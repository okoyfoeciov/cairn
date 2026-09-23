/**
 * electron-shell/fold.test.mjs — §0.44 E90's folder fold, in the real engine.
 *
 * ===========================================================================
 * WHY THIS CANNOT LIVE IN `tests/frontend/tree.test.mjs`
 * ===========================================================================
 * That file's DOM shim has no `requestAnimationFrame`, no computed styles and
 * no layout. `setOpen()`'s `canAnimate` therefore evaluates FALSE there by
 * construction and every one of its 63 tests exercises the INSTANT path — which
 * is exactly what happened when this feature landed: all 63 stayed green and
 * not one of them could have failed on a broken animation.
 *
 * That is §0.30 E71's lesson in new clothes ("a test that can only fail one way
 * is half a test") and §0.20.6.1's ("a feature nobody has executed cannot
 * fail"). The fold is only observable where there is a compositor to run it, so
 * the assertions are here and the shim keeps testing the model.
 *
 * ===========================================================================
 * WHAT IS ASSERTED, AND WHY EACH ONE IS A SEPARATE CLAIM
 * ===========================================================================
 *   1. It ANIMATES — the sizer takes many distinct intermediate heights rather
 *      than jumping. A regression to the class-flip this replaced passes every
 *      before/after assertion and fails only this one.
 *   2. THE CHILDREN DO NOT MOVE. Measured in the live Obsidian (§0.44.2): its
 *      first child's viewport top held at 113.10 for the whole 100ms while the
 *      row below the folder travelled 113.00 -> 166.90. A fold that slid the
 *      children down would look plausible and be wrong.
 *   3. THE ROW BELOW MOVES IN LOCKSTEP with the sizer, which is what makes the
 *      band look like it is pushing rather than overlapping.
 *   4. THE ARROW TURNS, on Obsidian's own `transform 100ms ease-in-out`.
 *   5. ONLY THE CLICKED ROW'S ARROW MAY TURN. `.tr` elements are POOLED, so a
 *      blanket transition spins the arrow of every recycled row during a
 *      scroll. This is the assertion that pins `--chev-ms`.
 *   6. IT SETTLES CLEAN — no `clip-path` and no `--chev-ms` left behind on any
 *      row, and the geometry back to an exact whole number of rows.
 *   7. A CLOSE KEEPS ITS ROWS to the last frame and drops them after, which is
 *      Obsidian's append-before / detach-after order.
 *
 * ===========================================================================
 * REQUIREMENTS
 * ===========================================================================
 * A display connection. The window is `CAIRN_HEADLESS=1` — offscreen and never
 * shown — but Electron still needs a compositor to run rAF at all, and a run
 * where rAF never fired is not a small measurement but a wrong one (§3).
 * Skipped, with a reason, where there is none.
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

/**
 * The row pitch — READ FROM THE PROBE (`d.rowH`), never a literal.  It was a
 * hardcoded `27` and stopped being right the day `chrome.ts`'s `applyRowH`
 * started measuring Obsidian's real pitch (26.890625 on this Mac, §0.17): the
 * fixture's geometry is still whole rows, just not whole rows of 27.
 */
const NEAR = (value, rowH, tol = 0.02) => {
  const rem = ((value % rowH) + rowH) % rowH
  return Math.min(rem, rowH - rem) < tol
}

function runProbe() {
  return new Promise((resolve, reject) => {
    const work = mkdtempSync(join(tmpdir(), 'cairn-fold-'))
    const cleanup = () => {
      try { rmSync(work, { recursive: true, force: true }) } catch {}
    }
    const vault = join(work, 'vault')
    // TWO folders, because assertion 5 needs a SECOND collapsible row to prove
    // the arming is not global. `Agent` sorts first, so it is the `.tr.d` the
    // probe clicks; `Moldco` is the control.
    mkdirSync(join(vault, 'Agent'), { recursive: true })
    mkdirSync(join(vault, 'Moldco'), { recursive: true })
    writeFileSync(join(vault, 'Agent', 'Memory.md'), 'm\n')
    writeFileSync(join(vault, 'Agent', 'settings.md'), 's\n')
    writeFileSync(join(vault, 'Moldco', 'plan.md'), 'p\n')
    // Sorts after both folders, so it is the row the fold has to push down.
    writeFileSync(join(vault, 'zz-after.md'), 'z\n')

    const child = spawn(BIN, [join(HERE, 'app-main.mjs')], {
      cwd: ROOT,
      env: {
        ...process.env,
        CAIRN_HEADLESS: '1',
        CAIRN_FOLD_PROBE: '1',
        CAIRN_VAULT: vault,
        // Hermetic (spike-M D1): a test that boots the app must not rewrite the
        // vault, recents or geometry of the person running it.
        CAIRN_STATE_DIR: join(work, 'state'),
        CAIRN_ELECTRON_GEOM: '1200x800',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })

    const kill = setTimeout(() => {
      child.kill('SIGKILL')
      cleanup()
      reject(new Error('fold probe timed out after 90s\nstdout:\n' + out + '\nstderr:\n' + err))
    }, 90_000)

    child.on('error', (e) => { clearTimeout(kill); cleanup(); reject(e) })
    child.on('exit', () => {
      clearTimeout(kill)
      const line = out.split('\n').find((l) => l.startsWith('FOLD '))
      if (!line) {
        cleanup()
        reject(new Error('no FOLD line\nstdout:\n' + out + '\nstderr:\n' + err))
        return
      }
      const result = JSON.parse(line.slice('FOLD '.length))
      cleanup()
      resolve(result)
    })
  })
}

let cached = null
const probeOnce = async () => (cached ??= await runProbe())

/** The named row's `translateY` in one sampled frame, or `null`. */
const yOf = (frame, name) => {
  const r = frame.rows.find((x) => x.t === name)
  return r ? r.y : null
}
const kidsIn = (frame) => frame.rows.filter((r) => r.t === 'Memory' || r.t === 'settings')

test('§0.44 E90 the fold ANIMATES: the sizer takes many intermediate heights, not one jump', {
  skip: SKIP,
}, async () => {
  const d = await probeOnce()
  assert.equal(d.error, undefined, 'probe error: ' + JSON.stringify(d.error))
  const ROW_H = d.rowH
  assert.ok(ROW_H > 0, 'the probe reported no --row-h: ' + ROW_H)

  const h = d.open.frames.map((f) => f.szH)
  // rAF really ran. A run where it did not is not a small measurement (§3).
  assert.ok(d.open.frames.length >= 6, 'rAF did not fire: only ' + d.open.frames.length + ' frames')

  const start = h[0]
  const end = h[h.length - 1]
  // Tolerant, not exact: `sz.style.height`/`getBoundingClientRect()` (`num()`,
  // rounded to 2 decimals) can each be a sub-pixel layout snap off a
  // non-integer ROW_H, and the difference of two such readings compounds it.
  assert.ok(Math.abs(end - start - 2 * ROW_H) < 0.15,
    'the band is not the folder\'s two notes: ' + (end - start) + ' vs ' + (2 * ROW_H))

  // THE ASSERTION A CLASS FLIP FAILS. A jump produces exactly two distinct
  // heights; an animation produces a spread of them.
  const distinct = new Set(h.map((v) => Math.round(v)))
  assert.ok(distinct.size >= 5, 'expected a swept height, got ' + distinct.size + ' values: ' + [...distinct])

  // Monotonic: a fold never backs up.
  for (let i = 1; i < h.length; i++) {
    assert.ok(h[i] >= h[i - 1] - 0.01, 'height went backwards at frame ' + i + ': ' + h[i - 1] + ' -> ' + h[i])
  }
})

test('§0.44 E90 the children HOLD their positions and the row below slides — Obsidian\'s own shape', {
  skip: SKIP,
}, async () => {
  const d = await probeOnce()
  const ROW_H = d.rowH

  // (2) Measured in the live Obsidian: kid tops constant for the whole fold.
  const seen = new Map()
  for (const f of d.open.frames) {
    for (const k of kidsIn(f)) {
      if (!seen.has(k.t)) seen.set(k.t, new Set())
      seen.get(k.t).add(k.y)
    }
  }
  assert.ok(seen.size === 2, 'both children should be painted throughout, saw ' + [...seen.keys()])
  for (const [name, ys] of seen) {
    assert.equal(ys.size, 1, name + ' MOVED during the fold (' + [...ys] + ') — Obsidian\'s do not')
  }

  // (3) …while the row below travels the band's full height, in lockstep.
  const first = d.open.frames[0]
  const last = d.open.frames[d.open.frames.length - 1]

  /* TOLERANT AT THE START, EXACT AT THE END, and the asymmetry is the point.
   * This read `assert.equal(travel, 2 * ROW_H)` and flaked once at **53.95**:
   * the probe's first sample is taken just after the click, and `startFold`'s
   * synchronous first frame computes `shift` from a real elapsed time — so a
   * fraction of a millisecond puts the band 0.05px open before anything is
   * sampled. That is timing jitter in the INSTRUMENT, not slack in the
   * feature, so it gets a tolerance here and none at all on the settled
   * geometry below and in the close test. An exact assertion against a sample
   * of a running animation is a flake waiting to happen. */
  const travel = yOf(last, 'zz-after') - yOf(first, 'zz-after')
  assert.ok(Math.abs(travel - 2 * ROW_H) < 1,
    'the row below the folder must be pushed down by the band, got ' + travel)
  // Exact where it can be: the fold must END on a whole number of rows.  A
  // small tolerance, not `=== 0`: `yOf()`'s reading is itself rounded to 2
  // decimals (app-main.mjs's `num()`), which a non-integer ROW_H can put a
  // few thousandths off an exact multiple.
  assert.ok(NEAR(yOf(last, 'zz-after'), ROW_H),
    'the fold settled on a fractional row: ' + yOf(last, 'zz-after') + ' (rowH ' + ROW_H + ')')

  // Lockstep: its offset from the sizer height is invariant to within a pixel.
  for (const f of d.open.frames) {
    const gap = f.szH - yOf(f, 'zz-after')
    assert.ok(Math.abs(gap - (last.szH - yOf(last, 'zz-after'))) < 1.5,
      'row-below and sizer drifted apart mid-fold (gap ' + gap + ')')
  }
})

test('§0.44 E90 the arrow turns on Obsidian\'s transform 100ms ease-in-out', { skip: SKIP }, async () => {
  const d = await probeOnce()

  // Obsidian's own declaration, app.css:7893, verified in its live app.
  const mid = d.open.frames[2]
  assert.equal(mid.chev.prop, 'transform')
  assert.equal(mid.chev.fn, 'ease-in-out')
  assert.equal(mid.chev.dur, '0.1s', 'the armed row must carry Obsidian\'s 100ms')

  // Identity -> rotate(90deg), THROUGH intermediate matrices. The endpoints
  // alone would pass with no animation at all.
  assert.equal(d.open.frames[0].chev.tf, 'matrix(1, 0, 0, 1, 0, 0)', 'starts unrotated')
  const partial = d.open.frames.filter((f) => {
    const m = /^matrix\(([-0-9.e]+), ([-0-9.e]+)/.exec(f.chev.tf || '')
    if (!m) return false
    const a = Number(m[1])
    return a > 0.02 && a < 0.98
  })
  assert.ok(partial.length >= 2, 'the arrow snapped: no partial rotations, saw ' +
    JSON.stringify(d.open.frames.map((f) => f.chev.tf)))
})

test('§0.44 E90 ONLY the clicked row is armed — the pool must not spin every arrow', {
  skip: SKIP,
}, async () => {
  const d = await probeOnce()

  // THE POOLING GUARD. `.tr` rows are recycled by the virtualiser, so a blanket
  // `transition` on the chevron animates a slot that merely changed which node
  // it draws — arrows spinning all over the sidebar on a fast scroll.
  assert.equal(d.otherChevDurBefore, '0s', 'a second folder row was armed before any click')
  assert.equal(d.otherChevDurDuringOpen, '0s', 'a second folder row was armed DURING the fold')

  // And the channel that does it: an inline custom property, present only for
  // the fold. The chevron is a `::before` and cannot take an inline style.
  assert.equal(d.before.chev.ms, '', 'armed before the click')
  assert.equal(d.open.frames[0].chev.ms, '100ms', 'the clicked row is not armed')
  assert.equal(d.settled.chev.ms, '', '--chev-ms outlived the fold')
})

test('§0.44 E90 a close keeps its rows to the last frame, then settles clean', { skip: SKIP }, async () => {
  const d = await probeOnce()
  const ROW_H = d.rowH

  const h = d.close.frames.map((f) => f.szH)
  for (let i = 1; i < h.length; i++) {
    assert.ok(h[i] <= h[i - 1] + 0.01, 'close height went backwards at frame ' + i)
  }
  assert.ok(new Set(h.map((v) => Math.round(v))).size >= 5, 'the close did not animate: ' + [...new Set(h)])

  // Obsidian appends BEFORE animating and detaches AFTER, so a closing fold
  // still paints its rows on the frame before it ends. Flattening any earlier
  // is the abrupt behaviour this pass removes.
  const early = d.close.frames.slice(0, 4)
  assert.ok(early.every((f) => kidsIn(f).length === 2), 'the children vanished before the close finished')
  const settledKids = kidsIn(d.settled)
  assert.equal(settledKids.length, 0, 'the children survived the close')

  // (6) No residue anywhere: a leaked clip-path hides part of a row forever.
  assert.deepEqual(d.settled.rows.filter((r) => r.clip !== ''), [], 'a clip-path outlived the fold')
  assert.ok(NEAR(d.settled.szH, ROW_H),
    'the tree settled on a fractional height: ' + d.settled.szH + ' (rowH ' + ROW_H + ')')
  assert.equal(d.settled.szH, d.before.szH, 'open-then-close did not return to the starting geometry')
})
