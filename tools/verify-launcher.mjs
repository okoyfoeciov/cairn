#!/usr/bin/env node
/**
 * tools/verify-launcher.mjs -- the /usr/bin/cairn launcher policies.
 *
 * The launcher is written by tools/package-electron.mjs and, unlike app code,
 * its two flags were each the difference between a window and no window on
 * real hardware; both were too late to set from app-main.mjs. The gate pins
 * the exact shapes that were measured, because every one of them has already
 * been wrong once (2026-09-30):
 *
 *   1. `--ozone-platform=wayland` when a Wayland socket is advertised and no
 *      X display exists. With no X server the default X11 backend dies before
 *      any window; an appendSwitch in app-main was measured too late (still
 *      X11, still dead) while the command-line flag works.
 *
 *   2. `--disable-gpu` when the DRM driver is `virtio-pci`. On the portability
 *      VM the virtio GL path cannot initialise: Chromium's own SwiftShader
 *      fallback never presents a frame, so the window is visible to Electron
 *      (isVisible() true) and absent from the screen -- screenshot-verified in
 *      both states. Software compositing paints reliably. Gated on virtio so a
 *      real adapter keeps hardware acceleration.
 *
 * The gate also asserts app-main.mjs contains no ozone switch of its own: an
 * earlier revision imported a predicate from have-display.mjs, which the .deb
 * does not ship, and the packaged app died with ERR_MODULE_NOT_FOUND while
 * dev and CI stayed green.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const MAIN = join(ROOT, 'electron-shell', 'app-main.mjs')
const PACKAGER = join(ROOT, 'tools', 'package-electron.mjs')

function fail(reason) {
  process.stdout.write(`LAUNCHER result=FAIL reason=${reason}\n`)
  process.exit(1)
}

let packager
try {
  packager = readFileSync(PACKAGER, 'utf8')
} catch {
  fail('packager-unreadable')
}

// 1. Wayland-first when no X display exists.
for (const token of ['--ozone-platform=wayland', 'WAYLAND_DISPLAY:-', 'DISPLAY:-']) {
  if (!packager.includes(token)) fail(`ozone-policy-missing token=${token}`)
}

// 2. Software rendering on a virtio GPU -- and ONLY then.
for (const token of [
  '--disable-gpu',
  'virtio-pci',
  '/sys/class/drm/card[0-9]*/device/driver',
]) {
  if (!packager.includes(token)) fail(`gpu-policy-missing token=${token}`)
}

// 3. app-main.mjs must not choose a backend itself -- too late to matter.
let src
try {
  src = readFileSync(MAIN, 'utf8')
} catch {
  fail('app-main-unreadable')
}
if (src.includes('ozone-platform')) fail('ozone-switch-in-app-main')

process.stdout.write(
  'LAUNCHER result=PASS ozone=wayland-without-x gpu=software-on-virtio app-main=clean\n'
)
process.exit(0)
