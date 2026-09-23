/* eslint-disable no-console */
/**
 * tools/verify-geometry.js — Cairn's tier-1 geometry probe
 * ========================================================
 * The reference screenshots (1.png, 2.png) are gone, so spec-01 §11.2's pixel diff can never be run
 * again (it is STRUCK, with tools/pixdiff.py and docs/pixdiff-log.md — CONTRACT.md §5.11). This
 * probe is the replacement gate: every layout fact the diff would have caught, re-expressed as an
 * assertion on computed CSS geometry.
 *
 * NORMATIVE SOURCE: docs/CONTRACT.md. Where a check's `from` string cites a §, that section wins
 * over anything the spec-0N documents say. Nothing here paraphrases a ruling; it cites it.
 *
 * THE GATE IS "0 failures, 0 skips" (G9) — NEVER a check count. The old "69/69" gate pinned the run
 * to the harness's own size and so forbade ever adding a check. No total is hardcoded anywhere in
 * this file, and none may be added. `result.rows` / `result.checks` are computed and reported.
 *
 * DPI-INSENSITIVE. Every value is read in CSS px via getBoundingClientRect / getComputedStyle.
 *   Nothing here touches devicePixelRatio or a screenshot; the answers are identical at 1x, 2x and
 *   any fractional scale. devicePixelRatio is *reported* in the result and never asserted. (This is
 *   also why §5.11 removed spec-01 §11.0's "must run on a 1x display" precondition.)
 *
 * FONT-INSENSITIVE. The probe never measures glyph ink or text advance — only box edges, padding,
 *   margins, and the computed font-size / line-height / font-weight *values*. Two places read a
 *   text *origin* (the caret-line marker rows): both use a Range over the FIRST character and read
 *   its `left`, which is a position, not an advance — the same number a zero-width caret would sit
 *   at. Where a magnitude genuinely is font-dependent (§5.4.1's marker shift) the contract itself
 *   refuses to assert it, and so does this file: it asserts the *relation* instead.
 *
 * COLOUR is asserted through getComputedStyle, NEVER from a raster (§5.11): the only capture method
 *   available in-process, `cacheDisplayInRect`, shifts colour and reads #2f2f2f back as (41,41,41).
 *
 * RUN
 *   In the app under `--pixeltest`: the shell injects this file, `src/chrome.ts` calls it on the
 *   first animation frame after `nc://vault-opened`, `src/ipc.ts` emits the report, and the shell
 *   exits 0 iff `report.ok` (= G9). NOT `report.skips`: the field is `skip`, singular, `report.ok`
 *   already folds `fail === 0 && skip === 0` into it, and `undefined === 0` is false, so a `skips`
 *   alias would fail every run. None exists here and none may be added.
 *
 *   Node, no DOM — the pure-arithmetic self-test of every derived constant below:
 *       node tools/verify-geometry.js --selftest      (or: npm run selftest:geometry)
 *   Both work. The direct form used to be a LIE: the guard at the foot of this file tested
 *   `require.main === module`, and package.json says `"type": "module"`, so under a direct
 *   `node tools/verify-geometry.js` there is no `require` and no `module` — the guard was false,
 *   nothing ran, and the process exited 0. A self-test that reports success without testing
 *   anything is the one failure mode §5.11 says is worse than a red run.
 *
 * OPTIONS
 *   gate      true  → also run the checks that depend on the window being exactly 1920x964 (§5.5:
 *                     that is a GATE size, not a default; the default is 1280x700). G9 runs this.
 *             false → those individual checks report SKIP; every size-independent check still runs.
 *   allowSkip true  → a SKIP does not fail the run. Default false, per §5.11: a missing fixture is
 *                     a failure, because a green run that measured nothing is worse than a red one.
 *   emit      'silent' | undefined (console)
 *
 * FIXTURE (spec-01 §11.0 as amended by CONTRACT.md §5.11 / §5.4.2 / §5.4.1). `--pixeltest` must
 * guarantee all of:
 *   - the reference vault open, with a folder at depth 0 expanded and, visible in the tree, a folder
 *     AND a file at depth 1, a folder at depth 2, and a file at depth 3;
 *   - a note open whose FIRST LINE IS BODY TEXT, never a heading (§5.4.2: the inline title occupies
 *     the box a leading H1 would have taken, so a leading H1 makes the `cm.line` row meaningless);
 *   - that note containing a fenced ```sh block of at least 3 lines, and at least one `## ` heading;
 *   - the note long enough to overflow vertically, so the editor's scrollbar gutter is real;
 *   - NEITHER §3.3 cap tripped and the watcher healthy, so the 881px tree band is the bare one;
 *   - the caret parked in the BODY, never on a heading line (§5.4.1's reveal shifts a heading's text
 *     by design; every measured heading band in the reference is a caret-elsewhere band);
 *   - `.cm-cursor { animation: none !important; }` injected.
 * Rows whose elements are absent report SKIP, not PASS.
 *
 * TWO ROWS DRIVE THE CARET. `heading.marker.shown` must observe the caret-on-heading state that
 * §5.4.1 rules, which the fixture deliberately is not in. It moves the caret, snapshots, and puts
 * the selection back before its checks run, so the DOM is left exactly as found. It reaches the
 * CodeMirror view via `window.__CM_VIEW__` -- installed under --pixeltest, and under any other
 * harness that sets `__HARNESS__` -- else it falls back to a real mousedown/mouseup pair on the
 * line.  It USED to name `.cm-content.cmView.rootView.view` as a second route; CM6 6.43 attaches no
 * such property to any DOM node, so that branch could never have run and it is gone (§0.24). If none of the three lands the caret on
 * the heading, the row SKIPs with that stated — it never reports a green "no marker" that merely
 * means the probe could not look.
 *
 * WHAT THIS FILE DOES **NOT** ASSERT, deliberately:
 *   - the vault bar's ink band (§5.10 R2). Its centre — content y 942.5, 3px below the 37px bar's
 *     interior centre — is reproduced by no model, spec-01's or spec-04's, and §5.10 explicitly
 *     de-gates it. A measurement no model derives is not a gate row. The bar's BOX is asserted.
 *   - any 2x figure. This display is 1x and every 2x number in the contract is a projection
 *     (§5.12.9 list B). Memory lives in tools/measure-memory.sh --layers (G5d), not here.
 *   - the four omitted UI elements (§9 E4): the two far-right title-bar icons, the ?/gear in the
 *     vault bar, code-block syntax highlighting, and the fullscreen traffic-light hole. There is no
 *     row for them because they do not exist; `cm.code.fence` asserts the *absence* of the third.
 */

(function (root) {
  'use strict';

  var EPS = 0.02;   // CSS px. Expected values are integers or exact 1/64-representable; this
                    // absorbs LayoutUnit float noise only (34.8 lands as 34.796875).

  /* ===========================================================================
   * THE DEVICE GRID — why a numeric check is not a bare |got - want| <= EPS.
   *
   * §5.11 claimed this probe is DPI-insensitive because it "reads no raster".
   * THAT IS FALSE AT FRACTIONAL SCALES, and it was measured false: at dpr 1.25
   * an 1918x958 gate run failed ELEVEN rows, every one of them by +/-0.2 or
   * +/-0.4 CSS px and NOT ONE of them a geometry error.  `getBoundingClientRect`
   * returns a USED box, and Chromium snaps a used box to whole DEVICE pixels.
   * A 1px rule cannot BE 1 CSS px at dpr 1.25 -- 1.25 device px is not
   * representable, so the engine draws 1 and reports 0.8.
   *
   * The old answer to that was "set your desktop to 100%".  That is not an
   * answer: the gate exists to measure the app, and a gate that only runs at
   * one display scale measures the desktop.  So the comparison is now stated in
   * terms of the grid the engine actually renders on, and each check records
   * WHICH rule admitted it:
   *
   *   exact      |got - want| <= EPS                    the old rule, unchanged
   *   snap       got is `want` snapped to the device    a single snapped edge;
   *              grid, i.e. round(want*dpr)/dpr         still exact, no slack
   *   device-px  |got - want| <= 1 device pixel         a value summed from
   *                                                     >1 independently snapped
   *                                                     edge. ONLY at fractional
   *                                                     dpr, and reported.
   *
   * AT AN INTEGER SCALE NOTHING CHANGES.  dpr 1 and dpr 2 put every integer CSS
   * px on an exact device boundary, so `snap` degenerates to `exact` and the
   * `device-px` rule is never reached -- the gate stays exactly as strict on
   * both machines the contract cares about as it has always been.  That is the
   * whole design: buy runnability at 1.25 without spending strictness at 1.
   *
   * The report carries `dpr`, `tolerance` and a per-check `via`, so a green run
   * at a fractional scale can never be quoted as if it were a green run at 1.
   * ========================================================================= */
  function devicePx(dpr) { return 1 / (dpr || 1); }
  function isIntegerScale(dpr) { return Math.abs(dpr - Math.round(dpr)) < 1e-9; }

  /** Returns the rule that admits `got`, or null if none does. */
  function admits(got, want, dpr) {
    if (typeof got !== 'number' || !isFinite(got)) return null;
    if (Math.abs(got - want) <= EPS) return 'exact';
    var snapped = Math.round(want * dpr) / dpr;
    if (Math.abs(got - snapped) <= EPS) return 'snap';
    // Never reached at an integer scale: there `snapped === want`, so anything
    // the device-px rule would admit the exact rule has already rejected by a
    // margin no smaller than one whole CSS pixel.
    if (!isIntegerScale(dpr) && Math.abs(got - want) <= devicePx(dpr) + EPS) return 'device-px';
    return null;
  }

  /* ===========================================================================
   * K — the derived constants, in one place, so the self-test can re-derive them
   * without a DOM and so a family of values (tree depths, sidebar bands) is
   * written as the law it came from rather than as literals that can drift.
   * Every entry is tagged [M] measured / [D] derived / [C] chosen / [O] Obsidian.
   * ========================================================================= */
  var K = {
    /* window & column sums */
    winW: 1920, winH: 964,      /* [D] §5.5 gate size; 1920 screenshot − 1px chrome each side      */
    stripH: 40,                 /* [M+S] §0.6 E8 — BORDER BOX: 39px of #2f2f2f fill + a 1px rule.
                                   The old 39 measured the FILL RUN and missed the rule under it;
                                   Obsidian's own app.css:6642-6651 is height 40 + border-bottom 1px.
                                   Everything derived below moves with it, which is the point of
                                   deriving it: titleTop 69->70, and treeTop/treeH followed until
                                   §0.12 E14 deleted the 40px nav band under this strip.            */
    stripFillH: 39,             /* [M] the #2f2f2f run alone, i.e. stripH minus the rule            */
    tabTop: 7,                  /* [M] §0.8 — re-measured: 7, not 6.  The first pass rounded 5.46
                                   off a downscaled capture and shipped the tab 1px too tall.       */
    /* §0.12 E14: `navH: 40` is DELETED with the toolbar it measured.  The band
       it named (sy 70..109, icon ink 82..99) is a measurement of the reference,
       not of this app, and it is preserved in CONTRACT §5.9's struck text. */
    vaultBarH: 43,              /* [S+M] 1px rule + 8 + 26 + 8, border-box. WAS 37 (§5.10 R2);
                                   overturned by Obsidian 1.13.7's app.css:6319-6330 (`height: unset`,
                                   8px padding round a 26px content row) and by a pixel measurement
                                   of the user's Debian screen. See chrome.css `.vault-bar`.        */
    bannerH: 24,                /* [M/D] §3.3 — box y 40..63 border-box since E14 (was 80..103)     */

    /* sidebar */
    sidebarW: 412,              /* [M] sx 1..412                                                   */
    sidebarPadR: 3,             /* [D] §5.2: "the sidebar's own 3px right padding beyond it"        */
    dividerW: 3,                /* [M+S] §0.7 E9 — the resize handle's hit target                  */
    gutterW: 8,                 /* [M] --scrollbar-gutter-w; the SIDEBAR's track (§0.37 E84)       */
    edGutterW: 12,              /* [S] --scrollbar-w-editor; Obsidian's own --scrollbar-width,
                                   app.css:2623, reserved by scrollbar-gutter: stable (§0.37 E84).
                                   The two differ because the panes do: the sidebar's 3px right
                                   padding lets an 8px track land the same 7 ink columns Obsidian's
                                   12px one does, and the editor's has no such padding.            */

    /* tree box model — §5.2, spike D verbatim */
    /* §0.48 E96 — cx0 15→16, tx0 35→36, gx0 23→24 on 2026-09-12, by user
       ruling on a live measurement. Each carried a "− 1px frame" correction
       against the reference PNG, and SPIKE O STRUCK THAT FRAME (its edge is a
       white wash over content — the same finding that took the window from
       1918×958 to 1920×964). Measured against the live Obsidian four ways:
       guides at device 30/51/72, chevron ink from 24, text ink 67/88/108, and
       Obsidian's own `.tree-item-inner` at exactly 36.000 at depth 0.
       `step` is UNMOVED at 17: that is Obsidian's design value too
       (margin 12 + border 1 + padding 4). Its RENDERED step is 16.8 at dpr
       1.25 only because Chromium snaps the border, which is a rasterisation
       artefact and not a layout intent — see the note on `--guide-w`. */
    rowH: 27, step: 17, chevW: 16, cx0: 16, gut: 4, tx0: 36, gx0: 24, treeFs: 13,
    /* [S] 2026-09-15 — design (macOS) defaults; `verify()` re-seats both from
       `data-os` before `buildTable()`, the same shape as `hairline` below. */
    scrollbarThumbRGB: '128,128,128', scrollbarThumbAlpha: 1,
    /* §0.49 E97 — ONE PIXEL AS CHROMIUM RENDERS IT: 1 at dpr 1 and 2, 0.8 at
       1.25.  `step` above is the DESIGN value (Obsidian's margin 12 + border 1
       + padding 4) and this is the border term, which is the only one that
       snaps.  `verify()` RE-SEATS both from the page's own `--hairline` before
       any row is built, so every expected position below is exact at every
       scale instead of being 0.2px-per-level adrift and absorbed by the loose
       device-grid tolerance — which would have hidden a real regression of up
       to 0.22px at depth 3.
       IT DOES NOT TOUCH devicePixelRatio, and that is the point: `--hairline`
       is read in CSS px like every other value here, and a row below ties it to
       the USED width of a real 1px border in the same document.  This file's
       header rule is intact. */
    hairline: 1,

    /* editor — §5.3 */
    /* insetX/insetY WERE 33 and 30, both marked [M], and neither was measured
       (spike Q §1.4).  Obsidian's --file-margins-x/-y are both var(--size-4-8)
       = 32px (app.css:2243-2244 + :2662).  30 was the DESIGNATED FIT PARAMETER
       (spec-01-visual.md:709) and had been nudged to cancel out --h1-size being
       29 instead of 25.888; 33 was an ink-edge reading of a 32px box.  This
       widens K.lineW 1432 -> 1434 and moves K.lineLeft 445 -> 444; the 1432
       marked [M] is ink-to-ink ACROSS a 1434px box.

       ⚠ THAT LAST SENTENCE WAS WRONG, AND §0.37 E84 WITHDRAWS IT.  The [M] 1432
       is the BOX, and it is what this derivation gives once the editor's gutter
       is Obsidian's 12 rather than the sidebar's 8: 1508 - 12 - 64 = 1432.  An
       estimate that does not reconcile is a reason to stop; this one was
       reconciled by re-labelling the measurement instead, and it stood for five
       days until a user photographed a url wrapping one unit early. */
    editorX: 412, editorW: 1508, insetX: 32, insetY: 32, codePadX: 16,
    codeFs: 14, codeLh: 21,

    /* inline title — §5.4.2, RE-DERIVED by spike Q 2026-09-07.
       h1Size WAS 29 and is a HAND-COPIED LITERAL, not read from the token — so
       this constant and tokens.css must move in ONE commit or the tool and the
       stylesheet are red in opposite directions.  25.888 is `1.618em` (Obsidian
       app.css:2327) resolved against .cm-content's 16px; the tool needs the
       resolved px because it compares against getComputedStyle.
       h1Weight is unchanged at 700, but h2..h6 are NOT 600 any more — Obsidian's
       @supports branch (app.css:2010-2018) gives 680/660/640/620/600 and
       Chromium takes it; see the h2 fixture row below.
       lhTight is STRUCK and replaced by h1Lh: the six line-heights are per
       level (1.2/1.2/1.3/1.4/1.5/1.5, app.css:2321-2326), not one flat value. */
    h1Size: 25.888, h1Weight: 700, h1Lh: 1.2, titleSpace: 12.944,   /* h1Space DELETED, §0.30 E74 */

    /* vault bar interior — §5.5 / §5.11 */
    vbPadL: 16, vbGap: 8
  };

  /* derived — one law per family, so the self-test can check the law, not five copies */
  K.tabH         = K.stripH - K.tabTop;                     /* 34   [D] §0.6 E8                    */
  K.treeTop      = K.stripH;                                /* 40   [D] §0.12 E14: the scroller
                                                                 starts under the strip; there is no
                                                                 nav band left to add.              */
  K.treeH        = K.winH - K.treeTop - K.vaultBarH;        /* 875  [D] §3.3 (no banner)           */
  K.vaultBarY    = K.winH - K.vaultBarH;                    /* 915  [D] rule at content y 915      */
  K.scrollerR    = K.sidebarW - K.sidebarPadR;              /* 409  [D] §5.2 "x 0..408 (409px)"    */
  K.gutterL      = K.scrollerR - K.gutterW;                 /* 401  [D] §5.2 gutter x 401..408     */
  K.rowW         = K.gutterL;                               /* 401  [D] §5.2 "rows lay out in 401" */
  K.textLeft     = function (d) { return K.tx0 + d * K.step; };   /* 36 + 17d  (was 35, §0.48 E96) */
  K.chevLeft     = function (d) { return K.cx0 + d * K.step; };   /* 16 + 17d  (was 15, §0.48 E96) */
  K.chevCentre   = function (d) { return K.gx0 + d * K.step; };   /* 24 + 17d == guide k (was 23)  */
  /* §0.48 E96 — HALF A STEP PAST THE LAST STRIPE, not a whole one.  The box used
     to be `d * step`, which ends exactly where the NEXT stripe begins, and the
     rasteriser painted that boundary column at partial coverage — a depth-2 row
     drew a third, half-ink guide Obsidian does not have.  Any edge strictly
     between the stripes removes it; the half is chosen because it needs no
     reference to `--guide-w` and therefore none to dpr, which this file's
     header requires of every expected value. */
  K.guidesW      = function (d) { return Math.max(0, (d - 0.5) * K.step); }; /* background-size x */
  K.lineLeft     = K.editorX + K.insetX;                    /* 444  [D] was 445 at insetX 33       */
  K.lineW        = K.editorW - K.edGutterW - 2 * K.insetX;  /* 1432 [D] == the 1432 [M], E84       */
  K.codeTextLeft = K.lineLeft + K.codePadX;                 /* 460  [D] was 461 at insetX 33       */
  K.edGutterL    = K.winW - K.edGutterW;                    /* 1908 [D] §5.3 absolute geometry     */
  K.titleTop     = K.stripH + K.insetY;                     /* 72   [D] §5.4.2 (was 70 at insetY 30) */
  K.titleH       = K.h1Size * K.h1Lh;                       /* 31.0656 [D] 25.888 x 1.2            */
  K.titleBottom  = K.titleTop + K.titleH;                   /* 103.0656 (was 104.8)                */
  K.firstLineTop = K.titleBottom + K.titleSpace;            /* 116.0096 [D] (was 113.0656 at 10)   */
  K.vbLabelLeft  = K.vbPadL + K.chevW + K.vbGap;            /* 40   [S] 8 + 8 + 16 + 8, app.css:6338 */

  /* ---------------------------------------------------------------------------
   * Selectors. Settled by CONTRACT.md; the losing names are kept only as trailing
   * fallbacks so a half-migrated scaffold reports a real number instead of a SKIP.
   *   §5.2  tree rows are `.tr` / `.tr.d` (block-with-padding, chevron as ::before)
   *   §5.3  code lines are `nc-cb*`; spec-01's `hm-code*` is STRUCK
   *   §5.2  the sidebar scroller is `.tree-scroller`, replaced by `.search-scroller` (§4.5)
   *   §5.4.1/§5.4.2  `.nc-md-marker`, `.nc-title`
   *   §3.3  cap banners are `.cap-banner`;  §0.12 E14  the watcher bar is
   *         `.watch-degraded` and, like `.vault-lost`, must be ABSENT here
   * ------------------------------------------------------------------------- */
  var SEL = {
    titlebar:   ['.titlebar', '.title-bar'],
    tab:        ['.tab.is-active', '.tab'],
    sidebar:    ['.sidebar', '#sidebar'],
    sidebarResize: ['.sidebar-resize'],
    tree:       ['.tree-scroller', '.search-scroller', '.tree-scroll'],
    sideScroll: ['.tree-scroller', '.search-scroller'],
    treeRow:    ['.tr', '.tree-row'],
    folderRow:  ['.tr.d', '.tree-row.is-folder'],
    banner:     ['.cap-banner'],
    watchBar:   ['.watch-degraded'],
    vaultBar:   ['.vault-bar', '.vaultbar'],
    editor:     ['.editor', '.editor-pane'],
    scroller:   ['.cm-scroller'],
    content:    ['.cm-content'],
    line:       ['.cm-line'],
    title:      ['.nc-title'],
    heading2:   ['.cm-line.nc-h2'],
    marker:     ['.nc-md-marker'],
    codeLine:   ['.nc-cb'],
    codeFirst:  ['.nc-cb-first', '.nc-cb-only']
  };

  var HEADING_RE  = /(^|\s)nc-h[1-6](\s|$)/;
  var SCROLLABLE  = /^(auto|scroll|overlay)$/;

  /* --- helpers -------------------------------------------------------------- */
  function q(k, s) { for (var i = 0, e; i < SEL[k].length; i++) { e = (s || document).querySelector(SEL[k][i]); if (e) return e; } return null; }
  function qa(k, s) { for (var i = 0, l; i < SEL[k].length; i++) { l = (s || document).querySelectorAll(SEL[k][i]); if (l.length) return [].slice.call(l); } return []; }
  function is(el, k) { return SEL[k].some(function (s) { try { return el.matches(s); } catch (e) { return false; } }); }
  function cs(el, pseudo) { return getComputedStyle(el, pseudo || null); }
  function px(v) { return parseFloat(v); }
  function R(el) { return el.getBoundingClientRect(); }
  function b(v) { return v ? 1 : 0; }                       // boolean checks assert 1

  /**
   * §5.1 rule 5, "no transitions, no animations, anywhere" — asserted as the RULE, not as one
   * spelling of it.
   *
   * RULING (gate G9, first run). Two checks — `tree.chevron · no transition` and
   * `heading.marker.shown · marker no transition` — expected the literal computed string
   * `all 0s ...` and FAILED A CORRECT APP, which ships `transition: none !important` as a global
   * kill-switch (src/styles/base.css, the rule that STRUCK spec-04 §4.3's
   * `transition: transform 100ms ease`). A `transition: none` declaration computes
   * `transition-property: none`, so those checks could only ever have passed against an app that
   * wrote the OTHER spelling, `transition: all 0s` — a spelling §5.1 rule 5 never asked for. The
   * probe was wrong on both, not the app.
   *
   * What the rule actually forbids is a transition that RUNS. That is exactly "every listed
   * duration is zero and every listed delay is zero", which is true of `none`, of `all 0s`, and of
   * a named property at `0s`, and false the moment anything animates. `transition-property` is
   * deliberately NOT asserted: it is the spelling, not the rule. It is still REPORTED inside the
   * failure string, so a red row still names what would have animated.
   */
  function noTransition(s) {
    var dur = String(s.transitionDuration).split(','), del = String(s.transitionDelay).split(',');
    var n = Math.max(dur.length, del.length), bad = [];
    for (var i = 0; i < n; i++) {
      var d = parseFloat(dur[Math.min(i, dur.length - 1)]) || 0;
      var y = parseFloat(del[Math.min(i, del.length - 1)]) || 0;
      if (d !== 0 || y !== 0) bad.push((dur[Math.min(i, dur.length - 1)] || '?').trim() + ' delay ' +
                                      (del[Math.min(i, del.length - 1)] || '?').trim());
    }
    return bad.length ? 'animates (' + String(s.transitionProperty).trim() + ': ' + bad.join(', ') + ')'
                      : 'none';
  }
  /** Left edge of an element's content box — where its text actually starts. */
  function cl(el) { var s = cs(el); return R(el).left + px(s.borderLeftWidth) + px(s.paddingLeft); }
  /** Any colour → "r,g,b". Handles hex, because a custom property read back with
   *  getPropertyValue() is the raw token text (`#606060`), not a resolved rgb() triple. */
  function rgb(v) {
    var s = String(v).trim();
    var h = s.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
    if (h) {
      var x = h[1];
      if (x.length === 3) x = x[0] + x[0] + x[1] + x[1] + x[2] + x[2];
      return [parseInt(x.slice(0, 2), 16), parseInt(x.slice(2, 4), 16), parseInt(x.slice(4, 6), 16)].join(',');
    }
    var m = s.match(/-?\d+(\.\d+)?/g);
    return m ? m.slice(0, 3).map(Math.round).join(',') : s;
  }
  /** Any colour → its alpha channel. rgb() cannot distinguish `transparent` from opaque black. */
  /* `-?(?:\d+\.?\d*|\.\d+)` and NOT `-?\d+(\.\d+)?`: the old form cannot match a
     decimal written without a leading zero, so the authored text
     `rgba(255,255,255,.1)` yielded the four tokens 255/255/255/1 and this
     returned an alpha of 1 for a 10%-opaque colour — a probe row that passes on
     a value it has misread. Computed colours are canonicalised by the engine and
     never hit it; a CUSTOM PROPERTY is handed back as authored, and that is what
     the scrollbar-thumb row reads. */
  function alpha(v) { var m = String(v).match(/-?(?:\d+\.?\d*|\.\d+)/g); return (m && m.length >= 4) ? parseFloat(m[3]) : 1; }
  function depthOf(el) {
    var d = el.getAttribute('data-d');
    if (d !== null && d !== '') return +d;
    return parseInt(cs(el).getPropertyValue('--d'), 10);
  }
  function rowAt(d, kind) {   // kind: 'folder' | 'file' | undefined
    var rows = qa('treeRow');
    for (var i = 0; i < rows.length; i++) {
      if (depthOf(rows[i]) !== d) continue;
      var f = is(rows[i], 'folderRow');
      if (kind === 'folder' && !f) continue;
      if (kind === 'file' && f) continue;
      return rows[i];
    }
    return null;
  }
  /** The chevron slot: the inline `<svg class="chev">` child of a folder row (§5.2 — absolutely
   *  positioned; §0.50 E98 moved it off `::before`, where it had been a -webkit-mask whose SVG
   *  document poisoned Blink's font-strike scale). Its box is what the rows below measure. */
  function chev(row) {
    if (!row) return null;
    var el = row.querySelector('.chev');
    if (!el) return null;
    var s = cs(el);
    if (!s || s.display === 'none') return null;
    var w = px(s.width);
    if (!isFinite(w) || w === 0) return null;
    var r = R(el);
    return { el: el, left: r.left, width: w, height: px(s.height), centre: r.left + w / 2 };
  }
  /** Reserved scrollbar gutter of a scroller, in CSS px (§5.2, §5.3 — always 8, never 0 or 17). */
  function gutterOf(el) { return el.offsetWidth - el.clientWidth; }

  function isCode(el)    { return is(el, 'codeLine'); }
  function isHeading(el) { return HEADING_RE.test(' ' + el.className + ' '); }

  /** The first ordinary body line: not code, not a heading, not empty. §5.11's fixture puts one first. */
  function bodyLine() {
    var ls = qa('line');
    for (var i = 0; i < ls.length; i++) {
      if (isCode(ls[i]) || isHeading(ls[i])) continue;
      if (ls[i].textContent.trim()) return ls[i];
    }
    return null;
  }
  /** The `## ` heading line the fixture guarantees. Class first; computed H2 metrics as fallback. */
  function headingLine() {
    var h = q('heading2');
    if (h) return h;
    var ls = qa('line');
    for (var i = 0; i < ls.length; i++) {
      var s = cs(ls[i]);
      /* spike Q: WAS `=== 26 && === 600`, which after the ladder moved could
         never match anything again -- the fallback was dead in exactly the
         decoration-failure case it exists to catch.  EPS, not `===`, so the
         next retune degrades loudly instead of silently. */
      if (Math.abs(px(s.fontSize) - 23.392) <= EPS && px(s.fontWeight) === 680 && ls[i].textContent.trim()) return ls[i];
    }
    return null;
  }

  /**
   * Left edge of a line's text run, skipping a revealed `.nc-md-marker`.
   * POSITION, not advance: a Range over the FIRST character reports the origin the run starts at —
   * the same x a zero-width caret would occupy. No glyph ink and no text width is read.
   */
  function textStartLeft(lineEl) {
    var marker = lineEl.querySelector(SEL.marker[0]);
    var w = document.createTreeWalker(lineEl, NodeFilter.SHOW_TEXT, null, false);
    var nodes = [], n;
    while ((n = w.nextNode())) if (n.nodeValue && n.nodeValue.length) nodes.push(n);
    var start = 0;
    if (marker) for (var i = 0; i < nodes.length; i++) if (marker.contains(nodes[i])) start = i + 1;
    for (var j = start; j < nodes.length; j++) {
      var rg = document.createRange();
      rg.setStart(nodes[j], 0);
      rg.setEnd(nodes[j], 1);
      var rc = rg.getBoundingClientRect();
      if (rc.width || rc.height) return rc.left;
    }
    return null;
  }

  /* --- caret control, for the two §5.4.1 rows ------------------------------- */
  /**
   * The CodeMirror view, without importing @codemirror/view.
   *
   * ONE ROUTE, NOT TWO.  This used to fall back to `.cm-content.cmView.rootView
   * .view`, described here as "the walk EditorView.findFromDOM uses".  **CM6
   * 6.43 attaches no `cmView` property to any DOM node** -- `grep -c cmView
   * node_modules/@codemirror/view/dist/index.js` is `0` -- so that branch could
   * never have returned anything, and it read as a safety net that was not
   * there.  §0.20.6.1's lesson in a third set of clothes: code nothing executes
   * cannot fail, and a dead fallback is worse than an absent one because it
   * stops the next person looking for a real route.
   * Found 2026-09-10 by a probe that tried to use it (§0.24.6).
   */
  function cmView() {
    return root.__CM_VIEW__ || null;                        // the hook installed under --pixeltest
  }
  function lineNumberOf(view, el) {
    try { return view.state.doc.lineAt(view.posAtDOM(el, 0)).number; } catch (e) { return null; }
  }
  /**
   * Put the caret on `lineEl` IN A FOCUSED EDITOR.
   *
   * THE `view.focus()` IS LOAD-BEARING AND IT IS NEW (2026-09-09).  Cairn's
   * live preview reveals a marker only when the view has DOM focus — Obsidian's
   * own decorator opens with `v10 = t10.hasFocus ? d11.selection.ranges : []`
   * (obsidian.asar 1.12.7, app.js, the `S6.buildDeco`/`T6` pair), which is why
   * clicking into the file tree makes an Obsidian note render with nothing
   * revealed.  A bare `dispatch({selection})` leaves the caret on the line with
   * the editor blurred, and that is a state a USER CANNOT BE IN: a caret is on a
   * line because they put it there.  So the probe was simulating a state the
   * ruling does not describe, and `heading.marker.shown` was measuring it.
   * Focusing here is what makes the row observe §5.4.1's actual subject.
   * The caller restores both the selection AND the previously focused element.
   */
  function caretTo(view, lineEl) {
    if (view) {
      try {
        try { view.focus(); } catch (e) { /* a blurred window still measures layout */ }
        view.dispatch({ selection: { anchor: view.posAtDOM(lineEl, 0) } });   // no scrollIntoView
        return lineNumberOf(view, lineEl) === view.state.doc.lineAt(view.state.selection.main.head).number;
      } catch (e) { /* fall through to the event route */ }
    }
    try {
      var r = R(lineEl), x = r.left + 2, y = r.top + r.height / 2;
      ['mousedown', 'mouseup', 'click'].forEach(function (t) {
        lineEl.dispatchEvent(new MouseEvent(t, {
          bubbles: true, cancelable: true, view: root, button: 0, buttons: 1, detail: 1,
          clientX: x, clientY: y
        }));
      });
    } catch (e) { return false; }
    return !!lineEl.querySelector(SEL.marker[0]);            // the reveal itself is the receipt
  }

  /* ===========================================================================
   * THE TABLE.
   *   sel   what is being measured
   *   need  a getter returning the element/handle, or null → the whole row SKIPs
   *   c(name, expect, from, get, gate)  one check.
   *         `from` is the recorded measurement or contract section it descends from, so a red row
   *               says what you broke and a future reader can audit the number without this file.
   *         `gate` true → the check depends on the window being exactly 1920x964 and only runs
   *               under {gate:true}. Per-CHECK, not per-row: a row like `title` has one
   *               size-dependent number (its 1434px line box) and six that hold at any size.
   * A row-level `gate` flag also exists and gates every check in the row.
   * ========================================================================= */
  function buildTable() {
    var T = [];
    function row(id, sel, need, checks, gate) {
      T.push({ id: id, sel: sel, need: need, checks: checks, gate: !!gate });
    }
    function c(name, expect, from, get, gate) {
      return { name: name, expect: expect, from: from, get: get, gate: !!gate };
    }

    /* ---- 1. window frame ------------------------------------------------- */
    row('window', 'window', function () { return root; }, [
      c('inner size', K.winW + 'x' + K.winH,
        'M: the reference PNG\'s content box, rows 31..994 x columns 0..1919 (spike-O §3.5, re-measured 2026-09-09). WAS 1918x958 from "1920 screenshot − 1px chrome each side" — THAT CHROME DOES NOT EXIST: only row 30 is a real frame line, and the left/right/bottom edges are a 0.199 WHITE WASH OVER CONTENT (x=0 reads 78 over the sidebar\'s 34). spike-D §4 is superseded on this row. §5.5: this is the GATE size only — the first-run default is 1280x700, min 900x520, and a window that cannot be created at 1918x958 must FAIL here rather than silently clamp',
        function () { return root.innerWidth + 'x' + root.innerHeight; }, true),
      c('no horizontal overflow', 0,
        'D: nothing may bleed past the content box. A −16px code-block margin (spec-03 §8.4, STRUCK by §5.3) would put 16px here — this row is the overhang model\'s tripwire. Size-independent, so it runs at any window size',
        function () { return document.documentElement.scrollWidth - document.documentElement.clientWidth; })
    ]);

    /* ---- 2. title / tab strip -------------------------------------------- */
    row('titlebar', SEL.titlebar[0], function () { return q('titlebar'); }, [
      c('y', 0, 'D: the strip is the top band of the webview', function (e) { return R(e).top; }),
      c('height', K.stripH, 'M+S §0.6 E8: BORDER BOX. 39px of #2f2f2f fill plus the 1px rule under it — the old expectation of 39 was the fill run alone. Obsidian app.css:6642-6651 draws the same two things', function (e) { return R(e).height; }),
      c('rule under the strip', 1, 'S §0.6 E8: --tab-outline-width. This is the boundary between the chrome and both panes, and it is a DIFFERENT decision from spec-01 §2\'s "no border-right between the panes" — that one is vertical, between two fills', function (e) { return parseFloat(cs(e).borderBottomWidth); }),
      /* §0.49 E97 — THE TIE THAT MAKES `--hairline` HONEST.  `.titlebar`'s rule
         is a REAL 1px border, and Chromium snaps a used border to whole device
         pixels; `--hairline` is the synthetic copy of that snap which the tree's
         indent step and guide stripe are built from, because a padding and a
         gradient stop get no snapping of their own.  Asserting they are EQUAL
         ties Cairn's number to the engine's own behaviour in the same document
         — where comparing it to a constant would only compare Cairn to Cairn
         (§0.37 E84's exact trap). */
      c('--hairline == a real 1px border', true, 'D §0.49 E97: the tree\'s indent step is 16 + a snapped 1px border, and this is that border. Both are read as used CSS px; neither consults the device scale', function (e) {
        var hair = parseFloat(root.getComputedStyle(root.document.documentElement).getPropertyValue('--hairline'));
        var bord = parseFloat(cs(e).borderBottomWidth);
        return isFinite(hair) && isFinite(bord) && Math.abs(hair - bord) < 0.001;
      }),
      c('rule colour', '51,51,51', 'S: Obsidian --tab-outline-color -> --color-base-30 = #333333, NOT this project\'s #2f2f2f --bg-modifier-border, which would be invisible on a #2f2f2f strip', function (e) { return rgb(cs(e).borderBottomColor); }),
      c('background', '51,51,51', 'S: --bg-titlebar = Obsidian --titlebar-background-FOCUSED -> --background-secondary-alt -> --color-base-30 = #333333. It WAS 47,47,47, sampled as #2f2f2f off the reference PNG — but that PNG carries an iCCP display profile (S27E390, gamma 1.961) and 47 is the framebuffer byte, which decodes to 1.12.7\'s #363636. See tokens.css', function (e) { return rgb(cs(e).backgroundColor); })
    ]);

    row('tab', SEL.tab[0], function () { return q('tab'); }, [
      c('x', 430, 'M: active tab sx 431..630', function (e) { return R(e).left; }),
      c('width', 200, 'M: sx 431..630 = 200px', function (e) { return R(e).width; }),
      c('y', K.tabTop, 'M+S §0.6 E8: the tab is INSET 6px from the strip\'s top. Obsidian app.css:6661 `margin: 6px -5px -1px`; measured on the reference at 5.46, with 7 excluded because at 7 the ring would land on a row the capture shows is already pane-coloured', function (e) { return R(e).top; }),
      c('height', K.tabH, 'D §0.6 E8: --titlebar-h - --tab-top. THE OLD ROW SAID "the tab fills the strip" AND THAT WAS A [D], NOT A MEASUREMENT — it does not fill it, and never did in the reference', function (e) { return R(e).height; }),
      c('bleeds over the rule', K.stripH, 'D §0.6 E8: bottom = tabTop + tabH + 1px of negative margin = 40, so the tab covers the strip\'s own rule and tab and pane read as one surface with no line between them', function (e) { return R(e).bottom; }),
      c('top corner radius', '6px', 'S §0.6 E8: Obsidian --tab-radius-active is 6px 6px 0 0. NOT --radius-m (8px): that token is shared with the menu, the modal and the popover, and its "[D] active tab top corners" was a derivation off the radius ladder', function (e) { return cs(e).borderTopLeftRadius; }),
      c('background', '28,28,28', 'M: active tab fill #1c1c1c — identical to the editor, so the tab reads as seamless', function (e) { return rgb(cs(e).backgroundColor); })
    ]);

    /* §0.7 E9 — the resize handle.  It must take NO layout space: its right edge
     * IS the sidebar's right edge and its 3px come out of the sidebar's own
     * padding, not out of the pane.  A handle laid out in flow would widen the
     * sidebar to 415 and move every x this file asserts, which is exactly the
     * failure this row exists to catch. */
    row('sidebar.resize', SEL.sidebarResize[0], function () { return q('sidebarResize'); }, [
      c('right edge == the sidebar\'s', K.sidebarW,
        'D: absolutely positioned at right:0 inside .sidebar, so it overlays the last 3px rather than adding any',
        function (e) { return R(e).right; }),
      c('width', K.dividerW,
        'M+S: Obsidian --divider-width-hover; the handle measures 3.07 CSS px on the reference',
        function (e) { return R(e).width; }),
      c('y', K.stripH, 'D: it spans the sidebar, which starts below the strip',
        function (e) { return R(e).top; }),
      c('transparent at rest', 'rgba(0, 0, 0, 0)',
        'S: --accent only on :hover / .is-active — the FILL, unaffected by the 2026-09-15 divider ruling below, which is a border on the same element',
        function (e) { return cs(e).backgroundColor; }),
      c('divider colour', '51,51,51',
        'S 2026-09-15, user ruling overturning spec-01 §2: Obsidian\'s `--divider-color` on `.workspace-leaf-resize-handle` (app.css:6436, 6489) -> --background-modifier-border -> --color-base-30 = #333333 dark, read from the pinned 1.13.7 cascade. `docs/KNOWN-ISSUES.md` UI-3 is CLOSED by this',
        function (e) { return rgb(cs(e).borderRightColor); }),
      c('divider width == a snapped hairline', true,
        'D 2026-09-15: Obsidian\'s design value is `--divider-width: 1px` (app.css:2198) and a USED border snaps to floor of the device scale over the device scale, the same rule `--hairline` already carries for the tree\'s guides — K.hairline is re-seated from the page\'s own `--hairline`, by the same `verify()` block that re-seats it, never read off the display here',
        function (e) { return Math.abs(px(cs(e).borderRightWidth) - K.hairline) < 0.02; })
    ]);

    /* ---- 3. the two panes ------------------------------------------------ */
    row('sidebar', SEL.sidebar[0], function () { return q('sidebar'); }, [
      c('x', 0, 'M: sidebar sx 1..412 → content x 0', function (e) { return R(e).left; }),
      c('width', K.sidebarW, 'M: sidebar sx 1..412; fixed, no splitter in v1. §5.5: "the sidebar does not scale" — spec-07 §11 open question 2 answered NO', function (e) { return R(e).width; }),
      c('background', '40,40,40', 'S: --bg-secondary = --background-secondary -> --color-base-20 = #282828. WAS 34,34,34 = the reference PNG\'s framebuffer byte, which decodes to 1.12.7\'s #262626. The user\'s own profile-free screenshot of 1.13.7 measures 40 exactly', function (e) { return rgb(cs(e).backgroundColor); }),
      c('border-right', 0, 'M: `.sidebar` itself carries no border; since 2026-09-15 the divider line lives on `.sidebar-resize` instead (`sidebar.resize · divider colour` below), the same element Obsidian draws it on', function (e) { return px(cs(e).borderRightWidth); })
    ]);

    row('editor', SEL.editor[0], function () { return q('editor'); }, [
      c('x', K.editorX, 'M: editor starts sx 413 → content 412; = sidebar width, no gap', function (e) { return R(e).left; }),
      c('width', K.editorW, 'D: 1920 − 412 (sidebarW is [M] and did not move). WAS 1506 from winW 1918; the ±1 tie the code-block solve broke in §5.3 is unaffected — it chose between 1506 and 1507 at winW 1918, and at 1920 the same solve gives 1508, and spec-01 §2\'s "treat ±1px on the far right column as a pass" is STRUCK', function (e) { return R(e).width; }, true),
      c('background', '28,28,28', 'M: sampled #1c1c1c at (1200,600), (900,800)', function (e) { return rgb(cs(e).backgroundColor); })
    ]);

    /* ---- 4. sidebar vertical bands ---------------------------------------
       §0.12 E14 DELETED TWO ROWS FROM THIS SECTION, `nav` and `nav.slots`, and
       the deletion is mandatory rather than tidy: G9 is `fail === 0 && skip === 0`
       (see `run()` below), a row whose `need()` returns null reports SKIP, and a
       correct post-E14 app would therefore have gone RED on eight skips while
       measuring nothing wrong. */
    row('tree.scroll', SEL.tree[0], function () { return q('tree'); }, [
      c('y', K.treeTop, 'D §0.12 E14: 40, the strip\'s border box, with nothing between. The old value was 39 + 40 and carried a cross-check — a 13px glyph in the 15th 27px row measured at sy 495..510 — which E14 INVALIDATES rather than re-anchors: with the band gone the same glyph lands ~40px higher, so the recorded run corroborates nothing and is struck, not moved', function (e) { return R(e).top; }),
      c('height', K.treeH, 'D §0.12 E14 + the 43px vault bar: 964 − 40 − 43 = 881, WHICH IS WHAT CONTRACT §0 E14 SAYS. At winH 958 this computed 875 and contradicted the ruling it cites. §3.3: 881 with no banner, 857 with one cap, 833 with both — and spec-04 sizes the row pool from the LIVE clientHeight, never from this constant', function (e) { return R(e).height; }, true)
    ]);

    /* sidebar.gutter (X6) — §5.2. Ruled here for the first time: the 8px #606060 thumb the
       --scrollbar-gutter-w token is measured from was sampled in the SIDEBAR (sx 402..410), yet the
       token was scoped to .cm-scroller alone. Left to overflow-y:auto, every tree row's usable
       width changes by 8px the moment the vault grows past one screen and row ellipsis moves with
       it. §5.12 does NOT amend this: the flag route ships with no DOM or CSS change, so the
       mechanism assertion below is `scroll`, not `hidden`. If §5.12.7's fallback is ever adopted,
       THIS row and only this row changes: overflow becomes `hidden` and the mechanism assertion is
       replaced by the observable (thumb box 8px wide, rgb(96,96,96)). */
    row('sidebar.gutter', SEL.sideScroll[0], function () {
      var s = q('sideScroll'), sb = q('sidebar');
      return s ? { s: s, sb: sb } : null;
    }, [
      c('overflow-y', 'scroll',
        'C §5.2: "reserve the 8px gutter ALWAYS — never auto". §5.12.4.1 restates that overflow-y:scroll stays exactly as written under the flag route. NOT `auto` (the width would jump), NOT `hidden` (that is §5.12.7\'s fallback, which is not adopted)',
        function (h) { return cs(h.s).overflowY; }),
      c('reserved gutter width', K.gutterW,
        'M §5.2: 8px #606060 thumb sampled in the sidebar at sx 402..410. §5.12.4.2 makes this memory-load-bearing as well as cosmetic: a pane left on WebKit\'s default 17px scrollbar measures 1.57x the bare backing store instead of 1.00x, which is ~7 MB at 2x and a G5d failure. Both memory spike rigs made exactly this mistake',
        function (h) { return gutterOf(h.s); }),
      c('border box left', 0, 'D §5.2: the scroller starts at the sidebar\'s left edge', function (h) { return R(h.s).left; }),
      c('border box right', K.scrollerR,
        'D §5.2 "the scroller\'s border box is x 0..408 (409px) with the sidebar\'s own 3px right padding beyond it". 409 + 3 = the measured 412 sidebar exactly. NB §5.11\'s summary table writes "right edge 408": that is 0..408 read as a CSS coordinate instead of the inclusive pixel-index range §5.2 uses everywhere (cf. "sidebar x 0..411" for a 412px box, "editor pane x 412..1917" for 1506px). 408 would make the 8px gutter [401,408) = 7px and leave 1px of the sidebar unowned. 409 is asserted; the discrepancy is reported as a contract defect',
        function (h) { return R(h.s).right; }),
      c('gutter left edge == content box right', K.gutterL,
        'D §5.2: "the reserved gutter is the scroller\'s rightmost 8px at x 401..408". 409 − 8 = 401 exactly, which is the independent confirmation that the border box is 409 wide and not 408',
        function (h) { return R(h.s).right - gutterOf(h.s); }),
      c('rows lay out in 401px', K.rowW,
        'D §5.2: "Rows lay out in the remaining 401px; padding-right:6px is measured from the scroller\'s content box, not from the sidebar edge"',
        function (h) { return h.s.clientWidth; }),
      c('sidebar padding-right', K.sidebarPadR,
        'D §5.2: the 3px beyond the scroller that closes 409 → 412',
        function (h) { return h.sb ? px(cs(h.sb).paddingRight) : null; }),
      c('scrollbar thumb colour', K.scrollbarThumbRGB,
        'S §5.2/§5.1, per-platform since 2026-09-15 (user ruling): on Linux, Obsidian 1.13.7\'s own --scrollbar-thumb-bg, `color-mix(in oklch, white 10%, transparent)` (app.css:2629 + 2962) = rgba(255,255,255,.1) — Cairn is permanently in the styled 8px-scrollbar branch there (§5.12.4.2) and a macOS colour would be neither app\'s rendering of anything. On macOS, Obsidian\'s OWN rendering: `gray` = rgb(128,128,128) (`.mod-macos { --scrollbar-thumb-bg: gray }`, app.css:3028), re-measured live against the running app rather than the reference PNG\'s colour-managed #606060. Read from the token so it is asserted even where ::-webkit-scrollbar-thumb is not introspectable',
        function (h) { return rgb(cs(document.documentElement).getPropertyValue('--scrollbar-thumb') || cs(h.s).getPropertyValue('--scrollbar-thumb')); }),
      c('scrollbar thumb alpha', K.scrollbarThumbAlpha,
        'S the OTHER half of the row above, and the half that makes it mean anything: rgb() cannot tell a translucent white from opaque grey, so without this a regression to the wrong branch\'s colour passes. On Linux the translucency is the point — one token reads #383838 over the sidebar\'s #222222 and #333333 over the editor\'s #1c1c1c, the per-pane difference Obsidian has there. On macOS the native thumb is OPAQUE and that per-pane argument does not apply',
        function (h) { return alpha(cs(document.documentElement).getPropertyValue('--scrollbar-thumb') || cs(h.s).getPropertyValue('--scrollbar-thumb')); })
    ]);

    /* banner.absent (X9) — §3.3, WIDENED BY §0.12 E14. The banner was previously drawn by nobody
       and measured by nobody while it silently shortened the scroller spec-04 sizes its row pool
       from. The gate fixture trips NEITHER cap, so the harness asserts the un-bannered 881 band AND
       that zero banners exist — a capped vault is not a gate configuration.

       E14 ADDS A SECOND ABSENCE, and it has to be asserted rather than assumed. The watcher-degraded
       signal used to be an opacity change on a button, which could not move a band; it is now a 48px
       `.watch-degraded` bar in this same slot. Counting only `.cap-banner` would leave a gate run on
       a machine that had hit its inotify limit failing `tree band` at 833 with no row saying why. */
    row('banner.absent', SEL.banner[0] + ' + ' + SEL.watchBar[0] + ' (must not exist)', function () {
      var s = q('sideScroll');
      return {
        n: document.querySelectorAll(SEL.banner[0]).length,
        w: document.querySelectorAll(SEL.watchBar[0]).length,
        s: s
      };
    }, [
      c('cap banner count', 0,
        '§3.3/§5.11: the fixture trips neither the 50,000-node cap nor the 255-depth cap, so no banner may be drawn. A banner here means the fixture is wrong, not that the app is',
        function (h) { return h.n; }),
      c('watcher banner count', 0,
        '§7.3 case 16/§0.12 E14: the fixture vault is watched, so `nc://watch-degraded` never arrives and no bar may be drawn. One here means the HOST ran out of file-watch handles — the fixture is fine and the machine is not, and the 48px it costs is why `tree band` below would fail too',
        function (h) { return h.w; }),
      c('tree band with no banner', K.treeH,
        'D §3.3/§0.12 E14: the scroller is 875 − 24 x (cap banners) − 48 x (watcher bar) tall — 875 with none, 851 with one cap, 827 with both — and the vault bar does not move. This check is the coupling between them: it is the same 875 as tree.scroll, asserted against a DIFFERENT premise (nothing in the banner slot) rather than against the column sum',
        function (h) { return h.s ? R(h.s).height : null; }, true)
    ]);

    /* vault.bar — THE 43px BORDER-BOX MODEL. §5.10 R2's 37 WAS NEVER A MEASUREMENT: it is
       `winH 964 - rule 921`. RESOLVED 2026-09-09: winH is 964 and the rule is at 921.
       THE REFERENCE MEASURES THIS BAR AT 43 TOO, and reading it took two passes. macOS does not
       draw a 1px ring outside the window: three of the four edges are a ~20% WHITE WASH OVER THE
       OUTERMOST CONTENT PIXEL. Solve the alpha and it is one number — bottom row 994 reads 78 over
       the sidebar's 34, 73 over the editor's 28, 78 over the track's 39 (0.1991/0.1982/0.1991), the
       left column the same 0.1991 — and row 994 carries GLYPH INK at x700, which no frame line can.
       Only the top is real: row 30 is a flat #696969 everywhere. So the content box is rows 31..994
       and columns 0..1919 = 1920 x 964. Then: rule at screen y952 = content y921 (R2's one real
       measurement, right all along), bar 952..994 = 43, tree band 964 - 40 - 43 = 881 — the number
       the docs always carried. And 43 is exactly what Obsidian 1.13.7 computes from `height: unset`
       + 8px padding round a 26px `.clickable-icon` row (app.css:6319-6330 + 8010-8022), and what the
       user's own screen measures at 42.1 with its last row under the taskbar. Three sources, one
       number, no version-drift excuse.
       THAT ALSO CLOSES R2's "UNEXPLAINED 3px": a 43px bar at 921 has its 26px content row at
       930..955, centre 942.5 — R2's measured ink centre, to the tenth of a pixel.
       FIXED 2026-09-09, HAVING BEEN REPORTED HERE SINCE spike-O: `winH` was 6 short of 964 and `winW` 2 short of
       1920. Both are §5.5 gate constants; moving either moves every row in this file and needs a G9
       run — and that run has now been taken, twice, on macOS: 129/133 at winH 964 with editorW
       still 1506 (four WIDTH rows, all +2), then 133/133 once editorW became 1508. The column
       closes on itself either way (40 + 881 + 43 = 964), but only 964 closes on the REFERENCE.
       Still true and still the correction §5.10 R2 got right: the height INCLUDES the rule, so it is
       `box-sizing: border-box` or the sidebar column sums to 959. The ink-band row stays REMOVED —
       it is now derivable, but re-adding a row changes what G9 asserts and is not a comment fix. */
    row('vault.bar', SEL.vaultBar[0], function () {
      var bar = q('vaultBar');
      if (!bar) return null;
      // Descend through single-child wrappers: §5.5 draws one flex row, but a hover-able <button>
      // wrapper is permitted and does not move either box.
      var host = bar;
      for (var g = 0; g < 4 && host.children.length === 1; g++) host = host.children[0];
      var kids = [].slice.call(host.children);
      return { bar: bar, chev: kids[0] || null, label: kids[1] || null };
    }, [
      c('y (border box, incl. rule)', K.vaultBarY,
        'D: 964 − 43 = 921, painted as the bar\'s own border-top. The COLOUR is still §5.10 R2\'s measured #2f2f2f and is deliberately not moved to Obsidian 1.13.7\'s --tab-outline-color (#333333) — that is one row of §0.14.1\'s palette conflict, which is the user\'s call, not this pass\'s',
        function (h) { return R(h.bar).top; }, true),
      c('height (border box)', K.vaultBarH,
        'S+M: 1px rule + 8px pad + 26px content row + 8px pad = 921..963, bottom flush with 964. Obsidian app.css:6319-6330 + 8010-8022; confirmed on the user\'s screen at 42.1 CSS px',
        function (h) { return R(h.bar).height; }),
      c('box-sizing', 'border-box',
        'D §5.10 R2: this is the half of R2 that survives. With content-box, `height:43px` + a 1px border-top makes the sidebar column sum to 959',
        function (h) { return cs(h.bar).boxSizing; }),
      c('border-top', 1, 'M §5.10 R2: the rule is #2f2f2f, 1px', function (h) { return px(cs(h.bar).borderTopWidth); }),
      c('rule colour', '51,51,51', 'S: --bg-modifier-border -> --color-base-30 = #333333, the same base-30 as the strip and --tab-outline. WAS 47,47,47 (a framebuffer byte); the user\'s screenshot of this very rule measures 51', function (h) { return rgb(cs(h.bar).borderTopColor); }),
      c('background', '40,40,40', 'S §5.5: --bg-secondary #282828, same ground as the sidebar', function (h) { return rgb(cs(h.bar).backgroundColor); }),
      c('chevron box left', K.vbPadL,
        'M/D §5.11 + §5.5: chevrons-up-down in a 16px box at content x 16..32. It is now 8 (bar padding) + 8 (switcher padding) rather than one 16px bar padding — the same 16, reached the way Obsidian reaches it, which is why the switcher can start its hover box at x 8',
        function (h) { return h.chev ? R(h.chev).left : null; }),
      c('chevron box width', K.chevW,
        'D §5.5: 16px box; Lucide content is 10 units wide so ink runs x 20.1..27.9, centred on 24 (sx 25). The INK is not asserted — only the box',
        function (h) { return h.chev ? R(h.chev).width : null; }),
      c('label box left', K.vbLabelLeft,
        'S §5.5/§5.11: 8 (bar padding) + 8 (switcher padding) + 16 (chevron box) + 8 (gap, Obsidian --size-4-2 at app.css:6338) = 40. It WAS 38 on a 6px gap; Obsidian\'s gap is 8',
        function (h) { return h.label ? R(h.label).left : null; })
      /* NO ink-band check. §5.10 R2 de-gates it explicitly: the measured band sy 965..982 is the
         union of the 16px mask box and the 13px label plus ±1px antialias spill (16+1+1 = 18), but
         its CENTRE — content y 942.5, 3px below the 37px bar's interior centre of 939.5 — is
         reproduced by NO model, spec-01's or spec-04's. "A measurement that cannot be reproduced by
         any model is not a gate row." The residual is recorded as unexplained, not encoded. Do not
         re-add this check without a model that derives 942.5. */
    ]);

    /* ---- 5. THE TREE BOX MODEL (dispute B9, §5.2 = spike D verbatim) ------ */
    row('tree.row', SEL.treeRow[0] + ' (any)', function () { return qa('treeRow')[0]; }, [
      c('height', K.rowH, 'M §5.2: --row-h, the measured 27px row pitch. Rows are absolutely positioned inside the .sz sizer (§5.12.4), so the pitch is the box height', function (e) { return R(e).height; }),
      c('font-size', K.treeFs, 'M: glyph band 13px tall', function (e) { return px(cs(e).fontSize); }),
      c('colour', '179,179,179', 'M §5.1: #b3b3b3 = --text-muted, folders and files alike (the #aaaaaa peak is ink, not the token)', function (e) { return rgb(cs(e).color); }),
      c('ellipsis, not clip', 'ellipsis',
        'D §5.2: the row is spec-04\'s block-with-padding, NOT spec-01 §5.4\'s flex container — text-overflow:ellipsis does not apply to an anonymous flex item, so a flex row would clip long filenames hard instead of ellipsing',
        function (e) { return cs(e).textOverflow; })
    ]);

    row('tree.row.d0', SEL.treeRow[0] + '[data-d="0"]', function () { return rowAt(0); }, [
      c('text box left', K.textLeft(0),
        'M §5.2: text first-ink sx 37 at depth 0 (folder). Minus 1px left side bearing at 13px → content 35. NOT 38 (spec-04 §4.1 / spec-05 §8.1, both wrong by +3px at every depth): a box at 38 would put ink at sx >= 39, and ink can never appear LEFT of its box. The 38 came from VISUAL-MEASUREMENTS.md\'s printed formula 39+17d, which is chevron INK 22 + step 17 — an ink position wearing a box label',
        function (e) { return cl(e); }),
      c('padding-left', K.textLeft(0), 'D: the row has no left border, so padding-left is the text origin', function (e) { return px(cs(e).paddingLeft); }),
      c('guides painted', K.guidesW(0), 'D §0.48 E96: a depth-0 row has no ancestors; the box computes negative and max(0px, …) paints no indent guide', function (e) { return px(cs(e).backgroundSize.split(' ')[0]) || 0; })
    ]);

    row('tree.row.d1', SEL.treeRow[0] + '[data-d="1"]', function () { return rowAt(1); }, [
      c('text box left', K.textLeft(1), 'M §5.2: text first-ink sx 54 at depth 1, for BOTH a file and a folder', function (e) { return cl(e); }),
      /* §0.49 E97 — THE ROW THAT CAN ACTUALLY FAIL ON A WRONG STEP.
         `indent step` below compares a MAGNITUDE, so at a fractional scale the
         loose device-grid tolerance (0.82 CSS px at dpr 1.25) swallows the
         0.2px-per-level difference between a flat 17 and Obsidian's snapped
         16.8 — mutation-tested: reverting `--row-indent` to `17px` passed every
         one of the 134 checks. A BOOLEAN is not a magnitude and takes no
         tolerance, so this one catches it.
         The step is Obsidian's `margin 12 + border 1 + padding 4`; Cairn spells
         it as one padding, so the border term has to be snapped explicitly or
         the two apps diverge by a fifth of a pixel per level. */
      c('step == 16 + a snapped border', true,
        'D §0.49 E97: --row-indent is calc(16px + var(--hairline)), and --hairline is tied to a real 1px border by the titlebar row. Asserted as a RELATION because the numeric tolerance at fractional dpr is wider than the quantity',
        function (e) {
          var z = rowAt(0);
          if (!z) return null;
          var hair = parseFloat(root.getComputedStyle(root.document.documentElement).getPropertyValue('--hairline'));
          if (!isFinite(hair)) return null;
          return Math.abs((cl(e) - cl(z)) - (16 + hair)) < 0.001;
        }),
      c('indent step', K.step, 'M §5.1/§5.2: --row-indent 17px per depth level — and --row-indent is the ONE name for it (X1). `--ind` is DELETED: it does not exist anywhere in the app, not even as an alias. Measured here as text.left(d1) − text.left(d0)', function (e) { var z = rowAt(0); return z ? cl(e) - cl(z) : null; }),
      c('guides painted (1 x 17px period)', K.guidesW(1), 'M §0.48 E96: one guide at content 24 (sx 24); the box ends half a step past it so the next stripe cannot bleed', function (e) { return px(cs(e).backgroundSize.split(' ')[0]); })
    ]);

    row('tree.row.d3', SEL.treeRow[0] + '[data-d="3"]', function () { return rowAt(3); }, [
      c('text box left', K.textLeft(3), 'M §5.2: text first-ink sx 88 (and 89 on a second depth-3 file — that ±1 IS the side-bearing signature, and is why 35+17d fits and 38+17d cannot)', function (e) { return cl(e); }),
      c('padding-left', K.textLeft(3), 'D §5.2: --tx0 + --d * --row-indent = 35 + 17x3', function (e) { return px(cs(e).paddingLeft); }),
      c('guides painted (3 x 17px period)', K.guidesW(3), 'M §0.48 E96: three guides at content 24 / 41 / 58, box ends half a step past the last', function (e) { return px(cs(e).backgroundSize.split(' ')[0]); })
    ]);

    row('tree.parity', 'file vs folder at the same depth', function () {
      var f = rowAt(1, 'file'), d = rowAt(1, 'folder');
      return (f && d) ? { f: f, d: d } : null;
    }, [
      c('text origins identical', 0,
        'M §5.2: d1 file ink sx 54 == d1 folder ink sx 54; d2 file 71 == d2 folder 71. A file carries the same padding-left, so the chevron slot is present on files too as an invisible spacer. Reproduced for free at depths 1 and 2',
        function (h) { return cl(h.f) - cl(h.d); })
    ]);

    row('tree.chevron', SEL.folderRow[0] + ' > .chev', function () {
      var r0 = rowAt(0, 'folder'), r2 = rowAt(2, 'folder');
      var b0 = chev(r0);
      return b0 ? { r0: r0, b0: b0, b2: chev(r2) } : null;
    }, [
      c('centre at depth 0', K.chevCentre(0),
        'M §5.2: chevron first-ink sx 22. For a lucide chevron-right (viewBox 24, stroke 2, round caps) ink starts S/3 into the box and the centre is S/2, so ink sits S/6 ~ 2px left of centre → centre = content 23. Independently: 23 is the MEASURED indent-guide x (sx 24). Two measurements, one answer. stroke-width is 2, NOT spec-04\'s 3 (sw:3 predicts sx 21)',
        function (h) { return h.b0.centre; }),
      c('centre at depth 2', K.chevCentre(2), 'M §0.48 E96: chevron ink sx 56, guide sx 58 == content 58', function (h) { return h.b2 ? h.b2.centre : null; }),
      c('slot width', K.chevW,
        'C §5.2: the icon SIZE is a free parameter — only the centre (23+17d) and the text origin (35+17d) are pinned. 16px is chosen to match every other icon in spec-01 §8; a 12px chevron would work equally well at --cx0:17 with a 6px gutter. spec-04\'s 12px is STRUCK (§5.1 rule 5)',
        function (h) { return h.b0.width; }),
      c('box left at depth 0', K.chevLeft(0), 'D §5.2: --cx0 = --gx0 − --chev-w/2 = 24 − 8 = 16 (§0.48 E96)', function (h) { return h.b0.left; }),
      c('gutter to text', K.gut, 'D §5.2: --gut = --tx0 − --cx0 − --chev-w = 35 − 15 − 16. Falls out once the slot width is chosen', function (h) { return cl(h.r0) - (h.b0.left + h.b0.width); }),
      c('mask colour', '102,102,102',
        'M §5.1: --text-faint #666666. spec-04\'s #8a8a8a is STRUCK. The chevron is a -webkit-mask (which recolours on hover; a background-image cannot), and its data URL is the --chev TOKEN in tokens.css, NOT one of icons.ts\'s 11 literals (X2)',
        function (h) { return rgb(cs(h.b0.el).stroke); }),
      c('no transition', 'none',
        'D §5.1 rule 5: no transitions, no animations, anywhere. spec-04 §4.3\'s `transition: transform 100ms ease` on the chevron is STRUCK. Asserted as "nothing animates" (every duration and delay is 0), never as one spelling of it — see noTransition(): the old literal `all 0s ease 0s` failed the shipping app, whose global `transition: none !important` computes transition-property `none`',
        function (h) { return noTransition(cs(h.b0.el)); })
    ]);

    row('tree.guides', SEL.treeRow[0] + ' background', function () {
      var r = rowAt(2) || rowAt(1);
      var f = rowAt(0, 'folder');
      return r ? { r: r, chevron: chev(f) } : null;
    }, [
      c('first guide x', K.gx0, 'M §0.48 E96: sx 24 / 41 / 58 ARE content 24 / 41 / 58 — spike O struck the 1px frame correction. Live Obsidian measures device 30 / 51 / 72 at dpr 1.25', function (h) { return px(cs(h.r).backgroundPositionX); }),
      c('guide colour', '255,255,255', 'S §5.1: --indent-guide is now Obsidian\'s own --indentation-guide-color, color-mix(in oklch, white 12%, transparent) = rgba(255,255,255,.12), so the CHANNELS are white and the alpha row below carries the rest. WAS the opaque 56,56,56 — which is exactly what 12% white over 1.12.7\'s #262626 decodes to, so the old literal was right about the pixel and wrong about the model', function (h) { var m = cs(h.r).backgroundImage.match(/rgba?\([^)]*\)/); return rgb(m ? m[0] : ''); }),
      c('guide alpha', 0.12,
        'S the other half of the row above: rgb() cannot tell rgba(255,255,255,.12) from opaque white, so without this an opaque regression passes. Same trap the scrollbar-thumb pair documents',
        function (h) { var m = cs(h.r).backgroundImage.match(/rgba?\([^)]*\)/); return alpha(m ? m[0] : ''); }),
      c('guide k sits on the depth-k chevron centre', 0,
        'D §5.2: this single coincidence is what fixes the chevron box. If it fails, the tree is the 3px-per-level wrong one',
        function (h) { return h.chevron ? h.chevron.centre - px(cs(h.r).backgroundPositionX) : null; })
    ]);

    /* ---- 6. editor content column (§5.3) --------------------------------- */
    row('cm.scroller', SEL.scroller[0], function () { return q('scroller'); }, [
      c('padding-left', K.insetX, 'M §5.3 + spike Q: 412 + 32 (--editor-inset-x) = 444. The sx 446 ink reading is one px right of the box edge', function (e) { return px(cs(e).paddingLeft); }),
      c('padding-right', K.insetX, 'D §5.3: symmetric with the left inset (residual R1 — derived, not measured). WAS forced arithmetically by 1918−412−8−33−1432 = 33; spike Q retires that arithmetic, because the 1432 it leans on is an INK-to-ink reading of a 1434px box', function (e) { return px(cs(e).paddingRight); }),
      c('padding-top', K.insetY, 'D §5.3 + spike Q: --editor-inset-y 32px (Obsidian --file-margins-y, app.css:2244). WAS 30 and tagged [M]; it was never measured -- spec-01-visual.md:709 designates it a FIT parameter. spec-03 §8.2\'s 24px is STRUCK, as is putting the padding on .cm-content instead of .cm-scroller', function (e) { return px(cs(e).paddingTop); }),
      c('padding-bottom', 0,
        'D §5.3: spec-03\'s `30vh` bottom padding is STRUCK — unmeasured, it changes the scroll height this probe asserts, and it makes the thumb lie about document length. Recorded as a deliberate functional gap: the last line does not scroll to mid-pane',
        function (e) { return px(cs(e).paddingBottom); }),
      c('overflow-y', 'scroll',
        'C §5.3: reserve the gutter ALWAYS. §5.12.4.1 confirms this is unchanged by the layer ruling — the flag route sets one WebKit preference and touches no DOM and no CSS, so .cm-scroller stays a real scroller and CM6\'s scrollIntoView, viewport virtualisation, selection autoscroll, keyboard paging and smooth-scroll easing all stay the platform\'s',
        function (e) { return cs(e).overflowY; }),
      c('scrollbar gutter reserved', K.edGutterW,
        'S §0.37 E84: 12px, Obsidian\'s own --scrollbar-width (app.css:2623), reserved unconditionally by scrollbar-gutter: stable in both apps. WAS 8 -- the sidebar\'s number, applied here on the argument that only the VISIBLE thumb matters (7px in both) and that the rest is invisible track. It is invisible and it is not free: it comes out of .cm-content, so it is 4px off the column every line wraps in, which is how the user found it. LOAD-BEARING TWICE OVER — (a) geometry: this is the 8px that turns a 1442px content column into the 1434px code box (was 1440->1432 at a 33px inset), and left to overflow-y:auto the column jumps 8px between a short note and a long one; (b) memory (§5.12.4.2): the ::-webkit-scrollbar rule MUST name .cm-scroller and never #ed or any ancestor, because a rule on the ancestor does not reach CM6\'s real scroller, which then inherits the 17px legacy scrollbar and measures 1.57x the bare backing store instead of 1.00x — ~7 MB at 2x and a G5d failure',
        function (e) { return gutterOf(e); })
    ]);

    row('cm.line', SEL.line[0] + ' (body)', bodyLine, [
      c('x', K.lineLeft, 'M §5.3 + spike Q: content left edge is 412 + 32 = 444; the sx 446/445 readings are ink and caret, one px right of the box', function (e) { return R(e).left; }),
      c('width', K.lineW, 'D §5.3 + spike Q: 1506 pane − 8 scrollbar − 64 inset = 1434. The 1432 "measured in 2.png" is INK-to-ink across this box, and 2.png no longer exists', function (e) { return R(e).width; }, true),
      c('font-size', 16, 'M: glyph bands 151–166, 175–190, 199–214', function (e) { return px(cs(e).fontSize); }),
      c('line-height', 24, 'M: 24px start-to-start between body lines', function (e) { return px(cs(e).lineHeight); }),
      c('vertical margin', 0, 'M §5.3: a blank markdown line is exactly one 24px empty line (sy 214→247 = 48 = 2x24); paragraphs get no extra margin. .cm-content, .cm-line { padding:0; margin:0 }', function (e) { return px(cs(e).marginTop) + px(cs(e).marginBottom); })
    ]);

    /* ---- 7. THE INLINE TITLE (X18, §5.4.2) ------------------------------- */
    /* Previously unruled. The reference is consistent with an inline title and not with a document
       H1: the tab reads "Misc", the ink at sy 107..127 reads "Misc", and no `#` is visible anywhere.
       Mechanically it is a CM6 BLOCK WIDGET at document position 0 — not a DOM node injected into
       .cm-scroller by hand — because a widget stays inside CM6's own layout and height map, which is
       what keeps the first body line's box top exact. It is never in state.doc, never saved, never
       sent to write_note. Nothing below reads glyph ink: §5.4.2's ink rows (cap top 75.98, band
       76..96) are the reconciliation against the measured sy 107..127 and are NOT assertable here. */
    row('title', SEL.title[0], function () {
      var t = q('title');
      var ls = qa('line');
      return t ? { t: t, first: ls[0] || null } : null;
    }, [
      c('box top', K.titleTop,
        'D §5.4.2 + spike Q: strip 40 + --editor-inset-y 32 = 72. WAS 70 on an inset of 30, which spec-01-visual.md:709 designates as a FIT parameter and which had been nudged to cancel out --h1-size being 29. Obsidian\'s own --file-margins-y is 32 (app.css:2244)',
        function (h) { return R(h.t).top; }),
      c('box height', K.titleH,
        'D §5.4.2 + spike Q: --h1-size 1.618em = 25.888px x --h1-lh 1.2 = 31.0656, box 72..103.0656. WAS 34.8 on a 29px H1. (LayoutUnit quantises; EPS covers it)',
        function (h) { return R(h.t).height; }),
      c('font-size', K.h1Size, 'M §5.4 + spike Q: --h1-size is 1.618em (Obsidian app.css:2327) resolving to 25.888px against .cm-content\'s 16px. WAS 29px, inverted from a 21px ink band through INTER\'s cap ratio on a screenshot that never rendered Inter. Its tokens are the H1 tokens, but it is NOT an <h1> — it is .nc-title and it consumes them', function (h) { return px(cs(h.t).fontSize); }),
      c('font-weight', K.h1Weight, 'M §5.4: --h1-weight 700. spec-03 §8.3\'s 28.8px / line-height 1.3 / H2 weight 700 are STRUCK', function (h) { return px(cs(h.t).fontWeight); }),
      c('line-height', K.titleH, 'D §5.4 + spike Q: --h1-lh 1.2 on 25.888px, resolved to 31.0656. --lh-tight is STRUCK: Obsidian\'s line-heights are per level (1.2/1.2/1.3/1.4/1.5/1.5, app.css:2321-2326), not one flat value', function (h) { return px(cs(h.t).lineHeight); }),
      c('margin-bottom', K.titleSpace,
        'M 2026-09-09: --inline-title-space-after 12.944px, applied as margin-bottom. It was --h1-space-after 10px until then; that token is a BODY-heading token and still governs .nc-h1. spec-03\'s "No margins on heading lines" is STRUCK — this margin is LOAD-BEARING for the measured geometry',
        function (h) { return px(cs(h.t).marginBottom); }),
      c('colour', '218,218,218', 'M §5.4.2: --text-normal #dadada', function (h) { return rgb(cs(h.t).color); }),
      c('x', K.lineLeft, 'M §5.4.2 + spike Q: it sits in the same line box as body text — now 1434px at origin 444 (was 1432 at 445)', function (h) { return R(h.t).left; }),
      c('width', K.lineW, 'D §5.4.2 + spike Q: the same 1434px line box as body text (was 1432)', function (h) { return R(h.t).width; }, true),
      c('document first line box top', K.firstLineTop,
        'M 2026-09-09 + D: 72 + 31.0656 + 12.944 = 116.0096. The 10 was --h1-space-after, which is a BODY-heading token; Obsidian gives .inline-title its own --inline-title-margin-bottom and its computed value is 12.944. The old 114.8 quoted "cap top 119.98 matches measured sy 151 exactly" as confirmation; it was not — two knobs fitted to two ink targets (spec-01-visual.md:709) cannot fail, and those ink figures were Inter\'s and are stale since 501abc7. §5.11\'s fixture MUST NOT open a note that begins with a heading, or this band is an H1 box and not a body box and the row is meaningless',
        function (h) { return h.first ? R(h.first).top : null; }),
      c('title box + margin == first line top', 0,
        'D §5.4.2: the same arithmetic asserted as a RELATION, so it still holds if the H1 tokens are ever retuned — the title must consume exactly the box the first line then starts below',
        function (h) { return h.first ? R(h.first).top - (R(h.t).bottom + px(cs(h.t).marginBottom)) : null; }),
      c('title is inside .cm-content', 1,
        'D §5.4.2: a block widget decorated at position 0, NOT a hand-injected node in .cm-scroller. If it is outside .cm-content, CM6\'s height map does not know about it and the 113.0656 above holds only by luck',
        function (h) { var c2 = q('content'); return b(c2 && c2.contains(h.t)); })
    ]);

    /* ---- 8. HEADING MARKERS (X17, §5.4.1) -------------------------------- */
    /* Previously unruled: spec-01 §3 implied dimmed-and-visible, spec-03 recommended never
       revealing, and the reference only shows the caret-elsewhere case. Ruled: hidden by default,
       revealed in --text-faint on the heading line the caret is on. The '#'xN AND THE SINGLE
       FOLLOWING SPACE are one Decoration.replace, so the heading's text starts at the content inset
       like a body line. Only the marker run is affected: no font change, no background, no gutter.
       The same rule governs no other syntax — **bold**, _em_, list bullets and fence backticks are
       NOT hidden in v1, so there is nothing to reveal. */
    row('heading.marker.hidden', SEL.heading2[0] + ' with the caret in the body', function () {
      var h = headingLine(), body = bodyLine();
      if (!h || !body) return null;
      return {
        h: h, body: body,
        markers: document.querySelectorAll(SEL.marker[0]).length,
        textLeft: textStartLeft(h),
        bodyLeft: R(body).left
      };
    }, [
      c('the fixture line is an H2', '23.392,680',
        'M §5.4/§5.11 + spike Q: the fixture guarantees at least one `## ` heading below the fold. --h2-size 1.462em = 23.392px / --h2-weight 680. WAS 26,600 — the 600 came from Obsidian\'s :root FALLBACK weights (app.css:2001-2008), which Chromium never takes; its @supports branch (app.css:2010-2018) gives 680. Asserted so a missing heading cannot silently pass by matching a body line',
        function (h) { var s = cs(h.h); return px(s.fontSize) + ',' + px(s.fontWeight); }),
      c('marker count in the viewport', 0,
        '§5.4.1 rule 1 + §5.11: with the caret parked in the body, every ATX heading line carries a Decoration.replace over its marker run and NO .nc-md-marker exists anywhere',
        function (h) { return h.markers; }),
      c('heading line box x', K.lineLeft, 'D §5.3: the line box is the body line box; only its contents differ', function (h) { return R(h.h).left; }),
      c('heading text starts at the content inset', K.lineLeft,
        '§5.4.1 rule 1: the replace covers the `#`xN AND the single following space, so the heading\'s text starts exactly where a body line\'s does. Read as a Range POSITION over the first character, never as an advance',
        function (h) { return h.textLeft; }),
      c('heading text origin == body text origin', 0,
        '§5.11: "the `## ` heading line\'s text box left edge equals a body line\'s". Asserted as a difference so it survives any future change to the 445',
        function (h) { return h.textLeft - h.bodyLeft; })
    ]);

    row('heading.marker.shown', SEL.marker[0] + ' with the caret on the heading', function () {
      var h = headingLine(), body = bodyLine();
      if (!h || !body) return null;
      var view = cmView();
      var saved = null;
      // The focused element as well as the selection: `caretTo` now focuses the
      // view, and §5.11's fixture must be handed back exactly as it was found.
      var savedFocus = null;
      try { savedFocus = document.activeElement; } catch (e) { savedFocus = null; }
      try { saved = view ? { anchor: view.state.selection.main.anchor, head: view.state.selection.main.head } : null; } catch (e) { saved = null; }
      var snap = null;
      try {
        var landed = caretTo(view, h);
        var m = h.querySelector(SEL.marker[0]);
        if (!landed && !m) return null;          // could not drive the caret → SKIP, never a green 0
        snap = {
          markers: document.querySelectorAll(SEL.marker[0]).length,
          left:  m ? R(m).left  : null,
          right: m ? R(m).right : null,
          width: m ? R(m).width : null,
          colour: m ? rgb(cs(m).color) : null,
          bgAlpha: m ? alpha(cs(m).backgroundColor) : null,
          fs: m ? px(cs(m).fontSize) : null,
          fw: m ? px(cs(m).fontWeight) : null,
          hfs: px(cs(h).fontSize),
          hfw: px(cs(h).fontWeight),
          trans: m ? noTransition(cs(m)) : null,
          textLeft: textStartLeft(h),
          bodyLeft: R(body).left
        };
      } finally {
        // Put the fixture back exactly as §5.11 requires it: caret in the body, never on a heading.
        try {
          if (view && saved) view.dispatch({ selection: { anchor: saved.anchor, head: saved.head } });
          else caretTo(view, body);
          if (savedFocus && savedFocus !== document.activeElement && savedFocus.focus) savedFocus.focus();
        } catch (e) { /* reported by the next row that reads a heading */ }
      }
      return snap;
    }, [
      c('marker count', 1,
        '§5.4.1 rule 2 + §5.11: "exactly one .nc-md-marker". A heading line reveals its marker when the PRIMARY selection intersects that line — an empty selection on the line, or a range that touches it',
        function (h) { return h.markers; }),
      c('marker colour', '102,102,102',
        '§5.4.1 rule 2 + §5.11: --text-faint #666666 = rgb(102,102,102)',
        function (h) { return h.colour; }),
      c('marker background alpha', 0,
        '§5.4.1 rule 2: "no background". Asserted as the ALPHA channel, because rgb() cannot tell transparent from opaque black — both read (0,0,0)',
        function (h) { return h.bgAlpha; }),
      c('marker no transition', 'none',
        '§5.4.1 rule 2 + §5.1 rule 5: "no transition". A revealed marker must not fade in. Asserted as "nothing animates" (every duration and delay is 0) rather than as the literal `all 0s`, which failed the shipping app\'s `transition: none !important` — see noTransition()',
        function (h) { return h.trans; }),
      c('marker takes the heading\'s own size and weight', 0,
        '§5.4.1 rule 2: the marker is drawn at "the heading\'s own font-size and weight". Asserted as a difference against the line it sits on, so it holds for any heading level',
        function (h) { return (h.fs - h.hfs) + (h.fw - h.hfw); }),
      c('marker sits at the content inset', K.lineLeft,
        'D §5.4.1 rule 3: the revealed run starts where the hidden run\'s replacement started — at the body text origin — and pushes the heading text right of it',
        function (h) { return h.left; }),
      c('reveal occupies layout (marker width > 0)', 1,
        '§5.4.1 rule 3: "Reveal occupies layout: the heading\'s text shifts right by the marker\'s advance while the caret is on it, exactly as Obsidian does." A zero-width marker would mean the reveal was drawn as an overlay, which the ruling forbids',
        function (h) { return b(h.width > EPS); }),
      c('heading text shifted right of the body origin', 1,
        '§5.11: "the heading line\'s text box left edge is GREATER THAN 445 (the shift is by design; its magnitude is font-dependent and is not asserted)". This file asserts the sign, never the magnitude — that is the whole font-insensitivity rule',
        function (h) { return b(h.textLeft > h.bodyLeft + EPS); }),
      c('shift == the marker\'s own advance', 0,
        'D §5.4.1 rule 3: the text starts exactly at the marker\'s right edge. Asserted as a RELATION between two measured boxes, so it is font-independent even though each side alone is not',
        function (h) { return h.textLeft - h.right; })
    ]);

    /* ---- 9. THE CODE BLOCK BOX MODEL (dispute B8, §5.3) ------------------ */
    row('cm.code', SEL.codeLine[0], function () { var l = qa('codeLine'); return l.length ? l : null; }, [
      c('margin-left', 0,
        '§5.3: the overhang model is REFUTED on four grounds. spec-03 §8.4\'s `margin: 0 -16px` derived from a 41px right ribbon that VISUAL-MEASUREMENTS.md contradicts ("Editor: x 413..1919, bg #1c1c1c" — a 41px ribbon at sx 1879..1919 would have stopped the sample at 1878)',
        function (l) { return px(cs(l[0]).marginLeft); }),
      c('margin-right', 0, '§5.3: a −16px right margin also makes the line box wider than .cm-content, giving every note with a code block a phantom 16px horizontal scroll (see the `window` row)', function (l) { return px(cs(l[0]).marginRight); }),
      c('padding-left', K.codePadX, 'M §5.3: the monospace cell grid solves the text origin to crop x=30 against a box left edge of 14 → 16px', function (l) { return px(cs(l[0]).paddingLeft); }),
      c('padding-right', K.codePadX, 'D §5.3: symmetric with the measured 16px left padding; the fill spans the full 1434px line box either way, so only the left is directly measurable', function (l) { return px(cs(l[0]).paddingRight); }),
      c('vertical padding', 0, 'M §5.3: 3 lines x 21px = 63px = the measured box height (crop y 24..86) exactly, which is what proves the vertical padding is zero', function (l) { return px(cs(l[0]).paddingTop) + px(cs(l[0]).paddingBottom); }),
      c('box left == body line left', K.lineLeft, 'D §5.3: the visible consequence of margin 0 — the tinted box starts where body text starts', function (l) { return R(l[0]).left; }),
      c('box width', K.lineW, 'M §5.3 + spike Q: 2.png\'s box x 14..1445 = 1432px is an INK reading; the box is 1434 at a 32px inset', function (l) { return R(l[0]).width; }, true),
      c('TEXT sits 16px right of body text', K.codeTextLeft,
        'D §5.3 + spike Q: 444 + 16 = 460 (was 445 + 16). THIS is the visible difference between the two disputed models: non-overhang indents the code text, overhang would have kept it flush at the line origin',
        function (l) { return cl(l[0]); }),
      c('font-size', K.codeFs, 'M §5.3: advance 8.370px (a 3-decimal fit over four dot centroids: 8.357/8.369/8.383) ÷ 0.6em → 13.95 → 14. Rejects spec-03\'s 13.8px, which also cannot give the measured 21.000 pitch', function (l) { return px(cs(l[0]).fontSize); }),
      c('line-height', K.codeLh, 'M §5.1/§5.3: backtick y-centroids on lines 1 and 3 at 28.46 and 70.46 → 42.00/2 = 21.000. --lh-code is the INTEGER 21px, never `1.5` (X4) — 14x1.5 must not be re-derived at render time and drift sub-pixel', function (l) { return px(cs(l[0]).lineHeight); }),
      c('background', '35,35,35', 'S §5.1: --bg-primary-alt = --code-background -> --background-primary-alt -> --color-base-10 = #232323. WAS 33,33,33, the framebuffer byte of 1.12.7\'s #242424', function (l) { return rgb(cs(l[0]).backgroundColor); }),
      c('border', 0, 'M §5.3: no ring of intermediate colour around the fill', function (l) { return px(cs(l[0]).borderTopWidth); })
    ]);

    row('cm.code.first', SEL.codeFirst[0], function () { return q('codeFirst'); }, [
      c('radii TL,TR,BR,BL', '4,4,0,0',
        'M §5.3: --radius-s 4px. The corner ramp reaches full fill over a 4px arc in both axes; the bottom-right mirrors it. Only the first and last lines round (.nc-cb-first / .nc-cb-last / .nc-cb-only), which is what makes the per-line fill read as one box',
        function (e) { var s = cs(e); return [s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomRightRadius, s.borderBottomLeftRadius].map(px).join(','); })
    ]);

    row('cm.code.fence', 'the ```sh fence lines', function () { var l = qa('codeLine'); return l.length >= 3 ? l : null; }, [
      c('fence colour == body colour', 0,
        'M §5.3: peak ink 213 on the backticks, on the "sh", and on the code body alike; the em-dash (a solid bar, so it reaches full value) peaks at 219 ~ #dadada. Both specs\' "fences are dimmer" guesses and VISUAL-MEASUREMENTS.md\'s "dimmer fence colour" prose are STRUCK — there is no dimming',
        function (l) { return rgb(cs(l[0]).color) === rgb(cs(l[1]).color) ? 0 : NaN; }),
      c('fence sits inside the tinted box', 0,
        'M §5.3: one class on every line of the block, opening fence to closing fence INCLUSIVE. A 3-line block is exactly 3 x 21px tall, so the two fence lines are two of those three tinted lines',
        function (l) { return rgb(cs(l[0]).backgroundColor) === rgb(cs(l[1]).backgroundColor) ? 0 : NaN; }),
      c('no syntax highlighting inside the block', 0,
        'M/C §5.3 + §9 E4: the reference has a few Prism-coloured pixels; code-block syntax highlighting is one of the four contested elements the user OMITTED, so every line in the block is one colour. No inert decoration',
        function (l) { return rgb(cs(l[1]).color) === rgb(cs(l[2]).color) ? 0 : NaN; })
    ]);

    /* ---- 10. THE LAYER ARCHITECTURE (§5.12) ------------------------------ */
    /* The flag route ships: one WebKit preference (AsyncOverflowScrollingEnabled = NO) set once at
       startup, with NO DOM change, NO CSS change and NO JavaScript. So this row does not assert a
       different scroller — it asserts that the shipping document still has EXACTLY the two the
       contract allows. The promotion rule, established by a 24-candidate sweep with the layer tree
       read directly after every variant: "a box gets its own compositing surface if and only if it
       is scrollable AND its content overflows. Nothing else about the box matters." So a third
       scrollable box is a ~23.5 MB regression at 2x, and it fails HERE as well as at G5d — which is
       the only reason a geometry probe carries a memory row at all. Nothing below reads a byte
       count or devicePixelRatio: the memory measurement lives in measure-memory.sh --layers. */
    row('layers.scrollers', 'every RENDERED element in the document', function () {
      var all = document.querySelectorAll('*'), hits = [];
      for (var i = 0; i < all.length; i++) {
        var s = cs(all[i]);
        if (!(SCROLLABLE.test(s.overflowX) || SCROLLABLE.test(s.overflowY))) continue;
        /* RENDERED-BOX FILTER (ruling, gate G9).  An element that generates no box
           cannot be a scroller and cannot own a compositing surface, so counting it
           here contradicted the very promotion rule this row exists to enforce:
           "scrollable AND its content overflows". A display:none box has no content
           box at all, so it satisfies neither conjunct.

           This was a LIVE false failure, not a hypothetical. src/search.ts:637 opens
           the panel with `this.tree.hidden = true` and mounts `.sr-list`, so with
           search open the document holds .cm-scroller + .sr-list + a display:none
           .tree-scroller. getComputedStyle still resolves `overflow:auto` on a
           display:none element -- computed style is not rendering -- so the old
           collector read 3 and failed a document that is exactly right. §5.11's
           "whichever of .tree-scroller / .search-scroller is LIVE" is the contract's
           own word for this filter; it just was not implemented.

           getClientRects().length is the test the ruling names, and it is the correct
           one: it is zero for display:none and for any non-rendered subtree, while
           staying non-zero for a scroller that is merely scrolled out of view,
           clipped, transparent, or covered -- all of which DO own surfaces. Note that
           an empty-but-rendered scroller keeps a rect, so the ceiling of two is still
           asserted against every box that genuinely exists. */
        if (all[i].getClientRects().length === 0) continue;
        hits.push(all[i]);
      }
      return { hits: hits, se: document.scrollingElement || document.documentElement };
    }, [
      c('scrollable box count', 2,
        '§5.12.4 + §5.11: the whole document has exactly two scrollable boxes THAT RENDER A BOX (see the collector: a display:none scroller has no box and no surface, and §5.11 says "whichever ... is LIVE"). .tree-scroller and .search-scroller are never live at the same time — the search panel REPLACES the tree in the sidebar (§4.5) — so the ceiling is two, not three. §5.12.4.3: menus, popovers, the tab strip, the vault bar and both §3.3 cap banners must fit or clip (single-line + text-overflow:ellipsis), which §3.3 already required for layout and which is now also a memory rule',
        function (h) { return h.hits.length; }),
      c('which two', 'cm-scroller + sidebar-scroller',
        '§5.11: ".cm-scroller and whichever of .tree-scroller / .search-scroller is live". Both sidebar scrollers normalise to one name here because either is correct and the fixture decides which',
        function (h) {
          return h.hits.map(function (e) {
            if (is(e, 'scroller')) return 'cm-scroller';
            if (is(e, 'sideScroll')) return 'sidebar-scroller';
            var cn = String(e.className || '').trim();
            return e.tagName.toLowerCase() + (cn ? '.' + cn.split(/\s+/).join('.') : '');
          }).sort().join(' + ');
        }),
      c('main frame does not scroll', 0,
        '§5.12.5, normative: `html, body { overflow: hidden; height: 100% }` and no layout may make the document scrollable. Measured, from the rejected page-scroll variant: a main frame that CANNOT scroll is tiled to exactly its viewport (overdraw 1.00x at every size); the moment it scrolls it takes overdraw like any other scroller and at 1600x1000 it takes 3.28x where a subscroller takes 1.64x. That variant measured 4.25x against a 2.96x baseline — 44% WORSE than the baseline it was meant to beat — and it was also unstable (3.88 MB and 7.00 MB for the identical page at the identical size). position:fixed does not rescue it and position:sticky earns the sidebar its own backing store on top',
        function (h) { return h.se.scrollHeight - h.se.clientHeight; }),
      c('html overflow-y', 'hidden', '§5.12.5, verbatim: `html, body { overflow: hidden; height: 100% }`. Asserted on the element as well as through scrollHeight, because a document can be non-scrolling today and scrollable the moment one banner grows', function () { return cs(document.documentElement).overflowY; }),
      c('body overflow-y', 'hidden', '§5.12.5, verbatim. Both elements are named in the ruling and both are asserted: `overflow:hidden` on html alone still lets body scroll in some quirks paths', function () { return cs(document.body).overflowY; }),
      c('body fills the viewport', 0,
        '§5.12.5: `height: 100%`. Size-independent — asserted against the live innerHeight, not against 964',
        function () { return document.body.clientHeight - root.innerHeight; }),
      c('independent pane scroll offsets survive', 1,
        '§5.12.1: the price §9 E3 agreed to pay does NOT materialise under the flag route — the two panes keep independent scroll positions and both keep their own 8px #606060 scrollbars, and §5.2\'s and §5.3\'s box models survive verbatim. Asserted structurally: the two scrollers are disjoint, so neither can be the other\'s ancestor',
        function (h) {
          if (h.hits.length !== 2) return 0;
          return b(!h.hits[0].contains(h.hits[1]) && !h.hits[1].contains(h.hits[0]));
        })
    ]);

    return T;
  }

  /* ========================================================================= */
  function verify(options) {
    var opts = options || {};
    var gate = !!opts.gate;
    /* §0.49 E97 — RE-SEAT THE STEP FROM THE PAGE, BEFORE buildTable(), because
       every `c(...)` computes its expected value the moment the table is built.
       A CSS-px read of a custom property, exactly like every other read here;
       nothing consults devicePixelRatio.  Falls back to the design values when
       the property is absent, which is what `selfTest()` runs on. */
    try {
      var hairRaw = parseFloat(
        root.getComputedStyle(root.document.documentElement).getPropertyValue('--hairline')
      );
      if (isFinite(hairRaw) && hairRaw > 0 && hairRaw <= 1) {
        K.hairline = hairRaw;
        K.step = 16 + hairRaw;
      }
    } catch (e) { /* no DOM: keep the design values */ }
    /* 2026-09-15 — RE-SEAT `K.rowH` THE SAME WAY, and for the same reason: it
       was 27, a round number assumed since spike D, and the live row is
       26.890625 on this Mac — `chrome.ts`'s `applyRowH` measures it from
       Obsidian's own font-size/line-height/padding/margin (app.css:10353-364)
       rather than hardcoding what one machine's font metrics gave.  Re-seating
       here is what lets G9 assert the ENGINE'S number instead of quietly
       failing every row-height check on a font this table never saw. */
    try {
      var rowHRaw = parseFloat(
        root.getComputedStyle(root.document.documentElement).getPropertyValue('--row-h')
      );
      if (isFinite(rowHRaw) && rowHRaw > 20 && rowHRaw < 40) {
        K.rowH = rowHRaw;
      }
    } catch (e) { /* no DOM: keep the design value */ }
    /* 2026-09-15 — the scrollbar thumb is now PER-PLATFORM (user ruling: match
       Obsidian's macOS look, keep its Linux styled-branch look).  `K.scrollbarThumbRGB`
       and `K.scrollbarThumbAlpha` pick the design values for THIS platform's
       `data-os`, the same signal chrome.ts's own `applyPlatform` reads — a
       literal branch, not a second read of the token being tested, or the row
       would only ever confirm getPropertyValue can echo itself. */
    try {
      var isLinux = root.document.documentElement.getAttribute('data-os') === 'linux';
      K.scrollbarThumbRGB = isLinux ? '255,255,255' : '128,128,128';
      K.scrollbarThumbAlpha = isLinux ? 0.1 : 1;
    } catch (e) { /* no DOM: keep the design (macOS) values below */ }
    var T = buildTable();
    var out = [], pass = 0, fail = 0, skip = 0, rowsSkipped = 0;
    var dprNow = root.devicePixelRatio || 1;
    var viaDevicePx = 0;
    var GATE_NOTE = 'gate-only check; call with {gate:true} on a ' + K.winW + 'x' + K.winH + ' window';

    T.forEach(function (r) {
      var handle = null, why = '';
      if (r.gate && !gate) { why = GATE_NOTE; }
      else {
        try { handle = r.need(); } catch (e) { why = e.message; }
        if (!handle) why = why || 'element or fixture missing (' + r.sel + ')';
      }

      if (!handle) {
        rowsSkipped++;
        r.checks.forEach(function (k) {
          skip++;
          out.push({ row: r.id, check: k.name, status: 'SKIP', expect: k.expect, got: null, from: k.from, note: why });
        });
        return;
      }

      r.checks.forEach(function (k) {
        var got, note = '', status, via = null;

        if (k.gate && !gate) {
          skip++;
          out.push({ row: r.id, check: k.name, status: 'SKIP', expect: k.expect, got: null, from: k.from, note: GATE_NOTE });
          return;
        }

        try { got = k.get(handle); } catch (e) { got = undefined; note = e.message; }

        if (got === null || got === undefined) {
          status = 'SKIP'; skip++; note = note || 'not measurable in this fixture';
        } else if (typeof k.expect === 'number') {
          via = admits(got, k.expect, dprNow);
          status = via ? 'PASS' : 'FAIL';
        } else {
          status = (String(got) === String(k.expect)) ? 'PASS' : 'FAIL';
        }
        if (status === 'PASS') pass++; else if (status === 'FAIL') fail++;
        if (via === 'device-px') viaDevicePx++;

        out.push({ row: r.id, check: k.name, status: status, expect: k.expect, got: got,
                   via: via, from: k.from, note: note });
      });
    });

    var ok = (fail === 0) && (opts.allowSkip ? true : skip === 0);
    var result = {
      ok: ok,                                           // G9: 0 failures, 0 skips — never a count
      rows: T.length, checks: out.length,               // reported, NOT gated (§5.11, G9)
      pass: pass, fail: fail,
      // §5.11, errata 2, VERBATIM: "The report's skip field is `skip`. Any `skips` alias added to
      // satisfy the old sentence is DELETED — two names for one number is how they drift apart."
      // The consumer string-matches `"ok":true` and reads nothing else, so the alias had no reader.
      skip: skip,
      rowsSkipped: rowsSkipped,
      dpr: root.devicePixelRatio,                       // reported, and NOW ALSO the grid
      // The tolerance actually applied, so a green run at a fractional scale can
      // never be quoted as if it were a green run at 1.
      tolerance: isIntegerScale(dprNow) ? EPS : devicePx(dprNow) + EPS,
      integerScale: isIntegerScale(dprNow),
      viaDevicePx: viaDevicePx,                         // rows that needed the loose rule
      inner: root.innerWidth + 'x' + root.innerHeight,
      gate: gate,
      results: out
    };

    if (opts.emit !== 'silent') {
      if (console.table) {
        console.table(out.map(function (r) {
          return { row: r.row, check: r.check, status: r.status, expect: r.expect, got: r.got };
        }));
      }
      out.filter(function (r) { return r.status !== 'PASS'; }).forEach(function (r) {
        console.warn('[' + r.status + '] ' + r.row + ' · ' + r.check +
          '\n    expected ' + r.expect + ', got ' + r.got + (r.note ? '  (' + r.note + ')' : '') +
          '\n    derives from: ' + r.from);
      });
      console.log('geometry: ' + T.length + ' rows / ' + out.length + ' checks — ' +
        pass + ' pass, ' + fail + ' fail, ' + skip + ' skip @ dpr ' + result.dpr +
        ', inner ' + result.inner + '  →  ' + (ok ? 'OK' : 'NOT OK'));
    }
    return result;
  }

  /* ===========================================================================
   * selfTest() — the pure arithmetic, with no DOM and no app.
   *
   * Every derived constant above is re-derived here from an INDEPENDENT statement of the same fact
   * (a measured band, a column sum, a printed absolute in CONTRACT.md §5.2/§5.3/§5.9/§5.4.2), so a
   * typo in K is caught before anyone tries to explain a red row in a real window. It asserts no
   * DOM behaviour — that is what the stub-geometry run does.
   *
   * It also pins noTransition(), a pure function of four style strings and the one place a G9
   * ruling changed a check's MEANING rather than its number. Nothing else here could have caught
   * "the probe asserted a SPELLING and failed a correct app", so it is caught here.
   *   node tools/verify-geometry.js --selftest
   * ========================================================================= */
  function selfTest() {
    var failures = [], n = 0;
    function eq(name, got, want, src) {
      n++;
      var ok = (typeof want === 'number')
        ? (typeof got === 'number' && isFinite(got) && Math.abs(got - want) <= EPS)
        : String(got) === String(want);
      if (!ok) failures.push(name + ': expected ' + want + ', got ' + got + '   [' + src + ']');
    }

    /* column sums — §5.5, §3.3, §5.10 R2 */
    // `strip + nav == tree top` stood here and is DELETED, not re-pointed: with
    // navH gone it would read `eq(K.stripH, K.treeTop)`, which restates line
    // K.treeTop's own definition.  It was already that tautology before E14 —
    // treeTop was DEFINED as stripH + navH — so the selfTest header's claim that
    // every entry re-derives a constant from an independent statement was false
    // for this one.  Reported, and closed by deletion rather than by pretending.
    eq('tree band', K.treeH, 881, '§3.3 and CONTRACT §0 E14, which both say 881. It read 875 between the 43px vault bar landing and 2026-09-09: `treeH = ruleY − stripH` and winH CANCELS OUT of it, so when vaultBarH went 37→43 the 6px belonged to winH (958→964), NOT to the tree band. Taking it off treeH instead left the gate asserting a number its own governing ruling contradicted');
    eq('sidebar column sums to the window', K.treeTop + K.treeH + K.vaultBarH, K.winH, '§5.10 R2: only spec-01\'s column sums to 958');
    eq('tab height', K.tabH, 33, '§0.8: --titlebar-h 40 - --tab-top 7.  33 is also what the reference PNG shows (top 6 on a 39px strip) — the tab is anchored to the strip BOTTOM');
    eq('tab bottom', K.tabTop + K.tabH, K.stripH, '§0.6 E8: the tab reaches the strip\'s full 40 and its -1px margin covers the rule');
    eq('strip fill', K.stripH - 1, K.stripFillH, '§0.6 E8: 40 border box - the 1px rule = the 39 the old [M] measured');
    eq('one banner', K.treeH - K.bannerH, 857, '§3.3. Was 857, briefly 851, and is 857 again — see `tree band`');
    eq('two banners', K.treeH - 2 * K.bannerH, 833, '§3.3. Was 833, briefly 827, and is 833 again — see `tree band`');
    eq('watcher bar band', K.treeH - 48, 833, '§7.3 case 16/§0.12 E14: the 48px `.watch-degraded` bar shortens the same band, by the same ordinary-resize path as a cap banner. Was 833, briefly 827, and is 833 again — see `tree band`');
    eq('vault bar y', K.vaultBarY, 921, 'the 43px bar puts its own border-top rule at 964 − 43 = 921, which is the reference PNG\'s measured rule position. It read 915 while winH was 958');
    eq('vault bar bottom flush', K.vaultBarY + K.vaultBarH, K.winH, '§5.10 R2: 921..957, flush with 958');

    /* sidebar horizontal — §5.2 */
    eq('scroller right', K.scrollerR, 409, '§5.2 "x 0..408 (409px)"');
    eq('scroller + sidebar padding == sidebar', K.scrollerR + K.sidebarPadR, K.sidebarW, '§5.2 "the sidebar\'s own 3px right padding beyond it"');
    eq('gutter left', K.gutterL, 401, '§5.2 "the rightmost 8px at x 401..408"');
    eq('row width', K.rowW, 401, '§5.2 "rows lay out in the remaining 401px"');

    /* tree box model — §5.2's own 13-of-13 table, box column */
    eq('chev box d0', K.chevLeft(0), 16, '§5.2 table +1, §0.48 E96');
    eq('chev box d1', K.chevLeft(1), 33, '§5.2 table +1, §0.48 E96');
    eq('chev box d2', K.chevLeft(2), 50, '§5.2 table +1, §0.48 E96');
    eq('chev box d3', K.chevLeft(3), 67, '§5.2 table +1, §0.48 E96');
    eq('text box d0', K.textLeft(0), 36, '§5.2 table +1, §0.48 E96');
    eq('text box d1', K.textLeft(1), 53, '§5.2 table +1, §0.48 E96');
    eq('text box d2', K.textLeft(2), 70, '§5.2 table +1, §0.48 E96');
    eq('text box d3', K.textLeft(3), 87, '§5.2 table +1, §0.48 E96');
    // §5.2's table prints the guide column in SCREENSHOT coords (sx 24/41/58/75); content = sx − 1.
    // Both sides are asserted, because conflating the two conventions is exactly how `--tx0: 38`
    // got into two specs: it is chevron INK sx 22 + step 17 wearing a box label.
    eq('guide d0 (content)', K.chevCentre(0), 24, '§0.48 E96: sx 24 IS content 24 — spike O struck the 1px frame. Measured device 30 at dpr 1.25');
    eq('guide d1 (content)', K.chevCentre(1), 41, '§0.48 E96: sx 41 IS content 41. Measured device 51');
    eq('guide d2 (content)', K.chevCentre(2), 58, '§0.48 E96: sx 58 IS content 58. Measured device 72');
    eq('guide d3 (content)', K.chevCentre(3), 75, '§0.48 E96: sx 75 IS content 75');
    eq('guide d3 (sx)', K.chevCentre(3), 75, '§0.48 E96: content == sx, the +1 frame offset is STRUCK');
    eq('cx0 == gx0 − chevW/2', K.gx0 - K.chevW / 2, K.cx0, '§5.2 token block [D]');
    eq('gut == tx0 − cx0 − chevW', K.tx0 - K.cx0 - K.chevW, K.gut, '§5.2 token block [D]');
    eq('guides painted at d3', K.guidesW(3), 42.5, '§0.48 E96: background-size max(0, calc((--d - 0.5) * --row-indent))');

    /* §0.12 E14 deleted the six nav-toolbar identities that stood here — the five
       centres, the button lefts, the group box and its 1px offset from the
       sidebar's geometric centre.  They re-derived §5.9, which is STRUCK.  The
       measurements themselves survive in §5.9's struck text; nothing in this
       file may re-derive an element the app does not draw. */

    /* editor — §5.3's printed absolute geometry */
    eq('panes sum to the window', K.sidebarW + K.editorW, K.winW, '§5.3: the solve only lands at pane = 1506');
    eq('line box', K.lineW, 1432, '§5.3 + spike Q + §0.37 E84: 1508 − 12 − 32 − 32, and 1432 is the [M] figure §5.3 recorded and then explained away as ink-to-ink. THIS IS THE RECONCILIATION: the derivation and the measurement agree once the editor\'s gutter is Obsidian\'s 12 and not the sidebar\'s 8');
    eq('line left', K.lineLeft, 444, '§5.3 + spike Q: 412 + 32. WAS 445 on a 33px inset — an ink-edge reading; the reference title\'s ink starts one px right of its box (u side bearing)');
    eq('line right + right inset + gutter == window', K.lineLeft + K.lineW + K.insetX + K.edGutterW, K.winW, '§5.3 absolute geometry');
    eq('code text origin', K.codeTextLeft, 460, '§5.3 + spike Q: 444 + 16. WAS 461 off the 445');
    eq('editor gutter left', K.edGutterL, 1908, '§5.3\'s "scrollbar gutter content x 1910..1917" was written at winW 1918 AND at an 8px gutter; at 1920 with §0.37 E84\'s 12 the track is x 1908..1919, and the 7px of thumb ink inside it is 1910..1916 — which is what that sentence was reading');
    eq('code block height', 3 * K.codeLh, 63, '§5.3: 3 lines x 21px = the measured crop y 24..86');

    /* inline title — §5.4.2's printed derivation */
    eq('title top', K.titleTop, 72, '§5.4.2 + spike Q: strip 40 + --editor-inset-y 32. WAS 70 on an inset of 30 — the designated FIT parameter (spec-01-visual.md:709); Obsidian\'s --file-margins-y is 32 (app.css:2244)');
    eq('title height', K.titleH, 31.0656, '§5.4.2 + spike Q: 25.888px x --h1-lh 1.2. WAS 34.8 on a 29px H1');
    eq('title bottom', K.titleBottom, 103.0656, '§5.4.2 + spike Q: box 72..103.0656. WAS 104.8');
    eq('first line top', K.firstLineTop, 116.0096, '§5.4.2: titleTop 72 + titleH 31.0656 + --inline-title-space-after 12.944. WAS 113.0656 while the inline title borrowed --h1-space-after 10, and 114.8 before spike Q. The 12.944 is MEASURED off Obsidian 1.13.7 (computed .inline-title marginBottom), not resolved from 0.5em on paper');

    /* vault bar interior — §5.5 / §5.11 */
    eq('vault label left', K.vbLabelLeft, 40, '8 (bar pad) + 8 (switcher pad) + 16 (chevron) + 8 (gap), app.css:6327/6339/6338');
    eq('vault chevron right', K.vbPadL + K.chevW, 32, '§5.5: 16px box at content x 16..32');

    /* noTransition() — the G9 ruling, pinned so the literal-spelling check cannot come back.
     * Not arithmetic, but it is the same class of bug: a probe that asserted a SPELLING failed a
     * correct app, and nothing here could have caught it. All four spellings of "nothing animates"
     * must read `none`, and anything that would actually run must not. */
    eq('noTransition: the shipping app\'s `transition: none`',
       noTransition({ transitionProperty: 'none', transitionDuration: '0s', transitionDelay: '0s' }), 'none',
       '§5.1 rule 5 / §5.11 G9 ruling: `transition: none !important` is the global kill-switch');
    eq('noTransition: the other spelling, `all 0s`',
       noTransition({ transitionProperty: 'all', transitionDuration: '0s', transitionDelay: '0s' }), 'none',
       '§5.1 rule 5: the rule is the behaviour, not the declaration');
    eq('noTransition: a named property at 0s',
       noTransition({ transitionProperty: 'transform', transitionDuration: '0s', transitionDelay: '0s' }), 'none',
       '§5.1 rule 5');
    eq('noTransition: a multi-valued list that is all zero',
       noTransition({ transitionProperty: 'transform, opacity', transitionDuration: '0s, 0s', transitionDelay: '0s, 0s' }), 'none',
       '§5.1 rule 5: every LISTED duration and delay');
    eq('noTransition: spec-04 §4.3\'s struck 100ms chevron transition is caught',
       noTransition({ transitionProperty: 'transform', transitionDuration: '0.1s', transitionDelay: '0s' }),
       'animates (transform: 0.1s delay 0s)',
       '§5.1 rule 5 STRIKES spec-04 §4.3 `transition: transform 100ms ease`');
    eq('noTransition: a zero duration with a real DELAY is still caught',
       noTransition({ transitionProperty: 'opacity', transitionDuration: '0s', transitionDelay: '0.2s' }),
       'animates (opacity: 0s delay 0.2s)',
       '§5.1 rule 5: "every duration AND every delay is 0"');
    eq('noTransition: one animating entry in a list is enough',
       noTransition({ transitionProperty: 'transform, opacity', transitionDuration: '0s, 0.15s', transitionDelay: '0s, 0s' }),
       'animates (transform, opacity: 0.15s delay 0s)',
       '§5.1 rule 5');

    var res = { ok: failures.length === 0, checks: n, failures: failures };
    if (typeof console !== 'undefined') {
      failures.forEach(function (f) { console.error('[SELFTEST FAIL] ' + f); });
      console.log('selfTest: ' + n + ' identities — ' +
        (n - failures.length) + ' pass, ' + failures.length + ' fail  →  ' + (res.ok ? 'OK' : 'NOT OK'));
    }
    return res;
  }

  verify.selfTest = selfTest;
  verify.K = K;            // exported so a stub-geometry run can build a DOM from the same numbers
  verify.SEL = SEL;

  root.__verifyGeometry = verify;
  if (typeof module !== 'undefined' && module.exports) module.exports = verify;

  /* node tools/verify-geometry.js --selftest
   *
   * "Am I the program being run?" WITHOUT `require.main === module` (undefined under
   * `"type": "module"`, which is what package.json says) and WITHOUT `import.meta` (a SyntaxError
   * in a classic script, which is how this file is pasted into Web Inspector and how owner 07
   * injects it). argv[1] satisfies both: it is this file's path when node runs it directly, and it
   * is absent when the module is `import`ed by npm's selftest:geometry one-liner or by a test. */
  var argv = (typeof process !== 'undefined' && process.argv) ? process.argv : null;
  if (argv && /(^|\/)verify-geometry\.js$/.test(String(argv[1] || ''))) {
    if (argv.indexOf('--selftest') < 0) {
      console.error('usage: node tools/verify-geometry.js --selftest');
      console.error('  (the DOM probe runs in the page: __verifyGeometry({ gate: true }))');
      process.exit(2);
    }
    var r = selfTest();
    process.exit(r.ok ? 0 : 1);
  }
})(typeof window !== 'undefined' ? window : globalThis);
