//! Owner: 02.  Integration: a REAL temp vault, on the real filesystem.
//! Spec: CONTRACT.md §7.3 (the enumerated paths), §2.4 (the round-trip
//! invariant, gate G-RT), §7.1 (the three structural rules), gates G8, G-RT.
//!
//! EVERY TEST HERE USES A `tempfile` FIXTURE VAULT.  Nothing in this file may
//! touch a real vault, `~/Documents` or anything under `~/Library`.
//!
//! The unit tests inside `fsops.rs`, `note_frame.rs`, `watcher.rs` and
//! `prefs.rs` cover each rule in isolation; this file covers the SCENARIOS —
//! the ones §7.3 describes in terms of what the user did, where more than one
//! rule has to hold at once, and where the interesting failures are between
//! processes rather than inside one.
//!
//! THE FILE IS IN TWO PARTS, and each has its own helpers so neither renames the
//! other's fixtures.  PART 1 (here) is `fsops.rs` / `note_frame.rs`: the §7.3
//! scenarios and the data-loss gates G-RT and G8.  PART 2 (below, after the
//! banner) is `tree.rs` / `scan.rs` / `path.rs` / `vault.rs`: the arena, the
//! walk, TreeBlob v1, the sort orders, the two §3.3 caps and the snapshot seam —
//! gates G1, G2 and G3.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use cairn_lib::error::VaultError;
use cairn_lib::fsops;
use cairn_lib::note_frame::{self, WriteArgs, FLAG_BOM, FLAG_CRLF};
use cairn_lib::watcher::SelfWrites;

fn sw() -> Mutex<SelfWrites> {
    Mutex::new(SelfWrites::new())
}

fn args(rel: &str, flags: u32, base: Option<i64>, create: bool) -> WriteArgs {
    WriteArgs { rel: rel.into(), flags, base_mtime_ms: base, create }
}

/// Names of everything in `dir`, sorted.  Gate G8 is read off this.
fn entries(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = fs::read_dir(dir)
        .expect("read_dir")
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    v.sort();
    v
}

/// Every `.tmp-` file anywhere under `root` (§7.3 case 1's "zero" assertion).
fn temp_files(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut q = vec![root.to_path_buf()];
    while let Some(d) = q.pop() {
        let Ok(rd) = fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
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

/* ── G-RT: the §2.4 round-trip invariant, through the filesystem ──────────── */

/// The seven cases §2.4 names, each written to a real file, READ through
/// `read_note`, and written straight back through `write_note` WITH NO EDIT.
/// The assertion is `cmp`-exact: the same bytes, BOM and CRLF included.
///
/// This is T2.1 and gate G-RT.  It is the test that catches a save which
/// "helpfully" normalises somebody's Windows-authored vault.
#[test]
fn g_rt_t2_1_read_then_save_with_no_edit_is_byte_identical() {
    let dir = tempfile::tempdir().unwrap();
    let root = fsops::canonical_root(dir.path()).unwrap();
    let s = sw();
    let cjk = "\u{4F60}\u{597D}\u{4E16}\u{754C} \u{1F600}\u{1F1EF}\u{1F1F5}";
    let bom: [u8; 3] = [0xEF, 0xBB, 0xBF];

    let cases: Vec<(&str, Vec<u8>)> = vec![
        ("lf.md", b"one\ntwo\nthree\n".to_vec()),
        ("crlf.md", b"one\r\ntwo\r\nthree\r\n".to_vec()),
        ("bom-lf.md", [&bom[..], b"one\ntwo\n"].concat()),
        ("bom-crlf.md", [&bom[..], b"one\r\ntwo\r\n"].concat()),
        ("bom-crlf-cjk.md", [&bom[..], format!("{cjk}\r\n{cjk}\r\n").as_bytes()].concat()),
        ("cjk-200k.md", cjk.repeat(200 * 1024 / cjk.len()).into_bytes()),
        ("ascii-1m.md", b"the quick brown fox\n".repeat(1024 * 1024 / 20)),
    ];

    for (name, original) in &cases {
        let abs = root.join(name);
        fs::write(&abs, original).unwrap();

        let read = fsops::read_note(&abs, name).unwrap();
        // Nothing the editor receives may carry a BOM or a CR (§2.4).
        assert!(!read.bytes.starts_with(&bom), "{name}: a BOM reached the editor");
        assert!(
            !read.bytes.windows(2).any(|w| w == b"\r\n"),
            "{name}: a CRLF reached the editor"
        );

        // Save with no edit, exactly as an autosave would: flags echoed
        // verbatim, x-create '0'.
        let a = args(name, read.flags, Some(read.mtime_ms), false);
        fsops::write_note(&abs, &a, &read.bytes, &s).unwrap();

        assert_eq!(
            fs::read(&abs).unwrap(),
            *original,
            "{name}: a no-edit save changed the file's bytes"
        );
    }

    // G8, on the same fixture: seven notes went in, seven files are there.
    assert_eq!(entries(&root).len(), cases.len());
    assert!(temp_files(&root).is_empty());
}

/// The frame the frontend actually receives, end to end: `read_note` ->
/// `encode_note` -> `decode_note` -> `write_note` is still byte-identical.
#[test]
fn g_rt_survives_the_wire_frame() {
    let dir = tempfile::tempdir().unwrap();
    let root = fsops::canonical_root(dir.path()).unwrap();
    let s = sw();
    let original = [&[0xEF, 0xBB, 0xBF][..], b"line one\r\nline two\r\n"].concat();
    let abs = root.join("n.md");
    fs::write(&abs, &original).unwrap();

    let framed = fsops::read_note_framed(&abs, "n.md").unwrap();
    let (mtime_ms, flags, text) = note_frame::decode_note(&framed).unwrap();
    assert_eq!(flags, FLAG_BOM | FLAG_CRLF);
    assert_eq!(text, b"line one\nline two\n");

    fsops::write_note(&abs, &args("n.md", flags, Some(mtime_ms), false), text, &s).unwrap();
    assert_eq!(fs::read(&abs).unwrap(), original);
}

/* ── §7.3 case 3 (B17): delete the open note, then let autosave fire ─────── */

/// THE RESURRECTION TEST.  The user types into `Misc.md`, deletes it, and both
/// autosave timers then fire (800 ms idle and 5 s sustained) — this walks past
/// both by calling the write directly, which is strictly harsher than waiting.
///
/// The file must NOT reappear.  §7.1 rule 1 makes it impossible by
/// construction rather than by timer luck: `x-create: '0'` and a missing
/// destination is `NotFound`, and it is `NotFound` whether or not a base mtime
/// is supplied.
#[test]
fn case_3_a_deleted_note_is_never_resurrected_by_autosave() {
    let dir = tempfile::tempdir().unwrap();
    let root = fsops::canonical_root(dir.path()).unwrap();
    let s = sw();
    let abs = root.join("Misc.md");
    fs::write(&abs, b"before\n").unwrap();

    let read = fsops::read_note(&abs, "Misc.md").unwrap();

    // The user deletes it (permanently here: `trash::delete` would move it into
    // the REAL ~/.Trash, and no test of ours may write outside its fixture).
    fsops::delete_entry(&abs, "Misc.md", true, &s).unwrap();
    assert!(!abs.exists());

    // Now every flush the editor could possibly issue, in the order it would
    // issue them: the idle flush, the blur flush, the close flush.
    for base in [Some(read.mtime_ms), None] {
        let e = fsops::write_note(&abs, &args("Misc.md", read.flags, base, false), b"typed\n", &s)
            .unwrap_err();
        assert_eq!(e.kind(), "notFound", "an autosave recreated a deleted note");
    }

    assert!(!abs.exists(), "the note came back");
    assert!(entries(&root).is_empty(), "the vault is not empty: {:?}", entries(&root));
}

/// §7.3 case 6: a FOLDER is deleted while a note inside it is open.  Identical
/// invariant — the containing folder's disappearance is a coarser version of the
/// note disappearing — and nothing under the folder may be recreated.
#[test]
fn case_6_a_folder_delete_takes_the_open_note_with_it_and_nothing_comes_back() {
    let dir = tempfile::tempdir().unwrap();
    let root = fsops::canonical_root(dir.path()).unwrap();
    let s = sw();
    fs::create_dir_all(root.join("A/B")).unwrap();
    let abs = root.join("A/B/n.md");
    fs::write(&abs, b"open and dirty\n").unwrap();
    let read = fsops::read_note(&abs, "A/B/n.md").unwrap();

    fsops::delete_entry(&root.join("A"), "A", true, &s).unwrap();
    assert!(!root.join("A").exists());

    let e = fsops::write_note(&abs, &args("A/B/n.md", read.flags, None, false), b"typed\n", &s)
        .unwrap_err();
    assert_eq!(e.kind(), "notFound");
    assert!(!root.join("A").exists(), "the write recreated the folder tree");
    assert!(entries(&root).is_empty());
}

/* ── §7.3 case 5: the open note is renamed or moved externally ───────────── */

/// `mv Misc.md Other.md` from a shell with a dirty buffer.  The autosave that
/// follows must write to NEITHER path: not to the old one (it is gone -> the
/// bar appears), and not to the new one (we do not follow renames — FSEvents
/// pairing is unreliable and following a mis-paired rename writes the buffer
/// into the wrong file).
///
/// Then `Save as…` — the ONE producer of `x-create: '1'` in the whole app —
/// into a fresh name writes exactly once; into an EXISTING name it is
/// `alreadyExists` and writes nothing.
#[test]
fn case_5_an_external_rename_stops_autosave_and_save_as_is_the_only_way_out() {
    let dir = tempfile::tempdir().unwrap();
    let root = fsops::canonical_root(dir.path()).unwrap();
    let s = sw();
    let old = root.join("Misc.md");
    let new = root.join("Other.md");
    fs::write(&old, b"original\n").unwrap();
    let read = fsops::read_note(&old, "Misc.md").unwrap();

    // Somebody's shell.
    fs::rename(&old, &new).unwrap();

    // The autosave that was already queued.
    let e = fsops::write_note(&old, &args("Misc.md", read.flags, Some(read.mtime_ms), false), b"dirty\n", &s)
        .unwrap_err();
    assert_eq!(e.kind(), "notFound");
    assert!(!old.exists(), "autosave recreated the old name");
    assert_eq!(fs::read(&new).unwrap(), b"original\n", "autosave followed the rename");

    // Save as… into a fresh name: exactly one write, with create = true.
    let fresh = root.join("Rescued.md");
    fsops::write_note(&fresh, &args("Rescued.md", read.flags, None, true), b"dirty\n", &s).unwrap();
    assert_eq!(fs::read(&fresh).unwrap(), b"dirty\n");

    // Save as… into an EXISTING name: refused, and zero writes.
    let e = fsops::write_note(&new, &args("Other.md", read.flags, None, true), b"dirty\n", &s)
        .unwrap_err();
    assert_eq!(e.kind(), "alreadyExists");
    assert_eq!(fs::read(&new).unwrap(), b"original\n", "Save-As overwrote an existing note");

    assert_eq!(entries(&root), vec!["Other.md".to_string(), "Rescued.md".to_string()]);
}

/* ── §7.3 case 7: concurrent edit from Obsidian ──────────────────────────── */

/// Open a note, edit it from a shell, then type in the app: EXACTLY ONE
/// `conflict`, the disk file still holds the shell's content, and NO write
/// occurred.  Then "Keep mine" (`x-base-mtime: ""`) goes through, because the
/// user was asked and answered.
#[test]
fn case_7_an_obsidian_edit_is_never_silently_clobbered() {
    let dir = tempfile::tempdir().unwrap();
    let root = fsops::canonical_root(dir.path()).unwrap();
    let s = sw();
    let abs = root.join("Shared.md");
    fs::write(&abs, b"as opened\n").unwrap();
    let read = fsops::read_note(&abs, "Shared.md").unwrap();

    std::thread::sleep(Duration::from_millis(20));
    fs::write(&abs, b"obsidian wrote this\n").unwrap();

    let a = args("Shared.md", read.flags, Some(read.mtime_ms), false);
    match fsops::write_note(&abs, &a, b"my typing\n", &s) {
        Err(VaultError::Conflict { path, disk_mtime_ms }) => {
            assert_eq!(path, "Shared.md");
            assert!(disk_mtime_ms != read.mtime_ms);
        }
        other => panic!("expected a conflict, got {other:?}"),
    }
    assert_eq!(fs::read(&abs).unwrap(), b"obsidian wrote this\n");
    assert!(temp_files(&root).is_empty(), "the refused write left a temp behind");

    // Autosave stops for that note; the user picks "Keep mine".
    fsops::write_note(&abs, &args("Shared.md", read.flags, None, false), b"my typing\n", &s)
        .unwrap();
    assert_eq!(fs::read(&abs).unwrap(), b"my typing\n");
}

/* ── §7.3 case 10: case-only renames on APFS ─────────────────────────────── */

/// The two halves of case 10, on the real filesystem, which is the only place
/// the case-insensitivity is real: `notes.md` -> `Notes.md` succeeds with the
/// content intact, and a SECOND file that collides only by case is refused.
#[test]
fn case_10_case_only_rename_succeeds_and_a_case_collision_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let root = fsops::canonical_root(dir.path()).unwrap();
    let s = sw();

    let lower = root.join("notes.md");
    fs::write(&lower, b"the content\n").unwrap();
    let upper = root.join("Notes.md");

    fsops::rename_entry(&lower, &upper, &s).unwrap();
    assert_eq!(fs::read(&upper).unwrap(), b"the content\n");
    assert_eq!(entries(&root), vec!["Notes.md".to_string()]);
    assert!(temp_files(&root).is_empty(), "the two-step rename left its intermediate behind");

    // A second file created from a shell, then renamed to collide only by case.
    let case_insensitive = fs::write(root.join("NOTES.md"), b"other\n").is_ok()
        && entries(&root).len() == 1;
    if case_insensitive {
        // On APFS's default, `NOTES.md` IS `Notes.md`; the shell just
        // overwrote it.  That is the filesystem's answer, and the app must not
        // pretend otherwise.
        assert_eq!(entries(&root), vec!["Notes.md".to_string()]);
    } else {
        let other = root.join("Other.md");
        fs::write(&other, b"other\n").unwrap();
        let e = fsops::rename_entry(&other, &upper, &s).unwrap_err();
        assert_eq!(e.kind(), "alreadyExists");
        assert_eq!(fs::read(&upper).unwrap(), b"the content\n");
    }
}

/* ── §7.3 case 1 + M67: the crash sweep ──────────────────────────────────── */

/// Debris from a process that is gone is unlinked ON SIGHT, not after an hour,
/// and nothing else in the vault is touched.  The hour-only rule let crash
/// debris created minutes before the next launch survive — and in an iCloud or
/// Dropbox vault it is replicated to every other device before it ages out.
#[test]
fn case_1_m67_the_sweep_clears_dead_debris_and_spares_everything_else() {
    let dir = tempfile::tempdir().unwrap();
    let root = fsops::canonical_root(dir.path()).unwrap();
    fs::create_dir_all(root.join("A/B")).unwrap();

    fs::write(root.join("Keep.md"), b"a note\n").unwrap();
    fs::write(root.join("A/B/Deep.md"), b"another\n").unwrap();
    fs::write(root.join(".obsidian"), b"config\n").unwrap();
    fs::write(root.join(".DS_Store"), b"finder\n").unwrap();
    // Debris from a PID that cannot be alive.
    fs::write(root.join(".Keep.md.tmp-4000000000-1"), b"crash\n").unwrap();
    fs::write(root.join("A/B/.Deep.md.tmp-4000000000-2"), b"crash\n").unwrap();
    // …and one from THIS process, which another instance might be mid-write on.
    let mine = root.join(format!(".Keep.md.tmp-{}-3", std::process::id()));
    fs::write(&mine, b"in flight\n").unwrap();

    assert_eq!(fsops::sweep_temps_in(&root), 2);
    assert!(mine.exists(), "a live process's in-flight write was swept");
    assert_eq!(entries(&root).len(), 5); // Keep.md, A, .obsidian, .DS_Store, mine
    assert!(root.join("A/B/Deep.md").exists());
}

/* ── §7.3 case 1: killed mid-save ────────────────────────────────────────── */

/// The child half of `case_1_killed_mid_save_is_all_or_nothing`.  `#[ignore]`
/// so an ordinary `cargo test` never runs it; the parent invokes it by name.
///
/// It writes a 1 MiB note in a tight loop through the real `write_note`, so
/// that a SIGKILL has a good chance of landing inside `write_all` or between
/// the fsync and the rename — the two places a non-atomic implementation tears.
#[test]
#[ignore = "spawned by case_1_killed_mid_save_is_all_or_nothing"]
fn kill_child_writer() {
    let Ok(dir) = std::env::var("CAIRN_KILL_DIR") else { return };
    let root = PathBuf::from(dir);
    let abs = root.join("Note.md");
    let s = sw();
    let new = new_content();
    loop {
        let _ = fsops::write_note(&abs, &args("Note.md", 0, None, false), &new, &s);
    }
}

fn old_content() -> Vec<u8> {
    b"OLD ".repeat(256 * 1024)
}

fn new_content() -> Vec<u8> {
    b"NEW ".repeat(256 * 1024)
}

/// §7.3 case 1, the mandated test: write in a loop while SIGKILLing the
/// process; after each kill the file must hash to EITHER the old or the new
/// content — never truncated, never torn — and the next vault open must leave
/// ZERO `.tmp-` files.
///
/// A real second process, really SIGKILLed (`Child::kill` is SIGKILL on Unix),
/// because the whole claim is about what survives when no destructor runs: an
/// in-process simulation would exercise the `TempGuard` this test is trying to
/// do without.
#[test]
fn case_1_killed_mid_save_is_all_or_nothing() {
    let exe = std::env::current_exe().expect("current_exe");
    let old = old_content();
    let new = new_content();
    // A round in which the child never got a write in proves nothing, and six
    // such rounds would be a green test that exercises no code at all.  Count
    // the rounds where the note actually changed hands.
    let mut rounds_the_child_wrote = 0u32;

    for round in 0..6 {
        let dir = tempfile::tempdir().unwrap();
        let root = fsops::canonical_root(dir.path()).unwrap();
        let abs = root.join("Note.md");
        fs::write(&abs, &old).unwrap();

        let mut child = std::process::Command::new(&exe)
            .args(["--exact", "kill_child_writer", "--ignored", "--nocapture"])
            .env("CAIRN_KILL_DIR", &root)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn the writer");

        // Vary where the axe falls: process start-up, the first write, and a
        // steady state of writes are all different moments.
        std::thread::sleep(Duration::from_millis(40 + round * 25));
        child.kill().expect("SIGKILL");
        let _ = child.wait();

        let after = fs::read(&abs).unwrap();
        assert!(
            after == old || after == new,
            "round {round}: the note was torn — {} bytes, starts {:?}",
            after.len(),
            after.get(..16)
        );
        if after == new {
            rounds_the_child_wrote += 1;
        }

        // "…and that the next vault open leaves ZERO `.tmp-` files."  The
        // child's PID is dead, so M67 unlinks its debris on sight.
        fsops::sweep_temps_in(&root);
        assert!(
            temp_files(&root).is_empty(),
            "round {round}: crash debris survived the sweep: {:?}",
            temp_files(&root)
        );
        assert_eq!(entries(&root), vec!["Note.md".to_string()], "round {round}");
    }

    assert!(
        rounds_the_child_wrote > 0,
        "the child never completed a single write, so nothing was actually killed \
         mid-save and this test proved nothing"
    );
}

/* ── §7.3 case 9: a vault on iCloud / Dropbox / Syncthing ────────────────── */

/// The case-9 test, as specified: run the write loop inside a directory a
/// second process is concurrently copying out of.  Assert no `.tmp-` file
/// survives and no note is truncated.
///
/// A sync client's reader is what this is really about: temp+rename inside the
/// SAME directory means a reader either sees the old inode or the new one, and
/// never a partially-written file.  A cross-directory move — which some clients
/// handle as delete+create — would break exactly that.
#[test]
fn case_9_a_concurrent_reader_never_sees_a_partial_note() {
    let dir = tempfile::tempdir().unwrap();
    let root = fsops::canonical_root(dir.path()).unwrap();
    let abs = root.join("Synced.md");
    let old = old_content();
    let new = new_content();
    fs::write(&abs, &old).unwrap();

    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let reader = {
        let abs = abs.clone();
        let stop = std::sync::Arc::clone(&stop);
        let (old, new) = (old.clone(), new.clone());
        std::thread::spawn(move || {
            let mut reads = 0u32;
            while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                if let Ok(b) = fs::read(&abs) {
                    assert!(
                        b == old || b == new,
                        "a concurrent reader saw {} bytes - a partial note",
                        b.len()
                    );
                    reads += 1;
                }
            }
            reads
        })
    };

    let s = sw();
    for _ in 0..40 {
        fsops::write_note(&abs, &args("Synced.md", 0, None, false), &new, &s).unwrap();
        fsops::write_note(&abs, &args("Synced.md", 0, None, false), &old, &s).unwrap();
    }
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    let reads = reader.join().expect("the reader saw a torn file");
    assert!(reads > 0, "the reader never actually read anything");

    assert!(temp_files(&root).is_empty(), "{:?}", temp_files(&root));
    assert_eq!(entries(&root), vec!["Synced.md".to_string()]);
}

/* ── gate G8 ─────────────────────────────────────────────────────────────── */

/// G8: THE VAULT IS WRITTEN TO ONLY FOR NOTES.  A full session's worth of
/// mutations — create, write, rename, delete, and a `state.json` flush — and the
/// vault holds exactly the notes and folders the user asked for.  `state.json`
/// lives in the config directory, never inside the vault.
#[test]
fn g8_a_whole_session_leaves_only_the_users_notes() {
    let dir = tempfile::tempdir().unwrap();
    let root = fsops::canonical_root(dir.path()).unwrap();
    let config = tempfile::tempdir().unwrap();
    let s = sw();

    let (folder, _) = fsops::create_folder(&root, Some("Projects"), &s).unwrap();
    let (note, name) = fsops::create_note(&folder, None, &s).unwrap();
    assert_eq!(name, "Untitled.md");

    fsops::write_note(&note, &args("Projects/Untitled.md", 0, None, false), b"# Ideas\n", &s)
        .unwrap();

    let renamed = fsops::rename_target(&note, "Ideas", true).unwrap();
    fsops::rename_entry(&note, &renamed, &s).unwrap();

    let (scratch, _) = fsops::create_note(&root, Some("Scratch"), &s).unwrap();
    fsops::delete_entry(&scratch, "Scratch.md", true, &s).unwrap();

    // The prefs flush, which is the one other thing the app writes.
    let prefs = std::sync::Arc::new(cairn_lib::prefs::PrefsStore::load(
        config.path().join("state.json"),
    ));
    prefs.edit(|st| st.touch_vault(&root.to_string_lossy()));
    prefs.flush_now().unwrap();

    assert_eq!(entries(&root), vec!["Projects".to_string()]);
    assert_eq!(entries(&folder), vec!["Ideas.md".to_string()]);
    assert!(temp_files(&root).is_empty());
    assert!(
        !root.join("state.json").exists(),
        "state.json was written INSIDE the vault"
    );
    assert!(config.path().join("state.json").is_file());
}

/* ── §7.3 case 15 and case 14, on real files ─────────────────────────────── */

#[test]
fn case_15_an_over_cap_note_is_refused_without_reading_it_all() {
    let dir = tempfile::tempdir().unwrap();
    let root = fsops::canonical_root(dir.path()).unwrap();
    let abs = root.join("Huge.md");
    let limit = note_frame::MAX_NOTE_BYTES;
    fs::write(&abs, vec![b'x'; limit as usize + 1]).unwrap();

    match fsops::read_note(&abs, "Huge.md") {
        Err(VaultError::TooLarge { path, bytes, limit: l }) => {
            assert_eq!(path, "Huge.md");
            assert_eq!(bytes, limit + 1);
            assert_eq!(l, limit);
        }
        other => panic!("{other:?}"),
    }
    // And the same cap on the way in, so the app cannot create a note it will
    // then refuse to open.
    let s = sw();
    let e = fsops::write_note(
        &abs,
        &args("Huge.md", 0, None, false),
        &vec![b'y'; limit as usize + 1],
        &s,
    )
    .unwrap_err();
    assert_eq!(e.kind(), "tooLarge");
    assert_eq!(fs::metadata(&abs).unwrap().len(), limit + 1, "the refused write still landed");
}

/// T2.6 / §7.3 case 14, end to end: the refusal is what protects the bytes, and
/// the bytes are still there afterwards.
#[test]
fn t2_6_a_non_utf8_note_is_refused_and_survives_untouched() {
    let dir = tempfile::tempdir().unwrap();
    let root = fsops::canonical_root(dir.path()).unwrap();
    let abs = root.join("Binary.md");
    let raw = b"caf\xE9\r\nna\xEFve\r\n".to_vec();
    fs::write(&abs, &raw).unwrap();

    assert_eq!(fsops::read_note(&abs, "Binary.md").unwrap_err().kind(), "notUtf8");
    assert_eq!(fs::read(&abs).unwrap(), raw, "a lossy decode rewrote the file");
    assert!(temp_files(&root).is_empty());
}

/* ===========================================================================
 * ===========================================================================
 * PART 2 — THE ARENA, THE WALK AND THE TREE TRANSPORT
 *
 * Spec: CONTRACT.md §3.2 (TreeBlob v1), §3.3 (the two caps, M38), §3.6 (what
 * the tree contains), §4.2 (the `Arc<VaultSnapshot>` seam, X14), §7.3 case 10
 * (case-insensitive APFS), case 12 (symlinks), spec-02 §4 (the arena),
 * gates G1, G2, G3.
 *
 * Part 1 above covers `fsops.rs` / `note_frame.rs` — the SCENARIOS of §7.3, the
 * data-loss half.  This part covers `tree.rs`, `scan.rs`, `path.rs` and
 * `vault.rs` — the memory half: the 24-byte `Node`, the per-node byte budget,
 * the cold walk, the blob's byte layout, the four sort orders, the two caps and
 * the lazily-built snapshot.  The two halves share a file because they share an
 * owner and a temp-vault discipline, and they are kept in separate blocks with
 * separate helpers so neither renames the other's fixtures.
 *
 * The two VALIDATORS (`validate_name`, `validate_rel_for_lookup`) are
 * deliberately NOT tested here: `tests/path_safety.rs` carries the whole
 * battery, written against their §7.3 case 11 signatures.
 * ===========================================================================
 * ========================================================================= */

use std::collections::BTreeSet;
use std::os::unix::fs::MetadataExt;
use std::process::Command;
use std::time::Instant;

use cairn_lib::path as vpath;
use cairn_lib::scan::{self, MAX_DEPTH, MAX_NODES};
use cairn_lib::tree::{
    self, Node, SortMode, Vault, VaultTree, FLAG_TRUNCATED_DEPTH, FLAG_TRUNCATED_NODES, ROOT,
};

/// `tools/gen-vault.sh` is deterministic and its manifest makes regeneration a
/// no-op, so the 5,000-note vault is built once and reused by every run — which
/// is what makes the G2 and G3 rows cheap enough to keep in `cargo test`.
const FIXTURE_NOTES: usize = 5_000;
const FIXTURE_FOLDERS: usize = 620;

fn fixture() -> PathBuf {
    // Unique per call: five tests share this helper and `cargo test` runs them
    // in parallel, so one shared dir means one test's `rm -rf` lands mid-write
    // in another's generation (and a partial dir without a manifest then fails
    // closed with exit 5).  `target/tmp/` is scratch; the pid keeps concurrent
    // `cargo test` invocations apart, the counter keeps threads apart.
    static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
        .join(format!("fixture-vault-{}-{n}", std::process::id()));
    let out = Command::new(repo.join("tools/gen-vault.sh"))
        .arg(&dir)
        .args(["--notes", &FIXTURE_NOTES.to_string()])
        .args(["--folders", &FIXTURE_FOLDERS.to_string()])
        .args(["--seed", "1"])
        .output()
        .expect("tools/gen-vault.sh must be runnable");
    assert!(out.status.success(), "gen-vault.sh: {}", String::from_utf8_lossy(&out.stderr));
    dir
}

fn tmpdir() -> tempfile::TempDir {
    tempfile::tempdir().expect("tempdir")
}

fn walk(root: &Path) -> VaultTree {
    scan::walk_vault(root, SortMode::NameAsc, 1).expect("walk_vault").tree
}

/* ── gate G1 ──────────────────────────────────────────────────────────────── */

/// The compile-time assert in `tree.rs` is the gate; this row makes it VISIBLE
/// in a test run and pins the two facts the 24 is made of, size and alignment.
/// It was 28 before `ctime` was removed (M53), and `Node.ctime` does not come
/// back — there are four sort orders and no created-time sort.
#[test]
fn g1_node_is_exactly_24_bytes() {
    assert_eq!(std::mem::size_of::<Node>(), 24, "gate G1");
    assert_eq!(std::mem::align_of::<Node>(), 4, "align 4 => the field order produces NO padding");
    // The sum of the fields IS the struct, which is the whole claim `#[repr(C)]`
    // with this field order is making.
    assert_eq!(4 * 5 + 2 + 1 + 1, 24);
}

/* ── gate G2 / spec-02 §4.3 ───────────────────────────────────────────────── */

/// spec-02 §4.3, measured by spike A §4.1 at **81.6 bytes/node over 5,621
/// nodes** (448 KiB), against a ≤ 768 KiB gate (G2).
///
/// TWO NUMBERS, DELIBERATELY, because they catch two different regressions and
/// one number hides one behind the other:
///   - `live_bytes` is the payload — `nodes` 24 + `kids` 4 + `names` ~20.  A new
///     field on `Node`, or a path stored per node, moves THIS, and it is the
///     figure the 81.6 B/node budget is asserted against.
///   - `arena_bytes` is what the allocator is actually holding: payload PLUS
///     spec-02 §4.6-2's pre-reserve slack (8,192 nodes / 8,192 kids / 256 KiB
///     names).  Gate G2's 768 KiB is asserted against THIS.
///
/// FOR THE RECORD: spike A's `arena bytes=458856` sits between these two figures
/// and its exact accounting formula is written down nowhere, so it is not
/// reproduced here.  Both bounds hold with room to spare — and the spike
/// measured a 28-byte `Node`, where this build has a 24-byte one.
#[test]
fn g2_per_node_byte_budget() {
    let tree = walk(&fixture());
    let n = tree.node_count() as u64;
    assert_eq!(n, (FIXTURE_NOTES + FIXTURE_FOLDERS) as u64, "5,000 notes + 620 folders");
    assert_eq!(tree.n_notes as usize, FIXTURE_NOTES);
    assert_eq!(tree.n_dirs as usize, FIXTURE_FOLDERS);

    let live = tree.live_bytes();
    let resident = tree.arena_bytes();
    let live_per_node = live as f64 / n as f64;
    let resident_per_node = resident as f64 / n as f64;
    eprintln!(
        "arena: live={live} B ({live_per_node:.1} B/node)  resident={resident} B \
         ({resident_per_node:.1} B/node)  nodes={n}  names={} B",
        tree.names.len()
    );

    assert!(
        live_per_node <= 81.6,
        "spike A §4.1's measured budget is 81.6 B/node; this build is {live_per_node:.1}"
    );
    assert!(
        resident <= 768 * 1024,
        "gate G2: the arena for a 5,000-note vault must be <= 768 KiB; this build is {resident} B"
    );
    // spec-02 §4.3's own claim, which 81.6 "confirmed with room to spare" —
    // asserted against the resident figure so pre-reserve slack cannot grow
    // unnoticed either.
    assert!(resident_per_node <= 97.0, "spec-02 §4.3 claims 97 B/node including slack");
}

/* ── gate G3 ──────────────────────────────────────────────────────────────── */

/// Gate G3: **≤ 50 ms** over the 5,000-note fixture (measured 40 ms, 1.25x
/// margin), on §6.5's protocol — the median of 5 runs with run 1 discarded.
///
/// THE GATE IS ASSERTED ONLY IN A RELEASE BUILD, and that is not a dodge: the
/// 40 ms measurement was taken from the shipped profile (`opt-level = "s"`,
/// `lto = "fat"`), and this crate's dev profile is `opt-level = 0`.  Asserting
/// 50 ms against an unoptimised walk would make the gate a coin flip on the one
/// axis §6.5 spent a whole table removing coin flips from.  A debug run still
/// asserts a loose ceiling, so an algorithmic regression — an O(n^2) child
/// lookup, a second `stat` per entry — is caught in either profile.
#[test]
fn g3_cold_walk_of_the_fixture() {
    let root = fixture();
    let _warm = walk(&root); // run 1, discarded (§6.5's protocol)

    let mut runs: Vec<Duration> = (0..5)
        .map(|_| {
            let t = Instant::now();
            let tree = walk(&root);
            let d = t.elapsed();
            assert_eq!(tree.node_count(), FIXTURE_NOTES + FIXTURE_FOLDERS);
            d
        })
        .collect();
    runs.sort();
    eprintln!(
        "G3 walk median={:.1} ms  runs={:?}  profile={}",
        runs[2].as_secs_f64() * 1e3,
        runs.iter().map(|d| format!("{:.1}", d.as_secs_f64() * 1e3)).collect::<Vec<_>>(),
        if cfg!(debug_assertions) { "debug" } else { "release" }
    );
    let median = runs[2];

    if cfg!(debug_assertions) {
        assert!(
            median <= Duration::from_millis(500),
            "the walk is {median:?} in a DEBUG build; gate G3's 50 ms is asserted only in \
             release, but 500 ms means something algorithmic broke"
        );
    } else {
        assert!(median <= Duration::from_millis(50), "gate G3: <= 50 ms, got {median:?}");
    }
}

/* ── §3.6, what the tree contains ─────────────────────────────────────────── */

#[test]
fn the_tree_contains_directories_and_md_only() {
    let d = tmpdir();
    let root = d.path();
    fs::create_dir_all(root.join("Folder/Nested")).unwrap();
    fs::create_dir(root.join("Empty")).unwrap();
    fs::create_dir(root.join(".obsidian")).unwrap();
    fs::write(root.join(".obsidian/app.json"), b"{}").unwrap();
    fs::write(root.join(".DS_Store"), b"x").unwrap();
    fs::write(root.join("note.md"), b"# n").unwrap();
    fs::write(root.join("UPPER.MD"), b"# u").unwrap(); // ASCII case-insensitive
    fs::write(root.join("image.png"), b"x").unwrap();
    fs::write(root.join("README"), b"x").unwrap();
    fs::write(root.join("Folder/Nested/deep.md"), b"# d").unwrap();
    fs::write(root.join(format!(".half.md.tmp-{}-0", std::process::id())), b"x").unwrap();
    std::os::unix::fs::symlink("..", root.join("loop")).unwrap();
    std::os::unix::fs::symlink(root.join("note.md"), root.join("alias.md")).unwrap();

    let tree = walk(root);
    let mut got = BTreeSet::new();
    collect_rel(&tree, ROOT, &mut got);

    assert_eq!(
        got,
        ["Empty", "Folder", "Folder/Nested", "Folder/Nested/deep.md", "UPPER.MD", "note.md"]
            .iter()
            .map(|s| (*s).to_string())
            .collect::<BTreeSet<_>>(),
        "directories and .md only; dotfiles, non-.md files and symlinks are excluded, and \
         EMPTY FOLDERS ARE SHOWN (§3.6)"
    );
    // §7.3 case 12: the symlink loop did not make the walk diverge, and no node
    // in the arena can name anything outside the root.
    for rel in &got {
        assert!(!rel.contains(".."), "no arena path contains `..`");
    }
}

/// §7.3 case 1 / M67, at the SCAN seam rather than at the write seam (Part 1's
/// `case_1_m67_...` covers that half): the walk collects candidates while it is
/// already reading every directory entry, and hands them to the sweep.  A
/// dotfile that is not one of OUR temp names is never a candidate at all.
#[test]
fn the_walk_collects_sweep_candidates_for_free() {
    let d = tmpdir();
    let root = d.path();
    let dead = reaped_pid();
    let mine = std::process::id();
    let debris = format!(".Ideas.md.tmp-{dead}-0");
    let live = format!(".Ideas.md.tmp-{mine}-7");
    fs::write(root.join(&debris), b"half").unwrap();
    fs::write(root.join(&live), b"half").unwrap();
    fs::write(root.join(".not-a-temp"), b"x").unwrap();
    fs::write(root.join("Ideas.md"), b"# Ideas").unwrap();

    let result = scan::walk_vault(root, SortMode::NameAsc, 1).unwrap();
    let candidates: BTreeSet<String> = result
        .sweep
        .iter()
        .filter_map(|p| p.file_name().and_then(|n| n.to_str()).map(str::to_string))
        .collect();
    assert_eq!(
        candidates,
        [debris.clone(), live.clone()].into_iter().collect::<BTreeSet<_>>(),
        "`.not-a-temp` is a dotfile but not OUR temp, so it is never a sweep candidate"
    );
    assert_eq!(result.tree.n_notes, 1, "and none of them entered the tree (§3.6)");

    assert_eq!(scan::sweep_temps(&result.sweep), 1, "the dead PID's file, and only that one");
    assert!(!root.join(&debris).exists(), "crash debris is unlinked ON SIGHT (M67)");
    assert!(root.join(&live).exists(), "a LIVE pid's temp may be another instance mid-write");
    assert!(root.join(".not-a-temp").exists());
}

/// The whole of `open_vault`'s blocking half, wired together: walk, then sweep.
#[test]
fn open_at_walks_then_sweeps() {
    let d = tmpdir();
    let root = d.path();
    fs::write(root.join("Ideas.md"), b"# Ideas\n").unwrap();
    let dead = reaped_pid();
    fs::write(root.join(format!(".Ideas.md.tmp-{dead}-0")), b"half").unwrap();

    let (vault, swept) = cairn_lib::vault::open_at(root, SortMode::NameAsc, 1).unwrap();
    assert_eq!(swept, 1, "§7.3 case 1: the next vault open leaves ZERO .tmp- files");
    assert!(temp_files(root).is_empty());
    // §7.6.1 (errata 3, Z2): `info()` now takes the persisted view state too.
    // This test has no `PrefsStore`, so it passes the same defaults `app.rs`
    // falls back to when none is initialised.
    let info = cairn_lib::vault::info(&vault, None, true, Vec::new(), 0.0);
    assert_eq!((info.n_notes, info.n_dirs, info.sort, info.epoch), (1, 0, 0, 1));
    assert!(!info.truncated && !info.truncated_depth);

    // A root that is not a directory, and one that is not there at all.
    let kind = |p: &Path| match cairn_lib::vault::open_at(p, SortMode::NameAsc, 1) {
        Err(e) => e.kind(),
        Ok(_) => panic!("{} must not open as a vault", p.display()),
    };
    assert_eq!(kind(&root.join("Ideas.md")), "notADirectory");
    assert_eq!(kind(&root.join("nope")), "notFound");
}

/* ── §3.3, the two caps ───────────────────────────────────────────────────── */

/// §3.3, depth: 255.  The subtree is not descended into, the row for the folder
/// itself still exists, and it gets ITS OWN header bit — overloading
/// `nc://watch-degraded` for depth truncation is STRUCK, because a degraded
/// watcher and a too-deep folder are different facts with different remedies
/// and different banners.
#[test]
fn depth_cap_truncates_and_sets_only_its_own_bit() {
    let d = tmpdir();
    let root = d.path();
    // One-character components: macOS caps a whole path at 1024 bytes, so 260
    // levels of `d123/` would fail with ENAMETOOLONG long before the DEPTH cap
    // was reached, and the test would be measuring PATH_MAX instead of §3.3.
    let mut p = root.to_path_buf();
    for _ in 0..(usize::from(MAX_DEPTH) + 5) {
        p.push("d");
    }
    fs::create_dir_all(&p).unwrap();
    fs::write(p.join("too-deep.md"), b"# x").unwrap();
    fs::write(root.join("shallow.md"), b"# x").unwrap();

    let tree = walk(root);
    assert!(tree.truncated_depth, "the depth cap was hit");
    assert!(!tree.truncated_nodes, "and the NODE cap was not — separate facts, separate bits");
    assert!(tree.resolve("shallow.md").is_some(), "the rest of the tree still paints");
    assert_eq!(tree.rel_path(tree.resolve("d").unwrap()), "d");

    // The deepest node the arena holds is at exactly MAX_DEPTH, and nothing
    // below it was read — `Node.depth` is a u8 and a child would be 256.
    let deepest = tree.nodes.iter().map(|n| n.depth).max().unwrap();
    assert_eq!(deepest, MAX_DEPTH);

    let blob = tree.encode_blob();
    assert_eq!(blob_u32(&blob, 20) & FLAG_TRUNCATED_DEPTH, FLAG_TRUNCATED_DEPTH);
    assert_eq!(blob_u32(&blob, 20) & FLAG_TRUNCATED_NODES, 0);
}

/// An EMPTY folder sitting at the depth cap must NOT light the banner: nothing
/// was hidden, so saying "some folders are nested too deeply to display" would
/// be false.  This is why the flag is raised after the directory is read.
#[test]
fn an_empty_folder_at_the_depth_cap_raises_no_banner() {
    let d = tmpdir();
    let root = d.path();
    let mut p = root.to_path_buf();
    for _ in 0..usize::from(MAX_DEPTH) {
        p.push("d");
    }
    fs::create_dir_all(&p).unwrap();

    let tree = walk(root);
    assert!(!tree.truncated_depth, "nothing was truncated, so nothing is claimed to be");
    assert_eq!(tree.node_count(), usize::from(MAX_DEPTH));
}

/// §3.3, nodes: 50,000.  Building the vault costs ~50,000 `create` syscalls, so
/// it is opt-in.  A skip that reads like a pass is how a cap ships untested, so
/// the skip says so on stderr and names the command that runs it.
#[test]
fn node_cap_stops_the_walk_descending() {
    if std::env::var_os("CAIRN_CAP_TEST").is_none() {
        eprintln!(
            "vault_ops: SKIPPED [node cap] — needs ~51,000 files. Re-run with \
             `CAIRN_CAP_TEST=1 cargo test --test vault_ops node_cap`"
        );
        return;
    }
    let d = tmpdir();
    let root = d.path();
    // 51 folders x 1,000 notes = 51,051 nodes, comfortably over the cap.
    for f in 0..51 {
        let dir = root.join(format!("f{f:03}"));
        fs::create_dir(&dir).unwrap();
        for i in 0..1_000 {
            fs::write(dir.join(format!("n{i:04}.md")), b"# x").unwrap();
        }
    }
    let tree = walk(root);
    assert!(tree.truncated_nodes, "the node cap was hit");
    assert!(!tree.truncated_depth, "and the DEPTH cap was not");
    assert!(tree.node_count() <= MAX_NODES, "never more than the cap, got {}", tree.node_count());

    let blob = tree.encode_blob();
    assert_eq!(blob_u32(&blob, 20) & FLAG_TRUNCATED_NODES, FLAG_TRUNCATED_NODES);
    assert_eq!(blob_u32(&blob, 8) as usize, tree.node_count());
}

/* ── §3.2, TreeBlob v1 ────────────────────────────────────────────────────── */

fn blob_u32(b: &[u8], off: usize) -> u32 {
    u32::from_le_bytes(b[off..off + 4].try_into().unwrap())
}

/// The decoder below is deliberately NOT `tree.rs`'s own code read backwards: it
/// is written straight from CONTRACT §3.2's byte table, the way `tree.ts` will
/// write it, so a mistake in the encoder cannot cancel out against a matching
/// mistake in the decoder.
struct Blob<'a> {
    bytes: &'a [u8],
    n: usize,
    m: usize,
}

impl<'a> Blob<'a> {
    fn parse(bytes: &'a [u8]) -> Self {
        assert!(bytes.len() >= 36, "a blob is at least a header");
        assert_eq!(blob_u32(bytes, 0), tree::MAGIC, "magic 0x3142544E");
        assert_eq!(&bytes[0..4], b"NTB1", "…which is \"NTB1\" little-endian");
        assert_eq!(blob_u32(bytes, 4), tree::VERSION, "version 1");
        let n = blob_u32(bytes, 8) as usize;
        let m = blob_u32(bytes, 12) as usize;
        assert_eq!(bytes.len(), 36 + 14 * n + m, "total = 36 + 14N + M");
        Blob { bytes, n, m }
    }
    fn sort_order(&self) -> u32 {
        blob_u32(self.bytes, 16)
    }
    fn flags(&self) -> u32 {
        blob_u32(self.bytes, 20)
    }
    fn epoch(&self) -> u64 {
        u64::from_le_bytes(self.bytes[24..32].try_into().unwrap())
    }
    fn subtree(&self, i: usize) -> u32 {
        blob_u32(self.bytes, 32 + 4 * i)
    }
    fn parent(&self, i: usize) -> i32 {
        blob_u32(self.bytes, 32 + 4 * self.n + 4 * i) as i32
    }
    fn name_off(&self, i: usize) -> usize {
        blob_u32(self.bytes, 32 + 8 * self.n + 4 * i) as usize
    }
    fn depth(&self, i: usize) -> u8 {
        self.bytes[36 + 12 * self.n + i]
    }
    fn kind(&self, i: usize) -> u8 {
        self.bytes[36 + 13 * self.n + i]
    }
    fn is_dir(&self, i: usize) -> bool {
        self.kind(i) & 1 != 0
    }
    fn name(&self, i: usize) -> &'a str {
        let base = 36 + 14 * self.n;
        let (s, e) = (self.name_off(i), self.name_off(i + 1));
        std::str::from_utf8(&self.bytes[base + s..base + e]).expect("names are UTF-8")
    }
    /// What the frontend actually does: the vault-relative path of a row, built
    /// from `parent` and the DISPLAY names plus the `.md` the blob stripped, in
    /// the case `kind` bits 1..2 record.
    fn rel(&self, i: usize) -> String {
        let mut parts = Vec::new();
        let mut cur = i as i32;
        while cur >= 0 {
            let k = cur as usize;
            parts.push(if self.is_dir(k) {
                self.name(k).to_string()
            } else {
                let m = if self.kind(k) & tree::KIND_EXT_UPPER_M != 0 { 'M' } else { 'm' };
                let d = if self.kind(k) & tree::KIND_EXT_UPPER_D != 0 { 'D' } else { 'd' };
                format!("{}.{m}{d}", self.name(k))
            });
            cur = self.parent(k);
        }
        parts.reverse();
        parts.join("/")
    }
}

#[test]
fn treeblob_v1_round_trips_the_fixture() {
    let tree = walk(&fixture());
    let bytes = tree.encode_blob();
    let b = Blob::parse(&bytes);

    assert_eq!(b.n, FIXTURE_NOTES + FIXTURE_FOLDERS, "the root is EXCLUDED from the blob");
    assert_eq!(b.sort_order(), u32::from(SortMode::NameAsc.as_u8()));
    assert_eq!(b.flags(), 0, "the fixture trips neither cap");
    assert_eq!(b.epoch(), tree.epoch);
    eprintln!("blob: {} B  N={}  M={}", bytes.len(), b.n, b.m);

    let mut dirs = 0usize;
    let mut names_seen = 0usize;
    for i in 0..b.n {
        // Invariant P: a node at index i owns [i+1, i+subtree[i]], and its
        // parent always has a LOWER index.
        let sub = b.subtree(i) as usize;
        assert!(i + sub < b.n, "subtree stays inside the array");
        assert!(b.parent(i) < i as i32, "invariant P: the parent has a lower index");
        for k in (i + 1)..=(i + sub) {
            let mut cur = b.parent(k);
            while cur > i as i32 {
                cur = b.parent(cur as usize);
            }
            assert_eq!(cur, i as i32, "index {k} is in i={i}'s claimed range but not below it");
        }
        if b.parent(i) >= 0 {
            assert!(b.is_dir(b.parent(i) as usize), "a folder's parent is always a folder");
            assert_eq!(b.depth(i), b.depth(b.parent(i) as usize) + 1);
        } else {
            assert_eq!(b.depth(i), 0, "0 == top level");
        }
        assert_eq!(b.kind(i) & !7u8, 0, "bits 3..7 of `kind` are reserved and MUST be 0");
        if b.is_dir(i) {
            assert_eq!(b.kind(i), tree::KIND_DIR, "a folder has no extension bits");
        }
        if b.is_dir(i) {
            dirs += 1;
        } else {
            assert_eq!(sub, 0, "a file has no descendants");
            assert!(!b.name(i).ends_with(".md"), "§3.2: the blob carries DISPLAY names");
        }
        names_seen += b.name(i).len();
    }
    assert_eq!(dirs, FIXTURE_FOLDERS);
    assert_eq!(names_seen, b.m, "name_off[N] == M and the sections tile exactly");

    // The identity that matters: every row's reconstructed path is the arena's
    // path for the same node, in the same order.
    let mut arena: Vec<String> = Vec::with_capacity(b.n);
    preorder_rel(&tree, ROOT, &mut arena);
    let decoded: Vec<String> = (0..b.n).map(|i| b.rel(i)).collect();
    assert_eq!(decoded, arena, "the blob's preorder DFS IS the arena's");

    // …and every one of them resolves back to the node it came from.
    for rel in &arena {
        let id = tree.resolve(rel).unwrap_or_else(|| panic!("{rel} must resolve"));
        assert_eq!(&tree.rel_path(id), rel);
    }
}

/// A folder with no children draws no chevron, and that is `subtree[i] == 0`,
/// not `kind` (M61).  spec-04 §4.3's chevron-for-every-`.tr.d` rule is STRUCK,
/// so the blob has to make the difference visible.
#[test]
fn an_empty_folder_is_a_dir_with_no_subtree() {
    let d = tmpdir();
    fs::create_dir(d.path().join("Empty")).unwrap();
    fs::create_dir(d.path().join("Full")).unwrap();
    fs::write(d.path().join("Full/n.md"), b"# n").unwrap();

    let bytes = walk(d.path()).encode_blob();
    let b = Blob::parse(&bytes);
    assert_eq!(b.n, 3);
    assert_eq!((b.name(0), b.is_dir(0), b.subtree(0)), ("Empty", true, 0));
    assert_eq!((b.name(1), b.is_dir(1), b.subtree(1)), ("Full", true, 1));
    assert_eq!((b.name(2), b.is_dir(2), b.subtree(2)), ("n", false, 0));
}

/// §3.2: "`names` holds display names: a file's trailing `.md` is stripped by
/// Rust.  The real filename is `display + \".md\"` for files and `display` for
/// folders."  A FOLDER called `Archive.md` is the case that breaks a decoder
/// which strips by extension instead of by `kind`.
#[test]
fn display_names_strip_md_for_files_and_never_for_folders() {
    let d = tmpdir();
    fs::create_dir(d.path().join("Archive.md")).unwrap();
    fs::write(d.path().join("Archive.md/inner.MD"), b"# i").unwrap();
    fs::write(d.path().join("plain.md"), b"# p").unwrap();

    let tree = walk(d.path());
    let bytes = tree.encode_blob();
    let b = Blob::parse(&bytes);
    assert_eq!(b.name(0), "Archive.md", "a FOLDER keeps its name verbatim");
    assert!(b.is_dir(0));
    assert_eq!(b.name(1), "inner", "and `.MD` is stripped ASCII-case-insensitively");
    assert_eq!(b.name(2), "plain");
    // The arena keeps the ON-DISK name; only the blob strips, for display (§5.1).
    assert!(tree.resolve("Archive.md/inner.MD").is_some());
    assert_eq!(vpath::display_name("inner.MD", false), "inner");
    assert_eq!(vpath::display_name("Archive.md", true), "Archive.md");
}

/// A note whose extension is not a lowercase `.md` (`Foo.MD`, `x.Md`) is a note,
/// as it is in Obsidian, and every blob row must rebuild to ITS OWN on-disk name.
/// The display name alone rebuilt `Foo.MD` as `Foo.md`: no such node, or — with
/// both spellings side by side on a case-sensitive filesystem — the sibling, so
/// a delete from one row trashed the other file.
#[test]
fn every_blob_row_rebuilds_to_its_own_node_whatever_the_extension_case() {
    let d = tmpdir();
    let root = d.path();
    fs::create_dir(root.join("Sub")).unwrap();
    fs::write(root.join("Foo.MD"), b"foo").unwrap();
    fs::write(root.join("x.Md"), b"x").unwrap();
    fs::write(root.join("Sub/inner.mD"), b"inner").unwrap();
    fs::write(root.join("plain.md"), b"plain").unwrap();
    fs::write(root.join("Dup.md"), b"lower").unwrap();
    // On a case-folding filesystem this overwrites `Dup.md`; the round trip
    // must hold either way.
    fs::write(root.join("Dup.MD"), b"upper").unwrap();

    let tree = walk(root);
    let bytes = tree.encode_blob();
    let b = Blob::parse(&bytes);
    let mut arena: Vec<String> = Vec::with_capacity(b.n);
    preorder_rel(&tree, ROOT, &mut arena);
    let rebuilt: Vec<String> = (0..b.n).map(|i| b.rel(i)).collect();
    assert_eq!(rebuilt, arena, "each row rebuilds to the arena's own on-disk path");

    let mut seen = BTreeSet::new();
    for (i, rel) in rebuilt.iter().enumerate() {
        assert!(seen.insert(rel.clone()), "two rows rebuild to {rel}");
        let id = tree.resolve(rel).unwrap_or_else(|| panic!("{rel} must resolve"));
        assert_eq!(tree.rel_path(id), *rel);
        if !b.is_dir(i) {
            assert!(fs::metadata(root.join(rel)).is_ok(), "{rel} is a file on disk");
        }
    }
    for want in ["Foo.MD", "x.Md", "Sub/inner.mD", "plain.md"] {
        assert!(seen.contains(want), "{want} is addressable from its row: {seen:?}");
    }
    // Display names are unchanged: the extension is stripped whatever its case.
    let names: BTreeSet<&str> = (0..b.n).map(|i| b.name(i)).collect();
    assert!(names.contains("Foo") && names.contains("x") && names.contains("inner"));

    assert_eq!(vpath::md_ext_case("a.md"), 0);
    assert_eq!(vpath::md_ext_case("a.Md"), 1);
    assert_eq!(vpath::md_ext_case("a.mD"), 2);
    assert_eq!(vpath::md_ext_case("a.MD"), 3);
    assert_eq!(vpath::md_ext_case("a.txt"), 0);
    assert_eq!(vpath::md_ext_case(".MD"), 0, "not a note: is_md needs a stem");
}

/* ── §4.4, paths are reconstructed, never stored ──────────────────────────── */

#[test]
fn path_reconstruction_matches_the_filesystem() {
    let root = fixture();
    let tree = walk(&root);

    let mut rels: Vec<String> = Vec::new();
    preorder_rel(&tree, ROOT, &mut rels);
    assert_eq!(rels.len(), FIXTURE_NOTES + FIXTURE_FOLDERS);

    // ROOT is "" (§1.1), and its absolute path is the vault root itself.
    assert_eq!(tree.rel_path(ROOT), "");
    assert_eq!(tree.abs_path(ROOT), root);
    assert_eq!(tree.resolve(""), Some(ROOT));

    // Every reconstructed absolute path names a real file of the right kind, and
    // the reusable-buffer variants agree with the allocating ones.
    let mut abs = PathBuf::new();
    let mut rel = String::new();
    for r in &rels {
        let id = tree.resolve(r).unwrap();
        tree.abs_path_into(id, &mut abs);
        tree.rel_path_into(id, &mut rel);
        assert_eq!(rel, *r);
        assert_eq!(abs, tree.abs_path(id));
        assert_eq!(abs, root.join(r));
        let meta = fs::symlink_metadata(&abs).unwrap_or_else(|e| panic!("{}: {e}", abs.display()));
        assert_eq!(meta.is_dir(), tree.get(id).unwrap().is_dir());
        assert!(!meta.file_type().is_symlink());
    }

    // A path that does not exist resolves to nothing, and so does a path THROUGH
    // a file — resolution walking the arena is what makes traversal structurally
    // impossible (§7.3 case 13), not the character rules.
    assert_eq!(tree.resolve("nope.md"), None);
    let a_file = rels.iter().find(|r| r.ends_with(".md")).unwrap();
    assert_eq!(tree.resolve(&format!("{a_file}/child.md")), None);
}

/// spec-02 §4.4 stores no path per node because reconstruction is 150 ns and
/// storage is ~200 B/node — more than double the entire model, to save 150 ns.
/// This row pins the half of that trade the code controls.
#[test]
fn path_reconstruction_is_cheap_enough_for_the_snapshot_build() {
    let tree = walk(&fixture());
    let mut buf = String::new();
    let mut ids = Vec::new();
    preorder_ids(&tree, ROOT, &mut ids);

    let t = Instant::now();
    let mut bytes = 0usize;
    for &id in &ids {
        tree.rel_path_into(id, &mut buf);
        bytes += buf.len();
    }
    let per = t.elapsed().as_secs_f64() / ids.len() as f64;
    eprintln!("rel_path_into: {:.0} ns/path over {} nodes ({bytes} B)", per * 1e9, ids.len());
    let ceiling = if cfg!(debug_assertions) { 20e-6 } else { 2e-6 };
    assert!(per < ceiling, "{:.0} ns/path is not a parent-chain walk any more", per * 1e9);
}

/* ── §4.5, the four sort orders ───────────────────────────────────────────── */

#[test]
fn nat_cmp_is_natural_case_insensitive_and_total() {
    use std::cmp::Ordering;
    assert_eq!(tree::nat_cmp("Note 2.md", "Note 10.md"), Ordering::Less, "2 before 10");
    assert_eq!(tree::nat_cmp("a9", "a10"), Ordering::Less);
    assert_eq!(tree::nat_cmp("a010", "a9"), Ordering::Greater, "leading zeros are stripped");
    assert_eq!(tree::nat_cmp("readme", "README"), Ordering::Greater, "folded equal => a.cmp(b)");
    assert_ne!(tree::nat_cmp("README", "readme"), Ordering::Equal, "the order is TOTAL");
    assert_eq!(tree::nat_cmp("x", "x"), Ordering::Equal);
    // Unsigned numeric order without parsing, so a 400-digit run cannot overflow.
    let big_a = format!("n{}1", "9".repeat(400));
    let big_b = format!("n{}2", "9".repeat(400));
    assert_eq!(tree::nat_cmp(&big_a, &big_b), Ordering::Less);
    assert_eq!(tree::nat_cmp("Zebra.md", "apple.md"), Ordering::Greater, "case-insensitive");
    assert_eq!(tree::nat_cmp("\u{65e5}\u{672c}", "\u{65e5}\u{672c}\u{8a9e}"), Ordering::Less);
}

/// Sorting compares DISPLAY names, not on-disk ones — user report, 2026-09-15:
/// `"Note 0212 a very long filename….md"` sorted BEFORE `"Note 0212.md"`.
/// `' '` (0x20) sorts before `'.'` (0x2E), so comparing on-disk names puts the
/// longer file first at the byte where they diverge — inside the SHORTER
/// file's own `.md`. Read from Obsidian's bundle (§0.17): its alphabetical
/// mode compares `.basename`, which has no extension to trip over.
#[test]
fn a_longer_name_that_starts_with_a_shorter_ones_stem_sorts_after_it() {
    let d = tmpdir();
    let root = d.path();
    for name in ["Note 0212.md", "Note 0212 a very long filename.md", "Note 0213.md"] {
        fs::write(root.join(name), b"# x").unwrap();
    }
    let t = walk(root);
    let names: Vec<String> = t.children(ROOT).iter().map(|&c| t.name(c).to_string()).collect();
    assert_eq!(
        names,
        ["Note 0212.md", "Note 0212 a very long filename.md", "Note 0213.md"],
        "the on-disk '.md' must not decide an order the basenames already settled"
    );
    // The same folder-vs-file boundary, so a folder's own name (which HAS no
    // extension to strip) is unaffected: `vpath::display_name` is a no-op there.
    let mut t2 = t;
    t2.set_sort(SortMode::NameDesc, 2);
    let names2: Vec<String> = t2.children(ROOT).iter().map(|&c| t2.name(c).to_string()).collect();
    assert_eq!(
        names2,
        ["Note 0213.md", "Note 0212 a very long filename.md", "Note 0212.md"],
        "NameDesc must reverse the SAME (correct) order, not a differently-broken one"
    );
}

#[test]
fn the_four_sort_orders_and_their_stability() {
    let d = tmpdir();
    let root = d.path();
    // Every mtime is set explicitly.  A test that lets the filesystem supply
    // them is asserting how fast it ran: macOS stamps directories to the current
    // second, so two folders created back to back usually tie and occasionally
    // do not.
    for (name, secs) in [("zeta", 4_000), ("Alpha", 5_000)] {
        let p = root.join(name);
        fs::create_dir(&p).unwrap();
        set_mtime(&p, secs);
    }
    for (name, secs) in [("Note 10.md", 3_000), ("Note 2.md", 1_000), ("apple.md", 2_000)] {
        let p = root.join(name);
        fs::write(&p, b"# x").unwrap();
        set_mtime(&p, secs);
    }

    let names = |t: &VaultTree| -> Vec<String> {
        t.children(ROOT).iter().map(|&c| t.name(c).to_string()).collect()
    };

    let mut t = walk(root);
    // Rule 1: directories always sort before files, in EVERY mode.
    // Rule 3: NameAsc/NameDesc use NATURAL, case-insensitive order — so
    // `apple.md` precedes `Note 2.md` (a < n) and `Note 2.md` precedes
    // `Note 10.md` (2 < 10, which a lexicographic sort gets backwards).
    assert_eq!(names(&t), ["Alpha", "zeta", "apple.md", "Note 2.md", "Note 10.md"]);

    t.set_sort(SortMode::NameDesc, 2);
    assert_eq!(names(&t), ["zeta", "Alpha", "Note 10.md", "Note 2.md", "apple.md"]);
    assert_eq!(t.epoch, 2, "a sort change bumps the epoch");

    // Rule 2: within a group, the mode's key — and the folders are ordered by
    // their OWN mtimes, because rule 1 groups them but does not sort them.
    t.set_sort(SortMode::MtimeDesc, 3);
    assert_eq!(names(&t), ["Alpha", "zeta", "Note 10.md", "apple.md", "Note 2.md"]);

    t.set_sort(SortMode::MtimeAsc, 4);
    assert_eq!(names(&t), ["zeta", "Alpha", "Note 2.md", "apple.md", "Note 10.md"]);

    // Round-tripping back to NameAsc reproduces the WALK's own order exactly.
    // The walk sorts as it reads and `set_sort` re-sorts in place, and the two
    // must agree or the tree reorders itself for no reason on the first sort
    // change and back again on the second.
    t.set_sort(SortMode::NameAsc, 5);
    assert_eq!(names(&t), names(&walk(root)));

    // A no-op sort does not bump the epoch — an epoch bump is a full rebuild on
    // the frontend (§3.5).
    let before = t.epoch;
    t.set_sort(SortMode::NameAsc, 99);
    assert_eq!(t.epoch, before);

    // The blob echoes the active mode, and its preorder follows it.
    for mode in [SortMode::NameAsc, SortMode::NameDesc, SortMode::MtimeDesc, SortMode::MtimeAsc] {
        t.set_sort(mode, t.epoch + 1);
        let bytes = t.encode_blob();
        let b = Blob::parse(&bytes);
        assert_eq!(b.sort_order(), u32::from(mode.as_u8()));
        let from_blob: Vec<String> =
            (0..b.n).filter(|&i| b.depth(i) == 0).map(|i| b.rel(i)).collect();
        let from_arena: Vec<String> = t.children(ROOT).iter().map(|&c| t.rel_path(c)).collect();
        assert_eq!(from_blob, from_arena, "mode {mode:?}");
    }
}

/// Time modes tie-break by `nat_cmp` so the order is TOTAL and stable across
/// rescans.  Without it, a vault whose notes share an mtime — a `git checkout`,
/// an rsync, an unzip — reorders itself on every refresh.
#[test]
fn time_modes_are_stable_across_rescans() {
    let d = tmpdir();
    let root = d.path();
    for i in 0..40 {
        let p = root.join(format!("n{i:02}.md"));
        fs::write(&p, b"# x").unwrap();
        set_mtime(&p, 1_700_000_000); // every one identical
    }
    let order = |mode: SortMode| -> Vec<String> {
        let mut t = walk(root);
        t.set_sort(mode, 2);
        t.children(ROOT).iter().map(|&c| t.name(c).to_string()).collect()
    };
    for mode in [SortMode::MtimeDesc, SortMode::MtimeAsc] {
        let a = order(mode);
        let b = order(mode);
        assert_eq!(a, b, "{mode:?} must be total, not implementation-defined");
        let mut sorted = a.clone();
        sorted.sort();
        assert_eq!(a, sorted, "the tie-break is nat_cmp ASCENDING in both time modes");
    }
}

#[test]
fn sort_mode_wire_values_are_0_to_3() {
    assert_eq!(SortMode::from_u8(0), Some(SortMode::NameAsc));
    assert_eq!(SortMode::from_u8(1), Some(SortMode::NameDesc));
    assert_eq!(SortMode::from_u8(2), Some(SortMode::MtimeDesc));
    assert_eq!(SortMode::from_u8(3), Some(SortMode::MtimeAsc));
    // FOUR orders (M28/M53): there is no created-time sort, and 4 is not a mode
    // that silently falls back to NameAsc.
    assert_eq!(SortMode::from_u8(4), None);
    assert_eq!(SortMode::from_u8(255), None);
    assert_eq!(SortMode::default(), SortMode::NameAsc);
}

/* ── §7.3 case 10, at the arena ───────────────────────────────────────────── */

/// Part 1's `case_10_...` covers the RENAME.  This is the other half: on a
/// case-insensitive volume `notes.md` and `NOTES.md` are ONE file, so the walk
/// must produce ONE node, and the arena's lookup — which is byte-exact, matching
/// the on-disk spelling — resolves the spelling that is there and refuses the
/// one that is not.
///
/// That asymmetry is exactly why the rename path cannot ask `resolve()` whether
/// a collision exists and needs `same_file(src, dst)` on `dev`+`ino`.
#[test]
#[cfg_attr(
    target_os = "linux",
    ignore = "unmeasured on Linux: states its world by panicking on case-sensitive volumes; §7.3 case 10 is written for case-insensitive APFS"
)]
fn apfs_case_collision_produces_one_node_and_a_byte_exact_lookup() {
    let d = tmpdir();
    let root = d.path();
    fs::write(root.join("notes.md"), b"the user's note\n").unwrap();

    let Ok(upper) = fs::metadata(root.join("NOTES.md")) else {
        panic!(
            "the volume under {} is CASE-SENSITIVE; §7.3 case 10 is written for APFS",
            root.display()
        )
    };
    let lower = fs::metadata(root.join("notes.md")).unwrap();
    assert_eq!(
        (lower.dev(), lower.ino()),
        (upper.dev(), upper.ino()),
        "case-insensitive volume: one file under two names"
    );

    let tree = walk(root);
    assert_eq!(tree.n_notes, 1, "ONE directory entry => ONE node, never two");
    assert_eq!(tree.node_count(), 1);
    assert!(tree.resolve("notes.md").is_some(), "the on-disk spelling resolves");
    assert!(
        tree.resolve("NOTES.md").is_none(),
        "and the other spelling does NOT: arena lookup is byte-exact, which is why the rename \
         path needs same_file(dev,ino) and cannot ask resolve() whether a collision exists"
    );

    // Writing through the other spelling OVERWRITES on APFS, so the walk still
    // sees one entry under its original spelling — the fact §7.3 case 10's
    // "refused rather than silently merged" rule exists to protect.
    fs::write(root.join("NOTES.md"), b"clobbered\n").unwrap();
    let tree = walk(root);
    assert_eq!(tree.node_count(), 1);
    assert_eq!(tree.name(tree.resolve("notes.md").unwrap()), "notes.md", "the spelling is kept");
    assert_eq!(fs::read(root.join("notes.md")).unwrap(), b"clobbered\n");
}

/* ── §4.2, the Arc<VaultSnapshot> seam ────────────────────────────────────── */

#[test]
fn the_snapshot_is_lazy_cached_and_epoch_invalidated() {
    let d = tmpdir();
    let root = d.path();
    fs::create_dir(root.join("A")).unwrap();
    fs::write(root.join("A/deep.md"), b"# d").unwrap();
    fs::write(root.join("top.md"), b"# t").unwrap();

    let vault = Vault::new(walk(root));
    let first = vault.snapshot();
    let again = vault.snapshot();
    assert!(std::sync::Arc::ptr_eq(&first, &again), "cached: same epoch => the SAME Arc");

    // FILES ONLY, in the blob's preorder — and the directory `A` is not in it,
    // which is the whole of X14: index i here and node i there are different
    // objects, and nothing may convert between them by arithmetic.
    let rels: Vec<&str> = first.files.iter().map(|f| &*f.rel).collect();
    assert_eq!(rels, ["A/deep.md", "top.md"]);
    assert_eq!(first.files[0].name(), "deep", "the basename WITHOUT .md");
    assert_eq!(first.files[1].name(), "top");
    assert_eq!(first.root, root);
    assert_eq!(first.epoch, 1);

    let blob = walk(root).encode_blob();
    let b = Blob::parse(&blob);
    assert_eq!(b.n, 3, "the blob has three nodes; the snapshot has two files");

    // A mutation only BUMPS the epoch; the next call whose epoch differs
    // replaces the cache entry, and the old Arc stays alive exactly as long as
    // its last holder — so an in-flight search's paths can never dangle and can
    // never be rewritten under it.
    vault.write().epoch = 2;
    let third = vault.snapshot();
    assert!(!std::sync::Arc::ptr_eq(&first, &third), "a new epoch => a fresh Arc");
    assert_eq!(third.epoch, 2);
    assert_eq!(first.files[0].rel, third.files[0].rel, "and the old one is still readable");
}

/* ── path.rs helpers (the two VALIDATORS live in tests/path_safety.rs) ─────── */

#[test]
fn path_helpers() {
    assert!(vpath::is_md("a.md") && vpath::is_md("A.MD") && vpath::is_md("x.Md"));
    assert!(!vpath::is_md(".md") && !vpath::is_md("md") && !vpath::is_md("a.mdx"));
    assert!(!vpath::is_md("caf\u{e9}"), "a multi-byte tail is not a `.md` boundary");

    assert_eq!(vpath::basename_span("a/b/note.md"), (4, 4));
    assert_eq!(vpath::basename_span("note.md"), (0, 4));
    assert_eq!(vpath::basename_span("Archive /v1./n.md"), (13, 1));
}

/* ── helpers for Part 2 ───────────────────────────────────────────────────── */

fn collect_rel(t: &VaultTree, id: tree::NodeId, out: &mut BTreeSet<String>) {
    for &c in t.children(id) {
        out.insert(t.rel_path(c));
        collect_rel(t, c, out);
    }
}

fn preorder_rel(t: &VaultTree, id: tree::NodeId, out: &mut Vec<String>) {
    for &c in t.children(id) {
        out.push(t.rel_path(c));
        preorder_rel(t, c, out);
    }
}

fn preorder_ids(t: &VaultTree, id: tree::NodeId, out: &mut Vec<tree::NodeId>) {
    for &c in t.children(id) {
        out.push(c);
        preorder_ids(t, c, out);
    }
}

/// `utimes` rather than sleeping: the sort tests need known, distinct mtimes,
/// and a test that sleeps to get them is both slow and flaky.
fn set_mtime(path: &Path, secs: i64) {
    let tv = libc::timeval { tv_sec: secs as libc::time_t, tv_usec: 0 };
    let times = [tv, tv];
    let c = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()).unwrap();
    // SAFETY: `c` is a valid NUL-terminated path and `times` is the 2-element
    // array `utimes` expects.
    let rc = unsafe { libc::utimes(c.as_ptr(), times.as_ptr()) };
    assert_eq!(rc, 0, "utimes({}) failed", path.display());
}

/// A process that has exited AND been reaped, so its PID is genuinely gone
/// rather than a zombie (a zombie still answers `kill(pid, 0)` with 0).
fn reaped_pid() -> u32 {
    let mut child = Command::new("/usr/bin/true").spawn().expect("spawn /usr/bin/true");
    let pid = child.id();
    child.wait().expect("wait");
    for _ in 0..50 {
        // SAFETY: signal 0 checks for existence and delivers nothing.
        if unsafe { libc::kill(pid as libc::pid_t, 0) } == -1 {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    pid
}
