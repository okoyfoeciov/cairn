/**
 * electron-shell/cdp-drive.mjs -- launch the built app on a temp vault and
 * drive its renderer over the Chrome DevTools Protocol, for engine tests that
 * need REAL input: IME composition (`Input.imeSetComposition`), raw key events,
 * trusted mouse clicks.  None of that can be synthesised from inside the page.
 *
 * Hermetic like every other suite here: a fresh vault and a fresh
 * `CAIRN_STATE_DIR` per launch, `CAIRN_HEADLESS=1` (offscreen), and the child
 * is killed by PID on every path out, including a failed launch.
 *
 * The editor view is reached through CM6's own DOM back-pointer
 * (`.cm-content` -> `cmTile.root.view`, which is what `EditorView.findFromDOM`
 * reads), so no harness seam is needed in `preload.cjs`.  `ready()` fails
 * loudly if that pointer ever stops resolving.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { NO_DISPLAY } from './have-display.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)

export const BIN = process.platform === 'darwin'
  ? join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
  : join(ROOT, 'node_modules', 'electron', 'dist', 'electron')

/** The skip reason, or false. */
export const SKIP = !existsSync(BIN)
  ? `electron not installed at ${BIN} -- run npm install`
  : !existsSync(join(HERE, 'cairn.node'))
    ? 'no cairn.node -- run node electron-shell/build-native.mjs'
    : !existsSync(join(HERE, 'app', 'index.html'))
      ? 'electron-shell/app not built -- run node electron-shell/build-app.mjs'
      : NO_DISPLAY

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** The page-side accessor every `evaluate` expression can call as `V()`. */
const VIEW = "const V = () => document.querySelector('.cm-content').cmTile.root.view;"

/**
 * Launch the app with `files` ({ relPath: text }) as its vault and `note` as
 * the note it opens.  Returns the driver; ALWAYS call `close()` (a `finally`).
 */
export async function launch({ files, note }) {
  const work = mkdtempSync(join(tmpdir(), 'cairn-cdp-'))
  const vault = join(work, 'vault')
  mkdirSync(vault, { recursive: true })
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(vault, rel)), { recursive: true })
    writeFileSync(join(vault, rel), text)
  }
  const child = spawn(BIN, ['--remote-debugging-port=0', join(HERE, 'app-main.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      CAIRN_HEADLESS: '1',
      CAIRN_VAULT: vault,
      CAIRN_PIXELTEST_NOTE: note,
      CAIRN_STATE_DIR: join(work, 'state'),
      CAIRN_ELECTRON_GEOM: '1200x800',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let err = ''
  child.stdout.on('data', () => {})
  child.stderr.on('data', (d) => { err += d })
  const exited = new Promise((r) => child.once('exit', r))

  let ws = null
  const close = async () => {
    try { ws && ws.close() } catch {}
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exited
    try { rmSync(work, { recursive: true, force: true }) } catch {}
  }

  try {
    const port = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no DevTools port within 30s\n' + err)), 30_000)
      const scan = () => {
        const m = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(err)
        if (m) { clearTimeout(t); resolve(Number(m[1])) }
      }
      child.stderr.on('data', scan)
      child.once('exit', () => { clearTimeout(t); reject(new Error('app exited before DevTools came up\n' + err)) })
      scan()
    })
    let target = null
    for (let i = 0; i < 200 && !target; i++) {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      target = list.find((t) => t.type === 'page' && /index\.html/.test(t.url)) ?? null
      if (!target) await sleep(100)
    }
    if (!target) throw new Error('no page target\n' + err)
    ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
    let id = 0
    const pending = new Map()
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data)
      const p = m.id && pending.get(m.id)
      if (p) { pending.delete(m.id); p(m) }
    }
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const n = ++id
      const t = setTimeout(() => { pending.delete(n); reject(new Error(method + ' timed out')) }, 20_000)
      pending.set(n, (m) => {
        clearTimeout(t)
        if (m.error) reject(new Error(method + ': ' + JSON.stringify(m.error)))
        else resolve(m.result)
      })
      ws.send(JSON.stringify({ id: n, method, params }))
    })
    const evaluate = async (expr) => {
      const r = await send('Runtime.evaluate', {
        expression: `(async () => { ${VIEW} return (${expr}) })()`,
        awaitPromise: true, returnByValue: true,
      })
      if (r.exceptionDetails) throw new Error('evaluate: ' + JSON.stringify(r.exceptionDetails).slice(0, 600))
      return r.result.value
    }
    /** Two animation frames: every DOM update CM6 scheduled has landed. */
    const frames = () => evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))')
    const key = async (k, code, text) => {
      await send('Input.dispatchKeyEvent', {
        type: text ? 'keyDown' : 'rawKeyDown', key: k, code: k,
        windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, ...(text ? { text } : {}),
      })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code })
    }
    const click = async (x, y) => {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
    }

    // An offscreen window is never focused, and the reveal is gated on focus.
    await send('Emulation.setFocusEmulationEnabled', { enabled: true })
    let ok = false
    for (let i = 0; i < 200 && !ok; i++) {
      ok = await evaluate(`(() => { try { return V().state.doc.length > 0 } catch { return false } })()`)
      if (!ok) await sleep(100)
    }
    if (!ok) throw new Error('the editor view never resolved through cmTile, or the note never loaded\n' + err)
    await evaluate('(V().focus(), 1)')
    await frames()
    return { vault, send, evaluate, frames, key, click, close, stderr: () => err }
  } catch (e) {
    await close()
    throw e
  }
}
