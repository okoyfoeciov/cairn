// Owner: 03.  `node --test tests/frontend/`.
// Spec: CONTRACT.md §7.1 (the three structural rules — rule 1 is `create` false
// on every autosave path), §7.2 (the autosave contract and its two timers),
// §7.3 cases 3/4/5/7/8/11, §1.6 (the flush-on-quit handshake), §5.4.2 (the
// rename validation shared with the tree's editor), §5.11 (the harness seam),
// §7.4 (the empty state), §9.2/§9.6, §6.4 (this file's row).
//
// ===========================================================================
// WHY THIS FILE SHIMS `EditorView`, AND ONLY `EditorView`
// ===========================================================================
// `src/editor.ts` constructs a real `EditorView`, which needs layout, `Range`,
// `MutationObserver` and `getComputedStyle`.  `_minidom.mjs` has none of those
// and jsdom is not in the dependency set — CONTRACT §6.3 pins esbuild and
// typescript and nothing else — so a real view cannot be mounted here.
//
// So the subject is bundled with ONE module substituted: an esbuild plugin
// rewrites `@codemirror/view` to a shim that re-exports the REAL module and
// overrides only the `EditorView` CLASS.  Every static on it — the
// `updateListener`, `atomicRanges`, `decorations`, `contentAttributes` and
// `darkTheme` facets — is copied off the real class rather than named one by
// one, so `EXTENSIONS` is the shipped extension set and a real `EditorState`
// resolves it for real.
//
// What that buys: the state machine under test is the SHIPPED code — the real
// two timers, the real `docGen` guard, the real serialising promise chain, the
// real `EditorState`/`ChangeSet`/rope.  What it gives up: everything needing
// pixels (the marker reveal's layout, the title widget's DOM, scrollIntoView).
// Those belong to livepreview.test.mjs and to the geometry probe, not here.
//
// The view is reached through §5.11's OWN seam — `window.__PIXELTEST__` makes
// `mountEditor` publish `window.__CM_VIEW__` — so this file adds no test-only
// door to the shipped module.
// ===========================================================================

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '..', '..')

const IDLE_MS = 800    // §7.2
const MAX_MS = 5000    // §7.2

/** @type {any} */ let ED

/* =========================================================================
 * 0.  Build the subject.
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

  // The statics ARE the facets EXTENSIONS is built from.  Copy them all, rather
  // than naming five and silently losing the sixth when the set grows.
  for (const k of Object.getOwnPropertyNames(RealEditorView)) {
    if (k === 'prototype' || k === 'name' || k === 'length') continue
    Object.defineProperty(EditorView, k, Object.getOwnPropertyDescriptor(RealEditorView, k))
  }
`

before(async () => {
  const esbuild = await import(
    pathToFileURL(join(ROOT, 'node_modules', 'esbuild', 'lib', 'main.js')).href
  )
  const dir = mkdtempSync(join(tmpdir(), 'cairn-ed-'))
  // Same guard tree.test.mjs and search.test.mjs use: registered on the
  // dir the moment it exists, BEFORE the bundle step, so a throw out of
  // esbuild or a failing assertion still takes the fixture with it.
  process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })
  const out = join(dir, 'bundle.mjs')

  const shimPlugin = {
    name: 'view-shim',
    setup(build) {
      build.onResolve({ filter: /^@codemirror\/view$/ }, () => ({
        path: '@codemirror/view',
        namespace: 'view-shim',
      }))
      build.onLoad({ filter: /.*/, namespace: 'view-shim' }, () => ({
        contents: VIEW_SHIM,
        loader: 'ts',
        resolveDir: ROOT,
      }))
      // The real module, resolved on the file system so the shim can re-export it.
      build.onResolve({ filter: /^@codemirror\/view__real$/ }, () => ({
        path: join(ROOT, 'node_modules', '@codemirror', 'view', 'dist', 'index.js'),
      }))
    },
  }

  await esbuild.build({
    stdin: {
      /* Plus ONE re-export from the same bundle: §7.1's Tab bindings are reached
         through CM6's own public `runScopeHandlers`, which resolves a key event
         against the `keymap` FACET. A facet is identified by object identity, so
         it has to be the bundle's copy of `@codemirror/view` and not a second
         import in this file — that one would carry a different `keymap` facet
         and find no bindings at all. This is a harness re-export, not a
         test-only door in `src/editor.ts`: nothing is added to the shipped
         module and the commands are still reached only through the real
         keymap. */
      contents: 'export * from ' + JSON.stringify(join(ROOT, 'src', 'editor.ts')) + '\n'
        + "export { runScopeHandlers } from '@codemirror/view'\n",
      resolveDir: ROOT,
      sourcefile: 'editor-test-entry.ts',
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

  // `mountEditor` touches `window` and `document` and nothing further into either.
  const listeners = new Map()
  globalThis.window = {
    __PIXELTEST__: true,           // §5.11 — publishes `window.__CM_VIEW__`
    addEventListener: (t, f) => listeners.set(t, f),
    fire: (t) => listeners.get(t)?.(),
  }
  globalThis.document = {
    hidden: false,
    documentElement: { style: { webkitFontSmoothing: '' } },
    addEventListener: (t, f) => listeners.set('doc:' + t, f),
    fire: (t) => listeners.get('doc:' + t)?.(),
  }

  ED = await import(pathToFileURL(out).href)
})

/* =========================================================================
 * 1.  A recording transport, and the harness around it.
 * ======================================================================= */

function makeIpc(files = { 'a.md': 'alpha\n' }) {
  const calls = []
  const ipc = {
    files: { ...files },
    calls,
    /** Set to a VaultErrorLike to make the NEXT writeNote reject. */
    failWriteWith: null,
    /** Resolvers for in-flight writes, when `holdWrites` is on. */
    holdWrites: false,
    pending: [],
    mtime: 1000,
    // F66: per-path mtimes, enforced like `core/src/fsops.rs` step 1 — a
    // write whose base predates the disk version conflicts instead of
    // silently succeeding. A one-shot `failWriteWith` still resolves on
    // retry (the failed write bumps nothing), so existing rows are unaffected.
    mtimes: {},
    async readNote(path) {
      calls.push({ op: 'read', path })
      const text = ipc.files[path]
      if (text === undefined) throw { kind: 'notFound' }
      if (ipc.mtimes[path] === undefined) ipc.mtimes[path] = ipc.mtime
      return { text, mtimeMs: ipc.mtimes[path], flags: 0 }
    },
    async writeNote(path, text, flags, baseMtimeMs, create) {
      calls.push({ op: 'write', path, text, flags, baseMtimeMs, create })
      if (ipc.holdWrites) await new Promise((r) => ipc.pending.push(r))
      const err = ipc.failWriteWith
      if (err) { ipc.failWriteWith = null; throw err }
      if (!create && baseMtimeMs !== null && baseMtimeMs !== undefined) {
        const cur = ipc.mtimes[path] ?? ipc.mtime
        if (baseMtimeMs !== cur) throw { kind: 'conflict', message: 'changed on disk' }
      }
      ipc.files[path] = text
      ipc.mtime += 1
      ipc.mtimes[path] = ipc.mtime
      return { mtimeMs: ipc.mtime }
    },
    async renameEntry(path, name) {
      calls.push({ op: 'rename', path, name })
      const to = path.replace(/[^/]+$/, name)
      ipc.files[to] = ipc.files[path]
      delete ipc.files[path]
      return { path: to }
    },
  }
  return ipc
}

const writes = (ipc) => ipc.calls.filter((c) => c.op === 'write')

let mounted = false

/**
 * EXACTLY ONE `EditorView` FOR THE PROCESS LIFETIME (M70), so this mounts once
 * and every later test re-points the transport and re-opens.  `showEmpty()`
 * first: it drops the buffer WITHOUT writing (§7.4), so a test never inherits
 * the previous test's dirt and never writes it to the previous test's ipc.
 */
function mount(ipc) {
  if (mounted) ED.showEmpty()
  ED.configureEditor(ipc)
  ED.setEditorHooks({})
  if (!mounted) { ED.mountEditor({}); mounted = true }
}

const view = () => globalThis.window.__CM_VIEW__

/** One user edit at the end of the document. */
function type(text) {
  const v = view()
  v.dispatch({ changes: { from: v.state.doc.length, insert: text } })
}

/** Let the promise chain settle without advancing any mocked timer. */
const settle = () => new Promise((r) => setImmediate(r))

/**
 * One real Tab (or Shift-Tab) through the SHIPPED keymap.  `runScopeHandlers`
 * is CM6's own public resolver, so this exercises the binding as well as the
 * command: a Tab that stopped being bound, or that lost `preventDefault`, fails
 * here rather than quietly doing nothing.
 */
function tab(shift = false) {
  const ev = {
    key: 'Tab',
    keyCode: 9,
    shiftKey: shift,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    preventDefault() {},
    stopPropagation() {},
  }
  /* `runScopeHandlers` RETURNS whether the key was swallowed; it never calls
     `event.preventDefault()` itself — CM's own `keydown` handler does that from
     this return value. And `if (prevented) handled = true` at the end of
     `runHandlers` means a binding carrying `preventDefault: true` returns true
     even when its command REFUSED, so this answers "was the key consumed", not
     "did the command run". The document is what says the latter. */
  return { handled: ED.runScopeHandlers(view(), ev, 'editor') }
}

const doc = () => view().state.doc.toString()
const sel = () => {
  const r = view().state.selection.main
  return [r.from, r.to]
}

/* =========================================================================
 * 1b.  §7.1's INDENTATION.  Obsidian's Tab is CodeMirror's `indentMore`, bound
 *      unconditionally (`app.js:67972` -> `indentList()` -> `exec("indentMore")`
 *      -> `VH(this.cm6)`), and Shift-Tab is `indentLess` by the same route.
 *
 *      THERE WAS NO TEST HERE AT ALL, AND THAT IS WHY IT SHIPPED BROKEN.  The
 *      old `insertIndent` wrote `{from: range.from, to: range.to, insert: "    "}`
 *      — a REPLACEMENT — so Tab with a selection DELETED the selected text.
 *      Every row below is written so that the old code fails it.
 * ======================================================================= */

test('§7.1: Tab with a multi-line selection INDENTS the lines, it does not replace them', async () => {
  mount(makeIpc({ 'a.md': 'one\ntwo\nthree\n' }))
  await ED.openNote('a.md')
  // From the start of `one` to the end of `three` — three whole lines.
  view().dispatch({ selection: { anchor: 0, head: 13 } })
  assert.equal(tab().handled, true, 'Tab must be bound, and consumed so focus cannot leave')
  assert.equal(doc(), '    one\n    two\n    three\n')
  // And the SAME TEXT is still selected: `mapPos(_, 1)` associates forward, so
  // the selection does not swallow the indent inserted in front of it.
  assert.deepEqual(sel(), [4, 25])
  assert.equal(view().state.sliceDoc(4, 25), 'one\n    two\n    three')
})

test('§7.1: Shift-Tab dedents EVERY selected line, not just the first', async () => {
  mount(makeIpc({ 'a.md': '    one\n    two\n    three\n' }))
  await ED.openNote('a.md')
  view().dispatch({ selection: { anchor: 0, head: 25 } })
  assert.equal(tab(true).handled, true)
  assert.equal(doc(), 'one\ntwo\nthree\n')
})

/* Obsidian has no cursor branch: `indentMore` is `changeBySelectedLine`, so the
 * unit lands at the LINE START wherever the caret happens to be.  The old code
 * inserted at the caret, which is the one case it got visibly right and is
 * still not what Obsidian does. */
test('§7.1: Tab with a bare caret indents the LINE, not the caret position', async () => {
  mount(makeIpc({ 'a.md': 'hello world\n' }))
  await ED.openNote('a.md')
  view().dispatch({ selection: { anchor: 5 } })      // between `hello` and ` world`
  tab()
  assert.equal(doc(), '    hello world\n')
  assert.equal(sel()[0], 9, 'the caret rides with its own text')
})

/* A level is measured in COLUMNS, not in characters.  A tab-indented line is
 * one level in — §0.51 E99 quantises a whole tab and four whole spaces to the
 * same 36px for exactly this reason — so Shift-Tab must take the tab, and a
 * doubly-tabbed line must keep one level. */
test('§7.1: Shift-Tab measures a level in columns, so one tab is one level', async () => {
  mount(makeIpc({ 'a.md': '\tone\n\t\ttwo\n  three\n' }))
  await ED.openNote('a.md')
  view().dispatch({ selection: { anchor: 0, head: view().state.doc.length } })
  tab(true)
  assert.equal(doc(), 'one\n    two\nthree\n',
    'one tab -> nothing; two tabs -> one level of four spaces; two spaces -> nothing')
})

/* `changeBySelectedLine`'s `range.to > line.from` guard.  A selection that ends
 * exactly at a line start must not indent that line: dragging to the beginning
 * of line 3 selects lines 1-2. */
test('§7.1: a selection ending at a line start does not indent that line', async () => {
  mount(makeIpc({ 'a.md': 'one\ntwo\nthree\n' }))
  await ED.openNote('a.md')
  view().dispatch({ selection: { anchor: 0, head: 8 } })   // `one\ntwo\n` -> start of `three`
  tab()
  assert.equal(doc(), '    one\n    two\nthree\n')
})

/* CM's own first line in both commands, and Cairn had neither: a read-only
 * state must REFUSE the command rather than dispatch a transaction the
 * `readOnly` filter then silently drops. */
test('§9.5: Tab is consumed but writes nothing in a read-only note state', async () => {
  mount(makeIpc({ 'a.md': 'one\ntwo\n' }))
  await ED.openNote('a.md')
  ED.markDetached()
  assert.equal(view().state.readOnly, true, 'the precondition, or this proves nothing')
  view().dispatch({ selection: { anchor: 0, head: 7 } })
  /* STILL CONSUMED: `preventDefault: true` swallows Tab whether or not the
     command ran, which is what keeps focus inside a read-only note instead of
     tabbing out of the editor. What must NOT happen is a write. */
  assert.equal(tab().handled, true)
  assert.equal(tab(true).handled, true)
  assert.equal(doc(), 'one\ntwo\n', 'a read-only note must not be indented')
  assert.deepEqual(sel(), [0, 7], 'and the selection must not move either')
})

/* =========================================================================
 * 2.  §5.4.2 / §7.3 case 11 — the name validation, shared with the tree.
 * ======================================================================= */

test('validateName: the nine reserved characters are each rejected', () => {
  for (const ch of ['\\', '/', ':', '*', '?', '"', '<', '>', '|']) {
    assert.equal(
      ED.validateName('ok' + ch + 'no'),
      'Name contains an illegal character',
      `${JSON.stringify(ch)} must be rejected`
    )
  }
})

test('validateName: control characters U+0000..U+001F are rejected', () => {
  for (const code of [0x00, 0x09, 0x0a, 0x1f]) {
    assert.equal(
      ED.validateName('a' + String.fromCharCode(code) + 'b'),
      'Name contains an illegal character',
      `U+${code.toString(16).padStart(4, '0')} must be rejected`
    )
  }
})

test('validateName: the /g regex is stateful — repeated calls must not alternate', () => {
  // BAD_CHARS carries /g and therefore a shared `lastIndex`.  A missing reset
  // makes every SECOND call on the same bad name return null, which would let
  // an illegal name straight through to `rename_entry`.
  for (let i = 0; i < 4; i += 1) {
    assert.equal(ED.validateName('a:b'), 'Name contains an illegal character', `call ${i}`)
  }
  assert.equal(ED.validateName('fine'), null)
  assert.equal(ED.validateName('a:b'), 'Name contains an illegal character')
})

test('validateName: the name-level rules', () => {
  assert.equal(ED.validateName(''), 'Name cannot be empty')
  assert.equal(ED.validateName('   '), 'Name cannot be empty')
  assert.equal(ED.validateName('.'), 'Name cannot be "." or ".."')
  assert.equal(ED.validateName('..'), 'Name cannot be "." or ".."')
  assert.equal(ED.validateName(' lead'), 'Name cannot start or end with a space')
  assert.equal(ED.validateName('trail '), 'Name cannot start or end with a space')
  assert.equal(ED.validateName('dot.'), 'Name cannot end with a dot')
  assert.equal(ED.validateName('CON'), 'Name is reserved on Windows')
  assert.equal(ED.validateName('con.md'), 'Name is reserved on Windows')
  assert.equal(ED.validateName('COM9'), 'Name is reserved on Windows')
  assert.equal(ED.validateName('CONSOLE'), null, 'CON matches a whole segment, not a prefix')
  assert.equal(ED.validateName('Notes'), null)
  assert.equal(ED.validateName('日本語のノート'), null)
})

test('validateName: the 255 limit is counted in BYTES, not UTF-16 units', () => {
  // 85 CJK characters are 255 UTF-8 bytes but only 85 code units.  A check in
  // the wrong unit would accept 255 of them — 765 bytes — and the filesystem
  // would then refuse the write with an error the user cannot act on.
  assert.equal(ED.validateName('あ'.repeat(85)), null, '255 bytes is the inclusive limit')
  assert.equal(ED.validateName('あ'.repeat(86)), 'Name is too long', '258 bytes must be refused')
  assert.equal(ED.validateName('a'.repeat(255)), null)
  assert.equal(ED.validateName('a'.repeat(256)), 'Name is too long')
})

/* =========================================================================
 * 3.  §7.1 rule 1 — `create` is FALSE on every autosave path.  This is the
 *     invariant that makes "delete the open note, autosave resurrects it"
 *     impossible BY CONSTRUCTION rather than by winning a race.
 * ======================================================================= */

for (const reason of ['idle', 'max', 'switch', 'blur', 'hidden', 'close', 'manual']) {
  test(`§7.1 rule 1: flushNow('${reason}') writes with create === false`, async () => {
    const ipc = makeIpc({ 'a.md': 'alpha\n' })
    mount(ipc)
    await ED.openNote('a.md')
    type('edited')
    assert.equal(ED.isDirty(), true, 'the edit must have dirtied the buffer')
    ipc.calls.length = 0
    await ED.flushNow(reason).catch(() => {})
    const w = writes(ipc)
    assert.equal(w.length, 1, 'a dirty buffer flushes exactly once')
    assert.equal(w[0].create, false, `flush(${reason}) must never set create`)
    assert.equal(w[0].path, 'a.md')
    assert.equal(w[0].baseMtimeMs, 1000, 'the read mtime is the conflict guard')
  })
}

test('§7.1 rule 1: the idle timer firing on its own also writes create === false', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const ipc = makeIpc({ 'a.md': 'alpha\n' })
  mount(ipc)
  await ED.openNote('a.md')
  ipc.calls.length = 0
  type('x')
  assert.deepEqual(writes(ipc), [], 'nothing is written before the debounce elapses')
  t.mock.timers.tick(IDLE_MS)
  await settle()
  const w = writes(ipc)
  assert.equal(w.length, 1)
  assert.equal(w[0].create, false)
})

test('§7.2: the idle timer is a DEBOUNCE — it restarts on every keystroke', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const ipc = makeIpc({ 'a.md': 'alpha\n' })
  mount(ipc)
  await ED.openNote('a.md')
  ipc.calls.length = 0
  for (let i = 0; i < 4; i += 1) {
    type('x')
    t.mock.timers.tick(IDLE_MS - 100)
    await settle()
  }
  assert.deepEqual(writes(ipc), [], 'steady typing under 800 ms apart never flushes on idle')
  t.mock.timers.tick(100)
  await settle()
  assert.equal(writes(ipc).length, 1)
})

test('§7.2: the ceiling is measured from the FIRST unsaved keystroke, not the last', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const ipc = makeIpc({ 'a.md': 'alpha\n' })
  mount(ipc)
  await ED.openNote('a.md')
  ipc.calls.length = 0
  // Type every 700 ms, so the 800 ms debounce never elapses.  Without a ceiling
  // anchored to the first keystroke, an unbroken typist would never autosave.
  for (let i = 0; i < 8; i += 1) {
    type('x')
    t.mock.timers.tick(700)
    await settle()
  }
  const w = writes(ipc)
  assert.ok(w.length >= 1, `the ${MAX_MS} ms ceiling must fire under continuous typing`)
  for (const c of w) assert.equal(c.create, false)
})

test('§7.1 rule 1: saveAs is the ONLY producer of create === true (X16)', async () => {
  const ipc = makeIpc({ 'a.md': 'alpha\n' })
  mount(ipc)
  await ED.openNote('a.md')
  ipc.calls.length = 0
  await ED.saveAs('b.md')
  const w = writes(ipc)
  assert.equal(w.length, 1)
  assert.equal(w[0].create, true, 'Save as… is the single create:true call site in the app')
  assert.equal(w[0].baseMtimeMs, null, 'there is nothing to conflict against on a create')
  assert.equal(w[0].path, 'b.md')
  assert.equal(ED.currentPath(), 'b.md', 'the editor follows the note to its new path')
})

test('§7.3 case 7 Keep mine: keepMine forces the overwrite but still never creates', async () => {
  const ipc = makeIpc({ 'a.md': 'alpha\n' })
  mount(ipc)
  await ED.openNote('a.md')
  type('mine')
  ipc.calls.length = 0
  await ED.keepMine().catch(() => {})
  const w = writes(ipc)
  assert.equal(w.length, 1)
  assert.equal(w[0].create, false)
  assert.equal(w[0].baseMtimeMs, null, 'a null base mtime is the force-overwrite signal')
})

test('§7.3 case 7 Keep mine snapshots the disk loser to a .conflict- sidecar first', async () => {
  const ipc = makeIpc({ 'a.md': 'theirs\n' })
  ipc.createNote = async (parent, name) => {
    ipc.calls.push({ op: 'create', parent, name })
    const path = parent ? parent + '/' + name + '.md' : name + '.md'
    if (ipc.files[path] !== undefined) throw { kind: 'alreadyExists' }
    ipc.files[path] = ''
    return { path }
  }
  mount(ipc)
  await ED.openNote('a.md')
  type('mine')
  await ED.keepMine()
  // The loser's bytes survive beside the note; the winner is in place.
  const backups = Object.keys(ipc.files).filter((p) => /^a\.conflict-\d+(\-\d+)?\.md$/.test(p))
  assert.equal(backups.length, 1, 'exactly one conflict sidecar: ' + JSON.stringify(Object.keys(ipc.files)))
  assert.equal(ipc.files[backups[0]], 'theirs\n', 'the sidecar holds the DISK version, not the buffer')
  assert.match(ipc.files['a.md'], /mine/, 'the overwrite still landed')
})

test('§7.3 case 7 Keep mine still overwrites when the backup cannot be taken', async () => {
  const ipc = makeIpc({ 'a.md': 'theirs\n' })
  ipc.createNote = async () => { throw { kind: 'io', message: 'no room' } }
  mount(ipc)
  await ED.openNote('a.md')
  type('mine')
  await ED.keepMine()
  assert.match(ipc.files['a.md'], /mine/, 'a failed backup must never veto the overwrite the user asked for')
})

/* =========================================================================
 * 4.  THE ONE WRITE CHAIN.
 *
 * `settleWrites()` is what closes finding F3's ~5.04 ms in-flight window, and
 * it closes it by awaiting `chain` — whose tail is the `writeNote` INVOKE, so
 * it resolves only after Rust's step 8 rename.  That argument is only as good
 * as the claim that EVERY write is on the chain.  `saveAs()` used to call
 * `writeNote` directly, so it was not, and `settleWrites()` could return with a
 * *Save as…* rename genuinely running inside Rust.
 *
 * `beforeDelete()` used to live here.  It was two lines — `cancelTimers()` —
 * and `main.ts` stopped importing it when `deleteFlow` moved to
 * `guardDeleteOfOpenNote()`, which cancels the timers itself as step 1.  Its
 * only remaining caller was this test, so both are gone; the behaviour it
 * asserted is covered by the guard's own rows in `dirty-delete.test.mjs` and
 * `modal.test.mjs`.
 * ======================================================================= */

test('settleWrites() waits for an in-flight saveAs, not just an autosave', async () => {
  // The regression, exactly: with `saveAs` writing outside `chain`, the two
  // `assert.equal(settled, false)` rows below both pass with `settled === true`
  // — `settleWrites()` resolves on an empty chain while the create is still on
  // the wire, and the §7.3 case 3 guard would return 'proceed' behind it.
  const ipc = makeIpc({ 'a.md': 'alpha\n' })
  mount(ipc)
  await ED.openNote('a.md')
  ipc.calls.length = 0

  ipc.holdWrites = true
  const save = ED.saveAs('b.md')
  await settle()
  assert.equal(writes(ipc).length, 1, 'the saveAs never reached the transport')
  assert.equal(writes(ipc)[0].create, true)

  let settled = false
  const s = ED.settleWrites().then(() => { settled = true })
  await settle()
  await settle()
  assert.equal(settled, false, 'settleWrites() returned with a Save as… still in flight')

  ipc.holdWrites = false
  ipc.pending.forEach((r) => r())
  ipc.pending.length = 0
  await save
  await s
  assert.equal(settled, true, 'settleWrites() never resolved once the write landed')
  assert.equal(ED.currentPath(), 'b.md')
})

test('settleWrites() does not resolve early when a saveAs is queued BEHIND a flush', async () => {
  // The chain must serialise the two, so settling waits for the tail — the
  // create — and not merely for the autosave that was already running.
  const ipc = makeIpc({ 'a.md': 'alpha\n' })
  mount(ipc)
  await ED.openNote('a.md')
  type('edited')
  ipc.calls.length = 0

  ipc.holdWrites = true
  const flush = ED.flushNow('idle')
  const save = ED.saveAs('c.md')
  await settle()
  assert.equal(writes(ipc).length, 1, 'the two writes did not serialise — both went out at once')

  let settled = false
  const s = ED.settleWrites().then(() => { settled = true })

  // Release ONLY the autosave.  The Save as… then starts, and is held in turn —
  // which is the state `settleWrites()` must not resolve in.
  ipc.pending.shift()()
  await settle()
  assert.equal(writes(ipc).length, 2, 'the queued Save as… never started')
  assert.equal(settled, false, 'settled while the queued saveAs was still in flight')

  ipc.holdWrites = false
  ipc.pending.forEach((r) => r())
  ipc.pending.length = 0
  await flush.catch(() => {})
  await save
  await s
  assert.equal(settled, true)
  const w = writes(ipc)
  assert.equal(w.length, 2)
  assert.equal(w[0].create, false, 'the autosave ran first')
  assert.equal(w[1].create, true, 'the Save as… ran second, on the same chain')
  assert.equal(w[1].path, 'c.md')
})

test('a REJECTED saveAs does not poison the chain the next write runs on', async () => {
  const ipc = makeIpc({ 'a.md': 'alpha\n' })
  mount(ipc)
  await ED.openNote('a.md')
  ipc.failWriteWith = { kind: 'alreadyExists' }
  await assert.rejects(() => ED.saveAs('taken.md'), (e) => e.kind === 'alreadyExists')
  assert.equal(ED.currentPath(), 'a.md', 'a refused Save as… must leave the editor where it was')

  assert.equal(await ED.settleWrites().then(() => 'ok', () => 'rejected'), 'ok')
  type('still writable')
  ipc.calls.length = 0
  await ED.flushNow('manual')
  assert.equal(writes(ipc).length, 1, 'the chain was poisoned by the refused Save as…')
})

/* =========================================================================
 * 4a.  A RESOLVED FLUSH IS NOT PROOF OF A WRITE (§7.2, §9.5).
 *
 * `write()` returns early — and RESOLVING — when `noteState !== 'live'` and the
 * reason is not `manual`.  §7.3 case 3's "Save and delete" is the caller this
 * bit: it awaited `flushNow('delete')`, got a resolved promise, and deleted a
 * file it had not saved.  Every row below asserts the resolution AND the
 * absence of a write together, because either one alone looks correct.
 *
 * `flushWouldSkip(reason)` is that condition, named and exported, and `write()`
 * calls it rather than restating it — so these rows pin the exported predicate
 * and the real code path at the same time.
 * ======================================================================= */

for (const [label, arm] of [
  ['conflict', async (ipc) => {
    ipc.failWriteWith = { kind: 'conflict' }
    await ED.flushNow('manual').catch(() => {})
  }],
  ['detached', async () => { ED.markDetached() }],
  ['vault-lost', async () => { ED.markVaultLost() }],
]) {
  test(`§9.5: on a ${label} note flushNow('idle') RESOLVES having written nothing`, async () => {
    const ipc = makeIpc({ 'a.md': 'alpha\n' })
    mount(ipc)
    await ED.openNote('a.md')
    type(' mine')
    await arm(ipc)
    assert.equal(ED.currentNoteState(), label)
    assert.equal(ED.isDirty(), true, 'the fixture lost the dirty buffer')
    ipc.calls.length = 0

    assert.equal(ED.flushWouldSkip('idle'), true, 'flushWouldSkip must see the skip coming')
    // RESOLVES.  Not `.catch(() => {})` — a rejection here would be a different
    // (and safer) bug, and this row exists to prove it is not what happens.
    assert.equal(
      await ED.flushNow('idle').then(() => 'resolved', () => 'rejected'),
      'resolved',
      'a caller cannot tell the skip from a success by the promise alone'
    )
    assert.deepEqual(writes(ipc), [], 'the resolved flush wrote nothing at all')
    assert.equal(ED.isDirty(), true, 'the buffer is STILL DIRTY after a resolved flush')
  })
}

test("§9.5: `manual` is the single exemption — it writes on a conflicted note", async () => {
  const ipc = makeIpc({ 'a.md': 'alpha\n' })
  mount(ipc)
  await ED.openNote('a.md')
  type(' mine')
  ipc.failWriteWith = { kind: 'conflict' }
  await ED.flushNow('manual').catch(() => {})
  assert.equal(ED.currentNoteState(), 'conflict')
  ipc.calls.length = 0

  assert.equal(ED.flushWouldSkip('manual'), false, 'manual must NOT be skipped')
  for (const r of ['idle', 'max', 'switch', 'blur', 'hidden', 'close', 'delete']) {
    assert.equal(ED.flushWouldSkip(r), true, `${r} must be skipped on a conflicted note`)
  }
  await ED.flushNow('manual')
  assert.equal(writes(ipc).length, 1, 'the user asking in so many words must reach the disk')
  assert.equal(ED.isDirty(), false)
  assert.equal(ED.currentNoteState(), 'live', 'a successful manual write clears the conflict')
})

test('a conflicted dirty buffer is NOT dropped by a note switch (resolved flush still aborts)', async () => {
  const ipc = makeIpc({ 'a.md': 'alpha\n', 'b.md': 'beta\n' })
  mount(ipc)
  await ED.openNote('a.md')
  type(' mine')
  ipc.failWriteWith = { kind: 'conflict' }
  await ED.flushNow('idle').catch(() => {})
  assert.equal(ED.currentNoteState(), 'conflict')
  assert.equal(ED.isDirty(), true)
  const r = await ED.openNote('b.md')
  assert.equal(r.ok, false, 'the switch must abort when the flush was skipped')
  assert.equal(ED.currentPath(), 'a.md', 'the conflicted note stays open with its buffer intact')
  assert.equal(ED.isDirty(), true)
})

test('flushWouldSkip agrees with what flushNow actually does, row for row', async () => {
  // The predicate is `write()`'s own guard, so a drift between them is the whole
  // failure mode.  Walk the states and check the prediction against the writes.
  const ipc = makeIpc({ 'a.md': 'alpha\n' })
  mount(ipc)

  // No note open.
  ED.showEmpty()
  assert.equal(ED.flushWouldSkip('manual'), true, 'no note open is a skip')

  // Open and CLEAN.
  await ED.openNote('a.md')
  assert.equal(ED.flushWouldSkip('idle'), true, 'a clean buffer is a skip')
  ipc.calls.length = 0
  await ED.flushNow('idle')
  assert.deepEqual(writes(ipc), [])

  // Open, dirty and live.
  type('x')
  assert.equal(ED.flushWouldSkip('idle'), false)
  ipc.calls.length = 0
  await ED.flushNow('idle')
  assert.equal(writes(ipc).length, 1)
  assert.equal(ED.flushWouldSkip('idle'), true, 'clean again after the write')
})

/* =========================================================================
 * 5.  §7.2 — Conflict stops autosave for this note.
 * ======================================================================= */

test('§7.2: a Conflict leaves the buffer dirty and stops the autosave timers', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const ipc = makeIpc({ 'a.md': 'alpha\n' })
  mount(ipc)
  await ED.openNote('a.md')
  type('mine')
  ipc.failWriteWith = { kind: 'conflict' }
  await ED.flushNow('idle').catch(() => {})

  assert.equal(ED.currentNoteState(), 'conflict')
  assert.equal(ED.isDirty(), true, 'the buffer must NOT be marked clean by a refused write')

  ipc.calls.length = 0
  type('more')
  t.mock.timers.tick(MAX_MS + IDLE_MS + 1000)
  await settle()
  assert.deepEqual(writes(ipc), [], 'autosave stops for this note until the user resolves it')
})

test('§7.2: flushNow REJECTS on a refused write — §1.6 and §4.3 depend on it', async () => {
  const ipc = makeIpc({ 'a.md': 'alpha\n' })
  mount(ipc)
  await ED.openNote('a.md')
  type('mine')
  ipc.failWriteWith = { kind: 'permission' }
  await assert.rejects(
    () => ED.flushNow('close'),
    (e) => e.kind === 'permission',
    'a swallowed rejection would let the app quit and lose the buffer'
  )
})

/* =========================================================================
 * 6.  §1.6 — the flush-on-quit handshake.
 * ======================================================================= */

test('§1.6: onFlushAndClose returns {ok:true} for a clean buffer, writing nothing', async () => {
  const ipc = makeIpc({ 'a.md': 'alpha\n' })
  mount(ipc)
  await ED.openNote('a.md')
  ipc.calls.length = 0
  assert.deepEqual(await ED.onFlushAndClose(), { ok: true })
  assert.deepEqual(writes(ipc), [], 'a non-dirty buffer must not write on quit')
})

test('§1.6: onFlushAndClose flushes a dirty buffer and reports ok', async () => {
  const ipc = makeIpc({ 'a.md': 'alpha\n' })
  mount(ipc)
  await ED.openNote('a.md')
  type(' and more')
  ipc.calls.length = 0
  assert.deepEqual(await ED.onFlushAndClose(), { ok: true })
  assert.equal(writes(ipc).length, 1)
  assert.match(ipc.files['a.md'], / and more$/)
})

test('§1.6: a refused flush CANCELS the close and names the kind', async () => {
  const ipc = makeIpc({ 'a.md': 'alpha\n' })
  mount(ipc)
  await ED.openNote('a.md')
  type('unsaved')
  ipc.failWriteWith = { kind: 'diskFull' }
  const r = await ED.onFlushAndClose()
  assert.deepEqual(r, { ok: false, kind: 'diskFull' })
  assert.equal(ED.isDirty(), true, 'the buffer survives a cancelled close')
})

/* =========================================================================
 * 7.  §7.2's window-level flush points, wired by mountEditor itself.
 * ======================================================================= */

test('§7.2: window blur flushes', async () => {
  const ipc = makeIpc({ 'a.md': 'alpha\n' })
  mount(ipc)
  await ED.openNote('a.md')
  type('blur me')
  ipc.calls.length = 0
  globalThis.window.fire('blur')
  await settle()
  const w = writes(ipc)
  assert.equal(w.length, 1, 'window blur is an unconditional flush point')
  assert.equal(w[0].create, false)
})

test('§7.2: visibilitychange flushes only when the document is actually hidden', async () => {
  const ipc = makeIpc({ 'a.md': 'alpha\n' })
  mount(ipc)
  await ED.openNote('a.md')
  type('hide me')
  ipc.calls.length = 0

  globalThis.document.hidden = false
  globalThis.document.fire('visibilitychange')
  await settle()
  assert.deepEqual(writes(ipc), [], 'becoming VISIBLE is not a flush point')

  globalThis.document.hidden = true
  globalThis.document.fire('visibilitychange')
  await settle()
  assert.equal(writes(ipc).length, 1)
  globalThis.document.hidden = false
})

/* =========================================================================
 * 8.  §9.2 — a note switch flushes first, and is ABORTED on a rejection.
 * ======================================================================= */

test('§9.2: switching notes flushes the outgoing buffer first', async () => {
  const ipc = makeIpc({ 'a.md': 'alpha\n', 'b.md': 'bravo\n' })
  mount(ipc)
  await ED.openNote('a.md')
  type(' edited')
  ipc.calls.length = 0
  const r = await ED.openNote('b.md')
  assert.equal(r.ok, true)
  const w = writes(ipc)
  assert.equal(w.length, 1)
  assert.equal(w[0].path, 'a.md', 'the OUTGOING note is the one written')
  assert.equal(w[0].create, false)
  assert.equal(ED.currentPath(), 'b.md')
})

test('§9.2: a switch whose flush is REFUSED is aborted and the buffer is kept', async () => {
  const ipc = makeIpc({ 'a.md': 'alpha\n', 'b.md': 'bravo\n' })
  mount(ipc)
  await ED.openNote('a.md')
  type(' edited')
  ipc.failWriteWith = { kind: 'permission' }
  const r = await ED.openNote('b.md')
  assert.equal(r.ok, false, 'the buffer is never dropped in order to open something else')
  assert.equal(r.err.kind, 'permission')
  assert.equal(ED.currentPath(), 'a.md')
  assert.equal(ED.isDirty(), true)
})

test('§9.2: openNote surfaces a read failure as {ok:false} and keeps the old note', async () => {
  const ipc = makeIpc({ 'a.md': 'alpha\n' })
  mount(ipc)
  await ED.openNote('a.md')
  const r = await ED.openNote('missing.md')
  assert.equal(r.ok, false)
  assert.equal(r.err.kind, 'notFound')
  assert.equal(ED.currentPath(), 'a.md')
})

/* =========================================================================
 * 9.  The docGen guard — keystrokes typed DURING a write are not lost.
 * ======================================================================= */

test('§7.2: a keystroke landing mid-write leaves the buffer dirty and re-arms', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const ipc = makeIpc({ 'a.md': 'alpha\n' })
  mount(ipc)
  await ED.openNote('a.md')
  type('first')
  ipc.calls.length = 0

  ipc.holdWrites = true
  const flush = ED.flushNow('idle')
  await settle()
  assert.equal(writes(ipc).length, 1, 'the write is in flight')

  // The user keeps typing while the write is on the wire.
  type('second')
  ipc.holdWrites = false
  ipc.pending.forEach((r) => r())
  ipc.pending.length = 0
  await flush.catch(() => {})
  await settle()

  assert.equal(ED.isDirty(), true, 'the newer keystrokes must NOT be marked saved')
  t.mock.timers.tick(IDLE_MS)
  await settle()
  const w = writes(ipc)
  assert.equal(w.length, 2, 'the generation guard re-arms the debounce')
  assert.match(w[1].text, /second$/)
})

/* =========================================================================
 * 10.  §7.3 cases 4, 5, 7, 8 and §7.4.
 * ======================================================================= */

test('§7.3 case 4: adoptRenamedPath moves activePath and the next flush follows it', async () => {
  const ipc = makeIpc({ 'a.md': 'alpha\n' })
  mount(ipc)
  const seen = []
  ED.setEditorHooks({ onPathChanged: (p) => seen.push(p) })
  await ED.openNote('a.md')
  seen.length = 0
  ED.adoptRenamedPath('a.md', 'b.md')
  assert.equal(ED.currentPath(), 'b.md')
  assert.deepEqual(seen, ['b.md'], 'the tab label follows RenameResult.path exactly once')
  // A rename for a note that is NOT open anymore lands nowhere.
  ED.adoptRenamedPath('a.md', 'c.md')
  assert.equal(ED.currentPath(), 'b.md')
  assert.deepEqual(seen, ['b.md'])
  type('after rename')
  ipc.calls.length = 0
  await ED.flushNow('manual').catch(() => {})
  assert.equal(writes(ipc)[0].path, 'b.md', 'the flush must land on the NEW path')
  ED.setEditorHooks({})
})

test('§7.3 case 5: markDetached leaves `live`, and a detached buffer never writes', async () => {
  const ipc = makeIpc({ 'a.md': 'alpha\n' })
  mount(ipc)
  await ED.openNote('a.md')
  assert.equal(ED.currentNoteState(), 'live')
  type('typed')
  ED.markDetached()
  assert.equal(ED.currentNoteState(), 'detached')
  assert.equal(ED.lastNoteError().kind, 'notFound')
  ipc.calls.length = 0
  await ED.flushNow('idle').catch(() => {})
  assert.deepEqual(writes(ipc), [])
})

test('§7.3 case 8: markVaultLost leaves `live`, and the buffer never writes', async () => {
  const ipc = makeIpc({ 'a.md': 'alpha\n' })
  mount(ipc)
  await ED.openNote('a.md')
  type('typed')
  ED.markVaultLost()
  assert.equal(ED.currentNoteState(), 'vault-lost')
  assert.equal(ED.lastNoteError().kind, 'vaultLost')
  ipc.calls.length = 0
  await ED.flushNow('idle').catch(() => {})
  assert.deepEqual(writes(ipc), [])
})

test('§7.3 case 7: a CLEAN buffer reloads silently on an external change', async () => {
  const ipc = makeIpc({ 'a.md': 'alpha\n' })
  mount(ipc)
  await ED.openNote('a.md')
  ipc.files['a.md'] = 'rewritten from outside\n'
  ipc.mtime = 9999
  await ED.noteExternalChange('a.md')
  assert.equal(ED.isDirty(), false)
  assert.equal(view().state.doc.toString(), 'rewritten from outside\n')
  ipc.calls.length = 0
  await ED.flushNow('manual').catch(() => {})
  assert.deepEqual(writes(ipc), [], 'a silent reload must not write straight back')
})

test('§7.3 case 7: a DIRTY buffer is never silently overwritten by a disk change', async () => {
  const ipc = makeIpc({ 'a.md': 'alpha\n' })
  mount(ipc)
  await ED.openNote('a.md')
  type(' MINE')
  const before = view().state.doc.toString()
  ipc.files['a.md'] = 'theirs\n'
  await ED.noteExternalChange('a.md')
  assert.equal(view().state.doc.toString(), before, 'the user’s unsaved text survives')
  assert.equal(ED.isDirty(), true)
})

test('§7.3 case 7: an external change to a DIFFERENT path does nothing at all', async () => {
  const ipc = makeIpc({ 'a.md': 'alpha\n', 'z.md': 'zulu\n' })
  mount(ipc)
  await ED.openNote('a.md')
  ipc.calls.length = 0
  await ED.noteExternalChange('z.md')
  assert.deepEqual(ipc.calls, [], 'no read, no write, nothing')
})

test('§7.3 case 7 Reload from disk: the buffer is DISCARDED and the caret memo evicted', async () => {
  // `reloadFromDisk` had no caller and no test.  It is the destructive half of
  // case 7 — unlike `noteExternalChange`, which refuses to touch a dirty buffer,
  // this one throws the user's edits away on purpose — so the two rows that
  // matter are that it clears `dirty` (or the next autosave writes the text the
  // user just chose to abandon straight back over the file) and that it drops
  // the caret memo (an offset from the OLD text is meaningless against the new).
  const ipc = makeIpc({ 'a.md': 'alpha bravo charlie\n' })
  mount(ipc)
  await ED.openNote('a.md')
  view().dispatch({ selection: { anchor: 12 } })
  type(' MINE')
  assert.equal(ED.isDirty(), true)

  ipc.files['a.md'] = 'theirs\n'
  ipc.mtime = 7777
  await ED.reloadFromDisk()

  assert.equal(view().state.doc.toString(), 'theirs\n', 'the disk copy must win')
  assert.equal(ED.isDirty(), false, 'a reloaded buffer that stays dirty writes itself back')
  assert.equal(ED.currentNoteState(), 'live')
  assert.equal(view().state.selection.main.anchor, 0, 'the stale caret memo must be evicted')

  ipc.calls.length = 0
  await ED.flushNow('idle')
  assert.deepEqual(writes(ipc), [], 'the reload must not write straight back')
})

test('§7.4: showEmpty drops the note, fires onEmpty and writes nothing', async () => {
  const ipc = makeIpc({ 'a.md': 'alpha\n' })
  mount(ipc)
  let empties = 0
  ED.setEditorHooks({ onEmpty: () => { empties += 1 } })
  await ED.openNote('a.md')
  type('unsaved work')
  ipc.calls.length = 0
  ED.showEmpty()
  assert.equal(empties, 1)
  assert.equal(ED.currentPath(), null)
  assert.equal(ED.isDirty(), false)
  await ED.flushNow('idle').catch(() => {})
  assert.deepEqual(writes(ipc), [], 'with no note open there is nothing to write')
  ED.setEditorHooks({})
})

/* =========================================================================
 * 11.  §9.6's caret memo.
 * ======================================================================= */

test('§9.6: the caret memo is restored when a note is reopened', async () => {
  const ipc = makeIpc({ 'a.md': 'alpha bravo charlie\n', 'b.md': 'other\n' })
  mount(ipc)
  await ED.openNote('a.md')
  view().dispatch({ selection: { anchor: 6 } })
  await ED.openNote('b.md')
  await ED.openNote('a.md')
  assert.equal(view().state.selection.main.anchor, 6, 'the caret returns where it was left')
})

test('§9.6: forgetCursor evicts, so a recreated path opens at the top', async () => {
  const ipc = makeIpc({ 'a.md': 'alpha bravo charlie\n', 'b.md': 'other\n' })
  mount(ipc)
  await ED.openNote('a.md')
  view().dispatch({ selection: { anchor: 6 } })
  await ED.openNote('b.md')
  ED.forgetCursor('a.md')
  await ED.openNote('a.md')
  assert.equal(view().state.selection.main.anchor, 0, 'a recreated path is a different note')
})

test('§9.6: a memo pointing past the end of a shrunken document is clamped', async () => {
  const ipc = makeIpc({ 'a.md': 'a very long first version\n', 'b.md': 'other\n' })
  mount(ipc)
  await ED.openNote('a.md')
  view().dispatch({ selection: { anchor: 20 } })
  await ED.openNote('b.md')
  ipc.files['a.md'] = 'hi\n'          // shorter than the remembered offset
  await ED.openNote('a.md')
  const sel = view().state.selection.main
  assert.ok(sel.anchor <= view().state.doc.length, 'the memo must be clamped, not thrown')
  assert.equal(sel.anchor, 3)
})

/* =========================================================================
 * 12.  `OpenResult.bytes` is BYTES.
 *
 * `read.bytes` comes from §2's frame when owner 02's decoder supplies it; the
 * fallback below is what runs when it does not.  Counting that fallback in
 * UTF-16 code units understates a Japanese note by two thirds, and `bytes` is
 * what §1.5's `tooLarge` message is rendered from (inline-edit.ts `mb()`).
 * ======================================================================= */

test('OpenResult.bytes counts UTF-8 bytes, not UTF-16 code units', async () => {
  const enc = new TextEncoder()
  const docs = {
    'ascii.md': 'hello world\n',
    'cjk.md': '日本語のノート\n',                 // 3 bytes per character
    'emoji.md': '👍🏽 done 🎉\n',                  // surrogate pairs, 4 bytes each
    'accent.md': 'café naïve über\n',            // 2 bytes per accented character
    'mixed.md': '# 見出し\n\nplain ascii body\n\n```\nコード\n```\n',
  }
  const ipc = makeIpc(docs)
  mount(ipc)
  for (const [path, text] of Object.entries(docs)) {
    const r = await ED.openNote(path)
    assert.equal(r.ok, true, path)
    assert.equal(r.bytes, enc.encode(text).length, `${path}: bytes must agree with TextEncoder`)
  }
})

test('the byte count agrees with TextEncoder across a randomised code-point sweep', async () => {
  const enc = new TextEncoder()
  let seed = 0x2f6e2b1
  const rand = (n) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed % n
  }
  const ipc = makeIpc({})
  mount(ipc)
  for (let round = 0; round < 60; round += 1) {
    let s = ''
    for (let i = 0; i < 40; i += 1) {
      const bucket = rand(5)
      if (bucket === 0) s += String.fromCodePoint(0x20 + rand(0x5f))        // 1 byte
      else if (bucket === 1) s += String.fromCodePoint(0x80 + rand(0x780))  // 2 bytes
      else if (bucket === 2) s += String.fromCodePoint(0x3000 + rand(0x2000)) // 3 bytes
      else if (bucket === 3) s += String.fromCodePoint(0x10000 + rand(0xfffff)) // 4 bytes
      else s += '\n'
    }
    const path = `r${round}.md`
    ipc.files[path] = s
    const r = await ED.openNote(path)
    assert.equal(r.bytes, enc.encode(s).length, `round ${round}`)
  }
})

test('a LONE surrogate is counted the way TextEncoder counts it (U+FFFD, 3 bytes)', async () => {
  const enc = new TextEncoder()
  const text = 'a' + '\ud83d' + 'b'          // high surrogate with no low partner
  const ipc = makeIpc({ 'lone.md': text })
  mount(ipc)
  const r = await ED.openNote('lone.md')
  assert.equal(r.bytes, enc.encode(text).length)
})

test('a trailing lone surrogate at end-of-string does not run off the end', async () => {
  const enc = new TextEncoder()
  const text = 'ab\ud83d'
  const ipc = makeIpc({ 'tail.md': text })
  mount(ipc)
  const r = await ED.openNote('tail.md')
  assert.equal(r.bytes, enc.encode(text).length)
})

/* ===========================================================================
 * 12.  §5.3 / §5.4 TYPOGRAPHY — THE CASCADE AGAINST CM6's BASE THEME (G9).
 *
 * WHY THESE TESTS EXIST.  G9 failed thirteen rows and eleven of them were one
 * bug: `src/styles/editor.css` declared `line-height`, `font-family` and the
 * §5.3 padding reset with BARE class selectors — `.cm-scroller`, `.cm-content`,
 * `.cm-line`, specificity (0,1,0) — against a CodeMirror base theme whose every
 * rule is prefixed with the generated theme class on `.cm-editor` and is
 * therefore (0,2,0).  The app lost every contested property, in every load
 * order, and no test in this repo could see it: `_minidom.mjs` has no cascade
 * and the geometry probe only runs inside a real window.
 *
 * SOURCE ORDER WAS NEVER THE PROBLEM AND IS NOT THE FIX.  style-mod mounts
 * CM6's <style> at `document.head.firstChild`, BEFORE the sheet build.mjs
 * inlines — so the app sheet already won every tie and still lost, on
 * specificity, before order was consulted.
 *
 * WHAT THIS SECTION DOES.  It resolves the SHIPPED `src/styles/*.css` against
 * the SHIPPED `@codemirror/view` base theme — read out of the installed dist,
 * never retyped — through a small cascade (specificity, then source order, then
 * inheritance) and asserts the COMPUTED numbers §5.3/§5.4 print: the 24px body
 * pitch, the 16px code padding, the 445 content inset, the 113.8 first line.
 * A CM6 upgrade that adds or moves a rule changes the model's input and fails
 * these rows loudly instead of silently unstyling the editor again.
 *
 * IT IS NOT A BROWSER.  It models what these sheets and these two elements
 * need and nothing more: no @-rules, no attribute or pseudo matching, no
 * shorthand beyond padding/margin/overflow.  Every one of those limits is an
 * ASSERTION, not a silent skip — an undecidable selector that declares a
 * tracked property throws rather than being ignored.  The authority on pixels
 * is still tools/verify-geometry.js in a real window.
 * ========================================================================= */

import { EditorView as RealView } from '@codemirror/view'

const CSS_ORDER = ['tokens.css', 'base.css', 'chrome.css', 'tree.css', 'editor.css', 'search.css']

/** CM6's base-theme spec, lifted from the installed dist rather than retyped. */
function baseThemeSpec() {
  const src = readFileSync(resolve(ROOT, 'node_modules/@codemirror/view/dist/index.js'), 'utf8')
  const anchor = 'buildTheme("." + baseThemeID, {'
  const at = src.indexOf(anchor)
  assert.ok(
    at >= 0,
    '@codemirror/view no longer builds its base theme with `buildTheme("." + baseThemeID, {…})`. ' +
      'The cascade model below is now BLIND to what the library declares and must be re-derived ' +
      'before these rows can be trusted.'
  )
  let i = at + anchor.length - 1, depth = 0
  for (; i < src.length; i += 1) {
    const c = src[i]
    if (c === '"' || c === "'" || c === '`') {
      const q = c
      i += 1
      while (i < src.length && src[i] !== q) { if (src[i] === '\\') i += 1; i += 1 }
      continue
    }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i += 1; continue }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i) + 1; continue }
    if (c === '{') depth += 1
    else if (c === '}' && (depth -= 1) === 0) { i += 1; break }
  }
  return new Function('return (' + src.slice(at + anchor.length - 1, i) + ')')()
}

/** The CSS text a `styleModule` extension would mount. */
function moduleRuleText(ext) {
  const out = []
  ;(function walk(e) {
    if (Array.isArray(e)) return e.forEach(walk)
    if (!e || typeof e !== 'object') return
    if (e.value && typeof e.value.getRules === 'function') out.push(e.value.getRules())
    if (e.inner) walk(e.inner)
    if (Array.isArray(e.value)) walk(e.value)
  })(ext)
  return out.join('\n')
}

/* The generated theme classes are a global counter, not a literal — read them
 * back instead of hard-coding `ͼ1`. */
const CM_PREFIX = (() => {
  const r = moduleRuleText(RealView.baseTheme({ '&': { color: 'red' }, '&dark': { color: 'blue' } })).split('\n')
  return { base: r[0].split(' ')[0].slice(1), dark: r[1].split(' ')[0].slice(1) }
})()

const TRACKED = new Set([
  // spike Q added 'font-weight' and 'letter-spacing'. Both were UNTRACKED, so
  // the model discarded them at parse time and could not see them at all --
  // which is how six new --hN-ls declarations and four changed weights landed
  // with zero coverage. A property missing from TRACKED cannot fail a test.
  'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'overflow-x', 'overflow-y',
])
// All five are inherited in CSS. Adding one to TRACKED without adding it here
// makes the model resolve it as if it were not inherited, which is worse than
// not modelling it: it would be confidently wrong instead of absent.
const INHERITED = new Set(['font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing'])

/** Split one compound selector into its simple selectors, unicode-safe. */
function simpleSelectors(compound) {
  const out = []
  let i = 0
  const stop = (ch) => ch === '.' || ch === '#' || ch === ':' || ch === '['
  while (i < compound.length) {
    const start = i
    if (compound[i] === '[') { i = compound.indexOf(']', i) + 1; out.push(compound.slice(start, i)); continue }
    if (compound[i] === ':') i += compound[i + 1] === ':' ? 2 : 1
    else if (compound[i] === '.' || compound[i] === '#') i += 1
    let paren = 0
    for (; i < compound.length; i += 1) {
      const ch = compound[i]
      if (ch === '(') paren += 1
      else if (ch === ')') paren -= 1
      else if (!paren && stop(ch)) break
    }
    out.push(compound.slice(start, i))
  }
  return out.filter(Boolean)
}

function specificity(sel) {
  let a = 0, b = 0, c = 0
  for (const compound of sel.replace(/\s*[>+~]\s*/g, ' ').split(/\s+/)) {
    if (!compound) continue
    for (const t of simpleSelectors(compound)) {
      if (t === '*') continue
      if (t[0] === '#') a += 1
      else if (t[0] === '.' || t[0] === '[') b += 1
      else if (t.startsWith('::')) c += 1
      else if (t[0] === ':') b += 1
      else c += 1
    }
  }
  return [a, b, c]
}
const cmpSpec = (x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]

function compoundMatch(compound, el) {
  for (const t of simpleSelectors(compound)) {
    if (t === '*') continue
    if (t[0] === '#') { if (el.id !== t.slice(1)) return false }
    else if (t[0] === '.') { if (!el.cls.has(t.slice(1))) return false }
    else if (t[0] === '[' || t[0] === ':') return 'undecidable'
    else if (el.tag !== t) return false
  }
  return true
}

/** `chain` is ancestors-first with the subject last. */
function selectorMatches(sel, chain) {
  const parts = sel.trim().split(/\s*(>)\s*|\s+/).filter(Boolean)
  let undecided = false
  let k = chain.length - 1
  let i = parts.length - 1
  const first = compoundMatch(parts[i], chain[k])
  if (first === false) return false
  if (first === 'undecidable') undecided = true
  i -= 1
  let child = false
  while (i >= 0) {
    if (parts[i] === '>') { child = true; i -= 1; continue }
    if (child) {
      k -= 1
      if (k < 0) return false
      const r = compoundMatch(parts[i], chain[k])
      if (r === false) return false
      if (r === 'undecidable') undecided = true
      child = false
    } else {
      let found = false
      for (let kk = k - 1; kk >= 0; kk -= 1) {
        const r = compoundMatch(parts[i], chain[kk])
        if (r === true || r === 'undecidable') {
          if (r === 'undecidable') undecided = true
          k = kk; found = true; break
        }
      }
      if (!found) return false
    }
    i -= 1
  }
  return undecided ? 'undecidable' : true
}

function expandShorthand(prop, value) {
  const p = prop.trim().toLowerCase()
  const v = value.trim()
  if (p === 'padding' || p === 'margin') {
    const q = v.split(/\s+/)
    const [t, r, b, l] =
      q.length === 1 ? [q[0], q[0], q[0], q[0]]
      : q.length === 2 ? [q[0], q[1], q[0], q[1]]
      : q.length === 3 ? [q[0], q[1], q[2], q[1]]
      : q
    return [[`${p}-top`, t], [`${p}-right`, r], [`${p}-bottom`, b], [`${p}-left`, l]]
  }
  if (p === 'overflow') { const q = v.split(/\s+/); return [['overflow-x', q[0]], ['overflow-y', q[1] ?? q[0]]] }
  return [[p, v]]
}

function parseSheet(text, sheet, rules, ats, vars) {
  const s = text.replace(/\/\*[\s\S]*?\*\//g, '')
  let i = 0
  for (;;) {
    const open = s.indexOf('{', i)
    if (open < 0) break
    const sel = s.slice(i, open).trim()
    let depth = 1, j = open + 1
    for (; j < s.length && depth; j += 1) { if (s[j] === '{') depth += 1; else if (s[j] === '}') depth -= 1 }
    const body = s.slice(open + 1, j - 1)
    i = j
    if (!sel) continue
    if (sel.startsWith('@')) { ats.push({ sheet, sel }); continue }
    const decls = []
    for (const d of body.split(';')) {
      const c = d.indexOf(':')
      if (c < 0) continue
      const prop = d.slice(0, c).trim()
      const value = d.slice(c + 1).trim()
      if (!prop) continue
      if (prop.startsWith('--')) { if (sel === ':root') vars.set(prop, value); continue }
      for (const [pp, vv] of expandShorthand(prop, value)) if (TRACKED.has(pp)) decls.push([pp, vv])
    }
    if (!decls.length) continue
    for (const one of sel.split(/,(?![^()]*\))/)) rules.push({ sheet, sel: one.trim(), decls })
  }
}

const SHEET = (() => {
  const rules = [], ats = [], vars = new Map()
  // CM6 first: style-mod mounts it at head.firstChild, ahead of the inlined sheet.
  parseSheet(moduleRuleText(RealView.baseTheme(baseThemeSpec())), 'cm6-base-theme', rules, [], vars)
  for (const f of CSS_ORDER) parseSheet(readFileSync(resolve(ROOT, 'src/styles', f), 'utf8'), f, rules, ats, vars)
  return { rules, ats, vars }
})()

function token(v, seen = 0) {
  assert.ok(seen < 8, `var() cycle resolving ${v}`)
  const m = /^var\((--[\w-]+)\)$/.exec(String(v).trim())
  if (!m) return String(v).trim()
  const got = SHEET.vars.get(m[1])
  assert.ok(got !== undefined, `${m[1]} is not declared in tokens.css (§5.1: it is the only declaration site)`)
  return token(got, seen + 1)
}

function element(tag, sel) {
  const cls = new Set()
  let id = null
  for (const t of simpleSelectors(sel || '')) {
    if (t[0] === '#') id = t.slice(1)
    else if (t[0] === '.') cls.add(t.slice(1))
  }
  return { tag, id, cls }
}

/** index.html + CM6's own DOM: .cm-editor > .cm-scroller > .cm-content > .cm-line */
function cmChain(lineSel = '') {
  return [
    element('html'), element('body'), element('div', '.app'), element('main', '.editor'),
    element('div', '#ed'),
    element('div', `.cm-editor.${CM_PREFIX.base}.${CM_PREFIX.dark}`), // §5.3: darkTheme.of(true)
    element('div', '.cm-scroller'),
    element('div', '.cm-content'),
    element('div', `.cm-line${lineSel}`),
  ]
}
const AT = { editor: 5, scroller: 6, content: 7, line: 8 }

/** The declaration that WINS for `prop` on chain[depth] — no inheritance. */
function winner(chain, depth, prop) {
  const subject = chain.slice(0, depth + 1)
  let best = null
  for (let n = 0; n < SHEET.rules.length; n += 1) {
    const r = SHEET.rules[n]
    const mine = r.decls.filter(([p]) => p === prop)
    if (!mine.length) continue
    const m = selectorMatches(r.sel, subject)
    if (m === false) continue
    assert.notEqual(
      m, 'undecidable',
      `the cascade model cannot decide \`${r.sel}\` (${r.sheet}) for ${prop}. ` +
        'Extend the model — leaving it would make these assertions silently blind.'
    )
    const sp = specificity(r.sel)
    if (!best || cmpSpec(sp, best.sp) > 0 || (cmpSpec(sp, best.sp) === 0 && n > best.n)) {
      best = { sp, n, value: mine[mine.length - 1][1], sel: r.sel, sheet: r.sheet }
    }
  }
  return best
}

/** The computed value, following inheritance for the properties that inherit. */
function computed(chain, depth, prop) {
  for (let d = depth; ; d -= 1) {
    const w = winner(chain, d, prop)
    if (w) return { ...w, value: token(w.value), from: d }
    if (!INHERITED.has(prop) || d === 0) return null
  }
}
/* UNIT HANDLING, ADDED BY SPIKE Q.  `computedPx` was a bare `Number.parseFloat`,
 * which is right for `30px` and silently wrong for `1.618em` — it returns 1.618.
 * That did not merely under-report: it made the h1..h3 line-height assertion
 * below pass VACUOUSLY, because the same wrong number appeared on both sides.
 * A green row that measures nothing is worse than a red one. */

/** The element's OWN computed font-size in px, following `em` chains upward.
 *  `font-size: Xem` is the one property whose `em` resolves against the PARENT,
 *  which is exactly why --h1-size: 1.618em is 25.888px (x .cm-content's 16) and
 *  not 1.618 x its own size. */
function fontSizePx(chain, depth) {
  const w = computed(chain, depth, 'font-size')
  assert.ok(w, 'nothing declares font-size')
  // `(?<!r)em` so `rem` does not match: a rem resolves against :root, not the
  // parent, and treating one as an em would make this model confidently wrong
  // rather than loud -- the failure class `winner()`'s undecidable-selector
  // assert already exists to prevent.
  if (!/(?<!r)em$/.test(w.value)) {
    assert.ok(/(px|rem)$/.test(w.value) || /^[\d.]+$/.test(w.value),
      `font-size in a unit this model does not model: ${w.value}`)
    return Number.parseFloat(w.value)
  }
  assert.ok(w.from > 0, `font-size in em at the root of the chain: ${w.value}`)
  return Number.parseFloat(w.value) * fontSizePx(chain, w.from - 1)
}

function computedPx(chain, depth, prop) {
  const w = computed(chain, depth, prop)
  assert.ok(w, `nothing declares ${prop}`)
  if (prop === 'font-size') return fontSizePx(chain, depth)
  // Every other property's `em` resolves against the element's OWN font-size.
  return /(?<!r)em$/.test(w.value)
    ? Number.parseFloat(w.value) * fontSizePx(chain, depth)
    : Number.parseFloat(w.value)
}
/** CSS resolves a unitless line-height against the element's own font-size. */
function lineHeightPx(chain, depth) {
  const lh = computed(chain, depth, 'line-height')
  assert.ok(lh, 'nothing declares line-height')
  return /px$/.test(lh.value)
    ? Number.parseFloat(lh.value)
    : Number.parseFloat(lh.value) * computedPx(chain, depth, 'font-size')
}

/* ---- the guards: the model's inputs, asserted so a change is loud -------- */

test('G9 model: the CM6 base theme still declares exactly the properties this sheet was designed against', () => {
  const text = moduleRuleText(RealView.baseTheme(baseThemeSpec()))
  const rule = (sel) => text.split('\n').find((l) => l.startsWith(`.${CM_PREFIX.base} ${sel} {`))
  const scroller = rule('.cm-scroller')
  const content = rule('.cm-content')
  const line = rule('.cm-line')
  assert.ok(scroller && content && line, 'the base theme no longer styles all three of .cm-scroller/.cm-content/.cm-line')

  // Every prefixed rule is TWO classes. That, and not load order, is what beat
  // a bare `.cm-scroller` in this sheet.
  assert.deepEqual(specificity(`.${CM_PREFIX.base} .cm-scroller`), [0, 2, 0])
  assert.deepEqual(specificity('.cm-scroller'), [0, 1, 0])

  // The four collisions §5.3 has to survive. If a CM6 upgrade moves, drops or
  // adds one of these, this row fails and the sheet gets re-derived.
  assert.match(scroller, /font-family: monospace;/)
  assert.match(scroller, /line-height: 1\.4;/)
  assert.match(scroller, /overflow-x: auto;/)
  assert.match(content, /padding: 4px 0;/)
  assert.match(line, /padding: 0 2px 0 6px;/)
})

test('G9 model: the app sheets contain no @-rule, which the model would skip', () => {
  assert.deepEqual(SHEET.ats, [], 'an @-rule was added to src/styles — the cascade model skips those and would be blind to it')
})

/* ---- the computed geometry §5.3/§5.4 prints ----------------------------- */

test('§5.3: the body line computes to a 16px / 24px pitch, not CM6\'s 22.4', () => {
  const body = cmChain()
  assert.equal(computedPx(body, AT.line, 'font-size'), 16)
  assert.equal(lineHeightPx(body, AT.line), 24)   // G9 measured 22.4 = 16 x CM6's 1.4
})

test('§5.3: line-height is declared on .cm-content, NOT on .cm-scroller (this is the fix)', () => {
  const body = cmChain()
  const lh = computed(body, AT.line, 'line-height')
  assert.equal(lh.sheet, 'editor.css')
  assert.equal(lh.from, AT.content,
    'the winning line-height must come from .cm-content. CM6 declares line-height on .cm-scroller at (0,2,0); ' +
      'moving this back up to .cm-scroller loses it again and reinstates the 22.4px pitch.')
  assert.ok(!/cm-scroller/.test(lh.sel), `line-height came from \`${lh.sel}\``)
})

test('§5.3: the editor is NOT monospace — CM6\'s base font must not reach the text', () => {
  const body = cmChain()
  const ff = computed(body, AT.line, 'font-family')
  assert.notEqual(ff.value, 'monospace',
    'the editor is rendering in CM6\'s base monospace. The geometry probe is font-insensitive by ' +
      'design and cannot catch this, so it is asserted here.')
  assert.equal(ff.value, token('var(--font-text)'))
  assert.equal(ff.from, AT.content)
})

test('§5.3: the padding reset beats CM6 — .cm-content 4px and .cm-line 6px/2px are both gone', () => {
  const body = cmChain()
  for (const side of ['top', 'right', 'bottom', 'left']) {
    assert.equal(computedPx(body, AT.content, `padding-${side}`), 0, `.cm-content padding-${side}`)
    assert.equal(computedPx(body, AT.line, `padding-${side}`), 0, `.cm-line padding-${side}`)
  }
  // and it wins on specificity, not on which sheet happens to load last
  assert.ok(cmpSpec(specificity(winner(body, AT.line, 'padding-left').sel),
                    specificity(`.${CM_PREFIX.base} .cm-line`)) > 0,
    'the .cm-line reset only ties CM6 — it must out-specify it')
})

test('§5.3: the fenced code block keeps its 16px padding through the reset', () => {
  const cb = cmChain('.nc-cb')
  assert.equal(computedPx(cb, AT.line, 'padding-left'), 16)   // G9 measured 6 (CM6's)
  assert.equal(computedPx(cb, AT.line, 'padding-right'), 16)  // G9 measured 2 (CM6's)
  assert.equal(computedPx(cb, AT.line, 'padding-top') + computedPx(cb, AT.line, 'padding-bottom'), 0)
  assert.equal(computedPx(cb, AT.line, 'font-size'), 14)
  assert.equal(lineHeightPx(cb, AT.line), 21)                 // the INTEGER 21px (X4)
})

test('§5.3: the content inset solves to 444, and code text to 460', () => {
  const EDITOR_PANE_LEFT = 412   // §5.5 — chrome.css owns it; the probe asserts it in a window
  const body = cmChain()
  const inset = EDITOR_PANE_LEFT
    + computedPx(body, AT.scroller, 'padding-left')
    + computedPx(body, AT.line, 'padding-left')
  // spike Q: 444, was 445. --editor-inset-x moved 33 -> 32 (Obsidian's own
  // --file-margins-x, app.css:2243). The 33 was an INK-edge reading of a 32px
  // box: the reference pane's left edge is 410, +32 = 442, and the title ink
  // starts at 443 — one px of `u` left side bearing.
  assert.equal(inset, 444)
  const cb = cmChain('.nc-cb')
  assert.equal(EDITOR_PANE_LEFT + computedPx(cb, AT.scroller, 'padding-left')
    + computedPx(cb, AT.line, 'padding-left'), 460)
})

test('§5.4.2: the title box and the first body line land on 72 / 31.0656 / 113.0656', () => {
  // READ FROM THE TOKEN, NOT A LITERAL.  This was `const EDITOR_PANE_TOP = 39`
  // and it is why §0.6 E8's strip change (39 -> 40) passed this file untouched:
  // a hardcoded pane top cannot notice that the pane moved.  base.css:66-71
  // insets `.app` by exactly this token, so this is the same number the browser
  // uses, and the next change to it fails here instead of shipping.
  const EDITOR_PANE_TOP = Number.parseFloat(token('var(--titlebar-h)'))   // §5.5, §0.6 E8
  assert.equal(EDITOR_PANE_TOP, 40, 'the strip is 40: 39px of fill plus its 1px rule')
  const body = cmChain()
  const titleTop = EDITOR_PANE_TOP
    + computedPx(body, AT.scroller, 'padding-top')
    + computedPx(body, AT.content, 'padding-top')
  // spike Q: 72, was 70. --editor-inset-y moved 30 -> 32 (Obsidian's own
  // --file-margins-y, app.css:2244). The 30 was never measured — it is the fit
  // parameter spec-01-visual.md:709 designates, nudged to cancel out --h1-size
  // being 29 instead of 25.888.
  assert.equal(titleTop, 72)
  // The em base is asserted, not assumed: `1.618em` is only 25.888 because the
  // title's parent .cm-content is 16px. If that ever moves, this fails first.
  const emBase = fontSizePx(body, AT.content)
  assert.equal(emBase, 16, '.cm-content is the em base for the whole H ladder')
  const h1Px = computedPx(cmChain('.nc-title'), AT.line, 'font-size')
  assert.equal(h1Px, 25.888, '--h1-size 1.618em x 16 (Obsidian app.css:2327)')
  const titleH = h1Px * Number.parseFloat(token('var(--h1-lh)'))
  assert.equal(titleH, 31.0656)  // was 34.8 on a 29px H1
  // §0.24.5 E52 + §0.30 E74. The title's gap is `--inline-title-space-after`
  // (12.944, Obsidian's own `--inline-title-margin-bottom: 0.5em` of 25.888) and
  // NOT `--h1-space-after`, which this line used to add and which E74 deleted
  // outright. 72 + 31.0656 + 12.944 = 116.0096, which is G9's `K.firstLineTop`.
  assert.equal(titleTop + titleH + Number.parseFloat(token('var(--inline-title-space-after)')),
    116.0096)
})

/* spike Q. WAS h1..h3 only, and asserted `lineHeightPx == size x lh` — an
 * identity that holds for ANY pair of tokens and that passed vacuously the
 * moment the ladder went to `em`. Now h1..h6, pinned to the values MEASURED off
 * Obsidian's own app.css in the pinned engine (Electron 39.8.3 / Chrome 142),
 * side by side with Cairn's sheet: 32 of 32 values identical, 0 mismatches.
 * Obsidian app.css:2327-2332 sizes, :2010-2018 weights, :2321-2326 line-heights,
 * :2315-2320 letter-spacings. Change a token and a literal here must move with
 * it — that is the point. */
const LADDER = [
  // level   size    line box   weight  letter-spacing   <- all four MEASURED in
  ['1', 25.888, 31.0656, 700, -0.38832],   //  the pinned engine off Obsidian's
  ['2', 23.392, 28.0704, 680, -0.257312],  //  own app.css, then compared with
  ['3', 21.088, 27.4144, 660, -0.168704],  //  Cairn's sheet side by side:
  ['4', 19.008, 26.6112, 640, -0.09504],   //  32 of 32 identical, 0 mismatches.
  ['5', 17.216, 25.824, 620, -0.034432],
  ['6', 16, 24, 600, 0],
]

/* ═══════════════════════════════════════════════════════════════════════════
 * NOTHING INSIDE `.cm-content` MAY CARRY A VERTICAL MARGIN.  2026-09-10.
 *
 * CM6 records a block's height as `child.dom.getBoundingClientRect().height`
 * (`@codemirror/view` 6.43, `measureVisibleLineHeights`) — a BORDER BOX, which
 * excludes margins.  A margin on a `.cm-line` is therefore real to the layout
 * and invisible to the height map, the map runs short by exactly that margin,
 * and `posAtCoords` — which picks its block out of THE MAP — resolves every
 * click below it to a position further down the document than the pixel the
 * user pointed at.  The user reported it as "I clicked, the caret jumps down
 * 2 lines"; the 2 lines were the sum of three margins.
 *
 * Heading spacing therefore lands as PADDING, which is Obsidian's own idiom for
 * the same problem: `.cm-s-obsidian .cm-line.HyperMD-header { padding-top:
 * var(--p-spacing) }` (app.css:12871), a padding on the line and never a margin.
 *
 * The consequence is pinned in the real engine by
 * `electron-shell/live-preview.test.mjs`; this pins the rule that prevents it,
 * where it can fail in 20ms without a display.
 * ═════════════════════════════════════════════════════════════════════════ */
test('§0.30 E73/E74 — a heading has 16px ABOVE it and NOTHING below', () => {
  // INVERTED FROM WHAT IT PINNED. This row was "`--hN-space-after` is PADDING,
  // and the reset does not eat it" — the right rule about the wrong side. E74
  // deleted those six tokens: Obsidian's heading declares no `padding-bottom`
  // anywhere and its base `.cm-line` is `padding: 0` (app.css:3888), so the
  // space below a heading is the next line box and nothing else. Measured both
  // ways on the same DOM in the pinned engine before it was taken.
  for (const [h] of LADDER) {
    // `.nc-h.nc-h${h}` — BOTH classes, in one compound selector. The shared
    // `nc-h` is what the space-above rule hangs off (§0.30 E73); passing only
    // the level class here would miss it and report a heading with no space.
    const line = cmChain(`.nc-h.nc-h${h}`)
    assert.equal(computedPx(line, AT.line, 'padding-bottom'), 0,
      `.nc-h${h} has space below it; Obsidian gives a heading none`)
    // …and the space ABOVE is `--p-spacing`, out-specifying §5.3's (0,3,0)
    // `.cm-scroller .cm-content .cm-line { padding: 0 }` exactly as .nc-cb's
    // 16px does. A heading that lost that fight sits flush under the line above.
    assert.equal(computedPx(line, AT.line, 'padding-top'),
      Number.parseFloat(token('var(--heading-space-before)')),
      `.nc-h${h}'s padding-top was zeroed by §5.3's reset`)
    assert.equal(computedPx(line, AT.line, 'padding-left'), 0)
  }
})

test('§5.4.2: no line class inside .cm-content carries a vertical margin', () => {
  // Every class this sheet ever puts on a `.cm-line`, plus the bare line.
  const CLASSES = ['', '.nc-h1', '.nc-h2', '.nc-h3', '.nc-h4', '.nc-h5', '.nc-h6',
                   '.nc-cb', '.nc-cb-first', '.nc-cb-last', '.nc-cb-only',
                   '.nc-li', '.nc-quote', '.nc-quote-1', '.nc-hr', '.nc-fm-invalid']
  for (const cls of CLASSES) {
    const line = cmChain(cls)
    for (const side of ['margin-top', 'margin-bottom']) {
      assert.equal(computedPx(line, AT.line, side), 0,
        `.cm-line${cls} declares ${side}. CM6 measures BORDER BOXES, so a margin here is ` +
        'invisible to its height map and every click below this line lands low. Use padding.')
    }
  }
})

/* The same rule for the two BLOCK WIDGETS, which are not `.cm-line`s and so are
 * not reachable by the cascade model above.  Both keep Obsidian's own
 * `margin-block-end` — `.nc-title`'s 12.944px and `.metadata-container`'s 2rem —
 * so the wrapper is what has to contain them, and `flow-root` is the whole of
 * how.  Obsidian needs no wrapper: its `.inline-title` and `.metadata-container`
 * are siblings of `.cm-contentContainer` inside `.cm-sizer`, so CM6 never
 * measures them at all. */
test('§5.4.2: the block-widget box is a formatting context, so it contains its margin', () => {
  const css = declsOnly(readFileSync(resolve(ROOT, 'src/styles/editor.css'), 'utf8'))
  const rule = /\.nc-block\s*\{([^}]*)\}/.exec(css)
  assert.ok(rule, '.nc-block is gone — the widgets have nothing to contain their margins')
  assert.match(rule[1], /display:\s*flow-root/,
    '.nc-block must be `display: flow-root`. A plain block lets the child\'s bottom margin ' +
    'collapse straight through it, which is the state the height map cannot see.')
  assert.doesNotMatch(rule[1], /padding|margin|background|border/,
    '.nc-block must carry no geometry of its own: G9 reads .nc-title\'s own box top, its ' +
    'margin-bottom and the relation between them, and a wrapper with padding moves all three')
  // The margin the wrapper exists to contain must still BE there, on the child.
  assert.match(css, /\.nc-title\s*\{[^}]*margin-bottom:\s*var\(--inline-title-space-after\)/,
    '.nc-title lost --inline-title-space-after (CONTRACT §0.24.5 E52)')
})

/* The literals below are PINNED MEASUREMENTS, so they are written as decimals
 * and compared with a tolerance rather than recomputed from the same two tokens
 * that produce them. 1e-9 is IEEE754 noise only (21.088 x -0.008 lands on
 * -0.16870400000000002) and is ~5 orders below the smallest real change in the
 * ladder; it cannot absorb a wrong token. */
function near(got, want, msg) {
  assert.ok(Math.abs(got - want) < 1e-9, `${msg} — expected ${want}, got ${got}`)
}

test('§5.4 + spike Q: the whole H1..H6 ladder resolves to Obsidian\'s own numbers', () => {
  for (const [h, size, lineBox, weight, ls] of LADDER) {
    const line = cmChain(`.nc-h${h}`)
    near(computedPx(line, AT.line, 'font-size'), size,
      `--h${h}-size must resolve to Obsidian's ${size}px (app.css:2327-2332)`)
    near(lineHeightPx(line, AT.line), lineBox,
      `.nc-h${h}'s line box is --h${h}-size x --h${h}-lh, both of them Obsidian's (app.css:2321-2326)`)
    assert.equal(computedPx(line, AT.line, 'font-weight'), weight,
      `--h${h}-weight must be Obsidian's @supports branch (app.css:2010-2018), NOT its :root fallback`)
    near(computedPx(line, AT.line, 'letter-spacing'), ls,
      `--h${h}-ls must resolve to Obsidian's ${ls}px (app.css:2315-2320)`)
  }
})

/* spike Q, and it guards a REAL defect this change shipped and then fixed:
 * `letter-spacing` is not a `font` sub-property and Chromium's UA sheet resets
 * it to `normal` on form controls, so `font: inherit` does not carry it. The
 * rename <input> rendered at `normal` while the title behind it rendered at
 * -0.38832px, and every glyph shifted on click. The sibling `line-height:
 * inherit` had been carrying this same lesson alone since the input-swap
 * shipped. Asserted as a DECLARATION, not a computed value, because this model
 * does not carry a UA stylesheet and so cannot see the reset that causes it. */
test('§5.4.2 + spike Q: the rename input inherits every metric the title sets', () => {
  const decls = SHEET.rules
    .filter((r) => r.sel.includes('.nc-title-edit'))
    .flatMap((r) => r.decls)
  for (const prop of ['line-height', 'letter-spacing']) {
    const d = decls.find(([p]) => p === prop)
    assert.ok(d, `.nc-title-edit must declare ${prop} explicitly — \`font: inherit\` does not carry it past the UA reset on form controls`)
    assert.equal(d[1], 'inherit', `.nc-title-edit's ${prop} must be \`inherit\`, not a value that can drift from .nc-title's`)
  }
})

/* ═══════════════════════════════════════════════════════════════════════════
 * THE POINTER OVER TEXT.  2026-09-10, user-reported: "hovering on text doesn't
 * change the cursor."
 *
 * `cursor` INHERITS, so `body { cursor: default }` -- which base.css shipped --
 * reached every character in every note and the editor never got its UA `auto`.
 * Obsidian writes no cursor on `body` at all (app.css:3134 + :3168 are its two
 * body rules and neither mentions it); it spends `cursor: var(--cursor)` on the
 * chrome elements that need an arrow and leaves everything else `auto`, which
 * Chromium resolves to an I-beam exactly where a node can start a selection or
 * is editable.  Measured on this machine through Electron's `cursor-changed`,
 * after the fix: note body text, heading text, the inline title and the
 * Properties inputs all set `text`; the tree rows, the tab label, the vault bar
 * and the property glyphs all set the arrow.  Before it, everything was arrow.
 * ═════════════════════════════════════════════════════════════════════════ */
/** A sheet with its comments removed. Every assertion below greps DECLARATIONS,
 *  and these files explain themselves at length — one of the comments here
 *  quotes the very rule it is documenting, which is enough to make a naive
 *  `assert.match` pass on a sheet that no longer contains it. */
const declsOnly = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '')

test('§5.1: `body` pins no cursor, so text can be text', () => {
  const base = declsOnly(readFileSync(resolve(ROOT, 'src/styles/base.css'), 'utf8'))
  const bodyRule = /(?:^|\n)body\s*\{([^}]*)\}/.exec(base)
  assert.ok(bodyRule, 'base.css has no `body` rule at all')
  assert.doesNotMatch(bodyRule[1], /(^|;)\s*cursor\s*:/,
    '`body` declares a cursor again. It INHERITS, so it lands on every glyph in every ' +
    'note and the editor can never reach its own `auto`. Obsidian pins none either — ' +
    'put the declaration on the one element that needs it.')
  // The companion rule, which is Obsidian's own (app.css:3173) and was the half
  // that never got transcribed: `user-select` inherits too, and it is what
  // Chromium consults for `cursor: auto` on anything that is not editable.
  assert.match(base, /body \[contenteditable="true"\][\s\S]{0,80}\{[^}]*user-select:\s*text/,
    'the `body [contenteditable]` user-select:text rule is gone; `.cm-content` computes ' +
    '`none` again and differs from Obsidian, which computes `text` there')
})

test('§5.4.2: the inline title says it is text, because clicking it opens an editor', () => {
  const css = declsOnly(readFileSync(resolve(ROOT, 'src/styles/editor.css'), 'utf8'))
  const rule = /\.nc-title\s*\{([^}]*)\}/.exec(css)
  assert.ok(rule)
  assert.match(rule[1], /cursor:\s*text/,
    'Obsidian\'s .inline-title is a permanent contenteditable and gets an I-beam from the UA; ' +
    'Cairn\'s is a widget in a contenteditable="false" subtree and has to say so itself')
})

test('§5.3: a body line carries no vertical margin, so a blank line is exactly one 24px box', () => {
  const body = cmChain()
  assert.equal(computedPx(body, AT.line, 'margin-top') + computedPx(body, AT.line, 'margin-bottom'), 0)
})

test('§5.3 / §5.12.4.2: the scroller keeps overflow-y:scroll and takes back overflow-x', () => {
  const body = cmChain()
  assert.equal(computed(body, AT.scroller, 'overflow-y').value, 'scroll')
  assert.equal(computed(body, AT.scroller, 'overflow-y').sheet, 'editor.css')
  // CM6 declares overflow-x:auto at (0,2,0); a bare `.cm-scroller` loses it.
  const ox = computed(body, AT.scroller, 'overflow-x')
  assert.equal(ox.value, 'hidden')
  assert.ok(cmpSpec(ox.sp, specificity(`.${CM_PREFIX.base} .cm-scroller`)) > 0,
    'overflow-x only ties CM6 — it must out-specify it, not depend on sheet order')
  // spike Q: both 32 — Obsidian's --file-margins-x/-y (app.css:2243-2244).
  assert.equal(computedPx(body, AT.scroller, 'padding-left'), 32)
  assert.equal(computedPx(body, AT.scroller, 'padding-top'), 32)
  assert.equal(computedPx(body, AT.scroller, 'padding-bottom'), 0)
})

test('§5.3: no rule in this sheet loses a tracked property to the CM6 base theme', () => {
  const chains = [cmChain(), cmChain('.nc-cb'), cmChain('.nc-h1'), cmChain('.nc-h2')]
  const lost = []
  for (const chain of chains) {
    for (const depth of [AT.scroller, AT.content, AT.line]) {
      for (const prop of TRACKED) {
        const w = winner(chain, depth, prop)
        if (!w || w.sheet !== 'cm6-base-theme') continue
        // CM6 winning is only a defect where this sheet also tried to set it.
        const ours = SHEET.rules.some((r) =>
          r.sheet === 'editor.css' && r.decls.some(([p]) => p === prop) &&
          selectorMatches(r.sel, chain.slice(0, depth + 1)) === true)
        if (ours) lost.push(`${chain[depth].cls.size ? [...chain[depth].cls].join('.') : '?'} ${prop} -> ${w.sel}`)
      }
    }
  }
  assert.deepEqual(lost, [], 'editor.css declares these and CM6\'s base theme still wins them')
})

/* =========================================================================
 * F66: conflicted/detached/vault-lost notes can be resolved. `keepMine`,
 * `reloadFromDisk` and `saveAs` existed with no caller; the note bar (owner
 * 01) is the caller now, and these rows pin the editor half — including that
 * a stale-base manual write keeps conflicting (the mock enforces the base
 * like `fsops.rs`), so Mod-S is not a way out and `keepMine` is.
 * ======================================================================= */

test('F66: a stale-base manual write keeps conflicting; keepMine clears it', async () => {
  const ipc = makeIpc({ 'a.md': 'alpha\n' })
  mount(ipc)
  await ED.openNote('a.md')
  type(' mine')
  // An outside write lands between the open and the flush.
  ipc.mtimes['a.md'] += 1
  ipc.files['a.md'] = 'alpha\nexternal\n'
  await ED.flushNow('idle').catch(() => {})
  assert.equal(ED.currentNoteState(), 'conflict')
  await ED.flushNow('manual').catch(() => {})
  assert.equal(ED.currentNoteState(), 'conflict', 'Mod-S with a stale base must not slip through')
  assert.equal(ED.isDirty(), true)
  assert.equal(ipc.files['a.md'], 'alpha\nexternal\n')
  await ED.keepMine()
  assert.equal(ED.currentNoteState(), 'live')
  assert.equal(ED.isDirty(), false)
  assert.equal(ipc.files['a.md'], 'alpha\n mine')
})

test('F66: reloadFromDisk takes the disk text and clears the conflict', async () => {
  const ipc = makeIpc({ 'a.md': 'alpha\n' })
  mount(ipc)
  await ED.openNote('a.md')
  type(' mine')
  ipc.mtimes['a.md'] += 1
  ipc.files['a.md'] = 'alpha\nexternal\n'
  await ED.flushNow('idle').catch(() => {})
  assert.equal(ED.currentNoteState(), 'conflict')
  await ED.reloadFromDisk()
  assert.equal(doc(), 'alpha\nexternal\n')
  assert.equal(ED.isDirty(), false)
  assert.equal(ED.currentNoteState(), 'live')
  type(' more')
  await ED.flushNow('manual')
  assert.equal(ipc.files['a.md'], 'alpha\nexternal\n more')
})

test('F66: resumeAfterVaultRestored returns a vault-lost note to live', async () => {
  const ipc = makeIpc({ 'a.md': 'alpha\n' })
  mount(ipc)
  await ED.openNote('a.md')
  type(' mine')
  ED.markVaultLost()
  assert.equal(ED.currentNoteState(), 'vault-lost')
  ED.resumeAfterVaultRestored()
  assert.equal(ED.currentNoteState(), 'live')
  await ED.flushNow('manual')
  assert.equal(ipc.files['a.md'], 'alpha\n mine')
})

test('F66: resumeAfterVaultRestored on a note changed while away conflicts', async () => {
  const ipc = makeIpc({ 'a.md': 'alpha\n' })
  mount(ipc)
  await ED.openNote('a.md')
  type(' mine')
  ED.markVaultLost()
  ipc.mtimes['a.md'] += 1
  ipc.files['a.md'] = 'alpha\naway\n'
  ED.resumeAfterVaultRestored()
  assert.equal(ED.currentNoteState(), 'live')
  await ED.flushNow('manual').catch(() => {})
  assert.equal(ED.currentNoteState(), 'conflict', 'the base-mtime guard is the detector')
  assert.equal(ipc.files['a.md'], 'alpha\naway\n')
})

/* F90: a metadata-only change (same mtime and size) must not reload the note.
 * The reload rebuilds every widget — dropping uncommitted Properties text —
 * over a clean buffer whose bytes never changed. */
test('F90: noteExternalChange with unchanged mtime+size skips the re-read', async () => {
  const ipc = makeIpc({ 'a.md': 'alpha\n' })
  mount(ipc)
  await ED.openNote('a.md')
  const readsBefore = ipc.calls.filter((c) => c.op === 'read').length
  const base = ipc.mtimes['a.md']
  await ED.noteExternalChange('a.md', base, 6)
  assert.equal(
    ipc.calls.filter((c) => c.op === 'read').length,
    readsBefore,
    'a metadata-only change re-read the note',
  )
  assert.equal(doc(), 'alpha\n')
  // A real change still reloads.
  ipc.files['a.md'] = 'alpha\nexternal\n'
  ipc.mtimes['a.md'] += 1
  await ED.noteExternalChange('a.md', ipc.mtimes['a.md'], 15)
  assert.equal(doc(), 'alpha\nexternal\n')
})

/* F80/F81/F82: file drops and tree-row drags land nowhere. CM6's default
 * reads every dropped File whole and inserts into whichever note is open when
 * the read finishes — including the wrong note after a switch. */
test('F80/F81/F82: refuseDrop takes tree drags and file drops, nothing else', () => {
  assert.equal(ED.refuseDrop(null), false)
  assert.equal(ED.refuseDrop({ types: [], files: [] }), false)
  assert.equal(ED.refuseDrop({ types: ['text/plain'], files: [] }), false)
  assert.equal(
    ED.refuseDrop({ types: ['text/plain', 'application/x-cairn-paths'], files: [] }),
    true,
    'a tree row lands nowhere',
  )
  assert.equal(ED.refuseDrop({ types: ['Files'], files: [{}, {}] }), true, 'files land nowhere')
})

/* F38: keystrokes typed while a file read is in flight must not be wiped —
 * neither by an outside-change reload nor by a note switch that was already
 * waiting on its own read. */
test('F38: typing into the old note during the new note read flushes first', async () => {
  const ipc = makeIpc({ 'a.md': 'alpha\n', 'b.md': 'beta\n' })
  mount(ipc)
  await ED.openNote('a.md')
  const orig = ipc.readNote.bind(ipc)
  let releaseB = null
  ipc.readNote = (path) => {
    if (path === 'b.md' && releaseB === null) {
      return new Promise((res) => { releaseB = () => orig(path).then(res) })
    }
    return orig(path)
  }
  const p = ED.openNote('b.md')
  assert.ok(releaseB, 'the test never held the read')
  type(' typed-during-read')
  releaseB()
  const r = await p
  assert.equal(r.ok, true)
  assert.equal(ipc.files['a.md'], 'alpha\n typed-during-read', 'keystrokes into A were lost')
  assert.equal(ED.currentPath(), 'b.md')
  assert.equal(doc(), 'beta\n')
})

test('F38: typing during an external-change read aborts the reload', async () => {
  const ipc = makeIpc({ 'a.md': 'alpha\n' })
  mount(ipc)
  await ED.openNote('a.md')
  const orig = ipc.readNote.bind(ipc)
  let release = null
  ipc.readNote = (path) => {
    if (release === null) return new Promise((res) => { release = () => orig(path).then(res) })
    return orig(path)
  }
  ipc.files['a.md'] = 'alpha\nfrom-outside\n'
  ipc.mtimes['a.md'] += 1
  const p = ED.noteExternalChange('a.md', ipc.mtimes['a.md'], 20)
  assert.ok(release, 'the test never held the read')
  type(' typed')
  release()
  await p
  assert.equal(doc(), 'alpha\n typed', 'the reload wiped keystrokes')
  assert.equal(ED.isDirty(), true)
  assert.equal(ipc.files['a.md'], 'alpha\nfrom-outside\n')
})

/* F83: a Properties field being typed is committed (blurred) before paths
 * that rebuild the widgets — quit, outside reload, note switch — or its text
 * dies with the widget. */
test('F83: openNote blurs a focused widget editor inside the note first', async () => {
  const ipc = makeIpc({ 'a.md': 'alpha\n', 'b.md': 'beta\n' })
  mount(ipc)
  await ED.openNote('a.md')
  const blurred = []
  globalThis.HTMLElement = class {}
  const field = { blur: () => { blurred.push(true) } }
  Object.setPrototypeOf(field, globalThis.HTMLElement.prototype)
  view().contentDOM.contains = () => true
  globalThis.document = { activeElement: field }
  try {
    const r = await ED.openNote('b.md')
    assert.equal(r.ok, true)
  } finally {
    delete globalThis.document
    delete globalThis.HTMLElement
  }
  assert.deepEqual(blurred, [true], 'the widget field was never committed')
})

/* Pasted clipboard images land inline as `![pasted image](data:…)` — the one
 * image use case. Like `refuseDrop` above, the pick rule is pure so it is
 * unit-testable without manufacturing a ClipboardEvent. */
test('image paste: firstClipboardImage takes the first image file, nothing else', () => {
  assert.equal(ED.firstClipboardImage(null), null)
  assert.equal(ED.firstClipboardImage({ files: [] }), null)
  assert.equal(ED.firstClipboardImage({ files: [{ type: 'text/plain' }] }), null)
  const png = { type: 'image/png' }
  assert.equal(ED.firstClipboardImage({ files: [png] }), png)
  assert.equal(
    ED.firstClipboardImage({ files: [{ type: 'text/plain' }, png] }),
    png,
    'a text item does not hide the image behind it',
  )
})

test('image paste: blobToDataUrl carries the MIME and the bytes', async () => {
  const url = await ED.blobToDataUrl(new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }))
  assert.equal(url, 'data:image/png;base64,iVBORw==')
})
