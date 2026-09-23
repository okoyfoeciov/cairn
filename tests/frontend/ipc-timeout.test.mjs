/**
 * tests/frontend/ipc-timeout.test.mjs — F91's renderer half.
 *
 * A write that outlives the 30 s IPC timeout keeps running in Rust; rejecting
 * early would release the write chain, and the next autosave would go out
 * with the same base mtime while the first can still land after it. So
 * `write_note` (like the user-paced `pick_vault`) is never raced, while every
 * other command still rejects after 30 s. Timer-mocked: the 30 s timeout is
 * advanced instantly instead of waited out.
 */

import { test, before, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '..', '..')

/** @type {any} */ let IPC

before(async () => {
  const esbuild = await import(pathToFileURL(join(ROOT, 'node_modules', 'esbuild', 'lib', 'main.js')).href)
  const dir = mkdtempSync(join(tmpdir(), 'cairn-ipc-'))
  process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })
  const out = join(dir, 'bundle.mjs')
  await esbuild.build({
    stdin: {
      contents: 'export * from ' + JSON.stringify(join(ROOT, 'src', 'ipc.ts')) + '\n',
      resolveDir: ROOT,
      sourcefile: 'ipc-test-entry.ts',
      loader: 'ts',
    },
    outfile: out, bundle: true, format: 'esm', platform: 'neutral',
    mainFields: ['module', 'main'], conditions: ['import', 'default'],
    target: 'es2021', absWorkingDir: ROOT, logLevel: 'silent',
  })
  IPC = await import(pathToFileURL(out).href)
})

test('F91: write_note waits past the 30 s timeout; other commands reject', async () => {
  mock.timers.enable({ apis: ['setTimeout'], now: 0 })
  try {
    const hanging = () => new Promise(() => {})
    globalThis.cairn = { invoke: hanging }

    let writeSettled = 'pending'
    const w = IPC.writeNote('a.md', 'x\n', 0, 1000, false).then(
      () => { writeSettled = 'resolved' },
      () => { writeSettled = 'rejected' },
    )
    let readSettled = 'pending'
    const r = IPC.readNote('a.md').then(
      () => { readSettled = 'resolved' },
      (e) => { readSettled = 'rejected:' + (e && e.kind) },
    )
    await Promise.resolve()
    mock.timers.tick(31_000)
    for (let i = 0; i < 10; i += 1) await Promise.resolve()
    assert.equal(writeSettled, 'pending', 'write_note raced the timeout: ' + writeSettled)
    assert.match(readSettled, /^rejected:io/, 'other commands must still time out: ' + readSettled)
    void w
    void r
  } finally {
    mock.timers.reset()
    delete globalThis.cairn
  }
})
