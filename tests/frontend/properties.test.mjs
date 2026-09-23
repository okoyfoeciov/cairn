// Owner: 03.  `node --test tests/frontend/*.test.mjs`.
// Spec: CONTRACT.md §5.4.5 (the Properties block), §5.4.4 (the live preview it
// sits inside), §9 E4 (no inert decoration).
//
// ===========================================================================
// WHAT IS BEING GUARDED, AND WHY EACH CASE EXISTS
// ===========================================================================
// The parser in `src/properties.ts` is deliberately small and its contract is
// "understand it completely or return null", where null means the frontmatter
// is left on screen as source.  That contract only holds if the BAIL cases are
// tested as carefully as the accept cases: a parser that quietly guesses at a
// block scalar renders a Properties block that disagrees with the file, and the
// file is the thing being edited.  So every construct named in that file's
// header as out of the subset has a case here asserting `null`.
//
// The type table is Obsidian's own (app.js:33085 + :33112) and is asserted
// value by value, because an icon that is merely plausible is exactly the kind
// of thing §0.17 was written to stop.
//
// Same bundling trick as livepreview.test.mjs: the subject is TypeScript, so it
// is built with the esbuild the app ships with and imported as ESM.  Nothing is
// mocked — the real `@codemirror/state` rope and the real `Decoration` objects
// are what the assertions run against.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '..', '..')

/** @type {any} */ let P
/** @type {any} */ let LP
/** @type {any} */ let CM

before(async () => {
  const esbuild = await import(pathToFileURL(join(ROOT, 'node_modules', 'esbuild', 'lib', 'main.js')).href)
  const dir = mkdtempSync(join(tmpdir(), 'cairn-props-'))
  process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })
  const out = join(dir, 'bundle.mjs')
  await esbuild.build({
    stdin: {
      contents:
        "export * as P from " + JSON.stringify(join(ROOT, 'src', 'properties.ts')) + "\n" +
        "export * as LP from " + JSON.stringify(join(ROOT, 'src', 'livepreview.ts')) + "\n" +
        "export { EditorState, Text } from '@codemirror/state'\n",
      resolveDir: ROOT,
      sourcefile: 'properties-test-entry.ts',
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
  P = mod.P
  LP = mod.LP
  CM = mod
})

const doc = (s) => CM.Text.of(s.split('\n'))

/* =========================================================================
 * 1.  `frontmatterEnd` — Obsidian's `tP`, and it is stricter than it looks.
 * ======================================================================= */

test('frontmatterEnd: line 1 must be EXACTLY `---`, and so must the closer', () => {
  assert.equal(LP.frontmatterEnd(doc('---\na: 1\n---\nbody')), 12)
  assert.equal(LP.frontmatterEnd(doc('---\n---\nbody')), 7, 'an empty block still counts')
  // Each of these is a real note somebody has written, and none of them is
  // frontmatter to Obsidian.
  assert.equal(LP.frontmatterEnd(doc('--- \na: 1\n---')), -1, 'a trailing space on the opener')
  assert.equal(LP.frontmatterEnd(doc('----\na: 1\n----')), -1, 'four dashes is a thematic break')
  assert.equal(LP.frontmatterEnd(doc(' ---\na: 1\n---')), -1, 'an indented opener')
  assert.equal(LP.frontmatterEnd(doc('---\na: 1')), -1, 'no closer at all')
  assert.equal(LP.frontmatterEnd(doc('body\n---\na: 1\n---')), -1, 'not on line 1')
  assert.equal(LP.frontmatterEnd(doc('---')), -1, 'a lone `---` is a thematic break')
})

/* =========================================================================
 * 2.  The parser's ACCEPT set.
 * ======================================================================= */

const parse = (s) => P.parseFrontmatter(s)

test('parse: scalars resolve on YAML 1.2\'s core schema', () => {
  assert.deepEqual(parse('a: hello'), [{ key: 'a', value: 'hello' }])
  assert.deepEqual(parse('a: 42'), [{ key: 'a', value: 42 }])
  assert.deepEqual(parse('a: -1.5e3'), [{ key: 'a', value: -1500 }])
  assert.deepEqual(parse('a: true'), [{ key: 'a', value: true }])
  assert.deepEqual(parse('a: false'), [{ key: 'a', value: false }])
  assert.deepEqual(parse('a: null'), [{ key: 'a', value: null }])
  assert.deepEqual(parse('a: ~'), [{ key: 'a', value: null }])
  assert.deepEqual(parse('a:'), [{ key: 'a', value: null }], 'a key with no value at all')
})

/* The reference note's `description` is a double-quoted scalar containing `#`,
 * `(`, `—` and a colon.  Every one of those breaks a naive splitter, and the
 * `#` is the dangerous one: outside quotes it opens a YAML comment. */
test('parse: a quoted scalar keeps its punctuation and loses its quotes', () => {
  assert.deepEqual(parse('a: "Bug class (PR #2283) — the constant: X"'),
    [{ key: 'a', value: 'Bug class (PR #2283) — the constant: X' }])
  assert.deepEqual(parse("a: 'it''s here'"), [{ key: 'a', value: "it's here" }])
  assert.deepEqual(parse('a: "not \\"json\\" safe"'), [{ key: 'a', value: 'not "json" safe' }])
})

test('parse: block and flow sequences of scalars', () => {
  assert.deepEqual(parse('tags:\n  - a\n  - b'), [{ key: 'tags', value: ['a', 'b'] }])
  assert.deepEqual(parse('tags: [a, b]'), [{ key: 'tags', value: ['a', 'b'] }])
  assert.deepEqual(parse('tags: []'), [{ key: 'tags', value: [] }])
})

/* The case the reference note actually has, and the one Obsidian renders as an
 * orange JSON string because its own type manager has no name for it. */
test('parse: a one-level nested map becomes an object', () => {
  assert.deepEqual(parse('m:\n  a: 1\n  b: two'),
    [{ key: 'm', value: { a: 1, b: 'two' } }])
})

test('parse: order is the file\'s, and blank lines and comments are skipped', () => {
  assert.deepEqual(parse('z: 1\n\n# a comment\na: 2').map((e) => e.key), ['z', 'a'])
})

/* =========================================================================
 * 3.  The parser's BAIL set — every one of these leaves the frontmatter on
 *     screen rather than rendering a Properties block that lies about it.
 * ======================================================================= */

for (const [why, src] of [
  ['a block scalar (|)', 'a: |\n  text'],
  ['a folded scalar (>)', 'a: >\n  text'],
  ['an anchor', 'a: &anchor 1'],
  ['an alias', 'a: *anchor'],
  ['an explicit tag', 'a: !!str 1'],
  ['a flow mapping', 'a: {b: 1}'],
  ['a tab anywhere', 'a:\n\t- x'],
  ['a two-level nested map', 'a:\n  b:\n    c: 1'],
  ['a sequence of maps', 'a:\n  - b: 1'],
  ['a nested flow collection', 'a: [[1], 2]'],
  ['a line that is not a key', 'a: 1\njust some prose'],
]) {
  test(`parse: BAILS on ${why}`, () => {
    assert.equal(parse(src), null, JSON.stringify(src))
  })
}

/* =========================================================================
 * 4.  The type table — app.js:33085 and :33112, value by value.
 * ======================================================================= */

/* KNOWN-ISSUES PR-5, and it was WRONG BYTES rather than an oddity: the panel
 * drew a row per occurrence, and `keyLine` addresses only the FIRST — so
 * editing the second `name` row's value rewrote the first `name` line. The user
 * edits the row they are looking at and a different line of the file changes.
 *
 * The rule is Obsidian's, asked of the live 1.13.7 with `tools/obsidian-live.mjs`
 * rather than inferred from its bundle ("duplicated mapping key" is not in
 * `app.js`, so the js-yaml assumption was not safe):
 *
 *   name: one / name: two   ->  rows 0, is-invalid TRUE
 *   Name: one / name: two   ->  rows 2, is-invalid FALSE
 *   meta: {a: 1, a: 2}      ->  rows 0, is-invalid TRUE
 *   no duplicates (control) ->  rows 2, is-invalid FALSE
 */
test('parse: a DUPLICATE key bails — exactly, case-sensitively, at every level', () => {
  assert.equal(parse('name: one\nname: two\n'), null)
  assert.equal(parse('a: 1\nb: 2\na: 3\n'), null, 'not only adjacent')
  // Case-SENSITIVE: `Name` and `name` are two different YAML keys, and Obsidian
  // renders both. This is the one place PR-1's case-FOLDING guard must not be
  // copied — that one indexes the rendered rows, this one is the file's grammar.
  assert.deepEqual(parse('Name: one\nname: two\n'),
    [{ key: 'Name', value: 'one' }, { key: 'name', value: 'two' }])
  // One level down, where a `Record` would have silently kept the LAST value.
  assert.equal(parse('meta:\n  a: 1\n  a: 2\n'), null)
  // And the control, so the guard cannot be a blanket refusal.
  assert.deepEqual(parse('a: 1\nb: 2\n'),
    [{ key: 'a', value: 1 }, { key: 'b', value: 2 }])
  assert.deepEqual(parse('meta:\n  a: 1\n  b: 2\n'),
    [{ key: 'meta', value: { a: 1, b: 2 } }])
  // A duplicate key in a nested map does not poison a DIFFERENT map's keys.
  assert.deepEqual(parse('one:\n  a: 1\ntwo:\n  a: 2\n'),
    [{ key: 'one', value: { a: 1 } }, { key: 'two', value: { a: 2 } }])
})

test('inferType: app.js:33085, transcribed', () => {
  assert.equal(P.inferType('x', 'plain'), 'text')
  assert.equal(P.inferType('x', '2026-09-09'), 'date')
  assert.equal(P.inferType('x', '2026-09-09T08:15'), 'datetime')
  assert.equal(P.inferType('x', 1), 'number')
  assert.equal(P.inferType('x', true), 'checkbox')
  assert.equal(P.inferType('x', ['a', 'b']), 'multitext')
  assert.equal(P.inferType('x', { a: 1 }), 'unknown')
  assert.equal(P.inferType('x', [1, 2]), 'unknown', 'an array of NON-strings is not multitext')
})

/* app.js:33081's `PL` — three keys have a type whatever their value is.  Cairn
 * has no vault-wide type manager, so this table is the whole of the
 * key-dependent half and it is worth pinning. */
/* THE ONE DEPARTURE FROM app.js:33085, and it is deliberate — see the comment
 * on `inferType`.  Obsidian sends `null` to `unknown` there, but never reaches
 * that branch for a real empty property because its `metadataTypeManager`
 * remembers a type per key across the vault and `addProperty` creates one as
 * text.  Cairn has no such cache, so a literal transcription would render every
 * `key:` with no value as an orange `null` — and, worse, as UNEDITABLE, since
 * only a scalar gets an editor.  A property you had just added could then never
 * be filled in. */
test('inferType: an EMPTY property is a text property, not an unknown one', () => {
  assert.equal(P.inferType('x', null), 'text')
})

test('inferType: aliases, tags and cssclasses are typed by their KEY', () => {
  assert.equal(P.inferType('aliases', ['a']), 'aliases')
  assert.equal(P.inferType('tags', ['a']), 'tags')
  assert.equal(P.inferType('cssclasses', ['a']), 'multitext')
  assert.equal(P.inferType('Tags', ['a']), 'tags', 'the key match is case-insensitive')
})

/* =========================================================================
 * 5.  The decoration — Obsidian's `JA` / `ZA` split.
 * ======================================================================= */

function decosOf(text) {
  const state = CM.EditorState.create({ doc: text, extensions: [P.frontmatterField] })
  const set = state.field(P.frontmatterField)
  const out = []
  set.between(0, state.doc.length, (from, to, v) => {
    out.push({
      from, to,
      block: v.spec.block === true,
      widget: v.spec.widget ? v.spec.widget.constructor.name : null,
      cls: v.spec.class ?? null,
    })
  })
  return out
}

test('decoration: valid frontmatter is REPLACED, block-wise, by the widget', () => {
  const d = decosOf('---\na: 1\n---\nbody')
  assert.equal(d.length, 1)
  assert.deepEqual({ from: d[0].from, to: d[0].to }, { from: 0, to: 12 })
  assert.equal(d[0].block, true, 'block: true is what removes the LINES, not just the text')
  assert.equal(d[0].widget, 'PropertiesWidget')
})

/* Obsidian's `hide = false` on a parse error, and the reason it matters: a note
 * whose frontmatter you cannot see is worse than one that shows it broken. */
test('decoration: UNPARSEABLE frontmatter is marked, never hidden', () => {
  const d = decosOf('---\na: |\n  x\n---\nbody')
  assert.equal(d.length, 1)
  assert.equal(d[0].block, false)
  assert.equal(d[0].widget, null)
  assert.equal(d[0].cls, 'nc-fm-invalid')
})

test('decoration: a note without frontmatter gets none', () => {
  assert.deepEqual(decosOf('# Heading\n\nbody'), [])
  assert.deepEqual(decosOf('---\nno closer'), [])
})

/* =========================================================================
 * 6.  The scanner must not see inside it.  This is the defect the reference
 *     screenshot showed: `---` matched HR_RE and drew two thematic breaks
 *     across the top of every note with frontmatter.
 * ======================================================================= */

function constructs(text) {
  const state = CM.EditorState.create({ doc: text, extensions: [LP.blockIndex] })
  const out = []
  LP.markdownSource.constructsIn(state, 0, state.doc.length, (c) => {
    out.push({ kind: c.kind, from: c.from, to: c.to })
  })
  return out
}

test('scanner: nothing inside frontmatter is markdown', () => {
  const text = '---\ntitle: **not bold**\ntags:\n  - not a list\n---\n\n# Real heading'
  const found = constructs(text)
  assert.deepEqual(found.map((c) => c.kind), ['heading'],
    'the delimiters are not thematic breaks and the body is not scanned')
  assert.equal(found[0].from, text.indexOf('# Real'), 'and it is the heading AFTER the block')
})

test('scanner: with no frontmatter, `---` is still a thematic break', () => {
  assert.deepEqual(constructs('body\n\n---\n\nmore').map((c) => c.kind), ['hr'])
})

/* =========================================================================
 * 7.  THE FOLD ARROW'S CSS.
 *
 *     `live-preview.test.mjs` measures this arrow in the real engine and
 *     covers everything JS can reach: opacity at rest, colour and rotation
 *     when collapsed, and the two glyph sizes.  The ONE thing it cannot reach
 *     is `:hover` — a pseudo-class needs a real pointer, and a probe that
 *     dispatches `mouseover` does not set it.  So the rule that makes the
 *     arrow appear under the mouse is asserted as a DECLARATION here, which is
 *     the same standard `editor.test.mjs` uses for the rename input's
 *     `letter-spacing` and for the same reason.
 *
 *     It is worth a test rather than a comment because the arrow being hidden
 *     at rest is only correct if something brings it back.
 * ======================================================================= */

test('§5.4.5: hovering the heading is what reveals the arrow', () => {
  const css = readFileSync(resolve(ROOT, 'src', 'styles', 'editor.css'), 'utf8')
  assert.match(css, /\.metadata-properties-heading \.collapse-indicator \{\s*opacity: 0;/,
    'app.css:7238 — hidden at rest')
  assert.match(css, /\.metadata-properties-heading:hover \.collapse-indicator,/,
    'app.css:7260 — and back on hover, or it can never be found')
  assert.match(css, /\.metadata-container\.is-collapsed \.collapse-indicator \{\s*opacity: 1;/,
    'app.css:7253 — and while collapsed, whether hovered or not')
})
