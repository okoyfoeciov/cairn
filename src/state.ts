/**
 * src/state.ts
 * Owner: 04.  Spec: CONTRACT.md §7.6 (state.json — one file, one schema),
 * §1.5 (UiPatch), §4.3 step 2, §1.6, M25, M60.
 *
 * ONE JOB: compose `UiPatch` and debounce `save_ui_state`.  This module holds
 * no app state of its own beyond the patch that has not been written yet.
 *
 * THE FILE IS prefs.rs's, NOT THIS MODULE'S (M25).  `core/src/state.rs`
 * was REMOVED from the file table; persisted state lives in
 * `app_config_dir()/state.json` — on macOS
 * `~/Library/Application Support/com.cairn.app/state.json` — and NEVER
 * inside the vault.  spec-04 §11's `md.notes/`, `recent.json`,
 * `vaults/<hash>.json` and `dirs::config_dir()` are all STRUCK.  This module
 * does not know the schema, the per-vault keying or the pruning rules; it emits
 * §1.5's `UiPatch` and Rust owns the file.
 *
 * `sidebarW` IS BACK (§0.7 E9), and M60 — "`sidebar_w` is deleted, the sidebar
 * is fixed at 412px" — is STRUCK.  The sidebar is resizable at the user's
 * request, so the dimension CAN change and the reason M60 gave for deleting the
 * field no longer holds.  It is GLOBAL, beside `win`, not per-vault: it is a
 * property of the window the user arranged, not of the notes in it.
 * `expanded` is folders only and is capped at 2000 entries (§7.6).
 *
 * WHY A DEBOUNCE AND NOT A WRITE PER EVENT.  Three of the five fields are
 * produced by things that fire continuously: `scrollTop` on every frame of a
 * trackpad fling, `expanded` on every chevron, `lastNote` on every note switch.
 * §7.6 fixes the window at 1,000 ms.  The tree already debounces its own two
 * callbacks by 1 s (§5.12.6(d)), so in practice this is a SECOND stage that
 * coalesces ACROSS producers — a scroll and an expansion inside the same second
 * become one `save_ui_state`, not two.
 *
 * `lastNote` HAS THREE STATES, NOT TWO, and the Rust side is
 * `Option<Option<String>>` to match: ABSENT means "this patch does not mention
 * the open note", `null` means "there is no open note now".  Collapsing them
 * loses the ability to close the last note and have that survive a restart.
 * `mergeInto` below therefore tests `'lastNote' in p`, never `p.lastNote != null`.
 */

import type { UiPatch, VaultPath } from './ipc'

/** §7.6.  Not configurable: the schema names the number. */
export const PERSIST_DEBOUNCE_MS = 1_000

/** §7.6.  `src/tree.ts` caps its own `expanded()` at the same number; this is
 *  the belt to that file's braces, because state.ts is the last thing between a
 *  caller and a 250 KB prefs file. */
export const EXPANDED_CAP = 2_000

/** The transport seam.  `src/ipc.ts` supplies `saveUiState`; a test supplies a
 *  spy.  Kept injectable so this module has no import of `@tauri-apps/api`,
 *  directly or transitively (§1.1). */
export type SaveFn = (patch: UiPatch) => Promise<void>

let save: SaveFn | null = null
let pending: UiPatch | null = null
let timer: ReturnType<typeof setTimeout> | null = null
/** The write currently on the wire, so `flush()` can await a save that has
 *  already left rather than starting a second one behind it. */
let inFlight: Promise<void> | null = null
let onError: ((err: unknown) => void) | null = null

export function configurePersist(fn: SaveFn, errorSink?: (err: unknown) => void): void {
  save = fn
  onError = errorSink ?? null
}

function mergeInto(target: UiPatch, p: UiPatch): void {
  if (p.win !== undefined) target.win = p.win
  // See the header: presence, not value.  `exactOptionalPropertyTypes` makes
  // the assignment below legal only because the field is `VaultPath | null`.
  if ('lastNote' in p) target.lastNote = p.lastNote as VaultPath | null
  if (p.sort !== undefined) target.sort = p.sort
  if (p.expanded !== undefined) {
    target.expanded = p.expanded.length > EXPANDED_CAP ? p.expanded.slice(0, EXPANDED_CAP) : p.expanded
  }
  if (p.scrollTop !== undefined) target.scrollTop = p.scrollTop
  if (p.sidebarW !== undefined) target.sidebarW = p.sidebarW
}

/**
 * Queue a patch.  Coalesces with anything already queued — LAST WRITER WINS per
 * field, which is what makes "scrolled, then expanded, then scrolled again"
 * one message carrying the final scrollTop.
 */
export function patchUi(p: UiPatch): void {
  if (!pending) pending = {}
  mergeInto(pending, p)
  if (timer !== null) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    void write()
  }, PERSIST_DEBOUNCE_MS)
}

function write(): Promise<void> {
  const p = pending
  pending = null
  if (!p || !save) return Promise.resolve()
  // A refused `save_ui_state` is NOT a user-facing failure (§7.6: "never an
  // error dialog, never a startup failure").  It is dropped, loudly enough for
  // a console and no louder, and the next patch tries again.
  const done = save(p).catch((err: unknown) => {
    onError?.(err)
  })
  inFlight = done
  void done.then(() => {
    if (inFlight === done) inFlight = null
  })
  return done
}

/**
 * Write NOW and wait for it.  Two callers, both normative:
 *   - §4.3 step 2, for the OUTGOING vault, before anything is torn down;
 *   - §1.6 / §7.6, in the `confirm_close` path, AFTER the editor buffer.
 * Sequencing is fixed and this function does not enforce it — the caller does.
 */
export function flushUi(): Promise<void> {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
  if (pending) return write()
  return inFlight ?? Promise.resolve()
}

/**
 * Drop the queued patch WITHOUT writing it.  For §4.3: once step 2 has flushed
 * the outgoing vault, anything that arrives from a module being torn down in
 * steps 3-5 belongs to a vault that is no longer open, and writing it would
 * file the old vault's scroll position under the new vault's key.
 */
export function discardPendingUi(): void {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
  pending = null
}
