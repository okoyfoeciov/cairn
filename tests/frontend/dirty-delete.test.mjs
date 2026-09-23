// Owner: 03 (tests/frontend/*.test.mjs).  `node --test tests/frontend/`.
//
// Spec: CONTRACT.md §7.3 case 3 (the dirty-delete path, errata 3 Z5), §7.2 (the
// autosave contract's unconditional blur / visibilitychange flushes), §9.5 (the
// four note states), and docs/DATA-LOSS-VERIFICATION.md finding F3.
//
// ===========================================================================
// THIS FILE IS THE REMAINDER, AND THE SPLIT IS DELIBERATE
// ===========================================================================
// `tests/frontend/modal.test.mjs` (owner 01) covers §1.6.1's eight normative
// behaviours and the three branches of §7.3 case 3's prompt.  Everything it
// covers is DELIBERATELY ABSENT here — two files asserting the same row is two
// places to update and one place to forget.
//
// What is left is four rows about the SEAM between the guard and the write
// chain, all four of which are places where the fix could look right and still
// lose the user's text:
//
//   1. A flush that RESOLVES WITHOUT WRITING.  `write()` returns early —
//      resolving — when `noteState !== 'live'` and the reason is not `manual`.
//      So on a CONFLICTED note "Save and delete" takes a resolved promise
//      straight past the abort check having saved nothing, and the delete
//      proceeds.  That is a silent data-loss path through the one button whose
//      label promises a save, and no assertion about the modal can see it.
//   2. THE SECOND `settleWrites()`.  §7.3 case 3 requires the guard to settle
//      TWICE, and the second one exists solely because §7.2 flushes
//      unconditionally on blur and the user can blur the window WHILE THE
//      MODAL IS UP.  A guard that settles once passes every branch test.
//   3. `settleWrites()` must never reject and must not poison the chain the
//      next write runs on.
//   4. Escape ON THE GUARD'S PROMPT is Cancel — asserted through the guard, not
//      through the primitive, because what matters is the DeleteGuard value.
//
// TWO SUBSTITUTIONS, AND ONLY TWO: `EditorView` (the shim `editor.test.mjs`
// uses, for the same reason — a real view needs layout, `Range`,
// `MutationObserver` and `getComputedStyle`, `_minidom.mjs` has none of them,
// and jsdom is not in the dependency set, §6.3), and the IPC transport, which
// `configureEditor()` already takes as an injection.  The modal is the REAL
// one: every answer below is a click dispatched on the actual `<button>`
// `openModal()` rendered.
//
// WHAT IT CANNOT PROVE, stated rather than implied: nothing about a rendered
// pixel — the minidom has no layout.  That is the geometry probe's (G9).  And
// nothing about `~/.Trash`; see `core/tests/dataloss.rs`.
// ===========================================================================

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

import { installGlobals, AElement, ADocument } from './_minidom.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '..', '..')

/** @type {any} */ let M   // src/modal.ts
/** @type {any} */ let ED  // src/editor.ts

/* =========================================================================
 * 0.  The DOM.  Installed BEFORE the bundle is imported, because
 *     `@codemirror/view` sniffs the browser at module scope — it reads
 *     `navigator.userAgent/vendor/platform` and `document.documentElement
 *     .style` before one line of our code runs.
 * ======================================================================= */

/* The three methods `_minidom.mjs` does not implement and `src/modal.ts` uses.
 * Added HERE rather than in that file, which this assignment does not own —
 * the same call this project's other test files made, and for the same reason:
 * a shim beside its use cannot rot in a file its author never reads. */
AElement.prototype.appendChild = function (n) { this.append(n); return n }
AElement.prototype.removeAttribute = function (k) { this.attrs.delete(k) }
Object.defineProperty(AElement.prototype, 'isConnected', {
  configurable: true,
  get() { let n = this; while (n.parentNode) n = n.parentNode; return n !== this },
})

let doc

function installDom() {
  installGlobals()
  doc = new ADocument()
  doc.body = doc.createElement('body')
  doc.body.parentNode = doc            // so `isConnected` is true inside the body
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
  /** Dispatch a document-level event the way `keydown` reaches modal.ts. */
  doc.fire = (t, ev) => { for (const fn of [...(listeners.get(t) ?? [])]) fn(ev) }

  const winListeners = new Map()
  globalThis.document = doc
  globalThis.window = {
    __PIXELTEST__: true,             // §5.11 — publishes `window.__CM_VIEW__`
    addEventListener: (t, f) => winListeners.set(t, f),
    fire: (t) => winListeners.get(t)?.(),
  }
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 ' +
        '(KHTML, like Gecko) Version/17.0 Safari/605.1.15',
      vendor: 'Apple Computer, Inc.',
      platform: 'MacIntel',
      maxTouchPoints: 0,
    },
  })
}

/* The `EditorView` shim — `editor.test.mjs`'s, unchanged.  Kept as its own copy
 * rather than imported, because that file is a `*.test.mjs` and importing it
 * would run its 60 tests a second time. */
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
        view: this,
        state: tr.state,
        startState,
        transactions: [tr],
        docChanged: tr.docChanged,
        selectionSet: tr.selection != null,
        viewportChanged: false,
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
  installDom()
  const esbuild = await import(
    pathToFileURL(join(ROOT, 'node_modules', 'esbuild', 'lib', 'main.js')).href
  )
  const dir = mkdtempSync(join(tmpdir(), 'cairn-dd-'))
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

  // ONE bundle holding BOTH modules, so `editor.ts`'s `import { openModal }
  // from './modal'` binds to the same module instance this file drives.  Two
  // bundles would give the guard a different `openSpec` than the one the
  // one-modal-at-a-time assertions read, and every such assertion would pass
  // for the wrong reason.
  await esbuild.build({
    stdin: {
      contents:
        'export * as ED from ' + JSON.stringify(join(ROOT, 'src', 'editor.ts')) + '\n' +
        'export * as M from ' + JSON.stringify(join(ROOT, 'src', 'modal.ts')) + '\n',
      resolveDir: ROOT,
      sourcefile: 'dirty-delete-entry.ts',
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

  const mod = await import(pathToFileURL(out).href)
  ED = mod.ED
  M = mod.M
})

/* =========================================================================
 * 1.  Helpers.
 * ======================================================================= */

const settle = () => new Promise((r) => setImmediate(r))

/* Reaching the REAL dialog `openModal()` rendered, and answering it the way a
 * user does — a click dispatched on the actual `<button>`.  Nothing here stubs
 * `./modal`: a stub would prove the guard calls something, which was never the
 * property in doubt. */
const backdrops = () => doc.body.children.filter((e) => e.className === 'nc-modal-back')
const dialog = () => backdrops()[0]?.querySelector('[role="dialog"]') ?? null
const modalButtons = () => (dialog()?.querySelectorAll('.nc-modal-btn') ?? [])
const clickModal = (id) => {
  const b = modalButtons().find((x) => x.getAttribute('data-id') === id)
  assert.ok(b, `no modal button with id ${JSON.stringify(id)}`)
  b.dispatch('click', { preventDefault() {}, stopPropagation() {} })
}
const pressKey = (key, init = {}) =>
  doc.fire('keydown', { key, preventDefault() {}, stopPropagation() {}, ...init })

/** A recording transport.  `configureEditor()` takes it as an injection. */
function makeIpc(files = { 'Misc.md': 'alpha\n' }) {
  const calls = []
  const ipc = {
    files: { ...files },
    calls,
    /** Set to a VaultErrorLike to make the NEXT writeNote reject. */
    failWriteWith: null,
    /** While true every writeNote parks until `release()` is called. */
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
      const to = path.replace(/[^/]+$/, name)
      ipc.files[to] = ipc.files[path]
      delete ipc.files[path]
      return { path: to }
    },
    release() { for (const r of ipc.pending.splice(0)) r() },
  }
  return ipc
}

const writes = (ipc) => ipc.calls.filter((c) => c.op === 'write')

let mounted = false

/** EXACTLY ONE `EditorView` FOR THE PROCESS LIFETIME (M70): mount once, then
 *  re-point the transport and re-open.  `showEmpty()` first, because it drops
 *  the buffer WITHOUT writing (§7.4), so no test inherits the previous test's
 *  dirt or writes it to the previous test's transport. */
function mount(ipc, hooks = {}) {
  if (mounted) ED.showEmpty()
  ED.configureEditor(ipc)
  ED.setEditorHooks(hooks)
  if (!mounted) { ED.mountEditor({}); mounted = true }
}

const view = () => globalThis.window.__CM_VIEW__

function type(text) {
  const v = view()
  v.dispatch({ changes: { from: v.state.doc.length, insert: text } })
}

/** Open `Misc.md` and make the buffer dirty.  Returns the transport. */
async function openDirty(overrides = {}) {
  const ipc = makeIpc()
  Object.assign(ipc, overrides)
  const flushErrors = []
  mount(ipc, { onFlushError: (reason, err) => flushErrors.push({ reason, err }) })
  const r = await ED.openNote('Misc.md')
  assert.equal(r.ok, true)
  type('beta\n')
  assert.equal(ED.isDirty(), true, 'the fixture did not make the buffer dirty')
  ipc.calls.length = 0
  ipc.flushErrors = flushErrors
  return ipc
}

/* =========================================================================
 * 2.  The four rows.
 * ======================================================================= */

test('§7.3 case 3 — a flush that RESOLVES WITHOUT WRITING aborts the delete', async () => {
  // Reach the conflict state the way the app does: one write is refused with
  // `conflict`, which arms `noteState`.  From then on `write()` returns early
  // and RESOLVES for every reason but `manual`, so "Save and delete" would
  // otherwise report success having written nothing at all.
  const ipc = await openDirty()
  ipc.failWriteWith = { kind: 'conflict' }
  await ED.flushNow('manual').then(() => assert.fail('the conflict did not reject'), () => {})
  assert.equal(ED.currentNoteState(), 'conflict')
  assert.equal(ED.isDirty(), true)
  ipc.calls.length = 0
  ipc.flushErrors.length = 0

  const g = ED.guardDeleteOfOpenNote('Misc')
  await settle()
  clickModal('save')

  assert.equal(await g, 'abort', 'a save that wrote nothing let the delete proceed')
  assert.equal(ED.isDirty(), true, 'the buffer was cleaned by a save that never happened')
  assert.equal(ED.currentPath(), 'Misc.md', 'the note was closed by a save that never happened')
  assert.equal(ipc.files['Misc.md'], 'alpha\n', 'the file changed')
  assert.deepEqual(ipc.flushErrors.map((e) => e.reason), ['delete'], 'the failure was silent')
})

test('§7.3 case 3 — a BLUR FLUSH landing while the prompt is open is settled before proceed', async () => {
  const ipc = await openDirty()
  const g = ED.guardDeleteOfOpenNote('Misc')
  await settle()
  assert.equal(backdrops().length, 1, 'the fixture did not open the prompt')

  // §7.2 flushes unconditionally on window blur, and the user can blur the
  // window while the modal is up.  THIS is what the second `settleWrites()` is
  // for: without it the guard returns with a write still running, and step 8's
  // `fs::rename` then recreates the note the caller has just deleted.
  ipc.holdWrites = true
  globalThis.window.fire('blur')
  await settle()
  assert.equal(writes(ipc).length, 1, 'the blur flush never reached the transport')

  clickModal('delete')
  let done = null
  g.then((r) => { done = r })
  await settle(); await settle()
  assert.equal(done, null, 'the guard proceeded with the blur flush still in flight')

  ipc.holdWrites = false
  ipc.release()
  await settle(); await settle()
  assert.equal(await g, 'proceed')

  // THE STATED RESIDUAL (§7.3 case 3, errata 3 Z5): the blur flush DID land, so
  // what the caller trashes holds the POST-edit content even though the user
  // pressed "Delete without saving".  That is a labelling imprecision in the
  // button, not data loss — it errs toward KEEPING the user's text — and the
  // alternative costs a flush-suppression flag whose failure mode is a LOST
  // blur save.  Pinned here so changing it is a deliberate act.
  assert.equal(ipc.files['Misc.md'], 'alpha\nbeta\n')
})

test('settleWrites() never rejects, and does not poison the chain', async () => {
  const ipc = await openDirty()
  ipc.failWriteWith = { kind: 'io' }
  await ED.flushNow('manual').then(() => assert.fail('the fixture did not reject'), () => {})

  // Called with a REJECTED promise at the tail of the chain.  It must swallow
  // it — the guard awaits this on a path where a throw would abort the delete
  // for a reason the user was never shown — and it must leave a usable chain.
  assert.equal(await ED.settleWrites().then(() => 'ok', () => 'rejected'), 'ok')
  assert.equal(await ED.settleWrites().then(() => 'ok', () => 'rejected'), 'ok')
  ipc.calls.length = 0
  await ED.flushNow('manual')
  assert.equal(writes(ipc).length, 1, 'the chain was poisoned by the rejection')
})

test('§7.3 case 3 — Escape on the prompt is CANCEL, never a discard', async () => {
  const ipc = await openDirty()
  const g = ED.guardDeleteOfOpenNote('Misc')
  await settle()
  pressKey('Escape')

  assert.equal(await g, 'abort', 'Escape let the delete proceed')
  assert.equal(ED.isDirty(), true)
  assert.equal(ED.currentPath(), 'Misc.md')
  assert.deepEqual(writes(ipc), [])
})
