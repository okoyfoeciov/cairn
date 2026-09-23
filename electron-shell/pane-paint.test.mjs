/**
 * electron-shell/pane-paint.test.mjs — §0.52 E100: the editor pane is a paint
 * containment box, and that is what puts every snapped box inside it on
 * Obsidian's device column.
 *
 * ===========================================================================
 * WHAT THE USER REPORTED
 * ===========================================================================
 * *"I think those bullets are closer to the right than Obsidian. 1 pixel or
 * so!"* — and it is one pixel, exactly one DEVICE pixel, on a screenshot at
 * dpr 1.25.
 *
 * Cross-correlating the glyph ink of the bullet rows against the unindented
 * rows put the TEXT at −0.20 device px, i.e. aligned; the DOT alone came back
 * at exactly −1.000 on all four rows.
 *
 * ===========================================================================
 * THE LAYOUT WAS ALREADY IDENTICAL, WHICH IS WHY THIS IS A PAINT TEST
 * ===========================================================================
 * Measured in both apps at the same sidebar width, on the same engine
 * (Chrome/142.0.7444.265 / Electron 39.8.3 in BOTH — the Debian Obsidian runs
 * the build Cairn pins, so §9's version gap is a macOS fact and not this one):
 *
 *                                    Obsidian    Cairn
 *   bullet content box, rel content    22.5625    22.5625
 *   dot width                           4.8        4.8
 *   dot left,   rel content            23.5562    23.5563
 *
 * The same box, to four decimals — and Cairn painted it one column right.
 *
 * THE CAUSE IS AN ANCESTOR THAT CAIRN DID NOT HAVE. Obsidian's `.workspace-leaf`
 * carries `contain: strict`. Paint containment makes the pane a paint origin of
 * its own and Chromium SNAPS that origin; the pane's left edge is the sidebar's
 * width, which at dpr 1.25 is almost never whole (221 CSS px is 276.25 device),
 * so everything inside Obsidian is painted 0.25 device px left of where an
 * uncontained subtree puts it. A box Chromium snaps — the bullet's disc — then
 * rounds the other way. `chrome.css` gives `.editor` `contain: paint`, and the
 * bisection that found it is in CONTRACT §0.52.
 *
 * ===========================================================================
 * WHAT THIS FILE ASSERTS, AND WHY IT CANNOT BE A UNIT TEST
 * ===========================================================================
 * A painted column. Nothing below a real compositor has one: the DOM, the CSS
 * and every `getBoundingClientRect` were already correct and identical to
 * Obsidian's while the defect was on screen.
 *
 * AND IT CAPTURES AT A FRACTIONAL SCALE, NOT AT 1. At dpr 1 a pane whose left
 * edge is a whole CSS pixel is already on the device grid, there is nothing to
 * snap, and the defect does not exist — so a capture at G10's reference scale
 * would pass against the broken code. §0.26.2 E66 hit the same wall and forced
 * 1.25 on its own regression test for the same reason.
 *
 * THE EXPECTATION IS COMPUTED, NOT A LITERAL. The test reads the pane's left
 * edge and the dot's left edge out of the SAME frame it photographed, forms
 * both predictions, and requires the painted column to be the CONTAINED one —
 * plus it requires the two predictions to DIFFER, so a fixture at which they
 * happen to coincide reports itself instead of passing vacuously.
 *
 * ===========================================================================
 * THE FIRST macOS RUN (2026-09-13) FOUND TWO HOLES IN THAT, BOTH IN THE HARNESS
 * ===========================================================================
 * (1) EMULATION IS NOT A SCALE. The capture used to reach 1.25 through CDP
 * alone (`CAIRN_CAPTURE_DPR` -> `Emulation.setDeviceMetricsOverride`), and the
 * first row below checked `devicePixelRatio === 1.25`. On Debian that was
 * honest by accident: the desktop IS 1.25, so emulation agreed with the real
 * scale. On a dpr-1 Mac, measured with this file's own fixture:
 *
 *                               emulation only     + --force-device-scale-factor
 *   devicePixelRatio                 1.25                 1.25
 *   a 1.2px-tall box lays out as     1.1875               1.2000
 *   the disc's ink columns           7 (unsnapped)        6 (snapped)
 *   `contain: paint` vs `none`       0 of 2,892,000 px    8,372 px of text move
 *                                    differ
 *
 * Under emulation alone Chromium lays out on the HOST's 1/64-CSS-px grid and
 * never snaps to the emulated device grid, so containment cannot move a pixel
 * at any sidebar width — the test could only fail there, or, on a width where
 * the predictions coincide, pass having asked nothing. So the launch now
 * carries the REAL switch as well (lifecycle.test.mjs's §0.26.2 pattern), and
 * the check that the scale took is one EMULATION CANNOT SATISFY: a box
 * declared 1.2px tall must lay out as `floor(1.2 × dpr × 64) / 64 / dpr`, the
 * value on THAT scale's layout grid (1.2 at 1.25, 1.19792 at 1.5), where the
 * host's grid gives 1.1875 at dpr 1 and 1.19531 at dpr 2 — measured on this
 * Mac as (emulation only / with the switch) 1.1875 / 1.2000 at 1.25, and
 * 1.1875 / 1.1979167 at 1.5.
 *
 * app-main.mjs records (§0.19.1) that a Wayland compositor overrides that
 * switch through `wp_fractional_scale`. That was measured for `=1` on a 1.25
 * desktop; on Debian the first rung below asks for 1.25, the desktop's own
 * scale, so switch, emulation and compositor all agree. A rung where the
 * compositor wins fails the grid row by name instead of producing a picture.
 *
 * (2) THE DOT'S OFFSET FROM THE PANE IS FONT-DEPENDENT, SO NO FIXED FIXTURE IS
 * SAFE. Write the offset in device px as `k + f` and the pane's origin
 * fraction as `p = frac(sidebar × dpr)`. `contained − uncontained` is
 * `round(p) + round(f) − round(p + f)`, which is non-zero exactly when
 *
 *     p = 0.25 and f ∈ [0.25, 0.5)      p = 0.5  and f ∈ [0.5, 1)
 *     p = 0.75 and f ∈ [0.5, 0.75)      p = 0    never
 *
 * CONTRACT §0.52.5's *"one integer sidebar width in four"* is TRUE ONLY FOR
 * DEBIAN'S FONT: there the dot is 69.4453 device px from the pane at 1.25,
 * f = .445, and 221 (p = .25) separates. On this Mac the line font resolves to
 * the system SF (a space is 4.1875 px against Debian's 3.5235), the dot is
 * 72.21875 device px out at a real 1.25, f = .219, and NO integer width
 * separates at 1.25 at all — zero in four. At a real 1.5 the same dot is
 * 86.67195 device px out, f = .672, and 221 (p = .5) separates: measured,
 * contained predicts 419, `contain: paint` paints 419 and `contain: none`
 * paints 418.
 *
 * So the fixture is CHOSEN, not pinned. A pre-flight capture at (1.25, 221)
 * reads the offset; if some width separates at that scale the first such width
 * is used (221 itself reuses the pre-flight frame, so Debian still launches
 * once, at the user's own width); otherwise the next rung of DPR_LADDER is
 * tried. p = 0.5 widths are tried LAST within a rung because they ask Chromium
 * to break a tie: measured on this Mac at a real 1.5 it rounds the pane's
 * origin UP (331.5 -> 332 at 221, 334.5 -> 335 at 223), which is what
 * `Math.round` does, but it is a rounding convention and a quarter-pixel phase
 * is not. If no rung separates, the vacuity guard in the pixel test still
 * refuses the fixture and prints what the pre-flight saw.
 */

import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { decodePng } from '../tools/png.mjs'
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

/** The reported shape: a nested bullet under an ordered item. */
const NOTE = [
  'Plain paragraph so the note does not open on a heading.',
  '',
  '1. An ordered parent line. Cover:',
  '   - A nested bullet under an ordered item.',
  '   - A second nested bullet.',
  '',
].join('\n')

/* The scales the pre-flight tries, in order. 1.25 first because it is Debian's
   desktop, the scale the defect was reported at, and the one rung where the
   Wayland compositor cannot disagree with the switch. The rest are fallbacks
   for a font whose dot offset no 1.25 width can separate (header, hole 2). */
const DPR_LADDER = [1.25, 1.5, 1.75]
/* Four consecutive integers cover every pane-origin phase any of those scales
   can produce. 221 is FIRST because it is the user's own width, and on Debian
   it is the width that separates, so that box keeps the fixture it always had. */
const WIDTHS = [221, 222, 223, 224]

/* The real-scale probe (header, hole 1): a box declared this tall lays out on
   the layout grid of whatever scale Chromium is ACTUALLY rasterising at. */
const GRID_PROBE_PX = 1.2
const onLayoutGrid = (len, dpr) => Math.floor(len * dpr * 64) / 64 / dpr

/* Read out of the SAME frame the picture came from: the pane's left edge, the
   dot's left edge, the scale, and the grid probe. The probe box is appended,
   measured and removed inside this one synchronous script, so it never reaches
   a frame. NO BACKTICKS (§0.24.10). */
const EVAL = `(() => {
  const pane = document.querySelector('main.editor')
  const dot = document.querySelector('.nc-bullet')
  if (!pane || !dot) return { error: 'no pane or no bullet' }
  const pr = pane.getBoundingClientRect(), dr = dot.getBoundingClientRect()
  const cs = getComputedStyle(dot), af = getComputedStyle(dot, '::after')
  const g = document.createElement('div')
  g.style.cssText = 'position:absolute;left:0;top:0;width:1px;height:${GRID_PROBE_PX}px;visibility:hidden'
  document.body.appendChild(g)
  const gridH = g.getBoundingClientRect().height
  g.remove()
  return {
    contain: getComputedStyle(pane).contain,
    paneLeft: pr.left,
    dotLeft: dr.left + (parseFloat(cs.borderLeftWidth) || 0) + parseFloat(af.insetInlineStart),
    dotTop: dr.top + (parseFloat(cs.borderTopWidth) || 0) + parseFloat(af.insetBlockStart),
    dotW: parseFloat(af.width),
    dpr: window.devicePixelRatio,
    gridH,
  }
})()`

/** Both predictions of the disc's painted left column, in device px.
 *    uncontained: the box is snapped against the viewport.
 *    contained:   the PANE's origin is snapped first, and the box is snapped
 *                 against that -- which is what Obsidian does. */
function predict(paneDev, dotDev) {
  return {
    uncontained: Math.round(dotDev),
    contained: Math.round(paneDev) + Math.round(dotDev - paneDev),
  }
}

/** Throws unless the frame was laid out -- and so rasterised -- at `dpr` for
 *  real. `devicePixelRatio` alone cannot say so: emulation sets it too. */
function assertRealScale(e, dpr) {
  const want = onLayoutGrid(GRID_PROBE_PX, dpr)
  // The row must be able to fail: the grids of the two host scales this
  // project's machines have had (dpr 1 and dpr 2) must give a different answer.
  for (const host of [1, 2]) {
    assert.ok(Math.abs(want - onLayoutGrid(GRID_PROBE_PX, host)) > 1e-3,
      `at dpr ${dpr} a ${GRID_PROBE_PX}px box lays out the same on a dpr-${host} host -- ` +
      'the real-scale row cannot tell emulation from the real scale; pick another probe length')
  }
  // 1e-4 absorbs the float32 in getBoundingClientRect (1.2000000477 measured)
  // and nothing else: the nearest wrong grid is 1.1e-3 away.
  assert.ok(Math.abs(e.gridH - want) < 1e-4,
    `a ${GRID_PROBE_PX}px box laid out as ${e.gridH}, not ${want} -- the page reports dpr ` +
    `${e.dpr} but was NOT rasterised at ${dpr} (emulation without the real scale, or a ` +
    'compositor that overrode --force-device-scale-factor, CONTRACT §0.19.1). ' +
    'Containment cannot move a pixel in that frame, so this test would prove nothing')
}

function runCapture({ sidebar, dpr }) {
  return new Promise((resolve, reject) => {
    const work = mkdtempSync(join(tmpdir(), 'cairn-panepaint-'))
    const vault = join(work, 'vault')
    const state = join(work, 'state')
    mkdirSync(join(vault, 'Notes'), { recursive: true })
    mkdirSync(state, { recursive: true })
    writeFileSync(join(vault, 'Notes', 'bullets.md'), NOTE)
    writeFileSync(join(vault, 'root.md'), 'root file\n')
    // The shell reads `sidebar_w` straight out of state.json before the window
    // opens (`persistedSidebarW`), which is the only way to pin it from here.
    writeFileSync(join(state, 'state.json'), JSON.stringify({ v: 1, sidebar_w: sidebar }))
    const png = join(work, 'shot.png')

    // The REAL scale switch AND the emulation, at the same value: the switch is
    // what makes Chromium lay out and snap on that scale's device grid (hole 1),
    // and the emulation is what keeps a Wayland desktop at the asked-for scale
    // where it agrees (§0.19.1). `assertRealScale` is what says which one won.
    const child = spawn(BIN, [join(HERE, 'app-main.mjs'), `--force-device-scale-factor=${dpr}`], {
      cwd: ROOT,
      env: {
        ...process.env,
        CAIRN_HEADLESS: '1',
        CAIRN_VAULT: vault,
        CAIRN_PIXELTEST_EXPANDED: 'Notes',
        CAIRN_PIXELTEST_NOTE: 'Notes/bullets.md',
        CAIRN_STATE_DIR: state,
        CAIRN_ELECTRON_GEOM: '1920x964',
        CAIRN_CAPTURE: png,
        CAIRN_CAPTURE_DPR: String(dpr),
        CAIRN_CAPTURE_EVAL: EVAL,
        CAIRN_CAPTURE_SETTLE: '2500',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    const kill = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('capture timed out after 90s\nstdout:\n' + out + '\nstderr:\n' + err))
    }, 90_000)
    child.on('error', (e) => { clearTimeout(kill); reject(e) })
    child.on('exit', () => {
      clearTimeout(kill)
      const line = out.split('\n').find((l) => l.startsWith('CAPTURE '))
      if (!line) { reject(new Error('no CAPTURE line\nstdout:\n' + out + '\nstderr:\n' + err)); return }
      const report = JSON.parse(line.slice('CAPTURE '.length))
      if (!report.ok) { reject(new Error('capture failed: ' + JSON.stringify(report))); return }
      const shot = readFileSync(png)
      rmSync(work, { recursive: true, force: true })
      resolve({ report, png: shot, sidebar, dpr })
    })
  })
}

/** THE PRE-FLIGHT (header, hole 2). Returns the capture to assert on, plus a
 *  record of every rung it tried, for the failure messages. */
async function chooseFixture() {
  const attempts = []
  let last = null
  for (const dpr of DPR_LADDER) {
    const probe = await runCapture({ sidebar: WIDTHS[0], dpr })
    last = probe
    const e = probe.report.eval
    // A frame that did not run the probe, or was not rasterised at `dpr`, cannot
    // predict anything at `dpr`. Stop and hand it to the assertions, which say
    // which of the two it was -- a fallback past it would hide the reason.
    if (!e || e.error || Math.abs(e.gridH - onLayoutGrid(GRID_PROBE_PX, dpr)) >= 1e-4) {
      attempts.push({ dpr, stopped: e && !e.error ? `not at the real scale (gridH ${e.gridH})` : 'no probe' })
      return { ...probe, attempts }
    }
    // The dot's offset from the pane in device px, at THIS scale's layout grid.
    // Width-independent: the pane's origin is a whole CSS px, which is on every
    // one of these grids, so moving it translates the subtree in whole layout
    // units (measured on this Mac: 86.67195 at a real 1.5 for 221, 222 and 223
    // alike, and 72.207 at every width 218..229 under 1.25 emulation).
    const offDev = (e.dotLeft - e.paneLeft) * dpr
    const isTie = (w) => Math.abs((w * dpr) % 1 - 0.5) < 1e-9
    const ordered = [...WIDTHS.filter((w) => !isTie(w)), ...WIDTHS.filter(isTie)]
    const separating = ordered.filter((w) => {
      const { uncontained, contained } = predict(w * dpr, w * dpr + offDev)
      return uncontained !== contained
    })
    attempts.push({ dpr, offDev: +offDev.toFixed(5), separating })
    if (separating.length === 0) continue
    const sidebar = separating[0]
    const chosen = sidebar === probe.sidebar ? probe : await runCapture({ sidebar, dpr })
    return { ...chosen, attempts }
  }
  // Nothing separates on any rung: hand the last frame over and let the vacuity
  // guard refuse it, with the whole ladder in its message.
  return { ...last, attempts }
}

let cached = null
const captureOnce = async () => (cached ??= await chooseFixture())

/** The ink columns of the bullet's disc, from the picture. */
function dotColumns(png, dev) {
  const { width: w, height: h, data } = decodePng(png)
  const lum = (x, y) => {
    const i = (y * w + x) * 4
    return (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000
  }
  // A window around where the layout says the disc is, wide enough that a
  // column either side of both predictions is inside it and narrow enough that
  // the bullet's own text is not.
  const x0 = Math.max(0, Math.round(dev.left) - 5)
  const x1 = Math.min(w, Math.round(dev.left + dev.w) + 5)
  const y0 = Math.max(0, Math.round(dev.top) - 3)
  const y1 = Math.min(h, Math.round(dev.top + dev.w) + 3)
  const ground = Math.round(lum(x0, y0))
  const cols = []
  for (let x = x0; x < x1; x++) {
    let s = 0
    for (let y = y0; y < y1; y++) s += Math.max(0, lum(x, y) - ground)
    if (s > 3) cols.push(x)
  }
  return cols
}

test('§0.52 E100: the editor pane declares paint containment',
  { skip: SKIP }, async () => {
    const { report, sidebar, dpr, attempts } = await captureOnce()
    const e = report.eval
    assert.ok(e && !e.error, 'the probe did not run: ' + JSON.stringify(e))
    // COMPUTED, not the source. §0.24.5 E53's rule: a declaration that is
    // present and outranked fails in total silence.
    assert.match(e.contain, /\bpaint\b/,
      `main.editor's computed \`contain\` is ${JSON.stringify(e.contain)}`)
    assert.equal(e.paneLeft, sidebar, 'the seeded sidebar width did not take')
    assert.equal(e.dpr, dpr, 'the capture scale did not reach the page')
    // NECESSARY, NOT SUFFICIENT, and the 2026-09-13 macOS run is the proof:
    // `devicePixelRatio` read 1.25 in a frame laid out on the dpr-1 grid.
    assertRealScale(e, dpr)
    assert.ok(attempts.length > 0, 'the pre-flight recorded nothing')
  })

test('§0.52 E100: the bullet paints on the CONTAINED device column, not the viewport one',
  { skip: SKIP }, async (t) => {
    const { report, png, sidebar, dpr, attempts } = await captureOnce()
    const e = report.eval
    assert.ok(e && !e.error, 'the probe did not run: ' + JSON.stringify(e))
    t.diagnostic(`fixture: sidebar ${sidebar} at dpr ${dpr}; pre-flight ${JSON.stringify(attempts)}`)
    assert.equal(e.dpr, dpr, 'the capture scale did not reach the page')
    assertRealScale(e, dpr)

    const paneDev = e.paneLeft * dpr
    const dotDev = e.dotLeft * dpr
    const { uncontained, contained } = predict(paneDev, dotDev)

    // THE ROW THAT STOPS THIS PASSING VACUOUSLY, re-derived from THIS frame and
    // not trusted from the pre-flight. Which fixtures separate the predictions
    // depends on the font (header, hole 2); if no rung of the ladder found one,
    // or the chosen frame disagrees with the pre-flight's, this says so instead
    // of going green on a question it never asked.
    assert.notEqual(uncontained, contained,
      `sidebar ${sidebar} at dpr ${dpr} cannot tell the two apart -- ` +
      `pre-flight ${JSON.stringify(attempts)}. No fixture on the ladder separates ` +
      'contained from uncontained with this font, so this test proves nothing')

    const cols = dotColumns(png, { left: dotDev, top: e.dotTop * dpr, w: e.dotW * dpr })
    assert.ok(cols.length > 0, 'no ink where the layout says the bullet is')
    assert.equal(cols[0], contained,
      `the bullet painted at column ${cols[0]}; contained predicts ${contained}, ` +
      `uncontained ${uncontained}. Obsidian paints ${contained}.`)
    // …and the disc is the size it should be, so a column count of one cannot
    // satisfy the row above.
    assert.equal(cols.length, Math.round(e.dotW * dpr),
      `the disc is ${cols.length} device columns, not ${Math.round(e.dotW * dpr)}`)
  })
