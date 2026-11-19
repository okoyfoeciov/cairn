/**
 * tests/frontend/mic-recorder.test.mjs — CONTRACT §0.58 E111's take
 * (src/mic-recorder.ts): capture → mono → Opus → live WebM → WebSocket, with
 * voice-typing's state machine, floors, cap, deadline and one retry.
 *
 * Every browser API is a fake injected through `deps`: the microphone, the
 * MediaStreamTrackProcessor, WebCodecs, the WebSocket and the clock.  The
 * fakes model what was measured in Electron 39 (a stopped track drops what is
 * still queued; the encoder emits packet k once (k+1)·2880 samples at 48 kHz
 * are in, and its flush pads to ceil((N + preSkip) / 2880) packets).
 */

import { strict as assert } from 'node:assert'
import { test, before } from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const SRC = join(ROOT, 'src', 'mic-recorder.ts')

/** @type {any} */ let M

before(async () => {
  const esbuild = await import(pathToFileURL(join(ROOT, 'node_modules', 'esbuild', 'lib', 'main.js')).href)
  const dir = mkdtempSync(join(tmpdir(), 'cairn-mic-recorder-'))
  process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })
  const out = join(dir, 'bundle.mjs')
  await esbuild.build({
    stdin: {
      contents: 'export * from ' + JSON.stringify(SRC) + '\nexport { WIRE_TYPE } from ' + JSON.stringify(join(ROOT, 'src', 'mic-wire.ts')) + '\n',
      resolveDir: ROOT, sourcefile: 'mic-recorder-test-entry.ts', loader: 'ts',
    },
    outfile: out, bundle: true, format: 'esm', platform: 'neutral',
    target: 'es2021', absWorkingDir: ROOT, logLevel: 'silent',
  })
  M = await import(pathToFileURL(out).href)
})

/* ------------------------------------------------------------------ */
/* fakes                                                               */
/* ------------------------------------------------------------------ */

const flush = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)) }

/** The value of a promise that should already have settled, or '__pending__'
 *  (never an await that could hang the suite). */
async function now(p) {
  let v = '__pending__'
  p.then((x) => { v = x })
  await flush()
  return v
}

function fakeClock() {
  let t = 0; let id = 0
  const q = new Map()
  const add = (fn, ms, every) => { const h = ++id; q.set(h, { at: t + Math.max(0, ms), fn, every }); return h }
  return {
    now: () => t,
    pending: () => q.size,
    setTimeout: (fn, ms) => add(fn, ms, 0),
    clearTimeout: (h) => { q.delete(h) },
    setInterval: (fn, ms) => add(fn, ms, ms),
    clearInterval: (h) => { q.delete(h) },
    async advance(ms) {
      const end = t + ms
      for (;;) {
        let next = null
        for (const [h, e] of q) if (e.at <= end && (!next || e.at < next[1].at)) next = [h, e]
        if (!next) break
        const [h, e] = next
        t = e.at
        if (e.every) e.at += e.every; else q.delete(h)
        e.fn()
        await flush()
      }
      t = end
      await flush()
    },
  }
}

/** The microphone, getUserMedia and MediaStreamTrackProcessor. */
function fakeDevice(clock, log, { rate = 48000, channels = 2, frames = 480 } = {}) {
  const d = { rate, channels, frames, gumCalls: [], mstp: [], tracks: [], refuse: null, gate: null, noTrack: false, noMstp: false, preQueue: 0 }
  const track = () => d.tracks[d.tracks.length - 1]
  function makeReader() {
    const q = []; let waiting = null; let ended = false; let failure = null
    const r = {
      read() {
        if (failure) return Promise.reject(failure)
        if (q.length) return Promise.resolve({ value: q.shift(), done: false })
        if (ended) return Promise.resolve({ value: undefined, done: true })
        return new Promise((res, rej) => { waiting = { res, rej } })
      },
      cancel() { log.push('reader.cancel'); r.end(); return Promise.resolve() },
      end() { ended = true; q.length = 0; if (waiting) { const w = waiting; waiting = null; w.res({ value: undefined, done: true }) } },
      fail(e) { failure = e; if (waiting) { const w = waiting; waiting = null; w.rej(e) } },
      push(ad) { if (ended) return; if (waiting) { const w = waiting; waiting = null; w.res({ value: ad, done: false }) } else q.push(ad) },
      get queued() { return q.length },
    }
    return r
  }
  d.getUserMedia = (c) => {
    d.gumCalls.push(c); log.push('gum')
    const go = () => {
      if (d.refuse) throw d.refuse
      const t = {
        label: 'Fake Default Audio Input', stopped: false, endedFns: [], reader: null,
        stop() { if (!t.stopped) { t.stopped = true; log.push('track.stop'); if (t.reader) t.reader.end() } },
        addEventListener(type, fn) { if (type === 'ended') t.endedFns.push(fn) },
        getSettings: () => ({ deviceId: 'default', sampleRate: d.rate, channelCount: d.channels, echoCancellation: false, noiseSuppression: false, autoGainControl: false }),
      }
      d.tracks.push(t)
      return { getAudioTracks: () => (d.noTrack ? [] : [t]), getTracks: () => [t] }
    }
    return (d.gate ?? Promise.resolve()).then(go)
  }
  d.MediaStreamTrackProcessor = class {
    constructor(init) {
      if (d.noMstp) throw new TypeError('MediaStreamTrackProcessor is not a constructor')
      d.mstp.push(init)
      const r = makeReader()
      init.track.reader = r
      for (let i = 0; i < d.preQueue; i++) r.push(d.audio())
      this.readable = { getReader: () => r }
    }
  }
  /** One captured buffer, ending at the clock's now unless `ts` is given. */
  d.audio = ({ n = d.frames, l = 0.5, r = 0.25, ts = null } = {}) => {
    const planes = [new Float32Array(n).fill(l), new Float32Array(n).fill(r), new Float32Array(n).fill(0.125)].slice(0, d.channels)
    const timestamp = ts ?? Math.round((clock.now() - (n * 1000) / d.rate) * 1000)
    return {
      numberOfFrames: n, sampleRate: d.rate, numberOfChannels: d.channels, timestamp, format: 'f32-planar', closed: false,
      copyTo(dest, o) { dest.set(planes[o.planeIndex]) }, close() { this.closed = true },
    }
  }
  d.push = (opts) => { track().reader.push(d.audio(opts)) }
  /** Real-time capture: one buffer per buffer-length of clock. */
  d.capture = async (ms, opts = {}) => {
    const per = ((opts.n ?? d.frames) * 1000) / d.rate
    for (let t = 0; t < ms - 1e-9; t += per) { await clock.advance(per); d.push(opts); await flush(1) }
    await flush()
  }
  d.unplug = () => { const t = track(); t.endedFns.forEach((f) => f()); t.reader.end() }
  d.track = track
  return d
}

const opusHead = (preSkip, rate) => {
  const b = new Uint8Array(19)
  b.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, 1])
  const dv = new DataView(b.buffer); dv.setUint16(10, preSkip, true); dv.setUint32(12, rate, true)
  return b
}

/** WebCodecs: AudioEncoder (Opus) and AudioData. */
function fakeCodecs(log) {
  const E = { instances: [], packetBytes: 959, preSkip: 312, flushGate: null, refuseConfig: null }
  E.AudioEncoder = class {
    constructor({ output, error }) { this.output = output; this.error = error; this.state = 'unconfigured'; this.inFrames = 0; this.in48 = 0; this.n = 0; this.inputs = []; E.instances.push(this) }
    configure(cfg) { if (E.refuseConfig) throw E.refuseConfig; this.cfg = cfg; this.state = 'configured'; log.push('encoder.configure ' + cfg.sampleRate) }
    encode(ad) {
      if (this.state !== 'configured') throw new Error('encode on ' + this.state)
      this.inputs.push(ad); this.inFrames += ad.numberOfFrames
      this.in48 = Math.round((this.inFrames * 48000) / this.cfg.sampleRate)
      while (this.in48 >= (this.n + 1) * 2880) this.emit()
    }
    emit() {
      const k = this.n++
      const size = typeof E.packetBytes === 'function' ? E.packetBytes(k) : E.packetBytes
      const chunk = { byteLength: size, timestamp: k * 60000 + (k % 2), duration: 60000, copyTo(dest) { dest.fill((k % 250) + 1) } }
      const meta = k === 0 ? { decoderConfig: { codec: 'opus', sampleRate: 48000, numberOfChannels: 1, description: opusHead(E.preSkip, this.cfg.sampleRate).buffer } } : {}
      this.output(chunk, meta)
    }
    flush() {
      log.push('encoder.flush')
      const done = () => { const total = Math.ceil((this.in48 + E.preSkip) / 2880); while (this.n < total) this.emit() }
      if (E.flushGate) return E.flushGate.then(done)
      done(); return Promise.resolve()
    }
    close() { if (this.state !== 'closed') { this.state = 'closed'; log.push('encoder.close') } }
  }
  E.AudioData = class {
    constructor(init) { this.init = init; this.numberOfFrames = init.numberOfFrames; this.sampleRate = init.sampleRate; this.numberOfChannels = init.numberOfChannels; this.data = init.data; this.closed = false }
    close() { this.closed = true }
  }
  return E
}

function fakeWs(log) {
  const W = { all: [], autoOpen: true }
  W.FakeWS = class {
    constructor(url) {
      this.url = url; this.readyState = 0; this.binaryType = 'blob'; this.sent = []; this.closedByClient = null
      this.onopen = null; this.onmessage = null; this.onerror = null; this.onclose = null
      W.all.push(this); log.push('ws.new')
      if (W.autoOpen) queueMicrotask(() => { if (this.readyState === 0) this.open() })
    }
    send(d) {
      if (this.readyState !== 1) throw new Error('send while ' + this.readyState)
      if (typeof d === 'string') log.push('ws.send ' + d)
      this.sent.push(typeof d === 'string' ? d : Uint8Array.from(d))
    }
    close() { if (!this.closedByClient) { this.closedByClient = true; log.push('ws.close') } this.readyState = 2 }
    open() { this.readyState = 1; this.onopen && this.onopen({}) }
    reply(data) { this.onmessage && this.onmessage({ data: typeof data === 'string' ? data : JSON.stringify(data) }) }
    error() { this.onerror && this.onerror({}) }
    closeFromServer(code, reason = '') { this.readyState = 3; this.onclose && this.onclose({ code, reason, wasClean: code !== 1006 }) }
    get binary() { return this.sent.filter((x) => typeof x !== 'string') }
    get texts() { return this.sent.filter((x) => typeof x === 'string') }
    get bytes() { return Buffer.concat(this.binary.map((b) => Buffer.from(b))) }
  }
  W.last = () => W.all[W.all.length - 1]
  return W
}

const EVENTS = ['armed', 'first-audio', 'stopping', 'sent', 'done', 'failed', 'mic-failed', 'cancelled']

function rig(opts = {}) {
  const log = []
  const clock = fakeClock()
  const dev = fakeDevice(clock, log, opts.device)
  const E = fakeCodecs(log)
  const W = fakeWs(log)
  const errors = []
  const rec = M.createMicRecorder({
    base: 'base' in opts ? opts.base : 'http://127.0.0.1:4321',
    deps: { getUserMedia: dev.getUserMedia, WebSocket: W.FakeWS, AudioEncoder: E.AudioEncoder, AudioData: E.AudioData, MediaStreamTrackProcessor: dev.MediaStreamTrackProcessor, now: clock.now, timers: clock },
    onError: (e) => errors.push(e),
    ...(opts.rec || {}),
  })
  const events = []
  const states = []
  for (const type of EVENTS) rec.on(type, (d) => { events.push([type, d]); log.push('event ' + type); states.push(rec.state) })
  const h = {
    rec, log, clock, dev, E, W, events, errors, states,
    names: () => events.map((e) => e[0]),
    ev: (type) => (events.find((e) => e[0] === type) || [])[1],
    /** start, let getUserMedia resolve, and capture `ms` of audio */
    async record(ms) { assert.equal(rec.start(), true); await flush(); if (ms) await dev.capture(ms) },
    /** stop with the click's buffer arriving `afterMs` later, through the flush and floors */
    async stop(afterMs = 10) { const ok = rec.stop(); await flush(); if (afterMs !== null) await dev.capture(afterMs); await flush(); return ok },
  }
  return h
}

function idx(log, s) { const i = log.indexOf(s); assert.notEqual(i, -1, 'log has ' + s + ': ' + log.join(' | ')); return i }

/** A small EBML walk over the bytes the server received (test-owned). */
function walk(u8) {
  const MASTERS = new Set([0x1A45DFA3, 0x18538067, 0x1254C367, 0x7373, 0x63C0, 0x67C8, 0x1549A966, 0x1654AE6B, 0xAE, 0xE1, 0x1F43B675, 0xA0])
  const els = []
  const vint = (p, keep) => {
    const b = u8[p]; let len = 1; let mask = 0x80
    while (len <= 8 && !(b & mask)) { len++; mask >>= 1 }
    let v = keep ? b : b & (mask - 1); let ones = (b & (mask - 1)) === mask - 1
    for (let i = 1; i < len; i++) { v = v * 256 + u8[p + i]; if (u8[p + i] !== 0xff) ones = false }
    return { v, len, unknown: !keep && ones }
  }
  let p = 0
  while (p < u8.length) {
    const id = vint(p, true); const sz = vint(p + id.len, false); const data = p + id.len + sz.len
    const e = { id: id.v, data }
    els.push(e)
    if (MASTERS.has(id.v)) { p = data; continue }
    e.bytes = u8.subarray(data, data + sz.v); p = data + sz.v
  }
  return els
}
const sintBE = (b) => { let v = 0; for (const x of b) v = v * 256 + x; return b[0] & 0x80 ? v - 2 ** (8 * b.length) : v }

/* ------------------------------------------------------------------ */
/* voice-typing's parameters                                           */
/* ------------------------------------------------------------------ */

test("the encoder config is voice-typing's opusenc, setting for setting", () => {
  assert.deepEqual(M.opusConfig(48000), {
    codec: 'opus', sampleRate: 48000, numberOfChannels: 1, bitrate: 128000, bitrateMode: 'variable',
    opus: { format: 'opus', frameDuration: 60000, complexity: 9, usedtx: false, useinbandfec: false, packetlossperc: 0, application: 'audio', signal: 'auto' },
  })
  assert.equal(M.opusConfig(44100).sampleRate, 44100)
})

test('the defaults: cap 119 s polled every 200 ms, floors 350 ms / 1200 B, 30 s deadline, 5 s connect, 3 s drain, 300-buffer queue', () => {
  assert.deepEqual({ ...M.DEFAULTS }, {
    capMs: 119000, capPollMs: 200, minMs: 350, minBytes: 1200, deadlineMs: 30000, connectTimeoutMs: 5000,
    drainTimeoutMs: 3000, releaseWaitMs: 50, maxBufferSize: 300,
    mime: 'audio/webm;codecs=opus;client=cairn', clipType: 'audio/webm;codecs=opus', frameMs: 60,
  })
  assert.equal(M.DEFAULTS.mime, M.WIRE_TYPE)
  assert.deepEqual({ ...M.RAW_CONSTRAINTS }, { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 })
})

test('toMono: one plane as is, two planes (L+R)·0.5 in float32, more planes the mean', () => {
  const ad = (planes) => ({ numberOfChannels: planes.length, numberOfFrames: planes[0].length, copyTo(dest, o) { assert.equal(o.format, 'f32-planar'); dest.set(planes[o.planeIndex]) } })
  const L = Float32Array.from([0.1, -0.7, 0.33333334, 1]); const R = Float32Array.from([0.3, 0.2, -0.1, 1])
  assert.deepEqual(M.toMono(ad([L])), L)
  const want = Float32Array.from(L, (x, i) => Math.fround(Math.fround(x + R[i]) * 0.5))
  assert.deepEqual(M.toMono(ad([L, R])), want)
  assert.deepEqual(M.toMono(ad([L, L])), L, 'a mono device opened as stereo comes back bit for bit')
  const C = Float32Array.from([0.5, 0.5, 0.5, 0.5])
  const mean = Float32Array.from(L, (x, i) => Math.fround(Math.fround(Math.fround(x + R[i]) + C[i]) / 3))
  assert.deepEqual(M.toMono(ad([L, R, C])), mean)
})

test('constructing a recorder opens nothing, and needs no browser global', () => {
  const h = rig()
  assert.equal(h.rec.state, 'idle')
  assert.equal(h.dev.gumCalls.length, 0)
  assert.equal(h.W.all.length, 0)
  assert.equal(h.E.instances.length, 0)
  assert.equal(h.clock.pending(), 0)
  const bare = M.createMicRecorder({ base: 'http://127.0.0.1:1' })
  assert.equal(bare.state, 'idle')
})

/* ------------------------------------------------------------------ */
/* one take, in order                                                  */
/* ------------------------------------------------------------------ */

test('a whole take: events, states and the wire, in order', async () => {
  const h = rig()
  assert.equal(h.rec.start(), true)
  assert.equal(h.rec.state, 'arming')
  assert.deepEqual(h.dev.gumCalls, [{ audio: M.RAW_CONSTRAINTS }])
  await flush()
  assert.deepEqual(h.names(), ['armed'])
  assert.equal(h.dev.mstp[0].maxBufferSize, 300)
  assert.equal(h.W.all.length, 0, 'no socket before the first audio')
  assert.equal(h.E.instances.length, 0, 'no encoder before the first audio')

  await h.dev.capture(10)
  assert.equal(h.rec.state, 'recording')
  assert.deepEqual(h.names(), ['armed', 'first-audio'])
  assert.deepEqual(h.ev('first-audio'), { armMs: 10, sampleRate: 48000, channels: 2 })
  assert.equal(h.W.all.length, 1)
  assert.equal(h.W.last().url, 'ws://127.0.0.1:4321/api/transcribe/ws?type=audio%2Fwebm%3Bcodecs%3Dopus%3Bclient%3Dcairn')
  assert.equal(h.E.instances[0].cfg.sampleRate, 48000)

  await h.dev.capture(990)
  assert.equal(h.W.last().texts.length, 0)
  const sentWhileRecording = h.W.last().binary.length
  assert.ok(sentWhileRecording >= 15, 'packets go out as they are made: ' + sentWhileRecording)

  let atSent = null
  h.rec.on('sent', (d) => { atSent = { texts: [...h.W.last().texts], names: h.names(), state: h.rec.state, d } })
  assert.equal(h.rec.stop(), true)
  assert.equal(h.rec.state, 'stopping')
  assert.equal(h.names().at(-1), 'stopping', '"stopping" fires synchronously in stop()')
  await h.stop(10)

  assert.equal(h.rec.state, 'transcribing')
  assert.ok(atSent, '"sent" fired')
  assert.deepEqual(atSent.texts, ['stop'], '"sent" fires as "stop" goes out')
  assert.deepEqual(atSent.names.slice(-2), ['stopping', 'sent'])
  assert.equal(atSent.state, 'transcribing')
  const clipBytes = Buffer.from(await atSent.d.clip.arrayBuffer())
  assert.deepEqual(clipBytes, h.W.last().bytes, 'the clip is exactly the bytes the server got')
  assert.equal(atSent.d.clip.type, 'audio/webm;codecs=opus')
  assert.equal(atSent.d.audioMs, h.E.instances[0].in48 / 48)

  let answer = 'pending'
  atSent.d.answer.then((a) => { answer = a })
  await flush()
  assert.equal(answer, 'pending')
  h.W.last().reply({ text: '  hello there ', first_word_ms: 120, last_word_ms: 880 })
  await flush()
  assert.deepEqual(answer, { text: 'hello there', first_word_ms: 120, last_word_ms: 880 })
  assert.deepEqual(h.names(), ['armed', 'first-audio', 'stopping', 'sent', 'done'])
  const done = h.ev('done')
  assert.equal(done.text, 'hello there')
  assert.equal(done.first_word_ms, 120)
  assert.equal(done.last_word_ms, 880)
  assert.equal(done.retried, false)
  assert.equal(done.clip, atSent.d.clip, 'the same clip')
  assert.equal(done.audioMs, atSent.d.audioMs)
  assert.equal(h.rec.state, 'idle')
  assert.deepEqual(h.states, ['arming', 'recording', 'stopping', 'transcribing', 'idle'])
  assert.equal(h.W.last().closedByClient, true, 'closed once the answer is in')
  assert.equal(h.clock.pending(), 0, 'no timer left behind')
  assert.equal(h.errors.length, 0)
})

test('"stop" goes out only after the mic is released and the encoder flushed; the held tail carries DiscardPadding', async () => {
  const h = rig()
  await h.record(1000)
  await h.stop(10)
  const L = h.log
  assert.ok(idx(L, 'track.stop') < idx(L, 'encoder.flush'), 'release, then flush')
  assert.ok(idx(L, 'encoder.flush') < idx(L, 'ws.send stop'), 'flush, then stop')
  const ws = h.W.last()
  assert.equal(ws.sent.at(-1), 'stop', '"stop" is the last thing sent')
  assert.ok(ws.binary.every((b) => b.byteLength > 0), 'never a zero-length frame')
  const enc = h.E.instances[0]
  const pad48 = enc.n * 2880 - enc.in48 - 312
  assert.ok(pad48 > 0 && pad48 < 2880)
  const els = walk(new Uint8Array(ws.bytes))
  const dp = els.filter((e) => e.id === 0x75A2)
  assert.equal(dp.length, 1, 'one DiscardPadding')
  assert.equal(sintBE(dp[0].bytes), Math.round((pad48 * 1e9) / 48000))
  assert.equal(els.filter((e) => e.id === 0xA3).length + els.filter((e) => e.id === 0xA1).length, enc.n, 'every packet written once')
  assert.equal(els[0].id, 0x1A45DFA3, 'the first frame starts with the EBML header')
  assert.ok(ws.binary[0].byteLength > 959, 'header and packet 0 travel together')
})

test('release waits for the buffer holding the click, so audio captured before it is kept', async () => {
  const h = rig()
  await h.record(1000)
  await h.clock.advance(3)                 // the click lands 3 ms into the next buffer
  assert.equal(h.rec.stop(), true)
  await flush()
  assert.equal(h.dev.track().stopped, false, 'not released before the click\'s buffer')
  const before = h.E.instances[0].inFrames
  await h.clock.advance(7); h.dev.push(); await flush()
  assert.equal(h.dev.track().stopped, true)
  assert.equal(h.E.instances[0].inFrames, before + 480, 'the click\'s buffer was encoded')
})

test('release gives up waiting after 50 ms when no buffer comes', async () => {
  const h = rig()
  await h.record(1000)
  h.rec.stop()
  await h.clock.advance(49)
  assert.equal(h.dev.track().stopped, false)
  await h.clock.advance(1)
  assert.equal(h.dev.track().stopped, true)
  await flush()
  assert.deepEqual(h.W.last().texts, ['stop'])
})

test('the drain is bounded: a flush that never ends gives up after 3 s and the take still goes out', async () => {
  const h = rig()
  await h.record(1000)
  h.E.flushGate = new Promise(() => {})
  await h.stop(10)
  assert.deepEqual(h.W.last().texts, [])
  await h.clock.advance(2999)
  assert.deepEqual(h.W.last().texts, [])
  await h.clock.advance(1)
  assert.deepEqual(h.W.last().texts, ['stop'])
  assert.equal(h.names().at(-1), 'sent')
})

test('stop() is true only while recording; in arming, stopping and transcribing it is false and changes nothing', async () => {
  const h = rig()
  assert.equal(h.rec.stop(), false, 'idle')
  h.rec.start()
  assert.equal(h.rec.stop(), false, 'arming (getUserMedia pending)')
  await flush()
  assert.equal(h.rec.stop(), false, 'arming (no audio yet)')
  assert.equal(h.rec.state, 'arming')
  assert.deepEqual(h.names(), ['armed'])
  await h.dev.capture(1000)
  assert.equal(h.rec.stop(), true)
  assert.equal(h.rec.stop(), false, 'stopping')
  await h.stop(10)
  assert.equal(h.rec.state, 'transcribing')
  assert.equal(h.rec.stop(), false, 'transcribing')
  assert.equal(h.names().filter((n) => n === 'stopping').length, 1)
})

test('start() is refused unless idle, and a new take after an ending starts clean', async () => {
  const h = rig()
  await h.record(1000)
  assert.equal(h.rec.start(), false)
  await h.stop(10)
  assert.equal(h.rec.start(), false, 'transcribing: a click is ignored')
  h.W.last().reply({ text: 'one' })
  await flush()
  assert.equal(h.rec.state, 'idle')
  await h.record(1000)
  assert.equal(h.W.all.length, 2, 'a fresh socket')
  assert.equal(h.E.instances.length, 2, 'a fresh encoder')
  await h.stop(10)
  h.W.last().reply({ text: 'two' })
  await flush()
  assert.deepEqual(h.events.filter((e) => e[0] === 'done').map((e) => e[1].text), ['one', 'two'])
})

test('"armed" always precedes "first-audio", even when a buffer is already queued as the processor is made', async () => {
  const h = rig()
  h.dev.preQueue = 2
  await h.clock.advance(10)
  h.rec.start()
  await flush()
  assert.deepEqual(h.names(), ['armed', 'first-audio'])
  assert.equal(h.rec.state, 'recording')
})

test('on() returns an unsubscribe; a throwing handler is reported and the take goes on', async () => {
  const h = rig()
  let n = 0
  const off = h.rec.on('armed', () => { n++ })
  h.rec.on('first-audio', () => { throw new Error('handler bug') })
  off()
  await h.record(1000)
  assert.equal(n, 0)
  assert.equal(h.errors.length, 1)
  assert.equal(h.rec.state, 'recording')
})

/* ------------------------------------------------------------------ */
/* floors and cap                                                      */
/* ------------------------------------------------------------------ */

test('floor: under 350 ms since the first buffer → cancelled short, closed without "stop", no "sent"', async () => {
  const h = rig()
  await h.record(300)                     // first buffer at 10, click at 300: 290 ms
  await h.stop(10)
  assert.deepEqual(h.names(), ['armed', 'first-audio', 'stopping', 'cancelled'])
  assert.equal(h.ev('cancelled').reason, 'short')
  assert.deepEqual(h.W.last().texts, [])
  assert.equal(h.W.last().closedByClient, true)
  assert.equal(h.rec.state, 'idle')
})

test('floor: exactly 350 ms is enough', async () => {
  const h = rig()
  await h.record(360)                     // 360 - 10 = 350
  await h.stop(10)
  assert.equal(h.names().at(-1), 'sent')
})

test('floor: it counts from the first buffer, not the click: a slow arm does not lend the take its arming time', async () => {
  // A first take arms in 25-92 ms; here the first buffer is read at 100.
  const slow = async (ms) => {
    const h = rig()
    assert.equal(h.rec.start(), true)      // the click, at 0
    await flush()
    await h.clock.advance(90)
    await h.dev.capture(ms)                // buffers at 100, 110, …, 90 + ms
    assert.equal(h.ev('first-audio').armMs, 100)
    assert.equal(h.clock.now(), 90 + ms)
    await h.stop(10)
    return h
  }
  const short = await slow(310)            // stop at 400: 300 ms since the first buffer, 400 since the click
  assert.deepEqual(short.names(), ['armed', 'first-audio', 'stopping', 'cancelled'])
  assert.equal(short.ev('cancelled').reason, 'short')
  assert.deepEqual(short.W.last().texts, [], 'no "stop": nothing is billed')
  const enough = await slow(360)           // stop at 450: 350 ms since the first buffer
  assert.equal(enough.names().at(-1), 'sent')
  assert.deepEqual(enough.W.last().texts, ['stop'])
})

test('floor: under 1200 bytes → cancelled short', async () => {
  const h = rig()
  h.E.packetBytes = 8
  await h.record(1000)
  await h.stop(10)
  assert.equal(h.ev('cancelled').reason, 'short')
  assert.ok(h.W.last().bytes.length < 1200)
  assert.deepEqual(h.W.last().texts, [])
})

test('cap on the 200 ms poll: 119 s after the first buffer, with no audio arriving at all', async () => {
  const h = rig()
  await h.record(10)                      // first buffer read at t=10
  await h.clock.advance(119190 - 10)      // polls at 200, 400, …; t - 10 >= 119000 first holds at 119200
  assert.equal(h.rec.state, 'recording')
  await h.clock.advance(10)
  assert.equal(h.rec.state, 'idle')
  assert.equal(h.clock.now(), 119200)
  assert.deepEqual(h.names(), ['armed', 'first-audio', 'cancelled'])
  assert.equal(h.ev('cancelled').reason, 'cap')
  assert.equal(h.dev.track().stopped, true)
  assert.deepEqual(h.W.last().texts, [])
  assert.equal(h.W.last().closedByClient, true)
})

test('cap on the poll bounds arming too: 119 s after the click', async () => {
  const h = rig()
  h.dev.gate = new Promise(() => {})
  h.rec.start()
  await h.clock.advance(118999)
  assert.equal(h.rec.state, 'arming')
  await h.clock.advance(1)
  assert.equal(h.rec.state, 'idle')
  assert.deepEqual(h.names(), ['cancelled'])
  assert.equal(h.ev('cancelled').reason, 'cap')
})

test('cap on the audio clock: 119 s of captured audio cancels even when no timer runs', async () => {
  const h = rig()
  await h.record(10)
  for (let i = 0; i < 1189; i++) h.dev.push({ n: 4800, ts: 0 })   // 1189 × 100 ms + the first 10 ms
  await flush(5)
  assert.equal(h.rec.state, 'recording', '118.91 s')
  const inBefore = h.E.instances[0].inFrames
  h.dev.push({ n: 4800, ts: 0 })
  await flush(5)
  assert.equal(h.rec.state, 'idle')
  assert.equal(h.ev('cancelled').reason, 'cap')
  assert.equal(h.E.instances[0].inFrames, inBefore, 'the buffer that crossed the cap was not encoded')
  assert.deepEqual(h.W.last().texts, [])
})

/* ------------------------------------------------------------------ */
/* cancel in every state                                               */
/* ------------------------------------------------------------------ */

async function assertSilentAfter(h, n) {
  for (const ws of h.W.all) { ws.reply({ text: 'late' }); ws.closeFromServer(1006) }
  await h.clock.advance(60000)
  assert.equal(h.events.length, n, 'nothing after the ending: ' + h.names().join(','))
}

test('cancel while getUserMedia is pending: the late stream is stopped at once, and nothing fires', async () => {
  const h = rig()
  let release; h.dev.gate = new Promise((r) => { release = r })
  h.rec.start()
  assert.equal(h.rec.cancel('user'), true)
  assert.deepEqual(h.names(), ['cancelled'])
  assert.equal(h.ev('cancelled').reason, 'user')
  release(); await flush()
  assert.equal(h.dev.track().stopped, true, 'the microphone is released as soon as it opens')
  assert.equal(h.W.all.length, 0)
  await assertSilentAfter(h, 1)
})

test('cancel in arming after the mic opened: released, no socket ever', async () => {
  const h = rig()
  await h.record(0)
  h.rec.cancel('user')
  assert.equal(h.dev.track().stopped, true)
  h.dev.push(); await flush()
  assert.equal(h.W.all.length, 0)
  assert.deepEqual(h.names(), ['armed', 'cancelled'])
  await assertSilentAfter(h, 2)
})

test('cancel while recording: mic released, encoder closed, socket closed without "stop"', async () => {
  const h = rig()
  await h.record(1000)
  assert.equal(h.rec.cancel('left'), true)
  assert.equal(h.ev('cancelled').reason, 'left')
  assert.equal(h.dev.track().stopped, true)
  assert.equal(h.E.instances[0].state, 'closed')
  assert.equal(h.W.last().closedByClient, true)
  assert.deepEqual(h.W.last().texts, [])
  assert.equal(h.rec.state, 'idle')
  assert.equal(h.clock.pending(), 0)
  await assertSilentAfter(h, 3)
})

test('cancel while stopping (waiting for the click\'s buffer): no "stop", no "sent"', async () => {
  const h = rig()
  await h.record(1000)
  h.rec.stop(); await flush()
  h.rec.cancel('user')
  await h.dev.capture(20)
  assert.deepEqual(h.W.last().texts, [])
  assert.deepEqual(h.names(), ['armed', 'first-audio', 'stopping', 'cancelled'])
  await assertSilentAfter(h, 4)
})

test('cancel while stopping (during the flush): no "stop", no "sent"', async () => {
  const h = rig()
  await h.record(1000)
  let go; h.E.flushGate = new Promise((r) => { go = r })
  await h.stop(10)
  assert.equal(h.rec.state, 'stopping')
  h.rec.cancel('user')
  go(); await flush()
  assert.deepEqual(h.W.last().texts, [])
  assert.deepEqual(h.names(), ['armed', 'first-audio', 'stopping', 'cancelled'])
  await assertSilentAfter(h, 4)
})

test('cancel while transcribing: the socket closes, the late answer is ignored, the answer promise says null', async () => {
  const h = rig()
  await h.record(1000)
  await h.stop(10)
  const { answer } = h.ev('sent')
  h.rec.cancel('left')
  assert.equal(h.W.last().closedByClient, true)
  assert.equal(await now(answer), null)
  assert.deepEqual(h.names(), ['armed', 'first-audio', 'stopping', 'sent', 'cancelled'])
  await assertSilentAfter(h, 5)
})

test('cancel during the retry closes the second socket too', async () => {
  const h = rig()
  await h.record(1000)
  await h.stop(10)
  h.W.last().reply({ error: 'could not reach AssemblyAI' })
  await flush()
  assert.equal(h.W.all.length, 2)
  h.rec.cancel('user')
  assert.equal(h.W.all[1].closedByClient, true)
  await assertSilentAfter(h, 5)
})

test('cancel when idle is refused and fires nothing', () => {
  const h = rig()
  assert.equal(h.rec.cancel('user'), false)
  assert.equal(h.events.length, 0)
})

/* ------------------------------------------------------------------ */
/* the answer: retry, deadline, failures                               */
/* ------------------------------------------------------------------ */

test('one retry: a 502-family answer → a fresh socket gets every kept byte, then "stop"', async () => {
  const h = rig()
  await h.record(1000)
  await h.stop(10)
  const first = h.W.all[0]
  first.reply({ error: 'could not reach AssemblyAI', detail: 'x' })
  await flush()
  assert.equal(h.W.all.length, 2)
  const second = h.W.all[1]
  assert.deepEqual(second.texts, ['stop'])
  assert.deepEqual(second.bytes, first.bytes, 'the same bytes')
  assert.ok(second.binary.length < first.binary.length, 'coalesced into fewer frames')
  second.reply({ text: 'second time', first_word_ms: 5 })
  await flush()
  assert.deepEqual(h.names(), ['armed', 'first-audio', 'stopping', 'sent', 'done'])
  assert.equal(h.ev('done').retried, true)
  assert.equal(h.ev('done').text, 'second time')
  assert.equal('last_word_ms' in h.ev('done'), false, 'an absent timing is absent, not undefined')
  assert.deepEqual(await now(h.ev('sent').answer), { text: 'second time', first_word_ms: 5 })
})

test('a second retryable outcome fails: exactly two attempts', async () => {
  const h = rig()
  await h.record(1000)
  await h.stop(10)
  h.W.all[0].reply({ error: 'assemblyai returned 500' }); await flush()
  h.W.all[1].reply({ error: 'assemblyai returned 500' }); await flush()
  assert.equal(h.W.all.length, 2)
  assert.deepEqual(h.names().slice(-1), ['failed'])
  assert.equal(h.ev('failed').message, 'Transcription failed — assemblyai returned 500')
  assert.equal(h.ev('failed').retried, true)
  assert.equal(await now(h.ev('sent').answer), null)
})

test('a final answer fails at once, never retried', async () => {
  const h = rig()
  await h.record(1000)
  await h.stop(10)
  h.W.all[0].reply({ error: 'recording too long' }); await flush()
  assert.equal(h.W.all.length, 1)
  assert.equal(h.ev('failed').message, 'Transcription failed — recording too long')
  assert.equal(h.ev('failed').retried, false)
})

test('Deepgram\'s "no transcript" is an empty transcript, not a failure', async () => {
  const h = rig()
  await h.record(1000)
  await h.stop(10)
  h.W.all[0].reply({ error: 'deepgram returned no transcript' }); await flush()
  assert.equal(h.ev('done').text, '')
})

test('the 30 s deadline after "stop": retried, then "no transcription response"', async () => {
  const h = rig()
  await h.record(1000)
  await h.stop(10)
  await h.clock.advance(29999)
  assert.equal(h.W.all.length, 1)
  await h.clock.advance(1)
  assert.equal(h.W.all.length, 2, 'the retry')
  assert.equal(h.W.all[0].closedByClient, true)
  await h.clock.advance(30000)
  assert.equal(h.ev('failed').message, 'Transcription failed — no transcription response')
  assert.equal(h.ev('failed').retried, true)
})

test('a socket that dies while recording: the take keeps recording; at stop no "stop" on it, the retry carries everything', async () => {
  const h = rig()
  await h.record(500)
  const first = h.W.all[0]
  first.closeFromServer(1006)
  await h.dev.capture(500)
  assert.equal(h.rec.state, 'recording', 'no event, no ending')
  assert.deepEqual(h.names(), ['armed', 'first-audio'])
  await h.stop(10)
  assert.deepEqual(first.texts, [])
  assert.equal(h.W.all.length, 2)
  const second = h.W.all[1]
  const clip = Buffer.from(await h.ev('sent').clip.arrayBuffer())
  assert.deepEqual(second.bytes, clip, 'every kept byte, including those made after the drop')
  assert.ok(second.bytes.length > first.bytes.length)
  second.reply({ text: 'ok after drop' }); await flush()
  assert.equal(h.ev('done').retried, true)
})

test('a malformed answer is retried, then worded "no answer"', async () => {
  const h = rig()
  await h.record(1000)
  await h.stop(10)
  h.W.all[0].reply('this is not json'); await flush()
  h.W.all[1].reply('[]'); await flush()
  assert.equal(h.ev('failed').message, 'Transcription failed — no answer')
})

test('a missing or bad base fails closed: no socket is ever made, and the take ends "transcription connection failed"', async () => {
  for (const base of [undefined, '', 'nonsense', 'ftp://127.0.0.1:1']) {
    const h = rig({ base })
    await h.record(1000)
    await h.stop(10)
    await flush()
    assert.equal(h.W.all.length, 0, String(base))
    assert.equal(h.ev('failed').message, 'Transcription failed — transcription connection failed', String(base))
    assert.equal(h.rec.state, 'idle')
  }
  const short = rig({ base: '' })
  await short.record(100)
  await short.stop(10)
  assert.equal(short.ev('cancelled').reason, 'short', 'the floors still come first')
})

test('a refused connection: retried once, then "transcription connection failed"', async () => {
  const h = rig()
  h.W.autoOpen = false
  await h.record(1000)
  h.W.all[0].error(); h.W.all[0].closeFromServer(1006)
  await h.stop(10)
  assert.equal(h.W.all.length, 2)
  h.W.all[1].error(); h.W.all[1].closeFromServer(1006)
  await flush()
  assert.equal(h.ev('failed').message, 'Transcription failed — transcription connection failed')
})

/* ------------------------------------------------------------------ */
/* the microphone's failures: codes only                               */
/* ------------------------------------------------------------------ */

const domError = (name) => Object.assign(new Error(name), { name })

test('getUserMedia refused: NotAllowedError and SecurityError are "denied", anything else "unavailable"; no words', async () => {
  for (const [name, code] of [['NotAllowedError', 'denied'], ['SecurityError', 'denied'], ['NotFoundError', 'unavailable'], ['NotReadableError', 'unavailable'], ['AbortError', 'unavailable'], ['TypeError', 'unavailable']]) {
    const h = rig()
    h.dev.refuse = domError(name)
    h.rec.start(); await flush()
    assert.deepEqual(h.names(), ['mic-failed'], name)
    assert.equal(h.ev('mic-failed').error, code, name)
    assert.equal('message' in h.ev('mic-failed'), false, 'the UI owns the words')
    assert.equal(h.rec.state, 'idle')
    assert.equal(h.clock.pending(), 0)
  }
})

test('a stream with no audio track, or no MediaStreamTrackProcessor: "unavailable", and the device is not left open', async () => {
  const a = rig(); a.dev.noTrack = true
  a.rec.start(); await flush()
  assert.equal(a.ev('mic-failed').error, 'unavailable')
  assert.equal(a.dev.track().stopped, true)
  const b = rig(); b.dev.noMstp = true
  b.rec.start(); await flush()
  assert.equal(b.ev('mic-failed').error, 'unavailable')
  assert.equal(b.dev.track().stopped, true, 'the open microphone is released')
})

test('the device goes away mid-take: "unavailable", the socket closed without "stop"', async () => {
  const h = rig()
  await h.record(1000)
  h.dev.unplug(); await flush()
  assert.deepEqual(h.names(), ['armed', 'first-audio', 'mic-failed'])
  assert.equal(h.ev('mic-failed').error, 'unavailable')
  assert.deepEqual(h.W.last().texts, [])
  assert.equal(h.W.last().closedByClient, true)
  assert.equal(h.E.instances[0].state, 'closed')
  await assertSilentAfter(h, 3)
})

test('the device goes away while arming, a read fails, or the encoder errors: "unavailable"', async () => {
  const a = rig()
  await a.record(0)
  a.dev.unplug(); await flush()
  assert.deepEqual(a.names(), ['armed', 'mic-failed'])
  const b = rig()
  await b.record(500)
  b.dev.track().reader.fail(domError('InvalidStateError')); await flush()
  assert.equal(b.ev('mic-failed').error, 'unavailable')
  const c = rig()
  await c.record(500)
  c.E.instances[0].error(domError('EncodingError')); await flush()
  assert.equal(c.ev('mic-failed').error, 'unavailable')
  assert.deepEqual(c.W.last().texts, [])
  const d = rig()
  d.E.refuseConfig = domError('NotSupportedError')
  await d.record(20)
  assert.equal(d.ev('mic-failed').error, 'unavailable')
})

test('a sample-rate change mid-take is a device failure', async () => {
  const h = rig()
  await h.record(500)
  h.dev.rate = 44100
  await h.dev.capture(20)
  assert.equal(h.ev('mic-failed').error, 'unavailable')
})

test('a 44.1 kHz device: the encoder runs at 44100 and audioMs counts input frames at 48 kHz', async () => {
  const h = rig({ device: { rate: 44100, frames: 441 } })
  await h.record(1000)
  await h.stop(10)
  assert.equal(h.E.instances[0].cfg.sampleRate, 44100)
  const enc = h.E.instances[0]
  assert.equal(h.ev('sent').audioMs, Math.round((enc.inFrames * 48000) / 44100) / 48)
})

test('every captured buffer is downmixed and handed to the encoder as one mono f32-planar AudioData, and closed', async () => {
  const h = rig()
  await h.record(100)
  const enc = h.E.instances[0]
  assert.equal(enc.inputs.length, 10)
  for (const ad of enc.inputs) {
    assert.equal(ad.init.format, 'f32-planar')
    assert.equal(ad.init.numberOfChannels, 1)
    assert.equal(ad.init.sampleRate, 48000)
    assert.equal(ad.init.numberOfFrames, 480)
    assert.equal(ad.init.data[0], 0.375)
    assert.equal(ad.closed, true)
  }
})

test('mic-recorder.ts carries no ai-service port literal', () => {
  assert.equal(/8770/.test(readFileSync(SRC, 'utf8')), false)
})
