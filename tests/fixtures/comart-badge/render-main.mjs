/**
 * tests/fixtures/comart-badge/render-main.mjs -- the Electron main process of
 * electron-shell/explain-badge.test.mjs.  It renders, measures and captures;
 * the test decides.
 *
 *   electron render-main.mjs --force-device-scale-factor=<dpr> --force-color-profile=srgb \
 *     --disable-partial-raster
 *   env BADGE_DIR=<reference.html, cairn.html and their assets>  BADGE_OUT=<an empty directory>
 *
 * Two offscreen windows in ONE process, so both pages share the engine, the
 * scale, the colour profile and the font configuration: `reference.html`
 * (comart's frozen sheet) and `cairn.html` (Cairn's real one), the same badge
 * DOM in each.  The Cairn page's bands are moved onto the reference's badge
 * positions, both pages get the same backdrop, and each is captured WHOLE,
 * from x = 0, so a badge box is the same device pixels in both pictures.
 *
 * Captures, in order: at rest and with every badge's `:hover` forced (CDP,
 * not a pointer: one frame holds all ten), on Cairn's band background and
 * on comart's; between the two, one Cairn frame with `.badge-pos` one blue
 * level off -- the test's proof that its comparison can see a change that
 * small.
 * Prints one line, `BADGE {json}`, and exits.  Writes nothing outside
 * BADGE_OUT: the captures, and userData, redirected there before `ready`.
 */

import { app, BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DIR = process.env.BADGE_DIR
const OUT = process.env.BADGE_OUT
const W = 640
const H = 1120 // ten 112px cells
app.setPath('userData', join(OUT, 'userdata'))
app.disableHardwareAcceleration()

// Resolves once the ~150 KB line has left the process: app.exit() with the
// write still queued can kill the process mid-line.
const say = (o) => new Promise((resolve) => { process.stdout.write('BADGE ' + JSON.stringify(o) + '\n', () => resolve()) })
// The test that reads us is gone (EPIPE): leave quietly.  Unhandled, the error
// becomes Electron's modal main-process error dialog on the user's screen.
process.stdout.on('error', () => app.exit(3))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* Text runs whose platform fonts are compared (Lora vs per-glyph fallback). */
const RUNS = ['.ipa', '.badge-pos', '.approx', '.ai-tag', '.err-label', '.dot-loader']
/* One blue level on every `.badge-pos`: #c5c2bb -> #c5c2bc, and the picked
   variant's #8ec5d3 -> #8ec5d4. */
const PERTURB = '.ep-explain .pron-badge .badge-pos { color: rgb(197, 194, 188) !important; } ' +
  '.ep-explain .pron-badge.is-picked .badge-pos { color: rgb(142, 197, 212) !important; }'
const OUTLINE = ['outlineStyle', 'outlineWidth', 'outlineColor', 'outlineOffset']

async function run() {
  const wins = []
  const open = async (file) => {
    const w = new BrowserWindow({
      width: W, height: H, useContentSize: true, show: false,
      webPreferences: { offscreen: true, backgroundThrottling: false },
    })
    wins.push(w)
    await w.loadFile(join(DIR, file))
    w.webContents.debugger.attach('1.3')
    return w
  }
  try {
    const pages = { ref: await open('reference.html'), cairn: await open('cairn.html') }
    const js = (w, src) => w.webContents.executeJavaScript(src, true)
    const cdp = (w, m, p) => w.webContents.debugger.sendCommand(m, p)
    const both = async (src) => ({ ref: await js(pages.ref, src), cairn: await js(pages.cairn, src) })

    const out = { ua: await js(pages.ref, 'navigator.userAgent') }
    out.faces = await both('H.ready')
    out.grid = await both('H.grid()')
    out.states = await js(pages.ref, 'H.states')
    out.dom = await both('H.dom()')
    out.computed = await both('H.computed()')

    const nodes = {}
    out.fonts = {}
    for (const [k, w] of Object.entries(pages)) {
      await cdp(w, 'DOM.enable')
      await cdp(w, 'CSS.enable')
      const { root } = await cdp(w, 'DOM.getDocument', { depth: -1 })
      const all = async (sel) => (await cdp(w, 'DOM.querySelectorAll', { nodeId: root.nodeId, selector: sel })).nodeIds
      nodes[k] = await all('.pron-badge')
      const per = {}
      for (const sel of RUNS) {
        per[sel] = []
        for (const nodeId of await all('.pron-badge ' + sel)) {
          per[sel].push((await cdp(w, 'CSS.getPlatformFontsForNode', { nodeId })).fonts)
        }
      }
      out.fonts[k] = per
    }
    const force = async (classes) => {
      for (const [k, w] of Object.entries(pages)) {
        for (const nodeId of nodes[k]) await cdp(w, 'CSS.forcePseudoState', { nodeId, forcedPseudoClasses: classes })
      }
      await both('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))')
    }
    const shoot = async (tag, which = ['ref', 'cairn']) => {
      const shots = {}
      for (const k of which) {
        const { data } = await cdp(pages[k], 'Page.captureScreenshot', { format: 'png', fromSurface: true })
        shots[k] = join(OUT, `${tag}-${k}.png`)
        writeFileSync(shots[k], Buffer.from(data, 'base64'))
      }
      return shots
    }

    // :focus-visible draws outside the box, beside text that differs between
    // the pages, so it is pinned by computed value, not pixels.
    await force(['focus', 'focus-visible'])
    out.focus = await both(`[...document.querySelectorAll('.pron-badge')].map((b) => {
      const c = getComputedStyle(b); return ${JSON.stringify(OUTLINE)}.map((p) => c[p]) })`)
    await force([])

    const appBg = await js(pages.cairn, 'H.backdrop()')
    const target = await js(pages.ref, 'H.rects()')
    await js(pages.cairn, `H.align(${JSON.stringify(target)}, devicePixelRatio)`)
    out.overflow = await both('H.overflowing()')
    const BACKDROPS = [['Cairn --bg-secondary', appBg], ['comart --panel-bg #0C130E', '#0C130E']]
    const capture = async (name, color, hover) => {
      await both(`H.setBackdrop(${JSON.stringify(color)})`)
      await force(hover ? ['hover'] : [])
      // Past the badge's 0.15s background fade (the fifth exemption).
      await sleep(400)
      return {
        name, color, hover,
        rects: await both('H.rects()'),
        backdrops: await both('H.backdrop()'),
        shots: await shoot(`run${out.runs.length}`),
      }
    }
    // Both pages go through the same steps in the same order, so the two
    // frames of every comparison share their history (partial raster made
    // history visible as ±1 on an arc; the test disables it as well).
    out.runs = []
    for (const [name, color] of BACKDROPS) out.runs.push(await capture(name, color, false))

    await js(pages.cairn, `(() => { const s = document.createElement('style'); s.id = 'perturb';
      s.textContent = ${JSON.stringify(PERTURB)}; document.head.append(s) })()`)
    await sleep(400)
    // Against the Cairn frame just before it (same page, same backdrop, no
    // hover in between), so it asks only whether one level can be seen.
    const before = out.runs[out.runs.length - 1]
    out.perturbed = {
      against: before.shots.cairn, backdrop: before.backdrops.cairn,
      rects: await js(pages.cairn, 'H.rects()'), shot: (await shoot('perturbed', ['cairn'])).cairn,
    }
    await js(pages.cairn, `document.getElementById('perturb').remove()`)

    for (const [name, color] of BACKDROPS) out.runs.push(await capture(name + ', :hover', color, true))
    await force([])
    await say(out)
    return 0
  } catch (e) {
    await say({ error: String((e && e.stack) || e) })
    return 1
  } finally {
    for (const w of wins) { try { w.destroy() } catch {} }
  }
}

const guard = setTimeout(() => { say({ error: 'render-main timed out after 90s' }).then(() => app.exit(2)) }, 90_000)
app.whenReady().then(run).then((code) => { clearTimeout(guard); app.exit(code) })
