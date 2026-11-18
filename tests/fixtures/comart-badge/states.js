/*
 * tests/fixtures/comart-badge/states.js -- the badge states, built by the REAL
 * builders.  Owner: electron-shell/explain-badge.test.mjs.
 *
 * Both test pages load this file after an esbuild bundle of
 * `src/explain-render.ts` (global `CairnExplainRender`), so the reference page
 * and the Cairn page get the same DOM from the same code.  Every badge goes
 * through `badgeFor` / `pronOnlyBlock`, the functions the panel calls, fed a
 * pron cache shaped like ai-service's answers.  Eleven states: real, real
 * with no label, AI, loading, both failure badges, playing, a picked and a
 * dimmed variant, a long row badge, and a real badge the model put inside
 * the bold word (`**word [[PRON]]**`) -- with IPA that mixes Lora glyphs and
 * per-glyph fallbacks (ˈ, ə, t͟h, u̇, ≈), as nearly every real badge does.
 *
 * No network: `data-mp3` is an attribute, and nothing here plays it.
 */
'use strict'
window.badgeCells = function badgeCells(R) {
  const MP3 = 'https://media.merriam-webster.com/audio/prons/en/us/mp3/c/close001.mp3'
  const st = R.newPronState()
  const real = (word, pos, ipa) => st.cache.set(R.badgeKey({ word, pos }),
    { hword: word, variants: [{ pos, posList: [pos], ipa, mp3: MP3 }] })
  real('surveil', 'verb', 'sər-ˈvāl')
  real('the', 'definite article', 't͟hə') // no POS_ABBREV entry: no `.badge-pos`
  real('tear', 'noun', 'ˈtir')
  st.cache.set('suddenly|adverb', R.pronFailure(404)) // + the model's ipa: the AI badge
  st.cache.set('foo|', R.pronFailure(404)) // no ipa: amber "no pron"
  st.cache.set('bar|', R.pronFailure(502)) // red "pron unavailable"
  st.cache.set('close|', { hword: 'close', variants: [
    { pos: 'verb', posList: ['verb'], ipa: 'ˈklōz', mp3: MP3 },
    { pos: 'adjective', posList: ['adjective'], ipa: 'ˈklōs', mp3: MP3 },
  ] })
  st.cache.set('bureaucracy|', { hword: 'bureaucracy', variants: [
    { pos: 'noun', posList: ['noun'], ipa: 'byu̇-ˈrä-krə-sē', mp3: MP3 },
  ] })
  st.posByWord.set('close', 'verb') // the model committed to the verb: it is picked

  /* An inline badge sits straight after the bolded word (the sentinel rule
     eats the spaces) with the gloss after it, as the model writes it. */
  const inline = (cell, word, attrs, gloss, after, inBold = false) => ({
    cell, kind: 'inline', word, gloss, inBold,
    build() { const b = R.badgeFor(attrs, st); if (after) after(b); return b },
  })
  const row = (cell, word) => ({
    cell, kind: 'row',
    build() { return R.pronOnlyBlock([{ phrase: word, words: [word] }], st) },
  })
  return [
    inline('in-real', 'surveil', { word: 'surveil', pos: 'verb', ipa: 'sər-ˈvāl' }, ': to watch closely.'),
    inline('in-nolabel', 'the', { word: 'the', pos: 'definite article', ipa: '' }, ': ordinary.'),
    inline('in-ai', 'suddenly', { word: 'suddenly', pos: 'adverb', ipa: 'ˈsə-dᵊn-lē' }, ': quickly.'),
    inline('in-loading', 'xyz', { word: 'xyz', pos: '', ipa: '' }, ': loading.'),
    inline('in-none', 'foo', { word: 'foo', pos: '', ipa: '' }, ': none.'),
    inline('in-mw', 'bar', { word: 'bar', pos: '', ipa: '' }, ': outage.'),
    inline('in-playing', 'tear', { word: 'tear', pos: 'noun', ipa: 'ˈtir' }, ': playing.',
      (b) => b.classList.add('is-playing')),
    row('row-close', 'close'), // two badges: the picked verb, the dimmed adjective
    row('row-real', 'bureaucracy'),
    inline('in-bold', 'surveil', { word: 'surveil', pos: 'verb', ipa: 'sər-ˈvāl' }, ': in bold.', null, true),
  ]
}

/* The eleven badges, in cell order: [state name, cell, index of the badge in it]. */
window.BADGE_STATES = [
  ['real', 'in-real', 0], ['no label', 'in-nolabel', 0], ['AI', 'in-ai', 0],
  ['loading', 'in-loading', 0], ['no pron', 'in-none', 0], ['pron unavailable', 'in-mw', 0],
  ['playing', 'in-playing', 0], ['picked variant', 'row-close', 0],
  ['dimmed variant', 'row-close', 1], ['long row badge', 'row-real', 0],
  ['in bold', 'in-bold', 0],
]
