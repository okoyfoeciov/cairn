// Owner: the verification pass (tools/verify-geometry.js).  `node --test tests/frontend/`.
// Spec: CONTRACT.md §5.11 (the probe IS the gate), §5.12.4 / §5.12.4.3 (the
// two-scroller ceiling), and the gate-G9 `layers.scrollers` ruling (Z6).
//
// ===========================================================================
// WHAT THIS FILE CAN AND CANNOT PROVE — READ BEFORE ADDING A ROW
// ===========================================================================
// `tools/verify-geometry.js` reads REAL rendered geometry: getBoundingClientRect,
// getClientRects and getComputedStyle against a live WebKit layout.  It cannot be
// executed against `_minidom` — that harness has no getClientRects at all and its
// getBoundingClientRect is a single hardcoded 409x27 rect (_minidom.mjs:137), so
// running the probe there would not test the probe, it would test the stub.
//
// So the rows below split into exactly two honest kinds, and NOTHING pretends to
// be the third:
//   1. BEHAVIOURAL — the DOM-free arithmetic self-test, which really does run.
//   2. STRUCTURAL  — assertions on the probe's source text, for the one property
//      whose failure mode is "the guard silently is not there".  This is the same
//      pattern chrome-ui.test.mjs already uses on this file, and it is a weaker
//      test than a real layout; it is used here only because the real layout is
//      reachable ONLY through a 1918x958 G9 run, which is the user's to make.
// The full gate remains G9 itself.  This file narrows the window in which the
// scrollers ruling could regress unnoticed; it does not replace the gate.
// ===========================================================================

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const PROBE_PATH = new URL('../../tools/verify-geometry.js', import.meta.url)
const SRC = readFileSync(PROBE_PATH, 'utf8')

/* --- 1. BEHAVIOURAL ------------------------------------------------------- */

test('the probe loads and its DOM-free self-test passes', async () => {
  await import(PROBE_PATH.href)
  const api = globalThis.__verifyGeometry
  assert.equal(typeof api, 'function', 'the probe must publish __verifyGeometry')
  assert.equal(typeof api.selfTest, 'function', '§5.11: --selftest is part of the probe')
  const r = api.selfTest()
  assert.equal(r.ok, true, `self-test failed: ${JSON.stringify(r.failures || r, null, 2)}`)
  assert.ok(r.checks > 0, 'a self-test that asserts nothing is not a self-test')
})

/* --- 2. STRUCTURAL: the gate-G9 scrollers ruling --------------------------- */

/* Isolate the layers.scrollers collector so these rows cannot be satisfied by
 * the string appearing somewhere else in this 1000-line file. */
function scrollersCollector() {
  const start = SRC.indexOf("row('layers.scrollers'")
  assert.notEqual(start, -1, "the layers.scrollers row is gone from the probe")
  const end = SRC.indexOf('return { hits: hits', start)
  assert.notEqual(end, -1, 'the layers.scrollers collector no longer returns hits')
  return SRC.slice(start, end)
}

/* THE RULING (Z6).  A hidden scroller has no box and therefore no compositing
 * surface, so counting it fails a correct app.  This is not hypothetical: with
 * the search panel open, src/search.ts sets `this.tree.hidden = true` and mounts
 * `.sr-list`, and getComputedStyle STILL resolves `overflow:auto` on the hidden
 * `.tree-scroller` — computed style is not rendering.  Without the filter the
 * document reads three scrollable boxes and G9 fails a document that is exactly
 * what §5.11 requires. */
test('gate G9: the scrollers collector skips elements that generate no box', () => {
  const c = scrollersCollector()
  assert.match(
    c, /getClientRects\(\)\.length === 0/,
    'the ruling names getClientRects().length > 0 as the test; without it a display:none ' +
    'scroller is counted and a correct app fails G9',
  )
  // The filter must GUARD the push, not merely be mentioned in a comment.
  const guard = c.indexOf('getClientRects().length === 0')
  const push = c.indexOf('hits.push(')
  assert.ok(guard !== -1 && push !== -1 && guard < push,
    'the rendered-box filter must run BEFORE the element is counted')
})

/* Why getClientRects and not offsetParent / offsetHeight: a scroller that is
 * merely scrolled out of view, clipped by an ancestor, fully transparent or
 * painted over DOES still own a compositing surface and MUST still be counted
 * against the ceiling of two.  offsetParent is additionally null for
 * position:fixed elements, which would under-count a real fixed scroller. */
test('gate G9: the ceiling is still asserted, and against the rendered boxes', () => {
  const c = scrollersCollector()
  assert.doesNotMatch(c, /offsetParent/,
    'offsetParent is null for position:fixed elements and would under-count a real scroller')
  // The count check itself must survive at 2 — the filter narrows what is counted,
  // it must not relax the ceiling.
  const row = SRC.slice(SRC.indexOf("row('layers.scrollers'"))
  assert.match(row, /c\('scrollable box count', 2,/,
    '§5.12.4.3: the ceiling of two scrollable boxes is the memory rule; the filter changes ' +
    'WHICH boxes count, never HOW MANY are allowed',
  )
})

/* The probe must never be allowed to quietly become DPI- or raster-dependent:
 * §5.11 removed the 1x precondition precisely because nothing here reads pixels. */
test('§5.11: the probe reads no raster and asserts no devicePixelRatio', () => {
  // Strip comments first: the file DISCUSSES devicePixelRatio at length, and a
  // naive grep matches its own prose (which is how this row was first written,
  // and it duly failed against a correct probe).
  const code = SRC
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
  const uses = code.split('\n').filter((l) => /devicePixelRatio/.test(l)).map((l) => l.trim())
  /* AMENDED 2026-09-08. This row used to require exactly one use -- the report
     field -- on §5.11's claim that the probe is DPI-insensitive because it
     "reads no raster". THAT CLAIM WAS MEASURED FALSE at fractional scales: at
     dpr 1.25 an 1918x958 gate run failed ELEVEN rows, all by +/-0.2 or +/-0.4
     CSS px and none of them a geometry error. `getBoundingClientRect` returns a
     USED box and Chromium snaps a used box to whole DEVICE pixels, so a 1px
     rule reports 0.8 -- 1.25 device px is not representable.
     The probe now READS dpr to state its comparison on the grid the engine
     actually renders on. It still asserts nothing about dpr, and it still reads
     no raster; what changed is that the tolerance is no longer a lie at 1.25.
     The two legal uses are the report field and the tolerance. */
  assert.deepEqual(uses, ['var dprNow = root.devicePixelRatio || 1;', 'dpr: root.devicePixelRatio,'],
    '§5.11 + §0.19.2: devicePixelRatio may be REPORTED and used to size the tolerance to the ' +
    'device grid, and asserted NEVER. At an integer scale the tolerance is unchanged at EPS, ' +
    'so a 1x and a 2x machine still run the identical gate')

  // The strictness at an integer scale is the whole bargain, so pin it.
  assert.match(code, /function isIntegerScale/,
    'the integer-scale branch is what keeps dpr 1 and dpr 2 exactly as strict as before')
  assert.match(code, /if \(!isIntegerScale\(dpr\) && Math\.abs\(got - want\) <= devicePx\(dpr\) \+ EPS\)/,
    'the loose device-pixel rule must be unreachable at an integer scale')
  // And no raster path: §5.11 struck the pixel diff outright.
  assert.doesNotMatch(code, /cacheDisplayInRect|toDataURL|getImageData|<canvas/i,
    '§5.11: colour is asserted through getComputedStyle, never from a raster')
})

/* --- 5. DRIFT: the probe's K vs the stylesheet it is gating ----------------
 * ADDED BY SPIKE Q, AND IT GUARDS THE DEFECT CLASS THAT LET 29px SURVIVE.
 *
 * `K.h1Size` and friends are HAND-COPIED literals in tools/verify-geometry.js.
 * Nothing made them track src/styles/tokens.css, so the tool and the stylesheet
 * could disagree indefinitely -- and worse, when the ladder finally moved they
 * would be red in OPPOSITE directions, each blaming the other. The probe's own
 * comment admits it ("must move in ONE commit"), but a comment is not a guard.
 *
 * This does not re-derive the numbers: it reads BOTH sides and asserts they
 * agree, so changing either one alone is loud. `--h1-size` is an `em` and the
 * probe holds resolved px, so the em base (--fs-text, the .cm-content reset) is
 * part of the assertion -- which is correct, because that reset is what makes
 * 1.618em land on 25.888 at all. Precedent: window-controls.test.mjs guards
 * chrome.ts's constants the same way. */
test('spike Q: the probe\'s K constants still agree with tokens.css', async () => {
  await import(PROBE_PATH.href)
  const K = globalThis.__verifyGeometry.K
  assert.ok(K, 'the probe must publish K for this guard to mean anything')

  const tokens = readFileSync(new URL('../../src/styles/tokens.css', import.meta.url), 'utf8')
  // Anchored to a real declaration -- line start or after a `;`, since the
  // ladder packs five declarations per line -- so the long explanatory comment
  // above it (which names every one of these tokens) cannot satisfy this.
  const decl = (name) => {
    const m = tokens.match(new RegExp(`(?:^|;)\\s*--${name}\\s*:\\s*([^;]+);`, 'm'))
    assert.ok(m, `tokens.css no longer declares --${name}`)
    return m[1].trim()
  }
  const num = (name) => Number.parseFloat(decl(name))

  const emBase = num('fs-text')
  assert.equal(emBase, 16, '--fs-text is the em base the whole ladder resolves against')

  assert.match(decl('h1-size'), /em$/,
    '--h1-size must stay an `em`: it is what makes the ladder right at more than one base')
  assert.ok(Math.abs(num('h1-size') * emBase - K.h1Size) < 1e-9,
    `K.h1Size ${K.h1Size} != tokens.css --h1-size ${decl('h1-size')} x ${emBase} = ${num('h1-size') * emBase}`)

  for (const [tok, k] of [['h1-weight', 'h1Weight'], ['h1-lh', 'h1Lh'],
    ['editor-inset-x', 'insetX'], ['editor-inset-y', 'insetY'],
    ['fs-code', 'codeFs'], ['lh-code', 'codeLh'], ['tree-fs', 'treeFs'], ['row-h', 'rowH']]) {
    assert.equal(num(tok), K[k], `K.${k} (${K[k]}) has drifted from tokens.css --${tok} (${decl(tok)})`)
  }

  // §0.30 E74 — `--hN-space-after` IS STRUCK, all six, and so is `K.h1Space`.
  // Obsidian's heading declares no `padding-bottom` and its base `.cm-line` is
  // `padding: 0`, so the space BELOW a heading is zero; the 10/9/8/7/6/6 ladder
  // was Cairn's own, and spike Q records `--h1-space-after` as one of two knobs
  // that had been TUNED rather than measured. Pinned absent on BOTH sides, so a
  // token coming back without its constant (or the reverse) fails here.
  for (let h = 1; h <= 6; h++) {
    assert.doesNotMatch(tokens, new RegExp(`--h${h}-space-after\\s*:`),
      `--h${h}-space-after is back; Obsidian gives a heading no space below it`)
  }
  const probeSrc = readFileSync(new URL('../../tools/verify-geometry.js', import.meta.url), 'utf8')
  assert.equal(/h1Space:/.test(probeSrc), false, 'K.h1Space is back in verify-geometry.js')

  // --lh-tight is STRUCK. If it comes back, one of the two sides has regressed.
  assert.doesNotMatch(tokens, /(?:^|;)\s*--lh-tight\s*:/m,
    '--lh-tight is struck by spike Q: Obsidian\'s line-heights are per level, not one flat value')
})
