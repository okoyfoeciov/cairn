//! The watcher as the frontend sees it: through `app.rs`'s event mapping, with
//! F8/F67/F14/F13 — the watcher as the frontend sees it, through `app.rs`'s event mapping, with
//! a recording `AppCtx` standing in for the shell.  Temp vaults only, and no
//! prefs store is ever initialised, so nothing here touches `state.json`.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use cairn_lib::app::{self, AppCtx};
use cairn_lib::fsops;
use cairn_lib::note_frame::WriteArgs;
use cairn_lib::vault::VaultState;
use cairn_lib::AppState;

#[derive(Clone)]
struct Rec {
    state: Arc<AppState>,
    events: Arc<Mutex<Vec<(String, serde_json::Value)>>>,
}

impl Rec {
    fn new() -> Self {
        Self { state: Arc::new(AppState::new()), events: Arc::default() }
    }

    fn clear(&self) {
        self.events.lock().unwrap().clear();
    }

    /// The payload of the first `name` event recorded within `dur`.
    fn wait(&self, name: &str, dur: Duration) -> Option<serde_json::Value> {
        let deadline = Instant::now() + dur;
        loop {
            if let Some((_, v)) = self.events.lock().unwrap().iter().find(|(n, _)| n == name) {
                return Some(v.clone());
            }
            if Instant::now() >= deadline {
                return None;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

impl AppCtx for Rec {
    fn emit_event<S: serde::Serialize + Clone>(&self, event: &str, payload: S) {
        let v = serde_json::to_value(payload).unwrap_or(serde_json::Value::Null);
        self.events.lock().unwrap().push((event.to_string(), v));
    }
    fn app_state(&self) -> &AppState {
        &self.state
    }
    fn quit(&self, _code: i32) {}
}

fn runtime() -> &'static tokio::runtime::Runtime {
    static RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RT.get_or_init(|| {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .max_blocking_threads(6)
            .build()
            .unwrap();
        cairn_lib::runtime::set(rt.handle().clone());
        rt
    })
}

fn base() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let base = fsops::canonical_root(dir.path()).unwrap();
    (dir, base)
}

fn open(ctx: &Rec, root: &Path) {
    app::open_vault_blocking(ctx, &ctx.state, root.to_str().unwrap()).unwrap();
    // Let the watch settle; the epoch guard compares a coarse ctime against a
    // fine clock, so a write in the same jiffy as `start` can read as history.
    std::thread::sleep(Duration::from_millis(300));
}

/// §7.3 case 8, when the vault's PARENT is renamed: the root's own inode
/// never moves, so no event names it.  The UI must still be told, and the
/// vault must stop being `Open` — otherwise every autosave fails silently.
#[test]
fn an_ancestor_rename_surfaces_vault_lost_and_drops_the_vault() {
    let (_d, base) = base();
    let root = base.join("Sync/Notes");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("Open.md"), b"typed before\n").unwrap();
    let ctx = Rec::new();
    open(&ctx, &root);

    std::fs::rename(base.join("Sync"), base.join("Syncthing")).unwrap();

    let lost = ctx.wait("nc://vault-lost", Duration::from_secs(5));
    assert_eq!(
        lost.as_ref().and_then(|v| v["path"].as_str()),
        Some(root.to_str().unwrap()),
        "no nc://vault-lost after the vault's parent folder was renamed"
    );
    assert!(matches!(app::current_vault(&ctx.state), VaultState::None));
}

/// An atomic save by another program reaches the open note; our own atomic
/// save, which has the same shape on disk, does not.
#[test]
fn an_external_rename_over_the_open_note_reaches_the_editor_and_ours_does_not() {
    let (_d, root) = base();
    let note = root.join("Open.md");
    std::fs::write(&note, b"before\n").unwrap();
    let ctx = Rec::new();
    open(&ctx, &root);
    app::read_note(&ctx.state, "Open.md").unwrap();

    // Ours first: an autosave through the real command.
    let base_mtime = fsops::mtime_ms(&std::fs::metadata(&note).unwrap());
    let args = WriteArgs { rel: "Open.md".into(), flags: 0, base_mtime_ms: Some(base_mtime), create: false };
    app::write_note(&ctx, &ctx.state, &args, b"typed in cairn\n").unwrap();
    assert_eq!(
        ctx.wait("nc://note-external-change", Duration::from_millis(1500)),
        None,
        "our own save echoed back as an external change"
    );

    // Theirs: `sed -i` / gedit / Kate shape.
    let tmp = root.join(".Open.md.swp");
    std::fs::write(&tmp, b"saved elsewhere\n").unwrap();
    std::fs::rename(&tmp, &note).unwrap();
    let ev = ctx.wait("nc://note-external-change", Duration::from_secs(5));
    assert_eq!(
        ev.as_ref().and_then(|v| v["path"].as_str()),
        Some("Open.md"),
        "an external rename-over of the open note never reached the editor"
    );
    assert_eq!(ev.as_ref().and_then(|v| v["size"].as_u64()), Some(16));
}

/* ── Refresh re-arms a watcher that went partly blind (Linux) ─────────────── */

/// Finds this process's inotify watch on `dir` and removes it — what an
/// overflowed queue or a watch-limit error leaves behind for a directory
/// whose create event was lost.  Returns false if no such watch exists.
#[cfg(target_os = "linux")]
fn drop_inotify_watch(dir: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    let ino = std::fs::metadata(dir).unwrap().ino();
    let mut found = false;
    for fd in std::fs::read_dir("/proc/self/fd").unwrap().flatten() {
        let link = std::fs::read_link(fd.path()).unwrap_or_default();
        if link.to_string_lossy() != "anon_inode:inotify" {
            continue;
        }
        let Some(n) = fd.file_name().to_str().and_then(|s| s.parse::<i32>().ok()) else { continue };
        let info = std::fs::read_to_string(format!("/proc/self/fdinfo/{n}")).unwrap_or_default();
        for line in info.lines().filter(|l| l.starts_with("inotify wd:")) {
            let field = |k: &str| {
                line.split_whitespace()
                    .find_map(|t| t.strip_prefix(k))
                    .and_then(|v| u64::from_str_radix(v, 16).ok())
            };
            if field("ino:") == Some(ino) {
                let wd = field("wd:").unwrap() as i32;
                // SAFETY: plain syscall on an fd this process owns.
                assert_eq!(unsafe { libc::inotify_rm_watch(n, wd) }, 0);
                found = true;
            }
        }
    }
    found
}

#[cfg(target_os = "linux")]
#[test]
fn refresh_rearms_a_watcher_that_lost_a_directory() {
    let (_d, root) = base();
    std::fs::create_dir(root.join("sub")).unwrap();
    std::fs::write(root.join("a.md"), b"a\n").unwrap();
    let ctx = Rec::new();
    open(&ctx, &root);

    assert!(drop_inotify_watch(&root.join("sub")), "premise: sub/ was being watched");
    ctx.clear();
    std::fs::write(root.join("sub/x.md"), b"x\n").unwrap();
    assert_eq!(
        ctx.wait("nc://tree-changed", Duration::from_millis(1000)),
        None,
        "premise: the watcher is blind to sub/"
    );

    let info = runtime().block_on(app::rescan_all(ctx.clone())).unwrap();
    assert!(info.watching);
    std::thread::sleep(Duration::from_millis(100));
    ctx.clear();

    std::fs::write(root.join("sub/y.md"), b"y\n").unwrap();
    assert!(
        ctx.wait("nc://tree-changed", Duration::from_secs(5)).is_some(),
        "Refresh left the watcher blind to a directory it had lost"
    );
}

/// F13: the scanner never admits symlinks, so the watcher must not follow
/// them either. A linked tree must stay out of the tree AND unwatched —
/// otherwise a change inside it fires events for rows that do not exist.
#[test]
fn a_symlinked_tree_is_neither_listed_nor_watched() {
    let (_d, root) = base();
    std::fs::write(root.join("Real.md"), b"real\n").unwrap();
    // The linked tree lives OUTSIDE the vault: nothing under it may be listed.
    let outer = tempfile::tempdir().unwrap();
    let outside = outer.path().join("outside");
    std::fs::create_dir(&outside).unwrap();
    std::fs::write(outside.join("Linked.md"), b"linked\n").unwrap();
    std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
    let ctx = Rec::new();
    open(&ctx, &root);

    let rels: Vec<String> = {
        let v = ctx.state.vault().expect("vault");
        v.snapshot().files.iter().map(|f| f.rel.to_string()).collect()
    };
    assert!(!rels.iter().any(|r| r.contains("Linked")), "the scanner admitted a linked note: {rels:?}");

    ctx.clear();
    std::fs::write(outside.join("Linked.md"), b"linked changed\n").unwrap();
    assert_eq!(
        ctx.wait("nc://tree-changed", Duration::from_millis(1500)),
        None,
        "the watcher followed a symlink the scanner refuses"
    );
}
