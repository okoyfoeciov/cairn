/**
 * src/explain-render.ts
 * Owner: 03.  Spec: CONTRACT.md §0.56 E109 — click-to-explain in the EPUB reader.
 *
 * The explanation panel's RENDERER: comart's `panel.js` string renderer
 * (markdown, the `[[PRON]]` / `[[SENSE]]` tags, the Merriam-Webster badge, the
 * pron-only row, the answer-word wrapping) ported to DOM building.  Pure: no
 * network, no listeners, no timers.  `explain.ts` owns the instances (the
 * pron state below) and the I/O; this file only turns text and cached data
 * into nodes.
 *
 * NO HTML STRING EVER REACHES THE DOCUMENT (§6.1).  comart builds HTML and
 * assigns it; here every element comes from `createElement`/`createElementNS`
 * and every piece of model text lands as a Text node.  Model text is
 * untrusted (a book can carry injected instructions), so a `<script>` in an
 * answer is characters on screen.
 *
 * The badge DOM, its classes and attributes are comart's VERBATIM — the
 * frozen badge CSS (explain.css) depends on every one of them.
 */

import type { ExplainItem } from './explain-types'

/* ------------------------------------------------------------------ *
 * Tags and small helpers (comart panel.js:36-53, 98-109, 232-233)
 * ------------------------------------------------------------------ */

/** comart's word: letters/digits with inner apostrophes and hyphens, so
 *  "state-of-the-art", "don't" and "co-op" stay one word. */
export const WORD_RE = /[\p{L}\p{N}](?:[\p{L}\p{N}'’\-]*[\p{L}\p{N}])?/gu
export const PRON_BRACKET_RE = /\[\[PRON\b([^\]]*?)\]\]/g
const ATTR_WORD = /\bword\s*=\s*"([^"]*)"/i
const ATTR_POS = /\bpos\s*=\s*"([^"]*)"/i
const ATTR_IPA = /\bipa\s*=\s*"([^"]*)"/i
/** `[[SENSE p="N"]]`: the model's odds for one reading, a whole percent. */
export const SENSE_BRACKET_RE = /\[\[SENSE\b([^\]]*?)\]\]/g
const ATTR_P = /\bp\s*=\s*"\s*(\d{1,3})\s*%?"/i
export const TAG_OPENERS: readonly string[] = ['[[PRON', '[[SENSE']

/* A Map, not comart's object literal: `posAbbrev("constructor")` must not
 * find Object.prototype. */
const POS_ABBREV: ReadonlyMap<string, string> = new Map([
  ['noun', 'n.'], ['verb', 'v.'], ['adjective', 'adj.'], ['adverb', 'adv.'],
  ['preposition', 'prep.'], ['conjunction', 'conj.'],
  ['interjection', 'interj.'], ['pronoun', 'pron.'],
])

/** Server JSON is untrusted: a missing field is '', never "undefined". */
const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v))

/** Strip the slashes/brackets a model wraps a respelling in. */
export const normIpa = (s: unknown): string =>
  str(s).trim().replace(/^[\\/\[]+|[\\/\]]+$/g, '').trim()
/** A respelling with stress marks, dots, hyphens and spaces removed. */
export const ipaSkeleton = (s: unknown): string =>
  normIpa(s).toLowerCase().replace(/[ˈˌ.\-\s]/g, '')
/** "noun (2)" → "noun". */
export const posHead = (pos: unknown): string => str(pos).toLowerCase().split(/[\s(]/)[0] ?? ''
/** "verb" → "v."; a part of speech outside the eight gets no label. */
export const posAbbrev = (pos: unknown): string => POS_ABBREV.get(posHead(pos)) ?? ''

/** One `[[PRON …]]` tag's attributes.  `word` and `pos` are required. */
export interface PronAttrs {
  word: string
  pos: string
  ipa: string
}

/** Parse a `[[PRON` tag body; null when `word` or `pos` is missing. */
export function parsePronAttrs(body: string): PronAttrs | null {
  const w = ATTR_WORD.exec(body)
  const p = ATTR_POS.exec(body)
  if (!w || !p) return null
  const i = ATTR_IPA.exec(body)
  return { word: w[1] ?? '', pos: p[1] ?? '', ipa: i ? normIpa(i[1]) : '' }
}

/** The pron cache key, `word|pos` lowercased.  pron-data arrives keyed on
 *  the word alone (`close|`); a lazy `/api/pron` is keyed under the pos the
 *  model committed to (`close|adjective`).  `prefetchedRealFor` bridges them. */
export const badgeKey = ({ word, pos }: { word: string; pos: string }): string =>
  `${str(word).toLowerCase()}|${str(pos).toLowerCase()}`

/* ------------------------------------------------------------------ *
 * Pronunciation state (comart panel.js:160-233; explain.ts owns it)
 * ------------------------------------------------------------------ */

/** ai-service `mw.Variant`.  Optional throughout: it is parsed JSON. */
export interface MwVariant {
  pos?: string
  posList?: string[]
  num?: string
  ipa?: string
  mp3?: string
}

/** A real Merriam-Webster answer: pron-data's `{hword, variants}`, or
 *  `/api/pron`'s flat LookupResult (ipa/mp3/pos at the top level too). */
export interface PronData {
  error?: undefined
  hword?: string
  pos?: string
  num?: string
  syllables?: string
  ipa?: string
  mp3?: string
  variants?: MwVariant[]
}

/** A cached lookup failure.  404 → `notfound`; anything else (502, a thrown
 *  fetch) → `unavailable`. */
export interface PronFailure {
  error: true
  reason: 'notfound' | 'unavailable'
}

export type PronEntry = PronData | PronFailure

/** Everything a badge is chosen from, all of it one thread's: the host
 *  empties `cache` when a thread starts, because the related-form bridge
 *  scans all of it, and refills the two word maps from the thread's own tags
 *  with `refreshPronMaps`. */
export interface PronState {
  /** `badgeKey` → MW data or a cached failure. */
  cache: Map<string, PronEntry>
  /** Lowercased word → the pos of its FIRST `[[PRON]]` in the thread. */
  posByWord: Map<string, string>
  /** Lowercased word → the ipa of its FIRST `[[PRON]]` in the thread. */
  llmIpaByWord: Map<string, string>
}

export function newPronState(): PronState {
  return { cache: new Map(), posByWord: new Map(), llmIpaByWord: new Map() }
}

export function isPronFailure(e: PronEntry | null | undefined): e is PronFailure {
  return !!e && !!(e as { error?: unknown }).error
}

/** The entry to cache for a failed `/api/pron` (status, or a thrown error). */
export function pronFailure(status: unknown): PronFailure {
  return { error: true, reason: status === 404 ? 'notfound' : 'unavailable' }
}

/** File an SSE `pron-data` payload's `prons` under `word|` (the server looked
 *  each word up without a pos).  Returns how many entries were stored. */
export function storePronData(cache: Map<string, PronEntry>, prons: unknown): number {
  if (!prons || typeof prons !== 'object') return 0
  let n = 0
  for (const [w, bundle] of Object.entries(prons as Record<string, unknown>)) {
    if (!bundle || typeof bundle !== 'object') continue
    const b = bundle as { hword?: unknown; variants?: unknown }
    cache.set(badgeKey({ word: w, pos: '' }), {
      hword: str(b.hword),
      variants: Array.isArray(b.variants) ? (b.variants as MwVariant[]) : [],
    })
    n += 1
  }
  return n
}

/** Refill `posByWord` / `llmIpaByWord` from every `[[PRON]]` in `sources`
 *  (the committed rounds' texts, then the live buffer). */
export function refreshPronMaps(st: PronState, sources: readonly string[]): void {
  st.posByWord.clear()
  st.llmIpaByWord.clear()
  for (const src of sources) {
    if (!src) continue
    for (const m of src.matchAll(PRON_BRACKET_RE)) {
      const attrs = parsePronAttrs(m[1] ?? '')
      if (!attrs) continue
      const w = attrs.word.toLowerCase()
      // FIRST wins, never last: one word may carry two badges (noun and verb
      // under the Ambiguity rule), senses come most-likely first, and
      // last-wins lit the less likely reading in the row above the answer.
      if (w && attrs.pos && !st.posByWord.has(w)) st.posByWord.set(w, attrs.pos)
      if (w && attrs.ipa && !st.llmIpaByWord.has(w)) st.llmIpaByWord.set(w, attrs.ipa)
    }
  }
}

/** The streaming buffer minus a tag that is still arriving, so half of one
 *  never flashes.  The LAST opener wins: an earlier closed tag must not mask
 *  a later open one. */
export function visibleBuffer(buffer: string): string {
  let open = -1
  for (const tag of TAG_OPENERS) open = Math.max(open, buffer.lastIndexOf(tag))
  return open >= 0 && buffer.indexOf(']]', open) < 0 ? buffer.slice(0, open) : buffer
}

/** POS narrows first; the model's own respelling then breaks ties between
 *  same-POS homographs (*tear*: ˈter and ˈtir, both nouns). */
export function chooseVariantIdx(variants: readonly MwVariant[], head: string, llmIpa: string): number {
  const all = variants.map((_, i) => i)
  const posPool = head
    ? all.filter((i) => posListOf(variants[i]).some((p) => posHead(p) === head))
    : []
  const pool = posPool.length ? posPool : all
  if (pool.length === 1) return pool[0] ?? 0
  const want = ipaSkeleton(llmIpa)
  if (want) {
    const exact = pool.find((i) => ipaSkeleton(variants[i]?.ipa) === want)
    if (exact != null) return exact
  }
  return pool[0] ?? 0
}

const posListOf = (v: MwVariant | undefined): string[] =>
  v && Array.isArray(v.posList) ? v.posList.map(str) : []

/** A real pron already cached under a related surface form.  The server
 *  looks MW up under the word the USER marked ("effects"), the model tags
 *  the base form ("effect"); without this bridge the same word shows a real
 *  badge in the row and an AI badge inline.  Do not delete it as
 *  reconciliation cruft.  Exact word first, then the entry MW filed under
 *  this headword, then an inflected form (see `inflectedPair`). */
export function prefetchedRealFor(cache: ReadonlyMap<string, PronEntry>, word: string): PronData | null {
  const lw = str(word).toLowerCase()
  let near: PronData | null = null
  for (const [k, v] of cache) {
    if (!v || isPronFailure(v) || !Array.isArray(v.variants)) continue
    const bar = k.indexOf('|')
    const w = bar < 0 ? k : k.slice(0, bar)
    if (!w) continue
    if (w === lw) return v
    if (!near && (str(v.hword).toLowerCase() === lw || inflectedPair(w, lw))) near = v
  }
  return near
}

const INFLECTION_RE = /^(?:s|es|d|ed|ing|['\u2019]s)$/

/** One word is the other plus an inflection ("effect"/"effects").  comart
 *  took any shared 3+ letter prefix, so "state" played for "statement" and
 *  "onerous" for "on"; a learner hears the clip as the word's sound, so a
 *  near miss falls to a real lookup instead. */
export function inflectedPair(a: string, b: string): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  return short.length >= 3 && long.startsWith(short) && INFLECTION_RE.test(long.slice(short.length))
}

/** The key the pron-only row looks a USER's word up under: the model's
 *  tagged form of the same word when there is one ("effects" → "effect"), so
 *  the row and the inline badge cannot disagree.  The row still prints the
 *  user's word. */
export function lemmaForUserWord(st: PronState, userWord: string): string {
  const lw = str(userWord).toLowerCase()
  if (st.posByWord.has(lw)) return lw
  for (const x of st.posByWord.keys()) {
    if (inflectedPair(x, lw)) return x
  }
  return userWord
}

/* ------------------------------------------------------------------ *
 * DOM helpers
 * ------------------------------------------------------------------ */

const SVG_NS = 'http://www.w3.org/2000/svg'

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

function svgEl(tag: 'svg' | 'path' | 'circle', attrs: readonly (readonly [string, string])[]): SVGElement {
  const e = document.createElementNS(SVG_NS, tag)
  for (const [k, v] of attrs) e.setAttribute(k, v)
  return e
}

/* ------------------------------------------------------------------ *
 * Badges (comart panel.js:1652-1838)
 * ------------------------------------------------------------------ */

/** The speaker glyph, comart's exact attributes.  NOT `icons.ts icon()`:
 *  its stroke defaults would outline the filled speaker body. */
export function speakerSvg(): SVGElement {
  const svg = svgEl('svg', [['class', 'speaker'], ['viewBox', '0 0 24 24'], ['aria-hidden', 'true']])
  svg.append(
    svgEl('path', [['d', 'M11 5 7 9H4a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h3l4 4z'], ['fill', 'currentColor']]),
    svgEl('path', [
      ['d', 'M15.5 8.5a5 5 0 0 1 0 7'], ['fill', 'none'], ['stroke', 'currentColor'],
      ['stroke-width', '2'], ['stroke-linecap', 'round'],
    ]),
  )
  return svg
}

/** The warning glyph of the two failure badges. */
export function warnSvg(): SVGElement {
  const svg = svgEl('svg', [['class', 'warn'], ['viewBox', '0 0 24 24'], ['aria-hidden', 'true']])
  svg.append(
    svgEl('path', [
      ['d', 'M12 4 2.5 20h19L12 4z'], ['fill', 'none'], ['stroke', 'currentColor'],
      ['stroke-width', '2'], ['stroke-linejoin', 'round'],
    ]),
    svgEl('path', [
      ['d', 'M12 10v4.4'], ['fill', 'none'], ['stroke', 'currentColor'],
      ['stroke-width', '2'], ['stroke-linecap', 'round'],
    ]),
    svgEl('circle', [['cx', '12'], ['cy', '17.6'], ['r', '1.15'], ['fill', 'currentColor']]),
  )
  return svg
}

export interface RealBadgeSpec {
  key: string
  ipa: string
  mp3: string
  /** `posAbbrev` of the label pos; '' prints no `.badge-pos`. */
  label: string
  hword: string
  pos: string
  fallbackPos: string
  picked?: boolean
}

/** A real Merriam-Webster badge: plays `data-mp3` (explain.ts wires it). */
export function realBadge(b: RealBadgeSpec): HTMLButtonElement {
  const title = `${b.hword} (${b.pos || b.fallbackPos || ''})`.trim().replace(/\s*\(\)$/, '')
  const btn = el('button')
  btn.setAttribute('type', 'button')
  btn.className = b.picked ? 'pron-badge is-picked' : 'pron-badge'
  btn.setAttribute('data-key', b.key)
  btn.setAttribute('data-mp3', b.mp3 || '')
  btn.setAttribute('title', title)
  btn.setAttribute('aria-label', `Play pronunciation ${b.ipa}`)
  if (b.label) btn.append(el('span', 'badge-pos', b.label))
  btn.append(el('span', 'ipa', b.ipa), speakerSvg())
  return btn
}

/** The violet "≈ … AI" badge: MW has no pronunciation (404) but the model
 *  gave a respelling — shown, and marked unmistakably as generated. */
export function aiBadge({ word, ipa, pos }: PronAttrs, st: PronState): HTMLButtonElement {
  const labelPos = pos || st.posByWord.get(word.toLowerCase()) || ''
  const label = posAbbrev(labelPos)
  const title = `Approximate pronunciation for "${word}"` +
    (labelPos ? ` (${labelPos})` : '') + ' — generated by AI, not from Merriam-Webster'
  const btn = el('button')
  btn.setAttribute('type', 'button')
  btn.className = 'pron-badge ai-made'
  btn.setAttribute('disabled', '')
  btn.setAttribute('title', title)
  btn.setAttribute('data-word', word)
  btn.setAttribute('data-pos', pos || '')
  btn.setAttribute('aria-label', `AI-made approximate pronunciation ${ipa}, not from a dictionary`)
  if (label) btn.append(el('span', 'badge-pos', label))
  const approx = el('span', 'approx', '≈')
  approx.setAttribute('aria-hidden', 'true')
  const tag = el('span', 'ai-tag', 'AI')
  tag.setAttribute('aria-hidden', 'true')
  btn.append(approx, el('span', 'ipa', ipa), tag)
  return btn
}

/** The explicit failure badge: red "pron unavailable" (could not reach MW)
 *  or amber "no pron" (MW answered and has none, and the model gave no ipa).
 *  Never the bare word, which would read like a real result. */
export function failedBadge(word: string, pos: string, reason: PronFailure['reason']): HTMLButtonElement {
  const unreachable = reason !== 'notfound'
  const title = unreachable
    ? `Couldn't reach Merriam-Webster for "${word}" — pronunciation unavailable, try again later`
    : `Merriam-Webster has no pronunciation for "${word}"`
  const btn = el('button')
  btn.setAttribute('type', 'button')
  btn.className = unreachable ? 'pron-badge failed err-mw' : 'pron-badge failed err-none'
  btn.setAttribute('disabled', '')
  btn.setAttribute('title', title)
  btn.setAttribute('data-word', word)
  btn.setAttribute('data-pos', pos || '')
  btn.append(warnSvg(), el('span', 'err-label', unreachable ? 'pron unavailable' : 'no pron'))
  return btn
}

/** Nothing cached yet: the placeholder explain.ts turns into `/api/pron`. */
export function loadingBadge(key: string, word: string, pos: string): HTMLButtonElement {
  const btn = el('button')
  btn.setAttribute('type', 'button')
  btn.className = 'pron-badge loading'
  btn.setAttribute('data-key', key)
  btn.setAttribute('data-word', word)
  btn.setAttribute('data-pos', pos || '')
  btn.setAttribute('disabled', '')
  btn.append(el('span', 'dot-loader', '…'))
  return btn
}

export interface BadgeAttrs extends PronAttrs {
  /** Every MW variant side by side, the chosen one `.is-picked` (the
   *  pron-only row).  An inline badge is the single chosen variant. */
  multi?: boolean
}

/** comart's `badgeHtml`: cache → related-form bridge → real (single, or
 *  `span.pron-variants` when `multi`) → AI / "no pron" / "pron unavailable"
 *  → loading placeholder. */
export function badgeFor({ word, pos, ipa, multi = false }: BadgeAttrs, st: PronState): HTMLElement {
  const key = badgeKey({ word, pos })
  const lw = str(word).toLowerCase()
  let cached = st.cache.get(key)
  const llmIpa = (ipa && normIpa(ipa)) || st.llmIpaByWord.get(lw) || ''
  // Nothing usable under this exact key: reuse a real pron already in hand
  // for a related form rather than re-fetch or fall to the AI badge.
  if (!cached || isPronFailure(cached)) {
    const reuse = prefetchedRealFor(st.cache, word)
    if (reuse) cached = reuse
  }
  if (cached && !isPronFailure(cached)) {
    const hit = cached
    // pron-data sends variants only; /api/pron also answers flat.
    const variants: MwVariant[] = Array.isArray(hit.variants) && hit.variants.length
      ? hit.variants.map((v) => (v && typeof v === 'object' ? v : {}))
      : [{ ipa: str(hit.ipa), mp3: str(hit.mp3), posList: hit.pos ? [str(hit.pos)] : [] }]
    const committedPos = pos || st.posByWord.get(lw) ||
      st.posByWord.get(str(hit.hword).toLowerCase()) || ''
    const head = posHead(committedPos)
    const pickedIdx = chooseVariantIdx(variants, head, llmIpa)
    const hword = str(hit.hword) || word
    if (!multi || variants.length <= 1) {
      const v = variants[pickedIdx] ?? {}
      const posList = posListOf(v)
      const labelPos = (head && posList.find((p) => posHead(p) === head)) || posList[0] || str(hit.pos)
      return realBadge({
        key, ipa: str(v.ipa), mp3: str(v.mp3), label: posAbbrev(labelPos),
        hword, pos: labelPos, fallbackPos: pos,
      })
    }
    const wrap = el('span', 'pron-variants')
    variants.forEach((v, i) => {
      const labelPos = posListOf(v)[0] || str(hit.pos)
      wrap.append(realBadge({
        key: `${key}#${i}`, ipa: str(v.ipa), mp3: str(v.mp3), label: posAbbrev(labelPos),
        hword, pos: labelPos, fallbackPos: pos,
        picked: !!committedPos && i === pickedIdx,
      }))
    })
    return wrap
  }
  if (cached && isPronFailure(cached)) {
    // notfound is permanent, so the model's respelling stands in (marked as
    // AI); unavailable is an outage, which a guess must not paper over.
    if (cached.reason === 'notfound' && llmIpa) return aiBadge({ word, ipa: llmIpa, pos }, st)
    return failedBadge(word, pos, cached.reason)
  }
  return loadingBadge(key, word, pos)
}

/** The row above an answer: one `span.ex-pron-only-row` per distinct picked
 *  word, the user's word in bold beside its badge(s).  Null when there are
 *  no words. */
export function pronOnlyBlock(items: readonly ExplainItem[], st: PronState): HTMLDivElement | null {
  const seen = new Set<string>()
  const block = el('div', 'ex-pron-only')
  for (const it of items) {
    for (const w of it.words ?? []) {
      const lw = str(w).toLowerCase()
      if (seen.has(lw)) continue
      seen.add(lw)
      const row = el('span', 'ex-pron-only-row')
      row.append(
        el('strong', undefined, w),
        badgeFor({ word: lemmaForUserWord(st, w), pos: '', ipa: '', multi: true }, st),
      )
      block.append(row)
    }
  }
  return seen.size ? block : null
}

/** The sense chip: neutral, never a button — a chip that looked clickable
 *  next to a badge that is would read as a broken badge. */
export function senseOdds(pct: number): HTMLSpanElement {
  const title = `About ${pct} readers in 100 would read the passage this way` +
    ' — the model\'s own estimate, not a dictionary fact'
  const chip = el('span', pct >= 50 ? 'sense-odds lead' : 'sense-odds', `${pct}%`)
  chip.setAttribute('title', title)
  chip.setAttribute('aria-label', title)
  return chip
}

/** Upgrade `.loading`, `.ai-made` and `.failed` badges under `root` in place
 *  once data has landed; a badge whose fresh build is identical is left
 *  alone.  Real badges are never rebuilt (the word maps are first-wins, so
 *  they cannot go stale, and a rebuild would drop `.is-playing`).  Returns
 *  how many were replaced. */
export function refreshBadges(root: ParentNode, st: PronState): number {
  let n = 0
  for (const btn of Array.from(root.querySelectorAll<HTMLElement>(
    '.pron-badge.loading, .pron-badge.ai-made, .pron-badge.failed'))) {
    const word = btn.getAttribute('data-word') || ''
    if (!word) continue
    const pos = btn.getAttribute('data-pos') || ''
    const multi = !!btn.closest('.ex-pron-only')
    const fresh = badgeFor({ word, pos, ipa: st.llmIpaByWord.get(word.toLowerCase()) || '', multi }, st)
    if (sameNode(fresh, btn)) continue
    btn.replaceWith(fresh)
    n += 1
  }
  return n
}

/** Structural equality (tag, attributes, children, text): comart compared
 *  serialized HTML, which this file never produces. */
export function sameNode(a: Node, b: Node): boolean {
  if (a.nodeType !== b.nodeType) return false
  if (a.nodeType === 3) return (a as Text).data === (b as Text).data
  if (a.nodeType !== 1) return false
  const x = a as Element
  const y = b as Element
  if (x.tagName !== y.tagName) return false
  const names = x.getAttributeNames()
  if (names.length !== y.getAttributeNames().length) return false
  for (const k of names) if (x.getAttribute(k) !== y.getAttribute(k)) return false
  const xs = x.childNodes
  const ys = y.childNodes
  if (xs.length !== ys.length) return false
  for (let i = 0; i < xs.length; i += 1) {
    const xi = xs[i]
    const yi = ys[i]
    if (!xi || !yi || !sameNode(xi, yi)) return false
  }
  return true
}

/* ------------------------------------------------------------------ *
 * Inline markdown (comart panel.js:1250-1411)
 * ------------------------------------------------------------------ */

/* Stash sentinels, comart's: U+0001 badges and chips, U+0002 inline code,
 * U+0003 links.  U+0001 and not spaces: with space delimiters two tags one
 * space apart cannot both match (the first eats the space the second needs).
 * Bold/italic become the noncharacters U+FDD0-U+FDD3 (open/close strong,
 * open/close em) where comart wrote `<strong>`/`<em>`; the same regexes see
 * single characters where comart saw tags, so they match identically. */
const B_OPEN = '\uFDD0'
const B_CLOSE = '\uFDD1'
const I_OPEN = '\uFDD2'
const I_CLOSE = '\uFDD3'
const OWN_MARKS = /[\uFDD0-\uFDD3]/g
const TOKEN_RE = /\u0001(\d+)\u0001|\u0002(\d+)\u0002|\u0003(\d+)\u0003|[\uFDD0-\uFDD3]/g

type Stash = (piece: Node | string) => string

/** Inline code: a run of N backticks pairs with the next run of exactly N.
 *  Lifted out first, so a `[[PRON]]` or `*` inside code stays literal. */
function replaceInlineCode(s: string, stash: Stash): string {
  let out = ''
  let i = 0
  while (i < s.length) {
    const open = s.indexOf('`', i)
    if (open < 0) { out += s.slice(i); break }
    out += s.slice(i, open)
    let n = 1
    while (s[open + n] === '`') n += 1
    let close = open + n
    let found = -1
    while (close < s.length) {
      const c = s.indexOf('`', close)
      if (c < 0) break
      let cn = 1
      while (s[c + cn] === '`') cn += 1
      if (cn === n) { found = c; break }
      close = c + cn
    }
    if (found < 0) { out += s.slice(open); break }
    let code = s.slice(open + n, found)
    if (code.startsWith(' ') && code.endsWith(' ') && code.trim()) code = code.slice(1, -1)
    out += stash(el('code', undefined, code))
    i = found + n
  }
  return out
}

/** Only http(s) becomes a link; javascript:, data: and relative stay text. */
function httpHref(raw: string): string {
  try {
    const u = new URL(raw.trim())
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : ''
  } catch {
    return ''
  }
}

function linkPiece(label: string, rawHref: string): Node | string {
  const href = httpHref(rawHref)
  if (!href) return label
  const a = el('a', 'ex-link', label)
  a.setAttribute('href', href)
  // explain.ts routes the click to open_external; these keep a missed
  // preventDefault from ever navigating the app window itself.
  a.setAttribute('target', '_blank')
  a.setAttribute('rel', 'noopener noreferrer')
  return a
}

/** `[label](https://…)` with balanced parentheses in the destination, so
 *  …/wiki/Claude_(language_model) keeps its `)`. */
function replaceMarkdownLinks(s: string, stash: Stash): string {
  let out = ''
  let i = 0
  while (i < s.length) {
    const open = s.indexOf('[', i)
    if (open < 0) { out += s.slice(i); break }
    // An image (![alt](url)) stays text: there is no image path here.
    if (open > 0 && s[open - 1] === '!') { out += s.slice(i, open + 1); i = open + 1; continue }
    const close = s.indexOf('](', open + 1)
    if (close < 0) { out += s.slice(i, open + 1); i = open + 1; continue }
    const label = s.slice(open + 1, close)
    // A stashed code/badge token or a nested bracket is not a plain label.
    if (!label || label.includes('[') || label.includes(']') || label.includes('\n') ||
        label.includes('\u0001') || label.includes('\u0002')) {
      out += s.slice(i, open + 1)
      i = open + 1
      continue
    }
    let j = close + 2
    if (!/^https?:\/\//i.test(s.slice(j))) { out += s.slice(i, open + 1); i = open + 1; continue }
    const hrefStart = j
    let depth = 1
    for (; j < s.length; j += 1) {
      const ch = s[j]
      if (ch === '\\') { j += 1; continue }
      if (ch === '(') depth += 1
      else if (ch === ')' && --depth === 0) break
    }
    if (depth !== 0) { out += s.slice(i, open + 1); i = open + 1; continue }
    out += s.slice(i, open)
    out += stash(linkPiece(label, s.slice(hrefStart, j)))
    i = j + 1
  }
  return out
}

type RenderBadge = (attrs: PronAttrs) => Node

function inline(src: string, renderBadge: RenderBadge): DocumentFragment {
  const badges: (Node | string)[] = []
  const code: (Node | string)[] = []
  const links: (Node | string)[] = []
  const into = (list: (Node | string)[], mark: string): Stash => (piece) => {
    list.push(piece)
    return `${mark}${list.length - 1}${mark}`
  }
  let s = src.replace(OWN_MARKS, '')
  s = replaceInlineCode(s, into(code, '\u0002'))
  const stash = into(badges, '\u0001')
  s = s.replace(PRON_BRACKET_RE, (_m, body: string) => {
    const attrs = parsePronAttrs(body)
    return attrs ? stash(renderBadge(attrs)) : ' '
  })
  s = s.replace(SENSE_BRACKET_RE, (_m, body: string) => {
    const m = ATTR_P.exec(body)
    if (!m) return ' '
    const pct = Number(m[1])
    if (!(pct >= 1 && pct <= 100)) return ' '
    return stash(senseOdds(pct))
  })
  // After code and badges, so a URL inside either stays literal.  A bare URL
  // with no label is deliberately left as text.
  s = replaceMarkdownLinks(s, into(links, '\u0003'))
  s = s.replace(/\*\*([^*]+)\*\*/g, `${B_OPEN}$1${B_CLOSE}`)
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, `$1${I_OPEN}$2${I_CLOSE}`)
  // A badge or chip eats ONE space on each side: it spaces itself with its
  // own margin, so `**word** [[PRON]]: gloss` sits word·badge·colon.
  s = s.replace(/ ?\u0001(\d+)\u0001 ?/g, '\u0001$1\u0001')
  return assemble(s, badges, code, links)
}

/* Text between tokens is buffered so a run that comart's parser would hold
 * as ONE text node stays one here (the answer-word wrapper splits per node). */
function assemble(s: string, badges: (Node | string)[], code: (Node | string)[], links: (Node | string)[]): DocumentFragment {
  const frag = document.createDocumentFragment()
  const stack: (DocumentFragment | HTMLElement)[] = [frag]
  let text = ''
  const flush = (): void => {
    if (text) (stack[stack.length - 1] ?? frag).append(document.createTextNode(text))
    text = ''
  }
  const put = (piece: Node | string | undefined): void => {
    if (piece === undefined) return
    if (typeof piece === 'string') { text += piece; return }
    flush()
    // A sentinel the model itself typed can name a placeholder twice; comart
    // printed its HTML twice, so the second use is a copy, not a move.
    ;(stack[stack.length - 1] ?? frag).append(piece.parentNode ? piece.cloneNode(true) : piece)
  }
  const close = (tag: string): void => {
    flush()
    for (let k = stack.length - 1; k > 0; k -= 1) {
      if ((stack[k] as HTMLElement).tagName === tag) { stack.length = k; return }
    }
  }
  TOKEN_RE.lastIndex = 0
  let last = 0
  let m: RegExpExecArray | null
  while ((m = TOKEN_RE.exec(s)) !== null) {
    text += s.slice(last, m.index)
    last = TOKEN_RE.lastIndex
    if (m[1] !== undefined) put(badges[Number(m[1])])
    else if (m[2] !== undefined) put(code[Number(m[2])])
    else if (m[3] !== undefined) put(links[Number(m[3])])
    else if (m[0] === B_OPEN || m[0] === I_OPEN) {
      const e = el(m[0] === B_OPEN ? 'strong' : 'em')
      put(e)
      stack.push(e)
    } else close(m[0] === B_CLOSE ? 'STRONG' : 'EM')
  }
  text += s.slice(last)
  flush()
  return frag
}

/** One line of answer text → inline DOM (bold, italic, code, http(s) links,
 *  `[[PRON]]` badges, `[[SENSE]]` chips). */
export function renderInline(src: string, st: PronState): DocumentFragment {
  return inline(src, (attrs) => badgeFor(attrs, st))
}

/* ------------------------------------------------------------------ *
 * Block markdown (comart panel.js:1418-1600)
 * ------------------------------------------------------------------ */

/** A one-line numbered list ("1. … 2. … 3. …"), split.  Conservative: the
 *  markers must count up, and "2.5" or "in 2020." never match. */
function splitInlineNumberedList(line: string): { intro: string; items: string[] } | null {
  const marks: { start: number; num: number; textStart: number }[] = []
  const re = /(^|\s)(\d{1,2})[.)]\s+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line)) !== null) {
    marks.push({ start: m.index, num: Number(m[2]), textStart: m.index + m[0].length })
  }
  const first = marks.findIndex((x) => x.num === 1)
  if (first < 0) return null
  const run = [marks[first]!]
  let want = 2
  for (let i = first + 1; i < marks.length; i += 1) {
    const mk = marks[i]!
    if (mk.num !== want) continue
    run.push(mk)
    want += 1
  }
  if (run.length < 2) return null
  const intro = line.slice(0, run[0]!.start).trim()
  const items: string[] = []
  for (let i = 0; i < run.length; i += 1) {
    const end = i + 1 < run.length ? run[i + 1]!.start : line.length
    items.push(line.slice(run[i]!.textStart, end).trim())
  }
  return { intro, items }
}

interface MdItem { text: string; children: MdList[] }
interface MdList { tag: 'ol' | 'ul'; indent: number; start: number; items: MdItem[] }

/* A list item owns its nested lists; an `ol` keeps the model's first number. */
function listEl(list: MdList, rb: RenderBadge): HTMLElement {
  const node = el(list.tag)
  if (list.tag === 'ol' && list.start > 1) node.setAttribute('start', String(list.start))
  for (const it of list.items) {
    const li = el('li')
    li.append(inline(it.text, rb))
    for (const c of it.children) li.append(listEl(c, rb))
    node.append(li)
  }
  return node
}

function indentWidth(ws: string): number {
  let n = 0
  for (const ch of ws) n = ch === '\t' ? n + 4 - (n % 4) : n + 1
  return n
}

/** An answer (or the visible part of a streaming one) → block DOM:
 *  paragraphs, `> ` blockquotes (a blank line separates quote boxes), nested
 *  ordered/unordered lists, fenced code (`pre.ex-code > code`, no Copy). */
export function renderMarkdown(src: string, st: PronState): DocumentFragment {
  const rb: RenderBadge = (attrs) => badgeFor(attrs, st)
  const out = document.createDocumentFragment()
  // Paragraphs and quotes buffer per block and a blank line ends either.
  // Lists close only when a different block arrives: a blank line between
  // items is still one (loose) list, so a numbered answer keeps counting.
  let bufP: string[] = []
  let bufQ: string[] = []
  let roots: MdList[] = []
  let stack: MdList[] = []
  let afterBlank = false

  const flushP = (): void => {
    if (!bufP.length) return
    const p = el('p')
    p.append(inline(bufP.join(' '), rb))
    out.append(p)
    bufP = []
  }
  const flushQ = (): void => {
    if (!bufQ.length) return
    const q = el('blockquote')
    bufQ.forEach((line, i) => {
      if (i) q.append(el('br'))
      q.append(inline(line, rb))
    })
    out.append(q)
    bufQ = []
  }
  const flushLists = (): void => {
    for (const list of roots) out.append(listEl(list, rb))
    roots = []
    stack = []
  }
  // Nesting is "further right", never a fixed width (the model indents by
  // two as often as four); the same depth with the other marker starts a
  // sibling list instead of retagging the open one.
  const addItem = (indent: number, tag: 'ol' | 'ul', num: number, text: string): void => {
    while (stack.length && indent < stack[stack.length - 1]!.indent) stack.pop()
    let level = stack[stack.length - 1]
    const list: MdList = { tag, indent, start: num, items: [] }
    if (level && indent > level.indent) {
      const owner = level.items[level.items.length - 1]
      owner?.children.push(list)
      stack.push(list)
      level = list
    } else if (level && indent === level.indent && level.tag !== tag) {
      stack.pop()
      const parent = stack[stack.length - 1]
      const owner = parent && parent.items[parent.items.length - 1]
      if (owner) owner.children.push(list)
      else roots.push(list)
      stack.push(list)
      level = list
    } else if (!level) {
      roots.push(list)
      stack.push(list)
      level = list
    }
    level.items.push({ text, children: [] })
  }

  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  for (let lineNo = 0; lineNo < lines.length; lineNo += 1) {
    const ln = (lines[lineNo] ?? '').replace(/\s+$/, '')
    if (!ln.trim()) {
      flushP()
      flushQ()
      afterBlank = true
      continue
    }
    const wasBlank = afterBlank
    afterBlank = false

    // A fence is consumed whole before any other rule sees its lines; an
    // unclosed one is still code, so a streaming block never flashes as prose.
    const fence = /^\s*(`{3,}|~{3,})(.*)$/.exec(ln)
    if (fence) {
      flushP(); flushQ(); flushLists()
      const mark = fence[1] ?? '```'
      const closeRe = new RegExp(`^\\s*${mark[0]}{${mark.length},}\\s*$`)
      const code: string[] = []
      let j = lineNo + 1
      for (; j < lines.length; j += 1) {
        const line = lines[j] ?? ''
        if (closeRe.test(line)) break
        code.push(line)
      }
      const pre = el('pre', 'ex-code')
      pre.append(el('code', undefined, code.join('\n')))
      out.append(pre)
      lineNo = j
      continue
    }

    const q = /^>\s?(.*)$/.exec(ln)
    if (q) { flushP(); flushLists(); bufQ.push(q[1] ?? ''); continue }
    // Before the item regex: "1. a 2. b" begins like a single item.
    const inlineList = splitInlineNumberedList(ln)
    if (inlineList) {
      flushP(); flushQ(); flushLists()
      if (inlineList.intro) {
        const p = el('p')
        p.append(inline(inlineList.intro, rb))
        out.append(p)
      }
      const ol = el('ol')
      for (const it of inlineList.items) {
        const li = el('li')
        li.append(inline(it, rb))
        ol.append(li)
      }
      out.append(ol)
      continue
    }
    const li = /^(\s*)(?:(\d+)[.)]|[-*+])\s+(.*)$/.exec(ln)
    if (li) {
      flushP(); flushQ()
      addItem(indentWidth(li[1] ?? ''), li[2] !== undefined ? 'ol' : 'ul',
        li[2] !== undefined ? Number(li[2]) : 1, li[3] ?? '')
      continue
    }
    // A wrapped line belongs to the item above; after a blank line an
    // indented line is a new paragraph, which closes the list.
    if (!wasBlank && stack.length && /^\s+\S/.test(ln)) {
      const level = stack[stack.length - 1]!
      const item = level.items[level.items.length - 1]
      if (item) { item.text += ' ' + ln.trim(); continue }
    }
    flushLists(); flushQ()
    bufP.push(ln)
  }
  flushP(); flushQ(); flushLists()
  return out
}

/* ------------------------------------------------------------------ *
 * Panel pieces (comart panel.js:2026-2045, 2253-2257)
 * ------------------------------------------------------------------ */

/** One round: `div.ex-round-block[data-round=k]` (`.ex-divided` after the
 *  first) holding the pron-only row for `items`, then `div.ex-round`
 *  (`.ex-live` while streaming) with the answer.  Pass `visibleBuffer(…)` as
 *  `text` for the live round. */
export function roundBlock(
  text: string,
  items: readonly ExplainItem[],
  k: number,
  live: boolean,
  st: PronState,
): HTMLDivElement {
  const block = el('div', k > 0 ? 'ex-round-block ex-divided' : 'ex-round-block')
  block.setAttribute('data-round', String(k))
  const pron = pronOnlyBlock(items, st)
  if (pron) block.append(pron)
  const round = el('div', live ? 'ex-round ex-live' : 'ex-round')
  round.append(renderMarkdown(text, st))
  block.append(round)
  return block
}

/** The waiting dots shown until the first chunk. */
export function thinkingDots(): HTMLDivElement {
  const box = el('div', 'ex-thinking')
  box.setAttribute('role', 'status')
  box.setAttribute('aria-label', 'Waiting for the explanation')
  box.append(el('span'), el('span'), el('span'))
  return box
}

/** The error line — the only text the panel prints unprompted. */
export function errorLine(message: string): HTMLParagraphElement {
  return el('p', 'ex-err', message)
}

/* ------------------------------------------------------------------ *
 * Answer words (comart panel.js:2311-2380)
 * ------------------------------------------------------------------ */

/* Never a drill-down target: the live round (its text changes every chunk),
 * badge text, the pron-only row, an already wrapped word, a sense chip (its
 * "70%" is metadata, not a word), the error line, a fenced code block, and a
 * link (a citation, not a word to explain).  Inline `code` stays pickable, as
 * in comart. */
function skipsWords(e: Element): boolean {
  if (e.tagName.toUpperCase() === 'A') return true
  const c = e.classList
  return (c.contains('ex-round') && c.contains('ex-live')) || c.contains('pron-badge') ||
    c.contains('ex-pron-only') || c.contains('ex-word') || c.contains('sense-odds') ||
    c.contains('ex-err') || c.contains('ex-code')
}

const NO_MARKS: ReadonlySet<string> = new Set()

/** Wrap every `WORD_RE` word of the committed answers under `root` in
 *  `span.ex-word[data-word][data-rid]` (`rid` = `<lower>#<occurrence>`),
 *  `.is-marked` when its rid is in `marks`.  Idempotent: wrapped words, the
 *  live round and the exclusions above are skipped.  Pass the whole
 *  `.ex-content` — the occurrence counter is seeded from the rids already
 *  under `root`, so a word in a new round cannot reuse an old round's id. */
export function wrapResponseWords(root: Element, marks: ReadonlySet<string> = NO_MARKS): void {
  for (let n: Node | null = root; n; n = n.parentNode) {
    if (n.nodeType === 1 && skipsWords(n as Element)) return
  }
  const texts: Text[] = []
  const collect = (node: Node): void => {
    for (const c of Array.from(node.childNodes)) {
      if (c.nodeType === 3) texts.push(c as Text)
      else if (c.nodeType === 1 && !skipsWords(c as Element)) collect(c)
    }
  }
  collect(root)

  const counter = new Map<string, number>()
  for (const sp of Array.from(root.querySelectorAll('.ex-word[data-rid]'))) {
    const rid = sp.getAttribute('data-rid') || ''
    const hash = rid.lastIndexOf('#')
    if (hash < 0) continue
    const occ = Number(rid.slice(hash + 1))
    if (!Number.isInteger(occ)) continue
    const lower = rid.slice(0, hash)
    counter.set(lower, Math.max(counter.get(lower) ?? 0, occ + 1))
  }

  for (const tn of texts) {
    const text = tn.data
    const parent = tn.parentNode
    if (!text || !parent) continue
    const re = new RegExp(WORD_RE.source, WORD_RE.flags)
    let m: RegExpExecArray | null
    let last = 0
    let any = false
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) parent.insertBefore(document.createTextNode(text.slice(last, m.index)), tn)
      const w = m[0]
      const lower = w.toLowerCase()
      const occ = counter.get(lower) ?? 0
      counter.set(lower, occ + 1)
      const rid = `${lower}#${occ}`
      const span = el('span', 'ex-word', w)
      span.setAttribute('data-word', w)
      span.setAttribute('data-rid', rid)
      if (marks.has(rid)) span.classList.add('is-marked')
      parent.insertBefore(span, tn)
      last = re.lastIndex
      any = true
    }
    if (!any) continue
    if (last < text.length) parent.insertBefore(document.createTextNode(text.slice(last)), tn)
    tn.remove()
  }
}
