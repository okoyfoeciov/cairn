//! core/src/watcher.rs — Owner: 02.
//! Spec: CONTRACT.md §3.5 (refresh, echo suppression and self-inflicted events,
//! M26/M39), §1.4 (the event table), §7.3 case 8 (`nc://vault-lost`, M57),
//! §7.3 case 16 (watcher exhaustion), spec-02 §7.1-7.5.
//!
//! ONE EVENT, ONE PAYLOAD (M39): `nc://tree-changed { epoch }`, 150 ms debounce,
//! <= 750 ms of accumulation.  `dirs` and `total` are STRUCK.
//!
//! ECHO SUPPRESSION IS BY EXACT `(abs, mtime_ns, len)` FINGERPRINT (M26).
//! spec-04 §10.4's "500 ms TTL touched-paths set" is STRUCK: a TTL suppresses
//! whatever happens to arrive inside the window, including a real external edit
//! the user is about to lose.  A fingerprint suppresses exactly the write we
//! made and nothing else.
//!
//! THE UNIT OF REPAIR IS A DIRECTORY, NEVER A FILE.  Rename events are the least
//! reliable part of every notification API — FSEvents coalesces and frequently
//! gives `Modify(Name(Any))` with one path and no partner — so nothing here
//! tries to reconstruct a rename pair.  Re-reading the containing directory is
//! ~30 us and is correct for every event kind, including ones nobody has seen.
//!
//! WHAT THIS MODULE DOES NOT DO, DELIBERATELY: it does not touch the arena, it
//! does not hold the vault lock, it does not know what an epoch is and it never
//! emits.  It hands the owner of the vault a `Flush` and lets
//! that owner rescan, bump the one epoch counter in the process and emit.  That
//! is what makes the debounce, the classification and the echo suppression
//! testable without a window, and it is why every rule below has a test.

#![deny(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]

use std::path::{Path, PathBuf};
#[cfg(test)]
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use notify::{Event, EventKind, RecursiveMode, Watcher};

/// spec-02 §7.2.  This is the 150 ms / 750 ms envelope CONTRACT §1.4 states for
/// `nc://tree-changed`.
pub const DEBOUNCE: Duration = Duration::from_millis(150);
/// spec-02 §7.2.  A long `git checkout` produces periodic updates instead of one
/// silent stall.
pub const MAX_ACCUM: Duration = Duration::from_millis(750);
/// spec-02 §7.2.  Beyond this, one full rescan is cheaper than N directory
/// rescans.
pub const MAX_DIRTY: usize = 512;
/// CONTRACT §3.5: the fingerprint list is capped at 8 and scanned linearly.
pub const SELF_WRITE_CAP: usize = 8;
/// CONTRACT §3.5: garbage collection ONLY.  It is never the reason an event is
/// dropped, and no code below reads it while matching.  An expired entry is
/// collected only once the file on disk no longer carries its fingerprint.
pub const SELF_WRITE_TTL: Duration = Duration::from_secs(5);
/// How often the coalescing loop re-checks that the root is still the
/// directory it started watching (§7.3 case 8).  One `lstat` per interval, on
/// a thread that already wakes every `DEBOUNCE`.
pub const ROOT_CHECK: Duration = Duration::from_millis(500);

/* ── the fingerprint ──────────────────────────────────────────────────────── */

/// CONTRACT §3.5, verbatim.  Recorded from POST-OPERATION metadata, before the
/// command returns, so an event already in flight is matched.
#[derive(Debug, Clone)]
pub struct SelfWrite {
    pub abs: PathBuf,
    pub mtime_ns: u128,
    pub len: u64,
    pub deadline: Instant,
}

impl SelfWrite {
    /// The fingerprint of a path that now EXISTS, taken from its post-operation
    /// metadata.  `write_note`, `create_note`, `create_folder` and the second
    /// half of `rename_entry` all use this.
    pub fn existing(abs: impl Into<PathBuf>, mtime_ns: u128, len: u64) -> Self {
        Self { abs: abs.into(), mtime_ns, len, deadline: Instant::now() + SELF_WRITE_TTL }
    }

    /// CONTRACT §3.5's delete rule: `(abs, 0, 0)`, which matches only when the
    /// path no longer exists.  `delete_entry` and the FIRST half of
    /// `rename_entry` use this — the half spec-02 §7.4 specified alone.
    pub fn removed(abs: impl Into<PathBuf>) -> Self {
        Self::existing(abs, 0, 0)
    }

    fn same_write(&self, other: &SelfWrite) -> bool {
        self.abs == other.abs && self.mtime_ns == other.mtime_ns && self.len == other.len
    }

    /// Whether the path still carries this fingerprint, by the same rule
    /// `matches_for` applies.  While it does, a late event for it is still ours.
    fn still_on_disk(&self) -> bool {
        match std::fs::symlink_metadata(&self.abs) {
            Ok(md) => crate::fsops::mtime_ns(&md) == self.mtime_ns && md.len() == self.len,
            Err(_) => self.mtime_ns == 0 && self.len == 0,
        }
    }
}

/// The capped, linearly-scanned ring of §3.5.  Eight entries do not justify a
/// map, and a map would make "remove the one that matched" the awkward case.
#[derive(Debug, Default)]
pub struct SelfWrites {
    entries: Vec<SelfWrite>,
}

impl SelfWrites {
    pub fn new() -> Self {
        Self { entries: Vec::with_capacity(SELF_WRITE_CAP) }
    }

    /// Records one fingerprint, dropping the OLDEST if the cap is reached.
    /// Expired entries are collected here and only here — `deadline` is never
    /// consulted while matching — and only once the disk has moved on from
    /// them: a sync client's xattr or a chmod can arrive long after the save.
    /// Recording a fingerprint already held refreshes that entry rather than
    /// spending a second slot (`fsops` records each write twice).
    pub fn record(&mut self, sw: SelfWrite) {
        let now = Instant::now();
        self.entries.retain(|e| (e.deadline > now || e.still_on_disk()) && !e.same_write(&sw));
        while self.entries.len() >= SELF_WRITE_CAP {
            self.entries.remove(0);
        }
        self.entries.push(sw);
    }

    /// Exact match on `(abs, mtime_ns, len)`.  The fingerprint is the ONLY
    /// matching rule; `deadline` is not read here, it only bounds how long the
    /// entry lives.
    ///
    /// ===================================================================
    /// CONTRACT §3.5 SAYS "REMOVED ON MATCH".  MEASUREMENT SAYS OTHERWISE, AND
    /// THE MEASUREMENT WINS.
    ///
    /// One `fs::write` of one note produces FOUR FSEvents on macOS 26.4/APFS,
    /// all four carrying the identical `(path, mtime_ns, len)`:
    ///
    /// ```text
    /// Create(File)
    /// Modify(Metadata(Any))
    /// Modify(Metadata(Extended))
    /// Modify(Data(Content))
    /// ```
    ///
    /// So an entry removed by the first of those cannot suppress the other
    /// three, and EVERY SAVE echoes back — a full tree rebuild per autosave and,
    /// on the open note, a bogus `nc://note-external-change` that §7.3 case 7
    /// turns into a conflict bar the user did nothing to earn.  Remove-on-match
    /// does not merely leak an echo occasionally; it leaks one every time.
    ///
    /// §3.5's stated REASON for removing — "so a second, genuine write to the
    /// same path with the same size is not also swallowed" — is preserved
    /// exactly, by the nanosecond mtime that the same paragraph chose the
    /// fingerprint for: a genuinely later write cannot reproduce `mtime_ns`, so
    /// it does not match, so it is not swallowed. What is dropped is only the
    /// REMOVAL; entries now live until `record`'s GC collects them (see
    /// `SELF_WRITE_TTL`).  `matching_survives_the_
    /// event_burst` and `a_genuine_later_write_is_not_swallowed` below hold both
    /// halves.
    /// ===================================================================
    pub fn matches(&mut self, abs: &Path, mtime_ns: u128, len: u64) -> bool {
        self.entries.iter().any(|e| e.abs == abs && e.mtime_ns == mtime_ns && e.len == len)
    }

    /// Stats the path and matches whichever rule applies: an existing path by
    /// its post-operation metadata, a vanished path by `(abs, 0, 0)`.
    ///
    /// The stat is the one spec-02 §7.3 already pays for, which is why M69's
    /// unconditional `Node.mtime` update is free.
    pub fn matches_for(&mut self, abs: &Path) -> bool {
        match std::fs::symlink_metadata(abs) {
            Ok(md) => self.matches(abs, crate::fsops::mtime_ns(&md), md.len()),
            Err(_) => self.matches(abs, 0, 0),
        }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

/* ── what the watcher hands upstream ──────────────────────────────────────── */

/// A content change to one `.md` file that survived echo suppression.  Carries
/// the stat the suppression check already performed, so the caller's
/// unconditional `Node.mtime` update (M69) costs no second syscall.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContentHit {
    pub abs: PathBuf,
    pub mtime_ms: i64,
    pub len: u64,
}

/// One debounced batch.  The caller rescans `dirs` (or everything, if
/// `full_rescan`), applies `content_hits` to `Node.mtime` unconditionally (M69),
/// bumps the ONE epoch counter and emits ONE `nc://tree-changed { epoch }`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Flush {
    pub dirs: Vec<PathBuf>,
    pub content_hits: Vec<ContentHit>,
    pub full_rescan: bool,
}

impl Flush {
    pub fn is_empty(&self) -> bool {
        self.dirs.is_empty() && self.content_hits.is_empty() && !self.full_rescan
    }
}

/// CONTRACT §7.3 case 16 / §1.4: the two reasons, and they are the wire values.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DegradeReason {
    WatchLimit,
    WatchError,
}

impl DegradeReason {
    pub fn as_str(self) -> &'static str {
        match self {
            DegradeReason::WatchLimit => "watch-limit",
            DegradeReason::WatchError => "watch-error",
        }
    }
}

/// Everything the watcher thread can tell the vault owner.  Each maps to
/// exactly one §1.4 event, and the mapping is the caller's job — this module
/// never emits.
#[derive(Debug, Clone)]
pub enum WatchEvent {
    /// -> rescan, bump the epoch, emit `nc://tree-changed { epoch }`, and emit
    /// `nc://note-external-change` for the ONE content hit whose path is the
    /// open note (spec-02 §7.5's filter: without it a `git checkout` touching
    /// 800 files emits 800 events for information the UI discards).
    Flush(Flush),
    /// -> `nc://vault-lost { path }`.  Drop the vault; do NOT rescan (§7.3 case 8).
    VaultLost { path: PathBuf },
    /// -> `nc://watch-degraded { reason, hint }`, AT MOST ONCE PER VAULT.
    Degraded { reason: DegradeReason, hint: String },
}

/// The sink is a plain closure so that a test can be the UI.  It is called from
/// the coalescing thread and MUST NOT block for long.
pub type Sink = Box<dyn Fn(WatchEvent) + Send + 'static>;

/* ── the test-only injection point (CONTRACT §7.3 case 16) ────────────────── */

/// §7.3 case 16 requires a `#[cfg(test)]`-only injection point that makes
/// `Watcher::new` return `ErrorKind::MaxFilesWatch`, because the real condition
/// is an inotify limit and Linux is out of v1 — there is no way to provoke it on
/// macOS.  It is `cfg(test)` so that it cannot exist in a shipped binary.
#[cfg(test)]
pub static FORCE_WATCH_LIMIT: AtomicBool = AtomicBool::new(false);

#[cfg(test)]
fn forced_watch_error() -> Option<notify::Error> {
    FORCE_WATCH_LIMIT
        .load(Ordering::SeqCst)
        .then(|| notify::Error::new(notify::ErrorKind::MaxFilesWatch))
}

#[cfg(not(test))]
fn forced_watch_error() -> Option<notify::Error> {
    None
}

fn degrade_reason(e: &notify::Error) -> DegradeReason {
    match e.kind {
        notify::ErrorKind::MaxFilesWatch => DegradeReason::WatchLimit,
        _ => DegradeReason::WatchError,
    }
}

fn degrade_hint(reason: DegradeReason) -> String {
    match reason {
        // We never fall back to PollWatcher: polling 5,000 files every 30 s is
        // exactly the background cost this product exists to avoid.
        DegradeReason::WatchLimit => {
            "The system ran out of file-watch handles. Use Refresh to pick up changes.".into()
        }
        DegradeReason::WatchError => {
            "File watching stopped. Use Refresh to pick up changes.".into()
        }
    }
}

/* ── the watcher ──────────────────────────────────────────────────────────── */

/// Owns the `notify` watcher and the coalescing thread.
///
/// SHUTDOWN IS BY DISCONNECT, NOT BY A FLAG (spec-02 §7.2).  Dropping the
/// watcher unregisters the kernel watches and drops its `Sender`;
/// `recv_timeout` then returns `Disconnected` and the thread returns.  `Drop`
/// therefore does exactly two things in exactly this order — drop the watcher,
/// then join the thread — and the vault's arena is dropped by the caller
/// AFTERWARDS (CONTRACT §8.5).  Getting that order wrong is a deadlock, which is
/// why it is `Drop` and not a method somebody can forget to call.
pub struct VaultWatcher {
    /// Shared with the coalescing thread only through a `Weak` (see
    /// `rewatch`), so dropping this still drops the notify watcher and so still
    /// disconnects the channel.
    watcher: Option<Arc<Mutex<notify::RecommendedWatcher>>>,
    thread: Option<std::thread::JoinHandle<()>>,
    root: PathBuf,
}

impl VaultWatcher {
    /// Starts watching `root` recursively.  On failure the caller gets the
    /// degrade reason and is expected to emit `nc://watch-degraded` and set
    /// `VaultInfo.watching = false` — the vault still opens and still works.
    ///
    /// `self_writes` is shared with `fsops`, which records a fingerprint BEFORE
    /// its command returns.
    /// `root` IS CANONICALISED HERE, ONCE, AND THAT IS LOAD-BEARING.  FSEvents
    /// reports canonical paths: watch `/var/x` — and `/var` is a symlink to
    /// `/private/var` on every Mac — and every event arrives as `/private/var/x`,
    /// fails the `starts_with(root)` test, and is dropped.  The failure is
    /// SILENT: the watcher starts, `VaultInfo.watching` is `true`, no banner
    /// stays dim, and no external edit ever reaches the UI, which is precisely
    /// what §7.3 case 16's invariant forbids.  A vault under `/tmp`, under a
    /// symlinked home, or inside a symlinked cloud folder hits this.
    ///
    /// This is NOT the traversal check §7.3 case 12 refuses to build on
    /// `canonicalize` — that check is the arena, under a lock, and is unchanged.
    /// This is a one-time normalisation of the root so that two strings naming
    /// the same directory compare equal.
    ///
    /// THE CALLER MUST USE `self.root()` AS THE VAULT'S `root_path`.  If the
    /// arena builds absolute paths from an uncanonicalised root, `fsops` records
    /// `/var/...` fingerprints while the watcher sees `/private/var/...`, no
    /// fingerprint ever matches, and every one of our own saves echoes back as
    /// an external change — which, on a dirty buffer, is a spurious conflict bar
    /// (§7.3 case 7).
    pub fn start(
        root: &Path,
        self_writes: Arc<Mutex<SelfWrites>>,
        sink: Sink,
    ) -> Result<Self, DegradeReason> {
        let root = crate::fsops::canonical_root(root).map_err(|_| DegradeReason::WatchError)?;
        let root = root.as_path();
        let id = RootId::of(root).ok_or(DegradeReason::WatchError)?;
        let (tx, rx) = std::sync::mpsc::channel::<notify::Result<Event>>();

        // §7.3 case 12: the scanner never admits a symlink, so the watcher must
        // not walk into one either — notify's default follows them, adding a
        // watch per directory of whatever tree the link points at.
        let config = notify::Config::default().with_follow_symlinks(false);
        let mut watcher = match forced_watch_error() {
            Some(e) => Err(e),
            None => notify::RecommendedWatcher::new(
                move |res| {
                    // MUST NOT block: notify's own thread is calling us.
                    let _ = tx.send(res);
                },
                config,
            ),
        }
        .map_err(|e| degrade_reason(&e))?;

        // BEFORE `watch`, never after: an event for a change that lands while
        // the stream is being established must be treated as live, and an epoch
        // taken afterwards would call it history.
        let epoch = Epoch::now();
        watcher.watch(root, RecursiveMode::Recursive).map_err(|e| degrade_reason(&e))?;
        let watcher = Arc::new(Mutex::new(watcher));

        let thread = {
            let root = root.to_path_buf();
            let self_writes = Arc::clone(&self_writes);
            let weak = Arc::downgrade(&watcher);
            std::thread::Builder::new()
                .name("cairn-watch".into())
                .spawn(move || {
                    let rearm = || rewatch(&weak, &root);
                    coalesce(&root, &rx, &self_writes, sink.as_ref(), epoch, id, &rearm);
                })
                .map_err(|_| DegradeReason::WatchError)?
        };

        Ok(Self {
            watcher: Some(watcher),
            thread: Some(thread),
            root: root.to_path_buf(),
        })
    }

    /// The canonical root this watcher is actually watching.  The vault MUST
    /// build its absolute paths from this, not from what the user picked — see
    /// `start`.
    pub fn root(&self) -> &Path {
        &self.root
    }
}

/// Free function so that `fsops` can record a fingerprint without a live
/// watcher — a vault whose watcher degraded still writes notes, and a write
/// whose fingerprint went nowhere would be an echo nobody suppressed later.
/// A poisoned lock is recovered from rather than propagated: dropping one
/// fingerprint costs a spurious tree rebuild, and panicking here would take out
/// a save.
pub fn record_self_write(self_writes: &Mutex<SelfWrites>, sw: SelfWrite) {
    let mut g = match self_writes.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    g.record(sw);
}

impl Drop for VaultWatcher {
    fn drop(&mut self) {
        drop(self.watcher.take());
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// Re-adds the recursive watch over `root`, which walks every directory again
/// and watches the ones notify never saw created: after an inotify queue
/// overflow (`IN_Q_OVERFLOW`) their `IN_CREATE` is simply gone, and notify
/// only ever adds watches for new directories from those events.  Already
/// watched directories keep their watch.  A watcher that has been dropped
/// is left alone.
fn rewatch(watcher: &Weak<Mutex<notify::RecommendedWatcher>>, root: &Path) -> notify::Result<()> {
    let Some(w) = watcher.upgrade() else { return Ok(()) };
    let mut g = w.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    g.watch(root, RecursiveMode::Recursive)
}

/// The watched root's identity: its device and inode, not its path.  §7.3
/// case 8 is decided on this, because the path can outlive the directory —
/// an unmount leaves the empty mountpoint behind, and renaming or moving a
/// PARENT folder raises no event on the root's own watch at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RootId {
    dev: u64,
    ino: u64,
}

impl RootId {
    fn of(root: &Path) -> Option<Self> {
        use std::os::unix::fs::MetadataExt;
        let md = std::fs::symlink_metadata(root).ok()?;
        md.is_dir().then(|| Self { dev: md.dev(), ino: md.ino() })
    }

    /// True only when `root` is definitely no longer this directory: missing,
    /// not a directory, or a different one.  Any other error (EIO, ESTALE,
    /// EACCES on a flaky network mount) is not loss, and reads as "still here".
    fn gone_from(self, root: &Path) -> bool {
        use std::os::unix::fs::MetadataExt;
        match std::fs::symlink_metadata(root) {
            Ok(md) => !md.is_dir() || md.dev() != self.dev || md.ino() != self.ino,
            Err(e) => {
                e.kind() == std::io::ErrorKind::NotFound || e.raw_os_error() == Some(libc::ENOTDIR)
            }
        }
    }
}

/// Only inotify loses directory watches; FSEvents watches the root as one
/// stream, so a rescan request there needs no re-arm.
fn wants_rewatch(ev: &Event) -> bool {
    cfg!(target_os = "linux") && ev.need_rescan()
}

/* ── classification and coalescing ────────────────────────────────────────── */

/// The debounce loop of spec-02 §7.2, verbatim in structure.
/* ══════════ THE START EPOCH, AND WHY macOS NEEDS ONE AND LINUX DOES NOT ═════
 * inotify delivers only what happens AFTER `watch()` returns.  FSEvents does
 * not: it reports the accumulated flag set for each path in its latency
 * window, so a write that happened BEFORE the stream started still arrives
 * after it, and it arrives indistinguishable from a live external edit.
 *
 * MEASURED 2026-09-09, first macOS run of `our_own_write_does_not_echo`.  The
 * test writes "before\n", starts the watcher, sleeps 300 ms and then does one
 * self-write of "after\n" -- and the flush that came back carried
 * `len: 7`, which is "before\n" (6 for "after\n").  So the escaping event was
 * never the self-write at all; §3.5's suppression worked exactly as written.
 * It was the SETUP write, replayed by FSEvents after the watcher started.
 *
 * The product consequence is the real one: on macOS, opening a vault whose
 * files were touched moments earlier fires a full rescan and, for the open
 * note, a bogus external-change bar -- every time.
 *
 * THE GUARD IS ON ctime, NOT mtime, and that is load-bearing.  A rename does
 * not touch mtime, so an mtime guard would swallow the rename of a file that
 * was last written before the watcher started -- a real change, dropped.
 * ctime moves for content, rename, chmod and link count alike: "nothing has
 * happened to this inode since we started watching" is exactly the question,
 * and ctime is exactly its answer.
 *
 * WHAT IT COSTS.  A change landing between `open_vault`'s walk and this
 * watcher's start is not reported.  That window already existed on Linux, where
 * such events are simply never delivered; this makes macOS agree with it rather
 * than covering it by accident at the price above.  A vanished path is NEVER
 * guarded -- `symlink_metadata` fails, there is no ctime to compare, and a
 * deletion must always propagate. */
#[derive(Clone, Copy)]
struct Epoch(#[cfg_attr(not(target_os = "macos"), allow(dead_code))] i128);

impl Epoch {
    /// An epoch nothing can predate, so the guard is inert. Unit tests that
    /// hand `classify` synthetic events want the classifier under test, not
    /// FSEvents' replay rule -- and several of them name paths that do not
    /// exist, where `predates` is false anyway.
    #[cfg(test)]
    const TEST: Self = Self(0);

    fn now() -> Self {
        Self(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos() as i128)
                .unwrap_or(0),
        )
    }

    /// True when `path` still exists and NOTHING has touched its inode since
    /// this epoch — i.e. the event reporting it is FSEvents replaying history.
    ///
    /// MACOS ONLY, and Linux returns false outright.  inotify is a LIVE stream:
    /// it emits only events from the moment the watch is registered, so there
    /// is no history to replay and the comparison can only do harm.  It did:
    /// ctime is coarse (jiffy granularity) while the epoch is `SystemTime::now()`
    /// at nanoseconds, so a legitimate write in the same tick as
    /// `VaultWatcher::start` compared as older than the epoch and was dropped —
    /// the vault's first external edit, silently lost.  FSEvents really does
    /// replay, so macOS keeps the guard.
    fn predates(self, path: &Path) -> bool {
        #[cfg(target_os = "macos")]
        {
            use std::os::unix::fs::MetadataExt;
            match std::fs::symlink_metadata(path) {
                Ok(md) => (md.ctime() as i128) * 1_000_000_000 + (md.ctime_nsec() as i128) < self.0,
                Err(_) => false,
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = path;
            false
        }
    }
}

fn coalesce(
    root: &Path,
    rx: &Receiver<notify::Result<Event>>,
    self_writes: &Mutex<SelfWrites>,
    sink: &(dyn Fn(WatchEvent) + Send),
    epoch: Epoch,
    id: RootId,
    rewatch: &dyn Fn() -> notify::Result<()>,
) {
    let mut batch = Flush::default();
    let mut first: Option<Instant> = None;
    let mut degraded = false;
    // Set by an event saying the kernel dropped events.  Consumed by the next
    // flush, BEFORE it is sunk, so the repair walk that flush triggers covers
    // whatever changed before the re-added watches existed.
    let mut rearm = false;
    let mut checked = Instant::now();

    // AT MOST ONCE PER VAULT (§1.4).  A watcher that has failed usually keeps
    // failing, and a banner that reappears every 150 ms is worse than the
    // degradation it reports.
    let report = |degraded: &mut bool, e: &notify::Error| {
        if !*degraded {
            *degraded = true;
            let reason = degrade_reason(e);
            sink(WatchEvent::Degraded { reason, hint: degrade_hint(reason) });
        }
    };
    let flush = |batch: &mut Flush, rearm: &mut bool, degraded: &mut bool| {
        if std::mem::take(rearm) {
            if let Err(e) = rewatch() {
                report(degraded, &e);
            }
        }
        sink(WatchEvent::Flush(std::mem::take(batch)));
    };

    loop {
        match rx.recv_timeout(DEBOUNCE) {
            Ok(Ok(ev)) => {
                rearm |= wants_rewatch(&ev);
                if classify(root, &ev, self_writes, &mut batch, epoch) {
                    sink(WatchEvent::VaultLost { path: root.to_path_buf() });
                    return;
                }
                if !batch.is_empty() {
                    let started = *first.get_or_insert_with(Instant::now);
                    if started.elapsed() >= MAX_ACCUM {
                        flush(&mut batch, &mut rearm, &mut degraded);
                        first = None;
                    }
                }
            }
            Ok(Err(e)) => report(&mut degraded, &e),
            Err(RecvTimeoutError::Timeout) => {
                if !batch.is_empty() {
                    flush(&mut batch, &mut rearm, &mut degraded);
                    first = None;
                }
            }
            // The `VaultWatcher` was dropped.  Flush what we have and stop —
            // no flag, no join deadlock.
            Err(RecvTimeoutError::Disconnected) => {
                if !batch.is_empty() {
                    sink(WatchEvent::Flush(std::mem::take(&mut batch)));
                }
                return;
            }
        }

        // §7.3 case 8 when no event names the root: a renamed parent or an
        // unmount.  Without this the arena outlives its directory, `watching`
        // stays true, and every autosave fails with nothing on screen.
        if checked.elapsed() >= ROOT_CHECK {
            checked = Instant::now();
            if id.gone_from(root) {
                sink(WatchEvent::VaultLost { path: root.to_path_buf() });
                return;
            }
        }
    }
}

/// spec-02 §7.3's table.  Returns `true` when the vault root itself is gone,
/// which is the one condition that ends the loop.
///
/// Echo suppression happens HERE, per path, before anything is marked dirty:
/// a self-inflicted event must not even mark a directory, or every save would
/// cost a rescan and a `nc://tree-changed` the frontend then acts on.
fn classify(
    root: &Path,
    ev: &Event,
    self_writes: &Mutex<SelfWrites>,
    batch: &mut Flush,
    epoch: Epoch,
) -> bool {
    if matches!(ev.kind, EventKind::Access(_)) {
        return false;
    }

    // FSEvents' `kMustScanSubDirs` and inotify's `IN_Q_OVERFLOW` degrade into
    // these, and the only safe reading is "you have missed something".
    if matches!(ev.kind, EventKind::Any | EventKind::Other) {
        batch.full_rescan = true;
        return false;
    }

    for path in &ev.paths {
        if !path.starts_with(root) {
            continue; // not ours
        }

        // §3.6's skip rule, applied to events as well as to the walk.  One
        // rule covers `.obsidian`, `.git`, `.trash`, `.DS_Store` AND OUR OWN
        // TEMP FILES — and that last one is the load-bearing part: every
        // atomic write creates and renames a `.<name>.tmp-<pid>-<counter>` in
        // the note's own directory, and without this rule each of those marks
        // the directory dirty and fires a tree rebuild on every autosave, for a
        // file the tree does not and must not contain.
        if hidden_under(root, path) {
            continue;
        }

        // FSEvents replaying history from before this watcher existed.  See
        // `Epoch` above; on Linux this is never true and costs one `lstat`.
        if epoch.predates(path) {
            continue;
        }

        // The root itself.  `remove`/`rename` of the root is §7.3 case 8, and
        // the check is "does it still exist", never "which event kind was it" —
        // FSEvents will not tell us reliably which.
        if path == root {
            if !root.exists() {
                return true;
            }
            /* A `full_rescan` HERE WAS AN OVER-TRIGGER ON macOS.  FSEvents
             * reports the watched directory itself whenever a child is added or
             * removed -- its own mtime changes -- so every note created in the
             * vault root cost a whole-tree rescan, while inotify (which reports
             * the CHILD path, not the parent) almost never took this branch.
             * The root's own metadata changing means its CONTENTS changed, which
             * is a dirty directory and nothing more; `full_rescan` is reserved
             * for `Any`/`Other`, where the only honest reading is "you have
             * missed something". */
            if !epoch.predates(path) {
                push_dir(batch, root.to_path_buf());
            }
            continue;
        }

        let mut sw = match self_writes.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        if sw.matches_for(path) {
            continue; // our own write; not an external change
        }
        drop(sw);

        let is_content = matches!(
            ev.kind,
            EventKind::Modify(notify::event::ModifyKind::Data(_))
                | EventKind::Modify(notify::event::ModifyKind::Any)
                | EventKind::Modify(notify::event::ModifyKind::Metadata(_))
        );
        // A name ARRIVING at a path is new content there: an atomic save by
        // another program (temp file, then rename over the note) reports
        // nothing else on the note's own path — inotify's `IN_MOVED_TO`, or
        // FSEvents' `ItemRenamed`.  Our own atomic saves were matched above.
        let is_arrival = matches!(
            ev.kind,
            EventKind::Modify(notify::event::ModifyKind::Name(
                notify::event::RenameMode::To
                    | notify::event::RenameMode::Both
                    | notify::event::RenameMode::Any
            ))
        );

        if (is_content || is_arrival) && is_md(path) {
            // spec-02 §7.3: a content hit does NOT mark the directory dirty.
            // No run needs re-sorting until the sort mode is time-based, and
            // `set_sort` re-sorts everything anyway.  An arrival still does
            // (below): the name may be new to the tree.
            if let Ok(md) = std::fs::symlink_metadata(path) {
                if md.is_file() {
                    push_hit(
                        batch,
                        ContentHit {
                            abs: path.clone(),
                            mtime_ms: crate::fsops::mtime_ms(&md),
                            len: md.len(),
                        },
                    );
                    if !is_arrival {
                        continue;
                    }
                }
            }
        }

        // Create, Remove, Modify(Name) and anything else: mark the containing
        // directory dirty.  For a rename event carrying two paths, both parents
        // get marked, which is what makes pairing unnecessary.
        if let Some(parent) = path.parent() {
            if parent.starts_with(root) {
                push_dir(batch, parent.to_path_buf());
            }
        }
    }

    false
}

/// True if any component of `path` below `root` starts with a `.`.  The root's
/// OWN components are not examined: a vault that legitimately lives inside
/// `~/.config` or a `/private/var/folders/...` temp directory must still work.
fn hidden_under(root: &Path, path: &Path) -> bool {
    let Ok(rel) = path.strip_prefix(root) else { return false };
    rel.components().any(|c| {
        matches!(c, std::path::Component::Normal(n)
            if n.to_str().is_some_and(|s| s.starts_with('.')))
    })
}

fn is_md(p: &Path) -> bool {
    p.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("md"))
}

/// Deduplicated by linear scan: `dirs` is almost always <= 5 entries, and a
/// `HashSet` here would allocate a hash table to hold three strings.
fn push_dir(batch: &mut Flush, dir: PathBuf) {
    if batch.full_rescan || batch.dirs.contains(&dir) {
        return;
    }
    if batch.dirs.len() >= MAX_DIRTY {
        // Beyond this a full rescan is cheaper than N directory rescans.
        batch.dirs.clear();
        batch.full_rescan = true;
        return;
    }
    batch.dirs.push(dir);
}

/// Last write wins for a path, so a burst on one file is one hit carrying the
/// latest stat.
///
/// OVERFLOW DROPS THE INCOMING HIT AND KEEPS THE COLLECTED ONES.  It used to
/// `clear()` them, and that threw away the only thing that tells the frontend
/// its OPEN NOTE changed: `app.rs`'s `on_watch_event` emits
/// `nc://note-external-change` from `content_hits` and from nowhere else, so a
/// `git checkout` touching more than `MAX_DIRTY` files left the open note
/// showing stale text — and the next autosave was then refused as a conflict,
/// because the mtime on disk had moved underneath a buffer nobody had reloaded.
///
/// `full_rescan` is still set, and still right: the hits past the cap are the
/// mtimes M69 keeps on `Node`, so the tree has to be re-walked wholesale to get
/// them. What overflow must NOT do is discard evidence that has already been
/// collected. `app.rs` carries a backstop for the narrower case where the open
/// note's own hit is the one past the cap.
fn push_hit(batch: &mut Flush, hit: ContentHit) {
    if let Some(existing) = batch.content_hits.iter_mut().find(|h| h.abs == hit.abs) {
        *existing = hit;
        return;
    }
    if batch.content_hits.len() >= MAX_DIRTY {
        batch.full_rescan = true;
        return;
    }
    batch.content_hits.push(hit);
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]
mod tests {
    use super::*;
    use std::sync::mpsc::{channel, Sender};

    fn sink_to(tx: Sender<WatchEvent>) -> Sink {
        Box::new(move |e| {
            let _ = tx.send(e);
        })
    }

    /// Waits for one event, or gives up.  Generous, because FSEvents' own
    /// latency is not ours to control and a flaky watcher test is worse than a
    /// slow one.
    fn wait(rx: &Receiver<WatchEvent>) -> Option<WatchEvent> {
        rx.recv_timeout(Duration::from_secs(10)).ok()
    }

    fn drain_flush(rx: &Receiver<WatchEvent>, dur: Duration) -> Vec<Flush> {
        let deadline = Instant::now() + dur;
        let mut out = Vec::new();
        while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
            match rx.recv_timeout(remaining) {
                Ok(WatchEvent::Flush(f)) => out.push(f),
                Ok(_) => {}
                Err(_) => break,
            }
        }
        out
    }

    /* ── the fingerprint ring ─────────────────────────────────────────────── */

    #[test]
    fn fingerprint_matches_exactly_and_is_removed_on_match() {
        let mut s = SelfWrites::new();
        let p = Path::new("/v/a.md");
        s.record(SelfWrite::existing(p, 42, 7));

        assert!(!s.matches(p, 42, 8), "a different length must NOT match");
        assert!(!s.matches(p, 43, 7), "a different mtime must NOT match");
        assert!(!s.matches(Path::new("/v/b.md"), 42, 7), "a different path must NOT match");
        assert!(s.matches(p, 42, 7));
    }

    /// The measured reason `matches` does not remove: FSEvents delivers FOUR
    /// events for one write, all carrying the same fingerprint.  All four must
    /// be suppressed by the one entry.
    #[test]
    fn matching_survives_the_event_burst() {
        let mut s = SelfWrites::new();
        let p = Path::new("/v/a.md");
        s.record(SelfWrite::existing(p, 42, 7));
        for i in 0..4 {
            assert!(s.matches(p, 42, 7), "event {i} of the burst was not suppressed");
        }
    }

    /// And the half §3.5's remove-on-match rule existed to protect: a genuinely
    /// later write is NOT swallowed, because it cannot reproduce the nanosecond
    /// mtime.  This is the property that makes removal unnecessary.
    #[test]
    fn a_genuine_later_write_is_not_swallowed() {
        let mut s = SelfWrites::new();
        let p = Path::new("/v/a.md");
        s.record(SelfWrite::existing(p, 42, 7));
        assert!(s.matches(p, 42, 7), "our own write");
        // Somebody else writes the same number of bytes, one nanosecond later.
        assert!(!s.matches(p, 43, 7), "an external edit was swallowed");
    }

    #[test]
    fn delete_fingerprint_is_zero_zero() {
        let mut s = SelfWrites::new();
        s.record(SelfWrite::removed("/v/gone.md"));
        assert!(s.matches(Path::new("/v/gone.md"), 0, 0));
    }

    #[test]
    fn ring_is_capped_at_eight_and_drops_the_oldest() {
        let mut s = SelfWrites::new();
        for i in 0..12u128 {
            s.record(SelfWrite::existing(format!("/v/{i}.md"), i, i as u64));
        }
        assert_eq!(s.len(), SELF_WRITE_CAP);
        // 0..3 were evicted; 4..11 remain.
        assert!(!s.matches(Path::new("/v/3.md"), 3, 3));
        assert!(s.matches(Path::new("/v/11.md"), 11, 11));
        assert!(s.matches(Path::new("/v/4.md"), 4, 4));
    }

    /// CONTRACT §3.5: `deadline` is garbage collection ONLY and is NEVER the
    /// reason an event is dropped.  An entry whose deadline has passed still
    /// matches if nothing has evicted it — the alternative is a TTL, which is
    /// exactly what M26 struck.
    #[test]
    fn deadline_is_gc_only_and_never_the_matching_rule() {
        let mut s = SelfWrites::new();
        s.record(SelfWrite {
            abs: "/v/a.md".into(),
            mtime_ns: 1,
            len: 1,
            deadline: Instant::now() - Duration::from_secs(60),
        });
        // GC evicts it, which is `deadline`'s ONLY job; what must never happen
        // is a fresh entry being dropped because a clock said so.
        s.record(SelfWrite::existing("/v/b.md", 2, 2));
        assert!(s.matches(Path::new("/v/b.md"), 2, 2), "a live entry stopped matching");
    }

    #[test]
    fn expired_entries_are_collected_on_the_next_record() {
        let mut s = SelfWrites::new();
        s.record(SelfWrite {
            abs: "/v/old.md".into(),
            mtime_ns: 1,
            len: 1,
            deadline: Instant::now() - Duration::from_secs(1),
        });
        s.record(SelfWrite::existing("/v/new.md", 2, 2));
        assert_eq!(s.len(), 1);
        assert!(s.matches(Path::new("/v/new.md"), 2, 2));
    }

    /* ── classification ───────────────────────────────────────────────────── */

    fn ev(kind: EventKind, paths: &[&Path]) -> Event {
        Event { kind, paths: paths.iter().map(|p| p.to_path_buf()).collect(), attrs: <_>::default() }
    }

    #[test]
    fn access_events_are_ignored_entirely() {
        let sw = Mutex::new(SelfWrites::new());
        let mut b = Flush::default();
        classify(
            Path::new("/v"),
            &ev(
                EventKind::Access(notify::event::AccessKind::Open(
                    notify::event::AccessMode::Read,
                )),
                &[Path::new("/v/a.md")],
            ),
            &sw,
            &mut b,
            Epoch::TEST,
        );
        assert!(b.is_empty());
    }

    #[test]
    fn any_and_other_force_a_full_rescan() {
        let sw = Mutex::new(SelfWrites::new());
        for kind in [EventKind::Any, EventKind::Other] {
            let mut b = Flush::default();
            classify(Path::new("/v"), &ev(kind, &[Path::new("/v/a.md")]), &sw, &mut b, Epoch::TEST);
            assert!(b.full_rescan, "{kind:?}");
        }
    }

    #[test]
    fn paths_outside_the_root_are_ignored() {
        let sw = Mutex::new(SelfWrites::new());
        let mut b = Flush::default();
        classify(
            Path::new("/v"),
            &ev(EventKind::Create(notify::event::CreateKind::File), &[Path::new("/elsewhere/a.md")]),
            &sw,
            &mut b,
            Epoch::TEST,
        );
        assert!(b.is_empty());
    }

    /// The rename rule: both parents are marked, and no pairing is attempted.
    #[test]
    fn a_rename_marks_both_parents() {
        let sw = Mutex::new(SelfWrites::new());
        let mut b = Flush::default();
        classify(
            Path::new("/v"),
            &ev(
                EventKind::Modify(notify::event::ModifyKind::Name(
                    notify::event::RenameMode::Both,
                )),
                &[Path::new("/v/A/x.md"), Path::new("/v/B/y.md")],
            ),
            &sw,
            &mut b,
            Epoch::TEST,
        );
        assert_eq!(b.dirs, vec![PathBuf::from("/v/A"), PathBuf::from("/v/B")]);
    }

    #[test]
    fn dirty_directories_are_deduplicated_and_capped() {
        let mut b = Flush::default();
        push_dir(&mut b, "/v/A".into());
        push_dir(&mut b, "/v/A".into());
        assert_eq!(b.dirs.len(), 1);
        for i in 0..MAX_DIRTY + 5 {
            push_dir(&mut b, format!("/v/d{i}").into());
        }
        assert!(b.full_rescan);
        assert!(b.dirs.is_empty(), "a full rescan does not also carry a directory list");
    }

    /// CONTENT HITS ARE NOT THROWN AWAY BY OVERFLOW, and the asymmetry with
    /// `push_dir` above is the point: a dirty DIRECTORY is superseded by a full
    /// rescan, so clearing the list loses nothing.  A content HIT is the only
    /// thing `app.rs` emits `nc://note-external-change` from, so clearing the
    /// list loses the one signal that tells the frontend its open note changed
    /// on disk — a `git checkout` of more than `MAX_DIRTY` files used to leave
    /// the open note showing stale text.
    #[test]
    fn content_hits_survive_overflow_and_the_incoming_one_is_dropped() {
        let mut b = Flush::default();
        let hit = |n: usize| ContentHit {
            abs: format!("/v/n{n}.md").into(),
            mtime_ms: 1_000 + n as i64,
            len: n as u64,
        };
        // Last write wins for a path, and that is not affected by any of this.
        push_hit(&mut b, hit(0));
        push_hit(&mut b, ContentHit { abs: "/v/n0.md".into(), mtime_ms: 9_999, len: 7 });
        assert_eq!(b.content_hits.len(), 1);
        assert_eq!(b.content_hits[0].mtime_ms, 9_999);

        for i in 1..MAX_DIRTY + 5 {
            push_hit(&mut b, hit(i));
        }
        assert!(b.full_rescan, "overflow must still force a rescan — M69's mtimes need it");
        assert_eq!(
            b.content_hits.len(),
            MAX_DIRTY,
            "the collected hits must be KEPT, capped at MAX_DIRTY"
        );
        // And the FIRST one — the one most likely to be the note the user has
        // open, since it arrived first — is still there, unmangled.
        assert_eq!(b.content_hits[0].abs, std::path::PathBuf::from("/v/n0.md"));
        assert_eq!(b.content_hits[0].mtime_ms, 9_999);
    }

    /* ── the live watcher, against the real filesystem ────────────────────── */

    /// Production ordering in miniature (fsops steps 3-10 with the pre-rename
    /// record): temp, fingerprint from the TEMP stat naming the DESTINATION,
    /// rename.  A raw `fs::write` + post-record leaves a window between the
    /// event and the record that macOS's FSEvents latency happens to cover and
    /// Linux's instant inotify does not — under parallel load the classifier
    /// can run first and the write echoes.  This helper has no such window by
    /// construction, on either OS.  The temp name's leading `.` keeps its own
    /// create/write events under `hidden_under`'s skip rule.
    fn atomic_self_write(dir: &Path, dest: &Path, bytes: &[u8], sw: &Mutex<SelfWrites>) {
        let tmp = dir.join(".selftest.tmp");
        std::fs::write(&tmp, bytes).unwrap();
        let md = std::fs::metadata(&tmp).unwrap();
        record_self_write(
            sw,
            SelfWrite::existing(dest, crate::fsops::mtime_ns(&md), md.len()),
        );
        std::fs::rename(&tmp, dest).unwrap();
    }

    /// CONTRACT §3.5 / M26, the headline: OUR OWN WRITES DO NOT ECHO.
    /// Recorded fingerprint in, no event out.
    #[test]
    fn our_own_write_does_not_echo() {
        let dir = tempfile::tempdir().unwrap();
        // AS `open_vault` MUST: one canonicalisation, and every absolute path
        // below is built from its result.  See `VaultWatcher::start`.
        let root = crate::fsops::canonical_root(dir.path()).unwrap();
        let note = root.join("Misc.md");
        std::fs::write(&note, b"before\n").unwrap();

        let sw = Arc::new(Mutex::new(SelfWrites::new()));
        let (tx, rx) = channel();
        let _w = VaultWatcher::start(&root, Arc::clone(&sw), sink_to(tx)).unwrap();
        std::thread::sleep(Duration::from_millis(300)); // let the watcher settle

        // Production ordering, not a raw write: see `atomic_self_write`.
        atomic_self_write(&root, &note, b"after\n", &sw);

        let flushes = drain_flush(&rx, Duration::from_millis(1500));
        assert!(
            flushes.is_empty(),
            "our own write echoed back as {flushes:?} - the frontend would rebuild the tree \
             and, for the open note, show a bogus external-change bar"
        );
    }

    /// THE FSEvents REPLAY RULE, and the reason `Epoch` exists.  A write that
    /// happened BEFORE the watcher started must not surface as an external
    /// change -- `open_vault` already walked it into the tree, so reporting it
    /// costs a rescan and, for the open note, a bogus external-change bar.
    ///
    /// This is not a hypothetical guard for a platform quirk somebody read
    /// about.  Before `Epoch`, this exact shape made `our_own_write_does_not_
    /// echo` FAIL on macOS, and the giveaway was in the payload: the escaping
    /// ContentHit carried `len: 7` for "before\n" while the self-write under
    /// test was 6 bytes of "after\n".  §3.5's suppression was never involved.
    ///
    /// ON LINUX THIS PASSES VACUOUSLY -- inotify delivers nothing from before
    /// `watch()` -- and it is kept anyway, because the assertion is about what
    /// the UI is told and that is the same promise on both platforms.
    #[test]
    fn a_write_from_before_the_watcher_started_is_not_an_external_change() {
        let dir = tempfile::tempdir().unwrap();
        let root = crate::fsops::canonical_root(dir.path()).unwrap();
        let note = root.join("Prior.md");

        // Written BEFORE the watcher exists, exactly as a vault's files are.
        std::fs::write(&note, b"written before the watcher\n").unwrap();

        let sw = Arc::new(Mutex::new(SelfWrites::new()));
        let (tx, rx) = channel();
        let _w = VaultWatcher::start(&root, Arc::clone(&sw), sink_to(tx)).unwrap();

        let flushes = drain_flush(&rx, Duration::from_millis(1500));
        assert!(
            flushes.is_empty(),
            "a pre-existing file surfaced as an external change: {flushes:?} — \
             the tree was walked with this content already in it"
        );
    }

    /// LINUX DOES NOT REPLAY HISTORY, SO IT MUST NOT PREDATE.  The ctime this
    /// guard reads comes from the coarse clock (jiffy granularity) while the
    /// epoch is `SystemTime::now()` at nanoseconds, so a legitimate write in
    /// the same tick as `VaultWatcher::start` compared as OLDER than the epoch
    /// and was dropped as if it were FSEvents history — the first external
    /// edit after opening a vault could be lost silently.  `native.test.mjs`
    /// reproduced it 8 runs in 10; this pins the rule.
    #[cfg(not(target_os = "macos"))]
    #[test]
    fn a_linux_write_in_the_same_tick_as_the_epoch_is_not_history() {
        let dir = tempfile::tempdir().unwrap();
        let note = dir.path().join("Note.md");
        std::fs::write(&note, b"fresh\n").unwrap();
        // The sleep forces the file's coarse ctime to a tick strictly before
        // the fine epoch: the exact shape the jiffy race produces.
        std::thread::sleep(Duration::from_millis(20));
        let epoch = Epoch::now();
        assert!(
            !epoch.predates(&note),
            "a write from this tick was classified as FSEvents history and dropped"
        );
    }

    /// THE GUARD'S OTHER EDGE, and the reason it reads ctime rather than mtime.
    ///
    /// mtime is CALLER-CONTROLLED.  `rsync -t`, `cp -p`, `tar -x`, a restore
    /// from backup and Obsidian Sync all write current content and then set the
    /// mtime BACKWARDS to preserve the original.  An mtime guard reads that as
    /// "nothing has happened since we started watching" and swallows it --
    /// silently, permanently, and precisely for the file a user just restored.
    ///
    /// ctime cannot be set by any API; the kernel moves it on every inode
    /// change, including the `utimensat` that rewrites mtime.  So it answers
    /// the question actually being asked.
    ///
    /// THIS TEST FAILS ON AN mtime GUARD AND PASSES ON A ctime ONE -- verified
    /// by swapping the field and watching it go red, which is the only reason
    /// it is worth having.  (An earlier version of this test used a RENAME and
    /// discriminated nothing: a rename's old path has vanished, `predates`
    /// cannot stat it, and the event reaches the UI on either field.)
    #[test]
    fn a_restore_that_backdates_mtime_still_reaches_the_ui() {
        let dir = tempfile::tempdir().unwrap();
        let root = crate::fsops::canonical_root(dir.path()).unwrap();
        let note = root.join("Restored.md");
        std::fs::write(&note, b"original\n").unwrap();

        let sw = Arc::new(Mutex::new(SelfWrites::new()));
        let (tx, rx) = channel();
        let _w = VaultWatcher::start(&root, Arc::clone(&sw), sink_to(tx)).unwrap();
        std::thread::sleep(Duration::from_millis(300));

        // What a restore does: new content NOW, mtime pushed back to the file's
        // original date. ctime is now; mtime is 2001.
        std::fs::write(&note, b"restored from a backup, with the old mtime\n").unwrap();
        let f = std::fs::OpenOptions::new().write(true).open(&note).unwrap();
        let old = std::time::UNIX_EPOCH + Duration::from_secs(1_000_000_000);
        f.set_times(std::fs::FileTimes::new().set_accessed(old).set_modified(old)).unwrap();
        drop(f);

        let flushes = drain_flush(&rx, Duration::from_millis(2500));
        assert!(
            !flushes.is_empty(),
            "a restored file with a backdated mtime produced NO event — the epoch \
             guard is reading mtime, which callers control, instead of ctime, which \
             they cannot. A user's restored note would never appear."
        );
    }

    /// And the other half, which is the one that matters more: an EXTERNAL edit
    /// must reach the UI.  A suppression rule that swallowed this would lose the
    /// user's Obsidian edits silently.
    #[test]
    fn an_external_edit_reaches_the_ui() {
        let dir = tempfile::tempdir().unwrap();
        // AS `open_vault` MUST: one canonicalisation, and every absolute path
        // below is built from its result.  See `VaultWatcher::start`.
        let root = crate::fsops::canonical_root(dir.path()).unwrap();
        let note = root.join("Misc.md");
        std::fs::write(&note, b"before\n").unwrap();

        let sw = Arc::new(Mutex::new(SelfWrites::new()));
        let (tx, rx) = channel();
        let _w = VaultWatcher::start(&root, Arc::clone(&sw), sink_to(tx)).unwrap();
        std::thread::sleep(Duration::from_millis(300));

        // No fingerprint recorded: this is somebody else's write.
        std::fs::write(&note, b"an edit from Obsidian\n").unwrap();

        let mut hits = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(10);
        while hits.is_empty() && Instant::now() < deadline {
            match rx.recv_timeout(Duration::from_secs(2)) {
                Ok(WatchEvent::Flush(f)) => hits.extend(f.content_hits),
                Ok(_) => {}
                Err(_) => break,
            }
        }
        let hit = hits.first().expect("no content hit for an external edit");
        assert_eq!(hit.abs, note);
        assert_eq!(hit.len, b"an edit from Obsidian\n".len() as u64);
    }

    /// A new file appears: the CONTAINING DIRECTORY is what gets marked, never
    /// the file.
    #[test]
    fn an_external_create_marks_the_directory() {
        let dir = tempfile::tempdir().unwrap();
        let root = crate::fsops::canonical_root(dir.path()).unwrap();
        std::fs::create_dir(root.join("Sub")).unwrap();

        let sw = Arc::new(Mutex::new(SelfWrites::new()));
        let (tx, rx) = channel();
        let _w = VaultWatcher::start(&root, Arc::clone(&sw), sink_to(tx)).unwrap();
        std::thread::sleep(Duration::from_millis(300));

        std::fs::write(root.join("Sub/New.md"), b"x").unwrap();

        let mut dirs: Vec<PathBuf> = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(10);
        while dirs.is_empty() && Instant::now() < deadline {
            match rx.recv_timeout(Duration::from_secs(2)) {
                Ok(WatchEvent::Flush(f)) => dirs.extend(f.dirs),
                Ok(_) => {}
                Err(_) => break,
            }
        }
        assert!(dirs.iter().any(|d| d.ends_with("Sub")), "got {dirs:?}");
    }

    /// CONTRACT §7.3 case 16, the mandated test, using the mandated
    /// `#[cfg(test)]`-only injection point.  The real trigger is an inotify
    /// limit; Linux is out of v1, so this is the only way it can be exercised.
    #[test]
    fn watch_limit_degrades_rather_than_failing_the_vault() {
        let dir = tempfile::tempdir().unwrap();
        FORCE_WATCH_LIMIT.store(true, Ordering::SeqCst);
        let started = VaultWatcher::start(
            dir.path(),
            Arc::new(Mutex::new(SelfWrites::new())),
            Box::new(|_| {}),
        );
        FORCE_WATCH_LIMIT.store(false, Ordering::SeqCst);

        match started {
            Err(reason) => {
                assert_eq!(reason, DegradeReason::WatchLimit);
                // This string is the `nc://watch-degraded` payload's `reason`,
                // which the frontend switches on to draw the degraded banner.
                assert_eq!(reason.as_str(), "watch-limit");
                assert!(!degrade_hint(reason).is_empty());
            }
            Ok(_) => panic!("the injection point did not fire"),
        }
    }

    /// §7.3 case 8: the vault root is deleted out from under us.  The loop ends
    /// and the caller is told once — it must NOT rescan, and it must not keep
    /// reporting a tree that is gone.
    #[test]
    fn vault_root_removed_reports_vault_lost() {
        let outer = tempfile::tempdir().unwrap();
        let root = crate::fsops::canonical_root(outer.path()).unwrap().join("vault");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("a.md"), b"x").unwrap();

        let (tx, rx) = channel();
        let _w =
            VaultWatcher::start(&root, Arc::new(Mutex::new(SelfWrites::new())), sink_to(tx))
                .unwrap();
        std::thread::sleep(Duration::from_millis(300));

        std::fs::remove_dir_all(&root).unwrap();

        let deadline = Instant::now() + Duration::from_secs(10);
        let mut lost = false;
        while !lost && Instant::now() < deadline {
            match rx.recv_timeout(Duration::from_secs(2)) {
                Ok(WatchEvent::VaultLost { path }) => {
                    assert_eq!(path, root);
                    lost = true;
                }
                Ok(_) => {}
                Err(_) => break,
            }
        }
        assert!(lost, "the vault root vanished and nothing told the frontend");
    }

    /// THE REQUIREMENT `VaultWatcher::start` STATES, PINNED AS A TEST, because a
    /// doc comment is not a guard and this one is invisible when it breaks.
    ///
    /// The OS reports canonical paths: on macOS `/var` is a symlink to
    /// `/private/var`, so watching `/var/x` delivers events under
    /// `/private/var/x`.  Record the fingerprint under the path the USER picked
    /// and it never matches the path the OS reports: our own save comes
    /// straight back as an external change, and on a dirty buffer that is a
    /// conflict bar the user did nothing to earn.
    ///
    /// Portable form: the symlink is built here rather than relying on the
    /// machine's temp dir being symlinked (true on macOS, false on Linux,
    /// where /tmp is a plain tmpfs and the old `assert_ne!` on the temp dir
    /// failed outright).  The link is a SIBLING of the vault, never inside it,
    /// so the recursive watch cannot descend into it.
    ///
    /// `our_own_write_does_not_echo` is the same scenario done correctly; this
    /// is the same scenario done wrongly, so that the reason the rule exists is
    /// written down in executable form.
    #[test]
    fn fingerprints_and_events_must_share_one_canonical_root() {
        let outer = tempfile::tempdir().unwrap();
        let vault = outer.path().join("vault");
        std::fs::create_dir(&vault).unwrap();
        let link = outer.path().join("vault-link");
        std::os::unix::fs::symlink(&vault, &link).unwrap();

        let picked = link.clone(); // the uncanonicalised spelling, as the user picked it
        let canonical = crate::fsops::canonical_root(&picked).unwrap();
        assert_ne!(picked, canonical, "the premise broke: the link resolved to itself");

        let sw = Arc::new(Mutex::new(SelfWrites::new()));
        let (tx, rx) = channel();
        // `start` canonicalises: it watches `vault` whatever spelling it was given.
        let _w = VaultWatcher::start(&picked, Arc::clone(&sw), sink_to(tx)).unwrap();
        std::thread::sleep(Duration::from_millis(300));

        // The WRONG thing: fingerprint under the uncanonicalised spelling.  The
        // event arrives under the canonical one, nothing matches, and it echoes —
        // observably, so the rule stays executable rather than documentary.
        let wrong = picked.join("Misc.md");
        atomic_self_write(&vault, &wrong, b"ours\n", &sw);

        let flushes = drain_flush(&rx, Duration::from_millis(1500));
        assert!(
            !flushes.is_empty(),
            "the mismatch stopped being observable - if paths now agree by some other \
             means, this test and the rule in VaultWatcher::start should be revisited"
        );
        // And the same write, recorded under the canonical path, IS suppressed.
        let right = canonical.join("Misc2.md");
        atomic_self_write(&vault, &right, b"ours\n", &sw);
        let after = drain_flush(&rx, Duration::from_millis(1200));
        assert!(
            after.is_empty(),
            "a canonical fingerprint stopped suppressing its own write: {after:?}"
        );
    }

    /// Shutdown is by disconnect.  Dropping the watcher must join cleanly and
    /// promptly — a `VaultWatcher` that hangs in `Drop` hangs a vault switch,
    /// and a vault switch that hangs is a data-loss path (the editor has already
    /// been flushed).
    #[test]
    fn drop_joins_the_thread_promptly() {
        let dir = tempfile::tempdir().unwrap();
        let (tx, _rx) = channel();
        let w =
            VaultWatcher::start(dir.path(), Arc::new(Mutex::new(SelfWrites::new())), sink_to(tx))
                .unwrap();
        let t0 = Instant::now();
        drop(w);
        assert!(t0.elapsed() < Duration::from_secs(2), "Drop took {:?}", t0.elapsed());
    }

    /// The debounce envelope, measured at the seam rather than asserted in a
    /// comment: a burst of writes coalesces into far fewer flushes than writes.
    #[test]
    fn a_burst_coalesces() {
        let dir = tempfile::tempdir().unwrap();
        let root = crate::fsops::canonical_root(dir.path()).unwrap();
        let (tx, rx) = channel();
        let _w =
            VaultWatcher::start(&root, Arc::new(Mutex::new(SelfWrites::new())), sink_to(tx))
                .unwrap();
        std::thread::sleep(Duration::from_millis(300));

        for i in 0..40 {
            std::fs::write(root.join(format!("n{i}.md")), b"x").unwrap();
        }

        let flushes = drain_flush(&rx, Duration::from_millis(2000));
        assert!(!flushes.is_empty(), "40 creates produced no flush at all");
        assert!(flushes.len() < 40, "40 creates produced {} flushes", flushes.len());
    }

    #[test]
    fn wait_is_used() {
        let (tx, rx) = channel::<WatchEvent>();
        tx.send(WatchEvent::Flush(Flush::default())).unwrap();
        assert!(wait(&rx).is_some());
    }

    /* ── root loss, rename-over, symlinks, late echoes, re-arming ─────────── */

    fn wait_lost(rx: &Receiver<WatchEvent>, dur: Duration) -> Option<PathBuf> {
        let deadline = Instant::now() + dur;
        while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
            match rx.recv_timeout(remaining) {
                Ok(WatchEvent::VaultLost { path }) => return Some(path),
                Ok(_) => {}
                Err(_) => break,
            }
        }
        None
    }

    fn hits_for(rx: &Receiver<WatchEvent>, dur: Duration) -> Vec<ContentHit> {
        drain_flush(rx, dur).into_iter().flat_map(|f| f.content_hits).collect()
    }

    /// §7.3 case 8 when nothing happens to the root's own inode: renaming a
    /// parent folder raises no event on the root watch, yet every path the
    /// arena resolves is gone and every autosave would fail silently.
    #[test]
    fn vault_root_ancestor_renamed_reports_vault_lost() {
        let outer = tempfile::tempdir().unwrap();
        let base = crate::fsops::canonical_root(outer.path()).unwrap();
        let root = base.join("Sync/Notes");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("a.md"), b"x").unwrap();

        let (tx, rx) = channel();
        let _w =
            VaultWatcher::start(&root, Arc::new(Mutex::new(SelfWrites::new())), sink_to(tx))
                .unwrap();
        std::thread::sleep(Duration::from_millis(300));

        std::fs::rename(base.join("Sync"), base.join("Syncthing")).unwrap();
        // Activity inside the moved vault still arrives under the OLD path.
        std::fs::write(base.join("Syncthing/Notes/a.md"), b"typed after the move").unwrap();

        assert_eq!(
            wait_lost(&rx, Duration::from_secs(5)),
            Some(root),
            "the vault's parent was renamed and nothing told the frontend"
        );
    }

    /// A directory at the same path is not the same vault: a path that still
    /// exists after an unmount is the empty mountpoint.  Renaming the root away
    /// and creating a fresh folder in its place is the unprivileged stand-in.
    #[test]
    fn vault_root_replaced_in_place_reports_vault_lost() {
        let outer = tempfile::tempdir().unwrap();
        let base = crate::fsops::canonical_root(outer.path()).unwrap();
        let root = base.join("vault");
        std::fs::create_dir(&root).unwrap();

        let (tx, rx) = channel();
        let _w =
            VaultWatcher::start(&root, Arc::new(Mutex::new(SelfWrites::new())), sink_to(tx))
                .unwrap();
        std::thread::sleep(Duration::from_millis(300));

        std::fs::rename(&root, base.join("vault-away")).unwrap();
        std::fs::create_dir(&root).unwrap();

        assert_eq!(wait_lost(&rx, Duration::from_secs(5)), Some(root));
    }

    /// An atomic save by another program (temp file, then rename over the
    /// note) must reach the open note the way an in-place write does.  Both
    /// temp shapes: hidden (gedit, Cairn's own) and visible (Kate's QSaveFile).
    #[test]
    fn an_external_rename_over_reaches_the_ui() {
        let dir = tempfile::tempdir().unwrap();
        let root = crate::fsops::canonical_root(dir.path()).unwrap();
        let note = root.join("Open.md");
        std::fs::write(&note, b"before\n").unwrap();

        let sw = Arc::new(Mutex::new(SelfWrites::new()));
        let (tx, rx) = channel();
        let _w = VaultWatcher::start(&root, Arc::clone(&sw), sink_to(tx)).unwrap();
        std::thread::sleep(Duration::from_millis(300));

        for (tmp, body) in [
            (".goutputstream-XYZ", &b"saved by gedit\n"[..]),
            ("Open.md.Qk3xYz", &b"saved by kate, longer\n"[..]),
        ] {
            let tmp = root.join(tmp);
            std::fs::write(&tmp, body).unwrap();
            std::fs::rename(&tmp, &note).unwrap();
            let hits = hits_for(&rx, Duration::from_millis(1500));
            let hit = hits.iter().find(|h| h.abs == note);
            assert!(
                hit.is_some_and(|h| h.len == body.len() as u64),
                "rename-over via {tmp:?} produced no content hit for the note: {hits:?}"
            );
        }
    }

    /// The classifier half of the rename-over rule, with no filesystem timing:
    /// a name ARRIVING at an existing note is a content hit AND marks its
    /// directory (the name may be new to the tree); a name LEAVING is not.
    #[test]
    fn a_name_arriving_at_an_existing_note_is_a_content_hit() {
        use notify::event::{ModifyKind, RenameMode};
        let dir = tempfile::tempdir().unwrap();
        let root = crate::fsops::canonical_root(dir.path()).unwrap();
        let note = root.join("n.md");
        std::fs::write(&note, b"12345").unwrap();
        let gone = root.join("gone.md");
        let sw = Mutex::new(SelfWrites::new());

        for mode in [RenameMode::To, RenameMode::Any] {
            let mut b = Flush::default();
            classify(&root, &ev(EventKind::Modify(ModifyKind::Name(mode)), &[&note]), &sw, &mut b, Epoch::TEST);
            assert_eq!(b.content_hits.len(), 1, "{mode:?}");
            assert_eq!(b.content_hits[0].len, 5);
            assert_eq!(b.dirs, vec![root.clone()], "{mode:?}");
        }
        let mut b = Flush::default();
        classify(
            &root,
            &ev(EventKind::Modify(ModifyKind::Name(RenameMode::Both)), &[&gone, &note]),
            &sw,
            &mut b,
            Epoch::TEST,
        );
        assert_eq!(b.content_hits.iter().map(|h| h.abs.clone()).collect::<Vec<_>>(), vec![note.clone()]);

        let mut b = Flush::default();
        classify(&root, &ev(EventKind::Modify(ModifyKind::Name(RenameMode::From)), &[&gone]), &sw, &mut b, Epoch::TEST);
        assert!(b.content_hits.is_empty());
        assert_eq!(b.dirs, vec![root.clone()]);
    }

    /// The scanner refuses symlinks (§7.3 case 12), so the watcher must not
    /// walk into them either: a linked `~/code` would otherwise cost one
    /// inotify watch per directory and a whole-vault repair per build.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_symlinked_directory_is_not_watched() {
        let outer = tempfile::tempdir().unwrap();
        let base = crate::fsops::canonical_root(outer.path()).unwrap();
        let root = base.join("vault");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("a.md"), b"x").unwrap();
        let target = base.join("target");
        std::fs::create_dir_all(target.join("build/obj")).unwrap();
        std::os::unix::fs::symlink(&target, root.join("Projects")).unwrap();

        let (tx, rx) = channel();
        let _w =
            VaultWatcher::start(&root, Arc::new(Mutex::new(SelfWrites::new())), sink_to(tx))
                .unwrap();
        std::thread::sleep(Duration::from_millis(300));

        for i in 0..10 {
            std::fs::write(target.join(format!("build/obj/{i}.o")), b"obj").unwrap();
            std::fs::write(target.join(format!("build/obj/{i}.md")), b"md").unwrap();
        }
        let flushes = drain_flush(&rx, Duration::from_millis(1500));
        assert!(flushes.is_empty(), "the watcher followed a symlink the scanner refuses: {flushes:?}");

        let walked = crate::scan::walk_vault(&root, crate::tree::SortMode::default(), 1).unwrap();
        assert!(walked.tree.resolve("Projects").is_none(), "premise: the scanner refuses the link");
    }

    /// Echo suppression outlives SELF_WRITE_TTL while the file still carries
    /// our fingerprint.  A late event for our own save (a slow flush, a sync
    /// client's xattr, a chmod) must not reach the open note as external
    /// content: the frontend would reload it and drop its undo history.
    #[test]
    fn an_expired_fingerprint_still_matches_while_the_file_is_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let root = crate::fsops::canonical_root(dir.path()).unwrap();
        let note = root.join("a.md");
        let sw = Mutex::new(SelfWrites::new());
        atomic_self_write(&root, &note, b"ours\n", &sw);
        let other = root.join("b.md");
        std::fs::write(&other, b"other\n").unwrap();

        for e in &mut sw.lock().unwrap().entries {
            e.deadline = Instant::now() - Duration::from_secs(60);
        }
        assert!(sw.lock().unwrap().matches_for(&note), "matching must not read the deadline");

        // Another record collects expired entries, but not one the disk still carries.
        let md = std::fs::metadata(&other).unwrap();
        record_self_write(&sw, SelfWrite::existing(&other, crate::fsops::mtime_ns(&md), md.len()));
        assert!(sw.lock().unwrap().matches_for(&note), "GC dropped a fingerprint still on disk");

        // Once the file moves on, the expired entry is dead and is collected.
        std::fs::write(&note, b"somebody else\n").unwrap();
        record_self_write(&sw, SelfWrite::existing(&other, crate::fsops::mtime_ns(&md), md.len()));
        assert_eq!(sw.lock().unwrap().len(), 1, "a dead, expired entry survived GC");
    }

    /// The identity rule on its own: the same directory is still here; a
    /// missing path, a file, or a DIFFERENT directory at the same path is not.
    /// An error that is not "it is gone" (here EACCES) is not loss.
    #[test]
    fn root_identity_detects_loss_but_not_the_same_directory() {
        use std::os::unix::fs::PermissionsExt;
        let outer = tempfile::tempdir().unwrap();
        let base = crate::fsops::canonical_root(outer.path()).unwrap();
        let root = base.join("vault");
        std::fs::create_dir(&root).unwrap();
        let id = RootId::of(&root).unwrap();
        assert!(!id.gone_from(&root));

        std::fs::rename(&root, base.join("away")).unwrap();
        assert!(id.gone_from(&root), "missing");
        std::fs::create_dir(&root).unwrap();
        assert!(id.gone_from(&root), "a different directory at the same path");
        std::fs::remove_dir(&root).unwrap();
        std::fs::write(&root, b"").unwrap();
        assert!(id.gone_from(&root), "a file at the same path");
        assert!(id.gone_from(&root.join("x")), "ENOTDIR");

        let away = base.join("away");
        let id = RootId::of(&away).unwrap();
        let locked = base.join("locked");
        std::fs::create_dir(&locked).unwrap();
        std::fs::rename(&away, locked.join("away")).unwrap();
        let moved = locked.join("away");
        let id_moved = RootId::of(&moved).unwrap();
        assert_eq!(id, id_moved);
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
        let denied = std::fs::symlink_metadata(&moved).is_err();
        let still = !id.gone_from(&moved);
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
        if denied {
            assert!(still, "EACCES was read as a lost vault");
        }
    }

    /// An overflow re-arms the watches BEFORE its flush is sunk (the flush's
    /// repair walk must cover what the new watches missed), a failing re-arm
    /// is reported once, and an ordinary event re-arms nothing.
    #[test]
    fn an_overflow_rewatches_before_its_flush_and_reports_a_failure_once() {
        use notify::event::Flag;
        let dir = tempfile::tempdir().unwrap();
        let root = crate::fsops::canonical_root(dir.path()).unwrap();
        let id = RootId::of(&root).unwrap();
        let log: Arc<Mutex<Vec<String>>> = Arc::default();
        // Each inner Vec is sent together and then left to flush on its own.
        let run = |batches: Vec<Vec<Event>>, fail: bool| {
            log.lock().unwrap().clear();
            let (tx, rx) = channel::<notify::Result<Event>>();
            let sw = Mutex::new(SelfWrites::new());
            let sink_log = Arc::clone(&log);
            let sink = move |e: WatchEvent| {
                let tag = match e {
                    WatchEvent::Flush(f) => format!("flush full={}", f.full_rescan),
                    WatchEvent::Degraded { reason, .. } => format!("degraded {}", reason.as_str()),
                    WatchEvent::VaultLost { .. } => "lost".into(),
                };
                sink_log.lock().unwrap().push(tag);
            };
            let rw_log = Arc::clone(&log);
            let rewatch = move || {
                rw_log.lock().unwrap().push("rewatch".into());
                if fail {
                    Err(notify::Error::new(notify::ErrorKind::MaxFilesWatch))
                } else {
                    Ok(())
                }
            };
            let t = std::thread::spawn({
                let root = root.clone();
                move || coalesce(&root, &rx, &sw, &sink, Epoch::TEST, id, &rewatch)
            });
            for batch in batches {
                for e in batch {
                    tx.send(Ok(e)).unwrap();
                }
                std::thread::sleep(DEBOUNCE * 3);
            }
            drop(tx);
            t.join().unwrap();
            log.lock().unwrap().clone()
        };
        let overflow = || Event::new(EventKind::Other).set_flag(Flag::Rescan);
        let linux = cfg!(target_os = "linux");

        let got = run(vec![vec![overflow()]], false);
        if linux {
            assert_eq!(got, vec!["rewatch", "flush full=true"]);
        } else {
            assert_eq!(got, vec!["flush full=true"]);
        }

        if linux {
            let got = run(vec![vec![overflow(), overflow()], vec![overflow()]], true);
            assert_eq!(
                got,
                vec!["rewatch", "degraded watch-limit", "flush full=true", "rewatch", "flush full=true"]
            );
        }

        let plain = ev(
            EventKind::Create(notify::event::CreateKind::File),
            &[root.join("n.md").as_path()],
        );
        let got = run(vec![vec![plain]], false);
        assert_eq!(got, vec!["flush full=false"], "an ordinary event re-armed the watcher");
    }

    /// The re-arm itself, against the real kernel: a directory whose inotify
    /// watch is gone (what an overflow leaves behind for one whose create
    /// event was dropped) is watched again, and already watched ones are not
    /// disturbed.
    #[cfg(target_os = "linux")]
    #[test]
    fn rewatch_restores_a_lost_directory_watch() {
        let dir = tempfile::tempdir().unwrap();
        let root = crate::fsops::canonical_root(dir.path()).unwrap();
        std::fs::create_dir(root.join("sub")).unwrap();
        std::fs::create_dir(root.join("kept")).unwrap();

        let (tx, rx) = channel();
        let w = VaultWatcher::start(&root, Arc::new(Mutex::new(SelfWrites::new())), sink_to(tx))
            .unwrap();
        std::thread::sleep(Duration::from_millis(300));

        assert!(drop_inotify_watch(&root.join("sub")), "premise: sub/ was watched");
        std::fs::write(root.join("sub/x.md"), b"x").unwrap();
        assert!(drain_flush(&rx, Duration::from_millis(800)).is_empty(), "premise: sub/ is unwatched");

        let weak = Arc::downgrade(w.watcher.as_ref().unwrap());
        rewatch(&weak, &root).unwrap();
        std::thread::sleep(Duration::from_millis(50));

        for d in ["sub", "kept"] {
            std::fs::write(root.join(d).join("y.md"), b"y").unwrap();
            let dirs: Vec<PathBuf> =
                drain_flush(&rx, Duration::from_millis(1500)).into_iter().flat_map(|f| f.dirs).collect();
            assert!(dirs.contains(&root.join(d)), "{d}/ is not watched after the re-arm: {dirs:?}");
        }
    }

    /// Finds this process's inotify watch on `dir` through `/proc/self/fdinfo`
    /// and removes it.  Inode numbers are unique among live files, so parallel
    /// tests' watches are never touched.
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
            let Some(n) = fd.file_name().to_str().and_then(|s| s.parse::<i32>().ok()) else {
                continue;
            };
            let info = std::fs::read_to_string(format!("/proc/self/fdinfo/{n}")).unwrap_or_default();
            for line in info.lines().filter(|l| l.starts_with("inotify wd:")) {
                let field = |k: &str| {
                    line.split_whitespace()
                        .find_map(|t| t.strip_prefix(k))
                        .and_then(|v| u64::from_str_radix(v, 16).ok())
                };
                if field("ino:") == Some(ino) {
                    let wd = field("wd:").unwrap() as i32;
                    // SAFETY: a plain syscall on an fd this process owns.
                    assert_eq!(unsafe { libc::inotify_rm_watch(n, wd) }, 0);
                    found = true;
                }
            }
        }
        found
    }

    /// fsops records every write twice (before and after the rename).  The
    /// second record must refresh the first, not spend a second slot of eight.
    #[test]
    fn recording_the_same_fingerprint_twice_takes_one_slot() {
        let mut s = SelfWrites::new();
        s.record(SelfWrite::existing("/v/a.md", 7, 7));
        s.record(SelfWrite::existing("/v/a.md", 7, 7));
        assert_eq!(s.len(), 1);
    }

    /// The live form of the rule above: a metadata-only change (chmod, an
    /// xattr) to a file we saved, classified after the TTL, is not a content
    /// hit.
    #[test]
    fn a_metadata_change_to_our_own_save_is_not_external_after_the_ttl() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let root = crate::fsops::canonical_root(dir.path()).unwrap();
        let note = root.join("Open.md");
        std::fs::write(&note, b"before\n").unwrap();

        let sw = Arc::new(Mutex::new(SelfWrites::new()));
        let (tx, rx) = channel();
        let _w = VaultWatcher::start(&root, Arc::clone(&sw), sink_to(tx)).unwrap();
        std::thread::sleep(Duration::from_millis(300));

        atomic_self_write(&root, &note, b"after\n", &sw);
        assert!(drain_flush(&rx, Duration::from_millis(800)).is_empty(), "premise: no echo");

        for e in &mut sw.lock().unwrap().entries {
            e.deadline = Instant::now() - Duration::from_secs(60);
        }
        std::fs::set_permissions(&note, std::fs::Permissions::from_mode(0o600)).unwrap();

        let flushes = drain_flush(&rx, Duration::from_millis(1500));
        assert!(
            flushes.iter().all(|f| f.content_hits.is_empty()),
            "a chmod of our own save surfaced as external content: {flushes:?}"
        );
    }
}
