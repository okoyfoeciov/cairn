#!/usr/bin/env node
/**
 * tools/scroll-bench.mjs -- SCROLL, ON ELECTRON: what the compositor presents,
 * what the tree's `scroll` handler costs, and how long input takes to reach
 * the glass.
 *
 * ===========================================================================
 * THIS IS A REWRITE. THE FILE IT REPLACES MEASURED AN ENGINE THAT IS DELETED.
 * ===========================================================================
 * v1 (1,673 lines) drove the Tauri/WebKitGTK binary through a probe stapled
 * into a staged copy of the frontend, and read its results back out of
 * `bench.jsonl` as chunked base64.  §8.2 step 10 deleted that binary, and from
 * 2026-09-08 the file refused to run at all -- deliberately, so that nobody
 * measured a dead engine by accident (CONTRACT §0.21.1 is what happens when a
 * stale artefact is left runnable).  Its own revival note named the work:
 * point the launch at Electron, drop `cargo tauri build`, re-derive the frame
 * model.  This is that work.
 *
 * WHAT SURVIVES FROM v1, UNCHANGED, AND WHY:
 *   * `cairnScrollPlan` -- the four-phase plan (step / momentum / jump / ends).
 *     The `jump` phase is the only way to reach the whole-pool repaint, which
 *     is where §5.12.6(d)'s budget is actually spent, and no wheel gesture can
 *     produce it.  Its invariant (no two consecutive equal tops, because an
 *     unchanged `scrollTop` fires no event) is still load-bearing.
 *   * `verdictFor` / `snapToQuantum` -- the quantisation-aware verdict.  The
 *     clock is different now (see below) but the rule is the same one, and it
 *     is the rule the contract's readers already know.
 *   * `distribution` -- a budget about dropped frames is a TAIL property.  A
 *     mean over 2,000 calls moves 0.018 ms for a 9 ms event.  Never a mean
 *     alone.
 *   * `containmentCheck`, `screenIsLocked`, kill-on-every-path.
 *
 * WHAT IS GONE, AND THIS IS THE BIGGEST SIMPLIFICATION:
 *   v1 spent ~300 lines defeating WebKit's `performance.now()` clamp, which
 *   has been 1 ms, 100 µs and 20 µs across versions and is not knowable in
 *   advance.  **This harness never reads a clock in the page.**  Every number
 *   below is a Chromium TRACE EVENT timestamp -- integer microseconds, from
 *   `base::TimeTicks`, not exposed to the page and therefore not clamped for
 *   fingerprinting.  The quantum is 0.001 ms against a 2 ms budget: three
 *   orders of magnitude of headroom where v1 had none.  `traceQuantumMs()`
 *   MEASURES it rather than asserting it, because "the clock is fine" is
 *   exactly the assumption v1 was written to distrust.
 *
 * ===========================================================================
 * THE FOUR QUANTITIES, AND THE MECHANISM FOR EACH
 * ===========================================================================
 * 1. WHAT THE COMPOSITOR PRESENTED -- `viz`'s own `Display::DrawAndSwap`, one
 *    per frame that reached the screen, in the GPU process.  Spike O §28.1
 *    named metric choice "the most expensive single error" of that
 *    investigation and ruled: **quote the compositor.**  rAF over-reports by
 *    1.16x on Chromium (spike P §2); `requestAnimationFrame` appears nowhere
 *    in this file.
 *
 * 2. WHETHER FRAMES WERE DROPPED -- `PipelineReporter`, cc's own per-frame
 *    reporter, whose terminal `state` is `STATE_PRESENTED_ALL`,
 *    `STATE_DROPPED` or `STATE_NO_UPDATE_DESIRED`.  A dropped frame and a
 *    frame nobody asked for are different things and are counted separately;
 *    a harness that lumps them reports an idle app as janky.
 *
 * 3. WHAT THE `scroll` HANDLER COST -- `devtools.timeline`'s `EventDispatch`,
 *    filtered to `data.type == 'scroll'`.  This is §5.12.6(d)'s gated
 *    quantity, measured in the real engine on real events, with NO probe in
 *    the page: v1 had to bracket the handler with two listeners of its own
 *    ("the sandwich") because WebKit exposed nothing; Chromium already emits
 *    the span.  It is an UPPER bound -- the trace event covers the whole
 *    dispatch, so it includes the dispatch machinery and any other listener on
 *    the path.  The tree's own listener (`src/tree.ts:2414`) is the only `scroll`
 *    listener in `src/`, so on this path the number is that handler plus
 *    dispatch overhead.
 *    Both `dur` (wall) and `tdur` (thread CPU) are reported: their difference
 *    is preemption by other main-thread work, which is a real scrolling cost
 *    but is NOT the handler's own cost, and the budget is written about the
 *    handler.
 *
 * 4. HOW LONG INPUT TOOK TO REACH THE GLASS -- cc's `EventLatency`, keyed by
 *    event type.  Spike O §28.2 and spike P §8 both record input latency as
 *    never measured in this project, and the user's original complaint was a
 *    latency complaint ("laggy, not sharp").  This is the first instrument
 *    here that produces the number.
 *
 * ===========================================================================
 * WHAT DRIVES THE SCROLL, AND WHY IT IS NOT `scrollTop` ANY MORE
 * ===========================================================================
 * v1's first documented caveat was "IT DRIVES `scrollTop`, NOT A WHEEL", for a
 * good reason: a synthesised `wheel` event from JS is untrusted and scrolls
 * nothing.  The Chrome DevTools Protocol has no such limit --
 * `Input.synthesizeScrollGesture` is dispatched by the BROWSER process and is
 * a trusted input event, so it travels the real path: browser -> renderer
 * compositor -> scroll on the compositor thread -> `scroll` event on main.
 * Measured: one coalesced `wheel` per presented frame, which is Chromium's
 * real cadence.
 *
 * So there are two phases and they answer different questions:
 *   gesture  a real trusted wheel gesture.  The ONLY phase that can produce a
 *            frame-rate number, because it is the only one where the
 *            compositor is doing what it does during a scroll.
 *   plan     v1's four-phase `scrollTop` plan, driven one assignment per
 *            animation frame.  NOT a frame-rate measurement -- an assignment
 *            is not a wheel and the cadence is the harness's -- but the only
 *            way to reach the `jump` path, where the handler repaints the
 *            whole pool.  Its handler samples are reported SEPARATELY and the
 *            gate verdict is taken over BOTH.
 *
 * ===========================================================================
 * WHAT THIS HARNESS DOES NOT MEASURE -- READ BEFORE QUOTING ITS NUMBERS
 * ===========================================================================
 *   1. IT DOES NOT MEASURE A TRACKPAD.  §4 of CLAUDE.md: the user works with a
 *      mouse, and momentum/rubber-band/fling are explicitly out of scope for
 *      v1.  `preventFling: true` is passed for that reason.
 *   2. IT DOES NOT MEASURE FEEL.  Spike P §5 is the standing warning: frame
 *      cadence was perfect while the app visibly stuttered, because the defect
 *      was distance-per-frame, not frames-per-second.  A green pacing report
 *      is not "scrolling is fine"; it is "the frames arrived".  Per-frame
 *      scroll DISTANCE uniformity is not measured here and is still unmeasured
 *      anywhere (spike P §8).
 *   3. IT DOES NOT MEASURE A PANEL IT CANNOT SEE.  The refresh rate is
 *      MEASURED from the presented-frame cadence, not read from a config, and
 *      a machine whose panel is 60 Hz cannot say anything about a 120 Hz
 *      deficit.  The deficit that motivated this rewrite (spike P §1: 105.6
 *      fps on a 120 Hz panel, "unexplained") is a DEBIAN observation and only
 *      the Debian machine can close it.  `--expect-hz` exists so that machine
 *      prints the deficit directly.
 *   4. IT DOES NOT GATE THE FRAME RATE.  No contract clause does.  The pacing
 *      block is a REPORT; the only verdict is §5.12.6(d)'s handler budget.
 *
 * ===========================================================================
 * VALIDITY, AND THE ONE RULE THAT IS NOT LIFTED
 * ===========================================================================
 * CLAUDE.md §3 lifted the window etiquette on 2026-09-08 ("AUTOMATE
 * EVERYTHING"), so this harness opens a real, on-screen, 1920x964 window --
 * the same geometry G9 and G10 use -- and does not apologise for it.  v1's
 * `--geom` ceiling of 1000x700 and its focus-theft discard are both GONE, and
 * with them the reason its numbers were a documented LOWER bound (a small
 * window paints a smaller row pool).
 *
 * WHAT IS NOT LIFTED, because it is a validity rule and not an etiquette one:
 *   * A LOCKED SCREEN INVALIDATES EVERY GRAPHICS NUMBER.  Checked before
 *     anything is launched; the run reports `result=NOT-TAKEN` and exits 4.
 *   * A RUN THAT PRESENTED NO FRAMES IS DISCARDED, not reported as 0 fps.
 *   * HEADLESS IS REFUSED for the pacing arm.  `CAIRN_HEADLESS=1` renders
 *     offscreen through Electron's frame-subscription path at a fixed
 *     software cadence; it is a different pipeline and its "fps" is a property
 *     of that path, not of the app.
 *
 * ===========================================================================
 * USAGE
 * ===========================================================================
 *   node tools/scroll-bench.mjs                      Cairn, tree pane, gate window
 *   node tools/scroll-bench.mjs --pane editor        Cairn, the editor pane
 *   node tools/scroll-bench.mjs --obsidian           the LIVE Obsidian, same fixture
 *   node tools/scroll-bench.mjs --attach 9222        whatever is on that port
 *   node tools/scroll-bench.mjs --self-test          pure analysis, no app at all
 *   node tools/scroll-bench.mjs --preflight          everything except the launch
 *
 *   --pane tree|editor    which scroller (default tree)
 *   --selector CSS        override the scroller selector
 *   --nodes N             flat fixture size (default 50500 -> the 50,000 cap)
 *   --geom WxH            window (default 1920x964, the G9/G10 gate window)
 *   --speed PX_PER_S      gesture speed (default 2000)
 *   --distance PX         gesture distance (default 12000)
 *   --events N            plan-phase events (default 400; 0 skips the phase)
 *   --budget MS           §5.12.6(d) budget (default 2)
 *   --expect-hz N         the panel's refresh rate, for the deficit line
 *   --vault PATH          reuse a fixture (a directory strictly under $TMPDIR)
 *   --keep-vault          do not delete a generated fixture
 *   --trace PATH          write the raw trace events (tens of MB)
 *   --json PATH           write the full result document
 *   --no-build            do not rebuild the addon and the bundle first
 *
 * EXIT CODES:  0 PASS   1 FAIL   2 usage/environment   3 INCONCLUSIVE   4 NOT-TAKEN
 */

import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')

/**
 * THE REAL BINARY, NOT `node_modules/.bin/electron`, AND THIS IS A BUG FIX.
 *
 * That path is a Node SHIM (`electron/cli.js`) which spawns
 * `Electron.app/Contents/MacOS/Electron` as its own child.  Killing the shim
 * kills the shim: the app is reparented to launchd and keeps running, keeps
 * its window, and keeps `app.requestSingleInstanceLock()`.  Two of them were
 * leaked writing this file, and the symptom was not "a stray window" -- it was
 * that every LATER launch took the single-instance path, printed "another
 * instance already holds the lock" and exited, so the next measurement failed
 * to connect with sixty seconds of silence.  CLAUDE.md §3's "kill every
 * process you spawn, including on the error path" is exactly this hazard.
 *
 * `require('electron')` from plain node resolves to the executable path.
 */
const ELECTRON = (() => {
  try { return createRequire(import.meta.url)('electron') } catch { return path.join(REPO, 'node_modules', '.bin', 'electron') }
})()

/* ═══════════════════════════════════════════════════════════════════════════
 *  PART 1 -- THE PURE CORE.
 *
 *  Everything here is a pure function of its arguments and is unit tested by
 *  `--self-test`, which is what `npm run pretest` runs on every `npm test`.
 *  `analyseTrace` is deliberately pure over an ARRAY OF TRACE EVENTS: the
 *  self-test can then drive the whole report out of a synthetic trace, with no
 *  app, no display and no GPU -- which is the only way the analysis half of a
 *  harness like this ever gets tested at all.
 * ═══════════════════════════════════════════════════════════════════════════ */

/** Nearest-rank percentile over an ASCENDING sorted array. */
export function percentile(sorted, p) {
  if (sorted.length === 0) return NaN
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length))
  return sorted[Math.min(sorted.length, rank) - 1]
}

/** The distribution of a sample set. Never a mean alone -- see the header. */
export function distribution(samples) {
  const s = samples.slice().sort((a, b) => a - b)
  const sum = s.reduce((a, b) => a + b, 0)
  return {
    n: s.length,
    min: s.length ? s[0] : NaN,
    median: percentile(s, 50),
    p90: percentile(s, 90),
    p95: percentile(s, 95),
    p99: percentile(s, 99),
    max: s.length ? s[s.length - 1] : NaN,
    mean: s.length ? sum / s.length : NaN,
  }
}

const GRID_EPS_REL = 1e-9

/**
 * Snap a sample onto the quantum grid.  KEPT FROM v1, where it changed a real
 * run's answer: a difference of two clamped reads is a multiple of `q` by
 * construction, the subtraction of two large doubles does not know that, and
 * 9.1e-13 ms of dust turned a documented PASS into INCONCLUSIVE.  It moves
 * nothing that is not already within 1e-9 relative of a grid point.
 */
export function snapToQuantum(v, q) {
  if (!Number.isFinite(v) || !Number.isFinite(q) || q <= 0) return v
  const g = Math.round(v / q) * q
  return Math.abs(v - g) <= GRID_EPS_REL * Math.max(q, Math.abs(v)) ? g : v
}

function compareEps(q, budget) {
  return GRID_EPS_REL * Math.max(1, Math.abs(budget), Math.abs(q))
}

/**
 * The verdict, taken from quantisation-aware intervals.  KEPT FROM v1.
 *
 *   provably within budget when `observed + q <= budget`
 *   provably over budget when   `observed - q >  budget`
 *   anything else is unresolved BY THE CLOCK and is reported as that.
 *
 * FAIL needs 1% of events (and at least one) provably over: a single 9 ms
 * sample is as likely to be another process taking the core as it is to be the
 * handler, and a gate that flaps on one outlier gets switched off.
 */
export function verdictFor(samples, q, budget) {
  const n = samples.length
  if (n === 0) return { verdict: 'INCONCLUSIVE', reason: 'no scroll events were sampled', overCertain: 0, overPossible: 0 }
  let overCertain = 0
  let overPossible = 0
  const eps = compareEps(q, budget)
  let worst = -Infinity
  for (const raw of samples) {
    const dt = snapToQuantum(raw, q)
    if (dt > worst) worst = dt
    if (dt - q > budget + eps) overCertain++
    if (dt + q > budget + eps) overPossible++
  }
  const failFloor = Math.max(1, Math.ceil(0.01 * n))
  if (overCertain >= failFloor) {
    return { verdict: 'FAIL', reason: overCertain + '/' + n + ' events are provably over the ' + budget + ' ms budget', overCertain, overPossible }
  }
  if (overPossible === 0) {
    return { verdict: 'PASS', reason: 'every one of ' + n + ' events is provably within ' + budget + ' ms (worst upper bound ' + (worst + q).toFixed(3) + ' ms)', overCertain, overPossible }
  }
  if (overCertain > 0) {
    return { verdict: 'INCONCLUSIVE', reason: overCertain + '/' + n + ' events are over budget but that is below the ' + failFloor + '-event (1%) fail floor: outliers, not a budget failure', overCertain, overPossible }
  }
  return {
    verdict: 'INCONCLUSIVE',
    reason: 'the clock quantum (' + q.toFixed(3) + ' ms) cannot resolve a ' + budget + ' ms budget for ' + overPossible + '/' + n + ' events',
    overCertain,
    overPossible,
  }
}

/**
 * v1's four-phase scroll plan, byte-for-byte.  The `jump` phase is why it is
 * still here: `first > curLast || last < curFirst` repaints the WHOLE pool in
 * one event (`src/tree.ts`'s scroll listener, `:2414`), which is the worst case
 * the budget is about, and
 * a wheel gesture cannot reach it at any speed.
 *
 * INVARIANT: no two consecutive targets are equal.  Assigning the `scrollTop`
 * a scroller already has fires no `scroll` event, so a plan with a repeat
 * silently measures fewer events than it claims to.
 */
export function cairnScrollPlan(maxTop, opts) {
  var rowH = opts.rowH > 0 ? opts.rowH : 27
  var n = opts.events
  var out = []
  var seed = 12345
  function lcg() { seed = (1103515245 * seed + 12345) % 2147483648; return seed / 2147483648 }
  function push(phase, top) {
    var t = Math.round(top)
    if (t < 0) t = 0
    if (t > maxTop) t = maxTop
    var prev = out.length > 0 ? out[out.length - 1].top : -1
    if (t === prev) {
      t = t + rowH <= maxTop ? t + rowH : t - rowH
      if (t < 0 || t > maxTop || t === prev) return
    }
    out.push({ phase: phase, top: t })
  }
  var quarter = Math.max(1, Math.floor(n / 4))
  var top = 0
  for (var i = 0; i < quarter; i++) {
    top += rowH * (1 + (i % 3))
    if (top > maxTop) top = top % (maxTop > 0 ? maxTop : 1)
    push('step', top)
  }
  var d = 160
  for (var j = 0; j < quarter; j++) {
    top += d
    if (top > maxTop || top < 0) { top = Math.max(0, maxTop - top % (maxTop > 0 ? maxTop : 1)) }
    push('momentum', top)
    d = d * 0.94
    if (d < 1) d = 160
  }
  for (var k = 0; k < quarter; k++) push('jump', lcg() * maxTop)
  for (var m = 0; m < n - 3 * quarter; m++) push('ends', m % 2 === 0 ? 0 : maxTop)
  return out
}

/* ---------------------------------------------------------------------------
 *  TRACE ANALYSIS.  Pure over an array of Chromium trace events.
 *
 *  The event shapes below were READ OFF A REAL TRACE on this machine
 *  (Electron 39.8.3 / Chrome 142, macOS 26.6.2, 2026-09-09), not taken from
 *  documentation.  That matters: `PipelineReporter`'s terminal state lives on
 *  its `b` event and its `e` event carries `args: {}`, which is the opposite of
 *  what you would guess, and a reader of the `e` args alone counts zero
 *  presented frames and reports a stall.
 * ------------------------------------------------------------------------- */

/** Trace timestamps are integer microseconds.  MEASURED, not assumed. */
export function traceQuantumMs(events) {
  const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b))
  let g = 0
  let seen = 0
  for (const e of events) {
    if (typeof e.dur !== 'number' || e.dur <= 0 || !Number.isInteger(e.dur)) continue
    g = gcd(g, e.dur)
    if (++seen >= 4000 || g === 1) break
  }
  return (g > 0 ? g : 1) / 1000
}

/**
 * Async `b`/`e` pairs.  Chromium REUSES the small `id2.local` values, so an id
 * is only unique while it is open: match each `e` to the most recent open `b`
 * with the same (pid, id) and drop the pairing after use.  Keying globally
 * pairs frame 3's begin with frame 900's end and reports 40-second frames.
 */
export function pairAsync(events, name, catRe = null) {
  const open = new Map()
  const out = []
  for (const e of events) {
    if (e.name !== name || (e.ph !== 'b' && e.ph !== 'e')) continue
    if (catRe && !catRe.test(e.cat ?? '')) continue
    const k = e.pid + '/' + (e.id2?.local ?? e.id ?? '')
    if (e.ph === 'b') {
      if (!open.has(k)) open.set(k, [])
      open.get(k).push(e)
    } else {
      const q = open.get(k)
      if (q && q.length) {
        const b = q.shift()
        out.push({ begin: b, end: e, ms: (e.ts - b.ts) / 1000 })
      }
    }
  }
  return out
}

/**
 * What the COMPOSITOR presented: `viz`'s `Display::DrawAndSwap`, one per frame
 * that reached the screen.  Grouped by (pid, tid) because one viz process
 * serves every Display it hosts; a second group means a second window was open
 * and the run is not measuring what it thinks it is.
 */
export function presentedFrames(events) {
  const groups = new Map()
  for (const e of events) {
    if (e.name !== 'Display::DrawAndSwap' || e.ph !== 'X') continue
    const k = e.pid + '/' + e.tid
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(e.ts)
  }
  const all = [...groups.entries()].map(([k, ts]) => ({ surface: k, ts: ts.sort((a, b) => a - b) }))
  all.sort((a, b) => b.ts.length - a.ts.length)
  return { surfaces: all.map((s) => ({ surface: s.surface, frames: s.ts.length })), ts: all.length ? all[0].ts : [] }
}

export function intervalsMs(ts) {
  const out = []
  for (let i = 1; i < ts.length; i++) out.push((ts[i] - ts[i - 1]) / 1000)
  return out
}

/**
 * The panel period.  Chromium puts its own `vsync_interval_ms` on every
 * `EventLatency` for a scroll update, which is the browser's idea of the
 * display's period; when that is absent (no scroll in the trace) the median
 * presented-frame interval is used instead and the source says so.
 *
 * NEVER read from a config file or from `system_profiler`: a machine can be
 * driving a panel at other than its nameplate rate, and the number this report
 * needs is the one the compositor is pacing against.
 */
export function estimatePanel(events, presentedIntervals) {
  const vs = []
  for (const e of events) {
    const v = e.args?.event_latency?.vsync_interval_ms
    if (typeof v === 'number' && v > 0) vs.push(v)
  }
  if (vs.length) {
    const periodMs = percentile(vs.slice().sort((a, b) => a - b), 50)
    return { periodMs, hz: 1000 / periodMs, source: 'trace: EventLatency.vsync_interval_ms', samples: vs.length }
  }
  if (presentedIntervals.length >= 8) {
    const periodMs = percentile(presentedIntervals.slice().sort((a, b) => a - b), 50)
    return { periodMs, hz: 1000 / periodMs, source: 'inferred: median presented-frame interval', samples: presentedIntervals.length }
  }
  return { periodMs: NaN, hz: NaN, source: 'unknown', samples: 0 }
}

/**
 * Presented-frame intervals in units of the panel period, bucketed to a
 * quarter of a vblank.  A strictly vblank-locked compositor shows one spike at
 * 1.00; a deficit shows mass at 2.00 (frames taking two vblanks), NOT a
 * uniformly stretched interval -- which is the distinction between "every
 * frame is a bit late" and "one frame in seven is missed", and the two have
 * completely different causes.
 */
export function vblankHistogram(intervals, periodMs) {
  const h = new Map()
  if (!(periodMs > 0)) return []
  for (const x of intervals) {
    const k = Math.round((x / periodMs) * 4) / 4
    h.set(k, (h.get(k) || 0) + 1)
  }
  return [...h.entries()].sort((a, b) => a[0] - b[0]).map(([vb, n]) => ({ vb, n }))
}

/** cc's own per-frame verdict.  `b` carries the state; `e` carries nothing. */
export function pipelineStates(events) {
  const out = { presented: 0, dropped: 0, noUpdate: 0, other: 0, byState: {} }
  for (const e of events) {
    if (e.name !== 'PipelineReporter' || e.ph !== 'b') continue
    const s = e.args?.frame_reporter?.state ?? '(none)'
    out.byState[s] = (out.byState[s] || 0) + 1
    if (s === 'STATE_PRESENTED_ALL') out.presented++
    else if (s === 'STATE_DROPPED') out.dropped++
    else if (s === 'STATE_NO_UPDATE_DESIRED') out.noUpdate++
    else out.other++
  }
  return out
}

/** `devtools.timeline` EventDispatch, in milliseconds, split wall / thread-CPU. */
export function dispatchDurations(events, type) {
  const dur = []
  const tdur = []
  for (const e of events) {
    if (e.name !== 'EventDispatch' || e.ph !== 'X') continue
    if (e.args?.data?.type !== type) continue
    if (typeof e.dur === 'number') dur.push(e.dur / 1000)
    if (typeof e.tdur === 'number') tdur.push(e.tdur / 1000)
  }
  return { dur, tdur }
}

const PIPELINE_STAGES = [
  'BeginImplFrameToSendBeginMainFrame',
  'SendBeginMainFrameToCommit',
  'Commit',
  'EndCommitToActivation',
  'Activation',
  'EndActivateToSubmitCompositorFrame',
  'SubmitCompositorFrameToPresentationCompositorFrame',
]

/**
 * Where a frame's time went.  The last stage --
 * `SubmitCompositorFrameToPresentationCompositorFrame` -- is the display
 * pipeline's own queueing depth and is NOT work the app can shorten; the
 * stages before it are.  Reporting the total alone invites the conclusion that
 * a 40 ms frame means a 40 ms app, which on this machine it does not.
 */
export function stageDurations(events) {
  const out = {}
  for (const name of PIPELINE_STAGES) {
    const ms = pairAsync(events, name, FRAME_REPORTER_CAT).map((p) => p.ms)
    if (ms.length) out[name] = { ...distribution(ms) }
  }
  return out
}

/**
 * THE SAME STAGE NAMES ARE EMITTED TWICE PER FRAME, and reading both doubles
 * every count.  cc reports its stages once under the FRAME reporter
 * (`disabled-by-default-devtools.timeline.frame`) and again under the
 * EVENT-LATENCY reporter (`input.scrolling`) -- 363 and 362 of
 * `SendBeginMainFrameToCommit` in a 362-frame trace.  The frame reporter is
 * the one whose population is "frames", so it is the one this reads.
 */
const FRAME_REPORTER_CAT = /disabled-by-default-devtools\.timeline\.frame/

/**
 * What the renderer's main thread did inside `SendBeginMainFrameToCommit`,
 * per frame, from cc's own breakdown -- style, layout, prepaint, paint,
 * layerize, commit.  This is the part of a frame Cairn's code can actually
 * make longer or shorter, which is why it is reported apart from the total.
 *
 * `begin_main_sent_to_started_us` is DROPPED when it reads as a u64 underflow
 * (~1.8e19 µs, i.e. 584,000 years): cc emits that for a frame whose main-frame
 * start predates the send, and a single such sample would otherwise dominate
 * every statistic in the block.
 */
export function mainFrameBreakdown(events) {
  const acc = {}
  for (const e of events) {
    const b = e.args?.send_begin_mainframe_to_commit_breakdown
    if (!b || e.ph !== 'b' || !FRAME_REPORTER_CAT.test(e.cat ?? '')) continue
    for (const [k, v] of Object.entries(b)) {
      if (typeof v !== 'number' || v < 0 || v > 1e9) continue
      ;(acc[k] ||= []).push(v / 1000)
    }
  }
  const out = {}
  for (const [k, a] of Object.entries(acc)) out[k] = { ...distribution(a) }
  return out
}

/**
 * DISTANCE PER PRESENTED FRAME -- the other half of "is scrolling smooth", and
 * the half nothing in this project has ever measured.
 *
 * SPIKE P §5 IS WHY THIS EXISTS. The first Electron run visibly STUTTERED while
 * the app's own probe reported a flat 120 Hz and `our JS 0.00 ms = 0% of the
 * frame`: **frame cadence was perfect and distance-per-frame was not.** Every
 * other number in this file -- fps, dropped frames, the handler, even
 * Chromium's own jank flag -- is a statement about WHEN frames arrived. A
 * flipbook whose pages arrive exactly on time and whose drawing jumps 45 px,
 * then 12, then 40, then 8 is flawless by all of them and awful to look at.
 *
 * NOTHING IS ADDED TO THE PAGE FOR THIS. cc emits its own scroll offset --
 * `ScrollTree::SetScrollOffset`, `args.y`, ~10 times per frame -- and the
 * renderer's compositor emits `DrawFrame` once per frame it draws. Both are in
 * the RENDERER process, so no cross-process pipeline delay enters the pairing:
 * the offset a frame carried is the last one set at or before that frame's
 * `DrawFrame`. Reading `scrollTop` from a rAF callback would have measured the
 * MAIN thread's copy of a value the compositor owns, one frame late and 1.16x
 * off the compositor's own rate (spike P §2).
 *
 * LEADING AND TRAILING STATIONARY FRAMES ARE TRIMMED. A six-second trace has
 * still frames at both ends -- before the gesture starts and after it stops --
 * and they are zeros that would halve the mean and treble the spread while
 * saying nothing about the glide. What is measured is the moving part.
 *
 * The headline is `cvPct`, the coefficient of variation: the spread of
 * per-frame distances as a percentage of their mean. A perfectly even glide is
 * 0%. `unevenFrames` counts frames that moved less than half or more than
 * half again the median step, which is the shape an eye actually catches.
 */
export function scrollDistancePerFrame(events) {
  const empty = { paired: false, n: 0, cvPct: NaN, unevenFrames: 0, unevenPct: NaN,
                  step: distribution([]), outliers: { n: 0, maxPx: 0 } }
  const offsets = []
  const frames = []
  for (const e of events) {
    if (e.name === 'ScrollTree::SetScrollOffset' && typeof e.args?.y === 'number') offsets.push({ ts: e.ts, y: e.args.y })
    else if (e.name === 'DrawFrame' && e.ph === 'I') frames.push(e.ts)
  }
  if (offsets.length < 8 || frames.length < 12) return empty
  offsets.sort((a, b) => a.ts - b.ts)
  frames.sort((a, b) => a - b)
  let i = 0
  let cur = null
  const perFrame = []
  for (const t of frames) {
    while (i < offsets.length && offsets[i].ts <= t) cur = offsets[i++].y
    if (cur !== null) perFrame.push(cur)
  }
  let steps = []
  for (let k = 1; k < perFrame.length; k++) steps.push(Math.abs(perFrame[k] - perFrame[k - 1]))
  // Trim the stationary head and tail: the gesture does not span the trace.
  while (steps.length && steps[0] === 0) steps.shift()
  while (steps.length && steps[steps.length - 1] === 0) steps.pop()
  if (steps.length < 10) return empty
  /* ONE STEP CAN DESTROY BOTH STATISTICS, AND ON A REAL PAGE ONE DID.
     `ScrollTree::SetScrollOffset` does NOT name its scroll node, so every
     scroller in the page interleaves into this one sequence; a page with a
     second scroller therefore produces differences between two unrelated
     offsets. Measured on Obsidian, 2026-09-09: a single 24,000 px step (the
     whole gesture's travel) took the spread to 892% and marked 359 of 361
     frames "uneven", while its p50 and p90 steps were identical to Cairn's to
     within a pixel. So steps beyond 5x the median are EXCLUDED from the glide
     statistics and REPORTED as their own count -- excluded because they are not
     this scroller's glide, reported because pretending they did not happen is
     how an instrument lies. */
  const med0 = percentile(steps.slice().sort((a, b) => a - b), 50)
  /* BOTH CONDITIONS, and the first draft had only the ratio. At 5x the median
     an ALTERNATING 8 / 58.6 px stutter -- the exact shape this metric exists to
     catch -- has a median of 8, so every long step scored as an outlier and the
     stutter measured as a perfectly even 8 px glide. The absolute floor is what
     separates them: 500 px in one frame is 30,000 px/s, which is not a wheel
     glide by any reading, while a 7x stutter is. */
  const isOutlier = (x) => med0 > 0 && x > 20 * med0 && x > 500
  const outliers = steps.filter(isOutlier)
  if (outliers.length) steps = steps.filter((x) => !isOutlier(x))
  if (steps.length < 10) return empty
  const step = distribution(steps)
  const mean = step.mean
  const sd = Math.sqrt(steps.reduce((a, x) => a + (x - mean) * (x - mean), 0) / steps.length)

  /* THE REFERENCE IS THE MEAN, NOT THE MEDIAN, and the self-test is what found
     that out. For the exact shape this metric exists to catch -- alternating
     long and short steps -- the median IS one of the two modes, so half the
     stutter measures as "normal" against it: a 8/58.6 alternation scored 48.7%
     uneven where the honest answer is 100%. The mean sits between the modes. */
  const uneven = steps.filter((x) => Math.abs(x - mean) > 0.5 * mean).length
  return {
    paired: true,
    n: steps.length,
    step,
    sdPx: sd,
    cvPct: mean > 0 ? (100 * sd) / mean : NaN,
    unevenFrames: uneven,
    unevenPct: (100 * uneven) / steps.length,
    outliers: { n: outliers.length, maxPx: outliers.length ? Math.max(...outliers) : 0 },
    travelledPx: perFrame.length ? Math.abs(perFrame[perFrame.length - 1] - perFrame[0]) : 0,
  }
}

/**
 * BEGIN-FRAME -> SUBMIT: the part of a frame the APPLICATION controls.
 *
 * WHY THIS IS THE NUMBER THAT MATTERS FOR "COULD IT FEED A FASTER PANEL".
 * `PipelineReporter`'s total is ~40 ms on this machine and ~38 of that is
 * `SubmitCompositorFrameToPresentationCompositorFrame` -- the display's own
 * queue, which is latency and not throughput, and which no application code
 * shortens.  Reading the total as "this app needs 40 ms per frame" is the
 * arithmetic that would conclude Cairn cannot reach 25 fps while it is
 * measurably presenting 59.7.
 *
 * The difference is taken PER FRAME, not between two medians: the two
 * sequences are the same frames in the same order, so they are zipped, and
 * mismatched lengths return `paired: false` rather than a silently misaligned
 * subtraction.
 */
export function beginFrameToSubmit(events) {
  const total = pairAsync(events, 'PipelineReporter', FRAME_REPORTER_CAT)
    .filter((p) => p.begin.args?.frame_reporter?.state === 'STATE_PRESENTED_ALL')
    .map((p) => p.ms)
  const display = pairAsync(events, 'SubmitCompositorFrameToPresentationCompositorFrame', FRAME_REPORTER_CAT).map((p) => p.ms)
  if (total.length === 0 || total.length !== display.length) return { ...distribution([]), paired: false }
  return { ...distribution(total.map((t, i) => t - display[i])), paired: true }
}

/**
 * Input to glass, by event type, plus Chromium's own scroll-jank verdict.
 *
 * THE MEDIAN OF THIS IS AN UNSTABLE STATISTIC AND MUST NOT BE QUOTED ALONE.
 * Measured over five identical runs on 2026-09-09: `GESTURE_SCROLL_UPDATE`'s
 * p50 moved 8.45 -> 34.51 ms while its p90 sat at 50-57 ms and every frame
 * statistic in the same runs was identical to two decimal places.  The
 * distribution is BIMODAL -- the synthetic gesture generates ~2 input events
 * per presented frame (722 wheels over 362 frames), so roughly half of them
 * wait an extra present cycle by construction -- and a median lands on
 * whichever mode happens to carry more mass.  The histogram below, in units of
 * the panel period, is what should be read: `latencyHistogram` shows the two
 * modes and the gap between them is one vblank.
 */
export function latencyByEvent(events, periodMs = NaN) {
  const byType = {}
  for (const p of pairAsync(events, 'EventLatency')) {
    const t = p.begin.args?.event_latency?.event_type ?? '?'
    ;(byType[t] ||= []).push(p.ms)
  }
  const dists = {}
  for (const [t, a] of Object.entries(byType)) dists[t] = { ...distribution(a) }
  const hist = periodMs > 0 && byType.GESTURE_SCROLL_UPDATE
    ? vblankHistogram(byType.GESTURE_SCROLL_UPDATE, periodMs)
    : []
  let frames = 0
  let janky = 0
  for (const e of events) {
    const el = e.args?.event_latency
    if (!el || e.ph !== 'b') continue
    const j = el.scroll_jank_v4?.is_janky ?? el.is_janky_scrolled_frame
    if (typeof j === 'boolean') {
      frames++
      if (j) janky++
    }
  }
  return { byType: dists, latencyHistogram: hist,
           jank: { frames, janky, pct: frames ? (100 * janky) / frames : NaN } }
}

/** Renderer main-thread totals, largest first.  Context, never a verdict. */
export function mainThreadTotals(events, top = 10) {
  const tot = new Map()
  for (const e of events) {
    if (e.ph !== 'X' || typeof e.dur !== 'number') continue
    if (!/(^|,)devtools\.timeline($|,)/.test(e.cat ?? '')) continue
    tot.set(e.name, (tot.get(e.name) || 0) + e.dur / 1000)
  }
  return [...tot.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([name, ms]) => ({ name, ms }))
}

/**
 * THE WHOLE ANALYSIS, as a pure function of one phase's trace events.
 * `--self-test` drives it over a synthetic trace, which is the only way the
 * analysis half of a harness like this is ever tested.
 */
export function analyseTrace(events, opts = {}) {
  const quantumMs = traceQuantumMs(events)
  const pres = presentedFrames(events)
  const gaps = intervalsMs(pres.ts)
  const panel = estimatePanel(events, gaps)
  const spanMs = pres.ts.length >= 2 ? (pres.ts[pres.ts.length - 1] - pres.ts[0]) / 1000 : 0
  const fps = spanMs > 0 ? (1000 * (pres.ts.length - 1)) / spanMs : NaN
  const expectHz = opts.expectHz ?? panel.hz
  const states = pipelineStates(events)
  const scroll = dispatchDurations(events, 'scroll')
  const wheel = dispatchDurations(events, 'wheel')
  const production = pairAsync(events, 'PipelineReporter', FRAME_REPORTER_CAT)
    .filter((p) => p.begin.args?.frame_reporter?.state === 'STATE_PRESENTED_ALL')
    .map((p) => p.ms)
  return {
    quantumMs,
    events: events.length,
    panel,
    pacing: {
      surfaces: pres.surfaces,
      presentedSwaps: pres.ts.length,
      spanMs: +spanMs.toFixed(1),
      fps,
      expectHz,
      deficitPct: Number.isFinite(fps) && expectHz > 0 ? 100 * (1 - fps / expectHz) : NaN,
      histogram: vblankHistogram(gaps, panel.periodMs),
      intervalMs: distribution(gaps),
      states,
    },
    production: {
      totalMs: distribution(production),
      appMs: beginFrameToSubmit(events),
      stages: stageDurations(events),
      mainFrame: mainFrameBreakdown(events),
    },
    handler: {
      samples: scroll.dur,
      wall: distribution(scroll.dur),
      threadCpu: distribution(scroll.tdur),
      wheelWall: distribution(wheel.dur),
    },
    latency: latencyByEvent(events, panel.periodMs),
    distance: scrollDistancePerFrame(events),
    mainThread: mainThreadTotals(events),
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  PART 2 -- THE CHROME DEVTOOLS PROTOCOL CLIENT.
 *
 *  Connects to the BROWSER endpoint and attaches to the page as a flattened
 *  session, because the two domains this harness needs live at different
 *  levels: `Tracing` is browser-wide (it must see the GPU process, where
 *  `Display::DrawAndSwap` is emitted), and `Input`/`Runtime` are the page's.
 *  A page-only connection sees a trace with no compositor in it.
 * ═══════════════════════════════════════════════════════════════════════════ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function cdpConnect(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  let ver = null
  while (Date.now() < deadline) {
    try {
      ver = await (await fetch('http://127.0.0.1:' + port + '/json/version')).json()
      break
    } catch { await sleep(250) }
  }
  if (!ver) throw new Error('no DevTools endpoint on port ' + port + ' after ' + timeoutMs + ' ms')
  const ws = new WebSocket(ver.webSocketDebuggerUrl)
  await Promise.race([
    new Promise((res, rej) => {
      ws.addEventListener('open', res)
      ws.addEventListener('error', () => rej(new Error('websocket refused')))
    }),
    new Promise((_, rej) => {
      const t = setTimeout(() => rej(new Error('websocket open timed out after 15s')), 15_000)
      if (typeof t.unref === 'function') t.unref()
    }),
  ])
  let id = 0
  const pending = new Map()
  const handlers = new Set()
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
      return
    }
    for (const h of handlers) h(m)
  })
  return {
    version: ver,
    send(method, params = {}, sessionId, timeoutMs = 30_000) {
      return new Promise((res, rej) => {
        const n = ++id
        const timer = setTimeout(() => {
          if (pending.delete(n)) rej(new Error(method + ': CDP send timed out after ' + timeoutMs + ' ms'))
        }, timeoutMs)
        if (typeof timer.unref === 'function') timer.unref()
        pending.set(n, (m) => {
          clearTimeout(timer)
          if (m.error) rej(new Error(method + ': ' + m.error.message))
          else res(m.result)
        })
        try {
          ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }))
        } catch (e) {
          clearTimeout(timer)
          pending.delete(n)
          rej(e)
        }
      })
    },
    on(h) { handlers.add(h); return () => handlers.delete(h) },
    close() { try { ws.close() } catch {} },
  }
}

/**
 * The page target.  `starter.html` is Obsidian's VAULT PICKER, which is a page
 * target too and would be attached to instead of the app window -- it presents
 * as a run with no scroller.
 */
async function attachPage(cdp, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { targetInfos } = await cdp.send('Target.getTargets')
    const t = targetInfos.find((x) => x.type === 'page' && !/starter\.html/.test(x.url) && !/devtools:/.test(x.url))
    if (t) {
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true })
      return { sessionId, target: t }
    }
    await sleep(250)
  }
  throw new Error('no page target appeared')
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  PART 3 -- ENVIRONMENT, FIXTURE, LAUNCH.
 * ═══════════════════════════════════════════════════════════════════════════ */

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts })
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') }
}

/**
 * CLAUDE.md §3: a locked screen is NOT an etiquette rule.  rAF never fires,
 * every run is correctly rejected as occluded, and no graphics or memory
 * number may be reported from one.  Refusing is the correct outcome.
 */
export function screenIsLocked() {
  if (os.platform() !== 'darwin') return false
  const r = sh('ioreg', ['-n', 'Root', '-d1', '-a'])
  if (r.code !== 0) return null
  const i = r.out.indexOf('CGSSessionScreenIsLocked')
  if (i < 0) return false
  return /<true\/>/.test(r.out.slice(i, i + 200))
}

/**
 * CONTAINMENT, kept from v1 and still absolute: temp fixtures only, verified
 * under the platform temp dir and not under $HOME, /Users, /Library, /System
 * or /Applications, with symlinks resolved first -- macOS's /var is a link to
 * /private/var and a naive prefix test passes a $HOME temp dir.
 */
export function containmentCheck(p, env) {
  const real = (x) => { try { return fs.realpathSync(x) } catch { return path.resolve(x) } }
  const target = path.resolve(p)
  // An existing path is resolved WHOLE, so a link under the temp dir that
  // points outside it is judged by where it points.
  const probe = fs.existsSync(target) ? real(target) : real(path.dirname(target)) + path.sep + path.basename(target)
  const tmp = real(env.tmpdir) + path.sep
  // STRICTLY under: the temp root itself is never a fixture, and a fixture is
  // regenerated with rm -rf.
  if (!probe.startsWith(tmp) || probe.length <= tmp.length) return { ok: false, why: probe + ' is not strictly under ' + tmp }
  for (const forbidden of [env.home, '/Users', '/Library', '/System', '/Applications']) {
    if (!forbidden) continue
    const f = real(forbidden) + path.sep
    if (probe.startsWith(f)) return { ok: false, why: probe + ' is under ' + f }
  }
  return { ok: true, why: probe }
}

/**
 * The fixture vault: N flat `.md` files at the root, plus ONE long note.
 *
 * FLAT, and at N > MAX_NODES on purpose (v1's reasoning, unchanged): `scan.rs`
 * stops the walk at 50,000 nodes, so the tree receives EXACTLY the cap and
 * every one of those nodes is a VISIBLE row with no expansion state --
 * `visibleCount` is then the cap, which is the quantity §5.12.6(d) is written
 * against.  `tools/gen-vault.sh` places notes in a 4-deep folder tree, so its
 * 50,000 nodes are mostly collapsed and the visible count at startup is a few
 * dozen; reaching the cap in VISIBLE rows from it needs a flat mode it does
 * not have.
 *
 * `0000-long-note.md` sorts first in both apps' file lists, which is how the
 * editor arm opens it without depending on either app's scripting API.
 */
export function generateFlatVault(dir, count, env, longLines = 4000) {
  const c = containmentCheck(dir, env)
  if (!c.ok) throw new Error('CONTAINMENT REFUSED: ' + c.why)
  const manifest = path.join(dir, '.scroll-bench-manifest')
  const want = 'notes=' + count + ' long=' + longLines + '\n'
  if (fs.existsSync(manifest)) {
    if (fs.readFileSync(manifest, 'utf8') === want) return { dir, count, reused: true }
    fs.rmSync(dir, { recursive: true, force: true })
  }
  fs.mkdirSync(dir, { recursive: true })
  for (let i = 0; i < count; i++) {
    fs.writeFileSync(path.join(dir, 'note-' + String(i).padStart(6, '0') + '.md'),
      '# note ' + i + '\n\nscroll-bench fixture row ' + i + '.\n')
  }
  let long = 'Body line one, deliberately not a heading.\n\n'
  for (let i = 0; i < longLines; i++) long += 'Line ' + i + ' of the long fixture note, long enough to wrap or not at will.\n'
  fs.writeFileSync(path.join(dir, '0000-long-note.md'), long)
  fs.writeFileSync(manifest, want)
  return { dir, count, reused: false }
}

/** Cairn, on a debugging port, with a hermetic state directory. */
function launchCairn({ port, geom, vault, stateDir, extraArgs = [] }) {
  if (!fs.existsSync(ELECTRON)) throw new Error('no electron at ' + ELECTRON + ' -- run: npm ci')
  const child = spawn(ELECTRON, [
    path.join(REPO, 'electron-shell', 'app-main.mjs'),
    '--remote-debugging-port=' + port,
    ...extraArgs,
  ], {
    cwd: REPO,
    env: { ...process.env, CAIRN_VAULT: vault, CAIRN_STATE_DIR: stateDir, CAIRN_ELECTRON_GEOM: geom,
           CAIRN_HEADLESS: '', CAIRN_PIXELTEST: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
    // F64: its own process group, so cleanup kills exactly this child.
    detached: true,
  })
  return child
}

/**
 * The LIVE Obsidian on this machine, pointed at the same fixture, in a throw-
 * away profile.  MIRRORS tools/run-g10.sh, which established this shape:
 * `obsidian.json` lives at `<userData>/obsidian.json` and `--user-data-dir`
 * SETS userData, so it is the profile root and not a nested directory.
 * Getting that wrong lands in the vault picker with no error at all.
 */
function launchObsidian({ port, vault, profileDir, appPath }, env = { tmpdir: os.tmpdir(), home: os.homedir() }) {
  const bin = path.join(appPath, 'Contents', 'MacOS', 'Obsidian')
  if (!fs.existsSync(bin)) throw new Error('no Obsidian at ' + appPath + ' (set OBSIDIAN_APP)')
  // CONTAINMENT: `appearance.json` mutates the vault. Only generated temp
  // vaults may be touched here — a real vault needs an explicit temp copy.
  const c = containmentCheck(vault, env)
  if (!c.ok) throw new Error('CONTAINMENT REFUSED (launchObsidian): ' + c.why)
  fs.mkdirSync(profileDir, { recursive: true })
  const vid = crypto.createHash('md5').update(vault).digest('hex').slice(0, 16)
  fs.writeFileSync(path.join(profileDir, 'obsidian.json'),
    JSON.stringify({ vaults: { [vid]: { path: vault, ts: Date.now(), open: true } } }))
  const dot = path.join(vault, '.obsidian')
  fs.mkdirSync(dot, { recursive: true })
  fs.writeFileSync(path.join(dot, 'appearance.json'), '{"theme":"obsidian"}\n')
  return spawn(bin, ['--user-data-dir=' + profileDir, '--remote-debugging-port=' + port],
    // F64: its own process group, so cleanup kills exactly this child.
    { stdio: ['ignore', 'pipe', 'pipe'], detached: true })
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  PART 4 -- THE RUN.
 * ═══════════════════════════════════════════════════════════════════════════ */

/* The categories, and every one of them earns its place:
 *   viz                                  Display::DrawAndSwap -- the presented frame
 *   cc, benchmark                        PipelineReporter, EventLatency, the stages
 *   disabled-by-default-devtools.timeline.frame   the FRAME reporter's copy of the stages
 *   devtools.timeline                    EventDispatch -- the handler
 *   input, input.scrolling               EventLatency's event types and jank flags
 *   __metadata                           process names, so a surface can be attributed
 * `blink` and `gpu` are deliberately NOT enabled: they triple the trace volume
 * and nothing here reads them. */
const TRACE_CATEGORIES = [
  'viz', 'cc', 'benchmark', 'devtools.timeline',
  'disabled-by-default-devtools.timeline.frame', 'input', 'input.scrolling', '__metadata',
]

async function evaluate(cdp, sid, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sid)
  if (r.exceptionDetails) throw new Error('page: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
  return r.result?.value
}

const FACTS = (sel) => `(() => {
  const s = document.querySelector(${JSON.stringify(sel)})
  if (!s) return { ok: false, error: 'no element matches ' + ${JSON.stringify(sel)} }
  const r = s.getBoundingClientRect()
  return { ok: true, dpr: devicePixelRatio, inner: [innerWidth, innerHeight],
           visibility: document.visibilityState, hidden: document.hidden,
           rect: [r.x, r.y, r.width, r.height],
           scrollHeight: s.scrollHeight, clientHeight: s.clientHeight, scrollTop: s.scrollTop,
           // THE POOL, not the tree.  §3.3 sizes the pool from clientHeight, so
           // this is ~49 rows however many nodes the vault has -- which is the
           // whole point of the virtualiser and is NOT the quantity
           // §5.12.6(d)'s budget is written against.
           poolRows: s.querySelectorAll('.tr, .nav-file, .cm-line').length,
           rowH: parseFloat(getComputedStyle(s).getPropertyValue('--row-h')) || 0 }
})()`

/** Poll until `fn` is true, or throw naming what was waited for. */
async function until(what, fn, timeoutMs = 60000, everyMs = 250) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return true
    await sleep(everyMs)
  }
  throw new Error('timed out after ' + timeoutMs + ' ms waiting for ' + what)
}

/** Wait until the pane exists and can actually scroll. */
async function waitForScroller(cdp, sid, sel, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await evaluate(cdp, sid, FACTS(sel)).catch((e) => ({ ok: false, error: e.message }))
    if (last.ok && last.scrollHeight > last.clientHeight + 1) return last
    await sleep(250)
  }
  throw new Error('the pane never became scrollable: ' + JSON.stringify(last))
}

/** One traced phase: start tracing, run the driver, stop, collect, analyse. */
async function tracedPhase(cdp, driver, opts) {
  const events = []
  let complete = false
  const off = cdp.on((m) => {
    if (m.method === 'Tracing.dataCollected') events.push(...m.params.value)
    else if (m.method === 'Tracing.tracingComplete') complete = true
  })
  await cdp.send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { includedCategories: TRACE_CATEGORIES } })
  let driverResult
  try {
    driverResult = await driver()
  } finally {
    await sleep(400) // let the last frames reach the glass and be reported
    await cdp.send('Tracing.end').catch(() => {})
    const deadline = Date.now() + 30000
    while (!complete && Date.now() < deadline) await sleep(50)
    off()
  }
  return { driver: driverResult, events, analysis: analyseTrace(events, opts) }
}

/**
 * PHASE `gesture` -- a real, trusted wheel gesture, dispatched by the BROWSER
 * process.  This is the only phase that can produce a frame-rate number.
 */
async function driveGesture(cdp, sid, { rect, distance, speed }) {
  const x = Math.round(rect[0] + rect[2] / 2)
  const y = Math.round(rect[1] + rect[3] / 2)
  const t0 = Date.now()
  await cdp.send('Input.synthesizeScrollGesture', {
    x, y, xDistance: 0, yDistance: -distance, speed,
    gestureSourceType: 'mouse', repeatCount: 0, preventFling: true,
  }, sid)
  return { at: [x, y], distance, speed, wallMs: Date.now() - t0 }
}

/**
 * PHASE `plan` -- v1's four-phase plan, one `scrollTop` assignment per
 * animation frame.  NOT a frame-rate measurement (an assignment is not a
 * wheel); the only way to reach the whole-pool repaint the budget is about.
 */
async function drivePlan(cdp, sid, { selector, plan }) {
  const tops = JSON.stringify(plan.map((p) => p.top))
  const t0 = Date.now()
  const r = await evaluate(cdp, sid, `(async () => {
    const s = document.querySelector(${JSON.stringify(selector)})
    const tops = ${tops}
    let applied = 0
    for (const t of tops) {
      s.scrollTop = t
      applied++
      await new Promise((r) => requestAnimationFrame(r))
    }
    return { applied, last: s.scrollTop }
  })()`)
  return { ...r, planned: plan.length, wallMs: Date.now() - t0 }
}

/** Put the window at an exact size, on screen, and say whether it worked. */
async function setWindowBounds(cdp, targetId, { width, height, left = 0, top = 25 }) {
  try {
    const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId })
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left, top, width, height, windowState: 'normal' } })
    return { ok: true, asked: { left, top, width, height } }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

/** Open the long fixture note, without depending on either app's scripting API. */
async function openLongNote(cdp, sid) {
  return await evaluate(cdp, sid, `(() => {
    const name = '0000-long-note'
    // Obsidian's file explorer, then Cairn's tree row, then anything that looks
    // like a row carrying the name.
    const obs = document.querySelector('.nav-file-title[data-path="0000-long-note.md"]')
    if (obs) { obs.click(); return { via: 'obsidian .nav-file-title' } }
    const rows = [...document.querySelectorAll('.tr')]
    const row = rows.find((r) => (r.textContent || '').includes(name))
    if (row) { row.click(); return { via: 'cairn .tr', text: row.textContent } }
    return { via: null, rows: rows.length }
  })()`)
}

/**
 * Obsidian into Cairn's layout contract.  MIRRORS tools/run-g10.sh's eval, and
 * adds the one thing G10 did not need: THE WINDOW SIZE.
 *
 * G10 sets the capture size with `Emulation.setDeviceMetricsOverride`, which is
 * right for a screenshot and wrong here -- an emulated viewport is composited
 * through a different path from a real window, and this file's whole subject is
 * that path.  Obsidian ships `contextIsolation: false, nodeIntegration: true`
 * (§8.3 K6 quotes it), so its renderer can reach its own BrowserWindow and set
 * the real content size.  Which route worked is REPORTED, because a silent
 * failure here means comparing a 3.28 Mpx window against a 7.37 Mpx one and
 * calling it a comparison -- which is exactly what the first Obsidian run did.
 */
async function normaliseObsidian(cdp, sid, size) {
  const resized = await evaluate(cdp, sid, `(() => {
    const tries = [
      ['electron.remote', () => require('electron').remote.getCurrentWindow()],
      ['@electron/remote', () => require('@electron/remote').getCurrentWindow()],
      ['window.electron', () => window.electron.remote.getCurrentWindow()],
    ]
    for (const [name, get] of tries) {
      try {
        const w = get()
        w.setContentSize(${size[0]}, ${size[1]})
        return { via: name }
      } catch (e) { /* next */ }
    }
    return { via: null }
  })()`).catch((e) => ({ via: null, error: e.message }))
  await sleep(1200)
  const rest = await evaluate(cdp, sid, `(async () => {
    app.vault.setConfig('readableLineLength', false)
    app.vault.setConfig('showRibbon', false)
    app.workspace.leftSplit.setSize(412)
    const s = document.createElement('style')
    s.textContent = '.nav-header{display:none!important}'
    document.head.appendChild(s)
    await new Promise((r) => setTimeout(r, 900))
    return { ribbon: document.querySelector('.workspace-ribbon')?.offsetWidth ?? 0,
             sidebar: app.workspace.leftSplit.containerEl.offsetWidth,
             inner: [innerWidth, innerHeight] }
  })()`)
  return { ...rest, resized }
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  PART 5 -- THE REPORT.
 * ═══════════════════════════════════════════════════════════════════════════ */

const f3 = (x) => (Number.isFinite(x) ? x.toFixed(3) : 'n/a')
const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : 'n/a')
const dline = (d) => (d && d.n ? `n=${d.n}  p50 ${f3(d.median)}  p90 ${f3(d.p90)}  p99 ${f3(d.p99)}  max ${f3(d.max)}` : 'n=0')

function renderPhase(name, phase, out) {
  const a = phase.analysis
  out.push('')
  out.push('-- phase ' + name + ': ' + phase.what + ' --')
  if (phase.pacing !== false) {
    const p = a.pacing
    out.push('presented   ' + p.presentedSwaps + ' frames in ' + p.spanMs + ' ms = ' + f2(p.fps) + ' fps' +
      (Number.isFinite(p.deficitPct) ? '   (' + f2(100 - p.deficitPct) + '% of the panel, deficit ' + f2(p.deficitPct) + '%)' : ''))
    out.push('frames      presented ' + p.states.presented + '   dropped ' + p.states.dropped +
      '   no-update-desired ' + p.states.noUpdate + (p.states.other ? '   other ' + p.states.other : ''))
    out.push('cadence     ' + dline(p.intervalMs) + '  (ms between presented frames)')
    if (p.histogram.length) {
      out.push('            ' + p.histogram.map((h) => h.vb.toFixed(2) + 'vb x' + h.n).join('   '))
    }
    if (p.surfaces.length > 1) {
      out.push('            WARNING: ' + p.surfaces.length + ' display surfaces in this trace ' +
        '(' + p.surfaces.map((s) => s.surface + ':' + s.frames).join(', ') + ') -- another window was open')
    }
    const j = a.latency.jank
    if (j.frames) out.push('jank        ' + j.janky + ' of ' + j.frames + ' scroll updates janky by Chromium\'s own metric (' + f2(j.pct) + '%)')
    const D = a.distance
    if (D.paired) {
      out.push('distance    per presented frame ' + dline(D.step) + ' px, over ' + Math.round(D.travelledPx) + ' px travelled')
      out.push('            spread ' + f3(D.sdPx) + ' px = ' + f2(D.cvPct) + '% of the mean;  ' +
        D.unevenFrames + ' of ' + D.n + ' frames (' + f2(D.unevenPct) + '%) moved more than half a step from the mean')
      if (D.outliers.n) {
        out.push('            ' + D.outliers.n + ' step(s) beyond 20x the median (largest ' + Math.round(D.outliers.maxPx) +
          ' px) EXCLUDED: cc does not name the scroll node, so another scroller in')
        out.push('            the page interleaves into the same offset sequence')
      }
      out.push('            (this is the half of "smooth" that cadence cannot see -- spike P §5)')
    } else if (a.pacing.presentedSwaps > 30) {
      out.push('distance    NOT MEASURED: cc emitted no ScrollTree::SetScrollOffset for this pane')
    }
    const prod = a.production
    out.push('production  per presented frame ' + dline(prod.totalMs) + ' ms, of which')
    const stage = (k, label) => {
      const d = prod.stages[k]
      if (d) out.push('              ' + label.padEnd(46) + dline(d))
    }
    stage('SendBeginMainFrameToCommit', 'main-frame work (style/layout/paint/layerize)')
    stage('EndCommitToActivation', 'commit -> activation (raster wait)')
    stage('SubmitCompositorFrameToPresentationCompositorFrame', 'submit -> presented (display queue, not the app)')
    if (prod.appMs?.paired) {
      out.push('              ' + 'begin-frame -> submit (THE PART THE APP CONTROLS)'.padEnd(46) + dline(prod.appMs))
      if (a.panel.periodMs > 0) {
        out.push('              a frame\'s budget is ' + f3(a.panel.periodMs) + ' ms at ' + f2(a.panel.hz) +
          ' Hz, and 8.333 ms at 120 Hz')
      }
    }
    const mf = prod.mainFrame
    const parts = ['style_update_us', 'layout_update_us', 'prepaint_us', 'paint_us', 'update_layers_us', 'composite_commit_us']
      .filter((k) => mf[k]).map((k) => k.replace(/_us$/, '') + ' ' + f3(mf[k].median))
    if (parts.length) out.push('              main-frame p50 breakdown (ms): ' + parts.join(', '))
    for (const [t, d] of Object.entries(a.latency.byType)) {
      if (d.n < 5) continue
      out.push('latency     ' + t.padEnd(28) + dline(d) + '  (input -> presented)')
    }
    if (a.latency.latencyHistogram.length) {
      // The median above is unstable by construction -- see latencyByEvent().
      // This is the shape, in panel periods, and it is what to read.
      out.push('            scroll-update latency in vblanks: ' +
        a.latency.latencyHistogram.filter((h) => h.n > 2).map((h) => h.vb.toFixed(2) + 'vb x' + h.n).join('   '))
    }
  } else {
    out.push('            (no frame-rate number: a scrollTop assignment is not a wheel, and the')
    out.push('             cadence would be the harness\'s own -- see the header)')
  }
  out.push('handler     scroll EventDispatch, wall  ' + dline(a.handler.wall) + ' ms')
  out.push('            scroll EventDispatch, cpu   ' + dline(a.handler.threadCpu) + ' ms')
  if (phase.driver) out.push('driver      ' + JSON.stringify(phase.driver))
}

export function renderReport(doc) {
  const out = []
  out.push('== scroll-bench ==  subject=' + doc.subject.kind + '  pane=' + doc.pane.name + '  ' + doc.when)
  out.push('host        ' + doc.host.platform + ' ' + doc.host.arch + ' ' + doc.host.release +
    ', node ' + doc.host.node + (doc.host.electron ? ', electron ' + doc.host.electron : ''))
  out.push('window      ' + doc.window.inner.join('x') + ' css, dpr ' + doc.window.dpr + ' -> ' +
    doc.window.devicePx.join('x') + ' device px (' + f2(doc.window.mpx) + ' Mpx)')
  if (doc.fixture) {
    out.push('fixture     ' + doc.fixture.notes + ' notes' + (doc.fixture.reused ? ' (reused)' : '') +
      ' -> ' + (doc.pane.virtualRows ?? '?') + ' rows in the tree, ' + doc.pane.poolRows +
      ' in the pool, scrollHeight ' + doc.pane.scrollHeight)
  }
  out.push('pane        ' + doc.pane.selector + '  ' + doc.pane.rect.map((x) => Math.round(x)).join(',') +
    '  client ' + doc.pane.clientHeight)
  const P = doc.panel
  out.push('panel       ' + f2(P.hz) + ' Hz (' + f3(P.periodMs) + ' ms)  [' + P.source + ']')
  for (const [name, phase] of Object.entries(doc.phases)) renderPhase(name, phase, out)
  out.push('')
  out.push(doc.gate.verdict === 'REPORT'
    ? '-- handler cost, UNGATED: ' + doc.gate.at + ' --'
    : '-- gate ' + doc.gate.clause + ': <= ' + doc.gate.budgetMs + ' ms per scroll event at the ' + doc.gate.at + ' --')
  out.push(doc.gate.verdict + '  ' + doc.gate.reason)
  out.push('      over both phases: ' + dline(doc.gate.dist) + ' ms;  clock quantum ' + f3(doc.gate.quantumMs) + ' ms')
  if (doc.validity.notes.length) {
    out.push('')
    out.push('-- validity --')
    for (const n of doc.validity.notes) out.push('  ' + n)
  }
  return out.join('\n')
}

export function summaryLine(doc) {
  const g = doc.phases.gesture?.analysis?.pacing
  const bits = [
    'SCROLL-BENCH result=' + doc.result,
    'subject=' + doc.subject.kind,
    'pane=' + doc.pane.name,
    ...(doc.pane.virtualRows === null ? [] : ['rows=' + doc.pane.virtualRows]),
    'pool=' + doc.pane.poolRows,
    'window=' + doc.window.inner.join('x') + '@' + doc.window.dpr,
  ]
  if (g) {
    bits.push('fps=' + f2(g.fps) + '/' + f2(doc.panel.hz))
    bits.push('deficit=' + f2(g.deficitPct) + '%')
    bits.push('dropped=' + g.states.dropped)
  }
  const D = doc.phases.gesture?.analysis?.distance
  if (D?.paired) {
    bits.push('step_cv=' + f2(D.cvPct) + '%')
    bits.push('uneven_frames=' + f2(D.unevenPct) + '%')
  }
  bits.push('handler_p99=' + f3(doc.gate.dist.p99) + 'ms')
  bits.push('handler_max=' + f3(doc.gate.dist.max) + 'ms')
  bits.push('budget=' + doc.gate.budgetMs + 'ms')
  const lat = doc.phases.gesture?.analysis?.latency?.byType?.GESTURE_SCROLL_UPDATE
  if (lat && lat.n) bits.push('input_to_glass_p50=' + f2(lat.median) + 'ms')
  return bits.join(' ')
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  PART 6 -- THE SELF-TEST.
 *
 *  `npm run pretest` runs this on every `npm test`.  It needs no display, no
 *  GPU and no app: `analyseTrace` is pure over an array of trace events, so a
 *  SYNTHETIC trace drives the whole analysis.  That is the point of the shape
 *  -- v1's analysis was tested and v1's parsing was not, because there was
 *  nothing to parse until an app had run.
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * A synthetic trace with the shapes this file reads, INCLUDING the two that
 * caught real defects: `id2.local` is reused across frames (Chromium reuses
 * the small ids, and pairing globally reports 40-second frames), and every
 * stage is emitted TWICE -- once in the frame reporter's category and once in
 * the event-latency reporter's -- which doubles every count if unfiltered.
 */
export function fakeTrace({ frames = 60, periodUs = 16666, dropAt = [], handlerUs = 100, mainFrameUs = 1500, displayUs = 3000, jankyAt = [] } = {}) {
  const ev = []
  const t0 = 1000000
  ev.push({ name: 'process_name', ph: 'M', pid: 1, tid: 1, cat: '__metadata', args: { name: 'Renderer' } })
  for (let i = 0; i < frames; i++) {
    const ts = t0 + i * periodUs
    const dropped = dropAt.includes(i)
    const id = { local: '0x' + ((i % 3) + 1) } // REUSED on purpose
    ev.push({ name: 'PipelineReporter', ph: 'b', pid: 1, tid: 9, ts,
      cat: 'cc,benchmark,disabled-by-default-devtools.timeline.frame', id2: id,
      args: { frame_reporter: { state: dropped ? 'STATE_DROPPED' : 'STATE_PRESENTED_ALL' } } })
    ev.push({ name: 'PipelineReporter', ph: 'e', pid: 1, tid: 9, ts: ts + 4000,
      cat: 'cc,benchmark,disabled-by-default-devtools.timeline.frame', id2: id, args: {} })
    for (const cat of ['cc,benchmark,disabled-by-default-devtools.timeline.frame', 'cc,benchmark,input,input.scrolling']) {
      ev.push({ name: 'SendBeginMainFrameToCommit', ph: 'b', pid: 1, tid: 9, ts, cat, id2: id,
        args: { send_begin_mainframe_to_commit_breakdown: {
          style_update_us: 200, layout_update_us: 300, paint_us: 150, prepaint_us: 90,
          update_layers_us: 10, composite_commit_us: 180,
          begin_main_sent_to_started_us: i === 0 ? 18446743981541933000 : 40 } } })
      ev.push({ name: 'SendBeginMainFrameToCommit', ph: 'e', pid: 1, tid: 9, ts: ts + mainFrameUs, cat, id2: id, args: {} })
      // The display queue, so `beginFrameToSubmit` has both halves to zip.
      if (!dropped) {
        ev.push({ name: 'SubmitCompositorFrameToPresentationCompositorFrame', ph: 'b', pid: 1, tid: 9, ts: ts + 1000, cat, id2: id, args: {} })
        ev.push({ name: 'SubmitCompositorFrameToPresentationCompositorFrame', ph: 'e', pid: 1, tid: 9, ts: ts + 1000 + displayUs, cat, id2: id, args: {} })
      }
    }
    if (!dropped) {
      ev.push({ name: 'Display::DrawAndSwap', ph: 'X', pid: 2, tid: 7, ts: ts + 3000, dur: 60, cat: 'viz', args: {} })
      ev.push({ name: 'EventDispatch', ph: 'X', pid: 1, tid: 8, ts: ts + 500, dur: handlerUs,
        tdur: handlerUs - 3, cat: 'devtools.timeline', args: { data: { type: 'scroll' } } })
      const lid = { local: '0x' + (100 + (i % 5)) }
      ev.push({ name: 'EventLatency', ph: 'b', pid: 1, tid: 9, ts, cat: 'cc,benchmark,input,input.scrolling', id2: lid,
        args: { event_latency: { event_type: 'GESTURE_SCROLL_UPDATE', vsync_interval_ms: periodUs / 1000,
                                 is_janky_scrolled_frame: jankyAt.includes(i) } } })
      ev.push({ name: 'EventLatency', ph: 'e', pid: 1, tid: 9, ts: ts + 30000, cat: 'cc,benchmark,input,input.scrolling', id2: lid, args: {} })
    }
  }
  return ev
}

async function selfTest() {
  let pass = 0
  const fails = []
  const check = (name, cond, detail) => { if (cond) pass++; else fails.push(name + (detail ? ' — ' + detail : '')) }
  const near = (a, b, eps) => Math.abs(a - b) <= eps

  // --- the plan, kept from v1 ----------------------------------------------
  const maxTop = 50000 * 27 - 521
  const plan = cairnScrollPlan(maxTop, { rowH: 27, events: 520 })
  check('plan: about the requested number of events', plan.length >= 500 && plan.length <= 520, 'got ' + plan.length)
  check('plan: every target inside [0, maxTop]', plan.every((p) => p.top >= 0 && p.top <= maxTop))
  check('plan: every target an integer', plan.every((p) => Number.isInteger(p.top)))
  let dup = -1
  for (let i = 1; i < plan.length; i++) if (plan[i].top === plan[i - 1].top) { dup = i; break }
  check('plan: NO consecutive duplicates (a repeat fires no scroll event)', dup === -1, 'index ' + dup)
  for (const ph of ['step', 'momentum', 'jump', 'ends']) check('plan: phase ' + ph + ' present', plan.some((p) => p.phase === ph))
  check('plan: survives a barely-scrollable scroller', cairnScrollPlan(27, { rowH: 27, events: 40 }).every((p) => p.top >= 0 && p.top <= 27))

  // --- distribution and verdict, kept from v1 ------------------------------
  const d = distribution([5, 1, 3, 2, 4])
  check('distribution: median', d.median === 3)
  check('distribution: max', d.max === 5)
  check('distribution: mean', d.mean === 3)
  const hundred = Array.from({ length: 100 }, (_, i) => i + 1)
  check('distribution: p95 nearest-rank', distribution(hundred).p95 === 95)
  check('distribution: p99 nearest-rank', distribution(hundred).p99 === 99)
  check('distribution: empty is not a crash', Number.isNaN(distribution([]).median))
  const allZero = new Array(400).fill(0)
  check('verdict: 400 zero samples on a 1 ms clock PASS', verdictFor(allZero, 1, 2).verdict === 'PASS')
  check('verdict: 400 samples of 2 ms on a 1 ms clock are INCONCLUSIVE, not PASS', verdictFor(new Array(400).fill(2), 1, 2).verdict === 'INCONCLUSIVE')
  check('verdict: 400 samples of 5 ms FAIL', verdictFor(new Array(400).fill(5), 1, 2).verdict === 'FAIL')
  const oneOutlier = allZero.slice(); oneOutlier[7] = 9
  check('verdict: ONE 9 ms outlier in 400 is INCONCLUSIVE, not FAIL', verdictFor(oneOutlier, 0.001, 2).verdict === 'INCONCLUSIVE')
  const manyOut = allZero.slice(); for (let i = 0; i < 8; i++) manyOut[i] = 9
  check('verdict: 8 over-budget events in 400 (>=1%) FAIL', verdictFor(manyOut, 0.001, 2).verdict === 'FAIL')
  check('verdict: no samples is INCONCLUSIVE', verdictFor([], 1, 2).verdict === 'INCONCLUSIVE')
  check('snapToQuantum: dust on the grid is removed', snapToQuantum(1 + 9.1e-13, 1) === 1)
  check('snapToQuantum: a real 1.5 on a 1 ms grid is left alone', snapToQuantum(1.5, 1) === 1.5)

  // --- the trace clock ------------------------------------------------------
  check('quantum: integer-microsecond durations read as 0.001 ms', traceQuantumMs(fakeTrace({ frames: 20, handlerUs: 101 })) === 0.001)
  const coarse = fakeTrace({ frames: 20, handlerUs: 100 }).map((e) => (e.dur ? { ...e, dur: Math.round(e.dur / 100) * 100 } : e))
  check('quantum: a clock clamped to 100 µs is DETECTED as 0.1 ms', traceQuantumMs(coarse) === 0.1, String(traceQuantumMs(coarse)))

  // --- the analysis, over a synthetic trace ---------------------------------
  const ev = fakeTrace({ frames: 120, periodUs: 16666, dropAt: [10, 40], handlerUs: 250, jankyAt: [11] })
  const a = analyseTrace(ev)
  check('analyse: the panel comes from the trace, not from a config', a.panel.source.includes('vsync_interval_ms'))
  check('analyse: 60 Hz panel is read as 60 Hz', near(a.panel.hz, 60, 0.02), String(a.panel.hz))
  check('analyse: presented frames counted from the compositor', a.pacing.presentedSwaps === 118, String(a.pacing.presentedSwaps))
  check('analyse: dropped frames counted from cc', a.pacing.states.dropped === 2, JSON.stringify(a.pacing.states))
  check('analyse: fps is the presented rate', near(a.pacing.fps, 59, 1.5), String(a.pacing.fps))
  check('analyse: the vblank histogram spikes at one vblank', a.pacing.histogram.some((h) => h.vb === 1 && h.n > 100), JSON.stringify(a.pacing.histogram))
  check('analyse: a dropped frame shows as a 2-vblank gap', a.pacing.histogram.some((h) => h.vb === 2), JSON.stringify(a.pacing.histogram))
  check('analyse: handler wall duration', near(a.handler.wall.median, 0.25, 1e-9), String(a.handler.wall.median))
  check('analyse: handler cpu duration is reported apart from wall', near(a.handler.threadCpu.median, 0.247, 1e-9), String(a.handler.threadCpu.median))
  check('analyse: jank is Chromium\'s own verdict', a.latency.jank.janky === 1 && a.latency.jank.frames === 118, JSON.stringify(a.latency.jank))
  check('analyse: input-to-glass latency is paired', near(a.latency.byType.GESTURE_SCROLL_UPDATE.median, 30, 1e-9), JSON.stringify(a.latency.byType))
  {
    // A UNIFORM glide and a STUTTERING one, with identical frame cadence: the
    // whole point of this metric is that everything else scores them the same.
    const withScroll = (steps) => {
      const ev = fakeTrace({ frames: steps.length + 1 })
      let y = 0
      const t0 = 1000000
      ev.push({ name: 'DrawFrame', ph: 'I', pid: 1, tid: 9, ts: t0 - 1, cat: 'disabled-by-default-devtools.timeline.frame', args: {} })
      steps.forEach((d, k) => {
        const ts = t0 + k * 16666
        y += d
        ev.push({ name: 'ScrollTree::SetScrollOffset', ph: 'I', pid: 1, tid: 9, ts: ts + 100, cat: 'cc', args: { x: 0, y } })
        ev.push({ name: 'DrawFrame', ph: 'I', pid: 1, tid: 9, ts: ts + 200, cat: 'disabled-by-default-devtools.timeline.frame', args: {} })
      })
      return ev
    }
    const even = scrollDistancePerFrame(withScroll(new Array(40).fill(33.3)))
    check('distance: a perfectly even glide is 0% spread', even.paired && near(even.cvPct, 0, 1e-6), JSON.stringify(even))
    check('distance: an even glide has no uneven frames', even.unevenFrames === 0)
    const jerky = scrollDistancePerFrame(withScroll(Array.from({ length: 40 }, (_, k) => (k % 2 ? 8 : 58.6))))
    check('distance: a stuttering glide with the SAME cadence is caught', jerky.cvPct > 50, JSON.stringify(jerky))
    check('distance: and its uneven frames are counted', jerky.unevenPct === 100, String(jerky.unevenPct))
    check('distance: both cover the same ground, so the mean cannot tell them apart',
      near(even.step.mean, jerky.step.mean, 1), even.step.mean + ' vs ' + jerky.step.mean)
    const withJump = withScroll([...new Array(20).fill(33.3), 24000, ...new Array(20).fill(33.3)])
    const jumped = scrollDistancePerFrame(withJump)
    check('distance: a single huge step is EXCLUDED from the glide and reported',
      jumped.outliers.n === 1 && jumped.outliers.maxPx > 20000 && jumped.cvPct < 1,
      JSON.stringify({ o: jumped.outliers, cv: jumped.cvPct }))
    check('distance: a trace with no scroll offsets reports itself unpaired, not zero',
      scrollDistancePerFrame(fakeTrace({ frames: 40 })).paired === false)
  }

  check('analyse: begin-frame -> submit excludes the display queue, per frame',
    near(a.production.appMs.median, 1, 1e-9) && a.production.appMs.paired,
    JSON.stringify(a.production.appMs))
  check('analyse: an unpairable begin-frame -> submit reports itself as unpaired rather than misaligning',
    beginFrameToSubmit(fakeTrace({ frames: 5 }).filter((e) => e.name !== 'SubmitCompositorFrameToPresentationCompositorFrame')).paired === false)
  check('analyse: the latency histogram is in vblanks, so a bimodal shape is visible',
    a.latency.latencyHistogram.some((h) => near(h.vb, 1.75, 0.26) || near(h.vb, 1.8, 0.3)),
    JSON.stringify(a.latency.latencyHistogram))
  // The two defects the shapes above exist to catch:
  check('analyse: REUSED async ids do not cross-pair (frame production stays 4 ms)',
    near(a.production.totalMs.median, 4, 1e-9), String(a.production.totalMs.median))
  check('analyse: stages are read from the FRAME reporter only, not counted twice',
    a.production.stages.SendBeginMainFrameToCommit.n === 120, String(a.production.stages.SendBeginMainFrameToCommit?.n))
  check('analyse: the u64-underflow breakdown sample is dropped',
    a.production.mainFrame.begin_main_sent_to_started_us.n === 119 &&
    a.production.mainFrame.begin_main_sent_to_started_us.max < 1,
    JSON.stringify(a.production.mainFrame.begin_main_sent_to_started_us))
  check('analyse: main-frame breakdown is in milliseconds', near(a.production.mainFrame.layout_update_us.median, 0.3, 1e-9))
  check('analyse: an empty trace is not a crash', analyseTrace([]).pacing.presentedSwaps === 0)

  // --- a trace with a real deficit -----------------------------------------
  const half = fakeTrace({ frames: 120, periodUs: 16666 })
    .filter((e) => !(e.name === 'Display::DrawAndSwap' && Math.round((e.ts - 1003000) / 16666) % 2 === 1))
  const ah = analyseTrace(half)
  check('analyse: half the frames presented reads as ~50% deficit', near(ah.pacing.deficitPct, 50, 3), String(ah.pacing.deficitPct))
  check('analyse: a 13% deficit is expressible against --expect-hz',
    near(analyseTrace(fakeTrace({ frames: 120, periodUs: 8333 }), { expectHz: 120 }).pacing.deficitPct, 0, 1),
    String(analyseTrace(fakeTrace({ frames: 120, periodUs: 8333 }), { expectHz: 120 }).pacing.deficitPct))

  // --- two surfaces are REPORTED, not silently merged ------------------------
  const two = [...fakeTrace({ frames: 30 }), ...fakeTrace({ frames: 5 }).map((e) => ({ ...e, pid: 99, tid: 99 }))]
  check('analyse: a second display surface is reported', analyseTrace(two).pacing.surfaces.length === 2,
    JSON.stringify(analyseTrace(two).pacing.surfaces))

  // --- containment ---------------------------------------------------------
  const env = { tmpdir: os.tmpdir(), home: os.homedir() }
  check('containment: a path under $TMPDIR is allowed', containmentCheck(path.join(os.tmpdir(), 'cairn-x'), env).ok)
  check('containment: $HOME is refused', !containmentCheck(path.join(os.homedir(), 'cairn-x'), env).ok)
  check('containment: /Applications is refused', !containmentCheck('/Applications/cairn-x', env).ok)
  // F64: cleanup kills only the child it spawned, by process group — a
  // `pkill -f` here would SIGTERM whoever the user attached to.
  const ownSource = fs.readFileSync(new URL(import.meta.url), 'utf8')
  const codeLines = ownSource.replace(/\/\/.*$/gm, '')
  check('cleanup: nothing invokes pkill',
    !/\b['"]pkill['"]/.test(codeLines),
    'a pkill invocation survives')
  check('launch: spawned children are detached (their own process group)',
    (codeLines.match(/detached:\s*true/g) ?? []).length >= 2)
  check('cleanup: the child dies by process group, not by name',
    codeLines.includes('process.kill(-child.pid'))
  // The temp root is not a fixture: regenerating one there would rm -rf it.
  // A private root stands in for it, so nothing real is ever at risk here.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-root.'))
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-outside.'))
  try {
    const renv = { tmpdir: root, home: os.homedir() }
    check('containment: the temp root itself is refused', !containmentCheck(root, renv).ok)
    check('containment: the temp root with a trailing separator is refused', !containmentCheck(root + path.sep, renv).ok)
    check('containment: the temp root spelled as root/. is refused', !containmentCheck(root + path.sep + '.', renv).ok)
    check('containment: a child of the temp root is still allowed', containmentCheck(path.join(root, 'cairn-x'), renv).ok)
    fs.symlinkSync(outside, path.join(root, 'link'))
    check('containment: a link under the temp root that points outside it is refused',
      !containmentCheck(path.join(root, 'link'), renv).ok)
    fs.writeFileSync(path.join(root, 'unrelated'), 'not a fixture')
    let refused = false
    try { generateFlatVault(root, 3, renv, 5) } catch (e) { refused = /CONTAINMENT REFUSED/.test(e.message) }
    check('generate: the temp root is refused before anything is written or deleted',
      refused && fs.existsSync(path.join(root, 'unrelated')) && !fs.existsSync(path.join(root, '.scroll-bench-manifest')))
    const fx = path.join(root, 'fx')
    generateFlatVault(fx, 3, renv, 5)
    const again = generateFlatVault(fx, 4, renv, 5)
    check('generate: a fixture under the root regenerates at a new size, and its neighbour survives',
      !again.reused && fs.readdirSync(fx).filter((f) => f.startsWith('note-')).length === 4 &&
      fs.existsSync(path.join(root, 'unrelated')))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  }

  process.stdout.write('scroll-bench --self-test: ' + pass + ' passed, ' + fails.length + ' failed\n')
  for (const x of fails) process.stdout.write('  FAIL  ' + x + '\n')
  return fails.length === 0
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  PART 7 -- MAIN.
 * ═══════════════════════════════════════════════════════════════════════════ */

const PANES = {
  tree: { selector: '.tree-scroller', rowH: 27 },
  editor: { selector: '.cm-scroller', rowH: 24 },
}

function parseArgs(argv) {
  const o = {
    pane: 'tree', selector: null, nodes: 50500, geom: '1920x964', speed: 2000, distance: 12000,
    events: 400, budget: 2, expectHz: null, vault: null, keepVault: false, trace: null, json: null,
    build: true, port: 9757, obsidian: false, attach: null, preflight: false, selfTest: false, help: false,
    longLines: 4000,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    switch (a) {
      case '--pane': o.pane = argv[++i]; break
      case '--selector': o.selector = argv[++i]; break
      case '--nodes': o.nodes = Number(argv[++i]); break
      case '--geom': o.geom = argv[++i]; break
      case '--speed': o.speed = Number(argv[++i]); break
      case '--distance': o.distance = Number(argv[++i]); break
      case '--events': o.events = Number(argv[++i]); break
      case '--budget': o.budget = Number(argv[++i]); break
      case '--expect-hz': o.expectHz = Number(argv[++i]); break
      case '--vault': o.vault = argv[++i]; break
      case '--keep-vault': o.keepVault = true; break
      case '--trace': o.trace = argv[++i]; break
      case '--json': o.json = argv[++i]; break
      case '--port': o.port = Number(argv[++i]); break
      case '--obsidian': o.obsidian = true; break
      case '--attach': o.attach = Number(argv[++i]); break
      case '--no-build': o.build = false; break
      case '--preflight': o.preflight = true; break
      case '--self-test': o.selfTest = true; break
      case '-h': case '--help': o.help = true; break
      default: throw new Error('unknown flag ' + a)
    }
  }
  if (!PANES[o.pane]) throw new Error('--pane must be tree or editor')
  if (!/^\d+x\d+$/.test(o.geom)) throw new Error('--geom must be WxH')
  return o
}

const log = (s) => process.stdout.write(s + '\n')

async function main() {
  let o
  try { o = parseArgs(process.argv.slice(2)) } catch (e) { log(e.message); process.exit(2) }
  if (o.help) {
    process.stdout.write(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0] + '*/\n')
    process.exit(0)
  }
  if (o.selfTest) process.exit((await selfTest()) ? 0 : 1)

  const env = { tmpdir: os.tmpdir(), home: os.homedir() }
  const notes = []
  const locked = screenIsLocked()
  log('screen locked: ' + (locked === null ? 'unknown' : locked))
  if (locked === true) {
    log('')
    log('NOT-TAKEN: the screen is locked.  Every frame is occluded, rAF does not fire, and no')
    log('           graphics number from this machine would mean anything.  CLAUDE.md §3 keeps')
    log('           this rule after the etiquette rules were lifted, because it is a validity')
    log('           rule and not an etiquette one.')
    log('SCROLL-BENCH result=NOT-TAKEN reason=screen-locked')
    process.exit(4)
  }
  if (locked === null) notes.push('the lock state could not be read; if the screen was locked, discard this run')

  const kind = o.attach ? 'attach' : o.obsidian ? 'obsidian' : 'cairn'
  const [gw, gh] = o.geom.split('x').map(Number)
  const pane = { name: o.pane, selector: o.selector ?? PANES[o.pane].selector }

  // ---- build, so nobody measures yesterday's code with today's probe -------
  if (kind === 'cairn' && o.build) {
    for (const step of ['build-native.mjs', 'build-app.mjs']) {
      log('== ' + step + ' ==')
      const r = sh(process.execPath, [path.join(REPO, 'electron-shell', step)], { cwd: REPO })
      const line = r.out.split('\n').find((l) => l.includes('result=')) ?? r.out.trim().split('\n').pop()
      log('   ' + (line ?? '').trim())
      if (r.code !== 0) { log('   build failed'); process.exit(2) }
    }
  }

  // ---- the fixture ---------------------------------------------------------
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-scrollbench.'))
  let fixture = null
  let generatedVault = null
  if (kind !== 'attach') {
    const vaultDir = o.vault ?? path.join(os.tmpdir(), 'cairn-scrollbench-vault-' + o.nodes)
    const c = containmentCheck(vaultDir, env)
    if (!c.ok) { log('CONTAINMENT REFUSED: ' + c.why); process.exit(2) }
    log('fixture vault: ' + vaultDir + ' (' + o.nodes + ' flat notes; the walk caps at 50,000)')
    fixture = generateFlatVault(vaultDir, o.nodes, env, o.longLines)
    if (!o.vault && !fixture.reused) generatedVault = vaultDir
    log('   ' + (fixture.reused ? 'reused' : 'generated'))
  }

  if (o.preflight) {
    log('')
    log('preflight only: nothing was launched.')
    log('  electron   ' + (fs.existsSync(ELECTRON) ? ELECTRON : 'MISSING -- run npm ci'))
    log('  addon      ' + (fs.existsSync(path.join(REPO, 'electron-shell', 'cairn.node')) ? 'present' : 'MISSING'))
    log('  pane       ' + pane.name + ' -> ' + pane.selector)
    log('  window     ' + o.geom)
    log('SCROLL-BENCH result=PREFLIGHT')
    fs.rmSync(work, { recursive: true, force: true })
    process.exit(0)
  }

  // ---- launch --------------------------------------------------------------
  let child = null
  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    // F64: kill ONLY the process this run spawned, by process group — never
    // `pkill -f`, which in `--attach` mode SIGTERMs the very app the user
    // attached to, and with two default runs kills the other run's app.
    if (child && child.pid !== undefined) {
      try { process.kill(-child.pid, 'SIGKILL') } catch {}
      try { child.kill('SIGKILL') } catch {}
    }
    fs.rmSync(work, { recursive: true, force: true })
    if (generatedVault && !o.keepVault) {
      const c = containmentCheck(generatedVault, env)
      if (c.ok) fs.rmSync(generatedVault, { recursive: true, force: true })
      else log('REFUSED to delete ' + generatedVault + ': ' + c.why)
    }
  }
  process.on('exit', cleanup)
  process.on('SIGINT', () => { cleanup(); process.exit(130) })

  let code = 2
  try {
    const port = o.attach ?? o.port
    if (kind === 'cairn') {
      child = launchCairn({ port, geom: o.geom, vault: fixture.dir, stateDir: path.join(work, 'state') })
    } else if (kind === 'obsidian') {
      child = launchObsidian({ port, vault: fixture.dir, profileDir: path.join(work, 'obsidian-profile'),
        appPath: process.env.OBSIDIAN_APP ?? '/Applications/Obsidian.app' })
    }
    if (child) {
      child.stderr.on('data', (d) => { const s = String(d).trim(); if (s && !/DevTools listening/.test(s)) notes.push('app stderr: ' + s.slice(0, 200)) })
    }
    const cdp = await cdpConnect(port, 60000)
    const { sessionId: sid, target } = await attachPage(cdp)
    await cdp.send('Runtime.enable', {}, sid)
    await cdp.send('Page.enable', {}, sid).catch(() => {})

    const bounds = await setWindowBounds(cdp, target.targetId, { width: gw, height: gh })
    if (!bounds.ok) notes.push('window bounds could not be set over CDP (' + bounds.error + '); the size below is what the app chose')

    if (kind === 'obsidian') {
      await sleep(6000)
      const norm = await normaliseObsidian(cdp, sid, [gw, gh]).catch((e) => ({ error: e.message }))
      log('obsidian layout: ' + JSON.stringify(norm))
      if (!norm.resized?.via) {
        notes.push('Obsidian\'s window could NOT be resized from its renderer, so this run is at the size ' +
          'Obsidian chose. A pacing comparison against a Cairn run at another size is not like for like.')
      }
      if (pane.name === 'tree' && !o.selector) pane.selector = '.nav-files-container'
    }
    if (pane.name === 'editor') {
      /* THE ROWS HAVE TO EXIST BEFORE ONE CAN BE CLICKED, and on a 50,000-note
         vault they do not for the first second or so.  The first draft clicked
         immediately, found `rows: 0`, opened nothing, and then failed with "the
         pane never became scrollable" -- which reads like an editor fault and
         was a race in the harness. */
      await until('a file row to exist', async () =>
        (await evaluate(cdp, sid, `document.querySelectorAll('.tr, .nav-file-title').length`)) > 0, 90000)
      const opened = await openLongNote(cdp, sid)
      log('opened the long note: ' + JSON.stringify(opened))
      if (!opened.via) throw new Error('the long fixture note could not be opened: ' + JSON.stringify(opened))
      await sleep(1500)
    }

    const facts = await waitForScroller(cdp, sid, pane.selector, 90000)
    if (facts.visibility !== 'visible') notes.push('document.visibilityState is "' + facts.visibility + '": the window was occluded or hidden, and a pacing number from it is not valid')
    /* THE VIRTUALISED ROW COUNT, from the sizer rather than from the DOM.
       `poolRows` is ~49 at any vault size; the gate is written about the nodes,
       and `scrollHeight / --row-h` is what the tree actually holds. */
    /* ONLY THE TREE HAS ROWS.  `--row-h` is a tree token and it resolves
       inside `.cm-scroller` too (it is inherited), so dividing the editor's
       scrollHeight by it produced "3561 rows" for a 4,000-line note -- a
       number with no referent, printed next to a gate clause about nodes. */
    const virtualRows = pane.name === 'tree' && facts.rowH > 0 ? Math.round(facts.scrollHeight / facts.rowH) : null
    Object.assign(pane, {
      rect: facts.rect, scrollHeight: facts.scrollHeight, clientHeight: facts.clientHeight,
      poolRows: facts.poolRows, rowH: facts.rowH, virtualRows,
    })

    // Settle: the first seconds after a vault opens carry the initial paint,
    // the watcher starting and (on the 50,000-note fixture) the cap banner.
    await sleep(2500)
    await evaluate(cdp, sid, `document.querySelector(${JSON.stringify(pane.selector)}).scrollTop = 0`)
    await sleep(500)

    const phases = {}
    log('== phase gesture ==')
    phases.gesture = await tracedPhase(cdp,
      () => driveGesture(cdp, sid, { rect: facts.rect, distance: o.distance, speed: o.speed }),
      { expectHz: o.expectHz ?? undefined })
    phases.gesture.what = 'a trusted wheel gesture, ' + o.distance + ' px at ' + o.speed + ' px/s'

    if (o.events > 0) {
      log('== phase plan ==')
      const maxTop = Math.max(0, facts.scrollHeight - facts.clientHeight)
      const plan = cairnScrollPlan(maxTop, { rowH: PANES[o.pane].rowH, events: o.events })
      phases.plan = await tracedPhase(cdp,
        () => drivePlan(cdp, sid, { selector: pane.selector, plan }),
        { expectHz: o.expectHz ?? undefined })
      phases.plan.what = plan.length + ' scrollTop assignments, one per animation frame (reaches the jump path)'
      phases.plan.pacing = false
    }

    const win = await evaluate(cdp, sid, `({ dpr: devicePixelRatio, inner: [innerWidth, innerHeight] })`)

    // ---- the verdict, over BOTH phases -------------------------------------
    const samples = Object.values(phases).flatMap((p) => p.analysis.handler.samples)
    const quantumMs = Math.max(...Object.values(phases).map((p) => p.analysis.quantumMs))
    /* §5.12.6(d) IS A CLAUSE ABOUT OWNER 04's TREE VIRTUALISER, and applying it
       to another pane is a category error the first draft of this file made:
       it reported the EDITOR as `result=FAIL` against a budget written for the
       tree.  §5.12.6's editor paragraph (owner 03) sets no millisecond budget
       at all -- its obligations are the `::-webkit-scrollbar` rule and "treat
       every synchronous main-thread task as a scrolling cost".  So the editor
       arm REPORTS, and says loudly when it is over the tree's number, which is
       information; it does not fail a gate that was never written about it. */
    /* AND ONLY CAIRN IS GATED.  Pointing Cairn's contract clause at Obsidian
       and printing `result=FAIL` says nothing true: §5.12.6(d) is a rule this
       project wrote for its own tree.  Obsidian's number is a YARDSTICK -- and
       a useful one, since it turns out to be the larger of the two. */
    const gated = pane.name === 'tree' && kind === 'cairn'
    const v = gated
      ? verdictFor(samples, quantumMs, o.budget)
      : { verdict: 'REPORT',
          reason: kind !== 'cairn'
            ? 'this is ' + kind + ', not Cairn: §5.12.6(d) is a clause this project wrote about its OWN tree ' +
              'virtualiser, and pointing it at another app would report a verdict nobody agreed to. The ' +
              'distribution is here as a yardstick'
            : 'the ' + pane.name + ' pane is not gated: §5.12.6(d)\'s <= ' + o.budget +
              ' ms is owner 04\'s clause about the TREE virtualiser, and §5.12.6 sets the editor no millisecond budget',
          overCertain: 0, overPossible: 0 }
    if (!gated) {
      const over = samples.filter((x) => x > o.budget).length
      if (over) {
        notes.push(over + '/' + samples.length + ' ' + kind + ' ' + pane.name + ' scroll handlers exceeded ' + o.budget +
          ' ms (the TREE\'s budget, quoted here only as a yardstick). It cost no frames in this run -- see the ' +
          'pacing block -- because Chromium scrolls this pane on the compositor thread. Under WebKitGTK with ' +
          '`AsyncOverflowScrollingEnabled = NO`, which is what §5.12.6 was written against, the same handler ' +
          'would have been on the critical path of every frame.')
      }
    }
    const gPacing = phases.gesture.analysis.pacing
    if (gPacing.presentedSwaps < 30) {
      notes.push('only ' + gPacing.presentedSwaps + ' frames were presented: the window was probably occluded, and the pacing block must not be quoted')
    }

    const doc = {
      tool: 'scroll-bench', version: 2, when: new Date().toISOString(),
      host: { platform: os.platform(), arch: os.arch(), release: os.release(), node: process.version,
              electron: kind === 'cairn' ? readElectronVersion() : null, chrome: (await cdp.send('Browser.getVersion').catch(() => ({})))?.product ?? null },
      subject: { kind, url: target.url, port },
      window: { geom: o.geom, inner: win.inner, dpr: win.dpr,
                devicePx: [Math.round(win.inner[0] * win.dpr), Math.round(win.inner[1] * win.dpr)],
                mpx: (win.inner[0] * win.dpr * win.inner[1] * win.dpr) / 1e6, boundsSet: bounds.ok },
      fixture: fixture ? { dir: fixture.dir, notes: o.nodes, longLines: o.longLines, reused: !!fixture.reused } : null,
      pane,
      panel: phases.gesture.analysis.panel,
      phases: Object.fromEntries(Object.entries(phases).map(([k, p]) => [k, { what: p.what, pacing: p.pacing, driver: p.driver, analysis: p.analysis }])),
      gate: { clause: '§5.12.6(d)',
              at: pane.virtualRows === null ? pane.poolRows + ' pooled elements, scrollHeight ' + pane.scrollHeight
                : pane.virtualRows >= 49999 ? '50,000-node cap (' + pane.virtualRows + ' rows, ' + pane.poolRows + ' pooled)'
                : pane.virtualRows + ' rows (' + pane.poolRows + ' pooled)',
              budgetMs: o.budget, quantumMs, dist: distribution(samples),
              verdict: v.verdict, reason: v.reason, overCertain: v.overCertain, overPossible: v.overPossible },
      validity: { screenLocked: locked, framesPresented: gPacing.presentedSwaps, notes },
      result: v.verdict,
    }
    log('')
    log(renderReport(doc))
    log('')
    log(summaryLine(doc))

    if (o.json) {
      const slim = { ...doc, phases: Object.fromEntries(Object.entries(doc.phases).map(([k, p]) => [k, { ...p, analysis: { ...p.analysis, handler: { ...p.analysis.handler } } }])) }
      fs.writeFileSync(o.json, JSON.stringify(slim, null, 2))
      log('json -> ' + o.json)
    }
    if (o.trace) {
      fs.writeFileSync(o.trace, JSON.stringify(Object.fromEntries(Object.entries(phases).map(([k, p]) => [k, p.events]))))
      log('trace -> ' + o.trace)
    }
    cdp.close()
    code = v.verdict === 'PASS' || v.verdict === 'REPORT' ? 0 : v.verdict === 'FAIL' ? 1 : 3
  } catch (e) {
    log('')
    log('SCROLL-BENCH result=ERROR ' + (e && e.message))
    if (process.env.CAIRN_BENCH_DEBUG) log(String(e && e.stack))
    code = 2
  } finally {
    cleanup()
  }
  process.exit(code)
}

function readElectronVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(REPO, 'node_modules', 'electron', 'package.json'), 'utf8')).version
  } catch { return null }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  await main()
}
