/**
 * electron-shell/package.test.mjs -- §8.2 step 10, Linux.
 *
 * It ASSEMBLES a package and then LAUNCHES it. Assembling is the easy half and
 * proves almost nothing: the failure that matters is a package that builds
 * cleanly and then renders an unstyled page, or cannot find its addon, or
 * refuses to start because the entry point points at a file that was never
 * copied. All three are silent at build time and obvious at launch, so the
 * launch is the test.
 *
 * ~15 s: most of it is copying 288 MB of Electron and booting Chromium
 * offscreen. Nothing reaches the display (CLAUDE.md §3).
 *
 * Run: node --test electron-shell/package.test.mjs
 */

import assert from 'node:assert/strict'
import { test, before } from 'node:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { NO_DISPLAY } from './have-display.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const STAGE = join(ROOT, 'out', `cairn-linux-${process.arch === 'x64' ? 'x64' : process.arch}`)

const SKIP =
  process.platform !== 'linux'
    ? 'the LINUX packager specifically: this file asserts the out/cairn-linux-<arch> ' +
      'stage layout and the .deb it becomes. K8 IS ANSWERED — macOS packaged, ' +
      'ad-hoc signed and launched on 2026-09-09 — so the old reason for this skip ' +
      '("macOS is UNVERIFIED") is retired and no longer true. What is left is that ' +
      'the macOS artefact has a different shape (out/darwin-<arch>/macos/Cairn.app) ' +
      'and needs its own assertions, and that packaging is OUT OF SCOPE for the ' +
      'development phase by user ruling. Not blocked — descoped, and say so'
    : !existsSync(join(HERE, 'cairn.node'))
      ? 'no cairn.node; run npm run electron:native'
      : !existsSync(join(HERE, 'app', 'index.html'))
        ? 'no bundle; run node electron-shell/build-app.mjs'
        : NO_DISPLAY

before(() => {
  if (SKIP) return
  execFileSync(process.execPath, [join(ROOT, 'tools', 'package-electron.mjs')], {
    cwd: ROOT,
    stdio: 'pipe',
  })
})

test('the built bundle is SELF-CONTAINED — no path climbs back into the repo', { skip: SKIP }, () => {
  /* THE SILENT ONE. `build-app.mjs` used to emit six
     `<link href="../../src/styles/…">`, which works from a checkout and renders
     a packaged app COMPLETELY UNSTYLED with no console error, no CSP violation
     and no failed build. Nothing else in the toolchain would notice. */
  const html = readFileSync(join(HERE, 'app', 'index.html'), 'utf8')
  assert.doesNotMatch(html, /\.\.\/\.\.\/src\//, 'index.html still links out to src/')
  assert.match(html, /<style>/, 'the stylesheet is not inlined')
  assert.ok(html.length > 20_000, 'index.html is too small to contain the sheet')
})

test('the staged package is complete and its entry point exists', { skip: SKIP }, () => {
  const app = join(STAGE, 'resources', 'app')
  const pkg = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'))

  // An entry point that does not exist is Electron's most confusing failure:
  // it falls back to the welcome screen, or errors about a module deep inside
  // its own bootstrap.
  assert.ok(existsSync(join(app, pkg.main)), `package.json main (${pkg.main}) does not exist`)
  assert.equal(pkg.type, 'module', 'app-main.mjs is ESM; the package must say so')

  for (const f of ['electron-shell/native.mjs', 'electron-shell/preload.cjs', 'electron-shell/cairn.node', 'electron-shell/app/app.js', 'tools/verify-geometry.js']) {
    assert.ok(existsSync(join(app, f)), 'missing from the package: ' + f)
  }

  // The binary is the product name -- it is what shows in `ps` and in a crash
  // report -- and it must be executable.
  const bin = statSync(join(STAGE, 'cairn'))
  assert.ok(bin.mode & 0o111, 'the packaged binary is not executable')

  /* Electron's "no app was supplied" welcome screen. Left in, a packaging
     mistake renders THAT instead of failing, which is the difference between a
     five-minute bug and an afternoon. */
  assert.ok(
    !existsSync(join(STAGE, 'resources', 'default_app.asar')),
    'default_app.asar was not removed'
  )
})

test('the PACKAGED app boots, renders the vault, and writes a note to disk', { skip: SKIP }, () => {
  const work = mkdtempSync(join(tmpdir(), 'cairn-pkg-'))
  try {
  const vault = join(work, 'vault')
  mkdirSync(vault, { recursive: true })
  writeFileSync(join(vault, 'Welcome.md'), '# Welcome\n\nfirst note\n')

  /* THE REAL TEST. It drives the shipped binary, not the checkout: a real tree
     row click, a real contenteditable insertion, then the BYTES ON DISK --
     because an editor that shows the edit and never writes it is exactly the
     failure a package can introduce (a missing addon, a stale bundle, an entry
     point that resolved to the welcome screen). */
  const r = spawnSync(join(STAGE, 'cairn'), [], {
    env: {
      ...process.env,
      CAIRN_HEADLESS: '1',
      CAIRN_BOOT_PROBE: '1',
      CAIRN_TYPE_PROBE: '1',
      CAIRN_VAULT: vault,
      CAIRN_STATE_DIR: work,
      CAIRN_ELECTRON_GEOM: '',
    },
    encoding: 'utf8',
    timeout: 120_000,
  })

  const line = (tag) => (r.stdout ?? '').split('\n').find((l) => l.startsWith(tag + ' '))
  const boot = line('BOOT_PROBE')
  assert.ok(boot, `the packaged app never reported\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`)
  const probe = JSON.parse(boot.slice('BOOT_PROBE '.length))

  assert.equal(probe.codeMirrorMounted, true, 'CodeMirror did not mount in the package')
  assert.equal(probe.vaultName, 'vault', 'the vault did not open')
  assert.ok(probe.treeRowNames.includes('Welcome'), 'the tree did not render the note')
  // Unstyled would show up here: the tree scroller gets its height from the CSS.
  assert.ok(probe.scrollerClientHeight > 100, 'the tree scroller has no height -- unstyled?')

  const disk = JSON.parse(line('TYPE_PROBE_DISK').slice('TYPE_PROBE_DISK '.length))
  assert.equal(disk.containsTypedText, true, 'the packaged app did not autosave to disk')

  assert.ok(existsSync(join(work, 'state.json')), '§7.6 was not written by the packaged app')
  } finally {
    try { rmSync(work, { recursive: true, force: true }) } catch {}
  }
})
