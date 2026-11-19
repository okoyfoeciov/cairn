/**
 * tests/frontend/mic-clip.test.mjs — CONTRACT §0.58 E111's clip player:
 * comart's offscreen.js:280-352 (loadClip, dropClip, playState, playPause,
 * seek, the error mapping) as the frozen MicClip of src/mic-types.ts.
 *
 * The <audio> element is a fake that does what the trim and the card rely on
 * and nothing more: paused / ended / currentTime / duration / error, play()
 * returning a promise, and events.  The object-URL pair and stopWarmSink are
 * injected, so every side effect is counted.
 */

import { strict as assert } from 'node:assert'
import { test, before } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '..', '..')

/** @type {any} */ let C

before(async () => {
  const esbuild = await import(pathToFileURL(join(ROOT, 'node_modules', 'esbuild', 'lib', 'main.js')).href)
  const dir = mkdtempSync(join(tmpdir(), 'cairn-mic-clip-'))
  process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })
  const out = join(dir, 'bundle.mjs')
  await esbuild.build({
    stdin: { contents: 'export * from ' + JSON.stringify(join(ROOT, 'src', 'mic-clip.ts')) + '\n', resolveDir: ROOT, sourcefile: 'mic-clip-test-entry.ts', loader: 'ts' },
    outfile: out, bundle: true, format: 'esm', platform: 'neutral', target: 'es2021', absWorkingDir: ROOT, logLevel: 'silent',
  })
  C = await import(pathToFileURL(out).href)
})

function fakeAudio() {
  const on = new Map()
  const el = {
    tag: 'audio', src: '', preload: '', paused: true, ended: false, currentTime: 0, duration: NaN, error: null,
    plays: 0, pauses: 0, removed: 0, playResult: () => Promise.resolve(),
    addEventListener(type, fn) { if (!on.has(type)) on.set(type, []); on.get(type).push(fn) },
    removeEventListener(type, fn) { const a = on.get(type) ?? []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1) },
    play() { el.plays += 1; el.paused = false; el.ended = false; return el.playResult() },
    pause() { el.pauses += 1; el.paused = true },
    remove() { el.removed += 1; const i = body.children.indexOf(el); if (i >= 0) body.children.splice(i, 1) },
    fire(type) { for (const fn of [...(on.get(type) ?? [])]) fn({ type }) },
  }
  return el
}
const body = { children: [], appendChild(e) { this.children.push(e); return e } }

function make(ms = 8644, opts = {}) {
  const el = fakeAudio()
  const log = { created: [], revoked: [], warmStops: 0 }
  const doc = { body, createElement(tag) { assert.equal(tag, 'audio'); return el } }
  const url = {
    createObjectURL(b) { log.created.push(b); return 'blob:clip/' + log.created.length },
    revokeObjectURL(u) { log.revoked.push(u) },
  }
  const blob = opts.blob ?? new Blob([new Uint8Array(10)], { type: 'audio/wav' })
  const clip = C.createMicClip(blob, ms, { doc, url, stopWarmSink: () => { log.warmStops += 1 } })
  return { clip, el, log, blob }
}
const listen = (clip) => {
  const got = { states: [], failed: [] }
  clip.watch({ state: (s) => got.states.push(s), failed: (m) => got.failed.push(m) })
  return got
}

test('loadClip: one object URL for the blob, on an <audio preload=auto> appended to the body', () => {
  body.children.length = 0
  const { el, log, blob } = make()
  assert.deepEqual(log.created, [blob])
  assert.equal(el.src, 'blob:clip/1')
  assert.equal(el.preload, 'auto')
  assert.deepEqual(body.children, [el])
  assert.equal(el.plays, 0, 'loading does not play; the card asks')
})

test("state(): the recorder's clock until the element knows its duration, then the element's", () => {
  const { clip, el } = make(8644)
  assert.deepEqual(clip.state(), { playing: false, t: 0, dur: 8.644 })
  el.duration = Infinity
  assert.deepEqual(clip.state(), { playing: false, t: 0, dur: 8.644 }, 'a live WebM reports Infinity')
  el.duration = 8.5
  el.currentTime = 9
  assert.deepEqual(clip.state(), { playing: false, t: 8.5, dur: 8.5 }, 't never passes dur')
  el.paused = false
  assert.equal(clip.state().playing, true)
  el.ended = true
  assert.equal(clip.state().playing, false, 'ended is not playing')
})

test('play(): undefined toggles, true plays, false pauses; going to play stops the sink wake', () => {
  const { clip, el, log } = make()
  el.duration = 4
  let s = clip.play(true)
  assert.deepEqual(s, { playing: true, t: 0, dur: 4 })
  assert.equal(el.plays, 1)
  assert.equal(log.warmStops, 1)
  s = clip.play()
  assert.equal(s.playing, false, 'toggle off')
  assert.equal(el.pauses, 1)
  s = clip.play()
  assert.equal(s.playing, true, 'toggle on')
  assert.equal(el.plays, 2)
  assert.equal(log.warmStops, 2)
  s = clip.play(true)
  assert.equal(el.plays, 3, 'true while playing calls play() again, as comart does')
  s = clip.play(false)
  assert.equal(s.playing, false)
  assert.equal(log.warmStops, 3, 'pausing never touches the sink wake')
})

test('play(true) at the end, or within 50 ms of it, restarts from 0', () => {
  const { clip, el } = make()
  el.duration = 4
  el.currentTime = 4
  el.ended = true
  clip.play(true)
  assert.equal(el.currentTime, 0)
  el.pause()
  el.currentTime = 3.96
  clip.play(true)
  assert.equal(el.currentTime, 0)
  el.pause()
  el.currentTime = 3.9
  clip.play(true)
  assert.equal(el.currentTime, 3.9, '100 ms before the end resumes')
})

test("play(): a refused play() promise is swallowed (comart's p.catch)", async () => {
  const { clip, el } = make()
  el.playResult = () => Promise.reject(new Error('NotAllowedError'))
  let unhandled = 0
  const onU = () => { unhandled += 1 }
  process.on('unhandledRejection', onU)
  clip.play(true)
  await new Promise((r) => setImmediate(r))
  process.off('unhandledRejection', onU)
  assert.equal(unhandled, 0)
})

test('seek(): a fraction of the duration, clamped to 0..1; nothing without a length', () => {
  const { clip, el } = make(8000)
  assert.deepEqual(clip.seek(0.25), { playing: false, t: 2, dur: 8 }, 'the clock length serves too')
  el.duration = 4
  assert.equal(clip.seek(0.5).t, 2)
  assert.equal(clip.seek(-3).t, 0)
  assert.equal(clip.seek(7).t, 4)
  assert.equal(clip.seek(Number.NaN).t, 0)
  const none = make(0)
  assert.equal(none.clip.seek(0.5), null, 'no duration, no seek')
  assert.equal(none.el.currentTime, 0)
})

test('watch(): timeupdate, play, pause, ended and loadedmetadata each report the state; a second watch replaces the first', () => {
  const { clip, el } = make(1000)
  const a = listen(clip)
  for (const type of ['timeupdate', 'play', 'pause', 'ended', 'loadedmetadata']) el.fire(type)
  assert.equal(a.states.length, 5)
  assert.deepEqual(a.states[0], { playing: false, t: 0, dur: 1 })
  el.fire('seeking')
  assert.equal(a.states.length, 5, 'other events say nothing')
  const b = listen(clip)
  el.fire('timeupdate')
  assert.equal(a.states.length, 5)
  assert.equal(b.states.length, 1)
})

test("error: comart's two texts; an abort (code 1) says nothing", () => {
  const { clip, el } = make()
  const got = listen(clip)
  el.error = { code: 1 }
  el.fire('error')
  assert.deepEqual(got.failed, [])
  el.error = { code: 4 }
  el.fire('error')
  el.error = { code: 3 }
  el.fire('error')
  el.error = { code: 2 }
  el.fire('error')
  el.error = null
  el.fire('error')
  assert.deepEqual(got.failed, [
    "Couldn't play the recording (unsupported format).",
    "Couldn't play the recording.",
    "Couldn't play the recording.",
    "Couldn't play the recording.",
  ])
})

test('release(): pause, detach, revoke once; idempotent; silent afterwards; play/seek answer null', () => {
  body.children.length = 0
  const { clip, el, log } = make(5000)
  const got = listen(clip)
  el.duration = 5
  clip.play(true)
  clip.release()
  assert.equal(el.pauses, 1)
  assert.equal(el.removed, 1)
  assert.deepEqual(body.children, [])
  assert.deepEqual(log.revoked, ['blob:clip/1'])
  clip.release()
  assert.equal(el.removed, 1)
  assert.deepEqual(log.revoked, ['blob:clip/1'], 'revoked once')
  const n = got.states.length
  for (const type of ['timeupdate', 'pause', 'ended', 'loadedmetadata']) el.fire(type)
  el.error = { code: 4 }
  el.fire('error')
  assert.equal(got.states.length, n, 'no state after release')
  assert.deepEqual(got.failed, [], 'no failure after release')
  assert.equal(clip.play(true), null)
  assert.equal(clip.play(), null)
  assert.equal(clip.seek(0.5), null)
  assert.deepEqual(clip.state(), { playing: false, t: 0, dur: 0 })
  assert.equal(log.warmStops, 1, 'a released clip never touches the sink wake')
})

test('a watch() after release() stays silent', () => {
  const { clip, el } = make()
  clip.release()
  const got = listen(clip)
  el.fire('timeupdate')
  assert.equal(got.states.length, 0)
})
