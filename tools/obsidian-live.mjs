#!/usr/bin/env node
/**
 * tools/obsidian-live.mjs — ask the LIVE Obsidian a question, on Debian.
 *
 * ===========================================================================
 * WHY THIS EXISTS
 * ===========================================================================
 * CONTRACT §0.17's method is "when the question is 'what does Obsidian do',
 * read Obsidian", and for a fortnight that meant reading `app.css`/`app.js` out
 * of the asar and rebuilding a piece of its DOM by hand in the pinned engine.
 * That works, and it has been wrong twice in one session: a hand-built harness
 * answers for the DOM you gave it, and the question is usually whether that is
 * the DOM Obsidian builds.
 *
 * `tools/run-g10.sh` already drives the live Obsidian — on macOS, for pixels.
 * This is the Debian counterpart, for MEASUREMENTS: it starts Obsidian on an
 * isolated profile, opens a note, evaluates an expression in its renderer and
 * prints the result.
 *
 *   node tools/obsidian-live.mjs --vault DIR [--open NAME] --eval 'JS'
 *   node tools/obsidian-live.mjs --vault DIR --open ground_truth \
 *        --eval "getComputedStyle(document.querySelector('.metadata-container')).marginBottom"
 *
 * `--eval` may be an async expression; its value is printed. `--keep` leaves the
 * instance running and prints the debugging port, for a session of questions.
 *
 * ── `--config-from` AND `--sidebar` ARE NOT CONVENIENCES ───────────────────
 * A fresh profile is Obsidian's DEFAULTS, and the defaults are not what anyone
 * is running. The first measurement taken with this tool was against
 * `readableLineLength: true` (Obsidian's default; the user's vault says false),
 * which capped its content column at 700px against Cairn's 1064 — so a property
 * value wrapped onto an extra line, the block below it moved 21px, and a
 * comparison of the two apps reported a difference that belonged to my own test
 * profile. `--config-from VAULT` copies that vault's `app.json` and
 * `appearance.json` in; `--sidebar N` sets the left split, because §0.26.4 says
 * compare only at an identical sidebar width and Obsidian's default is 300
 * where Cairn's is 412.
 *
 * With both set, every number matched Cairn's to the sub-device-pixel (§0.41).
 *
 * ── IT DOES NOT TOUCH THE USER'S OBSIDIAN, AND THAT IS THE DESIGN ──────────
 * A fresh `--user-data-dir` gives Electron a different single-instance lock, so
 * this starts a SECOND Obsidian beside whatever is already open instead of
 * focusing it. Nothing is written to `~/.config/obsidian`. Obsidian writes
 * `.obsidian/workspace.json` into whatever vault it opens, so `--vault` must be
 * a directory under the platform temp dir: copy the note you care about into a
 * temp vault. Anything else is refused unless `--allow-vault-writes` is given.
 *
 * ── IT RUNS 1.13.7, NOT /opt's 1.12.7 ─────────────────────────────────────
 * The `/opt/Obsidian/obsidian` binary loads the newest `obsidian-*.asar` it
 * finds in its user-data-dir and falls back to the Debian package's payload,
 * which is 1.12.7 (CLAUDE.md's box on WHICH ASAR). A fresh profile has no asar
 * at all, so this copies the newest one out of `~/.config/obsidian` first —
 * without which every measurement is of a build the user is not running.
 *
 * ── MAXIMIZE ──────────────────────────────────────────────────────────────
 * The window is maximized before anything is measured, by the user's own
 * instruction and for §0.26.4's reason: a fractional pane width moves a wrap
 * and nothing else looks wrong. `Browser.setWindowBounds` is NOT available on a
 * page session here, so the renderer maximizes itself through `@electron/remote`
 * — which works because Obsidian's own window has node integration.
 */

import { spawn } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'

const BIN = '/opt/Obsidian/obsidian'
const CONFIG = join(homedir(), '.config', 'obsidian')

function arg(name, fallback = null) {
  const i = process.argv.indexOf('--' + name)
  return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback
}
const has = (name) => process.argv.includes('--' + name)

const VAULT = arg('vault')
const CONFIG_FROM = arg('config-from')
const SIDEBAR = arg('sidebar')
const OPEN = arg('open')
const EVAL = arg('eval')
const PORT = Number(arg('port', '9422'))
const KEEP = has('keep')

if (!VAULT || (!EVAL && !KEEP)) {
  console.error("usage: obsidian-live.mjs --vault DIR [--config-from VAULT] [--sidebar N]")
  console.error("                          [--open NAME] [--port N] [--keep] [--allow-vault-writes] --eval 'JS'")
  process.exit(2)
}

/* CONTAINMENT. Opening a vault writes into it (Obsidian's own
 * `workspace.json`, and `app.json`/`appearance.json` under `--config-from`), so
 * the vault must sit strictly under the platform temp dir, with symlinks
 * resolved, unless `--allow-vault-writes` says otherwise. Checked before
 * anything else is touched. */
const real = (p) => { try { return realpathSync(p) } catch { return null } }
function underTmpDir(p) {
  const target = resolve(p)
  const probe = real(target) ?? (real(dirname(target)) ?? dirname(target)) + sep + basename(target)
  const root = real(tmpdir()) ?? resolve(tmpdir())
  return probe !== root && probe.startsWith(root + sep)
}
const ALLOW_WRITES = has('allow-vault-writes')
if (!ALLOW_WRITES && !underTmpDir(VAULT)) {
  console.error('obsidian-live: REFUSED to open ' + VAULT + ': Obsidian writes .obsidian/workspace.json into any vault it opens')
  console.error('obsidian-live: copy the note into a temp vault under ' + tmpdir() + ' first, or pass --allow-vault-writes')
  process.exit(2)
}

if (!existsSync(BIN)) {
  console.error('obsidian-live: ' + BIN + ' is missing — this tool is Debian-only')
  process.exit(3)
}

/** The newest `obsidian-<version>.asar` the user's own Obsidian has downloaded. */
function newestAsar() {
  let best = null
  for (const f of readdirSync(CONFIG)) {
    const m = /^obsidian-(\d+)\.(\d+)\.(\d+)\.asar$/.exec(f)
    if (!m) continue
    const v = [Number(m[1]), Number(m[2]), Number(m[3])]
    if (best === null || v > best.v) best = { f, v }
  }
  return best
}

/* The vault's OWN settings, or the answer is about Obsidian's defaults. The
 * vault itself passed the containment check above. */
if (CONFIG_FROM) {
  const dst = join(VAULT, '.obsidian')
  mkdirSync(dst, { recursive: true })
  for (const f of ['app.json', 'appearance.json']) {
    const src = join(CONFIG_FROM, '.obsidian', f)
    if (existsSync(src)) copyFileSync(src, join(dst, f))
  }
}

const work = mkdtempSync(join(tmpdir(), 'cairn-obslive-'))
const data = join(work, 'data')
mkdirSync(data, { recursive: true })
const asar = newestAsar()
if (asar) copyFileSync(join(CONFIG, asar.f), join(data, asar.f))
writeFileSync(join(data, 'obsidian.json'), JSON.stringify({
  vaults: { aaaaaaaaaaaaaaaa: { path: VAULT, ts: Date.now(), open: true } },
  disableGpu: true,
}))

const child = spawn(BIN, [
  '--user-data-dir=' + data,
  '--remote-debugging-port=' + PORT,
  '--no-sandbox',
  '--disable-gpu',
], { stdio: ['ignore', 'pipe', 'pipe'], detached: false })
child.stdout.on('data', () => {})
child.stderr.on('data', () => {})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function pageTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + PORT + '/json')).json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch { /* not listening yet */ }
    await sleep(500)
  }
  throw new Error('obsidian-live: no page target after 30s')
}

let page
try {
  page = await pageTarget()
} catch (e) {
  console.error('obsidian-live: ' + (e?.message ?? e))
  try { child.kill('SIGTERM') } catch { /* ignore */ }
  await new Promise((done) => {
    let s = false
    const f = () => { if (!s) { s = true; done() } }
    child.once('exit', f)
    setTimeout(() => { try { child.kill('SIGKILL') } catch { /* gone */ } f() }, 4000)
  })
  try { rmSync(work, { recursive: true, force: true }) } catch { /* best effort */ }
  process.exit(1)
}
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
})
// Bounded open: a wedged target must fail loudly, not hang with no output.
await Promise.race([
  new Promise((r, rej) => {
    ws.addEventListener('open', r)
    ws.addEventListener('error', (e) => rej(new Error('obsidian-live: websocket error: ' + (e?.message ?? e))))
  }),
  new Promise((_, rej) => setTimeout(() => rej(new Error('obsidian-live: websocket open timed out after 15s')), 15_000)),
])

const CDP_TIMEOUT_MS = 30_000
const send = (method, params = {}) => new Promise((res, rej) => {
  const n = ++id
  const timer = setTimeout(() => {
    if (pending.delete(n)) rej(new Error(`obsidian-live: CDP ${method} timed out after ${CDP_TIMEOUT_MS} ms`))
  }, CDP_TIMEOUT_MS)
  if (typeof timer.unref === 'function') timer.unref()
  pending.set(n, (m) => {
    clearTimeout(timer)
    if (m.error) rej(new Error(JSON.stringify(m.error)))
    else res(m.result)
  })
  try {
    ws.send(JSON.stringify({ id: n, method, params }))
  } catch (e) {
    clearTimeout(timer)
    pending.delete(n)
    rej(e)
  }
})

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) {
    throw new Error('obsidian-live eval: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
  }
  return r.result.value
}

await send('Runtime.enable')
// The vault has to finish loading before `app.vault` answers anything.
for (let i = 0; i < 40; i++) {
  // Optional chaining throughout: `app` can exist for a moment with no
  // `workspace`, and a THROW out of the readiness probe aborts the whole run
  // with `Cannot read properties of undefined (reading 'layoutReady')` —
  // which reads like a broken query and is really "ask again in 500ms".
  const ready = await evaluate(
    "(() => { try { return typeof app !== 'undefined' && !!app?.vault && !!app?.workspace?.layoutReady }" +
    " catch (e) { return false } })()"
  )
  if (ready) break
  await sleep(500)
}

// §0.26.4 — maximized, always, before anything is measured.
await evaluate(
  "(() => { try { const { getCurrentWindow } = require('@electron/remote'); getCurrentWindow().maximize(); return 1 }" +
  " catch (e) { try { require('electron').remote.getCurrentWindow().maximize(); return 2 } catch (e2) { return 0 } } })()"
)
await sleep(900)

// §0.26.4 — an identical sidebar width, or the content columns differ and every
// wrap below them differs with it.
if (SIDEBAR) {
  await evaluate('app.workspace.leftSplit.setSize(' + Number(SIDEBAR) + ')')
  await sleep(1200)
}

if (OPEN) {
  const opened = await evaluate(
    // The pieces are joined with NEWLINES, not nothing: without them
    // `… >= 0)` runs straight into `if (…)` and the page answers
    // `SyntaxError: Unexpected token 'if'` — which is a long way from
    // anything about Obsidian.
    [
      '(async () => {',
      '  const f = app.vault.getFiles().find((x) => x.path.indexOf(' + JSON.stringify(OPEN) + ') >= 0)',
      '  if (!f) return null',
      '  await app.workspace.getLeaf().openFile(f)',
      '  await new Promise((r) => setTimeout(r, 2000))',
      '  return f.path',
      '})()',
    ].join('\n')
  )
  if (opened === null) {
    console.error('obsidian-live: no file matching ' + JSON.stringify(OPEN) + ' in ' + VAULT)
    try { ws.close() } catch { /* ignore */ }
    try { child.kill('SIGTERM') } catch { /* ignore */ }
    await new Promise((done) => {
      let s = false
      const f = () => { if (!s) { s = true; done() } }
      child.once('exit', f)
      setTimeout(() => { try { child.kill('SIGKILL') } catch { /* gone */ } f() }, 4000)
    })
    try { rmSync(work, { recursive: true, force: true }) } catch { /* best effort */ }
    process.exit(4)
  }
  console.error('obsidian-live: opened ' + opened)
}

let _exitCode = 0
let _keep = false
async function killObsidian() {
  // CLAUDE.md §3: kill every process you spawn, including on the error path —
  // AND WAIT FOR IT.
  try { ws.close() } catch { /* already closed */ }
  await new Promise((done) => {
    let settled = false
    const finish = () => { if (!settled) { settled = true; done() } }
    child.once('exit', finish)
    try { child.kill('SIGTERM') } catch { finish() }
    setTimeout(() => { try { child.kill('SIGKILL') } catch { /* already gone */ } finish() }, 4000)
  })
  if (!_keep) {
    try { rmSync(work, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}
try {
  if (EVAL) console.log(await evaluate(EVAL))

  if (KEEP) {
    _keep = true
    console.error('obsidian-live: left running on port ' + PORT + ' (profile ' + data + ')')
    console.error('obsidian-live: kill it with  pkill -f "user-data-dir=' + data + '"')
    try { ws.close() } catch { /* ignore */ }
    child.unref()
    process.exit(0)
  }
} catch (e) {
  _exitCode = 1
  console.error('obsidian-live: ' + (e?.message ?? e))
} finally {
  if (!_keep) await killObsidian()
}
if (_exitCode !== 0) process.exit(_exitCode)
