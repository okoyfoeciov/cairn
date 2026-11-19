/**
 * tests/frontend/mic-trim.test.mjs — CONTRACT §0.58 E111's playback trim:
 * comart's offscreen.js lead-in/tail trim (src/mic-trim.ts), with no engine.
 *
 * Every signal is synthetic and deterministic (a 32-bit LCG for the room, a
 * 220 Hz sine for the "voice"), and OfflineAudioContext is a stub that decodes
 * the signal at whatever rate it is asked for.  The VAD is src/vad.ts's own
 * segments()/pick() over scripted probabilities, so only the model is faked.
 *
 * The golden numbers came from running comart's own offscreen.js (lines 39-52
 * and 445-678) and vad.js on these exact signals, and each was then checked by
 * hand against the rule it pins — the arithmetic is written beside it.
 */

import { strict as assert } from 'node:assert'
import { test, before, after } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '..', '..')

/** @type {any} */ let T
/** @type {any} */ let V

before(async () => {
  const esbuild = await import(pathToFileURL(join(ROOT, 'node_modules', 'esbuild', 'lib', 'main.js')).href)
  const dir = mkdtempSync(join(tmpdir(), 'cairn-mic-trim-'))
  process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })
  const out = join(dir, 'bundle.mjs')
  await esbuild.build({
    stdin: {
      contents: 'export * as T from ' + JSON.stringify(join(ROOT, 'src', 'mic-trim.ts')) + '\nexport * as V from ' + JSON.stringify(join(ROOT, 'src', 'vad.ts')) + '\n',
      resolveDir: ROOT, sourcefile: 'mic-trim-test-entry.ts', loader: 'ts',
    },
    outfile: out, bundle: true, format: 'esm', platform: 'neutral', target: 'es2021', absWorkingDir: ROOT, logLevel: 'silent',
  })
  ;({ T, V } = await import(pathToFileURL(out).href))
})

/* ── synthetic audio ──────────────────────────────────────────────────────── */

function lcg(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32) * 2 - 1 }
/** parts: [seconds, 'room' | 'tone' | 'zero', amplitude] */
function signal(sr, parts) {
  const n = parts.reduce((a, [s]) => a + Math.round(s * sr), 0)
  const x = new Float32Array(n)
  const rnd = lcg(1234)
  let o = 0
  for (const [secs, kind, amp] of parts) {
    const m = Math.round(secs * sr)
    for (let i = 0; i < m; i++, o++) x[o] = kind === 'tone' ? amp * Math.sin(2 * Math.PI * 220 * o / sr) : kind === 'room' ? amp * rnd() : 0
  }
  return x
}
// A word from 1.2 s to 3.0 s in a -60 dBFS-ish room; 3.5 s in all.
const WORD = [[1.2, 'room', 0.002], [1.8, 'tone', 0.3], [0.5, 'room', 0.002]]
const HOT = [[2.0, 'tone', 0.3], [0.5, 'room', 0.002]]
const NARROW = [[1.2, 'room', 0.01], [1.8, 'room', 0.03], [0.5, 'room', 0.01]]

/** OfflineAudioContext as the trim uses it: decode at the context's rate.
 *  `decoding` is the signal the next decodes return; null makes them throw. */
let decoding = null
const decodes = []
class StubOfflineAudioContext {
  constructor(channels, length, rate) { this.rate = rate; assert.equal(channels, 1); assert.equal(length, 1) }
  async decodeAudioData(buf) {
    decodes.push({ rate: this.rate, bytes: buf.byteLength })
    if (!decoding) throw new Error('EncodingError: undecodable')
    const x = signal(this.rate, decoding)
    return { sampleRate: this.rate, length: x.length, numberOfChannels: 1, duration: x.length / this.rate, getChannelData: () => x }
  }
}
let savedCtx
before(() => { savedCtx = globalThis.OfflineAudioContext; globalThis.OfflineAudioContext = StubOfflineAudioContext })
after(() => { globalThis.OfflineAudioContext = savedCtx })

const FS = 512 / 16000
/** A Vad whose model says 0.9 inside the given frame ranges and 0.01 elsewhere. */
function fakeVad(ranges, seen = []) {
  return {
    warm: async () => {},
    probabilities: async (x) => {
      seen.push(x.length)
      const p = new Float32Array(Math.max(1, Math.ceil(x.length / 512))).fill(0.01)
      for (const [a, b] of ranges) p.fill(0.9, a, b)
      return { probs: p, frameSec: FS }
    },
    segments: (p, f) => V.segments(p, f),
    pick: (p, f, a) => V.pick(p, f, a),
  }
}
const failingVad = { ...fakeVad([]), probabilities: async () => { throw new Error('no available backend found') } }
const BLOB = () => new Blob([new Uint8Array(64)], { type: 'audio/webm;codecs=opus' })
/** The output as samples: header 44 bytes, then 16-bit mono at 48 kHz. */
const samples = (r) => (r.blob.size - 44) / 2

/* ── constants: offscreen.js:39-52, 445-457 ───────────────────────────────── */

test("comart's TRIM_* constants, every one", () => {
  assert.deepEqual({
    LEAD: T.TRIM_LEAD_SECS, TAIL: T.TRIM_TAIL_SECS, WORD_TAIL: T.TRIM_WORD_TAIL_SECS, HINT_PAD: T.TRIM_HINT_PAD_SECS,
    FRAME: T.TRIM_FRAME_SECS, HOP: T.TRIM_HOP_SECS, SMOOTH: T.TRIM_SMOOTH_SECS, PLATEAU: T.TRIM_PLATEAU_SECS,
    FILL: T.TRIM_PLATEAU_FILL, QUIET: T.TRIM_QUIET_SECS, FLOOR: T.TRIM_FLOOR_SECS, FLOOR_PCT: T.TRIM_FLOOR_PERCENT,
    RANGE: T.TRIM_RANGE, QUIET_FACTOR: T.TRIM_QUIET_FACTOR, SILENCE: T.TRIM_SILENCE,
  }, {
    LEAD: 0.010, TAIL: 0.250, WORD_TAIL: 0.150, HINT_PAD: 0.150,
    FRAME: 0.020, HOP: 0.010, SMOOTH: 0.050, PLATEAU: 0.150,
    FILL: 0.800, QUIET: 0.100, FLOOR: 1.500, FLOOR_PCT: 0.100,
    RANGE: 4, QUIET_FACTOR: 1.75, SILENCE: 1e-5,
  })
})

/* ── wavBlob: offscreen.js:554-572 ────────────────────────────────────────── */

test('wavBlob: a 44-byte RIFF header, 16-bit mono PCM at the given rate, clamped', async () => {
  const b = T.wavBlob(Float32Array.of(-1, 0.5, 1.5, -2, 0), 16000)
  assert.equal(b.type, 'audio/wav')
  const u = new Uint8Array(await b.arrayBuffer())
  const d = new DataView(u.buffer)
  const tag = (o) => String.fromCharCode(...u.slice(o, o + 4))
  assert.equal(u.length, 44 + 10)
  assert.equal(tag(0), 'RIFF')
  assert.equal(d.getUint32(4, true), 36 + 10)
  assert.equal(tag(8), 'WAVE')
  assert.equal(tag(12), 'fmt ')
  assert.equal(d.getUint32(16, true), 16)
  assert.equal(d.getUint16(20, true), 1, 'PCM')
  assert.equal(d.getUint16(22, true), 1, 'mono')
  assert.equal(d.getUint32(24, true), 16000)
  assert.equal(d.getUint32(28, true), 32000, 'byte rate')
  assert.equal(d.getUint16(32, true), 2, 'block align')
  assert.equal(d.getUint16(34, true), 16, 'bits')
  assert.equal(tag(36), 'data')
  assert.equal(d.getUint32(40, true), 10)
  // -1 -> -0x8000; 0.5 -> 0.5 * 0x7fff = 16383.5, truncated; 1.5 and -2 clamp.
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => d.getInt16(44 + i * 2, true)), [-32768, 16383, 32767, -32768, 0])
})

/* ── monoMix: offscreen.js:459-472 ────────────────────────────────────────── */

test('monoMix: one channel is returned as is; more are averaged', () => {
  const a = Float32Array.of(1, 0.5, -1)
  const buf1 = { length: 3, numberOfChannels: 1, getChannelData: () => a }
  assert.equal(T.monoMix(buf1), a)
  const b = Float32Array.of(0, 0.5, 1)
  const buf2 = { length: 3, numberOfChannels: 2, getChannelData: (c) => (c === 0 ? a : b) }
  assert.deepEqual([...T.monoMix(buf2)], [0.5, 0.5, 0])
})

/* ── voicedBounds: offscreen.js:476-552 ───────────────────────────────────── */

test('voicedBounds: a word in a quiet room starts at the end of the last 100 ms of room', () => {
  // The voice starts at 1.200 s.  A frame at t covers t..t+20 ms and the 50 ms
  // average reaches 20 ms further, so the last calm frame ends at 1.140 s;
  // the last loud smoothed frame is at 3.010 s, which ends a window later.
  const b = T.voicedBounds(signal(48000, WORD), 48000)
  assert.ok(Math.abs(b.start - 1.14) < 1e-9 && Math.abs(b.end - 3.03) < 1e-9, JSON.stringify(b))
})

test('voicedBounds: null when the clip opens on speech, under 12 dB, silent, or too short', () => {
  assert.equal(T.voicedBounds(signal(48000, HOT), 48000), null, 'hot start')
  // The hot rule's own case: 90 ms of voice in the first 8 frames, then a word
  // that alone would cut at 1.140 s (it does, without the rule).
  const open = [[0.09, 'tone', 0.3], [1.11, 'room', 0.002], [1.8, 'tone', 0.3], [0.5, 'room', 0.002]]
  assert.equal(T.voicedBounds(signal(48000, open), 48000), null, 'opens on speech, then a word')
  assert.equal(T.voicedBounds(signal(48000, NARROW), 48000), null, '~9.5 dB between room and voice')
  assert.equal(T.voicedBounds(new Float32Array(96000), 48000), null, 'digital silence')
  assert.equal(T.voicedBounds(signal(48000, [[0.1, 'tone', 0.3]]), 48000), null, 'under 20 frames')
})

/* ── trimClip: offscreen.js:593-678, the whole decision table ─────────────── */

const trim = async (parts, hint, vad) => {
  decoding = parts
  decodes.length = 0
  return T.trimClip(BLOB(), hint === undefined ? null : Promise.resolve(hint), vad)
}

test('rule 1: the VAD segment that holds the first word, less 10 ms; the last word + 150 ms', async () => {
  const seen = []
  // VAD frames 38..95 = 1.216..3.040 s; the recognizer says 1.306..2.980 s.
  const r = await trim(WORD, { first: 1306, last: 2980 }, fakeVad([[38, 95]], seen))
  // from round((1.216 - 0.010) * 48000) = 57888 to round((2.980 + 0.150) * 48000) = 150240
  assert.equal(samples(r), 150240 - 57888)
  assert.equal(r.ms, 1924)
  assert.equal(r.blob.type, 'audio/wav')
  assert.deepEqual(seen, [56000], 'the VAD got the clip decoded again at 16 kHz')
  assert.deepEqual(decodes.map((d) => d.rate).sort(), [16000, 48000])
})

test('rule 1 with no word timings: the first segment, pulled back to the energy onset within 500 ms', async () => {
  const r = await trim(WORD, { first: NaN, last: NaN }, fakeVad([[38, 95]]))
  // start = energy 1.140 (0.076 before the VAD's 1.216) - 0.010; end = max(3.030, 3.040) + 0.250
  assert.equal(samples(r), Math.round(3.29 * 48000) - Math.round(1.13 * 48000))
  assert.equal(r.ms, 2160)
})

test('rule 1 with a bare-number hint: the first word only, so the VAD/energy end + 250 ms', async () => {
  const r = await trim(WORD, 1306, fakeVad([[38, 95]]))
  assert.equal(samples(r), 157920 - 57888)
  assert.equal(r.ms, 2084)
})

test('rule 2: a VAD edge more than 50 ms after the word is rejected; the word less 150 ms', async () => {
  const r = await trim(WORD, { first: 1016, last: 2980 }, fakeVad([[38, 95]]))
  // 1.216 > 1.016 + 0.05: start 1.016, lead 0.150 -> round(0.866 * 48000) = 41568
  assert.equal(samples(r), 150240 - 41568)
  assert.equal(r.ms, 2264)
})

test("rule 1's 50 ms, at its edges: a VAD edge 40 ms after the word is kept, one 60 ms after is rejected", async () => {
  // The VAD starts at 1.216 s.  Word at 1.176: 1.216 <= 1.226, so rule 1 cuts at
  // 1.216 - 0.010 -> 57888; word at 1.156: 1.216 > 1.206, so rule 2 cuts at
  // 1.156 - 0.150 = 1.006 -> 48288.  Both end at 2.980 + 0.150 -> 150240.
  const kept = await trim(WORD, { first: 1176, last: 2980 }, fakeVad([[38, 95]]))
  assert.equal(samples(kept), 150240 - 57888)
  assert.equal(kept.ms, 1924)
  const late = await trim(WORD, { first: 1156, last: 2980 }, fakeVad([[38, 95]]))
  assert.equal(samples(late), 150240 - 48288)
  assert.equal(late.ms, 2124)
})

test("rule 1's 500 ms pull-back, at its edges: with no timings, an energy onset 492 ms before the VAD edge is taken, one 524 ms before is not", async () => {
  // The energy onset is 1.140 s (voicedBounds above).  VAD frames 51..95 start
  // at 1.632 (0.492 later): the cut is 1.140 - 0.010 -> 54240.  Frames 52..95
  // start at 1.664 (0.524 later): the cut stays 1.664 - 0.010 -> 79392.  Both
  // end at max(3.030, 3.040) + 0.250 -> 157920.
  const pulled = await trim(WORD, { first: NaN, last: NaN }, fakeVad([[51, 95]]))
  assert.equal(samples(pulled), 157920 - 54240)
  assert.equal(pulled.ms, 2160)
  const far = await trim(WORD, { first: NaN, last: NaN }, fakeVad([[52, 95]]))
  assert.equal(samples(far), 157920 - 79392)
  assert.equal(far.ms, 1636)
})

test('rule 2: no VAD, a VAD that fails, no speech, or nothing near the word', async () => {
  // 1.306 - 0.150 = 1.156 -> 55488
  for (const [label, vad] of [['no VAD', null], ['VAD rejects', failingVad], ['no-speech', fakeVad([])]]) {
    const r = await trim(WORD, { first: 1306, last: 2980 }, vad)
    assert.equal(samples(r), 150240 - 55488, label)
    assert.equal(r.ms, 1974, label)
  }
  // Only 1.216..1.600 is speech and the word is at 2.700: none-near, so 2.700 - 0.150.
  const r = await trim(WORD, { first: 2700, last: 2980 }, fakeVad([[38, 50]]))
  assert.equal(samples(r), 150240 - Math.round(2.55 * 48000))
  assert.equal(r.ms, 580)
})

test('rule 3: the energy detector alone, less 10 ms, plus 250 ms', async () => {
  const r = await trim(WORD, { first: NaN, last: NaN }, null)
  assert.equal(samples(r), Math.round(3.28 * 48000) - Math.round(1.13 * 48000))
  assert.equal(r.ms, 2150)
  // A first word at or past the end, and a last word past it, are not timings.
  const beyond = await trim(WORD, { first: 3600, last: 3700 }, null)
  assert.equal(beyond.ms, 2150)
})

test("no hint, or a rejected one, is comart's Number(null) = 0: the start stays, only the end is cut", async () => {
  // Unreachable through wordHint(), which always resolves to {first, last};
  // pinned so the port keeps comart's arithmetic.  An anchor at 0 s is rule 2
  // at max(0, -0.150) = 0, with no last word: the energy end 3.030 + 0.250.
  decoding = WORD
  const none = await T.trimClip(BLOB(), null, null)
  assert.equal(samples(none), Math.round(3.28 * 48000))
  assert.equal(none.ms, 3280)
  const rejected = await T.trimClip(BLOB(), Promise.reject(new Error('socket closed')), fakeVad([[38, 95]]))
  assert.equal(rejected.ms, 3280, 'the VAD is none-near an anchor at 0 s')
})

test('a start later than the local end plays to the end of the clip', async () => {
  // Rule 2 at 3.300 s; the energy end is 3.030 < 3.300, so the end is the duration.
  const r = await trim(WORD, { first: 3300, last: NaN }, null)
  assert.equal(samples(r), 168000 - Math.round(3.15 * 48000))
  assert.equal(r.ms, 350)
})

test('null, so the recording plays as is: nothing to cut, or an undecodable clip', async () => {
  assert.equal(await trim(HOT, { first: NaN, last: NaN }, null), null, 'hot start, no timings, no VAD')
  assert.equal(await trim(null, { first: 1306, last: 2980 }, fakeVad([[38, 95]])), null, 'decode throws')
})

/* ── the sample work: where monoMix / voicedBounds / wavBlob run ───────────── */

test('localTrimWork: bounds() is monoMix + voicedBounds, wav() is wavBlob of [a, z) of the mixed samples', async () => {
  const x = signal(48000, WORD)
  const half = Float32Array.from(x, (v) => v / 2)
  // Two channels: the mix (their average) is what gets measured and cut.
  const buf = { sampleRate: 48000, length: x.length, numberOfChannels: 2, getChannelData: (c) => (c === 0 ? x : half) }
  const w = T.localTrimWork()
  await assert.rejects(w.wav(0, 10), /no clip/)
  const r = await w.bounds(buf)
  assert.equal(r.length, 168000)
  const direct = T.voicedBounds(T.monoMix(buf), 48000)
  assert.ok(direct && direct.start > 1 && direct.start < 1.2, JSON.stringify(direct))
  assert.deepEqual(r.bounds, direct)
  const b = await w.wav(100, 400)
  assert.equal(b.size, 44 + 600)
  const want = new Uint8Array(await T.wavBlob(T.monoMix(buf).subarray(100, 400), 48000).arrayBuffer())
  assert.deepEqual(new Uint8Array(await b.arrayBuffer()), want)
})

test('trimClip hands the sample work to its TrimWork: one bounds() of the 48 kHz decode, one wav() of the cut', async () => {
  const local = T.localTrimWork()
  const calls = []
  const work = {
    bounds: (buf) => { calls.push(['bounds', buf.sampleRate, buf.length]); return local.bounds(buf) },
    wav: (a, z) => { calls.push(['wav', a, z]); return local.wav(a, z) },
  }
  decoding = WORD
  const r = await T.trimClip(BLOB(), Promise.resolve({ first: 1306, last: 2980 }), fakeVad([[38, 95]]), work)
  assert.deepEqual(calls, [['bounds', 48000, 168000], ['wav', 57888, 150240]])
  assert.equal(r.ms, 1924)
  assert.equal(samples(r), 150240 - 57888)
})

test('trimClip: a TrimWork that fails is a failed trim (null), like any other throw', async () => {
  decoding = WORD
  const broken = { bounds: async () => { throw new Error('gone') }, wav: async () => { throw new Error('gone') } }
  assert.equal(await T.trimClip(BLOB(), Promise.resolve({ first: 1306, last: 2980 }), null, broken), null)
})

test('vadAnalyze: no VAD is comart\'s "vad.js not loaded"', async () => {
  await assert.rejects(T.vadAnalyze(BLOB(), null), /vad\.js not loaded/)
  decoding = WORD
  const a = await T.vadAnalyze(BLOB(), fakeVad([[38, 95]]))
  assert.equal(a.frameSec, FS)
  assert.equal(a.probs.length, 110)
  assert.deepEqual(a.segments.map((s) => [s.start, s.end].map((v) => Math.round(v * 1000))), [[1216, 3040]])
})

/* ── wordHint: offscreen.js:859-869 ───────────────────────────────────────── */

test("wordHint: first_word_ms / last_word_ms when finite and >= 0, else NaN", async () => {
  const h = (a) => T.wordHint(a === undefined ? null : Promise.resolve(a))
  assert.deepEqual(await h({ first_word_ms: 1306, last_word_ms: 9700 }), { first: 1306, last: 9700 })
  assert.deepEqual(await h({ first_word_ms: 0, last_word_ms: 0 }), { first: 0, last: 0 })
  assert.deepEqual(await h({ first_word_ms: '120', last_word_ms: '4500' }), { first: 120, last: 4500 })
  const nan = await h({ first_word_ms: -1, last_word_ms: Infinity })
  assert.ok(Number.isNaN(nan.first) && Number.isNaN(nan.last))
  const none = await h({ text: 'hello' })
  assert.ok(Number.isNaN(none.first) && Number.isNaN(none.last))
  const nul = await h(null)
  assert.ok(Number.isNaN(nul.first) && Number.isNaN(nul.last))
  const absent = await h(undefined)
  assert.ok(Number.isNaN(absent.first) && Number.isNaN(absent.last), 'no answer promise at all')
  const rej = await T.wordHint(Promise.reject(new Error('closed')))
  assert.ok(Number.isNaN(rej.first) && Number.isNaN(rej.last))
  // comart's Number(): a JSON null is 0, kept as is.
  assert.deepEqual(await h({ first_word_ms: null, last_word_ms: 5 }), { first: 0, last: 5 })
})

/* ── warmSink / stopWarmSink: offscreen.js:109-145 ────────────────────────── */

test('warmSink: one silent looping WAV at volume 0.01, restarted on each call, stopped after 8 s or by stopWarmSink', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const els = []
  const body = { children: [], appendChild(e) { this.children.push(e) } }
  const doc = {
    body,
    createElement(tag) {
      const el = { tag, attrs: {}, plays: 0, pauses: 0, currentTime: 5, volume: 1,
        setAttribute(k, v) { this.attrs[k] = v },
        play() { this.plays += 1; return Promise.reject(new Error('NotAllowedError')) },
        pause() { this.pauses += 1 } }
      els.push(el)
      return el
    },
  }
  const urls = []
  const savedDoc = globalThis.document
  const savedCreate = URL.createObjectURL
  globalThis.document = doc
  URL.createObjectURL = (b) => { urls.push(b); return 'blob:warm' }
  try {
    T.warmSink()
    assert.equal(els.length, 1)
    const el = els[0]
    assert.deepEqual({ tag: el.tag, src: el.src, loop: el.loop, preload: el.preload, volume: el.volume, currentTime: el.currentTime, hidden: el.attrs['aria-hidden'] },
      { tag: 'audio', src: 'blob:warm', loop: true, preload: 'auto', volume: 0.01, currentTime: 0, hidden: 'true' })
    assert.equal(body.children[0], el)
    assert.equal(el.plays, 1)
    // One second of 16 kHz zeros: 44 + 32000 bytes of WAV.
    assert.equal(urls.length, 1)
    assert.equal(urls[0].size, 44 + 32000)
    assert.equal(urls[0].type, 'audio/wav')
    el.currentTime = 3
    T.warmSink()
    assert.equal(els.length, 1, 'the element is reused')
    assert.equal(urls.length, 1, 'and so is its URL')
    assert.equal(el.currentTime, 0)
    assert.equal(el.plays, 2)
    t.mock.timers.tick(7999)
    assert.equal(el.pauses, 0)
    t.mock.timers.tick(1)
    assert.equal(el.pauses, 1, '8 s after the last call')
    T.warmSink()
    T.stopWarmSink()
    assert.equal(el.pauses, 2)
    t.mock.timers.tick(8000)
    assert.equal(el.pauses, 2, 'stopWarmSink cleared the timer')
    T.stopWarmSink()
    assert.equal(el.pauses, 3, 'stopping again only pauses again')
  } finally {
    globalThis.document = savedDoc
    URL.createObjectURL = savedCreate
    await new Promise((r) => setImmediate(r))
  }
})
