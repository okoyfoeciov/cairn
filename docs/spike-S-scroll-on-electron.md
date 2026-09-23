# Scroll on Electron — the performance baseline

`tools/scroll-bench.mjs` is the instrument and this file is its measurements on the current
stack. It drives the app over the Chrome DevTools Protocol and reads Chromium's own trace
events; `requestAnimationFrame` appears nowhere in it and nothing is injected into the page.
The quantities it exists to answer are all below the app's own code: what the compositor
presented, whether frames were dropped, what the `scroll` handler cost, and how long input
took to reach the glass. A fifth — distance per presented frame — closes the half of
"smooth" that cadence cannot see.

Run protocol: CONTRACT §6.5 — the median of five runs, run 1 discarded. The gate is
§5.12.6(d): the tree virtualiser's scroll handler costs **≤ 2 ms** per event at the
50,000-node cap. It is applied **only to Cairn's tree** (`tools/scroll-bench.mjs:1805`);
every other pane or subject prints `result=REPORT`, and the live Obsidian runs in the same
fixture as a yardstick, never as a verdict.

Two anchors the contract keeps on this file: the 120 Hz Debian measurement is what CONTRACT
§0.25.3 E61 quotes, and the 144 Hz driver cap is what CONTRACT §0.53.7 E106 and
`KNOWN-ISSUES.md` V-6 quote.

---

## What the instrument reads

| quantity | mechanism | in `tools/scroll-bench.mjs` |
|---|---|---|
| presented frames | `viz`'s `Display::DrawAndSwap`, one event per frame that reached the screen; grouped by process and thread, so a second display surface is reported rather than silently merged | `presentedFrames()` `:402` |
| dropped frames | `cc`'s `PipelineReporter`: `STATE_PRESENTED_ALL`, `STATE_DROPPED` and `STATE_NO_UPDATE_DESIRED` are counted separately, because a dropped frame and a frame nobody asked for are different things. The state is on the `b` event; the `e` event carries nothing | `pipelineStates()` `:467` |
| the `scroll` handler | `devtools.timeline`'s `EventDispatch` filtered to `data.type == 'scroll'`; wall (`dur`) and thread-CPU (`tdur`) are reported apart, because their difference is preemption rather than the handler's own cost | `dispatchDurations()` `:482` |
| input to glass | `cc`'s `EventLatency`, by event type, plus Chromium's own `scroll_jank_v4` / `is_janky_scrolled_frame` flag | `latencyByEvent()` `:696` |
| the panel | `EventLatency.vsync_interval_ms` — the browser's own number, never a config file or `system_profiler` | `estimatePanel()` `:431` |
| distance per frame | `ScrollTree::SetScrollOffset`'s `args.y` paired with the next `DrawFrame`, both in the renderer process so no cross-process delay enters the pairing | `scrollDistancePerFrame()` `:587` |
| app-controlled frame cost | the per-frame `PipelineReporter` total minus `SubmitCompositorFrameToPresentationCompositorFrame`; a length mismatch returns `paired: false` rather than a misaligned subtraction | `beginFrameToSubmit()` `:673` |
| the gesture driver | `Input.synthesizeScrollGesture`, dispatched by the browser process so it is a trusted input that travels the real path; it fires one event every 8.333 ms whatever the panel — see the 144 Hz section | `driveGesture()` `:1092` |
| the plan driver | a four-phase `scrollTop` plan, one assignment per animation frame; it is not a frame-rate measurement, and it is the only phase that reaches the whole-pool repaint (`src/tree.ts:1116`) | `cairnScrollPlan()` `:308`, `drivePlan()` `:1108` |
| the verdict | quantisation-aware: `observed + q <= budget` is provably within, `observed − q > budget` is provably over, and anything between is `INCONCLUSIVE`, because the clock cannot resolve it. FAIL needs 1% of events provably over | `verdictFor()` `:267` |
| the self-test | 67 assertions over a synthetic trace — no app, no display, no GPU; `npm run pretest` runs it on every `npm test` | `selfTest()` `:1393`, `package.json:14` |

The handler span is an **upper bound**: the trace event covers the whole dispatch, including
the dispatch machinery and any other listener on the path, and the budget is written about
the handler.

---

## The gated budget: §5.12.6(d)

**Measured on macOS, 60 Hz panel at dpr 2** (window 1920 × 959 CSS), at the 50,000-node cap:
**PASS**, over both phases — p99 **0.625 ms**, max **0.841 ms** against the 2 ms budget, with
the clock quantum at **0.001 ms**.

| phase | p50 | p99 | max |
|---|---|---|---|
| `gesture` — a trusted wheel, 12,000 px at 2,000 px/s | 0.256 ms | 0.609 ms | 0.665 ms |
| `plan` — 400 `scrollTop` assignments, one per frame, reaching the whole-pool repaint | 0.175 ms | 0.591 ms | 0.841 ms |

Both phases feed one verdict. The `plan` phase exists because
`src/tree.ts:1116` repaints the entire pool in one event, and no wheel gesture reaches that
branch at any speed.

**Measured on Debian, 120 Hz panel at dpr 1.25**: **PASS** with every one of **1,114** events
provably ≤ 2 ms — p99 **0.281 ms**, max 0.573 ms over both phases.

The measurement needs no probe in the page: Chromium emits the handler's own span in integer
microseconds, and `traceQuantumMs()` measures the clock quantum rather than asserting it
(`:357`), because "the clock is fine" is exactly the assumption a harness should distrust.

---

## Presented frames, dropped frames and jank

### Measured on macOS, 60 Hz panel at dpr 2

Window 1920 × 959 CSS = 3840 × 1918 device px = 7.37 Mpx. Fixture: 50,000 nodes in the tree,
2,000 notes for the Obsidian arm, a 4,000-line note for the editor arm.

| arm | presented | dropped | janky |
|---|---|---|---|
| tree, 50,000 nodes | 59.73 / 60.00 — deficit **0.45%** | 0–1 of 363 | 0 of 360 |
| tree, 2,000 nodes | 59.85 / 60.00 | 0 of 364 | 0 |
| editor, a 4,000-line note | 59.68–59.84 / 60.00 | 0 of 362 | 0 |
| Obsidian, same window, same vault | 59.61–59.74 / 60.00 | 0–1 of 363 | 0 |

Cadence: p50 **16.662 ms** — one vblank, in 338 of 361 intervals. The panel period comes from
the trace, not from a config, and is cross-checked against the presented cadence.

**Cairn against the live Obsidian**, same window, same fixture, same gesture, 2,000 notes:

| | Cairn | Obsidian |
|---|---|---|
| `scroll` handler p50 | 0.096 ms | 0.074 ms |
| `scroll` handler p90 | 0.173 ms | **3.100 ms** |
| `scroll` handler max | 0.294 ms | **5.592 ms** |
| handlers over 2 ms | **0 of 361** | **57 of 361 (16%)** |
| `submit → presented` | 37.9 ms | 40.3 ms |

Obsidian's p50 frame does no main-thread work at all — its whole
`send_begin_mainframe_to_commit_breakdown` is zeros at p50 — and pays 3–5 ms when it does;
Cairn does ~1.4 ms of work every frame and never spikes. Both saturate the panel. No verdict
is reported for Obsidian: §5.12.6(d) is a clause this project wrote about its own tree
virtualiser.

### Measured on Debian, 120 Hz panel at dpr 1.25

Fixture: 50,500 flat notes, the walk capping at 50,000. This is the current baseline against
a fast panel:

| | Cairn | the live Obsidian, same box, same fixture, same gesture |
|---|---|---|
| presented | **115.70 fps of 120.00 Hz — deficit 3.59%** | **103.04 fps — deficit 14.14%** |
| dropped | **6** of ~731 | **95** |
| janky scroll updates | **3.5 of 718 (0.49%)** | **85 of 630 (13.49%)** |
| cadence | p50 **8.333 ms** = one vblank, p99 9.785 | p50 8.392, p99 24.211 |
| `scroll` handler, both phases | p50 0.087 · **p99 0.281** · max 0.573 ms | p50 0.017 · **p99 11.259** · max 15.873 ms |
| §5.12.6(d) | **PASS**, all 1,114 events ≤ 2 ms | not gated — `REPORT` only |

Of the ~745 vblanks the gesture spanned, **719 were presented, 6 dropped, and 32 reported
`STATE_NO_UPDATE_DESIRED`** at the head and tail. Cairn is ~12.7 fps ahead of the app being
cloned on this hardware.

The windows were not like-for-like: `Browser.getWindowForTarget` is unimplemented on this
Wayland session, so the harness could not set bounds and each app ran at the size it chose
(Cairn 2048 × 1070 CSS at dpr 1.25, Obsidian 1920 × 964). Cairn painted more device pixels
than Obsidian and still led it; the bias runs against Cairn.

### Measured on macOS, 144 Hz panel at dpr 1 — the driver's ceiling

Panel: Dell AW2725DM, 2560 × 1440, `dpr` 1, 144 Hz; both apps in a 2560 × 1319 CSS window
(resized through Obsidian's own renderer), so this comparison is like-for-like.

| same window, same fixture, same gesture | Cairn | the live Obsidian |
|---|---|---|
| presented | **119.75 fps of 143.97 Hz — deficit 16.84%** | **118.41 fps — deficit 17.77%** |
| dropped | 0.5 | 6 |
| janky scroll updates | 19.90% | 20.07% |
| presented cadence p50 / p99 | 7.416 / 15.599 ms | 7.284 / 14.034 ms |
| step spread (sd ÷ mean) | 8.49% | 18.90% |
| uneven frames | 0.42% | 2.59% |
| `scroll` handler p99 / max | 0.167 / 0.352 ms — §5.12.6(d) **PASS** in all five | 6.26 / 11.62 ms — `REPORT` only |
| `STATE_NO_UPDATE_DESIRED` per run | 325 | 886–900 |
| `submit → presented` p50 | 14.54 ms | 16.12 ms |
| `GESTURE_SCROLL_UPDATE` p50 | 18.00 ms | 17.60 ms |

**None of that deficit is Cairn's.** `Input.synthesizeScrollGesture` dispatches one event
every **8.333 ms** whatever the panel, so a driver that delivers exactly 120 events a second
caps the measurable deficit at **1 − 120/143.97 = 16.65%**. Cairn is 0.19 points short of
that ceiling and Obsidian 1.12.

The cause is read in Chromium's source: `synthetic_gesture_controller.cc:119-137` sets
`event_interval_ = vsync_interval * (AllowHighFrequencyDispatch() ? 0.5f : 1.0f)`;
`AllowHighFrequencyDispatch()` returns `true` (`synthetic_gesture.cc:18-19`);
`synthetic_gesture_target_base.cc:111-116` (Chrome 142) / `:114-119` (150) hard-codes
`GetVSyncParameters()` to 16667 µs, a constant not the display's; and
`SyntheticGestureTargetMac` does not override it (`synthetic_gesture_target_mac.h:15`).
16,667 × 0.5 = 8.333 ms, and the controller is byte-identical at both tags — so Cairn on
Chrome 142 and Obsidian on 150 share the cap, which is what the table measures.

What the trace shows: `vsync_interval_ms` **6.946 ms** in every sample = **143.97 Hz**; the
display-link callback fires 143.66–143.98 times a second; wheel events arrive at
**120.15–120.20 per second**. The compositor is fed at 144 Hz and is not pacing at 120 —
presented frames come out at ~120 a second, one per input event, with roughly one vsync in
six carrying nothing new to draw.

**Fed by something that is not capped, Cairn reaches the panel.** A trusted CDP
`Input.dispatchMouseEvent` wheel at 144/s: Cairn's tree presents **143.99 fps, 0 of 864
janky, 0 dropped**, 747 consecutive one-vblank frames; Obsidian 140.38 fps, 75 of 670 janky,
18 dropped. A compositor CSS transform animation presents ~144 in both apps. These arms show
that Cairn's tree can be fed at 144 Hz; they rank nothing between the two engines, because
the engines differ and the explanation for Obsidian's 120/s result — the two engines treating
phase-less CDP wheel events differently — is inferred, not verified.

Two limits on this run, stated rather than implied. The `begin-frame → submit` pairing
printed `paired=false` in all ten runs, so no app-controlled frame cost is available from
this machine (`:678`). And the ~20% janky figure in every synthetic-gesture arm is the
driver's, not either app's (inferred): five inputs per six vsyncs leaves a two-vsync gap every
fifth frame.

`KNOWN-ISSUES.md` **V-6**: above 120 Hz, quote `fps` and `deficit` only from a panel at or
below 120 Hz, or from a driver that is not capped.

---

## Frame production cost

### Measured on macOS, 60 Hz panel at dpr 2

| stage | p50 | p99 |
|---|---|---|
| `SendBeginMainFrameToCommit` (style, layout, paint, layerize) | **1.462 ms** | 2.955 ms |
| `EndCommitToActivation` (raster wait) | 1.039 ms | — |
| **begin-frame → submit — THE PART THE APP CONTROLS** | **2.903 ms** | **4.989 ms** |
| `SubmitCompositorFrameToPresentationCompositorFrame` (the display's queue) | 37.784 ms | — |
| `PipelineReporter` total | 40.645 ms | — |

Main-frame p50 breakdown, in ms: `style_update` 0.20, `layout_update` 0.31, `prepaint` 0.09,
`paint` 0.15, `update_layers` 0.01, `composite_commit` 0.18.

A frame's budget is 16.666 ms at 60 Hz and 8.333 ms at 120 Hz. On this hardware Cairn's
app-controlled frame cost fits a 120 Hz cadence with ~3.3 ms of headroom at p99.

### Measured on Debian, 120 Hz panel at dpr 1.25

Median across runs 2–5, in ms:

| stage | p50 | p99 |
|---|---|---|
| `BeginImplFrameToSendBeginMainFrame` | 0.122 | 2.218 |
| `SendBeginMainFrameToCommit` (style, layout, paint, layerize) | 1.425 | 4.982 |
| `Commit` | 0.049 | 0.230 |
| `EndCommitToActivation` (raster wait) | 1.435 | 3.684 |
| `Activation` | 0.038 | 0.198 |
| `EndActivateToSubmitCompositorFrame` | 0.250 | 6.721 |
| **begin-frame → submit, sum of medians** | **3.32** | — |
| `SubmitCompositorFrameToPresentation` (display queue, not the app) | 24.783 | 40.795 |

**No stage the app controls has a p99 over 8.333 ms**, and the whole app-controlled path
costs 3.32 ms at p50 — the same shape the macOS run measured (2.9 ms p50 / 5.0 ms p99).
Percentiles do not add, so the p50 sum is quoted as a sum and the p99s are quoted per stage.

**The ~24.8 ms display queue is not a defect.** It is three vblanks of pipelining between
submit and scanout; it sets input-to-glass latency and not the frame rate, which is why
115.70 fps and a 24.8 ms queue coexist.

---

## The editor pane

**Measured on macOS, 60 Hz panel at dpr 2**, a 4,000-line note:

| | p50 | p99 | max | over 2 ms |
|---|---|---|---|---|
| editor, both phases | 0.272 ms | 4.968 ms | **7.090 ms** | **145 of 787** |

**§5.12.6(d) does not apply to it.** That clause is the tree virtualiser's; §5.12.6's editor
paragraph sets no millisecond budget — its obligations are the `::-webkit-scrollbar` rule and
"treat every synchronous main-thread task as a scrolling cost". The harness reports the number
and refuses to fail a gate nobody wrote (`:1793-1800`).

It cost no frames: 59.68–59.84 fps, zero dropped, zero janky, in the same runs.
**Chromium scrolls this pane on the compositor thread**, so CM6's viewport work lands after
the scroll has been presented. That is worth knowing before anybody spends effort optimising
CM6's scroll path.

---

## Distance per frame

The other half of "smooth", and the half every cadence number above is blind to: a flipbook
whose pages arrive exactly on time and whose drawing jumps 45 px, then 12, then 40, then 8
scores perfectly on all of them.

**Measured on macOS, 60 Hz panel at dpr 2**, same window, same fixture, same gesture:

| | step p50 | spread (sd ÷ mean) | frames >½ step from the mean |
|---|---|---|---|
| **Cairn**, tree | 67.000 px | **3.80%** | **1 of 360 (0.28%)** |
| **Obsidian**, file explorer | 67.000 px | **3.76%** | **1 of 360 (0.28%)** |
| Cairn, editor | 67.000 px | 2.45% | 0 of 359 (0.00%) |

Cairn's glide is even, and it is the same glide Obsidian has — both apps let Chromium's own
compositor animate the scroll.

**One step can destroy both statistics, and on a real page one did.** `ScrollTree::SetScrollOffset`
does not name its scroll node, so every scroller in the page interleaves into one offset
sequence. On Obsidian a single 24,000 px step — the whole gesture's travel — took the spread
to 892% and marked 359 of 361 frames "uneven" while its p50 and p90 steps stayed identical to
Cairn's to within a pixel. Steps beyond **20× the median and beyond 500 px** are therefore
excluded from the glide statistics and reported as their own count (`:630`); both conditions,
because at 5× the median an alternating 8 / 58.6 px stutter — the exact shape the metric
exists to catch — has a median of 8 and measures as a perfectly even glide. The self-test
drives an even glide and a stuttering one with identical cadence, and requires the second to
be caught (`:1467-1474`).

**Measured on Debian, 120 Hz panel at dpr 1.25**: per-frame distance spread **15.75%**, median
step 21.0 px; Obsidian's spread in the same gesture is **45.99%**. Most of Cairn's 15.75% is
arithmetic rather than stutter — at 120 Hz a 2,000 px/s gesture puts ~21 px in a frame where
60 Hz puts ~33, so the same ±2 px of wheel-delta quantisation is a proportionally larger
spread. **Recorded as a number and not as a finding**; separating quantisation from stutter
needs a run at matched steps per frame, which has not been taken.

**`--distance` and `--speed` are CSS-pixel arguments that the gesture delivers in device
pixels.** Asked for 12,000 px at dpr 2, the run travelled **23,966**. Uniformity is unaffected —
it is a ratio — but a speed quoted from such a run is a CSS-pixel number describing a
device-pixel gesture at the run's dpr.

---

## Input latency

**Measured on macOS, 60 Hz panel at dpr 2:**

| | Cairn | Obsidian |
|---|---|---|
| `GESTURE_SCROLL_UPDATE` p90 | 51.7 ms | 53.0 ms |
| `MOUSE_WHEEL` p50 | 2.8–9.4 ms | 0.13 ms |
| `submit → presented` p50 | **37.8 ms** | **40.3 ms** |

**Measured on Debian, 120 Hz panel**: `GESTURE_SCROLL_UPDATE` p50 **8.07 ms**, one vblank.

The dominant term is the display queue, and Obsidian pays it too — slightly more. ~38 ms of a
~40 ms frame is `SubmitCompositorFrameToPresentationCompositorFrame`, the platform's present
pipeline, which no application code shortens.

**The median of this quantity is unstable by construction and must not be quoted alone.**
`EventLatency` is emitted per input event, and the synthetic gesture generates ~722 wheel
events over ~362 presented frames — two per frame — so roughly half wait an extra present
cycle by construction. The distribution is bimodal with the modes one vblank apart, and the
median lands on whichever mode carries more mass that run. The instrument prints a histogram
in vblank units next to the percentiles; that is what to read.

---

## Validity, traps and refusals

- **A locked screen invalidates every graphics number.** `screenIsLocked()` (`:891`) is
  checked before anything is launched, and the run reports `SCROLL-BENCH result=NOT-TAKEN
  reason=screen-locked` and exits 4 (`:1630-1637`). This is a validity rule and not an
  etiquette one: rAF does not fire on a locked screen and no pacing number from it means
  anything. Refusing is the correct outcome.
- **Above 120 Hz, `fps` and `deficit` measure the harness's driver** — see the 144 Hz section
  and `KNOWN-ISSUES.md` V-6.
- **Window bounds cannot be set over CDP.** `Browser.getWindowForTarget` is not implemented in
  Electron (`:1126-1134`), so the harness uses whatever size the app takes — and `--geom`
  sizes the **frame** outside `--pixeltest`, so the default 1920 × 964 produced a **1920 × 959
  content box** on macOS. The Debian comparison ran at 2048 × 1070 against 1920 × 964, neither
  of them set by the harness, so neither run is the gate geometry. A pacing comparison between
  windows of different sizes is reported as such.
- **An offscreen run is not a pacing run.** The launch clears `CAIRN_HEADLESS` (`:970`); an
  offscreen window renders through Electron's frame-subscription path at a fixed software
  cadence, and its "fps" is a property of that path. A run that presented fewer than 30
  frames is flagged and its pacing block must not be quoted (`:1827-1829`).
- **A second display surface is reported, not merged.** If another window was open, the trace
  contains two `Display::DrawAndSwap` surfaces and the run says so (`:1218-1221`).
- **The handler span is an upper bound, and the gate is Cairn's tree only** (`:1805`); the
  editor and Obsidian are `REPORT`.

---

## What is not measured

- **A trackpad.** Out of scope by user ruling; `preventFling: true` is passed for that reason
  (`:1098`).
- **A real mouse wheel's cadence.** The gesture is Chromium's synthetic one and runs at
  ~120 events a second whatever the panel — two per frame at 60 Hz, one at 120 Hz, fewer than
  one per frame above that.
- **A panel the machine cannot see.** The refresh rate is measured from the trace, and a
  60 Hz machine cannot say whether an app can feed a 120 Hz panel; `--expect-hz` exists so a
  faster machine prints the deficit against a rate the trace itself does not reveal.
- **The frame rate is never gated.** No contract clause does; the pacing block is a report and
  §5.12.6(d)'s handler budget is the only verdict.
