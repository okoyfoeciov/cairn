/**
 * src/bookpick.ts
 * Owner: 03.  Spec: CONTRACT.md §0.56 E109 — click-to-explain in the EPUB reader.
 *
 * Pure string functions behind the reader's word pick: what a word is, which
 * word an index falls in, and the passage sent to ai-service with it.  They run
 * over the reader's normalized text (`chapterText()` in reader.ts: whitespace
 * collapsed per text node, `\n` at block boundaries), so every offset maps
 * straight back to a DOM range through its runs.  No DOM here.
 *
 * Ported from comart's content.js (WORD_RE, sentenceRanges, contextWindow,
 * scanContext).  Where it differs, it is because a book is not a web page:
 *   · WORD_RE keeps combining marks (`\p{M}`) inside a word, so a decomposed
 *     "café" is one word, and lets a soft hyphen (U+00AD, `&shy;` in typeset
 *     books) sit inside one.  The returned word text drops the soft hyphen.
 *   · A sentence also ends after closing quotes or brackets (`.”`, `?"`, `!)`);
 *     comart's split ran a quoted sentence into the one after it.
 *   · Sentences are split per block and blank blocks are not sentences, so
 *     the ±5 window counts real sentences across paragraphs.
 *   · The passage joins sentences of one block with a space and blocks with
 *     `\n` (comart flattened paragraphs), squashes whitespace runs and drops
 *     soft hyphens, so the picked words appear in it verbatim.
 *   · When even the sentences the pick touches exceed the cap, the cut is
 *     centred on the pick and kept off half words; comart cut from the start
 *     and could lose the word.
 *   · The orientation prefix is the book's title, author and chapter, not
 *     `document.title`.
 */

/** Longest phrase one drag may pick (comart's MAX_WORDS: the ±7 clamp). */
export const MAX_WORDS = 8
/** Sentences of context on each side of the pick. */
export const SENT_WINDOW = 5
/** Characters; the window shrinks until the passage fits. */
export const CONTEXT_CAP = 2500

/** comart's tokenizer plus combining marks and soft hyphens.  A word starts and
 *  ends with a letter or digit (each with its marks) and may carry apostrophes
 *  and hyphens inside, so "state-of-the-art", "don't" and "co-op" stay single
 *  words — Intl.Segmenter splits them, which is wrong for a learner.  Global:
 *  use `matchAll` or a copy, never `exec` on the shared instance. */
export const WORD_RE = /[\p{L}\p{N}]\p{M}*(?:[\p{L}\p{N}\p{M}'’\-\u00AD]*[\p{L}\p{N}]\p{M}*)?/gu

/** A word in the text, `[from, to)` in the text's own offsets. */
export interface PickWord {
  from: number
  /** Exclusive; soft hyphens inside the word are counted. */
  to: number
  /** The word as ai-service gets it: soft hyphens removed. */
  text: string
}

/** A sentence, `[from, to)`.  Sentences tile each block except a blank tail. */
export interface Sentence {
  from: number
  to: number
  /** The `\n`-separated block it sits in, counted from 0. */
  block: number
}

/** What `buildPassage` puts in front of the context; '' omits a part. */
export interface PassageMeta {
  title: string
  author: string
  chapter: string
}

const SHY = /\u00AD/g
const SPACE = /\s/
const SPACES = /\s+/g
/** Sentence end: terminal marks, any closing quotes or brackets, then space. */
const SENT_END = /[.!?…]+["'”’»›)\]]*\s+/g
/** Private copy for `wordAt`, whose `lastIndex` it owns. */
const SCAN = new RegExp(WORD_RE.source, WORD_RE.flags)

/** Every word in `text`, in order. */
export function wordsIn(text: string): PickWord[] {
  const out: PickWord[] = []
  for (const m of text.matchAll(WORD_RE)) {
    const from = m.index ?? 0
    out.push({ from, to: from + m[0].length, text: m[0].replace(SHY, '') })
  }
  return out
}

/** The word whose `[from, to)` contains `index`, else null.  An index on a
 *  word's end (a caret after its last letter) is outside it. */
export function wordAt(text: string, index: number): PickWord | null {
  if (!(index >= 0 && index < text.length)) return null
  // A word never holds whitespace, so matching from just after the last space
  // gives the same words as matching from the start of the text.
  let start = Math.floor(index)
  while (start > 0 && !SPACE.test(text[start - 1]!)) start--
  SCAN.lastIndex = start
  let m: RegExpExecArray | null
  while ((m = SCAN.exec(text)) !== null && m.index <= index) {
    const to = m.index + m[0].length
    if (index < to) return { from: m.index, to, text: m[0].replace(SHY, '') }
  }
  return null
}

/** comart's offset-preserving sentence split, run per block (`\n`), so a block
 *  end is always a sentence end.  Whitespace-only remainders are not
 *  sentences: pretty-printed XHTML leaves a blank block between paragraphs. */
export function sentenceRanges(text: string): Sentence[] {
  const out: Sentence[] = []
  let at = 0
  let block = 0
  for (const line of text.split('\n')) {
    let start = 0
    for (const m of line.matchAll(SENT_END)) {
      const end = (m.index ?? 0) + m[0].length
      out.push({ from: at + start, to: at + end, block })
      start = end
    }
    if (/\S/.test(line.slice(start))) out.push({ from: at + start, to: at + line.length, block })
    at += line.length + 1
    block++
  }
  return out
}

/** The passage around `[from, to)` (offsets into `text`, one chapter): the
 *  sentences the range touches plus up to SENT_WINDOW on each side, the pad
 *  shrinking until the passage fits CONTEXT_CAP.  Never longer than the cap. */
export function contextWindow(text: string, from: number, to: number): string {
  const sents = sentenceRanges(text)
  if (sents.length === 0) return ''
  const a = Math.min(Math.max(0, from), text.length)
  const b = Math.max(Math.min(Math.max(0, to), text.length), a + 1)
  let lo = -1
  let hi = -1
  for (let i = 0; i < sents.length; i++) {
    const s = sents[i]!
    if (a < s.to && b > s.from) {
      if (lo < 0) lo = i
      hi = i
    }
  }
  if (lo < 0) {
    // A range on a block break or blank block: the next sentence stands in.
    lo = sents.findIndex((s) => s.from >= a)
    if (lo < 0) lo = sents.length - 1
    hi = lo
  }
  for (let pad = SENT_WINDOW; pad > 0; pad--) {
    const out = joinSentences(text, sents, Math.max(0, lo - pad), Math.min(sents.length - 1, hi + pad), lo, hi, a, b)
    if (out.text.length <= CONTEXT_CAP) return out.text
  }
  const base = joinSentences(text, sents, lo, hi, lo, hi, a, b)
  return base.text.length <= CONTEXT_CAP ? base.text : centredCut(base)
}

/** `context` with the book's orientation in front — `title — author`, then the
 *  chapter — only when the whole still fits CONTEXT_CAP: the context is never
 *  cut or dropped to make room (comart's scanContext). */
export function buildPassage(context: string, meta: PassageMeta): string {
  const title = tidy(meta.title).trim()
  const author = tidy(meta.author).trim()
  let chapter = tidy(meta.chapter).trim()
  // comart's scanPrefix: an over-long heading is not a title, and the title is
  // not said twice.  Equality, not comart's substring test: chapters named
  // "I" or "1" sit inside most titles.  comart also dropped a prefix that
  // contains the whole context; not here, since that is when the context is
  // shortest and the orientation matters most.
  if (chapter.length > 300 || chapter.toLowerCase() === title.toLowerCase()) chapter = ''
  const prefix = [[title, author].filter(Boolean).join(' — '), chapter].filter(Boolean).join('\n')
  if (!prefix) return context
  if (!context) return prefix
  if (context.includes(prefix)) return context
  return prefix.length + 2 + context.length <= CONTEXT_CAP ? prefix + '\n\n' + context : context
}

/** Squash whitespace runs and drop soft hyphens: the passage's spelling. */
function tidy(s: string): string {
  return s.replace(SHY, '').replace(SPACES, ' ')
}

interface Joined {
  text: string
  /** `[at, end)` is the pick inside `text`. */
  at: number
  end: number
}

/** Sentences `lo..hi`, a space inside a block and `\n` between blocks, and
 *  where the pick (`[from, to)`, touching sentences `pickLo..pickHi`) lands. */
function joinSentences(
  text: string, sents: Sentence[], lo: number, hi: number,
  pickLo: number, pickHi: number, from: number, to: number,
): Joined {
  let out = ''
  let at = 0
  let end = 0
  let block = -1
  for (let i = lo; i <= hi; i++) {
    const s = sents[i]!
    const body = tidy(text.slice(s.from, s.to)).trim()
    if (!body) continue
    if (out) out += s.block === block ? ' ' : '\n'
    block = s.block
    // Offsets go through the same tidy as the body, so they stay aligned.
    const lead = (cut: number): number => tidy(text.slice(s.from, cut)).replace(/^ /, '').length
    if (i === pickLo) at = out.length + lead(Math.max(s.from, from))
    if (i === pickHi) end = out.length + Math.min(body.length, lead(Math.min(s.to, to)))
    out += body
  }
  return { text: out, at, end: Math.max(at, end) }
}

/** How far a cut edge may move to reach whitespace: past any real word, short
 *  of eating a run of unspaced text (CJK, a URL). */
const SNAP = 40

/** A CONTEXT_CAP window centred on the pick, its edges moved in to the nearest
 *  whitespace so no half word is sent, unless that would cut into the pick. */
function centredCut(j: Joined): string {
  const { text, at, end } = j
  let start = Math.floor((at + end) / 2) - CONTEXT_CAP / 2
  start = Math.min(Math.max(0, start), text.length - CONTEXT_CAP)
  let stop = start + CONTEXT_CAP
  if (start > 0 && !SPACE.test(text[start - 1]!)) {
    const sp = text.slice(start, Math.min(at, start + SNAP)).search(/\s/)
    if (sp >= 0) start += sp + 1
  }
  if (stop < text.length && !SPACE.test(text[stop]!)) {
    const from = Math.max(end, stop - SNAP)
    const sp = text.slice(from, stop).search(/\s\S*$/)
    if (sp >= 0) stop = from + sp
  }
  return text.slice(start, stop).trim()
}
