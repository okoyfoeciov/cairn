/**
 * electron-shell/empty-pane.test.mjs — §0.45 E91/E92/E93: what the pane shows
 * with no note open, and what the caret does, in the real engine.
 *
 * ===========================================================================
 * WHY AN ENGINE, AND NOT `tests/frontend`
 * ===========================================================================
 * The deleted `.empty-state` element IS testable in the DOM shim, and
 * `chrome-ui.test.mjs` now asserts the tab strip never re-creates it. The other
 * two are not:
 *
 *   · E92 is `EditorView.editable.of(false)` reaching `contenteditable` on a
 *     REAL CodeMirror view. The shim mounts no CM6 at all.
 *   · E93 is a CASCADE outcome — CM6 injects its base theme as a runtime
 *     `<style>`, so which `caret-color` wins is only decidable once both
 *     stylesheets are in one real document. Reading `editor.css` proves
 *     nothing: the losing declaration was correct and present the whole time.
 *
 * E93 in particular is the §0.24.5 E53 shape — a rule that is right, live and
 * OUTRANKED fails in total silence — so the assertion is deliberately on
 * `getComputedStyle`, never on the source.
 *
 * Requires a display; skipped with a reason where there is none.
 */

import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { NO_DISPLAY } from './have-display.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)

function electronBinary() {
  const dist = join(ROOT, 'node_modules', 'electron', 'dist')
  if (process.platform === 'darwin') {
    return join(dist, 'Electron.app', 'Contents', 'MacOS', 'Electron')
  }
  return join(dist, 'electron')
}

const BIN = electronBinary()
const SKIP = !existsSync(BIN)
  ? `electron not installed at ${BIN} -- run npm install`
  : !existsSync(join(HERE, 'cairn.node'))
    ? 'no cairn.node -- run node electron-shell/build-native.mjs'
    : !existsSync(join(HERE, 'app', 'index.html'))
      ? 'electron-shell/app not built -- run node electron-shell/build-app.mjs'
      : NO_DISPLAY

/** `tokens.css`'s `--caret-color: #d7dfe9 [C]` (Oceanic == `--text-normal`). */
const CARET = 'rgb(215, 223, 233)'

function runProbe(openNote) {
  const work = mkdtempSync(join(tmpdir(), 'cairn-empty-'))
  const vault = join(work, 'vault')
  mkdirSync(join(vault, 'Agent'), { recursive: true })
  writeFileSync(join(vault, 'Agent', 'Memory.md'), 'x\n')

  const inner = new Promise((resolve, reject) => {

    const child = spawn(BIN, [join(HERE, 'app-main.mjs')], {
      cwd: ROOT,
      env: {
        ...process.env,
        CAIRN_HEADLESS: '1',
        CAIRN_EMPTY_PROBE: '1',
        CAIRN_VAULT: vault,
        CAIRN_STATE_DIR: join(work, 'state'),
        CAIRN_ELECTRON_GEOM: '1200x800',
        ...(openNote
          ? { CAIRN_PIXELTEST_EXPANDED: 'Agent', CAIRN_PIXELTEST_NOTE: 'Agent/Memory.md' }
          : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })

    const kill = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('empty probe timed out\nstdout:\n' + out + '\nstderr:\n' + err))
    }, 90_000)

    child.on('error', (e) => { clearTimeout(kill); reject(e) })
    child.on('exit', () => {
      clearTimeout(kill)
      const line = out.split('\n').find((l) => l.startsWith('EMPTY '))
      if (!line) {
        reject(new Error('no EMPTY line\nstdout:\n' + out + '\nstderr:\n' + err))
        return
      }
      resolve(JSON.parse(line.slice('EMPTY '.length)))
    })
  })
  return inner.finally(() => {
    try { rmSync(work, { recursive: true, force: true }) } catch {}
  })
}

let noNote = null
let withNote = null
const probeEmpty = async () => (noNote ??= await runProbe(false))
const probeOpen = async () => (withNote ??= await runProbe(true))

test('§0.45 E91 with no note open the pane is EMPTY — no element, no text', {
  skip: SKIP,
}, async () => {
  const d = await probeEmpty()
  assert.equal(d.error, undefined, 'probe error: ' + JSON.stringify(d.error))

  assert.equal(d.emptyStateEl, false, '`.empty-state` is back in the document')
  assert.equal(d.paneText, '', 'the pane renders text with no note open: ' + JSON.stringify(d.paneText))
  assert.deepEqual(d.visibleTextNodes, [], 'something visible is drawn in `.editor`')
  // §7.4 row 3 is unchanged and is now the ONLY on-screen signal.
  assert.equal(d.tabHidden, true, 'the tab is rendered with no note open')
})

test('§0.45 E92 with no note open there is NO CARET: the pane is not an editable surface', {
  skip: SKIP,
}, async () => {
  const d = await probeEmpty()

  // `EditorState.readOnly` alone leaves `contenteditable="true"` and Chromium
  // keeps blinking a caret in it — which is what the user reported. Only
  // `EditorView.editable.of(false)` clears the attribute.
  assert.equal(d.contentEditable, 'false',
    'the empty editor is still contenteditable — readOnly does NOT remove the caret')

  // And the receipt: the probe calls `.focus()` on `.cm-content` before
  // sampling. A non-editable host refuses it, so there is nowhere for a caret
  // to be drawn. This is the assertion that would catch a future change that
  // swapped `editable` back for `readOnly`.
  assert.equal(d.focusIsContent, false, 'focus landed on a pane with no document')
})

test('§0.45 E92 a note open is editable again — the caret must come back', { skip: SKIP }, async () => {
  const d = await probeOpen()
  assert.equal(d.error, undefined, 'probe error: ' + JSON.stringify(d.error))

  // THE REGRESSION THIS PAIR EXISTS FOR. Taking the caret away is easy; taking
  // it away permanently would make the app unusable and every existing editor
  // test still passes, because they drive CM6 through `dispatch` and never
  // through the DOM.
  assert.equal(d.contentEditable, 'true', 'the editor stayed non-editable with a note open')
  assert.equal(d.focusIsContent, true, 'focus will not land in an open note')
  assert.equal(d.tabHidden, false, 'the tab is hidden with a note open')
  assert.match(d.paneText, /Memory/, 'the note did not render')
})

test('§0.45 E93 the caret takes the MEASURED colour, not CM6\'s white', { skip: SKIP }, async () => {
  const d = await probeOpen()

  // Asserted on the COMPUTED value on purpose. `editor.css` declared this
  // correctly at (0,1,0) and lost to CM6's base theme
  // `"&dark .cm-content": {caretColor:"white"}` at (0,3,0) — a rule that is
  // right, present and outranked fails silently (§0.24.5 E53). Reading the
  // source would have passed throughout.
  assert.equal(d.caretToken, '#d7dfe9', 'the token itself moved')
  assert.equal(d.caretColor, CARET,
    'the caret is not `--caret-color` — CM6\'s base theme is winning the cascade again')
  // Oceanic derives it from --text-normal, so the two must agree.
  assert.equal(d.contentColor, CARET, 'the caret IS --text-normal; these have diverged')
})
