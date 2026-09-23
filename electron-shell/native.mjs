/**
 * electron-shell/native.mjs -- §8.2 step 5: §1.3's commands, on the REAL
 * Rust core.
 *
 * IT REPLACES `electron-shell/backend/`, WHICH IS DELETED. That directory was
 * a third copy of TreeBlob v1 and the §2 note frame, written to get step 4's
 * "the frontend boots with zero Rust" measurement and carrying an expiry date
 * from the day it landed (`CLAUDE.md`: "MUST be deleted at step 5, not kept as
 * a fallback"). Keeping it as a fallback would mean keeping a second
 * implementation of every data-loss rule in §7 -- one of which is tested and
 * one of which is not -- and choosing between them at runtime.
 *
 * WHAT THIS FILE IS ALLOWED TO CONTAIN, and it is the same rule `cmds.rs` and
 * `napi/src/lib.rs` keep: argument shuffling and one call. There is no vault
 * logic here, no path validation, no wire format and no error taxonomy. If a
 * body below grows past a line or two, it is in the wrong file.
 *
 * ONE THING IS DELIBERATELY *NOT* NATIVE: `pick_vault`. Electron's
 * `dialog.showOpenDialog` is called from the MAIN process, the renderer only
 * asks, and no `dialog:*` capability is granted to the page.
 *
 * §1.5 CROSSES AS A PREFIXED MESSAGE AND IS REBUILT HERE. `ipcMain.handle`
 * serialises a thrown Error by its message and stack and by nothing else, so
 * no structured payload survives main -> renderer however it is thrown -- see
 * `toEnvelope`.
 */

import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ADDON = join(HERE, 'cairn.node')

/** Must match `napi/src/lib.rs`'s `CAIRN_VAULT_ERROR`. */
const VAULT_ERROR = 'cairn.VaultError:'

/**
 * Load the addon.
 *
 * NO FALLBACK, ON PURPOSE. A missing `cairn.node` used to mean "run the JS
 * backend instead", and that is exactly the arrangement step 5 exists to end:
 * a shell that can silently serve a vault from a second, untested
 * implementation is a shell whose green run proves nothing about the first.
 */
export function loadAddon() {
  if (!existsSync(ADDON)) {
    throw new Error(
      'cairn: ' + ADDON + ' is missing. Run `node electron-shell/build-native.mjs` ' +
        '(npm run electron:native). There is no JavaScript fallback -- see this file’s header.'
    )
  }
  return createRequire(import.meta.url)(ADDON)
}

/**
 * A Node `Buffer` from the addon -> the `ArrayBuffer` `src/ipc.ts` promises.
 *
 * ZERO EXTRA COPY, AND ASSERTED RATHER THAN ASSUMED. K4 already costs one copy
 * on the way out of Rust: Electron refuses `napi_create_external_buffer`, so
 * napi-rs falls back to `napi_create_buffer_copy`, which allocates a fresh
 * ArrayBuffer of exactly the right length -- never a slice of Node's 8 KiB
 * pool. `buf.buffer` is therefore the whole blob and handing it on costs
 * nothing. If that ever stops being true the assert fires instead of a silent
 * third copy appearing, or -- far worse -- the renderer receiving 8 KiB of
 * somebody else's buffer.
 */
function asArrayBuffer(buf, what) {
  if (buf.byteOffset !== 0 || buf.byteLength !== buf.buffer.byteLength) {
    throw new Error(
      `cairn: ${what} returned a pooled Buffer (offset ${buf.byteOffset}, ` +
        `${buf.byteLength} of ${buf.buffer.byteLength}); napi-rs's ` +
        'no-external-buffers fallback is expected to allocate exactly'
    )
  }
  return buf.buffer
}

/**
 * Run one command and shape the result the way `ipcMain.handle` can carry it.
 *
 * `{ ok: true, value }` / `{ ok: false, error }`, and never a throw for a §1.5
 * condition. A thrown Error would reach the renderer as its MESSAGE only, so
 * `err.kind` -- which `editor.ts:209`, `inline-edit.ts:488` and
 * `tabstrip.ts:215` all switch on -- would be `undefined` at every call site.
 * That was true of the step-4 scaffold, silently, for every error it raised.
 *
 * Anything without the marker is a real fault (a wrong argument type, `start`
 * not called, a panic) and is re-thrown, so it surfaces as the programming
 * error it is instead of being mistaken for a vault condition.
 */
export async function toEnvelope(work) {
  try {
    return { ok: true, value: await work() }
  } catch (err) {
    const msg = err && typeof err.message === 'string' ? err.message : ''
    const at = msg.indexOf(VAULT_ERROR)
    if (at < 0) throw err
    return { ok: false, error: JSON.parse(msg.slice(at + VAULT_ERROR.length)) }
  }
}

/**
 * The commands the core owns (§1.3 minus `pick_vault`, which is Electron's).
 *
 * NOT ONE OF THEM ANNOUNCES A MUTATION. The step-4 scaffold had to `send`
 * `nc://tree-changed` after every create/rename/delete because it had no
 * watcher, and its comment says so ("in the real app, the Rust WATCHER emits").
 * The real app is now what is running: `app::repair_and_emit` raises the event
 * from inside the command, through `AppCtx`, before it returns. Re-announcing
 * here would rebuild the tree twice per mutation.
 */
export function nativeCommands(addon) {
  return {
    open_vault: ({ path }) => addon.openVault(path),
    current_vault: () => addon.currentVault(),
    recent_vaults: () => addon.recentVaults(),
    rescan_all: () => addon.rescanAll(),

    tree_snapshot: async () => asArrayBuffer(await addon.treeSnapshot(), 'tree_snapshot'),
    set_sort: ({ sort }) => addon.setSort(sort),
    // Command 25 (user feature, 2026-09-16): the secret notes' rels, for the
    // tree's row mark.  A plain JSON array — no frame, no blob change.
    secret_notes: () => addon.secretNotes(),

    read_note: async ({ path }) => asArrayBuffer(await addon.readNote(path), 'read_note'),
    // `text` arrives as the Uint8Array `ipc-electron.mjs` encoded, not as a
    // string: §2.3's body is BYTES, and re-encoding it here would put a second
    // TextEncoder on the write path.
    write_note: ({ path, text, flags, baseMtimeMs, create }) =>
      addon.writeNote(path, text, flags, baseMtimeMs, create),

    // ASYNC ADDON FNS (off the event loop via spawn_blocking): awaited here so
    // the envelope carries values, not pending Promises.
    create_note: ({ parent, name }) => addon.createNote(parent, name ?? null),
    create_folder: ({ parent, name }) => addon.createFolder(parent, name ?? null),
    rename_entry: ({ path, new_name }) => addon.renameEntry(path, new_name),
    delete_entry: ({ path, permanent }) => addon.deleteEntry(path, permanent),
    move_entry: ({ path, dest_parent }) => addon.moveEntry(path, dest_parent ?? ''),

    search_start: ({ query, generation }) =>
      addon.searchStart(query, generation, 'search:' + generation),
    search_expand: ({ query, rel }) => addon.searchExpand(query, rel),
    search_cancel: ({ generation }) => addon.searchCancel(generation),

    save_ui_state: ({ patch }) => addon.saveUiState(patch),
    confirm_close: ({ ok, reason }) => addon.confirmClose(ok, reason ?? null),
    reveal_in_os: ({ path }) => addon.revealInOs(path),
    // Command 21 (§0.30 E70). Writes `state.json` and NOTHING in the vault.
    forget_vault: ({ root }) => addon.forgetVault(root),
  }
}
