// `node --test tests/frontend/*.test.mjs`.
//
// tools/gen-vault.sh --force rebuilds a fixture. It must only ever delete a
// directory this tool generated: a mistyped path that names a real vault is
// otherwise one `--force` away from a permanent `rm -rf`, and the refusal used
// to tell the user to pass exactly that flag.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
const GEN = join(ROOT, 'tools', 'gen-vault.sh')
const SMALL = ['--notes', '5', '--folders', '20']

const gen = (...args) => spawnSync('bash', [GEN, ...args], { encoding: 'utf8' })

function scratch() {
  return mkdtempSync(join(tmpdir(), 'cairn-genvault-'))
}

/** A directory that looks like somebody's vault, not like a fixture. */
function realLookingVault(parent) {
  const dir = join(parent, 'Notes')
  mkdirSync(join(dir, '.obsidian'), { recursive: true })
  writeFileSync(join(dir, 'journal.md'), 'my own words\n')
  writeFileSync(join(dir, '.obsidian', 'app.json'), '{}\n')
  return dir
}

test('--force REFUSES a directory that is not a gen-vault fixture, and deletes nothing', () => {
  const t = scratch()
  try {
    const dir = realLookingVault(t)
    const r = gen(dir, ...SMALL, '--force')
    assert.equal(r.status, 5, 'expected a refusal (exit 5), got ' + r.status + '\n' + r.stdout + r.stderr)
    assert.match(r.stderr, /not a gen-vault fixture/)
    assert.equal(readFileSync(join(dir, 'journal.md'), 'utf8'), 'my own words\n')
    assert.ok(existsSync(join(dir, '.obsidian', 'app.json')))
    assert.ok(!existsSync(join(dir, '.vault-manifest')), 'a manifest was written into a directory that was refused')
  } finally {
    rmSync(t, { recursive: true, force: true })
  }
})

test('without --force, a non-fixture directory is refused WITHOUT advice to pass --force', () => {
  const t = scratch()
  try {
    const dir = realLookingVault(t)
    const r = gen(dir, ...SMALL)
    assert.equal(r.status, 5)
    assert.match(r.stderr, /not a gen-vault fixture/)
    assert.doesNotMatch(r.stderr, /pass --force/)
    assert.equal(readFileSync(join(dir, 'journal.md'), 'utf8'), 'my own words\n')
  } finally {
    rmSync(t, { recursive: true, force: true })
  }
})

test('--force still rebuilds a fixture this tool generated', () => {
  const t = scratch()
  try {
    const dir = join(t, 'fx')
    assert.equal(gen(dir, ...SMALL).status, 0)
    const again = gen(dir, '--notes', '7', '--folders', '20')
    assert.equal(again.status, 5, 'a different shape without --force must be refused')
    assert.match(again.stderr, /pass --force/)
    const r = gen(dir, '--notes', '7', '--folders', '20', '--force')
    assert.equal(r.status, 0, r.stdout + r.stderr)
    const v = gen(dir, '--verify')
    assert.equal(v.status, 0, v.stdout + v.stderr)
    assert.match(v.stdout, /notes=7/)
    assert.ok(!existsSync(join(dir, '.gen-vault-partial')), 'the in-progress marker outlived the generation')
  } finally {
    rmSync(t, { recursive: true, force: true })
  }
})

test('--force cleans up an INTERRUPTED generation, which carries the in-progress marker', () => {
  const t = scratch()
  try {
    const dir = join(t, 'half')
    mkdirSync(dir)
    writeFileSync(join(dir, '.gen-vault-partial'), '')
    writeFileSync(join(dir, 'half-written-note.md'), '# half\n')
    const r = gen(dir, ...SMALL, '--force')
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.ok(!existsSync(join(dir, 'half-written-note.md')))
    assert.equal(gen(dir, '--verify').status, 0)
  } finally {
    rmSync(t, { recursive: true, force: true })
  }
})

test('an EMPTY directory can be generated into with --force', () => {
  const t = scratch()
  try {
    const dir = join(t, 'empty')
    mkdirSync(dir)
    const r = gen(dir, ...SMALL, '--force')
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.equal(gen(dir, '--verify').status, 0)
  } finally {
    rmSync(t, { recursive: true, force: true })
  }
})
