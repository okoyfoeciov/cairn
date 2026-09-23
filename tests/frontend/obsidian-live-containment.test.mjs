// `node --test tests/frontend/*.test.mjs`.
//
// tools/obsidian-live.mjs opens a vault in a throwaway Obsidian profile, and
// Obsidian writes `.obsidian/workspace.json` into any vault it opens. So a
// vault outside the temp dir is refused whether or not `--config-from` is
// given; the refusal is argument validation and happens before Obsidian is
// looked for, so this runs on a machine without it.
//
// HOME is redirected, so even a regression that got past the refusal could not
// find the user's Obsidian config (the tool reads the asar from there before it
// launches anything).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
const TOOL = join(ROOT, 'tools', 'obsidian-live.mjs')

function fixture() {
  const t = mkdtempSync(join(tmpdir(), 'cairn-obslive-test-'))
  mkdirSync(join(t, 'tmp'))
  mkdirSync(join(t, 'home'))
  // The stand-in for a real vault: NOT under the child's temp dir.
  mkdirSync(join(t, 'vault'))
  writeFileSync(join(t, 'vault', 'note.md'), '# note\n')
  mkdirSync(join(t, 'src', '.obsidian'), { recursive: true })
  writeFileSync(join(t, 'src', '.obsidian', 'app.json'), '{}\n')
  return t
}

function run(t, extra) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [TOOL, '--vault', join(t, 'vault'), '--open', 'note', '--eval', '1',
      '--port', '1', ...extra], {
      env: { ...process.env, TMPDIR: join(t, 'tmp'), HOME: join(t, 'home') },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
    let err = ''
    child.stderr.on('data', (d) => { err += d })
    child.stdout.on('data', () => {})
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL') } catch {}
    }, 20_000)
    child.on('close', (code, signal) => { clearTimeout(timer); done({ code, signal, err }) })
  })
}

test('a vault outside the temp dir is REFUSED even without --config-from', async () => {
  const t = fixture()
  try {
    const r = await run(t, [])
    assert.equal(r.code, 2, 'expected a refusal (exit 2), got ' + r.code + '/' + r.signal + '\n' + r.err)
    assert.match(r.err, /REFUSED/)
    assert.ok(!existsSync(join(t, 'vault', '.obsidian')), 'something was written into the vault')
  } finally {
    rmSync(t, { recursive: true, force: true })
  }
})

test('a vault outside the temp dir is REFUSED with --config-from, and nothing is copied in', async () => {
  const t = fixture()
  try {
    const r = await run(t, ['--config-from', join(t, 'src')])
    assert.equal(r.code, 2, 'expected a refusal (exit 2), got ' + r.code + '/' + r.signal + '\n' + r.err)
    assert.match(r.err, /REFUSED/)
    assert.ok(!existsSync(join(t, 'vault', '.obsidian')), 'the config was copied into the vault')
  } finally {
    rmSync(t, { recursive: true, force: true })
  }
})

test('the temp dir ITSELF is not a vault either', async () => {
  const t = fixture()
  try {
    const child = await new Promise((done) => {
      const c = spawn(process.execPath, [TOOL, '--vault', join(t, 'tmp'), '--eval', '1', '--port', '1'], {
        env: { ...process.env, TMPDIR: join(t, 'tmp'), HOME: join(t, 'home') },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      })
      let err = ''
      c.stderr.on('data', (d) => { err += d })
      c.stdout.on('data', () => {})
      const timer = setTimeout(() => { try { process.kill(-c.pid, 'SIGKILL') } catch {} }, 20_000)
      c.on('close', (code) => { clearTimeout(timer); done({ code, err }) })
    })
    assert.equal(child.code, 2, child.err)
    assert.match(child.err, /REFUSED/)
    assert.ok(!existsSync(join(t, 'tmp', '.obsidian')))
  } finally {
    rmSync(t, { recursive: true, force: true })
  }
})
