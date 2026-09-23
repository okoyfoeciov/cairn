#!/usr/bin/env node
/**
 * electron-shell/build-native.mjs -- §8.2 step 5's build step.
 *
 * Builds `core/napi` and publishes the cdylib to `electron-shell/cairn.node`
 * by rename (see `replace-file.mjs`): a Cairn running from this checkout has
 * that file mapped, and writing into it would crash it.
 * Nothing else in this directory compiles Rust, and `app-main.mjs` refuses to
 * start without the artefact this produces.
 *
 * RELEASE BY DEFAULT, and that is not a performance preference. `core`'s
 * `[profile.release]` is what CONTRACT §6.2 pins -- `opt-level = "s"` with
 * `memchr` at 3 for gate G4's search budget, `panic = "unwind"` so a panic
 * inside a command cannot take the window and the user's unsaved buffer with
 * it -- and because `core/Cargo.toml` is the WORKSPACE ROOT, that profile
 * governs this crate too. A debug addon would be a different engine from the
 * one the gates describe. `--debug` builds one anyway, for debugging.
 *
 * IT VERIFIES THE THING THE PORT IS FOR. `cargo tree` over the addon must
 * contain no `tauri` crate at any depth. That is a one-line check and it is
 * the whole claim of §8.1 -- if it ever fails, the Electron shell has quietly
 * grown a dependency on the engine it exists to leave.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { replaceFileAtomically } from './replace-file.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const CRATE = join(ROOT, 'core')
const DEBUG = process.argv.includes('--debug')
const PROFILE = DEBUG ? 'debug' : 'release'

// `libcairn_napi.so` on Linux, `.dylib` on macOS. Both are loaded by Node under
// the name `cairn.node`; the extension is Node's convention, not the platform's,
// and `process.dlopen` does not care what the file is called.
const LIB = process.platform === 'darwin' ? 'libcairn_napi.dylib' : 'libcairn_napi.so'
const OUT = join(HERE, 'cairn.node')

const run = (args) =>
  execFileSync('cargo', args, { cwd: CRATE, stdio: ['ignore', 'pipe', 'inherit'] }).toString()

try {
  run(['build', '-p', 'cairn-napi', ...(DEBUG ? [] : ['--release'])])
} catch {
  console.error('BUILD-NATIVE result=FAIL reason=cargo-build')
  process.exit(1)
}

/* THE CHECK THAT MATTERS. `cargo tree --prefix none` prints one crate per line
   as `name vX.Y.Z (source)`; the first field is the crate name, so a `tauri`,
   `tauri-build`, `tauri-utils`... anywhere in the graph shows up here and the
   directory name `core` -- which a naive grep would hit on every line --
   does not. */
let deps = []
try {
  deps = run(['tree', '-p', 'cairn-napi', '-e', 'normal,build', '--prefix', 'none'])
    .split('\n')
    .map((l) => l.trim().split(' ')[0])
    .filter(Boolean)
} catch {
  console.error('BUILD-NATIVE result=FAIL reason=cargo-tree')
  process.exit(1)
}
const tauri = [...new Set(deps.filter((d) => d === 'tauri' || d.startsWith('tauri-')))]
if (tauri.length > 0) {
  console.error('BUILD-NATIVE result=FAIL reason=tauri-in-addon crates=' + tauri.join(','))
  process.exit(1)
}

const built = join(CRATE, 'target', PROFILE, LIB)
if (!existsSync(built)) {
  console.error('BUILD-NATIVE result=FAIL reason=artefact-missing path=' + built)
  process.exit(1)
}
try {
  replaceFileAtomically(built, OUT)
} catch (e) {
  console.error('BUILD-NATIVE result=FAIL reason=publish ' + (e && e.message))
  process.exit(1)
}

console.log(
  'BUILD-NATIVE result=PASS profile=' +
    PROFILE +
    ' crates=' +
    new Set(deps).size +
    ' tauri_crates=0 bytes=' +
    statSync(OUT).size +
    ' out=' +
    OUT
)
