/**
 * tests/frontend/reader.test.mjs — CONTRACT §0.55 E108's reader surface.
 *
 * Driven through the real `mountReader` on `_minidom.mjs`.  The important half
 * is the SANITISER: a book's XHTML contains scripts, remote images and hostile
 * link schemes, and none of them may become live DOM.  The rest pins the reading
 * surface, the Mod-F find overlay, the stripped chrome and the takeover class.
 */

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'
import { installGlobals, AElement, ADocument } from './_minidom.mjs'
import { fixture } from './_epub-fixture.mjs'

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
    addEventListener: () => {},
    requestAnimationFrame: (cb) => setTimeout(cb, 0),
  }
  globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0)
  globalThis.URL.createObjectURL = () => 'blob:fixture'
  globalThis.URL.revokeObjectURL = () => {}
})

const settle = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0))
}

function mount(readEpub = async () => fixture()) {
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
