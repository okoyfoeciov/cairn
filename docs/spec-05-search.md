# Spec 05 — Search

> **Conformed to `docs/CONTRACT.md`.** CONTRACT.md is normative and overrides this document wherever
> the two disagree. Where a ruling there replaced something written here, the text is deleted and
> replaced by a one-line pointer — never paraphrased. Where a measurement refuted a number asserted
> here, the number and the reasoning that produced it are both gone.

**This document is normative for** the internal design an implementer builds from: the no-index
decision and the measurements behind it (§2), query parsing and smart case (§5.1–5.3), the per-file
sink and snippet construction (§5.4–5.6), the worker loop (§5.7), the coordinator's phases (§5.8),
panic discipline in `search.rs` (§5.9), the streaming/batching mechanism (§6), the filename path
(§7), the search panel's own DOM, CSS and behaviour (§8), result opening (§9), cancellation
mechanics (§10), on-disk-change handling (§11), edge cases (§13) and the rejected alternatives (§15).

**It defers to CONTRACT.md for:**

| Subject | Contract section |
|---|---|
| Command signatures, error type, transport; `SearchMsg` / `FileGroup` / `Snippet` wire shapes | §1.1, §1.2, §1.3, §1.5 |
| Event names and payloads (`nc://tree-changed`, `nc://vault-opened`) | §1.4 |
| The engine ruling, the thread count, the DFA limit | §4.1 |
| The `Arc<VaultSnapshot>` seam and its lifetime rule | §4.2 |
| Vault-switch ordering | §4.3 |
| Search policy: debounces, caps, snippets inline, UTF-16 offsets, batching, the DOM ceiling | §4.4 |
| Every search constant | §4.5 |
| Design tokens (`tokens.css` is the only declaration site) and the tree box model the panel inherits | §5.1, §5.2 |
| The sidebar scroller's reserved gutter and its CSS | §5.2 |
| The manifest, the release profile and the panic discipline it obliges | §6.2 |
| The CSS build order and the pinned npm set | §6.3 |
| Acceptance gates (G4 search budget, G7 no-unwrap) | §6.5 |
| The process/thread inventory | §8.5 |

Numbers marked *(measured)* were produced on this machine during the writing of this spec; the
methodology and raw output are in §2.

Owner boundary: this document owns `core/src/search.rs`, `core/tests/search_int.rs`, `src/search.ts`
and `src/styles/search.css`. It **consumes** the vault file list from the tree backend (owner 02)
through CONTRACT.md §4.2, and **calls into** the editor (owner 03) to open a note at a position. It
does not own file watching (owner 02); it subscribes to `nc://tree-changed` through the shell's
event door.

A bare `§N` means a section of **this** document; everything normative is cited as
`CONTRACT.md §N`.

---

## 1. The decision, in one paragraph

**No index. Ever.** Search is an on-demand, cancellable, streamed parallel line scan over the notes,
executed by `grep-searcher` on **four threads spawned per query** (CONTRACT.md §4.1, §4.5), driven by
the `Arc<VaultSnapshot>` path list the tree backend builds lazily on first search (CONTRACT.md §4.2).
Filename matching is a separate, purely in-memory code path that answers in **under 0.35 ms**
*(measured)* and therefore runs with no debounce at all; content matching is debounced 90 ms and
streams its results. A full uncapped content scan of a 5,000-note vault takes **45–65 ms**
*(measured)*; the subsystem's memory cost is normative in CONTRACT.md §4.4 — **0.44 MB at rest,
4.7 MB peak**. The alternative — a persistent in-memory inverted index — costs **13.6–46.3 MB** of
RSS and **190–500 ms** of cold-start CPU *(measured)* to make a 50 ms operation into a 5 ms one.

---

## 2. The core decision, with real numbers

### 2.1 Method

* Machine: Apple Silicon, 8 cores, 16 GB RAM, macOS, APFS/NVMe. `rustc 1.93.1`, `--release`.
* Two synthetic vaults, each **5,000 `.md` files** in a nested tree (12 top-level folders × 9
  sub-folders), filled with real prose sampled from 1,388 markdown documents found on this machine:
  * **Corpus A** — 10.27 MB total, mean 2,054 B/file. Models a typical personal vault.
  * **Corpus B** — 25.53 MB total, mean 5,107 B/file. Models a heavy vault.
* Reference corpus statistics (1,388 real `.md` files, 6.6 MB), used for the extrapolations below:
  mean 4,784 B/file, median 2,037 B, p90 10,446 B, max 150 KB; mean 122 lines/file; 694 token
  occurrences/file; **211 unique terms/file**; vocabulary 33,081 over 963,763 occurrences.
* All timings are warm-page-cache, wall clock, including the work-distribution overhead. RSS is the
  process `maximum resident set size` reported by `/usr/bin/time -l`.

### 2.2 Option A — persistent in-memory inverted index

Built with `HashMap<String, Vec<..>>`, lowercased alphanumeric tokens of length ≥ 2, single-threaded
build, measured end to end.

| Index shape | Corpus A (10 MB) | Corpus B (25 MB) |
|---|---|---|
| `term -> Vec<doc_id>` build time | 330 ms | 500 ms |
| `term -> Vec<doc_id>` **peak RSS** | **13.65 MB** | **18.56 MB** |
| `term -> Vec<(doc_id, line)>` build time | 189 ms | 333 ms |
| `term -> Vec<(doc_id, line)>` **peak RSS** | **23.13 MB** | **46.25 MB** |
| vocabulary | 26,686 | 27,786 |
| postings (doc-level / line-level) | 667,496 / 1,377,561 | 1,332,136 / 3,438,846 |

Three corrections that make Option A *worse* than the table:

1. **Vocabulary is understated.** The synthetic corpora repeat text, so their vocabulary saturates at
   ~27 K. Heaps' law fitted to the real corpus (V = 33.7·N^0.5, from V=33,081 at N=963,763) predicts
   **≈ 63,000 distinct terms** for 5,000 real notes at 694 tokens each. That adds ~35 K hash slots,
   `String` keys and `Vec` headers: **+4 to 6 MB**. Realistic figure for the line-level index on a
   25 MB vault: **≈ 51 MB**.
2. **It cannot answer the query the user actually types.** A term index matches whole tokens. Typing
   `obsi` must show `obsidian` hits *while you are still typing*, or the panel blinks empty on every
   third keystroke. Supporting that needs a prefix structure (sorted vocabulary or an FST) for
   prefixes only, and a **trigram** index for true substring. A trigram index over Corpus B is
   ~5,000 docs × ~2,000 distinct trigrams/doc ≈ 10 M postings ≈ **40 MB of postings alone**, on top
   of everything above.
3. **It still cannot render the result panel.** The panel shows *matching lines with the query
   highlighted*. Doc-level postings give you a file list and nothing else, so you must re-open and
   re-scan every candidate file anyway to produce snippets. The index buys you a candidate filter in
   front of an I/O step you were going to do regardless — and the scan of 200 candidate files is
   ~2 ms.

Plus the two structural problems: a 190–500 ms single-threaded build would sit directly on top of the
cold start, and the index goes stale the moment Obsidian (or `git`, or a sync client) writes to the
same vault — which the storage decision explicitly permits.

### 2.3 Option B — streamed parallel scan (chosen)

`grep-searcher` + `grep-regex`, case-insensitive literal, `max_matches` cap, memory maps disabled.

| Measurement | Corpus A (10 MB) | Corpus B (25 MB) |
|---|---|---|
| Directory walk only | 8.4 / 9.8 / 12.2 ms | 9.3 / 6.5 ms |
| Full **uncapped** content scan (literal) | 46.5 / 48.9 ms | 44.9 / 60.4 ms |
| Same, single thread | 115.6 ms | — |
| Full uncapped scan, **regex** `conf[a-z]+ion` | 46.9 / 49.1 / 53.6 ms | — |
| Scan with **early stop at 50 matching files** | 2.2 / 3.1 / 3.2 ms (55–58 files opened) | 1.6 ms (52 files opened) |
| **Peak process RSS during a scan** | **4.44–4.57 MB** | **4.44 MB** |
| Memory maps on vs. off | 48.3 vs 48.9 ms (no difference) | — |
| 200 back-to-back searches over a cached path list | mean **4.61 ms**, worst 10.72 ms | mean **2.74 ms**, worst 15.47 ms |
| Process RSS: before first search → after 200 searches | 5.89 MB → **7.14 MB** (incl. 795 KB of path strings) | 5.76 MB → 6.94 MB |
| 5,000 relative paths held as strings | **243 KB** | 243 KB |

The RSS line is the important one: **200 consecutive searches grow resident memory by ~1.2 MB and
then plateau.** There is no accumulation, because there is nothing to accumulate.

The harness ran 8 threads; **the engine ships 4** (CONTRACT.md §4.1, §4.5). Four threads measured
faster than eight on this machine, and gate **G4 (≤ 65 ms against a measured median of 48.9 ms, on
the 10 MB corpus)** is set against the 4-thread configuration (CONTRACT.md §6.5). The 25 MB corpus is
informational only.

### 2.4 Option C — the middle grounds, evaluated

* **Memory-mapped reads (`MmapChoice::auto()`).** Rejected. Measured *zero* benefit (48.3 vs 48.9 ms)
  because notes are ~2 KB and `grep-searcher`'s own heuristic declines to map them. Worse, the
  constructor is `unsafe` with the contract "the caller guarantees the underlying file won't be
  mutated" — and this application's entire premise is that Obsidian may be writing the same vault
  concurrently. A truncation under a live mapping is a `SIGBUS`, i.e. a crash, not an error.
  **`MmapChoice::never()` is mandatory.**
* **Early termination.** Adopted, and it is the single largest win: capping the result set takes the
  common case from ~48 ms to **1.6–3.2 ms** because only 52–58 files are ever opened. The shipping
  cap is `MAX_FILES = 200` (CONTRACT.md §4.5). See §5.4.
* **Filename-only as a separate faster path.** Adopted, and it is the reason the panel feels instant.
  Substring-matching 5,000 relative paths costs **0.053–0.341 ms** and no I/O *(measured)*. It runs
  synchronously on the keystroke, with no debounce, so the panel is never empty while the content
  scan is still running. See §7.
* **A cached path list instead of walking the filesystem per search.** Adopted, and it is **not
  free**. The tree stores no path per node, so there was never a list lying around to borrow. The
  path list is a separate `Arc<VaultSnapshot>`, built lazily on the first search, cached, and
  invalidated by the epoch counter. **Normative: see CONTRACT.md §4.2.** It removes the 6–12 ms walk
  from every query, costs ~0.8 ms to build cold, and costs **+0.44 MB charged to search**
  (CONTRACT.md §4.4) — or exactly zero if the panel is never opened in a session.

### 2.5 Recommendation

**Option B + the two Option-C refinements (early termination, separate filename path), with the
`Arc<VaultSnapshot>` path cache.** Concretely:

> A search is: take an `Arc` of the immutable path snapshot, fan it out over **`SEARCH_THREADS = 4`
> threads spawned for this query and joined when it ends**, in chunks of 32, have each worker run one
> `grep_searcher::Searcher` over each file, accumulate at most 8 snippets per file and 200 files
> total, stream file-groups to the webview in ≤ 6 KB batches every 16 ms, and abort the whole thing
> the instant the generation counter moves.

Cost: **0.44 MB at rest, 4.7 MB peak** (CONTRACT.md §4.4), **45–65 ms worst case, 2–5 ms typical.**

### 2.6 Cold cache — the one honest caveat

All content-scan timings above are warm. This machine does not allow purging the page cache without
`sudo`, so the cold number is *estimated*: the first run immediately after writing each corpus
measured 123–136 ms versus 46–50 ms warm. **Budget 150–400 ms for the first full-content search after
launch** *(estimated)*.

This is designed around, not ignored:
* filename results land in < 1 ms and are rendered first, so the panel is never blank;
* content results stream, so the first file-group appears long before the scan finishes;
* the early stop means most real queries never touch 5,000 files;
* the count line says `Searching…` once 120 ms have passed with nothing to show (§8.7), which covers
  the gap honestly and without an animation.

It is explicitly **not** designed around by pre-warming the cache at launch. Reading 25 MB at startup
to make a later search faster would spend the cold-start budget and the RSS budget to buy latency in
a feature the user may not open. Do not do it.

---

## 3. Dependencies

### 3.1 Rust

**Normative: see CONTRACT.md §6.2.** The manifest is `core/Cargo.toml`; it carries the search crates
and their exact versions. What follows is the search-specific reasoning only.

Search uses `grep-searcher` (line-oriented streaming search; its `Sink` trait gives cancellation for
free), `grep-regex` (`RegexMatcher`, with `fixed_strings` / `case_smart` / `build_many`),
`grep-matcher` (the `Matcher` trait: `find_iter`, `is_match`) and `memchr` (EOL trimming). Their
transitives include `bstr`, `regex-automata`, `regex-syntax`, `aho-corasick`, `encoding_rs`,
`encoding_rs_io`, `memmap2` and `log`.

**Not used by search:** `ignore` (the tree owns the walk, and the per-query `WalkBuilder` fallback
does not exist — CONTRACT.md §4.2), `nucleo-matcher` (removed; filename search is a substring
match, §7.2), `rayon` (§15), `walkdir` and `tantivy`. `tokio` **is** a direct dependency of the crate
(CONTRACT.md §6.2) because the runtime it sizes is built at module init and the coordinator runs on
its blocking pool (§5.8) — but `search.rs` imports it nowhere and reaches the runtime only through
`crate::spawn_blocking`.

`memmap2` arrives as a mandatory dependency of `grep-searcher` but is never exercised, because
`MmapChoice::never()` is set on every `Searcher` (§2.4). Do not add the `simd-accel` / `avx-accel`
features; they are no-ops in current `grep-searcher`.

### 3.2 npm

No new packages. The panel is hand-written HTML/CSS/TS. The pinned frontend set is normative in
CONTRACT.md §6.3; search needs the bridge wrappers for commands 14–16, and `EditorSelection` /
`EditorView.scrollIntoView` from the editor's already-present `@codemirror/state` and
`@codemirror/view` for §9.

`src/ipc.ts` (owner 02) is the only frontend module permitted to cross the bridge, so every call in
this document goes through its typed wrappers: `searchStart`, `searchExpand`, `searchCancel`.

---

## 4. Data structures

### 4.1 The vault snapshot

**Normative: see CONTRACT.md §4.2.** `VaultSnapshot`, `NoteEntry`, the lazy build, the
cache-and-invalidate-by-epoch rule and the `Arc` lifetime rule all live there.

What search relies on, and nothing more:

* the returned `Arc` is immutable and is **pinned for the whole life of a job**, so paths can neither
  be rewritten under an in-flight scan nor freed while a worker still holds one;
* `files` is in the snapshot's own index order, which is preorder DFS under the active sort — the
  same order the tree is showing. That is what makes `FileGroup.id` a stable DOM key for one
  generation, and it is the third component of the §5.5 rank key;
* `name()` gives the basename without `.md` so the filename path can match it without allocating;
* `NoteEntry.size` is **always 0** — the arena has no size field, so the worker tests
  `MAX_SCAN_BYTES` against the open file's metadata. A consumer that reads `size` as a size sees
  every note in the vault as empty;
* the ~0.44 MB the snapshot costs is charged to **search**, not to the tree.

### 4.2 The engine

There is no persistent pool and no parked threads (CONTRACT.md §4.1, §8.5). At rest, search owns one
`AtomicU64` and one empty `Vec`. A query allocates a `Job`, spawns `SEARCH_THREADS` threads, joins
them, and frees everything.

**The generation has exactly one writer, and it is the frontend** (CONTRACT.md §4.3).
`SearchState.generation` is *not* a counter Rust increments — it is the **last-seen-generation
record**: `search_start` stores the number it was handed and every `SearchMsg` echoes it back. Rust
never invents, bumps or reorders it, and a vault switch does **not** touch it. That is why a second
mechanism is needed for "stop everything regardless of number", and why `SearchState` carries the
`live` list below.

```rust
/// The whole of search's at-rest state. Lives in AppState.
pub struct SearchState {
    /// The NEWEST generation the frontend has handed us, via search_start or search_cancel.
    /// Rust only ever STORES this value. Anything whose gen != this is garbage.
    pub generation: Arc<AtomicU64>,
    /// Live jobs, so a vault switch can cancel generation-INDEPENDENTLY (CONTRACT.md §4.3).
    /// Pushed at job construction, removed when the coordinator exits, so it is EMPTY at rest
    /// and an empty Vec allocates nothing.
    pub live: Mutex<Vec<(u64, Arc<AtomicBool>)>>,
}

struct Job {
    gen: u64,
    generation: Arc<AtomicU64>,          // shared with SearchState; the staleness check
    cancelled: Arc<AtomicBool>,          // this job's own flag; set by search_cancel and by
                                         // cancel_all() (CONTRACT.md §4.3)
    snapshot: Arc<VaultSnapshot>,        // pinned for the life of the job (CONTRACT.md §4.2)
    m: Matchers,                         // the alternation matcher + one per token + the AND mask
    name_hits: HashSet<u32>,             // ids the filename phase matched — rank component 0
    cursor: AtomicUsize,                 // next unclaimed index into `snapshot.files`
    files_hit: AtomicUsize,
    matches_total: AtomicUsize,
    scanned: AtomicUsize,
    skipped: AtomicUsize,                // unreadable / oversized-line / oversized-file / secret
    out: Mutex<Vec<FileGroup>>,          // drained by the coordinator every BATCH_FLUSH_MS
    ranks: Mutex<Vec<(u8, u32, u32)>>,   // every emitted group's rank key (see below)
    left: Mutex<usize>,                  // workers still running
    done: Condvar,                       // woken by the last worker to exit
}
```

`Job` is an `Arc`: the coordinator holds one clone and each worker holds one, so the result vector,
the matchers and the pinned snapshot are freed when the last worker exits. There is deliberately no
long-lived `Mutex<Arc<VaultSnapshot>>` — the coordinator calls the tree's `snapshot()` once, at job
construction, and that `Arc` belongs to the job.

`ranks` is separate from `out` because `out` is drained as the search runs; by the time `Complete` is
built, the groups themselves are already on the wire and `order` still has to name all of them.

`left`/`done` is a **condvar, not a spin**: the coordinator must wake the instant the last worker
exits, because polling at the 16 ms batch cadence would add up to 16 ms of dead time to every search
and gate G4 has 16 ms of margin in total.

**The two cancellation tests, and why there are two.** A worker is stale if
`generation != job.gen` (the frontend has moved on) **or** `job.cancelled` is set (someone asked this
specific job to stop). `search_cancel(gen)` sets the flag on the entry whose generation is `gen`;
`cancel_all()` sets it on every entry in `live`. The second exists because a vault switch must cancel
without touching a number the frontend is about to issue (CONTRACT.md §4.3), which a generation bump
cannot do. Both are one relaxed atomic load at each check site.

### 4.3 Results

**The wire shapes are normative in CONTRACT.md §1.5** — `FileGroup`, `Snippet`, `SearchMsg` and
`VaultError`, as declared in `src/ipc.d.ts` (owner 02). The Rust definitions below are the mirror an
implementer writes; if the two ever disagree, `src/ipc.d.ts` wins and this block is the bug.

```rust
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileGroup {
    /// Index into VaultSnapshot.files. The frontend uses it as a stable DOM key.
    pub id: u32,
    /// Vault-relative path, for the tooltip and for `open`.
    pub rel: String,
    /// Basename without ".md" — what the row displays.
    pub name: String,
    /// Highlight ranges *inside `name`*, UTF-16 code units. Empty for a content-only hit.
    pub name_ranges: Vec<[u32; 2]>,
    /// At most MAX_SNIPPETS_IPC (=2) here; the rest are fetched on expand.
    pub snippets: Vec<Snippet>,
    /// Total matching lines in the file. Saturates at MAX_SNIPPETS_PER_FILE; see `more`.
    pub match_count: u32,
    /// True when the per-file snippet cap was hit, i.e. `match_count` is a floor.
    pub more: bool,
    /// Sort key, see §5.5. Lower sorts first.
    pub rank: (u8, u32, u32),
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    /// 1-based line number in the file.
    pub line: u32,
    /// The (possibly windowed) line text, already trimmed of its EOL. Never > 262 chars.
    pub text: String,
    /// Highlight ranges inside `text`, in **UTF-16 code units**, ascending, non-overlapping.
    pub ranges: Vec<[u32; 2]>,
    /// UTF-16 column of the first match *in the original full line* — feeds CodeMirror directly.
    pub col: u32,
    /// UTF-16 length of the first match. Used to select it on open.
    pub len: u32,
}
```

**Offsets are UTF-16 code units, not bytes and not chars.** JavaScript strings and CodeMirror 6
document positions are both UTF-16-code-unit indexed; emitting anything else guarantees an off-by-N
on any note containing an emoji or a CJK character. Convert in Rust with
`chars().map(|c| c.len_utf16() as u32).sum()`. CONTRACT.md §4.4 makes this an acceptance criterion
rather than a preference.

**`rename_all` on an enum renames its variants, not its fields.** `SearchMsg::Complete` must reach JS
as `totalMatches` / `totalFiles` / `smartCase` / `elapsedMs`, so the enum needs

```rust
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
```

`rename_all_fields` exists from serde 1.0.181. Without it the frontend silently reads `undefined`
for four fields of the one message that ends a search — the struct-level `rename_all` on `FileGroup`
and `Snippet` is not enough, because those are structs and `SearchMsg` is an enum.

### 4.4 Constants

**Normative: see CONTRACT.md §4.5.** Every constant is declared once, at the top of `search.rs`,
verbatim from that table: `SEARCH_THREADS = 4`, `MAX_TOKENS = 8`, `MAX_FILES = 200`,
`MAX_TOTAL_MATCHES = 1_000`, `MAX_SNIPPETS_PER_FILE = 8`, `MAX_SNIPPETS_IPC = 2`,
`MAX_RANGES_PER_LINE = 8`, `SNIPPET_WINDOW_CHARS = 260`, `CHUNK = 32`,
`HEAP_LIMIT_BYTES = 1 << 16`, `REGEX_SIZE_LIMIT = 1 << 20`, `REGEX_DFA_SIZE_LIMIT = 1 << 20`,
`BATCH_FLUSH_MS = 16`, `BATCH_MAX_GROUPS = 8`, `BATCH_MAX_BYTES = 6_000`,
`MIN_CONTENT_QUERY_CHARS = 2`, `FILENAME_DEBOUNCE_MS = 0`, `CONTENT_DEBOUNCE_MS = 90`,
`MAX_SCAN_BYTES = 8 MiB`, `RERUN_QUIET_MS = 400`, `RERUN_MIN_INTERVAL_MS = 2_000`.

Three of the constants change behaviour and not merely a number, so they are called out where the
behaviour lives:

* **`REGEX_DFA_SIZE_LIMIT` = 1 MiB (not 4).** At 4 MiB across 4 workers the lazy-DFA cache alone is
  a 16 MB worst case. A pathological regex now thrashes its cache instead of growing it: slower on
  that one query, and nothing else. §5.3.
* **`HEAP_LIMIT_BYTES` = 64 KiB.** This is also the longest line the searcher can handle, so a note
  containing a single line longer than 64 KiB is now *skipped* rather than scanned. §5.4, §13.
* **`MAX_SCAN_BYTES` = 8 MiB.** A note larger than the read cap is reachable by filename but is never
  content-scanned. §5.7, §13.

`MAX_FILENAME_HITS = 20` is the filename section's own cap (§7.3), named in `search.rs` so it cannot
drift into the panel's CSS.

---

## 5. The search algorithm

### 5.1 Query parsing

The query string is parsed by exactly this function. There is no configuration, no toggle, and no
settings screen anywhere in the product.

```rust
pub enum Query {
    Empty,
    /// 1..=MAX_TOKENS literal tokens. AND across the file, OR per line.
    Literal(Vec<String>),
    /// A user regex, already validated.
    Regex(String),
}

pub fn parse(raw: &str) -> Query {
    let q = raw.trim();
    if q.is_empty() { return Query::Empty; }
    // Regex escape hatch: /pattern/ — at least one character between the slashes.
    if q.chars().count() >= 3 && q.starts_with('/') && q.ends_with('/') {
        return Query::Regex(q[1..q.len() - 1].to_string());
    }
    let toks: Vec<String> = q.split_whitespace().take(MAX_TOKENS).map(str::to_string).collect();
    Query::Literal(toks)
}
```

A malformed regex is not a parse failure here: it is compiled before the filename phase runs, and its
message goes out as `SearchMsg::Error` (§5.8).

### 5.2 Case sensitivity — **smart case, always**

`RegexMatcherBuilder::case_smart(true)` with `case_insensitive` left at `false`. The query is matched
case-insensitively **iff it contains no uppercase letter**. This is ripgrep's `-S` behaviour.

*Verified* against `grep-regex` with the exact builder configuration of §5.3:

| query | matches in `"The Patient lab … patient id … config.toml and CONFIG."` |
|---|---|
| `patient` | `Patient`, `patient` — 2 |
| `Patient` | `Patient` — 1 |
| `config`  | `config`, `CONFIG` — 2 |
| `CONFIG`  | `CONFIG` — 1 |

Rationale: it is the only case policy that needs zero UI, is right ~99 % of the time, and is
recoverable when wrong (add a capital, or use the regex form). Because it can surprise, the panel's
count line appends ` · case-sensitive` whenever smart case engaged (§8.5).

### 5.3 Matcher construction — exact

```rust
fn build_matcher(pattern: &str, literal: bool) -> Result<RegexMatcher, String> {
    RegexMatcherBuilder::new()
        .case_smart(true)              // NOT case_insensitive(true)
        .fixed_strings(literal)        // literal mode escapes the whole pattern
        .multi_line(false)             // '^'/'$' anchor the whole input, not lines
        .line_terminator(Some(b'\n'))  // lets the engine use its line-oriented fast paths
        .size_limit(REGEX_SIZE_LIMIT)
        .dfa_size_limit(REGEX_DFA_SIZE_LIMIT)
        .build(pattern)
        .map_err(|e| e.to_string().lines().next().unwrap_or("invalid pattern").to_string())
}
```

For `Query::Literal(toks)` build **two things**:

```rust
let any = RegexMatcherBuilder::new()
            .case_smart(true).fixed_strings(true).multi_line(false)
            .line_terminator(Some(b'\n'))
            .size_limit(REGEX_SIZE_LIMIT).dfa_size_limit(REGEX_DFA_SIZE_LIMIT)
            .build_many(&toks)?;                     // alternation, one pass, Teddy prefilter
let tokens: Vec<RegexMatcher> =
    toks.iter().map(|t| build_matcher(t, true)).collect::<Result<_, _>>()?;
```

`any` drives the `Searcher` (one pass over the file, SIMD-prefiltered). `tokens` is used only on
lines that already matched, to compute the AND bitmask. Using the *same engine* for both guarantees
the AND check and the highlight ranges agree; hand-rolling the second check with `memmem` and
`to_lowercase` would introduce Unicode case-folding disagreements (`ß`/`SS`) between them.

For `Query::Regex(p)`: `any = build_matcher(&p, false)?`, `tokens = vec![]`, `token_mask_full = 0`.

Regex safety is structural, not defensive: the `regex` crate is a finite automaton with no
backtracking, so there is no catastrophic-backtracking class to defend against. The two size limits
bound *compilation* and *DFA cache* memory, which is the only memory risk. Both are **1 MiB**
(CONTRACT.md §4.5); across the four workers that is the 4 MB the memory budget carries.

### 5.4 The per-file sink

```rust
struct GroupSink<'a> {
    job: &'a Job,
    snippets: Vec<Snippet>,
    match_count: u32,
    seen_mask: u32,
}

impl Sink for GroupSink<'_> {
    type Error = std::io::Error;

    fn matched(&mut self, _s: &Searcher, m: &SinkMatch<'_>) -> Result<bool, std::io::Error> {
        // (1) Cancellation. Two relaxed loads per matched line; returning false aborts this file
        //     immediately and cleanly, which is what Sink::matched is documented to do.
        if stale(self.job) { return Ok(false); }

        self.match_count += 1;
        let raw = trim_eol(m.bytes());               // strips one "\r\n" or "\n"

        // (2) Which query tokens appear on THIS line -> per-file AND accumulator.
        let mut line_mask = 0u32;
        for (i, tm) in self.job.m.tokens.iter().enumerate() {
            if tm.is_match(raw).unwrap_or(false) { line_mask |= 1 << i; }
        }
        self.seen_mask |= line_mask;

        // (3) Snippet, capped.
        if self.snippets.len() < MAX_SNIPPETS_PER_FILE {
            self.snippets.push(make_snippet(
                raw, m.line_number().unwrap_or(0) as u32, &self.job.m.any,
                line_mask.count_ones() as u8,
            ));
        }

        // (4) Stop only when we can no longer learn anything: every token has been seen somewhere
        //     in this file AND we have all the snippets we will ever show.
        let and_satisfied = self.seen_mask == self.job.m.token_mask_full;
        Ok(!(and_satisfied && self.snippets.len() >= MAX_SNIPPETS_PER_FILE))
    }
}
```

Note the ordering subtlety in (4): you may **not** use `SearcherBuilder::max_matches(Some(8))` here,
because stopping after 8 lines could miss the line carrying the last AND token and would wrongly drop
the file. The sink's own condition is the correct cap.

The searcher — `build_searcher()` in §5.7 — is built once per worker thread when the query's threads
are spawned, and reused for every file that thread claims:

```rust
let mut searcher = SearcherBuilder::new()
    .line_number(true)
    .multi_line(false)
    .binary_detection(BinaryDetection::quit(b'\x00'))  // a .md that is actually binary: bail
    .memory_map(MmapChoice::never())                   // §2.4 — non-negotiable
    .heap_limit(Some(HEAP_LIMIT_BYTES))                // 64 KiB (CONTRACT.md §4.5)
    .bom_sniffing(true)
    .build();
```

`heap_limit` is simultaneously the buffer ceiling and the longest line the searcher can handle. The
default buffer capacity is 64 KB and `HEAP_LIMIT_BYTES` is that same 64 KiB, so **four workers cost
256 KB and the buffer never grows**. The price is that a file containing a single line longer than
64 KiB returns an error from `search_file`; the worker increments `skipped` and moves on, and the
count line's ` · N skipped` suffix is the only trace. Long-line notes are rare in prose but real in
machine-generated markdown (one-line tables, an embedded base64 image). See §13.

### 5.5 Ranking

There is no sort control in the panel, so the ordering must be self-evident. It is a three-part key,
ascending:

```rust
rank = (
    kind,                       // 0 = the query matched the file NAME, 1 = content only
    u32::MAX - match_count,     // more matching lines first
    id,                         // stable tie-break = snapshot index order, i.e. the order the
                                // tree is currently showing (CONTRACT.md §4.2)
)
```

A group the filename phase already emitted keeps its filename row; a content group that the filename
phase also hit takes `kind = 0` and sorts above a content-only group.

That is the entire relevance model. No TF-IDF, no tunable weights, no per-field boosts. Justification:
a weighted model that nobody can inspect or configure produces orderings the user cannot predict.
"Name matches first, then whichever file mentions it most, then in tree order" is explainable in one
sentence.

Within a file group, snippets are ordered by `(u8::MAX - tokens_on_line, line)` — lines covering more
of the query first, then document order. Computed in `make_snippet` via the
`line_mask.count_ones()` argument.

### 5.6 Snippet construction

```rust
fn make_snippet(raw: &[u8], line: u32, any: &RegexMatcher, tokens_on_line: u8) -> Snippet {
    // 1. Lossy-decode FIRST, then match against the decoded bytes. Matching the raw bytes and
    //    mapping offsets through a lossy decode is where off-by-N bugs live: U+FFFD is 3 bytes
    //    where the invalid input may have been 1.
    let text: String = String::from_utf8_lossy(raw).into_owned();

    let mut byte_ranges: Vec<(usize, usize)> = Vec::new();
    let _ = any.find_iter(text.as_bytes(), |mm| {
        byte_ranges.push((mm.start(), mm.end()));
        byte_ranges.len() < MAX_RANGES_PER_LINE
    });

    // 2. Column of the first match in the FULL line, in UTF-16 units (for CodeMirror).
    let first = byte_ranges.first().copied().unwrap_or((0, 0));
    let col = utf16_len(&text[..first.0]);
    let len = utf16_len(&text[first.0..first.1]);

    // 3. Window long lines around the first match, on char boundaries.
    let (slice, off, lead, trail) = window(&text, first.0, SNIPPET_WINDOW_CHARS);

    // 4. Re-express the surviving ranges as UTF-16 offsets inside the emitted string.
    let mut out = String::with_capacity(slice.len() + 6);
    if lead { out.push('…'); }
    let base = if lead { 1 } else { 0 };
    out.push_str(slice);
    if trail { out.push('…'); }

    let ranges = byte_ranges.iter()
        .filter(|(a, b)| *a >= off && *b <= off + slice.len())
        .map(|(a, b)| [base + utf16_len(&slice[..a - off]),
                       base + utf16_len(&slice[..b - off])])
        .collect();

    Snippet { line, text: out, ranges, col, len }
}

#[inline]
fn utf16_len(s: &str) -> u32 { s.chars().map(|c| c.len_utf16() as u32).sum() }

#[inline]
fn trim_eol(b: &[u8]) -> &[u8] {
    let b = b.strip_suffix(b"\n").unwrap_or(b);
    b.strip_suffix(b"\r").unwrap_or(b)
}
```

`window` returns a `&str` of at most `SNIPPET_WINDOW_CHARS` characters, centred on the first match,
snapped outward to `char` boundaries, plus its byte offset and whether an ellipsis is needed on each
side. A snippet is therefore never longer than 262 characters, which caps both the IPC payload and
the DOM text node.

### 5.7 The worker loop

Four threads, spawned when the job is built and joined when it ends. No condvar for parking, no park
loop, no `shutdown` flag, nothing alive between queries.

```rust
/// The ONE staleness test, used at every check site (§4.2).
#[inline]
fn stale(job: &Job) -> bool {
    job.generation.load(Ordering::Relaxed) != job.gen
        || job.cancelled.load(Ordering::Relaxed)
}

/// Spawn the scan threads. Returns the handles the coordinator joins.
fn spawn_workers(job: &Arc<Job>) -> Vec<std::thread::JoinHandle<()>> {
    let mut handles = Vec::with_capacity(SEARCH_THREADS);
    for _ in 0..SEARCH_THREADS {
        let job = Arc::clone(job);
        // Spawn failure is not fatal and is not a panic (§5.9): fewer workers is slower, and if
        // none start at all the coordinator scans the vault on its own thread.
        if let Ok(h) = std::thread::Builder::new()
            .name("nc-search".into())
            .stack_size(256 * 1024)              // the scan is iterative; 8 MiB of reserve is waste
            .spawn(move || worker_main(job))
        {
            handles.push(h);
        }
    }
    handles
}

fn worker_main(job: Arc<Job>) {
    let mut searcher = build_searcher();         // §5.4; one per thread, reused across files
    loop {
        if stale(&job) { return; }                                               // cancelled
        if job.files_hit.load(Ordering::Relaxed) >= MAX_FILES { return; }         // cap
        if job.matches_total.load(Ordering::Relaxed) >= MAX_TOTAL_MATCHES { return; }

        let start = job.cursor.fetch_add(CHUNK, Ordering::Relaxed);
        if start >= job.snapshot.files.len() { return; }
        let end = (start + CHUNK).min(job.snapshot.files.len());

        for i in start..end {
            if stale(&job) { return; }
            let entry = match job.snapshot.files.get(i) { Some(e) => e, None => return };

            // MAX_SCAN_BYTES (CONTRACT.md §4.5): a note above the 8 MiB read cap stays reachable
            // by filename but is never content-scanned. The length comes from the OPEN FILE —
            // `entry.size` is always 0 — and the `entry.size` test stays in front of it as a free
            // short-circuit for the day the walker fills the field in.
            if u64::from(entry.size) > MAX_SCAN_BYTES {
                job.skipped.fetch_add(1, Ordering::Relaxed);
                continue;
            }
            let abs = job.snapshot.root.join(&*entry.rel);
            let Ok(mut file) = std::fs::File::open(&abs) else {
                job.skipped.fetch_add(1, Ordering::Relaxed);   // deleted between snapshot and scan
                continue;
            };
            if file.metadata().map(|m| m.len()).unwrap_or(0) > MAX_SCAN_BYTES {
                job.skipped.fetch_add(1, Ordering::Relaxed);
                continue;
            }
            // §5.7's secrets rule: a secrets note stays filename-reachable but contributes no
            // content hits — its bytes must never reach a snippet. Counted as skipped.
            if file_is_secret(&mut file) {
                job.skipped.fetch_add(1, Ordering::Relaxed);
                continue;
            }

            let mut sink = GroupSink { job: &job, snippets: Vec::new(),
                                       match_count: 0, seen_mask: 0 };
            job.scanned.fetch_add(1, Ordering::Relaxed);
            if searcher.search_file(&job.m.any, &file, &mut sink).is_err() {
                job.skipped.fetch_add(1, Ordering::Relaxed);   // unreadable, or long line
                continue;
            }
            if sink.match_count == 0 { continue; }
            if sink.seen_mask != job.m.token_mask_full { continue; }   // AND not satisfied
            job.matches_total.fetch_add(sink.match_count as usize, Ordering::Relaxed);
            if job.files_hit.fetch_add(1, Ordering::Relaxed) >= MAX_FILES { return; }
            let g = build_group(i as u32, entry, sink, job.name_hits.contains(&(i as u32)));
            lock(&job.ranks).push(g.rank);
            lock(&job.out).push(g);
        }
    }
}
```

`job.out` is contended only when a file actually matches — at most 200 times per search — so a plain
`std::sync::Mutex<Vec<_>>` is correct and cheaper than any channel. `lock()` is §5.9's
poison-tolerant helper, never `.unwrap()`.

`i as u32` is the group id, and it is an index into *this generation's* snapshot: the frontend must
not carry an id across a `Complete`.

**Secret notes** (`cairn-type: secrets` in the frontmatter) are never content-scanned: the search
panel is the worst place in the app for a seed or an API key to surface. They stay
filename-reachable — a name match opens the file in the secrets viewer — and `search_expand` on one
returns an empty vector (§11.3). The detector is shared with the tree's secret-note set, so the two
always agree on what a secret is.

### 5.8 Off the UI thread, and what the coordinator does

Two rules:

1. `search_start` hands off with **`crate::spawn_blocking`**. It must not do file I/O on an async
   worker: `search_file` is blocking, and starving the runtime's workers would stall every other
   command. The spawned closure is the **coordinator**, and it occupies **one of the six blocking
   slots for the duration of the search** — which is exactly why the ceiling is 6 and not 4
   (CONTRACT.md §8.5). `search_start` itself returns as soon as the coordinator is spawned; it
   never awaits the scan.
2. Every message send is a thread hop into the JS event loop, so results are **batched** rather
   than sent per file (§6.2).

**Both debounces are the coordinator's, not the frontend's.** CONTRACT.md §1.3 has one entry point
(`search_start`) and CONTRACT.md §4.5 has two debounce constants — `FILENAME_DEBOUNCE_MS = 0` and
`CONTENT_DEBOUNCE_MS = 90` — so the only place they can both live is behind that one command. The
frontend therefore calls `searchStart` once per keystroke and owns no timer (§10.2). The coordinator:

```
0. record the frontend's generation in SearchState; register (gen, cancelled) in SearchState.live
1. staleness check                        -> send Complete { cancelled: true } and return
2. compile the matchers                   -> on failure send Error and return (terminal)
3. filename phase (§7): substring-match the snapshot, send Files    [FILENAME_DEBOUNCE_MS = 0]
4. query shorter than MIN_CONTENT_QUERY_CHARS
       -> send Complete { scanned: 0, .. } and return             [no content scan]
5. sleep CONTENT_DEBOUNCE_MS in <= 15 ms slices, testing `stale` between slices
       -> superseded: send Complete { cancelled: true } and return, releasing the blocking slot
6. build the Job, spawn_workers(), wait on `left`/`done` with a BATCH_FLUSH_MS timeout, drain
   job.out every wakeup, join the handles
7. sort by rank, send Complete { order, .. }
8. remove this job's entry from SearchState.live -- ALWAYS, on every exit path above, so the
   list is empty at rest and a cancelled job cannot be cancelled twice
```

Step 0 and step 8 bracket every other path, including the early returns, which is what keeps
`SearchState.live` empty between queries and makes `cancel_all()` O(live jobs).

Step 3 runs on the coordinator's blocking thread rather than in the async command body, so no CPU
work of any kind lands on a runtime worker; the `Files` message still precedes all I/O, which is what
§6.3 depends on. Step 5's slicing matters: a superseded coordinator that slept the full 90 ms would
hold a blocking slot doing nothing while the user is still typing.

The matchers are compiled before the filename phase so an invalid regex is **one `Error` and nothing
else**. This is the one place where "`Files` is always first" yields: §8.6 makes an invalid regex a
panel state that replaces the result list, so sending filename hits and then an error would put
results behind an error banner. `Error` is terminal for its generation, and no `Complete` follows.

### 5.9 Panic discipline in `search.rs` (gate G7)

`search.rs` is one of the modules carrying `#![deny(clippy::unwrap_used, clippy::expect_used,
clippy::indexing_slicing)]` (CONTRACT.md §6.2, gate G7). Under `panic = "unwind"` a panic here kills
the coordinator task and leaves a search that never completes — no `Complete`, a spinner-shaped hang,
and a leaked blocking slot.

```rust
/// Mutex poisoning cannot corrupt `Vec<FileGroup>`: a poisoned lock here means some worker panicked,
/// and the partial results already pushed are still valid. Recover, never propagate.
#[inline]
fn lock<T>(m: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}
```

| Site | Rule |
|---|---|
| `job.out.lock().unwrap()` | `lock(&job.out)`, above |
| `job.snapshot.files[i]` | `files.get(i)`, return on `None` (§5.7) |
| `SearchState.live.lock().unwrap()` | `lock(&state.search.live)`, the same poison-tolerant helper |
| `q[1..q.len() - 1]` in `parse` | `q.get(1..q.len() - 1)`, falling back to `Query::Literal` on `None` |
| `text[..first.0]` / `slice[..a - off]` in `make_snippet` | `get(..).unwrap_or("")`; the offsets come from the matcher and are char-aligned by construction, so the fallback is unreachable and free |
| `RegexMatcherBuilder::build(..)?` | already a `Result`; it becomes `SearchMsg::Error`, never a panic |
| thread spawn | `if let Ok(h)`, never `.expect()` (§5.7) |
| `m.line_number().unwrap_or(0)` | already safe — `line_number(true)` is set on the searcher |
| `#[allow(clippy::indexing_slicing)]` | permitted on exactly one site: the `1 << i` bit arithmetic for `token_mask_full`, where `i < MAX_TOKENS = 8` is enforced by `parse` |

No condition in search is fatal: a malformed query is a `SearchMsg::Error`, an unreadable or deleted
file is `skipped += 1`, an oversized line is `skipped += 1`, and a vault that disappeared mid-scan is
5,000 skips and an honest count line.

---

## 6. Streaming results to the UI

### 6.1 IPC surface

**Normative: see CONTRACT.md §1.3** (the three signatures, commands 14–16) **and §1.5** (the
`SearchMsg` union). Two rules that shape it: the error type is **`VaultError`, never `String`** (no
command in the app returns a `String` error), and **`search.rs` declares no command** — the addon's
per-command shell is the only place a command is declared, and it makes one call per command.
`search.rs` exposes plain functions for the shell to call:

```rust
// search.rs — no command attribute anywhere in this file
pub async fn start<S: MsgSink + Send + 'static>(
    state: &SearchState, snapshot: Arc<VaultSnapshot>, query: String,
    generation: u64, on_event: S) -> Result<(), VaultError>;
pub fn expand(root: &Path, query: &str, rel: &str) -> Result<Vec<Snippet>, VaultError>;
pub fn cancel(state: &SearchState, generation: u64);
```

The sink is a trait, not a channel type: the shell implements `MsgSink` by sending each message
through a Node-API `ThreadsafeFunction`, which the Electron main process forwards to the renderer.
It is a trait so the engine can be driven from a test with no webview, which is the only way
`search_int.rs` can assert message ORDER at all.

The message *sequencing* is this document's, and CONTRACT.md §1.5 does not restate it:

* **`Files`** — sent before any I/O, always first, may be empty. Filename hits only (§7).
* **`Batch`** — zero or more, in arrival order, never final order (§6.3).
* **`Complete`** — exactly one, always last, **including for a generation that was superseded**
  (with `cancelled: true`). It is what guarantees the coordinator's blocking task terminates and its
  blocking slot is released.
* **`Error`** — terminal for its generation: a bad regex, and no `Complete` follows.

`expand` re-greps one file and answers with up to `MAX_SNIPPETS_PER_FILE` snippets — ~20 µs, and it
self-heals if the file changed since the scan (§11.3).

The frontend keeps **one** generation counter. Every message carries `gen`; the frontend drops
anything whose `gen` is not its current one.

### 6.2 Batching policy

The coordinator loop:

```
loop {
    wait on (left, done) with BATCH_FLUSH_MS (16) timeout, or wake as soon as left == 0
    drain job.out
    while drained is non-empty:
        take groups until BATCH_MAX_GROUPS (8) or the serialized size would exceed
            BATCH_MAX_BYTES (6000), whichever first
        truncate each group's `snippets` to MAX_SNIPPETS_IPC (2)
        sink.send(SearchMsg::Batch { gen, groups })
    if all workers joined or generation != gen: break
}
sort all groups by `rank`; sink.send(SearchMsg::Complete { gen, order, .. })
```

A group is ≈ 90 B of header plus 2 × ≈ 300 B of snippet ≈ 690 B, so 8 groups ≈ 5.5 KB. A full result
set of 200 groups is ~25 messages. Per-message overhead is what forbids per-hit streaming: 5,000
unbatched hits would be tens of milliseconds of main-thread work.

### 6.3 Why results arrive out of order, and what fixes it

Workers claim chunks independently, so `Batch` groups arrive in completion order, which is
nondeterministic. Two mechanisms keep the panel from visibly reshuffling:

* The `Files` message (filename matches) is sent **before any I/O starts** and is pinned to the top of
  the list. On a big vault this is what the user sees first, in under a millisecond.
* Content groups are appended in arrival order. The single `Complete` message carries `order: Vec<u32>`
  — the authoritative `rank`-sorted sequence of group ids — and the frontend applies it with **one**
  DOM reorder (`node.append(...)` in order, which moves existing nodes without recreating them).
  Because the whole scan is 45–65 ms warm, that reorder happens before the eye registers the interim
  order. On a cold vault the reorder is visible, which is honest: it marks the moment the search
  finished.

Do **not** attempt an insertion-sorted live list. It costs O(n) DOM moves per batch and makes the list
squirm while the user is reading it.

---

## 7. The filename path

### 7.1 Why it is separate

It touches no disk, so it is 100–500× faster than the content path and can run on every keystroke.
That is what makes the panel feel instant on a 5,000-note vault, and it is the mitigation for the
cold-cache estimate in §2.6.

### 7.2 Algorithm

**The match is a case-insensitive SUBSTRING, ranked by occurrence count.** There is no fuzzy matcher
and no `nucleo-matcher`: fuzzy subsequence is Obsidian's quick switcher, and Cairn has no quick
switcher — its search panel matches substrings, as Obsidian's does.

```rust
let q = raw.trim();
let use_path = q.contains('/');           // matching the whole path always makes deep vaults noisy
let needle = q.to_ascii_lowercase();      // ASCII-only, length-preserving

for (i, e) in snapshot.files.iter().enumerate() {
    let hay = if use_path { &*e.rel } else { e.name() };   // basename without ".md"
    let n = count_occurrences(&hay.to_ascii_lowercase(), &needle);
    if n > 0 { hits.push((n, i as u32)); }
}
// Most occurrences first, then tree order. A count is the honest ranking signal for a substring
// match: there is no "how well does it match", only "how often".
hits.sort_unstable_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
hits.truncate(MAX_FILENAME_HITS);         // 20
```

Four rules that are not optional:

* **The basename is the haystack unless the query contains `/`.** Matching the whole path always
  makes deep vaults noisy — a query for a common word would hit every file under a folder whose name
  contains it.
* **ALL occurrences are highlighted**, not just the first: a name that contains the query twice is a
  better hit than one that contains it once, and showing only the first would misreport why the row
  is there. A `/`-query highlights nothing, because path offsets are not rendered in the row.
* **Lowercasing is ASCII-only by design.** `to_lowercase()` can change a string's LENGTH (`İ` → `i̇`,
  one char to two), which would put every span after it at the wrong offset; `to_ascii_lowercase` is
  length-preserving by construction. The cost is that a query for `STRASSE` does not match `straße`
  — Obsidian's search does not either.
* **Spans are UTF-16 code units** (§4.3), found on the lowered haystack and therefore valid in the
  original.

`MAX_FILENAME_HITS = 20` is the hard cap. The phase costs 0.053–0.341 ms on 5,000 nested paths
*(measured)* and no I/O.

### 7.3 Surfacing — no separate modal

Filename results are rendered as a **`Files` section pinned to the top of the same search panel**,
above the content results, capped at 20 and always fully visible (no collapse). There is **no Quick
Switcher modal and no command palette** — the scope forbids one, and a second overlay would be a
second visual surface to keep pixel-identical for no functional gain.

One keyboard entry point: **`Cmd/Ctrl+Shift+F`** reveals the search panel and focuses the input,
selecting any existing text. The panel is left with its back control (`.sr-back`). That is the whole
binding surface.

### 7.4 The MPL-2.0 fallback — deleted

**§7.4. (DELETED — `nucleo-matcher` does not ship; the substring matcher needs no extra crate and no
licence fallback.)**

---

## 8. The panel

### 8.1 Placement and geometry

**Normative: see CONTRACT.md §4.4** — the panel **replaces** the file tree in the sidebar (the two do
not stack) — **and §5.2** for the row box model.

The panel **declares no row geometry and no colour of its own** — its own chrome (the input row, the
count line, the section label, the back control) is all it sizes. It consumes, by name:

| Token | Used for |
|---|---|
| `--row-h` | every result row's pitch |
| `--tree-fs` | result-row font-size |
| `--cx0`, `--chev-w` | the group-header chevron box |
| `--tx0` | result-row text edge, and the snippet block's left inset |
| `--row-indent`, `--gx0` | reserved — the result list is flat, so it draws no indent guides. **`--ind` does not exist** (CONTRACT.md §5.1, §5.2): `--row-indent` is the one name for the step, there is no alias, and the panel must not invent one |
| `--text-highlight`, `--text-error`, `--bg-form-field`, `--bg-modifier-border`, `--border-focus` | the match highlight, the error box, the input's ground/border/focus ring |
| `--font-ui`, `--fs-ui-small`, `--fs-ui-smaller` | the panel's type |

The sidebar column, the tab strip and the vault bar are unchanged and belong to their owners.

**Two consequences of CONTRACT.md §3.3's cap banners that the panel must not get wrong.** The banners
belong to owner 01 and sit *between* the toolbar band and the scroller, as siblings of it — not
inside it, so they neither scroll away nor enter the panel's coordinate system. They are present or
absent regardless of which sidebar view is showing, because they describe the *vault*, not the tree.
(a) The panel's flex column starts **below** them and its available height is whatever the live box
gives it — so §8.2 states no absolute y coordinate; and (b) the panel must never assume a constant
height or draw a banner of its own.

### 8.2 Vertical stack

Expressed as a flex column inside the sidebar body, because the absolute y coordinates belong to
CONTRACT.md §5 and this panel must not restate them:

```
[ .cap-banner ]  0–2 × 24px          owner 01 — a SIBLING of the scroller, not inside it
┌ .search-panel   flex column, fills the sidebar body ─────────────────────┐
│ .sr-input-row   40px    30px field + 5px above and below                 │
│ .sr-count       --row-h (27px), hidden while the query is empty          │
│ .sr-list        flex: 1 — this element IS `.search-scroller` (§8.3)      │
│    ├─ "Files" section   0…20 rows at --row-h, never collapsible          │
│    └─ content groups    header at --row-h + an expanded snippet block    │
└──────────────────────────────────────────────────────────────────────────┘
[ vault bar ]                        owner 01 — below the panel, unchanged
```

There is no progress bar band: the count line is the affordance (§8.7).

**The panel contributes exactly one scrollable box to the document, and it is `.sr-list`**
(CONTRACT.md §5.2). `.search-panel` is `overflow: hidden` and every other band is fixed-height,
single-line and ellipsised, so nothing else in this file may take `overflow: auto | scroll | overlay`.
`.tree-scroller` and `.search-scroller` are never live at the same time, because the panel *replaces*
the tree (CONTRACT.md §4.4), which is what keeps the document's ceiling at two.

### 8.3 CSS — token-consuming only

**`tokens.css` (owner 01) is the only declaration site for a custom property** (CONTRACT.md §5.1).
`search.css` declares none. Three prose rules survive from the full sheet this section used to print,
and `search.css` is the source of truth for the rest:

* **Every row consumes the tree's tokens by name** — `--row-h`, `--tree-fs`, `--tx0`, `--cx0`,
  `--chev-w` — so the panel and the tree cannot drift apart. The scrolling rules for `.search-scroller`
  are declared once, in the sheet that carries CONTRACT §5.2's box model; `search.css` MUST NOT
  restate them. A rule that misses its real scroller leaves it on the engine's default scrollbar.
* **A row is a block with padding, not a flex container.** `text-overflow: ellipsis` does not apply
  to an anonymous flex item, so a flex row would hard-clip long filenames instead of ellipsing them.
  The badge floats; the chevron is a `::before`; snippets are clamped to two lines.
* **No transitions and no animations anywhere in this file** (CONTRACT.md §5.1). The group chevron's
  rotation is instant.

The search-match highlight is `--text-highlight`, a yellow, deliberately not the accent hue: at the
accent's alpha a match is indistinguishable from `--text-selection` the moment its row is selected,
which is exactly when the user is reading it. The error box consumes `--text-error`.

### 8.4 Highlight rendering

Never use `innerHTML` on snippet text — a note can contain `<script>`. Build the row from the
`ranges` array with `document.createTextNode` and `<span class="sr-hit">`:

```ts
function renderHighlighted(text: string, ranges: [number, number][]): DocumentFragment {
  const frag = document.createDocumentFragment();
  let cursor = 0;
  for (const [a, b] of ranges) {
    if (a > cursor) frag.append(document.createTextNode(text.slice(cursor, a)));
    const hit = document.createElement("span");
    hit.className = "sr-hit";
    hit.textContent = text.slice(a, b);
    frag.append(hit);
    cursor = b;
  }
  if (cursor < text.length) frag.append(document.createTextNode(text.slice(cursor)));
  return frag;
}
```

`ranges` are UTF-16 offsets, which is exactly what `String.prototype.slice` indexes by (§4.3).

### 8.5 The result-count line

Rendered only when the query is non-empty. Exact copy:

| Situation | Text |
|---|---|
| in flight, nothing yet, > 120 ms elapsed | `Searching…` |
| in flight, partial | `47 matches in 12 files · searching…` |
| done | `312 matches in 74 files` |
| done, one of each | `1 match in 1 file` |
| smart case engaged | append ` · case-sensitive` |
| file/match cap hit | `1000+ matches in 200+ files · stopped` |
| regex mode | prepend `regex · ` |
| files skipped | append ` · 2 skipped` |

Numbers use `toLocaleString()` so 5,000 renders as `5,000`. `1000+` / `200+` are
`MAX_TOTAL_MATCHES` and `MAX_FILES` (CONTRACT.md §4.5); do not hardcode either literal — render them
from the constants so the copy cannot drift from the caps. **The `+` is attached per cap actually
reached**, so the real cap row reads `526 matches in 200+ files · stopped` rather than claiming
1,000+ matches it did not find; both caps hit renders the exact string in the table. Below 120 ms of
a content search the line stays empty rather than flashing `Searching…` (§8.7).

The ` · N skipped` suffix has three causes: a file that vanished between the snapshot and the scan, a
file whose single longest line exceeds `HEAP_LIMIT_BYTES`, and a file above `MAX_SCAN_BYTES`. It is
deliberately one bucket — the user's question is "did anything get missed", not "why".

### 8.6 Empty and error states

| Condition | Primary (`.sr-state-primary`) | Secondary (`.sr-state-secondary`) |
|---|---|---|
| query empty | `Search this vault` | `Wrap the query in /slashes/ for a regular expression.` |
| query is 1 char, no filename hit | `Type 2 characters to search note contents` | — |
| ≥ 2 chars, complete, 0 results | `No results` | `Searched 5,000 notes in 48 ms` |
| invalid regex | rendered in `.sr-error`, verbatim first line from `RegexMatcher::build` | — |
| vault has no notes | `This vault has no notes` | — |

The regex hint in the empty state is the *only* place the escape hatch is documented: it is
discoverable to anyone who opens search, and it costs no settings UI. The "Searched 5,000 notes in
48 ms" line appears only on the zero-result state, where the user's real question is "did it actually
look?".

### 8.7 Progress affordance — text, not an animation

There is no progress bar and no `@keyframes`. CONTRACT.md §5.1 upholds "no transitions, no
animations" everywhere, and the reason is not stylistic: an animating element is promoted to its own
compositing surface for the duration of the animation, and a surface that appears every time the
user pauses mid-word is the worst possible place to spend one.

What replaces it: **the count line** (§8.5) reads `Searching…` once a content search has been in
flight for **> 120 ms** with no `Batch` yet received, and switches to the partial-count form on the
first `Batch`. Below 120 ms nothing appears at all, so a warm 5 ms search shows no chrome whatsoever.
No bar, no spinner, no skeleton rows.

### 8.8 Expansion policy and the DOM budget

* Filename rows are leaves: no chevron behaviour, no snippets.
* Content groups **1–10 render expanded**; **11 and beyond render collapsed**.
* A collapsed group renders **no** snippet DOM at all. Expanding it calls `searchExpand` and builds
  the children then.
* Collapse state is keyed by `rel` and **discarded whenever the query changes**; it survives streaming
  updates within one query.

Worst-case DOM: 20 filename rows + 200 group headers + 10 × 8 snippets = **300 elements**, against
the **≤ 800** ceiling CONTRACT.md §4.4 sets for the `search` scenario (the `idle` ceiling of 400 is a
different scenario and does not apply while the panel is open). Without this policy it would be
1,820, which fails that gate outright.

**The panel has no scroll handler at all** — the list is a plain scrolling box of at most ~300 real
elements, not a virtualiser. Two obligations follow: never attach a `scroll` listener to `.sr-list`
(a re-run on scroll, a "load more", or a sticky-header recompute would put work on every frame of
every fling), and never let the DOM grow past the ceiling, because the paint cost of a long list is
a scrolling cost.

### 8.9 Keyboard

| Key | Action |
|---|---|
| `Cmd/Ctrl+Shift+F` | reveal the panel, focus the input, select existing text |
| `Esc` (input non-empty) | clear the input, cancel the search, keep focus |
| `Esc` (input empty) | return focus to the editor |
| `↓` / `↑` | move the row cursor over the flattened visible rows (filename rows, group headers, visible snippets) |
| `Enter` | open the row under the cursor (§9) |
| `←` on a group header | collapse |
| `→` on a group header | expand (triggers `searchExpand`) |
| `Cmd/Ctrl+Enter` | open and keep focus in the search input |

No other bindings. There is no command palette.

---

## 9. Opening a result

`click` on a filename row, a group header, or a snippet — or `Enter` on the row cursor — calls:

```ts
await openSearchResult(rel: string, line: number, col: number, len: number);
```

`line` is 1-based; `col` and `len` are UTF-16 code units within that line, taken straight from the
`Snippet` (§4.3). A group header passes the `line`/`col`/`len` of its **first** snippet; a filename-only
row passes `line = 1, col = 0, len = 0`.

```ts
async function openSearchResult(rel, line, col, len) {
  await openNote(rel);                       // owner 03: loads the doc into the single tab
  const doc = view.state.doc;
  const ln  = doc.line(Math.min(Math.max(line, 1), doc.lines));   // clamp: the file may have changed
  const from = Math.min(ln.from + col, ln.to);
  const to   = Math.min(from + len, ln.to);
  view.dispatch({
    selection: EditorSelection.single(from, to),
    effects: EditorView.scrollIntoView(from, { y: "center" }),
  });
  view.focus();
}
```

Clamping is required, not optional: the file may have been edited (by us or by Obsidian) between the
scan and the click, so `line` may exceed `doc.lines` and `col` may exceed the line length. A stale
position must scroll to the nearest valid spot, never throw.

The match is shown by **selecting** it — no flash animation, no temporary decoration. The editor's
existing selection styling is the whole affordance.

`view` is **the** `EditorView` — there is exactly one for the process lifetime (CONTRACT.md §4.3), so
this function never constructs or destroys an editor; it dispatches into the one that is already
mounted.

Focus moves to the editor, and the search panel keeps its results and its scroll position, so the user
can `Cmd/Ctrl+Shift+F` back and continue down the list.

---

## 10. Cancellation

### 10.1 The rule

**One content search at a time, identified by a monotonically increasing `u64` generation.** Anything
whose generation is not `SearchState.generation` is garbage and is discarded at the earliest
opportunity by whoever notices first. That counter is search's only at-rest state, and it is distinct
from the tree's `epoch` — the two are never compared.

### 10.2 The frontend side

```
on input event:
  gen = ++localGen
  if query.trim() === "":
    searchCancel(gen); clear the panel; return
  searchStart(query, gen)             // one call per keystroke; the frontend owns no timer
```

**The frontend has no debounce timer at all.** Both debounces are constants in Rust —
`FILENAME_DEBOUNCE_MS = 0`, `CONTENT_DEBOUNCE_MS = 90` (CONTRACT.md §4.5) — and CONTRACT.md §1.3
exposes one entry point, so the coordinator owns them (§5.8). The behaviour the user sees is
unchanged; the timer simply moved to the side that has the constants.

* **Filename path: 0 ms.** It costs 0.3 ms and no I/O; debouncing it would only make the panel feel
  slower. `Files` is on the wire within about a millisecond of the keystroke.
* **Content path: 90 ms**, spent inside the coordinator before any file is opened. A warm search is
  2–5 ms, so debouncing saves little warm; but a cold search is 150–400 ms *(estimated)*, and ten
  keystrokes without a debounce would queue several seconds of I/O. 90 ms is below the ~100 ms
  threshold at which a response stops feeling immediate, and above a fast typist's ~60 ms inter-key
  interval.
* Every arriving `SearchMsg` with `msg.gen !== localGen` is **dropped without touching the DOM**.
  This is defence in depth; the backend already stops sending.

One `search_start` per keystroke is deliberate: a superseded call costs a generation bump, one
filename pass and a `Complete` — no file is opened.

### 10.3 The backend side

`search_start` **stores** the generation it was handed **first thing** — before parsing, before
touching the snapshot, and before the coordinator is spawned. It does not invent or increment it:
the frontend owns the number and Rust records the newest one it has seen (CONTRACT.md §4.3). From
that instant, four independent checks unwind the previous job:

| Check | Location | Granularity |
|---|---|---|
| stale (`generation != gen` **or** `job.cancelled`) | the coordinator's debounce sleep | ≤ 15 ms, and no I/O has started |
| stale | top of the worker chunk loop | ≤ 32 files ≈ 0.3 ms |
| stale | per-file, inside the chunk | 1 file ≈ 20 µs |
| stale | `GroupSink::matched`, returns `Ok(false)` | 1 matched line |

The last is the one that matters for pathological files: a 100 MB note matching on every line aborts
within one line, not after 100 MB. The first is the one that matters in normal typing — a superseded
query is almost always still inside its 90 ms debounce, so it dies having opened no file at all.

Workers of the superseded job **exit**; they do not pick up the new one, because the new job spawns
its own four threads. The cost of that is `SEARCH_THREADS × ~60 µs ≈ 240 µs` of spawn latency per
query, 0.4% of a 45–65 ms search and the price of holding nothing at rest (CONTRACT.md §4.1). No
thread is ever killed, no work is ever orphaned, and no allocation outlives the job (`Job` is an
`Arc`; the last worker to drop it frees the result vector, the matchers and the pinned snapshot).

`Complete` is still sent for a cancelled generation, with `cancelled: true`. The frontend ignores it
(wrong `gen`), but it guarantees the coordinator's blocking task always terminates and never leaks.

---

## 11. Vault switch and on-disk changes

### 11.1 Vault switch

**Normative: see CONTRACT.md §4.3** for the ordering on both sides. Search's obligations inside it
are two lines: the frontend's step 4 is `searchCancel(gen)` plus clearing the panel, and the Rust side
calls **`state.search.cancel_all()`** before the outgoing `Vault` is dropped.

**It is a cancellation, not a generation bump.** A vault switch must not hand the frontend a number
it never issued. `cancel_all()` sets every live job's `cancelled` flag (§4.2), which is
generation-independent and therefore cannot collide with the next keystroke's number. A cancelled
job's last message is `{kind:'complete', cancelled:true}` on **its own** generation, which the
frontend drops by the ordinary staleness rule.

What survives from this section is the reason that ordering is safe, which is search's own invariant:

* the cancellation happens **before** the old `Vault`, and therefore the old snapshot, is dropped,
  so every in-flight worker sees a cancelled job at its next check;
* a worker finishes at most its current file (≤ ~1 ms) and then **exits** — there is no pool to park,
  and nothing to tear down;
* the old `VaultSnapshot` is freed when the last worker drops its `Arc`, which is why a path can never
  dangle even though the vault it names is gone;
* nothing holds a swappable snapshot. The next search pulls a fresh `Arc`, building it lazily on
  first use (CONTRACT.md §4.2).

The panel is cleared by the frontend as part of that sequence — input emptied, results dropped,
collapse map cleared, count line hidden — not in reaction to an event.

### 11.2 A file changes on disk

The vault is a plain directory that Obsidian, `git`, and sync clients may write at any time. Three
distinct cases:

**During a search.** The job holds an `Arc` to an immutable snapshot, so the path list cannot change
underneath it. Per file:
* **Deleted** → `File::open` returns `NotFound` → `search_file` returns `Err` → `skipped += 1`, move
  on. No error surfaces to the user; the count line's ` · N skipped` suffix is the only trace.
* **Modified** → read with ordinary `read()` calls (memory maps are off, §2.4), so the worst outcome
  is a snippet that is a few milliseconds stale. No `SIGBUS`, no torn mapping, no crash.
* **Created** → not in this snapshot; it will appear on the next search.

**With results on screen.** The panel subscribes to **`nc://tree-changed { epoch }`** (CONTRACT.md
§1.4) and schedules a **silent re-run of the identical query after `RERUN_QUIET_MS` = 400 ms of
quiet**, replacing the results in place and preserving the scroll position and the collapse map.
Deleted files' groups therefore vanish on their own; edited files' snippets refresh. Re-runs are
rate-limited to `RERUN_MIN_INTERVAL_MS` = 2 s (CONTRACT.md §4.5), so a `git checkout` or a sync burst
cannot thrash the scan. A re-run takes a **new** generation, exactly like a keystroke, so a re-run
and a keystroke can never interleave.

The panel also listens for `nc://vault-opened` and clears itself, which is the same teardown as
§11.1 for the case where the vault changed underneath it.

**On the currently-open note.** No special case. It is re-scanned from disk like any other file. This
does mean unsaved in-editor changes are not searchable; given the editor autosaves (owner 03), the
window is small. Do not attempt to splice the live `EditorState` into the scan — that would put the
document text on both sides of the bridge and duplicate its memory.

### 11.3 `search_expand` against a changed file

`searchExpand` re-greps the single file at call time. If the file changed since the scan, the user
gets the *current* snippets — which is right — and if it was deleted, it returns `Ok(vec![])` and the
frontend removes the group. A deleted file is **not** a `notFound` `VaultError`: an empty vector is
the honest answer to "what does this file match now", and it keeps a routine race off the error path.
A secrets note also returns an empty vector — the content scan never saw it, so there is nothing to
expand. This is why expansion re-greps rather than reading from a backend cache: correctness for
free, and no per-search snippet cache to hold in memory.

---

## 12. Memory budget

**§12. (DELETED — the live figures are CONTRACT §4.4 and §8.2: 0.44 MB at rest, 4.7 MB peak, with
the snapshot charged to search and zero if the panel is never opened.)**

---

## 13. Edge cases

| Case | Behaviour |
|---|---|
| Note is not valid UTF-8 | `String::from_utf8_lossy` per matched line; U+FFFD appears in the snippet. Never an error. |
| Note has a UTF-8/UTF-16 BOM | `bom_sniffing(true)` transcodes via `encoding_rs`. |
| CRLF line endings | `trim_eol` strips `\r\n`; highlight offsets are computed after trimming. |
| A single line longer than **64 KiB** | `search_file` errors, `skipped += 1`, file omitted from content results (it is still reachable by filename). Surfaced only in the count line. `HEAP_LIMIT_BYTES` is both the buffer ceiling and the line ceiling (CONTRACT.md §4.5). |
| A note larger than `MAX_SCAN_BYTES` (8 MiB) | Never opened by the scan: `skipped += 1` before any I/O. It is the same 8 MiB cap the editor refuses to open, so a note search cannot reach is also a note the app cannot show. |
| A secret note | Filename-reachable, never content-scanned, `expand` returns empty (§5.7, §11.3). |
| A note that is actually binary | `BinaryDetection::quit(0)` stops at the first NUL; partial results before it are discarded. |
| Symlinked notes / cycles | The scanner does not follow symlinks and does not list them (CONTRACT.md §3.6), so they never enter the snapshot. Search never walks, so it cannot loop. |
| Query is only whitespace | `parse` trims → `Query::Empty` → empty state, no search. |
| Query is `/` or `//` | Length < 3 → treated as a literal, not a regex. |
| Query contains > 8 tokens | Tokens beyond 8 are ignored. The count line is unaffected; this is a silent, documented cap. |
| Query is 1 character | Filename path only. Content search does not run. |
| Vault has 0 notes | `This vault has no notes`. |
| Two searches at the same `generation` | Impossible: the frontend increments before every call. |
| Panel closed mid-search | `searchCancel` on unmount; workers unwind within one chunk, then exit. |
| A search running when the vault root disappears | Every `search_file` fails: 5,000 skips, an empty result set, one `Complete`. The `nc://vault-lost` handler (owner 01) owns what the user sees; search surfaces nothing of its own. |
| The tree is truncated at the 50,000-node cap | Search sees exactly what the tree sees — the snapshot is built from the same walk — so results are truncated identically and silently. The banner the tree shows is the only signal. |

---

## 14. Acceptance criteria

Measurable, on a 5,000-note / 10–25 MB vault:

1. Typing a character updates the **Files** section within **16 ms** (one frame) of the keystroke.
2. A warm full-content search meets **gate G4: ≤ 65 ms on 4 threads over the 10 MB corpus**
   (CONTRACT.md §6.5 — 1.25× the measured 48.9 ms median, with the 25 MB corpus informational only);
   the first `Batch` arrives in **< 30 ms** p95.
3. Ten keystrokes typed at 60 ms intervals result in **at most 1** content search reaching the scan
   threads. With the debounce inside the coordinator, every superseded query dies during its sleep,
   having opened no file.
4. Process resident memory after 500 consecutive distinct searches is bounded and plateaued: no
   steady growth with search count.
5. Switching vaults during an active search leaves no thread running the old query after **5 ms**, and
   frees the old snapshot.
6. Deleting a file that is in the visible result set removes its group within **2.5 s** with no error
   toast and no console error. (150 ms watcher debounce + 400 ms `RERUN_QUIET_MS` + the re-run.)
7. Clicking a snippet in a note containing emoji and CJK selects **exactly** the matched text — this is
   the UTF-16 offset regression test and it must be automated.
8. `/[/` renders an inline error, not a crash and not an empty result list.
9. `MD` (uppercase) returns strictly fewer results than `md` on a vault containing both cases, and the
   count line says `case-sensitive`.
10. Memory attributable to search stays within CONTRACT.md §4.4's figures — 0.44 MB at rest, 4.7 MB
    peak — measured by diffing a run with the panel never opened against one with 50 searches
    performed.
11. The panel's DOM stays **≤ 800 nodes** with 200 groups on screen (CONTRACT.md §4.4, §8.8).
12. `search.rs` compiles clean under `#![deny(clippy::unwrap_used, clippy::expect_used,
    clippy::indexing_slicing)]` with at most the one `#[allow]` §5.9 names — gate G7.

---

## 15. Rejected alternatives

| Alternative | Verdict |
|---|---|
| `tantivy` | **Rejected.** Creates an on-disk index directory beside the `.md` files — a second source of truth, violating the "storage format identical to Obsidian" decision. Its `IndexWriter` arena alone defaults to tens of MB, and it adds ~40 crates. Doc-level postings *measured* at 13.6–18.6 MB before any of tantivy's own overhead. |
| SQLite FTS5 | **Rejected.** Same on-disk-index objection, plus ~1.5 MB of library, plus the same staleness problem when Obsidian writes the vault. |
| Trigram substring index | **Rejected.** ~10 M postings ≈ 40 MB of postings alone for a 25 MB vault, on top of the term index it would supplement. |
| Persisting the index and `mmap`-ing it at startup | **Rejected.** Fixes cold start but not staleness, and touched pages still count toward RSS. Adds an invalidation protocol against an external writer we do not control. |
| `MmapChoice::auto()` for reads | **Rejected.** *Measured* zero benefit (48.3 vs 48.9 ms), and its `unsafe` contract ("the file won't be mutated") is exactly the assumption this product cannot make. A concurrent truncate is a `SIGBUS`. |
| `rayon` for the fan-out | **Rejected** (though *measured* as equivalent: mean 2.74–4.61 ms). Four hand-spawned threads sharing an `AtomicUsize` cursor is ~40 lines, allocates no work-stealing deques, and files are uniform enough that stealing buys nothing. |
| **A persistent worker pool** | **Rejected** (CONTRACT.md §4.1). Permanent threads plus 4 × 64 KB of line buffers at rest, for a feature used for seconds per session, buy 240 µs of spawn latency, 0.4% of a search. |
| `ignore::WalkBuilder` per search | **Rejected**, with no fallback role left. Walking per query costs a *measured* 6–12 ms for information the lazy `Arc<VaultSnapshot>` already has (CONTRACT.md §4.2). |
| Shelling out to `rg` | **Rejected.** Not a shippable dependency, no cancellation, no structured streaming, and a process spawn per keystroke. |
| Per-file IPC messages instead of batches | **Rejected.** Each send is a thread hop plus a JS eval; 200 of them is 200 main-thread interruptions. Batching at 16 ms costs nothing perceptible. |
| A whole-word toggle | **Rejected.** It is configuration UI, and substring matching is required for incremental typing (`obsi` must find `obsidian` mid-word). The regex form `/\bword\b/` covers the need. *Verified working.* |
| A case-sensitivity toggle | **Rejected** in favour of smart case, for the same reason. |
| Insertion-sorted live result list | **Rejected.** O(n) DOM moves per batch and the list visibly squirms. One reorder on `Complete` instead. |
| Quick Switcher modal | **Rejected.** The scope forbids a command palette, and a second overlay is a second surface to keep pixel-identical. Filename matching lives in the same panel as a pinned section. |
| Searching the live `EditorState` for the open note | **Rejected.** Puts the document on both sides of the bridge and duplicates its memory for one file's worth of freshness. |
| An animated indeterminate progress bar | **Rejected** (CONTRACT.md §5.1). It is an animation, and an animating element takes its own compositing surface. The count line's `Searching…` costs a text node. §8.7. |
| A `--sr-*` token set for the panel | **Rejected** (CONTRACT.md §5.1). Most of its names were the token set under different spellings, and three of its values silently disagreed (hover alpha, field ground, match highlight). `tokens.css` is the only declaration site; `search.css` consumes. §8.3. |

---

## 16. Appendix — reproducing the measurements

**§16. (DELETED — the benchmark harnesses were scratch binaries against two generated corpora; the
measurements they produced are §2's and the generator that produces the corpora is
`tools/gen-vault.sh`.)**
