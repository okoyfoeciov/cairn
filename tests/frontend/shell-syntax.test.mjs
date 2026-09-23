// Owner: 07.  `node --test tests/frontend/*.test.mjs`.
//
// ===========================================================================
// WHY A SYNTAX CHECK IS A TEST
// ===========================================================================
// `electron-shell/app-main.mjs` drives several harness probes, and each one
// hands the renderer a page script as a TEMPLATE LITERAL. A backtick inside a
// comment in one of those scripts ends the string, and the file becomes a
// `SyntaxError` at module load.
//
// THAT FAILURE DOES NOT LOOK LIKE A SYNTAX ERROR. Electron opens a modal error
// dialog the run cannot reach, so what a caller sees is **a launch that hangs
// with no output until its timeout** — spike R §0's exact failure class, one
// file further out. It cost minutes three separate times in one session, and
// the third occurrence was inside a comment explaining the first.
//
// `node --check` finds it in ~40ms. There is no reason for that to be a thing
// somebody remembers to run.
//
// It covers every `.mjs` in `electron-shell/`, not just `app-main.mjs`: the
// hazard is the technique, not the file.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
const SHELL = join(ROOT, 'electron-shell')

const files = readdirSync(SHELL).filter((f) => f.endsWith('.mjs') || f.endsWith('.cjs'))

test('electron-shell: every shell script parses', () => {
  assert.ok(files.length >= 5, `expected the shell to have scripts, found ${files.length}`)
  for (const f of files) {
    try {
      execFileSync(process.execPath, ['--check', join(SHELL, f)], { stdio: 'pipe' })
    } catch (e) {
      const out = String(e.stderr ?? e.stdout ?? e.message)
      assert.fail(
        `electron-shell/${f} does not parse — a launch using it will HANG with no output.\n` +
        'The usual cause is a backtick inside a comment in a page script passed to ' +
        'executeJavaScript(`…`).\n' + out
      )
    }
  }
})

/**
 * ONE DISPLAY PREDICATE, AND NOBODY GETS TO COPY IT AGAIN.
 *
 * `electron-shell/have-display.mjs` exists because five suites had guarded
 * themselves with, verbatim:
 *
 *     Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)
 *
 * which asks whether an X11 or Wayland server is reachable. On macOS neither
 * variable is ever set and neither ever will be — the window server is Quartz —
 * so the guard was not "no display", it was **"not Linux" wearing a display
 * check's clothes**, and it skipped 16 passing tests on the first macOS run.
 * That module's header writes the whole thing up.
 *
 * SIX SUITES WRITTEN AFTER THAT FIX RE-INTRODUCED IT, by copying the old
 * literal: live-preview, indent, fold, empty-pane, totp and pane-paint — which
 * between them are the entire engine coverage of live preview and the
 * Properties block. So `KNOWN-ISSUES` V-1 was not "untested on macOS", it was
 * "would report a clean green run having executed nothing".
 *
 * A comment in `have-display.mjs` did not stop that happening, so this does.
 * Verified by construction rather than by intention: the literal may appear in
 * exactly one file, the one that owns the predicate.
 *
 * **A SKIP IS A THIRD KIND OF GREEN** (CONTRACT §0.22.2 E40): nothing in a
 * summary line distinguishes "16 skipped" from "16 that cannot fail here", and
 * no CI run on one platform ever will.
 *
 * ── IT CAUGHT THE PROSE FIRST, WHICH IS THE THIRD TIME HERE ────────────────
 * Its own first run failed against `indent.test.mjs`, whose header had just
 * been written to explain this defect and QUOTED THE LITERAL while doing it.
 * §0.49 E97 records the same shape — `geometry-probe.test.mjs` failed on a
 * REASON STRING containing `devicePixelRatio`, and its comment notes that that
 * had already happened once before.
 *
 * Left as a flat scan of the file's bytes, deliberately: stripping comments is
 * what `geometry-probe.test.mjs` does and it is exactly what let a string
 * literal through. A rule that is trivial to satisfy — do not quote the name —
 * and impossible to fudge is worth more than a smarter scanner.
 */
test('electron-shell: the display predicate lives in exactly one file', () => {
  const OWNER = 'have-display.mjs'
  const LITERAL = 'WAYLAND_DISPLAY'
  const offenders = []
  for (const f of files) {
    if (f === OWNER) continue
    if (readFileSync(join(SHELL, f), 'utf8').includes(LITERAL)) offenders.push(f)
  }
  assert.deepEqual(offenders, [],
    `these files spell the display check themselves instead of importing it from ` +
    `${OWNER}:\n  ${offenders.join('\n  ')}\n` +
    `On macOS neither DISPLAY nor WAYLAND_DISPLAY is ever set, so a local copy does not mean ` +
    `"no display" — it means "not Linux", and every test in the file SKIPS there while ` +
    `reporting a green run. Import { NO_DISPLAY } from './${OWNER}' instead.`)

  // …and the owner really does own it, so this cannot pass by the literal
  // having been renamed out of existence everywhere.
  assert.ok(readFileSync(join(SHELL, OWNER), 'utf8').includes(LITERAL),
    `${OWNER} no longer contains the predicate this test exists to centralise`)
})

/* =========================================================================
 * Step-1 shell conformance: shapes no unit test can see, each pinned so a
 * well-meaning edit cannot silently reintroduce the bug. Every row below
 * fails on the pre-fix source (verified by stashing) and passes on it.
 * ====================================================================== */

const APP_MAIN = readFileSync(join(ROOT, 'electron-shell', 'app-main.mjs'), 'utf8')

test('F27: the application menu has no reload role, and Mod-R never reaches the page', () => {
  assert.match(APP_MAIN, /Menu\.setApplicationMenu/, 'no explicit menu is installed at all')
  assert.ok(!/'reload'/.test(APP_MAIN), 'a reload role survives in the menu template')
  assert.ok(!/'forceReload'/.test(APP_MAIN), 'a forceReload role survives in the menu template')
  assert.match(APP_MAIN, /before-input-event/, 'the Mod-R guard is gone')
})

test('F31: a crashed renderer reloads instead of sitting blank', () => {
  assert.match(APP_MAIN, /render-process-gone/, 'no crash listener is registered')
  assert.match(APP_MAIN, /unresponsive/, 'no hang listener is registered')
})

test('F59: a CAIRN_VAULT launch is hermetic, a plain launch is untouched', () => {
  assert.match(APP_MAIN, /process\.env\.CAIRN_VAULT/, 'CAIRN_VAULT no longer implies a temp state dir')
  assert.match(APP_MAIN, /cairn-dev-/, 'the dev temp prefix is gone')
})

test('F60: the totp/secrets probes give the clipboard back', () => {
  assert.equal(
    (APP_MAIN.match(/savedClipboard/g) ?? []).length >= 4, true,
    'expected snapshot+restore in both probes',
  )
})

test('F64: scroll-bench kills only the child it spawned', () => {
  const bench = readFileSync(join(ROOT, 'tools', 'scroll-bench.mjs'), 'utf8')
  const code = bench.replace(/\/\/.*$/gm, '')
  assert.ok(!/['"]pkill['"]/.test(code), 'a pkill invocation survives')
  assert.ok(code.includes('process.kill(-child.pid'), 'the process-group kill is gone')
})
