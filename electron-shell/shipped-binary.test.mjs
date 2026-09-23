/**
 * electron-shell/shipped-binary.test.mjs -- data-loss case `dl_23`, moved.
 *
 * `dl_23_the_shipped_binary_opens_sweeps_and_watches_a_real_vault` was the LAST
 * `#[ignore]`d test in `core/tests/dataloss.rs`, and its reason was the same one
 * that held gap G-b open: *"launches a real window; `cargo test` must never open
 * one"*. Its subject -- `target/release/bundle/macos/Cairn.app/.../cairn`, or
 * `target/release/cairn` -- was deleted with the Tauri shell at §8.2 step 10.
 *
 * IT RUNS HEADLESS NOW, AND AGAINST A BETTER SUBJECT. `CAIRN_HEADLESS=1`
 * renders fully offscreen, so nothing reaches the display and this needs no
 * permission from anybody; and the binary it drives is `out/cairn-linux-x64/`,
 * the artefact `npm run package:deb` installs, rather than a developer build.
 *
 * WHAT IT PROVES, and why a unit test cannot: `vault::open_at` sweeping crash
 * debris is covered by `dl_02` at the Rust seam. What `dl_02` cannot see is
 * whether the SHIPPED STARTUP PATH still calls it -- a sweep that is correct in
 * `fsops.rs` and never reached from the shell leaves the user's vault filling
 * with `.tmp-` files, silently, while every unit test passes. That is the same
 * class as §0.20.6's two defects, and the same reason `dl_28` exists.
 *
 * Run: node --test electron-shell/shipped-binary.test.mjs
 */

import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { NO_DISPLAY } from './have-display.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const STAGE = join(ROOT, 'out', `cairn-linux-${process.arch === 'x64' ? 'x64' : process.arch}`)

const SKIP =
  process.platform !== 'linux'
    ? 'the LINUX package. "macOS has never built one" was true when written and is ' +
      'NOT true now: K8 was answered on 2026-09-09 and the .app builds, signs and ' +
      'launches. This is DATA-LOSS case dl_23, so the skip is worth naming precisely: ' +
      'the shipped-artefact data-loss check has still never run on macOS, and it ' +
      'cannot until packaging comes back into scope (descoped by user ruling for the ' +
      'development phase). An honest gap, not a passing test'
    : !existsSync(join(HERE, 'cairn.node'))
      ? 'no cairn.node; run npm run electron:native'
      : !existsSync(join(HERE, 'app', 'index.html'))
        ? 'no bundle; run node electron-shell/build-app.mjs'
        : NO_DISPLAY

/** A pid that is certainly dead: spawn something trivial and reap it. The Rust
 *  original does exactly this with `/usr/bin/true`, for the same reason -- a
 *  hard-coded pid might be alive on the machine running the test. */
function deadPid() {
  const r = spawnSync('/bin/true', [], { encoding: 'utf8' })
  assert.equal(r.status, 0, 'could not spawn /bin/true to burn a pid')
  return r.pid
}

let out = ''
let work = ''
let vault = ''
let seeded = ''

const DECOY = '/nonexistent/decoy-vault'

before(() => {
  if (SKIP) return
  execFileSync(process.execPath, [join(ROOT, 'tools', 'package-electron.mjs')], {
    cwd: ROOT,
    stdio: 'pipe',
  })

  work = mkdtempSync(join(tmpdir(), 'cairn-shipped-'))
  vault = join(work, 'vault')
  mkdirSync(join(vault, 'Notes'), { recursive: true })
  mkdirSync(join(vault, 'A', 'B'), { recursive: true })
  writeFileSync(join(vault, 'Misc.md'), 'before\n')
  writeFileSync(join(vault, 'Notes', 'Deep.md'), 'deep\n')
  writeFileSync(join(vault, 'A', 'B', 'n.md'), 'nested\n')

  /* THE THREE THINGS THE SWEEP MUST TELL APART (M67, `fsops::should_sweep`):
       - a DEAD pid's temp        -> unlinked on sight
       - a LIVE pid's temp        -> spared, because a running instance may be
                                     mid-write; only age past LIVE_PID_GRACE
                                     makes it a candidate, and this one is new
       - a file that is NOT OURS  -> never touched. `.hidden.tmp-notes` looks
                                     like debris and does not match
                                     `.<any>.tmp-<digits>-<digits>` */
  writeFileSync(join(vault, `.Misc.md.tmp-${deadPid()}-0`), 'dead debris\n')
  writeFileSync(join(vault, `.Misc.md.tmp-${process.pid}-1`), 'live in-flight\n')
  writeFileSync(join(vault, '.hidden.tmp-notes'), "the user's own file\n")
  // And one under a subdirectory, because the sweep walks the tree.
  writeFileSync(join(vault, 'Notes', `.Deep.md.tmp-${deadPid()}-0`), 'dead debris, nested\n')

  /* `recents` is seeded with a DECOY FIRST, so that the fixture moving to the
     front is PROOF the shipped process read and rewrote THIS file rather than
     one under the user's real home. Straight from the Rust original. */
  seeded = join(work, 'state.json')
  writeFileSync(
    seeded,
    JSON.stringify({ v: 1, vault: null, recents: [DECOY], vaults: {} }, null, 2)
  )

  const r = spawnSync(join(STAGE, 'cairn'), [], {
    env: {
      ...process.env,
      CAIRN_HEADLESS: '1',
      CAIRN_BOOT_PROBE: '1',
      CAIRN_DIAG: '1',
      CAIRN_VAULT: vault,
      CAIRN_STATE_DIR: work,
      CAIRN_ELECTRON_GEOM: '',
    },
    encoding: 'utf8',
    timeout: 120_000,
  })
  out = (r.stdout ?? '') + (r.stderr ?? '')
})

after(() => {
  if (work) {
    try { rmSync(work, { recursive: true, force: true }) } catch {}
  }
})

const bootProbe = () => {
  const line = out.split('\n').find((l) => l.startsWith('BOOT_PROBE '))
  assert.ok(line, `the shipped binary never reported\n${out.slice(0, 4000)}`)
  return JSON.parse(line.slice('BOOT_PROBE '.length))
}

test('dl_23: the SHIPPED binary opens a real vault', { skip: SKIP }, () => {
  const p = bootProbe()
  // Reaching the probe at all is the "it did not exit on its own" assertion the
  // Rust original made with `try_wait`.
  assert.equal(p.vaultName, 'vault', 'the shipped binary did not open the vault')
  assert.ok(p.treeRowNames.includes('Misc'), 'the tree did not render the vault')
  assert.equal(p.codeMirrorMounted, true)
})

test('dl_23: the crash sweep runs in the SHIPPED startup path, and it is EXACT (M67)', { skip: SKIP }, () => {
  bootProbe() // fail with the launch output rather than a confusing ENOENT

  const gone = readdirSync(vault).filter((f) => f.startsWith('.Misc.md.tmp-'))
  assert.equal(gone.length, 1, `expected exactly the live temp to survive, found ${gone}`)
  assert.match(gone[0], new RegExp(`\\.tmp-${process.pid}-1$`), 'the wrong temp survived')

  assert.ok(
    !existsSync(join(vault, 'Notes', readdirSync(join(vault, 'Notes')).find((f) => f.startsWith('.Deep')) ?? 'x')),
    'a dead-pid temp inside a subdirectory survived; the sweep did not walk the tree'
  )
  assert.ok(
    existsSync(join(vault, '.hidden.tmp-notes')),
    "a file that is NOT ours was unlinked -- `.hidden.tmp-notes` does not match `.<x>.tmp-<pid>-<n>`"
  )
})

test('dl_23: §7.6 / G8 — the vault holds the notes and nothing else', { skip: SKIP }, () => {
  bootProbe()
  const visible = readdirSync(vault).filter((f) => !f.startsWith('.')).sort()
  assert.deepEqual(visible, ['A', 'Misc.md', 'Notes'], 'the shipped app changed the vault')
  // G8's other half: nothing of ours was written INTO the vault.
  assert.ok(!existsSync(join(vault, 'state.json')), '§7.6: state.json must never live in the vault')
})

test('dl_23: it read and rewrote THE SEEDED state.json, not the user’s', { skip: SKIP }, () => {
  bootProbe()
  const after = JSON.parse(readFileSync(seeded, 'utf8'))
  assert.equal(after.vault, vault, 'the shipped app did not record the vault it opened')
  assert.equal(
    after.recents[0],
    vault,
    `the fixture did not reach the front of recents (got ${JSON.stringify(after.recents)}) -- ` +
      'so this process was reading some OTHER state.json'
  )
  assert.ok(after.recents.includes(DECOY), 'the decoy was dropped; recents is not being preserved')
})

test('dl_23: the watcher STARTED — the half the Rust original could not see', { skip: SKIP }, () => {
  /* The original asserted the sweep and the state file and stopped there: from
     Rust, with the app in another process, `watching` was not observable. It is
     here, because §1.4's `nc://vault-opened` carries it -- and `CAIRN_DIAG=1`
     prints the shell -> page direction only since this test asked for it; it
     used to log page -> shell alone, which made the whole event table
     invisible from outside the process. A vault that opens unwatched is §0.12.2's
     network-vault case -- legitimate there, and a silent regression here. */
  const line = out.split('\n').find((l) => l.startsWith('[event] nc://vault-opened'))
  assert.ok(line, `no nc://vault-opened was emitted\n${out.slice(0, 2000)}`)
  const info = JSON.parse(line.slice(line.indexOf('{')))
  assert.equal(info.watching, true, 'the shipped binary opened the vault UNWATCHED')
  assert.equal(info.nNotes, 3, `the walk found ${info.nNotes} notes, expected 3`)
})
