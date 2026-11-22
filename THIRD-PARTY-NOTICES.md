# Third-party notices

Cairn ships third-party work in four places: the `cairn.node` native addon
(Rust crates, pinned in `core/Cargo.lock`), the `app.js` bundle (npm packages,
bundled by `electron-shell/build-app.mjs` from `src/main.ts`), inline SVG
path data (`src/icons.ts`, `src/explain-render.ts`), and two font files
(`src/styles/fonts/`, inlined into `electron-shell/app/index.html` by the same
build). The code below is permissive. The fonts are under the SIL Open Font
License 1.1, which binds the font files themselves (a modified font must stay
under the OFL) and not the software they are bundled with. `nucleo-matcher`
(MPL-2.0) was removed, verified absent from `core/Cargo.toml` and
`core/Cargo.lock`. This file travels inside both packages
(`tools/package-electron.mjs` copies it next to the app), so every copy
carries these notices.

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
`app.js`; their licence could not be determined — see the file header. The
pronunciation badge's speaker and warning glyphs (`src/explain-render.ts`)
are copied verbatim from the author's comart extension, which records no
outside source for them.

## Fonts

`--font-ui`, `--font-text` and `--font-mono` (`src/styles/tokens.css`) are
stacks over faces the operating system already provides. The only font files
shipped are two Lora faces, used by one element: the Merriam-Webster
pronunciation badge in the EPUB reader's explanation band (CONTRACT §0.56
E109, `src/styles/explain.css`).

### Lora 3.008 (regular and italic), the unchanged Original Version

- Files: `src/styles/fonts/Lora[wght].ttf` and
  `src/styles/fonts/Lora-Italic[wght].ttf`. These are Cyreal's two variable
  fonts, byte for byte as the copyright holder distributes them. Nothing was
  converted, subset, renamed or rebuilt. The file names are upstream's; the
  `[wght]` is part of the file name, not of the font name.
- Upstream: https://github.com/cyrealtype/Lora-Cyrillic at commit
  `403b1a66ca2e79f81d749c5299559e168591a4df`:

  | File | Bytes | SHA-256 |
  |---|---|---|
  | [`fonts/variable/Lora[wght].ttf`](https://raw.githubusercontent.com/cyrealtype/Lora-Cyrillic/403b1a66ca2e79f81d749c5299559e168591a4df/fonts/variable/Lora%5Bwght%5D.ttf) | 212196 | `822a6621ccbe8d97d20ac88c1c41f5615c9c2c202eaa75f272cd452aac6475a7` |
  | [`fonts/variable/Lora-Italic[wght].ttf`](https://raw.githubusercontent.com/cyrealtype/Lora-Cyrillic/403b1a66ca2e79f81d749c5299559e168591a4df/fonts/variable/Lora-Italic%5Bwght%5D.ttf) | 221232 | `22d8d8854b53807aa664ca34f2031a9ed57a1d0dea296b8b96cdd3aad937a2b3` |
  | [`OFL.txt`](https://raw.githubusercontent.com/cyrealtype/Lora-Cyrillic/403b1a66ca2e79f81d749c5299559e168591a4df/OFL.txt) (reproduced below) | 4423 | `1d9a970809ac804b582a6ce7f0ebc4e7fefcbfd7ff6299cad35ee656a21be716` |

  The same three files, byte for byte, are in google/fonts `ofl/lora/`, whose
  `METADATA.pb` names this repository and commit as their source.
  `tests/frontend/explain-css.test.mjs` pins both font hashes.
- Name records 0-25 (`name` table, Windows, English), as they are in the files.
  IDs 256 and up are the `wght` axis and instance names (Weight, Regular …
  Bold), and the files also carry Mac-platform copies of some records:

  | ID | `Lora[wght].ttf` | `Lora-Italic[wght].ttf` |
  |---|---|---|
  | 0 copyright | Copyright 2011 The Lora Project Authors (https://github.com/cyrealtype/Lora-Cyrillic), with Reserved Font Name "Lora". | same |
  | 1 family | Lora | Lora |
  | 2 subfamily | Regular | Italic |
  | 3 unique ID | 3.008;CYRE;Lora-Regular | 3.008;CYRE;Lora-Italic |
  | 4 full name | Lora Regular | Lora Italic |
  | 5 version | Version 3.008 | Version 3.008 |
  | 6 PostScript name | Lora-Regular | Lora-Italic |
  | 7 trademark | Lora is a trademark of Cyreal. | same |
  | 8 manufacturer | Cyreal | Cyreal |
  | 9 designer | Olga Karpushina, Alexei Vanyashin (Cyrillic) | same |
  | 11 vendor URL | https://cyreal.org | same |
  | 12 designer URL | https://cyreal.org | same |
  | 13 licence | This Font Software is licensed under the SIL Open Font License, Version 1.1. This license is available with a FAQ at: https://scripts.sil.org/OFL | same |
  | 14 licence URL | https://scripts.sil.org/OFL | same |
  | 25 variations prefix | Lora | LoraItalic |

- License: SIL Open Font License, Version 1.1, with the Reserved Font Name
  "Lora". The text at the end of this section is upstream's `OFL.txt` from the
  same commit, verbatim.

#### Why the files are unchanged

The OFL calls anything made "by adding to, deleting, or substituting -- in
part or in whole -- any of the components of the Original Version, by changing
formats or by porting the Font Software to a new environment" a Modified
Version, and its condition 3 says a Modified Version may not use a Reserved
Font Name without the copyright holder's written permission. SIL's own
guidance applies this to web fonts:

- OFL-FAQ 2.6 (https://openfontlicense.org/ofl-faq/): "Removing any parts of
  the font when delivering a webfont to a browser, including unused glyphs and
  smart font code, is considered modification. This is permitted by the OFL
  but would not normally allow the use of RFNs."
- OFL-FAQ 2.5: optimized web versions "are Modified Versions and so must
  follow OFL requirements like appropriate renaming."
- OFL-FAQ 5.3: the restriction covers "the font menu name and other
  mechanisms that specify a font in a document". A CSS `font-family` is one.
- "Webfonts and Reserved Font Names"
  (https://openfontlicense.org/webfonts-and-reserved-font-names/): pre-made
  subsets "need to be considered a Modified Version for which RFN restrictions
  apply". The first of its four options is to "Host the Original Version
  without any changes at all."
- OFL-FAQ 1.21 and 5.9: a font added "without modifying or optimizing it" is
  "simply bundling the font", and a package that "is simply a wrapper or a
  compressed structure around the final font - leaving them intact on the
  inside" needs no name change.

comart's own Lora files are byte-identical to Google Fonts' Latin subsets
(`fonts.gstatic.com/s/lora/v37/0QIvMX1D_JOuMwr7Iw.woff2` and
`0QIhMX1D_JOuMw_LIftL.woff2`): 226 code points instead of 778, and without
name records 7, 8, 9, 11, 12, 13 and 25. That is a Modified Version still
called "Lora", so Cairn ships neither those files nor any other changed copy.
The Original Version may keep its name with no separate agreement.
`electron-shell/explain-badge.test.mjs` uses comart's subsets only as its
reference, read from a comart checkout at run time; they are not in this
repository and do not ship.

#### How Cairn uses it

- `src/styles/explain.css` declares the two faces as `font-family: "Lora"`,
  weight `400 700`, for one element: the pronunciation badge (CONTRACT §0.56
  E109). Each face has a `unicode-range` of exactly the 226 code points of
  comart's subsets. The browser takes only those characters from Lora and
  draws every other one (for example ə, ā, ≈) from the next font in the
  stack, as comart does, so the badge keeps comart's pixels. The range is a
  rule in Cairn's stylesheet; it does not touch the font file.
- `electron-shell/build-app.mjs` inlines each file as a base64
  `data:font/ttf` URL inside the `<style>` of `electron-shell/app/index.html`,
  so the page stays one file. Base64 is only a transport encoding: the decoded
  bytes are the upstream file, and `explain-css.test.mjs` decodes them and
  checks both hashes.
- Cairn never shows a font name to the user and offers no way to install the
  fonts.
- This file, with the licence text below, is copied into both packages by
  `tools/package-electron.mjs`.

```text
Copyright 2011 The Lora Project Authors (https://github.com/cyrealtype/Lora-Cyrillic), with Reserved Font Name "Lora".

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
https://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded, 
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```
