/**
 * tests/frontend/bookpick.test.mjs — CONTRACT §0.56 E109's word pick and
 * passage, with no DOM.
 *
 * The tokenizer is pinned DIFFERENTIALLY against comart's own regex: every
 * input without a combining mark or a soft hyphen must tokenize exactly as
 * comart does, and the two extensions are pinned case by case.  The passage
 * rules are pinned on synthetic chapters whose expected output is built by
 * hand from the sentence list, not by calling the code under test.
 */

import { strict as assert } from 'node:assert'
import { test, before } from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const SRC = join(ROOT, 'src', 'bookpick.ts')

/** @type {any} */ let M

before(async () => {
  const esbuild = await import(pathToFileURL(join(ROOT, 'node_modules', 'esbuild', 'lib', 'main.js')).href)
  const dir = mkdtempSync(join(tmpdir(), 'cairn-bookpick-'))
  process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })
  const out = join(dir, 'bundle.mjs')
  await esbuild.build({
    stdin: {
      contents: 'export * from ' + JSON.stringify(SRC) + '\n',
      resolveDir: ROOT,
      sourcefile: 'bookpick-test-entry.ts',
      loader: 'ts',
    },
    outfile: out, bundle: true, format: 'esm', platform: 'neutral',
    mainFields: ['module', 'main'], conditions: ['import', 'default'],
    target: 'es2021', absWorkingDir: ROOT, logLevel: 'silent',
  })
  M = await import(pathToFileURL(out).href)
})

/** comart content.js:100, verbatim. */
const COMART_WORD_RE = /[\p{L}\p{N}](?:[\p{L}\p{N}'’\-]*[\p{L}\p{N}])?/gu
const comartWords = (s) => s.match(COMART_WORD_RE) ?? []
const words = (s) => M.wordsIn(s).map((w) => w.text)

/** comart content.js:2592-2609's cut, for the "it would lose the word" case. */
const comartCut = (s) => s.slice(0, 2500)

test("comart's numbers: 8 words, ±5 sentences, 2500 characters", () => {
  assert.equal(M.MAX_WORDS, 8)
  assert.equal(M.SENT_WINDOW, 5)
  assert.equal(M.CONTEXT_CAP, 2500)
})

test("WORD_RE: comart's measured table, unchanged", () => {
  const table = [
    ["state-of-the-art don't co-op", ['state-of-the-art', "don't", 'co-op']],
    ["can't-stop won’t", ["can't-stop", 'won’t']],
    ["rock 'n' roll", ['rock', 'n', 'roll']],
    ['1990s x² H₂O 1st', ['1990s', 'x²', 'H₂O', '1st']],
    ['3.14', ['3', '14']],
    ['$5,000', ['5', '000']],
    ['well—known well–known', ['well', 'known', 'well', 'known']],
    ["students' books, the dogs’ bowls", ['students', 'books', 'the', 'dogs', 'bowls']],
    ['Привет, мир! Ελληνικά', ['Привет', 'мир', 'Ελληνικά']],
    ['naïve café Œuvre', ['naïve', 'café', 'Œuvre']],
    ['東京は日本の首都です。', ['東京は日本の首都です']],
    ['co--op -lead trail- ’quoted’', ['co--op', 'lead', 'trail', 'quoted']],
    ['𝔸𝔹c 😀 emoji', ['𝔸𝔹c', 'emoji']],
  ]
  for (const [input, want] of table) {
    assert.deepEqual(words(input), want, input)
    assert.deepEqual(comartWords(input), want, 'comart itself: ' + input)
  }
})

test('WORD_RE: a combining mark stays inside its word (comart split it)', () => {
  const decomposed = 'e\u0301te'
  assert.deepEqual(comartWords(decomposed), ['e', 'te'])
  assert.deepEqual(words(decomposed), ['e\u0301te'])
  // A word may END in a mark; comart dropped the accent off "café".
  assert.deepEqual(comartWords('cafe\u0301 au lait'), ['cafe', 'au', 'lait'])
  assert.deepEqual(M.wordsIn('cafe\u0301 au lait')[0], { from: 0, to: 5, text: 'cafe\u0301' })
  // A stray mark with no base letter before it starts nothing.
  assert.deepEqual(M.wordsIn('\u0301abc'), [{ from: 1, to: 4, text: 'abc' }])
})

test('WORD_RE: a soft hyphen inside a word does not split it, and is stripped', () => {
  const s = 'a liz\u00ADard ran'
  assert.deepEqual(comartWords(s), ['a', 'liz', 'ard', 'ran'])
  // The offsets are the TEXT's, so the reader can map them back to the DOM.
  assert.deepEqual(M.wordsIn(s), [
    { from: 0, to: 1, text: 'a' },
    { from: 2, to: 9, text: 'lizard' },
    { from: 10, to: 13, text: 'ran' },
  ])
  // At an edge it is not part of the word.
  assert.deepEqual(M.wordsIn('\u00ADword\u00AD'), [{ from: 1, to: 5, text: 'word' }])
  assert.deepEqual(words('state-of-the-\u00ADart'), ['state-of-the-art'])
})

test('WORD_RE: identical to comart on every input with no mark and no soft hyphen', () => {
  const corpus = [
    'It was the best of times, it was the worst of times; it was the age of wisdom…',
    '“Don’t,” she said — and he didn’t. (Well, not until 9:45 p.m.)',
    'O\'Brien\'s co-op—a 24/7 deli—sold “state-of-the-art” bagels at $3.50!',
    'Ünïcödé façade, Ærøskøbing, Ðorđe, İstanbul, ǅemal',
    'Line one\nLine two\u00A0with nbsp',
  ]
  for (const s of corpus) assert.deepEqual(words(s), comartWords(s), s)
})

test('wordAt: the word whose [from, to) holds the index, else null', () => {
  const s = 'the big dog.'
  assert.equal(M.wordAt(s, 4)?.text, 'big')
  assert.equal(M.wordAt(s, 6)?.text, 'big')
  assert.deepEqual(M.wordAt(s, 4), { from: 4, to: 7, text: 'big' })
  assert.equal(M.wordAt(s, 7), null, 'the space after a word')
  assert.equal(M.wordAt(s, 3), null)
  assert.equal(M.wordAt(s, 11), null, 'the full stop')
  assert.equal(M.wordAt(s, 12), null, 'past the end')
  assert.equal(M.wordAt(s, -1), null)
  assert.equal(M.wordAt(s, NaN), null)
  assert.equal(M.wordAt('', 0), null)
})

test('wordAt agrees with wordsIn at every index of a mixed text', () => {
  const s = 'Hello, liz\u00ADard! cafe\u0301 𝔸𝔹c don\'t\nNext—line 東京です。 x  y\u00AD \u00ADz-'
  const all = M.wordsIn(s)
  for (let i = -2; i <= s.length + 2; i++) {
    const want = all.find((w) => w.from <= i && i < w.to) ?? null
    assert.deepEqual(M.wordAt(s, i), want, 'index ' + i)
  }
})

test('wordAt finds a word deep in a long text', () => {
  const s = 'word '.repeat(20000) + 'target ' + 'word '.repeat(10)
  const at = s.indexOf('target') + 3
  assert.deepEqual(M.wordAt(s, at), { from: 100000, to: 100006, text: 'target' })
})

/** The sentences as strings, for readable assertions. */
const sents = (s) => M.sentenceRanges(s).map((r) => s.slice(r.from, r.to))

test("sentenceRanges: comart's split, plus closing quotes and brackets", () => {
  const s = 'Mr. Smith said "Stop." Then he left! Was it 3.5 p.m.? Yes… maybe.'
  assert.deepEqual(sents(s), ['Mr. ', 'Smith said "Stop." ', 'Then he left! ', 'Was it 3.5 p.m.? ', 'Yes… ', 'maybe.'])
  const q = '“Go.” She ran. ‘Why?’ he asked (quietly!) and left.] Really?" Then »Oui.» Non'
  assert.deepEqual(sents(q), [
    '“Go.” ', 'She ran. ', '‘Why?’ ', 'he asked (quietly!) ', 'and left.] ', 'Really?" ', 'Then »Oui.» ', 'Non',
  ])
})

test('sentenceRanges: a block end is a sentence end; blank blocks are not sentences', () => {
  const s = 'One. Two\nThree.\n \nFour'
  assert.deepEqual(M.sentenceRanges(s), [
    { from: 0, to: 5, block: 0 },
    { from: 5, to: 8, block: 0 },
    { from: 9, to: 15, block: 1 },
    { from: 18, to: 22, block: 3 },
  ])
  assert.deepEqual(sents('Hello\nworld.'), ['Hello', 'world.'])
  assert.deepEqual(sents('End. '), ['End. '], 'the trailing space stays with its sentence')
  assert.deepEqual(M.sentenceRanges(''), [])
  assert.deepEqual(M.sentenceRanges(' \n \n'), [])
})

/** `n` sentences of exactly `len` characters, `S007 xxx….` */
const fixed = (n, len) => Array.from({ length: n }, (_, k) => 'S' + String(k).padStart(3, '0') + ' ' + 'x'.repeat(len - 6) + '.')
const span = (text, word) => { const at = text.indexOf(word); return [at, at + word.length] }

test('contextWindow: ±5 sentences, a space inside a block and \\n between blocks', () => {
  const list = Array.from({ length: 20 }, (_, k) => 'Sentence number ' + k + ' is here.')
  const one = list.join(' ')
  const [a, b] = span(one, 'number 10')
  assert.equal(M.contextWindow(one, a, b), list.slice(5, 16).join(' '))
  // Starting the window at the chapter's first sentence never reaches before it.
  const [c, d] = span(one, 'number 0 ')
  assert.equal(M.contextWindow(one, c, d - 1), list.slice(0, 6).join(' '))
  // The window crosses blocks; each block break survives as \n.
  const blocks = list.slice(0, 12).join('\n')
  const [e, f] = span(blocks, 'number 6')
  assert.equal(M.contextWindow(blocks, e, f), list.slice(1, 12).join('\n'))
})

test('contextWindow: whitespace squashed, blank blocks skipped, soft hyphens dropped', () => {
  const s = ' Alpha one. Beta  two. \n \nGamma\u00ADray three.'
  const [a, b] = span(s, 'two')
  assert.equal(M.contextWindow(s, a, b), 'Alpha one. Beta two.\nGammaray three.')
  // A blank block does not use up the window: 6 blocks with blanks between
  // them still give the five on each side.
  const list = Array.from({ length: 13 }, (_, k) => 'Para ' + k + '.')
  const spaced = list.join('\n \n')
  const [c, d] = span(spaced, 'Para 6')
  assert.equal(M.contextWindow(spaced, c, d), list.slice(1, 12).join('\n'))
})

test('contextWindow: the pad shrinks until the passage fits the cap', () => {
  const list = fixed(21, 300)
  const s = list.join(' ')
  // pad 5 = 11×300+10, pad 4 = 9×300+8: both over 2500; pad 3 = 7×300+6 fits.
  const [a, b] = span(s, 'S010')
  const got = M.contextWindow(s, a, b)
  assert.equal(got, list.slice(7, 14).join(' '))
  assert.equal(got.length, 2106)
  // A pick spanning two sentences keeps both and pads around the pair.
  const at = s.indexOf('S010') + 290
  const to = s.indexOf('S011') + 4
  assert.equal(M.contextWindow(s, at, to), list.slice(7, 15).join(' '))
})

test('contextWindow: one sentence over the cap is cut CENTRED on the pick, never losing it', () => {
  const tokens = Array.from({ length: 2000 }, (_, k) => 'w' + String(k).padStart(4, '0'))
  tokens[1000] = 'TARGET'
  const s = tokens.join(' ')
  assert.ok(s.length > 6000 + 1250 * 2)
  const [a, b] = span(s, 'TARGET')
  assert.ok(!comartCut(s).includes('TARGET'), "comart's cut drops the word")
  const got = M.contextWindow(s, a, b)
  assert.ok(got.length <= 2500, 'length ' + got.length)
  assert.ok(got.length >= 2490, 'uses the cap, length ' + got.length)
  assert.ok(got.includes('TARGET'))
  assert.ok(Math.abs(got.indexOf('TARGET') + 3 - got.length / 2) <= 6, 'centred: at ' + got.indexOf('TARGET'))
  // No half word at either edge.
  const parts = got.split(' ')
  assert.match(parts[0], /^w\d{4}$/)
  assert.match(parts[parts.length - 1], /^w\d{4}$/)
  assert.ok(s.includes(got))
  // Near the end the window clamps to the text instead of running past it.
  const [c, d] = span(s, 'w1998')
  const tail = M.contextWindow(s, c, d)
  assert.ok(tail.endsWith('w1998 w1999') && tail.length <= 2500 && tail.length >= 2490)
})

test('contextWindow: the cut clamps to the text and does not eat unspaced runs', () => {
  // The pick is the first word of a 4000-character sentence: the window starts
  // at the text's start.  The far edge lands inside a 4000-character run with
  // no space; moving it back to whitespace would throw the run away.
  const s = 'Start ' + 'y'.repeat(4000) + ' end.'
  const got = M.contextWindow(s, 0, 5)
  assert.equal(got, 'Start ' + 'y'.repeat(2494))
})

test('contextWindow: degenerate input', () => {
  assert.equal(M.contextWindow('', 0, 0), '')
  assert.equal(M.contextWindow(' \n ', 0, 1), '')
  // A range on a block break falls to the next sentence, with its window.
  assert.equal(M.contextWindow('One.\nTwo.', 4, 4), 'One.\nTwo.')
  // Out-of-range offsets are clamped, never thrown on.
  assert.equal(M.contextWindow('Only one.', -10, 99), 'Only one.')
})

const META = { title: 'Dracula', author: 'Bram Stoker', chapter: 'Chapter I' }

test('buildPassage: title — author, then the chapter, then the context', () => {
  assert.equal(M.buildPassage('ctx', META), 'Dracula — Bram Stoker\nChapter I\n\nctx')
  assert.equal(M.buildPassage('ctx', { ...META, author: '' }), 'Dracula\nChapter I\n\nctx')
  assert.equal(M.buildPassage('ctx', { ...META, title: '' }), 'Bram Stoker\nChapter I\n\nctx')
  assert.equal(M.buildPassage('ctx', { title: '', author: '', chapter: 'Chapter I' }), 'Chapter I\n\nctx')
  assert.equal(M.buildPassage('ctx', { ...META, chapter: '' }), 'Dracula — Bram Stoker\n\nctx')
  assert.equal(M.buildPassage('ctx', { title: '', author: '', chapter: '' }), 'ctx')
  assert.equal(
    M.buildPassage('ctx', { title: ' The\n  Time Machine ', author: 'H. G.\tWells', chapter: 'I\u00ADntroduction' }),
    'The Time Machine — H. G. Wells\nIntroduction\n\nctx',
  )
})

test('buildPassage: the chapter is not said twice, and a giant heading is not a title', () => {
  assert.equal(M.buildPassage('ctx', { ...META, chapter: 'DRACULA' }), 'Dracula — Bram Stoker\n\nctx')
  // Equality, not substring: "I" sits inside "Inferno" and is still a chapter.
  assert.equal(M.buildPassage('ctx', { title: 'Inferno', author: '', chapter: 'I' }), 'Inferno\nI\n\nctx')
  assert.equal(M.buildPassage('ctx', { ...META, chapter: 'z'.repeat(301) }), 'Dracula — Bram Stoker\n\nctx')
  assert.equal(M.buildPassage('ctx', { ...META, chapter: 'z'.repeat(300) }), 'Dracula — Bram Stoker\n' + 'z'.repeat(300) + '\n\nctx')
})

test('buildPassage: the prefix goes only when the whole fits; the context is never cut', () => {
  const meta = { title: 'T', author: '', chapter: 'C' } // prefix "T\nC", 3 characters
  const fits = 'a'.repeat(2500 - 5)
  assert.equal(M.buildPassage(fits, meta), 'T\nC\n\n' + fits)
  assert.equal(M.buildPassage(fits, meta).length, 2500)
  const over = 'a'.repeat(2500 - 4)
  assert.equal(M.buildPassage(over, meta), over)
  const huge = 'b'.repeat(4000)
  assert.equal(M.buildPassage(huge, meta), huge)
  // Already in the context: not repeated.
  assert.equal(M.buildPassage('T\nC and more', meta), 'T\nC and more')
  // No context at all: the orientation alone, as comart's join does.
  assert.equal(M.buildPassage('', meta), 'T\nC')
})

test('end to end: a picked word, its window and the prefix fit together', () => {
  const chapter = 'Chapter I\n' + fixed(30, 120).join(' ') + '\nThe count smiled.'
  const [a, b] = span(chapter, 'count')
  const ctx = M.contextWindow(chapter, a, b)
  const passage = M.buildPassage(ctx, META)
  assert.ok(passage.length <= 2500)
  assert.ok(passage.startsWith('Dracula — Bram Stoker\nChapter I\n\n'))
  assert.ok(passage.endsWith('\nThe count smiled.'))
  assert.ok(passage.includes(M.wordAt(chapter, a).text))
})

test('the module is pure: no DOM, no network, no HTML sink', () => {
  const code = readFileSync(SRC, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  for (const bad of [/\bdocument\b/, /\bwindow\b/, /\bfetch\b/, /innerHTML|outerHTML|insertAdjacentHTML|DOMParser/]) {
    assert.doesNotMatch(code, bad)
  }
})
