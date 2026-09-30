/**
 * electron-shell/app-main.mjs -- §8.2 step 5: the real frontend on Electron,
 * over the REAL Rust core, loaded as a Node-API addon.
 *
 * IT WAS STEP 4 UNTIL THE ADDON LANDED, and the difference is the whole point
 * of step 5: `electron-shell/backend/` -- a second, JavaScript implementation
 * of the vault, TreeBlob v1 and the §2 note frame -- IS DELETED, with no
 * fallback. Every command below now reaches `app.rs` through
 * `electron-shell/native.mjs`, so there is exactly one implementation of §7's
 * data-loss rules in the process and it is the one `cargo test` covers.
 *
 * `CAIRN_ELECTRON_GEOM` overrides the geometry for a deliberate run;
 * `CAIRN_VAULT` points at a vault; `CAIRN_HEADLESS=1` renders fully offscreen
 * so nothing reaches the display at all.
 */

import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, screen, shell } from 'electron'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadAddon, nativeCommands, toEnvelope } from './native.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const HEADLESS = process.env.CAIRN_HEADLESS === '1'
const addon = loadAddon()

/**
 * WAYLAND-FIRST ON A WAYLAND SESSION WHOSE XWAYLAND ISN'T UP YET.
 *
 * MEASURED 2026-09-30 on a fresh Debian 13/GNOME install: with no `DISPLAY`
 * in the environment the default backend is X11, and the launch dies before
 * any window exists -- `Missing X server or $DISPLAY`, then a segfault. The
 * process stays around holding the single-instance lock, so every later
 * launch reports "another instance already holds the lock; handing over to
 * it" and nothing ever appears. Passing `--ozone-platform=wayland` on the
 * same machine opens the window at once.
 *
 * ONLY when `WAYLAND_DISPLAY` is set and `DISPLAY` is not. Once XWayland is
 * running (`DISPLAY` set) the default X11 backend works -- that is every
 * machine this app has ever run on -- so leave it alone there. Headless and
 * harness runs set neither variable and are untouched, and this is not macOS
 * (`have-display.mjs`: Quartz needs no variable at all).
 *
 * An `appendSwitch` here rather than an env var, because it has to reach the
 * zygotes as well: `ELECTRON_OZONE_PLATFORM_HINT=wayland` in the environment
 * was measured IGNORED on this build (still X11, still dead) while the
 * identical switch on the command line works. Must run before `ready`.
 */
if (
  process.platform === 'linux' &&
  process.env.WAYLAND_DISPLAY &&
  !process.env.DISPLAY
) {
  app.commandLine.appendSwitch('ozone-platform', 'wayland')
}

// The macOS app-menu title still reads "Electron": that name comes from the
// bundle's Info.plist, and this runs unpackaged. setName fixes the About panel
// and the userData path; the menu bar itself only changes at packaging (step 10).
app.setName('Cairn')

let win = null

const PIXELTEST = process.env.CAIRN_PIXELTEST === '1'

/**
 * `state.json`'s directory (§7.6), resolved by the SHELL and handed to the
 * addon -- never derived in Rust.
 *
 * §9 E1 makes the bundle identifier the thing that decides this path, and
 * since step 10 deleted `tauri.conf.json` its single source of truth is
 * `package.json` -- which `tools/package-electron.mjs` also reads, so the
 * bundle and the state file cannot drift apart. It is read rather than
 * respelled: two spellings of `com.cairn.app` is exactly the drift E1 spent a
 * ruling closing. It is NOT `app.getPath('userData')`, which would be
 * `<appData>/Cairn` and would silently strand the state the Tauri build wrote.
 *
 * A HARNESS RUN IS HERMETIC (spike-M D1). Under `--pixeltest` the shell SEEDS
 * `expanded` and `lastNote` through command 17 -- the Tauri runner seeds a
 * state file instead -- and with the real path that would rewrite the user's
 * own expansion set every time the gate ran. So a gate run gets a fresh temp
 * directory and nothing it writes outlives it. `CAIRN_STATE_DIR` overrides
 * either, for a harness that wants to pin the file.
 */
const HERMETIC_DIR = process.env.CAIRN_STATE_DIR
  ? process.env.CAIRN_STATE_DIR
  : PIXELTEST
    ? mkdtempSync(join(tmpdir(), 'cairn-pixeltest-'))
    // F59: a launch with CAIRN_VAULT set is a dev/fixture run, never the
    // user's real profile — it becomes hermetic rather than sharing the
    // installed app's lock, Chromium profile and state.json. A plain launch
    // is unchanged (on macOS the dev launch IS the user's real app).
    : process.env.CAIRN_VAULT
      ? mkdtempSync(join(tmpdir(), 'cairn-dev-'))
      : null
const HERMETIC_OWNED = !process.env.CAIRN_STATE_DIR && HERMETIC_DIR !== null
if (HERMETIC_OWNED) {
  process.on('exit', () => {
    try { rmSync(HERMETIC_DIR, { recursive: true, force: true }) } catch {}
  })
}

/**
 * A HERMETIC RUN GETS ITS OWN `userData`, AND THAT IS THREE THINGS AT ONCE.
 *
 *   1. Chromium's profile (cache, GPU shader cache, Local Storage) stops
 *      landing in the real one. Harness runs were creating `~/.config/Cairn`
 *      beside the user's own directory and nobody had noticed.
 *   2. Electron keys the SINGLE-INSTANCE LOCK on `userData`, so a test or a
 *      gate run can never be refused because the user has Cairn open -- and,
 *      the other way round, cannot steal the lock from it. Without this the
 *      lock below would make `npm test` fail depending on what else is running,
 *      which is the worst kind of flake.
 *   3. `state.json` goes with it, which is what it was already doing.
 *
 * It has to be set before `whenReady`.
 */
if (HERMETIC_DIR) app.setPath('userData', HERMETIC_DIR)

function prefsPath() {
  if (HERMETIC_DIR) return join(HERMETIC_DIR, 'state.json')
  let identifier = 'com.cairn.app'
  try {
    identifier =
      JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).identifier ?? identifier
  } catch {
    // A packaged app has its own package.json one level up from `electron-shell/`,
    // so this resolves in both layouts; the literal above is §9 E1's value and
    // is the same string either way.
  }
  return join(app.getPath('appData'), identifier, 'state.json')
}

/**
 * §8.2 step 7. ONE INSTANCE, and it is Obsidian's own answer: `main.js` calls
 * `app.requestSingleInstanceLock()` and gives up if it does not get it.
 *
 * IT IS NOT COSMETIC HERE. Two Cairns on one vault means two `VaultWatcher`s,
 * two arenas, and -- the part that loses data -- two writers of one
 * `state.json`, which §7.6 has no multi-writer story for: last flush wins, so
 * the instance you quit second silently overwrites the expansion set, the
 * window geometry and `last_note` of the one you quit first.
 *
 * `app.exit(0)`, not `app.quit()`: this process has no window and nothing to
 * flush, and `quit()` would run the §1.6 machinery for a vault it never opened.
 */
const GOT_LOCK = app.requestSingleInstanceLock()
if (!GOT_LOCK) {
  console.log('cairn: another instance already holds the lock; handing over to it')
  app.exit(0)
}

app.on('second-instance', () => {
  // What a person means by launching it twice is "show me the one I have".
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  if (!HEADLESS) win.show()
  win.focus()
})

/* NO SCALE-FACTOR SWITCH HERE, DELIBERATELY.
 * An earlier revision appended `--force-device-scale-factor=1` so the gate
 * could reach a green run at 125%.  It did not work -- on Wayland the scale
 * arrives via `wp_fractional_scale` and a client switch does not override it
 * (measured 3 runs per arm: 1.25/1.25/1.25 with, 1.25/1.25/1.25 without) -- and
 * asking the USER to change their desktop scale so a test passes is the wrong
 * shape of fix anyway.  The probe now states its comparison on the device grid,
 * so the gate runs at any scale and this switch has nothing left to do.
 * See CONTRACT §0.19.2. */

/* CONTRACT §5.11's probe. Tauri compiles it in (`lib.rs:103`, `include_str!`)
   and injects it with `initialization_script`; the Electron equivalent is an
   `executeJavaScript` from the MAIN process, which -- unlike an inline script
   in the page -- is not subject to the page's CSP.
   Read at startup rather than per-injection so a mid-run edit of the file
   cannot make two injections disagree. */
const PROBE_JS = PIXELTEST
  ? readFileSync(join(HERE, '..', 'tools', 'verify-geometry.js'), 'utf8')
  : null

let probeInjected = false
/**
 * Idempotent, and awaited at the one moment that makes it RACE-FREE: inside
 * `open_vault`, immediately before `nc://vault-opened` goes out. `chrome.ts`'s
 * `runGeometryProbe()` fires on the first rAF AFTER that event, so the probe
 * cannot be missing by the time it looks -- there is no timing assumption left
 * to be wrong about.
 *
 * It is also called on `dom-ready`, which is belt to that braces and costs one
 * assignment. If it somehow still lost, `chrome.ts:751` emits
 * `ok:false, error:'__verifyGeometry missing under --pixeltest'` -- a LOUD red,
 * never a silent green. That asymmetry is the whole design.
 */
async function injectProbe() {
  if (!PIXELTEST || probeInjected || !win || win.isDestroyed()) return
  probeInjected = true
  await win.webContents.executeJavaScript(PROBE_JS).catch((e) => {
    console.error('PIXELTEST: probe injection failed:', e && e.message)
    probeInjected = false
  })
}

function geometry() {
  const m = /^(\d+)x(\d+)$/.exec(process.env.CAIRN_ELECTRON_GEOM ?? '')
  if (m) return { width: Number(m[1]), height: Number(m[2]) }
  // CONTRACT §5.11: the gate window is 1920x964 INNER. `useContentSize` below
  // is what makes this the content box and not the frame -- with `frame:false`
  // they coincide today, but not on a platform that draws a frame, and a gate
  // that silently measures 1920 minus a border is the worst outcome there is.
  // 1918x958 UNTIL 2026-09-09. Corrected to the reference PNG's real content
  // box: spike-O §3.5 measured rows 31..994 x columns 0..1919, re-measured
  // independently this session (x=0 reads #4e4e4e = 78, which is 34 + 0.1991
  // of the way to white over the sidebar's #222222 -- a WASH OVER CONTENT, not
  // a 1px frame, so those columns are content). The old numbers came from
  // "1920 screenshot - 1px chrome each side", and that chrome does not exist.
  if (PIXELTEST) return { width: 1920, height: 964 }
  return { width: 1000, height: 700 }
}

const send = (event, payload) => {
  /* `CAIRN_DIAG=1` logs BOTH DIRECTIONS. It used to log only `cairn:emit` --
     page -> shell -- which left §1.4's whole event table, the shell -> page
     direction, invisible from outside the process. That is the direction the
     watcher, the vault open and the flush handshake all travel, so a harness
     could see the app being asked things and never see what it answered.
     Found while writing `shipped-binary.test.mjs`, which needed exactly this. */
  if (process.env.CAIRN_DIAG === '1') {
    console.log('[event]', event, JSON.stringify(payload ?? null))
  }
  if (win && !win.isDestroyed()) win.webContents.send('cairn:event:' + event, payload)
}

/**
 * THE `announce()` WRAPPER IS GONE, and its deletion is a result rather than a
 * tidy-up. It existed because the step-4 scaffold had no watcher: its own
 * comment said "in the real app, the Rust WATCHER emits", and without it a
 * rename moved the file on disk while the tree kept the old path. The real
 * watcher is now running -- `app::repair_and_emit` raises `nc://tree-changed`
 * from inside every mutation, through `AppCtx`, before the command returns,
 * and `watcher.rs` raises it for changes made outside the app. Wrapping the
 * commands again would rebuild the tree twice per mutation.
 *
 * `nc://note-external-change` arrives for the first time on this shell for the
 * same reason: the scaffold could not see an external edit at all.
 */

/* ── the twenty commands (§1.3) ────────────────────────────────────────────
      Eighteen of them are `native.mjs`'s and reach `app.rs` directly. The two
      below are the shell's own and are named in that file's header: there is no
      window in Rust to show, and the picker is Electron's. ─────────────────── */
const COMMANDS = {
  ...nativeCommands(addon),

  /** Command 1. §6.2's security property, kept: the dialog is opened by the
      MAIN process, never by the renderer, and no `dialog:*` capability is
      granted to the page. */
  async pick_vault() {
    const r = await dialog.showOpenDialog(win, {
      title: 'Open folder as vault',
      properties: ['openDirectory', 'createDirectory'],
    })
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
  },

  show_main_window: () => {
    if (win && !win.isDestroyed() && !HEADLESS) win.show()
  },

  /** Command 22 (§0.38 E85). Open a url a NOTE contains, in the OS's own
      handler. Shell-implemented for command 1's reason: `shell.openExternal` is
      Electron's, and the Rust core has no business launching a browser.

      THE ALLOWLIST IS HERE AND NOWHERE ELSE, and it is a Cairn decision rather
      than a transcription -- Obsidian normalises with `new URL(e).toString()`
      and does not restrict the scheme at this point. The renderer is not
      trusted to decide what the OS may be asked to open: the string comes out
      of somebody's markdown, `shell.openExternal` hands it to `xdg-open`, and
      `file:`, `javascript:` and every registered custom scheme are launchable
      that way. Three schemes are enough for what a note can contain, and
      widening it is a ruling, not a patch. */
  /** Command 23 (S0.46 E94). Put text on the system clipboard.
      Shell-implemented, like commands 1 and 22.

      NOT `navigator.clipboard.writeText`, AND THAT IS MEASURED RATHER THAN
      PREFERRED. In a real `file://` renderer on this shell the Async Clipboard
      API exists and REJECTS -- "Document is not focused." Every windowed run
      this repo takes is of an unfocused window (S0.23 E45), and for a
      credential a copy that silently fails is the worst outcome there is: the
      user pastes whatever was in the clipboard before and blames the site.
      Electron's own `clipboard` has no focus requirement.

      THE CAP IS NOT SECURITY, IT IS A SANITY BOUND. A one-time code is six to
      ten characters; nothing legitimate reaching this command is large, and an
      unbounded main-process write on renderer-supplied input is the kind of
      thing that should have a number on it. There is no allowlist because
      there is nothing to allow: unlike command 22, this hands the string to no
      OS handler and launches nothing. */
  copy_text: async (args) => {
    const text = typeof args.text === 'string' ? args.text : ''
    if (!text) throw vaultError('invalidPath', { path: '', reason: 'Nothing to copy.' })
    if (text.length > 4096) {
      throw vaultError('invalidPath', { path: '', reason: 'Refusing to copy more than 4096 characters.' })
    }
    clipboard.writeText(text)
  },

  open_external: async (args) => {
    const url = typeof args.url === 'string' ? args.url : ''
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      throw vaultError('invalidPath', { path: url, reason: 'Not a URL.' })
    }
    if (!OPENABLE_SCHEMES.has(parsed.protocol)) {
      throw vaultError('invalidPath', {
        path: url,
        reason: `Cairn opens http, https and mailto links only (got '${parsed.protocol}').`,
      })
    }
    await shell.openExternal(parsed.toString())
  },
}

/** §0.38 E85. `mailto:` is here because Obsidian linkifies a bare email and its
    own click handler rewrites it to `mailto:` before opening. */
const OPENABLE_SCHEMES = new Set(['http:', 'https:', 'mailto:'])

/** A §1.5 condition raised by a SHELL command, in the envelope `native.mjs`
    recognises -- so `ipc.ts` throws it in the page's world as the same plain
    object a Rust one arrives as, and `asVaultError` reads its `kind`. */
function vaultError(kind, fields) {
  return new Error('cairn.VaultError:' + JSON.stringify({ kind, ...fields }))
}

/* `open_vault` is the one native command the shell wraps, and only to keep
   §5.11's ordering: the probe MUST exist before `nc://vault-opened` reaches the
   page, because `chrome.ts`'s `runGeometryProbe()` fires on the first rAF after
   it. The addon emits that event itself, from inside `open_vault_blocking`, so
   the injection is hoisted to BEFORE the call rather than squeezed between the
   walk and the event -- there is no longer a gap to squeeze into. */
const openVaultNative = COMMANDS.open_vault
COMMANDS.open_vault = async (args) => {
  await injectProbe()
  return openVaultNative(args)
}

/**
 * §1.5 CROSSES AS A VALUE, NOT AS A THROW, and that is a fix rather than a
 * style choice.
 *
 * `ipcMain.handle` serialises a thrown Error by its `message` and `stack` and
 * by nothing else, so the step-4 scaffold's `throw new Error(JSON.stringify(
 * err.vaultError))` reached the renderer as
 * `Error invoking remote method 'cairn:invoke': Error: {"kind":"notFound",...}`
 * -- a string. `err.kind` was `undefined` at every call site that reads it
 * (`editor.ts:209`'s `asVaultError`, `inline-edit.ts:488`, `tabstrip.ts:215`),
 * so the whole of §1.5 was inert on this shell and every structured condition
 * degraded to the generic branch. Under Tauri `invoke` REJECTS WITH THE OBJECT,
 * which is what those call sites are written against.
 *
 * So the envelope is the value: `{ ok: true, value }` or
 * `{ ok: false, error }`, and `ipc-electron.mjs` throws the error object in the
 * page's own world, where it is a plain object exactly as Tauri's is.
 * `preload.cjs` forwards it untouched -- contextBridge clones plain data, and
 * an object thrown across it would not survive as one.
 *
 * A fault that is NOT a §1.5 condition still throws: an unknown command, a bad
 * argument type, `start()` not called, a panic in Rust. Those are programming
 * errors and must surface as such.
 */
ipcMain.handle('cairn:invoke', async (_e, command, args) => {
  const fn = COMMANDS[command]
  if (!fn) throw new Error(`cairn: unknown command '${command}'`)
  return toEnvelope(() => fn(args ?? {}))
})

/**
 * §0.5 E7's three window controls, the Electron half. `lib.rs:353-367` is the
 * reference and this matches it action for action.
 *
 * AN UNKNOWN ACTION IS IGNORED, NOT DEFAULTED -- lib.rs:348-350's reasoning,
 * unchanged: the only emitter is `ipc.ts:421`'s three-string union, so an
 * unknown value means the two ends have drifted, and guessing `close` on drift
 * is unthinkable.
 *
 * `close` is `win.close()`, NOT `destroy()` and NOT `app.quit()`. It raises the
 * `close` event below, which is §1.6's flush handshake -- so the ✕ takes the
 * same path the WM's own close does and a rejecting flush still cancels it.
 * Exported shape kept deliberately dumb: no state, no async, no return.
 */
function handleWindowControl(payload) {
  if (!win || win.isDestroyed()) return
  switch (payload && payload.action) {
    case 'minimize':
      win.minimize()
      break
    case 'toggle-maximize':
      if (win.isMaximized()) win.unmaximize()
      else win.maximize()
      break
    case 'close':
      win.close()
      break
    default:
      break
  }
}

/**
 * `nc://window-state`, the middle glyph's only source of truth (chrome.ts:551).
 *
 * WHY THE GLYPH CANNOT FOLLOW THE CLICK, restated from lib.rs:370-374 because
 * it is the whole reason this event exists: the WM can maximize on its own, a
 * double-click on the drag region never reaches the frontend, and a tiling WM
 * may refuse the request outright. So the SHELL owns the state and says so.
 *
 * THE PAYLOAD CARRIES THE STATE, NEVER THE TRANSITION, so a dropped event
 * self-heals on the next one (lib.rs:379-380).
 *
 * ONE DELIBERATE IMPROVEMENT ON THE RUST ARM, and it is named as one. tao
 * raises no `Maximized` event -- `Resized` is the only signal -- so lib.rs
 * re-reads and re-publishes on EVERY frame of a resize drag (lib.rs:625-631,
 * which accepts that cost explicitly). Electron raises `maximize` and
 * `unmaximize` directly, and `resize` is kept as the catch-all for a WM that
 * changes the state without them. `lastMaximized` then suppresses the
 * unchanged repeats, so a resize drag emits ZERO events instead of one per
 * frame. `force` exists for the first publish, where there is no previous
 * value to differ from.
 */
let lastMaximized = null

function emitWindowState(force = false) {
  if (!win || win.isDestroyed()) return
  const maximized = win.isMaximized()
  if (!force && maximized === lastMaximized) return
  lastMaximized = maximized
  send('nc://window-state', { maximized })
}

ipcMain.on('cairn:emit', (_e, event, payload) => {
  if (event === 'frontend-ready' && win && !win.isDestroyed() && !HEADLESS) win.showInactive()
  // THE FIRST PUBLISH RIDES ON `frontend-ready`, not on window creation.
  // lib.rs:381 emits during `setup()`, before the webview exists, so its first
  // event is delivered to nobody and the glyph is correct only from the first
  // resize onward -- survivable there because the payload is state, not a
  // transition. Here the frontend ANNOUNCES itself, so the one moment its
  // `onWindowState` subscription is guaranteed attached is this one. A window
  // mapped already maximized therefore draws the restore glyph on frame one.
  if (event === 'frontend-ready') emitWindowState(true)
  if (event === 'window-control') handleWindowControl(payload)
  /* CONTRACT §5.11, "consume it" -- the exact contract `lib.rs:508-515` keeps,
     through the exact frontend path: chrome.ts's `runGeometryProbe()` fires on
     the first rAF after `nc://vault-opened` and hands the report to
     `emitGeometryReport` (ipc.ts:369), which is one `emit('geometry-report')`.
     Print it as ONE JSON line, then exit 0 iff `ok`. THAT EXIT CODE IS GATE G9,
     and no other process needs to understand the event. */
  if (event === 'geometry-report' && PIXELTEST) {
    console.log(JSON.stringify(payload))
    // `ok` already folds fail AND skip (§5.11 errata 2: the field is `skip`,
    // singular, and there is no `skips` alias to read). A missing `ok` is a
    // malformed report and must NOT read as a pass.
    app.exit(payload && payload.ok === true ? 0 : 1)
  }
  if (process.env.CAIRN_DIAG === '1') console.log('[emit]', event, JSON.stringify(payload ?? null))
})

/**
 * §0.7 E9's persisted sidebar width, and it had NEVER been injected on this
 * shell -- found while deleting the Tauri one, because the test that pinned it
 * was reading `lib.rs`. `chrome.ts:156` reads `window.__CAIRN_SIDEBAR_W__` and
 * nothing set it, so the sidebar opened at 412 every time however the user had
 * dragged it.
 *
 * NEVER UNDER `--pixeltest`, and that is the half that protects a gate rather
 * than a preference: every x G9 asserts -- sidebar 412, editor 412, scroller
 * 409, gutter 401, tab 430 -- is a function of `--sidebar-w`. A width dragged
 * yesterday reaching a gate run would report eight failures that mean nothing
 * about the code. `lib.rs` withheld it for exactly this reason and said so.
 *
 * It is read from `state.json` HERE rather than fetched through a command,
 * because the command table is CLOSED AT TWENTY (§1.3) and this is one field of
 * a file whose path the shell already owns. `lib.rs` did the same thing with
 * `prefs::State::load`.
 */
function persistedSidebarW() {
  if (PIXELTEST) return null
  try {
    const w = JSON.parse(readFileSync(prefsPath(), 'utf8')).sidebar_w
    return Number.isFinite(w) ? w : null
  } catch {
    // No state file yet, or a truncated one. §7.6 is total: a missing or
    // corrupt value is the default, never an error.
    return null
  }
}

/**
 * §8.2 step 5. Build the process's `AppState`, install the §1.4 event sink and
 * load `state.json`. FIRST, and before `whenReady`: `ipcMain.handle` is already
 * registered by this point and a command that arrived before `start()` would
 * get "start() has not been called" rather than a vault.
 *
 * The event sink is `send`, which drops anything raised before the window
 * exists. That is the Tauri behaviour too (`lib.rs:381` emits during `setup()`,
 * before the webview exists, and says why it is survivable: §1.4's payloads
 * carry STATE, never a transition, so a dropped event self-heals on the next).
 *
 * `onQuit` is `AppCtx::quit`, which only §1.6's `confirm_close` and its watchdog
 * reach. `app.exit`, not `app.quit`: the flush has already happened by then and
 * a second pass through the `close` handler would re-arm the handshake.
 */
const WINCTL_PROBE = process.env.CAIRN_WINCTL_PROBE === '1'
const QUIT_PROBE = process.env.CAIRN_QUIT_PROBE === '1'
/** Which harness is watching, if any. The two probes drive DIFFERENT gestures
 *  into the SAME function -- the ✕ and `app.quit()` -- which is exactly what
 *  §8.2 step 7's done-when asks to be shown. */
const CLOSE_TAG = WINCTL_PROBE ? 'WINCTL_CLOSED' : QUIT_PROBE ? 'QUIT_CLOSED' : null
let closeReported = false
/** Called from the QUIT, so the line means the gesture completed THROUGH §1.6
 *  and not merely that a window object went away. */
function reportClose(viaHandshake) {
  if (!CLOSE_TAG || closeReported) return
  closeReported = true
  console.log(CLOSE_TAG + ' ' + JSON.stringify({ viaHandshake }))
}

addon.start(
  (event, payload) => send(event, payload),
  (code) => {
    reportClose(true)
    app.exit(code)
  },
  prefsPath()
)

/**
 * F27: Electron installs a default application menu — File>Quit, View>Reload,
 * Force Reload, Toggle DevTools, Window>Close — and its accelerators stay live
 * on the frameless window. Neither the renderer's keydown (N/1/2/S/Shift+F/O
 * only) nor CodeMirror consumes Mod-R, so Ctrl/Cmd+R called webContents.reload
 * with no unload guard, bypassing §1.6 for every buffer no flush can save
 * (conflicted/detached notes, the journal beat). The explicit menu below has
 * NO reload/forceReload roles. Belt and braces: `before-input-event` swallows
 * the keystroke even if a future menu rebuild reintroduces it.
 */
function installMenu() {
  const isMac = process.platform === 'darwin'
  const editSubmenu = [
    { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
    { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'delete' },
    { role: 'selectAll' },
  ]
  const viewSubmenu = [
    { role: 'toggleDevTools' }, { type: 'separator' },
    { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
    { type: 'separator' }, { role: 'togglefullscreen' },
  ]
  const template = isMac
    ? [
        { label: 'Cairn', submenu: [
          { role: 'about' }, { type: 'separator' },
          { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
          { type: 'separator' }, { role: 'quit' },
        ] },
        { label: 'File', submenu: [{ role: 'close' }] },
        { label: 'Edit', submenu: editSubmenu },
        { label: 'View', submenu: viewSubmenu },
        { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }] },
      ]
    : [
        { label: 'File', submenu: [{ role: 'quit' }] },
        { label: 'Edit', submenu: editSubmenu },
        { label: 'View', submenu: viewSubmenu },
        { label: 'Window', submenu: [{ role: 'close' }] },
      ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

app.whenReady().then(async () => {
  installMenu()
  const { width, height } = geometry()
  const display = screen.getPrimaryDisplay()

  win = new BrowserWindow({
    // §5.11 wants a DETERMINISTIC window: centred and unresizable, never
    // cornered. `lib.rs:216-224` does the same and says why -- if the window
    // cannot be made at the gate size, the probe's first row FAILS with the
    // actual size; the flag never silently clamps.
    ...(PIXELTEST
      ? { center: true, resizable: false, useContentSize: true }
      : { x: display.workArea.x + display.workArea.width - width - 20, y: display.workArea.y + 20 }),
    width,
    height,
    show: false,
    title: 'Cairn',
    backgroundColor: '#182028',
    /* CONTRACT §5.6, measured: macOS gets `decorations: true` + `titleBarStyle:
       Overlay` + `hiddenTitle: true` -- the native bar's CHROME stays (traffic
       lights, resize, shadow) but its caption and strip do not, and Cairn's own
       `.titlebar` occupies the top 39px with 88px reserved for the lights.
       `.titlebar` is CROSS-PLATFORM markup; only `.window-controls` is
       Linux-only (§0.5 E7). Electron's equivalent of Overlay+hiddenTitle is
       titleBarStyle 'hidden', which keeps the frame and drops the caption.

       THESE THREE VALUES ARE READ OFF OBSIDIAN ITSELF, not derived. Obsidian
       is an Electron app, so its own BrowserWindow options are the ground
       truth for the pinned engine, and `main.js` in obsidian-1.13.7.asar has:

           let Ae = D.frame === "native"        // false unless the user opts in
           let Ue = Ae ? "default" : "hidden"
           { trafficLightPosition: { x: 19, y: 12 }, frame: Ae, titleBarStyle: Ue }

       So: frame false, titleBarStyle 'hidden', lights at 19/12. An earlier
       revision of this block derived 20/11.5 by mapping §5.6's y=17.5 out of
       tao's coordinate space, and it was 1px right and 0.5px high -- visible
       side by side. §5.6's numbers are correct FOR TAO; they are not
       Electron's, and the reference app settles it without a pixel ruler.

       (§5.6's own history is the warning: two prior derivations, spec-07's
       y=12 and spec-01's y=19, were both wrong. This is the third derivation
       to fail and the first measurement to succeed.) */
    frame: false,
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 19, y: 12 },
    webPreferences: {
      preload: join(HERE, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      offscreen: HEADLESS,
      /* Tauri had `initialization_script`; Electron's equivalent for a value
         the MAIN process computes is `additionalArguments`, which the preload
         reads out of its own `process.argv`. A sandboxed preload cannot read a
         file, so the value has to arrive this way. */
      additionalArguments:
        persistedSidebarW() === null ? [] : [`--cairn-sidebar-w=${persistedSidebarW()}`],
    },
  })

  if (process.env.CAIRN_VAULT) {
    await addon.openVault(process.env.CAIRN_VAULT).catch((e) => {
      console.error('failed to open CAIRN_VAULT:', e.message)
    })
    /* §5.11's fixture, seeded through command 17 rather than through a state
       file. `run-g9.sh` writes a seeded `state.json` for the Tauri binary and
       lets the ordinary startup path read it; this shell opens the vault
       explicitly, so the seed has to go in after the open -- `save_ui_state`
       keys `expanded` and `scroll_top` BY VAULT ROOT and there is no root to
       key them to until then.
       Why it is needed at all: eleven G9 checks live on tree rows at depth 1, 2
       and 3, and a vault opens fully COLLAPSED -- those rows have no DOM,
       they SKIP, and a SKIP fails the run (chrome.ts:741). Without this the
       gate can never reach a verdict.
       It writes to a REAL state.json now, which is why `prefsPath()` hands a
       `--pixeltest` run a fresh temp directory: a gate run must not rewrite the
       expansion set of the person running it (spike-M D1). */
    if (process.env.CAIRN_PIXELTEST_EXPANDED !== undefined) {
      addon.saveUiState({
        expanded: process.env.CAIRN_PIXELTEST_EXPANDED.split(',').filter(Boolean),
      })
    }
    if (process.env.CAIRN_PIXELTEST_NOTE) {
      addon.saveUiState({ lastNote: process.env.CAIRN_PIXELTEST_NOTE })
    }
  } else {
    // §7.5: a normal launch reopens the vault state.json last recorded; a CAIRN_VAULT run opened its own above.
    if (typeof addon.startupOpen !== 'function') {
      // A cairn.node built before startupOpen existed would otherwise throw here and hang with no window.
      console.error('cairn: electron-shell/cairn.node is out of date; rebuild it with node electron-shell/build-native.mjs')
      app.exit(1)
      return
    }
    // Its stats of the tracked vault roots run on a worker and are bounded, so a
    // dead network mount delays this by at most the probe deadline and never
    // blocks this thread. Awaited so `current_vault` already answers `loading`
    // when the page first asks.
    await addon.startupOpen().catch((e) => {
      console.error('cairn: the startup vault open failed:', e && e.message)
    })
  }

  const consoleLines = []
  win.webContents.on('console-message', (...a) => {
    // Electron 39 passes (event, level, message, ...) or an event object;
    // normalise so a harness run records whichever shape arrives.
    const msg = typeof a[2] === 'string' ? a[2] : (a[0] && a[0].message) || String(a[2])
    consoleLines.push(msg)
  })

  // F27, belt and braces: the reload roles are gone from the menu, and the
  // keystroke never reaches the page even if a future rebuild re-adds them.
  win.webContents.on('before-input-event', (e, input) => {
    if ((input.control || input.meta) && (input.key === 'r' || input.key === 'R')) e.preventDefault()
  })

  /* F31: a dead renderer used to leave a blank, uncontrollable window whose
     only exit cost the 2 s watchdog. The Rust core still holds the open vault,
     so a crashed page reloads and re-serves it at once; a hang is logged. */
  win.webContents.on('render-process-gone', (_e, details) => {
    const reason = details ? details.reason : 'unknown'
    console.error('cairn: render-process-gone reason=' + reason)
    if (reason !== 'clean-exit' && win && !win.isDestroyed()) win.webContents.reload()
  })
  win.webContents.on('unresponsive', () => {
    console.error('cairn: renderer unresponsive')
  })

  /* §1.6, now THE REAL HANDSHAKE and not a re-implementation of it.
     `app::begin_close` emits `nc://flush-and-close`, arms the 2,000 ms watchdog
     (`CLOSE_DEADLINE_MS`, not the scaffold's 4,000) and answers whether the
     close must be prevented; `confirm_close` flushes `state.json`, sets
     `close_ok` and calls `AppCtx::quit`, which is `app.exit(0)` above. So a
     REJECTING FLUSH CANCELS THE CLOSE (B11/B18/M55) through the same code the
     Tauri build runs, and the watchdog's discard is logged by the same line.

     The window is not destroyed here. `close_ok` makes the second `begin_close`
     return false, so the ✕ that follows `app.exit` takes the ordinary path --
     which is exactly how `lib.rs` behaves, and it means there is one place
     that decides the process may go away. */
  win.on('close', (e) => {
    if (addon.beginClose()) e.preventDefault()
  })

  /* §0.5 E7. `maximize`/`unmaximize` are the direct signals tao never had;
     `resize` is the catch-all for a WM that changes the state without raising
     them. `emitWindowState` dedupes, so the resize arm costs one
     `isMaximized()` per event and sends nothing while the answer is unchanged. */
  for (const ev of ['maximize', 'unmaximize', 'resize']) win.on(ev, () => emitWindowState())

  /* `win.focus()` IS NOT REDUNDANT AFTER `show()`, and it is not etiquette.
   * MEASURED 2026-09-09 on this Debian/GNOME session: a gate run launched from
   * a terminal maps the window and leaves it UNFOCUSED — `document.hasFocus()`
   * reads false in the page while `document.activeElement` is already
   * `.cm-content`. The WM's focus-stealing prevention keeps the focus on the
   * shell that spawned it, and `show()` alone does not take it back. That was
   * invisible until §5.4.4's live preview gated its reveal on `view.hasFocus`
   * (which is `ownerDocument.hasFocus() && activeElement == contentDOM`), at
   * which point gate G9's `heading.marker.shown` row went red measuring a state
   * no user can be in. With this line: docFocus=true, viewFocus=true, 133/133.
   * CLAUDE.md §3's window-etiquette ruling was LIFTED by the user on
   * 2026-09-08, so a window that takes the focus it is entitled to is no longer
   * something this file has to apologise for.
   *
   * ALL THREE CALLS ARE NEEDED, and that was measured too, not assumed:
   * `show()` alone leaves docFocus false, `show() + focus()` ALSO leaves it
   * false (G9 red, marker count 0), and only `show() + focus() +
   * webContents.focus()` reaches docFocus=true / viewFocus=true / 133-133.
   * On Linux `webContents.focus()` activates the native view, which is the
   * part `BrowserWindow.focus()` does not do under this WM. Do not "simplify"
   * this line back to `win.show()`: the receipt for each step is above. */
  /* MAXIMIZED ON LAUNCH -- a user ruling, 2026-09-10: "Make the app start
   * maximized on first launch. I don't want to manually click the Maximize
   * button." It is not Obsidian's default (its `fe()` in main.js opens at
   * `min(1024, workArea.width) x min(800, workArea.height - 1)` and only
   * maximizes when its own persisted `isMaximized` says so), so this is a
   * DECISION and not a derivation -- but the CALL SITE is Obsidian's own:
   * `a.isMaximized && p.maximize(), ... p.show()`, i.e. maximize the hidden
   * window, then show it, so it is never painted at the small size first.
   *
   * NOT under `--pixeltest`, and not headless. §5.11 wants a DETERMINISTIC
   * window and G9 asserts `inner=1920x964`; a maximized gate window would
   * measure the display and fail every geometry row for a reason that has
   * nothing to do with the layout. Every windowed test in `electron-shell/`
   * runs with CAIRN_HEADLESS=1 and is therefore untouched by this.
   *
   * `emitWindowState` needs no help: `win.maximize()` raises `maximize`, and
   * `frontend-ready` republishes with `force`, so the title-bar glyph is the
   * RESTORE glyph on frame one (§0.5 E7). */
  const startMaximized = !PIXELTEST && !HEADLESS
  if (!HEADLESS) {
    win.once('ready-to-show', () => {
      if (startMaximized) win.maximize()
      win.show()
      win.focus()
      win.webContents.focus()
    })
  }

  /* `lifecycle.test.mjs`'s two receipts. It REPORTS and exits; every assertion
     lives in the test.

     `maximized` has to come from a REAL window -- `win.maximize()` on an
     offscreen one asks nothing of a window manager, so a headless run would
     assert against a value nobody computed. `tab` is the opposite: it is
     LAYOUT, which is exact offscreen, and the test that wants it forces
     `--force-device-scale-factor=1.25` so the number is the same on every
     machine. Both are reported from both arms; the test picks. */
  if (process.env.CAIRN_WINDOW_PROBE === '1') {
    let reported = false
    const report = async () => {
      if (reported || !win || win.isDestroyed()) return
      reported = true
      const b = win.getBounds()
      const work = screen.getPrimaryDisplay().workAreaSize
      /* NO BACKTICKS IN THIS TEMPLATE LITERAL (§0.24.10). The tab's own box,
         and the strip's, because the defect §0.26.2 fixed was a tab whose top
         was a function of the strip's height and therefore of how Chromium
         snapped a 1px border. */
      const tab = await win.webContents.executeJavaScript(`
        (async () => {
          // §7.4 hides the tab while no note is open, and a display:none box
          // measures 0 -- which would make every assertion below vacuous. Open
          // one the way a user does: a real click on a real tree row.
          if (document.querySelector('.tab[hidden]')) {
            const row = document.querySelector('.tree-scroller .tr')
            if (row) {
              for (const type of ['mousedown', 'mouseup', 'click']) {
                row.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }))
              }
              await new Promise((r) => setTimeout(r, 500))
            }
          }
          const t = document.querySelector('.tab'), s = document.querySelector('.tab-strip')
          const l = document.querySelector('.tab-label')
          if (!t || !s) return null
          const R = (e) => { const r = e.getBoundingClientRect(); return { top: +r.top.toFixed(4), h: +r.height.toFixed(4) } }
          return {
            dpr: devicePixelRatio,
            tab: R(t), strip: R(s), label: l ? R(l) : null,
            tabTopToken: getComputedStyle(document.documentElement).getPropertyValue('--tab-top').trim(),
            labelLineHeight: l ? getComputedStyle(l).lineHeight : null,
            stripAlign: getComputedStyle(s).alignItems,
            tabAlignSelf: getComputedStyle(t).alignSelf,
            tabHidden: t.hasAttribute('hidden'),
          }
        })()
      `).catch((e) => ({ error: String(e && e.message) }))
      console.log('WINDOW_PROBE ' + JSON.stringify({
        maximized: win.isMaximized(),
        asked: geometry(),
        bounds: { width: b.width, height: b.height },
        workArea: { width: work.width, height: work.height },
        page: tab,
      }))
      app.exit(0)
    }
    /* Wait for the WM to ACK, not for a guessed number of milliseconds: the
       `maximize` event is the acknowledgement, and reading `getBounds()` before
       it arrives measures the window Electron asked for rather than the one
       that is on screen. The fallback still fires so a WM that refuses the
       request is REPORTED (maximized:false) instead of hanging. The other arm
       has nothing to wait for beyond a first layout, and reports early because
       under `--pixeltest` the geometry report exits the process on its own. */
    if (startMaximized) win.once('maximize', () => setTimeout(() => void report(), 150))
    setTimeout(() => void report(), startMaximized ? 4000 : 1200)
  }

  /* S0.46 E94 -- the `totp` block in the real engine. Renders, copies through
     command 23, and adds an entry through the form.

     NO CODE AND NO COUNTDOWN TO SAMPLE since S0.46.6: the first version of this
     probe swept a live countdown for up to 34 seconds, and all of that is gone
     with the readout it was watching. NO BACKTICKS IN HERE (S0.24.10). */
  if (process.env.CAIRN_TOTP_PROBE === '1') {
    // F60: the probe's receipt is the OS clipboard, which belonged to the
    // user. Snapshot it first and put it back after the read, error path
    // included — the test must not eat whatever was copied before it ran.
    const savedClipboard = (() => { try { return clipboard.readText() } catch { return null } })()
    setTimeout(async () => {
      const out = await win.webContents.executeJavaScript(`
        (async () => {
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
          const q = (s) => document.querySelector(s)
          const all = (s) => Array.from(document.querySelectorAll(s))
          const blk = q('.nc-totp')
          if (!blk) return { error: 'no .nc-totp widget', body: document.body.innerText.slice(0, 200) }

          const readRows = () => all('.nc-totp-row').map((r) => ({
            label: r.querySelector('.nc-totp-label')?.textContent ?? null,
            comment: r.querySelector('.nc-totp-comment') ? r.querySelector('.nc-totp-comment').textContent : null,
            copiedText: r.querySelector('.nc-totp-copied') ? r.querySelector('.nc-totp-copied').innerText : null,
            cursor: getComputedStyle(r).cursor,
            tip: r.title || null,
            bad: r.classList.contains('is-bad'),
            err: r.querySelector('.nc-totp-error')?.textContent ?? null,
          }))

          await sleep(800)
          const first = readRows()
          /* The two things that must NOT be on screen: the seed (the security
             claim) and any six-digit run (the ruling). */
          const text = document.body.innerText
          const seedOnScreen = /GEZDGNBVGY3TQOJQ|JBSWY3DPEHPK3PXP/.test(text)
          const codeOnScreen = /\\b\\d{3}\\s?\\d{3}\\b/.test(text)
          const paneText = blk.innerText

          /* Click-to-copy: the row is the control, so the probe clicks the
             label the way a user does — never a button, there is none. */
          const row = all('.nc-totp-row:not(.is-bad)')[0]
          const rowLabel = row ? row.querySelector('.nc-totp-label') : null
          const pillOf = (el) => el ? el.querySelector('.nc-totp-copied') : null
          const pillBefore = pillOf(row) ? pillOf(row).innerText : null
          if (rowLabel) rowLabel.click()
          await sleep(600)
          const pillAfter = pillOf(row) ? pillOf(row).innerText : null
          /* It must clear again, or the row is stuck saying Copied forever. */
          await sleep(1200)
          const pillSettled = pillOf(row) ? pillOf(row).innerText : null

          const add = q('.nc-totp-add')
          if (add) add.click()
          await sleep(200)
          const formShown = q('.nc-totp-form') ? !q('.nc-totp-form').hidden : null
          q('.nc-totp-seed').value = 'not!base32!'
          q('.nc-totp-save').click()
          await sleep(250)
          const refusedMsg = q('.nc-totp-msg') ? q('.nc-totp-msg').textContent : null
          const rowsAfterRefusal = all('.nc-totp-row').length
          q('.nc-totp-input').value = 'Added By Test'
          q('.nc-totp-seed').value = 'JBSWY3DPEHPK3PXP'
          q('.nc-totp-save').click()
          await sleep(700)
          const rowsAfterAdd = readRows()
          const docText = window.__CM_VIEW__ ? window.__CM_VIEW__.state.doc.toString() : null

          return {
            first, seedOnScreen, codeOnScreen, paneText,
            pillBefore, pillAfter, pillSettled,
            formShown, refusedMsg, rowsAfterRefusal, rowsAfterAdd, docText,
          }
        })()
      `).catch((e) => ({ error: String(e && e.message) }))
      /* THE RECEIPT FOR COMMAND 23, and it has to be read HERE: the renderer
         cannot read the clipboard back (that needs a permission it is never
         granted), so a probe that only checked the button said "Copied" would
         be checking the label and not the copy. */
      out.clipboard = clipboard.readText()
      try { if (savedClipboard !== null) clipboard.writeText(savedClipboard) } catch {}
      console.log('TOTP ' + JSON.stringify(out))
      app.exit(0)
    }, 2600)
  }


  /* The secret file in the real engine: viewer takeover, masking, copy
     through command 23, add of both kinds, delete.  NO BACKTICKS IN HERE. */
  if (process.env.CAIRN_SECRETS_PROBE === '1') {
    // F60: see the TOTP probe above — same snapshot, same restore.
    const savedClipboard = (() => { try { return clipboard.readText() } catch { return null } })()
    setTimeout(async () => {
      const out = await win.webContents.executeJavaScript(`
        (async () => {
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
          const q = (s) => document.querySelector(s)
          const all = (s) => Array.from(document.querySelectorAll(s))
          await sleep(800)
          const root = q('.nc-secrets')
          if (!root) return { error: 'no .nc-secrets viewer', body: document.body.innerText.slice(0, 200) }
          const ed = q('#ed')
          const edHidden = ed ? getComputedStyle(ed).display === 'none' : null
          /* PRESENCE IS NOT VISIBILITY: the viewer once rendered fully below
             the fold (an emptied host still spans full height), probed
             present by every check, and painted nothing.  So the rect is the
             assertion — it must sit inside the window with real height. */
          const rect = root.getBoundingClientRect()
          const sections = all('.nc-secrets-section').length
          /* The tree row for this file carries the secret mark (command 25).
             Rows show the stem, so match on that. */
          const treeRow = all('.tree-scroller .tr').find((r) => r.textContent === 'vault-secrets')
          const treeSecret = treeRow ? treeRow.classList.contains('is-secret') : null
          const treeInk = treeRow ? getComputedStyle(treeRow).color : null
          const readRows = (idx) => {
            const sec = all('.nc-secrets-section')[idx]
            if (!sec) return null
            return Array.from(sec.querySelectorAll('.nc-secrets-row')).map((r) => ({
              label: r.querySelector('.nc-secrets-label') ? r.querySelector('.nc-secrets-label').textContent : null,
              comment: r.querySelector('.nc-secrets-comment') ? r.querySelector('.nc-secrets-comment').textContent : null,
              copiedText: r.querySelector('.nc-secrets-copied') ? r.querySelector('.nc-secrets-copied').innerText : null,
              cursor: getComputedStyle(r).cursor,
              role: r.getAttribute('role'),
              tip: r.title || null,
              value: r.querySelector('.nc-secrets-value') ? r.querySelector('.nc-secrets-value').textContent : null,
              show: r.querySelector('.nc-secrets-show') ? r.querySelector('.nc-secrets-show').textContent : null,
              edit: r.querySelector('.nc-secrets-edit') ? r.querySelector('.nc-secrets-edit').textContent : null,
              bad: r.classList.contains('is-bad'),
              err: r.querySelector('.nc-secrets-error') ? r.querySelector('.nc-secrets-error').textContent : null,
            }))
          }
          const totpFirst = readRows(0)
          const secretFirst = readRows(1)
          /* The three things that must NOT be on screen. */
          const text = document.body.innerText
          const seedOnScreen = /GEZDGNBVGY3TQOJQ/.test(text)
          const secretOnScreen = /sk-test-TESTONLY456/.test(text)
          const codeOnScreen = /\\b\\d{3}\\s?\\d{3}\\b/.test(text)

          /* TOTP copy by clicking the row itself: the pill must confirm (the
             code receipt is the secret row's exact clipboard match below;
             this proves totpCode ran in the viewer without throwing). */
          const totpRow = all('.nc-secrets-section')[0].querySelector('.nc-secrets-row')
          const totpLabel = totpRow ? totpRow.querySelector('.nc-secrets-label') : null
          if (totpLabel) totpLabel.click()
          await sleep(600)
          const totpCopyLabel = totpRow && totpRow.querySelector('.nc-secrets-copied') ?
            totpRow.querySelector('.nc-secrets-copied').innerText : null

          /* Show toggle: masked, then the secret, then masked again. */
          const firstSecretRow = all('.nc-secrets-section')[1].querySelector('.nc-secrets-row')
          const showBtn = firstSecretRow ? firstSecretRow.querySelector('.nc-secrets-show') : null
          const maskedBefore = firstSecretRow ? firstSecretRow.querySelector('.nc-secrets-value').textContent : null
          if (showBtn) showBtn.click()
          await sleep(200)
          const shownValue = firstSecretRow ? firstSecretRow.querySelector('.nc-secrets-value').textContent : null
          const showLabel = showBtn ? showBtn.textContent : null
          if (showBtn) showBtn.click()
          await sleep(200)
          const maskedAfter = firstSecretRow ? firstSecretRow.querySelector('.nc-secrets-value').textContent : null

          /* Secret copy by clicking the row, while masked again: the copy
             reads the MODEL, not the mask.  This is the LAST copy, so the
             main-process clipboard read below is its receipt. */
          const secretLabel = firstSecretRow ? firstSecretRow.querySelector('.nc-secrets-label') : null
          if (secretLabel) secretLabel.click()
          await sleep(500)
          const secretCopyLabel = firstSecretRow && firstSecretRow.querySelector('.nc-secrets-copied') ?
            firstSecretRow.querySelector('.nc-secrets-copied').innerText : null

          /* TOTP add: refusal first, then a valid entry with a comment. The
             queries stay INSIDE the Add form: every row carries a hidden edit
             form with the same input classes. */
          const totpSec = all('.nc-secrets-section')[0]
          const totpAdd = totpSec.querySelector('.nc-secrets-add')
          if (totpAdd) totpAdd.click()
          await sleep(200)
          const totpAddForm = totpSec.querySelector('.nc-secrets-form:not(.nc-secrets-editform)')
          const totpFormShown = totpAddForm ? !totpAddForm.hidden : null
          const totpInputs = totpAddForm.querySelectorAll('.nc-secrets-input')
          totpInputs[2].value = 'not!base32!'
          totpAddForm.querySelector('.nc-secrets-save').click()
          await sleep(250)
          const totpRefused = totpAddForm.querySelector('.nc-secrets-msg').textContent
          const totpRowsAfterRefusal = readRows(0).length
          totpInputs[0].value = 'Added By Test'
          totpInputs[1].value = 'added comment'
          totpInputs[2].value = 'JBSWY3DPEHPK3PXP'
          totpAddForm.querySelector('.nc-secrets-save').click()
          await sleep(700)
          const totpAfterAdd = readRows(0)

          /* Secret-text add: refusal (no label), then a two-line entry with
             a comment — scoped to the Add form for the same reason. */
          const secSec = all('.nc-secrets-section')[1]
          const secAdd = secSec.querySelector('.nc-secrets-add')
          if (secAdd) secAdd.click()
          await sleep(200)
          const secAddForm = secSec.querySelector('.nc-secrets-form:not(.nc-secrets-editform)')
          const secInputs = secAddForm.querySelectorAll('.nc-secrets-input')
          secInputs[2].value = 'label-less value'
          secAddForm.querySelector('.nc-secrets-save').click()
          await sleep(250)
          const secRefused = secAddForm.querySelector('.nc-secrets-msg').textContent
          secInputs[0].value = 'Probe Added'
          secInputs[1].value = 'probe comment'
          secInputs[2].value = 'probe-value-1' + String.fromCharCode(10) + 'probe-value-2'
          secAddForm.querySelector('.nc-secrets-save').click()
          await sleep(700)
          const secretAfterAdd = readRows(1)

          /* Rows go stale on every render, so each leg below re-queries by
             label, and each form by visibility. */
          const findRow = (idx, label) => Array.from(all('.nc-secrets-section')[idx].querySelectorAll('.nc-secrets-row')).find((r) => {
            const lab = r.querySelector('.nc-secrets-label')
            return lab && lab.textContent === label
          })
          const visibleForm = (idx) => Array.from(all('.nc-secrets-section')[idx].querySelectorAll('.nc-secrets-editform')).find((f) => !f.hidden)

          /* Edit the secret entry just added: label, comment and secret. */
          let secretEditOpened = false
          const addedSec = findRow(1, 'Probe Added')
          if (addedSec) {
            addedSec.querySelector('.nc-secrets-edit').click()
            await sleep(300)
            const f = visibleForm(1)
            if (f) {
              secretEditOpened = true
              const inputs = f.querySelectorAll('.nc-secrets-input')
              inputs[0].value = 'Probe Edited'
              inputs[1].value = 'edited comment'
              inputs[2].value = 'edited-value-1' + String.fromCharCode(10) + 'edited-value-2'
              f.querySelector('.nc-secrets-save').click()
            }
          }
          await sleep(700)
          const secretAfterEdit = readRows(1)
          const docAfterSecretEdit = window.__CM_VIEW__ ? window.__CM_VIEW__.state.doc.toString() : null

          /* Edit the TOTP entry just added: rename, keep the seed. */
          let totpEditOpened = false
          const addedTotp = findRow(0, 'Added By Test')
          if (addedTotp) {
            addedTotp.querySelector('.nc-secrets-edit').click()
            await sleep(300)
            const f = visibleForm(0)
            if (f) {
              totpEditOpened = true
              const inputs = f.querySelectorAll('.nc-secrets-input')
              inputs[0].value = 'Added Edited'
              inputs[1].value = 'edited totp comment'
              f.querySelector('.nc-secrets-save').click()
            }
          }
          await sleep(700)
          const totpAfterEdit = readRows(0)
          const docAfterTotpEdit = window.__CM_VIEW__ ? window.__CM_VIEW__.state.doc.toString() : null

          /* Delete the entry just edited, found by its NEW label.  Delete ASKS
             FIRST: cancel keeps, a second Delete plus the modal's Delete
             removes. */
          const editedRows = all('.nc-secrets-section')[1].querySelectorAll('.nc-secrets-row')
          let editedRow = null
          for (const r of editedRows) {
            const lab = r.querySelector('.nc-secrets-label')
            if (lab && lab.textContent === 'Probe Edited') editedRow = r
          }
          let deleted = false
          let modalTitle = null
          let rowsAfterCancel = null
          if (editedRow) {
            editedRow.querySelector('.nc-secrets-delete').click()
            await sleep(300)
            const modal = q('.nc-modal')
            modalTitle = modal ? modal.querySelector('.nc-modal-title').textContent : null
            const cancelBtn = modal ? modal.querySelector('.nc-modal-btn[data-id="cancel"]') : null
            if (cancelBtn) cancelBtn.click()
            await sleep(300)
            rowsAfterCancel = readRows(1).length
            editedRow.querySelector('.nc-secrets-delete').click()
            await sleep(300)
            const modal2 = q('.nc-modal')
            const delBtn = modal2 ? modal2.querySelector('.nc-modal-btn[data-id="delete"]') : null
            if (delBtn) { delBtn.click(); deleted = true }
          }
          await sleep(700)
          const secretAfterDelete = readRows(1)
          const docText = window.__CM_VIEW__ ? window.__CM_VIEW__.state.doc.toString() : null

          /* Let the §7.2 autosave flush so the test can read the file. */
          await sleep(2000)
          return {
            edHidden, sections, treeSecret, treeInk, totpFirst, secretFirst,
            rectTop: rect.top, rectHeight: rect.height, rectBottom: rect.bottom,
            winH: window.innerHeight,
            seedOnScreen, secretOnScreen, codeOnScreen,
            totpCopyLabel, maskedBefore, shownValue, showLabel, maskedAfter,
            secretCopyLabel, totpFormShown, totpRefused, totpRowsAfterRefusal,
            totpAfterAdd, secRefused, secretAfterAdd, secretEditOpened, secretAfterEdit,
            docAfterSecretEdit,             totpEditOpened, totpAfterEdit, docAfterTotpEdit,
            deleted, secretAfterDelete,
            modalTitle, rowsAfterCancel, docText,
          }
        })()
      `).catch((e) => ({ error: String(e && e.message) }))
      out.clipboard = clipboard.readText()
      try { if (savedClipboard !== null) clipboard.writeText(savedClipboard) } catch {}
      console.log('SECRETS ' + JSON.stringify(out))
      app.exit(0)
    }, 2600)
  }

  /* S0.45 E91/E92 -- the pane with NO NOTE OPEN.  Reports what is actually on
     screen and whether the editor is an editable surface at all.  NO BACKTICKS
     IN HERE (S0.24.10). */
  if (process.env.CAIRN_EMPTY_PROBE === '1') {
    setTimeout(async () => {
      const out = await win.webContents.executeJavaScript(`
        (async () => {
          const ed = document.querySelector('.editor')
          const content = document.querySelector('.cm-content')
          if (content) content.focus()
          await new Promise((r) => setTimeout(r, 300))
          const vis = []
          const shown = (el) => {
            // A leaf's own display says nothing when an ancestor hides the
            // whole subtree (the Memoir page's hidden buttons read as
            // "visible" otherwise): walk up to the pane.
            for (let n = el; n && n !== ed; n = n.parentElement) {
              const cs = getComputedStyle(n)
              if (cs.display === 'none' || cs.visibility === 'hidden') return false
            }
            return true
          }
          for (const el of ed ? ed.querySelectorAll('*') : []) {
            const t = (el.textContent || '').trim()
            if (t && shown(el) && el.children.length === 0) {
              vis.push(el.className + ' :: ' + t.slice(0, 40))
            }
          }
          return {
            emptyStateEl: !!document.querySelector('.empty-state'),
            paneText: ed ? ed.innerText.trim() : null,
            visibleTextNodes: vis,
            contentEditable: content ? content.getAttribute('contenteditable') : null,
            caretColor: content ? getComputedStyle(content).caretColor : null,
            caretToken: content ? getComputedStyle(content).getPropertyValue('--caret-color').trim() : null,
            contentColor: content ? getComputedStyle(content).color : null,
            rootCaretToken: getComputedStyle(document.documentElement).getPropertyValue('--caret-color').trim(),
            focusIsContent: document.activeElement === content,
            tabHidden: document.querySelector('.tab') ? document.querySelector('.tab').hidden : null,
          }
        })()
      `).catch((e) => ({ error: String(e && e.message) }))
      console.log('EMPTY ' + JSON.stringify(out))
      app.exit(0)
    }, 2500)
  }

  /* S0.51 E99 -- THE LEADING INDENT RUN OF A LIST LINE, in the real engine.
     Reports, per line: the line's class and vertical padding, and every indent
     group with its class and RENDERED width.

     NOTHING BELOW A REAL ENGINE DECIDES THIS. `tests/frontend` can assert which
     ranges the decorator emits -- and it does -- but the two numbers the user
     actually reported are a WIDTH and a HEIGHT: `min-width: var(--list-indent)`
     quantising a whole group to 36px, and `--list-spacing` arriving on one side
     or two. Both are the cascade's answer, not the decorator's, and the shim has
     neither layout nor computed styles.

     ITS OWN FIXTURE, AND ITS OWN FILE, DELIBERATELY. `live-preview.test.mjs`'s
     note carries S0.26 E62's hit-test row at ZERO tolerance, and that fixture
     already had an ordered item taken back out of it for landing a 30px sample
     on a glyph midpoint (KNOWN-ISSUES V-4). Adding five list shapes to it to
     test something else would put that guard at risk for an unrelated reason.

      NO BACKTICKS IN HERE (S0.24.10). */
   /* The fixed Memoir tab (user feature, 2026-09-15; a journal PAGE since
      2026-09-17, not a note in the editor): second tab, no close button,
      vault-root Memoir.md shown ONLY there, inside the page's own textarea.
      The probe clicks both tabs with real MouseEvents and samples the strip,
      the pane takeover and the painted tree rows at each stop.  What the DOM
      shim cannot prove and this can: the lazy create reaching disk, the
      switch reaching the real page (vault read/create through the real
      addon, the #ed HOST hidden, the page's textarea mounted), the tree
      hiding the file in the REAL virtualiser, and coming back to the note.
      NO BACKTICKS IN HERE (S0.24.10). */
  if (process.env.CAIRN_MEMOIR_PROBE === '1') {
    setTimeout(async () => {
      const out = await win.webContents.executeJavaScript(`
        (async () => {
          function tabState() {
            var note = document.querySelector('.tab-strip .tab:not([data-tab="memoir"])');
            var memoir = document.querySelector('.tab-strip [data-tab="memoir"]');
            var rows = Array.prototype.slice.call(document.querySelectorAll('.tree-scroller .tr')).filter(function (r) { return !r.hidden; }).map(function (r) { return (r.textContent || '').trim(); });
            var title = document.querySelector('.nc-title');
            // The hover-pill inset: the inner's left edge minus the slot's.  3px
            // per side is what separates a hovered pill from the active tab.
            function insetL(tab) {
              if (!tab) return null;
              var inner = tab.querySelector('.tab-inner');
              if (!inner) return null;
              return +(inner.getBoundingClientRect().left - tab.getBoundingClientRect().left).toFixed(2);
            }
            return {
              tabs: document.querySelectorAll('.tab-strip .tab').length,
              noteHidden: note ? note.hidden : null,
              memoirHidden: memoir ? memoir.hidden : null,
              noteActive: note ? note.classList.contains('is-active') : null,
              memoirActive: memoir ? memoir.classList.contains('is-active') : null,
              noteLabel: note && note.querySelector('.tab-label') ? note.querySelector('.tab-label').textContent : null,
              memoirLabel: memoir && memoir.querySelector('.tab-label') ? memoir.querySelector('.tab-label').textContent : null,
              title: title ? title.textContent : null,
              // THE TAKEOVER, AS RENDERED.  memoirVisible is the page's own
              // host; edHidden reads the COMPUTED display because the rule
              // hides the #ed host (an emptied-but-visible #ed keeps its
              // height and pushes the page below the fold — presence is not
              // visibility).  mmEditor is the page's textarea.
              memoirVisible: (function () { var m = document.getElementById('memoir'); return m ? !m.hidden : null; })(),
              edHidden: (function () { var e = document.getElementById('ed'); return e ? getComputedStyle(e).display === 'none' : null; })(),
              mmEditor: !!document.getElementById('mm-editor'),
              // FOCUS + SIZE (user rulings, 2026-09-17): selecting the tab
              // must land the caret in the text, and the verbs wear the tab
              // label's 13px.
              mmFocused: (function () { var e = document.getElementById('mm-editor'); return e ? document.activeElement === e : null; })(),
              checkFont: (function () { var b = document.getElementById('mm-checkBtn'); return b ? getComputedStyle(b).fontSize : null; })(),
              // THE NOTE ALIGNMENT, AS RENDERED: the journal frame's left
              // padding against the live editor scroller's own.
              mmFramePadL: (function () { var f = document.querySelector('.mm-frame'); return f ? getComputedStyle(f).paddingLeft : null; })(),
              cmPadL: (function () { var s = document.querySelector('.cm-scroller'); return s ? getComputedStyle(s).paddingLeft : null; })(),
              // THE CAIRN TYPE, AS RENDERED: the journal textarea wears the
              // note's own face and size — sans, 16px.
              mmFont: (function () { var e = document.getElementById('mm-editor'); return e ? getComputedStyle(e).fontFamily : null; })(),
              mmSize: (function () { var e = document.getElementById('mm-editor'); return e ? getComputedStyle(e).fontSize : null; })(),
              noteInsetL: insetL(note),
              memoirInsetL: insetL(memoir),
              // The pill radius, COMPUTED (E53's shape: right, present and
              // outranked fails silently) — 4px off macOS, 8px on it.
              pillRadius: memoir && memoir.querySelector('.tab-inner')
                ? getComputedStyle(memoir.querySelector('.tab-inner')).borderTopLeftRadius
                : null,
              os: document.documentElement.getAttribute('data-os'),
              treeRows: rows
            };
          }
          function click(el) {
            var types = ['mousedown', 'mouseup', 'click'];
            for (var k = 0; k < types.length; k++) {
              el.dispatchEvent(new MouseEvent(types[k], { bubbles: true, cancelable: true, button: 0 }));
            }
          }
           function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
           var memoir = document.querySelector('.tab-strip [data-tab="memoir"]');
           var note = document.querySelector('.tab-strip .tab:not([data-tab="memoir"])');
           if (!memoir || !note) return { error: 'memoir tab missing from the strip' };
           var wantLive = ${process.env.CAIRN_MEMOIR_LIVE === '1' ? 'true' : 'false'};
           var before = tabState();
           click(memoir);
           await wait(1000);
           // Focus lands after the async entry load, not the click — poll for
           // the caret rather than sampling a race.
           var ft0 = Date.now();
           while (Date.now() - ft0 < 5000) {
             var ae = document.activeElement;
             if (ae && ae.id === 'mm-editor') break;
             await wait(200);
           }
           var onMemoir = tabState();
            // THE LIVE LEG (gated: it bills one Cerebras turn).  Type a sentence
           // with a known error, wait for the autosaved status, run Check,
           // and read back the issue cards — the whole renderer-to-localhost
           // path, plus the vault write proved from disk by the test.
           var live = null;
           if (wantLive) {
             var mmed = document.getElementById('mm-editor');
             if (!mmed) { live = { error: 'no mm-editor' }; }
             else {
               mmed.focus();
               mmed.value = 'Yesterday I go to office at morning.';
               mmed.dispatchEvent(new Event('input', { bubbles: true }));
               var t0 = Date.now();
               var saved = false;
               while (Date.now() - t0 < 15000) {
                 await wait(500);
                 var st = document.getElementById('mm-status');
                 if (st && st.textContent.indexOf('Saved') === 0) { saved = true; break; }
               }
               var checkBtn = document.getElementById('mm-checkBtn');
               if (checkBtn) click(checkBtn);
               var issues = -1;
               var reason = null;
               var spin = null;
               var sawSpinner = false;
               t0 = Date.now();
               while (Date.now() - t0 < 120000) {
                 await wait(1000);
                 // The fourth rule-5 exemption, as rendered: the panel ink
                 // ring must carry a RUNNING animation, not the blanket
                 // ban's none.  (The toolbar button carries no spinner any
                 // more — user ruling 2026-09-18.)
                 if (spin === null) {
                   var sp = document.querySelector('#memoir .mm-ink-ring');
                   if (sp) spin = getComputedStyle(sp).animationName || '';
                 }
                 if (document.querySelector('#mm-checkBtn .mm-spinner')) sawSpinner = true;
                 var cards = document.querySelectorAll('#mm-checkPanel .mm-issue');
                 if (cards.length > 0) {
                   issues = cards.length;
                   var r0 = cards[0].querySelector('.mm-issue-reason');
                   reason = r0 ? r0.textContent : null;
                   break;
                 }
                 var empty = document.querySelector('#mm-checkPanel .mm-empty');
                 if (empty && (empty.textContent.indexOf('Could not') === 0 || empty.textContent.indexOf('Check failed') === 0)) {
                   issues = 0;
                   reason = empty.textContent;
                   break;
                 }
               }
               live = { saved: saved, issues: issues, reason: reason, spin: spin, sawSpinner: sawSpinner };
             }
           }
           // THE TREE LEG (reported 2026-09-17): selecting a row from inside
           // the page must leave it for the note viewer — not just the note
           // tab.  Every route funnels through openNoteAt, so this samples
           // the same takeover fields after a real row click.
           var treeNote = null;
           var allRows = Array.prototype.slice.call(document.querySelectorAll('.tree-scroller .tr'));
           var memoryRow = null;
           for (var k = 0; k < allRows.length; k++) {
             if ((allRows[k].textContent || '').trim() === 'Memory') { memoryRow = allRows[k]; break; }
           }
           if (memoryRow) {
             click(memoryRow);
             await wait(1000);
             treeNote = tabState();
           }
           click(note);
           await wait(1000);
           var backOnNote = tabState();
           return { before: before, onMemoir: onMemoir, live: live, treeNote: treeNote, backOnNote: backOnNote };
        })()
      `).catch((e) => ({ error: String(e && e.message) }))
      console.log('MEMOIR ' + JSON.stringify(out))
      app.exit(0)
    }, 3000)
  }
  if (process.env.CAIRN_INDENT_PROBE === '1') {
    setTimeout(async () => {
      const out = await win.webContents.executeJavaScript(`
        (async () => {
          const content = document.querySelector('.cm-content')
          if (!content) return { error: 'no .cm-content -- no note is open' }
          const cbox = content.getBoundingClientRect()
          const lines = []
          for (const l of content.querySelectorAll('.cm-line')) {
            const lc = getComputedStyle(l)
            const box = l.getBoundingClientRect()
            const groups = Array.from(l.querySelectorAll(':scope > .nc-indent, :scope > .nc-indent-sp')).map((g) => {
              const gc = getComputedStyle(g)
              return { cls: g.className, text: JSON.stringify(g.textContent),
                       w: +g.getBoundingClientRect().width.toFixed(3),
                       pad: gc.paddingInlineStart, minW: gc.minWidth,
                       display: gc.display, ws: gc.whiteSpace }
            })
            /* The marker's own x, which is what the reader sees move: the sum of
               every group plus the hanging indent, read off the DOM instead of
               added up here. */
            const marker = l.querySelector('.nc-bullet, .nc-num')
            lines.push({
              text: l.textContent.slice(0, 60),
              cls: l.className,
              h: +box.height.toFixed(3),
              lh: lc.lineHeight,
              padT: lc.paddingTop, padB: lc.paddingBottom,
              markerX: marker ? +(marker.getBoundingClientRect().left - cbox.left).toFixed(3) : null,
              groups,
            })
          }
          /* THE REFERENCE THE WIDTHS ARE DERIVED FROM (2026-09-13). A group
             of n spaces renders n SPACE ADVANCES wide, and a space is a
             different width in every font the stack can land on (.SF NS on the
             Mac, 4.1875px; about 3.52 on the Debian box), so the test can
             only pin the claim, not the number. What it needs from the page
             is a run of n spaces laid out by the same engine, at the same
             scale, snapped the same way, in a box that is NOT the one under
             test.

             SO THE FONT IS COPIED FROM .cm-content AND NEVER FROM A GROUP.
             A reference that took a group's own letter-spacing or font-size
             would move with exactly the defect the widths exist to catch --
             mutation-tested: sourcing it from the group passes a
             letter-spacing that the real reference fails. Body-level,
             position fixed, hidden and removed before the report: nothing is
             inserted into .cm-content, where CM6's DOM observer would read it
             as typing.

             A RUN, NOT n TIMES ONE ADVANCE: Chromium snaps a box's text width
             UP to 1/64 of a DEVICE px, so n times an off-grid advance is the
             wrong number after the snap. spaceAdvance is 64 spaces over 64,
             for the failure message and the header's arithmetic only.
             NO BACKTICKS IN HERE (S0.24.10). */
          const refSrc = content
          const FONT_PROPS = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontStretch',
            'fontVariant', 'fontFeatureSettings', 'fontVariationSettings', 'fontKerning',
            'fontOpticalSizing', 'fontSynthesis', 'fontSizeAdjust', 'letterSpacing',
            'wordSpacing', 'textRendering']
          const refRun = (text) => {
            const sc = getComputedStyle(refSrc)
            const host = document.createElement('div')
            host.style.cssText = 'position:fixed;left:0;top:0;visibility:hidden;pointer-events:none;margin:0;padding:0;border:0'
            const s = document.createElement('span')
            s.style.cssText = 'display:inline-block;white-space:pre;text-indent:0;margin:0;padding:0;border:0;min-width:0'
            for (const k of FONT_PROPS) s.style[k] = sc[k]
            s.textContent = text
            host.appendChild(s)
            document.body.appendChild(host)
            const w = s.getBoundingClientRect().width
            host.remove()
            return w
          }
          const ref = {
            spaceRun: [0, 1, 2, 3, 4].map((n) => +refRun(' '.repeat(n)).toFixed(3)),
            spaceAdvance: +(refRun(' '.repeat(64)) / 64).toFixed(4),
          }
          return { dpr: window.devicePixelRatio, listIndent: getComputedStyle(content).getPropertyValue('--list-indent').trim(), ref, lines }
        })()
      `).catch((e) => ({ error: String(e && e.message) }))
      console.log('INDENT ' + JSON.stringify(out))
      app.exit(0)
    }, 2500)
  }

  /* S0.44 E90 -- THE FOLD, in the real engine.  Clicks a folder row and samples
     every animation frame: the sizer's height, the clip on the rows being
     revealed, the transform of the rows below, and the chevron's own computed
     transition and transform.  Then clicks again and samples the close.

     NOTHING BELOW A REAL ENGINE CAN SEE ANY OF THIS.  `tests/frontend`'s DOM
     shim has no `requestAnimationFrame`, no computed styles and no layout, so
     it exercises the INSTANT path by construction -- which is why every one of
     those 63 tree tests still passed when this landed.  The animation is only
     observable where there is a compositor to run it.

     NO BACKTICKS IN HERE (S0.24.10). */
  if (process.env.CAIRN_FOLD_PROBE === '1') {
    setTimeout(async () => {
      const out = await win.webContents.executeJavaScript(`
        (async () => {
          const sc = document.querySelector('.tree-scroller')
          const sz = sc && sc.querySelector('.sz')
          if (!sc || !sz) return { error: 'no tree' }
          const folder = Array.from(sc.querySelectorAll('.tr.d')).find((r) => !r.hidden)
          if (!folder) return { error: 'no folder row' }

          const num = (v) => Math.round(parseFloat(v) * 100) / 100
          const ty = (el) => {
            const m = /translateY\\(([-0-9.]+)px\\)/.exec(el.style.transform || '')
            return m ? num(m[1]) : null
          }
          /* The row BELOW the whole folder subtree is the one that must slide.
             Identified by its translateY before the click -- the first row that
             sits lower than the folder and is not revealed by the fold. */
          const rowsNow = () => Array.from(sc.querySelectorAll('.tr'))
            .filter((r) => !r.hidden && !r.classList.contains('tr-edit'))
            .map((r) => ({ t: r.textContent.trim(), y: ty(r), clip: r.style.clipPath || '' }))
            .sort((a, b) => a.y - b.y)

          const chev = () => {
            // S0.50 E98: the chevron is the row's inline svg.chev child, not a ::before
            const cs = getComputedStyle(folder.querySelector('.chev'))
            return {
              dur: cs.transitionDuration,
              fn: cs.transitionTimingFunction,
              prop: cs.transitionProperty,
              tf: cs.transform,
              ms: folder.style.getPropertyValue('--chev-ms') || '',
            }
          }
          /* A row that is NOT the toggled one must never be armed: the pool
             recycles, and an armed pool row spins its arrow on every scroll. */
          const otherChevDur = () => {
            const other = Array.from(sc.querySelectorAll('.tr.d')).find((r) => r !== folder && !r.hidden)
            return other ? getComputedStyle(other.querySelector('.chev')).transitionDuration : null
          }

          const sample = () => ({
            szH: num(sz.style.height || sz.getBoundingClientRect().height),
            rows: rowsNow(),
            chev: chev(),
          })

          const run = async (label) => {
            const frames = []
            const t0 = performance.now()
            folder.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
            frames.push({ t: 0, ...sample() })
            await new Promise((resolve) => {
              const tick = () => {
                frames.push({ t: Math.round(performance.now() - t0), ...sample() })
                if (performance.now() - t0 < 260) requestAnimationFrame(tick)
                else resolve()
              }
              requestAnimationFrame(tick)
            })
            return { label, frames }
          }

          const before = sample()
          const otherBefore = otherChevDur()
          const open = await run('open')
          await new Promise((r) => setTimeout(r, 120))
          const close = await run('close')
          await new Promise((r) => setTimeout(r, 120))
          return {
            before, otherChevDurBefore: otherBefore,
            otherChevDurDuringOpen: open.frames.length ? otherChevDur() : null,
            open, close, settled: sample(),
            // 2026-09-15 -- the test derives its own expectations from THIS,
            // never a literal: --row-h is measured by chrome.ts's applyRowH()
            // and is not 27 on every font (§0.17).  FULL precision, not
            // rounded through num() -- the settled-row check below needs an
            // exact multiple, and rounding this would make it lie.
            rowH: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--row-h')),
          }
        })()
      `).catch((e) => ({ error: String(e && e.message) }))
      console.log('FOLD ' + JSON.stringify(out))
      app.exit(0)
    }, 2500)
  }

  /* 2026-09-15 -- THE TREE'S CURSOR RING AND ITS OVERFLOW INSET, driven through
     the engine's REAL input pipeline, for tree-ring.test.mjs.  It REPORTS and
     exits; every assertion lives in the test.

     WHY sendInputEvent AND NOT dispatchEvent.  The defect only exists inside
     Chromium's input handling: a BARE SHIFT KEYDOWN flips a mouse-focused box
     to :focus-visible, and a synthetic KeyboardEvent dispatched from script
     runs the page's listeners without ever reaching that heuristic.  A probe
     built on dispatchEvent would pass against the broken selector.  So every
     click and key below goes through webContents.sendInputEvent, and the
     probe REPORTS whether the trap actually sprang (trap.focusVisible) so the
     test can refuse a run where it did not.

     The gesture is the user's: plain click R1, hold Shift, shift-click R2,
     release.  Then ArrowDown (the ring must come on), a plain click (it must
     go off), and the fill's right edge with the tree overflowing and, after a
     plain click folds the big folder, not overflowing -- read twice, from
     layout and from the captured frame.

     NO BACKTICKS IN HERE (S0.24.10). */
  if (process.env.CAIRN_TREE_RING_PROBE === '1') {
    setTimeout(async () => {
      const out = {}
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
      const wc = win.webContents
      const js = (src) => wc.executeJavaScript(src)
      try {
        await js(`
          (() => {
            const sc = () => document.querySelector('.tree-scroller')
            const rowEl = (name) => Array.from(sc().querySelectorAll('.tr'))
              .find((e) => !e.hidden && e.getClientRects().length > 0 && e.textContent.trim() === name) || null
            const R = (r) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height })
            const frames = () => new Promise((res) => {
              const t = setTimeout(() => res(false), 1500)
              requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(t); res(true) }))
            })
            window.__RING_PROBE__ = {
              ready: () => !!(sc() && rowEl('Alpha') && rowEl('Gamma')),
              row: (name) => {
                const e = rowEl(name)
                if (!e) return null
                const r = e.getBoundingClientRect()
                return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), rect: R(r) }
              },
              snap: async (names) => {
                const raf = await frames()
                const s = sc()
                const ae = document.activeElement
                const rows = {}
                for (const n of names) {
                  const e = rowEl(n)
                  if (!e) { rows[n] = null; continue }
                  const pb = getComputedStyle(e, '::before')
                  rows[n] = {
                    cls: e.className,
                    rect: R(e.getBoundingClientRect()),
                    beforeShadow: pb.boxShadow,
                    beforeLeft: pb.left,
                    beforeRight: pb.right,
                    rowShadow: getComputedStyle(e).boxShadow,
                    padRight: getComputedStyle(e).paddingRight,
                  }
                }
                const sb = document.querySelector('.sidebar')
                return {
                  raf,
                  dpr: devicePixelRatio,
                  docFocus: document.hasFocus(),
                  activeIsScroller: ae === s,
                  activeTag: ae ? ae.tagName + '.' + String(ae.className).slice(0, 40) : null,
                  focus: s.matches(':focus'),
                  focusVisible: s.matches(':focus-visible'),
                  kbdFocus: s.classList.contains('kbd-focus'),
                  overflowing: s.classList.contains('is-overflowing'),
                  scrollHeight: s.scrollHeight,
                  clientHeight: s.clientHeight,
                  cursor: Array.from(s.querySelectorAll('.tr.c')).filter((e) => !e.hidden).map((e) => e.textContent.trim()),
                  selected: Array.from(s.querySelectorAll('.tr.s')).filter((e) => !e.hidden).map((e) => e.textContent.trim()),
                  sidebar: sb ? R(sb.getBoundingClientRect()) : null,
                  scroller: R(s.getBoundingClientRect()),
                  rows,
                }
              },
              /* What chrome.ts wrote, and a FRESH measurement taken here with
                 Obsidian's own macOS declaration -- written out again rather
                 than calling chrome.ts, so the two cannot share a mistake. */
              navW: () => {
                const html = document.documentElement
                const box = document.createElement('div')
                box.style.cssText = 'position:absolute;visibility:hidden;left:0;top:0;width:100px;height:50px;overflow-y:scroll;scrollbar-color:gray transparent'
                const kid = document.createElement('div')
                kid.style.height = '200px'
                box.appendChild(kid)
                document.body.appendChild(box)
                const fresh = box.offsetWidth - box.clientWidth
                box.remove()
                return {
                  os: html.getAttribute('data-os'),
                  inline: html.style.getPropertyValue('--nav-scrollbar-w').trim(),
                  computed: getComputedStyle(html).getPropertyValue('--nav-scrollbar-w').trim(),
                  gutter: getComputedStyle(html).getPropertyValue('--scrollbar-gutter-w').trim(),
                  fresh,
                }
              },
            }
          })()
        `)
        let ready = false
        for (let i = 0; i < 80 && !ready; i++) {
          ready = await js('window.__RING_PROBE__.ready()')
          if (!ready) await sleep(125)
        }
        if (!ready) throw new Error('the tree never rendered rows Alpha and Gamma')

        /* An offscreen window is never shown and never focused, and :focus
           (so :focus-visible, so the ring) needs the PAGE focused as well as
           the element -- measured: headless with wc.focus() alone reads
           document.hasFocus() false and the trap cannot spring.  CDP's focus
           emulation is the engine's own "treat this page as focused"; the input
           events stay real.  A windowed run takes the real focus instead. */
        wc.focus()
        if (HEADLESS) {
          const dbg = wc.debugger
          if (!dbg.isAttached()) dbg.attach('1.3')
          await dbg.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
          out.focusEmulated = true
        }
        await sleep(200)

        const row = (n) => js('window.__RING_PROBE__.row(' + JSON.stringify(n) + ')')
        const snap = (names) => js('window.__RING_PROBE__.snap(' + JSON.stringify(names) + ')')
        const click = async (name, modifiers = []) => {
          const p = await row(name)
          if (!p) throw new Error('no row ' + name + ' to click')
          wc.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y, modifiers })
          await sleep(60)
          wc.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1, modifiers })
          await sleep(60)
          wc.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1, modifiers })
          await sleep(350)
        }
        /* The captured frame, as raw pixels.  Grey is grey in BGRA and RGBA
           alike, and every other comparison below is colour against colour, so
           the channel order never matters. */
        const shot = async () => {
          await sleep(150)
          const img = await wc.capturePage()
          const size = img.getSize()
          const bmp = img.toBitmap()
          const w = size.width
          const h = size.height
          const ok = bmp.length === w * h * 4
          const px = (x, y) => {
            if (!ok || x < 0 || y < 0 || x >= w || y >= h) return null
            const i = (y * w + x) * 4
            return [bmp[i], bmp[i + 1], bmp[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join('')
          }
          return { w, h, ok, px }
        }
        const near = (a, b) => a !== null && b !== null &&
          [0, 2, 4].every((k) => Math.abs(parseInt(a.slice(k, k + 2), 16) - parseInt(b.slice(k, k + 2), 16)) <= 2)
        /* The first column right of x0, on row y, whose colour leaves the
           fill's.  x0 is well inside the fill and right of the label. */
        const fillEdge = (s, y, x0) => {
          const base = s.px(x0, y)
          for (let x = x0 + 1; x < s.w; x++) if (!near(s.px(x, y), base)) return { x, inside: base, outside: s.px(x, y) }
          return null
        }
        const cols = (s, y, xs) => Object.fromEntries(xs.map((x) => [x, s.px(x, y)]))

        const R1 = 'Alpha'
        const R2 = 'Gamma'
        const NAMES = ['Alpha', 'Beta', 'Delta', 'Gamma']

        // ---- A: plain click R1, Shift down, shift-click R2, Shift up -------
        await click(R1)
        out.afterPlainClick = await snap(NAMES)
        wc.sendInputEvent({ type: 'keyDown', keyCode: 'Shift', modifiers: ['shift'] })
        await sleep(200)
        out.afterShiftDown = await snap(NAMES)
        out.trap = { focusVisible: out.afterShiftDown.focusVisible, focus: out.afterShiftDown.focus }
        await click(R2, ['shift'])
        out.afterShiftClick = await snap(NAMES)
        wc.sendInputEvent({ type: 'keyUp', keyCode: 'Shift', modifiers: [] })
        await sleep(200)
        out.afterShiftUp = await snap(NAMES)
        {
          const s = await shot()
          const a = out.afterShiftUp.rows.Alpha
          const b = out.afterShiftUp.rows.Beta
          const fl = Math.round((a.rect.left + parseFloat(a.beforeLeft)) * out.afterShiftUp.dpr)
          const ya = Math.round((a.rect.top + 12) * out.afterShiftUp.dpr)
          const yb = Math.round((b.rect.top + 12) * out.afterShiftUp.dpr)
          const xs = [0, fl - 2, fl - 1]
          out.pixA = { shotOk: s.ok, size: [s.w, s.h], xs, cursorRow: cols(s, ya, xs), controlRow: cols(s, yb, xs) }
        }

        // ---- B: ArrowDown arms the ring; a plain click disarms it ---------
        wc.sendInputEvent({ type: 'keyDown', keyCode: 'Down', modifiers: [] })
        await sleep(40)
        wc.sendInputEvent({ type: 'keyUp', keyCode: 'Down', modifiers: [] })
        await sleep(250)
        out.afterArrowDown = await snap(NAMES)
        {
          const s = await shot()
          const c = out.afterArrowDown.cursor[0]
          const r = c ? out.afterArrowDown.rows[c] : null
          if (r) {
            const d = out.afterArrowDown.dpr
            const fl = Math.round((r.rect.left + parseFloat(r.beforeLeft)) * d)
            const y = Math.round((r.rect.top + 12) * d)
            /* The TOP edge too: the two device rows above the fill, which lie
               OUTSIDE the row box (the fill is top 0) and inside the row
               above's.  Sampled at a plain column and at the indent guide's
               column (--gx0, 24 CSS px), where the row above paints its own
               background -- the two ways that edge was lost. */
            const top = Math.round(r.rect.top * d)
            const gx = Math.round(24 * d)
            const tx = fl + Math.round(60 * d)
            out.pixB = {
              row: c, xs: [fl - 2, fl - 1], ring: cols(s, y, [fl - 2, fl - 1]),
              topXs: [tx, gx],
              topEdge: { above1: cols(s, top - 1, [tx, gx]), above2: cols(s, top - 2, [tx, gx]) },
            }
          }
        }
        await click('Delta')
        out.afterPlainClick2 = await snap(NAMES)
        {
          const s = await shot()
          const d = out.afterPlainClick2.dpr
          const b = out.afterPlainClick2.rows.Beta
          const a = out.afterPlainClick2.rows.Alpha
          const fl = Math.round((b.rect.left + parseFloat(b.beforeLeft)) * d)
          out.pixB2 = {
            xs: [fl - 2, fl - 1],
            formerCursor: cols(s, Math.round((b.rect.top + 12) * d), [fl - 2, fl - 1]),
            control: cols(s, Math.round((a.rect.top + 12) * d), [fl - 2, fl - 1]),
          }
        }

        // ---- C: the fill's right edge, overflowing then not ---------------
        const edgeOf = async (label) => {
          const sn = await snap(['Delta'])
          const r = sn.rows.Delta
          const s = await shot()
          const d = sn.dpr
          const y = Math.round((r.rect.top + 12) * d)
          const x0 = Math.round((r.rect.right - 60) * d)
          out[label] = {
            snap: sn,
            nav: await js('window.__RING_PROBE__.navW()'),
            layoutFillRight: r.rect.right - parseFloat(r.beforeRight),
            pixelFillRight: fillEdge(s, y, x0),
            dpr: d,
          }
        }
        await edgeOf('overflowing')
        await click('Z')
        await sleep(400)
        await edgeOf('notOverflowing')

        // ---- D: the ring's top edge when the row ABOVE is LATER in the DOM --
        /* Rows are pooled as pool[v % poolSize], so the row visually above the
           cursor comes later in the DOM exactly when the cursor sits on slot 0
           -- and then that row's own background (the indent guide) paints over
           the ring's top 2px unless the cursor row is lifted (z-index).  Legs
           A-C never reach that slot.  Re-open Z, then ArrowDown until it is. */
        await click('Z')
        await sleep(400)
        await click('Delta')
        const wrapState = () => js(
          '(() => {' +
          ' const sz = document.querySelector(".tree-scroller .sz");' +
          ' const kids = Array.from(sz.children);' +
          ' const cur = kids.find((e) => e.classList.contains("c") && !e.hidden);' +
          ' if (!cur) return null;' +
          ' const ty = (e) => { const m = /translateY\\(([-0-9.]+)px\\)/.exec(e.style.transform || ""); return m ? parseFloat(m[1]) : NaN };' +
          ' const pitch = cur.getBoundingClientRect().height;' +
          ' const above = kids.find((e) => !e.hidden && Math.abs(ty(e) - (ty(cur) - pitch)) < 0.5);' +
          ' return { name: cur.textContent.trim(), curIdx: kids.indexOf(cur), aboveIdx: above ? kids.indexOf(above) : -1,' +
          '   curDepth: Number(cur.getAttribute("data-d")), aboveDepth: above ? Number(above.getAttribute("data-d")) : -1 };' +
          '})()')
        let wrap = null
        for (let i = 0; i < 90; i++) {
          wc.sendInputEvent({ type: 'keyDown', keyCode: 'Down', modifiers: [] })
          await sleep(30)
          wc.sendInputEvent({ type: 'keyUp', keyCode: 'Down', modifiers: [] })
          await sleep(60)
          const w = await wrapState()
          if (w && w.aboveIdx > w.curIdx && w.curDepth >= 1 && w.aboveDepth >= 1) { wrap = w; break }
        }
        out.zwrap = { found: wrap !== null, ...(wrap || {}) }
        if (wrap) {
          const sn = await snap([wrap.name])
          const r = sn.rows[wrap.name]
          const s = await shot()
          const d = sn.dpr
          const fl = Math.round((r.rect.left + parseFloat(r.beforeLeft)) * d)
          const top = Math.round(r.rect.top * d)
          const xs = [Math.round(24 * d), fl + Math.round(60 * d)]   // the guide column, a plain column
          out.zwrap.dpr = d
          out.zwrap.kbdFocus = sn.kbdFocus
          out.zwrap.beforeShadow = r.beforeShadow
          out.zwrap.xs = xs
          out.zwrap.above1 = cols(s, top - 1, xs)
          out.zwrap.above2 = cols(s, top - 2, xs)
        }
      } catch (e) {
        out.error = String(e && e.stack || e)
      }
      console.log('TREE_RING ' + JSON.stringify(out))
      app.exit(0)
    }, 1500)
  }

  /* S0.36 E83 -- the two link kinds, in the real engine.  Opens the first note
     and reports every rendered link span with the styles that decide whether it
     LOOKS like Obsidian's.  NO BACKTICKS IN HERE (S0.24.10). */
  if (process.env.CAIRN_LINK_PROBE === '1') {
    setTimeout(async () => {
      const out = await win.webContents.executeJavaScript(`
        (async () => {
          const row = document.querySelector('.tree-scroller .tr')
          if (row) {
            for (const type of ['mousedown', 'mouseup', 'click']) {
              row.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }))
            }
          }
          await new Promise((r) => setTimeout(r, 900))
          const content = document.querySelector('.cm-content')
          if (!content) return { error: 'no editor' }
          const dump = (el) => {
            const cs = getComputedStyle(el)
            return {
              cls: el.className, text: el.textContent,
              color: cs.color, decoration: cs.textDecorationLine,
              cursor: cs.cursor, wordBreak: cs.wordBreak,
            }
          }
          const links = Array.from(content.querySelectorAll('.nc-url, .nc-ilink')).map(dump)
          /* S0.38 E85 -- REAL CLICKS, and what they did.  A synthetic event is
             still the shipped handler's input: it carries the coordinates the
             handler reads, it bubbles to the contentDOM CM6 listens on, and
             nothing about the path is stubbed. */
          const errors = []
          const realError = console.error
          console.error = (...a) => { errors.push(a.map(String).join(' ')); realError(...a) }
          const clickAt = (el, mod) => {
            const r = el.getBoundingClientRect()
            el.dispatchEvent(new MouseEvent('click', {
              bubbles: true, cancelable: true, button: 0,
              clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
              ctrlKey: !!mod,
            }))
          }
          const find = (sel, text) => Array.from(content.querySelectorAll(sel))
            .find((e) => e.textContent.indexOf(text) >= 0) || null
          const settle = () => new Promise((r) => setTimeout(r, 400))

          /* (a) a PLAIN click on a bare url: Obsidian refuses one (the handler
                 wants a .cm-underline, which a bare url never gets), so this
                 must do nothing at all. */
          const plain = find('.nc-url', 'example.com/plain')
          if (plain) clickAt(plain, false)
          await settle()
          const afterPlain = errors.slice()

          /* (b) a MOD click on a url whose scheme the main process refuses.
                 It exercises the WHOLE path -- handler, target, command 22,
                 allowlist -- and launches nothing, which is why the fixture
                 uses ftp: and not http:. */
          const refused = find('.nc-url', 'example.com/refused')
          if (refused) clickAt(refused, true)
          await settle()
          const afterRefused = errors.slice()

          /* (c) a plain click on a wikilink OPENS the note, so it goes last. */
          const wiki = find('.nc-ilink', 'target note')
          const textBefore = content.textContent.slice(0, 80)
          if (wiki) clickAt(wiki, false)
          await new Promise((r) => setTimeout(r, 1200))
          console.error = realError
          const clicks = {
            hadPlain: !!plain, hadRefused: !!refused, hadWiki: !!wiki,
            afterPlain, afterRefused,
            textBefore,
            textAfter: document.querySelector('.cm-content').textContent.slice(0, 80),
            tab: (document.querySelector('.tab-label') || {}).textContent || null,
          }
          /* The rendered text of the line holding the wikilink: the brackets
             must be GONE from what the reader sees, and still in the document. */
          const wikiLine = Array.from(content.querySelectorAll('.cm-line'))
            .filter((l) => l.querySelector('.nc-ilink')).map((l) => l.textContent)
          const urlLine = Array.from(content.querySelectorAll('.cm-line'))
            .filter((l) => l.querySelector('.nc-url'))
            .map((l) => ({ text: l.textContent.slice(0, 60), rects: l.getClientRects().length }))
          return {
            accent: getComputedStyle(document.body).getPropertyValue('--text-accent').trim(),
            linkColor: getComputedStyle(document.body).getPropertyValue('--link-color').trim(),
            count: links.length, links: links.slice(0, 8), wikiLine, urlLine: urlLine.slice(0, 3),
            clicks,
          }
        })()
      `).catch((e) => ({ error: String(e && e.message) }))
      console.log('LINK_PROBE ' + JSON.stringify(out))
      app.exit(0)
    }, 2500)
  }

  /* `menu.test.mjs`'s receipt — §0.28 E68, the vault popover's dismissal set.
     It REPORTS and exits; every assertion lives in the test.

     THE USER'S GESTURE IS ALT-TAB, so the run that matters is the one where the
     window really loses focus: `win.blur()` is what a window manager does, and
     a NON-headless arm is the only place it means anything (an offscreen window
     was never focused, so it cannot be un-focused). The synthetic dispatch that
     follows is the belt: a `blur` Event dispatched on `window` invokes any
     listener that is registered whether or not the OS was involved, so that leg
     can never go green vacuously. Both are reported; the test picks.

     NO BACKTICKS IN THIS TEMPLATE LITERAL (§0.24.10). */
  if (process.env.CAIRN_MENU_PROBE === '1') {
    const mounted = () => win.webContents.executeJavaScript(
      "!!document.querySelector('.ctx-menu')")
    setTimeout(async () => {
      const out = {}
      try {
        /* A click WITH A POSITION, because §0.29 E69 places the menu at the
           pointer: `detail: 1` is what tells the handler this was a real mouse
           click and not a keyboard activation of the same button. The point is
           inside the bar's own box so the gesture is one a user could make. */
        out.placed = await win.webContents.executeJavaScript(`
          (async () => {
            const b = document.querySelector('.vault-switch')
            if (!b) return 'no .vault-switch'
            const r = b.getBoundingClientRect()
            const at = { x: Math.round(r.left + 20), y: Math.round(r.top + 8) }
            for (const t of ['mousedown', 'mouseup', 'click']) {
              b.dispatchEvent(new MouseEvent(t, {
                bubbles: true, cancelable: true, button: 0, detail: 1,
                clientX: at.x, clientY: at.y,
              }))
            }
            await new Promise((r2) => setTimeout(r2, 400))
            const m = document.querySelector('.ctx-menu')
            if (!m) return { at, rows: 0 }
            const mr = m.getBoundingClientRect()
            return {
              at,
              rows: m.querySelectorAll('.ctx-item').length,
              menu: { left: +mr.left.toFixed(3), top: +mr.top.toFixed(3),
                      right: +mr.right.toFixed(3), bottom: +mr.bottom.toFixed(3) },
              /* placeMenu does its arithmetic on offsetHeight, which is an
                 INTEGER, while the rect's height is not at a fractional scale --
                 so top is exact against the first and bottom is within a device
                 pixel of the second. Obsidian measures the same way.
                 NO BACKTICKS IN HERE (S0.24.10): one ends this template literal
                 and the launch hangs with no output. This comment was written
                 with them once and shell-syntax.test.mjs caught it. */
              offset: { w: m.offsetWidth, h: m.offsetHeight },
              dpr: devicePixelRatio,
              viewport: { w: document.body.clientWidth, h: document.body.clientHeight },
            }
          })()
        `)
        out.opened = out.placed && out.placed.rows
        /* A REAL focus change, not `win.blur()`. On Wayland a client cannot
           hand its own focus away — `win.blur()` returns and `isFocused()` is
           still true — so the honest way to un-focus this window is to give the
           compositor another one to focus, which is what Alt-Tab does. The
           probe REPORTS `focusedAfter` either way: a run where the compositor
           refused is a run where this leg proved nothing, and it has to say so
           rather than pass quietly. */
        /* S0.30 E70 -- the `Close` button. It is HOVER-REVEALED and absolutely
           positioned, so the resting popover keeps the box S0.27 E67 pinned;
           this reports both halves, because "it exists in the DOM" is not the
           claim -- "it appears when you point at the row, and costs nothing when
           you do not" is. */
        out.closeBtn = await win.webContents.executeJavaScript(`
          (() => {
            const m = document.querySelector('.ctx-menu')
            if (!m) return 'no menu'
            const rows = m.querySelectorAll('.ctx-item')
            const widthAtRest = m.getBoundingClientRect().width
            const btns = m.querySelectorAll('.ctx-row-btn')
            if (btns.length === 0) return { rows: rows.length, btns: 0 }
            const b = btns[0]
            const row = b.closest('.ctx-item')
            const hidden = getComputedStyle(b).display
            row.classList.add('is-active')
            const shown = getComputedStyle(b).display
            const br = b.getBoundingClientRect(), rr = row.getBoundingClientRect()
            row.classList.remove('is-active')
            return {
              rows: rows.length, btns: btns.length,
              hidden, shown,
              widthAtRest, widthWhenShown: m.getBoundingClientRect().width,
              rightInset: +(rr.right - br.right).toFixed(3),
              size: [+br.width.toFixed(3), +br.height.toFixed(3)],
              onOpenRow: !!m.querySelector('.ctx-item.mod-checked .ctx-row-btn'),
            }
          })()
        `)
        out.focusedBefore = win.isFocused()
        const thief = new BrowserWindow({ width: 200, height: 120, show: false })
        await thief.loadURL('data:text/html,<title>focus thief</title>')
        thief.show()
        thief.focus()
        await new Promise((r) => setTimeout(r, 600))
        out.focusedAfter = win.isFocused()
        out.afterRealBlur = await mounted()
        thief.destroy()
        out.afterSyntheticBlur = await win.webContents.executeJavaScript(`
          (async () => {
            window.dispatchEvent(new Event('blur'))
            window.dispatchEvent(new Event('resize'))
            document.querySelector('.tree-scroller').dispatchEvent(new Event('scroll', { bubbles: true }))
            await new Promise((r) => setTimeout(r, 100))
            return !!document.querySelector('.ctx-menu')
          })()
        `)
        /* …and it STILL closes on the two things Obsidian closes on. */
        out.afterOutsideClick = await win.webContents.executeJavaScript(`
          (async () => {
            for (const t of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
              document.body.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, button: 0 }))
            }
            await new Promise((r) => setTimeout(r, 100))
            return !!document.querySelector('.ctx-menu')
          })()
        `)
      } catch (e) {
        out.error = String(e && e.message)
      }
      console.log('MENU_PROBE ' + JSON.stringify(out))
      app.exit(0)
    }, 2500)
  }

  if (PIXELTEST) {
    win.webContents.on('dom-ready', () => { void injectProbe() })

    /* THE SAFETY PROPERTY THAT MATTERS MOST HERE.
       Every failure mode of this path -- the frontend never calling
       `open_vault`, `nc://vault-opened` never arriving, `runGeometryProbe`
       returning early, the window failing to map -- is SILENT, and its silence
       looks exactly like a run still in progress. Without this the harness
       either hangs forever or, worse, is killed by a caller that then reports
       whatever exit code the kill produced.
       A gate that cannot reach a verdict must FAIL, and it must say why. */
    const budgetMs = 30000
    setTimeout(() => {
      console.log(JSON.stringify({
        ok: false, rows: 0, checks: 0, pass: 0, fail: 1, skip: 0,
        error: `no geometry-report within ${budgetMs} ms — the probe never reached a verdict`,
        probeInjected,
      }))
      app.exit(1)
    }, budgetMs).unref()
  }

  await win.loadFile(join(HERE, 'app', 'index.html'))

  /* ── GATE G10's CAPTURE (§8.4) ─────────────────────────────────────────
     `CAIRN_CAPTURE=<path>` writes one PNG of the rendered page and exits.
     `CAIRN_CAPTURE_DPR` chooses the scale (default 1); `CAIRN_CAPTURE_EVAL`
     runs JS in the page and reports its value beside the picture.

     THROUGH THE DEVTOOLS PROTOCOL, NOT THROUGH THE COMPOSITOR, and §8.4 says
     why that is the whole reason G10 became possible: CONTRACT §5.11 records
     the macOS pixel diff as STRUCK because `screencapture` is TCC-blocked, so
     no run could take a picture of itself. `Page.captureScreenshot` asks the
     renderer, not the window server, and needs no permission from anybody.

     `Emulation.setDeviceMetricsOverride` with `deviceScaleFactor: 1` is the
     other half, and it is the thing `--force-device-scale-factor=1` could NOT
     do: that switch is a client hint the Wayland compositor overrides through
     `wp_fractional_scale` (§0.19.1, measured three runs per arm). Emulation is
     applied inside the renderer, below the compositor, so a 1.25 desktop can
     still produce a 1x capture -- which the reference is.

     Inert unless asked for, and it REPORTS rather than asserting. */
  if (process.env.CAIRN_CAPTURE) {
    await new Promise((r) => setTimeout(r, Number(process.env.CAIRN_CAPTURE_SETTLE ?? 2000)))
    const dbg = win.webContents.debugger
    const report = { path: process.env.CAIRN_CAPTURE }
    try {
      if (!dbg.isAttached()) dbg.attach('1.3')
      const { width, height } = geometry()
      /* `CAIRN_CAPTURE_DPR` defaults to 1, which is G10's reference scale and
         the only scale this block could take until S0.52 E100. A capture at 1
         CANNOT SEE A DEFECT THAT ONLY EXISTS AT A FRACTIONAL SCALE, and E100's
         is exactly that: Chromium snaps a painted box to whole device pixels,
         so a pane whose left edge is a whole number of device pixels at dpr 1
         has nothing to snap. S0.26.2 E66 met the same wall from the other side
         and forced `--force-device-scale-factor=1.25` on its regression test.
         ~~Emulation is the better lever here~~ -- EMULATION ALONE IS NOT A
         SCALE, measured on macOS 2026-09-13 (CONTRACT S0.53 E104, and the table
         in electron-shell/pane-paint.test.mjs's header). On a dpr-1 host,
         emulating 1.25 sets devicePixelRatio to 1.25 but Chromium does not
         rasterise at that scale: a 1.2px box lays out as 1.1875 (the HOST's
         grid), and `contain: paint` against `none` differs in 0 of 2,892,000 px.
         So a capture at a scale the host does not really have must ALSO launch
         with the real `--force-device-scale-factor`, which pane-paint.test.mjs
         now does. Where the two agree -- G10's dpr-1 captures on a dpr-1 host,
         or 1.25 on a 1.25 desktop -- emulation and the real scale are the same
         thing. Only the upward direction was measured; E37's 1x capture on a
         1.25 desktop was not re-measured. S0.19.1's reason still holds for what
         it measured: on Wayland that switch is a client hint the compositor can
         override, and this is applied inside the renderer, below it. */
      const captureDpr = Number(process.env.CAIRN_CAPTURE_DPR ?? 1)
      await dbg.sendCommand('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: captureDpr,
        mobile: false,
      })
      /* `CAIRN_CAPTURE_EVAL` runs in the page AFTER the scale is applied and
         lands in the report as `eval`. It exists so a pixel assertion can carry
         the LAYOUT numbers it is meant to be checked against, from the same
         frame -- a painted column compared with a layout position measured in a
         different run is a comparison of two runs. */
      if (process.env.CAIRN_CAPTURE_EVAL) {
        report.eval = await win.webContents
          .executeJavaScript(process.env.CAIRN_CAPTURE_EVAL)
          .catch((e) => ({ error: String(e && e.message) }))
      }
      const shot = await dbg.sendCommand('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: false,
      })
      const png = Buffer.from(shot.data, 'base64')
      writeFileSync(process.env.CAIRN_CAPTURE, png)
      Object.assign(report, {
        ok: true,
        bytes: png.length,
        asked: `${width}x${height}`,
        // What the PAGE thinks it is, after the override -- so a capture that
        // silently came out at 1.25x is visible in the report rather than in a
        // diff nobody can explain.
        dpr: await win.webContents.executeJavaScript('window.devicePixelRatio'),
        inner: await win.webContents.executeJavaScript(
          '`${window.innerWidth}x${window.innerHeight}`'
        ),
      })
    } catch (e) {
      Object.assign(report, { ok: false, error: String(e && e.message) })
    }
    console.log('CAPTURE ' + JSON.stringify(report))
    app.exit(report.ok ? 0 : 1)
    return
  }

  /* §8.2 step 7's done-when: "✕, ⌘Q/Ctrl-Q and a write-denied parent all flush
     through the SAME function". This is the ⌘Q leg. `app.quit()` is what ⌘Q
     raises on macOS and what a menu Quit raises on either platform; MEASURED,
     it reaches `win.on('close')` and therefore `app::begin_close`, so the quit
     is PREVENTED and the flush runs before anything exits. Inert unless asked
     for, and it REPORTS rather than asserting -- the assertions are the test's. */
  if (QUIT_PROBE) {
    await new Promise((r) => setTimeout(r, 1500))
    app.quit()
    setTimeout(() => {
      // Reached only if the quit never came back through the handshake, which
      // is the failure this reports rather than hangs on.
      reportClose(false)
      app.exit(1)
    }, 6000).unref?.()
    return
  }

  /* §5.4.4's live preview end to end, for `live-preview.test.mjs`. Inert unless
     asked for, and it REPORTS rather than asserting.

     WHY A CHILD PROCESS, when `livepreview.test.mjs` already tests the
     decorator with no DOM: because the decorator is not the thing that can be
     wrong here. Everything below the widget was already covered — what is not
     is whether a real `mousedown` on a real `<input>` inside a real
     `contenteditable` reaches `view.posAtDOM`, produces a `changes`, survives
     `ignoreEvent`, and comes back as a REBUILT widget with the other state. A
     unit test on either end passes throughout, which is exactly the shape §0.5
     E7's seam bug had. The probe adds nothing to the path: the event is real,
     the handler is the shipped one, and what it reads back is the DOM. */
  if (process.env.CAIRN_LP_PROBE === '1') {
    const settle = (ms) => new Promise((r) => setTimeout(r, ms))
    await settle(1500)
    /* TWO rAFs before every read, not a bare settle. Reading `textContent`
       mid-update is not deterministic: the first attempt at this probe saw
       ` an open task` after the click and `an open task` before it, in the same
       run, purely because the initial render had not finished placing the text
       node after the widget. Waiting for a presented frame removes the race
       instead of letting the assertion absorb it. */
    const read = () => win.webContents.executeJavaScript(`
      new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done((() => {
        const box = document.querySelector('.nc-task input')
        const line = box && box.closest('.cm-line')
        /* THE FONT REFERENCES (2026-09-13) -- a box laid out by this engine at
           this scale, in the computed font of refSrc, and NOT the element under
           test. Two assertions below depend on the font the stack lands on
           and so cannot be literals: the continuation span is two SPACE
           ADVANCES plus 16px, and the th's min-width is 6ch of its own face.
           The span's reference font comes from .cm-content, never from the
           span: a reference that copied the span's letter-spacing would move
           with the defect and the assertion could not fail (the same rule and
           the same mutation as CAIRN_INDENT_PROBE's). The th's comes from the
           th, because 6ch is defined against the th's own font -- what is under
           test there is the min-width, not the face. Body-level, hidden,
           removed before the report; nothing enters .cm-content, where CM6's
           DOM observer would read it as typing.
           NO BACKTICKS IN HERE (S0.24.10). */
        const FONT_PROPS = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontStretch',
          'fontVariant', 'fontFeatureSettings', 'fontVariationSettings', 'fontKerning',
          'fontOpticalSizing', 'fontSynthesis', 'fontSizeAdjust', 'letterSpacing',
          'wordSpacing', 'textRendering']
        const refBox = (refSrc, css, text) => {
          const sc = getComputedStyle(refSrc)
          const host = document.createElement('div')
          host.style.cssText = 'position:fixed;left:0;top:0;visibility:hidden;pointer-events:none;margin:0;padding:0;border:0'
          const s = document.createElement('span')
          s.style.cssText = 'display:inline-block;white-space:pre;text-indent:0;margin:0;padding:0;border:0;min-width:0;' + css
          for (const k of FONT_PROPS) s.style[k] = sc[k]
          s.textContent = text
          host.appendChild(s)
          document.body.appendChild(host)
          const out = { w: s.getBoundingClientRect().width, minWidth: getComputedStyle(s).minWidth }
          host.remove()
          return out
        }
        return {
          tasks: document.querySelectorAll('.nc-task input').length,
          dataTask: box ? box.getAttribute('data-task') : null,
          checked: box ? box.checked : null,
          /* app.css:14147 -- a TICKED task line is struck through and muted.
             Read as COMPUTED style off the real line, never as the presence of
             a rule: this project has now shipped four declarations that were
             correct, present and outranked (S0.45 E93's caret is the clearest),
             and both of these tokens sat in tokens.css with nothing consuming
             them.  Every task line in the fixture is reported with its own
             state, so an OPEN line that started getting struck arrives here as
             a wrong row rather than as silence.
             NO BACKTICKS IN HERE (S0.24.10). */
          taskLines: Array.from(document.querySelectorAll('.cm-content .nc-li')).filter(
            (e) => e.querySelector('.nc-task')
          ).map((e) => {
            const cs9 = getComputedStyle(e)
            const inp = e.querySelector('.nc-task input')
            return { cls: e.className, checked: inp ? inp.checked : null,
                     decoration: cs9.textDecorationLine, color: cs9.color,
                     text: e.textContent }
          }),
          bullets: document.querySelectorAll('.nc-bullet').length,
          strong: document.querySelectorAll('.nc-strong').length,
          quoteRules: document.querySelectorAll('.nc-quote').length,
          rules: document.querySelectorAll('.nc-hr-rule').length,
          /* S0.35 E81 + S0.51 E99 -- EVERY leading-indent group in the
             document, with its own class.  It reports all of them, not just the
             padded one, so a nested ITEM that wrongly took a continuation's 1em
             arrives here as an extra row rather than as silence.
             NO BACKTICKS IN HERE (S0.24.10). */
          contIndents: Array.from(document.querySelectorAll('.cm-content .nc-indent, .cm-content .nc-indent-sp')).map((e) => {
            const cs6 = getComputedStyle(e)
            const line = e.closest('.cm-line'), lc = getComputedStyle(line)
            return { w: +e.getBoundingClientRect().width.toFixed(3),
                     cls: e.className,
                     pad: cs6.paddingInlineStart, display: cs6.display,
                     ws: cs6.whiteSpace, text: JSON.stringify(e.textContent),
                     lineCls: line.className,
                     linePadTop: lc.paddingTop, linePadBottom: lc.paddingBottom }
          }),
          /* The reference runs for contIndents' width: n spaces in
             .cm-content's font, snapped by this engine at this scale. See
             FONT_PROPS above for why the source is .cm-content. */
          fontRef: (() => {
            const refSrc = document.querySelector('.cm-content')
            if (!refSrc) return null
            return {
              dpr: window.devicePixelRatio,
              spaceRun: [0, 1, 2, 3, 4].map((n) => +refBox(refSrc, '', ' '.repeat(n)).w.toFixed(3)),
              spaceAdvance: +(refBox(refSrc, '', ' '.repeat(64)).w / 64).toFixed(4),
            }
          })(),
          /* S0.36 E83 -- the two link kinds, styled by the REAL sheet.  What a
             unit test cannot see: whether the marks survived the engine, and
             whether the brackets are gone from what a reader sees.  NO
             BACKTICKS IN HERE (S0.24.10). */
          links: Array.from(document.querySelectorAll('.cm-content .nc-url, .cm-content .nc-ilink'))
            .map((e) => {
              const c8 = getComputedStyle(e)
              return { cls: e.className, text: e.textContent, color: c8.color,
                       decoration: c8.textDecorationLine, cursor: c8.cursor,
                       wordBreak: c8.wordBreak,
                       lineText: e.closest('.cm-line').textContent }
            }),
          /* The ITEM line, for contrast: it keeps --list-spacing on BOTH sides. */
          itemLinePad: (() => {
            const l = document.querySelector('.cm-content .cm-line.nc-li:not(.nc-li-cont)')
            if (!l) return null
            const c7 = getComputedStyle(l)
            return { top: c7.paddingTop, bottom: c7.paddingBottom }
          })(),
          /* S0.31 E75 -- the hanging indent on a list line, per line, with the
             prefix that earned it. A token could not produce these: three list
             kinds, three different measured offsets. */
          indents: Array.from(document.querySelectorAll('.cm-content .cm-line')).map((e) => {
            const c4 = getComputedStyle(e)
            return { li: e.classList.contains('nc-li'), text: e.textContent.slice(0, 20),
                     textIndent: c4.textIndent, paddingInlineStart: c4.paddingInlineStart }
          }),
          /* S0.30 E73 -- the space ABOVE a heading, which Cairn had none of.
             Reported as computed padding AND as box tops, because the ruling is
             about a BOX: the user compared ink bands, which is the right way to
             see it and the wrong way to assert it (an ink band also moves when a
             font falls back). */
          /* S0.31.6 E76 -- the bullet's own box and its dot. text-indent
             INHERITS, and E75's negative indent on the line collapsed this
             inline-flex span to its padding until the companion rule landed.
             NO BACKTICKS IN HERE (S0.24.10); this is the THIRD time in one
             session that a quoted identifier in one of these comments ended the
             template literal and turned every launch into a silent 120s hang. */
          bullet: (() => {
            const b = document.querySelector('.cm-content .cm-line .nc-bullet')
            if (!b) return null
            const line = b.closest('.cm-line')
            const lr = line.getBoundingClientRect(), br = b.getBoundingClientRect()
            const af = getComputedStyle(b, '::after')
            const rg = document.createRange(); rg.selectNodeContents(b)
            return { x: +(br.left - lr.left).toFixed(3), w: +br.width.toFixed(3),
                     content: +rg.getBoundingClientRect().width.toFixed(3),
                     dotLeft: af.left, dotWidth: af.width,
                     textIndent: getComputedStyle(b).textIndent,
                     lineTextIndent: getComputedStyle(line).textIndent }
          })(),
          headings: Array.from(document.querySelectorAll('.cm-content .cm-line.nc-h')).map((el) => {
            const cs = getComputedStyle(el)
            const r = el.getBoundingClientRect()
            const prev = el.previousElementSibling
            return {
              cls: el.className,
              text: el.textContent,
              padTop: cs.paddingTop,
              padBottom: cs.paddingBottom,
              top: +r.top.toFixed(4),
              /* the blank-line case: Obsidian gives a heading separated from the
                 heading above it by exactly one empty line NO top padding. */
              afterBlank: !!(prev && prev.classList.contains('cm-line') &&
                             prev.childElementCount === 1 &&
                             prev.firstElementChild.tagName === 'BR'),
            }
          }),
          props: Array.from(document.querySelectorAll('.metadata-property')).map((el) => ({
            // .value, not textContent: it is an input since the block became
            // editable, and an input's textContent is always empty.
            key: el.querySelector('.metadata-property-key-input').value,
            icon: (el.querySelector('.metadata-property-icon svg path') || {}).outerHTML || null,
            value: el.querySelector('.metadata-property-value').textContent,
            unknown: !!el.querySelector('.mod-unknown'),
          })),
          propsTitle: (document.querySelector('.metadata-properties-title') || {}).textContent || null,
          metrics: (() => {
            const span = document.querySelector('.metadata-property-icon')
            if (!span) return null
            const svg = span.querySelector('svg')
            const keyBox = span.parentElement
            const input = keyBox ? keyBox.querySelector('input') : null
            const cs = getComputedStyle(span)
            const bs = getComputedStyle(span, '::before')
            const R = (e) => { const r = e.getBoundingClientRect(); return [+r.width.toFixed(2), +r.height.toFixed(2)] }
            const X = (e) => +e.getBoundingClientRect().left.toFixed(2)
            const content = document.querySelector('.cm-content')
            const line = document.querySelector('.cm-line')
            return {
              span: R(span),
              spanMinWidth: cs.minWidth, spanFlex: cs.flex, spanShrink: cs.flexShrink,
              before: bs.width,
              svg: svg ? R(svg) : null,
              svgAttr: svg ? [svg.getAttribute('width'), svg.getAttribute('stroke-width')] : null,
              svgCss: svg ? getComputedStyle(svg).width : null,
              keyBox: keyBox ? R(keyBox) : null,
              input: input ? R(input) : null,
              inputFlex: input ? getComputedStyle(input).flex : null,
              inputMinWidth: input ? getComputedStyle(input).minWidth : null,
              // Absolute lefts, so the glyph's origin can be checked against the
              // TEXT COLUMN rather than against another box that might have
              // moved with it.
              xSpan: X(span), xSvg: svg ? X(svg) : null,
              xContent: content ? X(content) : null,
              xLine: line ? X(line) : null,
              xTitle: (() => { const t = document.querySelector('.nc-title'); return t ? X(t) : null })(),
              // Every font-size down the value chain, so a compounding em is
              // visible as a number rather than as "it looks smaller".
              // (NO BACKTICKS: this is inside a template literal.)
              fs: (() => {
                const pick = (sel) => { const e = document.querySelector(sel); return e ? getComputedStyle(e).fontSize : null }
                return {
                  container: pick('.metadata-container'),
                  key: pick('.metadata-property-key'),
                  keyInput: pick('.metadata-property-key-input'),
                  value: pick('.metadata-property-value'),
                  longtext: pick('.metadata-input-longtext'),
                  unknown: pick('.mod-unknown'),
                }
              })(),
            }
          })(),
          iconColour: (() => {
            const g = document.querySelector('.metadata-property-icon')
            return g ? getComputedStyle(g).color : null
          })(),
          addButton: !!document.querySelector('.metadata-add-button'),
          fold: (() => {
            const el = document.querySelector('.metadata-properties-heading .collapse-indicator')
            if (!el) return null
            const svg = el.querySelector('svg')
            const cs = getComputedStyle(el)
            const ss = svg ? getComputedStyle(svg) : {}
            const row = document.querySelector('.metadata-property')
            return {
              opacity: cs.opacity,
              colour: ss.color || null,
              transform: ss.transform || null,
              w: svg ? svg.getAttribute('width') : null,
              stroke: svg ? svg.getAttribute('stroke-width') : null,
              collapsedOn: [
                document.querySelector('.metadata-container').classList.contains('is-collapsed'),
                document.querySelector('.metadata-properties-heading').classList.contains('is-collapsed'),
                el.classList.contains('is-collapsed'),
              ],
              rowShown: !!(row && row.getClientRects().length),
              propIconW: (() => {
                const g = document.querySelector('.metadata-property-icon svg')
                return g ? g.getAttribute('width') : null
              })(),
            }
          })(),
          firstLines: Array.from(document.querySelectorAll('.cm-line')).slice(0, 2).map((e) => e.textContent),
          /* S0.40 E87 -- the table WIDGET, and the style it is dressed in.  A
             block decoration CM6 refuses fails at RENDER time, not at build
             time, so its presence in the document is the receipt.  NO
             BACKTICKS IN HERE (S0.24.10). */
          tables: Array.from(document.querySelectorAll('.cm-content .nc-table')).map((t) => {
            const th = t.querySelector('th')
            const cs9 = getComputedStyle(th), ts = getComputedStyle(t)
            return {
              headers: Array.from(t.querySelectorAll('th')).map((e) => e.textContent),
              cells: Array.from(t.querySelectorAll('tbody td')).map((e) => e.textContent),
              code: t.querySelectorAll('.nc-code').length,
              align: Array.from(t.querySelectorAll('th')).map((e) => getComputedStyle(e).textAlign),
              collapse: ts.borderCollapse, lineHeight: ts.lineHeight,
              marginTop: ts.marginTop, marginBottom: ts.marginBottom,
              thPad: cs9.padding, thBorderW: parseFloat(cs9.borderTopWidth),
              thBorderColor: cs9.borderTopColor, dpr: window.devicePixelRatio,
              thWeight: cs9.fontWeight, thWhiteSpace: cs9.whiteSpace,
              thMinWidth: cs9.minWidth, thVerticalAlign: cs9.verticalAlign,
              /* ONE ch of the th's own face, RESOLVED -- a computed min-width
                 of 1ch, not a 0 glyph laid out as text.  In this engine the
                 resolved ch is not the 0 glyph's advance: on the Mac, ch is
                 10.6614 against a canvas advance of 10.3516, 0.30px apart
                 BEFORE any box exists or snaps (the box adds only 0.008). */
              thCh: refBox(th, 'min-width:1ch', '').minWidth,
              rawPipes: t.closest('.cm-content').textContent.indexOf('|---|') >= 0,
            }
          }),
          lineText: line ? line.textContent : null,
        }
      })()))))
    `)
    const before = await read()

    /* PHASE 1b -- DOES A CLICK LAND WHERE THE POINTER IS?
     *
     * CM6 picks the block for a coordinate out of its HEIGHT MAP
     * (`posAtCoords` -> `elementAtHeight`), and it fills that map with
     * `child.dom.getBoundingClientRect().height` -- a BORDER BOX, which
     * excludes margins.  So any CSS margin inside `.cm-content` is real to the
     * layout and invisible to CM6, the map runs short by exactly that margin,
     * and every click below it resolves to a position further down the
     * document than the pixel the user pointed at.
     *
     * Reported by the user 2026-09-10 ("I clicked, the caret jumps down 2
     * lines"), and the 2 lines were arithmetic: the inline title's 12.944px
     * plus the Properties block's 2rem, both `margin-block-end`, both
     * transcribed from Obsidian -- which pays no price for them because its
     * `.inline-title` and `.metadata-container` are siblings of
     * `.cm-contentContainer` inside `.cm-sizer` and CM6 never measures them.
     * Cairn draws both as block widgets INSIDE `.cm-content` (§5.4.2 X18), so
     * every heading margin cost another 9-10px on top.
     *
     * The comparison is CM6's answer against the ENGINE's own hit test at the
     * same point.  `caretRangeFromPoint` knows nothing about height maps: it
     * reads the boxes that were actually laid out, which is what the user
     * pointed at.  A drift of ONE pixel fails this, long before it is visible.
     * (NO BACKTICKS IN HERE -- this comment is inside a template literal.) */
    const hit = await win.webContents.executeJavaScript(`
      (() => {
        const content = document.querySelector('.cm-content')
        const view = window.__CM_VIEW__
        if (!content || !view) return { error: 'no view' }
        const scroller = document.querySelector('.cm-scroller')
        const sb = scroller.getBoundingClientRect()
        const points = []
        // SAMPLE THE MIDDLE OF EVERY VISIBLE PIECE OF TEXT, not a blind grid.
        // A grid also lands in the gaps BETWEEN blocks -- a heading's trailing
        // padding, a code block's radius -- where the two hit tests disagree by
        // convention rather than by error: CM6 gives the gap to the block that
        // owns it and the engine's caret hit test prefers the nearest text.
        // Neither is wrong and neither is what this measures.  A rect from a
        // Range over a text node is text, and only text.
        for (const line of document.querySelectorAll('.cm-line')) {
          const walk = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
          let node
          while ((node = walk.nextNode())) {
            const r = document.createRange()
            r.selectNodeContents(node)
            for (const b of r.getClientRects()) {
              if (b.width < 8 || b.height < 4) continue
              if (b.top < sb.top + 2 || b.bottom > sb.bottom - 2) continue
              const x = b.left + Math.min(30, b.width / 2)
              const y = (b.top + b.bottom) / 2
              const hitRange = document.caretRangeFromPoint(x, y)
              if (!hitRange) continue
              const n = hitRange.startContainer
              const host = n.nodeType === 1 ? n : n.parentElement
              if (!host || !host.closest('.cm-line')) continue
              let dom = null
              try { dom = view.posAtDOM(n, hitRange.startOffset) } catch (e) { continue }
              const cm = view.posAtCoords({ x: x, y: y })
              if (typeof cm !== 'number' || typeof dom !== 'number') continue
              points.push({ y: Math.round(y - sb.top), dom: dom, cm: cm, t: node.data.slice(0, 16) })
            }
          }
        }
        return {
          points: points,
          mismatches: points.filter(function (p) { return p.dom !== p.cm }),
          docHeight: view.viewState.docHeight,
          // The two block widgets must be INSIDE the flow-root box, or their
          // Obsidian margins collapse straight out of the element CM6 measures.
          wrapped: {
            title: (function () { const t = document.querySelector('.nc-title'); return t && t.parentElement ? t.parentElement.className : null })(),
            metadata: (function () { const m = document.querySelector('.metadata-container'); return m && m.parentElement ? m.parentElement.className : null })(),
          },
          // The laid-out height of everything CM6 put in the content box,
          // margins included -- what the map is supposed to equal.
          laidOut: (function () {
            const kids = content.children
            if (!kids.length) return null
            const first = kids[0].getBoundingClientRect()
            const last = kids[kids.length - 1].getBoundingClientRect()
            return +(last.bottom - first.top).toFixed(4)
          })(),
        }
      })()
    `)

    await win.webContents.executeJavaScript(`
      (() => {
        const box = document.querySelector('.nc-task input')
        if (!box) return false
        box.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }))
        return true
      })()
    `)
    await settle(400)
    const after = await read()
    // Phase three: fold the Properties block, and CATCH IT IN FLIGHT.
    //
    // Two things are being measured and only one of them survives to the
    // settled state.  The arrow is only its true colour while collapsed
    // (app.css:7285), so a probe that never folds measures the half that was
    // already right; and the fold ANIMATION exists only between the click and
    // 100ms later, so a probe that only reads the end state cannot tell a
    // transition from a class flip.  The mid-flight sample is what distinguishes
    // them, and it is the whole reason this phase is not one settle.
    //
    // The click and the first sample are ONE evaluation, so the 4ms of IPC
    // between them cannot eat the window.  NO BACKTICKS IN HERE -- this comment
    // is inside a template literal, and a stray one ends the string and takes
    // the whole main process down at load.
    const flight = await win.webContents.executeJavaScript(`
      (async () => {
        const h = document.querySelector('.metadata-properties-heading')
        const c = document.querySelector('.metadata-content')
        if (!h || !c) return null
        const rest = c.getBoundingClientRect().height
        for (const t of ['mousedown', 'mouseup', 'click']) {
          h.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, button: 0 }))
        }
        await new Promise((r) => setTimeout(r, 40))
        const cs = getComputedStyle(c)
        return {
          rest,
          // The COMPUTED transition, not the inline one.  base.css:51's blanket
          // kill is a stylesheet !important and outranks a normal inline style,
          // so the inline value read back perfectly while the computed one was
          // 0s -- reading the wrong one is what hid the defect.
          inline: c.getAttribute('style') || '',
          mid: c.getBoundingClientRect().height,
          duration: cs.transitionDuration,
          easing: cs.transitionTimingFunction,
          property: cs.transitionProperty,
          overflowY: cs.overflowY,
          display: cs.display,
        }
      })()
    `)
    // 100ms of transition + the 50ms watchdog + slack.
    await settle(600)
    const settled = await win.webContents.executeJavaScript(`
      (() => {
        const c = document.querySelector('.metadata-content')
        if (!c) return null
        const cs = getComputedStyle(c)
        return {
          display: cs.display,
          height: c.getBoundingClientRect().height,
          // Every inline style the animation set must be gone again, or the
          // next expand measures a wrapper that is already pinned to 0.
          inline: c.getAttribute('style') || '',
        }
      })()
    `)
    const collapsed = await read()

    /* Phases four onward: §5.4.5's EDITING, which writes to the note.  Every
       one reports the whole document, because the assertion that matters is not
       "the value changed" but "NOTHING ELSE DID" -- a one-line writer is only a
       one-line writer if the other lines are byte-identical afterwards.
       The CM6 view is reached by the same walk `verify-geometry.js` falls back
       to (`.cm-content.cmView.rootView.view`), so no `__PIXELTEST__` hook is
       needed. */
    const edit = await win.webContents.executeJavaScript(`
      (async () => {
        const step = (ms) => new Promise((r) => setTimeout(r, ms))
        // window.__CM_VIEW__ is the ONLY route to the view.  CM6 6.43 attaches
        // no cmView property to any DOM node, so the walk verify-geometry.js
        // advertised as a fallback could never have run; this probe therefore
        // requires CAIRN_PIXELTEST=1, which is what installs the hook.
        // (NO BACKTICKS IN HERE -- this comment is inside a template literal.)
        const view = () => window.__CM_VIEW__ || null
        const doc = () => { const v = view(); return v ? v.state.doc.toString() : null }
        const key = (el, k) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
        const clickOn = (el) => {
          for (const t of ['mousedown', 'mouseup', 'click']) {
            el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, button: 0 }))
          }
        }
        const out = { start: doc() }

        // Unfold again, so the rows are on screen to edit.
        clickOn(document.querySelector('.metadata-properties-heading'))
        await step(250)

        // P4 -- the button adds a ROW and writes NOTHING.
        const add = document.querySelector('.metadata-add-button')
        out.hasAdd = !!add
        out.addLabel = add ? add.textContent : null
        out.addIcon = !!(add && add.querySelector('svg'))
        if (add) clickOn(add)
        await step(120)
        out.rowsAfterAdd = document.querySelectorAll('.metadata-property').length
        out.docAfterAdd = doc()
        out.focusedAfterAdd = document.activeElement ? document.activeElement.className : null

        // P4b -- the glyph of a NAMELESS row is dimmed (app.css:12432).  Read
        // the COMPUTED opacity, not the attribute alone: the attribute is only
        // a claim about the DOM and the dimming is the claim about the pixels.
        const lastIcon = () => {
          const rows = document.querySelectorAll('.metadata-property')
          const last = rows[rows.length - 1]
          return last ? last.querySelector('.metadata-property-icon') : null
        }
        const iconState = (ic) => (ic
          ? { aria: ic.getAttribute('aria-disabled'), opacity: getComputedStyle(ic).opacity }
          : null)
        out.iconOnNamelessRow = iconState(lastIcon())

        // P5 -- naming it is what writes.
        const fresh = document.querySelectorAll('.metadata-property-key-input')
        const box = fresh[fresh.length - 1]
        if (box) { box.value = 'status'; key(box, 'Enter') }
        await step(250)
        out.docAfterName = doc()
        out.iconOnNamedRow = iconState((() => {
          for (const r of document.querySelectorAll('.metadata-property')) {
            if (r.getAttribute('data-property-key') === 'status') return r.querySelector('.metadata-property-icon')
          }
          return null
        })())

        // P6 -- a value write must touch ONE line.
        const vals = document.querySelectorAll('.metadata-input-longtext')
        let target = null
        for (const v of vals) {
          const row = v.closest('.metadata-property')
          if (row && row.getAttribute('data-property-key') === 'status') target = v
        }
        if (target) { target.textContent = 'open'; key(target, 'Enter') }
        await step(250)
        out.docAfterValue = doc()

        // P7 -- renaming a key whose value is a BLOCK SEQUENCE must not orphan it.
        const keys = document.querySelectorAll('.metadata-property-key-input')
        let tagsKey = null
        for (const k of keys) if (k.value === 'tags') tagsKey = k
        if (tagsKey) { tagsKey.value = 'labels'; key(tagsKey, 'Enter') }
        await step(250)
        out.docAfterRename = doc()

        // P8 -- KNOWN-ISSUES PR-1.  A rename the writer REFUSES must not leave
        // the panel showing a name the file does not have.  The attempt is
        // 'NAME' against an existing 'name' on purpose: Obsidian's guard folds
        // case, so this proves the fold AND the refusal in one step, where a
        // lowercase attempt would only have proved the refusal.
        let statusKey = null
        for (const k of document.querySelectorAll('.metadata-property-key-input')) {
          if (k.value === 'status') statusKey = k
        }
        out.pr1 = null
        if (statusKey) {
          const docBefore = doc()
          statusKey.focus()
          out.pr1 = { docBefore, focused: document.activeElement === statusKey }
          statusKey.value = 'NAME'
          key(statusKey, 'Enter')
          await step(120)
          out.pr1.docAfterEnter = doc()
          out.pr1.valueAfterEnter = statusKey.value
          out.pr1.flashed = Array.from(document.querySelectorAll('.metadata-property.is-flashing'))
            .map((r) => ({
              key: r.getAttribute('data-property-key'),
              bg: getComputedStyle(r).backgroundColor,
              blend: getComputedStyle(r).mixBlendMode,
            }))
          // The revert is on BLUR, and THIS HARNESS CANNOT PRODUCE A REAL ONE.
          // Measured here, not assumed: CAIRN_HEADLESS renders offscreen, so
          // document.hasFocus() is FALSE, and in a document without focus
          // Chromium keeps the activeElement bookkeeping but delivers no focus
          // events at all -- statusKey.blur() fires nothing, and focusing a
          // sibling moves activeElement off it (measured true) while still
          // firing nothing.  So the event is dispatched, which runs the listener
          // under test through the real addEventListener path.  What is NOT
          // tested is Chromium's delivery of blur when focus leaves an input,
          // which is not something this app can get wrong.  Same family as
          // KNOWN-ISSUES LP-4 and §0.23 E45: an unfocused window is its own
          // state, and this probe's other 30 assertions need it (one of them
          // asserts that an UNFOCUSED editor reveals no markers), so the probe
          // stays unfocused and this step dispatches.
          out.pr1.hadRealFocus = document.hasFocus()
          statusKey.dispatchEvent(new FocusEvent('blur'))
          await step(200)
          out.pr1.docAfterBlur = doc()
          out.pr1.valueAfterBlur = statusKey.value
          out.pr1.rowsAfterBlur = document.querySelectorAll('.metadata-property').length
          // And the row must still be editable afterwards -- a refusal must not
          // latch the one-shot guard, or the user is locked out of the row.
          let again = null
          for (const k of document.querySelectorAll('.metadata-property-key-input')) {
            if (k.value === 'status') again = k
          }
          if (again) { again.focus(); again.value = 'state'; key(again, 'Enter') }
          await step(250)
          out.pr1.docAfterRetry = doc()
        }

        // P9 -- KNOWN-ISSUES PR-2.  Collapse the block, then make an edit that
        // changes the frontmatter TEXT, which is what eq() compares -- so the
        // widget is destroyed and rebuilt.  The fold must survive that.
        out.pr2 = null
        const head = document.querySelector('.metadata-properties-heading')
        if (head) {
          clickOn(head)
          await step(260)
          const boxEl = document.querySelector('.metadata-container')
          const contentEl = document.querySelector('.metadata-content')
          out.pr2 = {
            collapsedAfterClick: !!(boxEl && boxEl.classList.contains('is-collapsed')),
            displayAfterClick: contentEl ? getComputedStyle(contentEl).display : null,
          }
          // A MARK, so the test cannot pass vacuously: if the widget were NOT
          // rebuilt there would be nothing for the fold to survive, and the
          // whole row would be measuring nothing.
          if (boxEl) boxEl.setAttribute('data-probe-mark', '1')
          const v9 = view()
          const before9 = doc()
          const at = before9.indexOf('name: sink')
          if (v9 && at >= 0) {
            v9.dispatch({ changes: { from: at + 'name: sink'.length, insert: '2' } })
          }
          await step(300)
          const box2 = document.querySelector('.metadata-container')
          const content2 = document.querySelector('.metadata-content')
          out.pr2.docChanged = doc() !== before9
          out.pr2.widgetRebuilt = !!(box2 && !box2.hasAttribute('data-probe-mark'))
          out.pr2.collapsedAfterEdit = !!(box2 && box2.classList.contains('is-collapsed'))
          out.pr2.displayAfterEdit = content2 ? getComputedStyle(content2).display : null
        }
        return out
      })()
    `)

    console.log('LP_PROBE ' + JSON.stringify({ before, hit, after, collapsed, flight, settled, edit }))
    app.exit(0)
    return
  }

  /* §0.5 E7 end to end, for `window-control.test.mjs`. Inert unless asked for,
     and it REPORTS rather than asserting -- the assertions live in the test.

     It drives the REAL path and stubs nothing: a real `.click()` on the real
     button element, through `chrome.ts`'s own listener, through contextBridge,
     through `cairn:emit`, into `handleWindowControl`, and back out as
     `nc://window-state` to a subscriber that uses the same public
     `window.cairn.on` that `chrome.ts` uses. The only thing the probe adds is
     the collector; every link it crosses is the shipped one. */
  if (process.env.CAIRN_WINCTL_PROBE === '1') {
    const settle = (ms) => new Promise((r) => setTimeout(r, ms))
    await settle(1200)

    // The collector, plus the `__CAIRN_OS__` half: `data-os`, and whether the
    // cluster is actually VISIBLE (offsetParent), not merely present in markup.
    const before = await win.webContents.executeJavaScript(`
      (() => {
        window.__ws = []
        window.cairn.on('nc://window-state', (p) => window.__ws.push(p))
        const c = document.querySelector('.window-controls')
        return {
          dataOs: document.documentElement.getAttribute('data-os'),
          cairnOs: window.__CAIRN_OS__ ?? null,
          controlsPresent: !!c,
          controlsVisible: !!(c && c.offsetParent !== null),
          buttons: ['.win-minimize', '.win-maximize', '.win-close']
            .map((s) => !!document.querySelector(s)),
          icon: document.querySelector('.win-maximize')?.dataset?.icon ?? null,
          statesSoFar: window.__ws.length,
        }
      })()
    `).catch((e) => ({ probeError: String(e) }))

    const maxBefore = win.isMaximized()
    await win.webContents.executeJavaScript(`document.querySelector('.win-maximize').click()`)
    await settle(600)
    const maxAfter = win.isMaximized()
    await win.webContents.executeJavaScript(`document.querySelector('.win-maximize').click()`)
    await settle(600)
    const maxBack = win.isMaximized()

    // An unknown action must be IGNORED, not defaulted (lib.rs:348-350). Sent
    // straight down the bridge because `chrome.ts` can never produce one --
    // the point is what the SHELL does when the two ends have drifted.
    await win.webContents.executeJavaScript(
      `window.cairn.emit('window-control', { action: 'frobnicate' })`
    )
    await settle(400)

    const after = await win.webContents.executeJavaScript(`
      ({ states: window.__ws, icon: document.querySelector('.win-maximize')?.dataset?.icon ?? null })
    `).catch((e) => ({ probeError: String(e) }))

    console.log('WINCTL_PROBE ' + JSON.stringify({
      ...before,
      maxBefore, maxAfter, maxBack,
      unknownActionSurvived: !win.isDestroyed(),
      maxAfterUnknown: win.isMaximized(),
      states: after.states, iconAfter: after.icon,
    }))

    /* The ✕ last, because it ends the run. Under CAIRN_HEADLESS the flush
       handshake short-circuits (see `win.on('close')`), so this isolates
       `handleWindowControl`'s close arm: did it reach `win.close()` at all.

       REPORTED FROM THE `closed` HANDLER, not from after an await. Closing the
       only window fires `app.on('window-all-closed')` (below), which quits the
       process -- so a line written after `await settle(...)` is never reached
       and the probe reports nothing at all. `closed` fires first, and stdout is
       SYNCHRONOUS on a pipe on Linux, so the line is out before the quit. */
    /* THE ✕ NOW REPORTS FROM THE QUIT, NOT FROM `closed`, AND THAT IS A
       STRONGER FACT. The handshake used to be skipped under CAIRN_HEADLESS so
       this probe could isolate "did the click reach win.close() at all"; with
       it skipped, the one thing §1.6 needs -- that the ✕ ARMS `begin_close` --
       was the only part of gap G-b that `close-handshake.test.mjs` could not
       execute, and it had to be asserted from source instead (G-b/5).

       So the guard is gone and the click now drives the whole path: ✕ ->
       `win.close()` -> `begin_close` -> `nc://flush-and-close` -> the real
       frontend's `flushAndClose()` -> `confirm_close(true)` -> `flush_prefs`
       -> `AppCtx::quit` -> `app.exit(0)`. `reportClose` is called from the
       QUIT CALLBACK (see `beginCloseReporter` above), so the line says the
       close completed THROUGH the handshake rather than merely that a window
       object went away.

       `closed` stays as a fallback: if a future change destroys the window
       without the handshake, that path reports `viaHandshake: false` and the
       test fails with the reason rather than hanging. */
    win.once('closed', () => reportClose(false))
    await win.webContents.executeJavaScript(`document.querySelector('.win-close').click()`)
    await settle(3000)
    // Only reached if NOTHING closed, which is the failure this reports rather
    // than hangs on.
    reportClose(false)
    app.exit(1)
    return
  }

  // Harness hook, the same shape as the Tauri build's CAIRN_PIXELTEST_GEOM:
  // inert unless asked for, and it reports rather than asserting.
  if (process.env.CAIRN_BOOT_PROBE === '1') {
    await new Promise((r) => setTimeout(r, 1200))
    const probe = await win.webContents.executeJavaScript(`
      (() => {
        const rows = document.querySelectorAll('.tree-scroller .tr')
        const scroller = document.querySelector('.tree-scroller')
        const cm = document.querySelector('.cm-editor')
        return {
          treeScrollerPresent: !!scroller,
          scrollerClientHeight: scroller ? scroller.clientHeight : null,
          scrollerScrollHeight: scroller ? scroller.scrollHeight : null,
          sizerHeight: document.querySelector('.tree-scroller .sz')?.style?.height ?? null,
          treeRowCount: rows.length,
          treeRowNames: [...rows].slice(0, 12).map(r => r.textContent.trim()),
          codeMirrorMounted: !!cm,
          editorText: document.querySelector('.cm-content')?.textContent?.slice(0, 60) ?? null,
          vaultName: document.querySelector('.vault-name')?.textContent ?? null,
          // §0.7 E9. Reported because the width was silently NEVER INJECTED on
          // this shell until step 10, and the test that was supposed to notice
          // was reading the Tauri source instead of this one.
          sidebarW: getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w').trim(),
          sidebarWGlobal: window.__CAIRN_SIDEBAR_W__ ?? null,
          bodyChildCount: document.body.children.length,
        }
      })()
    `).catch((e) => ({ probeError: String(e) }))

    console.log('BOOT_PROBE ' + JSON.stringify(probe))
    console.log('BOOT_CONSOLE ' + JSON.stringify(consoleLines.slice(0, 25)))

    // Step 4's remaining two criteria: "types, autosaves". Drives the REAL UI
    // -- a click on a real tree row, a real contenteditable insertion -- and
    // then checks the bytes on disk, because an editor that shows the edit but
    // never writes it is exactly the failure this has to catch.
    if (process.env.CAIRN_TYPE_PROBE === '1') {
      const opened = await win.webContents.executeJavaScript(`
        (async () => {
          const sleep = (ms) => new Promise(r => setTimeout(r, ms))
          const row = [...document.querySelectorAll('.tree-scroller .tr')]
            .find(r => r.textContent.trim() === 'Welcome')
          if (!row) return { error: 'no Welcome row' }
          row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
          for (let i = 0; i < 40 && !document.querySelector('.cm-content')?.textContent; i++) {
            await sleep(50)
          }
          const content = document.querySelector('.cm-content')
          return { loadedText: content?.textContent?.slice(0, 40) ?? null }
        })()
      `)
      console.log('TYPE_PROBE_OPEN ' + JSON.stringify(opened))

      const typed = await win.webContents.executeJavaScript(`
        (async () => {
          const sleep = (ms) => new Promise(r => setTimeout(r, ms))
          const content = document.querySelector('.cm-content')
          if (!content) return { error: 'no .cm-content' }
          content.focus()
          const sel = window.getSelection()
          const range = document.createRange()
          range.selectNodeContents(content)
          range.collapse(false)          // caret to end of document
          sel.removeAllRanges(); sel.addRange(range)
          document.execCommand('insertText', false, '\\nTYPED_BY_PROBE\\n')
          await sleep(100)
          return { textAfter: content.textContent.slice(-40) }
        })()
      `)
      console.log('TYPE_PROBE_TYPED ' + JSON.stringify(typed))

      // IDLE_MS is 800 (src/editor.ts:137); wait past it, then read the disk.
      await new Promise((r) => setTimeout(r, 2000))
      const notePath = join(process.env.CAIRN_VAULT, 'Welcome.md')
      let onDisk = null
      try {
        onDisk = readFileSync(notePath, 'utf8')
      } catch (e) {
        onDisk = 'READ FAILED: ' + e.message
      }
      console.log(
        'TYPE_PROBE_DISK ' +
          JSON.stringify({
            containsTypedText: onDisk.includes('TYPED_BY_PROBE'),
            bytes: Buffer.byteLength(onDisk, 'utf8'),
            tail: onDisk.slice(-40),
          })
      )
    }

    app.quit()
  }
})

app.on('window-all-closed', () => app.quit())
