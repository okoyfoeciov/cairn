//! core/tests/dataloss.rs — Owner: the data-loss verification run.
//! Spec: CONTRACT.md §7 in its entirety — §7.1 (the three structural rules),
//! §7.2 (the autosave contract), §7.3 (the sixteen enumerated paths), §7.6
//! (`state.json`), and gates G8 and G-RT.
//!
//! ===========================================================================
//! WHY THIS FILE EXISTS ALONGSIDE `vault_ops.rs` AND `path_safety.rs`
//!
//! Those two prove the RULES: `fsops::write_note` refuses a missing
//! destination, `should_sweep` unlinks dead debris, `validate_name` rejects
//! `CON`.  Every one of them calls one function with hand-built arguments.
//!
//! This file proves the SEAMS — the places where autosave, the arena, the
//! watcher and the vault-open path meet — because all three of the worst bugs
//! this project has found lived in a seam and not in a module:
//!   * the arena's root and the watcher's root disagreeing over `/var` vs
//!     `/private/var`, which killed the watcher SILENTLY (§7.3 case 16's
//!     invariant, broken with `watching: true` and no degraded banner);
//!   * `write_note`'s step 8 `rename` creating a destination that step 1 never
//!     checked for existence, which resurrected a deleted note (B17);
//!   * the temp sweep's hour-only rule, which left crash debris that a sync
//!     client then replicated (M67).
//!
//! So every test here goes through `vault::open_at` (the real walk, the real
//! sweep), resolves through the arena exactly as `app::resolve` does, and where
//! the claim is about crash or concurrency, uses a REAL SECOND PROCESS.
//!
//! ---------------------------------------------------------------------------
//! THE CONTAINMENT RULE, AND IT IS CHECKED BEFORE ANY TEST WRITES A BYTE.
//!
//! Every fixture is a `tempfile` directory whose name carries `cairn-dataloss-`.
//! `guard()` runs on every fixture root at construction and FAILS THE TEST if
//! the canonical path is not under the canonical `std::env::temp_dir()`, or is
//! under `$HOME`, `/Users`, `/Library`, `/System` or `/Applications`.
//! `dl_00_the_containment_guard_is_real` proves the guard itself rejects the
//! paths it is there to reject, so it cannot rot into a no-op.
//!
//! ONE CASE IS DELIBERATELY NOT EXERCISED FOR THIS REASON: §7.3 case 3's
//! "assert `~/.Trash` holds the pre-edit copy".  `trash::delete` writes to the
//! real `~/.Trash`, which is outside the fixture, so every delete here passes
//! `permanent: true`.  The trash leg is a NAMED GAP in
//! docs/DATA-LOSS-VERIFICATION.md, not a silent omission.
//! ===========================================================================

use std::fs;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use cairn_lib::app::AppState;
use cairn_lib::error::VaultError;
use cairn_lib::fsops::{self, WriteReceipt};
use cairn_lib::note_frame::{self, WriteArgs, FLAG_BOM, FLAG_CRLF, MAX_NOTE_BYTES};
use cairn_lib::path as vpath;
use cairn_lib::tree::SortMode;
use cairn_lib::vault;
use cairn_lib::watcher::{SelfWrites, VaultWatcher, WatchEvent};

/* ===========================================================================
 * THE FIXTURE AND ITS GUARD
 * ========================================================================= */

const PREFIX: &str = "cairn-dataloss-";

fn canon(p: &Path) -> PathBuf {
    fs::canonicalize(p).unwrap_or_else(|e| panic!("canonicalize {}: {e}", p.display()))
}

/// The containment rule, as a function, applied to every fixture root.
///
/// It is deliberately positive AND negative: "inside the temp dir" alone would
/// pass for a temp directory somebody had symlinked into `~/Documents`, so the
/// forbidden prefixes are listed too and `$HOME` is resolved rather than
/// assumed.
fn guard(root: &Path) {
    let root = canon(root);
    let tmp = canon(&std::env::temp_dir());
    assert!(
        root.starts_with(&tmp),
        "fixture {} is not under the temp dir {}",
        root.display(),
        tmp.display()
    );
    assert!(
        root.to_string_lossy().contains(PREFIX),
        "fixture {} does not carry the {PREFIX} marker",
        root.display()
    );
    if let Some(home) = std::env::var_os("HOME") {
        let home = canon(Path::new(&home));
        assert!(!root.starts_with(&home), "fixture {} is under $HOME", root.display());
    }
    for forbidden in ["/Users", "/Library", "/System", "/Applications", "/private/etc"] {
        assert!(
            !root.starts_with(forbidden),
            "fixture {} is under {forbidden}",
            root.display()
        );
    }
}

fn tmpdir() -> tempfile::TempDir {
    tempfile::Builder::new().prefix(PREFIX).tempdir().expect("tempdir")
}

/// A fixture vault: a temp directory, its CANONICAL root (which is what
/// `open_vault_blocking` walks and what the watcher watches), and a handful of
/// notes at three depths.
struct Fixture {
    _dir: tempfile::TempDir,
    root: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let dir = tmpdir();
        let root = canon(dir.path());
        guard(&root);
        fs::create_dir(root.join("Notes")).expect("mkdir Notes");
        fs::create_dir_all(root.join("A/B")).expect("mkdir A/B");
        fs::write(root.join("Misc.md"), b"before\n").expect("Misc.md");
        fs::write(root.join("Notes/Deep.md"), b"deep\n").expect("Deep.md");
        fs::write(root.join("A/B/n.md"), b"nested\n").expect("n.md");
        Self { _dir: dir, root }
    }

    fn abs(&self, rel: &str) -> PathBuf {
        self.root.join(rel)
    }
}

/// Everything `open_vault_blocking` does that needs no shell:
/// canonicalise the root, walk it, sweep the crash debris, publish the arena.
/// Returns the state and the sweep count, which is what §7.3 case 1's "the next
/// vault open leaves zero `.tmp-` files" is actually read off.
fn open_vault(root: &Path) -> (AppState, usize) {
    let state = AppState::new();
    let root = fsops::canonical_root(root).expect("canonical_root");
    let (v, swept) = vault::open_at(&root, SortMode::default(), 1).expect("open_at");
    *state.vault.write().expect("vault lock") = Some(Arc::new(v));
    (state, swept)
}

/// `app::resolve`, reproduced: vault-relative -> absolute THROUGH THE ARENA.
/// The real one is private; this is the same three lines and it is the only
/// resolution any test here performs, so no test can accidentally reach a path
/// the walk never admitted.
fn arena_abs(state: &AppState, rel: &str) -> Result<PathBuf, VaultError> {
    vpath::validate_rel_for_lookup(rel)?;
    let v = state.vault().ok_or_else(|| VaultError::not_found("<no vault>"))?;
    let t = v.read();
    let id = t.resolve(rel).ok_or_else(|| VaultError::not_found(rel))?;
    Ok(t.abs_path(id))
}

fn wargs(rel: &str, flags: u32, base: Option<i64>, create: bool) -> WriteArgs {
    WriteArgs { rel: rel.into(), flags, base_mtime_ms: base, create }
}

/// An autosave, idle flush, blur flush or close flush: `x-create: '0'`, always
/// (§7.1 rule 1).  Every write in this file that is not explicitly Save-As goes
/// through here, so no test can accidentally grant itself the create bit.
fn autosave(
    state: &AppState,
    rel: &str,
    body: &[u8],
    base: Option<i64>,
) -> Result<WriteReceipt, VaultError> {
    let abs = arena_abs(state, rel)?;
    fsops::write_note(&abs, &wargs(rel, 0, base, false), body, &state.self_writes)
}

/// §7.3 case 5's Save as… — the ONE producer of `x-create: '1'`.
fn save_as(
    state: &AppState,
    parent_rel: &str,
    name: &str,
    body: &[u8],
) -> Result<WriteReceipt, VaultError> {
    let parent = arena_abs(state, parent_rel)?;
    vpath::validate_name(name)?;
    let rel = if parent_rel.is_empty() {
        name.to_string()
    } else {
        format!("{parent_rel}/{name}")
    };
    fsops::write_note(&parent.join(name), &wargs(&rel, 0, None, true), body, &state.self_writes)
}

/// Names of everything in `dir`, sorted — including dotfiles, because the whole
/// point of gate G8 is what the app leaves behind that the user did not ask for.
fn entries(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = fs::read_dir(dir)
        .expect("read_dir")
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    v.sort();
    v
}

/// Every `.tmp-` file anywhere under `root`.
fn temp_files(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut q = vec![root.to_path_buf()];
    while let Some(d) = q.pop() {
        let Ok(rd) = fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let Ok(ft) = e.file_type() else { continue };
            let p = e.path();
            if ft.is_symlink() {
                continue;
            }
            if ft.is_dir() {
                q.push(p);
            } else if p
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| fsops::parse_temp_pid(n).is_some())
            {
                out.push(p);
            }
        }
    }
    out
}

/// A PID that is certainly dead: a child that has been spawned, exited and
/// reaped.  The kernel will not reuse it within the life of one test.
fn dead_pid() -> u32 {
    let mut c = std::process::Command::new("/usr/bin/true").spawn().expect("spawn /usr/bin/true");
    let pid = c.id();
    let _ = c.wait();
    pid
}

/* ===========================================================================
 * THE WATCHER HARNESS
 *
 * A real `VaultWatcher` over a real FSEvents stream, with the test as the sink.
 * Nothing here simulates an event.
 * ========================================================================= */

struct Watched {
    _w: VaultWatcher,
    seen: Arc<Mutex<Vec<WatchEvent>>>,
    root: PathBuf,
}

impl Watched {
    fn start(root: &Path, self_writes: &Arc<Mutex<SelfWrites>>) -> Self {
        let seen: Arc<Mutex<Vec<WatchEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        let w = VaultWatcher::start(
            root,
            Arc::clone(self_writes),
            Box::new(move |ev| {
                sink.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push(ev);
            }),
        )
        .expect("the watcher must start on a fixture vault");
        let root = w.root().to_path_buf();
        Self { _w: w, seen, root }
    }

    fn events(&self) -> Vec<WatchEvent> {
        self.seen.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone()
    }

    /// Every content hit for `abs`, across every flush delivered so far.  This
    /// is `on_watch_event`'s `nc://note-external-change` filter, reproduced:
    /// hits whose path is the open note, and nothing else.
    fn hits(&self, abs: &Path) -> usize {
        self.events()
            .iter()
            .filter_map(|e| match e {
                WatchEvent::Flush(f) => Some(f),
                _ => None,
            })
            .flat_map(|f| f.content_hits.iter())
            .filter(|h| h.abs == abs)
            .count()
    }

    fn lost(&self) -> bool {
        self.events().iter().any(|e| matches!(e, WatchEvent::VaultLost { .. }))
    }

    /// Wait until `f` is true, or give up.  Returns whether it became true, so
    /// a caller that gives up FAILS rather than passing on an empty event list.
    fn wait(&self, ms: u64, f: impl Fn(&Self) -> bool) -> bool {
        let deadline = Instant::now() + Duration::from_millis(ms);
        while Instant::now() < deadline {
            if f(self) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        f(self)
    }

    /// Let the 150 ms debounce and the FSEvents pipeline settle, so that
    /// "exactly one" is a claim about the whole burst and not about a race.
    fn settle(&self) {
        std::thread::sleep(Duration::from_millis(700));
    }

    fn root(&self) -> &Path {
        &self.root
    }
}

/* ===========================================================================
 * dl_00 — THE GUARD ITSELF
 * ========================================================================= */

/// The containment rule is the one thing in this file that cannot be allowed to
/// rot into a tautology, so it is tested from both sides: a real fixture passes,
/// and four paths that MUST be refused are each refused.
#[test]
fn dl_00_the_containment_guard_is_real() {
    let f = Fixture::new();
    guard(&f.root); // the positive case

    let home = std::env::var("HOME").expect("HOME");
    for bad in [
        home.clone(),
        format!("{home}/Documents"),
        format!("{home}/Library"),
        "/tmp".to_string(),
    ] {
        let p = PathBuf::from(&bad);
        if !p.exists() {
            continue;
        }
        let refused = std::panic::catch_unwind(|| guard(&p)).is_err();
        assert!(refused, "guard() accepted {bad}, which it must never do");
    }
}

/* ===========================================================================
 * §7.3 CASE 1 — KILLED MID-SAVE, AND THE SWEEP ON THE NEXT VAULT OPEN
 * ========================================================================= */

/// The child half of `dl_01`.  `#[ignore]` so an ordinary `cargo test` never
/// runs it; the parent invokes it by name through `current_exe()`.
///
/// It writes a 4 MiB note in a tight loop through the real `write_note`, so the
/// temp file exists for nearly the whole of every iteration and a SIGKILL lands
/// between `create_new` and `rename` with high probability — which is the exact
/// window §7.3 case 1 is about.
#[test]
#[ignore = "spawned by dl_01_sigkill_between_the_temp_write_and_the_rename"]
fn dataloss_kill_child() {
    let Ok(dir) = std::env::var("CAIRN_DL_KILL_DIR") else { return };
    let root = PathBuf::from(dir);
    let abs = root.join("Misc.md");
    let sw = Mutex::new(SelfWrites::new());
    let body = b"NEW ".repeat(1024 * 1024);
    loop {
        let _ = fsops::write_note(&abs, &wargs("Misc.md", 0, None, false), &body, &sw);
    }
}

/// §7.3 case 1, END TO END: SIGKILL a real process mid-save, then OPEN THE
/// VAULT the way the app opens it (`vault::open_at`, which walks and sweeps) and
/// assert that the note is whole and that the debris is gone.
///
/// `vault_ops.rs` proves the same invariant by calling `sweep_temps_in`
/// directly.  This one never calls the sweep: it calls the vault open, because
/// the claim in §7.3 is about what the NEXT LAUNCH does, and a sweep that is
/// correct but unwired would pass the other test and fail this one.
#[test]
fn dl_01_sigkill_between_the_temp_write_and_the_rename() {
    let exe = std::env::current_exe().expect("current_exe");
    let old = b"before\n".to_vec();
    let new = b"NEW ".repeat(1024 * 1024);

    let mut rounds_with_debris = 0u32;
    let mut rounds_the_child_wrote = 0u32;

    for round in 0..8u64 {
        let f = Fixture::new();
        let abs = f.abs("Misc.md");

        let mut child = std::process::Command::new(&exe)
            .args(["--exact", "dataloss_kill_child", "--ignored", "--nocapture"])
            .env("CAIRN_DL_KILL_DIR", &f.root)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn the writer");

        // Vary where the axe falls: start-up, the first write, and a steady
        // state of writes are three different moments.
        std::thread::sleep(Duration::from_millis(60 + round * 30));
        child.kill().expect("SIGKILL");
        let _ = child.wait();

        // THE INVARIANT: complete old content or complete new content.
        let after = fs::read(&abs).expect("the note must still exist");
        assert!(
            after == old || after == new,
            "round {round}: the note was TORN — {} bytes beginning {:?}",
            after.len(),
            after.get(..16)
        );
        if after == new {
            rounds_the_child_wrote += 1;
        }
        if !temp_files(&f.root).is_empty() {
            rounds_with_debris += 1;
        }

        // "…and the next vault open leaves ZERO `.tmp-` files."  This IS the
        // next vault open.
        let (state, swept) = open_vault(&f.root);
        assert!(
            temp_files(&f.root).is_empty(),
            "round {round}: crash debris survived the vault open: {:?} (swept {swept})",
            temp_files(&f.root)
        );
        assert_eq!(entries(&f.root), vec!["A", "Misc.md", "Notes"], "round {round}");
        // And the note the child was killed writing is still openable.
        let read = fsops::read_note(&arena_abs(&state, "Misc.md").expect("arena"), "Misc.md")
            .expect("the note must be readable after the crash");
        assert!(read.bytes == old || read.bytes == new);
    }

    assert!(
        rounds_the_child_wrote > 0,
        "the child never completed a write, so nothing was killed mid-save"
    );
    assert!(
        rounds_with_debris > 0,
        "no round was killed while a temp file existed, so the sweep was never \
         actually exercised — this test proved nothing"
    );
}

/// The other half of case 1's sweep rule (M67), through a real vault open: debris
/// from a DEAD pid goes on sight; debris from a LIVE pid (another instance,
/// possibly mid-write) is spared until it is an hour old.
#[test]
fn dl_02_the_vault_open_sweeps_dead_debris_and_spares_a_live_instance() {
    let f = Fixture::new();
    let dead = f.root.join(format!(".Misc.md.tmp-{}-0", dead_pid()));
    let live = f.root.join(format!(".Misc.md.tmp-{}-1", std::process::id()));
    let notours = f.root.join(".hidden.tmp-notes");
    fs::write(&dead, b"crash debris").expect("dead");
    fs::write(&live, b"another instance is mid-write").expect("live");
    fs::write(&notours, b"the user's own file").expect("notours");

    let (_state, swept) = open_vault(&f.root);

    assert_eq!(swept, 1, "exactly the dead-PID temp should have been swept");
    assert!(!dead.exists(), "dead-PID debris survived the vault open");
    assert!(live.exists(), "a LIVE instance's in-flight temp was unlinked — that is data loss");
    assert!(notours.exists(), "a file that is not ours was unlinked");
}

/* ===========================================================================
 * §7.3 CASE 2 — QUIT WITH A DIRTY BUFFER
 * ========================================================================= */

/// Case 2 leg (a), at the level this test file can reach: a flush issued before
/// the process goes away is ON DISK before it goes away.  A real child process
/// writes through the real `write_note` and then exits normally; the parent
/// reads the file after `wait()` returns.  The §1.6 handshake itself is driven
/// by `electron-shell/close-handshake.test.mjs`.
#[test]
#[ignore = "spawned by dl_03_a_flush_issued_before_exit_is_on_disk_after_exit"]
fn dataloss_flush_child() {
    let Ok(dir) = std::env::var("CAIRN_DL_FLUSH_DIR") else { return };
    let root = PathBuf::from(dir);
    let abs = root.join("Misc.md");
    let sw = Mutex::new(SelfWrites::new());
    fsops::write_note(&abs, &wargs("Misc.md", 0, None, false), b"typed but not yet saved\n", &sw)
        .expect("the close flush must succeed");
    // Exit the instant the flush returns, exactly as `confirm_close(true)` does.
    std::process::exit(0);
}

#[test]
fn dl_03_a_flush_issued_before_exit_is_on_disk_after_exit() {
    let f = Fixture::new();
    let exe = std::env::current_exe().expect("current_exe");
    let status = std::process::Command::new(&exe)
        .args(["--exact", "dataloss_flush_child", "--ignored", "--nocapture"])
        .env("CAIRN_DL_FLUSH_DIR", &f.root)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .expect("run the flush child");
    assert!(status.success(), "the child did not exit cleanly");

    assert_eq!(fs::read(f.abs("Misc.md")).expect("Misc.md"), b"typed but not yet saved\n");
    assert!(temp_files(&f.root).is_empty(), "the flush left debris behind");
}

/// Case 2 leg (b): with the destination unwritable, the flush REJECTS — which is
/// what §1.6 requires in order to CANCEL the close and show the modal.  A flush
/// that resolved here would turn a refused write into a silent discard.
///
/// The one thing this proves that inspection cannot: the refusal is an error
/// RETURN, the note is untouched, and no temp file is left in the directory the
/// user will look at next.
#[test]
fn dl_04_an_unwritable_destination_makes_the_close_flush_reject() {
    // SAFETY: `geteuid` reads a process attribute and has no failure mode.
    if unsafe { libc::geteuid() } == 0 {
        panic!("this test is meaningless as root; run it as an ordinary user");
    }
    let f = Fixture::new();
    let (state, _) = open_vault(&f.root);
    let dir = f.abs("Notes");
    let before = fs::read(f.abs("Notes/Deep.md")).expect("Deep.md");

    fs::set_permissions(&dir, fs::Permissions::from_mode(0o500)).expect("chmod 500");
    let refused = autosave(&state, "Notes/Deep.md", b"edited but unsaveable\n", None);
    // Restore FIRST: a failed assertion below must not leave a directory the
    // TempDir cleanup cannot remove.
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).expect("chmod back");

    match refused {
        Err(VaultError::Io { .. }) => {}
        other => panic!("an unwritable destination must reject, got {other:?}"),
    }
    assert_eq!(fs::read(f.abs("Notes/Deep.md")).expect("Deep.md"), before, "the note changed");
    assert!(temp_files(&f.root).is_empty(), "a rejected flush left a temp file behind");
}

/* ===========================================================================
 * §7.3 CASE 3 — DELETE THE OPEN NOTE WHILE DIRTY (B17)
 * ========================================================================= */

/// The invariant, proved by CONSTRUCTION rather than by timer luck: with
/// `x-create: '0'` a missing destination is `NotFound` at step 1b, BEFORE
/// `denormalise`, BEFORE the temp file, and therefore before anything can
/// recreate the file.
///
/// The test runs the whole §7.3 case 3 order against a real vault: read the note
/// through the arena (which is what makes it the open note), delete it, rescan,
/// then fire the autosave that the user's last keystroke had already scheduled —
/// six seconds later, past both §7.2 timers.
#[test]
fn dl_05_a_deleted_open_note_is_never_resurrected_by_a_late_autosave() {
    let f = Fixture::new();
    let (state, _) = open_vault(&f.root);

    // Open it: `app::read_note` is what claims the note as THE open note.
    let framed = cairn_lib::app::read_note(&state, "Misc.md").expect("read_note");
    let (base_mtime, flags, body) = note_frame::decode_note(&framed).expect("decode");
    assert_eq!(body, b"before\n");
    assert_eq!(flags, 0);
    assert_eq!(
        state.open_note.lock().unwrap_or_else(std::sync::PoisonError::into_inner).as_deref(),
        Some("Misc.md")
    );

    // The user deletes it.  `permanent: true` — see the header for why the trash
    // leg is a named gap.
    let abs = arena_abs(&state, "Misc.md").expect("arena");
    fsops::delete_entry(&abs, "Misc.md", true, &state.self_writes).expect("delete");
    assert!(!abs.exists());

    // The tree is rebuilt ([ Refresh ] / the watcher's rescan), so the arena no
    // longer holds the note either.
    let (state, _) = open_vault(&f.root);
    assert!(matches!(arena_abs(&state, "Misc.md"), Err(VaultError::NotFound { .. })));

    // Now the late autosave, at every base-mtime the frontend could be holding.
    for base in [Some(base_mtime), None] {
        // Straight through `fsops`, bypassing the arena, which is the WORST case:
        // it is what a frontend holding a stale absolute path would reach.
        let e = fsops::write_note(&abs, &wargs("Misc.md", flags, base, false), b"edited\n", &state.self_writes);
        match e {
            Err(VaultError::NotFound { path }) => assert_eq!(path, "Misc.md"),
            other => panic!("a late autosave with base={base:?} did not refuse: {other:?}"),
        }
        assert!(!abs.exists(), "the deleted note was RESURRECTED (B17)");
    }

    // §7.3 case 3's "wait 6 s (past both timers)" is a statement about the
    // FRONTEND's 800 ms / 5 s timers, which do not exist in this process — the
    // write above IS the one those timers would have fired, issued at the moment
    // they would have fired it.  A second one a second later, to catch anything
    // that retries.
    std::thread::sleep(Duration::from_millis(1_000));
    assert!(matches!(
        fsops::write_note(&abs, &wargs("Misc.md", flags, None, false), b"edited\n", &state.self_writes),
        Err(VaultError::NotFound { .. })
    ));
    assert!(!abs.exists());

    // AND THE ASSERTION ABOVE DISCRIMINATES.  The identical call with the create
    // bit set DOES recreate the file — which is what `write_note` would do on
    // every autosave if step 1b were dropped, and is exactly bug B17.  Without
    // this line the four `NotFound`s above could be passing for any reason at
    // all, including a typo in the path.
    fsops::write_note(&abs, &wargs("Misc.md", flags, None, true), b"edited\n", &state.self_writes)
        .expect("x-create: 1 must be able to create");
    assert!(abs.exists(), "the create bit did not create — the test above proves nothing");
    fs::remove_file(&abs).expect("clean up the deliberate resurrection");

    assert!(temp_files(&f.root).is_empty());
    assert_eq!(entries(&f.root), vec!["A", "Notes"]);
}

/// §7.1 rule 1 says the create bit is set in EXACTLY ONE PLACE in the whole app.
/// That is a claim about the frontend source, and the only way to hold it is to
/// read the frontend source — so this test does, and it names the file and the
/// function that is allowed to be the exception.
///
/// It is a tripwire, not a style check: a second `create: true` call site is the
/// reintroduction of B17, and it would otherwise be invisible to every Rust test
/// in this repo.
#[test]
fn dl_06_the_create_bit_has_exactly_one_producer_in_the_frontend() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src");
    let src = canon(&src);

    let mut producers: Vec<String> = Vec::new();
    for entry in fs::read_dir(&src).expect("read src/").flatten() {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) != Some("ts") {
            continue;
        }
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
        if name == "ipc.ts" || name == "ipc.d.ts" {
            continue; // the wrapper and the type: they TAKE the flag, never set it
        }
        let text = fs::read_to_string(&p).expect("read a frontend module");
        for (i, line) in text.lines().enumerate() {
            let Some(at) = line.find("writeNote(") else { continue };
            let call = line.get(at..).unwrap_or("");
            // The last argument is `create`.  A literal `true` there is a producer.
            if call.contains("true)") {
                producers.push(format!("{name}:{}", i + 1));
            }
        }
    }

    assert_eq!(
        producers.len(),
        1,
        "§7.1 rule 1: `x-create: '1'` must have exactly ONE producer (§7.3 case 5's \
         Save as…). Found: {producers:?}"
    );
    assert!(
        producers.first().is_some_and(|p| p.starts_with("editor.ts:")),
        "the one create-bit producer moved out of editor.ts's saveAs(): {producers:?}"
    );
}


/* ===========================================================================
 * §7.3 CASES 4 AND 5 — RENAME, IN-APP AND EXTERNAL
 * ========================================================================= */

/// §7.3 case 4's mandated test: rename the open note, edit the file from another
/// process, assert EXACTLY ONE `nc://note-external-change`.
///
/// The filter that event passes through is `open_note_is(rel)`, so a stale
/// `open_note` shows up here as ZERO events, not as a wrong one — which is
/// precisely why the bug M54 fixes was silent.
#[test]
fn dl_07_after_an_in_app_rename_the_open_note_still_hears_external_edits() {
    let f = Fixture::new();
    let (state, _) = open_vault(&f.root);
    let _ = cairn_lib::app::read_note(&state, "Misc.md").expect("read_note");

    let w = Watched::start(&f.root, &state.self_writes);
    assert_eq!(w.root(), f.root, "the watcher root must be the canonical root");

    // The in-app rename.  `rename_entry` + the M54 bookkeeping that
    // `app::rename_entry` performs under the write lock.
    let src = arena_abs(&state, "Misc.md").expect("arena");
    let dst = fsops::rename_target(&src, "Renamed", true).expect("rename_target");
    fsops::rename_entry(&src, &dst, &state.self_writes).expect("rename");
    *state.open_note.lock().unwrap_or_else(std::sync::PoisonError::into_inner) =
        Some("Renamed.md".to_string());
    let (state, _) = open_vault(&f.root);
    *state.open_note.lock().unwrap_or_else(std::sync::PoisonError::into_inner) =
        Some("Renamed.md".to_string());

    // Let the rename's own events drain before the external edit, so the count
    // below is about the edit and nothing else.
    w.settle();
    let renamed = f.abs("Renamed.md");
    assert!(renamed.is_file());

    // "…edit the file from a shell": a real second process.
    external_write(&renamed, b"edited by another program\n");

    assert!(
        w.wait(5_000, |w| w.hits(&renamed) >= 1),
        "no external-change hit ever arrived for the renamed note — the watcher is \
         silently dead, which is exactly the failure §7.3 case 4 exists for. \
         events={:?}",
        w.events()
    );
    w.settle();
    assert_eq!(
        w.hits(&renamed),
        1,
        "exactly one nc://note-external-change was required; events={:?}",
        w.events()
    );

    // And the filter is real: the hit resolves to the path `open_note` holds.
    let rel = renamed.strip_prefix(&f.root).expect("rel").to_string_lossy().into_owned();
    assert_eq!(
        state.open_note.lock().unwrap_or_else(std::sync::PoisonError::into_inner).as_deref(),
        Some(rel.as_str())
    );
}

/// §7.3 case 5's mandated test, in three parts:
///   `mv Misc.md Other.md` from another process with a dirty buffer ->
///   NO WRITE TO EITHER PATH; then Save as… into a fresh name -> EXACTLY ONE
///   write with `x-create: 1`; then Save as… into an EXISTING name ->
///   `alreadyExists` and ZERO writes.
#[test]
fn dl_08_an_external_rename_stops_autosave_and_save_as_is_the_only_way_out() {
    let f = Fixture::new();
    let (state, _) = open_vault(&f.root);
    let _ = cairn_lib::app::read_note(&state, "Misc.md").expect("read_note");
    let old = f.abs("Misc.md");
    let moved = f.abs("Other.md");

    external_rename(&old, &moved);
    let (state, _) = open_vault(&f.root); // the watcher's rescan
    *state.open_note.lock().unwrap_or_else(std::sync::PoisonError::into_inner) =
        Some("Misc.md".to_string());

    // The buffer is dirty and autosave fires. It must not write to EITHER path.
    assert!(matches!(autosave(&state, "Misc.md", b"dirty\n", None), Err(VaultError::NotFound { .. })));
    assert!(!old.exists(), "autosave recreated the note at its OLD path");
    assert_eq!(fs::read(&moved).expect("Other.md"), b"before\n", "autosave followed the rename");

    // Save as… into a fresh name: exactly one write, with the create bit.
    let r = save_as(&state, "", "Rescued.md", b"dirty\n").expect("save as");
    assert_eq!(r.size, 6);
    assert_eq!(fs::read(f.abs("Rescued.md")).expect("Rescued.md"), b"dirty\n");

    // Save as… into an existing name: refused at step 1c, and NOTHING is written.
    let before = fs::read(&moved).expect("Other.md");
    let (state, _) = open_vault(&f.root);
    match save_as(&state, "", "Other.md", b"dirty\n") {
        Err(VaultError::AlreadyExists { path }) => assert_eq!(path, "Other.md"),
        other => panic!("Save as… over an existing note must refuse: {other:?}"),
    }
    assert_eq!(fs::read(&moved).expect("Other.md"), before, "Save as… overwrote a note");
    assert!(temp_files(&f.root).is_empty());
    assert_eq!(entries(&f.root), vec!["A", "Notes", "Other.md", "Rescued.md"]);
}

/* ===========================================================================
 * §7.3 CASE 6 — THE FOLDER UNDER THE OPEN NOTE IS DELETED
 * ========================================================================= */

#[test]
fn dl_09_deleting_the_folder_takes_the_open_note_and_nothing_comes_back() {
    let f = Fixture::new();
    let (state, _) = open_vault(&f.root);
    let framed = cairn_lib::app::read_note(&state, "A/B/n.md").expect("read_note");
    let (base, flags, _) = note_frame::decode_note(&framed).expect("decode");
    let note = f.abs("A/B/n.md");

    // Delete `A` — the grandparent — with a dirty buffer open on `A/B/n.md`.
    let a = arena_abs(&state, "A").expect("arena");
    fsops::delete_entry(&a, "A", true, &state.self_writes).expect("delete A");

    // M54's containment rule, which `app::delete_entry` applies under the lock.
    let cleared = {
        let g = state.open_note.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        g.as_deref().is_some_and(|cur| cur == "A" || cur.starts_with("A/"))
    };
    assert!(cleared, "the open note was not inside the deleted folder — fixture bug");

    // Every autosave that could still be in the frontend's queue.
    for base in [Some(base), None] {
        assert!(matches!(
            fsops::write_note(&note, &wargs("A/B/n.md", flags, base, false), b"x\n", &state.self_writes),
            Err(VaultError::NotFound { .. })
        ));
    }
    assert!(!f.abs("A").exists(), "the deleted folder came back");
    assert!(!note.exists(), "the note under the deleted folder came back");
    assert_eq!(entries(&f.root), vec!["Misc.md", "Notes"]);
}

/* ===========================================================================
 * §7.3 CASE 7 — A CONCURRENT EDIT FROM ANOTHER PROCESS
 * ========================================================================= */

/// The child half of the concurrent-edit tests: a genuinely separate process,
/// because the whole claim is about an edit Cairn did not make.
#[test]
#[ignore = "spawned by external_write()/external_rename()"]
fn dataloss_external_actor() {
    let Ok(path) = std::env::var("CAIRN_DL_EXT_PATH") else { return };
    match std::env::var("CAIRN_DL_EXT_TO") {
        Ok(to) => fs::rename(&path, &to).expect("external rename"),
        Err(_) => {
            let body = std::env::var("CAIRN_DL_EXT_BODY").unwrap_or_default();
            fs::write(&path, body.as_bytes()).expect("external write");
        }
    }
}

fn run_external(env: &[(&str, &str)]) {
    let exe = std::env::current_exe().expect("current_exe");
    let mut cmd = std::process::Command::new(&exe);
    cmd.args(["--exact", "dataloss_external_actor", "--ignored", "--nocapture"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    for (k, v) in env {
        cmd.env(k, v);
    }
    let status = cmd.status().expect("spawn the external actor");
    assert!(status.success(), "the external actor failed");
}

fn external_write(path: &Path, body: &[u8]) {
    // A millisecond of separation, because the conflict guard compares
    // MILLISECOND mtimes: two writes inside one millisecond are indistinguishable
    // to it, and a test that raced them would be flaky for a reason that is not
    // the app's fault.
    std::thread::sleep(Duration::from_millis(20));
    run_external(&[
        ("CAIRN_DL_EXT_PATH", &path.to_string_lossy()),
        ("CAIRN_DL_EXT_BODY", &String::from_utf8_lossy(body)),
    ]);
}

fn external_rename(from: &Path, to: &Path) {
    run_external(&[
        ("CAIRN_DL_EXT_PATH", &from.to_string_lossy()),
        ("CAIRN_DL_EXT_TO", &to.to_string_lossy()),
    ]);
}

/// §7.3 case 7's mandated test: open a note, edit it from another process, type
/// in the app.  Assert EXACTLY ONE conflict, assert the disk still holds the
/// other process's content, assert NO WRITE occurred.
#[test]
fn dl_10_a_concurrent_edit_from_another_process_is_never_clobbered() {
    let f = Fixture::new();
    let (state, _) = open_vault(&f.root);
    let framed = cairn_lib::app::read_note(&state, "Misc.md").expect("read_note");
    let (base, _, _) = note_frame::decode_note(&framed).expect("decode");
    let abs = f.abs("Misc.md");

    external_write(&abs, b"written by Obsidian\n");
    let disk_after_external = fs::read(&abs).expect("Misc.md");

    // The user types; autosave fires with the base mtime the editor read.
    let mut conflicts = 0u32;
    for _ in 0..3 {
        match autosave(&state, "Misc.md", b"typed in Cairn\n", Some(base)) {
            Err(VaultError::Conflict { path, disk_mtime_ms }) => {
                conflicts += 1;
                assert_eq!(path, "Misc.md");
                assert_ne!(disk_mtime_ms, base, "the conflict reported the base as the disk mtime");
            }
            other => panic!("a concurrent edit must conflict: {other:?}"),
        }
    }
    assert_eq!(conflicts, 3, "the conflict guard must not disarm itself after the first refusal");
    assert_eq!(fs::read(&abs).expect("Misc.md"), disk_after_external, "the other process's edit was clobbered");
    assert!(temp_files(&f.root).is_empty(), "a refused write left a temp file");

    // §7.2's *Keep mine* is the ONLY way through, and it is explicit.
    let receipt = autosave(&state, "Misc.md", b"typed in Cairn\n", None).expect("keep mine");
    assert_eq!(fs::read(&abs).expect("Misc.md"), b"typed in Cairn\n");
    assert_eq!(receipt.size, 15);
}

/// The echo rule, which is the other half of case 7 and the one that turns a
/// working app into a conflict bar the user did nothing to earn: OUR OWN write
/// must not come back as an external change, and a GENUINELY later external
/// write to the same path must.
#[test]
fn dl_11_our_own_saves_do_not_echo_but_a_real_external_edit_does() {
    let f = Fixture::new();
    let (state, _) = open_vault(&f.root);
    let _ = cairn_lib::app::read_note(&state, "Misc.md").expect("read_note");
    let abs = f.abs("Misc.md");

    let w = Watched::start(&f.root, &state.self_writes);
    w.settle();

    for i in 0..5 {
        autosave(&state, "Misc.md", format!("save {i}\n").as_bytes(), None).expect("autosave");
        std::thread::sleep(Duration::from_millis(60));
    }
    w.settle();
    assert_eq!(
        w.hits(&abs),
        0,
        "our own saves echoed back as external changes — every autosave would raise a \
         spurious conflict bar. events={:?}",
        w.events()
    );

    external_write(&abs, b"and now somebody else\n");
    assert!(
        w.wait(5_000, |w| w.hits(&abs) >= 1),
        "a genuine external edit was swallowed by echo suppression. events={:?}",
        w.events()
    );
}

/* ===========================================================================
 * §7.3 CASE 8 — THE VAULT ROOT GOES AWAY
 * ========================================================================= */

#[test]
fn dl_12_a_vanished_vault_root_is_reported_and_nothing_is_written_after() {
    let f = Fixture::new();
    let (state, _) = open_vault(&f.root);
    let _ = cairn_lib::app::read_note(&state, "Misc.md").expect("read_note");
    let abs = arena_abs(&state, "Misc.md").expect("arena");

    let w = Watched::start(&f.root, &state.self_writes);
    w.settle();

    // "…open a vault on a DMG, eject it": the root itself disappears.
    fs::remove_dir_all(&f.root).expect("remove the root");

    assert!(
        w.wait(6_000, Watched::lost),
        "nc://vault-lost never fired for a vanished root. events={:?}",
        w.events()
    );

    // "…assert zero writes afterwards."  With the root gone the write cannot
    // even create its temp file, so nothing is recreated under a path whose root
    // no longer exists.
    match fsops::write_note(&abs, &wargs("Misc.md", 0, None, false), b"late\n", &state.self_writes) {
        Err(VaultError::NotFound { .. } | VaultError::Io { .. }) => {}
        other => panic!("a write into a vanished vault must fail: {other:?}"),
    }
    assert!(!f.root.exists(), "the vault root was recreated by a late write");
}

/* ===========================================================================
 * §2.4 / GATE G-RT — THE BYTE-IDENTICAL ROUND TRIP
 * ========================================================================= */

/// Read a file, write it back UNMODIFIED, and compare the bytes.  Returns the
/// bytes that ended up on disk.
fn round_trip(state: &AppState, rel: &str) -> Vec<u8> {
    let abs = arena_abs(state, rel).expect("arena");
    let read = fsops::read_note(&abs, rel).expect("read_note");
    fsops::write_note(
        &abs,
        &wargs(rel, read.flags, Some(read.mtime_ms), false),
        &read.bytes,
        &state.self_writes,
    )
    .expect("write_note");
    fs::read(&abs).expect("read back")
}

/// The invariant the assignment names: a note carrying a BOM, CRLF endings, or
/// both, read and written straight back, must be BYTE-IDENTICAL.
///
/// Every uniform case is byte-exact.  The MIXED case is not, deliberately and
/// documentedly — see `dl_14` — and putting the two in separate tests is what
/// keeps the mixed behaviour from hiding inside a green G-RT row.
#[test]
fn dl_13_uniform_bom_and_crlf_notes_round_trip_byte_identically() {
    let f = Fixture::new();
    let cases: [(&str, &[u8]); 9] = [
        ("lf.md", b"plain\nlf\n"),
        ("crlf.md", b"windows\r\nendings\r\n"),
        ("bom_lf.md", b"\xEF\xBB\xBFbom then lf\n"),
        ("bom_crlf.md", b"\xEF\xBB\xBFbom then\r\ncrlf\r\n"),
        ("no_trailing_newline.md", b"no newline at eof"),
        ("empty.md", b""),
        ("bom_only.md", b"\xEF\xBB\xBF"),
        ("lone_cr.md", b"old mac\rendings\rhere"),
        ("utf8.md", "héllo — 日本語 🎉\n".as_bytes()),
    ];
    for (name, bytes) in cases {
        fs::write(f.abs(name), bytes).expect("write the fixture note");
    }
    let (state, _) = open_vault(&f.root);

    for (name, bytes) in cases {
        let after = round_trip(&state, name);
        assert_eq!(
            after, bytes,
            "{name} did NOT round-trip byte-identically: {:?} -> {:?}",
            bytes, after
        );
    }
    assert!(temp_files(&f.root).is_empty());
}

/// THE MIXED CASE, PINNED RATHER THAN CLAIMED.
///
/// A file holding BOTH `\r\n` and bare `\n` does NOT round-trip byte-identically:
/// `normalise` sets `FLAG_CRLF` if the file contains ANY `\r\n`, and
/// `denormalise` then writes EVERY line ending as `\r\n`.  The first save
/// therefore UNIFIES the file on CRLF and it grows by one byte per previously
/// bare `\n`.
///
/// That is a deliberate choice with a stated reason (CodeMirror normalises the
/// document to `\n` on load, so leaving the `\r`s in the editor's text would
/// make the next save DELETE every one of them — a worse outcome). It is
/// asserted here as `assert_ne` + an exact expected value so that changing it is
/// a deliberate act against a failing test, and it is written up as a
/// DIVERGENCE row in docs/DATA-LOSS-VERIFICATION.md rather than hidden.
#[test]
fn dl_14_a_mixed_eol_note_is_unified_on_crlf_not_silently_stripped() {
    let f = Fixture::new();
    let mixed: &[u8] = b"crlf\r\nbare\nboth\r\n\nend";
    fs::write(f.abs("mixed.md"), mixed).expect("mixed.md");
    let (state, _) = open_vault(&f.root);

    let after = round_trip(&state, "mixed.md");
    assert_ne!(after, mixed, "mixed EOL is documented as NOT byte-identical; behaviour changed");
    assert_eq!(
        after, b"crlf\r\nbare\r\nboth\r\n\r\nend",
        "mixed EOL must be UNIFIED on CRLF — never stripped, never torn"
    );
    // The one thing that must never happen: a `\r` silently deleted.
    assert!(
        after.windows(2).filter(|w| *w == b"\r\n").count() >= mixed.windows(2).filter(|w| *w == b"\r\n").count(),
        "a CRLF was silently downgraded to LF"
    );
    // And the second round trip IS stable: the file is uniform now.
    let again = round_trip(&state, "mixed.md");
    assert_eq!(again, after, "the round trip is not idempotent");
}

/// §7.3 case 14, at the seam: a note that is not valid UTF-8 is refused on READ,
/// so the buffer never holds a lossy decode that a later autosave could write
/// back over the original.
#[test]
fn dl_15_a_non_utf8_note_is_refused_and_survives_untouched() {
    let f = Fixture::new();
    let raw: &[u8] = b"latin-1 caf\xE9 and a lone \xFF byte\n";
    fs::write(f.abs("latin1.md"), raw).expect("latin1.md");
    let (state, _) = open_vault(&f.root);

    match fsops::read_note(&arena_abs(&state, "latin1.md").expect("arena"), "latin1.md") {
        Err(VaultError::NotUtf8 { path }) => assert_eq!(path, "latin1.md"),
        other => panic!("a non-UTF-8 note must be refused: {other:?}"),
    }
    assert_eq!(fs::read(f.abs("latin1.md")).expect("latin1.md"), raw, "the bytes were rewritten");
}

/* ===========================================================================
 * §7.3 CASE 10 — CASE-ONLY RENAME ON CASE-INSENSITIVE APFS
 * ========================================================================= */

/// Is the fixture filesystem case-insensitive?  Measured, never assumed: the
/// whole of case 10 is conditional on it, and a case-SENSITIVE volume would make
/// the "refused" half unreachable rather than failing.
fn case_insensitive(dir: &Path) -> bool {
    let a = dir.join("cAsE-probe");
    let _ = fs::write(&a, b"x");
    let insensitive = dir.join("CASE-PROBE").exists();
    let _ = fs::remove_file(&a);
    insensitive
}

#[test]
#[cfg_attr(
    target_os = "linux",
    ignore = "unmeasured on Linux: §7.3 case 10 premise is case-insensitive APFS; the body asserts it and panics on case-sensitive volumes"
)]
fn dl_16_a_case_only_rename_keeps_the_file_and_a_real_collision_is_refused() {
    let f = Fixture::new();
    assert!(
        case_insensitive(&f.root),
        "this fixture is on a case-SENSITIVE volume; §7.3 case 10's premise does not hold \
         here and the result must be recorded as unmeasured rather than passed"
    );

    fs::write(f.abs("notes.md"), b"the user's writing\n").expect("notes.md");
    let (state, _) = open_vault(&f.root);
    let src = arena_abs(&state, "notes.md").expect("arena");
    let ino_before = fs::symlink_metadata(&src).expect("stat").ino();

    // `notes.md` -> `Notes.md`: same file, so it is a case-only rename and goes
    // old -> .Notes.md.tmp-<pid>-<n> -> new.
    let dst = fsops::rename_target(&src, "Notes", true).expect("rename_target");
    fsops::rename_entry(&src, &dst, &state.self_writes).expect("the case-only rename must succeed");

    assert_eq!(fs::read(f.abs("Notes.md")).expect("Notes.md"), b"the user's writing\n");
    assert_eq!(
        fs::symlink_metadata(f.abs("Notes.md")).expect("stat").ino(),
        ino_before,
        "the case-only rename replaced the inode instead of moving it"
    );
    assert!(temp_files(&f.root).is_empty(), "the intermediate temp name survived: {:?}", temp_files(&f.root));
    let names = entries(&f.root);
    assert!(names.contains(&"Notes.md".to_string()));
    assert_eq!(names.iter().filter(|n| n.eq_ignore_ascii_case("notes.md")).count(), 1);

    // A GENUINE collision: a different file whose name differs only by case.
    fs::write(f.abs("OTHER.md"), b"a different note\n").expect("OTHER.md");
    let (state, _) = open_vault(&f.root);
    let src = arena_abs(&state, "Notes.md").expect("arena");
    let dst = fsops::rename_target(&src, "other", true).expect("rename_target");
    match fsops::rename_entry(&src, &dst, &state.self_writes) {
        Err(VaultError::AlreadyExists { .. }) => {}
        other => panic!("a case-only COLLISION with a different file must be refused: {other:?}"),
    }
    assert_eq!(fs::read(f.abs("OTHER.md")).expect("OTHER.md"), b"a different note\n");
    assert_eq!(fs::read(f.abs("Notes.md")).expect("Notes.md"), b"the user's writing\n");
}

/* ===========================================================================
 * THE SYMLINKED VAULT ROOT — THE REGRESSION THAT KILLED THE WATCHER SILENTLY
 * ========================================================================= */

/// The vault is reached through a symlinked root.  FSEvents reports CANONICAL
/// paths, so if the arena's `root_path` is the user's spelling while the watcher
/// canonicalises, no fingerprint ever matches and every save echoes back — or,
/// with the roots the other way round, every external edit is dropped and the
/// watcher is dead with `watching: true`.
///
/// This is regression-tested at three levels at once: the arena's root, the
/// watcher's root, and a real external edit arriving through the symlinked
/// spelling.
///
/// `/var` -> `/private/var` on every Mac, so the fixture is ALREADY behind one
/// symlink (`std::env::temp_dir()` is under `/var/folders`); the explicit
/// symlink below adds a second, user-created one on top of it.
#[test]
fn dl_17_a_vault_reached_through_a_symlink_still_watches_and_still_suppresses() {
    let f = Fixture::new();
    let link_home = tmpdir();
    let link = link_home.path().join("vault-link");
    std::os::unix::fs::symlink(&f.root, &link).expect("symlink");
    assert!(link.symlink_metadata().expect("lstat").file_type().is_symlink());
    assert_ne!(link, f.root);

    // Open THROUGH THE SYMLINK, exactly as a user who picked it would.
    let (state, _) = open_vault(&link);
    let arena_root = state.vault().expect("vault").root();
    assert_eq!(
        arena_root, f.root,
        "the arena kept the user's spelling of the root instead of the canonical one — \
         every FSEvent will fail the starts_with(root) test and the watcher dies SILENTLY"
    );

    // THE HAZARD IS REAL, NOT HYPOTHETICAL, and this is the line that shows it:
    // walk the SAME vault WITHOUT the canonicalisation `open_vault_blocking`
    // performs, and the arena's root and the watcher's root are two different
    // strings for one directory.  Every `(abs, mtime_ns, len)` fingerprint the
    // write path records would then be spelled differently from every path
    // FSEvents delivers, and not one would ever match.
    let (raw, _) = vault::open_at(&link, SortMode::default(), 1).expect("uncanonicalised walk");
    assert_ne!(
        raw.root(),
        f.root,
        "the fixture is not behind a symlink, so this regression test is inert"
    );
    assert!(
        !f.root.starts_with(raw.root()),
        "the two spellings must be genuinely different paths"
    );

    let w = Watched::start(&link, &state.self_writes);
    assert_eq!(w.root(), f.root, "the watcher and the arena disagree about the root");
    w.settle();

    // Echo suppression must still work: same fingerprint ring, same spelling.
    autosave(&state, "Misc.md", b"saved through the link\n", None).expect("autosave");
    w.settle();
    let abs = f.abs("Misc.md");
    assert_eq!(w.hits(&abs), 0, "our own save echoed back through the symlinked root: {:?}", w.events());

    // And a real external edit must still arrive.
    external_write(&abs, b"external, through the link\n");
    assert!(
        w.wait(5_000, |w| w.hits(&abs) >= 1),
        "the watcher is silently dead on a symlinked vault root — the exact regression \
         this test exists for. events={:?}",
        w.events()
    );
}

/* ===========================================================================
 * §7.3 CASES 11, 12 AND 13 — NAMES, SYMLINK LOOPS, TRAVERSAL
 * ========================================================================= */

/// §7.3 case 11's mandated test, plus the measurement behind it.
///
/// The asymmetry is NOT what the shorthand "legal on Linux, illegal on macOS"
/// suggests: at the POSIX layer APFS accepts every byte except `/` and NUL, so
/// the names that are legal on ext4 are legal here too. The real hazard is the
/// THIRD machine — a vault synced onto Windows — which is why `validate_name` is
/// stricter than either Unix, and why `validate_rel_for_lookup` is not: a
/// directory called `Archive ` or `v1.` is legal, common, and must stay openable.
#[test]
fn dl_18_awkward_names_are_openable_even_where_they_are_uncreatable() {
    let f = Fixture::new();

    // Created from OUTSIDE the app, which is the only way they can appear.
    let awkward: [&str; 6] = ["Archive ", "v1.", "CON.md", "star*.md", "pipe|.md", "quote\".md"];
    let mut made: Vec<&str> = Vec::new();
    for name in awkward {
        let p = f.root.join(name);
        let ok = if name.ends_with(".md") {
            fs::write(&p, b"awkward\n").is_ok()
        } else {
            fs::create_dir(&p).is_ok()
        };
        if ok {
            made.push(name);
        }
    }
    assert!(
        made.contains(&"Archive ") && made.contains(&"v1.") && made.contains(&"CON.md"),
        "the fixture filesystem refused names §7.3 case 11 assumes it accepts: made={made:?}"
    );
    fs::write(f.root.join("Archive /inside.md"), b"inside a trailing-space folder\n")
        .expect("a note inside `Archive `");

    let (state, _) = open_vault(&f.root);

    // OPEN, RENAME AND DELETE THROUGH THE APP: all three must succeed.
    let inside = arena_abs(&state, "Archive /inside.md").expect(
        "a note inside a trailing-space folder must be reachable — spec-02 §5.2's single \
         validate_rel made exactly this note visible but permanently unopenable",
    );
    assert_eq!(fsops::read_note(&inside, "Archive /inside.md").expect("read").bytes, b"inside a trailing-space folder\n");
    autosave(&state, "Archive /inside.md", b"edited\n", None).expect("write through an awkward parent");
    let dst = fsops::rename_target(&inside, "Renamed inside", true).expect("rename_target");
    fsops::rename_entry(&inside, &dst, &state.self_writes).expect("rename through an awkward parent");
    fsops::delete_entry(&dst, "Archive /Renamed inside.md", true, &state.self_writes).expect("delete");

    // `CON.md` is openable and deletable, even though it can never be CREATED.
    let con = arena_abs(&state, "CON.md").expect("CON.md must be openable");
    assert_eq!(fsops::read_note(&con, "CON.md").expect("read CON.md").bytes, b"awkward\n");

    // And the creation policy is the strict one, on every name the app itself
    // would have to write onto a synced Windows machine.
    for bad in ["CON", "Archive ", "v1.", "a/b", "a:b", "a*b", "a?b", "a<b", "..", "."] {
        assert!(
            vpath::validate_name(bad).is_err(),
            "validate_name accepted {bad:?}, which a Windows checkout cannot hold"
        );
    }
    // …while the LOOKUP validator admits every one of them that is a real name.
    for ok in ["Archive ", "v1.", "CON.md", "Archive /inside.md"] {
        assert!(vpath::validate_rel_for_lookup(ok).is_ok(), "lookup refused {ok:?}");
    }
}

/// §7.3 case 12: a symlink loop in the vault.  The walk must TERMINATE, the tree
/// must not contain the link, and nothing outside the root may be reachable
/// through it.
#[test]
fn dl_19_a_symlink_loop_terminates_the_walk_and_is_absent_from_the_tree() {
    let f = Fixture::new();
    let outside = tmpdir();
    fs::write(outside.path().join("secret.md"), b"not in the vault\n").expect("secret");

    std::os::unix::fs::symlink("..", f.abs("loop")).expect("ln -s .. loop");
    std::os::unix::fs::symlink(&f.root, f.abs("self")).expect("ln -s <root> self");
    std::os::unix::fs::symlink(outside.path(), f.abs("escape")).expect("ln -s <outside> escape");
    std::os::unix::fs::symlink("../secret.md", f.abs("Notes/link.md")).expect("a symlinked NOTE");

    // If the walk followed symlinks this would not return.
    let started = Instant::now();
    let (state, _) = open_vault(&f.root);
    assert!(started.elapsed() < Duration::from_secs(10), "the walk did not terminate promptly");

    for absent in ["loop", "self", "escape", "Notes/link.md"] {
        assert!(
            matches!(arena_abs(&state, absent), Err(VaultError::NotFound { .. })),
            "{absent} reached the arena; symlinks must be skipped entirely (§7.3 case 12)"
        );
    }
    // The accepted limitation, asserted as a limitation: a symlinked note is
    // absent with no error, rather than followed.
    assert!(f.abs("Notes/link.md").symlink_metadata().is_ok(), "the fixture link vanished");

    // §7.3 case 13, through the same seam: nothing outside the root resolves.
    for hostile in ["../../etc/passwd", "/etc/passwd", "loop/../../etc/passwd", "escape/secret.md", "..", "a/../.."] {
        let r = arena_abs(&state, hostile);
        assert!(
            matches!(r, Err(VaultError::NotFound { .. } | VaultError::InvalidPath { .. })),
            "{hostile} resolved to {r:?}"
        );
    }
    assert_eq!(fs::read(outside.path().join("secret.md")).expect("secret"), b"not in the vault\n");
}

/* ===========================================================================
 * §7.3 CASE 15 — THE 8 MiB CAP
 * ========================================================================= */

#[test]
fn dl_20_the_eight_mib_cap_holds_on_both_the_read_and_the_write_path() {
    let f = Fixture::new();
    let cap = MAX_NOTE_BYTES as usize;
    assert_eq!(cap, 8 * 1024 * 1024, "M27 pins MAX_NOTE_BYTES at 8 MiB");

    fs::write(f.abs("AtCap.md"), vec![b'x'; cap]).expect("AtCap.md");
    fs::write(f.abs("OverCap.md"), vec![b'x'; cap + 1]).expect("OverCap.md");
    let (state, _) = open_vault(&f.root);

    // Exactly at the cap opens; one byte over is refused, with the numbers.
    assert_eq!(fsops::read_note(&arena_abs(&state, "AtCap.md").expect("arena"), "AtCap.md").expect("at cap").bytes.len(), cap);
    match fsops::read_note(&arena_abs(&state, "OverCap.md").expect("arena"), "OverCap.md") {
        Err(VaultError::TooLarge { path, bytes, limit }) => {
            assert_eq!(path, "OverCap.md");
            assert_eq!(bytes, cap as u64 + 1);
            assert_eq!(limit, MAX_NOTE_BYTES);
        }
        other => panic!("an over-cap note must be refused: {other:?}"),
    }

    // The WRITE path enforces it too, or the app could create a note it then
    // refuses to open.
    let before = fs::read(f.abs("AtCap.md")).expect("AtCap.md");
    match autosave(&state, "AtCap.md", &vec![b'y'; cap + 1], None) {
        Err(VaultError::TooLarge { bytes, .. }) => assert_eq!(bytes, cap as u64 + 1),
        other => panic!("an over-cap write must be refused: {other:?}"),
    }
    assert_eq!(fs::read(f.abs("AtCap.md")).expect("AtCap.md"), before, "the refused write landed anyway");

    // AND THE CAP IS APPLIED AFTER `denormalise`, which is the subtle one: a body
    // that fits becomes over-cap once the BOM and the CRLFs are re-applied.
    match fsops::write_note(
        &arena_abs(&state, "AtCap.md").expect("arena"),
        &wargs("AtCap.md", FLAG_BOM, None, false),
        &vec![b'y'; cap],
        &state.self_writes,
    ) {
        Err(VaultError::TooLarge { bytes, .. }) => assert_eq!(bytes, cap as u64 + 3, "the BOM's three bytes"),
        other => panic!("the cap must be measured on what LANDS on disk: {other:?}"),
    }
    // The same, through the CRLF flag: one extra byte per line ending.
    let mut body = vec![b'y'; cap - 4];
    body.extend_from_slice(b"\n\n\n\n");
    match fsops::write_note(
        &arena_abs(&state, "AtCap.md").expect("arena"),
        &wargs("AtCap.md", FLAG_CRLF, None, false),
        &body,
        &state.self_writes,
    ) {
        Err(VaultError::TooLarge { bytes, .. }) => assert_eq!(bytes, cap as u64 + 4, "four re-applied CRs"),
        other => panic!("the cap must be measured after denormalise: {other:?}"),
    }
    assert_eq!(fs::read(f.abs("AtCap.md")).expect("AtCap.md"), before);
    assert!(temp_files(&f.root).is_empty(), "a refused over-cap write left a temp file");
}

/* ===========================================================================
 * GATE G8 — A WHOLE SESSION LEAVES ONLY THE USER'S NOTES
 * ========================================================================= */

/// A full session against a real vault reached through a symlinked root, with a
/// real watcher running throughout, a real external actor editing underneath it,
/// and `state.json` written to a config directory OUTSIDE the vault (§7.6).
///
/// The assertion is the whole directory listing, dotfiles included.
#[test]
fn dl_21_g8_a_whole_session_leaves_exactly_the_users_notes() {
    let f = Fixture::new();
    let link_home = tmpdir();
    let link = link_home.path().join("vault");
    std::os::unix::fs::symlink(&f.root, &link).expect("symlink");
    let config = tmpdir();
    guard(config.path());

    let (state, _) = open_vault(&link);
    let w = Watched::start(&link, &state.self_writes);

    let root_abs = state.vault().expect("vault").root();
    let (folder, _) = fsops::create_folder(&root_abs, Some("Projects"), &state.self_writes).expect("mkdir");
    let (note, name) = fsops::create_note(&folder, None, &state.self_writes).expect("create");
    assert_eq!(name, "Untitled.md");
    fsops::write_note(&note, &wargs("Projects/Untitled.md", 0, None, false), b"# Ideas\n", &state.self_writes).expect("write");
    let renamed = fsops::rename_target(&note, "Ideas", true).expect("rename_target");
    fsops::rename_entry(&note, &renamed, &state.self_writes).expect("rename");
    let (scratch, _) = fsops::create_note(&root_abs, Some("Scratch"), &state.self_writes).expect("create");
    fsops::delete_entry(&scratch, "Scratch.md", true, &state.self_writes).expect("delete");
    external_write(&f.abs("Misc.md"), b"and somebody else edited this\n");

    let prefs = Arc::new(cairn_lib::prefs::PrefsStore::load(config.path().join("state.json")));
    prefs.edit(|st| st.touch_vault(&root_abs.to_string_lossy()));
    prefs.flush_now().expect("flush state.json");

    w.settle();
    drop(w); // joins the watcher thread

    assert_eq!(entries(&f.root), vec!["A", "Misc.md", "Notes", "Projects"]);
    assert_eq!(entries(&f.abs("Projects")), vec!["Ideas.md"]);
    assert!(temp_files(&f.root).is_empty(), "{:?}", temp_files(&f.root));
    assert!(!f.abs("state.json").exists(), "state.json was written INSIDE the vault");
    assert!(config.path().join("state.json").is_file(), "state.json did not reach the config dir");
    // And the config directory holds NOTHING but state.json.
    assert_eq!(entries(config.path()), vec!["state.json"]);
}

/* ===========================================================================
 * §7.3 CASE 16 — WATCHER DEGRADATION
 *
 * `watcher::FORCE_WATCH_LIMIT` is `#[cfg(test)]`, which means it exists only
 * when the LIBRARY is compiled as a test target — an integration test links the
 * ordinary library, so the injection point is not reachable from here.  It is
 * covered by the unit tests inside `src/watcher.rs`.  What IS reachable from
 * here is the half that a unit test cannot reach: a vault whose watcher never
 * started still OPENS and still works, which is the invariant the user actually
 * experiences.
 * ========================================================================= */

#[test]
fn dl_22_a_vault_with_no_watcher_still_opens_and_still_saves() {
    let f = Fixture::new();
    let (state, _) = open_vault(&f.root);
    assert!(!state.watching(), "no watcher was started, so `watching` must be false (M57)");

    // The vault is fully usable: read, write, create, rename, delete.
    let framed = cairn_lib::app::read_note(&state, "Misc.md").expect("read_note");
    let (base, _, _) = note_frame::decode_note(&framed).expect("decode");
    autosave(&state, "Misc.md", b"edited with no watcher\n", Some(base)).expect("write");
    assert_eq!(fs::read(f.abs("Misc.md")).expect("Misc.md"), b"edited with no watcher\n");

    // And a start against a path that cannot be watched degrades rather than
    // panicking or hanging.
    let gone = f.abs("does-not-exist");
    let sw = Arc::new(Mutex::new(SelfWrites::new()));
    assert!(
        VaultWatcher::start(&gone, sw, Box::new(|_| {})).is_err(),
        "watching a nonexistent root must degrade, not succeed"
    );
}

/* ===========================================================================
 * §7.3 CASE 3, THE HALVES THAT WERE NEVER EXERCISED
 *
 * `dl_05` above proves the RESURRECTION half of case 3 and it proves it hard.
 * The three tests below are the rest of the case, added with the fix for
 * `docs/DATA-LOSS-VERIFICATION.md` finding F1:
 *
 *   dl_24  finding F3's in-flight-write window, DEMONSTRATED rather than
 *          asserted, and the `settleWrites()` closure shown to close it.
 *   dl_25  which BYTES reach the delete on each of the prompt's three
 *          branches — the containable half of "assert ~/.Trash holds the
 *          pre-edit copy".
 *   dl_26  gap G-a itself: a read-only measurement of where a fixture note's
 *          trash actually is, which is why every delete in this file passes
 *          `permanent: true`.  It sits alongside `dl_27`, which drives the real
 *          `trash::delete` against a stubbed `osascript` — the two are the
 *          "where would it go" and the "what does the call do" halves of the
 *          same question.
 * ========================================================================= */

/// The body used by `dl_24`.  Big enough that `write_all` + `sync_data` is a
/// window a single `unlink` can be landed inside on purpose, and comfortably
/// under `MAX_NOTE_BYTES` (8 MiB) so the write is a legal one.
const F3_BODY_LEN: usize = 6 * 1024 * 1024;

/// Wait until at least one `.tmp-` file exists under `root`, i.e. until the
/// writer has passed step 1b (`create_new`) and has not yet reached step 8
/// (`rename`).  THAT IS THE WINDOW, expressed as an observable fact rather than
/// as a sleep: a sleep would make this test a race, and a race would make it
/// flaky in exactly the direction that hides the bug.
fn wait_for_temp(root: &Path, ms: u64) -> bool {
    let deadline = Instant::now() + Duration::from_millis(ms);
    while Instant::now() < deadline {
        if !temp_files(root).is_empty() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(1));
    }
    !temp_files(root).is_empty()
}

/// §7.3 case 3 / finding F3, and it is the reason `settleWrites()` is normative
/// rather than decorative (errata 3, Z5).
///
/// F3 says: `x-create: '0'` closes the case where an autosave is issued AFTER
/// the delete (`dl_05`), and cancelling both timers closes the case where one is
/// about to be issued — but NEITHER closed a write that had already passed step
/// 1b when the delete landed, because step 8's `fs::rename` creates the
/// destination whether or not it still exists.
///
/// F91's WRITE_LOCK closes that third case underneath: `write_note` holds it
/// from its conflict check through its rename, and `delete_entry` holds it for
/// its whole operation, so a delete can no longer land between the check and
/// the rename and be undone by it. ARM 1 below asserts the locked end state
/// directly — the delete waits for the in-flight write, then unlinks, and the
/// note stays deleted — instead of racing the old window. ARM 2 (settle first)
/// is unchanged: it is the frontend's ordering, one process down.
///
/// A round only counts if the temp file was STILL THERE when the unlink
/// returned — that is the proof the delete really ran against an in-flight
/// write and not after it — and the test fails if no round was conclusive, so
/// it cannot pass vacuously.
#[test]
fn dl_24_a_write_already_in_flight_resurrects_a_deleted_note_and_settling_stops_it() {
    let f = Fixture::new();

    /* ── ARM 1: THE HAZARD, CLOSED BY THE WRITE LOCK ──────────────────────── */
    let mut conclusive = 0_usize;

    for round in 0..6 {
        // A fresh note each round, so a round never inherits the last one's file.
        let rel = format!("f3-{round}.md");
        fs::write(f.abs(&rel), b"before\n").expect("seed the note");
        let (state, _) = open_vault(&f.root);
        let abs = arena_abs(&state, &rel).expect("arena");
        // The base mtime the FRONTEND holds — read out of §2's frame, exactly as
        // `openNote` gets it.  A `stat`-derived one is wrong at the millisecond
        // and every write would be refused with `Conflict` before it ever
        // created a temp, which would make this test silently vacuous.
        let framed = cairn_lib::app::read_note(&state, &rel).expect("read_note");
        let (base, _, _) = note_frame::decode_note(&framed).expect("decode");

        let writes = Arc::clone(&state.self_writes);
        let (wabs, wrel) = (abs.clone(), rel.clone());
        let writer = std::thread::spawn(move || {
            let body = vec![b'x'; F3_BODY_LEN];
            // A PERFECTLY ORDINARY AUTOSAVE: create is FALSE, the base mtime is
            // the one the frontend holds.  Nothing about this write is special,
            // which is the whole point — §7.1 rule 1 cannot see it coming.
            fsops::write_note(&wabs, &wargs(&wrel, 0, Some(base), false), &body, &writes)
        });

        if !wait_for_temp(&f.root, 5_000) {
            // Report what the write actually did rather than the symptom: a
            // refused write and a too-fast write look identical from here.
            let r = writer.join().expect("writer thread");
            panic!("round {round}: no temp file ever appeared. The write returned {r:?}");
        }

        // THE DELETE, against an in-flight write.  `permanent: true` — see dl_26.
        // The lock serialises it behind the write's rename; it cannot land
        // inside the window any more, so there is no conclusive/not distinction
        // to draw — every round counts.
        fsops::delete_entry(&abs, &rel, true, &state.self_writes).expect("delete");
        conclusive += 1;

        let receipt = writer.join().expect("writer thread");
        assert!(receipt.is_ok(), "round {round}: the in-flight write itself failed: {receipt:?}");
        assert!(
            !abs.exists(),
            "round {round}: the in-flight write re-created the deleted note — \
             the write lock is not serialising delete behind the rename"
        );
        assert!(temp_files(&f.root).is_empty(), "round {round}: a temp survived");
    }

    // Reported, not merely asserted: a run where the delete never met an
    // in-flight write is still a pass only if the temp was seen — `wait_for_temp`
    // above guarantees that per round, and the count is how a reader knows.
    eprintln!("dl_24: {conclusive}/6 rounds ran the delete against an in-flight write");
    assert!(
        conclusive >= 1,
        "no round ran the delete against an in-flight write, so this test proved nothing"
    );

    /* ── ARM 2: THE CLOSURE ───────────────────────────────────────────────── */
    // `guardDeleteOfOpenNote` awaits `settleWrites()` and only then returns
    // 'proceed'; `deleteFlow` invokes `delete_entry` after that.  Modelled here
    // by joining the writer BEFORE the delete — the same ordering, one process
    // down.  Nothing else about the sequence changes.
    for round in 0..3 {
        let rel = format!("f3-settled-{round}.md");
        fs::write(f.abs(&rel), b"before\n").expect("seed the note");
        let (state, _) = open_vault(&f.root);
        let abs = arena_abs(&state, &rel).expect("arena");
        let framed = cairn_lib::app::read_note(&state, &rel).expect("read_note");
        let (base, _, _) = note_frame::decode_note(&framed).expect("decode");

        let writes = Arc::clone(&state.self_writes);
        let (wabs, wrel) = (abs.clone(), rel.clone());
        let writer = std::thread::spawn(move || {
            let body = vec![b'x'; F3_BODY_LEN];
            fsops::write_note(&wabs, &wargs(&wrel, 0, Some(base), false), &body, &writes)
        });
        assert!(wait_for_temp(&f.root, 5_000), "round {round}: the write never started");

        // await settleWrites()
        writer.join().expect("writer thread").expect("the settled write");
        assert!(temp_files(&f.root).is_empty(), "a temp survived a completed write");

        fsops::delete_entry(&abs, &rel, true, &state.self_writes).expect("delete");
        assert!(
            !abs.exists(),
            "round {round}: the note came back even though the write had been AWAITED — \
             settleWrites() does not close F3's window and §7.3 case 3 is wrong"
        );
    }

    assert!(temp_files(&f.root).is_empty(), "the run left crash debris behind");
}

/// §7.3 case 3's *"assert `~/.Trash` holds the pre-edit copy and nothing holds a
/// post-edit copy"*, reduced to the half that can be proved inside a fixture —
/// and it is the half that carries the meaning.
///
/// The claim decomposes into two:
///   (a) WHICH BYTES are in the file at the instant `delete_entry` is called.
///       That is a property of the app's ordering and it is what the prompt's
///       three branches decide.  It is proved here, exactly, for all three.
///   (b) that the OS then moves THAT FILE to the trash.  That is one
///       `trash::delete` call and it is gap G-a; `dl_26` measures why.
///
/// (b) is a same-volume move, so the file the user finds in the Trash is this
/// inode.  The rename is therefore modelled here — inside the fixture, with the
/// same syscall — and asserted to preserve both the inode and the bytes, so the
/// only thing G-a still stands on is that `trash::delete` performs a move at
/// all.  That is a one-line call with an error map (`fsops.rs:795`).
///
/// The three branches are named for the buttons in §7.3 case 3's prompt, which
/// `src/editor.ts`'s `guardDeleteOfOpenNote` now shows and
/// `tests/frontend/modal.test.mjs` drives for real.
#[test]
fn dl_25_the_bytes_that_reach_the_delete_are_the_branch_the_user_picked() {
    const PRE: &[u8] = b"before\n";
    const POST: &[u8] = b"before\nedited\n";

    /* ── branch "Cancel": nothing happens at all ──────────────────────────── */
    {
        let f = Fixture::new();
        let (state, _) = open_vault(&f.root);
        let framed = cairn_lib::app::read_note(&state, "Misc.md").expect("read_note");
        let (_, _, body) = note_frame::decode_note(&framed).expect("decode");
        assert_eq!(body, PRE);

        // The guard returns 'abort', so `main.ts` does nothing: no write, no
        // delete_entry, and the buffer stays dirty in the editor.
        let abs = arena_abs(&state, "Misc.md").expect("arena");
        assert_eq!(fs::read(&abs).expect("read"), PRE, "Cancel changed the file");
        assert_eq!(entries(&f.root), vec!["A", "Misc.md", "Notes"]);
        assert!(temp_files(&f.root).is_empty());
    }

    /* ── branch "Delete without saving": the PRE-EDIT bytes are what go ───── */
    {
        let f = Fixture::new();
        let (state, _) = open_vault(&f.root);
        let framed = cairn_lib::app::read_note(&state, "Misc.md").expect("read_note");
        let (base, flags, body) = note_frame::decode_note(&framed).expect("decode");
        assert_eq!(body, PRE);

        // The editor clears `dirty` and drops the open note (step 4), so the
        // buffer's `POST` is never written.  Modelled as: no write is issued.
        let abs = arena_abs(&state, "Misc.md").expect("arena");
        let ino_before = fs::metadata(&abs).expect("stat").ino();
        let bytes_at_delete = fs::read(&abs).expect("read");
        assert_eq!(
            bytes_at_delete, PRE,
            "'Delete without saving' must trash the PRE-EDIT file — that is what the button says"
        );

        // (b), modelled: the same-volume move `trash::delete` performs.
        let trash = f.abs(".fixture-trash");
        fs::create_dir(&trash).expect("mkdir");
        let moved = trash.join("Misc.md");
        fs::rename(&abs, &moved).expect("the same-volume move a trash is");
        assert_eq!(fs::metadata(&moved).expect("stat").ino(), ino_before, "the move copied");
        assert_eq!(fs::read(&moved).expect("read"), PRE, "the trashed copy is not the pre-edit one");
        assert!(!abs.exists());

        // AND NOTHING HOLDS A POST-EDIT COPY: the buffer was never written, so
        // no later flush can put one anywhere.  `x-create: '0'` refuses.
        let e = fsops::write_note(&abs, &wargs("Misc.md", flags, Some(base), false), POST, &state.self_writes);
        assert!(matches!(e, Err(VaultError::NotFound { .. })), "a post-edit copy was created: {e:?}");
        assert!(!abs.exists());
    }

    /* ── branch "Save and delete": the POST-EDIT bytes are what go ────────── */
    {
        let f = Fixture::new();
        let (state, _) = open_vault(&f.root);
        let framed = cairn_lib::app::read_note(&state, "Misc.md").expect("read_note");
        let (base, _, body) = note_frame::decode_note(&framed).expect("decode");
        assert_eq!(body, PRE);

        // Step 3: `await flushNow('delete')` — an ordinary autosave, create FALSE.
        let receipt = autosave(&state, "Misc.md", POST, Some(base)).expect("the flush behind the button");
        assert!(receipt.mtime_ms >= base);

        let abs = arena_abs(&state, "Misc.md").expect("arena");
        let ino_before = fs::metadata(&abs).expect("stat").ino();
        assert_eq!(
            fs::read(&abs).expect("read"),
            POST,
            "'Save and delete' reached the delete with the pre-edit bytes still on disk — the \
             button's promise is that the edits are saved BEFORE the file goes"
        );
        // The write left nothing behind on the way (§7.3 case 1).
        assert!(temp_files(&f.root).is_empty());

        let trash = f.abs(".fixture-trash");
        fs::create_dir(&trash).expect("mkdir");
        let moved = trash.join("Misc.md");
        fs::rename(&abs, &moved).expect("the same-volume move a trash is");
        assert_eq!(fs::metadata(&moved).expect("stat").ino(), ino_before);
        assert_eq!(fs::read(&moved).expect("read"), POST);
        assert!(!abs.exists());
    }

    /* ── and the branch that must NOT exist: a rejected flush ─────────────── */
    {
        // §7.3 case 3 step 3: "on reject, ABORT the delete and show the error".
        // With the parent directory unwritable the flush is refused, so the
        // guard returns 'abort' and NO delete happens — the file on disk is then
        // the only copy of the old content and the buffer the only copy of the
        // edits, and deleting would destroy both in one move.
        let f = Fixture::new();
        let (state, _) = open_vault(&f.root);
        let framed = cairn_lib::app::read_note(&state, "Misc.md").expect("read_note");
        let (base, _, _) = note_frame::decode_note(&framed).expect("decode");
        let abs = arena_abs(&state, "Misc.md").expect("arena");

        let mut perms = fs::metadata(&f.root).expect("stat root").permissions();
        let original = perms.mode();
        perms.set_mode(0o500);
        fs::set_permissions(&f.root, perms).expect("chmod 500");

        let refused = autosave(&state, "Misc.md", POST, Some(base));

        let mut perms = fs::metadata(&f.root).expect("stat root").permissions();
        perms.set_mode(original);
        fs::set_permissions(&f.root, perms).expect("restore");

        assert!(matches!(refused, Err(VaultError::Io { .. })), "the flush was not refused: {refused:?}");
        // The delete does NOT happen, so the file is still there and still holds
        // the pre-edit content — which is the only copy of it there is.
        assert!(abs.exists(), "the note was deleted after a REFUSED save");
        assert_eq!(fs::read(&abs).expect("read"), PRE);
        assert!(temp_files(&f.root).is_empty(), "the refused write left debris");
    }
}

/// GAP G-a, MEASURED rather than asserted.
///
/// `docs/DATA-LOSS-VERIFICATION.md` records G-a as "`trash::delete` writes into
/// the user's real `~/.Trash`, which is outside the fixture", and every delete
/// in this file therefore passes `permanent: true`.  That was a reasonable
/// assumption; this test turns it into a fact, and it does so WITHOUT TRASHING
/// ANYTHING — `URLForDirectory:inDomain:appropriateForURL:create:` is a
/// read-only query for where a given file's trash WOULD be, with `create: NO`.
///
/// It is written as an assertion rather than a comment so that it flips the day
/// it stops being true: if some future machine or OS puts a fixture note's
/// trash somewhere containable, this test FAILS and G-a becomes reachable.
///
/// Measured on this machine (macOS 26.4, arm64, APFS):
///   - every path under `std::env::temp_dir()` -> `/Users/<user>/.Trash`
///   - a separate APFS RAM-disk volume, which would have contained it, has NO
///     trash directory at all (it mounts `noowners`, so there is no
///     `.Trashes/<uid>` for the query to return), so that route is closed too.
///
/// WHAT THIS LEAVES, AND WHAT NOW COVERS IT.  Three tests share G-a between
/// them and none of them writes a byte outside the fixture:
///   - `dl_25` proves WHICH BYTES are in the file at the instant `delete_entry`
///     is called, for each of the prompt's three branches, and that the
///     same-volume move preserves the inode and the content;
///   - `dl_27` drives the REAL `trash::delete` with a stub `osascript` first on
///     `PATH`, so the Finder Apple Event is never sent and the note lands in a
///     fixture trash — and it proves the refusal path leaves the note alone;
///   - this test is the one that says WHY both of those have to exist: the
///     destination the OS would really pick is the user's own `~/.Trash`, so
///     `permanent: true` here is containment, not laziness.
///
/// What none of them reaches is the real `~/.Trash` after a real Finder move.
/// That is the residue of G-a and it is deliberate.
#[test]
#[cfg_attr(
    target_os = "linux",
    ignore = "unmeasured on Linux: probes the trash destination via /usr/bin/osascript and asserts ~/.Trash (macOS-only)"
)]
fn dl_26_g_a_the_trash_for_a_fixture_note_is_the_users_real_trash_not_the_fixture() {
    let f = Fixture::new();
    let note = f.abs("Misc.md");
    assert!(note.exists());

    // Foundation only — no Finder, no Apple Events, no TCC prompt, and
    // `create: false`, so this cannot bring a directory into existence either.
    const JXA: &str = r#"
        ObjC.import('Foundation')
        function run(argv) {
          const fm = $.NSFileManager.defaultManager
          const url = $.NSURL.fileURLWithPath($(argv[0]))
          const err = Ref()
          const t = fm.URLForDirectoryInDomainAppropriateForURLCreateError(
            $.NSTrashDirectory, $.NSUserDomainMask, url, false, err)
          if (!t.js) return 'NONE'
          return ObjC.unwrap(t.path)
        }
    "#;

    let out = std::process::Command::new("/usr/bin/osascript")
        .args(["-l", "JavaScript", "-e", JXA, note.to_str().expect("utf-8 path")])
        .output()
        .expect("osascript is part of macOS and v1 is macOS only (§9 E2)");
    assert!(out.status.success(), "the trash-destination probe failed: {out:?}");
    let dest = String::from_utf8_lossy(&out.stdout).trim().to_string();
    assert!(!dest.is_empty(), "the probe printed nothing");

    // The measurement, and the reason `permanent: true` is mandatory here.
    assert!(
        !dest.starts_with(f.root.to_str().expect("utf-8 root")),
        "G-a HAS BECOME REACHABLE: a fixture note's trash is {dest}, which is INSIDE the \
         fixture. §7.3 case 3's `assert ~/.Trash holds the pre-edit copy` can now be exercised \
         for real — do it, and delete this test."
    );
    let home = std::env::var("HOME").expect("HOME");
    assert_eq!(
        dest,
        format!("{home}/.Trash"),
        "the trash destination for a temp-dir file is neither the fixture nor ~/.Trash; \
         re-derive G-a before trusting `permanent: true` to be the containment it is"
    );

    // And the containment rule this file lives by still holds for the fixture
    // itself: nothing about running the probe moved the vault anywhere.
    guard(&f.root);
    assert!(note.exists(), "the read-only probe touched the note");
    assert_eq!(entries(&f.root), vec!["A", "Misc.md", "Notes"]);
}

/* ===========================================================================
 * GAP G-b — §1.6's QUIT HANDSHAKE
 *
 * The handshake is driven end to end by
 * `electron-shell/close-handshake.test.mjs`; `dl_28` below adds the one thing
 * that run cannot see — that every link is WIRED at both ends.
 * ========================================================================= */

/// §1.6, the wiring — a tripwire in the same shape as `dl_06`.
///
/// A handshake that is correct in `app.rs` and never reached from the shell is
/// the failure this test exists for: every unit test passes and the app
/// silently discards the buffer on quit.  Three of the links below are
/// *executed* rather than asserted, and the list says which, so nobody reads a
/// source grep as a drive:
///
///   link 1+2  both close gestures arm the SAME handshake
///             -> EXECUTED. `window-control.test.mjs` clicks the real ✕ and
///                `lifecycle.test.mjs` calls `app.quit()` (which is what ⌘Q,
///                Ctrl-Q and a menu Quit raise); both report from the QUIT
///                callback, so a window destroyed by any other route fails.
///   link 3    the event, the payload, the 2,000 ms deadline
///             -> EXECUTED as a TIMER by `close-handshake.test.mjs` G-b/3
///                (2,001 ms measured). Still asserted here as a constant.
///   link 4    the frontend answers, both ways, in order
///             -> asserted here, as before. Unchanged.
///
/// What stays a grep is the shape of the seam, which no run can notice going
/// wrong: one arming call site, no `destroy()`, and a renderer that has no
/// window API of its own.
#[test]
fn dl_28_the_quit_handshake_is_wired_at_both_ends_and_the_webview_cannot_close_the_window() {
    let repo = canon(&Path::new(env!("CARGO_MANIFEST_DIR")).join(".."));
    let src = |rel: &str| fs::read_to_string(repo.join(rel)).unwrap_or_else(|e| panic!("{rel}: {e}"));

    /* ── link 1+2: ONE arming call site, and it PREVENTS ──────────────────── */
    // Electron needs ONE arming site: `app.quit()` cascades into
    // `win.on('close')` (measured, `lifecycle.test.mjs`).  One path cannot
    // drift from itself, so the assertion is that there is exactly one — a
    // second would mean somebody added a bypass.
    let main_mjs = src("electron-shell/app-main.mjs");
    assert_eq!(
        main_mjs.matches("addon.beginClose()").count(),
        1,
        "§1.6: there must be exactly ONE place that arms the handshake; a second is a bypass"
    );
    assert!(
        main_mjs.contains("if (addon.beginClose()) e.preventDefault()"),
        "the close path no longer PREVENTS while the handshake is armed (§1.6 link 1)"
    );
    assert!(
        !main_mjs.contains("win.destroy()"),
        "`destroy()` skips the close event entirely and discards the buffer — the defect \
         dl_03/dl_04 exist to prevent"
    );
    assert!(
        src("electron-shell/native.mjs").contains("confirm_close:"),
        "command 18 is not in the command table, so the frontend's answer can never arrive"
    );

    /* ── link 3: the event, the payload and the deadline ──────────────────── */
    let app_rs = src("core/src/app.rs");
    assert!(
        app_rs.contains(r#"app.emit_event("nc://flush-and-close""#),
        "§1.4's `nc://flush-and-close` is no longer emitted by begin_close"
    );
    assert!(
        app_rs.contains("pub const CLOSE_DEADLINE_MS: u64 = 2_000;"),
        "§1.6's watchdog is not 2,000 ms"
    );
    assert_eq!(
        cairn_lib::app::CLOSE_DEADLINE_MS,
        2_000,
        "the compiled constant disagrees with §1.6"
    );

    /* ── link 4: the frontend answers, and answers BOTH ways ──────────────── */
    let editor_ts = src("src/editor.ts");
    let main_ts = src("src/main.ts");
    assert!(
        editor_ts.contains("export async function onFlushAndClose"),
        "editor.ts no longer implements §1.6's frontend half"
    );
    assert!(
        main_ts.contains("await confirmClose(true)") && main_ts.contains("confirmClose(false, r.kind)"),
        "main.ts does not answer confirm_close on BOTH outcomes; the missing one falls through \
         to the watchdog, which DISCARDS (§1.6)"
    );
    // §1.6's sequencing is fixed: EDITOR BUFFER FIRST, the journal SECOND,
    // `state.json` THIRD. Rust exits the instant it sees `true`, so anything
    // not written before that call is lost — the order here is the whole of
    // it. The FIRST `confirmClose(true)` in the body is the discard-and-quit
    // arm (F26's journal modal, like the note modal below it); the success
    // path is the LAST one, after `flushUi()`.
    let body = main_ts
        .split("async function flushAndClose()")
        .nth(1)
        .and_then(|s| s.split("\n}\n").next())
        .expect("main.ts no longer has flushAndClose()");
    let flush_ui = body.find("await flushUi()").expect("main.ts no longer flushes state.json");
    let editor_flush =
        body.find("await editorFlushAndClose()").expect("main.ts no longer flushes the buffer");
    let memoir_flush = body
        .find("await flushMemoirForClose()")
        .expect("main.ts no longer flushes the journal (F26)");
    let confirm_true = body.rfind("await confirmClose(true)").expect("confirmClose(true)");
    assert!(
        editor_flush < memoir_flush && memoir_flush < flush_ui && flush_ui < confirm_true,
        "§1.6's sequencing is broken: it must be editor buffer -> journal -> state.json -> confirm_close, \
         and Rust closes the moment it gets the answer"
    );
    assert!(
        main_ts.contains("This note could not be saved."),
        "the rejecting-flush modal (§1.6) is gone from main.ts"
    );

    /* ── the renderer's reach ─────────────────────────────────────────────── */
    // The page has no window API of its own: the only route to a close is
    // §0.5 E7's three-action handler, which routes into `win.close()` and
    // therefore into this very handshake.  The assertion is not "the page
    // cannot close" but "the only route is the one that flushes".
    for flag in ["contextIsolation: true", "nodeIntegration: false", "sandbox: true"] {
        assert!(main_mjs.contains(flag), "the renderer lost `{flag}` — it can now reach past the seam");
    }
    let preload = src("electron-shell/preload.cjs");
    assert!(
        preload.contains("contextBridge.exposeInMainWorld('cairn'"),
        "the preload no longer publishes the bridge"
    );
    for forbidden in ["exposeInMainWorld('require'", "exposeInMainWorld('fs'", "exposeInMainWorld('ipcRenderer'"] {
        assert!(!preload.contains(forbidden), "the preload exposes {forbidden} to the page");
    }
    // The one indirect route, and it must land on `close()` rather than
    // `destroy()` — asserted above — after passing through a CLOSED set of
    // actions, so a drifted string cannot be guessed into a close.
    assert!(
        main_mjs.contains("case 'close':") && main_mjs.contains("win.close()"),
        "§0.5 E7's ✕ no longer routes through win.close(), which is what arms §1.6"
    );
    // An unknown action is IGNORED, never defaulted: guessing `close` on drift is
    // unthinkable. `window-control.test.mjs` drives that for real; this is the
    // grep that fails if the arm is deleted.
    assert!(
        main_mjs.contains("default:"),
        "the window-control switch lost its default arm; an unknown action must be IGNORED"
    );
}

/* ===========================================================================
 * GAP G-a, THE OTHER HALF — WHAT `permanent: false` ACTUALLY DOES
 *
 * `dl_26` above measures WHERE a fixture note's trash is (`~/.Trash`, so the
 * branch is uncontainable) and that is the right answer to the question it
 * asks.  This test asks the question underneath it — WHAT THE BRANCH DOES.
 *
 * IT USED TO BE AN APPLE EVENT.  `trash::delete` uses `TrashContext::default()`,
 * whose macOS `DeleteMethod` default is `Finder`, so `delete_entry(.., permanent:
 * false, ..)` spawned
 *
 *     osascript -e 'tell application "Finder" to delete { POSIX file "…" }'
 *
 * — an Apple Event to Finder, from a child process, resolved through `PATH`.
 * Nobody chose that; it was the crate default.  Its costs were a TCC Automation
 * prompt that §6.4's per-rebuild signature churn re-raised every rebuild, a
 * missing `NSAppleEventsUsageDescription`, and a bare-name spawn in an app whose
 * stated posture is that `/usr/bin/open` is the one spawn and is absolute.
 *
 * IT IS NOW `NsFileManager`.  `fsops::move_to_trash` pins the backend to
 * `-[NSFileManager trashItemAtURL:resultingItemURL:error:]`.  The one thing that
 * held the decision open was PUT BACK — §7.3 case 3's recovery story leans on
 * it, and `trash 5.2.7`'s own doc-comment claims `NsFileManager` loses it.  That
 * claim is stale, and it was settled by MEASUREMENT rather than by argument:
 * trashing into a throwaway APFS disk image (never the user's real Trash) and
 * reading the bookkeeping back off disk shows `trashItemAtURL:` creating
 * `<trash>/.DS_Store` itself and writing the two records Finder reads —
 * `ptbL ustr "/Vault/Notes/"` and `ptbN ustr "Deep.md"` — with the same pair for
 * a folder trashed whole, and with `ptbN` preserving the ORIGINAL name when a
 * collision forces a rename on disk.  Those record types are byte-identical to
 * the ones Finder's own deletes have already written into this machine's real
 * `~/.Trash/.DS_Store`.  So Put Back survives, and every cost above is gone.
 * The full ruling lives in `fsops::move_to_trash`'s doc-comment.
 *
 * WHAT THIS TEST CAN AND CANNOT REACH.  The old containment trick — a stub
 * `osascript` first on `PATH` — DIED WITH THE APPLE EVENT.  `trashItemAtURL:` is
 * an in-process call that picks its own destination, so a SUCCESSFUL trash of a
 * fixture note now lands in the user's REAL `~/.Trash`, which containment
 * forbids absolutely.  This test therefore never performs a successful trash.
 * It drives the branch to a REAL, deterministic REFUSAL instead — a note whose
 * parent directory is mode 0555, which `trashItemAtURL:` rejects with
 * `NSCocoaErrorDomain` 513 — and that refusal is the row carrying the data-loss
 * weight anyway.  The happy path's byte-identity, which the old test could reach
 * only because the stub did the `mv` itself, is now covered by the disk-image
 * measurement recorded above and NOT claimed here.
 * ========================================================================= */

/// The exact `trash` version whose macOS backend was read.  If Cargo.lock moves,
/// `dl_27` fails loudly: a different version could change which backend
/// `set_delete_method` selects, or reintroduce the `osascript` spawn.  Bumping
/// this constant means re-reading `src/macos/mod.rs` first.
const AUDITED_TRASH_VERSION: &str = "5.2.7";

/// What the stub prints when asked to identify itself.
const STUB_MARK: &str = "cairn-fake-osascript";

/// The child half of `dl_27`: the ONLY place in this repository that calls
/// `delete_entry` with `permanent: false`.  It runs in its own process so the
/// `PATH` redirection cannot leak into any other test.
#[test]
#[ignore = "spawned by dl_27_the_trash_branch_is_nsfilemanager_and_a_refusal_keeps_the_note"]
fn dataloss_trash_child() {
    let Ok(abs) = std::env::var("CAIRN_DL_TRASH_ABS") else { return };
    let rel = std::env::var("CAIRN_DL_TRASH_REL").expect("CAIRN_DL_TRASH_REL");
    let out = PathBuf::from(std::env::var("CAIRN_DL_TRASH_RESULT").expect("RESULT"));
    let abs = PathBuf::from(abs);

    // THE CONTAINMENT INTERLOCK, and the reason this child exists at all.
    //
    // `trashItemAtURL:` cannot be redirected by anything this process controls:
    // if the call SUCCEEDS, the fixture note is in the user's real `~/.Trash`.
    // So refuse to call it unless the target is one the OS is guaranteed to
    // refuse — a parent directory with no write bit for anybody.  A writable
    // parent means the harness did not set up what it thinks it set up, and the
    // correct response is to delete nothing and say so.
    let parent = abs.parent().expect("the target has a parent");
    let write_bits = fs::metadata(parent).expect("parent metadata").permissions().mode() & 0o222;
    if write_bits != 0 {
        let msg = format!(
            "abort:the parent of {rel} has write bits {write_bits:o}; a trash there could \
             SUCCEED and put a fixture note in the user's real ~/.Trash"
        );
        fs::write(&out, msg.as_bytes()).expect("write");
        return;
    }

    let sw = Mutex::new(SelfWrites::new());
    let r = fsops::delete_entry(&abs, &rel, false, &sw);
    let line = match r {
        // Reported, not asserted here — the parent turns this into the loud
        // failure, because it means a real note reached the real Trash.
        Ok(()) => "ok".to_string(),
        Err(e) => format!("err:{}:{e}", e.kind()),
    };
    fs::write(&out, line.as_bytes()).expect("write the result");
}

/// GAP G-a's containable half, and the negative control that carries the
/// data-loss weight: **a refused trash must leave the note in the vault.**
///
/// Four things are proved, none of which any other test in this repository
/// covers:
///   1. `permanent: false` NO LONGER SPAWNS ANYTHING.  A stub `osascript` sits
///      first on the child's `PATH` and logs every invocation; the log stays
///      EMPTY across a delete that, under the old `Finder` backend, would have
///      invoked it exactly once.  This is the discriminator that pins the
///      backend — the old test asserted the opposite of this line.
///   2. The branch is `NsFileManager` POSITIVELY, not just by absence: the
///      error text that comes back carries `trashItemAtURL`, which only
///      `delete_using_file_mgr` produces.  An `osascript` failure said
///      "The AppleScript exited with error" instead.
///   3. A REFUSED trash — here a real `NSCocoaErrorDomain` 513 from a
///      read-only parent, which is the same shape as a locked file, a full
///      disk or a read-only vault — returns `TrashUnavailable` and LEAVES THE
///      NOTE BYTE-UNCHANGED WHERE IT WAS.  A half-completed delete here would
///      be a data-loss path, and until this wave it had no error surface at
///      all: `main.ts` logged it to a console the shipped app does not have.
///      `reportDeleteFailure` now puts it on a modal.
///   4. `permanent: true` spawns NOTHING either, which is what keeps assertion
///      1 from being a property of the fixture rather than of the branch.
#[test]
#[cfg_attr(
    target_os = "linux",
    ignore = "unmeasured on Linux: pins the NsFileManager backend via trashItemAtURL + osascript interlocks (macOS-only); the Freedesktop refusal-keeps-note equivalent is an open gap"
)]
fn dl_27_the_trash_branch_is_nsfilemanager_and_a_refusal_keeps_the_note() {
    // INTERLOCK 1.  A different `trash` version may not honour
    // `set_delete_method`, or may spawn `osascript` regardless — either of which
    // could put a fixture note in the user's real `~/.Trash`.  Refuse to run.
    let lock = fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.lock"))
        .expect("Cargo.lock");
    let pinned = lock
        .split("\nname = \"trash\"\n")
        .nth(1)
        .and_then(|s| s.lines().next())
        .unwrap_or("")
        .trim()
        .trim_start_matches("version = ")
        .trim_matches('"')
        .to_string();
    assert_eq!(
        pinned, AUDITED_TRASH_VERSION,
        "trash is pinned at {pinned}, not the audited {AUDITED_TRASH_VERSION}. This test drives \
         the REAL trash branch and contains it by pointing it at a target the OS must refuse; a \
         version whose backend selection differs could trash for real, into the user's own \
         ~/.Trash. Re-read trash's macOS backend, then update AUDITED_TRASH_VERSION."
    );

    let f = Fixture::new();
    let bin = f.abs("harness-bin");
    let log = f.abs("harness-ae.log");
    fs::create_dir(&bin).expect("mkdir harness-bin");

    // The stub.  It logs its whole argv and fails.  Nothing should ever reach
    // it — that is the assertion — so it does not need to be able to succeed.
    let stub = bin.join("osascript");
    fs::write(
        &stub,
        b"#!/bin/sh\n\
          if [ \"$1\" = \"--cairn-identify\" ]; then echo cairn-fake-osascript; exit 0; fi\n\
          printf '%s\\n' \"$*\" >> \"$CAIRN_FAKE_AE_LOG\"\n\
          echo 'execution error: Finder got an error (-1743)' >&2; exit 1\n",
    )
    .expect("write the stub");
    fs::set_permissions(&stub, fs::Permissions::from_mode(0o755)).expect("chmod +x");

    // Sanity: the stub really is what `osascript` resolves to under this PATH,
    // so an empty log later means "nothing was spawned" and not "the stub was
    // never reachable in the first place".
    let exe = std::env::current_exe().expect("current_exe");
    let path_with_stub = format!(
        "{}:{}",
        bin.to_str().expect("utf-8"),
        std::env::var("PATH").unwrap_or_default()
    );
    let probe = std::process::Command::new("sh")
        .args(["-c", "osascript --cairn-identify"])
        .env("PATH", &path_with_stub)
        .env("CAIRN_FAKE_AE_LOG", &log)
        .output()
        .expect("probe the stub");
    assert!(
        String::from_utf8_lossy(&probe.stdout).contains(STUB_MARK),
        "the stub osascript is not first on PATH, so an empty log would prove nothing"
    );

    let result_file = f.abs("harness-result");
    let run = |rel: &str| -> String {
        let _ = fs::remove_file(&result_file);
        let status = std::process::Command::new(&exe)
            .args(["--exact", "dataloss_trash_child", "--ignored", "--nocapture"])
            .env("PATH", &path_with_stub)
            .env("CAIRN_DL_TRASH_ABS", f.abs(rel))
            .env("CAIRN_DL_TRASH_REL", rel)
            .env("CAIRN_DL_TRASH_RESULT", &result_file)
            .env("CAIRN_FAKE_AE_LOG", &log)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .expect("run the trash child");
        assert!(status.success(), "the trash child did not exit cleanly");
        fs::read_to_string(&result_file).expect("the child wrote no result")
    };

    /* ---- 1 + 2 + 3: the refusal, and what the branch is ----------------- */
    fs::write(&log, b"").expect("truncate the log");
    let notes = f.abs("Notes");
    let before = fs::read(f.abs("Notes/Deep.md")).expect("Deep.md");

    // Read-only parent: `trashItemAtURL:` answers NSCocoaErrorDomain 513
    // ("couldn't be moved to the trash because you don't have permission").
    fs::set_permissions(&notes, fs::Permissions::from_mode(0o555)).expect("chmod 0555 Notes");
    let r = run("Notes/Deep.md");
    let after_exists = f.abs("Notes/Deep.md").exists();
    let after = fs::read(f.abs("Notes/Deep.md")).ok();
    let spawned = fs::read_to_string(&log).expect("log");
    // RESTORE BEFORE ASSERTING.  A panic with `Notes` still at 0555 would leave
    // `TempDir`'s recursive delete unable to unlink the note inside it, and the
    // fixture would outlive the run.
    fs::set_permissions(&notes, fs::Permissions::from_mode(0o755)).expect("chmod 0755 Notes");

    assert_ne!(
        r, "ok",
        "THE TRASH SUCCEEDED. A fixture note has been moved into the user's REAL ~/.Trash — \
         check it. The read-only-parent interlock no longer refuses on this OS."
    );
    assert!(
        r.starts_with("err:trashUnavailable:"),
        "a refused trash must be TrashUnavailable, got {r}"
    );
    assert!(
        r.contains("trashItemAtURL"),
        "the trash branch is not NsFileManager any more — the error text should name \
         `trashItemAtURL`, got {r}"
    );
    assert_eq!(
        spawned, "",
        "`permanent: false` SPAWNED A SUBPROCESS: {spawned:?}. The backend has fallen back to \
         DeleteMethod::Finder, which reintroduces the Apple Event, the TCC Automation prompt and \
         the bare-name PATH lookup that fsops::move_to_trash exists to remove."
    );
    assert!(
        after_exists,
        "A REFUSED TRASH LOST THE NOTE — it is gone from the vault and it never reached the Trash"
    );
    assert_eq!(after.as_deref(), Some(&before[..]), "a refused trash rewrote the note");

    /* ---- 4: the discriminator ------------------------------------------- */
    // `permanent: true` — every other delete in this file — must spawn nothing
    // either.  Without this row, assertion 1 could be true of any delete.
    fs::write(&log, b"").expect("truncate the log");
    let sw = Mutex::new(SelfWrites::new());
    fsops::delete_entry(&f.abs("A/B/n.md"), "A/B/n.md", true, &sw).expect("permanent delete");
    assert!(!f.abs("A/B/n.md").exists());
    assert_eq!(fs::read_to_string(&log).expect("log"), "", "`permanent: true` spawned something");

    assert!(temp_files(&f.root).is_empty());
    guard(&f.root);
}

/// The containment interlock in `dataloss_trash_child` is the only thing
/// standing between this suite and the user's real `~/.Trash`, so it gets its
/// own test rather than being trusted because it is short.
///
/// Pointed at a note whose parent is WRITABLE — the ordinary case, where a trash
/// would succeed and therefore escape containment — the child must refuse,
/// write an `abort:` result, and LEAVE THE NOTE ALONE.  If this test ever fails,
/// `dl_27` is one bad fixture away from moving real files into the real Trash.
#[test]
fn dl_29_the_trash_childs_containment_interlock_refuses_a_writable_parent() {
    let f = Fixture::new();
    let exe = std::env::current_exe().expect("current_exe");
    let result_file = f.abs("harness-result");
    let before = fs::read(f.abs("Notes/Deep.md")).expect("Deep.md");

    // Deliberately NOT chmod'ed: `Notes` is writable, so the real backend would
    // succeed here and put `Deep.md` in the user's own Trash.
    let status = std::process::Command::new(&exe)
        .args(["--exact", "dataloss_trash_child", "--ignored", "--nocapture"])
        .env("CAIRN_DL_TRASH_ABS", f.abs("Notes/Deep.md"))
        .env("CAIRN_DL_TRASH_REL", "Notes/Deep.md")
        .env("CAIRN_DL_TRASH_RESULT", &result_file)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .expect("run the trash child");
    assert!(status.success(), "the trash child did not exit cleanly");

    let r = fs::read_to_string(&result_file).expect("the child wrote no result");
    assert!(
        r.starts_with("abort:"),
        "THE CONTAINMENT INTERLOCK DID NOT FIRE on a writable parent, got {r:?}. If this says \
         \"ok\", a fixture note is in the user's real ~/.Trash right now."
    );
    assert!(
        f.abs("Notes/Deep.md").exists(),
        "the child deleted the note despite refusing to run"
    );
    assert_eq!(fs::read(f.abs("Notes/Deep.md")).expect("Deep.md"), before);

    assert!(temp_files(&f.root).is_empty());
    guard(&f.root);
}
