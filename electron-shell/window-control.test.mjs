/**
 * electron-shell/window-control.test.mjs -- §0.5 E7's three window controls,
 * on the Electron shell, end to end.
 *
 * ===========================================================================
 * WHY THIS IS A CHILD PROCESS AND NOT A UNIT TEST
 * ===========================================================================
 * The bug this guards against was NOT a wrong function. Every function
 * involved was already correct: `chrome.ts:547-549` wired the buttons,
 * `ipc.ts:421` emitted the action, `wheel.ts`-style globals had readers ready.
 * What was missing was a SEAM -- Tauri's `initialization_script` and its
 * `window-control` listener had no counterpart in `electron-shell/`, so
 * `__CAIRN_OS__` was never defined, `.window-controls` stayed `display: none`,
 * and the emits fell into a handler that answered `frontend-ready` and nothing
 * else. A unit test on either end would have PASSED throughout.
 *
 * So the only test that can fail for the right reason is one that crosses
 * every link: a real click on the real button, through `chrome.ts`'s own
 * listener, through contextBridge, through `cairn:emit`, into
 * `handleWindowControl`, out to a real `BrowserWindow`, and back as
 * `nc://window-state` to a renderer subscriber. That needs a real Electron
 * process, so this spawns one and reads its stdout.
 *
 * ===========================================================================
 * THE ASSERTION THAT IS DOING THE REAL WORK, AND THE ONE THAT WAS WRONG FIRST
 * ===========================================================================
 * NO TWO CONSECUTIVE PAYLOADS MAY BE EQUAL. That is exactly the invariant
 * `app-main.mjs`'s `lastMaximized` provides, and nothing else in the app would
 * notice if it were deleted -- the glyph looks identical either way and every
 * individual payload is correct.
 *
 * This started life as `deepEqual(states, [true, false])` -- two events for
 * two clicks -- and that FAILED, for a reason worth recording. The raw stream
 * for one `maximize()` then one `unmaximize()`, measured on Debian/XWayland
 * 2026-09-07 with no dedupe at all, is:
 *
 *   maximize:true  unmaximize:false  maximize:true  resize:true
 *   unmaximize:false  resize:false
 *
 * A single maximize GENUINELY FLAPS true -> false -> true; the compositor
 * reports unmaximized mid-transition. So four events reach the renderer and
 * all four are honest. The dedupe is still doing its job -- it is what drops
 * `resize:true` and `resize:false` -- but it collapses REPEATS, not the flap,
 * and an assertion that expected two events was asserting a fiction about the
 * WM rather than a property of our code. The consecutive-pair check is the
 * property we actually implement, and it fails the moment the dedupe goes.
 *
 * ===========================================================================
 * REQUIREMENTS
 * ===========================================================================
 * A display connection. The window is `CAIRN_HEADLESS=1` -- offscreen and
 * never shown, so nothing reaches the screen and CLAUDE.md §3 is satisfied --
 * but Electron still needs to talk to a compositor to have a window at all.
 * Skipped, not failed, where there is none: a missing display is an absent
 * environment, not a broken seam.
 */

import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { NO_DISPLAY } from './have-display.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)

/** The same binary `verify-electron-pin.mjs:41-53` gates, resolved the same way. */
function electronBinary() {
  const dist = join(ROOT, 'node_modules', 'electron', 'dist')
  if (process.platform === 'darwin') {
    return join(dist, 'Electron.app', 'Contents', 'MacOS', 'Electron')
  }
  return join(dist, 'electron')
}

const BIN = electronBinary()
const SKIP = !existsSync(BIN)
  ? `electron not installed at ${BIN} -- run npm install`
  : !existsSync(join(HERE, 'app', 'index.html'))
    ? 'electron-shell/app not built -- run node electron-shell/build-app.mjs'
    : NO_DISPLAY

/** Runs the probe once and returns its two reported lines, parsed. */
function runProbe() {
  const stateDir = mkdtempSync(join(tmpdir(), 'cairn-winctl-'))
  const inner = new Promise((resolve, reject) => {
    const child = spawn(BIN, [join(HERE, 'app-main.mjs')], {
      cwd: ROOT,
      env: {
        ...process.env,
        CAIRN_HEADLESS: '1',
        CAIRN_WINCTL_PROBE: '1',
        /* HERMETIC, since §8.2 step 5 put `prefs.rs` in this process.
           `app-main.mjs` now hands the addon a REAL `state.json` -- the same
           `~/.config/com.cairn.app/state.json` the Tauri build writes -- and a
           test that boots the app must not be able to rewrite the vault,
           recents or window geometry of the person running it. That is
           spike-M D1's exact failure mode: configuration arriving from ambient
           state nobody in the run declared. */
        CAIRN_STATE_DIR: stateDir,
        // Not inherited: they would change what the probe is looking at.
        CAIRN_ELECTRON_GEOM: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })

    const kill = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('probe timed out after 60s\nstdout:\n' + out + '\nstderr:\n' + err))
    }, 60_000)

    child.on('error', (e) => { clearTimeout(kill); reject(e) })
    child.on('exit', () => {
      clearTimeout(kill)
      const pick = (tag) => {
        const line = out.split('\n').find((l) => l.startsWith(tag + ' '))
        return line ? JSON.parse(line.slice(tag.length + 1)) : null
      }
      const probe = pick('WINCTL_PROBE')
      if (!probe) {
        reject(new Error('no WINCTL_PROBE line\nstdout:\n' + out + '\nstderr:\n' + err))
        return
      }
      resolve({ probe, closed: pick('WINCTL_CLOSED'), out, err })
    })
  })
  return inner.finally(() => {
    try { rmSync(stateDir, { recursive: true, force: true }) } catch {}
  })
}

let cached = null
const probeOnce = async () => (cached ??= await runProbe())

test('§0.5 E7: the window controls are drawn, and only on Linux', { skip: SKIP }, async () => {
  const { probe } = await probeOnce()
  assert.equal(probe.probeError, undefined, 'renderer probe threw: ' + probe.probeError)

  if (process.platform === 'linux') {
    // The whole point of the `__CAIRN_OS__` injection. Before it, `data-os`
    // was the string "macos" on Debian and the cluster was display:none.
    assert.equal(probe.cairnOs, 'linux', '__CAIRN_OS__ not injected by preload.cjs')
    assert.equal(probe.dataOs, 'linux', 'chrome.ts did not flip data-os')
    assert.equal(probe.controlsVisible, true, '.window-controls present but not visible')
    assert.deepEqual(probe.buttons, [true, true, true], 'a control button is missing')
  } else {
    // The Tauri build's macOS behaviour, preserved: global absent, data-os
    // stands at "macos", cluster hidden. lib.rs:233-237 says the same.
    assert.equal(probe.cairnOs, null, '__CAIRN_OS__ must not be set off Linux')
    assert.equal(probe.dataOs, 'macos')
    assert.equal(probe.controlsVisible, false)
  }
})

test('§0.5 E7: a real click on ⬜ toggles the real window', { skip: SKIP }, async () => {
  const { probe } = await probeOnce()
  assert.equal(probe.maxBefore, false, 'window started maximized; probe cannot read a toggle')
  assert.equal(probe.maxAfter, true, 'first click did not maximize the BrowserWindow')
  assert.equal(probe.maxBack, false, 'second click did not restore it')
})

test('§0.5 E7: nc://window-state reaches the renderer, deduped', { skip: SKIP }, async () => {
  const { probe } = await probeOnce()
  assert.ok(Array.isArray(probe.states), 'no states array')
  const seq = probe.states.map((s) => s.maximized)

  // It reached the renderer at all, and every payload is a real boolean.
  assert.ok(seq.length >= 2, 'expected at least one event per click; got ' + JSON.stringify(seq))
  assert.ok(seq.every((v) => typeof v === 'boolean'), 'a payload was not a boolean: ' + JSON.stringify(seq))

  // THE DEDUPE INVARIANT. See the header: the raw stream carries `maximize:true`
  // immediately followed by `resize:true`, so a consecutive duplicate is
  // exactly what appears the moment `lastMaximized` is removed.
  const dupeAt = seq.findIndex((v, i) => i > 0 && v === seq[i - 1])
  assert.equal(dupeAt, -1, 'consecutive duplicate at index ' + dupeAt + ': ' + JSON.stringify(seq))

  // The last thing the renderer was told must be the truth, because the
  // payload carries STATE and not a transition -- that is the property that
  // lets a dropped event self-heal.
  assert.equal(seq.at(-1), false, 'final published state disagrees with the restored window')

  // The glyph followed the window, which is what the event is for.
  assert.equal(probe.iconAfter, 'win-maximize', 'maximize glyph did not follow the state back')
})

test('§0.5 E7: an unknown action is ignored, never defaulted', { skip: SKIP }, async () => {
  const { probe } = await probeOnce()
  // lib.rs:348-350: guessing `close` on drift is unthinkable. The window must
  // still exist, and must not have silently toggled either.
  assert.equal(probe.unknownActionSurvived, true, "'frobnicate' destroyed the window")
  assert.equal(probe.maxAfterUnknown, false, "'frobnicate' changed the maximize state")
})

test('§0.5 E7: the ✕ closes the window THROUGH the §1.6 handshake', { skip: SKIP }, async () => {
  const { closed } = await probeOnce()
  assert.ok(closed, 'no WINCTL_CLOSED line -- the close arm never reported')

  /* THIS ASSERTION GOT STRONGER AT §8.2 STEP 7, and it closed the last sliver
     of data-loss gap G-b. It used to read `closed.destroyed === true`: a window
     object went away. That was all it could read, because the handshake was
     skipped under CAIRN_HEADLESS so this probe could isolate the click.

     `viaHandshake` is reported from the QUIT CALLBACK, so it means the whole
     path ran: ✕ -> win.close() -> app::begin_close -> nc://flush-and-close ->
     the REAL frontend's flushAndClose() -> confirm_close(true) -> flush_prefs
     -> AppCtx::quit -> app.exit(0). A window destroyed by any other route
     reports `false` and fails here, which is exactly the `destroy()` regression
     lib.rs warns about and dl_03/dl_04/dl_28 exist to prevent. */
  assert.equal(
    closed.viaHandshake,
    true,
    'the ✕ did not reach app::begin_close -- it closed the window some other way'
  )
})

test('the wheel seam is GONE, not merely switched off', { skip: SKIP }, () => {
  /* `src/wheel.ts` reproduced CHROMIUM's wheel glide on WebKit, and on this
     shell it was a main-thread JS clone of an animation the compositor already
     runs -- which it SUPPRESSED, by calling preventDefault() on a non-passive
     listener (spike P §5). The preload used to withhold it with
     `__CAIRN_WHEEL__ = false`.

     §8.2 step 10 deleted the module with the engine it was written for, so the
     assertion inverts: the seam must stay gone. It is worth keeping because the
     failure it guards is INVISIBLE -- a re-added JS glide reports a perfect
     120 Hz while the scroll stutters, since the probe measures cadence and is
     structurally blind to distance-per-frame. */
  const src = readFileSync(join(HERE, 'preload.cjs'), 'utf8')
  assert.doesNotMatch(src, /__CAIRN_WHEEL__/, 'the wheel seam is back in the preload')
  assert.ok(
    !existsSync(join(ROOT, 'src', 'wheel.ts')),
    'src/wheel.ts is back; on Chromium it fights the compositor (spike P §5)'
  )
})
