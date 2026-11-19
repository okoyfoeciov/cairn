/**
 * tests/frontend/vad.test.mjs — CONTRACT §0.58 E111's voice-activity oracle:
 * comart's vendor/silero/vad.js, split between src/vad.ts (the frame rules and
 * the per-take Worker host) and src/vad-worker.ts (warm + probabilities inside
 * the Worker), plus build-app.mjs's half: the vendored runtime is SHA-256
 * pinned and travels inside app.js as one string.
 *
 * No engine here: the Worker is a fake, and the worker bundle runs in a vm
 * context against a fake `ort`.  The real Silero leg is a real-engine suite.
 * Every probability below is synthetic, and every expected segment is worked
 * out by hand from comart's hysteresis (512 / 16000 = 32 ms frames, so
 * MIN_SIL_MS and MIN_SPEECH_MS are round(0.1 / 0.032) = 3 frames).
 */

import { strict as assert } from 'node:assert'
import { test, before } from 'node:test'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '..', '..')

/** @type {any} */ let M
/** @type {any} */ let esbuild
let dir = ''

before(async () => {
  esbuild = await import(pathToFileURL(join(ROOT, 'node_modules', 'esbuild', 'lib', 'main.js')).href)
  dir = mkdtempSync(join(tmpdir(), 'cairn-vad-'))
  process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })
  const out = join(dir, 'vad.mjs')
  // No define: a unit-test bundle carries no payload, which is a case below.
  await esbuild.build({
    stdin: {
      contents: 'export * from ' + JSON.stringify(join(ROOT, 'src', 'vad.ts')) + '\nexport * as T from ' + JSON.stringify(join(ROOT, 'src', 'mic-trim.ts')) + '\n',
      resolveDir: ROOT, sourcefile: 'vad-test-entry.ts', loader: 'ts',
    },
    outfile: out, bundle: true, format: 'esm', platform: 'neutral', target: 'es2021', absWorkingDir: ROOT, logLevel: 'silent',
  })
  M = await import(pathToFileURL(out).href)
})

const FS = 512 / 16000
const P = (...v) => Float32Array.from(v)
const near = (a, b) => Math.abs(a - b) < 1e-9
const segEq = (got, want, msg) => {
  assert.equal(got.length, want.length, msg + ': ' + JSON.stringify(got))
  got.forEach((s, i) => assert.ok(near(s.start, want[i][0] * FS) && near(s.end, want[i][1] * FS), `${msg}: segment ${i} ${JSON.stringify(s)}`))
}

/* ── vad.js:21-27 ─────────────────────────────────────────────────────────── */

test("comart's constants: 512-sample frames, 64 of context, 16 kHz, 0.5 / 0.35, 100 ms / 100 ms", () => {
  assert.equal(M.FRAME, 512)
  assert.equal(M.CONTEXT, 64)
  assert.equal(M.SR, 16000)
  assert.equal(M.POS, 0.5)
  assert.equal(M.NEG, 0.35)
  assert.equal(M.MIN_SIL_MS, 100)
  assert.equal(M.MIN_SPEECH_MS, 100)
})

/* ── segments(): vad.js:103-132 ───────────────────────────────────────────── */

test('segments: nothing at or over 0.5 is no speech', () => {
  segEq(M.segments(P(0.1, 0.49, 0.3, 0.2), FS), [], 'quiet')
})

test('segments: a word ends after 3 frames under 0.35, at the first of them', () => {
  segEq(M.segments(P(0, 0, 0.9, 0.9, 0.9, 0.9, 0.1, 0.1, 0.1, 0), FS), [[2, 6]], 'word')
})

test('segments: a 2-frame blip is not a word (MIN_SPEECH_MS)', () => {
  segEq(M.segments(P(0, 0.9, 0.9, 0.1, 0.1, 0.1, 0), FS), [], 'blip')
})

test('segments: a dip of two quiet frames is a false negative when 0.5 comes back', () => {
  segEq(M.segments(P(0.9, 0.9, 0.9, 0.1, 0.1, 0.9, 0.9, 0.1, 0.1, 0.1), FS), [[0, 7]], 'dip')
})

test('segments: a frame between 0.35 and 0.5 neither ends nor rescues the silence run', () => {
  // quietAt = 3; frame 4 (0.4) keeps it; frame 5 is the third frame of the run.
  segEq(M.segments(P(0.9, 0.9, 0.9, 0.1, 0.4, 0.1, 0.1), FS), [[0, 3]], 'middle band')
})

test('segments: speech still running at the end closes at the last frame', () => {
  segEq(M.segments(P(0, 0.9, 0.6, 0.6), FS), [[1, 4]], 'open end')
  segEq(M.segments(P(0, 0, 0.9, 0.9), FS), [], 'open end, too short')
})

test('segments: two words', () => {
  segEq(M.segments(P(0.9, 0.9, 0.9, 0, 0, 0, 0, 0.8, 0.8, 0.8, 0.8, 0, 0, 0), FS), [[0, 3], [7, 11]], 'two')
})

/* ── pick(): vad.js:138-156 ───────────────────────────────────────────────── */

// Two words: frames 10-20 (0.32-0.64 s) and 50-60 (1.6-1.92 s).
const TWO = (() => { const p = new Float32Array(80); p.fill(0.9, 10, 20); p.fill(0.9, 50, 60); return p })()

test('pick: no segment is no-speech', () => {
  assert.deepEqual(M.pick(new Float32Array(40), FS, 1), { segments: [], start: null, how: 'no-speech' })
})

test('pick: no anchor takes the first segment', () => {
  const r = M.pick(TWO, FS, NaN)
  assert.equal(r.how, 'first')
  assert.ok(near(r.start, 10 * FS) && near(r.end, 20 * FS))
  assert.equal(r.segments.length, 2)
})

test('pick: a segment containing the anchor, with 150 ms either side, wins', () => {
  assert.equal(M.pick(TWO, FS, 1.7).how, 'contains')
  assert.ok(near(M.pick(TWO, FS, 1.7).start, 50 * FS))
  // 1.6 - 0.15 = 1.45 is still "contains"; 1.92 + 0.15 = 2.07 too.
  assert.equal(M.pick(TWO, FS, 1.451).how, 'contains')
  assert.equal(M.pick(TWO, FS, 2.069).how, 'contains')
  assert.ok(near(M.pick(TWO, FS, 0.2).start, 10 * FS), 'the first word, 120 ms before it')
})

test('pick: otherwise the nearest start within 800 ms, else none-near', () => {
  const r = M.pick(TWO, FS, 1.0)
  assert.equal(r.how, 'nearest')
  assert.ok(near(r.start, 50 * FS), 'start 1.6 is 0.6 away, start 0.32 is 0.68 away')
  const far = M.pick(TWO, FS, 2.5)
  assert.deepEqual({ start: far.start, how: far.how }, { start: null, how: 'none-near' })
})

/* ── sileroVadWorker(): the host ───────────────────────────────────────────── */

/** A Worker as far as the host can tell: it records posts and lets the test
 *  answer, fail or kill it. */
function fakeWorker() {
  const on = { message: [], error: [], messageerror: [] }
  const w = {
    posts: [], terminated: 0,
    postMessage(msg, transfer) { w.posts.push({ msg, transfer }) },
    addEventListener(type, fn) { on[type].push(fn) },
    terminate() { w.terminated += 1 },
    reply(data) { for (const fn of on.message) fn({ data }) },
    fire(type, ev = {}) { for (const fn of on[type]) fn({ preventDefault() {}, message: 'boom', ...ev }) },
    last() { return w.posts[w.posts.length - 1] },
  }
  return w
}
const settle = () => new Promise((r) => setImmediate(r))
/** A promise that must settle soon: a host that never rejects fails the test, never hangs it. */
const soon = (p, ms = 2000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`unsettled after ${ms} ms`)), ms).unref())])
const state = (p) => Promise.race([p.then(() => 'resolved', (e) => 'rejected: ' + e.message), settle().then(() => 'pending')])

test('worker host: constructing it starts nothing', () => {
  let made = 0
  const v = M.sileroVadWorker(() => { made += 1; return fakeWorker() })
  assert.equal(made, 0)
  v.dispose()
  assert.equal(made, 0)
})

test('worker host: warm() posts once to one worker and settles on its answer', async () => {
  const w = fakeWorker()
  let made = 0
  const v = M.sileroVadWorker(() => { made += 1; return w })
  const p = v.warm()
  assert.equal(made, 1)
  assert.deepEqual(w.last().msg, { id: 1, type: 'warm' })
  assert.equal(await state(p), 'pending')
  w.reply({ id: 1, ok: true })
  assert.equal(await state(p), 'resolved')
  const q = v.warm()
  assert.equal(made, 1, 'one worker per host')
  w.reply({ id: 2, ok: false, error: 'no available backend found' })
  assert.equal(await state(q), 'rejected: no available backend found')
})

test('worker host: probabilities() transfers the samples and returns the probabilities', async () => {
  const w = fakeWorker()
  const v = M.sileroVadWorker(() => w)
  const x = new Float32Array(1600)
  const p = v.probabilities(x)
  const { msg, transfer } = w.last()
  assert.equal(msg.type, 'probabilities')
  assert.equal(msg.x, x)
  assert.deepEqual(transfer, [x.buffer], 'the 16 kHz samples are transferred, not copied')
  const probs = P(0.1, 0.9, 0.2, 0.3)
  w.reply({ id: msg.id, ok: true, probs, frameSec: FS })
  const r = await soon(p)
  assert.equal(r.probs, probs)
  assert.equal(r.frameSec, FS)
})

test('worker host: answers are matched by id, not by order', async () => {
  const w = fakeWorker()
  const v = M.sileroVadWorker(() => w)
  const a = v.warm()
  const b = v.probabilities(new Float32Array(10))
  w.reply({ id: 2, ok: true, probs: P(0.5), frameSec: FS })
  assert.equal(await state(b), 'resolved')
  assert.equal(await state(a), 'pending')
  w.reply({ id: 1, ok: true })
  assert.equal(await state(a), 'resolved')
})

for (const kind of ['error', 'messageerror']) {
  test(`worker host: an '${kind}' event rejects every pending call and ends the worker for good`, async () => {
    const w = fakeWorker()
    let made = 0
    const v = M.sileroVadWorker(() => { made += 1; return w })
    const a = v.warm()
    const b = v.probabilities(new Float32Array(10))
    w.fire(kind)
    assert.match(await state(a), /^rejected: /)
    assert.match(await state(b), /^rejected: /)
    assert.equal(w.terminated, 1)
    assert.match(await state(v.warm()), /^rejected: /, 'a dead host never comes back')
    assert.equal(made, 1, 'and never makes a second worker')
  })
}

test('worker host: dispose() terminates once, rejects what is pending, and refuses later calls', async () => {
  const w = fakeWorker()
  const v = M.sileroVadWorker(() => w)
  const a = v.warm()
  v.dispose()
  v.dispose()
  assert.equal(w.terminated, 1)
  assert.match(await state(a), /^rejected: /)
  assert.match(await state(v.probabilities(new Float32Array(4))), /^rejected: /)
  w.reply({ id: 1, ok: true })
  assert.match(await state(a), /^rejected: /, 'a late answer changes nothing')
})

test('worker host: a worker that cannot be made rejects the call instead of throwing', async () => {
  const v = M.sileroVadWorker(() => { throw new Error('no Worker here') })
  let threw = false
  let p
  try { p = v.warm() } catch { threw = true }
  assert.equal(threw, false)
  assert.equal(await state(p), 'rejected: no Worker here')
})

test('worker host: a build without the payload (this bundle) rejects warm() with a reason', async () => {
  const v = M.sileroVadWorker()
  assert.match(await state(v.warm()), /^rejected: .*payload/i)
  v.dispose()
})

test("worker host: the payload's Blob is made once per page, lazily; each take still gets its own Worker from a URL revoked once it is constructed", async () => {
  // app.js's define, as a page bundle has it.  The Blob copies the whole
  // 18 MB string (25-100 ms on the page), so it must not happen per take.
  const out = join(dir, 'vad-payload.mjs')
  await esbuild.build({
    stdin: { contents: 'export * from ' + JSON.stringify(join(ROOT, 'src', 'vad.ts')) + '\n', resolveDir: ROOT, sourcefile: 'vad-payload-entry.ts', loader: 'ts' },
    outfile: out, bundle: true, format: 'esm', platform: 'neutral', target: 'es2021', absWorkingDir: ROOT, logLevel: 'silent',
    define: { __CAIRN_VAD_WORKER__: JSON.stringify('self.onmessage = () => {}') },
  })
  const P2 = await import(pathToFileURL(out).href)
  const log = []
  const saved = { Blob: globalThis.Blob, Worker: globalThis.Worker, create: URL.createObjectURL, revoke: URL.revokeObjectURL }
  let blobs = 0
  globalThis.Blob = class extends saved.Blob { constructor(...a) { super(...a); blobs += 1; log.push('blob ' + this.type) } }
  URL.createObjectURL = (b) => { const u = saved.create.call(URL, b); log.push('url'); return u }
  URL.revokeObjectURL = (u) => { log.push('revoke'); saved.revoke.call(URL, u) }
  globalThis.Worker = class { constructor(u) { log.push('worker ' + String(u).slice(0, 5)) } addEventListener() {} postMessage() {} terminate() { log.push('terminate') } }
  try {
    const host = P2.sileroVadWorker()
    assert.equal(blobs, 0, 'nothing at load or at construction')
    for (let k = 1; k <= 3; k++) {
      const v = k === 1 ? host : P2.sileroVadWorker()
      const p = v.warm()
      v.dispose()
      await p.catch(() => {})
    }
    assert.equal(blobs, 1, 'one Blob for three takes: ' + log.join(' | '))
    assert.deepEqual(log, [
      'blob text/javascript',
      ...Array.from({ length: 3 }, () => ['url', 'worker blob:', 'revoke', 'terminate']).flat(),
    ])
  } finally {
    globalThis.Blob = saved.Blob
    globalThis.Worker = saved.Worker
    URL.createObjectURL = saved.create
    URL.revokeObjectURL = saved.revoke
  }
})

test('worker host: a sample buffer that cannot be posted rejects that call only', async () => {
  const w = fakeWorker()
  w.postMessage = () => { throw new Error('DataCloneError') }
  const v = M.sileroVadWorker(() => w)
  assert.equal(await state(v.probabilities(new Float32Array(4))), 'rejected: DataCloneError')
})

/* ── sileroVadWorker() as the trim's TrimWork ──────────────────────────────── */

/** An AudioBuffer as decodeAudioData gives it: a word-ish burst in a quiet room. */
function stereoBuffer() {
  const n = 48000 * 2
  let s = 7
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32) * 2 - 1
  const l = new Float32Array(n), r = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const voiced = i >= 48000 && i < 84000
    l[i] = voiced ? 0.3 * Math.sin(2 * Math.PI * 220 * i / 48000) : 0.002 * rnd()
    r[i] = l[i] * 0.5
  }
  return { sampleRate: 48000, length: n, numberOfChannels: 2, getChannelData: (c) => (c === 0 ? l : r) }
}

test('TrimWork: bounds() sends every channel to the worker as a copy, not a transfer', async () => {
  const w = fakeWorker()
  const v = M.sileroVadWorker(() => w)
  const buf = stereoBuffer()
  const p = v.bounds(buf)
  const { msg, transfer } = w.last()
  assert.equal(msg.type, 'bounds')
  assert.equal(msg.sr, 48000)
  assert.deepEqual(msg.channels, [buf.getChannelData(0), buf.getChannelData(1)])
  assert.deepEqual(transfer, [], 'the page keeps its samples: they are the fallback')
  w.reply({ id: msg.id, ok: true, length: 96000, bounds: { start: 0.9, end: 1.77 } })
  assert.deepEqual(await soon(p), { length: 96000, bounds: { start: 0.9, end: 1.77 } })
  const q = v.wav(10, 20)
  assert.deepEqual(w.last().msg, { id: msg.id + 1, type: 'wav', a: 10, z: 20 })
  const blob = new Blob(['x'], { type: 'audio/wav' })
  w.reply({ id: msg.id + 1, ok: true, blob })
  assert.equal(await soon(q), blob)
})

test('TrimWork: with the worker dead, bounds() and wav() run on the page and give the local answer', async () => {
  const buf = stereoBuffer()
  const local = M.T.localTrimWork()
  const want = await local.bounds(buf)
  const wantWav = new Uint8Array(await (await local.wav(47000, 50000)).arrayBuffer())
  assert.ok(want.bounds, 'the signal has a word to find')

  const dead = M.sileroVadWorker(() => { throw new Error('no Worker') })
  assert.deepEqual(await soon(dead.bounds(buf)), want)
  assert.deepEqual(new Uint8Array(await (await soon(dead.wav(47000, 50000))).arrayBuffer()), wantWav)

  // Alive for bounds(), dead by wav(): the page mixes its own copy and encodes.
  const w = fakeWorker()
  const v = M.sileroVadWorker(() => w)
  const p = v.bounds(buf)
  w.reply({ id: w.last().msg.id, ok: true, length: want.length, bounds: want.bounds })
  await soon(p)
  const q = v.wav(47000, 50000)
  w.fire('error')
  assert.deepEqual(new Uint8Array(await (await soon(q)).arrayBuffer()), wantWav)
  v.dispose()
  assert.deepEqual(new Uint8Array(await (await soon(v.wav(47000, 50000))).arrayBuffer()), wantWav, 'and after dispose()')
})

test('TrimWork: wav() before any bounds() rejects', async () => {
  const v = M.sileroVadWorker(() => fakeWorker())
  v.dispose()
  await assert.rejects(v.wav(0, 10), /no clip/)
})

/* ── src/vad-worker.ts in a vm, against a fake ort ─────────────────────────── */

const FAKE_ORT = `
self.ort = {
  env: { wasm: {}, versions: { common: 'fake' } },
  Tensor: class { constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; self.__tensors.push(this) }
    dispose() { self.__disposed.push(this) } },
  InferenceSession: { create: (buf, opts) => self.__create(buf, opts) },
}`
const FAKE_MJS = 'export default function factory() {}'
const FAKE_WASM = Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0])
const FAKE_MODEL = Buffer.from([8, 7, 6, 5, 4])

/** Runs the worker bundle in a fresh context that looks like a dedicated
 *  worker: importScripts, Blob URLs, postMessage, setTimeout. */
async function workerContext() {
  const r = await esbuild.build({
    entryPoints: [join(ROOT, 'src', 'vad-worker.ts')], bundle: true, format: 'iife', platform: 'browser', target: 'es2021',
    write: false, logLevel: 'silent', absWorkingDir: ROOT,
    define: {
      __VAD_ORT_JS__: JSON.stringify(FAKE_ORT),
      __VAD_ORT_MJS__: JSON.stringify(FAKE_MJS),
      __VAD_WASM_B64__: JSON.stringify(FAKE_WASM.toString('base64')),
      __VAD_MODEL_B64__: JSON.stringify(FAKE_MODEL.toString('base64')),
    },
  })
  const blobs = new Map()
  const ctx = {
    replies: [], timeouts: 0, imported: [], __tensors: [], __disposed: [],
    console, atob, TextDecoder, Float32Array, Uint8Array, BigInt, Promise, Math, Error, DataView, ArrayBuffer, Number, isFinite,
    Blob: class { constructor(parts, opts) { this.parts = parts; this.type = opts?.type ?? '' } },
    URL: { createObjectURL: (b) => { const u = 'blob:fake/' + blobs.size; blobs.set(u, b); return u } },
    setTimeout: (fn, ms) => { ctx.timeouts += 1; return setTimeout(fn, ms) },
    importScripts: (...urls) => { for (const u of urls) { ctx.imported.push(u); vm.runInContext(blobs.get(u).parts.join(''), ctx) } },
    postMessage: (msg, opts) => { ctx.replies.push({ msg, transfer: Array.isArray(opts) ? opts : opts?.transfer ?? [] }) },
  }
  ctx.self = ctx
  ctx.blobs = blobs
  vm.createContext(ctx)
  vm.runInContext(r.outputFiles[0].text, ctx)
  assert.equal(typeof ctx.onmessage, 'function', 'the worker installs self.onmessage')
  const ask = async (msg) => {
    const n = ctx.replies.length
    ctx.onmessage({ data: msg })
    for (let i = 0; i < 200 && ctx.replies.length === n; i++) await new Promise((r) => setTimeout(r, 1))
    return ctx.replies[n]
  }
  return { ctx, ask }
}
/** Objects made inside the vm have its prototypes; compare their JSON. */
const plain = (o) => JSON.parse(JSON.stringify(o))

test('worker: warm() loads ort from the carried text, one thread, no proxy, and both wasm pieces as blob: URLs', async () => {
  const { ctx, ask } = await workerContext()
  const created = []
  ctx.__create = async (buf, opts) => { created.push({ buf, opts }); return { run: async () => ({}) } }
  const r = await ask({ id: 7, type: 'warm' })
  assert.deepEqual(plain(r.msg), { id: 7, ok: true })
  assert.equal(ctx.imported.length, 1)
  assert.equal(ctx.blobs.get(ctx.imported[0]).parts.join(''), FAKE_ORT, 'ort.wasm.min.js runs as carried')
  const wasm = ctx.ort.env.wasm
  assert.equal(wasm.numThreads, 1)
  assert.equal(wasm.proxy, false)
  assert.equal(wasm.wasmBinary, undefined, 'never wasmBinary: with a blob: .mjs it hangs warm() (VAD.md §2.3)')
  const mjs = ctx.blobs.get(wasm.wasmPaths.mjs)
  const wasmBlob = ctx.blobs.get(wasm.wasmPaths.wasm)
  assert.equal(mjs.parts.join(''), FAKE_MJS)
  assert.equal(mjs.type, 'text/javascript')
  assert.equal(wasmBlob.type, 'application/wasm')
  assert.deepEqual([...wasmBlob.parts[0]], [...FAKE_WASM])
  assert.equal(created.length, 1)
  assert.deepEqual([...created[0].buf], [...FAKE_MODEL], 'the model bytes, decoded')
  assert.deepEqual(plain(created[0].opts), { executionProviders: ['wasm'] })
  // vad.js:44-45: the session is made once.
  assert.deepEqual(plain((await ask({ id: 8, type: 'warm' })).msg), { id: 8, ok: true })
  assert.equal(created.length, 1)
})

test('worker: a failed warm() answers ok:false, and the next warm() tries again (vad.js:53-56)', async () => {
  const { ctx, ask } = await workerContext()
  let n = 0
  ctx.__create = async () => { n += 1; if (n === 1) throw new Error('model rejected'); return { run: async () => ({}) } }
  assert.deepEqual(plain((await ask({ id: 1, type: 'warm' })).msg), { id: 1, ok: false, error: 'model rejected' })
  assert.deepEqual(plain((await ask({ id: 2, type: 'warm' })).msg), { id: 2, ok: true })
  assert.equal(n, 2)
})

test("worker: probabilities() is vad.js's loop: 64 samples of context, the state carried, old tensors disposed, a yield every 64 frames", async () => {
  const { ctx, ask } = await workerContext()
  const seen = []
  let calls = 0
  ctx.__create = async () => ({
    run: async (feeds) => {
      seen.push(feeds)
      calls += 1
      return { output: new ctx.ort.Tensor('float32', Float32Array.of(calls / 1000), [1, 1]), stateN: new ctx.ort.Tensor('float32', new Float32Array(256), [2, 1, 128]) }
    },
  })
  const frames = 130
  const x = Float32Array.from({ length: 512 * (frames - 1) + 100 }, (_, i) => (i % 997) / 997)
  const before = ctx.timeouts
  const r = await ask({ id: 3, type: 'probabilities', x })
  assert.equal(r.msg.ok, true)
  assert.equal(r.msg.id, 3)
  assert.equal(r.msg.frameSec, 512 / 16000)
  assert.equal(r.msg.probs.length, frames, 'ceil(samples / 512)')
  assert.equal(r.msg.probs[0], Math.fround(0.001))
  assert.equal(r.msg.probs[129], Math.fround(0.13))
  assert.equal(r.transfer.length, 1)
  assert.equal(r.transfer[0], r.msg.probs.buffer, 'the probabilities go back transferred')
  assert.equal(ctx.timeouts - before, 2, 'frames 63 and 127 yield')
  // Frame 0: 64 zeros, then samples 0..511.  Frame 1: samples 448..511, then 512..1023.
  const in0 = seen[0].input.data
  const in1 = seen[1].input.data
  assert.equal(in0.length, 576)
  assert.deepEqual([...seen[0].input.dims], [1, 576])
  assert.ok(in0.slice(0, 64).every((v) => v === 0))
  assert.deepEqual([...in0.slice(64)], [...x.slice(0, 512)])
  assert.deepEqual([...in1.slice(0, 64)], [...x.slice(448, 512)])
  assert.deepEqual([...in1.slice(64)], [...x.slice(512, 1024)])
  // The last frame is zero-padded past the end of the clip.
  const inLast = seen[129].input.data
  assert.deepEqual([...inLast.slice(64, 164)], [...x.slice(512 * 129)])
  assert.ok(inLast.slice(164).every((v) => v === 0))
  // sr is the int64 scalar 16000; the state starts at zeros [2,1,128] and is the previous stateN after.
  assert.equal(seen[0].sr.type, 'int64')
  assert.deepEqual([...seen[0].sr.data], [16000n])
  assert.deepEqual([...seen[0].state.dims], [2, 1, 128])
  assert.ok(seen[0].state.data.every((v) => v === 0))
  assert.equal(seen[1].state.dims.join(), '2,1,128')
  // Every output and every superseded state is disposed: 130 outputs + 130 states.
  assert.equal(ctx.__disposed.length, 260)
})

test('worker: a model that returns no output answers ok:false with vad.js\'s message', async () => {
  const { ctx, ask } = await workerContext()
  ctx.__create = async () => ({ run: async () => ({}) })
  const r = await ask({ id: 4, type: 'probabilities', x: new Float32Array(600) })
  assert.deepEqual(plain(r.msg), { id: 4, ok: false, error: 'model returned no stateN/output' })
})

test("worker: 'bounds' is comart's monoMix + voicedBounds on the posted channels; 'wav' encodes [a, z) of that mix", async () => {
  const { ctx, ask } = await workerContext()
  const buf = stereoBuffer()
  const want = await M.T.localTrimWork().bounds(buf)
  assert.deepEqual(plain((await ask({ id: 1, type: 'wav', a: 0, z: 4 })).msg), { id: 1, ok: false, error: 'no clip' })
  const r = await ask({ id: 2, type: 'bounds', channels: [buf.getChannelData(0), buf.getChannelData(1)], sr: 48000 })
  assert.deepEqual(plain(r.msg), { id: 2, ok: true, length: want.length, bounds: want.bounds })
  const w = await ask({ id: 3, type: 'wav', a: 47000, z: 47003 })
  assert.equal(w.msg.ok, true)
  // The fake Blob keeps its parts: one ArrayBuffer, 44 + 3 * 2 bytes, audio/wav.
  assert.equal(w.msg.blob.type, 'audio/wav')
  const bytes = new Uint8Array(w.msg.blob.parts[0])
  const local = new Uint8Array(await M.T.wavBlob(M.T.monoMix(buf).subarray(47000, 47003), 48000).arrayBuffer())
  assert.deepEqual([...bytes], [...local])
  assert.ok(ctx.replies.every((x) => x.transfer.length === 0 || x.msg.probs), 'nothing but probabilities is transferred')
})

/* ── build-app.mjs: the vendored runtime ───────────────────────────────────── */

// ~/comart/THIRD_PARTY_NOTICES.md, written out: a test must not read another repo.
const PINNED = {
  'vendor/onnxruntime/ort.wasm.min.js': '65e09376df69107e881b5c34d2d37aed333a366b6d941073ec518168e269b87d',
  'vendor/onnxruntime/ort-wasm-simd-threaded.mjs': '30dd851d9c00622940500f71ddd2ff8820c5cb65270816080175b958705385a8',
  'vendor/onnxruntime/ort-wasm-simd-threaded.wasm': '71aef04959c5c1b6de461b6538e2058e306610034a85aad2742d0c7fd4533fe4',
  'vendor/silero/silero_vad_v6.onnx': '1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3',
}
const LICENCES = ['vendor/onnxruntime/LICENSE', 'vendor/silero/LICENSE-silero.txt', 'vendor/silero/LICENSE-vad-web.txt']
const sha = (b) => createHash('sha256').update(b).digest('hex')

test("the vendored runtime is comart's, byte for byte, with its licences beside it", () => {
  for (const [rel, want] of Object.entries(PINNED)) assert.equal(sha(readFileSync(join(ROOT, rel))), want, rel)
  for (const rel of LICENCES) assert.ok(readFileSync(join(ROOT, rel)).length > 500, rel)
  assert.match(readFileSync(join(ROOT, 'vendor/onnxruntime/LICENSE'), 'utf8'), /MIT License[\s\S]*Microsoft/)
  assert.match(readFileSync(join(ROOT, 'vendor/silero/LICENSE-vad-web.txt'), 'utf8'), /ISC/)
})

test('git never rewrites the vendored bytes (.gitattributes)', () => {
  const attrs = readFileSync(join(ROOT, '.gitattributes'), 'utf8')
  assert.match(attrs, /^vendor\/\*\* binary$/m)
})

test("build-app pins the same four hashes it embeds", async () => {
  const B = await import(join(ROOT, 'electron-shell', 'build-app.mjs'))
  assert.deepEqual(Object.fromEntries(Object.values(B.VAD_VENDOR).map((v) => [v.file, v.sha256])), PINNED)
})

test('build-app refuses a vendored file whose hash differs, or that is missing, naming it', async () => {
  const B = await import(join(ROOT, 'electron-shell', 'build-app.mjs'))
  const fake = join(dir, 'root')
  for (const rel of Object.keys(PINNED)) {
    mkdirSync(dirname(join(fake, rel)), { recursive: true })
    copyFileSync(join(ROOT, rel), join(fake, rel))
  }
  assert.equal(Object.keys(B.readVadVendor(fake)).length, 4, 'an exact copy passes')
  const model = join(fake, 'vendor/silero/silero_vad_v6.onnx')
  const bytes = readFileSync(model)
  bytes[1000] ^= 1
  writeFileSync(model, bytes)
  assert.throws(() => B.readVadVendor(fake), (e) => e.reason === 'vendor-hash' && e.file === 'vendor/silero/silero_vad_v6.onnx')
  rmSync(join(fake, 'vendor/onnxruntime/ort-wasm-simd-threaded.mjs'))
  assert.throws(() => B.readVadVendor(fake), (e) => e.reason === 'vendor-missing' && e.file === 'vendor/onnxruntime/ort-wasm-simd-threaded.mjs')
})

test('build-app: the worker bundle carries each runtime file once, and the page bundle carries the bundle once', async () => {
  const B = await import(join(ROOT, 'electron-shell', 'build-app.mjs'))
  const src = await B.buildVadWorker()
  const count = (hay, needle) => hay.split(needle).length - 1
  const wasm64 = readFileSync(join(ROOT, 'vendor/onnxruntime/ort-wasm-simd-threaded.wasm')).toString('base64')
  const model64 = readFileSync(join(ROOT, 'vendor/silero/silero_vad_v6.onnx')).toString('base64')
  assert.equal(count(src, wasm64), 1, 'the wasm, once')
  assert.equal(count(src, model64), 1, 'the model, once')
  assert.equal(count(src, 'ONNX Runtime Web v1.22.0'), 1, 'ort.wasm.min.js, once')
  assert.equal(count(src, 'var ortWasmThreaded'), 1, 'the .mjs, once')
  // The host's one reference to the define: a page bundle holds the payload once.
  const page = await esbuild.build({
    stdin: { contents: 'import { sileroVadWorker } from ' + JSON.stringify(join(ROOT, 'src', 'vad.ts')) + '\n;(globalThis).v = sileroVadWorker\n', resolveDir: ROOT, loader: 'ts' },
    bundle: true, format: 'iife', target: 'chrome142', minify: true, write: false, logLevel: 'silent',
    define: { __CAIRN_VAD_WORKER__: JSON.stringify('PAYLOAD-SENTINEL') },
  })
  assert.equal(count(page.outputFiles[0].text, 'PAYLOAD-SENTINEL'), 1)
})

test('CSS_ORDER ships mic.css straight after explain.css', async () => {
  const B = await import(join(ROOT, 'electron-shell', 'build-app.mjs'))
  assert.equal(B.CSS_ORDER.indexOf('mic.css'), B.CSS_ORDER.indexOf('explain.css') + 1)
  assert.equal(B.CSS_ORDER.at(-1), 'mic.css')
})
