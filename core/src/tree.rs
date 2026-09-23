//! core/src/tree.rs — Owner: 02.
//! Spec: CONTRACT.md §3 (the tree transport, B1/B19/M49/M38/M61), §3.2 (TreeBlob
//! v1's layout), §3.5 (M69), §4.2 (the `Arc<VaultSnapshot>` seam, X14),
//! spec-02 §4 (the arena), M28/M53, gates G1, G2.
//!
//! GATE G1 IS A COMPILE-TIME ASSERT: `size_of::<Node>() == 24`.  It was 28
//! before `ctime` was removed (M53), and `Node.ctime` does not come back — there
//! are FOUR sort orders (name asc/desc, mtime desc/asc), wire type `u8` 0..3,
//! and NO created-time sort.  spec-02 §4.5's six-variant enum and §11.6's string
//! union are STRUCK.
//!
//! `Node.mtime` is updated on EVERY content hit (M69), not "only if the sort
//! mode is time-based" — a stale mtime is wrong regardless of what is currently
//! being sorted on.
//!
//! NO PATH IS STORED PER NODE (spec-02 §4.4).  Paths are reconstructed by
//! walking the parent chain — measured 150 ns/path, against ~200 B/node to
//! store them, i.e. more than double the entire model to save 150 ns.  The one
//! exception is §4.2's `VaultSnapshot`, which materialises paths LAZILY, ONCE,
//! on first search, and never at rest.
//!
//! TWO INDEX SPACES, NAMED AND SEPARATED (X14).  `VaultSnapshot.files` is the
//! FILES-ONLY index space; the TreeBlob's node indices also cover directories.
//! `FileGroup.id` indexes the former, and PATH is the join key between them.
//!
//! `flag::EXPANDED` is STRUCK (§3.4): expansion is FRONTEND-owned, a
//! `Set<string>` of vault-relative folder paths persisted per vault.  Rust
//! carries none, and `set_expanded` / `reveal` do not exist.
//!
//! CLIPPY DENY LIST (§6.2, gate G7) applies to this module.
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]

use std::cmp::Ordering;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock, RwLockReadGuard, RwLockWriteGuard};

use crate::path as vpath;

pub type NodeId = u32;
pub const NONE: NodeId = u32::MAX;
pub const ROOT: NodeId = 0;

pub mod flag {
    /// directory
    pub const DIR: u8 = 1 << 0;
    // bits 1..7 reserved; keep the field a u8.
    // There is deliberately no EXPANDED bit — expansion is frontend-owned
    // (CONTRACT §3.4).
}

/// EXACTLY 24 bytes (gate G1).  Field order is load-bearing: it produces zero
/// padding.
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct Node {
    /// `NONE` for ROOT.
    pub parent: NodeId, // 4
    /// byte offset into `VaultTree::names`
    pub name_off: u32, // 4
    /// start index into `VaultTree::kids`
    pub kids_off: u32, // 4
    /// number of children (0 for files)
    pub kids_len: u32, // 4
    /// unix seconds, saturating; 0 = unknown
    pub mtime: u32, // 4
    /// bytes; POSIX caps filenames at 255, so u16 is 256x headroom
    pub name_len: u16, // 2
    /// ROOT = 0; hard cap 255
    pub depth: u8, // 1
    pub flags: u8, // 1
} // = 24, align 4, no padding — verified by the compiler on the next line.

/// GATE G1.  If this ever fails, a field was added or reordered and the whole
/// per-node budget (§4.3) moved with it.
const _: () = assert!(core::mem::size_of::<Node>() == 24);
const _: () = assert!(core::mem::align_of::<Node>() == 4);

impl Node {
    #[must_use]
    pub fn is_dir(&self) -> bool {
        self.flags & flag::DIR != 0
    }
}

/// CONTRACT §1.5 / spec-02 §4.5.  The wire value is the `u8` and it is the ONLY
/// wire value.  FOUR orders — `CtimeDesc`/`CtimeAsc` went with the `ctime`
/// field (M28/M53), and so did the kebab-case string serialisation.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
#[repr(u8)]
pub enum SortMode {
    #[default]
    NameAsc = 0,
    NameDesc = 1,
    MtimeDesc = 2,
    MtimeAsc = 3,
}

impl SortMode {
    /// The wire decoder for command 7 (`set_sort`).  Out-of-range is `None`, so
    /// a bad `u8` is an `invalidName`-class refusal at the command boundary and
    /// never a silent fallback to `NameAsc`.
    #[must_use]
    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(Self::NameAsc),
            1 => Some(Self::NameDesc),
            2 => Some(Self::MtimeDesc),
            3 => Some(Self::MtimeAsc),
            _ => None,
        }
    }
    #[must_use]
    pub fn as_u8(self) -> u8 {
        self as u8
    }
}

/* ── natural order (spec-02 §4.5) ─────────────────────────────────────────── */

/// Natural, case-insensitive comparison: `Note 2.md` before `Note 10.md`, as
/// Obsidian does.  No crate.
///
/// Walk both strings.  When both sides are at an ASCII digit, consume the full
/// digit run on each side, strip leading zeros, and compare first by remaining
/// LENGTH and then lexicographically — unsigned numeric order without parsing,
/// so it cannot overflow on a 400-digit filename.  Otherwise compare one char
/// from each side folded via `to_lowercase().next()`.
///
/// If the folded comparison is `Equal` for the whole string, tie-break with
/// `a.cmp(b)` so the order is TOTAL — otherwise `README` and `readme` would be
/// interchangeable and the tree would flicker between rescans.
#[must_use]
pub fn nat_cmp(a: &str, b: &str) -> Ordering {
    let (ab, bb) = (a.as_bytes(), b.as_bytes());
    let (mut i, mut j) = (0usize, 0usize);
    loop {
        let (x, y) = (ab.get(i).copied(), bb.get(j).copied());
        match (x, y) {
            (None, None) => break,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let sa = i;
                while ab.get(i).is_some_and(u8::is_ascii_digit) {
                    i += 1;
                }
                let sb = j;
                while bb.get(j).is_some_and(u8::is_ascii_digit) {
                    j += 1;
                }
                let da = strip_zeros(ab.get(sa..i).unwrap_or(&[]));
                let db = strip_zeros(bb.get(sb..j).unwrap_or(&[]));
                match da.len().cmp(&db.len()).then_with(|| da.cmp(db)) {
                    Ordering::Equal => {}
                    ord => return ord,
                }
            }
            (Some(_), Some(_)) => {
                let ca = char_at(a, i);
                let cb = char_at(b, j);
                match (ca, cb) {
                    (Some(ca), Some(cb)) => {
                        i += ca.len_utf8();
                        j += cb.len_utf8();
                        let fa = ca.to_lowercase().next().unwrap_or(ca);
                        let fb = cb.to_lowercase().next().unwrap_or(cb);
                        match fa.cmp(&fb) {
                            Ordering::Equal => {}
                            ord => return ord,
                        }
                    }
                    // Not reachable for well-formed &str; degrade to the total
                    // byte order rather than looping forever.
                    _ => return a.cmp(b),
                }
            }
        }
    }
    a.cmp(b)
}

fn strip_zeros(run: &[u8]) -> &[u8] {
    let mut k = 0usize;
    while run.get(k) == Some(&b'0') && k + 1 < run.len() {
        k += 1;
    }
    run.get(k..).unwrap_or(&[])
}

fn char_at(s: &str, i: usize) -> Option<char> {
    s.get(i..).and_then(|t| t.chars().next())
}

/// The one ordering key, shared by the walk (which sorts raw directory entries
/// before they become nodes) and by `set_sort` (which re-sorts child runs in
/// place).  Two call sites, one rule:
///   1. Directories always sort before files, in EVERY mode.
///   2. Within a group, compare by the mode's key.
///   3. Time modes tie-break by `nat_cmp`, so the order is total and stable
///      across rescans.
///
/// COMPARES DISPLAY NAMES, NOT ON-DISK NAMES — user report, 2026-09-15:
/// `"Note 0212 a very long filename…"` sorted BEFORE `"Note 0212"` in Cairn and
/// after it in Obsidian.  A space (0x20) sorts before a dot (0x2E), so
/// comparing the on-disk names — `"Note 0212 a….md"` against `"Note 0212.md"`
/// — puts the longer one first at the first byte they differ on, which is
/// inside the OTHER file's extension.  Read from Obsidian's own bundle
/// (§0.17's method — `app.js`, offset 1443629): its alphabetical mode is
/// `(e,t) => Sw(e.basename, t.basename)`, `Sw` being `Intl.Collator(undefined,
/// {usage:"sort", sensitivity:"base", numeric:true}).compare` — sorted on the
/// FILE's basename (extension stripped), never its on-disk name.  Folders
/// compare by `.name` — untouched — which `vpath::display_name` already gives
/// for a directory (folders carry no `.md` to strip), so one call covers both
/// arms without a directory branch of its own. `set_sort`'s comparator was the
/// other call site and got the same fix for free — `node_key` below already
/// hands it the same `(&str, bool, u32)` shape.
fn cmp_key(mode: SortMode, a: (&str, bool, u32), b: (&str, bool, u32)) -> Ordering {
    match (a.1, b.1) {
        (true, false) => return Ordering::Less,
        (false, true) => return Ordering::Greater,
        _ => {}
    }
    let da = crate::path::display_name(a.0, a.1);
    let db = crate::path::display_name(b.0, b.1);
    match mode {
        SortMode::NameAsc => nat_cmp(da, db),
        SortMode::NameDesc => nat_cmp(db, da),
        SortMode::MtimeDesc => b.2.cmp(&a.2).then_with(|| nat_cmp(da, db)),
        SortMode::MtimeAsc => a.2.cmp(&b.2).then_with(|| nat_cmp(da, db)),
    }
}

/* ── the arena ────────────────────────────────────────────────────────────── */

/// spec-02 §4.6-2's pre-reserves.  Measured: the 5,000-note fixture never grew
/// any of them.  Growth is not a correctness issue, just realloc churn during
/// the scan.
pub const RESERVE_NODES: usize = 8_192;
pub const RESERVE_KIDS: usize = 8_192;
pub const RESERVE_NAMES: usize = 256 * 1024;

/// A struct-of-arrays arena: three flat buffers, `u32` indices, no per-node heap
/// allocation, no `Rc`, no `RefCell`, no `PathBuf` per node, no `String` per
/// node.  Measured 81.6 bytes/node over 5,621 nodes (spike A §4.1).
pub struct VaultTree {
    /// Node arena. Index == NodeId. Slot 0 is always ROOT and is never freed.
    pub nodes: Vec<Node>,
    /// Child runs. Node `n`'s children are
    /// `kids[n.kids_off .. n.kids_off + n.kids_len]`, in the CURRENT display
    /// order (§4.5).
    pub kids: Vec<NodeId>,
    /// One concatenated UTF-8 buffer holding every node's ON-DISK file name, no
    /// separators.  Nothing is ever removed from it: every repair re-walks into
    /// a FRESH `VaultTree`, so a name that leaves the model leaves with the
    /// whole arena.
    pub names: String,

    /// The ONLY `PathBuf` in the model.
    pub root_path: PathBuf,
    pub sort: SortMode,

    /// The value of the one process-wide counter at the last structural
    /// mutation.  Emitted in the blob header at offset 24 and used to
    /// invalidate the snapshot cache (§4.2).
    pub epoch: u64,
    pub n_notes: u32,
    pub n_dirs: u32,
    /// The 50,000-node cap was hit — header `flags` bit 0, `VaultInfo.truncated`.
    pub truncated_nodes: bool,
    /// A subtree was cut at depth 255 — header `flags` bit 1,
    /// `VaultInfo.truncatedDepth`.  ITS OWN BIT: a degraded watcher and a
    /// too-deep folder are different facts with different remedies (§3.3).
    pub truncated_depth: bool,
}

impl VaultTree {
    #[must_use]
    pub fn new(root_path: PathBuf, sort: SortMode, epoch: u64) -> Self {
        let mut nodes = Vec::with_capacity(RESERVE_NODES);
        nodes.push(Node {
            parent: NONE,
            name_off: 0,
            kids_off: 0,
            kids_len: 0,
            mtime: 0,
            name_len: 0,
            depth: 0,
            flags: flag::DIR,
        });
        Self {
            nodes,
            kids: Vec::with_capacity(RESERVE_KIDS),
            names: String::with_capacity(RESERVE_NAMES),
            root_path,
            sort,
            epoch,
            n_notes: 0,
            n_dirs: 0,
            truncated_nodes: false,
            truncated_depth: false,
        }
    }

    /// Live, non-root node count — the blob's `node_count` and the number every
    /// cap and budget is stated against.
    #[must_use]
    pub fn node_count(&self) -> usize {
        self.nodes.len().saturating_sub(1)
    }

    #[must_use]
    pub fn get(&self, id: NodeId) -> Option<&Node> {
        self.nodes.get(id as usize)
    }

    /// The ON-DISK name (including `.md`).  Resolution always works in on-disk
    /// names; only the blob strips the extension, for display (§3.2).
    #[must_use]
    pub fn name(&self, id: NodeId) -> &str {
        let Some(n) = self.nodes.get(id as usize) else { return "" };
        let s = n.name_off as usize;
        let e = s + n.name_len as usize;
        self.names.get(s..e).unwrap_or("")
    }

    fn intern(&mut self, name: &str) -> (u32, u16) {
        let off = self.names.len() as u32;
        self.names.push_str(name);
        (off, name.len() as u16)
    }

    fn alloc_node(&mut self, n: Node) -> NodeId {
        self.nodes.push(n);
        (self.nodes.len() - 1) as NodeId
    }

    /// Append one directory's children as a single contiguous run, sorted by the
    /// active mode as it is read (§4.6-6: the walk emits an already-sorted tree;
    /// there is no second pass).  `entries` is `(on-disk name, is_dir, mtime)`
    /// and is sorted in place.
    ///
    /// Returns the run's `(off, len)`.  Callers that need to descend read the
    /// ids back out of `kids`.
    pub fn add_children(
        &mut self,
        parent: NodeId,
        entries: &mut [(String, bool, u32)],
    ) -> (u32, u32) {
        let mode = self.sort;
        entries.sort_by(|a, b| cmp_key(mode, (&a.0, a.1, a.2), (&b.0, b.1, b.2)));

        let depth = self.get(parent).map_or(0, |p| p.depth).saturating_add(1);
        let off = self.kids.len() as u32;
        for (name, is_dir, mtime) in entries.iter() {
            let (name_off, name_len) = self.intern(name);
            let id = self.alloc_node(Node {
                parent,
                name_off,
                kids_off: 0,
                kids_len: 0,
                mtime: *mtime,
                name_len,
                depth,
                flags: if *is_dir { flag::DIR } else { 0 },
            });
            self.kids.push(id);
            if *is_dir {
                self.n_dirs += 1;
            } else {
                self.n_notes += 1;
            }
        }
        let len = entries.len() as u32;
        // A directory that is re-read (the watcher's unit of repair is a
        // DIRECTORY, never a file — §3.5) gets a NEW run appended and its old
        // one abandoned.  The abandoned run stays in `kids` until the whole
        // arena is replaced, which every repair does.
        if let Some(p) = self.nodes.get_mut(parent as usize) {
            p.kids_off = off;
            p.kids_len = len;
        }
        (off, len)
    }

    /// The child ids of `id`, in display order.
    #[must_use]
    pub fn children(&self, id: NodeId) -> &[NodeId] {
        let Some(n) = self.nodes.get(id as usize) else { return &[] };
        let s = n.kids_off as usize;
        let e = s + n.kids_len as usize;
        self.kids.get(s..e).unwrap_or(&[])
    }

    /* ── paths: reconstructed, never stored (§4.4) ────────────────────────── */

    /// Absolute path.  Allocates once, sized from `depth`.
    #[must_use]
    pub fn abs_path(&self, id: NodeId) -> PathBuf {
        let mut out = PathBuf::new();
        self.abs_path_into(id, &mut out);
        out
    }

    /// Vault-relative path with `/` separators — the IPC identity of a node
    /// (§5.1).  ROOT is `""`.
    #[must_use]
    pub fn rel_path(&self, id: NodeId) -> String {
        let mut out = String::new();
        self.rel_path_into(id, &mut out);
        out
    }

    /// Reusable-buffer variant.  MUST be used in hot loops (the snapshot build,
    /// the blob build) — that is what makes 5,000 paths 0.8 ms instead of 5,000
    /// allocations.
    pub fn abs_path_into(&self, id: NodeId, out: &mut PathBuf) {
        out.clear();
        out.push(&self.root_path);
        let chain = self.chain(id);
        for &s in chain.iter().rev() {
            out.push(self.name(s));
        }
    }

    /// Reusable-buffer variant of `rel_path`.
    pub fn rel_path_into(&self, id: NodeId, out: &mut String) {
        out.clear();
        let chain = self.chain(id);
        for (k, &s) in chain.iter().rev().enumerate() {
            if k > 0 {
                out.push('/');
            }
            out.push_str(self.name(s));
        }
    }

    /// The parent chain from `id` up to (but excluding) ROOT, deepest first.
    /// Sized from `depth`, so it allocates once and never grows.
    fn chain(&self, id: NodeId) -> Vec<NodeId> {
        let cap = self.get(id).map_or(0, |n| n.depth as usize);
        let mut chain = Vec::with_capacity(cap);
        let mut cur = id;
        // `depth + 1` is a hard bound on the walk: a cycle cannot exist in a
        // tree built by the walk, but a bounded loop cannot hang either way.
        for _ in 0..=cap {
            if cur == ROOT || cur == NONE {
                break;
            }
            chain.push(cur);
            match self.get(cur) {
                Some(n) => cur = n.parent,
                None => break,
            }
        }
        chain
    }

    /* ── resolution (§5.1) ────────────────────────────────────────────────── */

    /// Resolve a vault-relative path to a live node.  `None` if any component is
    /// missing.  THIS is the traversal guarantee (§7.3 case 13), not the
    /// character rules: the walk never admits `..` (`read_dir` does not yield
    /// it) and never admits a symlink, so a path that resolves is inside the
    /// vault by construction.
    ///
    /// Lookup inside a run is a linear scan, not a binary search: the run is in
    /// DISPLAY order, and a folder with 500 children costs 500 short `str`
    /// comparisons (~2 µs).  That removes the need for any secondary index.
    #[must_use]
    pub fn resolve(&self, rel: &str) -> Option<NodeId> {
        if rel.is_empty() {
            return Some(ROOT);
        }
        let mut cur = ROOT;
        for comp in rel.split('/') {
            let node = self.get(cur)?;
            if !node.is_dir() {
                return None;
            }
            cur = *self.children(cur).iter().find(|&&c| self.name(c) == comp)?;
        }
        Some(cur)
    }

    /// Resolve the parent directory of a not-yet-existing entry, plus the final
    /// component.
    #[must_use]
    pub fn resolve_parent<'a>(&self, rel: &'a str) -> Option<(NodeId, &'a str)> {
        let (dir, name) = match rel.rfind('/') {
            Some(i) => (rel.get(..i)?, rel.get(i + 1..)?),
            None => ("", rel),
        };
        let parent = self.resolve(dir)?;
        if !self.get(parent)?.is_dir() {
            return None;
        }
        Some((parent, name))
    }

    /* ── mutation (§4.7) ──────────────────────────────────────────────────── */

    /// Re-sort every child run in place and bump the epoch.  Borrowck note: the
    /// comparator needs `&self.names` while `&mut self.kids` is borrowed, so the
    /// buffers are taken out and put back.
    ///
    /// Does NOT re-`stat`: it does not need to, because `Node.mtime` is updated
    /// on every content hit (M69).
    pub fn set_sort(&mut self, mode: SortMode, epoch: u64) {
        if self.sort == mode {
            return;
        }
        self.sort = mode;
        let names = core::mem::take(&mut self.names);
        let nodes = core::mem::take(&mut self.nodes);
        for n in &nodes {
            if !n.is_dir() || n.kids_len == 0 {
                continue;
            }
            let s = n.kids_off as usize;
            let e = s + n.kids_len as usize;
            if let Some(run) = self.kids.get_mut(s..e) {
                run.sort_by(|&a, &b| {
                    let (na, nb) = (
                        node_key(&nodes, &names, a),
                        node_key(&nodes, &names, b),
                    );
                    cmp_key(mode, na, nb)
                });
            }
        }
        self.names = names;
        self.nodes = nodes;
        self.epoch = epoch;
    }

    /* ── budgets (gate G2, spec-02 §4.3) ──────────────────────────────────── */

    /// Resident arena bytes: every buffer's CAPACITY, including the §4.6-2
    /// pre-reserve slack, plus the one `PathBuf`.  This is the number gate G2
    /// (≤ 768 KiB for a 5,000-note vault) is evaluated against, because
    /// capacity — not length — is what the allocator is actually holding.
    #[must_use]
    pub fn arena_bytes(&self) -> u64 {
        (self.nodes.capacity() * core::mem::size_of::<Node>()
            + self.kids.capacity() * core::mem::size_of::<NodeId>()
            + self.names.capacity()
            + self.root_path.as_os_str().len()) as u64
    }

    /// Live payload bytes, excluding pre-reserve slack — the per-node budget of
    /// spec-02 §4.3 (`nodes` 24 + `kids` 4 + `names` ~20 ≈ 81.6 B/node measured).
    /// Kept separate from `arena_bytes` deliberately: a payload regression and a
    /// slack regression are different defects and a single number hides one
    /// behind the other.
    #[must_use]
    pub fn live_bytes(&self) -> u64 {
        (self.nodes.len() * core::mem::size_of::<Node>()
            + self.kids.len() * core::mem::size_of::<NodeId>()
            + self.names.len()) as u64
    }

    /* ── TreeBlob v1 (§3.2) ───────────────────────────────────────────────── */

    /// Encode the whole tree as `TreeBlob v1`.  Little-endian throughout; nodes
    /// in preorder DFS, already sorted by the active `SortMode`, EXCLUDING the
    /// vault root.
    ///
    /// > **Invariant P.** A node at index `i` owns the contiguous range
    /// > `[i+1, i+subtree[i]]`.  Its parent always has a lower index.  A
    /// > folder's parent is always a folder.
    ///
    /// `total = 36 + 14N + M`.  Measured 191,975 B at N=5,620, M=113,259.
    ///
    /// No `has_children` field is added (M61): `subtree[i] > 0` already answers
    /// it, and the chevron MUST be keyed off that so an empty folder draws none.
    #[must_use]
    pub fn encode_blob(&self) -> Vec<u8> {
        // Pass 1 — preorder DFS.  An explicit stack, never recursion.
        let n_hint = self.node_count();
        let mut order: Vec<NodeId> = Vec::with_capacity(n_hint);
        let mut parent_ix: Vec<i32> = Vec::with_capacity(n_hint);
        let mut subtree: Vec<u32> = Vec::with_capacity(n_hint);
        let mut stack: Vec<(NodeId, i32)> = Vec::with_capacity(64);
        for &c in self.children(ROOT).iter().rev() {
            stack.push((c, -1));
        }
        while let Some((id, pix)) = stack.pop() {
            let ix = order.len() as i32;
            order.push(id);
            parent_ix.push(pix);
            subtree.push(0);
            for &c in self.children(id).iter().rev() {
                stack.push((c, ix));
            }
        }

        // Pass 2 — descendant counts, bottom-up.  In preorder every child has a
        // higher index than its parent, so one reverse sweep is enough.
        for i in (0..order.len()).rev() {
            let Some(&p) = parent_ix.get(i) else { continue };
            if p < 0 {
                continue;
            }
            let own = subtree.get(i).copied().unwrap_or(0);
            if let Some(slot) = subtree.get_mut(p as usize) {
                *slot = slot.saturating_add(own).saturating_add(1);
            }
        }

        // Pass 3 — the names section, display names (§3.2).
        let n = order.len();
        let mut names: String = String::with_capacity(self.names.len());
        let mut name_off: Vec<u32> = Vec::with_capacity(n + 1);
        for &id in &order {
            name_off.push(names.len() as u32);
            let is_dir = self.get(id).is_some_and(Node::is_dir);
            names.push_str(vpath::display_name(self.name(id), is_dir));
        }
        name_off.push(names.len() as u32);
        let m = names.len();

        // Pass 4 — emit.
        let mut out: Vec<u8> = Vec::with_capacity(36 + 14 * n + m);
        out.extend_from_slice(&MAGIC.to_le_bytes());
        out.extend_from_slice(&VERSION.to_le_bytes());
        out.extend_from_slice(&(n as u32).to_le_bytes());
        out.extend_from_slice(&(m as u32).to_le_bytes());
        out.extend_from_slice(&u32::from(self.sort.as_u8()).to_le_bytes());
        let mut flags: u32 = 0;
        if self.truncated_nodes {
            flags |= FLAG_TRUNCATED_NODES;
        }
        if self.truncated_depth {
            flags |= FLAG_TRUNCATED_DEPTH;
        }
        out.extend_from_slice(&flags.to_le_bytes());
        out.extend_from_slice(&self.epoch.to_le_bytes());
        for v in &subtree {
            out.extend_from_slice(&v.to_le_bytes());
        }
        for v in &parent_ix {
            out.extend_from_slice(&v.to_le_bytes());
        }
        for v in &name_off {
            out.extend_from_slice(&v.to_le_bytes());
        }
        for &id in &order {
            // Arena depth 1 == blob depth 0: the root is not in the blob.
            out.push(self.get(id).map_or(0, |nd| nd.depth.saturating_sub(1)));
        }
        for &id in &order {
            let k = match self.get(id) {
                Some(nd) if nd.is_dir() => KIND_DIR,
                // `names` lost the extension's case; bits 1..2 give it back.
                Some(_) => vpath::md_ext_case(self.name(id)) << 1,
                None => 0,
            };
            out.push(k);
        }
        out.extend_from_slice(names.as_bytes());
        debug_assert_eq!(out.len(), 36 + 14 * n + m);
        out
    }

    /* ── the search seam (§4.2) ───────────────────────────────────────────── */

    /// Build a `VaultSnapshot`: every `.md` in the vault, in the SAME preorder
    /// DFS the blob is emitted from, with directories OMITTED.  One pass using
    /// `rel_path_into` on a reusable `String` — measured 150 ns/path, ~0.8 ms
    /// for 5,000 notes, ~440 KB resident.
    ///
    /// This is a FILES-ONLY index space and it is NOT the blob's node index
    /// space.  Nothing may convert between them by arithmetic (X14).
    #[must_use]
    pub fn build_snapshot(&self) -> VaultSnapshot {
        let mut files: Vec<NoteEntry> = Vec::with_capacity(self.n_notes as usize);
        let mut buf = String::with_capacity(256);
        let mut stack: Vec<NodeId> = self.children(ROOT).iter().rev().copied().collect();
        while let Some(id) = stack.pop() {
            let Some(node) = self.get(id) else { continue };
            if node.is_dir() {
                stack.extend(self.children(id).iter().rev().copied());
                continue;
            }
            self.rel_path_into(id, &mut buf);
            let (name_start, name_len) = vpath::basename_span(&buf);
            files.push(NoteEntry {
                rel: buf.as_str().into(),
                name_start,
                name_len,
                size: 0,
                mtime_ms: i64::from(node.mtime) * 1000,
            });
        }
        VaultSnapshot { root: self.root_path.clone(), files, epoch: self.epoch }
    }
}

fn node_key<'a>(nodes: &[Node], names: &'a str, id: NodeId) -> (&'a str, bool, u32) {
    let Some(n) = nodes.get(id as usize) else { return ("", false, 0) };
    let s = n.name_off as usize;
    let e = s + n.name_len as usize;
    (names.get(s..e).unwrap_or(""), n.is_dir(), n.mtime)
}

/* ── the blob's constants, in one place ───────────────────────────────────── */

/// `"NTB1"` little-endian.
pub const MAGIC: u32 = 0x3142_544E;
pub const VERSION: u32 = 1;
/// header `flags` bit 0 — the 50,000-node cap (§3.3).
pub const FLAG_TRUNCATED_NODES: u32 = 1 << 0;
/// header `flags` bit 1 — the 255-depth cap (§3.3).  ITS OWN BIT.
pub const FLAG_TRUNCATED_DEPTH: u32 = 1 << 1;
/// `kind` bit 0 — a directory.
pub const KIND_DIR: u8 = 1 << 0;
/// `kind` bit 1 — a file whose extension's `m` is `M` on disk.
pub const KIND_EXT_UPPER_M: u8 = 1 << 1;
/// `kind` bit 2 — a file whose extension's `d` is `D` on disk.  Bits 3..7 are
/// reserved and zero; a folder never sets 1..2.
pub const KIND_EXT_UPPER_D: u8 = 1 << 2;

/* ── the vault-path seam (§4.2) ───────────────────────────────────────────── */

pub struct VaultSnapshot {
    /// absolute, no trailing separator
    pub root: PathBuf,
    /// Every `.md` in the vault, in the SAME preorder DFS traversal the blob is
    /// emitted from, with directories OMITTED.  FILES-ONLY index space (X14).
    pub files: Vec<NoteEntry>,
    /// the generation this snapshot was built from
    pub epoch: u64,
}

pub struct NoteEntry {
    /// vault-relative, `/`-separated, always ends `.md`
    pub rel: Box<str>,
    /// byte offset of the basename inside `rel`
    pub name_start: u32,
    /// byte length of the basename WITHOUT `.md`
    pub name_len: u32,
    /// **ALWAYS 0 — "unknown", never "empty".**  `Node` has no size field and
    /// cannot grow one: gate G1 pins it at 24 bytes.  CONTRACT §4.2 costs the
    /// snapshot build as "one pass over the arena using `rel_path_into`", i.e.
    /// NO I/O, so filling this in would mean 5,000 `stat`s the measurement does
    /// not carry.  §4.5's `MAX_SCAN_BYTES` must therefore be enforced by the
    /// SEARCHER at read time, from the length it already has in hand — a
    /// consumer that reads this field as a size will treat every note in the
    /// vault as empty.
    pub size: u32,
    /// Whole SECONDS from `Node.mtime`, scaled to milliseconds.  Sub-second
    /// precision is not in the arena (§4.2's `Node` is 24 bytes) and the wire
    /// unit is milliseconds (§1.1), so this is exact to 1,000 ms and no finer.
    pub mtime_ms: i64,
}

impl NoteEntry {
    /// The basename without `.md`, which is what the filename matcher scores.
    #[must_use]
    pub fn name(&self) -> &str {
        let s = self.name_start as usize;
        let e = s + self.name_len as usize;
        self.rel.get(s..e).unwrap_or("")
    }
}

/// The tree plus the lazily-built, generation-invalidated snapshot cache.
pub struct Vault {
    tree: RwLock<VaultTree>,
    /// Interior mutability on purpose: `snapshot()` is a READ operation and must
    /// not need the write lock.  Holds (epoch_it_was_built_from, the published
    /// `Arc`).
    snap_cache: Mutex<Option<(u64, Arc<VaultSnapshot>)>>,
    /// The secret-note set's memo: rel -> (mtime_ms it was classified at, verdict).
    /// Keyed by mtime so the steady state costs no I/O at all — only files
    /// whose mtime moved since the last call are opened, and then for 4 KiB.
    /// Stale entries (deleted or renamed paths) are dropped on every call by
    /// rebuilding the map from the current snapshot.  Same-second rewrites
    /// keep their old verdict until the mtime moves: `Node.mtime` has no
    /// finer grain, and the mark is INDICATIVE — the viewer and the search
    /// exclusion re-detect on every open and every scan, so nothing secret
    /// ever depends on this cache being fresh.
    secrets_cache: Mutex<HashMap<Box<str>, (i64, bool)>>,
}

impl Vault {
    #[must_use]
    pub fn new(tree: VaultTree) -> Self {
        Self {
            tree: RwLock::new(tree),
            snap_cache: Mutex::new(None),
            secrets_cache: Mutex::new(HashMap::new()),
        }
    }

    /// Lock poisoning is recovered from rather than propagated: a poisoned lock
    /// means some other task panicked, and `panic = "unwind"` (§6.2) exists
    /// precisely so that the window stays up and the user's unsaved text stays
    /// savable.  Turning that into a second panic here would be the abort
    /// behaviour the manifest rejected.
    pub fn read(&self) -> RwLockReadGuard<'_, VaultTree> {
        self.tree.read().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub fn write(&self) -> RwLockWriteGuard<'_, VaultTree> {
        self.tree.write().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    #[must_use]
    pub fn root(&self) -> PathBuf {
        self.read().root_path.clone()
    }

    /// CONTRACT §4.2's lifetime rule, normative:
    ///  - the returned `Arc` is IMMUTABLE; nothing ever mutates a
    ///    `VaultSnapshot` behind an `Arc`;
    ///  - a mutation does NOT rebuild it and does NOT invalidate it eagerly — it
    ///    only bumps `epoch`;
    ///  - the next call whose `epoch` differs REPLACES the cache entry with a
    ///    freshly built `Arc`.  The old `Arc` stays alive exactly as long as its
    ///    last holder, so an in-flight search's paths can never dangle and can
    ///    never be rewritten under it;
    ///  - cost at rest, if search was never used this session: ZERO.
    #[must_use]
    pub fn snapshot(&self) -> Arc<VaultSnapshot> {
        let tree = self.read();
        let epoch = tree.epoch;
        let mut cache = self.snap_cache.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some((built_at, snap)) = cache.as_ref() {
            if *built_at == epoch {
                return Arc::clone(snap);
            }
        }
        let fresh = Arc::new(tree.build_snapshot());
        *cache = Some((epoch, Arc::clone(&fresh)));
        fresh
    }

    /// The vault-relative rels of every secret note (`cairn-type: secrets`
    /// frontmatter), in snapshot order.  Feeds the tree's row mark; the
    /// viewer and the search exclusion detect independently.
    ///
    /// Cost is one `HashMap` lookup per file plus a 4 KiB head read for
    /// files whose mtime moved — the scan itself is untouched (G3/G4), the
    /// blob is untouched (no frame change), and `Node` is untouched (G1).
    /// A file that cannot be opened classifies as ordinary and is NOT
    /// cached, so a transient failure retries on the next call instead of
    /// sticking.
    #[must_use]
    pub fn secret_notes(&self) -> Vec<String> {
        let snap = self.snapshot();
        let mut cache = self
            .secrets_cache
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // Rebuilt (not retained) so deleted and renamed paths fall out here.
        let mut next: HashMap<Box<str>, (i64, bool)> = HashMap::with_capacity(snap.files.len());
        let mut out: Vec<String> = Vec::new();
        for f in &snap.files {
            let rel: &str = &f.rel;
            if let Some((at, secret)) = cache.remove(rel) {
                if at == f.mtime_ms {
                    if secret {
                        out.push(rel.to_string());
                    }
                    next.insert(f.rel.clone(), (at, secret));
                    continue;
                }
            }
            let secret = match read_head_is_secret(&snap.root, rel) {
                Some(secret) => secret,
                // Unopenable (deleted mid-scan): ordinary, and uncached so a
                // transient failure retries on the next call instead of
                // sticking.
                None => continue,
            };
            if secret {
                out.push(rel.to_string());
            }
            next.insert(f.rel.clone(), (f.mtime_ms, secret));
        }
        *cache = next;
        out
    }
}

/// Open `rel` under `root` and classify its head.  Returns `None` when the
/// file cannot be opened at all (deleted mid-scan: the caller treats it as
/// ordinary and does not cache the verdict).
fn read_head_is_secret(root: &Path, rel: &str) -> Option<bool> {
    use std::os::unix::fs::OpenOptionsExt;
    // The snapshot can be one refresh behind the disk, and a path it lists may
    // now be a FIFO: a blocking open would park this thread, and the
    // `secrets_cache` lock every later caller waits on, until a writer
    // appears.  O_NONBLOCK does nothing to a regular file's reads.
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(root.join(rel))
        .ok()?;
    if !file.metadata().ok()?.is_file() {
        return None;
    }
    crate::search::read_secret_verdict(&mut file)
}

/// CONTRACT §4.3 (M30), the vault-switch order, which is a DATA-LOSS RULE.  The
/// old vault is taken OUT of the slot and dropped OUTSIDE the lock, so tearing
/// down a 5,000-node arena does not hold every reader out.
///
/// spec-06 §6.6's "`*guard = None;` … Never build-then-swap" is STRUCK and is a
/// DEADLOCK: dropping a `Vault` joins the watcher thread, and the watcher thread
/// takes the vault write lock.
pub fn take_vault(slot: &RwLock<Option<Arc<Vault>>>) -> Option<Arc<Vault>> {
    let old = {
        let mut guard = slot.write().unwrap_or_else(std::sync::PoisonError::into_inner);
        guard.take()
    };
    old
}
