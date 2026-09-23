# Third-party notices

Cairn ships third-party code in three places: the `cairn.node` native addon
(Rust crates, pinned in `core/Cargo.lock`), the `app.js` bundle (npm packages,
bundled by `electron-shell/build-app.mjs` from `src/main.ts`), and inline SVG
path data (`src/icons.ts`). Everything below is permissive. No copyleft
licence remains in the tree: `nucleo-matcher` (MPL-2.0) was removed, verified
absent from `core/Cargo.toml` and `core/Cargo.lock`.

## Rust crates (compiled into `electron-shell/cairn.node`)

Versions are pinned in `core/Cargo.lock`. Licences read from each crate's
published `Cargo.toml`:

- **MIT**: `tokio`, `trash`, `rfd`, `napi`, `napi-derive`, `napi-build`,
  `napi-sys`, `napi-derive-backend`, `mio`, `block2`, `objc2`, `objc2-encode`,
  `objc2-foundation`, `fsevent-sys`, `kqueue`, `kqueue-sys`, `slab`,
  `convert_case`, `urlencoding`, `zmij`
- **MIT OR Apache-2.0**: `serde`, `serde_json`, `serde_core`, `serde_derive`,
  `libc`, `percent-encoding`, `chrono`, `tempfile`, `regex-automata`,
  `regex-syntax`, `bitflags`, `log`, `once_cell`, `proc-macro2`, `quote`,
  `syn`, `bstr`, and the remaining build/transitive crates in the lock file
- **Unlicense OR MIT** (equivalents: `Unlicense/MIT`): `memchr`,
  `grep-searcher`, `grep-regex`, `grep-matcher`, `aho-corasick`, `same-file`,
  `walkdir`, `winapi-util`
- **CC0-1.0**: `notify`
- **ISC**: `inotify`, `inotify-sys`, `libloading`
- **Apache-2.0 OR MIT** (equivalents: `Apache-2.0/MIT`): `autocfg`, `ctor`,
  `fastrand`, `nohash-hasher`, `pin-project-lite`, `rustc-hash`, `pollster`
- **Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT**: `rustix`,
  `linux-raw-sys`, `wasi`
- **(Apache-2.0 OR MIT) AND BSD-3-Clause**: `encoding_rs`
- **(MIT OR Apache-2.0) AND Unicode-3.0**: `unicode-ident`
- **MIT OR Apache-2.0 OR Zlib**: `raw-window-handle`
- **MIT OR Apache-2.0 OR LGPL-2.1-or-later**: `r-efi`
- **Zlib OR Apache-2.0 OR MIT**: `dispatch2`, `objc2-app-kit`,
  `objc2-core-foundation`

Platform-specific crates (e.g. `windows-*`, `objc2-*`) are in the lock file
but only link on their own target OS.

## npm packages (bundled into `electron-shell/app/app.js`)

Licences read from each package's `package.json`. `esbuild` and `typescript`
are build tools only and do not ship; `electron` is the app runtime (MIT),
not bundled code.

- **MIT**: `@codemirror/state`, `@codemirror/view`, `@codemirror/commands`,
  `@codemirror/language`, `@lezer/common`, `@lezer/highlight`, `@lezer/lr`,
  `@marijn/find-cluster-break`, `crelt`, `style-mod`, `w3c-keyname`
- **Apache-2.0**: `typescript` (build tool, does not ship)

## Icons

The glyphs in `src/icons.ts` are **Lucide** path data (ISC licence, as
declared by the Lucide project), inlined as SVG path strings. No Lucide
package is a dependency and none ships. The four Linux window-control glyphs
and `open-vault` / `right-triangle` are transcribed from Obsidian's own
`app.js`; their licence could not be determined — see the file header.

## Fonts

**No font files are shipped.** `--font-ui` and `--font-mono`
(`src/styles/tokens.css`) are stacks over faces the operating system already
provides.
