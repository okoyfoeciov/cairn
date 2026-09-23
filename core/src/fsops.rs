//! core/src/fsops.rs — Owner: 02.
//! Spec: CONTRACT.md §7 in its entirety (the data-loss rules), §7.1 (the three
//! structural rules), §7.3 (the enumerated paths), §2 (the frame), §1.3 command
//! 20 (`reveal_in_os`, X11), M66, M67, M68; spec-02 §6.
//!
//! THE THREE RULES EVERYTHING ELSE RESTS ON (§7.1):
//!   1. `write_note` NEVER CREATES A FILE unless explicitly told to.  `x-create`
//!      is '0' on every autosave, idle flush, blur flush and close flush, and
//!      '1' in EXACTLY ONE PLACE in the whole app: the "Save as…" button on
//!      §7.3 case 5's bar.  This is what makes B17's resurrection bug impossible
//!      BY CONSTRUCTION rather than by timer luck.
//!   2. The atomic write sequence is fixed — eleven steps, below, in order.
//!   3. Nothing is ever silently overwritten and nothing is ever silently
//!      discarded: write, refuse-and-tell, or prompt.  There is no fourth
//!      outcome, and no function in this file has one.
//!
//! ===========================================================================
//! THE SEAM, STATED PLAINLY, BECAUSE IT IS THE ONE THING A READER WILL WANT
//! FIRST.  Every function here takes an ALREADY-RESOLVED ABSOLUTE PATH.  Path
//! RESOLUTION — vault-relative string -> arena node -> absolute path — belongs to
//! the arena (`tree.rs`) and the two validators belong to `path.rs`, and §7.3
//! case 12 is explicit that "the arena is the check": the traversal guarantee
//! comes from `resolve()` walking arena names under a lock, NOT from anything
//! this file could re-derive.  A second resolver here would be a second place
//! for the guarantee to be wrong.
//!
//! What this file does own, and does enforce regardless of its caller, is
//! `reject_path_component` (below): a floor that makes it impossible to get a
//! `/`, a NUL, a `.` or a `..` into a name this file creates.  It is NOT
//! `validate_name` — that is `path.rs`'s stricter, Windows-aware policy and is
//! the caller's obligation on the create and rename paths.
//! ===========================================================================
//!
//! Also normative here: parent-directory `sync_all()` on Linux, step 8b (M66) —
//! a `#[cfg]` portability seam that stays honest even though Linux is deferred
//! past v1.  Temp files are unlinked ON SIGHT when their embedded PID is dead
//! (M67), not on a one-hour timer.  New notes get a FLAT `0o644`; an overwrite
//! PRESERVES THE DESTINATION'S MODE (M68) — spec-02 §6.2 step 7's `0o644 &
//! !umask` is STRUCK.
//!
//! CLIPPY DENY LIST (§6.2, gate G7): this module carries the three restriction
//! lints.  That is the obligation `panic = "unwind"` creates, and it is
//! enforced, not hoped for.

#![deny(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]

use std::ffi::CString;
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::Write;
use std::os::fd::AsRawFd;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::error::VaultError;
use crate::note_frame::{self, WriteArgs, MAX_NOTE_BYTES};
use crate::path;
use crate::watcher::{SelfWrite, SelfWrites};

/* ── wire results ─────────────────────────────────────────────────────────── */

/// CONTRACT §1.5, X13: camelCase on the wire.  `mtime_ms` is an `i64`
/// millisecond epoch (§1.1), the same number the note frame carries at offset 8
/// and the same number the frontend echoes back in `x-base-mtime`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteReceipt {
    pub mtime_ms: i64,
    pub size: u64,
}

/// CONTRACT §1.3: the mutating commands (10-13) return `{ path, epoch }`-shaped
/// results and NEVER a blob.  The frontend follows with `tree_snapshot()`, which
/// keeps every binary payload on one code path.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateResult {
    pub path: String,
    pub epoch: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameResult {
    pub path: String,
    pub epoch: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteResult {
    pub epoch: u64,
}

/// spec-02 §6.1.  PURELY INTERNAL — it never crosses the IPC boundary and is
/// never serialised, so it keeps snake_case (§1.1's camelCase rule binds wire
/// types only).  The TypeScript `NoteRead` of §1.5 is a different object with
/// the same name: it is what `decodeNote()` RETURNS.
#[derive(Debug, Clone)]
pub struct NoteRead {
    pub bytes: Vec<u8>,
    pub mtime_ms: i64,
    pub flags: u32,
}

/* ── time ─────────────────────────────────────────────────────────────────── */

/// §1.1: `i64` milliseconds since the Unix epoch.  A pre-1970 mtime is negative
/// rather than clamped — it is a legal timestamp and the conflict guard compares
/// it for equality, so silently mapping it to 0 would make every save on such a
/// file a false conflict.
pub fn mtime_ms(md: &Metadata) -> i64 {
    match md.modified() {
        Ok(t) => match t.duration_since(UNIX_EPOCH) {
            Ok(d) => i64::try_from(d.as_millis()).unwrap_or(i64::MAX),
            Err(e) => i64::try_from(e.duration().as_millis()).map(|v| -v).unwrap_or(i64::MIN),
        },
        Err(_) => 0,
    }
}

/// CONTRACT §3.5's fingerprint field: full nanosecond resolution, which is what
/// makes `(abs, mtime_ns, len)` strong enough to use instead of a time window.
/// Taken from `st_mtime`/`st_mtime_nsec` directly, because `SystemTime` loses
/// the sub-second part on some platforms' `Duration` conversions and a
/// fingerprint that quietly truncated to whole seconds would suppress a real
/// external edit made in the same second as our own write.
pub fn mtime_ns(md: &Metadata) -> u128 {
    let secs = md.mtime();
    let nanos = md.mtime_nsec().max(0) as u128;
    if secs < 0 {
        return 0; // pre-1970: not a case any fingerprint needs to distinguish
    }
    (secs as u128) * 1_000_000_000 + nanos
}

/* ── the vault root ──────────────────────────────────────────────────────── */

/// Resolve the vault root ONCE, at open, and use the result everywhere: the
/// arena's `root_path`, every absolute path built from it, and the watcher.
///
/// This is the ONLY place the app calls `canonicalize`, and it is not a
/// traversal check — §7.3 case 12 is explicit that `canonicalize` must not be
/// one (a syscall per validation and a TOCTOU race; the arena is the check).
/// It is here because the OS reports canonical paths back to us: `/var` is a
/// symlink to `/private/var` on every Mac, so a vault the user picked as
/// `/var/x` generates FSEvents under `/private/var/x`, and two spellings of one
/// directory make the echo-suppression fingerprints and the watcher's root test
/// silently disagree.  One normalisation at open removes the whole class.
pub fn canonical_root(root: &Path) -> Result<PathBuf, VaultError> {
    let abs = fs::canonicalize(root)
        .map_err(|e| VaultError::from_io(root.to_string_lossy(), &e))?;
    if !abs.is_dir() {
        return Err(VaultError::not_a_directory(root.to_string_lossy()));
    }
    Ok(abs)
}

/* ── the ONE temp-name helper (§7.1 rule 2 step 3, X15-temp) ──────────────── */

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// The longest single path component, in bytes, on ext4, tmpfs, APFS and HFS+.
const NAME_MAX: usize = 255;

/// `dir/".<name>.tmp-<pid>-<counter>"`.  EVERY temp file in the app comes from
/// here — the note write and `state.json`.  `<name>` is only a label and is cut
/// (at a char boundary) so the whole component fits `NAME_MAX`: uniqueness comes
/// from pid + counter + `create_new`, and the sweep reads only the suffix, so a
/// note named near the 255-byte limit must not become unsaveable because its
/// temp name is longer than the filesystem allows.
///
/// Three properties, each load-bearing:
///   - the leading `.` means our own walker and Obsidian both ignore it (§3.6),
///     so a crash never leaves a visible file holding the user's note;
///   - the same directory means the same filesystem, so `rename` is atomic;
///   - the embedded PID is what makes the crash sweep EXACT (M67) rather than a
///     one-hour guess.
///
/// The earlier `<tmp>.<pid>.<nanos>` form matched neither the sweep's pattern
/// nor the leading-dot convention.
///
/// §7.3 case 10's case-only rename does NOT use this helper any more: its
/// intermediate holds the SOLE copy of the note between two renames, so a name
/// the crash sweep unlinks on sight is a full-file-loss window.  It uses
/// `rename_tmp_path` (`.rn-` infix, never swept, recovered at open) instead.
pub fn temp_path(dir: &Path, file_name: &str) -> PathBuf {
    let n = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let suffix = format!(".tmp-{}-{n}", std::process::id());
    let room = NAME_MAX.saturating_sub(1 + suffix.len());
    let mut cut = file_name.len().min(room);
    while !file_name.is_char_boundary(cut) {
        cut -= 1;
    }
    let label = file_name.get(..cut).unwrap_or_default();
    dir.join(format!(".{label}{suffix}"))
}

/// `dir/".<name>.rn-<pid>-<counter>"` — the case-only rename intermediate ONLY.
///
/// Unlike `temp_path`, `<name>` is never shortened: it is the recovery key
/// (`parse_rename_tmp` reads the destination back out of it).
///
/// Same invisibility (leading `.`, same directory) as `temp_path`, but a
/// DISTINCT infix so `parse_temp_pid` never matches it and `should_sweep`
/// never unlinks it.  A crash between the two renames leaves the note here,
/// and `recover_rename_tmps` completes `tmp -> dst` at the next open instead
/// of deleting the only copy.
pub fn rename_tmp_path(dir: &Path, file_name: &str) -> PathBuf {
    let n = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    dir.join(format!(".{file_name}.rn-{}-{n}", std::process::id()))
}

/// The inverse of `rename_tmp_path`: `(pid, destination file name)` when
/// `name` is one of ours.  Matches `.<dest>.rn-<digits>-<digits>` only.
pub fn parse_rename_tmp(name: &str) -> Option<(u32, String)> {
    let rest = name.strip_prefix('.')?;
    let at = rest.rfind(".rn-")?;
    let dest = rest.get(..at)?;
    if dest.is_empty() || dest.contains('/') {
        return None;
    }
    let tail = rest.get(at + ".rn-".len()..)?;
    let (pid, counter) = tail.split_once('-')?;
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if !digits(pid) || !digits(counter) {
        return None;
    }
    Some((pid.parse().ok()?, dest.to_string()))
}

/// The inverse: `Some(pid)` if `name` is one of ours.  Matches
/// `.<anything>.tmp-<digits>-<digits>` and nothing else, so a user's real file
/// called `.hidden.tmp-notes` is never a sweep candidate.
pub fn parse_temp_pid(name: &str) -> Option<u32> {
    let rest = name.strip_prefix('.')?;
    let at = rest.rfind(".tmp-")?;
    let tail = rest.get(at + ".tmp-".len()..)?;
    let (pid, counter) = tail.split_once('-')?;
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if !digits(pid) || !digits(counter) {
        return None;
    }
    pid.parse().ok()
}

/// `kill(pid, 0)`: `Ok` or `EPERM` means the process exists, `ESRCH` means it
/// does not.
///
/// PID 0 IS NEVER LIVE, and that is a safety rule, not a technicality:
/// `kill(0, 0)` signals the caller's ENTIRE PROCESS GROUP.  A temp file named
/// `.x.tmp-0-1` — which a corrupted name or a hostile sync client can produce —
/// must not turn a sweep into a self-signal.
pub fn pid_is_live(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    let pid = match i32::try_from(pid) {
        Ok(p) => p,
        Err(_) => return false,
    };
    // SAFETY: `kill` with signal 0 performs error checking only and sends no
    // signal.  `pid` is guaranteed positive, so no group or broadcast semantics
    // can be reached.
    if unsafe { libc::kill(pid, 0) } == 0 {
        return true;
    }
    // EPERM: it exists and belongs to somebody else.  ESRCH: it is gone.
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// One hour.  Applies ONLY to a temp whose PID is live (§7.3 case 1, M67).
const LIVE_PID_GRACE: Duration = Duration::from_secs(3600);

/// §7.3 case 1's amended sweep rule (M67), as a pure predicate so it can be
/// tested without deleting anything:
///   - not one of our temp names -> never
///   - PID not live -> UNLINK ON SIGHT
///   - PID live -> only after an hour (another instance may be mid-write)
///
/// spec-02 §4.6-7's hour-only rule is STRUCK: crash debris created minutes
/// before the next launch survived it, and in an iCloud or Dropbox vault it is
/// replicated to every other device before it ages out — contradicting G8 and
/// "byte-identical to a vault Obsidian has never seen".
pub fn should_sweep(path: &Path, now: SystemTime) -> bool {
    let Some(name) = path.file_name().and_then(|s| s.to_str()) else { return false };
    // Rename intermediates are NEVER sweep candidates: they hold the sole copy
    // of a note mid-rename and are completed by `recover_rename_tmps` instead.
    if parse_rename_tmp(name).is_some() {
        return false;
    }
    let Some(pid) = parse_temp_pid(name) else { return false };
    if !pid_is_live(pid) {
        return true;
    }
    match fs::symlink_metadata(path).and_then(|m| m.modified()) {
        Ok(mtime) => now.duration_since(mtime).is_ok_and(|age| age >= LIVE_PID_GRACE),
        Err(_) => false,
    }
}

/// Unlinks one candidate if the rule says so.  `scan.rs` calls this for each
/// entry it collected while walking (it is already reading every directory
/// entry, so collecting them is free).
pub fn sweep_temp(path: &Path) -> bool {
    should_sweep(path, SystemTime::now()) && fs::remove_file(path).is_ok()
}

/// Complete interrupted case-only renames: every `.<dest>.rn-<pid>-<ctr>` whose
/// destination is missing is renamed into place.  Runs BEFORE the temp sweep
/// at open, so the sweep can never see the sole copy as debris.  A rename-tmp
/// whose destination already exists is left alone (a later file legitimately
/// took the name — overwriting it would be a second data-loss path).
///
/// Folders as well as notes: a case-only folder rename goes through the same
/// intermediate, and the scanner hides every dot-name, so an unrecovered folder
/// would take every note in it out of the tree.  A recovered folder is then
/// walked, so an intermediate nested inside it is recovered too.
///
/// Iterative, never recursive, symlinks never descended — same shape as the
/// sweep below.  Returns the number of renames completed.
pub fn recover_rename_tmps(root: &Path) -> usize {
    let mut recovered = 0usize;
    let mut queue = vec![root.to_path_buf()];
    while let Some(dir) = queue.pop() {
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for entry in rd.flatten() {
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_symlink() {
                continue;
            }
            let p = entry.path();
            // `parse_rename_tmp` refuses an empty or '/'-bearing destination.
            let dest = p.file_name().and_then(|s| s.to_str()).and_then(parse_rename_tmp);
            if let Some((_pid, dest)) = dest {
                let dst = dir.join(&dest);
                // `occupied`, not `exists()`: rename(2) silently replaces a
                // dangling symlink or an empty directory.
                if !occupied(&dst) && fs::rename(&p, &dst).is_ok() {
                    recovered += 1;
                    if ft.is_dir() {
                        queue.push(dst);
                    }
                    continue;
                }
            }
            if ft.is_dir() {
                queue.push(p);
            }
        }
    }
    recovered
}

/// The whole sweep, standalone: walk `root` and unlink every candidate.  The
/// startup path prefers `scan.rs`'s free collection, but a sweep that can be
/// run on its own is what makes §7.3 case 1's "zero `.tmp-` files after the next
/// vault open" assertion testable without a scanner.
///
/// Iterative, never recursive: a pathological tree must not blow the stack.
/// Symlinked directories are not descended into, for the same reason the walk
/// does not (§7.3 case 12).
pub fn sweep_temps_in(root: &Path) -> usize {
    let now = SystemTime::now();
    let mut swept = 0usize;
    let mut queue = vec![root.to_path_buf()];
    while let Some(dir) = queue.pop() {
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for entry in rd.flatten() {
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_symlink() {
                continue;
            }
            let p = entry.path();
            if ft.is_dir() {
                queue.push(p);
            } else if should_sweep(&p, now) && fs::remove_file(&p).is_ok() {
                swept += 1;
            }
        }
    }
    swept
}

/// Removes the temp file unless disarmed.  This is §7.1 rule 2 step 11 —
/// "on any error after step 4: `let _ = fs::remove_file(&tmp)`" — expressed so
/// that it also covers the paths a `?` takes and the path a panic takes.  Gate
/// G8 is "zero stray files", and an early return is exactly how a stray file
/// gets left behind.
struct TempGuard(Option<PathBuf>);

impl TempGuard {
    fn disarm(&mut self) {
        self.0 = None;
    }
}

impl Drop for TempGuard {
    fn drop(&mut self) {
        if let Some(p) = self.0.take() {
            let _ = fs::remove_file(p);
        }
    }
}

/* ── one Cairn mutation at a time ─────────────────────────────────────────── */

/// Serialises every mutation this process makes to a vault entry.  A note
/// write holds it from its conflict check (step 1) through the rename and the
/// fingerprint; rename, move and delete hold it for their whole operation.
/// Without it two writes with the same base both pass the check and the last
/// rename wins, and a rename or delete landing between a write's check and its
/// rename is undone by that rename (it re-creates the old path).  Process-wide
/// rather than per path, because a folder rename moves every path under it at
/// once.  Never held across a vault walk.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// Poison-tolerant: the lock guards no data, so a panic under it leaves
/// nothing half-updated.
fn write_lock() -> std::sync::MutexGuard<'static, ()> {
    WRITE_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/* ── the atomic write (§7.1 rule 2, steps 3-9) ────────────────────────────── */

/// What a note write must still find at the destination just before its
/// rename.  Step 1 looks at the destination before the temp is written, and the
/// write and fsync take milliseconds, in which another program (a sync client,
/// another editor) can save the note.  Re-checking right before `rename(2)`
/// shrinks that window to the gap between one `lstat` and the rename.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Expect {
    /// `x-create: 1`: nothing may have appeared at the name.
    Absent,
    /// A force write ("Keep mine"): the note must still exist, or the rename
    /// would re-create a note somebody just deleted (step 1b's rule).
    Present,
    /// A guarded write: still exactly the file step 1 compared against.  No
    /// ctime: macOS moves it for xattr churn alone.  A rename-over changes
    /// `ino`; an in-place write changes `mtime_ns` or `len`.
    Unchanged { dev: u64, ino: u64, mtime_ns: u128, len: u64 },
}

impl Expect {
    fn unchanged(md: &Metadata) -> Self {
        Expect::Unchanged { dev: md.dev(), ino: md.ino(), mtime_ns: mtime_ns(md), len: md.len() }
    }

    fn check(self, abs: &Path, rel: &str) -> Result<(), VaultError> {
        let now = match fs::symlink_metadata(abs) {
            Ok(md) => Some(md),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(VaultError::io(rel, &e)),
        };
        match (self, now) {
            (Expect::Absent, None) | (Expect::Present, Some(_)) => Ok(()),
            (Expect::Absent, Some(_)) => Err(VaultError::already_exists(rel)),
            (Expect::Present | Expect::Unchanged { .. }, None) => Err(VaultError::not_found(rel)),
            (Expect::Unchanged { .. }, Some(md)) => {
                if Expect::unchanged(&md) == self {
                    Ok(())
                } else {
                    Err(VaultError::conflict(rel, mtime_ms(&md)))
                }
            }
        }
    }
}

/// The note-only half of the atomic write, which `state.json` never takes.
struct NoteReplace<'a> {
    rel: &'a str,
    expect: Expect,
    /// Carry the replaced file's extended attributes onto the temp.
    carry_xattrs: bool,
}

/// Test seams on the writing thread: after the temp is complete and before the
/// destination is re-checked, and right after the rename lands.
#[cfg(test)]
type WriteHook = std::cell::RefCell<Option<Box<dyn FnOnce(&Path)>>>;

#[cfg(test)]
thread_local! {
    static BEFORE_RECHECK: WriteHook = const { std::cell::RefCell::new(None) };
    static AFTER_RENAME: WriteHook = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn run_hook(slot: &'static std::thread::LocalKey<WriteHook>, abs: &Path) {
    if let Some(f) = slot.with(|s| s.borrow_mut().take()) {
        f(abs);
    }
}

/// Steps 3-9 of §7.1 rule 2, with no policy: temp, fsync, rename.  The
/// conflict check, the create rules and `denormalise` are the CALLER's, because
/// `state.json` uses this routine "minus the conflict check and minus step 1b"
/// (§7.6) and must not be able to reach them by accident.
///
/// `prior_mode` is step 7 (M68): `Some(mode)` preserves an existing
/// destination's permissions, `None` means a new file and a flat `0o644`.
/// `rename` replaces the destination inode, so without this every save would
/// silently tighten the file to the temp's `0o600`.
///
/// `pre_record` is step 9b, the echo-suppression half of the write: when `Some`,
/// the fingerprint for `abs` is recorded from the TEMP file's metadata BEFORE
/// the rename.  `rename(2)` preserves mtime and size, so this names exactly the
/// post-rename state — and the fingerprint is already in place when the rename
/// event is generated.  On macOS this is belt-and-braces (FSEvents latency
/// covers the record-after-rename gap); on Linux inotify delivers instantly and
/// a post-rename record can lose to classification under load, and every loss
/// is a spurious tree rebuild plus, on the open note, a bogus
/// `nc://note-external-change`.  A crash between record and rename leaves a
/// stale exact-match entry that matches nothing (no event was generated) and
/// GCs in 5 s.  `state.json` passes `None`: it is outside every vault and no
/// watcher ever sees it.
///
/// Step 9's result is the TEMP file's metadata too, never a stat of `abs`
/// after the rename: by then `abs` may already hold another program's file,
/// and a receipt naming that file would make the editor adopt its mtime as
/// the base and silently overwrite it on the next save.
pub fn atomic_write(
    abs: &Path,
    bytes: &[u8],
    prior_mode: Option<u32>,
    pre_record: Option<&Mutex<SelfWrites>>,
) -> Result<Metadata, VaultError> {
    replace_file(abs, bytes, prior_mode, pre_record, None)
}

fn replace_file(
    abs: &Path,
    bytes: &[u8],
    prior_mode: Option<u32>,
    pre_record: Option<&Mutex<SelfWrites>>,
    note: Option<&NoteReplace<'_>>,
) -> Result<Metadata, VaultError> {
    let dir = abs.parent().ok_or_else(|| {
        VaultError::invalid_path(abs.to_string_lossy(), "the path has no parent directory")
    })?;
    let name = abs
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| VaultError::invalid_path(abs.to_string_lossy(), "the path has no name"))?;

    // Step 3 + step 4.  `create_new` makes "already exists" an OS-level
    // guarantee, so we can never clobber another instance's in-flight write.
    // The counter makes a collision essentially impossible; a few retries make
    // it actually impossible.
    let mut last_err = None;
    let mut opened: Option<(PathBuf, File)> = None;
    for _ in 0..8 {
        let tmp = temp_path(dir, name);
        match OpenOptions::new().write(true).create_new(true).mode(0o600).open(&tmp) {
            Ok(f) => {
                opened = Some((tmp, f));
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => last_err = Some(e),
            Err(e) => return Err(VaultError::io(dir.to_string_lossy(), &e)),
        }
    }
    let (tmp, mut file) = match opened {
        Some(v) => v,
        None => {
            let e = last_err.unwrap_or_else(|| std::io::Error::other("no temp name was free"));
            return Err(VaultError::io(dir.to_string_lossy(), &e));
        }
    };
    let mut guard = TempGuard(Some(tmp.clone()));

    // Step 5.
    file.write_all(bytes).map_err(|e| VaultError::io(tmp.to_string_lossy(), &e))?;

    // Step 6.  `sync_data` maps to fsync(2), NOT F_FULLFSYNC: full
    // device-barrier durability costs ~50x more and is not warranted for a notes
    // app.  Measured 5.04 ms / 11 KB on APFS, against an 800 ms autosave
    // debounce — invisible.
    file.sync_data().map_err(|e| VaultError::io(tmp.to_string_lossy(), &e))?;

    // Step 7, on the TEMP file, before the rename.
    let mode = prior_mode.unwrap_or(0o644);
    fs::set_permissions(&tmp, fs::Permissions::from_mode(mode))
        .map_err(|e| VaultError::io(tmp.to_string_lossy(), &e))?;

    // After the chmod: on Linux a chmod rewrites an ACL's mask, so the ACL
    // carried here must land second.
    if note.is_some_and(|n| n.carry_xattrs) {
        carry_xattrs(abs, &file);
    }

    // Step 8.  Close first: renaming a file that is still open is legal on Unix
    // but leaves the durability argument resting on the drop order.
    drop(file);

    // Step 9's metadata, from the TEMP (see the doc comment).  chmod and xattrs
    // move ctime, never mtime, so this is the post-rename stat of OUR bytes.
    let tmp_md =
        fs::symlink_metadata(&tmp).map_err(|e| VaultError::io(tmp.to_string_lossy(), &e))?;

    #[cfg(test)]
    run_hook(&BEFORE_RECHECK, abs);

    // Before step 9b, so a refused write leaves no fingerprint behind.
    if let Some(n) = note {
        n.expect.check(abs, n.rel)?;
    }

    // Step 9b (see the `pre_record` contract above).
    if let Some(sw) = pre_record {
        crate::watcher::record_self_write(
            sw,
            SelfWrite::existing(abs, mtime_ns(&tmp_md), tmp_md.len()),
        );
    }

    fs::rename(&tmp, abs).map_err(|e| VaultError::io(abs.to_string_lossy(), &e))?;
    guard.disarm();

    #[cfg(test)]
    run_hook(&AFTER_RENAME, abs);

    // Step 8b (M66).  Without it the `sync_data` above is half a durability
    // guarantee: on ext4 the rename is durable only once the journal commits.
    // macOS does not need it and this is deferred-Linux code, but a `#[cfg]`
    // seam that is written down is one nobody has to rediscover.
    #[cfg(target_os = "linux")]
    {
        if let Ok(d) = File::open(dir) {
            let _ = d.sync_all();
        }
    }

    // Step 9.
    Ok(tmp_md)
}

/* ── extended attributes, carried across the rename (best effort) ─────────── */

/// Values larger than this are skipped rather than read on every autosave.
/// Finder tags and ACLs are a few hundred bytes.
const XATTR_VALUE_CAP: usize = 1 << 20;

/// The rename replaces the note's inode and drops everything attached to the
/// old one.  This copies the replaced file's extended attributes (Finder tags
/// and FinderInfo on macOS; `user.*` and the POSIX access ACL on Linux) onto
/// the temp.  Every failure is ignored: metadata must never make a note
/// unsaveable.  Timestamps are NEVER copied — an old mtime on new bytes would
/// defeat the conflict check and the self-write fingerprint.
fn carry_xattrs(src: &Path, dst: &File) {
    let Ok(c_src) = CString::new(src.as_os_str().as_bytes()) else { return };
    let fd = dst.as_raw_fd();
    let Some(names) = read_sized(|buf, len| xattr_sys::list(&c_src, buf, len)) else { return };
    for name in names.split(|b| *b == 0) {
        if name.is_empty() || !xattr_sys::wanted(name) {
            continue;
        }
        let Ok(c_name) = CString::new(name) else { continue };
        if let Some(value) = read_sized(|buf, len| xattr_sys::get(&c_src, &c_name, buf, len)) {
            xattr_sys::set(fd, &c_name, &value);
        }
    }
}

/// The size-then-fill protocol of `listxattr`/`getxattr`: a null buffer asks
/// for the size.  A change between the two calls fails the second with ERANGE,
/// which is retried.
fn read_sized(mut call: impl FnMut(*mut u8, usize) -> isize) -> Option<Vec<u8>> {
    for _ in 0..3 {
        let need = usize::try_from(call(std::ptr::null_mut(), 0)).ok()?;
        if need > XATTR_VALUE_CAP {
            return None;
        }
        if need == 0 {
            return Some(Vec::new());
        }
        let mut buf = vec![0u8; need];
        match usize::try_from(call(buf.as_mut_ptr(), buf.len())) {
            Ok(got) => {
                buf.truncate(got);
                return Some(buf);
            }
            Err(_) if std::io::Error::last_os_error().raw_os_error() == Some(libc::ERANGE) => {}
            Err(_) => return None,
        }
    }
    None
}

#[cfg(target_os = "linux")]
mod xattr_sys {
    use std::ffi::CStr;
    use std::os::fd::RawFd;

    // SAFETY (all three): the strings are NUL-terminated `CStr`s, and `buf` is
    // either null with `len == 0` or valid for `len` bytes.
    pub fn list(path: &CStr, buf: *mut u8, len: usize) -> isize {
        unsafe { libc::llistxattr(path.as_ptr(), buf.cast(), len) }
    }

    pub fn get(path: &CStr, name: &CStr, buf: *mut u8, len: usize) -> isize {
        unsafe { libc::lgetxattr(path.as_ptr(), name.as_ptr(), buf.cast(), len) }
    }

    pub fn set(fd: RawFd, name: &CStr, value: &[u8]) {
        let _ = unsafe { libc::fsetxattr(fd, name.as_ptr(), value.as_ptr().cast(), value.len(), 0) };
    }

    /// `user.*` and the access ACL.  Not `security.*` (the new inode takes its
    /// own label) and not `trusted.*` (needs CAP_SYS_ADMIN).
    pub fn wanted(name: &[u8]) -> bool {
        name.starts_with(b"user.") || name == b"system.posix_acl_access"
    }
}

#[cfg(target_os = "macos")]
mod xattr_sys {
    use std::ffi::CStr;
    use std::os::fd::RawFd;

    // SAFETY (all three): the strings are NUL-terminated `CStr`s, and `buf` is
    // either null with `len == 0` or valid for `len` bytes.  Position 0 reads
    // and writes a resource fork whole.
    pub fn list(path: &CStr, buf: *mut u8, len: usize) -> isize {
        unsafe { libc::listxattr(path.as_ptr(), buf.cast(), len, libc::XATTR_NOFOLLOW) }
    }

    pub fn get(path: &CStr, name: &CStr, buf: *mut u8, len: usize) -> isize {
        unsafe {
            libc::getxattr(path.as_ptr(), name.as_ptr(), buf.cast(), len, 0, libc::XATTR_NOFOLLOW)
        }
    }

    pub fn set(fd: RawFd, name: &CStr, value: &[u8]) {
        let _ = unsafe {
            libc::fsetxattr(fd, name.as_ptr(), value.as_ptr().cast(), value.len(), 0, 0)
        };
    }

    /// Everything the list shows.  `com.apple.decmpfs` is not listed without
    /// XATTR_SHOWCOMPRESSION, so a compressed original's layout never reaches
    /// the new file.
    pub fn wanted(_name: &[u8]) -> bool {
        true
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
mod xattr_sys {
    use std::ffi::CStr;
    use std::os::fd::RawFd;

    pub fn list(_path: &CStr, _buf: *mut u8, _len: usize) -> isize {
        -1
    }

    pub fn get(_path: &CStr, _name: &CStr, _buf: *mut u8, _len: usize) -> isize {
        -1
    }

    pub fn set(_fd: RawFd, _name: &CStr, _value: &[u8]) {}

    pub fn wanted(_name: &[u8]) -> bool {
        false
    }
}

/* ── read (spec-02 §6.1) ──────────────────────────────────────────────────── */

/// `rel` is carried only so that every error names the path the USER typed
/// rather than an absolute path from a machine they have never seen.
pub fn read_note(abs: &Path, rel: &str) -> Result<NoteRead, VaultError> {
    // One `open`, then `metadata()` on the OPEN HANDLE — one lookup, no race
    // between the size check and the read.  F15: non-blocking, and a regular
    // file is required — a FIFO substituted for an open note would otherwise
    // park this blocking worker until a writer appears, and a read that
    // returned its (empty) bytes would look like a wiped note.
    let file = OpenOptions::new().read(true).custom_flags(libc::O_NONBLOCK).open(abs);
    let mut file = file.map_err(|e| VaultError::from_io(rel, &e))?;
    let md = file.metadata().map_err(|e| VaultError::io(rel, &e))?;

    if md.is_dir() {
        return Err(VaultError::not_found(rel));
    }
    if !md.is_file() {
        return Err(VaultError::not_found(rel));
    }

    // §7.3 case 15.  Refused, with no truncated preview and no read-only
    // fallback: a truncated view the user might edit is a data-loss path, not a
    // feature.
    if md.len() > MAX_NOTE_BYTES {
        return Err(VaultError::too_large(rel, md.len(), MAX_NOTE_BYTES));
    }

    let mut raw = Vec::with_capacity(md.len() as usize);
    std::io::Read::read_to_end(&mut file, &mut raw).map_err(|e| VaultError::io(rel, &e))?;

    // A file that GREW between the stat and the read is still refused, because
    // the cap is a footprint guard and a racing writer must not be able to walk
    // through it.
    if raw.len() as u64 > MAX_NOTE_BYTES {
        return Err(VaultError::too_large(rel, raw.len() as u64, MAX_NOTE_BYTES));
    }

    let mtime_ms = mtime_ms(&md);
    let (bytes, flags) = note_frame::normalise(raw);

    // §7.3 case 14.  NEVER `from_utf8_lossy`: a lossy decode followed by an
    // autosave permanently rewrites the file.  Validate, then hand back the
    // ORIGINAL bytes — no re-encode, no copy.
    if std::str::from_utf8(&bytes).is_err() {
        return Err(VaultError::not_utf8(rel));
    }

    Ok(NoteRead { bytes, mtime_ms, flags })
}

/// The framed form command 8 returns.  §2's layout lives in `note_frame.rs` and
/// is not restated here.
pub fn read_note_framed(abs: &Path, rel: &str) -> Result<Vec<u8>, VaultError> {
    let n = read_note(abs, rel)?;
    Ok(note_frame::encode_note(n.mtime_ms, n.flags, &n.bytes))
}

/* ── write (§7.1 rule 2, all eleven steps) ────────────────────────────────── */

/// The whole of §7.1 rule 2.  `body` is the raw UTF-8 the editor holds, with no
/// BOM and LF endings; `args.flags` is what `read_note` recorded.
///
/// Records the §3.5 fingerprint into `self_writes` BEFORE returning (step 10),
/// so an event already in flight is matched.
pub fn write_note(
    abs: &Path,
    args: &WriteArgs,
    body: &[u8],
    self_writes: &Mutex<SelfWrites>,
) -> Result<WriteReceipt, VaultError> {
    let rel = args.rel.as_str();
    // Held from the conflict check through the rename and the fingerprint.
    let _serial = write_lock();
    let existing = fs::symlink_metadata(abs).ok();

    if let Some(md) = &existing {
        if md.is_dir() {
            return Err(VaultError::not_a_directory(rel));
        }
    }

    // Step 1 — the conflict check.  §7.3 case 7: an edit made in another
    // application is never silently clobbered.  `None` is the explicit
    // force-overwrite of §7.2's "Keep mine" — and the losing side is preserved
    // by the FRONTEND's `keepMine()`, which snapshots the disk bytes to a
    // `<stem>.conflict-<secs>.md` sidecar through the ordinary create/write
    // commands BEFORE issuing the force write.  No snapshot happens here:
    // `None` also arrives from flows that must leave no trace (create-then-
    // write, the dl_01 kill-child loop), and a sidecar on every one of those
    // would break G8's "exactly the user's notes".
    if let (Some(base), Some(md)) = (args.base_mtime_ms, existing.as_ref()) {
        let disk = mtime_ms(md);
        if disk != base {
            return Err(VaultError::conflict(rel, disk));
        }
    }

    // Step 1b (B17) — THE ONE THAT MAKES THE RESURRECTION BUG IMPOSSIBLE.
    // spec-02 §6.2 step 1 only raised `Conflict` when the file existed with a
    // different mtime, so a MISSING file passed the check, and step 8's rename
    // creates the destination whether or not it existed.  An autosave firing
    // after the user deleted the open note therefore recreated it.
    if !args.create && existing.is_none() {
        return Err(VaultError::not_found(rel));
    }

    // Step 1c (X16) — the other half.  With `x-create: 1`, an EXISTING
    // destination is `AlreadyExists`, not an overwrite, so neither value of the
    // header can silently destroy a file.
    if args.create && existing.is_some() {
        return Err(VaultError::already_exists(rel));
    }

    // Step 2 — denormalise in RUST (M51).  spec-02 §6.2 step 2's
    // "(Caller does this)" is STRUCK: it made §2.4's byte-exact round trip
    // depend on a frontend that has no BOM in its type at all.
    let bytes = note_frame::denormalise(body, args.flags);

    // The same cap the read path enforces (§7.3 case 15), applied to what
    // actually lands on disk.  Without it the app can create a note it will
    // then refuse to open.
    if bytes.len() as u64 > MAX_NOTE_BYTES {
        return Err(VaultError::too_large(rel, bytes.len() as u64, MAX_NOTE_BYTES));
    }

    // Step 7's input (M68): preserve an existing destination's mode, else 0o644.
    let prior_mode = existing.as_ref().map(|md| md.permissions().mode() & 0o7777);

    // What the destination must still be just before the rename (`Expect`).
    // Steps 1b and 1c have already refused the other two combinations.
    let expect = match (&existing, args.base_mtime_ms) {
        (None, _) => Expect::Absent,
        (Some(md), Some(_)) => Expect::unchanged(md),
        (Some(_), None) => Expect::Present,
    };
    let note = NoteReplace {
        rel,
        expect,
        carry_xattrs: existing.as_ref().is_some_and(|md| md.file_type().is_file()),
    };

    // Steps 3-9, plus the pre-rename fingerprint (step 9b above).
    let md = replace_file(abs, &bytes, prior_mode, Some(self_writes), Some(&note))?;

    // Step 10 — record the fingerprint BEFORE returning (§3.5).  Same values
    // step 9b already recorded (both are the temp's); this refreshes the
    // entry's 5 s GC deadline so a burst of saves keeps its suppression alive.
    crate::watcher::record_self_write(
        self_writes,
        SelfWrite::existing(abs, mtime_ns(&md), md.len()),
    );

    Ok(WriteReceipt { mtime_ms: mtime_ms(&md), size: md.len() })
}

/* ── create (spec-02 §6.3) ────────────────────────────────────────────────── */

/// The name floor this file enforces on its own, whatever the caller did.  It
/// is NOT `validate_name` (path.rs) — that is a stricter, Windows-aware policy
/// applied to creation and rename targets.  This is the subset without which
/// this file could be talked into writing outside the directory it was given,
/// and it is checked here so that the guarantee does not depend on a caller
/// remembering.
pub fn reject_path_component(name: &str) -> Result<(), VaultError> {
    if name.is_empty() {
        return Err(VaultError::invalid_name(name, "it is empty"));
    }
    if name.contains('/') {
        return Err(VaultError::invalid_name(name, "it contains '/'"));
    }
    if name.contains('\0') {
        return Err(VaultError::invalid_name(name, "it contains a NUL"));
    }
    if name == "." || name == ".." {
        return Err(VaultError::invalid_name(name, "it is a directory reference"));
    }
    Ok(())
}

const MD: &str = ".md";

/// `path::is_md` is the single declaration site for "what the tree considers a
/// note" (§3.6); this must not grow a second opinion.
fn with_md(name: &str) -> String {
    if path::is_md(name) {
        name.to_string()
    } else {
        format!("{name}{MD}")
    }
}

/// The name that will actually land on disk, checked as `path.rs`'s
/// `validate_name` (§7.3 case 11) plus this file's floor.
///
/// BOTH the typed name and the final name are checked, and that is not
/// belt-and-braces.  `validate_name` rejects a trailing space — but the user
/// types `Ideas ` and the file becomes `Ideas .md`, whose LAST character is not
/// a space, so checking only the final name lets it through.  Conversely `CON`
/// becomes `CON.md`, which is reserved on Windows "with or without an
/// extension" and which only the FINAL check catches.  Each check catches what
/// the other cannot.
fn validate_created_name(typed: &str, final_name: &str) -> Result<(), VaultError> {
    path::validate_name(typed)?;
    path::validate_name(final_name)?;
    reject_path_component(final_name)?;
    // §3.6: the scanner skips every name starting with `.`.  Creating one would
    // put a real note on disk that the tree can never show — the user writes
    // into it, it vanishes from the app, and nothing reports an error.  This is
    // the one name-level rule `validate_name` does not carry, because that
    // function is about PORTABILITY and this is about visibility.
    if final_name.starts_with('.') {
        return Err(VaultError::invalid_name(
            final_name,
            "a name cannot start with a period - the note would be hidden from the tree",
        ));
    }
    Ok(())
}

/// `symlink_metadata`, not `exists()`: a dangling symlink named `Notes.md` still
/// occupies the name, and `exists()` follows the link and reports `false`.
/// On a case-insensitive filesystem this is also, and deliberately, the
/// case-insensitive answer — it asks the filesystem the write will actually hit,
/// which is what §7.3 case 10 requires.
fn occupied(p: &Path) -> bool {
    fs::symlink_metadata(p).is_ok()
}

/// AUTO-NUMBERING HAPPENS ONLY FOR THE SYSTEM-GENERATED `Untitled` (§7.3 case
/// 10).  A user-typed name is never silently turned into `Ideas 1`: silently
/// renaming what somebody typed is how people lose track of notes.
fn first_free(parent: &Path, stem: &str, suffix: &str) -> Result<(PathBuf, String), VaultError> {
    for n in 0..10_000u32 {
        let name =
            if n == 0 { format!("{stem}{suffix}") } else { format!("{stem} {n}{suffix}") };
        let p = parent.join(&name);
        if !occupied(&p) {
            return Ok((p, name));
        }
    }
    Err(VaultError::already_exists(format!("{stem}{suffix}")))
}

/// The generated base name, matching Obsidian.
pub const UNTITLED: &str = "Untitled";

/// Returns `(abs, file_name)`.  The caller turns `file_name` into the
/// vault-relative path it hands back as `CreateResult.path`.
///
/// `name: None` generates `Untitled.md`, `Untitled 1.md`, … first free.
/// `name: Some(n)` is exact — an existing destination is `AlreadyExists`, and on
/// APFS that comparison is case-insensitive because `create_new` asks the
/// filesystem rather than a table of our own.
pub fn create_note(
    parent_abs: &Path,
    name: Option<&str>,
    self_writes: &Mutex<SelfWrites>,
) -> Result<(PathBuf, String), VaultError> {
    if !parent_abs.is_dir() {
        return Err(VaultError::not_a_directory(parent_abs.to_string_lossy()));
    }
    let (abs, file_name) = match name {
        None => first_free(parent_abs, UNTITLED, MD)?,
        Some(n) => {
            let f = with_md(n);
            validate_created_name(n, &f)?;
            (parent_abs.join(&f), f)
        }
    };

    // `create_new` makes "already exists" an OS-level guarantee, not a
    // check-then-act race.
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o644)
        .open(&abs)
        .map_err(|e| VaultError::from_io(&file_name, &e))?;

    record_existing(&abs, self_writes);
    // F73: the entry's true spelling (identity on byte-preserving systems).
    let abs = true_abs(&abs);
    let file_name = abs
        .file_name()
        .map_or_else(|| file_name.clone(), |n| n.to_string_lossy().into_owned());
    Ok((abs, file_name))
}

pub fn create_folder(
    parent_abs: &Path,
    name: Option<&str>,
    self_writes: &Mutex<SelfWrites>,
) -> Result<(PathBuf, String), VaultError> {
    if !parent_abs.is_dir() {
        return Err(VaultError::not_a_directory(parent_abs.to_string_lossy()));
    }
    let (abs, file_name) = match name {
        None => first_free(parent_abs, UNTITLED, "")?,
        Some(n) => {
            validate_created_name(n, n)?;
            (parent_abs.join(n), n.to_string())
        }
    };

    // `create_dir`, not `create_dir_all`: the parent is known to exist and
    // `_all` would silently paper over a bug — including one where the "name"
    // was really a path.
    fs::create_dir(&abs).map_err(|e| VaultError::from_io(&file_name, &e))?;

    record_existing(&abs, self_writes);
    // F73: the entry's true spelling (identity on byte-preserving systems).
    let abs = true_abs(&abs);
    let file_name = abs
        .file_name()
        .map_or_else(|| file_name.clone(), |n| n.to_string_lossy().into_owned());
    Ok((abs, file_name))
}

/// CONTRACT §3.5: a folder's `len` is whatever `metadata` reports.
fn record_existing(abs: &Path, self_writes: &Mutex<SelfWrites>) {
    if let Ok(md) = fs::symlink_metadata(abs) {
        crate::watcher::record_self_write(
            self_writes,
            SelfWrite::existing(abs, mtime_ns(&md), md.len()),
        );
    }
}

/* ── rename (spec-02 §6.4, CONTRACT §7.3 case 10) ─────────────────────────── */

/// Same file, by `dev` + `ino`.  This is how a case-only rename is told apart
/// from a genuine collision on a case-insensitive filesystem.
fn same_file(a: &Metadata, b: &Metadata) -> bool {
    a.dev() == b.dev() && a.ino() == b.ino()
}

/// `src_abs` -> `dst_abs`, both in the SAME directory (renaming does not move;
/// `move_entry` does not exist).
///
/// §7.3 case 10, the whole rule: if the destination exists AND is the same file,
/// it is a case-only rename and is performed as `old -> temp -> new` through the
/// ONE temp-name helper, restoring `old` if the second step fails.  Otherwise
/// `AlreadyExists`.
///
/// Returns the TWO fingerprints §3.5 requires — `(old_abs, 0, 0)` under the
/// delete rule and `(new_abs, post_mtime_ns, post_len)`.  spec-02 §7.4 specified
/// only the delete half; the missing half is what made the frontend's
/// create-then-rename flow flicker on every new note.
pub fn rename_entry(
    src_abs: &Path,
    dst_abs: &Path,
    self_writes: &Mutex<SelfWrites>,
) -> Result<PathBuf, VaultError> {
    let _serial = write_lock();
    rename_entry_locked(src_abs, dst_abs, self_writes)
}

/// `rename_entry`'s body.  The caller holds `WRITE_LOCK`, so no note write can
/// land between the destination check and the rename(s).  Returns the TRUE
/// destination (F73): on a normalising filesystem the entry's spelling may
/// differ from the typed one.
fn rename_entry_locked(
    src_abs: &Path,
    dst_abs: &Path,
    self_writes: &Mutex<SelfWrites>,
) -> Result<PathBuf, VaultError> {
    let src_name = src_abs.file_name().and_then(|s| s.to_str()).unwrap_or_default();
    let dst_name = dst_abs.file_name().and_then(|s| s.to_str()).unwrap_or_default();
    reject_path_component(dst_name)?;

    let src_md = fs::symlink_metadata(src_abs).map_err(|e| VaultError::from_io(src_name, &e))?;

    if src_abs == dst_abs {
        // A rename to the identical path is a no-op, not a collision.  Doing the
        // two-step dance here would open a window in which the user's note does
        // not exist under either name, for no benefit at all.
        return Ok(src_abs.to_path_buf());
    }

    if let Ok(dst_md) = fs::symlink_metadata(dst_abs) {
        if !same_file(&src_md, &dst_md) {
            return Err(VaultError::already_exists(dst_name));
        }
        // Case-only rename as `old -> tmp -> new` through the rename-only
        // helper (`.rn-` infix, leading `.` so the scanner and Obsidian ignore
        // it, same directory so both steps stay atomic).  Deliberately NOT
        // `temp_path`: that name is swept by PID on sight, and between the two
        // renames the tmp holds the SOLE copy — sweeping it is full file loss.
        // `recover_rename_tmps` completes it at the next open instead.
        let dir = dst_abs.parent().ok_or_else(|| {
            VaultError::invalid_path(dst_name, "the destination has no parent directory")
        })?;
        let tmp = rename_tmp_path(dir, dst_name);
        fs::rename(src_abs, &tmp).map_err(|e| VaultError::io(src_name, &e))?;
        if let Err(e) = fs::rename(&tmp, dst_abs) {
            // Put it back.  If even this fails the note (or the whole folder)
            // is still on disk under the rename-tmp name, which the sweep will
            // never unlink and the next open will complete into place.
            let _ = fs::rename(&tmp, src_abs);
            return Err(VaultError::io(dst_name, &e));
        }
    } else {
        fs::rename(src_abs, dst_abs).map_err(|e| VaultError::from_io(dst_name, &e))?;
    }

    crate::watcher::record_self_write(self_writes, SelfWrite::removed(src_abs));
    record_existing(dst_abs, self_writes);
    Ok(true_abs(dst_abs))
}

/// Builds the destination for a rename: same directory, new single component.
///
/// For a note, `.md` is ENSURED rather than assumed: a name that does not
/// already end in `.md` gets it appended, so `notes.txt` becomes
/// `notes.txt.md`.  This is what Obsidian does, and it makes it structurally
/// impossible for a rename to hide a note from the tree (§3.6 shows only `.md`).
///
/// DIVERGENCE FROM spec-02 §6.4, STATED: that section says "renaming a note to
/// a different extension is rejected (InvalidName)", and its stated REASON is
/// "it would vanish from the tree and confuse the user".  Ensuring `.md` serves
/// that reason exactly — nothing can vanish — while a rejection ALSO refuses
/// every legitimate name that merely contains a dot: `v1.2 plan`, `2026.Q1
/// review`, `Fig. 3 notes`.  Those are ordinary note titles, the user would get
/// `invalidName` on a name they typed deliberately, and §7.3 case 11's whole
/// point is that over-refusing is its own defect.  The invariant is kept; the
/// mechanism is the more permissive of the two that keep it.
pub fn rename_target(src_abs: &Path, new_name: &str, is_note: bool) -> Result<PathBuf, VaultError> {
    let dir = src_abs
        .parent()
        .ok_or_else(|| VaultError::invalid_name(new_name, "the source has no parent directory"))?;
    let name = if is_note { with_md(new_name) } else { new_name.to_string() };
    validate_created_name(new_name, &name)?;
    Ok(dir.join(name))
}

/* ── move (drag-to-move, Obsidian's file-explorer drop) ─────────────────────
 * `src_abs` -> `dst_dir_abs/file_name`, possibly across directories.
 * Obsidian's `attachDropHandler` moves via `fileManager.renameFile` with
 * `vault.getAvailablePath` uniquification, so a drop never fails on collision:
 * `Foo.md` becomes `Foo 1.md`, `Bar` becomes `Bar 1`. This transcribes that:
 * the destination is uniquified, never refused with `alreadyExists`.
 *
 * Returns the FINAL absolute destination (after uniquification), so the caller
 * can derive the vault-relative path it hands back. A move onto itself
 * (`src_abs == dst`) is a no-op returning `src_abs`, mirroring `rename_entry`.
 */

/// Split `Foo.md` -> (`Foo`, `.md`); `Bar` -> (`Bar`, ``). Split at the LAST
/// dot, because `v1.2 plan.md` must become `v1.2 plan 1.md`, not `v1 1.2 plan.md`.
fn split_stem_suffix(file_name: &str, is_dir: bool) -> (String, String) {
    if is_dir {
        return (file_name.to_string(), String::new());
    }
    match file_name.rfind('.') {
        Some(at) if at > 0 => (
            file_name[..at].to_string(),
            file_name[at..].to_string(),
        ),
        _ => (file_name.to_string(), String::new()),
    }
}

/// First free name in `dir`: `name`, then `stem 1+suffix`, `stem 2+suffix`, …
/// — Obsidian's `getAvailablePath`, which appends ` 1`, ` 2`, … Boundedly
/// (10,000 attempts, like `first_free`); the error names the original.
fn first_free_for_move(dir: &Path, file_name: &str, is_dir: bool) -> Result<(PathBuf, String), VaultError> {
    let (stem, suffix) = split_stem_suffix(file_name, is_dir);
    for n in 0..10_000u32 {
        let name = if n == 0 {
            file_name.to_string()
        } else {
            format!("{stem} {n}{suffix}")
        };
        let p = dir.join(&name);
        if !occupied(&p) {
            return Ok((p, name));
        }
    }
    Err(VaultError::already_exists(file_name))
}

/// Move one entry into another directory, uniquifying on collision.
/// `dst_dir_abs` must be a directory; the caller resolves it through the arena.
pub fn move_entry(
    src_abs: &Path,
    dst_dir_abs: &Path,
    is_dir: bool,
    self_writes: &Mutex<SelfWrites>,
) -> Result<PathBuf, VaultError> {
    let file_name = src_abs
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| VaultError::invalid_path(src_abs.to_string_lossy(), "the source has no name"))?;
    // The name came out of the vault, so it is already valid — but the floor
    // holds regardless of caller, exactly as `rename_entry` holds it.
    reject_path_component(file_name)?;
    if !dst_dir_abs.is_dir() {
        return Err(VaultError::not_a_directory(dst_dir_abs.to_string_lossy()));
    }
    // Before the free-name search, so the name it picks is still free when
    // the rename runs, as far as this process is concerned.
    let _serial = write_lock();
    // No-op first: the source's own name occupies itself, so the free-name
    // search below would otherwise skip it and uniquify a move that moves
    // nothing (`a.md` -> `a 1.md` in its own folder).
    if dst_dir_abs.join(file_name) == src_abs {
        return Ok(src_abs.to_path_buf());
    }
    let (dst_abs, _) = first_free_for_move(dst_dir_abs, file_name, is_dir)?;
    if dst_abs == src_abs {
        return Ok(src_abs.to_path_buf());
    }
    // `rename_entry` is the atomic move: same filesystem (one vault), same
    // self-write bookkeeping (removed + existing), same case-only dance.
    rename_entry_locked(src_abs, &dst_abs, self_writes)?;
    Ok(dst_abs)
}

/// F73: the name the directory actually holds. On a normalising filesystem
/// (HFS+) a rename or create with an accented name stores a
/// differently-spelled entry; the typed string then resolves nothing and the
/// note detaches. The inode does not lie: return the entry spelling for the
/// file just written, falling back to the given path when the directory
/// cannot be read. On a byte-preserving filesystem this is the identity.
fn true_abs(abs: &Path) -> PathBuf {
    let (Some(dir), Ok(md)) = (abs.parent(), fs::symlink_metadata(abs)) else {
        return abs.to_path_buf();
    };
    if let Ok(rd) = fs::read_dir(dir) {
        for e in rd.flatten() {
            if let Ok(m) = e.metadata() {
                if m.dev() == md.dev() && m.ino() == md.ino() {
                    return e.path();
                }
            }
        }
    }
    abs.to_path_buf()
}

/* ── delete (spec-02 §6.5) ────────────────────────────────────────────────── */

/// DEFAULT: the OS trash.  Hard delete only on explicit opt-in.
///
/// The premise of the product is that a vault is the user's plain-text notes on
/// disk.  An `unlink` on a mis-click destroys hours of writing with no undo, no
/// version history (there is none — no sync, no index, no database) and no
/// recovery path.  `~/.Trash` is restorable through Finder, costs one crate, and
/// is what Obsidian does.
///
/// Directories go to the trash WHOLE; we never enumerate and delete piecewise.
///
/// THE BACKEND IS PINNED TO `NsFileManager` — see `move_to_trash` below.
pub fn delete_entry(
    abs: &Path,
    rel: &str,
    permanent: bool,
    self_writes: &Mutex<SelfWrites>,
) -> Result<(), VaultError> {
    // A write in flight for this note finishes first; its rename can then no
    // longer re-create what this deletes.
    let _serial = write_lock();
    let md = fs::symlink_metadata(abs).map_err(|e| VaultError::from_io(rel, &e))?;

    if permanent {
        let r = if md.is_dir() { fs::remove_dir_all(abs) } else { fs::remove_file(abs) };
        r.map_err(|e| VaultError::from_io(rel, &e))?;
    } else {
        // Two commands were considered and rejected in favour of one command
        // with a `permanent` flag, because the flag makes the dangerous call
        // impossible to reach by accident from a retry loop: the UI has to ask
        // again, in different words, before it can be set.
        move_to_trash(abs).map_err(|e| VaultError::trash_unavailable(rel, e.to_string()))?;
    }

    crate::watcher::record_self_write(self_writes, SelfWrite::removed(abs));
    Ok(())
}

/// The one call that moves a user's note out of the vault, and the ONLY place
/// the trash backend is chosen.  MEASURED on macOS 26.4.1 (25E253), arm64.
///
/// `trash::delete` uses `TrashContext::default()`, and that default on macOS is
/// `DeleteMethod::Finder` — which spawns
///
/// ```text
/// osascript -e 'tell application "Finder" to delete { POSIX file "<abs>" }'
/// ```
///
/// i.e. every "Move to Trash" was an APPLE EVENT TO FINDER from a child
/// process.  Nobody chose that; it is what the crate's default happens to be.
/// This function overrides it to `NsFileManager`
/// (`-[NSFileManager trashItemAtURL:resultingItemURL:error:]`).
///
/// WHY THE OVERRIDE IS SAFE — THE PUT BACK QUESTION, SETTLED BY MEASUREMENT.
/// The Finder method's one genuine advantage is that it gives the user "Put
/// Back", which §7.3 case 3's recovery story leans on.  `trash 5.2.7`'s own
/// doc-comment claims `NsFileManager` does "not show the Put Back option on
/// some systems … This is a macOS bug", citing two issues from 2019-2020.
/// THAT CLAIM IS STALE ON THIS OS.  Measured by trashing into a throwaway APFS
/// disk image (never the user's real Trash) and reading the bookkeeping back
/// off disk: `trashItemAtURL:` itself creates `<trash>/.DS_Store` and writes
/// the two Put Back records Finder reads —
///
/// ```text
/// key "Deep.md"  ptbL ustr  "/Vault/Notes/"   (put-back location)
/// key "Deep.md"  ptbN ustr  "Deep.md"         (put-back name)
/// ```
///
/// A folder trashed whole gets the same pair.  On a NAME COLLISION the item is
/// renamed on disk (`Deep.md 02-14-01-761.md`) and the records are keyed by the
/// NEW name while `ptbN` still holds the ORIGINAL one — so Put Back restores
/// the original name to the original folder, exactly as the Finder path does.
/// The record types are byte-identical to the ones already in this machine's
/// real `~/.Trash/.DS_Store` (235 `ptbLustr` / 233 `ptbNustr` records, all
/// written by Finder's own deletes), so it is the same mechanism, not a
/// look-alike.
///
/// NsFileManager is therefore STRICTLY BETTER here — it keeps the recovery path
/// and drops every cost:
///
///   * NO APPLE EVENT, so no TCC Automation gate.  Under Finder the first
///     delete raised "Cairn wants to control Finder", and because §6.4 records
///     that this app's ad-hoc signature changes on EVERY REBUILD, that prompt
///     came back every rebuild — and a Deny turned every later delete into
///     `TrashUnavailable`.  (The probe above ran to completion with the screen
///     LOCKED and raised no prompt, which an Apple Event could not have done.)
///   * NO `NSAppleEventsUsageDescription` needed, and no such key exists.
///   * NO SUBPROCESS and NO `PATH` LOOKUP.  `Command::new("osascript")` was a
///     BARE name resolved through `PATH`, against this project's stated posture
///     that `/usr/bin/open` (command 20, `reveal_in_os`) is the ONE spawn and is
///     absolute.  That posture is now true again without an exception.
///   * No Finder trash sound, and it is the faster of the two.
///
/// RESIDUAL, STATED HONESTLY: the disk-image probe necessarily measured a
/// per-volume trash (`/Volumes/…/.Trashes/502/`), because writing to the boot
/// volume's trash means writing to the user's real `~/.Trash`, which
/// containment forbids.  The record FORMAT is confirmed shared with the real
/// home trash (the counts above), and `trashItemAtURL:` is one call that picks
/// its own destination, but a home-trash Put Back was not driven through
/// Finder's UI here.
fn move_to_trash(abs: &Path) -> Result<(), trash::Error> {
    #[cfg(target_os = "macos")]
    {
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        let mut ctx = trash::TrashContext::default();
        ctx.set_delete_method(DeleteMethod::NsFileManager);
        ctx.delete(abs)
    }

    #[cfg(not(target_os = "macos"))]
    {
        trash::delete(abs)
    }
}

/* ── reveal (command 20, X11) ─────────────────────────────────────────────── */

/// CONTRACT §1.3 command 20.  `abs` has already been resolved through the arena
/// exactly as `read_note` resolves it, so §7.3 case 13's traversal guarantee is
/// unchanged; a path that does not exist is `NotFound` BEFORE anything is
/// spawned.
///
/// No new dependency and NO `shell:*` capability: the webview cannot spawn
/// anything — Rust does, from an already-validated arena path, with a fixed
/// absolute binary and a fixed argument.
pub fn reveal_in_os(abs: &Path, rel: &str) -> Result<(), VaultError> {
    if !occupied(abs) {
        return Err(VaultError::not_found(rel));
    }

    #[cfg(target_os = "macos")]
    {
        let child = std::process::Command::new("/usr/bin/open")
            .arg("-R")
            .arg(abs)
            .spawn()
            .map_err(|e| VaultError::io(rel, &e))?;
        reap(child);
        Ok(())
    }

    // USER RULING, 2026-09-10 (CONTRACT §0.25 E59): *"Fuck this feature.  Just
    // show an error, for all.  Don't over engineer this app."*  The D-Bus
    // `org.freedesktop.FileManager1.ShowItems` arm that §0.20.2 costed is
    // CANCELLED, not deferred, so the message no longer says "in v1" — there is
    // no v2 for it to arrive in.  `main.ts`'s delete-failure dialog still offers
    // the button and still reports this through `reportError`; showing the error
    // IS the ruled behaviour, and §9 E4's objection to an affordance that does
    // nothing is answered by the ruling rather than by hiding the button.
    #[cfg(not(target_os = "macos"))]
    {
        let _ = abs;
        Err(VaultError::io(
            rel,
            &std::io::Error::other("Reveal is macOS-only"),
        ))
    }
}

/// `open -R` exits within milliseconds, but a `Child` that is never waited on is
/// a zombie for the life of the process — and this is a menu item somebody can
/// click a hundred times.  One short-lived detached thread per reveal is the
/// cheapest correct answer; `wait()` inside the command would block a tokio
/// worker, and there are only two.
#[cfg(target_os = "macos")]
fn reap(mut child: std::process::Child) {
    let _ = std::thread::Builder::new()
        .name("cairn-reveal".into())
        .spawn(move || {
            let _ = child.wait();
        });
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]
mod tests {
    use super::*;

    fn sw() -> Mutex<SelfWrites> {
        Mutex::new(SelfWrites::new())
    }

    fn args(rel: &str, flags: u32, base: Option<i64>, create: bool) -> WriteArgs {
        WriteArgs { rel: rel.into(), flags, base_mtime_ms: base, create }
    }

    /* ── the temp-name helper and the sweep (§7.1 r2 s3, §7.3 case 1, M67) ── */

    #[test]
    fn temp_names_are_hidden_pid_bearing_and_unique() {
        let dir = Path::new("/v/A");
        let a = temp_path(dir, "Misc.md");
        let b = temp_path(dir, "Misc.md");
        assert_ne!(a, b, "two temps in the same directory collided");
        for p in [&a, &b] {
            let name = p.file_name().unwrap().to_str().unwrap();
            assert!(name.starts_with('.'), "{name} is visible to the scanner and to Obsidian");
            assert_eq!(p.parent().unwrap(), dir, "the temp left the destination's directory");
            assert_eq!(parse_temp_pid(name), Some(std::process::id()), "{name}");
        }
    }

    #[test]
    fn parse_temp_pid_matches_only_our_form() {
        assert_eq!(parse_temp_pid(".Misc.md.tmp-1234-7"), Some(1234));
        assert_eq!(parse_temp_pid(".x.tmp-0-0"), Some(0));
        // Not ours:
        for n in [
            "Misc.md.tmp-1234-7", // no leading dot
            ".Misc.md.tmp-1234",  // no counter
            ".Misc.md.tmp--7",    // empty pid
            ".Misc.md.tmp-12a4-7",
            ".Misc.md.tmp-1234-x",
            ".hidden.tmp-notes",
            ".DS_Store",
            ".obsidian",
        ] {
            assert_eq!(parse_temp_pid(n), None, "{n} was treated as crash debris");
        }
        // A note whose own name contains ".tmp-" still resolves to the LAST one.
        assert_eq!(parse_temp_pid(".weird.tmp-1.md.tmp-99-1"), Some(99));
    }

    /// PID 0 must never be probed with `kill(0, 0)` — that signals our whole
    /// process group.  It is reported dead, which also makes such debris
    /// sweepable.
    #[test]
    fn pid_zero_is_never_probed_and_never_live() {
        assert!(!pid_is_live(0));
        assert!(pid_is_live(std::process::id()), "our own pid must read as live");
        // A pid that cannot exist on macOS (pid_max is 99999).
        assert!(!pid_is_live(4_000_000_000));
    }

    /// M67, the amended rule, both halves.
    #[test]
    fn sweep_unlinks_dead_pid_debris_on_sight_and_spares_live_ones() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        let dead = root.join(".Misc.md.tmp-4000000000-1");
        let live = root.join(format!(".Other.md.tmp-{}-2", std::process::id()));
        let innocent = root.join(".DS_Store");
        let note = root.join("Misc.md");
        for p in [&dead, &live, &innocent, &note] {
            fs::write(p, b"x").unwrap();
        }

        let now = SystemTime::now();
        assert!(should_sweep(&dead, now), "dead-PID debris survived");
        assert!(!should_sweep(&live, now), "a live instance's in-flight write was swept");
        assert!(!should_sweep(&innocent, now));
        assert!(!should_sweep(&note, now));

        // The one-hour rule applies ONLY to a live PID.
        assert!(should_sweep(&live, now + LIVE_PID_GRACE + Duration::from_secs(1)));

        assert_eq!(sweep_temps_in(root), 1);
        assert!(!dead.exists());
        assert!(live.exists() && innocent.exists() && note.exists());
    }

    #[test]
    fn sweep_descends_but_does_not_follow_symlinks() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("A/B")).unwrap();
        fs::write(root.join("A/B/.deep.md.tmp-4000000000-1"), b"x").unwrap();
        std::os::unix::fs::symlink("..", root.join("loop")).unwrap();
        assert_eq!(sweep_temps_in(root), 1);
        assert!(!root.join("A/B/.deep.md.tmp-4000000000-1").exists());
    }

    /* ── case-only rename intermediate (crash window) ── */

    #[test]
    fn rename_tmp_is_hidden_unsweepable_and_recoverable() {
        let dir = Path::new("/v/A");
        let p = rename_tmp_path(dir, "notes.md");
        let name = p.file_name().unwrap().to_str().unwrap();
        assert!(name.starts_with('.'), "{name} is visible");
        assert_eq!(p.parent().unwrap(), dir);
        assert_eq!(parse_temp_pid(name), None, "rename-tmp must never match the temp sweep");
        let (pid, dest) = parse_rename_tmp(name).expect("rename-tmp did not parse");
        assert_eq!(pid, std::process::id());
        assert_eq!(dest, "notes.md");
        assert_eq!(parse_rename_tmp(".notes.md.tmp-1-2"), None);
        assert_eq!(parse_rename_tmp(".DS_Store"), None);
    }

    #[test]
    fn rename_intermediate_is_never_swept_and_recovers_into_place() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        // Simulate a crash between the two renames: sole copy sits at the
        // rename-tmp name, destination missing.
        let tmp = root.join(".notes.md.rn-4000000000-0");
        fs::write(&tmp, b"body\n").unwrap();
        let now = SystemTime::now();
        assert!(!should_sweep(&tmp, now), "the sole copy is sweepable");
        assert_eq!(sweep_temps_in(root), 0, "sweep took the sole copy");
        assert!(tmp.exists(), "sweep took the sole copy");
        assert_eq!(recover_rename_tmps(root), 1);
        assert_eq!(fs::read(root.join("notes.md")).unwrap(), b"body\n");
        assert!(!tmp.exists());
    }

    #[test]
    fn rename_recovery_never_overwrites_an_existing_destination() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let tmp = root.join(".notes.md.rn-4000000000-0");
        fs::write(&tmp, b"stale\n").unwrap();
        fs::write(root.join("notes.md"), b"live\n").unwrap();
        assert_eq!(recover_rename_tmps(root), 0);
        assert_eq!(fs::read(root.join("notes.md")).unwrap(), b"live\n");
    }

    /// F6: a case-only FOLDER rename interrupted between its two renames
    /// leaves the folder hidden under the rename-tmp name. Recovery renames
    /// it back (and walks into it, so a nested intermediate completes too) —
    /// without this the folder and every note in it stay out of the tree.
    #[test]
    fn rename_recovery_completes_an_interrupted_case_only_folder_rename() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let tmp = root.join(".Creds.rn-4000000000-0");
        fs::create_dir(&tmp).unwrap();
        fs::write(tmp.join("secret.md"), b"s\n").unwrap();
        assert_eq!(recover_rename_tmps(root), 1);
        assert!(root.join("Creds").is_dir());
        assert_eq!(fs::read(root.join("Creds/secret.md")).unwrap(), b"s\n");
        assert!(!tmp.exists());
    }

    /* ── the atomic write ─────────────────────────────────────────────────── */

    /// G8: the vault is written to ONLY for notes.  After a write, the directory
    /// holds the note and nothing else.  Guarded (autosave-shaped) write, so no
    /// conflict sidecar: only Keep mine (`None`) snapshots the loser.
    #[test]
    fn g8_a_write_leaves_no_stray_files() {
        let dir = tempfile::tempdir().unwrap();
        let abs = dir.path().join("Misc.md");
        fs::write(&abs, b"old\n").unwrap();
        let base = mtime_ms(&fs::metadata(&abs).unwrap());
        let s = sw();
        write_note(&abs, &args("Misc.md", 0, Some(base), false), b"new\n", &s).unwrap();

        let names: Vec<String> = fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["Misc.md".to_string()], "stray files: {names:?}");
        assert_eq!(fs::read(&abs).unwrap(), b"new\n");
    }

    /// Step 11, via `TempGuard`: an error AFTER the temp is created must not
    /// leave it behind.  Provoked with a destination whose directory is
    /// read-only, so the rename in step 8 fails.
    #[test]
    fn a_failed_write_leaves_no_temp_behind() {
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("ro");
        fs::create_dir(&sub).unwrap();
        let abs = sub.join("Misc.md");
        fs::write(&abs, b"old\n").unwrap();
        fs::set_permissions(&sub, fs::Permissions::from_mode(0o500)).unwrap();

        let s = sw();
        let e = write_note(&abs, &args("ro/Misc.md", 0, None, false), b"new\n", &s).unwrap_err();
        assert_eq!(e.kind(), "io", "{e:?}");

        fs::set_permissions(&sub, fs::Permissions::from_mode(0o700)).unwrap();
        let strays: Vec<_> = fs::read_dir(&sub)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n != "Misc.md")
            .collect();
        assert!(strays.is_empty(), "step 11 did not run: {strays:?}");
        assert_eq!(fs::read(&abs).unwrap(), b"old\n", "the old content was damaged");
    }

    /// M68.  An overwrite preserves the destination's mode; a new file gets a
    /// flat 0o644.  Without this every save silently tightens the file to the
    /// temp's 0o600 and a vault shared over a group mount stops being readable.
    /// Guarded write so no conflict sidecar is produced.
    #[test]
    fn m68_mode_is_preserved_on_overwrite_and_flat_on_create() {
        let dir = tempfile::tempdir().unwrap();
        let abs = dir.path().join("Misc.md");
        fs::write(&abs, b"old\n").unwrap();
        fs::set_permissions(&abs, fs::Permissions::from_mode(0o640)).unwrap();

        let base = mtime_ms(&fs::metadata(&abs).unwrap());
        let s = sw();
        write_note(&abs, &args("Misc.md", 0, Some(base), false), b"new\n", &s).unwrap();
        assert_eq!(fs::metadata(&abs).unwrap().permissions().mode() & 0o777, 0o640);

        let fresh = dir.path().join("Fresh.md");
        write_note(&fresh, &args("Fresh.md", 0, None, true), b"x\n", &s).unwrap();
        assert_eq!(fs::metadata(&fresh).unwrap().permissions().mode() & 0o777, 0o644);
    }

    /// §3.5 step 10: the fingerprint is recorded BEFORE the command returns, so
    /// an event already in flight is matched.  Guarded write so no sidecar.
    #[test]
    fn the_write_records_its_own_fingerprint_before_returning() {
        let dir = tempfile::tempdir().unwrap();
        let abs = dir.path().join("Misc.md");
        fs::write(&abs, b"old\n").unwrap();
        let base = mtime_ms(&fs::metadata(&abs).unwrap());
        let s = sw();
        write_note(&abs, &args("Misc.md", 0, Some(base), false), b"new\n", &s).unwrap();
        assert!(s.lock().unwrap().matches_for(&abs), "no fingerprint was recorded");
    }

    /* ── §7.1 rule 1: the create semantics ───────────────────────────────── */

    /// B17, THE TEST.  `x-create: 0` and a missing destination is `NotFound`,
    /// never a create.  This is the assertion that makes "delete the open note,
    /// autosave resurrects it" impossible by construction.
    #[test]
    fn x_create_0_never_creates() {
        let dir = tempfile::tempdir().unwrap();
        let abs = dir.path().join("Gone.md");
        let s = sw();
        let e = write_note(&abs, &args("Gone.md", 0, None, false), b"typed\n", &s).unwrap_err();
        assert_eq!(e.kind(), "notFound");
        assert!(!abs.exists(), "an autosave resurrected a deleted note");
        // …and it is still NotFound when a base mtime is present, which is the
        // shape an autosave actually sends.
        let e = write_note(&abs, &args("Gone.md", 0, Some(123), false), b"typed\n", &s).unwrap_err();
        assert_eq!(e.kind(), "notFound");
        assert!(!abs.exists());
    }

    /// X16, step 1c.  `x-create: 1` and an EXISTING destination is
    /// `AlreadyExists`, not an overwrite — so neither value of the header can
    /// silently destroy a file.
    #[test]
    fn x_create_1_never_overwrites() {
        let dir = tempfile::tempdir().unwrap();
        let abs = dir.path().join("Taken.md");
        fs::write(&abs, b"somebody else's note\n").unwrap();
        let s = sw();
        let e = write_note(&abs, &args("Taken.md", 0, None, true), b"mine\n", &s).unwrap_err();
        assert_eq!(e.kind(), "alreadyExists");
        assert_eq!(fs::read(&abs).unwrap(), b"somebody else's note\n");
    }

    #[test]
    fn x_create_1_creates() {
        let dir = tempfile::tempdir().unwrap();
        let abs = dir.path().join("SavedAs.md");
        let s = sw();
        let r = write_note(&abs, &args("SavedAs.md", 0, None, true), b"mine\n", &s).unwrap();
        assert_eq!(fs::read(&abs).unwrap(), b"mine\n");
        assert_eq!(r.size, 5);
    }

    /* ── §7.3 case 7: the conflict guard ─────────────────────────────────── */

    #[test]
    fn case_7_a_concurrent_external_edit_is_never_clobbered() {
        let dir = tempfile::tempdir().unwrap();
        let abs = dir.path().join("Misc.md");
        fs::write(&abs, b"original\n").unwrap();
        let base = mtime_ms(&fs::metadata(&abs).unwrap());
        let s = sw();

        // Obsidian writes.  Make sure the mtime actually moves: APFS has
        // nanosecond resolution but the ms-level value is what the guard reads.
        std::thread::sleep(Duration::from_millis(20));
        fs::write(&abs, b"obsidian's version\n").unwrap();
        let disk_mtime = mtime_ms(&fs::metadata(&abs).unwrap());
        assert_ne!(disk_mtime, base, "the fixture did not actually move the mtime");

        let e = write_note(&abs, &args("Misc.md", 0, Some(base), false), b"mine\n", &s).unwrap_err();
        match e {
            VaultError::Conflict { disk_mtime_ms, .. } => assert_eq!(disk_mtime_ms, disk_mtime),
            other => panic!("expected conflict, got {other:?}"),
        }
        assert_eq!(fs::read(&abs).unwrap(), b"obsidian's version\n", "the write went through");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1, "a temp was left behind");
    }

    /// §7.2's "Keep mine": `x-base-mtime: ""` -> `None` -> force overwrite.
    /// The losing side is preserved by the FRONTEND's `keepMine()` (a
    /// `<stem>.conflict-<secs>.md` sidecar through create/write), never here:
    /// this layer must leave exactly the note behind (G8, dl_01, dl_21).
    #[test]
    fn keep_mine_forces_the_overwrite() {
        let dir = tempfile::tempdir().unwrap();
        let abs = dir.path().join("Misc.md");
        fs::write(&abs, b"theirs\n").unwrap();
        let s = sw();
        write_note(&abs, &args("Misc.md", 0, None, false), b"mine\n", &s).unwrap();
        assert_eq!(fs::read(&abs).unwrap(), b"mine\n");
        let names: Vec<String> = fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["Misc.md".to_string()], "stray files: {names:?}");
    }

    /* ── read ─────────────────────────────────────────────────────────────── */

    #[test]
    fn case_15_too_large_is_refused_at_the_cap() {
        let dir = tempfile::tempdir().unwrap();
        let abs = dir.path().join("Big.md");
        fs::write(&abs, vec![b'a'; MAX_NOTE_BYTES as usize + 1]).unwrap();
        match read_note(&abs, "Big.md") {
            Err(VaultError::TooLarge { bytes, limit, .. }) => {
                assert_eq!(bytes, MAX_NOTE_BYTES + 1);
                assert_eq!(limit, MAX_NOTE_BYTES);
            }
            other => panic!("{other:?}"),
        }
        // Exactly at the cap is fine — an off-by-one here refuses a legal note.
        fs::write(&abs, vec![b'a'; MAX_NOTE_BYTES as usize]).unwrap();
        assert!(read_note(&abs, "Big.md").is_ok());
    }

    /// T2.6 / §7.3 case 14.  `NotUtf8`, and THE FILE IS BYTE-IDENTICAL
    /// AFTERWARDS — the whole point is that we never took a lossy copy that an
    /// autosave could then write back.
    #[test]
    fn t2_6_non_utf8_is_refused_and_the_file_is_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let abs = dir.path().join("Latin1.md");
        let raw = b"caf\xE9 na\xEFve\n".to_vec();
        fs::write(&abs, &raw).unwrap();
        assert_eq!(read_note(&abs, "Latin1.md").unwrap_err().kind(), "notUtf8");
        assert_eq!(fs::read(&abs).unwrap(), raw);
    }

    #[test]
    fn a_missing_note_is_not_found_and_a_directory_is_not_a_note() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_note(&dir.path().join("nope.md"), "nope.md").unwrap_err().kind(), "notFound");
        fs::create_dir(dir.path().join("Folder")).unwrap();
        assert_eq!(read_note(&dir.path().join("Folder"), "Folder").unwrap_err().kind(), "notFound");
    }

    /* ── create ───────────────────────────────────────────────────────────── */

    #[test]
    fn untitled_is_the_only_thing_that_auto_numbers() {
        let dir = tempfile::tempdir().unwrap();
        let s = sw();
        let (_, a) = create_note(dir.path(), None, &s).unwrap();
        let (_, b) = create_note(dir.path(), None, &s).unwrap();
        let (_, c) = create_note(dir.path(), None, &s).unwrap();
        assert_eq!((a.as_str(), b.as_str(), c.as_str()), ("Untitled.md", "Untitled 1.md", "Untitled 2.md"));

        // A USER-TYPED name is never silently turned into "Ideas 1".
        create_note(dir.path(), Some("Ideas"), &s).unwrap();
        assert_eq!(create_note(dir.path(), Some("Ideas"), &s).unwrap_err().kind(), "alreadyExists");
        assert!(!dir.path().join("Ideas 1.md").exists());
    }

    #[test]
    fn create_note_appends_md_but_only_when_missing() {
        let dir = tempfile::tempdir().unwrap();
        let s = sw();
        assert_eq!(create_note(dir.path(), Some("Plain"), &s).unwrap().1, "Plain.md");
        assert_eq!(create_note(dir.path(), Some("Kept.md"), &s).unwrap().1, "Kept.md");
        assert_eq!(create_note(dir.path(), Some("Upper.MD"), &s).unwrap().1, "Upper.MD");
    }

    #[test]
    fn folders_do_not_get_md() {
        let dir = tempfile::tempdir().unwrap();
        let s = sw();
        let (abs, name) = create_folder(dir.path(), None, &s).unwrap();
        assert_eq!(name, "Untitled");
        assert!(abs.is_dir());
        assert_eq!(create_folder(dir.path(), None, &s).unwrap().1, "Untitled 1");
    }

    /// The floor this file enforces on its own, whatever the caller forgot.
    #[test]
    fn create_cannot_be_talked_out_of_its_directory() {
        let dir = tempfile::tempdir().unwrap();
        let s = sw();
        for bad in [
            "../escape", "a/b", "..", ".", "", "nul\0name",
            // §7.3 case 11, now enforced through path::validate_name:
            "CON", "nul", "trailing ", " leading", "trailing.",
            "a:b", "a*b", "a?b", "a\"b", "a<b", "a>b", "a|b", "a\\b",
            // …and the hidden-name rule, which is this file's:
            ".secret", ".DS_Store",
        ] {
            let e = create_note(dir.path(), Some(bad), &s);
            assert!(e.is_err(), "create_note accepted {bad:?}");
            let e = create_folder(dir.path(), Some(bad), &s);
            assert!(e.is_err(), "create_folder accepted {bad:?}");
        }
        assert!(!dir.path().parent().unwrap().join("escape.md").exists());
    }

    /// §7.3 case 11 reaches the create path through `path::validate_name`, and
    /// the two-sided check catches what one side alone cannot.
    #[test]
    fn case_11_portability_rules_reach_the_create_path_from_both_sides() {
        let dir = tempfile::tempdir().unwrap();
        let s = sw();
        // Only the FINAL name is reserved on Windows: "CON" -> "CON.md".
        assert_eq!(create_note(dir.path(), Some("CON"), &s).unwrap_err().kind(), "invalidName");
        // Only the TYPED name has the trailing space: "Ideas " -> "Ideas .md".
        assert_eq!(create_note(dir.path(), Some("Ideas "), &s).unwrap_err().kind(), "invalidName");
        // …and the near-misses are still allowed, because over-refusing is its
        // own bug: `CONTRACT.md` is not `CON`.
        for good in ["CONTRACT", "COMET", "NULL", "LPT10", "Ideas"] {
            create_note(dir.path(), Some(good), &s)
                .unwrap_or_else(|e| panic!("{good} was refused: {e:?}"));
        }
    }

    /// A note that the tree can never show is a note the user will believe was
    /// lost.  Renaming into one is refused for the same reason creating one is.
    #[test]
    fn a_rename_cannot_hide_a_note_or_change_its_extension() {
        let src = Path::new("/v/A/note.md");
        assert_eq!(rename_target(src, ".hidden", true).unwrap_err().kind(), "invalidName");
        // A rename can never hide a note behind another extension: `.md` is
        // ensured, not assumed (see `rename_target`).
        assert_eq!(rename_target(src, "notes.txt", true).unwrap(), Path::new("/v/A/notes.txt.md"));
        // …and an ordinary title containing a dot is NOT refused.
        assert_eq!(rename_target(src, "v1.2 plan", true).unwrap(), Path::new("/v/A/v1.2 plan.md"));
        assert_eq!(rename_target(src, "Notes.MD", true).unwrap(), Path::new("/v/A/Notes.MD"));
        // A folder has no extension rule.
        assert!(rename_target(Path::new("/v/A"), "Renamed", false).is_ok());
    }

    /* ── rename (§7.3 case 10) ───────────────────────────────────────────── */

    /// §7.3 case 10, the headline: a case-only rename NEVER destroys the file.
    /// On APFS `Notes.md` and `notes.md` are the same file, so the naive
    /// "destination exists -> refuse" is wrong and the naive "just rename" is
    /// what an implementation that unlinks the destination first would destroy.
    #[test]
    fn case_10_a_case_only_rename_keeps_the_file_and_its_content() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("notes.md");
        let dst = dir.path().join("Notes.md");
        fs::write(&src, b"important\n").unwrap();
        let s = sw();

        rename_entry(&src, &dst, &s).unwrap();

        assert_eq!(fs::read(&dst).unwrap(), b"important\n");
        let names: Vec<String> = fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names.len(), 1, "{names:?}");
        // On a case-PRESERVING filesystem the new case is what is stored.
        assert_eq!(names.first().map(String::as_str), Some("Notes.md"));
    }

    /// The other half of case 10: a name that collides with a DIFFERENT file is
    /// refused rather than silently merged.
    #[test]
    fn case_10_a_genuine_collision_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.md");
        let b = dir.path().join("b.md");
        fs::write(&a, b"a\n").unwrap();
        fs::write(&b, b"b\n").unwrap();
        let s = sw();
        assert_eq!(rename_entry(&a, &b, &s).unwrap_err().kind(), "alreadyExists");
        assert_eq!(fs::read(&a).unwrap(), b"a\n");
        assert_eq!(fs::read(&b).unwrap(), b"b\n");
    }

    /// §3.5's rename row: TWO fingerprints, not one.  The delete half alone —
    /// which is all spec-02 §7.4 specified — leaves the create half of every
    /// in-app rename echoing back as an external change.
    #[test]
    fn a_rename_records_both_fingerprints() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("old.md");
        let dst = dir.path().join("new.md");
        fs::write(&src, b"x\n").unwrap();
        let s = sw();
        rename_entry(&src, &dst, &s).unwrap();

        let mut g = s.lock().unwrap();
        assert!(g.matches(&src, 0, 0), "the delete half was not recorded");
        assert!(g.matches_for(&dst), "the create half was not recorded");
    }

    /// F73: the entry's true spelling comes from its inode, not the typed
    /// string. On a normalising filesystem (HFS+) an accented name stores
    /// differently spelled, and echoing the typed string detaches the note.
    /// On a byte-preserving filesystem this is the identity — it pins the
    /// lookup mechanism, which is the half testable here (HFS+ is not on
    /// this machine); the divergence it guards needs that filesystem.
    #[test]
    fn created_and_renamed_accented_names_resolve_by_inode() {
        use std::os::unix::fs::MetadataExt;
        let dir = tempfile::tempdir().unwrap();
        let s = sw();
        // NFC é — the spelling HFS+ would not keep.
        let (abs, name) = create_note(dir.path(), Some("caf\u{e9}.md"), &s).unwrap();
        assert_eq!(name, "caf\u{e9}.md");
        let ino = std::fs::metadata(&abs).unwrap().ino();
        assert_eq!(std::fs::metadata(dir.path().join(&name)).unwrap().ino(), ino);
        let dst = rename_target(&abs, "cr\u{e8}me", true).unwrap();
        let final_abs = rename_entry(&abs, &dst, &s).unwrap();
        assert_eq!(final_abs.file_name().unwrap(), "cr\u{e8}me.md");
        assert_eq!(std::fs::metadata(&final_abs).unwrap().ino(), ino);
        // And the typed spelling is gone: exactly one entry holds the inode.
        let hits: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .filter(|e| e.metadata().is_ok_and(|m| m.ino() == ino))
            .collect();
        assert_eq!(hits.len(), 1);
    }

    #[test]
    fn rename_target_keeps_the_extension_honest() {
        let src = Path::new("/v/A/note.md");
        assert_eq!(rename_target(src, "Renamed", true).unwrap(), Path::new("/v/A/Renamed.md"));
        assert_eq!(rename_target(src, "Renamed.md", true).unwrap(), Path::new("/v/A/Renamed.md"));
        // A folder keeps exactly what was typed.
        assert_eq!(rename_target(Path::new("/v/A"), "B", false).unwrap(), Path::new("/v/B"));
        // Renaming does not move.
        assert!(rename_target(src, "../elsewhere", true).is_err());
        assert!(rename_target(src, "sub/deeper", true).is_err());
    }

    #[test]
    fn renaming_to_the_same_path_is_a_no_op_not_a_collision() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.md");
        fs::write(&p, b"x\n").unwrap();
        let s = sw();
        rename_entry(&p, &p, &s).unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"x\n");
    }

    /* ── delete ───────────────────────────────────────────────────────────── */

    #[test]
    fn permanent_delete_removes_a_file_and_a_whole_folder() {
        let dir = tempfile::tempdir().unwrap();
        let s = sw();
        let f = dir.path().join("a.md");
        fs::write(&f, b"x").unwrap();
        delete_entry(&f, "a.md", true, &s).unwrap();
        assert!(!f.exists());

        let d = dir.path().join("A/B");
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join("n.md"), b"x").unwrap();
        delete_entry(&dir.path().join("A"), "A", true, &s).unwrap();
        assert!(!dir.path().join("A").exists());
    }

    #[test]
    fn deleting_something_that_is_gone_is_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let s = sw();
        assert_eq!(
            delete_entry(&dir.path().join("nope.md"), "nope.md", true, &s).unwrap_err().kind(),
            "notFound"
        );
    }

    #[test]
    fn a_delete_records_the_zero_zero_fingerprint() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("a.md");
        fs::write(&f, b"x").unwrap();
        let s = sw();
        delete_entry(&f, "a.md", true, &s).unwrap();
        assert!(s.lock().unwrap().matches(&f, 0, 0));
    }

    /* ── move (drag-to-move, Obsidian's `getAvailablePath` uniquification) ── */

    #[test]
    fn move_into_a_folder_lands_inside_it() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir(root.join("F")).unwrap();
        let src = root.join("a.md");
        fs::write(&src, b"x").unwrap();
        let s = sw();
        let dst = move_entry(&src, &root.join("F"), false, &s).unwrap();
        assert_eq!(dst, root.join("F/a.md"));
        assert!(!src.exists());
        assert_eq!(fs::read(&dst).unwrap(), b"x");
    }

    #[test]
    fn move_uniquifies_like_obsidian_instead_of_refusing() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir(root.join("F")).unwrap();
        fs::write(root.join("a.md"), b"root").unwrap();
        let src = root.join("F/a.md");
        fs::write(&src, b"inner").unwrap();
        let s = sw();
        // Root holds `a.md`: the move becomes `a 1.md`, not `alreadyExists`.
        let dst = move_entry(&src, root, false, &s).unwrap();
        assert_eq!(dst, root.join("a 1.md"));
        assert_eq!(fs::read(&dst).unwrap(), b"inner");
        // Folders uniquify without an extension split: `F` -> `F 1`.
        let fsrc = root.join("F");
        let fdst = move_entry(&fsrc, root, true, &s).unwrap();
        // Root has no `F` any more (it just moved), so this is exact…
        assert_eq!(fdst, root.join("F"));
        // …but a second folder colliding does number.
        fs::create_dir(root.join("G")).unwrap();
        fs::create_dir(root.join("G/F")).unwrap();
        let fdst2 = move_entry(&root.join("G/F"), root, true, &s).unwrap();
        assert_eq!(fdst2, root.join("F 1"));
    }

    #[test]
    fn move_onto_itself_is_a_no_op() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let p = root.join("a.md");
        fs::write(&p, b"x\n").unwrap();
        let s = sw();
        let dst = move_entry(&p, root, false, &s).unwrap();
        assert_eq!(dst, p);
        assert_eq!(fs::read(&p).unwrap(), b"x\n");
    }

    /* ── reveal ───────────────────────────────────────────────────────────── */

    /// A non-existent path is `notFound` BEFORE anything is spawned.  The
    /// success path is not exercised here: it opens Finder on the machine
    /// running the tests, which is exactly the window etiquette this project
    /// takes seriously.
    #[test]
    fn reveal_refuses_a_missing_path_without_spawning() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            reveal_in_os(&dir.path().join("nope.md"), "nope.md").unwrap_err().kind(),
            "notFound"
        );
    }
}

/* ── the write guard, long names, folder recovery, xattrs ─────────────────── */

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]
mod write_guard_tests {
    use super::*;
    use std::sync::Arc;

    fn sw() -> Mutex<SelfWrites> {
        Mutex::new(SelfWrites::new())
    }

    fn args(rel: &str, base: Option<i64>, create: bool) -> WriteArgs {
        WriteArgs { rel: rel.into(), flags: 0, base_mtime_ms: base, create }
    }

    fn before_recheck(f: impl FnOnce(&Path) + 'static) {
        BEFORE_RECHECK.with(|s| *s.borrow_mut() = Some(Box::new(f)));
    }

    fn after_rename(f: impl FnOnce(&Path) + 'static) {
        AFTER_RENAME.with(|s| *s.borrow_mut() = Some(Box::new(f)));
    }

    fn set_mtime(p: &Path, t: SystemTime) {
        File::options().write(true).open(p).unwrap().set_modified(t).unwrap();
    }

    fn seed(dir: &Path, name: &str, body: &[u8]) -> (PathBuf, i64) {
        let abs = dir.join(name);
        fs::write(&abs, body).unwrap();
        (abs.clone(), mtime_ms(&fs::metadata(&abs).unwrap()))
    }

    fn dot_entries(dir: &Path) -> Vec<String> {
        fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with('.'))
            .collect()
    }

    /* ── an outside save between the conflict check and the rename ── */

    /// Another program writes the note IN PLACE while our temp is being
    /// written: the save is refused as a conflict and their bytes survive.
    #[test]
    fn an_in_place_outside_write_during_the_save_is_a_conflict() {
        let dir = tempfile::tempdir().unwrap();
        let (abs, base) = seed(dir.path(), "Misc.md", b"original\n");
        before_recheck(|abs| {
            fs::write(abs, b"their edit, longer\n").unwrap();
            set_mtime(abs, SystemTime::now() + Duration::from_secs(3600));
        });
        let e = write_note(&abs, &args("Misc.md", Some(base), false), b"mine\n", &sw()).unwrap_err();
        assert_eq!(e.kind(), "conflict", "{e:?}");
        assert_eq!(fs::read(&abs).unwrap(), b"their edit, longer\n", "the outside edit was overwritten");
        assert!(dot_entries(dir.path()).is_empty(), "{:?}", dot_entries(dir.path()));
    }

    /// A sync client's temp+rename replace with the SAME length and the SAME
    /// mtime: only the inode tells it apart, and it must still be a conflict.
    #[test]
    fn a_rename_over_during_the_save_is_a_conflict_even_with_equal_mtime_and_len() {
        let dir = tempfile::tempdir().unwrap();
        let (abs, base) = seed(dir.path(), "Misc.md", b"original\n");
        let old_mtime = fs::metadata(&abs).unwrap().modified().unwrap();
        before_recheck(move |abs| {
            let theirs = abs.with_file_name(".syncthing.Misc.md.tmp");
            fs::write(&theirs, b"REMOTE!!\n").unwrap();
            set_mtime(&theirs, old_mtime);
            fs::rename(&theirs, abs).unwrap();
        });
        let e = write_note(&abs, &args("Misc.md", Some(base), false), b"mine\n", &sw()).unwrap_err();
        assert_eq!(e.kind(), "conflict", "{e:?}");
        assert_eq!(fs::read(&abs).unwrap(), b"REMOTE!!\n");
        assert!(dot_entries(dir.path()).is_empty(), "{:?}", dot_entries(dir.path()));
    }

    /// Deleted by another program mid-save: the save must not re-create it,
    /// guarded or forced (§7.1 rule 1).
    #[test]
    fn a_note_deleted_during_the_save_is_not_recreated() {
        for base in [true, false] {
            let dir = tempfile::tempdir().unwrap();
            let (abs, m) = seed(dir.path(), "Misc.md", b"original\n");
            before_recheck(|abs| fs::remove_file(abs).unwrap());
            let e = write_note(&abs, &args("Misc.md", base.then_some(m), false), b"mine\n", &sw())
                .unwrap_err();
            assert_eq!(e.kind(), "notFound", "base={base} {e:?}");
            assert!(!abs.exists(), "base={base}: the save resurrected a deleted note");
            assert!(dot_entries(dir.path()).is_empty());
        }
    }

    /// Save-As (`x-create: 1`) never replaces a file that appeared mid-save.
    #[test]
    fn save_as_does_not_replace_a_file_that_appeared_during_the_save() {
        let dir = tempfile::tempdir().unwrap();
        let abs = dir.path().join("New.md");
        before_recheck(|abs| fs::write(abs, b"somebody else's\n").unwrap());
        let e = write_note(&abs, &args("New.md", None, true), b"mine\n", &sw()).unwrap_err();
        assert_eq!(e.kind(), "alreadyExists", "{e:?}");
        assert_eq!(fs::read(&abs).unwrap(), b"somebody else's\n");
    }

    /// "Keep mine" stays a force write: an outside change is overwritten.
    #[test]
    fn keep_mine_still_overwrites_an_outside_change() {
        let dir = tempfile::tempdir().unwrap();
        let (abs, _) = seed(dir.path(), "Misc.md", b"original\n");
        before_recheck(|abs| fs::write(abs, b"theirs, again\n").unwrap());
        write_note(&abs, &args("Misc.md", None, false), b"mine\n", &sw()).unwrap();
        assert_eq!(fs::read(&abs).unwrap(), b"mine\n");
    }

    /* ── the receipt names our bytes, not whatever is at the path later ── */

    #[test]
    fn the_receipt_names_our_write_not_a_replacement_that_landed_after_the_rename() {
        let dir = tempfile::tempdir().unwrap();
        let (abs, base) = seed(dir.path(), "Misc.md", b"original\n");
        let past = SystemTime::now() - Duration::from_secs(3600);
        after_rename(move |abs| {
            let theirs = abs.with_file_name(".syncthing.Misc.md.tmp");
            fs::write(&theirs, b"REMOTE EDIT, a different length\n").unwrap();
            set_mtime(&theirs, past);
            fs::rename(&theirs, abs).unwrap();
        });
        let s = sw();
        let r = write_note(&abs, &args("Misc.md", Some(base), false), b"mine\n", &s).unwrap();
        let theirs = fs::metadata(&abs).unwrap();
        assert_eq!(r.size, 5, "the receipt describes the replacement");
        assert_ne!(r.mtime_ms, mtime_ms(&theirs), "the receipt describes the replacement");
        assert!(!s.lock().unwrap().matches_for(&abs), "the replacement is suppressed as our echo");

        // The editor's next autosave uses the receipt as its base: refused.
        let e = write_note(&abs, &args("Misc.md", Some(r.mtime_ms), false), b"mine 2\n", &s)
            .unwrap_err();
        assert_eq!(e.kind(), "conflict", "{e:?}");
        assert_eq!(fs::read(&abs).unwrap(), b"REMOTE EDIT, a different length\n");
    }

    /* ── Cairn's own mutations do not interleave with a write ── */

    /// A rename issued while a save is between its check and its rename waits
    /// for the save, then moves the NEWEST bytes.  Interleaved, the save's
    /// rename re-creates the old name and the renamed note keeps stale text.
    #[test]
    fn a_rename_during_a_save_waits_and_carries_the_newest_text() {
        let dir = tempfile::tempdir().unwrap();
        let (abs, base) = seed(dir.path(), "Untitled.md", b"stale\n");
        let s = Arc::new(sw());
        let renamed = dir.path().join("My title.md");
        let handle = Arc::new(Mutex::new(None));
        let (s2, renamed2, handle2) = (Arc::clone(&s), renamed.clone(), Arc::clone(&handle));
        before_recheck(move |abs| {
            let src = abs.to_path_buf();
            let h = std::thread::spawn(move || rename_entry(&src, &renamed2, &s2));
            std::thread::sleep(Duration::from_millis(200));
            *handle2.lock().unwrap() = Some((h.is_finished(), h));
        });
        write_note(&abs, &args("Untitled.md", Some(base), false), b"newest\n", &s).unwrap();
        let (ran_early, h) = handle.lock().unwrap().take().unwrap();
        h.join().unwrap().unwrap();
        assert!(!ran_early, "the rename ran between the save's check and its rename");
        assert!(!abs.exists(), "the save re-created the old name");
        assert_eq!(fs::read(&renamed).unwrap(), b"newest\n");
    }

    /// Same for a delete: it waits, and the save cannot resurrect the note.
    #[test]
    fn a_delete_during_a_save_waits_and_the_note_stays_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let (abs, base) = seed(dir.path(), "Misc.md", b"old\n");
        let s = Arc::new(sw());
        let handle = Arc::new(Mutex::new(None));
        let (s2, handle2) = (Arc::clone(&s), Arc::clone(&handle));
        before_recheck(move |abs| {
            let p = abs.to_path_buf();
            let h = std::thread::spawn(move || delete_entry(&p, "Misc.md", true, &s2));
            std::thread::sleep(Duration::from_millis(200));
            *handle2.lock().unwrap() = Some((h.is_finished(), h));
        });
        write_note(&abs, &args("Misc.md", Some(base), false), b"new\n", &s).unwrap();
        let (ran_early, h) = handle.lock().unwrap().take().unwrap();
        h.join().unwrap().unwrap();
        assert!(!ran_early, "the delete ran between the save's check and its rename");
        assert!(!abs.exists(), "the save resurrected a deleted note");
        assert!(dot_entries(dir.path()).is_empty());
    }

    /* ── a note named near the 255-byte limit is still saveable ── */

    #[test]
    fn a_255_byte_note_name_saves_and_leaves_no_temp() {
        for name in [format!("{}.md", "a".repeat(252)), format!("{}.md", "日".repeat(84))] {
            assert_eq!(name.len(), 255);
            path::validate_name(&name).unwrap();
            let dir = tempfile::tempdir().unwrap();
            let s = sw();
            let (abs, _) = create_note(dir.path(), Some(&name), &s).unwrap();
            for (i, grow) in [0u64, 0, 1_000_000_000_000].into_iter().enumerate() {
                // A counter with more digits must not push the temp name over.
                TEMP_COUNTER.fetch_add(grow, Ordering::Relaxed);
                let body = format!("save {i}\n");
                write_note(&abs, &args(&name, None, false), body.as_bytes(), &s)
                    .unwrap_or_else(|e| panic!("save {i} of a 255-byte name failed: {e:?}"));
                assert_eq!(fs::read(&abs).unwrap(), body.as_bytes());
            }
            let tmp = temp_path(dir.path(), &name);
            let tname = tmp.file_name().unwrap().to_str().unwrap();
            assert!(tname.len() <= NAME_MAX, "{} bytes", tname.len());
            assert!(tname.starts_with('.'));
            assert_eq!(parse_temp_pid(tname), Some(std::process::id()));
            assert!(dot_entries(dir.path()).is_empty(), "{:?}", dot_entries(dir.path()));
        }
    }

    /* ── an interrupted case-only FOLDER rename is recovered ── */

    #[test]
    fn a_folder_rename_intermediate_recovers_into_place() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let tmp = root.join(".Work.rn-4000000000-0");
        fs::create_dir_all(tmp.join("sub")).unwrap();
        fs::write(tmp.join("plan.md"), b"important\n").unwrap();
        fs::write(tmp.join("sub/deep.md"), b"deep\n").unwrap();
        assert_eq!(recover_rename_tmps(root), 1);
        assert_eq!(fs::read(root.join("Work/plan.md")).unwrap(), b"important\n");
        assert_eq!(fs::read(root.join("Work/sub/deep.md")).unwrap(), b"deep\n");
        assert!(!tmp.exists());
    }

    /// The recovered folder is walked, so an intermediate inside it is
    /// recovered too.
    #[test]
    fn a_nested_intermediate_inside_a_recovered_folder_is_recovered() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let tmp = root.join(".Work.rn-4000000000-0");
        fs::create_dir(&tmp).unwrap();
        fs::write(tmp.join(".x.md.rn-4000000000-1"), b"x\n").unwrap();
        assert_eq!(recover_rename_tmps(root), 2);
        assert_eq!(fs::read(root.join("Work/x.md")).unwrap(), b"x\n");
    }

    /// rename(2) would silently replace an EMPTY directory: an occupied
    /// destination leaves both folders exactly as they are.
    #[test]
    fn folder_recovery_never_replaces_an_existing_folder() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let tmp = root.join(".Work.rn-4000000000-0");
        fs::create_dir(&tmp).unwrap();
        fs::write(tmp.join("plan.md"), b"important\n").unwrap();
        fs::create_dir(root.join("Work")).unwrap();
        assert_eq!(recover_rename_tmps(root), 0);
        assert_eq!(fs::read(tmp.join("plan.md")).unwrap(), b"important\n");
        assert!(root.join("Work").is_dir());
        assert_eq!(fs::read_dir(root.join("Work")).unwrap().count(), 0);
    }

    /* ── extended attributes survive a save; timestamps are not carried ── */

    fn cstr(s: &[u8]) -> CString {
        CString::new(s).unwrap()
    }

    fn set_xattr(p: &Path, name: &str, value: &[u8]) -> std::io::Result<()> {
        let (p, n) = (cstr(p.as_os_str().as_bytes()), cstr(name.as_bytes()));
        #[cfg(target_os = "linux")]
        let rc = unsafe { libc::setxattr(p.as_ptr(), n.as_ptr(), value.as_ptr().cast(), value.len(), 0) };
        #[cfg(target_os = "macos")]
        let rc =
            unsafe { libc::setxattr(p.as_ptr(), n.as_ptr(), value.as_ptr().cast(), value.len(), 0, 0) };
        if rc == 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        }
    }

    fn get_xattr(p: &Path, name: &str) -> Option<Vec<u8>> {
        let (p, n) = (cstr(p.as_os_str().as_bytes()), cstr(name.as_bytes()));
        let mut buf = vec![0u8; 4096];
        #[cfg(target_os = "linux")]
        let got = unsafe { libc::getxattr(p.as_ptr(), n.as_ptr(), buf.as_mut_ptr().cast(), buf.len()) };
        #[cfg(target_os = "macos")]
        let got = unsafe {
            libc::getxattr(p.as_ptr(), n.as_ptr(), buf.as_mut_ptr().cast(), buf.len(), 0, 0)
        };
        let got = usize::try_from(got).ok()?;
        buf.truncate(got);
        Some(buf)
    }

    #[test]
    fn a_user_xattr_survives_a_save_and_the_mtime_still_moves() {
        let dir = tempfile::tempdir().unwrap();
        let (abs, _) = seed(dir.path(), "Tagged.md", b"original\n");
        set_mtime(&abs, SystemTime::now() - Duration::from_secs(3600));
        let base = mtime_ms(&fs::metadata(&abs).unwrap());
        if let Err(e) = set_xattr(&abs, "user.cairn.tag", b"Red") {
            eprintln!("SKIP: this filesystem refuses user xattrs: {e}");
            return;
        }
        let r = write_note(&abs, &args("Tagged.md", Some(base), false), b"edited\n", &sw()).unwrap();
        assert_eq!(fs::read(&abs).unwrap(), b"edited\n");
        assert_eq!(
            get_xattr(&abs, "user.cairn.tag").as_deref(),
            Some(&b"Red"[..]),
            "the xattr was dropped"
        );
        let now = mtime_ms(&fs::metadata(&abs).unwrap());
        assert_ne!(now, base, "the old mtime was carried onto the new bytes");
        assert_eq!(r.mtime_ms, now);
    }

    /// Linux: the POSIX access ACL is the `system.posix_acl_access` xattr.
    /// Dropping it also widens the owning group to the ACL mask.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_posix_acl_survives_a_save() {
        let dir = tempfile::tempdir().unwrap();
        let (abs, base) = seed(dir.path(), "Shared.md", b"original\n");
        fs::set_permissions(&abs, fs::Permissions::from_mode(0o640)).unwrap();
        // Version 2, then (tag, perm, id): USER_OBJ rw, USER nobody r,
        // GROUP_OBJ r, MASK rw, OTHER none.
        let mut blob = 2u32.to_le_bytes().to_vec();
        for (tag, perm, id) in [
            (0x01u16, 6u16, u32::MAX),
            (0x02, 4, 65534),
            (0x04, 4, u32::MAX),
            (0x10, 6, u32::MAX),
            (0x20, 0, u32::MAX),
        ] {
            blob.extend(tag.to_le_bytes());
            blob.extend(perm.to_le_bytes());
            blob.extend(id.to_le_bytes());
        }
        if let Err(e) = set_xattr(&abs, "system.posix_acl_access", &blob) {
            eprintln!("SKIP: this filesystem refuses POSIX ACLs: {e}");
            return;
        }
        let before_acl = get_xattr(&abs, "system.posix_acl_access").unwrap();
        let before_mode = fs::metadata(&abs).unwrap().permissions().mode() & 0o7777;
        write_note(&abs, &args("Shared.md", Some(base), false), b"edited\n", &sw()).unwrap();
        assert_eq!(
            get_xattr(&abs, "system.posix_acl_access").as_deref(),
            Some(&before_acl[..]),
            "the ACL was dropped"
        );
        assert_eq!(fs::metadata(&abs).unwrap().permissions().mode() & 0o7777, before_mode);
    }
}
