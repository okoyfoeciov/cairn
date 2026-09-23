//! Owner: 02.  Integration: traversal, unicode and case-fold attacks.
//! Spec: CONTRACT.md §7.3 case 10 (case-insensitive APFS), case 11 (invalid
//! names, M52), case 12 (symlink loops), case 13 (the traversal guarantee),
//! §7.1 rule 2 step 3 / §7.3 case 1 (the leading-dot, PID-bearing temp name,
//! M67), and §6.4's struck normalisation clause.
//!
//! ===========================================================================
//! THIS FILE IS IN TWO HALVES, AND THE SPLIT IS DELIBERATE.
//!
//! PART 1 — THE PLATFORM PREMISES.  Every invariant in §7.3 rests on a claim
//! about macOS and APFS: that `DirEntry::file_type()` does not follow symlinks,
//! that a NUL can never reach a syscall, that APFS is case-insensitive, that
//! `root.join("/etc/passwd")` throws the root away, that macOS will happily
//! create `CON.md` and `trailing .md `.  Those claims are the reason the
//! validators are written the way they are — and NOT ONE OF THEM IS TESTED
//! ANYWHERE ELSE.  They run today, against the real filesystem, and they are
//! the half of this file that has teeth right now.
//!
//! PART 2 — THE VALIDATOR BATTERY.  The §7.3 case-11 rejection sets, run
//! against `validate_name` and `validate_rel_for_lookup` directly.
//!
//! THE TWO VALIDATORS ARE DIFFERENT FUNCTIONS (M52) and this file tests them
//! separately.  A single `validate_rel` cannot be both, because a name that must
//! be REJECTED on creation (`Archive `, `v1.`) may still have to be RESOLVED if
//! it already exists on disk — spec-02 §5.2's version made such notes visible
//! but permanently unopenable.
//!
//! NFC/NFD NORMALISATION IS STRUCK (§6.4) and is a RECORDED LIMITATION.  This
//! file asserts THE LIMITATION rather than the feature, so that adding
//! normalisation later is a deliberate change to a failing test and not a
//! silent one.
//!
//! Every command re-validates its own path in RUST (§6.1): the frontend's
//! `beforeinput` filter is a courtesy, never the guarantee.
//! ===========================================================================

use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::Path;

use cairn_lib::error::VaultError;
use cairn_lib::path::{validate_name, validate_rel_for_lookup};

/* ===========================================================================
 * PART 1 — THE PLATFORM PREMISES.  These run today.
 * ========================================================================= */

fn tmp() -> tempfile::TempDir {
    tempfile::tempdir().expect("tempdir")
}

/// §7.3 case 12, the WHOLE mechanism: "`DirEntry::file_type()` on Unix reads
/// `d_type` and does **not** follow, so a symlinked directory reports
/// `is_symlink() == true` and `is_dir() == false` and is skipped at walk time.
/// Loops are therefore structurally impossible."
///
/// The contract then declines to call `fs::canonicalize` — "it is a syscall per
/// validation and a TOCTOU race; the arena is the check". That trade is only
/// sound if this claim holds, and it is a claim about libstd and about APFS.
#[test]
fn symlinked_directory_reports_is_symlink_and_not_is_dir() {
    let d = tmp();
    let root = d.path();
    fs::create_dir(root.join("real")).unwrap();
    std::os::unix::fs::symlink("..", root.join("loop")).unwrap();
    std::os::unix::fs::symlink("/etc", root.join("escape")).unwrap();
    fs::write(root.join("note.md"), b"# n\n").unwrap();

    let mut seen: Vec<(String, bool, bool, bool)> = fs::read_dir(root)
        .unwrap()
        .map(|e| {
            let e = e.unwrap();
            let ft = e.file_type().unwrap();
            (
                e.file_name().to_string_lossy().into_owned(),
                ft.is_symlink(),
                ft.is_dir(),
                ft.is_file(),
            )
        })
        .collect();
    seen.sort();

    let get = |n: &str| seen.iter().find(|r| r.0 == n).cloned().unwrap();
    assert_eq!(get("loop"), ("loop".into(), true, false, false), "a symlink loop");
    assert_eq!(get("escape"), ("escape".into(), true, false, false), "a symlink out of the vault");
    assert_eq!(get("real"), ("real".into(), false, true, false));
    assert_eq!(get("note.md"), ("note.md".into(), false, false, true));

    // And the contrast that makes the choice load-bearing: `metadata()` FOLLOWS,
    // so a walk written with `metadata()` instead of `file_type()` would recurse
    // into /etc and into itself.
    assert!(fs::metadata(root.join("escape")).unwrap().is_dir(), "metadata() follows the link");
    assert!(fs::symlink_metadata(root.join("escape")).unwrap().file_type().is_symlink());
}

/// §7.3 case 13 and the reason `validate_rel_for_lookup` must reject a leading
/// `/` and every `..` component: naive joining is not a containment check.
/// `Path::join` with an ABSOLUTE argument DISCARDS THE ROOT ENTIRELY — silently.
// The lint below exists BECAUSE of the behaviour this test asserts. Asserting it
// is the point: `root.join("/etc/passwd")` silently discards `root`.
#[allow(clippy::join_absolute_paths)]
#[test]
fn joining_a_relative_path_is_not_a_containment_check() {
    let root = Path::new("/Users/someone/Vault");

    let escaped = root.join("../../etc/passwd");
    assert_eq!(escaped, Path::new("/Users/someone/Vault/../../etc/passwd"));
    assert_eq!(
        escaped.components().filter(|c| matches!(c, std::path::Component::ParentDir)).count(),
        2,
        "`..` survives join; only a component walk or a canonicalize would collapse it"
    );

    let absolute = root.join("/etc/passwd");
    assert_eq!(absolute, Path::new("/etc/passwd"), "an absolute join THROWS THE ROOT AWAY");
    assert!(!absolute.starts_with(root));

    // starts_with() is not a rescue either: it is textual, so it passes for a
    // path that has not been collapsed.
    assert!(escaped.starts_with(root), "starts_with() says yes about a path that escapes");
}

/// §7.3 case 10's premise. Everything the case rules — `same_file(src, dst)`
/// by `dev`+`ino`, the two-step rename through a temp name — exists only
/// because of this. If the volume under the test is case-SENSITIVE the case is
/// unreachable, so the test states which world it is in rather than guessing.
#[test]
#[cfg_attr(
    target_os = "linux",
    ignore = "unmeasured on Linux: states which world it is in by panicking on case-sensitive volumes; §7.3 case 10 mechanism is written for case-insensitive APFS"
)]
fn apfs_case_insensitivity_and_the_dev_ino_test() {
    let d = tmp();
    let root = d.path();
    fs::write(root.join("notes.md"), b"the user's note\n").unwrap();

    let lower = fs::metadata(root.join("notes.md")).unwrap();
    let upper = fs::metadata(root.join("NOTES.md"));

    match upper {
        Ok(u) => {
            assert_eq!(
                (lower.dev(), lower.ino()),
                (u.dev(), u.ino()),
                "case-insensitive volume: the two names must be the SAME file, which is \
                 exactly what §7.3 case 10's same_file(src, dst) detects"
            );
            // The two-step rename §7.3 case 10 mandates, performed for real.
            let tmp_name = root.join(format!(".notes.md.tmp-{}-0", std::process::id()));
            fs::rename(root.join("notes.md"), &tmp_name).unwrap();
            fs::rename(&tmp_name, root.join("Notes.md")).unwrap();
            assert_eq!(fs::read(root.join("Notes.md")).unwrap(), b"the user's note\n");
            let names: Vec<String> = fs::read_dir(root)
                .unwrap()
                .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                .collect();
            assert_eq!(names, vec!["Notes.md".to_string()], "one file, the new casing, content intact");
        }
        Err(e) => panic!(
            "the volume under {} is CASE-SENSITIVE ({e}); §7.3 case 10's mechanism is written \
             for case-insensitive APFS and this run cannot exercise it",
            root.display()
        ),
    }
}

/// §7.3 case 11: a NUL can never reach the syscall, because libstd refuses to
/// build the `CString`. The validator's NUL rule is defence in depth and a
/// SOURCE OF A TYPED ERROR — not the only thing standing between the user and a
/// truncated path. Worth pinning: the failure is `InvalidInput`, not a panic.
#[test]
fn a_nul_byte_never_reaches_the_filesystem() {
    let d = tmp();
    let err = fs::write(d.path().join("a\0b.md"), b"x").unwrap_err();
    assert_eq!(err.kind(), std::io::ErrorKind::InvalidInput, "libstd refuses before the syscall");
    assert!(fs::read_dir(d.path()).unwrap().next().is_none(), "and nothing was created");
}

/// §7.3 case 11 again: `/` is a separator, never a name. A "name" containing one
/// is a two-component path, and creating through it fails because the parent
/// does not exist — it does NOT create a file with a slash in its name.
#[test]
fn a_separator_in_a_name_is_a_path_not_a_name() {
    let d = tmp();
    assert_eq!(Path::new("sub/child.md").components().count(), 2);
    let err = fs::write(d.path().join("sub/child.md"), b"x").unwrap_err();
    assert_eq!(err.kind(), std::io::ErrorKind::NotFound);
    assert!(fs::read_dir(d.path()).unwrap().next().is_none());
}

/// §7.3 case 11's ACTUAL justification: `validate_name` is "deliberately
/// stricter than either OS's own minimum, because vaults get synced onto
/// Windows". This test proves the "stricter than macOS" half by creating, on
/// this filesystem, every name `validate_name` rejects for portability. Each one
/// that succeeds here is a name the filesystem will NOT protect the user from.
#[test]
fn macos_happily_creates_every_name_validate_name_rejects_for_portability() {
    let d = tmp();
    let root = d.path();
    // `/` and NUL are excluded: they are the only two the OS itself refuses,
    // and they have their own tests above.
    let portability_only = [
        "back\\slash.md",
        "colon:name.md",
        "star*name.md",
        "question?.md",
        "quote\".md",
        "less<than.md",
        "greater>than.md",
        "pipe|name.md",
        "ctrl\u{1}char.md",
        " leading-space.md",
        "trailing-space.md ",
        "trailing-dot.md.",
        "CON.md",
        "PRN",
        "AUX.md",
        "NUL.md",
        "COM1.md",
        "LPT9.md",
        "Archive ",
        "v1.",
    ];
    let mut created = Vec::new();
    for name in portability_only {
        match fs::write(root.join(name), b"x") {
            Ok(()) => created.push(name),
            Err(e) => panic!("macOS refused {name:?} ({e}) — this test's premise has changed"),
        }
    }
    assert_eq!(
        created.len(),
        portability_only.len(),
        "every one of these is legal on macOS; the ONLY guard is validate_name"
    );
    // And they really are on disk under those exact bytes.
    let on_disk: std::collections::BTreeSet<String> = fs::read_dir(root)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    for name in portability_only {
        assert!(on_disk.contains(name), "{name:?} is on disk verbatim");
    }
}

/// §7.1 rule 2 step 3 / §7.3 case 1 / §7.3 case 10 (X15-temp): ONE temp-name
/// shape — leading `.`, a `.tmp-` infix, the writing process's PID — and three
/// separate rules depend on all three parts of it:
///   - the leading `.` makes it invisible to the scanner (§3.6 skips dotfiles)
///     and to every sync client, which is what satisfies G8;
///   - the `.tmp-` infix is what the crash sweep matches;
///   - the PID is what makes the sweep able to unlink on sight (M67) instead of
///     waiting an hour, which is what stops crash debris being replicated into
///     an iCloud or Dropbox vault.
///
/// The earlier `<tmp>.<pid>.<nanos>` form matched neither the sweep nor the
/// dotfile rule, so a crash between the two renames left a permanently visible,
/// never-swept file holding the user's note.
#[test]
fn the_temp_name_convention_is_invisible_swept_and_pid_bearing() {
    let d = tmp();
    let root = d.path();
    let pid = std::process::id();
    let temp = format!(".Ideas.md.tmp-{pid}-0");

    assert!(temp.starts_with('.'), "leading dot: the scanner and every sync client skip it");
    assert!(temp.contains(".tmp-"), "the infix the crash sweep matches");
    assert!(temp.contains(&pid.to_string()), "the PID the sweep tests with kill(pid, 0)");

    fs::write(root.join(&temp), b"half-written").unwrap();
    fs::write(root.join("Ideas.md"), b"# Ideas\n").unwrap();

    // §3.6's rule, applied: the scanner skips dotfiles, so the temp is invisible
    // and G8 ("0 stray files") holds even mid-write.
    let visible: Vec<String> = fs::read_dir(root)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| !n.starts_with('.'))
        .collect();
    assert_eq!(visible, vec!["Ideas.md".to_string()]);

    // M67's sweep predicate: a temp whose PID is not a live process is unlinked
    // ON SIGHT. A dead PID must report ESRCH, or the sweep silently degrades
    // back to the hour-only rule the contract struck.
    let dead = spawn_and_reap();
    let rc = unsafe { libc::kill(dead as libc::pid_t, 0) };
    assert_eq!(rc, -1, "kill(dead_pid, 0) must fail");
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ESRCH),
        "and it must fail with ESRCH specifically — EPERM would mean the PID is alive and \
         someone else's, which the sweep must NOT unlink"
    );
    let rc_self = unsafe { libc::kill(pid as libc::pid_t, 0) };
    assert_eq!(rc_self, 0, "and a LIVE pid must report 0, or the sweep deletes live temps");
}

/// A process that has exited AND been reaped, so its PID is genuinely gone
/// rather than a zombie (a zombie still answers `kill(pid, 0)` with 0).
fn spawn_and_reap() -> u32 {
    let mut child = std::process::Command::new("/usr/bin/true").spawn().expect("spawn /usr/bin/true");
    let pid = child.id();
    child.wait().expect("wait");
    // Give the kernel a moment to release the entry.
    for _ in 0..50 {
        if unsafe { libc::kill(pid as libc::pid_t, 0) } == -1 {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    pid
}

/// §6.4: "path.rs's NFC/NFD normalisation is STRUCK — spec-02 specifies none and
/// spec-04 §8.4 explicitly refuses it. Recorded as a LIMITATION."
///
/// The limitation is asserted, not the feature. Two things are pinned here and
/// they are different: what the STRINGS do (they are not equal, and nothing in
/// this codebase makes them equal) and what APFS does (it is
/// normalisation-INSENSITIVE, so the two spellings reach the same file). The
/// gap between those two facts is the limitation.
#[test]
#[cfg_attr(
    target_os = "linux",
    ignore = "unmeasured on Linux: asserts APFS normalisation-insensitivity; on ext4/tmpfs NFC and NFD are distinct files, which the app treats as distinct identities (the recorded limitation's other half)"
)]
fn unicode_normalisation_is_not_performed_and_that_is_the_recorded_limitation() {
    let nfc = "caf\u{e9}.md"; // é as one code point
    let nfd = "cafe\u{301}.md"; // e + combining acute
    assert_ne!(nfc, nfd, "different byte strings");
    assert_eq!(nfc.chars().count(), 7);
    assert_eq!(nfd.chars().count(), 8);

    let d = tmp();
    let root = d.path();
    fs::write(root.join(nfc), b"one\n").unwrap();

    let same_file = fs::metadata(root.join(nfd))
        .ok()
        .map(|m| {
            let a = fs::metadata(root.join(nfc)).unwrap();
            (a.dev(), a.ino()) == (m.dev(), m.ino())
        })
        .unwrap_or(false);

    let entries: Vec<String> = fs::read_dir(root)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(entries.len(), 1, "one file on disk either way");

    // Whichever way this volume behaves, record it. If it ever changes, this
    // assertion is the thing that says so.
    assert!(
        same_file,
        "APFS on this machine is normalisation-INSENSITIVE, so {nfd:?} resolves to the file \
         created as {nfc:?}. The app does NOT normalise (§6.4), so two vault paths that differ \
         only by normalisation are two distinct app-level identities pointing at ONE file. That \
         is the recorded limitation; if this assertion ever fails the volume changed, not the app."
    );
    // And the directory entry keeps the spelling it was created with, so a path
    // read back out of the arena is never silently re-spelled.
    assert_eq!(entries[0], nfc, "the entry keeps its original normalisation form");
}

/* ===========================================================================
 * PART 2 — THE VALIDATOR BATTERY (M52).  Dormant until the seam is flipped;
 * `path_rs_tripwire` fails the build if it is still dormant once path.rs
 * defines either function.
 * ========================================================================= */

fn assert_invalid_name(name: &str, why: &str) {
    match validate_name(name) {
        Err(VaultError::InvalidName { .. }) => {}
        other => panic!("validate_name({name:?}) must be InvalidName ({why}); got {other:?}"),
    }
}

fn assert_valid_name(name: &str) {
    assert!(matches!(validate_name(name), Ok(())), "validate_name({name:?}) must be Ok");
}

fn assert_invalid_rel(rel: &str, why: &str) {
    match validate_rel_for_lookup(rel) {
        Err(VaultError::InvalidPath { .. }) => {}
        other => panic!("validate_rel_for_lookup({rel:?}) must be InvalidPath ({why}); got {other:?}"),
    }
}

fn assert_valid_rel(rel: &str) {
    assert!(
        matches!(validate_rel_for_lookup(rel), Ok(())),
        "validate_rel_for_lookup({rel:?}) must be Ok — §7.3 case 11 rejects ONLY NUL, a leading \
         or trailing `/`, an empty component, a `.` or `..` component, and >255 components"
    );
}

/// §7.3 case 11, `validate_name`'s full rejection set, verbatim.
#[test]
fn validate_name_rejects_case_11s_set() {
    for c in ['\\', '/', ':', '*', '?', '"', '<', '>', '|'] {
        assert_invalid_name(&format!("a{c}b.md"), "the nine reserved characters");
    }
    for code in 0u32..0x20 {
        let c = char::from_u32(code).unwrap();
        assert_invalid_name(&format!("a{c}b.md"), "U+0000-U+001F");
    }
    assert_invalid_name("", "empty");
    assert_invalid_name("   ", "whitespace-only");
    assert_invalid_name("\t", "whitespace-only");
    assert_invalid_name(".", "the current directory");
    assert_invalid_name("..", "the parent directory");
    assert_invalid_name(" leading.md", "leading space");
    assert_invalid_name("trailing.md ", "trailing space");
    assert_invalid_name("trailing.", "trailing dot");
    for dev in [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM9", "LPT1", "LPT9", "con", "Con", "CON.md",
        "nul.txt", "COM3.md",
    ] {
        assert_invalid_name(dev, "a Windows device name, with or without an extension");
    }
    assert_invalid_name(&"a".repeat(256), "longer than 255 UTF-8 bytes");
    // 255 BYTES, not 255 chars: the rule is stated in UTF-8 bytes.
    assert_invalid_name(&"é".repeat(128), "256 UTF-8 bytes from 128 characters");
}

#[test]
fn validate_name_accepts_ordinary_names() {
    for name in [
        "Meeting notes.md",
        "日本語のノート.md",
        "v1.2.3.md",
        "COMET.md",
        "CONTRACT.md",
        "NULL.md",
        "LPT10.md",
        "a.md",
        "-.md",
        "100% done.md",
        "Archive",
    ] {
        assert_valid_name(name);
    }
    assert_valid_name(&"a".repeat(255));
}

/// M52's whole point, and the bug it fixes: spec-02 §5.2's single `validate_rel`
/// required every component of a LOOKUP path to pass `validate_name`, which made
/// legitimate notes VISIBLE BUT PERMANENTLY UNOPENABLE. `Archive ` and `v1.` are
/// legal on ext4, common, and arrive on macOS through a sync client; the §4.6
/// walk admits them and the tree draws them.
#[test]
fn the_two_validators_disagree_and_that_is_the_ruling() {
    for name in ["Archive ", "v1.", "CON.md", "star*name.md", "trailing-dot.md."] {
        assert_invalid_name(name, "creation is strict");
    }
    assert_valid_rel("Archive /note.md");
    assert_valid_rel("v1./note.md");
    assert_valid_rel("CON.md");
    assert_valid_rel("star*name.md");
    assert_valid_rel("Archive /v1./deep/CON.md");
}

/// §7.3 case 11: `validate_rel_for_lookup` rejects ONLY six things. Anything
/// else it refuses is a note the user can see and cannot open.
#[test]
fn validate_rel_for_lookup_rejects_only_the_six() {
    assert_invalid_rel("a\0b.md", "NUL");
    assert_invalid_rel("/a.md", "leading slash");
    assert_invalid_rel("a.md/", "trailing slash");
    assert_invalid_rel("a//b.md", "empty component");
    assert_invalid_rel("./a.md", "a `.` component");
    assert_invalid_rel("a/./b.md", "a `.` component");
    assert_invalid_rel("../a.md", "a `..` component");
    assert_invalid_rel("a/../../etc/passwd", "a `..` component");
    assert_invalid_rel("a/..", "a trailing `..` component");
    let too_deep = std::iter::repeat("a").take(256).collect::<Vec<_>>().join("/");
    assert_invalid_rel(&too_deep, "more than 255 components");
}

/// §7.3 case 13, at the validator: every path the traversal test names must be
/// refused BEFORE resolution runs.
#[test]
fn case_13_traversal_inputs_are_all_refused() {
    for rel in [
        "../../etc/passwd",
        "/etc/passwd",
        "..",
        "../",
        "loop/../../etc/passwd",
        "notes/../../../../../../etc/passwd",
    ] {
        assert_invalid_rel(rel, "§7.3 case 13");
    }
    // The rename and create halves of case 13 go through validate_name, which
    // rejects `/` outright and so cannot express a traversal at all.
    for name in ["../b.md", "../x", "/etc/passwd"] {
        assert_invalid_name(name, "§7.3 case 13 via a NAME");
    }
}

#[test]
fn validate_rel_for_lookup_accepts_what_the_walk_can_produce() {
    // §1.1: "`\"\"` for the vault root".
    assert_valid_rel("");
    for rel in [
        "note.md",
        "a b/日本 100%.md",
        "Archive /2024/notes.md",
        "deep/deep/deep/deep/note.md",
        "cafe\u{301}.md",
        "caf\u{e9}.md",
    ] {
        assert_valid_rel(rel);
    }
    let deep = std::iter::repeat("a").take(255).collect::<Vec<_>>().join("/");
    assert_valid_rel(&deep);
}

/// §6.4, asserted at the validator: neither function normalises, so the NFC and
/// NFD spellings stay two distinct inputs. Adding normalisation later must break
/// this test deliberately.
#[test]
fn neither_validator_normalises() {
    assert_valid_name("caf\u{e9}.md");
    assert_valid_name("cafe\u{301}.md");
    assert_valid_rel("caf\u{e9}.md");
    assert_valid_rel("cafe\u{301}.md");
    assert_ne!("caf\u{e9}.md", "cafe\u{301}.md");
}
