/**
 * electron-shell/menu.test.mjs -- the vault popover in a REAL engine.
 *
 * Two rulings, both from user reports on 2026-09-11, and three tests because
 * one of the three depends on a window manager and the other two do not.
 *
 * §0.28 E68 -- WHAT DISMISSES A MENU.
 *   "Obsidian persists this menu even when I alt+tab. It only disappears when I
 *    click away or click on an item inside that menu!"
 *   Obsidian's `Menu.onload` registers `mousedown`, `click` and (desktop)
 *   `contextmenu`, plus Escape in the keymap scope it pushes. No `blur`, no
 *   `resize`, no `scroll`. Cairn had all three.
 *
 * §0.29 E69 -- WHERE A MENU IS PLACED.
 *   "The left bottom corner of the dialog is always the place I place my cursor."
 *   Obsidian's vault switcher is `Menu.forEvent(clickEvent)` ->
 *   `showAtMouseEvent` -> `showAtPosition({x: clientX, y: clientY})`, and that
 *   function lifts a menu which would overflow the bottom by its own height --
 *   so the BOTTOM-left corner lands at (x + 2, y + 2). Cairn anchored to the
 *   BAR instead, so the popover ignored the pointer entirely.
 *
 * WHY THE FOCUS LEG IS ITS OWN TEST. `win.blur()` is a no-op on Wayland -- a
 * client cannot hand its own focus away -- so the probe shows the compositor a
 * second window and lets it take focus, which is what Alt-Tab does. A
 * compositor that declines leaves that leg PROVING NOTHING, and a leg that
 * proved nothing must say so rather than pass: it is reported as a skip with a
 * reason, which is `CLAUDE.md` §3's rule for a measurement the environment
 * invalidated. The synthetic leg next to it can never be vacuous, and it is the
 * one that guards the regression.
 *
 * Both were verified to FAIL against the defect: re-adding
 * `window.addEventListener('blur', closeMenu)` reports
 * `afterRealBlur:false, afterSyntheticBlur:false`.
 *
 * Run: node --test electron-shell/menu.test.mjs
 * (needs a display connection and `electron-shell/cairn.node`)
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'cairn-menu-'))
  const vault = join(dir, 'vault')
  mkdirSync(vault, { recursive: true })
  writeFileSync(join(vault, 'Note.md'), '# Note\n\nbody\n')
  // §0.30 E70 — A SECOND VAULT, ALREADY IN `recents` AND NOT OPEN, because the
  // `Close` button is drawn on exactly those rows. Seeded into `state.json`
  // rather than opened: opening it would make it the current vault and this
  // harness runs one process.
  const other = join(dir, 'other')
  mkdirSync(other, { recursive: true })
  mkdirSync(join(dir, 'state'), { recursive: true })
  writeFileSync(join(dir, 'state', 'state.json'),
    JSON.stringify({ v: 1, recents: [other], vaults: {} }))
  return { dir, vault, other }
}

/** Detached, so the whole Electron process group can be reaped -- see
 *  `lifecycle.test.mjs` for why a plain kill hangs `node --test`. */
function launch(env, args = []) {
  return spawn(BIN, [APP, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
}

function watch(child, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    let out = ''
    let err = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ }
      reject(new Error(`timed out after ${timeoutMs} ms\nSTDOUT:\n${out}\nSTDERR:\n${err}`))
    }, timeoutMs)
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('close', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ out, err })
    })
  })
}

async function probe(env, args = []) {
  const { dir, vault } = fixture()
  try {
    const child = launch(
      { CAIRN_MENU_PROBE: '1', CAIRN_VAULT: vault, CAIRN_STATE_DIR: join(dir, 'state'), ...env },
      args,
    )
    const { out, err } = await watch(child)
    const line = out.split('\n').find((l) => l.startsWith('MENU_PROBE '))
    assert.ok(line, `no MENU_PROBE line\nSTDOUT:\n${out}\nSTDERR:\n${err}`)
    const p = JSON.parse(line.slice('MENU_PROBE '.length))
    assert.equal(p.error, undefined, `probe failed: ${p.error}`)
    return p
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
}

/* HEADLESS and at dpr 1, on purpose: this is LAYOUT, which is exact offscreen
 * and needs no window manager, and forcing the scale keeps the numbers whole.
 * At the desktop's 1.25 the same run reports a bottom of 1047.2 against a
 * pointer at 1045 -- Chromium snapping the menu's 1px border to 0.8 -- which is
 * correct and would need the loose device-grid rule to assert. */
let placed = null
test('§0.29 E69: the popover\'s BOTTOM-LEFT corner lands on the pointer', { skip: SKIP }, async () => {
  const p = await probe(
    { CAIRN_HEADLESS: '1', CAIRN_ELECTRON_GEOM: '1000x700' },
    ['--force-device-scale-factor=1']
  )
  placed = p
  const q = p.placed
  assert.ok(q && typeof q === 'object', `the probe did not place a menu: ${JSON.stringify(q)}`)
  assert.equal(q.rows, 3, 'the vault popover did not open with its three rows')

  // The gesture has to be one that could NOT have worked by accident: the
  // pointer is 20px right and 8px down from the bar's own top-left, so a
  // popover still anchored to the bar would miss by exactly that.
  assert.equal(q.menu.left, q.at.x + 2,
    `left ${q.menu.left} is not pointer ${q.at.x} + 2 -- the menu is not placed at the cursor`)

  // EXACT, against the number the code actually computes with. `placeMenu` is
  // handed `offsetHeight`, which Chromium ROUNDS to an integer, so `top` is
  // exact and the rect's `bottom` is not: this desktop renders at dpr 1.25
  // whatever `--force-device-scale-factor` asks for (§0.19.1 -- the switch is a
  // client hint a Wayland compositor overrides through `wp_fractional_scale`),
  // and a 1px border measures 0.8 there. Obsidian measures with `offsetHeight`
  // too, so this is transcription and not tolerance.
  assert.equal(q.menu.top, q.at.y + 2 - q.offset.h,
    `top ${q.menu.top} is not pointer ${q.at.y} + 2 - height ${q.offset.h} -- the lift did not fire`)
  // …and the visible claim, on the device grid (§0.19 E27).
  const eps = 1 / q.dpr
  assert.ok(Math.abs(q.menu.bottom - (q.at.y + 2)) <= eps,
    `bottom ${q.menu.bottom} is more than one device pixel from pointer ${q.at.y} + 2`)

  // …and it really was the LIFT that put it there, not room below: the popover
  // must actually be taller than the space under the pointer, or this test
  // would pass on a menu that simply opened downward.
  assert.ok(q.at.y + q.offset.h > q.viewport.h,
    'there was room below the pointer, so the bottom-left rule was never exercised')
})

test('§0.30 E70: `Close` is hover-revealed and costs the popover NO width', { skip: SKIP }, async () => {
  const p = placed ?? await probe({ CAIRN_HEADLESS: '1', CAIRN_ELECTRON_GEOM: '1000x700' })
  const b = p.closeBtn
  assert.ok(b && typeof b === 'object', `the probe found no menu: ${JSON.stringify(b)}`)

  // ONE button, on the ONE row that is a vault and is not the open one. The
  // fixture seeds a second vault into `recents` for exactly this; without it
  // the popover has only the open vault and this test would be vacuous.
  assert.equal(b.rows, 3, 'the fixture no longer produces a non-active vault row')
  assert.equal(b.btns, 1)
  assert.equal(b.onOpenRow, false,
    'the OPEN vault offers a Close that command 21 would refuse (§9 E4: omitted, not disabled)')

  // HOVER-REVEALED. `display: none` at rest and `flex` on the row's is-active —
  // which is the SAME state as hover in this menu, by the rule in chrome.css.
  assert.equal(b.hidden, 'none', 'the Close button is visible on an untouched row')
  assert.equal(b.shown, 'flex', 'the Close button never appears')

  // …AND IT COSTS THE RESTING MENU NOTHING. This is the assertion the whole
  // absolute-positioning decision exists for: §0.27 E67 pinned this popover's
  // box to Obsidian's to three decimals, and a hidden-but-in-flow button would
  // have widened it by 16 + 8 and undone that silently.
  assert.equal(b.widthAtRest, b.widthWhenShown,
    'the Close button is in flow — every menu that has one is now wider than Obsidian\'s')

  // 16px at the row's own 8px padding edge, like every other glyph in the menu.
  assert.deepEqual(b.size, [16, 16])
  assert.equal(b.rightInset, 8)
})

test('§0.28 E68: a blur, resize or scroll IN THE PAGE does not close the popover',
  { skip: SKIP }, async () => {
    const p = placed ?? await probe({ CAIRN_HEADLESS: '1', CAIRN_ELECTRON_GEOM: '1000x700' })
    // Dispatched events, so this leg runs the listeners whatever the window
    // manager did. It cannot go vacuous, and it is the regression guard.
    assert.equal(p.afterSyntheticBlur, true,
      'a blur/resize/scroll event in the page closed the menu; a listener is back')
    // The set is still CLOSED, not merely emptied: clicking away dismisses.
    assert.equal(p.afterOutsideClick, false, 'an outside click left the menu mounted')
  })

test('§0.28 E68: the popover survives the window really losing focus',
  { skip: SKIP }, async (t) => {
    const p = await probe({ CAIRN_HEADLESS: '', CAIRN_ELECTRON_GEOM: '1000x700' })
    assert.equal(p.opened, 3, 'the vault popover did not open with its three rows')
    if (p.focusedBefore !== true || p.focusedAfter !== false) {
      // NOT TAKEN, and it says so. `win.blur()` is a no-op on Wayland and the
      // probe's focus thief depends on a compositor willing to move focus; a
      // run where it did not is a run where this question was never asked.
      t.skip(`the compositor did not move focus (before=${p.focusedBefore}, ` +
             `after=${p.focusedAfter}); the real-blur leg was NOT TAKEN`)
      return
    }
    assert.equal(p.afterRealBlur, true,
      'the menu closed when the window lost focus -- Alt-Tab still eats the popover')
  })
