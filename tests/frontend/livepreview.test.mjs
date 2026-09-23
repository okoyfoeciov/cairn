// Owner: 03.  `node --test tests/frontend/`.
// Spec: spec-03 §13.1 (the block-index table and the incremental-equivalence
// property test), §5.2 (the marker reveal), CONTRACT.md §5.3 (`nc-cb*` on every
// line of the block, fences included), §5.4.1 (hide by default, reveal on the
// caret line), §6.4 (this file's row in the table).
//
// ===========================================================================
// WHY THIS FILE COMPILES ITS SUBJECT
// ===========================================================================
// `src/livepreview.ts` is TypeScript and `node --test` has no loader for it, so
// this file bundles it with the SAME esbuild the app ships with (CONTRACT §6.3
// pins esbuild 0.28.2) into an ESM module under os.tmpdir() and imports that.
// Nothing is mocked: the real `@codemirror/state` rope, the real `StateField`
// and the real `Decoration` objects are what the assertions run against.  Only
// `EditorView` needs a DOM, and no test here constructs one — that is exactly
// why `buildDecorations(state, ranges)` takes the ranges instead of the view.
// ===========================================================================

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '..', '..')

/** @type {any} */ let LP
/** @type {any} */ let CM

before(async () => {
  const esbuild = await import(pathToFileURL(join(ROOT, 'node_modules', 'esbuild', 'lib', 'main.js')).href)
  const dir = mkdtempSync(join(tmpdir(), 'cairn-lp-'))
  // Same guard tree.test.mjs and search.test.mjs use: registered on the
  // dir the moment it exists, BEFORE the bundle step, so a throw out of
  // esbuild or a failing assertion still takes the fixture with it.
  process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })
  const out = join(dir, 'bundle.mjs')
  await esbuild.build({
    // stdin with `resolveDir: ROOT`, not a temp entry file: bare specifiers
    // like '@codemirror/state' must resolve against the REPO's node_modules,
    // and a file under os.tmpdir() has no node_modules above it.
    stdin: {
      contents:
        "export * from " + JSON.stringify(join(ROOT, 'src', 'livepreview.ts')) + "\n" +
        "export { EditorState, EditorSelection, Text } from '@codemirror/state'\n",
      resolveDir: ROOT,
      sourcefile: 'livepreview-test-entry.ts',
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
  LP = await import(pathToFileURL(out).href)
  CM = LP
})

/** A state carrying the block-index field, from a plain string. */
function st(doc) {
  return CM.EditorState.create({ doc, extensions: [LP.blockIndex] })
}
function idxOf(state) {
  return state.field(LP.blockIndex)
}
function blocksOf(doc) {
  return idxOf(st(doc)).blocks.map((b) => ({ from: b.from, to: b.to }))
}

/* =========================================================================
 * 1.  spec-03 §13.1's table, verbatim.  Input markdown -> expected Block[].
 * ======================================================================= */

const TABLE = [
  ['```\na\n```', [{ from: 0, to: 9 }], 'plain backtick fence'],
  ['~~~\na\n~~~', [{ from: 0, to: 9 }], 'tilde fence'],
  ['```js\na\n```', [{ from: 0, to: 11 }], 'an info string does not prevent opening'],
  ['```a`b\nx', [], 'a backtick inside a backtick info string is not a fence at all'],
  ['````\n```\n````', [{ from: 0, to: 13 }], 'a 3-backtick line cannot close a 4-backtick fence'],
  ['```\na', [{ from: 0, to: 5 }], 'an unclosed fence runs to the end of the document'],
  ['   ```\na\n   ```', [{ from: 0, to: 15 }], 'up to 3 leading spaces is still a fence'],
  ['    ```\na', [], '4 leading spaces is not a fence'],
  [
    '```\nx\n```\ntext\n```\ny\n```',
    [
      { from: 0, to: 9 },
      { from: 15, to: 24 },
    ],
    'two blocks',
  ],
]

for (const [doc, want, why] of TABLE) {
  test(`blocks: ${why}`, () => {
    assert.deepEqual(blocksOf(doc), want, JSON.stringify(doc))
  })
}

test('blocks: a heading inside a fence is code, never a heading (§5.3)', () => {
  const doc = '```\n# not a heading\n```'
  const state = st(doc)
  const built = LP.buildDecorations(state, [{ from: 0, to: state.doc.length }])
  const classes = []
  built.decorations.between(0, state.doc.length, (from, to, v) => {
    classes.push([from, to, v.spec.class ?? null])
  })
  // every one of the three lines is nc-cb, and no nc-hN appears anywhere
  assert.equal(classes.length, 3)
  assert.equal(classes[0][2], 'nc-cb nc-cb-first')
  assert.equal(classes[1][2], 'nc-cb')
  assert.equal(classes[2][2], 'nc-cb nc-cb-last')
  assert.ok(!classes.some((c) => /nc-h[1-6]/.test(c[2] ?? '')))
})

test('blocks: a one-line block is nc-cb-only', () => {
  // an unclosed fence on the last line of the document
  const doc = 'body\n```'
  const state = st(doc)
  const built = LP.buildDecorations(state, [{ from: 0, to: state.doc.length }])
  const classes = []
  built.decorations.between(0, state.doc.length, (f, t, v) => classes.push(v.spec.class))
  assert.deepEqual(classes, ['nc-cb nc-cb-only'])
})

test('blockAt: binary search agrees with a linear scan', () => {
  const doc = '```\nx\n```\ntext\n```\ny\n```\ntail'
  const state = st(doc)
  const idx = idxOf(state)
  for (let p = 0; p <= state.doc.length; p++) {
    const linear = idx.blocks.find((b) => p >= b.from && p <= b.to) ?? null
    assert.deepEqual(idx.blockAt(p), linear, `pos ${p}`)
  }
})

/* =========================================================================
 * 2.  §5.4.1 — hide by default, reveal on the line the primary selection
 *     intersects.  Ranges, not just the head.
 * ======================================================================= */

function markerAt(doc, sel) {
  const base = st(doc)
  const state = base.update({ selection: sel }).state
  const built = LP.buildDecorations(state, [{ from: 0, to: state.doc.length }])
  const found = []
  built.decorations.between(0, state.doc.length, (from, to, v) => {
    if (from !== to) found.push({ from, to, v })
  })
  const atoms = []
  built.atoms.between(0, state.doc.length, (from, to) => atoms.push({ from, to }))
  return { found, atoms, built, state }
}

test('marker: hidden when the selection does not touch the heading line', () => {
  const { found, atoms } = markerAt('body\n## Heading\nmore', { anchor: 0 })
  assert.equal(found.length, 1)
  assert.equal(found[0].v, LP.HIDE_MARK)
  assert.deepEqual({ from: found[0].from, to: found[0].to }, { from: 5, to: 8 }) // '## ' = 3 chars
  // hidden runs, and ONLY hidden runs, are what the caret steps over
  assert.deepEqual(atoms, [{ from: 5, to: 8 }])
})

test('marker: revealed by an empty selection on the line', () => {
  const { found, atoms } = markerAt('body\n## Heading\nmore', { anchor: 9 })
  assert.equal(found.length, 1)
  assert.equal(found[0].v, LP.SHOW_MARK)
  // a REVEALED marker must not be atomic, or the caret could not edit it
  assert.deepEqual(atoms, [])
})

test('marker: revealed by a RANGE that merely overlaps the line', () => {
  // a selection running from the body line into the line after the heading
  const { found } = markerAt('body\n## Heading\nmore', { anchor: 2, head: 17 })
  assert.equal(found[0].v, LP.SHOW_MARK)
})

test('marker: the replace covers the hashes AND the single following space', () => {
  const { found } = markerAt('body\n###### Deep\nmore', { anchor: 0 })
  assert.deepEqual({ from: found[0].from, to: found[0].to }, { from: 5, to: 12 })
})

test('marker: a tab after the hashes is the marker run too', () => {
  const { found } = markerAt('body\n#\tTabbed\nmore', { anchor: 0 })
  assert.deepEqual({ from: found[0].from, to: found[0].to }, { from: 5, to: 7 })
})

test('marker: moving the caret changes ONLY the marker — no line-class churn', () => {
  const doc = 'body\n## Heading\nmore'
  const off = markerAt(doc, { anchor: 0 })
  const on = markerAt(doc, { anchor: 9 })
  const lineClasses = (r) => {
    const out = []
    r.built.decorations.between(0, r.state.doc.length, (from, to, v) => {
      if (from === to) out.push([from, v])
    })
    return out
  }
  const a = lineClasses(off)
  const b = lineClasses(on)
  assert.equal(a.length, b.length)
  for (let i = 0; i < a.length; i++) {
    assert.equal(a[i][0], b[i][0])
    // IDENTITY, not equality: CM6 diffs decoration sets by value identity, so a
    // fresh Decoration.line per rebuild would force DOM churn per cursor move.
    assert.equal(a[i][1], b[i][1])
  }
})

test('heading: `#Title` with no space is not a heading (CommonMark)', () => {
  const state = st('#Title')
  const built = LP.buildDecorations(state, [{ from: 0, to: state.doc.length }])
  let n = 0
  built.decorations.between(0, state.doc.length, () => { n++ })
  assert.equal(n, 0)
})

test('heading: an indented `# ` is not a heading (column 0 only, §11.3)', () => {
  const state = st(' # Title')
  const built = LP.buildDecorations(state, [{ from: 0, to: state.doc.length }])
  let n = 0
  built.decorations.between(0, state.doc.length, () => { n++ })
  assert.equal(n, 0)
})

test('heading: seven hashes is not a heading', () => {
  const state = st('####### Title')
  const built = LP.buildDecorations(state, [{ from: 0, to: state.doc.length }])
  let n = 0
  built.decorations.between(0, state.doc.length, () => { n++ })
  assert.equal(n, 0)
})

/* =========================================================================
 * 2b. §0.31 E75 — the list prefix, which is what the hanging indent measures.
 * ======================================================================= */

test('§0.35 E81 / §0.51 E99 — listIndentAt separates a CONTINUATION from a nested ITEM', () => {
  const D = (text) => CM.Text.of(text.split('\n'))
  const at = (text, n) => { const d = D(text); return LP.listIndentAt(d, d.line(n)) }

  // The reported shape: a bullet, then its own hard-wrapped continuations.
  const note = '- `~/notes/` — LOWERCASE. The dir is literally\n' +
               '  lowercase on the Linux box, and lowercase also resolves on\n' +
               '  macOS. The earlier `~/Notes` (capital) and\n' +
               'flush paragraph'
  assert.equal(at(note, 1), null, 'the bullet line itself has no leading indent')
  assert.deepEqual(at(note, 2), { n: 2, cont: true })
  assert.deepEqual(at(note, 3), { n: 2, cont: true }, 'a continuation of a continuation still counts')
  assert.equal(at(note, 4), null, 'a flush line is not indented at all')

  // §0.51 E99 — A NESTED ITEM IS NOT A CONTINUATION, and this is the whole
  // defect the user reported: every one of these answered `2`/`3` before, which
  // the builder then dressed as a continuation. It cost 16.000px of
  // `padding-inline-start` and 1.2px of `padding-top`, measured in both apps.
  assert.deepEqual(at('1. a\n   - nested under an ordered item', 2), { n: 3, cont: false })
  assert.deepEqual(at('- a\n  - nested under a bullet', 2), { n: 2, cont: false })
  assert.deepEqual(at('- a\n  * a different bullet char', 2), { n: 2, cont: false })
  assert.deepEqual(at('- a\n  2) an ordered child', 2), { n: 2, cont: false })
  assert.deepEqual(at('- a\n\t- a tab-indented child', 2), { n: 1, cont: false })
  // …AND A TASK BOX IS STILL AN ITEM. `LIST_OPENER_RE` stops at the marker, so
  // the `[ ] ` never has to be in it.
  assert.deepEqual(at('- a\n  - [ ] a nested task', 2), { n: 2, cont: false })

  // A LINE THAT ONLY LOOKS LIKE A MARKER IS NOT ONE. Obsidian's `bO` requires
  // the SPACE after the bullet, and without that `  -- em dash` opens a list.
  assert.deepEqual(at('- a\n  -- not a marker, no space', 2), { n: 2, cont: true })
  assert.deepEqual(at('- a\n  1.no space either', 2), { n: 2, cont: true })

  // A TAB counts as indent, and the length is in CHARACTERS — the px width is
  // the layout's business, which is why this returns a length and not a size.
  assert.deepEqual(at('- a\n\tdeeper', 2), { n: 1, cont: true })
  assert.deepEqual(at('- a\n    four spaces', 2), { n: 4, cont: true })

  // NOT A LIST: an indented line under ordinary prose is an indented paragraph,
  // and giving it a list's 1em would indent things that are not lists at all.
  assert.equal(at('just a paragraph\n  indented under it', 2), null)
  assert.equal(at('  indented, nothing above', 1), null)
  // …but an indented line that carries a MARKER is a list line wherever it is,
  // which is why the opener test comes before the walk-back.
  assert.deepEqual(at('just a paragraph\n  - a bullet under it', 2), { n: 2, cont: false })

  // A BLANK LINE ENDS THE ITEM. A recorded divergence, not an oversight:
  // Obsidian's stream-mode `listStack` survives one, so a loose list's second
  // paragraph gets the padding there and not here. The conservative direction
  // under-indents a rare shape rather than indenting a non-list.
  assert.equal(at('- a\n\n  loose second paragraph', 3), null)

  // An ORDERED item opens one too, and so does an already-indented marker.
  assert.deepEqual(at('1. a\n   continuation', 2), { n: 3, cont: true })
  assert.deepEqual(at('  - nested\n    continuation', 2), { n: 4, cont: true })

  // Whitespace with NO content is not an indent — an all-blank line has nothing
  // to push right, and marking it would be a zero-width span.
  assert.equal(at('- a\n   \nx', 2), null)
})

test('§0.51 E99 — indentGroups is Obsidian\'s `Bq` loop: whole units, then the leftover', () => {
  const G = (ws) => LP.indentGroups(ws).map((g) => [g.from, g.to, g.full])

  assert.deepEqual(G(''), [])
  // FEWER THAN FOUR SPACES IS ONE PARTIAL GROUP, NOT ONE PER SPACE. Obsidian's
  // `b = T` moves the cursor to the first non-space, so the whole short run is
  // a single `.cm-indent-spacing`. Three spaces is the shape the user reported.
  assert.deepEqual(G(' '), [[0, 1, false]])
  assert.deepEqual(G('  '), [[0, 2, false]])
  assert.deepEqual(G('   '), [[0, 3, false]])
  // FOUR IS A WHOLE UNIT, and a whole unit is `min-width: var(--list-indent)`
  // wide — 36px — rather than four spaces' advance.
  assert.deepEqual(G('    '), [[0, 4, true]])
  assert.deepEqual(G('     '), [[0, 4, true], [4, 5, false]])
  assert.deepEqual(G('      '), [[0, 4, true], [4, 6, false]])
  assert.deepEqual(G('        '), [[0, 4, true], [4, 8, true]])
  // A TAB IS A WHOLE UNIT WHATEVER ITS ADVANCE — the width comes from
  // `min-width`, so `tab-size` never enters the geometry of an indent.
  assert.deepEqual(G('\t'), [[0, 1, true]])
  assert.deepEqual(G('\t\t'), [[0, 1, true], [1, 2, true]])
  // A TAB THAT ENDS A PARTIAL RUN OF SPACES STAYS INSIDE THAT GROUP.
  //
  // Obsidian's `b++` DROPS that character — read out of the live 1.13.7's own
  // `.cm-hmd-list-indent`, where a guess could not have survived:
  //   " \t- x"        <span class="cm-indent-spacing"> </span>\t
  //   "  \t  cont"    <span class="cm-indent-spacing">  </span>\t<span class="cm-indent-spacing">  </span>
  // — the tab is a bare text node between the spans. It works there because it
  // is bare INSIDE the `inline-block` wrapper, which re-origins its tab stop at
  // the start of the indent run. Cairn emits no wrapper, so a bare tab would
  // take its stop from the LINE, whose origin the hanging indent has moved:
  // measured 46.05 against Obsidian's 59.05. Keeping it in the group puts the
  // stop back where Obsidian's wrapper puts it — re-measured at 59.05 exactly.
  assert.deepEqual(G(' \t'), [[0, 2, false]])
  assert.deepEqual(G('  \t  '), [[0, 3, false], [3, 5, false]])
  assert.deepEqual(G('       \t'), [[0, 4, true], [4, 8, false]])
  // …whereas a tab that STARTS a group is a whole unit and takes `min-width`.
  assert.deepEqual(G('\t  '), [[0, 1, true], [1, 3, false]])

  // THE GROUPS TILE THE RUN EXACTLY: ordered, disjoint, in bounds, and no
  // character left outside every group. Whitespace that renders outside every
  // span is whitespace at the wrong width, which is the defect above.
  for (const ws of ['', ' ', '  ', '   ', '    ', '     ', '\t', '\t\t', ' \t', '  \t  ', '\t  ', '       \t']) {
    const g = LP.indentGroups(ws)
    let at = 0
    for (const x of g) {
      assert.equal(x.from, at, `gap or overlap in ${JSON.stringify(ws)}`)
      assert.ok(x.to > x.from && x.to <= ws.length, `out of bounds in ${JSON.stringify(ws)}`)
      at = x.to
    }
    assert.equal(at, ws.length, `groups do not cover ${JSON.stringify(ws)}`)
  }
})

test('§0.51 E99 — a nested ITEM takes indent groups and NOT a continuation\'s classes', () => {
  const marks = (doc) => {
    const state = st(doc)
    const built = LP.buildDecorations(state, [{ from: 0, to: state.doc.length }])
    const out = []
    built.decorations.between(0, state.doc.length, (from, to, v) => {
      const cls = v.spec.class ?? null
      if (cls && /nc-indent|nc-li/.test(cls)) out.push([from, to, cls])
    })
    return out
  }

  // The reported note's shape. The nested line starts at 5 (`1. a\n`).
  const nested = marks('1. a\n   - b')
  assert.ok(nested.some(([f, t, c]) => f === 5 && t === 8 && c === 'nc-indent-sp'),
    `the indent run is not one spacing group: ${JSON.stringify(nested)}`)
  assert.ok(!nested.some(([, , c]) => /nc-indent-pad/.test(c)),
    'a nested ITEM took the continuation 1em')
  assert.ok(!nested.some(([, , c]) => /nc-li-cont/.test(c)),
    'a nested ITEM took `padding-top: 0`')
  // …and it IS still a list line, which is what gives it --list-spacing on both
  // sides. Losing that would fix the 16px and break the 1.2px.
  assert.ok(nested.some(([f, t, c]) => f === 5 && t === 5 && c === 'nc-li'))

  // A CONTINUATION still takes all three, unchanged from E81/E82.
  const cont = marks('- a\n  b')
  assert.ok(cont.some(([f, t, c]) => f === 4 && t === 6 && c === 'nc-indent-sp nc-indent-pad'),
    `the continuation lost its 1em: ${JSON.stringify(cont)}`)
  assert.ok(cont.some(([f, t, c]) => f === 4 && t === 4 && c === 'nc-li nc-li-cont'))

  // A FOUR-SPACE CONTINUATION TAKES NO 1em, because its last group is a whole
  // unit and Obsidian's selector is `.cm-indent-spacing:last-child`. Measured
  // in the live 1.13.7 at 36.000 with `padding-inline-start: 0px`.
  const four = marks('- a\n    b')
  assert.ok(four.some(([f, t, c]) => f === 4 && t === 8 && c === 'nc-indent'),
    `four spaces are not one whole group: ${JSON.stringify(four)}`)
  assert.ok(!four.some(([, , c]) => /nc-indent-pad/.test(c)))
  // …but the LINE is still a continuation: the 1em and the `padding-top: 0` are
  // two different rules and only one of them is conditioned on the group kind.
  assert.ok(four.some(([f, t, c]) => f === 4 && t === 4 && c === 'nc-li nc-li-cont'))

  // SIX SPACES: a whole unit, then a leftover that DOES take the 1em.
  const six = marks('- a\n      b')
  assert.ok(six.some(([f, t, c]) => f === 4 && t === 8 && c === 'nc-indent'))
  assert.ok(six.some(([f, t, c]) => f === 8 && t === 10 && c === 'nc-indent-sp nc-indent-pad'))
})

test('listPrefix: Obsidian\'s own regex, and the marker is OPTIONAL', () => {
  // `bO` in app.js, verbatim:
  //   /^([>\s]*)(([*+-] |(\d+)([.)] ))(?:\[(.)\] )?)?/
  // and `lj` returns the whole match only when it is non-empty.
  const P = LP.listPrefix
  assert.equal(P('- a bullet'), '- ')
  assert.equal(P('* a bullet'), '* ')
  assert.equal(P('+ a bullet'), '+ ')
  assert.equal(P('12. ordered'), '12. ')
  assert.equal(P('3) ordered'), '3) ')
  // A task box is part of the prefix, which is why a task hangs further than a
  // bare bullet — and why the offset cannot be one constant.
  assert.equal(P('- [ ] open'), '- [ ] ')
  assert.equal(P('- [x] done'), '- [x] ')
  // NESTING and QUOTES come from group 1, which is NOT optional. `> quoted`
  // therefore has a prefix and takes a hanging indent in Obsidian too — the
  // predicate is the prefix, never "is this a list".
  assert.equal(P('  - nested'), '  - ')
  assert.equal(P('> quoted'), '> ')
  assert.equal(P('> - quoted bullet'), '> - ')
  // …and a bare paragraph has none, which is what keeps this off body text.
  assert.equal(P('plain text'), null)
  assert.equal(P(''), null)
  // A marker with no trailing space is not a marker: `-x` is a word.
  assert.equal(P('-x not a bullet'), null)
  // Indentation ALONE is a prefix. It is what indents a wrapped continuation of
  // an already-indented line, and dropping it would be a divergence.
  assert.equal(P('   indented paragraph'), '   ')
})

test('heading: every level gets its own line class, AND the shared one', () => {
  // §0.30 E73 — `nc-h` beside `nc-hN`. It is Obsidian's `HyperMD-header`, which
  // its sheet carries beside `HyperMD-header-N` for the three rules that do not
  // care about the level (the 16px above a heading, and the carve-out for a
  // heading one blank line below another). Written as six level classes alone,
  // the carve-out is a 36-way selector.
  for (let lvl = 1; lvl <= 6; lvl++) {
    const state = st('#'.repeat(lvl) + ' T')
    const built = LP.buildDecorations(state, [{ from: 0, to: state.doc.length }])
    let cls = null
    built.decorations.between(0, state.doc.length, (f, t, v) => { if (f === t) cls = v.spec.class })
    assert.equal(cls, `nc-h nc-h${lvl}`)
  }
})

/* =========================================================================
 * 3.  The incremental-equivalence property test (spec-03 §13.1).
 *     "This is the test that catches the coordinate-mapping bugs in §5.1, and
 *      skipping it is the main correctness risk in this design."
 * ======================================================================= */

/** A deterministic PRNG, so a failure is reproducible from the seed alone. */
function rng(seed) {
  let s = seed >>> 0
  return () => {
    s ^= s << 13; s >>>= 0
    s ^= s >>> 17
    s ^= s << 5; s >>>= 0
    return s / 0x100000000
  }
}

const SNIPPETS = [
  '```', '~~~', '````', '```js', '```sh', '```a`b', '   ```', '    ```',
  '# H', '## H', 'body text', '', 'x', '~~~~', '```   ',
]

function randomDoc(rand, lines) {
  const out = []
  for (let i = 0; i < lines; i++) out.push(SNIPPETS[Math.floor(rand() * SNIPPETS.length)])
  return out.join('\n')
}

function normalise(idx) {
  return idx.blocks.map((b) => `${b.from}-${b.to}`).join(',')
}

test('applyChanges over 200 random edits == scanAll on the final document', () => {
  for (let seed = 1; seed <= 12; seed++) {
    const rand = rng(seed * 7919)
    let state = st(randomDoc(rand, 40))
    for (let step = 0; step < 200; step++) {
      const len = state.doc.length
      const from = Math.floor(rand() * (len + 1))
      const to = Math.min(len, from + Math.floor(rand() * 6))
      const insert = rand() < 0.55 ? SNIPPETS[Math.floor(rand() * SNIPPETS.length)] : ''
      const withNl = rand() < 0.4 ? insert + '\n' : insert
      state = state.update({ changes: { from, to, insert: withNl } }).state

      const incremental = normalise(state.field(LP.blockIndex))
      const fromScratch = normalise(LP.BlockIndex.scanAll(state.doc))
      assert.equal(
        incremental,
        fromScratch,
        `seed ${seed} step ${step}\n--- doc ---\n${JSON.stringify(state.doc.toString())}`
      )
    }
  }
})

test('applyChanges: a multi-range ChangeSet in one transaction', () => {
  let state = st('```\na\n```\nbody\n~~~\nb\n~~~')
  state = state.update({
    changes: [
      { from: 0, to: 3, insert: '````' },
      { from: 15, to: 15, insert: 'zz' },
    ],
  }).state
  assert.equal(
    normalise(state.field(LP.blockIndex)),
    normalise(LP.BlockIndex.scanAll(state.doc))
  )
})

test('applyChanges: a no-op transaction returns the same index object', () => {
  const state = st('```\na\n```')
  const before = state.field(LP.blockIndex)
  const after = state.update({ selection: { anchor: 1 } }).state.field(LP.blockIndex)
  assert.equal(before, after)
})

/* =========================================================================
 * 4.  The inline title (§5.4.2) — it is NEVER in the document.
 * ======================================================================= */

test('title: the widget is a decoration, never a document byte', () => {
  LP.setInitialTitle('Misc')
  const state = CM.EditorState.create({
    doc: 'body line\n## Heading\n',
    extensions: [LP.blockIndex, LP.titleField],
  })
  // The document is rendered UNCHANGED: sliceDoc and the clipboard never see it.
  assert.equal(state.doc.toString(), 'body line\n## Heading\n')
  const set = state.field(LP.titleField)
  const at = []
  set.between(0, state.doc.length, (from, to, v) => at.push({ from, to, block: v.block }))
  assert.deepEqual(at, [{ from: 0, to: 0, block: true }])
  LP.setInitialTitle(null)
})

test('title: a document that genuinely begins with an H1 renders BOTH', () => {
  LP.setInitialTitle('Misc')
  const state = CM.EditorState.create({
    doc: '# Misc\nbody\n',
    extensions: [LP.blockIndex, LP.titleField],
  })
  // the title widget …
  let widgets = 0
  state.field(LP.titleField).between(0, state.doc.length, () => { widgets++ })
  assert.equal(widgets, 1)
  // … AND an untouched H1 line in the document
  const built = LP.buildDecorations(state, [{ from: 0, to: state.doc.length }])
  let h1 = 0
  built.decorations.between(0, state.doc.length, (f, t, v) => { if (v.spec.class === 'nc-h nc-h1') h1++ })
  assert.equal(h1, 1)
  assert.equal(state.doc.line(1).text, '# Misc')
  LP.setInitialTitle(null)
})

test('title: setTitle(null) clears it (§7.4 empty state)', () => {
  LP.setInitialTitle('Misc')
  let state = CM.EditorState.create({ doc: 'x', extensions: [LP.titleField] })
  state = state.update({ effects: LP.setTitle.of(null) }).state
  let n = 0
  state.field(LP.titleField).between(0, state.doc.length, () => { n++ })
  assert.equal(n, 0)
  LP.setInitialTitle(null)
})

test('title: the widget survives a document change, still at position 0', () => {
  LP.setInitialTitle('Misc')
  let state = CM.EditorState.create({ doc: 'body', extensions: [LP.titleField] })
  state = state.update({ changes: { from: 0, insert: 'prefix ' } }).state
  const at = []
  state.field(LP.titleField).between(0, state.doc.length, (from) => at.push(from))
  assert.deepEqual(at, [0])
  LP.setInitialTitle(null)
})

/* =========================================================================
 * 5.  THE v2 CONSTRUCT SET (§5.4.4, 2026-09-09).
 *
 *     Every expectation below was taken from Obsidian 1.12.7's own
 *     `lib/codemirror/markdown.js` and its live-preview decorator (`app.js`,
 *     the `S6.buildDeco` class), not from a reading of CommonMark and not from
 *     what "looks right".  Where a case exists only because Obsidian's rule is
 *     surprising — `snake_case`, a bare `[text]`, a line that is only hashes —
 *     the comment says so, because those are the ones a well-meaning
 *     simplification would break first.
 * ======================================================================= */

/** Every construct the source emits for `doc`, as flat comparable strings. */
function constructs(doc) {
  const state = st(doc)
  const out = []
  LP.markdownSource.constructsIn(state, 0, state.doc.length, (c) => {
    out.push({
      kind: c.kind,
      from: c.from,
      to: c.to,
      detail: c.detail,
      markers: c.markers.map((m) => [m.role, m.from, m.to]),
    })
  })
  return out
}

/**
 * The decorations for `doc` with the selection at `anchor`.  `anchor: null`
 * means the UNFOCUSED editor — Obsidian's `view.hasFocus ? ranges : []` — which
 * is the state a note is in whenever the file tree has the focus.
 */
function decos(doc, anchor = null) {
  const base = st(doc)
  const state = anchor === null ? base : base.update({ selection: { anchor } }).state
  const built = LP.buildDecorations(
    state,
    [{ from: 0, to: state.doc.length }],
    undefined,
    anchor === null ? [] : state.selection.ranges
  )
  const out = []
  built.decorations.between(0, state.doc.length, (from, to, v) => {
    out.push({
      from, to,
      cls: v.spec.class ?? null,
      widget: v.spec.widget ? v.spec.widget.constructor.name : null,
      hidden: v === LP.HIDE_MARK,
    })
  })
  return out
}
const clsAt = (doc, anchor = null) =>
  decos(doc, anchor).map((d) => `${d.from}-${d.to}:${d.cls ?? (d.widget ? 'W' + d.widget : d.hidden ? 'HIDE' : '?')}`)

/* -- the inline tokeniser ------------------------------------------------ */

test('inline: one construct per delimiter pair, with both markers', () => {
  assert.deepEqual(constructs('**b** *i* ~~s~~ ==h== `c`'), [
    { kind: 'strong', from: 0, to: 5, detail: 0, markers: [['open', 0, 2], ['close', 3, 5]] },
    { kind: 'emphasis', from: 6, to: 9, detail: 0, markers: [['open', 6, 7], ['close', 8, 9]] },
    { kind: 'strikethrough', from: 10, to: 15, detail: 0, markers: [['open', 10, 12], ['close', 13, 15]] },
    { kind: 'highlight', from: 16, to: 21, detail: 0, markers: [['open', 16, 18], ['close', 19, 21]] },
    { kind: 'inlineCode', from: 22, to: 25, detail: 0, markers: [['open', 22, 23], ['close', 24, 25]] },
  ])
})

/* CM5's flanking test, and the single most load-bearing case in this file: an
 * underscore inside a word is NOT emphasis.  A naive "find the next matching
 * delimiter" scanner italicises half of every snake_case identifier a note
 * mentions, which is exactly the failure mode the contract's "bad half-parser"
 * warning is about.  `*` between the same two letters DOES open, because CM5's
 * rule reads `(ch === "*" || !rightFlanking || punctuation.test(before))`. */
test('inline: `_` inside a word is not emphasis, `*` is (CM5 flanking)', () => {
  assert.deepEqual(constructs('snake_case_word'), [])
  assert.equal(constructs('a*b*c').length, 1)
  assert.deepEqual(constructs('a * b * c'), [], 'a delimiter with space on both sides opens nothing')
  assert.deepEqual(constructs('**unclosed'), [], 'a run that never closes is not a construct')
})

test('inline: `***x***` is strong AND em over the same span, markers once', () => {
  const cs = constructs('***x***')
  assert.deepEqual(cs.map((c) => c.kind), ['strong', 'emphasis'])
  assert.deepEqual(cs[0].markers, [['open', 0, 3], ['close', 4, 7]])
  // The em carries NONE: emitting the shared run twice would hand §4 two
  // replace decorations over one range.
  assert.deepEqual(cs[1].markers, [])
  assert.deepEqual([cs[1].from, cs[1].to], [0, 7])
})

test('inline: a code span swallows every other delimiter inside it', () => {
  assert.deepEqual(constructs('`**not bold**`').map((c) => c.kind), ['inlineCode'])
})

/* The SOURCE emits in END order — the code span closes before the bold that
 * contains it — which is seam rule 3 as amended.  `Decoration.set(…, true)`
 * is what absorbs that; a `RangeSetBuilder` would have thrown "Ranges must be
 * added sorted by `from` position and `startSide`", and that throw is the whole
 * reason the builder had to go.  The assertion is on the RESULT, not on the
 * iteration order: CM6 stores replace and mark decorations in separate layers
 * and `between()` walks them layer by layer, so a flat ascending `from` is not
 * a property the set has or needs. */
test('inline: nesting closes inner-first, and §4 absorbs it', () => {
  assert.deepEqual(constructs('a **b `x` c** d').map((c) => c.kind), ['inlineCode', 'strong'])
  assert.deepEqual(clsAt('a **b `x` c** d'), [
    '2-4:HIDE', '6-7:HIDE', '8-9:HIDE', '11-13:HIDE', '2-13:nc-strong', '6-9:nc-code',
  ])
})

test('inline: `[text](url)` hides both markers and underlines the TEXT only', () => {
  assert.deepEqual(constructs('[t](u)'), [
    { kind: 'link', from: 0, to: 6, detail: 0, markers: [['open', 0, 1], ['close', 2, 6]] },
  ])
  // 1-2 is `t`.  Obsidian's `cm-underline` lands on the text alone (`E10 -> J2`).
  assert.deepEqual(clsAt('[t](u)'), ['0-1:HIDE', '1-2:nc-link', '2-6:HIDE'])
})

/* =========================================================================
 * §0.36 E83 — THE TWO LINK KINDS.  Reported as *"Can you render links?"* over
 * two screenshots of ONE note: in Obsidian both the bare
 * `https://github.com/medplum/medplum` and `[[feedback_pr_review_workflow]]`
 * are accent-coloured and underlined; in Cairn both were raw source.
 * ======================================================================= */

test('inline: `[[wikilink]]` hides both pairs of brackets and underlines the name', () => {
  assert.deepEqual(constructs('see [[note]] here'), [
    { kind: 'wikilink', from: 4, to: 12, detail: 0, markers: [['open', 4, 6], ['close', 10, 12]] },
  ])
  assert.deepEqual(clsAt('see [[note]] here'), ['4-6:HIDE', '6-10:nc-ilink', '10-12:HIDE'])
})

/* THE ALIAS IS THE HALF THAT A GUESS GETS WRONG.  Obsidian's decorator hides
 * `D = formatting-link || link-has-alias || link-alias-pipe` — so the TARGET
 * and the `|` go with the brackets — and underlines `M = hmd-internal-link &&
 * !link-has-alias && !link-alias-pipe`, which is the alias alone.  Read out of
 * its mode and its decorator, not inferred from what the screenshot shows. */
test('inline: `[[target|alias]]` hides the target AND the pipe, showing the alias', () => {
  assert.deepEqual(constructs('[[a/b/c|Alias]]'), [
    { kind: 'wikilink', from: 0, to: 15, detail: 0, markers: [['open', 0, 8], ['close', 13, 15]] },
  ])
  assert.deepEqual(clsAt('[[a/b/c|Alias]]'), ['0-8:HIDE', '8-13:nc-ilink', '13-15:HIDE'])
})

test('inline: a wikilink reveals its own source when the caret is inside it', () => {
  // scope 'construct': the caret in the name shows the brackets again…
  assert.deepEqual(clsAt('[[note]]', 4),
    ['0-2:nc-md-marker', '2-6:nc-ilink', '6-8:nc-md-marker'])
  // …and the caret elsewhere on the line does not (this is not 'line' scope).
  assert.deepEqual(clsAt('x [[note]] y', 0), ['2-4:HIDE', '4-8:nc-ilink', '8-10:HIDE'])
})

/* `![[x]]` is Obsidian's `hmd-embed`, which RENDERS the embedded note.  Cairn
 * has no renderer for that, and hiding an embed's brackets to draw a link that
 * is not an embed would be worse than leaving the source visible. */
test('inline: `![[embed]]` is not a wikilink and hides nothing', () => {
  assert.deepEqual(constructs('![[note]]'), [])
  assert.deepEqual(clsAt('![[note]]'), [])
})

test('inline: an unclosed `[[` is not a wikilink, on its line or any other', () => {
  assert.deepEqual(constructs('[[note'), [])
  assert.deepEqual(constructs('[[note\nmore]]'.replace('\\n', '\n')), [])
})

/* The url rule is Obsidian's `rU`, transcribed with its whole IANA scheme
 * list.  These rows are the REPORT's own strings: the note that was screenshot
 * carries all four. */
test('inline: a bare url is linkified, and stops where Obsidian stops', () => {
  assert.deepEqual(constructs('repo https://github.com/medplum/medplum.'), [
    { kind: 'url', from: 5, to: 39, detail: 0, markers: [] },
  ])
  // 39, not 40: the trailing `.` is outside the final character class, so the
  // sentence's full stop is not part of the link.
  assert.deepEqual(clsAt('repo https://github.com/medplum/medplum.'), ['5-39:nc-url'])
  assert.deepEqual(clsAt('at https://github.com/medplum/medplum/commits/main — and'),
    ['3-50:nc-url'])
})

/* `api.medplum.com` in the same note is INSIDE backticks, and `MoldCo side.`
 * is neither.  Both must stay plain, and the second is the one a hand-rolled
 * "word with a dot in it" rule gets wrong: Obsidian's scheme-less branch is
 * `[a-z0-9.\-]+[.][a-z]{2,4}\/`, which requires the slash. */
test('inline: a dotted word is not a url without a scheme or a path', () => {
  assert.deepEqual(constructs('the MoldCo side.'), [])
  assert.deepEqual(constructs('hosted at api.medplum.com, whose'), [])
  assert.deepEqual(constructs('`api.medplum.com`').map((c) => c.kind), ['inlineCode'])
})

/* Obsidian's guard is `state.hmdLinkType || state.image || state.linkText ||
 * …`, i.e. a url inside a link is already a link. */
test('inline: a url inside `[text](url)` is not linkified twice', () => {
  assert.deepEqual(constructs('[t](https://x.com/ab)').map((c) => c.kind), ['link'])
  assert.deepEqual(clsAt('[t](https://x.com/ab)'), ['0-1:HIDE', '1-2:nc-link', '2-21:HIDE'])
})

/* The OTHER half of linkifying, and the reason the run is consumed rather than
 * marked in place: a path with underscores in it must not italicise. */
test('inline: `_` and `*` inside a url open nothing', () => {
  assert.deepEqual(constructs('https://x.com/a_b_c_d').map((c) => c.kind), ['url'])
  assert.deepEqual(constructs('https://x.com/a*b*c').map((c) => c.kind), ['url'])
})

/* §0.39 E86 — `<https://…>`, THE STOCK MODE'S OWN AUTOLINK.  Reported from a
 * screenshot: Obsidian hid the angle brackets and Cairn drew them, with the url
 * inside linkified by §0.36's BARE rule — so the two apps disagreed about two
 * characters and agreed about everything between them. */
test('inline: `<https://x>` hides the angles and links what is between them', () => {
  assert.deepEqual(constructs('see <https://x.com/ab> here'), [
    { kind: 'autolink', from: 4, to: 22, detail: 0, markers: [['open', 4, 5], ['close', 21, 22]] },
  ])
  assert.deepEqual(clsAt('see <https://x.com/ab> here'),
    ['4-5:HIDE', '5-21:nc-link', '21-22:HIDE'])
})

test('inline: `<name@host>` is one too, and it is NOT the bare-url rule', () => {
  assert.deepEqual(constructs('<james@example.com>').map((c) => c.kind), ['autolink'])
  // The scheme set is CM5's own `(https?|ftps?)` — NARROWER than the 1.0 kB
  // list the bare rule uses, because an angle autolink is a narrower construct.
  assert.deepEqual(constructs('<ftp://x.com/ab>').map((c) => c.kind), ['autolink'])
  assert.deepEqual(constructs('<magnet:?xt=urn:x>'), [], 'magnet: is not in CM5 s four')
})

test('inline: an unclosed `<` is not an autolink and hides nothing', () => {
  assert.deepEqual(constructs('a < b and https://x.com/ab'),
    [{ kind: 'url', from: 10, to: 26, detail: 0, markers: [] }],
    'the bare url still linkifies; the stray `<` is text')
  assert.deepEqual(constructs('<https://x.com/ab').map((c) => c.kind), ['url'],
    'no closing angle: CM5 does not open one, and the bare rule takes it')
})

test('§0.38 E85: an autolink points at what is between the angles', () => {
  assert.deepEqual(LP.linkTargetAt(st('see <https://x.com/ab> here'), 10),
    { kind: 'external', url: 'https://x.com/ab' })
  assert.deepEqual(LP.linkTargetAt(st('<james@example.com>'), 5),
    { kind: 'external', url: 'mailto:james@example.com' })
})

/* THE PREFILTER'S OWN TABLE.  `scanInline` does not run the 1.0 kB pattern at
 * every letter: it runs it where the run of `[A-Za-z0-9.-]` starting there ends
 * in `:` or `/`, or where the text is `www…`.  That is a NECESSARY condition
 * for every branch of Obsidian's pattern, so it changes no answer — checked
 * against the unfiltered regex over the 30-note vault in the report, 120,694
 * letter positions, 1,340 matches, 0 misses, 89.5% of the attempts skipped.
 * These rows are the boundary cases that a wrong prefilter would drop. */
const URL_TABLE = [
  ['https://x.com', [[0, 13]], 'scheme, run ends at the `:`'],
  ['HTTPS://X.COM', [[0, 13]], 'the pattern is case-insensitive and so is the prefilter'],
  ['www.example.com', [[0, 15]], 'the `www` branch needs neither a colon nor a slash'],
  ['WWW.Example.com', [[0, 15]], 'and it is case-insensitive too'],
  ['x.com/ab', [[0, 8]], 'scheme-less: the run ends at the `/`'],
  ['x.com/a', [], 'and it needs two characters of path, which is Obsidian`s rule'],
  ['see x.com now', [], 'a dotted host with no path and no scheme is not a url'],
  ['ms-help://x/ab', [[0, 14]], 'a scheme with a dash in it, from the IANA list'],
  ['z39.50r://x/ab', [[0, 14]], 'and one with a dot and a digit'],
  ['note: this is prose', [], 'a word before a colon is not a scheme'],
  ['a/b and c/d', [], 'a slash alone linkifies nothing'],
]
for (const [doc, want, why] of URL_TABLE) {
  test(`url: ${why}`, () => {
    assert.deepEqual(
      constructs(doc).filter((c) => c.kind === 'url').map((c) => [c.from, c.to]),
      want, JSON.stringify(doc))
  })
}

test('inline: a bare email is linkified too, as Obsidian does', () => {
  assert.deepEqual(constructs('mail james@example.com now'), [
    { kind: 'url', from: 5, to: 22, detail: 0, markers: [] },
  ])
})

/* MID-WORD, AND THIS ONE IS THE OPPOSITE OF WHAT I FIRST ASSERTED.  CM5's
 * `inlineNormal` ends in `stream.next()` + `return getType(state)` — ONE
 * character per token in plain text — so Obsidian's wrapper runs its url test
 * at every position, and `xhttps://x.com/ab` is a link there from the `h`.
 * The first draft of this test pinned "not a link" on the assumption that the
 * stream consumed whole words; reading the mode's fallback disproved it. */
test('inline: a url glued to the end of a word still linkifies, from the scheme', () => {
  assert.deepEqual(constructs('xhttps://x.com/ab'), [
    { kind: 'url', from: 1, to: 17, detail: 0, markers: [] },
  ])
})

/* =========================================================================
 * §0.38 E85 — WHERE A CLICKED LINK POINTS.  `linkTargetAt` takes a STATE, not a
 * view, which is the whole design: the DOM only ever answers "did the pointer
 * land on a link span" — a question about pixels — and everything else is the
 * document.  So all of this is testable with no DOM at all.
 * ======================================================================= */

const target = (doc, pos) => LP.linkTargetAt(st(doc), pos)

test('§0.38 E85: a bare url is itself', () => {
  assert.deepEqual(target('see https://x.com/ab now', 10),
    { kind: 'external', url: 'https://x.com/ab' })
})

/* Obsidian's own last line: `/^([a-z0-9+.-]+):/.test(F) || (F = "https://" + F)`.
 * Its scheme-less branch matches `host.tld/path`, so this case is reachable. */
test('§0.38 E85: a url with no scheme gets https, as Obsidian gives it', () => {
  assert.deepEqual(target('see x.com/ab now', 6),
    { kind: 'external', url: 'https://x.com/ab' })
  assert.deepEqual(target('www.example.com', 3),
    { kind: 'external', url: 'https://www.example.com' })
})

/* …and `tm(F) ? F = "mailto:" + F : …` for an email.  The test that decides
 * which is the SCANNER's own literal, so the two cannot disagree about what an
 * email is. */
test('§0.38 E85: a bare email becomes mailto:', () => {
  assert.deepEqual(target('mail james@example.com now', 8),
    { kind: 'external', url: 'mailto:james@example.com' })
})

test('§0.38 E85: a wikilink points at its TARGET, never at its alias', () => {
  assert.deepEqual(target('see [[a note]] here', 8),
    { kind: 'internal', path: 'a note', subpath: '' })
  assert.deepEqual(target('see [[some/where|an alias]] here', 20),
    { kind: 'internal', path: 'some/where', subpath: '' },
    'the alias is what is on screen and it is not where the link goes')
})

/* The subpath is parsed and then ignored by the host — Cairn has no heading
 * index. Parsing it is not waste: it is what stops `[[Note#Heading]]` looking
 * for a file called `Note#Heading`. */
test('§0.38 E85: `#subpath` comes off the path and is carried separately', () => {
  assert.deepEqual(target('[[Note#Some heading]]', 5),
    { kind: 'internal', path: 'Note', subpath: '#Some heading' })
  assert.deepEqual(target('[[Note#Head|Alias]]', 14),
    { kind: 'internal', path: 'Note', subpath: '#Head' })
})

test('§0.38 E85: `[text](dest)` is external or internal by its scheme', () => {
  assert.deepEqual(target('[t](https://x.com/a)', 1),
    { kind: 'external', url: 'https://x.com/a' })
  assert.deepEqual(target('[t](Notes/other.md)', 1),
    { kind: 'internal', path: 'Notes/other.md', subpath: '' })
})

test('§0.38 E85: a position on no link at all answers null', () => {
  assert.equal(target('just some prose', 5), null)
  assert.equal(target('`https://x.com/ab`', 5), null, 'a url inside a code span is code')
  assert.equal(target('see [[a note]] here', 1), null, 'before the link')
  assert.equal(target('see [[a note]] here', 16), null, 'after it')
})

/* Obsidian calls a `[text]` with no destination `hmd-barelink` and its
 * decorator sets `b = P = false` for one: NOTHING is hidden.  So Cairn emits no
 * construct at all rather than hiding brackets someone typed on purpose. */
test('inline: a bare `[text]` is not a link and hides nothing', () => {
  assert.deepEqual(constructs('see [note] here'), [])
})

test('inline: a backslash escape hides the backslash only', () => {
  assert.deepEqual(constructs('a \\* b'), [
    { kind: 'escape', from: 2, to: 4, detail: 0, markers: [['open', 2, 3]] },
  ])
  assert.deepEqual(constructs('a \\q b'), [], 'q is not escapable, so there is no escape')
})

/* -- lists, tasks -------------------------------------------------------- */

test('lists: the bullet marker is ONE character and is re-drawn, not removed', () => {
  assert.deepEqual(constructs('- item'), [
    { kind: 'listUl', from: 0, to: 6, detail: 0, markers: [['prefix', 0, 1]] },
  ])
  assert.deepEqual(clsAt('- item'), ['0-0:nc-li', '0-1:nc-bullet'])
  // and it is NOT atomic: the `-` is still on screen, so the caret must be able
  // to sit beside it.
  const built = LP.buildDecorations(st('- item'), [{ from: 0, to: 6 }], undefined, [])
  const atoms = []
  built.atoms.between(0, 6, (f, t) => atoms.push([f, t]))
  assert.deepEqual(atoms, [])
})

test('lists: an ordered marker keeps its whole `1. ` token', () => {
  assert.deepEqual(constructs('1. item'), [
    { kind: 'listOl', from: 0, to: 7, detail: 0, markers: [['prefix', 0, 3]] },
  ])
  assert.deepEqual(clsAt('1. item'), ['0-0:nc-li', '0-3:nc-num'])
})

/* `lib/codemirror/markdown.js:586` guards the stock mode's link branch on
 * `!state.image`, and `:563` sets that flag from a `!` followed by a complete
 * `[…]` and a `(` or `[`. Cairn's `[[wikilink]]` branch had the equivalent
 * guard (§0.36 E83) and its `[text](url)` branch did not, so `![alt](url)` came
 * out as `!` plus a rendered, UNDERLINED, CLICKABLE link over `alt` — and
 * §0.38 E85's handler would open the image url in a browser. `KNOWN-ISSUES.md`
 * LP-2 says images render as raw source; this is what makes them. */
test('links: `![alt](url)` is an IMAGE, so it is not scanned as a link at all', () => {
  assert.deepEqual(constructs('![alt](http://x.test/a.png)'), [],
    'nothing may be emitted — the whole run stays raw source')
  assert.deepEqual(clsAt('![alt](http://x.test/a.png)'), [],
    'and nothing may be hidden, or the `!` is left in front of a bare word')
  // The negatives, so the guard cannot be a blanket refusal of links:
  assert.deepEqual(constructs('[alt](http://x.test/a.png)').map((c) => c.kind), ['link'])
  assert.deepEqual(constructs('hi! [alt](http://x.test/a.png)').map((c) => c.kind), ['link'],
    'a `!` that is not touching the bracket is prose')
  // And `![[embed]]` was already excluded, by the same test one branch up.
  assert.deepEqual(constructs('![[some/note]]'), [])
})

/* THE LINKED IMAGE — `[![badge](img)](page)`, one of the commonest shapes in a
 * real note. The stock mode's `!` rule (`markdown.js:563`) has NO
 * `state.linkText` guard, and while Cairn's did, this scanned as
 * `link[0,12] + url[14,31]`: the reader saw `![a` drawn as an accent-underlined
 * link whose destination was the IMAGE, then a literal `](`, then the real url
 * linkified separately — and a click went to `b.png`.
 *
 * Images are still absent (LP-2), so the link's TEXT is the raw image source.
 * What matters is that it is ONE link and that its destination is the url. */
test('links: a linked image is ONE link to the url, not a link to the image', () => {
  const line = '[![a](b.png)](https://x.test/go)'
  assert.deepEqual(constructs(line).map((c) => c.kind + '[' + c.from + ',' + c.to + ']'),
    ['link[0,32]'], 'one link spanning the whole run — no stray `url` construct')
  assert.deepEqual(clsAt(line),
    ['0-1:HIDE', '1-12:nc-link', '12-32:HIDE'],
    'the outer bracket and `](url)` are hidden; the image source is the link text')
  // The destination is the URL, not the image — which is what the click follows.
  assert.equal(line.slice(13, 31), '(https://x.test/go')
})

test('lists: a nested bullet is found at its own indent', () => {
  assert.deepEqual(constructs('    - deep'), [
    { kind: 'listUl', from: 0, to: 10, detail: 0, markers: [['prefix', 4, 5]] },
  ])
})

test('tasks: the bullet goes whole and the box becomes a widget', () => {
  assert.deepEqual(constructs('- [ ] todo'), [
    // detail 1 on the list is "this marker leads a task line" — §4 reads it to
    // hide the bullet instead of dotting it.
    { kind: 'listUl', from: 0, to: 10, detail: 1, markers: [['prefix', 0, 2]] },
    { kind: 'task', from: 2, to: 5, detail: 0, markers: [['open', 2, 5]] },
  ])
  assert.deepEqual(clsAt('- [ ] todo'), ['0-0:nc-li', '0-2:HIDE', '2-5:WTaskWidget'])
  assert.equal(constructs('- [x] done')[1].detail, 1, '`x` is the checked bit')
  assert.equal(constructs('- [X] done')[1].detail, 1, 'and so is `X`')
})

/* app.css:14147.  A TICKED task line is struck through and muted, and Cairn had
 * both tokens and no rule.  The state rides on the LIST construct's `detail`
 * because that is the construct that owns the LINE: 0 plain, 1 a task, 2 a
 * ticked task.  Obsidian reaches the same place by a second ViewPlugin that
 * re-matches the line for a `data-task` attribute (app.js:79884). */
test('tasks: a TICKED task line carries the done class, and an open one does not', () => {
  assert.equal(constructs('- [x] done')[0].detail, 2, 'the LIST construct carries the tick')
  assert.equal(constructs('- [X] done')[0].detail, 2, 'and `X` counts')
  assert.equal(constructs('- [ ] todo')[0].detail, 1, 'an open task is still just a task line')
  assert.equal(constructs('- plain')[0].detail, 0)
  assert.deepEqual(clsAt('- [x] done'), ['0-0:nc-li nc-li-done', '0-2:HIDE', '2-5:WTaskWidget'])
  // …and the bullet still goes whole, which is what `detail === 1` used to gate.
  assert.deepEqual(clsAt('1. [x] done'), ['0-0:nc-li nc-li-done', '0-3:HIDE', '3-6:WTaskWidget'])
})

test('tasks: `- [z]` is not a task box', () => {
  assert.deepEqual(constructs('- [z] no').map((c) => c.kind), ['listUl'])
})

/* -- blockquotes, thematic breaks ---------------------------------------- */

test('quotes: one construct, one marker per `>`, depth in detail', () => {
  assert.deepEqual(constructs('> q'), [
    { kind: 'blockquote', from: 0, to: 3, detail: 1, markers: [['prefix', 0, 1]] },
  ])
  assert.deepEqual(constructs('>> deep'), [
    { kind: 'blockquote', from: 0, to: 7, detail: 2, markers: [['prefix', 0, 1], ['prefix', 1, 2]] },
  ])
})

/* The first `>` keeps its place and the LINE's ::before draws the rule; every
 * deeper one becomes a widget carrying its own rule.  That is Obsidian's
 * `e6` / `i6` split, and it is why `nc-quote-1` and `nc-quote-n` differ. */
test('quotes: the first `>` is a mark, deeper ones are border widgets', () => {
  assert.deepEqual(clsAt('> q'), ['0-0:nc-quote nc-quote-1', '0-1:nc-quote-mark'])
  assert.deepEqual(clsAt('>> deep'),
    ['0-0:nc-quote nc-quote-n', '0-1:nc-quote-mark', '1-2:WQuoteBorderWidget'])
})

test('quotes: content after the marker is still tokenised', () => {
  assert.deepEqual(constructs('> **b**').map((c) => c.kind), ['blockquote', 'strong'])
})

test('hr: the line becomes a rule widget, and beats the list rule', () => {
  for (const doc of ['***', '---', '___', '- - -']) {
    const cs = constructs(doc)
    assert.deepEqual(cs.map((c) => c.kind), ['hr'], doc)
    assert.deepEqual(cs[0].markers, [['prefix', 0, doc.length]], doc)
  }
  assert.deepEqual(clsAt('***'), ['0-0:nc-hr', '0-3:WRuleWidget'])
})

/* -- headings ------------------------------------------------------------ */

/* Obsidian: `g10.text.trim() === u11().trim() || h11(...)`.  A line whose whole
 * content IS the hashes never hides them, or the line would look empty at the
 * exact moment you were typing it. */
test('heading: a line that is only hashes keeps them visible', () => {
  assert.deepEqual(constructs('## '), [
    { kind: 'heading', from: 0, to: 3, detail: 2, markers: [] },
  ])
  assert.deepEqual(clsAt('## '), ['0-0:nc-h nc-h2'])   // §0.30 E73: shared + level
  assert.equal(constructs('## H')[0].markers.length, 1)
})

test('heading: the rest of the line is tokenised as inline', () => {
  assert.deepEqual(constructs('# a **b**').map((c) => c.kind), ['heading', 'strong'])
})

/* -- the reveal rule, which is three rules ------------------------------- */

/* This is the change §5.4.1 did not anticipate and the one most likely to be
 * "simplified" back: inline formatting reveals per CONSTRUCT, not per line. */
test('reveal: a caret in one bold does not reveal the other bold on its line', () => {
  const doc = '**bold** plain **more**'
  const at4 = clsAt(doc, 4)
  assert.ok(at4.includes('0-2:nc-md-marker-plain'), 'the one the caret is in is revealed')
  assert.ok(at4.includes('15-17:HIDE'), 'the one it is not in stays hidden')
  // and with the caret between them, neither is revealed
  const at11 = clsAt(doc, 11)
  assert.ok(at11.includes('0-2:HIDE') && at11.includes('15-17:HIDE'))
})

test('reveal: a heading marker is per LINE, and its bold is not', () => {
  const at = clsAt('# H **b**', 2)
  assert.ok(at.includes('0-2:nc-md-marker'), 'the `# ` reveals from anywhere on the line')
  assert.ok(at.includes('4-6:HIDE'), 'the bold on the same line does not')
})

test('reveal: a list bullet reveals only with the caret ON it', () => {
  assert.deepEqual(clsAt('- item', 0), ['0-0:nc-li', '0-1:nc-md-marker'])
  assert.deepEqual(clsAt('- item', 4), ['0-0:nc-li', '0-1:nc-bullet'])
})

/* Obsidian: `v10 = t10.hasFocus ? d11.selection.ranges : []`.  Clicking into
 * the file tree makes a note render with nothing revealed at all, and this is
 * the whole of the mechanism. */
test('reveal: an UNFOCUSED editor reveals nothing, wherever the selection is', () => {
  const state = st('# H').update({ selection: { anchor: 2 } }).state
  const focused = LP.buildDecorations(state, [{ from: 0, to: 3 }], undefined, state.selection.ranges)
  const blurred = LP.buildDecorations(state, [{ from: 0, to: 3 }], undefined, [])
  const cls = (b) => { const o = []; b.decorations.between(0, 3, (f, t, v) => o.push(v.spec.class)); return o }
  assert.deepEqual(cls(focused), ['nc-h nc-h1', 'nc-md-marker'])
  assert.deepEqual(cls(blurred), ['nc-h nc-h1', undefined], 'the marker is a replace, so it has no class')
})

/* `allowMultipleSelections` is not decoration: without it `EditorState.update`
 * silently keeps the primary range and drops the rest, and this test would then
 * assert nothing at all while passing for the wrong reason. */
test('reveal: every range counts, not only the primary one', () => {
  const base = CM.EditorState.create({
    doc: '**a** **b**',
    extensions: [LP.blockIndex, CM.EditorState.allowMultipleSelections.of(true)],
  })
  const sel = CM.EditorSelection.create([CM.EditorSelection.cursor(0), CM.EditorSelection.cursor(7)], 0)
  const state = base.update({ selection: sel }).state
  assert.equal(state.selection.ranges.length, 2, 'both ranges survived into the state')
  const built = LP.buildDecorations(state, [{ from: 0, to: 11 }], undefined, state.selection.ranges)
  const out = []
  built.decorations.between(0, 11, (f, t, v) => { if (v.spec.class) out.push(`${f}-${t}:${v.spec.class}`) })
  assert.ok(out.includes('0-2:nc-md-marker-plain'), 'the primary range reveals its own construct')
  assert.ok(out.includes('6-8:nc-md-marker-plain'), 'and so does the secondary one')
})

/* -- the code block still wins over everything --------------------------- */

test('code block: nothing inside one is tokenised (§5.3, §9 E4)', () => {
  const doc = '```\n**b** - x > q\n```'
  assert.deepEqual(constructs(doc).map((c) => c.kind), ['codeblock'])
  assert.deepEqual(clsAt(doc), ['0-0:nc-cb nc-cb-first', '4-4:nc-cb', '18-18:nc-cb nc-cb-last'])
})

/* -- the borrow rule, which a pool bug broke once already ----------------- */

/* An earlier draft grew the marker pool by calling `mark(i, 0, 0)`, which
 * zeroed the marker it was about to hand out — but only for the FIRST
 * construct of each arity in the process, because every later call found the
 * array cached.  A test whose subject is not the first thing the scanner ever
 * sees cannot catch that, so this one asserts the property directly. */
test('source: a fresh process gets correct markers on its very first construct', () => {
  assert.deepEqual(constructs('## H')[0].markers, [['prefix', 0, 3]])
})

test('source: constructs are borrowed — the same object comes back each time', () => {
  const state = st('**a** **b**')
  const seen = []
  LP.markdownSource.constructsIn(state, 0, state.doc.length, (c) => seen.push(c))
  assert.equal(seen.length, 2)
  assert.equal(seen[0], seen[1], 'the source reuses one object, as the seam permits')
})

/* =========================================================================
 * 6.  PARAGRAPH-SCOPED INLINE SCANNING (§5.4.4's deviation (a), retired
 *     2026-09-09).
 *
 *     v2 shipped with inline state reset at every line, and the first real
 *     note it was pointed at showed why that was not good enough: hard-wrapped
 *     prose puts `**bold text` on one line and `more bold**` on the next, and
 *     a per-line scanner renders both asterisk runs raw. CM5 carries
 *     `em`/`strong`/`code` across the lines of a paragraph and so does this
 *     now — bounded, because seam rule 5 still binds.
 * ======================================================================= */

test('paragraph: emphasis spans a hard line break', () => {
  const cs = constructs('a **per-patient value, never a\nconstant**: b')
  assert.deepEqual(cs.map((c) => c.kind), ['strong'])
  assert.deepEqual(cs[0].markers, [['open', 2, 4], ['close', 39, 41]])
})

test('paragraph: a code span spans one too', () => {
  assert.deepEqual(constructs('x `a\nb` y').map((c) => c.kind), ['inlineCode'])
})

/* The bound, and it is the whole reason a paragraph is not "the rest of the
 * document": a BLANK LINE ends it, and an unclosed run then opens nothing. */
test('paragraph: a blank line ends it, and the run does not close across it', () => {
  assert.deepEqual(constructs('a **bold\n\nnot bold** b'), [])
})

for (const [why, doc] of [
  ['a heading', '**a\n# h\nb**'],
  ['a list item', '**a\n- item\nb**'],
  ['a blockquote', '**a\n> q\nb**'],
  ['a thematic break', '**a\n***\nb**'],
  ['a fenced code block', '**a\n```\nx\n```\nb**'],
]) {
  test(`paragraph: ${why} ends it`, () => {
    assert.ok(!constructs(doc).some((c) => c.kind === 'strong'),
      'a run must not close across a block boundary')
  })
}

/* Seam rule 1 is INTACT across the paragraph walk, and this is the case that
 * proves it: the scanner backs up to the paragraph start to get the inline
 * state right, so it sees a construct that lies entirely before the range it
 * was asked for — and `emit` drops it rather than handing §4 something to
 * clip. The viewport here starts on line 3. */
test('paragraph: a construct wholly outside the asked-for range is not emitted', () => {
  const text = '**one**\n**two**\n**three**'
  const state = st(text)
  const from = state.doc.line(3).from
  const out = []
  LP.markdownSource.constructsIn(state, from, state.doc.length, (c) => out.push([c.from, c.to]))
  assert.deepEqual(out, [[16, 25]], 'only the run on the asked-for line')
})

/* And the state it backs up FOR: line 2 of a two-line paragraph must know that
 * line 1 opened a run, or the viewport's first line renders its `**` raw. */
test('paragraph: a viewport starting mid-paragraph still closes the run', () => {
  const text = 'a **bold\nmore** b'
  const state = st(text)
  const from = state.doc.line(2).from
  const out = []
  LP.markdownSource.constructsIn(state, from, state.doc.length, (c) => out.push(c.kind))
  assert.deepEqual(out, ['strong'])
})

/* F84: a link destination must close on its own line (CM5's `\(.*?\)` never
 * crosses one). `[^)]` matched `\n`, so a `)` on a later line produced a
 * replace decoration spanning a line break — which CM6 forbids from a plugin
 * and threw, wedging the editor with the new state bound to the dead DOM. */
test('F84: no link construct crosses a line break', () => {
  assert.deepEqual(constructs('see [the docs](https://x.com/a "The\nofficial docs") ok').filter((c) => c.kind === 'link'), [])
  assert.deepEqual(constructs('typing [foo](\nthen (a note) here').filter((c) => c.kind === 'link'), [])
  assert.deepEqual(constructs('handlers[i](event,\nctx) done').filter((c) => c.kind === 'link'), [])
})

test('F84: no hidden marker decoration crosses a line break', () => {
  for (const doc of [
    'see [the docs](https://x.com/a "The\nofficial docs") ok',
    'typing [foo](\nthen (a note) here',
    'handlers[i](event,\nctx) done',
    '[![a](b.png)](url\nmore) z',
  ]) {
    const state = st(doc)
    const built = LP.buildDecorations(state, [{ from: 0, to: state.doc.length }], undefined, [])
    built.decorations.between(0, state.doc.length, (from, to, v) => {
      if (v === LP.HIDE_MARK) assert.ok(to <= state.doc.lineAt(from).to, `HIDE_MARK ${from}-${to} crosses a line in ${JSON.stringify(doc)}`)
    })
  }
})

test('F84: a single-line link still renders', () => {
  assert.equal(constructs('x [a](b) y').filter((c) => c.kind === 'link').length, 1)
})

/* F77: typing with an IME right after a closing marker must not flip the
 * reveal mid-composition. The first composed character moves the caret past
 * the marker, and a rebuild then hides it while Chrome holds the composition
 * inside the body mark — CM6's redraw drops the construct's text from the DOM
 * and the diff comes back as a deletion, which autosave writes to disk. */
test('F77: the reveal state is frozen while a composition is active', () => {
  const text = '- **sách**'
  const caret = text.length // right after the closing **
  const s0 = st(text).update({ selection: { anchor: caret } }).state
  const fakeView = (state, composing) => ({
    state,
    visibleRanges: [{ from: 0, to: state.doc.length }],
    hasFocus: true,
    composing,
  })
  const P = new LP.LivePreview(fakeView(s0, false))
  const hideCount = () => {
    let n = 0
    P.decorations.between(0, s0.doc.length + 8, (from, to, v) => {
      if (v === LP.HIDE_MARK) n++
    })
    return n
  }
  assert.equal(hideCount(), 0, 'revealed while the caret touches the construct')
  // The composition inserts 'v': the caret leaves the construct.
  const tr = s0.update({ changes: { from: caret, insert: 'v' }, selection: { anchor: caret + 1 } })
  P.update({
    view: fakeView(tr.state, true),
    changes: tr.changes,
    docChanged: true, selectionSet: true, viewportChanged: false, focusChanged: false,
  })
  assert.equal(hideCount(), 0, 'still revealed mid-composition — the rebuild is deferred')
  // The composition ends: the deferred rebuild runs and hides the markers.
  P.update({
    view: fakeView(tr.state, false),
    changes: tr.changes,
    docChanged: false, selectionSet: false, viewportChanged: false, focusChanged: false,
  })
  assert.ok(hideCount() > 0, 'hidden again once the composition is over')
})
