#!/usr/bin/env node
/**
 * tools/verify-ozone-wayland.mjs -- the Wayland-first guard in app-main.mjs.
 *
 * MEASURED 2026-09-30 on a fresh Debian 13/GNOME install: with `DISPLAY`
 * unset the default backend is X11 and the launch dies before any window
 * exists (`Missing X server or $DISPLAY`, then a segfault), while the
 * identical launch with `--ozone-platform=wayland` opens at once. The guard
 * forces that switch exactly in the broken configuration -- a Wayland session
 * whose XWayland isn't up yet -- and leaves every working setup alone.
 *
 * This gate pins the guard's three properties, because each has already been
 * the wrong value once: the switch itself (an env var was measured IGNORED on
 * this build while the command-line switch works), the condition (Wayland
 * advertised AND X11 absent -- forcing Wayland when `DISPLAY` is set would
 * move every working machine onto an untested path), and the placement (it
 * must run before `ready`, after which Chromium has already chosen).
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const MAIN = join(ROOT, 'electron-shell', 'app-main.mjs')

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

// 2. The condition: Linux, Wayland advertised, X11 absent.
for (const token of [
  "process.platform === 'linux'",
  'process.env.WAYLAND_DISPLAY',
  '!process.env.DISPLAY',
]) {
  if (!src.includes(token)) fail(`condition-missing token=${token}`)
}

// 3. Placement: before `ready`, so Chromium has not chosen yet.
const switchAt = src.indexOf("appendSwitch('ozone-platform', 'wayland')")
const readyAt = src.indexOf('app.whenReady')
if (readyAt === -1) fail('whenReady-not-found')
if (!(switchAt < readyAt)) fail('switch-after-ready')

process.stdout.write(
  'OZONE-WAYLAND result=PASS switch=ozone-platform/wayland ' +
    'condition=wayland-without-x placement=before-ready\n'
)
process.exit(0)
