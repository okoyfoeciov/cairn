/**
 * electron-shell/tree-ring.test.mjs — the tree's cursor ring and its overflow
 * inset, in the real engine, through the engine's real input pipeline.
 * Two user reports, 2026-09-15.
 *
 * ===========================================================================
 * (1) "Did you see the gray line in the first note? That was the first click."
 * ===========================================================================
 * The ring was `.tree-scroller:focus-visible .tr.c`, and CHROMIUM FLIPS A
 * MOUSE-FOCUSED BOX TO `:focus-visible` ON A BARE SHIFT KEYDOWN. A person holds
 * Shift before a shift-click, and a shift-click does not move `.c`, so the ring
 * lit the row they had plain-clicked first. The fix is tree.ts's own
 * `.kbd-focus` flag (Obsidian's `has-focus` lifecycle): armed by keyboard
 * navigation, cleared by a plain click, untouched by Shift and shift-clicks.
 *
 * WHY THIS CANNOT LIVE IN `tests/frontend/tree.test.mjs`. That file already
 * tests the FLAG. It cannot test the DEFECT: the shim has no `:focus-visible`,
 * no computed styles and no input pipeline, and a synthetic `KeyboardEvent`
 * from script never reaches the heuristic that flips `:focus-visible` at all.
 * So the probe drives `webContents.sendInputEvent` — real mouse and key events
 * — and THE TEST FIRST PROVES THE TRAP IS LIVE: after the plain click and the
 * Shift keydown the scroller must match `:focus-visible`. A run where it does
 * not is a run where the old selector would ALSO have drawn nothing, and the
 * ring assertions would pass against the defect; that run FAILS, it does not
 * pass quietly.
 *
 * ===========================================================================
 * (2) "Look at the space between the pink tile and the sidebar!!"
 * ===========================================================================
 * With the tree overflowing, Obsidian's fills end 16px before its scrollbar,
 * because its `.nav-files-container` is `overflow-y: auto` and the bar takes
 * width out of the box the fill is inset from. Cairn's gutter is always
 * reserved, so tree.ts says WHEN (`.is-overflowing`) and chrome.ts says HOW
 * MUCH (`--nav-scrollbar-w`, probed from the engine on macOS). Asserted as the
 * user sees it: the fill's right edge relative to the SIDEBAR's right edge —
 * `12 + that width` inside while overflowing, `12` inside when not — read
 * twice, from layout and from the captured frame, and the two states must
 * differ.
 *
 * ===========================================================================
 * HEADLESS, WITH CDP FOCUS EMULATION — AND WHY THAT IS NOT A STUB
 * ===========================================================================
 * Measured 2026-09-15 on macOS: an offscreen window is never focused, so with
 * `webContents.focus()` alone `document.hasFocus()` is false, the scroller
 * never matches `:focus`, and the trap cannot spring (the probe reported
 * `focusVisible: false` and every ring assertion would have been vacuous).
 * `Emulation.setFocusEmulationEnabled` is the engine's own "treat this page as
 * focused"; the click and the keys are still real input events, and the
 * `:focus-visible` flip the test requires is the engine's, not the probe's.
 *
 * DEBIAN HAS NOT RUN THIS. On Linux chrome.ts writes Obsidian's styled 12px
 * without measuring, so C expects that constant there; and a desktop that
 * overrides `--force-device-scale-factor` renders at a fractional scale, where
 * the pixel legs do not have whole-pixel answers and are reported as not taken
 * (a diagnostic, never a silent pass — the layout legs still run).
 *
 * Requires a display connection; skipped with a reason where there is none.
 */

import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { NO_DISPLAY } from './have-display.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)

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
  : !existsSync(join(HERE, 'cairn.node'))
    ? 'no cairn.node -- run node electron-shell/build-native.mjs'
    : !existsSync(join(HERE, 'app', 'index.html'))
      ? 'electron-shell/app not built -- run node electron-shell/build-app.mjs'
      : NO_DISPLAY

/** Obsidian's `has-focus` ring, app.css:10454: `0 0 0 2px
 *  var(--background-modifier-border-focus)`, #555555 in the dark theme, and
 *  measured live as exactly #555555 in its tree. */
const RING = 'rgb(85, 85, 85) 0px 0px 0px 2px'

/** The fill's inset from the sidebar's right edge when the tree does NOT
 *  overflow: 1px of fill inset + 8px gutter + 3px of scroller-to-sidebar. */
const BASE_INSET = 12

/**
 * 2026-09-15 — a per-channel tolerance for a sampled '#rrggbb' hex string,
 * needed once `--row-h` stopped being a whole number of device pixels
 * (§0.17's `applyRowH`).  A row's top edge can now land a fraction of a
 * device pixel off a whole one, and Chromium anti-aliases whatever the ring's
 * box-shadow paints across that boundary against whatever the row ABOVE
 * painted there — measured up to 10 per channel on this Mac, well short of
 * the ~45 a genuinely wrong colour (the #282828 background) would show.  Not
 * a defect: Obsidian's own row is the SAME fraction of a device pixel tall,
 * so its rows blend the same way at the boundaries where they land the same
 * way — this loosens the INSTRUMENT to the geometry it is now measuring, it
 * does not paper over a colour that is actually wrong.
 */
const NEAR_HEX = (a, b, tol = 15) =>
  [0, 2, 4].every((k) => Math.abs(parseInt(a.slice(k, k + 2), 16) - parseInt(b.slice(k, k + 2), 16)) <= tol)
const assertNearHexMap = (actual, expected, msg) => {
  for (const k of Object.keys(expected)) {
    assert.ok(k in actual && NEAR_HEX(actual[k], expected[k]),
      msg + ' at column ' + k + ': got ' + JSON.stringify(actual) + ', want near ' + JSON.stringify(expected))
  }
}

function runProbe() {
  const work = mkdtempSync(join(tmpdir(), 'cairn-ring-'))
  const vault = join(work, 'vault')
  // `A` holds the four rows the gesture uses. Alphabetical, so the tree is
    // A, Alpha, Beta, Delta, Gamma, Z, … — Alpha is R1, Gamma is R2, ArrowDown
    // from Alpha lands on Beta, and Delta is the "another row" plain click.
    mkdirSync(join(vault, 'A'), { recursive: true })
    for (const n of ['Alpha', 'Beta', 'Gamma', 'Delta']) writeFileSync(join(vault, 'A', n + '.md'), 'x\n')
    // `Z` is what makes the tree overflow: 65 rows x 27 against a ~717px band
    // at 1200x800. A plain click folds it to 5 rows, which does not.
    mkdirSync(join(vault, 'Z'), { recursive: true })
    for (let i = 0; i < 60; i++) {
      writeFileSync(join(vault, 'Z', 'Note ' + String(i).padStart(3, '0') + '.md'), 'x\n')
    }

    // `-AppleShowScrollBars Always` pins CLASSIC scroll bars for this process
    // only (NSArgumentDomain; nothing is written to the user's defaults).
    // Measured 2026-09-15: the same Mac reads 15px with a mouse attached and
    // 0px without one (overlay bars), and at 0px C cannot tell the two insets
    // apart — it refused the run as vacuous, correctly, on a machine with no
    // mouse.  Pinning makes C a test of the mechanism on every Mac.
    const macBars = process.platform === 'darwin' ? ['-AppleShowScrollBars', 'Always'] : []
    const inner = new Promise((resolve, reject) => {
    const child = spawn(BIN, [join(HERE, 'app-main.mjs'), '--force-device-scale-factor=1', ...macBars], {
      cwd: ROOT,
      env: {
        ...process.env,
        CAIRN_HEADLESS: '1',
        CAIRN_TREE_RING_PROBE: '1',
        CAIRN_VAULT: vault,
        // Hermetic (spike-M D1): never the state, recents or lock of the person
        // running it.
        CAIRN_STATE_DIR: join(work, 'state'),
        CAIRN_ELECTRON_GEOM: '1200x800',
        CAIRN_PIXELTEST_EXPANDED: 'A,Z',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Its own process group, so a timeout reaps every Electron helper too.
      detached: true,
    })

    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })

    const kill = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ }
      reject(new Error('tree-ring probe timed out after 90s\nstdout:\n' + out + '\nstderr:\n' + err))
    }, 90_000)

    child.on('error', (e) => { clearTimeout(kill); reject(e) })
    child.on('close', () => {
      clearTimeout(kill)
      const line = out.split('\n').find((l) => l.startsWith('TREE_RING '))
      if (!line) {
        reject(new Error('no TREE_RING line\nstdout:\n' + out + '\nstderr:\n' + err))
        return
      }
      resolve(JSON.parse(line.slice('TREE_RING '.length)))
    })
    })
  return inner.finally(() => {
    try { rmSync(work, { recursive: true, force: true }) } catch {}
  })
}

let cached = null
const probeOnce = async () => (cached ??= await runProbe())

/** Every test starts here: a probe that errored, or a run where the engine's
 *  Shift heuristic never fired, proves nothing about the ring. */
async function liveProbe() {
  const d = await probeOnce()
  assert.equal(d.error, undefined, 'probe error: ' + d.error)
  assert.equal(d.afterPlainClick.focus, true,
    'the plain click did not leave the scroller focused -- nothing below can be about its ring')
  assert.equal(d.afterPlainClick.focusVisible, false,
    'the scroller was :focus-visible straight after a MOUSE click, before any key')
  assert.equal(d.trap.focusVisible, true,
    'VACUOUS RUN: a real Shift keydown did not make the mouse-focused scroller :focus-visible in ' +
    'this engine, so the old `:focus-visible` selector would ALSO draw nothing and the ring ' +
    'assertions could not fail. Refusing to pass.')
  return d
}

test('A: plain click, Shift, shift-click, release -- NO ring on the first row (user report 1)', {
  skip: SKIP,
}, async (t) => {
  const d = await liveProbe()

  // The gesture really was a shift-click: a range, and the cursor left behind.
  assert.deepEqual(d.afterShiftClick.selected, ['Alpha', 'Beta', 'Delta', 'Gamma'],
    'the shift-click did not select Alpha..Gamma, so the gesture under test never happened')

  for (const [label, s] of [
    ['Shift held', d.afterShiftDown],
    ['after the shift-click', d.afterShiftClick],
    ['after Shift is released', d.afterShiftUp],
  ]) {
    const r1 = s.rows.Alpha
    assert.ok(r1 && r1.cls.split(' ').includes('c'),
      label + ': the first row is not the cursor row, which is the whole trap: ' + JSON.stringify(r1))
    assert.equal(r1.beforeShadow, 'none', label + ': the cursor ring is drawn on the first plain-clicked row')
    assert.equal(r1.rowShadow, 'none', label + ': the pre-fix inset ring is back on the row itself')
    assert.equal(s.kbdFocus, false, label + ': the scroller is armed (.kbd-focus) without keyboard navigation')
  }
  // Still :focus-visible at the moment asserted, or the three rows above were free.
  assert.equal(d.afterShiftUp.focusVisible, true, 'the trap closed before the last assertion')

  // THE PIXELS THE USER PHOTOGRAPHED: the ring's columns, and the old inset
  // ring's x = 0, on the cursor row against a row in the same selection.
  if (d.afterShiftUp.dpr === 1) {
    assert.equal(d.pixA.shotOk, true, 'the captured frame could not be read')
    assert.deepEqual(d.pixA.cursorRow, d.pixA.controlRow,
      'the first row paints something at x ' + d.pixA.xs + ' that its neighbour does not: ' +
      JSON.stringify(d.pixA))
  } else {
    t.diagnostic('pixel leg of A NOT TAKEN at dpr ' + d.afterShiftUp.dpr)
  }
})

test('B: ArrowDown arms Obsidian\'s ring; a plain click on another row removes it', {
  skip: SKIP,
}, async (t) => {
  const d = await liveProbe()

  const k = d.afterArrowDown
  assert.deepEqual(k.cursor, ['Beta'], 'ArrowDown from Alpha did not land on Beta')
  assert.equal(k.kbdFocus, true, 'keyboard navigation did not arm .kbd-focus')
  assert.equal(k.rows.Beta.beforeShadow, RING, 'the keyboard cursor row does not carry Obsidian\'s ring')
  for (const n of ['Alpha', 'Delta', 'Gamma']) {
    assert.equal(k.rows[n].beforeShadow, 'none', n + ' carries a ring and is not the cursor')
  }

  const c = d.afterPlainClick2
  assert.deepEqual(c.cursor, ['Delta'], 'the plain click did not move the cursor to Delta')
  assert.equal(c.kbdFocus, false, 'a plain click did not disarm .kbd-focus')
  assert.equal(c.rows.Beta.beforeShadow, 'none', 'the ring stayed on the former cursor row')
  assert.equal(c.rows.Delta.beforeShadow, 'none', 'the ring followed the plain click to the new cursor row')

  if (k.dpr === 1 && c.dpr === 1) {
    // Outset 2px from a fill whose left edge is x 12: columns 10 and 11.
    assert.deepEqual(d.pixB.ring, Object.fromEntries(d.pixB.xs.map((x) => [x, '555555'])),
      'the ring is not painted #555555 in the two columns outside the fill: ' + JSON.stringify(d.pixB))
    // The TOP edge lies outside the row box, where `.tr { overflow: hidden }`
    // clipped it and the row above's indent guide painted over it — measured
    // missing in a real window before this assertion existed.  NEAR, not
    // exact: this y sits at a row BOUNDARY, which a non-integer `--row-h` need
    // not land on a whole device pixel (see NEAR_HEX).
    const want = Object.fromEntries(d.pixB.topXs.map((x) => [x, '555555']))
    assertNearHexMap(d.pixB.topEdge.above1, want,
      'the ring\'s top edge is missing 1px above the fill (clipped by the row, or painted over by the row above)')
    assertNearHexMap(d.pixB.topEdge.above2, want,
      'the ring\'s top edge is missing 2px above the fill')
    assert.deepEqual(d.pixB2.formerCursor, d.pixB2.control,
      'the former cursor row still paints a ring after the plain click: ' + JSON.stringify(d.pixB2))
  } else {
    t.diagnostic('pixel leg of B NOT TAKEN at dpr ' + k.dpr)
  }

  // The pooled case: the row visually ABOVE the cursor is LATER in the DOM, so
  // it paints its indent guide over the ring's top edge unless the cursor row
  // is lifted.  Measured without `z-index: 1`: #696969 at the guide column.
  const z = d.zwrap
  assert.equal(z.found, true, 'ArrowDown never reached a cursor row whose row above is later in the DOM: ' + JSON.stringify(z))
  assert.equal(z.kbdFocus, true, 'the wrap leg lost .kbd-focus')
  assert.equal(z.beforeShadow, RING, 'the wrap leg\'s cursor row does not carry the ring')
  if (z.dpr === 1) {
    // NEAR, not exact — see NEAR_HEX: this y is a row boundary, which a
    // non-integer `--row-h` need not land on a whole device pixel.
    const want = Object.fromEntries(z.xs.map((x) => [x, '555555']))
    assertNearHexMap(z.above1, want,
      'the row above (later in the DOM) paints over the ring\'s top edge, 1px above the fill')
    assertNearHexMap(z.above2, want,
      'the row above (later in the DOM) paints over the ring\'s top edge, 2px above the fill')
  } else {
    t.diagnostic('pixel leg of the pool-wrap case NOT TAKEN at dpr ' + z.dpr)
  }
})

test('C: overflowing, the fill ends 12 + the scrollbar width inside the sidebar; not, 12 (user report 2)', {
  skip: SKIP,
}, async (t) => {
  const d = await liveProbe()
  const o = d.overflowing
  const n = d.notOverflowing

  // Both states are real, by the scroller's own numbers and by tree.ts's flag.
  assert.ok(o.snap.scrollHeight > o.snap.clientHeight,
    'the fixture no longer overflows: ' + o.snap.scrollHeight + ' <= ' + o.snap.clientHeight)
  assert.equal(o.snap.overflowing, true, 'an overflowing tree lacks .is-overflowing')
  assert.ok(n.snap.scrollHeight <= n.snap.clientHeight,
    'the folded fixture still overflows: ' + n.snap.scrollHeight + ' > ' + n.snap.clientHeight)
  assert.equal(n.snap.overflowing, false, 'a tree that fits still carries .is-overflowing')

  // The width, as chrome.ts wrote it, against the engine measured afresh.
  const nav = o.nav
  assert.match(nav.inline, /^\d+(\.\d+)?px$/, '--nav-scrollbar-w is not an inline px value on <html>: ' + JSON.stringify(nav))
  assert.equal(nav.computed, nav.inline, 'the inline --nav-scrollbar-w is not the one in effect')
  const w = parseFloat(nav.inline)
  if (nav.os === 'linux') {
    // Obsidian's styled `--scrollbar-width` (app.css:2623); NOT measured on Debian.
    assert.equal(w, 12, 'on Linux the width is Obsidian\'s styled 12px')
  } else {
    assert.equal(w, nav.fresh,
      '--nav-scrollbar-w is not what this engine gives a box under Obsidian\'s scrollbar-color: ' + JSON.stringify(nav))
  }
  assert.ok(w > 0,
    'VACUOUS RUN: the scrollbar width is 0 (overlay scroll bars?), so the overflowing and ' +
    'non-overflowing insets would be identical and C could not fail.')

  // LAYOUT: the fill's right edge, from the row box and the pseudo's used `right`.
  const sbO = o.snap.sidebar.right
  const sbN = n.snap.sidebar.right
  assert.equal(sbO - o.layoutFillRight, BASE_INSET + w,
    'overflowing: the fill ends ' + (sbO - o.layoutFillRight) + 'px inside the sidebar, not ' + (BASE_INSET + w))
  assert.equal(sbN - n.layoutFillRight, BASE_INSET,
    'not overflowing: the fill ends ' + (sbN - n.layoutFillRight) + 'px inside the sidebar, not ' + BASE_INSET)
  assert.notEqual(o.layoutFillRight, n.layoutFillRight, 'the two states put the fill\'s right edge in the same place')
  // The label's clip edge moves with the fill, or a long name runs into the
  // gap.  Asserted as the RELATION (padding-right = the fill's own right
  // inset + Obsidian's 8px title padding), read from each row's live
  // `::before`, not as a value that happens to match today's 8px scrollbar
  // gutter — the gutter and the label-clip fix are two different tokens, and
  // this is the check that notices if a change to one ever separates them.
  const wantPadO = parseFloat(o.snap.rows.Delta.beforeRight) + 8
  const wantPadN = parseFloat(n.snap.rows.Delta.beforeRight) + 8
  assert.equal(o.snap.rows.Delta.padRight, wantPadO + 'px',
    'overflowing: padding-right ' + o.snap.rows.Delta.padRight + ' is not the fill\'s own right inset (' +
    o.snap.rows.Delta.beforeRight + ') + 8px')
  assert.equal(n.snap.rows.Delta.padRight, wantPadN + 'px',
    'not overflowing: padding-right ' + n.snap.rows.Delta.padRight + ' is not the fill\'s own right inset (' +
    n.snap.rows.Delta.beforeRight + ') + 8px')

  // PIXELS: the first column that is not fill, on the active row's centre line.
  if (o.dpr === 1 && n.dpr === 1) {
    assert.ok(o.pixelFillRight && n.pixelFillRight, 'no fill edge found in the frame: ' + JSON.stringify([o.pixelFillRight, n.pixelFillRight]))
    assert.equal(o.pixelFillRight.x, o.layoutFillRight, 'overflowing: the painted fill does not end where layout says')
    assert.equal(n.pixelFillRight.x, n.layoutFillRight, 'not overflowing: the painted fill does not end where layout says')
  } else {
    t.diagnostic('pixel leg of C NOT TAKEN at dpr ' + o.dpr)
  }
})
