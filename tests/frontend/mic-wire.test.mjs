/**
 * tests/frontend/mic-wire.test.mjs — CONTRACT §0.58 E111's wire to ai-service
 * (src/mic-wire.ts): one WebSocket attempt to `/api/transcribe/ws`, what its
 * outcome means (voice-typing's classify mapped onto the WS route), and the
 * retry's framing.
 *
 * Every row of the audio design's mapping table (voice-typing signal → WS
 * signal → ours) has a test here, named by its row.  The WebSocket and the
 * clock are fakes: nothing here opens a socket.
 */

import { strict as assert } from 'node:assert'
import { test, before } from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const SRC = join(ROOT, 'src', 'mic-wire.ts')

/** @type {any} */ let M

before(async () => {
  const esbuild = await import(pathToFileURL(join(ROOT, 'node_modules', 'esbuild', 'lib', 'main.js')).href)
  const dir = mkdtempSync(join(tmpdir(), 'cairn-mic-wire-'))
  process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })
  const out = join(dir, 'bundle.mjs')
  await esbuild.build({
    stdin: { contents: 'export * from ' + JSON.stringify(SRC) + '\n', resolveDir: ROOT, sourcefile: 'mic-wire-test-entry.ts', loader: 'ts' },
    outfile: out, bundle: true, format: 'esm', platform: 'neutral',
    target: 'es2021', absWorkingDir: ROOT, logLevel: 'silent',
  })
  M = await import(pathToFileURL(out).href)
})

/* ------------------------------------------------------------------ */
/* fakes                                                               */
/* ------------------------------------------------------------------ */

const flush = () => new Promise((r) => setImmediate(r))

function fakeClock() {
  let t = 0; let id = 0
  const q = new Map()
  return {
    now: () => t,
    pending: () => q.size,
    setTimeout(fn, ms) { const h = ++id; q.set(h, { at: t + ms, fn }); return h },
    clearTimeout(h) { q.delete(h) },
    async advance(ms) {
      const end = t + ms
      for (;;) {
        let next = null
        for (const [h, e] of q) if (e.at <= end && (!next || e.at < next[1].at)) next = [h, e]
        if (!next) break
        q.delete(next[0]); t = next[1].at; next[1].fn(); await flush()
      }
      t = end; await flush()
    },
  }
}

function fakeWsClass() {
  const all = []
  class FakeWS {
    constructor(url) {
      this.url = url; this.readyState = 0; this.binaryType = 'blob'
      this.sent = []; this.closedByClient = null
      this.onopen = null; this.onmessage = null; this.onerror = null; this.onclose = null
      all.push(this)
    }
    send(d) {
      if (this.readyState !== 1) throw new Error('send while not open')
      this.sent.push(typeof d === 'string' ? d : Uint8Array.from(d))
    }
    close(code, reason) { this.closedByClient = { code, reason }; this.readyState = 2 }
    // the server's side
    open() { this.readyState = 1; this.onopen && this.onopen({}) }
    reply(data) { this.onmessage && this.onmessage({ data }) }
    error() { this.onerror && this.onerror({}) }
    closeFromServer(code, reason = '', wasClean = code !== 1006) { this.readyState = 3; this.onclose && this.onclose({ code, reason, wasClean }) }
    get binary() { return this.sent.filter((x) => typeof x !== 'string') }
    get texts() { return this.sent.filter((x) => typeof x === 'string') }
  }
  return { FakeWS, all }
}

function sock(url = 'ws://127.0.0.1:1/api/transcribe/ws?type=x') {
  const clock = fakeClock()
  const { FakeWS, all } = fakeWsClass()
  const s = new M.TakeSocket(url, { WebSocket: FakeWS, connectTimeoutMs: 5000, now: clock.now, timers: clock })
  return { s, ws: all[0], all, clock }
}

const bytes = (...n) => new Uint8Array(n)
const reply = (o) => ({ kind: 'reply', data: typeof o === 'string' ? o : JSON.stringify(o), beforeStop: false, t: 0 })

/** Settled? (a promise that has not settled after a flush is still pending) */
async function settled(p) {
  let v = '__pending__'
  p.then((x) => { v = x })
  await flush()
  return v
}

/* ------------------------------------------------------------------ */
/* constants and the URL                                               */
/* ------------------------------------------------------------------ */

test('the wire type is comart\'s plus voice-typing\'s client tag', () => {
  assert.equal(M.WIRE_TYPE, 'audio/webm;codecs=opus;client=cairn')
  assert.equal(M.DEEPGRAM_EMPTY_ERROR, 'deepgram returned no transcript')
  assert.equal(M.FAILED_PREFIX, 'Transcription failed — ')
})

test('transcribeUrl: http(s) origin → ws(s) /api/transcribe/ws?type=…, and null for a missing or bad base', () => {
  assert.equal(M.transcribeUrl('http://127.0.0.1:4321', M.WIRE_TYPE),
    'ws://127.0.0.1:4321/api/transcribe/ws?type=audio%2Fwebm%3Bcodecs%3Dopus%3Bclient%3Dcairn')
  assert.equal(M.transcribeUrl('http://127.0.0.1:4321/', 'audio/webm'), 'ws://127.0.0.1:4321/api/transcribe/ws?type=audio%2Fwebm')
  assert.equal(M.transcribeUrl('https://[::1]:9', 'audio/webm'), 'wss://[::1]:9/api/transcribe/ws?type=audio%2Fwebm')
  for (const bad of [undefined, null, '', '   ', 42, {}, 'not a url', 'ftp://127.0.0.1:1', 'ws://127.0.0.1:1', 'file:///x', 'javascript:alert(1)']) {
    assert.equal(M.transcribeUrl(bad, 'audio/webm'), null, String(bad))
  }
})

/* ------------------------------------------------------------------ */
/* classifyReply: the rows that are decided by the answer's content    */
/* ------------------------------------------------------------------ */

test('row "200 {text}": text, trimmed, with first/last_word_ms kept; blank → empty', () => {
  assert.deepEqual(M.classifyReply(reply({ text: '  xin chào ', first_word_ms: 120, last_word_ms: 900 })),
    { kind: 'text', text: 'xin chào', first_word_ms: 120, last_word_ms: 900 })
  for (const o of [{ text: '' }, { text: '   ' }, { text: null }, {}]) assert.deepEqual(M.classifyReply(reply(o)), { kind: 'empty', text: '' }, JSON.stringify(o))
  assert.deepEqual(M.classifyReply(reply({ text: '', first_word_ms: 0, last_word_ms: 0 })), { kind: 'empty', text: '', first_word_ms: 0, last_word_ms: 0 })
  // timings that are not finite and >= 0 are dropped, never passed on as undefined
  const r = M.classifyReply(reply({ text: 'a', first_word_ms: -1, last_word_ms: 'x' }))
  assert.deepEqual(r, { kind: 'text', text: 'a' })
  assert.equal('first_word_ms' in r, false)
  assert.deepEqual(M.classifyReply(reply({ text: 'a', first_word_ms: '15', last_word_ms: null })), { kind: 'text', text: 'a', first_word_ms: 15, last_word_ms: 0 })
  assert.deepEqual(M.classifyReply(reply({ error: null, text: 'ok' })), { kind: 'text', text: 'ok' }, 'a null error is no error')
})

test('row "502 deepgram returned no transcript": empty (No speech detected), not a failure', () => {
  assert.deepEqual(M.classifyReply(reply({ error: 'deepgram returned no transcript', detail: 'no final transcript' })), { kind: 'empty', text: '' })
})

test('row "502 family": every provider failure string is retried, with the server text as the message', () => {
  for (const e of ['could not reach AssemblyAI', 'could not stream the recording to AssemblyAI', 'assemblyai returned 500', 'assemblyai returned 429',
    'assemblyai returned unparseable JSON', 'could not reach Deepgram', 'could not stream the recording to Deepgram']) {
    const v = M.classifyReply(reply({ error: e }))
    assert.equal(v.kind, 'retry', e)
    assert.equal(v.message, e)
  }
})

test('row "(WS only) could not reach the transcription service": retried', () => {
  const v = M.classifyReply(reply({ error: 'could not reach the transcription service', detail: 'dial' }))
  assert.deepEqual([v.kind, v.message], ['retry', 'could not reach the transcription service'])
})

test('rows "413 recording too long" and "500 server not configured / internal": final, never retried', () => {
  for (const e of ['recording too long', 'internal', 'server not configured', 'server not configured: neither ASSEMBLYAI_API_KEY nor DEEPGRAM_API_KEY is set',
    'Content-Type must be an audio type.', 'Forbidden.']) {
    const v = M.classifyReply(reply({ error: e }))
    assert.deepEqual([v.kind, v.message], ['fail', e], e)
  }
})

test('an unknown error string is treated as the 502 family (retried once)', () => {
  assert.equal(M.classifyReply(reply({ error: 'something new' })).kind, 'retry')
  assert.equal(M.classifyReply(reply({ error: 12 })).message, '12')
})

test('row "malformed response / non-object 200": not JSON, not an object, or binary → retry, "no answer"', () => {
  for (const d of ['not json', '[1,2]', '"str"', 'null', '7', 'true', '']) {
    assert.deepEqual(pickKM(M.classifyReply({ kind: 'reply', data: d, beforeStop: false, t: 0 })), ['retry', 'no answer'], JSON.stringify(d))
  }
  assert.deepEqual(pickKM(M.classifyReply({ kind: 'reply', data: new ArrayBuffer(3), beforeStop: false, t: 0 })), ['retry', 'no answer'])
})
const pickKM = (v) => [v.kind, v.message]

test('rows "415 → close 1008" and "close 1009": final, with the close reason as the message', () => {
  assert.deepEqual(pickKM(M.classifyReply({ kind: 'closed', code: 1008, reason: 'Content-Type must be an audio type', errorSeen: false, beforeStop: true, t: 0 })),
    ['fail', 'Content-Type must be an audio type'])
  assert.deepEqual(pickKM(M.classifyReply({ kind: 'closed', code: 1009, reason: '', errorSeen: false, beforeStop: true, t: 0 })), ['fail', 'transcription connection closed'])
})

test('rows "refused", "403", "TCP drop", "1011 internal / stream closed": transport failures, retried', () => {
  for (const code of [1006, 1011, 1000, 1001, 0]) {
    const closed = M.classifyReply({ kind: 'closed', code, reason: '', errorSeen: false, beforeStop: true, t: 0 })
    assert.deepEqual(pickKM(closed), ['retry', 'transcription connection closed'], String(code))
    const failed = M.classifyReply({ kind: 'closed', code, reason: '', errorSeen: true, beforeStop: true, t: 0 })
    assert.deepEqual(pickKM(failed), ['retry', 'transcription connection failed'], String(code))
  }
})

test('row "response timeout": retry, "no transcription response"; connect timeout: retry, "transcription connection failed"', () => {
  assert.deepEqual(pickKM(M.classifyReply({ kind: 'timeout', t: 0 })), ['retry', 'no transcription response'])
  assert.deepEqual(pickKM(M.classifyReply({ kind: 'connect-timeout', beforeStop: true, t: 0 })), ['retry', 'transcription connection failed'])
  assert.deepEqual(pickKM(M.classifyReply(null)), ['retry', 'no transcription response'])
  assert.deepEqual(pickKM(M.classifyReply({ kind: 'aborted', t: 0 })), ['fail', 'no answer'])
})

/* ------------------------------------------------------------------ */
/* TakeSocket: the rows that are decided by the socket's life          */
/* ------------------------------------------------------------------ */

test('the socket asks for ArrayBuffers and connects to the URL it was given', () => {
  const { ws } = sock('ws://127.0.0.1:7/api/transcribe/ws?type=a')
  assert.equal(ws.url, 'ws://127.0.0.1:7/api/transcribe/ws?type=a')
  assert.equal(ws.binaryType, 'arraybuffer')
})

test('bytes fed while CONNECTING are queued in order and flushed on open; "stop" waits for the flush', async () => {
  const { s, ws } = sock()
  s.send(bytes(1)); s.send(bytes(2, 3))
  const p = s.finish(30000)
  assert.equal(ws.sent.length, 0, 'nothing before open')
  ws.open()
  assert.deepEqual(ws.sent.map((x) => (typeof x === 'string' ? x : [...x])), [[1], [2, 3], 'stop'])
  ws.reply('{"text":"hi"}')
  const r = await p
  assert.equal(r.kind, 'reply'); assert.equal(r.data, '{"text":"hi"}'); assert.equal(r.beforeStop, false)
  assert.equal(s.sentFrames, 2); assert.equal(s.sentBytes, 3)
})

test('never a zero-length frame, and nothing after "stop"', async () => {
  const { s, ws } = sock()
  ws.open()
  s.send(new Uint8Array(0)); s.send(null); s.send(undefined)
  s.send(bytes(9))
  s.finish(30000)
  s.send(bytes(10))
  assert.deepEqual(ws.sent.map((x) => (typeof x === 'string' ? x : [...x])), [[9], 'stop'])
})

test('row "connect refused": error then close 1006 before open → closed, errorSeen → retry "transcription connection failed"', async () => {
  const { s, ws } = sock()
  s.send(bytes(1))
  ws.error(); ws.closeFromServer(1006)
  const r = await s.finish(30000)
  assert.deepEqual([r.kind, r.code, r.errorSeen, r.beforeStop], ['closed', 1006, true, true])
  assert.equal(ws.sent.length, 0, 'never sent, so never a "stop"')
  assert.deepEqual(pickKM(M.classifyReply(r)), ['retry', 'transcription connection failed'])
})

test('row "403": the refused upgrade looks exactly like a refused connect (retried)', async () => {
  const { s, ws } = sock()
  ws.error(); ws.closeFromServer(1006)
  assert.equal(M.classifyReply(await s.finish(30000)).kind, 'retry')
})

test('an error with no close event still settles, 1 s later, as a failed connection', async () => {
  const { s, ws, clock } = sock()
  const p = s.finish(30000)
  ws.error()
  await clock.advance(999)
  assert.equal(await settled(p), '__pending__')
  await clock.advance(1)
  const r = await p
  assert.deepEqual([r.kind, r.code, r.errorSeen], ['closed', 1006, true])
})

test('row "EPIPE/ECONNRESET mid-body": a drop while recording is remembered, later sends are dropped quietly, finish() reports it without "stop"', async () => {
  const { s, ws } = sock()
  ws.open()
  s.send(bytes(1)); s.send(bytes(2))
  ws.closeFromServer(1006)
  s.send(bytes(3))                         // the take keeps recording; nothing throws
  const r = await s.finish(30000)
  assert.deepEqual([r.kind, r.code, r.errorSeen, r.beforeStop], ['closed', 1006, false, true])
  assert.deepEqual(ws.texts, [], 'no "stop" on a dead socket')
  assert.equal(ws.binary.length, 2)
  assert.deepEqual(pickKM(M.classifyReply(r)), ['retry', 'transcription connection closed'])
})

test('row "early inner answer lost": close 1011 "stream closed" before stop → retried', async () => {
  const { s, ws } = sock()
  ws.open(); s.send(bytes(1))
  ws.closeFromServer(1011, 'stream closed')
  const r = await s.finish(30000)
  assert.deepEqual([r.kind, r.code, r.reason, r.beforeStop], ['closed', 1011, 'stream closed', true])
  assert.equal(M.classifyReply(r).kind, 'retry')
})

test('row "1011 internal": retried', async () => {
  const { s, ws } = sock()
  ws.open()
  const p = s.finish(30000)
  ws.closeFromServer(1011, 'internal')
  const r = await p
  assert.deepEqual([r.kind, r.code, r.beforeStop], ['closed', 1011, false])
  assert.equal(M.classifyReply(r).kind, 'retry')
})

test('row "415": close 1008 at open → final, the reason is the message', async () => {
  const { s, ws } = sock()
  ws.open()
  ws.closeFromServer(1008, 'Content-Type must be an audio type')
  const r = await s.finish(30000)
  assert.deepEqual(pickKM(M.classifyReply(r)), ['fail', 'Content-Type must be an audio type'])
})

test('row "response timeout": nothing 30 s after "stop" → timeout, the client closes; 29.999 s is not enough', async () => {
  const { s, ws, clock } = sock()
  ws.open(); s.send(bytes(1))
  const p = s.finish(30000)
  assert.deepEqual(ws.texts, ['stop'])
  await clock.advance(29999)
  assert.equal(await settled(p), '__pending__')
  assert.equal(ws.closedByClient, null)
  await clock.advance(1)
  const r = await p
  assert.equal(r.kind, 'timeout')
  assert.equal(r.t, 30000, 'settled at the deadline on the injected clock')
  assert.notEqual(ws.closedByClient, null, 'closed by the client')
  assert.deepEqual(pickKM(M.classifyReply(r)), ['retry', 'no transcription response'])
})

test('no timeout while recording: an open socket with no "stop" waits indefinitely', async () => {
  const { s, ws, clock } = sock()
  ws.open(); s.send(bytes(1))
  await clock.advance(10 * 60 * 1000)
  assert.equal(ws.closedByClient, null)
  assert.equal(clock.pending(), 0, 'no timer at all while recording')
  const p = s.finish(30000)
  ws.reply('{"text":"late but fine"}')
  assert.equal((await p).kind, 'reply')
})

test('connect timeout: 5 s without open → connect-timeout, closed', async () => {
  const { s, ws, clock } = sock()
  const p = s.finish(30000)
  await clock.advance(4999)
  assert.equal(await settled(p), '__pending__')
  await clock.advance(1)
  const r = await p
  assert.equal(r.kind, 'connect-timeout')
  assert.notEqual(ws.closedByClient, null)
})

test('an answer that arrives before "stop" settles the attempt, and no "stop" is sent after it', async () => {
  const { s, ws } = sock()
  ws.open(); s.send(bytes(1))
  ws.reply('{"error":"recording too long"}')
  const r = await s.finish(30000)
  assert.deepEqual([r.kind, r.beforeStop], ['reply', true])
  assert.deepEqual(ws.texts, [])
  assert.deepEqual(pickKM(M.classifyReply(r)), ['fail', 'recording too long'])
})

test('the first outcome wins: a close after the answer changes nothing', async () => {
  const { s, ws } = sock()
  ws.open()
  const p = s.finish(30000)
  ws.reply('{"text":"x"}')
  ws.closeFromServer(1006)
  assert.equal((await p).kind, 'reply')
})

test('row "cancel": abort() closes without "stop", clears every timer, and settles nobody', async () => {
  const { s, ws, clock } = sock()
  ws.open(); s.send(bytes(1))
  s.abort()
  assert.notEqual(ws.closedByClient, null)
  assert.deepEqual(ws.texts, [])
  assert.equal(clock.pending(), 0)
  // a connecting socket too
  const b = sock()
  b.s.send(bytes(1)); b.s.abort()
  assert.notEqual(b.ws.closedByClient, null)
  assert.equal(b.clock.pending(), 0)
  b.ws.open()
  assert.deepEqual(b.ws.sent, [], 'an aborted socket never flushes')
})

test('a bad base (no URL) constructs no WebSocket and fails closed as a failed connection', async () => {
  const { s, all } = sock(null)
  assert.equal(all.length, 0, 'nothing was dialled')
  s.send(bytes(1))
  const r = await s.finish(30000)
  assert.deepEqual([r.kind, r.errorSeen], ['closed', true])
  assert.deepEqual(pickKM(M.classifyReply(r)), ['retry', 'transcription connection failed'])
})

test('a WebSocket constructor that throws is a failed connection too', async () => {
  const clock = fakeClock()
  class Throws { constructor() { throw new SyntaxError('bad url') } }
  const s = new M.TakeSocket('ws://x', { WebSocket: Throws, now: clock.now, timers: clock })
  assert.deepEqual(pickKM(M.classifyReply(await s.finish(30000))), ['retry', 'transcription connection failed'])
})

/* ------------------------------------------------------------------ */
/* the retry's framing                                                 */
/* ------------------------------------------------------------------ */

test('row "retry with Content-Length": coalesce keeps every byte in order, frames ≤ 256 KiB, never empty', () => {
  const parts = Array.from({ length: 2000 }, (_, i) => new Uint8Array(966).fill(i & 255))
  const frames = M.coalesce(parts)
  assert.deepEqual(frames.map((f) => f.byteLength), [...Array(7).fill(261786), 99498])
  assert.ok(frames.every((f) => f.byteLength > 0 && f.byteLength <= 256 * 1024))
  assert.deepEqual(Buffer.concat(frames.map((f) => Buffer.from(f))), Buffer.concat(parts.map((p) => Buffer.from(p))))
  assert.deepEqual(M.coalesce([]), [])
  // a part bigger than the cap goes on its own, whole
  const big = M.coalesce([bytes(1), new Uint8Array(10), bytes(2)], 4)
  assert.deepEqual(big.map((f) => f.byteLength), [1, 10, 1])
})

test('the retry attempt: all kept bytes queued at once on a fresh socket, then "stop", under the same deadline', async () => {
  const { s, ws, clock } = sock()
  for (const f of M.coalesce([bytes(1, 2), bytes(3)], 2)) s.send(f)
  const p = s.finish(30000)
  ws.open()
  assert.deepEqual(ws.sent.map((x) => (typeof x === 'string' ? x : [...x])), [[1, 2], [3], 'stop'])
  await clock.advance(30000)
  assert.equal((await p).kind, 'timeout')
})

test('failedLine words a verdict the way comart does', () => {
  assert.equal(M.failedLine('recording too long'), 'Transcription failed — recording too long')
})

test('mic-wire.ts carries no ai-service port literal', () => {
  assert.equal(/8770/.test(readFileSync(SRC, 'utf8')), false)
})
