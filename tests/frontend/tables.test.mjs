// Owner: 03.  `node --test tests/frontend/tables.test.mjs`.
// Ruling: CONTRACT §0.40 E87 — a markdown table renders as a table.
//
// ===========================================================================
// WHAT IS TESTED HERE AND WHAT IS TESTED IN THE ENGINE
// ===========================================================================
// The MODEL is pure — `TableIndex.scanAll(Text)` in, `Table[]` out — so every
// rule Obsidian's mode has can be pinned here with no DOM and no view: which
// lines open a table, which close one, what the delimiter row may contain, and
// the incremental rescan that keeps a `StateField` off a full-document pass.
//
// The WIDGET is in `electron-shell/live-preview.test.mjs`, because a `<table>`
// reaching the document is the half a unit test cannot see (§0.24 E49's shape:
// a block decoration CM6 refuses fails at render time, not at build time).
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '..', '..')

/** @type {any} */ let T
/** @type {any} */ let CM

before(async () => {
  const esbuild = await import(pathToFileURL(join(ROOT, 'node_modules', 'esbuild', 'lib', 'main.js')).href)
  const dir = mkdtempSync(join(tmpdir(), 'cairn-tbl-'))
  process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })
  const out = join(dir, 'bundle.mjs')
  await esbuild.build({
    stdin: {
      contents:
        'export * from ' + JSON.stringify(join(ROOT, 'src', 'tables.ts')) + '\n' +
        "export { EditorState, EditorSelection, Text } from '@codemirror/state'\n",
      resolveDir: ROOT,
      sourcefile: 'tables-test-entry.ts',
      loader: 'ts',
    },
    outfile: out, bundle: true, format: 'esm', platform: 'neutral',
    mainFields: ['module', 'main'], conditions: ['import', 'default'],
    target: 'es2021', absWorkingDir: ROOT, logLevel: 'silent',
  })
  T = await import(pathToFileURL(out).href)
  CM = T
})

const doc = (...lines) => CM.Text.of(lines)
const tablesIn = (...lines) =>
  T.TableIndex.scanAll(doc(...lines)).tables.map((t) => ({
    from: t.from, to: t.to, align: t.align, rows: t.rows.map((r) => r.slice()),
  }))

/* ── opening ─────────────────────────────────────────────────────────────── */

test('§0.40 E87: a header, a delimiter and its rows', () => {
  const got = tablesIn('| A | B |', '|---|---|', '| 1 | 2 |', '| 3 | 4 |')
  assert.equal(got.length, 1)
  assert.deepEqual(got[0].rows, [['A', 'B'], ['1', '2'], ['3', '4']],
    'the DELIMITER row is consumed and never carried as a row')
  assert.deepEqual(got[0].align, ['default', 'default'])
  assert.equal(got[0].from, 0)
  assert.equal(got[0].to, 9 + 1 + 9 + 1 + 9 + 1 + 9, 'the range ends at the LAST row')
})

test('§0.40 E87: the four delimiter cells, in Obsidian`s own four patterns', () => {
  const got = tablesIn('| a | b | c | d |', '| --- | :-- | :-: | --: |', '| 1 | 2 | 3 | 4 |')
  assert.deepEqual(got[0].align, ['default', 'left', 'center', 'right'])
})

/* THE RULE THAT IS OBSIDIAN'S AND NOT GFM'S, and the one a transcription buys:
 *   if (!K && o.prevLine && o.prevLine.stream.string.trim() && !o.wasHeading)
 *     J = false
 * GFM starts a table straight after a paragraph line. Obsidian does not, and a
 * note written in Obsidian is written against that. */
test('§0.40 E87: a table needs a blank line, a heading, or the top of the note', () => {
  assert.equal(tablesIn('prose', '| A | B |', '|---|---|', '| 1 | 2 |').length, 0,
    'a table opened straight after a paragraph line')
  assert.equal(tablesIn('prose', '', '| A | B |', '|---|---|', '| 1 | 2 |').length, 1)
  assert.equal(tablesIn('## Heading', '| A | B |', '|---|---|', '| 1 | 2 |').length, 1)
  assert.equal(tablesIn('| A | B |', '|---|---|', '| 1 | 2 |').length, 1, 'first line of the note')
})

test('§0.40 E87: no delimiter row, no table', () => {
  assert.deepEqual(tablesIn('| A | B |', '| 1 | 2 |'), [])
  assert.deepEqual(tablesIn('| A | B |', '| x | y |', '| 1 | 2 |'), [],
    'a second row is not a delimiter row')
  assert.deepEqual(tablesIn('| A | B |'), [], 'a header with nothing under it')
})

/* AND THE COLUMN COUNTS ARE NOT CHECKED, which is Obsidian's behaviour and not
 * GFM's.  Its mode splits the delimiter row, tests each cell against the four
 * patterns, and never compares the count with the header's:
 *
 *     ee = te.split("|"); for (…) { if (vU.test(ie)) … else if (!yU.test(ie))
 *       { K = NONE; break } }
 *
 * GFM refuses the table outright.  This was asserted the GFM way in the first
 * draft and the transcription disagreed; the transcription is what ships. */
test('§0.40 E87: a delimiter row with the WRONG number of cells still opens one', () => {
  const got = tablesIn('| A | B |', '|---|', '| 1 | 2 |')
  assert.equal(got.length, 1)
  assert.deepEqual(got[0].align, ['default'], 'one alignment for two columns')
  assert.deepEqual(got[0].rows, [['A', 'B'], ['1', '2']], 'and both cells are kept')
})

test('§0.40 E87: one bad delimiter cell refuses the whole table', () => {
  assert.deepEqual(tablesIn('| A | B |', '|---|:-x-:|', '| 1 | 2 |'), [])
})

/* SIMPLE form: `hU = /^\s*[^\|].*?\|.*[^|]\s*$/` — no leading pipe, no trailing
 * one. Obsidian supports both; so does this. */
test('§0.40 E87: the SIMPLE form, with no outer pipes', () => {
  const got = tablesIn('A | B', '--- | ---', '1 | 2')
  assert.equal(got.length, 1)
  assert.deepEqual(got[0].rows, [['A', 'B'], ['1', '2']])
})

test('§0.40 E87: the two forms do not mix', () => {
  assert.deepEqual(tablesIn('| A | B |', '--- | ---', '| 1 | 2 |'), [],
    'a NORMAL header with a SIMPLE delimiter is not a table')
})

/* ── closing ─────────────────────────────────────────────────────────────── */

test('§0.40 E87: the first line that is not a row ends it', () => {
  const got = tablesIn('| A | B |', '|---|---|', '| 1 | 2 |', '', 'after')
  assert.equal(got.length, 1)
  assert.deepEqual(got[0].rows, [['A', 'B'], ['1', '2']])
  assert.equal(got[0].to, 9 + 1 + 9 + 1 + 9, 'the blank line is outside the range')
})

test('§0.40 E87: two tables in one document, and the second still needs its blank', () => {
  const got = tablesIn('| A |', '|---|', '| 1 |', '', '| B |', '|---|', '| 2 |')
  assert.equal(got.length, 2)
  assert.deepEqual(got[0].rows, [['A'], ['1']])
  assert.deepEqual(got[1].rows, [['B'], ['2']])
})

/* ── the incremental index ───────────────────────────────────────────────── */

/* A `StateField` cannot see the viewport, so the cost has to come out of the
 * CHANGE — `blockIndex`'s shape.  The property under test is that it agrees
 * with a full rescan, which is the only thing that makes the optimisation safe.
 * A table cannot cross a blank line, which is why rescanning to the nearest
 * blank on each side is exact rather than approximate. */
function afterEdit(lines, at, insert) {
  const state = CM.EditorState.create({ doc: lines.join('\n'), extensions: [T.tableIndex] })
  const next = state.update({ changes: { from: at, to: at, insert } }).state
  return {
    incremental: next.field(T.tableIndex).tables,
    full: T.TableIndex.scanAll(next.doc).tables,
  }
}

test('§0.40 E87: an edit inside a table leaves the index equal to a full rescan', () => {
  const lines = ['intro', '', '| A | B |', '|---|---|', '| 1 | 2 |', '', 'tail']
  const at = lines.slice(0, 4).join('\n').length + 3   // inside the body row
  const { incremental, full } = afterEdit(lines, at, 'XY')
  assert.deepEqual(incremental, full)
  assert.equal(incremental.length, 1)
  assert.ok((incremental[0].rows[1][0]).includes('XY'))
})

test('§0.40 E87: an edit that DESTROYS a table is seen', () => {
  const lines = ['| A | B |', '|---|---|', '| 1 | 2 |']
  const { incremental, full } = afterEdit(lines, 10, 'x')   // break the delimiter row
  assert.deepEqual(incremental, full)
  assert.equal(incremental.length, 0)
})

test('§0.40 E87: an edit far away leaves the table alone, mapped, not rescanned', () => {
  const lines = ['head', '', '| A | B |', '|---|---|', '| 1 | 2 |']
  const { incremental, full } = afterEdit(lines, 0, 'more ')
  assert.deepEqual(incremental, full)
  assert.equal(incremental.length, 1)
  assert.equal(incremental[0].from, 'more head'.length + 2, 'the range moved with the edit')
})

/* ── the reveal ──────────────────────────────────────────────────────────── */

/** `focused` is pushed in by CM6's `focusChangeEffect` in the real editor; with
 *  no view there is no focus, so the test pushes the same effect. */
function decoCount(lines, anchor, focused = true) {
  const base = CM.EditorState.create({ doc: lines.join('\n'), extensions: [T.tables] })
  const withFocus = base.update({ effects: T.setTableFocus.of(focused) }).state
  const state = anchor === null ? withFocus : withFocus.update({ selection: { anchor } }).state
  let n = 0
  state.field(T.tableDecorations).between(0, state.doc.length, () => { n++ })
  return n
}

/* §0.23 E48 AT BLOCK SCALE, and the reveal test is what found it: an UNFOCUSED
 * editor reveals nothing.  `buildDecorations` reads `view.hasFocus` directly;
 * a StateField cannot, so the view pushes it in.  Without it the caret sits at
 * position 0 in a freshly opened note and a table on its FIRST line shows
 * markdown the moment the note appears. */
test('§0.40 E87: an UNFOCUSED editor renders every table, caret or not', () => {
  const lines = ['| A |', '|---|', '| 1 |']
  assert.equal(decoCount(lines, 3, false), 1, 'unfocused: the caret does not reveal')
  assert.equal(decoCount(lines, 3, true), 0, 'focused: it does')
})

/* §5.4.1's rule at block scale: the construct the selection is in shows its
 * source. It is the same reveal a `**bold**` gets, and it is what makes a
 * read-only widget editable — you edit the markdown, which is what you do
 * today. */
test('§0.40 E87: the table the caret is in shows its markdown, the others do not', () => {
  const lines = ['| A |', '|---|', '| 1 |', '', 'prose', '', '| B |', '|---|', '| 2 |']
  assert.equal(decoCount(lines, null, false), 2, 'unfocused: both are widgets')
  assert.equal(decoCount(lines, 3), 1, 'the caret is in the first table')
  assert.equal(decoCount(lines, lines.join('\n').length - 2), 1, 'the caret is in the second')
  assert.equal(decoCount(lines, 20), 2, 'the caret is in the prose between them')
})
