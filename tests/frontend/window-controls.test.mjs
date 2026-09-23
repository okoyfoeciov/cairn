// Owner: 01.  `node --test tests/frontend/*.test.mjs`.
//
// Spec: CONTRACT.md §0.5 E7 (the Linux title bar), §5.7 (THE DRAG REGION),
// §5.8 (what E7 amends), §6.1 (icons.ts is the only innerHTML source),
// §1.6 (the close handshake the ✕ must not bypass), docs/spike-N-linux-titlebar.md.
//
// ===========================================================================
// WHAT THIS FILE CAN AND CANNOT PROVE
// ===========================================================================
// The same three parts as chrome-ui.test.mjs, and the same limits:
//
//   PART A — behaviour.  The real compiled modules, imported and driven.
//   PART B — source conformance.  Grep-shaped assertions over shipped text.
//     Weak on their own, and here for one reason: every rule they guard is a
//     number or a call that is INVISIBLE when it is wrong.  A `fill="none"`
//     added to the close glyph renders nothing and throws nothing.  A cluster
//     moved one child earlier in index.html moves the tab to x 562 and only
//     gate G9, on a different machine, would ever say so.  A `destroy()` where
//     `close()` should be silently discards the user's unsaved note.
//   PART C — DOM behaviour, against tests/frontend/_minidom.mjs.  No layout, so
//     it proves order, identity and which handler ran, and NOT ONE PIXEL.
//
// NOT COVERED, and reported rather than faked: the rendered 44x39 boxes (39 = the
// strip's content box above its 1px rule, §0.6 E8) and
// their flush-right placement.  Gate G9 is macOS-only and this cluster is
// `display: none` there, so no automated gate measures it on any machine in
// this project.  Its geometry rests on spike N — Obsidian's own app.css, plus
// three ink centres measured off the reference to a tenth of a pixel — and on
// a manual pass.  Saying so is the point; a stub returning invented rects
// would only prove the stub agrees with the code written against it.
// ===========================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as esbuild from 'esbuild'
import { ADocument, AElement, installGlobals } from './_minidom.mjs'

const ROOT = new URL('../../', import.meta.url).pathname
const read = (p) => readFileSync(ROOT + p, 'utf8')

const iconsTs = read('src/icons.ts')
const chromeTs = read('src/chrome.ts')
const ipcTs = read('src/ipc.ts')
const chromeCss = read('src/styles/chrome.css')
const tokensCss = read('src/styles/tokens.css')
const indexHtml = read('src/index.html')
/* WAS `core/src/lib.rs` UNTIL THE TAURI SHELL WAS DELETED (§8.2 step 10).
   Every ruling these tests pin is still live; only the file that implements it
   moved. Three of them are now also EXECUTED by
   `electron-shell/window-control.test.mjs`, which drives a real click on the
   real button through the real shell -- these stay as the cheap half, because
   they fail in milliseconds and without a display. */
const appMain = read('electron-shell/app-main.mjs')
const preload = read('electron-shell/preload.cjs')

/** Block and line comments out of a TS/Rust source, so a grep-shaped assertion
 *  reads the CODE and not the prose explaining it.  chrome-ui.test.mjs does the
 *  same for CSS, for the same reason. */
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

/** `src/icons.ts` and `src/chrome.ts`, compiled by the same esbuild the app is
 *  built with.  Nothing under `src/` imports `@tauri-apps/api` any more, so
 *  the bundle needs no stub for it. */
async function load() {
  const out = await esbuild.build({
    stdin: {
      contents: `export * from './src/icons'\nexport * from './src/chrome'\n`,
      resolveDir: ROOT, loader: 'ts',
    },
    bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2021',
  })
  return import('data:text/javascript;base64,' +
    Buffer.from(out.outputFiles[0].text).toString('base64'))
}
const ICONS = await load()

/** The shape `src/index.html` ships inside `.titlebar`, and nothing else.
 *  `installDom`'s equivalent in chrome-ui.test.mjs, minus what this file does
 *  not touch.  NO LAYOUT — see the header. */
function installDom(cairnOs) {
  installGlobals()
  const doc = new ADocument()
  doc.body = doc.createElement('body')
  globalThis.Event = class Event { constructor(t) { this.type = t } }
  globalThis.HTMLElement = AElement
  globalThis.Node = AElement
  doc.addEventListener = () => {}
  doc.removeEventListener = () => {}
  // ADocument is not a ParentNode; delegate the two query methods to <html>,
  // which is where index.html's markup hangs.
  // The minidom has no CSSStyleDeclaration; setSidebarW writes one, so the
  // fixture stands one in. It stores what it is given and hands it back, which
  // is the only behaviour under test here.
  const props = new Map()
  doc.documentElement.style = {
    setProperty: (k, v) => props.set(k, v),
    getPropertyValue: (k) => props.get(k) ?? '',
  }
  doc.querySelector = (s) => doc.documentElement.querySelector(s)
  doc.querySelectorAll = (s) => doc.documentElement.querySelectorAll(s)
  globalThis.document = doc
  globalThis.window = cairnOs === undefined ? {} : { __CAIRN_OS__: cairnOs }

  doc.documentElement.setAttribute('data-os', 'macos')  // what index.html ships
  const bar = doc.createElement('div'); bar.className = 'titlebar'
  const ctl = doc.createElement('div'); ctl.className = 'window-controls'
  for (const [cls, glyph] of [
    ['win-btn win-minimize', 'win-minimize'],
    ['win-btn win-maximize', 'win-maximize'],
    ['win-btn win-close', 'win-close'],
  ]) {
    const b = doc.createElement('button')
    b.className = cls
    b.setAttribute('data-icon', glyph)
    ctl.append(b)
  }
  bar.append(ctl)
  doc.documentElement.append(doc.body)
  doc.body.append(bar)
  return { doc, ctl }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * PART A — the glyphs are Obsidian's, byte for byte
 *
 * THE WHOLE CLAIM OF THIS FEATURE IS PIXEL-IDENTITY, and it rests entirely on
 * these four strings.  They were transcribed out of Obsidian 1.13.7's own
 * app.js (spike N §3.3).  A reformat, a re-rounded coordinate or a "cleanup"
 * pass over the path data breaks the identity and renders something that still
 * looks broadly like a window control, which is exactly why a human reviewing
 * a diff would wave it through.
 * ═══════════════════════════════════════════════════════════════════════════ */

test('E7 — the four window-control glyphs are Obsidian 1.13.7 verbatim', () => {
  // Transcribed a SECOND time, independently, from the same source, so that
  // this file and icons.ts do not share a copy that could drift together.
  assert.equal(
    ICONS.windowIcon('win-minimize'),
    '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">' +
      '<rect fill="currentColor" width="10" height="1" x="1" y="6"></rect></svg>'
  )
  assert.equal(
    ICONS.windowIcon('win-maximize'),
    '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">' +
      '<rect width="9" height="9" x="1.5" y="1.5" fill="none" stroke="currentColor"></rect></svg>'
  )
  assert.equal(
    ICONS.windowIcon('win-restore'),
    '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">' +
      '<path d="M1.5 3.5H8.5V10.5H1.5V3.5Z" stroke="currentColor"/>' +
      '<path d="M4 2H10V8H9V9H11V1H3V3H4V2Z" fill="currentColor"/></svg>'
  )
  assert.equal(
    ICONS.windowIcon('win-close'),
    '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">' +
      '<path fill="currentColor" fill-rule="evenodd" d="M10.052 10.968 1.03 1.93l.849-.848 9.023 9.037-.849.848Z"/>' +
      '<path fill="currentColor" fill-rule="evenodd" d="M1.023 10.112 10.06 1.09l.848.85-9.037 9.023-.848-.85Z"/></svg>'
  )
})

test('E7 — the root `fill` is reproduced where Obsidian has it and only there', () => {
  // A FIDELITY assertion, not a rendering one, and the difference matters
  // because the tempting comment here is wrong: `fill` is an INHERITED
  // presentation attribute, and every filled shape in these four sets its own
  // `fill="currentColor"`, so a root `fill="none"` would override nothing and
  // erase nothing.  What this pins is that nobody "normalised" the four to one
  // shape — which is how a verbatim transcription stops being verbatim.
  //
  // The attributes that WOULD corrupt them are viewBox and the stroke-* set;
  // those are asserted in the next test.
  for (const outline of ['win-maximize', 'win-restore']) {
    assert.match(ICONS.windowIcon(outline), /fill="none"/, `${outline} lost its root fill`)
  }
  for (const filled of ['win-minimize', 'win-close']) {
    assert.doesNotMatch(ICONS.windowIcon(filled), /fill="none"/,
      `${filled} gained a root fill Obsidian does not write`)
  }
  // And the shapes that must paint carry their own fill, which is the reason
  // the root attribute is inert either way.
  assert.match(ICONS.windowIcon('win-minimize'), /<rect fill="currentColor"/)
  assert.match(ICONS.windowIcon('win-close'), /<path fill="currentColor"/)
})

test('E7 — none of the four carries a Lucide stroke attribute', () => {
  // `stroke-width` / `stroke-linecap` / `stroke-linejoin` are what `icon()`
  // stamps on every Lucide glyph.  On a 12-unit filled path they outline the
  // shape and round its corners: a visibly fatter, softer control.
  for (const n of ['win-minimize', 'win-maximize', 'win-restore', 'win-close']) {
    const svg = ICONS.windowIcon(n)
    assert.doesNotMatch(svg, /stroke-width|stroke-linecap|stroke-linejoin/, n)
    assert.match(svg, /viewBox="0 0 12 12"/, `${n} must be 12-unit, not Lucide's 24`)
  }
})

test('E7 — the window glyphs are NOT in the Lucide table, so the pinned count does not move', () => {
  // M41 / §5.1 X2 / Y6 govern the count of LUCIDE literals in icons.ts.  The
  // four here are a separate inventory on purpose; if somebody folds them into
  // `G` to "simplify", `icon()` starts stamping fill="none" on them (see above)
  // AND the count those rulings pin moves silently.
  assert.equal(typeof ICONS.windowIcon, 'function')
  for (const n of ['win-minimize', 'win-maximize', 'win-restore', 'win-close']) {
    assert.doesNotMatch(iconsTs, new RegExp(`'${n}':\\s*\\{\\s*size:`),
      `${n} was moved into the Lucide table G`)
  }
})

/* ═══════════════════════════════════════════════════════════════════════════
 * PART C — paintIcons really paints them
 * ═══════════════════════════════════════════════════════════════════════════ */

test('E7 — paintIcons fills every win-* host, and leaves an unknown data-icon alone', () => {
  const { doc, ctl } = installDom('linux')
  const stranger = doc.createElement('button')
  stranger.setAttribute('data-icon', 'not-a-glyph')
  stranger.innerHTML = 'untouched'
  ctl.append(stranger)

  ICONS.paintIcons(ctl)

  const painted = ctl.children.slice(0, 3).map((b) => b.innerHTML)
  for (const html of painted) assert.match(html, /viewBox="0 0 12 12"/)
  assert.notEqual(painted[0], painted[1], 'minimize and maximize painted the same glyph')
  assert.equal(stranger.innerHTML, 'untouched',
    'a host naming no known glyph must be SKIPPED, not emptied — index.html ' +
    'ships hosts this pass does not own')
})

/* ═══════════════════════════════════════════════════════════════════════════
 * PART C — `data-os`, and the ⌘/Ctrl seam that rides on it
 * ═══════════════════════════════════════════════════════════════════════════ */

test('E7 — mountChrome promotes data-os to linux ONLY on the compiled-in signal', () => {
  for (const [signal, expected] of [[undefined, 'macos'], ['linux', 'linux']]) {
    const { doc } = installDom(signal)
    ICONS.mountChrome(doc)
    assert.equal(doc.documentElement.getAttribute('data-os'), expected,
      `__CAIRN_OS__ = ${String(signal)} must give data-os = ${expected}`)
  }
})

test('E7 — the glyphs are painted in the SAME pass, so the strip never shows three holes', () => {
  const { doc, ctl } = installDom('linux')
  ICONS.mountChrome(doc)
  for (const b of ctl.children) {
    assert.match(String(b.innerHTML ?? ''), /<svg/,
      'a control shipped unpainted: applyPlatform must run BEFORE paintIcons')
  }
})

/* ═══════════════════════════════════════════════════════════════════════════
 * PART B — source conformance.  Each one guards an invisible failure.
 * ═══════════════════════════════════════════════════════════════════════════ */

test('E7/G9 — the cluster is the LAST child of .titlebar', () => {
  // LOAD-BEARING FOR GATE G9, on a machine this suite never runs on.
  // `.titlebar-left` and `.tab` are both `flex: 0 0`, so the cluster's 132px
  // comes out of `.tab-strip`'s grow share and the tab stays at x 430 / w 200,
  // which is exactly what verify-geometry.js's `tab` row asserts.  Put the
  // cluster BEFORE `.tab-strip` and the tab lands at 562 — on Linux only,
  // where no gate looks.
  const strip = indexHtml.indexOf('<div class="tab-strip"')
  const cluster = indexHtml.indexOf('<div class="window-controls"')
  const close = indexHtml.indexOf('</div>\n\n<div class="app">')
  assert.ok(strip > 0 && cluster > 0, 'the tab strip or the cluster is gone from index.html')
  assert.ok(strip < cluster,
    '.window-controls must come AFTER .tab-strip, or the tab moves off x 430 on Linux')
  assert.ok(cluster < close, '.window-controls must be inside .titlebar')
})

test('§5.7 — the titlebar drags and NOT ONE BUTTON does', () => {
  // `-webkit-app-region: drag` INHERITS, so the strip declares `drag` once and
  // every interactive child takes `no-drag` back. An interactive element left
  // out of that list swallows its own click.
  const appChromeCss = read('electron-shell/app-chrome.css')
  assert.match(appChromeCss, /\.titlebar\s*\{[^}]*webkit-app-region:\s*drag/,
    'the titlebar is not a drag region, so the window cannot be moved')
  const listStart = appChromeCss.indexOf('.titlebar button,')
  assert.ok(listStart > 0, 'the no-drag selector list is gone from app-chrome.css')
  const list = appChromeCss.slice(listStart, appChromeCss.indexOf('{', listStart))
  for (const sel of ['.titlebar button,', '.titlebar .tab,', '.titlebar .tab-label,',
                     '.titlebar .window-controls,', '.titlebar .window-controls .win-btn']) {
    assert.ok(list.includes(sel), `${sel} is missing from the no-drag list`)
  }

  const block = indexHtml.slice(
    indexHtml.indexOf('<div class="window-controls"'),
    indexHtml.indexOf('<div class="app">')
  )
  const buttons = block.match(/<button[^>]*>/g) ?? []
  assert.equal(buttons.length, 3, 'three controls: minimize, maximize, close')
  assert.doesNotMatch(block, /data-tauri-drag-region/,
    'the markup carries drag attributes again; the region is declared in app-chrome.css')
})

test('E7 — the cluster is off unless data-os is linux', () => {
  const css = chromeCss.replace(/\/\*[\s\S]*?\*\//g, '')
  assert.match(css, /\.window-controls\s*\{\s*display:\s*none;?\s*\}/,
    'the default must be OFF: macOS draws traffic lights in this strip instead')
  assert.match(css, /\[data-os="linux"\]\s+\.window-controls\s*\{[^}]*display:\s*flex/,
    'and ON only under [data-os="linux"]')
})

test('E7 — spike N §3.2 geometry survives in the CSS', () => {
  const css = chromeCss.replace(/\/\*[\s\S]*?\*\//g, '')
  const btn = css.slice(css.indexOf('.win-btn {'), css.indexOf('.win-btn:hover'))
  assert.match(btn, /width:\s*var\(--winctl-w\)/, 'the 44px box is a token, not a literal')
  assert.match(btn, /height:\s*100%/,
    'the button must fill the strip, not centre in it — 100% is the strip CONTENT box, ' +
    'i.e. 39px above the 1px rule §0.6 E8 added, which is exactly where Obsidian puts it')
  assert.doesNotMatch(btn, /border-radius/,
    'Obsidian rounds these ONLY under .mod-macos; a rounded hover fill in a square ' +
    'window corner is the visible tell of a hand-rolled title bar')
  // The tokens live in tokens.css — chrome.css declares none (§5.1).
  assert.match(tokensCss, /--winctl-w:\s*44px/)
  assert.match(tokensCss, /--bg-close-hover:\s*#fb464c/)
  assert.match(tokensCss, /:root\[data-os="linux"\][\s\S]*--macos-tl-inset:\s*8px/,
    'spike N §4: Linux zeroes the 80px traffic-light term, leaving Obsidian\'s own 8px')
})

test('E7 — the ✕ goes through §1.6 and cannot become a shortcut past it', () => {
  // THE ONE THAT MATTERS.  `window.close()` raises WindowEvent::CloseRequested,
  // which is where the dirty-buffer flush handshake is armed.  `destroy()` and
  // `app.exit()` skip it and silently discard the user's unsaved note — the
  // same class of defect dl_03 / dl_04 / dl_28 exist to prevent.
  const listener = appMain.slice(
    appMain.indexOf('function handleWindowControl'),
    appMain.indexOf('nc://window-state`, the middle glyph')
  )
  assert.ok(listener.length > 0, 'the window-control handler is gone from app-main.mjs')
  assert.match(listener, /win\.close\(\)/, 'the close arm no longer calls close()')
  assert.doesNotMatch(listener, /destroy\(\)|app\.exit\(/,
    'destroy()/exit() skip the close event and discard the buffer (§1.6)')
  // And the frontend reaches it by EVENT, never by a window command: the page
  // has no `allow-close` and dl_28 pins that it never gets one.
  assert.match(ipcTs, /emit\('window-control', \{ action \}\)/)
  assert.doesNotMatch(chromeTs, /plugin:window\|/,
    'chrome.ts must not invoke window plugin commands directly; ipc.ts owns the seam')
})

test('E7 — the maximize glyph follows the WINDOW, not the click', () => {
  // drag.js's double-click-to-maximize invokes internal_toggle_maximize through
  // __TAURI_INTERNALS__ and calls stopImmediatePropagation(), so the app never
  // sees it — nor a WM keybinding, nor a tiling manager.  An icon driven from
  // the button's own handler is wrong within one double-click.
  /* tao raised only `Resized`, so `lib.rs` re-read the state on every frame of
     a resize drag. Electron raises `maximize`/`unmaximize` DIRECTLY and keeps
     `resize` as the catch-all for a WM that changes the state without them --
     one deliberate improvement, and `emitWindowState` dedupes so a drag emits
     nothing. The property is the same: the SHELL owns the state. */
  assert.match(appMain, /for \(const ev of \['maximize', 'unmaximize', 'resize'\]\)/,
    'app-main.mjs no longer re-publishes the window state')
  assert.match(chromeTs, /onWindowState\(/, 'chrome.ts no longer listens for it')
  assert.match(chromeTs, /'win-restore'\s*:\s*'win-maximize'/, 'the glyph swap is gone')
  assert.doesNotMatch(chromeTs, /maxBtn\.innerHTML/,
    '§6.1: icons.ts is the only file in the app that may write markup')
})

test('E7 — the window is frameless, and the OS reaches the page from the shell', () => {
  /* `decorations(false)` was tao's spelling; Electron's is `frame: false`, and
     it is read off Obsidian's own `main.js` rather than derived (§0.17 E21).
     CROSS-PLATFORM here, unlike the Tauri arm: Electron takes `frame:false` +
     `titleBarStyle:'hidden'` on macOS too, which is what Obsidian ships. */
  assert.match(appMain, /frame: false/,
    'the native frame is back, so the app wears two title bars again')
  assert.match(appMain, /titleBarStyle: 'hidden'/)
  /* `__CAIRN_OS__` moved from an `initialization_script` to the preload, which
     is the only seam a sandboxed renderer has. Without it the page cannot know
     it is on Linux -- and a frameless window whose page draws no controls
     cannot be closed at all. */
  assert.match(preload, /exposeInMainWorld\('__CAIRN_OS__', 'linux'\)/,
    'the preload no longer tells the page it is on Linux')
  assert.match(preload, /process\.platform === 'linux'/,
    'the OS signal must be a fact about the process, never a guess')
  // Comments stripped: the prose above `applyPlatform` says the word
  // `navigator.userAgent` in order to say why it is NOT used.
  assert.doesNotMatch(stripComments(chromeTs), /navigator\.(userAgent|platform)/,
    'a sniff is a guess, and a wrong guess here ships an unclosable window')
})

/* ═══════════════════════════════════════════════════════════════════════════
 * §0.7 E9 — THE RESIZABLE SIDEBAR
 *
 * The bounds are PURE and exported, so they can be driven for real rather than
 * grepped for. A clamp that only exists inside a pointermove handler is a clamp
 * nobody ever checks, and this one guards the two states that look like a
 * crash: a sidebar collapsed to nothing, and an editor squeezed to nothing.
 * ═══════════════════════════════════════════════════════════════════════════ */

test('E9 — the clamp holds both floors, at the boundaries and past them', () => {
  const W = 1918
  const { SIDEBAR_MIN, EDITOR_MIN, clampSidebarW } = ICONS
  assert.equal(clampSidebarW(600, W), 600, 'an ordinary drag is passed through')
  assert.equal(clampSidebarW(SIDEBAR_MIN, W), SIDEBAR_MIN, 'the floor itself is legal')
  assert.equal(clampSidebarW(0, W), SIDEBAR_MIN, 'dragged to the left edge')
  assert.equal(clampSidebarW(-9999, W), SIDEBAR_MIN, 'dragged past the left edge')
  assert.equal(clampSidebarW(W, W), W - EDITOR_MIN, 'dragged to the right edge')
  assert.equal(clampSidebarW(99999, W), W - EDITOR_MIN, 'dragged past the right edge')
  assert.equal(clampSidebarW(412.6, W), 413, 'a fractional pointer x lands on a whole px')
})

test('E9 — a window too narrow for both floors keeps the SIDEBAR, not the editor', () => {
  const { SIDEBAR_MIN, EDITOR_MIN, clampSidebarW } = ICONS
  const tiny = SIDEBAR_MIN + EDITOR_MIN - 50
  assert.equal(clampSidebarW(9999, tiny), SIDEBAR_MIN,
    'a collapsed sidebar looks broken; a merely narrow editor does not')
  assert.ok(SIDEBAR_MIN + EDITOR_MIN <= 900,
    'both floors must fit inside tauri.conf.json minWidth 900, or the app can be ' +
    'launched into the degenerate case on purpose')
})

test('E9 — a corrupt persisted width falls back to the token default, not to NaN', () => {
  const { clampSidebarW, SIDEBAR_W_DEFAULT } = ICONS
  for (const bad of [NaN, Infinity, -Infinity]) {
    assert.equal(clampSidebarW(bad, 1918), SIDEBAR_W_DEFAULT, String(bad))
  }
  // and the JS default must agree with the CSS token, or boot and drag disagree
  assert.match(tokensCss, new RegExp('--sidebar-w:\\s*' + SIDEBAR_W_DEFAULT + 'px'),
    'chrome.ts\'s SIDEBAR_W_DEFAULT drifted from tokens.css\'s --sidebar-w')
})

test('E9 — setSidebarW writes an INLINE style, leaving tokens.css the only declarer', () => {
  const { doc } = installDom()
  ICONS.setSidebarW(333, doc)
  assert.equal(doc.documentElement.style.getPropertyValue('--sidebar-w'), '333px')
  // §5.1: chrome.css must still declare nothing.
  const decls = chromeCss.replace(/\/\*[\s\S]*?\*\//g, '').match(/(^|[;{]\s*)--[a-z0-9-]+\s*:/gim)
  assert.equal(decls, null, `chrome.css declares a custom property: ${decls}`)
})

test('E9/G9 — the gate can never see a persisted width', () => {
  // THE ONE THAT PROTECTS G9.  Every x the gate asserts — sidebar 412, editor
  // 412, scroller 409, gutter 401, tab 430 — is a function of --sidebar-w. If
  // a width the user dragged to yesterday reached a --pixeltest run, the gate
  // would report eight failures that mean nothing about the code.
  /* THIS WAS BROKEN ON THE ELECTRON SHELL AND THE TEST COULD NOT SEE IT,
     because it was reading `lib.rs` while the app ran on `app-main.mjs`: the
     width was never injected at all, so the gate was safe for the wrong reason
     and the FEATURE was dead. Both halves are asserted now. */
  assert.match(appMain, /function persistedSidebarW\(\)[\s\S]{0,200}if \(PIXELTEST\) return null/,
    'app-main.mjs no longer withholds the persisted sidebar width under --pixeltest')
  assert.match(appMain, /--cairn-sidebar-w=/, 'the width is never handed to the preload')
  assert.match(preload, /exposeInMainWorld\('__CAIRN_SIDEBAR_W__'/,
    'the preload no longer publishes the width chrome.ts:156 reads')
})

test('E9 — the handle takes no layout space and is not a window drag region', () => {
  const css = chromeCss.replace(/\/\*[\s\S]*?\*\//g, '')
  const rule = css.slice(css.indexOf('.sidebar-resize {'), css.indexOf('.sidebar-resize:hover'))
  assert.match(rule, /position:\s*absolute/,
    'a handle in flow would widen the sidebar past its measured 412 and move every gate x')
  assert.match(rule, /width:\s*var\(--divider-w\)/)
  assert.match(rule, /cursor:\s*col-resize/)
  // M59 is "no transitions anywhere"; Obsidian fades this over 200ms and we do not.
  assert.doesNotMatch(css.slice(css.indexOf('.sidebar-resize')), /^\s*transition\s*:/m)
})
