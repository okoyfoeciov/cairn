/**
 * electron-shell/totp.test.mjs — §0.46 E94's `totp` block, in the real engine.
 *
 * ===========================================================================
 * WHAT THIS ADDS OVER `tests/frontend/totp.test.mjs`
 * ===========================================================================
 * That file pins the MODEL — RFC 6238's own vectors, the block grammar, the
 * otpauth parser — with no DOM and no engine, which is the right shape for it.
 * Five things live only here:
 *
 *   1. THE WIDGET REACHES THE DOM. A `Decoration.replace({block:true})` that
 *      CM6 refuses fails at render time, not at build time.
 *   2. NEITHER THE SEED NOR A CODE IS ON SCREEN. Two claims, both about
 *      RENDERED TEXT, so both are asserted against `innerText` and nothing
 *      else: the seed because it is the security claim the design rests on
 *      (§0.46 divergence 3), and the code because §0.46.6 is a user ruling that
 *      a passing unit test could not express.
 *   3. THE COPY REALLY COPIES. The renderer cannot read the clipboard back, so
 *      a test inside the page could only ever check that the row confirmed.
 *      The clipboard is read in the MAIN process — that is the only real
 *      receipt for §1.3 command 23, and it is also the assertion that would
 *      have caught `navigator.clipboard` silently rejecting.
 *   4. THE ADD FORM WRITES THE NOTE. Validation, refusal, and a document that
 *      is byte-identical except for the entry that was added.
 *   5. THE COMMENT RENDERS BESIDE ITS LABEL. The `# comment:` line is
 *      rendered text, so it is asserted in the engine — including that it
 *      does not trip the no-time-shaped-text ruling.
 *   6. CLICK-TO-COPY (user feature, 2026-09-17). There is no Copy button: the
 *      row is the control, so the probe clicks the label, and asserts the
 *      pointer cursor, the tooltip, the transient pill, and that the pill
 *      clears again.
 *
 * NO REAL SECRET IS USED. The seeds are RFC 6238's own and the well-known
 * `JBSWY3DPEHPK3PXP`.
 *
 * Requires a display; skipped with a reason where there is none. ~8s — it was
 * up to ~40s until §0.46.6 deleted the countdown this had to sweep.
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

/** RFC 6238's seed, and "Hello!" — both public, neither anybody's credential. */
const SEED_A = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
const SEED_B = 'JBSWY3DPEHPK3PXP'

const NOTE = [
  '# Ops credentials',
  '',
  '```totp',
  '# Example Issuer',
  SEED_A,
  '# Second Account',
  '# comment: on call',
  SEED_B,
  '# Broken On Purpose',
  '!!!not-base32!!!',
  '```',
  '',
  'Trailing prose.',
  '',
].join('\n')

function runProbe() {
  return new Promise((resolve, reject) => {
    const work = mkdtempSync(join(tmpdir(), 'cairn-totp-'))
    const cleanup = () => {
      try { rmSync(work, { recursive: true, force: true }) } catch {}
    }
    const vault = join(work, 'vault')
    mkdirSync(join(vault, 'Notes'), { recursive: true })
    writeFileSync(join(vault, 'Notes', 'creds.md'), NOTE)

    const child = spawn(BIN, [join(HERE, 'app-main.mjs')], {
      cwd: ROOT,
      env: {
        ...process.env,
        CAIRN_HEADLESS: '1',
        CAIRN_TOTP_PROBE: '1',
        CAIRN_VAULT: vault,
        CAIRN_PIXELTEST_EXPANDED: 'Notes',
        CAIRN_PIXELTEST_NOTE: 'Notes/creds.md',
        CAIRN_STATE_DIR: join(work, 'state'),
        CAIRN_ELECTRON_GEOM: '1300x800',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })

    const kill = setTimeout(() => {
      child.kill('SIGKILL')
      cleanup()
      reject(new Error('totp probe timed out\nstdout:\n' + out + '\nstderr:\n' + err))
    }, 120_000)

    child.on('error', (e) => { clearTimeout(kill); cleanup(); reject(e) })
    child.on('exit', () => {
      clearTimeout(kill)
      const line = out.split('\n').find((l) => l.startsWith('TOTP '))
      if (!line) {
        cleanup()
        reject(new Error('no TOTP line\nstdout:\n' + out + '\nstderr:\n' + err))
        return
      }
      const result = JSON.parse(line.slice('TOTP '.length))
      cleanup()
      resolve(result)
    })
  })
}

let cached = null
const probeOnce = async () => (cached ??= await runProbe())

test('§0.46 E94 the block renders one row per entry', { skip: SKIP }, async () => {
  const d = await probeOnce()
  assert.equal(d.error, undefined, 'probe error: ' + JSON.stringify(d.error))

  assert.equal(d.first.length, 3, 'expected three rows')
  assert.deepEqual(d.first.map((r) => r.label),
    ['Example Issuer', 'Second Account', 'Broken On Purpose'])
})

test('the comment renders beside its label and nowhere else', { skip: SKIP }, async () => {
  const d = await probeOnce()
  assert.deepEqual(d.first.map((r) => r.comment), [null, 'on call', null])
  // The comment is rendered text, so it must not trip the ruling that no
  // time-shaped text is on screen — the fixture phrase is chosen for that.
  assert.match(d.paneText, /on call/)
})

test('§0.46 E94 THE SEED IS NEVER ON SCREEN — the security claim', { skip: SKIP }, async () => {
  const d = await probeOnce()
  // The widget REPLACES the fence, so the base32 seed — the thing worth
  // stealing — is not rendered anywhere, where a plain note shows it in the
  // clear. A 30-second derived code is not the secret.
  assert.equal(d.seedOnScreen, false, 'a base32 seed was rendered in the document')
})

test('§0.46 E94 a broken entry fails ITS OWN row and the others keep working', {
  skip: SKIP,
}, async () => {
  const d = await probeOnce()
  const bad = d.first[2]
  assert.equal(bad.bad, true)
  assert.match(bad.err, /base32/)
  assert.equal(bad.copiedText, null, 'a broken entry must not offer a copy control')
  // The plugin's one behaviour kept verbatim: one bad seed must not take the
  // other accounts down with it.
  assert.equal(d.first[0].bad, false)
  assert.equal(d.first[1].bad, false)
})

test('§0.46.6 NO CODE IS RENDERED — the user ruling, asserted on the pixels', {
  skip: SKIP,
}, async () => {
  const d = await probeOnce()

  // The first build of this block showed a live code and a one-second
  // countdown. The user overruled it twice — "I don't want code or countdown,
  // really. Please remove it!" — so the plugin's posture is restored and this
  // is the assertion that keeps it restored.
  assert.equal(d.codeOnScreen, false,
    'a six-digit run is rendered somewhere: ' + JSON.stringify(d.paneText))
  // The row is a name and nothing else — no button, no code.
  assert.deepEqual(d.first.map((r) => r.copiedText), ['', '', null])
  assert.match(d.paneText, /Example Issuer/)
  assert.doesNotMatch(d.paneText, /\d\d:\d\d|\bs\b/, 'something time-shaped is rendered')
})

test('click-to-copy: pointer cursor, tooltip, and a pill that clears', { skip: SKIP }, async () => {
  const d = await probeOnce()
  // The affordance §9 E4 demands of anything clickable: the cursor and the
  // tooltip name the action before the click happens.
  assert.deepEqual(d.first.slice(0, 2).map((r) => r.cursor), ['pointer', 'pointer'])
  assert.match(d.first[0].tip, /copy/i, 'no tooltip on the row')
  assert.equal(d.pillBefore, '', 'the pill is visible before any click')
  assert.equal(d.pillAfter, 'Copied', 'clicking the row did not confirm')
})

test('§0.46.6 the pill confirms, then GOES AWAY', { skip: SKIP }, async () => {
  const d = await probeOnce()

  // A row stuck on "Copied" would read as a permanent state rather than as
  // feedback.
  assert.equal(d.pillSettled, '', 'the confirmation never cleared')
})

test('§0.46 E94 clicking the row puts a real code on the real clipboard', {
  skip: SKIP,
}, async () => {
  const d = await probeOnce()

  // READ IN THE MAIN PROCESS. This is the only real receipt for command 23 —
  // and the assertion that would catch `navigator.clipboard.writeText`
  // rejecting with "Document is not focused", which is what it does here.
  //
  // IT CANNOT BE COMPARED AGAINST THE SCREEN ANY MORE, and that is the point of
  // §0.46.6: there is no displayed code to compare with. So the assertion is on
  // the SHAPE — six digits, nothing else — plus the fact that it is not the
  // empty pill the row showed before the click.
  assert.match(d.clipboard, /^\d{6}$/,
    'the clipboard does not hold a six-digit code: ' + JSON.stringify(d.clipboard))
  assert.notEqual(d.clipboard, d.pillBefore)
})

test('§0.46 E94 Add REFUSES an unusable secret instead of writing it', { skip: SKIP }, async () => {
  const d = await probeOnce()

  assert.equal(d.formShown, true, 'the add form did not open')
  assert.match(d.refusedMsg, /base32/, 'no reason given for the refusal')
  // The whole value of the button is that the next thing you see is a working
  // code. A form that accepted anything would put a broken row in a credentials
  // file and tell you about it the next time you needed to log in.
  assert.equal(d.rowsAfterRefusal, 3, 'a refused secret was written anyway')
})

test('§0.46 E94 Add writes ONE entry and leaves the rest of the note alone', {
  skip: SKIP,
}, async () => {
  const d = await probeOnce()

  assert.equal(d.rowsAfterAdd.length, 4, 'the new entry did not appear')
  assert.equal(d.rowsAfterAdd[3].label, 'Added By Test')
  assert.equal(d.rowsAfterAdd[3].copiedText, '', 'the added entry is not usable')

  // ONE INSERT, never a re-serialisation (§0.24.6 E55's rule). The document
  // must differ from the original by exactly the two added lines — including
  // the deliberately-broken entry, which a "helpful" rewrite would drop.
  const want = NOTE.replace('```\n\nTrailing', '# Added By Test\n' + SEED_B + '\n```\n\nTrailing')
  assert.equal(d.docText, want, 'the add rewrote more than it inserted')
})
