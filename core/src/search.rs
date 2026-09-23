//! core/src/search.rs — Owner: 05.
//! Spec: CONTRACT.md §4 (the search engine, B4/B20/B5/M47/M48/M29/M40/M64),
//! §4.2 (the `Arc<VaultSnapshot>` seam, X14), §4.3 (generation, X15),
//! §4.4 (search policy), §4.5 (the constants), §8.5 (threads and locks),
//! gate G4.  spec-05 carries the internal design detail.
//!
//! spec-05's ENGINE SHIPS, with two corrections (B4/B20/M47): FOUR threads, not
//! eight, and NO PERSISTENT POOL.  spec-05 §5.8's eight permanent threads are
//! STRUCK, and so is spec-02 §8 in its entirety along with §11.6's `SearchHit` /
//! `SearchEvent` and §1.3's rejection of `nucleo`.  The tokio runtime is 2
//! workers / 6 blocking, and the blocking count is LOAD-BEARING: the search
//! coordinator holds one slot for a whole search (M40).
//!
//! Gate G4: <= 65 ms over the 10 MB corpus, 4 threads.  THE GATE CORPUS IS THE
//! 10 MB ONE; the 25 MB corpus is informational.
//!
//! THE FRONTEND OWNS THE GENERATION NUMBER (§4.3, X15).  A vault switch CANCELS
//! rather than bumping.  Search never uses the global event bus: it uses the
//! per-call `Channel<SearchMsg>` (§1.3 command 14, §1.4).
//!
//! CLIPPY DENY LIST (§6.2, gate G7) applies to this module.
//!
//! NO THIRD-PARTY MATCHER.  `nucleo-matcher` (MPL-2.0) was the filename phase's
//! and is REMOVED with it (§0.33 E79): filename search is a case-insensitive
//! substring match written here.  The content phase's `grep-searcher` /
//! `grep-matcher` / `memchr` are unaffected.
//!
//! ## What this file does NOT contain
//!
//! No command surface (that is `napi/src/lib.rs`, owner 07) and no window, event or
//! state wiring.  The three entry points the shell calls are [`start`],
//! [`expand`] and [`cancel`], and each is one line at the call site.
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use grep_matcher::Matcher as _;
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::{BinaryDetection, MmapChoice, Searcher, SearcherBuilder, Sink, SinkMatch};
use serde::Serialize;

use crate::error::VaultError;

/* ─────────────────────────────────────────────────────────────────────────────
 * 1.  CONSTANTS — CONTRACT §4.5, verbatim.  Declared once, here (spec-05 §4.4).
 * ────────────────────────────────────────────────────────────────────────── */

/// AMENDED from spec-05's 8 (B4/B20/M47); spawned per query, no persistent pool.
pub const SEARCH_THREADS: usize = 4;
pub const MAX_TOKENS: usize = 8;
pub const MAX_FILES: usize = 200;
pub const MAX_TOTAL_MATCHES: usize = 1_000;
pub const MAX_SNIPPETS_PER_FILE: usize = 8;
pub const MAX_SNIPPETS_IPC: usize = 2;
pub const MAX_RANGES_PER_LINE: usize = 8;
pub const SNIPPET_WINDOW_CHARS: usize = 260;
pub const CHUNK: usize = 32;
/// 64 KiB line buffer per `Searcher`.  This is ALSO the longest line the
/// searcher can handle: a note with one line longer than this is `skipped`.
pub const HEAP_LIMIT_BYTES: usize = 1 << 16;
pub const REGEX_SIZE_LIMIT: usize = 1 << 20;
/// AMENDED from 4 MiB (M47): 4 MiB x 4 workers is a 16 MB worst case against
/// 13 MB of measured headroom.  1 MiB x 4 = 4 MB, which is what §8 carries.
pub const REGEX_DFA_SIZE_LIMIT: usize = 1 << 20;
pub const BATCH_FLUSH_MS: u64 = 16;
pub const BATCH_MAX_GROUPS: usize = 8;
pub const BATCH_MAX_BYTES: usize = 6_000;
pub const MIN_CONTENT_QUERY_CHARS: usize = 2;
pub const CONTENT_DEBOUNCE_MS: u64 = 90;
/// == MAX_NOTE_BYTES; larger => name-only.
pub const MAX_SCAN_BYTES: u64 = 8 * 1024 * 1024;

/// spec-05 §7.2/§7.3, not §4.5: the Files section is capped at 20 and always
/// fully visible.  Named here so the cap cannot drift into the panel's CSS.
pub const MAX_FILENAME_HITS: usize = 20;

/// The debounce is slept in slices this long so a superseded coordinator does
/// not hold a tokio blocking slot doing nothing (spec-05 §5.8 step 4).
const DEBOUNCE_SLICE_MS: u64 = 15;

/* ─────────────────────────────────────────────────────────────────────────────
 * 2.  THE SEAM — CONTRACT §4.2.
 * ────────────────────────────────────────────────────────────────────────── */

/// The `Arc<VaultSnapshot>` seam (CONTRACT §4.2, B5/M48, X14).
///
/// The types belong to `tree.rs` (owner 02); they are named through it directly
/// so there is no second declaration site.
///
/// **`NoteEntry.size` is always 0** — `Node` has no size field and cannot grow
/// one (gate G1 pins it at 24 bytes), and §4.2 costs the snapshot build as one
/// pass over the arena with NO I/O.  `MAX_SCAN_BYTES` is therefore enforced by
/// the searcher at open time, from the length it has in hand once the file is
/// open; see `worker_main`.  A consumer that reads `size` as a size sees every
/// note in the vault as empty.
use crate::tree::{NoteEntry, VaultSnapshot};

/* ─────────────────────────────────────────────────────────────────────────────
 * 3.  WIRE TYPES — CONTRACT §1.5.  camelCase on the wire, no exceptions (X13).
 * ────────────────────────────────────────────────────────────────────────── */

/// CONTRACT §1.5.  **All offsets are UTF-16 code units** — an acceptance
/// criterion, not a preference (§4.4, M29/M64).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    /// 1-based line number in the file.
    pub line: u32,
    /// The (possibly windowed) line text, EOL already trimmed.  Never > 262
    /// chars: `SNIPPET_WINDOW_CHARS` plus at most two ellipses.
    pub text: String,
    /// Highlight ranges inside `text`, UTF-16 units, ascending, non-overlapping.
    pub ranges: Vec<(u32, u32)>,
    /// UTF-16 column of the first match in the ORIGINAL full line.
    pub col: u32,
    /// UTF-16 length of that match.
    pub len: u32,
}

/// `id` indexes `VaultSnapshot.files` — the FILES-ONLY index space, which is NOT
/// the TreeBlob node index space (the blob also contains directories).  It is
/// valid only for the `gen` it arrived on and is usable only as a DOM key;
/// anything that has to find a tree row resolves it BY PATH (`rel`).  (X14)
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileGroup {
    pub id: u32,
    pub rel: String,
    pub name: String,
    pub name_ranges: Vec<(u32, u32)>,
    /// <= `MAX_SNIPPETS_IPC` on the wire; the rest via `search_expand`.
    pub snippets: Vec<Snippet>,
    pub match_count: u32,
    /// True when the per-file snippet cap was hit, i.e. `match_count` is a floor.
    pub more: bool,
    /// spec-05 §5.5: `(kind, u32::MAX - match_count, id)`, ascending.
    /// `kind` 0 = the query matched the file NAME, 1 = content only.
    pub rank: (u8, u32, u32),
}

/// CONTRACT §1.5.  `rename_all` on an enum renames its VARIANTS;
/// `rename_all_fields` is what makes `total_matches` arrive as `totalMatches`.
/// Both are required.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum SearchMsg {
    /// Filename hits.  Sent BEFORE any I/O, always first, may be empty.
    Files { gen: u64, groups: Vec<FileGroup> },
    /// Zero or more, in arrival order — never final order (spec-05 §6.3).
    Batch { gen: u64, groups: Vec<FileGroup> },
    /// Exactly one, always last, INCLUDING for a superseded generation
    /// (`cancelled: true`).  It is what guarantees the coordinator's blocking
    /// slot is released.
    Complete {
        gen: u64,
        /// The authoritative rank-sorted sequence of CONTENT group ids.  The
        /// frontend applies it with ONE DOM reorder (§4.4).
        order: Vec<u32>,
        total_matches: u32,
        total_files: u32,
        /// Files whose content was actually READ.  Feeds §8.6's zero-result
        /// line, "Searched 5,000 notes in 48 ms".
        scanned: u32,
        /// Files the scan could not or would not read: vanished since the
        /// snapshot, unreadable, over `MAX_SCAN_BYTES`, or holding a single line
        /// over `HEAP_LIMIT_BYTES`.  ONE bucket on purpose — the user's question
        /// is "did anything get missed", not "why".  `scanned + skipped` is
        /// every entry in the snapshot the workers reached.
        skipped: u32,
        truncated: bool,
        /// True when smart case ENGAGED, i.e. the query carried an uppercase
        /// letter and the match is therefore case-sensitive.  Drives the count
        /// line's ` · case-sensitive` suffix (spec-05 §8.5).
        smart_case: bool,
        cancelled: bool,
        /// The content scan's own elapsed time, EXCLUDING `CONTENT_DEBOUNCE_MS`
        /// — the number gate G4 gates.  For a query too short to scan, the
        /// filename phase's time.
        elapsed_ms: f64,
    },
    /// TERMINAL for its generation: a bad regex.  No `Complete` follows.
    Error { gen: u64, message: String },
}

/// Where a `SearchMsg` goes.
///
/// In the app this is the shell's per-call IPC channel, which owns the only
/// implementation.  (§1.2: search results are
/// JSON over the per-call channel, ordered and lossless in 23/23 runs including
/// four sender threads and 20,000 messages — spike B §4).  It is a trait so the
/// engine can be driven from a test without a webview, which is the only way
/// `search_int.rs` can assert message ORDER at all.
pub trait MsgSink {
    fn send(&self, msg: SearchMsg);
}

/* ─────────────────────────────────────────────────────────────────────────────
 * 4.  AT-REST STATE — spec-05 §4.2, CONTRACT §4.3 (X15).
 * ────────────────────────────────────────────────────────────────────────── */

/// The whole of search's at-rest state.  Lives in `AppState` as one field.
///
/// **The generation has exactly one writer, and it is the frontend** (X15).
/// `generation` is not a counter Rust increments — it is the
/// last-seen-generation record: `search_start` STORES the number it was handed
/// and every `SearchMsg` echoes it back.  A vault switch does not touch it; it
/// calls [`SearchState::cancel_all`], which is generation-independent and
/// therefore cannot collide with a number the frontend is about to issue.
///
/// `Clone` is two `Arc` bumps.  It exists because the coordinator runs on a
/// `spawn_blocking` thread and must own its handle to this state; spec-05 §4.2's
/// "one `AtomicU64` and one empty `Vec`" at-rest cost is unchanged in substance
/// — an empty `Vec` allocates nothing, and the two `Arc` headers are 32 bytes.
/// `(generation, that job's cancellation flag)`.
type LiveJob = (u64, Arc<AtomicBool>);

#[derive(Clone, Default)]
pub struct SearchState {
    /// The NEWEST generation the frontend has handed us. Anything whose `gen`
    /// differs is garbage.
    generation: Arc<AtomicU64>,
    /// Live jobs, so a vault switch can cancel generation-INDEPENDENTLY (§4.3).
    /// Pushed at job construction, removed on EVERY coordinator exit path, so it
    /// is empty at rest.
    live: Arc<Mutex<Vec<LiveJob>>>,
}

impl SearchState {
    /// Record the frontend's number.  Rust never invents, bumps or reorders it.
    pub fn observe_generation(&self, gen: u64) {
        self.generation.store(gen, Ordering::Relaxed);
    }

    #[must_use]
    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::Relaxed)
    }

    /// `search_cancel(gen)` — command 16.  Records the number (the frontend owns
    /// it, and a cancel is the newest thing it has said) and flags the job that
    /// carries it, if it is still running.
    pub fn cancel(&self, gen: u64) {
        self.observe_generation(gen);
        for (g, flag) in lock(&self.live).iter() {
            if *g == gen {
                flag.store(true, Ordering::Relaxed);
            }
        }
    }

    /// CONTRACT §4.3: what `open_vault` calls instead of bumping a counter.
    /// Sets every live job's `cancelled` flag.  MUST be called BEFORE the
    /// outgoing `Vault` is dropped, so every in-flight worker sees a cancelled
    /// job at its next check and the last `Arc<VaultSnapshot>` holder goes away
    /// on its own.
    pub fn cancel_all(&self) {
        for (_, flag) in lock(&self.live).iter() {
            flag.store(true, Ordering::Relaxed);
        }
    }

    /// Live job count.  Zero at rest; the invariant `search_int.rs` asserts.
    #[must_use]
    pub fn live_jobs(&self) -> usize {
        lock(&self.live).len()
    }

    fn register(&self, gen: u64, flag: &Arc<AtomicBool>) {
        lock(&self.live).push((gen, Arc::clone(flag)));
    }

    fn unregister(&self, flag: &Arc<AtomicBool>) {
        lock(&self.live).retain(|(_, f)| !Arc::ptr_eq(f, flag));
    }
}

/// Poison-tolerant lock (spec-05 §5.9).  A poisoned mutex here means a worker
/// panicked; the partial results already pushed are still valid.  Recover, never
/// propagate — and never `.unwrap()`, which gate G7 denies.
#[inline]
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/* ─────────────────────────────────────────────────────────────────────────────
 * 5.  QUERY PARSING — spec-05 §5.1 / §5.2 / §5.3.
 * ────────────────────────────────────────────────────────────────────────── */

/// There is no configuration, no toggle and no settings screen anywhere in the
/// product: this function is the whole query language.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Query {
    Empty,
    /// 1..=`MAX_TOKENS` literal tokens.  AND across the file, OR per line.
    Literal(Vec<String>),
    /// A user regex, not yet compiled.
    Regex(String),
}

/// `/pattern/` is the regex escape hatch, with at least one character between
/// the slashes — so `/` and `//` are literals, not regexes (spec-05 §13).
#[must_use]
pub fn parse(raw: &str) -> Query {
    let q = raw.trim();
    if q.is_empty() {
        return Query::Empty;
    }
    if q.len() >= 3 && q.starts_with('/') && q.ends_with('/') {
        // G7: `q[1..q.len()-1]` is denied; `get` cannot fail here, and the
        // fallback is a literal rather than a panic.
        if let Some(inner) = q.get(1..q.len() - 1) {
            return Query::Regex(inner.to_string());
        }
    }
    Query::Literal(q.split_whitespace().take(MAX_TOKENS).map(str::to_string).collect())
}

impl Query {
    /// The text the matcher actually sees — used for the smart-case report and
    /// for the minimum-length test.
    fn needle(&self) -> String {
        match self {
            Query::Empty => String::new(),
            Query::Literal(t) => t.join(" "),
            Query::Regex(p) => p.clone(),
        }
    }

    /// True when smart case ENGAGED: the query carries an uppercase letter, so
    /// matching is case-sensitive (spec-05 §5.2, ripgrep's `-S`).
    fn smart_case_engaged(&self) -> bool {
        self.needle().chars().any(char::is_uppercase)
    }
}

/// spec-05 §5.3, exact.  `case_smart(true)`, NOT `case_insensitive(true)`.
fn build_matcher(pattern: &str, literal: bool) -> Result<RegexMatcher, String> {
    RegexMatcherBuilder::new()
        .case_smart(true)
        .fixed_strings(literal)
        .multi_line(false)
        .line_terminator(Some(b'\n'))
        .size_limit(REGEX_SIZE_LIMIT)
        .dfa_size_limit(REGEX_DFA_SIZE_LIMIT)
        .build(pattern)
        .map_err(one_line)
}

fn build_matcher_many(pats: &[String]) -> Result<RegexMatcher, String> {
    RegexMatcherBuilder::new()
        .case_smart(true)
        .fixed_strings(true)
        .multi_line(false)
        .line_terminator(Some(b'\n'))
        .size_limit(REGEX_SIZE_LIMIT)
        .dfa_size_limit(REGEX_DFA_SIZE_LIMIT)
        .build_many(pats)
        .map_err(one_line)
}

fn one_line(e: grep_regex::Error) -> String {
    e.to_string().lines().next().unwrap_or("invalid pattern").to_string()
}

/// `any` drives the `Searcher` (one pass, SIMD-prefiltered).  `tokens` is used
/// only on lines that already matched, to compute the per-file AND bitmask.
/// Using the SAME engine for both is what keeps the AND check and the highlight
/// ranges in agreement — a hand-rolled second check with `memmem` and
/// `to_lowercase` would disagree with it on `ß`/`SS`.
struct Matchers {
    any: RegexMatcher,
    tokens: Vec<RegexMatcher>,
    token_mask_full: u32,
}

fn build_matchers(q: &Query) -> Result<Matchers, String> {
    match q {
        Query::Empty => Err("empty query".to_string()),
        Query::Regex(p) => Ok(Matchers {
            any: build_matcher(p, false)?,
            tokens: Vec::new(),
            token_mask_full: 0,
        }),
        Query::Literal(toks) => {
            let any = build_matcher_many(toks)?;
            let mut tokens = Vec::with_capacity(toks.len());
            for t in toks {
                tokens.push(build_matcher(t, true)?);
            }
            // `toks.len() <= MAX_TOKENS == 8` is enforced by `parse`, so the
            // shift can never reach 32.
            let token_mask_full = if tokens.is_empty() {
                0
            } else {
                (1u32 << tokens.len()) - 1
            };
            Ok(Matchers { any, tokens, token_mask_full })
        }
    }
}

/* ─────────────────────────────────────────────────────────────────────────────
 * 6.  THE JOB — spec-05 §4.2.
 * ────────────────────────────────────────────────────────────────────────── */

struct Job {
    gen: u64,
    /// Shared with `SearchState`; half of the staleness test.
    generation: Arc<AtomicU64>,
    /// This job's own flag; set by `cancel(gen)` and by `cancel_all()`.
    cancelled: Arc<AtomicBool>,
    /// **Pinned for the whole life of the job** (CONTRACT §4.2).  Files deleted
    /// mid-scan surface as `skipped += 1`; files created mid-scan appear on the
    /// next search.  The old `Arc` stays alive exactly as long as its last
    /// holder, so an in-flight search's paths can never dangle and can never be
    /// rewritten under it.
    snapshot: Arc<VaultSnapshot>,
    m: Matchers,
    /// Ids of the files the FILENAME phase matched — the `kind` component of the
    /// rank key (spec-05 §5.5).
    name_hits: HashSet<u32>,
    cursor: AtomicUsize,
    files_hit: AtomicUsize,
    matches_total: AtomicUsize,
    /// Files whose content was actually read.
    scanned: AtomicUsize,
    /// Unreadable / deleted / oversized-line / oversized-file.  One bucket on
    /// purpose: the user's question is "did anything get missed", not "why".
    skipped: AtomicUsize,
    out: Mutex<Vec<FileGroup>>,
    /// Every emitted group's rank key, kept separately because `out` is DRAINED
    /// as the search runs — by the time `Complete` is built the groups
    /// themselves are already on the wire, and `order` still has to name all of
    /// them (§4.4: ONE DOM reorder, not an insertion-sorted live list).
    ranks: Mutex<Vec<(u8, u32, u32)>>,
    /// Workers still running, plus the condvar the coordinator waits on.  A
    /// condvar, NOT spec-05 §4.2's struck `workers_done` spin: the coordinator
    /// must wake the instant the last worker exits, because polling at the
    /// 16 ms batch cadence would add up to 16 ms of dead time to every search
    /// and gate G4 has 16 ms of margin in total.
    left: Mutex<usize>,
    done: Condvar,
}

/// The ONE staleness test, used at every check site.  Two relaxed loads.
#[inline]
fn stale(job: &Job) -> bool {
    job.generation.load(Ordering::Relaxed) != job.gen || job.cancelled.load(Ordering::Relaxed)
}

/* ─────────────────────────────────────────────────────────────────────────────
 * 7.  UTF-16 AND SNIPPETS — spec-05 §5.6.
 * ────────────────────────────────────────────────────────────────────────── */

#[inline]
fn utf16_len(s: &str) -> u32 {
    s.chars().map(|c| c.len_utf16() as u32).sum()
}

#[inline]
fn trim_eol(b: &[u8]) -> &[u8] {
    let b = b.strip_suffix(b"\n").unwrap_or(b);
    b.strip_suffix(b"\r").unwrap_or(b)
}

/// A window of at most `max_chars` characters centred on the match, snapped to
/// `char` boundaries.  Returns `(slice, byte_offset, needs_lead_ellipsis,
/// needs_trail_ellipsis)`.
fn window(text: &str, first_start: usize, max_chars: usize) -> (&str, usize, bool, bool) {
    let total = text.chars().count();
    if total <= max_chars {
        return (text, 0, false, false);
    }
    let match_ci = text.get(..first_start).map_or(0, |s| s.chars().count());
    // Put the match about a third of the way in, so there is context on both
    // sides and the eye lands on the highlight rather than on the ellipsis.
    let want = match_ci.saturating_sub(max_chars / 3);
    let start_ci = want.min(total - max_chars);
    let end_ci = start_ci + max_chars;

    let mut off = text.len();
    let mut end = text.len();
    for (ci, (bi, _)) in text.char_indices().enumerate() {
        if ci == start_ci {
            off = bi;
        }
        if ci == end_ci {
            end = bi;
            break;
        }
    }
    let slice = text.get(off..end).unwrap_or(text);
    (slice, off, start_ci > 0, end_ci < total)
}

/// spec-05 §5.6.  Lossy-decode FIRST, then match the decoded bytes: matching raw
/// bytes and mapping offsets through a lossy decode is where off-by-N bugs live,
/// because U+FFFD is 3 bytes where the invalid input may have been 1.
fn make_snippet(raw: &[u8], line: u32, any: &RegexMatcher, tokens_on_line: u8) -> (Snippet, u8) {
    let text: String = String::from_utf8_lossy(raw).into_owned();

    let mut byte_ranges: Vec<(usize, usize)> = Vec::new();
    let _ = any.find_iter(text.as_bytes(), |mm| {
        byte_ranges.push((mm.start(), mm.end()));
        byte_ranges.len() < MAX_RANGES_PER_LINE
    });

    let first = byte_ranges.first().copied().unwrap_or((0, 0));
    let col = utf16_len(text.get(..first.0).unwrap_or(""));
    let len = utf16_len(text.get(first.0..first.1).unwrap_or(""));

    let (slice, off, lead, trail) = window(&text, first.0, SNIPPET_WINDOW_CHARS);

    let mut out = String::with_capacity(slice.len() + 6);
    if lead {
        out.push('…');
    }
    let base = u32::from(lead);
    out.push_str(slice);
    if trail {
        out.push('…');
    }

    let ranges = byte_ranges
        .iter()
        .filter(|(a, b)| *a >= off && *b <= off + slice.len())
        .map(|(a, b)| {
            (
                base + utf16_len(slice.get(..a - off).unwrap_or("")),
                base + utf16_len(slice.get(..b - off).unwrap_or("")),
            )
        })
        .collect();

    (Snippet { line, text: out, ranges, col, len }, tokens_on_line)
}

/* ─────────────────────────────────────────────────────────────────────────────
 * 8.  THE PER-FILE SINK — spec-05 §5.4.
 * ────────────────────────────────────────────────────────────────────────── */

struct GroupSink<'a> {
    job: &'a Job,
    /// `(snippet, tokens_on_line)` — the second element is the snippet sort key.
    snippets: Vec<(Snippet, u8)>,
    match_count: u32,
    seen_mask: u32,
}

impl Sink for GroupSink<'_> {
    type Error = std::io::Error;

    fn matched(&mut self, _s: &Searcher, m: &SinkMatch<'_>) -> Result<bool, std::io::Error> {
        // Cancellation, checked per matched line: a 100 MB note matching on
        // every line aborts within ONE line, not after 100 MB.
        if stale(self.job) {
            return Ok(false);
        }

        self.match_count = self.match_count.saturating_add(1);
        let raw = trim_eol(m.bytes());

        let mut line_mask = 0u32;
        for (i, tm) in self.job.m.tokens.iter().enumerate() {
            if tm.is_match(raw).unwrap_or(false) {
                line_mask |= 1 << i;
            }
        }
        self.seen_mask |= line_mask;

        if self.snippets.len() < MAX_SNIPPETS_PER_FILE {
            let line_no = m.line_number().unwrap_or(0) as u32;
            self.snippets.push(make_snippet(
                raw,
                line_no,
                &self.job.m.any,
                line_mask.count_ones() as u8,
            ));
        }

        // Stop only when we can no longer learn anything.  `max_matches(8)` on
        // the Searcher would be WRONG here: stopping after 8 lines could miss
        // the line carrying the last AND token and would silently drop the file.
        let and_satisfied = self.seen_mask == self.job.m.token_mask_full;
        Ok(!(and_satisfied && self.snippets.len() >= MAX_SNIPPETS_PER_FILE))
    }
}

/// spec-05 §5.4.  One per worker thread, reused for every file that thread
/// claims.  `MmapChoice::never()` is non-negotiable (§4.1: `memmap2` is linked
/// and never exercised).
fn build_searcher() -> Searcher {
    SearcherBuilder::new()
        .line_number(true)
        .multi_line(false)
        .binary_detection(BinaryDetection::quit(b'\x00'))
        .memory_map(MmapChoice::never())
        .heap_limit(Some(HEAP_LIMIT_BYTES))
        .bom_sniffing(true)
        .build()
}

fn build_group(id: u32, entry: &NoteEntry, sink: GroupSink<'_>, name_hit: bool) -> FileGroup {
    let mut snippets = sink.snippets;
    // spec-05 §5.5: lines covering more of the query first, then document order.
    snippets.sort_by_key(|(s, toks)| (u8::MAX - *toks, s.line));
    let more = snippets.len() >= MAX_SNIPPETS_PER_FILE;
    FileGroup {
        id,
        rel: entry.rel.to_string(),
        name: entry.name().to_string(),
        name_ranges: Vec::new(),
        snippets: snippets.into_iter().map(|(s, _)| s).collect(),
        match_count: sink.match_count,
        more,
        rank: (
            u8::from(!name_hit),
            u32::MAX - sink.match_count,
            id,
        ),
    }
}

/* ─────────────────────────────────────────────────────────────────────────────
 * 8b.  SECRET NOTES — user feature, 2026-09-16.
 *
 * A note whose frontmatter carries `cairn-type: secrets` is a credentials
 * file.  Its bytes must never reach a snippet: the search panel is the worst
 * place in the app for a seed or an API key to surface.  So these files are
 * never content-scanned — while staying FILENAME-reachable, exactly like a
 * note above `MAX_SCAN_BYTES`.  A name match opens the file in the secrets
 * viewer; it just never contributes content hits.
 *
 * The marker is deliberately the same string the frontend's secrets viewer
 * keys on (`src/secrets.ts`), checked with the same strictness as
 * `frontmatterEnd`: line 1 EXACTLY `---`, a closing line EXACTLY `---`, and
 * the marker as its own line in between.
 *
 * The viewer decides on the EDITOR's text, not on the file's bytes, so this
 * side reproduces that text: one leading BOM stripped and each CRLF made LF
 * (`note_frame::normalise`, the read path), then lines split the way
 * CodeMirror splits a document (`\r\n`, `\r` or `\n`).  A BOM or CR-only
 * secrets note is therefore excluded here exactly when it is masked there.
 * Only the head is read: 4 KiB, and more only while the 64-line walk is still
 * undecided (a long frontmatter), up to `MAX_SCAN_BYTES`.  The viewer caps
 * lines, not bytes, and this side must never be less inclusive than it.
 * ────────────────────────────────────────────────────────────────────────── */

/// The first read of a file's head; it grows only while the walk is undecided.
const SECRET_HEAD_BYTES: usize = 4096;
/// Bounds the line walk below; the marker the app writes is on line 2.
const SECRET_HEAD_LINES: usize = 64;

/// CodeMirror's default line split (`/\r\n?|\n/`).  The text after the last
/// break is yielded only when `last` says the text is the whole file.
struct EditorLines<'a> {
    rest: Option<&'a [u8]>,
    last: bool,
}

impl<'a> Iterator for EditorLines<'a> {
    type Item = &'a [u8];

    fn next(&mut self) -> Option<&'a [u8]> {
        let rest = self.rest?;
        let Some(i) = rest.iter().position(|b| *b == b'\n' || *b == b'\r') else {
            self.rest = None;
            return if self.last { Some(rest) } else { None };
        };
        let crlf = rest.get(i) == Some(&b'\r') && rest.get(i + 1) == Some(&b'\n');
        self.rest = rest.get(i + if crlf { 2 } else { 1 }..);
        rest.get(..i)
    }
}

/// The viewer's verdict on a file whose first bytes are `head`, or `None` when
/// the head ends before the walk can decide.  `eof` says `head` is the whole
/// file; otherwise its last, possibly incomplete line is not looked at.
fn classify_head(head: &[u8], eof: bool) -> Option<bool> {
    // Most notes stop here, without the copy below: line 1 cannot be `---`.
    let body = head.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(head);
    if !body.starts_with(b"---") {
        // Under 6 bytes a BOM and the opener may both still be arriving.
        return if eof || head.len() >= 6 { Some(false) } else { None };
    }
    let (mut text, _) = crate::note_frame::normalise(head.to_vec());
    if !eof {
        // A trailing `\r` may yet pair with a `\n` (and `\r\r\n` is one break
        // after `normalise`), so it is not known to end a line yet.  The text
        // after the last known break is never walked (`last: eof`): it may be
        // a line cut short.
        while text.last() == Some(&b'\r') {
            text.pop();
        }
    }
    let mut lines = EditorLines { rest: Some(&text), last: eof };
    match lines.next() {
        Some(b"---") => {}
        Some(_) => return Some(false),
        None => return if eof { Some(false) } else { None },
    }
    // The closer is REQUIRED, exactly like `frontmatterEnd`: an unclosed `---`
    // is a thematic break, not frontmatter, and the frontend's viewer applies
    // the same rule — so the two detectors always agree on what a secret is.
    // NO TRIMMING anywhere: `frontmatterEnd` compares exact lines, and an
    // indented marker is a nested YAML key, not this file's type tag.
    let mut seen_marker = false;
    let mut walked = 0;
    for line in lines.take(SECRET_HEAD_LINES) {
        walked += 1;
        if line == b"---" {
            return Some(seen_marker);
        }
        if line == b"cairn-type: secrets" {
            seen_marker = true;
        }
    }
    if eof || walked == SECRET_HEAD_LINES { Some(false) } else { None }
}

/// The whole-head predicate, for the unit tests' vectors.
#[cfg(test)]
fn is_secret_head(head: &[u8]) -> bool {
    classify_head(head, true) == Some(true)
}

/// Whether the file `r` reads from (at its start) is a secrets note.  Shared
/// with `tree.rs`'s secret-note set (§8b's detector in one place): the tree
/// mark, the search exclusion and the viewer must always agree on what a
/// secret is.  `None` on a read error.  A file whose head is still undecided
/// at `MAX_SCAN_BYTES` is not a secret: it is too large to open or to scan.
pub(crate) fn read_secret_verdict(r: &mut impl std::io::Read) -> Option<bool> {
    let cap = usize::try_from(MAX_SCAN_BYTES).unwrap_or(usize::MAX);
    let mut buf: Vec<u8> = Vec::new();
    let mut want = SECRET_HEAD_BYTES;
    loop {
        let mut eof = false;
        while buf.len() < want {
            let have = buf.len();
            buf.resize(want, 0);
            let got = r.read(buf.get_mut(have..)?).ok()?;
            buf.truncate(have + got);
            if got == 0 {
                eof = true;
                break;
            }
        }
        if let Some(secret) = classify_head(&buf, eof) {
            return Some(secret);
        }
        if eof || want > cap {
            return Some(false);
        }
        // One byte past the cap, so a file of exactly `MAX_SCAN_BYTES` still
        // reaches its end.
        want = want.saturating_mul(2).min(cap.saturating_add(1));
    }
}

/// True when the open file is a secrets note.  Reads the head (see
/// `read_secret_verdict`) and seeks back to 0, so the caller can hand the file
/// to the searcher unchanged.  An unreadable head is NOT a secret: the scan
/// then proceeds and its own error path (`skipped`) applies as before.
fn file_is_secret(file: &mut std::fs::File) -> bool {
    use std::io::{Seek, SeekFrom};
    let secret = read_secret_verdict(file).unwrap_or(false);
    // Restore the offset whatever the answer was: a `false` here falls
    // through to `search_file`, which must see the whole file.
    let _ = file.seek(SeekFrom::Start(0));
    secret
}

/* ─────────────────────────────────────────────────────────────────────────────
 * 9.  THE WORKER LOOP — spec-05 §5.7.
 * ────────────────────────────────────────────────────────────────────────── */

fn worker_main(job: &Arc<Job>) {
    let mut searcher = build_searcher();
    loop {
        if stale(job) {
            return;
        }
        if job.files_hit.load(Ordering::Relaxed) >= MAX_FILES {
            return;
        }
        if job.matches_total.load(Ordering::Relaxed) >= MAX_TOTAL_MATCHES {
            return;
        }

        let start = job.cursor.fetch_add(CHUNK, Ordering::Relaxed);
        if start >= job.snapshot.files.len() {
            return;
        }
        let end = (start + CHUNK).min(job.snapshot.files.len());

        for i in start..end {
            if stale(job) {
                return;
            }
            let Some(entry) = job.snapshot.files.get(i) else { return };

            // A note above the 8 MiB read cap stays reachable by filename but is
            // never content-scanned.  It counts as skipped, not scanned.
            //
            // The length comes from the OPEN FILE, not from `entry.size`, and
            // that is not a preference: `NoteEntry.size` is always 0 (tree.rs —
            // `Node` is 24 bytes by gate G1 and the snapshot build does no I/O),
            // so testing it would let every note through.  `File::open` +
            // `fstat` is the same open `search_path` would have done plus one
            // cheap `fstat`, and it is the only place the size is knowable
            // without a second `stat` per file across the whole vault.  The
            // `entry.size` test is kept in front of it as a free short-circuit
            // for the day the walker does fill the field in.
            if u64::from(entry.size) > MAX_SCAN_BYTES {
                job.skipped.fetch_add(1, Ordering::Relaxed);
                continue;
            }

            let abs = job.snapshot.root.join(&*entry.rel);
            let Ok(mut file) = std::fs::File::open(&abs) else {
                // Deleted between the snapshot and the scan.
                job.skipped.fetch_add(1, Ordering::Relaxed);
                continue;
            };
            if file.metadata().map(|m| m.len()).unwrap_or(0) > MAX_SCAN_BYTES {
                job.skipped.fetch_add(1, Ordering::Relaxed);
                continue;
            }
            // §8b: a secrets note stays filename-reachable but contributes no
            // content hits — its bytes must never reach a snippet.  Counted as
            // skipped, like an oversized note, so `scanned + skipped` still
            // covers every entry the workers reached.
            if file_is_secret(&mut file) {
                job.skipped.fetch_add(1, Ordering::Relaxed);
                continue;
            }

            let mut sink = GroupSink {
                job,
                snippets: Vec::new(),
                match_count: 0,
                seen_mask: 0,
            };
            job.scanned.fetch_add(1, Ordering::Relaxed);
            if searcher.search_file(&job.m.any, &file, &mut sink).is_err() {
                // Unreadable, or a single line over HEAP_LIMIT_BYTES.
                job.skipped.fetch_add(1, Ordering::Relaxed);
                continue;
            }
            if sink.match_count == 0 {
                continue;
            }
            if sink.seen_mask != job.m.token_mask_full {
                continue; // AND across the file not satisfied
            }
            job.matches_total.fetch_add(sink.match_count as usize, Ordering::Relaxed);
            if job.files_hit.fetch_add(1, Ordering::Relaxed) >= MAX_FILES {
                return;
            }
            let id = i as u32;
            let name_hit = job.name_hits.contains(&id);
            // `out` is contended only when a file actually MATCHES — at most 200
            // times per search — so a plain Mutex<Vec<_>> beats any channel.
            let group = build_group(id, entry, sink, name_hit);
            lock(&job.ranks).push(group.rank);
            lock(&job.out).push(group);
        }
    }
}

/// Spawn failure is not fatal and is not a panic (§5.9): fewer workers is
/// slower, and if none start at all the coordinator scans on its own thread.
fn spawn_workers(job: &Arc<Job>) -> Vec<std::thread::JoinHandle<()>> {
    let mut handles = Vec::with_capacity(SEARCH_THREADS);
    for _ in 0..SEARCH_THREADS {
        let j = Arc::clone(job);
        // The scan is iterative; 8 MiB of stack reserve per thread is waste.
        let spawned = std::thread::Builder::new()
            .name("nc-search".into())
            .stack_size(256 * 1024)
            .spawn(move || {
                worker_main(&j);
                let mut n = lock(&j.left);
                *n = n.saturating_sub(1);
                if *n == 0 {
                    j.done.notify_all();
                }
            });
        match spawned {
            Ok(h) => handles.push(h),
            Err(_) => {
                let mut n = lock(&job.left);
                *n = n.saturating_sub(1);
                if *n == 0 {
                    job.done.notify_all();
                }
            }
        }
    }
    handles
}

/* ─────────────────────────────────────────────────────────────────────────────
 * 10.  THE FILENAME PATH — spec-05 §7.
 * ────────────────────────────────────────────────────────────────────────── */

/* §0.33 E79 — `char_indices_to_utf16_spans` AND `push_span` ARE DELETED HERE.
 * They existed to post-process nucleo's char-index output (sort, dedup, merge
 * adjacent runs, convert to UTF-16), and the fuzzy matcher that produced it is
 * gone.  A substring match needs none of it: its spans are already sorted,
 * already non-overlapping and already contiguous, so `substring_spans_utf16`
 * below is the whole of what replaces ~50 lines.  spec-05 §7.2's "three
 * mandatory post-processing steps" describe a matcher this app no longer has. */

/// Filename hits: no disk, 100-500x faster than the content path, which is what
/// makes the panel feel instant.  Capped at `MAX_FILENAME_HITS`.
///
/// § 0.33 E79 — SUBSTRING, CASE-INSENSITIVE.  **NOT FUZZY**, and that is a user
/// ruling that overrides spec-05 §7.2.
///
/// It was `nucleo-matcher`, a strict SUBSEQUENCE match, and spec-05 defended it
/// with *"on this corpus `conf` correctly returns 0 results because no path
/// contains `c…o…n…f` in order"*.  That defence holds only for queries made of
/// rare letters.  The user searched **`test`** — four of the commonest letters
/// in English — in a vault of long snake_case names, and got
/// `feedback_clear_site_da**t**a_fr**es**h_boo**t**` as its first hit: a real
/// subsequence, not a match by any reading a person would accept.
///
/// **AND THE ALGORITHM WAS IN THE WRONG PANEL.** Fuzzy subsequence is
/// Obsidian's QUICK SWITCHER (⌘O).  Its SEARCH panel matches substrings.
/// spec-05 §7.3 records that Cairn has no quick switcher — so the quick
/// switcher's matcher ended up in Search by default, never by decision.
///
/// The whole matcher is now `str::find` on a lowercased haystack, which also
/// removes the last consumer of `nucleo-matcher` and its MPL-2.0 notice.
///
/// ALL OCCURRENCES ARE HIGHLIGHTED, not just the first: a name that contains
/// the query twice is a better hit than one that contains it once, and showing
/// only the first would misreport why the row is there.
///
/// LOWERCASING IS ASCII-ONLY BY DESIGN.  `to_lowercase()` can change a string's
/// LENGTH (`İ` -> `i̇`, one char to two), which would put every span after it at
/// the wrong offset; `to_ascii_lowercase` is length-preserving by construction,
/// so a span found in the lowered haystack is valid in the original.  The cost
/// is that a query for `STRASSE` does not match `straße` — Obsidian's search
/// does not either.
fn filename_hits(snapshot: &VaultSnapshot, raw: &str) -> Vec<FileGroup> {
    let q = raw.trim();
    if q.is_empty() {
        return Vec::new();
    }

    // Matching the whole path always makes deep vaults noisy, so the full path
    // is used only when the query itself contains a '/'.  Unchanged from the
    // fuzzy implementation; it is about WHICH haystack, not how it is matched.
    let use_path = q.contains('/');
    let needle = q.to_ascii_lowercase();

    let mut hits: Vec<(u32, u32)> = Vec::with_capacity(64);
    let mut hay_lower = String::new();
    for (i, e) in snapshot.files.iter().enumerate() {
        let hay = if use_path { &*e.rel } else { e.name() };
        hay_lower.clear();
        hay_lower.extend(hay.chars().map(|c| c.to_ascii_lowercase()));
        let n = count_occurrences(&hay_lower, &needle);
        if n > 0 {
            hits.push((n, i as u32));
        }
    }
    // Most occurrences first, then tree order — the same shape the fuzzy path
    // had (score desc, then index asc), with a count where the score was.  A
    // count is the honest ranking signal for a substring match: there is no
    // "how well does it match", only "how often".
    hits.sort_unstable_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    hits.truncate(MAX_FILENAME_HITS);

    let mut groups = Vec::with_capacity(hits.len());
    for (_, id) in hits {
        let Some(e) = snapshot.files.get(id as usize) else { continue };
        let hay = if use_path { &*e.rel } else { e.name() };
        // Ranges are always expressed inside `name`, which is what the row
        // displays; a '/'-query highlights nothing rather than highlighting at
        // path offsets the row does not render.  Unchanged.
        let name_ranges =
            if use_path { Vec::new() } else { substring_spans_utf16(hay, &needle) };
        groups.push(FileGroup {
            id,
            rel: e.rel.to_string(),
            name: e.name().to_string(),
            name_ranges,
            snippets: Vec::new(),
            match_count: 0,
            more: false,
            rank: (0, u32::MAX, id),
        });
    }
    groups
}

/// Non-overlapping occurrences of `needle` in an already-lowercased `hay`.
/// Both are ASCII-lowercased by the caller, so this is a plain byte search.
fn count_occurrences(hay: &str, needle: &str) -> u32 {
    if needle.is_empty() {
        return 0;
    }
    let mut n = 0u32;
    let mut from = 0usize;
    while let Some(at) = hay[from..].find(needle) {
        n = n.saturating_add(1);
        from += at + needle.len();
    }
    n
}

/// Every occurrence of `needle` in `hay`, as UTF-16 spans over `hay`.
///
/// `hay` is the ORIGINAL string and `needle` is already ASCII-lowercased; the
/// haystack is lowered here the same length-preserving way, so a byte offset
/// found in the lowered copy indexes the original correctly.
///
/// The frontend slices by UTF-16 code units (§4.3), so byte offsets are
/// converted the same way `char_indices_to_utf16_spans` converts char indices —
/// the two differ for any astral-plane character, e.g. an emoji in a filename.
fn substring_spans_utf16(hay: &str, needle: &str) -> Vec<(u32, u32)> {
    if needle.is_empty() {
        return Vec::new();
    }
    let lower: String = hay.chars().map(|c| c.to_ascii_lowercase()).collect();
    let mut out: Vec<(u32, u32)> = Vec::new();
    let mut from = 0usize;
    while let Some(at) = lower[from..].find(needle) {
        let bstart = from + at;
        let bend = bstart + needle.len();
        // Byte offsets -> UTF-16 code units, counted over the ORIGINAL string.
        let u16_start: u32 = hay[..bstart].chars().map(|c| c.len_utf16() as u32).sum();
        let u16_len: u32 = hay[bstart..bend].chars().map(|c| c.len_utf16() as u32).sum();
        out.push((u16_start, u16_start + u16_len));
        from = bend;
    }
    out
}

/* ─────────────────────────────────────────────────────────────────────────────
 * 11.  BATCHING — CONTRACT §4.4, spike B.
 * ────────────────────────────────────────────────────────────────────────── */

/// Cheap upper estimate of a group's serialised size.  Deliberately an estimate
/// and not `serde_json::to_vec(..).len()`: `BATCH_MAX_BYTES` is a COMFORT
/// MARGIN, not a hard requirement — spike B measured no cliff at 8 KB, and a
/// 250-group batch at 32 KB per message was the fastest configuration tried.
/// Serialising every group twice to honour a soft bound would be the expensive
/// mistake.
fn group_bytes(g: &FileGroup) -> usize {
    let snip: usize = g
        .snippets
        .iter()
        .map(|s| 60 + s.text.len() + s.ranges.len() * 12)
        .sum();
    90 + g.rel.len() + g.name.len() + g.name_ranges.len() * 12 + snip
}

/// Cut `drained` into messages of at most `BATCH_MAX_GROUPS` groups or
/// `BATCH_MAX_BYTES` bytes, whichever comes first, truncating each group's
/// snippets to `MAX_SNIPPETS_IPC` on the way out.
///
/// This is the whole reason batching exists: `Channel::send` costs
/// 16.3-16.4 µs PER MESSAGE regardless of payload, so 5,000 unbatched hits would
/// be 82 ms of main-thread eval (spike B).  With `MAX_FILES = 200` the whole
/// result set is ~25 messages ≈ 0.4 ms.
fn flush_batches<S: MsgSink>(sink: &S, gen: u64, drained: Vec<FileGroup>) {
    let mut msg: Vec<FileGroup> = Vec::with_capacity(BATCH_MAX_GROUPS);
    let mut bytes = 0usize;
    for mut g in drained {
        g.snippets.truncate(MAX_SNIPPETS_IPC);
        let b = group_bytes(&g);
        if !msg.is_empty() && (msg.len() >= BATCH_MAX_GROUPS || bytes + b > BATCH_MAX_BYTES) {
            sink.send(SearchMsg::Batch { gen, groups: std::mem::take(&mut msg) });
            bytes = 0;
        }
        bytes += b;
        msg.push(g);
    }
    if !msg.is_empty() {
        sink.send(SearchMsg::Batch { gen, groups: msg });
    }
}

/* ─────────────────────────────────────────────────────────────────────────────
 * 12.  THE COORDINATOR — spec-05 §5.8.
 * ────────────────────────────────────────────────────────────────────────── */

/// The coordinator, synchronous.  [`start`] runs this on a tokio BLOCKING
/// thread, where it occupies **one of the six blocking slots for the duration of
/// the search** — which is exactly why `max_blocking_threads` is 6 and not 4
/// (CONTRACT §8.5, M40).
///
/// It is `pub` and takes its snapshot by argument so `search_int.rs` can drive
/// the real engine with a real fixture and no webview.  The ordering below is
/// spec-05 §5.8's, and steps 0 and 7 bracket EVERY exit path — which is what
/// keeps `SearchState.live` empty between queries and makes `cancel_all()`
/// O(live jobs).
pub fn run_search<S: MsgSink>(
    state: &SearchState,
    snapshot: Arc<VaultSnapshot>,
    query: &str,
    gen: u64,
    sink: &S,
) {
    // 0. register
    let cancelled = Arc::new(AtomicBool::new(false));
    state.register(gen, &cancelled);
    let guard = LiveGuard { state, flag: &cancelled };

    let parsed = parse(query);
    let smart_case = parsed.smart_case_engaged();
    let t0 = Instant::now();

    // 1. staleness — superseded before we did anything at all.
    //
    // spec-05 §5.8 step 1 says "return without sending anything"; §6.1 says
    // `Complete` is sent "exactly one, always last, INCLUDING for a generation
    // that was superseded".  The second wins, and every early return below sends
    // one: it is what guarantees this task terminates and releases its blocking
    // slot, the frontend drops it on the ordinary `gen` rule, and a `Complete`
    // that is sometimes omitted is a promise the frontend cannot rely on.
    if state.generation.load(Ordering::Relaxed) != gen || cancelled.load(Ordering::Relaxed) {
        sink.send(complete_empty(gen, smart_case, true, t0));
        drop(guard);
        return;
    }

    if matches!(parsed, Query::Empty) {
        sink.send(SearchMsg::Files { gen, groups: Vec::new() });
        sink.send(complete_empty(gen, smart_case, false, t0));
        drop(guard);
        return;
    }

    // Compile BEFORE the filename phase, so an invalid regex is one Error and
    // nothing else.  This ordering is deliberate and it is the one place where
    // "`Files` is always first" (spec-05 §6.1) yields: spec-05 §8.6 makes
    // `invalid regex` a panel STATE that replaces the result list, so sending
    // filename hits and then an error would put results behind an error banner.
    // Error is TERMINAL for its generation — no `Complete` follows, which is
    // also why the live entry is dropped here rather than at the bottom.
    let matchers = match build_matchers(&parsed) {
        Ok(m) => m,
        Err(message) => {
            sink.send(SearchMsg::Error { gen, message });
            drop(guard);
            return;
        }
    };

    // 2. filename phase — no debounce, no I/O, sent before
    //    anything is opened.  This is what §6.3 depends on.
    let name_groups = filename_hits(&snapshot, query);
    let name_hits: HashSet<u32> = name_groups.iter().map(|g| g.id).collect();
    sink.send(SearchMsg::Files { gen, groups: name_groups });

    // 3. too short to scan content
    if parsed.needle().chars().count() < MIN_CONTENT_QUERY_CHARS {
        sink.send(complete_empty(gen, smart_case, false, t0));
        drop(guard);
        return;
    }

    // 4. content debounce, slept in slices so a superseded coordinator is not
    //    holding a blocking slot doing nothing while the user is still typing.
    let deadline = Instant::now() + Duration::from_millis(CONTENT_DEBOUNCE_MS);
    while Instant::now() < deadline {
        if state.generation.load(Ordering::Relaxed) != gen || cancelled.load(Ordering::Relaxed) {
            sink.send(complete_empty(gen, smart_case, true, t0));
            drop(guard);
            return;
        }
        let left = deadline.saturating_duration_since(Instant::now());
        std::thread::sleep(left.min(Duration::from_millis(DEBOUNCE_SLICE_MS)));
    }

    // 5. scan.  `t_scan` — not `t0` — is what gate G4 gates.
    let t_scan = Instant::now();
    let job = Arc::new(Job {
        gen,
        generation: Arc::clone(&state.generation),
        cancelled: Arc::clone(&cancelled),
        snapshot,
        m: matchers,
        name_hits,
        cursor: AtomicUsize::new(0),
        files_hit: AtomicUsize::new(0),
        matches_total: AtomicUsize::new(0),
        scanned: AtomicUsize::new(0),
        skipped: AtomicUsize::new(0),
        out: Mutex::new(Vec::new()),
        ranks: Mutex::new(Vec::new()),
        left: Mutex::new(SEARCH_THREADS),
        done: Condvar::new(),
    });

    let handles = spawn_workers(&job);
    if handles.is_empty() {
        // Not one thread started.  Scan here rather than return nothing.
        worker_main(&job);
    }

    loop {
        let finished = {
            let n = lock(&job.left);
            let (n, _) = job
                .done
                .wait_timeout_while(n, Duration::from_millis(BATCH_FLUSH_MS), |n| *n > 0)
                .unwrap_or_else(|p| {
                    let (g, t) = p.into_inner();
                    (g, t)
                });
            *n == 0
        };
        let drained: Vec<FileGroup> = std::mem::take(&mut *lock(&job.out));
        if !drained.is_empty() {
            flush_batches(sink, gen, drained);
        }
        if finished || stale(&job) {
            break;
        }
    }

    for h in handles {
        let _ = h.join();
    }
    // Anything a worker pushed between the last drain and its exit.
    let tail: Vec<FileGroup> = std::mem::take(&mut *lock(&job.out));
    if !tail.is_empty() {
        flush_batches(sink, gen, tail);
    }

    // 6. one Complete, carrying the authoritative order.
    //
    // AT THE CAP THE COUNTS ARE A FLOOR, DELIBERATELY.  A worker whose
    // `files_hit.fetch_add` came back >= MAX_FILES returns WITHOUT pushing its
    // group, but it has already added that file's lines to `matches_total` — so
    // up to SEARCH_THREADS-1 files can be counted and not shown.  `total_files`
    // is clamped to MAX_FILES, which makes `groups.len() == total_files` hold
    // exactly (every `fetch_add` below the cap pushed).  Making `total_matches`
    // exact would need a second pass or a lock on the counting, and §8.5 renders
    // `1000+ matches in 200+ files · stopped` at the cap anyway — the number is
    // not shown as an exact figure at precisely the point where it is not one.
    let mut ordered: Vec<(u8, u32, u32)> = lock(&job.ranks).clone();
    ordered.sort_unstable();
    let order: Vec<u32> = ordered.into_iter().map(|(_, _, id)| id).collect();

    let files = job.files_hit.load(Ordering::Relaxed).min(MAX_FILES) as u32;
    let matches = job.matches_total.load(Ordering::Relaxed) as u32;
    let truncated = job.files_hit.load(Ordering::Relaxed) >= MAX_FILES
        || job.matches_total.load(Ordering::Relaxed) >= MAX_TOTAL_MATCHES;

    sink.send(SearchMsg::Complete {
        gen,
        order,
        total_matches: matches,
        total_files: files,
        scanned: job.scanned.load(Ordering::Relaxed) as u32,
        skipped: job.skipped.load(Ordering::Relaxed) as u32,
        truncated,
        smart_case,
        cancelled: stale(&job),
        elapsed_ms: t_scan.elapsed().as_secs_f64() * 1000.0,
    });

    // 7. deregister — done by `guard` on every path, including the early ones.
    drop(guard);
}

/// Step 7 of spec-05 §5.8, made unmissable: the entry leaves `live` on every
/// exit path, including a panic unwinding out of the coordinator.
struct LiveGuard<'a> {
    state: &'a SearchState,
    flag: &'a Arc<AtomicBool>,
}

impl Drop for LiveGuard<'_> {
    fn drop(&mut self) {
        self.state.unregister(self.flag);
    }
}

fn complete_empty(gen: u64, smart_case: bool, cancelled: bool, t0: Instant) -> SearchMsg {
    SearchMsg::Complete {
        gen,
        order: Vec::new(),
        total_matches: 0,
        total_files: 0,
        scanned: 0,
        skipped: 0,
        truncated: false,
        smart_case,
        cancelled,
        elapsed_ms: t0.elapsed().as_secs_f64() * 1000.0,
    }
}

/* ─────────────────────────────────────────────────────────────────────────────
 * 13.  THE THREE ENTRY POINTS THE SHELL CALLS — spec-05 §6.1.
 *
 * No command surface appears in this file.  `napi/src/lib.rs` (owner 07) is the only
 * file that carries them, at <= 10 lines per command and no logic (§1.1, X12).
 * ────────────────────────────────────────────────────────────────────────── */

/// Command 14, `search_start`.
///
/// **Stores the generation FIRST THING** — before parsing, before touching the
/// snapshot, before the coordinator is spawned.  It does not invent or increment
/// it: the frontend owns the number and Rust records the newest one it has seen
/// (X15, §4.3).
///
/// Returns as soon as the coordinator is spawned; it never awaits the scan.  The
/// coordinator must be a BLOCKING task — `search_path` is blocking file I/O, and
/// putting it on one of the two async workers would stall every other command
/// (spec-05 §5.8 rule 1).
///
/// The command-layer body this enables is one line:
///
/// ```ignore
/// search::start(&state.search, state.snapshot()?, query, generation, on_event).await
/// ```
///
/// # Errors
/// Never, today: a malformed query is a `SearchMsg::Error` on the channel, not a
/// command failure, because the command has already returned by the time the
/// pattern is compiled.  The `Result` is CONTRACT §1.3's signature and is kept
/// so a "no vault" case has somewhere to go when the shell resolves the
/// snapshot.
pub async fn start<S>(
    state: &SearchState,
    snapshot: Arc<VaultSnapshot>,
    query: String,
    generation: u64,
    on_event: S,
) -> Result<(), VaultError>
where
    S: MsgSink + Send + 'static,
{
    state.observe_generation(generation);
    let st = state.clone();
    crate::spawn_blocking(move || {
        run_search(&st, snapshot, &query, generation, &on_event);
    });
    Ok(())
}

/// Command 16, `search_cancel`.  The frontend passes back a number IT issued;
/// Rust records it and flags the matching live job.
pub fn cancel(state: &SearchState, generation: u64) {
    state.cancel(generation);
}

/// Command 15, `search_expand`.
///
/// Re-greps ONE file at call time — ~20 µs — and answers with up to
/// `MAX_SNIPPETS_PER_FILE` snippets.  It re-greps rather than reading a backend
/// cache because that is correctness for free: if the file changed since the
/// scan the user gets the CURRENT snippets, and there is no per-search snippet
/// cache to hold in memory (spec-05 §11.3).
///
/// A file that has been deleted is `Ok(vec![])`, **not** a `notFound`
/// `VaultError`: an empty vector is the honest answer to "what does this file
/// match now", and it keeps a routine race off the error path.  A pattern that
/// no longer compiles is the same — the user is expanding a result that a
/// successful search produced, so it is unreachable in practice, and a
/// structured error here has no `VaultError` variant to land in (§1.5 is closed).
///
/// # Errors
/// `InvalidPath` when `rel` is not a vault-relative note path.  That check is
/// this module's own, minimal one; see [`safe_rel`].
pub fn expand(root: &Path, query: &str, rel: &str) -> Result<Vec<Snippet>, VaultError> {
    let abs = safe_rel(root, rel)?;
    // §8b: a filename hit on a secrets note must not expand into snippets —
    // the content scan never saw it, so there is nothing to expand.
    if let Ok(mut f) = std::fs::File::open(&abs) {
        if file_is_secret(&mut f) {
            return Ok(Vec::new());
        }
    }
    let parsed = parse(query);
    let Ok(m) = build_matchers(&parsed) else { return Ok(Vec::new()) };

    let job = Job {
        gen: 0,
        generation: Arc::new(AtomicU64::new(0)),
        cancelled: Arc::new(AtomicBool::new(false)),
        snapshot: Arc::new(VaultSnapshot { root: root.to_path_buf(), files: Vec::new(), epoch: 0 }),
        m,
        name_hits: HashSet::new(),
        cursor: AtomicUsize::new(0),
        files_hit: AtomicUsize::new(0),
        matches_total: AtomicUsize::new(0),
        scanned: AtomicUsize::new(0),
        skipped: AtomicUsize::new(0),
        out: Mutex::new(Vec::new()),
        ranks: Mutex::new(Vec::new()),
        left: Mutex::new(0),
        done: Condvar::new(),
    };
    let mut sink = GroupSink { job: &job, snippets: Vec::new(), match_count: 0, seen_mask: 0 };
    if build_searcher().search_path(&job.m.any, &abs, &mut sink).is_err() {
        return Ok(Vec::new());
    }
    let mut snippets = sink.snippets;
    snippets.sort_by_key(|(s, toks)| (u8::MAX - *toks, s.line));
    Ok(snippets.into_iter().map(|(s, _)| s).collect())
}

/// The traversal guard for the ONE path search resolves that did not come out of
/// a snapshot (§7.3 case 13).
///
/// `path::validate_rel_for_lookup` (owner 02) is the rule, and it is a DIFFERENT
/// function from `validate_name` (M52) — a name that must be REJECTED on
/// creation may still have to be RESOLVED if it already exists on disk.  Search
/// adds exactly one condition of its own: the target must be a note, because
/// `validate_rel_for_lookup` accepts `""` (the vault root) and every directory,
/// and there is nothing to grep in either.
///
/// No normalisation is performed — NFC/NFD normalisation is STRUCK (§6.4, M41)
/// and must not be quietly added back: normalising a path changes which file on
/// disk a name refers to.
fn safe_rel(root: &Path, rel: &str) -> Result<PathBuf, VaultError> {
    crate::path::validate_rel_for_lookup(rel)?;
    if !crate::path::is_md(rel) {
        return Err(VaultError::InvalidPath {
            path: rel.to_string(),
            reason: "not a note".to_string(),
        });
    }
    let mut out = root.to_path_buf();
    for seg in rel.split('/') {
        out.push(seg);
    }
    Ok(out)
}

/* ─────────────────────────────────────────────────────────────────────────────
 * 14.  UNIT TESTS — the pure functions.  The engine itself is exercised against
 *      a real fixture vault in `tests/search_int.rs`.
 * ────────────────────────────────────────────────────────────────────────── */

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]
mod tests {
    use super::*;

    #[test]
    fn constants_match_contract_4_5() {
        // CONTRACT §4.5 is normative and these are the amended values, not
        // spec-05's originals.  A silent drift here changes the memory budget
        // (§8) and gate G4 at once.
        assert_eq!(SEARCH_THREADS, 4, "AMENDED from spec-05's 8 (B4/B20/M47)");
        assert_eq!(REGEX_DFA_SIZE_LIMIT, 1 << 20, "AMENDED from 4 MiB (M47)");
        assert_eq!(HEAP_LIMIT_BYTES, 1 << 16);
        assert_eq!(MAX_TOKENS, 8);
        assert_eq!(MAX_FILES, 200);
        assert_eq!(MAX_TOTAL_MATCHES, 1_000);
        assert_eq!(MAX_SNIPPETS_PER_FILE, 8);
        assert_eq!(MAX_SNIPPETS_IPC, 2);
        assert_eq!(MAX_RANGES_PER_LINE, 8);
        assert_eq!(SNIPPET_WINDOW_CHARS, 260);
        assert_eq!(CHUNK, 32);
        assert_eq!(REGEX_SIZE_LIMIT, 1 << 20);
        assert_eq!(BATCH_FLUSH_MS, 16);
        assert_eq!(BATCH_MAX_GROUPS, 8);
        assert_eq!(BATCH_MAX_BYTES, 6_000);
        assert_eq!(MIN_CONTENT_QUERY_CHARS, 2);
        assert_eq!(CONTENT_DEBOUNCE_MS, 90);
        assert_eq!(MAX_SCAN_BYTES, 8 * 1024 * 1024);
    }

    #[test]
    fn secret_marker_is_recognised_and_nothing_else_is() {
        // The file the app writes: marker on line 2.
        assert!(is_secret_head(b"---\ncairn-type: secrets\n---\n"));
        // Other keys around it are fine, before and after.
        assert!(is_secret_head(b"---\ntitle: Creds\ncairn-type: secrets\n---\nbody"));
        assert!(is_secret_head(b"---\ncairn-type: secrets\ntitle: Creds\n---\nbody"));
        // CRLF vaults (checked out on Windows, opened here).
        assert!(is_secret_head(b"---\r\ncairn-type: secrets\r\n---\r\n"));

        // Everything else is an ordinary note and MUST stay searchable —
        // a false positive here silently removes a note from content search.
        // NOTHING is trimmed: `frontmatterEnd` compares exact lines, and an
        // indented marker is a nested YAML key, not this file's type tag.
        assert!(!is_secret_head(b""));
        assert!(!is_secret_head(b"---\n"));
        assert!(!is_secret_head(b"no frontmatter at all\ncairn-type: secrets\n"));
        assert!(!is_secret_head(b"--- \ncairn-type: secrets\n---\n"), "opener with trailing space");
        assert!(!is_secret_head(b"----\ncairn-type: secrets\n----\n"), "four dashes is a break");
        assert!(!is_secret_head(b" ---\ncairn-type: secrets\n---\n"), "indented opener");
        assert!(!is_secret_head(b"---\ncairn-type: secrets\n"), "no closer at all");
        assert!(!is_secret_head(b"---\ntitle: x\n---\ncairn-type: secrets\n"), "marker after the closer");
        assert!(!is_secret_head(b"---\n  cairn-type: secrets\n---\n"), "indented marker is nested YAML");
        assert!(!is_secret_head(b"---\ncairn-type: secrets \n---\n"), "trailing space on the marker");
        assert!(!is_secret_head(b"---\ncairn-type: secret\n---\n"), "near-miss value");
        assert!(!is_secret_head(b"---\ncairn-type: secrets-extra\n---\n"), "near-miss key");
        assert!(!is_secret_head(b"---\n# cairn-type: secrets\n---\n"), "a comment is not the marker");
    }

    /* The viewer decides on the editor's text: one BOM stripped and CRLF made
     * LF on read, then CodeMirror's `\r\n?|\n` line split.  Every vector here
     * has a twin in `electron-shell/secret-parity.test.mjs`, which runs the
     * real frontend detector over the same bytes. */

    /// `---`, the marker, `filler` keys, the closer, a body line; `eol` between.
    fn frontmatter(filler: usize, eol: &str) -> Vec<u8> {
        let mut s = format!("---{eol}cairn-type: secrets{eol}");
        for i in 0..filler {
            s.push_str(&format!("k{i}: v{eol}"));
        }
        s.push_str(&format!("---{eol}body{eol}"));
        s.into_bytes()
    }

    #[test]
    fn secret_verdict_sees_the_text_the_viewer_sees() {
        // One BOM is stripped on read, so the viewer's line 1 is `---`.
        assert!(is_secret_head(b"\xEF\xBB\xBF---\ncairn-type: secrets\n---\n"), "BOM + LF");
        assert!(is_secret_head(b"\xEF\xBB\xBF---\r\ncairn-type: secrets\r\n---\r\n"), "BOM + CRLF");
        // CodeMirror breaks a line at a lone CR.
        assert!(is_secret_head(b"---\rcairn-type: secrets\r---\r"), "CR-only");
        assert!(is_secret_head(b"---\ncairn-type: secrets\r---\n"), "one stray CR");
        // `\r\r\n` is ONE break once the read path has made its CRLF an LF, so
        // 62 keys still put the closer at the 64th line walked.
        assert!(is_secret_head(&frontmatter(62, "\r\r\n")), "CR before CRLF");

        // Only ONE BOM is stripped: a second is content, and line 1 is not `---`.
        assert!(!is_secret_head(b"\xEF\xBB\xBF\xEF\xBB\xBF---\ncairn-type: secrets\n---\n"));
        // A BOM anywhere but byte 0 is content too.
        assert!(!is_secret_head(b"\n\xEF\xBB\xBF---\ncairn-type: secrets\n---\n"));
        assert!(!is_secret_head(b"---\n\xEF\xBB\xBFcairn-type: secrets\n---\n"));
        // A CR inside the marker line splits it.
        assert!(!is_secret_head(b"---\ncairn-type:\rsecrets\n---\n"));
    }

    #[test]
    fn secret_verdict_walks_64_lines_after_the_opener_and_no_more() {
        for eol in ["\n", "\r\n", "\r", "\r\r\n"] {
            assert!(is_secret_head(&frontmatter(62, eol)), "closer is line 64 ({eol:?})");
            assert!(!is_secret_head(&frontmatter(63, eol)), "closer is line 65 ({eol:?})");
        }
    }

    #[test]
    fn a_file_whose_frontmatter_outruns_the_first_read_is_still_a_secret() {
        let dir = tempfile::tempdir().unwrap();
        let check = |name: &str, bytes: &[u8]| {
            let path = dir.path().join(name);
            std::fs::write(&path, bytes).unwrap();
            file_is_secret(&mut std::fs::File::open(&path).unwrap())
        };
        // 40 keys of 120 bytes put the marker past 4 KiB, well inside 64 lines.
        let mut long = String::from("---\n");
        for i in 0..40 {
            long.push_str(&format!("k{i}: {}\n", "x".repeat(120)));
        }
        long.push_str("cairn-type: secrets\n---\n\n```secret\n# A\npw\n```\n");
        assert!(long.len() > SECRET_HEAD_BYTES);
        assert!(check("long.md", long.as_bytes()), "marker past the first 4 KiB");
        assert!(check("bom.md", b"\xEF\xBB\xBF---\ncairn-type: secrets\n---\n"));
        assert!(check("cr.md", b"---\rcairn-type: secrets\r---\r"));

        // And what must stay searchable does.
        assert!(!check("plain.md", "no frontmatter\n".repeat(70_000).as_bytes()));
        assert!(!check("unclosed.md", &frontmatter(63, "\n")));
        let mut huge = b"---\n".to_vec();
        huge.resize(9 * 1024 * 1024, b'x');
        assert!(!check("huge.md", &huge), "undecided at the scan cap");
    }

    /// Hands out one byte per `read`.
    struct Trickle<'a>(&'a [u8]);
    impl std::io::Read for Trickle<'_> {
        fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
            match (self.0.split_first(), out.first_mut()) {
                (Some((b, rest)), Some(slot)) => {
                    *slot = *b;
                    self.0 = rest;
                    Ok(1)
                }
                _ => Ok(0),
            }
        }
    }

    fn verdict_cases() -> Vec<Vec<u8>> {
        let mut long = b"---\n".to_vec();
        for i in 0..40 {
            long.extend_from_slice(format!("k{i}: {}\r\n", "y".repeat(150)).as_bytes());
        }
        long.extend_from_slice(b"cairn-type: secrets\r\r\n---\r");
        vec![
            b"---\ncairn-type: secrets\n---\n".to_vec(),
            b"\xEF\xBB\xBF---\r\ncairn-type: secrets\r\n---\r\n".to_vec(),
            b"---\rcairn-type: secrets\r---\r".to_vec(),
            b"---\ncairn-type: secrets\n---x\n---\n".to_vec(),
            b"---\ncairn-type: secrets\n---x\n".to_vec(),
            b"\xEF\xBB\xBF\xEF\xBB\xBF---\ncairn-type: secrets\n---\n".to_vec(),
            frontmatter(62, "\r\r\n"),
            frontmatter(63, "\r\r\n"),
            frontmatter(62, "\r"),
            long,
        ]
    }

    /// A head cut anywhere may leave the walk undecided, but never wrong: this
    /// is what lets the reader decide on 4 KiB and read on only when unsure.
    #[test]
    fn a_partial_head_never_decides_wrongly() {
        for case in verdict_cases() {
            let whole = classify_head(&case, true);
            assert!(whole.is_some());
            for k in 0..=case.len() {
                if let Some(v) = classify_head(&case[..k], false) {
                    assert_eq!(Some(v), whole, "{:?} cut at {k}", String::from_utf8_lossy(&case));
                }
            }
        }
    }

    #[test]
    fn the_verdict_does_not_depend_on_how_the_bytes_arrive() {
        for case in verdict_cases() {
            let whole = Some(is_secret_head(&case));
            assert_eq!(read_secret_verdict(&mut Trickle(&case)), whole);
            assert_eq!(read_secret_verdict(&mut std::io::Cursor::new(&case)), whole);
        }
    }

    #[test]
    fn parse_is_the_whole_query_language() {
        assert_eq!(parse(""), Query::Empty);
        assert_eq!(parse("   \t "), Query::Empty);
        assert_eq!(parse("alpha"), Query::Literal(vec!["alpha".into()]));
        assert_eq!(
            parse("  alpha   beta "),
            Query::Literal(vec!["alpha".into(), "beta".into()])
        );
        assert_eq!(parse("/ab.c/"), Query::Regex("ab.c".into()));
        // spec-05 §13: `/` and `//` are literals, not regexes — len < 3.
        assert_eq!(parse("/"), Query::Literal(vec!["/".into()]));
        assert_eq!(parse("//"), Query::Literal(vec!["//".into()]));
        // `/a/` is exactly 3 -> a regex with one character between the slashes.
        assert_eq!(parse("/a/"), Query::Regex("a".into()));
    }

    #[test]
    fn parse_caps_tokens_at_max_tokens_silently() {
        let q = parse("a b c d e f g h i j k");
        match q {
            Query::Literal(t) => assert_eq!(t.len(), MAX_TOKENS),
            other => panic!("expected Literal, got {other:?}"),
        }
    }

    #[test]
    fn smart_case_engages_only_on_an_uppercase_letter() {
        assert!(!parse("md").smart_case_engaged());
        assert!(parse("MD").smart_case_engaged());
        assert!(parse("Md").smart_case_engaged());
        assert!(!parse("/a.b/").smart_case_engaged());
        assert!(parse("/A.b/").smart_case_engaged());
        // Digits and punctuation are not uppercase letters.
        assert!(!parse("2024-01").smart_case_engaged());
    }

    #[test]
    fn token_mask_full_is_zero_for_a_regex_so_and_is_vacuously_satisfied() {
        let m = build_matchers(&parse("/foo/")).unwrap();
        assert_eq!(m.token_mask_full, 0);
        assert!(m.tokens.is_empty());
        let m = build_matchers(&parse("a b c")).unwrap();
        assert_eq!(m.token_mask_full, 0b111);
        assert_eq!(m.tokens.len(), 3);
    }

    #[test]
    fn a_bad_regex_is_a_message_not_a_panic() {
        // spec-05 §14 criterion 8: `/[/` renders an inline error.
        let Err(err) = build_matchers(&parse("/[/")) else { panic!("/[/ must not compile") };
        assert!(!err.is_empty());
        assert!(!err.contains('\n'), "the message is one line: {err:?}");
    }

    #[test]
    fn literal_mode_escapes_the_whole_pattern() {
        // `fixed_strings(true)` means `a.c` must NOT match `abc`.
        let m = build_matchers(&parse("a.c")).unwrap();
        assert!(m.any.is_match(b"xxa.cxx").unwrap());
        assert!(!m.any.is_match(b"xxabcxx").unwrap());
    }

    #[test]
    fn smart_case_matches_ripgreps_dash_s() {
        // spec-05 §5.2's verification table, re-run against the real builder.
        let hay = b"The Patient lab ... patient id ... config.toml and CONFIG.";
        let count = |q: &str| {
            let m = build_matchers(&parse(q)).unwrap();
            let mut n = 0;
            let _ = m.any.find_iter(hay, |_| {
                n += 1;
                true
            });
            n
        };
        assert_eq!(count("patient"), 2);
        assert_eq!(count("Patient"), 1);
        assert_eq!(count("config"), 2);
        assert_eq!(count("CONFIG"), 1);
    }

    #[test]
    fn utf16_len_counts_code_units_not_chars_or_bytes() {
        assert_eq!(utf16_len("abc"), 3);
        assert_eq!(utf16_len("日本語"), 3); // 9 bytes, 3 chars, 3 units
        assert_eq!(utf16_len("🎉"), 2); // 4 bytes, 1 char, 2 units (surrogate pair)
    }

    #[test]
    fn trim_eol_strips_crlf_and_lf_but_not_a_bare_cr_in_the_middle() {
        assert_eq!(trim_eol(b"abc\n"), b"abc");
        assert_eq!(trim_eol(b"abc\r\n"), b"abc");
        assert_eq!(trim_eol(b"abc"), b"abc");
        assert_eq!(trim_eol(b"a\rb\n"), b"a\rb");
    }

    #[test]
    fn snippet_offsets_are_utf16_units_across_astral_planes() {
        // spec-05 §14 criterion 7, the UTF-16 regression test.
        let m = build_matchers(&parse("needle")).unwrap();
        let line = "🎉日本 needle tail";
        let (s, _) = make_snippet(line.as_bytes(), 7, &m.any, 1);
        assert_eq!(s.line, 7);
        // "🎉" = 2 units, "日本" = 2, " " = 1  => col 5
        assert_eq!(s.col, 5);
        assert_eq!(s.len, 6);
        assert_eq!(s.ranges, vec![(5, 11)]);
        assert_eq!(s.text, line);
    }

    #[test]
    fn snippet_windows_a_long_line_and_shifts_ranges_past_the_ellipsis() {
        let m = build_matchers(&parse("needle")).unwrap();
        let mut line = "x".repeat(2000);
        line.push_str("needle");
        line.push_str(&"y".repeat(2000));
        let (s, _) = make_snippet(line.as_bytes(), 1, &m.any, 1);
        assert!(s.text.starts_with('…'), "{:?}", &s.text[..8]);
        assert!(s.text.ends_with('…'));
        // Never longer than SNIPPET_WINDOW_CHARS + two ellipses.
        assert!(s.text.chars().count() <= SNIPPET_WINDOW_CHARS + 2);
        // `col` is the column in the ORIGINAL line, not in the window.
        assert_eq!(s.col, 2000);
        assert_eq!(s.ranges.len(), 1);
        let (a, b) = s.ranges[0];
        assert!(a >= 1, "the leading ellipsis shifts every range by one unit");
        assert_eq!(b - a, 6);
        // And the range really does cover the needle inside the emitted text.
        let units: Vec<u16> = s.text.encode_utf16().collect();
        let got = String::from_utf16(&units[a as usize..b as usize]).unwrap();
        assert_eq!(got, "needle");
    }

    #[test]
    fn a_short_line_is_never_windowed() {
        let (slice, off, lead, trail) = window("hello", 0, SNIPPET_WINDOW_CHARS);
        assert_eq!(slice, "hello");
        assert_eq!(off, 0);
        assert!(!lead && !trail);
    }

    #[test]
    fn window_snaps_to_char_boundaries_on_multibyte_text() {
        let text: String = "日".repeat(1000);
        let (slice, off, lead, trail) = window(&text, 1500, 260);
        assert!(text.is_char_boundary(off));
        assert_eq!(slice.chars().count(), 260);
        assert!(lead && trail);
    }

    #[test]
    fn ranges_are_capped_per_line() {
        let m = build_matchers(&parse("a")).unwrap();
        let (s, _) = make_snippet(&b"a".repeat(50), 1, &m.any, 1);
        assert_eq!(s.ranges.len(), MAX_RANGES_PER_LINE);
    }

    #[test]
    fn lossy_decode_never_errors_on_invalid_utf8() {
        let m = build_matchers(&parse("ok")).unwrap();
        let raw = b"\xff\xfe ok \xff";
        let (s, _) = make_snippet(raw, 3, &m.any, 1);
        assert!(s.text.contains('\u{fffd}'));
        assert_eq!(s.ranges.len(), 1);
    }

    /// §0.33 E79 — REWRITTEN FOR THE SUBSTRING MATCHER. It used to feed
    /// `char_indices_to_utf16_spans` a hand-made unsorted index vector, which
    /// was nucleo's output shape; that function and that matcher are gone.
    #[test]
    fn filename_spans_are_utf16_and_cover_every_occurrence() {
        // The plain case.
        assert_eq!(substring_spans_utf16("abcd", "bc"), vec![(1, 3)]);

        // EVERY occurrence, not just the first: a name that contains the query
        // twice is a better hit than one that contains it once, and showing only
        // the first would misreport why the row is on screen.
        assert_eq!(substring_spans_utf16("ababa", "ab"), vec![(0, 2), (2, 4)]);

        // Case-insensitive, and the span indexes the ORIGINAL string.
        assert_eq!(substring_spans_utf16("AbCd", "bc"), vec![(1, 3)]);

        // Astral plane: char 0 is one char but TWO UTF-16 units, and the
        // frontend slices by UTF-16 (§4.3).
        assert_eq!(substring_spans_utf16("🎉ab", "a"), vec![(2, 3)]);
        assert_eq!(substring_spans_utf16("a🎉b", "b"), vec![(3, 4)]);

        // No match, and an empty needle, are both empty — never a panic and
        // never a zero-width span the frontend would render as a stray mark.
        assert_eq!(substring_spans_utf16("abc", "zz"), Vec::<(u32, u32)>::new());
        assert_eq!(substring_spans_utf16("abc", ""), Vec::<(u32, u32)>::new());
    }

    /// THE DEFECT THE USER REPORTED, as a test. `test` is four of the commonest
    /// letters in English; under the fuzzy matcher it matched
    /// `feedback_clear_site_data_fresh_boot` as a strict subsequence
    /// (t…es…t) and that was the FIRST result. A substring matcher cannot.
    #[test]
    fn a_subsequence_is_not_a_substring_match() {
        assert_eq!(count_occurrences("feedback_clear_site_data_fresh_boot", "test"), 0);
        assert_eq!(substring_spans_utf16("feedback_clear_site_data_fresh_boot", "test"),
                   Vec::<(u32, u32)>::new());
        // …and a real substring still matches, so this is not green by refusing
        // everything.
        assert_eq!(count_occurrences("my_test_notes", "test"), 1);
        assert_eq!(substring_spans_utf16("my_test_notes", "test"), vec![(3, 7)]);
        // spec-05 §7.2's own example keeps working for the right reason now:
        // `conf` returns nothing because no name CONTAINS it, not because no
        // name has c…o…n…f in order.
        assert_eq!(count_occurrences("my_configuration_note", "conf"), 1);
        assert_eq!(count_occurrences("clean_offline_notes_final", "conf"), 0);
    }

    /// Ranking: most occurrences first, then tree order. The fuzzy path sorted
    /// by nucleo's score; a substring match has no "how well", only "how often".
    #[test]
    fn occurrence_count_is_the_ranking_signal() {
        assert_eq!(count_occurrences("test_test_test", "test"), 3);
        assert_eq!(count_occurrences("a_test_note", "test"), 1);
        // NON-OVERLAPPING, which is what a reader counts: `aaa` contains `aa`
        // once by this rule, not twice.
        assert_eq!(count_occurrences("aaa", "aa"), 1);
        assert_eq!(count_occurrences("aaaa", "aa"), 2);
    }

    /// The one thing search relies on `NoteEntry` for: `name()` must be the
    /// basename without `.md`, and it must agree with `path::basename_span`,
    /// which is what the walker fills the offsets from.  Search scores THIS
    /// string in the filename phase, so a disagreement here is a silently wrong
    /// Files section.
    #[test]
    fn note_entry_name_agrees_with_path_basename_span() {
        for (rel, want) in [
            ("Projects/Deep/note_04.md", "note_04"),
            ("top.md", "top"),
            ("a/b.c.md", "b.c"),
            ("dir/UPPER.MD", "UPPER"),
        ] {
            let (name_start, name_len) = crate::path::basename_span(rel);
            let e = NoteEntry { rel: rel.into(), name_start, name_len, size: 0, mtime_ms: 0 };
            assert_eq!(e.name(), want, "{rel}");
        }
    }

    #[test]
    fn safe_rel_refuses_traversal_and_non_notes() {
        let root = Path::new("/vault");
        assert!(safe_rel(root, "a/b.md").is_ok());
        for bad in ["", "/abs.md", "../x.md", "a/../b.md", "a//b.md", "a/b.txt", "dir/"] {
            assert!(safe_rel(root, bad).is_err(), "{bad:?} must be refused");
        }
        // A backslash is a LEGAL byte in a macOS filename, so it is not a
        // traversal signal and `validate_rel_for_lookup` rightly allows it — a
        // note really called `a\\b.md` must stay expandable.
        assert!(safe_rel(root, "a\\b.md").is_ok());
        // `.MD` is a note: §3.6 matches the extension ASCII-case-insensitively.
        assert!(safe_rel(root, "a/B.MD").is_ok());
    }

    struct Collector(std::sync::Mutex<Vec<SearchMsg>>);
    impl MsgSink for Collector {
        fn send(&self, msg: SearchMsg) {
            self.0.lock().unwrap().push(msg);
        }
    }

    #[test]
    fn batching_respects_both_caps_and_truncates_snippets_to_the_ipc_limit() {
        let snip = Snippet {
            line: 1,
            text: "s".repeat(300),
            ranges: vec![(0, 1)],
            col: 0,
            len: 1,
        };
        let groups: Vec<FileGroup> = (0..40)
            .map(|i| FileGroup {
                id: i,
                rel: format!("f{i}.md"),
                name: format!("f{i}"),
                name_ranges: vec![],
                snippets: vec![snip.clone(); MAX_SNIPPETS_PER_FILE],
                match_count: 3,
                more: false,
                rank: (1, u32::MAX - 3, i),
            })
            .collect();
        let c = Collector(std::sync::Mutex::new(Vec::new()));
        flush_batches(&c, 7, groups);
        let msgs = c.0.lock().unwrap();
        assert!(!msgs.is_empty());
        let mut total = 0;
        for m in msgs.iter() {
            let SearchMsg::Batch { gen, groups } = m else { panic!("not a Batch") };
            assert_eq!(*gen, 7);
            assert!(groups.len() <= BATCH_MAX_GROUPS, "{} groups", groups.len());
            for g in groups {
                assert!(g.snippets.len() <= MAX_SNIPPETS_IPC);
            }
            total += groups.len();
        }
        assert_eq!(total, 40, "batching must not drop a group");
        // 8 groups x ~700 B would be over 6,000 B, so the byte cap bites first.
        assert!(msgs.len() > 40 / BATCH_MAX_GROUPS);
    }

    #[test]
    fn a_single_oversized_group_is_still_sent_rather_than_dropped() {
        let g = FileGroup {
            id: 0,
            rel: "x".repeat(20_000),
            name: "x".into(),
            name_ranges: vec![],
            snippets: vec![],
            match_count: 1,
            more: false,
            rank: (1, 0, 0),
        };
        let c = Collector(std::sync::Mutex::new(Vec::new()));
        flush_batches(&c, 1, vec![g]);
        assert_eq!(c.0.lock().unwrap().len(), 1);
    }

    #[test]
    fn search_state_is_empty_at_rest_and_cancel_all_is_generation_independent() {
        let st = SearchState::default();
        assert_eq!(st.live_jobs(), 0);
        assert_eq!(st.generation(), 0);

        let f1 = Arc::new(AtomicBool::new(false));
        let f2 = Arc::new(AtomicBool::new(false));
        st.register(11, &f1);
        st.register(12, &f2);
        assert_eq!(st.live_jobs(), 2);

        // cancel(gen) flags exactly one job...
        st.cancel(11);
        assert!(f1.load(Ordering::Relaxed));
        assert!(!f2.load(Ordering::Relaxed));
        // ...and RECORDS the number, because the frontend owns it (X15).
        assert_eq!(st.generation(), 11);

        // cancel_all() flags every job WITHOUT touching the counter — that is
        // the whole point: a vault switch must not hand the frontend a number it
        // never issued (§4.3).
        st.cancel_all();
        assert!(f2.load(Ordering::Relaxed));
        assert_eq!(st.generation(), 11);

        st.unregister(&f1);
        st.unregister(&f2);
        assert_eq!(st.live_jobs(), 0);
    }

    #[test]
    fn rank_puts_name_matches_first_then_most_matches_then_tree_order() {
        let mk = |id: u32, count: u32, name_hit: bool| -> (u8, u32, u32) {
            (u8::from(!name_hit), u32::MAX - count, id)
        };
        let mut v = vec![
            mk(9, 1, false),
            mk(3, 50, false),
            mk(7, 1, true),
            mk(1, 50, false),
        ];
        v.sort_unstable();
        let ids: Vec<u32> = v.into_iter().map(|(_, _, id)| id).collect();
        assert_eq!(ids, vec![7, 1, 3, 9]);
    }
}
