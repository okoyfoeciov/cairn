//! core/src/prefs.rs — Owner: 02.  ABSORBS the removed `state.rs` (M25).
//! Spec: CONTRACT.md §7.6 (state.json — one file, one schema), §1.5 (UiPatch),
//! §1.6 (flushed in the `confirm_close` path, AFTER the editor buffer),
//! M25, M60; spec-02 §9.3.
//!
//! ONE FILE, ONE SCHEMA, PER-VAULT KEYED.  Location is
//! `<appData>/com.cairn.app/state.json` — `~/.config/` on Debian,
//! `~/Library/Application Support/` on macOS — resolved by the shell and passed
//! in.  NEVER inside the vault (gate G8: the vault is written to only for
//! notes), and nothing here hardcodes either platform's path.
//!
//! THE IDENTIFIER IS ONE SOURCE OF TRUTH, NOT A ONE-WAY DOOR.  `com.cairn.app`
//! in `package.json` decides the bundle ID, the ad-hoc signature's `Identifier`
//! AND this path; all three move together and none of them is spelled out in
//! Rust.  NEVER INFER AN IDENTIFIER FROM THE HOST: not from `$HOME`, not from
//! the account name, not from the git remote.
//!
//! WHAT A FUTURE RENAME ACTUALLY COSTS: one `mv`.  Cairn is never distributed —
//! it is built here, ad-hoc signed and installed on machines the user owns — so
//! "everybody's state" is one person's `state.json` on machines they control,
//! not an installed base that can be orphaned.  A rename makes the app read a
//! NEW, empty directory and leave the old one behind, so it must be paired with
//! moving `~/Library/Application Support/<old>/state.json` into `<new>/`.
//! Cheap, but SILENT if forgotten: the symptom is an app that has forgotten
//! every vault, recent, sort and expansion — never an error.
//!
//! THE VAULT KEY IS THE CANONICAL ROOT, AND NOTHING IN THIS FILE ENFORCES IT.
//! `vault`, every entry in `recents` and every key of `vaults` is the string
//! `fsops::canonical_root()` produced at open, i.e.
//! `vault.root().to_string_lossy()`.  That is load-bearing: `/var` is a symlink
//! to `/private/var` on every Mac (so is `/tmp`), so one directory has two
//! spellings and this map will happily hold an entry for each.  A lookup with
//! the non-canonical spelling silently returns the DEFAULTS (empty expansion,
//! scroll 0) and a seed written under it is never read back — no error, no
//! panic, just state that appears to have been forgotten.  It cost an hour to
//! find by hand, and it is the same class as the watcher bug `/var` caused
//! earlier (see `fsops::canonical_root` for that one).
//!
//! `PrefsStore` takes `&str` and canonicalises NOTHING, deliberately:
//! canonicalising here would be a syscall under the state mutex, and a vault
//! that has since been deleted or unmounted must still be listable in
//! `recents`.  So the invariant lives at the callers, and today all of them hold
//! it — `app::open_vault_blocking` (canonicalises, walks the canonical root and
//! keys from it), `app::current_vault` and `vault::info` (`vault.root()`,
//! canonical by construction).  IF YOU ADD A CALLER, CANONICALISE BEFORE YOU
//! CALL — this file cannot catch you.
//!
//! `sidebar_w` IS DELETED (M60).  The sidebar is fixed at 412px and there is no
//! splitter; a persisted field for a dimension that cannot change is a bug
//! waiting for someone to honour it.
//!
//! WHY THE SCHEMA IS PER-VAULT KEYED: spec-02 §9.3's flat schema held exactly
//! ONE vault's `expanded`/`last_note`, so switching A -> B -> A lost A's
//! expansion.  spec-04 §11's `md.notes/`, `recent.json`, `vaults/<sha256-16>.json`
//! and `dirs::config_dir()` are all STRUCK — no second file, no hashing.
//!
//! STATE.JSON IS NOT A WIRE TYPE (§1.1), so it keeps the snake_case field names
//! §7.6 prints and carries NO `rename_all`.  `UiPatch` beside it IS a wire type
//! and is camelCase.  The two casings sitting in one file is deliberate and is
//! the reason each type says which it is.
//!
//! CLIPPY DENY LIST (§6.2, gate G7) applies to this module.

#![deny(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::error::VaultError;

/// §7.6.  Bumping this orphans everybody's state, so it is bumped only for a
/// change `serde(default)` cannot absorb.
pub const SCHEMA_VERSION: u32 = 1;
/// §7.6.  spec-02's 500 is too small for a real vault (it silently loses
/// expansion a heavy user notices) and spec-04's 4,096 is a 250 KB prefs file;
/// 2,000 paths is ~60 KB.
pub const MAX_EXPANDED: usize = 2_000;
/// §7.6.  MRU, deduplicated by canonical path.
pub const MAX_RECENTS: usize = 8;
/// spec-02 §9.3.
pub const DEBOUNCE: Duration = Duration::from_millis(1_000);
/// The file name under `app_config_dir()`.
pub const FILE_NAME: &str = "state.json";
/// §0.7 E9.  A SANITY BAND, not the layout policy.  Rust cannot know the window
/// width, so it only rejects what could not have come from a drag — a NaN, a
/// zero, a hand-edited 90,000 — and the frontend does the real clamp against
/// the live window (`clampSidebarW`, chrome.ts). Splitting it this way keeps the
/// two rules from having to agree about a number neither of them owns.
pub const SIDEBAR_W_MIN: f64 = 120.0;
pub const SIDEBAR_W_MAX: f64 = 4_000.0;

/// `Some(w)` only if `w` could plausibly be a width somebody dragged to.
fn sane_sidebar_w(w: f64) -> Option<f64> {
    (w.is_finite() && (SIDEBAR_W_MIN..=SIDEBAR_W_MAX).contains(&w)).then_some(w)
}

/* ── the wire type (§1.5, camelCase) ──────────────────────────────────────── */

/// CONTRACT §1.5.  `expanded` is folders only and is capped at 2000 (§7.6).
///
/// `last_note` is `Option<Option<String>>` and both layers matter: the OUTER
/// `None` means "the patch did not mention it", the INNER `None` means
/// "there is no open note now".  Collapsing them loses the ability to close the
/// last note and have that survive a restart.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiPatch {
    pub last_note: Option<Option<String>>,
    pub sort: Option<u8>,
    pub expanded: Option<Vec<String>>,
    pub scroll_top: Option<f64>,
    /// §0.7 E9.  GLOBAL — a property of the window the user arranged, not of
    /// the notes in it.
    pub sidebar_w: Option<f64>,
}

/* ── the file (§7.6, snake_case — NOT a wire type) ────────────────────────── */

/// One vault's remembered UI.  EVERY field degrades on its own: a field that is
/// missing, or present with the wrong type (a hand edit, a future version),
/// takes its default and costs nothing else.  Only a file that is not §7.6's
/// object at all is thrown away whole, and `PrefsStore` keeps that one aside
/// before anything overwrites it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct VaultUi {
    #[serde(default, deserialize_with = "lenient")]
    pub sort: u8,
    #[serde(default, deserialize_with = "lenient_strings")]
    pub expanded: Vec<String>,
    #[serde(default, deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub last_note: Option<String>,
    #[serde(default, deserialize_with = "lenient")]
    pub scroll_top: f64,
}

/// A present value of the wrong type becomes the default, never an error that
/// discards the whole file.
fn lenient<'de, D, T>(d: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::de::DeserializeOwned + Default,
{
    let v = serde_json::Value::deserialize(d)?;
    Ok(serde_json::from_value(v).unwrap_or_default())
}

/// `lenient`, per element: one non-string drops that element only.
fn lenient_strings<'de, D>(d: D) -> Result<Vec<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let serde_json::Value::Array(items) = serde_json::Value::deserialize(d)? else {
        return Ok(Vec::new());
    };
    Ok(items
        .into_iter()
        .filter_map(|v| match v {
            serde_json::Value::String(s) => Some(s),
            _ => None,
        })
        .collect())
}

/// `lenient`, per vault: a record that is not an object drops that vault's
/// record only.
fn lenient_vaults<'de, D>(d: D) -> Result<BTreeMap<String, VaultUi>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let serde_json::Value::Object(map) = serde_json::Value::deserialize(d)? else {
        return Ok(BTreeMap::new());
    };
    Ok(map
        .into_iter()
        .filter_map(|(k, v)| serde_json::from_value::<VaultUi>(v).ok().map(|ui| (k, ui)))
        .collect())
}

/// §7.6's schema, exactly.  `v` alone is strict: a different version is not
/// half-read.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct State {
    pub v: u32,
    #[serde(default, deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub vault: Option<String>,
    #[serde(default, deserialize_with = "lenient_strings")]
    pub recents: Vec<String>,
    /// §0.7 E9.  Absent until the user drags the divider once, which is why it
    /// is an `Option` and not a defaulted `f64`: absent means "never resized"
    /// and the frontend keeps tokens.css's 412, while `Some(412.0)` means
    /// "resized, and back to the default".
    #[serde(default, deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub sidebar_w: Option<f64>,
    /// Keyed by the CANONICAL vault root (module header): two spellings of one
    /// directory are two keys here, and nothing joins them back up.
    ///
    /// A `BTreeMap`, not a `HashMap`: the file is rewritten on every flush and a
    /// stable key order makes it diffable and keeps a debounced rewrite from
    /// churning bytes that did not change.
    #[serde(default, deserialize_with = "lenient_vaults")]
    pub vaults: BTreeMap<String, VaultUi>,
}

impl Default for State {
    fn default() -> Self {
        Self {
            v: SCHEMA_VERSION,
            vault: None,
            recents: Vec::new(),
            sidebar_w: None,
            vaults: BTreeMap::new(),
        }
    }
}

impl State {
    /// A CORRUPT OR UNPARSEABLE FILE IS SILENTLY REPLACED WITH DEFAULTS.  Never
    /// an error dialog, never a startup failure: losing a window position is not
    /// worth a modal, and a state file is not user data.
    ///
    /// Absent, empty, truncated, not JSON, JSON of the wrong shape, and a
    /// version from the future all land here.  A single wrong-typed VALUE does
    /// not: it costs that value (see `VaultUi`).
    pub fn load(path: &Path) -> Self {
        Self::read(path).0
    }

    /// `load`, plus the raw bytes of a file that was there but could not be
    /// used, which `PrefsStore` keeps aside before its first write.
    fn read(path: &Path) -> (Self, Option<Vec<u8>>) {
        let Ok(raw) = std::fs::read(path) else { return (Self::default(), None) };
        // An editor's UTF-8 BOM is not a reason to lose the file.
        let body = raw.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(raw.as_slice());
        match serde_json::from_slice::<State>(body) {
            Ok(mut st) if st.v == SCHEMA_VERSION => {
                st.sanitise();
                (st, None)
            }
            _ if raw.iter().all(u8::is_ascii_whitespace) => (Self::default(), None),
            _ => (Self::default(), Some(raw)),
        }
    }

    /// Applies every cap and prune.  Run on load AND before every write, so a
    /// hand-edited or future-version file cannot put the process into a state
    /// the invariants do not describe.
    pub fn sanitise(&mut self) {
        // MRU, deduplicated, capped.  Dedup keeps the FIRST occurrence, which is
        // the most recent.
        let mut seen = Vec::with_capacity(MAX_RECENTS);
        self.recents.retain(|r| {
            if r.is_empty() || seen.iter().any(|s| s == r) {
                return false;
            }
            seen.push(r.clone());
            true
        });
        self.recents.truncate(MAX_RECENTS);

        // §0.7 E9.  A file edited by hand, or written by a future version, must
        // not be able to ship a 0px sidebar that looks like the app failed to
        // start.  Out of band => forget it and fall back to the token's 412.
        if let Some(w) = self.sidebar_w {
            self.sidebar_w = sane_sidebar_w(w);
        }

        for ui in self.vaults.values_mut() {
            if ui.sort > 3 {
                ui.sort = 0; // four orders, wire u8 0..3 (M28/M53)
            }
            ui.expanded.truncate(MAX_EXPANDED);
            if !ui.scroll_top.is_finite() || ui.scroll_top < 0.0 {
                ui.scroll_top = 0.0;
            }
        }

        // "The `vaults` map is pruned to the 8 entries in `recents`" (§7.6) —
        // this is what stops the file growing without bound.  The CURRENT vault
        // is kept even if a caller has not pushed it into recents yet, because
        // dropping the open vault's expansion state on the next flush would be
        // the very bug the per-vault schema exists to fix.
        let current = self.vault.clone();
        self.vaults.retain(|k, _| {
            self.recents.iter().any(|r| r == k) || current.as_deref() == Some(k.as_str())
        });
    }

    /// MRU: most recent first, deduplicated, capped at 8.
    ///
    /// **THE KEY IS BUILT HERE, AND `root` MUST ALREADY BE CANONICAL** (module
    /// header).  This is the write half of the pair `view_state` reads back, and
    /// the dedup is a STRING compare: pass `/var/Notes` where the open path
    /// passes `/private/var/Notes` and you get a second `recents` entry and a
    /// second `vaults` key for one directory, each holding half the state.  Not
    /// checked, not canonicalised, not detectable from in here — an unnormalised
    /// path is indistinguishable from a genuinely different vault.
    pub fn touch_vault(&mut self, root: &str) {
        self.vault = Some(root.to_string());
        self.recents.retain(|r| r != root);
        self.recents.insert(0, root.to_string());
        self.recents.truncate(MAX_RECENTS);
        self.vaults.entry(root.to_string()).or_default();
    }

    /// §1.5's `UiPatch`, applied to one vault.  A patch with no vault open still
    /// carries `sidebar_w`, which is global — that is the case a fresh install
    /// hits.
    ///
    /// The other place a `vaults` key is built, so the same rule as
    /// `touch_vault`: `vault` is the CANONICAL root (module header).  The only
    /// caller is `save_ui_state`, which takes it from the open vault's
    /// `root()`; anything else must canonicalise first.
    pub fn apply(&mut self, vault: Option<&str>, patch: &UiPatch) {
        // §0.7 E9.  GLOBAL, so it goes ABOVE the per-vault early return — a
        // resize with no vault open still persists, which is the whole point of
        // it being a window property rather than a note one.
        if let Some(w) = patch.sidebar_w {
            if let Some(w) = sane_sidebar_w(w) {
                self.sidebar_w = Some(w);
            }
        }
        let Some(vault) = vault else { return };
        let ui = self.vaults.entry(vault.to_string()).or_default();
        if let Some(s) = patch.sort {
            ui.sort = if s <= 3 { s } else { ui.sort };
        }
        if let Some(ln) = &patch.last_note {
            ui.last_note = ln.clone();
        }
        if let Some(e) = &patch.expanded {
            ui.expanded = e.clone();
            ui.expanded.truncate(MAX_EXPANDED);
        }
        if let Some(t) = patch.scroll_top {
            if t.is_finite() && t >= 0.0 {
                ui.scroll_top = t;
            }
        }
    }

    /// `vault` is the CANONICAL root string (module header).  A miss is
    /// `None` and callers read that as "never seen", so a non-canonical
    /// spelling looks exactly like a brand-new vault.
    pub fn ui(&self, vault: &str) -> Option<&VaultUi> {
        self.vaults.get(vault)
    }
}

/// Writes `raw` to `<name>.bad-<unix-secs>` beside `path`, never over an
/// earlier backup, and makes it durable before returning.
fn keep_aside(path: &Path, raw: &[u8]) -> Result<(), VaultError> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let io = |p: &Path, e: &std::io::Error| VaultError::io(p.to_string_lossy(), e);
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    let name = path
        .file_name()
        .map_or_else(|| FILE_NAME.to_string(), |n| n.to_string_lossy().into_owned());
    for n in 0..100u32 {
        let aside = path.with_file_name(if n == 0 {
            format!("{name}.bad-{secs}")
        } else {
            format!("{name}.bad-{secs}-{n}")
        });
        match std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&aside) {
            Ok(mut f) => {
                f.write_all(raw).map_err(|e| io(&aside, &e))?;
                f.sync_all().map_err(|e| io(&aside, &e))?;
                eprintln!(
                    "cairn: {} could not be read; the original is kept as {}",
                    path.display(),
                    aside.display()
                );
                return Ok(());
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(io(&aside, &e)),
        }
    }
    Err(io(path, &std::io::Error::other("no free name to keep an unreadable state file aside")))
}

/* ── the store ────────────────────────────────────────────────────────────── */

/// Owns the file and the 1,000 ms debounce.
///
/// The flush ordering is NOT this type's to choose and is stated where it
/// belongs (§1.6): the editor buffer FIRST, `state.json` SECOND.  What this type
/// guarantees is that `flush_now` is synchronous and total, so the
/// `confirm_close` path can call it and know the bytes are down.
pub struct PrefsStore {
    path: PathBuf,
    state: Mutex<State>,
    /// Bumped by every `save_debounced`; the worker that observes a full quiet
    /// period is the one that writes.
    token: AtomicU64,
    /// Single-flight guard for the debounce worker: at most one sleeping thread
    /// exists no matter how dense the burst (a sidebar drag is hundreds of
    /// patches in a second).  The worker re-sleeps while the token keeps moving
    /// rather than exiting, so the latest patch always gets its write without a
    /// thread per call.
    armed: AtomicBool,
    debounce: Duration,
    /// Held by `flush_now` from its snapshot through its rename, so flushes
    /// from different threads (the debounce worker, `confirm_close`,
    /// `forget_vault`, the watchdog) land in the order they snapshotted and an
    /// older state can never be renamed over a newer one.  It also carries the
    /// bytes of a `state.json` that could not be used at load, which the first
    /// flush keeps aside before replacing it.
    flush: Mutex<Option<Vec<u8>>>,
}

impl PrefsStore {
    /// Never fails: an unreadable or corrupt file is defaults (§7.6).
    pub fn load(path: PathBuf) -> Self {
        let (state, unusable) = State::read(&path);
        Self {
            path,
            state: Mutex::new(state),
            token: AtomicU64::new(0),
            armed: AtomicBool::new(false),
            debounce: DEBOUNCE,
            flush: Mutex::new(unusable),
        }
    }

    /// Test seam only — the production debounce is §7.6's 1,000 ms.
    #[cfg(test)]
    fn with_debounce(mut self, d: Duration) -> Self {
        self.debounce = d;
        self
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// A poisoned lock is recovered from rather than propagated.  A panic in one
    /// command must not make the window position unsavable for the rest of the
    /// session, and there is nothing in this struct a panic can leave
    /// half-updated — every mutation is a whole-value assignment.
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        match self.state.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        }
    }

    pub fn snapshot(&self) -> State {
        self.lock().clone()
    }

    /// §7.6.1 (errata 3, Z2).  **THE READ PATH** for the two fields `state.json`
    /// persisted write-only until this landed: the per-vault expansion set and
    /// the sidebar scroll offset for `root`, or the defaults `(vec![], 0.0)`
    /// when this vault has never been seen.
    ///
    /// Already truncated to `MAX_EXPANDED` and already clamped finite and
    /// non-negative — `State::apply` enforces both on the way in and
    /// `State::sanitise` enforces both again on load — SO NO CALLER
    /// RE-VALIDATES.  One reader, so the three `vault::info_view` call sites do
    /// not each re-derive it and cannot disagree.
    ///
    /// `root` MUST be spelled the way `save_ui_state` writes it and the way
    /// `VaultInfo.root` reports it: `vault.root().to_string_lossy()`, which is
    /// the CANONICAL root (module header) because `app::open_vault_blocking`
    /// canonicalises before it walks.  A key that differs by one character
    /// makes the whole ruling silently inert, which is exactly the failure mode
    /// it exists to fix — see `view_state_is_keyed_by_the_string_vault_info
    /// _reports`.  THE REALISTIC WAY TO GET THAT WRONG IS NOT A TYPO, IT IS A
    /// SYMLINK: `/var/Notes` and `/private/var/Notes` are one directory and two
    /// keys, and this returns `(vec![], 0.0)` for the spelling that was not
    /// written under, indistinguishable from a vault opened for the first time.
    #[must_use]
    pub fn view_state(&self, root: &str) -> (Vec<String>, f64) {
        self.lock()
            .ui(root)
            .map_or_else(|| (Vec::new(), 0.0), |u| (u.expanded.clone(), u.scroll_top))
    }

    pub fn edit<R>(&self, f: impl FnOnce(&mut State) -> R) -> R {
        f(&mut self.lock())
    }

    /// Writes the file NOW, synchronously.  Used by the `confirm_close` path
    /// (§1.6) and by the watchdog, both of which need the bytes on disk before
    /// the process goes away.
    ///
    /// Same atomic routine as a note write (§7.6), MINUS the conflict check and
    /// minus step 1b — this file has no other writer and no base mtime, and it
    /// must be creatable, which is exactly what those two steps forbid.
    pub fn flush_now(&self) -> Result<(), VaultError> {
        let mut unusable = self.flush.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let bytes = {
            let mut st = self.lock();
            st.sanitise();
            serde_json::to_vec_pretty(&*st)
                .map_err(|e| VaultError::io(self.path.to_string_lossy(), &std::io::Error::other(e)))?
        };
        #[cfg(test)]
        tests::run_after_serialise_hook();

        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)
                .map_err(|e| VaultError::io(dir.to_string_lossy(), &e))?;
        }

        // A file that could not be read is the user's only copy of that state:
        // it goes aside BEFORE the write below replaces it, or the write does
        // not happen.
        if let Some(raw) = unusable.as_deref() {
            keep_aside(&self.path, raw)?;
            *unusable = None;
        }

        // A symlinked state.json is written THROUGH the link, with the mode of
        // the file it names: an lstat reads the link's own 0o777, and a rename
        // over the link would replace it with a world-writable regular file and
        // stop updating the file it pointed at.  A path that does not resolve
        // (first run, a dangling link) is written as itself.
        let target = std::fs::canonicalize(&self.path).unwrap_or_else(|_| self.path.clone());

        // 0o600, not 0o644: this file records which folders the user has open on
        // disk.  It is not a note, and G8's "the vault holds only notes" is the
        // reason it lives here at all.
        let prior = std::fs::metadata(&target).ok().map(|md| {
            use std::os::unix::fs::PermissionsExt;
            md.permissions().mode() & 0o7777
        });
        crate::fsops::atomic_write(&target, &bytes, Some(prior.unwrap_or(0o600)), None)?;
        Ok(())
    }

    /// Coalesced write, §7.6's 1,000 ms.  Cheap to call on every keystroke of a
    /// window drag: at most one worker sleeps no matter how dense the burst,
    /// and it re-sleeps while patches keep arriving so the last one is always
    /// written a full quiet period after it lands.
    pub fn save_debounced(self: &Arc<Self>) {
        self.token.fetch_add(1, Ordering::SeqCst);
        // A worker is already sleeping and will observe the bump above.
        if self.armed.swap(true, Ordering::SeqCst) {
            return;
        }
        let this = Arc::clone(self);
        let spawned = std::thread::Builder::new()
            .name("cairn-prefs".into())
            .spawn(move || {
                let delay = this.debounce;
                loop {
                    let before = this.token.load(Ordering::SeqCst);
                    std::thread::sleep(delay);
                    if this.token.load(Ordering::SeqCst) != before {
                        continue; // patches arrived mid-sleep: deadline resets
                    }
                    if let Err(e) = this.flush_now() {
                        // Never a dialog, never a startup failure (§7.6).  One line.
                        eprintln!("cairn: could not write {}: {e}", this.path.display());
                    }
                    this.armed.store(false, Ordering::SeqCst);
                    // A patch that landed between the flush and the disarm still
                    // needs its write: re-arm in place rather than stranding it.
                    // If a fresh worker started in the gap, stand down instead.
                    if this.token.load(Ordering::SeqCst) != before
                        && !this.armed.swap(true, Ordering::SeqCst)
                    {
                        continue;
                    }
                    return;
                }
            });
        if spawned.is_err() {
            // Out of threads: write inline rather than silently losing the
            // state.  Rare enough that the stall does not matter, bad enough
            // that dropping it would be wrong.
            self.armed.store(false, Ordering::SeqCst);
            let _ = self.flush_now();
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]
mod tests {
    use super::*;

    fn store(dir: &Path) -> Arc<PrefsStore> {
        Arc::new(
            PrefsStore::load(dir.join("state.json")).with_debounce(Duration::from_millis(30)),
        )
    }

    /* ── tolerance: absent, truncated, corrupt (§7.6) ─────────────────────── */

    /// "A corrupt or unparseable file is silently replaced with defaults."  All
    /// six shapes, and NONE of them may return an error or panic — this runs in
    /// `setup()`, so a throw here is a startup failure over a window position.
    #[test]
    fn a_broken_state_file_is_always_defaults_never_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("state.json");

        // absent
        assert_eq!(State::load(&p), State::default());

        for (name, bytes) in [
            ("empty", &b""[..]),
            ("truncated mid-object", br#"{"v":1,"recents":["#),
            ("not json", b"\x00\x01\x02 not json at all"),
            ("json but the wrong shape", br#"[1,2,3]"#),
            ("right shape, wrong types", br#"{"v":"one","recents":{}}"#),
            ("a version from the future", br#"{"v":99,"vault":"/x"}"#),
        ] {
            std::fs::write(&p, bytes).unwrap();
            assert_eq!(State::load(&p), State::default(), "{name}");
            // And the store built on it is usable, not poisoned.
            assert!(PrefsStore::load(p.clone()).snapshot().recents.is_empty(), "{name}");
        }
    }

    /// A file missing individual fields degrades field by field.  This is the
    /// realistic forward-compatibility case: a newer version added a key, the
    /// user downgraded.
    #[test]
    fn missing_fields_degrade_individually() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("state.json");
        std::fs::write(
            &p,
            br#"{"v":1,"vault":"/V","vaults":{"/V":{"expanded":["A"]}},"unknown_future_key":42}"#,
        )
        .unwrap();
        let st = State::load(&p);
        assert_eq!(st.vault.as_deref(), Some("/V"));
        assert_eq!(st.ui("/V").unwrap().expanded, vec!["A".to_string()]);
        assert_eq!(st.ui("/V").unwrap().sort, 0);
        assert_eq!(st.ui("/V").unwrap().last_note, None);
    }

    /* ── the schema (§7.6) ────────────────────────────────────────────────── */

    /* ── §0.7 E9, the sidebar width ───────────────────────────────────────── */

    /// GLOBAL, not per-vault, and that is the whole point: a resize performed
    /// with no vault open must still persist.  `apply` handles it ABOVE the
    /// per-vault early return, and this is the test that says so — pass `None`
    /// for the vault and the width must still land.
    #[test]
    fn sidebar_w_persists_with_no_vault_open() {
        let mut st = State::default();
        st.apply(None, &UiPatch { sidebar_w: Some(300.0), ..Default::default() });
        assert_eq!(st.sidebar_w, Some(300.0), "a resize with no vault open was dropped");
    }

    /// Rust rejects what could not have come from a drag; it does NOT try to
    /// know the window width, which is the frontend's clamp.  Out-of-band
    /// values leave the field ABSENT so the page falls back to the token's 412
    /// — never a 0px sidebar that looks like the app failed to start.
    #[test]
    fn an_insane_sidebar_w_is_refused_not_stored() {
        for bad in [0.0, -1.0, f64::NAN, f64::INFINITY, 90_000.0, SIDEBAR_W_MIN - 0.5] {
            let mut st = State::default();
            st.apply(None, &UiPatch { sidebar_w: Some(bad), ..Default::default() });
            assert_eq!(st.sidebar_w, None, "{bad} was stored");
        }
        for ok in [SIDEBAR_W_MIN, 412.0, SIDEBAR_W_MAX] {
            let mut st = State::default();
            st.apply(None, &UiPatch { sidebar_w: Some(ok), ..Default::default() });
            assert_eq!(st.sidebar_w, Some(ok), "{ok} was refused");
        }
    }

    /// A file edited by hand, or written by a future version, must not be able
    /// to ship a broken layout.  `load` sanitises, so the bad value never
    /// reaches the initialization script.
    #[test]
    fn a_hand_edited_sidebar_w_is_sanitised_on_load() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("state.json");
        std::fs::write(&p, format!(r#"{{"v":{SCHEMA_VERSION},"sidebar_w":0.0}}"#)).unwrap();
        assert_eq!(State::load(&p).sidebar_w, None, "a 0px sidebar survived load()");
        std::fs::write(&p, format!(r#"{{"v":{SCHEMA_VERSION},"sidebar_w":333.0}}"#)).unwrap();
        assert_eq!(State::load(&p).sidebar_w, Some(333.0), "a good width was thrown away");
    }

    /// M60 said the field was deleted because the sidebar could not change.
    /// It can now (§0.7 E9), and absence still has to mean "never resized" —
    /// otherwise every fresh install would serialise a width it never chose.
    #[test]
    fn an_unresized_sidebar_serialises_no_field_at_all() {
        let st = State::default();
        let j = serde_json::to_string(&st).unwrap();
        assert!(!j.contains("sidebar_w"), "a fresh state.json names a width nobody set: {j}");
    }

    /// §7.6 prints the file with snake_case keys, and it is NOT a wire type, so
    /// it carries no `rename_all`.  `UiPatch` beside it IS a wire type and is
    /// camelCase.  Pinning both here is the only thing stopping somebody
    /// "tidying up" one casing into the other.
    #[test]
    fn the_file_is_snake_case_and_the_patch_is_camel_case() {
        let mut st = State::default();
        st.touch_vault("/Users/me/Notes");
        st.apply(
            Some("/Users/me/Notes"),
            &UiPatch {
                last_note: Some(Some("Misc.md".into())),
                sort: Some(2),
                expanded: Some(vec!["Projects".into(), "Projects/2026".into()]),
                scroll_top: Some(0.0),
                sidebar_w: Some(300.0),
            },
        );

        let j = serde_json::to_string(&st).unwrap();
        assert!(j.contains(r#""last_note":"Misc.md""#), "{j}");
        assert!(j.contains(r#""scroll_top":0.0"#), "{j}");
        assert!(!j.contains("lastNote"), "{j}");

        // The patch is read as camelCase — this is what the frontend sends.
        let p: UiPatch =
            serde_json::from_str(r#"{"lastNote":"A.md","scrollTop":12,"sort":3}"#).unwrap();
        assert_eq!(p.last_note, Some(Some("A.md".into())));
        assert_eq!(p.scroll_top, Some(12.0));
    }

    /// The whole reason the schema is per-vault keyed (M25): A -> B -> A must not
    /// lose A's expansion.  spec-02 §9.3's flat schema did exactly that.
    #[test]
    fn switching_a_b_a_keeps_a_s_expansion() {
        let mut st = State::default();
        st.touch_vault("/A");
        st.apply(Some("/A"), &UiPatch { expanded: Some(vec!["A/x".into()]), ..<_>::default() });
        st.touch_vault("/B");
        st.apply(Some("/B"), &UiPatch { expanded: Some(vec!["B/y".into()]), ..<_>::default() });
        st.touch_vault("/A");
        assert_eq!(st.ui("/A").unwrap().expanded, vec!["A/x".to_string()]);
        assert_eq!(st.ui("/B").unwrap().expanded, vec!["B/y".to_string()]);
    }

    /// `last_note: Some(None)` must be able to CLEAR the remembered note.  If
    /// the two `Option` layers were collapsed, closing the last tab and quitting
    /// would reopen it forever.
    #[test]
    fn last_note_can_be_cleared_and_can_be_left_alone() {
        let mut st = State::default();
        st.touch_vault("/A");
        st.apply(Some("/A"), &UiPatch { last_note: Some(Some("n.md".into())), ..<_>::default() });
        assert_eq!(st.ui("/A").unwrap().last_note.as_deref(), Some("n.md"));
        // Absent: leave it alone.
        st.apply(Some("/A"), &UiPatch { scroll_top: Some(5.0), ..<_>::default() });
        assert_eq!(st.ui("/A").unwrap().last_note.as_deref(), Some("n.md"));
        // Present-but-null: clear it.
        st.apply(Some("/A"), &UiPatch { last_note: Some(None), ..<_>::default() });
        assert_eq!(st.ui("/A").unwrap().last_note, None);
    }

    /* ── caps and pruning (§7.6) ──────────────────────────────────────────── */

    #[test]
    fn recents_are_mru_deduplicated_and_capped_at_eight() {
        let mut st = State::default();
        for i in 0..12 {
            st.touch_vault(&format!("/v{i}"));
        }
        assert_eq!(st.recents.len(), MAX_RECENTS);
        assert_eq!(st.recents.first().map(String::as_str), Some("/v11"));
        // Re-touching moves to the front rather than duplicating.
        st.touch_vault("/v5");
        assert_eq!(st.recents.first().map(String::as_str), Some("/v5"));
        assert_eq!(st.recents.iter().filter(|r| *r == "/v5").count(), 1);
    }

    #[test]
    fn expanded_is_capped_at_two_thousand() {
        let mut st = State::default();
        st.touch_vault("/A");
        let many: Vec<String> = (0..MAX_EXPANDED + 500).map(|i| format!("d{i}")).collect();
        st.apply(Some("/A"), &UiPatch { expanded: Some(many), ..<_>::default() });
        assert_eq!(st.ui("/A").unwrap().expanded.len(), MAX_EXPANDED);
    }

    /// The prune that stops the file growing without bound — and the exception
    /// that stops it eating the open vault.
    #[test]
    fn the_vaults_map_is_pruned_to_recents_but_keeps_the_open_vault() {
        let mut st = State::default();
        for i in 0..12 {
            st.touch_vault(&format!("/v{i}"));
            st.apply(
                Some(&format!("/v{i}")),
                &UiPatch { expanded: Some(vec!["x".into()]), ..<_>::default() },
            );
        }
        st.sanitise();
        assert_eq!(st.vaults.len(), MAX_RECENTS);
        assert!(st.ui("/v0").is_none(), "an evicted vault kept its entry");
        assert!(st.ui("/v11").is_some());

        // The open vault survives even if it is not in recents.
        let mut st = State { vault: Some("/open".into()), ..State::default() };
        st.vaults.insert("/open".into(), VaultUi::default());
        st.sanitise();
        assert!(st.ui("/open").is_some(), "the OPEN vault's state was pruned away");
    }

    /// Four sort orders, wire `u8` 0..3 (M28/M53).  A value outside that from a
    /// hand-edited file must not reach the sorter.
    #[test]
    fn an_out_of_range_sort_is_clamped_not_trusted() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("state.json");
        std::fs::write(&p, br#"{"v":1,"vault":"/A","vaults":{"/A":{"sort":250}}}"#).unwrap();
        assert_eq!(State::load(&p).ui("/A").unwrap().sort, 0);
        // …and through the patch path too.
        let mut st = State::default();
        st.touch_vault("/A");
        st.apply(Some("/A"), &UiPatch { sort: Some(2), ..<_>::default() });
        st.apply(Some("/A"), &UiPatch { sort: Some(9), ..<_>::default() });
        assert_eq!(st.ui("/A").unwrap().sort, 2, "a bogus sort overwrote a good one");
    }

    /// A NaN scroll offset must not reach the tree.
    #[test]
    fn non_finite_numbers_are_dropped() {
        let mut st = State::default();
        st.touch_vault("/A");
        st.apply(
            Some("/A"),
            &UiPatch { scroll_top: Some(f64::INFINITY), ..<_>::default() },
        );
        st.sanitise();
        assert_eq!(st.ui("/A").unwrap().scroll_top, 0.0);
    }

    /* ── the store ────────────────────────────────────────────────────────── */

    /// G8, restated for this file: it is written with the SAME atomic routine as
    /// a note (temp + fsync + rename), so a power cut mid-flush leaves either
    /// the old file or the new one, never a truncated one — and it leaves NO
    /// temp behind.
    #[test]
    fn flush_is_atomic_and_leaves_nothing_behind() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        s.edit(|st| st.touch_vault("/A"));
        s.flush_now().unwrap();

        let names: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["state.json".to_string()], "{names:?}");

        let reloaded = State::load(&dir.path().join("state.json"));
        assert_eq!(reloaded.vault.as_deref(), Some("/A"));
    }

    /// The config directory does not exist on a fresh install; the first flush
    /// must create it rather than failing.
    #[test]
    fn the_first_flush_creates_the_config_directory() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("com.cairn.app");
        let s = Arc::new(PrefsStore::load(nested.join("state.json")));
        s.edit(|st| st.touch_vault("/A"));
        s.flush_now().unwrap();
        assert!(nested.join("state.json").is_file());
    }

    /// This file records which folders the user keeps notes in.  0o600.
    #[test]
    fn state_json_is_not_world_readable() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        s.flush_now().unwrap();
        let mode = std::fs::metadata(s.path()).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "state.json is {mode:o}");
        // A rewrite preserves it rather than widening it.
        s.flush_now().unwrap();
        assert_eq!(std::fs::metadata(s.path()).unwrap().permissions().mode() & 0o777, 0o600);
    }

    /// A symlinked state.json (a dotfiles setup) is written through the link
    /// with the target's mode.  Replacing the link would leave a regular file
    /// with the LINK's mode (0o777 on Linux) and a target that never updates.
    #[test]
    fn a_symlinked_state_json_is_written_through_with_the_targets_mode() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("dotfiles")).unwrap();
        std::fs::create_dir(dir.path().join("cfg")).unwrap();
        let target = dir.path().join("dotfiles/state.json");
        store(&dir.path().join("dotfiles")).flush_now().unwrap();
        assert_eq!(std::fs::metadata(&target).unwrap().permissions().mode() & 0o777, 0o600);
        let link = dir.path().join("cfg/state.json");
        std::os::unix::fs::symlink(&target, &link).unwrap();

        let s = Arc::new(PrefsStore::load(link.clone()));
        s.edit(|st| st.touch_vault("/B"));
        s.flush_now().unwrap();

        let lmd = std::fs::symlink_metadata(&link).unwrap();
        let lmode = lmd.permissions().mode() & 0o777;
        assert!(lmd.file_type().is_symlink(), "the link was replaced (mode {lmode:o})");
        assert_eq!(std::fs::metadata(&target).unwrap().permissions().mode() & 0o777, 0o600);
        let recents = State::load(&target).recents;
        assert_eq!(recents, vec!["/B".to_string()], "the target was not updated");
        let strays: Vec<_> = std::fs::read_dir(dir.path().join("cfg"))
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n != "state.json")
            .collect();
        assert!(strays.is_empty(), "{strays:?}");

        // A dangling link becomes a private regular file, never a 0o777 one.
        let dangling = dir.path().join("cfg/dangling.json");
        std::os::unix::fs::symlink(dir.path().join("nowhere/state.json"), &dangling).unwrap();
        PrefsStore::load(dangling.clone()).flush_now().unwrap();
        let dmd = std::fs::symlink_metadata(&dangling).unwrap();
        assert!(dmd.file_type().is_file());
        assert_eq!(dmd.permissions().mode() & 0o777, 0o600);
    }

    /// Debounced: a burst of saves produces ONE write, and the last value wins.
    #[test]
    fn the_debounce_coalesces_and_the_last_value_wins() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        for i in 0..20 {
            s.edit(|st| st.touch_vault(&format!("/v{i}")));
            s.save_debounced();
        }
        assert!(!s.path().exists(), "the debounce wrote immediately");
        std::thread::sleep(Duration::from_millis(300));
        let st = State::load(s.path());
        assert_eq!(st.vault.as_deref(), Some("/v19"));
    }

    /// §1.6: `confirm_close` flushes unconditionally, and it must not depend on
    /// a timer that is still sleeping.
    #[test]
    fn flush_now_does_not_wait_for_the_debounce() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        s.edit(|st| st.touch_vault("/A"));
        s.save_debounced();
        s.flush_now().unwrap();
        assert_eq!(State::load(s.path()).vault.as_deref(), Some("/A"));
    }

    /// A round trip through the real file keeps every field.
    #[test]
    fn a_full_state_round_trips_through_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        s.edit(|st| {
            st.touch_vault("/Users/me/Notes");
            st.apply(
                Some("/Users/me/Notes"),
                &UiPatch {
                    last_note: Some(Some("Misc.md".into())),
                    sort: Some(3),
                    expanded: Some(vec!["Projects".into(), "Projects/2026".into()]),
                    scroll_top: Some(432.0),
                    sidebar_w: Some(340.0),
                },
            );
        });
        s.flush_now().unwrap();

        let st = State::load(s.path());
        assert_eq!(st.v, SCHEMA_VERSION);
        assert_eq!(st.recents, vec!["/Users/me/Notes".to_string()]);
        let ui = st.ui("/Users/me/Notes").unwrap();
        assert_eq!(ui.sort, 3);
        assert_eq!(ui.last_note.as_deref(), Some("Misc.md"));
        assert_eq!(ui.expanded, vec!["Projects".to_string(), "Projects/2026".to_string()]);
        assert_eq!(ui.scroll_top, 432.0);
    }

   /* ── one bad value costs that value; an unreadable file is kept aside ── */

    /// The shape the report reproduced: ONE vault's `scroll_top` is `null`.
    /// Everything else in the file must survive, and so must the rest of the
    /// wrong-typed values' neighbours.
    #[test]
    fn one_wrong_typed_value_costs_only_that_value() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("state.json");
        std::fs::write(
            &p,
            br#"{"v":1,"vault":"/A","recents":["/A","/B",7],
                "sidebar_w":"wide",
                "vaults":{
                  "/A":{"sort":2,"last_note":"n.md","expanded":["x",5,"y"],"scroll_top":12},
                  "/B":{"scroll_top":null,"sort":256,"last_note":3},
                  "/C":5}}"#,
        )
        .unwrap();
        let st = State::load(&p);
        assert_eq!(st.vault.as_deref(), Some("/A"));
        assert_eq!(st.recents, vec!["/A".to_string(), "/B".to_string()]);
        assert_eq!(st.sidebar_w, None);
        let a = st.ui("/A").unwrap();
        assert_eq!((a.sort, a.last_note.as_deref(), a.scroll_top), (2, Some("n.md"), 12.0));
        assert_eq!(a.expanded, vec!["x".to_string(), "y".to_string()]);
        let b = st.ui("/B").unwrap();
        assert_eq!((b.sort, b.last_note.as_deref(), b.scroll_top), (0, None, 0.0));
        assert!(st.ui("/C").is_none(), "/C is neither a record nor in recents");

        // Nothing unusable, so nothing is set aside on the next flush.
        let s = PrefsStore::load(p.clone());
        s.flush_now().unwrap();
        assert!(bad_copies(dir.path()).is_empty());
    }

    /// An editor's byte-order mark is not corruption.
    #[test]
    fn a_leading_bom_does_not_lose_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("state.json");
        std::fs::write(&p, b"\xEF\xBB\xBF{\"v\":1,\"vault\":\"/A\",\"recents\":[\"/A\"]}").unwrap();
        assert_eq!(State::load(&p).recents, vec!["/A".to_string()]);
    }

    fn bad_copies(dir: &Path) -> Vec<PathBuf> {
        let mut v: Vec<PathBuf> = std::fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.file_name().is_some_and(|n| n.to_string_lossy().starts_with("state.json.bad-")))
            .collect();
        v.sort();
        v
    }

    /// A file that cannot be used at all is still the user's only copy of its
    /// state: the first flush keeps it byte for byte beside `state.json`
    /// before replacing it, and later flushes do not copy it again.
    #[test]
    fn an_unusable_state_file_is_kept_aside_before_the_first_flush_replaces_it() {
        for (name, bytes) in [
            ("truncated", &br#"{"v":1,"vault":"/A","recents":["/A","/B""#[..]),
            ("another version", br#"{"v":2,"vault":"/A","recents":["/A"]}"#),
            ("not an object", br#"["/A","/B"]"#),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let p = dir.path().join("state.json");
            std::fs::write(&p, bytes).unwrap();

            let s = store(dir.path());
            assert!(s.snapshot().recents.is_empty(), "{name}");
            s.edit(|st| st.touch_vault("/New"));
            s.flush_now().unwrap();

            let kept = bad_copies(dir.path());
            assert_eq!(kept.len(), 1, "{name}: {kept:?}");
            assert_eq!(std::fs::read(&kept[0]).unwrap(), bytes, "{name}: the copy is not the original");
            assert_eq!(State::load(&p).vault.as_deref(), Some("/New"), "{name}");

            s.flush_now().unwrap();
            assert_eq!(bad_copies(dir.path()).len(), 1, "{name}: a second flush copied again");
        }

        // Nothing to keep: absent, empty, whitespace.
        for bytes in [&b""[..], b" \n\t"] {
            let dir = tempfile::tempdir().unwrap();
            std::fs::write(dir.path().join("state.json"), bytes).unwrap();
            store(dir.path()).flush_now().unwrap();
            assert!(bad_copies(dir.path()).is_empty());
        }
    }

    /* ── flushes are serialised ───────────────────────────────────────────── */

    thread_local! {
        /// Runs on the flushing thread between `flush_now`'s snapshot and its
        /// write.  Thread-local, so no other test's flush ever meets it.
        static AFTER_SERIALISE: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
            std::cell::RefCell::new(None);
    }

    pub(super) fn run_after_serialise_hook() {
        if let Some(f) = AFTER_SERIALISE.with(|h| h.borrow_mut().take()) {
            f();
        }
    }

    /// Flush A snapshots, then stalls before its write (the debounce worker in
    /// its fsync); a newer edit is flushed by B (`confirm_close`).  A's older
    /// snapshot must not be the one left on disk.
    #[test]
    fn a_flush_that_snapshotted_first_cannot_land_after_a_newer_one() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        let width = |x: f64| Some(400.0 + x);
        let (snapped_tx, snapped_rx) = std::sync::mpsc::channel::<()>();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let s_ref = &*s;
        std::thread::scope(|scope| {
            let a = scope.spawn(move || {
                AFTER_SERIALISE.with(|h| {
                    *h.borrow_mut() = Some(Box::new(move || {
                        snapped_tx.send(()).unwrap();
                        let _ = release_rx.recv();
                    }));
                });
                s_ref.edit(|st| st.sidebar_w = width(1.0));
                s_ref.flush_now()
            });
            snapped_rx.recv_timeout(Duration::from_secs(10)).expect("flush A never snapshotted");

            s_ref.edit(|st| st.sidebar_w = width(2.0));
            let (b_done_tx, b_done_rx) = std::sync::mpsc::channel::<()>();
            let b = scope.spawn(move || {
                let r = s_ref.flush_now();
                let _ = b_done_tx.send(());
                r
            });
            // Unserialised, B's write lands here; serialised, B waits for A.
            let _ = b_done_rx.recv_timeout(Duration::from_millis(500));
            release_tx.send(()).unwrap();
            a.join().unwrap().unwrap();
            b.join().unwrap().unwrap();
        });

        assert_eq!(s.snapshot().sidebar_w, Some(402.0));
        assert_eq!(
            State::load(s.path()).sidebar_w,
            Some(402.0),
            "the older snapshot was renamed over the newer one"
        );
    }
}
