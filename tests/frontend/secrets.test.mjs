/**
 * tests/frontend/secrets.test.mjs — the secret file's model, with no DOM.
 *
 * WHAT IS BEING GUARDED, AND WHY EACH CASE EXISTS
 * The marker is a security boundary in both directions: a secret file that
 * the viewer does NOT recognise renders its seeds as source, and a normal
 * note that the backend DOES recognise vanishes from content search.  So
 * `isSecretText` is pinned with the same vectors as `is_secret_head` in
 * `core/src/search.rs` — the two detectors must always agree, and a case
 * added to one belongs in the other.
 *
 * The `secret` fence is opaque text with a required label.  The cases pin
 * that multi-line values survive verbatim (inner blanks kept, edge blanks
 * trimmed), that label-less and valueless entries are VISIBLE ERRORS rather
 * than silent drops (E94's philosophy), and that every entry's offsets cover
 * exactly its lines — Delete writes those offsets, so a wrong `to` eats the
 * next entry.
 *
 * NO REAL SECRET APPEARS IN THIS FILE.  Seeds are RFC 6238's own and
 * `JBSWY3DPEHPK3PXP`; secret texts are obvious fixtures.
 */

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '..', '..')

/** @type {any} */ let S
/** @type {any} */ let LP
/** @type {any} */ let CM

before(async () => {
  const esbuild = await import(pathToFileURL(join(ROOT, 'node_modules', 'esbuild', 'lib', 'main.js')).href)
  const dir = mkdtempSync(join(tmpdir(), 'cairn-secrets-'))
  process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })
  const out = join(dir, 'bundle.mjs')
  await esbuild.build({
    stdin: {
      contents:
        "export * as S from " + JSON.stringify(join(ROOT, 'src', 'secrets.ts')) + "\n" +
        "export * as LP from " + JSON.stringify(join(ROOT, 'src', 'livepreview.ts')) + "\n" +
        "export { EditorState, Text } from '@codemirror/state'\n",
      resolveDir: ROOT,
      sourcefile: 'secrets-test-entry.ts',
      loader: 'ts',
    },
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    mainFields: ['module', 'main'],
    conditions: ['import', 'default'],
    target: 'es2021',
    absWorkingDir: ROOT,
    logLevel: 'silent',
  })
  const mod = await import(pathToFileURL(out).href)
  S = mod.S
  LP = mod.LP
  CM = mod
})

/** A state with the real incremental fence index over `text`. */
const stateOf = (text) => CM.EditorState.create({
  doc: text,
  extensions: [LP.blockIndex],
})

test('bundled harness exposes the secrets model', () => {
  assert.equal(typeof S.isSecretText, 'function')
  assert.equal(typeof S.parseSecretFile, 'function')
  assert.equal(typeof S.SECRET_TEMPLATE, 'string')
})

/* =========================================================================
 * 1.  The marker — the same vectors as `is_secret_head` in search.rs.
 *     A case added to one belongs in the other.
 * ========================================================================= */

test('isSecretText recognises the marker file', () => {
  assert.equal(S.isSecretText('---\ncairn-type: secrets\n---\n'), true)
  assert.equal(S.isSecretText('---\ntitle: Creds\ncairn-type: secrets\n---\nbody'), true)
  assert.equal(S.isSecretText('---\ncairn-type: secrets\ntitle: Creds\n---\nbody'), true)
  assert.equal(S.isSecretText('---\r\ncairn-type: secrets\r\n---\r\n'), true)
  assert.equal(S.isSecretText(S.SECRET_TEMPLATE), true)
})

test('isSecretText refuses everything else — a false positive hides a note', () => {
  for (const [v, why] of [
    ['', 'empty'],
    ['---\n', 'opener only'],
    ['no frontmatter at all\ncairn-type: secrets\n', 'no frontmatter'],
    ['--- \ncairn-type: secrets\n---\n', 'opener with trailing space'],
    ['----\ncairn-type: secrets\n----\n', 'four dashes is a break'],
    [' ---\ncairn-type: secrets\n---\n', 'indented opener'],
    ['---\ncairn-type: secrets\n', 'no closer at all'],
    ['---\ntitle: x\n---\ncairn-type: secrets\n', 'marker after the closer'],
    ['---\n  cairn-type: secrets\n---\n', 'indented marker is nested YAML'],
    ['---\ncairn-type: secrets \n---\n', 'trailing space on the marker'],
    ['---\ncairn-type: secret\n---\n', 'near-miss value'],
    ['---\ncairn-type: secrets-extra\n---\n', 'near-miss key'],
    ['---\n# cairn-type: secrets\n---\n', 'a comment is not the marker'],
  ]) assert.equal(S.isSecretText(v), false, why)
})

test('isSecretText is false for the old mixed note — Misc.md is untouched', () => {
  const misc = [
    'Are you ready?', '', 'This is a test line.', '',
    '# oursprivacy key', 'api_key_asdfasdx', '',
    '```totp', '# Google (for eastagile@moldco.com)', 'asjdkfajsdfasdf', '```',
  ].join('\n')
  assert.equal(S.isSecretText(misc), false)
})

/* =========================================================================
 * 2.  The template parses to two empty fences.
 * ========================================================================= */

test('SECRET_TEMPLATE is a secret with one empty fence of each kind', () => {
  const st = stateOf(S.SECRET_TEMPLATE)
  const f = S.parseSecretFile(st)
  assert.equal(f.totps.length, 1)
  assert.equal(f.secrets.length, 1)
  assert.deepEqual([...f.totps[0].entries], [])
  assert.deepEqual([...f.secrets[0].entries], [])
})

/* =========================================================================
 * 3.  The `secret` fence — labels required, values verbatim and multi-line.
 * ========================================================================= */

const SECRET_DOC = [
  '---', 'cairn-type: secrets', '---', '',
  '```secret',
  '# Stripe API key',
  'sk-live-TESTONLY123',
  '# Deploy key',
  'line one of the secret',
  '',
  'line three after a blank',
  '# Empty below',
  '# Joined / label',
  '# continues here',
  'value for the joined label',
  '```',
  '',
].join('\n')

test('secret entries parse with labels and verbatim multi-line values', () => {
  const st = stateOf(SECRET_DOC)
  const f = S.parseSecretFile(st)
  assert.equal(f.secrets.length, 1)
  const es = [...f.secrets[0].entries]
  assert.equal(es.length, 3)
  assert.equal(es[0].label, 'Stripe API key')
  assert.equal(es[0].secret, 'sk-live-TESTONLY123')
  assert.equal(es[0].error, null)
  // The inner blank line is the secret's business and is kept.
  assert.equal(es[1].label, 'Deploy key')
  assert.equal(es[1].secret, 'line one of the secret\n\nline three after a blank')
  assert.equal(es[1].error, null)
  // Consecutive `#` lines are ONE label — the plugin's rule, so `# Empty
  // below` joins rather than becoming a labelless error row.
  assert.equal(es[2].label, 'Empty below / Joined / label / continues here')
  assert.equal(es[2].secret, 'value for the joined label')
})

test('entry offsets cover exactly their lines — Delete writes these', () => {
  const st = stateOf(SECRET_DOC)
  const f = S.parseSecretFile(st)
  const es = [...f.secrets[0].entries]
  const doc = st.doc.toString()
  assert.match(doc.slice(es[0].from, es[0].to), /^# Stripe API key\nsk-live-TESTONLY123$/)
  assert.match(doc.slice(es[1].from, es[1].to),
    /^# Deploy key\nline one of the secret\n\nline three after a blank$/)
})

test('label-less and value-less entries are visible errors, not silent drops', () => {
  const text = [
    '---', 'cairn-type: secrets', '---', '',
    '```secret',
    'orphan secret with no label',
    '# Label with no secret',
    '```', '',
  ].join('\n')
  const st = stateOf(text)
  const f = S.parseSecretFile(st)
  const es = [...f.secrets[0].entries]
  assert.equal(es.length, 2)
  assert.equal(es[0].label, '')
  assert.equal(es[0].secret, 'orphan secret with no label')
  assert.equal(es[0].error, 'label required')
  assert.equal(es[1].label, 'Label with no secret')
  assert.equal(es[1].secret, '')
  assert.equal(es[1].error, 'no secret text for this label')
})

test('leading and trailing blank lines are not the secret', () => {
  const text = [
    '---', 'cairn-type: secrets', '---', '',
    '```secret',
    '# Padded',
    '',
    'inner',
    '',
    '',
    '```', '',
  ].join('\n')
  const st = stateOf(text)
  const es = [...S.parseSecretFile(st).secrets[0].entries]
  assert.equal(es.length, 1)
  assert.equal(es[0].secret, 'inner')
  assert.equal(es[0].error, null)
})

test('an unclosed secret fence runs to the document end', () => {
  const text = ['---', 'cairn-type: secrets', '---', '', '```secret', '# Late', 'tail'].join('\n')
  const st = stateOf(text)
  const f = S.parseSecretFile(st)
  assert.equal(f.secrets.length, 1)
  const es = [...f.secrets[0].entries]
  assert.equal(es.length, 1)
  assert.equal(es[0].secret, 'tail')
})

test('the fence info string is case-insensitive, like totp', () => {
  const text = ['---', 'cairn-type: secrets', '---', '', '```SECRET', '# A', 'b', '```', ''].join('\n')
  const f = S.parseSecretFile(stateOf(text))
  assert.equal(f.secrets.length, 1)
  assert.equal([...f.secrets[0].entries].length, 1)
})

/* =========================================================================
 * 4.  TOTP fences are reused, not reimplemented.
 * ========================================================================= */

const SEED_A = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
const SEED_B = 'JBSWY3DPEHPK3PXP'

test('totp fences parse through the shared grammar, bad seeds flagged', () => {
  const text = [
    '---', 'cairn-type: secrets', '---', '',
    '```totp',
    '# Example Issuer',
    SEED_A,
    '# Broken On Purpose',
    '!!!not-base32!!!',
    '```', '',
  ].join('\n')
  const f = S.parseSecretFile(stateOf(text))
  assert.equal(f.totps.length, 1)
  const es = [...f.totps[0].entries]
  assert.equal(es.length, 2)
  assert.equal(es[0].label, 'Example Issuer')
  assert.equal(es[0].secret, SEED_A)
  assert.equal(es[0].error, null)
  assert.equal(es[1].label, 'Broken On Purpose')
  assert.notEqual(es[1].error, null)
})

/* =========================================================================
 * 5.  Comment (user feature, 2026-09-16) — label, comment and secret each
 *     editable, so each needs its own field in the model and its own lines
 *     on disk.
 * ========================================================================= */

const COMMENT_DOC = [
  '---', 'cairn-type: secrets', '---', '',
  '```totp',
  '# Google',
  '# comment: for work',
  SEED_A,
  '```', '',
  '```secret',
  '# Stripe API key',
  '# comment: live, do not rotate casually',
  'sk-live-TESTONLY123',
  '# Deploy key',
  'alpha',
  '',
  'beta',
  '```', '',
].join('\n')

test('comment lines parse beside the label instead of joining it', () => {
  const f = S.parseSecretFile(stateOf(COMMENT_DOC))
  const [totp] = [...f.totps[0].entries]
  assert.equal(totp.label, 'Google')
  assert.equal(totp.comment, 'for work')
  assert.equal(totp.secret, SEED_A)
  assert.equal(totp.error, null)
  const es = [...f.secrets[0].entries]
  assert.equal(es.length, 2)
  assert.equal(es[0].label, 'Stripe API key')
  assert.equal(es[0].comment, 'live, do not rotate casually')
  assert.equal(es[0].secret, 'sk-live-TESTONLY123')
  assert.equal(es[0].error, null)
  // No comment means the empty string — the row renders no comment span.
  assert.equal(es[1].label, 'Deploy key')
  assert.equal(es[1].comment, '')
  assert.equal(es[1].secret, 'alpha\n\nbeta')
})

test('a comment before any label attaches to the coming entry', () => {
  const text = [
    '---', 'cairn-type: secrets', '---', '',
    '```secret',
    '# comment: early',
    '# Late Label',
    'tail',
    '```', '',
  ].join('\n')
  const es = [...S.parseSecretFile(stateOf(text)).secrets[0].entries]
  assert.equal(es.length, 1)
  assert.equal(es[0].label, 'Late Label')
  assert.equal(es[0].comment, 'early')
  assert.equal(es[0].secret, 'tail')
  assert.equal(es[0].error, null)
})

test('entry offsets cover the comment lines — Edit replaces these', () => {
  const f = S.parseSecretFile(stateOf(COMMENT_DOC))
  const doc = stateOf(COMMENT_DOC).doc.toString()
  const [totp] = [...f.totps[0].entries]
  assert.match(doc.slice(totp.from, totp.to),
    /^# Google\n# comment: for work\n.+$/)
  const es = [...f.secrets[0].entries]
  assert.match(doc.slice(es[0].from, es[0].to),
    /^# Stripe API key\n# comment: live, do not rotate casually\nsk-live-TESTONLY123$/)
})

test('formatSecretEntry omits the comment line when empty — the old shape', () => {
  assert.equal(S.formatSecretEntry('Probe Added', '', 'probe-value-1\nprobe-value-2'),
    '# Probe Added\nprobe-value-1\nprobe-value-2')
})

test('formatSecretEntry round-trips through parseSecretEntries', () => {
  const text = [
    '---', 'cairn-type: secrets', '---', '',
    '```secret',
    S.formatSecretEntry('Google', 'for work', 'line one\n\nline two'),
    '```', '',
  ].join('\n')
  const es = [...S.parseSecretFile(stateOf(text)).secrets[0].entries]
  assert.equal(es.length, 1)
  assert.equal(es[0].label, 'Google')
  assert.equal(es[0].comment, 'for work')
  assert.equal(es[0].secret, 'line one\n\nline two')
  assert.equal(es[0].error, null)
})
