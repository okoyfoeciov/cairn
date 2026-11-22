/**
 * electron-shell/explain-badge.test.mjs — CONTRACT §0.56 E109: the explain
 * panel's Merriam-Webster badge is comart's, pixel for pixel.  explain.css
 * ports comart's badge rules as literals with the inherited font pinned; this
 * is what keeps the port honest.
 *
 * ONE DOM, TWO STYLESHEETS, ONE ENGINE.  The badges are built by the real
 * `src/explain-render.ts` builders (`badgeFor`, `pronOnlyBlock`, bundled by
 * esbuild) in two offscreen windows of one Electron process:
 *   reference  tests/fixtures/comart-badge/panel-badge.css, a frozen verbatim
 *              copy of comart's badge lines (pinned below by hash), in a host
 *              like comart's `.explain-content`, with comart's own two Lora
 *              files (Google Fonts' Latin subsets, pinned below by hash);
 *   cairn      Cairn's real stylesheet (build-app.mjs's `bundleCss()`, the
 *              pass that fills index.html) in the band's real ancestry, with
 *              Cyreal's full Lora files inlined under the subsets'
 *              unicode-range.
 * The Cairn bands are moved onto the reference badges' exact layout
 * positions, both pages get the same backdrop, and both windows are captured
 * whole from x = 0, so a badge box is the same device pixels in both pictures
 * and only the CSS and the fonts can make them differ.
 *
 * COMART'S FONTS ARE READ FROM COMART, the one thing that is.  The subsets
 * are a Modified Version that keeps the Reserved Font Name "Lora", so Cairn's
 * repo does not carry a copy (THIRD-PARTY-NOTICES.md).  `COMART_DIR`, default
 * `~/comart`; without them the rendering rows skip and say so.
 *
 * Per dpr in DPRS (each its own process, `--force-device-scale-factor`
 * checked by the layout grid, `--force-color-profile=srgb`,
 * `--disable-partial-raster`), all eleven states:
 *   · 0 differing pixels in every badge box, at rest and with `:hover`
 *     forced, over the band's --bg-secondary AND comart's #0C130E (the app
 *     blends over its own background by ruling; each run compares like with
 *     like);
 *   · the computed pins (13.95px, 23.715px, the Lora stack, `.badge-pos`
 *     italic rgb(197, 194, 187)) and every property in harness.js's list
 *     equal to the reference's, `:focus-visible`'s outline included (it draws
 *     outside the box, beside text that differs between the pages);
 *   · the fonts that drew each text run (CDP CSS.getPlatformFontsForNode):
 *     Lora for every `.ipa`, Lora-Italic for the labels, the same fallbacks;
 *   · that the comparison can fail: one blue level on `.badge-pos` shows in
 *     every labelled badge and nowhere else.
 *
 * Two measured traps.  PARTIAL RASTER: Chromium re-rasterises only the
 * invalidated part of a tile, and an arc crossing that clip lands ±1 level
 * off a full raster depending on what changed before the capture — 5 of 8
 * runs at dpr 1.25 had such a pixel without `--disable-partial-raster`, 0 of
 * 48 with it.  SCROLLING: a cell whose scroller overflows rasterised the
 * badge's right cap ±1 level differently between the pages at identical
 * layout rects, every time, so cells are tall enough not to scroll (asserted).
 * The pages are still always captured together, and the perturbed frame is
 * compared with the frame just before it.
 *
 * `CAIRN_BADGE_CSS=<file>` replaces bundleCss() with a `.css` file, or an
 * `.html` file's first <style> (e.g. electron-shell/app/index.html, to check a
 * build).  Point it at a copy with one colour changed to watch this go red.
 *
 * Skipped with a reason where Electron is missing, there is no display
 * (have-display.mjs) or comart's two Lora files are not found.  Needs no
 * cairn.node and no built app.
 */

import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'
import { decodePng } from '../tools/png.mjs'
import { bundleCss } from './build-app.mjs'
import { NO_DISPLAY } from './have-display.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const FIX = join(ROOT, 'tests', 'fixtures', 'comart-badge')

function electronBinary() {
  const dist = join(ROOT, 'node_modules', 'electron', 'dist')
  if (process.platform === 'darwin') {
    return join(dist, 'Electron.app', 'Contents', 'MacOS', 'Electron')
  }
  return join(dist, 'electron')
}

const BIN = electronBinary()

/* Cairn's Lora: Cyreal's unchanged Original Version (explain-css.test.mjs pins
   the same hashes and the unicode-range). */
const CAIRN_LORA = {
  'Lora[wght].ttf': '822a6621ccbe8d97d20ac88c1c41f5615c9c2c202eaa75f272cd452aac6475a7',
  'Lora-Italic[wght].ttf': '22d8d8854b53807aa664ca34f2031a9ed57a1d0dea296b8b96cdd3aad937a2b3',
}
/* comart's Lora: Google Fonts' Latin subsets, under the names its sheet loads.
   A change here is a change to what "comart's badge" means. */
const COMART_LORA = {
  'Lora-Latin.woff2': 'ddb8c66035104e233fc024669183aad3738b6daa16deee2ebb1241bd0f98ace1',
  'Lora-Latin-Italic.woff2': 'd824d807d4d832d12c87932d0b8ec1314dcfd502157a56dee6bb04cf8a3768ae',
}
// comart's Chrome extension lives in ~/comart/chrome since 2026-11-22 (the fonts
// moved with it); ~/comart itself held it until then.
const COMART = process.env.COMART_DIR ||
  [join(homedir(), 'comart', 'chrome'), join(homedir(), 'comart')].find((d) => existsSync(join(d, 'Lora-Latin.woff2'))) ||
  join(homedir(), 'comart', 'chrome')
const comartMissing = Object.keys(COMART_LORA).filter((n) => !existsSync(join(COMART, n)))

const SKIP = !existsSync(BIN) ? `electron not installed at ${BIN} -- run npm install`
  : NO_DISPLAY || (comartMissing.length > 0 &&
    `comart's ${comartMissing.join(', ')} not found in ${COMART} -- set COMART_DIR to comart's checkout`)

/* Integer and fractional device grids: the badge itself is 25.719 CSS px
   tall at 1 and 25.313 at 1.25. */
const DPRS = [1, 1.25, 1.5, 2]
/* render-main.mjs's window, CSS px. */
const VIEW = { w: 640, h: 1120 }

/* The frozen reference.  A change to it is a change to what "comart's badge"
   means, so it is deliberate: re-vendor from comart and update this hash. */
const REFERENCE_SHA256 = '12b690e7b86ae6a843bcee7b9af0c27d77849cfd0f47f1832b6eaf15a2c02659'
const sha = (buf) => createHash('sha256').update(buf).digest('hex')

/* The states whose badge carries a `.badge-pos` label (the perturbation's
   targets); the other four must not move by a single level. */
const LABELLED = new Set(['real', 'AI', 'playing', 'picked variant', 'dimmed variant', 'long row badge', 'in bold'])

/* A box declared 1.2px tall lays out on the grid of the scale Chromium is
   really rasterising at (pane-paint.test.mjs). */
const onLayoutGrid = (len, dpr) => Math.floor(len * dpr * 64) / 64 / dpr

/* ── assembling the two pages ─────────────────────────────────────────────── */

let work = null
let keep = false
after(() => {
  if (work && !keep) rmSync(work, { recursive: true, force: true })
  else if (work) console.log(`# explain-badge: kept ${work} for the failure above`)
})

async function cairnCss() {
  const src = process.env.CAIRN_BADGE_CSS
  if (!src) return { css: await bundleCss(), from: 'bundleCss() (src/styles, the pass build-app inlines)' }
  const text = readFileSync(src, 'utf8')
  if (!src.endsWith('.html')) return { css: text, from: src }
  const m = text.match(/<style>([\s\S]*?)<\/style>/)
  assert.ok(m, `CAIRN_BADGE_CSS=${src} has no <style>`)
  return { css: m[1], from: `${src} (its first <style>)` }
}

let site = null
/** One directory both windows load from: the two pages, the shared scripts,
 *  the explain-render bundle, comart's sheet and comart's two fonts (Cairn's
 *  are inside its CSS, as data: URLs). */
function assemble() {
  site ??= (async () => {
    work = mkdtempSync(join(tmpdir(), 'cairn-badge-'))
    const dir = join(work, 'site')
    mkdirSync(dir)
    for (const [name, hash] of Object.entries(COMART_LORA)) {
      const src = join(COMART, name)
      // The reference must get comart's bytes, or both sides could agree on
      // the wrong font and pass.
      assert.equal(sha(readFileSync(src)), hash, `${src} is not the ${name} the reference is pinned to`)
      copyFileSync(src, join(dir, name))
    }
    assert.equal(sha(readFileSync(join(FIX, 'panel-badge.css'))), REFERENCE_SHA256,
      'tests/fixtures/comart-badge/panel-badge.css is not the frozen reference')
    for (const f of ['panel-badge.css', 'reference.html', 'states.js', 'harness.js']) {
      copyFileSync(join(FIX, f), join(dir, f))
    }
    await esbuild.build({
      entryPoints: [join(ROOT, 'src', 'explain-render.ts')],
      outfile: join(dir, 'explain-render.js'),
      bundle: true, format: 'iife', globalName: 'CairnExplainRender',
      platform: 'browser', target: 'chrome142', logLevel: 'silent',
    })
    const { css, from } = await cairnCss()
    const page = readFileSync(join(FIX, 'cairn.html'), 'utf8')
    const PLACEHOLDER = '<!--' + 'CAIRN-CSS-->'
    assert.equal(page.split(PLACEHOLDER).length - 1, 1, 'cairn.html must hold the CSS placeholder exactly once')
    // A function, so `$&` in the CSS is not a substitution pattern.
    writeFileSync(join(dir, 'cairn.html'), page.replace(PLACEHOLDER, () => `<style>${css}</style>`))
    return { dir, from }
  })()
  return site
}

/* ── one Electron process per dpr ─────────────────────────────────────────── */

const renders = new Map()
function render(dpr) {
  if (!renders.has(dpr)) renders.set(dpr, (async () => {
    const { dir, from } = await assemble()
    const out = join(work, `dpr-${dpr}`)
    mkdirSync(out)
    const state = mkdtempSync(join(work, 'state-'))
    const report = await new Promise((resolve, reject) => {
      const child = spawn(BIN, [join(FIX, 'render-main.mjs'),
        `--force-device-scale-factor=${dpr}`, '--force-color-profile=srgb', '--disable-partial-raster'], {
        cwd: ROOT,
        env: { ...process.env, BADGE_DIR: dir, BADGE_OUT: out, CAIRN_STATE_DIR: state },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let so = ''
      let se = ''
      child.stdout.on('data', (d) => { so += d })
      child.stderr.on('data', (d) => { se += d })
      const kill = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error(`render at dpr ${dpr} timed out after 120s\nstdout:\n${so}\nstderr:\n${se}`))
      }, 120_000)
      child.on('error', (e) => { clearTimeout(kill); reject(e) })
      // 'close', not 'exit': 'exit' can come before the pipe has delivered
      // all of stdout, and the BADGE line is ~150 KB (measured: a cut line).
      child.on('close', () => {
        clearTimeout(kill)
        const line = so.split('\n').find((l) => l.startsWith('BADGE '))
        if (!line) { reject(new Error(`no BADGE line at dpr ${dpr}\nstdout:\n${so}\nstderr:\n${se}`)); return }
        let r
        try {
          r = JSON.parse(line.slice('BADGE '.length))
        } catch (e) {
          // A throw here would leave the promise pending and hang every later row.
          reject(new Error(`a cut BADGE line at dpr ${dpr} (${line.length} chars): ${e.message}`))
          return
        }
        if (r.error) { reject(new Error(`render at dpr ${dpr} failed: ${r.error}`)); return }
        resolve(r)
      })
    })
    return { ...report, dpr, from, out }
  })())
  return renders.get(dpr)
}

/* ── pixels ───────────────────────────────────────────────────────────────── */

const pngs = new Map()
const png = (file) => { if (!pngs.has(file)) pngs.set(file, decodePng(readFileSync(file))); return pngs.get(file) }

/** The device-pixel box of a CSS rect: every pixel the border box touches. */
const deviceBox = ([x, y, w, h], dpr) => ({
  x0: Math.floor(x * dpr), y0: Math.floor(y * dpr), x1: Math.ceil((x + w) * dpr), y1: Math.ceil((y + h) * dpr),
})

const rgb = (css) => (css.match(/\d+/g) ?? []).slice(0, 3).map(Number)

/** Differing pixels (any channel) inside `box`, the largest channel delta,
 *  and how many reference pixels are not the backdrop (the box is not empty). */
function compare(a, b, box, backdrop) {
  // Outside the capture every read is undefined: no diff and all "ink".
  assert.ok(box.x0 >= 0 && box.y0 >= 0 && box.x1 <= a.width && box.y1 <= a.height && box.x1 <= b.width && box.y1 <= b.height,
    `box ${JSON.stringify(box)} is not inside the ${a.width}x${a.height} capture -- add room to render-main.mjs's window`)
  let diff = 0
  let maxDelta = 0
  let ink = 0
  for (let y = box.y0; y < box.y1; y++) {
    for (let x = box.x0; x < box.x1; x++) {
      const k = (y * a.width + x) * 4
      let d = 0
      for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(a.data[k + c] - b.data[k + c]))
      if (d) { diff++; maxDelta = Math.max(maxDelta, d) }
      if (a.data[k] !== backdrop[0] || a.data[k + 1] !== backdrop[1] || a.data[k + 2] !== backdrop[2]) ink++
    }
  }
  return { diff, maxDelta, ink, px: (box.x1 - box.x0) * (box.y1 - box.y0) }
}

const fmt = (r) => r.map((v) => +v.toFixed(4)).join(', ')

/* ── the tests ────────────────────────────────────────────────────────────── */

test('the reference is the frozen comart copy; Cairn\'s fonts are Cyreal\'s, comart\'s are its subsets', (t) => {
  for (const f of ['panel-badge.css', 'reference.html', 'cairn.html', 'states.js', 'harness.js', 'render-main.mjs']) {
    assert.ok(existsSync(join(FIX, f)), `tests/fixtures/comart-badge/${f} is missing`)
  }
  const css = readFileSync(join(FIX, 'panel-badge.css'))
  assert.equal(sha(css), REFERENCE_SHA256,
    'panel-badge.css changed: it is a verbatim copy of comart panel.css, re-vendor it on purpose or not at all')
  const text = css.toString('utf8')
  // The lines the header promises, by content, so a re-vendor that drops one fails here.
  for (const s of ['font-family: "Lora";', 'src: url("Lora-Latin-Italic.woff2") format("woff2");',
    '* { box-sizing: border-box; margin: 0; padding: 0; }', 'color-scheme: dark;', '--pron: #8ec5d3;',
    '--warn: #e8b34a;', '  font: inherit;\n  font-size: 0.9em;\n  line-height: 1.7;',
    '.pron-badge .ipa { font-style: normal; font-family: "Open Sans", inherit; }',
    '.pron-badge { font-family: "Lora", Georgia, "Iowan Old Style", "Times New Roman", serif; }',
    '.pron-badge .badge-pos { color: #c5c2bb; }']) {
    assert.ok(text.includes(s), `panel-badge.css lacks ${JSON.stringify(s)}`)
  }
  for (const [name, hash] of Object.entries(CAIRN_LORA)) {
    assert.equal(sha(readFileSync(join(ROOT, 'src', 'styles', 'fonts', name))), hash, `src/styles/fonts/${name}`)
  }
  if (comartMissing.length > 0) {
    t.diagnostic(`comart's fonts not found in ${COMART}; the rendering rows skip`)
    return
  }
  for (const [name, hash] of Object.entries(COMART_LORA)) {
    assert.equal(sha(readFileSync(join(COMART, name))), hash, `${COMART}/${name}`)
  }
})

for (const dpr of DPRS) {
  test(`dpr ${dpr}: both pages are really rasterised at ${dpr}, Lora is loaded, the DOM is the same, nothing scrolls`,
    { skip: SKIP }, async (t) => {
      const r = await render(dpr)
      t.diagnostic(`dpr ${dpr}; ${r.ua}; Cairn CSS from ${r.from}`)
      for (const k of ['ref', 'cairn']) {
        assert.equal(r.grid[k].dpr, dpr, `${k}: devicePixelRatio is ${r.grid[k].dpr}`)
        // Emulation sets devicePixelRatio too; only the real scale moves the grid.
        assert.ok(Math.abs(r.grid[k].gridH - onLayoutGrid(1.2, dpr)) < 1e-4,
          `${k}: a 1.2px box laid out as ${r.grid[k].gridH}, not ${onLayoutGrid(1.2, dpr)} -- not rasterised at ${dpr}`)
        assert.deepEqual(r.faces[k], ['normal 400 700 loaded', 'italic 400 700 loaded'],
          `${k}: the Lora faces are ${JSON.stringify(r.faces[k])}`)
        assert.deepEqual(r.overflow[k], [], `${k}: these cells scroll, which moves their raster: ${r.overflow[k]}`)
      }
      assert.deepEqual(r.dom.cairn, r.dom.ref, 'the two pages built different badge DOM')
      assert.equal(r.states.length, 11)
    })

  test(`dpr ${dpr}: computed style -- the pins, and every listed property equal to comart's`,
    { skip: SKIP }, async () => {
      const r = await render(dpr)
      const stack = 'Lora, Georgia, "Iowan Old Style", "Times New Roman", serif'
      r.states.forEach(([name], i) => {
        const [badge, ...kids] = r.computed.cairn[i]
        assert.equal(badge.fontSize, '13.95px', `${name}: font-size`)
        assert.equal(badge.lineHeight, '23.715px', `${name}: line-height`)
        assert.equal(badge.fontFamily, stack, `${name}: font-family`)
        // comart's badge inherits its weight: bold inside **…**, as there.
        assert.equal(badge.fontWeight, name === 'in bold' ? '600' : '400', `${name}: font-weight`)
        assert.equal(badge.fontStyle, 'normal', `${name}: font-style`)
        assert.equal(badge.webkitFontSmoothing, 'antialiased', `${name}: -webkit-font-smoothing`)
        assert.equal(badge.borderTopLeftRadius, '100px', `${name}: radius`)
        assert.equal(badge.transition, 'background, color / 0.15s, 0.15s / ease, ease',
          `${name}: the fifth exemption's fade`)
        const pos = kids.find((k) => k.cls === 'badge-pos')
        if (pos && name !== 'picked variant') {
          assert.equal(pos.fontStyle, 'italic', `${name}: .badge-pos style`)
          assert.equal(pos.color, 'rgb(197, 194, 187)', `${name}: .badge-pos colour`)
          assert.equal(pos.fontSize, '11.8575px', `${name}: .badge-pos size`)
        }
        assert.equal(Boolean(pos), LABELLED.has(name), `${name}: has a .badge-pos`)
        // Everything else: the same as comart's, element by element.
        assert.equal(r.computed.cairn[i].length, r.computed.ref[i].length, `${name}: element count`)
        r.computed.ref[i].forEach((want, j) => {
          assert.deepEqual(r.computed.cairn[i][j], want, `${name}: <${want.tag} class="${want.cls}"> differs from comart`)
        })
      })
      assert.deepEqual(r.focus.cairn, r.focus.ref, ':focus-visible outline differs from comart')
      for (const o of r.focus.cairn) {
        assert.equal(o[0], 'solid', ':focus-visible must still beat base.css :focus { outline: none }')
        assert.equal(o[2], 'rgb(142, 197, 211)')
      }
    })

  test(`dpr ${dpr}: the fonts that draw each run -- Lora, and the reference's own fallbacks`,
    { skip: SKIP }, async () => {
      const r = await render(dpr)
      assert.deepEqual(r.fonts.cairn, r.fonts.ref, 'a text run is drawn in different fonts than comart\'s')
      const ipa = r.fonts.cairn['.ipa']
      assert.equal(ipa.length, 8, 'eight badges carry an .ipa')
      ipa.forEach((fonts, i) => assert.ok(fonts.some((f) => f.familyName === 'Lora' && f.isCustomFont),
        `.ipa #${i} is not drawn in the shipped Lora: ${JSON.stringify(fonts)}`))
      // The IPA must reach past Lora (ə, ā, ≈ are in Cairn's files but not
      // in the range), or the equality above would not test the unicode-range.
      assert.ok(ipa.some((fonts) => fonts.some((f) => !f.isCustomFont)),
        `no .ipa run falls back past Lora: ${JSON.stringify(ipa)}`)
      const italic = r.fonts.cairn['.badge-pos'].filter((fonts) => fonts.some((f) => f.postScriptName === 'Lora-Italic'))
      // Seven labels; the picked variant's is upright bold, the other six italic.
      assert.equal(italic.length, 6, `the unpicked labels are not in Lora-Italic: ${JSON.stringify(r.fonts.cairn['.badge-pos'])}`)
    })

  test(`dpr ${dpr}: 0 differing pixels in every badge box, eleven states, at rest and :hover, on both backdrops`,
    { skip: SKIP }, async (t) => {
      const r = await render(dpr)
      const bad = []
      for (const run of r.runs) {
        assert.equal(run.backdrops.cairn, run.backdrops.ref, `${run.name}: the backdrops differ`)
        const a = png(run.shots.ref)
        const b = png(run.shots.cairn)
        for (const img of [a, b]) {
          assert.deepEqual([img.width, img.height], [Math.round(VIEW.w * dpr), Math.round(VIEW.h * dpr)],
            `${run.name}: the capture is not the whole window at dpr ${dpr}`)
        }
        r.states.forEach(([name], i) => {
          const want = run.rects.ref[i]
          const got = run.rects.cairn[i]
          // Position first: a pixel diff of two boxes in different places proves nothing.
          if (want.some((v, j) => Math.abs(v - got[j]) > 1e-3)) {
            bad.push(`${run.name} / ${name}: box ${fmt(got)} is not comart's ${fmt(want)}`)
            return
          }
          const c = compare(a, b, deviceBox(want, dpr), rgb(run.backdrops.ref))
          assert.ok(c.ink > 0, `${run.name} / ${name}: nothing but backdrop in the box -- the comparison is empty`)
          if (c.diff) bad.push(`${run.name} / ${name}: ${c.diff} of ${c.px} px differ (max channel delta ${c.maxDelta})`)
        })
        t.diagnostic(`dpr ${dpr}, ${run.name} (${run.backdrops.ref}): ${r.states.length} boxes compared`)
      }
      if (bad.length) keep = true
      assert.deepEqual(bad, [], `at dpr ${dpr} the badge is not comart's, pixel for pixel ` +
        `(Cairn CSS from ${r.from}; captures kept in ${r.out}):\n  ` + bad.join('\n  '))
    })

  test(`dpr ${dpr}: the comparison can fail -- one blue level on .badge-pos shows in every labelled badge, and only there`,
    { skip: SKIP }, async (t) => {
      const r = await render(dpr)
      // Cairn against its own previous frame, so a real mismatch with comart
      // cannot make this row fail too: it asks only whether one level shows.
      const { against, shot, rects, backdrop } = r.perturbed
      const a = png(against)
      const b = png(shot)
      const seen = []
      r.states.forEach(([name], i) => {
        const c = compare(a, b, deviceBox(rects[i], dpr), rgb(backdrop))
        seen.push(`${name} ${c.diff}`)
        if (LABELLED.has(name)) {
          assert.ok(c.diff > 0, `${name}: one blue level on its label changed no pixel -- this test cannot see a colour change`)
        } else {
          assert.equal(c.diff, 0, `${name}: has no label, yet ${c.diff} px moved -- the box or the capture is not tight`)
        }
      })
      t.diagnostic(`dpr ${dpr}: differing px per box with the label one level off: ${seen.join(', ')}`)
    })
}
