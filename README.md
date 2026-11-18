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

**Cairn is publicly developed** — no store, no notarization, ever. The only artifacts are
the GitHub releases of the single version 1.0.0, built from latest main for the author's
own Debian and macOS machines. Ad-hoc `codesign -s -` is the
permanent signature, not a stopgap; `tools/cairn.entitlements` is load-bearing on macOS (library
validation demands it). A locally built app has no quarantine xattr and launches with no dialog; if
a copy ever travelled through a quarantining route, `xattr -dr com.apple.quarantine <app>` clears it.
TCC Files-and-Folders grants are re-prompted after every rebuild, because the ad-hoc cdhash moves.

---

## Status

It works end to end: tree, editor with live preview, Properties, the Memoir journal page, the
secrets viewer with live TOTP codes, the EPUB reader (import or copy an `.epub` into the vault;
continuous read, Mod-F in-book search and per-book resume; a click on a word explains it in a band
under the book, through the local ai-service, and a click on a second word can replace the answer
or split the band into two halves), search, vault switching, and autosave to disk.

Verified numbers move. **Re-run rather than trusting a count quoted here.** The current ones:

```
cd core && cargo test --no-fail-fast       332 passed, 0 failed, 17 ignored (all targets)
cd core && cargo clippy --all-targets -- -D warnings   clean
npx tsc --noEmit                            clean
npm test                                    961 tests: 961 pass, 0 fail, 0 todo
node --test electron-shell/explain.test.mjs        61 pass (fake ai-service; live leg gated; dpr 1.25)
node --test electron-shell/explain-badge.test.mjs  21 pass: 0 differing badge pixels, dpr 1/1.25/1.5/2
node electron-shell/build-native.mjs        BUILD-NATIVE result=PASS tauri_crates=0
node electron-shell/build-app.mjs           BUILD-APP result=PASS modules=38
npm run selftest:geometry                   50 identities, 50 pass
./tools/run-g9-electron.sh                  137/137, ok=True, 1920x964, dpr=1.25
node tools/scroll-bench.mjs --self-test     67 passed, 0 failed
```

`npm test` uses the **glob** (`tests/frontend/*.test.mjs`), not the directory — the directory form
dies on node 24 and is a CLI failure wearing a test failure's clothes. G9 opens a real window; it is
the one command here that takes the screen.

**`npm run electron:app` is the dev command.** `npm run package:deb` and `npm run package:mac`
ship the 1.0.0 release (`.github/workflows/release.yml`, rebuilt on every push to `main`)
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
- `src/` — the frontend. `main.ts` boots and wires; every other file owns one subject. The EPUB
  container is `src/epub.ts`, its reader `src/reader.ts`, and its sheet `src/styles/reader.css`.
  Click-to-explain is `src/bookpick.ts` (the word and the passage), `src/explain.ts` (the band),
  `src/explain-thread.ts` (one half of the band), `src/explain-render.ts` (its DOM) and
  `src/styles/explain.css`; `src/styles/fonts/` holds the only font files shipped (Lora, for the
  pronunciation badge — see `THIRD-PARTY-NOTICES.md`).
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
