/**
 * F18/F39 -- the note frame's edge cases,
 * through the REAL Rust encoder (`read_note` / `write_note` over the addon)
 * and the REAL `decodeNote`.  A frontend test cannot build a valid frame
 * without restating its layout (CONTRACT §2.2), so these live here.
 *
 *   1. A U+FEFF AFTER THE STRIPPED BOM IS CONTENT.  Rust strips ONE leading
 *      BOM and records it in `flags`; a second one is text, and must survive
 *      the decode and a save byte for byte.
 *   2. WHAT A SAVE DOES TO A LONE CR, pinned through the whole pipeline
 *      (read -> CM6 document, built as `editor.ts` builds it -> write).  This
 *      is documented behaviour, not a defect: CodeMirror's default line split
 *      (Obsidian's too) reads a lone `\r` as a line break.  The test exists so
 *      that changing it, e.g. with a `lineSeparator` facet, is deliberate.
 *
 * Headless: needs only `electron-shell/cairn.node`.
 *
 * Run: node --test electron-shell/note-frame-edges.test.mjs
 */

import assert from 'node:assert/strict'
import { test, before } from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { EditorState } from '@codemirror/state'

import { loadAddon, nativeCommands } from './native.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const { decodeNote, FLAG_BOM, FLAG_CRLF } = await import(pathToFileURL(join(ROOT, 'src', 'note_frame.js')).href)

const work = realpathSync(mkdtempSync(join(tmpdir(), 'cairn-frame-edges-')))
process.on('exit', () => {
  try {
    rmSync(work, { recursive: true, force: true })
  } catch {}
})

const addon = loadAddon()
const cmd = nativeCommands(addon)
const VAULT = join(work, 'vault')

const BOM = [0xef, 0xbb, 0xbf]
const bytes = (...parts) => Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p) : Buffer.from(p))))

const FILES = {
  'twobom.md': bytes(BOM, BOM, 'hello\n'),
  'twobom-crlf.md': bytes(BOM, BOM, 'a\r\nb\r\n'),
  'onebom.md': bytes(BOM, 'hello\n'),
  'midfeff.md': bytes(BOM, 'x', BOM, 'y\n'),
  'lonecr.md': bytes('alpha\rbeta\ngamma\n'),
  'crlf-lonecr.md': bytes('a\r\nb\rc\r\n'),
  'crcrlf.md': bytes('x\r\r\ny\n'),
}

before(async () => {
  mkdirSync(VAULT, { recursive: true })
  for (const [name, b] of Object.entries(FILES)) writeFileSync(join(VAULT, name), b)
  addon.start(() => {}, () => {}, join(work, 'state.json'))
  await cmd.open_vault({ path: VAULT })
})

/** read -> `text` -> write, as the editor saves: returns what is on disk. */
async function save(path, edit = (t) => t) {
  const r = decodeNote(await cmd.read_note({ path }))
  await cmd.write_note({
    path,
    text: new TextEncoder().encode(edit(r.text)),
    flags: r.flags,
    baseMtimeMs: r.mtimeMs,
    create: false,
  })
  return readFileSync(join(VAULT, path))
}

test('note frame: a U+FEFF after the stripped BOM is content, and survives a save', async () => {
  const r = decodeNote(await cmd.read_note({ path: 'twobom.md' }))
  assert.equal(r.text, '﻿hello\n')
  assert.equal(r.flags, FLAG_BOM)
  assert.deepEqual([...await save('twobom.md')], [...FILES['twobom.md']], 'an unedited save is byte-identical')
  assert.deepEqual([...await save('twobom.md', (t) => t + 'X')], [...bytes(BOM, BOM, 'hello\nX')])

  const c = decodeNote(await cmd.read_note({ path: 'twobom-crlf.md' }))
  assert.equal(c.text, '﻿a\nb\n')
  assert.equal(c.flags, FLAG_BOM | FLAG_CRLF)
  assert.deepEqual([...await save('twobom-crlf.md')], [...FILES['twobom-crlf.md']])
})

test('note frame: one BOM, and a U+FEFF inside the text, still round-trip', async () => {
  assert.equal(decodeNote(await cmd.read_note({ path: 'onebom.md' })).text, 'hello\n')
  assert.deepEqual([...await save('onebom.md')], [...FILES['onebom.md']])
  assert.equal(decodeNote(await cmd.read_note({ path: 'midfeff.md' })).text, 'x﻿y\n')
  assert.deepEqual([...await save('midfeff.md')], [...FILES['midfeff.md']])
})

test('a save writes a lone CR back as a line ending (documented, as in Obsidian)', async () => {
  // No lineSeparator facet: `editor.ts` builds its state exactly this way.
  const viaEditor = (t) => {
    const doc = EditorState.create({ doc: t }).doc
    return doc.toString() + 'X'
  }
  const r = decodeNote(await cmd.read_note({ path: 'lonecr.md' }))
  assert.equal(r.text, 'alpha\rbeta\ngamma\n', 'Rust keeps the lone CR')
  assert.equal(EditorState.create({ doc: r.text }).doc.lines, 4, 'CodeMirror breaks the line there')
  assert.equal((await save('lonecr.md', viaEditor)).toString(), 'alpha\nbeta\ngamma\nX')
  assert.equal((await save('crlf-lonecr.md', viaEditor)).toString(), 'a\r\nb\r\nc\r\nX')
  // `\r\r\n` reaches the editor as `\r\n`: one line ending, one CR fewer.
  assert.equal((await save('crcrlf.md', viaEditor)).toString(), 'x\r\ny\r\nX')
})
