/**
 * tests/frontend/open-atomic.test.mjs — F42/F84's editor half, pinned
 * INDEPENDENTLY of any trigger fix.
 *
 * The totp safe-decode and the link regex remove two known throws, but the
 * editor invariant is general: ANY exception out of ANY StateField's `create`
 * for a note's text must report `{ok:false}` and keep the previous note
 * bound — never rebind `open` to a note the view does not show. So this file
 * bundles the SHIPPED `src/editor.ts` with `src/totp.ts` substituted by a
 * shim that re-exports the real module except that its `totp` field throws on
 * a sentinel string. A note holding the sentinel is a note no trigger fix
 * can save, and the open must still be atomic.
 */

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '..', '..')

/** @type {any} */ let ED

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
      return update
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

/* The throwing field: identical to the real `totp` extension for every doc
 * except one holding the sentinel, where its `create` throws. Non-sentinel
 * docs get `Decoration.none`, which is behaviourally identical here because
 * the test's plain note holds no totp block. */
const TOTP_SHIM = `
  export * from 'totp__real'
  import { StateField } from '@codemirror/state'
  import { Decoration, EditorView } from '@codemirror/view'
  const throwing = StateField.define({
    create(state) {
      if (state.doc.toString().includes('SENTINEL-THROW')) throw new Error('sentinel decorator boom')
      return Decoration.none
    },
    update(v) { return v },
    provide: (f) => EditorView.decorations.from(f),
  })
  export const totp = [throwing]
`

before(async () => {
  const esbuild = await import(
    pathToFileURL(join(ROOT, 'node_modules', 'esbuild', 'lib', 'main.js')).href
  )
  const dir = mkdtempSync(join(tmpdir(), 'cairn-oa-'))
  process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })
  const out = join(dir, 'bundle.mjs')

  const shimPlugin = {
    name: 'open-atomic-shims',
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
      build.onResolve({ filter: /^@codemirror\/view__real$/ }, () => ({
        path: join(ROOT, 'node_modules', '@codemirror', 'view', 'dist', 'index.js'),
      }))
      build.onResolve({ filter: /(^|\/)\.\/totp$|src\/totp(\.ts)?$/ }, (args) => {
        if (args.path === 'totp__real') return null
        return { path: args.path, namespace: 'totp-shim' }
      })
      build.onLoad({ filter: /.*/, namespace: 'totp-shim' }, () => ({
        contents: TOTP_SHIM,
        loader: 'ts',
        resolveDir: ROOT,
      }))
      build.onResolve({ filter: /^totp__real$/ }, () => ({
        path: join(ROOT, 'src', 'totp.ts'),
      }))
    },
  }

  await esbuild.build({
    stdin: {
      contents: 'export * from ' + JSON.stringify(join(ROOT, 'src', 'editor.ts')) + '\n',
      resolveDir: ROOT,
      sourcefile: 'open-atomic-test-entry.ts',
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

  const listeners = new Map()
  globalThis.window = {
    __PIXELTEST__: true,
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

function makeIpc(files) {
  const calls = []
  const ipc = {
    files: { ...files },
    calls,
    failWriteWith: null,
    mtime: 1000,
    async readNote(path) {
      calls.push({ op: 'read', path })
      const text = ipc.files[path]
      if (text === undefined) throw { kind: 'notFound' }
      return { text, mtimeMs: ipc.mtime, flags: 0 }
    },
    async writeNote(path, text, flags, baseMtimeMs, create) {
      calls.push({ op: 'write', path, text, flags, baseMtimeMs, create })
      const err = ipc.failWriteWith
      if (err) { ipc.failWriteWith = null; throw err }
      ipc.files[path] = text
      ipc.mtime += 1
      return { mtimeMs: ipc.mtime }
    },
  }
  return ipc
}

let mounted = false
function mount(ipc) {
  if (mounted) ED.showEmpty()
  ED.configureEditor(ipc)
  ED.setEditorHooks({})
  if (!mounted) { ED.mountEditor({}); mounted = true }
}

const view = () => globalThis.window.__CM_VIEW__
const doc = () => view().state.doc.toString()
const settle = () => new Promise((r) => setImmediate(r))

test('a note whose decorations throw reports ok:false and keeps the old note bound', async () => {
  const bad = 'hello\nSENTINEL-THROW\nworld\n'
  const ipc = makeIpc({ 'a.md': 'alpha\n', 'bad.md': bad })
  mount(ipc)
  const r1 = await ED.openNote('a.md')
  assert.equal(r1.ok, true)
  const r2 = await ED.openNote('bad.md')
  assert.equal(r2.ok, false)
  assert.match(String(r2.err?.message ?? r2.err?.kind ?? ''), /sentinel|boom|could not open/i)
  assert.equal(ED.currentPath(), 'a.md')
  assert.equal(doc(), 'alpha\n')
  view().dispatch({ changes: { from: view().state.doc.length, insert: 'more\n' } })
  await ED.flushNow('manual')
  await settle()
  assert.equal(ipc.files['bad.md'], bad)
  assert.equal(ipc.files['a.md'], 'alpha\nmore\n')
  assert.ok(!ipc.calls.some((c) => c.op === 'write' && c.path === 'bad.md'))
})

test('a failed external reload keeps the old base so the next write conflicts instead of clobbering', async () => {
  const ipc = makeIpc({ 'a.md': 'alpha\n' })
  mount(ipc)
  assert.equal((await ED.openNote('a.md')).ok, true)
  // The disk version gains a line AND the sentinel: the reload must fail.
  ipc.files['a.md'] = 'alpha\nexternal\nSENTINEL-THROW\n'
  await ED.noteExternalChange('a.md')
  assert.equal(doc(), 'alpha\n')
  view().dispatch({ changes: { from: view().state.doc.length, insert: 'mine\n' } })
  // The write must carry the PRE-reload base (1000), so Rust would conflict
  // rather than overwrite the external version.
  await ED.flushNow('manual').catch(() => {})
  await settle()
  const w = ipc.calls.filter((c) => c.op === 'write').at(-1)
  assert.ok(w, 'a write was attempted')
  assert.equal(w.baseMtimeMs, 1000)
})
