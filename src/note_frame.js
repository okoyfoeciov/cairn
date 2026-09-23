/**
 * src/note_frame.js
 * Owner: 02.  Spec: CONTRACT.md §2 (the note read/write byte framing, B2) and
 * §2.2, where this file and src-tauri/src/note_frame.rs are printed ADJACENT so
 * they cannot drift.
 *
 * THE ONLY JS COPY OF THE NOTE FRAME.  No other file — not editor.ts, not
 * ipc.ts, not a test — may restate the frame's byte offsets, in code or in
 * prose or in a table (spec-07 §1, rule 4).  Two copies of a wire format is how
 * a 16-byte header and a 24-byte header end up shipping in the same release,
 * which is exactly what B2 struck.
 *
 * WRITTEN BY THE INTEGRATOR, TRANSCRIBED FROM §2.2 VERBATIM, NOT DESIGNED HERE.
 * Owner 02 never landed the body and `decodeNote` is a hard dependency of
 * ipc.ts's `readNote`, which every note open goes through.  §2.2 prints the
 * normative source, so this is a transcription of the contract rather than a
 * second design of the frame; §2.3's `write_note` call lives in ipc.ts, where
 * §2.3 puts it.  spec-02 §11.2's 16-byte header and its inline `ts` decode are
 * STRUCK; so are spec-03 §9.4's `decode(buf)` and spec-06 §6.2's decoder.
 *
 * The four guards each convert one class of drift into an immediate throw:
 * transport degradation, wrong offset, version skew, truncation.  The
 * `instanceof ArrayBuffer` guard is NOT optional — it is the only thing between
 * a degraded IPC channel and a silently 4x-slower editor, because after one
 * malformed JSON response `read_note` comes back as a JS `Array` of numbers and
 * `new Uint8Array(thatArray)` *works* (spike B §6).
 *
 * `new Uint8Array(buf, NOTE_HEADER, size)` is a VIEW: the decode stays
 * zero-copy, which is why the self-describing header costs nothing.
 *
 * `ignoreBOM: true` because Rust's `normalise` has already removed the file's
 * BOM and recorded it in `flags`: a U+FEFF still at the start of the body is
 * content (a file that began with two), and the default decoder would drop it
 * so that the next save loses it.
 *
 * It is a `.js`, not a `.ts`, on purpose: `tests/frontend/*.test.mjs` runs it
 * under `node --test` with no build step, and the randomised block-index
 * property test in CONTRACT §2.4 depends on that.
 */

export const NOTE_MAGIC = 0x4E4F5445, NOTE_VERSION = 1, NOTE_HEADER = 24;
export const FLAG_CRLF = 1, FLAG_BOM = 2;

export function decodeNote(buf) {
  if (!(buf instanceof ArrayBuffer))
    throw new Error('read_note did not return an ArrayBuffer (got ' +
      Object.prototype.toString.call(buf) + ') - the IPC transport has degraded to JSON');
  if (buf.byteLength < NOTE_HEADER) throw new Error('note frame too short: ' + buf.byteLength);
  const dv = new DataView(buf);
  const magic = dv.getUint32(0, true);
  if (magic !== NOTE_MAGIC)
    throw new Error('note frame magic 0x' + magic.toString(16) + ' != 0x4e4f5445');
  const version = dv.getUint32(4, true);
  if (version !== NOTE_VERSION) throw new Error('note frame version ' + version);
  const size = dv.getUint32(16, true);
  if (buf.byteLength !== NOTE_HEADER + size)
    throw new Error('note frame size ' + size + ' != body ' + (buf.byteLength - NOTE_HEADER));
  return {
    mtimeMs: Number(dv.getBigInt64(8, true)),
    flags:   dv.getUint32(20, true),
    text:    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
               .decode(new Uint8Array(buf, NOTE_HEADER, size)),
  };
}
