/**
 * src/search.ts
 * Owner: 05.  Spec: CONTRACT.md §4 (the search engine, B4/B20/B5/M47/M48/M29/
 * M40/M64), §4.3 (vault switch ordering + X15, the ONE generation writer),
 * §4.4 (batching, the DOM ceiling, UTF-16 offsets), §4.5 (the search constants
 * and the token-consumption rule), §3.3 errata 2 / ruling Y17 (the cap banners
 * stay visible in BOTH sidebar views), §1.3 command 14/15/16, §1.4 (search
 * never uses the global event bus), §5.12.4 (two scrollers, never three).
 * spec-05 §6.3, §7.3, §8, §9, §10, §11.
 *
 * THREE THINGS THIS MODULE MUST NOT GET WRONG:
 *   - The search panel REPLACES the tree in the sidebar; `.tree-scroller` and
 *     `.search-scroller` are NEVER live at the same time.  That is what keeps
 *     the document at TWO scrollable boxes and holds the compositing multiplier
 *     at 1.00x (§5.12.4, probe row `layers.scrollers`, gate G5d).  Its scroller
 *     block is already written verbatim in tree.css — do not restate it.
 *   - Search NEVER uses the global event bus.  It uses the per-call
 *     `Channel<SearchMsg>` handed to search_start (§1.4).
 *   - The FRONTEND owns the generation number (§4.3, X15).  A vault switch
 *     CANCELS rather than bumping.  Two writers and no reconciliation rule was
 *     the defect this closed.
 *
 * ===========================================================================
 * THE WIRE TYPES AND THE TRANSPORT SEAM
 * ===========================================================================
 * §1.5's types come from `./ipc` (declared in `src/ipc.d.ts`, re-exported by
 * `src/ipc.ts`), which is the app's only module allowed to talk to the shell.
 * `SearchDeps` is the seam to the four things this panel cannot reach on its
 * own, and `main.ts` passes them in at boot.
 *
 * NO `innerHTML`, ANYWHERE (§6.1's review rule).  A note can contain `<script>`,
 * and snippet text is note content.  Every row is built from `createTextNode`
 * and `createElement` (spec-05 §8.4).
 * ===========================================================================
 */

/* THE ONE VALUE IMPORT.  §6.1 puts every `innerHTML` assignment in icons.ts,
 * so a module that wants a glyph asks icons.ts for it rather than writing
 * markup — menu.ts does the same, for the same reason. */
import { chevron, paintIcons } from './icons'
import type { FileGroup, SearchMsg, Snippet, VaultPath } from './ipc'

/* ═══════════════════════════════════════════════════════════════════════════
 * 2.  CONSTANTS — mirrors of CONTRACT §4.5, plus this panel's own two.
 *
 * §8.5 is explicit that the count line's `1000+` / `200+` are rendered FROM the
 * constants so the copy cannot drift from the caps.  These four therefore exist
 * as names, never as literals in a template.
 * ═════════════════════════════════════════════════════════════════════════ */

/** CONTRACT §4.5 — `MAX_FILES`.  Groups, not matches. */
export const MAX_FILES = 200
/** CONTRACT §4.5 — `MAX_TOTAL_MATCHES`. */
export const MAX_TOTAL_MATCHES = 1_000
/** CONTRACT §4.5 — `MIN_CONTENT_QUERY_CHARS`.  Below this the content scan does
 *  not run at all and the panel says so rather than looking broken. */
export const MIN_CONTENT_QUERY_CHARS = 2
/** CONTRACT §4.5 — `RERUN_QUIET_MS`: quiet time after the last
 *  `nc://tree-changed` before the identical query is silently re-run. */
export const RERUN_QUIET_MS = 400
/** CONTRACT §4.5 — `RERUN_MIN_INTERVAL_MS`: a `git checkout` or a sync burst
 *  must not thrash the scan. */
export const RERUN_MIN_INTERVAL_MS = 2_000

/** spec-05 §8.7 — below this the count line stays EMPTY rather than flashing
 *  `Searching…`, so a warm 5 ms search shows no chrome whatsoever. */
export const SEARCHING_HINT_MS = 120
/** spec-05 §8.8 — content groups 1..N render expanded, N+1 and beyond render
 *  collapsed with NO snippet DOM at all.  This is what holds the panel to ~300
 *  elements against §4.4's `search` ceiling of 800; without it, 1,820. */
export const AUTO_EXPAND_GROUPS = 10

/* ═══════════════════════════════════════════════════════════════════════════
 * 3.  THE TRANSPORT SEAM (see the header).
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface SearchDeps {
  /** CONTRACT §1.3 command 14.  `ipc.ts` (owner 02) constructs the per-call
   *  `Channel<SearchMsg>`, subscribes `onMsg` to it and invokes `search_start`.
   *  Search never touches the global `nc://` bus (§1.4). */
  start(query: string, gen: number, onMsg: (msg: SearchMsg) => void): Promise<void>
  /** CONTRACT §1.3 command 16.  The number passed back is one THIS module
   *  issued; Rust never invents, bumps or reorders it (X15). */
  cancel(gen: number): Promise<void>
  /** CONTRACT §1.3 command 15.  Re-greps ONE file at call time; a deleted file
   *  is an empty array, never an error (spec-05 §11.3). */
  expand(query: string, rel: VaultPath): Promise<Snippet[]>
  /** spec-05 §9, owner 03.  Opens the note into the single tab and selects
   *  [col, col+len) on `line` (1-based), CLAMPED — the file may have changed
   *  between the scan and the click. */
  openResult(rel: VaultPath, line: number, col: number, len: number): Promise<void>
  /** spec-05 §8.9 — `Esc` on an empty input returns focus to the editor. */
  focusEditor(): void
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 4.  THE GENERATION COUNTER — CONTRACT §4.3, X15.
 *
 * "The frontend owns the number."  A frontend-side monotonic u64 starting at 1
 * PER PROCESS (not per vault), incremented on every `search_start`, never
 * reused, passed back verbatim to `search_cancel`.  A VAULT SWITCH DOES NOT
 * TOUCH IT — it cancels through Rust's generation-independent
 * `search_cancel_all()`, precisely so it cannot collide with a number this
 * module is about to issue.
 *
 * This is the only writer in the process.  It is module-scoped rather than a
 * field so that a second `SearchPanel` (there is never one, but a test can make
 * one) cannot re-issue a number.
 * ═══════════════════════════════════════════════════════════════════════════ */

let generationCounter = 0

/** The next unused generation.  Monotonic, per process, never reused. */
export function nextGeneration(): number {
  generationCounter += 1
  return generationCounter
}

/** Test-only: the value the counter is currently at (0 before the first query). */
export function currentGeneration(): number {
  return generationCounter
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 5.  QUERY SHAPE — the frontend half of spec-05 §5.1/§5.2.
 *
 * Rust's `parse()` is the whole query language and this module does NOT
 * re-implement it.  These two helpers exist only so the count line and the
 * empty state can be rendered BEFORE `Complete` arrives; both agree with
 * `search.rs` by construction (`/x/` needs len >= 3; smart case is
 * "any uppercase in the needle").
 * ═══════════════════════════════════════════════════════════════════════════ */

/** `/pattern/` with at least one character between the slashes, so `/` and `//`
 *  are literals (spec-05 §13). */
export function isRegexQuery(raw: string): boolean {
  const q = raw.trim()
  return q.length >= 3 && q.startsWith('/') && q.endsWith('/')
}

/** True when smart case ENGAGES, i.e. matching becomes case-sensitive.  Mirrors
 *  `Query::smart_case_engaged` — the needle is the pattern for a regex and the
 *  whole trimmed query for a literal. */
export function smartCaseEngaged(raw: string): boolean {
  const q = raw.trim()
  const needle = isRegexQuery(q) ? q.slice(1, -1) : q
  return needle !== needle.toLowerCase()
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 6.  THE MODEL — everything that is not DOM.
 *
 * Separated deliberately: staleness, ordering, the collapse policy and every
 * line of copy are testable in `node --test` with no DOM at all, which is the
 * only way the UTF-16 and generation rules get regression cover.
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface CompleteInfo {
  order: number[]
  totalMatches: number
  totalFiles: number
  scanned: number
  skipped: number
  truncated: boolean
  smartCase: boolean
  cancelled: boolean
  elapsedMs: number
}

/** What `accept()` did with a message.  `stale` is the X15 staleness drop and is
 *  the ONLY staleness test that exists (§4.3). */
export type Accepted = 'stale' | 'files' | 'batch' | 'complete' | 'error'

export interface StateCopy {
  primary: string
  secondary: string | null
}

export class SearchModel {
  /** The query the current generation was started with. */
  query = ''
  /** The generation of the current query.  0 = none issued yet. */
  gen = 0
  inFlight = false
  startedAt = 0

  /** Filename hits.  Pinned to the top, capped at 20 by Rust, never collapsible. */
  files: FileGroup[] = []
  /** Content groups in ARRIVAL order until `Complete` supplies `order`. */
  groups: FileGroup[] = []
  /** Content groups in rank order.  Non-null only after `Complete` (§6.3). */
  ordered: FileGroup[] | null = null

  complete: CompleteInfo | null = null
  /** A bad regex: TERMINAL for its generation, and no `Complete` follows. */
  error: string | null = null

  /** Collapse state, keyed by `rel` — an EXPLICIT user toggle only.  Discarded
   *  whenever the query changes; survives streaming updates and silent re-runs
   *  within one query (spec-05 §8.8). */
  readonly collapsed = new Map<VaultPath, boolean>()
  /** Snippets fetched by `search_expand`, keyed by `rel`.  Same lifetime. */
  readonly expanded = new Map<VaultPath, Snippet[]>()

  /** `VaultInfo.nNotes`, for §8.6's "This vault has no notes".  Null until
   *  owner 01 hands us a `nc://vault-opened`. */
  vaultNotes: number | null = null

  private byId = new Map<number, FileGroup>()

  /** Start a new query on `gen`.  Everything derived from the previous query is
   *  dropped here, including the collapse map (§8.8). */
  begin(query: string, gen: number, now: number): void {
    this.query = query
    this.gen = gen
    this.inFlight = true
    this.startedAt = now
    this.files = []
    this.groups = []
    this.ordered = null
    this.complete = null
    this.error = null
    this.collapsed.clear()
    this.expanded.clear()
    this.byId.clear()
  }

  /** Clear to the "no query" state.  Used by the empty input, by the §4.3 vault
   *  switch step 4 and by `nc://vault-opened` (spec-05 §11.1/§11.2).
   *
   *  `gen = 0` IS LOAD-BEARING, not tidiness.  `accept()` drops a message whose
   *  gen is not the current one, so leaving the OLD generation here makes a
   *  batch that was already in flight for the PREVIOUS VAULT match on the way
   *  in and repaint itself into the new vault's panel — `search_cancel` is
   *  async and cannot beat a message that has already crossed.  0 means "no
   *  query is live", which is exactly the `this.gen === 0` arm of that guard
   *  (§4.3, X15).  `runQuery('')` overwrites it with the fresh number it just
   *  issued; both values drop the same stale traffic. */
  clear(): void {
    this.query = ''
    this.gen = 0
    this.inFlight = false
    this.startedAt = 0
    this.files = []
    this.groups = []
    this.ordered = null
    this.complete = null
    this.error = null
    this.collapsed.clear()
    this.expanded.clear()
    this.byId.clear()
  }

  /**
   * CONTRACT §4.3: "The frontend discards any `SearchMsg` whose `gen` is not the
   * generation of its current query.  This is the only staleness test that
   * exists."  Defence in depth — the backend already stopped sending — and it is
   * also what makes a cancelled job's `{cancelled:true}` `Complete` a no-op.
   */
  accept(msg: SearchMsg): Accepted {
    if (msg.gen !== this.gen || this.gen === 0) return 'stale'
    switch (msg.kind) {
      case 'files':
        this.files = msg.groups
        return 'files'
      case 'batch':
        for (const g of msg.groups) {
          if (this.byId.has(g.id)) continue
          this.byId.set(g.id, g)
          this.groups.push(g)
        }
        return 'batch'
      case 'complete':
        this.inFlight = false
        this.complete = {
          order: msg.order,
          totalMatches: msg.totalMatches,
          totalFiles: msg.totalFiles,
          scanned: msg.scanned,
          skipped: msg.skipped,
          truncated: msg.truncated,
          smartCase: msg.smartCase,
          cancelled: msg.cancelled,
          elapsedMs: msg.elapsedMs,
        }
        this.ordered = this.applyOrder(msg.order)
        return 'complete'
      case 'error':
        this.inFlight = false
        this.error = msg.message
        return 'error'
    }
  }

  /**
   * spec-05 §6.3.  `Complete` carries the authoritative rank-sorted sequence of
   * CONTENT group ids and the panel applies it with ONE reorder.  Ids not in
   * `order` keep arrival order at the end — defensive, and it means a truncated
   * `order` can never make a group that is on screen vanish.
   *
   * NOTE (X14): these ids are keys into THIS generation's `FileGroup` set and
   * nothing else.  No arithmetic is done on them anywhere.
   */
  private applyOrder(order: number[]): FileGroup[] {
    const out: FileGroup[] = []
    const seen = new Set<number>()
    for (const id of order) {
      const g = this.byId.get(id)
      if (g && !seen.has(id)) { out.push(g); seen.add(id) }
    }
    for (const g of this.groups) if (!seen.has(g.id)) out.push(g)
    return out
  }

  /** The content groups in the order they should be painted. */
  contentGroups(): FileGroup[] {
    return this.ordered ?? this.groups
  }

  /**
   * spec-05 §8.8.  An explicit user toggle always wins; otherwise groups 1..10
   * are expanded and 11+ are collapsed.  `index` is the position in the CURRENT
   * paint order, so the default follows the one DOM reorder rather than freezing
   * at arrival order.
   */
  isCollapsed(rel: VaultPath, index: number): boolean {
    const explicit = this.collapsed.get(rel)
    if (explicit !== undefined) return explicit
    return index >= AUTO_EXPAND_GROUPS
  }

  /** The snippets to paint for a group: whatever `search_expand` fetched, else
   *  the <= 2 that crossed the IPC. */
  snippetsFor(g: FileGroup): Snippet[] {
    return this.expanded.get(g.rel) ?? g.snippets
  }

  /** True when nothing at all has arrived for the current query yet. */
  get isEmptyResult(): boolean {
    return this.files.length === 0 && this.groups.length === 0
  }

  /* ── §8.5 the result-count line ───────────────────────────────────────── */

  /**
   * Exact copy from spec-05 §8.5.  Returns `null` when the line is HIDDEN, which
   * is both "query empty" and "a content search under 120 ms with nothing yet"
   * (§8.7 — no bar, no spinner, no skeleton rows, and no flash).
   *
   * `1000+` / `200+` are rendered from `MAX_TOTAL_MATCHES` / `MAX_FILES`, never
   * written as literals.  One refinement on the spec's example row: the `+` is
   * attached per cap actually reached, so the real `memory` query on the 5,000-
   * note corpus reads `526 matches in 200+ files · stopped` rather than claiming
   * 1000+ matches it did not find.  Both caps hit still renders the spec's exact
   * string.
   *
   * MEASURED, not asserted: `cargo test --release --test search_int
   * gate_g4_ten_megabyte_corpus -- --ignored` over `fixtures/corpus-a`
   * (5,000 notes, 9.9 MB) reports `files=200 matches=526 TRUNCATED` in 4.4 ms
   * median, and the panel renders exactly that string from it.
   */
  countLine(now: number): string | null {
    if (this.query.trim() === '') return null
    if (this.error !== null) return null

    const c = this.complete
    const matches = c ? c.totalMatches : this.groups.reduce((n, g) => n + g.matchCount, 0)
    const nFiles = c ? c.totalFiles : this.groups.length

    if (!c && matches === 0 && this.files.length === 0) {
      return now - this.startedAt > SEARCHING_HINT_MS ? 'Searching…' : null
    }

    const capMatches = matches >= MAX_TOTAL_MATCHES
    const capFiles = nFiles >= MAX_FILES
    const mTxt = capMatches ? `${MAX_TOTAL_MATCHES.toLocaleString()}+` : matches.toLocaleString()
    const fTxt = capFiles ? `${MAX_FILES.toLocaleString()}+` : nFiles.toLocaleString()
    const mWord = !capMatches && matches === 1 ? 'match' : 'matches'
    const fWord = !capFiles && nFiles === 1 ? 'file' : 'files'

    let s = `${mTxt} ${mWord} in ${fTxt} ${fWord}`
    if (isRegexQuery(this.query)) s = `regex · ${s}`
    if (c?.truncated) s += ' · stopped'
    if (this.inFlight) s += ' · searching…'
    if (c ? c.smartCase : smartCaseEngaged(this.query)) s += ' · case-sensitive'
    if (c && c.skipped > 0) s += ` · ${c.skipped.toLocaleString()} skipped`
    return s
  }

  /* ── §8.6 empty and error states ──────────────────────────────────────── */

  /** The `.sr-state` copy, or `null` when there are results to draw instead. */
  stateCopy(): StateCopy | null {
    if (this.error !== null) return null            // rendered in .sr-error
    const q = this.query.trim()
    if (q === '') {
      return {
        primary: 'Search this vault',
        secondary: 'Wrap the query in /slashes/ for a regular expression.',
      }
    }
    if (this.vaultNotes === 0) return { primary: 'This vault has no notes', secondary: null }
    if (!this.isEmptyResult) return null
    if (q.length < MIN_CONTENT_QUERY_CHARS) {
      return { primary: 'Type 2 characters to search note contents', secondary: null }
    }
    const c = this.complete
    if (!c) return null                              // still in flight: draw nothing
    if (c.scanned === 0 && c.skipped === 0 && this.vaultNotes === null) {
      return { primary: 'This vault has no notes', secondary: null }
    }
    return {
      primary: 'No results',
      secondary: `Searched ${c.scanned.toLocaleString()} notes in ${Math.round(c.elapsedMs)} ms`,
    }
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 7.  HIGHLIGHT RENDERING — spec-05 §8.4.
 *
 * NEVER `innerHTML` on snippet text: a note can contain `<script>`, and this is
 * the app's only path from note bytes to the DOM outside CodeMirror.  `ranges`
 * are UTF-16 offsets, which is exactly what `String.prototype.slice` indexes by,
 * so there is no conversion step and there must never be one.
 * ═══════════════════════════════════════════════════════════════════════════ */

export function renderHighlighted(
  doc: Document,
  text: string,
  ranges: readonly (readonly [number, number])[],
): DocumentFragment {
  const frag = doc.createDocumentFragment()
  let cursor = 0
  for (const r of ranges) {
    const a = Math.max(cursor, Math.min(r[0], text.length))
    const b = Math.max(a, Math.min(r[1], text.length))
    if (b <= a) continue
    if (a > cursor) frag.append(doc.createTextNode(text.slice(cursor, a)))
    const hit = doc.createElement('span')
    hit.className = 'sr-hit'
    hit.textContent = text.slice(a, b)
    frag.append(hit)
    cursor = b
  }
  if (cursor < text.length) frag.append(doc.createTextNode(text.slice(cursor)))
  return frag
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 8.  THE PANEL — DOM, events, and the one place a search is started.
 * ═══════════════════════════════════════════════════════════════════════════ */

/** Where the row cursor is.  `kind` decides what Enter opens (spec-05 §9). */
interface CursorRow {
  el: HTMLElement
  rel: VaultPath
  line: number
  col: number
  len: number
}

export class SearchPanel {
  readonly model = new SearchModel()

  private readonly doc: Document
  private readonly deps: SearchDeps
  private readonly now: () => number

  /** The band the tree scroller occupies.  `.search-panel` REPLACES
   *  `.tree-scroller`; the two are never live at the same time (§5.12.4). */
  readonly root: HTMLElement
  private readonly input: HTMLInputElement
  private readonly clearBtn: HTMLElement
  /** §0.6 E8 left `toggle()` as the ONLY way back to the tree, and it is a
   *  keyboard-only one.  This is the mouse's. */
  private readonly backBtn: HTMLElement
  private readonly countEl: HTMLElement
  /** THE panel's one scrollable box, and the document's second (§5.12.4). */
  private readonly list: HTMLElement
  private readonly tree: HTMLElement | null

  private rows: CursorRow[] = []
  private cursor = -1

  /** §8.7's 120 ms hint, and §11.2's re-run pair.  All three are cleared on
   *  every teardown path — a timer that outlives the panel is a re-run against
   *  a vault that is gone. */
  private hintTimer: ReturnType<typeof setTimeout> | null = null
  private rerunTimer: ReturnType<typeof setTimeout> | null = null
  /** `-Infinity` and NOT `0`: 0 is a real point on the `Date.now()` line and
   *  would make the FIRST re-run of the session look rate-limited under any
   *  clock that starts near zero.  "No re-run has happened yet" is not a time. */
  private lastRerunAt = Number.NEGATIVE_INFINITY

  /** `--cx0` and `--chev-w`, read ONCE at mount from the document element and
   *  never restated (§4.5 — the panel consumes the tree's tokens by name).
   *  Cached rather than read per click: the chevron's box is `::before`, so it
   *  has no node to hit-test against, and a `getComputedStyle` inside a click
   *  handler is exactly the kind of main-thread work §5.12.6 made expensive. */
  private readonly chev: { x0: number; w: number }

  constructor(host: HTMLElement, deps: SearchDeps, now: () => number = () => Date.now()) {
    this.doc = host.ownerDocument
    this.deps = deps
    this.now = now
    this.tree = host.querySelector<HTMLElement>('.tree-scroller')

    const rootStyle = this.doc.defaultView?.getComputedStyle(this.doc.documentElement)
    this.chev = {
      x0: parseFloat(rootStyle?.getPropertyValue('--cx0') ?? '') || 0,
      w: parseFloat(rootStyle?.getPropertyValue('--chev-w') ?? '') || 0,
    }

    const d = this.doc
    const panel = d.createElement('div')
    panel.className = 'search-panel'
    panel.hidden = true

    const inputRow = d.createElement('div')
    inputRow.className = 'sr-input-row'
    // THE WAY BACK TO THE FILE TREE, and it is Cairn's own control: Obsidian has
    // no button for this because its left sidebar carries tab headers (Files /
    // Search / Bookmarks) that Cairn does not draw.
    //
    // §0.33 E78 — IT IS A BACK ARROW.  It wore Obsidian's `files` glyph, on the
    // reasoning that its registry maps `"file-explorer-glyph":"files"` so that
    // picture means "the file tree".  The reasoning was right about the NAME and
    // wrong about the PICTURE: `files` is two overlapping documents and every
    // other app on the machine uses that for COPY.  Reported by the user in
    // those words.  `arrow-left` is Obsidian's own `app:go-back` glyph, and the
    // button already said `Back to files` in its label and its tooltip — the
    // icon was the only part that did not.
    //
    // IT IS NOT DECORATION (§9 E4).  Before it, `toggle()` off Mod-Shift-F was
    // the ONLY route back — Escape deliberately does not close this panel
    // (`onKeyDown`) and §0.6 E8 deleted the title-bar search button — so a mouse
    // user who opened search had no way out with the mouse, and §9 records that
    // this user works with a mouse.  The deleted `reveal()` note further down
    // this file is the same fact written from the other side.
    const backBtn = d.createElement('button')
    backBtn.className = 'icon-btn sr-back'
    backBtn.type = 'button'
    backBtn.dataset['icon'] = 'arrow-left'
    backBtn.setAttribute('aria-label', 'Back to files')
    backBtn.title = 'Back to files'
    const input = d.createElement('input')
    input.className = 'sr-input'
    input.type = 'text'
    input.spellcheck = false
    input.autocapitalize = 'off'
    input.setAttribute('autocomplete', 'off')
    input.setAttribute('aria-label', 'Search this vault')
    input.placeholder = 'Search'
    const clearBtn = d.createElement('div')
    clearBtn.className = 'sr-clear'
    clearBtn.setAttribute('role', 'button')
    clearBtn.setAttribute('aria-label', 'Clear search')
    clearBtn.textContent = '×'
    clearBtn.hidden = true
    inputRow.append(backBtn, input, clearBtn)

    const countEl = d.createElement('div')
    countEl.className = 'sr-count'
    countEl.hidden = true
    countEl.setAttribute('role', 'status')

    // `.sr-list` IS the sidebar's `.search-scroller` (spec-05 §8.3).  Its
    // overflow, its stable gutter and its 8px `::-webkit-scrollbar` are
    // CONTRACT §5.2's, declared ONCE in tree.css under the grouped selector
    // `.tree-scroller, .search-scroller` (errata 2).  search.css restates none
    // of it, and this is the class name that reaches it.
    const list = d.createElement('div')
    list.className = 'sr-list search-scroller'
    list.setAttribute('role', 'listbox')
    list.setAttribute('aria-label', 'Search results')

    panel.append(inputRow, countEl, list)

    // §3.3 errata 2 (ruling Y17): BOTH cap banners stay visible in BOTH sidebar
    // views.  They are owner 01's `.cap-banner` siblings and this panel neither
    // draws, hides nor measures one — it takes its height from flex, exactly as
    // the tree does, so a banner appearing shortens both panes identically and
    // toggling views never reflows the sidebar.  Inserting the panel directly
    // AFTER the tree scroller keeps that sibling order intact.
    if (this.tree && this.tree.parentElement === host) {
      host.insertBefore(panel, this.tree.nextSibling)
    } else {
      host.append(panel)
    }

    this.root = panel
    this.input = input
    this.clearBtn = clearBtn
    this.backBtn = backBtn
    this.countEl = countEl
    this.list = list

    // The panel is built AFTER `mountChrome()` has run its one `paintIcons(root)`
    // pass (main.ts: 807 then 888), so the back button's host would sit empty
    // forever if this file did not paint it.  menu.ts does exactly this for the
    // row-menu glyphs and for the same reason; §6.1 is satisfied because the
    // innerHTML assignment still happens inside icons.ts and nowhere else.
    paintIcons(panel)

    this.wire()
  }

  /* ── visibility: the panel REPLACES the tree ──────────────────────────── */

  get isOpen(): boolean {
    return !this.root.hidden
  }

  /**
   * §4.5: the titlebar search button (content centre x = 103) toggles between
   * the two views.  Owner 01 binds the button to this.
   *
   * `.tree-scroller` and `.search-scroller` are NEVER live at the same time.
   * Hiding is `hidden`, i.e. `display: none`, so the hidden pane has no box, no
   * overflow and therefore no compositing surface — which is what keeps
   * `layers.scrollers` at two and gate G5d passing.
   */
  show(): void {
    if (this.tree) this.tree.hidden = true
    this.root.hidden = false
    this.input.focus()
    this.input.select()
    this.paint()
  }

  hide(): void {
    this.root.hidden = true
    if (this.tree) this.tree.hidden = false
    // spec-05 §13: "Panel closed mid-search -> searchCancel on unmount."
    this.stopTimers()
    if (this.model.inFlight && this.model.gen !== 0) void this.deps.cancel(this.model.gen)
    this.model.inFlight = false
  }

  toggle(): void {
    if (this.isOpen) this.hide()
    else this.show()
  }

  /* ── the query lifecycle ──────────────────────────────────────────────── */

  /**
   * CONTRACT §4.3 / spec-05 §10.2.  ONE `search_start` per keystroke and THE
   * FRONTEND HAS NO DEBOUNCE TIMER AT ALL: `FILENAME_DEBOUNCE_MS = 0` and
   * `CONTENT_DEBOUNCE_MS = 90` are constants in Rust, so the coordinator owns
   * both and a superseded query dies inside its own sleep having opened no file.
   *
   * The generation is bumped HERE and nowhere else, which is X15's whole point.
   */
  runQuery(raw: string): void {
    this.stopTimers()
    const gen = nextGeneration()

    if (raw.trim() === '') {
      // Cancel on the number we just issued, exactly as §4.3 requires: Rust
      // records the newest generation it has been given, so cancelling on a
      // fresh one also invalidates everything older.
      void this.deps.cancel(gen)
      this.model.clear()
      this.model.gen = gen
      this.paint()
      return
    }

    this.model.begin(raw, gen, this.now())
    this.paint()

    // §8.7: the count line reads `Searching…` ONLY once a search has been in
    // flight for > 120 ms with nothing to show.  Below that, nothing appears.
    this.hintTimer = setTimeout(() => {
      this.hintTimer = null
      if (this.model.gen === gen && this.model.inFlight) this.paintCount()
    }, SEARCHING_HINT_MS + 1)

    void this.deps.start(raw, gen, (msg) => this.onMessage(msg))
  }

  /**
   * Messages arrive BATCHED — CONTRACT §4.4: flush every 16 ms, <= 8 groups or
   * <= 6,000 serialised bytes.  Spike B measured `Channel::send` at 16.3 µs PER
   * MESSAGE regardless of payload, i.e. 82 ms of main-thread eval for 5,000
   * unbatched hits, which is why per-hit streaming is forbidden.
   *
   * Rendering is INCREMENTAL: `files` paints immediately (it is on the wire
   * within ~1 ms of the keystroke and is what makes the panel feel instant), and
   * each `batch` appends its groups.  Nothing waits for `Complete`; `Complete`
   * only supplies the ONE reorder (§6.3).
   */
  private onMessage(msg: SearchMsg): void {
    const what = this.model.accept(msg)
    if (what === 'stale') return          // X15 — the only staleness test there is
    switch (what) {
      case 'files':
        this.paintFiles()
        this.paintCount()
        break
      case 'batch':
        this.appendGroups()
        this.paintCount()
        break
      case 'complete':
        // ONE DOM reorder, applied with `append`, which MOVES the existing nodes
        // rather than recreating them.  Do NOT insertion-sort the live list: it
        // costs O(n) moves per batch and makes the list squirm while it is being
        // read (spec-05 §6.3).
        this.reorder()
        this.paintCount()
        this.paintState()
        break
      case 'error':
        this.paint()
        break
    }
  }

  /* ── §11.2 silent re-run on nc://tree-changed ─────────────────────────── */

  /** Owner 01/02 forwards `nc://tree-changed { epoch }` here.  The payload is
   *  ignored on purpose: the epoch is the tree's counter and search's generation
   *  is a different number — §10.1, "the two are never compared". */
  onTreeChanged(): void {
    if (!this.isOpen || this.model.query.trim() === '') return
    if (this.rerunTimer !== null) clearTimeout(this.rerunTimer)
    this.rerunTimer = setTimeout(() => {
      this.rerunTimer = null
      const t = this.now()
      if (t - this.lastRerunAt < RERUN_MIN_INTERVAL_MS) return
      this.lastRerunAt = t
      this.rerun()
    }, RERUN_QUIET_MS)
  }

  /** A re-run takes a NEW generation, exactly like a keystroke, so a re-run and
   *  a keystroke can never interleave (spec-05 §11.2).  Scroll position and the
   *  collapse map survive it. */
  private rerun(): void {
    const q = this.model.query
    const scroll = this.list.scrollTop
    const collapsed = new Map(this.model.collapsed)
    this.runQuery(q)
    for (const [rel, v] of collapsed) this.model.collapsed.set(rel, v)
    this.list.scrollTop = scroll
  }

  /**
   * CONTRACT §4.3 step 4 of the vault switch, and spec-05 §11.1: the panel is
   * cleared by the FRONTEND as part of that sequence, not in reaction to an
   * event.  Also the `nc://vault-opened` handler.
   *
   * It cancels; it does NOT bump for the sake of bumping (X15).  Rust's own
   * `search_cancel_all()` is what stops the in-flight job, and it is
   * generation-independent precisely so it cannot collide with the next number
   * this module issues.
   */
  reset(vaultNotes: number | null = null): void {
    this.stopTimers()
    if (this.model.inFlight && this.model.gen !== 0) void this.deps.cancel(this.model.gen)
    this.model.clear()
    this.model.vaultNotes = vaultNotes
    this.input.value = ''
    this.clearBtn.hidden = true
    this.lastRerunAt = Number.NEGATIVE_INFINITY
    this.paint()
  }

  /** `VaultInfo.nNotes`, for §8.6's "This vault has no notes". */
  setVaultNoteCount(n: number | null): void {
    this.model.vaultNotes = n
    this.paintState()
  }

  private stopTimers(): void {
    if (this.hintTimer !== null) { clearTimeout(this.hintTimer); this.hintTimer = null }
    if (this.rerunTimer !== null) { clearTimeout(this.rerunTimer); this.rerunTimer = null }
  }

  /* ── events ───────────────────────────────────────────────────────────── */

  private wire(): void {
    this.input.addEventListener('input', () => {
      this.clearBtn.hidden = this.input.value === ''
      this.runQuery(this.input.value)
    })
    this.clearBtn.addEventListener('click', () => this.clearInput())
    // `hide()`, not `toggle()`: this button has exactly one meaning and it must
    // not become a second toggle that re-opens the panel on a double click.
    //
    // THEN HAND THE FOCUS OVER, and that is not a nicety.  The click puts focus
    // on the button, `hide()` puts the button in a `display: none` subtree, and
    // the browser drops focus to `<body>` — so the user lands on the file tree
    // with the caret nowhere and the arrow keys dead, having just asked to go
    // back to the file tree.  `.tree-scroller` is `tabindex="0" role="tree"`
    // (index.html) precisely so it can hold that focus; tree.ts's own keydown
    // listener is on it and drives the cursor.
    //
    // ONLY HERE, deliberately, and NOT inside `hide()`: `toggle()` off
    // Mod-Shift-F shares that path, and a keyboard user who closes search has
    // not asked for their focus to be moved into the sidebar.
    this.backBtn.addEventListener('click', () => {
      this.hide()
      this.tree?.focus()
    })
    this.input.addEventListener('keydown', (e) => this.onKeyDown(e))

    // ONE delegated listener for the whole list.  Per-row listeners on 200
    // headers plus their snippets is 200+ closures rebuilt on every batch, and
    // the panel repaints while the user is reading.
    this.list.addEventListener('click', (e) => this.onListClick(e))

    // spec-05 §8.8, and CONTRACT §5.12.6's budget: THE SEARCH PANEL HAS NO
    // SCROLL HANDLER AT ALL.  Under `AsyncOverflowScrollingEnabled = NO` the
    // scroll handler is on the critical path of every frame of every fling, so
    // a "load more", a re-run on scroll or a sticky-header recompute would each
    // put work on every one of them.  No scroll listener is registered anywhere
    // in this file, and `tests/frontend/search.test.mjs` asserts that by
    // pattern-matching the comment-stripped source.
  }

  private clearInput(): void {
    this.input.value = ''
    this.clearBtn.hidden = true
    this.runQuery('')
    this.input.focus()
  }

  /** spec-05 §8.9.  No other bindings; there is no command palette. */
  private onKeyDown(e: KeyboardEvent): void {
    // F79: the Return or Escape that ends an IME composition belongs to the IME.
    if (e.isComposing || e.keyCode === 229) return
    switch (e.key) {
      case 'Escape':
        e.preventDefault()
        if (this.input.value !== '') this.clearInput()
        else this.deps.focusEditor()
        return
      case 'ArrowDown':
        e.preventDefault()
        this.moveCursor(1)
        return
      case 'ArrowUp':
        e.preventDefault()
        this.moveCursor(-1)
        return
      case 'ArrowLeft':
        if (this.setCursorCollapsed(true)) e.preventDefault()
        return
      case 'ArrowRight':
        if (this.setCursorCollapsed(false)) e.preventDefault()
        return
      case 'Enter': {
        e.preventDefault()
        const row = this.rows[this.cursor]
        if (!row) return
        const keepFocus = e.metaKey || e.ctrlKey
        void this.open(row, keepFocus)
        return
      }
      default:
    }
  }

  /* `reveal()` STOOD HERE AND IS DELETED (§0.7 E9).  It was spec-05 §8.9's
   * intended `Mod-Shift-F` — show if closed, focus-and-select if already open —
   * and it had no call site anywhere in `src/`: main.ts:817 wires the shortcut
   * to `toggle()` instead.
   *
   * IT CANNOT BE WIRED, and that is why it was dead rather than merely unused.
   * `Escape` does not close this panel (`onKeyDown` below: it clears the input,
   * then focuses the editor), and §4.5 has the panel REPLACE the file tree.  So
   * `toggle()` is the only route back to the tree, and a `reveal()` that never
   * closes would strand the user in the search view with the tree unreachable —
   * doubly so since §0.6 E8 deleted the title-bar search button and made the
   * shortcut the only way in at all.
   *
   * Restoring it needs a close path first, not just a call site. */

  private onListClick(e: Event): void {
    const target = e.target
    if (!(target instanceof Element)) return
    const chevron = target.closest<HTMLElement>('.sr-file--group')
    const snip = target.closest<HTMLElement>('.sr-snip')
    const file = target.closest<HTMLElement>('.sr-file')
    const el = snip ?? file
    if (!el) return
    const idx = this.rows.findIndex((r) => r.el === el)
    if (idx < 0) return
    this.cursor = idx
    this.paintCursor()
    const row = this.rows[idx]
    if (!row) return
    // A click in the chevron's 16px box toggles; anywhere else on a group header
    // opens.  The chevron box is `::before`, so it has no node of its own — its
    // extent is `--cx0`..`--cx0 + --chev-w`, consumed by name, never restated.
    if (chevron && el === chevron && this.inChevron(e, chevron)) {
      const rel = chevron.dataset['rel']
      if (rel !== undefined) void this.toggleGroup(rel)
      return
    }
    void this.open(row, false)
  }

  private inChevron(e: Event, row: HTMLElement): boolean {
    if (this.chev.w <= 0) return false
    if (!(e instanceof MouseEvent)) return false
    const local = e.clientX - row.getBoundingClientRect().left
    return local >= this.chev.x0 && local <= this.chev.x0 + this.chev.w
  }

  /* ── opening a result — spec-05 §9 ────────────────────────────────────── */

  /** `line` is 1-based; `col`/`len` are UTF-16 code units within that line,
   *  taken straight from the `Snippet`.  A group header passes the line/col/len
   *  of its FIRST snippet; a filename-only row passes `line = 1, col = 0,
   *  len = 0`.  The clamp against a file that changed since the scan is owner
   *  03's, inside `openResult`, because it needs the live document. */
  private async open(row: CursorRow, keepFocus: boolean): Promise<void> {
    await this.deps.openResult(row.rel, row.line, row.col, row.len)
    if (keepFocus) this.input.focus()
  }

  /* ── expansion — spec-05 §8.8 / §11.3 ─────────────────────────────────── */

  private async toggleGroup(rel: VaultPath): Promise<void> {
    const groups = this.model.contentGroups()
    const idx = groups.findIndex((g) => g.rel === rel)
    if (idx < 0) return
    const nowCollapsed = this.model.isCollapsed(rel, idx)
    this.model.collapsed.set(rel, !nowCollapsed)
    if (nowCollapsed && !this.model.expanded.has(rel)) {
      // Expanding: fetch the rest.  A collapsed group renders NO snippet DOM at
      // all, so this is the first time this group's snippets are needed.
      const gen = this.model.gen
      try {
        const snips = await this.deps.expand(this.model.query, rel)
        if (this.model.gen !== gen) return          // superseded while awaiting
        if (snips.length === 0) {
          // §11.3: a file deleted since the scan is an EMPTY VECTOR, not an
          // error.  Drop the group rather than showing an empty accordion.
          this.model.groups = this.model.groups.filter((g) => g.rel !== rel)
          if (this.model.ordered) this.model.ordered = this.model.ordered.filter((g) => g.rel !== rel)
          this.model.collapsed.delete(rel)
        } else {
          this.model.expanded.set(rel, snips)
        }
      } catch {
        // A structured failure here has no `VaultError` variant to land in
        // (§1.5 is closed) and the user is expanding a result a SUCCESSFUL
        // search produced, so it is unreachable in practice.  Leave the two
        // inline snippets showing rather than surfacing anything.
      }
    }
    this.paintList()
  }

  private setCursorCollapsed(collapse: boolean): boolean {
    const row = this.rows[this.cursor]
    if (!row) return false
    const el = row.el
    if (!el.classList.contains('sr-file--group')) return false
    const rel = el.dataset['rel']
    if (rel === undefined) return false
    const groups = this.model.contentGroups()
    const idx = groups.findIndex((g) => g.rel === rel)
    if (idx < 0) return false
    if (this.model.isCollapsed(rel, idx) === collapse) return true
    void this.toggleGroup(rel)
    return true
  }

  private moveCursor(delta: number): void {
    if (this.rows.length === 0) return
    const next = this.cursor + delta
    this.cursor = Math.max(0, Math.min(this.rows.length - 1, next < 0 ? 0 : next))
    this.paintCursor()
    const el = this.rows[this.cursor]?.el
    // `scrollIntoView({block:'nearest'})` is a one-off call from a key event,
    // not a per-frame cost, so it does not touch §5.12.6's scroll budget.
    el?.scrollIntoView({ block: 'nearest' })
  }

  /* ═════════════════════════════════════════════════════════════════════════
   * 9.  PAINT.  Full repaint for structure, targeted for the count line and the
   *     cursor.  `appendGroups` is the incremental path and is what makes a
   *     16 ms batch cost one append rather than one rebuild.
   * ═══════════════════════════════════════════════════════════════════════ */

  paint(): void {
    this.paintCount()
    this.paintList()
  }

  private paintCount(): void {
    const text = this.model.countLine(this.now())
    if (text === null) {
      this.countEl.hidden = true
      this.countEl.textContent = ''
    } else {
      this.countEl.hidden = false
      this.countEl.textContent = text
    }
  }

  private paintList(): void {
    const scroll = this.list.scrollTop
    this.list.textContent = ''
    this.rows = []
    this.paintErrorInto(this.list)
    this.paintFilesInto(this.list)
    this.paintGroupsInto(this.list, this.model.contentGroups())
    this.paintState()
    this.list.scrollTop = scroll
    this.paintCursor()
  }

  private paintFiles(): void {
    // The `Files` section is pinned to the top and is the only thing that can
    // change when a `files` message lands, but it is at most 20 rows, so a full
    // structural repaint is cheaper than a splice and cannot get out of step.
    this.paintList()
  }

  /** The incremental path: append the groups that arrived since the last paint,
   *  without touching what is already on screen (§6.3 — content groups are
   *  appended in arrival order). */
  private appendGroups(): void {
    if (this.model.ordered !== null) { this.paintList(); return }
    const painted = this.list.querySelectorAll('.sr-file--group').length
    const groups = this.model.groups
    if (groups.length <= painted) return
    const stateEl = this.list.querySelector('.sr-state')
    if (stateEl) stateEl.remove()
    for (let i = painted; i < groups.length; i += 1) {
      const g = groups[i]
      if (g) this.appendGroup(this.list, g, i)
    }
  }

  /** spec-05 §6.3's ONE DOM reorder: `append` MOVES an existing node, so the
   *  200 headers are re-parented, not rebuilt.  Their snippet blocks move with
   *  them because each is appended immediately after its header. */
  private reorder(): void {
    const ordered = this.model.ordered
    if (!ordered) return
    // ONE pass to index the headers by `rel`, rather than a `querySelector` per
    // group.  At the §4.5 cap that is 200 selector matches against a ~500-node
    // subtree — quadratic work landing at the END of every search, i.e. on the
    // frame the user is already reading results in.  The map is built from the
    // same live list the loop then reorders, so it cannot disagree with it.
    const headers = new Map<VaultPath, HTMLElement>()
    for (const el of this.list.querySelectorAll<HTMLElement>('.sr-file--group')) {
      const rel = el.dataset['rel']
      if (rel !== undefined) headers.set(rel, el)
    }
    for (let i = 0; i < ordered.length; i += 1) {
      const g = ordered[i]
      if (!g) continue
      const header = headers.get(g.rel)
      if (!header) { this.paintList(); return }
      const snips = header.nextElementSibling
      this.list.append(header)
      if (snips && snips.classList.contains('sr-snips')) this.list.append(snips)
      // The default collapse state is positional, so a group that the reorder
      // moved past the auto-expand boundary must lose or gain its snippets.
      const collapsed = this.model.isCollapsed(g.rel, i)
      header.classList.toggle('is-collapsed', collapsed)
      header.setAttribute('aria-expanded', String(!collapsed))
      if (collapsed && snips && snips.classList.contains('sr-snips')) snips.remove()
      if (!collapsed && (!snips || !snips.classList.contains('sr-snips'))) {
        header.after(this.buildSnippets(g))
      }
    }
    this.rebuildRows()
  }

  private paintErrorInto(host: HTMLElement): void {
    if (this.model.error === null) return
    const box = this.doc.createElement('div')
    box.className = 'sr-error'
    box.setAttribute('role', 'alert')
    // Verbatim first line from `RegexMatcherBuilder::build`, as text (§8.6).
    box.textContent = this.model.error
    host.append(box)
  }

  private paintFilesInto(host: HTMLElement): void {
    const files = this.model.files
    if (files.length === 0) return
    const label = this.doc.createElement('div')
    label.className = 'sr-section-label'
    label.textContent = 'Files'
    host.append(label)
    for (const g of files) {
      // Filename rows are LEAVES: no chevron, no snippets, never collapsible.
      const row = this.buildFileRow(g, false)
      host.append(row)
      this.rows.push({ el: row, rel: g.rel, line: 1, col: 0, len: 0 })
    }
  }

  private paintGroupsInto(host: HTMLElement, groups: FileGroup[]): void {
    for (let i = 0; i < groups.length; i += 1) {
      const g = groups[i]
      if (g) this.appendGroup(host, g, i)
    }
  }

  private appendGroup(host: HTMLElement, g: FileGroup, index: number): void {
    const collapsed = this.model.isCollapsed(g.rel, index)
    const header = this.buildFileRow(g, true)
    header.classList.toggle('is-collapsed', collapsed)
    header.setAttribute('aria-expanded', String(!collapsed))
    host.append(header)
    const first = this.model.snippetsFor(g)[0]
    this.rows.push({
      el: header,
      rel: g.rel,
      line: first ? first.line : 1,
      col: first ? first.col : 0,
      len: first ? first.len : 0,
    })
    if (!collapsed) host.append(this.buildSnippets(g))
  }

  private buildSnippets(g: FileGroup): HTMLElement {
    const box = this.doc.createElement('div')
    box.className = 'sr-snips'
    for (const s of this.model.snippetsFor(g)) {
      const el = this.doc.createElement('div')
      el.className = 'sr-snip'
      el.setAttribute('role', 'option')
      // The snippet's own line/col/len live ON the node.  `reorder()` MOVES
      // these nodes rather than rebuilding them, so after the one reorder the
      // row table has to be recovered from the DOM — and a snippet is the one
      // row kind whose coordinates cannot be derived from its group (a group
      // has many).  Stamping them at build time keeps them exact by
      // construction and unable to drift from the text beside them.  UTF-16
      // code units, unconverted, as everywhere else in this file (§4.4).
      el.dataset['rel'] = g.rel
      el.dataset['line'] = String(s.line)
      el.dataset['col'] = String(s.col)
      el.dataset['len'] = String(s.len)
      el.append(renderHighlighted(this.doc, s.text, s.ranges))
      box.append(el)
      this.rows.push({ el, rel: g.rel, line: s.line, col: s.col, len: s.len })
    }
    return box
  }

  private buildFileRow(g: FileGroup, isGroup: boolean): HTMLElement {
    const row = this.doc.createElement('div')
    row.className = isGroup ? 'sr-file sr-file--group' : 'sr-file'
    row.dataset['rel'] = g.rel
    row.setAttribute('role', 'option')
    row.title = g.rel
    if (isGroup) {
      // §0.50 E98: the tree's chevron is an INLINE `<svg>`, and this panel
      // borrows it (`icons.ts`'s `chevron()`) rather than a CSS image, so the
      // two sidebar views draw the same mark by construction (§4.5). A
      // `::before` masked with the deleted `--chev` token painted a solid
      // block here.
      row.append(chevron(this.doc))
      // `float: right`, so the badge must precede the text in source order.
      const badge = this.doc.createElement('span')
      badge.className = 'sr-badge'
      badge.textContent = g.more ? `${g.matchCount.toLocaleString()}+` : g.matchCount.toLocaleString()
      row.append(badge)
    }
    row.append(renderHighlighted(this.doc, g.name, g.nameRanges))
    return row
  }

  private paintState(): void {
    const existing = this.list.querySelector('.sr-state')
    if (existing) existing.remove()
    if (this.model.error !== null) return
    if (this.rows.length > 0) return
    const copy = this.model.stateCopy()
    if (!copy) return
    const box = this.doc.createElement('div')
    box.className = 'sr-state'
    const p = this.doc.createElement('div')
    p.className = 'sr-state-primary'
    p.textContent = copy.primary
    box.append(p)
    if (copy.secondary !== null) {
      const s = this.doc.createElement('div')
      s.className = 'sr-state-secondary'
      s.textContent = copy.secondary
      box.append(s)
    }
    this.list.append(box)
  }

  /**
   * Recover the flattened row table from the DOM after `reorder()` has moved
   * nodes around.  It must walk BOTH row kinds in document order: `this.rows`
   * is what `onListClick` resolves a click against (`findIndex(r => r.el ===
   * el)`) and what the arrow keys step through, so a row kind missing here is
   * a row the user can neither click nor reach — silently, with the element
   * still on screen.  Snippets were the kind that went missing, and since
   * `Complete` always arrives that made clicking any result snippet a no-op
   * for every finished search.
   */
  private rebuildRows(): void {
    this.rows = []
    for (const el of this.list.querySelectorAll<HTMLElement>('.sr-file, .sr-snip')) {
      const rel = el.dataset['rel']
      if (rel === undefined) continue
      if (el.classList.contains('sr-snip')) {
        // Straight off the node `buildSnippets` stamped — no lookup, so a
        // reordered or expanded group cannot mis-address its own snippets.
        this.rows.push({
          el,
          rel,
          line: Number(el.dataset['line'] ?? 1),
          col: Number(el.dataset['col'] ?? 0),
          len: Number(el.dataset['len'] ?? 0),
        })
      } else if (el.classList.contains('sr-file')) {
        // A group header opens its FIRST snippet; a filename row opens 1/0/0.
        const g = this.model.contentGroups().find((x) => x.rel === rel)
          ?? this.model.files.find((x) => x.rel === rel)
        const first = g ? this.model.snippetsFor(g)[0] : undefined
        const isGroup = el.classList.contains('sr-file--group')
        this.rows.push({
          el,
          rel,
          line: isGroup && first ? first.line : 1,
          col: isGroup && first ? first.col : 0,
          len: isGroup && first ? first.len : 0,
        })
      }
    }
    this.paintCursor()
  }

  private paintCursor(): void {
    if (this.cursor >= this.rows.length) this.cursor = this.rows.length - 1
    for (let i = 0; i < this.rows.length; i += 1) {
      this.rows[i]?.el.classList.toggle('is-cursor', i === this.cursor)
    }
  }

  /** Test/harness hook: the flattened visible rows the cursor walks. */
  get visibleRowCount(): number {
    return this.rows.length
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 10.  MOUNT — the one entry point owner 01's main.ts calls.
 * ═══════════════════════════════════════════════════════════════════════════ */

export function mountSearch(sidebar: HTMLElement, deps: SearchDeps, now?: () => number): SearchPanel {
  return new SearchPanel(sidebar, deps, now)
}
