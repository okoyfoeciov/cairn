/**
 * F58 -- a rebuild must not crash a Cairn
 * that is running from this checkout.
 *
 * A child `node` loads `electron-shell/cairn.node` (the path every dev launch
 * and every engine test loads), opens a vault and reads a note. Then the real
 * `build-native.mjs` runs -- with a warm cargo cache that is a no-op rebuild,
 * so the published bytes are IDENTICAL -- and the child calls into the addon
 * again. Written into the loaded inode, even identical bytes kill it: the
 * truncate discards the process's relocated copy-on-write pages. Published by
 * rename, the child keeps the inode it loaded and carries on.
 *
 * Needs cargo and a built addon; skipped with a reason otherwise. It rebuilds
 * `electron-shell/cairn.node` as a side effect, which is what
 * `npm run electron:native` would have produced.
 *
 * Run: node --test electron-shell/addon-rebuild.test.mjs
 */

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ADDON = join(HERE, 'cairn.node')
const hasCargo = spawnSync('cargo', ['--version'], { stdio: 'ignore' }).status === 0
const SKIP = !existsSync(ADDON)
  ? 'no cairn.node -- run node electron-shell/build-native.mjs'
  : !hasCargo
    ? 'no cargo on PATH'
    : false

const CHILD = `
const addon = require(process.argv[2])
const vault = process.argv[3]
addon.start(() => {}, () => {}, null)
;(async () => {
  await addon.openVault(vault)
  await addon.readNote('a.md')
  process.stdout.write('READY\\n')
  process.stdin.once('data', async () => {
    await addon.writeNote('a.md', new TextEncoder().encode('edited after rebuild\\n'), 0, null, false)
    await addon.readNote('a.md')
    process.stdout.write('WROTE\\n')
    process.exit(0)
  })
})().catch((e) => { process.stdout.write('ERROR ' + e.message + '\\n'); process.exit(3) })
`

test('a rebuild publishes a new cairn.node and a process that loaded the old one keeps working', {
  skip: SKIP,
  timeout: 600_000,
}, async () => {
  const work = mkdtempSync(join(tmpdir(), 'cairn-addon-rebuild-'))
  const vault = join(work, 'vault')
  mkdirSync(vault, { recursive: true })
  writeFileSync(join(vault, 'a.md'), 'hello\n')
  const script = join(work, 'child.cjs')
  writeFileSync(script, CHILD)

  const child = spawn(process.execPath, [script, ADDON, vault], { stdio: ['pipe', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { err += d })
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('child never loaded the addon\n' + out + err)), 30_000)
      child.stdout.on('data', () => { if (out.includes('READY')) { clearTimeout(t); resolve() } })
      child.on('exit', () => { clearTimeout(t); reject(new Error('child exited early\n' + out + err)) })
    })

    const inoBefore = statSync(ADDON).ino
    const build = spawnSync(process.execPath, [join(HERE, 'build-native.mjs')], {
      encoding: 'utf8',
      timeout: 540_000,
    })
    assert.equal(build.status, 0, 'build-native.mjs failed:\n' + build.stdout + build.stderr)
    assert.match(build.stdout, /BUILD-NATIVE result=PASS/)
    assert.notEqual(statSync(ADDON).ino, inoBefore,
      'cairn.node kept its inode: the build wrote into the file running processes have mapped')

    child.stdin.write('go\n')
    let timer
    const r = await Promise.race([
      exited,
      new Promise((resolve) => { timer = setTimeout(() => resolve({ code: 'timeout', signal: null }), 30_000) }),
    ])
    clearTimeout(timer)
    assert.equal(r.signal, null, `the child was killed by ${r.signal} on its first addon call after the rebuild\n${err}`)
    assert.equal(r.code, 0, 'the child did not finish its write\n' + out + err)
    assert.match(out, /WROTE/)
    assert.equal(readFileSync(join(vault, 'a.md'), 'utf8'), 'edited after rebuild\n')
  } finally {
    try { child.kill('SIGKILL') } catch {}
    rmSync(work, { recursive: true, force: true })
  }
})
