// `node --test tests/frontend/*.test.mjs`.
//
// F85/F86 — A LONG LINE MUST COST LINEAR TIME, IN BOTH TOKENISERS THAT RUN ON EVERY
// KEYSTROKE.
//
// 1. `livepreview.ts`'s email branch.  `scanInline` tries `EMAIL_RE` at every
//    position of a line that holds an `@`, and a failed attempt's local part
//    runs greedily to the end of its delimiter-free run before backtracking.
//    A 60k base64 blob, a hex dump or a CJK paragraph is ONE such run, so the
//    scan was quadratic in it: seconds per rebuild, and a rebuild happens on
//    every keystroke and every cursor move while the line is on screen.
// 2. `tables.ts`'s simple-row test, Obsidian's `hU`
//    (`/^\s*[^|].*?\|.*[^|]\s*$/`), which backtracks quadratically on a long
//    line that ends in `|` and runs over the whole document on note open.
//
// Each has a cost row that fails on the quadratic code by two orders of
// magnitude, and a row pinning that the answers did not change: the email fix
// is a skip, not a new rule, and the row test is Obsidian's regex, so the
// linear version is checked against the regex literal itself.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '..', '..')

/** @type {any} */ let LP
/** @type {any} */ let T

before(async () => {
  const esbuild = await import(pathToFileURL(join(ROOT, 'node_modules', 'esbuild', 'lib', 'main.js')).href)
  const dir = mkdtempSync(join(tmpdir(), 'cairn-cost-'))
  process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })
  const out = join(dir, 'bundle.mjs')
  await esbuild.build({
    stdin: {
      // ONE bundle: `tables.ts` imports `livepreview.ts`, and a StateField is
      // matched by identity.
      contents:
        'export * as LP from ' + JSON.stringify(join(ROOT, 'src', 'livepreview.ts')) + '\n' +
        'export * as T from ' + JSON.stringify(join(ROOT, 'src', 'tables.ts')) + '\n' +
        "export { EditorState, Text } from '@codemirror/state'\n",
      resolveDir: ROOT,
      sourcefile: 'long-line-cost-entry.ts',
      loader: 'ts',
    },
    outfile: out, bundle: true, format: 'esm', platform: 'neutral',
    mainFields: ['module', 'main'], conditions: ['import', 'default'],
    target: 'es2021', absWorkingDir: ROOT, logLevel: 'silent',
  })
  const M = await import(pathToFileURL(out).href)
  LP = { ...M.LP, EditorState: M.EditorState }
  T = { ...M.T, Text: M.Text, EditorState: M.EditorState }
  // Warm the code paths once, so the first timed row measures the scan and
  // not the engine's first compile of it.
  timedUrls('warm up **b** `c` [l](u) a@b.io https://x.io\n')
})

/** A fixed-seed base64 run: no delimiter any tokeniser branch stops at. */
function b64(n) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let x = 7, s = ''
  for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) >>> 0; s += A[(x >>> 16) & 63] }
  return s
}

function cjk(n) {
  let s = ''
  for (let i = 0; i < n; i++) s += String.fromCharCode(0x4e00 + (i * 7919) % 0x51a5)
  return s
}

const st = (doc) => LP.EditorState.create({ doc, extensions: [LP.blockIndex] })

/** One full decoration pass, timed; returns the `nc-url` ranges it drew. */
function timedUrls(doc) {
  const s = st(doc)
  const t0 = performance.now()
  const b = LP.buildDecorations(s, [{ from: 0, to: s.doc.length }], LP.markdownSource, [])
  const ms = performance.now() - t0
  const urls = []
  b.decorations.between(0, s.doc.length, (from, to, v) => {
    if (v.spec.class === 'nc-url') urls.push(doc.slice(from, to))
  })
  return { ms, urls }
}

function urlsOf(doc) {
  const s = st(doc)
  const out = []
  LP.markdownSource.constructsIn(s, 0, s.doc.length, (c) => {
    if (c.kind === 'url') out.push([c.from, c.to])
  })
  return out
}

/* ── the email branch ────────────────────────────────────────────────────── */

test('a 60k delimiter-free run beside an email is scanned in linear time', () => {
  const doc = 'Signed blob for ops@example.com: ' + b64(60000) + '\n'
  const { ms, urls } = timedUrls(doc)
  // Quadratic: 1.6-4.7 s in node.  Linear: a few ms.
  assert.ok(ms < 250, `one rebuild took ${ms.toFixed(1)} ms`)
  assert.deepEqual(urls, ['ops@example.com'], 'the email is still linkified')
})

test('a long dotted chain beside an email is scanned in linear time', () => {
  const doc = 'mail ops@example.com ' + 'ab.'.repeat(20000) + '\n'
  const { ms, urls } = timedUrls(doc)
  assert.ok(ms < 250, `one rebuild took ${ms.toFixed(1)} ms`)
  assert.deepEqual(urls, ['ops@example.com'])
})

test('a long CJK paragraph that mentions an address is scanned in linear time', () => {
  const doc = cjk(20000) + ' jane@example.com\n'
  const { ms, urls } = timedUrls(doc)
  assert.ok(ms < 250, `one rebuild took ${ms.toFixed(1)} ms`)
  assert.deepEqual(urls, ['jane@example.com'])
})

test('where an email may start is unchanged by the skip', () => {
  // Pinned to the outputs of the per-position scan.  The first row is the one
  // a "try only at the start of a run" shortcut gets wrong.
  const CASES = [
    ['\\*foo@x.io', [[2, 10]]],
    ['**b**foo@x.io', [[2, 13]]],
    ['a.b`c@x.io', [[0, 10]]],
    ['x`c@x.io', []],
    ['a..b@x.io', [[3, 9]]],
    ['foo bar@x.io', [[4, 12]]],
    ['_a_b@x.io', [[1, 9]]],
    ['[t](u)z@x.io', [[6, 12]]],
    ['mail ops@example.com now', [[5, 20]]],
    ['a.b.c@d.e.com', [[0, 13]]],
    ['.a@b.io', [[1, 7]]],
    ['a.@b.io', []],
    ['ab`cd.ef@x.io', []],
    ['ab.c`d@x.io', [[0, 11]]],
    ['jane.doe@example.com, bob@x.org', [[0, 20], [22, 31]]],
    ['a@b.c', []],
    ['foo@bar.baz.', [[0, 11]]],
    ['q*w*e@x.io', [[0, 10]]],
    ['~~a~~b@x.io', [[2, 11]]],
    ['日本語テキストjane@example.com', [[0, 23]]],
    ['x\\@y.io', []],
    ['a+b-c_d@e-f.gh', [[0, 14]]],
  ]
  for (const [doc, want] of CASES) assert.deepEqual(urlsOf(doc), want, JSON.stringify(doc))
})

/* ── the table row test ─────────────────────────────────────────────────── */

/** Obsidian's `hU`, verbatim: the specification `isSimpleRow` must equal. */
const ORACLE = /^\s*[^|].*?\|.*[^|]\s*$/

test('isSimpleRow is exactly Obsidian\'s hU regex', () => {
  const ALPHA = ['|', ' ', 'a', '\t', ' ', ' ', '-', ':', '\n', '\r', '﻿']
  let checked = 0
  const walk = (s) => {
    assert.equal(T.isSimpleRow(s), ORACLE.test(s), JSON.stringify(s))
    checked++
    if (s.length < 5) for (const c of ALPHA) walk(s + c)
  }
  walk('')
  // And longer strings, seeded.
  let x = 12345
  const rnd = (n) => { x = (x * 1103515245 + 12345) >>> 0; return (x >>> 16) % n }
  for (let k = 0; k < 20000; k++) {
    let s = ''
    const len = 6 + rnd(24)
    for (let i = 0; i < len; i++) s += ALPHA[rnd(ALPHA.length)]
    assert.equal(T.isSimpleRow(s), ORACLE.test(s), JSON.stringify(s))
    checked++
  }
  assert.ok(checked > 170000)
})

test('a 40 KB line ending in `|` does not stall the table index', () => {
  const t0 = performance.now()
  T.TableIndex.scanAll(T.Text.of(['', 'a|'.repeat(20000), '']))
  const ms = performance.now() - t0
  // Quadratic: ~0.45 s in node.  Linear: ~1 ms.
  assert.ok(ms < 100, `scanAll took ${ms.toFixed(1)} ms`)
})

test('an 80 KB indented pipe row does not stall the table index', () => {
  const t0 = performance.now()
  T.TableIndex.scanAll(T.Text.of(['', '  ' + '| a '.repeat(20000) + '|']))
  const ms = performance.now() - t0
  // Quadratic: ~5 s in node.
  assert.ok(ms < 100, `scanAll took ${ms.toFixed(1)} ms`)
})

test('a keystroke beside such a line is cheap', () => {
  const s0 = T.EditorState.create({
    doc: ['', 'a|'.repeat(20000), 'next', '', 'x'].join('\n'),
    extensions: [T.tables],
  })
  const at = s0.doc.line(3).to
  const t0 = performance.now()
  const tr = s0.update({ changes: { from: at, insert: 'z' } })
  void tr.state.field(T.tableIndex)
  const ms = performance.now() - t0
  assert.ok(ms < 50, `one keystroke took ${ms.toFixed(1)} ms`)
})
