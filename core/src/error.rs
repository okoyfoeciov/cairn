//! core/src/error.rs — Owner: 02.
//! Spec: CONTRACT.md §1.5 (the normative `VaultError` union) and §1.1's casing
//! rule (X13).  The `io::ErrorKind` mapping is spec-02 §6.7, which the contract
//! deliberately leaves to this document.
//!
//! THE TWO SERDE ATTRIBUTES ARE BOTH REQUIRED AND THE SECOND IS EASY TO MISS.
//! `rename_all = "camelCase"` renames the VARIANTS; `rename_all_fields =
//! "camelCase"` renames the FIELDS, and it is what makes `disk_mtime_ms` arrive
//! as `diskMtimeMs`.  §1.1's casing rule has no exceptions: every struct or enum
//! that crosses the IPC is camelCase on the wire, errors included.
//!
//! `std::io::Error` is NEVER returned raw.  The frontend switches on `kind` and
//! MUST NOT parse `message`, which is OS-localised.
//!
//! TIMESTAMPS ARE `i64` MILLISECONDS (§1.1), NOT `f64`.  The scaffold declared
//! `Conflict.disk_mtime_ms` as an `f64`; §1.1 says "Timestamps crossing the
//! boundary are `i64` milliseconds since the Unix epoch", the note frame carries
//! an `i64` at offset 8, and the frontend echoes the value back as a decimal
//! string in `x-base-mtime`.  Three representations of one number is how a
//! conflict guard starts comparing `1.7e12` against `1700000000000`.  The wire
//! bytes are identical for every value this app can produce.

use serde::Serialize;

/// CONTRACT §1.5.  `disk_mtime_ms` serialises as `diskMtimeMs` — that is what
/// `rename_all_fields` is for, and it is the field the conflict bar reads.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum VaultError {
    NotFound { path: String },
    AlreadyExists { path: String },
    NotADirectory { path: String },
    NotUtf8 { path: String },
    TooLarge { path: String, bytes: u64, limit: u64 },
    InvalidName { name: String, reason: String },
    InvalidPath { path: String, reason: String },
    Conflict { path: String, disk_mtime_ms: i64 },
    TrashUnavailable { path: String, message: String },
    Io { path: String, code: i32, message: String },
}

impl VaultError {
    pub fn not_found(path: impl Into<String>) -> Self {
        VaultError::NotFound { path: path.into() }
    }

    pub fn already_exists(path: impl Into<String>) -> Self {
        VaultError::AlreadyExists { path: path.into() }
    }

    pub fn not_a_directory(path: impl Into<String>) -> Self {
        VaultError::NotADirectory { path: path.into() }
    }

    pub fn not_utf8(path: impl Into<String>) -> Self {
        VaultError::NotUtf8 { path: path.into() }
    }

    pub fn too_large(path: impl Into<String>, bytes: u64, limit: u64) -> Self {
        VaultError::TooLarge { path: path.into(), bytes, limit }
    }

    pub fn invalid_name(name: impl Into<String>, reason: impl Into<String>) -> Self {
        VaultError::InvalidName { name: name.into(), reason: reason.into() }
    }

    pub fn invalid_path(path: impl Into<String>, reason: impl Into<String>) -> Self {
        VaultError::InvalidPath { path: path.into(), reason: reason.into() }
    }

    pub fn conflict(path: impl Into<String>, disk_mtime_ms: i64) -> Self {
        VaultError::Conflict { path: path.into(), disk_mtime_ms }
    }

    pub fn trash_unavailable(path: impl Into<String>, message: impl Into<String>) -> Self {
        VaultError::TrashUnavailable { path: path.into(), message: message.into() }
    }

    /// ALWAYS `Io`, whatever the `ErrorKind`.  Use it where the OS error is
    /// about something other than the path the caller asked for — a temp file,
    /// a parent directory, an `fsync` — so that an `ENOENT` on OUR scratch file
    /// can never be reported as "your note is missing".
    pub fn io(path: impl Into<String>, e: &std::io::Error) -> Self {
        VaultError::Io {
            path: path.into(),
            code: e.raw_os_error().unwrap_or(0),
            message: e.to_string(),
        }
    }

    /// spec-02 §6.7's mapping, and it is only correct when `path` is the thing
    /// the OS call was about: `NotFound` -> `NotFound`, `AlreadyExists` ->
    /// `AlreadyExists`, everything else (`PermissionDenied` included) -> `Io`
    /// carrying the raw code.
    pub fn from_io(path: impl Into<String>, e: &std::io::Error) -> Self {
        match e.kind() {
            std::io::ErrorKind::NotFound => VaultError::NotFound { path: path.into() },
            std::io::ErrorKind::AlreadyExists => VaultError::AlreadyExists { path: path.into() },
            _ => VaultError::io(path, e),
        }
    }

    /// The stable discriminant the frontend switches on, and the string
    /// `confirm_close(false, reason)` carries in §1.6's handshake.  Kept beside
    /// the serde attributes so the two cannot drift.
    pub fn kind(&self) -> &'static str {
        match self {
            VaultError::NotFound { .. } => "notFound",
            VaultError::AlreadyExists { .. } => "alreadyExists",
            VaultError::NotADirectory { .. } => "notADirectory",
            VaultError::NotUtf8 { .. } => "notUtf8",
            VaultError::TooLarge { .. } => "tooLarge",
            VaultError::InvalidName { .. } => "invalidName",
            VaultError::InvalidPath { .. } => "invalidPath",
            VaultError::Conflict { .. } => "conflict",
            VaultError::TrashUnavailable { .. } => "trashUnavailable",
            VaultError::Io { .. } => "io",
        }
    }
}

/// One line each, written for a person.  The frontend has its own copy deck for
/// the two errors that get a bar (§7.3 cases 5 and 7) and for `tooLarge`
/// (§7.3 case 15); these are the fallback and the log line.
impl std::fmt::Display for VaultError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            VaultError::NotFound { path } => write!(f, "\u{201c}{path}\u{201d} no longer exists."),
            VaultError::AlreadyExists { path } => {
                write!(f, "\u{201c}{path}\u{201d} already exists.")
            }
            VaultError::NotADirectory { path } => {
                write!(f, "\u{201c}{path}\u{201d} is not a folder.")
            }
            VaultError::NotUtf8 { path } => write!(
                f,
                "\u{201c}{path}\u{201d} is not valid UTF-8 text, so it cannot be opened without \
                 changing its bytes."
            ),
            // §7.3 case 15's copy shape, with §7.1's number.  MiB, because the
            // limit is 8 MiB and rounding it to "8 MB" in an error about a size
            // is how a 8,000,000-byte note becomes an unexplained refusal.
            VaultError::TooLarge { path, bytes, limit } => write!(
                f,
                "\u{201c}{path}\u{201d} is {} \u{2014} too large to open (the limit is {}).",
                human_bytes(*bytes),
                human_bytes(*limit)
            ),
            VaultError::InvalidName { name, reason } => {
                write!(f, "\u{201c}{name}\u{201d} is not a usable name: {reason}.")
            }
            VaultError::InvalidPath { path, reason } => {
                write!(f, "\u{201c}{path}\u{201d} is not a usable path: {reason}.")
            }
            VaultError::Conflict { path, .. } => write!(
                f,
                "\u{201c}{path}\u{201d} was changed by another application since it was opened."
            ),
            VaultError::TrashUnavailable { path, message } => write!(
                f,
                "\u{201c}{path}\u{201d} could not be moved to the Trash: {message}"
            ),
            VaultError::Io { path, message, .. } if path.is_empty() => f.write_str(message),
            VaultError::Io { path, message, .. } => write!(f, "\u{201c}{path}\u{201d}: {message}"),
        }
    }
}

impl std::error::Error for VaultError {}

/// Binary units, because every number this app refuses is a binary limit.
fn human_bytes(n: u64) -> String {
    const KIB: u64 = 1024;
    const MIB: u64 = 1024 * KIB;
    if n >= MIB {
        let whole = n / MIB;
        let tenths = (n % MIB) * 10 / MIB;
        if tenths == 0 { format!("{whole} MB") } else { format!("{whole}.{tenths} MB") }
    } else if n >= KIB {
        format!("{} KB", n / KIB)
    } else {
        format!("{n} bytes")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// X13.  The one thing a frontend `switch (e.kind)` cannot survive is a
    /// snake_case field, and `rename_all_fields` is the attribute people forget.
    #[test]
    fn wire_shape_is_camel_case() {
        let j = serde_json::to_string(&VaultError::conflict("A/b.md", 1_700_000_000_123)).unwrap();
        assert_eq!(j, r#"{"kind":"conflict","path":"A/b.md","diskMtimeMs":1700000000123}"#);

        let j = serde_json::to_string(&VaultError::too_large("big.md", 9_000_000, 8_388_608)).unwrap();
        assert_eq!(j, r#"{"kind":"tooLarge","path":"big.md","bytes":9000000,"limit":8388608}"#);

        let j = serde_json::to_string(&VaultError::NotADirectory { path: "x".into() }).unwrap();
        assert!(j.starts_with(r#"{"kind":"notADirectory""#), "{j}");
    }

    /// An i64 millisecond epoch must serialise as an INTEGER.  An `f64` here
    /// emits `1700000000123.0`, which `String(x)` on the JS side turns back into
    /// `"1700000000123"` only by luck of double precision.
    #[test]
    fn mtimes_are_integers_on_the_wire() {
        let j = serde_json::to_string(&VaultError::conflict("a", 1_700_000_000_123)).unwrap();
        assert!(j.contains("1700000000123"), "{j}");
        assert!(!j.contains('.'), "{j}");
    }

    /// `kind()` and the serde tag are two hand-written lists of the same ten
    /// strings.  This is the test that stops them drifting.
    #[test]
    fn kind_matches_the_serde_tag() {
        let all = [
            VaultError::not_found("p"),
            VaultError::already_exists("p"),
            VaultError::not_a_directory("p"),
            VaultError::not_utf8("p"),
            VaultError::too_large("p", 1, 2),
            VaultError::invalid_name("n", "r"),
            VaultError::invalid_path("p", "r"),
            VaultError::conflict("p", 1),
            VaultError::trash_unavailable("p", "m"),
            VaultError::io("p", &std::io::Error::other("m")),
        ];
        for e in &all {
            let v: serde_json::Value = serde_json::to_value(e).unwrap();
            assert_eq!(v["kind"].as_str().unwrap(), e.kind(), "{v}");
        }
    }

    /// `from_io` maps only the two kinds spec-02 §6.7 names; everything else
    /// stays `Io` and keeps its raw code, because the frontend branches on kind
    /// and a mis-mapped `EACCES` would render as "no longer exists".
    #[test]
    fn io_mapping_is_spec_02_6_7() {
        use std::io::{Error, ErrorKind};
        assert_eq!(VaultError::from_io("p", &Error::from(ErrorKind::NotFound)).kind(), "notFound");
        assert_eq!(
            VaultError::from_io("p", &Error::from(ErrorKind::AlreadyExists)).kind(),
            "alreadyExists"
        );
        assert_eq!(
            VaultError::from_io("p", &Error::from(ErrorKind::PermissionDenied)).kind(),
            "io"
        );
        // `io()` never maps, even for the two kinds `from_io` does.
        assert_eq!(VaultError::io("p", &Error::from(ErrorKind::NotFound)).kind(), "io");
        match VaultError::io("p", &Error::from_raw_os_error(13)) {
            VaultError::Io { code, .. } => assert_eq!(code, 13),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn display_is_a_sentence_not_a_debug_dump() {
        let s = VaultError::not_found("Notes/Misc.md").to_string();
        assert!(s.contains("Notes/Misc.md"), "{s}");
        assert!(!s.contains("NotFound"), "{s}");
        let s = VaultError::too_large("big.md", 49_283_072, 8 * 1024 * 1024).to_string();
        assert!(s.contains("47 MB") && s.contains("8 MB"), "{s}");
    }
}
