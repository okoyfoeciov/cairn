//! core/src/path.rs — Owner: 02.
//! Spec: CONTRACT.md §7.3 case 11 (invalid names), §7.3 case 12/13 (the
//! traversal guarantee), §3.2 (display names), M52, and §6.4's struck
//! normalisation clause.
//!
//! TWO VALIDATORS, AND THEY ARE DIFFERENT FUNCTIONS (M52):
//!   - `validate_name(..)`           — create and rename targets.  Strict.
//!   - `validate_rel_for_lookup(..)` — resolution.  Rejects SIX things and
//!     nothing else, because a name that must be REJECTED on creation
//!     (`Archive `, `v1.`) may still have to be RESOLVED if it already exists on
//!     disk.  spec-02 §5.2's single `validate_rel` made such notes VISIBLE BUT
//!     PERMANENTLY UNOPENABLE and is STRUCK.
//!
//! Nothing is weakened by the split: the traversal guarantee comes from
//! `VaultTree::resolve` walking the arena (tree.rs), not from the character
//! rules.  `fs::canonicalize` is deliberately not used as a check — a syscall
//! per validation and a TOCTOU race.
//!
//! NFC/NFD NORMALISATION IS STRUCK (§6.4, M41).  It is a RECORDED LIMITATION,
//! not a feature, and it must not be quietly added back: normalising a path
//! changes which file on disk a name refers to, which is a data-loss class of
//! change, not a tidying-up.  `tests/path_safety.rs` asserts the LIMITATION.

use crate::error::VaultError;

/// §7.3 case 11: "longer than 255 UTF-8 bytes".  Bytes, not chars.
pub const MAX_NAME_BYTES: usize = 255;
/// §7.3 case 11: `validate_rel_for_lookup` rejects "more than 255 components".
pub const MAX_COMPONENTS: usize = 255;

/// §7.3 case 11's nine reserved characters.  `/` is here as well as being a
/// separator: a "name" containing one is a two-component path, never a name.
const RESERVED: [char; 9] = ['\\', '/', ':', '*', '?', '"', '<', '>', '|'];

/// The Windows device names, matched case-insensitively and with or without an
/// extension: `CON.md` and `nul.txt` are refused, `CONTRACT.md`, `COMET.md`,
/// `NULL.md` and `LPT10.md` are not.  The stem is everything before the FIRST
/// `.`, which is what Windows itself reserves.
const DEVICE_NAMES: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

fn bad_name(name: &str, reason: &str) -> VaultError {
    VaultError::invalid_name(name, reason)
}

fn bad_path(rel: &str, reason: &str) -> VaultError {
    VaultError::invalid_path(rel, reason)
}

/// CONTRACT §7.3 case 11, `validate_name` row — **creation and rename targets
/// only**.  Deliberately stricter than either OS's own minimum, because vaults
/// get synced onto Windows: this app never creates a file another machine
/// holding the same vault cannot check out.
///
/// Rejects: `\ / : * ? " < > |` and U+0000–U+001F; empty or whitespace-only;
/// `.` or `..`; leading/trailing space; trailing `.`; the Windows device names
/// `CON PRN AUX NUL COM1..9 LPT1..9` with or without an extension; longer than
/// 255 UTF-8 bytes.
pub fn validate_name(name: &str) -> Result<(), VaultError> {
    if name.is_empty() {
        return Err(bad_name(name, "a name cannot be empty"));
    }
    if name.len() > MAX_NAME_BYTES {
        return Err(bad_name(name, "a name cannot be longer than 255 bytes"));
    }
    for c in name.chars() {
        if RESERVED.contains(&c) {
            return Err(bad_name(name, "a name cannot contain \\ / : * ? \" < > or |"));
        }
        if (c as u32) < 0x20 {
            return Err(bad_name(name, "a name cannot contain control characters"));
        }
    }
    if name.trim().is_empty() {
        return Err(bad_name(name, "a name cannot be only whitespace"));
    }
    if name == "." || name == ".." {
        return Err(bad_name(name, "\".\" and \"..\" are not names"));
    }
    if name.starts_with(' ') || name.ends_with(' ') {
        return Err(bad_name(name, "a name cannot start or end with a space"));
    }
    if name.ends_with('.') {
        return Err(bad_name(name, "a name cannot end with a period"));
    }
    let stem = name.split('.').next().unwrap_or(name);
    if DEVICE_NAMES.iter().any(|d| d.eq_ignore_ascii_case(stem)) {
        return Err(bad_name(name, "this name is reserved on Windows"));
    }
    Ok(())
}

/// CONTRACT §7.3 case 11, `validate_rel_for_lookup` row — **every path arriving
/// over IPC for resolution**.
///
/// Rejects **only**: NUL, a leading or trailing `/`, any empty component, any
/// `.` or `..` component, more than 255 components.  Nothing else.  `""` is the
/// vault root and is valid (§1.1).
///
/// Anything else this function refused would be a note the user can SEE in the
/// tree and cannot open — that is the whole of M52.
pub fn validate_rel_for_lookup(rel: &str) -> Result<(), VaultError> {
    if rel.is_empty() {
        return Ok(()); // the vault root
    }
    if rel.contains('\0') {
        return Err(bad_path(rel, "a path cannot contain a NUL byte"));
    }
    if rel.starts_with('/') {
        return Err(bad_path(rel, "a path must be vault-relative, not absolute"));
    }
    if rel.ends_with('/') {
        return Err(bad_path(rel, "a path cannot end with a separator"));
    }
    let mut n = 0usize;
    for comp in rel.split('/') {
        n += 1;
        if n > MAX_COMPONENTS {
            return Err(bad_path(rel, "a path cannot have more than 255 components"));
        }
        if comp.is_empty() {
            return Err(bad_path(rel, "a path cannot contain an empty component"));
        }
        if comp == "." || comp == ".." {
            return Err(bad_path(rel, "\".\" and \"..\" are not allowed in a path"));
        }
    }
    Ok(())
}

/* ── small pure helpers on vault-relative paths ───────────────────────────── */

/// CONTRACT §3.6: the tree contains directories and files whose name ends
/// `.md`, ASCII case-insensitively.
#[must_use]
pub fn is_md(name: &str) -> bool {
    name.len() > 3 && name.get(name.len() - 3..).is_some_and(|e| e.eq_ignore_ascii_case(".md"))
}

/// CONTRACT §3.2: `names` holds **display** names — a file's trailing `.md` is
/// stripped by Rust, a folder's name is untouched.  The real filename is
/// `display` plus the extension in its on-disk case for files (`md_ext_case`
/// carries that case in the blob's `kind`), and `display` for folders.
#[must_use]
pub fn display_name(name: &str, is_dir: bool) -> &str {
    if is_dir || !is_md(name) {
        return name;
    }
    name.get(..name.len() - 3).unwrap_or(name)
}

/// The case of a note's `.md` as two bits: bit 0 when the `m` is `M`, bit 1
/// when the `d` is `D`; 0 for `.md` and for a name that is not a note.
/// `display_name` strips the extension whatever its case, so without these
/// bits `Foo.MD` would be rebuilt as `Foo.md` — a different file, or none.
#[must_use]
pub fn md_ext_case(name: &str) -> u8 {
    if !is_md(name) {
        return 0;
    }
    let b = name.as_bytes();
    let n = b.len();
    u8::from(b.get(n - 2) == Some(&b'M')) | (u8::from(b.get(n - 1) == Some(&b'D')) << 1)
}

/// Byte offset of the basename inside a vault-relative path, and its length
/// with `.md` removed — CONTRACT §4.2's `NoteEntry.name_start` / `name_len`.
#[must_use]
pub fn basename_span(rel: &str) -> (u32, u32) {
    let start = rel.rfind('/').map_or(0, |i| i + 1);
    let base = rel.get(start..).unwrap_or("");
    let len = display_name(base, false).len();
    (start as u32, len as u32)
}

/* ── the temp-name helper lives in `fsops.rs`, not here ──────────────────── */
//
// CONTRACT §7.1 rule 2 step 3 calls it "the ONE temp-name helper; every temp
// file in the app comes from it".  It is `fsops::temp_path` /
// `fsops::parse_temp_pid`, beside the atomic write sequence that is its only
// producer.  A second copy in this module would be a second place for the
// leading dot, the `.tmp-` infix or the embedded PID to drift, and all three are
// load-bearing (§3.6's dotfile skip, the sweep's pattern, M67's unlink-on-sight).
// `scan.rs` collects sweep candidates with `fsops::parse_temp_pid`.
