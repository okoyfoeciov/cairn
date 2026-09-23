/**
 * electron-shell/live-preview.test.mjs — §5.4.4's live preview, in the real
 * engine, end to end.
 *
 * ===========================================================================
 * WHAT THIS ADDS OVER `tests/frontend/livepreview.test.mjs`
 * ===========================================================================
 * That file tests the decorator with no DOM at all, which is the right shape
 * for the markdown model: it can drive `buildDecorations` with any document and
 * any selection and read the ranges back exactly. What it CANNOT see is
 * everything between a `DecorationSet` and a pixel.
 *
 * Two things live only there, and both are things a unit test on either end
 * passes throughout — the exact shape of §0.5 E7's seam bug:
 *
 *   1. THE WIDGETS REACH THE DOM. A `Decoration.replace({widget})` that CM6
 *      refuses (block decorations from a `ViewPlugin`, for instance) fails at
 *      render time, not at build time. `.nc-task`, `.nc-bullet` and `.nc-quote`
 *      being in the document is the receipt that they were accepted.
 *   2. THE TASK BOX EDITS THE DOCUMENT. A real `mousedown` on a real `<input>`
 *      inside a real `contenteditable`, through `posAtDOM`, into a `changes`,
 *      past `ignoreEvent`, and back out as a REBUILT widget carrying the other
 *      state. Nothing about that is observable without an engine.
 *
 * The probe is `CAIRN_LP_PROBE=1` in `app-main.mjs`. It reports; every
 * assertion is here.
 *
 * ===========================================================================
 * REQUIREMENTS
 * ===========================================================================
 * A display connection. The window is `CAIRN_HEADLESS=1` — offscreen and never
 * shown — but Electron still needs a compositor to have a window at all.
 * Skipped, not failed, where there is none.
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
 * One note carrying one of everything the scanner emits, so a widget that never
 * reached the DOM shows up as a zero rather than as a subtly wrong picture.
 * The FIRST task is unchecked on purpose: the probe clicks the first one it
 * finds and the assertion below is directional.
 */
const NOTE = [
  // §5.4.5's frontmatter, with the one shape that matters: a nested map, which
  // Obsidian's own type manager cannot name and renders as `mod-unknown` JSON.
  '---',
  'name: sink',
  // A BLOCK SEQUENCE, so a rename has something it could orphan.
  'tags:',
  '  - alpha',
  '  - beta',
  'metadata:',
  '  originSessionId: be5d9fee',
  '---',
  '',
  'Body line, then **bold** and `code` and a [link](https://example.com).',
  '',
  // §0.40 E87 — a table, HIGH IN THE FIXTURE so it is inside the viewport: its
  // decorations come from a StateField and so exist for the whole document,
  // but CM6 only builds DOM for the viewport, and a widget below the fold is
  // not a widget a probe can read.
  '| App | Path |',
  '|---|:-:|',
  '| Patient app | `apps/client` |',
  '',
  '## A heading',
  '',
  '- a bullet',
  '- [ ] an open task',
  '- [x] a done task',
  // §0.31 E75 — a bullet long enough to WRAP, so the hanging indent has
  // something to hang.
  //
  // AN ORDERED ITEM IS DELIBERATELY NOT HERE. One was added and taken out
  // again: `1. an ordered item …` made the hit-test row above report ONE
  // mismatch of ONE position (`cm 421 / dom 420`) — and the SAME mismatch
  // appears with the hanging-indent plugin removed, so it is the fixture line
  // and not the feature. It is the probe's sampling landing on a glyph
  // midpoint, where `caretRangeFromPoint` and `posAtCoords` round to different
  // sides of the same boundary. `KNOWN-ISSUES.md` V-4. Widening that
  // assertion's tolerance to admit it would blunt §0.26 E62's guard, so the
  // line goes instead, and a bullet against a task box already proves the
  // offset is measured rather than tokenised: two prefixes, two widths.
  '- a bullet long enough to wrap onto a second row so the hanging indent is visible and not merely computed',
  // §0.35 E81 — a HARD-WRAPPED continuation: its own line, two literal spaces.
  // Not a soft wrap, so E75's hanging indent never touches it.
  '- a hard-wrapped item whose source breaks the line itself',
  '  and this is its continuation, indented by two spaces in the file',
  '',
  '> quoted',
  '',
  '***',
  '',
  // §0.36 E83 — the two link kinds, in one paragraph, with the two negatives
  // beside them: a url inside backticks and a dotted host with no path.
  'a bare https://example.com/path_with_underscores and `api.example.com` and',
  'example.com alone, then [[a note]] and [[some/where|an alias]].',
  '',
  // §0.30 E73 — TWO HEADINGS SEPARATED BY EXACTLY ONE BLANK LINE. Obsidian gives
  // the second one no top padding, because the blank line is already a full line
  // of space, and that carve-out is a rule Cairn would otherwise have missed.
  '## Adjacent A',
  '',
  '## Adjacent B',
  '',
].join('\n')

function runProbe() {
  return new Promise((resolve, reject) => {
    const work = mkdtempSync(join(tmpdir(), 'cairn-lp-'))
    const cleanup = () => {
      try { rmSync(work, { recursive: true, force: true }) } catch {}
    }
    const vault = join(work, 'vault')
    mkdirSync(join(vault, 'Notes'), { recursive: true })
    writeFileSync(join(vault, 'Notes', 'sink.md'), NOTE)
    writeFileSync(join(vault, 'root.md'), 'root file\n')

    const child = spawn(BIN, [join(HERE, 'app-main.mjs')], {
      cwd: ROOT,
      env: {
        ...process.env,
        CAIRN_HEADLESS: '1',
        CAIRN_LP_PROBE: '1',
        /* The editing phases read `view.state.doc` through `window.__CM_VIEW__`,
           which `CAIRN_LP_PROBE` itself now installs (preload.cjs). Asking for
           it with `CAIRN_PIXELTEST=1` instead does NOT work: that also starts
           the geometry probe, whose report ends the run before this one gets a
           turn. */
        CAIRN_VAULT: vault,
        CAIRN_PIXELTEST_EXPANDED: 'Notes',
        CAIRN_PIXELTEST_NOTE: 'Notes/sink.md',
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
      const line = out.split('\n').find((l) => l.startsWith('LP_PROBE '))
      if (!line) {
        cleanup()
        reject(new Error('no LP_PROBE line\nstdout:\n' + out + '\nstderr:\n' + err))
        return
      }
      const result = JSON.parse(line.slice('LP_PROBE '.length))
      cleanup()
      resolve(result)
    })
  })
}

let cached = null
const probeOnce = async () => (cached ??= await runProbe())

/* ═══════════════════════════════════════════════════════════════════════════
 * §0.38 E85 — THE LINK CLICK, in its own probe because the last of the three
 * clicks OPENS ANOTHER NOTE and everything after it would be reading a
 * different document.
 *
 * NOTHING ON THE PATH IS STUBBED, and the fixture is what makes that safe: the
 * mod-click goes at an `ftp://` url, so it runs the real handler, the real
 * `linkTargetAt`, the real command 22 and the real allowlist — and the
 * allowlist REFUSES it, so no browser is ever launched by a test.  An `http:`
 * fixture would have tested the same code and opened a window on the machine
 * running it.
 * ═══════════════════════════════════════════════════════════════════════════ */

const LINK_NOTE = [
  'A bare https://example.com/plain and ftp://example.com/refused, then',
  '[[target note]] at the end.',
  '',
].join('\n')

function runLinkProbe() {
  return new Promise((resolve, reject) => {
    const work = mkdtempSync(join(tmpdir(), 'cairn-link-'))
    const cleanup = () => {
      try { rmSync(work, { recursive: true, force: true }) } catch {}
    }
    const vault = join(work, 'vault')
    mkdirSync(join(vault, 'Notes'), { recursive: true })
    writeFileSync(join(vault, 'Notes', 'links.md'), LINK_NOTE)
    // The wikilink's destination, and the ONLY note whose body says so.
    writeFileSync(join(vault, 'Notes', 'target note.md'), 'ARRIVED AT THE TARGET NOTE\n')

    const child = spawn(BIN, [join(HERE, 'app-main.mjs')], {
      cwd: ROOT,
      env: {
        ...process.env,
        CAIRN_HEADLESS: '1',
        CAIRN_LINK_PROBE: '1',
        CAIRN_VAULT: vault,
        CAIRN_PIXELTEST_EXPANDED: 'Notes',
        CAIRN_PIXELTEST_NOTE: 'Notes/links.md',
        CAIRN_STATE_DIR: join(work, 'state'),
        CAIRN_ELECTRON_GEOM: '1200x800',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = '', err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    const kill = setTimeout(() => {
      child.kill('SIGKILL')
      cleanup()
      reject(new Error('link probe timed out\nstdout:\n' + out + '\nstderr:\n' + err))
    }, 90_000)
    child.on('error', (e) => { clearTimeout(kill); cleanup(); reject(e) })
    child.on('exit', () => {
      clearTimeout(kill)
      const line = out.split('\n').find((l) => l.startsWith('LINK_PROBE '))
      if (!line) { cleanup(); reject(new Error('no LINK_PROBE line\nstdout:\n' + out + '\nstderr:\n' + err)); return }
      const result = JSON.parse(line.slice('LINK_PROBE '.length))
      cleanup()
      resolve(result)
    })
  })
}
let linkCached = null
const linkProbeOnce = async () => (linkCached ??= await runLinkProbe())

test('§0.38 E85: a plain click on a BARE url does nothing, as in Obsidian', { skip: SKIP }, async () => {
  const c = (await linkProbeOnce()).clicks
  assert.equal(c.hadPlain, true, 'the fixture did not render a bare url')
  // Obsidian's handler wants a `.cm-underline` for an external link and a bare
  // url never gets one, so a plain click is refused there too. Nothing reached
  // the command, so nothing reached the error path either.
  assert.deepEqual(c.afterPlain, [])
})

/* THE WHOLE PATH, AND THE ALLOWLIST, IN ONE CLICK. A mod-click IS a navigation
 * in Obsidian (`i = isModifier(e, "Mod") || button === 1`), so the handler
 * fires, reads the target out of the document, and calls command 22 — where the
 * MAIN process refuses the scheme. The refusal coming back as a §1.5
 * `invalidPath` and landing in `reportError` is the receipt for every link in
 * that chain. */
test('§0.38 E85: a mod-click reaches command 22, and the allowlist refuses ftp:', { skip: SKIP }, async () => {
  const c = (await linkProbeOnce()).clicks
  assert.equal(c.hadRefused, true, 'the fixture did not render the ftp url')
  const fresh = c.afterRefused.filter((m) => !c.afterPlain.includes(m))
  assert.equal(fresh.length, 1, 'expected exactly one report: ' + JSON.stringify(c.afterRefused))
  assert.match(fresh[0], /cairn\[open-external\]/, 'the failure did not reach reportError')
  assert.match(fresh[0], /http, https and mailto/, 'not the allowlist refusal: ' + fresh[0])
})

test('§0.38 E85: a plain click on a wikilink OPENS the note it names', { skip: SKIP }, async () => {
  const c = (await linkProbeOnce()).clicks
  assert.equal(c.hadWiki, true, 'the fixture did not render a wikilink')
  assert.ok(!c.textBefore.includes('ARRIVED'), 'the fixture was already showing the target')
  assert.ok(c.textAfter.includes('ARRIVED AT THE TARGET NOTE'),
    'the click did not open the note: ' + JSON.stringify(c.textAfter))
  assert.equal(c.tab, 'target note', 'the tab still names the old note')
})


/* THE DEFECT THE REFERENCE SCREENSHOT SHOWED.  `---` matched `HR_RE`, so every
 * note with frontmatter drew two thematic breaks across its top and its YAML as
 * body text.  Asserted on `.nc-hr-rule` because that is the widget that was
 * wrongly there, not on the absence of the text. */
test('§5.4.5: frontmatter draws no thematic break and leaves no raw YAML', { skip: SKIP }, async () => {
  const { before } = await probeOnce()
  // ONE, not zero: the note ends with a real `***`.  Two `---` delimiters
  // rendered as breaks would make it three, which is what the reference
  // screenshot showed across the top of the note.
  assert.equal(before.rules, 1, 'a `---` delimiter rendered as an <hr>')
  // The `.cm-line` elements are the DOCUMENT's lines.  If the block replace had
  // not taken, the first of them would be `---` and the second `name: sink`;
  // the key name itself is a useless probe because the Properties block
  // legitimately renders it inside the `mod-unknown` JSON.
  assert.equal(before.firstLines[0], '', 'the first rendered line is the blank after the block')
  assert.ok(!before.firstLines.some((l) => l.startsWith('---') || l.includes('originSessionId:')),
    'a frontmatter line is still being rendered as document text')
})

/* ═══════════════════════════════════════════════════════════════════════════
 * §5.4.2 / §5.4.5 — A CLICK MUST LAND WHERE THE POINTER IS
 *
 * The defect the user reported on 2026-09-10: "the position of the cursor is
 * between `client` and `component`. I clicked. The caret jumps down 2 lines."
 * It was not the parser and not the note.  CM6 resolves a coordinate to a
 * document position through its HEIGHT MAP, and it builds that map out of
 * `child.dom.getBoundingClientRect().height` — a BORDER BOX, which excludes
 * margins.  Every margin inside `.cm-content` was therefore real to the layout
 * and absent from the map, so the map ran short and the map is what decides.
 *
 * The three that were leaking, and they ADD:
 *   `.nc-title`          margin-bottom  12.944  (--inline-title-margin-bottom)
 *   `.metadata-container` margin-block-end 32   (2rem, app.css:11172)
 *   `.nc-hN`             margin-bottom  10..0   (--hN-space-after)
 * — 44.944px before the first line of a note with frontmatter, and one more
 * heading's worth for every heading above the click.  At a 24px body pitch that
 * is the two lines the user counted.
 *
 * WHY THIS TEST AND NOT A UNIT TEST.  Nothing below a real engine can see it:
 * the decorations are correct, the DOM is correct, the CSS is correct, and the
 * only thing that is wrong is a number CM6 measured off boxes that only exist
 * once something has laid them out.  `tests/frontend/editor.test.mjs` pins the
 * CSS rule that prevents it; this pins the CONSEQUENCE, which is the part that
 * matters and the part that would survive a clever refactor of the sheet.
 * ═════════════════════════════════════════════════════════════════════════ */
test('§0.31.6 E76: a negative text-indent does not collapse the bullet', { skip: SKIP }, async () => {
  const b = (await probeOnce()).before.bullet
  assert.ok(b, 'no bullet in the fixture')

  // THE REGRESSION E75 SHIPPED FOR ONE BUILD. `text-indent` INHERITS, and E75
  // writes a NEGATIVE one on the line; `.nc-bullet` is `display: inline-flex`,
  // so it reached the anonymous flex item inside — a block container — and took
  // that item's max-content width to `max(0, advance - k)`. The span's border
  // box collapsed to its padding alone and the dot moved 3.4px left. The user
  // saw it as "the first line of each bullet" being wrong while the wrapped
  // body lines were right, which is exactly the shape of a bug in the first
  // line only.
  assert.equal(b.textIndent, '0px',
    'the bullet inherited the line\'s negative text-indent — [S] app.css:3621 ' +
    '`.cm-line > * { text-indent: 0 }` is the companion to the hanging indent, not an extra')
  assert.notEqual(b.lineTextIndent, '0px',
    'the LINE has no hanging indent, so this row proves nothing — check E75 first')

  // …and the box is its padding PLUS its content, which is what the reset buys.
  assert.ok(b.content > 0, 'the bullet character has no advance at all')
  assert.ok(b.w > b.content,
    `the bullet box (${b.w}) did not grow past its content (${b.content}) — it is collapsed`)

  // The dot sits where Obsidian's sits: 12.984px from the line's left, measured
  // both ways on the same DOM at dpr 1. Asserted as the RELATION rather than the
  // literal, because this probe runs at the desktop's own scale and Chromium
  // snaps these to the device grid there (the same run reports 4.8 at dpr 1.25
  // and 4.79688 at dpr 1) — §0.19 E27's rule: quote a geometry number with its
  // dpr, or assert something that does not depend on one.
  const dotW = Number.parseFloat(b.dotWidth)
  const dotL = Number.parseFloat(b.dotLeft)
  const pad = b.w - b.content                       // --list-indent-editing, 0.75em
  assert.ok(Math.abs(dotW - 0.3 * 16) < 0.05, `--list-bullet-size 0.3em moved: ${b.dotWidth}`)
  // CENTRED ON THE MARKER'S ADVANCE, which is what `justify-content: center` on
  // the padded box buys and what the collapse destroyed: with the box at its
  // padding alone the dot centred at 12.0 instead of 15.38.
  assert.ok(Math.abs(dotL - (pad + (b.content - dotW) / 2)) < 0.6,
    `the dot is not centred on the bullet's advance: dotLeft ${dotL}, ` +
    `padding ${pad}, content ${b.content}`)
})

test('§0.35 E81: a HARD-WRAPPED list continuation gets Obsidian\'s 1em of indent',
  { skip: SKIP }, async () => {
    const c = (await probeOnce()).before.contIndents
    assert.equal(c.length, 1, `wrong number of continuation spans: ${JSON.stringify(c)}`)
    const sp = c[0]

    // [S] `.HyperMD-list-line-nobullet > .cm-hmd-list-indent > .cm-indent-spacing
    //      :last-child { padding-inline-start: calc(--list-indent-editing +
    //      --list-marker-space) }` (app.css:13328) = 0.75em + 0.25em = 1em.
    // MEASURED both apps, same DOM, same engine, dpr 1: Obsidian's span is
    // 23.047px wide (7.047 of real spaces + 16 of padding) and Cairn's was
    // 7.047 before this. The 16.000 difference is the 20 device px the user
    // reported at dpr 1.25.
    assert.equal(sp.pad, '16px', 'the continuation lost Obsidian\'s 1em')
    // THE WIDTH IS DERIVED, NOT PINNED (2026-09-13). 23.047 was a Debian number:
    // 7.047 of it is two SPACE ADVANCES, `--font-text` opens `ui-sans-serif,
    // -apple-system, …`, and the Mac's engine lands on `.SF NS`, whose two
    // spaces are 8.375 — so the Mac measured 24.375, in Cairn AND in the live
    // Obsidian on the same note, and this row failed on a correct app. The 16px
    // above is the token and does not move; the spaces move with the font.
    //
    // So the expectation is the probe's REFERENCE run of two spaces — a
    // body-level box in `.cm-content`'s computed font, laid out and snapped by
    // this engine at this scale, and never the span under test — plus the
    // literal 16. Compared in whole LayoutUnits (1/64 device px), EXACTLY, where
    // the old row allowed ±0.5; `indent.test.mjs`'s header has why a run and
    // not 2 × one advance, why LayoutUnits and not the three decimals, and the
    // Debian arithmetic: at dpr 1 an advance of ~3.52 snaps 2 spaces to 451/64
    // = 7.046875, + 16 = 23.047. Debian has not run this version.
    const ref = (await probeOnce()).before.fontRef
    assert.ok(ref && Array.isArray(ref.spaceRun) && ref.spaceRun[1] > 0 &&
              ref.spaceRun[2] > ref.spaceRun[1],
      `the probe reported no reference space runs: ${JSON.stringify(ref)}`)
    const lu = (css) => Math.round(css * ref.dpr * 64)
    const want = lu(ref.spaceRun[2]) + lu(16)
    assert.equal(lu(sp.w), want,
      `the indent span is ${sp.w}, not two spaces (${ref.spaceRun[2]}) + 16 = ` +
      `${+(want / (64 * ref.dpr)).toFixed(4)} at dpr ${ref.dpr} ` +
      `(space advance ${ref.spaceAdvance})`)

    // Obsidian's own two declarations on `.cm-hmd-list-indent`, and neither is
    // cosmetic: without `inline-block` the padding does not apply to the start
    // of an inline box, and without `pre` the run of spaces collapses to one.
    assert.equal(sp.display, 'inline-block')
    assert.equal(sp.ws, 'pre')
    assert.equal(sp.text, '"  "', 'the span covers the literal whitespace and nothing else')

    // §0.35.1 E82 — AND THE LINE TAKES THE BOTTOM HALF OF `--list-spacing` ONLY.
    // Obsidian's stream mode emits `line-HyperMD-list-line` for a continuation
    // too, so it gets the spacing on both sides from the shared rule and then
    // `HyperMD-list-line-nobullet { padding-top: initial }` gives the top back:
    // the item's own top spacing already opened the gap above it.
    //
    // Reported as "Obsidian has more spacing (vertically) among them": the pitch
    // between two consecutive continuations measured 30/30/30 device px in Cairn
    // against 31/32/32 in Obsidian, while paragraph→bullet (31/31) and
    // bullet→continuation (32/32) already agreed — the signature of a rule that
    // applies to a continuation and not to an item.
    assert.match(sp.lineCls, /(^| )nc-li( |$)/, 'a continuation line is not a list line')
    assert.match(sp.lineCls, /(^| )nc-li-cont( |$)/)
    assert.equal(sp.linePadTop, '0px',
      'a continuation pays for the gap above it twice — the item above already opened it')
    assert.equal(sp.linePadBottom, '1.2px', '--list-spacing 0.075em moved')

    // …and the ITEM line still takes BOTH sides, which is what makes the
    // override meaningful rather than a rule that zeroes everything.
    const item = (await probeOnce()).before.itemLinePad
    assert.ok(item, 'no plain list item in the fixture')
    assert.equal(item.top, '1.2px', 'the override leaked onto real list items')
    assert.equal(item.bottom, '1.2px')
  })

test('§0.31 E75: a wrapped list line hangs under its own text, and a paragraph does not',
  { skip: SKIP }, async () => {
    const p = await probeOnce()
    const rows = p.before.indents
    const li = rows.filter((r) => r.li)
    const plain = rows.filter((r) => !r.li)

    // EVERY list line gets one, and it is `padding-inline-start: k` with
    // `text-indent: -k` — Obsidian's own pair, so the FIRST row starts where it
    // always did and only the wrapped rows move.
    assert.ok(li.length >= 4, `too few list lines to test: ${li.length}`)
    for (const r of li) {
      const k = Number.parseFloat(r.paddingInlineStart)
      assert.ok(k > 0, `a list line got no hanging indent: ${JSON.stringify(r)}`)
      assert.equal(r.textIndent, `-${k}px`,
        'text-indent must be the negation of the padding, or the FIRST row moves too')
    }

    // …AND A LINE WITH NO PREFIX DOES NOT. `listPrefix` returns null there, which
    // is what keeps this off ordinary paragraphs.
    //
    // "NO PREFIX" IS NOT THE SAME AS "NOT A LIST", and the difference is
    // Obsidian's, found by this row failing: its regex is
    // `^([>\s]*)(([*+-] |(\d+)([.)] ))(?:\[(.)\] )?)?` — the list marker is
    // OPTIONAL and the leading `[>\s]*` is not, so `> quoted` matches with a
    // non-empty `> ` and takes a hanging indent too. A wrapped blockquote line
    // hangs under its own text in Obsidian for exactly that reason. The
    // predicate here is therefore the PREFIX, never Cairn's `.nc-li` class.
    const prefixed = (t) => /^([>\s]*)(([*+-] |(\d+)([.)] ))(?:\[(.)\] )?)?/.exec(t)?.[0]
    for (const r of plain) {
      if (prefixed(r.text)) continue
      assert.equal(r.paddingInlineStart, '0px', `an unprefixed line was indented: ${JSON.stringify(r)}`)
      assert.equal(r.textIndent, '0px')
    }

    // THE OFFSET IS MEASURED, NOT TOKENISED, and this is the assertion that says
    // so: a bare bullet and a task box are two prefixes of two different widths,
    // and no single constant is right for both.
    const widthOf = (needle) => {
      const r = rows.find((x) => x.text.includes(needle))
      return r ? Number.parseFloat(r.paddingInlineStart) : null
    }
    // The probe truncates each line to 20 characters, so the needles are short.
    const bullet = widthOf('a bullet long')
    const task = widthOf('an open task')
    assert.ok(bullet, `the wrapping bullet is gone from the fixture: ${JSON.stringify(rows.map((r) => r.text))}`)
    assert.ok(task, 'the task line is gone from the fixture')
    assert.ok(task > bullet,
      `a task box (${task}) did not widen the prefix past a bare bullet (${bullet}) — ` +
      'that would mean the offset is a constant, not a measurement')
  })

test('§0.30 E73: every heading carries Obsidian\'s 16px of space above it', { skip: SKIP }, async () => {
  const p = await probeOnce()
  const hs = p.before.headings
  // `## A heading`, `## Adjacent A`, `## Adjacent B` — the shared `nc-h` class
  // is what the rules hang off, so a heading that lost it is invisible here and
  // would silently lose its spacing.
  assert.equal(hs.length, 3, `wrong heading count: ${JSON.stringify(hs.map((h) => h.text))}`)
  for (const h of hs) assert.match(h.cls, /\bnc-h\b/, 'a heading lost the shared class')

  // [S] `.cm-s-obsidian .cm-line.HyperMD-header { padding-top: var(--p-spacing) }`
  // (app.css:12871) with `--p-spacing: 1rem` (app.css:2577). Cairn had NO space
  // above a heading at all until the user caught it in two screenshots: its H1
  // ink sat 20 device px high at dpr 1.25, which is 16 CSS px exactly.
  assert.equal(hs[0].padTop, '16px', 'a heading in running text lost its space above')
  assert.equal(hs[1].padTop, '16px')

  // …AND THE CARVE-OUT. A heading whose previous line is EMPTY takes none: the
  // blank line is already a full line of space, and Obsidian writes
  // `.HyperMD-header + .cm-line:has(>br:only-child) + .cm-line.HyperMD-header
  //  { padding-top: 0 }` for it. `Adjacent B` is that shape and `Adjacent A` is
  // not, which is why both are in the fixture.
  assert.equal(hs[2].afterBlank, true, 'the fixture no longer produces the blank-line shape')
  assert.equal(hs[2].padTop, '0px', 'a heading one blank line below another paid for it twice')
  assert.equal(hs[1].afterBlank, true)

  // …AND NOTHING BELOW (§0.30 E74). Obsidian's heading declares no
  // `padding-bottom` and its base `.cm-line` is `padding: 0` (app.css:3888), so
  // the gap under a heading is the next line box and nothing else. Cairn had
  // 10/9/8/7/6/6 px of its own there; the user saw it as the space between
  // `Memory Index` and the list under it.
  for (const h of hs) assert.equal(h.padBottom, '0px', 'a heading grew space below it again')
})

test('§5.4.2: CM6\'s height map agrees with the engine\'s own hit test at every y', { skip: SKIP }, async () => {
  const { hit } = await probeOnce()
  assert.ok(!hit.error, `the hit-test phase never ran: ${hit.error}`)
  // A fixture that rendered nothing would make this vacuous.  The note carries
  // frontmatter, a heading, three list rows, a quote and a rule, so a healthy
  // run samples every text row in it — twelve at the time of writing.
  assert.ok(hit.points.length >= 10,
    `only ${hit.points.length} sample points — the fixture did not render`)
  assert.deepEqual(hit.mismatches, [],
    'CM6 resolved a click to a different document position than the engine\'s own ' +
    'hit test at the same pixel. That is the height map running short of the layout, ' +
    'and the cause is always a MARGIN on something inside `.cm-content` — CM6 records ' +
    'border boxes (`measureVisibleLineHeights`), so it cannot see one. Use padding, or ' +
    'put the element inside a `.nc-block` (`display: flow-root`), which contains it.')
})

test('§5.4.2: both block widgets sit inside the flow-root box that contains their margin', { skip: SKIP }, async () => {
  const { hit } = await probeOnce()
  assert.equal(hit.wrapped.title, 'nc-block',
    '.nc-title is no longer wrapped — CM6 will measure it WITHOUT its 12.944px margin-bottom')
  assert.equal(hit.wrapped.metadata, 'nc-block',
    '.metadata-container is no longer wrapped — CM6 will measure it WITHOUT its 2rem margin-block-end')
})

/* The same defect from the other end, as one number instead of 100 samples:
 * what CM6 thinks the document is worth against what was actually laid out.
 * This is the row that moves first when a new widget arrives carrying a margin,
 * and it says by how much. */
test('§5.4.2: docHeight equals the height that was actually laid out', { skip: SKIP }, async () => {
  const { hit } = await probeOnce()
  assert.ok(hit.laidOut !== null, 'the content box was empty')
  assert.ok(Math.abs(hit.docHeight - hit.laidOut) < 0.5,
    `CM6's height map says ${hit.docHeight} and the DOM occupies ${hit.laidOut} — ` +
    `short by ${(hit.laidOut - hit.docHeight).toFixed(3)}px of margin it cannot see`)
})

test('§5.4.5: the Properties block renders one row per key, in file order', { skip: SKIP }, async () => {
  const { before } = await probeOnce()
  assert.equal(before.propsTitle, 'Properties')
  assert.deepEqual(before.props.map((p) => p.key), ['name', 'tags', 'metadata'])
  assert.equal(before.props[0].value, 'sink')
  // A nested map: Obsidian gives it `mod-unknown` and `JSON.stringify`.
  assert.equal(before.props[2].unknown, true)
  assert.equal(before.props[2].value, '{"originSessionId":"be5d9fee"}')
  // The icons are real SVG, painted through `icons.ts` — a `data-icon` host
  // that `paintIcons` never reached would leave this null.
  assert.ok(before.props[0].icon, 'the type icon was never painted')
  assert.notEqual(before.props[0].icon, before.props[2].icon,
    'text and unknown must not share a glyph')
})

/* §9 E4 is satisfied by the button WORKING, not by its absence — which is what
 * it was before the user asked where it had gone. */
test('§5.4.5: the Add-property button is drawn, with its icon and label', { skip: SKIP }, async () => {
  const { edit } = await probeOnce()
  assert.equal(edit.hasAdd, true)
  assert.match(edit.addLabel, /Add property/)
  assert.equal(edit.addIcon, true, 'the `+` was never painted')
})

test('§5.4.4: every widget kind reaches the real DOM', { skip: SKIP }, async () => {
  const { before } = await probeOnce()
  assert.equal(before.tasks, 2, 'both task checkboxes rendered')
  // THREE: the original, §0.31 E75's wrapping bullet, and §0.35 E81's
  // hard-wrapped one. The count is asserted rather than loosened to `>= 1`: a
  // bullet that stopped rendering its dot is what this row exists to catch.
  assert.equal(before.bullets, 3, 'a non-task bullet lost its dot')
  assert.equal(before.quoteRules, 1, 'the blockquote line got its rule')
  assert.ok(before.strong >= 1, 'the bold mark reached the DOM')
})

/* The editor is not focused in an offscreen run, and Obsidian's rule — which
 * §5.4.4 follows — is `hasFocus ? selection.ranges : []`. So the markers are
 * hidden here, which is what makes `lineText` a clean assertion: if the `- ` or
 * the `[ ]` were still in the rendered line, they would appear in it. */
test('§5.4.4: an unfocused editor renders the task line with no markup', { skip: SKIP }, async () => {
  const { before } = await probeOnce()
  // `.trim()`: the space AFTER `[ ]` is content, not markup — CM5's
  // `formatting-task` token is the three bracket characters and no more — so it
  // is legitimately still in the rendered line and is not what this asserts.
  assert.equal(before.lineText.trim(), 'an open task',
    'the `- ` and the `[ ]` are both gone from the rendered line')
})

test('§5.4.4: the first box reads unchecked, from the document', { skip: SKIP }, async () => {
  const { before } = await probeOnce()
  assert.equal(before.dataTask, ' ')
  assert.equal(before.checked, false)
})

/* THE ONE THAT NEEDED AN ENGINE. A checkbox that cannot be ticked is worse than
 * no checkbox: it renders as an affordance and then lies. The state read back
 * comes from a REBUILT widget — the click writes `x` into the document, the
 * scanner re-reads it, and a different `Decoration` singleton is what lands. */
test('§5.4.4: a real click on the box edits the document and the widget follows', { skip: SKIP }, async () => {
  const { before, after } = await probeOnce()
  assert.equal(after.dataTask, 'x', 'the click did not write `x` into the document')
  assert.equal(after.checked, true)
  assert.equal(after.tasks, 2, 'the other task box survived the rebuild')
  assert.equal(after.lineText, before.lineText, 'and the click disturbed nothing else on the line')
})

/* =========================================================================
 * §5.4.5's FOLD ARROW.
 *
 * Three details, all of which the first draft got wrong and none of which a
 * decoration test can see: it is invisible at rest, it is the ACCENT colour
 * once collapsed, and it is 10px at stroke 4 where the property icons beside it
 * are 18px at stroke 1.75.  Every number below is `app.css`'s, cited in
 * `editor.css` §6 and `icons.ts`.
 * ======================================================================= */

test('§5.4.5: the fold arrow is invisible until the heading is hovered', { skip: SKIP }, async () => {
  const { before } = await probeOnce()
  assert.ok(before.fold, 'no collapse indicator in the DOM at all')
  assert.equal(before.fold.opacity, '0', 'app.css:7238 — `.collapse-indicator { opacity: 0 }`')
  assert.deepEqual(before.fold.collapsedOn, [false, false, false])
  assert.equal(before.fold.rowShown, true)
})

test('§5.4.5: the glyphs are Obsidian\'s two different sizes, not one', { skip: SKIP }, async () => {
  const { before } = await probeOnce()
  // app.css:7270 overrides both for the fold arrow …
  assert.equal(before.fold.w, '10')
  assert.equal(before.fold.stroke, '4')
  // … and :7336 + :2334 leave the property icons at the document default.
  assert.equal(before.fold.propIconW, '18')
})

test('§5.4.5: folding sets is-collapsed on all three elements', { skip: SKIP }, async () => {
  const { collapsed } = await probeOnce()
  // app.js:36069's own list: container, heading, foldEl.  Each drives a
  // different rule — rows, nothing, and the rotation respectively.
  assert.deepEqual(collapsed.fold.collapsedOn, [true, true, true])
  assert.equal(collapsed.fold.rowShown, false, 'app.css:11188 — the rows go')
})

/* THE ONE IN THE SCREENSHOT.  Grey in both states was simply wrong:
 * app.css:2186 is `--collapse-icon-color-collapsed: var(--text-accent)`. */
test('§5.4.5: collapsed, the arrow is visible, accent-coloured and rotated', { skip: SKIP }, async () => {
  const { before, collapsed } = await probeOnce()
  assert.equal(collapsed.fold.opacity, '1', 'app.css:7253 — `.is-collapsed .collapse-indicator`')
  assert.equal(collapsed.fold.colour, 'rgb(166, 138, 249)',
    '--text-accent = hsl(255, 89.76%, 75.9%); a faint grey here is the reported defect')
  assert.notEqual(collapsed.fold.colour, before.fold.colour, 'the two states must differ')
  // `rotate(-90deg)` is `matrix(0, -1, 1, 0, 0, 0)`.  On the SVG, not the box:
  // the box is absolutely positioned with 6px of side padding, so rotating it
  // pivots 6px off the glyph's centre.
  assert.equal(collapsed.fold.transform, 'matrix(0, -1, 1, 0, 0, 0)')
  assert.equal(before.fold.transform, 'none')
})

/* =========================================================================
 * §5.4.5's FOLD ANIMATION.
 *
 * Reported by the user: "Obsidian - smooth. Cairn: just show/hide abruptly."
 * It was a class flip.  Obsidian animates the content wrapper's height —
 * `kl`/`bl`/`wl`/`yl` in `app.js`, 100ms on `cubic-bezier(.02, .01, .47, 1)`
 * with `overflow-y: clip` for the duration — and `properties.ts` now ports it.
 *
 * THE MID-FLIGHT SAMPLE IS THE POINT.  A settled-state assertion cannot tell a
 * transition from an instant collapse: both end at zero.  The probe clicks and
 * reads 40ms later in ONE evaluation, so the only way `mid` lands strictly
 * between 0 and the resting height is if something is actually interpolating.
 * ======================================================================= */

test('§5.4.5: the fold is a real height transition, caught mid-flight', { skip: SKIP }, async () => {
  const { flight } = await probeOnce()
  assert.ok(flight, 'no .metadata-content wrapper — the animation has nothing to move')
  assert.ok(flight.rest > 20, `the block must have a resting height, got ${flight.rest}`)
  assert.ok(flight.mid > 0 && flight.mid < flight.rest,
    `40ms in, the height must be BETWEEN 0 and ${flight.rest}; got ${flight.mid}. ` +
    'Equal to rest means the transition never started; 0 means it is still a class flip')
})

test('§5.4.5: the transition is Obsidian\'s own 100ms curve', { skip: SKIP }, async () => {
  const { flight } = await probeOnce()
  // app.js `bl`/`wl`: `new dl({ duration: 100, fn: "cubic-bezier(.02, .01, .47, 1)" })`
  assert.equal(flight.duration, '0.1s')
  assert.equal(flight.easing, 'cubic-bezier(0.02, 0.01, 0.47, 1)')
  // `i10.addProp("overflowY", "clip", ...)` — without it the rows spill out of
  // the shrinking box instead of being clipped by it.
  assert.equal(flight.overflowY, 'clip')
  assert.match(flight.property, /height/)
})

/* `kl`: collapse animates to 0 and THEN hides.  The inline styles must all be
 * released, or the next expand measures a wrapper already pinned to zero and
 * animates from 0 to 0 — which is the abrupt behaviour again, one fold later. */
test('§5.4.5: it ends hidden, with every inline style released', { skip: SKIP }, async () => {
  const { settled } = await probeOnce()
  assert.equal(settled.display, 'none', 'app.js `kl`: animate to 0, then hide')
  assert.equal(settled.height, 0)
  for (const leaked of ['height', 'transition', 'overflow-y', 'padding', 'margin']) {
    assert.ok(!settled.inline.includes(leaked),
      `the animation leaked an inline ${leaked}: ${settled.inline}`)
  }
})

/* =========================================================================
 * §5.4.5's EDITING.
 *
 * These write to the note, so the assertions are on the WHOLE DOCUMENT, not on
 * the field that changed.  A one-line writer is only a one-line writer if every
 * other line is byte-identical afterwards, and that is the property worth a
 * test: §1's parser refuses ten YAML constructs, so anything it did not model
 * has to survive an edit somewhere else in the same block untouched.
 * ======================================================================= */

/* Obsidian's `addProperty("")` renders a row and writes NOTHING; the file
 * changes only once the key has a name.  A click the user then abandons must
 * leave the note byte-identical. */
test('§5.4.5: Add property adds a ROW and writes nothing yet', { skip: SKIP }, async () => {
  const { edit } = await probeOnce()
  assert.equal(edit.rowsAfterAdd, 4, 'three properties plus the new empty one')
  assert.equal(edit.docAfterAdd, edit.start, 'clicking Add must not touch the file')
  assert.match(edit.focusedAfterAdd, /metadata-property-key-input/,
    'the new key input must take focus, or the row cannot be named')
})

test('§5.4.5: naming it inserts ONE line, before the closing `---`', { skip: SKIP }, async () => {
  const { edit } = await probeOnce()
  const was = edit.start.split('\n')
  const now = edit.docAfterName.split('\n')
  assert.equal(now.length, was.length + 1)
  // The new line goes in immediately above the closing delimiter …
  const close = was.indexOf('---', 1)
  assert.equal(now[close], 'status:')
  assert.equal(now[close + 1], '---')
  // … and every other line is untouched, in order.
  assert.deepEqual(now.filter((l, i) => i !== close), was)
})

test('§5.4.5: setting a value rewrites that line and no other', { skip: SKIP }, async () => {
  const { edit } = await probeOnce()
  const was = edit.docAfterName.split('\n')
  const now = edit.docAfterValue.split('\n')
  assert.equal(now.length, was.length)
  const diff = now.map((l, i) => (l === was[i] ? null : i)).filter((i) => i !== null)
  assert.deepEqual(diff.length, 1, `exactly one line may change, ${diff.length} did`)
  assert.equal(now[diff[0]], 'status: open')
})

/* THE ONE THAT NEEDED THE SURGICAL WRITER.  `tags:` owns a block sequence on
 * the two lines below it.  A rename that rewrote the whole line as
 * `labels: <serialised>` would strand `- alpha` / `- beta` under a key that no
 * longer describes them — or drop them, if the writer re-serialised from a
 * parse that had not modelled them.  Only the KEY TEXT is replaced. */
test('§5.4.5: renaming a key with a block value does not orphan it', { skip: SKIP }, async () => {
  const { edit } = await probeOnce()
  const was = edit.docAfterValue.split('\n')
  const now = edit.docAfterRename.split('\n')
  assert.equal(now.length, was.length)
  const i = was.indexOf('tags:')
  assert.ok(i > 0, 'the fixture must carry a block sequence')
  assert.equal(now[i], 'labels:')
  assert.equal(now[i + 1], '  - alpha', 'the sequence must still be there')
  assert.equal(now[i + 2], '  - beta')
  assert.deepEqual(now.filter((l, n) => n !== i), was.filter((l, n) => n !== i))
})

/* The `description` in the reference note is a double-quoted scalar full of
 * `#`, `(`, `:` and an em dash.  If an unrelated edit ever re-serialised the
 * block, that is the line that would come back subtly different. */
test('§5.4.5: every line the user did not edit is byte-identical', { skip: SKIP }, async () => {
  const { edit } = await probeOnce()
  for (const line of ['name: sink', '  - alpha', '  - beta', 'metadata:', '  originSessionId: be5d9fee']) {
    assert.ok(edit.docAfterRename.includes('\n' + line + '\n') || edit.docAfterRename.startsWith(line + '\n'),
      `\`${line}\` did not survive the edits verbatim`)
  }
})

/* KNOWN-ISSUES PR-2. `PropertiesWidget.eq` compares the frontmatter TEXT, so
 * committing any property edit destroys the widget and builds a new one — and
 * the fold state lived nowhere but the DOM classes the old widget took with it,
 * so the block sprang back open on every edit. It is a `StateField` now, whose
 * lifetime is the point: a note switch is `view.setState(...)` (M70) and builds
 * a fresh field, so the fold resets per note without anything having to notice
 * a note switch, while a document edit is a transaction, which a field
 * survives.
 *
 * `widgetRebuilt` IS THE ROW THAT KEEPS THIS HONEST: the probe marks the
 * container before the edit, and if the widget were not actually rebuilt there
 * would be nothing for the fold to survive and the test would be measuring
 * nothing at all. */
test('PR-2: the Properties fold survives the widget rebuild an edit causes',
  { skip: SKIP }, async () => {
    const { edit } = await probeOnce()
    const pr2 = edit.pr2
    assert.ok(pr2, 'the probe must have found the Properties heading')
    assert.equal(pr2.collapsedAfterClick, true, 'the click must collapse it')
    assert.equal(pr2.displayAfterClick, 'none', 'and the rows must actually be gone')

    assert.equal(pr2.docChanged, true, 'the probe must really have edited the frontmatter')
    assert.equal(pr2.widgetRebuilt, true,
      'the edit must really have destroyed the widget, or this row proves nothing')

    assert.equal(pr2.collapsedAfterEdit, true, 'and the fold must survive — this IS the defect')
    assert.equal(pr2.displayAfterEdit, 'none', 'applied as the end state, without animating')
  })

/* app.css:14147 — a TICKED task line is struck through and muted. Both tokens
 * (`--checklist-done-decoration` :2163, `--checklist-done-color` :2164) were
 * transcribed into `tokens.css` with their line numbers beside them and NOTHING
 * consumed either, so every finished task looked exactly like an open one.
 *
 * ASSERTED AS COMPUTED STYLE, and that is the point rather than a detail: a
 * declaration that is correct, present and outranked fails in total silence
 * here — §0.45 E93's caret, §0.24.5 E53's transitions, twice more since — so a
 * test that read the stylesheet would pass against a rule the cascade throws
 * away. `--text-muted` is `#b3b3b3`. */
test('§5.4.4: a ticked task line is struck through and muted; an open one is not',
  { skip: SKIP }, async () => {
    const { before } = await probeOnce()
    const lines = before.taskLines ?? []
    assert.equal(lines.length, 2, 'the fixture carries one open task and one done one')
    const done = lines.filter((l) => l.checked)
    const open = lines.filter((l) => !l.checked)
    assert.equal(done.length, 1)
    assert.equal(open.length, 1)

    assert.match(done[0].cls, /\bnc-li-done\b/)
    assert.equal(done[0].decoration, 'line-through', '--checklist-done-decoration')
    assert.equal(done[0].color, 'rgb(179, 179, 179)', '--checklist-done-color = --text-muted')

    // The open one must be untouched, or the rule is firing on "is a task".
    assert.doesNotMatch(open[0].cls, /nc-li-done/)
    assert.equal(open[0].decoration, 'none')
    assert.notEqual(open[0].color, 'rgb(179, 179, 179)')
  })

/* =========================================================================
 * KNOWN-ISSUES PR-1 — A REFUSED WRITE MUST NOT LEAVE THE PANEL DISAGREEING
 * WITH THE FILE.
 *
 * `renameProperty` has always returned `false` on a duplicate key, correctly,
 * and nothing read the answer.  Because no document change followed, `eq` held,
 * the widget was never rebuilt, and the `<input>` kept showing a name the file
 * did not have — with nothing on screen saying so.
 *
 * THESE ARE IN THE ENGINE AND CANNOT BE ANYWHERE ELSE.  The claim is about what
 * a real `blur` does to a real `<input>` and about a COMPUTED background on a
 * class that lives for 750 ms; `tests/frontend` drives CM6 through `dispatch`
 * and never through the DOM, so every existing property test would stay green
 * against the defect. That is §0.20.6.1 E36's shape and it is why the cost is
 * paid here.
 * ======================================================================= */

test('PR-1: a refused rename writes nothing and flashes the row it collided with',
  { skip: SKIP }, async () => {
    const { edit } = await probeOnce()
    const pr1 = edit.pr1
    assert.ok(pr1, 'the probe must have found the `status` row to rename')
    assert.ok(pr1.focused, 'the row must be the active element, as it is while being typed into')
    // Nothing was written.  `NAME` vs the fixture's `name:` — Obsidian's guard
    // folds case, so this is refused there too.
    assert.equal(pr1.docAfterEnter, pr1.docBefore, 'a refused rename must not touch the file')
    // Obsidian does NOT put the text back on Enter: the row is still being
    // edited and the flash has already said why.
    assert.equal(pr1.valueAfterEnter, 'NAME', 'Enter must leave the typed text to be corrected')
    // `um()` — the collision is pointed AT, on the row that owns the name.
    assert.deepEqual(pr1.flashed.map((f) => f.key), ['name'],
      'exactly the colliding row must carry `is-flashing`')
    assert.equal(pr1.flashed[0].bg, 'rgba(255, 208, 0, 0.4)',
      '`--highlight-bg` is Obsidian`s own --text-highlight-bg')
    assert.equal(pr1.flashed[0].blend, 'lighten',
      '`.theme-dark`s own --highlight-mix-blend-mode (app.css:2960)')
  })

test('PR-1: blur is where the control goes back to what the file says',
  { skip: SKIP }, async () => {
    const { edit } = await probeOnce()
    const pr1 = edit.pr1
    assert.ok(pr1)
    assert.equal(pr1.hadRealFocus, false,
      'the probe runs offscreen, so the blur is DISPATCHED — see app-main.mjs P8')
    assert.equal(pr1.valueAfterBlur, 'status',
      'on blur a refused rename must revert — this IS the defect')
    assert.equal(pr1.docAfterBlur, pr1.docBefore, 'and still without writing anything')
    assert.equal(pr1.rowsAfterBlur, edit.rowsAfterAdd,
      'and without dropping or duplicating a row')
  })

/* The regression that would be easy to ship while fixing the one above: latch
 * the one-shot guard on a refusal and the row can never be edited again. */
test('PR-1: a refusal does not lock the row — the next rename still lands',
  { skip: SKIP }, async () => {
    const { edit } = await probeOnce()
    const pr1 = edit.pr1
    assert.ok(pr1)
    const was = pr1.docBefore.split('\n')
    const now = pr1.docAfterRetry.split('\n')
    assert.equal(now.length, was.length)
    const i = was.indexOf('status: open')
    assert.ok(i > 0, 'the fixture must carry the row the earlier steps wrote')
    assert.equal(now[i], 'state: open', 'the retry must rename the key and keep the value')
    assert.deepEqual(now.filter((l, n) => n !== i), was.filter((l, n) => n !== i))
  })

/* Found while fixing PR-1, in the same constructor (app.css:12432): Obsidian
 * dims the type glyph of a row that has no name yet.  `--icon-color` is already
 * `--text-muted` on this element, so the 0.4 is the whole of the effect — which
 * is why the assertion is on the COMPUTED opacity and not on the attribute. */
test('§0.24.6: a nameless property row draws its glyph dimmed, and a named one does not',
  { skip: SKIP }, async () => {
    const { edit } = await probeOnce()
    assert.ok(edit.iconOnNamelessRow, 'the Add-property row must have an icon host')
    assert.equal(edit.iconOnNamelessRow.aria, 'true')
    assert.equal(edit.iconOnNamelessRow.opacity, '0.4')
    assert.ok(edit.iconOnNamedRow, 'the named row must have one too')
    assert.equal(edit.iconOnNamedRow.aria, 'false')
    assert.equal(edit.iconOnNamedRow.opacity, '1')
  })

/* The user measured this one off a brightness profile before I did: Obsidian's
 * strokes peak at 151 against Cairn's 74 on the same ground, which is #b3b3b3
 * against #666666. `.metadata-property-icon` takes `--icon-color`, and
 * `--icon-color` is `--text-muted` (app.css:2346) — not `--text-faint`. */
/* =========================================================================
 * §0.36 E83 — THE LINKS, IN THE ENGINE.  `livepreview.test.mjs` already proves
 * the decorator emits the marks; what only a real engine can answer is whether
 * the sheet dresses them the way Obsidian's dresses its own, and whether the
 * brackets are gone from what a READER sees while still in the document.
 * ======================================================================= */

test('§0.36 E83: a bare url and a wikilink both render as links', { skip: SKIP }, async () => {
  const { before } = await probeOnce()
  const links = before.links ?? []
  const urls = links.filter((l) => l.cls.includes('nc-url'))
  const wikis = links.filter((l) => l.cls.includes('nc-ilink'))

  // ONE url on the fixture's line, and neither negative beside it: the
  // backticked `api.example.com` is inside a code span, and a dotted host with
  // no scheme and no path is not a url in Obsidian either.
  assert.deepEqual(urls.map((u) => u.text), ['https://example.com/path_with_underscores'])
  // …and its `_`s did not italicise it: both are still in the text of ONE span,
  // which is what consuming the run in the scanner buys.
  assert.equal(urls[0].text.split('_').length - 1, 2, 'an underscore was eaten by emphasis')

  // `[[a note]]` and `[[some/where|an alias]]` — the second shows the ALIAS.
  assert.deepEqual(wikis.map((w) => w.text), ['a note', 'an alias'])

  // The accent, underlined, in both — `--link-color` and
  // `--link-external-color` are separate tokens holding one value.
  for (const l of links) {
    assert.equal(l.color, 'rgb(166, 138, 249)', l.text)
    assert.equal(l.decoration, 'underline', l.text)
  }
  // Obsidian puts the link cursor on `.cm-underline`, which a bare url never
  // gets; its own click handler refuses a plain click on one for the same
  // reason.  So: pointer on the wikilink, and NOT on the url.
  assert.equal(urls[0].cursor, 'auto')
  assert.equal(wikis[0].cursor, 'pointer')
  // `word-break: break-all` is the visible half of the report — Obsidian breaks
  // a long url mid-token at a wrap rather than pushing the whole thing down.
  assert.equal(urls[0].wordBreak, 'break-all')

  // AND THE BRACKETS ARE GONE FROM THE RENDERED LINE, both pairs, plus the
  // target and the pipe of the aliased one.
  const line = wikis[0].lineText
  assert.equal(line.includes('[['), false, line)
  assert.equal(line.includes(']]'), false, line)
  assert.equal(line.includes('some/where'), false, 'the alias target is still on screen')
  assert.equal(line.includes('|'), false, 'the alias pipe is still on screen')
})

/* =========================================================================
 * §0.40 E87 — THE TABLE, IN THE ENGINE.  `tests/frontend/tables.test.mjs`
 * pins the MODEL with no DOM; this is the half it cannot see — that CM6
 * ACCEPTED a block replacement spanning three lines and built a `<table>` out
 * of it, and that the sheet dresses it the way Obsidian's dresses its own.
 * ======================================================================= */

test('§0.40 E87: a markdown table reaches the DOM as a <table>', { skip: SKIP }, async () => {
  const { before } = await probeOnce()
  assert.equal((before.tables ?? []).length, 1, 'no table widget in the document')
  const t = before.tables[0]
  assert.deepEqual(t.headers, ['App', 'Path'])
  assert.deepEqual(t.cells, ['Patient app', 'apps/client'])
  // The cells went through §3's OWN inline tokeniser, which is the whole reason
  // tables did not need "a second parser": the backticks are gone and what is
  // left is an `.nc-code` span, by the same code that makes one in a paragraph.
  assert.equal(t.code, 1, 'the cell rendered its backticks as text')
  // …and the source is no longer on screen anywhere.
  assert.equal(t.rawPipes, false, 'the delimiter row is still being drawn')
})

/* Every number here was read out of Obsidian's own stylesheet by rendering a
 * `<table>` inside `.markdown-rendered` in this same engine and taking the
 * COMPUTED style — not by resolving `calc(var(--font-weight) +
 * var(--bold-modifier))` and `--table-border-color` by eye, which is how
 * §0.24.9 E58 happened. */
test('§0.40 E87: and it is dressed in Obsidian`s own measured table style', { skip: SKIP }, async () => {
  const t = (await probeOnce()).before.tables[0]
  assert.equal(t.collapse, 'collapse')
  assert.equal(t.lineHeight, '20.8px', '--table-line-height 1.3 on a 16px cell')
  assert.equal(t.marginTop, '16px', '--p-spacing, so a table sits in a paragraph`s rhythm')
  assert.equal(t.marginBottom, '16px')
  assert.equal(t.thPad, '4px 8px', '--size-2-2 --size-4-2')
  assert.equal(t.thBorderColor, 'rgb(51, 51, 51)', '--background-modifier-border')
  // …and the WIDTH is asserted through Chromium's snapping rather than against
  // it. `--table-border-width` is 1px; a border is laid out in whole DEVICE
  // pixels, so at dpr 1.25 the used value is floor(1.25)/1.25 = 0.8 — which is
  // §0.26.2 E66's rule, the one that made the tab strip 39.2 instead of 39, and
  // this run is at 1.25. Asserting a flat 1px would pass only at dpr 1 and 2.
  const wantBorder = Math.floor(1 * t.dpr) / t.dpr
  assert.ok(Math.abs(t.thBorderW - wantBorder) < 0.01,
    `border ${t.thBorderW} at dpr ${t.dpr}, want ${wantBorder}`)
  assert.equal(t.thWeight, '600', '--font-weight 400 + --bold-modifier 200')
  assert.equal(t.thWhiteSpace, 'break-spaces', '--table-white-space')
  assert.equal(t.thVerticalAlign, 'top', '--table-cell-vertical-alignment')
  // `6ch` is a FONT-relative length — six of the th's OWN `ch`, as the engine
  // resolves it — so its used value moves with the font and must not be
  // pinned: this row held `60.48 ± 0.1`, which is 6 × 10.08, the Debian box's
  // ch, and the first macOS run failed it at 63.9685px — 6 × 10.6614 of
  // `.SF NS` semibold, the same number the live Obsidian computes on that Mac.
  // What is asserted is that the th's min-width IS six of its own ch.
  //
  // DERIVED (2026-09-13) from `thCh`: the probe's reference box in the th's
  // computed font, reporting the RESOLVED `min-width: 1ch`, and not the th
  // itself. NOT a `0` glyph laid out as text either: in this engine the
  // resolved ch is not the `0` glyph's advance, and the gap is there BEFORE any
  // snapping. Measured on the Mac in the th's semibold `.SF NS` (live Obsidian
  // 1.13.7, diagnosis `diag-font-advance-sites/obsidian.json`): the canvas
  // advance of `0` is 10.3516, unsnapped, since no box exists yet. A `0`
  // span's box is 10.3594, and the resolved ch is 10.6614 (63.9685 / 6). The
  // box's 1/64 snap accounts for 0.008 of that; the other 0.30 already
  // separates the unsnapped advance from ch, so a glyph reference would be
  // wrong by construction, not by rounding. (Why this engine's ch differs from
  // the shaped `0` was not investigated; the test does not depend on it.)
  //
  // A computed length serialises to six significant figures, so 6 × ch
  // carries at most 0.0003 of rounding against a `thMinWidth` good to
  // 0.00005: 0.001 bounds that and nothing else. It is
  // TIGHTER than the ±0.1 it replaces, which admitted a `min-width: 64px`
  // literal on the Mac (0.03 away); this does not.
  //
  // Debian arithmetic (not run there): ch "10.08px" × 6 = 60.48 against the
  // "60.48px" measured, a difference of 0.
  assert.ok(/px$/.test(t.thCh) && Number.parseFloat(t.thCh) > 0,
    `the probe reported no reference ch for the th's face: ${t.thCh}`)
  const wantMinW = 6 * Number.parseFloat(t.thCh)
  assert.ok(Math.abs(Number.parseFloat(t.thMinWidth) - wantMinW) < 0.001,
    `--table-column-min-width: 6ch resolved to ${t.thMinWidth}, not 6 × ${t.thCh} = ` +
    `${wantMinW.toFixed(4)}px`)
  // `|---|:-:|` — the second column is centred and the first takes the
  // browser's own start alignment, which is what `default` means.
  assert.deepEqual(t.align, ['start', 'center'])
})

test('§5.4.5: the property glyphs are --text-muted, not --text-faint', { skip: SKIP }, async () => {
  const { before } = await probeOnce()
  assert.equal(before.iconColour, 'rgb(179, 179, 179)')
})

/* The user's DevTools gave Obsidian's own number for this box — 22 x 28 — which
 * is a better reference than any screenshot measurement, so it is pinned
 * exactly.  Cairn's read 18.77 x 28 before `flex-shrink: 0`, with the ::before
 * at 3.41 and the glyph at 15.36: both scaled by 0.8535, i.e. flex-shrunk.
 * `min-width: auto` does not protect the span, because an outermost `<svg>` is
 * a scroll container by UA rule and contributes ZERO to a row flex container's
 * content-based minimum. */
test('§5.4.5: the icon box is Obsidian\'s measured 22 x 28', { skip: SKIP }, async () => {
  const { before } = await probeOnce()
  const m = before.metrics
  assert.ok(m, 'no property icon in the DOM')
  assert.deepEqual(m.span, [22, 28], 'the span must not be flex-shrunk')
  assert.equal(m.before, '4px', 'app.css:11330 — the ::before is a 4px spacer')
  assert.deepEqual(m.svg, [18, 18], '--icon-m, at its full size')
  // And the shrink lands where it is designed to: the input beside it carries
  // `overflow: hidden` and `text-overflow: ellipsis` for exactly this.
  assert.deepEqual(m.keyBox, [144, m.keyBox[1]], '9em label column')
  assert.equal(m.input[0], 122, '144 - 22, so the column still adds up')
})

/* THE HORIZONTAL ORIGIN, which the user reported as "1 pixel to the left".
 *
 * It was the SHRINK, not an offset: a glyph 3.23px narrower has its centre of
 * mass 1.6px left, and the eye reads a centre. The box's left edge was right
 * all along — which is why a left-edge measurement said 0.25px and the
 * complaint said 1px, and both were honest.
 *
 * Pinned as a RELATION, not a number: `app.css:11175` translates the container
 * -4px and `:11330`'s `::before` puts it back, so the glyph lands exactly on
 * the text column. Anything that changes either has to change both. */
test('§5.4.5: the glyph starts exactly at the text column origin', { skip: SKIP }, async () => {
  const m = (await probeOnce()).before.metrics
  assert.equal(m.xContent, m.xLine, 'the fixture must have a body line to compare against')
  assert.equal(m.xSvg, m.xContent,
    'app.css:11175 translateX(-4px) + :11330 ::before 4px = the glyph sits on the column')
  assert.equal(m.xSpan, m.xContent - 4, 'and the container itself hangs 4px into the margin')
  assert.equal(m.xTitle, m.xContent, 'the inline title shares that origin (§5.4.2)')
})

/* THE FONT-SIZE CHAIN, pinned as the whole chain rather than as one number.
 *
 * The defect this catches is a RELATIVE UNIT DECLARED TWICE DOWN ONE CHAIN.
 * `--metadata-input-font-size` is `0.875em`, and `app.css` declares it on the
 * value CHILDREN only — the `.metadata-property-value` cell carries no
 * font-size at all, so it stays at the inherited 16 and each child lands on 14.
 * Cairn set it on the cell as well, so the `em` compounded to 12.25px, and the
 * user reported the orange JSON as smaller than Obsidian's. Measuring their
 * screenshot confirms it: the value's ink was 16 device px at dpr 1.25 = 12.8
 * CSS px, against 11.2 for the 14px label beside it in the same shot.
 *
 * Asserting only `unknown === '14px'` would pass on a chain that reached 14 by
 * some other accident, so every step is here. */
test('§5.4.5: the value font-size is declared ONCE, not compounded', { skip: SKIP }, async () => {
  const { fs } = (await probeOnce()).before.metrics
  assert.deepEqual(fs, {
    container: '16px',   // inherits .cm-content
    key: '16px',         // app.css:11348 sets no font-size
    keyInput: '14px',    // :11367 --metadata-label-font-size, 0.875em of 16
    value: '16px',       // :11409 sets NO font-size — this is the one that bit
    longtext: '14px',    // :11572 --metadata-input-font-size, 0.875em of 16
    unknown: '14px',     // :11481, the same
  })
})
