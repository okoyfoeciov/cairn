# Cairn

A pixel-identical Obsidian clone the author runs daily on **Debian and macOS** for real notes,
including a credentials note and a journal. Public software, developed in the open: GitHub
releases for the author's own machines only — never in a store,
no notarization — ad-hoc `codesign -s -` is the permanent signature and `tools/cairn.entitlements`
is load-bearing on macOS.

**Stack:** Electron 39.8.3 pinned to Obsidian's own Chromium (`Chrome/142.0.7444.265`), a Rust core
behind a Node-API addon, TypeScript + CodeMirror 6 built with esbuild. No framework, no bundler
config, no electron-builder, no Tauri (deleted; `cargo tree` holds zero tauri crates).

**Gates that do not exist, so nobody rebuilds them:** the memory position (G5a and its build-size
children, retired by user ruling), the WebKit compositing census (G5d/G5e, engine deleted), the
CSS/JS byte gates (retired), G-CSP (this shell ships no CSP), G6 (cold start, measured on the
deleted engine, never re-derived), and G10 (live-Obsidian pixel diff — deleted with its tooling;
there is currently NO pixel gate, only G9's box edges).

---

## 1. Where things are

**Shell** (`electron-shell/`)
- `app-main.mjs` — the main process: window creation, `cairn:invoke` dispatch, the three
  shell-owned commands (`pick_vault`, `open_external`, `copy_text`), the §1.6 close handshake, the
  `CAIRN_*` harness probes, and the explicit application menu (no reload roles).
- `preload.cjs` — the `window.cairn` bridge. `native.mjs` — the addon loader and command map.
- `build-native.mjs` / `build-app.mjs` — the two builds; both are also the gates for "does it build".
- `*.test.mjs` — real-engine suites. They need `cairn.node` and `electron-shell/app/` built, and a
  display (headless offscreen is what CI-less runs here use).

**Core** (`core/`) — `src/app.rs` (commands), `src/tree.rs` (arena, `Node` == 24 bytes, blob),
`src/scan.rs`, `src/search.rs`, `src/watcher.rs`, `src/fsops.rs` (the data-loss rules: atomic write,
trash, move), `src/prefs.rs` (`state.json`), `src/note_frame.rs` (§2 encoder), `src/path.rs`,
`src/error.rs`. `napi/` holds the bindings; the binding layer holds no logic.

**Frontend** (`src/`) — `ipc.ts` is the ONLY shell seam. `main.ts` is entry: boot, wiring,
cross-module flows, owns nothing else. `editor.ts`, `livepreview.ts`, `properties.ts`, `tables.ts`,
`totp.ts`, `secrets.ts`, `memoir.ts` are the editor surface. `tree.ts` / `treeblob.ts`,
`search.ts`, `chrome.ts`, `tabstrip.ts`, `vaultbar.ts`, `menu.ts`, `modal.ts`, `inline-edit.ts`,
`icons.ts`, `state.ts`, `note_frame.js` (the §2 decoder).

`src/styles/tokens.css` is the only file that declares custom properties. `src/icons.ts` is the
only innerHTML sink. `src/main.ts` boots; if you are adding behaviour there, it probably belongs
elsewhere.

**Docs** (`docs/`) — `CONTRACT.md` is NORMATIVE and `§0` is the ruling index. The `spec-0N-*.md`
files are design detail only. `KNOWN-ISSUES.md` is the live register of what is wrong or missing —
read it before "fixing" anything that looks broken. `DATA-LOSS-VERIFICATION.md` maps §7.3's cases to
their tests.

---

## 2. Authority, and how to report a conflict

1. **A live measurement** beats everything.
2. **`docs/CONTRACT.md`** beats the specs.
3. **`docs/spec-0N-*.md`** are design detail; a section the contract marks deleted is void.

A measurement that contradicts the contract has happened repeatedly. **Follow the measurement and
report the conflict loudly** — do not quietly work around it, and do not silently rewrite the
contract. Ask before rewriting a rule.

---

## 3. Working against Obsidian

**Pixel-identity is the default for anything Obsidian has.** Where Cairn diverges, the divergence is
a user ruling, tagged `[C]` in CSS with Obsidian's own value written beside it, and pinned by a test
so nobody silently "corrects" it back. The token tags: `[M]` measured, `[S]` transcribed from
Obsidian's own source, `[D]` derived, `[O]` an Obsidian default, `[C]` a Cairn choice.

**When the question is "what does Obsidian do", read Obsidian rather than deriving it.** It is an
Electron app, so `main.js`, `app.js` and `app.css` are readable text — **in the asar the running app
actually loads**: `~/.config/obsidian/obsidian-1.13.7.asar`, NOT `/opt/Obsidian/resources/obsidian.asar`
(the stale 1.12.7 installer payload). When the question is what DOM it builds, read the constructor
in `app.js`, not only the stylesheet. Live preview's grammar is split between
`lib/codemirror/markdown.js` and Obsidian's own `hypermd` mode in `app.js` — when the transcribed
file does not carry a rule, the wrapper does.

**`tools/obsidian-live.mjs` is the Debian instrument** for asking the live app. It runs on an
isolated profile and copies the newest asar. `--config-from VAULT` and `--sidebar N` are NOT optional
for a comparison: a fresh profile is Obsidian's defaults (readable-line-length ON, sidebar 300) and
answers for a configuration nobody runs. Point it at a temp vault. Compare at an identical
`sidebar_w` and identical settings, both windows maximized, capturing from `x=0` — a clip at a
fractional CSS x resets the rasteriser's sub-phase and hides the thing being asked about.

**Never assume a dpr.** Monitors get swapped; quote every geometry number with its dpr. CDP
emulation is not a rasterisation scale.

---

## 4. Standing user decisions

| Decision | Status |
|---|---|
| Publicly developed | Open repo. No store, no notarization; ad-hoc signing only. The only artifacts are 1.0.0 releases for the author's own machines. Open the app after signing; TCC re-prompts after every rebuild are accepted. |
| Identifier `com.cairn.app` | Single source: `package.json` `identifier`. State: `<appData>/com.cairn.app/state.json`; Chromium userData is separate at `<appData>/Cairn/`. |
| Do not infer identity | Never infer identity, ownership or affiliation from a path, hostname, git config or login name. |
| Mouse, never a trackpad | Trackpad scroll feel is out of scope. |
| No memory or size goals | Retired by user ruling; optimise later. |
| IPC table closed at 25 | The three shell-owned commands are `pick_vault`, `open_external`, `copy_text`. `open_external`'s http/https/mailto allowlist is enforced in the MAIN process and is a ruling, not an accident. |
| No inert controls | §9 E4. The one recorded exception: `Show in Finder` on Linux errors by ruling, because the fix was cancelled. |
| Deliberate behaviours | Fixed non-closable tabs (Mod-1/Mod-2); maximized launch except under `--pixeltest`/headless; global transition ban with named exemptions; collapse-all removed; a network vault has no refresh (never draw its banner while `watching` is true); a clicked bare url does not navigate; a wikilink to a missing note does nothing. |
| User features that are NOT Obsidian's | The `totp` block, secret files (`cairn-type: secrets`), and the Memoir journal page over the local llm-service at `127.0.0.1:8770`. These are design, not transcription. |

---

## 5. Running things safely

- The INSTALLED Cairn (from `/usr/lib/cairn`) is in daily use: its profile is `~/.config/Cairn` and
  its state is `~/.config/com.cairn.app/state.json`. **Never touch either, and never open the real
  vault.** A launch with `CAIRN_VAULT` set is hermetic (its own temp state dir); so is anything with
  `CAIRN_STATE_DIR`. Every Electron launch invented for a test gets
  `CAIRN_STATE_DIR=$(mktemp -d)` and a temp vault.
- **Never kill processes by name** (`pkill -f cairn`, `killall electron`, …). Kill only PIDs you
  started, on the error path too.
- Automate everything — launching windows for gates and benches is allowed.
- A LOCKED SCREEN invalidates graphics and memory numbers: report them as not taken, never disable
  the check to produce a figure.
- Never `git add -A` / `git add .`: `.claude-session-active` and `.claude/` stay out of the repo.
- Commit nothing unless asked. Never push.

---

## 6. Commands

```bash
npm run electron:app                 # build addon + bundle, then launch (dev)
CAIRN_STATE_DIR=$(mktemp -d) CAIRN_VAULT=/tmp/vault CAIRN_HEADLESS=1 \
  npx electron electron-shell/app-main.mjs        # hermetic launch
node electron-shell/build-native.mjs # the Rust core -> cairn.node (gitignored)
node electron-shell/build-app.mjs    # esbuild bundle + inlined CSS (prints js=/css=)
npx tsc --noEmit                     # types
cd core && cargo test --no-fail-fast # the Rust suites, headless
cd core && cargo clippy --lib -- -D warnings
cd core && cargo clippy -p cairn-napi -- -D warnings
cd core && cargo clippy --all-targets -- -D warnings   # clean; quote this one
npm test                             # pretest (fixtures + bench self-test) + frontend glob
node --test tests/frontend/*.test.mjs   # THE GLOB, never the directory: node 24 breaks it
node --test electron-shell/<suite>.test.mjs   # real-engine (needs a display; README lists them)
npm run selftest:geometry            # 50 identities
./tools/run-g9-electron.sh           # gate G9 (box edges) at 1920x964 — OPENS A WINDOW
node tools/scroll-bench.mjs --self-test
node tools/scroll-bench.mjs --expect-hz N   # scroll baseline; refuses on a locked screen
node tools/obsidian-live.mjs --vault DIR --config-from VAULT --sidebar N --open NAME --eval 'JS'
npm run verify:electron-pin          # G-PIN
npm run package:deb                  # out/cairn_1.0.0_amd64.deb, then sudo dpkg -i
npm run package:mac                  # then: bash tools/sign-macos.sh out/darwin-<arch>
```

Every Electron test suite: give it its own `CAIRN_STATE_DIR` and temp vault, as in §5.

---

## 7. Gates

`docs/CONTRACT.md §6.5` is the full table. What is enforced: **G1** `Node` == 24 bytes;
**G2** arena ≤ 768 KiB on the 5,000-note fixture; **G3** cold walk ≤ 50 ms; **G4** 4-thread scan of
the 10 MB corpus ≤ 65 ms; **G7** no `unwrap`/`expect`/`indexing_slicing` in the six named modules;
**G8** the vault is written to only for notes; **G9** `run-g9-electron.sh` → `report.ok` (0 failures
and 0 skips; quote it with its dpr); **G-RT** the §2.4 round-trip, byte-identical; **G-PIN** the
Electron build matches Obsidian's. Everything else is retired or deleted — see the header.

---

## 8. How to work here

- **Report exact command output, never intent.** "Tests pass" is not a result; the `test result:`
  line is.
- **Write real tests, and watch a new test fail before the fix.** A test that cannot fail is not a
  test.
- **`clippy` and `tsc` must stay clean** (all invocations in §6).
- **One owner per file.** Report what you need changed elsewhere; do not reach into another file.
- Keep comments short and about *why*. No history, no dates, no user quotes.
- `docs/` describes the app as it is now. When code and a doc disagree, fix the doc or ask — never
  leave a rule quietly contradicted.
