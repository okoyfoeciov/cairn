/**
 * src/main.ts
 * Owner: 01.  Spec: CONTRACT.md §7.5 (first run, M65), §7.6 (state.json),
 * §4.3 (vault-switch ordering), §1.4 (the event table), §1.6 (flush-on-quit),
 * §5.11 (the probe kick-off), §6.1 (`visible: false`, shown by the frontend on
 * first paint), §2.2 (the mandatory IPC-degradation hook).
 *
 * THE ENTRY POINT: it boots, wires the modules together, and OWNS NO
 * BEHAVIOUR.  Every rule below is enforced in some other owner's module; what
 * lives here is the ORDER those modules are called in and the small number of
 * flows that genuinely span three of them at once (create, rename, delete, the
 * vault switch, the quit handshake).  If a function here grows a rule, it has
 * been written in the wrong file.
 *
 * FOUR ORDERING FACTS THAT ARE LOAD-BEARING AND LOOK ARBITRARY:
 *
 *   1. `tree.setExpanded(...)` runs BEFORE the first snapshot and
 *      `tree.setScrollTop(...)` AFTER it (tree.ts's REPORTED WIRING note).
 *      Before, because `restore()` then applies the persisted set in the same
 *      pass that resolves the cursor instead of flattening twice; after,
 *      because the clamp needs a real content height rather than 0.
 *   2. The vault is applied from `nc://vault-opened` and from NOWHERE ELSE,
 *      even though `open_vault` and `rescan_all` also RETURN the `VaultInfo`.
 *      Both emit the event on success, so one application point means a startup
 *      open, a user switch and a refresh all land on the same code.
 *   3. §4.3's six steps run in `releaseVault` in the printed order, and step 1
 *      REJECTING ABORTS THE SWITCH.  Never resolve on a failed flush: the
 *      buffer is the user's text and the outgoing vault is where it belongs.
 *   4. §1.6's quit handshake flushes the EDITOR BUFFER FIRST and `state.json`
 *      SECOND, then answers `confirm_close`.  Rust closes the moment it gets a
 *      `true`, so anything not written before that call is lost.
 */

import {
  clearWatchDegraded,
  mountChrome,
  runGeometryProbe,
  setCapBanners,
  setWatchDegraded,
  wireChrome,
  type ChromeHandle,
} from './chrome'
import {
  adoptRenamedPath,
  configureEditor,
  currentNoteState,
  currentPath,
  findDocText,
  findReveal,
  findSelectionText,
  focusEditor,
  forgetCursor,
  guardDeleteOfOpenNote,
  fillEmptyNote,
  isDirty,
  keepMine,
  lastNoteError,
  markDetached,
  markVaultLost,
  mountEditor,
  noteExternalChange,
  onFindDocChanged,
  onFlushAndClose as editorFlushAndClose,
  openNote,
  reloadFromDisk,
  resumeAfterVaultRestored,
  runOnWriteChain,
  saveAs,
  selectRange,
  setEditorHooks,
  setFindHighlightInView,
  showEmpty,
  flushNow as editorFlush,
  type FlushReason,
} from './editor'
import {
  absolutePath,
  attachNameEditor,
  basename,
  displayName,
  messageOf,
  parentOf,
} from './inline-edit'
import { emptySpaceMenu, fileRowMenu, folderRowMenu, openMenu } from './menu'
import {
  confirmClose,
  createFolder,
  createNote,
  deleteEntry,
  emitFrontendReady,
  onFlushAndClose,
  onNoteExternalChange,
  onTreeChanged,
  onVaultLost,
  onVaultOpened,
  onWatchDegraded,
  copyText,
  openExternal,
  openVault,
  pickVault,
  readNote,
  recentVaults,
  forgetVault,
  renameEntry,
  moveEntry,
  rescanAll,
  revealInOs,
  saveUiState,
  searchCancel,
  searchExpand,
  searchStart,
  secretNotes,
  setSort,
  showMainWindow,
  treeSnapshot,
  writeNote,
  currentVault,
} from './ipc'
import type { VaultInfo } from './ipc'
import { modalIsOpen, openModal } from './modal'
import { mountFind, type FindPanel } from './find'
import { mountSearch, type SearchPanel } from './search'
import { configurePersist, discardPendingUi, flushUi, patchUi } from './state'
import { createTabStrip, type TabId, type TabStrip } from './tabstrip'
import { mountMemoir, type MemoirView } from './memoir'
import { createTree, MEMOIR_PATH, type TreeController } from './tree'
import { registerLinkHost } from './livepreview'
import { registerTotpHost } from './totp'
import { SECRET_TEMPLATE, registerSecretsHost } from './secrets'
import { createVaultBar, type VaultBar } from './vaultbar'

/* ═══════════════════════════════════════════════════════════════════════════
 * 1.  The session's model.  Three values, and every one of them is a cache of
 *     something Rust owns — nothing here is a source of truth.  (It was four
 *     until §0.12 E14 deleted `sortMode`: it existed only so the sort menu could
 *     tick the current row without a round trip, and there is no sort menu.)
 * ═══════════════════════════════════════════════════════════════════════════ */

let vault: VaultInfo | null = null
/** §7.3 case 8.  Non-null while `nc://vault-lost` is outstanding: the tree is
 *  frozen, the buffer is read-only, and no mutation may be attempted. */
let vaultLostPath: string | null = null
/** §5.11: the probe runs ONCE, on the first frame after the fixture is up. */
let probeDone = false

let tree: TreeController
let search: SearchPanel
let find: FindPanel | null = null
let tabs: TabStrip
let bar: VaultBar
let chromeHandle: ChromeHandle
/** The Memoir page (owner 03's `memoir.ts`) and the pane it takes over.
 *  Null until the boot path mounts it beside `#ed`. */
let memoir: MemoirView | null = null
let memoirPane: HTMLElement | null = null

function reportError(err: unknown, context: string): void {
  // There is no error console in the shipped chrome, and inventing one here
  // would be a surface no section describes.  §7.3 gives every user-visible
  // failure its own affordance (the conflict bar, the vault-lost bar, the
  // inline-editor message); what reaches this function is the residue, and it
  // goes where a developer can find it.
  console.error('cairn[' + context + ']:', messageOf(err))
}


/* ═══════════════════════════════════════════════════════════════════════════
 * 3.  THE MODAL MOVED OUT OF THIS FILE (errata 3, Z4 — CONTRACT §1.6.1, §6.4).
 *
 * This section used to hold ~70 lines of `createElement`/`textContent` building
 * a two-button dialog, supplied here because §6.4 gave the modal NO OWNER and
 * both call sites are in this file.  That was REPORTED at the time rather than
 * claimed, and the ruling agreed with the report and against the placement:
 * spec-07 §1's line for this file is "entry: boot sequence, wires modules,
 * OWNS NOTHING ELSE", and a modal is not wiring.
 *
 * It now lives in `src/modal.ts` (owner 01) as the promise-shaped `openModal`,
 * because §7.3 case 3 asks a THREE-way question that two labelled callbacks
 * cannot express.  This file imports it, passes it to the tab strip, and owns
 * no dialog of its own.  `promptForName` below is NOT a second modal: it is the
 * inline name editor's fallback placement (see its own note), it asks no
 * data-loss question, and since the rename moved into the tree row it is not on
 * any path the user reaches by ordinary use.
 * ═══════════════════════════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════════════════════════
 * 4.  The name prompt — NOW A FALLBACK AND NOTHING ELSE.
 *
 * THE DEVIATION THIS BLOCK USED TO REPORT IS CLOSED.  It read: "§5.4.2 and
 * spec-04 describe an INLINE row editor for create and rename … but `tree.ts`
 * exposes NO API that hands out a host element for a row", and so every create
 * and every rename ran through a centred backdrop dialog.  The premise was
 * false when it was written and is doubly false now: `TreeController` has
 * `rowHost`, `reserveRowHost`, `beginCreate` AND `beginRename`, and tree.ts's
 * own wiring note shows them being driven from here.  §0.17 E22 moved the two
 * create gestures onto them; the rename is the last of the three and is now on
 * `beginRename` (see `renameFlow`).
 *
 * What survives is a FALLBACK with two callers and no other purpose: a create
 * whose parent folder has no visible row to reserve under, and a rename of a
 * path the tree does not hold.  It reuses `attachNameEditor`, so the validation,
 * the rejected-character filter, the flash, the `{ok:false}` keeps-it-open rule
 * and the §7.3 messages are the app's single copy either way; only the placement
 * differs, and it is placement the user will normally never see.
 * ═══════════════════════════════════════════════════════════════════════════ */
interface NamePrompt {
  title: string
  initial: string
  select?: 'all' | 'stem'
  suffix?: string
  commit(name: string): Promise<void>
}

function promptForName(p: NamePrompt): void {
  const back = document.createElement('div')
  back.setAttribute(
    'style',
    'position:fixed;inset:0;z-index:80;display:flex;align-items:flex-start;' +
      'justify-content:center;padding-top:140px;background:rgba(0,0,0,.35)'
  )
  const box = document.createElement('div')
  box.setAttribute(
    'style',
    // MEASURED, NOT ASSUMED: `--border-normal`, `--interactive-accent` and
    // `--fs-ui` are named by CONTRACT §1.6.1 and are DECLARED NOWHERE — not in
    // `tokens.css`, not in any sheet.  An undeclared custom property resolves to
    // the empty string rather than throwing, so this box has been rendering with
    // no border since it was written.  The tokens that exist are used instead,
    // and `--shadow-popover` is §5.1's ONE permitted shadow.  See the erratum
    // note at the top of `src/modal.ts`.
    'width:420px;padding:14px;border-radius:var(--radius-m);background:var(--bg-secondary);' +
      'border:1px solid var(--bg-modifier-border);box-shadow:var(--shadow-popover)'
  )
  const label = document.createElement('div')
  label.textContent = p.title
  label.setAttribute(
    'style',
    'font-size:var(--fs-ui-small);color:var(--text-muted);margin-bottom:8px'
  )
  const input = document.createElement('input')
  input.type = 'text'
  input.setAttribute(
    'style',
    'width:100%;box-sizing:border-box;padding:6px 8px;border-radius:5px;' +
      'background:var(--bg-primary);color:var(--text-normal);' +
      'border:1px solid var(--bg-modifier-border);font-size:var(--fs-ui-medium)'
  )
  box.append(label, input)
  back.append(box)
  document.body.appendChild(back)

  const handle = attachNameEditor(input, {
    initial: p.initial,
    ...(p.select ? { select: p.select } : {}),
    ...(p.suffix !== undefined ? { suffix: p.suffix } : {}),
    // A centred dialog is not an inline row: clicking the backdrop to dismiss is
    // the expected gesture, and committing on blur would create a note the user
    // was in the middle of abandoning.  §5.4.2's "blur commits" is about the
    // INLINE editors, both of which keep the default.
    commitOnBlur: false,
    async onCommit(name: string) {
      // A throw is `{ok:false, message}` — `attachNameEditor` does that for us,
      // so a VaultError keeps the field open with the reason under it instead of
      // closing over a failure.
      await p.commit(name)
      back.remove()
      return { ok: true as const }
    },
    onCancel() {
      back.remove()
    },
  })
  handle.focus()
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 5.  The flows that span three modules at once.
 * ═══════════════════════════════════════════════════════════════════════════ */

/** §3.5: FULL REBUILD, ALWAYS.  There is no delta path and there must not be
 *  one — the blob crosses the IPC once and the frontend re-flattens. */
async function refreshTree(): Promise<void> {
  try {
    tree.applySnapshot(await treeSnapshot())
    // Command 25, same refresh: the secret rows' mark.  A rel the blob does
    // not hold falls out in `setSecrets` and reconciles on the next refresh.
    tree.setSecrets(await secretNotes())
  } catch (err) {
    reportError(err, 'tree-snapshot')
  }
}

/**
 * MEASURED against Obsidian 1.13.7: neither creation gesture prompts. New note
 * creates `Untitled.md` immediately, opens it, and drops the caret into the
 * inline title with the name selected; New folder opens an inline editor on a
 * fresh row in the tree and creates on commit. Cairn prompted with a centred
 * dialog for both, which is a divergence from the reference on the two most
 * common gestures in the app.
 *
 * The inline machinery was already here and simply unused: `tree.beginCreate`
 * (tree.ts:1331) reserves a row host under `parent` for exactly this, and
 * tree.ts:1403's own wiring example shows it was designed to be driven this
 * way. `promptForName` kept `renameFlow` as its last real caller "for now";
 * that has since gone the same way, so it is a fallback for both and a first
 * choice for neither.
 */
function newNoteIn(parent: string): void {
  if (vaultLostPath !== null) return
  void (async () => {
    try {
      // `null` asks the backend for its own unique default, so two rapid
      // invocations cannot collide on one name.
      const r = await createNote(parent, undefined)
      await refreshTree()
      await openNoteAt(r.path)
      focusInlineTitle()
    } catch (err) {
      reportError(err, 'create-note')
    }
  })()
}

/**
 * Obsidian puts the caret in the new note's title with the whole name
 * selected, so typing replaces `Untitled`. The click path computes a caret
 * offset from the pointer; dispatching without one leaves `caret` undefined,
 * which is the branch in editor.ts that selects all.
 */
function focusInlineTitle(): void {
  const el = document.querySelector<HTMLElement>('.nc-title')
  if (!el) return
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
}

function newFolderIn(parent: string): void {
  if (vaultLostPath !== null) return
  const handle = tree.beginCreate(parent, {
    initial: 'Untitled',
    select: 'all',
    async onCommit(name: string) {
      await createFolder(parent, name)
      await refreshTree()
      return { ok: true as const }
    },
  })
  // A collapsed or off-screen parent has no row to host the editor. Rather
  // than silently doing nothing, fall back to the dialog that used to be the
  // only path.
  if (!handle) {
    promptForName({
      title: 'New folder in ' + (parent === '' ? vault?.name ?? 'vault' : parent),
      initial: 'Untitled',
      async commit(name) {
        await createFolder(parent, name)
        await refreshTree()
      },
    })
  }
}

/**
 * `New secret file` (user feature, 2026-09-16).  Neither creation gesture
 * prompts (§0.17 E22), so neither does this: the name is taken by the tree's
 * inline row editor — the same one `newFolderIn` drives — and the file opens
 * with the template in it.
 *
 * `beginCreate` is why there is no dialog AND no second rename path: the
 * name is validated by the shared machinery (reserved characters, 255 bytes,
 * Windows names) and an exact-name `createNote` that collides keeps the row
 * open with the message inline (§7.3 case 11), instead of stranding an
 * `Untitled 3.md` the user never asked for.
 */
function newSecretIn(parent: string): void {
  if (vaultLostPath !== null) return
  const handle = tree.beginCreate(parent, {
    initial: 'Untitled',
    select: 'all',
    // A note shows the stem and the commit re-appends the extension —
    // Obsidian's own shape, same as `renameFlow` (§3.6 keeps `.md` on the
    // wire only).
    suffix: '.md',
    async onCommit(name: string) {
      await createSecretNote(parent, name)
      return { ok: true as const }
    },
  })
  // A collapsed or off-screen parent has no row to host the editor — the same
  // fallback `newFolderIn` keeps for the same reason.
  if (!handle) {
    promptForName({
      title: 'New secret file in ' + (parent === '' ? vault?.name ?? 'vault' : parent),
      initial: 'Untitled',
      suffix: '.md',
      async commit(name) {
        await createSecretNote(parent, name)
      },
    })
  }
}

/**
 * The second half of both secret-file creation paths: exact-name create,
 * open, and template fill through the ordinary dispatch + flush path, so a
 * failure here is a reported flush error and not a half-created file.  There
 * is no inline title to focus: in secret mode the editor is not an editable
 * surface.
 */
async function createSecretNote(parent: string, name?: string): Promise<void> {
  // `name: undefined` asks the backend for its own unique default, so two
  // rapid invocations cannot collide on one name.
  const r = await createNote(parent, name)
  await refreshTree()
  if (!await openNoteAt(r.path)) return
  if (fillEmptyNote(SECRET_TEMPLATE)) {
    await editorFlush('manual').catch(() => {})
  }
}

/**
 * spec-04 §8.3 step 1 — an in-app folder rename KEEPS ITS SUBTREE EXPANDED.
 *
 * The expansion set is PATH-KEYED (CONTRACT §3.4) and Rust's rename moves every
 * path under the folder at once, so without this the set still holds `old` and
 * `old/…` after the snapshot, `restore()` finds neither, and the folder the user
 * just renamed silently COLLAPSES under them along with everything in it.  It is
 * also why §3.4's pruning rule almost never has a dead entry to prune.
 *
 * `setExpanded` before `refreshTree()` and never after: `applySnapshot` runs
 * `restore()` against whatever the set holds at that moment.
 */
function rekeyExpanded(oldPath: string, newPath: string): void {
  if (oldPath === newPath) return
  const prefix = oldPath + '/'
  let moved = false
  const next = tree.expanded().map((p) => {
    if (p === oldPath) { moved = true; return newPath }
    if (p.startsWith(prefix)) { moved = true; return newPath + p.slice(oldPath.length) }
    return p
  })
  if (!moved) return
  tree.setExpanded(next)
  // `setExpanded` is the READ path and fires no `onExpandedChanged`, so the
  // persisted copy would keep the dead keys until the next expand or collapse —
  // i.e. across a restart, which is exactly when it would be believed.
  patchUi({ expanded: next })
}

/**
 * §7.3 case 4.  The new path comes back from Rust in `RenameResult.path` and is
 * ADOPTED, never recomputed here — `rename_entry` updates `AppState.open_note`
 * under the write lock (M54) and a frontend that guessed the string would drift
 * from it on the first sanitised character.
 *
 * §0.17's method applied to the rename: THE EDITOR IS THE TREE ROW, not a
 * dialog.  Obsidian's `startRenameFile` puts a `contenteditable` on the row's
 * own title element with the whole name selected and a 2px accent ring around
 * the row (`app.js` `startRename` -> `sm()`; `app.css` `.is-being-renamed`), and
 * `tree.beginRename` has existed for exactly this since the tree was written.
 * This routed through `promptForName`'s centred backdrop dialog instead — the
 * same divergence §0.17 E22 found on the two create gestures, in the third and
 * last place it survived.  The dialog remains the fallback for a path with no
 * row to host the field, and nothing else.
 *
 * TWO THINGS THE FIELD NO LONGER SHOWS, both Obsidian's:
 *   - `.md`.  Its `getTitle()` is `file.basename` and its
 *     `getNewPathAfterRename` re-appends the ORIGINAL extension, so the user
 *     types a name and gets a note.  Here that is `displayName` + `suffix`, and
 *     Rust's `rename_target` would ensure `.md` even if the suffix were dropped.
 *   - a partial selection.  `sm(innerEl)` selects the lot.
 */
function renameFlow(path: string, isDir: boolean): void {
  if (vaultLostPath !== null) return
  // A folder shows its whole name; a note shows the name the row was drawing,
  // which never carries the extension (§3.6 keeps `.md` on the wire only).
  const shown = isDir ? basename(path) : displayName(path)
  const suffix = isDir ? '' : '.md'

  async function commit(name: string): Promise<void> {
    // F35: the rename runs ON the editor's write chain — a write that passed
    // step 1 must not rename its temp over the old path after the move — and
    // hands the editor the rename ITSELF. `adoptRenamedPath` re-checks the
    // open note at call time, so a switch during the IPC (which re-walks the
    // vault before replying) leaves the newly opened note alone. `before` is
    // not read here at all: a pre-await `currentPath()` is the stale value
    // the bug relabelled with.
    // F56: the vault is captured before the IPC for the same reason as
    // `deleteFlow` — a switch under the rename must not apply its aftermath
    // elsewhere. The IPC itself cannot be un-sent, but the editor and the
    // expansion set stay untouched and the refresh shows reality.
    const root = vault?.root ?? null
    await runOnWriteChain(async () => {
      const r = await renameEntry(path, name)
      if ((vault?.root ?? null) !== root || vaultLostPath !== null) return
      adoptRenamedPath(path, r.path)
      rekeyExpanded(path, r.path)
    })
    await refreshTree()
  }

  const opened = tree.beginRename(path, {
    initial: shown,
    select: 'all',
    suffix,
    async onCommit(name: string) {
      // A throw becomes `{ok:false, message}` inside the shared editor, so a
      // VaultError keeps the field open under the row with the reason beneath
      // it — §7.3 case 11's "nothing is silently accepted-then-rejected".
      await commit(name)
      return { ok: true as const }
    },
  })
  if (opened) return

  // No row to host it: the path is not in the tree at all (a snapshot has not
  // landed yet, or it went away under us).  `rowHost` already un-collapses
  // ancestors, so this is not the collapsed-parent case.
  promptForName({
    title: 'Rename ' + (isDir ? 'folder' : 'note'),
    initial: shown,
    select: 'all',
    suffix,
    commit,
  })
}

/**
 * Drag-to-move drop: `sources` (already top-level-filtered, already validated,
 * in blob order) into `destParent` (`''` = vault root). Obsidian's `MA` +
 * `renameFile` per entry, transcribed: one command 24 per entry, sequentially
 * (each re-walks, so the next uniquification sees the last move), then one
 * refresh. The open note follows like a rename (it IS the moved thing or under
 * a moved folder); expansion rekeys like a rename; a failure is reported and
 * the rest continue (there is no cancel on a drop, unlike `deleteTargets`).
 */
function moveFlow(sources: { path: string; isDir: boolean }[], destParent: string): void {
  if (vaultLostPath !== null) return
  if (sources.length === 0) return
  void (async () => {
    try {
      for (const s of sources) {
        try {
          // F35: one entry at a time, each on the editor's write chain (see
          // `renameFlow`'s commit above), handing the editor the move itself.
          // F56: like the rename, a switch under the move leaves the editor
          // and the expansion set alone.
          const root = vault?.root ?? null
          const r = await runOnWriteChain(async () => {
            const moved = await moveEntry(s.path, destParent)
            if ((vault?.root ?? null) !== root || vaultLostPath !== null) return null
            adoptRenamedPath(s.path, moved.path)
            return moved
          })
          if (r !== null) rekeyExpanded(s.path, r.path)
        } catch (err) {
          reportError(err, 'move')
        }
      }
      await refreshTree()
    } catch (err) {
      reportError(err, 'move')
    }
  })()
}

/**
 * §7.3 case 3 — THE DIRTY-DELETE PATH.  Steps 5 and 6 are this file's half
 * (errata 3, Z5's owner table); steps 1-4 are `editor.ts`'s
 * `guardDeleteOfOpenNote()`, and the modal is `modal.ts`'s `openModal()`.
 *
 * WHAT THIS FIXES, stated plainly because it shipped broken.
 * `docs/DATA-LOSS-VERIFICATION.md` finding F1: this function used to show a
 * two-button "<name> will be moved to the Trash" dialog that NEVER CONSULTED
 * `isDirty()`.  Deleting the open note with unsaved edits trashed the PRE-EDIT
 * file and dropped the buffer, so the edits were gone and the Trash copy did
 * not contain them — no recovery path anywhere, behind a sentence that reads as
 * if there were one.  That is the exact class of bug this whole project is a
 * defence against, and it survived to a working app.
 *
 * THE THREE MODALS THIS PATH CAN SHOW ARE SEQUENTIAL, NEVER STACKED (§1.6.1
 * behaviour 5).  Every one of them is `await`ed:
 *
 *   1  "Delete note?"                 — the confirmation.  ALWAYS, dirty or not,
 *                                       open or not.  Cancel is the default.
 *   2  "<name> has unsaved changes."  — §7.3 case 3 step 2, and ONLY when the
 *                                       entry being deleted IS the open note or
 *                                       an ancestor folder of it AND the buffer
 *                                       is dirty.  Owned by the guard, because
 *                                       a caller that reads `isDirty()` and then
 *                                       acts on it is reading a value that can
 *                                       change under it.
 *   3  an error report                — only if `delete_entry` itself refuses.
 *
 * WHY THE GUARD IS CALLED AND NOT INLINED.  Steps 1-4 are "cancel both timers,
 * settle the in-flight write, decide, flush, settle again" and every one of
 * those five verbs is `editor.ts` state.  Reproducing the decision here would
 * mean reading `isDirty()` across two awaits, which is precisely the race Z5's
 * owner table exists to prevent.
 *
 * THE ORDERING THAT LOOKS LIKE BELT AND BRACES AND IS NOT (§7.1 rule 1, F3).
 * `x-create: '0'` on every autosave makes an autosave issued AFTER the delete
 * unable to resurrect the note (`dl_05` proves it).  It does NOT close a write
 * that had already passed step 1b when the delete landed — a measured 5.04 ms
 * window on an 11 KB note.  `guardDeleteOfOpenNote` awaits `settleWrites()`
 * twice for that, and returns only when no write is in flight; this function
 * then invokes `delete_entry` with nothing running and nothing armed.  All
 * three mechanisms are required and none of them is redundant.
 *
 * There is no `(deleted)` tab marker — spec-04 §10.4's row is STRUCK.
 */
/**
 * A FAILED DELETE MUST NEVER LOOK LIKE "NOTHING HAPPENED".
 *
 * This is the fix for a real bug, not a nicety.  Before it, `deleteFlow`'s only
 * response to a refused delete was `reportError`, which is a `console.error` —
 * and there is no error console in the shipped chrome.  So the user clicked
 * `Delete`, confirmed a destructive modal, and the row STAYED IN THE TREE with
 * no explanation whatsoever.  Every plausible cause looked identical and
 * identically silent: a denied permission, a locked file, a full disk, a
 * read-only vault directory.
 *
 * The old Finder/Apple-Event backend made that failure routine rather than
 * exotic — one Deny on the "Cairn wants to control Finder" TCC prompt turned
 * EVERY subsequent Move to Trash into a silent no-op, and §6.4's per-rebuild
 * signature churn re-raised that prompt every rebuild.  `fsops::move_to_trash`
 * has since dropped the Apple Event, which removes that particular cause — but
 * the silence was a defect independent of which backend won, so it is fixed
 * here on its own merits.  `TrashUnavailable`, `io` and the rest now all land
 * on a dialog.
 *
 * Two buttons, because §1.6.1 allows 2 or 3 and a one-button alert is a shape
 * this app does not have.  The second is not filler: the delete failed, the
 * entry is therefore still on disk, and `Show in Finder` is command 20 — the
 * one affordance that lets the user go deal with the file by hand.  Nothing
 * here offers `permanent: true` as a retry.  `fsops::delete_entry`'s flag is
 * deliberately hard to reach from a retry loop, and an error dialog that
 * answers "the Trash refused" with a one-click unrecoverable `unlink` would be
 * the exact data-loss path the flag exists to prevent.
 */
async function reportDeleteFailure(path: string, isDir: boolean, err: unknown): Promise<void> {
  const kind =
    err !== null && typeof err === 'object' && 'kind' in err
      ? String((err as { kind: unknown }).kind)
      : ''
  // Only claim the entry survived where that is actually known to be true.
  // `trashUnavailable` is the refusal `dl_27` pins: the note is byte-unchanged
  // and still in the vault.  `notFound` is the opposite — it is already gone —
  // and a message that told the user to look for it would send them hunting for
  // a file that does not exist.
  const stillThere = kind === 'trashUnavailable' || kind === 'io'
  const noun = isDir ? 'folder' : 'note'
  const pick = await openModal({
    title: 'Could not delete ' + displayName(path),
    detail:
      messageOf(err) +
      (stillThere
        ? ' The ' + noun + ' was not moved to the Trash and is still in your vault.'
        : ' The ' + noun + ' was not moved to the Trash.'),
    buttons: [
      // The id is `keep`, not `ok`, and that is not cosmetic: §1.6.1 [N1] is
      // enforced by a source scan over every shipped `defaultId`, whose
      // allowlist is the set of ids that MEAN "change nothing".  Dismissing
      // this dialog changes nothing — the entry stays exactly where it is — so
      // `keep` is the accurate word as well as the one that keeps that guard at
      // full strength.  The label the user reads is still `OK`; §1.6.1 says the
      // id is "stable, not the label" precisely so the two can differ.
      { id: 'keep', label: 'OK' },
      { id: 'reveal', label: 'Show in Finder' },
    ],
    defaultId: 'keep',
  })
  if (pick === 'reveal') {
    // A failure here is genuinely residue — the dialog has already told the
    // user what went wrong, and a second dialog about the first dialog's
    // button would stack, which §1.6.1 behaviour 5 forbids.
    await revealInOs(path).catch((e: unknown) => reportError(e, 'reveal'))
  }
}

/**
 * The secret entry's delete confirm (user request, 2026-09-16): the Delete
 * button sits one click from Copy and a misclick destroys a credential, so
 * it asks through the app's one modal in §7.3 case 5/6's shape — title,
 * quoted name, Cancel + solid-red Delete.
 *
 * ONE deliberate divergence from the file confirm: NO `focusId`.  The file
 * confirm focuses Delete, as measured — but a file delete lands in the Trash
 * and an entry delete is an edit with no undo surface in the viewer, so
 * Return must land on Cancel (§1.6.1 behaviour 1), not on destruction.
 */
async function confirmDeleteSecret(label: string): Promise<boolean> {
  const pick = await openModal({
    title: 'Delete secret',
    detail: [
      'Are you sure you want to delete \u201c' + label + '\u201d?',
      'This cannot be undone.',
    ],
    buttons: [
      { id: 'cancel', label: 'Cancel' },
      { id: 'delete', label: 'Delete', destructive: true, cta: true },
    ],
    defaultId: 'cancel',
  })
  return pick === 'delete'
}

/**
 * The delete confirm, transcribed from Obsidian 1.13.7 (2026-09-14, app.js +
 * live measurement at dpr 1.25): title `Delete file` / `Delete folder`, body
 * `Are you sure you want to delete “<name>”?` (the FULL name WITH extension —
 * `e.name`, not the stem) + `It will be moved to your system trash.`, a
 * non-empty folder's two amber rows, Cancel + SOLID-red Delete with Delete
 * focused, an X that answers Cancel, and NO checkbox (user ruling — Obsidian's
 * `Don't ask again` is deliberately not transcribed).
 *
 * Returns whether the caller should CONTINUE a multi-delete: `'cancelled'`
 * (the confirm, or the dirty guard behind it, said stop) breaks the loop;
 * `'deleted'` and `'failed'` (reported on its own dialog) both continue.
 */
async function deleteFlow(path: string, isDir: boolean): Promise<'deleted' | 'failed' | 'cancelled'> {
  if (vaultLostPath !== null) return 'cancelled'

  // F56: the confirm is an await — a vault switch under the dialog must not
  // retarget the pending relative path into the new vault.
  const root = vault?.root ?? null
  const name = basename(path)
  const warnings: string[] =
    isDir && (tree?.descendantCount(path) ?? 0) > 0
      ? ['This folder is not empty.', 'If you continue, all files inside this folder will be deleted.']
      : []
  const confirm = await openModal({
    title: 'Delete ' + (isDir ? 'folder' : 'file'),
    detail: [
      'Are you sure you want to delete \u201c' + name + '\u201d?',
      'It will be moved to your system trash.',
    ],
    warnings,
    buttons: [
      { id: 'cancel', label: 'Cancel' },
      { id: 'delete', label: 'Delete', destructive: true, cta: true },
    ],
    defaultId: 'cancel',
    focusId: 'delete',
  })
  if (confirm !== 'delete') return 'cancelled'
  // F56: the vault changed under the dialog (or was lost) — the relative
  // path no longer names the file the user was asked about.
  if ((vault?.root ?? null) !== root || vaultLostPath !== null) return 'cancelled'

  // The open note is affected when it IS the deleted thing, or when the deleted
  // thing is one of its ancestor folders — §7.3 case 6 is case 5 with a folder
  // in front of it, and both reach here.
  const openPath = currentPath()
  const hitsOpen = openPath !== null && (openPath === path || openPath.startsWith(path + '/'))

  if (hitsOpen) {
    // Steps 1-4.  Never throws.  `'abort'` means the user said Cancel, or the
    // flush behind "Save and delete" was REFUSED — and on a refusal the delete
    // MUST NOT happen, because the file on disk is then the only copy of
    // anything and the buffer is the only copy of the edits.
    const guard = await guardDeleteOfOpenNote(displayName(path))
    if (guard === 'abort') return 'cancelled'
  }

  // Steps 5 and 6.
  try {
    await deleteEntry(path, false)
  } catch (err) {
    reportError(err, 'delete')
    // STEP 6 RUNS EVEN WHEN STEP 5 FAILS, and that is not a tidy-up: a
    // `'proceed'` from the guard means step 4 already cleared the editor's open
    // note, so the pane is showing text it can no longer save.  Nothing is lost
    // by closing it — every path that reaches here has either written the
    // buffer to disk ("Save and delete", or a clean buffer) or been told
    // explicitly to drop it ("Delete without saving").  Leaving it on screen
    // would be the state that LOOKS recoverable and is not, which is the exact
    // shape of the bug this function is fixing.
    if (hitsOpen) { showEmpty(); hideFind() }
    // The pane is settled BEFORE the dialog goes up, so the modal is the last
    // thing drawn and the user is not answering a question over a stale pane.
    await reportDeleteFailure(path, isDir, err)
    return 'failed'
  }
  forgetCursor(path)
  if (hitsOpen) { showEmpty(); hideFind() }
  await refreshTree()
  return 'deleted'
}

/**
 * User ruling, 2026-09-14: Delete applies to a whole shift-selection, not
 * just the row under the cursor.  Obsidian's own shape for this
 * (`onDeleteSelectedFiles` → `removeSelection` → one `promptForDeletion` PER
 * file) is transcribed rather than invented: there is no bulk-confirm copy
 * anywhere in its bundle, so N files mean N sequential confirms — each with
 * its own name in it — and a Cancel stops the sequence rather than skipping
 * to the next file.
 *
 * A folder swallows its selected descendants (deleting it deletes them; a
 * second confirm for a note that is already gone would read as a bug, and its
 * `notFound` report would send the user hunting for a file that does not
 * exist).  That dedupe is derived, not transcribed, and it is the only half
 * of this function that is.
 */
async function deleteTargets(entries: { path: string; isDir: boolean }[]): Promise<void> {
  const roots = entries.filter(
    (e) => !entries.some((o) => o.isDir && o.path !== e.path && e.path.startsWith(o.path + '/'))
  )
  for (const e of roots) {
    if ((await deleteFlow(e.path, e.isDir)) === 'cancelled') return
  }
}

/**
 * §0.12 E14 — `Copy absolute path`.  The row's whole implementation.
 *
 * NO IPC AND NO COMMAND: `VaultInfo.root` is already the absolute vault root in
 * this module (§1.5), so the string is composed here and written straight to the
 * clipboard.  §1.3 is closed at TWENTY-ONE since §0.30 E70's `forget_vault`, and this path adds none.
 *
 * `writeText` MUST BE REACHED SYNCHRONOUSLY FROM THE CLICK.  WebKit gates the
 * async clipboard on TRANSIENT ACTIVATION (`ClipboardAccessPolicy` defaults to
 * `RequiresUserGesture`), and menu.ts's `activate()` calls `onSelect()` inside
 * the click task for exactly this reason.  Anything awaited before this line —
 * a path lookup, a round trip to Rust — would consume the activation and the
 * promise would reject with `NotAllowedError` for no visible reason.  Do not
 * make this function `async`.
 *
 * A rejection is REPORTED, not swallowed: a copy that silently did nothing is
 * indistinguishable from one that worked until the user pastes.
 *
 * BOTH FAILURE SHAPES ARE CAUGHT, and they are different shapes.  A REJECTED
 * promise (`NotAllowedError`, a lost activation) is the `.catch`.  A missing
 * `navigator.clipboard` — a non-secure context, or a WebKit build without the
 * async clipboard — makes `navigator.clipboard.writeText` a TypeError thrown
 * SYNCHRONOUSLY, before any promise exists for `.catch` to attach to, and it
 * would escape this function into menu.ts's click listener as an uncaught
 * exception.  Every reading of the evidence says the API is there on both
 * platforms; the `try` is here because the cost of being wrong about that is an
 * uncaught error and the cost of the guard is three lines.
 */
function copyAbsolutePath(rel: string): void {
  const root = vault?.root
  // No vault open: the menu is unreachable in that state (there is no tree to
  // right-click), so this is a guard against a future caller, not a live case.
  if (root === undefined) return
  try {
    void navigator.clipboard
      .writeText(absolutePath(root, rel))
      .catch((e: unknown) => reportError(e, 'copy-path'))
  } catch (err) {
    reportError(err, 'copy-path')
  }
}

/**
 * §0.16 E18 — THREE MENUS, AND THE CREATE ROWS APPEAR IN TWO OF THEM.
 *
 * A user decision, and Obsidian's own shape: its create rows are built inside
 * `if (t instanceof ZT)`, the folder branch. So a create is only ever offered
 * where its destination is unambiguous — INSIDE this folder, or at the ROOT from
 * empty space — and `destinationFor()` is gone with the ambiguity it existed to
 * paper over. A folder's destination is the folder itself, which needs no helper
 * to say.
 */
function rowMenu(ev: MouseEvent, path: string | null, isDir: boolean): void {
  const opts = { x: ev.clientX, y: ev.clientY, label: 'Row actions' }
  if (path === null) {
    openMenu(
      emptySpaceMenu({
        newNote: () => newNoteIn(''),
        newFolder: () => newFolderIn(''),
        newSecret: () => newSecretIn(''),
      }),
      opts
    )
    return
  }
  // The three that act on THIS entry, whatever it is.
  const onThis = {
    rename: () => renameFlow(path, isDir),
    copyPath: () => copyAbsolutePath(path),
    // User ruling, 2026-09-14: when the row sits inside a shift-selection the
    // menu deletes the WHOLE selection, not just the row — the standard
    // file-browser subject rule, and the dialog names every file anyway.
    remove: () => { void deleteTargets(deleteSubject(path, isDir)) },
  }
  if (!isDir) {
    openMenu(fileRowMenu(onThis), opts)
    return
  }
  openMenu(
    folderRowMenu({
      ...onThis,
      // `path`, not `parentOf(path)`: a create on a folder row lands INSIDE it.
      newNote: () => newNoteIn(path),
      newFolder: () => newFolderIn(path),
      newSecret: () => newSecretIn(path),
    }),
    opts
  )
}

/**
 * The delete subject for a row gesture (menu Delete, Delete key): the whole
 * shift-selection when the row is in it, else the row alone.  The keyboard
 * path leans on the same rule — a live selection wins over the cursor row,
 * which is Obsidian's `getSelectedItems` (selection, else focused item).
 */
function deleteSubject(path: string, isDir: boolean): { path: string; isDir: boolean }[] {
  const sel = tree?.getSelection() ?? []
  if (sel.some((s) => s.path === path)) return sel
  return [{ path, isDir }]
}

/** The one route into the editor.  `openNote` FLUSHES FIRST and ABORTS on a
 *  rejection (§9.2) — the buffer is never dropped to open something else — so
 *  everything this has to do afterwards is report the failure.
 *
 *  `Memoir.md` never reaches the editor: it is the Memoir page's file and
 *  opens as the page, through the same flush-first rule.
 *
 *  The reverse direction lives here too: the page holds its own dirty buffer
 *  outside the editor, so ANY route into the editor (tree click, search hit,
 *  link, restore — not just the note tab) flushes the page first and steps it
 *  aside, aborting on a refused write.  The tab-only version of this lived in
 *  `switchTab` and missed the tree entirely (reported 2026-09-17: selecting a
 *  row from inside Memoir kept the page on screen). */
function hideFind(): void {
  find?.hide()
}

/**
 * In-note find is NOTE VIEWER ONLY (user clarification on X-13): Mod-F opens
 * the overlay bar over the CodeMirror note and never over the Memoir page,
 * which is a plain textarea outside the editor.  The toggle is refused while
 * the page is visible, and every route to the page hides the bar.
 *
 * SHOW-OR-FOCUS, never a close: with the bar open and the caret in the note,
 * a second Mod-F hands the focus back to the field (the query selected) rather
 * than dismissing the bar it just opened.  Esc and × are the closes.
 */
function toggleFind(): void {
  if (vaultLostPath !== null) return
  if (memoir !== null && memoir.visible()) return
  if (currentPath() === null) return
  if (findDocText() === null) return
  find?.toggle()
}

async function openNoteAt(path: string): Promise<boolean> {
  if (vaultLostPath !== null) return false
  if (path === MEMOIR_PATH) return openMemoir()
  hideFind()
  if (memoir !== null && memoirPane !== null && memoir.visible()) {
    // F47: a journal that will not save (an outside edit conflicted it) must
    // not trap the user on the page with no visible reason. The buffer stays
    // in the page — nothing is discarded by leaving — and the quit handshake
    // (F26) still refuses to exit over it. `releaseVault` below stays strict:
    // its `reset()` would drop the buffer, so a vault switch still aborts.
    try {
      await memoir.flush()
    } catch {
      /* the buffer stays dirty in the hidden page; leaving is safe */
    }
    memoir.hide()
    memoirPane.classList.remove('is-memoir')
  }
  const r = await openNote(path)
  if (!r.ok) {
    reportError(r.err, 'open-note')
    // F54: the tree already moved its active row to the clicked note —
    // put it back on the note that is actually open, or a later
    // disappearance of the clicked row detaches a healthy note.
    tree.setActivePath(currentPath())
    return false
  }
  return true
}

/**
 * THE MEMOIR PAGE (user feature, 2026-09-15; rebuilt as a page 2026-09-17).
 * Vault-root `Memoir.md` is shown ONLY in the fixed second tab, and as the
 * journal page — never as a CodeMirror note.  The sidebar never holds its row
 * (tree.ts's MEMOIR_PATH); search results and `[[Memoir]]` links resolve
 * through the intact blob and land here through `openNoteAt`'s intercept.
 *
 * LAZY, and that is load-bearing: nothing on the vault-open path writes, so a
 * fresh vault gains no file until the user first selects the tab.  The page
 * itself owns the create (exact-or-throw `createNote`, `alreadyExists` is the
 * lost race with a watcher refresh).
 */
async function openMemoir(): Promise<boolean> {
  if (vaultLostPath !== null || vault === null || memoir === null || memoirPane === null) return false
  if (memoir.visible()) return true
  hideFind()
  try {
    await editorFlush('switch')
  } catch {
    return false
  }
  if (isDirty()) return false
  memoirPane.classList.add('is-memoir')
  tabs.setActive('memoir')
  tree.setActivePath(null)
  memoir.show()
  return true
}

/** Leave the page for the note tab.  This is `openNoteAt`'s page half, kept
 *  as its own step so the tab switch reads as a switch: flush the page (a
 *  refused write keeps it), step it aside, and hand the note to the one
 *  route into the editor. */
async function closeMemoir(): Promise<boolean> {
  if (memoir === null || memoirPane === null) return false
  if (!memoir.visible()) return true
  // F47: see `openNoteAt` — a refused flush keeps its buffer in the page and
  // does not veto the tab switch.
  try {
    await memoir.flush()
  } catch {
    /* the buffer stays dirty in the hidden page; leaving is safe */
  }
  memoir.hide()
  memoirPane.classList.remove('is-memoir')
  return true
}

/**
 * Tab click, either direction.  Fire-and-forget BY DESIGN: the click already
 * happened and there is nothing to answer — success moves the tab, and a
 * refused flush keeps the current one, which IS the "flush + block on
 * conflict" ruling.  `tabs.path` is the note tab's note and survives a Memoir
 * visit untouched, so switching back reopens it rather than guessing.
 */
function switchTab(which: TabId): void {
  void (async () => {
    if (vaultLostPath !== null || vault === null || memoir === null) return
    const cur: TabId = memoir.visible() ? 'memoir' : 'note'
    if (cur === which) return
    if (which === 'memoir') {
      await openMemoir()
      return
    }
    if (!(await closeMemoir())) return
    const p = tabs.path
    if (p !== null) await openNoteAt(p)
  })()
}

/** F66 (§7.3 case 5): Save as… for a detached note. The prompt opens on the
 *  old stem; committing an existing name throws, which keeps the field open
 *  with the reason instead of closing over the failure. When the old folder
 *  is gone too, the first commit says so and the NEXT commit saves at the
 *  top of the vault — never silently. */
function saveAsPrompt(): void {
  const cur = currentPath()
  if (!cur) return
  const parent = parentOf(cur)
  let parentGone = false
  promptForName({
    title: 'Save a copy of this note',
    initial: displayName(cur),
    select: 'all',
    suffix: '.md',
    async commit(name) {
      const dest = !parentGone && parent !== '' ? parent + '/' + name : name
      try {
        await saveAs(dest)
      } catch (e) {
        const kind = e !== null && typeof e === 'object' && 'kind' in e
          ? String((e as { kind: unknown }).kind)
          : ''
        if (!parentGone && parent !== '' && kind === 'notFound') {
          parentGone = true
          throw new Error('The folder "' + parent + '" no longer exists. Save at the top of the vault instead?')
        }
        throw e
      }
      await refreshTree()
    },
  })
}

/* §0.38 E85 — WHAT A CLICKED LINK DOES.  `livepreview.ts` decides WHETHER a
 * link was clicked and reads its target out of the document; it resolves
 * nothing and opens nothing, because it does not know what a vault is.  This
 * does, and it is three lines of policy:
 *
 *   external  ->  command 22, which allowlists the scheme in the MAIN process.
 *   internal  ->  `TreeBlob.resolveLink`, then the one route into the editor.
 *
 * AN UNRESOLVED WIKILINK DOES NOTHING, and that is a decision.  Obsidian CREATES
 * the note (`getFirstLinkpathDest` misses -> `fileManager.createNewFile`).
 * Creating a file from a click is a write to the vault, it is the one thing
 * `KNOWN-ISSUES.md` LP-7 says Cairn cannot even DRAW yet (it has no resolved /
 * unresolved state, so every wikilink looks openable), and a write nobody can
 * see coming is worse than a click that does nothing.  Named in LP-8.
 *
 * `#subpath` IS PARSED AND THEN IGNORED — Cairn has no heading index, so the
 * note opens at the top.  Parsing it is not waste: it is what stops
 * `[[Note#Heading]]` looking for a file called `Note#Heading`.
 */
function linkHost(): void {
  registerLinkHost({
    external(url) {
      void openExternal(url).catch((err) => reportError(err, 'open-external'))
    },
    internal(path) {
      const blob = tree?.blob() ?? null
      if (blob === null) return
      const hit = blob.resolveLink(path, currentPath())
      if (hit === null) return
      void openNoteAt(hit)
    },
  })

  /* §0.46 E94 — the `totp` block's one seam.  Same shape and same reason as the
     link host above: `totp.ts` is a CM6 widget and must not import `ipc.ts`
     (§6.4), so `main.ts` — whose whole job is wiring — hands it the command. */
  registerTotpHost({
    copyText: (text) => copyText(text),
    onError: reportError,
  })
  /* The secret file's viewer copies through the same command, for the same
     reason: `secrets.ts` is a viewer and must not import `ipc.ts` (§6.4). */
  registerSecretsHost({
    copyText: (text) => copyText(text),
    onError: reportError,
    confirmDelete: (label) => confirmDeleteSecret(label),
  })
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 6.  §4.3 — the vault switch.  The order is normative on both sides and steps
 *     1-5 are the FRONTEND's, run before Rust is asked for anything.
 * ═══════════════════════════════════════════════════════════════════════════ */
async function releaseVault(reason: string): Promise<void> {
  // 1. On REJECT, ABORT the switch and show the error.  Never discard.  This
  //    `await` is the abort: `pickAndSwitch` in vaultbar.ts leaves the current
  //    vault open and untouched when this promise rejects.  A RESOLVED flush
  //    that left the buffer dirty (conflicted/detached `skipped`) aborts the
  //    same way — resolution is not proof of a write.
  await editorFlush(reason as FlushReason)
  if (isDirty()) {
    throw lastNoteError() ?? { kind: 'conflict', message: 'the note was not saved' }
  }
  // The Memoir page holds its own dirty buffer outside the editor: flush it
  // under the same abort rule, and drop its session once it is clean — it
  // belongs to the outgoing vault and must not survive into the next one.
  if (memoir !== null) {
    await memoir.flush().catch((err) => {
      reportError(err, 'flush-memoir')
      throw lastNoteError() ?? { kind: 'conflict', message: 'the journal was not saved' }
    })
    if (memoir.isDirty()) {
      throw { kind: 'conflict', message: 'the journal was not saved' }
    }
    memoir.reset()
    memoirPane?.classList.remove('is-memoir')
  }
  // 2. Persist state.json for the OUTGOING vault, then stop accepting patches
  //    for it — anything steps 3-5 produce belongs to a vault that is closing
  //    and would be filed under the incoming vault's key.  The tree debounces
  //    its own expansion/scroll persists, so those join the queue first.
  tree.flushPersist()
  await flushUi()
  discardPendingUi()
  // F38: keystrokes typed between the step-1 check and this line. `showEmpty`
  // drops the buffer, so re-check first — aborting here keeps the text.
  if (isDirty()) {
    throw lastNoteError() ?? { kind: 'conflict', message: 'the note was not saved' }
  }
  // 3. `view.setState(EditorState.create({doc:'',extensions}))`, NOT
  //    `view.destroy()`: there is exactly ONE EditorView for the process
  //    lifetime (M70), and `showEmpty()` is that call.
  showEmpty()
  hideFind()
  // 4. Cancel the search and clear the panel.
  search.reset(null)
  // 5. Drop the blob and the per-vault view state.  The next `applySnapshot`
  //    replaces the ui/visible arrays and the name cache wholesale (§3.5).
  tree.setActivePath(null)
  tree.setExpanded([])
  // The collapse above re-arms the scroll persist with the closing tree's
  // scrollTop; it must not fire into the incoming vault's state.
  tree.cancelPersist()
  tabs.setMemoirVisible(false)
  tabs.setActive('note')
  vault = null
  probeDone = true // never re-run the §5.11 probe across a switch
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 7.  `nc://vault-opened` — the ONE place a vault is applied.
 * ═══════════════════════════════════════════════════════════════════════════ */
async function applyVaultInfo(info: VaultInfo): Promise<void> {
  const switched = vault === null || vault.root !== info.root
  vault = info

  chromeHandle.vaultRestored()
  vaultLostPath = null
  // §3.3: both banners, both independent bits.  They are siblings of the
  // scroller and shorten it; the vault bar does not move.
  setCapBanners(info.truncated, info.truncatedDepth)
  // §7.3 case 16 / §0.12 E14 — THE READ PATH FOR `watching`, and it is BOTH
  // directions, not just the clear.
  //
  // This line used to be `if (info.watching) clearWatchDegraded()` and nothing
  // else, so the bar was drawn ONLY by the `nc://watch-degraded` event. That was
  // survivable while the toolbar existed, because nav slot 4's Refresh button
  // was in the markup unconditionally and a missed event cost only its lit
  // state. E14 deleted that button and made this bar the ONLY host of the
  // `[ Refresh ]` that calls `rescan_all()` — so a missed event now costs the
  // control itself, and `watching: false` with no bar is a vault whose tree is
  // silently dead for the whole session.
  //
  // WHAT THIS DELIBERATELY DOES NOT FIX (§0.12.2, a user decision): a NETWORK
  // vault (NFS/SMB, §7.3 case 9) has `watching: true` — the watch registers, it
  // simply never fires — so no bar is drawn and there is no route to
  // `rescan_all()` at all. That is ACCEPTED, not overlooked: a menu row and a
  // keybinding were both offered and declined, because neither is worth a
  // permanent affordance for a configuration this user does not have. A network
  // vault picks up external changes on its next OPEN. Do not "fix" it by
  // drawing the bar when `watching` is true — that would put a warning about a
  // broken watcher on every healthy network vault, which is a lie.
  //
  // The event IS missable, and by design rather than by accident. `setup()`
  // spawns the vault open on its own thread, which can emit both
  // `nc://watch-degraded` and `nc://vault-opened` before this page has parsed
  // the bundle and registered a listener; Tauri drops an event with no
  // listener rather than queueing it. §7.5's `current_vault()` fallback exists
  // precisely because that race is real — it is how the vault gets applied at
  // all when the events are lost — and `VaultInfo.watching` is the same fact,
  // carried on a value instead of an event.
  //
  // So: `watching` is authoritative and this is Z2's shape again (a read path
  // for a fact that only had a write path). `hint` is deliberately empty here —
  // only the event carries Rust's hint, and the line alone is true without it.
  if (info.watching) clearWatchDegraded()
  else setWatchDegraded('watch-error', '')
  bar.setVault(info)
  // The fixed Memoir tab lives exactly as long as the vault is open: visible
  // now (lazily creating nothing), hidden again in `releaseVault`.  It is NOT
  // auto-selected — `lastNote` below opens the note tab, and a fresh vault
  // with no `lastNote` waits behind an empty pane with Memoir one click away.
  tabs.setMemoirVisible(true)
  search.setVaultNoteCount(info.nNotes)
  if (switched) search.reset(info.nNotes)

  // The tree, in tree.ts's REPORTED WIRING order.
  //
  // §7.6.1 (errata 3, Z2) — THE READ PATH, and both halves of it are here.
  // `info.expanded` and `info.scrollTop` are the persisted per-vault view state
  // that `prefs.rs` has always stored and that nothing sent back until Z2
  // widened `VaultInfo`; without them the tree opened fully collapsed and the
  // sidebar at the top on every launch.  Rust has already truncated `expanded`
  // to 2,000 and clamped `scrollTop` finite and >= 0, so nothing is re-validated
  // here.
  //
  // ONLY WHEN `switched`, and that is normative, not an optimisation: a
  // `rescan_all` and a re-emitted `nc://vault-opened` both carry the state as it
  // was PERSISTED, and re-applying it on a refresh would collapse every folder
  // the user has expanded since the vault opened (the debounce means the newest
  // expansions are not in that set yet). See
  // `applyVaultInfo` in tests/frontend/vault-restore.test.mjs.
  //
  // The ORDER does not move: `setExpanded` BEFORE the snapshot, because
  // `restore()` then applies the set in the same pass that resolves the cursor;
  // `setScrollTop` AFTER it, because the clamp needs real content height.
  if (switched) tree.setExpanded(info.expanded)
  await refreshTree()
  if (switched) tree.setScrollTop(info.scrollTop)

  if (info.lastNote !== null && currentPath() !== info.lastNote) {
    await openNoteAt(info.lastNote)
  } else if (!switched && currentNoteState() === 'vault-lost') {
    // F66: the vault is back on the same root and the note is still marked
    // vault-lost — return it to live (the base-mtime guard still detects a
    // note changed while the vault was away). Without this the Re-open left
    // the note read-only with autosave off.
    resumeAfterVaultRestored()
  }

  // §0.12 E14 — SORTING IS PINNED TO FILE NAME A-Z, and this is the whole of it.
  //
  // E14 deleted the sort menu at the user's request.  The four orders, §1.3
  // command 7 and the persisted per-vault `sort` all SURVIVE — the ruling was
  // "no UI", not "no sorter" — which leaves exactly one hole: a vault whose
  // state.json already says 2 would open by modified-time forever, with nothing
  // left on screen that could change it back.  So a non-zero mode is corrected
  // ONCE, here, on the path every vault open goes through.
  //
  // Deliberately AFTER `lastNote` opens and after the tree is drawn: the
  // correction is rare (only a vault sorted before E14 shipped), and doing it
  // late means the common case pays nothing and the rare case redraws a tree
  // that is already on screen rather than delaying the first paint.
  //
  // `patchUi` persists it, so the SECOND open of the same vault takes this
  // branch no more.  A failure is reported and dropped: the vault is perfectly
  // usable in the wrong order, and a modal about sort order on every launch
  // would be worse than the wrong order.
  if (info.sort !== 0) {
    try {
      await setSort(0)
      patchUi({ sort: 0 })
      await refreshTree()
    } catch (err) {
      reportError(err, 'pin-sort')
    }
  }

  // §7.4 row 3.  On a vault with no `lastNote` — every first open of a new
  // vault — the tab must not be left showing the note from the vault before it.
  //
  // WHAT THIS LINE IS FOR CHANGED TWICE IN ONE DAY, so it is worth stating what
  // it does NOW rather than what it used to. It was originally about
  // `.empty-state`: `setFirstRun(true)` hid that element and `setFirstRun(false)`
  // did not put it back, so without this call a bare vault showed nothing at
  // all. §0.44 E89 deleted the first-run panel and §0.45 E91 deleted
  // `.empty-state` itself, so BOTH halves of that reason are gone — and the
  // call stays, because `setNote(null)` also hides the TAB, which is §7.4 row 3
  // and is now the only thing that distinguishes "no note open" on screen.
  if (currentPath() === null) tabs.setNote(null)

  // §5.11, "run it": on the first animation frame AFTER `nc://vault-opened`,
  // and — per the fixture — after the note is OPEN.  Running it in `boot()`,
  // as the scaffold did, measures a `.tab` that §7.4 correctly hides when no
  // note is open, which is four guaranteed FAILs in a gate whose whole
  // condition is `fail === 0 && skip === 0`.
  if (!probeDone) {
    probeDone = true
    runGeometryProbe()
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 8.  §1.6 — the flush-on-quit handshake, the frontend's half.
 * ═══════════════════════════════════════════════════════════════════════════ */
async function flushAndClose(): Promise<void> {
  // EDITOR BUFFER FIRST, THE MEMOIR PAGE'S SECOND, `state.json` LAST (§1.6,
  // §7.6).  Rust closes the instant it sees `confirm_close(true)`, so every
  // write must be on disk before that call — not merely started.
  const r = await editorFlushAndClose()
  if (r.ok) {
    // F57: the tree's own 1 s debounce would otherwise die with the renderer.
    tree.flushPersist()
    // F26: the journal page holds its own buffer outside the editor, on its
    // own debounce — quitting without flushing it silently lost the last beat,
    // and everything unsaved after a refused write. A journal that will not
    // save refuses the close exactly like a note that will not save.
    const m = await flushMemoirForClose()
    if (!m.ok) {
      await confirmClose(false, m.kind)
      const pick = await openModal({
        title: 'This journal entry could not be saved.',
        detail: 'The write was refused (' + m.kind + '). Your entry is still on the Memoir page.',
        buttons: [
          { id: 'keep', label: 'Keep editing' },
          { id: 'quit', label: 'Discard changes and quit', destructive: true },
        ],
        defaultId: 'keep',
      })
      // F52: positive too — only an explicit `quit` quits.
      if (pick === 'quit') await confirmClose(true).catch((e: unknown) => reportError(e, 'confirm-close'))
      else void openMemoir()
      return
    }
    await flushUi()
    await confirmClose(true)
    return
  }
  // A REJECTING FLUSH CANCELS THE CLOSE.  The watchdog exists for a hung disk,
  // not for a refused write, so `confirm_close(false, kind)` DISARMS it and the
  // window stays open behind the modal.
  await confirmClose(false, r.kind)
  // §1.6.1's first call site, printed in the contract and reproduced here.
  // `keep` is the default, so it is focused on open and is what Escape picks —
  // Escape can never be the button that discards the user's text.
  // F52: the destructive arm is POSITIVE — only an explicit `quit` quits. A
  // refused dialog answers with its own default, which is never `quit`, so an
  // unknown answer keeps the window open rather than discarding the buffer.
  const pick = await openModal({
    title: 'This note could not be saved.',
    detail: 'The write was refused (' + r.kind + '). Your changes are still in the editor.',
    buttons: [
      { id: 'keep', label: 'Keep editing' },
      { id: 'quit', label: 'Discard changes and quit', destructive: true },
    ],
    defaultId: 'keep',
  })
  if (pick === 'quit') await confirmClose(true).catch((e: unknown) => reportError(e, 'confirm-close'))
  // A refused prompt answers with its own default and leaves the open dialog
  // up: pulling focus to the editor would steal it from that dialog.
  else if (!modalIsOpen()) focusEditor()
}

/** F26: flush the journal for the quit handshake. A resolved flush is not
 *  proof of a write — a refused one leaves the buffer dirty — so both the
 *  throw and the still-dirty report refusal, and the close is cancelled. */
async function flushMemoirForClose(): Promise<{ ok: true } | { ok: false; kind: string }> {
  if (memoir === null) return { ok: true }
  try {
    await memoir.flush()
  } catch (e) {
    const kind = e !== null && typeof e === 'object' && 'kind' in e
      ? String((e as { kind: unknown }).kind)
      : 'io'
    return { ok: false, kind }
  }
  if (memoir.isDirty()) return { ok: false, kind: 'conflict' }
  return { ok: true }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 9.  Boot.
 * ═══════════════════════════════════════════════════════════════════════════ */
function boot(): void {
  mountChrome()

  /* THE WHEEL GLIDE IS DELETED WITH THE WEBKIT SHELL (§8.2 step 10).
     `src/wheel.ts` existed to reproduce CHROMIUM's wheel glide on WebKit, whose
     own law (`min(distance/1000, 200ms)`, no floor) turns a small notch into a
     three-frame step.  On Chromium the engine already IS the glide, and the
     module SUPPRESSED the native one by calling `preventDefault()` on a
     non-passive listener — measured on the first Electron run, spike P §5.
     Withholding it was the fix; deleting it with the engine it was written for
     is the end of that story, exactly as spike P said it should be. */

  // §7.4 row 3: with no note open the tab is NOT RENDERED.  `mountChrome()`
  // above has already hidden it, before any await, so the scaffold's visible
  // `.tab is-active` never reaches a frame.

  // CONTRACT §6.1: the window is created `visible: false` and shown by the
  // frontend on its first animation frame, and §7.5: `setup()` MUST NOT block
  // on the vault walk.  Together those are what keep an empty grey rectangle
  // off the screen during the walk.
  //
  // Raced with a timeout: if the first frame is ever delayed or lost — locked
  // screen, occluded window, compositor hiccup — the app still appears instead
  // of sitting invisible.
  // `show()` is idempotent, so whichever fires first wins and the other is a
  // no-op; on the normal path rAF wins and behaviour is unchanged.
  //
  // `emitFrontendReady` is the same moment through the other channel: the
  // direct `show()` above needs `core:window:allow-show`, which dl_28
  // deliberately withholds from the webview (gap G-b), so where it is denied
  // Rust shows the window on this event instead (lib.rs, unrestricted side).
  // Either path maps the same window; both firing is a harmless no-op.
  let shown = false;
  const showOnce = (): void => {
    if (shown) return;
    shown = true;
    void showMainWindow();
    emitFrontendReady();
  };
  requestAnimationFrame(showOnce);
  setTimeout(showOnce, 1000);

  configurePersist(saveUiState, (err) => reportError(err, 'save-ui-state'))

  /* ── the editor.  EXACTLY ONE EditorView for the process lifetime (M70). ── */
  configureEditor({ readNote, writeNote, renameEntry, createNote })
  setEditorHooks({
    onPathChanged: (path) => {
      // `Memoir.md` never arrives here: `openNoteAt` intercepts it into the
      // Memoir page before `openNote` runs, so the editor only ever holds
      // real notes and every path below resolves a tree row.
      tabs.setNote(path)
      tabs.setActive('note')
      tree.setActivePath(path)
      patchUi({ lastNote: path })
    },
    onDirtyChanged: (dirty) => tabs.setDirty(dirty),
    // F66: the conflict/detached states draw the note bar (their Keep mine /
    // Reload / Save as… buttons are wired in `wireChrome` below); every other
    // state removes it. `vault-lost` keeps its sidebar bar.
    onNoteStateChanged: (stateName, err) => {
      if (err && stateName !== 'live') reportError(err, 'note-' + stateName)
      chromeHandle.noteState(stateName === 'conflict' || stateName === 'detached' ? stateName : null)
    },
    onFlushError: (reason, err) => reportError(err, 'flush-' + reason),
    onEmpty: () => {
      tabs.setNote(null)
      tree.setActivePath(null)
      patchUi({ lastNote: null })
    },
  })
  const ed = document.getElementById('ed')
  if (ed) mountEditor(ed)
  // THE MEMOIR PAGE.  Mounted beside `#ed` inside `main.editor`, hidden until
  // the tab selects it.  Transport is `ipc.ts`'s own functions, handed down —
  // owner 03's module never imports them (§6.4).
  if (ed?.parentElement) {
    memoirPane = ed.parentElement
    memoir = mountMemoir(memoirPane, {
      path: MEMOIR_PATH,
      transport: { readNote, writeNote, createNote },
      onDirtyChanged: (dirty) => tabs.setDirty(dirty),
      onFirstCreate: () => {
        void refreshTree()
      },
      onError: reportError,
    })
  }
  // §0.38 E85.  AFTER `tree` exists?  No — the host reads `tree` lazily on each
  // click, so registering here is safe and keeps the editor's wiring together.
  linkHost()

  /* ── the tree.  Its two persist callbacks are already debounced 1 s inside
       tree.ts; state.ts debounces a second time ACROSS producers (§7.6). ──── */
  const scroller = document.querySelector<HTMLElement>('.tree-scroller')
  if (!scroller) throw new Error('main.ts: .tree-scroller is missing from index.html')
  tree = createTree({
    scroller,
    openNote: (path) => { void openNoteAt(path) },
    // F54: only the disappearance of the note that is actually open detaches
    // it. The clicked row takes the active highlight before its open is known
    // to succeed, so any OTHER row's disappearance must not touch the buffer.
    onActiveVanished: (p) => { if (p === currentPath()) markDetached() },
    onExpandedChanged: (expanded) => patchUi({ expanded }),
    onScrollTopChanged: (scrollTop) => patchUi({ scrollTop }),
    onContextMenu: rowMenu,
    onRenameRequest: renameFlow,
    onDeleteRequest: (p, d) => { void deleteTargets(deleteSubject(p, d)) },
    onMoveRequest: (sources, destParent) => moveFlow(sources, destParent),
    getVaultName: () => vault?.name ?? 'vault',
    onEscape: () => focusEditor(),
    isFrozen: () => vaultLostPath !== null,
  })

  /* ── search.  The panel REPLACES the tree in the same band; the two are
       never live at once, which is what keeps `layers.scrollers` at two. ──── */
  const sidebar = document.querySelector<HTMLElement>('.sidebar')
  if (!sidebar) throw new Error('main.ts: .sidebar is missing from index.html')
  search = mountSearch(sidebar, {
    start: searchStart,
    cancel: searchCancel,
    expand: searchExpand,
    async openResult(rel, line, col, len) {
      if (await openNoteAt(rel)) selectRange(line, col, len)
    },
    focusEditor: () => focusEditor(),
  })

  /* ── the tab strip and the vault bar. ─────────────────────────────────── */
  // User ruling 2026-09-16: BOTH tabs are FIXED and carry no close button, so
  // the strip takes no flush/close deps — only tab selection.  Delete, vault
  // switch and quit all go through `showEmpty` and leave the pane empty with
  // Memoir one click away.
  // In-note find is NOTE VIEWER ONLY: the bar overlays `main.editor` (which
  // also hosts the Memoir page), so it is mounted on the pane but the toggle
  // refuses while the page is visible and every route to the page hides it.
  const editorPane = document.querySelector<HTMLElement>('main.editor')
  if (!editorPane) throw new Error('main.ts: main.editor is missing from index.html')
  find = mountFind(editorPane, {
    getText: () => findDocText(),
    getSelection: () => findSelectionText(),
    reveal: (from, to) => findReveal(from, to),
    setHighlight: (query, caseSensitive, from, to) =>
      setFindHighlightInView(query, caseSensitive, from, to),
    focusEditor: () => focusEditor(),
    onDocChanged: (cb) => onFindDocChanged(cb),
  })
  tabs = createTabStrip({
    // §0.30 E71 — NO `newNote` HERE ANY MORE.  It was the tab strip's `+`, and
    // that button is deleted; Mod-N below is unchanged and still carries the
    // same destination rule.
    onSelect: (which) => switchTab(which),
  })

  bar = createVaultBar({
    pickVault,
    openVault,
    recentVaults,
    // §1.3 command 21 (§0.30 E70).  Straight through: the popover's `Close` is
    // the only caller and the core owns the refusal for the open vault.
    forgetVault,
    releaseVault,
    onError: reportError,
  })

  /* ── the chrome: the banners, the window controls, seven shortcuts. ─────── */
  chromeHandle = wireChrome({
    // Mod-N creates BESIDE the cursor, which is what `destinationFor(_, false)`
    // computed before §0.16 E18 deleted it: that helper's only other caller was
    // the row menu, and its `isDir` branch died with the file menu's create
    // rows, leaving `parentOf` under a second name.
    //
    // REPORTED, NOT CHANGED: with the cursor ON A FOLDER this still creates the
    // note in that folder's PARENT, which is not what E18's own model would
    // predict. It is pre-existing, it is not what the user asked about, and
    // changing a keyboard shortcut's destination is not a silent edit.
    newNote: () => newNoteIn(parentOf(tree.cursorPath() ?? '')),
    // §7.3 case 16's `[ Refresh ]`.  The VaultInfo it resolves to is discarded
    // on purpose: §1.4 makes `nc://vault-opened` the ONE application point, and
    // `rescan_all` re-emits it (see this file's header, rule 2).
    rescanAll: async () => { await rescanAll() },
    toggleSearch: () => search.toggle(),
    toggleFind: () => toggleFind(),
    switchVault: () => bar.openPopup(),
    // User ruling 2026-09-16: Mod-1 / Mod-2 select the note / Memoir tab —
    // the same flush-first `switchTab` the tab clicks go through.
    selectTab: (which) => switchTab(which),
    // §0.7 E9.  Straight into the SAME debounced patch every other persisted
    // dimension uses — no new command, no new event, no second write path.
    saveSidebarW: (w) => patchUi({ sidebarW: w }),
    pickVault: () => { void bar.pickAndSwitch() },
    reopenVault: () => {
      const root = vaultLostPath ?? vault?.root
      if (root) void openVault(root).catch((e: unknown) => reportError(e, 'reopen'))
    },
    flushNow: (reason) => editorFlush(reason as FlushReason),
    // F66 (§7.3 cases 5/7): the note bar's four buttons. `keepMine` force-
    // overwrites (snapshotting the disk loser to a sidecar first) and
    // `reloadFromDisk` discards the buffer; both live in owner 03's module
    // and this is their first caller.
    keepMine: () => keepMine().catch((e: unknown) => reportError(e, 'keep-mine')),
    reloadFromDisk: () => reloadFromDisk().catch((e: unknown) => reportError(e, 'reload-note')),
    saveAsPrompt,
    discardNote: () => { hideFind(); showEmpty() },
    onVaultLost: (path) => {
      // §7.3 case 8, the half that is not chrome's: stop autosave and mark the
      // buffer read-only.  The tree freezes through `isFrozen` above.
      vaultLostPath = path
      hideFind()
      markVaultLost()
    },
    onError: reportError,
  })

  /* ── §1.4's six `nc://` events, each to its owner's handler. ──────────── */
  const subs: Array<Promise<unknown>> = [
    onVaultOpened((info) => { void applyVaultInfo(info) }),
    onTreeChanged(() => {
      void refreshTree().then(() => search.onTreeChanged())
    }),
    onVaultLost((p) => chromeHandle.vaultLost(p.path)),
    onWatchDegraded((p) => setWatchDegraded(p.reason, p.hint)),
    onNoteExternalChange((p) => {
      // F47: the journal page owns its own buffer outside the editor, so the
      // editor's reload cannot cover it — route its path to the page.
      if (p.path === MEMOIR_PATH && memoir !== null) {
        memoir.externalChange()
        return
      }
      // F90: the payload carries the disk's mtime and size, so a metadata-only
      // change skips the reload instead of rebuilding every widget over it.
      void noteExternalChange(p.path, p.mtimeMs, p.size).catch((e: unknown) => reportError(e, 'external-change'))
    }),
    onFlushAndClose(() => { void flushAndClose() }),
  ]
  for (const s of subs) void s.catch((e: unknown) => reportError(e, 'listen'))

  /* ── §7.5, M65: three states, three different screens. ────────────────── */
  void currentVault()
    .then((st) => {
      if (st.state === 'none') {
        // §0.44 E89 — THE PROMPT IS GONE; THE STATE IS NOT.  `setFirstRun(true)`
        // drew a centred `Open folder as vault…` button here and the user ruled
        // it out: the vault bar's switcher at the bottom left is the picker, in
        // this state as in every other.  What is left is telling the bar that
        // there is no vault, which is the `null` arm `VaultBar.setVault` has
        // always documented — it gives the button the "Open a vault" label
        // instead of "Switch vault — <name>", and a screen reader has no other
        // way to tell the two apart.
        bar.setVault(null)
      } else if (st.state === 'open') {
        void applyVaultInfo(st.info)
      }
      // 'loading': the walk is in flight on its own thread; the shell is
      // already drawn and `nc://vault-opened` will arrive.
    })
    .catch((e: unknown) => reportError(e, 'current-vault'))
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true })
} else {
  boot()
}
