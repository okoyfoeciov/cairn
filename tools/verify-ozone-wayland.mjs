#!/usr/bin/env node
/**
 * tools/verify-ozone-wayland.mjs -- the Wayland-first guard in app-main.mjs.
 *
 * MEASURED 2026-09-30 on a fresh Debian 13/GNOME install: with no X display
 * in the environment the default backend is X11 and the launch dies before
 * any window exists, while the identical launch with
 * `--ozone-platform=wayland` opens at once. The guard forces that switch
 * exactly in the broken configuration and leaves every working setup alone.
 *
 * This gate pins the guard's three properties, because each has already been
 * the wrong value once: the switch itself (an env var was measured IGNORED
 * on this build while the command-line switch works), the condition (the
 * `WAYLAND_WITHOUT_X` predicate, imported from `have-display.mjs` -- the
 * display check may be spelled in exactly one file and
 * `shell-syntax.test.mjs` enforces it), and the placement (before `ready`,
 * after which Chromium has already chosen).
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SHELL = join(ROOT, 'electron-shell')
const MAIN = join(SHELL, 'app-main.mjs')
const OWNER = join(SHELL, 'have-display.mjs')
const PACKAGER = join(ROOT, 'tools', 'package-electron.mjs')

function fail(reason) {
  process.stdout.write(`OZONE-WAYLAND result=FAIL reason=${reason}\n`)
  process.exit(1)
}

let src
try {
  src = readFileSync(MAIN, 'utf8')
} catch {
  fail('app-main-unreadable')
}

// 1. The switch, on the command line (not an env var).
if (!src.includes("appendSwitch('ozone-platform', 'wayland')")) {
  fail('wayland-switch-missing')
}

// 2. The condition, imported -- never spelled here.
if (!src.includes("from './have-display.mjs'") || !src.includes('WAYLAND_WITHOUT_X')) {
  fail('predicate-not-imported')
}
if (src.includes('WAYLAND_DISPLAY')) fail('predicate-spelled-locally')

// 3. The owner really owns it, so this cannot pass by rename.
let owner
try {
  owner = readFileSync(OWNER, 'utf8')
} catch {
  fail('have-display-unreadable')
}
if (!owner.includes('WAYLAND_WITHOUT_X')) fail('predicate-missing-in-owner')

// 4. Placement: before `ready`, so Chromium has not chosen yet.
const switchAt = src.indexOf("appendSwitch('ozone-platform', 'wayland')")
const readyAt = src.indexOf('app.whenReady')
if (readyAt === -1) fail('whenReady-not-found')
if (!(switchAt < readyAt)) fail('switch-after-ready')

// 5. Packaging: the import must resolve in the SHIPPED app, where only
// APP_FILES exists. An import of a checkout-only file passes every dev and
// CI check and dies on launch with ERR_MODULE_NOT_FOUND (2026-09-30).
let packager
try {
  packager = readFileSync(PACKAGER, 'utf8')
} catch {
  fail('packager-unreadable')
}
if (!packager.includes("'have-display.mjs'")) fail('have-display-not-packaged')

process.stdout.write(
  'OZONE-WAYLAND result=PASS switch=ozone-platform/wayland ' +
    'condition=imported placement=before-ready\n'
)
process.exit(0)
