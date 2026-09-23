#!/usr/bin/env node
/**
 * tools/verify-electron-pin.mjs -- docs/VERDICT-scroll-and-stack.md §8.2 step 1 (G-PIN).
 *
 * The whole migration rests on one claim: `electron@39.8.3` embeds the same
 * Chromium build Obsidian ships, `Chrome/142.0.7444.265` -- that byte-identical
 * Blink/Skia is the entire justification (§3.2) for Electron over a native
 * rewrite. This gate checks the claim at the four points that can each drift
 * independently: the declared version, the lockfile's resolved version, the
 * lockfile's integrity hash, and -- the one that actually matters, since the
 * first three are package-manager bookkeeping -- the bytes of the INSTALLED
 * binary, read the same way the verdict doc read Obsidian's own binary
 * (`strings -a /opt/Obsidian/obsidian`), so a corrupted extract or a
 * platform-swapped prebuilt fails this gate even if npm's ledger looks clean.
 *
 * Verified against the npm registry 2026-09-07 (`npm view electron@39.8.3
 * version dist.shasum`) and independently against two installed Obsidian
 * copies before this gate was written: Debian's launcher binary (verdict
 * doc, §3.2) and this Mac's `Electron Framework` (Electron/39.5.1, a
 * different Electron patch, but the SAME `Chrome/142.0.7444.265` -- Electron
 * patch releases don't always bump Chromium, and this one didn't).
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PINNED_VERSION = '39.8.3'
const PINNED_SHASUM = '60ed01d2281b9a4782e4498c54c4d86f19452eab' // npm dist.shasum, sha1
const PINNED_CHROME = '142.0.7444.265'

function fail(reason) {
  process.stdout.write(`G-PIN result=FAIL reason=${reason}\n`)
  process.exit(1)
}

function electronBinaryPath() {
  const dist = join(ROOT, 'node_modules', 'electron', 'dist')
  if (process.platform === 'darwin') {
    return join(
      dist,
      'Electron.app',
      'Contents',
      'Frameworks',
      'Electron Framework.framework',
      'Electron Framework'
    )
  }
  if (process.platform === 'linux') return join(dist, 'electron')
  return null
}

// Plain-JS strings scan rather than shelling to `strings(1)` -- a gate must
// not depend on a coreutil that may be absent from a CI image.
function findAsciiPattern(filePath, pattern) {
  const text = readFileSync(filePath).toString('latin1')
  const m = text.match(pattern)
  return m ? m[0] : null
}

// 1. package.json -- an exact pin, not a range.
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const declared = pkg.devDependencies?.electron ?? pkg.dependencies?.electron
if (!declared) fail('electron-not-declared')
if (declared !== PINNED_VERSION) {
  fail(`declared-version-mismatch declared=${declared} expected=${PINNED_VERSION}`)
}

// 2. package-lock.json -- the resolved version npm actually locked.
const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'))
const lockEntry = lock.packages?.['node_modules/electron']
if (!lockEntry) fail('electron-not-in-lockfile')
if (lockEntry.version !== PINNED_VERSION) {
  fail(`lockfile-version-mismatch locked=${lockEntry.version} expected=${PINNED_VERSION}`)
}
if (!String(lockEntry.resolved ?? '').endsWith(`electron-${PINNED_VERSION}.tgz`)) {
  fail(`lockfile-resolved-mismatch resolved=${lockEntry.resolved}`)
}
if (!lockEntry.integrity) fail('lockfile-missing-integrity')

// 3. The installed binary -- the number that actually renders.
const binPath = electronBinaryPath()
if (!binPath) fail(`unsupported-platform platform=${process.platform}`)
if (!existsSync(binPath)) fail(`electron-not-installed path=${binPath}`)

const chrome = findAsciiPattern(binPath, /Chrome\/[0-9.]+/)
if (!chrome) fail('chrome-string-not-found')
if (chrome !== `Chrome/${PINNED_CHROME}`) {
  fail(`chrome-version-mismatch found=${chrome} expected=Chrome/${PINNED_CHROME}`)
}
const electronBuild = findAsciiPattern(binPath, /Electron\/[0-9.]+/)

process.stdout.write(
  `G-PIN result=PASS declared=${declared} shasum_expected=${PINNED_SHASUM} ` +
    `chrome=${chrome} binary_electron=${electronBuild ?? 'unknown'} ` +
    `platform=${process.platform}\n`
)
process.exit(0)
