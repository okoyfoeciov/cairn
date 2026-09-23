/**
 * src/properties.ts
 * Owner: 03.  Spec: CONTRACT.md §5.4.5 (the Properties block), §5.4.4 (the live
 * preview it sits inside), §5.4.2 (the inline title it sits under).
 *
 * ===========================================================================
 * WHAT OBSIDIAN DOES, READ RATHER THAN DERIVED (§0.17's method)
 * ===========================================================================
 * A note whose first line is `---` has YAML frontmatter, and in Live Preview
 * Obsidian does not show it: it shows a **Properties** block instead. The
 * mechanism, from `obsidian.asar` 1.12.7's `app.js`:
 *
 *     ZA = Decoration.mark({ class: "is-invalid" })
 *     JA = Decoration.replace({ block: true })          // <- the hider
 *
 *     StateField.update(_, tr) {
 *       const end = tP(tr.newDoc)                       // -1, or the closing `---`'s `to`
 *       let hide = end !== -1 && getConfig('propertiesInDocument') !== 'source'
 *       if (end !== -1) {
 *         const err = parseYaml(doc.sliceString(3, end - 3))
 *         if (err) { hide = false; push(ZA.range(0, end)) }   // INVALID YAML IS SHOWN
 *       }
 *       if (hide) push(JA.range(0, end))
 *       return Decoration.set(decos, true)
 *     }
 *
 * and `tP` is strict — line 1 must be exactly `---`, and the block ends at the
 * first later line that is exactly `---`. There is a companion
 * `transactionFilter` that clamps every selection range to `>= end + 1` and
 * CANCELS any transaction that would edit inside the hidden run.
 *
 * The three things worth naming, because each is a decision a re-derivation
 * would get wrong:
 *
 *   1. INVALID YAML IS NOT HIDDEN. `hide = false` on a parse error, and the run
 *      is marked `is-invalid` instead. A note you cannot see is worse than a
 *      note that shows its own broken frontmatter, and this file follows it:
 *      `parseFrontmatter` returns `null` for anything it does not FULLY
 *      understand, and null means "render it raw".
 *   2. THE PANEL IS NOT A DECORATION IN OBSIDIAN. Its `metadata-container` is a
 *      plain div prepended into `.cm-sizer` next to the inline title, because it
 *      is a live editor bound to the metadata cache. Cairn's is read-only and
 *      derived from the same range, so ONE `Decoration.replace({block:true,
 *      widget})` does both jobs and lands the panel in the same place — after
 *      the title (a block widget at 0 with `side: -1`) and before the content.
 *   3. THE TYPE ICONS ARE OBSIDIAN'S OWN MAP, not a guess. app.js:33112 is
 *      `registeredTypeWidgets = { aliases: bO, checkbox: TO, date: EO, datetime:
 *      MO, file: CO, folder: kO, multitext: PO, property: yO, number: xO, tags:
 *      wO, text: rO }` and each widget carries `icon:`. `inferType` below is
 *      app.js:33085, transcribed.
 *
 * ===========================================================================
 * IT EDITS NOW — AND WHAT IT STILL DOES NOT DO
 * ===========================================================================
 * The first version of this file was read-only, and drew no "+ Add property"
 * button because §9 E4 forbids an inert control. The user asked where the
 * button was. The answer was to make it work rather than to draw a dead one,
 * so: **the key is a real `<input>`, a scalar value is a real
 * `contentEditable`, a checkbox toggles, and the button adds a property.**
 *
 * **EVERY WRITE IS ONE LINE AND NEVER A RE-SERIALISATION** — §4 is the whole
 * argument, and it is the reason this could land without a data-loss pass of
 * its own: nothing in the block is rewritten except the line being edited, so
 * a comment, a quoting style or a construct §1 refuses cannot be destroyed by
 * an edit somewhere else in the same block.
 *
 * STILL ABSENT, each because it is a feature and not a corner:
 *   · DELETING a property (Obsidian puts it on a context menu)
 *   · editing a LIST — `tags`, `aliases`, any block sequence. `isScalar` gates
 *     it, because a one-line write cannot reach a value that lives on the
 *     following lines
 *   · the TYPE PICKER, drag reorder, and autocomplete against the vault's
 *     property names, all of which need the `metadataTypeManager` Cairn has no
 *     equivalent of
 * ------------------------------------------------------------------------- */

import { EditorState, StateEffect, StateField } from '@codemirror/state'
import type { Extension, Text } from '@codemirror/state'
import { Decoration, EditorView, WidgetType } from '@codemirror/view'
import type { DecorationSet } from '@codemirror/view'
import { frontmatterEnd } from './livepreview'
import { paintIcons } from './icons'
import type { IconName } from './icons'

/* ===========================================================================
 * 1.  The YAML subset.
 *
 *     A DELIBERATELY SMALL PARSER WITH A LOUD FAILURE MODE.  It returns `null`
 *     — meaning "show the frontmatter raw, as source" — for every construct it
 *     does not fully understand, and it is written so that the list of those is
 *     short and stated:
 *
 *       block scalars (`|`, `>`), anchors and aliases (`&`, `*`), explicit tags
 *       (`!`), tab indentation, a nested map more than one level deep, a
 *       sequence of anything but scalars, and a flow mapping (`{a: b}`).
 *
 *     That is not a shortcut around writing a YAML parser; it is the same
 *     decision Obsidian makes at a different threshold. A parser that GUESSES
 *     would render a Properties block that disagrees with the file, and the
 *     file is the thing being edited.
 * ========================================================================= */

export interface Entry {
  readonly key: string
  readonly value: unknown
}

/** YAML 1.2 core schema, which is what `js-yaml`'s default resolves. */
const NUMBER_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/
/** A top-level key.  Quoted keys are not accepted; nothing real uses them. */
const KEY_RE = /^([A-Za-z0-9_][\w .$@/-]*?)\s*:(?:[ \t]+(.*))?$/
/** The indent of a nested line, and what follows it. */
const INDENT_RE = /^([ ]+)(.*)$/

function parseScalar(raw: string): unknown {
  const s = raw.trim()
  if (s === '' || s === 'null' || s === '~' || s === 'Null' || s === 'NULL') return null
  if (s === 'true' || s === 'True' || s === 'TRUE') return true
  if (s === 'false' || s === 'False' || s === 'FALSE') return false
  if (NUMBER_RE.test(s)) return Number(s)
  if (s.length >= 2 && s.charCodeAt(0) === 34 && s.charCodeAt(s.length - 1) === 34) {
    // A double-quoted YAML scalar and a JSON string agree on every escape YAML
    // uses that JSON also has; `JSON.parse` is therefore right when it succeeds
    // and the raw-with-quotes-stripped is the honest answer when it does not.
    try { return JSON.parse(s) } catch { return s.slice(1, -1) }
  }
  if (s.length >= 2 && s.charCodeAt(0) === 39 && s.charCodeAt(s.length - 1) === 39) {
    return s.slice(1, -1).replace(/''/g, "'")
  }
  return s
}

/** `[a, b, c]`.  Nested brackets are not split and are therefore rejected. */
function parseFlowSeq(raw: string): unknown[] | null {
  const inner = raw.slice(1, -1).trim()
  if (inner === '') return []
  if (/[[\]{}]/.test(inner)) return null
  return inner.split(',').map(parseScalar)
}

/**
 * The frontmatter body — the text BETWEEN the `---` lines — as ordered entries,
 * or `null` if any part of it is outside the subset above.
 *
 * Order is preserved because the Properties block is ordered by the file, not
 * alphabetically: Obsidian renders `entry.key` in document order and so does
 * this.  A `Map` would lose that for numeric-looking keys.
 */
export function parseFrontmatter(body: string): Entry[] | null {
  if (body.indexOf('\t') >= 0) return null
  const lines = body.split('\n')
  const out: Entry[] = []
  /* A DUPLICATE KEY IS A BAIL, AND IT IS MEASURED RATHER THAN REASONED.
   *
   * `KNOWN-ISSUES.md` PR-5 recorded this as *"`keyLine` finds the first, so
   * that is the line an edit writes. Untested and unruled"* — and unruled it
   * was WRONG BYTES, not an oddity: the panel drew a row per occurrence, so a
   * file holding `name:` twice showed two `name` rows, and editing the SECOND
   * one's value rewrote the FIRST one's line. The user edits the row they are
   * looking at and a different line of the file changes.
   *
   * Asked of the live Obsidian 1.13.7 with `tools/obsidian-live.mjs` rather
   * than inferred from its bundle (the string "duplicated mapping key" is not
   * in `app.js`, so the js-yaml assumption was not safe to make):
   *
   *   name: one / name: two     ->  rows 0, is-invalid TRUE, raw YAML on screen
   *   Name: one / name: two     ->  rows 2, is-invalid FALSE
   *   meta: { a: 1, a: 2 }      ->  rows 0, is-invalid TRUE   (nested too)
   *   no duplicates (control)   ->  rows 2, is-invalid FALSE
   *
   * So: EXACT and CASE-SENSITIVE, at every level. That is YAML's own rule, and
   * it is the eleventh member of a bail list this parser already has — the
   * design §0.24 E50 states, that a panel which disagrees with the file is the
   * failure being prevented.
   *
   * NOT to be confused with PR-1's duplicate GUARD, which folds case: that one
   * indexes the RENDERED ROWS against Obsidian's own
   * `rendered.find(l => l.entry.key.toLowerCase() === …)` and answers "may this
   * rename land". This one is the FILE's grammar. Two different questions, and
   * Obsidian answers them differently too. */
  const seen = new Set<string>()
  let i = 0
  while (i < lines.length) {
    const line = lines[i] as string
    if (line.trim() === '') { i++; continue }
    if (/^\s*#/.test(line)) { i++; continue }          // a whole-line comment
    const m = KEY_RE.exec(line)
    if (!m) return null
    const key = m[1] as string
    if (seen.has(key)) return null
    seen.add(key)
    const inline = m[2]
    i++
    if (inline !== undefined && inline.trim() !== '') {
      const t = inline.trim()
      if (t.charCodeAt(0) === 124 || t.charCodeAt(0) === 62) return null   // `|` or `>`
      if (t.charCodeAt(0) === 38 || t.charCodeAt(0) === 42) return null    // `&` or `*`
      if (t.charCodeAt(0) === 33) return null                              // `!tag`
      if (t.charCodeAt(0) === 123) return null                             // `{a: b}`
      if (t.charCodeAt(0) === 91) {
        if (t.charCodeAt(t.length - 1) !== 93) return null
        const seq = parseFlowSeq(t)
        if (seq === null) return null
        out.push({ key, value: seq })
        continue
      }
      out.push({ key, value: parseScalar(t) })
      continue
    }
    // `key:` with nothing after it — a block sequence, a block map, or null.
    const block: string[] = []
    while (i < lines.length) {
      const l = lines[i] as string
      if (l.trim() === '') { i++; continue }
      const im = INDENT_RE.exec(l)
      if (!im) break
      block.push(im[2] as string)
      i++
    }
    if (block.length === 0) { out.push({ key, value: null }); continue }
    if ((block[0] as string).startsWith('- ') || block[0] === '-') {
      const seq: unknown[] = []
      for (const b of block) {
        if (!b.startsWith('- ') && b !== '-') return null
        const item = b === '-' ? '' : b.slice(2)
        if (/^[[{|>&*!]/.test(item.trim())) return null
        // `- key: value` is a SEQUENCE OF MAPS in YAML, not the string
        // "key: value", and an earlier draft accepted it as the latter — which
        // is the exact failure this parser's contract exists to prevent: a
        // Properties block that disagrees with the file.  `KEY_RE` needs a
        // space after the colon, so `- https://example.com` is still a scalar,
        // as YAML also has it.
        if (KEY_RE.test(item)) return null
        seq.push(parseScalar(item))
      }
      out.push({ key, value: seq })
      continue
    }
    const map: Record<string, unknown> = {}
    const seenHere = new Set<string>()
    for (const b of block) {
      const bm = KEY_RE.exec(b)
      // ONE level.  A deeper map arrives here as an indented line that KEY_RE
      // rejects (it starts with a space), and the whole frontmatter goes raw.
      if (!bm) return null
      // The same rule one level down — measured, `meta: {a: 1, a: 2}` is
      // `is-invalid` in the live app. A `Record` would have silently kept the
      // LAST value here, where the top level silently kept both.
      if (seenHere.has(bm[1] as string)) return null
      seenHere.add(bm[1] as string)
      const bv = bm[2]
      if (bv === undefined || bv.trim() === '') return null
      const t = bv.trim()
      if (/^[[{|>&*!]/.test(t)) return null
      map[bm[1] as string] = parseScalar(t)
    }
    out.push({ key, value: map })
  }
  return out
}

/* ===========================================================================
 * 2.  Types and icons — app.js:33081-33085 and :33112, transcribed.
 * ========================================================================= */

export type PropType =
  | 'text' | 'multitext' | 'number' | 'checkbox' | 'date' | 'datetime'
  | 'tags' | 'aliases' | 'unknown'

/** app.js:33085's `OL` and `FL`, verbatim. */
const DATE_RE = /^\d{4}-[01]\d-[0-3]\d$/
const DATETIME_RE = /^\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d$/

/**
 * app.js:33081 — three keys have a type regardless of their value:
 * `aliases -> aliases`, `tags -> tags`, `cssclasses -> multitext`.
 */
const BY_KEY: Record<string, PropType> = {
  aliases: 'aliases',
  tags: 'tags',
  cssclasses: 'multitext',
}

/** app.js:33085, transcribed.  `vc(e, true)` is "an array of strings". */
export function inferType(key: string, value: unknown): PropType {
  const fixed = BY_KEY[key.toLowerCase()]
  if (fixed !== undefined) return fixed
  /* AN EMPTY PROPERTY IS A TEXT PROPERTY, and this is the one place `inferType`
   * departs from app.js:33085 — which sends `null` to `unknown`, because
   * `typeof null` is `"object"` and it is not an array of strings.
   *
   * Obsidian never reaches that branch for a real empty property: its
   * `metadataTypeManager` remembers a type per key across the whole vault, and
   * `addProperty` creates one as text.  Cairn has no such cache and infers per
   * note (§5.4.5 clause 4), so the literal transcription would render every
   * `key:` with no value as an orange `null` — unreadable, and worse,
   * uneditable, since only a scalar gets an editor.  A property you have just
   * added could then never be filled in.
   * Named as a divergence rather than hidden as a special case. */
  if (value === null) return 'text'
  if (typeof value === 'string') {
    return DATETIME_RE.test(value) ? 'datetime' : DATE_RE.test(value) ? 'date' : 'text'
  }
  if (typeof value === 'number') return 'number'
  if (typeof value === 'boolean') return 'checkbox'
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return 'multitext'
  return 'unknown'
}

/**
 * app.js:33112's `registeredTypeWidgets`, reduced to the one field this file
 * needs.  Kept as a table of OBJECTS rather than flattened to
 * `Record<PropType, IconName>` for two reasons: it is the shape Obsidian's own
 * registry has (`{ name, type, icon, validate, render }`), so a future `render`
 * or `validate` lands without a rewrite; and `icon: 'text'` is the form
 * `chrome-ui.test.mjs`'s inert-glyph guard recognises, so every glyph declared
 * in `icons.ts` for this file can be found by the check that exists rather than
 * by a fourth pattern added to it.
 */
const TYPE_WIDGET: Record<PropType, { readonly icon: IconName }> = {
  text: { icon: 'text' },
  multitext: { icon: 'list' },
  number: { icon: 'binary' },
  checkbox: { icon: 'check-square' },
  date: { icon: 'calendar' },
  datetime: { icon: 'clock' },
  tags: { icon: 'tags' },
  aliases: { icon: 'forward' },
  unknown: { icon: 'file-question' },
}

/* ===========================================================================
 * 3.  The block.
 * ========================================================================= */

/* ---------------------------------------------------------------------------
 * THE FOLD ANIMATION — Obsidian's `kl` / `bl` / `wl` / `yl` / `ml`, ported.
 *
 * Collapsing was a class flip here, and the user's report was exactly right:
 * "Obsidian - smooth. Cairn: just show/hide abruptly."  Obsidian animates the
 * CONTENT WRAPPER's height, and the numbers are its own:
 *
 *     duration  100ms                     (app.js, `bl`/`wl`)
 *     easing    cubic-bezier(.02, .01, .47, 1)
 *     props     height, paddingTop, paddingBottom, marginTop, marginBottom
 *               — `hl` (app.js:12160), and only those whose computed value is a
 *                 NON-ZERO px length (`ml`, :12173), so a wrapper with no
 *                 padding animates height alone
 *     overflow  `overflow-y: clip` for the duration, restored after
 *     order     collapse → animate to 0, THEN `display: none`
 *               expand   → `display: ''` FIRST, then animate from 0
 *
 * `yl` (:12189) starts the transition on a `setTimeout(0)` after touching
 * `document.body.offsetHeight`.  That is not a flourish: without a forced
 * reflow between the from-state and the to-state the browser coalesces them and
 * nothing animates at all.
 *
 * ── ONE PLACE CAIRN DOES NOT COPY OBSIDIAN, AND WHY ────────────────────────
 * `app.css:11188` is `.metadata-container.is-collapsed .metadata-property {
 * display: none }`, and `setCollapse` (app.js:36069) adds that class BEFORE
 * calling `kl`.  Taken together those two would make the rows vanish on the
 * frame the fold starts, leaving `kl` to animate only the leftover height — the
 * abrupt behaviour the user reported, not the smooth one they see.  The two
 * halves of Obsidian disagree and I cannot run Obsidian to see which wins, so
 * the rule is NOT copied: the wrapper's own `display: none` at the end of the
 * collapse already removes the rows, which is what `kl` is for.  Recorded as a
 * deliberate divergence rather than an oversight.
 * ------------------------------------------------------------------------- */

const FOLD_MS = 100
const FOLD_EASE = 'cubic-bezier(.02, .01, .47, 1)'
/** app.js:12160's `hl`, in the order it declares them. */
const FOLD_PROPS: readonly [keyof CSSStyleDeclaration & string, string][] = [
  ['height', 'height'],
  ['paddingTop', 'padding-top'],
  ['paddingBottom', 'padding-bottom'],
  ['marginTop', 'margin-top'],
  ['marginBottom', 'margin-bottom'],
]

/** One in-flight fold per element, so a double click cannot leave inline styles. */
const folding = new WeakMap<HTMLElement, () => void>()

/** app.js:12173's `ml` — the non-zero px lengths, and nothing else. */
function foldSizes(el: HTMLElement): [string, number][] {
  const cs = getComputedStyle(el)
  const out: [string, number][] = []
  for (const [js, css] of FOLD_PROPS) {
    const v = cs[js as 'height']
    if (typeof v === 'string' && v.endsWith('px')) {
      const n = parseFloat(v)
      if (n !== 0) out.push([css, n])
    }
  }
  return out
}

/**
 * `collapse ? wl-then-hide : show-then-bl`, which is `kl`.
 *
 * `onFrame` is Cairn's, not Obsidian's, and it is needed because of where this
 * block lives: Obsidian's Properties panel is a DOM sibling of `.cm-content`
 * inside `.cm-sizer`, so its height change is ordinary layout.  Cairn's is a
 * CM6 block widget INSIDE `.cm-content`, and CM6's `ResizeObserver` watches
 * `scrollDOM` only (`@codemirror/view/dist/index.js:7171`) — it never sees a
 * widget resize.  Without a measure per frame the height map goes stale and the
 * scrollbar lies until the next transaction.
 */
function slideFold(el: HTMLElement, collapse: boolean, onFrame: () => void): void {
  folding.get(el)?.()
  if (!collapse) el.style.removeProperty('display')
  const sizes = foldSizes(el)
  const set = (open: boolean): void => {
    for (const [css, n] of sizes) el.style.setProperty(css, (open ? n : 0) + 'px')
  }

  let done = false
  let timer = 0
  let raf = 0
  const onEnd = (e: TransitionEvent): void => { if (e.target === el) finish() }
  function finish(): void {
    if (done) return
    done = true
    folding.delete(el)
    el.removeEventListener('transitionend', onEnd)
    clearTimeout(timer)
    cancelAnimationFrame(raf)
    el.style.removeProperty('transition')
    el.style.removeProperty('transition-property')
    el.style.removeProperty('overflow-y')
    for (const [css] of sizes) el.style.removeProperty(css)
    if (collapse) el.style.display = 'none'
    onFrame()
  }
  folding.set(el, finish)

  el.style.overflowY = 'clip'
  set(collapse)                      // the FROM state
  void el.offsetHeight               // `yl`'s forced reflow — see the header
  setTimeout(() => {
    if (done) return
    /* `important`, AND IT IS NOT DEFENSIVE.  `base.css:51` is
     *     *, *::before, *::after { transition: none !important }
     * — CONTRACT §5.1 rule 5's blanket kill — and a stylesheet `!important`
     * outranks a normal inline style, so `el.style.transition = …` is silently
     * discarded and the fold snaps.  That is exactly what the user reported and
     * it took a mid-flight sample to see: the inline style READ BACK correctly
     * while `getComputedStyle` said `transition-duration: 0s`.
     * An INLINE `!important` is the one declaration that outranks a stylesheet
     * `!important`, and it keeps the transition scoped to the fold — present
     * for 100ms, removed by `finish()` — which is what Obsidian does too.
     * `base.css` records this exemption at the rule itself. */
    el.style.setProperty('transition', 'all ' + FOLD_MS + 'ms ' + FOLD_EASE, 'important')
    el.style.setProperty('transition-property', sizes.map(([css]) => css).join(', '), 'important')
    set(!collapse)                   // the TO state
    el.addEventListener('transitionend', onEnd)
    timer = window.setTimeout(finish, FOLD_MS + 50)
    const tick = (): void => { if (!done) { onFrame(); raf = requestAnimationFrame(tick) } }
    raf = requestAnimationFrame(tick)
  }, 0)
}

/** What the widget is built from, and what its `eq` compares. */
interface Model {
  /** The end of the closing `---` line, or -1 when there is no frontmatter. */
  readonly end: number
  /** `null` when the body is outside §1's subset: then nothing is hidden. */
  readonly entries: readonly Entry[] | null
  /** The raw body, so `eq` can be exact without walking the entries. */
  readonly body: string
}

const NO_MODEL: Model = { end: -1, entries: null, body: '' }

export function modelOf(doc: Text): Model {
  const end = frontmatterEnd(doc)
  if (end < 0) return NO_MODEL
  // `3` and `end - 3` are Obsidian's own slice: past the opening `---` and its
  // newline is 4, but it slices from 3 so the body starts with that newline,
  // and stops 3 short of the closing line's end.  Same text either way.
  const body = doc.sliceString(4, Math.max(4, end - 4))
  return { end, entries: parseFrontmatter(body), body }
}

/* ===========================================================================
 * 4.  EDITING — SURGICAL LINE WRITES, NEVER A RE-SERIALISATION.
 *
 * OBSIDIAN RE-SERIALISES AND THIS DOES NOT, AND THE DIFFERENCE IS THE WHOLE
 * SAFETY ARGUMENT.  `addProperty` ends in `saveFrontmatter(this.serialize())`:
 * the entire block is rebuilt from a JavaScript object every time one field
 * changes.  That is safe for Obsidian because its parser is a complete YAML
 * implementation and round-trips whatever it read.  §1's parser is NOT
 * complete — it refuses ten constructs on purpose — and rebuilding a block from
 * it would silently drop a comment, a quoting style, or an ordering it never
 * modelled.  The user's note is the artefact; a renderer may not paraphrase it.
 *
 * So every write below touches ONE LINE, and usually less:
 *   · rename  — replaces the KEY TEXT only, so a block sequence on the
 *               following lines is untouched and cannot be orphaned
 *   · set     — replaces what follows the colon on that one line
 *   · add     — inserts one line before the closing `---`
 * Nothing else in the block is read or rewritten, ever.  And a block that did
 * not parse offers no editor at all, because §3 renders it raw.
 * ========================================================================= */

/**
 * Would this scalar survive being written bare?  Conservative: anything that
 * could start a collection, open a comment, or be read as a key gets quoted.
 */
function needsQuote(raw: string): boolean {
  if (raw === '') return false                        // `key:` — a null value
  if (raw !== raw.trim()) return true                 // leading/trailing space
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(raw)) return true
  if (/:(\s|$)/.test(raw)) return true                // `a: b` would be a map
  if (/\s#/.test(raw)) return true                    // ` #` opens a comment
  return raw.indexOf('\n') >= 0
}

/** A scalar as YAML.  Bare where that is unambiguous, JSON-quoted where not. */
export function toYaml(raw: string): string {
  return needsQuote(raw) ? JSON.stringify(raw) : raw
}

/** The line declaring `key` at indent 0, and where its colon is. */
interface KeyLine { readonly from: number; readonly to: number; readonly keyEnd: number; readonly colon: number }

function keyLine(doc: Text, end: number, key: string): KeyLine | null {
  const closing = doc.lineAt(end)
  // Lines 2 .. closing-1 are the body.  A NESTED line starts with a space, and
  // `KEY_RE` is anchored on a non-space, so this never matches one — which is
  // what makes "the line that declares this key" unambiguous.
  for (let n = 2; n < closing.number; n++) {
    const line = doc.line(n)
    const text = doc.sliceString(line.from, line.to)
    const m = KEY_RE.exec(text)
    if (!m || (m[1] as string) !== key) continue
    const keyEnd = (m[1] as string).length
    return {
      from: line.from,
      to: line.to,
      keyEnd: line.from + keyEnd,
      colon: line.from + text.indexOf(':', keyEnd),
    }
  }
  return null
}

/** Rename in place: the KEY TEXT only, so any block value below survives. */
function renameProperty(view: EditorView, was: string, key: string): boolean {
  const doc = view.state.doc
  const end = frontmatterEnd(doc)
  if (end < 0 || key === '' || key === was) return false
  if (keyLine(doc, end, key)) return false            // a duplicate key is not a rename
  const line = keyLine(doc, end, was)
  if (!line) return false
  view.dispatch({
    changes: { from: line.from, to: line.keyEnd, insert: key },
    userEvent: 'input.property',
  })
  return true
}

/** Split a line tail (`text after the colon`) into its value and its trailing
 *  ` # comment`, the latter only when the `#` opens one outside single and
 *  double quotes.  A `#` inside `"…"` or `'…'` is value, not comment. */
function splitValueComment(tail: string): { value: string; comment: string } {
  let quote: string | null = null
  for (let i = 0; i < tail.length; i++) {
    const c = tail[i]
    if (quote !== null) {
      if (c === quote) {
        // `''` inside single quotes is an escaped quote, not the end.
        if (quote === "'" && tail[i + 1] === "'") { i++; continue }
        quote = null
      } else if (quote === '"' && c === '\\') {
        i++ // skip the escaped character
      }
      continue
    }
    if (c === '"' || c === "'") { quote = c; continue }
    if (c === '#' && i > 0 && (tail[i - 1] === ' ' || tail[i - 1] === '\t')) {
      return { value: tail.slice(0, i), comment: tail.slice(i) }
    }
  }
  return { value: tail, comment: '' }
}

/** Replace the VALUE on this key's own line, preserving a trailing ` # comment`.
 *  `key: value # why` stays commented; only the value span is rewritten. */
function setProperty(view: EditorView, key: string, yaml: string): boolean {
  const doc = view.state.doc
  const end = frontmatterEnd(doc)
  if (end < 0) return false
  const line = keyLine(doc, end, key)
  if (!line || line.colon < line.from) return false
  const tail = doc.sliceString(line.colon + 1, line.to)
  const { comment } = splitValueComment(tail)
  const insert = (yaml === '' ? '' : ' ' + yaml) + (comment === '' ? '' : ' ' + comment.replace(/^[ \t]+/, ''))
  if (tail === insert) return false
  view.dispatch({
    changes: { from: line.colon + 1, to: line.to, insert },
    userEvent: 'input.property',
  })
  return true
}

/** app.js `addProperty`: a new key with a null value, and its own guard on duplicates. */
function addProperty(view: EditorView, key: string): boolean {
  const doc = view.state.doc
  const end = frontmatterEnd(doc)
  if (end < 0 || key === '' || keyLine(doc, end, key)) return false
  const closing = doc.lineAt(end)
  view.dispatch({
    changes: { from: closing.from, insert: key + ':\n' },
    userEvent: 'input.property',
  })
  return true
}

/**
 * Is this value one a single line can hold?  An array or an object arrived
 * either as a block on the following lines or as a flow collection, and
 * `setProperty` would orphan the first and mangle the second — so neither is
 * editable here.  Named as a gap rather than half-built.
 */
function isScalar(value: unknown): boolean {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

/** `um()`'s own 750 ms (app.js:20449). */
const FLASH_MS = 750

/**
 * The already-rendered row that `next` would collide with, or null.
 *
 * `data-property-key` is written LOWERCASED by `row()`, which is Obsidian's own
 * construction (`containerEl.setAttr("data-property-key", e.toLowerCase())`) —
 * so the attribute IS the case-insensitive index its `rendered.find` walks, and
 * no second list has to be kept in step with the DOM.  `mine` is excluded for
 * the same reason Obsidian excludes `focusedLine`: a row does not clash with
 * itself.
 */
function clashingRow(mine: HTMLElement, next: string): HTMLElement | null {
  const host = mine.parentElement
  if (!host) return null
  const want = next.toLowerCase()
  for (const el of Array.from(host.children)) {
    if (el === mine || !(el instanceof HTMLElement)) continue
    if (el.getAttribute('data-property-key') === want) return el
  }
  return null
}

/**
 * `um()` (app.js:20449): `is-flashing` for 750 ms, and `app.css:3228` carries
 * the appearance — `--text-highlight-bg !important`, `--text-normal`,
 * `mix-blend-mode: var(--highlight-mix-blend-mode)` and `--radius-s`.
 *
 * ITS `transition` IS NOT AN EXEMPTION TO §5.1 RULE 5, and that is measured
 * rather than argued: the declaration sits ON `.is-flashing`, so neither adding
 * the class (the before-change style has no transition) nor removing it (the
 * after-change style has none) starts one — in Obsidian either.  The flash is a
 * step in both apps, so `base.css`'s blanket ban changes nothing here and the
 * exemption list in KNOWN-ISSUES X-1 does not grow.  The engine test asserts
 * the rendered background, which is the only thing that can settle it.
 */
function flashRow(row: HTMLElement): void {
  row.classList.add('is-flashing')
  window.setTimeout(() => { row.classList.remove('is-flashing') }, FLASH_MS)
}

/* ===========================================================================
 * 5.  The widget.
 * ========================================================================= */

class PropertiesWidget extends WidgetType {
  constructor(readonly entries: readonly Entry[], readonly body: string) { super() }

  /* CM6 reuses a widget's DOM when `eq` is true, and this one is asked on every
   * document change.  Comparing the raw body is exact and O(length); comparing
   * the parsed entries would be a deep walk for the same answer.
   * IT IS ALSO WHY EVERY EDITOR BELOW COMMITS ON ENTER OR BLUR AND NEVER ON
   * INPUT: a commit changes the body, which fails this test, which destroys the
   * DOM the user is typing into. */
  eq(other: PropertiesWidget): boolean { return other.body === this.body }

  /**
   * THE RETURNED ELEMENT IS A WRAPPER AROUND `.metadata-container`, for the
   * reason `livepreview.ts`'s `TitleWidget.toDOM` states in full: CM6 measures
   * this block as `toDOM()`'s BORDER BOX, and `.metadata-container` carries
   * Obsidian's own `margin-block-end: 2rem` (app.css:11172), which a border box
   * excludes.  Obsidian never pays for that because its panel is a sibling of
   * `.cm-contentContainer` inside `.cm-sizer` and CM6 does not measure it at
   * all (see §2 of this file's header); Cairn's is a block widget INSIDE
   * `.cm-content`, so the 2rem went missing from the height map and every click
   * below the panel landed ~2 lines low.  `.nc-block` is `display: flow-root`
   * (editor.css §1b), which contains the margin.  Nothing else moves: the
   * container keeps its own class, its transform and its transcribed rule.
   */
  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('div')
    box.className = 'nc-block'
    const root = document.createElement('div')
    root.className = 'metadata-container'
    root.setAttribute('data-property-count', String(this.entries.length))

    const heading = document.createElement('div')
    heading.className = 'metadata-properties-heading'
    const fold = document.createElement('div')
    fold.className = 'collapse-indicator collapse-icon'
    fold.dataset['icon'] = 'right-triangle'
    const title = document.createElement('div')
    title.className = 'metadata-properties-title'
    title.textContent = 'Properties'
    heading.appendChild(fold)
    heading.appendChild(title)
    // Obsidian's own split (app.js:35972): `mousedown` ONLY prevents the
    // default — so the caret is never placed into the editor behind the block —
    // and `click` is what toggles.  Folding on mousedown would fire on a press
    // the user then drags away from and releases elsewhere.
    heading.addEventListener('mousedown', (e) => { e.preventDefault() })
    heading.addEventListener('click', (e) => {
      e.preventDefault()
      /* The fold survives a rebuild because it is dispatched into
       * `collapsedField` (§5b, KNOWN-ISSUES PR-2), not because the DOM keeps
       * it. The DOM is still what is READ here: it is the live truth of what
       * the user is looking at, and a double click mid-animation must toggle
       * what is on screen. */
      // ALL THREE, which is `setCollapse`'s own list (app.js:36069:
      // `containerEl.toggleClass(...)`, `headingEl.toggleClass(...)`,
      // `foldEl.toggleClass(...)`).  Each drives a different rule and none is
      // redundant: the CONTAINER's `is-collapsed` turns the arrow accent-
      // coloured (app.css:7285) and keeps it visible (:7253), while the FOLD
      // ELEMENT's is what rotates the glyph (:7277).
      const on = !root.classList.contains('is-collapsed')
      root.classList.toggle('is-collapsed', on)
      heading.classList.toggle('is-collapsed', on)
      fold.classList.toggle('is-collapsed', on)
      slideFold(content, on, () => view.requestMeasure())
      view.dispatch({ effects: setCollapsedEffect.of(on) })
    })
    root.appendChild(heading)

    // app.js:35981 — the rows live in `.metadata-content`, and that wrapper is
    // what `kl` animates.  Without it there is nothing whose height can move.
    const content = document.createElement('div')
    content.className = 'metadata-content'
    const list = document.createElement('div')
    list.className = 'metadata-properties'
    for (const entry of this.entries) list.appendChild(this.row(entry, view, false))
    content.appendChild(list)

    /* app.js:35982's `.metadata-add-button.text-icon-button`.  It was ABSENT
     * while the block was read-only — §9 E4 forbids drawing a control that does
     * nothing — and it is here now because it does something.
     *
     * `addProperty("")` (app.js) writes NOTHING: it renders a row with an empty
     * key, focuses it, and the file changes only once that key has a name.  A
     * click that the user then abandons must leave the note byte-identical, and
     * this is how Obsidian gets that, so it is how this does. */
    const add = document.createElement('div')
    add.className = 'metadata-add-button text-icon-button'
    add.tabIndex = 0
    const addIcon = document.createElement('span')
    addIcon.className = 'text-button-icon'
    addIcon.dataset['icon'] = 'plus'
    const addLabel = document.createElement('span')
    addLabel.className = 'text-button-label'
    addLabel.textContent = 'Add property'
    add.appendChild(addIcon)
    add.appendChild(addLabel)
    add.addEventListener('mousedown', (e) => { e.preventDefault() })
    add.addEventListener('click', () => {
      const row = this.row({ key: '', value: null }, view, true)
      list.appendChild(row)
      paintIcons(row)
      const input = row.querySelector('input')
      if (input instanceof HTMLInputElement) input.focus()
      view.requestMeasure()
    })
    content.appendChild(add)

    root.appendChild(content)

    /* THE REMEMBERED FOLD, APPLIED WITHOUT ANIMATING.  This is a fresh render,
     * not a fold: there is nothing to slide from. Obsidian draws the same
     * distinction with `setCollapse(collapsed, animate)` passing `animate`
     * straight through to `Jf` (app.js:36069), and `display: none` is exactly
     * the end state `slideFold`'s own `finish()` leaves behind on a collapse,
     * so the two paths agree on what "closed" is. */
    if (view.state.field(collapsedField, false) === true) {
      for (const el of [root, heading, fold]) el.classList.add('is-collapsed')
      content.style.display = 'none'
    }

    // ONE pass, at the end, through the app's ONLY innerHTML site (spec-01
    // §8.3).  Every host above declares `data-icon` and paints nothing itself,
    // so this file never touches innerHTML and the glyph strings stay in
    // `icons.ts` where the inert-glyph guard can see them.
    paintIcons(root)
    box.appendChild(root)
    return box
  }

  private row(entry: Entry, view: EditorView, isNew: boolean): HTMLElement {
    const type = inferType(entry.key, entry.value)
    const row = document.createElement('div')
    row.className = 'metadata-property'
    row.setAttribute('data-property-key', entry.key.toLowerCase())

    const keyEl = document.createElement('div')
    keyEl.className = 'metadata-property-key'
    const iconEl = document.createElement('span')
    iconEl.className = 'metadata-property-icon'
    iconEl.dataset['icon'] = TYPE_WIDGET[type].icon
    keyEl.appendChild(iconEl)
    // `iconEl` is handed over rather than looked up: `keyEl` is not inside `row`
    // yet at this point, so a `row.querySelector` here finds nothing and every
    // `aria-disabled` write goes silently nowhere.
    keyEl.appendChild(this.keyInput(entry, view, isNew, row, iconEl))

    const valueEl = document.createElement('div')
    valueEl.className = 'metadata-property-value'
    valueEl.appendChild(this.value(entry, type, view))

    row.appendChild(keyEl)
    row.appendChild(valueEl)
    return row
  }

  /** app.js:36233's `<input class="metadata-property-key-input">`, for real. */
  private keyInput(
    entry: Entry, view: EditorView, isNew: boolean, row: HTMLElement, iconEl: HTMLElement,
  ): HTMLInputElement {
    const el = document.createElement('input')
    el.type = 'text'
    el.className = 'metadata-property-key-input'
    el.value = entry.key
    el.spellcheck = false
    el.setAttribute('autocapitalize', 'none')

    /* Obsidian greys the TYPE ICON while the key has no name — `attr:
     * {"aria-disabled": !this.entry.key}` on the icon span at creation, updated
     * from the `input` event, and cleared by `handleUpdateKey` on a successful
     * write.  `app.css:12432` is `color: var(--text-muted); opacity: 0.4`, and
     * Cairn's icon is already `--text-muted` (§0.24.6 E54), so what the
     * attribute actually buys here is the 0.4.  FOUND WHILE FIXING PR-1, in the
     * same constructor: click `+ Add property` in Obsidian and the glyph is
     * dim until you name the row; Cairn drew it at full strength. */
    const setIconDisabled = (off: boolean): void => {
      iconEl.setAttribute('aria-disabled', String(off))
    }
    setIconDisabled(entry.key === '')

    /**
     * `app.js`'s `handleUpdateKey`, transcribed: it answers whether the
     * DOCUMENT now holds `next`, and every caller below acts on that answer.
     *
     * THAT ANSWER IS THE WHOLE OF `KNOWN-ISSUES.md` PR-1.  `addProperty` and
     * `renameProperty` have always refused a duplicate — correctly, a duplicate
     * key is not a rename — and nothing read the refusal.  Because no document
     * change followed, `eq` held, the widget was never rebuilt, and the
     * `<input>` went on showing a name the file did not have with nothing on
     * screen saying so.
     *
     * THE DUPLICATE CHECK IS CASE-INSENSITIVE AND `keyLine` IS NOT, and the
     * asymmetry is Obsidian's own: its guard is
     * `rendered.find(l => l.entry.key.toLowerCase() === e.toLowerCase())`,
     * while the line a write lands on must be found EXACTLY or a file holding
     * both `Foo` and `foo` would have the wrong one rewritten.  A guard and an
     * address are different questions.
     */
    const handleUpdateKey = (next: string): boolean => {
      if (next === entry.key) return true          // nothing to write, nothing refused
      if (next === '') return false
      const clash = clashingRow(row, next)
      if (clash) {
        /* `um()` — add `is-flashing` for 750 ms, `app.css:3228`.  Obsidian also
         * hangs a `.tooltip` reading "Property already exists" off the input
         * (`Xg(this.keyInputEl, …, {classes:["mod-error"]})`); Cairn has no
         * tooltip host at all — its hints are native `title` attributes — and
         * inventing that subsystem for one message is out of proportion to the
         * defect.  The flash points AT the conflicting row, which is the
         * informative half.  Recorded as a divergence in KNOWN-ISSUES PR-1. */
        flashRow(clash)
        return false
      }
      const wrote = isNew ? addProperty(view, next) : renameProperty(view, entry.key, next)
      if (wrote) setIconDisabled(false)
      return wrote
    }

    let settled = false
    el.addEventListener('input', () => { setIconDisabled((entry.key || el.value.trim()) === '') })
    el.addEventListener('keydown', (e) => {
      // F79: the Return or Escape that ends an IME composition belongs to the IME.
      if (e.isComposing || e.keyCode === 229) return
      if (e.key === 'Enter') {
        e.preventDefault()
        if (settled) return
        /* On a REFUSAL Obsidian does not put the text back here: the row is
         * still being edited and the flash has already said why, so the user
         * can correct what they typed.  The revert belongs on `blur`, which is
         * the moment the panel would otherwise be left disagreeing with the
         * file. */
        if (handleUpdateKey(el.value.trim())) settled = true
      } else if (e.key === 'Escape') {
        e.preventDefault()
        settled = true
        if (isNew) { row.remove(); view.requestMeasure() } else el.value = entry.key
        el.blur()
      }
    })
    el.addEventListener('blur', () => {
      if (settled) return
      const next = el.value.trim()
      if (next === '' && entry.key === '') {
        // `removeProperties([this], false)` — Obsidian discards a nameless NEW
        // property and writes nothing.  Deleting a NAMED one is a separate
        // gesture it puts on a context menu, and this file does not have it yet
        // (PR-3).
        settled = true
        row.remove()
        view.requestMeasure()
        return
      }
      // `i.handleUpdateKey(n) || (t.value = i.entry.key)`.  A refused write puts
      // the control back to what the file says, so the two can never be left
      // disagreeing once the row loses focus.  `settled` stays false on a
      // refusal so the row can be edited again.
      if (handleUpdateKey(next)) settled = true
      else { el.value = entry.key; setIconDisabled(entry.key === '') }
    })
    return el
  }

  /** The value cell.  Editable for a scalar, and read-only for anything else. */
  private value(entry: Entry, type: PropType, view: EditorView): HTMLElement {
    const value = entry.value

    if (!isScalar(value)) {
      if (Array.isArray(value)) {
        // A list renders as `.multi-select-container` of borderless, unpadded
        // pills — app.css:11457 zeroes `--pill-border-width` and both paddings
        // inside a property value, so what a reader sees is items separated by
        // one `--size-2-3` gap and nothing else.  READ-ONLY: see `isScalar`.
        const box = document.createElement('div')
        box.className = 'multi-select-container'
        for (const item of value) {
          const pill = document.createElement('div')
          pill.className = 'multi-select-pill'
          const inner = document.createElement('div')
          inner.className = 'multi-select-pill-content'
          inner.textContent = String(item)
          pill.appendChild(inner)
          box.appendChild(pill)
        }
        return box
      }
      // app.js:36848 — `createSpan({cls:"metadata-property-value-item
      // mod-unknown", text: JSON.stringify(n10)})`, in `--text-warning`.
      const el = document.createElement('span')
      el.className = 'metadata-property-value-item mod-unknown'
      el.textContent = JSON.stringify(value)
      return el
    }

    if (type === 'checkbox') {
      const box = document.createElement('input')
      box.type = 'checkbox'
      box.className = 'metadata-input-checkbox'
      box.checked = value === true
      box.addEventListener('mousedown', (e) => { e.stopPropagation() })
      box.addEventListener('change', () => {
        if (entry.key !== '') setProperty(view, entry.key, box.checked ? 'true' : 'false')
      })
      return box
    }

    // app.js:36393's `.metadata-input-longtext`, `contentEditable` — a DIV and
    // not an `<input>` because it wraps, which is what `-webkit-line-clamp: 3`
    // on it is for.  `plaintext-only` so a paste cannot bring markup into a
    // YAML scalar.
    const el = document.createElement('div')
    el.className = 'metadata-input-longtext'
    el.contentEditable = 'plaintext-only'
    el.spellcheck = false
    el.textContent = value === null ? '' : String(value)
    const initial = el.textContent
    let settled = false
    const commit = (): void => {
      if (settled || entry.key === '') return
      // No `trim()`: leading/trailing spaces are significant when quoted
      // (`key: "  padded  "`), and `toYaml` quotes them back.  Trimming here
      // silently normalised such a value on every edit of the row.
      const next = (el.textContent ?? '').replace(/\n+$/, '')
      if (next === initial) return
      settled = true
      setProperty(view, entry.key, toYaml(next))
    }
    el.addEventListener('keydown', (e) => {
      // F79: the Return or Escape that ends an IME composition belongs to the IME.
      if (e.isComposing || e.keyCode === 229) return
      if (e.key === 'Enter') { e.preventDefault(); commit(); el.blur() }
      else if (e.key === 'Escape') { e.preventDefault(); settled = true; el.textContent = initial; el.blur() }
    })
    el.addEventListener('blur', commit)
    return el
  }

  /* The block is not part of the document, so the caret has no business in it
   * and CM6 must not try to put one there.  Its own inputs are unaffected:
   * `ignoreEvent` stops CM6 HANDLING the event, it does not stop the event. */
  ignoreEvent(): boolean { return true }
}

/** The whole run marked invalid, so a broken frontmatter reads as broken. */
const INVALID = Decoration.mark({ class: 'nc-fm-invalid' })

/**
 * `Decoration.replace({ block: true, widget })` — and `block: true` is exactly
 * why this is a `StateField` and not a `ViewPlugin`: CM6 refuses block
 * decorations from a plugin.  It is also why the field cannot be viewport-
 * bounded, which is fine and is not seam rule 5's case: the range is `[0, end]`
 * and `end` is found by reading line 1 and, only when it is `---`, walking
 * forward to the closing line.  A note without frontmatter costs one
 * `doc.line(1)`.
 */
/* ===========================================================================
 * 5b.  THE FOLD STATE, KNOWN-ISSUES PR-2.
 *
 * `PropertiesWidget.eq` compares the frontmatter TEXT, so committing any
 * property edit destroys the widget and builds a new one — and the fold state
 * lived nowhere but the DOM classes the old widget took with it, so the block
 * sprang back open on every edit.
 *
 * A `StateField` IS THE RIGHT HOME AND ITS LIFETIME IS THE POINT.  A note
 * switch is `view.setState(EditorState.create(…))` (M70), which builds a fresh
 * field, so the state resets per note without anything having to notice a note
 * switch; a document edit is a transaction, which a field survives. Module
 * state would have leaked one note's fold onto the next, and widget state is
 * what was already wrong.
 *
 * WHAT THIS DOES NOT DO, and it is PR-2's other half rather than an oversight:
 * Obsidian persists the fold PER FILE — `setCollapse` ends in
 * `this.owner.onMarkdownFold()` (app.js:36069), the same path that saves
 * heading and list folds into the vault's `workspace.json`. Cairn has no
 * per-file fold store, and adding one is a new persisted field in
 * `state.json`, not a defect fix. So the block remembers its fold for as long
 * as the note is open, and forgets it on a switch.
 * ========================================================================= */

const setCollapsedEffect = StateEffect.define<boolean>()

const collapsedField = StateField.define<boolean>({
  create: () => false,
  update(was, tr) {
    for (const e of tr.effects) if (e.is(setCollapsedEffect)) return e.value
    return was
  },
})

export const frontmatterField = StateField.define<DecorationSet>({
  create: (state) => decorate(modelOf(state.doc)),
  update(deco, tr) {
    if (!tr.docChanged) return deco
    return decorate(modelOf(tr.newDoc))
  },
  provide: (f) => EditorView.decorations.from(f),
})

function decorate(m: Model): DecorationSet {
  if (m.end < 0) return Decoration.none
  if (m.entries === null) {
    // Obsidian's rule, and the one that matters most: UNPARSEABLE FRONTMATTER
    // IS NOT HIDDEN.  Marked, and left on screen to be fixed.
    return Decoration.set([INVALID.range(0, m.end)])
  }
  return Decoration.set([
    Decoration.replace({
      block: true,
      widget: new PropertiesWidget(m.entries, m.body),
    }).range(0, m.end),
  ])
}

/**
 * Obsidian's companion `transactionFilter`, reduced to the half a read-only
 * block needs: keep the SELECTION out of the hidden run.  Obsidian's also
 * cancels edits inside it; here there is nothing to edit into — the range is
 * replaced by a widget that ignores its own events — but a selection can still
 * be moved there by ⌘A, by a click above the first visible line, or by
 * `EditorSelection` restored from `state.json`, and a caret inside a block
 * replacement is invisible.
 */
const selectionGuard: Extension = EditorState.transactionFilter.of((tr) => {
  if (!tr.selection) return tr
  const end = frontmatterEnd(tr.newDoc)
  if (end < 0) return tr
  const min = Math.min(end + 1, tr.newDoc.length)
  const sel = tr.newSelection
  if (sel.ranges.every((r) => r.from >= min)) return tr
  return [
    tr,
    {
      selection: {
        anchor: Math.max(sel.main.anchor, min),
        head: Math.max(sel.main.head, min),
      },
      sequential: true,
    },
  ]
})

/** What `editor.ts` adds.  One name, so the extension list stays readable. */
export const properties: Extension = [collapsedField, frontmatterField, selectionGuard]
