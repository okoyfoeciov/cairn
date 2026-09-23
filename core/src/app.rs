//! core/src/app.rs — Owner: 07.  **NEW FILE, NOT IN CONTRACT §6.4's TABLE.**
//! Spec: CONTRACT.md §1.3 (the twenty commands), §1.4 (the seven events), §1.6
//! (the flush-on-quit handshake), §3.5 (echo suppression and repair), §4.2/§4.3
//! (the snapshot seam and the switch order), §7.5 (first run), §7.6 (state.json).
//!
//! ============================ WHY THIS FILE EXISTS ==========================
//! §6.4's table gives every leaf a home and gives the ORCHESTRATION none.
//! `vault.rs` says `open_at` does not touch `AppState`, emit an event or start
//! the watcher — those are the caller's; `watcher.rs` says the mapping is the
//! caller's job; `search.rs` names `state.search` and stops at the seam.  The
//! caller is this file, owned by 07 — the same owner as `AppState`, whose
//! methods these are.
//! ============================================================================
//!
//! THE ONE PROCESS-WIDE EPOCH LIVES HERE (`AppState::epoch`), and it is the same
//! number the blob header carries at offset 24, that `nc://tree-changed`
//! reports, and that every mutating command returns (§1.4).  `VaultTree.epoch`
//! is a COPY of the last value this counter handed it, never a second counter.

//! CLIPPY DENY LIST (§6.2, gate G7).  §6.2 names six modules; this one did not
//! exist when it was written, and it sits on exactly the paths the list exists
//! for — a panic here takes out a save, a close or a vault switch.  So it opts
//! in rather than waiting to be named.
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::{Duration, Instant};

/// EVERYTHING `app.rs` NEEDS FROM THE SHELL, AND NOTHING ELSE.
///
/// This module is the orchestration layer (§6.4's table has no row for it; see
/// this file's header), so it is the one place that legitimately reaches for
/// the shell -- eleven `nc://` emits, seven state lookups and two exits.
/// Naming the shell's type in those signatures made all of it unreachable from
/// a test; three methods behind a trait do not.
///
/// STATIC DISPATCH ONLY, deliberately.  The generic methods make this
/// non-object-safe, which is exactly right: every caller is `&impl AppCtx`, so
/// there is no vtable and no boxing.
pub trait AppCtx: Clone + Send + Sync + 'static {
    /// §1.4's event table.  A dead webview is not an error worth unwinding
    /// for -- every existing call site already discarded the result.
    fn emit_event<S: serde::Serialize + Clone>(&self, event: &str, payload: S);
    /// The process-wide `AppState`.  Returns the reference directly rather
    /// than the shell's guard type, which is the whole point.
    fn app_state(&self) -> &crate::AppState;
    /// §1.6.  NOT a quit shortcut: only `confirm_close` reaches it.
    fn quit(&self, code: i32);
}

use crate::error::VaultError;
use crate::fsops::{self, CreateResult, DeleteResult, RenameResult, WriteReceipt};
use crate::note_frame::WriteArgs;
use crate::path as vpath;
use crate::prefs::{PrefsStore, UiPatch};
use crate::scan;
use crate::search::{self, MsgSink, SearchState, Snippet};
use crate::tree::{self, SortMode, Vault, VaultSnapshot};
use crate::vault::{self, RecentVault, VaultInfo, VaultState};
use crate::watcher::{DegradeReason, SelfWrites, VaultWatcher, WatchEvent};

/// CONTRACT §1.6.  The frontend is given 2,000 ms to flush its editor buffer,
/// counted from the last vault write activity: the flush IS a write, so a slow
/// disk extends the wait rather than having its write abandoned mid-fsync.
pub const CLOSE_DEADLINE_MS: u64 = 2_000;
/// §1.6's backstop for the backstop.  However busy the disk, the watchdog quits
/// this long after it was armed, so a hung mount cannot make the window
/// unclosable.
pub const CLOSE_HARD_CAP_MS: u64 = 15_000;
/// How often the close watchdog re-reads the close token and the write counters.
const CLOSE_POLL: Duration = Duration::from_millis(50);

/* ── the state ────────────────────────────────────────────────────────────── */

/// The process-wide state every command takes as `State<'_, AppState>`.
#[derive(Default)]
pub struct AppState {
    /// M54: the vault-relative path of the note the editor currently holds.
    /// UPDATED ON RENAME, CLEARED ON DELETE, and it is what §1.4 filters
    /// `nc://note-external-change` by — without that filter a `git checkout`
    /// touching 800 files emits 800 events the UI discards.
    pub open_note: Mutex<Option<String>>,

    /// CONTRACT §4.2's seam.  `RwLock<Option<Arc<Vault>>>` exactly as
    /// `tree::take_vault` expects.
    pub vault: RwLock<Option<Arc<Vault>>>,

    /// CONTRACT §4.3.  `cancel_all()` runs BEFORE the outgoing `Vault` is
    /// dropped; the order is load-bearing.
    pub search: SearchState,

    /// §3.5's fingerprint ring, shared with `fsops` (which records BEFORE a
    /// mutating command returns) and with the watcher (which reads).  It
    /// outlives any one vault on purpose: a write recorded a millisecond before
    /// a vault switch must still be suppressible.
    pub self_writes: Arc<Mutex<SelfWrites>>,

    /// `None` means the vault is open but unwatched — `VaultInfo.watching` is
    /// false and the watcher-degraded banner is drawn (M57, §0.12 E14).
    pub watcher: Mutex<Option<VaultWatcher>>,

    /// §7.6.  Set once in `setup()` from `app_config_dir()`; `None` only if that
    /// call failed, which is reported once and then degrades to "no persistence"
    /// rather than to a startup failure.
    pub prefs: OnceLock<Arc<PrefsStore>>,

    /// §1.4: THE one counter.  0 is never handed out — `next_epoch` pre-
    /// increments — so "epoch 0" in a blob or an event is unambiguously "no
    /// vault has ever been opened".
    epoch: AtomicU64,

    /// §7.5: distinguishes `{state:'loading'}` from `{state:'none'}`.  Collapsing
    /// them is what left a fresh install waiting forever with no prompt.
    loading: AtomicBool,

    /// §1.6.  Bumped by every arm and by every answer; the watchdog that finds
    /// it unchanged is the one that fires.  Same shape as `PrefsStore`'s
    /// debounce token, and for the same reason: no timer handle, no
    /// cancellation, no thread that outlives what it was armed for.
    close_token: AtomicU64,
    /// Set the instant a close is authorised.  The close/exit interceptors read
    /// it and stand aside, which is what makes `app.quit(0)` actually exit.
    close_ok: AtomicBool,

    /// §1.6.  Vault writes in progress, and a counter bumped as each one starts
    /// and ends (so a write that began and finished between two looks is still
    /// seen).  The close watchdog waits for both to go quiet: quitting while a
    /// write is in `sync_data` leaves its bytes only in a temp file that the
    /// next open sweeps away.  Maintained by `WriteInFlight`.
    writes_in_flight: AtomicUsize,
    write_activity: AtomicU64,

    /// §3.5.  Held by `repair` from its walk through its install, and by
    /// `set_sort` for its in-place re-sort, so a walk that began before a
    /// command's mutation can never install over that command's own, newer
    /// repair.  NEVER held across a watcher drop or start: `VaultWatcher::drop`
    /// joins the watcher thread, which may be waiting on this lock in `repair`.
    repair_lock: Mutex<()>,

    /// Test seam: a shorter `CLOSE_HARD_CAP_MS` when non-zero.
    #[cfg(test)]
    close_cap_ms: AtomicU64,
}

/// RAII: marks one vault write in progress for the close watchdog.  A guard,
/// not a pair of calls, so an early `?` return cannot leak a count.
struct WriteInFlight<'a>(&'a AppState);

impl<'a> WriteInFlight<'a> {
    fn new(state: &'a AppState) -> Self {
        state.writes_in_flight.fetch_add(1, Ordering::SeqCst);
        state.write_activity.fetch_add(1, Ordering::SeqCst);
        Self(state)
    }
}

impl Drop for WriteInFlight<'_> {
    fn drop(&mut self) {
        self.0.writes_in_flight.fetch_sub(1, Ordering::SeqCst);
        self.0.write_activity.fetch_add(1, Ordering::SeqCst);
    }
}

impl AppState {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// The ONE counter.  Pre-increment, so the first epoch ever issued is 1.
    pub fn next_epoch(&self) -> u64 {
        self.epoch.fetch_add(1, Ordering::SeqCst) + 1
    }

    #[must_use]
    pub fn epoch(&self) -> u64 {
        self.epoch.load(Ordering::SeqCst)
    }

    /// The live vault, or `None`.  Returns a CLONED `Arc` and releases the lock
    /// immediately: a guard held across an `.await` or across a 20 ms walk is
    /// how the tree freezes under the user's cursor.
    #[must_use]
    pub fn vault(&self) -> Option<Arc<Vault>> {
        self.vault
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
            .map(Arc::clone)
    }

    fn require_vault(&self) -> Result<Arc<Vault>, VaultError> {
        self.vault().ok_or_else(|| VaultError::not_found("<no vault is open>"))
    }

    #[must_use]
    pub fn watching(&self) -> bool {
        self.watcher.lock().unwrap_or_else(std::sync::PoisonError::into_inner).is_some()
    }

    #[must_use]
    pub fn prefs(&self) -> Option<&Arc<PrefsStore>> {
        self.prefs.get()
    }

    /// Called once from `setup()`.  A second call is ignored, which is what
    /// `OnceLock` is for.
    pub fn init_prefs(&self, path: PathBuf) -> Arc<PrefsStore> {
        let store = Arc::new(PrefsStore::load(path));
        let _ = self.prefs.set(Arc::clone(&store));
        self.prefs.get().map_or(store, Arc::clone)
    }

    fn set_open_note(&self, rel: Option<String>) {
        *self.open_note.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = rel;
    }

    #[must_use]
    fn open_note_is(&self, rel: &str) -> bool {
        self.open_note
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_deref()
            == Some(rel)
    }
}

/* ── resolution: the arena IS the check (§7.3 cases 12 and 13) ────────────── */

/// vault-relative -> absolute, THROUGH THE ARENA.  There is no second resolver
/// anywhere in the app: `fs::canonicalize` is deliberately not used as a
/// containment check (a syscall per validation and a TOCTOU race), and the
/// character rules in `path.rs` are a name policy, not the guarantee.  The
/// guarantee is that the walk never admitted `..` and never admitted a symlink,
/// so a path that RESOLVES is inside the vault by construction.
fn resolve(vault: &Vault, rel: &str) -> Result<(PathBuf, bool), VaultError> {
    vpath::validate_rel_for_lookup(rel)?;
    let t = vault.read();
    let id = t.resolve(rel).ok_or_else(|| VaultError::not_found(rel))?;
    let is_dir = t.get(id).is_some_and(tree::Node::is_dir);
    Ok((t.abs_path(id), is_dir))
}

/// The same walk, for an entry that does not exist YET: `create_note`,
/// `create_folder` and `write_note`'s `x-create: 1` Save-As.  The PARENT must
/// resolve through the arena; only the final component is new.
fn resolve_parent(vault: &Vault, rel: &str) -> Result<(PathBuf, String), VaultError> {
    vpath::validate_rel_for_lookup(rel)?;
    let t = vault.read();
    let (pid, name) = t
        .resolve_parent(rel)
        .ok_or_else(|| VaultError::not_found(rel))?;
    if name.is_empty() {
        return Err(VaultError::invalid_path(rel, "it has no final component"));
    }
    Ok((t.abs_path(pid), name.to_string()))
}

/// `abs` -> vault-relative, or `None` if it is not under the root.  Both sides
/// are canonical (see `open_vault`), so this is a plain prefix strip and not a
/// second normalisation.
fn rel_of(root: &Path, abs: &Path) -> Option<String> {
    let rest = abs.strip_prefix(root).ok()?;
    let s = rest.to_str()?;
    (!s.is_empty()).then(|| s.to_string())
}

/* ── the repair path (§3.5) ───────────────────────────────────────────────── */

/// Rebuild the arena in place and publish a new epoch.
///
/// ============ DELIBERATE DIVERGENCE FROM §3.5, STATED, NOT HIDDEN ===========
/// §3.5 says "the unit of repair is a DIRECTORY, never a file".  This function
/// re-walks the WHOLE VAULT.  It does so because no owner wrote a directory-
/// granular repair and because writing one correctly is not a small job:
/// `VaultTree::add_children` appends a NEW run and abandons the old one, so
/// re-reading a directory through it double-counts `n_notes`/`n_dirs` and leaks
/// every grandchild node — a subtree-free plus a scoped re-walk has to come
/// first, and that is `scan.rs`'s (owner 02's) design to make, not the
/// integrator's to invent at the seam.
///
/// The cost is bounded and MEASURED, not assumed: 21.8 ms release median over
/// the 5,000-note / 620-folder fixture.  It is paid on a user-initiated
/// mutation and on a debounced watcher flush (>= 150 ms apart, <= 750 ms of
/// accumulation), never on an autosave — a plain overwrite updates ONE node's
/// `mtime` in place instead (see `write_note`).  At the §3.3 50,000-node cap it
/// extrapolates to ~195 ms, which WOULD be visible; that is the number that
/// makes the directory-granular repair worth writing.
///
/// It is correct in the way that matters: it is the same code path `open_vault`
/// uses, so a repaired arena and a freshly opened one cannot disagree.
/// ============================================================================
///
/// SERIALISED, walk through install (`AppState::repair_lock`).  The watcher's
/// coalescing thread, every mutating command and `rescan_all` all land here
/// concurrently, and without the lock the walk that FINISHES last wins even if
/// it read the disk before a command's create or rename — the command's own
/// events are suppressed as self-writes, so nothing would ever heal it.
fn repair(state: &AppState) -> Option<u64> {
    let _serial = state.repair_lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let vault = state.vault()?;
    let (root, sort) = {
        let t = vault.read();
        (t.root_path.clone(), t.sort)
    };
    // Walk FIRST, allocate the epoch after: a failed walk must not burn a number
    // the frontend would then see skipped in a `tree-changed` it never got.
    let mut result = scan::walk_vault(&root, sort, state.epoch()).ok()?;
    #[cfg(test)]
    tests::run_after_walk_hook();
    let epoch = state.next_epoch();
    result.tree.epoch = epoch;
    *vault.write() = result.tree;
    Some(epoch)
}

/// Repair + `nc://tree-changed`.  Every mutating command ends here, which is why
/// none of them has to remember to emit.
fn repair_and_emit(app: &impl AppCtx, state: &AppState) -> u64 {
    match repair(state) {
        Some(epoch) => {
            app.emit_event("nc://tree-changed", TreeChanged { epoch });
            epoch
        }
        // The mutation itself SUCCEEDED — the bytes are on disk.  Only the
        // in-memory picture is stale, and the watcher's next flush or a manual
        // refresh fixes it.  Reporting the old epoch is honest; failing the
        // command after the write landed would be a lie.
        None => state.epoch(),
    }
}

#[derive(serde::Serialize, Clone, Copy)]
struct TreeChanged {
    epoch: u64,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ExternalChange {
    path: String,
    mtime_ms: i64,
    size: u64,
}

#[derive(serde::Serialize, Clone)]
struct VaultLost {
    path: String,
}

#[derive(serde::Serialize, Clone)]
struct Degraded {
    reason: &'static str,
    hint: String,
}

#[derive(serde::Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
struct FlushAndClose {
    deadline_ms: u64,
}

/* ── 2-5: the vault ───────────────────────────────────────────────────────── */

/// Command 2.  Emits `nc://vault-opened` on success, INCLUDING the startup one.
///
/// Runs on a tokio blocking worker (a command) or on the
/// dedicated startup thread (`§7.5`); NEVER on the main thread and never on one
/// of the two runtime workers.
pub fn open_vault_blocking(
    app: &impl AppCtx,
    state: &AppState,
    path: &str,
) -> Result<VaultInfo, VaultError> {
    // CANONICALISE FIRST, AND WALK THE CANONICAL ROOT.  This is the cross-owner
    // seam `watcher.rs` flagged as ACTION REQUIRED: FSEvents reports canonical
    // paths, `/var` is a symlink to `/private/var` on every Mac, and if the
    // arena's `root_path` is the user's spelling while the watcher's is the
    // canonical one then NO fingerprint ever matches — every one of our own
    // saves echoes back as an external change, which on a dirty buffer is a
    // spurious conflict bar (§7.3 case 7).  Canonicalising the root here makes
    // the two strings equal by construction.  It is NOT the traversal check
    // §7.3 case 12 refuses to build on `canonicalize`; that check is the arena.
    let root = fsops::canonical_root(Path::new(path))?;

    // §4.3, M30, IN THIS ORDER — it is a data-loss rule.
    // 1. Cancel every live search FIRST, while the outgoing snapshot's last
    //    holder still exists, so no worker is walking an arena we are about to
    //    tear down.
    state.search.cancel_all();
    // 2. Stop the watcher BEFORE the vault, and drop it with NO other lock held:
    //    `VaultWatcher::drop` joins its thread, and that thread takes the vault
    //    lock.  Doing this under `state.vault`'s write guard is the deadlock
    //    spec-06 §6.6 was struck for.
    let old_watcher = state.watcher.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take();
    drop(old_watcher);
    // 3. Take the vault OUT of the slot and drop it OUTSIDE the lock, so tearing
    //    down a 5,000-node arena does not hold every reader out.
    let old_vault = tree::take_vault(&state.vault);
    drop(old_vault);

    state.loading.store(true, Ordering::SeqCst);

    let sort = state
        .prefs()
        .and_then(|p| p.snapshot().ui(&root.to_string_lossy()).map(|u| u.sort))
        .and_then(SortMode::from_u8)
        .unwrap_or_default();

    let epoch = state.next_epoch();
    let walked = vault::open_at(&root, sort, epoch);
    let (vault, swept) = match walked {
        Ok(v) => v,
        Err(e) => {
            state.loading.store(false, Ordering::SeqCst);
            return Err(e);
        }
    };
    if swept > 0 {
        // Gate G8 wants this in a LOG, never in a banner: crash debris the user
        // never saw being cleaned up is not news they can act on.
        eprintln!("cairn: swept {swept} temp file(s) left by a previous run");
    }

    let vault = Arc::new(vault);
    *state.vault.write().unwrap_or_else(std::sync::PoisonError::into_inner) =
        Some(Arc::clone(&vault));
    state.loading.store(false, Ordering::SeqCst);

    // The watcher, and its degrade path.  A vault whose watcher will not start
    // still OPENS and still works — `watching: false` draws the banner (M57).
    let sink_app = app.clone();
    let watch = VaultWatcher::start(
        &root,
        Arc::clone(&state.self_writes),
        Box::new(move |ev| on_watch_event(&sink_app, ev)),
    );
    let watching = match watch {
        Ok(w) => {
            *state.watcher.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(w);
            true
        }
        Err(reason) => {
            emit_degraded(app, reason);
            false
        }
    };

    // §7.6.  `last_note` is remembered per vault and is what the frontend
    // reopens; recording the vault in `recents` is the same edit.
    let root_key = root.to_string_lossy().into_owned();
    let last_note = state.prefs().map(|p| {
        p.edit(|s| {
            s.touch_vault(&root_key);
            s.vault = Some(root_key.clone());
            s.ui(&root_key).and_then(|u| u.last_note.clone())
        })
    });
    let last_note = last_note.flatten();
    state.set_open_note(last_note.clone());
    if let Some(p) = state.prefs() {
        p.save_debounced();
    }

    // §7.6.1 (errata 3, Z2) — THE READ PATH.  `root_key` above is the key
    // `save_ui_state` writes under and the string `VaultInfo.root` reports; one
    // spelling, asserted by `expansion_and_scroll_survive_a_quit_and_relaunch`.
    let (expanded, scroll_top) =
        state.prefs().map_or_else(|| (Vec::new(), 0.0), |p| p.view_state(&root_key));
    let info = vault::info(&vault, last_note, watching, expanded, scroll_top);
    app.emit_event("nc://vault-opened", info.clone());
    Ok(info)
}

/// Command 3.  A DISCRIMINATED union, never an `Option<VaultInfo>` (M65, §7.5).
pub fn current_vault(state: &AppState) -> VaultState {
    match state.vault() {
        Some(v) => {
            let last_note =
                state.open_note.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
            // §7.6.1.  Same key, same reader, same fallback as the other two.
            let key = v.root().to_string_lossy().into_owned();
            let (expanded, scroll_top) =
                state.prefs().map_or_else(|| (Vec::new(), 0.0), |p| p.view_state(&key));
            VaultState::Open {
                info: vault::info(&v, last_note, state.watching(), expanded, scroll_top),
            }
        }
        None if state.loading.load(Ordering::SeqCst) => VaultState::Loading,
        None => VaultState::None,
    }
}

/// Command 4.  `exists` is one bounded `probe_dirs` stat per entry, at most 8
/// (§7.6): a root that has not answered within `DIR_PROBE_DEADLINE` reads as
/// not existing, so an unreachable mount draws the disabled `(missing)` row
/// instead of hanging the popover.
pub fn recent_vaults(state: &AppState) -> Vec<RecentVault> {
    let Some(prefs) = state.prefs() else { return Vec::new() };
    let recents = prefs.snapshot().recents;
    let probes = probe_dirs(&recents);
    recents
        .into_iter()
        .zip(probes)
        .map(|(root, probe)| {
            let p = Path::new(&root);
            RecentVault {
                name: p
                    .file_name()
                    .map_or_else(|| root.clone(), |n| n.to_string_lossy().into_owned()),
                exists: probe == DirProbe::Dir,
                root,
            }
        })
        .collect()
}

/// What a bounded stat of a vault root could establish.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DirProbe {
    /// It is a directory.
    Dir,
    /// It is definitely not there as a directory: `ENOENT`, `ENOTDIR`, or a
    /// non-directory in its place.
    Gone,
    /// Anything else — a permission error, an I/O error, a stale handle, or no
    /// answer before the deadline.  An unreachable mount looks like this, and
    /// it is not evidence that the vault is gone.
    Unknown,
}

/// How long `probe_dirs` waits for its stats.  A stat on a hard NFS mount
/// whose server is gone blocks in the kernel indefinitely, and one on a dead
/// SMB share or automount for tens of seconds.
const DIR_PROBE_DEADLINE: Duration = Duration::from_millis(300);

/// Roots whose previous probe is still blocked in the kernel.  Such a root gets
/// no second thread, so reopening the vault switcher against a hung mount does
/// not pile up stuck threads — at most one per path.
static DIR_PROBES_IN_FLIGHT: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());

/// Stat every path in parallel, each on its own detached thread, and wait at
/// most `DIR_PROBE_DEADLINE` for the lot.  A path that has not answered by then
/// is `Unknown`; its thread is left to finish whenever the kernel lets it.
fn probe_dirs(paths: &[String]) -> Vec<DirProbe> {
    probe_dirs_with(paths, DIR_PROBE_DEADLINE, |p| std::fs::metadata(p).map(|m| m.is_dir()))
}

/// `probe_dirs` with the stat and the deadline injected, so a test can stand in
/// a stat that hangs or fails.
fn probe_dirs_with<F>(paths: &[String], deadline: Duration, stat: F) -> Vec<DirProbe>
where
    F: Fn(&Path) -> std::io::Result<bool> + Send + Clone + 'static,
{
    let in_flight = || DIR_PROBES_IN_FLIGHT.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let (tx, rx) = std::sync::mpsc::channel::<(usize, DirProbe)>();
    let mut out = vec![DirProbe::Unknown; paths.len()];
    let mut pending = 0usize;
    for (i, path) in paths.iter().enumerate() {
        if !in_flight().insert(path.clone()) {
            continue; // still stuck from last time: Unknown, and no new thread
        }
        let (tx, stat, key) = (tx.clone(), stat.clone(), path.clone());
        let spawned = std::thread::Builder::new().name("cairn-dir-probe".into()).spawn(move || {
            let probe = classify_dir_stat(stat(Path::new(&key)));
            DIR_PROBES_IN_FLIGHT
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .remove(&key);
            let _ = tx.send((i, probe));
        });
        if spawned.is_ok() {
            pending += 1;
        } else {
            in_flight().remove(path);
        }
    }
    drop(tx);
    let until = Instant::now() + deadline;
    while pending > 0 {
        let left = until.saturating_duration_since(Instant::now());
        let Ok((i, probe)) = rx.recv_timeout(left) else { break };
        if let Some(slot) = out.get_mut(i) {
            *slot = probe;
        }
        pending -= 1;
    }
    out
}

fn classify_dir_stat(r: std::io::Result<bool>) -> DirProbe {
    match r {
        Ok(true) => DirProbe::Dir,
        Ok(false) => DirProbe::Gone,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => DirProbe::Gone,
        Err(e) if e.raw_os_error() == Some(libc::ENOTDIR) => DirProbe::Gone,
        Err(_) => DirProbe::Unknown,
    }
}

/// Command 21.  §0.30 E70 — DROP A VAULT FROM THE TRACKED LIST, AND FROM
/// NOTHING ELSE.  Obsidian's `vault-remove`, transcribed from its launcher:
///
/// ```js
/// ipcMain.on("vault-remove", (t, n) => {
///   for (let s in L) if (L[s].path === n) {
///     if (Y[s]) { t.returnValue = false; return }   // a window has it OPEN
///     t.returnValue = true; delete L[s]; z(); Q(s); rt(s); return
///   }
///   t.returnValue = false
/// })
/// ```
///
/// Three properties come from that, and all three are load-bearing.
///
/// **IT TOUCHES NO FILE IN THE VAULT.** `L` is the launcher's own list; the
/// folder on disk is not read, not moved and not deleted.  G8 ("zero stray
/// files written to the vault") is unaffected because this writes exactly one
/// file and it is `state.json`.
///
/// **IT REFUSES THE OPEN VAULT.** Obsidian answers `false` and shows *"Can't
/// remove a currently open vault."*; this answers §1.5's `invalidPath` with the
/// same sentence, because the frontend already switches on `kind` and must not
/// parse prose.  The vault bar only draws the control on a NON-ACTIVE row, so
/// this is the guard behind the affordance and not a path a user can walk into.
///
/// **THE PER-VAULT STATE GOES WITH IT.** Obsidian's `Q(s)`/`rt(s)` clear that
/// vault's caches; here it is one line of `sanitise()`, which already prunes
/// `vaults` to `recents` plus the current vault (§7.6) and runs before every
/// write.  So dropping the `recents` entry is the whole edit, and the expansion
/// set and scroll position follow it out on the same flush.  Do NOT also remove
/// the `vaults` key by hand: two rules for one invariant is how they drift.
///
/// Flushed with `flush_now`, not debounced.  A deliberate removal that a crash
/// could undo is a removal the user has to make twice, and this is the same
/// synchronous atomic write `confirm_close` takes.
pub fn forget_vault(state: &AppState, root: &str) -> Result<(), VaultError> {
    if state.vault().is_some_and(|v| v.root().to_string_lossy() == root) {
        return Err(VaultError::invalid_path(root, "Can't remove a currently open vault."));
    }
    let Some(prefs) = state.prefs() else { return Ok(()) };
    prefs.edit(|s| {
        s.recents.retain(|r| r != root);
        // …AND `State.vault`, WHICH IS THE ONE THE FIRST DRAFT MISSED.  `vault`
        // is the root the next launch reopens, and `state.vault()` above only
        // rules out a vault that is open RIGHT NOW.  The two disagree in a case
        // the app really has: §7.3 case 8's vault-lost, where the folder is gone
        // and nothing is open while `state.json` still names it.  Forget it
        // there and, without this line, the next launch reopens the vault the
        // user just removed — and `sanitise()` keeps its `vaults` key too,
        // because it spares the current vault by name.
        if s.vault.as_deref() == Some(root) {
            s.vault = None;
        }
    });
    prefs.flush_now()
}

/// Command 5.  The escape hatch M57 closes: the banner's `[ Refresh ]` is bound
/// here.  It re-walks AND re-arms the watcher, because the commonest reason to
/// reach for Refresh is that the watcher degraded.  A watcher that is still
/// running can be partly blind — a directory created while the watch limit
/// was hit is never watched — so it is replaced, not only started when absent.
pub async fn rescan_all(app: impl AppCtx) -> Result<VaultInfo, VaultError> {
    let app2 = app.clone();
    let handle = app.clone();
    crate::spawn_blocking(move || {
        let state = app2.app_state();
        let vault = state.require_vault()?;
        let root = vault.root();
        if !root.is_dir() {
            // A lost root is §7.3 case 8's to report, not a degraded watcher.
            return Err(VaultError::not_found(root.to_string_lossy().into_owned()));
        }

        // Re-arm BEFORE the walk, so the walk covers anything that lands while
        // no watcher is running.  The old one is dropped with no lock held:
        // its `Drop` joins a thread that takes the vault lock (see
        // `open_vault_blocking`, step 2).
        let old = state.watcher.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take();
        drop(old);
        let sink_app = handle.clone();
        match VaultWatcher::start(
            &root,
            Arc::clone(&state.self_writes),
            Box::new(move |ev| on_watch_event(&sink_app, ev)),
        ) {
            Ok(w) => {
                // A vault switch that raced this Refresh owns the slot now.
                let same_vault = state.vault().is_some_and(|v| v.root() == root);
                let mut slot = state.watcher.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                let stale = if same_vault && slot.is_none() {
                    *slot = Some(w);
                    None
                } else {
                    Some(w)
                };
                drop(slot);
                drop(stale);
            }
            // `watching` is then false and the banner stays: the honest answer.
            Err(reason) => emit_degraded(&handle, reason),
        }

        let epoch = repair(state).ok_or_else(|| {
            VaultError::not_found(vault.root().to_string_lossy().into_owned())
        })?;
        handle.emit_event("nc://tree-changed", TreeChanged { epoch });

        let last_note =
            state.open_note.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
        // §7.6.1.  A rescan re-reports the persisted set, which is harmless:
        // the FRONTEND applies it only when `switched` is true (§7.6.1's
        // application rule), so a watcher-driven refresh cannot stomp live
        // expansion.
        let key = vault.root().to_string_lossy().into_owned();
        let (expanded, scroll_top) =
            state.prefs().map_or_else(|| (Vec::new(), 0.0), |p| p.view_state(&key));
        let info = vault::info(&vault, last_note, state.watching(), expanded, scroll_top);
        handle.emit_event("nc://vault-opened", info.clone());
        Ok(info)
    })
    .await
    .map_err(|e| VaultError::io("<vault walker>", &std::io::Error::other(e.to_string())))?
}

/* ── the watcher -> event mapping (§1.4) ──────────────────────────────────── */

/// `watcher.rs` never emits; this is the mapping it says is the caller's job.
/// Runs on the coalescing thread, so it must not block for long — the one slow
/// thing it does is `repair`, which is exactly what a flush is FOR.
fn on_watch_event(app: &impl AppCtx, ev: WatchEvent) {
    let state = app.app_state();
    match ev {
        WatchEvent::Flush(flush) => {
            // spec-02 §7.5's filter, and it is not an optimisation: without it a
            // `git checkout` touching 800 files emits 800 events for information
            // the editor discards for 799 of them.
            let root = state.vault().map(|v| v.root());
            let mut told_open = false;
            if let Some(root) = root {
                for hit in &flush.content_hits {
                    let Some(rel) = rel_of(&root, &hit.abs) else { continue };
                    if state.open_note_is(&rel) {
                        told_open = true;
                        app.emit_event(
                            "nc://note-external-change",
                            ExternalChange { path: rel, mtime_ms: hit.mtime_ms, size: hit.len },
                        );
                    }
                }
            }
            /* THE OVERFLOW BACKSTOP.  `content_hits` is the only source of
             * `nc://note-external-change`, and `push_hit` stops collecting at
             * `MAX_DIRTY` — so when a bulk change (a `git checkout`, a restore)
             * overflows the batch, the open note's own hit can be one of the
             * ones that never arrived. `watcher.rs` no longer CLEARS the
             * collected hits, which covers the common case; this covers the
             * rest.
             *
             * THE SNAPSHOT IS TAKEN BEFORE `repair`, WHICH IS THE WHOLE TRICK:
             * `repair` re-walks the vault and rewrites every `Node.mtime`, so
             * afterwards there is nothing left to compare against.
             *
             * AND IT MUST NOT FIRE ON AN UNCHANGED FILE. The frontend's
             * `noteExternalChange` re-reads and calls `loadDoc`, which is
             * `view.setState(...)` — that DESTROYS THE UNDO HISTORY. So this
             * emits only when the mtime actually moved, never merely because a
             * rescan happened.
             *
             * RESIDUAL, STATED: `Node.mtime` is unix SECONDS (it is 4 bytes of
             * a struct gate G1 pins at 24, so there is no room for the
             * millisecond stat the hit carries), so a change landing in the
             * same second as the tree's recorded mtime is not seen here. That
             * is a strictly narrower hole than the one this closes, and the
             * `content_hits` path — which does carry milliseconds — is still
             * what handles every non-overflowing flush. */
            let before = if flush.full_rescan && !told_open {
                let rel = state
                    .open_note
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .clone();
                rel.and_then(|rel| {
                    let v = state.vault()?;
                    // ONE read guard, dropped before `repair` takes the write
                    // lock — holding it across `repair` would deadlock.
                    let mtime = {
                        let t = v.read();
                        let id = t.resolve(&rel)?;
                        t.get(id)?.mtime
                    };
                    Some((rel, mtime, v.root()))
                })
            } else {
                None
            };
            if let Some(epoch) = repair(state) {
                app.emit_event("nc://tree-changed", TreeChanged { epoch });
            }
            if let Some((rel, was, root)) = before {
                let abs = root.join(&rel);
                if let Ok(md) = std::fs::metadata(&abs) {
                    let now_secs = u32::try_from(fsops::mtime_ms(&md) / 1000).unwrap_or(0);
                    // An autosave of ours landing between the snapshot and
                    // this stat moves the mtime too; it is ours by fingerprint.
                    let ours = state
                        .self_writes
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .matches_for(&abs);
                    if now_secs != was && !ours {
                        app.emit_event(
                            "nc://note-external-change",
                            ExternalChange {
                                path: rel,
                                mtime_ms: fsops::mtime_ms(&md),
                                size: md.len(),
                            },
                        );
                    }
                }
            }
        }
        WatchEvent::VaultLost { path } => {
            // §7.3 case 8: drop the vault, do NOT rescan.  The watcher thread is
            // still running underneath us, so the watcher handle is NOT taken
            // here — dropping it would join the thread we are called from.  It
            // is released by the next `open_vault`, which takes it first thing.
            state.search.cancel_all();
            let old = tree::take_vault(&state.vault);
            drop(old);
            state.set_open_note(None);
            app.emit_event("nc://vault-lost", VaultLost { path: path.to_string_lossy().into_owned() });
        }
        WatchEvent::Degraded { reason, hint } => {
            app.emit_event("nc://watch-degraded", Degraded { reason: reason.as_str(), hint });
        }
    }
}

fn emit_degraded(app: &impl AppCtx, reason: DegradeReason) {
    let hint = match reason {
        DegradeReason::WatchLimit => {
            "The system ran out of file-watch handles. Use Refresh to pick up changes."
        }
        DegradeReason::WatchError => "File watching stopped. Use Refresh to pick up changes.",
    };
    app.emit_event(
        "nc://watch-degraded",
        Degraded { reason: reason.as_str(), hint: hint.to_string() },
    );
}

/* ── 6-7: the tree ────────────────────────────────────────────────────────── */

/// Command 6.  RAW OUT: TreeBlob v1, ONE crossing (B1/B19/M49).  191,975 B
/// measured at 5,620 nodes; as a JSON number array it would be ~4x and a full
/// parse.
pub fn tree_blob(state: &AppState) -> Result<Vec<u8>, VaultError> {
    Ok(state.require_vault()?.read().encode_blob())
}

/// Command 25.  The vault-relative rels of every secret note, in snapshot
/// order.  Feeds the tree's row mark — and nothing else, by design: the
/// viewer re-detects on every open and the search exclusion on every scan,
/// so a stale mark here is cosmetic (a row missing its tint until the next
/// mtime change) rather than a security boundary.  No vault open means no
/// secrets, not an error — same rule `search_start` applies to its empty
/// snapshot.
pub fn secret_notes(state: &AppState) -> Vec<String> {
    state.vault().map_or_else(Vec::new, |v| v.secret_notes())
}

/// Command 7.  Returns the NEW epoch.  Four orders, no created-time (M28/M53).
pub fn set_sort(app: &impl AppCtx, state: &AppState, sort: u8) -> Result<u64, VaultError> {
    let mode = SortMode::from_u8(sort)
        .ok_or_else(|| VaultError::invalid_path("<sort>", "sort must be 0, 1, 2 or 3"))?;
    let vault = state.require_vault()?;
    // Under `repair_lock`: a repair walking with the OLD sort would otherwise
    // install its tree over this one and silently undo the change.
    let (epoch, root) = {
        let _serial = state.repair_lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let epoch = state.next_epoch();
        let mut t = vault.write();
        t.set_sort(mode, epoch);
        // `set_sort` is a no-op when the mode is unchanged and does NOT take the
        // epoch in that case, so the tree is stamped here rather than trusted to
        // have been.  The counter has still advanced; a skipped epoch is free.
        t.epoch = epoch;
        (epoch, t.root_path.to_string_lossy().into_owned())
    };
    if let Some(p) = state.prefs() {
        p.edit(|s| s.apply(Some(&root), &UiPatch { sort: Some(sort), ..UiPatch::default() }));
        p.save_debounced();
    }
    app.emit_event("nc://tree-changed", TreeChanged { epoch });
    Ok(epoch)
}

/* ── 8-9: notes ───────────────────────────────────────────────────────────── */

/// Command 8.  RAW OUT, the §2 frame.  Opening a note is what makes it THE open
/// note, which is what `nc://note-external-change` is filtered by (§1.4).
pub fn read_note(state: &AppState, path: &str) -> Result<Vec<u8>, VaultError> {
    let vault = state.require_vault()?;
    let (abs, is_dir) = resolve(&vault, path)?;
    if is_dir {
        return Err(VaultError::not_found(path));
    }
    let framed = fsops::read_note_framed(&abs, path)?;
    state.set_open_note(Some(path.to_string()));
    Ok(framed)
}

/// Command 9.  RAW IN + headers.  `write_note` NEVER CREATES unless `x-create`
/// is '1' (§7.1 rule 1), and that header is set in exactly one place in the whole
/// app: the "Save as…" button on §7.3 case 5's bar.
pub fn write_note(
    app: &impl AppCtx,
    state: &AppState,
    args: &WriteArgs,
    body: &[u8],
) -> Result<WriteReceipt, VaultError> {
    let _busy = WriteInFlight::new(state);
    let vault = state.require_vault()?;
    let (abs, structural) = if args.create {
        // Save-As: the file does not exist in the arena yet, so only the PARENT
        // resolves.  The final component is validated as a NAME (the strict
        // policy), not as a lookup path.
        let (parent, name) = resolve_parent(&vault, &args.rel)?;
        vpath::validate_name(&name)?;
        (parent.join(&name), true)
    } else {
        let (abs, is_dir) = resolve(&vault, &args.rel)?;
        if is_dir {
            return Err(VaultError::not_a_directory(&args.rel));
        }
        (abs, false)
    };

    let receipt = fsops::write_note(&abs, args, body, &state.self_writes)?;

    if structural {
        state.set_open_note(Some(args.rel.clone()));
        repair_and_emit(app, state);
    } else {
        // M69, and the reason a plain autosave does NOT re-walk: the ONLY thing
        // that changed in the arena is one node's `mtime`, which the mtime sort
        // orders read.  Updating it in place is O(depth); a re-walk would put
        // 21.8 ms on every autosave for a fact worth four bytes.
        touch_mtime(&vault, &args.rel, receipt.mtime_ms);
    }
    Ok(receipt)
}

/// M69's "apply content hits to `Node.mtime` unconditionally", for the one node
/// we just wrote.  Whole seconds, because `Node.mtime` is a `u32` of them.
fn touch_mtime(vault: &Vault, rel: &str, mtime_ms: i64) {
    let mut t = vault.write();
    let Some(id) = t.resolve(rel) else { return };
    let secs = u32::try_from(mtime_ms.max(0) / 1_000).unwrap_or(u32::MAX);
    if let Some(n) = t.nodes.get_mut(id as usize) {
        n.mtime = secs;
    }
}

/* ── 10-13: mutations ─────────────────────────────────────────────────────── */

/// Command 10.  `parent` is vault-relative; `""` is the vault root.
pub fn create_note(
    app: &impl AppCtx,
    state: &AppState,
    parent: &str,
    name: Option<&str>,
) -> Result<CreateResult, VaultError> {
    let _busy = WriteInFlight::new(state);
    let vault = state.require_vault()?;
    let (abs, _) = resolve(&vault, parent)?;
    let (_, file_name) = fsops::create_note(&abs, name, &state.self_writes)?;
    Ok(CreateResult { path: join_rel(parent, &file_name), epoch: repair_and_emit(app, state) })
}

/// Command 11.
pub fn create_folder(
    app: &impl AppCtx,
    state: &AppState,
    parent: &str,
    name: Option<&str>,
) -> Result<CreateResult, VaultError> {
    let _busy = WriteInFlight::new(state);
    let vault = state.require_vault()?;
    let (abs, _) = resolve(&vault, parent)?;
    let (_, file_name) = fsops::create_folder(&abs, name, &state.self_writes)?;
    Ok(CreateResult { path: join_rel(parent, &file_name), epoch: repair_and_emit(app, state) })
}

/// Command 12.  MUST update `AppState.open_note` under the write lock (M54):
/// §5.4.2's inline-title rename and §7.3 case 4 both depend on Rust not holding
/// a stale path — a stale one silently kills `nc://note-external-change` for the
/// note the user is actually looking at.
pub fn rename_entry(
    app: &impl AppCtx,
    state: &AppState,
    path: &str,
    new_name: &str,
) -> Result<RenameResult, VaultError> {
    let _busy = WriteInFlight::new(state);
    let vault = state.require_vault()?;
    let (src, is_dir) = resolve(&vault, path)?;
    let dst = fsops::rename_target(&src, new_name, !is_dir)?;
    // F73: the entry's true spelling — on a normalising filesystem the typed
    // name is not what the directory holds, and the arena must learn the true
    // one or the note detaches.
    let final_abs = fsops::rename_entry(&src, &dst, &state.self_writes)?;

    let final_name = final_abs
        .file_name()
        .map_or_else(|| new_name.to_string(), |n| n.to_string_lossy().into_owned());
    let parent = path.rfind('/').map_or("", |i| path.get(..i).unwrap_or(""));
    let new_rel = join_rel(parent, &final_name);

    reparent_open_note(state, path, &new_rel, is_dir);

    Ok(RenameResult { path: new_rel, epoch: repair_and_emit(app, state) })
}

/// Command 24.  Drag-to-move: `path` into `dest_parent` (`""` = vault root).
/// Obsidian's file-explorer drop, transcribed (`attachDropHandler` in app.js):
/// a drop moves via rename with `getAvailablePath` uniquification, never a
/// refuse-on-collision. `fsops::move_entry` carries that half; this carries
/// the arena half — the SA rule, the no-op, and M54's `open_note` reparenting.
///
/// SA (transcribed): `e!==t && !(dragged is root) && !(dragged is a folder AND
/// target starts with dragged+"/")` — a folder cannot be dropped into itself
/// or a descendant. The root is never draggable (it has no row), so only the
/// descendant clause is enforced here; the frontend enforces the rest by never
/// highlighting an invalid target. A move whose parent is unchanged is a no-op
/// returning the same path with the current epoch (no re-walk, no event).
pub fn move_entry(
    app: &impl AppCtx,
    state: &AppState,
    path: &str,
    dest_parent: &str,
) -> Result<RenameResult, VaultError> {
    let _busy = WriteInFlight::new(state);
    let vault = state.require_vault()?;
    let (src_abs, is_dir) = resolve(&vault, path)?;
    // `""` is the vault root (§1.1); anything else must resolve to a directory.
    let dst_dir_abs = if dest_parent.is_empty() {
        let t = vault.read();
        t.root_path.clone()
    } else {
        let (abs, dst_is_dir) = resolve(&vault, dest_parent)?;
        if !dst_is_dir {
            return Err(VaultError::invalid_path(
                dest_parent,
                "a note cannot contain anything - drop onto a folder",
            ));
        }
        abs
    };
    // SA, backend half: a folder into itself or a descendant is refused, never
    // performed. `path == dest_parent` is the self-drop; `starts_with(path+"/")`
    // is the descendant drop. The prefix test is on `"{path}/"`, never on
    // `path` — moving `Work` must not refuse `Workshop` as a target.
    if is_dir && (dest_parent == path || dest_parent.starts_with(&format!("{path}/"))) {
        return Err(VaultError::invalid_path(
            path,
            "a folder cannot be moved into itself or one of its own subfolders",
        ));
    }
    // Already there: no-op. The parent of `a/b.md` is `a`; of `a.md` is `""`.
    let src_parent = path.rfind('/').map_or("", |i| path.get(..i).unwrap_or(""));
    if src_parent == dest_parent {
        return Ok(RenameResult { path: path.to_string(), epoch: state.epoch() });
    }
    let dst_abs = fsops::move_entry(&src_abs, &dst_dir_abs, is_dir, &state.self_writes)?;
    let final_name = dst_abs
        .file_name()
        .map_or_else(String::new, |n| n.to_string_lossy().into_owned());
    let new_rel = join_rel(dest_parent, &final_name);

    reparent_open_note(state, path, &new_rel, is_dir);

    Ok(RenameResult { path: new_rel, epoch: repair_and_emit(app, state) })
}

/// Command 13.  Delete of the OPEN note is ORDERED, not raced (B17), and
/// `AppState.open_note` is CLEARED (M54).  There is no `(deleted)` tab marker:
/// spec-04 §10.4's row is STRUCK.
pub fn delete_entry(
    app: &impl AppCtx,
    state: &AppState,
    path: &str,
    permanent: bool,
) -> Result<DeleteResult, VaultError> {
    let _busy = WriteInFlight::new(state);
    let vault = state.require_vault()?;
    let (abs, is_dir) = resolve(&vault, path)?;
    fsops::delete_entry(&abs, path, permanent, &state.self_writes)?;

    // B17: cleared BEFORE the repair and before the event, so an autosave that
    // lands in the gap gets `notFound` from `fsops::write_note`'s step 1b
    // instead of resurrecting the file the user just deleted.
    clear_open_note_under(state, path, is_dir);

    Ok(DeleteResult { epoch: repair_and_emit(app, state) })
}

/// M54, the rename half.  The open note may be the renamed entry ITSELF, or may
/// live UNDER a renamed folder — both leave `open_note` stale, and only the
/// first is obvious.
///
/// A stale `open_note` is not cosmetic: it is what `nc://note-external-change`
/// is filtered by (§1.4), so it silently stops the editor hearing about the note
/// the user is actually looking at, and §7.3 case 4 depends on it being right.
///
/// The prefix test is on `"{path}/"`, never on `path`: renaming `Work` must not
/// drag `Workshop/a.md` with it.
fn reparent_open_note(state: &AppState, old_rel: &str, new_rel: &str, is_dir: bool) {
    let mut g = state.open_note.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let next = match g.as_deref() {
        Some(cur) if cur == old_rel => Some(new_rel.to_string()),
        Some(cur) if is_dir && cur.starts_with(&format!("{old_rel}/")) => {
            cur.get(old_rel.len()..).map(|rest| format!("{new_rel}{rest}"))
        }
        _ => None,
    };
    if next.is_some() {
        *g = next;
    }
}

/// M54, the delete half.  Same containment rule, same `"{path}/"` prefix.
fn clear_open_note_under(state: &AppState, path: &str, is_dir: bool) {
    let mut g = state.open_note.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let hit = g
        .as_deref()
        .is_some_and(|cur| cur == path || (is_dir && cur.starts_with(&format!("{path}/"))));
    if hit {
        *g = None;
    }
}

/// `""` + `"a.md"` -> `"a.md"`; `"p"` + `"a.md"` -> `"p/a.md"`.  The vault-
/// relative form never has a leading separator.
fn join_rel(parent: &str, name: &str) -> String {
    if parent.is_empty() {
        name.to_string()
    } else {
        format!("{parent}/{name}")
    }
}

/* ── 14-16: search ────────────────────────────────────────────────────────── */

/// Command 14.  4 threads per query, NO persistent pool (B4/M47).  The FRONTEND
/// owns the generation number; Rust records it and never invents one.
///
/// With no vault open the search still RUNS, over an empty snapshot: the
/// frontend gets `Files(0)` then `Done` and renders "no results", where
/// returning early would leave its panel spinning forever with nothing on the
/// channel.
pub async fn search_start<S: MsgSink + Send + 'static>(
    state: &AppState,
    query: String,
    generation: u64,
    on_event: S,
) -> Result<(), VaultError> {
    let snapshot = state.vault().map_or_else(
        || Arc::new(VaultSnapshot { root: PathBuf::new(), files: Vec::new(), epoch: 0 }),
        |v| v.snapshot(),
    );
    search::start(&state.search, snapshot, query, generation, on_event).await
}

/// Command 15.
pub fn search_expand(
    state: &AppState,
    query: &str,
    rel: &str,
) -> Result<Vec<Snippet>, VaultError> {
    let Some(vault) = state.vault() else { return Ok(Vec::new()) };
    search::expand(&vault.root(), query, rel)
}

/// Command 16.  A vault switch CANCELS rather than bumping (§4.3, X15).
pub fn search_cancel(state: &AppState, generation: u64) {
    search::cancel(&state.search, generation);
}

/* ── 17-20: state, lifecycle, diagnostics ─────────────────────────────────── */

/// Command 17.  §7.6, debounced 1,000 ms.
pub fn save_ui_state(state: &AppState, patch: &UiPatch) {
    let Some(prefs) = state.prefs() else { return };
    let root = state.vault().map(|v| v.root().to_string_lossy().into_owned());
    prefs.edit(|s| s.apply(root.as_deref(), patch));
    // The frontend's `last_note` is the SAME fact as `AppState.open_note`, and
    // two copies of one fact drift.  The outer `Option` is "the patch mentioned
    // it"; the inner one is "there is no open note now" (§1.5), and collapsing
    // them is what loses the ability to close the last note and have that
    // survive a restart.
    if let Some(last) = patch.last_note.clone() {
        state.set_open_note(last);
    }
    prefs.save_debounced();
}

/// Command 18, the frontend's half of §1.6.  A REJECTING FLUSH CANCELS THE
/// CLOSE — spec-03 §9.2's unconditional 2 s watchdog is STRUCK, because a
/// watchdog that closes anyway is a silent discard wearing a timeout's clothes.
pub fn confirm_close(app: &impl AppCtx, state: &AppState, ok: bool, reason: Option<&str>) {
    // Either answer DISARMS the watchdog: bumping the token is what the sleeping
    // thread compares against.
    state.close_token.fetch_add(1, Ordering::SeqCst);
    if !ok {
        eprintln!(
            "cairn: close cancelled by the frontend ({})",
            reason.unwrap_or("no reason given")
        );
        return;
    }
    // §1.6's sequencing, fixed: editor buffer FIRST (the frontend has just done
    // that, which is what `ok` means), `state.json` SECOND.
    flush_prefs(state);
    state.close_ok.store(true, Ordering::SeqCst);
    app.quit(0);
}

/// Command 20.  "Reveal in Finder", RESTORED (X11).  Resolved through the arena
/// exactly as `read_note` resolves, so §7.3 case 13's traversal guarantee is
/// unchanged, and no `shell:*` capability is granted.
pub fn reveal_in_os(state: &AppState, path: &str) -> Result<(), VaultError> {
    let vault = state.require_vault()?;
    let (abs, _) = resolve(&vault, path)?;
    fsops::reveal_in_os(&abs, path)
}

/* ── §1.6: the close/exit interception ────────────────────────────────────── */

/// Returns true when the caller must PREVENT the close and wait for command 18.
///
/// Called from both `WindowEvent::CloseRequested` (the ✕) and
/// `RunEvent::ExitRequested` (⌘Q).  Both arm the same handshake, which is why
/// it lives in one function rather than two that drift.
pub fn begin_close(app: &impl AppCtx) -> bool {
    let state = app.app_state();
    if state.close_ok.load(Ordering::SeqCst) {
        return false;
    }
    let token = state.close_token.fetch_add(1, Ordering::SeqCst) + 1;
    app.emit_event("nc://flush-and-close", FlushAndClose { deadline_ms: CLOSE_DEADLINE_MS });

    let handle = app.clone();
    /* THE SPAWN RESULT IS READ.  It was `let _ = …`, which silently removed
     * §1.6's 2 s backstop: out of threads, no watchdog, and a frontend hung on
     * a stalled disk would leave the ✕ doing nothing at all with no line
     * anywhere saying why.
     *
     * LOG AND CONTINUE IS THE ONLY NON-HARMFUL ANSWER HERE, and the two
     * alternatives are worth writing down because each looks reasonable:
     *   · running the wait INLINE — `prefs.rs`'s answer for its own failed
     *     spawn — would sleep 2 s inside the close handler, i.e. block the
     *     thing the watchdog exists to unblock;
     *   · returning `false` would CANCEL the close, so the ✕ would do nothing
     *     on the very path where the user wants out.
     * So the close still proceeds and still waits for `confirm_close`, which is
     * the normal path; only the hung-disk backstop is gone, and now it says so. */
    let spawned = std::thread::Builder::new().name("cairn-close".into()).spawn(move || {
        let state = handle.app_state();
        // The deadline runs from the last vault write activity, not from the
        // arming: the frontend's flush is itself a `write_note`, and quitting
        // while it is in `sync_data` strands its bytes in a temp file the next
        // open deletes.  `CLOSE_HARD_CAP_MS` still bounds the whole wait.
        let quiet_for = Duration::from_millis(CLOSE_DEADLINE_MS);
        let cap = close_hard_cap(state);
        let armed_at = Instant::now();
        let mut quiet_since = armed_at;
        let mut seen = state.write_activity.load(Ordering::SeqCst);
        let capped = loop {
            std::thread::sleep(CLOSE_POLL);
            // Somebody answered (either way): their `fetch_add` moved the token.
            if state.close_token.load(Ordering::SeqCst) != token {
                return;
            }
            let activity = state.write_activity.load(Ordering::SeqCst);
            if activity != seen || state.writes_in_flight.load(Ordering::SeqCst) > 0 {
                seen = activity;
                quiet_since = Instant::now();
            }
            if quiet_since.elapsed() >= quiet_for {
                break false;
            }
            if armed_at.elapsed() >= cap {
                break true;
            }
        };
        // THE WATCHDOG EXISTS FOR A HUNG DISK, NOT FOR A REFUSED WRITE (§1.6).
        // Only a frontend that has not answered at all reaches here, and this
        // path logs what it is discarding.  The prefs flush is BEST-EFFORT with
        // a bounded wait: on the hung disk this backstop exists for, a
        // synchronous flush would block the quit it is supposed to guarantee,
        // leaving the window unclosable except via SIGKILL.
        if capped {
            eprintln!(
                "cairn: a vault write was still in progress {} ms after flush-and-close; \
                 closing anyway and discarding whatever was unflushed",
                cap.as_millis()
            );
        } else {
            eprintln!(
                "cairn: the frontend did not answer flush-and-close within {CLOSE_DEADLINE_MS} ms; \
                 closing anyway and discarding whatever was unflushed"
            );
        }
        // Best-effort prefs flush on an owned Arc: `state` is borrowed from
        // `handle`, which cannot cross the inner spawn boundary, but the prefs
        // store is already an Arc and is all the flush needs.
        let prefs = state.prefs().cloned();
        let flush = std::thread::Builder::new()
            .name("cairn-close-flush".into())
            .spawn(move || {
                if let Some(p) = prefs {
                    if let Err(e) = p.flush_now() {
                        eprintln!("cairn: could not write state.json: {e}");
                    }
                }
            });
        if let Ok(join) = flush {
            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(500);
            while !join.is_finished() && std::time::Instant::now() < deadline {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            // Quit regardless: a hung flush must not veto the close.  The
            // handle is detached on timeout; its write either lands or it does
            // not, and losing a window position is never worth hanging a quit.
        }
        state.close_ok.store(true, Ordering::SeqCst);
        handle.quit(0);
    });
    if spawned.is_err() {
        eprintln!(
            "cairn: could not spawn the close watchdog; §1.6's {CLOSE_DEADLINE_MS} ms backstop is              NOT armed for this close. The flush-and-close handshake still runs — only a frontend              that never answers at all will now hang instead of closing."
        );
    }
    true
}

#[cfg_attr(not(test), allow(unused_variables))]
fn close_hard_cap(state: &AppState) -> Duration {
    #[cfg(test)]
    {
        let ms = state.close_cap_ms.load(Ordering::SeqCst);
        if ms > 0 {
            return Duration::from_millis(ms);
        }
    }
    Duration::from_millis(CLOSE_HARD_CAP_MS)
}

/// §7.6.  Synchronous and total: the `confirm_close` path needs the bytes down
/// before the process goes away, so this is `flush_now`, never the debounce.
fn flush_prefs(state: &AppState) {
    if let Some(p) = state.prefs() {
        if let Err(e) = p.flush_now() {
            // Never a dialog and never a startup failure (§7.6): losing a window
            // position is not worth blocking a quit for.  One line.
            eprintln!("cairn: could not write state.json: {e}");
        }
    }
}

/* ── §7.5: first run and the startup open ─────────────────────────────────── */

/// User ruling, 2026-09-14: vaults whose folders are gone are REMOVED from the
/// tracked list automatically on launch — no `(missing)` rows survive a
/// restart. The popover still SHOWS a vault that disappears mid-session (that
/// is `recent_vaults`' `exists` flag, and the row keeps its `Close` control),
/// because silently dropping one then would read as data loss; on the next
/// launch this runs first and the row is gone.
///
/// Only `recents` and `vault` are edited here. The per-vault `vaults` map
/// follows on the same flush via `sanitise()`, which prunes it to `recents`
/// plus the current vault — the same one-line mechanism `forget_vault` relies
/// on, so there is still exactly one rule for that invariant. Returns true
/// when anything was removed, in which case `state.json` has been rewritten.
///
/// "Gone" means `DirProbe::Gone`, and only that.  A root that cannot be stat'ed
/// for any other reason — permission denied, an I/O error, a mount that does
/// not answer within the probe deadline — is KEPT, with its per-vault state:
/// an offline share is not a deleted folder.  The probes run before
/// `prefs.edit`, so no stat ever happens under the prefs lock.
pub fn prune_missing_vaults(state: &AppState) -> bool {
    let Some(prefs) = state.prefs() else { return false };
    let snap = prefs.snapshot();
    let mut roots = snap.recents;
    if let Some(v) = snap.vault {
        if !roots.contains(&v) {
            roots.push(v);
        }
    }
    let probes = probe_dirs(&roots);
    let gone: Vec<String> = roots
        .into_iter()
        .zip(probes)
        .filter(|(_, p)| *p == DirProbe::Gone)
        .map(|(r, _)| r)
        .collect();
    if gone.is_empty() {
        return false;
    }
    let changed = prefs.edit(|s| {
        let before_n = s.recents.len();
        let before_vault = s.vault.clone();
        s.recents.retain(|r| !gone.contains(r));
        if s.vault.as_ref().is_some_and(|v| gone.contains(v)) {
            s.vault = None;
        }
        s.recents.len() != before_n || s.vault != before_vault
    });
    if changed {
        if let Err(e) = prefs.flush_now() {
            eprintln!("cairn: could not write state.json: {e}");
        }
    }
    changed
}

/// `setup()` MUST NOT BLOCK ON THE VAULT WALK (§7.5).  This is spawned as a
/// plain thread — not a tokio task — because it runs before the runtime has any
/// other work and a 21.8 ms walk on a blocking worker would hold one of only six
/// slots that the search coordinator also draws from (§6.2, X8).
///
/// With no `prefs.vault` (a fresh install) it does NOTHING and leaves
/// `current_vault()` answering `{state:'none'}`, which is what renders the
/// "Open folder as vault…" button.  Before M65 that case rendered an empty
/// sidebar and an empty pane and waited forever.
///
/// It stats the tracked roots (bounded, `probe_dirs`), so the shell calls it
/// from a worker, never from its UI thread.  A last vault that does not answer
/// as a directory is left in `state.json` and simply not reopened: starting an
/// open against a hung mount would park a walker that could complete hours
/// later and switch the app away from whatever vault the user chose since.
pub fn spawn_startup_open(app: &impl AppCtx) {
    let state = app.app_state();
    let Some(prefs) = state.prefs() else { return };
    prune_missing_vaults(state);
    let Some(path) = prefs.snapshot().vault else { return };
    if probe_dirs(std::slice::from_ref(&path)).first() != Some(&DirProbe::Dir) {
        return;
    }
    state.loading.store(true, Ordering::SeqCst);
    let handle = app.clone();
    // `path` moves into the closure; keep the name for the failure line.
    let named = path.clone();
    // Same shape, same reason: a swallowed spawn here leaves `loading` stuck
    // TRUE and the vault never opening, with nothing on stderr. Inline is not
    // an option — §7.5 says `setup()` MUST NOT BLOCK ON THE VAULT WALK — so
    // `loading` is released and the failure is named.
    let spawned = std::thread::Builder::new().name("cairn-vault-open".into()).spawn(move || {
        let state = handle.app_state();
        if let Err(e) = open_vault_blocking(&handle, state, &path) {
            state.loading.store(false, Ordering::SeqCst);
            eprintln!("cairn: could not reopen {path}: {e}");
        }
    });
    if spawned.is_err() {
        // `loading` was set TRUE above and nothing else clears it on this path,
        // so releasing it here is what keeps the UI from waiting forever on a
        // walk that never started.
        state.loading.store(false, Ordering::SeqCst);
        eprintln!("cairn: could not spawn the startup vault open; {named} was not reopened");
    }
}

/* ─────────────────────────────────────────────────────────────────────────────
 * TESTS.  The shell seam is the `AppCtx` implementations below, so the
 * mutating commands are exercised through the pieces they compose (`resolve`,
 * `repair`, the M54 bookkeeping) rather than end to end.  The IPC round trip
 * itself is covered by the electron-shell suites.
 * ────────────────────────────────────────────────────────────────────────── */
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]
mod tests {
    use super::*;
    use std::fs;

    /// A vault on disk plus an open `AppState` over it.
    fn fixture() -> (tempfile::TempDir, AppState) {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        fs::create_dir(root.join("Projects")).expect("mkdir");
        fs::create_dir(root.join("Projects/2026")).expect("mkdir");
        fs::write(root.join("Top.md"), "# top\n").expect("write");
        fs::write(root.join("Projects/Plan.md"), "# plan\n").expect("write");
        fs::write(root.join("Projects/2026/Q1.md"), "# q1\n").expect("write");

        let state = AppState::new();
        // The same canonicalisation `open_vault_blocking` does, and for the same
        // reason: on macOS `/var/folders/...` (where tempfile lives) IS a
        // symlinked path, so without it every test here would compare
        // `/var/...` against `/private/var/...` and the fixture would be
        // measuring the bug instead of the behaviour.
        let root = fsops::canonical_root(root).expect("canonical root");
        let epoch = state.next_epoch();
        let (vault, _swept) = vault::open_at(&root, SortMode::default(), epoch).expect("walk");
        *state.vault.write().expect("vault lock") = Some(Arc::new(vault));
        (dir, state)
    }

    /* ── the one epoch counter (§1.4) ─────────────────────────────────────── */

    /// §1.4: "There is exactly one such counter in the process." Zero is never
    /// handed out, so an epoch of 0 anywhere is unambiguously "no vault has
    /// been opened", not "the first one".
    #[test]
    fn the_epoch_is_one_monotonic_counter_that_never_issues_zero() {
        let state = AppState::new();
        assert_eq!(state.epoch(), 0, "nothing has been opened yet");
        let a = state.next_epoch();
        let b = state.next_epoch();
        let c = state.next_epoch();
        assert_eq!((a, b, c), (1, 2, 3));
        assert_eq!(state.epoch(), 3);
    }

    /// The blob header at offset 24 carries the SAME number the state counter
    /// last issued — §1.4's "the same counter" claim, checked against the bytes
    /// rather than against a comment.
    #[test]
    fn the_blob_header_epoch_is_the_state_counter() {
        let (_d, state) = fixture();
        let epoch = repair(&state).expect("repair");
        let blob = tree_blob(&state).expect("blob");
        let from_blob = u64::from_le_bytes(
            blob.get(24..32).expect("header").try_into().expect("8 bytes"),
        );
        assert_eq!(from_blob, epoch);
        assert_eq!(from_blob, state.epoch());
    }

    /* ── resolution: the arena IS the check (§7.3 cases 12, 13) ───────────── */

    #[test]
    fn resolve_walks_the_arena_and_finds_what_the_walk_admitted() {
        let (_d, state) = fixture();
        let v = state.vault().expect("vault");
        let (abs, is_dir) = resolve(&v, "Projects/2026/Q1.md").expect("resolve");
        assert!(!is_dir);
        assert!(abs.ends_with("Projects/2026/Q1.md"));
        assert_eq!(fs::read_to_string(&abs).expect("read"), "# q1\n");

        let (dir_abs, is_dir) = resolve(&v, "Projects").expect("resolve dir");
        assert!(is_dir);
        assert!(dir_abs.is_dir());

        // The root itself resolves, and that is what makes `create_note("")`
        // work without a special case for the top level.
        let (root_abs, is_dir) = resolve(&v, "").expect("resolve root");
        assert!(is_dir);
        assert_eq!(root_abs, v.root());
    }

    /// §7.3 case 13 at the INTEGRATION seam.  Every one of these is refused
    /// because the arena has no such node — not because a character rule caught
    /// it — which is the guarantee the contract actually rests on.
    #[test]
    fn case_13_traversal_is_refused_at_the_command_seam() {
        let (_d, state) = fixture();
        let v = state.vault().expect("vault");
        for evil in [
            "../outside.md",
            "Projects/../../outside.md",
            "/etc/passwd",
            "..",
            "Projects/./Plan.md",
            "Projects//Plan.md",
            "Missing/Plan.md",
        ] {
            let got = resolve(&v, evil);
            assert!(got.is_err(), "resolve({evil:?}) must fail, got {got:?}");
        }
    }

    /// A directory that exists on disk but was SKIPPED by the walk (a dotfile,
    /// §3.6) is not in the arena, so it is not reachable by any command.  This
    /// is the rule that keeps `.git` and `.obsidian` unwritable through the IPC.
    #[test]
    fn a_skipped_dotfile_directory_is_unreachable_through_the_arena() {
        let dir = tempfile::tempdir().expect("tempdir");
        fs::create_dir(dir.path().join(".git")).expect("mkdir");
        fs::write(dir.path().join(".git/config"), "x").expect("write");
        let root = fsops::canonical_root(dir.path()).expect("canonical");
        let (vault, _) = vault::open_at(&root, SortMode::default(), 1).expect("walk");
        assert!(resolve(&vault, ".git").is_err());
        assert!(resolve(&vault, ".git/config").is_err());
        assert!(resolve_parent(&vault, ".git/new.md").is_err());
    }

    /// Save-As (`x-create: 1`) resolves only the PARENT, because the file it is
    /// about to write does not exist yet and never resolves.
    #[test]
    fn resolve_parent_admits_a_new_leaf_but_not_a_new_directory() {
        let (_d, state) = fixture();
        let v = state.vault().expect("vault");
        let (parent, name) = resolve_parent(&v, "Projects/New.md").expect("parent");
        assert_eq!(name, "New.md");
        assert!(parent.ends_with("Projects"));

        let (parent, name) = resolve_parent(&v, "Top2.md").expect("root parent");
        assert_eq!(name, "Top2.md");
        assert_eq!(parent, v.root());

        // The intermediate directory has to exist in the arena: a Save-As never
        // creates a folder tree on the way.
        assert!(resolve_parent(&v, "Nope/New.md").is_err());
        // And it is still the arena doing the refusing for traversal.
        assert!(resolve_parent(&v, "../New.md").is_err());
    }

    #[test]
    fn rel_of_and_join_rel_are_inverses_at_the_root_and_below() {
        let root = Path::new("/vault");
        assert_eq!(rel_of(root, Path::new("/vault/a.md")).as_deref(), Some("a.md"));
        assert_eq!(rel_of(root, Path::new("/vault/p/a.md")).as_deref(), Some("p/a.md"));
        // The root itself has no relative form; `None` is what stops
        // `nc://note-external-change` firing with an empty path.
        assert_eq!(rel_of(root, Path::new("/vault")), None);
        assert_eq!(rel_of(root, Path::new("/elsewhere/a.md")), None);

        assert_eq!(join_rel("", "a.md"), "a.md");
        assert_eq!(join_rel("p", "a.md"), "p/a.md");
        assert_eq!(join_rel("p/q", "a.md"), "p/q/a.md");
    }

    /* ── repair (§3.5) ────────────────────────────────────────────────────── */

    /// The repair path sees a file created behind the arena's back, and it
    /// publishes a NEW epoch when it does.
    #[test]
    fn repair_picks_up_an_external_create_and_bumps_the_epoch() {
        let (dir, state) = fixture();
        let before = state.epoch();
        let v = state.vault().expect("vault");
        assert!(resolve(&v, "Late.md").is_err());

        fs::write(dir.path().join("Late.md"), "# late\n").expect("write");
        let epoch = repair(&state).expect("repair");
        assert!(epoch > before, "{epoch} must be newer than {before}");

        let v = state.vault().expect("vault");
        assert!(resolve(&v, "Late.md").is_ok());
        assert_eq!(v.read().epoch, epoch, "the arena carries the published epoch");
    }

    /// A repair rebuilds the arena in place, so the `Arc<Vault>` IDENTITY does
    /// not change — which is what keeps an in-flight search's `Arc<VaultSnapshot>`
    /// alive and unrewritten (§4.2's lifetime rule).
    #[test]
    fn repair_keeps_the_vault_arc_and_invalidates_the_snapshot_by_epoch() {
        let (dir, state) = fixture();
        let v1 = state.vault().expect("vault");
        let snap1 = v1.snapshot();
        assert_eq!(snap1.files.len(), 3);

        fs::write(dir.path().join("Four.md"), "x").expect("write");
        repair(&state).expect("repair");

        let v2 = state.vault().expect("vault");
        assert!(Arc::ptr_eq(&v1, &v2), "the Vault Arc is reused, not replaced");
        // The OLD snapshot is still valid and still says 3 — nothing rewrote it
        // under a holder.
        assert_eq!(snap1.files.len(), 3);
        assert_eq!(v2.snapshot().files.len(), 4, "a new epoch rebuilds the cache");
    }

    /* ── command 25: the secret-note set ────────────────────────────────── */

    /// The marker lists the file; plain notes and non-notes do not; a repeat
    /// call with no changes answers the same (the mtime memo, not a re-read).
    #[test]
    fn secret_notes_lists_marked_files_and_nothing_else() {
        let (dir, state) = fixture();
        let root = dir.path();
        fs::write(root.join("Creds.md"), "---\ncairn-type: secrets\n---\n").expect("write");
        fs::write(root.join("Projects/Keys.md"), "---\ncairn-type: secrets\n---\n").expect("write");
        fs::write(root.join("Plain.md"), "# plain\n").expect("write");
        fs::write(root.join("notes.txt"), "cairn-type: secrets\n").expect("write");
        repair(&state).expect("repair");

        let v = state.vault().expect("vault");
        let mut got = v.secret_notes();
        got.sort();
        assert_eq!(got, vec!["Creds.md".to_string(), "Projects/Keys.md".to_string()]);
        // Unchanged: the memo answers, no head is re-opened.
        let mut again = v.secret_notes();
        again.sort();
        assert_eq!(again, got);
    }

    /// Unmarking is seen once the mtime moves and a repair publishes the new
    /// epoch; deleting the file prunes it rather than sticking.
    #[test]
    fn secret_notes_forgets_unmarked_and_deleted_files() {
        let (dir, state) = fixture();
        let root = dir.path();
        let creds = root.join("Creds.md");
        fs::write(&creds, "---\ncairn-type: secrets\n---\n").expect("write");
        repair(&state).expect("repair");

        let v = state.vault().expect("vault");
        assert_eq!(v.secret_notes(), vec!["Creds.md".to_string()]);

        // Rewrite without the marker and move the mtime past the arena's
        // one-second grain, or the memo cannot tell anything changed.
        fs::write(&creds, "# now plain\n").expect("write");
        let f = std::fs::OpenOptions::new().write(true).open(&creds).expect("open");
        f.set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(2))
            .expect("mtime");
        drop(f);
        repair(&state).expect("repair");
        assert_eq!(v.secret_notes(), Vec::<String>::new());

        // And back, then deleted: the set prunes rather than pointing at a
        // path no snapshot holds any more.
        fs::write(&creds, "---\ncairn-type: secrets\n---\n").expect("write");
        repair(&state).expect("repair");
        assert_eq!(v.secret_notes(), vec!["Creds.md".to_string()]);
        fs::remove_file(&creds).expect("remove");
        repair(&state).expect("repair");
        assert_eq!(v.secret_notes(), Vec::<String>::new());
    }

    /// A repair over a vault whose root has gone is `None`, and it must NOT
    /// destroy the arena that is still serving the UI.
    #[test]
    fn repair_of_a_vanished_root_keeps_the_last_good_arena() {
        let (dir, state) = fixture();
        let epoch_before = state.epoch();
        let path = dir.path().to_path_buf();
        drop(dir);
        assert!(!path.exists());

        assert_eq!(repair(&state), None);
        let v = state.vault().expect("the vault is still there");
        assert!(resolve(&v, "Top.md").is_ok(), "the last good arena still answers");
        assert_eq!(state.epoch(), epoch_before, "a failed walk burns no epoch");
    }

    /* ── M54: the open-note bookkeeping ───────────────────────────────────── */

    #[test]
    fn m54_rename_follows_the_open_note_and_the_folder_above_it() {
        let state = AppState::new();

        state.set_open_note(Some("Projects/Plan.md".into()));
        reparent_open_note(&state, "Projects/Plan.md", "Projects/Roadmap.md", false);
        assert!(state.open_note_is("Projects/Roadmap.md"));

        // Renaming the FOLDER the open note lives in.  This is the half that is
        // easy to miss and silent when missed.
        state.set_open_note(Some("Projects/2026/Q1.md".into()));
        reparent_open_note(&state, "Projects", "Archive", true);
        assert!(state.open_note_is("Archive/2026/Q1.md"));

        // An unrelated rename leaves it alone.
        state.set_open_note(Some("Top.md".into()));
        reparent_open_note(&state, "Projects", "Archive", true);
        assert!(state.open_note_is("Top.md"));
    }

    /// Renaming `Work` must not drag `Workshop/a.md` with it: the prefix test is
    /// on `"{path}/"`, never on `path`.
    #[test]
    fn m54_a_sibling_with_a_shared_prefix_is_not_dragged_along() {
        let state = AppState::new();
        state.set_open_note(Some("Workshop/a.md".into()));
        reparent_open_note(&state, "Work", "Job", true);
        assert!(state.open_note_is("Workshop/a.md"));

        state.set_open_note(Some("Workshop/a.md".into()));
        clear_open_note_under(&state, "Work", true);
        assert!(state.open_note_is("Workshop/a.md"));
    }

    /// B17/M54: delete CLEARS it, including a delete of the folder above.  A
    /// stale `open_note` after a delete is what lets an autosave resurrect the
    /// file the user just deleted.
    #[test]
    fn m54_delete_clears_the_open_note_and_everything_under_a_deleted_folder() {
        let state = AppState::new();

        state.set_open_note(Some("Top.md".into()));
        clear_open_note_under(&state, "Top.md", false);
        assert!(state.open_note.lock().expect("lock").is_none());

        state.set_open_note(Some("Projects/2026/Q1.md".into()));
        clear_open_note_under(&state, "Projects", true);
        assert!(state.open_note.lock().expect("lock").is_none());

        state.set_open_note(Some("Top.md".into()));
        clear_open_note_under(&state, "Projects", true);
        assert!(state.open_note_is("Top.md"));
    }

    /// Opening a note is what makes it THE open note — that is the only writer
    /// besides `save_ui_state`, and §1.4 filters `nc://note-external-change` by
    /// it.
    #[test]
    fn read_note_returns_the_frame_and_claims_the_open_note() {
        let (_d, state) = fixture();
        let framed = read_note(&state, "Projects/Plan.md").expect("read");
        let (_mtime, flags, body) = crate::note_frame::decode_note(&framed).expect("decode");
        assert_eq!(body, b"# plan\n");
        assert_eq!(flags, 0);
        assert!(state.open_note_is("Projects/Plan.md"));

        // A directory is `notFound`, never a frame full of nothing.
        assert!(read_note(&state, "Projects").is_err());
        // …and the failed read did not steal the open note.
        assert!(state.open_note_is("Projects/Plan.md"));
    }

    /* ── §7.5 / §1.5: the three vault states ──────────────────────────────── */

    /// M65: `none` and `loading` are DIFFERENT states with different UI.
    /// Collapsing them into `Option<VaultInfo>` is what left a fresh install
    /// waiting forever behind an empty sidebar with no prompt.
    #[test]
    fn current_vault_distinguishes_none_from_loading_from_open() {
        let state = AppState::new();
        assert!(matches!(current_vault(&state), VaultState::None));

        state.loading.store(true, Ordering::SeqCst);
        assert!(matches!(current_vault(&state), VaultState::Loading));
        state.loading.store(false, Ordering::SeqCst);

        let (_d, open) = fixture();
        match current_vault(&open) {
            VaultState::Open { info } => {
                assert_eq!(info.n_notes, 3);
                assert_eq!(info.n_dirs, 2);
                assert!(!info.truncated);
                assert!(!info.truncated_depth);
                // No watcher in the fixture, so the degraded banner is drawn.
                assert!(!info.watching);
            }
            other => panic!("expected Open, got {other:?}"),
        }
    }

    /* ── M69 ──────────────────────────────────────────────────────────────── */

    /// A plain overwrite updates ONE node's `mtime` in place rather than
    /// re-walking, which is what keeps a 21.8 ms walk off every autosave.
    #[test]
    fn touch_mtime_updates_one_node_and_nothing_else() {
        let (_d, state) = fixture();
        let v = state.vault().expect("vault");
        let other_before = {
            let t = v.read();
            let id = t.resolve("Top.md").expect("Top.md");
            t.get(id).expect("node").mtime
        };

        touch_mtime(&v, "Projects/Plan.md", 1_700_000_000_123);
        let t = v.read();
        let id = t.resolve("Projects/Plan.md").expect("Plan.md");
        // Whole seconds: `Node.mtime` is a u32 of them, so the 123 ms is
        // truncated and that is exact, not lossy-by-accident.
        assert_eq!(t.get(id).expect("node").mtime, 1_700_000_000);
        let other = t.resolve("Top.md").expect("Top.md");
        assert_eq!(t.get(other).expect("node").mtime, other_before);
    }

    /* ── §4.3 ─────────────────────────────────────────────────────────────── */

    /// The switch order is a data-loss rule (M30): the old vault is taken OUT of
    /// the slot and dropped OUTSIDE the lock.  `take_vault` is the function that
    /// guarantees it; this pins that `open_vault_blocking` uses it rather than
    /// assigning over the slot under the write guard.
    #[test]
    fn taking_the_vault_leaves_the_slot_empty_and_hands_back_the_last_arc() {
        let (_d, state) = fixture();
        let held = state.vault().expect("vault");
        let taken = tree::take_vault(&state.vault).expect("taken");
        assert!(Arc::ptr_eq(&held, &taken));
        assert!(state.vault().is_none());
        assert!(matches!(current_vault(&state), VaultState::None));
    }

    /// §4.3: search is cancelled BEFORE the outgoing vault is dropped, and a
    /// cancel never invents a generation number — the frontend owns it.
    #[test]
    fn cancel_all_flags_live_jobs_without_touching_the_frontends_number() {
        let state = AppState::new();
        search_cancel(&state, 7);
        assert_eq!(state.search.generation(), 7);
        state.search.cancel_all();
        assert_eq!(state.search.generation(), 7, "cancel_all bumps nothing");
        assert_eq!(state.search.live_jobs(), 0, "empty at rest");
    }

    /* ── §7.6 ─────────────────────────────────────────────────────────────── */

    /* ── §0.30 E70 — command 21, `forget_vault` ──────────────────────────── */

    /// The whole edit, and the two things it must NOT do.
    ///
    /// **It drops the `recents` entry and the per-vault `vaults` key together**,
    /// and the second one is not written here: `sanitise()` prunes `vaults` to
    /// `recents` plus the current vault before every write, so removing the
    /// recent is the whole edit and the expansion set follows it out. Asserting
    /// it from the file — after a real `flush_now` and a real reload — is what
    /// makes that a fact rather than a comment.
    ///
    /// **It leaves the FOLDER ON DISK alone.** Obsidian's `vault-remove` deletes
    /// a list entry, not a directory, and a user who reads "Close" as "delete my
    /// notes" would be right to be angry. The directory and its note are checked
    /// after the call.
    #[test]
    fn forget_vault_drops_the_recent_and_its_view_state_and_touches_no_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let gone = dir.path().join("gone");
        std::fs::create_dir_all(&gone).expect("mkdir");
        std::fs::write(gone.join("Note.md"), b"# keep me\n").expect("write");
        let gone_key = gone.to_string_lossy().into_owned();

        let state = AppState::new();
        let prefs_path = dir.path().join("state.json");
        state.init_prefs(prefs_path.clone());
        let prefs = state.prefs().expect("prefs");
        prefs.edit(|s| {
            s.touch_vault("/kept");
            s.touch_vault(&gone_key);
            // Give the doomed vault some view state, so its `vaults` key is real.
            s.apply(Some(&gone_key), &UiPatch { sort: Some(2), ..UiPatch::default() });
        });
        prefs.flush_now().expect("flush");
        assert_eq!(prefs.snapshot().recents.len(), 2);

        forget_vault(&state, &gone_key).expect("forget");

        // In memory…
        let snap = prefs.snapshot();
        assert_eq!(snap.recents, vec!["/kept".to_string()]);
        assert!(!snap.vaults.contains_key(&gone_key), "the per-vault key outlived its recent");
        // …and `vault` — the root the NEXT LAUNCH reopens — no longer names it.
        // `touch_vault` set it, which is §7.3 case 8's shape exactly: the folder
        // is gone, nothing is open, and `state.json` still points at it. Without
        // this the app reopens the vault the user just removed, AND `sanitise`
        // keeps its `vaults` key, because it spares the current vault by name.
        assert_eq!(snap.vault, None, "state.json still reopens the forgotten vault");

        // …and on disk, because the point of `flush_now` is that a crash cannot
        // undo a removal the user asked for.
        let reloaded = PrefsStore::load(prefs_path).snapshot();
        assert_eq!(reloaded.recents, vec!["/kept".to_string()]);
        assert!(!reloaded.vaults.contains_key(&gone_key));
        assert_eq!(reloaded.vault, None);

        // …and the vault itself is untouched. THIS is the assertion that matters
        // most to a user reading the word "Close".
        assert!(gone.is_dir(), "forget_vault removed the folder");
        assert_eq!(std::fs::read(gone.join("Note.md")).expect("read"), b"# keep me\n");
    }

    /// Obsidian REFUSES to remove a vault a window has open (`"Can't remove a
    /// currently open vault."`), and so does this. The vault bar only draws the
    /// control on a non-active row, so the refusal is the guard BEHIND the
    /// affordance — which is exactly the kind of rule that rots unasserted.
    #[test]
    fn forget_vault_refuses_the_open_vault_and_changes_nothing() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("open");
        std::fs::create_dir_all(&root).expect("mkdir");
        let key = root.to_string_lossy().into_owned();

        let state = AppState::new();
        state.init_prefs(dir.path().join("state.json"));
        let prefs = state.prefs().expect("prefs");
        prefs.edit(|s| s.touch_vault(&key));
        *state.vault.write().expect("lock") =
            Some(std::sync::Arc::new(crate::tree::Vault::new(crate::tree::VaultTree::new(
                root.clone(),
                crate::tree::SortMode::NameAsc,
                1,
            ))));

        let err = forget_vault(&state, &key).expect_err("the open vault was forgotten");
        assert!(
            matches!(err, VaultError::InvalidPath { .. }),
            "a refusal must be §1.5's invalidPath, not an io or a panic: {err:?}"
        );
        assert_eq!(prefs.snapshot().recents, vec![key], "a refused removal still edited the list");
    }

    /// User ruling, 2026-09-14: a launch drops every tracked vault whose folder
    /// is gone, and clears `vault` when it names one — then rewrites
    /// `state.json`, so no `(missing)` row survives a restart. The folder on
    /// disk is not touched (there is nothing to touch), and a vault that is
    /// still there keeps its place AND its per-vault key.
    #[test]
    fn startup_prune_removes_missing_vaults_and_clears_a_missing_current() {
        let dir = tempfile::tempdir().expect("tempdir");
        let kept = dir.path().join("kept");
        std::fs::create_dir_all(&kept).expect("mkdir");
        let kept_key = kept.to_string_lossy().into_owned();
        let gone_key = dir.path().join("gone").to_string_lossy().into_owned();
        let prefs_path = dir.path().join("state.json");

        let state = AppState::new();
        state.init_prefs(prefs_path.clone());
        let prefs = state.prefs().expect("prefs");
        prefs.edit(|s| {
            s.touch_vault(&kept_key);
            s.touch_vault(&gone_key);
            // `touch_vault` puts the last touch first AND names it current, so
            // restore the order this case is about: kept first, gone current.
            s.recents = vec![kept_key.clone(), gone_key.clone()];
            s.vault = Some(gone_key.clone());
            s.apply(Some(&kept_key), &UiPatch { sort: Some(2), ..UiPatch::default() });
            s.apply(Some(&gone_key), &UiPatch { sort: Some(1), ..UiPatch::default() });
        });
        prefs.flush_now().expect("flush");

        assert!(prune_missing_vaults(&state), "nothing was pruned");

        let snap = prefs.snapshot();
        assert_eq!(snap.recents, vec![kept_key.clone()]);
        assert_eq!(snap.vault, None, "state.json still reopens the missing vault");
        assert!(snap.vaults.contains_key(&kept_key), "the kept vault lost its view state");
        assert!(!snap.vaults.contains_key(&gone_key), "the missing vault kept its view state");

        let reloaded = PrefsStore::load(prefs_path).snapshot();
        assert_eq!(reloaded.recents, vec![kept_key]);
        assert_eq!(reloaded.vault, None);
        assert!(!reloaded.vaults.contains_key(&gone_key));

        // And a launch with nothing missing changes nothing and reports so.
        assert!(!prune_missing_vaults(&state), "a clean launch reported a prune");
    }

    /// With no config directory the app must still run: `prefs()` is `None`,
    /// every persistence call is a no-op, and nothing panics.  §7.6 says a bad
    /// state file is never a startup failure; no state file at all is the same
    /// rule.
    #[test]
    fn every_persistence_path_degrades_to_a_no_op_without_prefs() {
        let state = AppState::new();
        assert!(state.prefs().is_none());
        assert!(recent_vaults(&state).is_empty());
        save_ui_state(&state, &UiPatch { sort: Some(2), ..UiPatch::default() });
        flush_prefs(&state);
    }

    /// `save_ui_state` keeps `AppState.open_note` and the persisted `last_note`
    /// as ONE fact.  The outer `Option` is "the patch mentioned it", the inner
    /// one is "there is no open note now" (§1.5) — collapsing them loses the
    /// ability to close the last note and have that survive a restart.
    #[test]
    fn save_ui_state_syncs_the_open_note_through_both_layers_of_the_option() {
        let dir = tempfile::tempdir().expect("tempdir");
        let state = AppState::new();
        state.init_prefs(dir.path().join("state.json"));
        state.set_open_note(Some("Top.md".into()));

        // Outer None: the patch did not mention it, so nothing changes.
        save_ui_state(&state, &UiPatch { sort: Some(1), ..UiPatch::default() });
        assert!(state.open_note_is("Top.md"));

        // Inner Some: a different note is now open.
        save_ui_state(
            &state,
            &UiPatch { last_note: Some(Some("Other.md".into())), ..UiPatch::default() },
        );
        assert!(state.open_note_is("Other.md"));

        // Inner None: the last note was CLOSED, and that must survive a restart.
        save_ui_state(&state, &UiPatch { last_note: Some(None), ..UiPatch::default() });
        assert!(state.open_note.lock().expect("lock").is_none());
    }

    /* ── §7.6.1 (errata 3, Z2) — THE READ PATH, END TO END ───────────────── */

    /// §7.6.1's mandatory test, stated as the thing the user actually does:
    /// **expand two folders, scroll the sidebar, quit, relaunch.**
    ///
    /// It is deliberately NOT a call to `view_state` — that would only prove the
    /// reader reads.  It goes through the real seam in both directions: the
    /// write is `save_ui_state` (which derives its key from `state.vault()`),
    /// the quit is `flush_prefs` (bytes on disk, not a debounce timer), the
    /// relaunch is a SECOND `AppState` with its own `PrefsStore` loaded from
    /// those bytes, and the read is `current_vault`, which is what the frontend
    /// awaits at boot.  A key that differs by one character between the two ends
    /// makes the whole ruling silently inert with no error anywhere, which is
    /// precisely the failure mode Z2 exists to fix — so a defaulted `([], 0.0)`
    /// here is a FAILURE, not an "unset".
    #[test]
    fn expansion_and_scroll_survive_a_quit_and_relaunch() {
        let dir = tempfile::tempdir().expect("tempdir");
        let vault_root = dir.path().join("Vault");
        fs::create_dir(&vault_root).expect("mkdir");
        fs::create_dir(vault_root.join("Projects")).expect("mkdir");
        fs::create_dir(vault_root.join("Projects/2026")).expect("mkdir");
        fs::write(vault_root.join("Projects/2026/Q1.md"), "# q1\n").expect("write");
        let state_json = dir.path().join("state.json");

        // A launch: canonical root, the vault in the slot, prefs over the file.
        let launch = || {
            let state = AppState::new();
            state.init_prefs(state_json.clone());
            let root = fsops::canonical_root(&vault_root).expect("canonical root");
            let epoch = state.next_epoch();
            let (vault, _) = vault::open_at(&root, SortMode::default(), epoch).expect("walk");
            *state.vault.write().expect("vault lock") = Some(Arc::new(vault));
            // The recents bookkeeping `open_vault_blocking` does, and it is
            // LOAD-BEARING here, not scenery: §7.6 prunes the `vaults` map to
            // the 8 entries in `recents`, so a per-vault record whose vault was
            // never touched is dropped by the very flush that was meant to save
            // it.  Omitting this is how the first draft of this test failed.
            let key = root.to_string_lossy().into_owned();
            if let Some(p) = state.prefs() {
                p.edit(|st| {
                    st.touch_vault(&key);
                    st.vault = Some(key.clone());
                });
            }
            state
        };

        // ── session 1: expand two folders, scroll the sidebar, quit ────────
        let first = launch();
        save_ui_state(
            &first,
            &UiPatch {
                expanded: Some(vec!["Projects".into(), "Projects/2026".into()]),
                scroll_top: Some(432.0),
                ..UiPatch::default()
            },
        );
        flush_prefs(&first); // the quit path (§1.6): bytes on disk, not a timer
        drop(first);

        // The bytes really are there, under the one spelling.
        let on_disk = fs::read_to_string(&state_json).expect("state.json");
        let key = fsops::canonical_root(&vault_root)
            .expect("canonical root")
            .to_string_lossy()
            .into_owned();
        assert!(on_disk.contains(&key), "state.json is not keyed by the vault root: {on_disk}");

        // ── session 2: relaunch, and read what the frontend reads ──────────
        let second = launch();
        let VaultState::Open { info } = current_vault(&second) else {
            panic!("expected an open vault on relaunch")
        };

        assert_eq!(
            info.expanded,
            vec!["Projects".to_string(), "Projects/2026".to_string()],
            "folder expansion did not survive the restart — this is the Z2 regression"
        );
        assert!(
            (info.scroll_top - 432.0).abs() < f64::EPSILON,
            "sidebar scroll did not survive the restart: {}",
            info.scroll_top
        );
        // §7.6.1's key agreement, restated where it bites: the string the
        // frontend gets back IS the string the write was filed under.
        assert_eq!(info.root, key);
    }

    /// The other two `vault::info` call sites report the same persisted state,
    /// so a refresh cannot silently hand the frontend `([], 0.0)` and undo a
    /// restore.  (Whether it is APPLIED on a refresh is the frontend's rule —
    /// §7.6.1's switched-only clause — and is tested in `tests/frontend/`.)
    #[test]
    fn a_second_read_of_the_same_vault_reports_the_same_view_state() {
        let (dir, state) = fixture();
        state.init_prefs(dir.path().join("state.json"));
        save_ui_state(
            &state,
            &UiPatch {
                expanded: Some(vec!["Projects".into()]),
                scroll_top: Some(96.0),
                ..UiPatch::default()
            },
        );

        for _ in 0..3 {
            let VaultState::Open { info } = current_vault(&state) else { panic!("open") };
            assert_eq!(info.expanded, vec!["Projects".to_string()]);
            assert!((info.scroll_top - 96.0).abs() < f64::EPSILON);
        }
    }

    /// With no prefs store — a test `AppState`, or a machine with no config
    /// directory — the read path degrades to §7.6.1's stated fallback rather
    /// than panicking on an unwrapped `Option`.
    #[test]
    fn the_read_path_falls_back_to_the_defaults_with_no_prefs_store() {
        let (_d, state) = fixture();
        assert!(state.prefs().is_none());
        let VaultState::Open { info } = current_vault(&state) else { panic!("open") };
        assert!(info.expanded.is_empty());
        assert!((info.scroll_top - 0.0).abs() < f64::EPSILON);
    }

    /// `init_prefs` is idempotent, because `setup()` and a test can both reach
    /// it and a second `PrefsStore` over the same file would be a second
    /// debounce timer racing the first.
    #[test]
    fn init_prefs_is_idempotent() {
        let dir = tempfile::tempdir().expect("tempdir");
        let state = AppState::new();
        let a = state.init_prefs(dir.path().join("state.json"));
        let b = state.init_prefs(dir.path().join("elsewhere.json"));
        assert!(Arc::ptr_eq(&a, &b));
        assert_eq!(a.path(), dir.path().join("state.json"));
    }

    /* ── §1.6 ─────────────────────────────────────────────────────────────── */

    /// The watchdog is disarmed by EITHER answer, and only by an answer.  This
    /// is the token arithmetic `begin_close` and `confirm_close` share; the
    /// emit/exit half is not reachable from here.
    #[test]
    fn either_answer_disarms_the_close_watchdog() {
        let state = AppState::new();
        let armed = state.close_token.fetch_add(1, Ordering::SeqCst) + 1;

        // "Keep editing": the token moves, so the sleeping watchdog returns.
        state.close_token.fetch_add(1, Ordering::SeqCst);
        assert_ne!(state.close_token.load(Ordering::SeqCst), armed);
        assert!(!state.close_ok.load(Ordering::SeqCst), "a refusal never authorises the close");

        // A second close is a second arming, and it is a different token.
        let rearmed = state.close_token.fetch_add(1, Ordering::SeqCst) + 1;
        assert_ne!(rearmed, armed);
    }

    /* ── test seams: a hook inside `repair`, and an `AppCtx` with no shell ── */

    thread_local! {
        /// Runs on the repairing thread between `repair`'s walk and its
        /// install.  Thread-local, so no other test's repair ever meets it.
        static AFTER_WALK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
            std::cell::RefCell::new(None);
    }

    pub(super) fn run_after_walk_hook() {
        if let Some(f) = AFTER_WALK.with(|h| h.borrow_mut().take()) {
            f();
        }
    }

    /// Park this thread's next `repair` after its walk: `walked` fires, then it
    /// waits for `release`.
    fn park_next_repair_after_walk(
        walked: std::sync::mpsc::Sender<()>,
        release: std::sync::mpsc::Receiver<()>,
    ) {
        AFTER_WALK.with(|h| {
            *h.borrow_mut() = Some(Box::new(move || {
                walked.send(()).expect("walked");
                let _ = release.recv();
            }));
        });
    }

    #[derive(Clone)]
    struct TestCtx {
        state: Arc<AppState>,
        quits: Arc<Mutex<Vec<(i32, Instant)>>>,
    }

    impl TestCtx {
        fn new(state: Arc<AppState>) -> Self {
            Self { state, quits: Arc::new(Mutex::new(Vec::new())) }
        }
        fn quits(&self) -> Vec<(i32, Instant)> {
            self.quits.lock().expect("quits").clone()
        }
        fn wait_for_quit(&self, limit: Duration) -> Option<(i32, Instant)> {
            let until = Instant::now() + limit;
            while Instant::now() < until {
                if let Some(q) = self.quits().first() {
                    return Some(*q);
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            None
        }
    }

    impl AppCtx for TestCtx {
        fn emit_event<S: serde::Serialize + Clone>(&self, _event: &str, _payload: S) {}
        fn app_state(&self) -> &AppState {
            &self.state
        }
        fn quit(&self, code: i32) {
            self.quits.lock().expect("quits").push((code, Instant::now()));
        }
    }

    /* ── §3.5: repairs are serialised ─────────────────────────────────────── */

    /// Repair A walks, then a note is created and repair B runs, then A tries
    /// to install.  A's walk predates the create, so if A installs last the
    /// note is missing from the arena and nothing heals it (the create's own
    /// events are suppressed as self-writes).  The hook parks A at exactly
    /// that point, so the interleaving is forced rather than hoped for.
    #[test]
    fn a_repair_that_walked_before_a_create_cannot_install_over_the_repair_after_it() {
        let (dir, state) = fixture();
        let st = &state;
        let (walked_tx, walked_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        std::thread::scope(|s| {
            let a = s.spawn(move || {
                park_next_repair_after_walk(walked_tx, release_rx);
                repair(st)
            });
            walked_rx.recv_timeout(Duration::from_secs(10)).expect("repair A never walked");

            fs::write(dir.path().join("Late.md"), "# late\n").expect("write");
            let (b_done_tx, b_done_rx) = std::sync::mpsc::channel();
            let b = s.spawn(move || {
                let r = repair(st);
                let _ = b_done_tx.send(());
                r
            });
            // Unserialised, B installs here; serialised, it is waiting for A.
            let _ = b_done_rx.recv_timeout(Duration::from_millis(500));
            release_tx.send(()).expect("release");
            a.join().expect("join A").expect("repair A");
            b.join().expect("join B").expect("repair B");
        });

        let v = state.vault().expect("vault");
        assert!(
            resolve(&v, "Late.md").is_ok(),
            "a walk that predates the create installed over the repair that saw it"
        );
        assert_eq!(v.read().epoch, state.epoch(), "the arena is not carrying the newest epoch");
    }

    /// `set_sort` re-sorts in place.  A repair already walking with the old
    /// sort must not install its tree over that and undo the user's choice.
    #[test]
    fn a_sort_change_made_during_a_repair_walk_survives_the_install() {
        let (_dir, state) = fixture();
        let state = Arc::new(state);
        let ctx = TestCtx::new(Arc::clone(&state));
        let st = &*state;
        let ctx = &ctx;
        assert_eq!(st.vault().expect("vault").read().sort, SortMode::NameAsc);
        let (walked_tx, walked_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        std::thread::scope(|s| {
            let a = s.spawn(move || {
                park_next_repair_after_walk(walked_tx, release_rx);
                repair(st)
            });
            walked_rx.recv_timeout(Duration::from_secs(10)).expect("repair A never walked");

            let (b_done_tx, b_done_rx) = std::sync::mpsc::channel();
            let b = s.spawn(move || {
                let r = set_sort(ctx, st, SortMode::NameDesc as u8);
                let _ = b_done_tx.send(());
                r
            });
            let _ = b_done_rx.recv_timeout(Duration::from_millis(500));
            release_tx.send(()).expect("release");
            a.join().expect("join A").expect("repair A");
            b.join().expect("join B").expect("set_sort");
        });

        let v = state.vault().expect("vault");
        assert_eq!(v.read().sort, SortMode::NameDesc, "a repair installed the old sort over set_sort");
        assert_eq!(v.read().epoch, state.epoch());
    }

    /* ── the recents probe: bounded, and only "not found" is gone ─────────── */

    #[test]
    fn only_not_found_classifies_a_root_as_gone() {
        use std::io::{Error, ErrorKind};
        assert_eq!(classify_dir_stat(Ok(true)), DirProbe::Dir);
        assert_eq!(classify_dir_stat(Ok(false)), DirProbe::Gone, "a file where the vault was");
        assert_eq!(classify_dir_stat(Err(Error::from(ErrorKind::NotFound))), DirProbe::Gone);
        assert_eq!(classify_dir_stat(Err(Error::from_raw_os_error(libc::ENOTDIR))), DirProbe::Gone);
        for errno in [libc::EACCES, libc::EPERM, libc::EIO, libc::ETIMEDOUT, libc::ESTALE] {
            assert_eq!(
                classify_dir_stat(Err(Error::from_raw_os_error(errno))),
                DirProbe::Unknown,
                "errno {errno} is not evidence that the vault is gone"
            );
        }
    }

    /// A stat that never comes back — a hard NFS mount whose server is gone —
    /// costs the deadline and no more, and while it is still stuck the next
    /// probe neither waits for it nor starts a second thread on it.
    #[test]
    fn a_stat_that_does_not_answer_is_unknown_at_the_deadline_and_is_not_restarted() {
        let dir = tempfile::tempdir().expect("tempdir");
        let real = dir.path().join("real");
        fs::create_dir(&real).expect("mkdir");
        let slow = dir.path().join("hung-mount");
        fs::create_dir(&slow).expect("mkdir");
        let paths: Vec<String> = [real, dir.path().join("missing"), slow]
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect();

        let slow_calls = Arc::new(AtomicUsize::new(0));
        let calls = Arc::clone(&slow_calls);
        let stat = move |p: &Path| {
            if p.ends_with("hung-mount") {
                calls.fetch_add(1, Ordering::SeqCst);
                std::thread::sleep(Duration::from_secs(4));
            }
            std::fs::metadata(p).map(|m| m.is_dir())
        };

        let t = Instant::now();
        let got = probe_dirs_with(&paths, Duration::from_millis(300), stat.clone());
        let took = t.elapsed();
        assert_eq!(got, vec![DirProbe::Dir, DirProbe::Gone, DirProbe::Unknown]);
        assert!(took < Duration::from_millis(1_500), "the probe waited {took:?} on a hung stat");

        let t = Instant::now();
        let again = probe_dirs_with(&paths, Duration::from_millis(300), stat);
        assert_eq!(again, vec![DirProbe::Dir, DirProbe::Gone, DirProbe::Unknown]);
        assert!(t.elapsed() < Duration::from_millis(1_500));
        assert_eq!(slow_calls.load(Ordering::SeqCst), 1, "a root still stuck was stat'ed again");
    }

    /// A REAL permission error on a vault's root: the folder is there, the
    /// stat fails with EACCES.  The launch prune must keep it — with its view
    /// state — and the switcher must not offer it as openable.
    #[test]
    fn startup_prune_keeps_a_vault_it_cannot_stat_for_a_reason_other_than_not_found() {
        use std::os::unix::fs::PermissionsExt;
        struct Unlock(PathBuf);
        impl Drop for Unlock {
            fn drop(&mut self) {
                let _ = fs::set_permissions(&self.0, fs::Permissions::from_mode(0o755));
            }
        }

        let dir = tempfile::tempdir().expect("tempdir");
        let kept = dir.path().join("kept");
        fs::create_dir(&kept).expect("mkdir");
        let locked = dir.path().join("locked");
        let behind = locked.join("vault");
        fs::create_dir_all(&behind).expect("mkdir");
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).expect("chmod");
        let _unlock = Unlock(locked.clone());
        if fs::metadata(&behind).is_ok() {
            eprintln!("skipped: this user can stat through a 0o000 directory (root?)");
            return;
        }
        let kept_key = kept.to_string_lossy().into_owned();
        let behind_key = behind.to_string_lossy().into_owned();

        let state = AppState::new();
        state.init_prefs(dir.path().join("state.json"));
        let prefs = state.prefs().expect("prefs");
        prefs.edit(|s| {
            s.recents = vec![kept_key.clone(), behind_key.clone()];
            s.vault = Some(behind_key.clone());
            s.apply(Some(&behind_key), &UiPatch { sort: Some(2), ..UiPatch::default() });
        });
        prefs.flush_now().expect("flush");

        assert!(!prune_missing_vaults(&state), "an unreadable vault was pruned as missing");
        let snap = prefs.snapshot();
        assert_eq!(snap.recents, vec![kept_key.clone(), behind_key.clone()]);
        assert_eq!(snap.vault.as_deref(), Some(behind_key.as_str()));
        assert_eq!(snap.ui(&behind_key).map(|u| u.sort), Some(2), "its view state was dropped");

        let rows = recent_vaults(&state);
        let exists = |k: &str| rows.iter().find(|r| r.root == k).map(|r| r.exists);
        assert_eq!(exists(&kept_key), Some(true));
        assert_eq!(exists(&behind_key), Some(false), "an unreachable vault was offered as openable");
    }

    /* ── §1.6: the watchdog and vault writes in flight ───────────────────── */

    /// A frontend whose flush is a slow `write_note` has not hung.  While that
    /// write is in flight the watchdog must wait, and once it ends the watchdog
    /// still quits `CLOSE_DEADLINE_MS` later if nobody answers.
    #[test]
    fn the_close_watchdog_waits_out_a_vault_write_in_flight() {
        let state = Arc::new(AppState::new());
        let ctx = TestCtx::new(Arc::clone(&state));
        let write = WriteInFlight::new(&state);
        assert!(begin_close(&ctx));

        std::thread::sleep(Duration::from_millis(CLOSE_DEADLINE_MS + 700));
        assert!(ctx.quits().is_empty(), "the watchdog quit under a vault write in flight");

        let ended = Instant::now();
        drop(write);
        let (code, at) = ctx.wait_for_quit(Duration::from_secs(5)).expect("it never quit after the write");
        assert_eq!(code, 0);
        let after = at.duration_since(ended);
        assert!(
            after >= Duration::from_millis(CLOSE_DEADLINE_MS - 100)
                && after <= Duration::from_millis(CLOSE_DEADLINE_MS + 1_000),
            "expected the quit ~{CLOSE_DEADLINE_MS} ms after the write ended, got {after:?}"
        );
        assert_eq!(ctx.quits().len(), 1);
    }

    /// With nothing in flight the backstop is unchanged: ~2,000 ms after arming.
    #[test]
    fn with_no_write_in_flight_the_close_watchdog_quits_at_the_deadline() {
        let state = Arc::new(AppState::new());
        let ctx = TestCtx::new(Arc::clone(&state));
        let armed = Instant::now();
        assert!(begin_close(&ctx));
        let (_, at) = ctx.wait_for_quit(Duration::from_secs(5)).expect("the watchdog never fired");
        let took = at.duration_since(armed);
        assert!(
            took >= Duration::from_millis(CLOSE_DEADLINE_MS - 100)
                && took <= Duration::from_millis(CLOSE_DEADLINE_MS + 1_000),
            "expected ~{CLOSE_DEADLINE_MS} ms, got {took:?}"
        );
    }

    /// A write that never finishes — a dead mount — must not make the window
    /// unclosable: the hard cap quits regardless.
    #[test]
    fn a_write_that_never_finishes_is_abandoned_at_the_hard_cap() {
        let state = Arc::new(AppState::new());
        state.close_cap_ms.store(3_000, Ordering::SeqCst);
        let ctx = TestCtx::new(Arc::clone(&state));
        let _stuck = WriteInFlight::new(&state);
        let armed = Instant::now();
        assert!(begin_close(&ctx));
        let (_, at) = ctx.wait_for_quit(Duration::from_secs(8)).expect("the cap never fired");
        let took = at.duration_since(armed);
        assert!(
            took >= Duration::from_millis(2_900) && took <= Duration::from_millis(4_500),
            "expected the quit at the 3,000 ms test cap, got {took:?}"
        );
    }

    /* ── the overflow backstop and our own writes ─────────────────────────── */

    #[derive(Clone)]
    struct Rec {
        state: Arc<AppState>,
        events: Arc<Mutex<Vec<String>>>,
    }

    impl AppCtx for Rec {
        fn emit_event<S: serde::Serialize + Clone>(&self, event: &str, _payload: S) {
            self.events.lock().unwrap().push(event.to_string());
        }
        fn app_state(&self) -> &AppState {
            &self.state
        }
        fn quit(&self, _code: i32) {}
    }

    /// The backstop compares the arena's mtime from BEFORE `repair` with the
    /// disk after it, so an autosave of ours landing in between looks like a
    /// change.  It is ours by fingerprint and must not reload the editor.
    #[test]
    fn the_overflow_backstop_does_not_report_our_own_write() {
        use crate::note_frame::WriteArgs;
        let (_d, state) = fixture();
        let ctx = Rec { state: Arc::new(state), events: Arc::default() };
        let st = &ctx.state;
        st.set_open_note(Some("Top.md".into()));
        let v = st.vault().expect("vault");
        let abs = v.root().join("Top.md");
        let rescan = || {
            ctx.events.lock().unwrap().clear();
            // The arena's view from before the write, as the race leaves it.
            touch_mtime(&v, "Top.md", 0);
            on_watch_event(
                &ctx,
                WatchEvent::Flush(crate::watcher::Flush { full_rescan: true, ..Default::default() }),
            );
            ctx.events.lock().unwrap().iter().any(|e| e == "nc://note-external-change")
        };

        let args = WriteArgs { rel: "Top.md".into(), flags: 0, base_mtime_ms: None, create: false };
        fsops::write_note(&abs, &args, b"# ours\n", &st.self_writes).expect("write");
        assert!(!rescan(), "our own save was reported to the editor as an external change");

        fs::write(&abs, b"# theirs, longer\n").expect("external write");
        assert!(rescan(), "the backstop no longer reports a real external change");
    }
}
