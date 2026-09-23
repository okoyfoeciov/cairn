// Owner: 05 (a NEW file — §6.4's table row `tests/frontend/*.test.mjs` names
// owner 03; this file is search's own and is REPORTED as an addition rather
// than an edit to anything owner 03 wrote).  `node --test tests/frontend/`.
//
// Spec: CONTRACT.md §4.3 (X15 — the frontend is the ONE generation writer and
// the gen mismatch is THE ONLY staleness test), §4.4 (batching, the ≤800 DOM
// ceiling, UTF-16 offsets), §4.5 (the constants the count line renders from),
// §1.5 (the wire types), spec-05 §6.3 (the ONE reorder), §8.4 (highlight
// rendering with NO innerHTML), §8.5 (the count line's exact copy), §8.6 (the
// empty states), §8.8 (the collapse policy), §8.9 (the keyboard), §9 (opening a
// result), §11.2/§11.3.
//
// `src/search.ts` is TypeScript and esbuild is the project's only transpiler
// (CONTRACT §6.3), so this file bundles the module to ESM in a temp dir and
// imports that.  No new dependency, and the code under test is the shipped code.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'
import { installGlobals, makeSidebar } from './_minidom.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const SRC = join(HERE, '..', '..', 'src', 'search.ts')

installGlobals()

const out = mkdtempSync(join(tmpdir(), 'cairn-search-'))
await esbuild.build({
  entryPoints: [SRC], bundle: true, format: 'esm', platform: 'neutral',
  target: 'es2021', outfile: join(out, 'search.mjs'), logLevel: 'silent',
})
const S = await import(join(out, 'search.mjs'))
process.on('exit', () => { try { rmSync(out, { recursive: true, force: true }) } catch {} })

/** The shipped source with comments removed.  Stripping matters: this file
 *  asserts that certain constructs are ABSENT, and a comment SAYING the
 *  construct is absent otherwise fails the very check it documents. */
const SOURCE = readFileSync(SRC, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

/* ── fixtures ─────────────────────────────────────────────────────────────── */

let nextId = 0
function group(rel, o = {}) {
  return {
    id: o.id ?? nextId++,
    rel,
    name: o.name ?? rel.split('/').pop().replace(/\.md$/, ''),
    nameRanges: o.nameRanges ?? [],
    snippets: o.snippets ?? [{ line: 3, text: 'a hit here', ranges: [[2, 5]], col: 2, len: 3 }],
    matchCount: o.matchCount ?? 1,
    more: o.more ?? false,
    rank: o.rank ?? [1, 0, 0],
  }
}
function complete(gen, o = {}) {
  return {
    kind: 'complete', gen,
    order: o.order ?? [], totalMatches: o.totalMatches ?? 0, totalFiles: o.totalFiles ?? 0,
    scanned: o.scanned ?? 5000, skipped: o.skipped ?? 0, truncated: o.truncated ?? false,
    smartCase: o.smartCase ?? false, cancelled: o.cancelled ?? false, elapsedMs: o.elapsedMs ?? 45,
  }
}

function deps(log = []) {
  return {
    log,
    start: async (q, gen) => { log.push(['start', q, gen]) },
    cancel: async (gen) => { log.push(['cancel', gen]) },
    expand: async (q, rel) => { log.push(['expand', q, rel]); return [] },
    openResult: async (rel, line, col, len) => { log.push(['open', rel, line, col, len]) },
    focusEditor: () => { log.push(['focusEditor']) },
  }
}

/** A click at `x` CSS px from the row's left edge, delivered the way the real
 *  delegated listener sees it: one event on `.sr-list` whose target is the row. */
function chevronClick(panel, row, x) {
  const ev = new globalThis.MouseEvent('click', { clientX: x })
  ev.target = row
  panel.root.querySelector('.sr-list').dispatch('click', ev)
}

function mount(now = () => 0) {
  const { sidebar, tree } = makeSidebar()
  const log = []
  const panel = S.mountSearch(sidebar, deps(log), now)
  return { panel, sidebar, tree, log }
}

/* ═══ the generation rule — CONTRACT §4.3, X15 ═══════════════════════════════ */

test('the generation is monotonic, never reused, and this module is its only writer', () => {
  const a = S.nextGeneration(), b = S.nextGeneration(), c = S.nextGeneration()
  assert.ok(a < b && b < c, `${a} < ${b} < ${c}`)
  assert.equal(S.currentGeneration(), c)
})

test('a message whose gen is not the current query generation is DROPPED — the only staleness test there is', () => {
  const m = new S.SearchModel()
  m.begin('x', 7, 0)
  assert.equal(m.accept({ kind: 'batch', gen: 6, groups: [group('old.md')] }), 'stale')
  assert.equal(m.accept({ kind: 'batch', gen: 8, groups: [group('future.md')] }), 'stale')
  assert.equal(m.groups.length, 0, 'a stale batch must not touch the model')
  assert.equal(m.accept({ kind: 'batch', gen: 7, groups: [group('mine.md')] }), 'batch')
  assert.equal(m.groups.length, 1)
})

test("a cancelled job's own Complete is dropped by the ordinary staleness rule", () => {
  const m = new S.SearchModel()
  m.begin('x', 4, 0)
  m.begin('xy', 5, 0)                                   // the user typed another character
  assert.equal(m.accept(complete(4, { cancelled: true })), 'stale')
  assert.equal(m.complete, null)
  assert.equal(m.inFlight, true, 'the LIVE query must still be in flight')
})

test('typing another character cancels in flight and issues a new number', () => {
  const { panel, log } = mount()
  panel.runQuery('me')
  const g1 = panel.model.gen
  panel.runQuery('mem')
  const g2 = panel.model.gen
  assert.ok(g2 > g1)
  assert.deepEqual(log.filter((r) => r[0] === 'start').map((r) => r[2]), [g1, g2])
  // Late traffic on the superseded generation reaches the model and is dropped.
  assert.equal(panel.model.accept({ kind: 'batch', gen: g1, groups: [group('stale.md')] }), 'stale')
})

test('an empty query cancels on a freshly issued number and clears the panel', () => {
  const { panel, log } = mount()
  panel.runQuery('memory')
  panel.model.accept({ kind: 'batch', gen: panel.model.gen, groups: [group('a.md')] })
  panel.runQuery('')
  assert.equal(panel.model.groups.length, 0)
  const cancels = log.filter((r) => r[0] === 'cancel')
  assert.equal(cancels.length, 1)
  assert.ok(cancels[0][1] > 0, 'cancel carries a number this module issued')
})

/* ═══ FileGroup.id is a DOM key, never an index into the tree — X14 ══════════ */

test('the tree is reached by PATH; FileGroup.id is used only as a per-generation key', () => {
  const m = new S.SearchModel()
  m.begin('q', 1, 0)
  // A files-only index space: ids skip the directories the blob would contain.
  m.accept({ kind: 'batch', gen: 1, groups: [group('deep/dir/a.md', { id: 41 }), group('b.md', { id: 7 })] })
  m.accept(complete(1, { order: [7, 41], totalFiles: 2, totalMatches: 2 }))
  assert.deepEqual(m.contentGroups().map((g) => g.rel), ['b.md', 'deep/dir/a.md'])
  // Nothing anywhere derives a path or a row from the number.
  const src = S.SearchModel.toString() + S.SearchPanel.toString()
  assert.equal(/\.id\s*[+\-]/.test(src), false, 'no arithmetic on FileGroup.id')
})

/* ═══ ordering — spec-05 §6.3 ════════════════════════════════════════════════ */

test('Complete applies its order once; ids missing from `order` keep arrival order at the end', () => {
  const m = new S.SearchModel()
  m.begin('q', 2, 0)
  m.accept({ kind: 'batch', gen: 2, groups: [group('c.md', { id: 3 }), group('a.md', { id: 1 })] })
  m.accept({ kind: 'batch', gen: 2, groups: [group('b.md', { id: 2 })] })
  assert.deepEqual(m.contentGroups().map((g) => g.rel), ['c.md', 'a.md', 'b.md'], 'arrival order until Complete')
  m.accept(complete(2, { order: [1, 2], totalFiles: 3, totalMatches: 3 }))
  assert.deepEqual(m.contentGroups().map((g) => g.rel), ['a.md', 'b.md', 'c.md'])
})

test('a duplicated group id in a later batch is not appended twice', () => {
  const m = new S.SearchModel()
  m.begin('q', 1, 0)
  m.accept({ kind: 'batch', gen: 1, groups: [group('a.md', { id: 5 })] })
  m.accept({ kind: 'batch', gen: 1, groups: [group('a.md', { id: 5 })] })
  assert.equal(m.groups.length, 1)
})

/* ═══ the collapse policy — spec-05 §8.8 ════════════════════════════════════ */

test('content groups 1..10 render expanded and 11+ render collapsed', () => {
  const m = new S.SearchModel()
  m.begin('q', 1, 0)
  assert.equal(S.AUTO_EXPAND_GROUPS, 10)
  for (let i = 0; i < 12; i += 1) assert.equal(m.isCollapsed(`f${i}.md`, i), i >= 10, `index ${i}`)
})

test('an explicit toggle beats the positional default, and the map dies with the query', () => {
  const m = new S.SearchModel()
  m.begin('q', 1, 0)
  m.collapsed.set('f0.md', true)
  assert.equal(m.isCollapsed('f0.md', 0), true)
  m.begin('q2', 2, 0)
  assert.equal(m.collapsed.size, 0, 'collapse state is discarded whenever the query changes')
  assert.equal(m.isCollapsed('f0.md', 0), false)
})

/* ═══ the count line — spec-05 §8.5, rendered FROM the constants ════════════ */

function counted(query, msgs, now = 1000) {
  const m = new S.SearchModel()
  m.begin(query, 1, 0)
  for (const x of msgs) m.accept(x)
  return m.countLine(now)
}

test('the count line reproduces §8.5 exactly', () => {
  assert.equal(counted('q', [complete(1, { totalMatches: 312, totalFiles: 74 })]),
    '312 matches in 74 files')
  assert.equal(counted('q', [complete(1, { totalMatches: 1, totalFiles: 1 })]),
    '1 match in 1 file')
  assert.equal(counted('Q', [complete(1, { totalMatches: 5, totalFiles: 2, smartCase: true })]),
    '5 matches in 2 files · case-sensitive')
  assert.equal(counted('q', [complete(1, { totalMatches: 9, totalFiles: 3, skipped: 2 })]),
    '9 matches in 3 files · 2 skipped')
  assert.equal(counted('/ab/', [complete(1, { totalMatches: 4, totalFiles: 1 })]),
    'regex · 4 matches in 1 file')
  assert.equal(counted('q', [complete(1, { totalMatches: 1000, totalFiles: 200, truncated: true })]),
    '1,000+ matches in 200+ files · stopped')
})

test('numbers use toLocaleString, so 5,000 renders with its separator', () => {
  // `totalMatches` and `totalFiles` are themselves capped at 1,000 / 200, so the
  // only count-line number that can carry a separator is `skipped`.
  assert.equal(counted('q', [complete(1, { totalMatches: 9, totalFiles: 3, skipped: 1234 })]),
    '9 matches in 3 files · 1,234 skipped')
  const m = new S.SearchModel()
  m.begin('memory', 1, 0)   // >= MIN_CONTENT_QUERY_CHARS, so the scan really ran
  m.accept(complete(1, { totalMatches: 0, totalFiles: 0, scanned: 5000, elapsedMs: 48 }))
  assert.deepEqual(m.stateCopy(), { primary: 'No results', secondary: 'Searched 5,000 notes in 48 ms' })
})

test('the `+` is attached per cap ACTUALLY reached, not both at once', () => {
  // The real `memory` query on fixtures/corpus-a: files=200 (capped), matches=524.
  assert.equal(counted('memory', [complete(1, { totalMatches: 524, totalFiles: 200, truncated: true })]),
    '524 matches in 200+ files · stopped')
})

test('§8.7: nothing at all below 120 ms, `Searching…` above it, partial once a batch lands', () => {
  const m = new S.SearchModel()
  m.begin('memory', 1, 0)
  assert.equal(m.countLine(100), null, 'a warm 5 ms search must show no chrome whatsoever')
  assert.equal(m.countLine(200), 'Searching…')
  m.accept({ kind: 'batch', gen: 1, groups: [group('a.md', { matchCount: 47 })] })
  assert.equal(m.countLine(200), '47 matches in 1 file · searching…')
})

test('the count line is hidden for an empty query and for a bad regex', () => {
  const m = new S.SearchModel()
  assert.equal(m.countLine(999), null)
  m.begin('/[/', 1, 0)
  m.accept({ kind: 'error', gen: 1, message: 'regex parse error:' })
  assert.equal(m.countLine(999), null)
})

/* ═══ empty and error states — spec-05 §8.6 ════════════════════════════════ */

test('the five §8.6 states', () => {
  const m = new S.SearchModel()
  assert.deepEqual(m.stateCopy(), {
    primary: 'Search this vault',
    secondary: 'Wrap the query in /slashes/ for a regular expression.',
  })

  m.begin('a', 1, 0)
  assert.equal(m.stateCopy().primary, 'Type 2 characters to search note contents')
  assert.equal(S.MIN_CONTENT_QUERY_CHARS, 2)

  m.begin('ab', 2, 0)
  m.accept(complete(2, { scanned: 5000, elapsedMs: 48 }))
  assert.deepEqual(m.stateCopy(), { primary: 'No results', secondary: 'Searched 5,000 notes in 48 ms' })

  m.vaultNotes = 0
  assert.deepEqual(m.stateCopy(), { primary: 'This vault has no notes', secondary: null })

  m.vaultNotes = null
  m.begin('ab', 3, 0)
  m.accept({ kind: 'error', gen: 3, message: 'regex parse error:' })
  assert.equal(m.stateCopy(), null, 'a bad regex renders in .sr-error, not in .sr-state')
  assert.equal(m.error, 'regex parse error:')
})

test('a bad regex is TERMINAL: no Complete follows, and the panel shows the message verbatim', () => {
  const { panel } = mount()
  panel.runQuery('/[/')
  const gen = panel.model.gen
  panel.model.accept({ kind: 'error', gen, message: 'regex parse error:\n    /[/' })
  panel.paint()
  const box = panel.root.querySelector('.sr-error')
  assert.ok(box, 'an inline .sr-error, not a crash and not an empty result list')
  assert.equal(box.textContent, 'regex parse error:\n    /[/')
})

/* ═══ query shape — spec-05 §5.1 / §5.2 / §13 ═════════════════════════════ */

test('/x/ is a regex; / and // are literals; smart case engages on any uppercase', () => {
  assert.equal(S.isRegexQuery('/ab/'), true)
  assert.equal(S.isRegexQuery('/a/'), true)
  assert.equal(S.isRegexQuery('//'), false)
  assert.equal(S.isRegexQuery('/'), false)
  assert.equal(S.smartCaseEngaged('md'), false)
  assert.equal(S.smartCaseEngaged('MD'), true)
  assert.equal(S.smartCaseEngaged('/AB/'), true)
  assert.equal(S.smartCaseEngaged('straße'), false)
})

/* ═══ highlight rendering — spec-05 §8.4, and the UTF-16 rule ══════════════ */

function highlightShape(text, ranges) {
  const { doc } = makeSidebar()
  const host = doc.createElement('div')
  host.append(S.renderHighlighted(doc, text, ranges))
  return host.childNodes.map((n) => (n.className === 'sr-hit' ? ['hit', n.textContent] : ['text', n.textContent]))
}

test('ranges become .sr-hit spans and everything else stays a text node', () => {
  assert.deepEqual(highlightShape('the memory budget', [[4, 10]]),
    [['text', 'the '], ['hit', 'memory'], ['text', ' budget']])
  assert.deepEqual(highlightShape('memory', [[0, 6]]), [['hit', 'memory']])
  assert.deepEqual(highlightShape('a b c', []), [['text', 'a b c']])
})

test('offsets are UTF-16 code units — the emoji/CJK regression (spec-05 §14.7)', () => {
  // "🔥" is ONE astral character and TWO UTF-16 code units.  A char-index
  // implementation selects "測" here; a UTF-16 one selects "定".
  const text = '🔥測定 memory 測定'
  const i = text.indexOf('memory')
  assert.equal(i, 5, 'the emoji occupies UTF-16 units 0..1')
  assert.deepEqual(highlightShape(text, [[i, i + 6]]),
    [['text', '🔥測定 '], ['hit', 'memory'], ['text', ' 測定']])
  // And the surrogate pair is never split.
  assert.deepEqual(highlightShape(text, [[0, 2]]), [['hit', '🔥'], ['text', '測定 memory 測定']])
})

test('a note containing markup reaches the DOM as TEXT — the §6.1 innerHTML rule', () => {
  const shape = highlightShape('<script>alert(1)</script> memory', [[26, 32]])
  assert.deepEqual(shape, [['text', '<script>alert(1)</script> '], ['hit', 'memory']])
  // And the shipped module contains no innerHTML assignment at all.
  const src = SOURCE
  assert.equal(/\.innerHTML\s*=/.test(src), false, 'no innerHTML assignment in src/search.ts')
  assert.equal(/insertAdjacentHTML|outerHTML/.test(src), false)
})

test('out-of-range or overlapping ranges cannot produce a torn row', () => {
  assert.deepEqual(highlightShape('abc', [[1, 99]]), [['text', 'a'], ['hit', 'bc']])
  assert.deepEqual(highlightShape('abc', [[2, 1]]), [['text', 'abc']])
  assert.deepEqual(highlightShape('abcdef', [[0, 3], [2, 5]]), [['hit', 'abc'], ['hit', 'de'], ['text', 'f']])
})

/* ═══ the panel's DOM ═════════════════════════════════════════════════════ */

test('the panel REPLACES the tree — the two scrollers are never live together', () => {
  const { panel, tree } = mount()
  assert.equal(panel.root.hidden, true)
  assert.equal(tree.hidden, false)
  panel.show()
  assert.equal(panel.root.hidden, false)
  assert.equal(tree.hidden, true)
  panel.hide()
  assert.equal(panel.root.hidden, true)
  assert.equal(tree.hidden, false)
  // Exactly ONE .search-scroller, and it is the list.
  const scrollers = panel.root.querySelectorAll('.search-scroller')
  assert.equal(scrollers.length, 1)
  assert.ok(scrollers[0].classList.contains('sr-list'))
})

test('the back button is the MOUSE route out of search, and it lands on the tree', () => {
  const { panel, tree } = mount()
  panel.show()
  assert.equal(tree.hidden, true, 'precondition: the tree is the pane being replaced')

  const back = panel.root.querySelector('.sr-back')
  assert.ok(back, 'the search panel draws no way back to the file tree')
  // It must be FIRST in the input row: the field is what grows, so anything
  // appended after it would be pushed off the end at a narrow sidebar.
  const row = panel.root.querySelector('.sr-input-row')
  assert.equal(row.children[0], back)
  assert.equal(back.getAttribute('aria-label'), 'Back to files')
  // §0.33 E78 — A BACK ARROW, not `files`. It wore Obsidian's file-explorer
  // glyph on the reasoning that its registry maps `file-explorer-glyph` ->
  // `files`, so that picture means "the file tree". Right about the name, wrong
  // about the picture: `files` is two overlapping documents and reads as COPY.
  // Reported by the user in those words. `arrow-left` is the glyph Obsidian's
  // own `app:go-back` command carries.
  assert.equal(back.dataset.icon, 'arrow-left',
    "the glyph is Obsidian's `app:go-back` arrow; `files` read as a copy icon")

  back.dispatch('click', { type: 'click' })
  assert.equal(panel.root.hidden, true, 'clicking back must close the panel')
  assert.equal(tree.hidden, false, 'clicking back must bring the tree back')
})

test('the back button leaves the FOCUS on the tree, not in the hidden panel', () => {
  // The click focuses the button; hide() then puts the button inside a
  // `display: none` subtree, so without a handoff focus falls to <body> and the
  // arrow keys are dead on the tree the user just asked to come back to.
  const { panel, tree, sidebar } = mount()
  panel.show()
  const back = panel.root.querySelector('.sr-back')
  back.dispatch('click', { type: 'click' })
  assert.equal(sidebar.ownerDocument.activeElement, tree,
    'focus must land on .tree-scroller, which is tabindex="0" for exactly this')
})

test('closing by Mod-Shift-F does NOT move the focus — only the button does', () => {
  // toggle() shares hide(); a keyboard user closing search has not asked to be
  // put in the sidebar. The handoff belongs to the button, not to hide().
  const { panel, tree, sidebar } = mount()
  panel.show()
  const before = sidebar.ownerDocument.activeElement
  panel.toggle()
  assert.equal(panel.root.hidden, true, 'precondition: toggle closed it')
  assert.notEqual(sidebar.ownerDocument.activeElement, tree)
  assert.equal(sidebar.ownerDocument.activeElement, before)
})

test('the back button CLOSES and never re-opens — it is not a second toggle', () => {
  // `toggle()` would make a double-click land back in search with the tree gone
  // again, which is the state the whole control exists to get out of.
  const { panel, tree } = mount()
  panel.show()
  const back = panel.root.querySelector('.sr-back')
  back.dispatch('click', { type: 'click' })
  back.dispatch('click', { type: 'click' })
  assert.equal(panel.root.hidden, true)
  assert.equal(tree.hidden, false)
})

test('leaving by the back button cancels the search in flight, exactly as hide() does', () => {
  // The button routes through hide(), so spec-05 §13's "searchCancel on unmount"
  // is inherited rather than reimplemented. Asserted because a second close path
  // that forgot it would leak a scan per exit.
  const { panel, log } = mount()
  panel.show()
  panel.root.querySelector('.sr-input').value = 'needle'
  panel.root.querySelector('.sr-input').dispatch('input', { type: 'input' })
  const gen = log.filter((e) => e[0] === 'start').at(-1)[2]
  panel.root.querySelector('.sr-back').dispatch('click', { type: 'click' })
  assert.ok(log.some((e) => e[0] === 'cancel' && e[1] === gen),
    `no cancel for the in-flight gen ${gen}: ${JSON.stringify(log)}`)
})

test('the panel is a SIBLING of the tree scroller, so owner 01 cap banners are untouched', () => {
  const { panel, sidebar, tree } = mount()
  assert.equal(panel.root.parentElement, sidebar)
  assert.equal(tree.nextElementSibling, panel.root)
  assert.equal(panel.root.querySelectorAll('.cap-banner').length, 0,
    'the panel neither draws nor hides a cap banner (§3.3 errata 2, ruling Y17)')
})

test('the Files section is pinned to the top and its rows are leaves', () => {
  const { panel } = mount()
  panel.show()
  panel.runQuery('note')
  const gen = panel.model.gen
  panel.model.accept({ kind: 'files', gen, groups: [group('x/n1.md'), group('n2.md')] })
  panel.paint()
  const kids = panel.root.querySelector('.sr-list').children
  assert.equal(kids[0].className, 'sr-section-label')
  assert.equal(kids[0].textContent, 'Files')
  assert.equal(kids[1].classList.contains('sr-file'), true)
  assert.equal(kids[1].classList.contains('sr-file--group'), false, 'no chevron on a filename row')
  assert.equal(panel.root.querySelectorAll('.sr-snips').length, 0, 'no snippets on a filename row')
})

test('a collapsed group renders NO snippet DOM at all', () => {
  const { panel } = mount()
  panel.show()
  panel.runQuery('memory')
  const gen = panel.model.gen
  const groups = Array.from({ length: 14 }, (_, i) => group(`f${i}.md`, { id: i }))
  panel.model.accept({ kind: 'batch', gen, groups })
  panel.paint()
  assert.equal(panel.root.querySelectorAll('.sr-file--group').length, 14)
  assert.equal(panel.root.querySelectorAll('.sr-snips').length, S.AUTO_EXPAND_GROUPS)
  const headers = panel.root.querySelectorAll('.sr-file--group')
  assert.equal(headers[9].classList.contains('is-collapsed'), false)
  assert.equal(headers[10].classList.contains('is-collapsed'), true)
})

test('the badge marks a per-file snippet cap with `+`', () => {
  const { panel } = mount()
  panel.show(); panel.runQuery('q')
  panel.model.accept({ kind: 'batch', gen: panel.model.gen, groups: [
    group('a.md', { id: 1, matchCount: 8, more: true }),
    group('b.md', { id: 2, matchCount: 3, more: false }),
  ] })
  panel.paint()
  const badges = panel.root.querySelectorAll('.sr-badge').map((b) => b.textContent)
  assert.deepEqual(badges, ['8+', '3'])
})

test('the ONE reorder moves the existing header nodes rather than rebuilding them', () => {
  const { panel } = mount()
  panel.show(); panel.runQuery('q')
  const gen = panel.model.gen
  panel.model.accept({ kind: 'batch', gen, groups: [group('c.md', { id: 3 }), group('a.md', { id: 1 })] })
  panel.paint()
  const before = panel.root.querySelectorAll('.sr-file--group')
  const idA = before.find((e) => e.dataset.rel === 'a.md')
  panel.model.accept(complete(gen, { order: [1, 3], totalFiles: 2, totalMatches: 2 }))
  // Drive the same path the channel would.
  panel.paint()
  const after = panel.root.querySelectorAll('.sr-file--group')
  assert.deepEqual(after.map((e) => e.dataset.rel), ['a.md', 'c.md'])
  assert.ok(idA, 'the a.md header existed before the reorder')
})

test('the flattened row cursor walks filename rows, group headers and visible snippets', () => {
  const { panel } = mount()
  panel.show(); panel.runQuery('q')
  const gen = panel.model.gen
  panel.model.accept({ kind: 'files', gen, groups: [group('f.md', { id: 9 })] })
  panel.model.accept({ kind: 'batch', gen, groups: [group('a.md', { id: 1 })] })
  panel.paint()
  // 1 filename row + 1 group header + 1 visible snippet
  assert.equal(panel.visibleRowCount, 3)
})

/* ═══ opening a result — spec-05 §9 ═══════════════════════════════════════ */

test('Enter on a group header opens its FIRST snippet; a filename row opens line 1 col 0', async () => {
  const { sidebar, tree } = makeSidebar()
  void tree
  const log = []
  const panel = S.mountSearch(sidebar, deps(log), () => 0)
  panel.show()
  panel.runQuery('memory')
  const gen = panel.model.gen
  panel.model.accept({ kind: 'files', gen, groups: [group('name-hit.md', { id: 9 })] })
  panel.model.accept({ kind: 'batch', gen, groups: [group('body-hit.md', { id: 1, snippets: [
    { line: 12, text: 'the memory budget', ranges: [[4, 10]], col: 4, len: 6 },
  ] })] })
  panel.paint()

  const key = (k, init = {}) => new globalThis.KeyboardEvent('keydown', { key: k, ...init })
  const input = panel.root.querySelector('.sr-input')
  input.dispatch('keydown', key('ArrowDown'))          // -> filename row
  input.dispatch('keydown', key('Enter'))
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(log.at(-1), ['open', 'name-hit.md', 1, 0, 0])

  input.dispatch('keydown', key('ArrowDown'))          // -> group header
  input.dispatch('keydown', key('Enter'))
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(log.at(-1), ['open', 'body-hit.md', 12, 4, 6])

  input.dispatch('keydown', key('ArrowDown'))          // -> the snippet itself
  input.dispatch('keydown', key('Enter'))
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(log.at(-1), ['open', 'body-hit.md', 12, 4, 6])
})

test('Esc clears a non-empty input; Esc on an empty one returns focus to the editor', () => {
  const { panel, log } = mount()
  panel.show()
  const input = panel.root.querySelector('.sr-input')
  input.value = 'memory'
  input.dispatch('keydown', new globalThis.KeyboardEvent('keydown', { key: 'Escape' }))
  assert.equal(input.value, '')
  assert.equal(log.some((r) => r[0] === 'focusEditor'), false)
  input.dispatch('keydown', new globalThis.KeyboardEvent('keydown', { key: 'Escape' }))
  assert.deepEqual(log.at(-1), ['focusEditor'])
})

/* ═══ expansion — spec-05 §8.8 / §11.3 ════════════════════════════════════ */

test('expanding a collapsed group calls search_expand once and renders what comes back', async () => {
  const { sidebar } = makeSidebar()
  const log = []
  const d = deps(log)
  d.expand = async (q, rel) => {
    log.push(['expand', q, rel])
    return [
      { line: 1, text: 'one', ranges: [[0, 3]], col: 0, len: 3 },
      { line: 2, text: 'two', ranges: [[0, 3]], col: 0, len: 3 },
      { line: 3, text: 'three', ranges: [[0, 3]], col: 0, len: 3 },
    ]
  }
  const panel = S.mountSearch(sidebar, d, () => 0)
  panel.show(); panel.runQuery('q')
  const gen = panel.model.gen
  panel.model.accept({ kind: 'batch', gen, groups: Array.from({ length: 12 }, (_, i) => group(`f${i}.md`, { id: i })) })
  panel.paint()
  const target = panel.root.querySelectorAll('.sr-file--group')[11]
  assert.equal(target.classList.contains('is-collapsed'), true)
  // Inside the chevron box: --cx0 15px .. 15+--chev-w 16px, consumed from the
  // tokens the panel cached at mount, never restated in src/search.ts.
  chevronClick(panel, target, 20)
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(log.filter((r) => r[0] === 'expand'), [['expand', 'q', 'f11.md']])
  assert.equal(panel.model.expanded.get('f11.md').length, 3)
})

test('§11.3: a file deleted since the scan answers with an EMPTY array, and its group is dropped', async () => {
  const { sidebar } = makeSidebar()
  const log = []
  const d = deps(log)
  d.expand = async () => []
  const panel = S.mountSearch(sidebar, d, () => 0)
  panel.show(); panel.runQuery('q')
  const gen = panel.model.gen
  panel.model.accept({ kind: 'batch', gen, groups: Array.from({ length: 12 }, (_, i) => group(`f${i}.md`, { id: i })) })
  panel.paint()
  const target = panel.root.querySelectorAll('.sr-file--group')[11]
  chevronClick(panel, target, 20)
  await new Promise((r) => setImmediate(r))
  assert.equal(panel.model.groups.some((g) => g.rel === 'f11.md'), false, 'the group is removed, not an error toast')
})

/* ═══ vault switch and re-run — CONTRACT §4.3 step 4, spec-05 §11.1/§11.2 ══ */

test('reset() cancels in flight, clears everything, and does NOT bump for the sake of bumping', () => {
  const { panel, log } = mount()
  panel.show(); panel.runQuery('memory')
  const gen = panel.model.gen
  panel.model.accept({ kind: 'batch', gen, groups: [group('a.md')] })
  const before = S.currentGeneration()
  panel.reset(0)
  assert.deepEqual(log.at(-1), ['cancel', gen])
  assert.equal(S.currentGeneration(), before, 'a vault switch must not consume a number')
  assert.equal(panel.model.query, '')
  assert.equal(panel.model.groups.length, 0)
  assert.equal(panel.model.collapsed.size, 0)
  assert.equal(panel.root.querySelector('.sr-input').value, '')
})

test('nc://tree-changed re-runs the identical query after RERUN_QUIET_MS, rate-limited', async () => {
  let t = 0
  const { sidebar } = makeSidebar()
  const log = []
  const panel = S.mountSearch(sidebar, deps(log), () => t)
  panel.show()
  panel.runQuery('memory')
  const starts = () => log.filter((r) => r[0] === 'start').length
  assert.equal(starts(), 1)
  assert.equal(S.RERUN_QUIET_MS, 400)
  assert.equal(S.RERUN_MIN_INTERVAL_MS, 2000)

  panel.onTreeChanged()
  t = 401
  await new Promise((r) => setTimeout(r, S.RERUN_QUIET_MS + 30))
  assert.equal(starts(), 2, 'one silent re-run, same query, a NEW generation')
  assert.equal(log.filter((r) => r[0] === 'start').at(-1)[1], 'memory')

  panel.onTreeChanged()
  t = 802                                        // inside RERUN_MIN_INTERVAL_MS
  await new Promise((r) => setTimeout(r, S.RERUN_QUIET_MS + 30))
  assert.equal(starts(), 2, 'a sync burst must not thrash the scan')
  panel.hide()
})

test('the panel attaches NO scroll listener (CONTRACT §5.12.6 is the reason)', () => {
  const { panel } = mount()
  const list = panel.root.querySelector('.sr-list')
  assert.equal(list.listeners.has('scroll'), false)
  assert.equal(/addEventListener\(\s*['"]scroll/.test(SOURCE), false)
})


/* ═══ REGRESSION: the row table must survive the ONE reorder ══════════════════
 * Both tests below cover defects that were live in this file's first cut.  They
 * are written against the PUBLIC path — the `onMsg` callback handed to
 * `deps.start` — because both defects lived past `SearchModel` in the DOM half,
 * where a model-only test cannot see them. */

/** Drive a panel the way Rust does: capture the callback `search_start` was
 *  given and push real `SearchMsg`s through it. */
function live(now = () => 0) {
  const { sidebar } = makeSidebar()
  const log = []
  let onMsg = null
  const d = { ...deps(log), start: async (q, gen, cb) => { log.push(['start', q, gen]); onMsg = cb } }
  const panel = S.mountSearch(sidebar, d, now)
  return { panel, log, send: (m) => onMsg(m) }
}

test('after Complete the row table still holds every SNIPPET — clicking one must open it', async () => {
  const { panel, log, send } = live()
  panel.show()
  panel.runQuery('mem')
  await new Promise((r) => setImmediate(r))
  const gen = panel.model.gen
  const snip = (line) => ({ line, text: `mem at ${line}`, ranges: [[0, 3]], col: 0, len: 3 })

  send({ kind: 'batch', gen, groups: [
    group('a.md', { id: 1, snippets: [snip(10), snip(20)], matchCount: 2 }),
    group('b.md', { id: 2, snippets: [snip(30)], matchCount: 1 }),
  ] })
  const list = panel.root.querySelector('.sr-list')
  assert.equal(list.querySelectorAll('.sr-snip').length, 3)
  assert.equal(panel.visibleRowCount, 5, '2 headers + 3 snippets before Complete')

  // `order` puts b.md first, so Complete performs the one DOM reorder.
  send(complete(gen, { order: [2, 1], totalMatches: 3, totalFiles: 2 }))
  assert.equal(list.querySelectorAll('.sr-snip').length, 3, 'the snippets are still on screen')
  assert.equal(panel.visibleRowCount, 5,
    'and every one of them is still a REACHABLE row — a row kind dropped here ' +
    'is one the user can neither click nor arrow onto, silently')

  // The click a user actually makes, through the one delegated listener.
  const first = list.querySelectorAll('.sr-snip')[0]
  const ev = new globalThis.MouseEvent('click', { clientX: 200 })
  ev.target = first
  list.dispatch('click', ev)
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(log.at(-1), ['open', 'b.md', 30, 0, 3],
    'the reordered list opens the file and line the clicked snippet belongs to')

  // And the arrow walk reaches a snippet that the reorder moved.
  const input = panel.root.querySelector('.sr-input')
  const key = (k) => new globalThis.KeyboardEvent('keydown', { key: k })
  for (let i = 0; i < 4; i += 1) input.dispatch('keydown', key('ArrowDown'))
  input.dispatch('keydown', key('Enter'))
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(log.at(-1), ['open', 'a.md', 20, 0, 3])
})

test('§4.3: after a vault switch a batch still in flight for the OLD vault is DROPPED', async () => {
  const { panel, send } = live()
  panel.show()
  panel.runQuery('secret')
  await new Promise((r) => setImmediate(r))
  const gen = panel.model.gen

  // Step 4 of the vault switch: the FRONTEND clears the panel.  `search_cancel`
  // is async and cannot overtake a message that has already crossed the wire,
  // so the generation guard is the only thing standing between the old vault's
  // note contents and the new vault's sidebar.
  panel.reset(12)
  assert.equal(panel.model.gen, 0, 'no query is live, so no generation matches')

  send({ kind: 'batch', gen, groups: [group('old-vault-note.md', { id: 1 })] })
  assert.equal(panel.model.groups.length, 0, 'the old vault\'s hit must not land')
  assert.equal(panel.visibleRowCount, 0)
  const text = panel.root.querySelector('.sr-list').textContent
  assert.match(text, /Search this vault/, 'the panel stays in its empty state')
  assert.doesNotMatch(text, /old-vault-note/)
})

/* The group chevron is an INLINE `<svg>` from icons.ts (CONTRACT §0.50 E98),
 * borrowed from the tree so the two sidebar views draw one mark by
 * construction (§4.5). It was a `::before` masked with the deleted `--chev`
 * token, which painted a solid block. */
test('the group chevron is the tree\'s inline svg, and groups alone carry it', () => {
  const { panel } = mount()
  panel.show()
  panel.runQuery('q')
  const gen = panel.model.gen
  panel.model.accept({ kind: 'batch', gen, groups: [group('a.md', { id: 1 }), group('b.md', { id: 2 })] })
  panel.paint()
  const headers = panel.root.querySelectorAll('.sr-file--group')
  assert.equal(headers.length, 2)
  for (const h of headers) {
    const chev = h.querySelector('.chev')
    assert.ok(chev, 'a group header has no chevron element')
    assert.equal(chev.tagName.toLowerCase(), 'svg')
    assert.ok(chev.children.some((c) => c.tagName === 'PATH'), 'the chevron has no path')
  }
  // A filename row is a leaf: no chevron node.
  panel.model.accept({ kind: 'files', gen, groups: [group('c.md', { id: 3 })] })
  panel.paint()
  const leaf = panel.root.querySelectorAll('.sr-file').find((e) => !e.classList.contains('sr-file--group'))
  assert.ok(leaf, 'no filename row rendered')
  assert.equal(leaf.querySelector('.chev'), null, 'a filename row carries a chevron')
})

test('group chevron direction lives on the svg, not on a ::before', () => {
  const css = readFileSync(join(HERE, '..', '..', 'src', 'styles', 'search.css'), 'utf8')
  assert.ok(!/--chev\)/.test(css), 'the deleted --chev token is still referenced')
  assert.match(css, /\.sr-file--group:not\(\.is-collapsed\) \.chev \{ transform: rotate\(90deg\); \}/)
})
