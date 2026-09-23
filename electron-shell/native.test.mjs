/**
 * electron-shell/native.test.mjs -- proves the REAL Rust encoders against the
 * REAL JavaScript decoders, over the Node-API addon.
 *
 * IT REPLACES `wire.test.mjs`, WHICH IS DELETED WITH ITS SUBJECT. That file
 * guarded `electron-shell/backend/wire.mjs` -- a JavaScript re-implementation
 * of TreeBlob v1 and the §2 note frame, written for step 4 and deleted at step
 * 5 -- by encoding with the copy and decoding with the originals. The test was
 * the right shape; its subject was scaffolding.
 *
 * What it does now is strictly stronger, because BOTH SIDES ARE SHIPPED CODE:
 * `tree.rs` and `note_frame.rs` encode, and `src/treeblob.ts`'s `adopt()` --
 * with its full `validate()` pass: invariant P, the depth chain, reserved kind
 * bits, name-offset monotonicity -- and `src/note_frame.js`'s `decodeNote`,
 * with its four drift guards, decode. Nothing here is a fixture of a fixture.
 *
 * The ordering cases are still the ones ported from
 * `core/tests/vault_ops.rs:1211`, but they now reach `tree.rs`'s own
 * `nat_cmp` through the filesystem and the wire rather than a JS port of it.
 *
 * Run: node --test electron-shell/native.test.mjs
 * (`electron-shell/cairn.node` must exist: npm run electron:native)
 */

import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

import { loadAddon, nativeCommands, toEnvelope } from './native.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/* The real TypeScript decoder, transpiled on the fly. Same arrangement
   `wire.test.mjs` used, and the same cleanup: registered on `exit` so a FAILING
   run cleans up too -- which is exactly the run that used to leak. */
const outDir = mkdtempSync(join(tmpdir(), 'cairn-native-test-'))
/* THE WORK DIRECTORY IS SPELLED THE WAY THE CORE SPELLS IT, OR §0.30 E70's
   TEST CANNOT PASS ON A MAC. `core/src/prefs.rs:33-53` is the rule: every
   vault key -- `vault`, each `recents` entry, each key of `vaults` -- is the
   string `fsops::canonical_root()` produced at open (`fs::canonicalize`,
   fsops.rs:153, called from `app::open_vault_blocking`), and `PrefsStore`
   canonicalises nothing, so "IF YOU ADD A CALLER, CANONICALISE BEFORE YOU
   CALL". A test that compares roots is such a caller.

   On macOS `os.tmpdir()` is `$TMPDIR` = `/var/folders/…/T/`, and `/var` is a
   symlink to `private/var`, so one directory has two spellings. Measured
   2026-09-13 (Apple M2, macOS 26.6.2, node v26.8.1): `recent_vaults` reported
   `/private/var/folders/…/vault` while `VAULT` was `/var/folders/…/vault`, and
   the E70 test failed at its FIRST line -- "the open vault is not in recents"
   -- which hid that `other` below had the same raw spelling and would have
   failed its own recents check too. On Debian `/tmp` is a real directory, so
   `realpathSync` is the identity there and every path in this file is the
   string it always was. It has never been recorded green on macOS before
   this: CLAUDE.md §2's macOS block says `native 21`, which predates E70.

   Fixed HERE, once, and not at the comparison, because every path this file
   builds -- `VAULT`, `other`, `sortvault`, `dirfirst` -- is `join(work, …)`.
   The core is not changed: it is behaving exactly as prefs.rs documents. */
const work = realpathSync(mkdtempSync(join(tmpdir(), 'cairn-native-vault-')))
process.on('exit', () => {
  for (const d of [outDir, work]) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {}
  }
})
const outFile = join(outDir, 'treeblob.mjs')
esbuild.buildSync({
  entryPoints: [join(ROOT, 'src', 'treeblob.ts')],
  outfile: outFile,
  format: 'esm',
  bundle: false,
})
const { adopt } = await import(pathToFileURL(outFile).href)
const { decodeNote } = await import(pathToFileURL(join(ROOT, 'src', 'note_frame.js')).href)

const addon = loadAddon()
const cmd = nativeCommands(addon)
const events = []

/* ── the vault ────────────────────────────────────────────────────────────
     Notes/            dir,  subtree 2
       Alpha           file (Alpha.md)
       Beta            file (Beta.md)
     README            file (README.md)
   The same shape `wire.test.mjs`'s SAMPLE hand-built, now built on disk and
   walked by `scan.rs`.
   ───────────────────────────────────────────────────────────────────────── */
const VAULT = join(work, 'vault')

/** True when the filesystem folded `README.md` and `readme.md` into one file. */
let caseInsensitiveFs = false

before(() => {
  mkdirSync(join(VAULT, 'Notes'), { recursive: true })
  writeFileSync(join(VAULT, 'Notes', 'Alpha.md'), '# Alpha\n')
  writeFileSync(join(VAULT, 'Notes', 'Beta.md'), '# Beta\n')
  writeFileSync(join(VAULT, 'README.md'), 'readme body\n')

  addon.start(
    (event, payload) => events.push({ event, payload }),
    () => {},
    // §7.6's file, inside the temp tree: a test must never write the state.json
    // of the person running it (spike-M D1).
    join(work, 'state.json')
  )
})

after(() => {
  // `AppState` holds a watcher thread per open vault; dropping the vault stops
  // it. There is no `close_vault` command, so the process simply exits -- which
  // is what the app does too. (§1.3 is twenty-ONE since §0.30 E70's
  // `forget_vault`, which closes nothing: it edits a list.)
})

// ASYNC ADDON: tree_snapshot runs off the event loop (spawn_blocking), so every
// snapshot awaits.
const snapshot = async () => adopt(await cmd.tree_snapshot())

test('the addon opens a real vault and the walk is scan.rs’s', async () => {
  const info = await cmd.open_vault({ path: VAULT })
  assert.equal(info.nNotes, 3)
  assert.equal(info.nDirs, 1)
  assert.equal(info.watching, true, 'watcher.rs started; the JS backend never had one')
  assert.equal(info.truncated, false)
})

test('TreeBlob v1: the REAL decoder accepts the REAL encoder and validate() passes', async () => {
  const blob = await snapshot()
  assert.equal(blob.n, 4)
  assert.equal(blob.sortOrder, 0)
  assert.ok(blob.epoch >= 1, 'the epoch is pre-increment, so the first is 1')
})

test('TreeBlob v1: names, kinds and paths round-trip through the real decoder', async () => {
  const blob = await snapshot()
  const names = Array.from({ length: blob.n }, (_, i) => blob.nameOf(i))
  assert.deepEqual(names, ['Notes', 'Alpha', 'Beta', 'README'], 'dirs first, then A-Z')
  assert.equal(blob.isDir(0), true)
  assert.equal(blob.isDir(1), false)
  // pathOf re-appends .md for files, and only for files (§3.2/§1.1).
  assert.equal(blob.pathOf(0), 'Notes')
  assert.equal(blob.pathOf(1), 'Notes/Alpha.md')
  assert.equal(blob.pathOf(3), 'README.md')
})

test('TreeBlob v1: the encoded length is exactly 36 + 14N + M', async () => {
  const buf = await cmd.tree_snapshot()
  const blob = adopt(buf)
  const m = Array.from({ length: blob.n }, (_, i) =>
    Buffer.byteLength(blob.nameOf(i), 'utf8')
  ).reduce((a, b) => a + b, 0)
  assert.equal(buf.byteLength, 36 + 14 * blob.n + m)
})

/* ── K4: the assumption `native.mjs`'s `asArrayBuffer` rests on ───────────── */
test('K4: the addon’s Buffer owns its whole ArrayBuffer, so handing it on costs nothing', async () => {
  const buf = await addon.treeSnapshot()
  assert.equal(buf.byteOffset, 0, 'not a slice of node’s 8 KiB pool')
  assert.equal(
    buf.byteLength,
    buf.buffer.byteLength,
    'napi-rs’s napi_no_external_buffers_allowed fallback allocates exactly'
  )
})

/* ── the §2 note frame ───────────────────────────────────────────────────── */
test('note frame: the real decoder round-trips text and mtime from the real encoder', async () => {
  const r = decodeNote(await cmd.read_note({ path: 'README.md' }))
  assert.equal(r.text, 'readme body\n')
  assert.equal(r.flags, 0)
  assert.ok(Number.isInteger(r.mtimeMs) && r.mtimeMs > 0, 'timestamps are i64 ms (§1.1)')
})

test('note frame: multi-byte UTF-8 survives, and size is BYTES not characters', async () => {
  const text = 'niño 日本語 \u{1f600}\n'
  writeFileSync(join(VAULT, 'utf8.md'), text)
  await cmd.rescan_all()
  const buf = await cmd.read_note({ path: 'utf8.md' })
  assert.equal(decodeNote(buf).text, text)
  assert.equal(buf.byteLength, 24 + Buffer.byteLength(text, 'utf8'))
})

test('note frame: an empty note is a valid frame', async () => {
  writeFileSync(join(VAULT, 'empty.md'), '')
  await cmd.rescan_all()
  assert.equal(decodeNote(await cmd.read_note({ path: 'empty.md' })).text, '')
})

test('note frame: CRLF and the BOM are NORMALISED OUT and reported as flags (§2.2)', async () => {
  writeFileSync(join(VAULT, 'dos.md'), '﻿first\r\nsecond\r\n')
  await cmd.rescan_all()
  const r = decodeNote(await cmd.read_note({ path: 'dos.md' }))
  assert.equal(r.text, 'first\nsecond\n', 'the frontend never sees a \\r or a BOM')
  assert.equal(r.flags, 0b11, 'FLAG_CRLF | FLAG_BOM')
})

test('write_note re-applies the flags, so a DOS file stays a DOS file on disk (§2.3)', async () => {
  const before = decodeNote(await cmd.read_note({ path: 'dos.md' }))
  const receipt = await cmd.write_note({
    path: 'dos.md',
    text: new TextEncoder().encode(before.text),
    flags: before.flags,
    baseMtimeMs: before.mtimeMs,
    create: false,
  })
  assert.ok(receipt.mtimeMs > 0)
  const raw = readFileSync(join(VAULT, 'dos.md'))
  assert.deepEqual(
    Array.from(raw.subarray(0, 3)),
    [0xef, 0xbb, 0xbf],
    'the BOM came back'
  )
  assert.ok(raw.includes('\r\n'), 'the CRLFs came back')
})

/* ── the three guards the conflict argument carries ───────────────────────────
     `write_note`'s conflict guard accepts a NUMBER (guarded) and `null`
     (§7.2's force-overwrite), and rejects `undefined` -- a dropped argument --
     because "a conflict guard that silently disables itself when a value is
     dropped is not a guard". The distinction is carried by the argument TYPE:
     `Either<f64, Null>`.

     THESE THREE TESTS EXIST BECAUSE THAT CLAIM WAS WRITTEN IN A COMMENT AND
     NOTHING PROVED IT. §0.19's third defect is the precedent: a property that
     no test reads cannot fail one, and this one guards the user's text.
   ────────────────────────────────────────────────────────────────────────── */

const NOTE = 'guard.md'
const enc = (t) => new TextEncoder().encode(t)
const onDisk = () => readFileSync(join(VAULT, NOTE), 'utf8')

test('guard 1: a DROPPED baseMtimeMs is refused, and it is NOT a §1.5 condition', async () => {
  writeFileSync(join(VAULT, NOTE), 'original\n')
  await cmd.rescan_all()

  // IT THROWS SYNCHRONOUSLY, BEFORE THE PROMISE EXISTS, and that is stronger
  // than a rejection: argument conversion happens on the JS thread before napi
  // builds the future, so there is no async path on which the refusal could be
  // dropped and no unhandled rejection to swallow it.
  let err = null
  try {
    const p = cmd.write_note({ path: NOTE, text: enc('clobbered\n'), flags: 0, create: false })
    await p
  } catch (e) {
    err = e
  }
  assert.ok(err, 'a missing baseMtimeMs must not write')
  assert.equal(err.code, 'InvalidArg')
  assert.match(err.message, /none of these types/)
  // AND IT MUST NOT WEAR §1.5's CLOTHES. A dropped field is a caller bug, not a
  // vault condition the UI should draw a conflict bar for -- so `toEnvelope`
  // must RE-THROW it rather than turning it into `{ok:false}`.
  assert.doesNotMatch(err.message, /cairn\.VaultError:/)
  await assert.rejects(
    () => toEnvelope(() => cmd.write_note({ path: NOTE, text: enc('x\n'), flags: 0, create: false })),
    { code: 'InvalidArg' }
  )
  assert.equal(onDisk(), 'original\n', 'the note is untouched by either attempt')
})

test('guard 2: a STALE baseMtimeMs is a §1.5 conflict, and the note is untouched', async () => {
  const env = await toEnvelope(() =>
    cmd.write_note({ path: NOTE, text: enc('clobbered\n'), flags: 0, baseMtimeMs: 1, create: false })
  )
  assert.equal(env.ok, false)
  assert.equal(env.error.kind, 'conflict')
  assert.ok(env.error.diskMtimeMs > 1, 'the bar needs the disk mtime to offer "Keep mine"')
  assert.equal(onDisk(), 'original\n')
})

test('guard 3: an EXPLICIT null is §7.2’s force-overwrite and DOES write', async () => {
  const receipt = await cmd.write_note({
    path: NOTE,
    text: enc('forced\n'),
    flags: 0,
    baseMtimeMs: null,
    create: false,
  })
  assert.ok(receipt.mtimeMs > 0)
  assert.equal(onDisk(), 'forced\n', '"Keep mine" must get through a conflict')
})

/* ── §1.5, which the step-4 scaffold could not carry at all ──────────────── */
test('a VaultError crosses the addon as its structured payload, not as a string', async () => {
  const env = await toEnvelope(() => cmd.read_note({ path: 'nope.md' }))
  assert.equal(env.ok, false)
  assert.deepEqual(env.error, { kind: 'notFound', path: 'nope.md' })
})

test('every §1.5 field survives, not just `kind`', async () => {
  const env = await toEnvelope(() => cmd.set_sort({ sort: 9 }))
  assert.equal(env.ok, false)
  assert.equal(env.error.kind, 'invalidPath')
  assert.equal(env.error.reason, 'sort must be 0, 1, 2 or 3')
})

test('§0.30 E70 — command 21 round-trips, and REFUSES the open vault', async () => {
  // Through the real addon and the real `nativeCommands` map, not through
  // `app::forget_vault` directly: the thing this file exists to prove is that
  // the seam carries what the core returns, and a §1.5 error is the half of
  // that seam nothing else here exercises for a SYNC command.
  const before = await cmd.recent_vaults()
  assert.ok(before.some((v) => v.root === VAULT), 'the open vault is not in recents')

  // The open vault is refused. Obsidian's own rule -- its `vault-remove`
  // answers false and its chooser says "Can't remove a currently open vault."
  const refused = await toEnvelope(() => cmd.forget_vault({ root: VAULT }))
  assert.equal(refused.ok, false, 'the OPEN vault was removed from the list')
  // §1.5 through §1.1's wire casing (X13), which is what the frontend switches
  // on. `messageOf` renders `reason`, so it must not be empty either.
  assert.equal(refused.error.kind, 'invalidPath', JSON.stringify(refused.error))
  assert.match(String(refused.error.reason), /currently open vault/)
  assert.deepEqual(await cmd.recent_vaults(), before, 'a refused removal edited the list')

  // A vault that is NOT open goes, and nothing else does.
  const other = join(work, 'other-vault')
  mkdirSync(other, { recursive: true })
  writeFileSync(join(other, 'Keep.md'), '# keep\n')
  await cmd.open_vault({ path: other })
  await cmd.open_vault({ path: VAULT })          // …and switch back, so `other` is closed
  assert.ok((await cmd.recent_vaults()).some((v) => v.root === other))

  await cmd.forget_vault({ root: other })
  assert.equal((await cmd.recent_vaults()).some((v) => v.root === other), false,
    'the vault is still in the tracked list')
  // THE FOLDER IS UNTOUCHED. A user reading the word "Close" would be right to
  // be angry if it were not, so it is asserted here as well as in Rust.
  assert.deepEqual(readdirSync(other), ['Keep.md'])
})

test('command 25 — secret_notes lists marked files, in snapshot order', async () => {
  // A vault of its own (like E70's `other`): the shared fixture's file set is
  // exact elsewhere in this file and must not gain a secret file.
  const v = join(work, 'secretvault')
  mkdirSync(join(v, 'Notes'), { recursive: true })
  writeFileSync(join(v, 'Notes', 'Creds.md'), '---\ncairn-type: secrets\n---\n')
  writeFileSync(join(v, 'Notes', 'Plain.md'), '# plain\n')
  writeFileSync(join(v, 'Top.md'), '# top\n')
  await cmd.open_vault({ path: v })
  // Through the real addon and the real `nativeCommands` map: the seam must
  // carry a plain JSON string array, not a Buffer and not an envelope.
  assert.deepEqual(await cmd.secret_notes(), ['Notes/Creds.md'])
  await cmd.open_vault({ path: VAULT })          // …and switch back
  assert.deepEqual(await cmd.secret_notes(), [], 'the mark leaked across vaults')
})

test('a fault that is NOT a §1.5 condition still throws (start() twice)', () => {
  assert.throws(
    () => addon.start(() => {}, () => {}, null),
    /start\(\) was called twice/
  )
})

/* ── ordering: tree.rs's own nat_cmp, reached through the filesystem ──────── */
test('the blob’s order is tree.rs nat_cmp, on the Rust suite’s own cases', async () => {
  const v = join(work, 'sortvault')
  mkdirSync(v, { recursive: true })
  for (const n of ['Note 2.md', 'Note 10.md', 'a9.md', 'a10.md', 'a010.md',
                   'Zebra.md', 'apple.md', '日本.md', '日本語.md']) {
    writeFileSync(join(v, n), 'x\n')
  }
  writeFileSync(join(v, 'README.md'), 'x\n')
  writeFileSync(join(v, 'readme.md'), 'x\n')
  // macOS folds the pair into one file; Debian does not. Detected rather than
  // assumed, because which arm runs is a property of the machine.
  caseInsensitiveFs = !readdirSync(v).includes('readme.md')

  await cmd.open_vault({ path: v })
  const blob = await snapshot()
  const names = Array.from({ length: blob.n }, (_, i) => blob.nameOf(i))
  const at = (n) => names.indexOf(n)

  assert.ok(at('Note 2') < at('Note 10'), '2 before 10')
  assert.ok(at('a9') < at('a10'))
  assert.ok(at('a010') > at('a9'), 'leading zeros are stripped')
  assert.ok(at('Zebra') > at('apple'), 'case-insensitive')
  assert.ok(at('日本') < at('日本語'))

  if (caseInsensitiveFs) {
    // The pair cannot exist, so the tie-break has nothing to break. Asserted
    // rather than skipped silently: this arm runs on the Mac and the other on
    // Debian, and a reader must be able to tell which one their run took.
    assert.equal(at('readme'), -1, 'a case-insensitive filesystem folded the pair')
  } else {
    assert.ok(
      at('README') < at('readme'),
      'folded equal => a.cmp(b), so the order is TOTAL'
    )
  }
  await cmd.open_vault({ path: VAULT })
})

test('directories precede files in every mode (tree.rs cmp_key rule 1)', async () => {
  const v = join(work, 'dirfirst')
  mkdirSync(join(v, 'zzz'), { recursive: true })
  writeFileSync(join(v, 'aaa.md'), 'x\n')
  await cmd.open_vault({ path: v })
  const blob = await snapshot()
  assert.deepEqual(
    [blob.nameOf(0), blob.nameOf(1)],
    ['zzz', 'aaa'],
    'a z-named folder still precedes an a-named file'
  )
  await cmd.open_vault({ path: VAULT })
})

/* ── the §1.4 event table, which only exists on this shell because AppCtx does */

/** Wait for an event, or give up loudly. A threadsafe function always DEFERS to
 *  the JS thread -- `emit_event` enqueues and returns -- so an event raised from
 *  inside a command has not been delivered when that command returns. Tauri's
 *  `emit` defers to the webview in exactly the same way; the assertion has to
 *  wait in both shells. */
async function waitFor(name, ms = 2000) {
  const until = Date.now() + ms
  for (;;) {
    const hit = events.filter((e) => e.event === name)
    if (hit.length > 0) return hit
    if (Date.now() > until) throw new Error(`no ${name} within ${ms} ms`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

test('every mutation announces nc://tree-changed from INSIDE the command', async () => {
  events.length = 0
  const created = await cmd.create_note({ parent: 'Notes', name: 'made.md' })
  assert.equal(created.path, 'Notes/made.md')
  const changed = await waitFor('nc://tree-changed')
  assert.equal(changed.length, 1, 'app::repair_and_emit raised it; native.mjs did not')
  assert.equal(changed[0].payload.epoch, created.epoch, 'the payload is THE EPOCH (§3.5)')
  await cmd.delete_entry({ path: 'Notes/made.md', permanent: true })
})

test('an EXTERNAL edit reaches the frontend — the step-4 scaffold had no watcher', async () => {
  await cmd.read_note({ path: 'README.md' })   // §1.4 filters by THE OPEN NOTE
  events.length = 0
  writeFileSync(join(VAULT, 'README.md'), 'edited by something that is not Cairn\n')
  const [ev] = await waitFor('nc://note-external-change', 5000)
  assert.equal(ev.payload.path, 'README.md')
  assert.ok(ev.payload.size > 0)
})
