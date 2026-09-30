/**
 * electron-shell/secrets.test.mjs — the secret file, in the real engine.
 *
 * ===========================================================================
 * WHAT THIS ADDS OVER `tests/frontend/secrets.test.mjs`
 * ===========================================================================
 * That file pins the MODEL — the marker, the fence grammar, the offsets —
 * with no DOM and no engine.  Six things live only here:
 *
 *   1. THE VIEWER TAKES OVER. The marker hides CodeMirror and mounts
 *      `.nc-secrets`; without the marker none of this happens.
 *   2. NEITHER THE SEED NOR A SECRET TEXT IS ON SCREEN. Three claims, all
 *      about RENDERED TEXT, so all asserted against `innerText`: the TOTP
 *      seed, a secret value, and any six-digit run.
 *   3. SHOW REVEALS AND RE-MASKS. The mask is fixed bullets (length says
 *      nothing); Show prints the secret, Hide takes it back.
 *   4. THE SECRET COPY REALLY COPIES. Read back in the MAIN process — the
 *      only real receipt for §1.3 command 23 — and asserted EXACT, because a
 *      credential copy that is almost right is wrong.  It is also the last
 *      copy in the probe, which is what makes the single clipboard slot hold
 *      it.  The TOTP copy is asserted by its row's pill (the shared row-copy
 *      path is what the clipboard receipt covers).
 *   5. BOTH ADD FORMS WRITE THE NOTE. Refusal first (unusable TOTP seed,
 *      missing label), then a valid entry each, each WITH a comment — and the
 *      document differs by exactly the inserted lines.
 *   6. DELETE REMOVES THE ENTRY. Found by label, and the line is gone from
 *      the document — plus the file on DISK, after the §7.2 autosave flush.
 *   7. EVERY ROW OFFERS EDIT, AND EDIT REPLACES ONLY ITS OWN LINES. Label,
 *      comment and secret each change on the added entries, and the document
 *      carries the replacement and nothing else.  The comment fixtures above
 *      prove the `# comment:` lines render without tripping the claims in 2.
 *   8. THE COMMENT RENDERS BESIDE ITS LABEL. Asserted on the fixture rows,
 *      which is also what keeps a hand-written `# comment:` line from
 *      vanishing into a label or an error row.
 *   9. CLICK-TO-COPY (user feature, 2026-09-17). There is no Copy button: a
 *      click on the row copies, so the probe clicks the labels, and asserts
 *      the pointer cursor, the tooltip, the row's button role for keyboard
 *      users, and the transient pill.
 *
 * NO REAL SECRET IS USED. The TOTP seed is RFC 6238's own; the secret texts
 * are obvious fixtures.
 *
 * Requires a display; skipped with a reason where there is none.
 */

import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

const SEED_A = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
const SEED_B = 'JBSWY3DPEHPK3PXP'

const NOTE = [
  '---',
  'cairn-type: secrets',
  '---',
  '',
  '```totp',
  '# Example Issuer',
  '# comment: for work',
  SEED_A,
  '```',
  '',
  '```secret',
  '# Stripe Test Key',
  '# comment: billing',
  'sk-test-TESTONLY456',
  '# Multi Line',
  'alpha',
  'beta',
  '```',
  '',
].join('\n')

function runProbe() {
  return new Promise((resolve, reject) => {
    const work = mkdtempSync(join(tmpdir(), 'cairn-secrets-'))
    const vault = join(work, 'vault')
    mkdirSync(join(vault, 'Notes'), { recursive: true })
    writeFileSync(join(vault, 'Notes', 'vault-secrets.md'), NOTE)

    const child = spawn(BIN, [join(HERE, 'app-main.mjs')], {
      cwd: ROOT,
      env: {
        ...process.env,
        CAIRN_HEADLESS: '1',
        CAIRN_SECRETS_PROBE: '1',
        CAIRN_VAULT: vault,
        CAIRN_PIXELTEST_EXPANDED: 'Notes',
        CAIRN_PIXELTEST_NOTE: 'Notes/vault-secrets.md',
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
      try { rmSync(work, { recursive: true, force: true }) } catch {}
      reject(new Error('secrets probe timed out\nstdout:\n' + out + '\nstderr:\n' + err))
    }, 120_000)

    child.on('error', (e) => { clearTimeout(kill); reject(e) })
    child.on('exit', () => {
      clearTimeout(kill)
      const line = out.split('\n').find((l) => l.startsWith('SECRETS '))
      if (!line) {
        try { rmSync(work, { recursive: true, force: true }) } catch {}
        reject(new Error('no SECRETS line\nstdout:\n' + out + '\nstderr:\n' + err))
        return
      }
      const result = JSON.parse(line.slice('SECRETS '.length))
      // The probe waited out the §7.2 autosave, so the vault file is the
      // flushed document — the end-to-end half of every write below.
      try {
        result.diskText = readFileSync(join(vault, 'Notes', 'vault-secrets.md'), 'utf8')
      } catch (e) {
        result.diskError = String((e && e.message) || e)
      }
      try { rmSync(work, { recursive: true, force: true }) } catch {}
      resolve(result)
    })
  })
}

let cached = null
const probeOnce = async () => (cached ??= await runProbe())

test('the marker hides the editor host and mounts a VISIBLE viewer', { skip: SKIP }, async () => {
  const d = await probeOnce()
  assert.equal(d.error, undefined, 'probe error: ' + JSON.stringify(d.error))
  assert.equal(d.edHidden, true, 'the emptied #ed still spans the pane')
  assert.equal(d.sections, 2, 'expected the TOTP section and the secret-text section')
  // PRESENCE IS NOT VISIBILITY: this once rendered fully below the fold and
  // every DOM check passed while the pane painted black.  The rect must sit
  // inside the window with real height.
  assert.ok(d.rectTop >= 0, 'the viewer starts above the viewport: ' + d.rectTop)
  assert.ok(d.rectHeight > 100, 'the viewer has no height: ' + d.rectHeight)
  assert.ok(d.rectBottom <= d.winH + 1, 'the viewer runs past the viewport: ' + d.rectBottom + ' > ' + d.winH)
})

test('the tree row for the secret file carries the secret mark', { skip: SKIP }, async () => {
  const d = await probeOnce()
  assert.equal(d.treeSecret, true, 'the secret file row is not marked in the tree')
  // Oceanic ice-blue, asserted on COMPUTED style — the class alone cannot
  // say what the row paints. Was #5EB3F6 pre-Oceanic; now var(--text-accent).
  assert.equal(d.treeInk, 'rgb(140, 191, 230)', 'the secret ink is not #8cbfe6: ' + d.treeInk)
})

test('one row per entry on both sections', { skip: SKIP }, async () => {
  const d = await probeOnce()
  assert.deepEqual(d.totpFirst.map((r) => r.label), ['Example Issuer'])
  assert.deepEqual(d.secretFirst.map((r) => r.label), ['Stripe Test Key', 'Multi Line'])
})

test('the fixture comments render beside their labels, and every row offers Edit', { skip: SKIP }, async () => {
  const d = await probeOnce()
  assert.deepEqual(d.totpFirst.map((r) => r.comment), ['for work'])
  assert.deepEqual(d.secretFirst.map((r) => r.comment), ['billing', null])
  for (const r of [...d.totpFirst, ...d.secretFirst]) {
    assert.equal(r.edit, 'Edit', 'no Edit button on ' + JSON.stringify(r.label))
  }
})

test('click-to-copy: pointer cursor, tooltip, button role, and a pill', { skip: SKIP }, async () => {
  const d = await probeOnce()
  // The affordance §9 E4 demands of anything clickable, named before the
  // click happens; the role is the keyboard half (Enter/Space on the row).
  for (const r of [...d.totpFirst, ...d.secretFirst]) {
    assert.equal(r.cursor, 'pointer', 'no pointer cursor on ' + JSON.stringify(r.label))
    assert.equal(r.role, 'button', 'no button role on ' + JSON.stringify(r.label))
    assert.match(r.tip, /copy/i, 'no tooltip on ' + JSON.stringify(r.label))
    assert.equal(r.copiedText, '', 'the pill is visible before any click on ' + JSON.stringify(r.label))
  }
})

test('NEITHER THE SEED NOR A SECRET NOR A CODE IS ON SCREEN', { skip: SKIP }, async () => {
  const d = await probeOnce()
  assert.equal(d.seedOnScreen, false, 'a base32 seed was rendered in the document')
  assert.equal(d.secretOnScreen, false, 'a secret text was rendered in the document')
  assert.equal(d.codeOnScreen, false, 'a six-digit run was rendered: ' + JSON.stringify(d.codeOnScreen))
})

test('the mask hides the value AND its length, Show reveals, Hide restores', { skip: SKIP }, async () => {
  const d = await probeOnce()
  assert.equal(d.maskedBefore, '••••••••', 'the mask is not the fixed bullets')
  assert.equal(d.showLabel, 'Hide')
  assert.equal(d.shownValue, 'sk-test-TESTONLY456', 'Show did not reveal the secret')
  assert.equal(d.maskedAfter, '••••••••', 'Hide did not re-mask the secret')
})

test('the TOTP copy confirms without throwing', { skip: SKIP }, async () => {
  const d = await probeOnce()
  assert.equal(d.totpCopyLabel, 'Copied', 'the TOTP copy did not confirm')
})

test('clicking the row puts the EXACT secret text on the real clipboard', { skip: SKIP }, async () => {
  const d = await probeOnce()
  // READ IN THE MAIN PROCESS — the only real receipt for command 23.  The
  // copy ran while the row was masked, so this also proves the copy reads
  // the model and not the mask.  EXACT: an almost-right credential is wrong.
  assert.equal(d.clipboard, 'sk-test-TESTONLY456',
    'the clipboard does not hold the secret: ' + JSON.stringify(d.clipboard))
  assert.equal(d.secretCopyLabel, 'Copied')
})

test('TOTP Add REFUSES an unusable seed instead of writing it', { skip: SKIP }, async () => {
  const d = await probeOnce()
  assert.equal(d.totpFormShown, true, 'the TOTP add form did not open')
  assert.match(d.totpRefused, /base32/, 'no reason given for the refusal')
  assert.equal(d.totpRowsAfterRefusal, 1, 'a refused secret was written anyway')
})

test('TOTP Add writes ONE entry and nothing else moves', { skip: SKIP }, async () => {
  const d = await probeOnce()
  assert.equal(d.totpAfterAdd.length, 2, 'the new TOTP entry did not appear')
  assert.equal(d.totpAfterAdd[1].label, 'Added By Test')
  assert.equal(d.totpAfterAdd[1].comment, 'added comment')
  assert.equal(d.totpAfterAdd[1].copiedText, '', 'the added entry is not usable')
})

test('secret-text Add REFUSES a missing label, then writes a two-line entry', { skip: SKIP }, async () => {
  const d = await probeOnce()
  assert.match(d.secRefused, /label/, 'no reason given for the refusal')
  assert.equal(d.secretAfterAdd.length, 3, 'the new secret entry did not appear')
  assert.equal(d.secretAfterAdd[2].label, 'Probe Added')
  assert.equal(d.secretAfterAdd[2].comment, 'probe comment')
})

test('Edit replaces the secret entry’s own lines and nothing else', { skip: SKIP }, async () => {
  const d = await probeOnce()
  assert.equal(d.secretEditOpened, true, 'the secret edit form did not open')
  assert.deepEqual(d.secretAfterEdit.map((r) => r.label), ['Stripe Test Key', 'Multi Line', 'Probe Edited'])
  assert.equal(d.secretAfterEdit[2].comment, 'edited comment')
  // The edit legs run before the delete leg, so their document is
  // `docAfterSecretEdit` — `docText` is read after the delete below.
  assert.equal(d.docAfterSecretEdit.includes('# Probe Edited'), true, 'the edited label is not in the document')
  assert.equal(d.docAfterSecretEdit.includes('# comment: edited comment'), true, 'the edited comment is not in the document')
  assert.equal(d.docAfterSecretEdit.includes('edited-value-1'), true, 'the edited secret is not in the document')
  assert.equal(d.docAfterSecretEdit.includes('Probe Added'), false, 'the old label survived the edit')
  assert.equal(d.docAfterSecretEdit.includes('probe-value-1'), false, 'the old secret survived the edit')
  // The neighbours did not move: fixture labels, secrets and comments intact.
  assert.equal(d.docAfterSecretEdit.includes('sk-test-TESTONLY456'), true, 'the neighbouring secret went missing')
  assert.equal(d.docAfterSecretEdit.includes('# comment: billing'), true, 'the neighbouring comment went missing')
})

test('Edit renames the TOTP entry and keeps its seed', { skip: SKIP }, async () => {
  const d = await probeOnce()
  assert.equal(d.totpEditOpened, true, 'the TOTP edit form did not open')
  assert.deepEqual(d.totpAfterEdit.map((r) => r.label), ['Example Issuer', 'Added Edited'])
  assert.equal(d.totpAfterEdit[1].comment, 'edited totp comment')
  assert.equal(d.totpAfterEdit[1].copiedText, '', 'the edited entry is not usable')
  assert.equal(d.docAfterTotpEdit.includes('Added By Test'), false, 'the old TOTP label survived the edit')
  assert.equal(d.docAfterTotpEdit.includes(SEED_B), true, 'the kept TOTP seed went missing')
})

test('Delete asks first: Cancel keeps, the modal Delete removes', { skip: SKIP }, async () => {
  const d = await probeOnce()
  assert.equal(d.modalTitle, 'Delete secret', 'no confirm dialog on Delete')
  assert.equal(d.rowsAfterCancel, 3, 'Cancel deleted the entry anyway')
  assert.equal(d.deleted, true, 'the edited row was not found for deletion')
  assert.deepEqual(d.secretAfterDelete.map((r) => r.label), ['Stripe Test Key', 'Multi Line'])
  assert.equal(d.docText.includes('Probe Edited'), false, 'the deleted label is still in the document')
  assert.equal(d.docText.includes('edited-value-1'), false, 'the deleted secret is still in the document')
  assert.equal(d.docText.includes('edited comment'), false, 'the deleted comment is still in the document')
  // The edited TOTP entry STAYS — Delete takes one entry, not the section.
  assert.equal(d.docText.includes('Added Edited'), true, 'the kept TOTP entry went missing')
  assert.equal(d.docText.includes(SEED_B), true, 'the kept TOTP seed went missing')
  // The marker and both fences survive every mutation above.
  assert.equal(d.docText.includes('cairn-type: secrets'), true, 'the marker went missing')
  assert.equal(d.diskError, undefined, 'could not read the vault file: ' + d.diskError)
  assert.equal(d.diskText, d.docText, 'the file on disk is not the flushed document')
})
