//! Gate G-RT's missing half: the FRAME SOURCE for the JS decoder suite.
//!
//! Spec: CONTRACT §2.1 (the frame), §2.2 (the layout lives in exactly two
//! places), §2.4 (the round-trip invariant, the seven cases, and gate G-RT).
//!
//! # Why this file exists
//!
//! `tests/frontend/note_frame.test.mjs` is written so that it may NOT restate
//! the frame's byte offsets — §2.2 allows the layout to exist in exactly two
//! files and a test is not one of them. It therefore takes its *valid* frames
//! from a fixture directory named by `CAIRN_FRAME_FIXTURES`, which is §2.4
//! T2.5's own arrangement: Rust encodes, JS decodes.
//!
//! Nothing in this repository ever wrote that directory. The consequence was
//! silent and total: `NO_FIXTURES` was always true, so **gate G-RT and T2.4
//! reported as TODO on every run and had never once executed** — while the
//! skip reason blamed `core/src/note_frame.rs` for being "a stub", which
//! it has not been for some time (it is 624 lines and fully implemented). A
//! green suite was reporting a gate that was not running.
//!
//! This test closes that seam from the Rust side. It is the ONLY producer of
//! valid frames for the JS suite, which keeps §2.2 intact: the offsets stay in
//! `note_frame.rs`, and the JS suite still never learns them.
//!
//! # What it asserts on its own account
//!
//! Emitting is not the whole job — a generator that writes whatever the code
//! currently does would launder a regression into a "fixture update". So each
//! case is also checked here, in Rust, against §2.4's invariant directly:
//! `denormalise(normalise(raw)) == raw`, byte for byte, BOM and CRLF included.
//! All seven §2.4 cases have uniform line endings, so the §2.4.1 mixed-EOL
//! exception does not apply to any of them and the unqualified invariant is
//! the right one to assert.

use std::fs;
use std::path::PathBuf;

use cairn_lib::note_frame::{self, FLAG_BOM, FLAG_CRLF, NOTE_HEADER};

const BOM: &[u8] = &[0xEF, 0xBB, 0xBF];

/// Where the fixtures land. `CAIRN_FRAME_FIXTURE_OUT` overrides, so a caller
/// can stage them somewhere disposable; the default is the path `npm test`
/// points `CAIRN_FRAME_FIXTURES` at.
fn out_dir() -> PathBuf {
    if let Ok(p) = std::env::var("CAIRN_FRAME_FIXTURE_OUT") {
        return PathBuf::from(p);
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("tests")
        .join("fixtures")
        .join("frames")
}

/// §2.4's seven cases, verbatim from the contract's own list:
/// "LF, CRLF, BOM+LF, BOM+CRLF, BOM+CRLF+CJK+emoji, 200 KiB CJK, 1 MiB ASCII".
///
/// Each entry is `(name, raw file bytes as they sit on disk)`. The bytes are
/// built here rather than checked in, so the two large cases cost nothing in
/// the repository and cannot rot into a stale binary blob.
fn cases() -> Vec<(&'static str, Vec<u8>)> {
    let mut v: Vec<(&'static str, Vec<u8>)> = Vec::new();

    v.push(("01-lf", b"# Meeting notes\n\n- ship it\n- then ship it again\n".to_vec()));
    v.push((
        "02-crlf",
        b"# Meeting notes\r\n\r\n- ship it\r\n- then ship it again\r\n".to_vec(),
    ));

    let mut bom_lf = BOM.to_vec();
    bom_lf.extend_from_slice(b"# BOM then LF\n\nplain ascii body\n");
    v.push(("03-bom-lf", bom_lf));

    let mut bom_crlf = BOM.to_vec();
    bom_crlf.extend_from_slice(b"# BOM then CRLF\r\n\r\nplain ascii body\r\n");
    v.push(("04-bom-crlf", bom_crlf));

    // BOM + CRLF + CJK + emoji: multi-byte sequences either side of the CRLFs,
    // which is what catches a normaliser that scans bytes without respecting
    // UTF-8 boundaries.
    let mut mixed = BOM.to_vec();
    mixed.extend_from_slice("# 会議のメモ 🚀\r\n\r\n- 出荷する ✅\r\n- 日本語とemoji😀が混ざる\r\n".as_bytes());
    v.push(("05-bom-crlf-cjk-emoji", mixed));

    // 200 KiB of CJK. Built by repetition to an exact byte target, cut on a
    // character boundary (the unit is 3 bytes of UTF-8, so the arithmetic is
    // exact and no partial code point can be produced).
    let unit = "日本語のテキスト"; // 8 chars x 3 bytes = 24 bytes
    assert_eq!(unit.len(), 24, "the 200 KiB case's size arithmetic assumes 24 bytes");
    let target = 200 * 1024;
    let mut cjk = String::with_capacity(target + unit.len());
    while cjk.len() + unit.len() < target {
        cjk.push_str(unit);
    }
    // Pad to the exact target with 1-BYTE characters. 200 KiB - 1 is not a
    // multiple of 3, so padding with further 3-byte CJK cannot land on it; a
    // 1-byte filler is the only way to hit the size exactly without splitting
    // a code point (which is the thing this case exists to not do).
    while cjk.len() < target - 1 {
        cjk.push('.');
    }
    cjk.push('\n');
    assert_eq!(cjk.len(), target, "the 200 KiB case must be exactly 200 KiB");
    v.push(("06-cjk-200kib", cjk.into_bytes()));

    // 1 MiB of ASCII, LF-terminated lines.
    let target = 1024 * 1024;
    let mut ascii = Vec::with_capacity(target);
    let line = b"the quick brown fox jumps over the lazy dog 0123456789\n";
    while ascii.len() + line.len() <= target {
        ascii.extend_from_slice(line);
    }
    while ascii.len() < target - 1 {
        ascii.push(b'x');
    }
    if ascii.len() < target {
        ascii.push(b'\n');
    }
    assert_eq!(ascii.len(), target, "the 1 MiB case must be exactly 1 MiB");
    v.push(("07-ascii-1mib", ascii));

    v
}

/// The generator, and §2.4's invariant asserted case by case.
#[test]
fn emit_frame_fixtures() {
    let dir = out_dir();
    fs::create_dir_all(&dir).expect("could not create the fixture directory");

    // A deterministic, realistic mtime: 2024-06-01T12:00:00Z. Fixed rather than
    // `now()` so a rebuild does not churn the fixtures, and non-zero so the
    // JS side's `Number.isSafeInteger(mtimeMs)` row is actually exercised.
    let mtime_ms: i64 = 1_717_243_200_000;

    let all = cases();
    assert_eq!(all.len(), 7, "§2.4 names seven cases");

    for (name, raw) in &all {
        let (text, flags) = note_frame::normalise(raw.clone());

        // ---- §2.4, the invariant itself, in Rust, before anything is written.
        let back = note_frame::denormalise(&text, flags);
        assert_eq!(
            &back, raw,
            "{name}: §2.4 round trip is not byte-identical (len {} -> {})",
            raw.len(),
            back.len(),
        );

        // ---- The two properties the frontend depends on: §2.4's "no BOM and
        // no CR ever leaking into the editor text" (spike B §5d).
        assert!(!text.starts_with(BOM), "{name}: a BOM survived into the editor text");
        assert!(!text.contains(&b'\r'), "{name}: a CR survived into the editor text");

        // ---- Flags must describe the source, not merely round-trip.
        assert_eq!(
            flags & FLAG_BOM != 0,
            raw.starts_with(BOM),
            "{name}: FLAG_BOM disagrees with the source bytes",
        );
        assert_eq!(
            flags & FLAG_CRLF != 0,
            raw.windows(2).any(|w| w == b"\r\n"),
            "{name}: FLAG_CRLF disagrees with the source bytes",
        );

        let frame = note_frame::encode_note(mtime_ms, flags, &text);
        assert_eq!(
            frame.len(),
            NOTE_HEADER + text.len(),
            "{name}: frame length is not header + content",
        );

        // ---- And it must decode back through Rust's own decoder, so a fixture
        // can never be emitted that Rust itself would reject.
        let (got_mtime, got_flags, got_text) =
            note_frame::decode_note(&frame).expect("emitted frame does not decode");
        assert_eq!(got_mtime, mtime_ms, "{name}: mtime");
        assert_eq!(got_flags, flags, "{name}: flags");
        assert_eq!(got_text, &text[..], "{name}: content");

        fs::write(dir.join(format!("{name}.frame")), &frame).expect("write .frame");
        fs::write(dir.join(format!("{name}.src")), raw).expect("write .src");
        fs::write(dir.join(format!("{name}.flags")), flags.to_string()).expect("write .flags");
    }

    // The JS suite asserts `fixtures.length >= 7`; make the failure legible here
    // rather than there if a case is ever dropped.
    let written = fs::read_dir(&dir)
        .expect("read back the fixture directory")
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().is_some_and(|x| x == "frame"))
        .count();
    assert_eq!(written, 7, "gate G-RT needs all seven §2.4 fixtures on disk");
}

/// The four flag combinations must be *distinguishable* in the emitted set,
/// otherwise "flags survive the frame verbatim" is asserted against a constant.
#[test]
fn fixtures_cover_all_four_flag_combinations() {
    let mut seen = std::collections::BTreeSet::new();
    for (_, raw) in cases() {
        let (_, flags) = note_frame::normalise(raw);
        seen.insert(flags);
    }
    assert!(seen.contains(&0), "no plain-LF case");
    assert!(seen.contains(&FLAG_CRLF), "no CRLF-without-BOM case");
    assert!(seen.contains(&FLAG_BOM), "no BOM-without-CRLF case");
    assert!(seen.contains(&(FLAG_BOM | FLAG_CRLF)), "no BOM+CRLF case");
}
