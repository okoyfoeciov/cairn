/**
 * electron-shell/preload.cjs -- the whole renderer/main boundary for §8.2
 * step 4.
 *
 * CommonJS on purpose: a SANDBOXED preload cannot be ESM, and the sandbox is
 * kept on because K6 (contextIsolation as a product ruling) has not been
 * decided and the safe default is the one that does not have to be argued for.
 *
 * Exactly two things cross: a request/response `invoke`, and a subscription
 * for the seven `nc://` events (§1.4). Nothing else is exposed -- in
 * particular no `require`, no `fs`, and no direct `ipcRenderer`.
 */
const { contextBridge, ipcRenderer } = require('electron')

/* ═══════════════════════════════════════════════════════════════════════════
 * THE PAGE-GLOBAL SEAM.
 *
 * The Tauri shell injected page globals with `.initialization_script(...)`.
 * This file is that seam's replacement, and when the shell was new it had no
 * counterpart at all -- so every global was silently ABSENT here, because every
 * reader of one is written to tolerate absence. Two were found that way and a
 * third (§0.7 E9's sidebar width) was found only when the Tauri source that
 * still declared it was deleted at step 10.
 *
 * It has to be `exposeInMainWorld`, not `window.x =`: `contextIsolation: true`
 * puts this file in the ISOLATED world, so a plain assignment lands somewhere
 * the page never looks. `exposeInMainWorld` takes primitives and defines them
 * before any page script runs, which is the contract the page needs.
 * ═════════════════════════════════════════════════════════════════════════ */

/* `src/wheel.ts` IS DELETED (§8.2 step 10), and with it this seam.
 *
 * It existed to withhold a main-thread JS clone of Chromium's wheel glide from
 * the one shell whose engine already IS Chromium -- and which the module
 * actively suppressed, by calling `preventDefault()` on a non-passive listener
 * (spike P §5, confirmed by experiment before any code was written). The module
 * was correct for WebKit and wrong here; deleting it with the WebKit shell is
 * what spike P said should happen, so there is nothing left to withhold and no
 * escape hatch to restore it with. `window-control.test.mjs` asserts the
 * absence, because a re-added JS glide reports a perfect 120 Hz while the
 * scroll stutters.
 */


/**
 * `__CAIRN_OS__ = 'linux'` -- the second half of the same missing seam.
 *
 * `chrome.ts:81` flips `data-os` on this and nothing else; there is
 * deliberately no `navigator.userAgent` fallback (globals.d.ts). Two things
 * ride on the attribute and BOTH were broken on this shell:
 *
 *   1. `.window-controls` is `display: none` without it (chrome.css). With
 *      `frame: false` (app-main.mjs) there are no native buttons either, so
 *      the window had NO close control at all -- only the WM's Alt+F4.
 *   2. `isMod()` picks Ctrl with it and ⌘ without. `data-os` was the string
 *      `macos` on Debian, so every Mod- shortcut was bound to SUPER and Ctrl-S
 *      fell through to the webview -- the same bug §0.5 E7 fixed for the Tauri
 *      build, reintroduced here by the missing injection.
 *
 * IT IS ONLY SAFE NOW BECAUSE THE OTHER HALF LANDED IN THE SAME CHANGE.
 * Until `app-main.mjs`'s `cairn:emit` learned `window-control`, all three
 * buttons emitted into a handler that answered `frontend-ready` and nothing
 * else, and `nc://window-state` was never sent, so the middle glyph could
 * never follow the window. Setting this global alone would have drawn three
 * dead buttons and a frozen glyph -- worse than the none there were. Do not
 * set it on a shell that has not implemented both.
 *
 * `process.platform`, not a build-time constant: this mirrors lib.rs:239's
 * `#[cfg(target_os = "linux")]`, and the typedef admits no other value
 * (`__CAIRN_OS__?: 'linux'`). On a macOS Electron run the global stays absent
 * and index.html's `data-os="macos"` stands, exactly as on Tauri.
 */
if (process.platform === 'linux') {
  contextBridge.exposeInMainWorld('__CAIRN_OS__', 'linux')
}

/**
 * `__PIXELTEST__` / `__PIXELTEST_GATE__` -- the THIRD half of the same seam.
 *
 * Tauri sets these with `initialization_script` (`lib.rs:227-231`) and they had
 * no counterpart here, so gate G9 could not run on the Electron shell at all.
 * They are NOT cosmetic and they do not only start the probe: `__PIXELTEST__`
 * starts `chrome.ts`'s geometry probe, and the probe parks the caret itself
 * (`tools/verify-geometry.js`'s `caretTo`) so no heading reveals its `# `
 * marker -- and every measured heading band in the reference is a
 * caret-elsewhere band (CONTRACT §5.4.1 rule 3). Without it the heading rows
 * measure a line that has shifted right.
 *
 * Set ONLY under CAIRN_PIXELTEST=1, so an ordinary launch has neither global.
 *
 * IT USED TO BE NESTED INSIDE THE `platform === 'linux'` BLOCK ABOVE, which
 * meant gate G9 COULD NEVER HAVE RUN ON macOS: `CAIRN_PIXELTEST=1` there set
 * neither global, `chrome.ts` would never start the probe, and the run would
 * have timed out with "no geometry-report" -- a failure that reads like a
 * frontend bug and is a brace. Found while deleting the Tauri shell, before
 * anybody tried it on the Mac. Cross-platform, as the sentence above always
 * said it was.
 */
/**
 * `__HARNESS__` -- "a harness is watching, expose the editor view".
 *
 * SPLIT OUT OF `__PIXELTEST__` on 2026-09-10, because the two things that flag
 * carried are not the same thing. It starts `chrome.ts`'s GEOMETRY PROBE, and
 * it installs `editor.ts`'s `__CM_VIEW__` SEAM. §5.4.5's editing probe needs
 * the second and must not have the first: the geometry probe drives the caret,
 * emits its report, and the run exits on it -- so asking for the view by
 * setting `CAIRN_PIXELTEST=1` got a G9 report instead and no probe at all.
 *
 * The seam is the general thing and the gate run is one of its two users, so
 * the seam gets its own flag rather than the probe borrowing the gate's.
 */
if (process.env.CAIRN_LP_PROBE === '1' || process.env.CAIRN_TOTP_PROBE === '1' ||
    process.env.CAIRN_SECRETS_PROBE === '1') {
  contextBridge.exposeInMainWorld('__HARNESS__', true)
}

if (process.env.CAIRN_PIXELTEST === '1') {
  contextBridge.exposeInMainWorld('__PIXELTEST__', true)
  // False only for the small-geometry plumbing run, where gate-mode rows would
  // be asserted against a geometry they were never measured at (§5.11.1). G9 is
  // only ever read from a gating run.
  contextBridge.exposeInMainWorld('__PIXELTEST_GATE__', process.env.CAIRN_PIXELTEST_GATE !== '0')
}

/**
 * §0.7 E9. The persisted sidebar width, handed over by the main process in
 * `additionalArguments` because a SANDBOXED preload cannot read `state.json`
 * itself. Absent under `--pixeltest` and absent on a first run, and
 * `chrome.ts:156` already treats absence as the 412 default.
 */
const sidebarW = process.argv.find((a) => a.startsWith('--cairn-sidebar-w='))
if (sidebarW) {
  const n = Number(sidebarW.slice('--cairn-sidebar-w='.length))
  if (Number.isFinite(n)) contextBridge.exposeInMainWorld('__CAIRN_SIDEBAR_W__', n)
}

contextBridge.exposeInMainWorld('cairn', {
  invoke: (command, args) => ipcRenderer.invoke('cairn:invoke', command, args),
  on: (event, handler) => {
    const channel = 'cairn:event:' + event
    const listener = (_e, payload) => handler(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
  emit: (event, payload) => ipcRenderer.send('cairn:emit', event, payload),
})
