// `node --test tests/frontend/*.test.mjs`.
//
// src/main.ts's half of five repairs, run for real: main.ts is bundled with
// every sibling module replaced by a recording stub (the harness shape of
// vault-restore.test.mjs, generated from main.ts's own import list), and the
// closures `boot()` hands to those stubs are driven directly.
//
//   - the quit prompt, refused because another dialog is up, keeps the window;
//   - a refused open puts the tree's active row back on the note actually
//     open, and only THAT note's disappearance detaches it;
//   - every note state that stops autosave reaches the note bar, the bar's
//     buttons reach the editor, and Re-open of the same vault resumes a note
//     that went read-only with it;
//   - renames and moves run on the editor's write chain and hand the editor
//     the rename itself, not a path computed from a stale `currentPath()`;
//   - a delete confirmed after the vault changed underneath it deletes nothing.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import * as esbuild from 'esbuild'
import ts from 'typescript'
import { AElement, ADocument } from './_minidom.mjs'

const ROOT = new URL('../../', import.meta.url).pathname
const MAIN = readFileSync(ROOT + 'src/main.ts', 'utf8')

/* ═══ the harness ═════════════════════════════════════════════════════════ */

function importsOf(src) {
  const mods = new Map()
  const re = /import\s+(type\s+)?(?:\{([^}]*)\}|(\w+))\s+from\s+'([^']+)'/g
  for (const m of src.matchAll(re)) {
    const [, typeOnly, braced, dflt, spec] = m
    if (typeOnly) continue
    const names = mods.get(spec) ?? new Set()
    if (dflt) names.add('default')
    for (const raw of (braced ?? '').split(',')) {
      const part = raw.trim()
      if (part === '' || part.startsWith('type ')) continue
      names.add(part.split(/\s+as\s+/)[0].trim())
    }
    mods.set(spec, names)
  }
  return mods
}
const MODS = importsOf(MAIN)

function stubFor(spec, names) {
  const lines = [`const M = globalThis.__CAIRN_HARNESS__; const K = ${JSON.stringify(spec)};`]
  for (const n of names) {
    lines.push(`export const ${n === 'default' ? '__d' : n} = (...a) => M.call(K, ${JSON.stringify(n)}, a);`)
    if (n === 'default') lines.push('export default __d;')
  }
  return lines.join('\n')
}

const BUNDLE = (
  await esbuild.build({
    entryPoints: [ROOT + 'src/main.ts'],
    bundle: true, format: 'esm', write: false, logLevel: 'silent',
    plugins: [{
      name: 'stub-siblings',
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
          if (args.kind === 'entry-point') return null
          assert.ok(MODS.get(args.path), `main.ts imports '${args.path}', which this harness does not stub`)
          return { path: args.path, namespace: 'stub' }
        })
        build.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
          contents: stubFor(args.path, MODS.get(args.path)), loader: 'js',
        }))
      },
    }],
  })
).outputFiles[0].text

const drain = async () => { for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r)) }

let bootSeq = 0
async function bootMain(extra = {}, { pane = false, page } = {}) {
  const log = []
  const calls = {
    log,
    argsOf: (n) => log.filter((c) => c.name === n).map((c) => c.args),
    countOf: (n) => log.filter((c) => c.name === n).length,
    order: (...ns) => log.filter((c) => ns.includes(c.name)).map((c) => c.name),
    clear: () => { log.length = 0 },
  }
  const got = {}
  const returns = {
    './ipc:onVaultOpened': (a) => { got.applyVault = a[0]; return Promise.resolve() },
    './ipc:onFlushAndClose': (a) => { got.flushAndClose = a[0]; return Promise.resolve() },
    './ipc:onFlushForReload': () => Promise.resolve(),
    './ipc:onTreeChanged': () => Promise.resolve(),
    './ipc:onVaultLost': () => Promise.resolve(),
    './ipc:onWatchDegraded': () => Promise.resolve(),
    './ipc:onNoteExternalChange': () => Promise.resolve(),
    './ipc:currentVault': () => Promise.resolve({ state: 'none' }),
    './ipc:treeSnapshot': () => Promise.resolve(new ArrayBuffer(64)),
    './ipc:showMainWindow': () => Promise.resolve(),
    './ipc:confirmClose': () => Promise.resolve(),
    './editor:currentPath': () => null,
    './editor:isDirty': () => false,
    './chrome:wireChrome': (a) => { got.chromeDeps = a[0]; return recorder('chrome') },
    './tree:createTree': (a) => { got.treeHost = a[0]; return recorder('tree') },
    './search:mountSearch': () => recorder('search'),
    './tabstrip:createTabStrip': () => recorder('tabs'),
    './vaultbar:createVaultBar': () => recorder('bar'),
    './editor:setEditorHooks': (a) => { got.hooks = a[0] },
    ...extra,
  }
  const recorder = (tag) => new Proxy({}, {
    get: (_t, prop) => typeof prop === 'string'
      ? (...a) => { log.push({ mod: tag, name: prop, args: a }); const r = returns[tag + ':' + prop]; return r ? r(a) : undefined }
      : undefined,
  })
  const g = globalThis
  const el = () => ({ addEventListener() {}, appendChild() {}, style: {}, classList: { add() {}, remove() {} } })
  // `pane`: `#ed` gets a parent, so boot mounts the Memoir page and the reader
  // beside it; the caller stubs both (`./memoir:mountMemoir`, `./reader:mountReader`).
  const host = pane ? el() : null
  const saved = { document: g.document, requestAnimationFrame: g.requestAnimationFrame }
  g.__CAIRN_HARNESS__ = {
    call(mod, name, args) {
      log.push({ mod, name, args })
      const r = returns[mod + ':' + name]
      return r ? r(args) : undefined
    },
  }
  // `page`: the window main.ts reads its preload values from (`defaultView`).
  g.document = { readyState: 'complete', addEventListener() {}, getElementById: () => (host ? { ...el(), parentElement: host } : el()), querySelector: () => el(), defaultView: page }
  g.requestAnimationFrame = () => 0
  try {
    const src = BUNDLE + `\n//# boot=${bootSeq += 1}\n`
    await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'))
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete g[k]; else g[k] = v }
  }
  await drain()
  assert.ok(got.applyVault && got.treeHost && got.chromeDeps && got.hooks, 'boot() did not wire everything')
  calls.clear()
  return {
    calls, got,
    apply: async (info) => { got.applyVault(info); await drain() },
  }
}

const vaultInfo = (over = {}) => ({
  root: '/tmp/A', name: 'A', nNotes: 3, nDirs: 2, sort: 0, epoch: 1, lastNote: null,
  expanded: [], scrollTop: 0, watching: true, truncated: false, truncatedDepth: false, ...over,
})

/** Silence main.ts's `reportError` (console.error) for the length of `fn`. */
async function quietly(fn) {
  const real = console.error
  console.error = () => {}
  try { return await fn() } finally { console.error = real }
}

/* ═══ §1.6 — a refused quit prompt keeps the window ═══════════════════════ */

test('the quit prompt answered with anything but `quit` keeps the window open', async () => {
  for (const answer of ['cancel', 'keep', undefined]) {
    const { calls, got } = await bootMain({
      './editor:onFlushAndClose': () => Promise.resolve({ ok: false, kind: 'conflict' }),
      './modal:openModal': () => Promise.resolve(answer),
    })
    got.flushAndClose()
    await drain()
    assert.deepEqual(calls.argsOf('confirmClose'), [[false, 'conflict']],
      `the answer ${JSON.stringify(answer)} discarded the buffer and quit`)
  }
})

test('the quit prompt answered `quit` still quits, and a refused prompt leaves focus with the open dialog', async () => {
  {
    const { calls, got } = await bootMain({
      './editor:onFlushAndClose': () => Promise.resolve({ ok: false, kind: 'conflict' }),
      './modal:openModal': () => Promise.resolve('quit'),
    })
    got.flushAndClose()
    await drain()
    assert.deepEqual(calls.argsOf('confirmClose'), [[false, 'conflict'], [true]])
  }
  {
    const { calls, got } = await bootMain({
      './editor:onFlushAndClose': () => Promise.resolve({ ok: false, kind: 'conflict' }),
      './modal:openModal': () => Promise.resolve('keep'),
      './modal:modalIsOpen': () => true,
    })
    got.flushAndClose()
    await drain()
    assert.equal(calls.countOf('focusEditor'), 0, 'focus was pulled out from under the open dialog')
  }
})

/* ═══ the tree's active row follows the note actually open ════════════════ */

test('a vanished row detaches the open note only when it IS the open note', async () => {
  const { calls, got } = await bootMain({ './editor:currentPath': () => 'X.md' })
  got.treeHost.onActiveVanished('P.md')
  assert.equal(calls.countOf('markDetached'), 0, 'a healthy open note was detached because ANOTHER row vanished')
  got.treeHost.onActiveVanished('X.md')
  assert.equal(calls.countOf('markDetached'), 1)
})

test('a refused open puts the tree\'s active row back on the note that is open', async () => {
  const { calls, got } = await bootMain({
    './editor:currentPath': () => 'X.md',
    './editor:openNote': (a) => Promise.resolve({ ok: false, path: a[0], err: { kind: 'notUtf8', path: a[0] } }),
  })
  await quietly(async () => { got.treeHost.openNote('P.md'); await drain() })
  assert.deepEqual(calls.argsOf('openNote'), [['P.md']])
  assert.deepEqual(calls.argsOf('setActivePath').at(-1), ['X.md'], 'nothing resynced the tree after the refused open')
})

/* ═══ §7.2 / §7.3 cases 5, 7, 8 — the note bar ════════════════════════════ */
// NOTE: the state→bar mapping and the Keep mine / Reload / Discard wiring
// live in `conflict-bars.test.mjs` and the bar's own rendering in
// `chrome-ui.test.mjs` (F66). This file keeps the Save as… flow, which is
// main.ts's own prompt logic.

test('Save as… writes a NEW note in the old folder, and says so when that folder is gone', async () => {
  let editor = null
  const saves = []
  let refuse = null
  const { calls, got } = await bootMain({
    './editor:currentPath': () => 'Inbox/Misc.md',
    './inline-edit:parentOf': (a) => a[0].slice(0, Math.max(0, a[0].lastIndexOf('/'))),
    './inline-edit:displayName': () => 'Misc',
    './inline-edit:attachNameEditor': (a) => { editor = a[1]; return { focus() {} } },
    './editor:saveAs': (a) => {
      saves.push(a[0])
      if (refuse) { const e = refuse; refuse = null; return Promise.reject(e) }
      return Promise.resolve()
    },
  })
  const g = globalThis
  const saved = g.document
  const doc = new ADocument()
  doc.body = doc.createElement('body')
  AElement.prototype.appendChild ??= function (n) { this.append(n); return n }
  g.document = doc
  try {
    got.chromeDeps.saveAsPrompt()
    assert.ok(editor, 'Save as… opened no name field')
    assert.equal(editor.initial, 'Misc')
    assert.equal(editor.suffix, '.md')

    await editor.onCommit('Kept.md')
    assert.deepEqual(saves, ['Inbox/Kept.md'], 'Save as… did not write into the old folder')
    assert.ok(calls.countOf('treeSnapshot') >= 1, 'the tree was not refreshed after the new file')

    // The old folder has gone too: the field says so, and the NEXT commit
    // saves at the top of the vault — never silently.
    refuse = { kind: 'notFound' }
    await assert.rejects(() => editor.onCommit('Again.md'), /no longer exists/)
    await editor.onCommit('Again.md')
    assert.deepEqual(saves, ['Inbox/Kept.md', 'Inbox/Again.md', 'Again.md'])

    // alreadyExists is not a missing folder: the error stands and nothing moves.
    refuse = { kind: 'alreadyExists' }
    await assert.rejects(() => editor.onCommit('Taken.md'), (e) => e.kind === 'alreadyExists')
  } finally {
    g.document = saved
  }
})

test('Re-open of the SAME vault resumes a note that went read-only with it, after the refresh', async () => {
  let state = 'live'
  const { calls, apply } = await bootMain({ './editor:currentNoteState': () => state })
  await apply(vaultInfo())
  assert.equal(calls.countOf('resumeAfterVaultRestored'), 0, 'a healthy open resumed something')

  calls.clear()
  state = 'vault-lost'
  await apply(vaultInfo())
  assert.equal(calls.countOf('resumeAfterVaultRestored'), 1, 'Re-open left the note read-only with autosave off')
  assert.deepEqual(calls.order('applySnapshot', 'resumeAfterVaultRestored'), ['applySnapshot', 'resumeAfterVaultRestored'],
    'resumed before the refresh could detach a note that vanished while the vault was away')

  // A different vault is a switch, not a restore: `releaseVault` already emptied the pane.
  calls.clear()
  await apply(vaultInfo({ root: '/tmp/B' }))
  assert.equal(calls.countOf('resumeAfterVaultRestored'), 0)
})

/* ═══ §7.3 case 4 — renames and moves go through the write chain ═════════ */

test('a tree rename runs on the write chain and hands the editor the rename itself', async () => {
  const { calls, got, apply } = await bootMain({
    './editor:runOnWriteChain': (a) => a[0](),
    './editor:currentPath': () => 'Other.md',
    './ipc:renameEntry': () => Promise.resolve({ path: 'Notes/renamed.md', epoch: 2 }),
    'tree:beginRename': () => ({ closed: false }),
    'tree:expanded': () => [],
  })
  await apply(vaultInfo())
  calls.clear()
  got.treeHost.onRenameRequest('Notes/test.md', false)
  const opts = calls.argsOf('beginRename')[0][1]
  calls.clear()
  await opts.onCommit('renamed.md')
  assert.deepEqual(calls.order('runOnWriteChain', 'renameEntry', 'adoptRenamedPath'),
    ['runOnWriteChain', 'renameEntry', 'adoptRenamedPath'],
    'the rename did not run inside the write chain')
  // Whatever note is open, the editor decides whether the rename is its.
  assert.deepEqual(calls.argsOf('adoptRenamedPath'), [['Notes/test.md', 'Notes/renamed.md']])
})

test('a drag-move runs on the write chain, one entry at a time', async () => {
  const { calls, got, apply } = await bootMain({
    './editor:runOnWriteChain': (a) => a[0](),
    './ipc:moveEntry': (a) => Promise.resolve({ path: a[1] + '/' + a[0], epoch: 2 }),
    'tree:expanded': () => [],
  })
  await apply(vaultInfo())
  calls.clear()
  got.treeHost.onMoveRequest([{ path: 'a.md', isDir: false }, { path: 'Dir', isDir: true }], 'Dest')
  await drain()
  assert.deepEqual(calls.order('runOnWriteChain', 'moveEntry', 'adoptRenamedPath'), [
    'runOnWriteChain', 'moveEntry', 'adoptRenamedPath',
    'runOnWriteChain', 'moveEntry', 'adoptRenamedPath',
  ])
  assert.deepEqual(calls.argsOf('adoptRenamedPath'), [['a.md', 'Dest/a.md'], ['Dir', 'Dest/Dir']])
})

/* ═══ a delete confirmed after the vault changed deletes nothing ══════════ */

test('a Delete confirmed after a vault switch under the dialog deletes nothing', async () => {
  let answer
  const { calls, got, apply } = await bootMain({
    './modal:openModal': () => new Promise((r) => { answer = r }),
    './inline-edit:basename': (a) => a[0],
    'tree:getSelection': () => [],
  })
  await apply(vaultInfo({ root: '/tmp/A' }))
  calls.clear()
  got.treeHost.onDeleteRequest('Inbox.md', false)
  await drain()
  assert.equal(typeof answer, 'function', 'the delete confirm never opened')

  await apply(vaultInfo({ root: '/tmp/B', name: 'B' }))
  answer('delete')
  await drain()
  assert.equal(calls.countOf('deleteEntry'), 0, 'the other vault\'s Inbox.md was deleted')

  // Control: the same gesture with no switch deletes.
  answer = undefined
  got.treeHost.onDeleteRequest('Inbox.md', false)
  await drain()
  answer('delete')
  await drain()
  assert.deepEqual(calls.argsOf('deleteEntry'), [['Inbox.md', false]])
})

/* ═══ §0.55 E108 — a note takes the pane back from the reader ═════════════ */

/** A reader stub: `st` is what it reports, `log` what main.ts asked of it. */
function fakeReader(st, open = () => Promise.resolve(true)) {
  const log = []
  const impl = {
    path: () => st.path,
    visible: () => st.visible,
    close: () => { log.push('close'); st.visible = false; st.path = null },
    cancelOpen: () => { log.push('cancelOpen') },
    open: (path) => { log.push('open ' + path); return open(path) },
  }
  const reader = new Proxy({}, { get: (_t, p) => (p === 'then' ? undefined : impl[p] ?? (() => undefined)) })
  return { log, reader, closes: () => log.filter((x) => x === 'close').length }
}

test('a note replaces a reader that is up without a path: a book still loading, or a failed book\'s error page', async () => {
  const got = {}
  for (const [label, st] of [
    ['up, no path yet', { path: null, visible: true }],
    ['an open book', { path: 'B.epub', visible: true }],
    ['hidden, no path', { path: null, visible: false }],
  ]) {
    const f = fakeReader({ ...st })
    const { got: g } = await bootMain({
      './reader:mountReader': () => f.reader,
      './memoir:mountMemoir': () => new Proxy({}, { get: (_t, p) => (p === 'then' ? undefined : () => false) }),
      './editor:openNote': (a) => Promise.resolve({ ok: true, path: a[0] }),
    }, { pane: true })
    g.treeHost.openNote('N.md')
    await drain()
    got[label] = f.closes()
  }
  assert.deepEqual(got, { 'up, no path yet': 1, 'an open book': 1, 'hidden, no path': 0 },
    'the note opened under a reader that stayed up, or a hidden reader was closed for nothing')
})

test('a note whose read ends after a book was clicked: a book still loading keeps the pane; a reader holding a book is closed, as before', async () => {
  const got = {}
  for (const leg of ['still loading', 'opened', 'old book up, newer one failed']) {
    const old = leg === 'old book up, newer one failed'
    const st = old ? { path: 'A.epub', visible: true } : { path: null, visible: false }
    const f = fakeReader(st, (path) => {
      if (old) return Promise.resolve(false) // a replacement whose read fails keeps A up
      st.visible = true // the book takes the pane at once
      if (leg === 'still loading') return new Promise(() => {})
      st.path = path
      return Promise.resolve(true)
    })
    let release
    const { got: g } = await bootMain({
      './reader:mountReader': () => f.reader,
      './memoir:mountMemoir': () => new Proxy({}, { get: (_t, p) => (p === 'then' ? undefined : () => false) }),
      './editor:openNote': (a) => new Promise((r) => { release = () => r({ ok: true, path: a[0] }) }),
    }, { pane: true })
    g.treeHost.openNote('N.md')
    await drain()
    g.treeHost.openNote('B.epub')
    await drain()
    assert.ok(f.log.includes('open B.epub'), 'fixture: the book click never reached the reader')
    release()
    await drain()
    got[leg] = f.closes()
  }
  // The late note has been applied and holds the tab (the editor applies a
  // superseded read), so a reader holding a book is closed to match it; only a
  // path-less one, a newer book still loading, is left to finish.
  assert.deepEqual(got, { 'still loading': 0, opened: 1, 'old book up, newer one failed': 1 },
    'a late note closed a book still loading, or left a book up under the note\'s tab')
})

/* ═══ §0.58 E111 — the reader's microphone, bound on Linux only ═══════════ */

/** Boot with a pane and capture what main.ts hands the reader.  Nothing of
 *  the microphone may be built at boot: the counters see every call, also
 *  the ones `bootMain` clears from the log. */
async function bootReader(page, extra = {}) {
  let deps = null
  const made = { audios: [], mics: [], explains: [] }
  const AUDIO = { audio: true }
  const VIEW = { view: true }
  const harness = await bootMain({
    './reader:mountReader': (a) => { deps = a[1]; return new Proxy({}, { get: (_t, p) => (p === 'then' ? undefined : () => undefined) }) },
    './memoir:mountMemoir': () => new Proxy({}, { get: (_t, p) => (p === 'then' ? undefined : () => false) }),
    './mic-take:createMicAudio': (a) => { made.audios.push(a[0]); return AUDIO },
    './mic:mountMic': (a) => { made.mics.push(a); return VIEW },
    './explain:mountExplain': (a) => { made.explains.push(a); return {} },
    ...extra,
  }, { pane: true, page })
  assert.ok(deps, 'main.ts never mounted the reader')
  return { ...harness, deps, made, AUDIO, VIEW }
}

/** The band's factory reads its height from `window`, which node lacks. */
function withWindow(page, fn) {
  const had = 'window' in globalThis
  const saved = globalThis.window
  globalThis.window = page ?? {}
  try { return fn() } finally { if (had) globalThis.window = saved; else delete globalThis.window }
}

test('mic: no __CAIRN_OS__ (macOS, a plain browser): the reader gets no mountMic and nothing is built', async () => {
  for (const page of [undefined, {}, { __CAIRN_AI_BASE__: 'http://127.0.0.1:4321' }]) {
    const { deps, made } = await bootReader(page)
    assert.equal(deps.mountMic, undefined, `mountMic bound off Linux (page ${JSON.stringify(page)})`)
    assert.equal(typeof deps.mountExplain, 'function', 'the band lost its factory')
    assert.equal(made.audios.length + made.mics.length, 0)
  }
})

test('mic: on Linux, mountMic reaches mic.ts with the reader\'s hooks, a recorder on the band\'s base, command 23 and the modal/menu test', async () => {
  let modal = false
  let menu = false
  const { deps, made, calls, AUDIO, VIEW } = await bootReader({ __CAIRN_OS__: 'linux' }, {
    './ipc:copyText': (a) => Promise.resolve('copied ' + a[0]),
    './modal:modalIsOpen': () => modal,
    './menu:isMenuOpen': () => menu,
  })
  assert.equal(typeof deps.mountMic, 'function')
  assert.equal(made.audios.length + made.mics.length, 0, 'the microphone was built at boot, before a book')

  const host = { id: 'reader' }
  const hooks = { restoreFocus: () => 'restored' }
  assert.equal(deps.mountMic(host, hooks), VIEW)
  assert.equal(made.mics.length, 1)
  const [gotHost, d] = made.mics[0]
  assert.equal(gotHost, host)
  assert.equal(d.restoreFocus, hooks.restoreFocus, 'the reader\'s hook was not passed through')
  assert.equal(d.audio, AUDIO)
  assert.deepEqual(Object.keys(d).sort(), ['audio', 'copyText', 'layerAbove', 'onError', 'restoreFocus'])

  // The recorder: one per mount, on the default origin.
  assert.equal(made.audios.length, 1)
  assert.equal(made.audios[0].base, 'http://127.0.0.1:8770')
  assert.deepEqual(Object.keys(made.audios[0]).sort(), ['base', 'onError'])

  // Copy is command 23.
  calls.clear()
  assert.equal(await d.copyText('hello'), 'copied hello')
  assert.deepEqual(calls.argsOf('copyText'), [['hello']])

  // Esc steps aside for a modal or a menu.
  const seen = []
  for (const [m, n] of [[false, false], [true, false], [false, true], [true, true]]) {
    modal = m
    menu = n
    seen.push(d.layerAbove())
  }
  assert.deepEqual(seen, [false, true, true, true])

  // Both error paths go to reportError.
  calls.clear()
  const e1 = new Error('copy')
  const e2 = new Error('vad')
  await quietly(async () => { d.onError(e1, 'mic-copy'); made.audios[0].onError(e2, 'mic-vad') })
  assert.deepEqual(calls.argsOf('messageOf'), [[e1], [e2]])
})

test('mic: the band and the microphone share one ai-service origin', async () => {
  for (const [page, want] of [
    [{ __CAIRN_OS__: 'linux' }, 'http://127.0.0.1:8770'],
    [{ __CAIRN_OS__: 'linux', __CAIRN_AI_BASE__: 'http://127.0.0.1:4321' }, 'http://127.0.0.1:4321'],
    [{ __CAIRN_OS__: 'linux', __CAIRN_AI_BASE__: 'http://127.0.0.1:9' }, 'http://127.0.0.1:9'],
  ]) {
    const { deps, made } = await bootReader(page)
    deps.mountMic({}, { restoreFocus() {} })
    withWindow(page, () => deps.mountExplain({}, { onClosed() {} }))
    assert.equal(made.audios[0].base, want, 'the microphone\'s origin')
    assert.equal(made.explains[0][1].base, want, 'the band\'s origin')
  }
})

test('mic: 8770 is written once in main.ts, and otherwise only at memoir.ts\'s own route', () => {
  // Code only: a doc comment may name the port.
  const hits = {}
  const dir = ROOT + 'src/'
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.ts')).sort()) {
    const sf = ts.createSourceFile(name, readFileSync(dir + name, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    let n = 0
    const walk = (node) => {
      if (node.kind >= ts.SyntaxKind.FirstLiteralToken && node.kind <= ts.SyntaxKind.LastTemplateToken &&
        node.getText(sf).includes('8770')) n++
      ts.forEachChild(node, walk)
    }
    walk(sf)
    if (n) hits[name] = n
  }
  assert.deepEqual(hits, { 'main.ts': 1, 'memoir.ts': 1 })
})
