/**
 * F24 -- the search backend and the secret
 * viewer agree on which notes are secret, over the SAME BYTES.
 *
 * The viewer decides on the editor's text: `read_note` (Rust strips one BOM
 * and makes CRLF LF), `decodeNote`, then CodeMirror's line split.  The
 * backend decides on the raw file, for the search exclusion and the tree
 * mark.  Where the two disagree, a note the app shows as a masked credentials
 * store has its passwords printed in search snippets -- or an ordinary note
 * silently drops out of content search.  So every fixture is checked in BOTH
 * directions, through shipped code on both sides:
 *
 *   - `secret_notes()` (the tree mark) === the viewer's `isSecretText` on the
 *     CM6 document built from `read_note`, exactly as `editor.ts` builds it;
 *   - a secret note's token reaches neither a search batch nor
 *     `search_expand`, and an ordinary note's token reaches both.
 *
 * Headless: needs only `electron-shell/cairn.node`.  No real secret is used.
 *
 * Run: node --test electron-shell/secret-parity.test.mjs
 */

import assert from 'node:assert/strict'
import { test, before } from 'node:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

import { loadAddon, nativeCommands } from './native.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

const work = realpathSync(mkdtempSync(join(tmpdir(), 'cairn-secret-parity-')))
process.on('exit', () => {
  try {
    rmSync(work, { recursive: true, force: true })
  } catch {}
})

/* The viewer's detector and CM6's document, bundled from the shipped source. */
const bundle = join(work, 'viewer.mjs')
await esbuild.build({
  stdin: {
    contents:
      'export { isSecretText } from ' + JSON.stringify(join(ROOT, 'src', 'secrets.ts')) + '\n' +
      "export { EditorState } from '@codemirror/state'\n",
    resolveDir: ROOT,
    sourcefile: 'secret-parity-entry.ts',
    loader: 'ts',
  },
  outfile: bundle,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  mainFields: ['module', 'main'],
  conditions: ['import', 'default'],
  target: 'es2021',
  logLevel: 'silent',
})
const { isSecretText, EditorState } = await import(pathToFileURL(bundle).href)
const { decodeNote } = await import(pathToFileURL(join(ROOT, 'src', 'note_frame.js')).href)

const addon = loadAddon()
const cmd = nativeCommands(addon)
const events = []
const VAULT = join(work, 'vault')

const BOM = '﻿'
const token = (name) => 'hunter2-' + name + '-TOKEN'

/** A secret file in the template's shape, with `eol` line endings. */
function secretNote(name, eol = '\n', keys = 0, keyLen = 3) {
  const lines = ['---']
  for (let i = 0; i < keys; i++) lines.push('k' + i + ': ' + 'x'.repeat(keyLen))
  lines.push('cairn-type: secrets', '---', '', '```secret', '# GitHub', token(name), '```', '')
  return lines.join(eol)
}

/** name -> [file text, whether the VIEWER masks it]. */
const FIXTURES = {
  Plain: [secretNote('Plain'), true],
  Bom: [BOM + secretNote('Bom'), true],
  BomCrlf: [BOM + secretNote('BomCrlf', '\r\n'), true],
  LoneCr: [secretNote('LoneCr', '\r'), true],
  // `\r\r\n` is one break in the editor, so the closer is the 64th line walked.
  CrCrLf: [secretNote('CrCrLf', '\r\r\n', 62), true],
  // A frontmatter longer than the backend's first 4 KiB read.
  LongFm: [secretNote('LongFm', '\n', 40, 120), true],
  // Only one BOM is stripped: the second is content, so line 1 is not `---`.
  TwoBoms: [BOM + BOM + secretNote('TwoBoms'), false],
  // The closer is the 65th line walked: out of the viewer's reach.
  Walk65: [secretNote('Walk65', '\n', 63), false],
  AfterCloser: ['---\ntitle: x\n---\ncairn-type: secrets\n' + token('AfterCloser') + '\n', false],
  Ordinary: ['# Notes\n\n' + token('Ordinary') + '\n', false],
}

before(async () => {
  mkdirSync(VAULT, { recursive: true })
  for (const [name, [text]] of Object.entries(FIXTURES)) writeFileSync(join(VAULT, name + '.md'), text)
  addon.start(
    (event, payload) => events.push({ event, payload }),
    () => {},
    // A test must never write the state.json of the person running it.
    join(work, 'state.json')
  )
  await cmd.open_vault({ path: VAULT })
})

/** The viewer's verdict, built the way `editor.ts` builds its document. */
async function viewerSecret(rel) {
  const r = decodeNote(await cmd.read_note({ path: rel }))
  return isSecretText(EditorState.create({ doc: r.text }).doc.toString())
}

test('fixtures: the viewer masks exactly the notes it is expected to', async () => {
  for (const [name, [, masked]] of Object.entries(FIXTURES)) {
    assert.equal(await viewerSecret(name + '.md'), masked, name)
  }
})

test('the tree mark agrees with the viewer on every fixture', async () => {
  const marked = new Set(await cmd.secret_notes())
  for (const name of Object.keys(FIXTURES)) {
    const rel = name + '.md'
    assert.equal(marked.has(rel), await viewerSecret(rel), rel)
  }
})

test('search: a masked note reaches no snippet, and an ordinary note still does', async () => {
  const GEN = 7
  const channel = 'search:' + GEN
  await cmd.search_start({ query: 'hunter2', generation: GEN })
  const deadline = Date.now() + 20_000
  while (!events.some((e) => e.event === channel && e.payload?.kind === 'complete')) {
    assert.ok(Date.now() < deadline, 'no search completion within 20 s')
    await new Promise((r) => setTimeout(r, 20))
  }
  const seen = JSON.stringify(events.filter((e) => e.event === channel))
  for (const [name, [, masked]] of Object.entries(FIXTURES)) {
    const rel = name + '.md'
    assert.equal(seen.includes(token(name)), !masked, rel + ' in the search results')
    const expanded = await cmd.search_expand({ query: 'hunter2', rel })
    assert.equal(JSON.stringify(expanded).includes(token(name)), !masked, rel + ' in search_expand')
  }
})
