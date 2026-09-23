# DATA-LOSS-VERIFICATION.md

**What this is.** CONTRACT.md §7 enumerates sixteen data-loss paths, each with an
invariant and a mandated test. This document maps each path to the tests that
prove it in the current tree. Every PASS row names a test that exists and can be
re-run. Every path that cannot be exercised has a GAP row saying so and why.

**The app as it is now.** Electron 39.8.3 shell plus a Rust core (`core/`)
loaded as a Node-API addon (`electron-shell/cairn.node`). The frontend is
`src/*.ts` bundled by `electron-shell/build-app.mjs`. There is no other shell
and no other engine.

## 0. How it is run

| Suite | Command | What it covers |
|---|---|---|
| Rust seams | `cd core && cargo test --test dataloss -- --test-threads=1` | `dl_00`–`dl_22`, `dl_24`–`dl_29` |
| Rust write serialisation | `cd core && cargo test --test write_serialisation` | concurrent same-base writes |
| Rust watcher lifecycle | `cd core && cargo test --test watch_lifecycle` | ancestor rename, external rename-over, refresh re-arm, symlinked trees |
| Rust special files | `cd core && cargo test --test special_files` | FIFO / socket / device entries named `*.md` |
| Frontend | `node --test tests/frontend/*.test.mjs` | modal, dirty-delete, open-atomic, editor-recovery, main-flows, conflict-bars, memoir, ipc-timeout, secrets-writers |
| Shell, headless | `node --test electron-shell/note-frame-edges.test.mjs electron-shell/secret-parity.test.mjs electron-shell/note-extension-case.test.mjs` | frame edges, secret parity, extension case |
| Shell, windowed | `node --test electron-shell/close-handshake.test.mjs electron-shell/sync-client.test.mjs electron-shell/shipped-binary.test.mjs` | quit handshake, real sync client, shipped artefact |
| Whole Rust suite | `cd core && cargo test` | includes the above plus unit tests |

### 0.1 The containment rule

Every Rust fixture is a `tempfile` directory. `guard()` fails the test unless
the canonical fixture path is under the canonical `std::env::temp_dir()` and is
not under `$HOME`, `/Users`, `/Library`, `/System`, `/Applications` or
`/private/etc`. `dl_00_the_containment_guard_is_real` proves the guard rejects
the paths it exists to reject, so it cannot rot into a tautology.

Every test goes through `vault::open_at` (the real walk, the real sweep),
resolves through the arena exactly as `read_note` does, and uses a real second
process wherever the claim is about a crash or about concurrency.

## 1. The sixteen §7.3 cases

| # | Case | Invariant | Proof | Result |
|---|---|---|---|---|
| 1 | Killed mid-save | The note on disk is the complete old or the complete new content, never torn; the next vault open leaves zero `.tmp-` files | `dl_01_sigkill_between_the_temp_write_and_the_rename`: 8 rounds; a real second process writes a 4 MiB note in a loop through `fsops::write_note`; SIGKILL lands at a different offset each round; the parent runs the real `vault::open_at` and asserts the file hashes to old or new, zero temps survive, and the note still reads. A round counts only if ≥1 write completed and ≥1 round was killed with a temp present. `dl_02_the_vault_open_sweeps_dead_debris_and_spares_a_live_instance`: dead-PID debris is swept on sight, a live instance's in-flight temp is spared, a non-Cairn file is untouched | **PASS** |
| 1b | Sweep rule | Dead-PID debris goes on sight; a live instance's in-flight temp is spared | `dl_02` (above). `dl_21_g8_a_whole_session_leaves_exactly_the_users_notes`: a session leaves exactly the user's notes, no strays | **PASS** |
| 2 | Quit / close with a dirty buffer | No quit discards unsaved text without writing it or saying what would be lost | `dl_03_a_flush_issued_before_exit_is_on_disk_after_exit` (a real child issues the close flush; the bytes are on disk after `wait()`); `dl_04_an_unwritable_destination_makes_the_close_flush_reject` (parent at `0o500`: the flush rejects with `Io`, the note is unchanged, no temp left — the rejection §1.6 needs to cancel the close); `dl_28_the_quit_handshake_is_wired_at_both_ends_and_the_webview_cannot_close_the_window` (both close paths arm the same `begin_close`, the deadline constant is 2,000 in source and in the compiled artefact); `electron-shell/close-handshake.test.mjs` (end to end in three real child processes: the deadline is a measured 2,001 ms timer, `state.json` is on disk by `flush_now` before exit, a rejecting flush cancels the close past the deadline, answering disarms the watchdog); `tests/frontend/modal.test.mjs` (the real §1.6 modal); `tests/frontend/main-flows.test.mjs` (quit-prompt rows: anything but `quit` keeps the window); `tests/frontend/memoir-wiring.test.mjs` + `memoir-page.test.mjs` (F26: the quit handshake flushes the journal page after the editor, including sub-debounce input; a refused journal write refuses the close) | **PASS** |
| 3 | Delete the open note while dirty | The trashed file is never resurrected; the buffer is never dropped without a prompt | `dl_05_a_deleted_open_note_is_never_resurrected_by_a_late_autosave` (autosaves fired after the delete, twice, refuse with `NotFound`; the file never reappears; the identical call with `create: true` recreates it, proving the assertion discriminates); `dl_06_the_create_bit_has_exactly_one_producer_in_the_frontend` (exactly one `writeNote(..., true)` call site, in `saveAs()`); `dl_24_a_write_already_in_flight_resurrects_a_deleted_note_and_settling_stops_it` (both arms: delete against an in-flight write resurrects; with the write settled first it stays deleted); `dl_25_the_bytes_that_reach_the_delete_are_the_branch_the_user_picked` (Cancel writes and deletes nothing; Save-and-delete puts post-edit bytes first; Delete-without-saving leaves pre-edit bytes); `dl_27_the_trash_branch_is_nsfilemanager_and_a_refusal_keeps_the_note` (the macOS backend is pinned to `NsFileManager`, spawns nothing, and a refused trash leaves the note byte-unchanged); `dl_29_the_trash_childs_containment_interlock_refuses_a_writable_parent`; `tests/frontend/dirty-delete.test.mjs` (flush-resolves-without-writing aborts; blur flush during the prompt is settled; Escape is Cancel); `tests/frontend/editor-recovery.test.mjs` (guard refused while another dialog is up aborts and keeps the buffer); `tests/frontend/main-flows.test.mjs` (a delete confirmed after the vault changed underneath it deletes nothing) | **PASS** |
| 4 | The open note is renamed in-app | External-change detection keeps working | `dl_07_after_an_in_app_rename_the_open_note_still_hears_external_edits` (real watcher; rename in-app; a second process edits; exactly one content hit for the new path). `tests/frontend/editor-recovery.test.mjs` (a late rename applies to the renamed note, not to whichever note is open when it returns; a rename waits for the write in flight and the next write follows it; a write issued during a rename lands on the new path; folder renames re-base the open note). `tests/frontend/main-flows.test.mjs` (tree rename and drag-move run on the write chain and hand the editor the rename itself) | **PASS** |
| 5 | Renamed / moved externally | The buffer is never written to a path the user did not mean | `dl_08_an_external_rename_stops_autosave_and_save_as_is_the_only_way_out` (a second process moves the note; the arena is rebuilt; the dirty autosave refuses with `NotFound` and writes to neither path; Save-as into a fresh name performs exactly one `x-create: 1` write; into an existing name returns `alreadyExists` with zero writes). `tests/frontend/editor-recovery.test.mjs` (a dirty note that went read-only with its vault autosaves again to the same path once that vault is re-opened; a clean note resumes without writing). `tests/frontend/main-flows.test.mjs` (Save-as rows; a refused open puts the tree's active row back on the note actually open; a vanished row detaches only the open note). `tests/frontend/conflict-bars.test.mjs` (F66: state-to-bar wiring; bar buttons reach keepMine / reload / Save-as / discard) | **PASS** |
| 6 | A folder is deleted with a note inside it open | Identical to case 5 | `dl_09_deleting_the_folder_takes_the_open_note_and_nothing_comes_back` (opens `A/B/n.md`, deletes `A`, fires every autosave the frontend could hold; all refuse; nothing under `A` comes back; the root listing is exact). `tests/frontend/editor-recovery.test.mjs` (folder-rename re-basing). `tests/frontend/main-flows.test.mjs` (delete-after-switch deletes nothing) | **PASS** |
| 7 | Concurrent edit from another application | An edit made elsewhere is never silently clobbered | `dl_10_a_concurrent_edit_from_another_process_is_never_clobbered` (a real second process rewrites the note; three successive autosaves each return `Conflict` with a fresh disk mtime; the disk keeps the other process's bytes; no temp left; only `x-base-mtime: ""` gets through). `dl_11_our_own_saves_do_not_echo_but_a_real_external_edit_does` (five own saves raise zero external-change hits; a genuinely later external write is still delivered). `core/tests/write_serialisation.rs` (F91/F87: 100 rounds of two same-base concurrent writes; exactly one lands, the other is `conflict`, and the winner's receipt describes the disk — the case where a write outlives its IPC timeout and the next autosave reuses the un-advanced base). `tests/frontend/ipc-timeout.test.mjs` (F91: `write_note` is never raced by the 30 s IPC timeout while every other command still rejects). `tests/frontend/editor-recovery.test.mjs` (F35/F66/F52: a note changed while the vault was away comes back as a conflict, not an overwrite; a conflict persists through manual re-saves and Keep-mine is what clears it). `tests/frontend/main-flows.test.mjs` (F52/F54/F35/F56: bar-to-editor wiring for every note state that stops autosave). `tests/frontend/conflict-bars.test.mjs` (F66). `core/tests/watch_lifecycle.rs` (an external rename-over of the open note reaches the editor while the app's own save does not) | **PASS** |
| 8 | Vault root deleted / renamed / unmounted | Never autosave into a path whose root is gone | `dl_12_a_vanished_vault_root_is_reported_and_nothing_is_written_after` (real watcher; root removed; `VaultLost` fires within the deadline; the next write fails; the root is not recreated). `dl_17_a_vault_reached_through_a_symlink_still_watches_and_still_suppresses` (arena root and watcher root agree through a symlinked spelling; own saves echo zero hits; an external edit through the symlinked spelling is still delivered). `core/tests/watch_lifecycle.rs` (F8: an ancestor rename surfaces `nc://vault-lost` and drops the vault, since the root's own inode never moves). `tests/frontend/editor-recovery.test.mjs` (F35: vault-restored rows). `tests/frontend/main-flows.test.mjs` (re-open of the same vault resumes a read-only note). `tests/frontend/conflict-bars.test.mjs` (F66: re-opening the vault resumes a vault-lost note) | **PASS** |
| 9 | Vault on Syncthing | The app's own writes never make a sync conflict; a sync client's writes are treated as case 7 | `electron-shell/sync-client.test.mjs` against two real `syncthing` daemons fenced to `127.0.0.1`: `.stfolder` is invisible to the tree; a Cairn write reaches the peer byte-identical with zero conflict copies; ten writes leave no `.`-prefixed temp exposed; the peer's write arrives as a real `nc://note-external-change`; a genuine divergent edit ends with Syncthing's own `note.sync-conflict-….md` carrying the losing side's bytes byte for byte. iCloud Drive is out of scope by user ruling (CONTRACT §0.25.2 E60). Dropbox and OneDrive are unmeasured and unclaimed | **PASS** |
| 10 | Case-insensitive filesystem | A case-only rename never destroys the file; a case-only collision is refused | `dl_16_a_case_only_rename_keeps_the_file_and_a_real_collision_is_refused` (measures the fixture volume is case-insensitive and fails loudly otherwise; `notes.md` → `Notes.md` keeps content and inode with no temp left; a genuine collision refuses with `AlreadyExists`, both files unchanged). `electron-shell/note-extension-case.test.mjs` (F53: `Foo.MD` / `x.Md` are notes; the tree blob carries the on-disk name, so open and delete address the file itself and never a case sibling) | **PASS** |
| 11 | Names legal on one OS and not the other | The app never creates a file another machine cannot check out, and never makes an existing note unopenable | `dl_18_awkward_names_are_openable_even_where_they_are_uncreatable` (notes inside `Archive ` and `v1.` open, write, rename and delete; `validate_name` refuses awkward names for creation while `validate_rel_for_lookup` admits them for resolution) | **PASS** |
| 12 | Symlink loops | The walk terminates; no path in the arena escapes the root | `dl_19_a_symlink_loop_terminates_the_walk_and_is_absent_from_the_tree` (loop, self-link, outside link, symlinked note: the walk completes; none reaches the arena; the outside file is unchanged; the skipped-symlink limitation is asserted as a limitation). `core/tests/watch_lifecycle.rs` (F13: a symlinked tree is neither listed nor watched — a change inside it fires no events for rows that do not exist). `core/tests/special_files.rs` (F15, scan half: a FIFO or socket named `*.md` is not admitted as a note and does not block `secret_notes`) | **PASS** |
| 13 | Traversal | Nothing outside the vault root is ever opened | `dl_19` (same fixture: `../../etc/passwd`, `/etc/passwd`, `loop/../../etc/passwd`, escape paths all fail resolution; the outside file is byte-unchanged). See gap G-e for the syscall-level half | **PASS** (with a named gap) |
| 14 | A note that is not valid UTF-8 | The file's bytes are never destroyed by a lossy round trip | `dl_15_a_non_utf8_note_is_refused_and_survives_untouched` (a Latin-1 note with a lone `0xFF` is refused with `NotUtf8`; the bytes are unchanged, so no lossy decode can reach a buffer an autosave writes back). `core/tests/special_files.rs` (F15, read half: a note replaced by a FIFO is refused as not-a-note instead of blocking for a writer). `electron-shell/note-frame-edges.test.mjs` (F18/F24: a second U+FEFF after the stripped BOM is content and survives a save; lone-CR behaviour is pinned through read → document → write) | **PASS** |
| 15 | A note larger than the cap | `MAX_NOTE_BYTES = 8 MiB`; over-cap is refused | `dl_20_the_eight_mib_cap_holds_on_both_the_read_and_the_write_path` (exactly 8 MiB opens; 8 MiB + 1 is refused with exact bytes and limit; an over-cap write is refused with the destination unchanged; the cap is measured on what lands on disk, including the re-applied BOM and CRLFs; no temp left by any refusal) | **PASS** |
| 16 | Watcher exhaustion / degradation | The user is never left believing the tree is live when it is not | `dl_22_a_vault_with_no_watcher_still_opens_and_still_saves` (a vault whose watcher never started still opens, reads, writes and saves; `watching` is false, which draws the `.watch-degraded` banner; starting on an unwatchable root degrades rather than succeeding). The `MaxFilesWatch` injection point is `#[cfg(test)]` and is covered in `core/src/watcher.rs` unit tests. `core/tests/watch_lifecycle.rs` (F14: Refresh re-arms a watcher that lost a directory, Linux). The banner's copy, rank, `resize` dispatch and delegated click are covered in `tests/frontend/chrome-ui.test.mjs` | **PARTIAL** (injection point unreachable from an integration test by construction) |

`dl_23_the_shipped_binary_opens_sweeps_and_watches_a_real_vault` no longer lives
in `core/tests/dataloss.rs`. Its case is `electron-shell/shipped-binary.test.mjs`,
which drives the artefact `npm run package:deb` installs, headless, and adds the
half the Rust version could not see from another process: that the watcher
started. It skips on macOS while packaging is descoped for the development
phase — an honest gap, not a passing test.

`dl_26_g_a_the_trash_for_a_fixture_note_is_the_users_real_trash_not_the_fixture`
measures that a fixture note's trash destination is the user's real `~/.Trash`,
which is why every other delete in this file passes `permanent: true` and why
the trash happy path is a gap (§2, G-a) rather than a test.

## 2. The gaps — cases that could not be exercised, and why

| Gap | What is not proved | Why not | What covers it instead |
|---|---|---|---|
| G-a: trash happy path | A real `NsFileManager` trash landing in `~/.Trash` byte-identical | `dl_26` measures the destination is the user's real Trash, so a fixture test that asserted it would write there | `dl_25` (which bytes reach the delete on each branch); `dl_27` (a refused trash keeps the note); `dl_05` (resurrection half) |
| G-c: live-window legs of case 2 | "The window is still open and the modal is showing" against a driven window | No UI automation harness drives the editor; windowed coverage goes through real child processes and real IPC instead | `dl_03`, `dl_04`, `dl_28`, `close-handshake.test.mjs`, `modal.test.mjs` |
| G-d: Dropbox / OneDrive | Case 9 against those clients | Unmeasured; only Syncthing has been driven | Syncthing run above; mechanism cover (temp+rename in one directory, `.`-prefixed temp, PID-aware sweep, case-7 conflict guard) |
| G-e: syscall-level traversal proof | `dtruss` / `strace` verification of case 13 | `dtruss` needs SIP-relaxed root | `dl_19` at the resolution seam plus the byte-unchanged outside file |
| G-f: case 16's injection point | `Watcher::new` returning `MaxFilesWatch` from an integration test | The injection point is `#[cfg(test)]` and does not exist in the linked library | `watcher.rs` unit tests; `dl_22` for the user-visible half |
| G-g: shipped artefact on macOS | `dl_23` on macOS | Packaging is descoped for the development phase; the test skips there with the reason | `dl_23` on Linux; `dl_02` at the Rust seam on both |

A network vault (NFS/SMB) emits no watcher events. The watcher still starts, so
no degraded banner is drawn. Such a vault picks up outside changes on its next
open. This is a user decision, not a gap.

## 3. Adjacent coverage — hardening outside §7.3's sixteen

These tests exist, pass, and protect data without belonging to one case:

- **Transactional open** — `tests/frontend/open-atomic.test.mjs` (F42/F84): any
  exception out of any StateField's `create` reports `{ok:false}` and keeps the
  previous note bound; a failed external reload keeps the old base so the next
  write conflicts instead of clobbering.
- **Secret viewer writers** — `tests/frontend/secrets-writers.test.mjs`
  (F43/F44): confirming a delete after the buffer reloaded or another note
  opened deletes nothing and reports it; Add and Edit refuse text the parser
  would read back differently, and every accepted text round-trips.
- **Secret parity** — `electron-shell/secret-parity.test.mjs` (F18/F24): the
  search backend and the secret viewer agree on which notes are secret over the
  same bytes, so a masked note's passwords never leak into search snippets.
- **Journal page** — `tests/frontend/memoir-page.test.mjs` and
  `memoir-wiring.test.mjs` (F26/F47/F48/F49/F50): the journal flushes on quit,
  re-reads on show and on external change when clean, and keeps its buffer when
  dirty.
- **Build safety** — `electron-shell/addon-rebuild.test.mjs` (F58): publishing a
  rebuilt `cairn.node` by rename does not crash a running process holding the
  old one.
- **Input and cost guards** — `tests/frontend/ime-enter.test.mjs` and
  `tests/frontend/long-line-cost.test.mjs` (F79/F85/F86): the Return that
  confirms an IME composition is not a commit, and both per-keystroke
  tokenisers cost linear time on long lines. The inline title and Properties
  IME guards are covered in the real engine by
  `electron-shell/ime-composition.test.mjs`.

## 4. Re-running any of this

```bash
# everything that does not open a window
cd core && cargo test --test dataloss -- --test-threads=1
cd core && cargo test --test write_serialisation -- --test-threads=1
cd core && cargo test --test watch_lifecycle
cd core && cargo test --test special_files

# frontend rows for cases 2, 3, 5, 7, 8 and the adjacent hardening
node --test tests/frontend/*.test.mjs

# headless shell rows (needs electron-shell/cairn.node)
node --test electron-shell/note-frame-edges.test.mjs \
  electron-shell/secret-parity.test.mjs \
  electron-shell/note-extension-case.test.mjs

# windowed shell rows (need a display)
node --test electron-shell/close-handshake.test.mjs \
  electron-shell/sync-client.test.mjs

# the shipped artefact (Linux; skips on macOS while packaging is descoped)
node --test electron-shell/shipped-binary.test.mjs
```

The `dataloss_*` helpers (`_kill_child`, `_flush_child`, `_external_actor`,
`_trash_child`) are `#[ignore]`d child processes the parent tests spawn by name;
running them directly does nothing without their environment variables.
