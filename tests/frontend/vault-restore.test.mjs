// Owner: 01.  `node --test tests/frontend/`.
//
// Spec: CONTRACT.md §7.6.1 (errata 3, Z2 — the read path for `expanded` and
// `scroll_top`), §7.6 (state.json), §4.3 (the vault switch), §1.5 (VaultInfo).
//
// ===========================================================================
// WHAT THIS FILE PROVES, AND HOW IT DIFFERS FROM THE OTHER FRONTEND FILES
// ===========================================================================
// §7.6.1 makes one frontend test mandatory, by name:
//
//   "`applyVault` with `switched === true` passes `info.expanded` to
//    `setExpanded` and `info.scrollTop` to `setScrollTop`, in that order,
//    around `refreshTree`; with `switched === false` it calls neither."
//
// `applyVaultInfo` is NOT exported from `src/main.ts` — main.ts is the entry
// point, it boots on import, and it deliberately exports nothing.  A grep-shaped
// assertion over its source would prove only that the right characters are
// present, and Z2 is exactly the class of bug where the characters looked fine
// (`setExpanded` WAS called; it was called with `[]`).
//
// So this file RUNS THE REAL FUNCTION.  main.ts is bundled by the same esbuild
// the app ships with, with every one of its sibling modules replaced by a
// recording stub (`stubFor` below, generated from main.ts's own import list, so
// a new import cannot silently slip past this harness — it fails to bundle).
// The bundle's `boot()` then hands our stub `onVaultOpened` the real
// `applyVaultInfo` closure, and the tests drive it.
//
// What is stubbed is every module BUT main.ts, which is the file under test.
// The assertions are about call ORDER and ARGUMENTS — never about a pixel, a
// box or a rendered row; those belong to tools/verify-geometry.js (gate G9).
// ===========================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as esbuild from 'esbuild'

const ROOT = new URL('../../', import.meta.url).pathname
const read = (p) => readFileSync(ROOT + p, 'utf8')

/* ═══ the harness ═════════════════════════════════════════════════════════ */

/**
 * Every module `src/main.ts` imports, and the named values it imports from
 * each — parsed out of main.ts itself rather than hardcoded, so that adding an
 * import to main.ts cannot leave this harness quietly stubbing the wrong set.
 * `import type` lines and `type X` members are skipped: esbuild erases them.
 */
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
      // `onFlushAndClose as editorFlushAndClose` -> the EXPORTED name.
      names.add(part.split(/\s+as\s+/)[0].trim())
    }
    mods.set(spec, names)
  }
  return mods
}

const MAIN = read('src/main.ts')
const MODS = importsOf(MAIN)

/** The recorder every stub funnels through. */
function makeCalls() {
  const log = []
  return {
    log,
    /** Names of the calls that matter to this file, in order. */
    order: (...names) => log.filter((c) => names.includes(c.name)).map((c) => c.name),
    argsOf: (name) => log.filter((c) => c.name === name).map((c) => c.args),
    countOf: (name) => log.filter((c) => c.name === name).length,
    clear: () => { log.length = 0 },
  }
}

function stubFor(spec, names) {
  const key = JSON.stringify(spec)
  const lines = [`const M = globalThis.__CAIRN_HARNESS__; const K = ${key};`]
  for (const n of names) {
    lines.push(
      `export const ${n === 'default' ? '__d' : n} = (...a) => M.call(K, ${JSON.stringify(n)}, a);`,
    )
    if (n === 'default') lines.push('export default __d;')
  }
  return lines.join('\n')
}

const stubPlugin = {
  name: 'cairn-stub-siblings',
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (args.kind === 'entry-point') return null
      const names = MODS.get(args.path)
      assert.ok(
        names,
        `main.ts imports '${args.path}', which this harness does not stub — add it or the ` +
          'test is running against a module it cannot see',
      )
      return { path: args.path, namespace: 'stub' }
    })
    build.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
      contents: stubFor(args.path, MODS.get(args.path)),
      loader: 'js',
    }))
  },
}

const BUNDLE = (
  await esbuild.build({
    entryPoints: [ROOT + 'src/main.ts'],
    bundle: true,
    format: 'esm',
    write: false,
    plugins: [stubPlugin],
    logLevel: 'silent',
  })
).outputFiles[0].text

/**
 * Boot the real main.ts against recording stubs and hand back the harness.
 * Returns `{ calls, applyVaultInfo }`, where `applyVaultInfo` is the genuine
 * closure main.ts registered on `nc://vault-opened` (§1.4) — the ONE place a
 * vault is applied, per main.ts's own ordering note 2.
 */
/**
 * §0.12 E14's `Copy absolute path` sink.  node has no `navigator.clipboard` and
 * the minidom deliberately refuses to invent browser APIs, so this file stubs
 * the ONE global the feature touches and records everything written to it.
 *
 * `navigator` is a non-writable accessor on node 24's global — a plain
 * assignment throws in strict mode — so `defineProperty` is the only way in.
 * Installed ONCE, for the whole file, and never restored: see the note in
 * `bootMain`.
 */
const CLIPBOARD = []
Object.defineProperty(globalThis, 'navigator', {
  value: { clipboard: { writeText: (t) => { CLIPBOARD.push(t); return Promise.resolve() } } },
  writable: true,
  configurable: true,
})

let bootSeq = 0
async function bootMain(extraReturns = {}) {
  const calls = makeCalls()
  let onVaultOpenedCb = null

  // The handful of values main.ts's stubbed collaborators must actually
  // RETURN rather than merely record.  Everything else may return undefined.
  const returns = {
    './ipc:onVaultOpened': (a) => { onVaultOpenedCb = a[0]; return Promise.resolve() },
    './ipc:onTreeChanged': () => Promise.resolve(),
    './ipc:onVaultLost': () => Promise.resolve(),
    './ipc:onWatchDegraded': () => Promise.resolve(),
    './ipc:onNoteExternalChange': () => Promise.resolve(),
    './ipc:onFlushAndClose': () => Promise.resolve(),
    // §7.5 / M65: 'none' so boot() applies NO vault — every application in this
    // file goes through the event, which is the only path the app uses.
    './ipc:currentVault': () => Promise.resolve({ state: 'none' }),
    // §0.12 E14.  A SENTINEL, not the real join: `absolutePath` is a pure
    // function with its own unit test in chrome-ui.test.mjs, and what this file
    // has to prove is the WIRING — that main.ts hands it (root, rel) in that
    // order and hands its RESULT to the clipboard.  Returning a string that
    // encodes both arguments makes an argument swap or a dropped result visible
    // in the assertion instead of invisible behind a plausible-looking path.
    './inline-edit:absolutePath': (a) => `ABS(${a[0]}|${a[1]})`,
    './ipc:treeSnapshot': () => Promise.resolve(new ArrayBuffer(64)),
    './ipc:showMainWindow': () => Promise.resolve(),
    './ipc:saveUiState': () => Promise.resolve(),
    './editor:currentPath': () => null,
    './editor:isDirty': () => false,
    // F35: renames run on the editor's write chain — pass through, or no
    // rename under test ever reaches its IPC.
    './editor:runOnWriteChain': (a) => a[0](),
    // The five FACTORIES: main.ts keeps their return values in module-level
    // bindings and calls methods on them all through the flow, so each one has
    // to be an object that records rather than an empty literal.
    './chrome:wireChrome': () => recorder('chrome'),
    './tree:createTree': () => recorder('tree'),
    './search:mountSearch': () => recorder('search'),
    './tabstrip:createTabStrip': () => recorder('tabs'),
    './vaultbar:createVaultBar': () => recorder('bar'),
    ...extraReturns,
  }

  /**
   * An object whose every method logs its own name and returns undefined —
   * unless `returns` names it, keyed `'<tag>:<method>'` exactly as the module
   * stubs are keyed.  A few of main.ts's flows BRANCH on what a factory handed
   * back (`tree.beginRename` returning null is "no row to host the field, use
   * the dialog"), and a recorder that can only return undefined would drive
   * every one of them down its fallback arm.
   */
  const recorder = (tag) =>
    new Proxy(
      {},
      {
        get: (_t, prop) =>
          typeof prop === 'string'
            ? (...a) => {
                calls.log.push({ mod: tag, name: prop, args: a })
                const r = returns[tag + ':' + prop]
                return r ? r(a) : undefined
              }
            : undefined,
      },
    )

  const el = () => ({ addEventListener() {}, appendChild() {}, style: {}, classList: { add() {}, remove() {} } })
  const g = globalThis
  const saved = {
    document: g.document,
    requestAnimationFrame: g.requestAnimationFrame,
    __CAIRN_HARNESS__: g.__CAIRN_HARNESS__,
  }
  // §0.12 E14.  CLIPBOARD is installed once, at module scope, and is NOT in
  // `saved`: the row-menu actions are invoked by the tests AFTER `bootMain()`
  // has returned, so a stub restored in the `finally` below would already be
  // gone — `navigator.clipboard` would be undefined, `copyAbsolutePath`'s own
  // try/catch would swallow the TypeError, and the assertion would fail with an
  // empty array for the wrong reason.  (It did, while this was being written.)
  CLIPBOARD.length = 0
  calls.clipboard = CLIPBOARD
  g.__CAIRN_HARNESS__ = {
    call(mod, name, args) {
      calls.log.push({ mod, name, args })
      const r = returns[mod + ':' + name]
      return r ? r(args) : undefined
    },
  }
  g.document = {
    readyState: 'complete',
    addEventListener() {},
    getElementById: () => el(),
    querySelector: () => el(),
  }
  // Inert: §6.1's show-on-first-frame is not what this file is testing, and
  // running it would put an unawaited promise in every test's tail.
  g.requestAnimationFrame = () => 0

  try {
    // A UNIQUE module URL per boot: ESM caches by specifier, and a second
    // `bootMain()` over the same bytes would silently reuse the first boot's
    // module — and its first boot's subscriptions.
    const src = BUNDLE + `\n//# boot=${bootSeq += 1}\n`
    await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'))
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete g[k]
      else g[k] = v
    }
  }

  // `currentVault()` resolves on a microtask; let boot()'s tail run.
  await Promise.resolve()
  await Promise.resolve()
  assert.ok(onVaultOpenedCb, 'main.ts did not subscribe to nc://vault-opened')
  // §0.12 E14: captured BEFORE the clear below, because `createTree` is called
  // once, in `boot()`.  `host.onContextMenu` is main.ts's real `rowMenu`.
  const treeHost = calls.argsOf('createTree')[0]?.[0]
  // A SNAPSHOT OF BOOT, taken before the clear below.  Everything `boot()`
  // itself did is erased by `calls.clear()`, which exists so the vault tests
  // see only what the EVENT did.  Both are wanted, so both are returned.
  const bootLog = calls.log.slice()
  const bootCalls = {
    countOf: (n) => bootLog.filter((c) => c.name === n).length,
    argsOf: (n) => bootLog.filter((c) => c.name === n).map((c) => c.args),
  }
  calls.clear()
  // §1.4's handler is `(info) => { void applyVaultInfo(info) }` — it returns
  // UNDEFINED, deliberately, because an event listener has nobody to await it.
  // So `apply` drains the microtask queue instead of awaiting a promise it was
  // never given; `applyVaultInfo` suspends once, on `treeSnapshot()`.
  return {
    calls,
    bootCalls,
    treeHost,
    apply: async (info) => {
      onVaultOpenedCb(info)
      for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r))
    },
  }
}

/** §1.5's ten-field `VaultInfo`, with the two Z2 fields. */
const vaultInfo = (over = {}) => ({
  root: '/tmp/A',
  name: 'A',
  nNotes: 3,
  nDirs: 2,
  sort: 0,
  epoch: 1,
  lastNote: null,
  expanded: [],
  scrollTop: 0,
  watching: true,
  truncated: false,
  truncatedDepth: false,
  ...over,
})

/* ═══ the tests ═══════════════════════════════════════════════════════════ */

/* ---- §7.3 case 16 / §0.12 E14 — `watching` is a READ PATH, both ways -----
 * These two tests exist because of a bug this errata pass introduced and the
 * review caught. E14 deleted nav slot 4, which was in the markup
 * UNCONDITIONALLY, and made the `.watch-degraded` banner the only host of the
 * `[ Refresh ]` that calls `rescan_all()`. `applyVaultInfo` only ever CLEARED
 * that banner — it was drawn by the `nc://watch-degraded` event alone — so a
 * missed event no longer cost the lit state, it cost the control, and a vault
 * whose watcher failed to start was silently dead for the session with no way
 * to refresh it.
 *
 * The event IS missable by design: `setup()` opens the vault on its own thread
 * and can emit before this page has registered a listener, which is the same
 * race §7.5's `current_vault()` fallback exists for. `VaultInfo.watching`
 * carries the identical fact on a value, so it is the fix.
 * ---------------------------------------------------------------------- */

test('§7.3 case 16 / E14 — watching:false DRAWS the banner, even with no event', async () => {
  const { calls, apply } = await bootMain()
  await apply(vaultInfo({ watching: false }))

  assert.equal(calls.countOf('setWatchDegraded'), 1,
    'a vault whose watcher never started drew no banner — since E14 that is a session with no Refresh at all')
  assert.equal(calls.countOf('clearWatchDegraded'), 0)
  // The reason is the general one: only the EVENT carries Rust's hint, and the
  // line is true without it.
  assert.deepEqual(calls.argsOf('setWatchDegraded'), [['watch-error', '']])
})

test('§7.3 case 16 / E14 — watching:true CLEARS it, and a rescan is the path that does', async () => {
  const { calls, apply } = await bootMain()
  await apply(vaultInfo({ watching: false }))
  calls.clear()

  // `rescan_all` retries the watcher and re-emits `nc://vault-opened`; a
  // successful retry is how the bar goes away.
  await apply(vaultInfo({ watching: true }))
  assert.equal(calls.countOf('clearWatchDegraded'), 1)
  assert.equal(calls.countOf('setWatchDegraded'), 0,
    'a healthy watcher redrew the degraded banner')

  // …and a retry that FAILED must leave it up, not flicker it away.
  calls.clear()
  await apply(vaultInfo({ watching: false }))
  assert.equal(calls.countOf('clearWatchDegraded'), 0)
  assert.equal(calls.countOf('setWatchDegraded'), 1)
})

/* ---- §0.12 E14 — Copy absolute path, driven for real -------------------- */

/** main.ts's `rowMenu`, as handed to `createTree` in `boot()` — the real closure. */
function rowMenuOf(treeHost) {
  assert.ok(treeHost, 'createTree was never called')
  assert.equal(typeof treeHost.onContextMenu, 'function', 'the tree got no context-menu host')
  return treeHost.onContextMenu
}

/** The action object main.ts passed to `fileRowMenu`/`folderRowMenu`/`emptySpaceMenu`. */
function actionsFrom(calls, name) {
  const args = calls.argsOf(name)
  assert.equal(args.length, 1, `${name} was not called exactly once`)
  return args[0][0]
}

test('§0.12 E14 — Copy absolute path composes root + rel and writes THAT to the clipboard', async () => {
  const { calls, treeHost, apply } = await bootMain()
  await apply(vaultInfo({ root: '/home/j/Vault' }))
  const rowMenu = rowMenuOf(treeHost)
  calls.clear()

  // A FILE row.
  rowMenu({ clientX: 10, clientY: 20 }, 'a/b/c.md', false)
  actionsFrom(calls, 'fileRowMenu').copyPath()
  assert.deepEqual(calls.clipboard, ['ABS(/home/j/Vault|a/b/c.md)'],
    'the clipboard did not receive absolutePath(root, rel) — check the argument order')

  // A FOLDER row goes to the same builder with the folder's OWN path, not its
  // parent: `destinationFor` is for creation, and copy is about this entry.
  calls.clear(); calls.clipboard.length = 0
  rowMenu({ clientX: 10, clientY: 20 }, 'Projects/2026', true)
  actionsFrom(calls, 'folderRowMenu').copyPath()
  assert.deepEqual(calls.clipboard, ['ABS(/home/j/Vault|Projects/2026)'])

  // EMPTY SPACE offers no copy row at all (user ruling, 2026-09-14): there is
  // no entry under the cursor, so the action object must not even carry one —
  // or reinstating the row in menu.ts would silently light it up again.
  calls.clear()
  rowMenu({ clientX: 10, clientY: 20 }, null, false)
  assert.equal('copyPath' in actionsFrom(calls, 'emptySpaceMenu'), false)
})

test('§0.16 E18 — main.ts hands a FILE only the three entry actions, a FOLDER all six', async () => {
  const { calls, treeHost, apply } = await bootMain()
  await apply(vaultInfo())
  const rowMenu = rowMenuOf(treeHost)

  // A FILE. `newNote`/`newFolder` must not merely be absent from the RENDERED
  // menu — main.ts must not build them at all, or a later reader reinstating the
  // rows in menu.ts would silently light them up again.
  calls.clear()
  rowMenu({ clientX: 1, clientY: 1 }, 'a.md', false)
  const file = actionsFrom(calls, 'fileRowMenu')
  assert.deepEqual(Object.keys(file).sort(), ['copyPath', 'remove', 'rename'],
    'the file row menu gained or lost an action')
  assert.equal(calls.countOf('folderRowMenu'), 0, 'a file was given the folder menu')
  assert.equal('reveal' in file, false, 'Reveal in Finder is back in the row menu')

  // A FOLDER gets all six, and its creates target the folder ITSELF — not its
  // parent, which is what the deleted `destinationFor()` would have returned for
  // anything but a directory.
  calls.clear()
  rowMenu({ clientX: 1, clientY: 1 }, 'Projects/2026', true)
  const folder = actionsFrom(calls, 'folderRowMenu')
  assert.deepEqual(Object.keys(folder).sort(),
    ['copyPath', 'newFolder', 'newNote', 'newSecret', 'remove', 'rename'])
  assert.equal(calls.countOf('fileRowMenu'), 0, 'a folder was given the file menu')

  // The DESTINATION is asserted at the source, not by calling `folder.newNote()`
  // — that reaches `promptForName`, which builds real DOM this harness has
  // already torn down. Scoped to `rowMenu`'s own body so it cannot be satisfied
  // by an unrelated `newNoteIn` elsewhere in the file.
  const main = read('src/main.ts')
  const body = main.slice(main.indexOf('function rowMenu('),
                          main.indexOf('/** The one route into the editor.'))
  assert.match(body, /newNote: \(\) => newNoteIn\(path\)/,
    'a create on a folder row must land INSIDE it, not in its parent')
  assert.match(body, /newFolder: \(\) => newFolderIn\(path\)/)
  assert.match(body, /newSecret: \(\) => newSecretIn\(path\)/,
    'a secret-file create on a folder row must land INSIDE it, like the other creates')
  // The DEFECT, not the word: `rowMenu`'s own comment names `parentOf` to say
  // it is not used, so a bare substring test would fail on its own explanation.
  assert.equal(/newNoteIn\(parentOf\(|newFolderIn\(parentOf\(/.test(body), false,
    'rowMenu is back to creating a SIBLING — that was the ambiguity E18 removed')
  // THE DECLARATION, not the word — main.ts names `destinationFor` twice in
  // comments explaining why it is gone. This is the second assertion in this
  // test that a bare substring match got wrong for the same reason, which is
  // the standing hazard of source scans: they read prose as code.
  assert.equal(/function destinationFor/.test(main), false,
    'destinationFor is back; its isDir branch died with the file menu\'s creates')

  // The empty-space menu omits rename/delete rather than disabling them, and
  // offers just the creates — user ruling, 2026-09-14: with no entry under the
  // cursor there is nothing to copy either, so `copyPath` is gone from the
  // action object, not only from the rendered rows.
  calls.clear()
  rowMenu({ clientX: 1, clientY: 1 }, null, false)
  assert.deepEqual(Object.keys(actionsFrom(calls, 'emptySpaceMenu')).sort(),
    ['newFolder', 'newNote', 'newSecret'])
})

test('New secret file names through the inline row, with the dialog fallback', async () => {
  // main.ts `newSecretIn`, read at the source: the name comes from the
  // tree's inline row editor (E22 parity — neither create gesture prompts),
  // not from a dialog and not from a second rename path in the viewer.
  // Scoped to `newSecretIn`'s own body so it cannot be satisfied by
  // `newFolderIn` next door — the standing hazard of source scans, named in
  // the E18 test above.
  const main = read('src/main.ts')
  const body = main.slice(main.indexOf('function newSecretIn('),
                          main.indexOf('The second half of both secret-file creation paths'))
  assert.match(body, /tree\.beginCreate\(parent,/, 'the secret create reserves no inline row')
  assert.match(body, /suffix: '\.md'/, 'the field would commit without the extension')
  assert.match(body, /promptForName\(\{/, 'no fallback when no row can host the editor')
  assert.match(body, /await createSecretNote\(parent, name\)/,
    'the commit does not reach the shared second half')
})

test('Delete applies to the whole shift-selection: one confirm PER file, in order', async () => {
  // Obsidian's own shape (`onDeleteSelectedFiles` → `removeSelection` → one
  // `promptForDeletion` per file): no bulk-confirm copy exists to transcribe,
  // so N files mean N sequential dialogs, each naming its file.
  const deleted = []
  const { calls, treeHost, apply } = await bootMain({
    './inline-edit:basename': (a) => String(a[0]).split('/').pop(),
    './modal:openModal': () => Promise.resolve('delete'),
    './ipc:deleteEntry': (a) => { deleted.push(a); return Promise.resolve({}) },
    'tree:getSelection': () => [
      { path: 'a.md', isDir: false },
      { path: 'b.md', isDir: false },
    ],
  })
  await apply(vaultInfo({ root: '/home/j/Vault' }))
  const rowMenu = rowMenuOf(treeHost)
  calls.clear()

  // The menu opens on a row INSIDE the selection: the whole selection goes.
  rowMenu({ clientX: 1, clientY: 1 }, 'a.md', false)
  actionsFrom(calls, 'fileRowMenu').remove()
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r))

  const specs = calls.argsOf('openModal').map((a) => a[0])
  assert.equal(specs.length, 2, 'each selected file gets its own confirm')
  assert.equal(specs[0].title, 'Delete file')
  assert.deepEqual(specs[0].detail, [
    'Are you sure you want to delete \u201ca.md\u201d?',
    'It will be moved to your system trash.',
  ])
  assert.equal(specs[0].focusId, 'delete')
  assert.deepEqual(deleted.map((a) => a[0]), ['a.md', 'b.md'])
})

test('Delete stops the sequence at the first Cancel, and a row outside the selection goes alone', async () => {
  const deleted = []
  const seen = []
  const { calls, treeHost, apply } = await bootMain({
    './modal:openModal': (a) => { seen.push(a[0].title); return Promise.resolve('cancel') },
    './ipc:deleteEntry': (a) => { deleted.push(a); return Promise.resolve({}) },
    'tree:getSelection': () => [
      { path: 'a.md', isDir: false },
      { path: 'b.md', isDir: false },
    ],
  })
  await apply(vaultInfo({ root: '/home/j/Vault' }))
  const rowMenu = rowMenuOf(treeHost)
  calls.clear()

  rowMenu({ clientX: 1, clientY: 1 }, 'a.md', false)
  actionsFrom(calls, 'fileRowMenu').remove()
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r))
  assert.equal(seen.length, 1, 'a Cancel continued to the next file')
  assert.deepEqual(deleted, [], 'a cancelled delete still deleted')

  // ...while a row OUTSIDE the selection deletes just itself.
  calls.clear()
  rowMenu({ clientX: 1, clientY: 1 }, 'lonely.md', false)
  actionsFrom(calls, 'fileRowMenu').remove()
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r))
  assert.deepEqual(deleted.map((a) => a[0]), [])
  assert.equal(seen.length, 2, 'a row outside the selection did not even confirm')
})

test('a selected folder swallows its selected descendants (no second confirm for a gone note)', async () => {
  const deleted = []
  const { calls, treeHost, apply } = await bootMain({
    './inline-edit:basename': (a) => String(a[0]).split('/').pop(),
    './modal:openModal': () => Promise.resolve('delete'),
    './ipc:deleteEntry': (a) => { deleted.push(a); return Promise.resolve({}) },
    'tree:getSelection': () => [
      { path: 'P', isDir: true },
      { path: 'P/a.md', isDir: false },
    ],
    'tree:descendantCount': () => 1,
  })
  await apply(vaultInfo({ root: '/home/j/Vault' }))
  const rowMenu = rowMenuOf(treeHost)
  calls.clear()

  rowMenu({ clientX: 1, clientY: 1 }, 'P', true)
  actionsFrom(calls, 'folderRowMenu').remove()
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r))
  assert.deepEqual(deleted.map((a) => a[0]), ['P'])
  // ...and the folder confirm carried the non-empty warnings.
  const spec = calls.argsOf('openModal')[0][0]
  assert.equal(spec.title, 'Delete folder')
  assert.deepEqual(spec.warnings, [
    'This folder is not empty.',
    'If you continue, all files inside this folder will be deleted.',
  ])
})

/* ═══════════════════════════════════════════════════════════════════════════
 * THE RENAME IS AN INLINE TREE ROW, NOT A DIALOG (§5.4.2, spec-04 §8.3).
 *
 * §0.17 E22 moved the two CREATE gestures off `promptForName`'s centred
 * backdrop dialog and onto the tree's own row editor, because that is what
 * Obsidian does. The rename was left on the dialog and is the third and last
 * of the three; Obsidian's `startRenameFile` puts a `contenteditable` on the
 * row's own title element with the whole name selected, and `app.css`'s
 * `.tree-item-self.is-being-renamed` rings the row in `--interactive-accent`.
 *
 * These run the REAL `renameFlow` — the row menu's own `rename` action, reached
 * through the same `onContextMenu` the tree calls — because a grep would prove
 * only that the characters `beginRename` are present in the file.
 * ═════════════════════════════════════════════════════════════════════════ */

/** Everything `renameFlow` needs from its stubbed collaborators to run to the
 *  end. `beginRename` returning an object is "a row hosted the field": the null
 *  it returns otherwise is main.ts's signal to fall back to the dialog. */
const renameReturns = (over = {}) => ({
  './inline-edit:displayName': (a) => `DISP(${a[0]})`,
  './inline-edit:basename': (a) => `BASE(${a[0]})`,
  'tree:beginRename': () => ({ closed: false }),
  'tree:expanded': () => [],
  ...over,
})

test('§5.4.2 — Rename opens the shared field IN THE TREE ROW, with no .md and all of it selected', async () => {
  const { calls, treeHost, apply } = await bootMain(renameReturns())
  await apply(vaultInfo())
  const rowMenu = rowMenuOf(treeHost)

  calls.clear()
  rowMenu({ clientX: 1, clientY: 1 }, 'Notes/test.md', false)
  actionsFrom(calls, 'fileRowMenu').rename()

  const opened = calls.argsOf('beginRename')
  assert.equal(opened.length, 1, 'Rename did not open the tree row editor')
  const [path, opts] = opened[0]
  assert.equal(path, 'Notes/test.md')
  // `displayName`, so the FIELD carries no extension — Obsidian's `getTitle()`
  // is `file.basename` and its `getNewPathAfterRename` puts the extension back.
  // The dialog showed `test.md` with only `test` selected.
  assert.equal(opts.initial, 'DISP(Notes/test.md)')
  assert.equal(opts.suffix, '.md', 'the extension must go back on at commit')
  assert.equal(opts.select, 'all')
  // And NO dialog: `promptForName` is the fallback for a path with no row, and
  // it is not this. (It would also throw — this harness has already put
  // `document` back — but the count says which failure it was.)
  assert.equal(calls.countOf('attachNameEditor'), 0, 'the rename still built a dialog')
})

test('spec-04 §8.3 — a folder rename RE-KEYS the expansion set, so the subtree stays open', async () => {
  const { calls, treeHost, apply } = await bootMain(
    renameReturns({
      // The trap is `Projectsx`: it starts with `Projects` and is NOT under it.
      'tree:expanded': () => ['Projects', 'Projects/2026', 'Projectsx', 'Other'],
      './ipc:renameEntry': () => Promise.resolve({ path: 'Work', epoch: 2 }),
      './editor:currentPath': () => 'Projects/2026/deep.md',
    }),
  )
  await apply(vaultInfo())
  const rowMenu = rowMenuOf(treeHost)

  calls.clear()
  rowMenu({ clientX: 1, clientY: 1 }, 'Projects', true)
  actionsFrom(calls, 'folderRowMenu').rename()
  const opts = calls.argsOf('beginRename')[0][1]
  assert.equal(opts.initial, 'BASE(Projects)', 'a folder shows its WHOLE name')
  assert.equal(opts.suffix, '', 'a folder must not be given .md')

  calls.clear()
  assert.deepEqual(await opts.onCommit('Work'), { ok: true })

  assert.deepEqual(calls.argsOf('renameEntry'), [['Projects', 'Work']])
  // The expansion set is PATH-KEYED (§3.4) and Rust just moved every path under
  // the folder. Without the re-key `restore()` finds neither `Projects` nor
  // `Projects/2026` in the new blob and the folder the user renamed COLLAPSES
  // under them, with everything in it.
  assert.deepEqual(calls.argsOf('setExpanded'), [[['Work', 'Work/2026', 'Projectsx', 'Other']]])
  // …and the PERSISTED copy follows, or the dead keys come back on the next
  // launch — which is exactly when they would be believed.
  assert.deepEqual(
    calls.argsOf('patchUi').filter((a) => a[0] && 'expanded' in a[0]),
    [[{ expanded: ['Work', 'Work/2026', 'Projectsx', 'Other'] }]],
  )
  // ORDER: `applySnapshot` runs `restore()` against whatever the set holds at
  // that moment, so a re-key after it would be one snapshot too late.
  assert.deepEqual(calls.order('setExpanded', 'applySnapshot'), ['setExpanded', 'applySnapshot'])
  // §7.3 case 4: the open note is UNDER the renamed folder. main.ts hands the
  // editor the rename ITSELF — (old, new) — and the editor re-bases the open
  // note under it; nothing is recomputed from a stale `currentPath()`.
  assert.deepEqual(calls.argsOf('adoptRenamedPath'), [['Projects', 'Work']])
})

test('a NOTE rename leaves the expansion set alone — nothing under it moved', async () => {
  const { calls, treeHost, apply } = await bootMain(
    renameReturns({
      'tree:expanded': () => ['Projects'],
      './ipc:renameEntry': () => Promise.resolve({ path: 'Notes/renamed.md', epoch: 2 }),
      './editor:currentPath': () => 'Notes/test.md',
    }),
  )
  await apply(vaultInfo())
  const rowMenu = rowMenuOf(treeHost)
  calls.clear()
  rowMenu({ clientX: 1, clientY: 1 }, 'Notes/test.md', false)
  actionsFrom(calls, 'fileRowMenu').rename()
  const opts = calls.argsOf('beginRename')[0][1]

  calls.clear()
  await opts.onCommit('renamed.md')
  assert.equal(calls.countOf('setExpanded'), 0, 'a note rename rewrote the expansion set')
  assert.equal(calls.countOf('patchUi'), 0)
  // The renamed note IS the open one; the editor decides that from the
  // (old, new) pair it is handed, not from a `currentPath()` read before the IPC.
  assert.deepEqual(calls.argsOf('adoptRenamedPath'), [['Notes/test.md', 'Notes/renamed.md']])
})

test('§0.12 E14 — a vault already sorted A-Z is NOT re-sorted; a stale mode is corrected once', async () => {
  const { calls, apply } = await bootMain()
  await apply(vaultInfo({ sort: 0 }))
  assert.equal(calls.countOf('setSort'), 0,
    'every vault open paid a set_sort round trip for nothing')

  calls.clear()
  await apply(vaultInfo({ sort: 2 }))
  assert.deepEqual(calls.argsOf('setSort'), [[0]],
    'a vault persisted on modified-time stayed there, with no UI left to change it')
  // …and it is PERSISTED, or the correction repeats on every launch forever.
  assert.ok(calls.argsOf('patchUi').some((a) => a[0] && a[0].sort === 0),
    'the corrected sort was never written back to state.json')
})

test('§7.6.1 — a switched vault restores the PERSISTED expansion set, not []', async () => {
  const { calls, apply } = await bootMain()
  await apply(vaultInfo({ expanded: ['Projects', 'Projects/2026'], scrollTop: 432 }))

  assert.deepEqual(
    calls.argsOf('setExpanded'),
    [[['Projects', 'Projects/2026']]],
    'the tree opened collapsed — this is the Z2 regression, and `[]` is how it looks',
  )
  assert.deepEqual(
    calls.argsOf('setScrollTop'),
    [[432]],
    'the sidebar scroll position was not restored',
  )
})

test('§7.6.1 — the order is setExpanded -> refreshTree -> setScrollTop', async () => {
  const { calls, apply } = await bootMain()
  await apply(vaultInfo({ expanded: ['Projects'], scrollTop: 96 }))

  // `treeSnapshot` + `applySnapshot` ARE refreshTree; there is no other caller
  // of either in this flow.  setExpanded must precede both (restore() applies
  // the set in the same pass that resolves the cursor) and setScrollTop must
  // follow both (the clamp needs a real content height, which is 0 before the
  // snapshot — restoring 432 into an empty tree would clamp it to 0 and the
  // bug would survive the fix).
  assert.deepEqual(
    calls.order('setExpanded', 'treeSnapshot', 'applySnapshot', 'setScrollTop'),
    ['setExpanded', 'treeSnapshot', 'applySnapshot', 'setScrollTop'],
  )
})

test('refreshTree fetches the secret rels and hands them to the tree, after the snapshot', async () => {
  const { calls, apply } = await bootMain({
    './ipc:secretNotes': () => Promise.resolve(['Notes/Creds.md']),
  })
  await apply(vaultInfo({ expanded: [], scrollTop: 0 }))
  // Order: the mark resolves against the blob THIS refresh adopted — a
  // secrets-first order would resolve the paths against the previous blob.
  assert.deepEqual(
    calls.order('treeSnapshot', 'applySnapshot', 'secretNotes', 'setSecrets'),
    ['treeSnapshot', 'applySnapshot', 'secretNotes', 'setSecrets'],
  )
  assert.deepEqual(calls.argsOf('setSecrets'), [[['Notes/Creds.md']]])
})

test('§7.6.1 — a RESCAN of the same vault applies neither, so it cannot stomp live expansion', async () => {
  const { calls, apply } = await bootMain()
  await apply(vaultInfo({ expanded: ['Projects'], scrollTop: 96 }))
  calls.clear()

  // What `rescan_all` and a watcher-driven re-emit both look like from here:
  // the SAME root, carrying the state as it was last PERSISTED.  The user has
  // expanded three more folders since, and none of them is in that set yet —
  // the write is debounced 1,000 ms (§7.6).  Applying it would collapse them.
  await apply(vaultInfo({ expanded: ['Projects'], scrollTop: 96 }))
  assert.equal(calls.countOf('setExpanded'), 0, 'a rescan stomped the live expansion set')
  assert.equal(calls.countOf('setScrollTop'), 0, 'a rescan stomped the live scroll position')
  // …and it is a real refresh, not a no-op: the tree IS re-snapshotted.
  assert.equal(calls.countOf('applySnapshot'), 1)

  // Even when the persisted set has gone EMPTY behind the app's back.
  calls.clear()
  await apply(vaultInfo({ expanded: [], scrollTop: 0 }))
  assert.equal(calls.countOf('setExpanded'), 0)
  assert.equal(calls.countOf('setScrollTop'), 0)
})

test('§7.6.1 — a genuine vault SWITCH applies the new vault’s own state', async () => {
  const { calls, apply } = await bootMain()
  await apply(vaultInfo({ root: '/tmp/A', expanded: ['A1'], scrollTop: 10 }))
  calls.clear()

  await apply(vaultInfo({ root: '/tmp/B', name: 'B', expanded: ['B1', 'B1/B2'], scrollTop: 250 }))
  assert.deepEqual(calls.argsOf('setExpanded'), [[['B1', 'B1/B2']]])
  assert.deepEqual(calls.argsOf('setScrollTop'), [[250]])
})

test('§7.6.1 — nothing is re-validated on the frontend: Rust already truncated and clamped', () => {
  // The contract is explicit that `expanded` arrives truncated to 2,000 and
  // `scrollTop` arrives finite and >= 0 ("so no caller re-validates").  A
  // second cap here would be a second rule in a second place, and the two would
  // drift.  main.ts must forward the values, unexamined.
  assert.match(MAIN, /if \(switched\) tree\.setExpanded\(info\.expanded\)/)
  assert.match(MAIN, /if \(switched\) tree\.setScrollTop\(info\.scrollTop\)/)
  assert.doesNotMatch(
    MAIN,
    /setExpanded\(\[\]\)[\s\S]{0,200}await refreshTree/,
    'main.ts is back to opening every vault collapsed',
  )
})

test('the two Z2 fields are on the VaultInfo the frontend is typed against (§1.5)', () => {
  const ipc = read('src/ipc.d.ts')
  const decl = ipc.slice(ipc.indexOf('export interface VaultInfo'))
  const body = decl.slice(0, decl.indexOf('}'))
  assert.match(body, /\n\s*expanded: VaultPath\[\];/)
  assert.match(body, /\n\s*scrollTop: number;/)
})

/* ═══════════════════════════════════════════════════════════════════════════
 * THE TREE'S OWN PERSIST DEBOUNCE, ACROSS A SWITCH AND A QUIT.  tree.ts holds
 * expansion/scroll changes for 1 s before they reach state.ts, so both
 * flushes must pull them in first or the last second of changes is lost — or,
 * on a switch, fires later and is filed under the incoming vault.
 * ═════════════════════════════════════════════════════════════════════════ */

test('releaseVault flushes the tree\'s pending persists before flushUi, and drops the teardown\'s', async () => {
  const { calls, bootCalls } = await bootMain()
  const barHost = bootCalls.argsOf('createVaultBar')[0][0]
  await barHost.releaseVault('switch')
  assert.deepEqual(
    calls.order('flushPersist', 'flushUi', 'discardPendingUi', 'setExpanded', 'cancelPersist'),
    ['flushPersist', 'flushUi', 'discardPendingUi', 'setExpanded', 'cancelPersist'],
  )
})

test('the close handshake flushes the tree\'s pending persists before flushUi and confirmClose', async () => {
  let closeCb = null
  const { calls } = await bootMain({
    './ipc:onFlushAndClose': (a) => { closeCb = a[0]; return Promise.resolve() },
    './editor:onFlushAndClose': () => Promise.resolve({ ok: true }),
  })
  assert.ok(closeCb, 'main.ts did not subscribe to the close handshake')
  closeCb()
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r))
  const seq = calls.log
    .map((c) => c.mod + ':' + c.name)
    .filter((k) => ['./editor:onFlushAndClose', 'tree:flushPersist', './state:flushUi', './ipc:confirmClose'].includes(k))
  assert.deepEqual(seq, ['./editor:onFlushAndClose', 'tree:flushPersist', './state:flushUi', './ipc:confirmClose'])
})
