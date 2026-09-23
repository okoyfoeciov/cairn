/**
 * electron-shell/lifecycle.test.mjs -- §8.2 step 7.
 *
 * The step's done-when is *"✕, ⌘Q/Ctrl-Q and a write-denied parent all flush
 * through the SAME function"*. Three legs, and this file executes the second:
 *
 *   ✕                      `window-control.test.mjs` -- a real click on the real
 *                          button, reported from the QUIT so it means the whole
 *                          handshake ran
 *   ⌘Q / Ctrl-Q / Quit     HERE. `app.quit()` is what all three raise
 *   write-denied parent    `dl_04` (the flush rejects with `Io`) plus
 *                          `close-handshake.test.mjs` G-b/2 (a rejecting flush
 *                          CANCELS the close and nothing quits anyway)
 *
 * Plus single-instance, which is the other half of step 7 and is Obsidian's own
 * answer: `obsidian-1.13.7.asar`'s `main.js` calls
 * `app.requestSingleInstanceLock()` and gives up the process if it does not get
 * it. Read, not assumed -- §0.17's method.
 *
 * Run: node --test electron-shell/lifecycle.test.mjs
 * (needs a display connection and `electron-shell/cairn.node`)
 */

import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { NO_DISPLAY } from './have-display.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const BIN = join(ROOT, 'node_modules', '.bin', 'electron')
const APP = join(HERE, 'app-main.mjs')

const SKIP = !existsSync(BIN)
  ? 'no electron binary; run npm ci'
  : !existsSync(join(HERE, 'cairn.node'))
    ? 'no cairn.node; run npm run electron:native'
    : !existsSync(join(HERE, 'app', 'index.html'))
      ? 'no bundle; run node electron-shell/build-app.mjs'
      : NO_DISPLAY

/** A vault and a hermetic state directory. `CAIRN_STATE_DIR` is what makes a
 *  run hermetic in BOTH senses: its own `state.json` AND its own `userData`,
 *  which is what Electron keys the single-instance lock on. */
const dirs = []
after(() => {
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }) } catch {}
  }
})
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'cairn-life-'))
  dirs.push(dir)
  const vault = join(dir, 'vault')
  mkdirSync(vault, { recursive: true })
  writeFileSync(join(vault, 'Note.md'), '# Note\n\nbody\n')
  return { dir, vault }
}

/**
 * `detached: true` IS LOAD-BEARING FOR THE TWO TESTS THAT KILL THEIR CHILD.
 *
 * Electron is not one process: it forks a GPU process, a zygote and a renderer,
 * and they INHERIT the stdio pipes. `child.kill('SIGKILL')` reaps only the
 * parent, the children keep the write end of the pipe open, and `node --test`
 * then waits for a stream that will never end -- measured, and it looked
 * exactly like a hung test rather than a leaked process.
 *
 * A detached child is its own process group, so `process.kill(-pid)` takes the
 * whole tree. `stop()` also destroys the streams, because a group kill still
 * races the pipe's own close.
 */
function launch(env, extra = {}) {
  const { args = [], ...rest } = extra
  return spawn(BIN, [APP, ...args], {
    cwd: ROOT,
    env: { ...process.env, CAIRN_HEADLESS: '1', CAIRN_ELECTRON_GEOM: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    ...rest,
  })
}

/** Kill a launched child AND everything it forked. */
function stop(child) {
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    // Already gone, or never started its group -- either way there is nothing
    // left to kill and the streams below are what actually matter.
    try {
      child.kill('SIGKILL')
    } catch {}
  }
  child.stdout.destroy()
  child.stderr.destroy()
}

/** Collect a child's output until it exits, or until `waitFor` appears. */
function watch(child, { waitFor = null, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    let out = ''
    let err = ''
    let settled = false
    const finish = (o) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(o)
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(`timed out after ${timeoutMs} ms\nSTDOUT:\n${out}\nSTDERR:\n${err}`))
    }, timeoutMs)
    child.stdout.on('data', (d) => {
      out += d
      if (waitFor && out.includes(waitFor)) finish({ out, err, code: null })
    })
    child.stderr.on('data', (d) => {
      err += d
    })
    child.on('close', (code) => finish({ out, err, code }))
  })
}

test('step 7: ⌘Q / Ctrl-Q flushes through the SAME function as the ✕', { skip: SKIP }, async () => {
  const { dir, vault } = fixture()
  const child = launch({ CAIRN_QUIT_PROBE: '1', CAIRN_VAULT: vault, CAIRN_STATE_DIR: dir })
  const { out, code } = await watch(child)

  const line = out.split('\n').find((l) => l.startsWith('QUIT_CLOSED '))
  assert.ok(line, `no QUIT_CLOSED line -- app.quit() never came back\n${out}`)
  const r = JSON.parse(line.slice('QUIT_CLOSED '.length))

  /* `viaHandshake` is reported from `AppCtx::quit`, so it can only be true if
     the whole path ran: app.quit() -> before-quit -> win.on('close') ->
     app::begin_close -> nc://flush-and-close -> the REAL frontend's
     flushAndClose() -> confirm_close(true) -> flush_prefs -> quit.
     A quit that bypassed §1.6 would exit(1) with `false`. */
  assert.equal(r.viaHandshake, true, 'app.quit() did not route through app::begin_close')
  assert.equal(code, 0, 'the app did not exit cleanly')

  // §7.6 landed on the way out -- the same guarantee `close-handshake.test.mjs`
  // proves in isolation, here through the real shell and the real frontend.
  assert.ok(existsSync(join(dir, 'state.json')), 'state.json was not flushed by the quit')
})

/* §7.5: the vault open at quit is the vault a normal launch reopens. The Electron
 * shell never called `spawn_startup_open`, so every launch from the app grid came
 * up with no vault. The relaunch passes NO `CAIRN_VAULT`, exactly like a user. */
test('§7.5: a relaunch with no CAIRN_VAULT reopens the vault that was open at quit', { skip: SKIP }, async () => {
  const { dir, vault } = fixture()
  const first = await watch(launch({ CAIRN_QUIT_PROBE: '1', CAIRN_VAULT: vault, CAIRN_STATE_DIR: dir }))
  assert.ok(first.out.includes('QUIT_CLOSED '), `the first session did not quit through §1.6\n${first.out}`)
  const root = realpathSync(vault)
  const saved = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
  assert.equal(saved.vault, root, 'the quit did not record the open vault in state.json')

  const child = launch({ CAIRN_STATE_DIR: dir, CAIRN_DIAG: '1', CAIRN_BOOT_PROBE: '1' })
  try {
    // BOOT_CONSOLE is printed right after BOOT_PROBE, so waiting for it means the probe line is complete.
    const { out } = await watch(child, { waitFor: 'BOOT_CONSOLE ' })
    const emitted = out.split('\n').find((l) => l.startsWith('[event] nc://vault-opened '))
    assert.ok(emitted, `the relaunch never opened a vault\n${out.slice(0, 3000)}`)
    const info = JSON.parse(emitted.slice('[event] nc://vault-opened '.length))
    assert.equal(info.root, root, 'the relaunch opened a different vault than the one recorded')

    const line = out.split('\n').find((l) => l.startsWith('BOOT_PROBE '))
    assert.ok(line, `no BOOT_PROBE line\n${out.slice(0, 3000)}`)
    assert.equal(JSON.parse(line.slice('BOOT_PROBE '.length)).vaultName, 'vault', 'the page did not show the reopened vault')
  } finally {
    stop(child)
  }
})

test('step 7: a SECOND instance hands over and never opens a window', { skip: SKIP }, async () => {
  const { dir, vault } = fixture()

  // The holder. `CAIRN_DIAG` makes it announce `frontend-ready`, which is the
  // one moment it is certainly up -- a fixed sleep would be a flake generator.
  const first = launch({ CAIRN_VAULT: vault, CAIRN_STATE_DIR: dir, CAIRN_DIAG: '1' })
  const ready = watch(first, { waitFor: 'frontend-ready' })
  try {
    await ready

    /* THE SAME `CAIRN_STATE_DIR`, WHICH IS THE SAME `userData`, WHICH IS THE
       SAME LOCK. Two Cairns on one vault means two watchers, two arenas and --
       the part that loses data -- two writers of one `state.json`, which §7.6
       has no multi-writer story for. */
    const second = launch({ CAIRN_VAULT: vault, CAIRN_STATE_DIR: dir })
    const r = await watch(second, { timeoutMs: 20_000 })

    assert.match(
      r.out,
      /another instance already holds the lock/,
      'the second instance did not recognise the first'
    )
    assert.equal(r.code, 0, 'handing over is a success, not a failure')
  } finally {
    stop(first)
  }
})

/* §7.5 made the no-CAIRN_VAULT launch call `startupOpen`, so a second click in the app grid
 * must not get as far as whenReady: a second walk, watcher and state.json writer is the
 * hazard the lock exists for. */
test('step 7: the SECOND instance does no startup work, even with a last vault recorded', { skip: SKIP }, async () => {
  const { dir, vault } = fixture()
  const root = realpathSync(vault)
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ v: 1, vault: root, recents: [root], vaults: {} }))

  const first = launch({ CAIRN_STATE_DIR: dir, CAIRN_DIAG: '1' })
  const ready = watch(first, { waitFor: 'frontend-ready' })
  try {
    await ready
    const second = launch({ CAIRN_STATE_DIR: dir, CAIRN_DIAG: '1' })
    const r = await watch(second, { timeoutMs: 20_000 })

    assert.match(r.out, /another instance already holds the lock/, 'the second instance did not recognise the first')
    assert.equal(r.code, 0, 'handing over is a success, not a failure')
    assert.doesNotMatch(r.out, /nc:\/\/vault-opened/, 'the losing instance opened the vault anyway')
    assert.doesNotMatch(r.out, /frontend-ready/, 'the losing instance loaded a page')
  } finally {
    stop(first)
  }
})

test('step 7: two HERMETIC runs do not collide — the lock is per userData', { skip: SKIP }, async () => {
  /* THIS IS WHY THE LOCK IS SAFE TO ADD. Without per-run `userData`, every test
     in this repo that launches Electron would start failing depending on
     whether the user happened to have Cairn open -- the worst kind of flake,
     and one that would look like a product bug. `app.setPath('userData', …)`
     under CAIRN_STATE_DIR is what makes a harness run its own instance. */
  const a = fixture()
  const b = fixture()
  const one = launch({ CAIRN_VAULT: a.vault, CAIRN_STATE_DIR: a.dir, CAIRN_DIAG: '1' })
  const two = launch({ CAIRN_VAULT: b.vault, CAIRN_STATE_DIR: b.dir, CAIRN_DIAG: '1' })
  try {
    const [r1, r2] = await Promise.all([
      watch(one, { waitFor: 'frontend-ready' }),
      watch(two, { waitFor: 'frontend-ready' }),
    ])
    for (const [name, r] of [['first', r1], ['second', r2]]) {
      assert.doesNotMatch(
        r.out,
        /another instance already holds the lock/,
        `the ${name} hermetic run was refused the lock`
      )
      assert.match(r.out, /frontend-ready/, `the ${name} hermetic run never booted`)
    }
  } finally {
    stop(one)
    stop(two)
  }
})

/* THE WINDOW OPENS MAXIMIZED — a user ruling, 2026-09-10: "I don't want to
 * manually click the Maximize button."
 *
 * The one test in this file that must NOT be headless.  `win.maximize()` on an
 * offscreen window asks nothing of a window manager, so a `CAIRN_HEADLESS=1`
 * run would assert against a value nobody computed; this launches a real,
 * mapped, visible window for about two seconds.  CLAUDE.md §3's etiquette
 * ruling was lifted on 2026-09-08 and this is exactly the case it covers.
 *
 * `bounds` is reported alongside `maximized` because they can disagree: a WM
 * that refuses the request leaves `isMaximized()` false with the asked-for
 * size, and a WM that honours it leaves a window the size of the work area.
 * Asserting both means neither a lying flag nor a silently ignored call
 * passes. */
test('the window opens MAXIMIZED, not at the default 1000x700', { skip: SKIP }, async () => {
  const { dir, vault } = fixture()
  const child = launch({
    CAIRN_HEADLESS: '',
    CAIRN_WINDOW_PROBE: '1',
    CAIRN_VAULT: vault,
    CAIRN_STATE_DIR: dir,
  })
  const { out } = await watch(child)
  const line = out.split('\n').find((l) => l.startsWith('WINDOW_PROBE '))
  assert.ok(line, `no WINDOW_PROBE line\n${out}`)
  const p = JSON.parse(line.slice('WINDOW_PROBE '.length))

  assert.equal(p.maximized, true, 'the window did not come up maximized')
  assert.deepEqual(p.asked, { width: 1000, height: 700 },
    'the DEFAULT size moved; this test is only meaningful while maximizing changes it')
  // ...and it is really that big, not merely flagged. The work area is the
  // ceiling, so a maximized window reaches most of it in both axes.
  assert.ok(p.bounds.width >= p.workArea.width - 8 && p.bounds.width > 1000,
    `width ${p.bounds.width} against a ${p.workArea.width} work area — the WM ignored maximize()`)
  assert.ok(p.bounds.height > 700,
    `height ${p.bounds.height} is still the unmaximized default`)
})

/* §0.26.2 — THE TAB'S TOP EDGE MUST NOT DEPEND ON THE STRIP'S HEIGHT.
 *
 * The user reported the tab label as *"half a pixel misaligned"* against
 * Obsidian on 2026-09-11, and half of it was this: `.tab` was `height: 33px`
 * against `.tab-strip { align-items: flex-end }`, i.e. anchored from the
 * BOTTOM. That is exact only while the strip's content box is an integer, and
 * it is not at a fractional scale — Chromium snaps `.titlebar`'s 1px
 * `border-bottom` to 0.8 CSS px at dpr 1.25, so the strip measures 39.2 and the
 * tab started at 7.2 instead of 7. Obsidian lays its tab out from the top and
 * never sees it.
 *
 * `--force-device-scale-factor=1.25` is what makes this test mean something
 * anywhere: at dpr 1 and 2 the border is exactly 1px and the OLD code passes
 * too, so on the macOS box (dpr 2) this would be green against the defect.
 * HEADLESS on purpose — this is layout, which is exact offscreen, and it needs
 * no window manager. */
test('§0.26.2: the tab starts at --tab-top exactly, at a FRACTIONAL scale', { skip: SKIP }, async () => {
  const { dir, vault } = fixture()
  const child = launch(
    { CAIRN_HEADLESS: '1', CAIRN_WINDOW_PROBE: '1', CAIRN_VAULT: vault, CAIRN_STATE_DIR: dir },
    { args: ['--force-device-scale-factor=1.25'] }
  )
  const { out } = await watch(child)
  const line = out.split('\n').find((l) => l.startsWith('WINDOW_PROBE '))
  assert.ok(line, `no WINDOW_PROBE line\n${out}`)
  const p = JSON.parse(line.slice('WINDOW_PROBE '.length)).page
  assert.ok(p && !p.error, `the page probe failed: ${p && p.error}`)

  assert.equal(p.dpr, 1.25, '--force-device-scale-factor did not take; this test proves nothing at dpr 1')
  assert.equal(p.tabHidden, false, '§7.4 hid the tab, so every box below is a display:none zero')
  // The premise: at this scale the strip is NOT an integer high. If Chromium
  // ever stops snapping the border, this row says so instead of the test
  // quietly becoming a tautology.
  assert.equal(p.strip.h, 39.2,
    `the strip is ${p.strip.h}, not 39.2 — the 1px border is no longer snapping and this test's premise is gone`)

  const want = Number.parseFloat(p.tabTopToken)
  assert.equal(want, 7, '--tab-top moved; update this test with the reason')
  assert.equal(p.tab.top, want,
    `the tab starts at ${p.tab.top}, not --tab-top ${want}. It is anchored from the BOTTOM again, ` +
    'so its top is a function of how Chromium snapped the strip\'s 1px border — and at dpr 1.25 ' +
    'that lands the label one whole device row below Obsidian\'s (CONTRACT §0.26.2)')
  assert.equal(p.tabAlignSelf, 'stretch', 'the tab no longer derives its height from the strip')
  // The other half of the same half-pixel: Obsidian's label inherits
  // `--line-height-tight` (1.3) and computes 16.9px at 13px. Cairn's `--lh-ui`
  // is 1, so without the explicit declaration the box is a flat 13.
  assert.equal(p.labelLineHeight, '16.9px',
    'the tab label lost Obsidian\'s 1.3 line-height (app.css:2401). Neither this nor the tab\'s ' +
    'top edge moves the glyphs alone — both are needed to land on Obsidian\'s device rows')
})

/* THE OTHER HALF, AND IT IS THE ONE THAT PROTECTS A GATE. G9 asserts
 * `inner=1920x964`; a maximized gate window measures the display instead and
 * every geometry row fails for a reason that has nothing to do with the layout.
 *
 * Asserted through the GATE'S OWN REPORT rather than through a window probe,
 * for the reason the sidebar test two below gives: under `--pixeltest` the
 * shell prints that report and exits on it, so nothing else gets a turn — and
 * `inner` is the exact field a maximized window would break, which makes the
 * report the better instrument anyway.
 *
 * WHAT THIS DOES AND DOES NOT PROVE, measured 2026-09-10: deleting
 * `!PIXELTEST` from `startMaximized` leaves this GREEN on this WM, because the
 * `--pixeltest` branch also sets `resizable: false` and a non-resizable window
 * is refused a maximize. So the guard is belt to that braces HERE and this row
 * does not exercise it. It pins the property that actually matters — the gate
 * window is the size it asked for — which is what breaks if either protection
 * is removed on a WM that does honour the request. */
test('a --pixeltest run is NEVER maximized', { skip: SKIP }, async () => {
  const { dir, vault } = fixture()
  mkdirSync(join(vault, 'Projects'), { recursive: true })
  writeFileSync(join(vault, 'Projects', 'guide.md'), 'Body line one, deliberately not a heading.\n')
  const child = launch({
    // A REAL window: an offscreen one is never maximized whatever the code says,
    // so a headless run could not fail this.
    CAIRN_HEADLESS: '',
    CAIRN_VAULT: vault,
    CAIRN_STATE_DIR: dir,
    CAIRN_PIXELTEST: '1',
    CAIRN_PIXELTEST_GATE: '0',
    CAIRN_ELECTRON_GEOM: '1000x700',
    CAIRN_PIXELTEST_EXPANDED: 'Projects',
    CAIRN_PIXELTEST_NOTE: 'Projects/guide.md',
  })
  const { out } = await watch(child)
  const json = out.split('\n').filter((l) => l.startsWith('{')).pop()
  assert.ok(json, `the probe printed no report\n${out}`)
  assert.equal(JSON.parse(json).inner, '1000x700',
    'the gate window is not the size it asked for — maximize() reached a --pixeltest run, ' +
    'and every G9 geometry row taken on it is void')
})

test('§0.7 E9: a persisted sidebar width REACHES THE PAGE', { skip: SKIP }, async () => {
  /* THIS WAS DEAD FOR THE WHOLE LIFE OF THIS SHELL and no test noticed, because
     the one that pinned it (`tests/frontend/window-controls.test.mjs`) was
     grepping `core/src/lib.rs` — the Tauri source — while the app ran on
     `app-main.mjs`. It surfaced only when step 10 deleted the file the test was
     reading. The wiring is asserted there; this EXECUTES it, because a grep of
     the wrong file is exactly what let it rot. */
  const { dir, vault } = fixture()
  writeFileSync(
    join(dir, 'state.json'),
    JSON.stringify({ v: 1, vault, recents: [vault], sidebar_w: 333.0, vaults: {} })
  )
  const child = launch({ CAIRN_BOOT_PROBE: '1', CAIRN_VAULT: vault, CAIRN_STATE_DIR: dir })
  const { out } = await watch(child)
  const line = out.split('\n').find((l) => l.startsWith('BOOT_PROBE '))
  assert.ok(line, `no BOOT_PROBE line\n${out}`)
  const p = JSON.parse(line.slice('BOOT_PROBE '.length))

  assert.equal(p.sidebarWGlobal, 333, 'the preload never published the persisted width')
  assert.equal(p.sidebarW, '333px', 'the page did not apply it to --sidebar-w')
})

test('§0.7 E9/G9: a --pixeltest run can NEVER see a persisted width', { skip: SKIP }, async () => {
  /* THE HALF THAT PROTECTS A GATE. Every x G9 asserts — sidebar 412, editor
     412, scroller 409, gutter 401, tab 430 — is a function of `--sidebar-w`. A
     width dragged yesterday reaching a gate run would report those as failures
     that mean nothing about the code.

     ASSERTED THROUGH THE GATE'S OWN REPORT, not through the boot probe: under
     `--pixeltest` the shell prints the geometry report and exits on it, so the
     boot probe never runs. That is the better instrument anyway — the report
     names the row and the number, so a leaked width shows up as the exact
     failure a real gate run would show. */
  const { dir, vault } = fixture()
  mkdirSync(join(vault, 'Projects'), { recursive: true })
  writeFileSync(join(vault, 'Projects', 'guide.md'), 'Body line one, deliberately not a heading.\n')
  writeFileSync(
    join(dir, 'state.json'),
    JSON.stringify({ v: 1, vault, recents: [vault], sidebar_w: 333.0, vaults: {} })
  )
  const child = launch({
    CAIRN_VAULT: vault,
    CAIRN_STATE_DIR: dir,
    CAIRN_PIXELTEST: '1',
    CAIRN_PIXELTEST_GATE: '0',
    CAIRN_ELECTRON_GEOM: '1000x700',
    CAIRN_PIXELTEST_EXPANDED: 'Projects',
    CAIRN_PIXELTEST_NOTE: 'Projects/guide.md',
  })
  const { out } = await watch(child)
  const json = out.split('\n').filter((l) => l.startsWith('{')).pop()
  assert.ok(json, `the probe printed no report\n${out}`)
  const report = JSON.parse(json)

  const sidebar = report.results.filter(
    (r) => r.row === 'sidebar' && r.status !== 'SKIP' && typeof r.expect === 'number'
  )
  assert.ok(sidebar.length > 0, 'the report carries no sidebar rows to check')
  for (const r of sidebar) {
    assert.notEqual(r.status, 'FAIL', `${r.check}: expect ${r.expect} got ${r.got} — a persisted width leaked into the gate`)
  }
  // And say it positively: the width the gate measured is the deterministic
  // one, not the 333 sitting in the state file it was pointed at.
  const w = sidebar.find((r) => r.check === 'width')
  if (w) assert.equal(w.got, 412, 'the gate did not measure the deterministic 412')
})
