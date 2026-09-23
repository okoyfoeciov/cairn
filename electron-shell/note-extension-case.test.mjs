/**
 * F53 -- a note whose extension is not
 * a lowercase `.md` (`Foo.MD`, `x.Md`) through the REAL encoder (`tree.rs`),
 * the REAL decoder (`src/treeblob.ts`) and the REAL commands, over the addon.
 *
 * Such a file is a note: the scanner admits `.md` in any ASCII case, and so
 * does Obsidian (its `extension` is the suffix lowercased).  The blob carries
 * only the stem, so the path a tree row hands to every command is rebuilt from
 * it -- and it must be the file's own on-disk name.  Rebuilt as `Foo.md` it
 * named nothing (notFound, the row could not be opened), and beside a real
 * `Foo.md` on a case-sensitive disk it named the SIBLING: a delete from one
 * row removed the other file.
 *
 * Run: node --test electron-shell/note-extension-case.test.mjs
 * (`electron-shell/cairn.node` must exist: node electron-shell/build-native.mjs)
 */

import assert from 'node:assert/strict'
import { test, before } from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

import { loadAddon, nativeCommands } from './native.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

const outDir = mkdtempSync(join(tmpdir(), 'cairn-extcase-test-'))
// realpath'd: the core stores canonical roots (see native.test.mjs).
const work = realpathSync(mkdtempSync(join(tmpdir(), 'cairn-extcase-vault-')))
process.on('exit', () => {
  for (const d of [outDir, work]) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {}
  }
})
const outFile = join(outDir, 'treeblob.mjs')
esbuild.buildSync({
  entryPoints: [join(ROOT, 'src', 'treeblob.ts')],
  outfile: outFile,
  format: 'esm',
  bundle: false,
})
const { adopt } = await import(pathToFileURL(outFile).href)
const { decodeNote } = await import(pathToFileURL(join(ROOT, 'src', 'note_frame.js')).href)

const addon = loadAddon()
const cmd = nativeCommands(addon)

const VAULT = join(work, 'vault')
/** On-disk rel -> body.  Filled in `before`, once the filesystem has answered
 *  whether `Dup.md` and `Dup.MD` can both exist. */
const BODY = new Map()
let caseSensitive = false

before(() => {
  mkdirSync(join(VAULT, 'Sub'), { recursive: true })
  const put = (rel, body) => {
    writeFileSync(join(VAULT, rel), body)
    BODY.set(rel, body)
  }
  put('Foo.MD', 'foo body\n')
  put('x.Md', 'x body\n')
  put('Sub/inner.mD', 'inner body\n')
  put('plain.md', 'plain body\n')
  writeFileSync(join(VAULT, 'Dup.md'), 'LOWER, the one with content\n')
  writeFileSync(join(VAULT, 'Dup.MD'), 'UPPER, the stale duplicate\n')
  // Detected, not assumed: macOS's default folds the pair into one file.
  caseSensitive = readdirSync(VAULT).includes('Dup.md') && readdirSync(VAULT).includes('Dup.MD')
  if (caseSensitive) {
    BODY.set('Dup.md', 'LOWER, the one with content\n')
    BODY.set('Dup.MD', 'UPPER, the stale duplicate\n')
  } else {
    const [only] = readdirSync(VAULT).filter((n) => n.toLowerCase() === 'dup.md')
    BODY.set(only, readFileSync(join(VAULT, only), 'utf8'))
  }
  addon.start(() => {}, () => {}, join(work, 'state.json'))
})

const snapshot = async () => adopt(await cmd.tree_snapshot())
const filesOf = (blob) => {
  const out = []
  for (let i = 0; i < blob.n; i++) if (!blob.isDir(i)) out.push(i)
  return out
}

test('every note row rebuilds to its own on-disk name and reads its own body', async () => {
  await cmd.open_vault({ path: VAULT })
  const blob = await snapshot()
  const paths = filesOf(blob).map((i) => blob.pathOf(i))
  assert.equal(new Set(paths).size, paths.length, `two rows share a path: ${paths}`)
  assert.deepEqual([...paths].sort(), [...BODY.keys()].sort())
  for (const i of filesOf(blob)) {
    const p = blob.pathOf(i)
    assert.equal(blob.nameOf(i), p.slice(p.lastIndexOf('/') + 1, -3), 'the row still draws the stem')
    const r = decodeNote(await cmd.read_note({ path: p }))
    assert.equal(r.text, BODY.get(p), `${p} read another file's text`)
  }
})

test('a delete from the Dup.MD row removes Dup.MD and leaves Dup.md alone', async (t) => {
  if (!caseSensitive) {
    t.skip('this filesystem folds Dup.md and Dup.MD into one file')
    return
  }
  await cmd.open_vault({ path: VAULT })
  const blob = await snapshot()
  const dups = filesOf(blob).filter((i) => blob.nameOf(i) === 'Dup')
  assert.equal(dups.length, 2, 'both files are rows')
  const [a, b] = dups.map((i) => blob.pathOf(i))
  assert.notEqual(a, b, 'both Dup rows address the same file')
  const bodyA = decodeNote(await cmd.read_note({ path: a })).text
  await cmd.delete_entry({ path: b, permanent: true })
  assert.deepEqual(readdirSync(VAULT).filter((n) => n.startsWith('Dup.')), [a],
    'the delete removed the file the OTHER row reads')
  assert.equal(readFileSync(join(VAULT, a), 'utf8'), bodyA)
})

test('a lone Foo.MD renames from its row', async () => {
  await cmd.open_vault({ path: VAULT })
  const blob = await snapshot()
  const [i] = filesOf(blob).filter((k) => blob.nameOf(k) === 'Foo')
  const r = await cmd.rename_entry({ path: blob.pathOf(i), new_name: 'Renamed.md' })
  assert.equal(r.path, 'Renamed.md')
  assert.equal(readFileSync(join(VAULT, 'Renamed.md'), 'utf8'), 'foo body\n')
  assert.ok(!readdirSync(VAULT).includes('Foo.MD'))
})
