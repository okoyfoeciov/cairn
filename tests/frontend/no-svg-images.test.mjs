// §0.50 E98 — NO STYLESHEET IN THIS APP MAY LOAD AN SVG AS A CSS IMAGE.
//
// An SVG reached through `url(data:image/svg+xml…)` — as a background, a mask,
// a border image or a list marker — is rendered by Chromium in an isolated
// page of its own, and on Linux that page's `LayoutView::LayoutRoot` writes its
// default screen-info scale (1.0) into Blink's process-wide font-strike scale
// (crbug.com/845468's plumbing).  Any text strike populated between that paint
// and the main document's next layout — a `ch`-sized cell at style time, for
// one — is created with subpixel positioning OFF and one device pixel less
// ascent, and a line that mixes it with a strike created the other way is a
// device pixel taller.  That was LP-10: a body line at 24.8px instead of 24,
// in 12 launches of 21, from the tree chevron's mask and the task tick's.
//
// Both are real `<svg>` elements now (Obsidian's own construction for the
// chevron).  This test pins the rule so it cannot be re-introduced by a
// transcription that copies a data: URL out of app.css without reading this.
//
// ── WHICH SHEETS, AND WHY THE LIST IS NOT `readdirSync` (2026-09-13) ─────────
//
// This file used to register one row per `.css` it found in `src/styles` ON
// DISK, plus the built page only `if (existsSync(...))`.  That made the SUITE'S
// TEST COUNT a function of the working tree rather than of the commit, and it
// is why CLAUDE.md §2's Debian block reads `510 tests` where a clean checkout of
// the same commit registers 509 on macOS.  Debian's extra row is
// `src/styles/_index.css`: a stale output of the DELETED pre-Electron
// `build.mjs`, ignored by `.gitignore:31`, so `git status` never shows it —
// only `git status --ignored` does.  It holds six `@import` lines and passes,
// which is why nothing ever looked wrong.  Dropping that one file into a clean
// export of 2745f36 on the Mac reproduced Debian's `510 / 507 pass / 0 fail /
// 3 todo` exactly.  The extra row entered at d27120b, with this file.
//
// So the list is now WHAT THE APP SHIPS, read out of the one place that decides
// it: `electron-shell/build-app.mjs`'s `CSS_ORDER` and the `@import`s its
// stylesheet pass appends (today: `electron-shell/app-chrome.css`) — the ROOTS —
// and then, transitively, every sheet a root pulls in with `@import`, because
// esbuild's `bundle: true` inlines those too.  A sheet reached by neither route
// is never inlined into the page, so it cannot carry LP-10's hazard into the
// app, and a sheet that is added by either route gets a row with no edit here.
//
// THE `@import` WALK IS NOT OPTIONAL, AND A REVIEW MEASURED WHY (2026-09-13,
// macOS).  The first cut of this list stopped at the roots and claimed a
// shipped sheet is "in CSS_ORDER by definition".  It is not: a forbidden mask
// in a new `src/styles/_nested.css`, pulled in by `@import "./_nested.css";`
// at the top of base.css and rebuilt, SHIPPED (2 `data:image/svg+xml` in the
// built page) and was caught ONLY by the built-page row — and with
// `index.html` absent that row skips, so the run read 9 tests / 8 pass /
// 0 fail / 1 skipped over a shipped SVG image.  HEAD's `readdirSync` caught it
// as a row of its own.  No sheet uses `@import` at this commit, so the walk
// registers nothing extra today; it exists so the next one cannot hide.
// The BUILT-PAGE row stays as the independent check on the inlined result.
//
// The build file is PARSED, NOT IMPORTED: it runs esbuild at top level and
// writes `electron-shell/app/`, and a unit test must not rebuild the app as a
// side effect of being loaded (other runs may be reading that directory).  A
// parse can rot silently — a refactor of `build-app.mjs` would match nothing
// and register zero rows, which is green — so every way it can come back empty
// or wrong THROWS at load, and node --test reports the file as failed.
//
// There is deliberately NO "every .css on disk is in the list" assertion: it
// would turn Debian red on the ignored `_index.css` for a file the app never
// loads.  Protection against a stray sheet is not this test's job — a sheet no
// root reaches, directly or through `@import`, is inert.  The walk reads what
// the BUILD reads, which is the same test in the other direction: `_index.css`
// is six `@import`s, but nothing imports `_index.css`, so it is never visited.
//
// The built-page row is REGISTERED UNCONDITIONALLY and SKIPS with a reason when
// `electron-shell/app/index.html` is absent (it is gitignored build output), so
// a missing build reads as `skipped 1` instead of a row that silently vanishes
// and takes one off the total.  Either way this file registers
// `CSS_ORDER.length + extras + imported + 1 built + 1 static` rows —
// 6 + 1 + 0 + 1 + 1 = 9 on both machines at this commit, whatever else is
// lying in `src/styles`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

const BUILD = join('electron-shell', 'build-app.mjs')

/** The sheets `build-app.mjs` bundles, in its own order, as repo-relative
 *  paths.  Throws — never returns short — when the build file no longer has
 *  the shape this reads, so a refactor there fails here instead of emptying
 *  the loop below. */
function shippedSheets() {
  const src = readFileSync(join(ROOT, BUILD), 'utf8')
  const fail = (why) => {
    throw new Error(`no-svg-images: cannot read the shipped sheet list from ${BUILD}: ${why}. ` +
      'Update shippedSheets() to match the build; do NOT fall back to listing src/styles on disk ' +
      '(that made the test count depend on ignored files).')
  }
  const order = /const CSS_ORDER = \[([^\]]*)\]/.exec(src)
  if (!order) fail('no `const CSS_ORDER = [...]` literal')
  const names = [...order[1].matchAll(/['"]([^'"]+\.css)['"]/g)].map((m) => m[1])
  if (names.length === 0) fail('CSS_ORDER lists no .css files')
  // CSS_ORDER is only the shipped list if the stylesheet pass consumes it.
  if (!/CSS_ORDER\.map\(\s*\(?\s*f\s*\)?\s*=>\s*`@import "\.\/\$\{f\}";`\s*\)/.test(src)) {
    fail('the stylesheet pass no longer builds its @imports from CSS_ORDER')
  }
  // The extra sheets that pass appends, e.g. K5's app-chrome.css, resolved from
  // its `resolveDir` of src/styles -- hence the two `../`.
  const extras = [...src.matchAll(/@import "\.\.\/\.\.\/([^"]+\.css)"/g)].map((m) => m[1])
  if (!extras.includes('electron-shell/app-chrome.css')) {
    fail('the stylesheet pass no longer imports electron-shell/app-chrome.css')
  }
  const roots = [...names.map((f) => join('src', 'styles', f)), ...extras.map((p) => join(...p.split('/')))]
  for (const rel of roots) if (!existsSync(join(ROOT, rel))) fail(`${rel} is listed but does not exist`)

  // Transitively, every sheet a root `@import`s — esbuild bundles those into the
  // page as well (see the header for the measurement).  Depth-first, importer
  // before importee, each sheet once, so a cycle or a diamond cannot loop or
  // register a row twice.
  const seen = new Set()
  const walk = (rel) => {
    if (seen.has(rel)) return
    seen.add(rel)
    for (const spec of cssImports(readFileSync(join(ROOT, rel), 'utf8'))) {
      // A URL with a scheme (`https:`, `data:`) is not a file this test can
      // read, so it cannot vouch for it: say so instead of skipping it.
      if (/^[a-z][a-z0-9+.-]*:/i.test(spec)) fail(`${rel} imports ${spec}, which is not a local sheet`)
      // CSS resolves an import against the IMPORTING sheet, not against ROOT.
      const target = join(dirname(rel), ...spec.split('/'))
      if (!existsSync(join(ROOT, target))) fail(`${rel} imports ${spec}, which does not resolve to a file (${target})`)
      walk(target)
    }
  }
  for (const rel of roots) walk(rel)
  return [...seen]
}

/** The `@import` targets of one sheet, in source order.  Comments are removed
 *  first — a commented-out import is not bundled and must not register a row
 *  or throw — and STRINGS are kept intact while doing it, so a `/*` inside a
 *  quoted value (a data: URL, a `content:`) cannot open a false comment.
 *  Covers `@import "x"`, `@import 'x'`, `@import url(x)` and `@import url("x")`;
 *  a trailing layer or media condition does not change which file is read. */
function cssImports(css) {
  const code = css.replace(/\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/g,
    (tok) => (tok.startsWith('/*') ? ' ' : tok))
  return [...code.matchAll(/@import\s+(?:url\(\s*)?(["']?)([^"'()\s;]+)\1/gi)].map((m) => m[2])
}

// Global, and it captures the opening quote: svgImages() needs every
// occurrence and where each one ends.
const SVG_IMAGE = /url\(\s*(["']?)\s*data:image\/svg\+xml/gi

// THE ONE THAT STAYS, AND WHY.  The task tick is Obsidian's own rule
// (`input[type=checkbox]:checked:after`, app.css:14046 in 1.13.7): a
// `-webkit-mask-image` whose source is a 12x10 SVG image, drawn 65% wide at
// 52%/52%.  Chromium SNAPS a CSS image's destination rectangle to device
// pixels before drawing it, so the tick Obsidian renders is a snapped raster,
// and two vector reconstructions (an exact clip-path, and one that modelled
// the snap) still differed from it by up to 68 and 95 levels on ~140 channels
// of a 25x25 crop at dpr 1.25.  Pixel identity wins: the tick keeps Obsidian's
// construction and is the app's ONLY remaining SVG image.  Its poison is
// real (measured: a bold strike populated right after a tick's first paint
// came out unhacked, 3 of 3) and NARROW -- it needs a checked task's first
// paint to be followed by a style-time strike population before any layout,
// and with the chevron gone nothing paints an SVG image before the note.
// KNOWN-ISSUES.md LP-11 carries the exposure and the two candidate fixes.
const ALLOWED = /viewBox=\\22 0 0 12 8\\22|viewBox="0 0 12 8"/

const NAME = (rel) => `${rel} loads no SVG as a CSS image (§0.50 E98, LP-10)`

// ONE VERDICT PER url(), NEVER PER LINE — AND THE BUILT-PAGE ROW COULD NOT FAIL
// UNTIL THIS CHANGED (measured 2026-09-13, macOS).  This loop used to test
// SVG_IMAGE and ALLOWED against a whole LINE.  A source sheet has one
// declaration per line, so there that was the same thing.  The built page is
// not: `electron-shell/app/index.html` is 293 lines and esbuild's minified
// stylesheet is ALL of it on line 34 — the tick's line.  An SVG mask appended
// to base.css and rebuilt was inlined onto that line as
// `url(data:image/svg+xml;utf8,<svg\ xmlns=…)`, the line matched ALLOWED
// because the tick is on it too, and the row stayed GREEN.  base.css's own row
// caught it, so the bundle row was only ever a stale-SOURCE check wearing a
// stale-BUNDLE name.  Each occurrence is now cut out on its own — up to its
// closing quote, or `)` when unquoted, stepping over a backslash escape — and
// only that token is compared with ALLOWED.  The tick's own parens are
// `%28`/`%29` in both spellings, so an unquoted cut never lands inside it.
function svgImages(text) {
  const out = []
  for (const m of text.matchAll(SVG_IMAGE)) {
    const close = m[1] || ')'
    let i = m.index + m[0].length
    while (i < text.length && text[i] !== close) i += text[i] === '\\' ? 2 : 1
    const before = text.slice(0, m.index)
    const line = before.split('\n').length
    const col = m.index - before.lastIndexOf('\n')
    out.push({ at: `${line}:${col}`, token: text.slice(m.index, i + 1) })
  }
  return out
}

function checkSheet(rel) {
  const text = readFileSync(join(ROOT, rel), 'utf8')
  const hits = [], allowed = []
  for (const { at, token } of svgImages(text)) {
    if (ALLOWED.test(token)) allowed.push(`${rel}:${at}`)
    else hits.push(`${rel}:${at}`)
  }
  assert.deepEqual(hits, [], 'an SVG data: URL inside url() is an isolated SVG page, and its layout poisons the font-strike scale')
  assert.ok(allowed.length <= 1, 'the tick is the only allowed SVG image, once per sheet: ' + allowed.join(', '))
}

for (const rel of shippedSheets()) test(NAME(rel), () => checkSheet(rel))

// The built page inlines every sheet above; check it too, so a stale bundle is
// caught as well as a stale source.  Always registered: see the header.
const built = join('electron-shell', 'app', 'index.html')
test(NAME(built), {
  skip: existsSync(join(ROOT, built)) ? false : `${built} is not built (gitignored output) -- run node electron-shell/build-app.mjs`,
}, () => checkSheet(built))

test('the chevron and the tick are built as elements, not strings (§0.50 E98)', () => {
  const icons = readFileSync(join(ROOT, 'src', 'icons.ts'), 'utf8')
  assert.match(icons, /export function chevron\(/, 'icons.ts exports chevron()')
  assert.match(icons, /createElementNS\(SVG_NS, 'svg'\)/, 'built with createElementNS, no innerHTML')
  const tokens = readFileSync(join(ROOT, 'src', 'styles', 'tokens.css'), 'utf8')
  assert.doesNotMatch(tokens, /^\s*--chev:/m, 'the --chev mask token is gone')
})
