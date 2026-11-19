/**
 * tests/frontend/mic-webm.test.mjs — CONTRACT §0.58 E111's live WebM writer
 * (src/mic-webm.ts), pinned byte for byte against GStreamer.
 *
 * The golden is SYNTHETIC: GStreamer's own `audiotestsrc` through
 * voice-typing's exact opusenc and webmmux settings (its config.py), no
 * microphone and no recording.  Regenerate it with:
 *
 *   gst-launch-1.0 -q audiotestsrc wave=ticks freq=440 volume=0.5 samplesperbuffer=480 num-buffers=101 \
 *     ! audio/x-raw,format=S16LE,rate=48000,channels=1,layout=interleaved \
 *     ! opusenc audio-type=generic bitrate=128000 bitrate-type=constrained-vbr complexity=9 \
 *       frame-size=60 bandwidth=auto dtx=false inband-fec=false max-payload-size=4000 \
 *     ! webmmux streamable=true min-cluster-duration=100000000 \
 *     ! filesink location=tests/fixtures/mic/gst-ticks.webm
 *
 * The date and the track UID differ per run, and the test reads both back
 * from the file, so any regenerated golden must pass.  `ticks` was chosen
 * because it gives full 959-byte packets, a partial one and 8-byte silent
 * ones, so 1- and 2-byte sizes, PrevSizes and Timecodes all occur, and it
 * ends on a BlockGroup with DiscardPadding.
 *
 * The EBML walk below is the test's own, not the module's.
 */

import { strict as assert } from 'node:assert'
import { test, before } from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const SRC = join(ROOT, 'src', 'mic-webm.ts')
const GOLDEN = join(ROOT, 'tests', 'fixtures', 'mic', 'gst-ticks.webm')

/** @type {any} */ let M

before(async () => {
  const esbuild = await import(pathToFileURL(join(ROOT, 'node_modules', 'esbuild', 'lib', 'main.js')).href)
  const dir = mkdtempSync(join(tmpdir(), 'cairn-mic-webm-'))
  process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })
  const out = join(dir, 'bundle.mjs')
  await esbuild.build({
    stdin: { contents: 'export * from ' + JSON.stringify(SRC) + '\n', resolveDir: ROOT, sourcefile: 'mic-webm-test-entry.ts', loader: 'ts' },
    outfile: out, bundle: true, format: 'esm', platform: 'neutral',
    target: 'es2021', absWorkingDir: ROOT, logLevel: 'silent',
  })
  M = await import(pathToFileURL(out).href)
})

/* ------------------------------------------------------------------ */
/* An independent EBML walk (masters of unknown size included)         */
/* ------------------------------------------------------------------ */

const MASTERS = new Set([0x1A45DFA3, 0x18538067, 0x1254C367, 0x7373, 0x63C0, 0x67C8, 0x1549A966, 0x1654AE6B, 0xAE, 0xE1, 0x1F43B675, 0xA0])
const NAMES = {
  0x1A45DFA3: 'EBML', 0x4282: 'DocType', 0x4287: 'DocTypeVersion', 0x4285: 'DocTypeReadVersion',
  0x18538067: 'Segment', 0x1254C367: 'Tags', 0x7373: 'Tag', 0x63C0: 'Targets', 0x63C5: 'TagTrackUID',
  0x67C8: 'SimpleTag', 0x45A3: 'TagName', 0x4487: 'TagString', 0x1549A966: 'Info', 0x2AD7B1: 'TimecodeScale',
  0x4D80: 'MuxingApp', 0x5741: 'WritingApp', 0x4461: 'DateUTC', 0x1654AE6B: 'Tracks', 0xAE: 'TrackEntry',
  0xD7: 'TrackNumber', 0x83: 'TrackType', 0x73C5: 'TrackUID', 0x23E383: 'DefaultDuration', 0x536E: 'Name',
  0xE1: 'Audio', 0xB5: 'SamplingFrequency', 0x86: 'CodecID', 0x63A2: 'CodecPrivate', 0x56BB: 'SeekPreRoll',
  0x56AA: 'CodecDelay', 0x1F43B675: 'Cluster', 0xE7: 'Timecode', 0xAB: 'PrevSize', 0xA3: 'SimpleBlock',
  0xA0: 'BlockGroup', 0xA1: 'Block', 0x75A2: 'DiscardPadding',
}

function walk(u8) {
  const els = []
  const vint = (p, keepMarker) => {
    const b = u8[p]
    let len = 1; let mask = 0x80
    while (len <= 8 && !(b & mask)) { len++; mask >>= 1 }
    let v = keepMarker ? b : b & (mask - 1)
    let ones = (b & (mask - 1)) === mask - 1
    for (let i = 1; i < len; i++) { v = v * 256 + u8[p + i]; if (u8[p + i] !== 0xff) ones = false }
    return { v, len, unknown: !keepMarker && ones }
  }
  let p = 0
  while (p < u8.length) {
    const id = vint(p, true)
    const sz = vint(p + id.len, false)
    const data = p + id.len + sz.len
    const name = NAMES[id.v] ?? '0x' + id.v.toString(16)
    const e = { name, off: p, idLen: id.len, sizeLen: sz.len, size: sz.unknown ? null : sz.v, data }
    els.push(e)
    if (MASTERS.has(id.v)) { p = data; continue }
    e.bytes = u8.subarray(data, data + sz.v)
    p = data + sz.v
  }
  return els
}

const uint = (b) => b.reduce((v, x) => v * 256n + BigInt(x), 0n)
const sint = (b) => { const u = uint(b); return b.length && b[0] & 0x80 ? u - (1n << BigInt(8 * b.length)) : u }
const str = (b) => Buffer.from(b).toString('latin1').replace(/\0+$/, '')

/** Everything GStreamer decided for this file: identity, head, and every packet. */
function goldenParts(u8) {
  const els = walk(u8)
  const one = (n) => { const e = els.find((x) => x.name === n); assert.ok(e, 'golden has ' + n); return e }
  let cluster = 0; let pad = 0n
  const packets = []
  for (const e of els) {
    if (e.name === 'Timecode') cluster = Number(uint(e.bytes))
    if (e.name === 'DiscardPadding') pad = sint(e.bytes)
    if (e.name === 'SimpleBlock' || e.name === 'Block') {
      assert.equal(e.bytes[0], 0x81, 'track 1')
      const rel = Buffer.from(e.bytes).readInt16BE(1)
      packets.push({ t: cluster + rel, payload: e.bytes.subarray(4), pad: e.name === 'Block' ? Number(pad) : 0 })
      pad = 0n
    }
  }
  return {
    els, packets,
    head: one('CodecPrivate').bytes,
    trackUid: uint(one('TrackUID').bytes),
    dateUtcNs: sint(one('DateUTC').bytes),
    muxingApp: str(one('MuxingApp').bytes),
    writingApp: str(one('WritingApp').bytes),
  }
}

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i
  return a.length === b.length ? -1 : n
}

/* ------------------------------------------------------------------ */

test('the golden is what the header says: GStreamer webmmux, 17 Opus packets, one DiscardPadding', () => {
  const g = goldenParts(new Uint8Array(readFileSync(GOLDEN)))
  assert.equal(g.muxingApp, 'GStreamer matroskamux version 1.26.2')
  assert.equal(g.packets.length, 17)
  assert.deepEqual(g.packets.map((p) => p.t), Array.from({ length: 17 }, (_, k) => k * 60))
  assert.deepEqual(g.packets.filter((p) => p.pad).map((p) => [p.t, p.pad]), [[960, 3500000]])
  const sizes = new Set(g.packets.map((p) => p.payload.length))
  assert.ok(sizes.has(959) && sizes.has(8), 'full and silent packets: ' + [...sizes])
})

test('LiveWebmWriter is byte-identical to GStreamer webmmux streamable=true, given its payloads, UID, date and app strings', () => {
  const gold = new Uint8Array(readFileSync(GOLDEN))
  const g = goldenParts(gold)
  const w = new M.LiveWebmWriter({ muxingApp: g.muxingApp, writingApp: g.writingApp, dateUtcNs: g.dateUtcNs, trackUid: g.trackUid })
  const parts = [w.header(g.head)]
  for (const p of g.packets) parts.push(w.packet(p.payload, p.t, { discardPaddingNs: p.pad }))
  const ours = Buffer.concat(parts.map((x) => Buffer.from(x)))
  const at = firstDiff(ours, gold)
  assert.equal(at, -1, `first differing byte at ${at} (ours ${ours.length} B, GStreamer ${gold.length} B)`)
  assert.equal(w.bytes, gold.length, 'the running byte count')
  assert.equal(parts.every((x) => x.length > 0), true, 'never an empty piece')
})

test("Cairn's own identity changes only MuxingApp, WritingApp and their sizes", () => {
  const g = goldenParts(new Uint8Array(readFileSync(GOLDEN)))
  const fixedMs = Date.UTC(2026, 10, 19, 12, 0, 0)
  const w = new M.LiveWebmWriter({ trackUid: g.trackUid, now: () => fixedMs })
  const parts = [w.header(g.head)]
  for (const p of g.packets) parts.push(w.packet(p.payload, p.t, { discardPaddingNs: p.pad }))
  const mine = walk(new Uint8Array(Buffer.concat(parts.map((x) => Buffer.from(x)))))
  const theirs = g.els
  assert.deepEqual(mine.map((e) => e.name), theirs.map((e) => e.name), 'the same element tree, in the same order')
  const val = (els, n) => str(els.find((e) => e.name === n).bytes)
  assert.equal(val(mine, 'MuxingApp'), 'Cairn')
  assert.equal(val(mine, 'WritingApp'), 'Cairn')
  assert.equal(sint(mine.find((e) => e.name === 'DateUTC').bytes), BigInt(fixedMs - Date.UTC(2001, 0, 1)) * 1000000n, 'ns since 2001-01-01')
  for (let i = 0; i < mine.length; i++) {
    const a = mine[i]; const b = theirs[i]
    if (['MuxingApp', 'WritingApp', 'DateUTC', 'Info', 'EBML', 'Segment'].includes(a.name)) continue
    if (a.bytes) assert.deepEqual(Buffer.from(a.bytes), Buffer.from(b.bytes), a.name + ' at ' + a.off)
  }
})

test('cadence: a new cluster every 120 ms of 60 ms packets, PrevSize from the second, DiscardPadding on the last block only', () => {
  const w = new M.LiveWebmWriter({ now: () => Date.UTC(2026, 10, 19) })
  const parts = [w.header()]
  for (let k = 0; k < 10; k++) parts.push(w.packet(new Uint8Array(959).fill(k), k * 60, { discardPaddingNs: k === 9 ? 13500000 : 0 }))
  const els = walk(new Uint8Array(Buffer.concat(parts.map((x) => Buffer.from(x)))))
  assert.deepEqual(els.filter((e) => e.name === 'Timecode').map((e) => Number(uint(e.bytes))), [0, 120, 240, 360, 480])
  assert.deepEqual(els.filter((e) => e.name === 'PrevSize').map((e) => Number(uint(e.bytes))), [1947, 1951, 1951, 1952])
  assert.equal(els.filter((e) => e.name === 'DiscardPadding').length, 1)
  assert.equal(sint(els.find((e) => e.name === 'DiscardPadding').bytes), 13500000n)
  assert.equal(els.filter((e) => e.name === 'SimpleBlock').length, 9)
  assert.equal(els.filter((e) => e.name === 'Cluster').every((e) => e.size === null), true, 'clusters of unknown size')
  assert.equal(els.find((e) => e.name === 'Segment').size, null, 'a segment of unknown size')
})

test('the block flags: 0x80 (keyframe) in SimpleBlocks, 0x00 in the padded Block', () => {
  const w = new M.LiveWebmWriter({ trackUid: 1n, now: () => 0 })
  w.header()
  const a = w.packet(new Uint8Array([1, 2, 3]), 0)
  const b = w.packet(new Uint8Array([4, 5, 6]), 60, { discardPaddingNs: 1000000 })
  const ea = walk(a).find((e) => e.name === 'SimpleBlock')
  assert.deepEqual([...ea.bytes], [0x81, 0, 0, 0x80, 1, 2, 3])
  const eb = walk(b).find((e) => e.name === 'Block')
  assert.deepEqual([...eb.bytes], [0x81, 0, 60, 0x00, 4, 5, 6])
})

test("header(): CodecPrivate is the encoder's OpusHead, CodecDelay its preSkip, SamplingFrequency always 48000", () => {
  const head = M.opusHead({ preSkip: 312, inputSampleRate: 44100 })
  const w = new M.LiveWebmWriter({ trackUid: 5n, now: () => 0 })
  const els = walk(w.header(head))
  assert.deepEqual(Buffer.from(els.find((e) => e.name === 'CodecPrivate').bytes), Buffer.from(head))
  assert.equal(Number(uint(els.find((e) => e.name === 'CodecDelay').bytes)), 6500000)
  assert.equal(Buffer.from(els.find((e) => e.name === 'SamplingFrequency').bytes).readDoubleBE(0), 48000)
  assert.equal(str(els.find((e) => e.name === 'TagString').bytes), '128000')
  const odd = walk(new M.LiveWebmWriter({ trackUid: 5n, now: () => 0 }).header(M.opusHead({ preSkip: 120 })))
  assert.equal(Number(uint(odd.find((e) => e.name === 'CodecDelay').bytes)), 2500000)
  // no description: the RFC 7845 default head
  const none = walk(new M.LiveWebmWriter({ trackUid: 5n, now: () => 0 }).header(null))
  assert.deepEqual(Buffer.from(none.find((e) => e.name === 'CodecPrivate').bytes), Buffer.from(M.opusHead()))
})

test('opusHead / readOpusHead (RFC 7845 §5.1) round-trip from any buffer shape, and refuse what is not one', () => {
  const h = M.opusHead({ preSkip: 312, inputSampleRate: 44100, channels: 1 })
  assert.deepEqual([...h], [0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, 1, 0x38, 0x01, 0x44, 0xac, 0, 0, 0, 0, 0])
  const want = { version: 1, channels: 1, preSkip: 312, inputSampleRate: 44100, gain: 0, family: 0 }
  const pick = (r) => ({ version: r.version, channels: r.channels, preSkip: r.preSkip, inputSampleRate: r.inputSampleRate, gain: r.gain, family: r.family })
  assert.deepEqual(pick(M.readOpusHead(h)), want)
  assert.deepEqual(pick(M.readOpusHead(h.slice().buffer)), want, 'ArrayBuffer')
  const big = new Uint8Array(40); big.set(h, 7)
  assert.deepEqual(pick(M.readOpusHead(new DataView(big.buffer, 7, 19))), want, 'a view at an offset')
  assert.equal(M.readOpusHead(null), null)
  assert.equal(M.readOpusHead(h.subarray(0, 18)), null, 'too short')
  const bad = h.slice(); bad[0] = 0x6f
  assert.equal(M.readOpusHead(bad), null, 'wrong magic')
})

test('a random TrackUID is used in both places, non-zero, with the top bit clear', () => {
  for (let i = 0; i < 20; i++) {
    const els = walk(new M.LiveWebmWriter({ now: () => 0 }).header())
    const a = els.find((e) => e.name === 'TrackUID').bytes
    const b = els.find((e) => e.name === 'TagTrackUID').bytes
    assert.equal(a.length, 8)
    assert.deepEqual(Buffer.from(a), Buffer.from(b))
    assert.ok(uint(a) > 0n && (a[0] & 0x80) === 0)
  }
})

test('concat joins in order', () => {
  assert.deepEqual([...M.concat([new Uint8Array([1]), new Uint8Array(0), new Uint8Array([2, 3])])], [1, 2, 3])
})
