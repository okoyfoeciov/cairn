#!/usr/bin/env node
/**
 * tools/verify-ozone-wayland.mjs -- the Wayland-first launcher guard.
 *
 * MEASURED 2026-09-30 on a fresh Debian 13/GNOME install: with no X display
 * in the environment the default backend is X11 and the launch dies before
 * any window exists, while the identical launch with
 * `--ozone-platform=wayland` opens at once.
 *
 * The guard lives in the /usr/bin/cairn launcher written by
 * tools/package-electron.mjs -- NOT in app-main.mjs. Chromium reads the
 * ozone backend before app code runs: an appendSwitch at the top of
 * app-main.mjs was measured too late (still X11, still dead) while the
 * identical command-line flag works. An earlier revision also imported a
 * predicate from have-display.mjs, which the .deb does not ship, so the
 * packaged app died with ERR_MODULE_NOT_FOUND while dev and CI stayed
 * green. This gate pins the shape that survives both failures:
 *
 *   1. the wrapper forces `--ozone-platform=wayland` exactly when a Wayland
 *      socket is advertised and no X display exists;
 *   2. app-main.mjs contains no ozone switch of its own (the too-late call
 *      must not come back).
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const MAIN = join(ROOT, 'electron-shell', 'app-main.mjs')
const PACKAGER = join(ROOT, 'tools', 'package-electron.mjs')

function fail(reason) {
  process.stdout.write(`OZONE-WAYLAND result=FAIL reason=${reason}\n`)
  process.exit(1)
}

let packager
try {
  packager = readFileSync(PACKAGER, 'utf8')
} catch {
  fail('packager-unreadable')
}

// 1. The wrapper: Wayland socket advertised, X display absent, flag first.
for (const token of [
  '--ozone-platform=wayland',
  'WAYLAND_DISPLAY:-',
  'DISPLAY:-',
  "'usr', 'bin', 'cairn'",
]) {
  if (!packager.includes(token)) fail(`wrapper-missing token=${token}`)
}

// 2. app-main.mjs must not choose a backend itself -- too late to matter.
let src
try {
  src = readFileSync(MAIN, 'utf8')
} catch {
  fail('app-main-unreadable')
}
if (src.includes('ozone-platform')) fail('ozone-switch-in-app-main')

process.stdout.write(
  'OZONE-WAYLAND result=PASS launcher=wayland-without-x app-main=clean\n'
)
process.exit(0)
