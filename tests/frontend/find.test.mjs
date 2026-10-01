// Owner: 03 (in-note find — src/find.ts).
// `node --test tests/frontend/find.test.mjs`.
//
// Spec: KNOWN-ISSUES.md X-13 (first bullet — Obsidian's Mod-F finds inside the
// open note); note viewer ONLY (never the Memoir page, which is a plain
// textarea outside the editor).
//
// `src/find.ts` is TypeScript and esbuild is the project's only transpiler
// (CONTRACT §6.3), so this file bundles the module to ESM in a temp dir and
// imports that.  No new dependency, and the code under test is the shipped code.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'
import { installGlobals, ADocument } from './_minidom.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const SRC = join(HERE, '..', '..', 'src', 'find.ts')

installGlobals()

const out = mkdtempSync(join(tmpdir(), 'cairn-find-'))
await esbuild.build({
  entryPoints: [SRC], bundle: true, format: 'esm', platform: 'neutral',
  target: 'es2021', outfile: join(out, 'find.mjs'), logLevel: 'silent',
})
const F = await import(join(out, 'find.mjs'))
process.on('exit', () => { try { rmSync(out, { recursive: true, force: true }) } catch {} })

/* The REAL decoration set, headless: `src/editor.ts` imports cleanly under
 * node (verified — no DOM at module scope), and `EditorState` needs no
 * layout.  This is the shipped field answering with the shipped matcher.
 *
 * ONE bundle for both, deliberately: `EditorState` must be the SAME module
 * instance the fields were defined against, or the extension set rejects them
 * ("multiple instances of @codemirror/state"). */
const outEd = mkdtempSync(join(tmpdir(), 'cairn-find-ed-'))
await esbuild.build({
  stdin: {
    contents: `export * from './src/editor.ts'\nexport { EditorState } from '@codemirror/state'\n`,
    resolveDir: join(HERE, '..', '..'),
    loader: 'ts',
  },
  bundle: true, format: 'esm', platform: 'neutral',
  target: 'es2021', outfile: join(outEd, 'ed.mjs'), logLevel: 'silent',
})
const ED = await import(join(outEd, 'ed.mjs'))
process.on('exit', () => { try { rmSync(outEd, { recursive: true, force: true }) } catch {} })

/** Every mark in `state`'s find layer, as [from, to, class]. */
function marksOf(state) {
  const out = []
  state.field(ED.findHighlightDeco).between(0, state.doc.length, (from, to, v) => {
    out.push([from, to, v.spec.class])
  })
  return out
}

function stateWith(doc, spec = { query: '', caseSensitive: false, from: -1, to: -1 }) {
  let s = ED.EditorState.create({ doc, extensions: [ED.findSpecField, ED.findHighlightDeco] })
  if (spec.query !== '') s = s.update({ effects: ED.setFindHighlight.of(spec) }).state
  return s
}

const SOURCE = readFileSync(SRC, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

/* ── fixtures ─────────────────────────────────────────────────────────────── */

function fixture(text = 'hello world, hello cairn', selection = '') {
  const doc = new ADocument()
  const listeners = new Map()
  doc.addEventListener = (t, fn) => {
    if (!listeners.has(t)) listeners.set(t, [])
    listeners.get(t).push(fn)
  }
  doc.removeEventListener = (t, fn) => {
    const l = listeners.get(t) ?? []
    const i = l.indexOf(fn)
    if (i >= 0) l.splice(i, 1)
  }
  doc.fire = (t, ev) => { for (const fn of [...(listeners.get(t) ?? [])]) fn(ev) }
  const pane = doc.createElement('main')
  pane.className = 'editor'
  const log = []
  let docCb = null
  const deps = {
    text,
    getText: () => deps.text,
    getSelection: () => selection,
    reveal: (from, to) => { log.push(['reveal', from, to]) },
    setHighlight: (query, caseSensitive, from, to) => { log.push(['highlight', query, caseSensitive, from, to]) },
    focusEditor: () => { log.push(['focusEditor']) },
    onDocChanged: (cb) => { docCb = cb; return () => { docCb = null } },
  }
  const panel = F.mountFind(pane, deps)
  return { doc, pane, panel, deps, log, fireDoc: () => docCb?.() }
}

function key(k, init = {}) {
  return new globalThis.KeyboardEvent('keydown', { key: k, ...init })
}

/* ── pure matching ────────────────────────────────────────────────────────── */

test('empty query matches nothing and is not truncated', () => {
  assert.deepEqual(F.findMatches('hello', '', false), { matches: [], truncated: false })
})

test('matching is a case-insensitive plain substring', () => {
  const { matches, truncated } = F.findMatches('Hello HELLO hello', 'hello', false)
  assert.equal(truncated, false)
  assert.deepEqual(matches, [{ from: 0, to: 5 }, { from: 6, to: 11 }, { from: 12, to: 17 }])
})

test('case-sensitive mode keeps case', () => {
  const { matches } = F.findMatches('Hello HELLO hello', 'HELLO', true)
  assert.deepEqual(matches, [{ from: 6, to: 11 }])
  const lower = F.findMatches('Hello HELLO hello', 'hello', true)
  assert.deepEqual(lower.matches, [{ from: 12, to: 17 }])
})

test('matches are non-overlapping', () => {
  assert.deepEqual(F.findMatches('aaa', 'aa', false).matches, [{ from: 0, to: 2 }])
})

test('matches are UTF-16 offsets, like the editor', () => {
  const text = '🔥 hello'
  const i = text.indexOf('hello')
  assert.equal(i, 3)
  assert.deepEqual(F.findMatches(text, 'hello', false).matches, [{ from: 3, to: 8 }])
})

test('markup in the note is just text — no regex, no parsing', () => {
  assert.deepEqual(F.findMatches('<script>hi</script>', '<script>', false).matches,
    [{ from: 0, to: 8 }])
})

test('matches are capped at MAX_FIND_MATCHES and report truncation', () => {
  assert.equal(F.MAX_FIND_MATCHES, 2000)
  const text = 'a '.repeat(3000)
  const r = F.findMatches(text, 'a', false)
  assert.equal(r.matches.length, 2000)
  assert.equal(r.truncated, true)
  const small = F.findMatches('a a a', 'a', false)
  assert.equal(small.truncated, false)
})

/* ── the model ────────────────────────────────────────────────────────────── */

test('the model starts at the first match and wraps on next/prev', () => {
  const m = new F.FindModel()
  m.recompute('a a a', 'a', false)
  assert.equal(m.index, 0)
  assert.deepEqual(m.current(), { from: 0, to: 1 })
  m.next()
  assert.deepEqual(m.current(), { from: 2, to: 3 })
  m.next()
  assert.deepEqual(m.current(), { from: 4, to: 5 })
  m.next()
  assert.deepEqual(m.current(), { from: 0, to: 1 }, 'next wraps')
  m.prev()
  assert.deepEqual(m.current(), { from: 4, to: 5 }, 'prev wraps')
})

test('the count line: empty, none, and current/total', () => {
  const m = new F.FindModel()
  assert.equal(m.countText(), '')
  m.recompute('hello', 'zzz', false)
  assert.equal(m.countText(), 'No results')
  m.recompute('a a a', 'a', false)
  assert.equal(m.countText(), '1/3')
  m.next()
  assert.equal(m.countText(), '2/3')
})

test('a truncated search marks the total with +', () => {
  const m = new F.FindModel()
  m.recompute('a '.repeat(3000), 'a', false)
  assert.equal(m.matches.length, 2000)
  assert.match(m.countText(), /^1\/2,000\+$/)
})

test('an empty query clears the model', () => {
  const m = new F.FindModel()
  m.recompute('hello', 'hello', false)
  assert.equal(m.matches.length, 1)
  m.recompute('hello', '', false)
  assert.equal(m.matches.length, 0)
  assert.equal(m.index, -1)
  assert.equal(m.countText(), '')
})

/* ── the panel ────────────────────────────────────────────────────────────── */

test('the bar starts hidden and show() focuses the field', () => {
  const { panel, pane } = fixture()
  assert.equal(panel.root.hidden, true)
  assert.equal(panel.isOpen, false)
  assert.ok(panel.root.classList.contains('find-bar'))
  assert.equal(panel.root.parentElement, pane)
  panel.show()
  assert.equal(panel.root.hidden, false)
  assert.equal(panel.isOpen, true)
})

test('show() with no note refuses — the panel never opens over nothing', () => {
  const { panel, deps } = fixture()
  deps.text = null
  // getText() null means no note open (or secret mode).
  deps.getText = () => null
  assert.equal(panel.show(), false)
  assert.equal(panel.isOpen, false)
})

test('show() prefills from the editor selection', () => {
  const { panel } = fixture('hello world', 'world')
  panel.show()
  const input = panel.root.querySelector('.find-input')
  assert.equal(input.value, 'world')
  assert.equal(panel.model.query, 'world')
  assert.equal(panel.model.countText(), '1/1')
})

test('typing reveals the first match and updates the count', () => {
  const { panel, log } = fixture('hello world, hello cairn')
  panel.show()
  const input = panel.root.querySelector('.find-input')
  input.value = 'hello'
  input.dispatch('input', { type: 'input' })
  assert.equal(panel.model.countText(), '1/2')
  assert.deepEqual(log.at(-1), ['reveal', 0, 5])
})

test('Enter steps forward, Shift+Enter steps back', () => {
  const { panel, log } = fixture('a a a')
  panel.show()
  const input = panel.root.querySelector('.find-input')
  input.value = 'a'
  input.dispatch('input', { type: 'input' })
  assert.deepEqual(log.at(-1), ['reveal', 0, 1])
  input.dispatch('keydown', key('Enter'))
  assert.deepEqual(log.at(-1), ['reveal', 2, 3])
  input.dispatch('keydown', key('Enter'))
  assert.deepEqual(log.at(-1), ['reveal', 4, 5])
  input.dispatch('keydown', key('Enter'))
  assert.deepEqual(log.at(-1), ['reveal', 0, 1], 'wraps')
  input.dispatch('keydown', key('Enter', { shiftKey: true }))
  assert.deepEqual(log.at(-1), ['reveal', 4, 5])
})

test('the Prev/Next buttons step without needing the keyboard', () => {
  const { panel, log } = fixture('a a a')
  panel.show()
  const input = panel.root.querySelector('.find-input')
  input.value = 'a'
  input.dispatch('input', { type: 'input' })
  const btns = panel.root.querySelectorAll('.find-btn')
  const next = btns.find((b) => b.getAttribute('aria-label') === 'Next match')
  const prev = btns.find((b) => b.getAttribute('aria-label') === 'Previous match')
  next.dispatch('click', { type: 'click' })
  assert.deepEqual(log.at(-1), ['reveal', 2, 3])
  prev.dispatch('click', { type: 'click' })
  assert.deepEqual(log.at(-1), ['reveal', 0, 1])
})

test('Esc closes the bar and returns focus to the note', () => {
  const { panel, log } = fixture('hello')
  panel.show()
  const input = panel.root.querySelector('.find-input')
  input.value = 'hello'
  input.dispatch('input', { type: 'input' })
  input.dispatch('keydown', key('Escape'))
  assert.equal(panel.isOpen, false)
  assert.deepEqual(log.at(-1), ['focusEditor'])
})

test('the close button is the mouse route out', () => {
  const { panel, log } = fixture('hello')
  panel.show()
  const btns = panel.root.querySelectorAll('.find-btn')
  const close = btns.find((b) => b.getAttribute('aria-label') === 'Close find')
  close.dispatch('click', { type: 'click' })
  assert.equal(panel.isOpen, false)
  assert.deepEqual(log.at(-1), ['focusEditor'])
})

test('toggle() opens, and a second toggle refocuses instead of closing', () => {
  const { panel } = fixture('hello')
  panel.toggle()
  assert.equal(panel.isOpen, true)
  // The bar open with the caret in the note: Mod-F must hand the focus BACK,
  // not dismiss the bar it just opened.
  panel.toggle()
  assert.equal(panel.isOpen, true)
})

test('show() on an open bar keeps the match index', () => {
  const { panel } = fixture('a a a')
  panel.show()
  const input = panel.root.querySelector('.find-input')
  input.value = 'a'
  input.dispatch('input', { type: 'input' })
  panel.model.next()
  panel.model.next()
  assert.equal(panel.model.countText(), '3/3')
  panel.show()
  assert.equal(panel.model.countText(), '3/3')
})

test('hide() is the programmatic close: no focus change', () => {
  const { panel, log } = fixture('hello')
  panel.show()
  log.length = 0
  panel.hide()
  assert.equal(panel.isOpen, false)
  assert.equal(log.some((r) => r[0] === 'focusEditor'), false)
})

test('the Aa toggle re-runs the query case-sensitively', () => {
  const { panel } = fixture('Hello hello')
  panel.show()
  const input = panel.root.querySelector('.find-input')
  input.value = 'hello'
  input.dispatch('input', { type: 'input' })
  assert.equal(panel.model.matches.length, 2)
  const btns = panel.root.querySelectorAll('.find-btn')
  const cs = btns.find((b) => b.getAttribute('aria-label') === 'Case sensitive')
  cs.dispatch('click', { type: 'click' })
  assert.equal(cs.getAttribute('aria-pressed'), 'true')
  assert.equal(panel.model.matches.length, 1)
  assert.deepEqual(panel.model.current(), { from: 6, to: 11 })
})

test('an editor edit under an open bar updates the count and keeps the index', async () => {
  const { panel, deps, fireDoc } = fixture('a a a')
  panel.show()
  const input = panel.root.querySelector('.find-input')
  input.value = 'a'
  input.dispatch('input', { type: 'input' })
  panel.model.next()
  assert.equal(panel.model.countText(), '2/3')
  deps.text = 'a a a a'
  fireDoc()
  assert.equal(panel.model.countText(), '2/4')
})

test('no match reports No results and reveals nothing', () => {
  const { panel, log } = fixture('hello')
  panel.show()
  const input = panel.root.querySelector('.find-input')
  input.value = 'zzz'
  input.dispatch('input', { type: 'input' })
  assert.equal(panel.model.countText(), 'No results')
  assert.equal(log.some((r) => r[0] === 'reveal'), false, 'nothing to reveal')
})

test('every recompute mirrors the model into the mark layer', () => {
  const { panel, log } = fixture('hello world, hello cairn')
  panel.show()
  const input = panel.root.querySelector('.find-input')
  input.value = 'hello'
  input.dispatch('input', { type: 'input' })
  assert.deepEqual(log.at(-1), ['reveal', 0, 5])
  assert.deepEqual(log.filter((r) => r[0] === 'highlight').at(-1),
    ['highlight', 'hello', false, 0, 5])
  input.dispatch('keydown', key('Enter'))
  assert.deepEqual(log.filter((r) => r[0] === 'highlight').at(-1),
    ['highlight', 'hello', false, 13, 18])
})

test('hiding the bar clears the mark layer', () => {
  const { panel, log } = fixture('hello')
  panel.show()
  const input = panel.root.querySelector('.find-input')
  input.value = 'hello'
  input.dispatch('input', { type: 'input' })
  panel.hide()
  assert.deepEqual(log.at(-1), ['highlight', '', false, -1, -1])
})

test('closing wipes the query — reopening starts empty, never cached', () => {
  const { panel } = fixture('hello world')
  panel.show()
  const input = panel.root.querySelector('.find-input')
  input.value = 'hello'
  input.dispatch('input', { type: 'input' })
  assert.equal(panel.model.query, 'hello')
  panel.close()
  assert.equal(input.value, '')
  panel.show()
  assert.equal(input.value, '')
  assert.equal(panel.model.query, '')
  assert.equal(panel.model.countText(), '')
})

test('closing the bar clears the marks and focuses the note', () => {
  const { panel, log } = fixture('hello')
  panel.show()
  panel.root.querySelector('.find-input').value = 'hello'
  panel.root.querySelector('.find-input').dispatch('input', { type: 'input' })
  log.length = 0
  panel.close()
  assert.deepEqual(log, [['highlight', '', false, -1, -1], ['focusEditor']])
})

test('a press outside the bar dismisses it, without stealing focus', () => {
  const { doc, pane, panel, log } = fixture('hello')
  panel.show()
  panel.root.querySelector('.find-input').value = 'hello'
  panel.root.querySelector('.find-input').dispatch('input', { type: 'input' })
  log.length = 0
  doc.fire('pointerdown', { type: 'pointerdown', target: pane })
  assert.equal(panel.isOpen, false)
  assert.deepEqual(log, [['highlight', '', false, -1, -1]])
  assert.equal(log.some((r) => r[0] === 'focusEditor'), false,
    'focus belongs to wherever the press landed, not the editor by decree')
})

test('a press inside the bar keeps it open', () => {
  const { doc, panel } = fixture('hello')
  panel.show()
  const input = panel.root.querySelector('.find-input')
  doc.fire('pointerdown', { type: 'pointerdown', target: input })
  assert.equal(panel.isOpen, true)
})

test('a press while closed is a no-op', () => {
  const { doc, panel, log } = fixture('hello')
  assert.equal(panel.isOpen, false)
  doc.fire('pointerdown', { type: 'pointerdown', target: null })
  assert.equal(log.length, 0)
})

/* ── source conformance ───────────────────────────────────────────────────── */

test('the shipped module contains no innerHTML assignment at all', () => {
  assert.equal(/\.innerHTML\s*=/.test(SOURCE), false, 'no innerHTML assignment in src/find.ts')
  assert.equal(/insertAdjacentHTML|outerHTML/.test(SOURCE), false)
})

test('the find bar attaches NO scroll listener (CONTRACT §5.12.6 is the reason)', () => {
  assert.equal(/addEventListener\(\s*['"]scroll/.test(SOURCE), false)
})

test('find.css declares no custom property and no scroller', () => {
  const css = readFileSync(join(HERE, '..', '..', 'src', 'styles', 'find.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
  assert.equal(/(^|[;{]\s*)--[a-z0-9-]+\s*:/gim.test(css), false, 'find.css declares a custom property')
  assert.equal(/overflow(-x|-y)?\s*:\s*(auto|scroll|overlay)/.test(css), false, 'find.css declares a scroller')
  assert.equal(/^\s*(transition|animation)\s*:/gm.test(css), false, 'find.css animates')
})

test('the find field takes no focus ring', () => {
  const css = readFileSync(join(HERE, '..', '..', 'src', 'styles', 'find.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
  const focus = /\.find-input:focus\s*\{([^}]*)\}/.exec(css)
  assert.ok(focus, '.find-input:focus is missing')
  assert.equal(/box-shadow/.test(focus[1]), false, 'the find field paints a focus ring')
})

test('the mark classes are styled in find.css', () => {
  const css = readFileSync(join(HERE, '..', '..', 'src', 'styles', 'find.css'), 'utf8')
  assert.match(css, /\.cm-find-match\s*\{[^}]*background:\s*var\(--text-highlight\)/)
  assert.match(css, /\.cm-find-current\s*\{[^}]*background:\s*var\(--highlight-bg\)/)
})

test('the editor owns the mark layer and the panel drives it (no view leak)', () => {
  const editorSrc = readFileSync(join(HERE, '..', '..', 'src', 'editor.ts'), 'utf8')
  // The decoration set lives with the single EditorView, fed by an effect the
  // panel reaches only through deps.setHighlight — find.ts never sees the view.
  assert.match(editorSrc, /export const setFindHighlight = StateEffect\.define/)
  assert.match(editorSrc, /findSpecField,\n  findHighlightDeco,/)
  assert.match(editorSrc, /export function setFindHighlightInView/)
  assert.equal(/from '\.\/editor'/.test(SOURCE), false, 'find.ts reaches into the editor module')
})

/* ── the shipped mark layer, headless ──────────────────────────────────── */

test('an empty query paints no marks', () => {
  assert.deepEqual(marksOf(stateWith('hello world')), [])
})

test('every match is marked and the current one wears its own class', () => {
  const s = stateWith('hello world, hello cairn',
    { query: 'hello', caseSensitive: false, from: 0, to: 5 })
  assert.deepEqual(marksOf(s), [
    [0, 5, 'cm-find-current'],
    [13, 18, 'cm-find-match'],
  ])
})

test('stepping moves the current class to the new match', () => {
  let s = stateWith('a a a', { query: 'a', caseSensitive: false, from: 0, to: 1 })
  s = s.update({ effects: ED.setFindHighlight.of({ query: 'a', caseSensitive: false, from: 2, to: 3 }) }).state
  assert.deepEqual(marksOf(s), [
    [0, 1, 'cm-find-match'],
    [2, 3, 'cm-find-current'],
    [4, 5, 'cm-find-match'],
  ])
})

test('an edit recomputes the marks against the new text', () => {
  let s = stateWith('a a a', { query: 'a', caseSensitive: false, from: 4, to: 5 })
  s = s.update({ changes: { from: 5, insert: ' a' } }).state
  // Recomputed from scratch against the new text; the stale current survives
  // here because [4,5] is still a match — the panel pushes the corrected spec
  // (clamped index) through its own doc-change listener right after.
  assert.deepEqual(marksOf(s), [
    [0, 1, 'cm-find-match'],
    [2, 3, 'cm-find-match'],
    [4, 5, 'cm-find-current'],
    [6, 7, 'cm-find-match'],
  ])
})

test('clearing the query removes every mark', () => {
  let s = stateWith('hello', { query: 'hello', caseSensitive: false, from: 0, to: 5 })
  assert.equal(marksOf(s).length, 1)
  s = s.update({ effects: ED.setFindHighlight.of({ query: '', caseSensitive: false, from: -1, to: -1 }) }).state
  assert.deepEqual(marksOf(s), [])
})
