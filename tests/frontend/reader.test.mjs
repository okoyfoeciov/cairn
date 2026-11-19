/**
 * tests/frontend/reader.test.mjs — CONTRACT §0.55 E108's reader surface.
 *
 * Driven through the real `mountReader` on `_minidom.mjs`.  The important half
 * is the SANITISER: a book's XHTML contains scripts, remote images and hostile
 * link schemes, and none of them may become live DOM.  The rest pins the reading
 * surface, the Mod-F find overlay, the stripped chrome and the takeover class,
 * and §0.56 E109's word pick, driven through a fake layout probe and a fake
 * explanation band (the real band is explain.ts's, tested on its own).
 */

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'
import { installGlobals, AElement, ADocument } from './_minidom.mjs'
import { fixture, zip, CONTAINER } from './_epub-fixture.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '..', '..')

/** @type {any} */ let R

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cairn-reader-'))
  process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })
  const out = join(dir, 'bundle.mjs')
  await esbuild.build({
    stdin: {
      contents: 'export * as R from ' + JSON.stringify(join(ROOT, 'src', 'reader.ts')) + '\n',
      resolveDir: ROOT,
      sourcefile: 'reader-test-entry.ts',
      loader: 'ts',
    },
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    mainFields: ['module', 'main'],
    conditions: ['import', 'default'],
    target: 'es2021',
    absWorkingDir: ROOT,
    logLevel: 'silent',
  })
  R = (await import(pathToFileURL(out).href)).R

  installGlobals()
  // `_minidom.mjs` covers tree/search; the reader uses the browser spellings
  // and the two layout numbers a scroll needs.
  if (!AElement.prototype.appendChild) {
    AElement.prototype.appendChild = function appendChild(kid) { this.append(kid); return kid }
  }
  if (!AElement.prototype.replaceWith) {
    AElement.prototype.replaceWith = function replaceWith(node) {
      const p = this.parentNode
      if (!p) return
      const at = p.childNodes.indexOf(this)
      if (at >= 0) {
        node.remove()
        node.parentNode = p
        p.childNodes[at] = node
      }
    }
  }
  Object.defineProperty(AElement.prototype, 'style', {
    configurable: true,
    get() {
      if (!this._style) this._style = {}
      return this._style
    },
  })
  Object.defineProperties(AElement.prototype, {
    scrollHeight: { configurable: true, get() { return 1000 } },
    clientHeight: { configurable: true, get() { return 500 } },
    offsetHeight: { configurable: true, get() { return 27 } },
  })

  const doc = new ADocument()
  doc.listeners = new Map()
  doc.addEventListener = (t, f) => {
    if (!doc.listeners.has(t)) doc.listeners.set(t, [])
    doc.listeners.get(t).push(f)
  }
  doc.removeEventListener = (t, f) => {
    const list = doc.listeners.get(t)
    if (list) doc.listeners.set(t, list.filter((x) => x !== f))
  }
  globalThis.document = doc
  globalThis.window = {
    setTimeout, clearTimeout,
    addEventListener: (t, f) => {
      if (!winListeners.has(t)) winListeners.set(t, [])
      winListeners.get(t).push(f)
    },
    removeEventListener: (t, f) => {
      const list = winListeners.get(t)
      if (list) winListeners.set(t, list.filter((x) => x !== f))
    },
    requestAnimationFrame: (cb) => setTimeout(cb, 0),
  }
  globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0)
  globalThis.URL.createObjectURL = () => 'blob:fixture'
  globalThis.URL.revokeObjectURL = () => {}
  // E109 paints picks through the CSS Highlight API; these stand in for the
  // engine's registry, Highlight and Range, recording what was painted.
  globalThis.CSS = { highlights: new Map() }
  globalThis.Highlight = class Highlight { constructor(...ranges) { this.ranges = ranges } }
  doc.createRange = () => ({
    setStart(node, offset) { this.startContainer = node; this.startOffset = offset },
    setEnd(node, offset) { this.endContainer = node; this.endOffset = offset },
  })
})

const winListeners = new Map()
const fireWindow = (type, ev) => { for (const f of [...(winListeners.get(type) ?? [])]) f(ev) }
const fireDocument = (type, ev) => { for (const f of [...(document.listeners.get(type) ?? [])]) f(ev) }

const settle = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0))
}

function mount(readEpub = async () => fixture(), extra = {}) {
  const pane = document.createElement('main')
  pane.className = 'editor'
  const progress = []
  const errors = []
  const reader = R.mountReader(pane, {
    transport: {
      readEpub,
      openExternal: async () => {},
    },
    onProgress: (path, pos) => progress.push([path, pos]),
    onError: (err, ctx) => errors.push([ctx, err]),
    ...extra,
  })
  const scroller = pane.querySelector('.ep-scroller')
  assert.ok(scroller)
  return { pane, reader, progress, errors, scroller }
}

test('mount: hidden by default, and no takeover class until a book is open', () => {
  const { pane, reader } = mount()
  assert.equal(reader.visible(), false)
  assert.equal(pane.classList.contains('is-reader'), false)
  assert.equal(pane.querySelector('[id="reader"]').hidden, true)
  reader.destroy()
})

test('open: two chapter sections and the takeover class, with no header chrome', async () => {
  const { pane, reader } = mount()
  assert.equal(await reader.open('Books/Test.epub', null), true)
  await settle()
  assert.equal(reader.visible(), true)
  assert.equal(pane.classList.contains('is-reader'), true)
  assert.equal(reader.path(), 'Books/Test.epub')
  const chapters = pane.querySelectorAll('.ep-chapter')
  assert.equal(chapters.length, 2)
  assert.ok(chapters[0].textContent.includes('Hello world'))
  assert.ok(chapters[1].textContent.includes('Another needle lives here.'))
  reader.destroy()
})

test('sanitiser: scripts and hostile link schemes never reach the document', async () => {
  const { pane, reader } = mount()
  await reader.open('Books/Test.epub', null)
  await settle()
  const all = pane.descendants()
  assert.equal(all.filter((e) => e.tagName === 'SCRIPT').length, 0, 'a script element is dropped whole')
  assert.equal(all.filter((e) => e.tagName === 'STYLE').length, 0)
  const anchors = all.filter((e) => e.tagName === 'A')
  assert.ok(anchors.some((a) => a.getAttribute('data-ep-external') === 'https://example.com/x'))
  assert.ok(anchors.every((a) => !String(a.getAttribute('href') ?? '').toLowerCase().startsWith('javascript:')))
  const internal = anchors.find((a) => a.getAttribute('data-ep-chapter') === '1')
  assert.ok(internal, 'a cross-chapter href resolves to the spine index')
  assert.equal(internal.getAttribute('data-ep-fragment'), 'deep')
  assert.equal(internal.getAttribute('href'), '#ep-c1-deep')
  reader.destroy()
})

test('images are resource blob URLs, never the archive path', async () => {
  const { pane, reader } = mount()
  await reader.open('Books/Test.epub', null)
  await settle()
  const img = pane.descendants().find((e) => e.tagName === 'IMG')
  assert.ok(img)
  assert.equal(img.getAttribute('alt'), 'A picture')
  assert.equal(img.getAttribute('width'), '1')
  assert.equal(img.getAttribute('height'), '1')
  assert.equal(img.getAttribute('src'), 'blob:fixture')
  assert.ok(!String(img.getAttribute('src')).includes('pic.png'))
  reader.destroy()
})

test('chrome: no reader header, Contents strip, progress or Search button', async () => {
  const { pane, reader } = mount()
  await reader.open('Books/Test.epub', null)
  await settle()
  assert.equal(pane.querySelectorAll('.ep-bar').length, 0)
  assert.equal(pane.querySelectorAll('.ep-toc-toggle').length, 0)
  assert.equal(pane.querySelectorAll('.ep-toc-pane').length, 0)
  assert.equal(pane.querySelectorAll('.ep-search-toggle').length, 0)
  assert.equal(pane.querySelectorAll('.ep-progress').length, 0)
  assert.equal(pane.querySelectorAll('.ep-chapter-arrow').length, 0)
  assert.equal(pane.querySelectorAll('.ep-scroller').length, 1)
  reader.destroy()
})

test('Mod-F opens the note viewer find bar; count, Enter, Esc', async () => {
  const { pane, reader } = mount()
  await reader.open('Books/Test.epub', null)
  await settle()
  pane.querySelector('[id="reader"]').dispatch('keydown', {
    key: 'f', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false,
    preventDefault() {},
  })
  const bar = pane.querySelector('.find-bar')
  assert.equal(bar.hidden, false)
  const input = pane.querySelector('.find-input')
  assert.equal(input.placeholder, 'Find in book')
  input.value = 'needle'
  input.dispatch('input', {})
  assert.equal(pane.querySelector('.find-count').textContent, '1/2')
  input.dispatch('keydown', { key: 'Enter', preventDefault() {} })
  assert.equal(pane.querySelector('.find-count').textContent, '2/2')
  input.dispatch('keydown', { key: 'Escape', preventDefault() {} })
  await settle()
  assert.equal(bar.hidden, true)
  assert.equal(pane.querySelectorAll('mark.cm-find-match').length, 0)
  reader.destroy()
})

test('find: reveal centres the mark directly, not through scrollIntoView', async () => {
  const { pane, reader, scroller } = mount()
  await reader.open('Books/Test.epub', null)
  await settle()
  Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 100000 })
  Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 600 })
  const proto = Object.getPrototypeOf(scroller)
  const original = proto.getBoundingClientRect
  let markTop = 5000
  // This is the environment that produced the reported bug: scrollIntoView
  // is a no-op, so only an explicit scrollTop can move the reading surface.
  proto.getBoundingClientRect = function () {
    if (this.classList.contains('ep-scroller')) {
      return { left: 0, top: 40, right: 1000, bottom: 640, width: 1000, height: 600 }
    }
    if (this.tagName === 'MARK') {
      return { left: 0, top: markTop, right: 60, bottom: markTop + 20, width: 60, height: 20 }
    }
    if (this.classList.contains('ep-chapter')) {
      return { left: 0, top: 40, right: 800, bottom: 5040, width: 800, height: 5000 }
    }
    return original.call(this)
  }
  try {
    pane.querySelector('[id="reader"]').dispatch('keydown', {
      key: 'f', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false,
      preventDefault() {},
    })
    const input = pane.querySelector('.find-input')
    input.value = 'needle'
    input.dispatch('input', {})
    assert.equal(pane.querySelector('.find-count').textContent, '1/2')
    // "needle" is split across two inline spans in the fixture: one match must
    // paint two mark segments and mark both as current.
    assert.equal(pane.querySelectorAll('mark.cm-find-match').length, 2)
    assert.equal(pane.querySelectorAll('mark.cm-find-current').length, 2)
    assert.equal(scroller.scrollTop, 4670)

    // An image above the mark lands after the reveal: the mark is now 1000px
    // lower in the document.  The load path must re-centre it.
    markTop = 1330
    pane.querySelector('.ep-content').dispatch('load', {})
    assert.equal(scroller.scrollTop, 5670)
  } finally {
    proto.getBoundingClientRect = original
    reader.destroy()
  }
})

test('find: stepping and changing the query repaint only when needed', async () => {
  const { pane, reader } = mount()
  await reader.open('Books/Test.epub', null)
  await settle()
  pane.querySelector('[id="reader"]').dispatch('keydown', {
    key: 'f', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false,
    preventDefault() {},
  })
  const input = pane.querySelector('.find-input')
  input.value = 'needle'
  input.dispatch('input', {})
  assert.equal(pane.querySelector('.find-count').textContent, '1/2')
  input.dispatch('keydown', { key: 'Enter', preventDefault() {} })
  assert.equal(pane.querySelector('.find-count').textContent, '2/2')
  input.value = 'hello'
  input.dispatch('input', {})
  assert.equal(pane.querySelector('.find-count').textContent, '1/1')
  assert.equal(pane.querySelectorAll('mark.cm-find-match').length, 1)
  assert.equal(pane.querySelectorAll('mark.cm-find-current').length, 1)
  reader.destroy()
})

test('Mod-F does not prefill the field from selected book text', async () => {
  const { pane, reader } = mount()
  await reader.open('Books/Test.epub', null)
  await settle()
  pane.ownerDocument.defaultView.getSelection = () => ({ toString: () => 'selected lizard' })
  try {
    pane.querySelector('[id="reader"]').dispatch('keydown', {
      key: 'f', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false,
      preventDefault() {},
    })
    const input = pane.querySelector('.find-input')
    assert.equal(pane.querySelector('.find-bar').hidden, false)
    assert.equal(input.value, '')
  } finally {
    delete pane.ownerDocument.defaultView.getSelection
    reader.destroy()
  }
})

test('find: count and painted marks use the same rendered text (NBSP)', async () => {
  const { pane, reader } = mount()
  await reader.open('Books/Test.epub', null)
  await settle()
  pane.querySelector('[id="reader"]').dispatch('keydown', {
    key: 'f', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false,
    preventDefault() {},
  })
  const input = pane.querySelector('.find-input')
  input.value = 'with space'
  input.dispatch('input', {})
  assert.equal(pane.querySelector('.find-count').textContent, '1/1')
  assert.equal(pane.querySelectorAll('mark.cm-find-match').length, 1)
  assert.equal(pane.querySelectorAll('mark.cm-find-current').length, 1)
  reader.destroy()
})

test('open: the last click wins, and a close during a read cannot resurrect', async () => {
  const { reader } = mount(async (path) => {
    await new Promise((r) => setTimeout(r, path === 'Books/A.epub' ? 40 : 1))
    return fixture()
  })
  const a = reader.open('Books/A.epub', null)
  const b = reader.open('Books/B.epub', null)
  assert.deepEqual(await Promise.all([a, b]), [false, true])
  await settle()
  assert.equal(reader.path(), 'Books/B.epub')
  assert.equal(reader.visible(), true)

  const c = reader.open('Books/C.epub', null)
  reader.close()
  assert.equal(await c, false)
  await settle()
  assert.equal(reader.visible(), false)
  assert.equal(reader.path(), null)
})

test('links: same-chapter fragments and structural ids survive rendering', async () => {
  const { pane, reader } = mount()
  await reader.open('Books/Test.epub', null)
  await settle()
  const links = pane.querySelectorAll('a[data-ep-target-id]')
  const targets = links.map((a) => a.getAttribute('data-ep-target-id'))
  assert.ok(targets.includes('ep-c1-tail'))
  assert.ok(targets.includes('ep-c1-aside1'))
  assert.ok(pane.querySelector('[id="ep-c1-tail"]'))
  assert.ok(pane.querySelector('[id="ep-c1-aside1"]'))
  reader.destroy()
})

test('open: a corrupt replacement leaves the readable book in place', async () => {
  const { pane, reader } = mount(async (path) =>
    path === 'Books/Bad.epub' ? new ArrayBuffer(8) : fixture()
  )
  assert.equal(await reader.open('Books/Test.epub', null), true)
  await settle()
  assert.equal(await reader.open('Books/Bad.epub', null), false)
  await settle()
  assert.equal(reader.path(), 'Books/Test.epub')
  assert.equal(reader.visible(), true)
  assert.equal(pane.querySelectorAll('.ep-chapter').length, 2)
  reader.destroy()
})

test('open: no "Opening book…" page: the pane stays blank until the text is in, and a failed open\'s page goes at once', async () => {
  const { pane, reader } = mount(async (path) =>
    path === 'Books/Bad.epub' ? new ArrayBuffer(8) : fixture()
  )
  const message = pane.querySelector('.ep-message')
  const title = pane.querySelector('.ep-message-title')
  // Every write to the message page, with how much of the book was in by then.
  const seen = []
  const spy = (el, key, label) => {
    let d = null
    for (let p = el; p && !d; p = Object.getPrototypeOf(p)) d = Object.getOwnPropertyDescriptor(p, key)
    Object.defineProperty(el, key, {
      configurable: true,
      get() { return d.get.call(this) },
      set(v) {
        seen.push({ [label]: v, chapters: pane.querySelectorAll('.ep-chapter').length })
        d.set.call(this, v)
      },
    })
  }
  spy(message, 'hidden', 'hidden')
  spy(title, 'textContent', 'title')

  assert.equal(await reader.open('Books/Test.epub', null), true)
  await settle()
  assert.deepEqual(seen.filter((s) => 'title' in s || s.hidden === false), [],
    'a first open put a message on screen before the book')
  assert.deepEqual({ chapters: pane.querySelectorAll('.ep-chapter').length, message: message.hidden },
    { chapters: 2, message: true })

  // A failed first open leaves its error page up...
  reader.close()
  assert.equal(await reader.open('Books/Bad.epub', null), true)
  await settle()
  assert.deepEqual({ hidden: message.hidden, title: title.textContent },
    { hidden: false, title: 'This EPUB could not be opened' }, 'fixture: no error page')
  // ...until the next book's bytes arrive, before that book is parsed.
  seen.length = 0
  assert.equal(await reader.open('Books/Test.epub', null), true)
  await settle()
  assert.deepEqual({ first: seen[0], titles: seen.filter((s) => 'title' in s), shown: seen.filter((s) => s.hidden === false) },
    { first: { hidden: true, chapters: 0 }, titles: [], shown: [] },
    'the old error page stayed up while the next book was parsed, or a message showed instead')
  assert.equal(pane.querySelectorAll('.ep-chapter').length, 2)
  reader.destroy()
})

/* Resume: a fresh render is laid out but unpainted (`.ep-restoring`) until it
 * is at its bookmark.  The minidom lays every chapter out at top 0 and 27px
 * tall, so chapter 1 at offset 0.5 is scrollTop 13.5. */
const MARK = { chapter: 1, href: '', offset: 0.5, progress: 0.5 }
const AT_MARK = 13.5
const view = (scroller) => ({ concealed: scroller.classList.contains('ep-restoring'), top: scroller.scrollTop })

test('resume: a reopened book paints no frame at its top: it waits unpainted and focused, and saves nothing, until it is at its bookmark', async () => {
  const { reader, scroller, progress } = mount()
  scroller.scrollTop = 0
  assert.equal(await reader.open('Books/Test.epub', MARK), true)
  // Rendered; its two frames have not run yet.
  const waiting = { ...view(scroller), shown: !scroller.hidden, focus: document.activeElement === scroller }
  // The engine measures the shown scroller during the wait (its ResizeObserver);
  // without that, there is no position to save and the guard goes untested.
  fireWindow('resize', {})
  reader.flushProgress()
  const savedWhileWaiting = progress.length
  await settle()
  assert.deepEqual({ waiting, savedWhileWaiting, after: view(scroller) }, {
    waiting: { concealed: true, top: 0, shown: true, focus: true },
    savedWhileWaiting: 0,
    after: { concealed: false, top: AT_MARK },
  }, 'the book was painted before it reached its bookmark, or saved the top of the book meanwhile')
  reader.flushProgress()
  assert.deepEqual(progress.map(([p, pos]) => [p, pos.chapter, pos.offset]), [['Books/Test.epub', 1, 0.5]])
  reader.destroy()
})

test('resume: hidden during the wait (a tab switch), the book saves nothing, and coming back puts it at its bookmark before painting it', async () => {
  const got = {}
  // main.ts comes back by opening the same book again; show() is the API's other way.
  for (const back of ['open() again', 'show()']) {
    const { reader, scroller, progress } = mount()
    scroller.scrollTop = 0
    await reader.open('Books/Test.epub', MARK)
    fireWindow('resize', {}) // the engine's measure during the wait
    reader.hide()
    await settle()
    const hidden = { ...view(scroller), saved: progress.length }
    if (back === 'show()') reader.show()
    else assert.equal(await reader.open('Books/Test.epub', MARK), true)
    const returning = view(scroller)
    await settle()
    got[back] = { hidden, returning, after: view(scroller) }
    reader.destroy()
  }
  const want = { hidden: { concealed: true, top: 0, saved: 0 }, returning: { concealed: true, top: 0 }, after: { concealed: false, top: AT_MARK } }
  assert.deepEqual(got, { 'open() again': want, 'show()': want },
    'a book hidden before its frames ran saved its top, or came back at it, or stayed unpainted')
})

test('resume: a second click on the same book, a failed read of another, or a cancelled open during the wait still lands the book on its bookmark', async () => {
  const got = {}
  for (const leg of ['same book', 'failed read', 'cancelled open']) {
    const { reader, scroller } = mount(async (path) => {
      if (path === 'Books/Missing.epub') throw new Error('gone')
      return fixture()
    })
    scroller.scrollTop = 0
    assert.equal(await reader.open('Books/Test.epub', MARK), true)
    if (leg === 'same book') assert.equal(await reader.open('Books/Test.epub', MARK), true)
    if (leg === 'failed read') assert.equal(await reader.open('Books/Missing.epub', null), false)
    if (leg === 'cancelled open') reader.cancelOpen()
    await settle()
    got[leg] = { ...view(scroller), path: reader.path() }
    reader.destroy()
  }
  const want = { concealed: false, top: AT_MARK, path: 'Books/Test.epub' }
  assert.deepEqual(got, { 'same book': want, 'failed read': want, 'cancelled open': want },
    'a later open made the book showing skip its bookmark')
})

test('resume: a rename during the wait keys the bookmark the book was opened with, not its top', async () => {
  const { reader, scroller, progress } = mount()
  scroller.scrollTop = 0
  await reader.open('Books/Test.epub', MARK)
  reader.adoptPath('Books/Renamed.epub')
  assert.deepEqual(progress, [['Books/Renamed.epub', MARK]], 'the rename wrote the top of the book')
  await settle()
  assert.deepEqual(view(scroller), { concealed: false, top: AT_MARK })
  reader.destroy()
})

/** Run `fn` the first time the reader asks for a picture URL while
 *  `when()` holds: the picture preload, between the parse (the book has its
 *  path) and the render.  Returns a restore function. */
function duringPictures(when, fn) {
  const real = URL.createObjectURL
  let done = false
  URL.createObjectURL = (...a) => {
    if (!done && when()) { done = true; fn() }
    return real(...a)
  }
  return { fired: () => done, restore: () => { URL.createObjectURL = real } }
}

test('open: a second click on a book still loading its pictures ends with the book on screen, not a blank pane', async () => {
  const got = {}
  // First open, and the same after another book: the flag must not outlive the book it was set for.
  for (const leg of ['first book', 'after another book']) {
    const { pane, reader } = mount()
    if (leg === 'after another book') {
      assert.equal(await reader.open('Books/Other.epub', null), true)
      await settle()
    }
    let second = null
    const hook = duringPictures(
      () => reader.path() === 'Books/Test.epub' && pane.querySelectorAll('.ep-chapter').length === 0,
      () => { second = reader.open('Books/Test.epub', null) })
    let oks
    try {
      const first = await reader.open('Books/Test.epub', null)
      assert.ok(hook.fired(), `fixture (${leg}): no picture was asked for between the parse and the render`)
      oks = [first, await second]
    } finally {
      hook.restore()
    }
    await settle()
    got[leg] = { oks, path: reader.path(), visible: reader.visible(), chapters: pane.querySelectorAll('.ep-chapter').length }
    reader.destroy()
  }
  const want = { oks: [false, true], path: 'Books/Test.epub', visible: true, chapters: 2 }
  assert.deepEqual(got, { 'first book': want, 'after another book': want },
    'the second click took the open-book shortcut, and the first open then dropped the book')
})

test('open: a cancelled open that has taken the pane with nothing on it gives the pane back at once; a book or an error page stays', async () => {
  const got = {}
  for (const leg of ['first open, blank page', 'first open, pictures', 'replacing a book, pictures']) {
    const { pane, reader } = mount()
    if (leg.startsWith('replacing')) {
      assert.equal(await reader.open('Books/Other.epub', null), true)
      await settle()
    }
    const root = pane.querySelector('[id="reader"]')
    let at = null
    const cancel = () => {
      reader.cancelOpen()
      at = { visible: reader.visible(), takeover: pane.classList.contains('is-reader') }
    }
    let hook = null
    if (leg === 'first open, blank page') {
      // Right after the takeover shows the blank page, before the parse goes on.
      const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Object.getPrototypeOf(root)), 'hidden') ??
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(root), 'hidden')
      Object.defineProperty(root, 'hidden', {
        configurable: true,
        get() { return d.get.call(this) },
        set(v) { d.set.call(this, v); if (!v && at === null) queueMicrotask(cancel) },
      })
    } else {
      hook = duringPictures(
        () => reader.path() === 'Books/Test.epub' && pane.querySelectorAll('.ep-chapter').length === 0, cancel)
    }
    let ok
    try {
      ok = await reader.open('Books/Test.epub', null)
    } finally {
      hook?.restore()
    }
    await settle()
    got[leg] = { at, ok, visible: reader.visible(), path: reader.path() }
    reader.destroy()
  }
  const gone = { at: { visible: false, takeover: false }, ok: false, visible: false, path: null }
  assert.deepEqual(got, { 'first open, blank page': gone, 'first open, pictures': gone, 'replacing a book, pictures': gone },
    'a cancelled open left its empty takeover over the surface that cancelled it')

  // Controls: nothing in flight.
  const kept = {}
  for (const leg of ['a rendered book', 'an error page']) {
    const { reader } = mount(async (path) => (path === 'Books/Bad.epub' ? new ArrayBuffer(8) : fixture()))
    assert.equal(await reader.open(leg === 'an error page' ? 'Books/Bad.epub' : 'Books/Test.epub', null), true)
    await settle()
    reader.cancelOpen()
    kept[leg] = reader.visible()
    reader.destroy()
  }
  assert.deepEqual(kept, { 'a rendered book': true, 'an error page': true }, 'cancelOpen hid a surface that was not in flight')
})

test('close: hides the reader, drops the takeover class and frees the path', async () => {
  const { pane, reader } = mount()
  await reader.open('Books/Test.epub', null)
  await settle()
  reader.close()
  assert.equal(reader.visible(), false)
  assert.equal(reader.path(), null)
  assert.equal(pane.classList.contains('is-reader'), false)
  assert.equal(pane.querySelectorAll('.ep-chapter').length, 0)
  reader.destroy()
})

/* ── §0.56 E109: click-to-explain ─────────────────────────────────────────── */

const PICK_OPF = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>The Picked Book</dc:title>
    <dc:creator>A. Writer</dc:creator>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="index_split_002.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="c1"/><itemref idref="c2"/></spine>
</package>`

const PICK_NAV = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<body><nav epub:type="toc"><ol><li><a href="ch1.xhtml">The Opening</a></li></ol></nav></body></html>`

// A noteref glued to its word, both kinds of actionable link, a word split
// across spans, a soft hyphen, and a <br> inside one block.
const PICK_CH1 = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>
<h1>The Opening</h1>
<p>It was a cold day. The lizard<a epub:type="noteref" href="#n1">12</a> slept on the stone. Nobody saw it again.</p>
<p>One two three four five six seven eight nine ten eleven twelve.</p>
<p>Visit <a href="https://example.com/x">the site</a> or read <a href="index_split_002.xhtml">the next part</a> now.</p>
<p>A nee<span>dle</span> and a liz&#173;ard here.<br/>New line here.</p>
<p id="n1">12. A note.</p>
</body></html>`

// No heading and no TOC entry: its title is epub.ts's file-stem fallback.
const PICK_CH2 = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Second part text.</p></body></html>`

function pickBook(opf = PICK_OPF) {
  return zip([
    { name: 'mimetype', data: 'application/epub+zip', store: true },
    { name: 'META-INF/container.xml', data: CONTAINER },
    { name: 'OEBPS/content.opf', data: opf },
    { name: 'OEBPS/nav.xhtml', data: PICK_NAV },
    { name: 'OEBPS/ch1.xhtml', data: PICK_CH1 },
    { name: 'OEBPS/index_split_002.xhtml', data: PICK_CH2 },
  ])
}

const SHY = String.fromCharCode(0xad)

/** The passage a pick of 'cold' must send: book and chapter in front, then
 *  the sentences around it, paragraphs on their own lines, the noteref's
 *  digits and the soft hyphen gone. */
const COLD_PASSAGE =
  'The Picked Book — A. Writer\nThe Opening\n\n' +
  'The Opening\n' +
  'It was a cold day. The lizard slept on the stone. Nobody saw it again.\n' +
  'One two three four five six seven eight nine ten eleven twelve.\n' +
  'Visit the site or read the next part now.\n' +
  'A needle and a lizard here.'

/** The injected probe's layout.  Every text node in the book is one line,
 *  20px tall, in document order from `top`; every UTF-16 unit is 10px wide.
 *  A caret snaps to the nearest character boundary and clamps to its line,
 *  as the engine's does in a margin. */
function fakeLayout(pane) {
  const nodes = () => {
    const out = []
    const walk = (n) => { for (const c of n.childNodes) { if (c.nodeType === 3) out.push(c); else walk(c) } }
    const content = pane.querySelector('.ep-content')
    if (content) walk(content)
    return out
  }
  const layout = {
    top: 0,
    caretAt(x, y) {
      const node = nodes()[Math.floor((y - layout.top) / 20)]
      if (!node) return null
      return { node, offset: Math.max(0, Math.min(node.data.length, Math.round(x / 10))) }
    },
    rectsOf(start, end) {
      const all = nodes()
      const a = all.indexOf(start.node)
      const b = all.indexOf(end.node)
      const out = []
      for (let i = a; i >= 0 && i <= b; i++) {
        const from = i === a ? start.offset : 0
        const to = i === b ? end.offset : all[i].data.length
        out.push({ left: from * 10, right: to * 10, top: layout.top + i * 20, bottom: layout.top + i * 20 + 18 })
      }
      return out
    },
    /** A point on character `char` of the first `text` in the book: its left
     *  half, or its right half with `right`. */
    at(text, { char = 0, right = false } = {}) {
      const all = nodes()
      const i = all.findIndex((n) => n.data.includes(text))
      assert.ok(i >= 0, 'no text node holds ' + JSON.stringify(text))
      const col = all[i].data.indexOf(text) + char
      return { x: col * 10 + (right ? 7 : 3), y: layout.top + i * 20 + 5 }
    },
    /** The text a painted Range covers. */
    textOf(range) {
      const all = nodes()
      const a = all.indexOf(range.startContainer)
      const b = all.indexOf(range.endContainer)
      let out = ''
      for (let i = a; i >= 0 && i <= b; i++) {
        out += all[i].data.slice(i === a ? range.startOffset : 0, i === b ? range.endOffset : undefined)
      }
      return out
    },
  }
  return layout
}

/** A stand-in for explain.ts's band that records what the reader asks of it.
 *  It keeps explain-types.ts's seam: a pick STARTS on a band that holds no
 *  answer and is STAGED on one that does; `place()` is a trusted click on a
 *  half. */
function fakeBand() {
  const band = {
    asks: [], closes: 0, relayouts: 0, destroyed: 0, open: false, hooks: null, el: null,
    /** The band holds an answer (a round, a stream or an error line). */
    content: false,
    staged: null, stages: 0, cancels: 0, placed: [],
  }
  band.mountExplain = (host, hooks) => {
    band.hooks = hooks
    band.el = host.ownerDocument.createElement('div')
    band.el.className = 'ep-explain'
    band.el.hidden = true
    host.append(band.el)
    return {
      explain(req) {
        band.asks.push(req)
        if (band.open && band.content) {
          band.staged = req
          band.stages++
          return 'staged'
        }
        band.staged = null
        band.open = true
        band.content = true
        band.el.hidden = false
        return 'started'
      },
      cancelStaged() {
        if (band.staged === null) return false
        band.staged = null
        band.cancels++
        return true
      },
      isStaged: () => band.staged !== null,
      close() {
        if (!band.open) return
        band.open = false
        band.content = false
        band.staged = null
        band.el.hidden = true
        band.closes++
        hooks.onClosed()
      },
      isOpen: () => band.open,
      element: () => band.el,
      relayout() { band.relayouts++ },
      destroy() { band.destroyed++; band.el.remove() },
    }
  }
  band.place = () => {
    assert.ok(band.staged, 'nothing is staged to place')
    band.placed.push(band.staged)
    band.staged = null
    band.hooks.onPlaced()
  }
  return band
}

async function mountPick(readEpub = async () => pickBook(), extra = {}) {
  const pane = document.createElement('main')
  pane.className = 'editor'
  const layout = fakeLayout(pane)
  const band = fakeBand()
  const errors = []
  const reader = R.mountReader(pane, {
    transport: { readEpub, openExternal: async () => {} },
    onProgress: () => {},
    onError: (err, ctx) => errors.push([ctx, err]),
    mountExplain: band.mountExplain,
    probe: layout,
    ...extra,
  })
  assert.equal(await reader.open('Books/Picked.epub', null), true)
  await settle()
  return {
    pane, reader, layout, band, errors,
    root: pane.querySelector('[id="reader"]'),
    content: pane.querySelector('.ep-content'),
    scroller: pane.querySelector('.ep-scroller'),
  }
}

function mouse(type, at, extra = {}) {
  return {
    type, isTrusted: true, button: 0, buttons: 0, detail: 1,
    clientX: at.x, clientY: at.y,
    ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
    defaultPrevented: false, propagationStopped: false,
    preventDefault() { this.defaultPrevented = true },
    stopPropagation() { this.propagationStopped = true },
    ...extra,
  }
}

/** Press at `from`, drag to `to` if given, release, and deliver the click the
 *  engine sends after the release. */
async function gesture(t, from, to = null, extra = {}) {
  const down = mouse('mousedown', from, { buttons: 1, ...extra })
  t.content.dispatch('mousedown', down)
  if (to) {
    t.scroller.dispatch('mousemove', mouse('mousemove', to, { buttons: 1 }))
    await settle()
  }
  fireWindow('mouseup', mouse('mouseup', to ?? from, extra))
  const click = mouse('click', to ?? from, { target: t.content, ...extra })
  fireDocument('click', click)
  return { down, click }
}

const painted = (t, name) => {
  const h = globalThis.CSS.highlights.get(name)
  return h ? t.layout.textOf(h.ranges[0]) : null
}
const marked = (t) => painted(t, 'cairn-explain-mark')
const hovered = (t) => painted(t, 'cairn-explain-hover')

function findQuery(t, query) {
  t.root.dispatch('keydown', {
    key: 'f', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false,
    preventDefault() {},
  })
  const input = t.pane.querySelector('.find-input')
  input.value = query
  input.dispatch('input', {})
  return input
}

test('explain: a press on a word asks about it, with its chapter passage', async () => {
  const t = await mountPick()
  try {
    assert.equal(t.band.el.parentNode, t.root, 'the band is mounted inside #reader')
    // Focus elsewhere (the band, say): the press must hand it to the book.
    document.activeElement = t.band.el
    const { down, click } = await gesture(t, t.layout.at('cold'))
    assert.equal(down.defaultPrevented, true, 'no native selection or focus move')
    assert.equal(document.activeElement, t.scroller, 'the book keeps the keyboard')
    assert.equal(t.band.asks.length, 1)
    assert.deepEqual(t.band.asks[0].items, [{ phrase: 'cold', words: ['cold'] }])
    assert.equal(t.band.asks[0].text, COLD_PASSAGE)
    assert.equal(marked(t), 'cold')
    assert.equal(t.band.open, true)
    assert.equal(click.defaultPrevented, true, 'the trailing click is swallowed')
    assert.equal(click.propagationStopped, true)
    assert.equal(t.band.closes, 0, 'and it is not an outside click')
  } finally {
    t.reader.destroy()
  }
})

test("explain: a word's last-letter right half picks it; a margin or a gap does not", async () => {
  const t = await mountPick()
  try {
    await gesture(t, t.layout.at('cold', { char: 3, right: true }))
    assert.deepEqual(t.band.asks.map((a) => a.items[0].phrase), ['cold'])
    // A margin: the caret still snaps to the line's last word.
    const margin = await gesture(t, { x: 5000, y: t.layout.at('cold').y })
    assert.equal(margin.down.defaultPrevented, false)
    // The right half of the space before 'cold': 3px off the word.
    const gap = await gesture(t, t.layout.at('a cold', { char: 1, right: true }))
    assert.equal(gap.down.defaultPrevented, false)
    assert.equal(t.band.asks.length, 1)
  } finally {
    t.reader.destroy()
  }
})

test('explain: links stay links, and a noteref does not glue onto its word', async () => {
  const t = await mountPick()
  try {
    for (const text of ['the site', 'the next part', '12']) {
      const { down } = await gesture(t, t.layout.at(text, { char: text.length - 1 }))
      assert.equal(down.defaultPrevented, false, text + ' is a link press')
    }
    assert.equal(t.band.asks.length, 0)
    t.scroller.dispatch('mousemove', mouse('mousemove', t.layout.at('the site')))
    await settle()
    assert.equal(t.content.classList.contains('ex-over-word'), false)
    await gesture(t, t.layout.at('lizard', { char: 5, right: true }))
    assert.deepEqual(t.band.asks[0].items, [{ phrase: 'lizard', words: ['lizard'] }])
    assert.equal(marked(t), 'lizard')
  } finally {
    t.reader.destroy()
  }
})

test('explain: a drag picks a phrase, clamped at 8 words either way', async () => {
  const t = await mountPick()
  try {
    await gesture(t, t.layout.at('One'), t.layout.at('twelve'))
    await gesture(t, t.layout.at('twelve'), t.layout.at('One'))
    assert.deepEqual(t.band.asks.map((a) => a.items), [
      [{ phrase: 'One two three four five six seven eight',
         words: ['One', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'] }],
      [{ phrase: 'five six seven eight nine ten eleven twelve',
         words: ['five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'] }],
    ])
    assert.equal(marked(t), 'five six seven eight nine ten eleven twelve')
  } finally {
    t.reader.destroy()
  }
})

test('explain: a drag never crosses a block, a line break or a link', async () => {
  const t = await mountPick()
  try {
    const at = (s) => t.layout.at(s)
    await gesture(t, at('Nobody'), at('One'))
    await gesture(t, at('and a'), at('New'))
    await gesture(t, at('Visit'), at('now'))
    // Across a noteref is fine: its digits are not in the passage either.
    await gesture(t, at('lizard'), at('slept'))
    // Across spans and a soft hyphen: one word each, the hyphen dropped.
    await gesture(t, at('nee'), at('and a'))
    await gesture(t, at('and a'), at('here.'))
    assert.deepEqual(t.band.asks.map((a) => a.items[0].phrase), [
      'Nobody', 'and', 'Visit', 'lizard slept', 'needle and', 'and a lizard here',
    ])
    assert.deepEqual(t.band.asks[5].items[0].words, ['and', 'a', 'lizard', 'here'])
    assert.equal(marked(t), 'and a liz' + SHY + 'ard here')
    assert.ok(t.band.asks[3].text.includes('The lizard slept on the stone.'))
  } finally {
    t.reader.destroy()
  }
})

test('explain: the trailing click is swallowed once; the next outside click closes', async () => {
  const t = await mountPick()
  try {
    await gesture(t, t.layout.at('cold'))
    assert.equal(t.band.open, true)
    const outside = mouse('click', t.layout.at('stone'), { target: t.content })
    fireDocument('click', outside)
    assert.equal(outside.defaultPrevented, false, 'an outside click is never consumed')
    assert.equal(t.band.open, false)
    assert.equal(t.band.closes, 1)
    assert.equal(marked(t), null)
  } finally {
    t.reader.destroy()
  }
})

test('explain: clicks inside the band, inside a menu, or untrusted do not close', async () => {
  const t = await mountPick()
  try {
    await gesture(t, t.layout.at('cold'))
    const inner = document.createElement('span')
    t.band.el.append(inner)
    const menu = document.createElement('div')
    menu.className = 'ctx-menu'
    const item = document.createElement('div')
    menu.append(item)
    for (const ev of [
      mouse('click', { x: 0, y: 0 }, { target: inner }),
      mouse('click', { x: 0, y: 0 }, { target: item }),
      mouse('click', { x: 0, y: 0 }, { target: t.content, isTrusted: false }),
    ]) {
      fireDocument('click', ev)
      assert.equal(t.band.open, true)
    }
    assert.equal(t.band.closes, 0)
    assert.equal(marked(t), 'cold')
  } finally {
    t.reader.destroy()
  }
})

test('explain: a double-click sends one request and keeps the answer up', async () => {
  const t = await mountPick()
  try {
    await gesture(t, t.layout.at('cold'))
    const second = await gesture(t, t.layout.at('cold'), null, { detail: 2 })
    assert.equal(second.down.defaultPrevented, true)
    assert.equal(second.click.defaultPrevented, true, 'its click is the gesture\'s too')
    assert.equal(t.band.asks.length, 1)
    assert.equal(t.band.open, true)
    assert.equal(marked(t), 'cold')
  } finally {
    t.reader.destroy()
  }
})

test("explain: modified, non-left and untrusted presses are the page's own", async () => {
  const t = await mountPick()
  try {
    for (const extra of [
      { ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true },
      { button: 1 }, { button: 2 }, { isTrusted: false },
    ]) {
      const down = mouse('mousedown', t.layout.at('cold'), extra)
      t.content.dispatch('mousedown', down)
      fireWindow('mouseup', mouse('mouseup', t.layout.at('cold'), extra))
      assert.equal(down.defaultPrevented, false, JSON.stringify(extra))
    }
    assert.equal(t.band.asks.length, 0)
    assert.equal(marked(t), null)
  } finally {
    t.reader.destroy()
  }
})

test('explain: Esc closes the find bar first, then the band', async () => {
  const t = await mountPick()
  try {
    findQuery(t, '')
    const bar = t.pane.querySelector('.find-bar')
    assert.equal(bar.hidden, false)
    await gesture(t, t.layout.at('cold'))
    const esc = () => {
      const ev = { key: 'Escape', defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
      t.root.dispatch('keydown', ev)
      return ev
    }
    assert.equal(esc().defaultPrevented, true)
    assert.equal(bar.hidden, true)
    assert.equal(t.band.open, true, 'one Esc, one layer')
    document.activeElement = t.band.el
    assert.equal(esc().defaultPrevented, true)
    assert.equal(t.band.open, false)
    assert.equal(marked(t), null)
    assert.equal(document.activeElement, t.scroller, 'focus leaves the hidden band for the book')
    assert.equal(esc().defaultPrevented, false, 'nothing left to close')
  } finally {
    t.reader.destroy()
  }
})

test('explain: hide, close and opening another book close the band', async () => {
  const t = await mountPick()
  try {
    await gesture(t, t.layout.at('cold'))
    t.reader.hide()
    assert.equal(t.band.open, false)
    assert.equal(marked(t), null)
    t.reader.show()
    await settle()
    await gesture(t, t.layout.at('cold'))
    t.reader.close()
    assert.equal(t.band.open, false)
    assert.equal(await t.reader.open('Books/Picked.epub', null), true)
    await settle()
    await gesture(t, t.layout.at('cold'))
    assert.equal(await t.reader.open('Books/Other.epub', null), true)
    await settle()
    assert.equal(t.band.open, false)
    assert.equal(t.band.closes, 3)
    assert.equal(t.band.asks.length, 3)
  } finally {
    t.reader.destroy()
  }
  assert.equal(t.band.destroyed, 1)
})

test('explain: find painting drops the mark and keeps the answer', async () => {
  const t = await mountPick()
  try {
    await gesture(t, t.layout.at('cold'))
    assert.equal(marked(t), 'cold')
    findQuery(t, 'stone')
    assert.equal(t.pane.querySelectorAll('mark.cm-find-match').length, 1)
    assert.equal(marked(t), null)
    assert.equal(t.band.open, true)
  } finally {
    t.reader.destroy()
  }
})

test("explain: the passage is walked fresh after find split the text nodes", async () => {
  const t = await mountPick()
  try {
    const input = findQuery(t, 'cold')
    input.dispatch('keydown', { key: 'Escape', preventDefault() {} })
    await settle()
    // The mark is gone but its text is a node of its own now.
    assert.ok(t.layout.at('cold'))
    await gesture(t, t.layout.at('cold'))
    assert.equal(t.band.asks[0].text, COLD_PASSAGE)
    assert.equal(marked(t), 'cold')
  } finally {
    t.reader.destroy()
  }
})

test('explain: the word under the pointer lights up', async () => {
  const t = await mountPick()
  try {
    t.scroller.dispatch('mousemove', mouse('mousemove', t.layout.at('stone')))
    await settle()
    assert.equal(t.content.classList.contains('ex-over-word'), true)
    assert.equal(hovered(t), 'stone')
    t.scroller.dispatch('mousemove', mouse('mousemove', { x: 5000, y: t.layout.at('stone').y }))
    await settle()
    assert.equal(t.content.classList.contains('ex-over-word'), false)
    assert.equal(hovered(t), null)
    t.scroller.dispatch('mousemove', mouse('mousemove', t.layout.at('stone')))
    await settle()
    t.scroller.dispatch('mouseleave', {})
    assert.equal(hovered(t), null)
    assert.equal(t.content.classList.contains('ex-over-word'), false)
  } finally {
    t.reader.destroy()
  }
})

test('explain: onShown scrolls a mark the band covers clear of it, once', async () => {
  const t = await mountPick()
  try {
    // The scroller is 500px tall from viewport y 0 in this layout, and the
    // band holds the 320px under it.
    t.root.getBoundingClientRect = () => ({ left: 0, top: 0, right: 409, bottom: 820, width: 409, height: 820 })
    t.layout.top = 600
    const p = t.layout.at('cold')
    await gesture(t, p)
    const bottom = p.y - 5 + 18
    t.band.hooks.onShown()
    await settle()
    assert.equal(t.scroller.scrollTop, Math.ceil(bottom - (500 - 12)))
    t.layout.top = 0
    const before = t.scroller.scrollTop
    t.band.hooks.onShown()
    await settle()
    assert.equal(t.scroller.scrollTop, before, 'a mark already clear does not move the book')
  } finally {
    t.reader.destroy()
  }
})

test('explain: a band resize never pulls the book back to a mark the reader scrolled away from', async () => {
  const t = await mountPick()
  try {
    t.root.getBoundingClientRect = () => ({ left: 0, top: 0, right: 409, bottom: 820, width: 409, height: 820 })
    await gesture(t, t.layout.at('cold'))
    // The reader scrolled up: the mark is now far below the band.
    t.layout.top = 3000
    t.scroller.scrollTop = 40
    t.band.hooks.onShown()
    await settle()
    assert.equal(t.scroller.scrollTop, 40)
  } finally {
    t.reader.destroy()
  }
})

test('explain: a hover frame still pending at the press does not cancel the pick', async () => {
  const t = await mountPick()
  try {
    // The engine flushes the last hover move right before the press: both
    // land in one frame, and the frame runs before the release.
    const at = t.layout.at('cold')
    t.scroller.dispatch('mousemove', mouse('mousemove', at, { buttons: 0 }))
    t.content.dispatch('mousedown', mouse('mousedown', at, { buttons: 1 }))
    await settle()
    fireWindow('mouseup', mouse('mouseup', at))
    const click = mouse('click', at, { target: t.content })
    fireDocument('click', click)
    assert.deepEqual(t.band.asks.map((a) => a.items[0].phrase), ['cold'])
    assert.equal(click.defaultPrevented, true)
    // The same race with the band open on another word keeps it open.
    const stone = t.layout.at('stone')
    t.scroller.dispatch('mousemove', mouse('mousemove', stone, { buttons: 0 }))
    t.content.dispatch('mousedown', mouse('mousedown', stone, { buttons: 1 }))
    await settle()
    fireWindow('mouseup', mouse('mouseup', stone))
    fireDocument('click', mouse('click', stone, { target: t.content }))
    assert.deepEqual(t.band.asks.map((a) => a.items[0].phrase), ['cold', 'stone'])
    assert.equal(t.band.open, true)
    assert.equal(t.band.closes, 0)
  } finally {
    t.reader.destroy()
  }
})

test('explain: a re-click after a miss asks, even when the engine counts it as a double-click', async () => {
  const t = await mountPick()
  try {
    const miss = await gesture(t, { x: 5000, y: t.layout.at('cold').y })
    assert.equal(miss.down.defaultPrevented, false)
    await gesture(t, t.layout.at('cold'), null, { detail: 2 })
    assert.deepEqual(t.band.asks.map((a) => a.items[0].phrase), ['cold'])
    // A double-click on the word itself still asks once.
    await gesture(t, t.layout.at('stone'), null, { detail: 1 })
    await gesture(t, t.layout.at('stone'), null, { detail: 2 })
    await gesture(t, t.layout.at('stone'), null, { detail: 3 })
    assert.deepEqual(t.band.asks.map((a) => a.items[0].phrase), ['cold', 'stone'])
  } finally {
    t.reader.destroy()
  }
})

test('explain: the chapter line is the heading the pick sits under, not the spine file\'s first title', async () => {
  const opf = PICK_OPF.replace('<item id="c2"', '<item id="c3" href="two.xhtml" media-type="application/xhtml+xml"/><item id="c2"')
    .replace('<spine>', '<spine><itemref idref="c3"/>')
  const nav = PICK_NAV.replace('<ol>', '<ol><li><a href="two.xhtml#c1">Chapter I. The Ball</a></li><li><a href="two.xhtml#c5">Chapter V. The Visit</a></li>')
  const two = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body>
<h2 id="c1">I</h2><p>The dancers turned.</p>
<h2 id="c5">Chapter V. The Visit</h2><p>A walrus came to tea.</p>
</body></html>`
  const book = () => zip([
    { name: 'mimetype', data: 'application/epub+zip', store: true },
    { name: 'META-INF/container.xml', data: CONTAINER },
    { name: 'OEBPS/content.opf', data: opf },
    { name: 'OEBPS/nav.xhtml', data: nav },
    { name: 'OEBPS/two.xhtml', data: two },
    { name: 'OEBPS/ch1.xhtml', data: PICK_CH1 },
    { name: 'OEBPS/index_split_002.xhtml', data: PICK_CH2 },
  ])
  const t = await mountPick(async () => book())
  try {
    await gesture(t, t.layout.at('walrus'))
    assert.equal(t.band.asks[0].text.split('\n')[1], 'Chapter V. The Visit')
    await gesture(t, t.layout.at('dancers'))
    assert.equal(t.band.asks[1].text.split('\n')[1], 'Chapter I. The Ball', 'a bare "I" is said better by the title that holds it')
  } finally {
    t.reader.destroy()
  }
})

test('explain: a window resize re-clamps the band', async () => {
  const t = await mountPick()
  try {
    fireWindow('resize', {})
    assert.equal(t.band.relayouts, 1)
  } finally {
    t.reader.destroy()
  }
})

test('explain: a file-named chapter and an untitled book are not sent as orientation', async () => {
  const untitled = PICK_OPF.replace('<dc:title>The Picked Book</dc:title>', '')
  const t = await mountPick(async (path) => (path === 'Books/Untitled.epub' ? pickBook(untitled) : pickBook()))
  try {
    await gesture(t, t.layout.at('Second'))
    assert.equal(t.band.asks[0].text, 'The Picked Book — A. Writer\n\nSecond part text.')
    assert.equal(await t.reader.open('Books/Untitled.epub', null), true)
    await settle()
    await gesture(t, t.layout.at('Second'))
    assert.equal(t.band.asks[1].text, 'A. Writer\n\nSecond part text.')
  } finally {
    t.reader.destroy()
  }
})

test('explain: no mountExplain, no picking; destroy removes every listener', async () => {
  const clicks = (document.listeners.get('click') ?? []).length
  const ups = (winListeners.get('mouseup') ?? []).length
  const downs = (document.listeners.get('pointerdown') ?? []).length
  const { pane, reader } = mount()
  await reader.open('Books/Test.epub', null)
  await settle()
  // The find bar's own press listener; the reader adds one only with a band.
  const findDowns = (document.listeners.get('pointerdown') ?? []).length - downs
  assert.equal((document.listeners.get('click') ?? []).length, clicks)
  assert.equal((winListeners.get('mouseup') ?? []).length, ups)
  assert.equal(pane.querySelectorAll('.ep-explain').length, 0)
  reader.destroy()
  assert.equal((document.listeners.get('pointerdown') ?? []).length, downs)

  const t = await mountPick()
  assert.equal((document.listeners.get('click') ?? []).length, clicks + 1)
  assert.equal((document.listeners.get('pointerdown') ?? []).length, downs + findDowns + 1)
  assert.equal((winListeners.get('mouseup') ?? []).length, ups + 1)
  t.reader.destroy()
  assert.equal((document.listeners.get('click') ?? []).length, clicks)
  assert.equal((document.listeners.get('pointerdown') ?? []).length, downs)
  assert.equal((winListeners.get('mouseup') ?? []).length, ups)
  assert.equal(t.band.destroyed, 1)
})

/* ── §0.57 E110: a pick on a band that holds an answer waits for a half ───── */

function esc(t, extra = {}) {
  const ev = {
    key: 'Escape', repeat: false, defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true },
    ...extra,
  }
  t.root.dispatch('keydown', ev)
  return ev
}

/** A press on `word` whose release the engine never delivered: the next move
 *  says no button is held. */
async function lostRelease(t, word) {
  const at = t.layout.at(word)
  t.content.dispatch('mousedown', mouse('mousedown', at, { buttons: 1 }))
  assert.equal(marked(t), word, 'the press marks its own word first')
  t.scroller.dispatch('mousemove', mouse('mousemove', at, { buttons: 0 }))
  await settle()
}

/** The onShown layout: the 500px scroller starts at viewport y 0, the band
 *  holds the 320px under it, and the book's lines start at y 600. */
function bandGeometry(t) {
  t.root.getBoundingClientRect = () => ({ left: 0, top: 0, right: 409, bottom: 820, width: 409, height: 820 })
  t.layout.top = 600
}
/** How far onShown scrolls a book at the top for the mark on `word`. */
const revealOf = (t, word) => Math.ceil(t.layout.at(word).y - 5 + 18 - (500 - 12))
async function revealed(t) {
  t.scroller.scrollTop = 0
  t.band.hooks.onShown()
  await settle()
  return t.scroller.scrollTop
}

test('split: a pick on a band with an answer is staged; the mark moves to it and shown stays', async () => {
  const t = await mountPick()
  try {
    bandGeometry(t)
    assert.notEqual(revealOf(t, 'cold'), revealOf(t, 'stone'), 'the two words sit on different lines')
    await gesture(t, t.layout.at('cold'))
    assert.equal(t.band.staged, null, 'an empty band starts')
    await gesture(t, t.layout.at('stone'))
    assert.equal(t.band.staged?.items[0].phrase, 'stone')
    assert.equal(t.band.open, true)
    assert.equal(marked(t), 'stone', 'the staged word is the one marked')
    assert.equal(await revealed(t), revealOf(t, 'cold'), 'shown is still the answered word')
    // A newer pick replaces the staged one; shown still does not move.
    await gesture(t, t.layout.at('One'))
    assert.equal(t.band.staged?.items[0].phrase, 'One')
    assert.equal(marked(t), 'One')
    assert.equal(await revealed(t), revealOf(t, 'cold'))
    assert.equal(t.band.closes, 0)
  } finally {
    t.reader.destroy()
  }
})

test('split: placing the staged pick makes it the shown one', async () => {
  const t = await mountPick()
  try {
    bandGeometry(t)
    await gesture(t, t.layout.at('cold'))
    await gesture(t, t.layout.at('stone'))
    t.band.place()
    assert.equal(marked(t), 'stone')
    assert.equal(await revealed(t), revealOf(t, 'stone'))
    await lostRelease(t, 'lizard')
    assert.equal(marked(t), 'stone', 'an abandoned drag goes back to the placed word')
    // Nothing is staged any more, so one Esc closes the band.
    assert.equal(esc(t).defaultPrevented, true)
    assert.equal(t.band.open, false)
    assert.equal(t.band.cancels, 0)
  } finally {
    t.reader.destroy()
  }
})

test('split: Esc drops a staged pick and puts the mark back on shown; the next Esc closes', async () => {
  const t = await mountPick()
  try {
    await gesture(t, t.layout.at('cold'))
    await gesture(t, t.layout.at('stone'))
    assert.equal(esc(t).defaultPrevented, true)
    assert.equal(t.band.staged, null)
    assert.equal(t.band.cancels, 1)
    assert.equal(t.band.open, true, 'one Esc, one layer')
    assert.equal(marked(t), 'cold', 'the mark goes back to the answered word')
    await lostRelease(t, 'lizard')
    assert.equal(marked(t), 'cold', 'the dropped word is forgotten')
    assert.equal(esc(t).defaultPrevented, true)
    assert.equal(t.band.open, false)
    assert.equal(t.band.closes, 1)
    assert.equal(marked(t), null)
    assert.equal(esc(t).defaultPrevented, false, 'nothing left to close')
    assert.equal(t.band.placed.length, 0, 'Esc never places')
  } finally {
    t.reader.destroy()
  }
})

test('split: a held Esc acts once; its repeats reach no further layer', async () => {
  const t = await mountPick()
  try {
    findQuery(t, '')
    const bar = t.pane.querySelector('.find-bar')
    await gesture(t, t.layout.at('cold'))
    await gesture(t, t.layout.at('stone'))
    esc(t)
    assert.equal(bar.hidden, true)
    for (let i = 0; i < 3; i++) esc(t, { repeat: true })
    assert.equal(t.band.cancels, 0, 'the stage outlives the repeats')
    assert.equal(t.band.staged?.items[0].phrase, 'stone')
    assert.equal(marked(t), 'stone')
    esc(t)
    assert.equal(t.band.cancels, 1)
    assert.equal(marked(t), 'cold')
    for (let i = 0; i < 3; i++) esc(t, { repeat: true })
    assert.equal(t.band.open, true, 'the band outlives the repeats')
    esc(t)
    assert.equal(t.band.open, false)
  } finally {
    t.reader.destroy()
  }
})

test('split: an outside click while staged closes the band and forgets both picks', async () => {
  const t = await mountPick()
  try {
    bandGeometry(t)
    await gesture(t, t.layout.at('cold'))
    await gesture(t, t.layout.at('stone'))
    const outside = mouse('click', t.layout.at('Nobody'), { target: t.content })
    fireDocument('click', outside)
    assert.equal(outside.defaultPrevented, false)
    assert.equal(t.band.open, false)
    assert.equal(t.band.staged, null)
    assert.equal(t.band.closes, 1)
    assert.equal(marked(t), null)
    await lostRelease(t, 'lizard')
    assert.equal(marked(t), null, 'neither the staged nor the shown word comes back')
    assert.equal(await revealed(t), 0)
  } finally {
    t.reader.destroy()
  }
})

test('split: a drag whose release was lost puts the mark back on the staged word', async () => {
  const t = await mountPick()
  try {
    await gesture(t, t.layout.at('cold'))
    await gesture(t, t.layout.at('stone'))
    await lostRelease(t, 'lizard')
    assert.equal(marked(t), 'stone')
    assert.equal(t.band.staged?.items[0].phrase, 'stone', 'an abandoned drag asks nothing')
    assert.equal(t.band.asks.length, 2)
  } finally {
    t.reader.destroy()
  }
})

test('split: a double-click on a closed band asks once and stages nothing', async () => {
  const t = await mountPick()
  try {
    await gesture(t, t.layout.at('cold'))
    const second = await gesture(t, t.layout.at('cold'), null, { detail: 2 })
    assert.equal(second.down.defaultPrevented, true)
    assert.equal(t.band.asks.length, 1)
    assert.equal(t.band.stages, 0)
    assert.equal(t.band.staged, null)
    assert.equal(marked(t), 'cold')
  } finally {
    t.reader.destroy()
  }
})

test('split: the reveal follows shown, never the staged word', async () => {
  const t = await mountPick()
  try {
    bandGeometry(t)
    await gesture(t, t.layout.at('cold'))
    assert.equal(await revealed(t), revealOf(t, 'cold'))
    await gesture(t, t.layout.at('stone'))
    assert.equal(await revealed(t), revealOf(t, 'cold'), 'staged')
    t.band.place()
    assert.equal(await revealed(t), revealOf(t, 'stone'), 'placed')
    await gesture(t, t.layout.at('cold'))
    assert.equal(await revealed(t), revealOf(t, 'stone'), 'staged again')
    esc(t)
    assert.equal(await revealed(t), revealOf(t, 'stone'), 'dropped')
  } finally {
    t.reader.destroy()
  }
})

test('split: find painting while staged drops both marks and leaves the stage to the band', async () => {
  const t = await mountPick()
  try {
    await gesture(t, t.layout.at('cold'))
    await gesture(t, t.layout.at('stone'))
    findQuery(t, 'Nobody')
    assert.equal(t.pane.querySelectorAll('mark.cm-find-match').length, 1)
    assert.equal(marked(t), null)
    assert.equal(t.band.staged?.items[0].phrase, 'stone')
    // Find split the staged word's text node: its old Range must not come back.
    await lostRelease(t, 'lizard')
    assert.equal(marked(t), null)
    t.band.place()
    await lostRelease(t, 'lizard')
    assert.equal(marked(t), null)
  } finally {
    t.reader.destroy()
  }
})

test('split: a press on the band released over the book is no outside click; a press outside still closes', async () => {
  const t = await mountPick()
  const press = (target, extra = {}) =>
    fireDocument('pointerdown', mouse('pointerdown', { x: 0, y: 0 }, { target, buttons: 1, ...extra }))
  const click = (target, extra = {}) => {
    const ev = mouse('click', { x: 0, y: 0 }, { target, ...extra })
    fireDocument('click', ev)
    return ev
  }
  try {
    await gesture(t, t.layout.at('cold'))
    await gesture(t, t.layout.at('stone'))
    const half = document.createElement('div')
    t.band.el.append(half)
    // The engine aims a press-drag-release's click at the common ancestor:
    // pressed on a half and released over the book, it lands on #reader.
    press(half)
    const slid = click(t.root)
    assert.equal(slid.defaultPrevented, false, 'never consumed')
    assert.equal(t.band.open, true, 'the band stays')
    assert.equal(t.band.staged?.items[0].phrase, 'stone', 'and so does the stage')
    assert.equal(marked(t), 'stone')
    // The flag belongs to that one click: a later click with no press of its
    // own is judged on its target.
    press(half)
    click(half)
    click(t.root)
    assert.equal(t.band.open, false, 'a used press protects nothing')
    // A keyboard click (detail 0) is no press's click.
    await gesture(t, t.layout.at('cold'))
    press(half)
    click(t.content, { detail: 0 })
    assert.equal(t.band.open, false, 'a keyboard click outside still closes')
    // A script's press, or a right or middle press, on the band is no left
    // click's press.
    for (const extra of [{ isTrusted: false }, { button: 2, buttons: 2 }, { button: 1, buttons: 4 }]) {
      await gesture(t, t.layout.at('cold'))
      press(half, extra)
      click(t.root)
      assert.equal(t.band.open, false, `a ${JSON.stringify(extra)} press protects nothing`)
    }
    // A band press whose click the band itself swallows (a drill-down) leaves
    // nothing behind: the next press, here the sidebar grip's, starts afresh.
    await gesture(t, t.layout.at('cold'))
    press(half)
    const grip = document.createElement('div')
    t.pane.append(grip)
    press(grip)
    click(grip)
    assert.equal(t.band.open, false, 'a grip click after a drill-down closes, as after any band press')
    // A press in a layer (the find bar, a menu) slid off over the book is
    // that layer's click.
    for (const cls of ['find-bar', 'ctx-menu']) {
      await gesture(t, t.layout.at('cold'))
      const layer = document.createElement('div')
      layer.className = cls
      const inner = document.createElement('span')
      layer.append(inner)
      t.pane.append(layer)
      press(inner)
      click(t.root)
      assert.equal(t.band.open, true, `a press in .${cls} slid off keeps the band`)
      layer.remove()
      press(t.content)
      click(t.root)
      assert.equal(t.band.open, false)
    }
    // A press that began outside the band: the same click closes.
    await gesture(t, t.layout.at('cold'))
    assert.equal(t.band.open, true)
    press(t.content)
    click(t.root)
    assert.equal(t.band.open, false)
  } finally {
    t.reader.destroy()
  }
})

test('split: Esc during the second press of a double-click puts the mark back on shown; a firing drag keeps it', async () => {
  const t = await mountPick()
  try {
    await gesture(t, t.layout.at('cold'))
    await gesture(t, t.layout.at('stone'))
    assert.equal(marked(t), 'stone')
    // The double-click's second press asks nothing and paints nothing.
    t.content.dispatch('mousedown', mouse('mousedown', t.layout.at('stone'), { buttons: 1, detail: 2 }))
    esc(t)
    assert.equal(t.band.cancels, 1)
    assert.equal(marked(t), 'cold', 'the dropped word is not left marked')
    fireWindow('mouseup', mouse('mouseup', t.layout.at('stone'), { detail: 2 }))
    fireDocument('click', mouse('click', t.layout.at('stone'), { target: t.content, detail: 2 }))
    assert.equal(marked(t), 'cold')
    assert.equal(t.band.asks.length, 2)
    assert.equal(t.band.staged, null)
    // A drag that will ask owns the mark until it ends.
    await gesture(t, t.layout.at('stone'))
    t.content.dispatch('mousedown', mouse('mousedown', t.layout.at('lizard'), { buttons: 1 }))
    esc(t)
    assert.equal(t.band.cancels, 2)
    assert.equal(marked(t), 'lizard')
    fireWindow('mouseup', mouse('mouseup', t.layout.at('lizard')))
    assert.equal(t.band.staged?.items[0].phrase, 'lizard')
    assert.equal(marked(t), 'lizard')
  } finally {
    t.reader.destroy()
  }
})

/* ── §0.58 E111: the reader's microphone ──────────────────────────────────── */

/** A stand-in for mic.ts's mount: it records what the reader asks of it, its
 *  card's openness is set by the test, and its two body-level roots are
 *  `.ep-mic` (the button) and `.ep-mic-layer` (shield + card). */
function fakeMic() {
  const mic = { mounts: 0, shown: [], leaves: 0, destroyed: 0, host: null, hooks: null, card: false }
  mic.root = document.createElement('section')
  mic.root.className = 'ep-mic'
  mic.btn = document.createElement('button')
  mic.root.append(mic.btn)
  mic.layer = document.createElement('div')
  mic.layer.className = 'ep-mic-layer'
  mic.shield = document.createElement('div')
  mic.layer.append(mic.shield)
  mic.mountMic = (host, hooks) => {
    mic.mounts++
    mic.host = host
    mic.hooks = hooks
    return {
      setShown: (on) => { mic.shown.push(on) },
      leave: () => { mic.leaves++ },
      cardOpen: () => mic.card,
      destroy: () => { mic.destroyed++ },
    }
  }
  mic.last = () => mic.shown.at(-1)
  return mic
}

const press = (target, extra = {}) =>
  fireDocument('pointerdown', mouse('pointerdown', { x: 0, y: 0 }, { target, buttons: 1, ...extra }))
const clickOn = (target, extra = {}) => {
  const ev = mouse('click', { x: 0, y: 0 }, { target, ...extra })
  fireDocument('click', ev)
  return ev
}

test('mic: mountMic gets #reader and a restoreFocus hook; no mountMic, no mic; a throwing one is reported', async () => {
  const mic = fakeMic()
  const t = await mountPick(undefined, { mountMic: mic.mountMic })
  try {
    assert.equal(mic.mounts, 1)
    assert.equal(mic.host, t.root, 'the mic is anchored to #reader')
    assert.equal(mic.host.getAttribute('id'), 'reader')
    assert.deepEqual(Object.keys(mic.hooks), ['restoreFocus'])
    assert.equal(typeof mic.hooks.restoreFocus, 'function')
  } finally {
    t.reader.destroy()
  }
  // Absent (macOS): the reader is the reader, picks and all.
  const plain = await mountPick()
  try {
    await gesture(plain, plain.layout.at('cold'))
    assert.equal(plain.band.asks.length, 1)
  } finally {
    plain.reader.destroy()
  }
  // A mic that cannot mount costs the reader nothing.
  const boom = new Error('no mic')
  const broken = await mountPick(undefined, { mountMic: () => { throw boom } })
  try {
    assert.deepEqual(broken.errors, [['mic-mount', boom]])
    await gesture(broken, broken.layout.at('cold'))
    assert.equal(broken.band.asks.length, 1)
  } finally {
    broken.reader.destroy()
  }
})

test('mic: the button shows only over a rendered book in read mode', async () => {
  const mic = fakeMic()
  const { pane, reader } = mount(
    async (path) => (path === 'Books/Bad.epub' ? new ArrayBuffer(8) : fixture()),
    { mountMic: mic.mountMic })
  try {
    assert.equal(mic.last(), false, 'mounted with no book')
    // A first open: the blank page while the pictures load shows no button.
    const during = []
    let hook = duringPictures(
      () => reader.path() === 'Books/Test.epub' && pane.querySelectorAll('.ep-chapter').length === 0,
      () => during.push(mic.last()))
    try {
      assert.equal(await reader.open('Books/Test.epub', null), true)
    } finally {
      hook.restore()
    }
    await settle()
    assert.deepEqual(during, [false], 'a button over the blank page of a first open')
    assert.equal(mic.last(), true, 'no button over the open book')
    reader.hide()
    assert.equal(mic.last(), false, 'a button over the note that took the pane')
    reader.show()
    assert.equal(mic.last(), true, 'no button back over the book')
    // A replacement: from the moment the old book is dropped until the new one
    // is in, the pane holds no book (REVIEW finding 9).
    during.length = 0
    hook = duringPictures(
      () => reader.path() === 'Books/Other.epub' && pane.querySelectorAll('.ep-chapter').length === 0,
      () => during.push(mic.last()))
    try {
      assert.equal(await reader.open('Books/Other.epub', null), true)
    } finally {
      hook.restore()
    }
    await settle()
    assert.deepEqual(during, [false], 'the old book\'s button stayed over the blank replacement')
    assert.equal(mic.last(), true)
    reader.close()
    assert.equal(mic.last(), false)
  } finally {
    reader.destroy()
  }
  // A book that fails to open draws its error page: no button there.
  const bad = fakeMic()
  const second = mount(async () => new ArrayBuffer(8), { mountMic: bad.mountMic })
  try {
    assert.equal(await second.reader.open('Books/Bad.epub', null), true)
    await settle()
    assert.equal(second.pane.querySelector('.ep-message').hidden, false, 'fixture: no error page')
    assert.equal(bad.last(), false, 'a button over the error page')
  } finally {
    second.reader.destroy()
  }
})

test('mic: every way out of the book leaves the mic, and nothing else does', async () => {
  const mic = fakeMic()
  const { pane, reader } = mount(undefined, { mountMic: mic.mountMic })
  const leaves = async (fn) => {
    const n = mic.leaves
    await fn()
    return mic.leaves - n
  }
  const open = async (path = 'Books/Test.epub') => {
    assert.equal(await reader.open(path, null), true)
    await settle()
  }
  try {
    await open()
    // Not leaving: the same book clicked again, the find bar, a rename.
    assert.equal(await leaves(() => open()), 0, 'the same book re-clicked discarded the take')
    assert.equal(await leaves(() => reader.toggleSearch()), 0)
    assert.equal(await leaves(() => reader.adoptPath('Books/Renamed.epub')), 0)
    const got = {}
    got.hide = await leaves(() => reader.hide())
    reader.show()
    got.close = await leaves(() => reader.close())
    await open()
    got.reset = await leaves(() => reader.reset())
    await open()
    got.another = await leaves(() => open('Books/Other.epub'))
    // A replacement cancelled while its pictures load gives the pane back.
    let cancelled = 0
    const hook = duringPictures(
      () => reader.path() === 'Books/Test.epub' && pane.querySelectorAll('.ep-chapter').length === 0,
      () => { const n = mic.leaves; reader.cancelOpen(); cancelled = mic.leaves - n })
    try {
      await reader.open('Books/Test.epub', null)
    } finally {
      hook.restore()
    }
    got.cancelOpen = cancelled
    for (const [way, n] of Object.entries(got)) assert.ok(n >= 1, `${way} left a take running`)
  } finally {
    reader.destroy()
  }
})

test('mic: a click on the mic or its layer never closes the band', async () => {
  const mic = fakeMic()
  const t = await mountPick(undefined, { mountMic: mic.mountMic })
  try {
    await gesture(t, t.layout.at('cold'))
    assert.equal(t.band.open, true)
    for (const target of [mic.btn, mic.root, mic.shield, mic.layer]) {
      press(target)
      const ev = clickOn(target)
      assert.equal(t.band.open, true, `a click on ${target.className || target.parentNode.className} closed the band`)
      assert.equal(ev.defaultPrevented, false, 'never consumed')
    }
    clickOn(t.content)
    assert.equal(t.band.open, false, 'control: an outside click still closes')
  } finally {
    t.reader.destroy()
  }
})

test('mic: while the card is open no click closes the band; the next one does', async () => {
  const mic = fakeMic()
  const t = await mountPick(undefined, { mountMic: mic.mountMic })
  try {
    await gesture(t, t.layout.at('cold'))
    mic.card = true
    // The shield's click (it closes the card at target phase, after this),
    // and a title-bar click the shield does not cover.
    const tab = document.createElement('span')
    tab.className = 'tab-label'
    for (const target of [mic.shield, t.content, tab]) {
      clickOn(target)
      assert.equal(t.band.open, true, 'the click that closes the card closed the band too')
    }
    assert.equal(marked(t), 'cold')
    mic.card = false
    clickOn(t.content)
    assert.equal(t.band.open, false, 'the next click is the band\'s')

    // A pick whose press began before the card opened still owns its click:
    // the swallow comes before the stand-down.
    t.content.dispatch('mousedown', mouse('mousedown', t.layout.at('stone'), { buttons: 1 }))
    mic.card = true
    fireWindow('mouseup', mouse('mouseup', t.layout.at('stone')))
    const trailing = clickOn(t.content)
    assert.equal(trailing.defaultPrevented, true, 'the pick\'s trailing click reached the shield')
    assert.equal(trailing.propagationStopped, true)
    assert.equal(t.band.asks.at(-1).items[0].phrase, 'stone')
  } finally {
    t.reader.destroy()
  }
})

test('mic: a press on a book word while the card is open picks nothing; the band still follows its mark', async () => {
  const mic = fakeMic()
  const t = await mountPick(undefined, { mountMic: mic.mountMic })
  try {
    bandGeometry(t)
    await gesture(t, t.layout.at('cold'))
    assert.equal(t.band.asks.length, 1)
    mic.card = true
    const { down } = await gesture(t, t.layout.at('stone'))
    assert.equal(t.band.asks.length, 1, 'a word under the card asked the band')
    assert.equal(down.defaultPrevented, false, 'the press was taken for a pick')
    assert.equal(marked(t), 'cold')
    // Only the press is guarded (REVIEW finding 17): the reveal still runs.
    assert.equal(await revealed(t), revealOf(t, 'cold'), 'the card stopped the band revealing its mark')
    mic.card = false
    await gesture(t, t.layout.at('stone'))
    assert.equal(t.band.asks.length, 2, 'control: with the card gone the press picks')
  } finally {
    t.reader.destroy()
  }
})

test('mic: a press that began on the mic or its layer, released over the book, keeps the band', async () => {
  const mic = fakeMic()
  const t = await mountPick(undefined, { mountMic: mic.mountMic })
  try {
    await gesture(t, t.layout.at('cold'))
    for (const target of [mic.btn, mic.shield]) {
      press(target)
      clickOn(t.root)
      assert.equal(t.band.open, true, `a press on ${target.parentNode.className} slid off closed the band`)
    }
    press(t.content)
    clickOn(t.root)
    assert.equal(t.band.open, false, 'control: a press outside still closes')
  } finally {
    t.reader.destroy()
  }
})

test('mic: restoreFocus lands inside #reader: the band while it is open, else the book; focus already inside stays', async () => {
  const mic = fakeMic()
  const t = await mountPick(undefined, { mountMic: mic.mountMic })
  try {
    // A shield click leaves focus on <body>.
    document.activeElement = null
    mic.hooks.restoreFocus()
    assert.equal(document.activeElement, t.scroller, 'band closed: the book')
    await gesture(t, t.layout.at('cold'))
    document.activeElement = null
    mic.hooks.restoreFocus()
    assert.equal(document.activeElement, t.band.el, 'band open: the band, where its Esc is heard')
    // Already inside #reader (the find field): left where it is.
    const input = findQuery(t, 'cold')
    document.activeElement = input
    mic.hooks.restoreFocus()
    assert.equal(document.activeElement, input, 'focus was pulled out of the find field')
    // A hidden reader takes nothing.
    t.reader.hide()
    const elsewhere = document.createElement('div')
    document.activeElement = elsewhere
    mic.hooks.restoreFocus()
    assert.equal(document.activeElement, elsewhere)
  } finally {
    t.reader.destroy()
  }
})

test('mic: destroy leaves and destroys the mic', async () => {
  const mic = fakeMic()
  const t = await mountPick(undefined, { mountMic: mic.mountMic })
  const leaves = mic.leaves
  t.reader.destroy()
  assert.equal(mic.destroyed, 1)
  assert.ok(mic.leaves > leaves, 'destroy did not leave the book first')
})
