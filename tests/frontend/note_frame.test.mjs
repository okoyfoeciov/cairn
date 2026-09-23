// Owner: 03.  `node --test tests/frontend/`.
// Spec: CONTRACT.md §2 (the note frame), §2.1 (the frame), §2.2 (the two files
// printed adjacent so they cannot drift), §2.4 (the round-trip invariant and
// tests T2.1-T2.6, gate G-RT), §6.4 (this file's row in the table).
//
// ===========================================================================
// WHY THIS FILE DOES NOT CONTAIN A COPY OF THE FRAME
// ===========================================================================
// CONTRACT §2.2: "These are the only two places this layout exists", and
// src/note_frame.js's own header extends that to "no other file -- not
// editor.ts, not ipc.ts, NOT A TEST -- may restate the frame's byte offsets."
// So this file never writes an offset down.  It gets its behaviour from
// `src/note_frame.js` and its *valid* fixtures from a FRAME SOURCE, which is
// CONTRACT §2.4 T2.5's own arrangement: "200,000 realistic mtimes through
// `encode_note` -> `decodeNote`", i.e. RUST encodes and JS decodes.
//
// Set `CAIRN_FRAME_FIXTURES=<dir>` to a directory of files written by Rust's
// `note_frame::encode_note`, named `<case>.frame` with the pre-encoding source
// bytes alongside as `<case>.src` and the flags as `<case>.flags`.  With that
// present the seven §2.4 cases run for real; without it they are reported as
// TODO with the reason, rather than passing vacuously.
//
// The rows that need NO valid frame -- a bare-bytes buffer, a JS Array, a
// non-ArrayBuffer view, a short buffer -- do not need the source and run as
// soon as `decodeNote` exists.
// ===========================================================================

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const MODULE_PATH = join(HERE, '..', '..', 'src', 'note_frame.js')

/* ---------------------------------------------------------------------------
 * The module under test.  `src/note_frame.js` exports the decoder and §2.1's
 * constants.
 * ------------------------------------------------------------------------- */
const mod = await import(MODULE_PATH)

/* The frame source (see the header).  Absent by default. */
const FIXTURE_DIR = process.env.CAIRN_FRAME_FIXTURES || ''
let fixtures = []
if (FIXTURE_DIR) {
  fixtures = readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.frame'))
    .map((f) => {
      const base = f.slice(0, -'.frame'.length)
      return {
        name: base,
        frame: readFileSync(join(FIXTURE_DIR, f)),
        src: readFileSync(join(FIXTURE_DIR, base + '.src')),
        flags: Number(readFileSync(join(FIXTURE_DIR, base + '.flags'), 'utf8').trim()),
      }
    })
}
const NO_FIXTURES = fixtures.length
  ? false
  : 'no CAIRN_FRAME_FIXTURES: valid frames must come from Rust\'s note_frame::encode_note ' +
    '(CONTRACT §2.4 T2.5), because §2.2 forbids this file from restating the layout. ' +
    'Run `npm test` (its `pretest` emits them via core/tests/frame_fixtures.rs), or ' +
    '`cargo test --test frame_fixtures` then set CAIRN_FRAME_FIXTURES=tests/fixtures/frames.'

const toArrayBuffer = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)

/* ===========================================================================
 * PART 1 -- rows that run TODAY, because they test the failure the frame
 *           exists to prevent rather than the frame itself.
 * ========================================================================= */

/* CONTRACT §2's opening paragraph and spike B §5a `[M]`.
 *
 * This is the measurement the whole 24-byte magic-guarded frame was chosen to
 * defeat, reproduced here as a REGRESSION test.  It pins spec-02 §11.2's STRUCK
 * 16-byte header -- i64 mtime_ms, u32 size, u32 flags, no magic and no version
 * -- and the bare `decode(buf)` that spec-03 §9.4 and spec-06 §6.2 both used to
 * perform.  Restating THAT layout is not the thing §2.2 forbids: it is the
 * layout that does not exist, written down so that nobody can reintroduce it
 * and believe `{fatal:true}` will catch them.
 *
 * The demonstrated consequence: the file grows by exactly 16 bytes of binary
 * garbage at its head, on every save, forever. */
test('spike B §5a: the STRUCK 16-byte header is silently accepted as text 3.581% of the time', () => {
  const START = Date.UTC(2020, 0, 1)
  const END = Date.UTC(2030, 0, 1)
  const N = 200000
  const STEP = (END - START) / N
  assert.equal(STEP, 1578096, 'the sweep must be evenly spaced across 2020-01-01 -> 2030-01-01 UTC')

  // A small ASCII note, exactly as the spike framed it: size 52, flags 3.
  const SIZE = 52
  const FLAGS = 3
  const note = Buffer.alloc(SIZE, 0x2e)
  Buffer.from('# Meeting notes\n\n- ship it\n', 'utf8').copy(note)

  const buf = Buffer.alloc(16 + SIZE)
  note.copy(buf, 16)
  buf.writeUInt32LE(SIZE, 8)
  buf.writeUInt32LE(FLAGS, 12)

  const fatal = new TextDecoder('utf-8', { fatal: true })
  const loose = new TextDecoder('utf-8')
  let fatalAccepted = 0
  let looseAccepted = 0
  for (let i = 0; i < N; i++) {
    buf.writeBigInt64LE(BigInt(START + i * STEP), 0)
    try { fatal.decode(buf); fatalAccepted++ } catch { /* threw, as it should */ }
    try { loose.decode(buf); looseAccepted++ } catch { /* never happens */ }
  }

  assert.equal(fatalAccepted, 7162, 'spike B §5a measured 7,162 of 200,000 silently accepted')
  assert.equal((fatalAccepted / N * 100).toFixed(3), '3.581')
  assert.equal(looseAccepted, N, 'the DEFAULT TextDecoder never throws: 100% silent corruption')
})

/* The concrete case spike B §5a printed, kept as its own row so a future
 * failure names an instant rather than a percentage. */
test('spike B §5a: mtime 1577847846672 (2020-01-01T03:04:06.672Z) is one of the accepted ones', () => {
  const buf = Buffer.alloc(16 + 8)
  buf.writeBigInt64LE(1577847846672n, 0)
  buf.writeUInt32LE(52, 8)
  buf.writeUInt32LE(3, 12)
  Buffer.from('# Meetin', 'utf8').copy(buf, 16)
  assert.deepEqual(
    Array.from(buf.subarray(0, 16)),
    [16, 119, 15, 95, 111, 1, 0, 0, 52, 0, 0, 0, 3, 0, 0, 0],
    'the 16 bytes the editor would have written back into the vault',
  )
  assert.doesNotThrow(
    () => new TextDecoder('utf-8', { fatal: true }).decode(buf),
    'this header decodes as valid text -- which is exactly why it is a data-loss path',
  )
})

/* Node/ICU could in principle change these semantics under us; the numbers
 * above are only meaningful while they hold. */
test('TextDecoder semantics the two rows above depend on', () => {
  const lone = Uint8Array.from([0x80])
  assert.throws(() => new TextDecoder('utf-8', { fatal: true }).decode(lone), TypeError)
  assert.equal(new TextDecoder('utf-8').decode(lone), '�')
  assert.equal(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from([0, 0, 0])), '\0\0\0',
    'NUL is perfectly legal UTF-8 -- which is why the STRUCK header\'s zero padding never trips a decoder')
})

/* ===========================================================================
 * PART 2 -- the module contract.  Live the moment src/note_frame.js lands.
 * ========================================================================= */

test('src/note_frame.js exports §2.2\'s constants with §2.1\'s values', () => {
  assert.equal(mod.NOTE_MAGIC, 0x4e4f5445, 'magic is "NOTE"')
  assert.equal(mod.NOTE_VERSION, 1)
  assert.equal(mod.NOTE_HEADER, 24, 'the 24-byte header; spec-02 §11.2\'s 16-byte one is STRUCK')
  assert.equal(mod.FLAG_CRLF, 1, 'bit 0 = source had CRLF')
  assert.equal(mod.FLAG_BOM, 2, 'bit 1 = source had a UTF-8 BOM')
  assert.equal(mod.FLAG_CRLF & mod.FLAG_BOM, 0, 'the two flags must not overlap')
})

/* The magic is not a checksum and it is not "unlikely to decode".  Its four
 * bytes are printable ASCII, so a bare content decode of a real frame SUCCEEDS.
 * The guard is the explicit comparison in decodeNote, and nothing else. */
test('the magic bytes are themselves valid UTF-8, so only the explicit check guards anything',
  () => {
    const b = Buffer.alloc(4)
    b.writeUInt32LE(mod.NOTE_MAGIC, 0)
    assert.equal(b.toString('latin1'), 'ETON', 'little-endian "NOTE"')
    assert.doesNotThrow(() => new TextDecoder('utf-8', { fatal: true }).decode(b))
  })

/* CONTRACT §2.4 T2.3, and spike B §6 `[M]`: after ONE malformed JSON response
 * tauri's module-level `customProtocolIpcFailed` latches with no reset path and
 * `read_note` starts returning a JS Array of numbers.  `new Uint8Array(thatArray)`
 * WORKS, so a decoder without this guard keeps going, silently, ~4x slower. */
test('T2.3: a JS Array of numbers is rejected as a degraded transport, not decoded',
  () => {
    assert.throws(() => mod.decodeNote([78, 79, 84, 69, 1, 0, 0, 0]), /did not return an ArrayBuffer/)
  })

test('T2.3b: a Uint8Array is not an ArrayBuffer and must be rejected too',
  () => {
    assert.throws(() => mod.decodeNote(Uint8Array.from([78, 79, 84, 69])), /did not return an ArrayBuffer/)
  })

test('T2.3c: null / undefined / a string are rejected by the same guard',
  () => {
    for (const bad of [null, undefined, '', 'NOTE', 0, {}]) {
      assert.throws(() => mod.decodeNote(bad), /did not return an ArrayBuffer/, `for ${String(bad)}`)
    }
  })

/* CONTRACT §2.4 T2.2 -- the drift case spike B §5b measured:
 * "Error: note frame magic 0xe39dbfe4 != 0x4e4f5445". */
test('T2.2: bare content bytes (no frame at all) throw a magic error',
  () => {
    const bare = new TextEncoder().encode('# Meeting notes\n\n- ship it\n- then ship it again\n')
    assert.throws(() => mod.decodeNote(toArrayBuffer(bare)), /magic/i)
  })

test('a buffer shorter than the header throws rather than reading past the end',
  () => {
    assert.throws(() => mod.decodeNote(new ArrayBuffer(0)), /too short/i)
    assert.throws(() => mod.decodeNote(new ArrayBuffer(23)), /too short/i)
  })

/* ===========================================================================
 * PART 3 -- the seven §2.4 cases and gate G-RT.  These need a VALID frame, and
 *           a valid frame may only come from Rust (see the file header).
 * ========================================================================= */

const RT_BLOCKED = NO_FIXTURES

test('G-RT: every §2.4 fixture decodes, and the decoded text carries no BOM and no CR',
  { todo: RT_BLOCKED }, () => {
    assert.ok(fixtures.length >= 7, `§2.4 names seven cases; found ${fixtures.length}`)
    for (const f of fixtures) {
      const got = mod.decodeNote(toArrayBuffer(f.frame))
      assert.equal(typeof got.text, 'string', f.name)
      assert.equal(got.flags, f.flags, `${f.name}: flags must survive the frame verbatim`)
      assert.ok(!got.text.includes('\r'), `${f.name}: a CR reached the editor`)
      assert.ok(!got.text.includes('﻿'), `${f.name}: a BOM reached the editor`)
      assert.ok(Number.isSafeInteger(got.mtimeMs), `${f.name}: mtimeMs`)
    }
  })

/* THE INVARIANT ITSELF (§2.4): "Bytes read from a file and written back
 * unmodified MUST be byte-identical, BOM and CRLF included."  Rust owns both
 * halves; the JS half's obligation is that what `decodeNote` hands the editor,
 * echoed back untouched with the same `flags`, reconstructs the source exactly.
 * `denormalise` is Rust's, so the reconstruction is checked against the `.src`
 * bytes the fixture generator recorded. */
test('G-RT: text + flags, echoed back unmodified, reconstruct the source bytes exactly',
  { todo: RT_BLOCKED }, () => {
    for (const f of fixtures) {
      const got = mod.decodeNote(toArrayBuffer(f.frame))
      let out = got.text
      if (got.flags & mod.FLAG_CRLF) out = out.replace(/\n/g, '\r\n')
      if (got.flags & mod.FLAG_BOM) out = '﻿' + out
      assert.deepEqual(Buffer.from(out, 'utf8'), f.src, `${f.name}: not byte-identical`)
    }
  })

test('T2.4: a frame whose `size` disagrees with the body throws',
  { todo: RT_BLOCKED }, () => {
    for (const f of fixtures.slice(0, 1)) {
      const truncated = Buffer.from(f.frame.subarray(0, f.frame.length - 1))
      assert.throws(() => mod.decodeNote(toArrayBuffer(truncated)), /size/i, f.name)
      const extended = Buffer.concat([f.frame, Buffer.from([0x41])])
      assert.throws(() => mod.decodeNote(toArrayBuffer(extended)), /size/i, f.name)
    }
  })
