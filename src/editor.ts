/**
 * src/editor.ts
 * Owner: 03.  Spec: CONTRACT.md §5.3 (the editor surface), §5.4 (headings),
 * §5.4.1 (the marker reveal), §5.4.2 (the inline title and its rename),
 * §5.11 (the harness seam), §5.12.6 (what the editor gives up),
 * §7.1 (the three structural rules), §7.2 (the autosave contract),
 * §7.3 cases 3/4/5/7/8/11, §1.6 (the flush-on-quit handshake), M70.
 *
 * EXACTLY ONE `EditorView` FOR THE PROCESS LIFETIME (M70).  A note switch and a
 * vault switch are both `view.setState(EditorState.create({ doc, extensions }))`;
 * spec-04 §13.4 step 3's `editor.close()` is STRUCK.
 *
 * WHAT §5.12.6 COSTS THIS MODULE: `.cm-scroller` stays a real scroller, so
 * `scrollIntoView`, viewport virtualisation, selection autoscroll and keyboard
 * paging are the platform's and are untouched.  But the editor is THE PANE
 * GENUINELY GIVING SOMETHING UP: scrolling now blocks on main-thread work.  So
 * the §7.2 autosave serialise MUST NOT run on a frame in which a scroll is in
 * flight — `scrollBusy()` below is that guard, and the debounce is what gives
 * the write somewhere else to go.  The §5.4.1 marker reveal is driven by
 * `selectionSet`, which a scroll does not raise, and the decoration rebuild is
 * bounded by `visibleRanges` (livepreview.ts).
 *
 * `@codemirror/language` and `@lezer/highlight` are NOT INSTALLED (M23) and MUST
 * NOT be added: `insertIndent`/`removeIndent` below exist solely to avoid the
 * one import (`indentWithTab` -> `indentMore`) that drags `HighlightStyle`,
 * `syntaxTree` and `StreamLanguage` back in.  The pinned set is
 * @codemirror/state 6.7.2, @codemirror/view 6.43.10, @codemirror/commands 6.11.0.
 *
 * ---------------------------------------------------------------------------
 * THE IPC SEAM, AND WHY IT IS AN INJECTION AND NOT AN IMPORT.
 * `src/ipc.ts` and `src/ipc.d.ts` are owner 02's and are TODO(impl) stubs
 * today: `readNote`, `writeNote`, `renameEntry` and every type in §1.5 do not
 * exist yet.  This module does not invent them, does not import
 * `@tauri-apps/api` (§1.1 keeps that in ipc.ts alone) and does not restate one
 * byte offset of §2's frame (§2.2 keeps that in note_frame.js alone).  It
 * declares the three calls it needs as a narrow structural interface and takes
 * them from `configureEditor()`.  When owner 02's wrappers land, the shell
 * passes them in and the `*Like` types below are replaced by
 * `import type { NoteRead, WriteReceipt, VaultError } from './ipc.d'` — the
 * field names here are already §1.1's camelCase, deliberately, so that swap is
 * a one-line change and not a rename.
 * ------------------------------------------------------------------------- */

import { Compartment, EditorSelection, EditorState, StateEffect, StateField } from '@codemirror/state'
import type { ChangeSpec, Extension, TransactionSpec } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, keymap } from '@codemirror/view'
import type { Command, DecorationSet, ViewUpdate } from '@codemirror/view'
import { history, historyKeymap, standardKeymap } from '@codemirror/commands'

import {
  blockIndex,
  endTitleEditing,
  linkClicks,
  livePreview,
  listHangingIndent,
  livePreviewAtomicRanges,
  registerTitleRenameHost,
  setInitialTitle,
  setTitle,
  titleField,
} from './livepreview'
import { tables } from './tables'
import { totp } from './totp'
import { findMatches } from './find'
import { isSecretText, renderSecrets } from './secrets'
/* §5.4.5.  It is TWO extensions behind one name — a `StateField` that replaces
   the frontmatter range with the Properties block, and a `transactionFilter`
   that keeps the selection out of it.  Both have to be here rather than inside
   `livepreview.ts`: `block: true` decorations may not come from a `ViewPlugin`,
   which is what `livePreview` is. */
import { properties } from './properties'
/* `openMenu`/`clipMenu` is THE ONE context-menu primitive (owner 04): the
 * note viewer's Copy/Paste rows are built by it, never as a second floating
 * list.  `menu.ts` imports only `icons.ts`, so this is not a cycle. */
import { clipMenu, openMenu } from './menu'
/* §7.3 case 3's prompt.  `src/modal.ts` (owner 01) is THE ONLY MODAL IN THE APP
 * (§1.6.1, errata 3 Z4); this module does not draw one and must never grow one.
 * The import is a VALUE import, not a type import, because the guard below
 * calls it — which is also why the modal has to be a module and not a
 * dependency injected through `configureEditor`: the guard is called from
 * `main.ts`, which already has the modal, and threading it through a fourth
 * transport field would make it optional at exactly the call site where it is
 * the whole point. */
import { openModal } from './modal'

/* ===========================================================================
 * 0.  The wire shapes this module consumes (see the header note).
 * ========================================================================= */

/** §1.5 `NoteRead`, structurally.  Decoded by note_frame.js (owner 02). */
export interface NoteReadLike {
  text: string
  mtimeMs: number
  flags: number
  bytes?: number
}

/** §1.5 `WriteReceipt`, structurally. */
export interface WriteReceiptLike {
  mtimeMs: number
}

/** §1.5 `VaultError`, structurally.  The frontend switches on `kind` and MUST
 *  NOT parse `message`, which is OS-localised (§1.5). */
export interface VaultErrorLike {
  kind: string
  message?: string
}

export interface EditorIpc {
  /** §1.3 command 8 + §2's frame, already decoded. */
  readNote(path: string): Promise<NoteReadLike>
  /** §1.3 command 9 + §2.3.  `create` is `false` on every autosave path (§7.1 rule 1). */
  writeNote(
    path: string,
    text: string,
    flags: number,
    baseMtimeMs: number | null,
    create: boolean
  ): Promise<WriteReceiptLike>
  /** §1.3's rename.  Returns §1.5 `RenameResult`; only `path` is read here. */
  renameEntry(path: string, name: string): Promise<{ path: string }>
  /**
   * §1.3 command 10, optional so older test transports keep working.
   * `keepMine()` uses it to snapshot the disk (losing) version to a
   * `<stem>.conflict-<secs>.md` sidecar BEFORE the force overwrite; without
   * it the backup is skipped and the overwrite still proceeds.
   */
  createNote?(parent: string, name?: string): Promise<{ path: string }>
  /**
   * §1.3 command 26, optional so older test transports keep working.
   * The note viewer's context menu probes this to decide whether the
   * clipboard holds text (the Paste row); without it the probe falls back
   * to `navigator.clipboard.readText()` and treats a refusal as empty.
   */
  readClipboardText?(): Promise<string>
  /**
   * §1.3 command 23, optional so older test transports keep working.
   * Copy's fallback when `navigator.clipboard.writeText()` rejects — an
   * unfocused window answers "Document is not focused", while the
   * main-process clipboard has no focus requirement (but refuses more than
   * 4096 characters, so the unbounded async clipboard stays the first try).
   */
  writeClipboardText?(text: string): Promise<void>
}

export type FlushReason =
  | 'idle' | 'max' | 'switch' | 'blur' | 'hidden' | 'close' | 'manual'
  /** §7.3 case 3 step 3's "Save and delete" (errata 3, Z5). */
  | 'delete'

export type OpenResult =
  | { ok: true; path: string; bytes: number }
  | { ok: false; path: string; err: VaultErrorLike }

/** spec-03 §9.5's four states.  Only `live` autosaves. */
export type NoteState = 'live' | 'conflict' | 'detached' | 'vault-lost'

export interface EditorHooks {
  /** §7.3 case 4 / §5.4.2: activePath and the tab label follow RenameResult.path. */
  onPathChanged?: (path: string) => void
  onDirtyChanged?: (dirty: boolean) => void
  onNoteStateChanged?: (state: NoteState, err: VaultErrorLike | null) => void
  /** A background flush (idle, max, blur, hidden) that was refused. */
  onFlushError?: (reason: FlushReason, err: VaultErrorLike) => void
  /** §7.4: no note open.  The shell hides the tab.  There is no longer a
   *  `.empty-state` line to show — §0.45 E91 deleted it. */
  onEmpty?: () => void
}

/* ===========================================================================
 * 1.  Module state.  One view, one open note, one set of timers.
 * ========================================================================= */

const IDLE_MS = 800     // §7.2 — quiet period after the last keystroke
const MAX_MS = 5000     // §7.2 — ceiling, from the FIRST unsaved keystroke
const SCROLL_QUIET_MS = 120   // §5.12.6 — how long after a scroll event a frame is "in flight"
const CURSOR_LRU_MAX = 20     // spec-03 §9.6
const BAD_FLASH_MS = 200      // §7.3 case 11

interface OpenNote {
  path: string
  baseMtimeMs: number
  flags: number
  bytes: number
}

interface CursorMemo {
  anchor: number
  head: number
  scrollTop: number
}

let view: EditorView | null = null
let ipc: EditorIpc | null = null
let hooks: EditorHooks = {}

/* A secret file (`cairn-type: secrets` frontmatter) hides the CodeMirror view
 * entirely and renders `secrets.ts`'s viewer in its place — `src/secrets.ts`
 * is the design, this is only the switch.  The document stays loaded, so
 * dirty tracking, the §7.2 autosave and every note state keep working: the
 * viewer mutates through ordinary dispatches. */
let secretMode = false
let secretsRoot: HTMLElement | null = null
let secretsParent: HTMLElement | null = null

let open: OpenNote | null = null
let dirty = false
let noteState: NoteState = 'live'
let lastError: VaultErrorLike | null = null

/** Bumped on every document change; a flush that outlives its generation must
 *  not clear `dirty`, or the keystrokes typed during the write are lost. */
let docGen = 0

let idleTimer: ReturnType<typeof setTimeout> | null = null
let maxTimer: ReturnType<typeof setTimeout> | null = null
let scrollingUntil = 0
let chain: Promise<unknown> = Promise.resolve()

const cursors = new Map<string, CursorMemo>()
const editable = new Compartment()

/* In-note find (src/find.ts, KNOWN-ISSUES.md X-13).  The panel lives outside
 * this module and must not reach the module-private view, so document changes
 * are fanned out here: one listener set, notified from `onUpdate` below. */
const findListeners = new Set<() => void>()

function fail(kind: string, message?: string): VaultErrorLike {
  return message === undefined ? { kind } : { kind, message }
}

/**
 * UTF-8 byte length, allocation-free.
 *
 * `text.length` is UTF-16 CODE UNITS, which equals the byte count only for
 * ASCII.  A CJK note is 3x, an emoji 4x — and `bytes` is what `OpenResult`
 * publishes and what §1.5's `tooLarge` message is rendered from, so counting it
 * in the wrong unit understates a Japanese note by two thirds.  This project
 * has already been bitten once by a CJK inflation claim; do not replace this
 * with `.length`, and do not replace it with `new TextEncoder().encode(text)
 * .length` either — that allocates a second copy of the whole document on every
 * flush, in an app whose premise is that megabytes are counted.
 */
function utf8Len(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1)
      // A well-formed pair is 4 bytes; a lone surrogate encodes as U+FFFD, 3.
      if (d >= 0xdc00 && d <= 0xdfff) { n += 4; i++ } else n += 3
    } else n += 3
  }
  return n
}

function asVaultError(e: unknown): VaultErrorLike {
  if (e && typeof e === 'object' && typeof (e as { kind?: unknown }).kind === 'string') {
    return e as VaultErrorLike
  }
  return fail('io', String(e))
}

function setDirty(v: boolean): void {
  if (dirty === v) return
  dirty = v
  hooks.onDirtyChanged?.(v)
}

function setNoteState(s: NoteState, err: VaultErrorLike | null): void {
  noteState = s
  lastError = err
  if (s !== 'live') cancelTimers()
  reconfigureEditable()
  hooks.onNoteStateChanged?.(s, err)
}

/**
 * §9.5: `detached` and `vault-lost` are read-only; `conflict` stays editable.
 *
 * §0.45 E92 — THREE STATES, WHERE THIS USED TO HAVE TWO, and the third is the
 * one the user could see:
 *
 *   `open === null`           NOT AN EDITABLE SURFACE AT ALL
 *   detached / vault-lost     read-only, but still a document
 *   otherwise                 editable
 *
 * `EditorState.readOnly` FORBIDS EDITS AND STILL PAINTS A CARET.  It is a
 * transaction filter: it stops changes from being applied and changes nothing
 * about the DOM, so `.cm-content` keeps `contenteditable="true"` and Chromium
 * keeps blinking a caret in it.  With no note open that put a cursor in the
 * top-left of an empty pane, inviting the user to type into a document that
 * does not exist — reported as *"and the cursor!"*.
 *
 * `EditorView.editable.of(false)` is the one that clears `contenteditable`, and
 * the caret goes with it because **Cairn draws no cursor of its own**: there is
 * no `drawSelection` in `EXTENSIONS`, so the caret is the browser's native one
 * and `editor.css`'s `caret-color` merely colours it. Nothing to hide in CSS —
 * take away the editable host and there is no caret to begin with.
 *
 * THE TWO READ-ONLY STATES DELIBERATELY KEEP THEIRS. A detached or vault-lost
 * note still holds text the user may want to select and copy out — §7.3 case 5
 * exists so they can `Save as…` — and `base.css`'s blanket `user-select: none`
 * is lifted only for `[contenteditable="true"]`, so making those non-editable
 * would take the selection away with the caret. Empty is the only state with
 * nothing to lose.
 */
function reconfigureEditable(): void {
  if (!view) return
  if (open === null) {
    view.dispatch({
      effects: editable.reconfigure([
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
      ]),
    })
    return
  }
  const ro = noteState === 'detached' || noteState === 'vault-lost'
  view.dispatch({
    effects: editable.reconfigure(ro ? EditorState.readOnly.of(true) : []),
  })
}

/* ===========================================================================
 * 2.  Indentation — §7.1's twelve local lines, the reason
 *     `@codemirror/language` is not installed.
 * ========================================================================= */

const INDENT = '    '

/**
 * OBSIDIAN'S TAB IS CODEMIRROR'S `indentMore`, AND IT IS BOUND UNCONDITIONALLY.
 * `app.js:67972` is the markdown editor's own keymap entry —
 * `{ key: "Tab", run: () => (t.editor.indentList(), true),
 *    shift: () => (t.editor.unindentList(), true) }` — and `indentList` is
 * `this.exec("indentMore")` (`:41325`), which is `VH(this.cm6)` (`:53175`),
 * which is the library's `indentMore`. There is no list branch and no
 * cursor branch: Tab indents the LINES the selection touches, empty selection
 * included. Shift-Tab is `indentLess` by the same route.
 *
 * ── WHAT THIS REPLACED, AND WHY IT WAS DATA LOSS ───────────────────────────
 * The previous pair inserted at `range.from`..`range.to`, which for a NON-EMPTY
 * selection is a REPLACEMENT: select three paragraphs, press Tab, and they were
 * gone — four spaces where the text had been. Recoverable through `history`,
 * and destructive all the same. Shift-Tab had the other half of the same bug:
 * it dedented only the line holding `range.from`, so a multi-line selection
 * moved one line.
 *
 * spec-03 §7.1's own wording is where it came from — *"insert or strip four
 * spaces at each selection range"* — which is true of a cursor and wrong of a
 * selection. The spec sentence is the defect's origin and is struck with it.
 *
 * ── WHY IT IS STILL LOCAL ──────────────────────────────────────────────────
 * M23 is a SOURCE ban and it stands: `@codemirror/language` is not imported
 * here, and `indentMore` cannot be borrowed from `@codemirror/commands` without
 * taking that package's `indentUnit` facet with it. So `changeBySelectedLine`,
 * `indentMore` and `indentLess` are transcribed from
 * `@codemirror/commands/dist/index.js:1567/1618/1630` against `INDENT` as the
 * unit. It is ~35 lines where §7.1 promised twelve; the twelve were the wrong
 * twelve.
 *
 * ── ONE DIVERGENCE, RECORDED AND NOT TAKEN ─────────────────────────────────
 * Obsidian's indent unit is a TAB by default (`useTab: true`, `tabSize: 4`), so
 * its Tab writes `\t` where Cairn writes four spaces. Both RENDER at the same
 * 36px — §0.51 E99 quantises "a whole tab or four whole spaces" to one indent
 * level precisely because Obsidian does — so this is invisible and it changes
 * the BYTES in the user's file. spec-03 §7.1 pinned four spaces; changing it is
 * a ruling about what this app writes into somebody's vault, not a fix.
 */

/** `@codemirror/commands:1567`'s `changeBySelectedLine`, transcribed. */
function changeBySelectedLine(
  state: EditorState,
  f: (line: { from: number; to: number; number: number; text: string }, changes: ChangeSpec[]) => void,
): TransactionSpec {
  let atLine = -1
  return state.changeByRange((range) => {
    const changes: ChangeSpec[] = []
    for (let pos = range.from; pos <= range.to;) {
      const line = state.doc.lineAt(pos)
      // `range.empty || range.to > line.from` is what stops a selection that
      // ENDS at a line start from indenting that line as well.
      if (line.number > atLine && (range.empty || range.to > line.from)) {
        f(line, changes)
        atLine = line.number
      }
      pos = line.to + 1
    }
    const set = state.changes(changes)
    return {
      changes,
      // `mapPos(_, 1)` associates forward, so a selection that started at a
      // line's first character still covers the same TEXT afterwards rather
      // than swallowing the indent that was just inserted in front of it.
      range: EditorSelection.range(set.mapPos(range.anchor, 1), set.mapPos(range.head, 1)),
    }
  })
}

/** Columns, counting a tab to the next multiple of `tabSize`. CM's `countColumn`. */
function columnsOf(ws: string, tabSize: number): number {
  let n = 0
  for (const ch of ws) n = ch === '\t' ? n + tabSize - (n % tabSize) : n + 1
  return n
}

const insertIndent: Command = (v) => {
  if (v.state.readOnly) return false
  v.dispatch(
    changeBySelectedLine(v.state, (line, changes) => {
      changes.push({ from: line.from, insert: INDENT })
    }),
    { scrollIntoView: true, userEvent: 'input.indent' }
  )
  return true
}

const removeIndent: Command = (v) => {
  const state = v.state
  if (state.readOnly) return false
  v.dispatch(
    changeBySelectedLine(state, (line, changes) => {
      const space = /^\s*/.exec(line.text)?.[0] ?? ''
      if (!space) return
      // ONE LEVEL, MEASURED IN COLUMNS, NOT `INDENT.length` CHARACTERS: a line
      // indented with a tab is one level in, and stripping four CHARACTERS off
      // it would take the whole tab and leave nothing — which is right — while
      // a line of `\t\t` must lose one tab and keep one. Columns are the only
      // unit in which "one level" means the same thing for both spellings.
      const want = ' '.repeat(Math.max(0, columnsOf(space, state.tabSize) - INDENT.length))
      let keep = 0
      while (keep < space.length && keep < want.length && space[keep] === want[keep]) keep++
      changes.push({ from: line.from + keep, to: line.from + space.length, insert: want.slice(keep) })
    }),
    { userEvent: 'delete.dedent' }
  )
  return true
}

/* ===========================================================================
 * 3.  The extension set (spec-03 §7.1).
 * ========================================================================= */

function onUpdate(u: ViewUpdate): void {
  if (!u.docChanged) return
  docGen++
  setDirty(true)
  scheduleAutosave()
  // Entering secret mode, leaving it, or re-rendering inside it.  The full
  // marker walk runs only when it can change the answer: already in secret
  // mode, or a first line that is a frontmatter opener.
  if (secretMode || u.state.doc.line(1).text === '---') syncSecretMode()
  for (const cb of [...findListeners]) {
    try {
      cb()
    } catch {
      /* a find listener must never break autosave */
    }
  }
}

/**
 * Re-evaluate the secret switch against the live document and reconcile the
 * pane.  Re-rendering on every document change while in secret mode is also
 * what re-masks every shown secret — the safe direction to fail in.
 *
 * THE TAKEOVER HIDES `#ed`, THE HOST — never the CM6 view itself, and that
 * is load-bearing twice over.  First, CM6's own base theme carries
 * `display: flex !important` on `.cm-editor`, and a stylesheet `!important`
 * outranks a normal inline style (§0.24.5 E53's mechanism): a plain
 * `view.dom.style.display = 'none'` is silently dead, and only `setProperty`
 * with the priority reaches it.  Second, and the one that shipped a black
 * pane: `#ed` is `height: 100%`, so an emptied-but-visible `#ed` keeps
 * occupying the whole pane and the viewer beside it is laid out BELOW the
 * fold, where `.editor`'s `overflow: hidden` clips it — mounted, rendered,
 * asserted present by every probe, and invisible.  Hiding the host costs
 * neither fight: `.editor.is-secret > #ed { display: none }` is an ordinary
 * rule over an ordinary element.
 */
function syncSecretMode(): void {
  if (!view || !secretsRoot) return
  const next = open !== null && isSecretText(view.state.doc.toString())
  if (next === secretMode) {
    if (next) renderSecrets(secretsRoot, view)
    return
  }
  secretMode = next
  secretsParent?.classList.toggle('is-secret', next)
  secretsRoot.hidden = !next
  if (next) renderSecrets(secretsRoot, view)
}

/**
 * §0.43 — SCROLL PAST THE END, and it is HALF the editor, not a line.
 *
 * Found in a user's DevTools screenshot of Obsidian, not by reading its CSS:
 * `.cm-content` carries an INLINE `padding-bottom`, 515px on a 1030.4px
 * scroller and 365px on the same editor shrunk by an open DevTools — i.e.
 * **exactly half the scroller's height**, recomputed as the editor resizes.
 * Cairn had none, so a note stopped dead at its last line while Obsidian lets
 * you pull that line up to the middle of the screen.
 *
 * IT IS ALSO MOST OF A 778px MYSTERY. Cairn's document measured 778px shorter
 * than Obsidian's for the same note, and three passes went looking for missing
 * content. There is none: 4292.7 − 515 = 3777.7 against Cairn's 3771.9. The
 * "missing" height was this padding.
 *
 * `@codemirror/view` ships its own `scrollPastEnd()`, and it is NOT this: it
 * pads by `editorHeight − defaultLineHeight`, a whole screen less one line.
 * The shape of the plugin below is that function's (a `ViewPlugin` whose value
 * provides `contentAttributes`, so the padding lands as an attribute CM6 owns
 * rather than a DOM write of ours); the NUMBER is Obsidian's own.
 *
 * spec-03 §8.2's `.cm-content { padding: … 30vh }` is STRUCK and stays struck —
 * that was a static 30% of the VIEWPORT in a stylesheet, and this is 50% of the
 * SCROLLER, maintained by the editor.
 */
class ScrollPastEnd {
  height = -1
  attrs: { style: string } = { style: 'padding-bottom: 0px' }

  constructor(view: EditorView) { this.read(view) }

  update(u: ViewUpdate): void {
    if (u.geometryChanged || u.viewportChanged) this.read(u.view)
  }

  private read(view: EditorView): void {
    const want = Math.max(0, Math.round(view.scrollDOM.clientHeight / 2))
    if (want === this.height) return
    this.height = want
    this.attrs = { style: `padding-bottom: ${want}px` }
  }
}

const scrollPastEnd = ViewPlugin.fromClass(ScrollPastEnd, {
  provide: (p) => EditorView.contentAttributes.of((v) => v.plugin(p)?.attrs ?? null),
})

/**
 * In-note find's mark layer (src/find.ts drives it through
 * `setFindHighlightInView` below).
 *
 * The panel keeps focus while it is open, so the editor is BLURRED while the
 * user reads the matches — and the editor's own selection is not a reliable
 * highlight there.  These marks are ordinary decorations and paint regardless
 * of focus: every match takes `.cm-find-match`, the current one
 * `.cm-find-current`.  A fresh `EditorState` (note switch, empty) builds fresh
 * fields, so the marks die with the note and nothing has to clear them there;
 * hiding or destroying the panel clears through the effect.
 */
export interface FindHighlightSpec {
  query: string
  caseSensitive: boolean
  from: number
  to: number
}

export const setFindHighlight = StateEffect.define<FindHighlightSpec>()

export const findSpecField = StateField.define<FindHighlightSpec>({
  create: () => ({ query: '', caseSensitive: false, from: -1, to: -1 }),
  update: (v, tr) => {
    for (const e of tr.effects) if (e.is(setFindHighlight)) return e.value
    return v
  },
})

const FIND_MATCH = Decoration.mark({ class: 'cm-find-match' })
const FIND_CURRENT = Decoration.mark({ class: 'cm-find-current' })

function findDeco(state: EditorState): DecorationSet {
  const spec = state.field(findSpecField)
  if (spec.query === '') return Decoration.none
  const { matches } = findMatches(state.doc.toString(), spec.query, spec.caseSensitive)
  if (matches.length === 0) return Decoration.none
  const out = []
  for (const m of matches) {
    out.push((m.from === spec.from && m.to === spec.to ? FIND_CURRENT : FIND_MATCH).range(m.from, m.to))
  }
  return Decoration.set(out, true)
}

export const findHighlightDeco = StateField.define<DecorationSet>({
  create: (state) => findDeco(state),
  update: (deco, tr) => {
    if (!tr.docChanged && !tr.effects.some((e) => e.is(setFindHighlight))) return deco
    return findDeco(tr.state)
  },
  provide: (f) => EditorView.decorations.from(f),
})

/** F80/F81/F82: whether a drag carries anything the editor must refuse — a
 *  tree row (the private MIME) or files. Pure, so the refusal rule is
 *  unit-testable without manufacturing a DropEvent. */
export function refuseDrop(
  dt: { types: ArrayLike<string> | readonly string[]; files?: ArrayLike<unknown> | null } | null,
): boolean {
  if (!dt) return false
  const types = Array.from(dt.types as ArrayLike<string>)
  if (types.includes('application/x-cairn-paths')) return true
  return !!dt.files && dt.files.length > 0
}

/**
 * Pasted clipboard images land inline as `![pasted image](data:…)` — the one
 * image use case.  A data URL keeps the image in the note's own text, so no
 * core change (the tree holds `.md` only), no IPC addition (the table is
 * closed at 25) and no attachment folder are owed.
 *
 * `firstClipboardImage` is the pure pick rule — the first `image/*` file, or
 * null — unit-testable without manufacturing a ClipboardEvent, like
 * `refuseDrop` above.  `blobToDataUrl` converts through `arrayBuffer` + `btoa`
 * rather than `FileReader`, so it runs identically in the renderer and in the
 * Node harness.
 */
export interface ClipboardImageLike {
  readonly type: string
  arrayBuffer(): Promise<ArrayBuffer>
}

export function firstClipboardImage(
  dt: { files?: ArrayLike<ClipboardImageLike> | null } | null,
): ClipboardImageLike | null {
  const files = dt?.files
  if (!files) return null
  for (let i = 0; i < files.length; i++) {
    const f = files[i] as ClipboardImageLike | undefined
    if (f !== undefined && typeof f.type === 'string' && f.type.startsWith('image/')) return f
  }
  return null
}

export async function blobToDataUrl(blob: ClipboardImageLike): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer())
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, Array.from(buf.subarray(i, i + CHUNK)) as number[])
  }
  return `data:${blob.type};base64,${btoa(bin)}`
}

const EXTENSIONS: Extension[] = [
  blockIndex,
  livePreview,
  /* F80/F81/F82: file drops and tree-row drags land nowhere. CM6's default
     drop reads every File whole (an 8 s freeze at 400 MB, then every save
     refused) and inserts into whichever note is open when the read FINISHES —
     including the secrets note, where the viewer never shows it. Obsidian
     never inlines a dropped file's contents, so refusal is transcription,
     not divergence. Tree drags carry the private MIME below; anything else
     with files is refused for the same reason. Returning true stops CM6's
     own handler from running at all. */
  EditorView.domEventHandlers({
    drop(event, _view) {
      if (refuseDrop(event.dataTransfer)) {
        event.preventDefault()
        return true
      }
      return false
    },
    dragover(event, _view) {
      if (refuseDrop(event.dataTransfer)) {
        event.preventDefault()
      }
    },
    /* Pasted clipboard images land inline; everything else pastes as CM6
       pastes it.  Returning true stops CM6's own handler, which would
       otherwise insert the file's name (or nothing) beside our markdown. */
    paste(event, v) {
      const file = firstClipboardImage(event.clipboardData)
      if (!file) return false
      if (v.state.readOnly || open === null || secretMode) return false
      event.preventDefault()
      // F38's shape at paste scale: the read is async and the user may switch
      // notes while it is in flight — the image then belongs to neither note,
      // so it is dropped rather than written into the wrong one.
      const path = open.path
      void blobToDataUrl(file).then((url) => {
        if (currentPath() !== path || v.state.readOnly) return
        const sel = v.state.selection.main
        v.dispatch({
          changes: { from: sel.from, to: sel.to, insert: `![pasted image](${url})` },
          scrollIntoView: true,
          userEvent: 'input.paste-image',
        })
      }).catch((e: unknown) => {
        console.error('cairn[image-paste]: ' + (e instanceof Error ? e.message : String(e)))
      })
      return true
    },
  }),
  /* §0.38 E85 — the link click, `KNOWN-ISSUES.md` LP-1 closed.  A `click`
     handler and not `mousedown`, which is Obsidian's own choice and load-
     bearing: it bails on a non-collapsed selection, so a drag that selects the
     text of a link does not navigate on release. */
  linkClicks,
  /* §0.31 E75 — the hanging indent on a wrapped list line.  A ViewPlugin with
     no decorations: it measures the bullet's prefix and writes `text-indent` /
     `padding-inline-start` on the line element inside CM6's own measure cycle,
     which is Obsidian's own mechanism and the only one that can answer for a
     prefix whose width is whatever the font makes it. */
  listHangingIndent,
  titleField,
  /* AFTER `titleField`, and the order is load-bearing for the reading order:
     the title is a block widget at position 0 with `side: -1`, so it renders
     BEFORE anything covering `[0, n]`, and the Properties block covering the
     frontmatter therefore lands between the title and the first body line —
     which is where Obsidian puts it (`sizerEl.prepend(metadataEditor)` then
     `sizerEl.prepend(inlineTitleEl)`, app.js 1.12.7). */
  properties,
  /* §0.40 E87 — a markdown table renders as a table.  AFTER `properties` for
     the same reason `properties` is after `titleField`: both are block
     replacements from a StateField, and the reading order is the order the
     ranges appear in the document, which CM6 resolves by position — the only
     thing declaration order decides here is that `tableIndex` is initialised
     before the field that reads it. */
  tables,
  /* §0.46 E94 — the `totp` fenced block.  AFTER `tables` for the same reason
     `tables` is after `properties`: these are all block widgets and CM6 takes
     block decorations in the order their fields are declared.  It contributes
     ONE field — `blockIndex` (from `livePreview`) and `editorFocused` (from
     `tables`) are already in the set, and this reads both rather than adding a
     second fence scanner or a second focus reporter. */
  totp,
  livePreviewAtomicRanges,
  /* In-note find's mark layer.  A pure mark set alongside the others: no block
     widget, no ordering constraint, initialised with the rest per M70. */
  findSpecField,
  findHighlightDeco,
  EditorView.lineWrapping,
  scrollPastEnd,
  EditorView.darkTheme.of(true),
  history({ minDepth: 40, newGroupDelay: 400 }),
  keymap.of([
    ...historyKeymap,
    ...standardKeymap,
    { key: 'Tab', run: insertIndent, shift: removeIndent, preventDefault: true },
    // Must return true so WKWebView does not open its own save dialog.
    { key: 'Mod-s', run: () => { void flushNow('manual').catch(() => {}); return true } },
  ]),
  EditorState.tabSize.of(4),
  editable.of([]),
  EditorView.contentAttributes.of({
    spellcheck: 'false',
    autocorrect: 'off',
    autocapitalize: 'off',
    translate: 'no',
    'aria-label': 'Note editor',
  }),
  EditorView.updateListener.of(onUpdate),
]

/* ===========================================================================
 * 4.  Mounting.
 * ========================================================================= */

export function configureEditor(transport: EditorIpc): void {
  ipc = transport
}

export function setEditorHooks(h: EditorHooks): void {
  hooks = h
}

export function mountEditor(host: HTMLElement): void {
  if (view) return
  setInitialTitle(null)
  view = new EditorView({
    parent: host,
    state: EditorState.create({ doc: '', extensions: EXTENSIONS }),
  })
  // The secrets viewer lives beside `#ed`, not inside it: hiding the CM6
  // view must not hide the viewer with it.
  const parent = host.parentElement ?? null
  if (parent) {
    const root = document.createElement('div')
    root.className = 'nc-secrets'
    root.hidden = true
    parent.appendChild(root)
    secretsRoot = root
    secretsParent = parent
  }
  reconfigureEditable()

  // §5.12.6: one number written per scroll frame, nothing read.  A
  // layout-forcing read here would cost a frame on every frame of every fling.
  view.scrollDOM.addEventListener(
    'scroll',
    () => { scrollingUntil = Date.now() + SCROLL_QUIET_MS },
    { passive: true }
  )

  // THE NOTE VIEWER'S CONTEXT MENU (Copy/Paste).  Guarded: the unit harness
  // mounts with a `dom` that has no `addEventListener`.
  if (typeof (view.dom as unknown as { addEventListener?: unknown }).addEventListener === 'function') {
    view.dom.addEventListener('contextmenu', onEditorContextMenu)
  }

  registerTitleRenameHost({ begin: beginTitleRename })

  // §7.2's unconditional flush points that belong to the window, not the shell.
  window.addEventListener('blur', () => { void backgroundFlush('blur') })
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) void backgroundFlush('hidden')
  })

  installPixeltestSeams()
}

export function focusEditor(): void {
  if (secretMode) return
  view?.focus()
}

/**
 * THE NOTE VIEWER'S CONTEXT MENU (2026-10-03): Copy and/or Paste over
 * `menu.ts`'s one primitive.
 *
 * `preventDefault()` is synchronous and unconditional (the tree's §0.13 E15
 * rationale applies verbatim: without it the engine opens its own menu as
 * well as ours).  The rows are decided ASYNCHRONOUSLY — the clipboard probe
 * is an IPC round trip — and the menu opens at the event's own point, so no
 * caret is moved and no layout is read to get there.
 *
 * Copy is offered on a non-empty selection in ANY state that holds text,
 * including the read-only ones: `detached`/`vault-lost` keep their selection
 * precisely so it can still be copied out (see `reconfigureEditable`).
 * Paste additionally needs an editable document, so the read-only states
 * never offer it.  When neither holds, no menu opens at all.
 */
function onEditorContextMenu(ev: MouseEvent): void {
  if (!view || secretMode || open === null) return
  ev.preventDefault()
  const x = ev.clientX
  const y = ev.clientY
  // Decided twice: this synchronous pass only skips the probe when there is
  // provably nothing to offer (no selection, and paste refused) — the rows
  // themselves are read after the probe lands, against the live state.
  if (view.state.selection.main.empty && view.state.readOnly) return
  void (async () => {
    let clip = ''
    try {
      clip = ipc?.readClipboardText
        ? await ipc.readClipboardText()
        : await navigator.clipboard.readText()
    } catch {
      clip = ''
    }
    const v = view
    if (!v || secretMode || open === null) return
    const hasSelection = !v.state.selection.main.empty
    const canPaste = !v.state.readOnly && clip.length > 0
    if (!hasSelection && !canPaste) return
    const clipText = clip
    openMenu(
      clipMenu({
        hasSelection,
        canPaste,
        copy: () => {
          const vv = view
          const s = vv?.state.selection.main
          if (!vv || !s || s.empty) return
          const text = vv.state.doc.sliceString(s.from, s.to)
          // `navigator.clipboard` first: it has no length cap (command 23
          // refuses more than 4096 characters).  `activate()` in menu.ts runs
          // this synchronously inside the click task, preserving the
          // transient activation the async clipboard is gated on.  When the
          // window is unfocused the write rejects ("Document is not
          // focused") and the IPC fallback — which has no focus requirement
          // — takes over instead of failing silently.
          const fallback = (): void => {
            if (ipc?.writeClipboardText) {
              void ipc.writeClipboardText(text).catch((e: unknown) => {
                console.error('cairn[editor-copy]: ' + (e instanceof Error ? e.message : String(e)))
              })
            } else {
              console.error('cairn[editor-copy]: clipboard write failed and no IPC fallback is configured')
            }
          }
          try {
            void navigator.clipboard.writeText(text).catch(() => fallback())
          } catch {
            fallback()
          }
        },
        paste: () => {
          const vv = view
          if (!vv || secretMode || open === null || vv.state.readOnly) return
          if (!clipText) return
          const s = vv.state.selection.main
          vv.dispatch({
            changes: { from: s.from, to: s.to, insert: clipText },
            scrollIntoView: true,
            userEvent: 'input.paste',
          })
        },
      }),
      { x, y, label: 'Note actions', cls: 'ctx-clip' }
    )
  })()
}

export function isDirty(): boolean {
  return dirty
}

export function currentPath(): string | null {
  return open ? open.path : null
}

export function currentNoteState(): NoteState {
  return noteState
}

/**
 * F66: leave `vault-lost` when the vault is back. The base-mtime guard stays
 * the detector — a note changed while the vault was away still comes back as
 * a conflict on the next write, and a note that vanished is caught when the
 * tree refresh marks it detached. Without this, a re-opened vault left the
 * note read-only with autosave off and no visible way to save it.
 */
export function resumeAfterVaultRestored(): void {
  if (noteState !== 'vault-lost' || !open) return
  setNoteState('live', null)
  if (dirty) scheduleAutosave()
}

export function lastNoteError(): VaultErrorLike | null {
  return lastError
}

/* ===========================================================================
 * 5.  Opening, switching and the empty state.
 * ========================================================================= */

function rememberCursor(): void {
  if (!view || !open || secretMode) return
  const sel = view.state.selection.main
  cursors.delete(open.path)
  cursors.set(open.path, { anchor: sel.anchor, head: sel.head, scrollTop: view.scrollDOM.scrollTop })
  while (cursors.size > CURSOR_LRU_MAX) {
    const oldest = cursors.keys().next()
    if (oldest.done) break
    cursors.delete(oldest.value)
  }
}

/** §7.3 case 4 / §5.4.2: re-key the caret memo in the same step as the path. */
function rekeyCursor(from: string, to: string): void {
  const memo = cursors.get(from)
  cursors.delete(from)
  if (memo) cursors.set(to, memo)
}

/** §9.6: on delete, evict.  A recreated path is a different note. */
export function forgetCursor(path: string): void {
  cursors.delete(path)
}

function basenameNoMd(path: string): string {
  const slash = path.lastIndexOf('/')
  const name = slash < 0 ? path : path.slice(slash + 1)
  return name.endsWith('.md') ? name.slice(0, -3) : name
}

function buildDoc(path: string, text: string): EditorState {
  // F42/F84: building the state can THROW (a decoration or widget over the
  // note's text). Callers build first and only assign `open` after success,
  // so a failed open leaves the previous note bound to its own path.
  // Set the title BEFORE the state exists so it is present on the very first
  // layout: the first body line's box top is then 113.0656 from frame one
  // (§5.4.2; was 113.8 before spike Q re-derived the ladder and the inset).
  setInitialTitle(basenameNoMd(path))
  return EditorState.create({ doc: text, extensions: EXTENSIONS })
}

function applyDoc(v: EditorView, path: string, next: EditorState): void {
  v.setState(next)
  syncSecretMode()
  if (secretMode) return
  const memo = cursors.get(path)
  const len = v.state.doc.length
  if (memo) {
    const anchor = Math.min(memo.anchor, len)
    const head = Math.min(memo.head, len)
    v.dispatch({ selection: EditorSelection.range(anchor, head) })
    v.scrollDOM.scrollTop = memo.scrollTop
  }
}

/**
 * spec-03 §3's public API.  A note switch flushes FIRST and is ABORTED on a
 * rejection (§9.2) — the buffer is never dropped to open something else.
 * A RESOLVED flush is NOT proof of a write (see `flushWouldSkip`): when the
 * note is conflicted/detached/vault-lost the flush resolves `skipped` and the
 * buffer stays dirty, so the switch aborts exactly as on rejection.
 */
export async function openNote(path: string): Promise<OpenResult> {
  const v = view
  const t = ipc
  if (!v) return { ok: false, path, err: fail('io', 'editor not mounted') }
  if (!t) return { ok: false, path, err: fail('io', 'editor transport not configured') }

  cancelTimers()
  rememberCursor()
  // F83: a Properties field being typed is not in the doc — commit it into
  // the old buffer before the switch flush below can miss it.
  commitFocusedWidgetEditor()
  if (open && dirty) {
    try {
      await flushNow('switch')
    } catch (e) {
      return { ok: false, path, err: asVaultError(e) }
    }
    if (dirty) {
      return { ok: false, path, err: lastError ?? fail('conflict', 'the note was not saved') }
    }
  }

  // F38: keystrokes typed into the old note while B's read is in flight.
  const gen = docGen
  let read: NoteReadLike
  try {
    read = await t.readNote(path)
  } catch (e) {
    return { ok: false, path, err: asVaultError(e) }
  }
  if (docGen !== gen) {
    try {
      await flushNow('switch')
    } catch (e) {
      return { ok: false, path, err: asVaultError(e) }
    }
    if (dirty) {
      return { ok: false, path, err: lastError ?? fail('conflict', 'the note was not saved') }
    }
  }

  let next: EditorState
  try {
    next = buildDoc(path, read.text)
  } catch (e) {
    // F42/F84: the new state failed to build — `open` still names the
    // previous note, which is what the view shows, so autosave keeps
    // writing A to A and the failed open reports instead of clobbering.
    return { ok: false, path, err: fail('io', 'could not open ' + path + ': ' + String(e)) }
  }
  open = {
    path,
    baseMtimeMs: read.mtimeMs,
    flags: read.flags,
    bytes: read.bytes ?? utf8Len(read.text),
  }
  docGen++
  applyDoc(v, path, next)
  // `applyDoc` synced secret mode against the previous `open`; re-sync now
  // that `open` names the new note (matters when it was null — fresh boot).
  syncSecretMode()
  setDirty(false)
  setNoteState('live', null)
  hooks.onPathChanged?.(path)
  return { ok: true, path, bytes: open.bytes }
}

/**
 * Secret-file creation's second half (`main.ts` does the `createNote`): fill
 * a fresh EMPTY note with the template.  Refuses anything else — overwriting
 * a non-empty document from a creation gesture would be data loss wearing a
 * template's clothes.  The dispatch flips secret mode on through `onUpdate`.
 */
export function fillEmptyNote(text: string): boolean {
  if (!view || !open || secretMode) return false
  if (view.state.doc.length !== 0) return false
  view.dispatch({ changes: { from: 0, insert: text }, userEvent: 'input.secret-template' })
  return true
}

/**
 * SEAM ADDED BY THE INTEGRATOR, and reported rather than designed here.
 *
 * `src/search.ts`'s `SearchDeps.openResult(rel, line, col, len)` is normative
 * (spec-05 §9): clicking a result opens the note and SELECTS the match.  This
 * module exported `openNote` and no way to place a selection, so the second
 * half of that dependency had nowhere to land — the panel could open a note but
 * never show the user which hit they clicked.  This is the smallest thing that
 * closes it, and it is the editor's to own because the CM6 `EditorView` is
 * module-private and there is exactly one of it for the process lifetime (M70).
 *
 * CLAMPED, deliberately.  `line`/`col`/`len` come from a scan that finished
 * before the click, and spec-05 §9 says so explicitly: the file may have been
 * shortened, or the line may have been deleted outright, between the grep and
 * the click.  An out-of-range line is not an error — it resolves to the end of
 * the document and the caret simply lands there.
 *
 * `line` is 1-BASED (§1.5 `Snippet.line`); `col` and `len` are UTF-16 code
 * units within that line, which is the same space CM6 counts in, so no
 * conversion happens anywhere.
 */
export function selectRange(line: number, col: number, len: number): void {
  const v = view
  if (!v || secretMode) return
  const doc = v.state.doc
  const n = Math.min(Math.max(1, Math.trunc(line)), doc.lines)
  const l = doc.line(n)
  const from = Math.min(l.from + Math.max(0, col), l.to)
  const to = Math.min(from + Math.max(0, len), l.to)
  v.dispatch({
    selection: EditorSelection.range(from, to),
    scrollIntoView: true,
  })
  v.focus()
}

/**
 * In-note find's narrow seam into the single EditorView (src/find.ts).
 *
 * NOTE VIEWER ONLY: the Memoir journal page is a plain textarea outside this
 * module and never reaches these functions — `main.ts` refuses the Mod-F
 * toggle while the page is visible and hides the bar on every route to it.
 * Secret files are refused here too: the viewer replaces the editor, so
 * `findDocText` is null and the panel cannot open over it.
 */
export function findDocText(): string | null {
  const v = view
  if (!v || !open || secretMode) return null
  try {
    return v.state.doc.toString()
  } catch {
    return null
  }
}

/** The current selection, for find prefill. Single short line only. */
export function findSelectionText(): string {
  const v = view
  if (!v || secretMode) return ''
  try {
    const sel = v.state.selection.main
    if (sel.empty) return ''
    const t = v.state.doc.sliceString(sel.from, sel.to)
    if (t.length === 0 || t.length > 100 || t.includes('\n')) return ''
    return t
  } catch {
    return ''
  }
}

/** Select [from, to) and scroll it into view. Keeps focus where it is, so
 *  typing in the find field is not interrupted by every keystroke's reveal. */
export function findReveal(from: number, to: number): void {
  const v = view
  if (!v || !open || secretMode) return
  const len = v.state.doc.length
  const a = Math.max(0, Math.min(Math.trunc(from), len))
  const b = Math.max(a, Math.min(Math.trunc(to), len))
  v.dispatch({
    selection: EditorSelection.range(a, b),
    scrollIntoView: true,
  })
}

export function onFindDocChanged(cb: () => void): () => void {
  findListeners.add(cb)
  return () => {
    findListeners.delete(cb)
  }
}

/** Paint the find mark layer. No-op without a view; a fresh `EditorState`
 *  (note switch, empty) builds fresh fields and needs none. */
export function setFindHighlightInView(
  query: string,
  caseSensitive: boolean,
  from: number,
  to: number,
): void {
  const v = view
  if (!v) return
  v.dispatch({
    effects: setFindHighlight.of({ query, caseSensitive, from, to }),
  })
}

/** §7.4's empty state.  Writes nothing, ever. */
export function showEmpty(): void {
  cancelTimers()
  rememberCursor()
  open = null
  setDirty(false)
  docGen++
  const wasSecret = secretMode
  secretMode = false
  if (view) {
    // `#ed` was hidden only on entering secret mode (which needs
    // `secretsRoot`, and the unit harness mounts with a host that has none),
    // so leaving any other state resets nothing.
    if (wasSecret) secretsParent?.classList.remove('is-secret')
    setInitialTitle(null)
    view.setState(EditorState.create({ doc: '', extensions: EXTENSIONS }))
  }
  if (secretsRoot) secretsRoot.hidden = true
  setNoteState('live', null)
  hooks.onEmpty?.()
}

/** §7.3 case 4: an in-app rename of the open note (or an ancestor of it). */
/**
 * F35: adopt a finished rename/move — but only if the open note is still the
 * thing that was renamed. `oldPath` is re-read against `open.path` AT CALL
 * TIME, not captured before the await: a note switch during the IPC (which
 * re-walks the vault before replying) must not relabel the newly opened note
 * as the renamed file — the next autosave would then write B's text to A's
 * new path. A folder rename re-bases an open note under it; an unrelated
 * prefix (`Projectsx` vs `Projects`) is left alone.
 */
export function adoptRenamedPath(oldPath: string, newPath: string): void {
  if (!open) return
  let next: string | null = null
  if (open.path === oldPath) next = newPath
  else if (open.path.startsWith(oldPath + '/')) next = newPath + open.path.slice(oldPath.length)
  if (next === null) return
  rekeyCursor(open.path, next)
  open.path = next
  view?.dispatch({ effects: setTitle.of(basenameNoMd(next)) })
  hooks.onPathChanged?.(next)
}

/** §7.3 case 5: the open path no longer resolves after a tree rebuild. */
export function markDetached(): void {
  setNoteState('detached', fail('notFound', 'renamed or removed outside the app'))
}

/** §7.3 case 8: `nc://vault-lost`.  Chrome owns the banner; this owns the buffer. */
export function markVaultLost(): void {
  setNoteState('vault-lost', fail('vaultLost'))
}

/**
 * §7.3 case 7 / spec-03 §9.5.  A CLEAN buffer reloads silently; a dirty one
 * does nothing at all until the next write refuses — the conflict guard is the
 * detector, not the event.
 */
export async function noteExternalChange(path: string, mtimeMs?: number, size?: number): Promise<void> {
  if (!open || !ipc || open.path !== path) return
  // F90: a metadata-only change carries the same mtime and size — it is not
  // a content change, so skip the reload (which rebuilds every widget and
  // drops uncommitted field text) instead of re-reading a clean note.
  if (
    mtimeMs !== undefined && size !== undefined &&
    mtimeMs === open.baseMtimeMs && size === open.bytes
  ) {
    return
  }
  // F83: a Properties field being typed is not in the doc — commit it first,
  // and the buffer a reload would destroy is dirty, so keep it instead.
  commitFocusedWidgetEditor()
  if (dirty) return
  // F38: keystrokes typed while the read below is in flight.
  const gen = docGen
  const read = await ipc.readNote(path).catch(() => null)
  if (!read || !view || !open || open.path !== path || dirty || docGen !== gen) return
  rememberCursor()
  // F42: build first — on failure leave the old baseMtimeMs so the next
  // write raises a real conflict instead of silently overwriting.
  let next: EditorState
  try {
    next = buildDoc(path, read.text)
  } catch {
    return
  }
  open.baseMtimeMs = read.mtimeMs
  open.flags = read.flags
  open.bytes = read.bytes ?? utf8Len(read.text)
  docGen++
  applyDoc(view, path, next)
  setDirty(false)
}

/* ===========================================================================
 * 6.  Autosave (§7.2) and the flush points (spec-03 §9.2).
 * ========================================================================= */

function cancelTimers(): void {
  if (idleTimer !== null) { clearTimeout(idleTimer); idleTimer = null }
  if (maxTimer !== null) { clearTimeout(maxTimer); maxTimer = null }
}

function scrollBusy(): boolean {
  return Date.now() < scrollingUntil
}

function scheduleAutosave(): void {
  if (noteState !== 'live' || !open) return
  if (idleTimer !== null) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => { idleTimer = null; timerFired('idle') }, IDLE_MS)
  // The ceiling is measured from the FIRST unsaved keystroke, not the last.
  if (maxTimer === null) {
    maxTimer = setTimeout(() => { maxTimer = null; timerFired('max') }, MAX_MS)
  }
}

/**
 * §5.12.6: the serialise must not land on a frame in which a scroll is in
 * flight.  The debounce already gives it somewhere else to go, so a timer that
 * fires mid-fling simply re-arms itself; it never drops the write.
 */
function timerFired(reason: FlushReason): void {
  if (scrollBusy()) {
    idleTimer = setTimeout(() => { idleTimer = null; timerFired(reason) }, SCROLL_QUIET_MS)
    return
  }
  void backgroundFlush(reason)
}

function backgroundFlush(reason: FlushReason): Promise<void> {
  return flushNow(reason).catch((e: unknown) => {
    hooks.onFlushError?.(reason, asVaultError(e))
  })
}

/**
 * THE one write chain.  EVERY call that reaches `writeNote` goes through here —
 * autosave, `flushNow`, `keepMine` and `saveAs` alike — because `settleWrites()`
 * can only wait for work that is ON the chain.  A write issued outside it is
 * invisible to the §7.3 case 3 guard, which is exactly how `saveAs` used to
 * re-open finding F3's ~5.04 ms in-flight window: the guard could return
 * `'proceed'` with a *Save as…* rename still running inside Rust.
 *
 * `chain` keeps a SWALLOWED copy of the tail, so one refused write can never
 * poison the next caller (dirty-delete.test.mjs pins that).  The returned
 * promise is the UNswallowed one — `flushNow`'s rejection is load-bearing.
 */
function enqueue<T>(run: () => Promise<T>): Promise<T> {
  const p = chain.then(run, run)
  chain = p.catch(() => {})
  return p
}

/**
 * F35: run `fn` on the editor's serialising write chain. A rename or move of
 * the open note (or its ancestor) must not overlap a write: a write that
 * passed step 1 renames its temp over the OLD path after the move (a
 * duplicate the self-write suppression can hide from the tree), and the
 * rename's own receipt handling races the write's. `main.ts` runs the tree's
 * rename/move through this; `delete` already goes through
 * `guardDeleteOfOpenNote` for the same reason.
 */
export function runOnWriteChain<T>(run: () => Promise<T>): Promise<T> {
  return enqueue(run)
}

/**
 * TRUE when a flush for `reason` would return WITHOUT WRITING ANYTHING.
 *
 * THIS IS `write()`'s OWN GUARD, NAMED AND EXPORTED, and `write()` calls it
 * rather than restating it — the two cannot drift.  It exists because the
 * silent-skip case is not observable from `flushNow()`'s promise: that promise
 * RESOLVES on every row below.
 *
 *   - no note open, no view, no transport  — nothing to write;
 *   - `!dirty`                             — nothing to write;
 *   - `noteState !== 'live'` and `reason !== 'manual'` — §7.2/§9.5 STOP autosave
 *     for a conflicted, detached or vault-lost note.  `manual` is the single
 *     exemption, because it is the user asking in so many words.
 *
 * The third row is a data-loss path the moment a caller treats a resolved
 * `flushNow()` as "the bytes are on disk": that is precisely what §7.3 case 3's
 * "Save and delete" did on a conflicted note before errata 3 Z5 — it reported a
 * save, saved nothing, and deleted the file.  Any caller that acts destructively
 * on a resolved flush (deleting the file, closing the window, dropping the
 * buffer) MUST consult this or `isDirty()` first.
 */
export function flushWouldSkip(reason: FlushReason): boolean {
  if (view === null || ipc === null || open === null) return true
  if (!dirty) return true
  return noteState !== 'live' && reason !== 'manual'
}

/**
 * REJECTS with a VaultError when the write is refused.  The rejection is
 * load-bearing: §1.6 cancels the close on it and §4.3 aborts the vault switch
 * on it.  It must never be swallowed into a resolved promise.
 *
 * A RESOLUTION, HOWEVER, IS NOT PROOF OF A WRITE.  This resolves unchanged
 * whenever `flushWouldSkip(reason)` is true — most sharply on a note whose
 * `noteState` is not `live`, where §7.2 has stopped autosave — and it resolves
 * after a write whose generation was outrun, which re-arms the debounce instead
 * of clearing `dirty`.  The signature cannot say so (`Promise<void>` is what
 * `chrome.ts` and `tabstrip.ts` accept), so the check is `flushWouldSkip()`
 * BEFORE and `isDirty()` AFTER.  `guardDeleteOfOpenNote` below does both.
 */
export function flushNow(reason: FlushReason): Promise<void> {
  cancelTimers()
  return enqueue(async (): Promise<void> => { await write(undefined, reason) })
}

/* ===========================================================================
 * 6a.  §7.3 case 3 — the dirty-delete guard (errata 3, Z5).
 *
 * ADDED UNDER A NARROW, DECLARED GRANT.  This module is owner 03's; the fix for
 * `docs/DATA-LOSS-VERIFICATION.md` finding F1 spans two owners and Z5's table
 * puts steps 1-4 HERE and steps 5-6 in `main.ts`.  Exactly four exports and
 * one widened union were added: `settleWrites`, `flushWouldSkip`, `DeleteGuard`,
 * `guardDeleteOfOpenNote`, `FlushReason |= 'delete'`, plus the `openModal`
 * import.
 *
 * WHY THE DECISION LIVES HERE AND NOT IN THE CALLER.  `main.ts` used to make it
 * — or rather, it never made it at all: `deleteFlow()` showed a two-button
 * dialog that never read `isDirty()`, so deleting the open note with unsaved
 * edits trashed the PRE-EDIT file and dropped the buffer.  A caller that reads
 * `isDirty()` and then acts on it across two awaits is reading a value that can
 * change under it: the idle timer, the 5 s ceiling, a blur flush and a
 * `visibilitychange` flush can all land in between.  The dirty flag, both
 * timers, the write chain and `flushNow` are all module state in here, so the
 * decision is made where it cannot go stale.
 * ========================================================================= */

/**
 * Resolve when no write is in flight.  Issues no write of its own and NEVER
 * rejects.
 *
 * THIS IS WHAT CLOSES FINDING F3'S WINDOW, and it is three lines because
 * `flushNow`, `keepMine` and every autosave already serialise through one
 * promise chain.  F3, exactly: `x-create: '0'` (§7.1 rule 1) makes an autosave
 * issued AFTER the delete unable to resurrect the note — step 1b stats the
 * destination, finds it gone, returns `NotFound`, and `dl_05` proves it.  It
 * does NOT close a write that had already passed step 1b when the delete
 * landed, because step 8's `fs::rename` creates the destination whether or not
 * it existed.  That window is `write_all` + `sync_data`, measured at 5.04 ms
 * for an 11 KB note on APFS.  Cancelling the timers does not close it either:
 * cancelling stops a write from being ISSUED and does nothing to one already
 * running.
 *
 * Awaiting the chain does, because the chain's tail is the `writeNote` INVOKE,
 * and that promise resolves only after Rust has returned a receipt — i.e. after
 * step 8's rename has already happened.  So when this resolves, there is no
 * rename left to race.
 *
 * THAT HOLDS ONLY WHILE EVERY WRITE IS ON THE CHAIN.  `saveAs` used to call
 * `writeNote` outside it, which made this claim ("closed, not merely narrowed")
 * false for an in-flight *Save as…*; `enqueue()` is now the single door and
 * `flushNow`, `keepMine` and `saveAs` all go through it.  Anything added here
 * that writes must too, or F3's window silently re-opens.
 */
export function settleWrites(): Promise<void> {
  const done = (): void => {}
  const p = chain.then(done, done)
  chain = p
  return p
}

export type DeleteGuard = 'proceed' | 'abort'

/**
 * §7.3 case 3, steps 1-4.  Call before `delete_entry` whenever the entry being
 * deleted IS the open note or is an ancestor folder of it.  Never throws.
 *
 * The caller is responsible for the "is it the open note" test — `currentPath()`
 * — because deleting an UNRELATED note while the open one happens to be dirty
 * must not prompt.
 */
export async function guardDeleteOfOpenNote(displayName: string): Promise<DeleteGuard> {
  // Step 1: cancel BOTH timers, then settle.  The settle comes first so that
  // the `dirty` the modal branches on is not about to be invalidated by a write
  // that is already landing — if it is, `dirty` goes false and there is nothing
  // to prompt about.
  cancelTimers()
  await settleWrites()

  if (open === null) return 'proceed'

  // Step 2.
  if (dirty) {
    const pick = await openModal({
      title: `${displayName} has unsaved changes.`,
      detail: 'Deleting it now will move the file to the Trash without these changes.',
      buttons: [
        { id: 'cancel', label: 'Cancel' },
        { id: 'save', label: 'Save and delete' },
        { id: 'delete', label: 'Delete without saving', destructive: true },
      ],
      defaultId: 'cancel',
    })

    if (pick === 'cancel') return 'abort'

    if (pick === 'save') {
      // Step 3.  ON REJECT, ABORT THE DELETE AND SHOW THE ERROR.  The file on
      // disk is then the only copy of the old content and the buffer is the
      // only copy of the edits; deleting anyway destroys both in one move.
      try {
        await flushNow('delete')
      } catch (e) {
        hooks.onFlushError?.('delete', asVaultError(e))
        return 'abort'
      }
      // A RESOLVED FLUSH IS NOT PROOF OF A WRITE — see `flushWouldSkip()`.
      // `write()` returns `'skipped'`, resolving, when `noteState !== 'live'`
      // and the reason is not `manual`; and when `docGen` moved during the
      // write it re-arms autosave instead of clearing `dirty`.  Either way the
      // buffer is still dirty and "Save and delete" has not saved anything, so
      // treat it exactly like a rejection.  Without this row the conflict state
      // is a silent data-loss path straight through the button whose label
      // promises a save.
      if (dirty) {
        hooks.onFlushError?.('delete', lastError ?? fail('conflict', 'the note was not saved'))
        return 'abort'
      }
    } else if (pick === 'delete') {
      // 'delete' — the explicitly labelled destructive choice.  Clearing dirty
      // is step 4's first half and is what stops every later flush point:
      // `write()` returns on `!dirty && !create`.
      setDirty(false)
    } else {
      // F52: anything else — including a refusal answered with another
      // dialog's default — aborts. Reading an unknown id as 'delete' discarded
      // the buffer and deleted the note.
      return 'abort'
    }
  }

  // Step 4, second half.  The SECOND settle is not belt and braces: §7.2
  // flushes unconditionally on window blur and `visibilitychange`, and the user
  // can blur the window while the modal above is open — so a write can have
  // been issued between the first settle and here.
  await settleWrites()

  // "Clear the frontend's activePath."  Dropping the handle is what makes a
  // further write IMPOSSIBLE rather than merely unlikely: `scheduleAutosave()`
  // returns on `!open`, `write()` returns on `!note`, and `flushNow` therefore
  // resolves without touching the disk.  Without it the user can still type
  // during `delete_entry`'s IPC round trip, and only `x-create: '0'` would be
  // left to catch the result.
  //
  // The contract prints this on the two dirty branches; it is done on the
  // clean branch too, which is strictly safer and never loses anything —
  // `dirty` is false on every path that reaches this line.
  //
  // THE CALLER'S OBLIGATION, and `main.ts` honours it: once this returns
  // `'proceed'` the editor has no open note, so `showEmpty()` MUST run on every
  // exit path afterwards — including the one where `delete_entry` itself fails
  // — or the pane is left showing text it can no longer save.
  rememberCursor()
  open = null
  setDirty(false)
  reconfigureEditable()

  return 'proceed'
}

/**
 * What a flush actually did.  `'skipped'` is returned, never thrown, on every
 * `flushWouldSkip()` row; `'written'` means `writeNote` returned a receipt —
 * i.e. Rust's atomic rename has already happened.
 *
 * The two are a TYPE and not a comment so that a future edit which adds another
 * early return has to say which one it is.
 */
type WriteOutcome = 'written' | 'skipped'

/**
 * §7.1 rule 1 IS THIS SIGNATURE: there is no `create` parameter, so no autosave,
 * idle, blur, close or *Keep mine* write can ever set `x-create: '1'`.  The one
 * `create: true` call site in the app is `doSaveAs` below (X16, dl_06).
 */
async function write(
  baseOverride: number | null | undefined,
  reason: FlushReason
): Promise<WriteOutcome> {
  const v = view
  const t = ipc
  const note = open
  // The three narrowings are TypeScript's; the policy is `flushWouldSkip`'s, and
  // it is tested there so the guard above and this line cannot drift apart.
  if (!v || !t || !note || flushWouldSkip(reason)) return 'skipped'

  const gen = docGen
  const text = v.state.doc.toString()
  const base = baseOverride === undefined ? note.baseMtimeMs : baseOverride
  try {
    const receipt = await t.writeNote(note.path, text, note.flags, base, false)
    if (open === note) {
      note.baseMtimeMs = receipt.mtimeMs
      note.bytes = utf8Len(text)
      if (docGen === gen) setDirty(false)
      else scheduleAutosave()
      if (noteState === 'conflict') setNoteState('live', null)
    }
    return 'written'
  } catch (e) {
    const err = asVaultError(e)
    // §7.2: on Conflict the buffer stays dirty and autosave STOPS for this note.
    if (err.kind === 'conflict' && open === note) setNoteState('conflict', err)
    throw err
  }
}

/**
 * §7.3 case 7's *Keep mine*: re-write with `x-base-mtime: ""` (force overwrite).
 * Before the overwrite, the DISK (losing) version is snapshotted to a
 * `<stem>.conflict-<secs>.md` sidecar in the same folder through the ordinary
 * create/write commands — best effort, never vetoing the overwrite the user
 * asked for.  Without a `createNote` transport (older test harnesses) the
 * backup is skipped and the overwrite still proceeds.
 */
export function keepMine(): Promise<void> {
  return enqueue(async (): Promise<void> => {
    await snapshotLoserForKeepMine()
    await write(null, 'manual')
  })
}

/** Best-effort backup of the disk bytes `keepMine()` is about to destroy. */
async function snapshotLoserForKeepMine(): Promise<void> {
  const t = ipc
  const note = open
  if (!t || !note || typeof t.createNote !== 'function') return
  let disk: NoteReadLike
  try {
    disk = await t.readNote(note.path)
  } catch {
    return // gone or unreadable: nothing to preserve
  }
  if (disk.text === '') return // empty loser: no bytes worth a sidecar
  const slash = note.path.lastIndexOf('/')
  const parent = slash < 0 ? '' : note.path.slice(0, slash)
  const base = slash < 0 ? note.path : note.path.slice(slash + 1)
  const stem = base.endsWith('.md') ? base.slice(0, -3) : base
  if (stem === '' || stem.startsWith('.') || stem.includes('/')) return
  const secs = Math.floor(Date.now() / 1000)
  for (let n = 0; n < 32; n++) {
    const name = n === 0 ? `${stem}.conflict-${secs}` : `${stem}.conflict-${secs}-${n}`
    try {
      const created = await t.createNote(parent, name)
      try {
        await t.writeNote(created.path, disk.text, disk.flags, null, false)
      } catch {
        // Backup file created but content write failed: leave the empty file
        // rather than failing the overwrite over it — the user asked for the
        // overwrite, and an empty placeholder still names the attempt.
      }
      return
    } catch (e) {
      // `alreadyExists` (a backup from the same second, or a real note): try
      // the next suffix.  Any other failure: give up on the backup.
      if (e && typeof e === 'object' && (e as { kind?: string }).kind === 'alreadyExists') continue
      return
    }
  }
}

/** §7.3 case 7's *Reload from disk*: discard the buffer after re-reading. */
export async function reloadFromDisk(): Promise<void> {
  if (!open || !ipc || !view) return
  const path = open.path
  const read = await ipc.readNote(path)
  if (!open || open.path !== path) return
  // F42: build first — a note whose new text cannot render keeps its old
  // base, so the conflict bar (not a silent overwrite) is what surfaces.
  let next: EditorState
  try {
    next = buildDoc(path, read.text)
  } catch (e) {
    throw fail('io', 'could not reload ' + path + ': ' + String(e))
  }
  open.baseMtimeMs = read.mtimeMs
  open.flags = read.flags
  open.bytes = read.bytes ?? utf8Len(read.text)
  docGen++
  cursors.delete(path)
  applyDoc(view, path, next)
  setDirty(false)
  setNoteState('live', null)
}

/**
 * §7.3 case 5's *Save as…* — the ONLY producer of `x-create: '1'` in the whole
 * app (X16).  No base mtime: there is nothing to conflict against.  An existing
 * destination comes back `alreadyExists` (§7.1 step 1c) and the editor stays open.
 *
 * The body is separate from the export below only so that the export can put it
 * ON the chain; see `saveAs`.
 */
async function doSaveAs(newPath: string): Promise<void> {
  const note = open
  if (!note) return
  const v = view
  const t = ipc
  if (!v || !t) return
  const text = v.state.doc.toString()
  const receipt = await t.writeNote(newPath, text, note.flags, null, true)
  if (open !== note) return
  rekeyCursor(note.path, newPath)
  note.path = newPath
  note.baseMtimeMs = receipt.mtimeMs
  note.bytes = utf8Len(text)
  v.dispatch({ effects: setTitle.of(basenameNoMd(newPath)) })
  hooks.onPathChanged?.(newPath)
  setDirty(false)
  setNoteState('live', null)
}

/**
 * ON THE CHAIN, AND THAT IS THE WHOLE POINT OF THIS WRAPPER.
 *
 * `saveAs` used to call `writeNote` directly.  Two things were wrong with that,
 * and only the second one is visible from a branch test:
 *
 *   1. It raced the autosave.  A *Save as…* issued while an idle flush was on
 *      the wire could interleave `note.path` and `note.baseMtimeMs` with the
 *      older write's receipt handling, so the receipt for the OLD path could
 *      land on the NEW one.
 *   2. `settleWrites()` could not see it.  The chain's tail is the `writeNote`
 *      invoke, which resolves only after Rust's step 8 rename — that is what
 *      makes `settleWrites()` close finding F3's ~5.04 ms window rather than
 *      narrow it.  A write outside the chain is simply not waited for, so
 *      `guardDeleteOfOpenNote` could return `'proceed'` with a rename genuinely
 *      in flight.  It targets a DIFFERENT path, so it could not resurrect the
 *      note being deleted — but the invariant the contract states ("closed, not
 *      merely narrowed") was false as written, and an invariant that is true
 *      only by accident of the destination path is not an invariant.
 */
export function saveAs(newPath: string): Promise<void> {
  return enqueue(() => doSaveAs(newPath))
}

/**
 * §1.6's frontend half.  The shell listens for `nc://flush-and-close` and calls
 * this; `{ok:false}` means `confirm_close(false, kind)` and the modal — a flush
 * that REJECTS cancels the close.  Only a flush that has not returned at all
 * after 2,000 ms may fall through to Rust's watchdog, which is why this never
 * imposes a timeout of its own.
 */
/**
 * F83: commit a Properties field being typed. The value/key editors hold
 * their text in widget DOM until Enter or blur; blurring commits it into the
 * CM6 document (and marks it dirty) through the editors' own blur handlers.
 * Scoped to `.cm-content` so a focused control elsewhere (search, prompts)
 * is never yanked.
 */
function commitFocusedWidgetEditor(): void {
  const v = view
  // `typeof` on both names: this runs in test bundles with neither global.
  if (!v || typeof document === 'undefined' || typeof HTMLElement === 'undefined') return
  const ae = document.activeElement
  if (!ae || !(ae instanceof HTMLElement)) return
  // A widget field only: blurring the content host itself would drop the
  // editor's own focus (and with it the table reveal) on every reload.
  if (ae === v.contentDOM || !v.contentDOM.contains(ae)) return
  ae.blur()
}

export async function onFlushAndClose(): Promise<{ ok: true } | { ok: false; kind: string }> {
  cancelTimers()
  // F83: a Properties value or key being typed lives only in widget DOM until
  // Enter or blur — the CM6 doc is clean, so the handshake would quit over it.
  // Blurring commits it into the doc first (a no-op when nothing is focused).
  commitFocusedWidgetEditor()
  try {
    await flushNow('close')
  } catch (e) {
    return { ok: false, kind: asVaultError(e).kind }
  }
  // A resolved flush is not proof of a write: a conflicted/detached note
  // resolves `skipped` with the buffer intact. Report it as a refusal so the
  // shell cancels the close instead of quitting over unsaved edits.
  if (dirty) {
    return { ok: false, kind: (lastError ?? fail('conflict', 'the note was not saved')).kind }
  }
  return { ok: true }
}

/* ===========================================================================
 * 7.  The inline title's rename editor (§5.4.2, §7.3 case 11).
 * ========================================================================= */

/** §7.3 case 11's character-level rules — the half a `beforeinput` can enforce:
 *  the nine reserved characters plus U+0000..U+001F.  The name-level rules run
 *  at commit, below, and Rust's `validate_name` is the authority for both. */
const BAD_CHARS = /[\\/:*?"<>|\u0000-\u001F]/g

const DEVICE_RE = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i

export function validateName(name: string): string | null {
  if (name.trim() === '') return 'Name cannot be empty'
  BAD_CHARS.lastIndex = 0
  if (BAD_CHARS.test(name)) { BAD_CHARS.lastIndex = 0; return 'Name contains an illegal character' }
  if (name === '.' || name === '..') return 'Name cannot be "." or ".."'
  if (name !== name.trim()) return 'Name cannot start or end with a space'
  if (name.endsWith('.')) return 'Name cannot end with a dot'
  if (DEVICE_RE.test(name)) return 'Name is reserved on Windows'
  if (new TextEncoder().encode(name).length > 255) return 'Name is too long'
  return null
}

function flashBad(input: HTMLInputElement): void {
  input.classList.add('bad')
  setTimeout(() => input.classList.remove('bad'), BAD_FLASH_MS)
}

/**
 * One click on `.nc-title` swaps its contents for an `<input>` of the same
 * metrics, pre-filled with the basename WITHOUT `.md` and fully selected.
 * While it is open the buffer keeps autosaving to the OLD path: a rename never
 * flushes and a flush never renames (§5.4.2).
 */
function beginTitleRename(el: HTMLElement, base: string, caret?: number): void {
  const v = view
  if (!v || !open) return

  const input = document.createElement('input')
  input.className = 'nc-title-edit'
  input.type = 'text'
  input.value = base
  const msg = document.createElement('div')
  msg.className = 'nc-title-error'
  msg.hidden = true

  el.textContent = ''
  el.appendChild(input)
  el.appendChild(msg)
  input.focus()
  // A CLICK places the caret where it landed; a PROGRAMMATIC open (New note,
  // which passes no pointer position) selects the whole name. Both are
  // measured against Obsidian 1.13.7. §5.4.2's "fully selected" describes only
  // the second case and is deviated from for the first -- see the note in
  // electron-shell/app-chrome.css on the same widget.
  if (caret === undefined) input.select()
  else input.setSelectionRange(caret, caret)

  /**
   * Put the widget's DOM back to its resting state: the title as a TEXT NODE,
   * with no editor left mounted inside it.
   *
   * THE DISPATCH BELOW IS NOT ENOUGH AND THAT IS THE WHOLE POINT. `setTitle`
   * re-renders only if the widget compares unequal, and on Escape/blur the
   * basename has not changed, so CM6 reuses the existing DOM node and
   * `toDOM()` never runs. Measured: after one cancelled edit `.nc-title` was
   * left holding `[INPUT.nc-title-edit, DIV.nc-title-error]` with `textContent`
   * empty -- the "title" on screen was still the input. The next click then
   * bubbled out of that stale input, found no text node to locate a caret in,
   * and fell back to selecting the whole name.
   */
  const restoreResting = (): void => {
    input.remove()
    msg.remove()
    el.textContent = open ? basenameNoMd(open.path) : base
  }

  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    endTitleEditing(v)
    restoreResting()
    // Still dispatched: when the name DID change this is what re-renders the
    // widget from state, and it is a no-op when it did not.
    v.dispatch({ effects: setTitle.of(open ? basenameNoMd(open.path) : base) })
    v.focus()
  }

  // Rejected characters never land (§7.3 case 11); the field flashes .bad.
  input.addEventListener('beforeinput', (e) => {
    const data = (e as InputEvent).data
    if (data === null || data === undefined) return
    BAD_CHARS.lastIndex = 0
    const cleaned = data.replace(BAD_CHARS, '')
    if (cleaned === data) return
    e.preventDefault()
    flashBad(input)
    if (cleaned) {
      const s = input.selectionStart ?? input.value.length
      const t2 = input.selectionEnd ?? s
      input.value = input.value.slice(0, s) + cleaned + input.value.slice(t2)
      input.setSelectionRange(s + cleaned.length, s + cleaned.length)
    }
  })

  const commit = async (): Promise<void> => {
    const name = input.value
    const bad = validateName(name)
    if (bad) { msg.textContent = bad; msg.hidden = false; flashBad(input); return }
    const t = ipc
    if (!t || !open) { close(); return }
    try {
      // Never a locally computed string: the new path comes from RenameResult.
      // F35: the open note is read at commit time, and `adoptRenamedPath`
      // re-checks it — a switch between the keystroke and the receipt must
      // not relabel the note that is open now.
      const before = open.path
      const r = await t.renameEntry(before, name + '.md')
      closed = true
      endTitleEditing(v)
      adoptRenamedPath(before, r.path)
      // AFTER adoptRenamedPath, so the restored text is the new basename. A
      // rename to a DIFFERENT name re-renders the widget on its own, but
      // committing the name unchanged does not -- same leak as close().
      restoreResting()
      v.focus()
    } catch (e) {
      // invalidName / alreadyExists: the editor STAYS OPEN with the message
      // inline.  Nothing is silently accepted-then-rejected.
      const err = asVaultError(e)
      msg.textContent = err.kind === 'alreadyExists' ? 'That name is already taken' : 'Invalid name'
      msg.hidden = false
      flashBad(input)
      input.focus()
    }
  }

  input.addEventListener('keydown', (e) => {
    // F79: the Return or Escape that ends an IME composition belongs to the IME.
    if (e.isComposing || e.keyCode === 229) return
    if (e.key === 'Enter') { e.preventDefault(); void commit() }
    else if (e.key === 'Escape') { e.preventDefault(); close() }
  })
  input.addEventListener('blur', () => { if (!closed) void commit() })
}

/* ===========================================================================
 * 8.  The §5.11 harness seam.  Installed ONLY under --pixeltest, so it is
 *     absent from every normal launch, exactly like the probe itself.
 * ========================================================================= */

interface HarnessWindow {
  __PIXELTEST__?: boolean
  /** A harness that wants the view but NOT the geometry probe — preload.cjs. */
  __HARNESS__?: boolean
  __CM_VIEW__?: EditorView
}

function installPixeltestSeams(): void {
  const w = window as unknown as HarnessWindow
  // EITHER flag. `__PIXELTEST__` is the gate run; `__HARNESS__` is any other
  // harness that needs to read the document — §5.4.5's editing probe reaches
  // `view.state.doc` through `__CM_VIEW__` and nothing else can, because CM6
  // 6.43 attaches no `cmView` to the DOM.
  if (!w.__PIXELTEST__ && !w.__HARNESS__) return
  const v = view
  if (!v) return
  // The probe's supported hook: it reaches the view through this, else through
  // CM6's own `.cm-content.cmView.rootView.view` walk.
  w.__CM_VIEW__ = v
}
