/**
 * src/ipc.d.ts
 * Owner: 02.  Spec: CONTRACT.md §1.5 — NORMATIVE, and it MUST MATCH RUST
 * EXACTLY.  The block below is TRANSCRIBED from §1.5, not paraphrased.
 *
 * TWO RULES THAT ARE EASY TO GET WRONG AND EXPENSIVE TO FIX LATER:
 *   1. CASING (§1.1, X13).  EVERY type that crosses the IPC is camelCase on the
 *      wire, errors included.  The Rust mirrors all carry
 *      `#[serde(rename_all = "camelCase")]`, and VaultError additionally carries
 *      `rename_all_fields = "camelCase"` — that second attribute is what makes
 *      `disk_mtime_ms` arrive as `diskMtimeMs`.  There is no snake_case field
 *      anywhere in this file.  `NoteRead { mtimeMs }` sitting beside
 *      `WriteReceipt { mtime_ms }` on one save path was the defect this closed.
 *   2. TWO INDEX SPACES (§4.2, X14).  `FileGroup.id` indexes
 *      `VaultSnapshot.files`, which is the FILES-ONLY space.  That is NOT the
 *      TreeBlob node index space, which also contains directories.  `id` is
 *      valid only for the `gen` it arrived on and is usable only as a DOM key;
 *      anything that has to find a tree row resolves it BY PATH (`rel`).
 *
 * `SearchHit` and `SearchEvent` (spec-02 §11.6) are STRUCK.
 * The frontend switches on `VaultError.kind` and MUST NOT parse `message`,
 * which is OS-localised.
 *
 * NOTE ON `SortMode`.  §1.5 declares it `const enum` and it is transcribed as
 * one.  Under this repo's `isolatedModules` an ambient const enum may be
 * DECLARED but its members may not be READ at runtime, so nothing in the app
 * writes `SortMode.NameAsc`; the wire value is the `u8`.  §0.12 E14 deleted the
 * sort MENU (and `SORT_LABELS` with it) — the four orders still exist on the
 * wire and command 7 is still live, but the frontend only ever sends 0.
 */

/** Vault-relative, '/'-separated, no leading slash. "" is the vault root. Notes keep ".md". */
export type VaultPath = string;

/** Wire value is the u8. The named members exist for readability only; since
    §0.12 E14 pinned sorting to file name A-Z, `NameAsc` is the only one sent. */
export const enum SortMode { NameAsc = 0, NameDesc = 1, MtimeDesc = 2, MtimeAsc = 3 }

/* CASING: every type in this file is camelCase on the wire (§1.1). The Rust mirrors all carry
   #[serde(rename_all = "camelCase")]. There is no snake_case field anywhere below. */

export interface VaultInfo {
  root: string;              // absolute, for the vault-switcher button
  name: string;              // final path component
  nNotes: number;
  nDirs: number;
  sort: SortMode;            // 0..3
  epoch: number;             // matches the blob header
  lastNote: VaultPath | null;
  /** §7.6, errata 3 Z2. The persisted expansion set for THIS vault, folders only, already
   *  truncated to 2000 and already sanitised by Rust. `[]` when nothing was persisted.
   *  THIS IS THE READ PATH for what `UiPatch.expanded` writes. */
  expanded: VaultPath[];
  /** §7.6, errata 3 Z2. The persisted sidebar scroll offset for THIS vault. Finite and >= 0;
   *  `0` when nothing was persisted. THE READ PATH for what `UiPatch.scrollTop` writes. */
  scrollTop: number;
  watching: boolean;         // false => the watcher-degraded banner is showing (§0.12 E14)
  truncated: boolean;        // the 50,000-node cap was hit (nodes only; depth is banner-only, §3.3)
  truncatedDepth: boolean;   // the 255-depth cap was hit — drives the second §3.3 banner
}

/** M65: the first run is a distinct state, not a null VaultInfo. */
export type VaultState =
  | { state: 'none' }        // no vault configured — render "Open folder as vault…"
  | { state: 'loading' }     // a walk is in flight — wait for nc://vault-opened
  | { state: 'open'; info: VaultInfo };

export interface RecentVault { root: string; name: string; exists: boolean }

export interface NoteRead { mtimeMs: number; flags: number; text: string }   // from decodeNote()
export interface WriteReceipt { mtimeMs: number; size: number }              // camelCase, X13
export interface CreateResult { path: VaultPath; epoch: number }
export interface RenameResult { path: VaultPath; epoch: number }
export interface DeleteResult { epoch: number }

export interface UiPatch {
  win?: { w: number; h: number; x: number; y: number; max: boolean };
  /** §0.7 E9.  The sidebar width in px, GLOBAL like `win` and not per-vault.
   *  Written on release of the resize drag; M60's deletion of `sidebar_w` is
   *  struck. Rust clamps it on read, so a hand-edited state.json cannot ship a
   *  0px or a 90,000px sidebar. */
  sidebarW?: number;
  lastNote?: VaultPath | null;
  sort?: SortMode;
  expanded?: VaultPath[];    // folders only; capped at 2000, see §7.6
  scrollTop?: number;
}

/* ── search ───────────────────────────────────────────────────────────────── */

export interface Snippet {
  line: number;              // 1-based
  text: string;              // EOL-trimmed, <= 262 chars
  ranges: [number, number][];// UTF-16 code units, ascending, non-overlapping
  col: number;               // UTF-16 column of the first match in the ORIGINAL line
  len: number;               // UTF-16 length of that match
}

export interface FileGroup {
  /** Index into `VaultSnapshot.files` (§4.2) — the FILES-ONLY index space, which is NOT the
   *  TreeBlob node index space (the blob also contains directories). Valid only for the
   *  `gen` it arrived on, and usable only as a DOM key. Anything that has to find the tree row
   *  for a result resolves it BY PATH (`rel`), never by this number. (X14) */
  id: number;
  rel: VaultPath;
  name: string;              // basename without ".md"
  nameRanges: [number, number][];
  snippets: Snippet[];       // <= 2 here; the rest via search_expand
  matchCount: number;
  more: boolean;
  rank: [number, number, number];
}

export type SearchMsg =
  | { kind: 'files';    gen: number; groups: FileGroup[] }
  | { kind: 'batch';    gen: number; groups: FileGroup[] }
  | { kind: 'complete'; gen: number; order: number[]; totalMatches: number; totalFiles: number;
      scanned: number; skipped: number; truncated: boolean; smartCase: boolean;
      cancelled: boolean; elapsedMs: number }
  | { kind: 'error';    gen: number; message: string };

/* ── errors ───────────────────────────────────────────────────────────────── */

export type VaultError =
  | { kind: 'noVault' }
  | { kind: 'notFound';         path: string }
  | { kind: 'alreadyExists';    path: string }
  | { kind: 'notADirectory';    path: string }
  | { kind: 'notUtf8';          path: string }
  | { kind: 'tooLarge';         path: string; bytes: number; limit: number }
  | { kind: 'invalidName';      name: string; reason: string }
  | { kind: 'invalidPath';      path: string; reason: string }
  | { kind: 'conflict';         path: string; diskMtimeMs: number }
  | { kind: 'trashUnavailable'; path: string; message: string }
  | { kind: 'io';               path: string; code: number; message: string }
  | { kind: 'cancelled' };
