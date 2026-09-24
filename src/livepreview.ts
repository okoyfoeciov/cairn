/**
 * src/livepreview.ts
 * Owner: 03.  Spec: CONTRACT.md §5.3 (the code block), §5.4 (headings),
 * §5.4.1 (heading markers — reveal on the caret line), §5.4.2 (the inline
 * title), §5.4.3 (the construct seam, and what v2 was allowed to add).
 *
 * ===========================================================================
 * v2 LANDED 2026-09-09.  THE CONSTRUCT SET IS NO LONGER LOCKED.
 * ===========================================================================
 * §5.4.1 rule 5 ("in v1 the ONLY constructs found and decorated are ATX
 * headings and fenced code blocks") is DISCHARGED, by user instruction, not
 * quietly widened.  What this file finds and decorates now:
 *
 *   block    ATX heading · fenced code block · thematic break · blockquote
 *            (nested) · bullet list · ordered list
 *   inline   bold · italic · bold-italic · strikethrough · ==highlight== ·
 *            inline code · [text](url) · <autolink> · [[wikilink]] · a BARE url
 *            or email · backslash escape · task checkbox
 *
 * and, still deliberately, NOTHING ELSE.  `![[embed]]`, `#tag`, `[^footnote]`,
 * callouts, math, mermaid, non-pasted images and inline HTML are absent because each of
 * them needs something Cairn does not have (a renderer, a second parser), not
 * because the shape cannot hold them: `ConstructKind` is a union and §4 is a
 * switch.  Pasted clipboard images (`data:` URLs, written by `editor.ts`'s
 * paste handler) are the exception: an `<img>` is a renderer the engine has
 * always had.
 *
 * TABLES ARE IN `tables.ts` (§0.40 E87) and not here, because a table is a
 * BLOCK REPLACEMENT and CM6 refuses one of those from a `ViewPlugin` — the same
 * reason `properties.ts` is its own file.  It renders its CELLS through §3's
 * `inlineIn`, so there is still exactly one inline tokeniser in this app.
 *
 * §0.36 E83 ADDED THE TWO LINK KINDS, 2026-09-12, on a user report — two
 * screenshots of one note, and in Obsidian's both `https://github.com/...` and
 * `[[feedback_pr_review_workflow]]` are accent-coloured and underlined where
 * Cairn drew the raw source.  `[[wikilink]]` was listed here as needing "a
 * metadata cache"; it does not.  A cache decides RESOLVED vs UNRESOLVED
 * (`is-unresolved`, `--link-unresolved-opacity: 0.7`), which is a second
 * colour on a link that already renders — so the cache is what the UNRESOLVED
 * STATE needs, and nothing else was ever waiting on it.  Cairn draws every
 * wikilink resolved; `KNOWN-ISSUES.md` LP-7 carries the state that is missing.
 *
 * THE HEADLINE, AND IT CONTRADICTS THE CONTRACT: §5.4.3 priced v2 at
 * +34,303 B of `@lezer/markdown` and concluded the 360,000 B gate would have
 * to be re-derived at ≥ 382,000 B.  **Obsidian does not use `@lezer/markdown`.**
 * It runs its live preview on a CodeMirror 5 stream mode wrapped in
 * `StreamLanguage` — see §3's header for the grep that shows it — so v2 landed
 * as source, at +6.5 kB and zero new dependencies, INSIDE the gate.  §5.4.3's
 * memory paragraph (a syntax tree at 20-22x the note's bytes) is likewise
 * about a data structure that now does not exist.
 *
 * ---------------------------------------------------------------------------
 * THE THREE RULINGS §1-§5 STILL IMPLEMENT, UNCHANGED:
 *
 *   1. THE CODE BLOCK (§5.3, B8/M34).  One class, `nc-cb`, on EVERY line of the
 *      block, opening fence to closing fence INCLUSIVE.  Fence lines are
 *      ORDINARY code lines — same fill, same font, same ink; only the border
 *      radius distinguishes them, because they happen to be first and last.
 *      No syntax highlighting anywhere in a code block (§9 E4).  Nothing inside
 *      a block is tokenised at all: §3 skips it, as Obsidian's own decorator
 *      does on `hmd-codeblock`.
 *   2. MARKERS ARE HIDDEN, NEVER DELETED (§5.4.1, X17).  A `Decoration.replace`
 *      over the run, and a reveal that OCCUPIES LAYOUT when the selection
 *      reaches it.  What "reaches it" means is now per-kind — §4's
 *      `revealScope`, which is Obsidian's own three-way split, read out of its
 *      decorator rather than guessed.
 *   3. THE INLINE TITLE (§5.4.2, X18).  A CM6 BLOCK WIDGET at document position
 *      0.  Never in `state.doc`, never typed into, never saved, never sent to
 *      write_note.  A note whose first line is `# Misc` shows the title "Misc"
 *      AND an H1 "Misc" below it: the document is rendered UNCHANGED (§2.4).
 *
 * ---------------------------------------------------------------------------
 * THE SEAM (§2), WHICH IS WHY v2 WAS AN ADDITION AND NOT A REWRITE.
 * Finding constructs and decorating them are separate, and they stayed
 * separate through this change:
 *
 *     §2  `ConstructSource` — WHERE the constructs are.  Pure positions.
 *     §3  `markdownSource`  — the implementation: block scanner + inline
 *         tokeniser, both transcribed from Obsidian's own markdown mode.
 *     §4  `buildDecorations` — WHAT they look like.  Consumes §2, and cannot
 *         see a regex, a fence, or a `#` from where it stands.
 *     §5  the inline title.
 *
 * §3 was replaced whole and §2 gained eleven names in one union; §4 gained a
 * switch arm per kind.  No caller outside this file changed, `editor.ts`'s
 * import list included.
 * ---------------------------------------------------------------------------
 * DEVIATION FROM spec-03 §5.2's SNIPPET, DELIBERATE, WITH THE EVIDENCE.
 * spec-03 §7.1 writes
 *     EditorView.atomicRanges.of(view => view.plugin(livePreview)?.decorations)
 * i.e. it hands CM6 the WHOLE decoration set.  Read
 * `node_modules/@codemirror/view/dist/index.js`, `skipAtomicRanges()`:
 *
 *     set.between(pos - 1, pos + 1, (from, to) => { if (pos > from && pos < to) ... })
 *
 * — it does not filter on `point`, on `isReplace`, or on anything else.  So a
 * REVEALED marker, which is a `Decoration.mark` spanning `# `, would be atomic
 * too, and the caret could not be placed inside the very marker §5.4.1 reveals
 * so that it can be edited.  This file therefore keeps a SECOND, much smaller
 * range set containing only the runs that VANISH, and that is what
 * `livePreviewAtomicRanges` hands to CM6.  A marker that is re-drawn in place —
 * a list bullet, a first-level `>` — is NOT in it, because the character is
 * still on screen and the caret must be able to sit beside it.
 * ------------------------------------------------------------------------- */

import { RangeSet, StateEffect, StateField } from '@codemirror/state'
import type { EditorState, Extension, Line, Text, Transaction } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType } from '@codemirror/view'
import type { DecorationSet, ViewUpdate } from '@codemirror/view'

/* ===========================================================================
 * 1.  The markdown model (spec-03 §4).  ATX only, column 0 only, no setext.
 *
 *     This is v1's PARSER, and everything in this section is private to §3's
 *     source.  §4 does not import one symbol from here.  When §3 is swapped for
 *     a `@lezer/markdown` walk, this section goes with it.
 * ========================================================================= */

/** Applied to at most the first 8 characters of a line, never the whole line. */
export const HEADING_RE = /^(#{1,6})[ \t]/

/** Applied to at most the first 200 characters of a line. g1 = fence run, g2 = info. */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/

const HEAD_SLICE = 8
const FENCE_SLICE = 200

const BACKTICK = 96

/** One fence line.  `lineLen` is invariant under changes outside the line. */
export interface Fence {
  pos: number
  lineLen: number
  ch: number
  len: number
  /** A backtick fence whose info string contains a backtick is not a fence at all. */
  canOpen: boolean
  /** A closing fence must have a whitespace-only info string. */
  canClose: boolean
}

/** `to` is the END offset of the closing fence line (or doc end, when unclosed). */
export interface Block {
  from: number
  to: number
}

function fenceAt(pos: number, lineLen: number, head: string): Fence | null {
  const m = FENCE_RE.exec(head)
  if (!m) return null
  const run = m[1] as string
  const info = m[2] as string
  const ch = run.charCodeAt(0)
  const canOpen = ch !== BACKTICK || info.indexOf('`') < 0
  const canClose = info.trim() === ''
  // `\`\`\`a\`b` is neither an opener nor a closer: it is not a fence at all.
  if (!canOpen && !canClose) return null
  return { pos, lineLen, ch, len: run.length, canOpen, canClose }
}

/** CommonMark pairing (spec-03 §4.2).  One linear pass, input already ascending. */
export function pairFences(fences: readonly Fence[], docLength: number): Block[] {
  const blocks: Block[] = []
  let i = 0
  while (i < fences.length) {
    const open = fences[i] as Fence
    if (!open.canOpen) { i++; continue }
    let j = i + 1
    while (j < fences.length) {
      const f = fences[j] as Fence
      if (f.ch === open.ch && f.len >= open.len && f.canClose) break
      j++
    }
    if (j < fences.length) {
      const close = fences[j] as Fence
      blocks.push({ from: open.pos, to: close.pos + close.lineLen })
      i = j + 1
    } else {
      // An unclosed opening fence runs to the end of the document.
      blocks.push({ from: open.pos, to: docLength })
      i = fences.length
    }
  }
  return blocks
}

/** Scan `[lo, hi]` of `doc`, whole lines, appending every fence line found. */
function scanRange(doc: Text, lo: number, hi: number, out: Fence[]): void {
  let pos = lo
  const end = Math.min(hi, doc.length)
  while (pos <= end) {
    const line = doc.lineAt(pos)
    // Never `line.text`: a 5 MB single-line document must not be materialised.
    const head = doc.sliceString(line.from, Math.min(line.from + FENCE_SLICE, line.to))
    const f = fenceAt(line.from, line.to - line.from, head)
    if (f) out.push(f)
    pos = line.to + 1
  }
}

/**
 * The fence positions, kept current incrementally so that "am I inside a code
 * block?" is an O(log B) binary search instead of an O(doc) backwards scan.
 */
export class BlockIndex {
  constructor(readonly fences: readonly Fence[], readonly blocks: readonly Block[]) {}

  static scanAll(doc: Text): BlockIndex {
    const fences: Fence[] = []
    scanRange(doc, 0, doc.length, fences)
    return new BlockIndex(fences, pairFences(fences, doc.length))
  }

  /** The block containing `pos`, or null.  O(log B). */
  blockAt(pos: number): Block | null {
    const b = this.blocks
    let lo = 0
    let hi = b.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const blk = b[mid] as Block
      if (pos < blk.from) hi = mid - 1
      else if (pos > blk.to) lo = mid + 1
      else return blk
    }
    return null
  }

  /**
   * Incremental update.  spec-03 §5.1's algorithm, verbatim:
   *   1 collapse the ChangeSet to one span in each coordinate system
   *   2 expand to whole lines
   *   3 head = fences before it; tail = fences after it, mapped
   *   4 mid  = rescan the changed lines only
   *   5 concatenate (already ascending; no sort)
   *   6 re-pair
   */
  applyChanges(tr: Transaction): BlockIndex {
    const oldDoc = tr.startState.doc
    const newDoc = tr.newDoc
    let fromA = Infinity, toA = -Infinity, fromB = Infinity, toB = -Infinity
    tr.changes.iterChanges((fa, ta, fb, tb) => {
      if (fa < fromA) fromA = fa
      if (ta > toA) toA = ta
      if (fb < fromB) fromB = fb
      if (tb > toB) toB = tb
    })
    if (fromA === Infinity) return this   // no actual change

    const oldLo = oldDoc.lineAt(fromA).from
    const oldHi = oldDoc.lineAt(toA).to
    const newLo = newDoc.lineAt(fromB).from
    const newHi = newDoc.lineAt(toB).to

    const next: Fence[] = []
    for (const f of this.fences) if (f.pos < oldLo) next.push(f)
    scanRange(newDoc, newLo, newHi, next)
    for (const f of this.fences) {
      if (f.pos > oldHi) {
        const pos = tr.changes.mapPos(f.pos, -1)
        next.push({ pos, lineLen: f.lineLen, ch: f.ch, len: f.len, canOpen: f.canOpen, canClose: f.canClose })
      }
    }
    return new BlockIndex(next, pairFences(next, newDoc.length))
  }
}

/**
 * YAML FRONTMATTER: the end of the closing `---` line, or -1.
 *
 * Obsidian's `tP` (app.js, 1.12.7), transcribed — and it is STRICTER than most
 * people assume: line 1 must be EXACTLY `---`, and the block ends at the first
 * later line that is EXACTLY `---`.  Not `--- `, not `----`, not indented.  A
 * note that opens with `----` therefore has no frontmatter and its rule is an
 * ordinary thematic break, which is the behaviour Obsidian has.
 *
 * The length test comes first so that the common case — a note that does not
 * open with `---` — costs one `doc.line(1)` and one integer compare, never a
 * string.  `properties.ts` and §3 both call this on the hot path.
 *
 * `FM_MAX_LINES` is Cairn's, not Obsidian's: `tP` walks to the end of the
 * document, so a 200,000-line note whose first line is `---` and which never
 * closes costs a full scan on every keystroke.  A frontmatter block longer than
 * a thousand lines is not frontmatter.
 */
const FM_MAX_LINES = 1000

export function frontmatterEnd(doc: Text): number {
  if (doc.lines < 2) return -1
  const first = doc.line(1)
  if (first.to - first.from !== 3) return -1
  if (doc.sliceString(0, 3) !== '---') return -1
  const last = doc.lines < FM_MAX_LINES ? doc.lines : FM_MAX_LINES
  for (let n = 2; n <= last; n++) {
    const l = doc.line(n)
    if (l.to - l.from !== 3) continue
    if (doc.sliceString(l.from, l.to) === '---') return l.to
  }
  return -1
}

export const blockIndex = StateField.define<BlockIndex>({
  create: (state) => BlockIndex.scanAll(state.doc),
  update: (value, tr) => (tr.docChanged ? value.applyChanges(tr) : value),
})


/* ===========================================================================
 * 2.  THE SEAM.  Everything §4 is allowed to know about the markdown language.
 *
 *     Positions and kinds.  No `Decoration`, no CSS class, no `EditorView`, no
 *     regex, no syntax tree: a source that answered out of a `@lezer/markdown`
 *     `Tree`, a WASM parser or a lookup table would satisfy this identically.
 * ========================================================================= */

/**
 * WHAT the construct is.  The decorator switches on this and on nothing else.
 *
 * THE v2 SET, LANDED 2026-09-09.  It is not the set §5.4.3 predicted, and the
 * difference is a reading of Obsidian rather than a preference — see §3's
 * header.  `'image'` is a pasted clipboard image (`data:` URL — see
 * `IMAGE_DATA_RE` in §3 and `ImageWidget` in §4).  Still absent, each needing
 * a renderer Cairn does not have: `hmd-embed`, `hashtag` and `footref`.
 * **`hmd-internal-link` IS here now** (§0.36 E83, as `'wikilink'`),
 * and so is Obsidian's bare-url/email linkifier (as `'url'`) — which has no
 * token of its own in the CM5 mode at all: the mode ADDS the class `url` to
 * whatever token it is already emitting.  Cairn makes it a construct because
 * §2 has no other way to carry a span, and the difference is invisible past
 * this seam.
 */
export type ConstructKind =
  /* block */
  | 'heading' | 'codeblock' | 'hr' | 'blockquote' | 'listUl' | 'listOl'
  /* inline */
  | 'task' | 'strong' | 'emphasis' | 'strikethrough' | 'highlight'
  | 'inlineCode' | 'link' | 'autolink' | 'wikilink' | 'url' | 'escape'
  /* a pasted clipboard image */
  | 'image'

/**
 * HOW the construct's own body is decorated.
 *
 *   'line'   — every line the construct spans gets a line decoration
 *              (headings, code blocks, list items, blockquotes).
 *   'inline' — the content gets a mark decoration over a span inside one line
 *              (bold, italic, inline code, links).
 *
 * This is about the BODY only.  Both kinds hide markers the same way, so the
 * reveal rule in §4 is written once and applies to everything.
 */
export type ConstructSpan = 'line' | 'inline'

/**
 * WHERE a marker sits relative to its construct.  `kind` + `role` is what the
 * decorator maps to a treatment, which is why a marker carries no class, no
 * widget and no "hide or replace" flag of its own:
 *
 *   'prefix' — leads the line:      `## `,  `> `,  `- `,  `1. `
 *   'open'   — opens a span:        `**`,  `*`,  `` ` ``,  `[`
 *   'close'  — closes a span:       `**`,  `*`,  `` ` ``,  `](https://…)`
 */
export type MarkerRole = 'prefix' | 'open' | 'close'

/**
 * A run of source text that is PRESENTATION, not content: hidden by default,
 * revealed (never deleted) when the selection reaches it.  WHAT "reaches it"
 * means is per-kind and is §4's decision — see `revealScope`.
 */
export interface Marker {
  readonly from: number
  readonly to: number
  readonly role: MarkerRole
}

/**
 * One construct found in the document.
 *
 * `[from, to]` is the WHOLE construct, markers included; the content is that
 * range minus `markers`, so no separate content range is carried.  `detail` is
 * the kind's one numeric variant — heading level 1-6, blockquote depth, a
 * task's checked bit, and the "this list marker leads a task line" bit — and is
 * 0 for kinds that have none.
 *
 * ── BORROWED, NOT OWNED ────────────────────────────────────────────────────
 * A `Construct` handed to a `ConstructSink`, and its `markers` array, are valid
 * ONLY for the duration of that call.  A source is free to hand out one mutable
 * object per pass, and §3's does.  A consumer that wants to keep a construct
 * must copy the fields it needs.  This is what keeps the hot path — a rebuild
 * on every keystroke and every cursor move — from allocating per construct,
 * which is the same reason the `Decoration` constants in §4 are module-level
 * singletons.
 * ───────────────────────────────────────────────────────────────────────────
 */
export interface Construct {
  readonly kind: ConstructKind
  readonly span: ConstructSpan
  readonly from: number
  readonly to: number
  readonly detail: number
  readonly markers: readonly Marker[]
}

/** Receives constructs.  See the borrow rule above, and rule 3 below. */
export type ConstructSink = (c: Construct) => void

/**
 * The parser seam.  ONE method.
 *
 * CONTRACT ON THE IMPLEMENTATION:
 *   1. Report every construct INTERSECTING `[from, to]`, and no others.  `from`
 *      and `to` are already expanded to whole-line boundaries by the caller.
 *   2. Report each construct EXACTLY ONCE per call, even when it spans many
 *      lines of the range.  (§3's scanner therefore skips to the end of a code
 *      block rather than re-reporting it per line.)
 *   3. Emit in ASCENDING `from` WHERE THAT IS NATURAL, and do not worry about
 *      it where it is not.  ── AMENDED 2026-09-09, and the amendment is the
 *      point: v1's rule read "ascending `from`, outer first", and gave its own
 *      reason — *"§4 feeds a `RangeSetBuilder`, which requires it"*.  §4 no
 *      longer feeds one.  A nested inline construct closes BEFORE its parent
 *      (`**a `b` c**` finishes the code span first), so an end-ordered emission
 *      is what any single-pass inline scanner produces, and forcing `from`
 *      order would mean buffering a line's constructs to sort them — paying an
 *      allocation to satisfy a rule whose only justification has gone.  §4 now
 *      collects into an array and calls `Decoration.set(ranges, sort=true)`,
 *      which is what Obsidian's own live preview does for its widget set.
 *   4. Clip nothing.  A construct starting before `from` or ending after `to`
 *      is reported with its true bounds; §4 clips to the viewport.
 *   5. Do no work proportional to the document.  The caller passes a viewport-
 *      sized range on every keystroke and every cursor move.
 */
export interface ConstructSource {
  constructsIn(state: EditorState, from: number, to: number, sink: ConstructSink): void
}

/* ===========================================================================
 * 3.  THE SOURCE: a line scanner with an inline tokeniser.
 *
 * ── WHY THIS IS NOT A `@lezer/markdown` TREE WALK ──────────────────────────
 * CONTRACT §5.4.3 predicted that v2 would swap this object for a
 * `@lezer/markdown` walk, priced that at +34,303 B, and concluded that the
 * 360,000 B gate would have to be re-derived at ≥ 382,000 B to let v2 land.
 * That whole paragraph rests on an assumption about Obsidian that was never
 * checked against Obsidian.  It is wrong, and §0.17's method is what shows it:
 *
 *     $ node -e '…extract obsidian.asar…'            # 1.12.7, Debian
 *     $ grep -c '@lezer/markdown' app.js
 *     0
 *     app.js:  Z$ = StreamLanguage.define(CodeMirror.getMode({}, {name:"hypermd"}))
 *
 * Obsidian's live preview runs on a CodeMirror **5** stream mode — the stock
 * `markdown` mode with `highlightFormatting`, `taskLists`, `strikethrough` and
 * Obsidian's own `highlight`, wrapped by `@codemirror/language`'s
 * `StreamLanguage` and read back through `tokenClassNodeProp`.  The only
 * `lezer` string in the whole 3.7 MB bundle is the plugin API's module map.
 * A line-at-a-time tokeniser IS Obsidian's answer, so this file's own shape was
 * already the right one and the seam's v2 cost is **0 B of dependency**.
 *
 * ── WHAT WAS PORTED, AND FROM WHERE ────────────────────────────────────────
 * The emphasis flanking test, the code-span run rule, the `~~`/`==` rules and
 * the link rules below are transcriptions of `lib/codemirror/markdown.js`
 * inside that same asar (`inlineNormal`, `getType`), not re-derivations.  The
 * block rules are its `blockNormal`.  Obsidian ships that file unmodified and
 * configures it with `tokenTypeOverrides` — `code: "inline-code"`,
 * `list1/2/3: "list-1/2/3"`, `hr`, `hashtag` — which is why an inline code span
 * lands in `--code-background` and a `##` lands in `--text-faint`.
 *
 * ── THE THREE DELIBERATE DEVIATIONS ────────────────────────────────────────
 *  (a) INLINE STATE IS PER LINE.  CM5's stream carries `em`/`strong`/`code`
 *      across lines inside a paragraph, so Obsidian matches `**foo\nbar**`.
 *      Doing that here would mean scanning back to the paragraph start on every
 *      keystroke, which is seam rule 5's exact prohibition.  A delimiter that
 *      does not close on its own line does not open a construct.
 *  (b) LIST DEPTH IS NOT TRACKED.  CM5 keeps a `listStack` to emit
 *      `list-1/2/3`; grep of `app.css` finds **no rule** for `.cm-list-1`,
 *      `.cm-list-2` or `.cm-list-3`, so those classes change no pixel in
 *      Obsidian's own theme and tracking the stack would buy nothing.
 *  (c) A LINE IS READ AT MOST `INLINE_SLICE` CHARACTERS.  §1 already refuses to
 *      materialise `line.text` for the same reason; a 5 MB single-line document
 *      must not become a 5 MB string on every cursor move.
 * ========================================================================= */

/** `- `, `+ `, `* `, `1. `, `1) `, with their leading indent.  CM5's `listRE`. */
const LIST_RE = /^([ \t]*)([*+-]|\d{1,9}[.)])([ \t]+)/
/** `[ ]` / `[x]`, immediately after a list marker.  CM5's `taskListRE`. */
const TASK_RE = /^\[([ xX])\](?=[ \t]|$)/
/** `***`, `---`, `___` with optional inner spaces.  CM5's `hrRE`. */
const HR_RE = /^ {0,3}([*\-_])(?:[ \t]*\1){2,}[ \t]*$/
/** CM5's `escapableRE`, minus the `\n` case this scanner cannot reach. */
const ESCAPABLE_RE = /[\\`*{}[\]()#+\-.!_>~|"$%&',/:;<=?@^]/
/**
 * CM5 spells its `punctuation` class out as a 2 kB literal of every Unicode
 * punctuation code point.  `\p{P}` is the same set by name and costs 8 bytes;
 * `\p{S}` is CommonMark 0.30's widening of it.  `chrome142` is the build target
 * (build-app.mjs), so the `u` flag's property escapes are unconditionally there.
 */
const PUNCT_RE = /[\p{P}\p{S}]/u
/** A `(…)` immediately after a link's `]`.  CM5 tests `\(.*?\)` non-greedily,
 *  which never crosses a line — so neither does this (F84: a cross-line
 *  replace decoration from a plugin throws in CM6 and wedges the editor). */
const LINK_DEST_RE = /^\([^)\n]*\)/
/* `lib/codemirror/markdown.js:563`'s `/\[[^\]]*\] ?(?:\(|\[)/` lookahead, plus
 * the destination its `linkHref` state then consumes — see the `BANG` branch in
 * §3.  The inline destination is `LINK_DEST_RE`'s body so the two agree on what
 * a destination is, and the reference form (`![alt][ref]`, space optional) is
 * carried because Obsidian's lookahead accepts it. */
const IMAGE_RUN_RE = /^\[[^\]\n]*\](?:\([^)\n]*\)| ?\[[^\]\n]*\])/
/* Pasted clipboard images, and ONLY those: `editor.ts`'s paste handler writes
 * `![pasted image](data:…)` on Ctrl/Cmd-V.  `[^)\n]*` never crosses a line
 * (F84), so a data URL carrying a `)` — an SVG one can — falls through to the
 * raw-source skip below rather than rendering half an image. */
const IMAGE_DATA_RE = /^!\[([^\]\n]*)\]\((data:image\/[^)\n]+)\)/

/* §0.36 E83 — THE TWO LINK RULES, AND BOTH ARE OBSIDIAN'S OWN LITERALS.
 *
 * They are NOT in `lib/codemirror/markdown.js`: that file's only autolink is
 * `<https://…>` in angle brackets (its `linkInline` branch), and it has no
 * `hmd-` token at all.  Both live in Obsidian's own `hypermd` mode, defined in
 * `app.js` — `window.CodeMirror.defineMode("hypermd", …)` — which wraps the
 * stock mode and adds these on top of its tokens.
 *
 * ── the wikilink ──────────────────────────────────────────────────────────
 * Obsidian looks ahead with `/^(!?\[\[)(.*?)]]/` and, on a match, emits
 * `formatting-link formatting-link-start` over the `[[`, sets
 * `state.hasAlias = inner.contains("|")`, then per character inside: `|` ->
 * `link-alias-pipe`, the text before it -> `link-has-alias`, the text after ->
 * `link-alias`, and `]]` -> `formatting-link formatting-link-end`.  Its
 * decorator then hides `D = formatting-link || link-has-alias ||
 * link-alias-pipe` and underlines `M = hmd-internal-link && !link-has-alias &&
 * !link-alias-pipe && !hmd-embed`.  **So the target and the pipe of an aliased
 * link are hidden with the brackets**, which is why the open marker here is
 * `[[` PLUS `target|` and not just `[[`.
 *
 * `.*?` never crosses a line, so a wikilink must close on its own line — the
 * same bound seam rule 5 puts on everything else here, and Obsidian's too.
 *
 * `!` IS EXCLUDED.  `![[x]]` is `hmd-embed`, which renders the embedded note;
 * Cairn has no renderer for that, and hiding an embed's brackets to draw a
 * link that is not an embed would be worse than leaving the source visible.
 *
 * ── the bare url and the bare email ───────────────────────────────────────
 * `URL_RE` and `EMAIL_RE` are `rU` and `oU` transcribed CHARACTER FOR
 * CHARACTER, including the IANA scheme list.  `rU` is the well-known "liberal"
 * URL pattern; it is 1.0 kB and none of it is Cairn's, which is the point — a
 * hand-narrowed `https?://\S+` would linkify a different set of strings than
 * the app being cloned, and every difference would be a defect report.
 *
 * ONE CHANGE, AND IT IS MECHANICAL: the leading `^` is dropped and the `y`
 * flag added.  Obsidian matches with CM5's `stream.match`, which anchors at
 * the stream position; Cairn scans one string with an index, and a sticky
 * regex anchored at `lastIndex` is the same operation without the `text.slice`
 * allocation an `^`-anchored one would need at every word.
 *
 * The mode's own guard is transcribed too: `y = g && !(state.code ||
 * state.indentedCode || state.linkHref)` and
 * `state.hmdLinkType || state.image || state.linkText || …` — so neither rule
 * runs inside a code span, inside a link's text, or inside its destination.
 */
const WIKILINK_RE = /^\[\[(.*?)\]\]/
/* §0.39 E86 — `<https://…>` and `<name@host>`, CM5's own two, transcribed from
 * `lib/codemirror/markdown.js` (its `inlineNormal`, the only autolink the stock
 * mode HAS — the bare-url rule above is Obsidian's wrapper, §0.36 E83).  Both
 * are applied AFTER the `<`, which is where CM5 applies them: `ch =
 * stream.next()` has already taken it when `stream.match(re, false)` peeks.
 *
 * `(https?|ftps?)` and NOT the 1.0 kB scheme list: an angle autolink is a
 * narrower construct than a bare url in Obsidian, and this is its rule. */
const AUTOLINK_RE = /^(https?|ftps?):\/\/(?:[^\\>]|\\.)+>/
const AUTOEMAIL_RE = /^[^> \\]+@(?:[^\\>]|\\.)+>/
const URL_RE = /(?:(?:(?:aaas?|about|acap|adiumxtra|af[ps]|aim|apt|attachment|aw|beshare|bitcoin|bolo|callto|cap|chrome(?:-extension)?|cid|coap|com-eventbrite-attendee|content|crid|cvs|data|dav|dict|dlna-(?:playcontainer|playsingle)|dns|doi|dtn|dvb|ed2k|facetime|feed|file|finger|fish|ftp|geo|gg|git|gizmoproject|go|gopher|gtalk|h323|hcp|https?|iax|icap|icon|im|imap|info|ipn|ipp|irc[6s]?|iris(?:\.beep|\.lwz|\.xpc|\.xpcs)?|itms|jar|javascript|jms|keyparc|lastfm|ldaps?|magnet|mailto|maps|market|message|mid|mms|ms-help|msnim|msrps?|mtqp|mumble|mupdate|mvn|news|nfs|nih?|nntp|notes|oid|opaquelocktoken|palm|paparazzi|platform|pop|pres|proxy|psyc|query|res(?:ource)?|rmi|rsync|rtmp|rtsp|secondlife|service|session|sftp|sgn|shttp|sieve|sips?|skype|sm[bs]|snmp|soap\.beeps?|soldat|spotify|ssh|steam|svn|tag|teamspeak|tel(?:net)?|tftp|things|thismessage|tip|tn3270|tv|udp|unreal|urn|ut2004|vemmi|ventrilo|view-source|webcal|wss?|wtai|wyciwyg|xcon(?:-userid)?|xfire|xmlrpc\.beeps?|xmpp|xri|ymsgr|z39\.50[rs]?):(?:\/{1,3}|[a-z0-9%])|www\d{0,3}[.]|[a-z0-9.\-]+[.][a-z]{2,4}\/)(?:[^\s()<>]|\([^\s()<>]*\))+(?:\([^\s()<>]*\)|[^\s`*!()\[\]{};:'".,<>?«»“”‘’]))/iy
const EMAIL_RE = /(?:(?:[^<>()[\]\\.,;:\s@\"`]+(?:\.[^<>()[\]\\.,;:\s@\"]+)*)|(?:\".+\"))@(?:(?:\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(?:(?:[a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))\b/y
/** `lU` — the mode tries a URL only where the next character is a letter. */
const URL_HEAD_RE = /[a-z]/i
/** The email branch's own guard: any character that is not one of these. */
const EMAIL_HEAD_RE = /[\s<>()[\]\\.,;:\s@"`]/
/**
 * F85: `EMAIL_RE`'s first local-part alternative alone, CHARACTER FOR
 * CHARACTER — edit the two together. After a failed attempt at `i` it says
 * how far that attempt's local part reached: no position inside that reach
 * can match either, because a local part starting there extends back to `i`,
 * and `i` already failed. Skipping them keeps a long delimiter-free run
 * linear.
 */
const EMAIL_LOCAL_RE = /[^<>()[\]\\.,;:\s@\"`]+(?:\.[^<>()[\]\\.,;:\s@\"]+)*/y

const INLINE_SLICE = 20_000
/** Enough to classify a line's block prefix; see `prefixed`. */
const CLASSIFY_SLICE = 400
/** How far `paragraphStart` may walk back.  Seam rule 5's bound. */
const PARA_LOOKBACK = 200
/** Up to three spaces then `>`.  CM5's `state.indentation <= maxNonCodeIndentation`. */
const QUOTE_HEAD_RE = /^ {0,3}>/

const SPACE = 32
const TAB = 9
const GT = 62
const STAR = 42
const UNDERSCORE = 95
const TILDE = 126
const EQUALS = 61
const BACKSLASH = 92
const LBRACKET = 91
const RBRACKET = 93
const BANG = 33
const LT = 60
const COLON = 58
const SLASH = 47
const DOT = 46
const DASH = 45

/** `[A-Za-z0-9.-]` — every character a url's scheme or its host can be made of. */
function isUrlRunCharCode(ch: number): boolean {
  return (ch >= 48 && ch <= 57) || (ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122)
    || ch === DOT || ch === DASH
}

/** `www\d{0,3}[.]`, the one branch of `URL_RE` that needs no `:` and no `/`. */
function isWww(text: string, i: number, n: number): boolean {
  if (i + 3 >= n) return false
  return (text.charCodeAt(i) | 32) === 119
    && (text.charCodeAt(i + 1) | 32) === 119
    && (text.charCodeAt(i + 2) | 32) === 119
}

const NO_MARKERS: readonly Marker[] = []

/** Internal mutable views of §2's read-only shapes — see the borrow rule. */
type MutableMarker = { -readonly [K in keyof Marker]: Marker[K] }
type MutableConstruct = { -readonly [K in keyof Construct]: Construct[K] }

function isSpaceChar(ch: string | undefined): boolean {
  return ch === undefined || ch === ' ' || ch === '\t'
}

class MarkdownSource implements ConstructSource {
  /** One construct object, one marker per slot, for the lifetime of the app. */
  private readonly pool: MutableMarker[] = []
  /** `slots[n-1]` is a frozen-length view of `pool[0..n)`; see `slot()`. */
  private readonly slots: (readonly Marker[])[] = []
  private readonly c: MutableConstruct = {
    kind: 'heading', span: 'line', from: 0, to: 0, detail: 0, markers: NO_MARKERS,
  }
  private sink: ConstructSink = () => {}
  /** The range `constructsIn` was asked for — see `emit`'s rule-1 filter. */
  private rangeFrom = 0
  private rangeTo = 0

  /**
   * §0.40 E87 — THE SAME INLINE TOKENISER, OVER A BARE STRING.
   *
   * `tables.ts` renders a table CELL, and a cell's text is inline markdown:
   * `` `apps/client` `` is inline code in Obsidian's table and backticks in a
   * table that renders its cells as plain text.  This is how it gets the one
   * parser instead of a second one — `KNOWN-ISSUES.md` LP-2 listed tables as
   * needing "a second parser or a renderer", and the parser half was already
   * here, one private method below the seam.
   *
   * NO `EditorState`, so NO block index: a cell is not a line and cannot open a
   * fence, a heading or a list.  Only `scanInline` runs, which is exactly the
   * set a cell can contain.
   */
  inlineIn(text: string, sink: ConstructSink): void {
    this.sink = sink
    this.rangeFrom = 0
    this.rangeTo = text.length
    this.scanInline(0, text, 0)
  }

  constructsIn(state: EditorState, from: number, to: number, sink: ConstructSink): void {
    const idx = state.field(blockIndex)
    const doc = state.doc
    this.sink = sink
    this.rangeFrom = from
    this.rangeTo = to
    // Nothing inside YAML frontmatter is markdown.  Without this its `---`
    // delimiters are two thematic breaks and its `key: value` lines are
    // ordinary text, which is exactly what Cairn drew before §5.4.5.
    const fmEnd = frontmatterEnd(doc)

    let pos = this.paragraphStart(doc, idx, from, fmEnd)
    while (pos <= to) {
      const line = doc.lineAt(pos)
      if (line.from < fmEnd) { pos = fmEnd + 1; continue }
      const blk = idx.blockAt(line.from)
      if (blk) {
        // Emitted ONCE for the whole block (seam rule 2); code lines never have
        // their text read at all, and nothing inside one is tokenised (CM5's
        // `hmd-codeblock` short-circuit, and §9 E4's no-highlighting ruling).
        this.emit('codeblock', 'line', blk.from, blk.to, 0, 0)
        pos = blk.to + 1
        continue
      }
      if (this.prefixed(doc, line, idx)) {
        this.scanLine(doc, line)
        pos = line.to + 1
        continue
      }
      // A PARAGRAPH, not a line.  See `scanInline`'s header: CM5 carries
      // `em`/`strong`/`code` across the lines of one paragraph, so `**foo\nbar**`
      // is bold in Obsidian, and a per-line scanner renders the `**` raw.  Hard-
      // wrapped notes hit that on almost every paragraph.
      let last = line
      for (;;) {
        const nextPos = last.to + 1
        if (nextPos > doc.length) break
        const next = doc.lineAt(nextPos)
        if (next.from === last.from) break
        if (next.to - line.from > INLINE_SLICE) break
        if (idx.blockAt(next.from)) break
        if (this.prefixed(doc, next, idx)) break
        last = next
      }
      this.scanInline(line.from, doc.sliceString(line.from, last.to), 0)
      pos = last.to + 1
    }
  }

  /**
   * Does this line open a block — a blank, a quote, an hr, a heading, a list?
   * Anything that answers `false` is paragraph text and joins its neighbours.
   *
   * Read at most `CLASSIFY_SLICE` characters: this runs per line on the hot
   * path and a 5 MB single-line document must not be materialised for it (§1's
   * rule).  A line longer than the slice cannot be an hr — `HR_RE` is anchored
   * at both ends — so the truncation is stated in the test rather than hidden.
   */
  private prefixed(doc: Text, line: Line, idx: BlockIndex): boolean {
    const len = line.to - line.from
    if (len === 0) return true
    if (idx.blockAt(line.from)) return true
    const head = doc.sliceString(line.from, line.from + (len > CLASSIFY_SLICE ? CLASSIFY_SLICE : len))
    if (QUOTE_HEAD_RE.test(head)) return true
    if (len <= CLASSIFY_SLICE && HR_RE.test(head)) return true
    if (HEADING_RE.test(head.length > HEAD_SLICE ? head.slice(0, HEAD_SLICE) : head)) return true
    return LIST_RE.test(head)
  }

  /**
   * Walk back to the first line of the paragraph `from` sits in, so a paragraph
   * that starts above the viewport is tokenised with the state it really has
   * rather than with a fresh one.
   *
   * BOUNDED, because seam rule 5 is not negotiable: at most `PARA_LOOKBACK`
   * lines and `INLINE_SLICE` characters.  A paragraph longer than either is
   * scanned from partway in, and the only consequence is that an emphasis run
   * opened before the cut does not close — the same outcome as v1's per-line
   * scan, on a document nobody hard-wraps.
   */
  private paragraphStart(doc: Text, idx: BlockIndex, from: number, fmEnd: number): number {
    const line = doc.lineAt(from)
    if (line.from <= fmEnd) return from
    if (this.prefixed(doc, line, idx)) return line.from
    let n = line.number
    for (let back = 0; back < PARA_LOOKBACK && n > 1; back++) {
      const prev = doc.line(n - 1)
      if (prev.from < fmEnd) break
      if (this.prefixed(doc, prev, idx)) break
      if (line.to - prev.from > INLINE_SLICE) break
      n--
    }
    return doc.line(n).from
  }

  /* -- the borrowed-object machinery ------------------------------------- */

  /** Grow the pool to hold index `i`.  Never touches an entry that exists. */
  private ensure(i: number): MutableMarker {
    const p = this.pool
    while (p.length <= i) p.push({ from: 0, to: 0, role: 'prefix' })
    return p[i] as MutableMarker
  }

  private mark(i: number, from: number, to: number, role: MarkerRole): void {
    const m = this.ensure(i)
    m.from = from
    m.to = to
    m.role = role
  }

  /**
   * The first `n` pool markers, as one array that is built once per `n`.
   * It must GROW the pool without writing to it: `mark()` has already run by
   * the time `emit()` gets here, and an earlier draft used `mark(i, 0, 0)` to
   * grow it — which zeroed the marker it was about to hand out, but only on
   * the FIRST construct of each arity in the process, because every later call
   * found the array cached.  That is a bug that hides from every test whose
   * subject is not the first thing the scanner sees.
   */
  private slot(n: number): readonly Marker[] {
    let arr = this.slots[n - 1]
    if (arr === undefined) {
      const built: Marker[] = []
      for (let i = 0; i < n; i++) built.push(this.ensure(i) as Marker)
      arr = built
      this.slots[n - 1] = arr
    }
    return arr
  }

  private emit(
    kind: ConstructKind, span: ConstructSpan,
    from: number, to: number, detail: number, markers: number
  ): void {
    // Seam rule 1, kept intact while the scanner reads outside its range: the
    // paragraph walk above deliberately starts before `from` and may run past
    // `to`, and a construct with NO intersection is dropped here rather than
    // handed to §4 to clip.  One compare, on the hot path, for a rule that
    // would otherwise have had to be amended.
    if (to < this.rangeFrom || from > this.rangeTo) return
    const c = this.c
    c.kind = kind
    c.span = span
    c.from = from
    c.to = to
    c.detail = detail
    c.markers = markers === 0 ? NO_MARKERS : this.slot(markers)
    this.sink(c)
  }

  /* -- block level (CM5 `blockNormal`) ----------------------------------- */

  private scanLine(doc: Text, line: Line): void {
    const len = line.to - line.from
    if (len === 0) return
    const base = line.from
    const text = doc.sliceString(base, base + (len > INLINE_SLICE ? INLINE_SLICE : len))
    const end = base + text.length

    let i = 0

    // 1. blockquote prefixes.  CM5 eats `>` then ALL following whitespace, and
    //    a `>` may be preceded by up to three spaces.  Obsidian decorates only
    //    the `>` character itself (`e6`/`i6` are one character wide), so that
    //    is the marker; the space after it stays visible and keeps the indent.
    let depth = 0
    for (;;) {
      let k = i
      let indent = 0
      while (k < text.length && indent < 3 && (text.charCodeAt(k) === SPACE || text.charCodeAt(k) === TAB)) { k++; indent++ }
      if (k >= text.length || text.charCodeAt(k) !== GT) break
      this.mark(depth, base + k, base + k + 1, 'prefix')
      depth++
      k++
      while (k < text.length && (text.charCodeAt(k) === SPACE || text.charCodeAt(k) === TAB)) k++
      i = k
    }
    if (depth > 0) this.emit('blockquote', 'line', base, line.to, depth, depth)

    const rest = i === 0 ? text : text.slice(i)
    if (rest.length === 0) return

    // 2. thematic break.  Checked before the list, because `- - -` is both.
    if (HR_RE.test(rest)) {
      this.mark(0, base + i, end, 'prefix')
      this.emit('hr', 'line', base + i, end, 0, 1)
      return
    }

    // 3. ATX heading.  Never `line.text`: at most HEAD_SLICE characters.
    const hm = HEADING_RE.exec(rest.length > HEAD_SLICE ? rest.slice(0, HEAD_SLICE) : rest)
    if (hm) {
      const all = hm[0] as string
      const level = (hm[1] as string).length
      const mkTo = base + i + all.length
      // Obsidian: `g10.text.trim() === u11().trim() || h11(...)` — a line whose
      // whole content IS the hashes never hides them, or typing `## ` on an
      // empty line would make the line look empty as you typed it.
      if (rest.trim() === all.trim()) {
        this.emit('heading', 'line', base, line.to, level, 0)
      } else {
        this.mark(0, base + i, mkTo, 'prefix')
        this.emit('heading', 'line', base, line.to, level, 1)
      }
      this.scanInline(base, text, mkTo - base)
      return
    }

    // 4. list marker, and the task box that may follow it.
    const lm = LIST_RE.exec(rest)
    if (lm) {
      const indent = (lm[1] as string).length
      const bullet = lm[2] as string
      const mkFrom = base + i + indent
      const mkTo = mkFrom + bullet.length + (lm[3] as string).length
      const ordered = bullet.length > 1
      const afterMarker = mkTo - base
      const tm = TASK_RE.exec(text.slice(afterMarker))
      if (tm) {
        // A task line hides its bullet whole: the checkbox stands where the
        // `- ` was.  `detail = 1` is what tells §4 to hide rather than dot it.
        this.mark(0, mkFrom, mkTo, 'prefix')
        const done = (tm[1] as string) !== ' '
        this.emit(ordered ? 'listOl' : 'listUl', 'line', base, line.to, done ? 2 : 1, 1)
        const box = (tm[0] as string).length
        this.mark(0, base + afterMarker, base + afterMarker + box, 'open')
        this.emit(
          'task', 'inline', base + afterMarker, base + afterMarker + box,
          done ? 1 : 0, 1
        )
        i = afterMarker + box
        if (text.charCodeAt(i) === SPACE) i++
      } else if (ordered) {
        // `1. ` is kept whole and re-tracked, never replaced (`s6`).
        this.mark(0, mkFrom, mkTo, 'prefix')
        this.emit('listOl', 'line', base, line.to, 0, 1)
        i = afterMarker
      } else {
        // ONE character.  Obsidian's `a6` is a mark over `[from, from+1]` and
        // the dot is drawn by CSS on top of a transparent `-`; the space after
        // it is ordinary text and is what indents the content.
        this.mark(0, mkFrom, mkFrom + 1, 'prefix')
        this.emit('listUl', 'line', base, line.to, 0, 1)
        i = afterMarker
      }
    }

    this.scanInline(base, text, i)
  }

  /* -- inline level (CM5 `inlineNormal`) --------------------------------- */

  private scanInline(base: number, text: string, start: number): void {
    const n = text.length
    let i = start

    let code = 0, codeFrom = -1, codeOpenTo = -1
    let em = 0, emFrom = -1, emOpenTo = -1
    let strong = 0, strongFrom = -1, strongOpenTo = -1
    let strike = false, strikeFrom = -1, strikeOpenTo = -1
    let hl = false, hlFrom = -1, hlOpenTo = -1
    let link = false, linkFrom = -1

    /* THE URL PREFILTER, and it changes no answer — see `URL_RE`.
     *
     * Every branch of Obsidian's pattern that is not `www…` is a run of
     * `[A-Za-z0-9.-]` followed by `:` (a scheme) or `/` (its scheme-less
     * `host.tld/path` branch).  So a position whose run ends in anything else
     * CANNOT match, and the test is NECESSARY: skipping there is not an
     * approximation of trying, it is the same answer for less.
     *
     * The run's terminator is a property of the RUN, not of the position
     * inside it, so it is computed once per run and reused — which is what
     * keeps a per-character rule linear.  Measured on a 278-character prose
     * line: 5.9 us for 278 bare attempts, 0.4 us with this.
     */
    let runEnd = -1
    let runTerm = -1
    /** An email needs an `@`, and one `indexOf` per line answers that. */
    const hasAt = text.indexOf('@', start) >= 0
    /** Positions below this cannot start an email — see `EMAIL_LOCAL_RE`. */
    let emailSkip = -1

    while (i < n) {
      const ch = text.charCodeAt(i)
      if (i >= runEnd) {
        let j = i
        while (j < n && isUrlRunCharCode(text.charCodeAt(j))) j++
        runEnd = j > i ? j : i + 1
        runTerm = j < n ? text.charCodeAt(j) : -1
      }

      // A code span swallows everything until a run of its own length.  CM5
      // returns `getType(state)` for every character inside it and reaches no
      // other branch, which is why this test comes first.
      if (code > 0) {
        if (ch === BACKTICK) {
          let run = 1
          while (i + run < n && text.charCodeAt(i + run) === BACKTICK) run++
          if (run === code) {
            this.mark(0, base + codeFrom, base + codeOpenTo, 'open')
            this.mark(1, base + i, base + i + run, 'close')
            this.emit('inlineCode', 'inline', base + codeFrom, base + i + run, 0, 2)
            code = 0
          }
          i += run
          continue
        }
        i++
        continue
      }

      if (ch === BACKTICK) {
        let run = 1
        while (i + run < n && text.charCodeAt(i + run) === BACKTICK) run++
        code = run
        codeFrom = i
        codeOpenTo = i + run
        i += run
        continue
      }

      if (ch === BACKSLASH && i + 1 < n && ESCAPABLE_RE.test(text.charAt(i + 1))) {
        this.mark(0, base + i, base + i + 1, 'open')
        this.emit('escape', 'inline', base + i, base + i + 2, 0, 1)
        i += 2
        continue
      }

      if (ch === STAR || ch === UNDERSCORE) {
        // CM5, verbatim: a run is at most three characters; `before` is the
        // character preceding the run and `after` the one following it; a run
        // of odd length may toggle em and a run longer than one may toggle
        // strong, so `***` toggles both in one token.
        let run = 1
        while (run < 3 && i + run < n && text.charCodeAt(i + run) === ch) run++
        const before = i === 0 ? ' ' : text.charAt(i - 1)
        const after = i + run < n ? text.charAt(i + run) : ' '
        const isStar = ch === STAR
        const pBefore = PUNCT_RE.test(before)
        const pAfter = PUNCT_RE.test(after)
        const leftFlank = !isSpaceChar(after) && (!pAfter || isSpaceChar(before) || pBefore)
        const rightFlank = !isSpaceChar(before) && (!pBefore || isSpaceChar(after) || pAfter)
        let setEm: boolean | null = null
        let setStrong: boolean | null = null
        if (run % 2) {
          if (!em && leftFlank && (isStar || !rightFlank || pBefore)) setEm = true
          else if (em === ch && rightFlank && (isStar || !leftFlank || pAfter)) setEm = false
        }
        if (run > 1) {
          if (!strong && leftFlank && (isStar || !rightFlank || pBefore)) setStrong = true
          else if (strong === ch && rightFlank && (isStar || !leftFlank || pAfter)) setStrong = false
        }
        if (setEm !== null || setStrong !== null) {
          // The markers are shared when one run toggles both, so they are
          // attached to the OUTER construct only and the inner one carries
          // none: emitting them twice would hand §4 two replace decorations
          // over one range.  Both bodies cover the markers either way, which
          // is what CM5 does — its `**` token carries `strong` as well as
          // `formatting-strong`.
          const closingStrong = setStrong === false
          const closingEm = setEm === false
          if (closingStrong) {
            this.mark(0, base + strongFrom, base + strongOpenTo, 'open')
            this.mark(1, base + i, base + i + run, 'close')
            this.emit('strong', 'inline', base + strongFrom, base + i + run, 0, 2)
            strong = 0
          }
          if (closingEm) {
            const owns = !closingStrong
            if (owns) {
              this.mark(0, base + emFrom, base + emOpenTo, 'open')
              this.mark(1, base + i, base + i + run, 'close')
            }
            this.emit('emphasis', 'inline', base + emFrom, base + i + run, 0, owns ? 2 : 0)
            em = 0
          }
          if (setStrong === true) { strong = ch; strongFrom = i; strongOpenTo = i + run }
          if (setEm === true) { em = ch; emFrom = i; emOpenTo = i + run }
          i += run
          continue
        }
        i += run
        continue
      }

      // `~~` and `==` are CM5's `eatWhile` pairs: a run of at least two, opened
      // only when the next character is not a space, closed on any later run.
      if (ch === TILDE || ch === EQUALS) {
        let run = 1
        while (i + run < n && text.charCodeAt(i + run) === ch) run++
        if (run >= 2) {
          const open = ch === TILDE ? strike : hl
          if (open) {
            const f = ch === TILDE ? strikeFrom : hlFrom
            const o = ch === TILDE ? strikeOpenTo : hlOpenTo
            this.mark(0, base + f, base + o, 'open')
            this.mark(1, base + i, base + i + run, 'close')
            this.emit(
              ch === TILDE ? 'strikethrough' : 'highlight', 'inline',
              base + f, base + i + run, 0, 2
            )
            if (ch === TILDE) strike = false; else hl = false
            i += run
            continue
          }
          const next = i + run < n ? text.charAt(i + run) : ' '
          // CM5 opens strikethrough on `/^[^\s]/` and highlight on `/^[^\s>]/`.
          const ok = !isSpaceChar(next) && !(ch === EQUALS && next === '>')
          if (ok) {
            if (ch === TILDE) { strike = true; strikeFrom = i; strikeOpenTo = i + run }
            else { hl = true; hlFrom = i; hlOpenTo = i + run }
          }
          i += run
          continue
        }
        i += run
        continue
      }

      // §0.39 E86 — `<https://…>` / `<name@host>`.  BEFORE the bare-url branch
      // and it has to be: that one starts at a letter, so it would otherwise
      // linkify the inside of the angles and leave the `<` and `>` as text,
      // which is exactly what the user photographed.
      if (ch === LT && !link) {
        const rest = text.slice(i + 1)
        const m = AUTOLINK_RE.exec(rest) ?? AUTOEMAIL_RE.exec(rest)
        if (m) {
          const to = i + 1 + (m[0] as string).length
          this.mark(0, base + i, base + i + 1, 'open')
          this.mark(1, base + to - 1, base + to, 'close')
          this.emit('autolink', 'inline', base + i, base + to, 0, 2)
          i = to
          runEnd = -1
          continue
        }
      }

      /* AN IMAGE RUN IS SKIPPED WHOLE — `lib/codemirror/markdown.js:563`:
       *
       *     if (ch === '!' && stream.match(/\[[^\]]*\] ?(?:\(|\[)/, false)) {
       *       state.imageMarker = true; state.image = true; …
       *
       * and `:586`'s link branch is guarded on `!state.image`, so the run that
       * follows is an IMAGE and not a link. `KNOWN-ISSUES.md` LP-2 keeps images
       * absent — they need a renderer — and absent means RAW SOURCE, which is
       * what emitting nothing and hiding nothing produces.
       *
       * IT WAS NOT GUARDED AT ALL, AND THE RESULT WAS WORSE THAN THE ABSENT
       * FEATURE: `![alt](url)` scanned as a bare `!` followed by a complete
       * `[text](url)`, so the brackets and the destination were HIDDEN, `alt`
       * was drawn accent-coloured and underlined with `cursor: pointer`, the
       * `!` was left sitting in front of it, and §0.38 E85's click handler
       * resolved `.nc-link` — clicking an image's alt text opened the image's
       * url in a browser.
       *
       * THE SKIP IS WHY THIS IS ONE BRANCH AND NOT A GUARD ON THE LINK BRANCH.
       * A guard alone leaves the scanner walking INTO `(http://…)`, where the
       * bare-url linkifier picks the destination up and renders it as a link —
       * measured, that is exactly what a first draft did. Obsidian is immune by
       * a different route: at the closing `]` it sets `state.inline = linkHref`,
       * and the linkifier's own guard is `state.code || state.indentedCode ||
       * state.linkHref`. Cairn has no `linkHref` state because its link branch
       * CONSUMES `[text](url)` in one jump and never visits the destination —
       * so the image has to consume its run the same way.
       *
       * The pattern is Obsidian's lookahead plus the destination its `linkHref`
       * state would then eat. When it does NOT match — `![alt]` with no
       * destination — the run falls through to the link branch, which is also
       * what the stock mode does, and a bare `[alt]` is `hmd-barelink`: nothing
       * hidden, no construct, raw source again. */
      /* NOT GATED ON `!link`, AND THAT IS THE LINKED-IMAGE CASE.  The stock
       * mode's `!` rule (`:563`) has no `state.linkText` guard, and dropping
       * Cairn's changes what `[![a](b.png)](url)` does — one of the commonest
       * shapes in real notes, a badge linked to a page. Measured before:
       *
       *   link[0,12] + url[14,31], hiding `[` and `](b.png)` — so a reader saw
       *   `![a` drawn as an accent-underlined link whose destination was the
       *   IMAGE, then a literal `](`, then the real url linkified separately.
       *   A click went to `b.png`.
       *
       * After: the image run is consumed, the outer `]` finds `(url)`, and the
       * whole thing is ONE link whose text is the raw image source and whose
       * destination is the url. Images are still absent (LP-2), so raw source
       * is the honest fallback for the text — and the click now goes where the
       * document says. */
      if (ch === BANG && i + 1 < n && text.charCodeAt(i + 1) === LBRACKET) {
        // A pasted clipboard image renders through §4's `ImageWidget`.  Every
        // other image keeps the raw-source skip below: there is no file to
        // resolve (the tree holds `.md` only) and no remote fetch to make.
        const dm = IMAGE_DATA_RE.exec(text.slice(i))
        if (dm) {
          const total = (dm[0] as string).length
          this.mark(0, base + i, base + i + total, 'open')
          this.emit('image', 'inline', base + i, base + i + total, 0, 1)
          i += total
          runEnd = -1
          continue
        }
        const im = IMAGE_RUN_RE.exec(text.slice(i + 1))
        if (im) {
          i += 1 + (im[0] as string).length
          runEnd = -1
          continue
        }
      }

      // `[[wikilink]]` and `[[target|alias]]`, BEFORE the `[text](url)` branch
      // — Obsidian's mode tests `!?[[` first for the same reason: a wikilink's
      // first `[` would otherwise open a markdown link that never closes.
      if (ch === LBRACKET && !link && i + 1 < n && text.charCodeAt(i + 1) === LBRACKET
          && !(i > 0 && text.charCodeAt(i - 1) === BANG)) {
        const w = WIKILINK_RE.exec(text.slice(i))
        if (w) {
          const inner = w[1] as string
          const pipe = inner.indexOf('|')
          // The open marker is `[[`, plus `target|` when there is an alias:
          // Obsidian hides `link-has-alias` and `link-alias-pipe` with the
          // brackets and underlines only what is left.
          const openTo = i + 2 + (pipe < 0 ? 0 : pipe + 1)
          const to = i + (w[0] as string).length
          this.mark(0, base + i, base + openTo, 'open')
          this.mark(1, base + to - 2, base + to, 'close')
          this.emit('wikilink', 'inline', base + i, base + to, 0, 2)
          i = to
          continue
        }
      }

      // A BARE url, or a bare email.  Tried at EVERY position, which is what
      // Obsidian does — CM5's `inlineNormal` ends in `stream.next()` and
      // `return getType(state)`, one character per token in plain text, and the
      // hypermd wrapper runs its test on each.  So `xhttps://x.com/ab` IS a
      // link there, from the `h`, and a "word start only" rule would be a
      // divergence rather than an optimisation.
      //
      // `!link` is its `state.linkText`; the code-span branch above has already
      // taken every position inside a code span, which is its `state.code`.
      if (!link && URL_HEAD_RE.test(text.charAt(i))
          && (isWww(text, i, n) || runTerm === COLON || runTerm === SLASH)) {
        URL_RE.lastIndex = i
        const m = URL_RE.exec(text)
        if (m) {
          // No markers: there is no source to hide, so there is nothing to
          // reveal either, and the whole run is the body.
          const len = (m[0] as string).length
          this.emit('url', 'inline', base + i, base + i + len, 0, 0)
          // Consumed, so `_` and `*` inside a path open nothing — which is the
          // other half of what linkifying buys.
          i += len
          runEnd = -1
          continue
        }
      }

      if (!link && hasAt && i >= emailSkip && !EMAIL_HEAD_RE.test(text.charAt(i))) {
        EMAIL_RE.lastIndex = i
        const m = EMAIL_RE.exec(text)
        if (m) {
          const len = (m[0] as string).length
          this.emit('url', 'inline', base + i, base + i + len, 0, 0)
          i += len
          runEnd = -1
          continue
        }
        EMAIL_LOCAL_RE.lastIndex = i
        emailSkip = EMAIL_LOCAL_RE.test(text) ? EMAIL_LOCAL_RE.lastIndex : i + 1
      }

      if (ch === LBRACKET && !link) {
        link = true
        linkFrom = i
        i++
        continue
      }

      if (ch === RBRACKET && link) {
        link = false
        const dest = LINK_DEST_RE.exec(text.slice(i + 1))
        if (dest) {
          // `[text](url)`.  A bare `[text]` is Obsidian's `hmd-barelink`, and
          // its decorator sets `b = P = false` for one: NOTHING is hidden and
          // no construct exists.  So there is no `else` branch here.
          const to = i + 1 + (dest[0] as string).length
          this.mark(0, base + linkFrom, base + linkFrom + 1, 'open')
          this.mark(1, base + i, base + to, 'close')
          this.emit('link', 'inline', base + linkFrom, base + to, 0, 2)
          i = to
          continue
        }
        i++
        continue
      }

      i++
    }
  }
}

/**
 * THE source.  `buildDecorations` defaults to it; nothing else names it.
 */
const theSource = new MarkdownSource()
export const markdownSource: ConstructSource = theSource

/** §0.40 E87 — `tables.ts`'s door to §3's inline half.  See `inlineIn`. */
export function inlineConstructs(text: string, sink: ConstructSink): void {
  theSource.inlineIn(text, sink)
}

/* ===========================================================================
 * 4.  The decorations.  Created ONCE at module load and reused forever: CM6
 *     diffs decoration sets by value identity when deciding which DOM lines to
 *     touch, so fresh objects per rebuild would force DOM churn per keystroke.
 *
 *     From here down there is no regex, no fence and no `#`.  Everything this
 *     section knows about markdown arrives through §2.
 * ========================================================================= */

/* §0.30 E73 — `nc-h` ON EVERY HEADING LINE, BESIDE ITS LEVEL CLASS.  It is
   Obsidian's `HyperMD-header`, which its own sheet carries beside
   `HyperMD-header-N` for exactly the rules that do not care about the level:

     .cm-line.HyperMD-header { padding-top: var(--p-spacing) }
     .cm-line.HyperMD-header + .cm-line:not(.HyperMD-header)… { padding-top: 0 }
     .cm-line.HyperMD-header + .cm-line:has(>br:only-child) + .cm-line.HyperMD-header
                             { padding-top: 0 }

   Written as six level classes alone, the third of those is a 36-way selector
   and the first is six rules; with the shared class it is one each.  The level
   classes are UNCHANGED and still carry every size, weight and space token. */
const H1 = Decoration.line({ class: 'nc-h nc-h1' })
const H2 = Decoration.line({ class: 'nc-h nc-h2' })
const H3 = Decoration.line({ class: 'nc-h nc-h3' })
const H4 = Decoration.line({ class: 'nc-h nc-h4' })
const H5 = Decoration.line({ class: 'nc-h nc-h5' })
const H6 = Decoration.line({ class: 'nc-h nc-h6' })

function headingDeco(level: number): Decoration {
  switch (level) {
    case 1: return H1
    case 2: return H2
    case 3: return H3
    case 4: return H4
    case 5: return H5
    default: return H6
  }
}

const CB_FIRST = Decoration.line({ class: 'nc-cb nc-cb-first' })
const CB_MID = Decoration.line({ class: 'nc-cb' })
const CB_LAST = Decoration.line({ class: 'nc-cb nc-cb-last' })
const CB_ONLY = Decoration.line({ class: 'nc-cb nc-cb-only' })

const HR_LINE = Decoration.line({ class: 'nc-hr' })
const LIST_LINE = Decoration.line({ class: 'nc-li' })
/* app.css:14147 — `.markdown-source-view.mod-cm6 .HyperMD-task-line[data-task="x"],
 * [data-task="X"] { text-decoration: var(--checklist-done-decoration);
 * color: var(--checklist-done-color) }`.  Obsidian carries the state as a LINE
 * ATTRIBUTE written by a ViewPlugin of its own (`q3.buildDeco`, app.js:79884,
 * which re-matches the line and takes the task character out of group 6);
 * Cairn already knows the state where the construct is emitted, so it takes a
 * class and needs no second pass over the line.
 *
 * ONLY `x` AND `X`, which is why this is a third decoration and not a
 * predicate on "is a task": Obsidian's selector names those two characters, so
 * `- [-]` and `- [/]` are task lines that are NOT struck through.  Cairn's
 * scanner refuses every character but ` `, `x` and `X` (`TASK_RE`), so the
 * distinction is currently invisible — it is written down here because the day
 * TASK_RE widens is the day it stops being. */
const LIST_LINE_DONE = Decoration.line({ class: 'nc-li nc-li-done' })

/* §0.51 E99 — THE LEADING INDENT RUN OF A LIST LINE, AND ITS TWO GROUP KINDS.
 *
 * Obsidian splits the run into GROUPS and marks each one (`Bq.getDeco`,
 * app.js, transcribed in `indentGroups` below):
 *
 *   `.cm-indent`          a WHOLE tab, or four whole spaces.  Its width is not
 *                         the whitespace's advance at all — `min-width:
 *                         var(--list-indent)` (app.css:8185) quantises it to
 *                         36px, so one level of indent is one level wide
 *                         whether the file used a tab or four spaces.
 *   `.cm-indent-spacing`  the leftover run of fewer than four spaces, at its
 *                         natural advance.
 *
 * ONE MARK PER GROUP, WITH NO WRAPPER, and that is a divergence from Obsidian's
 * DOM taken deliberately: its groups sit inside a `.cm-hmd-list-indent` span,
 * which exists so that `.cm-indent-spacing:last-child` can name the last group.
 * Cairn's groups are siblings of the line's own text, where `:last-child` would
 * name the text instead — so "is this the last group" is decided HERE, by the
 * builder that knows, and carried by a third class.  The geometry is identical;
 * §0.51's measurements are the receipt. */
const INDENT_FULL = Decoration.mark({ class: 'nc-indent' })
const INDENT_SPACING = Decoration.mark({ class: 'nc-indent-sp' })

/* §0.35 E81 — …AND THE 1em THAT ONLY A CONTINUATION TAKES.
 *
 * [S] `.cm-s-obsidian .HyperMD-list-line.HyperMD-list-line-nobullet >
 * .cm-hmd-list-indent > .cm-indent-spacing:last-child { padding-inline-start:
 * calc(var(--list-indent-editing) + var(--list-marker-space)) }`
 * (app.css:13328) = 0.75em + 0.25em = 1em = 16px.
 *
 * THREE CONDITIONS, ALL OF THEM LOAD-BEARING, and E81 shipped with only the
 * first: the line must be a `-nobullet` CONTINUATION, the group must be the
 * LAST one, and it must be a `.cm-indent-spacing` rather than a `.cm-indent`.
 * Measured in the live 1.13.7 (§0.51): a continuation indented by two spaces
 * takes it (7.05 + 16 = 23.05) and one indented by FOUR does not (36.0, because
 * four spaces are a whole group and the last child is a `.cm-indent`). */
const INDENT_SPACING_PAD = Decoration.mark({ class: 'nc-indent-sp nc-indent-pad' })

/* §0.35.1 E82 — and the LINE itself.  Obsidian's stream mode emits
 * `line-HyperMD-list-line` for a continuation as well as for a real item, so
 * the line takes `--list-spacing` like any other list line; then
 * `.HyperMD-list-line-nobullet { padding-top: initial }` takes the TOP half off,
 * because an item's own top spacing already opened the gap above it.
 * Both classes, mirroring that pair: `nc-li` carries the shared rule and
 * `nc-li-cont` is the override.
 *
 * A NESTED ITEM IS NOT A CONTINUATION AND MUST NOT GET THIS (§0.51 E99). */
const LIST_CONT_LINE = Decoration.line({ class: 'nc-li nc-li-cont' })

/** Leading whitespace followed by content — the shape an indented line has. */
const LEADING_WS_RE = /^[ \t]+(?=\S)/

/** A real list marker at the start of a line, indented or not.  Obsidian's `bO`
 *  with the optional group made REQUIRED, which is the difference between "this
 *  line opens a list item" and "this line is inside one". */
const LIST_OPENER_RE = /^[ \t]*([*+-] |\d+[.)] )/

/** One group of a leading indent run: `[from, to)` in characters from the start
 *  of the line, and whether it is a WHOLE unit (`.cm-indent`) or the partial
 *  leftover (`.cm-indent-spacing`). */
export interface IndentGroup {
  readonly from: number
  readonly to: number
  readonly full: boolean
}

/**
 * Obsidian's `Bq.getDeco` inner loop, transcribed (app.js):
 *
 *     k = y.charAt(b)
 *     if (k === '\t') { E = true; b++ }
 *     else { S = true; x = b + 4
 *            for (T = b; T < x; T++) if (y.charAt(T) !== ' ') { b = T; S = false; break }
 *            if (!S) { add(C, from + b, cm-indent-spacing); b++; continue }
 *            E = true; b = x }
 *     if (E) add(C, from + b, cm-indent)
 *
 * TWO THINGS IN THAT LOOP ARE EASY TO GET WRONG BY PARAPHRASE, and both were
 * checked against the live app rather than reasoned about:
 *
 *   - A PARTIAL GROUP RUNS TO THE FIRST NON-SPACE, not one character.  `b = T`
 *     inside the guard moves the cursor to the offending index, so `"   "`
 *     emits ONE spacing group of three, not three of one.
 *   - A TAB IS ONE GROUP WHATEVER ITS ADVANCE, when it STARTS one.  Its width
 *     is `min-width`, so `tab-size` does not decide it.
 *
 * THE ONE DELIBERATE DEPARTURE, AND WHY IT IS THE OPPOSITE OF A PARAPHRASE.
 * Obsidian's `b++` after a partial group steps over the character that ENDED
 * it — harmless at the end of a run, and a dropped TAB anywhere else.  Read out
 * of the live 1.13.7's own `.cm-hmd-list-indent`, `"  \t  "` really does build
 *
 *     <span class="cm-indent-spacing">  </span>\t<span class="cm-indent-spacing">  </span>
 *
 * with the tab bare between the spans.  It is bare INSIDE THE WRAPPER, though,
 * and that is what makes it work there: the wrapper is `display: inline-block`,
 * so the tab's stop is measured from the start of the indent RUN.  Cairn emits
 * no wrapper (see the group decorations above), so a bare tab would take its
 * stop from the LINE — whose origin §0.31 E75's hanging indent has already
 * moved — and measured 46.05 against Obsidian's 59.05 on that run.
 *
 * So the terminating tab is kept INSIDE the group it ended.  That span is an
 * inline-block too, so the stop is re-originned at the same place Obsidian's
 * wrapper puts it, and the run measures 59.05 exactly.  Verified identical on
 * every mixed run whose partial groups are 36-aligned; a run that mixes
 * spaces-and-tab TWICE (`"  \t  \t  "`) differs by 0.05px, which is recorded in
 * `docs/KNOWN-ISSUES.md` rather than chased with a wrapper.
 *
 * Obsidian's own loop also consumes `>` (and one space after it) with no mark.
 * `ws` here is `[ \t]` only — Cairn's indent run starts at the line's first
 * character, so a quote marker is not in it — and the arm is left out rather
 * than transcribed dead.
 */
export function indentGroups(ws: string): IndentGroup[] {
  const out: IndentGroup[] = []
  let b = 0
  while (b < ws.length) {
    const from = b
    if (ws.charAt(b) === '\t') {
      b++
      out.push({ from, to: b, full: true })
      continue
    }
    let whole = true
    const x = b + 4
    for (let t = b; t < x; t++) {
      if (ws.charAt(t) !== ' ') { b = t; whole = false; break }
    }
    if (!whole) {
      // …to AND INCLUDING the tab that ended it, where there is one: Obsidian's
      // `b++` drops that character, and only its wrapper makes that survivable.
      b++
      out.push({ from, to: b <= ws.length ? b : ws.length, full: false })
      continue
    }
    b = x
    out.push({ from, to: b, full: true })
  }
  return out
}

/** What a line's leading whitespace is: how many characters of it, and whether
 *  the line CONTINUES an item (Obsidian's `-nobullet`) or OPENS one at depth. */
export interface ListIndent {
  readonly n: number
  readonly cont: boolean
}

/**
 * The leading indent run of a list line, or `null` when the line has none.
 *
 * A LINE THAT CARRIES ITS OWN MARKER IS AN ITEM, NOT A CONTINUATION (§0.51
 * E99), and that distinction is the whole of this function.  Obsidian tags such
 * a line `HyperMD-list-line-2` and never `-nobullet`, so it takes
 * `--list-spacing` on BOTH sides and its indent run takes no 1em.  Cairn's
 * predecessor asked only "is there an open item above me", which every nested
 * bullet answers yes to: reported by the user with two screenshots of one note,
 * where a nested bullet sat 16.000 px right of Obsidian's and 1.2px high.
 *
 * The rest is unchanged.  Obsidian decides continuation-ness with a stream-mode
 * `listStack` that it carries down the document; Cairn's scanner is line- and
 * paragraph-scoped (§0.24), so this walks back instead — BOUNDED, for the same
 * reason `PARA_LOOKBACK` is bounded: an unbounded walk makes a 50,000-line
 * document quadratic on every viewport change.
 *
 * A BLANK LINE ENDS THE ITEM HERE, and that is a divergence recorded rather
 * than hidden: Obsidian's `listStack` survives one, so a "loose" list whose
 * second paragraph is indented gets the padding there and Cairn does not.  The
 * conservative direction is the safe one — it under-indents a rare shape rather
 * than indenting a plain indented paragraph that is not in a list at all.
 */
export function listIndentAt(doc: Text, line: Line): ListIndent | null {
  const m = LEADING_WS_RE.exec(line.text)
  if (m === null) return null
  const n = (m[0] as string).length
  if (LIST_OPENER_RE.test(line.text)) return { n, cont: false }
  for (let k = line.number - 1, steps = 0; k >= 1 && steps < LIST_LOOKBACK; k--, steps++) {
    const prev = doc.line(k)
    // A blank line ends the item (see above).
    if (prev.text.trim() === '') return null
    // Found the item this line continues.
    if (LIST_OPENER_RE.test(prev.text)) return { n, cont: true }
    // A line that starts flush is ordinary prose, not a list at any depth, so
    // an indented line under it is an indented paragraph and not a continuation.
    if (!LEADING_WS_RE.test(prev.text)) return null
  }
  return null
}

/** The walk-back bound.  `PARA_LOOKBACK`'s sibling and its reason. */
const LIST_LOOKBACK = 200
const QUOTE_LINE_1 = Decoration.line({ class: 'nc-quote nc-quote-1' })
const QUOTE_LINE_N = Decoration.line({ class: 'nc-quote nc-quote-n' })

/** §5.4.1: the marker run is hidden by default … */
export const HIDE_MARK = Decoration.replace({})
/** … and revealed, in --text-faint, where Obsidian gives it a colour rule. */
export const SHOW_MARK = Decoration.mark({ class: 'nc-md-marker' })
/**
 * … and revealed with NO class where Obsidian gives it none.  `app.css` has a
 * `color: var(--text-faint)` rule for `.cm-formatting-header`,
 * `.cm-formatting-quote`, `.cm-formatting-link` and `.cm-formatting-list`, and
 * has NO rule at all for `.cm-formatting-em`, `-strong`, `-strikethrough` or
 * `-highlight` — so a revealed `**` renders bold in body colour, inside the
 * `nc-strong` mark that covers it.  Dimming it would be this file's invention.
 */
export const SHOW_PLAIN = Decoration.mark({ class: 'nc-md-marker-plain' })

/* Inline bodies.  Obsidian's `getType` puts the construct's own class on the
 * formatting tokens too, so these cover the markers — except `link`, whose
 * `cm-underline` lands on the text alone (`E10 -> J2` in its decorator). */
const STRONG = Decoration.mark({ class: 'nc-strong' })
const EM = Decoration.mark({ class: 'nc-em' })
const STRIKE = Decoration.mark({ class: 'nc-strike' })
const HIGHLIGHT = Decoration.mark({ class: 'nc-hl' })
const INLINE_CODE = Decoration.mark({ class: 'nc-code' })
const LINK_TEXT = Decoration.mark({ class: 'nc-link' })
/* §0.36 E83.  TWO CLASSES, NOT ONE, because Obsidian has two rules and they
 * differ in more than a colour token that happens to hold the same value:
 *
 *   `.cm-s-obsidian span.cm-url`            (app.css:13447)  the BARE url
 *   `.markdown-source-view.mod-cm6 .cm-hmd-internal-link .cm-underline`
 *                                           (app.css:13511)  the WIKILINK
 *
 * The bare url takes `word-break: break-all` and NO pointer cursor; the
 * wikilink takes the cursor and no break rule.  Both are Obsidian's, and the
 * cursor difference is not an oversight of its stylesheet — `cursor` is on
 * `.cm-underline`, which a bare url never gets (its decorator's `L` branch is
 * outside the `S` that adds it), and its own click handler refuses a plain
 * click on one for exactly the same reason.
 */
const URL_TEXT = Decoration.mark({ class: 'nc-url' })
const WIKILINK_TEXT = Decoration.mark({ class: 'nc-ilink' })

/* Markers that are re-drawn rather than removed. */
const BULLET = Decoration.mark({ class: 'nc-bullet' })
const NUMBER = Decoration.mark({ class: 'nc-num' })
const QUOTE_MARK = Decoration.mark({ class: 'nc-quote-mark' })

class QuoteBorderWidget extends WidgetType {
  eq(): boolean { return true }
  toDOM(): HTMLElement {
    // Obsidian's `n6`: `createSpan({cls:"cm-blockquote-border cm-transparent", text:">"})`.
    // The `>` is kept as text so the line keeps the advance it had.
    const el = document.createElement('span')
    el.className = 'nc-quote-border nc-quote-mark'
    el.textContent = '>'
    return el
  }
  ignoreEvent(): boolean { return false }
}
const QUOTE_BORDER = Decoration.replace({ widget: new QuoteBorderWidget() })

class RuleWidget extends WidgetType {
  eq(): boolean { return true }
  toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = 'nc-hr-rule'
    el.appendChild(document.createElement('hr'))
    return el
  }
  ignoreEvent(): boolean { return false }
}
/**
 * Obsidian's `r6` is a BLOCK widget (`<div class="hr cm-line"><br><hr></div>`)
 * supplied from a `StateField`.  This one is inline, because CM6 refuses block
 * decorations from a `ViewPlugin` ("Block decorations may not be specified via
 * plugins") and moving the whole decorator to a `StateField` would cost the
 * viewport-only rule, which is seam rule 5.  The `<hr>` is a real `<hr>` in
 * both; the difference is the line box it sits in.
 */
const RULE = Decoration.replace({ widget: new RuleWidget() })

class TaskWidget extends WidgetType {
  constructor(readonly checked: boolean) { super() }
  eq(other: TaskWidget): boolean { return other.checked === this.checked }
  toDOM(view: EditorView): HTMLElement {
    // Obsidian's `l6`: a <label> wrapping an <input type=checkbox data-task>.
    const label = document.createElement('label')
    label.className = 'nc-task'
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.checked = this.checked
    box.setAttribute('data-task', this.checked ? 'x' : ' ')
    label.appendChild(box)
    /**
     * CLICKING IT EDITS THE DOCUMENT, because a checkbox that cannot be ticked
     * is worse than no checkbox: it renders as an affordance and then lies.
     * The widget replaces `[from, from+3]`, so the state character is at
     * `from + 1` and one `changes` is the whole edit — it then travels the
     * ordinary dirty/autosave path in `editor.ts`, exactly as typing does.
     * `mousedown`, not `click`: the caret must not land inside the box first.
     */
    box.addEventListener('mousedown', (e) => {
      e.preventDefault()
      const from = view.posAtDOM(label, 0)
      const line = view.state.doc.lineAt(from)
      // Re-read the character rather than trusting `this.checked`: the widget
      // is a cached singleton and the document is the only authority.
      const at = from + 1
      if (at >= line.to) return
      const now = view.state.doc.sliceString(at, at + 1)
      view.dispatch({
        changes: { from: at, to: at + 1, insert: now === ' ' ? 'x' : ' ' },
        userEvent: 'input.task',
      })
    })
    return label
  }
  // The widget owns its own events; CM6 must not also place a caret in it.
  ignoreEvent(): boolean { return true }
}
const TASK_OFF = Decoration.replace({ widget: new TaskWidget(false) })
const TASK_ON = Decoration.replace({ widget: new TaskWidget(true) })

/**
 * A pasted clipboard image (`data:` URL only — §3 emits nothing else as
 * `'image'`).  The whole `![…](…)` run is one atomic replace, so Backspace and
 * Delete take it in a single keystroke and the caret can never land inside
 * 200 kB of base64.  A click anywhere but the X places the caret and reveals
 * the source, like the table widget.
 *
 * The X is Cairn's, not Obsidian's [C]: Obsidian draws no remove control on
 * images.  It is a real `<button>` (focusable, labelled) whose mousedown
 * deletes the run through the ordinary dispatch + autosave path — §9 E4
 * forbids drawing a control that does nothing, so this one works.  `mousedown`,
 * not `click`, like the task checkbox: the caret must not land in the run
 * first and reveal the source under the pointer.  No innerHTML anywhere (B12):
 * the glyph is a text node, not markup, and `src` is set as a property.
 */
export class ImageWidget extends WidgetType {
  constructor(readonly url: string, readonly alt: string) { super() }
  override eq(o: WidgetType): boolean {
    return o instanceof ImageWidget && o.url === this.url && o.alt === this.alt
  }
  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = 'nc-img-wrap'
    const img = document.createElement('img')
    img.className = 'nc-img'
    img.src = this.url
    img.alt = this.alt
    img.draggable = false
    wrap.appendChild(img)
    const x = document.createElement('button')
    x.className = 'nc-img-x'
    x.type = 'button'
    x.textContent = '×'
    x.setAttribute('aria-label', 'Remove image')
    x.setAttribute('title', 'Remove image')
    x.addEventListener('mousedown', (e) => {
      e.preventDefault()
      const hit = imageRangeAt(view.state, view.posAtDOM(x, 0))
      if (hit === null) return
      view.dispatch({ changes: { from: hit.from, to: hit.to }, userEvent: 'delete.image' })
    })
    wrap.appendChild(x)
    return wrap
  }
  // The X owns its mousedown; anything else falls through to CM6.
  override ignoreEvent(e: Event): boolean {
    const t = e.target
    return t instanceof Element && t.closest('.nc-img-x') !== null
  }
}

/** The replace decoration for one pasted-image marker, over the whole run.
 *  Built per image (the URL differs), unlike §4's singletons. */
function imageDeco(doc: Text, from: number, to: number): Decoration {
  const m = IMAGE_DATA_RE.exec(doc.sliceString(from, to))
  return Decoration.replace({
    widget: new ImageWidget(m ? (m[2] as string) : '', m ? (m[1] as string) : ''),
  })
}

/**
 * WHAT COUNTS AS "the selection is here", per kind.
 *
 * Obsidian does not have one rule, it has three, and reading its decorator is
 * the only way to know which is which:
 *
 *   'line'      the header branch takes `doc.lineAt(from)` and tests the whole
 *               line; the quote and escape branches call its `a10`, which is
 *               the same thing.  Anywhere on the line reveals it.
 *   'construct' inline formatting is accumulated into a group and flushed
 *               against the group's own span, which for a well-formed
 *               `**bold**` is exactly the construct.  The rest of the line does
 *               not reveal it.
 *   'marker'    a list bullet's group is one character wide (`L10.to = r11 =
 *               i12 + 1`), so only a caret ON the bullet turns the dot back
 *               into a `-`.  `hr` tests its own node range, which is the line's
 *               whole text and therefore the same thing.
 *   'never'     Cairn's, not Obsidian's [C]: a pasted image is never revealed.
 *               The paste leaves the caret touching the new run, so any other
 *               scope shows base64 soup until the caret moves away — and the
 *               ruling is that the image is on the page from the keystroke
 *               until Backspace/Delete or the X takes it.
 */
type RevealScope = 'line' | 'construct' | 'marker' | 'never'

function revealScope(kind: ConstructKind): RevealScope {
  switch (kind) {
    case 'image':
      return 'never'
    case 'heading':
    case 'blockquote':
    case 'escape':
      return 'line'
    case 'listUl':
    case 'listOl':
    case 'task':
    case 'hr':
      return 'marker'
    default:
      return 'construct'
  }
}

/**
 * Obsidian's `FA`/`NA`: `e.from <= n && e.to >= t` over EVERY range, not just
 * the primary one, and touching a boundary counts.  Transcribed rather than
 * re-derived, because the inclusive/exclusive choice at the boundary is exactly
 * the kind of thing that gets guessed wrong.
 */
function rangesTouch(ranges: readonly { from: number; to: number }[], from: number, to: number): boolean {
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i] as { from: number; to: number }
    if (r.from <= to && r.to >= from) return true
  }
  return false
}

/** Result of one build pass: what CM6 draws, and what the caret must step over. */
export interface Built {
  decorations: DecorationSet
  atoms: RangeSet<Decoration>
}

/**
 * The line decoration for one line of a `span:'line'` construct.  `first`/`last`
 * are computed against the construct's TRUE bounds, not the clipped ones, so a
 * block whose opening fence is scrolled off screen still draws its visible tail
 * as `nc-cb` / `nc-cb-last` and never as `nc-cb-first`.
 */
function lineDeco(c: Construct, line: Line): Decoration | null {
  switch (c.kind) {
    case 'codeblock': {
      const first = line.from === c.from
      const last = line.to === c.to
      return first && last ? CB_ONLY : first ? CB_FIRST : last ? CB_LAST : CB_MID
    }
    case 'heading':
      return headingDeco(c.detail)
    case 'hr':
      return HR_LINE
    case 'listUl':
    case 'listOl':
      // detail: 0 plain · 1 a task line · 2 a task line whose box is TICKED.
      return c.detail === 2 ? LIST_LINE_DONE : LIST_LINE
    case 'blockquote':
      return c.detail > 1 ? QUOTE_LINE_N : QUOTE_LINE_1
    default:
      return null
  }
}

/** The mark decoration over an inline construct's body, and how far it reaches. */
function bodyDeco(kind: ConstructKind): Decoration | null {
  switch (kind) {
    case 'strong': return STRONG
    case 'emphasis': return EM
    case 'strikethrough': return STRIKE
    case 'highlight': return HIGHLIGHT
    case 'inlineCode': return INLINE_CODE
    case 'link': return LINK_TEXT
    // §0.39 E86 — the SAME class, because Obsidian gives it the same rule:
    // CM5 tags the inside of an autolink `link` with no `url` and no
    // `formatting`, which is its decorator's `E`, which is `cm-underline` over
    // `.cm-link` — the treatment `[text](url)`'s text gets.
    case 'autolink': return LINK_TEXT
    case 'wikilink': return WIKILINK_TEXT
    case 'url': return URL_TEXT
    default: return null
  }
}

/**
 * What replaces a marker that is NOT revealed.  `null` means "delete it from
 * the rendered line", which is the common case; everything else is a marker
 * Obsidian re-draws rather than removes.
 */
function hiddenDeco(c: Construct, index: number): Decoration {
  switch (c.kind) {
    case 'listUl':
      // `detail >= 1` is the task line, whose bullet goes entirely — 1 open,
      // 2 ticked (see LIST_LINE_DONE). It was `=== 1` while the done state had
      // nowhere else to live.
      return c.detail >= 1 ? HIDE_MARK : BULLET
    case 'listOl':
      return c.detail >= 1 ? HIDE_MARK : NUMBER
    case 'blockquote':
      // The first `>` keeps its place and the line's own ::before draws the
      // rule; every deeper one becomes a widget carrying its own rule.
      return index === 0 ? QUOTE_MARK : QUOTE_BORDER
    case 'task':
      return c.detail === 1 ? TASK_ON : TASK_OFF
    case 'hr':
      return RULE
    default:
      return HIDE_MARK
  }
}

/**
 * Is this marker one the caret must step OVER?  A marker that is re-drawn in
 * place (a bullet, a quote rule) still occupies its own text, so making it
 * atomic would put the caret on the wrong side of a character that is visibly
 * there.  Only the runs that vanish are atomic.
 */
function isAtomic(deco: Decoration): boolean {
  return deco === HIDE_MARK || deco === RULE || deco === TASK_ON || deco === TASK_OFF || deco === QUOTE_BORDER
}

/** The class a revealed marker carries — see SHOW_MARK / SHOW_PLAIN. */
function shownDeco(kind: ConstructKind): Decoration {
  switch (kind) {
    case 'heading':
    case 'blockquote':
    case 'listUl':
    case 'listOl':
    case 'link':
    case 'autolink':
    case 'wikilink':
      return SHOW_MARK
    default:
      return SHOW_PLAIN
  }
}

/**
 * The decoration pass.  Takes the RANGES, not the view, so it is exactly the
 * function `tests/frontend/livepreview.test.mjs` calls with no DOM — the
 * viewport-only rule is then a property of the caller, and the thing under test
 * is the markdown model itself.
 *
 * `active` is the selection as the decorator is allowed to see it.  Obsidian
 * computes it as `view.hasFocus ? state.selection.ranges : []`: an UNFOCUSED
 * editor reveals nothing at all, which is why clicking into the file tree makes
 * an Obsidian note render clean.  Passing `null` means "take it from `state`",
 * which is what every caller that has no view does.
 *
 * `source` is §2's seam.  It defaults to §3's scanner; passing another is how a
 * third implementation lands, and how a test drives the decorator with
 * constructs no scanner can produce.
 */
export function buildDecorations(
  state: EditorState,
  ranges: readonly { from: number; to: number }[],
  source: ConstructSource = markdownSource,
  active: readonly { from: number; to: number }[] | null = null
): Built {
  const decos: { from: number; to: number; value: Decoration }[] = []
  const atomRanges: { from: number; to: number; value: Decoration }[] = []
  const doc = state.doc
  const sel = active ?? state.selection.ranges
  // Whole lines: a viewport that starts mid-line still decorates that line.
  let lo = 0
  let hi = 0
  // The last line looked up, reused when the next lookup lands on it.  A
  // `span:'line'` construct's markers sit on lines the loop above just walked,
  // so this turns the per-marker `lineAt` binary search into a compare; without
  // it the seam costs a measured +0.4 us per rebuild for nothing.
  let cached: Line | null = null
  const lineAt = (pos: number): Line => {
    const c = cached
    if (c !== null && pos >= c.from && pos <= c.to) return c
    const line = doc.lineAt(pos)
    cached = line
    return line
  }
  const add = (from: number, to: number, value: Decoration): void => {
    decos.push({ from, to, value })
  }

  /* §0.35 E81 / §0.51 E99 — the leading indent run of a list line, its own pass
     over the visible lines.  It is NOT a construct: no marker opens it and
     nothing closes it, so it has no place in the scanner's vocabulary.  A
     separate walk of the lines already bounded by `[lo, hi]` costs one regex per
     visible line and keeps the construct pipeline unchanged. */
  const markListIndents = (): void => {
    let pos = lo
    while (pos <= hi) {
      const line = lineAt(pos)
      const ind = listIndentAt(doc, line)
      if (ind !== null) {
        // A CONTINUATION gives the top half of `--list-spacing` back; an ITEM
        // at depth keeps both halves, like any other list line.
        if (ind.cont) add(line.from, line.from, LIST_CONT_LINE)
        const groups = indentGroups(line.text.slice(0, ind.n))
        for (let g = 0; g < groups.length; g++) {
          const grp = groups[g] as IndentGroup
          const pad = ind.cont && !grp.full && g === groups.length - 1
          add(line.from + grp.from, line.from + grp.to,
              grp.full ? INDENT_FULL : pad ? INDENT_SPACING_PAD : INDENT_SPACING)
        }
      }
      pos = line.to + 1
    }
  }

  // Built ONCE per call, not once per range: the sink is on the hot path.
  const sink: ConstructSink = (c) => {
    if (c.span === 'line') {
      let pos = c.from > lo ? c.from : lo
      const end = c.to < hi ? c.to : hi
      while (pos <= end) {
        const line = lineAt(pos)
        const d = lineDeco(c, line)
        if (d) add(line.from, line.from, d)
        pos = line.to + 1
      }
    }

    // Where the construct is revealed, and therefore whether its markers are
    // hidden at all.  One test per construct, not one per marker.
    const scope = revealScope(c.kind)
    const revealed =
      scope === 'line'
        ? rangesTouch(sel, lineAt(c.from).from, lineAt(c.from).to)
        : scope === 'construct'
          ? rangesTouch(sel, c.from, c.to)
          : false      // 'marker' is decided per marker, below

    const body = c.span === 'inline' ? bodyDeco(c.kind) : null
    if (body !== null) {
      const marks = c.markers
      // A link's underline is the one body that stops at its markers — true of
      // `[text](url)` and of `[[wikilink]]`, and vacuous for a bare url, which
      // has no markers at all.
      const stops = c.kind === 'link' || c.kind === 'wikilink' || c.kind === 'autolink'
      const from = stops && marks.length > 0 ? (marks[0] as Marker).to : c.from
      const to = stops && marks.length > 1 ? (marks[1] as Marker).from : c.to
      const f = from < lo ? lo : from
      const t = to > hi ? hi : to
      if (f < t) add(f, t, body)
    }

    const marks = c.markers
    for (let i = 0; i < marks.length; i++) {
      const mk = marks[i] as Marker
      if (mk.from >= hi || mk.to <= lo) continue
      const show = scope === 'marker' ? rangesTouch(sel, mk.from, mk.to) : revealed
      if (show) {
        add(mk.from, mk.to, shownDeco(c.kind))
      } else if (mk.to > doc.lineAt(mk.from).to) {
        // F84 defence in depth: a plugin-supplied replace across a line break
        // is always fatal in CM6, so show the raw source instead of wedging.
        add(mk.from, mk.to, shownDeco(c.kind))
      } else {
        // A pasted image is replaced by its widget, over the whole run, and
        // the run is atomic — one Backspace or Delete takes it.  `isAtomic`
        // below compares singleton identity, which a per-image widget can
        // never satisfy, so the kind carries the atomicity instead.
        const deco = c.kind === 'image' ? imageDeco(doc, mk.from, mk.to) : hiddenDeco(c, i)
        add(mk.from, mk.to, deco)
        if (c.kind === 'image' || isAtomic(deco)) atomRanges.push({ from: mk.from, to: mk.to, value: deco })
      }
    }
  }

  for (const { from, to } of ranges) {
    lo = doc.lineAt(from).from
    hi = doc.lineAt(to).to
    cached = null
    source.constructsIn(state, lo, hi, sink)
    markListIndents()
  }
  return {
    // `sort: true`, not a `RangeSetBuilder`: nested constructs close inner
    // first, so the sink sees `from` out of order (seam rule 3's amendment).
    decorations: Decoration.set(decos.map((d) => d.value.range(d.from, d.to)), true),
    atoms: RangeSet.of(atomRanges.map((d) => d.value.range(d.from, d.to)), true),
  }
}

export class LivePreview {
  decorations: DecorationSet
  atoms: RangeSet<Decoration>
  /** A rebuild was held back by a composition and is still owed. */
  stale = false
  constructor(view: EditorView) {
    const r = buildDecorations(view.state, view.visibleRanges, markdownSource, activeRanges(view))
    this.decorations = r.decorations
    this.atoms = r.atoms
  }
  update(u: ViewUpdate): void {
    // F77: never change the reveal state mid-composition. The first composed
    // character moves the caret past the closing marker, which would flip it
    // from revealed to hidden while Chrome holds the composition inside the
    // body mark — CM6's composition-preserving redraw then drops the
    // construct's text from the DOM and the diff comes back as a deletion.
    // `composing` (not `compositionStarted`): a change must have been made in
    // this composition for the redraw hazard to exist.
    if (u.view.composing) {
      this.decorations = this.decorations.map(u.changes)
      this.atoms = this.atoms.map(u.changes)
      this.stale = true
      return
    }
    // `selectionSet` is unconditional: §5.4.1's reveal is the shipped behaviour.
    // Measured cost of a rebuild is 0.017 ms (spec-03 §6.3); a scroll does not
    // raise selectionSet, so the reveal never lands on a scrolling frame.
    //
    // `focusChanged` is new, and it is the whole of what makes an unfocused
    // note render clean: `activeRanges` returns nothing when the view is not
    // focused, and neither focus nor blur is a document or a selection change.
    // CM6 raises the flag itself — `observers.focus -> updateForFocusChange ->
    // view.update([])` on a 10 ms timeout (@codemirror/view/dist/index.js:5230)
    // — which is the same 10 ms timeout Obsidian's `D6` re-implements on top of
    // it, so no DOM handler of our own is needed here.
    if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged || this.stale) {
      this.stale = false
      const r = buildDecorations(u.view.state, u.view.visibleRanges, markdownSource, activeRanges(u.view))
      this.decorations = r.decorations
      this.atoms = r.atoms
    }
  }
}

const EMPTY_RANGES: readonly { from: number; to: number }[] = []

/** Obsidian's `t10.hasFocus ? d11.selection.ranges : []`, exactly. */
function activeRanges(view: EditorView): readonly { from: number; to: number }[] {
  return view.hasFocus ? view.state.selection.ranges : EMPTY_RANGES
}

export const livePreview = ViewPlugin.fromClass(LivePreview, {
  decorations: (v) => v.decorations,
  eventObservers: {
    // F77: the rebuild a composition held back. CM6's own post-composition
    // `view.update([])` is empty and never reaches plugins, so without this
    // the reveal state lags until the next keystroke. Deferred: this observer
    // runs before CM6's own `compositionend` bookkeeping, and an empty
    // transaction is neither a change nor a save.
    compositionend(this: LivePreview, _e: Event, view: EditorView) {
      setTimeout(() => {
        if (this.stale && !view.compositionStarted && view.plugin(livePreview) === this) view.dispatch({})
      }, 60)
    },
  },
})

/* ===========================================================================
 * 4a.  THE LINK CLICK (§0.38 E85).  `KNOWN-ISSUES.md` LP-1, closed.
 *
 * §0.36 E83 made three kinds of link RENDER; two of them carried
 * `cursor: pointer` and nothing listened, which is the affordance §9 E4 exists
 * to forbid.  This is the listener, and the policy is Obsidian's own, read out
 * of `onEditorClick` in `app.js` rather than chosen:
 *
 *   o.addEventListener("click",     r.onEditorClick.bind(r))
 *   o.addEventListener("mousedown", r.onEditorClick.bind(r), { capture: true })
 *   … if ("click" === e.type && 0 === e.button) || ("mousedown" === e.type && 1 === e.button)
 *
 * **`click`, NOT `mousedown`** — and the reason is in the next branch: it bails
 * when the window's selection is non-collapsed inside the target, so a DRAG
 * that selects the text of a link does not then navigate on release. A
 * mousedown handler cannot tell those two apart at all. The middle-button arm
 * is `mousedown` because a middle click has no `click` event to wait for.
 *
 * WHAT COUNTS AS A NAVIGATING CLICK, from the same function:
 *   i = isModifier(e, "Mod") || button === 1          // the "mod" flag
 *   … (sourceMode || button !== 0 || i || (!altKey && !shiftKey))
 * so in live preview a plain left click navigates unless alt or shift is held,
 * and a Mod-click always does.
 *
 * AND THE THREE CLASSES ARE NOT EQUAL:
 *   if ("internal-link" === l.type) { if (!matchParent(".cm-underline")) return false … }
 *   if ("external-link" === l.type) { … if (!matchParent(".cm-underline")) return false
 *                                     if (matchParent(".cm-url")) return true … }
 * A bare url never gets `.cm-underline` (§0.36's `L` branch is outside `S`), so
 * **a plain click on one is refused in Obsidian too** and only a Mod-click opens
 * it. That is the same fact that decides its cursor, and E83 had already
 * transcribed the cursor half.
 * ========================================================================= */

/** Where a link points, once the markers and the alias are off it. */
export type LinkTarget =
  | { kind: 'external'; url: string }
  | { kind: 'internal'; path: string; subpath: string }

/** `scheme:` — RFC 3986's, and Obsidian's own `/^([a-z0-9+.-]+):/` test. */
const SCHEME_RE = /^[a-z][a-z0-9+.\-]*:/i

/**
 * The link at `pos`, or null.  **Takes a state, not a view**, so the whole of
 * this decision is testable with no DOM — the DOM only ever answers "did the
 * pointer land on a link span", which is a question about pixels.
 *
 * §2's seam again: the constructs come from the source, and the text comes from
 * the document. Nothing here knows a regex.
 */
export function linkTargetAt(state: EditorState, pos: number): LinkTarget | null {
  const line = state.doc.lineAt(pos)
  let found: LinkTarget | null = null
  markdownSource.constructsIn(state, line.from, line.to, (c) => {
    if (found !== null) return
    if (pos < c.from || pos > c.to) return
    if (c.kind === 'url') {
      found = externalTarget(state.doc.sliceString(c.from, c.to))
    } else if (c.kind === 'autolink') {
      // Between the angles, which is what Obsidian's `UE()` takes out of one.
      found = externalTarget(state.doc.sliceString(c.from + 1, c.to - 1))
    } else if (c.kind === 'wikilink') {
      // `[[inner]]`, and `inner` may carry `|alias` and `#subpath`.
      found = internalTarget(state.doc.sliceString(c.from + 2, c.to - 2))
    } else if (c.kind === 'link' && c.markers.length > 1) {
      // The close marker is `](dest)` — §3 emits it whole.
      const mk = c.markers[1] as Marker
      const dest = state.doc.sliceString(mk.from + 2, mk.to - 1).trim()
      found = SCHEME_RE.test(dest) ? externalTarget(dest) : internalTarget(dest)
    }
  })
  return found
}

/**
 * A url with no scheme gets one, which is Obsidian's own last line:
 * `tm(F) ? F = "mailto:" + F : /^([a-z0-9+.-]+):/.test(F) || (F = "https://" + F)`.
 * The email test is the scanner's own literal, so the two cannot disagree about
 * what an email is.
 */
function externalTarget(text: string): LinkTarget {
  const t = text.trim()
  if (SCHEME_RE.test(t)) return { kind: 'external', url: t }
  EMAIL_RE.lastIndex = 0
  const m = EMAIL_RE.exec(t)
  const email = m !== null && (m[0] as string).length === t.length
  return { kind: 'external', url: (email ? 'mailto:' : 'https://') + t }
}

/** `target|alias` -> target, `target#heading` -> target + subpath. */
function internalTarget(inner: string): LinkTarget {
  const pipe = inner.indexOf('|')
  const path = (pipe < 0 ? inner : inner.slice(0, pipe)).trim()
  const hash = path.indexOf('#')
  return hash < 0
    ? { kind: 'internal', path, subpath: '' }
    : { kind: 'internal', path: path.slice(0, hash).trim(), subpath: path.slice(hash) }
}

/**
 * The pasted-image run around `pos`, or null.  **Takes a state, not a view**,
 * like `linkTargetAt` above, so the whole of this decision is testable with no
 * DOM — the X button's mousedown handler is the only DOM caller.  A file or
 * remote image is not an `'image'` construct and never answers here.
 */
export function imageRangeAt(state: EditorState, pos: number): { from: number; to: number } | null {
  const line = state.doc.lineAt(pos)
  let found: { from: number; to: number } | null = null
  markdownSource.constructsIn(state, line.from, line.to, (c) => {
    if (found !== null || c.kind !== 'image') return
    if (pos < c.from || pos > c.to) return
    found = { from: c.from, to: c.to }
  })
  return found
}

/**
 * What the app does with a link the user clicked.  Registered from `main.ts`,
 * which is the only place that knows what a vault is — this module resolves
 * nothing and opens nothing.
 */
export interface LinkHost {
  external(url: string): void
  internal(path: string, subpath: string): void
}

let linkHost: LinkHost | null = null

export function registerLinkHost(host: LinkHost | null): void {
  linkHost = host
}

/** `.nc-url` is the bare url — the one that needs a modifier. */
const LINK_SELECTOR = '.nc-url, .nc-ilink, .nc-link'

function handleLinkClick(view: EditorView, ev: MouseEvent): boolean {
  if (linkHost === null || ev.button !== 0) return false
  const el = ev.target
  if (!(el instanceof HTMLElement)) return false
  const span = el.closest(LINK_SELECTOR)
  if (span === null) return false

  const mod = ev.ctrlKey || ev.metaKey
  // Obsidian's `(!altKey && !shiftKey)`: those two are selection modifiers, and
  // a click holding one is not a navigation.
  if (!mod && (ev.altKey || ev.shiftKey)) return false
  // …and its selection guard, which is why this is a `click` handler: a drag
  // that ends inside a link must select, not navigate.
  if (!view.state.selection.main.empty) return false
  // A bare url has no `.cm-underline` in Obsidian, so its own handler refuses a
  // plain click on one. Mod-click opens it there and here.
  if (span.classList.contains('nc-url') && !mod) return false

  const pos = view.posAtCoords({ x: ev.clientX, y: ev.clientY })
  if (pos === null) return false
  const target = linkTargetAt(view.state, pos)
  if (target === null) return false
  if (target.kind === 'external') linkHost.external(target.url)
  else linkHost.internal(target.path, target.subpath)
  return true
}

/** The extension.  `editor.ts` mounts it beside the rest of live preview. */
export const linkClicks: Extension = EditorView.domEventHandlers({
  click: (ev, view) => handleLinkClick(view, ev),
})

/* ===========================================================================
 * 4b.  THE HANGING INDENT ON A WRAPPED LIST LINE (§0.31 E75).
 *
 * Reported by the user: the continuation rows of a bullet sat at the line's
 * left edge instead of under the bullet's TEXT.  Measured in the real engine
 * before the fix — a four-row list item at content x 444: first row's ink at
 * 456, every wrapped row at 444, `text-indent` and `padding-inline-start` both
 * `0px`.  Cairn did nothing at all.
 *
 * OBSIDIAN'S OWN ALGORITHM, and the shape of it is the finding: the offset is
 * **MEASURED, NOT COMPUTED**.  Its plugin (`uj` in app.js) does, per visible
 * line with a list prefix:
 *
 *     lineEl.style.textIndent = ''; lineEl.style.paddingInlineStart = ''
 *     const y = view.coordsAtPos(line.from + prefix.length, 1)
 *     let k = Math.floor(Math.abs(y.right - contentLeft))
 *     if (k > lineEl.offsetWidth / 2) k = <retry with side -1>
 *     lineEl.style.textIndent = -k + 'px'
 *     lineEl.style.paddingInlineStart = k + 'px'
 *
 * A token could not do this.  The prefix is `- `, `* `, `12. `, `- [ ] `, any
 * of them behind any depth of indentation and any number of `> ` quotes, and
 * its width is whatever the font makes it.  Obsidian asks the layout.
 *
 * `--list-indent` IS NOT THAT NUMBER and must not be used here: Obsidian's own
 * `.cm-line.HyperMD-list-line { tab-size: var(--list-indent) }` spends it on
 * TAB WIDTH inside the prefix, which is a different question.
 *
 * WHY `requestMeasure` AND NOT `update()`.  CM6 forbids DOM writes from
 * `update`, and a write that changes how a line WRAPS changes its height — the
 * exact class of hazard §0.26 E62 records.  `requestMeasure({read, write})`
 * runs both halves inside CM6's own measure cycle, so the heights CM6 records
 * are the heights after the write.  `live-preview.test.mjs`'s two height-map
 * rows are the guard, and they are why this is safe to do to the DOM at all.
 * ========================================================================= */

/** Obsidian's `bO`, verbatim (app.js): quote/indent prefix, then an optional
 *  bullet or ordered marker, then an optional task box.  `lj` returns the whole
 *  match only when it is non-empty, which is what makes a plain paragraph line
 *  fall out of this plugin. */
export const LIST_PREFIX_RE = /^([>\s]*)(([*+-] |(\d+)([.)] ))(?:\[(.)\] )?)?/

/** Obsidian's `lj`. `null` for a line with no prefix at all. */
export function listPrefix(text: string): string | null {
  const m = LIST_PREFIX_RE.exec(text)
  return m && m[0] ? m[0] : null
}

class HangingIndent {
  /** line number -> the px offset last written, so an unchanged line is not
   *  re-written on every scroll. Obsidian keeps the same cache for the same
   *  reason (`indentCache`). */
  private readonly cache = new Map<number, number>()

  constructor(view: EditorView) { this.schedule(view) }

  update(u: ViewUpdate): void {
    // `geometryChanged` is the one that is easy to leave out and the one that
    // matters most: a sidebar drag re-wraps every line without touching the
    // document, and a stale indent would then be measured against the old width.
    if (u.docChanged || u.viewportChanged || u.geometryChanged) {
      if (u.docChanged) this.cache.clear()
      this.schedule(u.view)
    }
  }

  private schedule(view: EditorView): void {
    view.requestMeasure<Map<HTMLElement, number>>({
      read: (v) => this.measure(v),
      write: (sizes) => {
        for (const [el, k] of sizes) {
          el.style.textIndent = -k + 'px'
          el.style.paddingInlineStart = k + 'px'
        }
      },
    })
  }

  private measure(view: EditorView): Map<HTMLElement, number> {
    const out = new Map<HTMLElement, number>()
    const idx = view.state.field(blockIndex, false)
    for (const block of view.viewportLineBlocks) {
      const line = view.state.doc.lineAt(block.from)
      const prefix = listPrefix(line.text)
      if (prefix === null) continue
      // A fenced block's lines are code, never lists — the same exclusion
      // Obsidian makes with `cj`, reached here through §5.3's own block index
      // instead of through a syntax tree Cairn does not build.
      if (idx && idx.blockAt(line.from)) continue
      const el = lineElementAt(view, line.from)
      if (el === null) continue
      // RESET BEFORE MEASURING, or the second pass measures the first pass's
      // own indent and the line walks right on every update.
      el.style.textIndent = ''
      el.style.paddingInlineStart = ''
      const at = view.coordsAtPos(line.from + prefix.length, 1)
      if (!at) continue
      const box = el.getBoundingClientRect()
      const left = box.left + parseFloat(getComputedStyle(el).paddingLeft || '0')
      // `.right`, WHICH IS OBSIDIAN'S, and on this DOM it is the same number as
      // `.left`: `coordsAtPos` answers a position with a ZERO-WIDTH caret rect,
      // instrumented here at 466.3125 for both edges.  Recorded because a first
      // pass changed this to `.left` on the theory that `.right` was
      // overshooting by the width of the next character — it was not, and the
      // instrumented run is what said so.  Cairn is LTR only (no
      // `textDirection` anywhere in this app), so Obsidian's RTL arm has no
      // counterpart here rather than being dropped silently.
      let k = Math.floor(Math.abs(at.right - left))
      // Obsidian's guard. `coordsAtPos(..., 1)` can answer with the START of the
      // NEXT wrapped row when the prefix ends exactly on a wrap boundary, which
      // reads as an offset most of the line wide; side -1 asks for the end of
      // the previous row instead.
      if (k > el.offsetWidth / 2) {
        const back = view.coordsAtPos(line.from + prefix.length, -1)
        if (!back) continue
        k = Math.floor(Math.abs(back.right - left))
      }
      if (!k) continue
      if (this.cache.get(line.number) === k) {
        // Unchanged — but the reset above has already cleared the style, so it
        // still has to be written back. The cache saves the MEASUREMENT, not
        // the write.
        out.set(el, k)
        continue
      }
      this.cache.set(line.number, k)
      out.set(el, k)
    }
    return out
  }
}

/** The `.cm-line` element for a document position, or `null` when CM6 has not
 *  rendered it (a line scrolled out between the update and the measure). */
function lineElementAt(view: EditorView, pos: number): HTMLElement | null {
  const dom = view.domAtPos(pos).node
  const el = dom instanceof HTMLElement ? dom : dom.parentElement
  return el === null ? null : (el.closest('.cm-line') as HTMLElement | null)
}

export const listHangingIndent = ViewPlugin.fromClass(HangingIndent)

/** §5.4.1: arrows step OVER a hidden marker instead of into it.  Hidden runs only. */
export const livePreviewAtomicRanges: Extension = EditorView.atomicRanges.of(
  (view) => view.plugin(livePreview)?.atoms ?? RangeSet.empty
)
/* ===========================================================================
 * 5.  The inline title (§5.4.2, X18) — a BLOCK WIDGET at document position 0.
 *     Block decorations may not come from a ViewPlugin, so it is a StateField.
 * ========================================================================= */

/**
 * The host that turns a click on the title into a rename.  Registered by
 * editor.ts, which owns `rename_entry`, the `beforeinput` filter and the
 * validation; this file owns only the widget and the click gesture.
 */
export interface TitleRenameHost {
  /**
   * One click landed on the title box.  `el` is the `.nc-title` element.
   *
   * `caret` is the character offset the click landed on, so the editor can put
   * the caret where the user pointed instead of selecting the whole name.
   * MEASURED against Obsidian 1.13.7: its inline title is a persistent
   * `contenteditable` and a click places the caret; it does not select.
   * `undefined` means "no pointer position" — a programmatic open, e.g. the
   * one that follows New note — and THAT case does select all, which is what
   * Obsidian does for a freshly created `Untitled`.
   */
  begin(el: HTMLElement, base: string, caret?: number): void
}

/**
 * Character offset within `el`'s text for a viewport point, or `undefined` if
 * the platform will not tell us (in which case the caller selects all, the
 * previous behaviour).
 */
function caretOffsetAt(el: HTMLElement, x: number, y: number): number | undefined {
  const doc = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null
  }
  const range = doc.caretRangeFromPoint?.(x, y)
  if (!range) return undefined
  // The widget holds a single text node; anything else means the DOM moved on
  // us and an offset would be meaningless.
  const node = el.firstChild
  if (!node || range.startContainer !== node) return undefined
  return range.startOffset
}

let renameHost: TitleRenameHost | null = null

export function registerTitleRenameHost(host: TitleRenameHost | null): void {
  renameHost = host
}

class TitleWidget extends WidgetType {
  /** True while the rename `<input>` is mounted inside this widget's DOM. */
  editing = false

  constructor(readonly base: string) { super() }

  /** No rebuild while the name is unchanged (§5.5). */
  override eq(o: WidgetType): boolean {
    return o instanceof TitleWidget && o.base === this.base
  }

  /**
   * §5.4.2 writes `ignoreEvent: () => false` so the click reaches our handler.
   * That holds for the STATIC title, and it is what this returns.  While the
   * rename `<input>` is mounted it returns `true` instead: with `false` CM6
   * handles the mousedown itself, maps it to document position 0 and pulls the
   * selection (and the focus) back into `.cm-content`, so the field could not
   * be clicked into or typed in.  The gesture the contract asks for is
   * preserved exactly; only the state the contract does not describe differs.
   */
  override ignoreEvent(): boolean {
    return this.editing
  }

  /**
   * THE RETURNED ELEMENT IS A WRAPPER, AND THAT IS LOAD-BEARING (§5.4.2).
   * CM6 records this block's height as `toDOM()`'s own
   * `getBoundingClientRect().height` — a BORDER BOX, so `.nc-title`'s
   * `margin-bottom` (Obsidian's `--inline-title-margin-bottom`, 12.944px) was
   * real to the layout and absent from the height map.  `posAtCoords` picks a
   * block out of that map, so every click in the note landed 12.944px too far
   * down the document, and a note with frontmatter (whose panel adds another
   * 32px the same way) put the caret two lines below the pointer.
   * `.nc-block` is `display: flow-root`, which contains the margin instead of
   * letting it collapse out — see editor.css §1b.  The wrapper carries NO
   * geometry of its own, so `.nc-title`'s box, margin and click target are
   * exactly what they were and every G9 title row still reads the same number.
   */
  override toDOM(): HTMLElement {
    const box = document.createElement('div')
    box.className = 'nc-block'
    const el = document.createElement('div')
    el.className = 'nc-title'
    el.textContent = this.base
    // One click — not a double-click, and not a drag (§5.4.2).
    let dx = 0, dy = 0
    el.addEventListener('mousedown', (e) => { dx = e.clientX; dy = e.clientY })
    el.addEventListener('click', (e) => {
      if (this.editing) return
      if (e.detail !== 1) return
      if (Math.abs(e.clientX - dx) > 2 || Math.abs(e.clientY - dy) > 2) return
      const host = renameHost
      if (!host) return
      const caret = caretOffsetAt(el, e.clientX, e.clientY)
      this.editing = true
      host.begin(el, this.base, caret)
    })
    box.appendChild(el)
    return box
  }
}

/**
 * Called by editor.ts when the rename editor closes, however it closed, so the
 * widget goes back to letting CM6 see events (see `ignoreEvent` above).
 */
export function endTitleEditing(view: EditorView): void {
  const set = view.state.field(titleField, false)
  if (!set) return
  set.between(0, 0, (_f, _t, value) => {
    const w: unknown = value.spec.widget
    if (w instanceof TitleWidget) w.editing = false
  })
}

/** `null` clears the title (no note open, §7.4's empty state). */
export const setTitle = StateEffect.define<string | null>()

/**
 * The basename WITHOUT `.md` the next `EditorState.create` should start with.
 * A vault or note switch is `view.setState(...)`, which builds a fresh state —
 * setting this first means the title is present on the very first layout, so
 * the first body line's box top is 113.0656 from frame one rather than after a
 * follow-up transaction.
 */
let initialTitle: string | null = null

export function setInitialTitle(base: string | null): void {
  initialTitle = base
}

function titleDeco(base: string | null): DecorationSet {
  if (base === null) return Decoration.none
  return Decoration.set([
    Decoration.widget({ widget: new TitleWidget(base), block: true, side: -1 }).range(0),
  ])
}

export const titleField = StateField.define<DecorationSet>({
  create: () => titleDeco(initialTitle),
  update(deco, tr) {
    let next = deco.map(tr.changes)
    for (const e of tr.effects) if (e.is(setTitle)) next = titleDeco(e.value)
    return next
  },
  provide: (f) => EditorView.decorations.from(f),
})
