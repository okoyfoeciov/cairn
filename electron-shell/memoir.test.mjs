/**
 * electron-shell/memoir.test.mjs — the two fixed tabs in the real engine.
 *
 * User features, 2026-09-15/16: a note tab and a fixed second tab named
 * `Memoir`, NEITHER closable. Since 2026-09-17 the second tab holds a journal
 * PAGE for vault-root `Memoir.md` (not a note in the editor); the sidebar
 * never shows the file. Inactive styling is Obsidian 1.13.7's own
 * `.workspace-tab-header`, transcribed in `src/styles/chrome.css` (read out
 * of the 1.13.7 asar).
 *
 * ===========================================================================
 * WHY AN ENGINE, AND NOT `tests/frontend`
 * ===========================================================================
 * `chrome-ui.test.mjs` already drives `createTabStrip` in the DOM shim (the
 * exactly-one-active invariant) and `tree.test.mjs` pins the hiding in the
 * virtualiser. What NEITHER can see:
 *
 *   · the lazy create reaching DISK (`createNote` through the real addon);
 *   · the switch reaching the real page (vault read/create through the real
 *     addon, the `#ed` HOST hidden, the page's textarea mounted —
 *     flush-first with abort on rejection — `main.ts`'s half);
 *   · the tree hiding the file once it EXISTS in a real snapshot cycle;
 *   · coming back to the note via the note tab's background click.
 *
 * The probe clicks both tabs with real MouseEvents and samples the strip, the
 * pane takeover and the painted tree rows at each stop. Headless offscreen
 * (`CAIRN_HEADLESS=1`); skipped with a reason where Electron is unavailable.
 */

import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { test, after } from 'node:test'
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

const dirs = []
after(() => {
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }) } catch {}
  }
})

function runProbe() {
  return new Promise((resolve, reject) => {
    const work = mkdtempSync(join(tmpdir(), 'cairn-memoir-'))
    dirs.push(work)
    const vault = join(work, 'vault')
    mkdirSync(join(vault, 'Agent'), { recursive: true })
    writeFileSync(join(vault, 'Agent', 'Memory.md'), 'a memoir probe note\n')

    const child = spawn(BIN, [join(HERE, 'app-main.mjs')], {
      cwd: ROOT,
      env: {
        ...process.env,
        CAIRN_HEADLESS: '1',
        CAIRN_MEMOIR_PROBE: '1',
        CAIRN_VAULT: vault,
        CAIRN_STATE_DIR: join(work, 'state'),
        CAIRN_ELECTRON_GEOM: '1200x800',
        CAIRN_PIXELTEST_EXPANDED: 'Agent',
        CAIRN_PIXELTEST_NOTE: 'Agent/Memory.md',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })

    const kill = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('memoir probe timed out\nstdout:\n' + out + '\nstderr:\n' + err))
      // The live leg bills one SkyDeck turn and waits up to 2m for its cards.
    }, process.env.CAIRN_MEMOIR_LIVE === '1' ? 240_000 : 90_000)

    child.on('error', (e) => { clearTimeout(kill); reject(e) })
    child.on('exit', () => {
      clearTimeout(kill)
      const line = out.split('\n').find((l) => l.startsWith('MEMOIR '))
      if (!line) {
        reject(new Error('no MEMOIR line\nstdout:\n' + out + '\nstderr:\n' + err))
        return
      }
      resolve({ d: JSON.parse(line.slice('MEMOIR '.length)), vault })
    })
  })
}

let cached = null
const probe = async () => (cached ??= await runProbe())

test('Memoir — two tabs, memoir visible beside the open note, exactly one active', {
  skip: SKIP,
}, async () => {
  const { d } = await probe()
  assert.equal(d.error, undefined, 'probe error: ' + JSON.stringify(d.error))

  assert.equal(d.before.tabs, 2, 'the strip does not hold two tabs')
  assert.equal(d.before.noteHidden, false)
  assert.equal(d.before.memoirHidden, false, 'the memoir tab is hidden with a vault open')
  assert.equal(d.before.noteActive, true)
  assert.equal(d.before.memoirActive, false)
  assert.equal(d.before.noteLabel, 'Memory')
  assert.equal(d.before.memoirLabel, 'Memoir', 'the fixed tab lost its label')
  assert.equal(d.before.title, 'Memory')
  // THE SEPARATION, AS GEOMETRY.  The inner pill sits 3px inside the slot on
  // each side (Obsidian's mod-root header padding), so a hovered pill never
  // touches the active tab — strip background shows between them.  A whole-tab
  // hover fill would read 0 here and touch edge to edge.
  assert.equal(d.before.noteInsetL, 3, 'the note tab lost its inner pill')
  assert.equal(d.before.memoirInsetL, 3, 'the memoir tab lost its inner pill')
  // THE PILL RADIUS, PLATFORM-SCOPED like Obsidian's own `--tab-radius`:
  // 4px off macOS, 8px on it — never the active tab's 6px.  Asserted computed
  // because a right-present-outranked rule fails in total silence (§0.24.5).
  assert.equal(d.before.pillRadius, d.before.os === 'macos' ? '8px' : '4px',
    'the hover pill wears the wrong platform radius (os=' + d.before.os + ')')
})

test('Memoir — selecting it lazily creates Memoir.md and shows the page', {
  skip: SKIP,
}, async () => {
  const { d, vault } = await probe()

  assert.equal(d.onMemoir.memoirActive, true, 'clicking the memoir tab did not activate it')
  assert.equal(d.onMemoir.noteActive, false, 'both tabs are active — G9 would read either')
  // THE TAKEOVER: the page's host is visible, the #ed HOST is computed-hidden
  // (not merely emptied), and the journal textarea is mounted.
  assert.equal(d.onMemoir.memoirVisible, true, 'the memoir page did not show')
  assert.equal(d.onMemoir.edHidden, true, 'the editor host is still laid out beside the page')
  assert.equal(d.onMemoir.mmEditor, true, 'the journal textarea is not mounted')
  assert.equal(d.onMemoir.mmFocused, true, 'selecting the tab did not put the caret in the text')
  assert.equal(d.onMemoir.checkFont, '13px',
    'the verbs lost their 13px: ' + JSON.stringify(d.onMemoir.checkFont))
  // THE NOTE ALIGNMENT: the journal's first glyph column is the note's —
  // the frame spends the live scroller's own left padding, not a constant.
  assert.equal(d.onMemoir.mmFramePadL, d.onMemoir.cmPadL,
    'memoir frame padding ' + d.onMemoir.mmFramePadL + ' != editor ' + d.onMemoir.cmPadL)
  assert.equal(d.onMemoir.mmSize, '16px',
    'the journal is not the note size: ' + JSON.stringify(d.onMemoir.mmSize))
  assert.ok(/sans-serif/.test(d.onMemoir.mmFont || '') && !/Georgia|Palatino/.test(d.onMemoir.mmFont || ''),
    'the journal is not the note face: ' + JSON.stringify(d.onMemoir.mmFont))
  assert.ok(!d.onMemoir.treeRows.includes('Memoir'),
    'Memoir.md draws a sidebar row: ' + JSON.stringify(d.onMemoir.treeRows))
  assert.ok(d.onMemoir.treeRows.includes('Memory'), 'the note row went missing under memoir')

  // THE LAZY CREATE, ON DISK.  Nothing on the vault-open path writes; the
  // first select is what creates the file, empty — or holding the live leg's
  // typed sentence when that leg ran in the same shared probe run (its
  // content is asserted exactly by the live test below).
  const memoirPath = join(vault, 'Memoir.md')
  assert.equal(existsSync(memoirPath), true, 'selecting the memoir tab created no file')
  if (d.live) {
    assert.equal(readFileSync(memoirPath, 'utf8'), 'Yesterday I go to office at morning.')
  } else {
    assert.equal(readFileSync(memoirPath, 'utf8'), '')
  }
})

test('Memoir — selecting a tree note leaves the page for the note viewer', { skip: SKIP }, async () => {
  const { d } = await probe()

  assert.ok(d.treeNote, 'the Memory tree row is missing from the sidebar')
  assert.equal(d.treeNote.memoirVisible, false, 'selecting a tree note kept the Memoir page on screen')
  assert.equal(d.treeNote.edHidden, false, 'the editor did not come back on a tree select')
  assert.equal(d.treeNote.noteActive, true, 'the strip did not follow a tree select back to the note')
  assert.equal(d.treeNote.memoirActive, false, 'both tabs are active after a tree select')
  assert.equal(d.treeNote.title, 'Memory', 'the tree select did not open the note')
})

test('Memoir — the note tab brings the note back and hides the page', { skip: SKIP }, async () => {
  const { d } = await probe()

  assert.equal(d.backOnNote.noteActive, true, 'clicking the note tab did not switch back')
  assert.equal(d.backOnNote.memoirActive, false)
  assert.equal(d.backOnNote.memoirVisible, false, 'the memoir page stayed visible over the note')
  assert.equal(d.backOnNote.edHidden, false, 'the editor host did not come back')
  assert.equal(d.backOnNote.title, 'Memory', 'the note tab forgot its note across a memoir visit')
})

// THE LIVE LEG (gated: it bills one SkyDeck turn through llm-service, so it
// runs only with CAIRN_MEMOIR_LIVE=1). What it proves end to end, in the real
// engine: typing in the page autosaves through the real addon (proved from
// DISK, not the DOM), and Check reaches llm-service over localhost and renders
// issue cards back into the drawer.
test('Memoir — typing autosaves to disk and Check returns issues', {
  skip: SKIP || (process.env.CAIRN_MEMOIR_LIVE === '1'
    ? false
    : 'live LLM turn not requested (CAIRN_MEMOIR_LIVE=1 to run it)'),
}, async () => {
  const { d, vault } = await probe()
  assert.equal(d.live && d.live.error, undefined, 'live leg error: ' + JSON.stringify(d.live))
  assert.equal(d.live.saved, true, 'typing never reached the Saved status')
  assert.equal(
    readFileSync(join(vault, 'Memoir.md'), 'utf8'),
    'Yesterday I go to office at morning.',
    'the typed sentence is not on disk',
  )
  assert.ok((d.live.issues | 0) >= 2, 'expected issues, got: ' + JSON.stringify(d.live))
  assert.match(d.live.reason || '', /tense|preposition|article/,
    'first issue reason is not the known error: ' + JSON.stringify(d.live.reason))
  assert.equal(d.live.spin, 'mm-spin',
    'the ink ring carries no running animation: ' + JSON.stringify(d.live.spin))
  assert.equal(d.live.sawSpinner, false,
    'the Check button showed a spinner (removed 2026-09-18)')
})
