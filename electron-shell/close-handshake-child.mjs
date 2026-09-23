/**
 * electron-shell/close-handshake-child.mjs -- one scenario of §1.6, in its own
 * process. Driven by `close-handshake.test.mjs`; not useful on its own.
 *
 * A SEPARATE PROCESS PER SCENARIO IS NOT CEREMONY. `AppState.close_ok` is a
 * process-wide latch with no reset -- once §1.6 has been answered, every later
 * `begin_close` returns false, which is exactly the property the accept path
 * has to prove. So the accept and watchdog paths CANNOT share a process, and a
 * quit is a fresh process in the real app anyway.
 *
 * `dataloss.rs` reaches for the same shape for the same reason ("each spawns a
 * real second process").
 *
 * Prints exactly one line, `RESULT <json>`, and exits 0. Everything else it has
 * to say goes to stderr, where the parent captures it -- including the
 * watchdog's own "closing anyway and discarding whatever was unflushed".
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadAddon } from './native.mjs'

const SCENARIO = process.argv[2]
const SENTINEL = 'CLOSE-HANDSHAKE-SENTINEL'

const work = mkdtempSync(join(tmpdir(), 'cairn-close-'))
/* ONE TEMP DIRECTORY PER CHILD, AND THREE CHILDREN PER RUN, so this leaked a
   directory per scenario per run -- 24 of them had accumulated in $TMPDIR by
   2026-09-09. The same defect in `wire.test.mjs` was fixed in `d92db5a`; this
   copy was missed because the leak is in the CHILD, and the parent (which
   cleans up after itself) is where anyone would look.
   Safe to delete on exit: the parent reads this child's STDOUT `RESULT` line
   and never opens its directory -- `stateNow()` is read in-process, at the
   instant of the quit, which is the whole point of doing it here. */
process.on('exit', () => { try { rmSync(work, { recursive: true, force: true }) } catch {} })
const vault = join(work, 'vault')
const statePath = join(work, 'state.json')
mkdirSync(vault, { recursive: true })
writeFileSync(join(vault, 'note.md'), '# note\n')

const events = []
const quits = []
const addon = loadAddon()
/** Read at the instant of the quit, so no later debounce can be mistaken for the flush. */
const stateNow = () => (existsSync(statePath) ? readFileSync(statePath, 'utf8') : null)

addon.start(
  (event, payload) => events.push({ event, payload, at: Date.now() }),
  (code) => quits.push({ code, at: Date.now(), state: stateNow() }),
  statePath
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const flushEvents = () => events.filter((e) => e.event === 'nc://flush-and-close')
const done = (o) => {
  process.stdout.write('RESULT ' + JSON.stringify(o) + '\n')
  process.exit(0)
}

await addon.openVault(vault)

if (SCENARIO === 'accept') {
  /* The frontend answers YES. §1.6's ordering: editor buffer first (which is
     what `ok` MEANS), then `state.json`, then the process may go.

     THE SENTINEL IS WHAT MAKES THIS DISCRIMINATE. `save_ui_state` is debounced
     1,000 ms, so a `state.json` written by the debounce would prove nothing
     about `flush_now`. It is checked ABSENT first and the elapsed time is
     reported, so a run slow enough for the debounce to have fired is visible
     rather than a false pass. */
  const savedAt = Date.now()
  addon.saveUiState({ expanded: [SENTINEL] })
  const stateBefore = stateNow()

  const armed = addon.beginClose()
  addon.confirmClose(true, null)
  await sleep(200)

  const stateAfterQuit = quits.length > 0 ? quits[0].state : null
  const secondArm = addon.beginClose()

  // The watchdog from the FIRST arm must be disarmed by the answer. If the
  // token arithmetic were wrong, a second quit lands here.
  await sleep(2400)

  done({
    scenario: 'accept',
    armed,
    flushEvents: flushEvents().map((e) => e.payload),
    quits: quits.map((q) => q.code),
    stateBefore,
    stateAfterQuit,
    sentinelBefore: (stateBefore ?? '').includes(SENTINEL),
    sentinelAfterQuit: (stateAfterQuit ?? '').includes(SENTINEL),
    msFromSaveToQuit: quits.length > 0 ? quits[0].at - savedAt : null,
    secondArm,
  })
}

if (SCENARIO === 'reject') {
  /* A REJECTING FLUSH CANCELS THE CLOSE (B11/B18/M55). spec-03 §9.2's
     unconditional watchdog is STRUCK because "a watchdog that closes anyway is
     a silent discard wearing a timeout's clothes" -- so the thing to prove is
     that after a NO, NOTHING quits, for longer than the deadline. */
  const armed = addon.beginClose()
  addon.confirmClose(false, 'io')
  await sleep(2400)          // past CLOSE_DEADLINE_MS with room to spare
  const quitsAfterDeadline = quits.length

  // And the ✕ must still work afterwards: a cancelled close leaves the window
  // usable, so the handshake has to be re-armable.
  const secondArm = addon.beginClose()
  addon.confirmClose(false, 'io')
  await sleep(150)

  done({
    scenario: 'reject',
    armed,
    flushEvents: flushEvents().map((e) => e.payload),
    quitsAfterDeadline,
    quits: quits.map((q) => q.code),
    secondArm,
  })
}

if (SCENARIO === 'watchdog') {
  /* THE LEG THAT HAS NEVER BEEN EXECUTED, on any build. The frontend answers
     NOTHING -- a hung disk, not a refused write -- and after CLOSE_DEADLINE_MS
     the app closes anyway, having first put `state.json` on disk and said on
     stderr what it is discarding.

     THE SECOND SENTINEL IS THE DISCRIMINATOR. `open_vault`'s own debounced save
     lands around t+1,000 ms and does NOT contain it. This one is written at
     t+1,500, so ITS debounce would land at t+2,500 -- 500 ms AFTER the watchdog
     fires. If the file read inside the quit callback contains it, `flush_prefs`
     is what wrote it and nothing else could have. */
  const armedAt = Date.now()
  const armed = addon.beginClose()

  await sleep(1500)
  const stateBeforeSentinel = stateNow()
  addon.saveUiState({ expanded: [SENTINEL] })

  // Wait for the quit, with a ceiling well past the deadline so a watchdog that
  // never fires is a reported timeout rather than a hang.
  const until = Date.now() + 6000
  while (quits.length === 0 && Date.now() < until) await sleep(20)

  done({
    scenario: 'watchdog',
    armed,
    flushEvents: flushEvents().map((e) => e.payload),
    quits: quits.map((q) => q.code),
    msFromArmToQuit: quits.length > 0 ? quits[0].at - armedAt : null,
    stateBeforeSentinel,
    stateAtQuit: quits.length > 0 ? quits[0].state : null,
    sentinelBeforeIt: (stateBeforeSentinel ?? '').includes(SENTINEL),
    sentinelAtQuit: (quits.length > 0 ? (quits[0].state ?? '') : '').includes(SENTINEL),
  })
}

done({ scenario: SCENARIO, error: 'unknown scenario' })
