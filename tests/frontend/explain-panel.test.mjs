/**
 * tests/frontend/explain-panel.test.mjs — CONTRACT §0.56 E109's explanation band
 * and §0.57 E110's two halves (comart §3h: start or stage, place left/right).
 * Owner: 03.  `node --test tests/frontend/explain-panel.test.mjs`.
 *
 * Driven through the real `mountExplain` on `_minidom.mjs` with a FAKE
 * ai-service: `fetch` answers `/api/explain` with a real `Response` whose
 * body is a `ReadableStream` the test writes SSE bytes into, and parks every
 * `/api/pron` until the test answers it.  Nothing here reaches the network,
 * so nothing is billed.
 *
 * The shims below are installed HERE (owner 05's `_minidom.mjs` is not
 * ours): `className` backed by the `class` attribute, `getAttributeNames`
 * and `cloneNode` (the renderer's badge refresh compares attributes),
 * `replaceChildren`, `removeEventListener`, `removeAttribute`, `blur`,
 * pointer capture and a `style` bag.  minidom has no `inert`: it is a plain
 * property here, read back as the band set it.  Events are dispatched by `fire()`: window capture listeners
 * first, then a bubble walk from the target, then window bubble listeners.
 */

import { test, before, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'
import { installGlobals, AElement, AText, ADocument } from './_minidom.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const SRC = join(ROOT, 'src', 'explain.ts')
const THREAD = join(ROOT, 'src', 'explain-thread.ts')

/** @type {any} */ let E
/** Every `console.info` line the panel printed. */
const infos = []
/** The fake window: only listener bookkeeping. */
const win = {
  listeners: [],
  addEventListener(type, fn, cap) { this.listeners.push({ type, fn, cap: !!cap }) },
  removeEventListener(type, fn, cap) {
    this.listeners = this.listeners.filter((l) => !(l.type === type && l.fn === fn && l.cap === !!cap))
  },
}
/** Frames requested and not yet run. */
let frames = []
/** Every band mounted by a test.  Destroyed after each one, so no window
 *  listener (an armed click swallow) leaks into the next test and no 180 s
 *  deadline outlives the run. */
const mounted = []

afterEach(() => {
  for (const p of mounted.splice(0)) p.destroy()
  frames = []
})

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cairn-exp-'))
  process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })
  const out = join(dir, 'bundle.mjs')
  await esbuild.build({
    stdin: {
      contents: 'export * as E from ' + JSON.stringify(SRC) + '\n',
      resolveDir: ROOT,
      sourcefile: 'explain-panel-test-entry.ts',
      loader: 'ts',
    },
    outfile: out, bundle: true, format: 'esm', platform: 'neutral',
    mainFields: ['module', 'main'], conditions: ['import', 'default'],
    target: 'es2021', absWorkingDir: ROOT, logLevel: 'silent',
  })
  E = (await import(pathToFileURL(out).href)).E

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
  AElement.prototype.getAttributeNames = function getAttributeNames() { return [...this.attrs.keys()] }
  AElement.prototype.cloneNode = function cloneNode(deep) {
    const c = this.ownerDocument.createElement(this.tagName.toLowerCase())
    for (const [k, v] of this.attrs) c.attrs.set(k, v)
    if (deep) for (const k of this.childNodes) c.append(k.cloneNode(true))
    return c
  }
  AText.prototype.cloneNode = function cloneNode() { return this.ownerDocument.createTextNode(this.data) }
  AElement.prototype.replaceChildren = function replaceChildren(...kids) {
    for (const c of this.childNodes) c.parentNode = null
    this.childNodes = []
    this.append(...kids)
  }
  AElement.prototype.removeEventListener = function removeEventListener(type, fn) {
    const list = this.listeners.get(type)
    if (list) this.listeners.set(type, list.filter((x) => x !== fn))
  }
  AElement.prototype.removeAttribute = function removeAttribute(k) { this.attrs.delete(k) }
  AElement.prototype.blur = function blur() {
    if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null
    this.blurred = (this.blurred ?? 0) + 1
  }
  AElement.prototype.setPointerCapture = function setPointerCapture(id) { this.captured = id }
  AElement.prototype.releasePointerCapture = function releasePointerCapture() { this.captured = null }

  globalThis.document = new ADocument()
  globalThis.window = win
  globalThis.requestAnimationFrame = (cb) => { frames.push(cb); return frames.length }
  console.info = (line) => { infos.push(String(line)) }
})

/* ── harness ─────────────────────────────────────────────────────────────── */

/** Let the stream reads, JSON parses and promise chains run. */
const settle = async (n = 12) => {
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
    type, target, isTrusted: true, button: 0, buttons: 1, detail: 1, clientY: 0, pointerId: 1,
    ctrlKey: false, metaKey: false, shiftKey: false, altKey: false,
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

const enc = new TextEncoder()

/** A fake ai-service.  Each `/api/explain` call parks until the test calls
 *  `open()` (200 + SSE body), `reply(status, json)` or `fail()`; aborting
 *  errors the body or rejects the fetch, as the engine does, unless
 *  `ignoreAbort` is set — then the old stream keeps delivering, which is what
 *  a read that resolved just before the abort looks like. */
function fakeService() {
  const explains = []
  const prons = []
  const fetch = (url, init = {}) => {
    url = String(url)
    if (url.includes('/api/pron?')) {
      const u = new URL(url)
      const call = { url, word: u.searchParams.get('word'), pos: u.searchParams.get('pos') }
      prons.push(call)
      return new Promise((resolve, reject) => {
        call.reply = (status, json) => resolve(new Response(JSON.stringify(json), { status }))
        call.fail = () => reject(new TypeError('Failed to fetch'))
      })
    }
    const call = { url, init, body: JSON.parse(init.body), aborted: false, ignoreAbort: false, cancelled: false }
    explains.push(call)
    return new Promise((resolve, reject) => {
      let ctl = null
      init.signal?.addEventListener('abort', () => {
        call.aborted = true
        if (call.ignoreAbort) return
        const err = new DOMException('The operation was aborted.', 'AbortError')
        if (ctl) { try { ctl.error(err) } catch {} } else reject(err)
      })
      call.open = () => {
        const stream = new ReadableStream({
          start(c) { ctl = c },
          cancel() { call.cancelled = true },
        })
        resolve(new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } }))
      }
      call.send = (event, data) => ctl.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
      call.raw = (s) => ctl.enqueue(enc.encode(s))
      call.end = () => { try { ctl.close() } catch {} }
      call.reply = (status, json) =>
        resolve(new Response(json === undefined ? 'oops' : JSON.stringify(json), { status }))
      call.fail = () => reject(new TypeError('Failed to fetch'))
    })
  }
  return { fetch, explains, prons }
}

function fakeAudio(url) {
  const ls = new Map()
  return {
    url, paused: false, played: 0,
    addEventListener(t, f) { if (!ls.has(t)) ls.set(t, []); ls.get(t).push(f) },
    emit(t) { for (const f of ls.get(t) ?? []) f() },
    play() { this.played += 1; return Promise.resolve() },
    pause() { this.paused = true },
  }
}

function mount(opts = {}) {
  const svc = fakeService()
  const host = document.createElement('section')
  host.className = 'ep-reader'
  host.clientHeight = opts.hostH ?? 900
  const log = { shown: 0, closed: 0, placed: 0, saved: [], opened: [], errors: [], audios: [] }
  const panel = E.mountExplain(host, {
    onClosed: () => { log.closed += 1 },
    onShown: () => { log.shown += 1 },
    onPlaced: () => { log.placed += 1 },
    base: 'http://127.0.0.1:8770',
    initialHeight: opts.initialHeight ?? null,
    saveHeight: (h) => { log.saved.push(h) },
    openExternal: async (u) => { log.opened.push(u) },
    onError: (err, ctx) => { log.errors.push([ctx, err]) },
    fetch: svc.fetch,
    audio: (url) => { const a = fakeAudio(url); log.audios.push(a); return a },
  })
  mounted.push(panel)
  const el = panel.element()
  const grip = el.querySelector('.ex-grip')
  // Slot order is document order: [0] is the left (or only) half.
  const slots = el.querySelector('.ex-slots')
  const cols = el.querySelectorAll('.ex-thread')
  const scrolls = el.querySelectorAll('.ex-scroll')
  const contents = el.querySelectorAll('.ex-content')
  const place = el.querySelector('.ex-place')
  const left = el.querySelector('.ex-place-left')
  const right = el.querySelector('.ex-place-right')
  for (const s of scrolls) {
    s.scrollHeight = 0
    s.clientHeight = 300
  }
  return {
    host, panel, el, grip, slots, cols, scrolls, contents, place, left, right,
    scroll: scrolls[0], content: contents[0], svc, log,
  }
}

const REQ = {
  text: 'The Pequod sailed at dawn, and the mate stood watch.',
  items: [{ phrase: 'mate', words: ['mate'] }],
}
const REQ2 = {
  text: 'Ahab paced the quarterdeck all night.',
  items: [{ phrase: 'quarterdeck', words: ['quarterdeck'] }],
}
const REQ3 = {
  text: 'Queequeg sharpened his harpoon.',
  items: [{ phrase: 'harpoon', words: ['harpoon'] }],
}
const ANSWER0 = 'A **mate** is an officer on a ship.'
const ANSWER1 = 'The quarterdeck is the after part of a deck.'
const MP3 = 'https://media.merriam-webster.com/audio/prons/en/us/mp3/m/mate0001.mp3'
const MATE = { hword: 'mate', variants: [{ pos: 'noun', posList: ['noun'], num: '1 of 2', ipa: 'ˈmāt', mp3: MP3 }] }

/** Mount, explain, open the stream: the usual start. */
async function started(opts = {}) {
  const m = mount(opts)
  m.panel.explain(opts.req ?? REQ)
  await settle()
  const call = m.svc.explains.at(-1)
  call.open()
  await settle()
  return { ...m, call }
}

/** Stream `text` (in `parts` pieces) and finish with `done`. */
async function answer(call, text, parts = 1) {
  const n = Math.ceil(text.length / parts)
  for (let i = 0; i < text.length; i += n) call.send('chunk', { text: text.slice(i, i + n) })
  call.send('done', {})
  await settle()
}

/** `inner` matches under `root` that sit inside an `outer` match: minidom
 *  has no descendant combinator. */
const inside = (root, outer, inner) => root.querySelectorAll(inner).filter((e) => e.parentNode?.closest?.(outer))
const blocks = (content) => content.children.filter((c) => c.classList.contains('ex-round-block'))
const errLine = (content) => content.children.find((c) => c.classList.contains('ex-err'))?.textContent ?? null
const words = (root) => root.querySelectorAll('.ex-word')
const wordEl = (root, w) => words(root).find((s) => s.getAttribute('data-word') === w)

/** Press on a word, optionally drag to another, release on the window. */
function drillDown(content, from, to = from) {
  fire(from, 'mousedown')
  if (to !== from) fire(to, 'mousemove')
  fire(content, 'mouseup')
}

/** Stage `req`, click a half, and open the request it sent. */
async function placed(m, req, side) {
  assert.equal(m.panel.explain(req), 'staged')
  fire(side === 'left' ? m.left : m.right, 'click')
  await settle()
  const call = m.svc.explains.at(-1)
  call.open()
  await settle()
  return call
}

/** A split band: ANSWER0 committed on the left, ANSWER1 on the right. */
async function splitBand(opts = {}) {
  const m = await started(opts)
  await answer(m.call, ANSWER0)
  const call1 = await placed(m, REQ2, 'right')
  await answer(call1, ANSWER1)
  return { ...m, call1 }
}

const preview = (m) =>
  m.slots.classList.contains('place-left') ? 'left' : m.slots.classList.contains('place-right') ? 'right' : null
const inert = (m) => m.cols.map((c) => c.inert === true)

/* ── mount and the DOM contract ─────────────────────────────────────────── */

test('mount: the band is appended to the host, hidden, with the §2 DOM (two columns and the overlay) and no request', () => {
  const { host, panel, el, grip, slots, cols, scrolls, contents, place, left, right, svc } = mount()
  assert.equal(host.children.at(-1), el)
  assert.ok(el.classList.contains('ep-explain'))
  assert.equal(el.hidden, true)
  assert.equal(panel.isOpen(), false)
  assert.equal(panel.isStaged(), false)
  assert.equal(el.getAttribute('tabindex'), '-1')
  assert.equal(el.getAttribute('role'), 'region')
  assert.equal(el.getAttribute('aria-label'), 'Explanation')
  assert.deepEqual(el.children, [grip, slots])
  assert.equal(grip.getAttribute('role'), 'separator')
  assert.equal(grip.getAttribute('aria-orientation'), 'horizontal')
  assert.equal(grip.getAttribute('aria-label'), 'Resize explanation panel')
  assert.equal(grip.getAttribute('tabindex'), '0')
  // data-layout lives on the row, never on the band root.
  assert.equal(slots.getAttribute('data-layout'), 'single')
  assert.equal(el.getAttribute('data-layout'), null)
  assert.equal(slots.getAttribute('data-place'), null)
  assert.equal(cols.length, 2)
  assert.deepEqual(slots.children, [cols[0], cols[1], place])
  cols.forEach((col, i) => {
    assert.equal(col.getAttribute('data-slot'), String(i))
    assert.deepEqual(col.children, [scrolls[i]])
    assert.deepEqual(scrolls[i].children, [contents[i]])
    assert.equal(contents[i].childNodes.length, 0)
    assert.equal(col.inert === true, false)
  })
  assert.equal(place.hidden, true)
  assert.deepEqual(place.children, [left, right])
  for (const half of [left, right]) {
    assert.ok(half.classList.contains('ex-place-half'))
    assert.equal(half.getAttribute('role'), 'button')
    assert.equal(half.getAttribute('tabindex'), '0')
    assert.equal(half.childNodes.length, 0, 'no label and no chrome: the tint is the message')
  }
  assert.equal(el.style.height, '320px')
  assert.equal(svc.explains.length + svc.prons.length, 0)
})

test('explain: shows the band, posts the request body, logs the passage, and calls onShown after a frame', async () => {
  const { panel, el, content, svc, log } = mount()
  infos.length = 0
  assert.equal(panel.explain(REQ), 'started', 'a pick on an empty band starts at once')
  assert.equal(panel.isStaged(), false)
  assert.equal(log.placed, 0, 'a start is not a placement')
  assert.equal(el.hidden, false)
  assert.equal(panel.isOpen(), true)
  assert.equal(log.shown, 0, 'onShown waits for layout')
  runFrames()
  assert.equal(log.shown, 1)
  await settle()
  assert.equal(svc.explains.length, 1)
  const call = svc.explains[0]
  assert.equal(call.url, 'http://127.0.0.1:8770/api/explain')
  assert.equal(call.init.method, 'POST')
  assert.equal(call.init.headers['content-type'], 'application/json')
  assert.ok(call.init.signal, 'abortable')
  assert.deepEqual(call.body, { text: REQ.text, items: [{ phrase: 'mate', words: ['mate'] }], history: [] })
  assert.deepEqual(infos, [`[explain] "mate" · ${REQ.text.length} chars · 0 earlier answers\n\n${REQ.text}`])
  // Before the first chunk: the live round (pron-only row, empty answer) and the dots.
  const kids = content.children
  assert.equal(kids.length, 2)
  assert.ok(kids[0].classList.contains('ex-round-block'))
  assert.equal(kids[0].getAttribute('data-round'), '0')
  assert.ok(kids[0].querySelector('.ex-round.ex-live'))
  assert.ok(kids[1].classList.contains('ex-thinking'))
  assert.equal(kids[1].getAttribute('role'), 'status')
})

test('pron-only row: its loading badge asks /api/pron at once, in parallel with the explain request', async () => {
  const { panel, content, svc } = mount()
  panel.explain(REQ)
  await settle()
  const row = content.querySelector('.ex-pron-only-row')
  assert.ok(row)
  assert.equal(row.children[0].tagName, 'STRONG')
  assert.equal(row.children[0].textContent, 'mate', 'the user\'s word, in bold')
  assert.equal(row.querySelector('.pron-badge.loading').getAttribute('data-key'), 'mate|')
  assert.equal(svc.prons.length, 1)
  assert.equal(svc.prons[0].url, 'http://127.0.0.1:8770/api/pron?word=mate&pos=')
  assert.equal(svc.explains.length, 1)
})

/* ── streaming ──────────────────────────────────────────────────────────── */

test('chunks render into the live round; a half-streamed tag never shows; done commits the round', async () => {
  const { content, call } = await started()
  call.send('chunk', { text: '**mate** — a ship' })
  await settle()
  assert.equal(content.querySelector('.ex-thinking'), null, 'the dots go with the first chunk')
  const live = content.querySelector('.ex-round.ex-live')
  assert.ok(live)
  assert.equal(live.textContent, 'mate — a ship')
  assert.equal(live.querySelector('.ex-word'), null, 'a streaming answer has no drill-down words')
  // The tag arrives in two pieces: the opener alone must not print.
  call.send('chunk', { text: "'s officer. [[PRON word=\"mate\" pos=\"no" })
  await settle()
  assert.equal(content.querySelector('.ex-round.ex-live').textContent, "mate — a ship's officer.")
  call.send('chunk', { text: 'un" ipa="ˈmāt"]] The end.' })
  call.send('done', {})
  await settle()
  const done = blocks(content)
  assert.equal(done.length, 1)
  assert.equal(done[0].querySelector('.ex-live'), null)
  assert.ok(done[0].querySelector('.ex-round'))
  assert.equal(inside(done[0], '.ex-round', '.pron-badge').length, 1, 'the closed tag is a badge')
  assert.ok(words(done[0]).length > 0, 'a committed answer is wrapped for drill-down')
  assert.equal(errLine(content), null)
  assert.equal(call.cancelled, true, 'done cancels the reader')
})

test('a chunk only rebuilds the live round: committed rounds keep their nodes', async () => {
  const { content, call, svc } = await started()
  await answer(call, 'First answer about the mate.')
  const first = blocks(content)[0]
  const picked = wordEl(first, 'answer')
  drillDown(content, picked)
  await settle()
  const call2 = svc.explains[1]
  call2.open()
  await settle()
  call2.send('chunk', { text: 'Second ' })
  await settle()
  const live = content.querySelector('.ex-round.ex-live')
  call2.send('chunk', { text: 'answer.' })
  await settle()
  assert.equal(blocks(content)[0], first, 'the committed round is the same node')
  assert.ok(picked.classList.contains('is-marked'), 'its mark survives every chunk')
  assert.equal(content.querySelector('.ex-round.ex-live'), live, 'the live round is refilled, not replaced')
  assert.equal(live.textContent, 'Second answer.')
})

test('stick-to-bottom: follows the stream only when the reader is within 48px of the bottom', async () => {
  const { scroll, call } = await started()
  scroll.scrollHeight = 1000
  scroll.scrollTop = 700           // 1000 - 700 - 300 = 0: at the bottom
  call.send('chunk', { text: 'one ' })
  await settle()
  assert.equal(scroll.scrollTop, 1000)
  scroll.scrollHeight = 1400
  scroll.scrollTop = 100           // reading further up
  call.send('chunk', { text: 'two ' })
  await settle()
  assert.equal(scroll.scrollTop, 100)
  scroll.scrollTop = 1060          // 1400 - 1060 - 300 = 40 < 48
  call.send('chunk', { text: 'three' })
  await settle()
  assert.equal(scroll.scrollTop, 1400)
})

/* ── badges ─────────────────────────────────────────────────────────────── */

test('pron-data fills the row badge and the inline badge with the real Merriam-Webster pron', async () => {
  const { content, call } = await started()
  assert.equal(inside(content, '.ex-pron-only', '.pron-badge.loading').length, 1)
  call.send('pron-data', { prons: { mate: MATE } })
  await settle()
  const row = inside(content, '.ex-pron-only', '.pron-badge')[0]
  assert.ok(row && !row.classList.contains('loading'))
  assert.equal(row.getAttribute('data-mp3'), MP3)
  assert.equal(row.querySelector('.ipa').textContent, 'ˈmāt')
  await answer(call, '**mate** [[PRON word="mate" pos="noun" ipa="ˈmāt"]]: an officer.')
  const inline = inside(content, '.ex-round', '.pron-badge')[0]
  assert.ok(inline)
  assert.equal(inline.classList.contains('loading'), false, 'pron-data bridges to the inline badge')
  assert.equal(inline.getAttribute('data-mp3'), MP3)
})

test('/api/pron: one request per key, 200 upgrades in place, 404 → AI or "no pron", 502 → "pron unavailable"', async () => {
  const { content, call, svc } = await started({
    req: { text: 'p', items: [{ phrase: 'up close', words: ['up', 'close'] }] },
  })
  // The row asks for both picked words.
  assert.deepEqual(svc.prons.map((p) => p.word), ['up', 'close'])
  await answer(call,
    '**tor** [[PRON word="tor" pos="noun" ipa="ˈtȯr"]] and **tor** [[PRON word="tor" pos="noun"]], ' +
    '**zzq** [[PRON word="zzq" pos="verb"]], **mew** [[PRON word="mew" pos="noun" ipa="ˈmyü"]].')
  const tor = svc.prons.filter((p) => p.word === 'tor')
  assert.equal(tor.length, 1, 'the same key is fetched once')
  assert.equal(tor[0].url, 'http://127.0.0.1:8770/api/pron?word=tor&pos=noun')
  // 404 with the model's ipa → the violet AI badge (the second tor has no ipa
  // of its own but inherits the thread's first).
  tor[0].reply(404, { error: 'not_found' })
  await settle()
  const ai = content.querySelectorAll('.pron-badge.ai-made')
  assert.equal(ai.length, 2)
  assert.equal(ai[0].querySelector('.ipa').textContent, 'ˈtȯr')
  // 404 and no ipa anywhere → amber "no pron".
  svc.prons.find((p) => p.word === 'zzq').reply(404, { error: 'not_found' })
  await settle()
  const none = content.querySelector('.pron-badge.failed.err-none')
  assert.ok(none)
  assert.equal(none.querySelector('.err-label').textContent, 'no pron')
  // 502 → red "pron unavailable", even with an ipa to hand.
  svc.prons.find((p) => p.word === 'mew').reply(502, { error: 'mw_unavailable' })
  // A thrown fetch counts as unreachable too.
  svc.prons.find((p) => p.word === 'up').fail()
  // 200 → a real badge, upgraded in place.
  svc.prons.find((p) => p.word === 'close').reply(200, {
    hword: 'close', pos: 'adjective', ipa: 'ˈklōs', mp3: MP3,
    variants: [{ pos: 'adjective', posList: ['adjective'], ipa: 'ˈklōs', mp3: MP3 }],
  })
  await settle()
  const mw = content.querySelectorAll('.pron-badge.failed.err-mw')
  assert.deepEqual(mw.map((b) => b.getAttribute('data-word')).sort(), ['mew', 'up'])
  assert.equal(mw[0].querySelector('.err-label').textContent, 'pron unavailable')
  const closeBadge = inside(content, '.ex-pron-only', '.pron-badge')
    .find((b) => b.getAttribute('data-key')?.startsWith('close|'))
  assert.ok(closeBadge, 'the row badge for "close" is real now')
  assert.equal(closeBadge.getAttribute('data-mp3'), MP3)
  // Every reply above re-rendered; cached failures asked nothing again.
  assert.deepEqual(svc.prons.map((p) => p.word).sort(), ['close', 'mew', 'tor', 'up', 'zzq'])
})

test('a new thread forgets cached failures, so the next pick asks Merriam-Webster again', async () => {
  const { panel, svc, left } = await started()
  svc.prons[0].reply(502, { error: 'mw_unavailable' })
  await settle()
  // A new pick with the band still open, placed over the whole panel: no
  // close in between.
  assert.equal(panel.explain(REQ), 'staged')
  await settle()
  assert.equal(svc.prons.length, 1, 'a staged pick asks nothing')
  fire(left, 'click')
  await settle()
  assert.equal(svc.prons.length, 2, 'the new thread looks the word up again')
  // A lookup that lands after its thread is gone is not cached: the next
  // thread asks for itself.
  panel.close()
  panel.explain(REQ)
  await settle()
  const before = svc.prons.length
  svc.prons.at(-1).reply(502, { error: 'mw_unavailable' })
  panel.close()
  await settle()
  panel.explain(REQ)
  await settle()
  assert.equal(svc.prons.length, before + 1)
})

test("another thread's words never lend their clips to this one", async () => {
  const STATE = { hword: 'state', variants: [{ pos: 'noun', posList: ['noun'], ipa: 'ˈstāt', mp3: MP3 + '?state' }] }
  const { panel, content, call, svc } = await started({ req: { text: 'p', items: [{ phrase: 'state', words: ['state'] }] } })
  call.send('pron-data', { prons: { state: STATE } })
  await answer(call, '**state** [[PRON word="state" pos="noun"]]: a condition.')
  panel.close()
  panel.explain({ text: 'q', items: [{ phrase: 'public statement', words: ['public', 'statement'] }] })
  await settle()
  const row = inside(content, '.ex-pron-only', '.pron-badge')
    .find((b) => b.getAttribute('data-key') === 'statement|')
  assert.ok(row, 'the row has a badge for "statement"')
  assert.equal(row.getAttribute('data-mp3'), null, "never state's clip")
  assert.ok(row.classList.contains('loading'))
  assert.ok(svc.prons.some((p) => p.word === 'statement'), 'statement is looked up for itself')
})

test("a late /api/pron failure never replaces the server's pron-data", async () => {
  const { content, call, svc } = await started()
  call.send('pron-data', { prons: { mate: MATE } })
  await settle()
  svc.prons.find((p) => p.word === 'mate').reply(502, { error: 'mw_unavailable' })
  await settle()
  const rowNow = inside(content, '.ex-pron-only', '.pron-badge')[0]
  assert.equal(rowNow.getAttribute('data-mp3'), MP3)
  await answer(call, '**mate** [[PRON word="mate" pos="noun"]]: an officer.')
  const row = inside(content, '.ex-pron-only', '.pron-badge')[0]
  assert.equal(row.classList.contains('failed'), false, 'still real after the commit')
  assert.equal(row.getAttribute('data-mp3'), MP3)
  assert.equal(inside(content, '.ex-round', '.pron-badge')[0].getAttribute('data-mp3'), MP3)
})

/* ── errors ─────────────────────────────────────────────────────────────── */

test('error lines: unreachable, HTTP status (with ai-service\'s own text), server error event, cut off', async () => {
  {
    const { panel, content, svc } = mount()
    panel.explain(REQ)
    await settle()
    svc.explains[0].fail()
    await settle()
    assert.equal(errLine(content), "Can't reach ai-service. It isn't answering on 127.0.0.1:8770.")
    assert.equal(content.querySelector('.ex-thinking'), null)
    assert.equal(content.querySelector('.ex-live'), null)
  }
  {
    const { panel, content, svc } = mount()
    panel.explain(REQ)
    await settle()
    svc.explains[0].reply(415, { error: 'Content-Type must be application/json.' })
    await settle()
    assert.equal(errLine(content), 'ai-service answered HTTP 415: Content-Type must be application/json.')
  }
  {
    const { panel, content, svc } = mount()
    panel.explain(REQ)
    await settle()
    svc.explains[0].reply(500)
    await settle()
    assert.equal(errLine(content), 'ai-service answered HTTP 500.')
  }
  {
    // An error after chunks: the partial answer is committed, the line under it.
    const { content, call } = await started()
    call.send('chunk', { text: 'Half an answer' })
    call.send('error', { message: 'OpenRouter error (HTTP 500): boom' })
    call.send('done', {})
    await settle()
    assert.equal(blocks(content).length, 1)
    assert.equal(blocks(content)[0].querySelector('.ex-round').textContent, 'Half an answer')
    assert.equal(content.children.at(-1).classList.contains('ex-err'), true)
    assert.equal(errLine(content), 'OpenRouter error (HTTP 500): boom')
  }
  {
    const { content, call } = await started()
    call.send('error', {})
    call.send('done', {})
    await settle()
    assert.equal(errLine(content), 'Something went wrong.')
    assert.equal(blocks(content).length, 0, 'nothing arrived, so no round')
  }
  {
    const { content, call } = await started()
    call.send('chunk', { text: 'Cut ' })
    call.end()
    await settle()
    assert.equal(blocks(content)[0].querySelector('.ex-round').textContent, 'Cut')
    assert.equal(errLine(content), 'The answer was cut off — the backend stopped mid-stream.')
  }
})

test('deadline: a request still running after 180 s is stopped and says so', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const { content, call } = await started()
    call.send('chunk', { text: 'Slow' })
    await settle()
    mock.timers.tick(179_999)
    await settle()
    assert.equal(call.aborted, false)
    mock.timers.tick(1)
    await settle()
    assert.equal(call.aborted, true)
    assert.equal(blocks(content)[0].querySelector('.ex-round').textContent, 'Slow')
    assert.equal(errLine(content), "ai-service didn't finish within 180 s, so the request was stopped.")
  } finally {
    mock.timers.reset()
  }
})

/* ── abort and staleness ────────────────────────────────────────────────── */

test('second, left: both halves reset, the old stream is aborted and never paints into the new thread', async () => {
  const m = await started()
  const { panel, content, call, svc, slots, place, left, log } = m
  call.ignoreAbort = true           // the old body keeps delivering after the abort
  call.send('chunk', { text: 'OLD answer' })
  await settle()
  assert.equal(panel.explain({ text: 'Another passage.', items: [{ phrase: 'passage', words: ['passage'] }] }), 'staged')
  assert.equal(call.aborted, false, 'staging aborts nothing')
  fire(left, 'mouseenter')
  assert.equal(preview(m), 'left')
  assert.equal(call.aborted, false, 'a hover only previews')
  await settle()
  assert.equal(svc.explains.length, 1, 'a hover fetches nothing')
  fire(left, 'click')
  assert.equal(call.aborted, true)
  assert.equal(panel.isStaged(), false)
  assert.equal(place.hidden, true)
  assert.equal(slots.getAttribute('data-layout'), 'single')
  assert.equal(slots.getAttribute('data-place'), null)
  assert.equal(preview(m), null)
  assert.equal(log.placed, 1)
  await settle()
  const fresh = svc.explains[1]
  fresh.open()
  await settle()
  call.send('chunk', { text: ' STALE' })
  call.send('error', { message: 'stale error' })
  call.send('done', {})
  await settle()
  fresh.send('chunk', { text: 'NEW answer' })
  fresh.send('done', {})
  await settle()
  assert.equal(blocks(content).length, 1)
  assert.equal(blocks(content)[0].querySelector('.ex-round').textContent, 'NEW answer')
  for (const c of m.contents) {
    assert.equal(c.textContent.includes('OLD'), false)
    assert.equal(c.textContent.includes('STALE'), false)
  }
  assert.equal(m.contents[1].childNodes.length, 0, 'the right half stays empty')
  assert.equal(errLine(content), null)
  assert.equal(fresh.body.text, 'Another passage.')
  assert.deepEqual(fresh.body.history, [], 'a new pick is a new thread')
})

test('close: aborts, hides, forgets the thread, calls onClosed once; a stale stream stays silent', async () => {
  const { panel, el, content, call, log } = await started()
  call.ignoreAbort = true
  call.send('chunk', { text: 'Some text' })
  await settle()
  panel.close()
  assert.equal(call.aborted, true)
  assert.equal(el.hidden, true)
  assert.equal(panel.isOpen(), false)
  assert.equal(content.childNodes.length, 0)
  assert.equal(log.closed, 1)
  call.send('chunk', { text: ' more' })
  call.end()
  await settle()
  assert.equal(content.childNodes.length, 0, 'nothing paints after close')
  panel.close()
  assert.equal(log.closed, 1, 'close is idempotent and reports only a real close')
  runFrames()
  assert.equal(log.shown, 0, 'a frame queued before the close does not report it shown')
})

test('close before any explain does not call onClosed', () => {
  const { panel, log } = mount()
  panel.close()
  assert.equal(log.closed, 0)
})

/* ── drill-down ─────────────────────────────────────────────────────────── */

test('drill-down: a press on an answer word marks it and streams the next round with the thread passage', async () => {
  const { content, call, svc } = await started()
  const text0 = 'A **mate** is an officer on a ship.'
  await answer(call, text0)
  const officer = wordEl(blocks(content)[0], 'officer')
  assert.ok(officer)
  const down = fire(officer, 'mousedown')
  assert.equal(down.defaultPrevented, true, 'no selection, no focus steal')
  assert.ok(officer.classList.contains('is-marked'))
  fire(content, 'mouseup')
  await settle()
  assert.equal(svc.explains.length, 2)
  assert.deepEqual(svc.explains[1].body, {
    text: REQ.text,
    items: [{ phrase: 'officer', words: ['officer'] }],
    history: [text0],
  })
  // The new round is appended below, divided; the parent's word stays marked.
  const b = blocks(content)
  assert.equal(b.length, 2)
  assert.equal(b[1].getAttribute('data-round'), '1')
  assert.ok(b[1].classList.contains('ex-divided'))
  assert.ok(b[1].querySelector('.ex-live'))
  assert.ok(officer.classList.contains('is-marked'))
  assert.ok(b[1].querySelector('.ex-pron-only-row'), 'the drilled word gets its own row')
})

test('drill-down: a double-click on an answer word asks once; a fresh click asks again', async () => {
  const { content, call, svc } = await started()
  await answer(call, 'A **mate** is an officer on a ship.')
  const officer = wordEl(blocks(content)[0], 'officer')
  fire(officer, 'mousedown', { detail: 1 })
  fire(content, 'mouseup')
  await settle()
  assert.equal(svc.explains.length, 2)
  const second = fire(officer, 'mousedown', { detail: 2 })
  assert.equal(second.defaultPrevented, true, 'a double-click still selects nothing')
  fire(content, 'mouseup')
  await settle()
  assert.equal(svc.explains.length, 2, 'the second press of a double-click is not a new request')
  assert.equal(svc.explains[1].aborted, false)
  // A second press on ANOTHER word is a new gesture, whatever its count.
  fire(wordEl(blocks(content)[0], 'ship'), 'mousedown', { detail: 2 })
  fire(content, 'mouseup')
  await settle()
  assert.equal(svc.explains.length, 3)
  assert.deepEqual(svc.explains[2].body.items, [{ phrase: 'ship', words: ['ship'] }])
  fire(wordEl(blocks(content)[0], 'ship'), 'mousedown', { detail: 1 })
  fire(content, 'mouseup')
  await settle()
  assert.equal(svc.explains.length, 4)
})

test('drill-down: a drag picks a phrase, clamped to 8 words, inside one round block', async () => {
  const { content, call, svc } = await started()
  await answer(call, 'one two three four five six seven eight nine ten eleven twelve')
  const blk = blocks(content)[0]
  drillDown(content, wordEl(blk, 'two'), wordEl(blk, 'twelve'))
  await settle()
  const sent = svc.explains[1].body.items
  assert.deepEqual(sent, [{
    phrase: 'two three four five six seven eight nine',
    words: ['two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'],
  }])
  // Backwards works too, and a modifier press is not a pick.
  const before = svc.explains.length
  fire(wordEl(blk, 'ten'), 'mousedown', { ctrlKey: true })
  fire(content, 'mouseup')
  fire(wordEl(blk, 'ten'), 'mousedown', { isTrusted: false })
  fire(content, 'mouseup')
  fire(wordEl(blk, 'ten'), 'mousedown', { button: 2 })
  fire(content, 'mouseup')
  await settle()
  assert.equal(svc.explains.length, before, 'modifier, untrusted and right presses start nothing')
})

test('drill-down in an earlier round truncates the chain; history carries at most the last 3 answers', async () => {
  const { content, call, svc } = await started()
  await answer(call, 'zero alpha')
  for (let k = 1; k <= 4; k++) {
    const last = blocks(content).at(-1)
    drillDown(content, wordEl(last, k === 1 ? 'alpha' : `w${k - 1}`))
    await settle()
    const c = svc.explains.at(-1)
    c.open()
    await settle()
    await answer(c, `round${k} w${k}`)
  }
  assert.equal(blocks(content).length, 5)
  // Every request replays at most the last three committed answers, oldest first.
  assert.deepEqual(svc.explains.map((c) => c.body.history.length), [0, 1, 2, 3, 3])
  assert.deepEqual(svc.explains[4].body.history, ['round1 w1', 'round2 w2', 'round3 w3'])
  // Back to round 0: everything after it is dropped, then round 1 is regenerated.
  const r0 = blocks(content)[0]
  drillDown(content, wordEl(r0, 'zero'))
  await settle()
  assert.deepEqual(svc.explains.at(-1).body.history, ['zero alpha'])
  const after = blocks(content)
  assert.equal(after.length, 2)
  assert.equal(after[0], r0, 'the kept round keeps its DOM')
  assert.ok(after[1].querySelector('.ex-live'))
  assert.equal(svc.explains.at(-1).body.text, REQ.text, 'still the thread passage')
})

test('drill-down: the release\'s trailing click is swallowed before anything else sees it', async () => {
  const { content, call, el } = await started()
  await answer(call, 'swallow this word')
  let reached = 0
  const outside = (e) => { if (!e.defaultPrevented) reached += 1 }
  win.addEventListener('click', outside, true)
  try {
    drillDown(content, wordEl(blocks(content)[0], 'word'))
    const click = fire(el.parentNode, 'click')
    assert.equal(click.defaultPrevented, true)
    assert.equal(click.stopped, true)
    assert.equal(reached, 0)
    // Only that one click.
    const next = fire(el.parentNode, 'click')
    assert.equal(next.defaultPrevented, false)
    assert.equal(reached, 1)
  } finally {
    win.removeEventListener('click', outside, true)
  }
})

/* ── links and audio ────────────────────────────────────────────────────── */

test('a link in an answer opens through openExternal and never navigates; middle click and drag are refused', async () => {
  const { content, call, log } = await started()
  await answer(call, 'See [the entry](https://www.merriam-webster.com/dictionary/mate) for more.')
  const a = content.querySelector('.ex-link')
  assert.ok(a)
  assert.equal(a.querySelector('.ex-word'), null, 'a link is a citation, not a word')
  const ev = fire(a, 'click')
  assert.equal(ev.defaultPrevented, true)
  await settle()
  assert.deepEqual(log.opened, ['https://www.merriam-webster.com/dictionary/mate'])
  assert.equal(fire(a, 'auxclick', { button: 1 }).defaultPrevented, true)
  assert.equal(fire(a, 'dragstart').defaultPrevented, true)
})

test('audio: a real badge plays, the previous clip stops and loses .is-playing, a late end of the old clip is ignored', async () => {
  const { el, content, call, svc, log } = await started()
  call.send('pron-data', {
    prons: {
      mate: MATE,
      ship: { hword: 'ship', variants: [{ pos: 'noun', posList: ['noun'], ipa: 'ˈship', mp3: MP3 + '?ship' }] },
    },
  })
  await answer(call, 'a [[PRON word="mate" pos="noun"]] and a [[PRON word="ship" pos="noun"]]')
  const [b1, b2] = inside(content, '.ex-round', '.pron-badge')
  assert.ok(b1 && b2)
  const c1 = fire(b1, 'click', { detail: 1 })
  assert.equal(c1.defaultPrevented, false)
  assert.equal(log.audios.length, 1)
  assert.equal(log.audios[0].url, MP3)
  assert.equal(log.audios[0].played, 1)
  assert.ok(b1.classList.contains('is-playing'))
  assert.equal(document.activeElement, el, 'a mouse click leaves focus on the band, where Esc still works')
  document.activeElement = b2
  fire(b2, 'click', { detail: 0 })
  assert.equal(log.audios[0].paused, true)
  assert.equal(b1.classList.contains('is-playing'), false)
  assert.ok(b2.classList.contains('is-playing'))
  assert.equal(document.activeElement, b2, 'a keyboard click keeps focus')
  // The superseded clip ends late: it must not clear the new one, nor forget
  // that the new one is the clip to stop next.
  log.audios[0].emit('ended')
  assert.ok(b2.classList.contains('is-playing'), 'the superseded clip cannot clear the new one')
  fire(b1, 'click')
  assert.equal(log.audios[1].paused, true, 'the playing clip is still the one stopped')
  assert.equal(b2.classList.contains('is-playing'), false)
  assert.ok(b1.classList.contains('is-playing'))
  log.audios[1].emit('error')
  assert.ok(b1.classList.contains('is-playing'))
  log.audios[2].emit('ended')
  assert.equal(b1.classList.contains('is-playing'), false)
  // A full re-render (a pron lookup landing) never rebuilds a real badge,
  // which would drop .is-playing mid-clip.
  fire(b1, 'click')
  svc.prons[0].reply(200, MATE)
  await settle()
  assert.ok(content.contains(b1), 'the same node')
  assert.ok(b1.classList.contains('is-playing'))
})

test('audio: loading, failed and AI badges play nothing', async () => {
  const { content, call, svc, log } = await started()
  await answer(call, 'x [[PRON word="tor" pos="noun" ipa="ˈtȯr"]] y')
  const loading = inside(content, '.ex-round', '.pron-badge.loading')[0]
  fire(loading, 'click')
  svc.prons.find((p) => p.word === 'tor').reply(404, { error: 'not_found' })
  svc.prons.find((p) => p.word === 'mate').reply(502, { error: 'mw_unavailable' })
  await settle()
  fire(content.querySelector('.pron-badge.ai-made'), 'click')
  fire(content.querySelector('.pron-badge.failed'), 'click')
  assert.equal(log.audios.length, 0)
})

/* ── height ─────────────────────────────────────────────────────────────── */

test('height: default 320, the persisted height, clamped to [140, host − 24]; relayout re-derives from the choice', () => {
  assert.equal(mount().el.style.height, '320px')
  assert.equal(mount({ initialHeight: 500 }).el.style.height, '500px')
  assert.equal(mount({ initialHeight: 60 }).el.style.height, '140px')
  assert.equal(mount({ initialHeight: 700, hostH: 600 }).el.style.height, '576px')
  const m = mount({ initialHeight: 700, hostH: 1000 })
  assert.equal(m.el.style.height, '700px')
  m.host.clientHeight = 600
  m.panel.relayout()
  assert.equal(m.el.style.height, '576px')
  // The window grows back: the chosen 700 returns, the clamp never overwrote it.
  m.host.clientHeight = 1000
  m.panel.relayout()
  assert.equal(m.el.style.height, '700px')
  m.host.clientHeight = 100
  m.panel.relayout()
  assert.equal(m.el.style.height, '140px', 'never below the floor')
  assert.deepEqual(m.log.saved, [], 'a relayout is not the user\'s choice')
})

test('height: the grip drags with pointer capture and saves once on release', () => {
  const { el, grip, panel, host, log } = mount()
  panel.explain(REQ)
  runFrames()
  const shown = log.shown
  const down = fire(grip, 'pointerdown', { clientY: 500, pointerId: 7 })
  assert.equal(down.defaultPrevented, true)
  assert.equal(grip.captured, 7)
  assert.ok(grip.classList.contains('is-active'))
  fire(grip, 'pointermove', { clientY: 400 })
  assert.equal(el.style.height, '420px', 'up is taller')
  fire(grip, 'pointermove', { clientY: -1000 })
  assert.equal(el.style.height, '876px', 'clamped to host − 24')
  fire(grip, 'pointermove', { clientY: 650 })
  assert.equal(el.style.height, '170px')
  assert.deepEqual(log.saved, [], 'not per frame')
  runFrames()
  assert.equal(log.shown, shown + 1, 'onShown after the new height, once a frame')
  fire(grip, 'pointerup', { clientY: 650, pointerId: 7 })
  assert.deepEqual(log.saved, [170])
  assert.equal(grip.captured, null)
  assert.equal(grip.classList.contains('is-active'), false)
  fire(grip, 'pointermove', { clientY: 100 })
  assert.equal(el.style.height, '170px', 'no drag after release')
  fire(grip, 'pointerdown', { button: 2, clientY: 100 })
  fire(grip, 'pointermove', { clientY: 50 })
  assert.equal(el.style.height, '170px', 'only the primary button drags')
  // The dragged height is the new choice: a relayout keeps it.
  host.clientHeight = 950
  panel.relayout()
  assert.equal(el.style.height, '170px')
})

test('height: ArrowUp/ArrowDown on the grip move it by 24 and save', () => {
  const { el, grip, log } = mount()
  assert.equal(fire(grip, 'keydown', { key: 'ArrowUp' }).defaultPrevented, true)
  assert.equal(el.style.height, '344px')
  fire(grip, 'keydown', { key: 'ArrowDown' })
  fire(grip, 'keydown', { key: 'ArrowDown' })
  assert.equal(el.style.height, '296px')
  assert.deepEqual(log.saved, [344, 320, 296])
  assert.equal(fire(grip, 'keydown', { key: 'Enter' }).defaultPrevented, false)
})

test('height: a click on the grip, or a key the clamp swallows, is no new choice', () => {
  const { el, grip, panel, host, log } = mount({ initialHeight: 600, hostH: 400 })
  panel.explain(REQ)
  runFrames()
  assert.equal(el.style.height, '376px')
  fire(grip, 'pointerdown', { clientY: 30, pointerId: 3 })
  fire(grip, 'pointerup', { clientY: 30, pointerId: 3 })
  assert.deepEqual(log.saved, [], 'a click that moved nothing saves nothing')
  fire(grip, 'keydown', { key: 'ArrowUp' })
  assert.equal(el.style.height, '376px')
  assert.deepEqual(log.saved, [], 'ArrowUp at the clamp saves nothing')
  host.clientHeight = 1000
  panel.relayout()
  assert.equal(el.style.height, '600px', 'the choice made in a tall window survives a short one')
})

/* ── E110: start or stage ───────────────────────────────────────────────── */

test('a pick while a half holds anything is STAGED: nothing is fetched or aborted, and the overlay waits unseen', async () => {
  const m = await started()
  m.call.send('chunk', { text: 'Still streaming' })
  await settle()
  infos.length = 0
  const asked = m.svc.explains.length + m.svc.prons.length
  assert.equal(m.panel.explain(REQ2), 'staged')
  await settle()
  assert.equal(m.panel.isStaged(), true)
  assert.equal(m.svc.explains.length + m.svc.prons.length, asked, 'a staged pick costs nothing')
  assert.equal(m.call.aborted, false, 'the answer on screen keeps streaming')
  assert.deepEqual(infos, [], 'nothing went out, so nothing is logged')
  assert.equal(m.place.hidden, false)
  assert.equal(m.slots.getAttribute('data-place'), 'second')
  assert.equal(m.slots.getAttribute('data-layout'), 'single')
  assert.equal(m.left.getAttribute('aria-label'), 'Replace the whole panel with the new explanation')
  assert.equal(m.right.getAttribute('aria-label'), 'Split the panel and put the new explanation on the right')
  assert.equal(preview(m), null, 'invisible until a half is hovered or focused')
  assert.equal(m.log.placed, 0)
  assert.equal(m.log.closed, 0)
  // The stream underneath still renders while it waits.
  m.call.send('chunk', { text: ' on.' })
  await settle()
  assert.equal(m.content.querySelector('.ex-round.ex-live').textContent, 'Still streaming on.')
})

test('start or stage: a waiting stream and an error line are content; an open band that holds nothing starts afresh', async () => {
  {
    // Before the first chunk: the dots are content.
    const m = await started()
    assert.equal(m.panel.explain(REQ2), 'staged')
  }
  {
    // ai-service down: the error line is content (comart threadHasContent).
    const m = mount()
    m.panel.explain(REQ)
    await settle()
    m.svc.explains[0].fail()
    await settle()
    assert.ok(errLine(m.content))
    assert.equal(m.panel.explain(REQ2), 'staged')
    await settle()
    assert.equal(m.svc.explains.length, 1)
  }
  {
    // `done` with no chunk: the band is open and blank, and the next pick
    // is a first pick, not a stage over nothing (critic C8).
    const m = await started()
    m.call.send('done', {})
    await settle()
    assert.equal(m.panel.isOpen(), true)
    assert.equal(m.content.childNodes.length, 0)
    assert.equal(m.panel.explain(REQ2), 'started')
    assert.equal(m.panel.isStaged(), false)
    assert.equal(m.place.hidden, true)
    await settle()
    assert.equal(m.svc.explains.length, 2)
    assert.deepEqual(m.svc.explains[1].body, { text: REQ2.text, items: REQ2.items, history: [] })
    assert.equal(m.log.placed, 0)
  }
})

test('the newest staged pick wins; the one it replaced never costs a request', async () => {
  const m = await started()
  await answer(m.call, ANSWER0)
  assert.equal(m.panel.explain({ text: 'stale passage', items: [{ phrase: 'stale', words: ['stale'] }] }), 'staged')
  fire(m.right, 'mouseenter')
  assert.equal(preview(m), 'right')
  // A book drag released over the band re-stages under a still pointer: the
  // half under it gets no new mouseenter, so the preview must survive.
  assert.equal(m.panel.explain(REQ2), 'staged')
  assert.equal(preview(m), 'right', 'a newer pick keeps the preview')
  // ...and the pointer's half: a keyboard focus that comes and goes hands
  // the preview back to it.
  fire(m.left, 'focus')
  assert.equal(preview(m), 'left')
  fire(m.left, 'blur')
  assert.equal(preview(m), 'right', 'the pointer still rests on the right half')
  assert.equal(m.place.hidden, false)
  assert.equal(m.slots.getAttribute('data-place'), 'second')
  assert.deepEqual(inert(m), [true, true])
  fire(m.place, 'mouseleave')
  fire(m.left, 'mouseenter')
  await settle()
  assert.equal(m.svc.explains.length, 1)
  fire(m.left, 'click')
  await settle()
  assert.equal(m.svc.explains.length, 2)
  assert.deepEqual(m.svc.explains[1].body, { text: REQ2.text, items: REQ2.items, history: [] })
  assert.equal(m.log.placed, 1)
})

/* ── E110: hover, focus and commit ──────────────────────────────────────── */

test('hover and focus preview a half, leaving clears it, and nothing is fetched until a commit', async () => {
  const m = await started()
  await answer(m.call, ANSWER0)
  fire(m.left, 'mouseenter')
  assert.equal(preview(m), null, 'no stage, no preview')
  m.panel.explain(REQ2)
  fire(m.left, 'mouseenter')
  assert.equal(preview(m), 'left')
  fire(m.right, 'mouseenter')
  assert.equal(preview(m), 'right')
  assert.equal(m.slots.getAttribute('data-layout'), 'single', 'a preview, not a split')
  assert.equal(m.contents[1].childNodes.length, 0, 'the right half previews empty')
  fire(m.place, 'mouseleave')
  assert.equal(preview(m), null)
  // Keyboard: focus previews, blur clears when the pointer is elsewhere...
  fire(m.right, 'focus')
  assert.equal(preview(m), 'right')
  fire(m.right, 'blur')
  assert.equal(preview(m), null)
  // ...and hands the preview back to the half under the pointer.
  fire(m.left, 'mouseenter')
  fire(m.right, 'focus')
  assert.equal(preview(m), 'right')
  fire(m.right, 'blur')
  assert.equal(preview(m), 'left')
  await settle()
  assert.equal(m.svc.explains.length, 1)
  assert.equal(m.log.placed, 0)
})

test('second, right: the band splits; thread 0 streams on untouched and thread 1 asks with its own passage', async () => {
  const m = await started()
  m.call.send('chunk', { text: 'Left answer ' })
  await settle()
  const live0 = m.contents[0].querySelector('.ex-round.ex-live')
  m.panel.explain(REQ2)
  fire(m.right, 'mouseenter')
  infos.length = 0
  fire(m.right, 'click')
  assert.equal(m.slots.getAttribute('data-layout'), 'split')
  assert.equal(m.slots.getAttribute('data-place'), null)
  assert.equal(preview(m), null)
  assert.equal(m.call.aborted, false, 'the left stream keeps going')
  assert.equal(m.log.placed, 1)
  await settle()
  assert.equal(m.svc.explains.length, 2)
  const right = m.svc.explains[1]
  assert.deepEqual(right.body, { text: REQ2.text, items: REQ2.items, history: [] })
  assert.deepEqual(infos, [
    `[explain] "quarterdeck" · ${REQ2.text.length} chars · 0 earlier answers · right half\n\n${REQ2.text}`,
  ])
  right.open()
  await settle()
  // Both stream at once, each into its own column.
  m.call.send('chunk', { text: 'goes on.' })
  right.send('chunk', { text: 'Right answer.' })
  await settle()
  assert.equal(m.contents[0].querySelector('.ex-round.ex-live'), live0, 'thread 0 kept its live round')
  assert.equal(live0.textContent, 'Left answer goes on.')
  assert.equal(m.contents[1].querySelector('.ex-round.ex-live').textContent, 'Right answer.')
  m.call.send('done', {})
  right.send('done', {})
  await settle()
  assert.equal(blocks(m.contents[0])[0].querySelector('.ex-round').textContent, 'Left answer goes on.')
  assert.equal(blocks(m.contents[1])[0].querySelector('.ex-round').textContent, 'Right answer.')
})

test('replace: in a split each half replaces only itself; the other keeps its stream, rounds and marks', async () => {
  const m = await started()
  await answer(m.call, ANSWER0)
  const right1 = await placed(m, REQ2, 'right')
  right1.ignoreAbort = true
  right1.send('chunk', { text: 'OLD right' })
  await settle()
  const block0 = blocks(m.contents[0])[0]
  const officer = wordEl(block0, 'officer')
  officer.classList.add('is-marked')    // stands for a drill mark left from earlier
  assert.equal(m.panel.explain(REQ3), 'staged')
  assert.equal(m.slots.getAttribute('data-place'), 'replace')
  assert.equal(m.left.getAttribute('aria-label'), 'Put the new explanation in the left panel')
  assert.equal(m.right.getAttribute('aria-label'), 'Put the new explanation in the right panel')
  fire(m.right, 'mouseenter')
  assert.equal(preview(m), 'right')
  assert.equal(m.slots.getAttribute('data-layout'), 'split', 'nothing moves')
  fire(m.right, 'click')
  assert.equal(right1.aborted, true)
  await settle()
  const right2 = m.svc.explains.at(-1)
  assert.deepEqual(right2.body, { text: REQ3.text, items: REQ3.items, history: [] })
  right2.open()
  await settle()
  right1.send('chunk', { text: ' STALE' })
  right1.send('done', {})
  right2.send('chunk', { text: 'NEW right' })
  await settle()
  assert.equal(m.contents[1].textContent.includes('OLD'), false)
  assert.equal(m.contents[1].textContent.includes('STALE'), false)
  assert.equal(m.contents[1].querySelector('.ex-round.ex-live').textContent, 'NEW right')
  assert.equal(blocks(m.contents[0])[0], block0, 'the left half kept its round, node for node')
  assert.ok(officer.classList.contains('is-marked'))
  assert.equal(m.slots.getAttribute('data-layout'), 'split')
  // Now the left: the right half's live stream is left alone.
  const before = m.svc.explains.length
  await placed(m, REQ, 'left')
  assert.equal(m.svc.explains.length, before + 1)
  assert.deepEqual(m.svc.explains.at(-1).body, { text: REQ.text, items: REQ.items, history: [] })
  assert.equal(right2.aborted, false, 'the right stream keeps going')
  assert.equal(m.contents[0].contains(block0), false, 'the left half started over')
  assert.equal(m.contents[1].querySelector('.ex-round.ex-live').textContent, 'NEW right')
  assert.equal(m.slots.getAttribute('data-layout'), 'split', 'a split outlives a replace while a half holds anything')
  assert.equal(m.log.placed, 3)
})

test('only a trusted click, Enter or Space on a half places the pick: scripts and other keys spend nothing', async () => {
  const m = await started()
  await answer(m.call, ANSWER0)
  m.panel.explain(REQ2)
  fire(m.left, 'click', { isTrusted: false })
  fire(m.right, 'click', { isTrusted: false })
  fire(m.left, 'keydown', { key: 'Enter', isTrusted: false })
  fire(m.right, 'keydown', { key: ' ', isTrusted: false })
  fire(m.left, 'keydown', { key: 'a' })
  const tab = fire(m.left, 'keydown', { key: 'Tab' })
  assert.equal(tab.defaultPrevented, false, 'Tab still moves focus')
  await settle()
  assert.equal(m.panel.isStaged(), true)
  assert.equal(m.svc.explains.length, 1)
  assert.equal(m.log.placed, 0)
  const enter = fire(m.right, 'keydown', { key: 'Enter' })
  assert.equal(enter.defaultPrevented, true)
  assert.equal(enter.stopped, true, '#reader never sees the key that placed a pick')
  assert.equal(m.slots.getAttribute('data-layout'), 'split')
  await settle()
  assert.equal(m.svc.explains.length, 2)
  m.panel.explain(REQ3)
  const space = fire(m.left, 'keydown', { key: ' ' })
  assert.equal(space.defaultPrevented, true)
  await settle()
  assert.equal(m.svc.explains.length, 3)
  assert.deepEqual(m.svc.explains[2].body.items, REQ3.items)
  assert.equal(m.log.placed, 2)
})

test('cancelStaged drops the pick and spends nothing; both halves, the layout and the band stay', async () => {
  const m = await splitBand()
  assert.equal(m.panel.cancelStaged(), false, 'nothing staged')
  const asked = m.svc.explains.length
  const b0 = blocks(m.contents[0])[0]
  const b1 = blocks(m.contents[1])[0]
  m.panel.explain(REQ3)
  fire(m.right, 'mouseenter')
  m.right.focus()
  assert.equal(m.panel.cancelStaged(), true)
  assert.equal(m.panel.isStaged(), false)
  assert.equal(m.place.hidden, true)
  assert.equal(m.slots.getAttribute('data-place'), null)
  assert.equal(preview(m), null)
  assert.deepEqual(inert(m), [false, false])
  assert.equal(document.activeElement, m.el, 'focus never falls to <body>')
  assert.equal(m.panel.isOpen(), true)
  assert.equal(m.slots.getAttribute('data-layout'), 'split')
  assert.equal(blocks(m.contents[0])[0], b0)
  assert.equal(blocks(m.contents[1])[0], b1)
  // A click on a half after the cancel is not a placement.
  fire(m.left, 'click')
  await settle()
  assert.equal(m.svc.explains.length, asked)
  assert.equal(m.log.placed, 1, 'only the split itself was placed')
  assert.equal(m.log.closed, 0)
  assert.equal(m.panel.cancelStaged(), false, 'twice is a no-op')
})

test('close while split and staged: both streams aborted, the stage dropped, one panel again, onClosed once', async () => {
  const m = await started()
  m.call.send('chunk', { text: 'left' })
  const right = await placed(m, REQ2, 'right')
  right.ignoreAbort = true             // its body keeps delivering after the abort
  right.send('chunk', { text: 'right' })
  await settle()
  m.panel.explain(REQ3)
  fire(m.right, 'mouseenter')
  m.panel.close()
  assert.equal(m.call.aborted, true)
  assert.equal(right.aborted, true)
  assert.equal(m.panel.isStaged(), false)
  assert.equal(m.place.hidden, true)
  assert.equal(m.slots.getAttribute('data-place'), null)
  assert.equal(m.slots.getAttribute('data-layout'), 'single')
  assert.equal(preview(m), null)
  assert.deepEqual(inert(m), [false, false])
  assert.equal(m.el.hidden, true)
  assert.deepEqual(m.contents.map((c) => c.childNodes.length), [0, 0])
  assert.equal(m.log.closed, 1)
  right.send('chunk', { text: ' late' })
  await settle()
  assert.equal(m.contents[1].childNodes.length, 0, 'nothing paints after close')
  // The next pick is a first pick again.
  assert.equal(m.panel.explain(REQ), 'started')
  assert.equal(m.slots.getAttribute('data-layout'), 'single')
})

test('D6: when no half holds anything at the click, the pick starts thread 0 at full width, never a blank-left split', async () => {
  const m = await started()            // thread 0 waits for its first chunk
  assert.equal(m.panel.explain(REQ2), 'staged')
  m.call.send('done', {})              // ...and ends empty
  await settle()
  fire(m.right, 'mouseenter')
  fire(m.right, 'click')
  assert.equal(m.slots.getAttribute('data-layout'), 'single')
  await settle()
  assert.equal(m.svc.explains.length, 2)
  assert.deepEqual(m.svc.explains[1].body, { text: REQ2.text, items: REQ2.items, history: [] })
  assert.ok(m.contents[0].querySelector('.ex-round.ex-live'), 'it streams on the left, at full width')
  assert.equal(m.contents[1].childNodes.length, 0)
  assert.equal(m.log.placed, 1)
})

/* ── E110: focus, inert, wheel, width ───────────────────────────────────── */

test('focus: every commit or cancel that hides a focused half leaves focus on the band root, inside #reader', async () => {
  const m = await started()
  await answer(m.call, ANSWER0)
  // Mouse: the press on a tabindex=0 half focuses it.
  m.panel.explain(REQ2)
  m.left.focus()
  fire(m.left, 'click')
  assert.equal(document.activeElement, m.el)
  await settle()
  m.svc.explains.at(-1).open()
  await settle()
  // Key.
  m.panel.explain(REQ3)
  m.right.focus()
  fire(m.right, 'keydown', { key: 'Enter' })
  assert.equal(document.activeElement, m.el)
  // Esc's cancel.
  m.panel.explain(REQ)
  m.left.focus()
  m.panel.cancelStaged()
  assert.equal(document.activeElement, m.el)
  // A newer pick hides nothing, so a focused half keeps focus, and Enter
  // places the newer pick.
  m.panel.explain(REQ2)
  m.right.focus()
  m.panel.explain(REQ3)
  assert.equal(document.activeElement, m.right)
  assert.equal(m.panel.isStaged(), true)
  fire(m.right, 'keydown', { key: 'Enter' })
  assert.equal(document.activeElement, m.el)
  await settle()
  assert.equal(m.svc.explains.at(-1).body.text, REQ3.text)
})

test('while a pick is staged both columns are inert, and a focused link inside moves to the band root first', async () => {
  const m = await started()
  await answer(m.call, 'See [the entry](https://www.merriam-webster.com/dictionary/mate) here.')
  m.content.querySelector('.ex-link').focus()
  assert.equal(m.panel.explain(REQ2), 'staged')
  assert.deepEqual(inert(m), [true, true])
  assert.equal(document.activeElement, m.el)
  m.panel.cancelStaged()
  assert.deepEqual(inert(m), [false, false])
  m.panel.explain(REQ2)
  fire(m.right, 'click')
  assert.deepEqual(inert(m), [false, false])
  m.panel.explain(REQ3)
  assert.deepEqual(inert(m), [true, true])
  m.panel.close()
  assert.deepEqual(inert(m), [false, false])
})

test('the wheel over the overlay scrolls the answer underneath: the hovered half in a split, else thread 0', async () => {
  const m = await splitBand()
  m.panel.explain(REQ3)
  const [s0, s1] = m.scrolls
  s0.scrollTop = 0
  s1.scrollTop = 0
  const w = fire(m.left, 'wheel', { deltaY: 120, deltaMode: 0 })
  assert.equal(w.defaultPrevented, true)
  assert.equal(s0.scrollTop, 120)
  assert.equal(s1.scrollTop, 0)
  fire(m.right, 'wheel', { deltaY: 50, deltaMode: 0 })
  assert.equal(s1.scrollTop, 50)
  fire(m.right, 'wheel', { deltaY: 3, deltaMode: 1 })          // lines
  assert.equal(s1.scrollTop, 50 + 3 * 40)
  fire(m.right, 'wheel', { deltaY: 1, deltaMode: 2 })          // a page: the scroller's height
  assert.equal(s1.scrollTop, 170 + 300)
  const zoom = fire(m.left, 'wheel', { deltaY: 100, ctrlKey: true })
  assert.equal(zoom.defaultPrevented, false, 'Ctrl+wheel is the zoom, not a scroll')
  assert.equal(s0.scrollTop, 120)
  // One panel, previewing the split: the new half is empty, so thread 0 scrolls.
  const one = await started()
  await answer(one.call, ANSWER0)
  one.panel.explain(REQ2)
  fire(one.right, 'mouseenter')
  one.scrolls[0].scrollTop = 0
  fire(one.right, 'wheel', { deltaY: 30 })
  assert.equal(one.scrolls[0].scrollTop, 30)
  assert.equal(one.scrolls[1].scrollTop, 0)
})

test('D2: a half that follows its stream keeps following through the preview, its removal and the committed split', async () => {
  const m = await started()
  m.call.send('chunk', { text: 'streaming ' })
  await settle()
  const s0 = m.scrolls[0]
  // Half the width wraps to more lines, so the column grows.
  const halfWidth = () => m.slots.classList.contains('place-right') || m.slots.getAttribute('data-layout') === 'split'
  Object.defineProperty(s0, 'scrollHeight', { configurable: true, get: () => (halfWidth() ? 1600 : 1000) })
  s0.scrollTop = 700                   // 1000 - 700 - 300 = 0: following
  m.panel.explain(REQ2)
  fire(m.right, 'mouseenter')
  assert.equal(s0.scrollTop, 1600, 'pinned at half width')
  fire(m.place, 'mouseleave')
  assert.equal(s0.scrollTop, 1000, 'pinned again at full width')
  fire(m.right, 'mouseenter')
  fire(m.right, 'click')
  assert.equal(s0.scrollTop, 1600, 'and through the committed split')
  // A half the reader scrolled up in stays where the reader left it.
  const n = await started()
  n.call.send('chunk', { text: 'streaming ' })
  await settle()
  const t0 = n.scrolls[0]
  Object.defineProperty(t0, 'scrollHeight', {
    configurable: true,
    get: () => (n.slots.classList.contains('place-right') ? 1600 : 1000),
  })
  t0.scrollTop = 100
  n.panel.explain(REQ2)
  fire(n.right, 'mouseenter')
  assert.equal(t0.scrollTop, 100)
  fire(n.right, 'click')
  assert.equal(t0.scrollTop, 100)
})

test('D2: Esc over the right preview re-pins a following half; a finished half at its bottom is never moved', async () => {
  const m = await started()
  m.call.send('chunk', { text: 'streaming ' })
  await settle()
  const s0 = m.scrolls[0]
  Object.defineProperty(s0, 'scrollHeight', {
    configurable: true,
    get: () => (m.slots.classList.contains('place-right') ? 1600 : 1000),
  })
  assert.equal(m.panel.explain(REQ2), 'staged')
  fire(m.right, 'focus')               // the keyboard previews the split
  assert.equal(preview(m), 'right')
  s0.scrollTop = 1300                  // 1600 - 1300 - 300 = 0: following at half width
  assert.equal(m.panel.cancelStaged(), true)
  assert.equal(preview(m), null)
  assert.equal(s0.scrollTop, 1000, 'pinned again at full width')
  // Following means following a STREAM: a finished half at its bottom stays.
  const n = await started()
  await answer(n.call, ANSWER0)
  const t0 = n.scrolls[0]
  Object.defineProperty(t0, 'scrollHeight', {
    configurable: true,
    get: () => (n.slots.classList.contains('place-right') ? 1600 : 1000),
  })
  t0.scrollTop = 700
  assert.equal(n.panel.explain(REQ2), 'staged')
  fire(n.right, 'mouseenter')
  assert.equal(preview(n), 'right')
  assert.equal(t0.scrollTop, 700, 'a finished half is not re-pinned')
})

test('a start drops an older stage: a pick left waiting when the stream ended empty is never placed', async () => {
  const m = await started()            // thread 0 waits for its first chunk
  assert.equal(m.panel.explain(REQ2), 'staged')
  m.call.send('done', {})              // ...and ends empty: no half holds anything
  await settle()
  assert.equal(m.panel.explain(REQ3), 'started')
  assert.equal(m.panel.isStaged(), false)
  assert.equal(m.place.hidden, true)
  assert.equal(m.slots.getAttribute('data-place'), null)
  assert.deepEqual(inert(m), [false, false])
  fire(m.left, 'click')
  fire(m.left, 'keydown', { key: 'Enter' })
  await settle()
  assert.equal(m.svc.explains.length, 2, 'the dropped pick costs nothing')
  assert.deepEqual(m.svc.explains[1].body, { text: REQ3.text, items: REQ3.items, history: [] })
  assert.equal(m.log.placed, 0)
})

test('a split whose two halves both ended empty goes back to one panel: at the click (D6) and at a new pick', async () => {
  // D6 at the click.
  const m = await started()
  const c1 = await placed(m, REQ2, 'right')
  assert.equal(m.slots.getAttribute('data-layout'), 'split')
  assert.equal(m.panel.explain(REQ3), 'staged')
  assert.equal(m.slots.getAttribute('data-place'), 'replace')
  m.call.send('done', {})
  c1.send('done', {})
  await settle()
  fire(m.right, 'click')
  assert.equal(m.slots.getAttribute('data-layout'), 'single')
  await settle()
  assert.deepEqual(m.svc.explains.at(-1).body, { text: REQ3.text, items: REQ3.items, history: [] })
  assert.ok(m.contents[0].querySelector('.ex-round.ex-live'), 'it streams on the left, at full width')
  // The start path.
  const n = await started()
  const d1 = await placed(n, REQ2, 'right')
  n.call.send('done', {})
  d1.send('done', {})
  await settle()
  assert.equal(n.panel.explain(REQ3), 'started')
  assert.equal(n.slots.getAttribute('data-layout'), 'single')
})

test('the band keeps exactly two window listeners, however many halves stream', async () => {
  const before = win.listeners.length
  const m = mount()
  assert.deepEqual(win.listeners.slice(before).map((l) => [l.type, l.cap]), [['mouseup', true], ['click', true]])
  m.panel.explain(REQ)
  await settle()
  m.svc.explains[0].open()
  await settle()
  const right = await placed(m, REQ2, 'right')
  right.send('chunk', { text: 'x' })
  m.panel.explain(REQ3)
  await settle()
  assert.equal(win.listeners.length, before + 2)
  m.panel.destroy()
  assert.equal(win.listeners.length, before)
})

/* ── E110: per half ─────────────────────────────────────────────────────── */

test('drill-down in a split extends only its own half, with that half\'s passage and history; the other keeps its marks and stream', async () => {
  const m = await started()
  await answer(m.call, ANSWER0)
  const right = await placed(m, REQ2, 'right')
  await answer(right, ANSWER1)
  const [c0, c1] = m.contents
  const officer = wordEl(blocks(c0)[0], 'officer')
  drillDown(c0, officer)
  await settle()
  const d0 = m.svc.explains.at(-1)
  assert.deepEqual(d0.body, { text: REQ.text, items: [{ phrase: 'officer', words: ['officer'] }], history: [ANSWER0] })
  d0.open()
  await settle()
  d0.send('chunk', { text: 'still streaming on the left' })
  await settle()
  // A press in the right half: its own chain, its own passage and history.
  const deck = wordEl(blocks(c1)[0], 'deck')
  drillDown(c1, deck)
  await settle()
  const d1 = m.svc.explains.at(-1)
  assert.deepEqual(d1.body, { text: REQ2.text, items: [{ phrase: 'deck', words: ['deck'] }], history: [ANSWER1] })
  assert.equal(d0.aborted, false, 'a drill-down on the right leaves the left stream alone')
  assert.ok(officer.classList.contains('is-marked'), "a press in the right half leaves the left half's mark")
  assert.ok(deck.classList.contains('is-marked'))
  assert.equal(blocks(c0).length, 2)
  assert.equal(blocks(c1).length, 2)
  // History is per half: a second round on the right replays only the right's answers.
  d1.open()
  await settle()
  await answer(d1, 'A deck is a floor.')
  drillDown(c1, wordEl(blocks(c1)[1], 'floor'))
  await settle()
  assert.deepEqual(m.svc.explains.at(-1).body.history, [ANSWER1, 'A deck is a floor.'])
  assert.equal(m.svc.explains.at(-1).body.text, REQ2.text)
})

test('drill-down is blocked while a pick is staged', async () => {
  const m = await started()
  await answer(m.call, ANSWER0)
  m.panel.explain(REQ2)
  const officer = wordEl(blocks(m.content)[0], 'officer')
  fire(officer, 'mousedown')
  fire(m.content, 'mouseup')
  await settle()
  assert.equal(m.svc.explains.length, 1)
  assert.equal(officer.classList.contains('is-marked'), false)
  assert.equal(m.panel.isStaged(), true)
})

test('drill-down: the double-click guard is per half, so the same round and word in the other half still asks', async () => {
  const m = await started()
  await answer(m.call, 'same words here')
  const right = await placed(m, REQ2, 'right')
  await answer(right, 'same words here')
  const w0 = wordEl(blocks(m.contents[0])[0], 'words')
  const w1 = wordEl(blocks(m.contents[1])[0], 'words')
  assert.equal(w0.getAttribute('data-rid'), w1.getAttribute('data-rid'), 'the same round/rid in both halves')
  fire(w0, 'mousedown', { detail: 1 })
  fire(m.contents[0], 'mouseup')
  await settle()
  const n = m.svc.explains.length
  fire(w1, 'mousedown', { detail: 2 })
  fire(m.contents[1], 'mouseup')
  await settle()
  assert.equal(m.svc.explains.length, n + 1)
  assert.equal(m.svc.explains.at(-1).body.text, REQ2.text)
})

test("each half has its own Merriam-Webster cache: the left half's clips never stand in for the right half's words", async () => {
  const STATE = { hword: 'state', variants: [{ pos: 'noun', posList: ['noun'], ipa: 'ˈstāt', mp3: MP3 + '?state' }] }
  const m = await started({ req: { text: 'p', items: [{ phrase: 'state', words: ['state'] }] } })
  m.call.send('pron-data', { prons: { state: STATE } })
  await answer(m.call, '**state** [[PRON word="state" pos="noun"]]: a condition.')
  m.panel.explain({ text: 'q', items: [{ phrase: 'public statement', words: ['public', 'statement'] }] })
  fire(m.right, 'click')
  await settle()
  const row = inside(m.contents[1], '.ex-pron-only', '.pron-badge')
    .find((b) => b.getAttribute('data-key') === 'statement|')
  assert.ok(row, 'the right half has a badge for "statement"')
  assert.equal(row.getAttribute('data-mp3'), null, "never the left half's clip for state")
  assert.ok(row.classList.contains('loading'))
  assert.ok(m.svc.prons.some((p) => p.word === 'statement'), 'statement is looked up for itself')
  const left = inside(m.contents[0], '.ex-pron-only', '.pron-badge')[0]
  assert.equal(left.classList.contains('loading'), false, 'the left half keeps its own')
})

test("each half looks its words up for itself, and resetting one half never drops the other's lookup", async () => {
  const m = await started()
  await answer(m.call, 'A mate.')
  assert.equal(m.svc.prons.filter((p) => p.word === 'mate').length, 1)
  const leftLookup = m.svc.prons[0]
  await placed(m, REQ, 'right')
  assert.equal(m.svc.prons.filter((p) => p.word === 'mate').length, 2, 'the right half asks for the same word itself')
  // Replace the right half while the left half's lookup is still out.
  m.panel.explain(REQ2)
  fire(m.right, 'click')
  await settle()
  leftLookup.reply(200, MATE)
  await settle()
  const row0 = inside(m.contents[0], '.ex-pron-only', '.pron-badge')[0]
  assert.equal(row0.classList.contains('loading'), false, "the left half's lookup still lands")
  assert.equal(row0.getAttribute('data-mp3'), MP3)
})

test('deadline: each half has its own 180 s deadline', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const m = await started()
    m.call.send('chunk', { text: 'Slow left' })
    await settle()
    mock.timers.tick(60_000)
    const right = await placed(m, REQ2, 'right')
    right.send('chunk', { text: 'Slow right' })
    await settle()
    mock.timers.tick(120_000)
    await settle()
    assert.equal(m.call.aborted, true)
    assert.equal(right.aborted, false)
    assert.equal(errLine(m.contents[0]), "ai-service didn't finish within 180 s, so the request was stopped.")
    assert.equal(errLine(m.contents[1]), null)
    mock.timers.tick(60_000)
    await settle()
    assert.equal(right.aborted, true)
    assert.equal(errLine(m.contents[1]), "ai-service didn't finish within 180 s, so the request was stopped.")
  } finally {
    mock.timers.reset()
  }
})

test('audio: one clip across both halves, and placing a pick in a half stops no clip', async () => {
  const m = await started()
  m.call.send('pron-data', { prons: { mate: MATE } })
  await answer(m.call, 'a [[PRON word="mate" pos="noun"]]')
  const b0 = inside(m.contents[0], '.ex-round', '.pron-badge')[0]
  fire(b0, 'click')
  assert.equal(m.log.audios.length, 1)
  const right = await placed(m, REQ, 'right')
  assert.equal(m.log.audios[0].paused, false, 'placing a pick stopped nothing')
  assert.ok(b0.classList.contains('is-playing'))
  right.send('pron-data', { prons: { mate: MATE } })
  await answer(right, 'b [[PRON word="mate" pos="noun"]]')
  const b1 = inside(m.contents[1], '.ex-round', '.pron-badge')[0]
  fire(b1, 'click')
  assert.equal(m.log.audios[0].paused, true, 'one clip at a time across the halves')
  assert.equal(b0.classList.contains('is-playing'), false)
  assert.ok(b1.classList.contains('is-playing'))
  // Replacing the right half lets its clip play on (comart: a reset stops no audio).
  m.panel.explain(REQ2)
  fire(m.right, 'click')
  assert.equal(m.log.audios[1].paused, false)
})

/* ── destroy ────────────────────────────────────────────────────────────── */

test('destroy: closes both halves, removes the band and its window listeners', async () => {
  const m = await started()
  const { panel, el, host, call, log } = m
  call.send('chunk', { text: 'left' })
  const right = await placed(m, REQ2, 'right')
  right.send('chunk', { text: 'right' })
  await settle()
  const before = win.listeners.length
  panel.destroy()
  assert.equal(call.aborted, true)
  assert.equal(right.aborted, true, 'the right half is aborted too')
  assert.equal(log.closed, 1)
  assert.equal(host.children.includes(el), false)
  assert.equal(win.listeners.length, before - 2)
  panel.explain(REQ)
  await settle()
  assert.equal(el.hidden, true, 'a destroyed band stays down')
  assert.equal(m.svc.explains.length, 2, 'and asks nothing')
})

/* ── source conformance ─────────────────────────────────────────────────── */

test('source: no innerHTML-family sink and no DOMParser in src/explain.ts or src/explain-thread.ts (§6.1)', () => {
  for (const file of [SRC, THREAD]) {
    const src = readFileSync(file, 'utf8')
    assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|setHTMLUnsafe|parseHTMLUnsafe|DOMParser|createContextualFragment|document\.write/, file)
  }
})

test('source: a half holds no listener; the band owns every one (explain-thread.ts)', () => {
  const src = readFileSync(THREAD, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
  assert.doesNotMatch(src, /addEventListener|\.on[a-z]+\s*=/)
})
