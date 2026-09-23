// Owner: 01.  `node --test tests/frontend/`.
// Spec: CONTRACT.md §1.6.1 (the modal primitive and its EIGHT normative
// behaviours, errata 3 Z4), §7.3 case 3 (the dirty-delete prompt and its three
// branches, errata 3 Z5), §1.6 (the failed-flush dialog), §5.12.4.3 (no third
// rendered scroller), §6.1 (no innerHTML).
//
// ===========================================================================
// WHY THIS FILE EXISTS, AND WHAT IT IS ALLOWED TO CLAIM
// ===========================================================================
// `docs/DATA-LOSS-VERIFICATION.md` finding F1 was a LIVE DATA-LOSS BUG that
// reached a working, shipping app: deleting the open note with unsaved edits
// trashed the PRE-EDIT file and dropped the buffer, with no prompt and no
// recovery path.  It was found by READING the source while building `dl_05`,
// and it was recorded as "not covered by a test in dataloss.rs: asserting it
// would need UI automation (gap G-c)".
//
// That gap is what this file closes, and it closes it WITHOUT a UI automation
// harness.  Both halves of the fix are ordinary modules with ordinary
// dependencies:
//
//   PART A — `src/modal.ts` driven against `tests/frontend/_minidom.mjs`.  The
//     real dialog, built by the real `openModal`, with its buttons clicked and
//     its keys pressed.  Every one of §1.6.1's eight numbered behaviours has a
//     row here, because each one exists ONLY to stop a stray click, a stray
//     Escape or a second dialog from answering a data-loss question.
//
//   PART B — the three branches of §7.3 case 3, driven through the REAL
//     `guardDeleteOfOpenNote` in `src/editor.ts`, the REAL promise chain, the
//     REAL two timers and the REAL `openModal` above, with the buttons clicked
//     for real.  `EditorView` is shimmed exactly as `editor.test.mjs` shims it
//     (and for the same reason: a real view needs layout, `Range`,
//     `MutationObserver` and `getComputedStyle`, and jsdom is not in the
//     dependency set — §6.3 pins esbuild and typescript and nothing else).
//
// WHAT IT CANNOT CLAIM.  Nothing about a pixel: the minidom has no layout, so
// no row here asserts a coordinate, a colour value or a font.  The dialog's
// rendered geometry belongs to `tools/verify-geometry.js` and to a manual pass.
// And nothing about `~/.Trash`: that is `dl_25`/`dl_26` in
// `core/tests/dataloss.rs`, and it is a NAMED GAP for a measured reason.
// ===========================================================================

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { installGlobals, AElement, ADocument } from './_minidom.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')
/** Source with comments removed.  Every grep-shaped row below runs on this:
 *  these files DOCUMENT the rules they obey ("Never `innerHTML`", "no overflow
 *  anywhere"), so a grep over the raw text would match the prose and pass —
 *  or fail — for the wrong reason. */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/** @type {any} */ let M

/* =========================================================================
 * 0.  The DOM.
 *
 * `_minidom.mjs` (owner 05) is missing three methods `src/modal.ts` uses.  They
 * are shimmed HERE rather than added there, for the reason chrome-ui.test.mjs
 * already states for its own two: this assignment does not own that file, and a
 * shim beside its use cannot silently rot in a file its author never reads.
 * REPORTED to owner 05.
 * ======================================================================= */
AElement.prototype.appendChild = function (n) { this.append(n); return n }
AElement.prototype.removeAttribute = function (k) { this.attrs.delete(k) }
// `activeElement` must go back to null when the focused element leaves the
// document, or [N3]'s "focus is restored" row would pass by accident.
const baseRemove = AElement.prototype.remove
AElement.prototype.remove = function () {
  const doc = this.ownerDocument
  if (doc && (doc.activeElement === this || this.descendants().includes(doc.activeElement))) {
    doc.activeElement = null
  }
  return baseRemove.call(this)
}

function makeDocument() {
  installGlobals()
  const doc = new ADocument()
  doc.body = doc.createElement('body')
  doc.hidden = false
  doc.documentElement.style = { webkitFontSmoothing: '' }
  const listeners = new Map()
  doc.addEventListener = (t, fn) => {
    if (!listeners.has(t)) listeners.set(t, [])
    listeners.get(t).push(fn)
  }
  doc.removeEventListener = (t, fn) => {
    const l = listeners.get(t) ?? []
    const i = l.indexOf(fn)
    if (i >= 0) l.splice(i, 1)
  }
  doc.fire = (t, ev) => { for (const fn of [...(listeners.get(t) ?? [])]) fn(ev) }
  doc.listenerCount = (t) => (listeners.get(t) ?? []).length
  return doc
}

/** Every rendered dialog currently in the document. */
const dialogs = () => globalThis.document.body.querySelectorAll('.nc-modal-back')
const dialog = () => dialogs()[0] ?? null
const buttonsOf = (back) => back.querySelectorAll('[data-id]')
const labelsOf = (back) => buttonsOf(back).map((b) => b.textContent)
const byId = (back, id) => buttonsOf(back).find((b) => b.getAttribute('data-id') === id) ?? null

const clickEvent = () => ({ preventDefault() {}, stopPropagation() {} })
const key = (k, shiftKey = false) => ({ key: k, shiftKey, preventDefault() {}, stopPropagation() {} })
const click = (back, id) => { byId(back, id).dispatch('click', clickEvent()) }

/** Let the microtask queue drain without advancing any timer. */
const settle = () => new Promise((r) => setImmediate(r))

/* =========================================================================
 * 1.  Build the subject.
 *
 * ONE bundle carrying BOTH `src/modal.ts` and `src/editor.ts`, deliberately:
 * PART B must exercise the SAME module instance PART A does, or [N5]'s
 * one-modal-at-a-time state would be two independent variables and the
 * three-branch rows would be driving a dialog nobody else can see.
 * ======================================================================= */

const VIEW_SHIM = `
  export * from '@codemirror/view__real'
  import { EditorView as RealEditorView } from '@codemirror/view__real'

  export class EditorView {
    constructor(config) {
      this.state = config.state
      this.dom = { classList: { add() {}, remove() {} } }
      this.contentDOM = this.dom
      this.scrollDOM = { scrollTop: 0, addEventListener() {} }
      this.hasFocus = false
    }
    setState(state) { this.state = state }
    dispatch(...specs) {
      const startState = this.state
      const tr = startState.update(...(specs.length ? specs : [{}]))
      this.state = tr.state
      const update = {
        view: this, state: tr.state, startState, transactions: [tr],
        docChanged: tr.docChanged, selectionSet: tr.selection != null, viewportChanged: false,
      }
      for (const fn of tr.state.facet(RealEditorView.updateListener)) fn(update)
    }
    focus() { this.hasFocus = true }
    plugin() { return null }
    get visibleRanges() { return [{ from: 0, to: this.state.doc.length }] }
  }
  for (const k of Object.getOwnPropertyNames(RealEditorView)) {
    if (k === 'prototype' || k === 'name' || k === 'length') continue
    Object.defineProperty(EditorView, k, Object.getOwnPropertyDescriptor(RealEditorView, k))
  }
`

before(async () => {
  const esbuild = await import(
    pathToFileURL(join(ROOT, 'node_modules', 'esbuild', 'lib', 'main.js')).href
  )
  const dir = mkdtempSync(join(tmpdir(), 'cairn-modal-'))
  // Same guard tree.test.mjs and search.test.mjs use: registered on the
  // dir the moment it exists, BEFORE the bundle step, so a throw out of
  // esbuild or a failing assertion still takes the fixture with it.
  process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })
  const out = join(dir, 'bundle.mjs')

  const shimPlugin = {
    name: 'view-shim',
    setup(build) {
      build.onResolve({ filter: /^@codemirror\/view$/ }, () => ({
        path: '@codemirror/view', namespace: 'view-shim',
      }))
      build.onLoad({ filter: /.*/, namespace: 'view-shim' }, () => ({
        contents: VIEW_SHIM, loader: 'ts', resolveDir: ROOT,
      }))
      build.onResolve({ filter: /^@codemirror\/view__real$/ }, () => ({
        path: join(ROOT, 'node_modules', '@codemirror', 'view', 'dist', 'index.js'),
      }))
    },
  }

  await esbuild.build({
    stdin: {
      contents:
        'export * from ' + JSON.stringify(join(ROOT, 'src', 'modal.ts')) + '\n' +
        'export * as ED from ' + JSON.stringify(join(ROOT, 'src', 'editor.ts')) + '\n',
      resolveDir: ROOT,
      sourcefile: 'modal-test-entry.ts',
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
    plugins: [shimPlugin],
    logLevel: 'silent',
  })

  // `@codemirror/view` sniffs the browser at MODULE SCOPE, before any of our
  // code runs, so these must exist before the import rather than before the
  // mount.  macOS/Safari because that is the only platform v1 ships on (§5.8).
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 ' +
        '(KHTML, like Gecko) Version/17.0 Safari/605.1.15',
      vendor: 'Apple Computer, Inc.', platform: 'MacIntel', maxTouchPoints: 0,
    },
  })
  const winListeners = new Map()
  globalThis.window = {
    __PIXELTEST__: true,                   // §5.11 — publishes `window.__CM_VIEW__`
    addEventListener: (t, f) => winListeners.set(t, f),
    fire: (t) => winListeners.get(t)?.(),
  }
  globalThis.document = makeDocument()

  M = await import(pathToFileURL(out).href)
})

/** A fresh document for a row that inspects the body, keeping the ONE modal
 *  module's state honest: `resetDom` never clears it, so a row that leaked an
 *  open dialog fails the next row rather than hiding. */
function resetDom() {
  globalThis.document = makeDocument()
  return globalThis.document
}

/* =========================================================================
 * PART A — src/modal.ts, §1.6.1's eight normative behaviours
 * ======================================================================= */

test('§1.6.1 — buttons render left to right IN ARRAY ORDER, and the pick resolves', async () => {
  resetDom()
  const p = M.openModal({
    title: 'Misc has unsaved changes.',
    detail: 'Deleting it now will move the file to the Trash without these changes.',
    buttons: [
      { id: 'cancel', label: 'Cancel' },
      { id: 'save', label: 'Save and delete' },
      { id: 'delete', label: 'Delete without saving', destructive: true },
    ],
    defaultId: 'cancel',
  })
  const back = dialog()
  assert.notEqual(back, null, 'no dialog was rendered')
  assert.deepEqual(labelsOf(back), ['Cancel', 'Save and delete', 'Delete without saving'])
  assert.equal(back.querySelector('.nc-modal').textContent.startsWith('Misc has unsaved changes.'), true)

  click(back, 'save')
  assert.equal(await p, 'save', 'openModal did not resolve with the picked button id')
  assert.equal(dialogs().length, 0, 'the dialog was left in the document after a pick')
})

test('§1.6.1 [N1] — the default is FOCUSED on open, and Escape picks it', async () => {
  resetDom()
  const p = M.openModal({
    title: 'x', detail: 'y',
    buttons: [
      { id: 'cancel', label: 'Cancel' },
      { id: 'delete', label: 'Delete without saving', destructive: true },
    ],
    defaultId: 'cancel',
  })
  const back = dialog()
  assert.equal(
    globalThis.document.activeElement,
    byId(back, 'cancel'),
    'the default button was not focused on open — the first Return would hit something else'
  )

  globalThis.document.fire('keydown', key('Escape'))
  assert.equal(await p, 'cancel', 'Escape did not pick the DEFAULT')
  assert.equal(dialogs().length, 0)
})

test('§1.6.1 [N1] — Escape can never destroy anything: it picks the default, not the destructive', async () => {
  // The row above proves Escape picks `defaultId`.  This one proves the OTHER
  // half of the claim, which is a property of the two SHIPPED call sites: at
  // both of them the default is the safe button.  Read out of the source,
  // because a future edit that made `delete` the default would satisfy every
  // behavioural row above and still be a data-loss bug.
  const editorTs = read('src/editor.ts')
  const mainTs = read('src/main.ts')
  const tabTs = read('src/tabstrip.ts')
  for (const [name, src] of [['editor.ts', editorTs], ['main.ts', mainTs], ['tabstrip.ts', tabTs]]) {
    for (const m of src.matchAll(/defaultId:\s*'([a-z]+)'/g)) {
      assert.ok(
        ['cancel', 'keep'].includes(m[1]),
        `${name}: defaultId '${m[1]}' is not a safe default (§1.6.1 [N1])`
      )
    }
  }
  // And every destructive button carries the flag that renders it in
  // --text-error, so it can never look like the default.
  for (const [name, src] of [['editor.ts', editorTs], ['main.ts', mainTs], ['tabstrip.ts', tabTs]]) {
    for (const m of src.matchAll(/\{\s*id:\s*'(delete|discard|quit)'[^}]*\}/g)) {
      assert.match(m[0], /destructive:\s*true/, `${name}: ${m[1]} is not marked destructive`)
    }
  }
})

test('§1.6.1 [N2] — a click on the BACKDROP does nothing at all', async () => {
  resetDom()
  let settled = null
  const p = M.openModal({
    title: 'x', detail: 'y',
    buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'delete', label: 'Delete', destructive: true }],
    defaultId: 'cancel',
  })
  p.then((id) => { settled = id })

  const back = dialog()
  back.dispatch('click', clickEvent())
  await settle()

  assert.equal(settled, null, 'a stray backdrop click ANSWERED a data-loss question')
  assert.equal(dialogs().length, 1, 'the backdrop click dismissed the dialog')

  click(back, 'cancel')
  assert.equal(await p, 'cancel')
})

test('§1.6.1 [N3] — focus is restored to the previously focused element', async () => {
  const doc = resetDom()
  const before = doc.createElement('div')
  doc.body.append(before)
  before.focus()
  assert.equal(doc.activeElement, before)

  const p = M.openModal({
    title: 'x', detail: 'y',
    buttons: [{ id: 'keep', label: 'Keep editing' }, { id: 'quit', label: 'Discard changes and quit', destructive: true }],
    defaultId: 'keep',
  })
  assert.notEqual(doc.activeElement, before, 'the dialog never took focus')
  click(dialog(), 'keep')
  await p
  assert.equal(doc.activeElement, before, 'focus was not returned to where it came from')
})

test('§1.6.1 [N4] — role, aria-modal, and Tab CYCLES inside the dialog', async () => {
  const doc = resetDom()
  const p = M.openModal({
    title: 'x', detail: 'y',
    buttons: [
      { id: 'cancel', label: 'Cancel' },
      { id: 'save', label: 'Save and delete' },
      { id: 'delete', label: 'Delete without saving', destructive: true },
    ],
    defaultId: 'cancel',
  })
  const back = dialog()
  const box = back.querySelector('.nc-modal')
  assert.equal(box.getAttribute('role'), 'dialog')
  assert.equal(box.getAttribute('aria-modal'), 'true')

  // Forward from the focused default, wrapping at the end.
  assert.equal(doc.activeElement, byId(back, 'cancel'))
  doc.fire('keydown', key('Tab'));       assert.equal(doc.activeElement, byId(back, 'save'))
  doc.fire('keydown', key('Tab'));       assert.equal(doc.activeElement, byId(back, 'delete'))
  doc.fire('keydown', key('Tab'))
  assert.equal(doc.activeElement, byId(back, 'cancel'), 'Tab walked OUT of an aria-modal dialog')
  // And backwards.
  doc.fire('keydown', key('Tab', true))
  assert.equal(doc.activeElement, byId(back, 'delete'))

  click(back, 'cancel')
  await p
})

test('§1.6.1 [N5] — ONE modal at a time: a second call is refused and answers with its OWN default', async () => {
  resetDom()
  const errs = []
  const realError = console.error
  console.error = (...a) => errs.push(a.join(' '))
  try {
    const first = M.openModal({
      title: 'first', detail: 'y',
      buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'delete', label: 'Delete', destructive: true }],
      defaultId: 'cancel',
    })
    assert.equal(M.modalIsOpen(), true)

    const second = M.openModal({
      title: 'second', detail: 'y',
      buttons: [{ id: 'keep', label: 'Keep editing' }, { id: 'quit', label: 'Quit', destructive: true }],
      defaultId: 'keep',
    })
    // THE ROW THAT MATTERS: the second caller is answered with ITS OWN safe
    // default, never with an id from the open dialog's button set, and no
    // second dialog is drawn.  The open dialog's `cancel` is not an answer
    // the quit prompt offers, and its caller must not have to guess at it.
    assert.equal(await second, 'keep')
    assert.equal(dialogs().length, 1, 'two data-loss prompts were stacked')
    assert.equal(errs.length, 1, 'the refusal was silent')

    // The first dialog is still live and still answers for itself.
    click(dialog(), 'delete')
    assert.equal(await first, 'delete')
    assert.equal(M.modalIsOpen(), false, 'the module stayed latched after the dialog closed')
  } finally {
    console.error = realError
  }
})

test('the dialog box is a flex COLUMN: the title-to-body gap must not margin-collapse', async () => {
  // User report, 2026-09-15: Obsidian's gap (header margin 11.25 + first
  // paragraph margin 15 = 26.25) rendered as 15 in Cairn, because a block box
  // collapses the two margins and Obsidian's `.modal` is flex (which never
  // collapses).  Assert the mechanism, not the pixels — the minidom has no
  // layout, so no row here can measure a gap.
  resetDom()
  const p = M.openModal({
    title: 'Delete file',
    detail: ['Are you sure you want to delete \u201cMisc.md\u201d?', 'It will be moved to your system trash.'],
    buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'delete', label: 'Delete', destructive: true, cta: true }],
    defaultId: 'cancel',
    focusId: 'delete',
  })
  const box = dialog().querySelector('.nc-modal')
  const style = box.getAttribute('style')
  assert.match(style, /display:flex/, 'the dialog box is not flex: margins collapse and the gap shrinks')
  assert.match(style, /flex-direction:column/)
  click(dialog(), 'cancel')
  await p
})

test('§1.6.1 [N6] — no element in the dialog declares overflow (§5.12.4.3)', async () => {
  resetDom()
  const p = M.openModal({
    title: 'x', detail: 'y',
    buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'delete', label: 'Delete', destructive: true }],
    defaultId: 'cancel',
  })
  // The RENDERED dialog: every inline style attribute it actually emitted.
  // `overflow-wrap` is NOT overflow: the property (`overflow:`) is what would
  // declare a scrollable box, and a bare substring would now fail on the
  // first paragraph's break-wording — the same prose-vs-code hazard this
  // file documents elsewhere.
  const back = dialog()
  for (const el of [back, ...back.descendants()]) {
    const style = el.getAttribute('style') ?? ''
    assert.equal(/(^|;)\s*overflow\s*:/.test(style), false, `an element declared overflow: ${style}`)
    assert.equal(/max-height/.test(style), false, 'a max-height invites an overflow (§1.6.1 [N6])')
  }
  // And the source, so a rule added in a form this DOM cannot render still fails.
  const modalTs = read('src/modal.ts')
  assert.equal(/overflow\s*:/.test(strip(modalTs)), false)
  click(back, 'cancel')
  await p
})

test('§1.6.1 [N7] — never innerHTML: a note name that looks like markup lands as TEXT', async () => {
  resetDom()
  // Comments STRIPPED first: this file's own prose says "Never `innerHTML`",
  // and a grep that matched its own warning would be a tautology.
  const code = strip(read('src/modal.ts'))
  assert.equal(/innerHTML/.test(code), false, 'modal.ts referenced innerHTML')

  const nasty = '<img src=x onerror=alert(1)>.md has unsaved changes.'
  const p = M.openModal({
    title: nasty, detail: 'y',
    buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'delete', label: 'Delete', destructive: true }],
    defaultId: 'cancel',
  })
  const box = dialog().querySelector('.nc-modal')
  // Four ELEMENT children — the X, the header, the content, the button row —
  // and the title is one text node, not a parsed `<img>`.
  assert.equal(box.children.length, 4)
  const title = box.querySelector('.nc-modal-title')
  assert.equal(title.textContent, nasty)
  assert.equal(title.children.length, 0, 'the note name was PARSED as markup')
  // The X is built with createElementNS, not innerHTML either: the minidom
  // has no innerHTML setter, so a string-built svg would not even render here
  // (and its selector engine has no tag selectors, so read it off children).
  const x = box.querySelector('.nc-modal-x')
  assert.notEqual(x, null, 'the dialog has no close button')
  assert.equal(x.children.length, 1)
  assert.equal(x.children[0].tagName, 'SVG')
  assert.equal(x.children[0].getAttribute('width'), '18')
  click(dialog(), 'cancel')
  await p
})

test('§1.6.1 [N8] — the dialog adds no stylesheet rule and consumes only tokens.css properties', () => {
  const modalTs = read('src/modal.ts')
  const tokens = read('src/styles/tokens.css')
  const used = [...strip(modalTs).matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1])
  assert.ok(used.length >= 5, 'the dialog stopped using tokens entirely')
  for (const v of new Set(used)) {
    assert.ok(tokens.includes(v + ':'), `${v} is used by modal.ts and not declared in tokens.css`)
  }
  // No stylesheet import and no rule text: §6.3's 20,000-byte CSS budget is
  // untouched by this file, which is why §1.6.1 can afford the dialog at all.
  assert.equal(/\.css'|\.css"/.test(strip(modalTs)), false, 'modal.ts imported a stylesheet')
})

test('§1.6.1 — buttons come in three looks: plain default, tinted destructive, SOLID destructive+cta', async () => {
  resetDom()
  const p = M.openModal({
    title: 'x', detail: 'y',
    buttons: [
      { id: 'cancel', label: 'Cancel' },
      { id: 'tinted', label: 'Tinted', destructive: true },
      { id: 'delete', label: 'Delete', destructive: true, cta: true },
    ],
    defaultId: 'cancel',
  })
  const back = dialog()
  const plain = byId(back, 'cancel').getAttribute('style')
  const tinted = byId(back, 'tinted').getAttribute('style')
  const solid = byId(back, 'delete').getAttribute('style')
  // The default is PLAIN dark, not an accent fill: nothing about it reads as
  // "press me".
  assert.match(plain, /--bg-modifier-border/, 'the default lost its plain fill')
  assert.equal(/var\(--accent\)/.test(plain), false, 'the default looks like a call to action')
  // Tinted destructive renders in --text-error without the accent...
  assert.match(tinted, /--text-error/, 'the destructive button is not rendered in --text-error')
  assert.equal(/var\(--accent\)/.test(tinted), false)
  // ...and only destructive+cta spends --text-error as a BACKGROUND.
  assert.match(solid, /background:var\(--text-error\)/, 'the delete confirm is not solid red')
  click(back, 'cancel')
  await p
})

test('the delete confirm focuses Delete, Escape still answers Cancel, and the X answers Cancel too', async () => {
  resetDom()
  const p = M.openModal({
    title: 'Delete file',
    detail: ['Are you sure you want to delete \u201cMisc.md\u201d?', 'It will be moved to your system trash.'],
    buttons: [
      { id: 'cancel', label: 'Cancel' },
      { id: 'delete', label: 'Delete', destructive: true, cta: true },
    ],
    defaultId: 'cancel',
    focusId: 'delete',
  })
  const back = dialog()
  // Two paragraphs, the first break-worded for long names...
  const paras = back.querySelector('.nc-modal-detail').children
  assert.equal(paras.length, 2)
  assert.equal(paras[0].textContent, 'Are you sure you want to delete \u201cMisc.md\u201d?')
  assert.match(paras[0].getAttribute('style'), /overflow-wrap:break-word/)
  assert.equal(paras[1].textContent, 'It will be moved to your system trash.')
  // ...Delete focused (Obsidian-measured), Escape on the safe answer.
  assert.equal(globalThis.document.activeElement, byId(back, 'delete'))
  globalThis.document.fire('keydown', key('Escape'))
  assert.equal(await p, 'cancel', 'Escape destroyed something')
  assert.equal(dialogs().length, 0)
})

test('the X closes to the safe default, and warnings render amber after the detail', async () => {
  resetDom()
  const p = M.openModal({
    title: 'Delete folder',
    detail: ['Are you sure you want to delete \u201cP\u201d?', 'It will be moved to your system trash.'],
    warnings: ['This folder is not empty.', 'If you continue, all files inside this folder will be deleted.'],
    buttons: [
      { id: 'cancel', label: 'Cancel' },
      { id: 'delete', label: 'Delete', destructive: true, cta: true },
    ],
    defaultId: 'cancel',
    focusId: 'delete',
  })
  const back = dialog()
  const content = back.querySelector('.nc-modal-detail')
  assert.equal(content.children.length, 4)
  assert.match(content.children[2].getAttribute('style'), /--text-warning/)
  assert.equal(content.children[2].textContent, 'This folder is not empty.')
  // The X is NOT a button in the row: it answers with the default, like Escape.
  back.querySelector('.nc-modal-x').dispatch('click', clickEvent())
  assert.equal(await p, 'cancel', 'the X did not answer with the safe default')
  assert.equal(dialogs().length, 0)
})

test('§1.6.1 — the keydown listener is removed when the dialog closes', async () => {
  const doc = resetDom()
  assert.equal(doc.listenerCount('keydown'), 0)
  const p = M.openModal({
    title: 'x', detail: 'y',
    buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'delete', label: 'Delete', destructive: true }],
    defaultId: 'cancel',
  })
  assert.equal(doc.listenerCount('keydown'), 1)
  click(dialog(), 'cancel')
  await p
  assert.equal(doc.listenerCount('keydown'), 0, 'a closed dialog is still eating Escape')
})

/* =========================================================================
 * PART B — §7.3 case 3's THREE BRANCHES, through the real guard
 *
 * This is finding F1's regression test.  Every row drives
 * `guardDeleteOfOpenNote` for real: real dirty flag, real timers, real
 * serialising promise chain, real `openModal`, real button clicks.
 * ======================================================================= */

function makeIpc(files = { 'Misc.md': 'before\n' }) {
  const calls = []
  const ipc = {
    files: { ...files },
    calls,
    failWriteWith: null,
    holdWrites: false,
    pending: [],
    mtime: 1000,
    async readNote(path) {
      calls.push({ op: 'read', path })
      const text = ipc.files[path]
      if (text === undefined) throw { kind: 'notFound' }
      return { text, mtimeMs: ipc.mtime, flags: 0 }
    },
    async writeNote(path, text, flags, baseMtimeMs, create) {
      calls.push({ op: 'write', path, text, flags, baseMtimeMs, create })
      if (ipc.holdWrites) await new Promise((r) => ipc.pending.push(r))
      const err = ipc.failWriteWith
      if (err) { ipc.failWriteWith = null; throw err }
      ipc.files[path] = text
      ipc.mtime += 1
      return { mtimeMs: ipc.mtime }
    },
    async renameEntry(path, name) {
      calls.push({ op: 'rename', path, name })
      return { path: path.replace(/[^/]+$/, name) }
    },
  }
  return ipc
}

const writes = (ipc) => ipc.calls.filter((c) => c.op === 'write')
let mounted = false

/** One dirty open note, with `text` typed at the end of it.  Returns the ipc. */
async function openDirty(text = 'edited') {
  resetDom()
  const ipc = makeIpc()
  const errors = []
  if (mounted) M.ED.showEmpty()
  M.ED.configureEditor(ipc)
  M.ED.setEditorHooks({ onFlushError: (reason, err) => errors.push({ reason, err }) })
  if (!mounted) { M.ED.mountEditor({}); mounted = true }
  const r = await M.ED.openNote('Misc.md')
  assert.equal(r.ok, true)
  if (text !== null) {
    const v = globalThis.window.__CM_VIEW__
    v.dispatch({ changes: { from: v.state.doc.length, insert: text } })
    assert.equal(M.ED.isDirty(), true, 'the fixture did not make the buffer dirty')
  }
  ipc.calls.length = 0
  return { ipc, errors }
}

test('§7.3 case 3 — the prompt is §7.3\'s, verbatim, and only when DIRTY', async () => {
  const { ipc } = await openDirty()
  const g = M.ED.guardDeleteOfOpenNote('Misc')
  await settle()

  const back = dialog()
  assert.notEqual(back, null, 'the dirty-delete prompt was not shown — this is finding F1')
  const box = back.querySelector('.nc-modal')
  assert.equal(box.querySelector('.nc-modal-title').textContent, 'Misc has unsaved changes.')
  assert.equal(
    box.querySelector('.nc-modal-detail').textContent,
    'Deleting it now will move the file to the Trash without these changes.'
  )
  assert.deepEqual(labelsOf(back), ['Cancel', 'Save and delete', 'Delete without saving'])
  assert.equal(globalThis.document.activeElement, byId(back, 'cancel'), 'Cancel is not the focused default')

  click(back, 'cancel')
  assert.equal(await g, 'abort')
  assert.deepEqual(writes(ipc), [], 'the Cancel branch wrote to disk')
})

test('§7.3 case 3 branch 1 — CANCEL aborts: no delete, and the buffer is untouched', async () => {
  const { ipc } = await openDirty('edited')
  const g = M.ED.guardDeleteOfOpenNote('Misc')
  await settle()
  click(dialog(), 'cancel')

  assert.equal(await g, 'abort', 'Cancel did not abort the delete')
  // The note is still open, still dirty, and still holds the typed text.
  assert.equal(M.ED.isDirty(), true, 'Cancel dropped the dirty flag')
  assert.equal(M.ED.currentPath(), 'Misc.md', 'Cancel closed the note')
  assert.deepEqual(writes(ipc), [])
  assert.equal(ipc.files['Misc.md'], 'before\n', 'the file on disk changed on a Cancel')
})

test('§7.3 case 3 branch 2 — SAVE AND DELETE writes the buffer FIRST, then proceeds', async () => {
  const { ipc } = await openDirty('edited')
  const g = M.ED.guardDeleteOfOpenNote('Misc')
  await settle()
  click(dialog(), 'save')

  assert.equal(await g, 'proceed')
  const w = writes(ipc)
  assert.equal(w.length, 1, `expected exactly one write, got ${w.length}`)
  assert.equal(w[0].text, 'before\nedited', 'the write did not carry the typed text')
  // §7.1 rule 1: the create bit is NEVER set on this path.  A `true` here is
  // bug B17 wearing a save button.
  assert.equal(w[0].create, false)
  assert.equal(ipc.files['Misc.md'], 'before\nedited', 'the edits are not on disk')
  assert.equal(M.ED.isDirty(), false)
  // Step 4: the editor has dropped the note, so nothing can write to it again.
  assert.equal(M.ED.currentPath(), null)
})

test('§7.3 case 3 branch 2 — a REJECTED flush ABORTS the delete and reports the error', async () => {
  const { ipc, errors } = await openDirty('edited')
  ipc.failWriteWith = { kind: 'io', message: 'Permission denied' }

  const g = M.ED.guardDeleteOfOpenNote('Misc')
  await settle()
  click(dialog(), 'save')

  // THE ROW THAT MATTERS MOST IN THIS FILE.  On a refused write the file on
  // disk is the only copy of the old content and the buffer is the only copy
  // of the edits; deleting anyway destroys both in one move.
  assert.equal(await g, 'abort', 'a refused save still let the delete proceed')
  assert.equal(M.ED.isDirty(), true, 'the buffer was cleaned after a failed save')
  assert.equal(M.ED.currentPath(), 'Misc.md', 'the note was closed after a failed save')
  assert.equal(ipc.files['Misc.md'], 'before\n')
  assert.equal(errors.length, 1, 'the failure was silent')
  assert.equal(errors[0].reason, 'delete')
  assert.equal(errors[0].err.kind, 'io')
})

test('§7.3 case 3 branch 3 — DELETE WITHOUT SAVING proceeds, writes NOTHING, and disarms every later flush', async () => {
  const { ipc } = await openDirty('edited')
  const g = M.ED.guardDeleteOfOpenNote('Misc')
  await settle()
  click(dialog(), 'delete')

  assert.equal(await g, 'proceed')
  assert.deepEqual(writes(ipc), [], 'the "without saving" branch wrote to disk')
  assert.equal(M.ED.isDirty(), false)
  assert.equal(M.ED.currentPath(), null)

  // And the point of step 4: the blur/visibilitychange flush §7.2 fires
  // unconditionally must now be a no-op, or it would recreate the note through
  // the very window `x-create: '0'` exists to close.
  await M.ED.flushNow('blur').catch(() => {})
  await M.ED.flushNow('hidden').catch(() => {})
  assert.deepEqual(writes(ipc), [], 'a later flush wrote to a note the user deleted')
  assert.equal(ipc.files['Misc.md'], 'before\n')
})

test('§7.3 case 3 — a CLEAN buffer is never prompted, and proceeds', async () => {
  const { ipc } = await openDirty(null)
  assert.equal(M.ED.isDirty(), false)

  const g = M.ED.guardDeleteOfOpenNote('Misc')
  await settle()
  assert.equal(dialogs().length, 0, 'a clean buffer was prompted — the dialog is noise')
  assert.equal(await g, 'proceed')
  assert.deepEqual(writes(ipc), [])
})

test('F3 — the guard does not return while a write is IN FLIGHT (settleWrites)', async () => {
  // Finding F3, exactly: `x-create: '0'` cannot close a write that had already
  // passed step 1b when the delete landed, because step 8's rename creates the
  // destination whether or not it existed.  Cancelling the timers cannot close
  // it either — cancelling stops a write from being ISSUED, not one already
  // running.  Awaiting the chain is what closes it, and this row proves the
  // guard actually awaits: with a write held open, the guard must not have
  // returned and must not even have drawn its dialog.
  const { ipc } = await openDirty('edited')
  ipc.holdWrites = true
  const inFlight = M.ED.flushNow('idle').catch(() => {})
  await settle()
  assert.equal(ipc.pending.length, 1, 'the fixture did not actually hold a write open')

  let done = null
  const g = M.ED.guardDeleteOfOpenNote('Misc').then((v) => { done = v })
  await settle()
  assert.equal(done, null, 'the guard returned while a write was still in flight')
  assert.equal(dialogs().length, 0, 'the guard prompted on a `dirty` a landing write was about to clear')

  // Let the held write land.  It succeeds, so the buffer is clean, so there is
  // nothing to prompt about and the guard proceeds without a dialog.
  ipc.holdWrites = false
  ipc.pending.shift()()
  await inFlight
  await g
  assert.equal(done, 'proceed')
  assert.equal(dialogs().length, 0)
  assert.equal(ipc.files['Misc.md'], 'before\nedited')
})

test('§7.3 case 3 — the guard is the ONLY caller of the unsaved-changes prompt, and main.ts calls it', () => {
  // A tripwire in the shape of `dl_06`.  F1 was exactly this: a delete path
  // that never asked.  If `deleteFlow` ever stops calling the guard, or a
  // second copy of the prompt grows somewhere else, this row fails.
  const mainTs = read('src/main.ts')
  const editorTs = read('src/editor.ts')
  assert.match(mainTs, /guardDeleteOfOpenNote\(/, 'main.ts stopped calling the delete guard')
  assert.match(mainTs, /if\s*\(guard === 'abort'\) return/, "main.ts stopped honouring 'abort'")

  const src = readFileSync(join(ROOT, 'src', 'editor.ts'), 'utf8')
  const promptSites = [...src.matchAll(/has unsaved changes\./g)]
  assert.equal(promptSites.length, 1, 'the unsaved-changes prompt has more than one copy')

  // And no module may draw its own dialog: `modal.ts` is the only file that
  // builds one (§1.6.1, §6.4).
  for (const f of ['main.ts', 'tabstrip.ts', 'editor.ts', 'chrome.ts', 'tree.ts', 'search.ts', 'vaultbar.ts']) {
    const text = read('src/' + f)
    assert.equal(
      /aria-modal/.test(text), false,
      `${f} builds its own dialog — §6.4 says modal.ts is THE ONLY MODAL IN THE APP`
    )
  }
  assert.match(editorTs, /from '\.\/modal'/, 'editor.ts stopped using the one modal')
})
