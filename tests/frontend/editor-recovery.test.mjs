// `node --test tests/frontend/*.test.mjs`.
//
// The editor's half of four repairs, driven through the SHIPPED `src/editor.ts`
// and `src/modal.ts` (one bundle, so the guard's `openModal` and this file's are
// the same module instance, as in modal.test.mjs):
//
//   - a note that went read-only with its vault autosaves again once the SAME
//     vault is re-opened, and the base-mtime guard is still the detector;
//   - Keep mine is what clears a conflict — against a transport that enforces
//     the base mtime the way `fsops::write_note` does, a manual re-save of the
//     same buffer conflicts again and again;
//   - an in-app rename applies to the note it renamed, not to whichever note
//     is open when it returns, and it is ordered with the note's writes;
//   - the dirty-delete guard, refused because another dialog is up, keeps the
//     buffer and does not proceed.
//
// `EditorView` is shimmed exactly as editor.test.mjs shims it, for the reason
// that file gives: a real view needs layout the node runner does not have.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { installGlobals, AElement, ADocument } from './_minidom.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const IDLE_MS = 800

/** @type {any} */ let M
/** @type {any} */ let ED

AElement.prototype.appendChild = function (n) { this.append(n); return n }
AElement.prototype.removeAttribute = function (k) { this.attrs.delete(k) }

function makeDocument() {
  installGlobals()
  const doc = new ADocument()
  doc.body = doc.createElement('body')
  doc.hidden = false
  doc.documentElement.style = { webkitFontSmoothing: '' }
  const listeners = new Map()
  doc.addEventListener = (t, fn) => { (listeners.get(t) ?? listeners.set(t, []).get(t)).push(fn) }
  doc.removeEventListener = (t, fn) => {
    const l = listeners.get(t) ?? []
    const i = l.indexOf(fn)
    if (i >= 0) l.splice(i, 1)
  }
  return doc
}

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
  const dir = mkdtempSync(join(tmpdir(), 'cairn-recovery-'))
  process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })
  const out = join(dir, 'bundle.mjs')
  const shimPlugin = {
    name: 'view-shim',
    setup(build) {
      build.onResolve({ filter: /^@codemirror\/view$/ }, () => ({ path: '@codemirror/view', namespace: 'view-shim' }))
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
      resolveDir: ROOT, sourcefile: 'recovery-test-entry.ts', loader: 'ts',
    },
    outfile: out, bundle: true, format: 'esm', platform: 'neutral',
    mainFields: ['module', 'main'], conditions: ['import', 'default'], target: 'es2021',
    absWorkingDir: ROOT, plugins: [shimPlugin], logLevel: 'silent',
  })
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 ' +
        '(KHTML, like Gecko) Version/17.0 Safari/605.1.15',
      vendor: 'Apple Computer, Inc.', platform: 'MacIntel', maxTouchPoints: 0,
    },
  })
  globalThis.window = { __PIXELTEST__: true, addEventListener() {} }
  globalThis.document = makeDocument()
  M = await import(pathToFileURL(out).href)
  ED = M.ED
})

/**
 * A transport that behaves like `fsops::write_note` on the two points these
 * rows depend on: a write whose base mtime is not the file's current mtime is
 * refused as a conflict (step 1), and a missing file is `notFound` (step 1b).
 * `touch(path, text)` is an edit from outside the app.
 */
function makeDisk(files) {
  const calls = []
  let clock = 1000
  const disk = new Map(Object.entries(files).map(([p, t]) => [p, { text: t, mtime: clock }]))
  const ipc = {
    calls,
    disk,
    holdWrites: false,
    heldWrites: [],
    holdRenames: false,
    heldRenames: [],
    touch(path, text) { disk.set(path, { text, mtime: (clock += 7) }) },
    async readNote(path) {
      calls.push({ op: 'read', path })
      const f = disk.get(path)
      if (!f) throw { kind: 'notFound' }
      return { text: f.text, mtimeMs: f.mtime, flags: 0 }
    },
    async writeNote(path, text, flags, baseMtimeMs, create) {
      calls.push({ op: 'write', path, text, baseMtimeMs, create })
      if (ipc.holdWrites) await new Promise((r) => ipc.heldWrites.push(r))
      const f = disk.get(path)
      if (create) { if (f) throw { kind: 'alreadyExists' } }
      else if (!f) throw { kind: 'notFound' }
      if (!create && baseMtimeMs !== null && f.mtime !== baseMtimeMs) throw { kind: 'conflict' }
      disk.set(path, { text, mtime: (clock += 1) })
      return { mtimeMs: clock }
    },
    async renameEntry(path, name) {
      calls.push({ op: 'rename', path, name })
      if (ipc.holdRenames) await new Promise((r) => ipc.heldRenames.push(r))
      const to = path.includes('/') ? path.replace(/[^/]+$/, name) : name
      const f = disk.get(path)
      if (!f) throw { kind: 'notFound' }
      disk.delete(path)
      disk.set(to, f) // rename(2) keeps the mtime
      return { path: to }
    },
    async createNote(parent, name) {
      const path = (parent ? parent + '/' : '') + name + '.md'
      if (disk.has(path)) throw { kind: 'alreadyExists' }
      disk.set(path, { text: '', mtime: (clock += 1) })
      return { path }
    },
  }
  return ipc
}

const writes = (ipc) => ipc.calls.filter((c) => c.op === 'write')
const settle = () => new Promise((r) => setImmediate(r))

let mounted = false
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
const text = () => view().state.doc.toString()

/* ═══ §7.3 case 8 — the way back from a lost vault ════════════════════════ */

test('vault restored: a dirty note that went read-only autosaves again, to the same path', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const ipc = makeDisk({ 'a.md': 'alpha\n' })
  const states = []
  mount(ipc, { onNoteStateChanged: (s) => states.push(s) })
  await ED.openNote('a.md')
  type(' MINE')
  ED.markVaultLost()
  t.mock.timers.tick(IDLE_MS * 10)
  await settle()
  assert.deepEqual(writes(ipc), [], 'a lost vault must stop autosave')

  ED.resumeAfterVaultRestored()
  assert.equal(ED.currentNoteState(), 'live')
  assert.equal(states.at(-1), 'live', 'the shell must hear the note is live again (the bar goes)')
  t.mock.timers.tick(IDLE_MS)
  await settle()
  const w = writes(ipc)
  assert.equal(w.length, 1, 'the buffer never reached the disk after Re-open')
  assert.equal(w[0].path, 'a.md')
  assert.equal(w[0].create, false)
  assert.equal(ipc.disk.get('a.md').text, 'alpha\n MINE')
  assert.equal(ED.isDirty(), false)
})

test('vault restored: a note CHANGED while the vault was away comes back as a conflict, not an overwrite', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const ipc = makeDisk({ 'a.md': 'alpha\n' })
  mount(ipc)
  await ED.openNote('a.md')
  type(' MINE')
  ED.markVaultLost()
  ipc.touch('a.md', 'theirs\n')

  ED.resumeAfterVaultRestored()
  t.mock.timers.tick(IDLE_MS)
  await settle()
  await settle()
  assert.equal(ipc.disk.get('a.md').text, 'theirs\n', 'the other copy was overwritten')
  assert.equal(ED.currentNoteState(), 'conflict')
  assert.equal(ED.isDirty(), true)
})

test('vault restored: a CLEAN note resumes without writing, and only vault-lost resumes', async () => {
  const ipc = makeDisk({ 'a.md': 'alpha\n' })
  mount(ipc)
  await ED.openNote('a.md')
  ED.markVaultLost()
  ED.resumeAfterVaultRestored()
  assert.equal(ED.currentNoteState(), 'live')
  await ED.flushNow('idle')
  assert.deepEqual(writes(ipc), [])

  // A detached note is not the vault coming back: it stays detached.
  ED.markDetached()
  ED.resumeAfterVaultRestored()
  assert.equal(ED.currentNoteState(), 'detached')
})

/* ═══ §7.2 — Keep mine is the way out of a conflict ══════════════════════ */

test('a conflict persists through manual re-saves; Keep mine overwrites and keeps the loser', async () => {
  const ipc = makeDisk({ 'a.md': 'alpha\n' })
  mount(ipc)
  await ED.openNote('a.md')
  type(' MINE')
  ipc.touch('a.md', 'theirs\n')
  await ED.flushNow('idle').catch(() => {})
  assert.equal(ED.currentNoteState(), 'conflict')

  // Mod-S resends the same stale base, and the disk refuses it every time.
  for (let i = 0; i < 2; i += 1) {
    await ED.flushNow('manual').catch(() => {})
    assert.equal(ED.currentNoteState(), 'conflict')
  }
  assert.equal(ipc.disk.get('a.md').text, 'theirs\n')

  await ED.keepMine()
  assert.equal(ED.currentNoteState(), 'live')
  assert.equal(ED.isDirty(), false)
  assert.equal(ipc.disk.get('a.md').text, 'alpha\n MINE')
  const sidecar = [...ipc.disk.keys()].find((p) => p.startsWith('a.conflict-'))
  assert.ok(sidecar, 'the overwritten copy was not kept')
  assert.equal(ipc.disk.get(sidecar).text, 'theirs\n')
})

/* ═══ §7.3 case 4 — a rename applies to the note it renamed ══════════════ */

test('a rename that returns after a note switch leaves the newly opened note alone', async () => {
  const ipc = makeDisk({ 'a.md': 'alpha\n', 'b.md': 'bravo\n' })
  const seen = []
  mount(ipc, { onPathChanged: (p) => seen.push(p) })
  await ED.openNote('a.md')
  await ED.openNote('b.md')
  seen.length = 0

  ED.adoptRenamedPath('a.md', 'a2.md')
  assert.equal(ED.currentPath(), 'b.md', 'the open note was relabelled as the renamed file')
  assert.deepEqual(seen, [], 'the tab and the tree were told b.md is a2.md')

  type(' TYPED-IN-B')
  await ED.flushNow('manual')
  const w = writes(ipc).at(-1)
  assert.equal(w.path, 'b.md', "b's text was written to the renamed file")
  assert.equal(ipc.disk.get('b.md').text, 'bravo\n TYPED-IN-B')
})

test('a folder rename re-bases the open note under it; an unrelated prefix does not', async () => {
  const ipc = makeDisk({ 'Projects/x.md': 'x\n', 'Projectsx/y.md': 'y\n' })
  mount(ipc)
  await ED.openNote('Projects/x.md')
  ED.adoptRenamedPath('Projects', 'Work')
  assert.equal(ED.currentPath(), 'Work/x.md')

  await ED.openNote('Projectsx/y.md')
  ED.adoptRenamedPath('Projects', 'Other')
  assert.equal(ED.currentPath(), 'Projectsx/y.md', '`Projectsx` is not under `Projects`')
})

test('a rename on the write chain waits for the write in flight, and the next write follows it', async () => {
  const ipc = makeDisk({ 'a.md': 'alpha\n' })
  mount(ipc)
  await ED.openNote('a.md')
  type(' one')

  ipc.holdWrites = true
  const flush = ED.flushNow('idle')
  await settle()
  assert.equal(writes(ipc).length, 1, 'the write is in flight')

  const renamed = ED.runOnWriteChain(async () => {
    const r = await ipc.renameEntry('a.md', 'a2.md')
    ED.adoptRenamedPath('a.md', r.path)
    return r
  })
  await settle()
  assert.equal(ipc.calls.filter((c) => c.op === 'rename').length, 0,
    'the rename ran while a write to the same file was still in flight')

  ipc.holdWrites = false
  ipc.heldWrites.splice(0).forEach((r) => r())
  await flush
  await renamed
  assert.equal(ED.currentPath(), 'a2.md')
  assert.equal(ipc.disk.has('a.md'), false, 'the old path was re-created')

  type(' two')
  await ED.flushNow('idle')
  const w = writes(ipc).at(-1)
  assert.equal(w.path, 'a2.md')
  assert.equal(ipc.disk.get('a2.md').text, 'alpha\n one two')
  assert.equal(ED.currentNoteState(), 'live', 'the moved file kept its mtime, so the base still holds')
})

test('a write issued DURING a rename waits for it and lands on the new path', async () => {
  const ipc = makeDisk({ 'a.md': 'alpha\n' })
  mount(ipc)
  await ED.openNote('a.md')
  ipc.holdRenames = true
  const renamed = ED.runOnWriteChain(async () => {
    const r = await ipc.renameEntry('a.md', 'a2.md')
    ED.adoptRenamedPath('a.md', r.path)
    return r
  })
  await settle()
  type(' during')
  const flush = ED.flushNow('blur')
  await settle()
  assert.equal(writes(ipc).length, 0, 'a write overlapped the rename')
  ipc.heldRenames.splice(0).forEach((r) => r())
  await renamed
  await flush
  assert.deepEqual(writes(ipc).map((w) => w.path), ['a2.md'])
  assert.equal(ipc.disk.has('a.md'), false)
})

/* ═══ §1.6.1 behaviour 5 × §7.3 case 3 — a refused guard keeps the buffer ═ */

test('the dirty-delete guard, refused while another dialog is up, aborts and keeps the buffer', async () => {
  globalThis.document = makeDocument()
  const ipc = makeDisk({ 'Misc.md': 'misc\n' })
  mount(ipc)
  await ED.openNote('Misc.md')
  type(' unsaved')
  const errs = []
  const realError = console.error
  console.error = (...a) => errs.push(a.join(' '))
  try {
    // The delete-failure report's shape: its default is `keep`, which is not
    // an answer the guard's dialog offers.
    const other = M.openModal({
      title: 'Could not delete x', detail: 'y',
      buttons: [{ id: 'keep', label: 'OK' }, { id: 'reveal', label: 'Show in Finder' }],
      defaultId: 'keep',
    })
    ipc.calls.length = 0
    const guard = await ED.guardDeleteOfOpenNote('Misc')
    assert.equal(guard, 'abort', 'a refused prompt was read as "Delete without saving"')
    assert.equal(ED.isDirty(), true)
    assert.equal(ED.currentPath(), 'Misc.md')
    assert.deepEqual(writes(ipc), [])
    assert.equal(errs.length, 1, 'the refusal was silent')

    const back = globalThis.document.body.querySelector('.nc-modal-back')
    back.querySelector('[data-id="keep"]').dispatch('click', { preventDefault() {}, stopPropagation() {} })
    assert.equal(await other, 'keep')
  } finally {
    console.error = realError
  }
})

test('a refused second dialog answers with its OWN default, whatever the open one says', async () => {
  globalThis.document = makeDocument()
  const realError = console.error
  console.error = () => {}
  try {
    const first = M.openModal({
      title: 'Delete file', detail: 'y',
      buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'delete', label: 'Delete', destructive: true }],
      defaultId: 'cancel',
    })
    const quit = await M.openModal({
      title: 'This note could not be saved.', detail: 'z',
      buttons: [{ id: 'keep', label: 'Keep editing' }, { id: 'quit', label: 'Discard changes and quit', destructive: true }],
      defaultId: 'keep',
    })
    assert.equal(quit, 'keep')
    const back = globalThis.document.body.querySelector('.nc-modal-back')
    back.querySelector('[data-id="cancel"]').dispatch('click', { preventDefault() {}, stopPropagation() {} })
    assert.equal(await first, 'cancel')
    assert.equal(M.modalIsOpen(), false)
  } finally {
    console.error = realError
  }
})
