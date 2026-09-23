//! core/src/note_frame.rs — Owner: 02.
//! Spec: CONTRACT.md §2 (the note read/write byte framing, B2), §2.1 (the
//! frame), §2.2 (this file and `src/note_frame.js` printed ADJACENT so they
//! cannot drift), §2.3 (`write_note` — the exact call), §2.4 (the round-trip
//! invariant, gate G-RT).
//!
//! THE ONLY RUST COPY OF THE NOTE FRAME.  No other file may restate its byte
//! offsets, in code or in prose or in a table (spec-07 §1, rule 4).
//!
//! ===========================================================================
//! THE JS DECODER, PRINTED ADJACENT (CONTRACT §2.2).  `src/note_frame.js` is the
//! only JS copy; this block is here so that anyone changing an offset on the
//! Rust side is looking at the code that has to change with it.  It is a
//! comment, not a second declaration site.
//!
//! ```js
//! // src/note_frame.js  — THE ONLY PLACE THIS LAYOUT EXISTS IN JS
//! export const NOTE_MAGIC = 0x4E4F5445, NOTE_VERSION = 1, NOTE_HEADER = 24;
//! export const FLAG_CRLF = 1, FLAG_BOM = 2;
//!
//! export function decodeNote(buf) {
//!   if (!(buf instanceof ArrayBuffer))
//!     throw new Error('read_note did not return an ArrayBuffer (got ' +
//!       Object.prototype.toString.call(buf) + ') - the IPC transport has degraded to JSON');
//!   if (buf.byteLength < NOTE_HEADER) throw new Error('note frame too short: ' + buf.byteLength);
//!   const dv = new DataView(buf);
//!   const magic = dv.getUint32(0, true);
//!   if (magic !== NOTE_MAGIC)
//!     throw new Error('note frame magic 0x' + magic.toString(16) + ' != 0x4e4f5445');
//!   const version = dv.getUint32(4, true);
//!   if (version !== NOTE_VERSION) throw new Error('note frame version ' + version);
//!   const size = dv.getUint32(16, true);
//!   if (buf.byteLength !== NOTE_HEADER + size)
//!     throw new Error('note frame size ' + size + ' != body ' + (buf.byteLength - NOTE_HEADER));
//!   return {
//!     mtimeMs: Number(dv.getBigInt64(8, true)),
//!     flags:   dv.getUint32(20, true),
//!     text:    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
//!                .decode(new Uint8Array(buf, NOTE_HEADER, size)),
//!   };
//! }
//! ```
//! ===========================================================================
//!
//! `write_note` takes the RAW BODY plus `WriteArgs` (B3/M45/M51).  There is a
//! `flags` bitfield and NO `eol` argument: RUST re-applies CRLF and the BOM.
//!
//! `MAX_NOTE_BYTES = 8 MiB` (M27).  spec-03 §10's 32 MB guard and its 47 MB
//! error copy are STRUCK.
//!
//! CJK JSON inflation is x1.0141, NOT 6x (M44).  The raw path stands on autosave
//! cost, not on an inflation figure that was off by two orders of magnitude.

use crate::error::VaultError;

/// CONTRACT §2.1.
pub const NOTE_MAGIC: u32 = 0x4E4F_5445; // "NOTE"
/// CONTRACT §2.1.
pub const NOTE_VERSION: u32 = 1;
/// CONTRACT §2.1.
pub const NOTE_HEADER: usize = 24;
/// CONTRACT §2.1: bit 0 — the source had CRLF line endings.
pub const FLAG_CRLF: u32 = 1 << 0;
/// CONTRACT §2.1: bit 1 — the source had a UTF-8 BOM.
pub const FLAG_BOM: u32 = 1 << 1;

/// CONTRACT §2 (M27) and §7.3 case 15.
pub const MAX_NOTE_BYTES: u64 = 8 * 1024 * 1024;

const BOM: [u8; 3] = [0xEF, 0xBB, 0xBF];

/// CONTRACT §2.1's 24-byte frame.  Little-endian throughout.
pub fn encode_note(mtime_ms: i64, flags: u32, content: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(NOTE_HEADER + content.len());
    out.extend_from_slice(&NOTE_MAGIC.to_le_bytes()); //  0  u32 magic
    out.extend_from_slice(&NOTE_VERSION.to_le_bytes()); //  4  u32 version
    out.extend_from_slice(&mtime_ms.to_le_bytes()); //  8  i64 mtime_ms
    out.extend_from_slice(&(content.len() as u32).to_le_bytes()); // 16  u32 size
    out.extend_from_slice(&flags.to_le_bytes()); // 20  u32 flags
    out.extend_from_slice(content); // 24  content
    out
}

/// The inverse of `encode_note`, and the Rust mirror of the JS decoder printed
/// at the top of this file — the SAME four guards, in the same order: length,
/// magic, version, size-vs-body.  It lives here because §2.2 allows the frame's
/// layout in exactly one place per language, and a Rust decoder in any other
/// file would be a second declaration site.
///
/// The magic is what does the work.  The header's bytes are frequently VALID
/// UTF-8 — a `version` of 1 is three NULs, and NUL is valid UTF-8 — so
/// "the header would fail to decode as text" was never the protection; spike B
/// §5a measured a non-fatal `TextDecoder` accepting 100% of realistic mtimes
/// and a fatal one accepting 3.581%.  `t2_5_realistic_mtimes` below reproduces
/// that number and then shows the magic catching all 200,000.
pub fn decode_note(buf: &[u8]) -> Result<(i64, u32, &[u8]), VaultError> {
    let bad = |r: &str| VaultError::invalid_path("", r.to_string());
    let head = buf.get(..NOTE_HEADER).ok_or_else(|| bad("note frame too short"))?;
    let g4 = |o: usize| -> u32 {
        let mut b = [0u8; 4];
        b.copy_from_slice(&head[o..o + 4]);
        u32::from_le_bytes(b)
    };
    if g4(0) != NOTE_MAGIC {
        return Err(bad("note frame magic mismatch"));
    }
    if g4(4) != NOTE_VERSION {
        return Err(bad("note frame version mismatch"));
    }
    let mut m = [0u8; 8];
    m.copy_from_slice(&head[8..16]);
    let mtime_ms = i64::from_le_bytes(m);
    let size = g4(16) as usize;
    let flags = g4(20);
    let body = buf.get(NOTE_HEADER..).unwrap_or(&[]);
    if body.len() != size {
        return Err(bad("note frame size disagrees with the body"));
    }
    Ok((mtime_ms, flags, body))
}

/// The read-side normalisation: strip one leading UTF-8 BOM (a second one is
/// content), rewrite `\r\n` to `\n`, and record both in `flags` so
/// `denormalise` can put them back.  Returns the text the editor is given.
///
/// Takes the buffer by value and edits it in place: spec-02 §6.1 step 3 buys
/// exactly one allocation for a note read, and a normalisation pass that
/// allocated a second copy would give that back on the largest file the app
/// accepts.
///
/// MIXED LINE ENDINGS ARE A RECORDED LIMITATION, not a silent one.  `FLAG_CRLF`
/// is one bit, so a file that mixes `\r\n` and bare `\n` cannot be described
/// exactly; this function sets the flag if the file contains ANY `\r\n`, which
/// means the first save unifies the file on CRLF.  The alternative — leaving
/// `\r\n` in the text the editor receives — is worse, because CodeMirror
/// normalises the document to `\n` on load and the save would then silently
/// DELETE every `\r`.  §2.4's seven cases are all uniform and all byte-exact;
/// `mixed_eol_is_unified_not_silently_stripped` below pins what happens outside
/// them so that changing it is a deliberate act.
///
/// A lone `\r` with no `\n` after it is left in the text, and `denormalise`
/// leaves it too — but only this pair keeps it.  The editor splits lines the
/// way CodeMirror does by default (`\r\n`, `\r` or `\n`, as Obsidian does), so
/// it reads a lone `\r` as a line break and the first save after any edit
/// writes it back as `\n` (`\r\n` under `FLAG_CRLF`).  The same split makes a
/// `\r\r\n`, which reaches the editor as `\r\n`, one line ending: it is saved
/// as a single `\n` (`\r\n`), one `\r` fewer than the file had.
pub fn normalise(mut raw: Vec<u8>) -> (Vec<u8>, u32) {
    let mut flags = 0;

    if raw.starts_with(&BOM) {
        flags |= FLAG_BOM;
        raw.drain(..BOM.len());
    }

    if memchr::memmem::find(&raw, b"\r\n").is_some() {
        flags |= FLAG_CRLF;
        let mut w = 0usize;
        let mut prev_cr = false;
        for r in 0..raw.len() {
            let b = match raw.get(r) {
                Some(b) => *b,
                None => break,
            };
            if prev_cr && b == b'\n' {
                // Overwrite the `\r` we already copied with this `\n`.
                w -= 1;
            }
            if let Some(slot) = raw.get_mut(w) {
                *slot = b;
            }
            w += 1;
            prev_cr = b == b'\r';
        }
        raw.truncate(w);
    }

    (raw, flags)
}

/// Inverse of `normalise`.  Applied by RUST, never by the caller (M51).
pub fn denormalise(text: &[u8], flags: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() + text.len() / 32 + 3);
    if flags & FLAG_BOM != 0 {
        out.extend_from_slice(&BOM);
    }
    if flags & FLAG_CRLF != 0 {
        for &b in text {
            if b == b'\n' {
                out.push(b'\r');
            }
            out.push(b);
        }
    } else {
        out.extend_from_slice(text);
    }
    out
}

/// CONTRACT §1.1.  The four arguments `write_note` receives.
///
/// `base_mtime_ms: None` is the FORCE-OVERWRITE case — §7.2's "Keep mine"
/// button.  It is not "the value was missing": a conflict guard that silently
/// disables itself when a value is dropped is not a guard.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WriteArgs {
    pub rel: String,
    pub flags: u32,
    pub base_mtime_ms: Option<i64>,
    pub create: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame_fields(f: &[u8]) -> (u32, u32, i64, u32, u32) {
        let g4 = |o: usize| u32::from_le_bytes(f[o..o + 4].try_into().unwrap());
        (
            g4(0),
            g4(4),
            i64::from_le_bytes(f[8..16].try_into().unwrap()),
            g4(16),
            g4(20),
        )
    }

    /// CONTRACT §2.1, offset by offset.  This is the test the JS decoder's four
    /// guards are the mirror of.
    #[test]
    fn frame_layout_is_contract_2_1() {
        let f = encode_note(-1, FLAG_CRLF | FLAG_BOM, b"hi");
        assert_eq!(f.len(), NOTE_HEADER + 2);
        let (magic, version, mtime, size, flags) = frame_fields(&f);
        assert_eq!(magic, 0x4E4F_5445);
        // ON THE WIRE the magic is little-endian, so the first four bytes read
        // "ETON", not "NOTE".  Both sides read it with a u32 accessor and never
        // as a string, which is why that is harmless - but it is worth pinning,
        // because a reader who greps a hex dump for "NOTE" and does not find it
        // will conclude the frame is wrong.
        assert_eq!(&f[0..4], b"ETON");
        assert_eq!(version, 1);
        assert_eq!(mtime, -1);
        assert_eq!(size, 2);
        assert_eq!(flags, 3);
        assert_eq!(&f[NOTE_HEADER..], b"hi");
    }

    /// T2.5.  200,000 realistic 2020-2030 mtimes through `encode_note` ->
    /// `decode_note`: ZERO silent acceptances of a wrong offset.
    ///
    /// It also reproduces the measurement that made the magic necessary.  The
    /// tempting premise - "a binary header cannot be mistaken for text" - is
    /// FALSE, and this test measures how false: a `version` of 1 is three NUL
    /// bytes, NUL is valid UTF-8, and 3.581% of realistic mtimes leave the whole
    /// 24-byte header decodable by a FATAL TextDecoder (spike B §5a's exact
    /// figure, 7,162 of 200,000).  So the guard that catches a 16-vs-24 offset
    /// skew is the MAGIC, not UTF-8 validation, and this asserts the magic
    /// catches every single one.
    #[test]
    fn t2_5_realistic_mtimes_never_decode_as_content() {
        // 2020-01-01 .. 2030-01-01, evenly spaced across the decade.
        const START: i64 = 1_577_836_800_000;
        const END: i64 = 1_893_456_000_000;
        const N: i64 = 200_000;
        let step = (END - START) / N;
        let content = b"# note\nbody\n";
        let mut header_is_valid_utf8 = 0u32;
        let mut wrong_offset_caught = 0u32;
        for i in 0..N {
            let mtime = START + i * step;
            let f = encode_note(mtime, FLAG_CRLF, content);

            // 1. The frame decodes to exactly what went in.
            let (got_mtime, got_flags, body) = decode_note(&f).unwrap();
            assert_eq!(got_mtime, mtime);
            assert_eq!(got_flags, FLAG_CRLF);
            assert_eq!(body, content);

            // 2. spec-02 §11.2's STRUCK 16-byte header, simulated: a decoder
            //    reading the body from offset 16 gets 8 bytes of header as
            //    content.  With the magic in place the frame it would have to
            //    accept is one whose first four bytes are NOT the magic, and
            //    `decode_note` refuses every one.
            let skewed = f.get(8..).unwrap();
            if decode_note(skewed).is_err() {
                wrong_offset_caught += 1;
            }

            // 3. The measurement itself.
            if std::str::from_utf8(f.get(..NOTE_HEADER).unwrap()).is_ok() {
                header_is_valid_utf8 += 1;
            }
        }
        assert_eq!(wrong_offset_caught, N as u32, "a wrong offset was silently accepted");

        // spike B §5a: 7,162 of 200,000 = 3.581%.  Pinned exactly, because if
        // this ever became 0 someone would conclude the magic is redundant.
        assert_eq!(header_is_valid_utf8, 7_162);
    }

    /// T2.2 / T2.3 / T2.4 - the JS decoder's guards, mirrored.  The JS
    /// `instanceof ArrayBuffer` guard (T2.3) has no Rust analogue: it exists
    /// because a degraded IPC channel hands JS an `Array` of numbers that
    /// `new Uint8Array()` happily accepts.
    #[test]
    fn t2_2_t2_4_decoder_guards() {
        // T2.2: bare bytes, no header.
        assert!(decode_note(b"# just a markdown file\n").is_err());
        // Too short to hold a header at all.
        assert!(decode_note(b"ETON").is_err());
        assert!(decode_note(&[]).is_err());
        // Version skew.
        let mut f = encode_note(0, 0, b"hi");
        f.get_mut(4..8).unwrap().copy_from_slice(&2u32.to_le_bytes());
        assert!(decode_note(&f).is_err());
        // T2.4: `size` disagrees with the body.
        let mut f = encode_note(0, 0, b"hi");
        f.get_mut(16..20).unwrap().copy_from_slice(&99u32.to_le_bytes());
        assert!(decode_note(&f).is_err());
        let mut f = encode_note(0, 0, b"hi");
        f.push(b'!');
        assert!(decode_note(&f).is_err());
    }

    /// CONTRACT §2.4, gate G-RT, at the byte level: `normalise` then
    /// `denormalise` is the identity for all seven cases.  The full round trip
    /// THROUGH THE FILESYSTEM is `tests/vault_ops.rs`; this is the pure half.
    #[test]
    fn g_rt_normalise_denormalise_is_the_identity() {
        let cjk = "\u{4F60}\u{597D}\u{4E16}\u{754C} \u{1F600}\u{1F1EF}\u{1F1F5}";
        let cases: Vec<(&str, Vec<u8>)> = vec![
            ("LF", b"one\ntwo\nthree\n".to_vec()),
            ("CRLF", b"one\r\ntwo\r\nthree\r\n".to_vec()),
            ("BOM+LF", [&BOM[..], b"one\ntwo\n"].concat()),
            ("BOM+CRLF", [&BOM[..], b"one\r\ntwo\r\n"].concat()),
            (
                "BOM+CRLF+CJK+emoji",
                [&BOM[..], format!("{cjk}\r\n{cjk}\r\n").as_bytes()].concat(),
            ),
            ("200KiB CJK", cjk.repeat(200 * 1024 / cjk.len()).into_bytes()),
            ("1MiB ASCII", b"the quick brown fox\n".repeat(1024 * 1024 / 20)),
        ];
        for (name, raw) in cases {
            let (text, flags) = normalise(raw.clone());
            assert!(!text.starts_with(&BOM), "{name}: a BOM leaked into the editor text");
            assert!(
                memchr::memmem::find(&text, b"\r\n").is_none(),
                "{name}: a CR leaked into the editor text"
            );
            assert!(std::str::from_utf8(&text).is_ok(), "{name}: not UTF-8 after normalise");
            let back = denormalise(&text, flags);
            assert_eq!(back, raw, "{name}: round trip is not byte-identical");
        }
    }

    /// The two flag bits are recorded, not guessed.
    #[test]
    fn flags_record_what_the_file_actually_had() {
        assert_eq!(normalise(b"a\nb".to_vec()).1, 0);
        assert_eq!(normalise(b"a\r\nb".to_vec()).1, FLAG_CRLF);
        assert_eq!(normalise([&BOM[..], b"a\nb"].concat()).1, FLAG_BOM);
        assert_eq!(normalise([&BOM[..], b"a\r\nb"].concat()).1, FLAG_BOM | FLAG_CRLF);
        // An empty file, and a BOM-only file, are both legal and must not panic.
        assert_eq!(normalise(Vec::new()), (Vec::new(), 0));
        assert_eq!(normalise(BOM.to_vec()), (Vec::new(), FLAG_BOM));
        assert_eq!(denormalise(&[], FLAG_BOM), BOM.to_vec());
    }

    /// A lone `\r` is not a line ending we know how to describe, so this pair
    /// leaves it exactly where it was, in both directions.  The editor does not
    /// (see `normalise`): this pins the Rust half only.
    #[test]
    fn lone_cr_survives_untouched() {
        let raw = b"a\rb\r\nc\r".to_vec();
        let (text, flags) = normalise(raw.clone());
        assert_eq!(flags, FLAG_CRLF);
        assert_eq!(text, b"a\rb\nc\r");
        assert_eq!(denormalise(&text, flags), raw);
    }

    /// THE RECORDED LIMITATION (see `normalise`'s doc comment).  A file mixing
    /// `\r\n` and bare `\n` is unified on CRLF by the first save.  This test
    /// asserts the limitation, not a feature: if someone widens the flags word
    /// to describe mixed endings exactly, this test is what tells them they have
    /// changed behaviour on purpose.
    #[test]
    fn mixed_eol_is_unified_not_silently_stripped() {
        let raw = b"crlf\r\nlf\ncrlf\r\n".to_vec();
        let (text, flags) = normalise(raw.clone());
        assert_eq!(flags, FLAG_CRLF);
        assert_eq!(text, b"crlf\nlf\ncrlf\n");
        // NOT byte-identical - and at this layer the divergence is one that
        // ADDS a `\r`, never one that deletes the user's bytes (the editor's
        // own line split can: see `normalise` on `\r\r\n`).
        assert_eq!(denormalise(&text, flags), b"crlf\r\nlf\r\ncrlf\r\n".to_vec());
    }

}
