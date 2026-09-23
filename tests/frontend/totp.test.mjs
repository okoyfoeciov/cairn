/**
 * tests/frontend/totp.test.mjs — §0.46 E94's model, with no DOM.
 *
 * THE CODES ARE PINNED AGAINST RFC 6238 APPENDIX B, NOT AGAINST THIS CODE.
 * A TOTP implementation that is self-consistent and wrong is indistinguishable
 * from a correct one until the day it locks somebody out of an account, so the
 * expected values here are transcribed from the RFC's own published table and
 * from RFC 4226 Appendix D. That is the only kind of assertion worth making
 * about a crypto primitive.
 *
 * NO REAL SECRET APPEARS IN THIS FILE. The seeds are the RFC's own
 * `12345678901234567890` and the well-known `JBSWY3DPEHPK3PXP` ("Hello!" in
 * base32) from the plugin's own doc comment. The user's live credentials note
 * was read to learn the BLOCK GRAMMAR and nothing from it is reproduced here.
 */

import { strict as assert } from 'node:assert'
import { test, before } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '..', '..')

/* The module is TypeScript, so it is bundled with the SAME esbuild the app
   ships with (CONTRACT §6.3 pins the version) and imported from tmp — the
   established harness in `tables.test.mjs` and `livepreview.test.mjs`. */
/** @type {any} */ let M

before(async () => {
  const esbuild = await import(pathToFileURL(join(ROOT, 'node_modules', 'esbuild', 'lib', 'main.js')).href)
  const dir = mkdtempSync(join(tmpdir(), 'cairn-totp-'))
  process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })
  const out = join(dir, 'bundle.mjs')
  await esbuild.build({
    stdin: {
      contents: 'export * from ' + JSON.stringify(join(ROOT, 'src', 'totp.ts')) + '\n',
      resolveDir: ROOT,
      sourcefile: 'totp-test-entry.ts',
      loader: 'ts',
    },
    outfile: out, bundle: true, format: 'esm', platform: 'neutral',
    mainFields: ['module', 'main'], conditions: ['import', 'default'],
    target: 'es2021', absWorkingDir: ROOT, logLevel: 'silent',
  })
  M = await import(pathToFileURL(out).href)
})

/** RFC 6238 Appendix B: the seed is the ASCII "12345678901234567890". */
const SEED = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'

const entry = (over = {}) => ({
  label: 'x', secret: SEED, digits: 8, period: 30, algorithm: 'SHA-1',
  error: null, from: 0, to: 0, ...over,
})

test('base32 decodes the RFC seed to its ASCII bytes', () => {
  const b = M.base32Decode(SEED)
  assert.equal(new TextDecoder().decode(b), '12345678901234567890')
})

test('base32 ignores spacing and case, as providers print it', () => {
  const want = new TextDecoder().decode(M.base32Decode('JBSWY3DPEHPK3PXP'))
  for (const v of ['jbswy3dpehpk3pxp', 'JBSW Y3DP EHPK 3PXP', 'JBSW-Y3DP-EHPK-3PXP', 'JBSWY3DPEHPK3PXP===']) {
    assert.equal(new TextDecoder().decode(M.base32Decode(v)), want, v)
  }
})

test('base32 REFUSES what is not base32 rather than decoding garbage', () => {
  for (const v of ['', '   ', '!!!!', 'ABC1', 'ABC8', 'abc0']) {
    assert.throws(() => M.base32Decode(v), /base32|empty/, JSON.stringify(v))
  }
})

test('RFC 6238 Appendix B — all six SHA-1 vectors, to the digit', async () => {
  // time (s) -> expected 8-digit code, transcribed from the RFC's table.
  const vectors = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ]
  for (const [t, want] of vectors) {
    const got = await M.totpCode(entry(), t * 1000)
    assert.equal(got, want, 'T=' + t)
  }
})

test('six digits is the last six of the RFC\'s eight — the default shape', async () => {
  assert.equal(await M.totpCode(entry({ digits: 6 }), 59_000), '287082')
  assert.equal(await M.totpCode(entry({ digits: 6 }), 1111111109_000), '081804')
})

test('the time-step counter tracks the period', () => {
  assert.equal(M.counterAt(59_000, 30), 1)
  assert.equal(M.counterAt(1111111109_000, 30), 37037036)
  assert.equal(M.counterAt(59_000, 60), 0)
  // §0.46.6 removed the countdown, so `secondsLeft` went with it — and so did
  // this test's assertions on it. A test kept for a deleted function is how a
  // module grows exports nothing calls.
  assert.equal(M.secondsLeft, undefined, 'secondsLeft came back without a caller')
})

/* ── the block grammar ──────────────────────────────────────────────────── */

test('THE PLUGIN\'S OWN SHAPE parses identically — one label, one seed', () => {
  // This is the shape of every block in the user's live credentials note. If
  // this test ever fails, that file stops producing codes.
  const e = M.parseEntries('# Google (for a@example.com)\n' + SEED + '\n', 0)
  assert.equal(e.length, 1)
  assert.equal(e[0].label, 'Google (for a@example.com)')
  assert.equal(e[0].secret, SEED)
  assert.equal(e[0].error, null)
  assert.equal(e[0].digits, 6)
  assert.equal(e[0].period, 30)
})

test('consecutive comment lines join with " / ", as the plugin does', () => {
  const e = M.parseEntries('# Google\n# work account\n' + SEED, 0)
  assert.equal(e.length, 1)
  assert.equal(e[0].label, 'Google / work account')
})

test('ONE BLOCK, MANY ENTRIES — the divergence the user asked for', () => {
  const e = M.parseEntries('# A\n' + SEED + '\n\n# B\nJBSWY3DPEHPK3PXP\n# C\n' + SEED, 0)
  assert.deepEqual(e.map((x) => x.label), ['A', 'B', 'C'])
  assert.deepEqual(e.map((x) => x.error), [null, null, null])
})

test('a trailing `# note` on a seed line is a comment, not base32', () => {
  const e = M.parseEntries('# A\n' + SEED + '  # rotated 2026-01-01', 0)
  assert.equal(e.length, 1)
  assert.equal(e[0].secret, SEED)
  assert.equal(e[0].error, null)
})

test('spaces WITHIN a seed line are joined — providers print seeds in groups', () => {
  const e = M.parseEntries('# A\nJBSW Y3DP EHPK 3PXP', 0)
  assert.equal(e[0].secret, 'JBSWY3DPEHPK3PXP')
  assert.equal(e[0].error, null)
})

test('a label with no seed is an ERROR ROW, not a silent disappearance', () => {
  const e = M.parseEntries('# A\n# B\n', 0)
  assert.equal(e.length, 1)
  assert.match(e[0].error, /no secret/)
})

test('a bad seed fails ITS OWN row and leaves the others working', () => {
  const e = M.parseEntries('# good\n' + SEED + '\n# bad\n!!!!not-base32!!!!\n# also good\nJBSWY3DPEHPK3PXP', 0)
  assert.equal(e.length, 3)
  assert.equal(e[0].error, null)
  assert.match(e[1].error, /base32/)
  assert.equal(e[2].error, null)
})

test('entries carry document offsets, so a row knows where it lives', () => {
  const body = '# A\n' + SEED
  const e = M.parseEntries(body, 100)
  assert.equal(e[0].from, 100)
  assert.equal(e[0].to, 100 + body.length)
})

/* ── otpauth:// ─────────────────────────────────────────────────────────── */

test('an otpauth URI carries its own digits, period and algorithm', () => {
  const p = M.parseOtpauth(
    'otpauth://totp/ACME%20Co:alice@example.com?secret=' + SEED +
    '&issuer=ACME%20Co&algorithm=SHA256&digits=8&period=60'
  )
  assert.equal(p.error, null)
  assert.equal(p.label, 'ACME Co (alice@example.com)')
  assert.equal(p.secret, SEED)
  assert.equal(p.algorithm, 'SHA-256')
  assert.equal(p.digits, 8)
  assert.equal(p.period, 60)
})

test('otpauth defaults are 6 / 30 / SHA-1 when unstated', () => {
  const p = M.parseOtpauth('otpauth://totp/alice?secret=' + SEED)
  assert.equal(p.digits, 6)
  assert.equal(p.period, 30)
  assert.equal(p.algorithm, 'SHA-1')
  assert.equal(p.label, 'alice')
})

test('HOTP is REFUSED — it is counter-based and has no clock', () => {
  const p = M.parseOtpauth('otpauth://hotp/alice?secret=' + SEED + '&counter=1')
  assert.match(p.error, /only otpauth:\/\/totp/)
})

test('otpauth rejects a missing secret and an out-of-range digits', () => {
  assert.match(M.parseOtpauth('otpauth://totp/a?issuer=b').error, /no secret/)
  assert.match(M.parseOtpauth('otpauth://totp/a?secret=' + SEED + '&digits=99').error, /digits/)
  assert.match(M.parseOtpauth('otpauth://totp/a?secret=' + SEED + '&algorithm=MD5').error, /algorithm/)
  assert.equal(M.parseOtpauth('not a uri at all'), null)
})

test('an otpauth line inside a block becomes an entry', () => {
  const e = M.parseEntries('otpauth://totp/ACME:bob?secret=' + SEED + '&digits=8', 0)
  assert.equal(e.length, 1)
  assert.equal(e[0].digits, 8)
  assert.equal(e[0].error, null)
})

/* ── presentation ──────────────────────────────────────────────────────── */

test('§0.46.6 nothing formats a code for display — there is no display', () => {
  // `groupCode` grouped a code as `482 915` for the on-screen readout. The user
  // ruled the readout out ("I don't want code or countdown, really"), which left
  // the function with no caller, so it is deleted. The copy has always been the
  // raw digits, and now that is the only form a code ever takes.
  assert.equal(M.groupCode, undefined, 'groupCode came back without a caller')
})

/* ── comment (user feature, 2026-09-16) ─────────────────────────────────── */

test('a `# comment:` line annotates the entry instead of joining the label', () => {
  const e = M.parseEntries('# Google\n# comment: for work\n' + SEED, 0)
  assert.equal(e.length, 1)
  assert.equal(e[0].label, 'Google')
  assert.equal(e[0].comment, 'for work')
  assert.equal(e[0].secret, SEED)
  assert.equal(e[0].error, null)
})

test('the comment prefix is case-insensitive and tolerates spacing', () => {
  for (const line of ['# Comment: for work', '#COMMENT:for work', '#   comment:   for work  ']) {
    const e = M.parseEntries('# Google\n' + line + '\n' + SEED, 0)
    assert.equal(e.length, 1, line)
    assert.equal(e[0].label, 'Google', line)
    assert.equal(e[0].comment, 'for work', line)
  }
})

test('several comment lines join with newlines, in order', () => {
  const e = M.parseEntries('# Google\n# comment: one\n# comment: two\n' + SEED, 0)
  assert.equal(e.length, 1)
  assert.equal(e[0].comment, 'one\ntwo')
})

test('a comment before any label attaches to the coming entry', () => {
  const e = M.parseEntries('# comment: early\n# Google\n' + SEED, 0)
  assert.equal(e.length, 1)
  assert.equal(e[0].label, 'Google')
  assert.equal(e[0].comment, 'early')
})

test('plain `#` lines still join the label — only `comment:` is special', () => {
  const e = M.parseEntries('# Google\n# work account\n' + SEED, 0)
  assert.equal(e.length, 1)
  assert.equal(e[0].label, 'Google / work account')
  assert.equal(e[0].comment, '')
})

test('entries without a comment carry the empty string, not undefined', () => {
  const e = M.parseEntries('# Google\n' + SEED, 0)
  assert.equal(e[0].comment, '')
  assert.equal(M.parseOtpauth('otpauth://totp/alice?secret=' + SEED).comment, '')
})

test('a `# Label` above an otpauth URI labels that entry — no error row', () => {
  const uri = 'otpauth://totp/ACME:bob?secret=' + SEED + '&digits=8'
  const e = M.parseEntries('# My Name\n# comment: mine\n' + uri, 0)
  assert.equal(e.length, 1, 'the label must not flush as a second row')
  assert.equal(e[0].label, 'My Name')
  assert.equal(e[0].comment, 'mine')
  assert.equal(e[0].digits, 8)
  assert.equal(e[0].secret, SEED)
  assert.equal(e[0].error, null)
})

test('a URI with bad params keeps the pending label on its ONE error row', () => {
  const e = M.parseEntries('# Waiting\notpauth://totp/a?secret=' + SEED + '&digits=99', 0)
  assert.equal(e.length, 1, 'the label must not flush as a second row')
  assert.equal(e[0].label, 'Waiting')
  assert.match(e[0].error, /digits/)
})

test('an unparseable URI keeps the pending label instead of dropping it', () => {
  // A space in the host makes `new URL` throw, so `parseOtpauth` is null.
  const e = M.parseEntries('# Waiting\notpauth://a b/', 0)
  assert.equal(e.length, 2)
  assert.equal(e[0].label, 'Waiting')
  assert.match(e[0].error, /no secret/)
  assert.match(e[1].error, /valid otpauth/)
})

test('formatTotpEntry omits the comment line when empty — the old shape', () => {
  assert.equal(M.formatTotpEntry('Added By Test', '', SEED), '# Added By Test\n' + SEED)
  assert.equal(M.formatTotpEntry('', '', SEED), SEED)
})

test('formatTotpEntry round-trips through parseEntries', () => {
  const text = M.formatTotpEntry('Google', 'for work', SEED)
  const e = M.parseEntries(text, 0)
  assert.equal(e.length, 1)
  assert.equal(e[0].label, 'Google')
  assert.equal(e[0].comment, 'for work')
  assert.equal(e[0].secret, SEED)
  assert.equal(e[0].error, null)
})

test('a multi-line comment re-emits one `# comment:` line each', () => {
  const text = M.formatTotpEntry('Google', 'one\ntwo', SEED)
  assert.equal(text, '# Google\n# comment: one\n# comment: two\n' + SEED)
  assert.equal(M.parseEntries(text, 0)[0].comment, 'one\ntwo')
})

/* F42: a malformed %-escape in an otpauth URI must not throw. `new URL` keeps
 * `%E9` untouched and `decodeURIComponent` then throws URIError — which used
 * to propagate out of EditorState.create and wedge the editor, so the next
 * autosave overwrote the note. The label falls back to the raw text. */
test('F42: parseOtpauth with a bad %-escape does not throw', () => {
  const p = M.parseOtpauth('otpauth://totp/Banque%20Soci%E9t%E9:me?secret=' + SEED)
  assert.equal(p.secret, SEED)
  assert.equal(p.error, null)
  assert.equal(p.label, 'me')
})

test('F42: parseOtpauth with a literal % does not throw', () => {
  const p = M.parseOtpauth('otpauth://totp/50%off?secret=' + SEED)
  assert.ok(p)
})

test('F42: parseEntries over a body with a bad escape returns entries', () => {
  const e = M.parseEntries('# Old bank\notpauth://totp/Banque%20Soci%E9t%E9:me?secret=' + SEED, 0)
  assert.equal(e.length, 1)
  assert.equal(e[0].secret, SEED)
  assert.equal(e[0].error, null)
})
