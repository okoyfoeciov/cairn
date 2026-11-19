/**
 * tests/frontend/mic-ui.test.mjs — CONTRACT §0.58 E111, the book reader's
 * microphone: comart's button and its PLAIN transcript card.
 * Owner: 03.  `node --test tests/frontend/mic-ui.test.mjs`.
 *
 * Driven through the real `mountMic` on `_minidom.mjs` with a FAKE `MicAudio`
 * (src/mic-types.ts): each take's event sink is the test's to call, and each
 * clip records play/seek/watch/release.  No device, no socket, no network.
 *
 * Shims installed HERE (owner 05's `_minidom.mjs` is not ours): `className`
 * backed by the `class` attribute, a `style` bag, `removeEventListener`,
 * `removeAttribute`, `blur`, and `document.body`.  Events go through `fire()`:
 * window capture listeners first, then a bubble walk from the target, then
 * window bubble listeners.
 */

import { test, before, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'
import { installGlobals, AElement, ADocument } from './_minidom.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const SRC = join(ROOT, 'src', 'mic.ts')

/** @type {any} */ let M
const win = {
  listeners: [],
  addEventListener(type, fn, cap) { this.listeners.push({ type, fn, cap: !!cap }) },
  removeEventListener(type, fn, cap) {
    this.listeners = this.listeners.filter((l) => !(l.type === type && l.fn === fn && l.cap === !!cap))
  },
}
let frames = []
/** Every ResizeObserver the mic made. */
const observers = []
const mounted = []

afterEach(() => {
  for (const v of mounted.splice(0)) v.destroy()
  frames = []
  observers.length = 0
  document.body.childNodes = []
})

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cairn-mic-'))
  process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })
  const out = join(dir, 'bundle.mjs')
  await esbuild.build({
    stdin: {
      contents: 'export * as M from ' + JSON.stringify(SRC) + '\n',
      resolveDir: ROOT,
      sourcefile: 'mic-ui-test-entry.ts',
      loader: 'ts',
    },
    outfile: out, bundle: true, format: 'esm', platform: 'neutral',
    mainFields: ['module', 'main'], conditions: ['import', 'default'],
    target: 'es2021', absWorkingDir: ROOT, logLevel: 'silent',
  })
  M = (await import(pathToFileURL(out).href)).M

  installGlobals()
  Object.defineProperty(AElement.prototype, 'className', {
    configurable: true,
    get() { return this.attrs.get('class') ?? '' },
    set(v) {
      const s = String(v)
      if (s) this.attrs.set('class', s)
      else this.attrs.delete('class')
    },
  })
  Object.defineProperty(AElement.prototype, 'style', {
    configurable: true,
    get() { if (!this._style) this._style = {}; return this._style },
  })
  AElement.prototype.removeEventListener = function removeEventListener(type, fn) {
    const list = this.listeners.get(type)
    if (list) this.listeners.set(type, list.filter((x) => x !== fn))
  }
  AElement.prototype.removeAttribute = function removeAttribute(k) { this.attrs.delete(k) }
  AElement.prototype.blur = function blur() {
    if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null
    this.blurred = (this.blurred ?? 0) + 1
  }

  globalThis.document = new ADocument()
  document.body = document.createElement('body')
  globalThis.window = win
  globalThis.requestAnimationFrame = (cb) => { frames.push(cb); return frames.length }
  globalThis.ResizeObserver = class {
    constructor(cb) { this.cb = cb; this.targets = new Set(); this.disconnected = false; observers.push(this) }
    observe(t) { this.targets.add(t) }
    unobserve(t) { this.targets.delete(t) }
    disconnect() { this.targets.clear(); this.disconnected = true }
    trigger() { if (this.targets.size) this.cb([...this.targets].map((target) => ({ target })), this) }
  }
})

/* ── harness ─────────────────────────────────────────────────────────────── */

const settle = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r))
}

function runFrames() {
  const due = frames
  frames = []
  for (const cb of due) cb(0)
}

/** A DOM-ish event, dispatched the way the engine orders listeners. */
function fire(target, type, init = {}) {
  const ev = {
    type, target, isTrusted: true, button: 0, detail: 1, clientX: 0, key: '', repeat: false,
    defaultPrevented: false, stopped: false,
    preventDefault() { this.defaultPrevented = true },
    stopPropagation() { this.stopped = true },
    ...init,
  }
  for (const l of win.listeners.filter((x) => x.type === type && x.cap)) {
    l.fn(ev)
    if (ev.stopped) return ev
  }
  for (let n = target; n && !ev.stopped; n = n.parentNode) n.dispatch?.(type, ev)
  if (!ev.stopped) for (const l of win.listeners.filter((x) => x.type === type && !x.cap)) l.fn(ev)
  return ev
}

/** A fake MicAudio: one take per start(); the test drives each take's sink. */
function fakeAudio() {
  const a = { takes: [], destroyed: 0, throwOnStart: null, onStart: null }
  a.start = (events) => {
    if (a.throwOnStart) throw a.throwOnStart
    const take = {
      events, stops: 0, cancels: 0, stopResult: true,
      stop() { this.stops += 1; return this.stopResult },
      cancel() { this.cancels += 1 },
    }
    a.takes.push(take)
    a.onStart?.(take)
    return take
  }
  a.destroy = () => { a.destroyed += 1 }
  return a
}

/** A fake MicClip: play/seek answer from a scripted state. */
function fakeClip(dur = 8.9) {
  const c = { plays: [], seeks: [], releases: 0, listeners: [], st: { playing: false, t: 0, dur } }
  c.play = (want) => {
    c.plays.push(want)
    if (c.releases) return null
    c.st = { ...c.st, playing: want === undefined ? !c.st.playing : want }
    return { ...c.st }
  }
  c.seek = (frac) => {
    c.seeks.push(frac)
    c.st = { ...c.st, t: frac * c.st.dur }
    return { ...c.st }
  }
  c.state = () => ({ ...c.st })
  c.watch = (l) => { c.listeners.push(l) }
  c.release = () => { c.releases += 1 }
  /** The listener the card registered last. */
  c.l = () => c.listeners.at(-1)
  return c
}

const RECT = { left: 412, top: 40, right: 1200, bottom: 800, width: 788, height: 760 }

function mount(over = {}) {
  const audio = fakeAudio()
  const log = { restoreFocus: 0, copies: [], errors: [] }
  let above = false
  let copyResult = () => Promise.resolve()
  const host = document.createElement('section')
  host.setAttribute('id', 'reader')
  let rect = { ...RECT }
  host.getBoundingClientRect = () => rect
  document.body.append(host)
  const view = M.mountMic(host, {
    restoreFocus: () => { log.restoreFocus += 1 },
    audio,
    copyText: (text) => { log.copies.push(text); return copyResult() },
    layerAbove: () => above,
    onError: (err, ctx) => { log.errors.push([ctx, err]) },
    ...over,
  })
  mounted.push(view)
  // The newest frame: a test may hold two mounts.
  const frame = document.body.children.filter((e) => e.classList.contains('ep-mic-frame')).at(-1)
  const root = frame?.querySelector('.ep-mic')
  const btn = root?.querySelector('.mc-btn')
  return {
    view, audio, log, host, frame, root, btn,
    setAbove: (v) => { above = v },
    setCopy: (fn) => { copyResult = fn },
    setRect: (r) => { rect = { ...rect, ...r } },
    take: () => audio.takes.at(-1),
  }
}

const layers = () => document.body.querySelectorAll('.ep-mic-layer')
const layer = () => layers()[0] ?? null
const part = (sel) => layer()?.querySelector(sel) ?? null
const state = (m) => m.root.getAttribute('data-state')
const status = (m) => ({
  msg: m.root.getAttribute('data-msg'),
  text: m.root.querySelector('.mc-label').textContent,
  error: m.btn.classList.contains('is-error'),
})
const NO_STATUS = { msg: null, text: '', error: false }

/** Click the button: a pointer click unless `init` says otherwise. */
const press = (m, init = {}) => fire(m.btn, 'click', init)

/** idle → arming → recording. */
function recording(m) {
  press(m)
  m.take().events.recording()
  return m.take()
}

/** A take that ends in a card with `text`. */
function withCard(m, text = 'hello world', clip = fakeClip()) {
  const take = recording(m)
  press(m)
  take.events.done({ text, clip })
  return { take, clip }
}

const escape = (init = {}) => fire(document.body, 'keydown', { key: 'Escape', ...init })
const escapeUp = () => fire(document.body, 'keyup', { key: 'Escape' })

/** Every element under `el`, `el` included. */
const all = (el) => [el, ...el.descendants()]
const attrs = (el) => Object.fromEntries(el.attrs)
const tag = (el) => el.tagName.toLowerCase()

/* ── mount and the DOM contract ─────────────────────────────────────────── */

test('mount: one body-level frame holding the button, hidden until a book shows, comart\'s DOM and words', () => {
  const m = mount()
  assert.equal(m.frame.parentNode, document.body, 'the frame is a body child (SPEC-UI §1.1: main.editor clips its descendants)')
  assert.deepEqual(attrs(m.frame), { class: 'ep-mic-frame', hidden: '' })
  const [pin, run] = m.frame.children
  assert.equal(m.frame.children.length, 2)
  assert.deepEqual([attrs(pin), attrs(run)], [{ class: 'mc-pin' }, { class: 'mc-run' }])
  assert.deepEqual(pin.children, [m.root], 'the button rides in the pin')
  assert.equal(run.children.length, 0)
  assert.equal(m.host.querySelectorAll('.ep-mic').length, 0, 'nothing is mounted inside the host')
  assert.equal(tag(m.root), 'section')
  assert.deepEqual(attrs(m.root), { class: 'ep-mic', 'aria-label': 'Voice transcription', 'data-state': 'idle', hidden: '' })
  assert.equal(m.root.children.length, 1)
  assert.equal(m.root.children[0], m.btn)
  assert.equal(tag(m.btn), 'button')
  assert.deepEqual(attrs(m.btn), { type: 'button', class: 'mc-btn', 'aria-label': 'Record' })

  const [mic, stop, dots, label] = m.btn.children
  assert.equal(m.btn.children.length, 4, 'mic, stop, dots, label: comart mic.js:196')
  const STROKE = { fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }
  assert.equal(tag(mic), 'svg')
  assert.deepEqual(attrs(mic), { viewBox: '0 0 24 24', 'aria-hidden': 'true', class: 'mc-ico mc-ico-mic', ...STROKE })
  assert.deepEqual(mic.children.map((p) => [tag(p), attrs(p)]), [
    ['path', { d: 'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z' }],
    ['path', { d: 'M19 10v2a7 7 0 0 1-14 0v-2' }],
    ['path', { d: 'M12 19v3' }],
  ])
  assert.deepEqual(attrs(stop), { viewBox: '0 0 24 24', 'aria-hidden': 'true', class: 'mc-ico mc-ico-stop' })
  assert.deepEqual(stop.children.map((p) => [tag(p), attrs(p)]), [
    ['rect', { x: '7', y: '7', width: '10', height: '10', rx: '2.5', fill: 'currentColor' }],
  ])
  assert.equal(tag(dots), 'span')
  assert.deepEqual(attrs(dots), { class: 'mc-dots', 'aria-hidden': 'true' })
  assert.deepEqual(dots.children.map(tag), ['i', 'i', 'i'])
  assert.equal(tag(label), 'span')
  assert.deepEqual(attrs(label), { class: 'mc-label', 'aria-live': 'polite' })
  assert.equal(label.textContent, '')

  assert.equal(layer(), null, 'no card layer until a card opens')
  for (const el of all(m.root)) assert.equal(el.attrs.has('title'), false, 'no title on any control (comart mic.js:76-83)')
  assert.equal(m.view.cardOpen(), false)
  assert.equal(m.audio.takes.length, 0, 'mounting opens nothing')
})

test('setShown toggles the button and nothing else', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const m = mount()
  m.view.setShown(true)
  assert.equal(m.root.hidden, false)
  const take = recording(m)
  take.events.micFailed('unavailable')
  const before = status(m)
  m.view.setShown(false)
  assert.equal(m.root.hidden, true)
  assert.deepEqual(status(m), before, 'the status survives a hide')
  assert.equal(state(m), 'idle')
  m.view.setShown(true)
  assert.equal(m.root.hidden, false)
  assert.deepEqual(status(m), before)
})

/* ── the take ───────────────────────────────────────────────────────────── */

test('idle click → arming; the red Stop only on recording()', () => {
  const m = mount()
  press(m)
  assert.equal(m.audio.takes.length, 1, 'start() once')
  assert.equal(state(m), 'arming')
  assert.equal(m.btn.getAttribute('aria-label'), 'Starting')
  assert.deepEqual(status(m), NO_STATUS)
  m.take().events.recording()
  assert.equal(state(m), 'recording')
  assert.equal(m.btn.getAttribute('aria-label'), 'Stop recording')
  assert.equal(m.audio.takes.length, 1)
})

test('a click while arming cancels at once and silently', () => {
  const m = mount()
  press(m)
  const take = m.take()
  press(m)
  assert.equal(take.cancels, 1)
  assert.equal(take.stops, 0)
  assert.equal(state(m), 'idle')
  assert.equal(m.btn.getAttribute('aria-label'), 'Record')
  assert.deepEqual(status(m), NO_STATUS)
  take.events.recording()
  assert.equal(state(m), 'idle', 'the cancelled take is no longer heard')
  assert.equal(m.audio.takes.length, 1)
})

test('a click while recording stops; stop() false goes back to idle', () => {
  const m = mount()
  const take = recording(m)
  press(m)
  assert.equal(state(m), 'transcribing')
  assert.equal(m.btn.getAttribute('aria-label'), 'Transcribing')
  assert.equal(take.stops, 1)
  assert.equal(take.cancels, 0)
  take.events.transcribing()
  assert.equal(state(m), 'transcribing', 'transcribing() is idempotent')

  const m2 = mount()
  m2.audio.onStart = (tk) => { tk.stopResult = false }
  const take2 = recording(m2)
  press(m2)
  assert.equal(take2.stops, 1)
  assert.equal(take2.cancels, 1, 'a refused stop drops the take')
  assert.equal(state(m2), 'idle')
  assert.deepEqual(status(m2), NO_STATUS)
})

test('a click while transcribing does nothing', () => {
  const m = mount()
  const take = recording(m)
  press(m)
  press(m)
  press(m, { detail: 0 })
  assert.equal(m.audio.takes.length, 1)
  assert.equal(take.stops, 1)
  assert.equal(take.cancels, 0)
  assert.equal(state(m), 'transcribing')
})

test('start() that throws, or fails before it returns, leaves no take behind', () => {
  const m = mount()
  const boom = new Error('no device')
  m.audio.throwOnStart = boom
  press(m)
  assert.equal(state(m), 'idle')
  assert.deepEqual(status(m), { msg: '1', text: 'Microphone unavailable', error: true })
  assert.deepEqual(m.log.errors, [['mic-start', boom]])

  const m2 = mount()
  m2.audio.onStart = (tk) => tk.events.micFailed('denied')
  press(m2)
  const dead = m2.take()
  assert.equal(state(m2), 'idle')
  assert.deepEqual(status(m2), { msg: '1', text: 'Microphone access denied', error: true })
  m2.view.leave()
  assert.equal(dead.cancels, 0, 'the take that already ended is not kept, so leaving does not cancel it')
  m2.audio.onStart = null
  press(m2)
  assert.equal(dead.cancels, 0)
  assert.equal(m2.audio.takes.length, 2)
  assert.equal(state(m2), 'arming')
})

/* ── the outcomes ───────────────────────────────────────────────────────── */

test('done opens the plain card with the transcript, Copy and a player, and autoplays', () => {
  const m = mount()
  const { take, clip } = withCard(m, 'hello world')
  assert.equal(take.cancels, 0)
  assert.equal(state(m), 'idle')
  assert.deepEqual(status(m), NO_STATUS)
  assert.equal(m.view.cardOpen(), true)
  assert.equal(layers().length, 1)
  const L = layer()
  assert.equal(L.parentNode, m.frame.children[0], 'the card layer rides in the frame\'s pin, over the button\'s root')
  assert.equal(m.frame.children[0].children.at(-1), L)

  const [shield, wrap] = L.children
  assert.equal(L.children.length, 2)
  assert.deepEqual(attrs(L), { class: 'ep-mic-layer' })
  assert.deepEqual(attrs(shield), { class: 'mc-shield' })
  assert.equal(wrap.getAttribute('class'), 'mc-wrap')
  assert.equal(wrap.children.length, 1)
  const card = wrap.children[0]
  assert.equal(tag(card), 'section')
  assert.deepEqual(attrs(card), { class: 'mc-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Transcript' })
  assert.equal(card.children.length, 1)
  const body = card.children[0]
  assert.deepEqual(attrs(body), { class: 'mc-body' })
  const [text, player, actions] = body.children
  assert.equal(body.children.length, 3)
  assert.equal(tag(text), 'p')
  assert.equal(text.getAttribute('class'), 'mc-text')
  assert.equal(text.textContent, 'hello world')

  assert.equal(tag(player), 'div')
  assert.equal(player.hidden, false)
  const [pp, track, time] = player.children
  assert.equal(player.children.length, 3)
  assert.equal(tag(pp), 'button')
  assert.equal(pp.getAttribute('type'), 'button')
  assert.equal(pp.getAttribute('class'), 'mc-pp')
  const [play, pause] = pp.children
  assert.deepEqual(attrs(play), { viewBox: '0 0 24 24', 'aria-hidden': 'true', class: 'mc-ico-pp mc-ico-play' })
  assert.deepEqual(play.children.map((p) => [tag(p), attrs(p)]), [
    ['path', { d: 'M9 7.4v9.2a1 1 0 0 0 1.53.85l7.3-4.6a1 1 0 0 0 0-1.7l-7.3-4.6A1 1 0 0 0 9 7.4z', fill: 'currentColor' }],
  ])
  assert.deepEqual(attrs(pause), { viewBox: '0 0 24 24', 'aria-hidden': 'true', class: 'mc-ico-pp mc-ico-pause' })
  assert.deepEqual(pause.children.map((p) => [tag(p), attrs(p)]), [
    ['rect', { x: '8', y: '6', width: '3.2', height: '12', rx: '1.2', fill: 'currentColor' }],
    ['rect', { x: '12.8', y: '6', width: '3.2', height: '12', rx: '1.2', fill: 'currentColor' }],
  ])
  assert.deepEqual(attrs(track), { class: 'mc-track' })
  assert.deepEqual(track.children.map((c) => c.getAttribute('class')), ['mc-fill'])
  assert.equal(tag(time), 'span')
  assert.equal(time.getAttribute('class'), 'mc-time')

  assert.deepEqual(attrs(actions), { class: 'mc-actions' })
  const copy = actions.children[0]
  assert.equal(actions.children.length, 1, 'Copy only: no CHECK on the plain card')
  assert.deepEqual(attrs(copy), { type: 'button', class: 'mc-copy', 'aria-label': 'Copy' })
  const STROKE = { fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }
  const [cp, ck] = copy.children
  assert.deepEqual(attrs(cp), { viewBox: '0 0 24 24', 'aria-hidden': 'true', class: 'mc-ico-cp', ...STROKE })
  assert.deepEqual(cp.children.map((p) => [tag(p), attrs(p)]), [
    ['rect', { x: '9', y: '9', width: '11', height: '11', rx: '2' }],
    ['path', { d: 'M5 15V6a2 2 0 0 1 2-2h8' }],
  ])
  assert.deepEqual(attrs(ck), { viewBox: '0 0 24 24', 'aria-hidden': 'true', class: 'mc-ico-ck', ...STROKE })
  assert.deepEqual(ck.children.map((p) => [tag(p), attrs(p)]), [['path', { d: 'M20 6 9 17l-5-5' }]])

  for (const el of all(L)) assert.equal(el.attrs.has('title'), false, 'no title anywhere')
  for (const sel of ['.mc-grip', '.cmtm-drag', '.mc-check', '.mc-exp', '.mc-close']) assert.equal(L.querySelector(sel), null)

  assert.deepEqual(clip.plays, [true], 'autoplay: play(true) once')
  assert.equal(clip.listeners.length, 1, 'the card watches its clip')
  assert.equal(player.classList.contains('is-playing'), true, 'painted from play()\'s answer')
  assert.equal(pp.getAttribute('aria-label'), 'Pause')
  assert.equal(time.textContent, '0:00 / 0:08')
  assert.equal(part('.mc-fill').style.width, '0%')
})

test('an empty transcript says "No speech detected", hides Copy, keeps the player', () => {
  const m = mount()
  withCard(m, '')
  assert.equal(part('.mc-text').textContent, 'No speech detected')
  assert.equal(part('.mc-text').classList.contains('is-empty'), true)
  assert.equal(part('.mc-copy').hidden, true)
  assert.equal(part('.mc-player').hidden, false)

  m.view.leave()
  withCard(m, 'words')
  assert.equal(layers().length, 1, 'one card at a time')
  assert.equal(part('.mc-text').classList.contains('is-empty'), false)
  assert.equal(part('.mc-copy').hidden, false)
})

test('failed shows the line verbatim, red, and it stays; empty → "Transcription failed"', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const m = mount()
  let take = recording(m)
  press(m)
  take.events.failed('Transcription failed — recording too long')
  assert.equal(state(m), 'idle')
  assert.deepEqual(status(m), { msg: '1', text: 'Transcription failed — recording too long', error: true })
  t.mock.timers.tick(5000)
  assert.deepEqual(status(m), { msg: '1', text: 'Transcription failed — recording too long', error: true })
  assert.equal(layer(), null)

  take = recording(m)
  assert.deepEqual(status(m), NO_STATUS, 'the next record clears it')
  assert.equal(m.audio.takes.length, 2)
  press(m)
  take.events.failed('')
  assert.deepEqual(status(m), { msg: '1', text: 'Transcription failed', error: true })
})

test('micFailed: denied and unavailable get the UI\'s words, red, persistent, from arming or mid-take', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const m = mount()
  press(m)
  m.take().events.micFailed('denied')
  assert.equal(state(m), 'idle')
  assert.deepEqual(status(m), { msg: '1', text: 'Microphone access denied', error: true })
  t.mock.timers.tick(60_000)
  assert.deepEqual(status(m), { msg: '1', text: 'Microphone access denied', error: true })

  const take = recording(m)
  take.events.micFailed('unavailable')
  assert.equal(state(m), 'idle')
  assert.deepEqual(status(m), { msg: '1', text: 'Microphone unavailable', error: true })
  assert.equal(take.cancels, 0, 'an ending is not cancelled again')
})

test('too short flashes 1800 ms, not red', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const m = mount()
  const take = recording(m)
  press(m)
  take.events.cancelled('short')
  assert.equal(state(m), 'idle')
  assert.deepEqual(status(m), { msg: '1', text: 'Too short — try again', error: false })
  t.mock.timers.tick(1799)
  assert.equal(status(m).text, 'Too short — try again')
  t.mock.timers.tick(1)
  assert.deepEqual(status(m), NO_STATUS)
})

test('the cap is sticky; its click only dismisses; the next click records', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const m = mount()
  const take = recording(m)
  take.events.cancelled('over')
  assert.equal(state(m), 'idle')
  assert.deepEqual(status(m), { msg: '1', text: 'Recording cancelled — over 2 minutes', error: false })
  t.mock.timers.tick(3_600_000)
  assert.equal(status(m).text, 'Recording cancelled — over 2 minutes')
  const focusBefore = m.log.restoreFocus
  press(m, { detail: 0 })
  assert.deepEqual(status(m), NO_STATUS, 'dismissed')
  assert.equal(m.audio.takes.length, 1, 'the dismissing click records nothing')
  assert.equal(state(m), 'idle')
  assert.equal(m.log.restoreFocus, focusBefore + 1, 'comart blur() → restoreFocus, keyboard included')
  press(m)
  assert.equal(m.audio.takes.length, 2)
  assert.equal(state(m), 'arming')
})

test('events of a take that is no longer current are ignored, and a stale done\'s clip is released', () => {
  const m = mount()
  const take = recording(m)
  m.view.leave()
  assert.equal(take.cancels, 1)
  const clip = fakeClip()
  take.events.recording()
  take.events.transcribing()
  take.events.micFailed('denied')
  take.events.failed('Transcription failed — no answer')
  take.events.cancelled('over')
  take.events.done({ text: 'late', clip })
  assert.equal(state(m), 'idle')
  assert.deepEqual(status(m), NO_STATUS)
  assert.equal(layer(), null, 'no card from a stale take')
  assert.equal(clip.releases, 1, 'its clip is released')
  assert.deepEqual(clip.plays, [])

  // A take cancelled while arming, answering after the next one started.
  const m2 = mount()
  press(m2)
  const old = m2.take()
  press(m2)
  press(m2)
  const clip2 = fakeClip()
  old.events.done({ text: 'old', clip: clip2 })
  assert.equal(clip2.releases, 1)
  assert.equal(state(m2), 'arming', 'the current take is untouched')
  assert.equal(layer(), null)
})

/* ── the card ───────────────────────────────────────────────────────────── */

test('the card\'s top is 15% of the host\'s height below its top (comart\'s full card), at its edges and width', () => {
  const m = mount()
  withCard(m)
  const wrap = part('.mc-wrap')
  assert.deepEqual({ ...wrap.style }, { top: '154px', left: '412px', right: 'auto', width: '788px' })

  m.setRect({ left: 300, top: 40, width: 900, height: 701 })
  fire(document.body, 'resize')
  assert.deepEqual({ ...wrap.style }, { top: '145px', left: '300px', right: 'auto', width: '900px' })

  const ro = observers.find((o) => o.targets.has(m.host))
  assert.ok(ro, 'the host is observed while the card is open')
  m.setRect({ left: 250, top: 40, width: 950, height: 760 })
  ro.trigger()
  assert.deepEqual({ ...wrap.style }, { top: '154px', left: '250px', right: 'auto', width: '950px' })

  fire(part('.mc-shield'), 'click')
  assert.equal(ro.targets.has(m.host), false, 'unobserved once the card is gone')
})

test('the entrance class arrives on the next frame, not in the opening task', () => {
  const m = mount()
  withCard(m)
  const card = part('.mc-card')
  assert.equal(card.classList.contains('is-shown'), false)
  runFrames()
  assert.equal(card.classList.contains('is-shown'), true)

  // A frame that lands after the card is gone touches nothing.
  withCard(m)
  const second = part('.mc-card')
  press(m)
  runFrames()
  assert.equal(second.classList.contains('is-shown'), false)
})

test('a trusted shield click closes only the card', () => {
  const m = mount()
  const { clip } = withCard(m)
  const shield = part('.mc-shield')
  fire(shield, 'click', { isTrusted: false })
  assert.equal(m.view.cardOpen(), true, 'untrusted: nothing')
  assert.equal(clip.releases, 0)
  const ev = fire(shield, 'click')
  assert.equal(ev.stopped, false, 'the click is not stopped')
  assert.equal(layer(), null, 'the layer is removed, not hidden')
  assert.equal(m.view.cardOpen(), false)
  assert.equal(clip.releases, 1)
  assert.equal(m.log.restoreFocus, 3, 'two pointer clicks on the button, then the shield')
  assert.equal(state(m), 'idle')
  assert.equal(m.audio.takes.length, 1, 'no take')
})

test('clicks inside the card never close it', () => {
  const m = mount()
  const { clip } = withCard(m)
  for (const sel of ['.mc-text', '.mc-player', '.mc-track', '.mc-fill', '.mc-time', '.mc-pp', '.mc-copy', '.mc-actions', '.mc-body', '.mc-card', '.mc-wrap']) {
    fire(part(sel), 'click')
    assert.equal(m.view.cardOpen(), true, sel)
  }
  fire(layer(), 'click')
  assert.equal(m.view.cardOpen(), true, 'a press released elsewhere aims the click at the layer: nothing')
  assert.equal(clip.releases, 0)
})

test('Esc closes the card first: window capture, trusted, one layer', () => {
  const m = mount()
  const keydowns = win.listeners.filter((l) => l.type === 'keydown')
  assert.equal(keydowns.length, 1)
  assert.equal(keydowns[0].cap, true, 'window capture')

  assert.equal(escape().stopped, false, 'no card: the Esc propagates')
  const { clip } = withCard(m)
  const focus = m.log.restoreFocus
  assert.equal(escape({ isTrusted: false }).stopped, false)
  assert.equal(m.view.cardOpen(), true, 'untrusted: nothing')
  assert.equal(fire(document.body, 'keydown', { key: 'Enter' }).stopped, false)
  assert.equal(m.view.cardOpen(), true)
  assert.equal(escape({ repeat: true }).stopped, false, 'a repeat while the card is open passes (comart)')
  assert.equal(m.view.cardOpen(), true)
  m.setAbove(true)
  assert.equal(escape().stopped, false, 'a modal or menu above takes its own Esc')
  assert.equal(m.view.cardOpen(), true)
  m.setAbove(false)
  const ev = escape()
  assert.equal(ev.stopped, true, '#reader never sees the Esc that closed the card')
  assert.equal(m.view.cardOpen(), false)
  assert.equal(clip.releases, 1)
  assert.equal(m.log.restoreFocus, focus + 1)
  escapeUp()
  assert.equal(escape().stopped, false, 'the next Esc is the reader\'s')
})

test('a held Esc closes one layer: its repeats are swallowed until the key comes up', () => {
  const m = mount()
  withCard(m)
  assert.equal(escape().stopped, true)
  assert.equal(m.view.cardOpen(), false)
  assert.equal(escape({ repeat: true }).stopped, true, 'the repeat of the press that closed the card')
  assert.equal(escape({ repeat: true }).stopped, true)
  assert.equal(fire(document.body, 'keydown', { key: 'a', repeat: true }).stopped, false, 'other keys pass')
  assert.equal(escape({ repeat: true, isTrusted: false }).stopped, false)
  escapeUp()
  assert.equal(escape({ repeat: true }).stopped, false, 'after keyup the hold is over')

  // A keyup that never arrived (focus left the window): the next real press ends the hold.
  withCard(m)
  assert.equal(escape().stopped, true)
  assert.equal(escape().stopped, false, 'a fresh press with no card passes')
  assert.equal(escape({ repeat: true }).stopped, false)

  // An Esc the mic did not use arms nothing.
  m.setAbove(true)
  withCard(m)
  assert.equal(escape().stopped, false)
  assert.equal(escape({ repeat: true }).stopped, false)
})

test('record again while the card is open: the old card ends at record start', () => {
  const m = mount()
  const { clip } = withCard(m, 'first')
  const oldCard = part('.mc-card')
  press(m)
  assert.equal(layer(), null, 'gone at once')
  assert.equal(m.view.cardOpen(), false)
  assert.equal(clip.releases, 1)
  assert.equal(state(m), 'arming')
  assert.equal(m.audio.takes.length, 2)
  const take = m.take()
  take.events.recording()
  press(m)
  const clip2 = fakeClip()
  take.events.done({ text: 'second', clip: clip2 })
  assert.equal(layers().length, 1)
  assert.notEqual(part('.mc-card'), oldCard, 'a fresh card')
  assert.equal(part('.mc-text').textContent, 'second')
  assert.equal(clip2.releases, 0)
})

test('leave() from every state discards silently', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const m = mount()
  /** leave(), asserting it never restores focus: the reader is going away. */
  const leave = () => {
    const f = m.log.restoreFocus
    m.view.leave()
    assert.equal(m.log.restoreFocus, f, 'leave never restores focus')
  }
  press(m, { detail: 0 })
  let take = m.take()
  leave()
  assert.equal(take.cancels, 1)
  assert.equal(state(m), 'idle')
  assert.deepEqual(status(m), NO_STATUS)

  take = recording(m)
  leave()
  assert.equal(take.cancels, 1)
  assert.equal(state(m), 'idle')

  take = recording(m)
  press(m)
  leave()
  assert.equal(take.cancels, 1)
  assert.equal(take.stops, 1)
  assert.equal(state(m), 'idle')
  assert.deepEqual(status(m), NO_STATUS)

  const { take: last, clip } = withCard(m)
  leave()
  assert.equal(layer(), null)
  assert.equal(m.view.cardOpen(), false)
  assert.equal(clip.releases, 1)
  assert.equal(last.cancels, 0, 'a take that already ended is not cancelled again')

  take = recording(m)
  take.events.cancelled('over')
  leave()
  assert.deepEqual(status(m), NO_STATUS, 'the status goes too')
  press(m)
  m.take().events.recording()
  press(m)
  m.take().events.cancelled('short')
  leave()
  assert.deepEqual(status(m), NO_STATUS)
  t.mock.timers.tick(5000)
  assert.deepEqual(status(m), NO_STATUS)
  leave()
  assert.equal(state(m), 'idle', 'idempotent')
})

test('Copy goes through command 23 and shows the check for 1.5 s after it resolved', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const m = mount()
  let resolveCopy
  m.setCopy(() => new Promise((r) => { resolveCopy = r }))
  withCard(m, 'the transcript')
  const copy = part('.mc-copy')
  fire(copy, 'click', { isTrusted: false })
  assert.deepEqual(m.log.copies, [], 'untrusted: nothing')
  fire(copy, 'click')
  assert.deepEqual(m.log.copies, ['the transcript'])
  assert.equal(copy.blurred, 1, 'Copy blurs, as comart\'s does')
  assert.equal(copy.classList.contains('is-copied'), false, 'no check before the copy resolved')
  resolveCopy()
  await settle()
  assert.equal(copy.classList.contains('is-copied'), true)
  assert.equal(copy.getAttribute('aria-label'), 'Copied')
  t.mock.timers.tick(1499)
  assert.equal(copy.classList.contains('is-copied'), true)
  t.mock.timers.tick(1)
  assert.equal(copy.classList.contains('is-copied'), false)
  assert.equal(copy.getAttribute('aria-label'), 'Copy')
  assert.equal(m.view.cardOpen(), true)

  const err = new Error('copy_text refused')
  m.setCopy(() => Promise.reject(err))
  fire(copy, 'click')
  await settle()
  assert.deepEqual(m.log.errors, [['mic-copy', err]])
  assert.equal(copy.classList.contains('is-copied'), false)

  // A copy that resolves after its card closed paints nothing.
  m.setCopy(() => new Promise((r) => { resolveCopy = r }))
  fire(copy, 'click')
  fire(part('.mc-shield'), 'click')
  resolveCopy()
  await settle()
  assert.equal(copy.classList.contains('is-copied'), false)
})

test('the player is a remote', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const m = mount()
  const { clip } = withCard(m, 'x', fakeClip(61))
  const pp = part('.mc-pp')
  fire(pp, 'click', { isTrusted: false })
  assert.deepEqual(clip.plays, [true])
  fire(pp, 'click')
  assert.deepEqual(clip.plays, [true, undefined], 'a toggle')
  assert.equal(part('.mc-player').classList.contains('is-playing'), false, 'painted from the answer')
  assert.equal(pp.getAttribute('aria-label'), 'Play')

  const track = part('.mc-track')
  track.getBoundingClientRect = () => ({ left: 100, top: 0, right: 300, bottom: 6, width: 200, height: 6 })
  fire(track, 'click', { clientX: 150 })
  assert.deepEqual(clip.seeks, [0.25])
  assert.equal(part('.mc-fill').style.width, '25%')
  assert.equal(part('.mc-time').textContent, '0:15 / 1:01')
  fire(track, 'click', { clientX: 150, isTrusted: false })
  track.getBoundingClientRect = () => ({ left: 100, top: 0, right: 100, bottom: 6, width: 0, height: 6 })
  fire(track, 'click', { clientX: 150 })
  assert.deepEqual(clip.seeks, [0.25], 'no width, no seek; untrusted, no seek')

  clip.l().state({ playing: true, t: 30.5, dur: 61 })
  assert.equal(part('.mc-fill').style.width, '50%')
  assert.equal(part('.mc-time').textContent, '0:30 / 1:01')
  assert.equal(part('.mc-player').classList.contains('is-playing'), true)
  assert.equal(pp.getAttribute('aria-label'), 'Pause')
  clip.l().state({ playing: false, t: 99, dur: 61 })
  assert.equal(part('.mc-fill').style.width, '100%', 't is clamped to the duration')
  clip.l().state({ playing: false, t: 3, dur: 0 })
  assert.equal(part('.mc-fill').style.width, '0%')
  assert.equal(part('.mc-time').textContent, '0:00 / 0:00')

  clip.l().failed('Couldn\'t play the recording (unsupported format).')
  assert.deepEqual(status(m), { msg: '1', text: 'Couldn\'t play the recording (unsupported format).', error: true })
  t.mock.timers.tick(1799)
  assert.equal(status(m).error, true)
  t.mock.timers.tick(1)
  assert.deepEqual(status(m), NO_STATUS)
  clip.l().failed('')
  assert.equal(status(m).text, 'Couldn\'t play the recording.')
  assert.equal(m.view.cardOpen(), true, 'a playback failure leaves the card')
})

test('the clock is m:ss', () => {
  const m = mount()
  const { clip } = withCard(m, 'x', fakeClip(200))
  const at = (t) => { clip.l().state({ playing: false, t, dur: 200 }); return part('.mc-time').textContent.split(' / ')[0] }
  assert.deepEqual([0, 8.9, 61, 119.2, -1].map(at), ['0:00', '0:08', '1:01', '1:59', '0:00'])
  assert.equal(part('.mc-time').textContent.split(' / ')[1], '3:20')
})

test('keyboard activation records and stops; untrusted does nothing', () => {
  const m = mount()
  press(m, { isTrusted: false })
  assert.equal(m.audio.takes.length, 0)
  press(m, { detail: 0 })
  assert.equal(state(m), 'arming', 'Enter clicks with detail 0 and is accepted (D11)')
  m.take().events.recording()
  press(m, { isTrusted: false, detail: 0 })
  assert.equal(state(m), 'recording')
  press(m, { detail: 0 })
  assert.equal(state(m), 'transcribing')
  assert.equal(m.take().stops, 1)
})

/** The engine's Enter on a focused <button> (Electron 39.8.3, probed): every
 *  keydown, auto-repeats included, is followed by a trusted click with detail
 *  0 unless that keydown was default-prevented.  Space clicks on keyup only. */
function enter(m, repeat = false) {
  const kd = fire(m.btn, 'keydown', { key: 'Enter', repeat })
  if (!kd.defaultPrevented) press(m, { detail: 0 })
  return kd
}

test('a held Enter is one click: its auto-repeats never reach the button', () => {
  const m = mount()
  enter(m)
  for (let i = 0; i < 6; i++) enter(m, true)
  assert.equal(m.audio.takes.length, 1, 'a held Enter opened the microphone once')
  assert.equal(m.take().cancels, 0, 'no repeat cancelled the take it started')
  assert.equal(state(m), 'arming')

  const take = m.take()
  take.events.recording()
  enter(m)
  assert.equal(take.stops, 1)
  // The floors answer while the key is still down.
  take.events.cancelled('short')
  for (let i = 0; i < 6; i++) enter(m, true)
  assert.equal(m.audio.takes.length, 1, 'the Enter that stopped the take does not start the next')
  assert.equal(state(m), 'idle')

  assert.equal(enter(m).defaultPrevented, false, 'a fresh press is the button\'s')
  assert.equal(m.audio.takes.length, 2)
  assert.equal(fire(m.btn, 'keydown', { key: ' ', repeat: true }).defaultPrevented, false, 'Space is left alone: it clicks on keyup')
})

test('Esc with focus on the button and no card gives focus back to the reader', () => {
  const m = mount()
  const doc = m.btn.ownerDocument
  try {
    // A keyboard take that ended with no card: focus is still on the button.
    doc.activeElement = m.btn
    enter(m)
    const take = m.take()
    take.events.recording()
    let f = m.log.restoreFocus
    assert.equal(escape().stopped, false)
    assert.equal(m.log.restoreFocus, f + 1, 'mid-take: the reader\'s Esc is heard again')
    assert.equal(take.cancels + take.stops, 0, 'the take goes on')
    assert.equal(state(m), 'recording')

    doc.activeElement = m.btn
    enter(m)
    take.events.cancelled('short')
    f = m.log.restoreFocus
    escape({ repeat: true })
    escape({ isTrusted: false })
    m.setAbove(true)
    escape()
    m.setAbove(false)
    assert.equal(m.log.restoreFocus, f, 'a repeat, an untrusted Esc, or one with a modal or menu above: nothing')
    escape()
    assert.equal(m.log.restoreFocus, f + 1, 'after a card-less ending too')

    doc.activeElement = m.host
    escape()
    assert.equal(m.log.restoreFocus, f + 1, 'focus elsewhere: the Esc is not the mic\'s')
  } finally {
    doc.activeElement = null
  }
})

test('a press on the button, the card or the shield never leaves the mic: find\'s outside press does not hear it', () => {
  const m = mount()
  const seen = []
  const spy = (ev) => seen.push(ev.target)
  document.body.addEventListener('pointerdown', spy)
  try {
    const capture = []
    const cap = (ev) => capture.push(ev.target)
    win.addEventListener('pointerdown', cap, true)
    try {
      assert.equal(fire(m.btn, 'pointerdown').stopped, true, 'the button')
      withCard(m)
      for (const sel of ['.mc-shield', '.mc-pp', '.mc-track', '.mc-time', '.mc-text', '.mc-copy', '.mc-card', '.mc-wrap']) {
        assert.equal(fire(part(sel), 'pointerdown').stopped, true, sel)
      }
      assert.equal(fire(layer(), 'pointerdown').stopped, true, 'the layer itself')
      assert.deepEqual(seen, [], 'nothing past the mic\'s roots')
      assert.equal(capture.length, 10, 'capture listeners (the reader\'s, the menu\'s) still see every press')
    } finally {
      win.removeEventListener('pointerdown', cap, true)
    }
    assert.equal(fire(m.host, 'pointerdown').stopped, false, 'a press elsewhere is not the mic\'s')
  } finally {
    document.body.removeEventListener('pointerdown', spy)
  }
})

test('a pointer press never takes focus; a pointer click gives focus back to the reader, a keyboard click keeps it', () => {
  const m = mount()
  const down = fire(m.btn, 'mousedown')
  assert.equal(down.defaultPrevented, true, 'focus stays where it was (probed: :active still applies)')
  press(m)
  assert.equal(m.log.restoreFocus, 1)
  press(m, { detail: 0 })
  assert.equal(m.log.restoreFocus, 1, 'a keyboard click leaves focus on the button, so the next key stops')
  press(m)
  assert.equal(m.log.restoreFocus, 2)
})

test('exactly three window listeners, all removed by destroy()', () => {
  const before = win.listeners.length
  const m = mount()
  const mine = win.listeners.slice(before).map((l) => [l.type, l.cap]).sort()
  assert.deepEqual(mine, [['keydown', true], ['keyup', true], ['resize', false]])
  const { clip } = withCard(m)
  const ro = observers.at(-1)
  const take = recording(m)
  assert.equal(clip.releases, 1)
  m.view.destroy()
  assert.equal(win.listeners.length, before)
  assert.equal(take.cancels, 1, 'the take in flight is discarded')
  assert.equal(m.frame.parentNode, null)
  assert.equal(document.body.children.includes(m.frame), false)
  assert.equal(layer(), null)
  assert.equal(m.audio.destroyed, 1)
  assert.equal(ro.disconnected, true)
  m.view.destroy()
  assert.equal(m.audio.destroyed, 1, 'idempotent')
})

/* ── the frame: the wheel over the mic is the engine's own ───────────────── */

/** An element with a scroll box; `ovy` is its computed overflow-y. */
function box(cls, { ovy = 'visible', top = 0, height = 0, client = 0 } = {}) {
  const el = document.createElement('div')
  el.className = cls
  el._ovy = ovy
  el.scrollTop = top
  el.scrollHeight = height
  el.clientHeight = client
  return el
}

/** What the engine would hit under the pointer, topmost first, and the
 *  computed overflow the mic reads. */
function hitStack(stack) {
  document.elementsFromPoint = () => stack
  win.getComputedStyle = (el) => ({ overflowY: el._ovy ?? 'visible' })
}

const PARK = 100000
const wheel = (target, init = {}) =>
  fire(target, 'wheel', { deltaY: 120, deltaX: 0, deltaMode: 0, clientX: 600, clientY: 300, ctrlKey: false, ...init })
/** The engine moves the frame by `d`, as its wheel animation does, one step. */
const step = (m, d) => { m.frame.scrollTop += d; fire(m.frame, 'scroll') }

test('the frame shows with the button or the card, and is parked in the middle of its run when it shows', () => {
  const m = mount()
  assert.equal(m.frame.hidden, true)
  m.view.setShown(true)
  assert.equal(m.frame.hidden, false)
  assert.equal(m.frame.scrollTop, PARK)
  m.frame.scrollTop = PARK + 300
  m.view.setShown(true)
  assert.equal(m.frame.scrollTop, PARK + 300, 'a frame already showing is not parked again: that would cut the engine\'s animation')
  m.view.setShown(false)
  assert.equal(m.frame.hidden, true)

  m.view.setShown(true)
  withCard(m)
  m.view.setShown(false)
  assert.equal(m.root.hidden, true)
  assert.equal(m.frame.hidden, false, 'the open card keeps the frame')
  escape()
  assert.equal(m.view.cardOpen(), false)
  assert.equal(m.frame.hidden, true, 'nothing left to show')
})

test('a wheel over the shield picks the scroller behind it, and every step of the frame is handed to it', () => {
  const m = mount()
  m.view.setShown(true)
  withCard(m)
  const book = box('ep-scroller', { ovy: 'auto', top: 100, height: 5000, client: 800 })
  const para = box('ep-para')
  hitStack([part('.mc-shield'), para, book, m.host, document.body])

  const ev = wheel(part('.mc-shield'))
  assert.equal(ev.defaultPrevented, false, 'the engine scrolls: the wheel is never cancelled')
  assert.equal(book.scrollTop, 100, 'the wheel itself moves nothing; the frame\'s steps do')
  for (const d of [0.8, 4, 12, 30.4, 40, 24, 8.8]) step(m, d)
  assert.equal(book.scrollTop, 220)
  assert.equal(layer() !== null, true, 'the wheel closed the card')
  step(m, -20)
  assert.equal(book.scrollTop, 200, 'back up, step by step')
  fire(m.frame, 'scroll')
  assert.equal(book.scrollTop, 200, 'a scroll event with no movement moves nothing')
})

test('the target is the first scroller under the pointer, outside the mic, with room that way', () => {
  const m = mount()
  m.view.setShown(true)
  withCard(m)
  const book = box('ep-scroller', { ovy: 'auto', top: 100, height: 5000, client: 800 })
  const half = box('ex-thread-scroll', { ovy: 'auto', top: 0, height: 900, client: 300 })
  const flat = box('ex-band', { ovy: 'hidden', top: 0, height: 900, client: 300 })
  const body = part('.mc-body')
  body._ovy = 'auto'
  body.scrollTop = 0
  body.scrollHeight = 600
  body.clientHeight = 300
  hitStack([body, part('.mc-card'), flat, half, book, document.body])

  wheel(body, { deltaY: 100 })
  step(m, 100)
  assert.equal(body.scrollTop, 0, 'the card text is the engine\'s own: never a target')
  assert.equal(half.scrollTop, 100, 'the band half under the pointer, as without the card')
  assert.equal(book.scrollTop, 100)

  half.scrollTop = 600
  wheel(body, { deltaY: 100 })
  step(m, 100)
  assert.equal(half.scrollTop, 600)
  assert.equal(book.scrollTop, 200, 'a half at its end lets the next scroller have it')

  wheel(body, { deltaY: -100 })
  step(m, -100)
  assert.equal(half.scrollTop, 500, 'up: the half has room again')

  book.scrollTop = 4200
  half.scrollTop = 600
  wheel(body, { deltaY: 100 })
  step(m, 100)
  assert.equal(book.scrollTop, 4200, 'nothing has room: nothing moves')
  assert.equal(half.scrollTop, 600)

  wheel(body, { deltaY: 0, deltaX: 50 })
  half.scrollTop = 0
  step(m, 100)
  assert.equal(half.scrollTop, 0, 'a sideways wheel keeps the target it had (none)')
})

test('the target lasts one wheel motion: when the frame\'s scroll ends, nothing else it does moves the book', () => {
  const m = mount()
  m.view.setShown(true)
  const book = box('ep-scroller', { ovy: 'auto', top: 0, height: 5000, client: 800 })
  hitStack([m.btn, m.root, book, document.body])
  wheel(m.btn, { deltaY: 120 })
  step(m, 120)
  assert.equal(book.scrollTop, 120)
  fire(m.frame, 'scrollend')
  // An arrow key on the focused button, or a drag-select's autoscroll, moves
  // the frame with no wheel: the book stays.
  step(m, 40)
  assert.equal(book.scrollTop, 120, 'a scroll of the frame with no wheel moved the book')
  wheel(m.btn, { deltaY: 120 })
  step(m, 30)
  assert.equal(book.scrollTop, 150, 'the next wheel picks again')
})

test('a wheel over the record button scrolls the book through the frame too', () => {
  const m = mount()
  m.view.setShown(true)
  const book = box('ep-scroller', { ovy: 'auto', top: 0, height: 5000, client: 800 })
  hitStack([m.btn, m.root, book, document.body])
  wheel(m.btn, { deltaY: 120 })
  step(m, 120)
  assert.equal(book.scrollTop, 120)
})

test('parking moves nothing, and a frame far from the middle is parked again when its scroll ends', () => {
  const m = mount()
  m.view.setShown(true)
  const book = box('ep-scroller', { ovy: 'auto', top: 1000, height: 900000, client: 800 })
  hitStack([m.btn, book])
  wheel(m.btn, { deltaY: 120 })
  step(m, PARK / 2 - 10)
  fire(m.frame, 'scrollend')
  assert.equal(m.frame.scrollTop, PARK + PARK / 2 - 10, 'near enough: left where the engine put it')
  wheel(m.btn, { deltaY: 120 })
  step(m, 20)
  const at = book.scrollTop
  fire(m.frame, 'scrollend')
  assert.equal(m.frame.scrollTop, PARK, 'parked again')
  fire(m.frame, 'scroll')
  assert.equal(book.scrollTop, at, 'the park\'s own scroll event moves nothing')
  wheel(m.btn, { deltaY: 120 })
  step(m, 40)
  assert.equal(book.scrollTop, at + 40)
})

/* ── source rules ───────────────────────────────────────────────────────── */

test('source: no innerHTML-family sink, and the UI imports only the frozen types', () => {
  const src = readFileSync(SRC, 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1')
  assert.doesNotMatch(code, /innerHTML|outerHTML|insertAdjacentHTML|setHTMLUnsafe|parseHTMLUnsafe|DOMParser|createContextualFragment|document\.write/)
  const imports = [...code.matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((x) => [x[0].trim(), x[1]])
  assert.deepEqual(imports.map(([, from]) => from), ['./mic-types'], 'no audio module, no icons.ts string')
  assert.match(imports[0][0], /^import type /, 'types only')
  assert.doesNotMatch(code, /\btitle\b\s*=|setAttribute\(\s*['"]title['"]/, 'no title on any control')
})
