//! core/src/vault.rs — Owner: 02.
//! Spec: CONTRACT.md §4.2 (the `Arc<VaultSnapshot>` seam, B5/M48), §4.3 (vault
//! switch ordering, M30), §7.5 (first run, M65), §1.5 (the wire types below),
//! §3.3 (the two cap bits, M38).
//!
//! THE SNAPSHOT IS PUBLISHED LAZILY, GENERATION-INVALIDATED AND CACHED (B5).
//! spec-05 §4.1's "republish on every mutation" is STRUCK, and so is its
//! `ignore::WalkBuilder` fallback.  The cache itself lives on `tree::Vault`,
//! which is where CONTRACT §4.2 prints it.
//!
//! THE SWITCH ORDER IS A DATA-LOSS RULE (M30, §4.3):
//!   `let old = guard.take(); drop(guard); drop(old);`
//! The old snapshot is dropped OUTSIDE the lock, so tearing down a 5,000-node
//! arena does not hold every reader out.  On the JS side the editor is flushed
//! FIRST.  spec-06 §6.6's paragraph and its JS ordering are STRUCK.
//!
//! `AppState.open_note` is UPDATED ON RENAME and CLEARED ON DELETE (M54); it is
//! not allowed to go stale.

use std::path::Path;

use serde::Serialize;

use crate::error::VaultError;
use crate::scan;
use crate::tree::{SortMode, Vault};

/// CONTRACT §1.5.  `watching == false` means the refresh affordance (§0.12 E14:
/// the watcher-degraded banner's `[ Refresh ]`; it was nav slot 4 until E14)
/// MUST be lit.  `truncated` / `truncatedDepth` are the two §3.3 cap bits,
/// surfaced here so owner 01's banner can read them WITHOUT parsing the blob.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultInfo {
    pub root: String,
    pub name: String,
    pub n_notes: u32,
    pub n_dirs: u32,
    pub sort: u8,
    pub epoch: u64,
    pub last_note: Option<String>,
    /// §7.6.1 (errata 3, Z2).  The persisted expansion set for THIS vault,
    /// folders only, ALREADY truncated to `prefs::MAX_EXPANDED` and already
    /// sanitised by `State::sanitise`.  `[]` when nothing was persisted.
    /// **This is the READ PATH for what `UiPatch.expanded` writes** — it did not
    /// exist, which is why folder expansion did not survive a restart.
    /// Serialised as `expanded`.
    pub expanded: Vec<String>,
    /// §7.6.1 (errata 3, Z2).  The persisted sidebar scroll offset for THIS
    /// vault.  Finite and >= 0, clamped by `State::sanitise`; `0.0` when nothing
    /// was persisted.  Serialised as `scrollTop`.
    pub scroll_top: f64,
    pub watching: bool,
    pub truncated: bool,
    pub truncated_depth: bool,
}

/// CONTRACT §1.5 / §7.5 (M65).  A DISCRIMINATED UNION, not an
/// `Option<VaultInfo>`: spec-02 §12's design leaves a fresh install waiting
/// forever behind an empty sidebar and an empty pane with no prompt, because
/// `nc://vault-opened` never arrives.  `none` renders the
/// "Open folder as vault…" button; `loading` renders the shell and waits.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum VaultState {
    None,
    Loading,
    Open { info: VaultInfo },
}

/// CONTRACT §1.5.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentVault {
    pub root: String,
    pub name: String,
    pub exists: bool,
}

/// The whole of `open_vault`'s BLOCKING half: the §4.6 walk, the M67 temp sweep,
/// and the `Vault` that owns the arena and the lazy snapshot cache.
///
/// It does NOT touch `AppState`, emit an event, or start the watcher — those are
/// the caller's, and keeping them out of here is what lets the walk run on the
/// vault-walker thread while `setup()` returns immediately (§7.5).
///
/// Returns the vault and the number of pieces of crash debris swept, which is
/// the one thing gate G8 wants to see reach a log rather than a banner.
pub fn open_at(root: &Path, sort: SortMode, epoch: u64) -> Result<(Vault, usize), VaultError> {
    // Recover interrupted case-only renames BEFORE the walk/sweep, so the
    // note is back under its destination name before anything is scanned and
    // the sweep never sees the sole copy as debris.
    let _ = crate::fsops::recover_rename_tmps(root);
    let result = scan::walk_vault(root, sort, epoch)?;
    let swept = scan::sweep_temps(&result.sweep);
    Ok((Vault::new(result.tree), swept))
}

/// Build the §1.5 wire record from a live vault.  `watching`, `last_note`,
/// `expanded` and `scroll_top` are NOT arena state — the watcher and `prefs.rs`
/// own them — so all four are passed in rather than guessed at here.
///
/// §7.6.1 (errata 3, Z2) prints this signature.  `expanded` and `scroll_top`
/// come from `PrefsStore::view_state(&root)`, whose key is the SAME STRING as
/// `VaultInfo.root` below — see `key_agreement_view_state_is_keyed_by_the_same
/// _string_vault_info_reports` in the test module, which is §7.6.1's mandatory
/// key-agreement test.
#[must_use]
pub fn info(
    vault: &Vault,
    last_note: Option<String>,
    watching: bool,
    expanded: Vec<String>,
    scroll_top: f64,
) -> VaultInfo {
    let tree = vault.read();
    let root = tree.root_path.clone();
    VaultInfo {
        name: root
            .file_name()
            .map_or_else(|| root.display().to_string(), |n| n.to_string_lossy().into_owned()),
        // ONE SPELLING (§7.6.1).  This string is the `state.json` key: it is
        // what `save_ui_state` writes under and what `PrefsStore::view_state`
        // is looked up by, so it is written here with the SAME call those two
        // use rather than a `Display` that merely happens to agree.
        root: root.to_string_lossy().into_owned(),
        n_notes: tree.n_notes,
        n_dirs: tree.n_dirs,
        sort: tree.sort.as_u8(),
        epoch: tree.epoch,
        last_note,
        expanded,
        scroll_top,
        watching,
        truncated: tree.truncated_nodes,
        truncated_depth: tree.truncated_depth,
    }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * §7.6.1 (errata 3, Z2) — THE READ PATH'S MANDATORY TESTS
 *
 * §7.6.1 makes one of these mandatory by name: "A test asserting that a
 * `save_ui_state` write is readable back through `open_vault` on the same vault
 * is mandatory — a key that differs by one character makes this whole ruling
 * silently inert, which is exactly the failure mode it is fixing."
 *
 * That end-to-end test lives in `app.rs`
 * (`expansion_and_scroll_survive_a_quit_and_relaunch`), where both halves of the
 * seam are: it writes through `save_ui_state`, flushes to disk, builds a SECOND
 * `AppState` over the same file, and reads back through `current_vault`.  The
 * tests below pin the same key one layer lower — the string `prefs.rs` files the
 * record under against the string `vault.rs` puts in `VaultInfo.root` — because
 * those two strings are the whole of the risk and a unit test names it more
 * precisely than an integration test can.
 * ═══════════════════════════════════════════════════════════════════════════ */
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]
mod tests {
    use std::fs;

    use super::*;
    use crate::prefs::{PrefsStore, UiPatch, MAX_EXPANDED};

    /// A real one-folder vault on disk, plus a prefs store beside it.
    fn fixture() -> (tempfile::TempDir, Vault, PrefsStore) {
        let td = tempfile::tempdir().unwrap();
        fs::create_dir(td.path().join("Projects")).unwrap();
        fs::write(td.path().join("Projects/a.md"), b"a").unwrap();
        fs::write(td.path().join("Misc.md"), b"m").unwrap();
        let (vault, _) = open_at(td.path(), SortMode::NameAsc, 1).unwrap();
        let prefs = PrefsStore::load(td.path().join("state.json"));
        (td, vault, prefs)
    }

    /// §7.6.1's mandatory key-agreement test, stated as the two strings that
    /// must be one string.  `save_ui_state` writes under
    /// `vault.root().to_string_lossy()`; `VaultInfo.root` is
    /// `root_path.display().to_string()`.  If those ever diverge — a trailing
    /// slash, a canonicalisation, a `\` on some future platform — every restore
    /// reads the defaults and the whole ruling is silently inert, with no error
    /// anywhere, which is precisely the bug Z2 is fixing.
    #[test]
    fn view_state_is_keyed_by_the_string_vault_info_reports() {
        let (_td, vault, prefs) = fixture();

        // The key `app.rs::save_ui_state` uses.
        let write_key = vault.root().to_string_lossy().into_owned();
        prefs.edit(|s| {
            s.apply(
                Some(&write_key),
                &UiPatch {
                    expanded: Some(vec!["Projects".into()]),
                    scroll_top: Some(432.0),
                    ..UiPatch::default()
                },
            );
        });

        // The key every frontend consumer has: `VaultInfo.root`.
        let read_key = info(&vault, None, true, Vec::new(), 0.0).root;
        assert_eq!(read_key, write_key, "VaultInfo.root is not the state.json key");

        let (expanded, scroll_top) = prefs.view_state(&read_key);
        assert_eq!(expanded, vec!["Projects".to_string()]);
        assert!((scroll_top - 432.0).abs() < f64::EPSILON);

        // …and the whole round trip, through the widened builder, which is what
        // the frontend actually receives.
        let out = info(&vault, None, true, expanded, scroll_top);
        assert_eq!(out.expanded, vec!["Projects".to_string()]);
        assert!((out.scroll_top - 432.0).abs() < f64::EPSILON);
    }

    #[test]
    fn view_state_returns_the_defaults_for_a_vault_never_seen() {
        let (_td, _vault, prefs) = fixture();
        let (expanded, scroll_top) = prefs.view_state("/nowhere/at/all");
        assert!(expanded.is_empty());
        assert!((scroll_top - 0.0).abs() < f64::EPSILON);
    }

    /// §7.6.1: "`expanded` comes back truncated at 2,000 and `scroll_top` comes
    /// back `0.0` for a persisted NaN/negative."  The caller does NOT
    /// re-validate, so the reader is where that has to be true.
    #[test]
    fn view_state_comes_back_already_truncated_and_already_clamped() {
        let (_td, vault, prefs) = fixture();
        let key = vault.root().to_string_lossy().into_owned();
        let many: Vec<String> = (0..MAX_EXPANDED + 500).map(|i| format!("d{i}")).collect();

        prefs.edit(|s| {
            s.apply(
                Some(&key),
                &UiPatch { expanded: Some(many), scroll_top: Some(90.0), ..UiPatch::default() },
            );
            // A NaN and a negative are REFUSED by `apply`, so the last good
            // value stands — never NaN, never < 0, on either path.
            s.apply(Some(&key), &UiPatch { scroll_top: Some(f64::NAN), ..UiPatch::default() });
            s.apply(Some(&key), &UiPatch { scroll_top: Some(-5.0), ..UiPatch::default() });
        });

        let (expanded, scroll_top) = prefs.view_state(&key);
        assert_eq!(expanded.len(), MAX_EXPANDED);
        assert!(scroll_top.is_finite() && scroll_top >= 0.0, "scroll_top = {scroll_top}");
        assert!((scroll_top - 90.0).abs() < f64::EPSILON);
    }

    /// A `state.json` that a power cut or a hand edit left holding a NaN cannot
    /// reach the wire either: `State::sanitise` runs on load, and `view_state`
    /// reads what sanitise left.  `f64::NAN` is not valid JSON, so the corrupt
    /// value that actually occurs is `null` / a negative.
    #[test]
    fn a_negative_scroll_top_on_disk_is_zero_by_the_time_it_reaches_the_wire() {
        let td = tempfile::tempdir().unwrap();
        let path = td.path().join("state.json");
        fs::write(
            &path,
            br#"{"v":1,"vault":"/V","vaults":{"/V":{"expanded":["A"],"scroll_top":-17.5}}}"#,
        )
        .unwrap();
        let prefs = PrefsStore::load(path);
        let (expanded, scroll_top) = prefs.view_state("/V");
        assert_eq!(expanded, vec!["A".to_string()]);
        assert!((scroll_top - 0.0).abs() < f64::EPSILON, "scroll_top = {scroll_top}");
    }

    /// The two new fields are camelCase on the wire (§1.1's casing rule, X13),
    /// which is what `src/ipc.d.ts`'s `expanded` / `scrollTop` are transcribed
    /// against.  A `#[serde(rename_all)]` lost in a refactor is invisible in
    /// Rust and breaks the frontend silently.
    #[test]
    fn the_two_new_fields_are_camel_case_on_the_wire() {
        let (_td, vault, _prefs) = fixture();
        let j = serde_json::to_string(&info(
            &vault,
            None,
            true,
            vec!["Projects".into()],
            432.0,
        ))
        .unwrap();
        assert!(j.contains(r#""expanded":["Projects"]"#), "{j}");
        assert!(j.contains(r#""scrollTop":432.0"#), "{j}");
        assert!(!j.contains("scroll_top"), "{j}");
    }

}
