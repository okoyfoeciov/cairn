/**
 * tests/frontend/memoir.test.mjs — the Memoir page's pure model, with no DOM.
 *
 * WHAT IS BEING GUARDED, AND WHY EACH CASE EXISTS
 * The sentence heuristic decides what the model rephrases: a wrong split bills
 * a turn on two ideas at once and shows a confusing source header. The cases
 * pin the three rules the clone transcribes from memoir's index.html — newline
 * as a hard boundary (the diary's note-style lines), abbreviations and version
 * strings as non-terminators, and a caret parked after a finished sentence
 * taking that sentence. `resolveRange` pins the selection-beats-sentence
 * priority, the 600-char truncation and the edge-whitespace strip (the prompt
 * states the markers touch the span directly).
 */

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '..', '..')

/** @type {any} */ let M

before(async () => {
  const esbuild = await import(pathToFileURL(join(ROOT, 'node_modules', 'esbuild', 'lib', 'main.js')).href)
  const dir = mkdtempSync(join(tmpdir(), 'cairn-memoir-'))
  process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })
  const out = join(dir, 'bundle.mjs')
  await esbuild.build({
    stdin: {
      contents: 'export * as M from ' + JSON.stringify(join(ROOT, 'src', 'memoir.ts')) + '\n',
      resolveDir: ROOT,
      sourcefile: 'memoir-test-entry.ts',
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
  M = mod.M
})

test('harness exposes the memoir model', () => {
  assert.equal(typeof M.resolveRange, 'function')
  assert.equal(typeof M.sentenceAt, 'function')
  assert.equal(typeof M.snapToWords, 'function')
  assert.equal(typeof M.isTerminator, 'function')
  assert.equal(M.MEMOIR_API, 'http://127.0.0.1:8770/api/memoir')
  assert.equal(M.MEMOIR_CHECK_MAX, 12000)
  assert.equal(M.MEMOIR_PARA_MAX, 600)
})

test('isTerminator skips titles, initials and version dots', () => {
  assert.equal(M.isTerminator('Met Dr. Nguyen today', 7), false)
  assert.equal(M.isTerminator('J. Smith came', 1), false)
  assert.equal(M.isTerminator('bumped v2.3.1 today', 10), false)
  assert.equal(M.isTerminator('Rain. Coffee.', 4), true)
  assert.equal(M.isTerminator('Really… Wow', 6), true)
  assert.equal(M.isTerminator('Really… wow', 6), false)
  assert.equal(M.isTerminator('plain text', 3), false)
})

test('snapToWords grows outward and trims inward, never shrinking', () => {
  assert.deepEqual(M.snapToWords('hello brave world', 7, 9), { start: 6, end: 11 })
  assert.deepEqual(M.snapToWords('  padded  ', 0, 10), { start: 2, end: 8 })
  assert.deepEqual(M.snapToWords('one two', 0, 3), { start: 0, end: 3 })
})

test('sentenceAt stops at newlines and takes the finished sentence', () => {
  const text = 'Rain. Coffee, then standup.\nLong day.'
  // Inside the second sentence of line one.
  assert.deepEqual(M.sentenceAt(text, 10), { start: 6, end: 27 })
  // Caret parked just after its period takes that same sentence.
  assert.deepEqual(M.sentenceAt(text, 27), { start: 6, end: 27 })
  // Second line is its own sentence; the newline is never crossed.
  assert.deepEqual(M.sentenceAt(text, 32), { start: 28, end: 37 })
})

test('resolveRange prefers the selection, falls back to the sentence', () => {
  const text = 'Rain. Coffee, then standup.'
  const sel = M.resolveRange(text, 7, 12)
  assert.equal(sel.kind, 'selection')
  assert.equal(sel.text, 'Coffee')
  const caret = M.resolveRange(text, 10, 10)
  assert.equal(caret.kind, 'sentence')
  assert.equal(caret.text, 'Coffee, then standup.')
  assert.equal(M.resolveRange('   \n  ', 2, 2), null)
})

test('resolveRange strips edge space and truncates long spans', () => {
  const text = '  padded span here  '
  const r = M.resolveRange(text, 0, text.length)
  assert.equal(r.text, 'padded span here')
  const long = 'word '.repeat(200)
  const t = M.resolveRange(long, 0, long.length)
  assert.equal(t.truncated, true)
  assert.ok(t.text.length <= 600)
})
