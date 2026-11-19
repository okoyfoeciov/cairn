/**
 * electron-shell/mic.test.mjs — §0.58 E111, the book reader's microphone, end
 * to end in the real app.
 *
 * WHY AN ENGINE.  `tests/frontend/mic-*.test.mjs` drive each module on fakes,
 * and `reader.test.mjs` drives the reader's half with a fake mic.  None of them
 * can see: a real capture device feeding a real Opus encoder, the WebM bytes
 * crossing a real WebSocket, the VAD worker built from app.js's inline payload,
 * the card's real geometry and motion, `<audio>` autoplay, command 23 reaching
 * the clipboard, or the order of the real listeners when the card, the band and
 * the book all want the same click.
 *
 * NEVER THE REAL MICROPHONE, NEVER THE REAL ai-service.  Every launch gets the
 * fake capture device on Electron's argv, fed from a WAV the test GENERATES
 * (`--use-file-for-fake-audio-capture`), its own `--user-data-dir`, and no
 * reachable Pulse, PipeWire or ALSA (an empty XDG_RUNTIME_DIR, PULSE_SERVER at
 * a socket that does not exist, an empty ALSA_CONFIG_PATH), so even a switch
 * that failed reaches no device.  The launch is refused before it is spawned
 * unless its argv and env carry every lock (cdp-drive.mjs's `assertLocked`),
 * and before any take the page must list nothing but fake inputs, which opens
 * no device, and only then report "Fake Default Audio Input" as its default,
 * or the suite refuses to drive.  With XDG_RUNTIME_DIR emptied the Wayland
 * socket is out of reach, so the app runs on X11 (XWayland), and a session
 * without one skips.  ai-service
 * is `fake-ai-ws.mjs`, on a free loopback port passed as CAIRN_AI_BASE; the
 * page's base is checked before the first click.  The Copy step writes the
 * desktop clipboard (X11) and puts its prior text back, as image-copy does.
 *
 * THE SILERO LEG (ruling 7) feeds real speech: CAIRN_MIC_SPEECH_WAV, or
 * $HOME/voice-typing/tests/e2e/clip.wav, read in place and never copied.  When
 * the file is missing only that leg is skipped, with the reason.
 *
 * The tests of one describe run IN ORDER against one app, each from the state
 * the previous one left, the way a reader uses the button.
 *
 * Run: node --test electron-shell/mic.test.mjs  (needs a display, cairn.node,
 * the built app, and ffmpeg for the upload check)
 */

import { strict as assert } from 'node:assert'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { after, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { NO_DISPLAY } from './have-display.mjs'
import { FAKE_INPUT, assertLocked, deviceLocks as baseLocks, inputsGuard, refuseRealInputs } from './cdp-drive.mjs'
import { startFakeAi } from './fake-ai-ws.mjs'
import { CONTAINER, zip } from '../tests/frontend/_epub-fixture.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const BIN = join(ROOT, 'node_modules', 'electron', 'dist', 'electron')
const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()
const SKIP = process.platform !== 'linux'
  ? 'the microphone is Debian only (§0.58 E111): no button off Linux'
  : !existsSync(BIN)
    ? `electron not installed at ${BIN} -- run npm install`
    : !existsSync(join(HERE, 'cairn.node'))
      ? 'no cairn.node -- run node electron-shell/build-native.mjs'
      : !existsSync(join(HERE, 'app', 'index.html'))
        ? 'electron-shell/app not built -- run node electron-shell/build-app.mjs'
        : NO_DISPLAY ||
          (!process.env.DISPLAY ? 'no X11 display: the device locks empty XDG_RUNTIME_DIR, which takes Wayland away' : false)
const SPEECH = process.env.CAIRN_MIC_SPEECH_WAV || join(homedir(), 'voice-typing', 'tests', 'e2e', 'clip.wav')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const BOOK = 'Keeper.epub'
const RED = 'rgb(242, 109, 109)'

/* ── the book ─────────────────────────────────────────────────────────── */

const filler = (tag, n) => Array.from({ length: n }, (_, i) =>
  `<p>Filler ${tag} ${i + 1} tells of rope and salt and the long grey water past the breakwater.</p>`).join('\n')

function makeBook() {
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>The Lantern Keeper</dc:title><dc:creator>Ada Quill</dc:creator><dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="c1" href="harbour.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="c1"/></spine>
</package>`
  const nav = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<body><nav epub:type="toc"><ol><li><a href="harbour.xhtml">The Harbour</a></li></ol></nav></body></html>`
  const ch1 = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body>
  <h1>The Harbour</h1>
  <p>The old keeper lit the lantern every evening before the tide turned.</p>
  <p>The gulls circled the mast and cried over the quiet boats.</p>
  ${filler('a', 40)}
</body></html>`
  return Buffer.from(zip([
    { name: 'mimetype', data: 'application/epub+zip', store: true },
    { name: 'META-INF/container.xml', data: CONTAINER },
    { name: 'OEBPS/content.opf', data: opf },
    { name: 'OEBPS/nav.xhtml', data: nav },
    { name: 'OEBPS/harbour.xhtml', data: ch1 },
  ]))
}

/* ── the signal on the fake device ─────────────────────────────────────────
 * A 2 s loop of sixteen 125 ms chords, two tones each, every chord different,
 * with 5 ms fades so no step clicks.  Tones survive Opus at 128 kbps and the
 * 48→44.1→48→16 kHz resampling nearly untouched, and the chord sequence makes
 * the circular correlation peak at one lag.  `seed` picks the sequence: the
 * control reference is the same shape with other chords. */

const LOOP_S = 2
const STEPS = 16
function chords(seed) {
  const out = []
  let s = seed
  const next = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648 }
  for (let k = 0; k < STEPS; k++) out.push([260 + Math.round(next() * 900), 1300 + Math.round(next() * 1500)])
  return out
}
function signal(rate, seed) {
  const seq = chords(seed)
  const n = Math.round(LOOP_S * rate)
  const step = n / STEPS
  const fade = Math.round(0.005 * rate)
  const x = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const k = Math.min(STEPS - 1, Math.floor(i / step))
    const j = i - Math.round(k * step)
    const len = Math.round((k + 1) * step) - Math.round(k * step)
    const env = Math.min(1, j / fade, (len - 1 - j) / fade)
    const t = i / rate
    const [a, b] = seq[k]
    x[i] = 0.22 * env * (Math.sin(2 * Math.PI * a * t) + Math.sin(2 * Math.PI * b * t))
  }
  return x
}
const SEED = 7
const WRONG_SEED = 1234

function wavFile(x, rate) {
  const b = Buffer.alloc(44 + x.length * 2)
  b.write('RIFF', 0); b.writeUInt32LE(36 + x.length * 2, 4); b.write('WAVE', 8)
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22)
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34)
  b.write('data', 36); b.writeUInt32LE(x.length * 2, 40)
  for (let i = 0; i < x.length; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767))), 44 + i * 2)
  return b
}

/** ai-service's own decode (transcribe_stream.go): the uploaded bytes through
 *  ffmpeg to 16 kHz mono s16le. */
function decode(bytes, dir) {
  const file = join(dir, `upload-${Date.now()}.webm`)
  writeFileSync(file, bytes)
  const pcm = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '16000',
    '-f', 's16le', '-c:a', 'pcm_s16le', 'pipe:1'], { maxBuffer: 64 * 1024 * 1024 })
  rmSync(file, { force: true })
  const out = new Float64Array(pcm.length >> 1)
  for (let i = 0; i < out.length; i++) out[i] = pcm.readInt16LE(i * 2) / 32768
  return out
}

/** The normalised correlation of `x` against the looping reference `ref`, per
 *  250 ms window (AUDIO's xcorr.mjs, windowed).  The first window searches
 *  every circular lag; each next one searches 5 ms around the last, because
 *  the fake device restarts the file when it opens and shifts it by ~3 ms at
 *  each loop wrap (measured), and a pure tone decorrelates at a few samples'
 *  offset. */
function xcorr(x, ref) {
  const N = ref.length
  const W = 4000
  const at = (w0, lag) => {
    let s = 0, a = 0, b = 0
    for (let i = w0; i < w0 + W; i++) { const r = ref[(i + lag) % N]; const y = x[i]; s += r * y; a += r * r; b += y * y }
    return s / Math.sqrt(a * b || 1)
  }
  const wins = []
  let lag = null
  for (let w0 = 0; w0 + W <= x.length; w0 += W) {
    let best = { lag: 0, c: -2 }
    const span = lag === null ? [0, N - 1] : [lag - 80, lag + 80]
    for (let l = span[0]; l <= span[1]; l++) {
      const m = ((l % N) + N) % N
      const c = at(w0, m)
      if (c > best.c) best = { lag: m, c }
    }
    wins.push(best)
    lag = best.lag
  }
  const cs = wins.map((w) => w.c)
  return {
    ms: x.length / 16, windows: wins.length, min: Math.min(...cs), max: Math.max(...cs),
    lagsMs: wins.map((w) => w.lag / 16), corrs: cs.map((c) => +c.toFixed(4)),
  }
}
/** Every window of the upload must match: chosen from measurement (the E3
 *  diagnostic prints both sides of it). */
const CORR_MIN = 0.9

/* ── the page helper ──────────────────────────────────────────────────── */

const PAGE_HELPER = String.raw`
window.__MIC__ = (() => {
  const q = (s) => document.querySelector(s)
  const R = (r) => r && ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom,
    x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2, w: r.width, h: r.height })
  const root = q('.ep-mic')
  const btn = q('.ep-mic .mc-btn')
  /** Every data-state the button went through, in order (a value set again
   *  is no change of state). */
  const states = []
  new MutationObserver((recs) => {
    for (let i = 0; i < recs.length; i++) {
      const v = i + 1 < recs.length ? recs[i + 1].oldValue : root.getAttribute('data-state')
      if (states[states.length - 1] !== v) states.push(v)
    }
  }).observe(root, { attributes: true, attributeFilter: ['data-state'], attributeOldValue: true })
  /** One record per card that opened: the button at the card's first frame,
   *  and the card's opacity on every frame of its first 450 ms. */
  const opens = []
  new MutationObserver((recs) => {
    for (const r of recs) for (const n of r.addedNodes) {
      if (n.nodeType !== 1 || !n.classList.contains('ep-mic-layer')) continue
      const t0 = performance.now()
      const card = n.querySelector('.mc-card')
      const rec = { first: null, samples: [] }
      opens.push(rec)
      const tick = () => {
        const ms = performance.now() - t0
        if (!rec.first) { const cs = getComputedStyle(btn); rec.first = { ms, bg: cs.backgroundColor, transition: cs.transitionProperty } }
        rec.samples.push([Math.round(ms * 10) / 10, Number(getComputedStyle(card).opacity)])
        if (ms < 450 && n.isConnected) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    }
  }).observe(document.body, { childList: true, subtree: true })
  /** Clicks that reached document capture (E11). */
  let clicks = 0
  document.addEventListener('click', () => { clicks++ }, true)
  function mic() {
    const cs = getComputedStyle(btn)
    return {
      count: document.querySelectorAll('.ep-mic').length, bodyChild: root.closest('.ep-mic-frame')?.parentElement === document.body,
      frameRendered: (q('.ep-mic-frame')?.getClientRects().length ?? 0) > 0,
      hidden: root.hidden, rendered: root.getClientRects().length > 0, state: root.getAttribute('data-state'),
      msg: root.hasAttribute('data-msg'), label: q('.ep-mic .mc-label').textContent, aria: btn.getAttribute('aria-label'),
      error: btn.classList.contains('is-error'), color: cs.color, bg: cs.backgroundColor,
      box: R(btn.getBoundingClientRect()),
      stopAnim: getComputedStyle(q('.ep-mic .mc-ico-stop')).animationName,
      dotAnim: getComputedStyle(q('.ep-mic .mc-dots i')).animationName,
      focused: document.activeElement === btn,
    }
  }
  function card() {
    const layer = q('.ep-mic-layer')
    if (!layer) return null
    const c = layer.querySelector('.mc-card')
    const body = layer.querySelector('.mc-body')
    const text = layer.querySelector('.mc-text')
    const copy = layer.querySelector('.mc-copy')
    const player = layer.querySelector('.mc-player')
    return {
      layers: document.querySelectorAll('.ep-mic-layer').length, layerParent: layer.closest('.ep-mic-frame')?.parentElement === document.body,
      text: text.textContent, empty: text.classList.contains('is-empty'), shown: c.classList.contains('is-shown'),
      copyHidden: copy.hidden, copied: copy.classList.contains('is-copied'), copyAria: copy.getAttribute('aria-label'),
      playerHidden: player.hidden, playing: player.classList.contains('is-playing'),
      pp: layer.querySelector('.mc-pp').getAttribute('aria-label'), time: layer.querySelector('.mc-time').textContent,
      fill: layer.querySelector('.mc-fill').style.width,
      box: R(c.getBoundingClientRect()), scrollH: body.scrollHeight, clientH: body.clientHeight,
    }
  }
  function box(sel) { const e = q(sel); return e ? R(e.getBoundingClientRect()) : null }
  function reader() { return R(q('#reader').getBoundingClientRect()) }
  function hit(x, y) { const e = document.elementFromPoint(x, y); return e ? { cls: String(e.className.baseVal ?? e.className), inBtn: !!e.closest('.ep-mic .mc-btn') } : null }
  function band() { const b = q('.ep-explain'); return b ? { open: !b.hidden } : null }
  function mark() { const h = CSS.highlights.get('cairn-explain-mark'); return h ? Array.from(h).map((r) => r.toString()).join('|') : null }
  /** The word's box, after scrolling it to the fraction at of the book's height. */
  function word(text, at = 0.3) {
    const root = q('.ep-content')
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      const at = t.data.indexOf(text)
      if (at < 0) continue
      const r = document.createRange()
      r.setStart(t, at)
      r.setEnd(t, at + text.length)
      const sc = q('.ep-scroller')
      const first = r.getClientRects()[0]
      const sr = sc.getBoundingClientRect()
      sc.scrollTop += first.top - (sr.top + at * sc.clientHeight)
      return R(r.getClientRects()[0])
    }
    return null
  }
  function scrollers() {
    const out = []
    for (const e of document.querySelectorAll('*')) {
      const s = getComputedStyle(e)
      if (!/^(auto|scroll|overlay)$/.test(s.overflowX) && !/^(auto|scroll|overlay)$/.test(s.overflowY)) continue
      if (e.getClientRects().length === 0) continue
      out.push(String(e.className).trim().split(/\s+/)[0] || e.tagName)
    }
    return out.sort()
  }
  function active() { const a = document.activeElement; return { cls: a ? String(a.className) : null, inReader: !!a && !!a.closest && !!a.closest('#reader') } }
  /** The clip the card plays: the <audio> mic-clip appended, and its bytes. */
  async function clip() {
    // Not the looping silent warm-up: the clip's own element.
    const a = [...document.querySelectorAll('body > audio')].filter((x) => !x.loop && x.src.startsWith('blob:')).pop()
    if (!a) return null
    // The card can open before the element has read its header: duration is
    // NaN until loadedmetadata (seen once: null right after the card opened).
    if (!Number.isFinite(a.duration)) {
      await new Promise((r) => { a.addEventListener('loadedmetadata', r, { once: true }); setTimeout(r, 3000) })
    }
    const b = await (await fetch(a.src)).blob()
    return { type: b.type, size: b.size, duration: a.duration }
  }
  return { states, opens, clicks: () => clicks, mic, card, box, reader, hit, band, mark, word, scrollers, active, clip }
})()
`

/* ── the app over the DevTools protocol ───────────────────────────────── */

/** cdp-drive's locks (the fake switches, its own `--user-data-dir`, Pulse at a
 *  socket that does not exist, an empty ALSA config), plus an empty runtime
 *  dir, so no PipeWire socket is reachable either.  That dir holds no Wayland
 *  socket, so the window goes to X11. */
function deviceLocks(work, userData) {
  const base = baseLocks(userData)
  const rt = mkdtempSync(join(tmpdir(), 'cmrt-'))
  const env = { ...base.env, XDG_RUNTIME_DIR: rt, XDG_CONFIG_HOME: join(work, 'xdg') }
  const dispose = () => { base.dispose(); rmSync(rt, { recursive: true, force: true }) }
  return { env, args: ['--ozone-platform=x11', ...base.args], dispose }
}

async function launch({ vault, state, base, expect = base, wav, work, geom = '1200x800', note = BOOK }) {
  const locks = deviceLocks(work, state)
  const env = { ...process.env }
  // Hermetic: nothing the caller's shell exports reaches the app.
  for (const k of Object.keys(env)) if (k.startsWith('CAIRN_')) delete env[k]
  Object.assign(env, locks.env, {
    CAIRN_HEADLESS: '1',
    CAIRN_VAULT: vault,
    CAIRN_STATE_DIR: state,
    CAIRN_PIXELTEST_NOTE: note,
    CAIRN_ELECTRON_GEOM: geom,
  })
  if (base) env.CAIRN_AI_BASE = base
  mkdirSync(env.XDG_CONFIG_HOME, { recursive: true })
  const argv = [
    ...locks.args,
    `--use-file-for-fake-audio-capture=${wav}`,
    '--mute-audio',
    '--remote-debugging-port=0',
    // The main process's inspector, for E24's wheel: only the main process can
    // send the engine a mouse's wheel tick (non-precise, so animated); CDP's
    // mouseWheel is precise and lands in one step.
    '--inspect=127.0.0.1:0',
    join(HERE, 'app-main.mjs'),
  ]
  try {
    assertLocked(argv, env)
  } catch (e) {
    locks.dispose()
    throw e
  }
  const child = spawn(BIN, argv, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let err = ''
  child.stdout.on('data', () => {})
  child.stderr.on('data', (d) => { err += d })
  const exited = new Promise((r) => child.once('exit', r))
  let ws = null
  let mws = null
  const consoleLines = []
  const exceptions = []
  const listeners = new Map()
  const close = async () => {
    try { ws && ws.close() } catch {}
    try { mws && mws.close() } catch {}
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exited
    locks.dispose()
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
    const pages = async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json())
      .filter((t) => t.type === 'page')
    let target = null
    for (let i = 0; i < 200 && !target; i++) {
      target = (await pages()).find((t) => /index\.html/.test(t.url)) ?? null
      if (!target) await sleep(100)
    }
    if (!target) throw new Error('no page target\n' + err)
    ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
    let id = 0
    const pending = new Map()
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data)
      if (m.method === 'Runtime.consoleAPICalled' && !m.sessionId) {
        consoleLines.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
      } else if (m.method === 'Runtime.exceptionThrown' && !m.sessionId) {
        exceptions.push(JSON.stringify(m.params.exceptionDetails).slice(0, 500))
      }
      if (m.method) for (const fn of listeners.get(m.method) ?? []) fn(m.params, m.sessionId)
      const p = m.id && pending.get(m.id)
      if (p) { pending.delete(m.id); p(m) }
    }
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const n = ++id
      const t = setTimeout(() => { pending.delete(n); reject(new Error(method + ' timed out')) }, 20_000)
      pending.set(n, (m) => {
        clearTimeout(t)
        if (m.error) reject(new Error(method + ': ' + JSON.stringify(m.error)))
        else resolve(m.result)
      })
      ws.send(JSON.stringify(sessionId ? { id: n, method, params, sessionId } : { id: n, method, params }))
    })
    const on = (method, fn) => {
      if (!listeners.has(method)) listeners.set(method, [])
      listeners.get(method).push(fn)
    }
    const ev = async (expr) => {
      const r = await send('Runtime.evaluate', {
        expression: `(async () => (${expr}))()`, awaitPromise: true, returnByValue: true,
      })
      if (r.exceptionDetails) throw new Error('evaluate: ' + JSON.stringify(r.exceptionDetails).slice(0, 600))
      return r.result.value
    }
    const M = (call) => ev('window.__MIC__.' + call)
    /** One wheel tick of a mouse at `p`, through the main process: `dir` 1 is
     *  down, -1 up.  Electron's sign is the engine's: a negative delta scrolls
     *  down. */
    const mainUrl = /Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[\w-]+)/.exec(err)?.[1]
    if (!mainUrl) throw new Error('no main-process inspector\n' + err)
    mws = new WebSocket(mainUrl)
    await new Promise((resolve, reject) => { mws.onopen = resolve; mws.onerror = reject })
    let mid = 0
    const mpending = new Map()
    mws.onmessage = (e) => { const m = JSON.parse(e.data); const p = m.id && mpending.get(m.id); if (p) { mpending.delete(m.id); p(m) } }
    const mainEval = (expression) => new Promise((resolve, reject) => {
      const n = ++mid
      const t = setTimeout(() => { mpending.delete(n); reject(new Error('main evaluate timed out')) }, 20_000)
      mpending.set(n, (m) => {
        clearTimeout(t)
        if (m.error || m.result?.exceptionDetails) reject(new Error('main evaluate: ' + JSON.stringify(m.error ?? m.result.exceptionDetails).slice(0, 600)))
        else resolve(m.result.result.value)
      })
      mws.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression, includeCommandLineAPI: true, returnByValue: true } }))
    })
    const tick = (p, dir) => mainEval(`(() => { const w = require('electron').webContents.getAllWebContents().find((c) => /index\\.html/.test(c.getURL()));
      w.sendInputEvent({ type: 'mouseWheel', x: ${p.x}, y: ${p.y}, deltaX: 0, deltaY: ${-120 * dir}, wheelTicksX: 0, wheelTicksY: ${-dir},
        accelerationRatioX: 1, accelerationRatioY: 1, hasPreciseScrollingDeltas: false, canScroll: true }); return 1 })()`)
    const frames = () => ev('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))')
    const until = async (what, expr, ms = 5000) => {
      const t0 = Date.now()
      let last
      for (;;) {
        last = await ev(expr)
        if (last) return last
        if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what} (${expr})`)
        await sleep(30)
      }
    }
    const mouse = (type, p, extra = {}) => send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, ...extra })
    const click = async (p) => {
      await mouse('mouseMoved', p)
      await mouse('mousePressed', p, { button: 'left', buttons: 1, clickCount: 1 })
      await mouse('mouseReleased', p, { button: 'left', buttons: 0, clickCount: 1 })
      await frames()
    }
    const key = async (k, code, vk, { modifiers = 0, text } = {}) => {
      const base = { key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers }
      await send('Input.dispatchKeyEvent', text === undefined ? { type: 'rawKeyDown', ...base } : { type: 'keyDown', text, ...base })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
      await frames()
    }
    /** A key held down: one press, `repeats` auto-repeat keydowns, then the
     *  release.  With `text`, every keydown carries it, as a held Enter does. */
    const hold = async (k, code, vk, repeats, { text } = {}) => {
      const base = { key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }
      const down = text === undefined ? { type: 'rawKeyDown', ...base } : { type: 'keyDown', text, ...base }
      await send('Input.dispatchKeyEvent', down)
      for (let i = 0; i < repeats; i++) await send('Input.dispatchKeyEvent', { ...down, autoRepeat: true })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
      await frames()
    }

    await send('Runtime.enable')
    // An offscreen window is never focused; the keyboard paths need a focused page.
    await send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await until('the book to render', `!!document.querySelector('.ep-content .ep-chapter') && !!document.querySelector('.ep-mic')`, 20_000)
    const inj = await send('Runtime.evaluate', { expression: PAGE_HELPER })
    if (inj.exceptionDetails) throw new Error('page helper: ' + JSON.stringify(inj.exceptionDetails).slice(0, 600))
    // Never drive a page that could reach the real ai-service.
    const pageBase = await ev('window.__CAIRN_AI_BASE__ ?? null')
    if (pageBase !== expect) throw new Error(`refusing to drive the app: its ai-service is ${pageBase ?? 'the default'}, not ${expect}`)
    // Never drive a page that could open a real microphone: the inputs are
    // listed first, and the default is opened only when every one is fake.
    const dev = await ev(`(${inputsGuard})(navigator, true)`)
    refuseRealInputs(dev)
    await frames()
    return { send, on, ev, M, frames, until, click, key, hold, tick, close, consoleLines, exceptions, dev, pid: child.pid }
  } catch (e) {
    await close()
    throw e
  }
}

/* ── fixtures and sessions ─────────────────────────────────────────────── */

const work = SKIP ? null : mkdtempSync(join(tmpdir(), 'cairn-mic-'))
const vault = work && join(work, 'vault')
const TAKE_WAV = work && join(work, 'take.wav')
let fake = null
let app = null
let refused = null
let speech = null

after(async () => {
  for (const a of [app, refused, speech]) { try { await a?.close() } catch {} }
  try { await fake?.close() } catch {}
  if (work) { try { rmSync(work, { recursive: true, force: true }) } catch {} }
})

let ready = false
async function setup() {
  if (ready) return
  ready = true
  fake = await startFakeAi()
  mkdirSync(vault, { recursive: true })
  writeFileSync(join(vault, BOOK), makeBook())
  writeFileSync(join(vault, 'Note.md'), 'a note\n')
  writeFileSync(TAKE_WAV, wavFile(signal(48000, SEED), 48000))
}

/** The last card's entrance has been sampled to its end. */
const ENTERED = `(window.__MIC__.opens.at(-1)?.samples.at(-1)?.[0] ?? 0) >= 400`
/** The card body scrolls: bring a control at its bottom into view, as a reader would. */
const INTO_VIEW = (sel) => `(document.querySelector(${JSON.stringify(sel)}).scrollIntoView({ block: 'nearest' }), 1)`
const STATE = (s) => `document.querySelector('.ep-mic').getAttribute('data-state') === ${JSON.stringify(s)}`
const CARD = `!!document.querySelector('.ep-mic-layer .mc-card.is-shown')`
const NO_CARD = `!document.querySelector('.ep-mic-layer')`
const MOD = 2 // Ctrl: the suite is Linux only

const btn = async (a) => (await a.M('mic()')).box

/** Record for `ms` after the red Stop appears, then stop.  Returns the fake's
 *  connection count before the take: `fake.conns.slice(n)` is this take's. */
async function take(a, ms = 2500) {
  const n = fake.conns.length
  await a.click(await btn(a))
  await a.until('the red Stop', STATE('recording'), 8000)
  await sleep(ms)
  await a.click(await btn(a))
  return n
}

/** A point inside the book on no word: past the end of the heading's line. */
async function blank(a) {
  const at = await a.M(`word('The Harbour')`)
  return { x: at.right + 150, y: at.y }
}

/** Open the band on `word` with a real click; waits for its request. */
async function openBand(a, word = 'lantern') {
  const before = fake.explains.length
  const at = await a.M(`word(${JSON.stringify(word)})`)
  assert.ok(at, `the book has no "${word}"`)
  await a.click(at)
  await a.until('the band', `!document.querySelector('.ep-explain').hidden`)
  const t0 = Date.now()
  while (fake.explains.length <= before && Date.now() - t0 < 5000) await sleep(25)
  assert.equal(fake.explains.length, before + 1, 'the band asked nothing')
}

const LONG = Array.from({ length: 14 }, (_, i) =>
  `Sentence ${i + 1} of the transcript tells how the keeper climbed the stair and trimmed the wick before the tide.`).join(' ')

describe('the fake ai-service answers like /api/transcribe/ws', () => {
  test('one text frame after "stop", then the connection dropped; refusals as ai-service refuses', async () => {
    const f = await startFakeAi()
    try {
      const open = (type) => {
        const w = new WebSocket(`ws://127.0.0.1:${f.port}/api/transcribe/ws?type=${encodeURIComponent(type)}`)
        w.binaryType = 'arraybuffer'
        const got = { msgs: [], closed: null }
        w.onmessage = (e) => got.msgs.push(String(e.data))
        const done = new Promise((r) => { w.onclose = (e) => { got.closed = e.code; r(got) }; w.onerror = () => {} })
        return { w, got, done, opened: new Promise((r) => { w.onopen = r }) }
      }
      f.script({ text: 'hello', first_word_ms: 120, last_word_ms: 900 }, { error: 'recording too long' })
      const a = open('audio/webm;codecs=opus;client=cairn')
      await a.opened
      a.w.send(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2]))
      a.w.send(new Uint8Array(70000))
      a.w.send('stop')
      const ga = await a.done
      assert.deepEqual(ga.msgs, ['{"text":"hello","first_word_ms":120,"last_word_ms":900}'])
      assert.equal(ga.closed, 1006, 'the server must drop the connection with no close frame (CloseNow)')
      const c = f.conns[0]
      assert.deepEqual({ type: c.type, frames: c.frames, stop: c.stop, endedBy: c.endedBy, head: f.body(c).subarray(0, 4).toString('hex') },
        { type: 'audio/webm;codecs=opus;client=cairn', frames: [6, 70000], stop: 2, endedBy: 'server', head: '1a45dfa3' })
      const b = open('audio/webm')
      await b.opened
      b.w.send('stop')
      assert.deepEqual((await b.done).msgs, ['{"error":"recording too long"}'])
      // A cancel: the client closes without "stop".
      const c2 = open('audio/webm')
      await c2.opened
      c2.w.send(new Uint8Array(10))
      c2.w.close()
      await c2.done
      await sleep(50)
      assert.deepEqual({ stop: f.conns[2].stop, endedBy: f.conns[2].endedBy, clientClose: f.conns[2].clientClose },
        { stop: null, endedBy: 'client', clientClose: 1005 })
      const bad = open('text/plain')
      assert.equal((await bad.done).closed, 1008)
      f.script({ http: 403 })
      const refused = open('audio/webm')
      assert.equal((await refused.done).closed, 1006)
      assert.deepEqual(f.stray, [])
    } finally {
      await f.close()
    }
  })
})

describe('the device locks refuse before anything can open the real microphone', () => {
  test('a launch missing any lock is refused before it is spawned', () => {
    const l = baseLocks('/nonexistent/user-data')
    try {
      const argv = [...l.args, '--remote-debugging-port=0', 'app-main.mjs']
      assert.doesNotThrow(() => assertLocked(argv, l.env))
      assert.throws(() => assertLocked(['--remote-debugging-port=0', 'app-main.mjs'], {}),
        /no --use-fake-device-for-media-stream, --use-fake-ui-for-media-stream, --user-data-dir=, PULSE_SERVER, ALSA_CONFIG_PATH/)
      for (const drop of l.args) {
        assert.throws(() => assertLocked(argv.filter((a) => a !== drop), l.env), /refusing to launch/, `without ${drop}`)
      }
      for (const drop of Object.keys(l.env)) {
        const env = { ...l.env }
        delete env[drop]
        assert.throws(() => assertLocked(argv, env), new RegExp(`no ${drop}`), `without ${drop}`)
      }
    } finally {
      l.dispose()
    }
  })

  test('the page guard lists the inputs first, and opens the default only when every input is fake', async () => {
    const calls = []
    const nav = (labels) => ({
      mediaDevices: {
        enumerateDevices: async () => {
          calls.push('enumerate')
          return [{ kind: 'audiooutput', label: 'Speakers' }, ...labels.map((label) => ({ kind: 'audioinput', label }))]
        },
        getUserMedia: async () => {
          calls.push('open')
          return { getAudioTracks: () => [{ label: labels[0] }], getTracks: () => [{ stop: () => calls.push('close') }] }
        },
      },
    })
    // The page runs the function's source, so it must stand alone.
    const guard = (0, eval)(`(${inputsGuard})`)
    const run = async (labels, open) => {
      calls.length = 0
      const dev = await guard(nav(labels), open)
      return { dev, calls: [...calls] }
    }
    for (const labels of [['Built-in Audio Analog Stereo'], [FAKE_INPUT, 'USB Headset Mono'], [''], []]) {
      const r = await run(labels, true)
      assert.deepEqual(r.calls, ['enumerate'], `the guard opened a device before it knew ${JSON.stringify(labels)} were all fake`)
      assert.throws(() => refuseRealInputs(r.dev), /refusing to drive the app/, JSON.stringify(labels))
    }
    const fakes = await run([FAKE_INPUT, 'Fake Audio Input 1', 'Fake Audio Input 2'], true)
    assert.deepEqual(fakes.calls, ['enumerate', 'open', 'close'])
    assert.deepEqual(fakes.dev, { inputs: [FAKE_INPUT, 'Fake Audio Input 1', 'Fake Audio Input 2'], label: FAKE_INPUT, opened: true })
    assert.doesNotThrow(() => refuseRealInputs(fakes.dev))
    const listOnly = await run([FAKE_INPUT], false)
    assert.deepEqual(listOnly.calls, ['enumerate'])
    assert.doesNotThrow(() => refuseRealInputs(listOnly.dev))
    // Opened, but the default is not the fake default: refused.
    assert.throws(() => refuseRealInputs({ inputs: ['Fake Audio Input 1'], label: 'Fake Audio Input 1', opened: true }), /refusing/)
  })
})

describe('E111 the reader\'s microphone, real engine (fake ai-service, fake capture device)', { skip: SKIP }, () => {
  test('E1 the page\'s base is the fake, every capture device is fake, the button is in one body-level frame over the book and none over a note', async (t) => {
    await setup()
    app = await launch({ vault, state: join(work, 'state'), base: fake.base, wav: TAKE_WAV, work })
    t.diagnostic(`device ${JSON.stringify(app.dev)}, dpr ${await app.ev('devicePixelRatio')}, ` +
      `window ${await app.ev('innerWidth + "x" + innerHeight')}, pid ${app.pid}`)
    const m = await app.M('mic()')
    assert.deepEqual({ count: m.count, bodyChild: m.bodyChild, hidden: m.hidden, rendered: m.rendered, state: m.state, aria: m.aria },
      { count: 1, bodyChild: true, hidden: false, rendered: true, state: 'idle', aria: 'Record' })
    assert.equal(await app.ev(`!!document.querySelector('#reader .ep-mic')`), false, 'the mic is inside #reader')
    // A note takes the pane: no button, no box.
    const row = (name) => app.until(`the ${name} row`, `(() => { const r = [...document.querySelectorAll('.tr')].find((e) => !e.hidden && e.textContent.trim().startsWith(${JSON.stringify(name)}));
      if (!r) return null; const b = r.getBoundingClientRect(); return { x: b.left + Math.min(40, b.width / 2), y: (b.top + b.bottom) / 2 } })()`)
    await app.click(await row('Note'))
    await app.until('the note', `document.getElementById('reader').hidden`)
    const onNote = await app.M('mic()')
    assert.deepEqual({ hidden: onNote.hidden, rendered: onNote.rendered, frame: onNote.frameRendered }, { hidden: true, rendered: false, frame: false },
      'a button, or the frame (a scroller G9 would count), over a note')
    await app.click(await row('Keeper'))
    await app.until('the book again', `!document.getElementById('reader').hidden && !document.querySelector('.ep-mic').hidden`)
    assert.deepEqual(fake.conns, [], 'the microphone dialled ai-service before any take')
  })

  test('E2 the button sits 16px inside the reader pane\'s bottom-right, 56px, over the open band, and hides on the Memoir tab', async (t) => {
    const r = await app.M('reader()')
    const b = await btn(app)
    const dpr = await app.ev('devicePixelRatio')
    t.diagnostic(`dpr ${dpr}; #reader ${JSON.stringify(r)}; button ${JSON.stringify(b)}`)
    const near = (x, want, tol = 0.5) => Math.abs(x - want) <= tol
    assert.ok(near(r.right - b.right, 16) && near(r.bottom - b.bottom, 16), `the button is not 16px inside #reader's corner: ${JSON.stringify({ r, b })}`)
    assert.ok(near(b.w, 56) && near(b.h, 56), `the button is not 56px: ${b.w}x${b.h}`)
    await openBand(app)
    const hit = await app.M(`hit(${b.x}, ${b.y})`)
    assert.equal(hit.inBtn, true, `the band covers the button: ${JSON.stringify(hit)}`)
    assert.deepEqual(await btn(app), b, 'the button moved when the band opened')
    await app.key('2', 'Digit2', 50, { modifiers: MOD })
    await app.until('the Memoir page', `!document.getElementById('memoir').hidden`)
    assert.equal((await app.M('mic()')).hidden, true, 'a button over the Memoir page')
    await app.key('1', 'Digit1', 49, { modifiers: MOD })
    await app.until('the book again', `!document.getElementById('reader').hidden && !document.querySelector('.ep-mic').hidden`)
  })

  test('E3 a take: dots, the red Stop only once audio flows, dots, the card; the upload is the device\'s audio', async (t) => {
    assert.equal((await app.M('band()')).open, false, 'fixture: the band is open')
    fake.script({ text: LONG, first_word_ms: 200, last_word_ms: 2400 })
    await app.ev('(window.__MIC__.states.length = 0)')
    const n = await take(app, 2600)
    await app.until('the card', CARD, 15_000)
    const states = await app.ev('window.__MIC__.states')
    assert.deepEqual(states, ['arming', 'recording', 'transcribing', 'idle'], 'the button went through the wrong states')
    const conns = fake.conns.slice(n)
    assert.equal(conns.length, 1, 'one take, one connection')
    const c = conns[0]
    const body = fake.body(c)
    assert.deepEqual({
      type: c.type, origin: c.origin, head: body.subarray(0, 4).toString('hex'), stopAfterLast: c.stop === c.frames.length,
      stops: c.texts.filter((x) => x === 'stop').length, empty: c.frames.filter((x) => x === 0).length,
    }, {
      type: 'audio/webm;codecs=opus;client=cairn', origin: 'file://', head: '1a45dfa3', stopAfterLast: true, stops: 1, empty: 0,
    })
    const card = await app.M('card()')
    assert.equal(card.text, LONG)
    // The upload, decoded the way ai-service decodes it, is the WAV on the device.
    if (!hasFfmpeg) {
      t.skip('ffmpeg is not installed: the upload cannot be decoded')
      return
    }
    const pcm = decode(body, work)
    const right = xcorr(pcm, signal(16000, SEED))
    const wrong = xcorr(pcm, signal(16000, WRONG_SEED))
    t.diagnostic(`upload ${body.length} B in ${c.frames.length} frames, decoded ${right.ms} ms; ` +
      `per-250ms corr ${JSON.stringify(right.corrs)} at lags ${JSON.stringify(right.lagsMs)} ms; ` +
      `against other chords max ${wrong.max.toFixed(4)} ${JSON.stringify(wrong.corrs)}`)
    assert.ok(right.ms > 2000 && right.windows >= 8, `the upload decodes to ${right.ms} ms`)
    assert.ok(right.min >= CORR_MIN, `the upload is not the device's audio: per-window corr ${JSON.stringify(right.corrs)}`)
    assert.ok(wrong.max < CORR_MIN, `the check cannot fail: other chords correlate at ${wrong.max}`)
  })

  test('E4 the black circle leaves at once when the card opens', async () => {
    const [rec] = await app.ev('window.__MIC__.opens')
    assert.ok(rec && rec.first, 'no frame was sampled after the card opened')
    assert.equal(rec.first.bg, 'rgba(0, 0, 0, 0)', `the button still had its circle on the card's first frame (${rec.first.ms} ms)`)
    assert.equal(/background/.test(rec.first.transition), false, `the circle fades: ${rec.first.transition}`)
  })

  test('E5 the card\'s top is 15% of the reader\'s height below the reader\'s top (comart\'s full card), at its width, capped at 33vh, and scrolls inside', async (t) => {
    await app.until('the entrance to end', ENTERED)
    const c = await app.M('card()')
    const r = await app.M('reader()')
    const vh = await app.ev('innerHeight')
    t.diagnostic(`card ${JSON.stringify(c.box)}; #reader ${JSON.stringify(r)}; innerHeight ${vh}; body ${c.scrollH}/${c.clientH}`)
    const want = r.top + 0.15 * r.h
    assert.ok(Math.abs(c.box.top - want) <= 1, `card top ${c.box.top} is not 15% down the reader, ${want}`)
    assert.ok(Math.abs(c.box.left - r.left) <= 0.5 && Math.abs(c.box.w - r.w) <= 0.5, 'the card is not at the reader\'s edges and width')
    assert.ok(Math.abs(c.box.h - 0.33 * vh) <= 1, `the card is ${c.box.h}px, not 33vh`)
    assert.ok(c.scrollH > c.clientH, 'the long transcript does not scroll inside the card')
    assert.deepEqual(await app.M('scrollers()'), ['ep-mic-frame', 'ep-scroller', 'mc-body', 'tree-scroller'])
    assert.equal(c.layerParent, true, 'the card layer is not in the body-level frame')
  })

  test('E6 the entrance fades and slides in over .22s', async (t) => {
    await app.until('the entrance to end', ENTERED)
    const [rec] = await app.ev('window.__MIC__.opens')
    t.diagnostic('opacity ' + rec.samples.map(([ms, o]) => `${o}@${ms}`).join(' '))
    const mid = rec.samples.filter(([ms]) => ms >= 40 && ms <= 120)
    assert.ok(mid.some(([, o]) => o > 0 && o < 1), 'no opacity strictly between 0 and 1 at 40-120 ms: the card jumped in')
    const late = rec.samples.filter(([ms]) => ms >= 350)
    assert.ok(late.length && late.every(([, o]) => o === 1), 'the card is not opaque by 350 ms')
  })

  test('E7 the clip autoplays and the player answers', async () => {
    await app.until('autoplay', `!!document.querySelector('.ep-mic-layer .mc-player.is-playing')`, 1500)
    await app.ev(INTO_VIEW('.ep-mic-layer .mc-player'))
    await app.click(await app.M(`box('.ep-mic-layer .mc-pp')`))
    await app.until('the pause', `!document.querySelector('.ep-mic-layer .mc-player.is-playing')`)
    const tr = await app.M(`box('.ep-mic-layer .mc-track')`)
    await app.click({ x: tr.left + tr.w * 0.75, y: tr.y })
    const c = await app.M('card()')
    assert.notEqual(c.time.split(' / ')[0], '0:00', `a seek to 75% left the clock at ${c.time}`)
    assert.ok(parseFloat(c.fill) > 50, `the fill is ${c.fill} after a seek to 75%`)
  })

  test('E8 Copy puts the transcript on the clipboard through command 23, then shows the check for 1.5 s', async (t) => {
    const invoke = (cmd, args = {}) => app.ev(`window.cairn.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`)
    const saved = await invoke('read_text')
    const prior = saved && saved.ok && typeof saved.value === 'string' ? saved.value : ''
    if (prior.length > 4096) {
      t.skip('the clipboard holds more text than command 23 could put back')
      return
    }
    try {
      const SENTINEL = 'cairn-mic-copy-sentinel'
      assert.equal((await invoke('copy_text', { text: SENTINEL })).ok, true, 'the sentinel could not be put on the clipboard')
      await app.ev(INTO_VIEW('.ep-mic-layer .mc-copy'))
      await app.click(await app.M(`box('.ep-mic-layer .mc-copy')`))
      await app.until('the check', `!!document.querySelector('.ep-mic-layer .mc-copy.is-copied')`, 3000)
      const t0 = Date.now()
      assert.equal((await app.M('card()')).copyAria, 'Copied')
      const got = await invoke('read_text')
      // Never print what was read: on a desktop it may be the user's own text.
      assert.ok(got && got.ok && got.value === LONG,
        'the clipboard does not hold the transcript' + (got && got.value === SENTINEL ? ' (the sentinel is still there)' : ''))
      await app.until('the check to go', `!document.querySelector('.ep-mic-layer .mc-copy.is-copied')`, 2500)
      const gone = Date.now() - t0
      assert.ok(gone <= 1700, `the check stayed ${gone} ms`)
      assert.equal((await app.M('card()')).copyAria, 'Copy')
    } finally {
      if (prior) await invoke('copy_text', { text: prior })
    }
  })

  test('E13 record again while the card is open: the card ends at once, a fresh one comes', async () => {
    fake.script({ text: 'The second take.', first_word_ms: 100, last_word_ms: 1200 })
    await app.click(await btn(app))
    assert.equal(await app.ev(NO_CARD), true, 'the old card outlived the record click')
    await app.until('the red Stop', STATE('recording'), 8000)
    await sleep(1500)
    await app.click(await btn(app))
    await app.until('the second card', CARD, 15_000)
    assert.equal((await app.M('card()')).text, 'The second take.')
    // Rule 3 with no band: the shield closes only the card.
    await app.click(await blank(app))
    await app.until('the card to close', NO_CARD)
    assert.equal((await app.M('active()')).inReader, true, 'focus left #reader after the shield click')
  })

  test('E12 the button over the open band records without closing it', async () => {
    await openBand(app)
    fake.script({ text: 'Over the band.', first_word_ms: 100, last_word_ms: 1200 })
    await app.click(await btn(app))
    const st = (await app.M('mic()')).state
    assert.ok(st === 'arming' || st === 'recording', `the click did not start a take: ${st}`)
    assert.equal((await app.M('band()')).open, true, 'the record click closed the band')
    await app.until('the red Stop', STATE('recording'), 8000)
    await sleep(1500)
    await app.click(await btn(app))
    await app.until('the card', CARD, 15_000)
    assert.equal((await app.M('band()')).open, true, 'the stop click or the card closed the band')
  })

  test('E9 with the band open, a click outside the card closes only the card, picks nothing; the next closes the band', async () => {
    const asks = fake.explains.length
    const mark = await app.M('mark()')
    assert.ok(mark, 'fixture: no mark')
    // Above the card: its top is 15% down the reader, so the book shows there.
    // A word deep in the book, so it can be scrolled that high.
    const at = await app.M(`word('Filler a 20', 0.08)`)
    const hit = await app.M(`hit(${at.x}, ${at.y})`)
    assert.equal(hit.cls, 'mc-shield', `the book word is not under the shield: ${JSON.stringify(hit)}`)
    await app.click(at)
    await app.until('the card to close', NO_CARD)
    await sleep(200)
    assert.equal(fake.explains.length, asks, 'a book word under the shield asked ai-service')
    assert.equal(await app.M('mark()'), mark, 'a book word under the shield was marked')
    assert.equal((await app.M('band()')).open, true, 'the click that closed the card closed the band')
    assert.equal((await app.M('active()')).inReader, true, 'focus left #reader')
    await app.click(await blank(app))
    await sleep(150)
    assert.equal((await app.M('band()')).open, false, 'the next click did not close the band')
    assert.equal(fake.explains.length, asks)
  })

  test('E10 Esc closes the card first, then the band; a held Esc closes one layer', async () => {
    for (const held of [false, true]) {
      await openBand(app)
      fake.script({ text: held ? 'Held.' : 'Pressed.', first_word_ms: 100, last_word_ms: 1200 })
      await take(app, 1200)
      await app.until('the card', CARD, 15_000)
      if (held) await app.hold('Escape', 'Escape', 27, 4)
      else await app.key('Escape', 'Escape', 27)
      assert.equal(await app.ev(NO_CARD), true, 'Esc did not close the card')
      assert.equal((await app.M('band()')).open, true, held ? 'a held Esc closed the band too' : 'one Esc closed the card and the band')
      assert.equal((await app.M('active()')).inReader, true, 'focus is not inside #reader, where the band\'s Esc is heard')
      await app.key('Escape', 'Escape', 27)
      assert.equal((await app.M('band()')).open, false, 'the next Esc did not close the band')
    }
  })

  test('E11 the title bar stays live while the card is open, and a click on the active tab closes neither', async () => {
    await openBand(app)
    fake.script({ text: 'Title bar.', first_word_ms: 100, last_word_ms: 1200 })
    await take(app, 1200)
    await app.until('the card', CARD, 15_000)
    const tab = await app.M(`box('.tab.is-active .tab-label')`)
    assert.ok(tab, 'fixture: no active tab label')
    const hit = await app.M(`hit(${tab.x}, ${tab.y})`)
    assert.match(hit.cls, /tab-label/, `the shield covers the title bar: ${JSON.stringify(hit)}`)
    const before = await app.ev('window.__MIC__.clicks()')
    await app.click(tab)
    await sleep(150)
    assert.equal(await app.ev('window.__MIC__.clicks()'), before + 1, 'the click never reached the document: the step cannot fail')
    assert.equal(await app.ev(CARD), true, 'a title-bar click closed the card')
    assert.equal((await app.M('band()')).open, true, 'a title-bar click closed the band under the card')
    await app.key('Escape', 'Escape', 27)
    await app.key('Escape', 'Escape', 27)
    assert.equal((await app.M('band()')).open, false)
  })

  test('E15 too short says "Too short — try again" and sends no stop', async () => {
    const n = fake.conns.length
    await app.click(await btn(app))
    await app.until('the red Stop', STATE('recording'), 8000)
    await app.click(await btn(app))
    await app.until('the flash', `document.querySelector('.ep-mic .mc-label').textContent === 'Too short — try again'`, 5000)
    const m = await app.M('mic()')
    assert.deepEqual({ state: m.state, error: m.error }, { state: 'idle', error: false })
    await sleep(300)
    const conns = fake.conns.slice(n)
    assert.ok(conns.every((c) => c.stop === null), 'a take under the floors sent "stop"')
    await app.until('the flash to go', `!document.querySelector('.ep-mic').hasAttribute('data-msg')`, 3000)
  })

  test('E16 an error answer shows the failure line in red and it stays; the next click clears it and records', async () => {
    fake.script({ error: 'recording too long' })
    await take(app, 1200)
    const line = 'Transcription failed — recording too long'
    await app.until('the failure line', `document.querySelector('.ep-mic .mc-label').textContent === ${JSON.stringify(line)}`, 15_000)
    await sleep(3000)
    const m = await app.M('mic()')
    assert.deepEqual({ label: m.label, error: m.error, color: m.color, msg: m.msg, state: m.state },
      { label: line, error: true, color: RED, msg: true, state: 'idle' })
    assert.equal(await app.ev(NO_CARD), true)
    fake.script({ text: 'After the error.', first_word_ms: 100, last_word_ms: 1200 })
    await app.click(await btn(app))
    const next = await app.M('mic()')
    assert.deepEqual({ msg: next.msg, error: next.error, label: next.label }, { msg: false, error: false, label: '' })
    await app.until('the red Stop', STATE('recording'), 8000)
    await sleep(1000)
    await app.click(await btn(app))
    await app.until('the card', CARD, 15_000)
    await app.key('Escape', 'Escape', 27)
    assert.equal(await app.ev(NO_CARD), true)
  })

  test('E17 an empty answer says "No speech detected" and hides Copy', async () => {
    fake.script({ text: '' })
    await take(app, 1200)
    await app.until('the card', CARD, 15_000)
    const c = await app.M('card()')
    assert.deepEqual({ text: c.text, empty: c.empty, copyHidden: c.copyHidden, playerHidden: c.playerHidden },
      { text: 'No speech detected', empty: true, copyHidden: true, playerHidden: false })
    await app.key('Escape', 'Escape', 27)
  })

  test('E19 reduced motion stops only the Stop\'s blink', async () => {
    fake.script({ text: 'Motion.', first_word_ms: 100, last_word_ms: 1200, delayMs: 1500 })
    const sample = async () => {
      await app.click(await btn(app))
      await app.until('the red Stop', STATE('recording'), 8000)
      const stop = (await app.M('mic()')).stopAnim
      await sleep(600)
      await app.click(await btn(app))
      await app.until('transcribing', STATE('transcribing'))
      const dots = (await app.M('mic()')).dotAnim
      await app.until('the card', CARD, 15_000)
      await app.key('Escape', 'Escape', 27)
      return { stop, dots }
    }
    assert.deepEqual(await sample(), { stop: 'mc-blink', dots: 'mc-dot' }, 'control: the motion is not comart\'s')
    await app.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    try {
      assert.deepEqual(await sample(), { stop: 'none', dots: 'mc-dot' })
    } finally {
      await app.send('Emulation.setEmulatedMedia', { features: [] })
    }
  })

  test('E14 leaving the book mid-take discards it silently: recording, and transcribing', async () => {
    // Recording: the Memoir tab takes the pane.
    let n = fake.conns.length
    await app.click(await btn(app))
    await app.until('the red Stop', STATE('recording'), 8000)
    await sleep(800)
    await app.key('2', 'Digit2', 50, { modifiers: MOD })
    await app.until('the Memoir page', `!document.getElementById('memoir').hidden`)
    await sleep(300)
    let conns = fake.conns.slice(n)
    assert.ok(conns.length >= 1, 'fixture: the take opened no connection')
    assert.deepEqual(conns.map((c) => ({ stop: c.stop, endedBy: c.endedBy })), conns.map(() => ({ stop: null, endedBy: 'client' })),
      'a take left mid-recording sent "stop", or its connection stayed open')
    await app.key('1', 'Digit1', 49, { modifiers: MOD })
    await app.until('the book again', `!document.getElementById('reader').hidden && !document.querySelector('.ep-mic').hidden`)
    let m = await app.M('mic()')
    assert.deepEqual({ state: m.state, msg: m.msg, card: await app.ev(NO_CARD) }, { state: 'idle', msg: false, card: true })

    // Transcribing, the answer never coming: the client closes the socket.
    fake.script({ hang: true })
    n = await take(app, 1000)
    await app.until('transcribing', STATE('transcribing'))
    await sleep(300)
    await app.key('2', 'Digit2', 50, { modifiers: MOD })
    await app.until('the Memoir page', `!document.getElementById('memoir').hidden`)
    await sleep(300)
    conns = fake.conns.slice(n)
    assert.equal(conns.length, 1)
    assert.deepEqual({ stop: conns[0].stop !== null, endedBy: conns[0].endedBy }, { stop: true, endedBy: 'client' },
      'the hung connection was left open after leaving the book')
    await app.key('1', 'Digit1', 49, { modifiers: MOD })
    await app.until('the book again', `!document.getElementById('reader').hidden && !document.querySelector('.ep-mic').hidden`)
    await sleep(500)
    m = await app.M('mic()')
    assert.deepEqual({ state: m.state, msg: m.msg, card: await app.ev(NO_CARD) }, { state: 'idle', msg: false, card: true })
  })

  test('E18 Enter starts and Space stops', async () => {
    fake.script({ text: 'Keyboard.', first_word_ms: 100, last_word_ms: 1200 })
    await app.ev(`(document.querySelector('.ep-mic .mc-btn').focus(), 1)`)
    await app.key('Enter', 'Enter', 13, { text: '\r' })
    await app.until('the red Stop', STATE('recording'), 8000)
    assert.equal((await app.M('mic()')).focused, true, 'a keyboard click moved focus off the button')
    await sleep(1000)
    await app.key(' ', 'Space', 32, { text: ' ' })
    await app.until('the card', CARD, 15_000)
    assert.equal((await app.M('card()')).text, 'Keyboard.')
    await app.key('Escape', 'Escape', 27)
  })

  test('E21 a held Enter on the focused button is one click: one take, never a start and a cancel per repeat', async () => {
    assert.equal(await app.ev(NO_CARD), true, 'fixture: a card is open')
    fake.script({ text: 'Held Enter.', first_word_ms: 100, last_word_ms: 1200 })
    const n = fake.conns.length
    await app.ev('(window.__MIC__.states.length = 0)')
    await app.ev(`(document.querySelector('.ep-mic .mc-btn').focus(), 1)`)
    await app.hold('Enter', 'Enter', 13, 4, { text: '\r' })
    const held = await app.ev('window.__MIC__.states')
    assert.deepEqual(held.filter((x) => x !== 'recording'), ['arming'], `a held Enter went through ${JSON.stringify(held)}`)
    await app.until('the red Stop', STATE('recording'), 8000)
    await sleep(800)
    await app.key('Enter', 'Enter', 13, { text: '\r' })
    await app.until('the card', CARD, 15_000)
    assert.equal((await app.M('card()')).text, 'Held Enter.')
    assert.equal(fake.conns.length - n, 1, 'one held Enter made more than one connection')
    await app.key('Escape', 'Escape', 27)
    await app.until('the card to close', NO_CARD)
  })

  test('E22 Esc with focus on the button and no card gives focus back to #reader; the next Esc is the band\'s', async () => {
    await openBand(app)
    await app.ev(`(document.querySelector('.ep-mic .mc-btn').focus(), 1)`)
    await app.key('Enter', 'Enter', 13, { text: '\r' })
    await app.until('the red Stop', STATE('recording'), 8000)
    await app.key(' ', 'Space', 32, { text: ' ' })
    await app.until('the flash', `document.querySelector('.ep-mic .mc-label').textContent === 'Too short — try again'`, 5000)
    assert.equal((await app.M('mic()')).focused, true, 'fixture: the keyboard take moved focus off the button')
    await app.key('Escape', 'Escape', 27)
    assert.equal((await app.M('active()')).inReader, true, 'Esc on the button left focus where no reader layer hears it')
    assert.equal((await app.M('band()')).open, true, 'the Esc that gave focus back closed the band too')
    await app.key('Escape', 'Escape', 27)
    assert.equal((await app.M('band()')).open, false, 'the next Esc did not close the band')
    await app.until('the flash to go', `!document.querySelector('.ep-mic').hasAttribute('data-msg')`, 3000)
  })

  test('E23 a press on the button or on the shield keeps the reader\'s find bar and its query', async () => {
    const FIND = `(() => { const b = document.querySelector('#reader .find-bar'); return b ? { shown: !b.hidden, query: b.querySelector('.find-input').value } : null })()`
    await app.key('f', 'KeyF', 70, { modifiers: MOD })
    await app.until('the find bar', `!!document.querySelector('#reader .find-bar') && !document.querySelector('#reader .find-bar').hidden`)
    await app.send('Input.insertText', { text: 'keeper' })
    await app.frames()
    const want = { shown: true, query: 'keeper' }
    assert.deepEqual(await app.ev(FIND), want, 'fixture: the find bar did not take the query')
    fake.script({ text: 'Find bar.', first_word_ms: 100, last_word_ms: 1200 })
    await app.click(await btn(app))
    assert.deepEqual(await app.ev(FIND), want, 'a press on Record closed the find bar or wiped its query')
    await app.until('the red Stop', STATE('recording'), 8000)
    await sleep(800)
    await app.click(await btn(app))
    await app.until('the card', CARD, 15_000)
    const r = await app.M('reader()')
    const off = { x: r.left + 40, y: r.bottom - 40 }
    assert.match((await app.M(`hit(${off.x}, ${off.y})`)).cls, /mc-shield/, 'fixture: the point is not on the shield')
    await app.click(off)
    assert.equal(await app.ev(NO_CARD), true, 'a click on the shield did not close the card')
    assert.deepEqual(await app.ev(FIND), want, 'a press on the shield closed the find bar or wiped its query')
    await app.key('Escape', 'Escape', 27)
    assert.equal((await app.ev(FIND)).shown, false, 'the next Esc did not close the find bar')
  })

  test('E24 the wheel over the shield, the card or the button scrolls the book with the engine\'s own motion; the card text scrolls first', async (t) => {
    const TOP = `document.querySelector('#reader .ep-scroller').scrollTop`
    const BODY = `document.querySelector('.ep-mic-layer .mc-body')`
    /** The book's scrollTop on every frame for `ms`, from the wheel at `p`. */
    const track = async (p, deltaY, ms = 700) => {
      await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y })
      await app.ev(`(window.__wheelTrack = new Promise((done) => { const s = document.querySelector('#reader .ep-scroller'); const t0 = performance.now(); const out = [s.scrollTop];
        const tick = () => { out.push(s.scrollTop); if (performance.now() - t0 < ${ms}) requestAnimationFrame(tick); else done(out) }; requestAnimationFrame(tick) }), 1)`)
      await app.tick(p, Math.sign(deltaY))
      const out = await app.ev('window.__wheelTrack')
      const moved = out.map((v) => v - out[0])
      // The motion from its first step: how many frames it moved on, and where it ended.
      const first = moved.findIndex((v) => v !== 0)
      const path = first < 0 ? [] : moved.slice(first)
      return { end: moved.at(-1), steps: path.filter((v, i) => i === 0 || v !== path[i - 1]).length, path }
    }
    const near = (got, want, what) => assert.ok(Math.abs(got - want) <= 0.5, `${what}: ${got}, want ${want}`)
    const r = await app.M('reader()')
    const off = { x: r.left + 40, y: r.top + 60 }

    // The engine's own wheel over the book, with no card: the reference.
    await app.ev(`(document.querySelector('#reader .ep-scroller').scrollTop = 200, 1)`)
    const bare = await track(off, 120)
    t.diagnostic(`no card: ${bare.steps} steps to ${bare.end}: ${bare.path.join(' ')}`)
    assert.ok(bare.steps > 3, `fixture: the engine's wheel did not animate (${bare.steps} steps)`)
    near(bare.end, 120, 'fixture: the engine\'s wheel over the book')

    fake.script({ text: LONG, first_word_ms: 100, last_word_ms: 1200 })
    await app.click(await btn(app))
    await app.until('the red Stop', STATE('recording'), 8000)
    await sleep(800)
    await app.click(await btn(app))
    await app.until('the card', CARD, 15_000)
    await app.until('the entrance to end', ENTERED)
    const room = await app.ev(`(() => { const s = document.querySelector('#reader .ep-scroller'); s.scrollTop = 200; return s.scrollHeight - s.clientHeight })()`)
    assert.ok(room >= 700, `fixture: the book scrolls only ${room}px`)
    const stack = await app.ev(`document.elementsFromPoint(${off.x}, ${off.y}).map((e) => String(e.className.baseVal ?? e.className).split(' ')[0])`)
    t.diagnostic(`under ${JSON.stringify(off)}: ${stack.join(' > ')}`)
    assert.equal(stack[0], 'mc-shield', 'fixture: the point is not on the shield')
    assert.ok(stack.includes('ep-scroller'), 'fixture: the book is not under the point')

    // The same wheel over the shield: the same motion, frame for frame.
    const shielded = await track(off, 120)
    t.diagnostic(`over the shield: ${shielded.steps} steps to ${shielded.end}: ${shielded.path.join(' ')}`)
    near(shielded.end, 120, 'a wheel over the shield did not scroll the book')
    assert.ok(Math.abs(shielded.steps - bare.steps) <= 1, `the motion differs: ${shielded.steps} steps against the engine's ${bare.steps}`)
    // The engine's own curve shifts with where the tick lands between frames:
    // two wheels over the bare book differ by up to 7px on a frame here (60 Hz
    // offscreen) and 8.8px windowed at 120 Hz.  A hand-made scroll is far off:
    // the old jump was 117.5px off on its first frame.
    const n = Math.min(bare.path.length, shielded.path.length)
    const gap = Math.max(...Array.from({ length: n }, (_, i) => Math.abs(bare.path[i] - shielded.path[i])))
    assert.ok(gap <= 12, `the motion differs from the engine's by ${gap}px on one frame`)
    assert.equal(await app.ev(CARD), true, 'the wheel closed the card')

    // The card text has room: it scrolls, and the book stays.
    const text = await app.M(`box('.ep-mic-layer .mc-text')`)
    const onText = { x: text.x, y: Math.min(text.y, (await app.M('card()')).box.y) }
    const inText = await track(onText, 120, 400)
    assert.equal(inText.end, 0, 'the book moved while the card text had room')
    await app.until('the card text to scroll', `${BODY}.scrollTop > 0`, 2000)

    // At its end the card text chains to the frame, and the book moves.  A new
    // wheel sequence: within one, the engine stays latched to the text, as it
    // does to any inner scroller on any page.
    await app.ev(`(${BODY}.scrollTop = ${BODY}.scrollHeight, 1)`)
    await sleep(1000)
    near((await track(onText, 120)).end, 120, 'a wheel over the card text at its end did not scroll the book')

    // The record button, with the card gone.
    await app.key('Escape', 'Escape', 27)
    await app.until('the card to close', NO_CARD)
    near((await track(await btn(app), -120)).end, -120, 'a wheel over the record button did not scroll the book')
  })

  test('the page threw nothing, logged no microphone error, and asked the fake for nothing unexpected', () => {
    assert.deepEqual(app.exceptions, [], 'the page threw')
    assert.deepEqual(app.consoleLines.filter((l) => /cairn\[mic/.test(l)), [], 'the microphone reported errors')
    assert.deepEqual(fake.stray, [], 'unexpected requests')
  })
})

describe('E111 a refused CAIRN_AI_BASE fails closed', { skip: SKIP }, () => {
  test('E20 a take ends in a red "Transcription failed — …" and the fake sees nothing', async () => {
    await setup()
    const seen = fake.conns.length
    refused = await launch({
      vault, state: join(work, 'state-refused'), base: 'http://example.com', expect: 'http://127.0.0.1:9', wav: TAKE_WAV, work,
    })
    await refused.click(await btn(refused))
    await refused.until('the red Stop', STATE('recording'), 8000)
    await sleep(1000)
    await refused.click(await btn(refused))
    await refused.until('a failure line', `/^Transcription failed — /.test(document.querySelector('.ep-mic .mc-label').textContent)`, 15_000)
    // The colour fades in over the button's .16s transition.
    await sleep(400)
    const m = await refused.M('mic()')
    assert.deepEqual({ error: m.error, color: m.color, card: await refused.ev(NO_CARD) }, { error: true, color: RED, card: true })
    assert.equal(m.label, 'Transcription failed — transcription connection failed')
    assert.equal(fake.conns.length, seen, 'the refused base reached the fake')
    assert.deepEqual(refused.exceptions, [])
    await refused.close()
    refused = null
  })
})

describe('E111 Silero in Cairn\'s own page, on real speech (ruling 7)', { skip: SKIP }, () => {
  test('the take\'s VAD worker loads from app.js, hears speech, and is gone before the trimmed card opens', {
    skip: !SKIP && !existsSync(SPEECH) ? `no speech WAV at ${SPEECH} (set CAIRN_MIC_SPEECH_WAV): only this step is skipped` : false,
  }, async (t) => {
    await setup()
    speech = await launch({ vault, state: join(work, 'state-speech'), base: fake.base, wav: SPEECH, work })
    // Every dedicated worker is paused at its start, hooked, then let go: the
    // hook logs each of its replies to the page (warm, probabilities, the trim
    // work) without changing them.
    const workers = []
    const probe = []
    const HOOK = `(() => { const post = self.postMessage.bind(self); self.postMessage = (m, o) => {
      try { const r = { ok: m.ok, error: m.error ?? null };
        if (m.probs) { let max = 0, voiced = 0; for (const p of m.probs) { if (p > max) max = p; if (p >= 0.5) voiced++ } Object.assign(r, { kind: 'probabilities', frames: m.probs.length, max, voiced }) }
        else if ('bounds' in m) r.kind = 'bounds'; else if (m.blob) Object.assign(r, { kind: 'wav', type: m.blob.type, size: m.blob.size }); else r.kind = 'warm';
        r.ort = typeof ort === 'object' ? ort.env.versions?.web ?? 'loaded' : null;
        console.log('cairn-vad-probe ' + JSON.stringify(r)) } catch (e) { console.log('cairn-vad-probe-error ' + e) }
      return post(m, o) }; return 1 })()`
    speech.on('Target.attachedToTarget', (p) => {
      if (p.targetInfo.type !== 'worker') return
      const w = { sessionId: p.sessionId, at: Date.now(), gone: null }
      workers.push(w)
      void (async () => {
        await speech.send('Runtime.enable', {}, p.sessionId)
        await speech.send('Runtime.evaluate', { expression: HOOK }, p.sessionId)
        await speech.send('Runtime.runIfWaitingForDebugger', {}, p.sessionId)
      })().catch((e) => probe.push({ hookError: String(e) }))
    })
    speech.on('Target.detachedFromTarget', (p) => { for (const w of workers) if (w.sessionId === p.sessionId) w.gone = Date.now() })
    speech.on('Runtime.consoleAPICalled', (p, sessionId) => {
      if (!sessionId) return
      const line = p.args.map((a) => a.value ?? '').join(' ')
      if (line.startsWith('cairn-vad-probe')) probe.push(line.startsWith('cairn-vad-probe ') ? JSON.parse(line.slice(16)) : { hookError: line })
    })
    await speech.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true })

    fake.script({ text: 'A sentence of speech.', first_word_ms: 300, last_word_ms: 3000 })
    await take(speech, 3500)
    await speech.until('the card', CARD, 20_000)
    const cardAt = Date.now()
    const t0 = Date.now()
    while (!workers.every((w) => w.gone) && Date.now() - t0 < 2000) await sleep(25)
    const clip = await speech.M('clip()')
    t.diagnostic(`workers ${JSON.stringify(workers.map((w) => ({ goneAfterCardMs: w.gone && w.gone - cardAt })))}; ` +
      `replies ${JSON.stringify(probe)}; clip ${JSON.stringify(clip)}`)
    assert.equal(workers.length, 1, 'one take, one VAD worker')
    assert.ok(workers[0].gone !== null, 'the VAD worker outlived the trim')
    assert.equal(probe.filter((r) => r.hookError).length, 0, JSON.stringify(probe))
    const warm = probe.find((r) => r.kind === 'warm')
    assert.ok(warm && warm.ok, 'Silero never warmed in the page')
    assert.ok(warm.ort, 'onnxruntime was not loaded in the worker')
    const probs = probe.filter((r) => r.kind === 'probabilities')
    assert.equal(probs.length, 1, 'the trim asked the VAD no question, or asked twice')
    assert.ok(probs[0].ok && probs[0].frames > 50, 'no probabilities came back')
    assert.ok(probs[0].max >= 0.9 && probs[0].voiced > 20, `Silero heard no speech in speech: ${JSON.stringify(probs[0])}`)
    assert.ok(probe.every((r) => r.ok), 'a VAD call failed')
    assert.equal(clip?.type, 'audio/wav', 'the card plays the untrimmed recording')
    assert.ok(clip.duration > 0.5 && clip.duration < 3.5, `the trimmed clip is ${clip.duration} s of a 3.5 s take`)
    assert.deepEqual(speech.consoleLines.filter((l) => /cairn\[mic/.test(l)), [], 'the microphone reported errors')
    assert.deepEqual(speech.exceptions, [])
    await speech.close()
    speech = null
  })
})
