/**
 * src/tables.ts
 * Owner: 03.  Ruling: CONTRACT §0.40 E87.
 *
 * ===========================================================================
 * A MARKDOWN TABLE RENDERS AS A TABLE.
 * ===========================================================================
 * Reported from two screenshots of one note: Obsidian drew a grid and Cairn
 * drew pipe soup.  `KNOWN-ISSUES.md` LP-2 listed tables among the constructs
 * that are absent "by decision", on the grounds that each needs *"a second
 * parser or a renderer"*.
 *
 * **Tables needed neither.**  The parser is `livepreview.ts` §3's own inline
 * tokeniser, reached through `inlineConstructs` — a cell is inline markdown and
 * nothing else, so `` `apps/client` `` is inline code here for the same reason
 * and by the same code as it is in a paragraph.  The renderer is `<table>`,
 * which the engine has had all along.  What tables actually needed was a BLOCK
 * WIDGET, and §5.4.5 had already built one of those for the Properties block.
 *
 * ── WHAT THIS IS NOT ───────────────────────────────────────────────────────
 * Obsidian's live-preview table is EDITABLE: each cell is its own nested
 * CodeMirror (`.cm-table-widget .cm-scroller` in its app.css is the giveaway —
 * a scroller inside a table cell).  This one is read-only, and it reveals its
 * source when the selection reaches it, which is §5.4.1's rule for every other
 * construct in this app.  So the table is edited the way it is edited today —
 * as markdown — and it LOOKS like Obsidian's the rest of the time.  Named in
 * `KNOWN-ISSUES.md` LP-9, not hidden.
 *
 * ── WHY A `StateField` ─────────────────────────────────────────────────────
 * `Decoration.replace({ block: true })` may not come from a `ViewPlugin` (CM6
 * refuses it, and refuses a plugin-supplied replacement that spans a line break
 * at all), which is the same reason `properties.ts` is a field.  A field cannot
 * be viewport-bounded, so the index below is INCREMENTAL instead, in the shape
 * `blockIndex` already uses: rescan the changed neighbourhood, map the rest.
 */

import { StateEffect, StateField } from '@codemirror/state'
import type { EditorState, Text, Transaction } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType } from '@codemirror/view'
import type { DecorationSet } from '@codemirror/view'
import { inlineConstructs } from './livepreview'
import type { Construct, ConstructKind, Marker } from './livepreview'

/* ===========================================================================
 * 1.  The model.  Obsidian's own regexes, transcribed from the `hypermd` mode
 *     in `app.js` — `hU`, `dU`, `vU`, `mU`, `gU`, `yU` — and its own opening
 *     rule, which is stricter than GFM's in one way that matters.
 * ========================================================================= */

/** `dU` — a NORMAL row: a leading pipe, a trailing pipe, no empty cells. */
const ROW_NORMAL_RE = /^\|(?:[^|]+\|)+?\s*$/
const PIPE = 124
const WS_RE = /\s/

/** What `.` refuses to match: the line terminators. */
function isLineTerminator(c: number): boolean {
  return c === 10 || c === 13 || c === 0x2028 || c === 0x2029
}

/**
 * F86: `hU` — a SIMPLE row: no leading pipe, no trailing pipe, at least one
 * inside. Exactly Obsidian's `/^\s*[^|].*?\|.*[^|]\s*$/`, in linear time: the
 * regex backtracks quadratically on a long line ending in `|`, and this runs
 * on every line at note open. Its `[^|]` may be whitespace, so the first and
 * last non-pipe characters sit as close to the pipes as the leading/trailing
 * `\s*` allow, and only the `.` spans between them must be free of line
 * terminators.
 */
export function isSimpleRow(s: string): boolean {
  const n = s.length
  let a = 0
  while (a < n && WS_RE.test(s.charAt(a))) a++
  if (a === n) return false
  let b = n - 1
  while (WS_RE.test(s.charAt(b))) b--
  const p = s.charCodeAt(a) !== PIPE ? a : a - 1
  const r = s.charCodeAt(b) !== PIPE ? b : b + 1
  if (p < 0 || r >= n) return false
  let pipe = false
  for (let k = p + 1; k < r; k++) {
    const c = s.charCodeAt(k)
    if (c === PIPE) pipe = true
    else if (isLineTerminator(c)) return false
  }
  return pipe
}
/** `vU`, `mU`, `gU`, `yU` — the four delimiter cells, in Obsidian's own order. */
const AL_RIGHT_RE = /^\s*-+\s*:\s*$/
const AL_LEFT_RE = /^\s*:\s*-+\s*$/
const AL_CENTER_RE = /^\s*:\s*-+\s*:\s*$/
const AL_NONE_RE = /^\s*-+\s*$/

export type Align = 'default' | 'left' | 'center' | 'right'

/** One table: the line range it occupies, its alignments, and its rows. */
export interface Table {
  /** Start of the header line. */
  readonly from: number
  /** End of the last row's line. */
  readonly to: number
  readonly align: readonly Align[]
  /** Row 0 is the header.  The delimiter row is consumed, never carried. */
  readonly rows: readonly (readonly string[])[]
}

/** How far `applyChanges` may walk out of the changed range looking for a
 *  blank line.  Seam rule 5's bound, in the units this construct uses. */
const NEIGHBOURHOOD = 200

function alignOf(cell: string): Align | null {
  // The order is Obsidian's: `-:` then `:-` then `:-:` then `-`.  `gU` last of
  // the three colon forms would never fire, because `mU` (`:\s*-+`) does not
  // anchor its own end — it does, `\s*$`, so the order is free.  Kept anyway.
  if (AL_RIGHT_RE.test(cell)) return 'right'
  if (AL_LEFT_RE.test(cell)) return 'left'
  if (AL_CENTER_RE.test(cell)) return 'center'
  if (AL_NONE_RE.test(cell)) return 'default'
  return null
}

/** A row's cells.  NORMAL loses its outer pipes first; SIMPLE has none. */
function cellsOf(text: string, normal: boolean): string[] {
  const t = normal ? text.replace(/^\s*\|/, '').replace(/\|\s*$/, '') : text
  return t.split('|').map((c) => c.trim())
}

/**
 * Does a table open at `line`?  Returns it, or null.
 *
 * **THE PREVIOUS LINE MUST BE BLANK** — or the line must be the first in the
 * document, or the previous line must be a heading.  That is Obsidian's rule,
 * not GFM's, and it is one line of its mode:
 *
 *     if (!K && o.prevLine && o.prevLine.stream.string.trim() && !o.wasHeading)
 *       J = false
 *
 * GFM will start a table straight after a paragraph line; Obsidian will not,
 * and a note written in Obsidian is written against that.
 */
function tableAt(doc: Text, lineFrom: number): Table | null {
  const head = doc.lineAt(lineFrom)
  if (head.number > 1) {
    const prev = doc.line(head.number - 1)
    if (prev.text.trim() !== '' && !/^#{1,6}[ \t]/.test(prev.text)) return null
  }
  const normal = ROW_NORMAL_RE.test(head.text)
  if (!normal && !isSimpleRow(head.text)) return null
  if (head.number >= doc.lines) return null

  const delim = doc.line(head.number + 1)
  if (normal ? !ROW_NORMAL_RE.test(delim.text) : !isSimpleRow(delim.text)) return null
  const align: Align[] = []
  for (const cell of cellsOf(delim.text, normal)) {
    const a = alignOf(cell)
    if (a === null) return null
    align.push(a)
  }

  const rows: string[][] = [cellsOf(head.text, normal)]
  let last = delim
  for (let n = delim.number + 1; n <= doc.lines; n++) {
    const line = doc.line(n)
    if (normal ? !ROW_NORMAL_RE.test(line.text) : !isSimpleRow(line.text)) break
    rows.push(cellsOf(line.text, normal))
    last = line
  }
  return { from: head.from, to: last.to, align, rows }
}

/** Every table whose header line starts in `[from, to]`. */
function scanRange(doc: Text, from: number, to: number, out: Table[]): void {
  let n = doc.lineAt(from).number
  const end = doc.lineAt(to).number
  while (n <= end) {
    const t = tableAt(doc, doc.line(n).from)
    if (t === null) { n++; continue }
    out.push(t)
    n = doc.lineAt(t.to).number + 1
  }
}

/**
 * The index.  `blockIndex`'s shape, for `blockIndex`'s reason: a field cannot
 * see the viewport, so the cost has to come out of the CHANGE instead.
 *
 * A table cannot cross a blank line — every one of its lines must match the row
 * pattern and a blank line does not — so rescanning the changed lines expanded
 * to the nearest blank line on each side is exact, not approximate.
 */
export class TableIndex {
  constructor(readonly tables: readonly Table[]) {}

  static scanAll(doc: Text): TableIndex {
    const out: Table[] = []
    scanRange(doc, 0, doc.length, out)
    return new TableIndex(out)
  }

  applyChanges(tr: Transaction): TableIndex {
    const oldDoc = tr.startState.doc
    const newDoc = tr.newDoc
    let fromA = Infinity, toA = -Infinity, fromB = Infinity, toB = -Infinity
    tr.changes.iterChanges((fa, ta, fb, tb) => {
      if (fa < fromA) fromA = fa
      if (ta > toA) toA = ta
      if (fb < fromB) fromB = fb
      if (tb > toB) toB = tb
    })
    if (fromA === Infinity) return this

    const oldLo = blankBefore(oldDoc, fromA)
    const oldHi = blankAfter(oldDoc, toA)
    const lo = blankBefore(newDoc, fromB)
    const hi = blankAfter(newDoc, toB)

    const next: Table[] = []
    for (const t of this.tables) if (t.to < oldLo) next.push(t)
    scanRange(newDoc, lo, hi, next)
    for (const t of this.tables) {
      if (t.from > oldHi) {
        const from = tr.changes.mapPos(t.from, -1)
        next.push({ from, to: from + (t.to - t.from), align: t.align, rows: t.rows })
      }
    }
    return new TableIndex(next)
  }
}

/** Walk back to the line after the nearest blank line, bounded. */
function blankBefore(doc: Text, pos: number): number {
  let n = doc.lineAt(pos).number
  const floor = Math.max(1, n - NEIGHBOURHOOD)
  while (n > floor && doc.line(n - 1).text.trim() !== '') n--
  // One line further back: a table's opening rule READS the previous line.
  return doc.line(Math.max(1, n - 1)).from
}

/** …and forward to the nearest blank line, bounded. */
function blankAfter(doc: Text, pos: number): number {
  let n = doc.lineAt(pos).number
  const ceil = Math.min(doc.lines, n + NEIGHBOURHOOD)
  while (n < ceil && doc.line(n + 1).text.trim() !== '') n++
  return doc.line(n).to
}

/* ===========================================================================
 * 2.  The widget.  A real `<table>`, and cells rendered through §3's own
 *     inline tokeniser rather than a second parser.
 * ========================================================================= */

/** The body class for an inline construct, mirroring §4's `bodyDeco`. */
function bodyClass(kind: ConstructKind): string | null {
  switch (kind) {
    case 'strong': return 'nc-strong'
    case 'emphasis': return 'nc-em'
    case 'strikethrough': return 'nc-strike'
    case 'highlight': return 'nc-hl'
    case 'inlineCode': return 'nc-code'
    case 'link': return 'nc-link'
    case 'autolink': return 'nc-link'
    case 'wikilink': return 'nc-ilink'
    case 'url': return 'nc-url'
    default: return null
  }
}

/** A body that stops at its markers — §4's `stops`, kept in step by hand
 *  because the two run over different shapes and neither can call the other. */
function stopsAtMarkers(kind: ConstructKind): boolean {
  return kind === 'link' || kind === 'wikilink' || kind === 'autolink'
}

/**
 * Render one cell's inline markdown into `host`.
 *
 * THE SEGMENT SWEEP, and it is why this is short: constructs NEST (`**a `b`**`),
 * so the classes at a character are a SET rather than one value.  Per character
 * we collect the covering bodies, then emit one span per run of equal class.
 * Hidden marker runs are dropped exactly as `HIDE_MARK` drops them in the
 * document.  A cell is tens of characters; this is not a hot path.
 */
export function renderCell(text: string, host: HTMLElement): void {
  const n = text.length
  if (n === 0) return
  const cls: (string | null)[] = new Array(n).fill(null)
  const hide: boolean[] = new Array(n).fill(false)

  inlineConstructs(text, (c: Construct) => {
    const marks = c.markers
    for (let i = 0; i < marks.length; i++) {
      const mk = marks[i] as Marker
      for (let p = mk.from; p < mk.to && p < n; p++) hide[p] = true
    }
    const body = bodyClass(c.kind)
    if (body === null) return
    const stops = stopsAtMarkers(c.kind)
    const from = stops && marks.length > 0 ? (marks[0] as Marker).to : c.from
    const to = stops && marks.length > 1 ? (marks[1] as Marker).from : c.to
    for (let p = from; p < to && p < n; p++) {
      cls[p] = cls[p] === null ? body : cls[p] + ' ' + body
    }
  })

  let run = ''
  let runCls: string | null = null
  const flush = (): void => {
    if (run === '') return
    if (runCls === null) host.appendChild(document.createTextNode(run))
    else {
      const el = document.createElement('span')
      el.className = runCls
      el.textContent = run
      host.appendChild(el)
    }
    run = ''
  }
  for (let p = 0; p < n; p++) {
    if (hide[p]) continue
    if (cls[p] !== runCls) { flush(); runCls = cls[p] ?? null }
    run += text.charAt(p)
  }
  flush()
}

class TableWidget extends WidgetType {
  constructor(readonly table: Table) { super() }

  /** No rebuild while the source is unchanged — the field hands a NEW `Table`
   *  on every scan, so identity would rebuild the DOM on every keystroke. */
  override eq(o: WidgetType): boolean {
    if (!(o instanceof TableWidget)) return false
    const a = this.table, b = o.table
    if (a.rows.length !== b.rows.length || a.align.length !== b.align.length) return false
    for (let i = 0; i < a.align.length; i++) if (a.align[i] !== b.align[i]) return false
    for (let r = 0; r < a.rows.length; r++) {
      const ra = a.rows[r] as readonly string[], rb = b.rows[r] as readonly string[]
      if (ra.length !== rb.length) return false
      for (let c = 0; c < ra.length; c++) if (ra[c] !== rb[c]) return false
    }
    return true
  }

  toDOM(): HTMLElement {
    // `.nc-block`, which is §5.4.2's convention for the outer element of EVERY
    // block widget here and is `display: flow-root` — so the table's own
    // `margin-block` is CONTAINED by the box CM6 measures rather than
    // collapsing out of it, which is §0.26 E62 exactly.
    //
    // NOT `.cm-line`, and the first draft had it: a widget's text is not the
    // document's text, and the probe that guards E62 walks `.cm-line` for text
    // nodes to hit-test.  Claiming the class put a `<td>`'s text in that walk,
    // where `caretRangeFromPoint` lands inside the widget and `posAtCoords`
    // lands on its edge, and the guard fired — correctly.  `.cm-line` also
    // carries nothing here: `editor.css` sets its padding to 0.
    const wrap = document.createElement('div')
    wrap.className = 'nc-block nc-table-block'
    const table = document.createElement('table')
    table.className = 'nc-table'

    const head = document.createElement('thead')
    const hr = document.createElement('tr')
    const header = this.table.rows[0] as readonly string[]
    for (let i = 0; i < header.length; i++) {
      const th = document.createElement('th')
      this.align(th, i)
      renderCell(header[i] as string, th)
      hr.appendChild(th)
    }
    head.appendChild(hr)
    table.appendChild(head)

    const body = document.createElement('tbody')
    for (let r = 1; r < this.table.rows.length; r++) {
      const tr = document.createElement('tr')
      const row = this.table.rows[r] as readonly string[]
      // A short row is padded and a long one is kept: GFM truncates to the
      // header's width, Obsidian keeps what you typed, and losing a cell
      // because a row has one too many is the worse failure.
      const width = Math.max(header.length, row.length)
      for (let i = 0; i < width; i++) {
        const td = document.createElement('td')
        this.align(td, i)
        renderCell(row[i] ?? '', td)
        tr.appendChild(td)
      }
      body.appendChild(tr)
    }
    table.appendChild(body)
    wrap.appendChild(table)
    return wrap
  }

  private align(cell: HTMLElement, i: number): void {
    const a = this.table.align[i]
    if (a !== undefined && a !== 'default') cell.style.textAlign = a
  }

  /** CM6 must handle its own events here: a click has to be able to put the
   *  caret into the range, which is what reveals the source. */
  override ignoreEvent(): boolean { return false }
}

/* ===========================================================================
 * 3.  The field.
 * ========================================================================= */

/**
 * §0.23 E48's rule, and a field cannot read it any other way: **an UNFOCUSED
 * editor reveals nothing.**  `buildDecorations` takes it straight off the view
 * (`view.hasFocus ? ranges : []`, which is Obsidian's `v10`); a `StateField`
 * has no view, so the view pushes it in through CM6's own
 * `focusChangeEffect` facet.
 *
 * IT IS NOT A REFINEMENT.  Without it the caret sits at position 0 in a note
 * that was just opened, and a table on the FIRST line of that note shows its
 * markdown the moment it appears — which is what the first draft of this file
 * did, and what the reveal test caught.
 */
export const setTableFocus = StateEffect.define<boolean>()

/** EXPORTED for `totp.ts` (§0.46 E94), which needs exactly this bit for exactly
 *  this reason and must not install a SECOND `focusChangeEffect` to get it.
 *  One source of truth for "is the editor focused"; the reporter below stays
 *  this file's. */
export const editorFocused = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setTableFocus)) return e.value
    return value
  },
})

const focusReporter = EditorView.focusChangeEffect.of((_state, focusing) =>
  setTableFocus.of(focusing)
)

/**
 * F78: `editorFocused` starts false in every new state, and CM6 raises no
 * focus change when `setState` keeps the focus it had (a clean note reloaded
 * from disk, a wikilink followed from inside the note) — so the table under
 * the caret would turn back into a widget and typing would land on the line
 * after it. Plugins are rebuilt on `setState`, so this sees every new state;
 * the dispatch is deferred because none is allowed during `setState`, and a
 * microtask lands before the next paint and the next input event.
 */
const focusSeed = ViewPlugin.define((view) => {
  if (view.hasFocus && !view.state.field(editorFocused, false)) {
    queueMicrotask(() => {
      if (view.hasFocus && view.state.field(editorFocused, false) === false) {
        view.dispatch({ effects: setTableFocus.of(true) })
      }
    })
  }
  return {}
})

export const tableIndex = StateField.define<TableIndex>({
  create: (state) => TableIndex.scanAll(state.doc),
  update: (value, tr) => (tr.docChanged ? value.applyChanges(tr) : value),
})

/**
 * §5.4.1's reveal, at block scale: a table whose range the selection touches
 * shows its markdown, and every other one is a `<table>` — and an UNFOCUSED
 * editor reveals none of them, which is §0.23 E48's rule and is why
 * `editorFocused` exists above.
 */
function decorate(state: EditorState): DecorationSet {
  const tables = state.field(tableIndex).tables
  if (tables.length === 0) return Decoration.none
  const focused = state.field(editorFocused)
  const ranges = []
  for (const t of tables) {
    let touched = false
    if (focused) {
      for (const r of state.selection.ranges) {
        if (r.to >= t.from && r.from <= t.to) { touched = true; break }
      }
    }
    if (touched) continue
    ranges.push(
      Decoration.replace({ block: true, widget: new TableWidget(t) }).range(t.from, t.to)
    )
  }
  return Decoration.set(ranges, true)
}

/** Exported for the tests: a field is the only way to read a block decoration
 *  set without an `EditorView`, and the reveal is the half worth pinning. */
export const tableDecorations = StateField.define<DecorationSet>({
  create: (state) => decorate(state),
  update(deco, tr) {
    const refocused = tr.startState.field(editorFocused) !== tr.state.field(editorFocused)
    if (!tr.docChanged && !tr.selection && !refocused) return deco
    return decorate(tr.state)
  },
  provide: (f) => EditorView.decorations.from(f),
})

/** What `editor.ts` adds.  The index must come first: the decoration field
 *  reads it through `state.field`, and CM6 initialises in declaration order. */
export const tables = [tableIndex, editorFocused, focusReporter, focusSeed, tableDecorations]
