/**
 * src/ipc.ts
 * Owner: 02 (MOVED from 06 — CONTRACT.md §6.4, M41).
 * Spec: CONTRACT.md §1.1 (conventions), §1.2 (transport), §1.3 (the twenty-
 * five commands), §1.4 (the event table), §1.5 (the wire types), §2.3 (the exact
 * `write_note` call), §5.11 (emitGeometryReport).
 *
 * THE ONLY MODULE IN THE APP THAT TALKS TO THE SHELL.  Every other frontend
 * module imports typed wrappers from here (spec-07 §1, rule 1), and that rule
 * is why the port cost three lines: §8.1 measured the entire Tauri coupling of
 * `src/*.ts` at this file's three imports, and this is what they became.
 *
 * ============ IT IS ELECTRON'S NOW.  `@tauri-apps/api` IS GONE. ==============
 * This file WAS `electron-shell/ipc-electron.mjs`, which `build-app.mjs`
 * substituted for this module at bundle time to prove §8.1's claim without
 * touching `src/`.  The claim is proved and the Tauri shell is deleted, so the
 * substitution has nothing left to substitute: the seam is back where §1.1 puts
 * it and the redirect plugin is gone with it.
 * ============================================================================
 *
 * The command table is CLOSED AT TWENTY-FIVE.  `list_tree`, `set_expanded`,
 * `reveal`, `tree_load`, `fs_*`, `vault_*`, `tree_set_sort` and `scan_vault`
 * DO NOT EXIST.  Adding a command touches `core/napi/src/lib.rs`
 * and `electron-shell/native.mjs` — both owner 07's — and one logic module.
 *
 * THREE THINGS THAT LOOK LIKE STYLE AND ARE NOT:
 *
 *   1. §1.5 CROSSES AS A VALUE, NOT AS A THROW.  `ipcMain.handle` serialises a
 *      thrown Error by its `message` and `stack` and by nothing else, so a
 *      structured payload cannot survive main -> renderer however it is thrown.
 *      The shell answers `{ok, value}` / `{ok, error}` and `call()` throws the
 *      error object HERE, in the page's own world, where it is a plain object
 *      with a `kind` — which is what Tauri's `invoke` rejected with and what
 *      `editor.ts:209`, `inline-edit.ts:488` and `tabstrip.ts:215` are written
 *      against.  This was inert for the whole of step 4 (CONTRACT §0.20 E29).
 *   2. `writeNote` sends BYTES, not a string.  §2.3's frame is defined over
 *      bytes, so the `TextEncoder` belongs on this side of the boundary; doing
 *      it in the main process would put a second encoder on the write path.
 *   3. `baseMtimeMs === undefined` is REFUSED by the addon, and that is the
 *      structured-clone equivalent of Rust refusing a missing `x-base-mtime`
 *      header: a conflict guard that silently disables itself when a field is
 *      dropped is not a guard (§1.1, §7.2).
 *
 * ARGUMENT NAMES ARE snake_case ON BOTH SIDES (§1.1), which is why `renameEntry`
 * sends `new_name`.  Payload FIELDS are camelCase.  The two rules do not
 * collide — see §1.1.
 */

import { decodeNote } from './note_frame.js'

// Only the names this file's own signatures mention.  `FileGroup` and
// `VaultError` are part of §1.5 and are re-exported below, but nothing here
// names them, and `noUnusedLocals` is right to say so.
import type {
  CreateResult,
  DeleteResult,
  NoteRead,
  RecentVault,
  RenameResult,
  SearchMsg,
  Snippet,
  SortMode,
  UiPatch,
  VaultInfo,
  VaultPath,
  VaultState,
  WriteReceipt,
} from './ipc.d'

/* §1.5 is declared in `src/ipc.d.ts` (owner 02's normative transcription) and
   re-exported HERE so that every other module writes `from './ipc'` and never
   has to know the declaration file exists.  `./ipc` resolves to this file, not
   to the sibling `.d.ts`, which is why the re-export is needed at all. */
export type {
  CreateResult,
  DeleteResult,
  FileGroup,
  NoteRead,
  RecentVault,
  RenameResult,
  SearchMsg,
  Snippet,
  SortMode,
  UiPatch,
  VaultError,
  VaultInfo,
  VaultPath,
  VaultState,
  WriteReceipt,
} from './ipc.d'

/** What `electron-shell/preload.cjs` publishes on `window.cairn`, and the whole
 *  of the renderer's reach: a request/response `invoke` and a subscription.
 *  No `require`, no `fs`, no `ipcRenderer` (pinned by `dl_28`). */
interface CairnBridge {
  invoke(command: string, args?: unknown): Promise<{ ok: boolean; value?: unknown; error?: unknown }>
  on(event: string, handler: (payload: never) => void): Unlisten
  emit(event: string, payload?: unknown): void
}

const bridge = (): CairnBridge => {
  const b = (globalThis as { cairn?: CairnBridge }).cairn
  if (!b) throw new Error('ipc: preload bridge missing (window.cairn is undefined)')
  return b
}

/**
 * §1.5, UNWRAPPED IN THE PAGE'S OWN WORLD — see this file's header, point 1.
 *
 * The envelope is checked positively (`ok === false`), never by looking for a
 * missing field: eight of the twenty commands legitimately resolve to
 * `undefined`, and none of them is a failure.
 *
 * Every invoke races a 30 s timeout so one hung main-process command (hung
 * disk, exhausted blocking pool) rejects instead of stalling its caller
 * forever — except the two in `NO_TIMEOUT`.
 *
 * `write_note` IS NOT RACED.  The timeout cannot cancel the write, which keeps
 * running in Rust; rejecting early would only release the editor's and the
 * Memoir's write chains, and their next save would go out with the same base
 * mtime while the first can still land after it — older text on disk under a
 * receipt for the newer.  A hung write therefore holds its chain until the
 * disk answers, and a quit is still bounded by §1.6's watchdog.
 */
const IPC_TIMEOUT_MS = 30_000

/** `pick_vault` is user-paced (the native folder dialog can stay open for
 *  minutes); `write_note` must settle only when the write has. */
const NO_TIMEOUT: ReadonlySet<string> = new Set(['pick_vault', 'write_note'])

function ipcTimeout(command: string): Promise<never> {
  return new Promise<never>((_, reject) => {
    const id = setTimeout(() => {
      reject({ kind: 'io', message: `ipc timeout: ${command} did not answer within ${IPC_TIMEOUT_MS} ms` })
    }, IPC_TIMEOUT_MS)
    // Do not hold a test runner open for the full window once settled.
    if (typeof (id as unknown as { unref?: () => void }).unref === 'function') {
      ;(id as unknown as { unref: () => void }).unref()
    }
  })
}

async function call<T>(command: string, args?: unknown): Promise<T> {
  const pending = bridge().invoke(command, args)
  const r = NO_TIMEOUT.has(command) ? await pending : await Promise.race([pending, ipcTimeout(command)])
  if (r && r.ok === false) throw r.error
  return (r ? r.value : undefined) as T
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 1-5.  The vault.
 * ═══════════════════════════════════════════════════════════════════════════ */

/** §1.3 command 1.  The picker is Electron's `dialog.showOpenDialog`, opened by
 *  the MAIN process — §6.2's property was WHO opens it, and the renderer still
 *  only asks.  `null` means the user cancelled, not an error. */
export function pickVault(): Promise<string | null> {
  return call<string | null>('pick_vault')
}

/** §1.3 command 2.  Emits `nc://vault-opened` on success, including at startup. */
export function openVault(path: string): Promise<VaultInfo> {
  return call<VaultInfo>('open_vault', { path })
}

/** §1.3 command 3.  A DISCRIMINATED union, never an `Option<VaultInfo>` (M65). */
export function currentVault(): Promise<VaultState> {
  return call<VaultState>('current_vault')
}

/** §1.3 command 4. */
export function recentVaults(): Promise<RecentVault[]> {
  return call<RecentVault[]>('recent_vaults')
}

/** §1.3 command 5.  The watcher-degraded banner's `[ Refresh ]` (M57). */
export function rescanAll(): Promise<VaultInfo> {
  return call<VaultInfo>('rescan_all')
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 6-7.  The tree.
 * ═══════════════════════════════════════════════════════════════════════════ */

/** §1.3 command 6.  TreeBlob v1, ONE crossing (B1/B19/M49). */
export async function treeSnapshot(): Promise<ArrayBuffer> {
  const buf = await call<ArrayBuffer>('tree_snapshot')
  // A transport that has quietly degraded hands back something
  // `new Uint8Array(...)` would happily accept.
  if (!(buf instanceof ArrayBuffer)) {
    throw new Error(
      'tree_snapshot did not return an ArrayBuffer (got ' +
        Object.prototype.toString.call(buf) +
        ') - the IPC transport has degraded'
    )
  }
  return buf
}

/** §1.3 command 7.  `sort` is the wire u8 0..3 (M28/M53).  Resolves to the NEW
 *  EPOCH.  One caller: `main.ts` correcting a vault whose PERSISTED mode is not
 *  0 (§0.12 E14 pinned the order to file name A-Z). */
export function setSort(sort: SortMode | number): Promise<number> {
  return call<number>('set_sort', { sort })
}

/** §1.3 command 25 (user feature, 2026-09-16): the secret notes' rels, in
 *  snapshot order.  Feeds the tree's row mark via `tree.setSecrets`, called
 *  from the same `refreshTree` that applies the snapshot. */
export function secretNotes(): Promise<string[]> {
  return call<string[]>('secret_notes')
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 8-9.  Notes.  The two raw-transport calls.
 * ═══════════════════════════════════════════════════════════════════════════ */

/** §1.3 command 8 + §2's frame.  `decodeNote` is `src/note_frame.js`'s and is
 *  the ONLY JS copy of the layout — this file must not restate a byte offset
 *  (spec-07 §1, rule 4). */
export async function readNote(path: VaultPath): Promise<NoteRead> {
  return decodeNote(await call<ArrayBuffer>('read_note', { path })) as NoteRead
}

/**
 * §1.3 command 9 + §2.3.  See this file's header, points 2 and 3.
 *
 * `create` is '1' in EXACTLY ONE PLACE in the whole app — the "Save as…" button
 * on §7.3 case 5's bar — because `write_note` NEVER CREATES (§7.1 rule 1).
 */
export function writeNote(
  path: VaultPath,
  text: string,
  flags: number,
  baseMtimeMs: number | null,
  create: boolean
): Promise<WriteReceipt> {
  return call<WriteReceipt>('write_note', {
    path,
    text: new TextEncoder().encode(text),
    flags,
    baseMtimeMs: baseMtimeMs === undefined ? null : baseMtimeMs,
    create,
  })
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 10-13.  Mutations.  All return `{ path, epoch }`-shaped results and NEVER a
 * blob; the caller follows with `treeSnapshot()`, which keeps every binary
 * payload on one code path (§1.3).
 * ═══════════════════════════════════════════════════════════════════════════ */

/** §1.3 command 10.  `parent` is "" for the vault root (§1.1). */
export function createNote(parent: VaultPath, name?: string): Promise<CreateResult> {
  return call<CreateResult>('create_note', { parent, name: name ?? null })
}

/** §1.3 command 11. */
export function createFolder(parent: VaultPath, name?: string): Promise<CreateResult> {
  return call<CreateResult>('create_folder', { parent, name: name ?? null })
}

/** §1.3 command 12.  Updates `AppState.open_note` under the write lock (M54);
 *  the caller adopts `RenameResult.path` rather than computing it (§7.3 case 4,
 *  §5.4.2).  Note the snake_case argument name (§1.1). */
export function renameEntry(path: VaultPath, newName: string): Promise<RenameResult> {
  return call<RenameResult>('rename_entry', { path, new_name: newName })
}

/** §1.3 command 13.  Delete of the OPEN note is ORDERED, not raced (B17). */
export function deleteEntry(path: VaultPath, permanent: boolean): Promise<DeleteResult> {
  return call<DeleteResult>('delete_entry', { path, permanent })
}

/** §1.3 command 24.  Drag-to-move: `path` into `destParent` (`''` = vault root).
 *  Obsidian's file-explorer drop, transcribed: a drop moves via rename with
 *  `getAvailablePath` uniquification, so it never refuses on collision — the
 *  returned `path` is the FINAL one (`Foo 1.md`), adopted never recomputed,
 *  exactly like `renameEntry`'s. Backend enforces SA (a folder into itself or
 *  a descendant is `invalidPath`) and the already-there no-op. */
export function moveEntry(path: VaultPath, destParent: VaultPath): Promise<RenameResult> {
  return call<RenameResult>('move_entry', { path, dest_parent: destParent })
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 14-16.  Search.  NEVER the global event bus — a per-call channel (§1.4).
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * §1.3 command 14.  The subscription outlives the CALL and ends on the message,
 * which is the Tauri `Channel`'s own lifetime.
 *
 * `search::start` stores the generation, spawns the coordinator on a blocking
 * worker and RETURNS — "it never awaits the scan" — so every message arrives
 * after this promise has resolved.  `complete` and `error` are both TERMINAL
 * for their generation (§1.4), and `Complete` is sent even for a superseded one
 * (`cancelled: true`), which is what guarantees the teardown always happens.
 *
 * The generation is the FRONTEND's (X15): `search.ts` owns the counter, Rust
 * stores the newest value it has been given and echoes it on every message.
 */
export function searchStart(
  query: string,
  generation: number,
  onMsg: (msg: SearchMsg) => void
): Promise<void> {
  const channel = 'search:' + generation
  let off: Unlisten | null = null
  const stop = (): void => {
    if (off) {
      off()
      off = null
    }
  }
  off = bridge().on(channel, (msg: SearchMsg) => {
    onMsg(msg)
    if (msg && (msg.kind === 'complete' || msg.kind === 'error')) stop()
  })
  return call<void>('search_start', { query, generation }).catch((e: unknown) => {
    stop()
    throw e
  })
}

/** §1.3 command 15.  Re-greps ONE file at call time; a deleted file is an empty
 *  array, never an error (spec-05 §11.3). */
export function searchExpand(query: string, rel: VaultPath): Promise<Snippet[]> {
  return call<Snippet[]>('search_expand', { query, rel })
}

/** §1.3 command 16.  The number passed back is one `search.ts` issued (X15). */
export function searchCancel(generation: number): Promise<void> {
  return call<void>('search_cancel', { generation })
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 17-18, 20-23.  State, lifecycle, diagnostics.
 * ═══════════════════════════════════════════════════════════════════════════ */

/** §1.3 command 17.  `prefs.rs` ABSORBED the removed `state.rs` (M25); the file
 *  is `<appData>/com.cairn.app/state.json` and NEVER inside the vault (§7.6). */
export function saveUiState(patch: UiPatch): Promise<void> {
  return call<void>('save_ui_state', { patch })
}

/** §1.3 command 18.  The frontend's half of the §1.6 flush-on-quit handshake.
 *  `confirmClose(false, kind)` DISARMS the watchdog and CANCELS the close — a
 *  rejecting flush never falls through to a discard (B11/B18/M55). */
export function confirmClose(ok: boolean, reason?: string): Promise<void> {
  return call<void>('confirm_close', { ok, reason: reason ?? null })
}

/** §1.3 command 20.  "Reveal in Finder", RESTORED (X11).  Resolved through the
 *  arena exactly as `read_note` is.  MACOS ONLY: `fsops::reveal_in_os` has no
 *  Linux arm and answers a §1.5 `io` there (CONTRACT §0.20.2). */
export function revealInOs(path: VaultPath): Promise<void> {
  return call<void>('reveal_in_os', { path })
}

/** §1.3 command 21 (§0.30 E70).  Drop a vault from the tracked list — Obsidian's
 *  own `vault-remove`, which its vault chooser offers as *"Remove from list"*.
 *  **It touches nothing in the vault**: the folder on disk is not read, moved or
 *  deleted, and the only file written is `state.json`.
 *
 *  REJECTS `invalidPath` FOR THE OPEN VAULT, which is Obsidian's rule too
 *  (*"Can't remove a currently open vault."*).  The vault bar only draws the
 *  control on a non-active row, so that is a guard and not a path a user walks. */
export function forgetVault(root: string): Promise<void> {
  return call<void>('forget_vault', { root })
}

/** §1.3 command 22 (§0.38 E85).  Hand a url to the OS, for a link a note
 *  contains.  **SHELL-IMPLEMENTED, not Rust** — like `pick_vault` (command 1),
 *  because `shell.openExternal` is Electron's and the Rust core has no business
 *  launching a browser.
 *
 *  THE SCHEME ALLOWLIST IS ENFORCED IN THE MAIN PROCESS, not here.  This
 *  function is a convenience for the one caller; the renderer is not trusted to
 *  decide what the OS may be asked to open, and a note is somebody else's text.
 *  `app-main.mjs` accepts `http:`, `https:` and `mailto:` and rejects everything
 *  else with a §1.5 `invalidPath`.
 *
 *  NOT A TRANSCRIPTION.  Obsidian normalises (`new URL(e).toString()`) and does
 *  not restrict the scheme at this point; Cairn's allowlist is a Cairn decision
 *  and is marked as one (§0.38.3). */
export function openExternal(url: string): Promise<void> {
  return call<void>('open_external', { url })
}

/** §1.3 command 23 (§0.46 E94).  Put text on the system clipboard, for the
 *  `totp` block's click-to-copy.  **SHELL-IMPLEMENTED, not Rust** — the
 *  clipboard is the window system's, not the vault's.
 *
 *  IT IS A COMMAND RATHER THAN `navigator.clipboard` BECAUSE THAT WAS MEASURED
 *  TO FAIL HERE.  In a real `file://` renderer the Async Clipboard API is
 *  present and `writeText` rejects with *"Document is not focused."*  Electron's
 *  main-process `clipboard` has no such requirement.  The main process bounds
 *  the length; nothing else is enforced, because unlike `open_external` this
 *  launches nothing. */
export function copyText(text: string): Promise<void> {
  return call<void>('copy_text', { text })
}

/* ═══════════════════════════════════════════════════════════════════════════
 * The §1.4 event table.  ONE namespace: `nc://`.  `vault://`, `note://` and
 * `tree:` are STRUCK everywhere.
 *
 * Each wrapper resolves to its own unlisten function.  They are never called in
 * the shipped app — the subscriptions live for the process — but returning them
 * is what lets a test tear one down.
 * ═══════════════════════════════════════════════════════════════════════════ */

export type Unlisten = () => void

const on = <T>(event: string, handler: (p: T) => void): Promise<Unlisten> =>
  Promise.resolve(bridge().on(event, handler as (p: never) => void))

export function onVaultOpened(h: (info: VaultInfo) => void): Promise<Unlisten> {
  return on('nc://vault-opened', h)
}
export function onTreeChanged(h: (p: { epoch: number }) => void): Promise<Unlisten> {
  return on('nc://tree-changed', h)
}
export function onVaultLost(h: (p: { path: string }) => void): Promise<Unlisten> {
  return on('nc://vault-lost', h)
}
export function onWatchDegraded(
  h: (p: { reason: 'watch-limit' | 'watch-error'; hint: string }) => void
): Promise<Unlisten> {
  return on('nc://watch-degraded', h)
}
export function onNoteExternalChange(
  h: (p: { path: string; mtimeMs: number; size: number }) => void
): Promise<Unlisten> {
  return on('nc://note-external-change', h)
}
export function onFlushAndClose(h: (p: { deadlineMs: number }) => void): Promise<Unlisten> {
  return on('nc://flush-and-close', h)
}
export function onWindowState(h: (p: { maximized: boolean }) => void): Promise<Unlisten> {
  return on('nc://window-state', h)
}

/* ═══════════════════════════════════════════════════════════════════════════
 * Harness and window plumbing.  Plain events, never a 21st command — the table
 * is CLOSED AT TWENTY (§1.3).
 * ═══════════════════════════════════════════════════════════════════════════ */

/** §5.11.  The shell prints the report as one JSON line and makes `ok` the exit
 *  code.  THAT EXIT CODE IS GATE G9. */
export function emitGeometryReport(report: unknown): void {
  bridge().emit('geometry-report', report)
}

/** §6.1's show path.  The page announces its first frame and the SHELL maps the
 *  window, so the renderer never needs a window API of its own (`dl_28`). */
export function emitFrontendReady(): void {
  bridge().emit('frontend-ready')
}

/** §0.5 E7.  A three-string union, and the shell IGNORES anything else rather
 *  than defaulting: guessing `close` on drift is unthinkable. */
export function emitWindowControl(action: 'minimize' | 'toggle-maximize' | 'close'): void {
  bridge().emit('window-control', { action })
}

/** Kept as a no-op-safe call for the harnesses that boot without a shell. */
export async function showMainWindow(): Promise<void> {
  try {
    await call<void>('show_main_window')
  } catch {
    // No shell listening -- a test harness, not a failure worth surfacing.
  }
}
