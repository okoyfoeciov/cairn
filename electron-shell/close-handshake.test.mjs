/**
 * electron-shell/close-handshake.test.mjs -- gap G-b, closed.
 *
 * `docs/DATA-LOSS-VERIFICATION.md` calls G-b "still the largest remaining gap
 * in §7". It is case 2: quit or close with a dirty buffer. Two things had never
 * been EXECUTED on any build -- `app::begin_close` and the 2,000 ms watchdog --
 * and the file says exactly why:
 *
 *   "begin_close and the watchdog live behind an AppHandle, which cannot be
 *    constructed outside a live Tauri runtime."
 *
 * Every other route was closed too: `core:window`'s default permission set is
 * 28 read-only entries with no `allow-close` (pinned by `dl_28`, so it cannot
 * be widened for a test), and the remaining routes need a TCC prompt on the
 * user's screen, which window etiquette refuses.
 *
 * §8.2 STEP 5 DISSOLVED ALL OF IT. There is no `AppHandle`. `beginClose()` and
 * `confirmClose()` are exported functions on the Node-API addon, `AppCtx::quit`
 * is a JavaScript callback this file can watch, and the whole handshake runs
 * headless in a child process in about two seconds. Nothing here needs a
 * window, a capability grant, or a second of the user's time.
 *
 * WHAT IS ACTUALLY BEING PROVED, and none of it was provable before:
 *   - the deadline is a real TIMER, not a constant in a source file (`dl_28`
 *     checked the constant; this measures the wall clock);
 *   - `state.json` is on disk BEFORE the process is allowed to go, and by
 *     `flush_now` rather than by the 1,000 ms debounce -- discriminated, not
 *     assumed;
 *   - **a rejecting flush cancels the close and the watchdog does NOT close
 *     anyway.** spec-03 §9.2's unconditional watchdog is STRUCK because "a
 *     watchdog that closes anyway is a silent discard wearing a timeout's
 *     clothes", and until now nothing had ever run past the deadline to check;
 *   - answering disarms the watchdog, so there is no second exit;
 *   - `close_ok` latches, so the ✕ after a confirmed quit goes straight through.
 *
 * Run: node --test electron-shell/close-handshake.test.mjs
 * (`electron-shell/cairn.node` must exist: npm run electron:native)
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CHILD = join(HERE, 'close-handshake-child.mjs')

/** CONTRACT §1.6 / `app.rs`'s `CLOSE_DEADLINE_MS`. */
const DEADLINE_MS = 2000

/**
 * Run one scenario in its own process and return its report plus its stderr.
 *
 * A FRESH PROCESS PER SCENARIO IS LOAD-BEARING: `close_ok` is a process-wide
 * latch with no reset, so the accept path and the watchdog path cannot coexist
 * in one -- and a quit is a fresh process in the real app anyway.
 */
function run(scenario) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [CHILD, scenario],
      { cwd: dirname(HERE), timeout: 30_000 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`${scenario}: ${err.message}\n${stderr}`))
        const line = stdout.split('\n').find((l) => l.startsWith('RESULT '))
        if (!line) return reject(new Error(`${scenario}: no RESULT line\n${stdout}\n${stderr}`))
        resolve({ r: JSON.parse(line.slice('RESULT '.length)), stderr })
      }
    )
  })
}

/* ALL THREE RUN ONCE, HERE, and the results are shared.
   Not for speed (though three children in parallel cost 2.6 s instead of 7.3):
   it is what lets G-b/4 compare the reject run against the watchdog run as a
   MUTATION of it, which is the only way to show G-b/2's central assertion can
   fail. `dataloss.rs`'s M-b standard: a test that has never been made to fail
   has not been shown to test anything. */
const [accept, reject, watchdog] = await Promise.all([
  run('accept'),
  run('reject'),
  run('watchdog'),
])

test('G-b/1: the frontend answers YES — state.json lands before the process goes', async () => {
  const { r } = accept

  assert.equal(r.armed, true, 'the first close must be PREVENTED and the handshake armed')
  assert.deepEqual(
    r.flushEvents,
    [{ deadlineMs: DEADLINE_MS }],
    'exactly one nc://flush-and-close, and it tells the frontend how long it has'
  )
  assert.deepEqual(r.quits, [0], 'AppCtx::quit(0), exactly once')

  // §7.6, and this is the pair that makes it discriminate. `save_ui_state` is
  // debounced 1,000 ms; if `state.json` already existed with the sentinel then
  // the debounce wrote it and this test would prove nothing about `flush_now`.
  assert.equal(r.sentinelBefore, false, 'the debounce had NOT written yet')
  assert.equal(r.sentinelAfterQuit, true, 'flush_now put §7.6 on disk before the quit')
  assert.ok(
    r.msFromSaveToQuit < 1000,
    `the quit came ${r.msFromSaveToQuit} ms after the save, inside the 1,000 ms debounce`
  )

  // `close_ok` latches: the ✕ that follows a confirmed quit must not re-arm the
  // handshake and hang the second attempt.
  assert.equal(r.secondArm, false, 'a second begin_close after a YES returns false')

  // And the watchdog from the first arm was DISARMED by the answer. The child
  // waited 2,400 ms past it; a broken token would land a second quit here.
  assert.equal(r.quits.length, 1, 'no second exit after the deadline had passed')
})

test('G-b/2: a REJECTING flush cancels the close — and nothing closes anyway', async () => {
  const { r, stderr } = reject

  assert.equal(r.armed, true)
  assert.deepEqual(r.flushEvents[0], { deadlineMs: DEADLINE_MS })

  /* THE ASSERTION THIS GAP EXISTED FOR. The child waited 2,400 ms -- past
     CLOSE_DEADLINE_MS with room -- after answering NO. spec-03 §9.2's
     unconditional watchdog would have exited here, and that is precisely the
     "silent discard wearing a timeout's clothes" B11/B18/M55 struck. */
  assert.equal(r.quitsAfterDeadline, 0, 'a NO must survive the deadline without quitting')
  assert.deepEqual(r.quits, [], 'nothing ever quit')

  // A cancelled close leaves the window usable, so the ✕ has to work again.
  assert.equal(r.secondArm, true, 'the handshake is re-armable after a cancel')

  assert.match(
    stderr,
    /close cancelled by the frontend \(io\)/,
    'the cancel says WHY, and carries the reason the frontend gave'
  )
})

test('G-b/3: the watchdog is a real timer, and it flushes §7.6 before it gives up', async () => {
  const { r, stderr } = watchdog

  assert.equal(r.armed, true)
  assert.deepEqual(r.quits, [0], 'the watchdog closed the app after the deadline')

  /* THE DEADLINE, MEASURED. `dl_28` proved CLOSE_DEADLINE_MS is 2,000 in the
     source AND in the compiled constant; it could not prove a timer runs for
     that long, because the thread that sleeps lives behind an AppHandle. The
     window is generous on the upper side -- this is a sleeping thread on a
     loaded machine, not a benchmark -- but a watchdog that fired instantly or
     never fired at all is what it has to exclude. */
  assert.ok(
    r.msFromArmToQuit >= DEADLINE_MS - 100 && r.msFromArmToQuit <= DEADLINE_MS + 1000,
    `expected the quit ~${DEADLINE_MS} ms after arming, got ${r.msFromArmToQuit} ms`
  )

  /* THE WATCHDOG IS FOR A HUNG DISK, NOT A REFUSED WRITE (§1.6), so what it
     discards is the editor buffer -- but `state.json` it must still write.
     Discriminated by timing: the sentinel was saved 1,500 ms after arming, so
     ITS debounce would land at 2,500 ms, 500 ms AFTER the watchdog fires. The
     file was read INSIDE the quit callback. If the sentinel is there, only
     `flush_prefs` can have put it there. */
  assert.equal(r.sentinelBeforeIt, false, 'the debounce had not written the sentinel')
  assert.equal(r.sentinelAtQuit, true, 'flush_prefs wrote §7.6 on the way out')

  /* AND IT SAYS WHAT IT IS DISCARDING. A watchdog that exits quietly is
     indistinguishable from a clean quit in a bug report. */
  assert.match(stderr, /did not answer flush-and-close within 2000 ms/)
  assert.match(stderr, /discarding whatever was unflushed/)
})

test('G-b/4: G-b/2 is shown to DISCRIMINATE — the same path with the answer withheld DOES quit', () => {
  /* THE MUTATION IS ALREADY IN THE FILE, and that is the point of running all
     three together. `reject` and `watchdog` arm the identical handshake on the
     identical code path; the ONLY difference between them is whether
     `confirm_close(false, …)` is ever called. Both then wait past the deadline.

     If G-b/2's `quitsAfterDeadline === 0` could not fail, it would be
     unfalsifiable and worth nothing. Here is the arm where it does fail. */
  assert.equal(reject.r.armed, true)
  assert.equal(watchdog.r.armed, true)
  assert.equal(reject.r.quits.length, 0, 'answered NO  -> nothing quit')
  assert.equal(watchdog.r.quits.length, 1, 'answered nothing -> the watchdog quit')

  // And they are distinguished by the answer alone, not by the deadline: both
  // waited past it.
  assert.ok(
    watchdog.r.msFromArmToQuit >= DEADLINE_MS - 100,
    'the arm that quit did so only after the deadline'
  )
})

test('G-b/5: the ✕ is WIRED to the handshake — a cheap guard on top of the executed proof', () => {
  /* THIS WAS THE LAST SLIVER OF G-b AND IT IS NO LONGER ONE.
     `window-control.test.mjs` now EXECUTES it: a real click on the real
     `.win-close` drives ✕ -> win.close() -> app::begin_close ->
     nc://flush-and-close -> the real frontend's flushAndClose() ->
     confirm_close(true) -> flush_prefs -> AppCtx::quit -> app.exit(0), and the
     report comes from the QUIT so it cannot be satisfied by a window merely
     going away. `lifecycle.test.mjs` does the same for `app.quit()`, which is
     what ⌘Q, Ctrl-Q and a menu Quit all raise.

     (What made THAT possible: `app-main.mjs`'s close handler used to skip the
     handshake under CAIRN_HEADLESS so the winctl probe could isolate the click.
     The probe now reports from the quit instead, so the guard was not needed
     and the real path runs in every headless run.)

     This test stays as the CHEAP half: it costs no process and it fails the
     instant somebody reintroduces `win.destroy()` on the ✕ path -- the same
     defect class dl_03/dl_04/dl_28 exist to prevent -- without waiting for a
     four-second Electron launch to notice. Belt to those braces, not a
     substitute for them. */
  const read = (p) => readFileSync(join(dirname(HERE), p), 'utf8')

  const main = read('electron-shell/app-main.mjs')
  const closeHandler = /win\.on\('close',[\s\S]{0,400}?\n  \}\)/.exec(main)
  assert.ok(closeHandler, "app-main.mjs must register a win.on('close') handler")
  assert.match(closeHandler[0], /addon\.beginClose\(\)/, 'the ✕ arms the handshake')
  assert.match(closeHandler[0], /preventDefault\(\)/, 'and PREVENTS the close while it is armed')

  // The frontend's half has to be reachable, or a YES can never arrive.
  assert.match(read('electron-shell/native.mjs'), /confirm_close:.*addon\.confirmClose/)
  assert.match(read('src/ipc.ts'), /export function confirmClose/)
  assert.match(read('src/main.ts'), /onFlushAndClose\(\(\) => \{ void flushAndClose\(\) \}\)/)

  // `destroy()` would skip the event entirely and discard the buffer -- the
  // same defect class dl_03/dl_04/dl_28 exist to prevent. lib.rs says so; this
  // shell must not reintroduce it.
  assert.doesNotMatch(main, /\bwin\.destroy\(\)/, 'the ✕ path must never call destroy()')
})
