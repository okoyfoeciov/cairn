/**
 * src/tree.ts
 * Owner: 04.  Spec: CONTRACT.md §3 (the tree transport), §3.3 (the row pool is
 * sized from live clientHeight; OVERSCAN = 8, errata 2 / Y5), §3.4 (expansion is
 * FRONTEND-owned and PATH-KEYED), §3.5 (full rebuild, always), §5.2 (the box
 * model), §5.12.6 (the new scroll obligation), §7.6 (state.json), M59, M61.
 *
 * Rust carries NO expansion state: `flag::EXPANDED`, `set_expanded` and `reveal`
 * are all STRUCK.  `revealPath()` below is §3.4's "three lines of frontend".
 *
 * ── THE ONE OBLIGATION §5.12.6 ADDS ──────────────────────────────────────────
 * Under `AsyncOverflowScrollingEnabled = NO` the `scroll` handler is on the
 * critical path of EVERY FRAME OF EVERY SCROLL, including the whole trackpad
 * momentum tail, with nothing running off-thread behind it.  It MUST:
 *   (a) read `scrollTop` AND NOTHING ELSE — no getBoundingClientRect,
 *       offsetHeight or clientHeight inside the handler.  `clientH` below is
 *       cached and refreshed by a ResizeObserver, which is what covers a window
 *       resize, the sidebar being shown or hidden, AND any §3.3-slot banner
 *       appearing (a cap banner shortens the scroller to 857 / 833 and §7.3
 *       case 16's watcher bar to 833 — all of them ordinary resizes, not
 *       special cases);
 *   (b) write only `transform: translateY()` and text, on pooled rows;
 *   (c) NEVER allocate a row during a scroll — the pool is sized once from live
 *       `clientHeight` and re-sized only on resize;
 *   (d) hold a budget of <= 2 ms per scroll event at the 50,000-node cap.
 *
 * ── WHY THIS MODULE TAKES ITS COLLABORATORS AS A `TreeHost` ──────────────────
 * The obvious shape is a module-level singleton importing `ipc.ts` (02),
 * `editor.ts` (03) and `state.ts` (04).  It is the wrong shape here for two
 * reasons, and only one of them is scheduling.
 *   1. Those modules are `TODO(impl)` stubs today.  Importing a named export
 *      that does not exist is a typecheck failure, so a singleton would make
 *      this file uncompilable until three other owners land — and §6.4 forbids
 *      me from touching any of them.
 *   2. More durably: the tree's dependencies are all EFFECTS (open a note,
 *      persist a patch, freeze on vault-lost).  Taking them as a record makes
 *      the whole virtualiser testable in a DOM shim with no IPC, which is where
 *      §5.12.6(d)'s <= 2 ms budget is asserted.
 * `main.ts` (owner 01) wires it; see the REPORTED WIRING note at the foot.
 *
 * Rows are `.tr` / `.tr.d` / `.tr.d.o` (+ `.a` active, `.c` cursor), absolutely
 * positioned inside `.sz`, and each carries its depth TWICE: `style="--d:3"` for
 * the CSS and `data-d="3"` so tools/verify-geometry.js and any DOM test can
 * assert on it without parsing inline styles.  `.tr.d` is applied when
 * `isDir(i) && subtree[i] > 0` — AN EMPTY FOLDER DRAWS NO CHEVRON (M61).  No
 * transition on the chevron (M59); that is tree.css's business, not this file's.
 */

import { chevron, paintIcons } from './icons'
import { adopt, type TreeBlob } from './treeblob'
import { openInlineRow, type NameEditorHandle, type NameEditorOptions } from './inline-edit'

/**
 * §3.3, errata 2 (Y5).  The pool is `ceil(clientHeight / --row-h) + 2*OVERSCAN + 1`
 * — 50 rows at 881px, 49 at 857, 48 at 833 (§0.12 E14 deleted the 40px nav band,
 * so every one of those heights is 40 more than the 842 / 818 / 794 this used to
 * print; §0.6 E8 had already made them 841 / 817 / 793 without propagating it).
 * X9's `+ 2` form is STRUCK: §8.2's additive ladder charged the tree with the
 * OVERSCAN pool and a measurement beats a derivation.  §3.3 requires this to be
 * A NAMED CONSTANT here, not a literal.  THE FORMULA DID NOT CHANGE — only the
 * heights it is worked against, which is the whole reason it is a formula.
 */
export const OVERSCAN = 8

/** Fallback row pitch if `--row-h` cannot be read (no stylesheet — a test shim). */
const ROW_H_FALLBACK = 27

/**
 * `editAt`'s inactive value — a display index no tree can reach (the node cap is
 * 50,000, §3.3).  A SENTINEL, not `-1`: `editAt` is compared with `v >= editAt`
 * on the paint path, and `-1` would make that true for every row.
 */
const NO_EDIT = 0x7fff_ffff

/** §7.6 / spec-04 §11: `expanded` and `scrollTop` are debounced 1,000 ms. */
const PERSIST_DEBOUNCE_MS = 1000

/** spec-04 §12.1: the type-ahead prefix buffer resets after 500 ms. */
const TYPEAHEAD_MS = 500

/**
 * THE FIXED MEMOIR NOTE (user feature, 2026-09-15).  Vault-root `Memoir.md` is
 * shown ONLY in the tab strip's fixed second tab (src/tabstrip.ts, src/main.ts)
 * and NEVER as a sidebar row: it is a place, not a file to browse.  Hidden
 * from the TREE ONLY — search still finds it (user ruling), and a `[[Memoir]]`
 * wikilink still resolves to it and opens in the Memoir tab.  Only the ROOT
 * spell is hidden: `notes/Memoir.md` is an ordinary note.  The backend snapshot
 * still carries it (so the blob, counts on the wire and search are untouched);
 * the hiding is one byte per node in `hidden`, set in `restore()` — which
 * already decodes every file's name — and honoured in `flatten()`.
 */
export const MEMOIR_PATH = 'Memoir.md'

/**
 * §7.6: `expanded` is capped at 2,000 entries and silently truncated.  Enforced
 * here as well as in `prefs.rs`, so the cap holds even if the patch never
 * reaches disk.
 */
export const EXPANDED_CAP = 2000

/* ── the fold animation (§0.44 E90) ────────────────────────────────────────
 * OBSIDIAN'S OWN NUMBERS, `[S]`, measured in the live 1.13.7 on this machine
 * with `tools/obsidian-live.mjs` (2026-09-12) and cross-read in its `app.js`:
 *
 *     duration  100ms                            `bl`/`wl`, app.js
 *     easing    cubic-bezier(.02, .01, .47, 1)   the computed style of the
 *                                                animating .nav-folder-children
 *     property  height, under `overflow-y: clip`
 *
 * They are the SAME TWO VALUES `properties.ts` already ports for the Properties
 * fold (§0.24.5 E53) — one primitive in Obsidian (`kl`/`bl`/`wl`/`yl`/`ml`),
 * used for both — and they are deliberately NOT shared between the two modules:
 * §6.4 gives `properties.ts` to owner 03 and this file to owner 04, and a
 * constant imported across that seam would make one owner's edit silently move
 * the other's animation.  Both cite Obsidian, which is the single source. */
const FOLD_MS = 100

/**
 * `cubic-bezier(x1, y1, x2, y2)` as a function of x, by Newton-Raphson with a
 * bisection fallback — the same solve Chromium does for a CSS timing function.
 *
 * WHY THIS IS COMPUTED RATHER THAN HANDED TO CSS.  Obsidian animates ONE
 * element's `height` and lets the engine ease it.  Cairn's rows are absolutely
 * positioned inside `.sz` at a fixed pitch (spec-04 §5.4) and there is no
 * element whose height IS the band, so the fold is driven from rAF and the
 * easing has to be evaluated here.  Keeping Obsidian's curve rather than
 * substituting `ease-in-out` matters at this duration: at the halfway point the
 * two differ by 21% of the band's height.
 */
function cubicBezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  const cx = 3 * x1
  const bx = 3 * (x2 - x1) - cx
  const ax = 1 - cx - bx
  const cy = 3 * y1
  const by = 3 * (y2 - y1) - cy
  const ay = 1 - cy - by
  const xAt = (t: number): number => ((ax * t + bx) * t + cx) * t
  const yAt = (t: number): number => ((ay * t + by) * t + cy) * t
  const dxAt = (t: number): number => (3 * ax * t + 2 * bx) * t + cx
  return (x: number): number => {
    if (x <= 0) return 0
    if (x >= 1) return 1
    let t = x
    for (let i = 0; i < 8; i++) {
      const d = xAt(t) - x
      if (Math.abs(d) < 1e-6) return yAt(t)
      const slope = dxAt(t)
      if (Math.abs(slope) < 1e-6) break
      t -= d / slope
    }
    let lo = 0
    let hi = 1
    t = x
    for (let i = 0; i < 32 && hi - lo > 1e-6; i++) {
      const v = xAt(t)
      if (Math.abs(v - x) < 1e-6) break
      if (v > x) hi = t
      else lo = t
      t = (lo + hi) / 2
    }
    return yAt(t)
  }
}

/** Obsidian's curve, applied to the band's height. */
const FOLD_EASE = cubicBezier(0.02, 0.01, 0.47, 1)

/** `performance.now()` where it exists — a DOM shim may have neither. */
function nowMs(): number {
  return typeof performance === 'object' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
}

/**
 * §0.44 E90.  One fold in flight, and everything the paint path needs to know
 * about it.
 *
 * THE MODEL IS OBSIDIAN'S, MEASURED RATHER THAN GUESSED.  Its children do NOT
 * slide: through the whole 100ms the first child's viewport top held at 113.10
 * and the second's at 140.00, while the row BELOW the folder moved 113.00 ->
 * 166.90.  So the band's contents are static at their final positions and are
 * revealed by a growing clip, and everything after the band is lifted by
 * whatever part of the band is still closed.  That is exactly `shift`.
 */
interface FoldAnim {
  /** First visible index inside the band — the folder's first child. */
  from: number
  /** Last visible index inside the band. */
  to: number
  /** The band's top edge in SIZER coordinates, frozen at the start. */
  top: number
  /** The band's full open height, `(to - from + 1) * rowH`. */
  delta: number
  /** How much of `delta` is still CLOSED: `delta` -> 0 opening, 0 -> `delta`
   *  closing.  The one number every frame moves. */
  shift: number
  /** Committed when the fold ends, however it ends. */
  finish: () => void
}

/* ── the class-name table (spec-04 §5.4) ────────────────────────────────────
 * `className` string concatenation is one of the three allocation sources
 * eliminated on the paint path.  A table precomputed at module load, indexed
 * by state bits, removes it.
 *
 * Drag-to-move (Obsidian's file-explorer drop, transcribed) adds two bits:
 * DRAG (the source rows, `is-being-dragged`) and DROP (the row under the
 * cursor, `is-being-dragged-over`). Both are painted, not toggled, because
 * the rows are pooled and a direct classList write would be overwritten by
 * the next paint — exactly why ACTIVE/CURSOR/SEL ride the table too.
 *
 * SECRET is the eighth bit and rides for the same reason: a secret file's
 * row draws `is-secret`, resolved from paths in `restore()` and read here. */
const CHEV = 1
const OPEN = 2
const ACTIVE = 4
const CURSOR = 8
const SEL = 16
const DRAG = 32
const DROP = 64
/* The secret row's mark (user feature, 2026-09-16): the eighth bit, painted
 * like every other row state because the rows are pooled and a direct
 * classList write would be overwritten by the next paint. */
const SECRET = 128
const CLS: string[] = new Array<string>(256)
for (let m = 0; m < 256; m++) {
  CLS[m] =
    'tr' +
    (m & CHEV ? ' d' : '') +
    (m & OPEN ? ' o' : '') +
    (m & ACTIVE ? ' a' : '') +
    (m & CURSOR ? ' c' : '') +
    (m & SEL ? ' s' : '') +
    (m & DRAG ? ' is-drag' : '') +
    (m & DROP ? ' is-drop' : '') +
    (m & SECRET ? ' is-secret' : '')
}

/**
 * A pooled row.  The four `__` fields are last-written caches — they are what
 * make a steady-state scroll frame one `textContent` write and two style writes
 * in total, and `__n` doubles as the hit-test result so no `data-*` read and no
 * `dataset` allocation is ever needed (spec-04 §5.4, §6.1).
 */
interface PoolRow extends HTMLDivElement {
  __n: number
  __y: number
  __d: number
  __m: number
  __h: boolean
  /** §0.44 E90: the last `clip-path` written, `''` for none.  A STRING rather
   *  than a number because the value is the thing compared — the fold writes a
   *  different inset on every frame and an unchanged one on most rows. */
  __c: string
  /** §0.50 E98: the row's label is a dedicated text node, written through
   *  `.data`, because the row now has a child before it — the `<svg class=
   *  "chev">` chevron — and a `textContent` write would take it with it. */
  __t: Text
}

/** What the tree asks of the rest of the app.  Every member is optional. */
export interface TreeHost {
  /** `.tree-scroller` — the scroller itself, `tabindex="0" role="tree"`. */
  scroller: HTMLElement
  /** `.sz` — the sizer.  Defaults to `scroller.querySelector('.sz')`. */
  sizer?: HTMLElement
  /** A file row was activated.  `path` keeps its `.md` (§1.1 `VaultPath`). */
  openNote?(path: string): void
  /** §7.3 case 5, via spec-04 §6.3: the open note is gone from the fresh blob. */
  onActiveVanished?(path: string): void
  /** The keyboard cursor moved.  `path` is null when the cursor was dropped. */
  onCursorMoved?(path: string | null): void
  /** Debounced 1 s.  Becomes `UiPatch.expanded` (§7.6). */
  onExpandedChanged?(paths: string[]): void
  /** Debounced 1 s.  Becomes `UiPatch.scrollTop` (§7.6). */
  onScrollTopChanged?(scrollTop: number): void
  /** Right-click on a row, or on empty space below the last row (`path` null). */
  onContextMenu?(ev: MouseEvent, path: string | null, isDir: boolean): void
  /** `F2` on the cursor row — owner 04's inline-edit.ts, not this file. */
  onRenameRequest?(path: string, isDir: boolean): void
  /** `Backspace` on the cursor row — the confirm modal is not this file's. */
  onDeleteRequest?(path: string, isDir: boolean): void
  /** Drag-to-move drop: `sources` into `destParent` (`''` = vault root).
   *  Already filtered to top-level (a folder swallows its selected
   *  descendants, Obsidian's `xA`), already validated (SA + already-there),
   *  in blob order. The host moves them (command 24, one call each) and
   *  refreshes; this module clears its drag state on `drop` regardless. */
  onMoveRequest?(sources: { path: string; isDir: boolean }[], destParent: string): void
  /** Vault display name for the drag ghost's `Move into “X”` line (`''` =
   *  vault root). Falls back to `vault` when absent — the ghost is transient
   *  and never gated, but Obsidian names the vault there. */
  getVaultName?(): string
  /** `Escape` with no rename open: return focus to the editor (spec-04 §12.1). */
  onEscape?(): void
  /**
   * §7.3 case 8: while `nc://vault-lost` is outstanding the tree is FROZEN —
   * clicks set the cursor but perform no mutation and open no note.  Returning
   * true from here is how the chrome tells the tree it is in that state.
   */
  isFrozen?(): boolean
}

/** The subset of `UiPatch` (§1.5) this module produces. */
export interface TreeController {
  /** §3.5: full rebuild, always, no deltas.  Adopt -> restore -> flatten -> paint. */
  applySnapshot(buffer: ArrayBuffer): void
  /** The live blob, or null before the first snapshot. */
  blob(): TreeBlob | null
  /** Seed the path-keyed expansion set from `state.json` (§3.4, §7.6). */
  setExpanded(paths: readonly string[]): void
  /** The expansion set, capped at EXPANDED_CAP — what goes into `UiPatch.expanded`.
   *  Insertion-ordered, not sorted: §7.6 specifies a cap and silent truncation
   *  and says nothing about order, and `prefs.rs` does not compare the arrays. */
  expanded(): string[]
  /** The note open in the note tab (never MEMOIR_PATH — the Memoir tab's note
   *  has no sidebar row, so the shell passes `null` while it is active).
   *  Survives sort changes and refreshes. */
  setActivePath(path: string | null): void
  activePath(): string | null
  cursorPath(): string | null
  /**
   * The shift-selection, in blob order.  Empty until the first shift-click;
   * main.ts's delete subject is its only consumer.
   */
  getSelection(): { path: string; isDir: boolean }[]
  /** The secret files' rels, from command 25.  Path-keyed like the
   *  selection; re-resolved here and in `restore()`, then painted through
   *  the class table.  A rel this blob does not hold is skipped. */
  setSecrets(rels: readonly string[]): void
  /** Descendant count for `path`, excluding itself.  The delete confirm's
   *  non-empty-folder warnings. */
  descendantCount(path: string): number
  /**
   * §3.4's `reveal`, in frontend: add every ancestor of `path` to the set,
   * re-flatten, scroll to it (CENTRED — the jump is arbitrary, spec-04 §12.1).
   * Returns the visible row index, or -1 if the path is not in this blob.
   */
  revealPath(path: string): number
  /** Restore `scrollTop` from `state.json`, clamped to the current content. */
  setScrollTop(top: number): void
  /** §7.6: fire the pending 1,000 ms expansion/scrollTop persists NOW, through
   *  `onExpandedChanged`/`onScrollTopChanged`.  A vault switch and a quit call
   *  this before flushing state.json, or the last second of changes is lost. */
  flushPersist(): void
  /** Drop the pending persists without firing them (a vault being closed). */
  cancelPersist(): void

  /* ── §5.4.2 / §7.3 cases 4 and 11: THE INLINE ROW EDITOR ────────────────
   * The entry being created or renamed is edited IN THE TREE ROW ITSELF, which
   * is what §5.4.2 describes and what Obsidian does.  Before this seam existed
   * `TreeController` handed out no host element, so `main.ts` (owner 01) had to
   * fall back to a small centred dialog and said so in a REPORTED DEVIATION
   * comment — the primitive `inline-edit.ts` exports for exactly this
   * (`openInlineRow(host, opts)`) had nowhere to be mounted.
   *
   * Rows are absolutely positioned inside `.sz` and their depth/indent model is
   * §5.2's, owned by this file; the character filter, the 200 ms `.bad` flash
   * and the stays-open-on-rejection rule are `inline-edit.ts`'s.  So the split
   * is: THIS FILE POSITIONS THE ROW, THAT FILE OWNS THE FIELD.  Nobody reaches
   * into anybody's subtree (spec-07 §1 rule 5). */

  /**
   * A positioned, empty `.tr.tr-edit` host sitting exactly on the row for
   * `path`, at that row's depth and indent.  The row underneath is hidden for
   * as long as the host is open, so the name is not drawn twice.  Ancestors are
   * revealed and the row is scrolled into view if it is not already.
   * Returns null before the first snapshot or if `path` is not in this blob.
   * The CALLER owns what goes inside it; `releaseRowHost()` takes it away.
   */
  rowHost(path: string): HTMLElement | null
  /**
   * Reserve a NEW row for an entry that does not exist yet, as the first child
   * of `parent` (`''` = the vault root, where it is row 0).  A collapsed parent
   * is expanded first.  Every row at or below the insertion point shifts down
   * by one row and the sizer grows by one, so nothing is drawn on top of
   * anything — the reserved row occupies real space exactly like a real one.
   */
  reserveRowHost(parent: string): HTMLElement | null
  /** Take away whichever host is open, un-hide the row under it and give back
   *  the reserved space.  Idempotent, and safe to call when nothing is open. */
  releaseRowHost(): void
  /**
   * §7.3 cases 4 and 11.  `rowHost(path)` + `openInlineRow`, wired together:
   * the field is the shared one, so the filter, the flash, the `{ok:false}`
   * keeps-it-open rule and the §1.5 error copy are all the app's single copy.
   * The host is released on commit and on cancel; the caller does not have to.
   *
   * `select` DEFAULTS TO `'all'`, which is Obsidian's: the field holds the name
   * as the row was drawing it, with no extension in it, and the caller puts the
   * extension back through `suffix`.  See the implementation for why `'stem'`
   * was wrong here.
   */
  beginRename(path: string, opts: NameEditorOptions): NameEditorHandle | null
  /** New note / new folder, in a reserved row under `parent`.  Same wiring. */
  beginCreate(parent: string, opts: NameEditorOptions): NameEditorHandle | null
  /** Re-read `clientHeight` and re-size the pool.  Idempotent. */
  measure(): void
  /** Remove every listener and every pooled row. */
  destroy(): void
  /** Test/diagnostic surface.  Not used by the app. */
  readonly debug: TreeDebug
}

export interface TreeDebug {
  visibleCount(): number
  poolSize(): number
  rowCount(): number
  clientHeight(): number
  rowPitch(): number
  /** The node index at visible row `v`, or -1. */
  nodeAt(v: number): number
  /** Drive one scroll frame without a real `scroll` event (budget assertions). */
  onScroll(): void
  paintedRange(): [number, number]
  flushPersist(): void
  /** The open inline-edit host, or null.  Test/diagnostic only. */
  editHost(): HTMLElement | null
  /** The path being renamed, or null (a create has no path yet). */
  editingPath(): string | null
  /** The display index the reserved row occupies, or -1 when none is reserved. */
  reservedAt(): number
  /** Drag-to-move test seam (pure, live-blob-bound). */
  dropTargetFor(n: number): string | null
  isValidDrop(sources: { path: string; isDir: boolean }[], target: string | null): boolean
  filterTopLevel(entries: { path: string; isDir: boolean }[]): { path: string; isDir: boolean }[]
  dragSetFor(n: number): { path: string; isDir: boolean }[]
}

export function createTree(host: TreeHost): TreeController {
  const scroller = host.scroller
  const sizer =
    host.sizer ?? (scroller.querySelector('.sz') as HTMLElement | null) ?? makeSizer(scroller)

  /* ── model ──────────────────────────────────────────────────────────────── */
  let blob: TreeBlob | null = null
  /** Frontend-owned, bit 0 = expanded.  One byte per node, never an object. */
  let ui = new Uint8Array(0)
  /** MEMOIR_PATH rows, set in `restore()`, skipped in `flatten()`. */
  let hidden = new Uint8Array(0)
  /** The flattened row list: visible[v] = node index. */
  let visible = new Int32Array(0)
  let visibleCount = 0

  /**
   * §3.4: a `Set<string>` of VAULT-RELATIVE FOLDER PATHS.  Path-keyed, not
   * NodeId-keyed, which is what survives an external `git pull` creating
   * folders and what RESTORES expansion for a folder deleted and recreated by a
   * `git checkout`.  Dead entries are NOT pruned here on a refresh; pruning
   * happens once, in Rust, after a successful full scan.
   */
  const expandedPaths = new Set<string>()

  /* Durable, because indices are invalidated by every snapshot (spec-04 §6.2). */
  let cursorPath: string | null = null
  let activePath: string | null = null
  let cursorNode = -1
  let activeNode = -1
  /**
   * Shift-click range selection, transcribed from Obsidian 1.13.7's file tree
   * (user ruling, 2026-09-14; `handleItemSelection` in app.js).  Three facts,
   * all measured live before they were written down:
   *
   * - The ANCHOR is the last plain-clicked row — Obsidian's `activeDom`, set
   *   for files AND folders, but NOT by opening a note another way and NOT by
   *   clicking the already-open file.  A shift-click with no anchor selects
   *   just the clicked row.
   * - A shift-click REPLACES the selection with the visible rows from anchor
   *   to clicked, inclusive — folders count as their one visible row, and
   *   nothing opens, toggles, or moves.  A plain click clears first.
   * - The open row keeps its own marker AND joins the range (both classes).
   *
   * `anchorPath`/`selPaths` are the truth (paths survive snapshots; indices
   * do not).  `anchorNode`/`selNodes` are derived in `restore()` and read on
   * the paint path, exactly like `activeNode`/`cursorNode`.  Ctrl/Cmd-toggle
   * (`isModEvent`) is deliberately NOT transcribed — unasked-for scope, and a
   * second selection gesture needs its own ruling.
   */
  let anchorPath: string | null = null
  let anchorNode = -1
  const selPaths = new Set<string>()
  const selNodes = new Set<number>()
  /* The secret files' rels, from command 25 (`secret_notes`).  Path-keyed
   * truth + derived nodes, exactly like `selPaths`/`selNodes`: indices mean
   * nothing across a snapshot, so `restore()` re-resolves and a rel the
   * backend saw but this blob does not hold falls out rather than marking
   * whatever now holds the index. */
  let secretPaths = new Set<string>()
  const secretNodes = new Set<number>()
  /** NOTES in the current snapshot (files, not folders). Re-counted in
   *  `restore()`, so it is current after every snapshot without a second walk.
   *  User ruling, 2026-09-14 [C]: a vault holding exactly one note draws NO
   *  active fill — Obsidian highlights its single row (`is-active` at the hover
   *  value, measured live on 1.13.7), and this deliberately differs. */
  let fileCount = 0

  /* ── drag-to-move (Obsidian's file-explorer drop, transcribed) ────────────
   * `dragPaths`/`dragNodes` are the SOURCES (path-keyed truth + derived nodes,
   * exactly like `selPaths`/`selNodes`); `dropNode` is the ROW UNDER THE CURSOR
   * carrying `is-drop` (-1 for empty-space/root, -2 for none/invalid).
   * `dropParent` is where a drop would land (`''` = vault root).
   * `dragGhost`/`dragActionEl` are the `.drag-ghost` follower; `dropTimer` is
   * the 750ms auto-expand (Obsidian's `mouseoverExpandTimeout`). */
  const dragPaths = new Set<string>()
  const dragNodes = new Set<number>()
  /** The top-level entries resolved at `dragstart`.  Valid for the whole drag:
   *  `applySnapshot` is the only writer of `blob` and it ends the drag
   *  (`clearDrag`) before adopting, so dragover/drop never re-walk the blob. */
  let dragLive: { path: string; isDir: boolean }[] = []
  let dropNode = -2
  let dropParent: string | null = null
  let dragGhost: HTMLElement | null = null
  let dragActionEl: HTMLElement | null = null
  /** Obsidian's `LO`: the 1x1 transparent GIF `NO(e)` sets as the drag image.
   *  One per tree, reused across drags, so it is decoded before it is needed. */
  let dragBlank: HTMLImageElement | null = null
  let dropTimer: ReturnType<typeof setTimeout> | null = null
  /** DROP_EXPAND_MS — Obsidian's `mouseoverExpandTimeout`, 750ms (app.js
   *  `attachDropHandler`: `setTimeout(...,750)` to `setCollapsed(!1)`). */
  const DROP_EXPAND_MS = 750

  /* ── view ───────────────────────────────────────────────────────────────── */
  const pool: PoolRow[] = []
  let poolSize = 0
  /** Scratch for hideUnused(): one byte per pool slot, never allocated on a
   *  scroll frame.  Re-made only when the pool is re-sized. */
  let slotUsed = new Uint8Array(0)
  let curFirst = 0
  let curLast = -1
  /** §5.12.6(a): cached.  NEVER read from the DOM inside onScroll. */
  let clientH = 0
  let rowH = ROW_H_FALLBACK
  /**
   * §0.34 E80 — THE SCROLLER'S OWN `padding-top`, in scroll coordinates.
   *
   * It is NOT cosmetic to this module and that is the whole point of caching it
   * here.  `scrollTop` is measured from the scroller's PADDING BOX, so with a
   * top padding of `p` the sizer — and therefore visible row `i` — sits at
   * `p + i * rowH` in scroll coordinates while every row is still laid out at
   * `i * rowH` inside `.sz`.  Four conversions have to know: `onScroll`'s
   * window, `maxScroll`, and the two comparisons in `reserveRowHost`.
   *
   * LEAVING IT OUT PRODUCES NO VISIBLE SYMPTOM, AND THAT IS THE HONEST REASON TO
   * WRITE IT DOWN RATHER THAN A REASON TO SKIP IT.  Measured both ways on a
   * 120-note vault at max scroll: WITH the correction 23 rows are painted,
   * WITHOUT it 22 — and in both cases every pixel of the viewport above the
   * bottom padding is covered, because `OVERSCAN = 8` absorbs a one-row shift
   * whole.  No blank strip, no trimmed row, nothing to see.
   *
   * What it actually buys is two things.  `maxScroll()` is short by `padTop`
   * without it, so a `scroll_top` restored from `state.json` (§7.6) clamps one
   * row above where it was saved — reasoned from the code, NOT reproduced here.
   * And the window stops being correct only by accident: it is a superset today
   * because the overscan happens to be larger than the padding, which is a
   * coincidence between two numbers that have no relationship and that the user
   * has already moved three times (§0.32).
   *
   * Read from the live computed style with `--row-h`, never assumed, because
   * §0.32's own history is a value the user changed three times.
   */
  let padTop = 0
  /** `padding-bottom`, read beside `padTop` — `syncOverflow()` needs the whole
   *  scrollHeight, and `maxScroll()` deliberately leaves this term out. */
  let padBottom = 0
  /** Mirrors `.is-overflowing` on the scroller; see `syncOverflow()`. */
  let overflowing = false
  /** Mirrors `.kbd-focus` on the scroller; see `setKbdFocus()`. */
  let kbdFocus = false
  let destroyed = false

  /* ── the fold in flight (§0.44 E90) ────────────────────────────────────── */
  /** `null` whenever the tree is settled, which is all but ~100ms at a time. */
  let anim: FoldAnim | null = null
  let animRaf = 0
  /** Timeout backstop mirroring `properties.ts`: if rAF never fires (occlusion,
   *  locked screen mid-100ms), the fold still settles instead of leaving the
   *  band clipped with `anim` non-null. */
  let animTimer: ReturnType<typeof setTimeout> | null = null
  /** The pooled row whose chevron is allowed to animate — see tree.css's
   *  `--chev-ms` note on why exactly one row may, and why it is a property. */
  let chevRow: HTMLElement | null = null

  /* ── persistence (§7.6, debounced 1,000 ms) ─────────────────────────────── */
  let expandedTimer: ReturnType<typeof setTimeout> | null = null
  let scrollTimer: ReturnType<typeof setTimeout> | null = null

  /* ── type-ahead (spec-04 §12.1) ─────────────────────────────────────────── */
  let typeBuf = ''
  let typeAt = 0

  /* ── the inline row editor (§5.4.2, §7.3 cases 4 and 11) ────────────────────
   * Four pieces of state and nothing else, because the field itself belongs to
   * inline-edit.ts:
   *   editHost   the `.tr.tr-edit` element, NOT a pooled row — it is created and
   *              destroyed once per edit and never enters the pool, so
   *              §5.12.6(c) ("never allocate a row during a scroll") is untouched;
   *   editNode   the node index whose pooled row is suppressed while a RENAME is
   *              open, so the name is not drawn twice.  -1 for a create;
   *   editPath   that node's path, so the suppression survives a snapshot
   *              (node indices do not, see invalidatePool());
   *   editAt     the display index a RESERVED row occupies, or NO_EDIT.  This is
   *              the one piece that touches the paint path: rows at or below it
   *              render one row lower.  One integer compare per painted row. */
  let editHost: HTMLElement | null = null
  let editHandle: NameEditorHandle | null = null
  let editNode = -1
  let editPath: string | null = null
  let editAt = NO_EDIT

  /* ═══ pool ══════════════════════════════════════════════════════════════ */

  function makeSizer(parent: HTMLElement): HTMLElement {
    const el = document.createElement('div')
    el.className = 'sz'
    parent.appendChild(el)
    return el
  }

  /**
   * §3.3, X9: sized from the scroller's LIVE `clientHeight`, NEVER from a
   * constant.  A banner appearing or disappearing is an ordinary resize and
   * takes exactly this path.  This is the ONLY place a row is created, and it is
   * never reached from `onScroll` — §5.12.6(c).
   */
  function ensurePool(): void {
    const want = Math.ceil(clientH / rowH) + 2 * OVERSCAN + 1
    if (want === poolSize) return
    while (pool.length > want) {
      const el = pool.pop()
      if (el) el.remove()
    }
    while (pool.length < want) {
      const el = document.createElement('div') as PoolRow
      el.className = 'tr'
      el.setAttribute('role', 'treeitem')
      // Drag-to-move: every pooled row is a drag source (Obsidian makes each
      // `.tree-item-self` draggable). Set once here, never on the paint path —
      // `paint()` rewrites `className` but never touches `draggable`.
      // The shim has no `draggable` property; the attribute is the portable half.
      try {
        ;(el as unknown as { draggable: boolean }).draggable = true
      } catch {}
      el.setAttribute('draggable', 'true')
      // §0.50 E98: chevron first, label second. Every row carries the chevron;
      // tree.css shows it only on `.d`. See icons.ts's `chevron()` for why it
      // is an element and not a mask.
      el.appendChild(chevron(document))
      el.__t = document.createTextNode('')
      el.appendChild(el.__t)
      el.__n = -1
      el.__y = -1
      el.__d = -1
      el.__m = -1
      el.__c = ''
      // BORN HIDDEN.  A fresh pool row has no node, no name and no `--y`, and
      // `paint()` is the only thing that gives it one — but `paint()` and
      // `onScroll()` both return early while `blob` is null, so between
      // `createTree()` and the FIRST `applySnapshot()` nothing ever hides these.
      // On §7.5's first run that window has no end: `current_vault()` returns
      // `{state:'none'}`, no snapshot is ever applied, and the sidebar shows ~35
      // empty 27px rows stacked under the title strip for as long as the user
      // takes to pick a vault.  Found by the end-to-end launch, which measured
      // "35 visible .tr rows, .sz height=0, first row text=''" on a vault that
      // had not been opened yet.
      //
      // §0.44 E89 MAKES THIS MORE LOAD-BEARING, NOT LESS.  §7.5's centred
      // `Open folder as vault…` panel is deleted, so nothing is drawn over the
      // pane in that state any more and the sidebar is the whole of what the
      // user sees before they pick a vault.  Re-verified after the deletion:
      // 44 pooled rows, every `textContent` empty, `.sz` height unset.
      //
      // `paint()` already unhides on first use (`if (el.__h) { el.hidden = false
      // ... }`), so starting hidden costs one branch on the row's first paint
      // and nothing on any later frame.
      el.hidden = true
      el.__h = true
      sizer.appendChild(el)
      pool.push(el)
    }
    poolSize = want
    slotUsed = new Uint8Array(want)
    // Every slot mapping (`v % poolSize`) just changed, so nothing painted is
    // trustworthy: force a full repaint on the next pass.
    curFirst = 0
    curLast = -1
  }

  /**
   * Drop every pooled row's last-written cache.
   *
   * `paint()`'s four `__` guards are keyed on the NODE INDEX, and a node index
   * only identifies a name, a depth and a state WITHIN ONE BLOB.  Across a
   * snapshot they identify nothing: rename `b.md` to `bb.md` in a name-sorted
   * vault of `a`, `b`, `c` and the renamed note is still node 1, so `__n === n`
   * held and `textContent` was never rewritten — THE TREE KEPT DRAWING THE OLD
   * NAME until the row happened to be recycled by a scroll.  The same argument
   * applies to `__d` (delete a folder above a node and its depth changes at a
   * constant index) and to `__m` (a folder emptied by a delete loses its
   * chevron).  `curFirst/curLast` alone do NOT cover this: they force `paint()`
   * to be CALLED, and it is `paint()` itself that then declines to write.
   *
   * Called from `applySnapshot` only — at most `poolSize` (49) integer stores,
   * once per snapshot, and NEVER on a scroll frame (§5.12.6(c)).
   */
  function invalidatePool(): void {
    for (let s = 0; s < pool.length; s++) {
      const el = pool[s]!
      el.__n = -1
      el.__y = -1
      el.__d = -1
      el.__m = -1
    }
  }

  /* ═══ model passes ══════════════════════════════════════════════════════ */

  /**
   * spec-04 §5.1.  O(visibleCount), not O(N): a collapsed folder holding 4,000
   * notes costs ONE integer add, which is what invariant P buys.
   */
  function flatten(): void {
    if (!blob) {
      visibleCount = 0
      sizer.style.height = '0px'
      return
    }
    const { n, subtree, kind } = blob
    let v = 0
    let i = 0
    while (i < n) {
      // MEMOIR_PATH rows never reach the sidebar (see the export's note).
      // Files carry no subtree, so the skip is one step; the directory arm is
      // written anyway so a future hidden folder cannot half-exist here.
      if (hidden[i] !== 0) {
        i += (kind[i]! & 1) !== 0 ? subtree[i]! + 1 : 1
        continue
      }
      visible[v++] = i
      i += (kind[i]! & 1) !== 0 && (ui[i]! & 1) === 0 ? subtree[i]! + 1 : 1
    }
    visibleCount = v
    sizeSizer()
  }

  /* ── display geometry ───────────────────────────────────────────────────
   * A RESERVED row (a create in progress) is a real row that occupies real
   * space: the content is one row taller and every visible row at or below the
   * insertion point renders one row lower.  Both facts live in these three
   * functions and nowhere else, so a reserved row cannot half-exist. */

  /** Rows of content, INCLUDING a reserved one. */
  function displayCount(): number {
    return visibleCount + (editAt === NO_EDIT ? 0 : 1)
  }

  /** The `translateY` for VISIBLE index `v`.  One integer compare; `editAt` is
   *  `NO_EDIT` whenever no row is reserved, so the compare is false and this is
   *  `v * rowH` on every ordinary frame.
   *
   *  §0.44 E90 adds the second compare, and `anim` is `null` on every ordinary
   *  frame for the same reason: a fold is ~100ms of a click and this is on the
   *  paint path, so the settled tree pays one `!== null` and nothing else.
   *  Rows INSIDE the band are deliberately not shifted — Obsidian's children
   *  hold their final positions and are revealed by the clip in `paint()`. */
  function yOf(v: number): number {
    const y = (v >= editAt ? v + 1 : v) * rowH
    return anim !== null && v > anim.to ? y - anim.shift : y
  }

  function sizeSizer(): void {
    // §0.44 E90 — the sizer carries the fold too, so the SCROLLBAR grows and
    // shrinks with the band instead of snapping to the end state on the first
    // frame.  `maxScroll()` reads through `displayCount()` and is deliberately
    // NOT folded: clamping against a mid-animation height would fight the
    // scroll position for 100ms.  `clampScroll()` runs once, at the end.
    sizer.style.height = displayCount() * rowH - (anim !== null ? anim.shift : 0) + 'px'
    syncOverflow()
  }

  /**
   * `.is-overflowing` on the scroller (2026-09-15), which tree.css spends on the
   * row fill's right inset.  Obsidian's `.nav-files-container` is `overflow-y:
   * auto`, so its scrollbar takes width out of the rows only WHILE they
   * overflow; Cairn's scroller is `scroll` with a stable gutter (§5.2 X6), so
   * its layout never learns and this module has to say.  The predicate is the
   * scrollHeight itself — `padTop + rows + padBottom` — from `measure()`'s
   * cache and the sizer height just written, so it reads no DOM, and it runs
   * on every sizer write, which is every fold frame: the inset moves at the
   * moment Obsidian's bar would appear, not at the end of the animation.
   */
  function syncOverflow(): void {
    const next = padTop + displayCount() * rowH - (anim !== null ? anim.shift : 0) + padBottom > clientH
    if (next === overflowing) return
    overflowing = next
    if (next) scroller.classList.add('is-overflowing')
    else scroller.classList.remove('is-overflowing')
  }

  /**
   * `.kbd-focus` on the scroller (2026-09-15): whether the cursor ring may draw.
   *
   * Obsidian's ring is a class its JavaScript sets, `has-focus`, and only
   * keyboard navigation sets it (`changeFocusedItem` from the arrow keys,
   * app.js @1464191); a plain click on a row CLEARS it (`handleItemSelection`
   * ends `setFocusedItem(null)`, @1461013); a shift-click leaves it alone; and
   * a bare modifier never reaches its keymap at all (`isModifierKey`,
   * @1064799).  Measured live on 1.13.7: no ring after a click, after Shift,
   * after a shift-click; a ring after ArrowDown.
   *
   * Cairn gated the ring on `:focus-visible` instead, and CHROMIUM FLIPS A
   * MOUSE-FOCUSED BOX TO `:focus-visible` ON A BARE SHIFT KEYDOWN — measured in
   * the pinned Chrome 142 (Alt and Control alone do not).  A person holds Shift
   * before a shift-click, so the ring appeared on the row they had plain-clicked
   * first, which is the user's report.  A flag this module owns cannot be
   * flipped by the engine's heuristic.
   *
   * NOT transcribed: Obsidian ALSO sets `has-focus` on a plain click of the
   * note that is already open (@1460925), which draws a ring from a click — the
   * very thing reported.  Nothing here does.
   */
  function setKbdFocus(on: boolean): void {
    if (on === kbdFocus) return
    kbdFocus = on
    if (on) scroller.classList.add('kbd-focus')
    else scroller.classList.remove('kbd-focus')
  }

  /** The largest legal `scrollTop`.  §0.34 E80: `padTop` is scrollable content
   *  like any other — `scrollHeight` is `padTop + rows + padBottom`. */
  function maxScroll(): number {
    return Math.max(0, padTop + displayCount() * rowH - clientH)
  }

  /**
   * spec-04 §6.3, run once after every `adopt()`.  One loop, three jobs: apply
   * the path-keyed expansion set to `ui`, re-resolve the cursor, re-resolve the
   * active note.  Only FOLDERS get a path built eagerly; a file is string-
   * compared only when its last segment already matches, which is typically 0-2
   * concatenations for the whole pass.  A non-empty selection or secret set
   * costs one concatenation per file and a Set lookup — never a scan of the
   * set per file, which made a large shift-selection quadratic.
   */
  function restore(): void {
    if (!blob) return
    const { n, kind, depth } = blob
    const pre: string[] = []
    cursorNode = -1
    activeNode = -1
    anchorNode = -1
    fileCount = 0
    // The selection is path-keyed, so a refresh re-resolves it in this same
    // pass — and rows deleted out from under it (a bulk delete, an external
    // rm) fall out rather than pointing at whatever now holds their indices.
    selNodes.clear()
    secretNodes.clear()
    const seen = new Set<string>()
    const noteSelected = (p: string): boolean => {
      if (selPaths.has(p)) {
        seen.add(p)
        return true
      }
      return false
    }
    for (let i = 0; i < n; i++) {
      if ((kind[i]! & 1) !== 0) {
        const d = depth[i]!
        const p = d ? pre[d - 1] + '/' + blob.nameOf(i) : blob.nameOf(i)
        pre[d] = p
        hidden[i] = 0 // directories are never hidden (MEMOIR_PATH is a file)
        ui[i] = expandedPaths.has(p) ? 1 : 0
        if (p === cursorPath) cursorNode = i
        if (p === anchorPath) anchorNode = i
        if (noteSelected(p)) selNodes.add(i)
      } else {
        const nm = blob.nameOf(i)
        // MEMOIR_PATH (see the export's note): root-level only, files only.
        // Marked here because this pass already decodes every file's name —
        // `flatten()` must not decode 50,000 names to find one.  `nm` is the
        // DISPLAY stem (`Memoir`, no extension), so the extension's case is
        // checked too: a depth-0 `Memoir` with a lowercase `.md` IS
        // `Memoir.md`, and a `Memoir.MD` is an ordinary note.  A hidden row is
        // not a row: it leaves `fileCount` alone so a vault holding only
        // Memoir.md reads as empty, and no cursor/active/selection resolution
        // below can land on it because nothing ever asks for its path.
        const isMemoir = depth[i] === 0 && nm === 'Memoir' && blob.extOf(i) === '.md'
        hidden[i] = isMemoir ? 1 : 0
        if (!isMemoir) fileCount += 1
        if (cursorPath !== null && cursorNode < 0 && endsWithSeg(cursorPath, nm)) {
          if (blob.pathOf(i) === cursorPath) cursorNode = i
        }
        if (activePath !== null && activeNode < 0 && endsWithSeg(activePath, nm)) {
          if (blob.pathOf(i) === activePath) activeNode = i
        }
        if (anchorPath !== null && anchorNode < 0 && endsWithSeg(anchorPath, nm)) {
          if (blob.pathOf(i) === anchorPath) anchorNode = i
        }
        // The selection and the secret mark: this file's path, built once from
        // the folder prefix stack (it equals `blob.pathOf(i)`), then one Set
        // lookup each.  A rel no row holds falls out rather than marking one.
        if (selPaths.size > 0 || secretPaths.size > 0) {
          const d = depth[i]!
          const fp = (d ? pre[d - 1] + '/' : '') + nm + blob.extOf(i)
          if (selPaths.has(fp)) {
            seen.add(fp)
            selNodes.add(i)
          }
          if (secretPaths.has(fp)) secretNodes.add(i)
        }
      }
    }
    selPaths.clear()
    for (const p of seen) selPaths.add(p)
    if (anchorPath !== null && anchorNode < 0) anchorPath = null
    if (cursorNode < 0 && cursorPath !== null) {
      cursorPath = null
      host.onCursorMoved?.(null)
    }
    if (activePath !== null && activeNode < 0) {
      // The tree's obligation is only to stop drawing an active row — NOT to
      // clear `activePath`.  The editor still holds a buffer for it and the user
      // may `Save as…` (spec-04 §6.3, CONTRACT §7.3 case 5).
      host.onActiveVanished?.(activePath)
    }
  }

  /**
   * `path` ends with `name + ".md"` at a '/' boundary, the extension in any
   * ASCII case (`Foo.MD` is a note).  A PREFILTER only: every caller confirms
   * with `blob.pathOf(i) === path`, which carries the row's exact extension.
   * One `length` compare and one bounded character scan; no allocation, no
   * `split`, no `endsWith` on a concatenated string (which would allocate on
   * every file row).
   */
  function endsWithSeg(path: string, name: string): boolean {
    const need = name.length + 3 // ".md"
    const start = path.length - need
    if (start < 0) return false
    if (start > 0 && path.charCodeAt(start - 1) !== 47 /* '/' */) return false
    for (let k = 0; k < name.length; k++) {
      if (path.charCodeAt(start + k) !== name.charCodeAt(k)) return false
    }
    return (
      path.charCodeAt(start + name.length) === 46 /* '.' */ &&
      (path.charCodeAt(start + name.length + 1) | 32) === 109 /* 'm' or 'M' */ &&
      (path.charCodeAt(start + name.length + 2) | 32) === 100 /* 'd' or 'D' */
    )
  }

  /* ═══ paint ═════════════════════════════════════════════════════════════ */

  function paint(v: number): void {
    if (!blob) return
    const el = pool[v % poolSize]
    if (!el) return
    const n = visible[v]!
    // §5.4.2: while a rename is open the edited row's own pooled row is
    // SUPPRESSED — the `.tr.tr-edit` host is drawn in its place, and drawing
    // both would show the old name behind the field.  Keyed on the NODE, which
    // `restore()` re-resolves from `editPath` across a snapshot.  The early
    // return happens before any write, so every `__` cache stays consistent
    // with what is on screen.
    if (n === editNode) {
      if (!el.__h) {
        el.hidden = true
        el.__h = true
      }
      return
    }
    const y = yOf(v)
    const d = blob.depth[n]!
    if (el.__n !== n) {
      el.__t.data = blob.nameOf(n)
      el.__n = n
    }
    if (el.__y !== y) {
      el.style.transform = 'translateY(' + y + 'px)'
      el.__y = y
    }
    // §0.44 E90 — THE REVEAL.  A row inside the band shows only the part of the
    // band that has opened; `clip-path` rather than a height, because the row IS
    // its own box here and there is no wrapper to shrink (Obsidian clips with
    // `overflow-y: clip` on the `.nav-folder-children` Cairn does not have).
    //
    // Exactly ONE row straddles the edge on any frame — the rows above it are
    // whole and the rows below it are clipped away entirely — so this is two
    // style writes per frame however many notes the folder holds.
    let clip = ''
    if (anim !== null && v >= anim.from && v <= anim.to) {
      const cut = Math.min(rowH, Math.max(0, y + rowH - (anim.top + anim.delta - anim.shift)))
      if (cut > 0) clip = 'inset(0 0 ' + cut + 'px 0)'
    }
    if (el.__c !== clip) {
      el.style.clipPath = clip
      el.__c = clip
    }
    if (el.__d !== d) {
      el.style.setProperty('--d', String(d))
      // The probe reads `data-d` first and only falls back to the custom
      // property, so both are written (tools/verify-geometry.js `depthOf`).
      el.setAttribute('data-d', String(d))
      el.setAttribute('aria-level', String(d + 1))
      el.__d = d
    }
    const isD = (blob.kind[n]! & 1) !== 0
    // M61 SAID "keyed off subtree[n] > 0, never off kind alone", i.e. an empty
    // folder drew no chevron. THAT IS OVERTURNED BY MEASUREMENT of the
    // reference app, and the measurement is not ambiguous: Obsidian 1.13.7's
    // folder tree item is constructed
    //     n.setClickable(!0), n.setCollapsible(!0), n.selfEl.addClass("mod-folder")
    // (obsidian-1.13.7.asar, app.js). `setCollapsible(true)` is unconditional
    // and is what creates the `.collapse-icon` element, so EVERY folder draws
    // a chevron whether or not it has children. Keyed off `kind` alone now.
    const chev = isD ? CHEV : 0
    // User ruling, 2026-09-14 [C]: with exactly one note in the vault the open
    // row draws no active fill (see `fileCount`). Counted on FILES, not visible
    // rows, so folding a folder cannot make the highlight blink in and out.
    // The shift-selection fill is independent of it: an explicitly selected
    // row draws `.s` even in a one-note vault.
    //
    // User ruling, 2026-09-15 [C]: while a shift-selection is LIVE, no row
    // draws the active fill at all — not even the open note.  The selection
    // is the one highlight system on screen; a grey box intruding on (or
    // beside) the purple range reads as a second, conflicting answer.  Gated
    // on the model (`selPaths`), not the paint (`selNodes`), so a selection
    // hidden inside a collapsed folder still suppresses.
    const active = n === activeNode && fileCount !== 1 && selPaths.size === 0 ? ACTIVE : 0
    const m =
      chev |
      (chev && (ui[n]! & 1) !== 0 ? OPEN : 0) |
      active |
      (n === cursorNode ? CURSOR : 0) |
      (selNodes.has(n) ? SEL : 0) |
      (dragNodes.has(n) ? DRAG : 0) |
      (n === dropNode ? DROP : 0) |
      (secretNodes.has(n) ? SECRET : 0)
    if (el.__m !== m) {
      el.className = CLS[m]!
      // An empty folder is still a treeitem and still toggles; it simply has
      // nothing to show and no chevron.  `aria-expanded` is written for it,
      // because it is still a folder.
      if (isD) el.setAttribute('aria-expanded', (m & OPEN) !== 0 ? 'true' : 'false')
      else el.removeAttribute('aria-expanded')
      el.setAttribute('aria-selected', (m & (ACTIVE | SEL)) !== 0 ? 'true' : 'false')
      el.__m = m
    }
    if (el.__h) {
      el.hidden = false
      el.__h = false
    }
  }

  function repaintRange(a: number, b: number): void {
    for (let v = a; v <= b; v++) paint(v)
  }

  function hideUnused(first: number, last: number): void {
    // Slots outside [first,last] hold rows whose `translateY` belongs to another
    // scroll position.  They are always outside the clip (the range is contiguous
    // and never longer than the pool), but hiding them makes that a property of
    // the code rather than of an argument, and the write only happens on change.
    //
    // O(span + poolSize), NOT O(span x poolSize): `slotUsed` is a scratch buffer
    // allocated once in ensurePool(), so this costs no allocation on a scroll
    // frame (§5.12.6(c)) and stays flat as the pool grows on a 4K-tall display.
    const span = last - first + 1
    if (span >= poolSize) return
    slotUsed.fill(0)
    for (let v = first; v <= last; v++) slotUsed[v % poolSize] = 1
    for (let s = 0; s < poolSize; s++) {
      if (slotUsed[s] === 1) continue
      const el = pool[s]!
      if (!el.__h) {
        el.hidden = true
        el.__h = true
      }
    }
  }

  /**
   * §5.12.6.  ONE DOM READ — `scrollTop` — and nothing else.  No allocation, no
   * layout-forcing read, no row creation.
   */
  function onScroll(): void {
    if (!blob || poolSize === 0) return
    const st = scroller.scrollTop // the ONE DOM read on a scroll frame
    // §0.34 E80 — INTO SIZER COORDINATES FIRST.  `scrollTop` counts from the
    // padding box and the rows start `padTop` below it.  `padTop` is a cached
    // number, so this stays the one DOM read §5.12.6 requires.
    const sy = st - padTop
    let first = Math.max(0, ((sy / rowH) | 0) - OVERSCAN)
    let last = Math.min(visibleCount - 1, (((sy + clientH) / rowH) | 0) + OVERSCAN)
    if (last - first + 1 > poolSize) last = first + poolSize - 1
    if (last < first) {
      // An empty tree: nothing to paint, everything to hide.
      for (let s = 0; s < poolSize; s++) {
        const el = pool[s]!
        if (!el.__h) {
          el.hidden = true
          el.__h = true
        }
      }
      curFirst = 0
      curLast = -1
      schedulePersistScroll(st)
      return
    }
    if (first === curFirst && last === curLast) {
      schedulePersistScroll(st)
      return
    }
    if (first > curLast || last < curFirst) {
      repaintRange(first, last) // jumped: repaint everything
    } else {
      if (first < curFirst) repaintRange(first, curFirst - 1)
      if (last > curLast) repaintRange(curLast + 1, last)
    }
    hideUnused(first, last)
    curFirst = first
    curLast = last
    schedulePersistScroll(st)
  }

  /** A full repaint of the current band — used after every model change. */
  function repaintAll(): void {
    curFirst = 0
    curLast = -1
    onScroll()
  }

  /* ═══ persistence ═══════════════════════════════════════════════════════ */

  /**
   * §5.12.6(c)/(d).  The callback is created ONCE, at mount, and the value it
   * will report is handed to it through `pendingScrollTop` — because this runs
   * on EVERY scroll event, including every frame of a trackpad momentum tail,
   * and a fresh closure per frame is a per-frame heap allocation on exactly the
   * path the ruling says must not allocate.  The debounce semantics are
   * unchanged: the timer is still re-armed on every event and still reports the
   * LAST scrollTop, 1,000 ms after scrolling stops (§7.6).
   */
  let pendingScrollTop = 0
  const firePersistScroll = (): void => {
    scrollTimer = null
    host.onScrollTopChanged?.(pendingScrollTop)
  }

  function schedulePersistScroll(st: number): void {
    if (!host.onScrollTopChanged) return
    pendingScrollTop = st
    if (scrollTimer !== null) clearTimeout(scrollTimer)
    scrollTimer = setTimeout(firePersistScroll, PERSIST_DEBOUNCE_MS)
  }

  function schedulePersistExpanded(): void {
    if (!host.onExpandedChanged) return
    if (expandedTimer !== null) clearTimeout(expandedTimer)
    expandedTimer = setTimeout(() => {
      expandedTimer = null
      host.onExpandedChanged?.(expandedSnapshot())
    }, PERSIST_DEBOUNCE_MS)
  }

  /** Fire whichever persist timers are pending, now, through the same host
   *  callbacks — so the values land in state.ts's queue before a vault switch
   *  or a quit flushes it, and are filed under the vault they describe. */
  function flushPersist(): void {
    if (expandedTimer !== null) {
      clearTimeout(expandedTimer)
      expandedTimer = null
      host.onExpandedChanged?.(expandedSnapshot())
    }
    if (scrollTimer !== null) {
      clearTimeout(scrollTimer)
      firePersistScroll()
    }
  }

  /** Drop pending persist timers without firing them: what they would report
   *  describes a vault that is being closed. */
  function cancelPersist(): void {
    if (expandedTimer !== null) clearTimeout(expandedTimer)
    if (scrollTimer !== null) clearTimeout(scrollTimer)
    expandedTimer = null
    scrollTimer = null
  }

  function expandedSnapshot(): string[] {
    const out: string[] = []
    for (const p of expandedPaths) {
      if (out.length >= EXPANDED_CAP) break // §7.6: silently truncated
      out.push(p)
    }
    return out
  }

  /* ═══ expansion ═════════════════════════════════════════════════════════ */

  /**
   * How many visible rows node `i`'s subtree occupies, with the folder itself at
   * visible index `v` in the `visible` array AS IT STANDS.  0 for a folder that
   * is closed, empty, or whose children are all collapsed away.
   *
   * The rows are contiguous because `flatten()` emits them in node order, so
   * this is a walk to the first index outside the subtree and not a search.
   */
  function visibleSpanOf(i: number, v: number): number {
    if (!blob) return 0
    const end = i + blob.subtree[i]!
    let n = 0
    while (v + 1 + n < visibleCount && visible[v + 1 + n]! <= end) n++
    return n
  }

  /**
   * §0.44 E90 — open or close a folder, optionally on Obsidian's 100ms curve.
   *
   * `animate` DEFAULTS TO FALSE, so every existing caller keeps the instant
   * behaviour it was written against — `reserveRowHost()` opens a collapsed
   * folder to put a create row inside it, and animating that would delay the
   * field the user is about to type into.  The two deliberate toggles (a click
   * on the row, and the keyboard's Right/Left) come through `toggle()`, which
   * opts in.
   */
  function setOpen(i: number, open: boolean, animate = false): void {
    if (!blob || (blob.kind[i]! & 1) === 0) return
    // A second click lands on a SETTLED tree, never on a half-open one: the
    // in-flight fold is committed at its end state first.  This is Obsidian's
    // `folding` WeakMap rule (`properties.ts` ports the same one), and without
    // it two fast clicks leave a band clipped at whatever the first frame of the
    // second fold happened to compute.
    finishAnim()
    const p = blob.pathOf(i)
    if (open) {
      ui[i] = 1
      expandedPaths.add(p)
    } else {
      ui[i] = 0
      expandedPaths.delete(p)
    }
    schedulePersistExpanded()

    // `v` is read BEFORE any re-flatten, and it survives one: the folder's own
    // row cannot move, because everything that changes is below it.
    const v = visibleIndexOfNode(i)
    const canAnimate =
      animate &&
      v >= 0 &&
      rowH > 0 &&
      // An inline editor is keyed on a visible index and a fold moves those for
      // 100ms.  Refused rather than solved: the reachable case is a watcher
      // refresh during a rename, and a rename that flickers is worse than a
      // fold that does not animate.
      editAt === NO_EDIT &&
      editHost === null &&
      typeof requestAnimationFrame === 'function' &&
      typeof cancelAnimationFrame === 'function'

    const settle = (): void => {
      // An open inline editor is keyed on a VISIBLE INDEX, and re-flattening
      // just moved every one of them.  Cheap: it returns on the first line
      // unless an editor is actually open, and this is a click, never a scroll
      // frame.
      settleEditHost()
      clampScroll()
      repaintAll()
    }

    if (!canAnimate) {
      flatten()
      settle()
      return
    }

    // THE ASYMMETRY IS OBSIDIAN'S.  Its `ev` appends the children BEFORE
    // animating and detaches them AFTER, so an open has a band to reveal from
    // the first frame and a close keeps its rows on screen to the last one.
    // Here that is: an open re-flattens now, a close re-flattens in `finish`.
    if (open) flatten()
    const m = visibleSpanOf(i, v)
    if (m === 0) {
      // Nothing to reveal — an empty folder, or one whose every child is itself
      // a collapsed folder contributing no visible row.  The arrow still turns;
      // there is simply no band, and a zero-height fold would be 100ms of
      // nothing.
      if (!open) flatten()
      settle()
      return
    }
    startFold(v, m, open, settle)
  }

  /**
   * Drive the band from closed to open (or back) over `FOLD_MS` on Obsidian's
   * own curve, and turn the arrow with it.
   *
   * Every frame moves ONE number — `anim.shift`, how much of the band is still
   * closed — and `yOf()`, `sizeSizer()` and `paint()`'s clip all read it.  There
   * is no second source of truth about where a row is mid-fold.
   */
  function startFold(v: number, m: number, open: boolean, settle: () => void): void {
    const delta = m * rowH
    anim = {
      from: v + 1,
      to: v + m,
      top: (v + 1) * rowH,
      delta,
      shift: open ? delta : 0,
      finish: () => {
        disarmChevron()
        // A close commits its model LAST — `flatten()` any earlier and the rows
        // being folded away stop being painted, which is the abrupt behaviour
        // this whole pass exists to remove.
        if (!open) flatten()
        sizeSizer()
        settle()
      },
    }
    armChevron(v)
    const t0 = nowMs()
    if (animTimer !== null) clearTimeout(animTimer)
    animTimer = setTimeout(finishAnim, FOLD_MS + 50)
    const step = (): void => {
      if (anim === null) return
      const x = Math.min(1, (nowMs() - t0) / FOLD_MS)
      anim.shift = delta * (open ? 1 - FOLD_EASE(x) : FOLD_EASE(x))
      sizeSizer()
      repaintAll()
      if (x < 1) animRaf = requestAnimationFrame(step)
      else finishAnim()
    }
    // THE FIRST FRAME IS SYNCHRONOUS, and it is not an optimisation: the band
    // has to be shut inside the same task as the click.  Left to the first rAF,
    // the tree paints its FINAL state once and then jumps back to animate from
    // it — one frame of the answer before the question.
    step()
  }

  /**
   * End the fold in flight at its end state.  Idempotent, and safe to call from
   * anywhere that is about to move the model underneath it — which is why every
   * entry point that re-flattens calls it first.
   */
  function finishAnim(): void {
    if (anim === null) return
    const done = anim.finish
    // Cleared BEFORE `done()` runs, so the `sizeSizer()` and `repaintAll()`
    // inside it produce the settled geometry rather than the last frame's.
    anim = null
    if (animRaf !== 0) {
      cancelAnimationFrame(animRaf)
      animRaf = 0
    }
    if (animTimer !== null) {
      clearTimeout(animTimer)
      animTimer = null
    }
    done()
  }

  /**
   * Let exactly ONE row's chevron animate, for the length of one fold.
   *
   * `tree.css` carries the full argument and it is worth restating here because
   * it is the reason this is not two lines of CSS: `.tr` elements are POOLED, so
   * a blanket transition on the chevron would animate every recycled row during
   * a scroll and spin arrows all over the sidebar.  The duration travels as a
   * custom property because the chevron is a `::before`, and a pseudo-element
   * has no inline style of its own — it can only inherit one from the element
   * it belongs to.
   *
   * Armed BEFORE the first `paint()`, because that paint is what flips `.o` and
   * a transition only runs when the duration is already non-zero as the
   * transform changes.
   */
  function armChevron(v: number): void {
    disarmChevron()
    const el = poolSize > 0 ? pool[v % poolSize] : undefined
    if (!el) return
    chevRow = el
    el.style.setProperty('--chev-ms', FOLD_MS + 'ms')
  }

  function disarmChevron(): void {
    if (chevRow === null) return
    chevRow.style.removeProperty('--chev-ms')
    chevRow = null
  }

  /** A deliberate toggle — a click on the row, or the keyboard. Animates. */
  function toggle(i: number, animate = true): void {
    setOpen(i, (ui[i]! & 1) === 0, animate)
  }

  function clampScroll(): void {
    const max = maxScroll()
    if (scroller.scrollTop > max) scroller.scrollTop = max
  }

  /* ═══ reveal (§3.4) ═════════════════════════════════════════════════════ */

  /** A LOCAL function, not just a controller method: `rowHost()` below needs it
   *  to un-collapse the ancestors of a row it is about to edit. */
  function revealPath(path: string): number {
    if (!blob) return -1
    finishAnim()   // §0.44 E90: never re-flatten under a fold in flight
    // §3.4: "add every ancestor of the target path to the Set, re-flatten,
    // return the visible index.  No IPC."
    let cut = path.indexOf('/')
    while (cut >= 0) {
      expandedPaths.add(path.slice(0, cut))
      cut = path.indexOf('/', cut + 1)
    }
    restore()
    flatten()
    let target = -1
    for (let i = 0; i < blob.n; i++) {
      if (blob.pathOf(i) === path) {
        target = i
        break
      }
    }
    if (target < 0) {
      repaintAll()
      return -1
    }
    schedulePersistExpanded()
    const v = visibleIndexOfNode(target)
    scrollIntoView(v, true) // an arbitrary jump: DO centre
    setCursorNode(target, false)
    settleEditHost()
    repaintAll()
    return v
  }

  /* ═══ the inline row editor (§5.4.2, §7.3 cases 4 and 11) ═══════════════ */

  /** O(n) over the blob, and deliberately so: it runs once per EDIT, never on a
   *  paint or a scroll frame, and a path->index map would be a second index
   *  space to keep in sync across every snapshot (X14's exact failure). */
  function nodeIndexOfPath(path: string): number {
    if (!blob) return -1
    for (let i = 0; i < blob.n; i++) if (blob.pathOf(i) === path) return i
    return -1
  }

  /**
   * The `.tr.tr-edit` host.  It carries the SAME two depth channels every
   * pooled row carries — `--d` for tree.css's `padding-left: 35 + 17d` and the
   * matching chevron/guide geometry, `data-d` for tools/verify-geometry.js — so
   * the field lines up with the names above and below it to the pixel.
   *
   * RESOLVED (was: "REPORTED, owner 01").  `tree.css` now carries the
   * `.tr.tr-edit` block — `display: flex; align-items: center` plus Obsidian's
   * own `is-being-renamed` ring, read out of its `app.css` — so the two inline
   * layout properties this function used to write are gone from here.  Nothing
   * about the element's identity moved: it is still a `.tr` at the row's depth,
   * and no custom property is declared here (§5.1's rule is untouched).
   *
   * `mask` IS THE POOLED ROW'S OWN STATE, out of the same `CLS` table `paint()`
   * indexes, so the row does not change appearance under the field.  Obsidian
   * puts `contenteditable` on the title element INSIDE the row and touches
   * nothing else, so everything the row was drawing keeps drawing:
   *
   *   - `d` / `o` — THE CHEVRON.  A folder under rename still shows its arrow,
   *     at its rotation.  Without this the arrow vanished for the duration of
   *     the edit and came back on commit, which is a flicker on the one row the
   *     user is looking at.  (`CHEV` is keyed off `kind` alone — see paint():
   *     M61's empty-folder exception was overturned by measurement.)
   *   - `a` — the ACTIVE fill.  `startRenameFile` never clears `is-active`, so
   *     renaming the note you are looking at does not blank its row.
   *
   * `CURSOR` is deliberately NOT passed: `.c` only paints under
   * `.tree-scroller.kbd-focus:focus`, and while the field has the focus the
   * scroller does not match `:focus` (that is the focused element, not an
   * ancestor).  Passing it would be a class that can never render.
   */
  function makeEditHost(depth: number, displayIndex: number, mask = 0): HTMLElement {
    const el = document.createElement('div') as PoolRow
    el.appendChild(chevron(document))   // §0.50 E98 — a folder under rename keeps its chevron
    applyEditMask(el, mask)
    // Never inside a fold band (a fold is refused while an editor is open), so
    // this cache only ever has to agree with the `''` the element already has.
    el.__c = ''
    // NOT a pooled row and never in `pool`: `__n = -1` is what makes the
    // delegated hit test below treat it as "no node" rather than as node
    // `undefined`.
    el.__n = -1
    el.__y = -1
    el.__d = -1
    el.__m = -1
    el.__h = false
    el.setAttribute('data-d', String(depth))
    el.style.setProperty('--d', String(depth))
    el.style.transform = 'translateY(' + displayIndex * rowH + 'px)'
    sizer.appendChild(el)
    return el
  }

  /** True for an event that happened inside the open editor.  Every delegated
   *  listener on the scroller returns early on it: without this a printable key
   *  typed into the field also drives type-ahead, and an arrow key moves the
   *  tree cursor out from under the row being renamed. */
  function inEdit(target: EventTarget | null): boolean {
    if (editHost === null || !(target instanceof Element)) return false
    return target === editHost || target.closest('.tr') === editHost
  }

  /** Called after every snapshot.  Node indices do not survive one; `editPath`
   *  does.  A rename whose row has vanished (someone deleted it externally)
   *  loses its editor rather than pointing at whatever now holds that index. */
  function settleEditHost(): void {
    if (editHost === null) return
    if (editPath === null) {
      // A create: the reserved row is keyed on a display index, which a
      // snapshot invalidates.  Rather than guess where it moved, keep it in
      // bounds — the field and everything typed into it survive.
      if (editAt > visibleCount) editAt = visibleCount
      editHost.style.transform = 'translateY(' + editAt * rowH + 'px)'
      return
    }
    const i = nodeIndexOfPath(editPath)
    if (i < 0) {
      releaseRowHost()
      return
    }
    editNode = i
    const v = visibleIndexOfNode(i)
    if (v < 0) {
      releaseRowHost()
      return
    }
    editHost.style.transform = 'translateY(' + yOf(v) + 'px)'
    // …and RE-APPLY the row's state, for the same reason the transform is
    // re-applied: the host stands in for a row whose state can move under it.
    // A snapshot that closes the folder being renamed is the reachable case —
    // a host that kept its `o` would draw an open chevron over a closed folder.
    applyEditMask(editHost, maskOf(i))
  }

  /** The `CLS` bits a pooled row would carry for node `i`, minus `CURSOR` —
   *  `makeEditHost` says why the cursor bit is left out. Carries the same
   *  single-note suppression AND the same live-selection suppression as
   *  `paint()`, so the rename host and the row it stands in for cannot
   *  disagree about the fill. */
  function maskOf(i: number): number {
    if (!blob) return 0
    const isD = (blob.kind[i]! & 1) !== 0
    return (
      (isD ? CHEV : 0) | (isD && (ui[i]! & 1) !== 0 ? OPEN : 0) | (i === activeNode && fileCount !== 1 && selPaths.size === 0 ? ACTIVE : 0) | (selNodes.has(i) ? SEL : 0)
    )
  }

  /** The className and the one ARIA attribute that go with it, in one place, so
   *  the open/close state cannot be right in the class and stale in the tree
   *  role — `paint()` writes the pair together for exactly the same reason. */
  function applyEditMask(el: HTMLElement, mask: number): void {
    el.className = CLS[mask]! + ' tr-edit'
    if ((mask & CHEV) !== 0) {
      el.setAttribute('aria-expanded', (mask & OPEN) !== 0 ? 'true' : 'false')
    } else {
      el.removeAttribute('aria-expanded')
    }
  }

  function rowHost(path: string): HTMLElement | null {
    if (!blob) return null
    releaseRowHost()
    let i = nodeIndexOfPath(path)
    if (i < 0) return null
    if (visibleIndexOfNode(i) < 0) {
      // Collapsed under one of its ancestors: §3.4's reveal is three lines and
      // it is already written, so use it rather than a second copy.
      revealPath(path)
      i = nodeIndexOfPath(path)
      if (i < 0) return null
    }
    const v = visibleIndexOfNode(i)
    if (v < 0) return null
    editPath = path
    editNode = i
    editHost = makeEditHost(blob.depth[i]!, v, maskOf(i))
    scrollIntoView(v, false)
    // Re-place after the scroll: `scrollIntoView` does not move rows (they are
    // absolutely positioned inside `.sz`), so the transform above is still
    // right — this is belt and braces against a future change that does.
    editHost.style.transform = 'translateY(' + yOf(v) + 'px)'
    repaintAll()
    return editHost
  }

  function reserveRowHost(parent: string): HTMLElement | null {
    if (!blob) return null
    releaseRowHost()
    let at = 0
    let d = 0
    if (parent !== '') {
      const i = nodeIndexOfPath(parent)
      if (i < 0 || (blob.kind[i]! & 1) === 0) return null
      // "New note INSIDE a folder row" — a collapsed folder is opened first, or
      // the reserved row would be the only visible thing inside it.
      if ((ui[i]! & 1) === 0) setOpen(i, true)
      const v = visibleIndexOfNode(i)
      if (v < 0) return null
      at = v + 1
      d = blob.depth[i]! + 1
    }
    editAt = at
    // MASK 0 — NO CHEVRON, and that is a ruling rather than an omission.  A
    // reserved row stands for an entry that DOES NOT EXIST YET (`beginCreate`
    // creates on commit), so an arrow on it would be a control that toggles
    // nothing: §9 E4's "no inert decoration".  Obsidian differs here because
    // its flow differs — `createAbstractFile` makes the folder on disk FIRST
    // and then renames the real row, so its arrow is a real one.  Aligning the
    // two means moving the create, not drawing an arrow; REPORTED, not done.
    editHost = makeEditHost(d, at)
    sizeSizer()
    // Bring the reserved row on screen WITHOUT centring: the parent folder row
    // directly above it is the context that says where the note is going.
    // §0.34 E80 — `top` is a SIZER coordinate; `scrollTop` is a scroll one, so
    // the two are compared in the same space by adding `padTop` once.
    const top = padTop + at * rowH
    if (top < scroller.scrollTop) scroller.scrollTop = top
    else if (top + rowH > scroller.scrollTop + clientH) {
      scroller.scrollTop = top + rowH - clientH
    }
    repaintAll()
    return editHost
  }

  function releaseRowHost(): void {
    if (editHost === null && editHandle === null) return
    const h = editHandle
    editHandle = null
    if (h && !h.closed) h.destroy()
    if (editHost) editHost.remove()
    editHost = null
    editNode = -1
    editPath = null
    editAt = NO_EDIT
    if (blob) {
      sizeSizer()
      clampScroll()
      repaintAll()
    }
  }

  /** `openInlineRow` on a host this file positioned, with release wired to both
   *  exits.  `{ok:false}` does NOT release — §7.3 case 11's "the editor stays
   *  open with the message inline; nothing is silently accepted-then-rejected". */
  function openOn(host: HTMLElement, opts: NameEditorOptions): NameEditorHandle {
    const h = openInlineRow(host, {
      ...opts,
      onCommit: async (name: string) => {
        const out = await opts.onCommit(name)
        if (out.ok) releaseRowHost()
        return out
      },
      onCancel: () => {
        releaseRowHost()
        opts.onCancel?.()
      },
    })
    editHandle = h
    return h
  }

  /* ═══ cursor ════════════════════════════════════════════════════════════ */

  function visibleIndexOfNode(n: number): number {
    for (let v = 0; v < visibleCount; v++) if (visible[v] === n) return v
    return -1
  }

  /**
   * `atV` is the caller's already-known visible index, which is how the keyboard
   * path avoids re-scanning `visible` — `visibleIndexOfNode` is O(visibleCount)
   * and at the 50,000-node cap an arrow key would otherwise pay for three linear
   * scans it already had the answer to.  It is never on a scroll frame.
   */
  function setCursorNode(n: number, scrollIn: boolean, centre = false, atV = -1): void {
    if (n === cursorNode) return
    const prev = cursorNode
    cursorNode = n
    cursorPath = n >= 0 && blob ? blob.pathOf(n) : null
    if (prev >= 0) repaintNode(prev)
    if (n >= 0) {
      if (atV >= 0) {
        if (atV >= curFirst && atV <= curLast) paint(atV)
      } else {
        repaintNode(n)
      }
    }
    host.onCursorMoved?.(cursorPath)
    if (scrollIn && n >= 0) scrollIntoView(atV >= 0 ? atV : visibleIndexOfNode(n), centre)
  }

  function repaintNode(n: number): void {
    const v = visibleIndexOfNode(n)
    if (v >= curFirst && v <= curLast) paint(v)
  }

  /**
   * spec-04 §12.1.  Never centre on a single-step move — it makes arrow-key
   * navigation feel like the list is sliding under a fixed cursor.  DO centre on
   * an arbitrary jump (`revealPath`, a create).
   */
  function scrollIntoView(v: number, centre: boolean): void {
    if (v < 0) return
    const top = yOf(v)
    if (centre) {
      scroller.scrollTop = Math.max(0, Math.round(top - (clientH - rowH) / 2))
      return
    }
    if (top < scroller.scrollTop) scroller.scrollTop = top
    else if (top + rowH > scroller.scrollTop + clientH) scroller.scrollTop = top + rowH - clientH
  }

  function moveCursorTo(v: number): void {
    if (v < 0 || v >= visibleCount) return
    setCursorNode(visible[v]!, true, false, v)
  }

  function cursorVisibleIndex(): number {
    return cursorNode >= 0 ? visibleIndexOfNode(cursorNode) : -1
  }

  /* ═══ listeners — three, delegated, never per row (spec-04 §6.1) ════════ */

  function nodeAt(ev: Event): number {
    const t = ev.target
    if (!(t instanceof Element)) return -1
    const el = t.closest('.tr') as PoolRow | null
    if (!el || el.hidden) return -1
    // `.tr.tr-edit` is a `.tr` that is NOT a pooled row.  It is born with
    // `__n = -1`, and the `typeof` guard is what keeps a future non-pooled `.tr`
    // from reading `undefined` here and being treated as node NaN.
    return typeof el.__n === 'number' ? el.__n : -1
  }

  function onClick(ev: MouseEvent): void {
    if (!blob) return
    if (inEdit(ev.target)) return // a click in the field is not a click on a row
    const n = nodeAt(ev)
    // Shift-click is selection ONLY — no cursor move, no open, no toggle.  A
    // folder reached this way does NOT fold, or the range being drawn would
    // collapse under it (Obsidian's shift branch returns before all three).
    if (ev.shiftKey === true) {
      if (n < 0) {
        setCursorNode(-1, false)
        clearSelection()
      } else {
        shiftSelect(n)
      }
      return
    }
    // A plain click clears Obsidian's `has-focus` wherever it lands, a row or
    // empty space (see `setKbdFocus`); the shift branch above returns before it.
    setKbdFocus(false)
    if (n < 0) {
      // Empty space below the last row: clear the cursor AND the selection,
      // keep the active note.
      setCursorNode(-1, false)
      clearSelection()
      return
    }
    setCursorNode(n, false)
    if (host.isFrozen?.()) return // §7.3 case 8: frozen — cursor only
    if ((blob.kind[n]! & 1) !== 0) {
      // The chevron is deliberately NOT a separate hit target: the whole folder
      // row toggles, which is what lets the chevron be a pseudo-element and the
      // row be one node.
      //
      // A folder click selects nothing but DOES move the anchor there —
      // measured live: click P, shift-click Misc selects P..Misc.
      clearSelection()
      setAnchor(blob.pathOf(n))
      toggle(n)
    } else {
      // Clicking the already-open file moves the cursor and nothing else: the
      // anchor and any live selection survive it (Obsidian's is-active branch
      // returns before the clear).
      if (blob.pathOf(n) !== activePath) {
        clearSelection()
        setAnchor(blob.pathOf(n))
      }
      activateFile(n)
    }
  }

  /** Plain-click anchor.  Folders included: a folder is a valid range end. */
  function setAnchor(path: string): void {
    anchorPath = path
    anchorNode = nodeIndexOfPath(path)
  }

  /**
   * The shift-click half of `handleItemSelection`, transcribed.  With an
   * anchor, the selection becomes the visible rows from anchor to clicked,
   * inclusive — folders count as their one visible row, and nothing opens or
   * toggles.  With no anchor (nothing plain-clicked yet — e.g. the note was
   * opened from a restore, or the last click hit the already-open file), just
   * the clicked row is selected and the anchor stays unset.
   */
  function shiftSelect(n: number): void {
    if (!blob) return
    selPaths.clear()
    selNodes.clear()
    if (anchorNode >= 0) {
      const va = visibleIndexOfNode(anchorNode)
      const ve = visibleIndexOfNode(n)
      if (va >= 0 && ve >= 0) {
        const lo = Math.min(va, ve)
        const hi = Math.max(va, ve)
        for (let v = lo; v <= hi; v++) {
          const k = visible[v]!
          selPaths.add(blob.pathOf(k))
          selNodes.add(k)
        }
        repaintAll()
        return
      }
    }
    const p = blob.pathOf(n)
    selPaths.add(p)
    selNodes.add(n)
    repaintAll()
  }

  /** Empty the selection; the anchor is independent and survives. */
  function clearSelection(): void {
    if (selPaths.size === 0 && selNodes.size === 0) return
    selPaths.clear()
    selNodes.clear()
    repaintAll()
  }

  /* ═══ drag-to-move (Obsidian's file-explorer drop, transcribed) ═══════════
   * app.js `dragFiles` + `attachDropHandler` + `SA` + `xA` + `MA`, measured
   * against 1.13.7 (`/tmp/obsidian-app.js`, 2026-09-16). Four facts:
   *
   * - SOURCES: a drag of a row inside the shift-selection drags the WHOLE
   *   selection (`dragFiles`: `selectedDoms.has(t)`); otherwise the single row.
   *   A folder swallows its selected descendants (`xA`), so dragging a folder
   *   with its child selected moves one entry, not two.
   * - TARGETS: folders and the vault root only. A file row is not a target —
   *   but in Obsidian's NESTED DOM a dragover on a file bubbles to its parent
   *   folder's handler, so dropping "onto a file" lands in its parent. Cairn's
   *   rows are FLAT (pooled `.tr` in `.sz`), so there is no parent block to
   *   bubble to: a file row resolves to its PARENT folder and highlights ITSELF
   *   as the proxy. The EFFECT is identical (move into the parent); the INK is
   *   under the cursor rather than on a distant folder row, which is the one
   *   deliberate adaptation this flat list requires.
   * - VALIDITY (SA): `dragged !== target && !(dragged is a folder AND target
   *   starts with dragged+"/")`. Plus Cairn's already-there no-op (Obsidian's
   *   `l.parent===e`): a drop that would not move anything highlights nothing.
   * - HOVER: 750ms over a collapsed folder expands it (`mouseoverExpandTimeout`);
   *   the drop runs `renameFile` per entry with `getAvailablePath`
   *   uniquification (command 24 carries that half); the ghost reads
   *   `Move into “X”` (i18n `dragAndDrop.moveIntoFolder`) and follows at +5,+5
   *   with the native image hidden (Obsidian's `NO(e)`: `setDragImage` on the
   *   1x1 transparent GIF `LO` — a 0x0 node is ignored and the default feedback
   *   flies to the cursor instead).
   *
   * Pure helpers (`dropTargetFor`, `isValidDrop`, `filterTopLevel`) are exported
   * on `debug` for unit tests; the event handlers below are thin. */

  /** Parent of `path`: `a/b.md` -> `a`, `a.md` -> `''` (vault root). */
  function parentOfPath(path: string): string {
    const cut = path.lastIndexOf('/')
    return cut < 0 ? '' : path.slice(0, cut)
  }

  /** Display name for the ghost/action: files strip `.md`, folders do not. */
  function shortNameOf(path: string, isDir: boolean): string {
    const base = path.slice(path.lastIndexOf('/') + 1)
    if (!isDir && base.toLowerCase().endsWith('.md')) return base.slice(0, -3)
    return base
  }

  /** Obsidian's `xA`: drop entries that are descendants of another dragged
   *  folder — moving the folder moves them. Order-preserving, blob-order input.
   *  Each entry's '/'-bounded ancestors are looked up in a Set of the dragged
   *  folders, so a selection of k rows costs O(k · depth), not O(k²). */
  function filterTopLevel(entries: { path: string; isDir: boolean }[]): { path: string; isDir: boolean }[] {
    const dirs = new Set<string>()
    for (const e of entries) if (e.isDir) dirs.add(e.path)
    return entries.filter((e) => {
      if (dirs.size === 0) return true
      const p = e.path
      for (let cut = p.lastIndexOf('/'); cut > 0; cut = p.lastIndexOf('/', cut - 1)) {
        if (dirs.has(p.slice(0, cut))) return false
      }
      return true
    })
  }

  /** Where a drop on node `n` would land: the folder itself, or the parent of
   *  a file (`''` = vault root). -1 (empty space) is always the root. */
  function dropTargetFor(n: number): string | null {
    if (!blob) return null
    if (n < 0) return ''
    const isDir = (blob.kind[n]! & 1) !== 0
    const p = blob.pathOf(n)
    return isDir ? p : parentOfPath(p)
  }

  /** SA + already-there, over the RESOLVED entries (not the raw event):
   *  every source must be droppable into `target`, and at least one must
   *  actually move (Obsidian highlights nothing for a no-op hover). */
  function isValidDrop(sources: { path: string; isDir: boolean }[], target: string | null): boolean {
    if (target === null) return false
    let moves = false
    for (const s of sources) {
      if (s.path === target) return false // onto itself
      if (s.isDir && (target === s.path || target.startsWith(s.path + '/'))) return false // SA: into self/descendant
      if (parentOfPath(s.path) !== target) moves = true
    }
    return moves
  }

  /** Blob-order selection entries — the inner half of the controller's
   *  `getSelection()` (which is defined below and not in scope here). */
  function selectionEntries(): { path: string; isDir: boolean }[] {
    if (!blob || selPaths.size === 0) return []
    const out: { path: string; isDir: boolean }[] = []
    for (let i = 0; i < blob.n; i++) {
      const p = blob.pathOf(i)
      if (selPaths.has(p)) out.push({ path: p, isDir: (blob.kind[i]! & 1) !== 0 })
    }
    return out
  }

  /** The drag set for a `dragstart` on node `n`: the whole shift-selection
   *  when `n` is in it (Obsidian's `dragFiles`), else the single row —
   *  filtered to top-level (`xA`), in blob order. */
  function dragSetFor(n: number): { path: string; isDir: boolean }[] {
    if (!blob) return []
    const p = blob.pathOf(n)
    const isDir = (blob.kind[n]! & 1) !== 0
    let entries: { path: string; isDir: boolean }[]
    if (selPaths.has(p)) {
      entries = selectionEntries()
    } else {
      entries = [{ path: p, isDir }]
    }
    return filterTopLevel(entries)
  }

  function dragTitleFor(entries: { path: string; isDir: boolean }[]): string {
    if (entries.length === 1) {
      const e = entries[0]!
      return shortNameOf(e.path, e.isDir)
    }
    let files = 0
    let folders = 0
    for (const e of entries) {
      if (e.isDir) folders++
      else files++
    }
    // Obsidian's `dragFiles` strings, transcribed: "N files", "N folders",
    // "N files and M folders" (singular untested — English i18n has no
    // singular branch in the bundle; the plural reads "1 files").
    if (files > 0 && folders > 0) return files + ' files and ' + folders + ' folders'
    if (folders > 0) return folders + ' folders'
    return files + ' files'
  }

  function dropLabelFor(target: string): string {
    if (target === '') return host.getVaultName?.() ?? 'vault'
    const cut = target.lastIndexOf('/')
    return cut < 0 ? target : target.slice(cut + 1)
  }

  /** Remove the ghost, the timer and both highlight bits. Idempotent. */
  function clearDrag(): void {
    if (dropTimer !== null) {
      clearTimeout(dropTimer)
      dropTimer = null
    }
    const had = dragPaths.size > 0 || dropNode !== -2 || dragGhost !== null
    dragPaths.clear()
    dragNodes.clear()
    // Reassigned, never mutated: `onDrop` hands the old array to the host.
    dragLive = []
    dropNode = -2
    dropParent = null
    if (dragGhost !== null) {
      dragGhost.remove()
      dragGhost = null
      dragActionEl = null
    }
    if (typeof document !== 'undefined' && document.body) {
      document.body.classList.remove('is-grabbing')
    }
    if (had && blob) repaintAll()
  }

  function moveGhostTo(clientX: number, clientY: number): void {
    if (!dragGhost) return
    // Obsidian's `onDragOver`: `t+=5,n+=5` — the ghost trails the cursor.
    dragGhost.style.left = clientX + 5 + 'px'
    dragGhost.style.top = clientY + 5 + 'px'
  }

  function setDropHighlight(node: number, target: string | null): void {
    if (node === dropNode && target === dropParent) return
    // A collapsed folder that was scheduled to expand is no longer hovered:
    // cancel its timer (Obsidian clears `mouseoverExpandTimeout` on leave).
    if (dropTimer !== null && (node !== dropNode || target !== dropParent)) {
      clearTimeout(dropTimer)
      dropTimer = null
    }
    dropNode = node
    dropParent = target
    if (dragActionEl) {
      // `Move into “X”` — i18n `dragAndDrop.moveIntoFolder`, transcribed with
      // its smart quotes. Empty while invalid so the ghost shows the title alone.
      dragActionEl.textContent = target !== null ? 'Move into \u201c' + dropLabelFor(target) + '\u201d' : ''
    }
    // Auto-expand: 750ms over a collapsed folder opens it (Obsidian's
    // `mouseoverExpandTimeout` -> `setCollapsed(!1)`). Armed only for folder
    // ROWS (node >= 0 and is a folder); empty-space/root has nothing to open.
    if (node >= 0 && target !== null && blob && (blob.kind[node]! & 1) !== 0 && (ui[node]! & 1) === 0) {
      if (dropTimer !== null) clearTimeout(dropTimer)
      const expandNode = node
      dropTimer = setTimeout(() => {
        dropTimer = null
        if (dropNode !== expandNode || !blob) return
        // Still collapsed and still hovered: open without animation (a fold
        // mid-drag would move every row under the cursor).
        if ((ui[expandNode]! & 1) === 0) setOpen(expandNode, true)
      }, DROP_EXPAND_MS)
    }
    if (blob) repaintAll()
  }

  function onDragStart(ev: DragEvent): void {
    if (!blob) return
    if (inEdit(ev.target)) return
    if (host.isFrozen?.()) {
      ev.preventDefault()
      return
    }
    const n = nodeAt(ev as unknown as Event)
    if (n < 0) {
      ev.preventDefault()
      return
    }
    const entries = dragSetFor(n)
    if (entries.length === 0) {
      ev.preventDefault()
      return
    }
    // The drag is live from here: record path-keyed truth + derived nodes.
    dragPaths.clear()
    dragNodes.clear()
    for (const e of entries) {
      dragPaths.add(e.path)
    }
    dragLive = entries
    // Resolve nodes by path (indices do not survive snapshots; the drag is
    // seconds long and a watcher refresh mid-drag clears it in applySnapshot).
    for (let i = 0; i < blob.n; i++) {
      if (dragPaths.has(blob.pathOf(i))) dragNodes.add(i)
    }
    dropNode = -2
    dropParent = null
    const dt = ev.dataTransfer
    if (dt) {
      dt.effectAllowed = 'all'
      try {
        // `text/plain` is required: without any `setData` a drag never starts
        // in Chromium. Obsidian writes its `obsidian://` URL + `text/uri-list`;
        // Cairn writes the vault-relative paths — the drop handler reads the
        // module state, not the payload, so this is the affordance, not the channel.
        dt.setData('text/plain', entries.map((e) => e.path).join('\n'))
      } catch {}
      try {
        // F82: the private tag the editor and the Memoir page refuse. A row
        // dropped on the note or the journal used to paste raw vault paths as
        // text and autosave them; now those surfaces see this type and take
        // nothing.
        dt.setData('application/x-cairn-paths', entries.map((e) => e.path).join('\n'))
      } catch {}
      try {
        // `NO(e)`, transcribed (app.js `LO` + `NO`, 1.13.7): the native image
        // is a 1x1 transparent GIF, so the custom ghost is the only thing
        // under the cursor. A 0x0 node has NO AREA and Chromium IGNORES it —
        // `setDragImage` falls back to the default feedback, a snapshot of the
        // source row flying to the cursor (the reported globe). An `img` with
        // intrinsic 1x1 size is honoured. Reused across drags like Obsidian's
        // `LO`, so it is decoded long before the drag that needs it.
        const doc = scroller.ownerDocument ?? document
        if (!dragBlank) {
          dragBlank = doc.createElement('img')
          dragBlank.setAttribute('src', 'data:image/gif;base64,R0lGODlhAQABAIAAAAUEBAAAACwAAAAAAQABAAACAkQBADs=')
          dragBlank.setAttribute('style', 'position:fixed;top:0;left:0;pointer-events:none;')
        }
        doc.body.appendChild(dragBlank)
        dt.setDragImage(dragBlank, 0, 0)
        const blank = dragBlank
        setTimeout(() => blank.remove(), 0)
      } catch {}
    }
    // The ghost: `.drag-ghost` + `.drag-ghost-self` (icon + title) +
    // `.drag-ghost-action` (the `Move into “X”` line, filled on hover).
    // Transcribed from app.css (dark `rgba(0,0,0,.85)`, white text, 300px cap)
    // and app.js (`drag-ghost-self` + `Ag(icon)` + title, `drag-ghost-action`).
    // Icons are Obsidian's own per-kind strings: `lucide-file` for one note,
    // `lucide-folder-open` for one folder, `lucide-files` for many.
    // Ghost icons, as literal `dataset` writes so the glyph-host test
    // (chrome-ui.test.mjs, §9 E4) greps them: `dataset['icon'] = 'file'` etc.
    // Obsidian's own per-kind strings (`dragFile` -> `lucide-file`,
    // `dragFolder` -> `lucide-folder-open`, `dragFiles` -> `lucide-files`).
    function paintGhostIcon(host: HTMLElement, entries: { path: string; isDir: boolean }[]): void {
      if (entries.length === 1 && !entries[0]!.isDir) host.dataset['icon'] = 'file'
      else if (entries.length === 1) host.dataset['icon'] = 'folder-open'
      else host.dataset['icon'] = 'files'
    }
    try {
      const doc = scroller.ownerDocument ?? document
      const ghost = doc.createElement('div')
      ghost.className = 'drag-ghost'
      const self = doc.createElement('div')
      self.className = 'drag-ghost-self'
      const ico = doc.createElement('span')
      ico.className = 'drag-ghost-icon'
      paintGhostIcon(ico, entries)
      self.appendChild(ico)
      const label = doc.createElement('span')
      label.textContent = dragTitleFor(entries)
      self.appendChild(label)
      ghost.appendChild(self)
      const action = doc.createElement('div')
      action.className = 'drag-ghost-action'
      ghost.appendChild(action)
      dragActionEl = action
      // §6.1: icons.ts is the only file that may write markup — paint through
      // its pass, never innerHTML here. Unconditional: a host without a name
      // is left alone by `paintIcons` anyway (see menu.ts's own note).
      try {
        paintIcons(ghost)
      } catch {}
      doc.body.appendChild(ghost)
      dragGhost = ghost
      const cx = (ev as MouseEvent).clientX ?? 0
      const cy = (ev as MouseEvent).clientY ?? 0
      moveGhostTo(cx, cy)
      doc.body.classList.add('is-grabbing')
    } catch {}
    repaintAll()
  }

  function onDragOver(ev: DragEvent): void {
    if (dragPaths.size === 0 || !blob) return
    // The ghost follows everywhere over the tree, valid target or not.
    const me = ev as unknown as MouseEvent
    if (typeof me.clientX === 'number') moveGhostTo(me.clientX, me.clientY)
    // The drag set resolved at dragstart (see `dragLive`): dragover fires
    // every ~50ms, so it must not walk the blob or re-filter the selection.
    const live = dragLive
    if (live.length === 0) return
    const n = nodeAt(ev as unknown as Event)
    const target = dropTargetFor(n)
    if (target === null || !isValidDrop(live, target)) {
      // Invalid: no highlight, no action line — but the ghost still follows.
      // `dropEffect='none'` is what tells the engine this is not a drop site.
      if (ev.dataTransfer) {
        try {
          ev.dataTransfer.dropEffect = 'none'
        } catch {}
      }
      setDropHighlight(-2, null)
      return
    }
    ev.preventDefault() // allow the drop
    if (ev.dataTransfer) {
      try {
        ev.dataTransfer.dropEffect = 'move'
      } catch {}
    }
    // Highlight the ROW UNDER THE CURSOR (n), or nothing for empty-space/root:
    // `dropTargetFor(-1)` is `''` and there is no row -1 to paint.
    setDropHighlight(n >= 0 ? n : -1, target)
  }

  function onDrop(ev: DragEvent): void {
    if (dragPaths.size === 0 || !blob || !host.onMoveRequest) {
      return
    }
    const live = dragLive
    const n = nodeAt(ev as unknown as Event)
    const target = dropTargetFor(n)
    // Snapshot the request BEFORE clearing: `clearDrag` repaints.
    const valid = live.length > 0 && target !== null && isValidDrop(live, target)
    const dest = valid ? target! : ''
    const req = valid ? live : []
    clearDrag()
    if (!valid) {
      ev.preventDefault()
      return
    }
    ev.preventDefault()
    host.onMoveRequest(req, dest)
  }

  function onDragEnd(): void {
    clearDrag()
  }

  function onDragLeave(ev: DragEvent): void {
    // Leaving the scroller for nowhere (`relatedTarget === null`) clears the
    // highlight; moving between rows inside it does not (those fire dragover,
    // not leave-to-null). The ghost is global and stays until drop/dragend.
    if (!ev.relatedTarget) setDropHighlight(-2, null)
  }

  function activateFile(n: number): void {
    if (!blob) return
    const p = blob.pathOf(n)
    const prev = activeNode
    activePath = p
    activeNode = n
    if (prev >= 0) repaintNode(prev)
    repaintNode(n)
    host.openNote?.(p)
  }

  /**
   * §7.2 / §0.13 E15 — THE ROW MENU, and the one line that makes it visible.
   *
   * `ev.preventDefault()` IS LOAD-BEARING AND IT WAS MISSING.  Without it the
   * ENGINE opens its own menu as well as ours, and on Linux that is fatal rather
   * than merely ugly: WebKitGTK's menu is a real GTK popup window, taking it
   * blurs the webview, and menu.ts closes on `window.blur` — so ours is built,
   * mounted and torn down again inside one event, and the user sees Back /
   * Forward / Stop / Reload / Inspect Element and nothing else.  MEASURED on the
   * Debian machine; the tree's own menu had never once been reachable there.
   *
   * It looked fine on macOS only because WKWebView shows nothing for a
   * right-click on non-editable, non-link content, so the missing call had no
   * observable effect — which is why the end-to-end launch that verified this
   * app never caught it.  A platform difference hiding a missing line, not a
   * platform bug.
   *
   * The two EARLY RETURNS above are deliberate and are not the same as each
   * other: `inEdit` lets the inline rename field keep the engine's own
   * cut/copy/paste menu, which this app does not reimplement; the frozen branch
   * suppresses BOTH menus, because §7.3 case 8 forbids acting on a vault that is
   * gone and an engine menu offering Reload over a dirty buffer is worse than
   * no menu at all.
   */
  function onContextMenu(ev: MouseEvent): void {
    if (!blob || !host.onContextMenu) return
    if (inEdit(ev.target)) return // let the field's own menu (cut/paste) through
    if (host.isFrozen?.()) {
      ev.preventDefault()
      return
    }
    // Ours replaces the engine's, on the row AND on empty space — `nodeAt`
    // returning -1 is the empty-space menu, not "no menu".
    ev.preventDefault()
    const n = nodeAt(ev)
    if (n >= 0) setCursorNode(n, false)
    host.onContextMenu(ev, n >= 0 ? blob.pathOf(n) : null, n >= 0 && (blob.kind[n]! & 1) !== 0)
  }

  function onKeyDown(ev: KeyboardEvent): void {
    if (!blob || visibleCount === 0) return
    // §5.4.2's editor is INSIDE the scroller, so every keystroke typed into it
    // bubbles to this delegated handler.  inline-edit.ts stops Enter and Escape
    // itself; everything else would reach the switch below, where an arrow key
    // moves the cursor out from under the row being renamed and a printable key
    // drives type-ahead.  One guard, at the top, covers all of it.
    if (inEdit(ev.target)) return
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return // global shortcuts (§12.2)
    // Keyboard NAVIGATION arms the ring (see `setKbdFocus`).  A bare Shift is
    // `ev.key === 'Shift'` and arms nothing, and neither do Enter, F2, Delete
    // or Escape.  Type-ahead arms it below, and only when it moves the cursor.
    switch (ev.key) {
      case 'ArrowDown': case 'ArrowUp': case 'ArrowRight': case 'ArrowLeft':
      case 'Home': case 'End': case 'PageDown': case 'PageUp':
        setKbdFocus(true)
    }
    const v = cursorVisibleIndex()
    switch (ev.key) {
      case 'ArrowDown':
        ev.preventDefault()
        moveCursorTo(v < 0 ? 0 : Math.min(visibleCount - 1, v + 1))
        return
      case 'ArrowUp':
        ev.preventDefault()
        moveCursorTo(v < 0 ? visibleCount - 1 : Math.max(0, v - 1))
        return
      case 'ArrowRight': {
        ev.preventDefault()
        if (v < 0) return
        const n = visible[v]!
        if ((blob.kind[n]! & 1) === 0) return // a file: nothing
        if ((ui[n]! & 1) === 0) setOpen(n, true)
        else if (blob.subtree[n]! > 0) moveCursorTo(v + 1) // first child
        return
      }
      case 'ArrowLeft': {
        ev.preventDefault()
        if (v < 0) return
        const n = visible[v]!
        if ((blob.kind[n]! & 1) !== 0 && (ui[n]! & 1) !== 0) {
          setOpen(n, false)
        } else {
          const p = blob.parent[n]!
          if (p >= 0) setCursorNode(p, true) // collapsing nothing
        }
        return
      }
      case 'Enter': {
        ev.preventDefault()
        if (v < 0) return
        const n = visible[v]!
        if (host.isFrozen?.()) return
        // Keyboard parity with the plain mouse click: a folder toggles (and
        // anchors), a file opens — clearing the selection and moving the
        // anchor first, unless it is the already-open file.
        if ((blob.kind[n]! & 1) !== 0) {
          clearSelection()
          setAnchor(blob.pathOf(n))
          toggle(n)
        } else {
          if (blob.pathOf(n) !== activePath) {
            clearSelection()
            setAnchor(blob.pathOf(n))
          }
          activateFile(n)
        }
        return
      }
      case 'Home':
        ev.preventDefault()
        moveCursorTo(0)
        return
      case 'End':
        ev.preventDefault()
        moveCursorTo(visibleCount - 1)
        return
      case 'PageDown':
        ev.preventDefault()
        moveCursorTo(Math.min(visibleCount - 1, (v < 0 ? 0 : v) + pageStep()))
        return
      case 'PageUp':
        ev.preventDefault()
        moveCursorTo(Math.max(0, (v < 0 ? 0 : v) - pageStep()))
        return
      case 'F2':
        if (v < 0 || host.isFrozen?.()) return
        ev.preventDefault()
        host.onRenameRequest?.(blob.pathOf(visible[v]!), (blob.kind[visible[v]!]! & 1) !== 0)
        return
      case 'Backspace':
      case 'Delete':
        if (v < 0 || host.isFrozen?.()) return
        ev.preventDefault()
        host.onDeleteRequest?.(blob.pathOf(visible[v]!), (blob.kind[visible[v]!]! & 1) !== 0)
        return
      case 'Escape':
        // Obsidian's `onKeyEscape`: a live selection is dropped first, and
        // only an empty one falls through to whatever Escape otherwise means.
        if (selPaths.size > 0) {
          ev.preventDefault()
          clearSelection()
          return
        }
        host.onEscape?.()
        return
      default:
        break
    }
    // Type-ahead: printable, single-character keys only.  Not an Obsidian
    // feature, but standard in every OS file browser, and the only way to reach
    // a note 3,000 rows down without leaving the keyboard (spec-04 §12.1).
    if (ev.key.length === 1 && ev.key >= ' ') {
      const now = Date.now()
      typeBuf = now - typeAt > TYPEAHEAD_MS ? ev.key : typeBuf + ev.key
      typeAt = now
      const hit = findPrefix(typeBuf, v)
      if (hit >= 0) {
        ev.preventDefault()
        setKbdFocus(true)
        moveCursorTo(hit)
      }
    }
  }

  function pageStep(): number {
    return Math.max(1, Math.floor(clientH / rowH) - 1)
  }

  /** Next visible row whose name starts with `prefix`, wrapping. */
  function findPrefix(prefix: string, from: number): number {
    if (!blob || prefix === '') return -1
    const lower = prefix.toLowerCase()
    const start = from < 0 ? 0 : from
    for (let k = 1; k <= visibleCount; k++) {
      const v = (start + k) % visibleCount
      if (blob.nameOf(visible[v]!).toLowerCase().startsWith(lower)) return v
    }
    return -1
  }

  /* ═══ wiring ════════════════════════════════════════════════════════════ */

  const scrollListener = (): void => {
    onScroll()
  }
  scroller.addEventListener('scroll', scrollListener, { passive: true })
  scroller.addEventListener('click', onClick)
  scroller.addEventListener('contextmenu', onContextMenu)
  scroller.addEventListener('keydown', onKeyDown)
  // Drag-to-move: `dragstart` bubbles from the pooled `.tr` rows (each is
  // `draggable=true`); the rest are on the scroller so empty space (root drop)
  // is a target too. `dragenter` re-uses the over logic — Chromium fires
  // `dragenter` once per element and `dragover` continuously, and the highlight
  // must appear on first contact, not on the second pulse.
  scroller.addEventListener('dragstart', onDragStart as unknown as EventListener)
  scroller.addEventListener('dragover', onDragOver as unknown as EventListener)
  scroller.addEventListener('dragenter', onDragOver as unknown as EventListener)
  scroller.addEventListener('dragleave', onDragLeave as unknown as EventListener)
  scroller.addEventListener('drop', onDrop as unknown as EventListener)
  scroller.addEventListener('dragend', onDragEnd as unknown as EventListener)

  let ro: ResizeObserver | null = null
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(() => {
      measure()
    })
    ro.observe(scroller)
  }

  /**
   * The only place `clientHeight` and `--row-h` are read.  Called at mount, from
   * the ResizeObserver (window resize, sidebar shown/hidden, §3.3 cap banner
   * appearing) and from `measure()`.  NEVER from `onScroll`.
   */
  function measure(): void {
    if (destroyed) return
    const h = scroller.clientHeight
    const cs = getComputedStyle(scroller)
    const declared = parseFloat(cs.getPropertyValue('--row-h') || '')
    const pitch = declared > 0 ? declared : ROW_H_FALLBACK
    // §0.34 E80.  READ, never assumed: §0.32's own history is a padding the
    // user revised three times, and a number this module hardcoded would be
    // wrong the next time tree.css moves and silently so.  `padding-top` is
    // always a resolved px length in a computed style, so `parseFloat` is total;
    // a shim with no stylesheet answers '' and falls back to 0, which is the
    // behaviour this module had before the padding existed.
    const pad = parseFloat(cs.paddingTop || '') || 0
    const padB = parseFloat(cs.paddingBottom || '') || 0
    if (h === clientH && pitch === rowH && pad === padTop && padB === padBottom) return
    // §0.44 E90 — a REAL resize lands here, and the band's geometry is frozen
    // against the old `rowH`/height.  Settle the fold rather than re-derive it.
    // Below the early return on purpose: an idle ResizeObserver callback must
    // not cut a fold short.
    finishAnim()
    clientH = h
    padTop = pad
    padBottom = padB
    if (pitch !== rowH) {
      rowH = pitch
      sizeSizer()
    } else {
      syncOverflow()   // a height change alone moves the overflow boundary
    }
    ensurePool()
    repaintAll()
  }

  measure()

  /* ═══ the controller ════════════════════════════════════════════════════ */

  return {
    applySnapshot(buffer: ArrayBuffer): void {
      // §3.5's handler, in order: preserve scrollTop, adopt, restore, flatten,
      // clamp, repaint.  FULL REBUILD, ALWAYS — delta application against a
      // virtualised list is where tree bugs live.
      finishAnim()   // §0.44 E90: the band's indices mean nothing across a snapshot
      clearDrag()    // drag node indices mean nothing across one either — a
      // watcher refresh mid-drag cancels the highlight rather than pointing it
      // at whatever now holds those indices (see `restore()`'s own note on
      // `selNodes`; a drag is seconds long and a refresh then is routine).
      const st = scroller.scrollTop
      const next = adopt(buffer)
      blob = next
      // Node indices mean nothing across a snapshot — see invalidatePool().
      invalidatePool()
      if (ui.length < next.n) ui = new Uint8Array(next.n)
      else ui.fill(0, 0, next.n)
      if (hidden.length < next.n) hidden = new Uint8Array(next.n)
      else hidden.fill(0, 0, next.n)
      if (visible.length < next.n) visible = new Int32Array(next.n)
      restore()
      flatten()
      // The pool depends on clientHeight alone, but a first snapshot can arrive
      // before the scroller has a height (window still hidden, §6.1), so re-check.
      if (poolSize === 0) measure()
      // A snapshot can land while an inline editor is open (a watcher refresh
      // during a rename).  Re-resolve the suppressed row BY PATH before the
      // repaint — node indices mean nothing across a snapshot — and drop the
      // host if the row it was sitting on is gone.
      settleEditHost()
      scroller.scrollTop = Math.min(st, maxScroll())
      repaintAll()
    },

    blob: () => blob,

    setExpanded(paths: readonly string[]): void {
      finishAnim()   // §0.44 E90
      // The whole set is replaced from an authoritative source, so a pending
      // snapshot of the old one must not fire afterwards and overwrite it.
      if (expandedTimer !== null) clearTimeout(expandedTimer)
      expandedTimer = null
      expandedPaths.clear()
      let k = 0
      for (const p of paths) {
        if (k++ >= EXPANDED_CAP) break
        expandedPaths.add(p)
      }
      if (blob) {
        restore()
        flatten()
        settleEditHost()
        clampScroll()
        repaintAll()
      }
    },

    expanded: expandedSnapshot,

    setActivePath(path: string | null): void {
      const prev = activeNode
      activePath = path
      activeNode = -1
      if (blob && path !== null) {
        for (let i = 0; i < blob.n; i++) {
          if ((blob.kind[i]! & 1) !== 0) continue
          if (endsWithSeg(path, blob.nameOf(i)) && blob.pathOf(i) === path) {
            activeNode = i
            break
          }
        }
      }
      if (prev >= 0) repaintNode(prev)
      if (activeNode >= 0) repaintNode(activeNode)
    },

    activePath: () => activePath,
    cursorPath: () => cursorPath,

    /**
     * The shift-selection, in blob order: `{path, isDir}` per selected row.
     * Empty until the first shift-click.  main.ts's delete subject reads this;
     * NOTHING else does, and nothing here deletes anything.
     */
    getSelection(): { path: string; isDir: boolean }[] {
      if (!blob || selPaths.size === 0) return []
      const out: { path: string; isDir: boolean }[] = []
      for (let i = 0; i < blob.n; i++) {
        const p = blob.pathOf(i)
        if (selPaths.has(p)) out.push({ path: p, isDir: (blob.kind[i]! & 1) !== 0 })
      }
      return out
    },

    /**
     * Command 25's answer, applied.  Re-resolves against the live blob with
     * the shared path lookup and repaints: node indices mean nothing across
     * a snapshot, so a stored node would point at whatever now holds the
     * index.  Misses (a rel this blob does not hold — the fetch raced the
     * snapshot) fall out and reconcile on the next refresh.
     */
    setSecrets(rels: readonly string[]): void {
      secretPaths = new Set(rels)
      secretNodes.clear()
      if (blob) {
        for (const rel of secretPaths) {
          const i = nodeIndexOfPath(rel)
          if (i >= 0) secretNodes.add(i)
        }
        repaintAll()
      }
    },

    /**
     * Descendant count for `path`, excluding itself — the delete confirm's
     * non-empty-folder warnings.  0 for a file, for a missing path, and for
     * an empty folder alike.
     */
    descendantCount(path: string): number {
      if (!blob) return 0
      const i = nodeIndexOfPath(path)
      return i < 0 ? 0 : blob.subtree[i]!
    },

    revealPath,

    flushPersist,
    cancelPersist,

    setScrollTop(top: number): void {
      finishAnim()   // §0.44 E90: `maxScroll()` is only meaningful on a settled tree
      scroller.scrollTop = Math.min(Math.max(0, top), maxScroll())
      repaintAll()
    },

    measure,

    rowHost,
    reserveRowHost,
    releaseRowHost,

    beginRename(path: string, opts: NameEditorOptions): NameEditorHandle | null {
      const h = rowHost(path)
      if (!h) return null
      // 'all', not 'stem' — CORRECTED, and the correction is Obsidian's own:
      // `startRename` in its `app.js` ends in `sm(innerEl)`, which is
      // `Range.selectNodeContents` over the WHOLE title.  The field holds what
      // the row was showing, which for a note is the name WITHOUT `.md`
      // (spec-04 §8.3 says so in as many words: "the .md is not shown so this
      // is just select all"), so 'stem' has no extension left to protect and
      // instead cuts a perfectly ordinary title at its first dot — `v1.2 plan`
      // would open with only `v1` selected.  The caller appends the extension
      // through `suffix`.
      return openOn(h, { select: 'all', ...opts })
    },

    beginCreate(parent: string, opts: NameEditorOptions): NameEditorHandle | null {
      const h = reserveRowHost(parent)
      if (!h) return null
      return openOn(h, { select: 'all', ...opts })
    },

    destroy(): void {
      destroyed = true
      // NOT `finishAnim()`: its `finish` repaints, and this tears the pool down.
      // Drop the fold and its frame instead.
      if (animRaf !== 0 && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(animRaf)
      }
      animRaf = 0
      if (animTimer !== null) clearTimeout(animTimer)
      animTimer = null
      anim = null
      chevRow = null
      releaseRowHost()
      clearDrag()
      // A new tree on this scroller starts from `overflowing = kbdFocus = false`
      // and its setters return early on a match, so leave no class behind.
      scroller.classList.remove('is-overflowing', 'kbd-focus')
      scroller.removeEventListener('scroll', scrollListener)
      scroller.removeEventListener('click', onClick)
      scroller.removeEventListener('contextmenu', onContextMenu)
      scroller.removeEventListener('keydown', onKeyDown)
      scroller.removeEventListener('dragstart', onDragStart as unknown as EventListener)
      scroller.removeEventListener('dragover', onDragOver as unknown as EventListener)
      scroller.removeEventListener('dragenter', onDragOver as unknown as EventListener)
      scroller.removeEventListener('dragleave', onDragLeave as unknown as EventListener)
      scroller.removeEventListener('drop', onDrop as unknown as EventListener)
      scroller.removeEventListener('dragend', onDragEnd as unknown as EventListener)
      ro?.disconnect()
      if (expandedTimer !== null) clearTimeout(expandedTimer)
      if (scrollTimer !== null) clearTimeout(scrollTimer)
      for (const el of pool) el.remove()
      pool.length = 0
      poolSize = 0
    },

    debug: {
      visibleCount: () => visibleCount,
      poolSize: () => poolSize,
      rowCount: () => pool.length,
      clientHeight: () => clientH,
      rowPitch: () => rowH,
      nodeAt: (v: number) => (v >= 0 && v < visibleCount ? visible[v]! : -1),
      onScroll,
      paintedRange: () => [curFirst, curLast],
      editHost: () => editHost,
      editingPath: () => editPath,
      reservedAt: () => (editAt === NO_EDIT ? -1 : editAt),
      // Drag-to-move test seam: the pure target/validity helpers, bound to the
      // LIVE blob. `dropTargetFor(-1)` is `''` (root); `isValidDrop` takes the
      // RESOLVED entries a `dragstart` would carry.
      dropTargetFor: (n: number) => dropTargetFor(n),
      isValidDrop: (sources: { path: string; isDir: boolean }[], target: string | null) => isValidDrop(sources, target),
      filterTopLevel: (entries: { path: string; isDir: boolean }[]) => filterTopLevel(entries),
      dragSetFor: (n: number) => dragSetFor(n),
      flushPersist,
    },
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * REPORTED WIRING — NOT A TODO IN THIS FILE, A REPORT ABOUT ANOTHER OWNER'S
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `src/index.html` already ships the boxes this module needs, at line 132:
 *
 *     <div class="tree-scroller" tabindex="0" role="tree" aria-label="Vault">
 *       <div class="sz"></div>
 *     </div>
 *
 * but `src/main.ts` (owner 01) imports only `./chrome`, `./ipc` and `./bench`.
 * `createTree` is therefore NEVER CALLED and this module is not in the bundle —
 * `npm run build` reports the same `js 19179 B` with and without it.  THE TREE
 * SHIPS DEAD until owner 01 adds roughly this to the boot sequence:
 *
 *     const tree = createTree({
 *       scroller: document.querySelector('.tree-scroller')!,
 *       openNote:            (p) => editor.openNote(p),
 *       onExpandedChanged:   (expanded) => state.patch({ expanded }),
 *       onScrollTopChanged:  (scrollTop) => state.patch({ scrollTop }),
 *       onCursorMoved:       () => {},
 *       onActiveVanished:    (p) => editor.markDetached(p),
 *       onContextMenu:       (ev, path, isDir) => menu.openTree(ev, path, isDir),
 *       onRenameRequest:     (path, isDir) => inlineEdit.rename(path, isDir),
 *       onDeleteRequest:     (path, isDir) => menu.confirmDelete(path, isDir),
 *       onEscape:            () => editor.focus(),
 *       isFrozen:            () => chrome.vaultLost(),
 *     })
 *     tree.setExpanded(ui.expanded)          // BEFORE the first snapshot
 *     tree.applySnapshot(await tree_snapshot())
 *     tree.setScrollTop(ui.scrollTop)        // AFTER it — it clamps to content
 *     on('nc://tree-changed', async () => tree.applySnapshot(await tree_snapshot()))
 *
 * The ORDER of those four lines is the load-bearing part.  `setExpanded` before
 * the snapshot means `restore()` applies the persisted set in the same pass that
 * resolves the cursor, instead of flattening twice; `setScrollTop` after it is
 * what lets the clamp see a real content height rather than 0.
 */
