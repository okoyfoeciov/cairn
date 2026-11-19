/**
 * tests/frontend/mic-take.test.mjs — CONTRACT §0.58 E111's `MicAudio`
 * (src/mic-take.ts): one take composed from the recorder, the playback trim
 * with its per-take VAD worker, and the clip player, in comart's offscreen.js
 * order (start :680-695, finish :818-896).
 *
 * Everything the take composes is injected and logs into ONE array, so the
 * order of warm, warmSink, the trim and every release is asserted directly.
 * The recorder fake keeps the real one's contract (mic-recorder.ts): 'stopping'
 * fires inside stop(), 'cancelled' fires inside cancel(), 'sent' carries the
 * clip and an answer promise that settles at the final answer.  Two tests at
 * the end run the real recorder over fake browser APIs.  The bound tests run
 * the real trimClip (OfflineAudioContext stubbed) and, where named, the real
 * worker host over a fake Worker that never answers.
 */

import { strict as assert } from 'node:assert'
import { test, before, after } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const src = (f) => JSON.stringify(join(ROOT, 'src', f))

/** @type {any} */ let M

before(async () => {
  const esbuild = await import(pathToFileURL(join(ROOT, 'node_modules', 'esbuild', 'lib', 'main.js')).href)
  const dir = mkdtempSync(join(tmpdir(), 'cairn-mic-take-'))
  process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })
  const out = join(dir, 'bundle.mjs')
  await esbuild.build({
    stdin: {
      contents: [
        'export * from ' + src('mic-take.ts'),
        'export { createMicRecorder } from ' + src('mic-recorder.ts'),
        'export { sileroVadWorker, segments, pick } from ' + src('vad.ts'),
        'export { localTrimWork } from ' + src('mic-trim.ts'),
      ].join('\n') + '\n',
      resolveDir: ROOT, sourcefile: 'mic-take-test-entry.ts', loader: 'ts',
    },
    outfile: out, bundle: true, format: 'esm', platform: 'neutral',
    target: 'es2021', absWorkingDir: ROOT, logLevel: 'silent',
  })
  M = await import(pathToFileURL(out).href)
})

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const flush = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)) }
/** Flush until `cond` holds; fails (never hangs) after `max` rounds. */
async function until(cond, what, max = 200) {
  for (let i = 0; i < max; i++) { if (cond()) return; await flush(1) }
  assert.fail('never happened: ' + what)
}
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
/** 'pending', or what the promise settled with (never an await that could hang). */
async function peek(p) {
  let v = 'pending'
  p.then((x) => { v = { value: x } }, (e) => { v = { error: e } })
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

const WEBM = () => new Blob([new Uint8Array(4000)], { type: 'audio/webm;codecs=opus' })
const WAV = (n = 100) => new Blob([new Uint8Array(44 + n)], { type: 'audio/wav' })
const ANSWER = { text: 'hello there', first_word_ms: 120, last_word_ms: 880 }

/** The recorder, keeping mic-recorder.ts's contract. */
function fakeRecorder(log) {
  const handlers = new Map()
  let answer = null
  const r = {
    state: 'idle', opts: null, refuse: false, clip: null, audioMs: 0,
    on(type, fn) {
      if (!handlers.has(type)) handlers.set(type, [])
      const l = handlers.get(type); l.push(fn)
      return () => { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1) }
    },
    listeners() { let n = 0; for (const l of handlers.values()) n += l.length; return n },
    /** Straight to the handlers, even out of turn: what a stray event would do. */
    emit(type, d) { for (const fn of [...(handlers.get(type) ?? [])]) fn(d) },
    start() { log.push('rec.start'); if (r.refuse || r.state !== 'idle') return false; r.state = 'arming'; answer = deferred(); return true },
    stop() {
      if (r.state !== 'recording') { log.push('rec.stop refused'); return false }
      log.push('rec.stop'); r.state = 'stopping'; r.emit('stopping', {}); return true
    },
    cancel(reason = 'user') {
      log.push('rec.cancel ' + reason)
      if (r.state === 'idle') return false
      r.end(null); r.emit('cancelled', { reason, stats: {} }); return true
    },
    end(a) { r.state = 'idle'; answer.resolve(a) },
    firstAudio() { r.state = 'recording'; r.emit('first-audio', { armMs: 5, sampleRate: 48000, channels: 1 }) },
    sent(clip = WEBM(), audioMs = 8020) {
      r.state = 'transcribing'; r.clip = clip; r.audioMs = audioMs
      r.emit('sent', { clip, audioMs, answer: answer.promise })
    },
    done(a = ANSWER) { r.end(a); r.emit('done', { ...a, clip: r.clip, audioMs: r.audioMs, retried: false, stats: {} }) },
    failed(message = 'Transcription failed — assemblyai returned 500') { r.end(null); r.emit('failed', { message, reason: 'status 500', retried: true, stats: {} }) },
    micFailed(error = 'denied') { r.end(null); r.emit('mic-failed', { error, detail: 'NotAllowedError' }) },
    short() { r.end(null); r.emit('cancelled', { reason: 'short', stats: {} }) },
    cap() { r.end(null); r.emit('cancelled', { reason: 'cap', stats: {} }) },
  }
  return r
}

/** A VAD worker host (src/vad.ts's shape).  `o.warm`/`o.probs`: 'ok' | 'hang' |
 *  'fail'; `o.deaf`: dispose() leaves pending calls pending. */
function fakeHost(log, k, o = {}) {
  const pending = []
  const hang = () => { const d = deferred(); pending.push(d); return d.promise }
  const local = M.localTrimWork()
  const h = {
    k, disposed: 0,
    warm() {
      log.push(`vad${k}.warm`)
      if (h.disposed) return Promise.reject(new Error('VAD disposed'))
      if (o.warm === 'hang') return hang()
      if (o.warm === 'fail') return Promise.reject(new Error('no available backend found'))
      return Promise.resolve()
    },
    probabilities(x) {
      log.push(`vad${k}.probabilities`)
      if (h.disposed) return Promise.reject(new Error('VAD disposed'))
      if (o.probs === 'hang') return hang()
      return Promise.resolve({ probs: new Float32Array(Math.max(1, Math.ceil(x.length / 512))).fill(0.01), frameSec: 512 / 16000 })
    },
    segments: (p, f) => M.segments(p, f),
    pick: (p, f, a) => M.pick(p, f, a),
    bounds(buf) { log.push(`vad${k}.bounds`); return local.bounds(buf) },
    wav(a, z) { log.push(`vad${k}.wav`); return local.wav(a, z) },
    dispose() {
      log.push(`vad${k}.dispose`); h.disposed++
      if (!o.deaf) for (const d of pending.splice(0)) d.reject(new Error('VAD disposed'))
    },
  }
  return h
}

function fakeClip(log, n, blob, ms) {
  log.push(`clip${n} ${blob.type} ${ms}`)
  const c = {
    n, blob, ms, released: 0,
    play: () => ({ playing: true, t: 0, dur: ms / 1000 }),
    seek: () => null,
    state: () => ({ playing: false, t: 0, dur: ms / 1000 }),
    watch() {},
    release() { c.released++; log.push(`clip${n}.release`) },
  }
  return c
}

const EVENTS = ['recording', 'micFailed', 'transcribing', 'done', 'failed', 'cancelled']
function sink(log, throwing = {}) {
  const got = []
  const ev = {}
  for (const name of EVENTS) {
    ev[name] = (x) => { got.push([name, x]); log.push('ev.' + name); if (throwing[name]) throw new Error('ui ' + name + ' threw') }
  }
  return { ev, got, names: () => got.map((g) => g[0]) }
}

function rig(o = {}) {
  const log = []
  const clock = o.clock ?? fakeClock()
  const errors = []
  const recs = []; const hosts = []; const trims = []; const clips = []
  const deps = {
    recorder: (opts) => { const r = fakeRecorder(log); r.opts = opts; recs.push(r); log.push('rec.new'); return r },
    vad: () => {
      const k = hosts.length + 1
      const h = o.host ? o.host(k, log) : fakeHost(log, k, o.vad ?? {})
      hosts.push(h); log.push(`vad${k}.new`)
      return h
    },
    createClip: (blob, ms) => { const c = fakeClip(log, clips.length + 1, blob, ms); clips.push(c); return c },
    warmSink: () => log.push('warmSink'),
    stopWarmSink: () => log.push('stopWarmSink'),
    timers: clock,
  }
  if (!o.realTrim) {
    deps.trimClip = (blob, hint, vad, work) => {
      log.push('trim')
      const d = deferred()
      trims.push({ blob, hint, vad, work, resolve: d.resolve, reject: d.reject })
      return d.promise
    }
  }
  const audio = M.createMicAudio({
    base: 'http://127.0.0.1:4321',
    onError: (e, c) => { errors.push([c, e]); log.push('onError ' + c) },
    deps: { ...deps, ...(o.deps ?? {}) },
  })
  return {
    audio, log, clock, errors, recs, hosts, trims, clips,
    rec: () => recs[recs.length - 1],
    host: () => hosts[hosts.length - 1],
    start(throwing) { const s = sink(log, throwing); const take = audio.start(s.ev); return { take, ...s } },
  }
}

/** Starts a take and walks it to `phase`. */
async function to(h, phase) {
  const t = h.start()
  if (phase === 'arming') return t
  h.rec().firstAudio()
  if (phase === 'recording') return t
  assert.equal(t.take.stop(), true)
  if (phase === 'stopping') return t
  h.rec().sent()
  if (phase === 'transcribing') return t
  h.rec().done()
  await flush()
  return t // 'trimming': the answer is in, the trim is not
}
const tail = (log, from) => log.slice(from)

/* ------------------------------------------------------------------ */
/* construction and start                                              */
/* ------------------------------------------------------------------ */

test('VAD_BOUND_MS is 10 s', () => {
  assert.equal(M.VAD_BOUND_MS, 10000)
})

test('constructing it opens nothing: no microphone, no worker, no timer', () => {
  const h = rig()
  assert.deepEqual(h.log, [])
  assert.equal(h.clock.pending(), 0)
  // the browser defaults are only looked up by a take
  const bare = M.createMicAudio({ base: 'http://127.0.0.1:1', onError: () => {} })
  bare.destroy()
})

test("start, in comart's order (offscreen.js:688-695) but for warm(): stopWarmSink, a new VAD worker, the last clip dropped, the microphone, and only then warm(), not awaited", async () => {
  // warm()'s first call builds the Worker from app.js's payload, synchronously:
  // getUserMedia goes out first, so the device opens while that runs.
  const h = rig({ vad: { warm: 'hang' } })
  const t1 = h.start()
  assert.deepEqual(h.log, ['stopWarmSink', 'vad1.new', 'rec.new', 'rec.start', 'vad1.warm'])
  assert.equal(typeof t1.take.stop, 'function', 'start() returned while warm() is still pending')
  assert.equal(h.rec().state, 'arming')
  h.rec().firstAudio(); t1.take.stop(); h.rec().sent(); h.rec().done()
  await flush()
  h.trims[0].resolve({ blob: WAV(), ms: 700 })
  await until(() => t1.names().includes('done'), 'done')
  assert.equal(h.clips.length, 1)

  const at = h.log.length
  h.start()
  assert.deepEqual(tail(h.log, at), ['stopWarmSink', 'vad2.new', 'clip1.release', 'rec.start', 'vad2.warm'],
    'a NEW worker per take, and the previous take\'s clip goes before the microphone opens')
  assert.equal(h.recs.length, 1, 'one recorder, reused')
  assert.notEqual(h.hosts[0], h.hosts[1])
})

test('the recorder gets the base verbatim and an onError that reaches the caller', () => {
  const h = rig()
  h.start()
  assert.equal(h.rec().opts.base, 'http://127.0.0.1:4321')
  const err = new Error('x')
  h.rec().opts.onError(err, 'mic-recorder sent')
  assert.deepEqual(h.errors, [['mic-recorder sent', err]])
})

test('a base the recorder cannot use is passed on as is: no fallback origin is invented', () => {
  for (const base of ['', 'file:///etc/passwd']) {
    const recs = []
    const a = M.createMicAudio({ base, onError: () => {}, deps: { recorder: (o) => { recs.push(o); return fakeRecorder([]) }, vad: () => fakeHost([], 1), warmSink() {}, stopWarmSink() {}, timers: fakeClock() } })
    a.start(sink([]).ev)
    assert.equal(recs[0].base, base)
  }
})

/* ------------------------------------------------------------------ */
/* the events of a take                                                */
/* ------------------------------------------------------------------ */

test("first audio is recording(); stop() is the recorder's (false while arming, true once recording, false after); stopping is transcribing()", async () => {
  const h = rig()
  const t = h.start()
  assert.equal(t.take.stop(), false, 'arming: nothing happens')
  assert.equal(h.rec().state, 'arming')
  assert.deepEqual(t.names(), [])
  h.rec().firstAudio()
  assert.deepEqual(t.names(), ['recording'])
  assert.equal(t.take.stop(), true)
  assert.deepEqual(t.names(), ['recording', 'transcribing'], 'transcribing() fires inside stop()')
  assert.equal(t.take.stop(), false, 'already stopping')
  assert.equal(h.log.filter((l) => l === 'rec.stop').length, 1)
})

test('sent: warmSink, then trimClip(the sent clip, the answer\'s word hint, the bounded VAD) at once; nothing of it at stopping (finding 14)', async () => {
  const h = rig()
  const t = await to(h, 'stopping')
  assert.ok(!h.log.includes('warmSink'), 'not at stopping')
  assert.ok(!h.log.includes('trim'))
  const at = h.log.length
  const clip = WEBM()
  h.rec().sent(clip, 8020)
  assert.deepEqual(tail(h.log, at), ['warmSink', 'trim'])
  const tr = h.trims[0]
  assert.equal(tr.blob, clip)
  for (const k of ['warm', 'probabilities', 'segments', 'pick', 'bounds', 'wav']) assert.equal(typeof tr.vad[k], 'function', 'vad.' + k)
  assert.equal(tr.work, tr.vad, 'the same worker does the sample work (TrimWork)')
  assert.notEqual(tr.vad, h.host(), 'never the raw host: every call is bounded')
  assert.equal(await peek(tr.hint), 'pending', 'the hint waits for the answer')
  h.rec().done({ text: 'hi', first_word_ms: 120, last_word_ms: 880 })
  assert.deepEqual((await peek(tr.hint)).value, { first: 120, last: 880 })
  assert.deepEqual(t.names(), ['recording', 'transcribing'], 'done waits for the trim')
})

test('done: the trim is awaited, the worker terminated once it settles, then the clip is the trimmed WAV at its length; the warm sink is left for the card', async () => {
  const h = rig()
  const t = await to(h, 'trimming')
  assert.deepEqual(t.names(), ['recording', 'transcribing'])
  assert.equal(h.clips.length, 0, 'no clip before the trim')
  assert.equal(h.host().disposed, 0, 'the worker is alive while the trim runs')
  const at = h.log.length
  const wav = WAV()
  h.trims[0].resolve({ blob: wav, ms: 8644 })
  await until(() => t.names().includes('done'), 'done')
  assert.deepEqual(tail(h.log, at), ['vad1.dispose', 'clip1 audio/wav 8644', 'ev.done'])
  const [, d] = t.got.at(-1)
  assert.deepEqual(Object.keys(d).sort(), ['clip', 'text'])
  assert.equal(d.text, 'hello there')
  assert.equal(d.clip, h.clips[0])
  assert.equal(h.clips[0].blob, wav)
  assert.equal(h.log.filter((l) => l === 'stopWarmSink').length, 1, 'only the one at start: done keeps the sink awake until the card plays')
  assert.equal(h.clips[0].released, 0)
  assert.equal(h.rec().listeners(), 0, 'the take let go of the recorder')
  assert.equal(h.clock.pending(), 0, 'no bound timer left behind')
})

test("a trim that gives up: the clip is the recorded WebM, with the recorder's audioMs as its length (offscreen.js:895)", async () => {
  const h = rig()
  const t = h.start()
  h.rec().firstAudio(); t.take.stop()
  const webm = WEBM()
  h.rec().sent(webm, 8020.5)
  h.rec().done({ text: '' })
  h.trims[0].resolve(null)
  await until(() => t.names().includes('done'), 'done')
  assert.equal(h.clips[0].blob, webm)
  assert.equal(h.clips[0].ms, 8020.5)
  assert.equal(t.got.at(-1)[1].text, '', "'' is no speech; the UI words it")
})

test('a trim that throws is reported and plays the recording as is', async () => {
  const h = rig()
  const t = await to(h, 'trimming')
  h.trims[0].reject(new Error('decode failed'))
  await until(() => t.names().includes('done'), 'done')
  assert.equal(h.clips[0].blob.type, 'audio/webm;codecs=opus')
  assert.deepEqual(h.errors.map((e) => e[0]), ['mic-trim'])
})

test('failed: stopWarmSink, the worker terminated, then failed(message) verbatim; a trim that settles later makes no clip', async () => {
  const h = rig()
  const t = await to(h, 'transcribing')
  const at = h.log.length
  h.rec().failed('Transcription failed — assemblyai returned 500')
  assert.deepEqual(tail(h.log, at), ['stopWarmSink', 'vad1.dispose', 'ev.failed'])
  assert.deepEqual(t.got.at(-1), ['failed', 'Transcription failed — assemblyai returned 500'])
  h.trims[0].resolve({ blob: WAV(), ms: 500 })
  await flush()
  assert.equal(h.clips.length, 0)
  assert.deepEqual(t.names(), ['recording', 'transcribing', 'failed'])
})

test("too short: stopWarmSink, the worker terminated, cancelled('short'); no warmSink and no trim", async () => {
  const h = rig()
  const t = await to(h, 'stopping')
  const at = h.log.length
  h.rec().short()
  assert.deepEqual(tail(h.log, at), ['stopWarmSink', 'vad1.dispose', 'ev.cancelled'])
  assert.deepEqual(t.got.at(-1), ['cancelled', 'short'])
  assert.ok(!h.log.includes('warmSink'))
  assert.ok(!h.log.includes('trim'))
})

test("the cap: the recorder's 'cap' is cancelled('over'), while recording and while arming", async () => {
  for (const phase of ['recording', 'arming']) {
    const h = rig()
    const t = await to(h, phase)
    const at = h.log.length
    h.rec().cap()
    assert.deepEqual(tail(h.log, at), ['stopWarmSink', 'vad1.dispose', 'ev.cancelled'], phase)
    assert.deepEqual(t.got.at(-1), ['cancelled', 'over'], phase)
  }
})

test('microphone failures are micFailed(code): denied while arming, unavailable mid-take; the worker terminated', async () => {
  for (const [phase, code] of [['arming', 'denied'], ['recording', 'unavailable']]) {
    const h = rig()
    const t = await to(h, phase)
    const at = h.log.length
    h.rec().micFailed(code)
    assert.deepEqual(tail(h.log, at), ['stopWarmSink', 'vad1.dispose', 'ev.micFailed'], phase)
    assert.deepEqual(t.got.at(-1), ['micFailed', code])
  }
})

test("a recorder that will not start ends the take at once with micFailed('unavailable')", () => {
  const h = rig()
  h.audio.start(sink([]).ev).cancel()
  h.rec().refuse = true
  const s = sink(h.log)
  const at = h.log.length
  const take = h.audio.start(s.ev)
  assert.deepEqual(tail(h.log, at), ['stopWarmSink', 'vad2.new', 'rec.start', 'stopWarmSink', 'vad2.dispose', 'ev.micFailed'],
    'no microphone, so no worker is ever made: warm() is never called')
  assert.deepEqual(s.got, [['micFailed', 'unavailable']])
  assert.equal(take.stop(), false)
})

/* ------------------------------------------------------------------ */
/* cancel, exactly one ending, stale clips                             */
/* ------------------------------------------------------------------ */

for (const phase of ['arming', 'recording', 'stopping', 'transcribing', 'trimming']) {
  test(`cancel() while ${phase}: the recorder discards, its own 'cancelled' is not heard, the sink stops, the worker goes, and nothing fires after it`, async () => {
    // warm() still pending, so its bound timer is live when the take goes
    const h = rig({ vad: { warm: 'hang' } })
    const t = await to(h, phase)
    const before = t.names()
    const at = h.log.length
    t.take.cancel()
    const recLive = phase !== 'trimming'
    assert.deepEqual(tail(h.log, at), [...(recLive ? ['rec.cancel user'] : []), 'stopWarmSink', 'vad1.dispose'])
    assert.equal(h.rec().state, 'idle')
    assert.deepEqual(t.names(), before, 'nothing, not even a cancelled')
    // a late trim and stray recorder events change nothing
    h.trims[0]?.resolve({ blob: WAV(), ms: 400 })
    for (const [type, d] of [['first-audio', {}], ['stopping', {}], ['done', { ...ANSWER, clip: WEBM(), audioMs: 1 }], ['failed', { message: 'x' }], ['cancelled', { reason: 'short' }]]) h.rec().emit(type, d)
    await flush()
    assert.deepEqual(t.names(), before)
    assert.equal(h.clips.length, 0, 'a cancelled take never makes a clip')
    assert.equal(t.take.stop(), false)
    const n = h.log.length
    t.take.cancel()
    assert.equal(h.log.length, n, 'a second cancel does nothing')
    assert.equal(h.host().disposed, 1)
    assert.equal(h.clock.pending(), 0)
    assert.deepEqual(h.errors, [])
  })
}

test('exactly one ending: after failed, a stray done from the recorder is not forwarded', async () => {
  const h = rig()
  const t = await to(h, 'transcribing')
  const r = h.rec()
  r.failed()
  r.emit('done', { ...ANSWER, clip: WEBM(), audioMs: 1 })
  r.emit('cancelled', { reason: 'cap' })
  h.trims[0].resolve({ blob: WAV(), ms: 1 })
  await flush()
  assert.deepEqual(t.names(), ['recording', 'transcribing', 'failed'])
})

test('exactly one ending even when the recorder ignores unsubscribe', async () => {
  const log = []
  const r = fakeRecorder(log)
  const all = []
  r.on = (type, fn) => { all.push([type, fn]); return () => {} }
  r.emit = (type, d) => { for (const [k, fn] of all) if (k === type) fn(d) }
  const clips = []
  const a = M.createMicAudio({
    base: 'http://127.0.0.1:1', onError: () => {},
    deps: {
      recorder: () => r, vad: () => fakeHost(log, 1), timers: fakeClock(),
      trimClip: async () => null, createClip: (b, ms) => { const c = fakeClip(log, 1, b, ms); clips.push(c); return c },
      warmSink() {}, stopWarmSink() {},
    },
  })
  const s = sink(log)
  const take = a.start(s.ev)
  r.firstAudio(); take.stop(); r.sent(); r.short()
  r.emit('done', { ...ANSWER, clip: WEBM(), audioMs: 1 })
  r.emit('failed', { message: 'x' })
  r.emit('mic-failed', { error: 'denied' })
  r.emit('first-audio', {})
  await flush()
  assert.deepEqual(s.names(), ['recording', 'transcribing', 'cancelled'])
  assert.equal(clips.length, 0)
})

test('cancel() after done does nothing: the card keeps its clip, and nothing reaches the recorder', async () => {
  const h = rig()
  const t = await to(h, 'trimming')
  h.trims[0].resolve({ blob: WAV(), ms: 900 })
  await until(() => t.names().includes('done'), 'done')
  const at = h.log.length
  t.take.cancel()
  assert.deepEqual(tail(h.log, at), [])
  assert.equal(h.clips[0].released, 0)
})

test('stale clips: the next take drops the last clip before the microphone opens (offscreen.js:695), and destroy() drops it too', async () => {
  const h = rig()
  const t = await to(h, 'trimming')
  h.trims[0].resolve({ blob: WAV(), ms: 900 })
  await until(() => t.names().includes('done'), 'done')
  h.start().take.cancel()
  assert.equal(h.clips[0].released, 1)
  assert.ok(h.log.indexOf('clip1.release') < h.log.lastIndexOf('rec.start'))

  const g = rig()
  const u = await to(g, 'trimming')
  g.trims[0].resolve(null)
  await until(() => u.names().includes('done'), 'done')
  g.audio.destroy()
  assert.equal(g.clips[0].released, 1)
})

test('stale clips: a take discarded while its trim runs never makes a clip, so no object URL is left behind', async () => {
  const h = rig()
  const t = await to(h, 'trimming')
  t.take.cancel()
  h.trims[0].resolve({ blob: WAV(), ms: 400 })
  await flush()
  assert.equal(h.clips.length, 0)
})

test("a discarded take's stop() never reaches the next take", async () => {
  const h = rig()
  const t1 = await to(h, 'recording')
  t1.take.cancel()
  const t2 = h.start()
  h.rec().firstAudio()
  assert.equal(t1.take.stop(), false)
  assert.equal(h.rec().state, 'recording')
  assert.deepEqual(t2.names(), ['recording'])
  const done = await to(rig(), 'trimming')
  assert.equal(done.take.stop(), false, 'nor does an answered one')
})

test("a recorder that discards a live take on its own ('left') ends it silently, and says so", async () => {
  const h = rig()
  const t = await to(h, 'recording')
  const at = h.log.length
  h.rec().cancel('left')
  assert.deepEqual(tail(h.log, at), ['rec.cancel left', 'onError mic-take', 'stopWarmSink', 'vad1.dispose'])
  assert.deepEqual(t.names(), ['recording'])
})

test("a clip that cannot be made ends the take with failed('Transcription failed — no answer')", async () => {
  const h = rig({ deps: { createClip: () => { throw new Error('createObjectURL failed') } } })
  const t = await to(h, 'trimming')
  h.trims[0].resolve({ blob: WAV(), ms: 500 })
  await until(() => t.names().includes('failed'), 'failed')
  assert.deepEqual(t.got.at(-1), ['failed', 'Transcription failed — no answer'])
  assert.deepEqual(h.errors.map((e) => e[0]), ['mic-clip'])
  assert.equal(h.log.filter((l) => l === 'stopWarmSink').length, 2)
})

test('start() while a take is in flight discards that take first, and says so', async () => {
  const h = rig()
  const t1 = await to(h, 'recording')
  const at = h.log.length
  const t2 = h.start()
  assert.deepEqual(tail(h.log, at), ['onError mic-take', 'rec.cancel user', 'stopWarmSink', 'vad1.dispose', 'stopWarmSink', 'vad2.new', 'rec.start', 'vad2.warm'])
  h.rec().firstAudio()
  assert.deepEqual(t1.names(), ['recording'])
  assert.deepEqual(t2.names(), ['recording'])
})

test('destroy(): the live take is discarded silently, the worker goes, the sink stops, and start() is refused afterwards', async () => {
  const h = rig()
  const t = await to(h, 'recording')
  const at = h.log.length
  h.audio.destroy()
  assert.deepEqual(tail(h.log, at), ['rec.cancel user', 'stopWarmSink', 'vad1.dispose'])
  assert.deepEqual(t.names(), ['recording'])
  h.audio.destroy()
  assert.equal(h.log.length, at + 3, 'idempotent')
  assert.throws(() => h.start())
  const g = rig()
  g.audio.destroy()
  assert.deepEqual(g.log, ['stopWarmSink'], 'with no take, it only stops the sink')
})

test('a UI handler that throws is reported, and the take still ends once', async () => {
  const h = rig()
  const t = h.start({ recording: true, transcribing: true })
  h.rec().firstAudio(); t.take.stop(); h.rec().sent(); h.rec().done()
  h.trims[0].resolve(null)
  await until(() => t.names().includes('done'), 'done')
  assert.deepEqual(t.names(), ['recording', 'transcribing', 'done'])
  assert.deepEqual(h.errors.map((e) => e[0]), ['mic-take recording', 'mic-take transcribing'])
})

/* ------------------------------------------------------------------ */
/* the VAD bound                                                       */
/* ------------------------------------------------------------------ */

test('a warm() that fails on its own is logged and the take goes on (offscreen.js:692-693)', async () => {
  const h = rig({ vad: { warm: 'fail' } })
  const t = h.start()
  await flush()
  assert.deepEqual(h.errors.map((e) => [e[0], e[1].message]), [['mic-vad-warm', 'no available backend found']])
  assert.equal(h.host().disposed, 0, 'a later probabilities() may warm again')
  h.rec().firstAudio()
  assert.deepEqual(t.names(), ['recording'])
})

test('the bound: a warm() that never settles is rejected at VAD_BOUND_MS, the worker terminated once and reported once; the take goes on', async () => {
  const h = rig({ vad: { warm: 'hang' } })
  const t = h.start()
  h.rec().firstAudio()
  await h.clock.advance(9999)
  assert.equal(h.host().disposed, 0)
  assert.deepEqual(h.errors, [])
  await h.clock.advance(1)
  assert.equal(h.host().disposed, 1)
  assert.deepEqual(h.errors.map((e) => e[0]), ['mic-vad-bound'])
  assert.match(h.errors[0][1].message, /warm.*10000 ms/)
  t.take.stop(); h.rec().sent()
  const v = h.trims[0].vad
  assert.ok((await peek(v.probabilities(new Float32Array(16)))).error, 'a closed VAD rejects at once')
  h.rec().done()
  h.trims[0].resolve(null)
  await until(() => t.names().includes('done'), 'done')
  assert.equal(h.host().disposed, 1)
  assert.equal(h.errors.length, 1)
})

/** OfflineAudioContext as the trim uses it: 1.2 s of room, a 1.8 s "word",
 *  0.5 s of room, decoded at whatever rate the context asks for. */
class StubOfflineAudioContext {
  constructor(channels, length, rate) { this.rate = rate }
  async decodeAudioData() {
    const sr = this.rate
    const x = new Float32Array(Math.round(3.5 * sr))
    let s = 1234
    for (let i = 0; i < x.length; i++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0
      const voiced = i >= 1.2 * sr && i < 3.0 * sr
      x[i] = voiced ? 0.3 * Math.sin(2 * Math.PI * 220 * i / sr) : 0.002 * ((s / 2 ** 32) * 2 - 1)
    }
    return { sampleRate: sr, length: x.length, numberOfChannels: 1, duration: x.length / sr, getChannelData: () => x }
  }
}
let savedCtx
before(() => { savedCtx = globalThis.OfflineAudioContext; globalThis.OfflineAudioContext = StubOfflineAudioContext })
after(() => { globalThis.OfflineAudioContext = savedCtx })

/** A Worker for the real host (src/vad.ts) that answers only what `answers` lists. */
function quietWorker(answers = []) {
  const on = { message: [], error: [], messageerror: [] }
  const w = {
    posts: [], terminated: 0,
    postMessage(msg) { w.posts.push(msg.type); if (answers.includes(msg.type)) queueMicrotask(() => { for (const fn of on.message) fn({ data: { id: msg.id, ok: true } }) }) },
    addEventListener(type, fn) { on[type].push(fn) },
    terminate() { w.terminated++ },
  }
  return w
}
// Rule 2 on the stub's signal: first word 1300 ms - 150 ms of pad, last word
// 2900 ms + 150 ms: samples [55200, 146400) at 48 kHz = 1900 ms.
const HINTED = { text: 'hello', first_word_ms: 1300, last_word_ms: 2900 }

test('the bound, end to end: a VAD worker that never answers (the real host and trimClip) still opens the card at VAD_BOUND_MS, cut by rule 2 from the word timings', async () => {
  const workers = []
  const h = rig({ realTrim: true, host: () => M.sileroVadWorker(() => { const w = quietWorker(); workers.push(w); return w }) })
  const t = h.start()
  h.rec().firstAudio()
  await h.clock.advance(3000)
  t.take.stop(); h.rec().sent(WEBM(), 3500); h.rec().done(HINTED)
  await flush(10)
  await h.clock.advance(6999)
  assert.deepEqual(t.names(), ['recording', 'transcribing'], 'the trim is still waiting on the VAD')
  assert.equal(workers[0].terminated, 0)
  await h.clock.advance(1)
  await until(() => t.names().includes('done'), 'done after the bound')
  assert.equal(workers[0].terminated, 1)
  assert.deepEqual(workers[0].posts, ['warm', 'bounds'], 'probabilities() never reached the dead worker')
  assert.equal(h.clips[0].blob.type, 'audio/wav')
  assert.equal(h.clips[0].blob.size, 44 + 2 * 91200)
  assert.equal(h.clips[0].ms, 1900)
  assert.deepEqual(h.errors.map((e) => e[0]), ['mic-vad-bound'])
})

test('the bound on probabilities(): it rejects even when the host would not, the worker is terminated, and the trim falls back to rule 2', async () => {
  const h = rig({ realTrim: true, vad: { probs: 'hang', deaf: true } })
  const t = h.start()
  h.rec().firstAudio()
  await h.clock.advance(3000)
  t.take.stop(); h.rec().sent(WEBM(), 3500); h.rec().done(HINTED)
  await until(() => h.log.includes('vad1.probabilities'), 'probabilities() called')
  await h.clock.advance(9999)
  assert.deepEqual(t.names(), ['recording', 'transcribing'])
  await h.clock.advance(1)
  await until(() => t.names().includes('done'), 'done after the bound')
  assert.equal(h.host().disposed, 1)
  assert.equal(h.clips[0].ms, 1900)
  assert.match(h.errors[0][1].message, /probabilities.*10000 ms/)
})

test('the bound covers the trim\'s sample work too: a worker that never answers bounds() is terminated and the page does the work', async () => {
  const workers = []
  const h = rig({ realTrim: true, host: () => M.sileroVadWorker(() => { const w = quietWorker(['warm']); workers.push(w); return w }) })
  const t = h.start()
  h.rec().firstAudio()
  await h.clock.advance(3000)
  t.take.stop(); h.rec().sent(WEBM(), 3500); h.rec().done(HINTED)
  await until(() => workers[0].posts.includes('bounds'), 'bounds posted')
  await h.clock.advance(9999)
  assert.deepEqual(t.names(), ['recording', 'transcribing'])
  await h.clock.advance(1)
  await until(() => t.names().includes('done'), 'done after the bound')
  assert.equal(workers[0].terminated, 1)
  assert.equal(h.clips[0].ms, 1900)
  assert.match(h.errors[0][1].message, /bounds.*10000 ms/)
})

test('with a VAD that answers, nothing is bounded away: the worker is terminated only when the trim settles', async () => {
  const h = rig({ realTrim: true })
  const t = h.start()
  h.rec().firstAudio()
  await h.clock.advance(3000)
  t.take.stop(); h.rec().sent(WEBM(), 3500); h.rec().done(HINTED)
  await until(() => t.names().includes('done'), 'done')
  assert.equal(h.host().disposed, 1)
  assert.ok(h.log.indexOf('vad1.dispose') > h.log.indexOf('vad1.wav'))
  assert.deepEqual(h.errors, [])
  assert.equal(h.clock.pending(), 0)
})

/* ------------------------------------------------------------------ */
/* over the real recorder                                              */
/* ------------------------------------------------------------------ */

/** The browser APIs the real recorder needs, as mic-recorder.test.mjs fakes them. */
function fakeBrowser(clock, log) {
  const tracks = []
  const readers = []
  function reader() {
    const q = []; let waiting = null; let ended = false
    return {
      read() {
        if (q.length) return Promise.resolve({ value: q.shift(), done: false })
        if (ended) return Promise.resolve({ value: undefined, done: true })
        return new Promise((res) => { waiting = res })
      },
      cancel() { this.end(); return Promise.resolve() },
      end() { ended = true; q.length = 0; if (waiting) { const w = waiting; waiting = null; w({ value: undefined, done: true }) } },
      push(ad) { if (ended) return; if (waiting) { const w = waiting; waiting = null; w({ value: ad, done: false }) } else q.push(ad) },
    }
  }
  const sockets = []
  class WS {
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; this.closed = false; sockets.push(this); queueMicrotask(() => { if (this.readyState === 0) { this.readyState = 1; this.onopen?.({}) } }) }
    send(d) { if (typeof d === 'string') log.push('ws.send ' + d); this.sent.push(d) }
    close() { if (!this.closed) { this.closed = true; log.push('ws.close') } this.readyState = 2 }
    reply(data) { this.onmessage?.({ data: JSON.stringify(data) }) }
  }
  class AudioEncoder {
    constructor({ output }) { this.output = output; this.state = 'unconfigured'; this.in48 = 0; this.n = 0 }
    configure(cfg) { this.rate = cfg.sampleRate; this.state = 'configured' }
    encode(ad) { this.in48 += ad.numberOfFrames * 48000 / this.rate; while (this.in48 >= (this.n + 1) * 2880) this.emit() }
    emit() {
      const k = this.n++
      const head = new Uint8Array(19); head.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, 1]); new DataView(head.buffer).setUint16(10, 312, true)
      this.output({ byteLength: 400, timestamp: k * 60000, duration: 60000, copyTo(dest) { dest.fill(k % 250 + 1) } }, k === 0 ? { decoderConfig: { description: head.buffer } } : {})
    }
    flush() { const total = Math.ceil((this.in48 + 312) / 2880); while (this.n < total) this.emit(); return Promise.resolve() }
    close() { this.state = 'closed' }
  }
  class AudioData { constructor(i) { this.numberOfFrames = i.numberOfFrames } close() {} }
  class MediaStreamTrackProcessor {
    constructor(init) { const r = reader(); readers.push(r); init.track.reader = r; this.readable = { getReader: () => r } }
  }
  const getUserMedia = () => { log.push('gum'); return Promise.resolve().then(() => {
    const t = { stopped: false, reader: null, stop() { if (!t.stopped) { t.stopped = true; log.push('track.stop'); t.reader?.end() } }, addEventListener() {}, getSettings: () => ({ sampleRate: 48000, channelCount: 1 }) }
    tracks.push(t)
    return { getAudioTracks: () => [t], getTracks: () => [t] }
  }) }
  const push = () => {
    const n = 480
    const plane = new Float32Array(n).fill(0.25)
    readers.at(-1).push({ numberOfFrames: n, sampleRate: 48000, numberOfChannels: 1, timestamp: Math.round((clock.now() - 10) * 1000), format: 'f32-planar', copyTo(dest) { dest.set(plane) }, close() {} })
  }
  const capture = async (ms) => { for (let t = 0; t < ms; t += 10) { await clock.advance(10); push(); await flush(1) } await flush() }
  return { deps: { getUserMedia, WebSocket: WS, AudioEncoder, AudioData, MediaStreamTrackProcessor, now: clock.now, timers: clock }, tracks, sockets, capture }
}

function realRig() {
  const clock = fakeClock()
  const h = rig({ clock, deps: { recorder: (o) => { const r = M.createMicRecorder({ ...o, deps: b.deps }); h.realOpts = o; return r } } })
  const b = fakeBrowser(clock, h.log)
  h.browser = b
  return h
}

test('over the real recorder: a whole take is recording, transcribing, then done with the trimmed clip', async () => {
  const h = realRig()
  const t = h.start()
  assert.deepEqual(h.log.filter((l) => l === 'gum' || l === 'vad1.warm'), ['gum', 'vad1.warm'], 'getUserMedia is called inside start(), before the VAD is warmed')
  await flush()
  await h.browser.capture(1000)
  assert.deepEqual(t.names(), ['recording'])
  assert.equal(h.browser.sockets[0].url, 'ws://127.0.0.1:4321/api/transcribe/ws?type=audio%2Fwebm%3Bcodecs%3Dopus%3Bclient%3Dcairn')
  assert.equal(t.take.stop(), true)
  assert.deepEqual(t.names(), ['recording', 'transcribing'])
  assert.ok(!h.log.includes('warmSink'))
  await h.browser.capture(20)
  await until(() => h.trims.length === 1, 'the trim started')
  assert.ok(h.log.indexOf('ws.send stop') < h.log.indexOf('warmSink'), 'warmSink once "stop" went out')
  assert.equal(h.trims[0].blob.type, 'audio/webm;codecs=opus')
  h.browser.sockets[0].reply({ text: ' hi ', first_word_ms: 100, last_word_ms: 700 })
  assert.deepEqual((await peek(h.trims[0].hint)).value, { first: 100, last: 700 })
  assert.deepEqual(t.names(), ['recording', 'transcribing'])
  h.trims[0].resolve({ blob: WAV(), ms: 650 })
  await until(() => t.names().includes('done'), 'done')
  assert.equal(t.got.at(-1)[1].text, 'hi')
  assert.equal(h.clips[0].ms, 650)
  assert.deepEqual(h.errors, [])
})

test('over the real recorder: cancel() while recording closes the socket without "stop", stops the track, and nothing fires', async () => {
  const h = realRig()
  const t = h.start()
  await flush()
  await h.browser.capture(500)
  t.take.cancel()
  await flush()
  assert.ok(h.log.includes('ws.close'))
  assert.ok(!h.log.includes('ws.send stop'))
  assert.equal(h.browser.tracks[0].stopped, true)
  assert.equal(h.host().disposed, 1)
  await h.browser.capture(100)
  assert.deepEqual(t.names(), ['recording'])
  assert.deepEqual(h.errors, [])
  const t2 = h.start()
  await flush()
  await h.browser.capture(30)
  assert.deepEqual(t2.names(), ['recording'], 'the recorder is free for the next take')
})
