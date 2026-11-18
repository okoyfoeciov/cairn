/**
 * tests/frontend/explain-render.test.mjs — CONTRACT §0.56 E109's renderer.
 * Owner: 03.  `node --test tests/frontend/explain-render.test.mjs`.
 *
 * `src/explain-render.ts` is comart's `panel.js` string renderer rebuilt as
 * DOM.  The badge expectations below are comart's own HTML strings (panel.js
 * speakerSvg/warnSvg/singleBadgeHtml/aiBadgeHtml/badgeHtml), transcribed — a
 * test must not read another repo — and compared against a serialisation of
 * the built nodes that writes attributes in creation order, escapes like
 * comart's `escapeHtml`, prints `disabled` bare as comart writes it and closes a
 * childless `<path>`/`<circle>` with `/>`.  So every class, attribute and
 * child of every badge state is pinned to the source it was ported from.
 *
 * Driven on `_minidom.mjs`; the shims it needs are installed HERE (owner 05's
 * file is not ours): `className` backed by the `class` attribute, so the
 * serialisation sees the real attribute order, `getAttributeNames` and
 * `cloneNode`.
 */

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'
import { installGlobals, AElement, AText, ADocument } from './_minidom.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const SRC = join(ROOT, 'src', 'explain-render.ts')

/** @type {any} */ let X

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cairn-exr-'))
  process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })
  const out = join(dir, 'bundle.mjs')
  await esbuild.build({
    stdin: {
      contents: 'export * as X from ' + JSON.stringify(SRC) + '\n',
      resolveDir: ROOT,
      sourcefile: 'explain-render-test-entry.ts',
      loader: 'ts',
    },
    outfile: out, bundle: true, format: 'esm', platform: 'neutral',
    mainFields: ['module', 'main'], conditions: ['import', 'default'],
    target: 'es2021', absWorkingDir: ROOT, logLevel: 'silent',
  })
  X = (await import(pathToFileURL(out).href)).X

  installGlobals()
  Object.defineProperty(AElement.prototype, 'className', {
    configurable: true,
    get() { return this.attrs.get('class') ?? '' },
    set(v) {
      const s = String(v)
      if (s) this.attrs.set('class', s)
      else this.attrs.delete('class')
    },
  })
  AElement.prototype.getAttributeNames = function getAttributeNames() { return [...this.attrs.keys()] }
  AElement.prototype.cloneNode = function cloneNode(deep) {
    const c = this.ownerDocument.createElement(this.tagName.toLowerCase())
    for (const [k, v] of this.attrs) c.attrs.set(k, v)
    if (deep) for (const k of this.childNodes) c.append(k.cloneNode(true))
    return c
  }
  AText.prototype.cloneNode = function cloneNode() { return this.ownerDocument.createTextNode(this.data) }
  globalThis.document = new ADocument()
})

/* ── helpers ─────────────────────────────────────────────────────────────── */

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function html(n) {
  if (n.nodeType === 3) return esc(n.data)
  if (n.nodeType !== 1) return n.childNodes.map(html).join('')
  const tag = n.tagName.toLowerCase()
  const attrs = [...n.attrs].map(([k, v]) => (k === 'disabled' && v === '' ? ` ${k}` : ` ${k}="${esc(v)}"`)).join('')
  if (tag === 'br') return `<br${attrs}>`
  if ((tag === 'path' || tag === 'circle') && !n.childNodes.length) return `<${tag}${attrs}/>`
  return `<${tag}${attrs}>${n.childNodes.map(html).join('')}</${tag}>`
}

/** A fragment's nodes, in a div so it can be queried. */
function box(frag) {
  const d = document.createElement('div')
  d.append(frag)
  return d
}

const md = (src, st = X.newPronState()) => box(X.renderMarkdown(src, st))
const inl = (src, st = X.newPronState()) => html(box(X.renderInline(src, st))).replace(/^<div>|<\/div>$/g, '')
const words = (root) => root.querySelectorAll('.ex-word').map((s) => s.getAttribute('data-word'))

/* comart panel.js:1652-1657 and 1676-1682, verbatim. */
const SPEAKER = '<svg class="speaker" viewBox="0 0 24 24" aria-hidden="true">' +
  '<path d="M11 5 7 9H4a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h3l4 4z" fill="currentColor"/>' +
  '<path d="M15.5 8.5a5 5 0 0 1 0 7" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round"/></svg>'
const WARN = '<svg class="warn" viewBox="0 0 24 24" aria-hidden="true">' +
  '<path d="M12 4 2.5 20h19L12 4z" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linejoin="round"/>' +
  '<path d="M12 10v4.4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
  '<circle cx="12" cy="17.6" r="1.15" fill="currentColor"/></svg>'

const MP3 = 'https://media.merriam-webster.com/audio/prons/en/us/mp3/r/record01.mp3'
const MP3B = 'https://media.merriam-webster.com/audio/prons/en/us/mp3/r/record03.mp3'
/* ai-service's live `/api/pron?word=record&pos=noun` shape (mw.LookupResult). */
const RECORD = {
  hword: 'record', pos: 'verb', num: '1 of 4', syllables: 're·cord', ipa: 'ri-ˈkȯrd', mp3: MP3,
  variants: [
    { pos: 'verb', posList: ['verb', 'noun (2)'], num: '1 of 4', ipa: 'ri-ˈkȯrd', mp3: MP3 },
    { pos: 'noun (1)', posList: ['noun (1)', 'adjective'], num: '2 of 4', ipa: 'ˈre-kərd', mp3: MP3B },
  ],
}

const real = ({ key, mp3, title, ipa, label, picked = false }) =>
  `<button type="button" class="pron-badge${picked ? ' is-picked' : ''}" data-key="${esc(key)}" ` +
  `data-mp3="${esc(mp3)}" title="${esc(title)}" aria-label="Play pronunciation ${esc(ipa)}">` +
  (label ? `<span class="badge-pos">${label}</span>` : '') +
  `<span class="ipa">${esc(ipa)}</span>${SPEAKER}</button>`
const loading = (key, word, pos) =>
  `<button type="button" class="pron-badge loading" data-key="${esc(key)}" ` +
  `data-word="${esc(word)}" data-pos="${esc(pos)}" disabled><span class="dot-loader">…</span></button>`

/* ── tags and helpers ────────────────────────────────────────────────────── */

test('parsePronAttrs: word and pos are required, ipa is normalised', () => {
  assert.deepEqual(X.parsePronAttrs(' word="surveil" pos="verb" ipa="/sər-ˈvāl/"'),
    { word: 'surveil', pos: 'verb', ipa: 'sər-ˈvāl' })
  assert.deepEqual(X.parsePronAttrs(' pos="noun"  WORD = "Tear"'), { word: 'Tear', pos: 'noun', ipa: '' })
  assert.equal(X.parsePronAttrs(' word="x"'), null)
  assert.equal(X.parsePronAttrs(' pos="noun"'), null)
  assert.equal(X.normIpa(' [\\ˈklōz/] '), 'ˈklōz')
  assert.equal(X.ipaSkeleton('ˈbyu̇-rə-ˌkra-sē'), X.ipaSkeleton('byu̇rəkrasē'))
  assert.equal(X.posHead('Noun (2)'), 'noun')
  assert.equal(X.posAbbrev('noun (1)'), 'n.')
  assert.equal(X.posAbbrev('adverb'), 'adv.')
  assert.equal(X.posAbbrev('definite article'), '')
  assert.equal(X.posAbbrev('constructor'), '', 'not Object.prototype')
  assert.equal(X.badgeKey({ word: 'Close', pos: 'Adjective' }), 'close|adjective')
  assert.equal(X.badgeKey({ word: 'close', pos: '' }), 'close|')
})

test('refreshPronMaps: the FIRST [[PRON]] per word wins, rounds before the buffer', () => {
  const st = X.newPronState()
  st.posByWord.set('stale', 'noun')
  X.refreshPronMaps(st, [
    '**charge** [[PRON word="charge" pos="noun" ipa="ˈchärj"]]: … **charge** [[PRON word="Charge" pos="verb" ipa="ˈchärj-x"]]',
    '',
    'later [[PRON word="charge" pos="adjective" ipa="no"]] [[PRON word="up" pos="adverb"]] [[PRON word="bad"]]',
  ])
  assert.equal(st.posByWord.get('charge'), 'noun')
  assert.equal(st.llmIpaByWord.get('charge'), 'ˈchärj')
  assert.equal(st.posByWord.get('up'), 'adverb')
  assert.equal(st.llmIpaByWord.has('up'), false, 'no ipa, no entry')
  assert.equal(st.posByWord.has('bad'), false, 'a tag without pos is ignored')
  assert.equal(st.posByWord.has('stale'), false, 'the maps are refilled, not merged')
})

test('visibleBuffer hides a half-streamed tag; the LAST opener wins', () => {
  assert.equal(X.visibleBuffer('**word** [[PRON word="w'), '**word** ')
  assert.equal(X.visibleBuffer('a [[SENSE p="7'), 'a ')
  assert.equal(X.visibleBuffer('a [[PRON word="w" pos="n"]] b'), 'a [[PRON word="w" pos="n"]] b')
  assert.equal(X.visibleBuffer('a [[PRON word="w" pos="n"]] b [[SENSE p'), 'a [[PRON word="w" pos="n"]] b ')
  assert.equal(X.visibleBuffer('plain'), 'plain')
})

test('chooseVariantIdx: POS narrows first, the respelling breaks ties (tear)', () => {
  const tear = [
    { posList: ['noun'], ipa: 'ˈter' },
    { posList: ['noun'], ipa: 'ˈtir' },
    { posList: ['verb'], ipa: 'ˈter' },
  ]
  assert.equal(X.chooseVariantIdx(tear, 'noun', 'ˈtir'), 1)
  assert.equal(X.chooseVariantIdx(tear, 'noun', ''), 0)
  assert.equal(X.chooseVariantIdx(tear, 'verb', 'ˈtir'), 2, 'a one-variant pool ignores the ipa')
  assert.equal(X.chooseVariantIdx(tear, 'adverb', '/ˈtir/'), 1, 'no POS match: the ipa picks from all')
})

test('prefetchedRealFor: exact word, then its MW headword, then an inflection; failures never bridge', () => {
  const cache = new Map([
    ['effects|', { hword: 'effect', variants: [{ ipa: 'i-ˈfekt' }] }],
    ['on|', { hword: 'on', variants: [{ ipa: 'ˈȯn' }] }],
    ['gone|', { error: true, reason: 'notfound' }],
    ['go|verb', { hword: 'go', ipa: 'ˈgō' }],
    ['children|', { hword: 'child', variants: [{ ipa: 'ˈchil-drən' }] }],
    ['state|', { hword: 'state', variants: [{ ipa: 'ˈstāt' }] }],
  ])
  assert.equal(X.prefetchedRealFor(cache, 'Effect'), cache.get('effects|'))
  assert.equal(X.prefetchedRealFor(cache, 'on'), cache.get('on|'))
  assert.equal(X.prefetchedRealFor(cache, 'one'), null, 'a 2-char stem never grabs a word')
  assert.equal(X.prefetchedRealFor(cache, 'gone'), null)
  assert.equal(X.prefetchedRealFor(cache, 'go'), null, 'a flat lookup without variants is not a bundle')
  assert.equal(X.prefetchedRealFor(cache, 'child'), cache.get('children|'), 'MW filed it under this headword')
  assert.equal(X.prefetchedRealFor(cache, 'statement'), null, "a longer word is not an inflection: never state's clip")
  assert.equal(X.prefetchedRealFor(cache, 'stat'), null)
})

test('inflectedPair: one word is the other plus an inflection, 3+ letters', () => {
  for (const [a, b] of [['effect', 'effects'], ['box', 'boxes'], ['use', 'used'], ['walk', 'walked'], ['read', 'reading'], ['dog', "dog's"], ['dog', 'dog\u2019s']]) {
    assert.equal(X.inflectedPair(a, b), true, `${a}/${b}`)
    assert.equal(X.inflectedPair(b, a), true, `${b}/${a}`)
  }
  for (const [a, b] of [['state', 'statement'], ['on', 'onerous'], ['you', 'your'], ['art', 'article'], ['a', 'as'], ['use', 'useful'], ['cat', 'cat']]) {
    assert.equal(X.inflectedPair(a, b), false, `${a}/${b}`)
  }
})

test('lemmaForUserWord: the row looks a user word up under the model\'s form', () => {
  const st = X.newPronState()
  X.refreshPronMaps(st, ['[[PRON word="effect" pos="noun"]] [[PRON word="onerous" pos="adjective"]] [[PRON word="state" pos="noun"]]'])
  assert.equal(X.lemmaForUserWord(st, 'Effects'), 'effect')
  assert.equal(X.lemmaForUserWord(st, 'effect'), 'effect')
  assert.equal(X.lemmaForUserWord(st, 'cause'), 'cause')
  assert.equal(X.lemmaForUserWord(st, 'on'), 'on', 'a short word is not a stem of every word it starts')
  assert.equal(X.lemmaForUserWord(st, 'statement'), 'statement')
})

/* ── every badge state, against comart's markup ──────────────────────────── */

test('badge: real, single, from a flat /api/pron answer', () => {
  const st = X.newPronState()
  st.cache.set('record|verb', RECORD)
  assert.equal(html(X.badgeFor({ word: 'record', pos: 'verb', ipa: '' }, st)),
    real({ key: 'record|verb', mp3: MP3, title: 'record (verb)', ipa: 'ri-ˈkȯrd', label: 'v.' }))
  // Same POS head on both variants: the model's respelling decides.
  st.cache.set('record|noun', RECORD)
  assert.equal(html(X.badgeFor({ word: 'record', pos: 'noun', ipa: 'ˈre-kərd' }, st)),
    real({ key: 'record|noun', mp3: MP3B, title: 'record (noun (1))', ipa: 'ˈre-kərd', label: 'n.' }))
})

test('badge: a part of speech outside the eight gets no .badge-pos', () => {
  const st = X.newPronState()
  const mp3 = 'https://media.merriam-webster.com/audio/prons/en/us/mp3/t/the00001.mp3'
  X.storePronData(st.cache, { the: { hword: 'the', variants: [{ pos: 'definite article', posList: ['definite article'], ipa: 't͟hə', mp3 }] } })
  assert.equal(html(X.badgeFor({ word: 'the', pos: 'definite article', ipa: '' }, st)),
    real({ key: 'the|definite article', mp3, title: 'the (definite article)', ipa: 't͟hə', label: '' }))
})

test('badge: multi = every variant, the committed one .is-picked (pron-only row)', () => {
  const st = X.newPronState()
  X.storePronData(st.cache, { record: { hword: 'record', variants: RECORD.variants } })
  const unpicked = html(X.badgeFor({ word: 'record', pos: '', ipa: '', multi: true }, st))
  assert.equal(unpicked, '<span class="pron-variants">' +
    real({ key: 'record|#0', mp3: MP3, title: 'record (verb)', ipa: 'ri-ˈkȯrd', label: 'v.' }) +
    real({ key: 'record|#1', mp3: MP3B, title: 'record (noun (1))', ipa: 'ˈre-kərd', label: 'n.' }) +
    '</span>', 'nothing committed yet: no variant is lit')
  X.refreshPronMaps(st, ['**record** [[PRON word="record" pos="noun (1)" ipa="ˈre-kərd"]]'])
  assert.equal(html(X.badgeFor({ word: 'record', pos: '', ipa: '', multi: true }, st)),
    '<span class="pron-variants">' +
    real({ key: 'record|#0', mp3: MP3, title: 'record (verb)', ipa: 'ri-ˈkȯrd', label: 'v.' }) +
    real({ key: 'record|#1', mp3: MP3B, title: 'record (noun (1))', ipa: 'ˈre-kərd', label: 'n.', picked: true }) +
    '</span>')
  // Inline (not multi) is always the single chosen variant.
  assert.equal(html(X.badgeFor({ word: 'record', pos: '', ipa: '' }, st)),
    real({ key: 'record|', mp3: MP3B, title: 'record (noun (1))', ipa: 'ˈre-kərd', label: 'n.' }))
})

test('badge: the related-form bridge turns a user-word bundle into the inline lemma\'s badge', () => {
  const st = X.newPronState()
  X.storePronData(st.cache, { effects: { hword: 'effect', variants: [{ pos: 'noun', posList: ['noun'], ipa: 'i-ˈfekt', mp3: 'e.mp3' }] } })
  st.cache.set('effect|noun', { error: true, reason: 'notfound' })
  assert.equal(html(X.badgeFor({ word: 'effect', pos: 'noun', ipa: 'i-ˈfekt' }, st)),
    real({ key: 'effect|noun', mp3: 'e.mp3', title: 'effect (noun)', ipa: 'i-ˈfekt', label: 'n.' }),
    'a cached failure under the exact key still takes the bridge, never the AI badge')
})

test('badge: AI (violet) — MW has none and the model gave a respelling', () => {
  const st = X.newPronState()
  st.cache.set('suddenly|adverb', X.pronFailure(404))
  assert.equal(html(X.badgeFor({ word: 'suddenly', pos: 'adverb', ipa: '/ˈsə-dᵊn-lē/' }, st)),
    '<button type="button" class="pron-badge ai-made" disabled title="Approximate pronunciation for ' +
    '&quot;suddenly&quot; (adverb) — generated by AI, not from Merriam-Webster" data-word="suddenly" ' +
    'data-pos="adverb" aria-label="AI-made approximate pronunciation ˈsə-dᵊn-lē, not from a dictionary">' +
    '<span class="badge-pos">adv.</span><span class="approx" aria-hidden="true">≈</span>' +
    '<span class="ipa">ˈsə-dᵊn-lē</span><span class="ai-tag" aria-hidden="true">AI</span></button>')
})

test('badge: amber "no pron" and red "pron unavailable"', () => {
  const st = X.newPronState()
  st.cache.set('quixotic|adjective', X.pronFailure(404))
  assert.equal(html(X.badgeFor({ word: 'quixotic', pos: 'adjective', ipa: '' }, st)),
    '<button type="button" class="pron-badge failed err-none" disabled title="Merriam-Webster has no ' +
    'pronunciation for &quot;quixotic&quot;" data-word="quixotic" data-pos="adjective">' +
    `${WARN}<span class="err-label">no pron</span></button>`)
  st.cache.set('quixotic|adjective', X.pronFailure(502))
  const unavailable = '<button type="button" class="pron-badge failed err-mw" disabled title="Couldn\'t ' +
    'reach Merriam-Webster for &quot;quixotic&quot; — pronunciation unavailable, try again later" ' +
    `data-word="quixotic" data-pos="adjective">${WARN}<span class="err-label">pron unavailable</span></button>`
  assert.equal(html(X.badgeFor({ word: 'quixotic', pos: 'adjective', ipa: '' }, st)), unavailable)
  assert.equal(html(X.badgeFor({ word: 'quixotic', pos: 'adjective', ipa: 'kwik-ˈsä-tik' }, st)), unavailable,
    'an outage is never papered over with the AI guess')
  assert.deepEqual(X.pronFailure(undefined), { error: true, reason: 'unavailable' }, 'a thrown fetch')
})

test('badge: loading placeholder while nothing is cached', () => {
  assert.equal(html(X.badgeFor({ word: 'Tear', pos: 'Noun', ipa: 'ˈtir' }, X.newPronState())),
    loading('tear|noun', 'Tear', 'Noun'))
})

test('pronOnlyBlock: one row per distinct word, the user\'s word printed, the lemma looked up', () => {
  const st = X.newPronState()
  X.refreshPronMaps(st, ['[[PRON word="effect" pos="noun"]]'])
  const block = X.pronOnlyBlock([
    { phrase: 'Effects', words: ['Effects'] },
    { phrase: 'effects of up', words: ['effects', 'of', 'up'] },
  ], st)
  assert.equal(html(block), '<div class="ex-pron-only">' +
    `<span class="ex-pron-only-row"><strong>Effects</strong>${loading('effect|', 'effect', '')}</span>` +
    `<span class="ex-pron-only-row"><strong>of</strong>${loading('of|', 'of', '')}</span>` +
    `<span class="ex-pron-only-row"><strong>up</strong>${loading('up|', 'up', '')}</span></div>`)
  assert.equal(X.pronOnlyBlock([], st), null)
  assert.equal(X.pronOnlyBlock([{ phrase: '', words: [] }], st), null)
})

/* ── inline markdown ─────────────────────────────────────────────────────── */

test('inline: a badge eats ONE space on each side (comart\'s U+0001 sentinel rule)', () => {
  assert.equal(inl('**surveil** [[PRON word="surveil" pos="verb" ipa="sər-ˈvāl"]]: to watch'),
    '<strong>surveil</strong>' + loading('surveil|verb', 'surveil', 'verb') + ': to watch')
  // Two tags one space apart both match, and the gap between them goes.
  assert.equal(inl('a [[PRON word="a" pos="noun"]] [[PRON word="b" pos="noun"]] b'),
    'a' + loading('a|noun', 'a', 'noun') + loading('b|noun', 'b', 'noun') + 'b')
  // Only one space each side.
  assert.equal(inl('x  [[PRON word="x" pos="noun"]]  y'), 'x ' + loading('x|noun', 'x', 'noun') + ' y')
  // A chip follows the same rule.
  const title = 'About 70 readers in 100 would read the passage this way — the model\'s own estimate, not a dictionary fact'
  assert.equal(inl('[[SENSE p="70"]] **charge** and [[SENSE p="30%"]] **charge**'),
    `<span class="sense-odds lead" title="${title}" aria-label="${title}">70%</span><strong>charge</strong> and` +
    `<span class="sense-odds" title="${title.replace('70', '30')}" aria-label="${title.replace('70', '30')}">30%</span>` +
    '<strong>charge</strong>')
  // A malformed tag is a plain space, not a sentinel.
  assert.equal(inl('a [[PRON word="w"]] b [[SENSE p="0"]] c [[SENSE p="101"]] d'), 'a   b   c   d')
})

test('inline: bold, italic, nesting, and inline code keeping its spaces and its literals', () => {
  assert.equal(inl('**b** and *i* and *a **b** c*'), '<strong>b</strong> and <em>i</em> and <em>a <strong>b</strong> c</em>')
  assert.equal(inl('If `x` is negative'), 'If <code>x</code> is negative')
  assert.equal(inl('`` a `b` c ``'), '<code>a `b` c</code>')
  assert.equal(inl('`[[PRON word="x" pos="noun"]] *no* <b>`'), '<code>[[PRON word=&quot;x&quot; pos=&quot;noun&quot;]] *no* &lt;b&gt;</code>')
  assert.equal(inl('`unclosed *em*'), '`unclosed <em>em</em>')
  assert.equal(inl('2 * 3 * 4'), '2 <em> 3 </em> 4', 'comart\'s em regex, as is')
})

test('inline: only http(s) markdown links become a.ex-link; everything else stays text', () => {
  assert.equal(inl('see [Claude](https://en.wikipedia.org/wiki/Claude_(language_model)) now'),
    'see <a class="ex-link" href="https://en.wikipedia.org/wiki/Claude_(language_model)" target="_blank" ' +
    'rel="noopener noreferrer">Claude</a> now')
  assert.equal(inl('[bbc.com](HTTPS://www.bbc.com/news)'),
    '<a class="ex-link" href="https://www.bbc.com/news" target="_blank" rel="noopener noreferrer">bbc.com</a>')
  assert.equal(inl('[x](javascript:alert(1))'), '[x](javascript:alert(1))')
  assert.equal(inl('[x](data:text/html,hi)'), '[x](data:text/html,hi)')
  assert.equal(inl('[x](/relative)'), '[x](/relative)')
  assert.equal(inl('![alt](https://example.com/a.png)'), '![alt](https://example.com/a.png)')
  assert.equal(inl('https://example.com/bare'), 'https://example.com/bare')
  assert.equal(inl('[**not bold**](https://example.com/)'),
    '<a class="ex-link" href="https://example.com/" target="_blank" rel="noopener noreferrer">**not bold**</a>')
  assert.equal(inl('[a](https://[x)'), 'a', 'an unparsable URL keeps only its label, as comart')
})

test('inline: hostile model text lands as characters, never as elements', () => {
  const d = box(X.renderInline('<script>alert(1)</script> & <img src=x onerror=alert(1)> "q"', X.newPronState()))
  assert.equal(d.children.length, 0)
  assert.equal(d.childNodes.length, 1, 'one text node')
  assert.equal(d.textContent, '<script>alert(1)</script> & <img src=x onerror=alert(1)> "q"')
  // Our own bold/italic markers in the input are inert.
  assert.equal(inl('a\uFDD0b\uFDD1c'), 'abc')
  // A sentinel typed by the model names a placeholder twice: comart printed it
  // twice, so the second is a copy, and the first stays where it was.
  const twice = box(X.renderInline('a [[PRON word="x" pos="noun"]] b \u00010\u0001 c', X.newPronState()))
  assert.deepEqual(twice.childNodes.map((n) => n.nodeType === 3 ? n.data : n.className),
    ['a', 'pron-badge loading', 'b', 'pron-badge loading', 'c'])
})

/* ── block markdown ──────────────────────────────────────────────────────── */

test('markdown: paragraphs join lines with a space; a blank line starts a new one', () => {
  assert.equal(html(md('one\ntwo\r\n\r\n**The story:** three')),
    '<div><p>one two</p><p><strong>The story:</strong> three</p></div>')
})

test('markdown: > lines are one quote box joined by <br>; a blank line separates boxes', () => {
  assert.equal(html(md('> The **cop** came.\n>Second line\n\n> 📜 *From:* Old English.\nafter')),
    '<div><blockquote>The <strong>cop</strong> came.<br>Second line</blockquote>' +
    '<blockquote>📜 <em>From:</em> Old English.</blockquote><p>after</p></div>')
})

test('markdown: lists — ul/ol, start, nesting by "further right", sibling on marker change, continuation', () => {
  assert.equal(html(md('- one\n  wrapped\n- two\n  - nested\n    1. deep\n3. three\n\n4. four')),
    '<div><ul><li>one wrapped</li><li>two<ul><li>nested<ol><li>deep</li></ol></li></ul></li></ul>' +
    '<ol start="3"><li>three</li><li>four</li></ol></div>')
  assert.equal(html(md('1) a\n2) b')), '<div><ol><li>a</li><li>b</li></ol></div>')
  assert.equal(html(md('- a\n\n  para')), '<div><ul><li>a</li></ul><p>  para</p></div>',
    'after a blank line an indented line is a paragraph, which closes the list')
})

test('markdown: a one-line numbered list is split into an intro and an <ol>', () => {
  assert.equal(html(md('Three things: 1. a 2. b 3. c')),
    '<div><p>Three things:</p><ol><li>a</li><li>b</li><li>c</li></ol></div>')
  assert.equal(html(md('in 2020. we 2.5 tried')), '<div><p>in 2020. we 2.5 tried</p></div>')
})

test('markdown: fenced code is pre.ex-code > code, literal, closed or not, no Copy button', () => {
  assert.equal(html(md('before\n```js\nconst x = a < b && **c**\n  [[PRON word="x" pos="n"]]\n```\nafter')),
    '<div><p>before</p><pre class="ex-code"><code>const x = a &lt; b &amp;&amp; **c**\n' +
    '  [[PRON word=&quot;x&quot; pos=&quot;n&quot;]]</code></pre><p>after</p></div>')
  assert.equal(html(md('~~~~\nstill\n~~~\ncode')), '<div><pre class="ex-code"><code>still\n~~~\ncode</code></pre></div>',
    'an unclosed (or shorter-closed) fence runs to the end')
  assert.equal(md('```\nx\n```').querySelectorAll('.code-copy').length, 0)
})

test('markdown: model output shape — gloss paragraph, quote boxes, badges in place', () => {
  const st = X.newPronState()
  const text = '**surveil** [[PRON word="surveil" pos="verb" ipa="sər-ˈvāl"]]: to watch someone closely — ' +
    'close to: *watch*, *spy on*.\n\n> They **surveil** the house.\n> 🗣️ *Used by:* police'
  const d = md(text, st)
  assert.deepEqual(d.children.map((c) => c.tagName), ['P', 'BLOCKQUOTE'])
  const p = d.children[0]
  assert.equal(p.children[0].tagName, 'STRONG')
  assert.equal(p.children[1].className, 'pron-badge loading')
  assert.equal(p.childNodes[2].data, ': to watch someone closely — close to: ')
})

/* ── panel pieces ────────────────────────────────────────────────────────── */

test('roundBlock: data-round, .ex-divided after the first, pron-only row first, .ex-live while streaming', () => {
  const st = X.newPronState()
  const first = X.roundBlock('hello', [{ phrase: 'cop', words: ['cop'] }], 0, false, st)
  assert.equal(html(first), '<div class="ex-round-block" data-round="0">' +
    `<div class="ex-pron-only"><span class="ex-pron-only-row"><strong>cop</strong>${loading('cop|', 'cop', '')}</span></div>` +
    '<div class="ex-round"><p>hello</p></div></div>')
  const live = X.roundBlock('', [{ phrase: 'up close', words: [] }], 2, true, st)
  assert.equal(html(live), '<div class="ex-round-block ex-divided" data-round="2"><div class="ex-round ex-live"></div></div>')
})

test('thinking dots and the error line', () => {
  assert.equal(html(X.thinkingDots()),
    '<div class="ex-thinking" role="status" aria-label="Waiting for the explanation"><span></span><span></span><span></span></div>')
  assert.equal(html(X.errorLine('Can\'t reach <ai-service>.')), '<p class="ex-err">Can\'t reach &lt;ai-service&gt;.</p>')
})

/* ── answer words ────────────────────────────────────────────────────────── */

function answerFixture() {
  const st = X.newPronState()
  st.cache.set('close|verb', { hword: 'close', variants: [{ posList: ['verb'], ipa: 'ˈklōz', mp3: 'c.mp3' }] })
  const content = document.createElement('div')
  content.className = 'ex-content'
  content.append(
    X.roundBlock('**Close** [[PRON word="close" pos="verb"]]: to shut. Use `don\'t` here [[SENSE p="70"]] ' +
      'and [see](https://example.com/x) co-op.\n\n```\ncode words\n```', [{ phrase: 'close', words: ['close'] }], 0, false, st),
    X.roundBlock('live words', [], 1, true, st),
    X.errorLine('Network down'),
  )
  return { st, content }
}

test('wrapResponseWords: committed answer words only, with comart\'s exclusions', () => {
  const { content } = answerFixture()
  X.wrapResponseWords(content)
  assert.deepEqual(words(content), ['Close', 'to', 'shut', 'Use', 'don\'t', 'here', 'and', 'co-op'],
    'not the badge, the pron-only row, the chip, the link, the code block, the live round or the error')
  const close = content.querySelector('.ex-word')
  assert.equal(html(close), '<span class="ex-word" data-word="Close" data-rid="close#0">Close</span>')
  assert.equal(close.parentNode.tagName, 'STRONG', 'wrapped in place, inside its <strong>')
  assert.equal(content.querySelector('.ex-round').childNodes[0].childNodes.at(-1).data, '.',
    'text between words stays text')
  assert.equal(content.querySelector('.ex-live').textContent, 'live words')
  assert.equal(content.querySelector('.ex-live').querySelectorAll('.ex-word').length, 0)
})

test('wrapResponseWords: idempotent, rid counter seeded from the words on screen, marks applied', () => {
  const { st, content } = answerFixture()
  X.wrapResponseWords(content)
  const before = html(content)
  X.wrapResponseWords(content)
  assert.equal(html(content), before, 'a second pass changes nothing')
  content.append(X.roundBlock('close CLOSE shut', [], 2, false, st))
  X.wrapResponseWords(content, new Set(['close#2', 'shut#1']))
  const added = content.querySelectorAll('.ex-word').slice(-3)
  assert.deepEqual(added.map((s) => s.getAttribute('data-rid')), ['close#1', 'close#2', 'shut#1'])
  assert.deepEqual(added.map((s) => s.classList.contains('is-marked')), [false, true, true])
  // A root inside an excluded subtree wraps nothing.
  const live = content.querySelector('.ex-live')
  X.wrapResponseWords(live)
  assert.equal(live.querySelectorAll('.ex-word').length, 0)
})

/* ── upgrading badges in place ───────────────────────────────────────────── */

test('refreshBadges: loading → real once data lands; real badges are never rebuilt', () => {
  const st = X.newPronState()
  const text = '**tear** [[PRON word="tear" pos="noun" ipa="ˈtir"]]: a drop'
  X.refreshPronMaps(st, [text])
  const block = X.roundBlock(text, [{ phrase: 'tears', words: ['tears'] }], 0, false, st)
  assert.equal(block.querySelectorAll('.pron-badge.loading').length, 2)
  assert.equal(X.refreshBadges(block, st), 0, 'nothing landed: identical placeholders stay')

  st.cache.set('tear|noun', { hword: 'tear', variants: [
    { posList: ['noun'], ipa: 'ˈter', mp3: 'a.mp3' },
    { posList: ['noun'], ipa: 'ˈtir', mp3: 'b.mp3' },
  ] })
  assert.equal(X.refreshBadges(block, st), 2)
  const inline = block.querySelector('.ex-round').querySelector('.pron-badge')
  assert.equal(html(inline), real({ key: 'tear|noun', mp3: 'b.mp3', title: 'tear (noun)', ipa: 'ˈtir', label: 'n.' }))
  // The row's user word "tears" looks up the lemma "tear" and gets every variant.
  const row = block.querySelector('.ex-pron-only-row')
  assert.equal(row.children[1].className, 'pron-variants')
  assert.deepEqual(row.querySelectorAll('.pron-badge').map((b) => b.className), ['pron-badge', 'pron-badge is-picked'])

  inline.classList.add('is-playing')
  assert.equal(X.refreshBadges(block, st), 0)
  assert.equal(block.querySelector('.ex-round').querySelector('.pron-badge'), inline, 'same node, still playing')
  assert.equal(inline.classList.contains('is-playing'), true)
})

test('refreshBadges: failed → AI when the model\'s respelling arrives; an unchanged failure keeps its node', () => {
  const st = X.newPronState()
  st.cache.set('suddenly|adverb', X.pronFailure(404))
  const d = md('it stopped [[PRON word="suddenly" pos="adverb"]].', st)
  const failed = d.querySelector('.pron-badge')
  assert.equal(failed.className, 'pron-badge failed err-none')
  assert.equal(X.refreshBadges(d, st), 0)
  assert.equal(d.querySelector('.pron-badge'), failed, 'identical rebuild: not replaced')
  X.refreshPronMaps(st, ['[[PRON word="suddenly" pos="adverb" ipa="ˈsə-dᵊn-lē"]]'])
  assert.equal(X.refreshBadges(d, st), 1)
  assert.equal(d.querySelector('.pron-badge').className, 'pron-badge ai-made')
})

test('sameNode compares tag, attributes, text and children', () => {
  const a = X.loadingBadge('k|', 'k', '')
  assert.equal(X.sameNode(a, X.loadingBadge('k|', 'k', '')), true)
  assert.equal(X.sameNode(a, X.loadingBadge('k|', 'k', 'noun')), false)
  const b = X.loadingBadge('k|', 'k', '')
  b.children[0].textContent = '..'
  assert.equal(X.sameNode(a, b), false)
  assert.equal(X.sameNode(X.speakerSvg(), X.warnSvg()), false)
})

/* ── the cache ───────────────────────────────────────────────────────────── */

test('storePronData files pron-data under word|, skipping junk', () => {
  const cache = new Map()
  assert.equal(X.storePronData(cache, { Close: { hword: 'close', variants: [{ ipa: 'ˈklōz' }] }, bad: null, odd: { hword: 'odd' } }), 2)
  assert.deepEqual(cache.get('close|'), { hword: 'close', variants: [{ ipa: 'ˈklōz' }] })
  assert.deepEqual(cache.get('odd|'), { hword: 'odd', variants: [] })
  assert.equal(X.storePronData(cache, null), 0)
})

/* ── source conformance ──────────────────────────────────────────────────── */

test('the module has no HTML-string sink, no network and no listeners', () => {
  const code = readFileSync(SRC, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  assert.equal(/innerHTML|outerHTML|insertAdjacentHTML|setHTMLUnsafe|parseHTMLUnsafe|DOMParser|createContextualFragment|document\.write/.test(code), false,
    'an HTML-string sink in src/explain-render.ts')
  assert.equal(/\bfetch\s*\(|XMLHttpRequest|new\s+Audio|addEventListener/.test(code), false,
    'the renderer is pure: I/O and listeners belong to explain.ts')
  assert.equal(/from\s+['"]\.\/icons['"]/.test(code), false, 'the badge glyphs are not icons.ts icon()s')
})
