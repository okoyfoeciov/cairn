//! core/src/scan.rs — Owner: 02.
//! Spec: CONTRACT.md §3.3 (the two caps, M38), §3.6 (what the tree contains),
//! §7.3 case 1 (the PID-aware temp sweep, M67), §7.3 case 12 (symlinks),
//! spec-02 §4.6, M37, gates G2 and G3.
//!
//! IT IS A HAND-ROLLED QUEUE WALK (M37).  No `walkdir`, no `ignore`, and NO
//! INDEX PHASE — spec-06 §8.2's Phase 1 and Phase 2 and its `scan_vault` are
//! STRUCK.  Gate G3 is <= 50 ms cold over the 5,000-note fixture (measured
//! 40 ms, 1.25x margin); gate G2 is <= 768 KiB of arena (measured 448 KiB).
//!
//! BOTH CAPS LIVE HERE AND BOTH ARE SIGNALLED IN THE BLOB HEADER (M38):
//!   nodes, 50,000  -> header `flags` bit 0; the walk STOPS DESCENDING.
//!   depth, 255     -> header `flags` bit 1; the subtree is not descended into.
//! Depth truncation gets ITS OWN BIT — overloading `nc://watch-degraded` for it
//! is STRUCK, because a degraded watcher and a too-deep folder are different
//! facts with different remedies and different banners (§3.3).
//!
//! CLIPPY DENY LIST (§6.2, gate G7) applies to this module.
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::VaultError;
use crate::fsops;
use crate::path as vpath;
use crate::tree::{NodeId, SortMode, VaultTree, ROOT};

/// CONTRACT §3.3 (M38).
pub const MAX_NODES: usize = 50_000;
/// CONTRACT §3.3 (M38).
pub const MAX_DEPTH: u8 = 255;

/// spec-02 §4.6.  `sweep` is the list of crash-debris candidates found while the
/// directories were already being read — collecting them costs nothing because
/// every entry is being looked at anyway.
pub struct ScanResult {
    pub tree: VaultTree,
    pub sweep: Vec<PathBuf>,
}

/// Walk `root` into a fresh arena.  Blocking; runs on the vault-walker thread,
/// never on the main thread and never on a tokio worker.
///
/// Normative rules, all from spec-02 §4.6:
///  1. iterative, breadth-first, explicit queue.  No recursion — a pathological
///     deeply-nested tree must not blow the stack.
///  2. pre-reserve `nodes`/`kids`/`names` (`VaultTree::new`).
///  3. skip rules per `DirEntry`, IN THIS ORDER: symlink, non-UTF-8, leading
///     `.`, and non-`.md` non-directory.  Empty folders ARE kept.
///  4. the two caps.
///  5. `stat` eagerly — `DirEntry::metadata()` costs a measured +6 ms over the
///     whole 5,000-note walk, and a lazy-stat state machine to save that is not
///     worth the branch in every sort path.
///  6. sort each directory's children once, as it is read; there is no second
///     pass.
///  7. collect the temp-file sweep candidates.
pub fn walk_vault(root: &Path, sort: SortMode, epoch: u64) -> Result<ScanResult, VaultError> {
    let root_display = root.display().to_string();
    let meta = fs::metadata(root).map_err(|e| VaultError::from_io(root_display.clone(), &e))?;
    if !meta.is_dir() {
        return Err(VaultError::not_a_directory(root_display));
    }

    let mut tree = VaultTree::new(root.to_path_buf(), sort, epoch);
    let mut sweep: Vec<PathBuf> = Vec::new();

    // BFS.  `head` walks the queue rather than draining from the front, so the
    // queue is one allocation and never memmoves.
    let mut queue: Vec<(NodeId, PathBuf)> = Vec::with_capacity(1024);
    queue.push((ROOT, root.to_path_buf()));
    let mut head = 0usize;
    let mut entries: Vec<(String, bool, u32)> = Vec::with_capacity(64);

    while head < queue.len() {
        let Some((dir_id, dir_path)) = queue.get(head).map(|(a, b)| (*a, b.clone())) else { break };
        head += 1;

        // §3.3: the node cap stops the walk DESCENDING; the tree already read is
        // kept and the banner says so.
        if tree.node_count() >= MAX_NODES {
            tree.truncated_nodes = true;
            break;
        }

        let dir_depth = tree.get(dir_id).map_or(0, |n| n.depth);

        let rd = match fs::read_dir(&dir_path) {
            Ok(rd) => rd,
            Err(e) => {
                // The vault root failing is fatal; one unreadable subdirectory is
                // not — the user still gets the other 4,999 notes.
                if dir_id == ROOT {
                    return Err(VaultError::from_io(root_display, &e));
                }
                continue;
            }
        };

        entries.clear();
        for entry in rd.flatten() {
            let Ok(ft) = entry.file_type() else { continue };
            // §7.3 case 12: `file_type()` on Unix reads `d_type` and does NOT
            // follow, so a symlinked directory reports `is_symlink() == true`
            // and `is_dir() == false`.  Loops are structurally impossible and
            // nothing in the arena can name a path outside the root.
            if ft.is_symlink() {
                continue;
            }
            let raw = entry.file_name();
            let Some(name) = raw.to_str() else { continue };
            if name.starts_with('.') {
                // §7.3 case 1 / M67: we are already reading every entry, so
                // recognising our own crash debris here is free.
                if fsops::parse_temp_pid(name).is_some() {
                    sweep.push(dir_path.join(name));
                }
                // One rule covers `.obsidian`, `.git`, `.trash`, `.DS_Store` and
                // our own in-flight temp files (§3.6).
                continue;
            }
            let is_dir = ft.is_dir();
            // A note is a REGULAR file.  A FIFO, socket or device named
            // `*.md` is not one, and opening a FIFO to read it blocks until a
            // writer appears — a worker parked for good per attempt.
            if !is_dir && !(ft.is_file() && vpath::is_md(name)) {
                continue;
            }
            let mtime = entry.metadata().ok().and_then(|m| m.modified().ok()).map_or(0, unix_secs);
            entries.push((name.to_string(), is_dir, mtime));
        }

        if entries.is_empty() {
            continue;
        }

        // §3.3, depth: a directory AT the cap is not descended into, because its
        // children would be at depth 256 and `Node.depth` is a u8.  The flag is
        // raised HERE — after the directory has been read — and not before, so
        // that an EMPTY folder sitting at depth 255 does not light a banner
        // saying content was hidden when none was.  The folder's own row is
        // already in the tree; only its contents are missing.
        if dir_depth == MAX_DEPTH {
            tree.truncated_depth = true;
            continue;
        }

        // §3.3 again, at the point where nodes are actually created: never emit
        // more than the cap, and say so in the header.
        let room = MAX_NODES.saturating_sub(tree.node_count());
        if entries.len() > room {
            entries.truncate(room);
            tree.truncated_nodes = true;
        }

        let (off, len) = tree.add_children(dir_id, &mut entries);
        for k in 0..len as usize {
            let Some(&child) = tree.kids.get(off as usize + k) else { continue };
            if tree.get(child).is_some_and(crate::tree::Node::is_dir) {
                queue.push((child, dir_path.join(tree.name(child))));
            }
        }
    }

    Ok(ScanResult { tree, sweep })
}

/// CONTRACT §7.3 case 1, amended by M67 — the sweep, applied to the candidates
/// the walk collected for free.
///
/// The RULE is `fsops::should_sweep`, and it lives there rather than here on
/// purpose: it is the inverse of `fsops::temp_path`, which is the only producer
/// of these names, and a predicate that drifted from its producer would either
/// unlink a live instance's in-flight write or leave crash debris behind.  This
/// function owns only the pairing — walk collects, sweep unlinks — because
/// re-walking the vault to find files we have already seen is the one thing
/// spec-02 §4.6-7 rules out.
///
/// Returns the number of files unlinked.
pub fn sweep_temps(candidates: &[PathBuf]) -> usize {
    candidates.iter().filter(|p| fsops::sweep_temp(p)).count()
}

/// spec-02 §4.6-5: `SystemTime` -> `duration_since(UNIX_EPOCH)` -> `as_secs()
/// as u32`, saturating.  Failure stores 0, which sorts last in `MtimeDesc` and
/// first in `MtimeAsc` — a stat that did not happen is not a timestamp.
fn unix_secs(t: SystemTime) -> u32 {
    t.duration_since(UNIX_EPOCH).map_or(0, |d| u32::try_from(d.as_secs()).unwrap_or(u32::MAX))
}
