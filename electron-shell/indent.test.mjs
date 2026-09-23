/**
 * electron-shell/indent.test.mjs — §0.51 E99, the leading indent run of a list
 * line, in the real engine.
 *
 * ===========================================================================
 * WHAT THE USER REPORTED
 * ===========================================================================
 * Two crops of one note, Cairn's and Obsidian's, with the nested bullets under
 * an ordered item sitting further right in Cairn. Cross-correlating the glyph
 * ink of the nested rows against the unindented rows above and below them put
 * it at 19.999 device px at dpr 1.25 — 16.000 CSS px — and the two DOMs then
 * agreed on 16.000 exactly.
 *
 * THE CAUSE WAS A CLASSIFICATION. `listIndentAt`'s predecessor asked only "is
 * there an open list item above this indented line", which a NESTED ITEM
 * answers yes to just as a continuation does. So every nested bullet was
 * dressed as a continuation: it took `.nc-indent-pad`'s 1em, and it took
 * `.nc-li-cont`'s `padding-top: 0` with it — 25.2 tall against Obsidian's 26.4.
 * One predicate, both symptoms, and the second one nobody had reported.
 *
 * ===========================================================================
 * WHY IN THE ENGINE, AND WHY IN ITS OWN FILE
 * ===========================================================================
 * `tests/frontend/livepreview.test.mjs` owns the MODEL — which ranges get which
 * class — and it is the right place for that. What it cannot see is the two
 * numbers the user actually reported, because both are the cascade's answer and
 * not the decorator's:
 *
 *   - a WIDTH: `.nc-indent` is `min-width: var(--list-indent)`, so a whole tab
 *     or four whole spaces render 36px wide whatever the file spelled them
 *     with. A decorator test cannot tell 36 from a tab's own advance.
 *   - a HEIGHT: `--list-spacing` arriving on one side or two.
 *
 * ITS OWN FIXTURE, DELIBERATELY. `live-preview.test.mjs`'s note carries §0.26
 * E62's hit-test row at ZERO tolerance, and that fixture has already had an
 * ordered item taken back OUT of it for landing a 30px sample on a glyph
 * midpoint (`KNOWN-ISSUES.md` V-4). Adding five list shapes to it to test
 * something else would put that guard at risk for an unrelated reason.
 *
 * ===========================================================================
 * THE REFERENCE MEASUREMENT: THE LIVE OBSIDIAN 1.13.7, ON DEBIAN, AT dpr 1.25
 * ===========================================================================
 * `node tools/obsidian-live.mjs --vault … --config-from … --sidebar 221`, the
 * same note, the same emulated viewport (§0.41), reading its own DOM:
 *
 *   source line          Obsidian   Cairn before   Cairn after
 *   `   - nested item`     10.563      26.563         10.563
 *   `  - nested item`       7.050      23.050          7.050
 *   `\t- nested item`      36.000      30.087         36.000
 *   `  continuation`       23.050      23.050         23.050
 *   `    continuation`     36.000      30.087         36.000
 *
 * …and the line box: 26.4 for an item (1.2px top AND bottom), 25.2 for a
 * continuation (0 and 1.2px). Cairn gave every nested item 25.2.
 *
 * THOSE ARE THE CLAIMS. THREE OF THE NUMBERS MOVE WITH THE FONT AND TWO WITH
 * THE SCALE, so from 2026-09-13 the test asserts the claims and derives the
 * numbers from the page. Until then this file held the table's literals, and
 * its first macOS run (Apple M2, dpr 1) failed ALL THREE of its tests — `tests
 * 3 / pass 0 / fail 3`: the parent's line box 26.375 against 26.4, the first
 * width 12.563 against 10.563, the first marker x 12.563 against 10.563. Each
 * stopped at that first assertion, so the rows after it never ran. On every row,
 * run or not, Cairn matched `/Applications/Obsidian.app` 1.13.7 on the same
 * note: 12.5625 / 8.375 / 36 / 24.375 / 36 and line boxes 26.375 / 25.1875 in
 * BOTH.
 *
 * ── WHAT MOVES WITH THE FONT ────────────────────────────────────────────────
 * `10.563` and `7.050` are runs of 3 and 2 SPACES, `23.050` is 2 of them plus
 * E81's 1em, and a nested marker's x is the run in front of it. `--font-text`
 * resolves through `--font-ui`, whose stack opens `ui-sans-serif,
 * -apple-system, …`: the Mac's engine picks `.SF NS`, whose space at 16px is
 * exactly 4.1875px, and the Debian box's is about 3.52. So the probe lays out
 * a run of n spaces in a REFERENCE box — body-level, in `.cm-content`'s
 * computed font — and the expectation is that run, plus the 16px token where
 * the row is padded. §0.49's discipline for `--hairline`: read the unit out of
 * the page, keep the claim.
 *
 *   WHY A RUN AND NOT n × ONE ADVANCE. Chromium lays a box's text out at the
 *   DEVICE scale and snaps its width UP to a whole LayoutUnit, 1/64 of a device
 *   pixel. Measured in the pinned engine (2026-09-13) at 17px, dpr 1: the space
 *   is 4.3496 and the runs are 279/64, 557/64 and 836/64 — the CEILING of
 *   n × 4.3496 × 64 each time, never the product. The Mac's 4.1875 sits on that
 *   grid, which is why the Mac cannot show the snap and Debian can.
 *
 *   THE DEBIAN ARITHMETIC — Debian has NOT run this version. The "3.5235" quoted
 *   for its space is 7.047 / 2, a width that had already been snapped, and
 *   3 × 3.5235 = 10.5705 is not 10.563: no advance times n gives back both
 *   rows. Snapped, they come back. At dpr 1.25 the run of 3 is 845/64 device px
 *   and the run of 2 is 564/64, which any advance s with 3·s·1.25·64 in
 *   (844, 845] and 2·s·1.25·64 in (563, 564] produces — s in (3.51875, 3.52083],
 *   e.g. 3.52 = 0.22em: 844.8 → 845 → 10.5625 → "10.563"; 563.2 → 564 → 7.05;
 *   7.05 + 16 = 23.05. At dpr 1, 2 × 3.52 × 64 = 450.56 → 451/64 = 7.046875, and
 *   + 16 = 23.046875 → "23.047", `live-preview.test.mjs`'s figure. The reference
 *   run is snapped by the same engine as the group, so the test needs none of
 *   this; it is here so the Debian literals can be checked against the model.
 *
 * ── WHAT MOVES WITH THE SCALE ───────────────────────────────────────────────
 * The line boxes are `line-height: 24px` plus `--list-spacing` = 0.075em =
 * 1.2px. This header used to say they "do not move" because they are not font
 * metrics — the second half is true and the first is not. A padding is stored
 * in whole LayoutUnits at the DEVICE scale and TRUNCATES into them:
 *
 *   dpr 1     1.2 × 64 =  76.8 →  76  1.1875     item 26.375     cont 25.1875
 *   dpr 1.25  1.5 × 64 =  96   →  96  1.2        item 26.4       cont 25.2
 *   dpr 2     2.4 × 64 = 153.6 → 153  1.1953125  item 26.390625  cont 25.1953125
 *
 * All six measured in the pinned engine; the dpr-1 pair is also the live
 * Obsidian's on the Mac, and E82 already recorded 25.188. So the expectation is
 * computed from the probe's own `devicePixelRatio`, at whatever scale the
 * window really runs — NOT forced to 1.25, which would turn the Mac green by
 * leaving the scale it runs at unchecked — and the formula is pinned to all
 * three rows above by a test of its own, so a wrong model cannot pass at one
 * scale by luck.
 *
 * ── WHAT DOES NOT MOVE, AND STAYS A LITERAL ─────────────────────────────────
 * `36` is `min-width: var(--list-indent)` (the tab row and the four-space row),
 * `16px` is E81's 1em, and `1.2px` / `0px` / `24px` are COMPUTED values, which
 * are not snapped.
 *
 * ── THE REFERENCE IS NEVER THE ELEMENT UNDER TEST ───────────────────────────
 * It copies `.cm-content`'s font, not the group's. A reference that copied the
 * GROUP's letter-spacing or font-size would move with exactly the defect the
 * widths exist to catch and the assertion would be a tautology — mutation-tested
 * 2026-09-13: with a `letter-spacing` on `.nc-indent-sp`, the real reference
 * fails the width rows, and the same probe sourcing its font from the group
 * passes them.
 *
 * ── COMPARED IN LAYOUT UNITS, NOT AS toFixed(3) NUMBERS ─────────────────────
 * Both sides are reported to three decimals and compared as
 * `round(css × dpr × 64)` — whole LayoutUnits, exact equality. Comparing the
 * decimals after adding 16 is NOT exact: DOMRect carries float32, and the pinned
 * engine at 15.3px and dpr 1.25 reads a 12.1375 run back as 12.137 while the
 * same run + 16px reads 28.138 — so `12.137 + 16` would fail a correct box. At
 * dpr ≤ 2 one LayoutUnit is at least 1/128 = 0.0078 CSS px, so half of one is
 * at least 0.0039, which exceeds toFixed(3)'s ±0.0005 display error (and
 * float32's ~1e-6). Rounding therefore recovers the unit exactly and admits
 * nothing a decimal compare would have rejected. Do not "fix" a failure here by widening anything; that is
 * the one thing this header forbids.
 *
 * ===========================================================================
 * REQUIREMENTS
 * ===========================================================================
 * A display connection. The window is `CAIRN_HEADLESS=1` — offscreen and never
 * shown — but Electron still needs a compositor to have a window at all.
 * Skipped, not failed, where there is none (`have-display.mjs`).
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
 * One note carrying every shape the indent run has, and NOTHING ELSE — a
 * heading or a table here would only add rows the probe has to skip.
 *
 * THE FIRST GROUP IS THE REPORTED ONE, spelled the way the user's note spells
 * it: three spaces under an ordered item. It is the shape a four-space rule
 * would silently get right for the wrong reason.
 */
const NOTE = [
  'Plain paragraph before the list.',
  '',
  '1. An ordered parent line. Cover:',
  '   - A nested bullet under an ordered item.',
  '   - A second nested bullet.',
  '2. The second ordered parent.',
  '',
  '- A top level bullet whose source breaks the line itself',
  '  and this is its hard-wrapped continuation, two spaces.',
  '- Another top level bullet.',
  '\t- A tab-indented nested bullet.',
  '',
  '- A parent bullet',
  '  - A nested bullet under a bullet',
  '    and a continuation of that nested bullet, four spaces.',
  '',
  // §0.51 E99's one departure from Obsidian's DOM, and the only fixture line
  // that can catch it: a run that MIXES a partial group with a tab.
  '- A bullet whose continuation mixes a tab in',
  '  \t  and this continuation is two spaces, a tab, two spaces.',
  '',
].join('\n')

function runProbe() {
  return new Promise((resolve, reject) => {
    const work = mkdtempSync(join(tmpdir(), 'cairn-indent-'))
    const cleanup = () => {
      try { rmSync(work, { recursive: true, force: true }) } catch {}
    }
    const vault = join(work, 'vault')
    mkdirSync(join(vault, 'Notes'), { recursive: true })
    writeFileSync(join(vault, 'Notes', 'lists.md'), NOTE)
    writeFileSync(join(vault, 'root.md'), 'root file\n')

    const child = spawn(BIN, [join(HERE, 'app-main.mjs')], {
      cwd: ROOT,
      env: {
        ...process.env,
        CAIRN_HEADLESS: '1',
        CAIRN_INDENT_PROBE: '1',
        CAIRN_VAULT: vault,
        CAIRN_PIXELTEST_EXPANDED: 'Notes',
        CAIRN_PIXELTEST_NOTE: 'Notes/lists.md',
        // Hermetic, for spike-M D1's reason: a test that boots the app must not
        // rewrite the vault, recents or geometry of the person running it.
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
      reject(new Error('probe timed out after 90s\nstdout:\n' + out + '\nstderr:\n' + err))
    }, 90_000)

    child.on('error', (e) => { clearTimeout(kill); cleanup(); reject(e) })
    child.on('exit', () => {
      clearTimeout(kill)
      const line = out.split('\n').find((l) => l.startsWith('INDENT '))
      if (!line) {
        cleanup()
        reject(new Error('no INDENT line\nstdout:\n' + out + '\nstderr:\n' + err))
        return
      }
      const result = JSON.parse(line.slice('INDENT '.length))
      cleanup()
      resolve(result)
    })
  })
}

let cached = null
const probeOnce = async () => (cached ??= await runProbe())

/** The reported line, by a fragment of its text. */
function lineOf(p, fragment) {
  const hit = p.lines.filter((l) => l.text.includes(fragment))
  assert.equal(hit.length, 1, `${hit.length} lines match ${JSON.stringify(fragment)}`)
  return hit[0]
}

/* ── LAYOUT UNITS ─────────────────────────────────────────────────────────── */

/** A length the probe reported to three decimals, as whole LayoutUnits (1/64
 *  of a device px). Exact recovery, see the header's last section. */
const lu = (dpr, css) => Math.round(css * dpr * 64)

/** A DECLARED length as layout stores it: scaled to the device, then TRUNCATED
 *  into LayoutUnits — `LayoutUnit(float)`, so the product goes through float32
 *  first, as it does in the engine. */
const truncLu = (dpr, css) => Math.floor(Math.fround(css * dpr) * 64)

/** LayoutUnits back to CSS px, for a failure message. */
const px = (dpr, units) => +(units / (64 * dpr)).toFixed(4)

const LINE_H = 24    // `line-height`, asserted as the computed `24px` below
const SPACING = 1.2  // `--list-spacing` 0.075em at 16px, asserted as `1.2px`
const itemLu = (dpr) => truncLu(dpr, LINE_H) + 2 * truncLu(dpr, SPACING)
const contLu = (dpr) => truncLu(dpr, LINE_H) + truncLu(dpr, SPACING)

/** The probe's reference run of `n` spaces — never the group's own width. */
function spaceRun(p, n) {
  const r = p.ref && p.ref.spaceRun
  assert.ok(Array.isArray(r) && r.length === 5,
    `the probe reported no reference space runs: ${JSON.stringify(p.ref)}`)
  // A reference that measured nothing would make every derived row "0 + pad",
  // and one that measured a min-width would be flat; a run must GROW by a space.
  assert.ok(r[0] === 0 && r[1] > 0 && r[2] > r[1] && r[3] > r[2] && r[4] > r[3],
    `the reference runs are not runs of spaces: ${JSON.stringify(r)}`)
  return r[n]
}

test('the line-box model reproduces every scale it was measured at',
  () => {
    // Pure arithmetic, so it runs with or without a display: it pins the
    // formula the next test computes its expectation from to the six measured
    // boxes in the header, so a model that is right at one scale by luck fails
    // here on every machine, whatever scale that machine's window runs at.
    for (const [dpr, item, cont] of [[1, 26.375, 25.1875],
                                     [1.25, 26.4, 25.2],
                                     [2, 26.390625, 25.1953125]]) {
      assert.equal(itemLu(dpr) / (64 * dpr), item, `item line box at dpr ${dpr}`)
      assert.equal(contLu(dpr) / (64 * dpr), cont, `continuation line box at dpr ${dpr}`)
    }
  })

test('§0.51 E99: a nested list ITEM keeps --list-spacing on BOTH sides',
  { skip: SKIP }, async () => {
    const p = await probeOnce()
    assert.ok(!p.error, String(p.error))
    assert.ok(p.dpr > 0, `no devicePixelRatio in the report: ${p.dpr}`)

    // The expectation at the scale this window REALLY runs at. See the header.
    const ITEM = itemLu(p.dpr)
    const CONT = contLu(p.dpr)
    const itemPx = px(p.dpr, ITEM)
    const contPx = px(p.dpr, CONT)

    // The ordered parent, for contrast — it was always right, and it is what
    // makes the assertion below "the nested one matches its parent" rather than
    // "the nested one is 26.4".
    const parent = lineOf(p, 'An ordered parent line')
    assert.equal(parent.lh, '24px', 'the line-height the line box is computed from moved')
    assert.equal(lu(p.dpr, parent.h), ITEM,
      `the ordered parent is ${parent.h} tall, not 24 + 2 × 1.2px at dpr ${p.dpr} = ${itemPx}`)
    assert.equal(parent.padT, '1.2px')
    assert.equal(parent.padB, '1.2px')

    for (const frag of ['A nested bullet under an ordered item',
                        'A second nested bullet',
                        'A tab-indented nested bullet',
                        'A nested bullet under a bullet']) {
      const l = lineOf(p, frag)
      assert.match(l.cls, /(^| )nc-li( |$)/, `${frag}: not a list line`)
      assert.ok(!/nc-li-cont/.test(l.cls),
        `${frag}: a nested ITEM was classified as a continuation`)
      assert.equal(l.padT, '1.2px', `${frag}: lost the top half of --list-spacing`)
      assert.equal(l.padB, '1.2px', `${frag}: lost the bottom half of --list-spacing`)
      assert.equal(lu(p.dpr, l.h), ITEM,
        `${frag}: the line box is ${l.h}, not Obsidian's ${itemPx} at dpr ${p.dpr}`)
    }

    // …and a CONTINUATION still gives the top half back (§0.35.1 E82). This is
    // the half that makes the pair meaningful rather than a rule that zeroes
    // everything: the item above has already opened the gap.
    for (const frag of ['hard-wrapped continuation', 'a continuation of that nested bullet']) {
      const l = lineOf(p, frag)
      assert.match(l.cls, /(^| )nc-li-cont( |$)/, `${frag}: not a continuation`)
      assert.equal(l.padT, '0px', `${frag}: pays for the gap above it twice`)
      assert.equal(l.padB, '1.2px')
      assert.equal(lu(p.dpr, l.h), CONT,
        `${frag}: the line box is ${l.h}, not ${contPx} at dpr ${p.dpr}`)
      // MEASURED against MEASURED: exactly one truncated padding shorter than the
      // parent item's box, so the pair cannot agree by both being wrong alike.
      assert.equal(lu(p.dpr, parent.h) - lu(p.dpr, l.h), truncLu(p.dpr, SPACING),
        `${frag}: ${l.h} is not one --list-spacing shorter than the item's ${parent.h}`)
    }
  })

test('§0.51 E99: the indent run renders at Obsidian\'s own widths',
  { skip: SKIP }, async () => {
    const p = await probeOnce()
    const d = p.dpr

    // EVERY claim below is the live Obsidian 1.13.7's on this note — see the
    // header. `w` is the rendered border box, not a token. A spacing group is
    // `spaces` reference runs wide plus its padding; a WHOLE group is the token.
    const cases = [
      // fragment,                              text,   spaces, padding, whole?
      ['A nested bullet under an ordered item', '"   "', 3,      '0px',   false],
      ['A second nested bullet',                '"   "', 3,      '0px',   false],
      ['A nested bullet under a bullet',        '"  "',  2,      '0px',   false],
      // A WHOLE TAB IS 36 AND NOT ITS OWN ADVANCE. This is the row that fails
      // if `min-width` is dropped: Cairn measured 30.087 before, and a tab's
      // advance at CM6's default `tab-size: 4` is 14.087.
      ['A tab-indented nested bullet',          '"\\t"', null,   '0px',   true],
      // The continuation keeps E81's 1em: 2 spaces + 16.
      ['hard-wrapped continuation',             '"  "',  2,      '16px',  false],
      // …and a FOUR-space continuation does NOT, because its last group is a
      // whole unit and Obsidian's selector is `.cm-indent-spacing:last-child`.
      // Measured live at 36.000 with `padding-inline-start: 0px`.
      ['a continuation of that nested bullet',  '"    "', null,   '0px',   true],
    ]

    for (const [frag, text, spaces, pad, whole] of cases) {
      const l = lineOf(p, frag)
      assert.equal(l.groups.length, 1, `${frag}: ${l.groups.length} groups, not 1`)
      const g = l.groups[0]
      assert.equal(g.text, text, `${frag}: the group covers the wrong characters`)
      if (whole) {
        assert.equal(g.w, 36, `${frag}: the indent run is ${g.w}, not --list-indent's 36`)
      } else {
        // The PADDING term is this row's literal, never `g.pad` — that is the
        // element under test, and reading it back would let a wrong padding
        // pay for itself.
        const run = spaceRun(p, spaces)
        const want = lu(d, run) + lu(d, Number.parseFloat(pad))
        assert.equal(lu(d, g.w), want,
          `${frag}: the indent run is ${g.w}, not ${spaces} spaces (${run}) + ${pad} = ` +
          `${px(d, want)} at dpr ${d} (space advance ${p.ref.spaceAdvance})`)
      }
      assert.equal(g.pad, pad, `${frag}: padding-inline-start is ${g.pad}, not ${pad}`)
      assert.equal(/(^| )nc-indent( |$)/.test(g.cls), whole,
        `${frag}: wrong group kind (${g.cls})`)

      // Obsidian's own two declarations on `.cm-hmd-list-indent` (app.css:13331),
      // and neither is cosmetic: without `inline-block` the padding does not
      // apply to the start of an inline box, and without `pre` the run of
      // spaces collapses to one.
      assert.equal(g.display, 'inline-block', `${frag}: not an inline-block`)
      assert.equal(g.ws, 'pre', `${frag}: the spaces can collapse`)
    }

    // THE TOKEN ITSELF, so a `min-width` that resolved to `auto` — which looks
    // identical on a note whose indents are all short — cannot pass.
    assert.equal(lineOf(p, 'A tab-indented nested bullet').groups[0].minW, '36px')

    // A MIXED RUN IS TWO GROUPS, AND THE TAB IS INSIDE THE FIRST ONE.
    //
    // Obsidian leaves that tab BARE between its two spans — verified in the
    // live 1.13.7's own innerHTML — and gets away with it because bare is still
    // inside the `inline-block` wrapper that re-origins the tab stop at the
    // start of the run. Cairn emits no wrapper, so a bare tab would take its
    // stop from the LINE, whose origin §0.31 E75's hanging indent has moved:
    // measured 46.05 against Obsidian's 59.05 before the tab was kept in the
    // group, and 59.05 after (Debian, dpr 1.25).
    //
    // 36 = two spaces then a tab to the next `--list-indent` stop, a token;
    // the second group = two spaces + E81's 1em. Both from the live app.
    const mixed = lineOf(p, 'two spaces, a tab, two spaces')
    assert.equal(mixed.groups.length, 2, `a mixed run is ${mixed.groups.length} groups, not 2`)
    assert.equal(mixed.groups[0].text, '"  \\t"', 'the tab escaped its group')
    assert.equal(mixed.groups[0].w, 36, 'the tab stop was taken from the LINE, not the group')
    assert.equal(mixed.groups[0].pad, '0px')
    assert.equal(mixed.groups[1].text, '"  "')
    const wantLast = lu(d, spaceRun(p, 2)) + lu(d, 16)
    assert.equal(lu(d, mixed.groups[1].w), wantLast,
      `the LAST group is ${mixed.groups[1].w}, not 2 spaces + 16 = ${px(d, wantLast)}: ` +
      'it is the one that takes the 1em')
    assert.equal(mixed.groups[1].pad, '16px')

    // A LINE WITH NO LEADING WHITESPACE GETS NO GROUP AT ALL. Marking one would
    // be a zero-width inline-block on every list line in the document.
    for (const frag of ['An ordered parent line', 'A top level bullet', 'A parent bullet']) {
      assert.equal(lineOf(p, frag).groups.length, 0, `${frag}: got an indent group`)
    }
    assert.equal(lineOf(p, 'Plain paragraph').groups.length, 0)
  })

test('§0.51 E99: the marker lands where Obsidian puts it',
  { skip: SKIP }, async () => {
    const p = await probeOnce()
    const d = p.dpr

    // THE USER-VISIBLE NUMBER, and the one the screenshots were cross-correlated
    // for. Measured in the live Obsidian on the reported note (Debian, dpr
    // 1.25): the ordered marker at 12.000 and the nested bullet's `-` at 22.563,
    // both from the `.cm-content` box. Cairn's nested marker was at 38.563
    // before — the 16.000 the user saw.
    //
    // `.nc-bullet` carries `--list-indent-editing` (12px) itself where
    // Obsidian's `.list-bullet` sits inside a padded `.cm-formatting-list-ul`,
    // so the marker X compared here is the padded box's left edge in both —
    // which is the indent run in front of it: a reference run of spaces for a
    // spacing group (10.563 / 7.050 on Debian, 12.563 / 8.375 on the Mac), the
    // 36px token for a tab.
    assert.equal(lineOf(p, 'An ordered parent line').markerX, 0)
    for (const [frag, spaces] of [['A nested bullet under an ordered item', 3],
                                  ['A second nested bullet', 3],
                                  ['A nested bullet under a bullet', 2]]) {
      const x = lineOf(p, frag).markerX
      const run = spaceRun(p, spaces)
      assert.equal(lu(d, x), lu(d, run),
        `${frag}: the marker is at ${x}, not after ${spaces} spaces (${run}) at dpr ${d}`)
    }
    assert.equal(lineOf(p, 'A tab-indented nested bullet').markerX, 36)
  })
