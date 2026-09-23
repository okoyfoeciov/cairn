//! A vault entry named `*.md` that is not a regular file — a FIFO, a socket, a
//! F15 — a vault entry named `*.md` that is not a regular file, socket or
//! device node — is not a note.  Opening a FIFO for reading blocks until a
//! writer appears, so one that reaches the tree parks a blocking worker (and
//! the `secrets_cache` mutex with it) for good; enough tree refreshes then
//! starve the six-thread pool that `write_note` runs on.
//!
//! Every call that could hang runs on its own thread behind a timeout, so a
//! regression FAILS here instead of hanging the suite.
#![cfg(unix)]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]

use std::ffi::CString;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

use cairn_lib::fsops;
use cairn_lib::tree::SortMode;
use cairn_lib::vault;

const SECRET: &[u8] = b"---\ncairn-type: secrets\n---\n";

fn mkfifo(p: &Path) {
    let c = CString::new(p.as_os_str().as_bytes()).unwrap();
    // SAFETY: a valid NUL-terminated path; mkfifo does not retain it.
    let rc = unsafe { libc::mkfifo(c.as_ptr(), 0o644) };
    assert_eq!(rc, 0, "mkfifo {}: {}", p.display(), std::io::Error::last_os_error());
}

/// Releases a reader parked in `open()` on `fifo`, so a failing run does not
/// leave a thread blocked for the rest of the test binary.
fn unblock(fifo: &Path) {
    use std::os::unix::fs::OpenOptionsExt;
    let _ = std::fs::OpenOptions::new().write(true).custom_flags(libc::O_NONBLOCK).open(fifo);
}

/// Runs `f` on its own thread and gives it `secs` to answer.
fn within<T: Send + 'static>(secs: u64, f: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(f());
    });
    rx.recv_timeout(Duration::from_secs(secs)).ok()
}

fn vault_dir() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let root = fsops::canonical_root(dir.path()).unwrap();
    (dir, root)
}

fn rels(v: &cairn_lib::tree::Vault) -> Vec<String> {
    let mut r: Vec<String> = v.snapshot().files.iter().map(|f| f.rel.to_string()).collect();
    r.sort();
    r
}

#[test]
fn a_fifo_or_socket_named_md_is_not_a_note() {
    let (_d, root) = vault_dir();
    std::fs::write(root.join("a.md"), SECRET).unwrap();
    mkfifo(&root.join("pipe.md"));
    let _sock = std::os::unix::net::UnixListener::bind(root.join("sock.md")).unwrap();

    let (v, _) = vault::open_at(&root, SortMode::default(), 1).unwrap();
    assert_eq!(rels(&v), vec!["a.md".to_string()], "a special file was admitted as a note");

    let secrets = within(3, move || v.secret_notes());
    if secrets.is_none() {
        unblock(&root.join("pipe.md"));
    }
    assert_eq!(secrets, Some(vec!["a.md".to_string()]), "secret_notes blocked on a FIFO");
}

/// The tree can be one refresh behind the disk: a note replaced by a FIFO
/// after the walk is still in the snapshot.  Classifying it must not block.
#[test]
fn secret_notes_does_not_block_on_a_note_replaced_by_a_fifo() {    let (_d, root) = vault_dir();
    std::fs::write(root.join("a.md"), SECRET).unwrap();
    std::fs::write(root.join("pipe.md"), b"plain\n").unwrap();
    let (v, _) = vault::open_at(&root, SortMode::default(), 1).unwrap();
    assert_eq!(rels(&v), vec!["a.md".to_string(), "pipe.md".to_string()]);

    std::fs::remove_file(root.join("pipe.md")).unwrap();
    mkfifo(&root.join("pipe.md"));

    let secrets = within(3, move || v.secret_notes());
    if secrets.is_none() {
        unblock(&root.join("pipe.md"));
    }
    assert_eq!(secrets, Some(vec!["a.md".to_string()]), "secret_notes blocked on a FIFO");
}

/// F15, the read half: the open note replaced by a FIFO (synced in from
/// elsewhere, or a prank) must not park the worker that reloads it. The read
/// is refused as not-a-note instead of blocking for a writer that never comes.
#[test]
fn read_note_does_not_block_on_a_note_replaced_by_a_fifo() {
    let (_d, root) = vault_dir();
    let abs = root.join("a.md");
    std::fs::write(&abs, b"plain\n").unwrap();
    std::fs::remove_file(&abs).unwrap();
    mkfifo(&abs);

    let r = within(3, {
        let abs = abs.clone();
        move || fsops::read_note(&abs, "a.md")
    });
    if r.is_none() {
        unblock(&abs);
    }
    let err = r.expect("read_note blocked on a FIFO").unwrap_err();
    assert_eq!(err.kind(), "notFound", "a FIFO reads as {err:?}");
}
