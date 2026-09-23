/**
 * electron-shell/sync-client.test.mjs -- CONTRACT §7.3 case 9 against a REAL
 * sync client.  This is gap **G-d** in `docs/DATA-LOSS-VERIFICATION.md`.
 *
 * ===========================================================================
 * WHAT G-d SAID, AND WHAT CHANGED
 * ===========================================================================
 * That row reads: *"a real cloud client was **not** installed or driven"*, and
 * gives two reasons -- installing or authenticating a sync client is out of
 * scope for a verification run, and **a synced folder cannot live inside a
 * temp fixture**.  Both were true of iCloud Drive and of Dropbox, which are
 * accounts before they are software and whose folder lives at a fixed path
 * under `$HOME`.
 *
 * Neither is true of **Syncthing**, which §7.3 case 9 names in the same breath
 * as the other two:
 *   * it needs no account, no authentication and no network -- two instances
 *     on one machine sync to each other over `127.0.0.1`;
 *   * it syncs **any** directory, so the fixture stays inside `$TMPDIR` and
 *     the containment rule is kept exactly as `dataloss.rs` keeps it.
 *
 * So this drives a real sync client over a real vault: a real daemon, real
 * scanning, real block transfer, real conflict resolution.  It is not a
 * simulation of one, and nothing here writes a `.sync-conflict-` file by hand.
 *
 * ===========================================================================
 * IT NEVER TOUCHES THE USER'S OWN SYNCTHING, AND THAT IS ENFORCED
 * ===========================================================================
 * This machine runs Syncthing for real.  Every instance started here is
 * therefore fenced off before it is allowed to run, and the fence is in the
 * config file BEFORE the first `serve`, not applied over the REST API after
 * it -- a daemon that starts on the defaults has already bound `0.0.0.0:22000`
 * and already announced itself to the global discovery servers by the time an
 * API call could reshape it.  (Measured, on the way to writing this: an
 * earlier draft configured over REST and the instances came up on port 22000,
 * fighting the user's real daemon for the UDP socket.)
 *
 *   * `--home` is a fresh directory under `$TMPDIR`.  The real instance's home
 *     (`~/Library/Application Support/Syncthing`) is never opened, read or
 *     written.
 *   * `listenAddress` is `tcp://127.0.0.1:<high port>`, not `default`.
 *   * global discovery, local discovery, relays, NAT traversal, usage
 *     reporting, crash reporting and the browser launch are all **off**.
 *   * the two devices are introduced to each other by explicit
 *     `tcp://127.0.0.1:<port>` addresses.  There is no discovery of any kind,
 *     so there is nothing for a third device to find.
 *   * every process spawned is killed on every exit path, and the teardown
 *     ASSERTS they are gone.
 *
 * ===========================================================================
 * WHAT IT PROVES, AND WHAT IT DOES NOT
 * ===========================================================================
 * PROVES, against a live sync daemon:
 *   1. Syncthing's own marker directory is invisible to the tree.
 *   2. A note Cairn writes reaches the peer byte-identical and produces NO
 *      conflict copy -- case 9's first clause, which is a claim about our
 *      temp+rename write and could only be argued before.
 *   3. Cairn's `.`-prefixed PID-bearing temp file never reaches the peer.
 *   4. The peer's write into the open vault arrives as case 7: a real
 *      `nc://note-external-change` for the open note, from the real watcher.
 *   5. A REAL divergent edit -- both sides changed while disconnected -- ends
 *      with the user's own bytes preserved in a conflict copy, the vault
 *      converged, and Cairn reading both files.  **This is the data-loss
 *      statement of case 9** and it is now a measurement.
 *
 * DOES NOT PROVE:
 *   * **iCloud's evicted-placeholder path.**  CONTRACT §5.12's "an iCloud
 *     'evicted' placeholder reads as a 0-byte file" is a property of
 *     `bird`/CloudDocs, not of sync clients in general, and Syncthing has no
 *     equivalent -- it either has the file or does not.  That half of G-d
 *     stays open, and this machine cannot close it: it is not signed in to
 *     iCloud (`~/Library/Mobile Documents` does not exist), so there is no
 *     iCloud Drive here to drive.
 *   * Dropbox's or OneDrive's rename semantics, which differ from both.
 *
 * Run: node --test electron-shell/sync-client.test.mjs
 * Needs: `syncthing` on PATH and `electron-shell/cairn.node` built.
 * Takes ~90 s: a real sync daemon scans, connects and converges on its own
 * clock, and nothing here can hurry it.
 */

import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { loadAddon, nativeCommands } from './native.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)

/* The REAL frame decoder, the same one `native.test.mjs` drives and the same
   one `src/ipc.ts` calls: `read_note` returns §2's note FRAME, not raw text,
   and a test that compares its bytes to a string is comparing a header to
   nothing.  (It fails loudly rather than quietly -- the magic is `ETON` in
   little-endian -- which is how this was caught.) */
const { decodeNote } = await import(pathToFileURL(join(ROOT, 'src', 'note_frame.js')).href)
const which = (bin) => spawnSync('which', [bin], { encoding: 'utf8' }).stdout.trim()
const SYNCTHING = process.env.SYNCTHING_BIN ?? which('syncthing')

/* THE PORT-PROBING FLAG IS ASKED OF THE BINARY, NOT HARDCODED.
 *
 * This file spelled it `--no-port-probing`, and on the syncthing installed here
 * -- v1.29.5, the Debian package -- that flag exists on NEITHER `generate` NOR
 * `serve`: both spell it `--skip-port-probing`, and syncthing exits 1 with
 * `unknown flag`. The old single-dash CLI (pre-1.18, before kong) did carry
 * `-no-port-probing`, so the spelling was real once and is not now.
 *
 * WHAT THAT COST: `before()` threw, so the ONLY executable coverage of
 * DATA-LOSS gap G-d was RED on Debian and did not skip -- five failures that
 * look like a data-loss regression and are a CLI rename. That is the inverse of
 * CONTRACT §0.22.2 E40's trap: not a skip wearing a pass, but a version
 * mismatch wearing a defect.
 *
 * PROBING IS THE FIX RATHER THAN A NEW LITERAL, because a literal would only
 * move the failure to whichever machine has the other one -- and `sync-client 5
 * pass` in CLAUDE.md's macOS block is a real run, on a syncthing this repo has
 * never named. `--help` is the binary's own answer about itself; without the
 * flag the daemon rewrites the ports it was told to use, which the fence in
 * `fenceConfig` then does not cover, so proceeding without it is not an option.
 */
function probeFlag() {
  if (!SYNCTHING) return null
  for (const sub of ['generate', 'serve']) {
    const h = spawnSync(SYNCTHING, [sub, '--help'], { encoding: 'utf8' })
    const text = (h.stdout ?? '') + (h.stderr ?? '')
    if (h.status !== 0 && !text) return null
    for (const flag of ['--skip-port-probing', '--no-port-probing']) {
      if (text.includes(flag)) return flag
    }
    return null      // the subcommand answered and offers neither
  }
  return null
}
const PORT_PROBE_FLAG = probeFlag()
const VERSION = SYNCTHING
  ? (spawnSync(SYNCTHING, ['--version'], { encoding: 'utf8' }).stdout ?? '').split('\n')[0].trim()
  : ''

const SKIP =
  !SYNCTHING
    ? 'syncthing is not on PATH. This test drives a REAL sync client (CONTRACT §7.3 case 9, ' +
      'DATA-LOSS gap G-d); with no client there is nothing to drive, and a simulated one would ' +
      'prove nothing this repo does not already prove in cases 1, 1b and 7. ' +
      'Install it (brew install syncthing) or set SYNCTHING_BIN.'
    : !PORT_PROBE_FLAG
      ? 'this syncthing advertises neither --skip-port-probing nor --no-port-probing (' +
        (VERSION || SYNCTHING) + '). Without it the daemon rewrites the ports it was given on ' +
        'first start, and `fenceConfig` no longer fences the instance to 127.0.0.1 -- which is ' +
        'the one outcome this file must never produce. Reported as NOT TAKEN rather than run ' +
        'unfenced, and rather than failed: a CLI rename is not a data-loss regression.'
      : !existsSync(join(HERE, 'cairn.node'))
        ? 'electron-shell/cairn.node is missing -- run: npm run electron:native'
        : false

/* Ports well away from Syncthing's defaults (22000 sync, 8384 GUI) so that a
   mistake here cannot collide with the user's real instance even by accident. */
const PORTS = { syncA: 42001, syncB: 42002, guiA: 42101, guiB: 42102 }
const KEY = 'cairn-dataloss-case9-key'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let work = null
const procs = []
const events = []
let cmd = null
let inst = null

/**
 * Kill everything this file started, and PROVE it is gone.
 *
 * ASYNCHRONOUSLY, and that is not a style choice: a synchronous wait loop
 * blocks the event loop, so node never processes the children's `exit` events
 * and `exitCode` stays null for processes that died instantly.  The first
 * draft of this function reported "still alive" about two corpses.
 */
async function killAll(timeoutMs = 5000) {
  const waits = procs.map((p) => {
    if (p.exitCode !== null || p.signalCode !== null) return Promise.resolve(true)
    const done = new Promise((res) => p.once('exit', () => res(true)))
    try { p.kill('SIGKILL') } catch { return Promise.resolve(true) }
    return Promise.race([done, sleep(timeoutMs).then(() => false)])
  })
  return (await Promise.all(waits)).every(Boolean)
}
/* The exit hook is best-effort and synchronous by necessity: whatever survives
   it is reparented and killed by the OS when this process goes. */
process.on('exit', () => {
  for (const p of procs) { try { p.kill('SIGKILL') } catch {} }
  if (work) { try { rmSync(work, { recursive: true, force: true }) } catch {} }
})

/**
 * The fence, applied to the generated config BEFORE the first `serve`.
 * Every substitution is asserted to have changed something: a silently
 * ineffective regex here means a daemon on the default ports with global
 * discovery on, which is the one outcome this file must never produce.
 */
function fenceConfig(configPath, listenPort) {
  let xml = readFileSync(configPath, 'utf8')
  const subs = [
    [/<listenAddress>default<\/listenAddress>/, '<listenAddress>tcp://127.0.0.1:' + listenPort + '</listenAddress>'],
    [/<globalAnnounceEnabled>true<\/globalAnnounceEnabled>/, '<globalAnnounceEnabled>false</globalAnnounceEnabled>'],
    [/<localAnnounceEnabled>true<\/localAnnounceEnabled>/, '<localAnnounceEnabled>false</localAnnounceEnabled>'],
    [/<relaysEnabled>true<\/relaysEnabled>/, '<relaysEnabled>false</relaysEnabled>'],
    [/<natEnabled>true<\/natEnabled>/, '<natEnabled>false</natEnabled>'],
    [/<startBrowser>true<\/startBrowser>/, '<startBrowser>false</startBrowser>'],
    [/<urAccepted>0<\/urAccepted>/, '<urAccepted>-1</urAccepted>'],
    [/<crashReportingEnabled>true<\/crashReportingEnabled>/, '<crashReportingEnabled>false</crashReportingEnabled>'],
  ]
  for (const [re, to] of subs) {
    if (!re.test(xml)) throw new Error('the syncthing config fence did not match: ' + re + ' in ' + configPath)
    xml = xml.replace(re, to)
  }
  writeFileSync(configPath, xml)
}

async function api(i, path, opts = {}) {
  const r = await fetch('http://127.0.0.1:' + i.gui + path, {
    ...opts,
    headers: { 'X-API-Key': KEY, 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
  })
  const text = await r.text()
  if (!r.ok) throw new Error(path + ' -> ' + r.status + ' ' + text.slice(0, 200))
  try { return JSON.parse(text) } catch { return text }
}

/** Wait for a predicate, polling; returns how long it took, or throws. */
async function until(what, fn, timeoutMs = 60000, everyMs = 500) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (await fn()) return Date.now() - t0
    await sleep(everyMs)
  }
  throw new Error('timed out after ' + timeoutMs + ' ms waiting for: ' + what)
}

/** The instance's own device id, out of the `config.xml` `generate` just wrote. */
function deviceIdFrom(configPath) {
  const m = /<device\s+id="([A-Z0-9]{7}(?:-[A-Z0-9]{7}){7})"/.exec(readFileSync(configPath, 'utf8'))
  return m ? m[1] : ''
}

const conflictsIn = (dir) => readdirSync(dir).filter((n) => n.includes('.sync-conflict-'))
const notesIn = (dir) => readdirSync(dir).filter((n) => n.endsWith('.md')).sort()

/**
 * THE FOUR PORTS MUST BE FREE, AND A STRAY DAEMON IS SAID OUT LOUD.
 *
 * These ports are FIXED (see `PORTS`) so that a mistake here can never collide
 * with the user's own instance -- which is right, and it means a leaked daemon
 * from an earlier run of THIS FILE holds them. Two did: the run below came back
 * `1 pass 4 fail` with a confident-looking conflict-copy failure, and the cause
 * was two `syncthing serve --home=/tmp/cairn-case9-…` processes still listening
 * on 42001/42002/42101/42102 from a run whose node process had been killed
 * before `process.on('exit')` could sweep them.
 *
 * `--skip-port-probing` is what makes this detectable AND what makes it matter:
 * without it syncthing would quietly pick different ports and the two runs would
 * interleave invisibly. With it, the second instance fails to bind, and the
 * failures land several tests later on assertions about conflict copies.
 *
 * So: check first, and REFUSE rather than guess. This is CLAUDE.md §3's
 * "kill every process you spawn" from the other side -- the sweep is
 * best-effort by construction (a SIGKILLed parent runs no exit handler), so the
 * next run has to be able to say what it found.
 */
async function portsInUse() {
  const busy = []
  for (const port of Object.values(PORTS)) {
    const free = await new Promise((res) => {
      const srv = createServer()
      srv.once('error', () => res(false))
      srv.once('listening', () => srv.close(() => res(true)))
      srv.listen(port, '127.0.0.1')
    })
    if (!free) busy.push(port)
  }
  return busy
}

before(async () => {
  if (SKIP) return
  const busy = await portsInUse()
  assert.deepEqual(busy, [],
    'port(s) ' + busy.join(', ') + ' are already in use, so this run cannot fence its own ' +
    'instances. That is almost certainly a leaked daemon from an earlier run of THIS file -- ' +
    'check `pgrep -a syncthing` for a `--home=' + tmpdir() + '/cairn-case9-*` process and kill ' +
    'it. It is NOT the user\'s own syncthing, which does not use these ports.')
  work = mkdtempSync(join(tmpdir(), 'cairn-case9-'))
  inst = {
    a: { home: join(work, 'home-a'), dir: join(work, 'vault'), gui: PORTS.guiA, sync: PORTS.syncA },
    b: { home: join(work, 'home-b'), dir: join(work, 'peer'), gui: PORTS.guiB, sync: PORTS.syncB },
  }
  for (const k of ['a', 'b']) {
    const i = inst[k]
    mkdirSync(i.dir, { recursive: true })
    const g = spawnSync(SYNCTHING, ['generate', '--home=' + i.home, PORT_PROBE_FLAG], { encoding: 'utf8' })
    assert.equal(g.status, 0, 'syncthing generate failed: ' + g.stderr)
    const configPath = join(i.home, 'config.xml')
    /* THE DEVICE ID COMES OUT OF THE CONFIG, NOT OUT OF A SUBCOMMAND.
     * This file ran `syncthing device-id --home=…`, and v1.29.5 answers
     * `unexpected argument device-id` -- its whole command list is `serve`,
     * `generate`, `decrypt`, `cli`, `install-completions`. So `i.id` came back
     * EMPTY and the assertion below caught it, which is the right outcome and
     * the second CLI rename in one `before()`.
     * `generate` has always written the id into `config.xml` as
     * `<device id="…">`, and this file already parses and rewrites that very
     * file (`fenceConfig`), so the config is the stable source and needs no
     * version probe of its own. Read BEFORE fencing, so a fence that ever
     * rewrites the device block cannot silently change what the peer is told. */
    i.id = deviceIdFrom(configPath)
    assert.match(i.id, /^[A-Z0-9]{7}(-[A-Z0-9]{7}){7}$/, 'device id: ' + i.id)
    fenceConfig(configPath, i.sync)
  }
  for (const k of ['a', 'b']) {
    const i = inst[k]
    /* NO `--log-level`: v1.29.5 does not have it either (it offers `--verbose`,
     * `--logfile` and `--logflags`), and it was purely cosmetic here — the log
     * is captured below whatever the level. That is the THIRD CLI difference in
     * this one `before()`, after the port-probing flag and the `device-id`
     * subcommand, which is why the wait that follows now reports the daemon's
     * own output: three unknown-flag deaths in a row each presented as a bare
     * 60-second timeout, and the daemon had printed the answer every time. */
    const p = spawn(SYNCTHING, ['serve', '--home=' + i.home, '--gui-address=127.0.0.1:' + i.gui,
      '--gui-apikey=' + KEY, '--no-browser', '--no-restart', '--no-upgrade', PORT_PROBE_FLAG,
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    procs.push(p)
    i.proc = p
    i.log = []
    p.stdout.on('data', (d) => i.log.push(String(d)))
    p.stderr.on('data', (d) => i.log.push(String(d)))
  }
  for (const k of ['a', 'b']) {
    const i = inst[k]
    /* A DEAD DAEMON IS REPORTED AS DEAD, not as a timeout. `until` polls the
     * REST API, and a `serve` that exited on an unknown flag never opens the
     * port — so the bare timeout said "did not answer in 60 s" while the
     * process had printed `syncthing: error: unknown flag …` and exited 1 a
     * hundred milliseconds in. Checking `exitCode` first turns a 60-second
     * mystery into one line, and this file has now paid for that three times. */
    try {
      await until('syncthing ' + k + ' to answer', async () => {
        if (i.proc.exitCode !== null || i.proc.signalCode !== null) {
          throw new Error('the daemon exited before it opened its API port')
        }
        try { return (await api(i, '/rest/system/ping')).ping === 'pong' } catch { return false }
      }, 60000)
    } catch (e) {
      throw new Error(
        'syncthing ' + k + ' never answered: ' + e.message +
        '\n  exit=' + i.proc.exitCode + ' signal=' + i.proc.signalCode +
        '\n  version: ' + (VERSION || '(unknown)') +
        '\n  its own output:\n    ' + (i.log.join('').trim().split('\n').join('\n    ') || '(none)')
      )
    }
  }
  // The fence, verified against the RUNNING daemon rather than against the file
  // we wrote: a config that failed to load would otherwise pass silently.
  for (const k of ['a', 'b']) {
    const opt = await api(inst[k], '/rest/config/options')
    assert.deepEqual(opt.listenAddresses, ['tcp://127.0.0.1:' + inst[k].sync], k + ' listen address')
    assert.equal(opt.globalAnnounceEnabled, false, k + ' global discovery')
    assert.equal(opt.relaysEnabled, false, k + ' relays')
  }
  // Share one folder between exactly these two devices.
  for (const [k, other] of [['a', 'b'], ['b', 'a']]) {
    const cfg = await api(inst[k], '/rest/config')
    cfg.folders = [{
      id: 'cairn-case9', label: 'cairn-case9', path: inst[k].dir, type: 'sendreceive',
      devices: [{ deviceID: inst.a.id }, { deviceID: inst.b.id }],
      rescanIntervalS: 5, fsWatcherEnabled: true, fsWatcherDelayS: 1,
    }]
    cfg.devices = [
      { deviceID: inst[k].id, name: k },
      { deviceID: inst[other].id, name: other, addresses: ['tcp://127.0.0.1:' + inst[other].sync] },
    ]
    await api(inst[k], '/rest/config', { method: 'PUT', body: JSON.stringify(cfg) })
  }
  await until('the two devices to connect', async () => {
    const c = await api(inst.a, '/rest/system/connections')
    return c.connections?.[inst.b.id]?.connected === true
  }, 60000)

  // Cairn opens folder A as a vault, through the REAL core.
  writeFileSync(join(inst.a.dir, 'note.md'), 'the original body, written before the vault opened\n')
  const addon = loadAddon()
  cmd = nativeCommands(addon)
  addon.start((event, payload) => events.push({ event, payload }), () => {}, join(work, 'state.json'))
  const info = await cmd.open_vault({ path: inst.a.dir })
  assert.equal(info.watching, true, 'the watcher must be running for case 7 to be observable')
})

after(async () => {
  if (SKIP) return
  assert.equal(await killAll(), true, 'every syncthing instance this test started must be dead')
})

test('§7.3 case 9: syncthing\'s marker directory is invisible to the tree', { skip: SKIP }, async () => {
  await until('.stfolder to be created by syncthing', () => existsSync(join(inst.a.dir, '.stfolder')))
  const info = await cmd.rescan_all()
  assert.equal(info.nDirs, 0, 'the tree must not show .stfolder as a folder')
  assert.equal(info.nNotes, 1, 'only note.md is a note')
})

test('§7.3 case 9: a note CAIRN writes reaches the peer byte-identical, with NO conflict copy', { skip: SKIP }, async () => {
  const body = '# written by cairn\n\nthrough write_note, temp + rename, into a folder a real sync daemon is watching.\n'
  const res = await cmd.write_note({
    path: 'note.md', text: new TextEncoder().encode(body), flags: 0, baseMtimeMs: null, create: false,
  })
  assert.ok(res, 'write_note returned')
  const ms = await until('the peer to receive cairn\'s bytes', () => {
    const p = join(inst.b.dir, 'note.md')
    return existsSync(p) && readFileSync(p, 'utf8') === body
  }, 60000)
  assert.equal(readFileSync(join(inst.b.dir, 'note.md'), 'utf8'), body)
  // The clause that could only be argued before: our own write is temp+rename
  // INSIDE the same directory, so the daemon sees one atomic replacement and
  // has nothing to conflict with.
  await sleep(3000)
  assert.deepEqual(conflictsIn(inst.a.dir), [], 'cairn\'s own write made a conflict copy in the vault')
  assert.deepEqual(conflictsIn(inst.b.dir), [], 'cairn\'s own write made a conflict copy on the peer')
  assert.ok(ms < 60000)
})

test('§7.3 case 9: cairn\'s temp file never reaches the peer, and none is left behind', { skip: SKIP }, async () => {
  // Ten writes back to back: if the temp name were ever exposed to the daemon
  // for long enough to be indexed, ten passes is where it shows up.
  for (let i = 0; i < 10; i++) {
    await cmd.write_note({
      path: 'note.md', text: new TextEncoder().encode('rev ' + i + '\n'), flags: 0, baseMtimeMs: null, create: false,
    })
  }
  await until('the peer to catch up to rev 9', () => {
    const p = join(inst.b.dir, 'note.md')
    return existsSync(p) && readFileSync(p, 'utf8') === 'rev 9\n'
  }, 60000)
  await sleep(2000)
  const strays = (dir) => readdirSync(dir).filter((n) => n !== '.stfolder' && n.startsWith('.'))
  assert.deepEqual(strays(inst.a.dir), [], 'a temp file was left in the vault: ' + strays(inst.a.dir))
  assert.deepEqual(strays(inst.b.dir), [], 'a temp file was synced to the peer: ' + strays(inst.b.dir))
  assert.deepEqual(notesIn(inst.a.dir), ['note.md'])
  assert.deepEqual(notesIn(inst.b.dir), ['note.md'])
})

test('§7.3 case 9 -> case 7: the PEER\'s write arrives as a real external change', { skip: SKIP }, async () => {
  // `read_note` is what sets `AppState.open_note` (app.rs:666), and that is
  // what `nc://note-external-change` is filtered by (§1.4).
  await cmd.read_note({ path: 'note.md' })
  events.length = 0
  const fromPeer = 'edited on the OTHER device, by a real sync client\n'
  writeFileSync(join(inst.b.dir, 'note.md'), fromPeer)
  await until('the vault to receive the peer\'s bytes', () =>
    readFileSync(join(inst.a.dir, 'note.md'), 'utf8') === fromPeer, 60000)
  await until('nc://note-external-change for the open note', () =>
    events.some((e) => e.event === 'nc://note-external-change' && e.payload?.path === 'note.md'), 20000)
  const ext = events.find((e) => e.event === 'nc://note-external-change')
  assert.equal(ext.payload.path, 'note.md')
  assert.equal(ext.payload.size, Buffer.byteLength(fromPeer), 'the event carries the new size')
  const back = decodeNote(await cmd.read_note({ path: 'note.md' }))
  assert.equal(back.text, fromPeer, 'read_note returns the peer\'s bytes, not a cached copy')
})

test('§7.3 case 9: a REAL divergent edit keeps both versions -- nothing is lost', { skip: SKIP }, async () => {
  // Disconnect the two devices, edit the same note on both sides, reconnect.
  // This is the only path that makes syncthing produce a conflict copy, and it
  // is produced BY SYNCTHING -- nothing here writes a .sync-conflict- name.
  for (const [k, other] of [['a', 'b'], ['b', 'a']]) {
    const cfg = await api(inst[k], '/rest/config')
    cfg.devices = cfg.devices.map((d) => (d.deviceID === inst[other].id ? { ...d, paused: true } : d))
    await api(inst[k], '/rest/config', { method: 'PUT', body: JSON.stringify(cfg) })
  }
  await until('the devices to disconnect', async () => {
    const c = await api(inst.a, '/rest/system/connections')
    return c.connections?.[inst.b.id]?.connected !== true
  }, 30000)

  const mine = '# MY edit, made in cairn while the devices were apart\n\nthis text must survive.\n'
  await cmd.write_note({ path: 'note.md', text: new TextEncoder().encode(mine), flags: 0, baseMtimeMs: null, create: false })
  const theirs = '# THEIR edit, made on the other device at the same time\n'
  writeFileSync(join(inst.b.dir, 'note.md'), theirs)
  // Make the peer's version unambiguously newer, so which side loses is a
  // decided question and not a race this test would flake on.
  const later = new Date(Date.now() + 5000)
  utimesSync(join(inst.b.dir, 'note.md'), later, later)
  await sleep(2000)

  for (const [k, other] of [['a', 'b'], ['b', 'a']]) {
    const cfg = await api(inst[k], '/rest/config')
    cfg.devices = cfg.devices.map((d) => (d.deviceID === inst[other].id ? { ...d, paused: false } : d))
    await api(inst[k], '/rest/config', { method: 'PUT', body: JSON.stringify(cfg) })
  }
  await until('the devices to reconnect', async () => {
    const c = await api(inst.a, '/rest/system/connections')
    return c.connections?.[inst.b.id]?.connected === true
  }, 60000)

  const ms = await until('syncthing to resolve the conflict in the vault', () => conflictsIn(inst.a.dir).length > 0, 90000)
  const conflicts = conflictsIn(inst.a.dir)
  assert.equal(conflicts.length, 1, 'exactly one conflict copy: ' + conflicts.join(', '))
  assert.match(conflicts[0], /^note\.sync-conflict-\d{8}-\d{6}-[A-Z0-9]+\.md$/, conflicts[0])

  // THE DATA-LOSS STATEMENT: my edit is still on disk, byte for byte.
  const kept = readFileSync(join(inst.a.dir, conflicts[0]), 'utf8')
  assert.equal(kept, mine, 'the losing side\'s bytes must be preserved in the conflict copy')
  assert.equal(readFileSync(join(inst.a.dir, 'note.md'), 'utf8'), theirs, 'the winning version is in place')

  // And cairn sees both, as ordinary notes.
  const info = await cmd.rescan_all()
  assert.equal(info.nNotes, 2, 'the tree carries the note and its conflict copy')
  const viaCairn = decodeNote(await cmd.read_note({ path: conflicts[0] }))
  assert.equal(viaCairn.text, mine, 'cairn can open the conflict copy and it holds my edit')
  assert.ok(ms < 90000)
})
