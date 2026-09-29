#!/usr/bin/env node
/**
 * tools/package-electron.mjs -- §8.2 step 10, the Electron half.
 *
 * Assembles a launchable application out of the pinned Electron distribution
 * and `electron-shell/`, and optionally wraps it in a `.deb`. It is the
 * Electron equivalent of `cargo tauri build`, and like that command it is
 * followed on macOS by `tools/sign-macos.sh`'s ad-hoc signature.
 *
 * ================== NO `electron-builder`, AND THAT IS DELIBERATE ============
 * Packaging Electron is a directory layout: the prebuilt binary, renamed; your
 * code under `resources/app`; a `package.json` naming the entry point. That is
 * what this file does, in ~200 lines, with no dependency at all.
 * `electron-builder` is ~100 MB of tooling and a configuration language, and it
 * would be the largest dependency in a project whose stated line is "no
 * framework, no bundler beyond esbuild". It also wants to sign, notarise and
 * publish -- three things CONTRACT §9 E5 says this app will never do.
 * ============================================================================
 *
 * WHAT IT REFUSES TO DO. It does not build. `cairn.node` and
 * `electron-shell/app/` must already exist and be current, and it says so
 * rather than quietly packaging a stale artefact -- which is exactly how gate
 * G9 lost a day on 2026-09-08 (docs/PENDING-USER-ACTIONS.md item 1).
 *
 *   node electron-shell/build-native.mjs && node electron-shell/build-app.mjs
 *   node tools/package-electron.mjs [--deb]
 *
 * Output: out/cairn-<platform>-<arch>/ , and out/cairn_<version>_<arch>.deb
 */

import { execFileSync } from 'node:child_process'
import {
  chmodSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync,
  statSync, writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SHELL = join(ROOT, 'electron-shell')
const DIST = join(ROOT, 'node_modules', 'electron', 'dist')
const OUT = join(ROOT, 'out')

const DEB = process.argv.includes('--deb')

/* §9 E1's identity, from `package.json` -- its last home. It lived in
   `tauri.conf.json` until step 10 deleted that file, and there is exactly one
   copy of it: `app-main.mjs` reads the same field for `state.json`'s directory,
   so the bundle and the state file cannot drift apart. */
const conf = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const NAME = conf.productName ?? 'Cairn'
const ID = conf.identifier ?? 'com.cairn.app'
const VERSION = conf.version ?? '0.1.0'
const ARCH = process.arch === 'x64' ? 'x64' : process.arch
const DEB_ARCH = process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : process.arch

const fail = (reason, hint) => {
  console.error(`PACKAGE result=FAIL reason=${reason}`)
  if (hint) console.error('  ' + hint)
  process.exit(1)
}

/* ── the preconditions, checked rather than assumed ───────────────────────── */
if (!existsSync(DIST)) fail('no-electron-dist', 'run npm ci')
if (!existsSync(join(SHELL, 'cairn.node')))
  fail('no-addon', 'run: node electron-shell/build-native.mjs')
if (!existsSync(join(SHELL, 'app', 'index.html')))
  fail('no-bundle', 'run: node electron-shell/build-app.mjs')

/* THE BUNDLE MUST BE SELF-CONTAINED. `build-app.mjs` used to link the stylesheet
   out to `../../src/styles/`, which works from a checkout and renders a
   packaged app completely unstyled with no error. It inlines now; this is the
   assertion that keeps it that way, because the failure is silent and visual
   and nothing else in the build would catch it. */
const indexHtml = readFileSync(join(SHELL, 'app', 'index.html'), 'utf8')
if (indexHtml.includes('../../src/'))
  fail('bundle-not-self-contained', 'electron-shell/app/index.html still links out to src/')

/* ── the app payload: what goes under resources/app ───────────────────────── */
const APP_FILES = [
  'app-main.mjs',
  'native.mjs',
  'preload.cjs',
  'cairn.node',
  'app', // the built frontend: index.html (CSS inlined) + app.js
]

function stageApp(appDir) {
  mkdirSync(join(appDir, 'electron-shell'), { recursive: true })
  for (const f of APP_FILES) cpSync(join(SHELL, f), join(appDir, 'electron-shell', f), { recursive: true })

  /* CONTRACT §5.11's probe, shipped. The Tauri build ships it too --
     `lib.rs:103` compiles it in with `include_str!` -- and gate G10 will need a
     PACKAGED app to measure, so leaving it out would make the shipped artefact
     the one thing that cannot be gated. It is inert without `--pixeltest`. */
  mkdirSync(join(appDir, 'tools'), { recursive: true })
  cpSync(join(ROOT, 'tools', 'verify-geometry.js'), join(appDir, 'tools', 'verify-geometry.js'))

  writeFileSync(
    join(appDir, 'package.json'),
    JSON.stringify(
      {
        name: 'cairn',
        productName: NAME,
        version: VERSION,
        description: conf.description,
        // Electron sets CHROME_DESKTOP (which Chromium uses for the Wayland app_id) from this; it names the installed cairn.desktop.
        desktopName: 'cairn.desktop',
        // ESM, because app-main.mjs is. Electron 39 loads an ESM entry point.
        type: 'module',
        main: 'electron-shell/app-main.mjs',
      },
      null,
      2
    ) + '\n'
  )
}

/* ── Linux ────────────────────────────────────────────────────────────────── */
function packageLinux() {
  const stage = join(OUT, `cairn-linux-${ARCH}`)
  rmSync(stage, { recursive: true, force: true })
  mkdirSync(OUT, { recursive: true })
  cpSync(DIST, stage, { recursive: true, dereference: false })

  // The binary IS the product name on Linux -- it is what shows in `ps`, in the
  // task switcher's fallback label, and in a crash report.
  renameSync(join(stage, 'electron'), join(stage, 'cairn'))
  chmodSync(join(stage, 'cairn'), 0o755)

  // `default_app.asar` is Electron's "no app was supplied" welcome screen. It
  // is dead weight the moment resources/app exists, and leaving it in means a
  // packaging mistake shows up as that screen instead of as an error.
  rmSync(join(stage, 'resources', 'default_app.asar'), { force: true })

  stageApp(join(stage, 'resources', 'app'))
  return stage
}

function buildDeb(stage) {
  const debRoot = join(OUT, `deb-${ARCH}`)
  rmSync(debRoot, { recursive: true, force: true })
  const libDir = join(debRoot, 'usr', 'lib', 'cairn')
  mkdirSync(libDir, { recursive: true })
  cpSync(stage, libDir, { recursive: true })

  mkdirSync(join(debRoot, 'usr', 'bin'), { recursive: true })
  writeFileSync(
    join(debRoot, 'usr', 'bin', 'cairn'),
    '#!/bin/sh\nexec /usr/lib/cairn/cairn "$@"\n'
  )
  chmodSync(join(debRoot, 'usr', 'bin', 'cairn'), 0o755)

  const appsDir = join(debRoot, 'usr', 'share', 'applications')
  mkdirSync(appsDir, { recursive: true })
  writeFileSync(
    join(appsDir, 'cairn.desktop'),
    [
      '[Desktop Entry]',
      'Type=Application',
      `Name=${NAME}`,
      `Comment=${conf.description}`,
      'Exec=/usr/bin/cairn %U',
      'Icon=cairn',
      'Terminal=false',
      `Categories=${conf.category ?? 'Utility'};`,
      'StartupWMClass=Cairn',
      '',
    ].join('\n')
  )

  // The sized PNGs are the shipped assets (core/icons/<n>x<n>.png), derived from
  // core/icons/source/logo-tight-native.png -- the v1_original_blue stone's tight
  // cutout, bbox exactly (0,0,w,h), the dark tile and glow removed (see
  // source/VERSION.json). No bounding box on either platform, just the stone,
  // sized like its dock neighbours, so it reads at the same visual weight as
  // Chrome/VS Code. No scalable SVG source exists for this icon.
  for (const n of [16, 24, 32, 48, 64, 128, 256, 512]) {
    const iconDir = join(debRoot, 'usr', 'share', 'icons', 'hicolor', `${n}x${n}`, 'apps')
    mkdirSync(iconDir, { recursive: true })
    cpSync(join(ROOT, 'core', 'icons', `${n}x${n}.png`), join(iconDir, 'cairn.png'))
  }

  mkdirSync(join(debRoot, 'DEBIAN'), { recursive: true })
  /* NO `Depends:` LINE, AND IT IS A DECISION. A dependency list is a promise
     about machines this package will be installed on, and CONTRACT §9 E5 says
     there is exactly one class of those: machines the author owns and builds on.
     A wrong list turns `dpkg -i` into a puzzle; an omitted one cannot. */
  writeFileSync(
    join(debRoot, 'DEBIAN', 'control'),
    [
      'Package: cairn',
      `Version: ${VERSION}`,
      `Architecture: ${DEB_ARCH}`,
      'Maintainer: Cairn <cairn@localhost>',
      'Priority: optional',
      'Section: editors',
      `Description: ${conf.description}`,
        ' Built locally for the author\u2019s own machines (CONTRACT §9 E5).',
      '',
    ].join('\n')
  )

  /* Chromium's setuid sandbox helper. Debian 13 has unprivileged user
     namespaces on, so Electron takes the namespace sandbox and this is not
     load-bearing today -- but a machine with `kernel.unprivileged_userns_clone`
     off refuses to start at all without it, with a message about the SUID
     helper that reads like a build error. One chmod is cheaper than that. */
  writeFileSync(
    join(debRoot, 'DEBIAN', 'postinst'),
    '#!/bin/sh\nset -e\nchown root:root /usr/lib/cairn/chrome-sandbox || true\n' +
      'chmod 4755 /usr/lib/cairn/chrome-sandbox || true\n'
  )
  chmodSync(join(debRoot, 'DEBIAN', 'postinst'), 0o755)

  // The build umask (and Electron's own 775 dist) would otherwise install group-writable paths under /usr beside a setuid helper.
  execFileSync('find', [debRoot, '-type', 'd', '-exec', 'chmod', '755', '{}', '+'])
  execFileSync('find', [debRoot, '-type', 'f', '-perm', '/111', '-exec', 'chmod', '755', '{}', '+'])
  execFileSync('find', [debRoot, '-type', 'f', '!', '-perm', '/111', '-exec', 'chmod', '644', '{}', '+'])

  const deb = join(OUT, `cairn_${VERSION}_${DEB_ARCH}.deb`)
  rmSync(deb, { force: true })
  execFileSync('fakeroot', ['dpkg-deb', '--build', debRoot, deb], { stdio: 'inherit' })
  return deb
}

/* ── macOS ────────────────────────────────────────────────────────────────
   WRITTEN AND NEVER RUN. K8: nothing in this project has executed on macOS
   since the port began. This is the layout Electron's own distribution already
   has -- `Electron.app`, renamed, with its Info.plist keys replaced and the app
   under Contents/Resources/app -- so it is a rename and four plist keys rather
   than a construction. It is still UNVERIFIED and must be reported as such the
   first time it runs.
   `tools/sign-macos.sh`'s ad-hoc `codesign -s -` is the FINAL signature
   (§9 E5); there is no notarisation step to add. ───────────────────────────── */
function packageMac() {
  /* THE LAYOUT IS `tools/sign-macos.sh`'S, NOT ONE OF MY OWN CHOOSING.
     That script takes a BUNDLE directory and looks for `$BUNDLE/macos/Cairn.app`
     -- the shape `cargo tauri build` emits. An earlier revision of this file put
     the app at `out/cairn-darwin-x64/Cairn.app`, so the very next command in the
     sequence would have failed to find it, on the one machine nobody here can
     reach to try it. Emitting the shape the signer already accepts costs one
     directory and removes a round trip from somebody else's afternoon. */
  const stage = join(OUT, `darwin-${ARCH}`)
  rmSync(stage, { recursive: true, force: true })
  mkdirSync(join(stage, 'macos'), { recursive: true })
  const src = join(DIST, 'Electron.app')
  if (!existsSync(src)) fail('no-electron-app', `expected ${src} -- is this really macOS?`)
  const app = join(stage, 'macos', `${NAME}.app`)
  // `dereference: false` is load-bearing: `Contents/Frameworks/Electron
  // Framework.framework` is a symlink farm, and flattening it breaks both the
  // launch and the signature.
  cpSync(src, app, { recursive: true, dereference: false, verbatimSymlinks: true })

  const contents = join(app, 'Contents')
  renameSync(join(contents, 'MacOS', 'Electron'), join(contents, 'MacOS', NAME))
  rmSync(join(contents, 'Resources', 'default_app.asar'), { force: true })
  // macOS ONLY: `core/icons/icon.icns` is the full-bleed stone-on-dark-tile,
  // because the bare stone gets auto-plated by Tahoe's icon modes -- the tile is
  // drawn by us. Derived from core/icons/source/full-bleed-1024.png via sips +
  // iconutil, all 10 slots. Linux never reads this file (it takes the sized
  // PNGs below).
  cpSync(join(ROOT, 'core', 'icons', 'icon.icns'), join(contents, 'Resources', 'cairn.icns'))
  stageApp(join(contents, 'Resources', 'app'))

  const plist = join(contents, 'Info.plist')
  let text = readFileSync(plist, 'utf8')
  /* TWO FIXES IN FOUR LINES, AND BOTH WOULD HAVE FAILED ON FIRST CONTACT.
     The pattern was `\\\\s` inside a template literal, which reaches the RegExp
     constructor as a LITERAL BACKSLASH followed by `s` and therefore never
     matches an Info.plist -- so every key would have been "missing". And a
     missing key was fatal, which would have aborted the whole package on the
     first one Electron's own plist happens not to carry (`CFBundleDisplayName`
     is the likely one). Missing keys are now INSERTED. */
  const setKey = (key, value) => {
    const re = new RegExp(`(<key>${key}</key>\\s*<string>)[^<]*(</string>)`)
    if (re.test(text)) {
      text = text.replace(re, `$1${value}$2`)
      return
    }
    const at = text.lastIndexOf('</dict>')
    if (at < 0) fail('plist-malformed', 'no </dict> in Info.plist')
    text = `${text.slice(0, at)}\t<key>${key}</key>\n\t<string>${value}</string>\n${text.slice(at)}`
  }
  setKey('CFBundleName', NAME)
  setKey('CFBundleDisplayName', NAME)
  setKey('CFBundleExecutable', NAME)
  setKey('CFBundleIdentifier', ID)
  setKey('CFBundleIconFile', 'cairn.icns')
  setKey('CFBundleShortVersionString', VERSION)
  setKey('CFBundleVersion', VERSION)
  writeFileSync(plist, text)
  return app
}

const du = (p) => {
  try {
    return execFileSync('du', ['-sh', p]).toString().split('\t')[0]
  } catch {
    return statSync(p).size + 'B'
  }
}

if (process.platform === 'linux') {
  const stage = packageLinux()
  const deb = DEB ? buildDeb(stage) : null
  console.log(
    `PACKAGE result=PASS platform=linux arch=${ARCH} app=${stage} size=${du(stage)}` +
      (deb ? ` deb=${deb} size=${du(deb)}` : ' deb=skipped (pass --deb)')
  )
} else if (process.platform === 'darwin') {
  const app = packageMac()
  const bundle = join(OUT, `darwin-${ARCH}`)
  console.log(
    `PACKAGE result=PASS-UNVERIFIED platform=darwin arch=${ARCH} app=${app} size=${du(app)}`
  )
  console.log('  UNVERIFIED: nothing in this project has executed on macOS since the port began (K8).')
  console.log('  Next, in this order:')
  console.log(`    bash tools/sign-macos.sh ${bundle}`)
  console.log(`    open "${app}"`)
  console.log('  The Electron HELPER bundles keep their own name and identifier. Cosmetic')
  console.log('  (Activity Monitor will say "Electron Helper"), and left alone on purpose:')
  console.log('  renaming them means rewriting three more Info.plists inside a framework')
  console.log('  that is about to be re-signed, and that is a change worth making only')
  console.log('  once somebody has watched the unrenamed version launch.')
} else {
  fail('unsupported-platform', process.platform)
}
