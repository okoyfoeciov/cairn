# Cairn

A pixel-identical Obsidian clone the author runs daily on **Debian and macOS** for real notes,
including a credentials note and a journal. Three layers:

| Layer | Where |
|---|---|
| Electron 39.8.3 shell, pinned to Obsidian's own Chromium (`Chrome/142.0.7444.265`) | `electron-shell/` |
| Rust core behind a Node-API addon — vault scan, watcher, file ops, search, `state.json` | `core/` → `electron-shell/cairn.node` |
| TypeScript + CodeMirror 6 frontend — no framework, esbuild only | `src/` |

**Memory is not a goal.** The old `< 100 MB` budget and its gates are retired; the measurements
remain in `docs/CONTRACT.md`, but nothing designs around them. Correctness and pixel-identity are
the goals.

**Cairn is never publicly distributed** — no store, no notarization, ever. The only artifacts are
the private GitHub releases of the single version 1.0.0, built from latest main for the author's
own Debian and macOS machines. Ad-hoc `codesign -s -` is the
permanent signature, not a stopgap; `tools/cairn.entitlements` is load-bearing on macOS (library
validation demands it). A locally built app has no quarantine xattr and launches with no dialog; if
a copy ever travelled through a quarantining route, `xattr -dr com.apple.quarantine <app>` clears it.
TCC Files-and-Folders grants are re-prompted after every rebuild, because the ad-hoc cdhash moves.

---

## Status

It works end to end: tree, editor with live preview, Properties, the Memoir journal page, the
secrets viewer with live TOTP codes, search, vault switching, and autosave to disk.

Verified numbers move. **Re-run rather than trusting a count quoted here.** The current ones:

```
cd core && cargo test --no-fail-fast       342 passed, 0 failed (all targets)
cd core && cargo clippy --all-targets -- -D warnings   clean
npx tsc --noEmit                            clean
npm test                                    693 tests: 690 pass, 0 fail, 3 todo
node electron-shell/build-native.mjs        BUILD-NATIVE result=PASS tauri_crates=0
node electron-shell/build-app.mjs           BUILD-APP result=PASS modules=32
npm run selftest:geometry                   50 identities, 50 pass
./tools/run-g9-electron.sh                  137/137, ok=True, 1920x964, dpr=1.25
node tools/scroll-bench.mjs --self-test     67 passed, 0 failed
```

`npm test` uses the **glob** (`tests/frontend/*.test.mjs`), not the directory — the directory form
dies on node 24 and is a CLI failure wearing a test failure's clothes. G9 opens a real window; it is
the one command here that takes the screen.

**`npm run electron:app` is the dev command.** `npm run package:deb` and `npm run package:mac`
ship the private 1.0.0 release (`.github/workflows/release.yml`, manual dispatch from latest main)
and are not run as part of development; on
macOS a packaged `.app` additionally needs `bash tools/sign-macos.sh out/darwin-<arch>`.

State lives at `<appData>/com.cairn.app/state.json` — `~/.config/` on Debian,
`~/Library/Application Support/` on macOS. Every harness run sets `CAIRN_STATE_DIR` and a temp vault,
so it never touches the real one.

---

## Where things live

- `electron-shell/` — `app-main.mjs` (the shell), `native.mjs` (the addon seam), `preload.cjs`, the
  build scripts. `npm run electron:app` ends in `electron app-main.mjs`.
- `core/` — the Rust core. `core/src/` is the library, `core/napi/` the Node-API wrapper,
  `core/tests/` the data-loss and vault suites.
- `src/` — the frontend. `main.ts` boots and wires; every other file owns one subject.
- `docs/CONTRACT.md` — **normative**; `§0` is the ruling index.
- `docs/KNOWN-ISSUES.md` — the register of what is wrong or missing in the code. Read it before
  "fixing" anything that looks broken.
- `docs/DATA-LOSS-VERIFICATION.md` — the map from the contract's §7.3 data-loss cases to the tests
  that prove them.

**Authority: a measurement beats `docs/CONTRACT.md`, which beats the specs.** The specs under
`docs/spec-0*.md` are design detail only; a section the contract marks deleted is void.

One owner per file; `src/styles/tokens.css` is the only file that declares custom properties;
`src/icons.ts` is the only markup sink; the note frame lives in exactly two files
(`core/src/note_frame.rs` and `src/note_frame.js`).

---

## Working on it

Node 24 and a current stable rustc are what the machines run. No global installs, no bundler
config, no Tauri toolchain — there is none in the repo.

```bash
npm ci                                  # one time
npm run electron:app                    # build addon + bundle, then launch
```

Testing conventions, gates and traps: `CLAUDE.md`'s Commands section and `docs/CONTRACT.md §6.5`.
The short version: report `test result:` lines rather than "tests pass"; watch a new test fail
before the fix; keep `clippy` and `tsc` clean.
