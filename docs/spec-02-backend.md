# spec-02 — Rust core: vault model, filesystem, watcher, persistence

**Status: subordinate to `docs/CONTRACT.md`.** CONTRACT.md is normative and overrides this document
wherever the two disagree. Where a rule is the contract's, this document carries a pointer rather
than a paraphrase.

**This document is normative for** the internal design an implementer builds from, none of which the
contract specifies:

- crate selection and the reasoning behind each accept/reject (§1);
- the in-memory arena — `Node`, `VaultTree`, the walk, the rescan diff, `nat_cmp`, compaction (§4);
- path identity and resolution inside the arena (§5);
- the *implementation* of the filesystem operations whose observable sequence the contract fixes (§6);
- the watcher: backend configuration, the coalescing thread, event classification (§7);
- the folder picker, `prefs.rs`, and the mechanics of a vault switch (§9);
- `error.rs`'s `io::ErrorKind` mapping (§10), `MemReport` (§11.7), the Rust module layout (§14.3),
  and the Rust-side test list (§15).

**This document defers to CONTRACT.md for:**

| Subject | Contract § |
|---|---|
| IPC conventions, the 25-command table, the event table, `ipc.d.ts`, the flush-on-quit handshake | §1 |
| The 24-byte note frame (`note_frame.rs` / `note_frame.js`), `write_note`'s exact call, the round-trip invariant | §2 |
| `TreeBlob v1`, the node and depth caps, where expansion state lives, echo-suppression rules | §3 |
| The search engine, the `Arc<VaultSnapshot>` seam, vault-switch ordering, all search constants | §4 |
| Tree box model, window geometry, chrome | §5 |
| `Cargo.toml`, `[profile.release]`, the file table, the acceptance gates | §6 |
| Every data-loss path, the atomic write sequence, the tab strip, first run, `state.json` | §7 |
| Every memory number, the composition of the footprint | §8 |
| The four escalations, including the bundle identifier | §9 |

A bare `§N` below always means a section of *this* document; everything else cites CONTRACT.md by
number. The reference screenshots `1.png` / `2.png` no longer exist, so nothing here plans to
re-sample them.

---

## 0. Measured baseline (read this first)

Fixture: **5,000 `.md` notes across 620 directories, 10,059,538 B of text, max depth 4** (5,621 nodes
including the root). Generator: `tools/gen-vault.sh` — see §15.1.

| Measurement | Result | Implication |
|---|---|---|
| `size_of::<Node>()` | **24 bytes** | compiler-verified, gate G1; see §4.2 |
| Arena for the whole vault | **448 KiB** = **81.6 bytes/node** | see §4.3 |
| Full in-app vault scan, 5,621 nodes | **40 ms** | the governing number; gate G3 |
| `rel_path_into` / `abs_path_into` | **~150 ns/path** | paths are cheaper to rebuild than to store (§4.4) |
| `fs::read_to_string` of an 11 KB note | **0.015 ms** | a content cache would be slower than the syscall (§4.8) |
| Atomic write: tmp + `fsync` + `rename` (11 KB) | **5.04 ms** | invisible behind an 800 ms autosave debounce |
| Atomic write: tmp + `rename`, no fsync | 0.34 ms | not durable; rejected |
| Threaded content scan, 1 / 2 / **4** / 8 threads | 90–142 / 54–56 / **32–33** / 42 ms | **4 threads is the optimum; 8 regressed 31%.** This is the measurement behind `SEARCH_THREADS = 4` (CONTRACT §4.1). |

The model must be **linear with a small constant** so that 50,000 notes costs ~4 MB and not ~50 MB,
and the backend must not be the problem. §4 achieves both. The footprint gate is `phys_footprint`
summed over the responsibility group (CONTRACT §8.1) — never RSS, and never the app process alone.

---

## 1. Crate list

### 1.1 Method

Candidate dependencies are measured by diffing resolved trees per target. Crate count is not a
constraint and is not used as one: the entire Rust side of a 5,000-note vault measured **0.5% of the
app**, so dependencies are chosen on capability and on what they do to the binary's behaviour, not
on how many lines `cargo tree` prints.

### 1.2 Accepted — direct dependencies

**Normative manifest, with pinned versions and features: see CONTRACT.md §6.2** and `core/Cargo.toml`.
Versions are deliberately not repeated here; this table is only the reason each crate is present.

| Crate | Why it earns its place |
|---|---|
| `serde` / `serde_json` | The ~600-byte `state.json` and every JSON command/event payload. |
| `notify` | The only maintained cross-platform FSEvents/inotify wrapper. `default-features = false, features = ["macos_fsevent"]` is kept because it makes the intent explicit and pins behaviour if the default changes. |
| `trash` | Deleting a user's notes irreversibly is not acceptable (§6.5). **Default features are kept**: the optional `chrono` writes the freedesktop `.trashinfo` `DeletionDate` field, without which Linux file managers cannot restore properly — i.e. dropping it silently breaks the one recovery path the delete design depends on. |
| `rfd` | Native folder picker for "switch vault". `app::pick_vault` drives it from Rust and never exposes it to JS (§9.2); the Electron addon deliberately does not implement command 1, because an addon has no main-thread hop to offer. |
| `memchr` | Line-boundary extraction, and it is pinned to `opt-level = 3` in the release profile. |
| `percent-encoding` | Decodes the `x-path` header (CONTRACT §2.3). |
| `libc` | Declared for every target. `kill(pid, 0)` for the temp sweep, xattr carry, `O_NONBLOCK` opens, and the errno mapping. |
| `tokio` (`rt`, `rt-multi-thread`) | Declared directly so the runtime can be built and sized (§3.2) — `tokio::runtime::Builder` cannot be named otherwise. Adds nothing else. |
| `grep-searcher`, `grep-regex`, `grep-matcher` | The search engine (CONTRACT §4.1). `MmapChoice::never()` is set on every `Searcher`, so `memmap2` links and is never exercised. |

### 1.3 Rejected — and what we use instead

| Rejected | Why | Instead |
|---|---|---|
| `notify-debouncer-full` / `-mini` | The full debouncer maintains its own cache of paths and metadata to reconstruct rename pairs — a second copy of tree data we already hold. Our rescan-the-parent-directory strategy (§7.3) is immune to imprecise rename events by design, so that reconstruction is wasted work. | ~60 lines of `recv_timeout` coalescing in `watcher.rs` (§7.2) |
| `ignore` | It exists to parse `.gitignore` / `.ignore` hierarchies, which we deliberately do not honour (neither does Obsidian). Our skip rule is four conditions. | 2 lines in `scan.rs` (§4.6) |
| `walkdir` | Present transitively via `notify`, unused. It yields a flat `DirEntry` stream with a depth counter; our walk must thread a parent `NodeId` and a per-directory child run through the arena as it goes, and must enforce two caps mid-walk. | hand-rolled queue walk (§4.6) |
| `slotmap` | We need a free list over a `Vec`, which is `Vec<u32>` plus two lines. `slotmap` adds a generation counter per slot (+4–8 B/node, 17–33% on a 24-byte node) to solve stale-handle detection — a problem we do not have, because our external IDs are paths, not indices (§5.1). | `Vec<Node>` + `free_nodes: Vec<NodeId>` (§4.2) |
| `parking_lot` | Present transitively, not used directly. Since Rust 1.62 `std::sync::Mutex` is a 4-byte futex word on Linux and `os_unfair_lock` on macOS; there is no size or speed argument left. | `std::sync::{Mutex, RwLock}` with poison recovery (§3.3) |
| `thiserror` | We derive `Display` for exactly one enum. | ~25 hand-written lines in `error.rs` (§10) |
| `rayon` | A work-stealing scheduler for a loop that is I/O-bound on `open`/`read` is pure overhead, and 8-way parallelism measured *slower* than 4-way (§0). | the search engine's own 4 threads per query (CONTRACT §4.1) |
| `tantivy` / any inverted index | An index over 5,000 notes costs 5–20 MB resident and 190–500 ms of build to accelerate an operation measured at 32–65 ms, plus incremental maintenance on every save and a persistence format that would have to live either in the user's vault (forbidden, §4.6-8) or in the config directory where it goes stale against external edits. CONTRACT §4.4 strikes every index proposal in the project. | streaming scan, no index |
| `nucleo` / `nucleo-matcher` | Filename search is a case-insensitive substring match ranked by occurrence count (spec-05 §7.2); a fuzzy subsequence matcher is Obsidian's quick switcher, not its search panel. | the substring matcher in `search.rs` |
| `mimalloc` / `tikv-jemallocator` | See §13.3. Our allocation pattern is dominated by buffers above both allocators' mmap thresholds, so they are already `munmap`'d on free. | system allocator |
| `chrono` (direct) | We need seconds and milliseconds since the epoch, which `SystemTime::duration_since(UNIX_EPOCH)` gives. (`chrono` still arrives via `trash`; that is its business.) | `std::time` |

### 1.4 The manifest

**Normative: see CONTRACT.md §6.2.** The manifest is `core/Cargo.toml`; the workspace member
`core/napi` is the Node-API addon crate, and it is the only JS-facing crate (§14.3).

---

## 2. Architecture in one paragraph

One `AppState` is process-global in the Node-API addon's host process; it holds an
`RwLock<Option<Arc<Vault>>>`. A `Vault` owns a `VaultTree` (the arena) and a lazily-built,
generation-invalidated `Arc<VaultSnapshot>` cache for search. The live `notify` watcher and the
coalescing thread live beside the vault on `AppState`, because a degraded watcher must survive a
failed open. Note **content** is never in any of it: reads and writes go straight to the filesystem,
and the webview holds exactly one note's text, in CodeMirror. Rust→JS traffic is three kinds: command
return values, the small set of `nc://` events (delivered through a Node-API `ThreadsafeFunction`),
and one message stream per search query (delivered through a `MsgSink`). Everything the frontend can
name is a **vault-relative path string**; internal `u32` node IDs never cross the IPC boundary. The
tree crosses that boundary once per change, whole, as `TreeBlob v1` raw bytes, and **the frontend
owns expansion state** — Rust carries none.

The addon holds no logic: `core/napi/src/lib.rs` is `cmds.rs`'s successor, one call into `app.rs`
per command plus argument conversion (CONTRACT §1.1/§1.3).

---

## 3. Process, threads, locks

### 3.1 Thread inventory

Normative: see CONTRACT.md §8.5.

What this document adds: **every thread we spawn uses
`std::thread::Builder::new().name(..).stack_size(..)`.** Naming threads makes `sample` / `perf`
output readable, and a stack size is set where the thread has a reason to differ from the default:
search workers take 256 KiB because search does no recursion at all and 2 MiB of virtual stack per
worker is pure address space. The named threads are the vault open, the watcher coalescer, the
directory probe, the close watchdog and its flush, and the search workers.

### 3.2 Sizing the async runtime

The runtime is built in the Node-API addon, `core/napi/src/lib.rs`: `worker_threads(2)` and
`max_blocking_threads(6)`, with `enable_all()`, held for the process lifetime.

`max_blocking_threads` is 6 and not 4 because the search coordinator occupies one blocking slot for
the entire duration of a search, so 4 leaves too little room for concurrent commands. Expected
saving from the whole stanza is well under 1 MB RSS; it is here because it reduces startup thread
churn, **not** because it is a large win.

Every blocking core function runs on that pool through `cairn_lib::spawn_blocking` (`app.rs`, used
by the addon), so no filesystem call runs on the renderer or on an event-loop thread.

### 3.3 Locking rules

```rust
pub struct AppState {
    pub open_note:    Mutex<Option<String>>,          // §7.5
    pub vault:        RwLock<Option<Arc<Vault>>>,     // CONTRACT §4.2
    pub search:       SearchState,                    // CONTRACT §4.3
    pub self_writes:  Arc<Mutex<SelfWrites>>,         // §7.4, <= 8 entries
    pub watcher:      Mutex<Option<VaultWatcher>>,    // None = degraded
    pub prefs:        OnceLock<Arc<PrefsStore>>,      // §9.3
    /// The ONE process-wide epoch counter (CONTRACT §1.4): the blob header's `epoch`, every
    /// mutating command's returned `epoch`, and `nc://tree-changed`'s payload are all this value.
    /// It survives vault switches; it is never reset; 0 is never handed out.
    epoch:            AtomicU64,
}
```

- `std::sync::RwLock`, not `parking_lot`, not `tokio::sync`. Command handlers are blocking functions
  on a blocking pool; an async lock buys nothing and costs a future state machine per call.
- Poisoning MUST be recovered, never unwrapped:
  ```rust
  #[inline]
  fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> { m.lock().unwrap_or_else(|e| e.into_inner()) }
  #[inline]
  fn read<T>(l: &RwLock<T>) -> RwLockReadGuard<'_, T> { l.read().unwrap_or_else(|e| e.into_inner()) }
  #[inline]
  fn write<T>(l: &RwLock<T>) -> RwLockWriteGuard<'_, T> { l.write().unwrap_or_else(|e| e.into_inner()) }
  ```
- **Lock-ordering rule: never hold the `vault` lock across a blocking filesystem call that reads or
  writes note *content*.** Tree rescans do hold it across `read_dir` (bounded, ~30 µs per directory);
  `read_note` / `write_note` resolve the path under a read lock, clone the `PathBuf`, drop the guard,
  then do I/O.
- **Deadlock hazard.** Dropping the watcher joins its thread, and the watcher thread takes the vault
  write lock, so the watcher is stopped and the old vault taken *out* of the lock and dropped *after*
  the guard is released. **Normative sequence: see CONTRACT.md §4.3.**
- **Search generation is frontend-owned.** The frontend supplies `generation` on `search_start`,
  increments it per query and never reuses one; Rust records the last-seen value, echoes it on every
  `SearchMsg`, and never invents, bumps or reorders it. A vault switch calls `search_cancel_all()`
  — the same cancellation flag `search_cancel` sets, applied to every live job — rather than bumping
  the number.
- `epoch` is read/written with `Relaxed`; it is a counter, not synchronisation. Every structural
  mutation bumps `epoch` **while holding the vault write lock** and stores the new value into
  `VaultTree::epoch`, so a reader under the read lock sees a tree and an epoch that agree.

---

## 4. The in-memory vault model

Measured result: **448 KiB, i.e. 81.6 bytes per node, for the 5,621-node fixture**.

### 4.1 Shape

A struct-of-arrays arena. Three flat buffers, `u32` indices, no per-node heap allocation, no `Rc`,
no `RefCell`, no `PathBuf` per node, no `String` per node.

Why not `Rc<RefCell<Node>>` with `Vec<Rc<..>>` children: each node would cost one heap allocation
(16-byte malloc header + 8-byte strong/weak counts on top of the payload), a `String` name (24-byte
`String` + a second allocation), a `Vec<Rc>` of children (24 bytes + a third allocation), and a
`PathBuf` if paths were stored (24 bytes + a fourth). Realistically 200–280 bytes per node in
**5,600 separate allocations** with terrible locality — roughly 3× the memory and an order of
magnitude more allocator pressure, for a tree that is read far more often than mutated.

### 4.2 Types (normative)

```rust
pub type NodeId = u32;
pub const NONE: NodeId = u32::MAX;
pub const ROOT: NodeId = 0;

pub mod flag {
    pub const DIR:  u8 = 1 << 0; // directory
    pub const DEAD: u8 = 1 << 1; // slot is on the free list
    // bits 2..7 reserved; keep the field a u8.
    // There is deliberately no EXPANDED bit — expansion is frontend-owned (CONTRACT §3.4).
}

/// EXACTLY 24 bytes. Field order is load-bearing: it produces zero padding.
/// Enforce with:  const _: () = assert!(core::mem::size_of::<Node>() == 24);   // gate G1
#[repr(C)]
#[derive(Clone, Copy)]
pub struct Node {
    pub parent:   NodeId, // 4   NONE for ROOT
    pub name_off: u32,    // 4   byte offset into VaultTree::names
    pub kids_off: u32,    // 4   start index into VaultTree::kids
    pub kids_len: u32,    // 4   number of children (0 for files)
    pub mtime:    u32,    // 4   unix seconds, saturating; 0 = unknown
    pub name_len: u16,    // 2   bytes; POSIX caps filenames at 255, so u16 is 256x headroom
    pub depth:    u8,     // 1   ROOT = 0; hard cap 255 (§4.6)
    pub flags:    u8,     // 1
}                         // = 24, align 4, no padding — verified by the compiler

pub struct VaultTree {
    /// Node arena. Index == NodeId. Slot 0 is always ROOT and is never freed.
    pub nodes: Vec<Node>,
    /// Child runs. Node `n`'s children are `kids[n.kids_off .. n.kids_off + n.kids_len]`,
    /// stored in the CURRENT display order (§4.5).
    pub kids: Vec<NodeId>,
    /// One concatenated UTF-8 buffer holding every node's ON-DISK file name, no separators.
    /// Names are never removed individually; dead bytes are counted and compacted (§4.7).
    pub names: String,

    pub root_path: PathBuf, // the ONLY PathBuf in the model
    pub sort: SortMode,

    free_nodes:    Vec<NodeId>, // reusable slots
    names_garbage: u32,         // dead bytes in `names`
    kids_garbage:  u32,         // dead slots in `kids`

    /// The value of the one process-wide epoch at the last structural mutation (§3.3).
    /// Emitted in the blob header at offset 24 and used to invalidate the snapshot cache (§4.9).
    pub epoch: u64,
    pub n_notes: u32,           // live `.md` count
    pub n_dirs:  u32,
    pub truncated_nodes: bool,  // the 50,000-node cap was hit (§4.6)
    pub truncated_depth: bool,  // at least one subtree was cut at depth 255 (§4.6)
}
```

Two absences are deliberate and structural:

- **There is no `ctime` field.** `st_ctime` on Linux is inode-change time, so "Created" would mean
  two different things on the two platforms and a "Created (new to old)" sort would reorder the tree
  on every autosave. If created-time is ever wanted it must be `Metadata::created()` with an explicit
  `Unsupported` path.
- **There is no `flag::EXPANDED`.** Expansion is a frontend `Set<string>` keyed on the
  vault-relative path, persisted per vault in `state.json` (CONTRACT §3.4). `set_expanded` and
  `reveal` do not exist as commands; reveal is frontend work with no IPC.

The process-wide counter is `u64` on the wire: there is exactly one, and it is `AppState::epoch`.

### 4.3 Per-node byte budget

| Component | Bytes/node | 5,621 nodes | Notes |
|---|---|---|---|
| `nodes` element | 24 | 132 KiB | compiler-verified |
| `kids` element | 4 | 22 KiB | every non-root node appears in exactly one run |
| `names` bytes | ~20 | ~111 KiB | measured mean name length in the fixture |
| `Vec`/`String` capacity slack | the remainder | | pre-reserved to avoid growth churn (§4.6) |
| **Measured total** | **81.6** | **448 KiB** | includes all slack |

Extrapolation: 50,000 notes ≈ **4.1 MB**. 250,000 notes ≈ 20 MB. The model is linear with a very
small constant, which is the whole point — and the 50,000-node cap (§4.6) bounds it hard.

**Budget gate: the arena for a 5,000-note vault MUST be ≤ 768 KiB** (gate G2, CONTRACT §6.5),
reported by `debug_mem` (§11.7).

### 4.4 Paths are reconstructed, never stored

Storing a `PathBuf` per node would cost 24 bytes of struct + a heap allocation + the full path bytes
(mean 171 B in the fixture) ≈ **200 B/node**, i.e. more than double the entire current model, to save
150 ns. Measured: rebuilding every absolute path takes 0.83 ms.

**This stands at rest and for every non-search code path.** The one exception is the search seam in
§4.9, which materialises paths *lazily, once, on first use*, and never at rest.

```rust
impl VaultTree {
    #[inline]
    pub fn name(&self, id: NodeId) -> &str {
        let n = &self.nodes[id as usize];
        // Safe by construction: name_off/name_len always delimit a whole name pushed by `intern`.
        &self.names[n.name_off as usize .. n.name_off as usize + n.name_len as usize]
    }

    /// Absolute path. Allocates once, sized from `depth`.
    pub fn abs_path(&self, id: NodeId) -> PathBuf {
        let mut chain: Vec<NodeId> = Vec::with_capacity(self.nodes[id as usize].depth as usize);
        let mut cur = id;
        while cur != ROOT { chain.push(cur); cur = self.nodes[cur as usize].parent; }
        let mut p = self.root_path.clone();
        for &s in chain.iter().rev() { p.push(self.name(s)); }
        p
    }

    /// Vault-relative path with '/' separators — the IPC identity of a node (§5.1). ROOT is "".
    pub fn rel_path(&self, id: NodeId) -> String { /* same walk, joined with '/' */ }

    /// Reusable-buffer variants for hot loops (snapshot build, blob build). MUST be used there.
    pub fn abs_path_into(&self, id: NodeId, out: &mut PathBuf);
    pub fn rel_path_into(&self, id: NodeId, out: &mut String);
}
```

### 4.5 Children, ordering, and lookup

Children are a **contiguous run** in `kids`, not a linked list. A linked list gives O(1) insertion
into a structure that is inserted into a handful of times per session and iterated on every rebuild;
a run gives sequential memory access and lets `set_sort` be a `sort_unstable_by` over a slice.

The run is kept in **display order**, i.e. sorted by the active `SortMode`, which is also the order
the blob's preorder DFS emits (CONTRACT §3.2). Consequence: name lookup inside a run is a linear
scan, not a binary search. That is fine and measured-fine — a folder with 500 children costs 500
short `str` comparisons (~2 µs), and path resolution touches at most `depth` runs. It removes the
need for any secondary index or hash map.

```rust
/// Wire value is the u8 and the ONLY wire value; see CONTRACT §1.5.
#[derive(Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum SortMode { NameAsc = 0, NameDesc = 1, MtimeDesc = 2, MtimeAsc = 3 }
// Default: NameAsc.
```

Four orders. The UI pins file-name A-Z and draws no sort menu; the other three still exist on the
wire and command 7 still accepts them.

**Ordering rules (normative):**
1. Directories always sort before files, in every mode.
2. Within a group, compare by the mode's key.
3. `NameAsc` / `NameDesc` use **natural order** — `Note 2.md` before `Note 10.md`, as Obsidian does.
4. Time modes tie-break by `nat_cmp` on the name, so the order is total and stable across rescans.

```rust
/// Natural, case-insensitive comparison. No crate; ~30 lines.
/// Walk both strings by char. When both sides are at an ASCII digit, consume the full digit run on
/// each side, strip leading zeros, and compare first by remaining length then lexicographically
/// (unsigned numeric order without parsing, so it cannot overflow on a 400-digit filename).
/// Otherwise compare one char from each side folded via `char::to_lowercase().next()`.
/// If the folded comparison is Equal for the whole string, tie-break with `a.cmp(b)` so the order
/// is total (otherwise "README" and "readme" would be interchangeable and the tree would flicker).
pub fn nat_cmp(a: &str, b: &str) -> core::cmp::Ordering;
```

`set_sort` re-sorts every child run in place and bumps the epoch. Borrowck note: the comparator needs
`&self.names` while `&mut self.kids` is borrowed, so take the buffers out and put them back:

```rust
pub fn set_sort(&mut self, mode: SortMode, epoch: u64) {
    if self.sort == mode { return; }
    self.sort = mode;
    let names = core::mem::take(&mut self.names);
    let nodes = core::mem::take(&mut self.nodes);
    for n in &nodes {
        if n.flags & flag::DIR == 0 || n.kids_len == 0 { continue; }
        let r = n.kids_off as usize .. (n.kids_off + n.kids_len) as usize;
        self.kids[r].sort_unstable_by(|&a, &b| cmp_nodes(&nodes, &names, mode, a, b));
    }
    self.names = names;
    self.nodes = nodes;
    self.epoch = epoch;
}
```

Measured shape: 5,621 elements across 419 runs — sub-millisecond. No incremental cleverness needed.
`set_sort` does **not** re-`stat`; it does not need to, because `Node.mtime` is updated on every
content hit (§7.3).

### 4.6 The initial walk — `scan.rs`

The walk lives in its own module, **`scan.rs`**, because it owns the two caps and the temp sweep and
is the one piece of the backend on the cold-start path.

```rust
pub struct ScanResult { pub tree: VaultTree, pub sweep: Vec<PathBuf> }

/// Walk `root` into a fresh arena. Blocking; runs on the vault-walker thread, never on the main
/// thread and never on a tokio worker.
pub fn walk_vault(root: &Path, sort: SortMode, epoch: u64) -> Result<ScanResult, VaultError>;
```

Normative rules:

1. **Iterative, breadth-first, with an explicit `Vec<(NodeId, PathBuf)>` queue.** No recursion — a
   pathological deeply-nested tree must not blow the stack.
2. **Pre-reserve**: `nodes` 8,192, `kids` 8,192, `names` 256 KiB. Measured: the fixture never grew
   any of them. Growth is not a correctness issue, just realloc churn during the scan.
3. **Skip rules, applied per `DirEntry`, in this order:**
   - `file_type()` is a symlink → **skip**. `DirEntry::file_type()` on Unix reads `d_type` and does
     *not* follow, so a symlinked directory reports `is_symlink() == true` and `is_dir() == false`.
     This makes symlink loops structurally impossible and makes it impossible for the tree to
     reference anything outside the vault root (§5.3; CONTRACT §7.3 case 12).
   - name is not valid UTF-8 → skip.
   - name starts with `.` → **skip**. One rule covers `.obsidian`, `.git`, `.trash`, `.DS_Store` and
     our own in-flight temp files (§6.2). A dotfile that matches the temp-name pattern is collected
     as a sweep candidate on the way past.
   - not a regular file and does not end in `.md` (ASCII-case-insensitively) → **skip**. A FIFO or
     socket named `*.md` is not a note and is never opened.
   Empty folders **are** kept. What the tree contains is settled: CONTRACT §3.6.
4. **Two hard caps, both enforced inside the walk, both signalled in the blob header** (CONTRACT §3.3):
   - `node_count == 50_000` → stop descending, set `truncated_nodes`, which becomes header `flags`
     bit 0 and `VaultInfo.truncated`.
   - `depth > 255` → do not descend into that subtree, set `truncated_depth`, which becomes header
     `flags` bit 1. **`nc://watch-degraded` is never emitted for depth truncation** — that event means
     "the watcher is not live". Each condition gets its own bit and its own banner.
5. **`stat` eagerly.** `DirEntry::metadata()` costs a measured +6 ms over the whole 5,000-note walk.
   A lazy-stat state machine to save that is not worth the branch in every sort path. `mtime` is
   `SystemTime → duration_since(UNIX_EPOCH) → as_secs() as u32`, saturating; failure stores 0 and
   sorts last.
6. **Sort each directory's children once, as it is read**, using the active `SortMode`, then append
   the run to `kids`. The walk emits an already-sorted tree; there is no second pass.
7. **Temp-file sweep.** While reading each directory, collect any entry matching
   `.<anything>.tmp-<digits>-<digits>` into `sweep` — we are already reading every directory entry,
   so this is free. After the walk, for each candidate: parse the embedded PID and **unlink it on
   sight if that PID is not a live process** (`kill(pid, 0)` → `ESRCH`); if the PID *is* live (another
   instance may be mid-write), fall back to the one-hour mtime rule. Crash debris created minutes
   before the next launch is removed, so it is never replicated to another device by a sync client.
8. **The app writes nothing into the vault** other than the user's `.md` files and those transient
   temp files. No index, no config, no `.notes/` folder. A vault opened by this app is byte-identical
   to one Obsidian has never seen, which is the storage-format requirement.

The blob encoder (`TreeBlob v1`, CONTRACT §3.2) is a second pass over the finished arena in `tree.rs`:
preorder DFS over `kids`, writing the six sections in the layout the contract fixes. **The byte
layout is not restated here or anywhere else in this document.**

### 4.7 Mutation, free lists, and compaction

Node slots are recycled. Name bytes and `kids` slots are not recycled individually; they are counted
as garbage and compacted in bulk.

```rust
impl VaultTree {
    fn alloc_node(&mut self, n: Node) -> NodeId {
        match self.free_nodes.pop() {
            Some(id) => { self.nodes[id as usize] = n; id }
            None     => { self.nodes.push(n); (self.nodes.len() - 1) as NodeId }
        }
    }

    /// Frees `id` and its entire subtree. Iterative (explicit stack).
    fn free_subtree(&mut self, id: NodeId) {
        // for each node: names_garbage += name_len; kids_garbage += kids_len;
        //                flags = DEAD; free_nodes.push(id)
    }

    fn maybe_compact(&mut self) {
        if self.names_garbage as usize > self.names.len() / 2 && self.names_garbage > 64 * 1024 {
            self.compact_names();   // rebuild `names`, rewrite every live name_off. O(n).
        }
        if self.kids_garbage as usize > self.kids.len() / 2 && self.kids_garbage > 4096 {
            self.compact_kids();    // rebuild `kids` in preorder DFS, rewrite kids_off. O(n).
        }
        if self.free_nodes.len() > self.nodes.len() / 2 && self.free_nodes.len() > 1024 {
            // Leave `nodes` alone: compacting it would invalidate every NodeId in `kids` for no
            // benefit — 24-byte dead slots are cheap, and no NodeId ever leaves the process.
            self.free_nodes.shrink_to_fit();
        }
    }
}
```

`maybe_compact` runs at the end of a watcher flush and at the end of any mutating command, always
under the write lock. `compact_kids` additionally reorders runs into DFS order, which makes the blob
encoder's pass sequential. Both are O(nodes) — sub-millisecond at this scale. There is no background
GC thread and no timer.

### 4.8 Note content is never cached in Rust — the justification

Measured: `fs::read_to_string` of an 11 KB note is **15 microseconds**. A hash lookup, an LRU touch
and a bounds check are not meaningfully faster than that; a cache miss is strictly slower.

More decisively: the file's bytes are already cached — by the kernel page cache, which is shared,
evictable under pressure, and costs our footprint nothing that a re-read would not. A Rust-side cache
is a **second copy of data the OS already holds**, and for the note that is actually open it would be
a *third* (page cache + Rust `String` + CodeMirror's document in the webview).

Therefore, normatively:
- `read_note` performs `File::open` + `read_to_end` into a fresh `Vec<u8>`, frames it (CONTRACT §2)
  and hands it to the IPC layer. Nothing is retained.
- `write_note` takes the bytes from the IPC request and writes them. Nothing is retained.
- `AppState` holds exactly one piece of content-adjacent state: `open_note: Option<String>`, the path
  (not the text) of the note the UI currently shows, used only to filter external-change events
  (§7.5).
- Search reads through the engine's own bounded line buffers (CONTRACT §4.5, `HEAP_LIMIT_BYTES`
  64 KiB per `Searcher`).

### 4.9 `VaultSnapshot` — the search seam

Normative: see CONTRACT.md §4.2. It is printed there, and the struct definition, the lifetime rule
and the invalidation rule are not restated here.

What belongs to this document is where it lives and what it costs. `Vault` gains
`snap_cache: Mutex<Option<(u64, Arc<VaultSnapshot>)>>` — interior mutability on purpose, because
`snapshot()` is a **read** operation and must not need the write lock. The build is one preorder pass
over the arena using `rel_path_into` on a reusable `String` (§4.4), measured at **150 ns/path ≈ 0.8 ms
for 5,000 notes and ~440 KB resident**. A mutation only bumps `epoch`; the next `snapshot()` call
whose epoch differs replaces the cache entry, and the old `Arc` stays alive exactly as long as its
last holder, so an in-flight search's paths can never dangle. **Cost at rest, if search was never
used this session: zero.** Dropped with the `Vault` on switch.

`Vault` also carries the secret-note memo (`secrets_cache`, keyed by `rel` and mtime), which is what
makes the classification cost no I/O in the steady state.

---

## 5. Paths: identity, validation, safety

### 5.1 Identity

**The IPC identity of every tree entry is its vault-relative path, `/`-separated, no leading slash,
with the `.md` extension included for notes. The vault root is the empty string `""`.**

Not `NodeId`. Node IDs are recycled by the free list and reshuffled by rescans; a webview holding a
stale ID would silently address the wrong file. Paths are stable across rescans, across restarts,
across an external `git checkout`, and they are what the UI has to display anyway. Resolution costs
one linear scan per depth level (§4.5) — microseconds. This is also why the frontend's expanded-set
is path-keyed (CONTRACT §3.4).

```rust
impl VaultTree {
    /// Resolve a vault-relative path to a live node. None if any component is missing.
    pub fn resolve(&self, rel: &str) -> Option<NodeId>;
    /// Resolve the parent directory of a not-yet-existing entry, plus the final component.
    pub fn resolve_parent<'a>(&self, rel: &'a str) -> Option<(NodeId, &'a str)>;
}
```

Note that `names` holds the **on-disk** name including `.md`; the blob strips the extension for
display (CONTRACT §3.2). Resolution always works in on-disk names.

### 5.2 Validation — two functions, not one

**Normative: see CONTRACT.md §7.3 case 11.** There is deliberately no single `validate_rel`: requiring
every component of a *lookup* path to pass the creation-time character rules would make legitimate
notes **visible but permanently unopenable** — a directory named `Archive ` (trailing space) or `v1.`
is legal on ext4, common, and reachable on macOS through a sync client, so the walk would admit it
and the tree draw it while every operation through it was rejected before resolution ran.

The Rust surface is therefore two functions with two different jobs:

```rust
/// Creation and rename targets ONLY. Character set per CONTRACT §7.3 case 11.
pub fn validate_name(name: &str) -> Result<(), VaultError>;

/// EVERY path arriving over IPC for resolution. Rejects only: NUL, a leading or trailing '/',
/// an empty component, a "." or ".." component, more than 255 components. Nothing else.
pub fn validate_rel_for_lookup(rel: &str) -> Result<(), VaultError>;
```

Nothing is weakened by the split, because the traversal guarantee comes from `resolve()` walking the
arena, not from the character rules — see §5.3.

### 5.3 Why traversal is structurally impossible

Validation is the first line, not the only one. The real guarantee is:

> **Every absolute path this process touches is produced by `VaultTree::abs_path`, which is
> `root_path` plus a chain of names that were read from `read_dir` inside the vault, none of which
> is `..` (impossible — `read_dir` never yields it) and none of which is a symlink (rejected at walk
> time).**

For reads, renames, moves and deletes, the path must `resolve()` to a live node, so it is inside the
vault by construction. For creates, the *parent* must resolve to a live directory node and the *name*
must pass `validate_name`, so the result is one level below a known-inside path.

We do **not** call `fs::canonicalize` as a check. It is a syscall per validation, it allocates, and it
is a TOCTOU race — the check and the open are not atomic. The arena is the check, and it does not race
because it is under a lock. The one `canonicalize` the process performs is `canonical_root` at vault
open, so the arena and the watcher share one spelling of the root. CONTRACT §7.3 cases 12 and 13
carry the tests.

---

## 6. Filesystem operations

All of these live in `fsops.rs` and are called from `app.rs` through `cairn_lib::spawn_blocking` (the
addon's `lib.rs`), so they never run on the main/UI thread or on a runtime worker — blocking I/O there
stutters the window.

### 6.1 Read

```rust
/// PURELY INTERNAL — it never crosses the IPC boundary and is never serialised, so it keeps
/// snake_case (CONTRACT §1.1's camelCase rule binds wire types only). It is consumed by
/// `note_frame::encode_note` and leaves this process as raw bytes. The TypeScript `NoteRead`
/// of CONTRACT §1.5 is a different object with the same name: it is what `decodeNote()`
/// RETURNS, and its fields are camelCase (`mtimeMs`).
pub struct NoteRead { pub bytes: Vec<u8>, pub mtime_ms: i64, pub flags: u32 }

pub fn read_note(abs: &Path, rel: &str) -> Result<NoteRead, VaultError>;
```

1. `File::open`, then `metadata()` on the **open handle**, not on the path — one lookup, no race.
2. If `len > MAX_NOTE_BYTES` (**8 MiB**) → `VaultError::TooLarge { path, bytes, limit }`. This is a
   footprint guard: an 80 MB "note" becomes ~80 MB in Rust *and* several hundred MB in the webview
   once CodeMirror builds its document. Refusing is the correct behaviour and 8 MiB is ~4 million
   words. Normative, including the UI copy and the refusal of any truncated preview:
   CONTRACT §7.3 case 15.
3. `read_to_end` into a `Vec<u8>` with `with_capacity(len)` — exactly one allocation.
4. Strip a UTF-8 BOM (`EF BB BF`) if present; set `flags |= note_frame::FLAG_BOM`.
5. If the content contains `\r\n`, rewrite in place to `\n` and set `flags |= note_frame::FLAG_CRLF`.
   *Rationale:* CodeMirror normalises to `\n` regardless, so without this the first autosave would
   silently convert a Windows-authored file's entire line endings. Rust records the convention here
   and **Rust restores it on write** — see §6.2.
6. `std::str::from_utf8(&bytes)` to validate. On failure → `VaultError::NotUtf8`. **Never**
   `from_utf8_lossy`: a lossy conversion followed by an autosave permanently destroys the file's
   bytes. Validate, then hand back the original `Vec<u8>` — no re-encode, no copy.
7. Set `state.open_note` to this path (§7.5). It is also **updated on rename and move and cleared on
   delete** — see §6.4 and §6.5.
8. Frame the result with `note_frame::encode_note(mtime_ms, flags, &bytes)` and return it as a
   `Buffer`. **The byte layout is defined in exactly one place per language and is not restated here:
   CONTRACT §2.**

### 6.2 Write — the atomic sequence

**Normative: see CONTRACT.md §7.1 rule 2.** The eleven-step sequence there fixes the order; this
section owns the mechanics the contract leaves to the implementation:

- **Step 1b** — `x-create == '0'` and a missing destination is `NotFound`, not a create. Without it
  the sequence would resurrect a note the user had just deleted, because the conflict check passes on
  a missing file and `fs::rename` creates the destination whether or not it existed.
- **Step 2** — `denormalise(text, flags)` happens **in Rust**, so the round-trip invariant does not
  depend on a frontend that has no BOM in its type at all.
- **Step 7** — a flat `0o644` for a new destination, and the destination's mode preserved on an
  overwrite. A umask-derived mode is impossible: Rust exposes no umask getter and `libc::umask` is
  destructive — it sets as it gets.
- **Step 8b** — on Linux, `File::open(parent_dir)?.sync_all()` after the rename. Without it the
  `sync_data` in step 6 is half a durability guarantee, because on ext4 the rename is durable only
  when the journal commits.

**Header parsing lives in `note_frame.rs`, not in a command wrapper and not here.**
`note_frame::parse_write_headers` percent-decodes `x-path` and parses `x-flags` / `x-base-mtime` /
`x-create`; header names are read lowercased; any malformed header is
`VaultError::InvalidPath`/`InvalidName`, never a panic. `parse_write_headers_parts` is the testable
core the public function is a thin adapter over.

What remains this document's, because the contract does not specify it:

- **The temp name is `dir/".{file_name}.tmp-{pid}-{counter}"`**, `counter` an
  `AtomicU64::fetch_add(1, Relaxed)`. The label is cut at a char boundary so the whole component
  fits `NAME_MAX`; uniqueness comes from pid + counter + `create_new`. Same directory, therefore same
  filesystem, therefore `rename` is atomic. The leading `.` means our own walker (§4.6-3) and
  Obsidian both ignore it while it exists, and the embedded PID is what makes the sweep in §4.6-7
  exact.
- `create_new(true)` on the temp so we never clobber another instance's in-flight write, with a
  bounded retry if the name is somehow taken.
- `sync_data` maps to `fsync(2)`, **not** `F_FULLFSYNC`. Full device-barrier durability costs ~50×
  more and is not warranted for a notes app; 5.04 ms against an 800 ms autosave debounce is invisible.
- **Mode restore mechanics for step 7:** `rename` replaces the destination inode, so the surviving
  file would otherwise carry the temp file's `0o600`. If the destination existed, `set_permissions` on
  the *temp* file to the destination's mode before renaming. Without this, every save silently
  tightens the file's permissions.
- Extended attributes are carried across the replacement (Finder tags and FinderInfo on macOS;
  `user.*` and the POSIX access ACL on Linux), after the chmod because a Linux chmod rewrites an
  ACL's mask. Every failure is ignored: metadata must never make a note unsaveable. Timestamps are
  never copied.
- The same routine, minus the conflict check and minus step 1b, writes `state.json` (§9.3).

**What temp+rename means for the file watcher:** the watcher sees a *create* of
`.foo.md.tmp-1234-7` (skipped: dotfile) followed by a *rename/create* of `foo.md`. On macOS FSEvents
will typically report `Modify(Name(Any))` or `Create(File)` with a single path and no pair
information. Because our reaction to any event is "mark the containing directory dirty and rescan it"
(§7.3), the imprecision costs nothing, and the self-write fingerprint (§7.4) suppresses the echo
entirely.

### 6.3 Create

```rust
pub fn create_note(parent: NodeId, name: Option<&str>)   -> Result<String, VaultError>;
pub fn create_folder(parent: NodeId, name: Option<&str>) -> Result<String, VaultError>;
```

- `name: None` means "generate one", matching Obsidian: `Untitled`, then `Untitled 1`, `Untitled 2`,
  … first free. Notes get `.md` appended; folders do not. **Auto-numbering happens only for the
  system-generated `Untitled`** — a user-typed name is never silently turned into `Ideas 1`
  (CONTRACT §7.3 case 10).
- If `name` is `Some`, it MUST pass `validate_name` (§5.2). A note name without `.md` gets it appended.
- Notes: `OpenOptions::new().write(true).create_new(true).mode(0o644)` on an empty file. `create_new`
  makes "already exists" an OS-level guarantee, not a check-then-act race → `AlreadyExists`.
- Folders: `fs::create_dir` — not `create_dir_all`; the parent is known to exist and `_all` would
  silently paper over a bug.
- Both then insert the node into the arena directly (no rescan), bump the epoch, and return the new
  relative path. The command layer wraps it as `CreateResult { path, epoch }` (CONTRACT §1.5). The
  watcher's echo is suppressed by the fingerprint mechanism (§7.4).

### 6.4 Rename and move

```rust
pub fn rename_entry(id: NodeId, new_name: &str) -> Result<String, VaultError>;
pub fn move_entry(src_abs: &Path, dst_dir_abs: &Path, is_dir: bool,
                  self_writes: &Mutex<SelfWrites>) -> Result<PathBuf, VaultError>;
```

- `rename_entry` takes a **single component**; it does not move. Moving between folders is command
  24 (`move_entry`, drag-to-move, CONTRACT §1.3), which reparents one node between two runs by
  `fs::rename` and needs no descendant paths rewritten (§4.4).
- For a note, if `new_name` has no `.md`, append it. Renaming a note to a different extension is
  rejected (`InvalidName`) — it would vanish from the tree and confuse the user.
- **Case-only renames** (`notes.md` → `Notes.md`) on a case-insensitive-but-preserving filesystem
  (APFS default) must not be reported as `AlreadyExists`. Detect with `same_file(src, dst)` —
  compare `dev` + `ino` via `MetadataExt`. The mechanism is fixed by CONTRACT §7.3 case 10: perform
  it as **`old` → temp → `new`** in the same directory, restoring `old` if the second step fails.
  The intermediate is `dir/".<name>.rn-<pid>-<counter>"`, a form the crash sweep will NOT unlink:
  it holds the sole copy of the note between the two renames, so it is recovered at the next open by
  `recover_rename_tmps` (`tmp -> dst`) rather than deleted. Collision detection is **case-insensitive
  on macOS, byte-exact on Linux**.
- Moves refuse a collision rather than auto-numbering when the caller asks for a strict move, and
  `first_free_for_move` supplies a free name where the caller allows one.
- `fs::rename`. Then update the node in place: intern the new name (old bytes → `names_garbage`),
  re-sort the parent's run, bump the epoch. Descendants are untouched — their names did not change,
  and paths are derived, which is exactly the payoff of §4.4. **Renaming a folder containing 4,000
  notes is O(1) plus one run re-sort.**
- **Update `state.open_note`** when the renamed or moved node **is, or is an ancestor of,** the open
  note (CONTRACT §7.3 case 4). Two lines under the write lock. Without it `open_note` points at a
  path that no longer exists, `nc://note-external-change` never fires again, and §7.5's "if the
  buffer is unmodified, silently reload" contract is dead while the user reads stale text.

### 6.5 Delete — to the OS trash

```rust
pub fn delete_entry(id: NodeId, permanent: bool) -> Result<(), VaultError>;
```

**Default: `trash::delete(abs)` — move to the OS trash. Hard delete only on explicit opt-in.**

Justification: the entire premise of the product is that a vault is the user's plain-text notes on
disk, interoperable with Obsidian and git. An `unlink` on a mis-click destroys hours of writing with
no undo, no version history (we have none — no sync, no index, no database) and no recovery path.
`~/.Trash` on macOS and the freedesktop `$XDG_DATA_HOME/Trash` on Linux are both restorable through
the user's normal file manager, cost us one crate, and are what Obsidian does by default.

Failure handling — trash is not always available (network volumes, `tmpfs`, some container mounts, a
`$HOME` on a different filesystem from the vault on Linux):
- `trash::delete` fails → `VaultError::TrashUnavailable { path, message }`.
- The UI responds with a **second, explicitly-worded confirmation** and only then calls
  `delete_entry(path, permanent = true)`, which does `fs::remove_file` / `fs::remove_dir_all`.
- Two commands were considered and rejected in favour of one command with a `permanent` flag, because
  the flag makes the dangerous call impossible to reach by accident from a retry loop.

Directory deletes go to the trash whole; we never enumerate and delete piecewise.

**Clear `state.open_note`** if the deleted node is, or is an ancestor of, the open note (CONTRACT
§7.3 cases 3 and 6). Then `free_subtree(id)`, remove the id from its parent's run (marking one
`kids_garbage` slot), `maybe_compact()`, bump the epoch.

**The ordering between the frontend's flush and this call is normative and is not ours:**
CONTRACT §7.3 case 3. Rust's part is only the two `open_note` lines; the reason the race is
unwinnable at all is `x-create: 0` (CONTRACT §7.1 rule 1).

### 6.6 Reveal in the OS file manager (command 20)

```rust
pub fn reveal_in_os(abs: &Path, rel: &str) -> Result<(), VaultError>;
```

**Normative: see CONTRACT.md §1.3 command 20.** On macOS it resolves `path` through the arena
exactly as `read_note` does — so §5.3's traversal guarantee is unchanged and CONTRACT §7.3 case 13's
test still covers it — refuses a path that does not resolve with `NotFound` before anything is
spawned, and runs `std::process::Command::new("/usr/bin/open").arg("-R").arg(abs).spawn()`. Off
macOS the same call returns an `io` error naming the unsupported platform; no other backend exists.
No new dependency, and **no `shell:*` capability**: the webview cannot spawn anything; Rust does,
from an already-validated arena path. The command's only caller is the delete-failure dialog's
`Show in Finder` button (CONTRACT §7.3 case 3).

### 6.7 Error surface

One enum. The wire shape and the full variant list are CONTRACT §1.5; the Rust definition is §10.
`std::io::Error` is never returned raw. The mapping — which the contract does not specify and which
is therefore normative here:

| `io::ErrorKind` | `VaultError` |
|---|---|
| `NotFound` | `NotFound { path }` |
| `AlreadyExists` | `AlreadyExists { path }` |
| `PermissionDenied` | `Io { path, code, message }` with `code = EACCES` |
| `InvalidInput`, anything else | `Io { path, code: raw_os_error().unwrap_or(0), message }` |

`message` is `io::Error`'s `Display`, already localised by the OS and safe to show. It never contains
anything the user did not already have on screen (a path they clicked). The frontend switches on
`kind` and MUST NOT parse `message`.

---

## 7. File watching

### 7.1 Backend and configuration

```rust
use notify::{RecommendedWatcher, RecursiveMode, Watcher, Config, Event, EventKind};

let (tx, rx) = std::sync::mpsc::channel::<notify::Result<Event>>();
let mut watcher = RecommendedWatcher::new(
    move |res| { let _ = tx.send(res); },     // MUST NOT block: notify's thread is calling us
    Config::default(),
)?;
watcher.watch(&root, RecursiveMode::Recursive)?;
```

`Config::default()` is correct: every knob on `notify::Config` (`with_poll_interval`,
`with_manual_polling`, `with_compare_contents`) applies only to the `PollWatcher` backend, which we
never select. In particular there is no follow-symlinks option — symlinks are handled in the walk
instead (§4.6-3).

- **macOS** → FSEvents. One recursive registration for the whole vault; kernel cost is O(1) in the
  number of directories. Documented caveat: events for files not owned by the user can be missed.
  Acceptable — a vault is the user's own files.
- **Debian** → inotify, which is **not recursive**: notify registers one watch descriptor per
  directory, so a very large vault can exhaust `fs.inotify.max_user_watches`.

```rust
// on Err from watcher.watch(...) or on a later notify error:
match e.kind {
    notify::ErrorKind::MaxFilesWatch => degrade("watch-limit"),
    _ => degrade("watch-error"),
}
```

`degrade(reason)` drops the watcher and emits **`nc://watch-degraded { reason, hint }`** once per
vault. The affordance is the `.watch-degraded` banner in the sidebar, whose `[ Refresh ]` button calls
`rescan_all()` (CONTRACT §1.4). `VaultInfo.watching` carries the same fact for a frontend that starts
up after the event. We never fall back to `PollWatcher`: polling 5,000 files every 30 s is exactly
the background cost this product exists to avoid. A network vault (NFS/SMB) emits no events at all;
the vault still works and the banner is not drawn, because the watcher did start — external changes
just arrive on the next open. There is deliberately no detection and no warning for that case
(CONTRACT §7.3 case 9).

### 7.2 The coalescing thread

```rust
const DEBOUNCE:   Duration = Duration::from_millis(150);
const MAX_ACCUM:  Duration = Duration::from_millis(750);
const MAX_DIRTY:  usize    = 512;   // beyond this, a full rescan is cheaper than N directory rescans
```

```rust
struct Flush {
    dirs: Vec<PathBuf>,          // directories to rescan
    content_hits: Vec<ContentHit>, // (path, mtime, len) for §7.5 and the Node.mtime update
    full_rescan: bool,
}
```

```
loop {
    match rx.recv_timeout(DEBOUNCE) {
        Ok(Ok(ev))  => { if classify(ev, &mut batch) { vault_lost(); return; } }
        Ok(Err(e))  => { degrade(...); }
        Err(Timeout) => { if !batch.is_empty() { flush(); } }
        Err(Disconnected) => { if !batch.is_empty() { flush(); } return; }
    }
    if checked.elapsed() >= ROOT_CHECK && watcher_root_is_gone() { vault_lost(); return; }
}
```

`dirs` is a `Vec<PathBuf>` of **directories**, deduplicated by linear scan (it is almost always ≤ 5
entries; a `HashSet` here would allocate a hash table to hold three strings). `flush()` is also
forced once accumulation has been running for more than `MAX_ACCUM`, so a long `git checkout`
produces periodic updates instead of one silent stall. This is the 150 ms / 750 ms envelope
CONTRACT §1.4 states for `nc://tree-changed`.

**The root-existence check is its own loop pass** (`ROOT_CHECK` = 500 ms), and it exists for the
case no event names the root: a renamed parent directory or an unmounted volume. Without it the
arena outlives its directory, `watching` stays true, and every autosave fails with nothing on screen.
When it trips, or when an event itself names the root, the thread emits `nc://vault-lost` and returns.

**Shutdown is by disconnect, not by a flag.** Dropping the `RecommendedWatcher` unregisters the
kernel watches and drops its `Sender`; `recv_timeout` then returns `Disconnected`, the batch is
flushed, and the thread returns. The drop order is therefore: watcher, then join, then the arena
(CONTRACT §8.5).

### 7.3 Classification: why we rescan directories, not files

For an `Event { kind, paths, .. }`:

| Kind | Action |
|---|---|
| `Create(_)`, `Remove(_)`, `Modify(Name(_))` | mark `paths[i].parent()` dirty (and, for a rename, the parent of every path in the event) |
| `Modify(Data(_))`, `Modify(Any)` on a `.md` file | record a **content hit** `(path, mtime, len)` for §7.5 **and** for the unconditional `Node.mtime` update below |
| `Modify(Metadata(_))` | same as a content change |
| `Access(_)` | ignore entirely |
| `Any`, `Other` | set `full_rescan` — this is what FSEvents' `kMustScanSubDirs` and inotify's `IN_Q_OVERFLOW` degrade into |
| any path not under `root_path` | ignore |
| `root_path` itself removed or renamed | emit `nc://vault-lost { path }`, drop the vault, do not rescan (CONTRACT §7.3 case 8 defines what the frontend does with it) |

**`Node.mtime` is updated on every content hit, unconditionally** (CONTRACT §3.5). Without this,
under the default `NameAsc` the stored mtime would never refresh, so after a day of editing in
Obsidian, switching to "Modified (new to old)" would order the tree by walk-time mtimes. The `stat`
this needs is the same one §7.4's echo check already performs, so the syscall is free; the
*application* of the result is carried in the flush batch and applied under the write lock, not from
`classify`, which holds no lock. A content hit that changes only the mtime does **not** mark the
directory dirty — no run needs re-sorting until the sort mode is time-based, and `set_sort` re-sorts
everything anyway (§4.5). `MAX_DIRTY` caps the collected content hits as well as the dirty
directories, so a bulk external change cannot build an unbounded batch before the flush.

**Why the unit of repair is a directory, not a file.** Rename events are the least reliable part of
every filesystem-notification API: FSEvents coalesces and frequently gives `Modify(Name(Any))` with
one path and no partner; inotify gives `MOVED_FROM` / `MOVED_TO` pairs that can be split across reads
or orphaned. Any design that tries to *interpret* rename pairs has a long tail of corruption bugs.
Re-reading the containing directory is ~30 µs, is correct for every event kind including ones we have
never seen, and needs no pairing logic at all. This is the boring option and it is also the correct
one; CONTRACT §3.5 makes it normative for the whole project.

`rescan_dir(dir: NodeId)` — the diff (never a rebuild):

```
1. read_dir(abs) with the §4.6 skip rules -> Vec<(name, is_dir, mtime)>
2. old = kids[dir.kids_off .. +kids_len]
3. Match old <-> new BY NAME (build two small Vec<(&str, idx)>, sort, two-pointer merge;
   a folder's child count is tens, so this is faster than any hash map):
     both      -> reuse the NodeId; update mtime; if it is a directory, KEEP its existing kids run
                  untouched (its own contents were not part of this event)
     new only  -> alloc_node(); if a directory, run the §4.6 walk on it to build its subtree
     old only  -> free_subtree()
4. Sort the new child list by the active SortMode; append it as a fresh run at the end of `kids`;
   kids_garbage += old_len
5. maybe_compact(); bump the epoch
```

Step 3's "keep the existing kids run" is what makes an external `git pull` not rebuild the world.
Expansion is frontend-owned and path-keyed, so it survives this diff without the arena's help, and
survives a delete-and-recreate that an in-arena flag could not have survived.

The flush emits **one** event for the whole batch: **`nc://tree-changed { epoch }` and nothing
else** (CONTRACT §1.4). The frontend rebuilds wholesale from `tree_snapshot()`.

### 7.4 Echo suppression — fingerprints, not timers

Normative rules, including the per-operation fingerprint table: **see CONTRACT.md §3.5.**

Why a fingerprint and not a window, in one line: a time window is simultaneously **too long** (it
swallows a genuine Obsidian edit made inside it) and **too short** (a busy machine delivers the event
later). Both APFS and ext4 store nanosecond mtimes, so `(abs, mtime_ns, len)` is a strong
fingerprint; if another writer produced different bytes in the same window, the length or the
nanosecond timestamp differs and we correctly process the event.

```rust
pub struct SelfWrite {
    pub abs: PathBuf,
    pub mtime_ns: u128,    // from Metadata::modified(), full nanosecond resolution
    pub len: u64,
    pub deadline: Instant, // now + 5 s — garbage collection ONLY, never the matching rule
}
```

Implementation notes that remain ours: the vec is capped at 8 entries (drop oldest) and scanned
linearly — eight entries do not justify a map; entries are recorded from **post-operation** metadata
*before the command returns*, so an event already in flight is matched; a matched entry is
**removed** when it matches, so a second, genuine write to the same path with the same size is not
also swallowed; and recording a fingerprint already held **refreshes** that entry rather than
spending a second slot. An expired entry is collected only once the disk has moved on from its
fingerprint — a sync client's xattr or a chmod can arrive long after the save, and the fingerprint is
what decides ownership, never the deadline.

A rename records **two** fingerprints — `(old_abs, 0, 0)` under the delete rule, and
`(new_abs, post_mtime_ns, post_len)` — because the frontend's create-then-rename flow otherwise
produces a visible flicker on every new note.

### 7.5 External changes to the open note

`AppState.open_note` holds the relative path of the note the editor currently shows. Its full
lifecycle:

| Event | Effect on `open_note` |
|---|---|
| `read_note` succeeds | set to that path |
| `open_vault` | set from the vault's persisted `last_note` (`None` when there is none) |
| `rename_entry` / `move_entry` on it, or on one of its ancestors | **rewritten** to the new path (§6.4) |
| `delete_entry` on it, or on one of its ancestors | **cleared** (§6.5) |

When the flush applies a content hit:

```
if content-hit path == open_note (after self-write suppression):
    emit nc://note-external-change { path, mtimeMs, size }   // camelCase on the wire
```

**Only for that one path.** Without this filter a `git checkout` touching 800 files emits 800 events,
each a JSON serialise and an IPC hop, for information the UI would discard. The frontend's contract —
silent reload when clean, a non-blocking bar when dirty — is CONTRACT §7.3 case 7.

---

## 8. Search

**§8. (DELETED — the search engine is CONTRACT.md §4 and spec-05; this document's brute-force engine
never shipped.)**

---

## 9. Vault switching and persisted state

### 9.1 Choosing a root

A directory is a valid vault if it exists, is a directory, and is readable. That is the whole test —
no marker file, no `.obsidian` requirement. Obsidian creates `.obsidian/` on first open; we never
create it and never require it, which is what makes an arbitrary folder of `.md` files openable by
both applications.

### 9.2 The picker

The picker the app uses is Electron's `dialog.showOpenDialog`, opened by the shell from the main
process, never by the renderer, and with no `dialog:*` capability granted to the page
(`electron-shell/app-main.mjs`, CONTRACT §6.1).

`app::pick_vault` — which drives `rfd` through `AppCtx::on_main_thread` — is a Rust-side
implementation of the same command that the addon deliberately does not expose: an addon loaded into
Electron's main process has no main-thread hop to offer, and `on_main_thread` returns `Err` rather
than silently dropping the closure. Anyone who wires it up gets a `VaultError::io` naming the
missing hop instead of a dialog that never opens. It is a dead-code candidate.

`Ok(None)` means the user cancelled; it is not an error.

### 9.3 Persisted state

**Normative — location, schema, caps, and the flush ordering: see CONTRACT.md §7.6.**

`prefs.rs` owns the store (owner 02):

- The schema is per-vault keyed. A flat one-vault schema is not used: it would lose each vault's
  expansion the moment another vault is opened. `expanded` is capped at 2,000 paths, and `recents`
  at 8.
- **`sidebar_w` is a live field**: the sidebar is resizable, it is a GLOBAL field beside `win`, and
  it is written on release of the drag through `save_ui_state` (CONTRACT §7.6). Rust clamps it
  sanely on read and on write; the frontend does the real clamp against the live window.
- The file is written with the **same atomic routine as note writes** (§6.2, minus the conflict check
  and minus step 1b), debounced **1,000 ms**, and flushed unconditionally in the `confirm_close` path
  — **after** the editor buffer, never before (CONTRACT §1.6).
- A corrupt or unparseable file is **silently replaced with defaults**. Never an error dialog, never a
  startup failure. Losing a window position is not worth a modal.
- `recents` is deduplicated by canonical path, MRU, max 8; the `vaults` map is pruned to those 8
  entries on write, which is what stops the file growing without bound.
- `last_note` is `Option<Option<String>>` on the patch, because the outer `None` means "the patch did
  not mention it" and the inner `None` means "there is no open note now".
- Reading it is one `open` + `read` of a few hundred bytes, and it is the only I/O the startup path
  performs.

### 9.4 Switching, and actually releasing the memory

**Normative ordering, both sides: see CONTRACT.md §4.3.** The Rust half is
`app::open_vault_blocking`; the order it implements is:

1. **Cancel every live search FIRST**, while the outgoing snapshot's last holder still exists, so no
   worker is walking an arena about to be torn down.
2. **Stop the watcher BEFORE the vault**, and drop it with no other lock held: dropping it joins its
   thread, and that thread takes the vault lock. Doing this under the vault write guard is a
   deadlock.
3. **Take the vault out of the slot and drop it OUTSIDE the lock**, so tearing down a 5,000-node
   arena does not hold every reader out.
4. **Build the new one off the UI thread** — `scan::walk_vault` then the temp sweep then the watcher.
5. **Install and persist**: store the `Arc<Vault>`, record the vault in `recents`, restore the
   per-vault `last_note` into `open_note`, emit `nc://vault-opened`.

The root is canonicalised once, at open, and the canonical root is what the arena, the watcher and
the prefs keys all use: FSEvents reports canonical paths, `/var` is a symlink to `/private/var` on
every Mac, and two spellings of one directory make echo suppression and the watcher's root test
silently disagree.

**Startup never blocks on the vault walk.** The launch path spawns the walk on its own thread and
`current_vault()` returns `{ state: 'loading' }` until `nc://vault-opened` arrives; a failure
releases the loading state and names the path on stderr.

**Is the memory actually returned to the OS?** The arena's three buffers are `nodes` ≈ 132 KiB,
`names` ≈ 111 KiB, `kids` ≈ 22 KiB, plus the snapshot's ~440 KB if search ran. Both platform
allocators service requests above ~128 KiB with `mmap` and release them with `munmap` on free —
glibc's `M_MMAP_THRESHOLD` defaults to 128 KiB, and macOS `libmalloc` routes anything above its large
threshold to VM regions that are returned on free. The smaller buffers land in the allocator's free
lists and are reused by the next vault; no manual trimming call exists anywhere in the core.

---

## 10. The error type

**The wire shape, the variant list and the TypeScript mirror are normative in CONTRACT.md §1.5.**
`error.rs` is owner 02 and is the Rust half:

```rust
// error.rs — no thiserror (see §1.3)
#[derive(Debug, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum VaultError { /* exactly the variants in CONTRACT §1.5, in that order */ }

impl std::fmt::Display for VaultError { /* one match arm per variant, ~25 lines */ }
impl std::error::Error for VaultError {}
```

`#[serde(tag = "kind")]` produces a discriminated union TypeScript narrows natively. A command
returning `Result<T, VaultError>` rejects the JS promise with exactly that object. **No command
returns `String` as its error.**

---

## 11. The IPC contract

Every subsection here is a pointer.

| Was | Now |
|---|---|
| §11.1 conventions | **Normative: CONTRACT §1.1.** |
| §11.2 raw-bytes framing | **Normative: CONTRACT §2** (frame) and **§1.2** (transport). The frame is magic-guarded, self-describing, 24 bytes, and exists in exactly two files. The raw path stands on the measured ×2.6/×1.9 at 1 MiB and +36 MB RSS for an 8 MiB JSON write. |
| §11.3 autosave contract | **Normative: CONTRACT §7.2.** 800 ms idle / 5 s cap / flush on switch, blur, hidden and close, extended with `visibilitychange` and `Mod-s`. The 5.04 ms fsync is still sized against that 800 ms floor. |
| §11.4 command list | **Normative: CONTRACT §1.3** — **twenty-five** commands. `list_tree`, `set_expanded`, `reveal`, `TreePage`, `TreeRow` and the tree-paging policy do not exist: the tree crosses IPC once, whole, as `TreeBlob v1` raw bytes. |
| §11.5 events | **Normative: CONTRACT §1.4.** One namespace, `nc://`; `vault://`, `note://` and `tree:` do not exist. |
| §11.6 TypeScript types | **Normative: CONTRACT §1.5**, and `src/ipc.ts` is **owned by 02** — the only frontend module that crosses the bridge. |

### 11.7 `MemReport` (debug builds only)

Ours:

`MemReport` crosses the IPC boundary as command 19's result, so **every field is camelCase**
(CONTRACT §1.1) and the Rust mirror carries `#[serde(rename_all = "camelCase")]`.

```ts
export interface MemReport {
  arenaBytes: number;      // the arena's resident capacity: nodes + kids + names, plus slack
  nodes: number;           // live node count in the arena
}
```

The command is `#[cfg(debug_assertions)]` on the Rust side; a release addon does not export it. Gate
G2's 768 KiB arena budget is checked against `arenaBytes` on the 5,000-note fixture. The report is a
scaffold: it is deliberately the shape the gate needs and nothing more.

---

## 12. Startup sequence

**§12. (DELETED — the startup timeline and the first-run panel described here belonged to the Tauri
build. The first-run state is CONTRACT §7.5 and the surviving rule — startup never blocks on the
vault walk — lives in §9.4.)**

---

## 13. Build profile and the allocator

### 13.1 Profiles

**Normative: see CONTRACT.md §6.2.** `opt-level = "s"`, `panic = "unwind"`, `lto = "fat"`,
`codegen-units = 1`, `strip = "symbols"`, `memchr` pinned to `opt-level = 3`.

The **obligation** those values create is a rule for code in this spec's modules: with
`panic = "unwind"`, **no `unwrap()` or `expect()` on anything derived from I/O, IPC input, or the
filesystem.** Locks use the poison-recovery helpers in §3.3.
`#![deny(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]` in `app.rs`,
`fsops.rs`, `prefs.rs`, `scan.rs`, `search.rs`, `tree.rs` and `watcher.rs`, with `#[allow]` on the
handful of provably-infallible sites (e.g. the `size_of` assertion). Gate G7.

### 13.2 The `opt-level` verification gate

Kept because it is a rule and not a restatement: build at `"s"`, run gate G4. **If the full-text scan
of the fixture exceeds 60 ms, switch the whole profile to `3` and re-measure. Do not switch on
taste.** Note that under `lto = "fat"` the final cross-module pass uses the top-level opt-level, so
per-package overrides are a strong hint, not a hard partition; if per-package control turns out to
matter, `lto = "thin"` preserves it at a small size cost.

### 13.3 The global allocator: measure, then almost certainly do nothing

**Decision: ship the system allocator. Do not add `mimalloc` or `jemalloc`.**

The reasoning is about *this* program's allocation pattern, not about allocator benchmarks:

1. **The large allocations bypass the allocator's arenas entirely.** `nodes` (132 KiB), `names`
   (256 KiB reserved) and every `read_note` buffer above 128 KiB are served by `mmap` on glibc and by
   dedicated VM regions on macOS `libmalloc`, and are returned on free. A replacement allocator
   cannot improve on "already returned to the kernel".
2. **The small-allocation volume is trivial.** Per-directory scratch during a walk, a handful of
   `PathBuf`s per command, JSON serialisation buffers. There is no fragmentation problem to solve
   because there is barely any heap.
3. **It cannot touch the thing that dominates.** The webview is a separate process group; the Rust
   arena is ~0.44 MB of the app.
4. **It is not free.** `mimalloc` adds ~150–250 KB of always-resident text and reserves large virtual
   regions; `jemalloc` adds more and is a build-system liability on macOS.

The one allocation risk — an allocator retaining freed scratch between vault switches — is covered
by the mmap-threshold behaviour above, because everything large is already returned and everything
small is reused by the next vault.

**Measurement protocol before overriding this decision** (do not swap on vibes):

```
Build A: system allocator.  Build B: identical + #[global_allocator] mimalloc.
For each, with the 5,000-note fixture, record phys_footprint (CONTRACT §8.1) at four points:
  P1 idle, no vault open
  P2 vault open, one note displayed
  P3 immediately after a full-text search
  P4 30 s after switching to an empty vault
Ship B only if it wins >= 5 MB at P2 or P4. Record the numbers in this section.
```

---

## 14. Configuration

### 14.1 `tauri.conf.json`

**§14.1. (DELETED — there is no Tauri configuration; the stack is Electron 39.8.3 / Chrome 142, and
the shell's own configuration lives in `package.json` and `electron-shell/`.)**

### 14.2 `capabilities/main.json`

**§14.2. (DELETED — Tauri's ACL does not exist in this stack.)** The observation that motivated the
hand-enumerated capability list survives and matters to the Electron shell: **the renderer is granted
nothing.** It reaches the core only through `ipcMain` handlers, and every filesystem operation is a
narrow, vault-scoped command. No `dialog:*`, no `shell:*`; a note can name a URL but the scheme
allowlist is enforced in the main process (CONTRACT §1.3 command 22).

### 14.3 Module layout (Rust side)

```
core/
├── Cargo.toml                // CONTRACT §6.2, owner 07
├── src/
│   ├── lib.rs                // the public surface: AppState, spawn_blocking, module exports (02)
│   ├── app.rs                // AppState, the command bodies, open_vault, close handshake (02)
│   ├── vault.rs              // Vault, VaultInfo/VaultState/RecentVault, the open half      (02)
│   ├── error.rs              // VaultError + Display                                      (02)
│   ├── note_frame.rs         // THE ONLY RUST COPY OF THE NOTE FRAME (CONTRACT §2)         (02)
│   ├── tree.rs               // Node, VaultTree, rescan diff, nat_cmp, compaction,
│   │                         // TreeBlob encoder, VaultSnapshot (~700)                     (02)
│   ├── scan.rs               // the walk, the 50k/255 caps, the temp sweep                 (02)
│   ├── path.rs               // validate_name / validate_rel_for_lookup                    (02)
│   ├── fsops.rs              // atomic write, read, create, rename, move, delete, reveal   (02)
│   ├── watcher.rs            // notify setup, coalescer, classify, fingerprints            (02)
│   ├── search.rs             // spec-05's engine                                            (05)
│   ├── prefs.rs              // state.json load/save/debounce                               (02)
│   └── bench.rs              // harness-only measurements, MemReport                         (06)
└── napi/src/lib.rs           // THE ONLY JS-FACING CRATE: one call into `app.rs` per command,
                              // no wire type, no logic. The runtime is built here (§3.2).    (07)
```

`napi/src/lib.rs` is `cmds.rs`'s successor and obeys the same rule: **at most one call into
`app.rs` per command, and no logic of its own.** It declares no wire type — the bytes come out of
`tree.rs` and `note_frame.rs` themselves, and every JSON shape is `serde_json::to_value` over the
very struct the casing rule already annotates. Argument extraction that is not trivial belongs in
`app.rs`, not here; header parsing belongs in `note_frame::parse_write_headers` (§6.2).

On the frontend side this spec owns **`src/ipc.ts`** and **`src/note_frame.js`**.

---

## 15. Verification

### 15.1 The fixture

The canonical generator is **`tools/gen-vault.sh`, owner 06** (CONTRACT §6.4). The fixture every
number in §0 was taken on is fixed: **5,000 `.md` notes across 620 directories, 10,059,538 B of text,
max depth 4, 5,621 nodes including the root**, from a fixed seed so it reproduces exactly; `--verify`
checks the byte total. Note bodies contain headings, paragraphs and at least one fenced code block,
because the editor and search fixtures need them. The search corpora (Corpus A at ~2,054 B mean and
Corpus B at ~5,107 B mean) come from the same script with `--mean-bytes` (spec-05 §2.1).

The micro-benchmarks behind §0's surviving rows (arena walk, threaded scan, atomic-write latency)
were single-file dependency-free programs; recreate them from §4.2, §4.6 and §6.2 if a row needs
re-taking — they are literally those with timing around them.

### 15.2 Acceptance gates

**Normative: see CONTRACT.md §6.5.**

The gates that touch this document's code are **G1** (`size_of::<Node>() == 24`), **G2** (arena
≤ 768 KiB), **G3** (cold walk ≤ 50 ms), **G4** (4-thread scan of the 10 MB corpus ≤ 65 ms), **G7**
(no `unwrap`/`expect`/`indexing_slicing` in the named modules), **G8** (zero stray files written to
the vault), **G-RT** (the frame round-trip invariant, CONTRACT §2.4/§2.5) and **G-CSP** (a real
invoke round-trips in a release build).

Two rules of §6.5 bind every number in this document: **every gate is evaluated on the median of 5
runs with run 1 discarded**, and every gate carries a stated margin — a timing gate is
`ceil₅(1.25 × the median measurement)`, a memory gate at least 2× the ±1.5 MB noise floor (≥ 3 MB),
sampled at 20 s. A threshold equal to its own measurement is not a gate.

### 15.3 How to measure footprint

**§15.3. (DELETED — the footprint harness this section described measured the retired Tauri build
and is gone; the live protocol is CONTRACT §6.5's median-of-5 rule at a 20 s settle, rejecting
occluded runs.)**

### 15.4 Behavioural tests that must exist (Rust side)

The data-loss paths and their tests are enumerated in CONTRACT §7.3; these are the backend tests that
implement the Rust half, plus the ones the contract does not carry.

1. **Atomic write survives a kill.** Write in a loop while `SIGKILL`ing; the note is always either
   the complete old or the complete new content, never truncated, and the next vault open leaves
   **zero** `.tmp-` files — which holds because the sweep unlinks debris whose PID is dead (§4.6-7).
2. **Echo suppression.** Save 200 times in a row; assert zero `nc://tree-changed` events attributable
   to those writes and zero `nc://note-external-change`.
3. **External edit is not suppressed.** Save, then within 100 ms overwrite the file from a shell with
   different content; assert exactly one `nc://note-external-change`.
4. **Rename does not break external-change detection.** Rename the open note in-app, edit the file
   from a shell, assert **exactly one** `nc://note-external-change`. Delete the open note and assert
   `open_note` is cleared and no further events reference it.
5. **A rescan does not disturb untouched subtrees.** Expand nothing (expansion is frontend-owned);
   `touch` a file in one folder and assert every other folder's `kids` run and every `NodeId` outside
   the dirtied directory are unchanged, and that `epoch` advanced exactly once.
6. **Traversal.** `read_note("../../etc/passwd")`, `read_note("/etc/passwd")`,
   `rename_entry("a.md", "../b.md")`, `create_note("", "../x")` → all `invalidPath` / `invalidName`,
   with nothing outside the root opened (verify with `dtruss` / `strace`).
7. **Awkward-but-legal names resolve.** Create `Archive ` (trailing space) and `v1.` from a shell
   inside the vault; open, rename and delete a note inside each through the app; all succeed.
   `validate_name` still refuses to *create* either.
8. **Case-only rename** on APFS: `notes.md` → `Notes.md` succeeds, the file survives with its content,
   and a genuine collision (`NOTES.md` created from a shell, then renamed to `Notes.md`) is refused.
9. **Non-UTF-8 note** → `notUtf8`, and the file is byte-identical afterwards.
10. **8 MiB + 1 note** → `tooLarge`, and the footprint does not spike.
11. **Trash then restore.** Delete a note; assert it is on macOS in `~/.Trash` and on Debian in
    `$XDG_DATA_HOME/Trash/files` with a `.trashinfo` carrying a `DeletionDate`. This is why `trash`
    keeps its default features.
12. **`nat_cmp`** — `Note 2.md` < `Note 10.md`; `a` < `B` < `c`; `README` and `readme` order stably.
13. **Caps.** A generated vault of 60,000 nodes sets header flag bit 0 and `VaultInfo.truncated`, and
    the walk stops at 50,000; a 300-deep chain sets header flag bit 1 and emits **no**
    `nc://watch-degraded`.
14. **The round-trip invariant**, all seven cases — CONTRACT §2.4, gate G-RT. It is listed here too
    because `read_note` and `write_note` are this spec's code.

---

## 16. Known limitations and open questions

### 16.1 Open questions — status

**§16.1. (DELETED — the open-questions table is closed; the settled answers live in CONTRACT §1, §3,
§7 and §9 where they bind.)**

### 16.2 Accepted limitations

- **Symlinks are skipped entirely** (§4.6-3) — both symlinked directories and symlinked notes.
  Obsidian follows them. This buys structural loop-immunity and a hard guarantee that no path in the
  arena escapes the vault root. A vault that uses symlinks to stitch in an external folder shows that
  folder as absent, with no error. The fix, if it ever matters, is to follow symlinked *directories*
  only after `canonicalize` confirms they stay under the root, plus a visited-inode set —
  meaningfully more code and a real class of bugs.
- **Filenames are not Unicode-normalised.** We compare and store the bytes `read_dir` returns; a note
  saved as NFD on macOS and NFC on Linux is two different names to this app. `path.rs` performs no
  NFC/NFD normalisation.
- **Linux inotify watch exhaustion** on very large vaults degrades to the manual refresh banner
  (§7.1). We do not silently fall back to polling. CONTRACT §7.3 case 16's injected
  `ErrorKind::MaxFilesWatch` covers the degrade path.
- **Network filesystems (NFS, SMB) emit no events.** `notify` documents this. The vault still works;
  external changes arrive on the next open. We do not detect this and do not warn (CONTRACT §7.3
  case 9).
- **A concurrent writer that produces byte-identical length and nanosecond mtime** would be mistaken
  for our own write (§7.4). This requires writing the same-length content within the same nanosecond;
  it is not reachable in practice.
- **Mixed line endings** are not round-tripped: `FLAG_CRLF` records that a file used `\r\n` and
  `denormalise` writes `\r\n` back, but a file that mixes both conventions loses the mixture. A lone
  `\r` is preserved as text and written back as `\n` (`\r\n` under `FLAG_CRLF`).
- **Hard deletes are permanent.** `delete_entry(permanent = true)` is only reachable from the
  second, explicitly-worded confirmation (§6.5); there is no undo.

### 16.3 Deliberate non-goals restated

No index, no database, no cache of note content, no background scanning, no telemetry, no plugin
host, no second window, no light theme, no expansion state in Rust, and nothing whatsoever written
into the user's vault beyond the notes themselves.
