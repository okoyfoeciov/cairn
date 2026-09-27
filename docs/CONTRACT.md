# CONTRACT.md — the single normative source of truth

**Status: normative. This document OVERRIDES every `spec-0N-*.md` wherever they disagree.** A spec
section named STRUCK in §0 or in the body is void: do not implement it, do not cite it, and delete
it on the next editing pass over that spec.

Authority, in precedence order: **a measurement beats any assertion, including this document's**;
where no measurement settles it, this document rules and names its loser. Prose marked `[C]` is a
choice this document makes and the user may reverse; §9 records the standing user decisions.

Marks used below: `[M]` measured, `[S]` read from pinned dependency source, `[D]` derived from `[M]`,
`[C]` a choice this document makes, `[O]` read out of Obsidian's own bundle. **No `[PENDING]` marks
remain: every escalation is settled in §9.**

---

## 0. Ruling index

One row per ruling id, with the rule as it stands and where it lives. **Section numbers and ids are
never renumbered or reused** — code cites them (ids like `E14` and section numbers like `§7.3`), so a
superseded id points at the rule that replaced it or at its own tombstone rather than disappearing.
Sections are numbered in the order below: §0's passes are §0.1–§0.53, then the body is §1–§10.

| Id | Current rule | Where |
|---|---|---|
| B1 | Tree crosses the boundary once, as **TreeBlob v1** raw bytes | §3.1 |
| B2 | The 24-byte self-describing note frame; one Rust and one JS copy | §2 |
| B3 | `write_note` takes typed args, not headers; `flags` carries CRLF/BOM, never `eol` | §1.3, §2.3 |
| B4 | The grep-searcher engine ships; 4 threads per query, no persistent pool | §4.1 |
| B5 | `Arc<VaultSnapshot>` built lazily, cached, epoch-invalidated | §4.2 |
| B6 | One command table (§1.3); `VaultError` everywhere; `src/ipc.ts` is owner 02's seam | §1.1, §1.3 |
| B7 | `panic = "unwind"`, `opt-level = "s"` | §6.2 |
| B8 | Code block: `margin: 0`, `padding: 0 16px`, 14px/21px, `nc-cb*`; no overhang | §5.3 |
| B9 | Tree box model: `--cx0`/`--tx0`/`--gx0`/`--row-indent` (corrected by E96/E97) | §5.2 |
| B10 | macOS chrome: `frame:false` + `titleBarStyle:'hidden'` + `trafficLightPosition {19,12}` | §5.6 |
| B11 | Flush-on-quit handshake; a rejecting flush cancels the close | §1.6 |
| B12 | The shell ships **no CSP**; the live rule is no `innerHTML` except `icons.ts` literals | §6.1 |
| B13–B16 | The memory position is **retired**, not gated | §8 |
| B17 | `write_note` never creates unless told; delete of the open note is ordered, not raced | §7.1, §7.3 case 3 |
| B18 | `confirm_close` + `nc://flush-and-close`; the watchdog is for a hung disk only | §1.6 |
| B19 | Expansion is frontend-owned, keyed on the vault-relative path | §3.4 |
| B20 | spec-05's engine and search policy are normative | §4.1, §4.4 |
| B21 | `panic = "unwind"` | §6.2 |
| M22 | The frontend build: esbuild, `iife`, `chrome142`, CSS inlined — `electron-shell/build-app.mjs` | §6.3 |
| M23 | A **source** rule: no `src/` import of `@codemirror/language` / `@lezer/*` (they are in the bundle transitively) | §6.3 |
| M24 | The core manifest and the addon manifest | §6.2 |
| M25 | One `state.json` per install, per-vault keyed | §7.6 |
| M26 | Exact `(abs, mtime_ns, len)` echo fingerprints, never a time window | §3.5 |
| M27 | `MAX_NOTE_BYTES = 8 MiB`, `TooLarge` | §7.3 case 15 |
| M28 | Four sort orders, wire `u8`; no created-time, no `ctime` | §1.5, §3.2 |
| M29 | Search policy resolved (0 ms filenames, 90 ms content, caps) | §4.4 |
| M30 | Vault switch order, both sides; the `Vault` is taken out before it is dropped | §4.3 |
| M31 | **Removed** — the nav toolbar | §0.12 E14 |
| M32 | `tokens.css` is the only declaration site | §5.1 |
| M33 | The editor surface and heading rules live in `editor.css`, owner 03 | §5.3, §5.4 |
| M34 | Code surface: insets, code block, fences as ordinary lines | §5.3 |
| M35 | The heading ladder is Obsidian's own | §5.4 |
| M36 | `tokens.css` is the only declaration site | §5.1 |
| M37 | Startup: hand-rolled walk, no index phase | §7.5, §4.1 |
| M38 | 50,000-node and 255-depth caps, signalled in the blob header | §3.3 |
| M39 | One `nc://tree-changed { epoch }`, 150 ms debounce | §1.4, §3.5 |
| M40 | tokio 2 workers / 6 blocking; search spawns 4 threads per query | §8.5, §4.1 |
| M41 | The file table and the glyph-host rule ("every literal has a host") | §6.4 |
| M42 | macOS chrome | §5.6 |
| M43 | Every `spec-NN §X` cross-reference is void; cite this document | §10 |
| M44 | CJK JSON inflation is ×1.0141, not 6× | §1.2 |
| M45 | `write_note`'s `flags` bitfield, no `eol` | §2.3 |
| M46 | **Removed** — the memory-lever magnitude | §8 |
| M47 | The search engine and policy | §4.1, §4.4 |
| M48 | `Arc<VaultSnapshot>` lazily built | §4.2 |
| M49 | TreeBlob v1, one crossing | §3.1 |
| M50 | `panic = "unwind"`, `opt-level = "s"` | §6.2 |
| M51 | Rust owns normalise/denormalise, never the caller | §2.1, §2.4 |
| M52 | `validate_name` (create/rename) and `validate_rel_for_lookup` (resolution) are different functions | §7.3 case 11 |
| M53 | Four sort orders; no `ctime` | §1.5 |
| M54 | `open_note` is updated on rename and cleared on delete | §7.3 cases 4–6 |
| M55 | The flush handshake | §1.6 |
| M56 | The tab strip, owner 03 — now two fixed tabs | §7.4 |
| M57 | `nc://vault-lost` has a handler; there is no refresh affordance | §7.3 case 8, §0.12.2 |
| M58 | **Removed** — the Linux target block | §6.2 |
| M59 | Rule 5: no transitions anywhere, with three named exemptions | §5.1, §0.24.5 E53, §0.44 E90 |
| M60 | **Struck by E9** — the sidebar resizes, and `sidebar_w` is a global field | §0.7, §7.6 |
| M61 | **Overturned by E19** — every folder draws a chevron | §0.17, §5.2 |
| M62 | **Removed** — the retired memory composition | §8 |
| M63 | **Not enforced** — cold start was measured on Tauri; G6 is not re-derived | §6.5 |
| M64 | Search policy | §4.4 |
| M65 | `current_vault()` returns a discriminated `VaultState` | §1.5, §7.5 |
| M66 | Parent-directory `sync_all()` on Linux (step 8b) | §7.1 |
| M67 | Temp debris is unlinked on sight when its embedded PID is dead | §7.3 case 1 |
| M68 | Flat `0o644` for new notes; preserve the destination's mode on overwrite | §7.1 |
| M69 | `Node.mtime` is updated on every content hit | §3.5 |
| M70 | `view.setState()` on vault switch; exactly one `EditorView` per process | §4.3 |
| X1 | `--row-indent` is the one name for the indent step | §5.2 |
| X2 | **Struck by E98** — the chevron is an inline `<svg>`, not a `--chev` mask token | §0.50, §5.2 |
| X3 | `--text-error` is a token (`#fb464c`), never an inline literal | §5.1 |
| X4 | `--lh-code` is the integer `21px` | §5.1, §5.3 |
| X5 | **Moot** — the nav toolbar is gone | §0.12 E14 |
| X6 | The sidebar scroller's gutter is 8px, reserved always | §5.2 |
| X7 | The vault bar's geometry (R2, resolved) | §5.10 |
| X8 | `tokio` is a direct dependency so the runtime can be tuned; `rfd` is the picker crate | §6.2 |
| X9 | The banners have an owner (01) and a geometry; the row pool is sized from live `clientHeight` | §3.3 |
| X10 | The `--pixeltest` probe, its owner table and its exit code | §5.11 |
| X11 | `reveal_in_os` is command 20 and is macOS-only, permanently | §1.3, §0.25 E59 |
| X12 | The binding layer holds no logic; `parse_write_headers` has no production caller | §1.1 |
| X13 | Every wire type is camelCase, `VaultError` included | §1.1, §1.5 |
| X14 | Files-only and blob index spaces are distinct; resolve by path | §4.2 |
| X15 | The frontend owns the search generation | §4.3 |
| X16 | Save as… is the only `create: true` | §7.1, §7.3 case 5 |
| X17 | Heading markers reveal on the caret's line | §5.4.1 |
| X18 | The inline title: a block widget at position 0, at the H1 tokens | §5.4.2 |
| X19 | The construct-scanner seam (`ConstructSource` / `buildDecorations`) | §5.4.4 |
| Y3 | Active equals hover; the active fill is an inset rounded rect, withheld under a selection | §5.1, §0.22.6 |
| Y5 | Row pool = `ceil(clientHeight / --row-h) + 2·OVERSCAN + 1`, `OVERSCAN = 8` | §3.3 |
| Y6 | **Superseded** — the glyph-host rule, not a count | §6.4, §0.30 E71 |
| Y13 | The grouped `.tree-scroller, .search-scroller` rule is declared once, in `tree.css` | §5.2 |
| Y17 | The cap banners show in both views | §3.3 |
| Z1 | **Retired** — the JS size gate | §0.47 E95 |
| Z2 | `VaultInfo` carries `expanded` and `scrollTop` | §7.6.1 |
| Z3 | Mixed-EOL files unify on CRLF; uniform files round-trip byte-exact | §2.4, §2.4.1 |
| Z4 | `src/modal.ts`, owner 01 — the one modal | §1.6.1 |
| Z5 | The dirty-delete guard, and `settleWrites()` awaited twice | §7.3 case 3 |
| Z6 | `layers.scrollers` counts RENDERED boxes: computed overflow **and** `getClientRects().length > 0` | §5.12.4 |
| Z7 | The modal consumes the real token names; no aliases | §1.6.1 |
| Z8 | The macOS trash backend is pinned to `NsFileManager` | §7.3.1 |
| E1 | Product name Cairn; identifier `com.cairn.app`; never infer identity from a path | §9 E1 |
| E2 | **Removed** — macOS-only for v1; lifted by E6 | §9 E2 |
| E3 | **Removed** — the retin/WebKit single-surface lever; deleted with the engine | §9 E3 |
| E4 | No inert decoration: four reference controls omitted | §9 E4 |
| E4a | The `panel-left` button is omitted | §9 E4a |
| E5 | Cairn is never publicly distributed; ad-hoc signing is permanent | §9 E5 |
| E6 | Debian/Linux is a supported dev and usage platform | §9 E6 |
| E7 | The Linux title bar is Cairn's own, 39px with a right-flush cluster | §0.5, §9 E7 |
| E8 | The tab strip: 40px, active tab inset/radius 6/ring/shoulders, two fixed tabs | §0.6 |
| E9 | The sidebar resizes by drag; `SIDEBAR_MIN` 180 / `EDITOR_MIN` 320 | §0.7 |
| E10 | `--accent` `#8a5cf5`; `--tab-top` 7 / `--tab-h` 33 | §0.8 |
| E11 | `.tab`'s vertical padding is 1px top / 3.5px bottom | §0.9 |
| E12 | **Refuted** — the UI font is Obsidian's own stack | §0.10, §0.18 E23 |
| E13 | **Overturned** — the tab label is 13px | §0.11, §0.26 E63 |
| E14 | No nav toolbar; the row menus; tree band 881; sorting pinned | §0.12 |
| E15 | A right-click the tree answers cancels the engine's menu | §0.13 |
| E16 | The row menu's box: 24.9px rows, 4/8 padding, 8 gap, rule separator | §0.14 |
| E17 | Row glyphs are named for Obsidian's `setIcon()` strings | §0.15 |
| E18 | A file row offers no create rows | §0.16 |
| E19 | Every folder draws a chevron, empty or not | §0.17 |
| E20 | A click on the inline title places the caret | §0.17 |
| E21 | Electron's traffic lights are Obsidian's own 19/12 | §0.17, §5.6 |
| E22 | Neither create gesture prompts | §0.17 |
| E23 | `--font-ui` is Obsidian's own stack, verbatim | §0.18 |
| E24 | The type spine: 25.888px and the whole ladder | §0.19, §5.4 |
| E25 | `--editor-inset-x` / `-y` are both 32px | §0.19, §5.3 |
| E26 | The CSS gate is RETIRED | §0.19 |
| E27 | G9 states its comparison on the device grid (`exact` / `snap` / `device-px`) | §0.19.2, §5.11 |
| E28 | **Superseded by E35** — the core builds with zero Tauri | §6.2, §0.20 E35 |
| E29 | Every command result crosses as `{ok,value}` / `{ok,error}`; non-§1.5 faults throw | §0.20, §1.1 |
| E30 | **Removed** — the K4 copy measurement | §0.20 |
| E31 | A search subscription ends on `complete` or `error`, not at call return | §0.20, §1.3 |
| E32 | **Removed** — G-b's closure; the handshake it proved is §1.6 | §1.6 |
| E33 | **Removed** — step 7; single-instance and the quit paths are §1.6 | §1.6 |
| E34 | Packaging: `tools/package-electron.mjs`, no electron-builder, refuses stale artefacts | §0.20.5 |
| E35 | Tauri is deleted; the stack is Electron + the napi core, `src-tauri/` is `core/` | §0.20.6 |
| E36 | **Removed** — the two defects the deletion found; the sidebar width now crosses via `additionalArguments` | §0.7 |
| E37 | **Removed** — G10's instrument | §0.21.3 |
| E38 | `dl_23` drives the packaged binary | §0.21 |
| E39 | `tools/cairn.entitlements` is load-bearing; `codesign --verify` ≠ launch | §0.22.1 |
| E40 | One display predicate (`have-display.mjs`); a SKIP is a third kind of green | §0.22.2 |
| E41 | The gate window is 1920 × 964; `treeH` 881; `editorW` 1508; `lineW` 1432 | §0.22.3 |
| E42 | `--inline-title-space-after` 12.944; first line top 116.0096 | §0.22.4 |
| E43 | **Removed** — the G10 verdict; the capture lessons survive | §0.22.8 |
| E44 | The active row is the hover value, as an inset rounded rect; `--row-h` is measured | §0.22.6 |
| E45 | The watcher reads ctime, not mtime, and `full_rescan` is for `Any`/`Other` | §0.22.7 |
| E46 | Obsidian runs live preview on a CM5 mode; no `@lezer/markdown` | §0.23.1 |
| E47 | The construct set and the three-scope reveal rule | §0.23.2, §5.4.4 |
| E48 | The reveal is gated on focus; `app-main.mjs` takes focus with three calls | §0.23.3 |
| E49 | Frontmatter is hidden and rendered as the Properties block | §0.24.1, §5.4.5 |
| E50 | Unparseable frontmatter is not hidden; the parser bails | §0.24.2, §5.4.5 |
| E51 | Inline state is paragraph-scoped, bounded | §0.24.3, §5.4.4 |
| E52 | The inline title's margin is its own 12.944px token | §0.24.5 |
| E53 | Rule 5's exemptions: the fold slide and the fold arrow | §0.24.5 |
| E54 | The property glyphs take `--icon-color`, not `--text-faint` | §0.24.6 |
| E55 | The Properties block edits; every write is one line | §0.24.6, §5.4.5 |
| E56 | `.metadata-property-icon` gets `flex-shrink: 0` | §0.24.7 |
| E57 | **Retired** — the JS gate | §0.47 E95 |
| E58 | A relative unit is consumed at exactly one level | §0.24.9 |
| E59 | "Reveal in Finder" is macOS-only, permanently | §0.25 |
| E60 | iCloud is out of scope; gap G-d is closed | §0.25, §7.3 case 9 |
| E61 | The 120 Hz run: 3.59% deficit, and above 120 Hz the bench measures its driver | §0.25, §0.53.7 |
| E62 | No CSS margin may exist inside `.cm-content` | §0.26, §5.4.5 |
| E63 | The tab label is 13px | §0.26 |
| E64 | `body` pins no cursor | §0.26 |
| E65 | The window opens maximized on a normal launch | §0.26, §7.5 |
| E66 | The tab is top-anchored; the label carries Obsidian's line-height | §0.26.2 |
| E67 | The menu tick is a trailing glyph; the icon slot is unconditional | §0.27 |
| E68 | The dismissal set is closed: outside click, Escape, a row, right-click | §0.28 |
| E69 | A menu is placed at the pointer | §0.29 |
| E70 | `forget_vault` (command 21) edits `state.json` only | §0.30.1, §1.3 |
| E71 | The tab strip's `+` is deleted | §0.30.2 |
| E72 | 24px of empty space under the tree's last row | §0.30.3 |
| E73 | 16px above every heading; rule 2 NOT transcribed (LP-18) | §0.30.4 |
| E74 | A heading has no space below it | §0.30.5 |
| E75 | A hard-wrapped continuation hangs under its own text | §0.31, §0.51 |
| E76 | `.cm-line > * { text-indent: 0 }` is E75's mandatory companion | §0.31.6 |
| E77 | The tree's bottom space is Obsidian's 24px; the sequence is withdrawn | §0.32 |
| E78 | The search panel's back button is `arrow-left` | §0.33 |
| E79 | Filename search is a case-insensitive substring match | §0.33 |
| E80 | The tree's top padding is 12px, a literal | §0.34 |
| E81 | A continuation's leading whitespace carries 1em, on three conditions | §0.35, §0.51 |
| E82 | A continuation takes `--list-spacing` on its bottom only | §0.35.1 |
| E83 | Links render: a bare url and a `[[wikilink]]` | §0.36 |
| E84 | The editor's scrollbar gutter is 12px; the sidebar's stays 8 | §0.37 |
| E85 | A clicked link goes somewhere; command 22 `open_external` | §0.38 |
| E86 | `<https://…>` is an autolink | §0.39 |
| E87 | A markdown table renders as a table | §0.40 |
| E88 | Scroll past the end is half the scroller | §0.43 |
| E89 | The first-run panel is deleted | §0.44.1, §7.5 |
| E90 | The folder fold is Obsidian's, on pooled rows | §0.44.2 |
| E91 | `.empty-state` is struck; the pane is empty | §0.45, §7.4 |
| E92 | `editable(false)` removes the caret; `readOnly` does not | §0.45 |
| E93 | The caret was white; CM6 outranked the token | §0.45 |
| E94 | The `totp` block: four divergences, no code on screen, click-to-copy | §0.46 |
| E95 | `JS_MAX` is RETIRED | §0.47 |
| E96 | The tree box model was 1px left; guides and the step | §0.48 |
| E97 | `--row-indent: calc(16px + var(--hairline))` | §0.49 |
| E98 | The tree chevron is an inline `<svg>`; no SVG loaded as a CSS image | §0.50 |
| E99 | A nested list item is not a continuation | §0.51 |
| E100 | The editor pane is a paint containment box | §0.52 |
| E101 | **Removed** — the G10 harness fix | §0.53 |
| E102 | **Removed** — V-2's closure went with G10 | §0.53 |
| E103 | Test expectations are derived from the page; line boxes move with dpr | §0.53.4 |
| E104 | CDP emulation is not a rasterisation scale | §0.53.5 |
| E105 | The frontend count is 509; the built-page SVG row matches per `url()` | §0.53.6 |
| E106 | Canonical roots; `forget_vault`'s silent no-op; the scroll driver above 120 Hz | §0.53.7 |

### §0.1 — DELETED (the errata changelog; the X/Y/Z ids it alone defined are folded into §0's index).

### §0.2 — DELETED (Tauri-era reconciliation pass; no live ruling).

### §0.3 — DELETED (the live-preview parser seam now lives in §5.4.4).

### §0.4 — DELETED (mechanism was Tauri/tao/WebKitGTK; the decision lives in §9 E6).

### §0.5 — The Linux title bar is Cairn's own (E7)

On Linux the 39px strip IS the title bar. The window is built `frame: false` on every platform
(`electron-shell/app-main.mjs`), and the right-flush control cluster is drawn in the strip under
`html[data-os="linux"]`. Three buttons, each **44 × 39** (a 12px glyph with `padding: 0 16px`),
flush to the window's right edge, minimize / maximize-restore / close in that order. Their glyphs
are four hand-drawn 12 × 12 SVGs in `icons.ts`'s second table (`W`); `restore` replaces `maximize`
while maximized. Ink is `--text-normal` at full opacity (the one deliberate divergence from
Obsidian's focused value); hover is `--bg-modifier-hover`; close-hover is `--bg-close-hover:
#fb464c` with white ink. `--macos-tl-inset` is **8px on Linux** (88px on macOS, §5.6). `data-os` is
set from the shell-supplied platform before `paintIcons`, and correcting it is what binds Mod to
Ctrl on Debian rather than to Super, so Ctrl-S no longer falls through to the engine's save panel.

The cluster is the LAST child of `.titlebar` and is `display: none` off Linux, so its 132px comes
out of `.tab-strip`'s grow share and the tab stays at x 430 / width 200. `minimize` and
`toggle-maximize` are handled in `electron-shell/app-main.mjs`; maximize state arrives as
`nc://window-state`, because the WM can maximize on its own. `close` is `win.close()`, NOT
`destroy()`, so it raises the `close` event and takes §1.6's flush handshake — a rejecting flush
still cancels the quit. Covered by `electron-shell/window-control.test.mjs` and
`tests/frontend/window-controls.test.mjs`.

### §0.6 — The tab strip (E8)

The strip is **40px border-box** (`--titlebar-h`): 39px of fill plus a 1px `--tab-outline` rule. The
**active tab is inset, curved and ringed** — `--tab-top: 7px`, `--tab-h: 33px`, `--tab-radius:
6px`, two `::before`/`::after` shoulders (a 12×12 circle parked outside each bottom corner with a
`--tab-curve × 4` spread of the tab's own fill, clipped to the facing quadrant) and a 1px ring. The
tab bleeds 1px over the rule so tab and pane read as one surface. `.tab` is anchored from the TOP
(`align-self: stretch` + `margin-top`) at every scale — §0.26 E66 — and its vertical padding is
asymmetric: **1px top, 3.5px bottom** (§0.9). Horizontal padding composes Obsidian's mod-root terms
(header 3px + inner 6px start / 3px end). The label is **13px**, `--font-ui-small`, weight 400
(§0.26 E63).

The two `.titlebar-left` buttons (`search`, `folder-open`) are DELETED — a user ruling; their routes
are Mod-Shift-F and the vault bar's own switcher. The strip's `+` button is deleted too (§0.30 E71).
**Two FIXED tabs (user ruling):** the note tab and a second `Memoir` tab, neither
closable — there is no close button anywhere in the strip. Exactly one carries `.is-active`; the
inactive style is transparent, no ring, no curves, and its hover fill is an inset pill on
`.tab-inner` (Obsidian's `.workspace-tab-header-inner`, radius `--tab-radius` platform-scoped).
Mod-1 / Mod-2 select the note / Memoir tab. With no note open the note tab is NOT RENDERED and the
pane is empty (§0.45 E91); the Memoir tab shows whenever a vault is open. `.tab[hidden]` is
`display: none`.

### §0.7 — The sidebar is resizable (E9)

A 3px `.sidebar-resize` handle, `position: absolute; right: 0` inside `.sidebar`, takes no layout
space. It is transparent at rest and `--accent` on hover and while dragging. The drag is
pointer-captured and sets `--sidebar-w` as an inline style on `<html>`, so `tokens.css` remains the
only file that DECLARES a custom property (§5.1). Bounds are `SIDEBAR_MIN` 180 and `EDITOR_MIN` 320,
both exported pure from `chrome.ts` and driven by tests rather than grepped for.

`sidebar_w` is a GLOBAL field in `state.json` beside `win` (absent = never resized), bounded to
`[120, 4000]` by `prefs.rs` on both apply and load — Rust rejects nonsense; the frontend enforces
policy. It reaches the page at boot through Electron's `additionalArguments`
(`--cairn-sidebar-w=…`, read by the preload bridge), and `prefs_path` is computed above the window
builder for it.

G9 is protected by construction: the persisted width is NEVER injected under `--pixeltest` — a width
the user dragged to yesterday must not decide whether the gate passes today. The boot path applies
the value Rust already bounded and re-clamps on the first frame and on `resize`, without persisting
(the window chose that width, not the user). The `sidebar.resize` gate row asserts the handle's
right edge IS the sidebar's right edge, so a handle accidentally laid out in flow fails loudly.

### §0.8 — `--accent` is `#8a5cf5` (E10)

`--accent` is `#8a5cf5` — 1.13.7's `hsl(258,88%,66%)`. Its consumers are the resize handle, the
inline-edit focus ring and the modal's primary button. `--tab-top` is 7px and `--tab-h` 33px. (The
`+` button this ruling sized is deleted — §0.30 E71.)

### §0.9 — `.tab`'s vertical padding is 1px top / 3.5px bottom (E11)

Obsidian's `.workspace-tab-header { padding: 1px 4px 3.5px }` lifts the tab's content 1.25px above
its geometric centre; Cairn had no vertical padding, so everything inside the tab sat 1.6px low.
Horizontal padding composes Obsidian's mod-root terms rather than a flat inset, so the label ink
still sits 9px from the tab's left edge. (The tab-close glyph this pass measured is gone with the
close button — §0.6.)

### §0.10 — DELETED (the `+` gap, and the Inter diagnosis — the UI font is Obsidian's own stack, §0.18 E23; the button is gone, §0.30 E71).

### §0.11 — DELETED (the tab label is 13px — §0.26 E63; the 12px cap-height inversion is refuted, and the method with it).

### §0.12 — There is no nav toolbar, and the row menus (E14)

The five-slot `<nav class="nav-toolbar">` is deleted from the markup, its rules from `chrome.css`,
`--navbar-h` from `tokens.css`, and its five glyphs (plus §9 E4a's dead `panel-left`) from
`icons.ts`. The 40px band is gone: `.tree-scroller` is content **y 40..920, height 881**. No
capability was lost that was not rehomed or ruled away: New note had three other routes, New folder
moved to the row menus, Refresh became the banner below, sorting is pinned, and **Collapse all is
gone and has no replacement** — `TreeController.collapseAll()` survives in `tree.ts` with test
coverage and NO caller.

**The row menus, current state:**

| target | rows |
|---|---|
| file | Rename… · Copy absolute path ‖ Delete |
| folder | New note · New folder · New secret file ‖ Rename… · Copy absolute path ‖ Delete |
| empty space | New note · New folder · New secret file |

`fileRowMenu` takes `EntryActions` — `rename`, `copyPath`, `remove` — and nothing else, so a file
menu has nowhere to put a create row (§0.16 E18). `New secret file` (a Cairn-only `cairn-type:
secrets` note) is a later addition; `Copy absolute path` was REMOVED from the empty-space menu. Row
glyphs are named for the string Obsidian's own `setIcon()` receives, minus `lucide-` (§0.15 E17).

**Sorting is pinned in the UI only.** `SortMode`, §1.3 command 7 and the persisted per-vault `sort`
all stay; the menu is gone and the frontend only ever sends 0, which is file name A–Z.

**The watcher-degraded banner.** A lit nav slot is replaced by a `.watch-degraded` banner with its
own `[ Refresh ]` action. The button must stay labelled `Refresh`: both Rust hint strings end *"Use
Refresh to pick up changes."*, and that sentence is shown in this bar's own tooltip. Banner rank is
`gone > stale > truncated`:

```
.sidebar
  .vault-lost       48px  §7.3 case 8    the root is gone
  .watch-degraded   48px  §7.3 case 16   the tree is not live
  .cap-banner*    2×24px  §3.3           the vault is truncated
  .tree-scroller | .search-panel
  .vault-bar
  .sidebar-resize   (absolute, no layout space)
```

**`Copy absolute path` adds no command and crosses no IPC.** `VaultInfo.root` is the absolute vault
root, `absolutePath(root, rel)` is the join, and the write is `navigator.clipboard.writeText`. The
call is deliberately not async and awaits nothing before the write, because the engine requires
transient activation for it.

#### §0.12.2 — A network vault has no refresh (user decision)

A network (NFS/SMB) vault emits no watcher events at all, so external changes require a re-open. On a network vault the watcher STARTS successfully —
`watching` is `true` and `nc://watch-degraded` is never emitted — so **the degraded banner is never
drawn there and there is no refresh route**: `rescan_all` keeps its one caller (the banner's button
on a degraded LOCAL watcher) and re-picking the same vault is a no-op. This is a user decision taken
with the alternatives on the table, not an oversight: **do not draw the banner when `watching` is
true**, and do not re-litigate. The remaining recovery is a re-open: switch to another vault and
back, or restart.

### §0.13 — A right-click the tree answers MUST cancel the engine's menu (E15)

`ev.preventDefault()` is called on BOTH paths that open a menu — the row path and the empty-space
path (`nodeAt` returning −1 is a menu, not the absence of one). The two early returns differ in
meaning: `inEdit` lets the inline rename field keep the engine's own cut/copy/paste menu, which Cairn
does not reimplement, and the frozen branch cancels both. Without the call the engine's menu opens
as well as Cairn's, and on an engine that draws one it wins. (On Electron the renderer draws no
default context menu, so Cairn's menus are the only ones; the call is kept as the guard it was
always meant to be.)

### §0.14 — The row menu is Obsidian's own box (E16)

`.ctx-menu` padding `6px`, radius `8px`, `13px` on a `1.3` line-height. `.ctx-item` padding
`4px 8px`, gap `8px`, radius `4px`. `.ctx-sep` is a RULE not a box — `height: 0`, `margin: 6px -6px`,
`border-bottom: 1px` — bleeding 6px past the menu's own padding so the line runs edge to edge. A
16px glyph at stroke 2 on every row, `--text-muted`, red on the Delete row. **The row height is
24.9px and is DERIVED (13 × 1.3 + 4 + 4), never pinned.** The icon slot is UNCONDITIONAL (§0.27
E67): a row with no icon gets an empty, zero-width slot and pays only the row's `gap` for it.

#### §0.14.1 — DELETED (the 1.12.7-vs-reference-PNG palette conflict; the palette is settled on 1.13.7 — §5.1).

### §0.15 — The row-menu glyphs are Obsidian's own names (E17)

Each row-menu glyph is named for the string Obsidian's own `setIcon()` receives, minus the `lucide-`
prefix, so the mapping is settled by grep and not by judgement: `edit`, `folder-open`, `edit-3`,
`clipboard`, `trash-2`. **`edit` IS `square-pen`** — Obsidian's registry holds both names against
character-for-character identical path data. `edit-3` is not `pencil-line`: it has the underline and
no nib.

### §0.16 — A file row offers no create rows (E18)

`New note` / `New folder` / `New secret file` appear only where a create has an unambiguous
destination: on a folder row (inside that folder) and on empty space (at the vault root). A
right-click on a FILE offers `Rename… · Copy absolute path ‖ Delete` and nothing else. This is
Obsidian's own behaviour: its create rows sit inside a folder-type guard while Rename and Delete sit
outside it. `fileRowMenu` carries the rule in the type; `folderRowMenu` is the file menu with the
creates above it; `emptySpaceMenu` offers the creates only. `destinationFor()` is deleted — Mod-N
calls `parentOf` directly. **Reported, not changed:** with the cursor on a FOLDER, Mod-N still
creates in that folder's parent.

### §0.17 — Four rulings read out of Obsidian's own bundle (E19–E22)

**E19 — EVERY FOLDER DRAWS A CHEVRON, empty or not.** Obsidian's `setCollapsible(true)` is
unconditional and is what creates the collapse icon; `tree.ts`'s predicate is keyed off `kind`
alone. `treeblob.ts`'s `hasKids()` still means "has children" and is unchanged. **M61 is struck.**

**E20 — a click on the inline title places the caret; only a programmatic open selects all.**
`livepreview.ts` computes a character offset from the pointer via `caretRangeFromPoint`, and the
select-all is the New-note path.

**E21 — the Electron window options are Obsidian's own:** `frame: false` +
`titleBarStyle: 'hidden'` + `trafficLightPosition { x: 19, y: 12 }` (`app-main.mjs`). §5.6's
`20 / 17.5` was fitted to tao's container-height law and does not apply.

**E22 — neither create gesture prompts.** New note creates `Untitled.md`, opens it and focuses the
title; New folder opens an inline editor on a fresh tree row (`tree.beginCreate`). The centred
`promptForName` dialog survives only for rename and as the fallback when a collapsed parent has no
row to host the editor.

### §0.18 — The UI font is Obsidian's own stack (E23)

Obsidian bundles Inter and never reaches it: its own `--font-default` begins `ui-sans-serif,
-apple-system, BlinkMacSystemFont, system-ui, …` and `"Inter"` sits ninth. `--font-ui` is that stack
copied byte for byte, verified by extracting both from the shipped CSS and the asar and comparing
the normalised strings — so the two resolve identically by construction. **The fix is the stack, not
the font**: nobody has to be right about what it resolves to.

### §0.19 — The type spine, the fitted insets, and a retired gate (E24–E26)

**E24 — the heading ladder is Obsidian's own, and it is stated once, in §5.4.** `--h1-size: 1.618em`
= 25.888px; weights 700/680/660/640/620/600; line-heights 1.2/1.2/1.3/1.4/1.5/1.5; letter-spacings
−0.015…0em. `--lh-tight` is deleted. `tools/verify-geometry.js`'s `K.h1Size` is held against
`tokens.css` by `geometry-probe.test.mjs`, so the two cannot drift.

**E25 — `--editor-inset-x` and `--editor-inset-y` are both 32px**, Obsidian's `--file-margins-x/y`
(`--size-4-8`). The 30/33 pair was a fit — two free parameters against two ink targets — and is
gone.

**E26 — the CSS size gate is RETIRED** by user ruling. `build-app.mjs` still prints `css=`;
nothing fails on it, and 20,000 is not to be restored.

#### §0.19.1 — DELETED (the probe's DPI-insensitivity is retired; the rule that replaces it is E27, below).

#### §0.19.2 — G9 states its comparison on the DEVICE GRID (E27)

A numeric check records WHICH rule admitted it:

| rule | test | when |
|---|---|---|
| `exact` | `\|got − want\| ≤ EPS` | the rule that has always applied |
| `snap` | `got` is `want` snapped to the device grid, within EPS | one snapped edge |
| `device-px` | `\|got − want\| ≤ 1 device px + EPS` | a value summed from more than one snapped edge; fractional scales only, and counted in the report |

At an integer scale `snap` degenerates to `exact` and `device-px` is unreachable, so nothing changes
at dpr 1 or 2. The report carries `dpr`, `tolerance`, `integerScale` and `viaDevicePx`, so a green
run at a fractional scale can never be quoted as a green run at 1.

### §0.20 — The napi addon, and the wire's value envelope (E28–E31)

The Rust core runs behind a Node-API addon (`core/napi/src/lib.rs`); `src/ipc.ts` is the frontend's
only IPC module. **Every §1.3 result crosses as a value envelope `{ ok, value }` / `{ ok, error }`**
(E29); faults that are not §1.5 `VaultError`s still throw. **A search subscription ends on `complete`
or `error`, not at call return** (E31), so a caller that starts one keeps it alive until it ends.

#### §0.20.1 — Four mechanisms that fail silently

Each cost time and none produced an error message.

1. **`await app.whenReady()` at the top level of an ESM main entrypoint DEADLOCKS.** Reproduced with
   no addon loaded, in a four-line file. `app-main.mjs` is shaped `whenReady().then(...)`.
2. **A napi threadsafe function REFS the host event loop**, so a process that loads the addon can
   never exit on its own. `node --test` ran every assertion, passed, and hung. `weak::<true>()`.
3. **A bare Rust tuple through a threadsafe function arrives as ONE JavaScript array**, not two
   arguments; only `FnArgs` spreads it.
4. **A renderer's `performance.now()` is clamped to 100 µs** (a Spectre mitigation). Time the whole
   loop and divide.

#### §0.20.2 — Open items, named rather than fixed

- **`pick_vault` is Electron's `dialog.showOpenDialog`, in the MAIN process, deliberately.** The
  renderer only asks; no `dialog:*` capability is granted. The addon's `AppCtx::on_main_thread`
  returns an ERROR rather than dropping the closure, so `app::pick_vault` cannot be wired here by
  accident and hang — it is unreachable from the Electron shell, and its `rfd` dependency is
  currently dead.
- **Command 19 `debug_mem` is absent from a release addon.**
- **The write path has no `x-` headers.** Its guarantees are carried by argument TYPES —
  `Either<f64, Null>` refuses `undefined`, which is what a dropped field arrives as.
- **`reveal_in_os` (command 20) is macOS-only permanently** — E59, §0.25.

#### §0.20.5 — Packaging (E34)

`tools/package-electron.mjs` builds the artefact with no `electron-builder` and no dependency. It
REFUSES to build anything unless the addon and the bundle already exist and are current, and says
which is missing rather than packaging a stale one. The stylesheet is INLINED into the page
(`build-app.mjs`), so a package cannot render unstyled; Electron's `default_app.asar` is removed so
a packaging mistake cannot fall back to the welcome screen. `electron-shell/package.test.mjs` runs
the shipped binary through a real tree-row click and a real contenteditable insertion and then reads
the bytes on disk. There is no `Depends:` line in the control file — a dependency list is a promise
about machines, and §9 E5 says the only machines are the author's. `postinst` sets the setuid bit on
`chrome-sandbox`. **macOS packaging is verified** (packaged, signed and launched 2026-09-09, K8):
releases ship the signed `.dmg` through the private 1.0.0 release; day-to-day dev still runs from
the checkout with `npm run electron:app`.

#### §0.20.6 — DELETED (Tauri was deleted — E35; the stack is Electron 39.8.3 / Chrome 142 + the napi core; `src-tauri/` is now `core/`, and `cargo tree` holds zero tauri crates).

#### §0.20.6.1 — DELETED (the two defects the Tauri deletion found — E36; the persisted sidebar width now reaches the page via `additionalArguments`, §0.7, and `__PIXELTEST__` is not platform-gated).

### §0.21 — `dl_23` drives the packaged binary (E38)

`electron-shell/shipped-binary.test.mjs` drives the PACKAGED binary — the artefact `dpkg -i`
installs — through a real startup and asserts M67's sweep exactly: a dead-PID temp is unlinked, a
live-PID one is spared, a nested dead one under a subdirectory is swept (so the walk really
descends), and `.hidden.tmp-notes` is untouched. Plus §7.6 (the seeded `state.json` is the one it
read and rewrote, proved by a decoy at the front of `recents`), G8 (the vault holds the notes and
nothing else), and **the watcher started**. `CAIRN_DIAG=1` logs the event bus in both directions.

#### §0.21.1 — DELETED (a deleted app's artefacts outlive the deletion; a measurement of a stale binary is not a measurement).

#### §0.21.3 — DELETED (G10's instrument — E37; G10 and `tools/g10.mjs` were removed. `tools/png.mjs`, `tools/pixel-diff.mjs` and `tools/capture-app.mjs` remain as general capture and diff tools).

### §0.22 — macOS runs, the gate window, the watcher (E39–E45)

**Say the dpr with every geometry number.** It is not a property of a machine — monitors get
swapped — so measure the scale, do not assume it.

#### §0.22.1 — macOS and the ad-hoc launch (E39)

`tools/cairn.entitlements` — `disable-library-validation`, `allow-jit`,
`allow-unsigned-executable-memory` — is **load-bearing**. An ad-hoc signature has no Team ID and
hardened-runtime library validation reads two absent Team IDs as two different ones, so **ad-hoc and
library validation are mutually exclusive by construction**; without the entitlement the app dies at
image load. `tools/sign-macos.sh` signs the nested bundles NUL-safely (the depth counted in bash)
and signs `cairn.node` explicitly — it is a Mach-O the main process `dlopen`s, and the Frameworks
sweep cannot see it. An XML comment may not contain two consecutive hyphens; prose lives in the
`.sh`, not the plist. **`codesign --verify --strict --deep` passes on a bundle that cannot start** —
it answers "is this signature well formed", never "will this run" — so the last step of any signing
change is to open the app.

#### §0.22.2 — The display guard is one predicate (E40)

`electron-shell/have-display.mjs` is THE display predicate. The old guard
(`!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY`) meant "not Linux" — on macOS neither
variable is ever set — and skipped 16 tests that all pass. **A SKIP is a third kind of green**:
nothing in a summary line distinguishes "16 skipped" from "16 that cannot fail here".

#### §0.22.3 — The gate window is 1920 × 964 (E41)

`winW` / `winH` are **1920 × 964** (the reference's content box — there is no 1px frame),
`editorW` **1508**, `treeH` **881** (§0.12 E14's own number), the vault bar's rule at content y
**921** (a 43px bar), and `lineW` **1432** (1508 − the 12px editor gutter of §0.37 E84 − 2 × 32
insets). **The gate size is not the window's default**; nothing in the app moves with these, they
are the fixture. All other geometry is derived from them.

#### §0.22.4 — The inline title's gap is its own token (E42)

`.nc-title`'s bottom margin is `--inline-title-space-after: 12.944px` — Obsidian's
`--inline-title-margin-bottom: 0.5em` of the title's own 25.888px, read off the live app's computed
style rather than resolved on paper. It is a token of its own because the inline title and the body
headings are separate models. `K.firstLineTop` is **116.0096**, and the `title | margin-bottom` row
moves with it.

#### §0.22.6 — The active row is Obsidian's (E44)

Obsidian declares `--nav-item-background-active = var(--background-modifier-hover)`, so **the active
nav item IS the hover value**; Y3's `.15` was Obsidian's LIGHT-theme hover, and the distinction it
built is one Obsidian has never drawn. The fill is Obsidian's **inset rounded rect**: `.tr::before`
is inset from the row's edges with `border-radius: 4px` and `corner-shape: var(--tree-corner-shape)`
(the macOS superellipse), stopping 2px short of the row's bottom because `.tr` is absolutely
positioned at a fixed pitch and a margin there would desynchronise the row pool. **`--row-h` is a
MEASURED value**, re-seated at runtime by `chrome.ts`'s `applyRowH` (26.890625 on the Mac's font;
27 is only the DOM shim's fallback). While a shift-selection is live, the active fill is **withheld
everywhere** and the selection fill (`color-mix(in oklch, var(--accent) 15%, transparent)`) is the
only one.

#### §0.22.7 — The watcher, and FSEvents history (E45)

`Epoch` is minted BEFORE `watch()` and drops any path whose inode has not moved since — because
FSEvents reports the accumulated flag set for each path in its latency window, so a write from
before the stream started arrives after it, indistinguishable from a live external edit. **It reads
ctime, not mtime, and that is the design:** mtime is caller-controlled (`rsync -t`, `cp -p`,
`tar -x`, a backup restore all set it backwards), so an mtime guard swallows exactly the file a user
just restored; ctime cannot be set by any API. A vanished path is never guarded — a deletion must
always propagate. `full_rescan` is reserved for `Any`/`Other` events, NOT `path == root`: FSEvents
reports the watched directory itself whenever a child is added or removed, so the old rule cost a
whole-tree rescan for every note created in the vault root.

#### §0.22.8 — Packaging scope, and two capture rules

**Packaging ships through the private 1.0.0 release** (§9 E5): day-to-day dev still runs from the
checkout, and `electron-shell/package.test.mjs` and `shipped-binary.test.mjs` still skip on macOS
in a checkout — their assertions are Linux-layout-specific and the macOS packaged-binary
assertions do not exist yet — so **`dl_23` has never run on macOS** — an honest gap, not a
passing test.

**Two capture rules, both bought with a wrong number:** force `--force-color-profile=srgb` on BOTH
sides of any pixel comparison, or a colour profile invents a palette defect (Obsidian stores
`#242424` for a surface its own computed style calls `#282828` — `tools/capture-app.mjs` refuses a
tagged capture); and kill every leaked dev process before capturing, or a capture can come out at
the wrong scale **while its report still says `dpr=1`**.

### §0.23 — Full live preview (E46–E48)

Live preview is **one CodeMirror 6 editor with decorations over the source**; Obsidian has no second
pane, and `src/livepreview.ts` has had that architecture since v1. This pass grew the construct set.

#### §0.23.1 — The tokeniser is Obsidian's own CM5 mode, transcribed (E46)

**Obsidian does not use `@lezer/markdown`.** Its live preview runs the stock CodeMirror 5 `markdown`
stream mode — `lib/codemirror/markdown.js`, configured with `highlightFormatting`, `taskLists`,
`strikethrough`, an `highlight` option and `tokenTypeOverrides` — wrapped by
`@codemirror/language`'s `StreamLanguage`, plus Obsidian's own wrapper mode
(`defineMode("hypermd", …)` inside `app.js`) which adds classes and carries the bare-URL and
`[[wikilink]]` rules. Cairn transcribes that tokeniser by hand: **a line-at-a-time tokeniser, no
`@lezer/markdown`, no new dependency.** **Seam rule 3 is amended**: a nested inline construct closes
before its parent, so ranges are collected into an array and applied with
`Decoration.set(ranges, true)` — which is what Obsidian's own decorator does.

#### §0.23.2 — The reveal rule, and what renders (E47)

**The reveal is three rules.** A caret anywhere on a heading line reveals its `## ` but NOT the bold
on the same line; inline formatting is revealed against the construct's own span; a list bullet is
revealed only for a caret exactly on the bullet (a one-character group). **An unfocused editor
reveals nothing** (§0.23.3).

Constructs: ATX headings, fenced code blocks, thematic breaks, blockquotes (nested), bullet and
ordered lists, task checkboxes, bold / italic / bold-italic / strikethrough / `==highlight==`,
inline code, `[text](url)`, `<url>` autolinks, `[[wikilink]]`, bare urls, backslash escapes, tables,
`totp` fenced blocks, and pasted clipboard images (`![…](data:image/…)` — Ctrl/Cmd-V writes the
data URL into the note, one atomic widget, Backspace/Delete or the Cairn `[C]` X removes it).
`![[embed]]`, `#tag`, `[^footnote]`, callouts, math, mermaid, non-pasted images and
inline HTML remain absent, each named — `docs/KNOWN-ISSUES.md` LP-2 is the live list. **Two
deviations from Obsidian remain:** list depth is not tracked (`grep` of `app.css` finds no rule for
`.cm-list-1/2/3`, so the stack would move no pixel), and the `<hr>` widget is inline rather than
block (CM6 refuses block decorations from a `ViewPlugin`). Both put a real `<hr>` on the line; the
difference is the line box around it.

#### §0.23.3 — The reveal is gated on focus (E48)

Obsidian's decorator opens `hasFocus ? selection.ranges : []`. Cairn matches through `view.hasFocus`,
and **`electron-shell/app-main.mjs` takes the focus the window is entitled to**: `show()`,
`focus()` AND `webContents.focus()` — all three measured necessary on Debian/GNOME, where
focus-stealing prevention leaves a shown window unfocused. `verify-geometry.js`'s `caretTo()`
focuses the view for the same reason: a caret is on a line because a user put it there.

### §0.24 — The Properties block (E49–E58)

A note whose first line is exactly `---` hides its YAML and renders Obsidian's **Properties** panel
in its place — one block `Decoration.replace` from a `StateField`. Unparseable frontmatter is NOT
hidden, which is Obsidian's own rule. The inline title is a block widget at 0 with `side: -1`, so
the ordering comes out as Obsidian's even though Obsidian's panel is a DOM sibling of `.cm-content`
and Cairn's is a widget inside it.

#### §0.24.1 — The frontmatter rule (E49)

Line 1 must be exactly `---`, and the block ends at the first later line that is exactly `---`. `--- `,
`----` and ` ---` are not frontmatter, and a note opening with `----` gets an ordinary thematic
break. The type icons are Obsidian's own table, transcribed value by value:
`registeredTypeWidgets` (`aliases, checkbox, date, datetime, file, folder, multitext, property,
number, tags, text`) plus its inference (`datetime` / `date` by regex, `number`, `checkbox`,
`multitext` for an array of strings, else `unknown`), with `aliases`, `tags` and `cssclasses` fixed
by key. An unknown value renders Obsidian's orange JSON string (`lucide-file-question` +
`JSON.stringify`).

#### §0.24.2 — The parser bails; it does not guess (E50)

`parseFrontmatter` returns `null` for anything outside its subset, and `null` means *leave the
frontmatter on screen as source* — Obsidian's own behaviour on a parse error. Out of the subset,
each with a named test: block scalars (`|`, `>`), anchors (`&`), aliases (`*`), explicit tags (`!`),
flow mappings (`{a: b}`), tab indentation, a map more than one level deep, a sequence of maps, a
nested flow collection, and any line that is not a key. `KEY_RE` needs a space after the colon, so
`- https://example.com` is still a scalar.

#### §0.24.3 — The paragraph is the inline unit (E51)

A maximal run of lines that open no block (no blank, quote, heading, thematic break, list marker or
fenced block), joined with their newlines, so a delimiter's flanking test sees `\n` as the
whitespace it is; and the walk goes BACK to the paragraph's first line, so a viewport opening
mid-paragraph is tokenised with the state it really has. **Both are bounded** — 200 lines and 20,000
characters. `emit` drops any construct with no intersection with `[from, to]`, so seam rule 1 is not
weakened.

#### §0.24.4 — The fold arrow

Invisible at rest; visible on the heading's hover, or while collapsed. `--text-faint` at rest,
**`--text-accent` while collapsed**. **10px at stroke 4**, rotated on the SVG itself — the box is
`position: absolute` with 6px of side padding, so rotating the box pivots around a point 6px off the
glyph's centre. `setCollapse` toggles `is-collapsed` on THREE elements (container, heading, fold) and
each drives a different rule. The property-type icons are `--icon-m`: **18px, stroke 1.75**. The
hover rule is asserted as a declaration in `tests/frontend/properties.test.mjs`, because a
pseudo-class needs a real pointer. `app-main.mjs` takes `CAIRN_CAPTURE_CLICK=<selector>` — one real
`mousedown` before a capture, so an interactive state can be photographed at all.

#### §0.24.5 — The inline title's spacing, and the rule that was eating transitions (E52, E53)

The inline title's bottom margin is §0.22.4's 12.944px token; `K.firstLineTop` is 116.0096.

**§5.1 rule 5** — `*, *::before, *::after { transition: none !important; animation: none
!important }` — outranks a NORMAL inline style, so it defeats `element.style.transition` as surely
as it defeats a sheet. Three declarations written to match Obsidian were dead on arrival and nothing
failed. Two are now exempted — the fold slide (inline `!important`, 100ms
`cubic-bezier(.02, .01, .47, 1)`) and the fold arrow's rotation — and the task checkbox's
`box-shadow` transition is **still dead and named** (its `:hover` changes `border-color`, and
nothing ever sets `box-shadow` on it). Rule 5's stated reason is gone — the engine it was written
for was deleted — but whether a blanket ban still earns its keep is a user ruling, not taken. **A
settled-state assertion cannot tell a transition from a class flip**, so the fold test samples 40ms
into the animation and asserts the height is strictly between 0 and the resting height.

#### §0.24.6 — The block edits (E54, E55)

The property icons take `--icon-color` (`--text-muted`), not `--text-faint` — the LIST MARKER's
colour. A brightness profile down one glyph column separates the two: peak 151 against 74 over the
same ground. (A difference reported as one dimension can be another: peak POSITION is the
contrast-free size measure, peak HEIGHT is the colour measure, and the bounding box confounds them.)

**The block EDITS, and `+ Add property` exists because it works.** The key is a real `<input>`, a
scalar value a real `contentEditable`, the checkbox toggles, and Add property renders a row, focuses
its empty key, and **writes nothing** until the key has a name. **EVERY WRITE IS ONE LINE and never
a re-serialisation, and that is the whole safety argument** — Cairn's parser is deliberately
incomplete, so rebuilding the YAML from it would silently drop a comment, a quoting style or one of
the ten constructs it refuses. **rename** replaces the KEY TEXT only (so a sequence like `- alpha` /
`- beta` under `tags:` is not orphaned), **set** replaces what follows the colon on that one line,
**add** inserts one line before the closing `---`. The tests assert the WHOLE DOCUMENT after each
edit. Still absent, each a feature: deleting a property, editing a LIST, the type picker, drag
reorder and vault-wide name autocomplete. One departure from `app.js`: `inferType(key, null)`
returns `text`, not `unknown` — Cairn infers per note, and only a scalar gets an editor, so the
literal transcription would render every empty property uneditable.

#### §0.24.7 — The icon was flex-shrunk (E56)

`.metadata-property-icon` gets **`flex-shrink: 0`**. That declaration is NOT in `app.css`: the 9em
key row holds the icon beside an input whose `width: 100%` makes its flex base the whole 144px, and
an outermost `<svg>` is a scroll container by UA rule, so the span's automatic minimum size is 0 and
it shrank to 0.8535 of its 22px. **It is chosen to reproduce a MEASURED box** — Obsidian's
`span.metadata-property-icon` is `[22, 28]` — rather than transcribed, and `editor.css` says so at
the rule. The box origin is pinned as relations, not numbers: `xSvg === xContent`,
`xSpan === xContent − 4`.

#### §0.24.8 — DELETED (the JS size gate — E57; RETIRED by §0.47 E95. 374,000 is not to be restored).

#### §0.24.9 — A relative unit is consumed at exactly one level (E58)

`--metadata-input-font-size` is `0.875em` and belongs on the value's CHILDREN only; declaring it on
the cell as well applied the em twice and every value compounded to 12.25px. The chain is pinned:
`container 16 · key 16 · keyInput 14 · value 16 · longtext 14 · unknown 14`.
#### §0.24.10 — The template-literal trap

A backtick inside a comment in a page script passed to `executeJavaScript` ends the template
literal and makes `app-main.mjs` a `SyntaxError` at load, presenting as a launch that hangs with no
output. `tests/frontend/shell-syntax.test.mjs` runs `node --check` over every `.mjs` / `.cjs` in
`electron-shell/`, in about 40 ms, and fails with the diagnosis rather than with a timeout.



### §0.25 — Two features ruled out, and the 120 Hz run (E59–E61)

**E59 — "Reveal in Finder" is macOS-only, permanently.** `fsops::reveal_in_os` keeps its macOS
`/usr/bin/open -R` path and answers a §1.5 `io` everywhere else; the D-Bus arm
(`org.freedesktop.FileManager1.ShowItems` with an `xdg-open` fallback) is **cancelled, not
deferred**. `main.ts`'s delete-failure dialog still offers `Show in Finder`, and pressing it on
Debian produces an error toast — the user was told the behaviour and chose it.

**E60 — iCloud is out of scope.** §7.3 case 9's evicted-placeholder path was never measured and the
ask is withdrawn; Dropbox and OneDrive are named for the same reason. **DATA-LOSS gap G-d is
CLOSED**: case 9 is PASS on the sync clients it was measured against (two real Syncthing daemons and
a real divergent edit — `electron-shell/sync-client.test.mjs`). The mechanism is unchanged:
temp+rename inside one directory, the `.`-prefixed temp name, the PID-aware sweep, and sync-client
writes handled as case 7.

**E61 — the 120 Hz deficit was measured on Debian:** Cairn presents **115.70 fps of a 120.00 Hz
panel** — deficit 3.59%, 0.49% janky, §5.12.6(d) passing at p99 0.281 ms — against the live Obsidian
on the same panel at **103.04 fps** (deficit 14.14%, handler p99 11.259 ms). The ≈13% does not
reproduce. Neither window was the gate size and the bias runs against Cairn. **Above 120 Hz,
`tools/scroll-bench.mjs`'s fps and deficit measure its own synthetic driver**, not the app —
KNOWN-ISSUES V-6.

### §0.26 — CM6's height map, the tab label, and the half-pixel (E62–E66)

**E62 — NO CSS MARGIN MAY EXIST INSIDE `.cm-content`.** CM6 records every block's height as a
BORDER box (`measureVisibleLineHeights`) and `posAtCoords` picks its block out of that map, so a
margin is real to the layout, invisible to the map, and **the map is what decides**. Both block
widgets are wrapped in `.nc-block { display: flow-root }`, which CONTAINS a child margin instead of
collapsing it through. Obsidian pays nothing for the same `margin-block-end` declarations because
its inline title and its Properties panel are DOM siblings of `.cm-contentContainer` and CM6 never
measures either; Cairn draws them as block widgets INSIDE `.cm-content` (§5.4.2 X18), and that is
where the bill arrives. Where Obsidian does put spacing on a line inside the content it uses
PADDING, never a margin.

**E63 — the tab label is 13px** (`--font-ui-small`, weight 400). The 12 was inverted out of the
reference PNG through Inter's 0.7275 cap ratio, and Obsidian never reaches Inter (§0.18 E23).

**E64 — `body` pins no cursor.** `cursor` inherits, so a `body { cursor: default }` reached every
glyph in every note and the editor never got its UA `auto`; the companion rule
`body [contenteditable] { user-select: text }` had also never been transcribed. After the fix the
note body, headings, inline title and Properties inputs set `text`; tree rows, tab label, vault bar
and property glyphs set the arrow.

**E65 — the window opens MAXIMIZED on a normal launch** (user ruling), never under `--pixeltest` —
which must stay deterministic — and never headless. The call site is Obsidian's own: maximize the
hidden window, then show it. The shipped size is still the restore size.

#### §0.26.1 — Why a margin inside `.cm-content` broke the caret

The user's report: *"I clicked. The caret jumps down 2 lines. Other notes work fine."* CM6 resolves
a coordinate in two steps — `posAtCoords` picks the BLOCK out of its height map, then hit-tests
inside that block's DOM — and the map is built from border boxes. Three margins were leaking (the
inline title's 12.944px, the Properties block's 2rem, and the old `--hN-space-after`), so the map ran
44.944px short before the first line of a note with frontmatter: the caret landed up to two lines
below the pointer. "Other notes work fine" is exactly right — a note with no frontmatter lost only
half a line. **Nothing below a real engine could see it**: the decorations, the DOM and the CSS were
all correct. Two rows now exist in `electron-shell/live-preview.test.mjs`: one clicks the centre of
every visible text row and requires CM6's answer to equal `caretRangeFromPoint` at the same pixel,
and one requires `viewState.docHeight` to equal the height actually laid out, to half a pixel (the
one with no tolerance).

#### §0.26.2 — The tab is top-anchored and its label carries Obsidian's line-height (E66)

The user saw a half-pixel. It is **0.45 CSS px of box geometry that Chromium's baseline snapping
turns into a whole device ROW**, from two independent causes, **neither of which moves the glyphs
alone**. `.tab` was anchored from the BOTTOM (`height` against `align-items: flex-end`), so its top
was *strip content height − 33* — and the strip's content box is **39.2** at dpr 1.25, because
`.titlebar`'s 1px `border-bottom` snaps to 0.8; Obsidian lays its tab out from the TOP. And
`.tab-label`'s line box was a flat **13px** where Obsidian's title inherits `--line-height-tight:
1.3` = 16.9px. The fix is `align-self: stretch` + `margin-top: var(--tab-top)` on `.tab`, and
`line-height: 1.3` on the label. Fixing either alone leaves the ink one row low; both together put
it on Obsidian's rows row for row. **It exists only at fractional scales** — at dpr 1 and 2 the old
code was already right — so the regression test forces `--force-device-scale-factor=1.25`.

#### §0.26.4 — Compare at identical settings, both maximized, from the window origin

The tab's horizontal x is NOT off: `pane + 18.000` in both apps, producing identical device pixels
at every sidebar width. `18 × 1.25 = 22.5` puts the tab's edge permanently on a rounding boundary,
so the tab AMPLIFIES a difference the seam physically cannot show. **Compare only at an identical
`sidebar_w`, both windows maximized, capturing from the window origin** — a
`Page.captureScreenshot` clip at a fractional CSS x resets the rasteriser's sub-pixel phase and
makes the whole question invisible. **And compare at identical SETTINGS**, not just an identical
`sidebar_w` — a fresh Obsidian profile is Obsidian's DEFAULTS (readable line length ON, sidebar
300), which answers for a configuration nobody runs (§0.41).

### §0.27 — The vault switcher popover (E67)

**The tick is a TRAILING glyph.** Obsidian's `MenuItem.setChecked` appends a SECOND
`.menu-item-icon.mod-checked` (`lucide-check`) AFTER the title; `.menu-item-title` is `flex: 1 0 0`,
so it grows and pushes the glyph against the row's right padding edge. It is a normal icon slot:
**16px at stroke 2**, not spec-01 §7.2's 14, and not a `::before` in a left gutter — which would put
the mark on the wrong side and indent every ticked row's label out of line.

**The icon slot is UNCONDITIONAL.** Obsidian's `MenuItem` constructor emits `menu-item-icon` on
EVERY row; `.menu.mod-no-icon` is an opt-in (`setNoIcon()`) that nothing in this popover calls. An
iconless row gets an EMPTY, zero-width slot and pays only the row's 8px `gap`. **§0.14 E16's
all-or-nothing rule was an inference**, and its hard `flex: 0 0 16px` plus its whole-menu
suppression were two compensating errors; both are gone. E16's row metrics are untouched and were
right.

**The border and the shadow.** `--menu-border-color` is `--background-modifier-border-hover` →
`#3f3f3f`; `#333333` is the SEPARATOR's. `--menu-shadow` is `--shadow-s`, three layers, not
`--shadow-popover`'s single `0 2px 8px` — a second shadow in an app whose §5.1 says there is one.
`--shadow-popover` itself is NOT changed; `modal.ts` and the delete-failure dialog are its remaining
consumers (KNOWN-ISSUES UI-4).

**The last row keeps Cairn's label and takes Obsidian's `open-vault` glyph.** The action is the
native folder picker; the glyph comes from Obsidian's own CUSTOM table, not Lucide (same root
attributes, different viewBox family — checking which table a glyph is in is not optional). It is
what makes the popover the right shape: in both apps the last row's label sits 16px right of the
vault names above it, because its slot is filled and theirs are not.

### §0.28 — What dismisses a menu is a closed set (E68)

The user: *"Obsidian persists this menu even when I alt+tab. It only disappears when I click away or
click on an item inside that menu!"* That is the complete dismissal set. Obsidian's `Menu.onload`
registers exactly three window events — `mousedown`, `click` and (desktop) `contextmenu` — plus
`Escape` in the keymap scope it pushes. **There is no `blur`, no `resize` and no `scroll` handler
anywhere in the class.** Cairn's set: outside `pointerdown` / `click` · `Escape` · activating a row ·
`contextmenu`.

**`contextmenu` is in CAPTURE here and BUBBLE there**, because **Cairn's menu is a singleton**:
a bubble-phase listener on `document` would run after a tree row's own handler had already called
`openMenu` and would close the menu that had just been opened. In capture it runs first; same
observable behaviour, opposite phase, and the reason is Cairn's data structure.

Pinned two ways. `tests/frontend/chrome-ui.test.mjs` reads `menu.ts` and pins the registrations as
an ordered list and the ABSENCE of a `window` listener — it reads the source because the stubs make
a behavioural row blind to a registration coming back. `electron-shell/menu.test.mjs` takes a REAL
mapped window and hands focus to a second one, because **`win.blur()` is a no-op on Wayland**; it
FAILS a run where focus did not move rather than passing on a question it never asked.

### §0.29 — A menu is placed at the POINTER (E69)

The user: *"The left bottom corner of the dialog is always the place I place my cursor."* Obsidian's
`showAtPosition` is one clamp:

```
left = (x + 2 + w <= vw) ? x + 2 : max(0, x - 2 - w)
if (y + h > vh) y = max(topInset, y - h)
top  = y + 2
```

With room below, the TOP-left corner lands at the cursor; without it the menu is lifted by its own
height first, so its BOTTOM-left corner lands at `y + 2`. One rule, not two. **There is no viewport
margin** — Obsidian floors at 0 and will sit a menu flush against the edge; `clampPopup`'s 4px
margin was a Cairn invention and is gone. (`clampPopup` itself survives for `inline-edit.ts`'s own
popup, which is not a menu, and `MenuOptions.alignRight` / `flipAboveY` are deleted.) The tree row
menus already pass `ev.clientX/clientY` and inherit the fix for free.

**The keyboard case Obsidian does not have.** ⌘⇧O opens the popover, and a keyboard has no pointer:
`openPopup(at?)` falls back to the bar's own top-left, and a `<button>` activated with Enter or
Space fires a `click` at 0,0 — a real coordinate that cannot be told from a click in the corner by
the numbers. `event.detail` separates them: the click count for a mouse, **0 for a synthesised
activation**. Without that check, ⌘⇧O would drop the popover in the window's top-left corner.

### §0.30 — Four user requests, and the mistake one of them caught (E70–E74)

#### §0.30.1 — `Close` on a non-active vault row (E70)

§1.3 gains command 21, `forget_vault(root)`. It writes `state.json` and **touches nothing in the
vault** — the folder is not read, moved or deleted. It answers §1.5 `invalidPath` for the OPEN vault,
which is Obsidian's own refusal reached from the other end; the UI cannot reach the non-canonical
spelling where that refusal is a silent no-op (KNOWN-ISSUES X-10). Clearing `State.vault` when it
names the forgotten root is part of it, or a vault forgotten while vault-lost (§7.3 case 8) reopens
on the next launch.

The control is `menu.ts`'s optional `trailing` — a real `<button>`, absolutely positioned and
hover-revealed so the RESTING popover keeps §0.27 E67's box (`widthAtRest === widthWhenShown`,
asserted in a real engine). It is **omitted** on the open vault's row rather than drawn disabled
(§9 E4), and **kept** on a missing vault's row: that row is disabled, forgetting it is the one thing
left to do with it, and the core prunes missing vaults on the NEXT launch
(`prune_missing_vaults`), so the row only ever describes a deletion that happened while the app was
running.

#### §0.30.2 — The tab strip's `+` is deleted (E71)

It was a New note button wearing Obsidian's new-TAB glyph in a single-tab viewer. New note keeps its
real routes — Mod-N and the tree menus — where the destination is unambiguous. The element, its CSS
rule, `TabStripDeps.newNote` and its handler are gone. Nothing in the strip moves: the tab is the
first child and was never positioned by it.

**The mistake, and it is the useful part:** `plus` had a SECOND host — `properties.ts` draws
`+ Add property` with it — and deleting the glyph left that button **blank** while `tsc` stayed
clean and the frontend suite stayed green, because `chrome-ui.test.mjs`'s glyph-host row ran one
direction only (*every glyph has a host*, never *every host has a glyph*). It runs both directions
now, with `panel-left` the one named exception.

#### §0.30.3 — 24px of empty space under the tree's last row (E72)

`.tree-scroller` takes `padding-bottom: 24px` (`[S]`, Obsidian's `--size-4-6`), bottom only — the
other three sides are §5.2's measured box model, which G9 asserts to the pixel. `safe-area-inset-
bottom` is 0 on both targets and the `max()` is dropped rather than transcribed as a value that can
never win. Scoped to the tree; the search panel draws no context menu. Padding leaves the border box
alone, so G9 is unmoved; it changes `scrollHeight`, which is the point. (The 72 / 216 / 144 / 108
sequence is withdrawn — §0.32.4.)

#### §0.30.4 — 16px above every heading (E73)

A heading line takes `padding-top: var(--p-spacing)` = **16px** (`[S]`, Obsidian's
`.cm-line.HyperMD-header`), and a heading exactly ONE blank line below another takes NONE — the blank
line is already a full line of space. **PADDING, NEVER MARGIN** — a margin on a `.cm-line` is
invisible to CM6's height map (§0.26 E62), and at 16px per heading this would have been the largest
such trap the app has had. `livepreview.ts` writes a shared `nc-h` beside `nc-hN` (Obsidian's own
`HyperMD-header` class), or rule 3 is a 36-way selector and rule 1 is six rules.

**RULE 2 IS NOT TRANSCRIBED, and that is a KNOWN DIVERGENCE.** Obsidian's
`.cm-line.HyperMD-header + .cm-line:not(.HyperMD-header):not(:has(>br:only-child)) { padding-top:
var(--p-spacing-empty) }` is 0 and outranks the `padding-top: var(--list-spacing)` a list line
carries, so the first list line after a heading is **25.19px** tall in Obsidian and **26.38** in
Cairn, and every line below it sits **+1.19px** low. It needs a ruling or a fix — KNOWN-ISSUES
LP-18. G9's `K.firstLineTop` is unmoved, because padding is inside the border box.

#### §0.30.5 — …and no space below one (E74)

**A heading has NO space below it.** Obsidian's base is `.cm-line { padding: 0 }` and no rule adds a
`padding-bottom` to a heading, so the gap under one is the next line box touching.
`--h1-space-after` … `--h6-space-after`, their six rules and `K.h1Space` are **DELETED**. Measured
both ways on the same DOM in the pinned engine: `heading.top → next.top` **47.0625 in both** after,
against Cairn's 57.0625 before. The 10/9/8/7/6/6 ladder was a hand-made ladder, not six measurements.

### §0.31 — A wrapped list line hangs under its own text (E75, E76)

#### §0.31.1 — Obsidian does this in JavaScript, and the offset is measured (E75)

There is no CSS rule for it. A CM6 ViewPlugin (`listHangingIndent`) resets the line's style, THEN
measures where the text after the prefix begins (`coordsAtPos(line.from + prefix.length, 1)`), and
writes `text-indent: -k` with `padding-inline-start: k`. **A token could not produce `k`:** `- `,
`- [ ] ` and `1. ` measure **22 / 34 / 28 px** in Cairn's own font, and `--list-indent` is
Obsidian's `tab-size` — how wide a TAB inside the prefix is — a different quantity.

#### §0.31.2 — The predicate is the PREFIX, not the list

Obsidian's regex `/^([>\s]*)(([*+-] |(\d+)([.)] ))(?:\[(.)\] )?)?/` has an **optional marker
group** and a mandatory leading `[>\s]*`, so `> quoted` and a bare indent hang too. (Cairn's
`.nc-li` class was the wrong predicate; a test failing found it.)

#### §0.31.3 — `requestMeasure`, because §0.26 E62

CM6 forbids DOM writes from `update`, and a write that changes how a line **wraps** changes its
height — the precise hazard E62 records. `requestMeasure({read, write})` runs both halves inside
CM6's own measure cycle, so the heights CM6 records are the heights after the write. The reset
before measuring is load-bearing for a second reason: without it the second pass measures the first
pass's own indent and the line walks right on every update.

#### §0.31.6 — `.cm-line > * { text-indent: 0 }` is E75's mandatory companion (E76)

`text-indent` **inherits**. The negative value on the line reached the **anonymous flex item**
inside `.nc-bullet` (`display: inline-flex`) — a block container, which is what `text-indent`
applies to — and took its max-content width to `max(0, advance − k)`, collapsing the FIRST row of
every bullet. Obsidian has the fix at `app.css:3621` and it had been read and dismissed as
unrelated. **A negative `text-indent` on a line is not safe without it**; the two ship together, and
the engine test asserts BOTH (plus that the line still has its hanging indent), so the row cannot
pass by both being zero.

### §0.32 — The tree's bottom space is a ruling, not a transcription (E77)

The 72 / 216 / 144 / 108 sequence — three user rulings taken in the app, the last of which found the
ceiling — is **withdrawn**: §0.32.4. The lesson it was written for survives: a comfort margin is the
one kind of number this project cannot measure its way to, so it is answered by the person using the
app.

#### §0.32.4 — Obsidian's own 24, `[S]`, and the divergence is WITHDRAWN (E77)

`padding-bottom: 24px` `[S]` — §0.30 E72's transcription of `.nav-files-container
{ padding-bottom: max(var(--safe-area-inset-bottom), var(--size-4-6)) }` (`--size-4-6: 24px`) is the
shipped value once more.

**The policy, stated once:** pixel-identity is the default, not the tiebreaker. Where Obsidian's own
number makes the app worse to use, the user rules — and what this project owes in return is that the
divergence is marked `[C]`, carries Obsidian's transcribed value beside it, and is pinned by a test
that fails on a silent correction back to it. `tests/frontend/chrome-ui.test.mjs` pins the literal.

### §0.33 — The back arrow, and filename search (E78, E79)

**E78 — the search panel's back button glyph is `arrow-left`**, Obsidian's `app:go-back` glyph. It
wore `files` because Obsidian's registry maps `"file-explorer-glyph": "files"` — right about the
NAME, wrong about the PICTURE, which is two overlapping documents and reads as COPY. `files` is
deleted.

**E79 — filename search is a case-insensitive SUBSTRING match.** It was `nucleo-matcher`'s strict
subsequence, so `test` returned `feedback_clear_site_da*t*a_fr*es*h_boo*t*` as its first hit. Fuzzy
subsequence is Obsidian's QUICK SWITCHER; its SEARCH panel matches substrings, and Cairn has no
quick switcher — so the matcher was there by default, never by decision. Current rules:
`str::find` on a lowered haystack, with **ASCII-only lowercasing deliberately** —
`to_lowercase()` can change a string's LENGTH and invalidate every span after it; the cost is that
`STRASSE` does not match `straße`, and neither does Obsidian's search. Ranking is occurrence
**COUNT**, then tree order, and **every occurrence is highlighted**. `nucleo-matcher` (MPL-2.0)
leaves `Cargo.toml` with its THIRD-PARTY-NOTICES obligation, and ~50 lines of span post-processing
with it.

### §0.34 — One row of space above the tree (E80)

`.tree-scroller`'s `padding-top` is **12px** `[S]` — Obsidian's ribbon-to-first-row gap, measured
over its own DOM (nav-header bottom 8 + files container 4), replacing the withdrawn
`var(--row-h)` (27px) and `calc(var(--row-h) / 2)` (13.5px).

#### §0.34.1 — Why the top is not the bottom

`padding-bottom` was free: it adds scrollable space **after** all the content. `padding-top` is not.
**`scrollTop` is measured from the padding box**, so row `i` sits at `padTop + i·rowH` in SCROLL
coordinates while every row is still laid out at `i·rowH` inside `.sz`. Four places convert between
the two: `onScroll`'s window (`(st − padTop) / rowH`), `maxScroll()`
(`padTop + count·rowH − clientH`), and two `reserveRowHost` reveal comparisons
(`padTop + at·rowH`). `padTop` is cached in `measure()` — the one place `clientHeight` and `--row-h`
are already read, so `onScroll` still performs the single DOM read §5.12.6 requires — and it is
**read from the computed style, never hardcoded**. Without it `maxScroll()` is short by `padTop`, so
a `scroll_top` restored from `state.json` (§7.6) clamps one row above where it was saved.

#### §0.34.4 — The number is 12 because the element the other half lives on is gone

Obsidian carries the 12 as two declarations on two elements: `.nav-header { padding: var(--size-4-2) }`'s
bottom 8px and `.nav-files-container`'s opening `var(--size-4-1)` 4px. Box to box, the distance from
the nav-header's edge to the first row **is** 4 — and copying THAT would be wrong: the 8 is padding
INSIDE a nav-header Cairn does not draw (§0.12 E14 deleted the nav toolbar), so 4 would seat the
first row 8px above Obsidian's. **When the element the other half lived on is gone, transcribe the
SPACE, not the declaration.** It is a literal, not an expression on `--row-h`, because Obsidian's
gap is not a function of its row pitch either. Measured live: `12 + 1620 + 24 = 1656`, no blank
strip anywhere in the viewport at max scroll.

### §0.35 — A hard-wrapped continuation hangs under its own text (E81, E82)

**These lines are not soft wraps.** The source breaks them itself, so each continuation is its own
`.cm-line` with literal leading spaces, and §0.31 E75's hanging indent — which is about SOFT wraps —
never applied to them. That is why the same user reported indentation twice in two days about two
different mechanisms.

**E81 — the horizontal half.** Obsidian's chain is three parts: its stream mode tags the run; a
ViewPlugin splits it into a whole tab or four whole spaces (`.cm-indent`) and a partial leftover
(`.cm-indent-spacing`); and one CSS rule gives the LAST spacing group
`calc(var(--list-indent-editing) + var(--list-marker-space))` = **1em**, because
`--list-marker-space` is `0.25em` under `.is-live-preview`. Cairn emits the two group kinds as
`.nc-indent` / `.nc-indent-sp`; **the current three-condition predicate lives in §0.51** (E99
narrowed it: the 1em lands on the last group of the run, and only when that group is a spacing
group, on a continuation).

**A BLANK LINE ENDS THE ITEM.** Obsidian carries a stream-mode `listStack` down the document;
`listIndentAt` walks back instead, bounded at `LIST_LOOKBACK = 200` for the same reason
`PARA_LOOKBACK` is bounded — an unbounded walk makes a 50,000-line document quadratic on every
viewport change. A loose list whose second paragraph is indented gets the padding in Obsidian and not
here; **the conservative direction is the safe one.** (KNOWN-ISSUES LP-22: Obsidian draws an
indentation guide beside a nested bullet and Cairn draws none — that needs a ruling or a fix.)

#### §0.35.1 — …and the bottom half of `--list-spacing` (E82)

A continuation takes `--list-spacing` on its **BOTTOM only**. Obsidian's
`.HyperMD-list-line-nobullet { padding-top: initial }` gives the top back, because the item above has
already opened that gap and paying for it twice is visible. Cairn's `nc-li` carries the shared rule
and `nc-li-cont` overrides it at **(0,5,0)** — one class more specific than the rule it overrides, so
it wins by specificity and not by source order; tied at (0,4,0) the two would swap silently the next
time anyone reorders `editor.css`. The line box is **25.188 at dpr 1** — the literal moves with dpr
(§0.53 E103).

### §0.36 — Links render: a bare url and a `[[wikilink]]` (E83)

**Neither rule is in the CodeMirror mode Obsidian ships.** Its only autolink is `<https://…>`
(§0.39 E86); the bare-url and `[[wikilink]]` rules live in Obsidian's own
`defineMode("hypermd", …)` wrapper inside `app.js`. **"Read Obsidian" has a second step now: when
the transcribed file does not contain the rule, the wrapper does.**

**The wikilink.** The mode looks ahead with `/^(!?\[\[)(.*?)]]/` and records `hasAlias` when the inner
text contains `|`. Its decorator HIDES `[[target|` and underlines only the ALIAS —
`link-has-alias` and `link-alias-pipe` are in the hidden group, not the underlined one — so the open
marker Cairn hides is `[[` PLUS `target|`, which is not what a reader of the rendered output would
infer. `.*?` never crosses a line, so a wikilink must close on its own line, and `![[embed]]` is
excluded: it renders the embedded note, and hiding an embed's brackets to draw a link that is not an
embed would be worse than leaving the source visible.

**The bare url** is Obsidian's own 1.0 kB literal, transcribed character for character — `URL_RE` /
`EMAIL_RE` including the IANA scheme list — with its guards read across, so neither runs inside a
code span, inside a link's text or inside its destination. **It is tried at EVERY position, not at
word starts** — `xhttps://x.com/ab` IS a link, from the `h` — because CM5's fallback emits one
character per token. A **necessary** prefilter — the run of `[A-Za-z0-9.-]` must end in `:` or `/`,
or be `www…` — changes no answer and skips **89.5%** of the attempts (120,694 letter positions of
the reported vault, 1,340 matches, 0 misses).

**Two CSS rules, because Obsidian has two.** `.nc-ilink` takes `--link-color` + underline + a
pointer cursor; `.nc-url` takes `--link-external-color` + underline + `word-break: break-all` and
**NO pointer** — Obsidian does not put `.cm-underline` on a bare url and its own click handler
refuses a plain click on one, so a pointer would promise a behaviour neither app has. The
`break-all` is the visible half of the report: Obsidian breaks a long url mid-token at the wrap
where Cairn pushed the whole thing down.

**Every wikilink renders RESOLVED** (KNOWN-ISSUES LP-7): Obsidian dims a link whose target does not
exist (`is-unresolved`), and that state, not the rendering, is what the metadata cache was ever
needed for.

### §0.37 — The editor's scrollbar gutter is 12px, not 8 (E84)

**Two panes, two tokens.** `--scrollbar-w-editor` is **12px** — Obsidian's `--scrollbar-width` —
and `--scrollbar-gutter-w` stays **8px** for the sidebar, because 8px plus the pane's own 3px right
padding lands the same seven columns of thumb ink Obsidian's 12px track does (402..408 in both).
Both panes reserve the track unconditionally (`scrollbar-gutter: stable`), so the editor's 12px comes
out of `.cm-content` — and therefore out of the column every line wraps in. `K.lineW` 1436 →
**1432** = 1508 − 12 − 2 × 32; `K.edGutterL` 1912 → **1908**; `edGutterW: 12` beside `gutterW: 8`.
**G9 could not have caught this** — its gutter row compares Cairn's computed width to Cairn's own
constant — and the row with teeth is the `line box` literal.

**Ink is not the box, for the fourth time:** the visible thumb is 7px in both (a 12px track less a
`3px 3px 3px 2px` transparent border; an 8px track less a 1px one), which is why the 8 was tagged
`[M]` and nobody saw the difference until a url wrapped one unit early.

**ON macOS THIS IS UNSETTLED — KNOWN-ISSUES UI-10.** `styled-scrollbars` is added on every platform
BUT macOS, so the 12px track is not Obsidian's there: measured on macOS at dpr 1 the line box was
1432 in Cairn against 1444 in Obsidian, and Obsidian's own macOS gutter moved between runs. E84's 12 is not changed here. On macOS the editor thumb colour is native (`#808080` /
`#595a5b`); Linux keeps the translucent pair.

### §0.38 — A clicked link goes somewhere (E85)

**The policy is Obsidian's `onEditorClick`, transcribed.** **`click`, NOT `mousedown`** — because the
branch after it returns when the window's selection is non-collapsed inside the target, so **a drag
that selects the text of a link does not then navigate on release**; a mousedown handler cannot tell
those two apart at all. A plain left click navigates unless alt or shift is held; Mod-click always.
**And a plain click on a BARE url is refused in Obsidian too** — its handler requires
`.cm-underline` for an external link and a bare url never gets one, the same fact that decides its
cursor (§0.36).

**The seam: pixels decide WHETHER, the document decides WHERE.** `linkTargetAt(state, pos)` takes a
STATE, not a view. The DOM answers one question — did the pointer land on a `.nc-url`, `.nc-ilink` or
`.nc-link` — and everything else is read from the document: the scheme defaulting (`x.com/ab` →
`https://`, an email → `mailto:`, by the scanner's own `EMAIL_RE`), the alias (`[[some/where|an
alias]]` goes to `some/where`, not to the alias), and the `#subpath` (parsed then ignored — there is
no heading index, so the note opens at the top; parsing it is what stops `[[Note#Heading]]` looking
for a file called `Note#Heading`). All of it is unit-tested with no DOM.

**Resolution lives on the blob, and the order is TOTAL.** `TreeBlob.resolveLink(target, fromPath)`:
a target containing `/` must match a path **exactly** — Obsidian falls back to the basename here, and
falling back means opening a file the user did not name; otherwise the note in the reader's own
folder wins; then the shallowest; then lexicographic. **One pass over BYTES** — it compares the
target's last segment against `names` directly, so one click on a 50,000-node vault decodes only the
hits (`nameCacheSize === 1` on a hit, 0 on a miss) and never evicts the row cache the virtualiser is
using. Case-insensitive in ASCII only, §0.33 E79's rule and reason.

**An unresolved wikilink does nothing**, where Obsidian creates the note — it is a write to the
vault from one click, and every wikilink renders resolved, so the click that would create a file
looks exactly like the click that opens one. **A write nobody can see coming is worse than a click
that does nothing.** KNOWN-ISSUES LP-8.

#### §0.38.3 — Command 22, and an allowlist that is Cairn's own

**§1.3 gains `open_external(url)`, shell-implemented** — `shell.openExternal` is Electron's and the
core has no business launching a browser. **The scheme allowlist is `http:`, `https:`, `mailto:`,
enforced in the MAIN process and marked `[C]`:** Obsidian normalises the url and does not restrict
the scheme there, and the string comes out of somebody's markdown. `file:`, `javascript:` and every
registered custom scheme are launchable through `shell.openExternal`; widening the list is a ruling,
not a patch. Anything else answers §1.5 `invalidPath` and lands in `reportError`.

**And the engine test launches nothing.** Its mod-click goes at an **`ftp://`** url, so the whole
path runs — handler, `linkTargetAt`, command 22, the allowlist — and the allowlist REFUSES it. An
`http:` fixture would have tested the same code and opened a browser on whoever ran it.

### §0.39 — `<https://…>` is an autolink (E86)

**This one IS in the CodeMirror mode Obsidian ships** — it is the only autolink
`lib/codemirror/markdown.js` has, and §0.36 E83 read past it while looking for a bare-url rule that
is not in that file. `linkInline` tags the `<` and the `>` `formatting-link` (hidden) and the inside
`link` (underlined) — which is exactly the treatment `[text](url)`'s TEXT gets, so Cairn reuses that
decoration instead of inventing a class. **The scheme set is `(https?|ftps?)` and NOT E83's 1.0 kB
IANA list** — an angle autolink is the narrower construct, and `<magnet:?xt=…>` is not one. It is
scanned BEFORE the bare-url branch, and it has to be: that branch starts at a letter, so it would
otherwise linkify the inside of the angles and leave them on screen.

### §0.40 — A markdown table renders as a table (E87)

**It needed neither of the two things it was said to need.** The parser is `livepreview.ts` §3's own
inline tokeniser through a new `inlineIn(text, sink)` — a cell is inline markdown and nothing else,
so `` `apps/client` `` is inline code in a cell by the same code as in a paragraph. The renderer is
`<table>`. What it actually needed was a **block widget**, and §5.4.5 had already built one.

**Obsidian's opening rule is stricter than GFM's.** Its mode carries
`if (!K && o.prevLine && o.prevLine.stream.string.trim() && !o.wasHeading) J = false`, so **a table
must follow a blank line, a heading, or the top of the note** — GFM opens one straight after a
paragraph line. **And the column counts are NOT checked**: `| A | B |` over `|---|` is a table there,
where GFM refuses the mismatch. Both were asserted the GFM way in this file's first test and the
transcription disagreed; the transcription ships.

**A `StateField`, an incremental index, and a bound.** CM6 refuses a plugin-supplied replacement
spanning a line break, so the decorations come from a field; a field cannot be viewport-bounded, so
the cost comes out of the CHANGE in `blockIndex`'s own shape: rescan the changed neighbourhood, map
the rest. **A table cannot cross a blank line** — every line must match the row pattern and a blank
one does not — so expanding the rescan to the nearest blank line on each side is exact rather than
approximate, and `NEIGHBOURHOOD = 200` bounds it. The test asserts the incremental index equals a
full rescan after an edit inside a table, after an edit that destroys one, and after an edit far
away.

**The reveal is §5.4.1's at block scale**: a table whose range the selection touches shows its
markdown, which is what makes a read-only widget editable. **An unfocused editor reveals nothing**
(§0.23 E48), pushed into the field through CM6's `focusChangeEffect` — without it the caret sits at
position 0 in a freshly opened note and a table on its FIRST line shows markdown the moment the note
appears.

**The widget wears `.nc-block`** (`display: flow-root`), never `.cm-line`: a first draft that classed
it `cm-line` tripped §0.26 E62's hit test immediately, because a `<td>`'s text is not the document's
text. Its `margin-block` is the same `--p-spacing` token as §0.30 E73's heading padding, declared
under Obsidian's own name with `--heading-space-before` pointing at it.

**The style is measured, not resolved by eye** — a `<table>` rendered under Obsidian's own sheet in
the pinned engine: `border-collapse: collapse`, line-height 20.8, `margin: 16px 0`, cells `4px 8px` +
`1px solid rgb(51,51,51)`, `min-width: 6ch`, `vertical-align: top`, `white-space: break-spaces`,
`text-align: start`, `overflow: hidden`, header weight 600. The engine test asserts the border
THROUGH Chromium's snapping rather than against it — 1px lays out as `floor(dpr)/dpr` = 0.8 at dpr
1.25 — and `6ch` with a tolerance, because it is font-relative.

**Cairn's table is read-only** and reveals its source where Obsidian's cells are nested editors.
KNOWN-ISSUES LP-9.

### §0.41 — The Properties gap is identical, and there is a live Obsidian to prove it

**NOT A DEFECT, and the numbers are here so it is not re-chased.** Measured on the LIVE Obsidian
1.13.7, maximized, against Cairn at the same emulated viewport: `.metadata-container`
`margin-bottom` **32px in both**, container bottom → first body line **56.0 in both**, Add-property
box bottom → first line **64.9 in both**, its label's text box → first line **71.5 in both**. Both
render the blank line after the closing `---` for the same reason: Obsidian's decoration ends at the
END of the closing `---` line, which is exactly what `properties.ts` computes independently.

#### §0.41.1 — Compare at identical SETTINGS (the ruling of this pass)

The first pass measured a one-device-pixel difference and blamed sub-pixel phase. **The cause was
the INSTRUMENT: a fresh Obsidian profile is Obsidian's DEFAULTS** — `readableLineLength: true` and a
300px sidebar — which capped its content column at 700px against Cairn's 1064, wrapped one value onto
extra lines, and moved everything below it 21px. With the vault's own `app.json` copied in and the
sidebar set to 412 on both sides at 2048×1070, every number is identical: content width **1560**,
description height **50**, add-button bottom **309.2**, gap **64.9**, device phase **0.5**.
**§0.26.4's rule gains a second half: compare at identical SETTINGS, not just an identical
`sidebar_w`.** A default profile is not a neutral reference; it is a different configuration, and it
produces a difference that looks exactly like a defect.

`tools/obsidian-live.mjs` is the instrument. It starts the live Obsidian on an ISOLATED profile (a
fresh `--user-data-dir` is a different single-instance lock, so the user's own Obsidian is not
touched), copies the newest `obsidian-*.asar` out of `~/.config/obsidian` first (without it,
`/opt`'s binary answers as **1.12.7**), maximizes before measuring, takes `--config-from VAULT` /
`--sidebar N` (without them it answers for an Obsidian nobody is running), and waits for the
instance to die. It is Debian-only now: Obsidian is no longer installed on the Mac.

### §0.42 — `text-rendering: optimizeLegibility` was never transcribed

`body { text-rendering: optimizeLegibility }` (app.css) is in every Obsidian build this project has
read and was absent from Cairn. **It is inert on this machine** — a full-frame diff of 3,425,280
pixels with the declaration toggled live on the running `body` shows 0 differing — and it is still
transcribed on its own merits: `optimizeLegibility` turns on kerning and standard ligatures, a font
carrying either renders different ADVANCE WIDTHS, and that moves where every line wraps. The stack
resolves per machine, so "no difference" is a fact about this box's fontconfig, not about the
declaration.

**Two measurement traps from this pass.** (1) **Check the user's own state files before choosing a
test geometry:** every measurement before it used sidebar 412, Cairn's `[M]` default, while both apps
on this machine persist **200** — and with `readableLineLength: false` the pane width IS the wrap
column, so 212px of sidebar changes every wrap in the note. (2) **CM6 reports ESTIMATED block
heights until it has measured them:** a height read from a document CM6 has not finished measuring
is not a measurement, and any conclusion from one is worth exactly nothing.

### §0.43 — Scroll past the end, and it is HALF the editor (E88)

> The user, after four passes of being told the region was identical: *"FIRST, YOU MUST ADMIT THAT
> THERE'S A MISMATCH BETWEEN TWO APPS."* There was one: `.cm-line` measured 24 in Obsidian and
> 24.8 in Cairn in the user's own windows. **The 0.8px is real, was NOT FOUND here, and was closed
> later by §0.50 E98** — a Chromium font-strike race triggered by an SVG loaded as a CSS image.

#### §0.43.1 — `.cm-content` has a bottom padding, and Cairn had none (E88)

Obsidian's `.cm-content` carries an INLINE `padding-bottom` of **exactly half the scroller's
height**, recomputed as the editor resizes (`style="tab-size: 4; padding-bottom: 515px"` at a 1030.4
scroller). Cairn had none, so a note stopped dead at its last line where Obsidian lets you pull that
line to the middle of the screen. **It was also most of a 778px mystery** — Cairn's document measured
778px shorter for the same note and three passes went looking for missing content; there is none
(`4292.7 − 515 = 3777.7` against Cairn's 3771.9).

The plugin's SHAPE is `@codemirror/view`'s own `scrollPastEnd()` — a `ViewPlugin` whose value
provides `contentAttributes`, so the padding is an attribute CM6 owns rather than a DOM write — and
the NUMBER is Obsidian's. spec-03 §8.2's static `padding: … 30vh` stays STRUCK: that was a percentage
of the VIEWPORT in a stylesheet; this is half the SCROLLER, maintained by the editor.

### §0.44 — The first-run prompt is deleted (E89), and the fold is Obsidian's (E90)

#### §0.44.1 — §7.5's `Open folder as vault…` panel is STRUCK (E89)

`.first-run`, `#first-run-open`, `setFirstRun()` and the `.first-run` CSS block are all deleted, and
**§7.5's normative sentence is void**: `{state:'none'}` renders the shell and nothing else
(`bar.setVault(null)`, so the button reads `Open a vault`).

**M65's reason expired rather than being overruled.** It was that a fresh install would wait forever
behind an empty pane *with no prompt* — and the vault bar is drawn in every state, its
`.vault-switch` opens the recents popover in every state, and that popover's last row is the same
`Open folder as vault…` wired to the same `pickAndSwitch()` (§0.27 E67). The route is singular, not
lost. `ChromeDeps.pickVault` keeps its other caller, §7.3 case 8's `[ Switch vault… ]`.

**A normal launch reopens the last vault `state.json` recorded**, through the addon's
`startupOpen()` — not a §1.3 command.

#### §0.44.2 — The fold is Obsidian's, rebuilt on a virtualised list (E90)

Measured frame by frame in the live 1.13.7, not derived: the arrow is `transform 100ms ease-in-out`
and the band is 100ms on `cubic-bezier(.02, .01, .47, 1)` under `overflow-y: clip`; expand appends
then animates, collapse animates then detaches. **THE FINDING THAT DECIDED THE IMPLEMENTATION: THE
CHILDREN DO NOT MOVE.** Through the whole 100ms the first child's viewport top held at **113.10** and
the second's at **140.00**, while the row below the folder travelled **113.00 → 166.90** — the band
is static at its final positions and is revealed by a GROWING CLIP, and everything after it is
lifted by whatever part of the band is still closed.

**Obsidian's mechanism does not transfer, and that is the whole of the work.** It animates the
`height` of a real `.nav-folder-children`; Cairn's rows are absolutely positioned inside `.sz` at a
fixed pitch and there is no element whose height IS the band. So the fold is driven from rAF over
**one number** — `anim.shift` — which `yOf()`, `sizeSizer()` and `paint()`'s `clip-path` all read,
with no second source of truth about where a row is mid-fold. Obsidian's curve is evaluated in JS
rather than swapped for `ease-in-out`: at 100ms the two differ by **21% of the band's height** at
the midpoint. The duration and curve are the values `properties.ts` already ports (§0.24.5 E53) and
are deliberately NOT shared across §6.4's owner seam.

**The arrow is the half a transcription gets wrong, because the rows are pooled.** A flat
`transition: transform 100ms` would also animate a slot that merely changed WHICH NODE IT DRAWS — a
fast scroll through mixed folders would spin arrows all over the sidebar. The duration is therefore
`var(--chev-ms, 0ms)`, `0ms` everywhere but the one row `tree.ts` arms for ~100ms. The chevron is an
inline `<svg>` (§0.50 E98), so the custom property reaches it by inheritance, and the transition is
`!important` because `base.css:51` is §5.1 rule 5's blanket — **the third exemption to rule 5 and
the first outside the Properties block.** Cairn's glyph rotates **+90°** where Obsidian's rotates
−90°, because the two base glyphs point different ways; do not "fix" the sign to match the
declaration.

`animate` **defaults false** on `setOpen`, so every pre-existing caller keeps the instant path (a
`reserveRowHost()` open must not delay the field the user is about to type into), and a fold is
**refused** while an inline editor is open.

**The test is in the engine, because nothing below one could have failed.** The DOM shim has no
`requestAnimationFrame`, so `canAnimate` is false there by construction — all **63** `tree.test.mjs`
tests stayed green when this landed and not one could have caught a broken fold.
`electron-shell/fold.test.mjs` (5 tests) asserts in a real engine, and each claim is mutation-tested:
killing the animation fails all five; a global chevron transition fails ONLY the pooling guard;
shifting the band's rows fails ONLY the children-hold-position test.

### §0.45 — The empty pane is empty (E91), the caret with it (E92), and CM6 was winning the cascade (E93)

**E91 — §7.4's `.empty-state` is STRUCK.** The element, its CSS block, and `tabstrip.ts`'s toggling
of it are deleted. **With no note open the pane is EMPTY**, which is what Obsidian shows — it has no
editor in that state at all, so it has neither a placeholder line nor a caret. spec-03 §7.2's
rejection of the CM6 `placeholder` extension is unaffected: nothing replaces this, a placeholder
least of all. `setNote(null)` survives because it hides the TAB, which is §7.4's own row.

**E92 — `readOnly` does not remove a caret; `editable` does.** `reconfigureEditable()` has three
states:

| | |
|---|---|
| `open === null` | **not an editable surface at all** — `EditorView.editable.of(false)` |
| detached / vault-lost | read-only, but still a document — `EditorState.readOnly.of(true)` |
| otherwise | editable |

**`EditorState.readOnly` is a transaction filter.** It stops changes from being applied and changes
nothing about the DOM, so `.cm-content` kept `contenteditable="true"` and Chromium kept blinking a
caret in an empty pane — inviting the user to type into a document that does not exist. **No CSS was
needed, because Cairn draws no cursor of its own:** there is no `drawSelection`, so the caret is the
browser's native one and `caret-color` merely colours it. **The two read-only states deliberately
keep their carets** — §7.3 case 5's `Save as…` needs the text selectable, and making those
non-editable would take the selection away with the caret. Empty is the only state with nothing to
lose.

**E93 — the caret was WHITE since CM6 was mounted, against an `[M]` token.** `editor.css` declared
`caret-color: var(--caret-color)` at **(0,1,0)**; CM6's base theme ships
`"&dark .cm-content": { caretColor: "white" }` → `.cm-editor.cm-dark .cm-content` at **(0,3,0)**, and
ordering cannot rescue it because StyleModule injects at the TOP of `<head>`. Measured live:
`--caret-color` resolved to `#dadada` on that very element while `caret-color` computed
**`rgb(255, 255, 255)`**. Out-specified with the real element chain it computes `#dadada`,
`--text-normal` — the value Obsidian declares at `.cm-content`. **It is §0.24.5 E53's shape for the
fourth time: a rule that is correct, present and OUTRANKED fails in total silence**, so the test
asserts on `getComputedStyle`, never on the source. `electron-shell/empty-pane.test.mjs` (4 tests)
covers all three, and the pair also pins that a note open is editable again — taking the caret away
permanently would make the app unusable while every existing editor test still passed.

### §0.46 — The `totp` block (E94)

**§0.17's method does not apply here, and that is the first thing to say.** Obsidian ships nothing
like this; the reference is the USER'S OWN plugin (`~/totp-obsidian-getter`, 140 lines, read
directly), and the user released the identity requirement. So the divergences below are **design**,
each recorded with its reason — the opposite of how every other UI ruling in this document works.

**What is transcribed exactly, because it is a wire format.** RFC 6238, pinned against **RFC 6238
Appendix B's published vectors** rather than against Cairn's output — a TOTP implementation that is
self-consistent and wrong is indistinguishable from a correct one until it locks somebody out. All
six SHA-1 vectors pass. **The BLOCK GRAMMAR is transcribed too, and that was not optional:** a live
credentials note holds nine of these fences, and a parser that disagreed with the plugin would
silently stop producing codes for a real account. The plugin's own shape — one `# Label`, one seed —
is the suite's first grammar assertion. (One `# comment: …` line per row is a later user feature,
rendered beside the label.)

**The four divergences.** (1) **Many entries per block** — asked for; `# Label` opens an entry where
the plugin joins every label with `" / "` and concatenates every token into one seed. (2) **The seed
is never rendered**: the widget REPLACES the fence, so the base32 seed leaves the screen where a
plain note shows it in the clear. (3) **`otpauth://` URIs**, with their own digits/period/algorithm —
the plugin hardcodes 6/30/SHA-1 and silently produces WRONG CODES for an 8-digit or SHA-256 issuer.
(4) **`+ Add TOTP secret`**, which REFUSES an unusable seed instead of writing it. **And one plugin
behaviour kept verbatim:** failure is per-entry and VISIBLE — a bad seed renders a row with the
reason in it; it does not throw, blank the block, or take the other eight accounts down.

**Two things were measured before they were assumed, and both decided the architecture.**
**`crypto.subtle` IS available** — `file://` is a secure context in Chromium (`isSecureContext ===
true`) and HMAC-SHA-1 returns its 20 bytes — so there is **no hand-rolled SHA-1 and no new Rust
dependency**. And **`navigator.clipboard.writeText` FAILS** with *"Document is not focused"* — every
windowed run this repo takes is of an unfocused window (§0.23 E48) — and for a credential a copy
that silently fails is the worst outcome there is: the user pastes whatever was in the clipboard
before. **§1.3 gains command 23, `copy_text`**, shell-implemented through Electron's main-process
`clipboard`, which has no focus requirement. **No allowlist**, unlike command 22, and the asymmetry
is deliberate: `open_external` hands a string to `xdg-open` and can launch anything; this hands it to
nothing. A 4,096-character cap is a sanity bound on an unbounded main-process write, marked as such.

**The reveal is also the edit path.** The block reuses `blockIndex` (already incremental) and
`tables.ts`'s exported `editorFocused` rather than adding a second fence scanner or a second
`focusChangeEffect`. Put the caret in the block and the source appears — which is how a seed is
edited or deleted — and an unfocused editor reveals nothing (§0.23 E48).

#### §0.46.6 — No code and no countdown on screen (user ruling)

The first version shipped a live code with a one-second countdown. The user overruled it: *"No. I
don't want code or countdown, really. Please remove it!"* **The plugin's posture is restored — a row
is a label and a click — and the deletions are the design, not tidying:** the shared 1 Hz ticker,
every cached code, `groupCode` (`482915` → `482 915`), `secondsLeft`, and the `is-expiring` state
and its three CSS rules. The two model helpers were DELETED rather than left exported-and-tested,
and their tests now assert they are `undefined`, so a readout cannot creep back in by way of a
helper. **The code is generated AT CLICK TIME** — the freshest the app can hand over — and the expiry
risk the countdown warned about is narrowed to the paste itself and **ACCEPTED by ruling**, not
re-argued.

**The row IS the copy control; there is no `Copy` button.** Clicking a healthy row generates a fresh
code and copies it, and a transient `Copied` pill confirms inside the row; a failed copy shows the
word in the row AND reports through the app's own error path, because a credential that did not copy
must not fail quietly. **The assertion is on RENDERED TEXT** — a unit test cannot express "not on
screen" — and it is mutation-tested by putting a code back. `cairn-type: secrets` notes reuse this
same code path.

### §0.47 — `JS_MAX` is RETIRED (E95)

`electron-shell/build-app.mjs` reads `JS_MAX = Infinity`; the `js=` byte count is still printed on
the build line and **nothing fails the build**. The gate was an RSS gate wearing a byte count,
derived from **G5a's headroom** — and G5a was retired, which is the same reason the CSS
gate fell (§0.19 E26). The measured ~15 bytes of `phys_footprint` per byte of minified JS is a
**measurement and stands**; optimisation is deferred, not abandoned. **DO NOT RESTORE 374,000** — it
was a function of a requirement that no longer exists, and a future gate is re-derived against a
live one.

### §0.48 — The tree box model, and the indent guides (E96)

**A gradient stop is not a border.** Obsidian's guide is a real `border-inline-start: 1px` and
Chromium snaps a USED border to `floor(dpr)/dpr` (0.8 at dpr 1.25), so its guides land on whole
device columns at every depth. Cairn's row is ONE pooled element and cannot carry N borders, so its
guides are `repeating-linear-gradient` stops, which are rasterised by coverage and never snapped — a
flat 1px stripe is 1.25 device px and painted TWO columns wherever it began on a fractional one.
Fixed with **`--hairline`** (renamed by §0.49 from `--guide-w`), written by `chrome.ts` as
`floor(dpr)/dpr` and declared `1px` in `tokens.css` as a fallback that is right at dpr 1 and 2.

**The extra line.** `background-size` was `calc(var(--d) * var(--row-indent))`, which ended the box
exactly where the next stripe starts, and the rasteriser painted that boundary column at partial
coverage. It is now `max(0px, calc((var(--d) − 0.5) * var(--row-indent)))`. **The half is not
arbitrary:** any edge strictly between stripes removes the bleed, and the half is the one that needs
no reference to `--hairline` and therefore none to dpr. The first draft used
`(d − 1) * step + --hairline` and **G9 rejected it at once** (`expect 17 got 0.8`), because
`verify-geometry.js`'s header requires that nothing in it touches `devicePixelRatio`.

**The finding underneath: the WHOLE tree box model was 1px left.** Four independent measurements
against the live Obsidian 1.13.7: its guides at device 30/51/72 against Cairn's 29/50/71; its chevron
ink from 24 against 23; its text ink 67/88/108 against 66/87/108; and `.tree-item-inner` at exactly
**36.000** at depth 0 against `--tx0: 35`. **The cause was a "− 1px frame" correction this project had
already struck:** the reference PNG has no frame — its edge is a wash over content, the same finding
that took the window to 1920 × 964 (§0.22 E41) — and the tree box model was never re-derived after
it. **`--cx0` 15 → 16, `--tx0` 35 → 36, `--gx0` 23 → 24**; `--gut` is unmoved at 4, because all three
of its terms shifted together. **A measurement of the LIVE APP beats a derivation from the reference
PNG**, taken as a user ruling because it moved three `[M]` tokens and nine G9 constants.

### §0.49 — The indent step carries a snapped border (E97)

Obsidian's step is **three terms — `margin 12 + border 1 + padding 4`** — and its design value is 17
while its RENDERED step is 16.8 at dpr 1.25, because only the border term snaps. **Cairn has no
border in its chain to do that snapping for it** — the whole indent is one `padding-left` — so the
step now spells the terms out: **`--row-indent: calc(16px + var(--hairline))`**, which is 17 at
dpr 1 and 2 and 16.8 at 1.25, i.e. Obsidian's rendered step at every scale. Guides and text ink are
now identical to Obsidian at every depth (guides 30 / 30,51 / 30,51,72; first text ink
67 / 88 / 108). Depth 3's ink was 109 against Obsidian's 108 before.

**The gate had to learn the hairline, and then had to be given a row that can fail.** `verify()`
re-seats `K.hairline` and `K.step` from the page's own `--hairline` before `buildTable()` — a CSS-px
read of a custom property, exactly like every other read in that file, with **nothing consulting
`devicePixelRatio`**. A row ties `--hairline` to the USED `border-bottom-width` of `.titlebar` — a
real 1px border in the same document, snapped by Chromium itself — because comparing it to a
constant would only compare Cairn to Cairn (§0.37 E84's trap).

**And a mutation test then showed the gate still could not fail.** Reverting `--row-indent` to a flat
`17px` passed **all 134 checks**: the loose device-grid tolerance at dpr 1.25 is 0.82 CSS px and the
quantity in dispute is 0.2 per level, so no MAGNITUDE row can separate 17 from 16.8 at any depth the
gate probes. **That blindness predates this pass** — but leaving it would have been a gate that looks
green for the wrong reason. Fixed with a BOOLEAN row, which takes no numeric tolerance:
`step == 16 + a snapped border`. Re-mutated: the flat `17px` now fails **exactly that row**.
**G9 135/135.**

### §0.50 — LP-10 closed: the 0.8px line was a font-strike race (E98)

The line measured **24.8px in Cairn on the user's screen and 24.0 in every instance the project could
launch**, and the gap between them was the measurement protocol: every launch in the handoff was
settled with a two-pass scroll before anything was read, and a scroll makes CodeMirror re-create
every line's DOM, re-laying the text out with whatever strikes are cached — so the evidence was
destroyed before it was read. Read WITHOUT the scroll, **12 of 21 fresh launches** rendered 24.8 and
the live Obsidian on the same box rendered 24.0 in 5 of 5.

**The cause is a Chromium/Linux race.** An SVG reached through `url(data:image/svg+xml…)` is rendered
in an isolated `SVGImage` page whose `LayoutRoot` writes scale **1.0** into Blink's process-wide
font-strike scale (`FontCache::DeviceScaleFactor`), and a text strike populated OUTSIDE layout — at
STYLE time, which is what a `ch` unit forces, since `min-width: 6ch` needs the font's zero advance —
then sees the stale value. Its ascent splits 19/5 instead of 20/4, the baseline sits one device pixel
lower, and one line is 31 device px = **24.8 CSS px**. The tree chevron's `--chev` mask was such an
image, painted when the tree first renders; the note's `th` cells (weight 600) populate the bold body
strike at style time, so whether a main-document layout happened to run between the two was the coin
flip. After the fix: **20 of 20 launches at 24.0**.

**The chevron is an inline `<svg class="chev">` child of every pooled row** — Obsidian's own
construction — and `--chev` is gone from `tokens.css` (§5.1 X2, "the chevron is a token, not an
icon", is struck). **`tests/frontend/no-svg-images.test.mjs` refuses any `url(data:image/svg+xml…)`**
in any sheet or the built page, matched per `url()`, with the sheet list taken from
`build-app.mjs`'s `CSS_ORDER` plus its `@import`s.

**The task tick stays Obsidian's SVG-image mask, deliberately.** Chromium snaps a CSS image's
destination rectangle to device pixels before drawing it, so the tick both apps render is a snapped
raster; an exact vector clip-path differed from it by 143 channels. Pixel identity wins over a narrow
hazard: the poison needs a checked task's FIRST paint to be followed by a style-time population
before any layout, and with the chevron gone nothing paints an SVG image before the note. It is
KNOWN-ISSUES LP-11, with both candidate fixes.

**The trap, named:** a settle scroll is not neutral — it re-creates the very DOM whose first
population is the evidence — and a fresh-strike probe cannot see a transient static, because
populating a strike takes a layout and the layout rewrites the static first. Only a style-time
population (`ch`) observes it.

### §0.51 — A nested list item is not a continuation (E99)

**The report was measured in the currency it arrived in.** The user's two crops share no stated
origin, so the unindented rows were cross-correlated first — **0.204 device px apart**, i.e. aligned
— and the nested rows then came back **19.999 device px** apart at dpr 1.25, which is **16.000 CSS px
exactly**. **The bullet DOT said 21, and the dot was the wrong instrument:** a `border-radius: 50%`
disc is a BOX, and Chromium snaps a painted box to whole device pixels, so two dots 20.0 apart whose
origins straddle a boundary land 21 apart while the glyphs beside them, positioned at subpixel, do
not. Hundreds of columns of glyph ink beat six columns of a snapped disc; the DOM then agreed with
the glyphs to three decimals.

**The cause is one predicate, and it produced both symptoms.** `listIndentLength` asked *is this line
indented, and is there an open list item above it* — which a nested ITEM answers yes to exactly as a
hard-wrapped continuation does. So every nested bullet took both `.nc-li-indent`'s **1em** (§0.35
E81 — the 16.000 the user saw) AND `.nc-li-cont`'s **`padding-top: 0`** (§0.35.1 E82), leaving its
line box **25.2 against Obsidian's 26.4**. **Only the first was reported**; a fix aimed at the 16px
alone would have left the second. `listIndentAt` now returns `{ n, cont }`, and `cont` is false
whenever the line carries its own marker — Obsidian tags such a line `HyperMD-list-line-2` and never
`-nobullet`.

**A third defect nobody had reported, found by reading the live DOM.** Obsidian splits the leading
run into two kinds of group (`indentGroups`, transcribed from `Bq.getDeco` in `app.js`): a
**`.nc-indent`** — a whole tab or four whole spaces — is `min-width: var(--list-indent)` = **36px**,
and a **`.nc-indent-sp`** (the leftover run of fewer than four spaces) takes its natural advance.
**A level of indent is a level wide whatever the file spelled it with**, and Cairn had neither the
token nor the quantisation: a tab-indented nested bullet measured **30.087** against Obsidian's
**36.000**. **§0.35 E81's deferral is withdrawn** — the split carries a `min-width`, which is
geometry and not a guide — and its 1em is now **three conditions instead of one**: the last group, a
spacing group, on a continuation. A two-space continuation takes it (7.05 + 16 = 23.05) and a
FOUR-space one does not (36.000, `padding-inline-start: 0`).

**One departure from Obsidian's DOM, taken on a measurement.** Obsidian's loop drops the tab that ENDS
a partial group — and that survives there only because the bare tab is inside an `inline-block`
wrapper that re-origins its tab stop at the start of the run. Cairn emits no wrapper, so a bare tab
would take its stop from the LINE, whose origin §0.31 E75's hanging indent has moved: **46.05 against
Obsidian's 59.05**. Cairn keeps the tab inside the group it ended, which re-origins the stop where
the wrapper does — **59.05 exactly**. A doubly-mixed run differs by 0.05px (KNOWN-ISSUES LP-12).
`.nc-li` also gains Obsidian's `tab-size: var(--list-indent)`; its computed value reads back as
`45px` at dpr 1.25 while the used value is 36, because Chromium reports `tab-size` in device pixels.

**The test is `electron-shell/indent.test.mjs`**, a new file with its OWN fixture — because
`live-preview.test.mjs`'s note carries §0.26 E62's hit-test row at ZERO tolerance. Widths are
asserted EXACT (two are a font's space advance, two are a token); a tolerance would admit the 16.000
that was reported. Each mutation is tested against the mutation it exists for: the old predicate
fails all three engine tests and five unit rows; dropping `min-width: var(--list-indent)` fails ONLY
the widths test — and it is the `minW` token row that catches it, because a tab's own stop at
`tab-size: 36` happens to land on 36 too; letting the terminating tab escape its group fails ONLY the
mixed-run row. Since §0.53 E103 the expectations are DERIVED, not Debian literals. **G9 135/135** —
an indent is inside the editor's content box and moves no gated edge.

### §0.52 — The editor pane is a paint containment box (E100)

**It was one pixel, and the text beside it was not.** Cross-correlated against Obsidian's crop: the
ordered row −0.207, the four bullet rows' TEXT −0.199 / −0.203 / −0.199 / −0.193 — aligned — and the
four rows' DOT **−1.000, exactly, on every one.** An integer translation is not a measurement error.
**And the layout was already identical**, so it was never going to be a CSS-value fix: the dot's box
was **23.5562** rel `.cm-content` in Obsidian and **23.5563** in Cairn, both 4.8 wide. Three
hypotheses were tested and killed rather than argued: the containing block's origin (moved Cairn's
onto Obsidian's with `padding`→`margin` — no change), the four `::after` declarations Obsidian has
and Cairn lacked, and **the ENGINE — which is the one worth ruling out loudly: `Chrome/142.0.7444.265
/ Electron 39.8.3` in BOTH** on Debian.

**The cause is an ancestor Cairn did not have: `main.editor` carries `contain: paint`.** Obsidian's
`.workspace-leaf` is `contain: strict`, which makes the pane its own paint origin, and **Chromium
SNAPS that origin** — the pane's left edge is the sidebar's width, which at dpr 1.25 is almost never
whole (221 CSS px = **276.25** device). So Obsidian's subtree paints 0.25 device px left of where an
uncontained one puts it, and a box Chromium snaps — a `border-radius: 50%` disc — rounds the other
way. **The 0.25 is also the text's 0.20**, which is how the mechanism was confirmed instead of
assumed: after the fix the text rows measure **−0.002 / −0.003 / +0.001 / +0.004** — the two editors
are on the same device grid now, not merely close. **The bullet was the messenger, not the subject.**

**`paint`, not Obsidian's `strict`, and that is a divergence with a reason.** `strict` is
`size layout style paint`; size containment is layout-neutral here only because `.editor`'s
`flex: 1 1 auto` is paired with `flex-grow: 1`, and a containment that could collapse the editor to
nothing if somebody edited that shorthand is not worth taking for a rasterisation origin; `paint` is
measured to be the whole of the effect. One `position: fixed` descendant is newly clipped — CM6's
`.cm-announced`, the screen-reader live region parked off-screen — and the accessibility tree is
unchanged.

#### §0.52.5 — Which sidebar widths separate the two predictions

With `p = frac(sidebar × dpr)` and `f = frac(the dot's offset in device px)`, the contained and
uncontained predictions differ **iff**: `p = .25 ∧ f ∈ [.25, .5)`; `p = .5 ∧ f ∈ [.5, 1)`;
`p = .75 ∧ f ∈ [.5, .75)`; and never at `p = 0`. **The offset is FONT-dependent, so which widths
separate is too:** Debian's 69.4453 device px at dpr 1.25 gives one width in four (221), which is
where the user's own width was; the Mac's `.SF NS` at a real 1.25 gives 72.21875 and NONE of 221..224
separates (348/348, 350/350, 351/351, 352/352); at a real 1.5 it is 86.67195 and 221 and 223 separate
(418/419, 421/422). Chromium's ties were measured round-half-UP. **E100 itself is measured WORKING on
macOS** at a real fractional scale: the disc at the contained column **419** against **418** with
`contain: none`.

**The test pre-flights its fixture.** `electron-shell/pane-paint.test.mjs` launches with a REAL
`--force-device-scale-factor` and asserts the RASTERISATION scale, because **CDP emulation is not a
rasterisation scale**: on a dpr-1 host, emulation alone reports `devicePixelRatio` 1.25 while a
1.2px box lays out at 1.1875, the disc spans 7 unsnapped columns, and `contain: paint` against
`none` differ in **0 of 2,892,000 px**. It picks a (dpr, sidebar) where the two predictions differ —
the 1.25 residues first, then 1.5, then 1.75 — and keeps the vacuity guard. The Mac picks 221 at
dpr 1.5; Debian picks 221 at 1.25 by arithmetic. The expectation is COMPUTED from the pane's and the
dot's own edges and requires the two predictions to differ, so a fixture that ever drifts onto an
unseparating width reports itself instead of passing vacuously. The residual is ≤ 6 of 255 of disc
anti-aliasing on 16 pixels (KNOWN-ISSUES UI-6).

### §0.53 — The macOS verification pass: every failure was the harness (E101–E106)

Taken on an Apple M2 at **dpr 1 and 144 Hz**. Four electron-shell suites went red on the first real
macOS run, and **every failure was a test or harness defect, not an app regression** — `git diff --stat -- src core`
is empty. The vocabulary this pass keeps: **MEASURED** means taken on the machine today, **READ**
means read from a source file, **INFERRED** says so where it stands.

#### §0.53.4 — A test's expectation is derived from the page, and the line boxes move with dpr (E103)

**The font-advance literals were Debian's font.** On macOS the live Obsidian 1.13.7 measured
identical to Cairn on every row — widths 12.5625 / 8.375 / 36 / 24.375 / 36, marker x
12.5625 / 8.375 / 36, item / continuation line boxes 26.375 / 25.1875 at dpr 1, the `th`'s `1ch` at
10.6614px — because macOS resolves a different face (the engine reports **`.SF NS`**). **So the
widths the old §0.35 / §0.51 A/B records quoted are measurements in DEBIAN'S font**: valid as records, and never
constants a test may pin on another machine.

**THE LINE BOXES MOVE WITH dpr.** Chromium stores layout in **1/64 DEVICE px and truncates**, so
`--list-spacing`'s 1.2px is 1.1875 at dpr 1:

| dpr | item | continuation |
|---|---|---|
| 1 | 26.375 | 25.1875 |
| 1.25 | 26.4 | 25.2 |
| 2 | 26.390625 | 25.1953125 |

**What the tests do now.** Expectations are DERIVED: widths from a reference run of spaces in
`.cm-content`'s computed font, laid out in an independent body-level hidden span and never in the
element under test (mutation-tested — sourcing it from the group under test would be a tautology);
`6ch` from the engine's resolved `min-width: 1ch` of the `th`'s face; line boxes from the probe's dpr
through 1/64-device-px truncation. **Token literals are kept** (36px, 16px) — they are the design,
not the font. `indent.test.mjs` is **4 tests** (+1 arithmetic-only formula test, which needs no
display).

Three engine facts, measured, recorded because each will be re-derived wrongly otherwise:

- **`ch` is not the `0` glyph's advance** in this engine — they are 0.30px apart before any
  snapping. The cause was not investigated.
- **An inline-block's text width snaps UP** (ceil) to 1/64 device px.
- **`DOMRect` is float32**, so comparing three-decimal numbers after adding is unsafe at non-dyadic
  scales.

#### §0.53.5 — CDP emulation is not a rasterisation scale (E104)

A page that reports `devicePixelRatio` 1.25 while rasterising at 1 cannot test a snap that exists
only at 1.25. On a dpr-1 host, CDP `Emulation` alone lays a 1.2px box out at **1.1875** (the host's
grid) and `contain: paint` against `none` differ in **0 of 2,892,000 px**; with the real
`--force-device-scale-factor` the box is 1.2000000477 and they differ by **8,372 px**. Tests that
depend on snapping launch with the REAL switch and assert the rasterisation scale, not merely
`devicePixelRatio`. `app-main.mjs`'s `CAIRN_CAPTURE_DPR` comment claiming emulation *"is the better
lever here"* was stale for any capture whose scale differs from the host's; it is struck in place.
**E100 is measured working on macOS** — §0.52.5's predicate says which (dpr, sidebar) pairs
separate, and the test pre-flights one.

#### §0.53.6 — DELETED (the frontend count is 509, not 510 — a stray gitignored `_index.css` from the deleted `build.mjs` — and the built-page SVG row now matches per `url()` so it can fail — E105).

#### §0.53.7 — native E70, `forget_vault`'s no-op, and the scroll bench above 120 Hz (E106)

**`native.test.mjs` now realpaths its temp root.** The core stores CANONICAL roots on purpose, and
the test compared `os.tmpdir()`'s `/var/folders/…` spelling with the canonical `/private/var/…` one;
it passed on Debian only because `/tmp` is not a symlink. Mutation-tested five ways.

**`forget_vault` with a non-canonical spelling of the OPEN vault is a silent no-op** — it returns
`ok: true` and neither refuses nor removes (KNOWN-ISSUES X-10). Measured through the addon. **The UI
cannot reach it:** the roots it passes come from `recent_vaults`, which are canonical.

**Above 120 Hz, `tools/scroll-bench.mjs`'s `fps` and `deficit` measure its own synthetic driver.**
`Input.synthesizeScrollGesture` dispatches every **8.333 ms** — the driver's ceiling is
`1 − 120/143.97 = 16.65%` — so the 16.8% deficit on a 144 Hz panel is not Cairn, Chromium or macOS;
wheel events measured **120.2/s**. With a 144/s trusted CDP wheel, Cairn's tree presents
**143.99 fps, 0 of 864 janky, 0 dropped**, and the compositor animation is ~143.9 in both apps.
KNOWN-ISSUES V-6.

## 1. The IPC contract

### 1.1 Conventions (normative)

- **Wire casing rule (X13), one rule, no exceptions: every struct or enum that crosses the boundary
  — command results, event payloads, search messages and `VaultError` — is camelCase**, carried by
  `#[serde(rename_all = "camelCase")]` (and `rename_all_fields = "camelCase"` on the error enum).
  Command *arguments* stay snake_case, which is what the `#[napi]` bindings and `src/ipc.ts` pass.
  `state.json` (§7.6) is **not** a wire type and keeps the schema printed there.
- **Every command result crosses as a value envelope: `{ ok: true, value }` or
  `{ ok: false, error }`** (E29). A §1.5 `VaultError` is the `error`; anything else — a wrong
  argument type, a missing binding — THROWS, so a programming error can never be mistaken for a
  §1.5 condition. The binding prefixes the serialised error with `cairn.VaultError:` and the shell
  splits on it.
- All paths in and out are **vault-relative, `/`-separated, no leading slash, `.md` retained for
  notes, `""` for the vault root**. Not `NodeId`, ever.
- Timestamps crossing the boundary are `i64` **milliseconds** since the Unix epoch.
- Every command returns `Result<T, VaultError>` (§1.5). No command returns `String` as its error.
- **`src/ipc.ts` is the only frontend module that talks to the core.** Owner: 02. The core is
  `core/`, behind a Node-API addon; `core/napi/src/lib.rs` is the binding layer and it **holds no
  logic** — every `#[napi]` body is an argument conversion and one call into `app.rs`. It declares
  no wire type either: the bytes come from `tree.rs` and `note_frame.rs`, and the JSON is
  `serde_json` over the very structs X13 annotates.
- **Raw bytes cross as a `Uint8Array` / `ArrayBuffer`** (note content, `TreeBlob`), never as a JSON
  number array — the frontend's `decodeNote` refuses one rather than accepting it (a transport that
  degrades to JSON is the 4×-slower editor §2.2 guards against).
- `core/src/note_frame.rs`'s `parse_write_headers` survives with **no production caller**. The write
  path takes typed arguments (`baseMtimeMs: number | null`, `create: boolean`) and its guarantees
  are carried by the TYPES: `Either<f64, Null>` refuses `undefined`, which is what a dropped field
  arrives as.

### 1.2 Transport rules

| Payload | Transport |
|---|---|
| note content, both directions | **raw bytes** — a `Uint8Array` in, an `ArrayBuffer` out, with §2's 24-byte frame carrying mtime and flags |
| `TreeBlob` | **raw bytes** — one `ArrayBuffer`, adopted with typed-array views |
| everything else | JSON |
| search results | ordered per-call messages; the subscription outlives the call and ends on `complete` or `error` (E31) |

**Binary payloads never travel as JSON number arrays** — measured at ~4× the bytes and requiring a
full parse — and the frontend refuses one if it ever arrives. Search never uses the global event
bus; it uses the per-call subscription `searchStart` registers and tears down itself.

### 1.3 The command table

**THE TABLE IS CLOSED AT TWENTY-FIVE.** Five commands were added after the original twenty —
**21 `forget_vault`** (§0.30 E70), **22 `open_external`** (§0.38 E85, shell-implemented),
**23 `copy_text`** (§0.46 E94, shell-implemented), **24 `move_entry`** (drag-to-move) and
**25 `secret_notes`** (secret files, user ruling). Every *"§1.3 stays closed at twenty"* in this
document is a dated record of a ruling that added none.

| # | Command | TypeScript signature | Transport |
|---|---|---|---|
| 1 | `pick_vault` | `pickVault(): Promise<string \| null>` | shell: `dialog.showOpenDialog`, MAIN process |
| 2 | `open_vault` | `openVault(path: string): Promise<VaultInfo>` | JSON |
| 3 | `current_vault` | `currentVault(): Promise<VaultState>` | JSON |
| 4 | `recent_vaults` | `recentVaults(): Promise<RecentVault[]>` | JSON |
| 5 | `rescan_all` | `rescanAll(): Promise<VaultInfo>` | JSON |
| 6 | `tree_snapshot` | `treeSnapshot(): Promise<ArrayBuffer>` | **raw out** |
| 7 | `set_sort` | `setSort(sort: SortMode \| number): Promise<number>` → new epoch | JSON |
| 8 | `read_note` | `readNote(path: VaultPath): Promise<NoteRead>` | **raw out**, §2 frame |
| 9 | `write_note` | `writeNote(path, text, flags, baseMtimeMs: number \| null, create: boolean): Promise<WriteReceipt>` | **raw in**, typed args |
| 10 | `create_note` | `createNote(parent: VaultPath, name?: string): Promise<CreateResult>` | JSON |
| 11 | `create_folder` | `createFolder(parent: VaultPath, name?: string): Promise<CreateResult>` | JSON |
| 12 | `rename_entry` | `renameEntry(path: VaultPath, newName: string): Promise<RenameResult>` | JSON |
| 13 | `delete_entry` | `deleteEntry(path: VaultPath, permanent: boolean): Promise<DeleteResult>` | JSON |
| 14 | `search_start` | `searchStart(query: string, generation: number, onMsg: (m: SearchMsg) => void): Promise<void>` | JSON + subscription |
| 15 | `search_expand` | `searchExpand(query: string, rel: VaultPath): Promise<Snippet[]>` | JSON |
| 16 | `search_cancel` | `searchCancel(generation: number): Promise<void>` | JSON |
| 17 | `save_ui_state` | `saveUiState(patch: UiPatch): Promise<void>` | JSON |
| 18 | `confirm_close` | `confirmClose(ok: boolean, reason?: string): Promise<void>` | JSON |
| 19 | `debug_mem` | `debugMem(): Promise<{ arenaBytes: number; nodes: number }>` | JSON, **absent from a release addon** |
| 20 | `reveal_in_os` | `revealInOs(path: VaultPath): Promise<void>` | JSON, **macOS-only permanently** (E59; §1.5 `io` elsewhere) |
| 21 | `forget_vault` | `forgetVault(root: string): Promise<void>` | JSON; `invalidPath` for the open vault (§0.30 E70) |
| 22 | `open_external` | `openExternal(url: string): Promise<void>` | **shell** (`shell.openExternal`), allowlist in the MAIN process (§0.38 E85) |
| 23 | `copy_text` | `copyText(text: string): Promise<void>` | **shell** (main-process `clipboard`); no allowlist, a 4,096-char sanity cap (§0.46 E94) |
| 24 | `move_entry` | `moveEntry(path: VaultPath, destParent: VaultPath): Promise<RenameResult>` | JSON; drag-to-move |
| 25 | `secret_notes` | `secretNotes(): Promise<string[]>` | JSON; `[]` with no vault open, never an error |

**There are no others.** `list_tree`, `set_expanded`, `reveal`, `tree_load`, `fs_create_note`,
`fs_create_folder`, `fs_rename`, `fs_delete`, `fs_reveal`, `vault_pick`, `vault_recents`,
`tree_set_sort` and `scan_vault` do not exist — including `fs_reveal`, whose *function* is
`reveal_in_os` under a different name.

**Command 20 is the restored "Reveal in Finder" affordance (X11).** It resolves the path through
the arena exactly as `read_note` does (so §7.3 case 13's traversal guarantee is unchanged) and
spawns `/usr/bin/open -R`; a non-existent path is `notFound` before anything is spawned. Its only
caller is **§7.3 case 3's delete-failure dialog** — `main.ts`'s `[ Show in Finder ]` — which is the
one moment the affordance is worth having.

**Command 24 is Obsidian's file-explorer drop, transcribed** (user feature): a drop
moves via rename with `getAvailablePath` uniquification, so it never refuses on collision and the
returned `path` is the FINAL one (`Foo 1.md`), adopted and never recomputed. The backend enforces
containment (a folder into itself or a descendant is `invalidPath`) and the already-there no-op.

**Command 25 lists a vault's secret-note paths** — files carrying `cairn-type: secrets` (user
feature) — for the tree's secret mark and the credentials viewer. Content search skips their bytes
(§4.1).

Mutating commands (10–13, 24) return `{ path, epoch }`-shaped results and **never** a blob; the
frontend follows with `tree_snapshot()`, which keeps every binary payload on one code path.

### 1.4 The event table

One namespace: **`nc://`**. `vault://`, `note://` and `tree:` are STRUCK everywhere.

| Event | Payload | When | Consumer |
|---|---|---|---|
| `nc://vault-opened` | `VaultInfo` | after any successful `open_vault`, including the startup one | chrome, tree, search |
| `nc://tree-changed` | `{ epoch: number }` | one per watcher flush, ≥150 ms apart, ≤750 ms of accumulation | tree, search |
| `nc://vault-lost` | `{ path: string }` | the vault root was deleted, renamed or unmounted | chrome — §7.3 case 8 |
| `nc://watch-degraded` | `{ reason: "watch-limit" \| "watch-error", hint: string }` | at most once per vault | chrome — draws the `.watch-degraded` banner (§0.12 E14) |
| `nc://note-external-change` | `{ path, mtimeMs, size }` | only for `AppState.open_note` | editor |
| `nc://flush-and-close` | `{ deadlineMs: 2000 }` | a close/quit was intercepted; the frontend must flush | editor |
| `nc://window-state` | `{ maximized: boolean }` | the WM maximizes/unmaximizes, or the app toggles it | chrome (§0.5 E7) |
| `geometry-report` | the probe result object | `--pixeltest` only | `electron-shell/app-main.mjs` — §5.11 |
| `bench-mark` | `{ mark: string, epoch_ms: number }` | only under `window.__CAIRN_BENCH__` | **none on this shell** — `src/bench.ts` still emits it and nothing consumes it; the memory harness is retired. Treated as dead code |

`nc://tree-changed` carries **the epoch and nothing else**. `dirs` and `total` are STRUCK: the
frontend rebuilds wholesale, so a changed-directory list has no consumer. `epoch` is a `u64`
monotonic counter serialised as a JS number (it cannot reach 2^53) and is the **same counter** as
the blob header's `epoch` and every mutating command's returned `epoch`. There is exactly one such
counter in the process.

**`geometry-report` and `bench-mark` are deliberately outside the `nc://` namespace.** `nc://` is
the app's own bus, emitted by the core and consumed by a frontend owner; these two run the other
way, emitted by the frontend and consumed by the shell under a harness only, and neither is a
command.

Search never uses the global event bus; it uses the per-call subscription (§1.3 command 14).

### 1.5 Shared types — `src/ipc.d.ts` (normative, owner 02, must match Rust exactly)

```ts
/** Vault-relative, '/'-separated, no leading slash. "" is the vault root. Notes keep ".md". */
export type VaultPath = string;

/** Wire value is the u8. The named members exist for readability only; sorting is pinned to
    file name A-Z in the UI (§0.12 E14) and the frontend only ever sends 0. */
export const enum SortMode { NameAsc = 0, NameDesc = 1, MtimeDesc = 2, MtimeAsc = 3 }

/* CASING: every type in this file is camelCase on the wire (§1.1). The Rust mirrors all carry
   #[serde(rename_all = "camelCase")]. There is no snake_case field anywhere below. */

export interface VaultInfo {
  root: string;              // absolute, for the vault-switcher button. ALSO the state.json key (§7.6)
  name: string;              // final path component
  nNotes: number;
  nDirs: number;
  sort: SortMode;            // 0..3
  epoch: number;             // matches the blob header
  lastNote: VaultPath | null;
  /** §7.6, Z2. The persisted expansion set for THIS vault, folders only, already truncated to
   *  2000 and already sanitised by Rust. `[]` when nothing was persisted.
   *  THIS IS THE READ PATH for what `UiPatch.expanded` writes. */
  expanded: VaultPath[];
  /** §7.6, Z2. The persisted sidebar scroll offset for THIS vault. Finite and >= 0;
   *  `0` when nothing was persisted. THE READ PATH for what `UiPatch.scrollTop` writes. */
  scrollTop: number;
  watching: boolean;         // false => the watcher-degraded banner is drawn (§0.12 E14)
  truncated: boolean;        // the 50,000-node cap was hit (nodes only; depth is banner-only, §3.3)
  truncatedDepth: boolean;   // the 255-depth cap was hit — drives the second §3.3 banner
}

/** The first run is a distinct state, not a null VaultInfo. `none` renders the shell and nothing
 *  else (§0.44 E89 deleted the first-run panel); `loading` waits for `nc://vault-opened`. */
export type VaultState =
  | { state: 'none' }
  | { state: 'loading' }
  | { state: 'open'; info: VaultInfo };

export interface RecentVault { root: string; name: string; exists: boolean }

export interface NoteRead { mtimeMs: number; flags: number; text: string }   // from decodeNote()
export interface WriteReceipt { mtimeMs: number; size: number }              // camelCase, X13
export interface CreateResult { path: VaultPath; epoch: number }
export interface RenameResult { path: VaultPath; epoch: number }
export interface DeleteResult { epoch: number }

export interface UiPatch {
  win?: { w: number; h: number; x: number; y: number; max: boolean };
  /** §0.7 E9. The sidebar width in px, GLOBAL like `win` and not per-vault. Written on release
   *  of the resize drag. Rust clamps it on read, so a hand-edited state.json cannot ship a 0px
   *  or a 90,000px sidebar. */
  sidebarW?: number;
  lastNote?: VaultPath | null;
  sort?: SortMode;
  expanded?: VaultPath[];    // folders only; capped at 2000, see §7.6
  scrollTop?: number;
}

/* ── search ───────────────────────────────────────────────────────────────── */

export interface Snippet {
  line: number;              // 1-based
  text: string;              // EOL-trimmed, <= 262 chars
  ranges: [number, number][];// UTF-16 code units, ascending, non-overlapping
  col: number;               // UTF-16 column of the first match in the ORIGINAL line
  len: number;               // UTF-16 length of that match
}

export interface FileGroup {
  /** Index into `VaultSnapshot.files` (§4.2) — the FILES-ONLY index space, which is NOT the
   *  TreeBlob node index space (the blob also contains directories). Valid only for the
   *  `gen` it arrived on, and usable only as a DOM key. Anything that has to find the tree row
   *  for a result resolves it BY PATH (`rel`), never by this number. (X14) */
  id: number;
  rel: VaultPath;
  name: string;              // basename without ".md"
  nameRanges: [number, number][];
  snippets: Snippet[];       // <= 2 here; the rest via search_expand
  matchCount: number;
  more: boolean;
  rank: [number, number, number];
}

export type SearchMsg =
  | { kind: 'files';    gen: number; groups: FileGroup[] }
  | { kind: 'batch';    gen: number; groups: FileGroup[] }
  | { kind: 'complete'; gen: number; order: number[]; totalMatches: number; totalFiles: number;
      scanned: number; skipped: number; truncated: boolean; smartCase: boolean;
      cancelled: boolean; elapsedMs: number }
  | { kind: 'error';    gen: number; message: string };

/* ── errors ───────────────────────────────────────────────────────────────── */

export type VaultError =
  | { kind: 'noVault' }
  | { kind: 'notFound';         path: string }
  | { kind: 'alreadyExists';    path: string }
  | { kind: 'notADirectory';    path: string }
  | { kind: 'notUtf8';          path: string }
  | { kind: 'tooLarge';         path: string; bytes: number; limit: number }
  | { kind: 'invalidName';      name: string; reason: string }
  | { kind: 'invalidPath';      path: string; reason: string }
  | { kind: 'conflict';         path: string; diskMtimeMs: number }
  | { kind: 'trashUnavailable'; path: string; message: string }
  | { kind: 'io';               path: string; code: number; message: string }
  | { kind: 'cancelled' };
```

Rust mirror: `#[derive(serde::Serialize)] #[serde(tag = "kind", rename_all = "camelCase",
rename_all_fields = "camelCase")] pub enum VaultError` in **`core/src/error.rs`** — the second
attribute is what makes `disk_mtime_ms` arrive as `diskMtimeMs`. `std::io::Error` is never returned
raw. **The frontend switches on `kind` and MUST NOT parse `message`**, which is OS-localised.

`SearchHit` and `SearchEvent` are STRUCK.

### 1.6 The flush-on-quit handshake (B11, B18, M55)

```
user hits ⌘Q / clicks the ✕
  ├ shell  win.on('close') and app.quit() both reach core's begin_close; the close is prevented
  ├ core   arm a 2000 ms watchdog, send nc://flush-and-close { deadlineMs: 2000 }
  ├ JS     cancel both autosave timers; await flushNow("close")
  │          ├ resolved -> confirm_close(true)
  │          └ REJECTED -> confirm_close(false, "<VaultError.kind>") and show the modal
  ├ core   confirm_close(true)  -> flush state.json, then close for real
  ├ core   confirm_close(false) -> DISARM the watchdog, cancel the close, the window stays open
  └ core   watchdog fires with no answer at all -> flush state.json, close anyway
```

**The watchdog exists for a hung disk, not for a refused write.** A flush that *rejects* —
`conflict`, `io` with `EACCES`, `ENOSPC` — MUST cancel the close and surface a modal:

> **This note could not be saved.**
> `<one line naming the reason>`
> `[ Keep editing ]  [ Discard changes and quit ]`

`Keep editing` is the default and is focused on open. `Discard changes and quit` re-invokes
`confirm_close(true)`. Only a flush that has not *returned at all* after 2,000 ms may fall through
to the watchdog, and that path logs what it is discarding. Sequencing is fixed: **editor buffer
first, `state.json` second.**

**The measured facts behind that drawing** (E32, E33), all of them exercised by
`electron-shell/close-handshake.test.mjs` in three separate child processes: a rejecting flush is
run PAST the deadline (2,400 ms) and **nothing quits**; the deadline is a real TIMER (2,001 ms
measured, not just the compiled constant); `state.json` is written by `flush_now`, not by the
1,000 ms debounce; answering **disarms** the watchdog; and `close_ok` **latches**, so the ✕ after a
confirmed quit goes straight through instead of re-arming. A separate process per scenario is
load-bearing: `close_ok` is a process-wide latch with no reset.

`close` is always `win.close()`, NEVER `win.destroy()` — `destroy()` would skip the handshake, and
the source-level assertion that no `destroy()` path exists stays as the cheap half of the test.

**Single-instance is Obsidian's own**, read rather than derived: `app.requestSingleInstanceLock()`,
and the process gives up if it does not get it. The hazard it closes is §7.6's — two instances on
one vault are two writers of one `state.json`, last-flush-wins. **A hermetic run gets its own
`userData`**, which is three things at once: the profile stops landing beside the real one,
`state.json` goes with it, and — the load-bearing one — **Electron keys the instance lock on
`userData`**, so the lock cannot make a test suite fail depending on whether the user has Cairn
open. `electron-shell/lifecycle.test.mjs` executes both the ✕ and `app.quit()` through the same
function.

#### 1.6.1 The modal primitive — `src/modal.ts`, owner 01

**`src/modal.ts` is THE ONLY MODAL IN THE APP**, and that is a file-ownership rule rather than a
style opinion: `main.ts`'s table line is *"entry: boot sequence, wires modules, owns nothing else"*,
so the primitive lives here and *a second implementation cannot appear without appearing in
somebody's diff as a new file.* It has exactly **five call sites**, all of them standing between a
user and something destructive:

| Caller | The question |
|---|---|
| §1.6 | `This note could not be saved.` — Keep editing / Discard changes and quit |
| §7.3 case 3 | the dirty-delete prompt (Cancel / Save and delete / Delete without saving) |
| §7.3 case 5/6 | the delete confirm, transcribed from Obsidian (Delete file) |
| §7.3 case 3/5/6 | the delete-failure report (Could not delete…) |
| secrets | the secret entry's delete confirm (Delete secret) |

```ts
// src/modal.ts — owner 01.
export interface ModalButton {
  id: string                 // returned by openModal(); stable, not the label
  label: string
  destructive?: boolean      // renders in --text-error; never the default
  cta?: boolean              // with destructive: the SOLID red fill (Obsidian mod-cta)
}

export interface ModalSpec {
  title: string
  details: string[]          // one or more paragraphs
  warnings?: string[]        // amber rows
  buttons: ModalButton[]     // rendered left to right, 2 or 3
  defaultId: string          // MUST match one button's id; focused on open; what Escape picks
  focusId?: string           // if set, THIS button takes focus instead (see the fork below)
}

/** Resolves with the picked button's id. Never rejects. */
export function openModal(spec: ModalSpec): Promise<string>
```

**Normative behaviour.** All eight are requirements, and the last two exist only because this
dialog stands between a user and their unsaved text:

1. **The default is focused on open and Escape picks it** — with one measured FORK: the delete
   confirm passes `focusId` so the ACCEPT button takes focus, which is what Obsidian does. Every
   guard around it is kept: `defaultId` stays the SAFE button (Escape, the no-stack refusal
   answer), the Trash is recoverable, and each file of a multi-delete is confirmed on its own. A
   caller that passes no `focusId` gets the plain behaviour.
2. **A click on the backdrop does nothing.** A stray click must not answer a data-loss question.
3. Focus is restored to the previously focused element when the dialog closes.
4. `role="dialog"`, `aria-modal="true"`, and Tab cycles within the dialog while it is open.
5. **One modal at a time.** A call made while one is open is refused: the returned promise resolves
   with the open dialog's `defaultId`, and it logs. Two stacked data-loss prompts is a bug, never a
   state to render.
6. **No element in the dialog may declare `overflow: auto | scroll | overlay`** (§5.12.4.3). The
   detail text wraps; it never scrolls. That is why the box has a `max-width` and no `max-height`.
7. It is built from `createElement` / `textContent` with inline `style`. **Never `innerHTML`** — the
   detail carries user-controlled note names, and `<img src=x onerror=…>.md` is a legal filename.
8. It consumes only `tokens.css` custom properties and adds no rule to any owner's sheet. Sizes and
   colours are tokens (plus a handful of `[S]` literals transcribed from Obsidian's own sheet for
   things Cairn has no token for, each cited where it stands).

## 2. The note read/write byte framing (B2)

This is the vault-corruption path. Critic B2 is **confirmed and quantified**: with a bare 16-byte
header decoded from offset 0, `new TextDecoder('utf-8', {fatal:true})` silently accepts **3.581%**
of realistic 2020–2030 mtimes (7,162 of 200,000), and the default non-fatal `TextDecoder` accepts
**100%** of them. The demonstrated consequence is a file that grows by exactly 16 bytes of binary
garbage at its head, on every save, forever.

The header cannot simply be dropped — the read path returns one body and a second JSON call would
open a TOCTOU window — so the fix is to make the header **self-describing**, which is free: measured
identical to a bare header at every payload size.

### 2.1 The frame

| Offset | Type | Field |
|---:|---|---|
| 0 | `u32` LE | `magic` = `0x4E4F5445` (`"NOTE"`) |
| 4 | `u32` LE | `version` = `1` |
| 8 | `i64` LE | `mtime_ms` |
| 16 | `u32` LE | `size` — byte length of the content that follows |
| 20 | `u32` LE | `flags` — bit 0 = source had CRLF, bit 1 = source had a UTF-8 BOM |
| 24 | `u8[size]` | UTF-8 content, LF-normalised, BOM stripped |

### 2.2 The two files, printed adjacent so they cannot drift

**These are the only two places this layout exists.**

```rust
// core/src/note_frame.rs  — THE ONLY PLACE THIS LAYOUT EXISTS IN RUST
pub const NOTE_MAGIC:   u32   = 0x4E4F_5445;   // "NOTE"
pub const NOTE_VERSION: u32   = 1;
pub const NOTE_HEADER:  usize = 24;
pub const FLAG_CRLF: u32 = 1 << 0;
pub const FLAG_BOM:  u32 = 1 << 1;

pub fn encode_note(mtime_ms: i64, flags: u32, content: &[u8]) -> Vec<u8> { /* §2.1, in order */ }

/// Inverse of the read normalisation. Applied by RUST, never by the caller (M51).
pub fn denormalise(text: &[u8], flags: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() + text.len() / 32 + 3);
    if flags & FLAG_BOM != 0 { out.extend_from_slice(&[0xEF, 0xBB, 0xBF]); }
    if flags & FLAG_CRLF != 0 {
        for &b in text { if b == b'\n' { out.push(b'\r'); } out.push(b); }
    } else {
        out.extend_from_slice(text);
    }
    out
}
```

```js
// src/note_frame.js  — THE ONLY PLACE THIS LAYOUT EXISTS IN JS
export const NOTE_MAGIC = 0x4E4F5445, NOTE_VERSION = 1, NOTE_HEADER = 24;
export const FLAG_CRLF = 1, FLAG_BOM = 2;

export function decodeNote(buf) {
  if (!(buf instanceof ArrayBuffer)) throw new Error('read_note did not return an ArrayBuffer …');
  if (buf.byteLength < NOTE_HEADER) throw new Error('note frame too short: ' + buf.byteLength);
  const dv = new DataView(buf);
  const magic = dv.getUint32(0, true);
  if (magic !== NOTE_MAGIC) throw new Error('note frame magic 0x' + magic.toString(16) + ' != 0x4e4f5445');
  const version = dv.getUint32(4, true);
  if (version !== NOTE_VERSION) throw new Error('note frame version ' + version);
  const size = dv.getUint32(16, true);
  if (buf.byteLength !== NOTE_HEADER + size)
    throw new Error('note frame size ' + size + ' != body ' + (buf.byteLength - NOTE_HEADER));
  return {
    mtimeMs: Number(dv.getBigInt64(8, true)),
    flags:   dv.getUint32(20, true),
    text:    new TextDecoder('utf-8', { fatal: true })
               .decode(new Uint8Array(buf, NOTE_HEADER, size)),
  };
}
```

Four guards, each converting one class of drift into an immediate throw: transport degradation,
wrong offset, version skew, truncation. `new Uint8Array(buf, 24, size)` is a **view** — the decode
stays zero-copy, which is why the header costs nothing.

**The `instanceof ArrayBuffer` guard is not optional.** It is the only thing standing between a
degraded transport and a silently 4×-slower editor: if the payload ever arrives as a JS `Array` of
numbers, `new Uint8Array(thatArray)` *works*.

### 2.3 `write_note` — the exact call

```ts
// src/ipc.ts
export function writeNote(
  path: VaultPath, text: string, flags: number,
  baseMtimeMs: number | null, create: boolean
): Promise<WriteReceipt> {
  return call<WriteReceipt>('write_note', {
    path,
    text: new TextEncoder().encode(text),
    flags,                                        // echoed verbatim from decodeNote()
    baseMtimeMs: baseMtimeMs === undefined ? null : baseMtimeMs,
    create,                                       // B17 — autosave ALWAYS sends false
  })
}
```

**`baseMtimeMs: null` means force-overwrite; `create` is `true` in EXACTLY ONE PLACE in the whole
app**, the `[ Save as… ]` button on §7.3 case 5's bar. `write_note` NEVER CREATES on its own (§7.1
rule 1). `eol: "lf" | "crlf"` is STRUCK: it cannot represent a BOM, and the round trip below is
byte-exact only because `flags` carries one.

### 2.4 The round-trip invariant (normative)

> **Bytes read from a file whose line endings are UNIFORM, and written back unmodified, MUST be
> byte-identical, BOM and CRLF included.** No save may add, remove or rewrite a byte the user did
> not type. **A file that mixes bare `\n` with `\r\n` is the one exception, is unified on CRLF by
> the first save, and is specified in §2.4.1.**

Rust owns both halves. `read_note` strips the BOM and rewrites `\r\n` → `\n`, recording both in
`flags`; `write_note` calls `denormalise(text, flags)` before the atomic write. The frontend never
touches EOLs and never sees a BOM.

Verified end to end across seven cases — LF, CRLF, BOM+LF, BOM+CRLF, BOM+CRLF+CJK+emoji, 200 KiB
CJK, 1 MiB ASCII — all **byte-exact**, with no BOM and no CR leaking into the editor text, and
re-verified since across nine uniform cases by `dl_13` (adding BOM-only, empty,
no-trailing-newline, lone-CR and multi-byte UTF-8).

**Tests that prove it** (all mandatory, `core/tests/vault_ops.rs` + the JS suite):

| # | Test | Assertion |
|---|---|---|
| T2.1 | Read then save with **no edit**, for each of the seven cases above | the file's bytes are identical, `cmp` exits 0 |
| T2.2 | Feed `decodeNote` a bare-bytes buffer | throws `magic 0x… != 0x4e4f5445` |
| T2.3 | Feed `decodeNote` a JS `Array` of numbers | throws `did not return an ArrayBuffer` |
| T2.4 | Feed `decodeNote` a frame whose `size` disagrees with the body | throws |
| T2.5 | 200,000 realistic mtimes through `encode_note` → `decodeNote` | 0 silent acceptances of a wrong offset |
| T2.6 | Non-UTF-8 note | `notUtf8`, and the file is byte-identical afterwards |
| T2.7 | The mixed-EOL note of §2.4.1, read then saved | exactly the bytes §2.4.1 prints; idempotent on a second round trip; no `\r` deleted; and an unedited open performs **zero** writes |

#### 2.4.1 Mixed line endings — unify on CRLF (Z3)

**Measured** (`dl_14`), and this is the whole defect:

```
on disk   b"crlf\r\nbare\nboth\r\n\nend"          19 bytes
read back b"crlf\r\nbare\r\nboth\r\n\r\nend"    21 bytes   (+1 per previously-bare \n)
```

`normalise` sets `FLAG_CRLF` if the file contains **any** `\r\n`; `denormalise` then writes
**every** line ending as `\r\n`. Any vault touched by both a Windows and a Unix editor has such
files, and the user sees `git` report every line changed after editing one word.

**Ruling: unify on CRLF; do not attempt byte-exact preservation.** Preserving a mixed file
byte-exactly means knowing, for every line ending in the *saved* text, whether it was originally
bare — after an edit there is no such fact, so the scheme is not harder, it is undefined. The only
well-defined alternative (keep the `\r`s in the buffer) is strictly worse: CodeMirror treats a lone
`\r` as content, so the next save would **delete every one of them**, turning the file uniformly LF
— a larger unrequested change, in the direction of losing bytes. Unification adds one byte per
previously-bare `\n`, deletes nothing, and is idempotent.

**What keeps this honest, and it is normative: Cairn never writes a note whose buffer is not
dirty.** Merely *opening* a mixed-EOL note must never rewrite it. Unification therefore only ever
happens to a file the user has already edited — the difference between "the app reformatted my
vault" and "my editor normalised the file I was editing". This is a limitation, recorded as one,
and `README.md` states it in one line; `write_note` emits no warning and shows no bar.

**Test (mandatory), T2.7:** `dl_14` — the exact byte strings above; a second round trip is
byte-identical; **no `\r` present on disk is ever absent afterwards**; and a note that is opened but
never edited is **not written at all**.

## 3. The tree transport (B1, B19, M49, M38)

### 3.1 Ruling

**One design: `TreeBlob v1`, the whole tree, once, as raw bytes.**

It is the design the virtualiser can consume without a rewrite: one `ArrayBuffer`, adopted with
typed-array views, no per-node allocation, no payload on the wire on a scroll tick. A JSON page
puts a payload on the wire on every tick, and columnar chunks over a channel buy a progressive
paint the tree does not need — the tree paints long before first paint.

### 3.2 `TreeBlob v1` — the layout

Little-endian throughout. Nodes are emitted in **preorder DFS, already sorted by the active
`SortMode`, excluding the vault root**.

> **Invariant P.** A node at index `i` owns the contiguous range `[i+1, i+subtree[i]]`. Its parent
> always has a lower index. A folder's parent is always a folder.

Invariant P is what makes flattening O(visible), "collapse a folder" a single integer add, and the
expanded-state restore pass touch only folders. Every consumer may rely on it.

```
off        size        field
  0        u32         magic       0x3142544E   ("NTB1" LE)
  4        u32         version     1
  8        u32         node_count  N
 12        u32         names_len   M            (bytes)
 16        u32         sort_order  0..3         (echo of the active SortMode)
 20        u32         flags       bit0 = TRUNCATED_NODES, bit1 = TRUNCATED_DEPTH
 24        u64         epoch                    (the one process-wide counter, §1.4)
 32        u32[N]      subtree     descendant count, excluding self
 32+4N     i32[N]      parent      index of parent, -1 for a top-level node
 32+8N     u32[N+1]    name_off    byte offsets into `names`; name_off[N] == M
 32+12N+4  u8[N]       depth       0 = top level; hard cap 255
 32+13N+4  u8[N]       kind        bit0 = is_directory; bits 1..7 reserved, MUST be 0
 32+14N+4  u8[M]       names       concatenated UTF-8 DISPLAY names, no separators
```

`total = 36 + 14N + M`. Measured: **191,975 B** at N=5,620, M=113,259.

`names` holds **display** names: a file's trailing `.md` is stripped by Rust. The real filename is
`display + ".md"` for files and `display` for folders — sound because the tree contains only `.md`
files and directories.

**`subtree[i]` is still what `hasKids()` means, but the CHEVRON is not keyed off it: EVERY folder
draws a chevron, empty or not** (§0.17 E19 — Obsidian's `setCollapsible(true)` is unconditional, and
M61 is struck).

The frontend adopts the blob with typed-array **views** — no copy, no parse, no per-node allocation
— and MUST validate `magic` and `version` before creating any view.

### 3.3 Caps (M38)

| Cap | Value | Signal | Behaviour |
|---|---|---|---|
| nodes | **50,000** | header `flags` bit 0 | the walk stops descending; the UI shows one line above the tree: `This vault is very large; only the first 50,000 items are shown.` |
| depth | **255** | header `flags` bit 1 | the subtree is not descended into; the UI shows `Some folders are nested too deeply to display.` |

Both caps live in `scan.rs`. Depth truncation gets its own bit; overloading `nc://watch-degraded`
for it is STRUCK. Both bits are surfaced on `VaultInfo` as `truncated` and `truncatedDepth` (§1.5)
so the banner's owner can read them without parsing the blob.

**The banners have an owner and a geometry (X9).** Owner **01**, in `src/chrome.ts` / `chrome.css`,
as SIBLINGS of the live scroller inside the sidebar — never inside it, so they do not scroll away
and do not enter the tree's coordinate system.

- One cap banner: box `y 40..63`, **height 24px** (`box-sizing: border-box`, 1px
  `--bg-modifier-border` bottom rule), full sidebar width, `--bg-secondary`, `--fs-ui-smaller` in
  `--text-faint`, `padding: 0 12px`, single line, `text-overflow: ellipsis`, no icon, no dismiss
  control. Both caps can be present at once, stacked in that order, for 48px.
- The live scroller — `.tree-scroller` or `.search-scroller` — starts immediately below and is
  **881 − 24·(banners shown)** tall: **881 with none, 857 with one, 833 with both.** The vault bar
  does not move. §0.12 E14 adds a THIRD banner in this slot — §7.3 case 16's 48px
  `.watch-degraded` — ABOVE the cap banners and BELOW `.vault-lost`: `gone > stale > truncated`.
- **The row pool is sized from the scroller's LIVE `clientHeight`, never from the constant 881.**
  A banner appearing or disappearing is an ordinary resize. The formula is
  **`ceil(clientHeight / --row-h) + 2·OVERSCAN + 1` with `OVERSCAN = 8`** (a named constant in
  `tree.ts`), which is 50 rows at 881px, 49 at 857, 48 at 833. (`--row-h` is itself a MEASURED value
  re-seated at runtime by `chrome.ts`'s `applyRowH`, §0.22 E44.)
- **The banners belong to the sidebar, not to the tree.** The search panel REPLACES the tree, so
  the two views share a box and the banners stay visible in both: `VaultSnapshot` (§4.2) is built
  from the same capped walk, so results are truncated by the same cap, and hiding the warning on
  the view where the user is *hunting for a missing note* is the worst possible moment to hide it.
  Toggling views never reflows the sidebar.
- The geometry gate (§5.11) runs on a fixture that trips **neither** cap and whose watcher is
  healthy: it asserts the 881px band and that **zero** `.cap-banner` AND **zero** `.watch-degraded`
  elements exist. A capped vault is not a gate configuration.

### 3.4 Where expansion state lives

**Expansion is frontend-owned: a `Set<string>` of vault-relative folder paths, persisted per vault
in `state.json` (§7.6).** Rust carries no expansion; `set_expanded` and `reveal` do not exist.

The key is the **vault-relative path**, which is stable across rescans, restarts, a `git checkout`
and NodeId recycling. A folder **created** externally has never been expanded by the user, so
opening it collapsed is correct; a folder **deleted and recreated** externally restores the user's
expansion because the path survived even though the node did not. Dead entries are **not pruned on
every refresh** — only after a successful full scan at `open_vault` / `rescan_all`, where any entry
that no longer resolves to a directory in the fresh blob is dropped. In-app folder renames re-key
their own prefix, so the common case never produces a dead entry.

`reveal` is three lines of frontend: add every ancestor of the target path to the `Set`, re-flatten,
return the visible index. No IPC.

### 3.5 Refresh, echo suppression and self-inflicted events (M26, M39)

```js
listen('nc://tree-changed', async ({ payload }) => {
  if (payload.epoch <= lastEpoch) return;              // out of order, or already applied
  const blob = await treeSnapshot();
  const st = treeEl.scrollTop;
  adopt(blob); restore(); flatten();
  treeEl.scrollTop = Math.min(st, Math.max(0, visibleCount * rowH - treeEl.clientHeight));
  repaintRange(curFirst, curLast);
  lastEpoch = payload.epoch;
});
```

**Full rebuild, always. No deltas.** A warm rescan is milliseconds and the frontend side is <3 ms;
delta application against a virtualised list is where tree bugs live.

**Echo suppression is by exact fingerprint, never by a time window** (M26). spec-04's "500 ms TTL
touched-paths set" is STRUCK: 500 ms is simultaneously too long (it swallows a genuine external
edit made in that window) and too short (a busy machine delivers later).

```rust
pub struct SelfWrite { pub abs: PathBuf, pub mtime_ns: u128, pub len: u64, pub deadline: Instant }
```

Recorded from **post-operation** metadata, capped at 8 entries, matched exactly on
`(abs, mtime_ns, len)` and removed on match. `deadline` (now + 5 s) is garbage collection only and
is **never** the reason an event is dropped. Per-operation rules, all normative:

| Operation | Fingerprint(s) recorded |
|---|---|
| `write_note` | `(abs, post_mtime_ns, post_len)` |
| `create_note` / `create_folder` | `(abs, post_mtime_ns, post_len)`; a folder's `len` is whatever `metadata` reports |
| `delete_entry` | `(abs, 0, 0)`; matches only when the path no longer exists |
| `rename_entry` | **two** entries — `(old_abs, 0, 0)` with the delete rule, **and** `(new_abs, post_mtime_ns, post_len)` |
| `move_entry` | the same two-entry rule as `rename_entry` (a cross-directory rename) |

The watcher's unit of repair is a **directory**, never a file: rename events are the least reliable
part of every notification API, and re-reading the containing directory is ~30 µs and correct for
every event kind including ones nobody has seen.

**`Node.mtime` is updated on every content hit, unconditionally** (M69). Updating it only when the
sort is time-based is STRUCK: the stat is already being done for the fingerprint check, so it is
free, and without it switching to "Modified (new to old)" after a day of external editing orders the
tree by walk-time mtimes.

### 3.6 What the tree contains

Directories, and files whose name ends `.md` (ASCII case-insensitive). Excluded by the scanner: any
name starting `.` (covers `.obsidian`, `.git`, `.trash`, `.DS_Store`, and our own temp files),
symlinks (not followed, not shown), and every non-`.md` file. Empty folders **are** shown.

**Three recorded divergences/additions:** a deliberate divergence from Obsidian (the filter above,
agreed by the specs); **vault-root `Memoir.md` is hidden from the sidebar** (the fixed Memoir tab's
note — `notes/Memoir.md` is an ordinary note); and **secret files carry a tree mark** (`is-secret`,
resolved from the `cairn-type: secrets` frontmatter, command 25).

## 4. The search engine (B4, B20, B5, M47, M48)

### 4.1 Ruling: the grep-searcher engine ships

**spec-02 §8 is STRUCK in its entirety** — the brute-force `memchr` scanner, its batches and its
`SearchHit` / `SearchEvent` types. Why: spec-02's engine cannot express multi-token AND, cannot do
smart case, and is **case-sensitive for all non-ASCII**, which for a notes app used in any
non-English language is a product defect, not a limitation. The chosen engine is measured at 45–65
ms warm over the same class of fixture. The measured fact that decides it: **the entire Rust side of
a 5,000-note vault is 0.5% of the app**, so the engine should be chosen on capability, not on crate
count.

Two amendments, both normative:

1. **Threads: 4, not 8, and spawned per query — no persistent pool** (M40). 8 threads regressed
   **31%** against 4 on this 8-core machine (32 ms → 42 ms). Thread creation is ~60 µs each — 0.4%
   of a search — and a permanent pool would hold 4 threads plus 4 × 64 KB of line buffers at rest
   for a feature used for seconds per session. `const SEARCH_THREADS: usize = 4;`
2. **`REGEX_DFA_SIZE_LIMIT` is 1 MiB** (not 4 MiB): at 4 MiB × 4 workers the lazy-DFA cache alone
   would be a 16 MB worst case. `REGEX_SIZE_LIMIT` stays 1 MiB.

Dependencies: `grep-searcher`, `grep-regex`, `grep-matcher` and their transitives (`bstr`,
`regex-automata`, `regex-syntax`, `aho-corasick`, `encoding_rs`, `encoding_rs_io`, `memmap2`, `log`,
`unicode-segmentation`). `MmapChoice::never()` is set on every `Searcher`. **`nucleo-matcher` is
NOT among them** — §0.33 E79 removed it when filename search became a substring match, and with it
`THIRD-PARTY-NOTICES.md`'s MPL-2.0 obligation for it.

**Content search skips secret notes' bytes**: a `cairn-type: secrets` file is listed by name but its
content is not scanned.

### 4.2 The vault-path seam — `Arc<VaultSnapshot>`, lazily built (B5, M48)

Neither extreme is right: republishing the snapshot on **every** mutation pays 440 KB and a full
rebuild on a 150 ms watcher debounce for a feature that may never be used in a session, and having
**no** paths ever forces search to reconstruct 5,000 paths inside the read lock on every query.

**Ruling: publish an `Arc<VaultSnapshot>` that is built lazily on first request, cached, and
invalidated by the generation counter.**

```rust
// tree.rs — the seam. Owner: 02.
pub struct VaultSnapshot {
    pub root: PathBuf,        // absolute, no trailing separator
    /// Every .md in the vault, in the SAME preorder DFS traversal the blob is emitted from, with
    /// directories OMITTED. This is a FILES-ONLY index space and it is NOT the blob's node index
    /// space: the blob contains directories, this does not, so index i here and node i there are
    /// different objects. Nothing may convert between them by arithmetic. (X14)
    pub files: Vec<NoteEntry>,
    pub epoch: u64,           // the generation this snapshot was built from
}

pub struct NoteEntry {
    pub rel: Box<str>,        // vault-relative, '/'-separated, always ends ".md"
    pub name_start: u32,      // byte offset of the basename inside `rel`
    pub name_len: u32,        // byte length of the basename WITHOUT ".md"
    pub size: u32,
    pub mtime_ms: i64,
}

pub struct Vault {
    tree: RwLock<VaultTree>,
    /// Interior mutability on purpose: `snapshot()` is a READ operation and must not need the
    /// write lock. Holds (epoch_it_was_built_from, the published Arc).
    snap_cache: Mutex<Option<(u64, Arc<VaultSnapshot>)>>,
}
```

**Lifetime rule, normative:** the returned `Arc` is IMMUTABLE; a mutation does NOT rebuild it and
does NOT invalidate it eagerly — it only bumps `epoch`; the next call whose `epoch` differs
REPLACES the cache entry, and the old `Arc` stays alive exactly as long as its last holder, so an
in-flight search's paths can never dangle. Cost when cold: one pass over the arena, ~0.8 ms for
5,000 notes and ~440 KB resident. Cost at rest if search was never used: ZERO. Dropped with the
`Vault` on switch, before `malloc_trim`.

Consequences, all normative:

- "Paths are reconstructed, never stored" **stands at rest** and for every non-search code path.
- **A search job pins the `Arc` it started with for its whole life.** Files deleted mid-scan surface
  as `skipped += 1`, never as an error; files created mid-scan appear on the next search.
- **`FileGroup.id` is an index into `files`** — a files-only space, meaningless outside the snapshot
  it came from (§1.5). The frontend uses it as a DOM key and for `search_expand`'s bookkeeping only;
  "show this result in the tree" resolves `FileGroup.rel` against the blob **by path**, exactly as
  expansion does (§3.4). Adding an offset to a `FileGroup.id` to reach a tree node is wrong by
  however many directories precede it.

### 4.3 Vault switch ordering (M30)

Fixed, and the order is load-bearing on both sides.

**Frontend, before anything is torn down:**

```
1. await flushNow("switch")     -> on REJECT, ABORT the switch and show the error. Never discard.
2. persist state.json for the OUTGOING vault (expanded set, last note, scroll)
3. view.setState(EditorState.create({ doc: '', extensions }))   <- NOT view.destroy()  (M70)
4. searchCancel(gen); clear the panel
5. drop the blob, the views, the ui/visible arrays, the name cache
6. invoke open_vault(newRoot)
```

Step 3 is normative: **there is exactly one `EditorView` for the process lifetime.** `setState`
drops the rope, the history and the block index just as effectively, and §5.3's numbers assume a
single view. Destroying the editor before the flush is STRUCK.

**Core, inside `open_vault`:**

```rust
let old = { write(&state.vault).take() };   // take it OUT, then release the guard
{ *lock(&state.open_note) = None; }
state.search_cancel_all();                   // X15 — NOT a generation bump; see below
drop(old);                                   // watcher dropped -> thread joined -> arena freed
#[cfg(target_os = "linux")] unsafe { libc::malloc_trim(0); }
```

**The search generation has exactly one writer (X15).** Normative:

- **The frontend owns the number.** `generation` is a frontend-side monotonic `u64` starting at 1
  **per process**, incremented on every `search_start`, never reused, and passed back verbatim to
  `search_cancel`. The core never invents, bumps or reorders it; it stores the newest value it has
  been given and echoes it on every `SearchMsg`.
- The frontend **discards any `SearchMsg` whose `gen` is not the generation of its current query.**
  This is the only staleness test that exists.
- **A vault switch does not touch the counter.** It cancels every in-flight search through
  `search_cancel_all()` — generation-independent, so it cannot collide with a number the frontend
  is about to issue. A cancelled job's last message is `{kind:'complete', cancelled:true}` on its
  own generation, which the frontend drops on the rule above.
- A Rust-owned `AppState.search_generation` counter is STRUCK; the field is the last-seen-generation
  record described here.

Dropping a `Vault` joins the watcher thread, and the watcher thread takes the vault write lock, so
"`*guard = None;` … never build-then-swap" is STRUCK and is a **deadlock**: take the `Vault` out
first, release the guard, then drop it.

### 4.4 Search policy (M29, M64)

| Rule | Verdict |
|---|---|
| "one per keystroke-debounce (250 ms), ≤ 50 results" | **STRUCK.** Normative: filenames at **0 ms** (they touch no disk), content at **90 ms**, `MAX_FILES = 200` groups, `MAX_TOTAL_MATCHES = 1,000`. |
| "results carry no content — return triples" | **STRUCK.** Normative: ≤2 snippets inline per group, the rest via `search_expand`. **All offsets are UTF-16 code units**, which is an acceptance criterion, not a preference. |
| "search postings 2 MB — a cap to design within" | **STRUCK.** There are no postings and no index. |
| "a filename/heading index in RAM plus a streaming content scan" | **STRUCK.** No index at all: measured, an index costs 13.6–46.3 MB and 190–500 ms of build. |
| a DOM gate of "≤ 400 nodes" for `idle` only | Per-scenario ceilings: **idle ≤ 400, search ≤ 800**. |

**Batching:** flush every **16 ms**, ≤8 groups or ≤6,000 serialised bytes per message, whichever
comes first, snippets truncated to 2. With `MAX_FILES = 200` the whole result set costs ~25
messages. `Complete` carries `order: Vec<u32>` and the frontend applies it with **one** DOM
reorder — do not build an insertion-sorted live list.

### 4.5 Search constants (normative)

Every constant below matches `core/src/search.rs` exactly.

```rust
const SEARCH_THREADS: usize         = 4;        // spawned per query, no pool
const MAX_TOKENS: usize             = 8;
const MAX_FILES: usize              = 200;
const MAX_TOTAL_MATCHES: usize      = 1_000;
const MAX_SNIPPETS_PER_FILE: usize  = 8;
const MAX_SNIPPETS_IPC: usize       = 2;
const MAX_RANGES_PER_LINE: usize    = 8;
const SNIPPET_WINDOW_CHARS: usize   = 260;
const CHUNK: usize                  = 32;
const HEAP_LIMIT_BYTES: usize       = 1 << 16;  // 64 KiB line buffer per Searcher
const REGEX_SIZE_LIMIT: usize       = 1 << 20;
const REGEX_DFA_SIZE_LIMIT: usize   = 1 << 20;
const BATCH_FLUSH_MS: u64           = 16;
const BATCH_MAX_GROUPS: usize       = 8;
const BATCH_MAX_BYTES: usize        = 6_000;
const MIN_CONTENT_QUERY_CHARS: usize= 2;
const FILENAME_DEBOUNCE_MS: u64     = 0;
const CONTENT_DEBOUNCE_MS: u64      = 90;
const MAX_SCAN_BYTES: u64           = 8 * 1024 * 1024;  // == MAX_NOTE_BYTES; larger => name-only
const RERUN_QUIET_MS: u64           = 400;      // after watcher quiet, silently re-run
const RERUN_MIN_INTERVAL_MS: u64    = 2_000;
```

The search panel **replaces** the file tree in the sidebar; the two do not stack. **`Mod-Shift-F`
is the only route in** (§0.6 E8 deleted the title-bar button). Row metrics are inherited from §5.2's
tree tokens by reference — the panel MUST consume `--tx0`, `--cx0`, `--gx0`, `--chev-w`,
`--row-indent`, `--row-h` and `--tree-fs`, never restate them, so the two views stay aligned when
toggled. Its group-header chevron is INTENDED to be the same 16px box at the same `--cx0` as a tree
row's — **and it is not, today: `src/styles/search.css` still masks it with the `--chev` token E98
deleted, so it paints as a solid 16px block. That is a code bug, not a rule; the box geometry above
is what it should consume.**

## 5. Visual tokens, box models, window geometry, chrome

Coordinate convention throughout: **content coords**, `content = screenshot − (0, 31)`. (The x
offset is 0, not 1: the reference's edge is a wash over content, not a frame — §0.22 E41.) A
screenshot value is written `sx`/`sy`.

### 5.1 `tokens.css` is the only declaration site (M32, M36)

Owner 01. **No other CSS file may declare a custom property.** The current values, read from
`tokens.css` (Obsidian 1.13.7 where tagged `[S]`):

| Concept | Token | Value |
|---|---|---|
| accent | `--accent` | `#8a5cf5` |
| sidebar ground | `--bg-secondary` | `#282828` |
| editor ground | `--bg-primary` | `#1c1c1c` |
| code-block fill | `--bg-primary-alt` | `#232323` |
| menu ground | `--bg-menu` | `#282828` |
| form field | `--bg-form-field` | `#2e2e2e` |
| row hover / row active | `--bg-modifier-hover`, `--bg-modifier-active` | `rgba(255,255,255,.067)` — **one value, declared as one** (§0.22 E44) |
| tree ink | `--text-muted` | `#b3b3b3` |
| caret | `--caret-color` | `#dadada` |
| selection | `--text-selection` | `color-mix(in oklch, var(--accent) 33%, transparent)` |
| search match | `--text-highlight` | `rgba(255,208,0,.28)` |
| error / destructive | `--text-error` | `#fb464c` |
| indent guide | `--indent-guide` | `rgba(255,255,255,.12)` |
| menu border | `--menu-border-color` | `var(--bg-modifier-border-hover)` = `#3f3f3f` (§0.27 E67) |
| menu shadow | `--menu-shadow` | `var(--shadow-s)`, three layers |
| the one popover shadow | `--shadow-popover` | `0 2px 8px rgba(0,0,0,.35)` — modal and delete dialog only |
| sidebar gutter | `--scrollbar-gutter-w` | `8px` |
| editor gutter | `--scrollbar-w-editor` | `12px` (§0.37 E84) |
| scrollbar thumb | `--scrollbar-thumb` | `#808080` on macOS, `rgba(255,255,255,.1)` on Linux |
| close-button hover | `--bg-close-hover` | `#fb464c` |

**The row hover and active values are the SAME, and that is Obsidian's own rule** (§0.22 E44):
Obsidian declares `--nav-item-background-active = var(--background-modifier-hover)`. The old `.15`
was Obsidian's LIGHT-theme hover.

**`--lh-code` is the integer `21px`, never `1.5` (X4).** `14 × 1.5` must not be re-derived at render
time and drift sub-pixel; the number is measured, so it is written as a number.

**Rule 5 — `*, *::before, *::after { transition: none !important; animation: none !important }` —
is upheld everywhere (M59) with THREE exemptions**, each Obsidian's own number and each carrying
`!important` because a stylesheet `!important` outranks a normal inline style: the Properties fold
slide, the fold arrow's rotation (§0.24.5 E53) and the tree chevron's 100ms turn (§0.44 E90). The
rule's original rationale was a WebKitGTK async-scrolling engine that was deleted, but whether a
blanket ban still earns its keep is a user ruling and it has not been taken. The task checkbox's
dead `box-shadow` transition is still dead and named (§0.24.5).

### 5.2 The file-tree box model (B9)

```css
:root{
  --row-h:      27px;             /* a DOM-shim FALLBACK — the live pitch is MEASURED at runtime
                                     by chrome.ts's applyRowH (§0.22 E44) */
  --row-indent: calc(16px + var(--hairline));  /* §0.49 E97: Obsidian's 12 + border 1 + padding 4,
                                     of which only the border term snaps */
  --chev-w:     16px;             /* a free parameter; 16 matches every other icon */
  --cx0:        16px;             /* §0.48 E96 */
  --gut:         4px;
  --tx0:        36px;             /* §0.48 E96 */
  --gx0:        24px;             /* §0.48 E96 */
  --tree-fs:    13px;
  --hairline:    1px;             /* written by chrome.ts as floor(dpr)/dpr (§0.48 E96) */
}
```

The row is ONE pooled element: one text node, the chevron as an inline `<svg class="chev">` child
(§0.50 E98 — it was a `::before` mask), the guides as a `repeating-linear-gradient` on the row
itself, and the active fill as an inset rounded rect on `.tr::before`:

- `padding-left: calc(var(--tx0) + var(--d) * var(--row-indent))`, so a file and a folder at the
  same depth share a text origin.
- guides: `background-size: max(0px, calc((var(--d) − 0.5) * var(--row-indent))) 100%`,
  `background-position: var(--gx0) 0`. The half-unit is what removes the boundary-column bleed
  (§0.48 E96); any edge strictly between stripes would do, and the half needs no reference to dpr.
- **EVERY folder draws a chevron, empty or not** (§0.17 E19): `.tr.d` is keyed off `kind` alone.
- **The active fill is Obsidian's inset rounded rect** (`--bg-modifier-active` on `.tr::before`,
  `border-radius: 4px`, `corner-shape: var(--tree-corner-shape)` platform-scoped, `bottom: 2px` so
  it stops short of the pitch without a margin) — §0.22 E44. While a shift-selection is live the
  active fill is WITHHELD everywhere and `.tr.s::before`'s selection tint is the only fill.
- `padding-right` is spelled in the same terms as the `::before` inset, so the two cannot drift.

**The sidebar scroller's gutter (X6).** `--scrollbar-gutter-w: 8px` applies to `.tree-scroller` and
`.search-scroller` — `overflow-y: scroll` plus `scrollbar-gutter: stable`, so the gutter is reserved
ALWAYS and row ellipsis does not move when the vault grows past one screen. The rule is declared
exactly once, in **`src/styles/tree.css`** (owner 01); `search.css` (owner 05) consumes it and MUST
NOT restate it.

Horizontal geometry as CSS edges: sidebar `[0, 412)`, scroller `[0, 409)` — **409, not 408** — rows
`[0, 401)`, gutter `[401, 409)`, sidebar padding-right `[409, 412)`. The tree and the search panel
share these numbers because they share the box (§4.5).

### 5.3 The code block and the editor surface (B8, M33, M34)

Ownership: `editor.css`, owner 03. The insets are **32px** (`--editor-inset-x` / `-y`, Obsidian's
`--file-margins-x/y`), the editor's reserved gutter is **12px** (§0.37 E84), and the line box is
**1432** = 1508 − 12 − 32 − 32. The body text origin is content x **444**; the code box's text
origin is `444 + 16`.

```css
.cm-scroller{
  padding: var(--editor-inset-y) var(--editor-inset-x) 0 var(--editor-inset-x);  /* 32px 32px 0 */
  overflow-y: scroll;             /* reserve the gutter ALWAYS — never auto */
  scrollbar-gutter: stable;
}
.cm-scroller::-webkit-scrollbar       { width: var(--scrollbar-w-editor) }   /* 12px */
.cm-scroller::-webkit-scrollbar-track { background: transparent }
.cm-scroller::-webkit-scrollbar-thumb { background: var(--scrollbar-thumb);
                                        border: 3px solid transparent; background-clip: padding-box }
.cm-content, .cm-line { padding: 0; margin: 0 }

/* one class on every line of the block, opening fence to closing fence INCLUSIVE */
.nc-cb{
  background-color: var(--bg-primary-alt);   /* #232323 */
  margin: 0;                                 /* NOT 0 -16px — a wider line box is a phantom scroll */
  padding: 0 16px;                           /* horizontal only; vertical is 0 */
  font-family: var(--font-mono);
  font-size:   var(--fs-code);               /* 14px */
  line-height: var(--lh-code);               /* 21px */
  color:       var(--text-normal);           /* #dadada — fences included */
  border: 0;
}
.nc-cb-first{ border-radius: var(--radius-s) var(--radius-s) 0 0 }   /* 4px */
.nc-cb-last { border-radius: 0 0 var(--radius-s) var(--radius-s) }
.nc-cb-only { border-radius: var(--radius-s) }
```

**The `::-webkit-scrollbar` selector MUST name `.cm-scroller`**, never an ancestor: a rule on the
ancestor does not reach CodeMirror's real scroller, which then inherits the **17px** legacy
scrollbar — and the pane is then measuring its own mistake.

**Fence lines are ordinary code lines** — same fill, same 14px mono, same 21px pitch, same
`--text-normal`, *inside* the tinted box. The only thing distinguishing them is the border radius,
because they happen to be first and last. Peak ink is 213 on the backticks, on the `sh` and on the
body alike. **No syntax highlighting anywhere in a code block** (§9 E4).

**The bottom of the scroller is padded with HALF the scroller's height**, recomputed as the editor
resizes (§0.43 E88) — not a static `30vh` in a stylesheet. That is what lets the last line scroll to
mid-pane.

**The gutter is reserved unconditionally.** Left to `overflow-y: auto`, the content column is one
width in a short note and another in a long one: body text re-wraps and the code box changes width
the moment a note grows past one screen.

### 5.4 Headings (M35)

Sizes and weights are declared in `tokens.css` (owner 01); the rules live in `editor.css` (owner 03).

| | size | weight | line-height | letter-spacing |
|---|---|---|---|---|
| H1 | `1.618em` = **25.888px** | **700** | 1.2 | −0.015em |
| H2 | `1.462em` = **23.392px** | **680** | 1.2 | −0.011em |
| H3 | `1.318em` = **21.088px** | **660** | 1.3 | −0.008em |
| H4 | `1.188em` = **19.008px** | **640** | 1.4 | −0.005em |
| H5 | `1.076em` = **17.216px** | **620** | 1.5 | −0.002em |
| H6 | `1em` = **16px** | **600** | 1.5 | 0em |

The `em` is deliberate and is the only form right at more than one base: the property is
unregistered, so it is substituted as a token stream and evaluated at the using element, whose parent
`.cm-content` is 16px. Registering it would freeze it at `body`'s base.

**A heading line takes `padding-top: var(--p-spacing)` = 16px** (§0.30 E73), and a heading exactly
ONE blank line below another takes NONE — the blank line is already a full line of space. **A heading
has NO space below it** (§0.30 E74): Obsidian's base is `.cm-line { padding: 0 }` and no rule adds a
`padding-bottom` to a heading, so the gap under one is the next line box touching. **PADDING, NEVER
MARGIN** — a margin on a `.cm-line` is invisible to CM6's height map and walks the caret away from
the pointer (§0.26 E62). `livepreview.ts` writes a shared `nc-h` beside `nc-hN` (Obsidian's own
`HyperMD-header`).

**Obsidian's rule 2 is NOT transcribed, and that is a known divergence** (KNOWN-ISSUES LP-18):
`padding-top: var(--p-spacing-empty)` (= 0) outranks the list padding on the first list line after a
heading in Obsidian, so that line is **25.19px** tall there and **26.38** in Cairn, and every line
below it sits **+1.19px** low. It needs a ruling or a fix.

#### 5.4.1 Heading markers — reveal on the caret line (X17)

Normative, owner 03:

1. Every ATX heading line carries a `Decoration.replace` over its marker run — the `#`×N **and the
   single following space** — so the text starts at the content inset like a body line.
2. A heading line **reveals** its marker when the primary selection **intersects that line**, as a
   `.nc-md-marker` mark at `--text-faint`, the heading's own size and weight, no background and no
   transition (§5.1 rule 5).
3. Reveal **occupies layout**: the text shifts right by the marker's advance while the caret is on
   it. Every measured heading band in the reference is a caret-elsewhere band, and the geometry
   fixture parks the caret in the body for that reason.
4. Only the marker run is affected; nothing else about the line changes on caret entry.
5. The full reveal rule is §5.4.4's — three scopes, focus-gated (§0.23 E47/E48).

#### 5.4.2 The inline title (X18)

**The note's filename is rendered as an inline title above the content, at the H1 tokens, and
clicking it renames the note.** It is a CodeMirror block widget decorated at document position 0
(`Decoration.widget({ block: true, side: -1 })`, class `.nc-title`) — **not part of the document**:
never in `state.doc`, never typed into, never saved, never sent to `write_note`.

**Exact vertical geometry**, content coords: editor pane top 40, `+ --editor-inset-y 32` →
`.nc-title` box top **72**; box `72 .. 103.0656` (`25.888 × --h1-lh 1.2`);
`+ --inline-title-space-after 12.944` → **first body line box top 116.0096** (§0.22.4 E42,
§0.24.5 E52). It consumes `--h1-size` 25.888px, `--h1-weight` 700, `--h1-lh` 1.2, `--h1-ls`
−0.015em and `--text-normal`. Horizontally it sits in the same line box as body text, origin
content x **444**.

**A document that genuinely begins with an H1** shows the title "Misc" from the *filename* and then
an H1 "Misc" below it, unchanged — nothing is hidden, stripped or promoted. Nothing edits the user's
bytes to make the screen tidier (§2.4). The geometry fixture's open note MUST NOT begin with a
heading, or the measured first-line band is an H1 box and the gate row is meaningless.

**Clicking it renames.** One click — not a double-click, and §0.17 E20: a click places the caret and
only a programmatic open selects all — swaps the widget's contents for an
`<input class="nc-title-edit">` of the same metrics, pre-filled with the basename without `.md`:

- keystrokes are filtered by the same `beforeinput` handler as the tree's rename editor (§7.3 case
  11); a rejected character never lands and the field flashes `.bad` in `--text-error`;
- `Enter` commits via `rename_entry(activePath, name + ".md")`; `Escape` cancels; blur commits;
- on success the frontend takes `RenameResult.path` and updates `activePath`, the tab label and the
  title from it;
- on `invalidName` / `alreadyExists` **the editor stays open** with the message inline;
- while the editor is open the buffer keeps autosaving to the *old* path; a rename never flushes and
  a flush never renames.

With no note open there is no title, and the widget is not created.

#### 5.4.3 — DELETED (the v2 cost model for a `@lezer/markdown` build that never shipped; live preview is §5.4.4).

#### 5.4.4 The construct set

`src/livepreview.ts` finds and decorates, and this is the whole list:

| | |
|---|---|
| block | ATX heading · fenced code block · thematic break · blockquote (nested) · bullet list · ordered list · table · `totp` block |
| inline | bold · italic · bold-italic · strikethrough · `==highlight==` · inline code · `[text](url)` · `<url>` autolink · `[[wikilink]]` · bare url · backslash escape · task checkbox · pasted image (`data:` URL) |

`![[embed]]`, `#tag`, `[^footnote]`, callouts, math, mermaid, non-pasted images and inline HTML are absent, each
because it needs something Cairn does not have — a resolver, a second renderer — not because the
shape cannot hold it. `docs/KNOWN-ISSUES.md` LP-2 is the live list.

**THE TOKENISER IS OBSIDIAN'S OWN**, transcribed from the CodeMirror 5 `markdown` stream mode and
its `hypermd` wrapper in `app.js` — **not `@lezer/markdown`**, which Obsidian never uses (§0.23.1
E46). Finding and decorating are separated by the `ConstructSource` / `buildDecorations` seam: a
`Construct` carries positions, a kind and marker `role`s, and no class, widget or hide flag.

**THE REVEAL RULE IS THREE RULES**, and flattening them to one is the most likely future regression:

| scope | applies to |
|---|---|
| **line** | heading, blockquote marker, backslash escape |
| **construct** | bold, italic, strikethrough, highlight, inline code, link |
| **marker** | list bullet, ordered marker, task box, thematic break |
| **never** | pasted image — Cairn `[C]`, not Obsidian: the paste leaves the caret touching the run, so the image renders from the keystroke until Backspace/Delete or the X takes it |

So a caret anywhere on a heading line reveals its `## ` but **not** the bold on the same line, and
only a caret exactly on a bullet turns the dot back into a `-`. **AND THE REVEAL IS GATED ON
FOCUS**: `hasFocus ? selection.ranges : []` — an unfocused editor reveals nothing whatever the
selection says, which is what makes a note render clean while the file tree has the focus (§0.23.3
E48).

**Two deviations remain named**: list depth is not tracked, because `.cm-list-1/2/3` style nothing in
Obsidian's own theme; and the `<hr>` widget is inline rather than block, because CM6 refuses block
decorations from a `ViewPlugin`.

#### 5.4.5 YAML frontmatter and the Properties block

**NORMATIVE.** A note whose **first line is exactly `---`**, with a later line that is **exactly
`---`**, has frontmatter. Nothing between those two lines is markdown: the scanner reports no
construct there, so the delimiters are not thematic breaks and the body is not tokenised. `--- `,
`----` and ` ---` are not frontmatter.

1. **Frontmatter that PARSES is replaced** by one `Decoration.replace({ block: true, widget })` over
   `[0, end]`, from a `StateField` — `block: true` may not come from a `ViewPlugin`. The widget is
   the **Properties block**: a fold heading, then one row per key in the file's own order, each row
   an icon, the key and the value.
2. **Frontmatter that does NOT parse is NOT hidden.** It stays in the document, marked
   `nc-fm-invalid`. This is Obsidian's own rule and it is the important one: a note whose
   frontmatter you cannot see is worse than one that shows it broken.
3. **The parser bails rather than guesses.** Its subset and its ten refusals are §0.24.2's list
   (block scalars, anchors, aliases, tags, flow maps, tabs, 2-level maps, sequences of maps, nested
   flow, non-key lines); a refusal is case 2.
4. **The type of a value is INFERRED, per note.** `inferType(key, null)` returns `text`, not
   `unknown`: Obsidian never reaches its `unknown` branch for a real empty property because its
   `metadataTypeManager` remembers a type per key vault-wide, and Cairn has no such cache — so a
   literal transcription would make every empty `key:` both orange and uneditable. The rest of
   Obsidian's table and inference is transcribed, with `aliases`, `tags` and `cssclasses` fixed by
   key. A known difference, not a defect to be found later.
5. **The block EDITS, and every write is ONE LINE and never a re-serialisation.** Rename replaces
   the KEY TEXT only (so a sequence under the key is not orphaned), set replaces what follows the
   colon on that one line, add inserts one line before the closing `---`. The tests assert the WHOLE
   DOCUMENT after each edit. Absent and named: DELETE, list editing (a one-line write cannot reach a
   block value), the type picker, drag reorder and vault-wide name autocomplete.
6. **The selection is kept out of the hidden run** by a `transactionFilter`, because a caret inside
   a block replacement is invisible.
7. **THE FOLD IS ANIMATED, AND ITS NUMBERS ARE OBSIDIAN'S**: 100ms on
   `cubic-bezier(.02, .01, .47, 1)` over the non-zero px lengths among `height`, `padding-top`,
   `padding-bottom`, `margin-top` and `margin-bottom`, with `overflow-y: clip` for the duration.
   Collapse animates to 0 and THEN hides; expand shows first and animates from 0. It lives on a
   `.metadata-content` wrapper and takes an inline `!important` to survive §5.1 rule 5's blanket.
8. **The heading toggles on `click`, not `mousedown`** (app.js), so a press the user drags away from
   does not fold it, and the caret is never placed into the editor behind the block.

### 5.5 Window geometry

- **The gate window is 1920 × 964**, entered only via `--pixeltest` (§0.22 E41). It is a GATE size,
  not a default: nothing else in the app hardcodes it. If the gate window cannot be created at that
  size, the probe's first row fails with the actual size — a clamped window silently producing green
  geometry rows is the worst outcome.
- **A normal launch opens at 1000 × 700 and is then MAXIMIZED** (user ruling, §0.26 E65), never
  under `--pixeltest` (G9 asserts `inner=1920x964`) and never headless. The 1000 × 700 is the
  RESTORE size; window size and position persist in global state and are clamped to the current work
  area on restore. **No minimum size is set.**
- **The sidebar does not scale; it RESIZES by drag** (§0.7 E9). Its default is 412px, and the drag
  sets `--sidebar-w` and persists it globally.

### 5.6 macOS chrome (B10, M42)

The window is built **`frame: false` + `titleBarStyle: 'hidden'` +
`trafficLightPosition: { x: 19, y: 12 }`** — the values read out of Obsidian's own `main.js`
(§0.17 E21, `electron-shell/app-main.mjs`). **`--macos-tl-inset: 88px`** on macOS reserves the
traffic-light strip; it is **8px on Linux** (§0.5 E7), where the cluster is Cairn's own. Only in
FULLSCREEN do the traffic lights leave the strip, which renders a 74px hole at its left; fullscreen
is not in the feature list, but ⌃⌘F and the green button still reach it — accepted, §9 E4. The tao-fitted
`20 / 17.5` and the `decorations` / `hiddenTitle` Tauri-era requirements do not apply to this
shell.

### 5.7 The drag region

`.titlebar` carries **`-webkit-app-region: drag`**, and every interactive descendant takes
**`no-drag`**, in `electron-shell/app-chrome.css`. That is Electron's own mechanism: the OS
hit-tests the region itself, so unlike the attribute it replaced it does not depend on which element the
pointer happens to hit. **`no-drag` must cover the tab, the window controls and every button**, or a
click that should reach the app starts a window drag instead. The `data-tauri-drag-region`
attributes still present in `src/index.html` are inert metadata and carry no behaviour.

### §5.8 — DELETED (Tauri/tao/GTK Linux chrome design notes; the live rule is the 39px strip and its right-flush control cluster — §0.5 E7, §9 E7).

### §5.9 — DELETED (the nav toolbar and the reference measurements taken from it; the element is gone — §0.12 E14).

### 5.10 The vault bar (R2, resolved)

The bar is **43px border-box**: a 1px `border-top` rule at content **y 921**, 8px padding, a 26px
content row and 8px padding, so its bottom is flush with 964. **`box-sizing: border-box` is
normative** — with content-box, `height` plus the border makes the sidebar column sum past the
window. Ground `--bg-secondary`; the rule is `--bg-modifier-border` `#333333`.

The 16px chevron box sits at content x **16..32** (8px bar padding + 8px switcher padding), and the
label box's left is **40** (8 + 8 + 16 + 8, Obsidian's `--size-4-2` gap). **The measured ink band's
vertical position is NOT asserted**: no model derives its centre, and it is dropped from the gate
rather than encoded as a number nobody can derive. R1 (the code box's right inset) and R3
(WebKitGTK's thumb behaviour) are deleted with the engines and derivations they were about.

### 5.11 The verification harness — `tools/verify-geometry.js`

**G9 is `report.ok`, and `ok` is `fail === 0 && skip === 0`.** A SKIP fails the run by default — a
green run that measured nothing is worse than a red one — and the report's skip field is **`skip`**
(singular). `pass`, `fail`, `skip`, `rowsSkipped`, `rows`, `checks`, `dpr`, `inner`, `gate` and
`results` are reported for humans and read by no gate. **No row or check count appears in this
section deliberately**: the counts rise on every pass that adds a row, and the count is not a gate.

The probe reads box edges and computed styles in CSS px and **never measures raster or glyph ink**.
**Nothing in it consults `devicePixelRatio` to decide an expected value** — `dpr` is REPORTED, and
`tests/frontend/geometry-probe.test.mjs` allows the token on exactly two lines of the file after
stripping comments. A check records which of three rules admitted it: **`exact`**
(`|got − want| ≤ EPS`), **`snap`** (`got` is `want` snapped to the device grid, within EPS) and
**`device-px`** (`≤ 1 device px + EPS`, fractional scales only, and counted). At an integer scale
`snap` degenerates to `exact` and `device-px` is unreachable (§0.19.2 E27). The report carries
`dpr`, `tolerance`, `integerScale` and `viaDevicePx`, so a green run at a fractional scale can never
be quoted as a green run at 1.

**How a run is launched on this shell.** `./tools/run-g9-electron.sh` builds the addon and the
bundle and starts the shell with `CAIRN_PIXELTEST=1`; the shell seeds a hermetic temp `userData` and
a fixture vault, forces the window to **1920 × 964** (the gate size, not the app's default — §5.5),
does NOT maximize it, runs the probe in gate mode and prints the report as one JSON line, exiting 0
iff `ok`. **The persisted sidebar width is NEVER injected under `--pixeltest`** (§0.7 E9), because
every x the gate asserts is a function of `--sidebar-w`.

**Fixture required:** a folder at depth 0 expanded; a folder AND a file both visible at depth 1; a
folder at depth 2; a file at depth 3; the open note containing a fenced `sh` block of at least 3
lines, long enough to overflow vertically so the scrollbar gutter is real; its **first line is body
text, never a heading**, with at least one `## ` heading below the fold; and it trips **neither
§3.3 cap** and has a healthy watcher. The caret is parked in the BODY before the probe runs.

**The caret hook (Y2).** `heading.marker.shown` asserts the marker *revealed*, which §5.4.1 makes
conditional on the caret being on that heading line — and the fixture parks the caret in the body.
So the probe produces the state itself, through ONE harness-only seam:
**`window.__PIXELTEST_CARET__('body' | 'heading'): boolean`** (owner 03, installed only when the
probe is), which dispatches a selection onto the first body line or the first `## ` line and returns
`false` if there is none. **Order is normative:** every other row is measured in the `body` state;
then `('heading')`, and `heading.marker.shown` alone is measured; then back to `('body')` before the
run ends, so a session cannot leave the app in a state no other row was written against. **If the
hook is missing or returns `false`, the row FAILS** — it never SKIPs.

**The row values that matter** (the full table lives in the file):

| Row | Asserts |
|---|---|
| `title` | `.nc-title` box top **72**, height **31.0656**, computed `font-size` **25.888px**, weight 700, `margin-bottom` **12.944px**, left edge **444**; `.cm-content`'s first line box top **116.0096** |
| `heading.marker.hidden` | with the caret in the body: zero `.nc-md-marker` in the viewport, and the heading line's text box left equals a body line's |
| `heading.marker.shown` | with the caret on that heading line: exactly one `.nc-md-marker`, `color: rgb(102,102,102)` (`--text-faint`), and the line's text box left GREATER than a body line's (the shift is by design; its magnitude is font-dependent and is not asserted) |
| `sidebar.gutter` | `.tree-scroller` computed `overflow-y: scroll`; gutter width **8**; scroller border box right edge **409** |
| `banner.absent` | zero `.cap-banner` elements, **zero `.watch-degraded` elements**, `.tree-scroller` height **881** |
| `vault.bar` | box `y 921`, height **43**, `border-top: 1px`, rule `rgb(51,51,51)`, chevron box `x 16..32`, label box left **40** |
| `layers.scrollers` | §5.12.4's rendered-box rule: exactly two RENDERED scrollable boxes, and `document.scrollingElement.scrollHeight === clientHeight` |

**`verify()` re-seats `K.hairline`, `K.step` and `K.rowH` from the page's own computed values before
the table is built** (§0.49 E97), and one row asserts `step == 16 + a snapped border` as a
**BOOLEAN**, which takes no numeric tolerance: the magnitude rows cannot separate a flat `17px` from
`16 + 0.8` at any depth the gate probes, and a mutation test proved it. A row also ties `--hairline`
to the USED `border-bottom-width` of `.titlebar` — a real 1px border in the same document —
because comparing it to a constant would only compare Cairn to Cairn (§0.37 E84's trap).

#### 5.11.1 Harness-only surfaces, ruled

- **`CAIRN_ELECTRON_GEOM` overrides the window size for a development run**, and
  **`CAIRN_PIXELTEST_GATE=0`** (what `./tools/run-g9-electron.sh --small` sets) turns gate mode off
  entirely. Neither is a gate path: a gate run is a plain `--pixeltest` run at 1920 × 964 with
  neither set, and a report from one is never quoted as a verdict — `gate` in the report is what
  keeps that distinction alive. A malformed value is IGNORED, not defaulted — silently substituting
  a geometry is how a measurement ends up describing a window nobody opened.
- **The capture seams** are `CAIRN_CAPTURE`, `CAIRN_CAPTURE_DPR`, `CAIRN_CAPTURE_EVAL` and
  `CAIRN_CAPTURE_CLICK` (one real `mousedown` before a capture, so an interactive state can be
  photographed at all); `tools/capture-app.mjs` drives any Electron app over CDP.
- **The `bench-mark` event has no consumer on this shell** — its only reader was the retired memory
  harness — and is treated as dead code (§1.4).
- **Window etiquette is void.** Launching a window is allowed; the only validity rule left is that a
  LOCKED SCREEN invalidates graphics and memory numbers: **refuse the run, do not disable the
  check.**

### 5.12 The layer architecture — what survives (E3)

The WebKit flag architecture this section ruled (`AsyncOverflowScrollingEnabled = NO`, set through
private SPI) was deleted with the Tauri/WebKit engine (§0.20.6 E35). **Three rules survive**, and
they survive because they are about the DOM and the layout rather than about the engine:
**§5.12.4** (exactly two rendered scrollers), **§5.12.5** (the main frame never scrolls) and
**§5.12.6** (the scroll-critical-path obligations). The rest — the flag route, its promotion rules,
the fallback and the memory numbers — is deleted below.

#### §5.12.1 — DELETED (the flag route; the WebKit preference was deleted with the engine).

#### §5.12.2 — DELETED (the WebKit compositing-promotion sweep; the engine is gone).

#### §5.12.3 — DELETED (`webkit_flags.rs` and the private SPI; deleted with the engine).

#### 5.12.4 The DOM and CSS that result

The whole document has **exactly two RENDERED scrollable boxes**, and the main frame is not one of
them:

```
html, body                               overflow: hidden; height: 100%      (§5.12.5 — normative)
  .sidebar                412px
    .vault-lost / .watch-degraded / .cap-banner*   siblings of the scroller, never inside it
    .tree-scroller | .search-scroller     overflow-y: scroll; scrollbar-gutter: stable   §5.2, §4.5
      .sz                                 the sizer; rows absolutely positioned inside it
  .editor
    .cm-scroller                          overflow-y: scroll; scrollbar-gutter: stable   §5.3
      .cm-content / .cm-line
```

`.tree-scroller` and `.search-scroller` are never live at the same time — the search panel REPLACES
the tree (§4.5) — so the ceiling is two scrollers, not three.

1. **§5.2's scroller block and §5.3's `.cm-scroller` block stand exactly as written.** The 8px
   sidebar gutter, the 12px editor gutter, the 401px row width and the 1432px line box are not
   amended by anything here.
2. **The `::-webkit-scrollbar` rules must be on `.cm-scroller`**, never on an ancestor: a rule on
   the ancestor does not reach CodeMirror's real scroller, which then inherits the **17px** legacy
   scrollbar and measures its own mistake.
3. **No third scroller, ever.** Menus, popovers, the tab strip, the vault bar and all three banners
   must **fit or clip** — single-line with `text-overflow: ellipsis`, or `overflow: hidden`, never a
   scrollbar. **"Scroller" here means a RENDERED box, and that qualifier is normative (Z6):** an
   element inside a `display: none` subtree generates no box, so it cannot scroll and cannot cost
   anything — but `getComputedStyle()` still returns its `overflow-y` as `auto`. **Computed style
   alone therefore over-counts, and it over-counts the shipping app**, whose sidebar holds both
   `.tree-scroller` and `.search-scroller` in the DOM with exactly one of them rendered. The test is
   `SCROLLABLE.test(cs.overflowX) || SCROLLABLE.test(cs.overflowY)` **AND**
   `el.getClientRects().length > 0`. **The ceiling is on rendered scrollable boxes, not on
   overflowing ones**: a third rendered scroller whose content happens to fit today still fails the
   row, because it is one note away from overflowing.

#### 5.12.5 The main frame must never scroll

Normative: **`html, body { overflow: hidden; height: 100% }`**, and no layout may make the document
scrollable. It is also what keeps the two panes independently scrollable: with `.cm-scroller`
unbounded, paging the editor moves `window.scrollY` and the document becomes the scroller.

#### 5.12.6 What each owner does differently

**Owner 04 — the tree virtualiser.** No structural change: the tree stays a real
`overflow-y: scroll` scroller with §5.2's box model, and its `scroll` handler is on the critical path
of every frame of every scroll. It MUST:

- **(a)** read `scrollTop` and nothing else — no `getBoundingClientRect`, `offsetHeight` or
  `clientHeight` inside the handler, because a layout-forcing read there costs a frame;
- **(b)** write only `transform: translateY()` and text on pooled rows;
- **(c)** never allocate a row during a scroll — the pool is sized once from live `clientHeight`
  (§3.3) and re-sized only on a resize or a banner appearing;
- **(d)** hold a budget of **≤ 2 ms per scroll event at the 50,000-node cap**, measured by
  `tools/scroll-bench.mjs` from the compositor's own trace events.

**Owner 03 — the editor.** No structural change; `.cm-scroller` stays a real scroller, so CM6's
`scrollIntoView`, viewport virtualisation, selection autoscroll, keyboard paging and smooth-scroll
easing are the platform's and are untouched. Two obligations: put `::-webkit-scrollbar` on
`.cm-scroller` (§5.12.4.2); and treat every synchronous main-thread task as a scrolling cost —
decoration rebuilds, the caret-line marker reveal and the autosave serialise must not run
synchronously on a frame in which a scroll is in flight.

**Owner 01 — chrome.** §5.12.4.3's no-third-scroller rule applies to the vault bar and to all three
banners — §7.3 case 8's `.vault-lost`, §7.3 case 16's `.watch-degraded` and §3.3's `.cap-banner`.
Nothing else changes.

#### §5.12.7 — DELETED (the JS-scroller fallback; the engine that needed it is gone).

#### §5.12.8 — DELETED (the WebKit memory numbers).

#### §5.12.9 — DELETED (the two unverified lists).

## 6. One configuration, one manifest, one build

### 6.1 The no-innerHTML rule

**No `innerHTML` assignment anywhere except from `icons.ts` string literals, and note content never
reaches the DOM as markup.** That is the app's one historical sink, the rule that keeps it closed,
and the whole of what §6.1 still rules.

**The Electron shell ships NO Content-Security-Policy at all** — there is no CSP meta tag and no
session header in `src/` or `electron-shell/`. The Tauri CSP string and its
`dangerousDisableAssetCspModification` workaround are deleted with that engine, and gate G-CSP has
no subject on this shell. **Whether Electron should get a CSP is an open question for the
user/security team, not something to invent here.**

#### §6.1.1 — DELETED (the Tauri CSP/nonce machinery; this shell ships no CSP — §6.1).

### 6.2 `Cargo.toml` and `[profile.release]`

Two manifests, one workspace: **`core/Cargo.toml`** (the core) and **`core/napi/Cargo.toml`** (the
addon), with `default-members = ["."]` so a bare `cargo test` in `core/` is the core's own suite.
The core's `crate-type` is **`rlib` only** — Tauri's `staticlib`/`cdylib` mobile targets are gone —
and the addon owns the `cdylib`.

**`core/Cargo.toml`:** `tokio` (**direct**, X8: the runtime is
`new_multi_thread().worker_threads(2).max_blocking_threads(6)`, and the blocking count is
load-bearing — the search coordinator holds one slot for a whole search; a transitive dependency
cannot be configured), `serde` + `serde_json`, `notify` (`macos_fsevent`), `trash` (default features
KEPT: `chrono` writes `.trashinfo`'s `DeletionDate`, without which Linux file managers cannot
restore), `rfd` (`xdg-portal` — **unreachable from the Electron shell**, where `pick_vault` is
Electron's own dialog, so it is currently dead), `percent-encoding` (the `x-path` decoding that no
longer exists — likely dead), `libc` (unconditional; `malloc_trim` is cfg'd at the call site),
`memchr`, `grep-searcher` / `grep-regex` / `grep-matcher`. **No `tauri`, no `objc2*`, no
`webkit_flags.rs`** (deleted with the engine), **no `nucleo-matcher`** (§0.33 E79).

**`core/napi/Cargo.toml`:** `cairn` with `default-features = false` (so `cargo tree -p cairn-napi`
contains no `tauri` at any depth), `napi = { version = "3", features = ["napi9", "serde-json",
"async"] }`, `napi-derive = 3`, `serde` / `serde_json`, `tokio`; build-dependency `napi-build = 2`.
**`napi9` rather than `napi10`**: Electron 39 reports Node-API 10 and node 24 reports 10, so 9 is a
strict subset both satisfy. The crate declares **no wire type** — every shape is
`serde_json::to_value` over the structs §1.1's casing rule annotates, so a second schema cannot
drift — and `async` is what turns an `async fn` into a JS Promise, with `module_init` handing napi
THIS crate's runtime so there is exactly one in the process.

`[profile.release]`: `opt-level = "s"` (decided by G4, the search budget, not by memory; `memchr` is
pinned at 3), `lto = "fat"`, `codegen-units = 1`, **`panic = "unwind"` (NOT `abort`)**, `strip =
"symbols"`, `incremental = false`, `overflow-checks = false`, `debug = false`.

**Why `unwind`, and it is a data-loss argument rather than a memory one.** Unwind tables are
demand-paged and cost `phys_footprint` nothing unless a panic actually unwinds. With `unwind`, a
panic inside a command kills that one task, the promise rejects, the window stays up, and the user's
unsaved text — which lives in the webview — is still there and still savable. With `abort`, one bad
index or one poisoned lock destroys the whole dirty CodeMirror buffer, and `cargo test --release`
becomes impossible. The obligation is enforced, not hoped for:
`#![deny(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]` in `fsops.rs`,
`tree.rs`, `scan.rs`, `watcher.rs`, `search.rs` and `prefs.rs`, with `#[allow]` on the handful of
provably-infallible sites. **Gate G7.**

### 6.3 The frontend build (M22, M23)

One builder: **`electron-shell/build-app.mjs`**, owner 07.

| Decision | Ruling |
|---|---|
| bundler | **esbuild 0.28.2** directly. No Vite, no Rollup, no PostCSS, no framework. |
| output format | **`iife`**, one `app.js` + a plain `<script>` |
| target | **`chrome142`** — the pinned Electron's Chrome, which is also the build being cloned |
| CSS | esbuild the CSS in **`CSS_ORDER`** (`tokens.css, base.css, chrome.css, tree.css, editor.css, search.css, memoir.css`) and **string-substitute it into the page as a `<style>` block**; `electron-shell/app-chrome.css` carries the Electron-only chrome rules (the drag region, §5.7) |
| size gates | **BOTH RETIRED** — CSS by §0.19 E26, JS by §0.47 E95. `build-app.mjs` still PRINTS `js=` and `css=`; neither fails the build |
| pins | `electron` 39.8.3, `esbuild` 0.28.2, `typescript` 5.9.3; `@codemirror/state` 6.7.2, `@codemirror/view` 6.43.10, `@codemirror/commands` 6.11.0 |

**M23 is a SOURCE RULE, restated:** no file in `src/` may import from `@codemirror/language`,
`@lezer/common` or `@lezer/highlight`, and none does. They are in the bundle transitively through
`@codemirror/commands` — ≈39.5 KB of parser and highlighting machinery, unavoidable because
`history`, `historyKeymap` and `standardKeymap` sit in the same module as the syntax-aware commands
— and that is a measured fact about the bundle, not a licence to import them.

`@codemirror/commands` is kept: it is ⌘Z. Dropping it is not on the table.

#### §6.3.1 — DELETED (the JS size gate `360,000 = 340,876 + 19,124`; RETIRED by §0.47 E95. The measured ~15 B of `phys_footprint` per byte of minified JS stands; do not restore the number).

### 6.4 The file table

Owners: **01** chrome and tokens, **02** the core's own modules and the IPC seam, **03** the editor
and its widgets, **04** the tree, **05** search, **06** the measurement tools, **07** the shell,
build and packaging.

```
src/ipc.ts               02  the ONLY module that talks to the core (§1.1)
src/note_frame.js        02  §2's decoder — THE ONLY JS COPY OF THE FRAME
src/modal.ts             01  openModal() — THE ONLY MODAL IN THE APP (§1.6.1)
src/chrome.ts            01  the title bar, the vault bar, all three banners, the probe kick-off
src/tabstrip.ts          03  the two fixed tabs (§7.4)
src/tree.ts              04  the virtualiser
src/editor.ts            03  CM6, autosave, the flush paths
src/livepreview.ts       03  the construct scanner and its decorations (§5.4.4)
src/properties.ts        03  the Properties block (§5.4.5)
src/tables.ts            03  the table widget
src/totp.ts              03  the totp block (§0.46)
src/secrets.ts           03  secret notes
src/memoir.ts            03  the Memoir tab
src/menu.ts              01  the one menu primitive
src/vaultbar.ts          01  the switcher and its recents popover
src/search.ts            05  the search panel
src/inline-edit.ts       04  the shared inline editor
src/state.ts             02  the frontend's state.json mirror
src/icons.ts             --  the inline SVG literals; the ONE innerHTML-adjacent sink (§6.1)
src/styles/tokens.css    01  the only declaration site (§5.1)
src/styles/tree.css      01  declares the grouped .tree-scroller/.search-scroller rule; search.css consumes it
src/styles/*             05  search.css; the rest are 01/03/04 by module
core/src/*               02  fsops, tree, scan, watcher, search, prefs, note_frame, error, app
core/napi/src/lib.rs     07  the binding layer — no logic, no wire types (§6.2)
core/tests/*             02  vault_ops, dataloss, path_safety, search_int, frame_fixtures, …
electron-shell/app-main.mjs   07  the shell: window, IPC bridge, capture probes
electron-shell/preload.cjs    07  the page bridge
electron-shell/native.mjs     07  the addon loader and the value envelope
electron-shell/build-app.mjs  07  the frontend build (§6.3)
electron-shell/build-native.mjs 07  core/cairn.node, release by default
electron-shell/app-chrome.css 07  the drag region (§5.7)
electron-shell/*.test.mjs     07  native, close-handshake, lifecycle, window-control, menu,
                                  live-preview, indent, pane-paint, fold, empty-pane, totp,
                                  sync-client, package, shipped-binary
tools/verify-geometry.js      01  the G9 probe (§5.11)
tools/scroll-bench.mjs        06  the scroll bench (§5.12.6(d))
tools/package-electron.mjs    07  the .deb / macOS package, no electron-builder
tools/sign-macos.sh           07  the four-step ad-hoc signing order
tools/obsidian-live.mjs       06  the live-Obsidian instrument (§0.41)
THIRD-PARTY-NOTICES.md        07  dependency notices
```

`tools/measure-memory.sh`, `tools/gen-vault.sh` and their harnesses belong to the retired memory
position and are not current tools. `path.rs` performs **no Unicode normalisation** — recorded as a
limitation, not an oversight.

**Signing (NORMATIVE, and the permanent answer).** `codesign -s -` is the FINAL signature, not a
stopgap: Cairn is never publicly distributed, so there is no Apple Developer account, no Developer ID, no
`notarytool` and no stapling — deleted, not deferred. What the packager emits is only
*linker*-signed and fails `codesign --verify --strict`; `hardenedRuntime` is inert without
`tools/sign-macos.sh`, and **`tools/cairn.entitlements` is what lets the signed app launch at all**
(§0.22.1 E39). **The order is the correction:** sign the `.app`, build the `.dmg` from the SIGNED
`.app`, sign the `.dmg`, then verify BOTH — including the `.app` INSIDE the `.dmg`, because a
linker-signed CodeDirectory inside the `.dmg` is a release blocker and verifying the `.app` on disk
does not see it. A locally built app carries no `com.apple.quarantine` xattr, so it launches with no
Gatekeeper dialog; `spctl`'s `rejected` verdict is expected forever. **The build is not
reproducible** — the ad-hoc designated requirement is a bare `cdhash` — so every rebuild is a new
code identity and **TCC Files-and-Folders grants are re-prompted after every rebuild**: a permanent,
accepted property of the app, not a defect awaiting a certificate. **Packaging ships through the
private 1.0.0 release** (`.github/workflows/release.yml`, manual dispatch from latest main);
day-to-day dev still runs from the checkout with `npm run electron:app`.

### 6.5 Acceptance gates (consolidated)

**Every gate is the median of 5 runs with run 1 discarded**, at a 20 s footprint settle where memory
is involved. The noise floors that set the margins: `phys_footprint` **±1.5 MB** (a real 0.44 MB
arena showed up as a **−0.26 MB** process delta) and wall-clock timings **up to ±17% run to run**.

| # | Gate | Threshold |
|---|---|---|
| G1 | `size_of::<Node>() == 24` | compile-time assert |
| G2 | Arena, 5,000-note fixture | ≤ 768 KiB (**measured 448 KiB**) |
| G3 | Cold walk of the fixture | ≤ 50 ms (**measured 40 ms**) |
| G4 | Full-text scan, 4 threads, 10 MB corpus | ≤ 65 ms (**median measured 48.9 ms**); the gate corpus is the 10 MB one, the 25 MB one is informational |
| G7 | No `unwrap` / `expect` / `indexing_slicing` in the six modules named in §6.2 | 0 |
| G8 | The vault is written to only for notes | 0 stray files (§7.3 case 1) |
| G9 | `./tools/run-g9-electron.sh` → `report.ok` | **0 failures, 0 skips**, both folded into `ok` (§5.11); evaluated only on a plain `--pixeltest` run at 1920 × 964, and quote it with its dpr |
| G-RT | The §2.4 round-trip invariant, all 7 cases | byte-identical |

**`cargo clippy --all-targets -- -D warnings` is clean.** It carried two rustc-1.95 lints until
2026-09-23 (an `int_plus_one` in `core/tests/frame_fixtures.rs` and an orphaned doc comment in
`core/src/prefs.rs`); both are fixed and all three invocations (`--lib`, `-p cairn-napi`,
`--all-targets`) are quoted green.

**Deleted gates, listed once so the numbers are not reassembled:** G5a / G5a′ / G5b / G5c / G5d /
G5e (the memory position and the WebKit compositing census — G5a retired by user ruling, the rest
deleted or unevaluable with the engine), both build-size gates (§0.19 E26, §0.47 E95), G-CSP (this
shell has no CSP, §6.1) and G6 (cold start, measured on Tauri and **never re-measured on Electron**,
so it is not enforced). **G10** — pixel-identity against a live Obsidian — was removed with its
tooling. **G9 is not macOS-only any more**: it runs on Debian and on macOS.

## 7. Data-loss rules

### 7.1 The three structural rules everything below rests on

1. **`write_note` never creates a file unless explicitly told to.** `create` is `false` on every
   autosave, every idle flush, every blur flush and every close flush. It is `true` in exactly
   **one** place in the whole app: the **`[ Save as… ]` button on §7.3 case 5's bar**. (X16.)
   With `create: false`, a missing destination is `NotFound`, not a create. With `create: true`, an
   **existing** destination is `AlreadyExists`, not an overwrite (step 1c) — so neither value can
   silently destroy a file. This is what makes B17's resurrection bug impossible **by
   construction**: a missing file must not pass the conflict check only to be recreated by the
   rename in step 8.
2. **The atomic write sequence is fixed:**
   ```
   1  conflict check: if baseMtimeMs is present and disk mtime != it -> Conflict{diskMtimeMs}
   1b if create == false and the destination does not exist         -> NotFound       [B17]
   1c if create == true  and the destination DOES exist             -> AlreadyExists  [X16]
   2  denormalise(text, flags) in RUST                                              [M51]
   3  tmp = dir/".<name>.tmp-<pid>-<counter>"      (leading '.', same directory)
      — the ONE temp-name helper; every temp file in the app comes from it, §7.3 cases 1 and 10
   4  OpenOptions: write, create_new, mode 0o600
   5  write_all
   6  file.sync_data()
   7  restore the destination's prior mode if it existed, else a flat 0o644
   8  drop(file); fs::rename(tmp, abs)
   8b #[cfg(linux)] File::open(parent_dir)?.sync_all()                              [M66]
   9  metadata(abs) -> mtimeMs, len
   10 record the SelfWrite fingerprint BEFORE returning                              [§3.5]
   11 on any error after step 4: let _ = fs::remove_file(&tmp)
   ```
   `baseMtimeMs` is `number | null` on the wire and the guarantees are carried by the argument
   TYPES, not by headers: `Either<f64, Null>` refuses `undefined`, which is what a dropped field
   arrives as. Rust exposes no umask getter and `libc::umask` is destructive, so step 7 uses a flat
   `0o644` — what most editors do. Step 8b closes M66: without it the `sync_data` in step 6 is half
   a durability guarantee, because on ext4 the rename is durable only when the journal commits.
3. **Nothing is ever silently overwritten and nothing is ever silently discarded.** Every path below
   resolves to one of: write, refuse-and-tell, or prompt. There is no fourth outcome.

### 7.2 Autosave contract (normative, frontend obligation)

800 ms of typing idle, **or** 5 s since the first unsaved keystroke, whichever comes first; and
unconditionally on note switch, window blur, `visibilitychange` to hidden, and the close handshake.
`Mod-s` flushes and returns `true` to suppress the engine's own save dialog. The core does no
autosave timing and holds no dirty buffer. Maximum loss on a hard power cut: **800 ms
idle-triggered, 5 s under sustained typing.** There is deliberately no journal or WAL.

On `VaultError::Conflict` the buffer stays dirty, **autosave stops for that note**, and a
non-blocking bar offers *Keep mine* (re-write with `baseMtimeMs: null`) or *Reload from disk*.

### 7.3 The enumerated paths

Each row states the **invariant** and the **test that proves it**. Every test listed is mandatory.

**1 — Killed mid-save.**
*Invariant:* the note on disk is always either the complete old content or the complete new content,
never truncated, never torn, never a temp file left behind. *Mechanism:* temp + `sync_data` + rename
in the same directory, so the rename is atomic with respect to readers **and** to power loss.
*Test:* write in a loop while `SIGKILL`ing the process; after each kill assert the file hashes to
either the old or the new content, and that the next vault open leaves **zero** `.tmp-` files.
*Temp sweep, amended (M67):* the sweep unlinks a candidate on sight when the PID embedded in its
name is not a live process (`kill(pid, 0)` → `ESRCH`); the one-hour mtime rule applies only to temps
whose PID **is** live (another instance may be mid-write). The hour-only rule is STRUCK, because
crash debris created minutes before the next launch survived it — and in a synced vault it would
already have been replicated to every other device.

**2 — Quit / window close with a dirty buffer.**
*Invariant:* no quit discards unsaved text without either writing it or telling the user exactly what
would be lost. *Mechanism:* §1.6's handshake. A **rejecting** flush cancels the close and shows the
modal; only a flush that has not returned after 2,000 ms falls through to the watchdog, and that path
logs what it discarded. *Test:* (a) type, ⌘Q, assert the file contains the typed text before the
process exits; (b) make the destination unwritable (`chmod 000` the parent), type, ⌘Q, assert the
window is **still open** and the modal is showing; (c) hang the write behind a 10 s sleep injected in
test builds, ⌘Q, assert the app exits at ~2 s and logs the discard.

**3 — Delete the open note while dirty (B17).**
*Invariant:* the trashed file is never resurrected, and the buffer is never dropped without a prompt.
*Mechanism — the order is normative and is the whole fix:*
```
1  cancel BOTH autosave timers
2  if dirty:  modal — "<name> has unsaved changes."
              [ Cancel ]  [ Save and delete ]  [ Delete without saving ]
              (Cancel is the default and is focused)
3  if "Save and delete": await flushNow(); on reject, ABORT the delete and show the error
4  clear dirty; clear the frontend's activePath
5  invoke delete_entry(path)      -> the core clears AppState.open_note under the write lock (M54)
6  view.setState(EditorState.create({ doc: '', extensions }))   -> the pane is EMPTY
```
Step 1 before step 5 is what makes the race unwinnable; `create: false` (§7.1 rule 1) is what makes
it unwinnable even if step 1 were skipped. The editor closes to an empty state — a `(deleted)` tab
marker is STRUCK, because two divergent copies of a note the user believes deleted is the worst
outcome in this document.
*Test:* type into `Misc.md`, delete it, wait 6 s (past both timers); assert the file does **not**
reappear, assert the user was prompted before the buffer was dropped, assert the Trash holds the
pre-edit copy and nothing holds a post-edit copy. The last clause is not reachable from a test and
that is a measured fact: a fixture note's trash destination *is* the user's own Trash. What is
asserted instead is which bytes are in the file at the instant `delete_entry` is called, on all
three branches (`dl_25`), and that a **refused** trash leaves the note in the vault (`dl_27`).

**Two normative additions the original spec did not name** (Z5), both in `editor.ts`'s
`guardDeleteOfOpenNote()`: a **resolved flush is not proof of a write** (the write path resolves
early when the note is not 'live', so a conflicted note would otherwise walk past the abort check
having saved nothing), and `settleWrites()` is awaited **twice** — once at step 1 and once after the
modal answers — because §7.2 flushes on blur, and the user can blur while the modal is up. **F3's
window closes with the second await:** a write already past step 1b when the delete lands would
otherwise resurrect the note via step 8's rename, and cancelling the timers cannot stop a write
already running. One residual, stated rather than solved: if a blur flush lands while the modal is
open and the user picks *Delete without saving*, the Trash copy holds the **post-edit** content —
a labelling imprecision that errs toward keeping the user's text. Owners: the modal is **01**
(`src/modal.ts`); steps 1–4 are **03** (`src/editor.ts`, one exported async function); steps 5–6 are
**01** (`src/main.ts`'s `deleteFlow()`, which performs no delete on `'abort'`).

**4 — The open note is renamed (in-app).**
*Invariant:* external-change detection keeps working, and the editor's `baseMtimeMs` stays valid.
*Mechanism:* `rename_entry` updates `AppState.open_note` under the write lock when the renamed node
**is, or is an ancestor of,** the open note (M54); the frontend updates its `activePath` and the tab
label from `RenameResult.path`. Without it, `open_note` points at a path that no longer exists,
`nc://note-external-change` never fires again, and the editor shows stale text forever.
*Test:* rename the open note, edit the file from a shell, assert **exactly one**
`nc://note-external-change`.

**5 — The open note is renamed or moved externally.**
*Invariant:* the buffer is never written to a path the user did not mean. *Mechanism:* the watcher
rescans the directory and emits `nc://tree-changed`; the frontend's `activePath` no longer resolves.
The editor **stops autosave**, marks the buffer read-only, and shows the bar
`This note was renamed or removed outside the app. [ Save as… ] [ Discard ]`. It does **not**
silently follow the rename — rename pairing is unreliable and following a mis-paired rename writes
the buffer into the wrong file.
*Save as…, specified (X16):* this button **is** the app's Save-As and the only producer of
`create: true`. It opens the same inline name editor as a rename, defaulted to the note's old
basename, rooted at the old parent folder. On commit it calls
`writeNote(newPath, text, flags, baseMtimeMs: null, create: true)`; an existing destination comes
back `alreadyExists` and the editor stays open. On success the frontend adopts `newPath` as
`activePath`, updates the tab label and the inline title, clears the bar, and resumes autosave
against the new path with the receipt's `mtimeMs` as the new base. `[ Discard ]` drops the buffer to
the empty state and writes nothing, ever.
*Test:* `mv Misc.md Other.md` from a shell with a dirty buffer; assert no write to either path and
that the bar appears. Then `Save as…` into a fresh name and assert exactly one write, with
`create: true`, to that name; repeat into an existing name and assert `alreadyExists` and **zero**
writes.

**6 — A folder is deleted while a note inside it is open.**
*Invariant:* identical to case 5 — the containing folder's disappearance is a coarser version of the
note disappearing. `delete_entry` on a folder clears `AppState.open_note` if the open note is a
descendant. *Test:* open `A/B/n.md`, delete `A` in-app with a dirty buffer; assert the prompt from
case 3 fires and nothing under `A` is recreated.

**7 — Concurrent edit from another application.**
*Invariant:* an edit made elsewhere is never silently clobbered. *Mechanism:* the `baseMtimeMs`
conflict guard. If the disk mtime differs from the base the editor read, the write is refused with
`Conflict { diskMtimeMs }`, autosave stops for that note, and the bar offers *Keep mine* / *Reload
from disk*. If the buffer is **clean** when `nc://note-external-change` arrives, the editor silently
reloads. *Test:* open a note, edit it from a shell, type in the app; assert exactly one `conflict`,
assert the disk file still holds the shell's content, assert no write occurred.

**8 — The vault root is deleted, renamed or unmounted (M57).**
*Invariant:* the app never autosaves into a path whose root is gone, and never draws a vault that no
longer exists. *Mechanism:* the core emits `nc://vault-lost { path }`, drops the vault, and does
**not** rescan. The frontend MUST: stop autosave, mark the buffer read-only with a banner, freeze the
tree, and offer `[ Re-open ] [ Switch vault… ]`. *Test:* open a vault on a removable volume, eject
it; assert the banner, assert zero writes afterwards.

**9 — The vault lives on iCloud Drive / Dropbox / Syncthing.**
*Invariant:* the app's own writes never produce a sync conflict of the app's making, and a sync
client's writes are treated exactly like another app's. *Mechanism:* temp+rename inside the same
directory (never a cross-directory move, which some clients handle as delete+create); the
`.`-prefixed temp name, which every client ignores; and the PID-aware sweep from case 1 so debris is
not replicated. Sync clients that rewrite mtimes are handled by the conflict guard as case 7.
**iCloud Drive is OUT OF SCOPE by user ruling (E60)** — the evicted-placeholder path was never
measured and is out of scope; Dropbox and OneDrive are unmeasured
too and are not claimed. What case 9 claims is what was measured: two real Syncthing daemons, a real
divergent edit, `electron-shell/sync-client.test.mjs`; **DATA-LOSS gap G-d is CLOSED.**
**Network filesystems (NFS, SMB) emit no watcher events at all.** The vault still works, the watcher
STARTS (`watching: true`, so the degraded banner is never drawn), and **there is no refresh
affordance and there will not be one** (§0.12.2). Such a vault picks up external changes on the next
RE-OPEN: switch to another vault and back, or restart.
*Test:* run the write-loop from case 1 inside a directory that a second process is concurrently
`rsync`ing; assert no `.tmp-` file survives and no note is truncated.

**10 — Case-insensitive APFS vs case-sensitive Linux.**
*Invariant:* a case-only rename never destroys the file, and a name that collides only by case is
refused rather than silently merged. *Mechanism:* on rename, if the destination exists **and**
`same_file(src, dst)` (compare `dev`+`ino`), it is a case-only rename: perform it as
`old → dir/".<name>.tmp-<pid>-<counter>" → new` in the same directory, restoring `old` if the second
step fails. **The intermediate name comes from the same temp-name helper as §7.1 rule 2 step 3** so
it is invisible to the scanner (§3.6 skips dotfiles), swept by the PID-aware crash sweep, and legal
for G8. Otherwise `AlreadyExists`. Collision detection is **case-insensitive on macOS, byte-exact on
Linux**, matching the filesystem the write will actually hit. **The frontend never auto-renames a
user-typed name** — silently turning `Ideas` into `Ideas 1` is how people lose track of notes;
auto-numbering happens only for the system-generated `Untitled`. *Test:* on APFS, `notes.md` →
`Notes.md` succeeds and the file still exists with its content intact; a second file `NOTES.md`
created from a shell then renamed to `Notes.md` is refused.

**11 — Filename characters legal on one OS and not the other.**
*Invariant:* this app never creates a file that another machine holding the same vault cannot check
out. *Mechanism (M52) — two different functions, because they answer two different questions:*

| Function | Applied to | Rule |
|---|---|---|
| `validate_name` | **creation and rename targets only** | rejects `\ / : * ? " < > \|` and U+0000–U+001F; empty or whitespace-only; `.` or `..`; leading/trailing space; trailing `.`; the Windows device names `CON PRN AUX NUL COM1..9 LPT1..9` with or without an extension; longer than 255 UTF-8 bytes. Deliberately stricter than either OS's minimum, because vaults get synced onto Windows. |
| `validate_rel_for_lookup` | **every path arriving over IPC for resolution** | rejects **only**: NUL, a leading or trailing `/`, any empty component, any `.` or `..` component, more than 255 components. |

A single `validate_rel` requiring every component of a *lookup* path to pass `validate_name` is
STRUCK: it made legitimate notes **visible but permanently unopenable** — a directory named
`Archive ` or `v1.` is legal on ext4 and reachable through a sync client, and every
`read_note`/`rename_entry`/`delete_entry` through it would be rejected before resolution ran. The
traversal guarantee comes from `resolve()` walking the arena, not from character rules.
Live enforcement in the rename/create editor is a `beforeinput` handler that drops rejected
characters before they land, flashing `.bad` for 200 ms; the name-level rules run at commit and the
editor **stays open** on failure. Nothing is silently accepted-then-rejected.
*Test:* create `Archive ` and `v1.` from a shell inside the vault, then open, rename and delete a
note inside each through the app; all three succeed.

**12 — Symlink loops.**
*Invariant:* the walk terminates, and no path in the arena escapes the vault root. *Mechanism:*
`DirEntry::file_type()` on Unix reads `d_type` and does **not** follow, so a symlinked directory
reports `is_symlink() == true` and `is_dir() == false` and is skipped at walk time. Loops are
structurally impossible, and every absolute path the process touches is `root_path` plus a chain of
names read from `read_dir` inside the vault, none of which is `..` and none of which is a symlink.
`fs::canonicalize` is deliberately **not** used as a check — it is a syscall per validation and a
TOCTOU race; the arena is the check and it does not race because it is under a lock.
*Accepted limitation:* symlinks are skipped **entirely**, so a vault that stitches in an external
folder shows it as absent with no error.
*Test:* `ln -s .. loop` inside the vault; assert the walk completes, the tree has no `loop` row, and
`read_note("loop/../../etc/passwd")` returns `invalidPath` with nothing outside the root opened
(verified at the syscall level).

**13 — Traversal.**
*Invariant:* nothing outside the vault root is ever opened. *Test:* `read_note("../../etc/passwd")`,
`read_note("/etc/passwd")`, `rename_entry("a.md", "../b.md")`, `create_note("", "../x")` → all
`invalidPath` / `invalidName`, verified at the syscall level.

**14 — A note that is not valid UTF-8.**
*Invariant:* the file's bytes are never destroyed by a lossy round trip. *Mechanism:* `read_note`
validates with `std::str::from_utf8` and returns `NotUtf8` — **never** `from_utf8_lossy`, because a
lossy decode followed by an autosave permanently rewrites the file. A read-only lossy-preview
fallback is STRUCK: it is one bug away from exactly that outcome, and the banner it proposes
protects nothing that refusing does not. *Test:* T2.6.

**15 — A note larger than the cap (M27).**
*Invariant:* the memory position is not blown by one pathological file. **`MAX_NOTE_BYTES = 8 MiB`**,
and `read_note` returns `TooLarge { path, bytes, limit }`. A 32 MB guard is STRUCK — with the
measured headroom of the day, a 32 MB rope plus a height map is exactly where the position dies, and
a 32 MB note is ~35 MB of JS heap. The UI copy:
`This note is 47 MB — too large to open (the limit is 8 MB).` There is no truncated preview and no
read-only fallback — a truncated view the user might edit is a data-loss path, not a feature.

**16 — Watcher exhaustion / degradation.**
*Invariant:* the user is never left believing the tree is live when it is not. *Mechanism (§0.12
E14):* `notify::ErrorKind::MaxFilesWatch` → `nc://watch-degraded { reason: "watch-limit" }`, which
draws the **`.watch-degraded` banner** — a 48px two-line bar in the §3.3 slot, `role="alert"`,
ranked below `.vault-lost` and above `.cap-banner`, carrying one `.chrome-btn` labelled **`Refresh`**
bound to `rescan_all()`. It is cleared from `applyVaultInfo` when `VaultInfo.watching` comes back
true; a rescan that failed to restart the watcher leaves the bar up. There is no `PollWatcher`
fallback — polling 5,000 files every 30 s is exactly the background cost this product exists to
avoid.
**The button's LABEL is normative, not cosmetic.** Both Rust hint strings — `watcher.rs`'s
`degrade_hint` and `app.rs`'s `emit_degraded` — end *"Use Refresh to pick up changes."*, and that
sentence is shown in this bar's own tooltip. Rename the button and the copy becomes a lie.
*Test (via injection on both platforms):* a `#[cfg(test)]`-only injection point makes `Watcher::new`
return `ErrorKind::MaxFilesWatch`; open the fixture vault and assert exactly one
`nc://watch-degraded`, a `.watch-degraded` bar whose line names the reason, whose tooltip carries
Rust's hint and whose only `.chrome-btn` reads `Refresh`, a tree that still paints, and that
`rescan_all()` from **that button** still refreshes it.

**17 — Drag-to-move (command 24, user feature).**
*Invariant:* a drop moves the entry and never refuses on collision, and it cannot move a folder into
itself. *Mechanism:* Obsidian's file-explorer drop, transcribed — a move is a rename with
`getAvailablePath` uniquification, so the returned path is the FINAL one (`Foo 1.md`), adopted never
recomputed, exactly like `rename_entry`'s. The backend refuses a folder into itself or a descendant
with `invalidPath`, and a move onto the existing parent is a no-op. Moving the **open note**, or an
ancestor of it, updates `AppState.open_note` and the frontend's `activePath` exactly as case 4 does.
*Test:* drop a note onto a folder with a name collision; assert one write, the final uniquified path,
and that the original is gone. Drop a folder onto its own child; assert `invalidPath` and nothing
moved.

**18 — Secret notes and secret-entry deletion (user feature).**
*Invariant:* a secret file's bytes never surface as content search hits, and a secret entry's delete
is confirmed and does not touch the Trash. *Mechanism:* a `cairn-type: secrets` note is marked in the
tree from command 25 and its bytes are skipped by content search (§4.1); its entries are deleted
through the modal-confirmed **Delete secret** dialog, which has NO Trash and therefore no `focusId`
(Return lands on Cancel). *Test:* a vault holding a secret file and a plain note with the same text;
assert a content search hits only the plain note, and that a secret-entry delete writes the block
away only after the confirm.

**19 — The delete confirm, and a multi-delete.**
*Invariant:* a non-dirty delete is still confirmed, and a shift-selection of N entries asks N times.
*Mechanism:* the confirm is Obsidian's own dialog, transcribed — title `Delete file` / `Delete
folder`, the full name WITH extension, `It will be moved to your system trash.`, a non-empty
folder's two amber rows, Cancel + solid-red Delete with Delete focused and an X that answers Cancel;
Obsidian's "Don't ask again" checkbox is deliberately not transcribed. Delete applies to a whole
shift-selection, and Obsidian's shape is transcribed: **N files mean N sequential confirms**, each
with its own name, and a Cancel stops the sequence rather than skipping to the next file. A folder
swallows its selected descendants (deleting it deletes them; a second confirm for a note already
gone would read as a bug). *Test:* shift-select three notes and one of their folders; assert the
folder's confirm swallows its children and that Cancel stops the sequence with the remaining files
untouched.

#### 7.3.1 The trash backend — `NsFileManager`, pinned, not defaulted (Z8)

**Normative.** On macOS, `fsops::delete_entry(.., permanent: false, ..)` MUST trash through
`-[NSFileManager trashItemAtURL:resultingItemURL:error:]`, i.e. a `TrashContext` with
`DeleteMethod::NsFileManager` explicitly set. It MUST NOT use `trash::delete`'s default context,
whose macOS default is `Finder` — an Apple Event to another application, from a child process,
resolved through `PATH`, that nobody chose. Pinning `NsFileManager` removes four things at once: the
Apple Event, the TCC Automation prompt (which, because the ad-hoc requirement is a bare `cdhash`,
**returned on every rebuild**, with a Deny turning every later delete into `trashUnavailable`), the
subprocess, and the bare-name `PATH` lookup — in an app whose stated posture is that `/usr/bin/open`
is the one spawn and it is absolute.

**Put Back survives, and that is a measurement rather than an argument.** `trash 5.2.7`'s own
doc-comment says `NsFileManager` loses Put Back on some systems; measured on macOS (arm64), it does
not. A throwaway disk image was used so the probe never wrote to the user's real Trash — the real
Trash held 72 items before and after, checked four times — and `trashItemAtURL:` was observed to
write the same `ptbL`/`ptbN` records Finder does, keyed by the new name on a collision while `ptbN`
keeps the original. The real `~/.Trash/.DS_Store` corroborates the format (235 `ptbLustr` / 233
`ptbNustr` records, all written by Finder). A second independent discriminator: the probe ran to
completion **with the screen locked and raised no TCC prompt**, which an Apple Event could not have
done.

**`NSAppleEventsUsageDescription` is correctly ABSENT** from the app's Info.plist rather than missing
from it: the app is no longer an Apple-Event sender, so the key it lacked is a key it must not need.

**Regression guard, normative:** `dl_27` MUST keep asserting that `permanent: false` spawns **no**
subprocess and that a refused trash leaves the note in the vault, byte-unchanged (`NSCocoaErrorDomain`
513 via a `0555` parent). A silent fallback to `DeleteMethod::Finder` reintroduces all four
consequences above and is invisible in every other test. **The Freedesktop case on Linux has no
test** — the backend there is the crate default, which is not `NsFileManager` — and that gap is
recorded rather than papered over.

### 7.4 The tab strip (M56)

**Owner: 03**, in `src/tabstrip.ts`. **Two FIXED tabs (user ruling): the note tab
and a second `Memoir` tab, neither closable** — *"Two tabs will be always on this app. Fixed. Can't
close!"* There is no close button anywhere in the strip, so the old dirty-close table is void: there
is no control left that discards anything, and the dirty-close guard lives on the paths that still
tear down (quit, vault switch, delete).

| Situation | Required behaviour |
|---|---|
| no note open | the note tab is **NOT RENDERED**, and the pane is **EMPTY** (§0.45 E91 deleted the `No note open` line; §0.30 E71 deleted the `+`). The Memoir tab shows whenever a vault is open |
| the empty state | **does not exist** — the element is deleted at the user's request. spec-03 §7.2's rejection of the CM6 `placeholder` extension is unaffected and still right: nothing replaces this, a placeholder least of all |
| the caret, with no note open | **there is none** (§0.45 E92). `open === null` reconfigures to `EditorView.editable.of(false)`, not merely `readOnly`: readOnly is a transaction filter and leaves `contenteditable="true"`, so Chromium kept blinking a caret in a pane with no document. `detached` and `vault-lost` deliberately KEEP theirs — their text stays selectable for `Save as…` |
| switching | click, or **Mod-1 / Mod-2** for the note / Memoir tab. Exactly one carries `.is-active`; the inactive style is Obsidian's own (transparent, no ring, no curves) with an inset hover pill on `.tab-inner` |
| `(deleted)` tab marker | **does not exist** — struck with the old `(deleted)` row |

### 7.5 Startup

`current_vault()` returns `VaultState` (§1.5), which distinguishes **`none`** from **`loading`** and
is the difference between "no vault configured" and "a walk is in flight". **`{state:'none'}` renders
the shell and nothing else** — §0.44 E89 deleted the first-run `Open folder as vault…` panel, and
the route to open one is the vault bar's own switcher, which is drawn in every state.

**A normal launch reopens the last vault `state.json` recorded**, through the addon's
`startupOpen()` — not a §1.3 command. A hermetic run with a fresh state directory has no `last_note`
or `vault`, so nothing is open at boot and the shell renders.

**The window is built hidden, MAXIMIZED, then shown** (§0.26 E65): `win.once('ready-to-show')`
maximizes the hidden window and then calls `show()` / `focus()` / `webContents.focus()` — all three
measured necessary, because the live-preview reveal is gated on focus and an unfocused window
renders its markdown (§0.23.3 E48). Never under `--pixeltest` and never headless. `setup()` MUST NOT
block on the vault walk.

### 7.6 `state.json` — one file, one schema (M25)

Location: `<appData>/com.cairn.app/state.json` — `~/Library/Application Support/com.cairn.app/` on
macOS, `~/.config/com.cairn.app/` on Linux. Never inside the vault, and nothing in the code
hardcodes either path (the shell resolves it from the identifier, §9 E1). There is no SHA-256, no
second file and no `dirs` crate.

The schema is **per-vault keyed**, because a flat one holds exactly one vault's
`expanded`/`last_note` and switching A→B→A would lose A's expansion:

```jsonc
{
  "v": 1,
  "vault": "/Users/me/Notes",                    // the last-open vault, or absent
  "recents": ["/Users/me/Notes", "/Users/me/Work"],   // max 8, MRU, deduplicated by canonical path
  "win": { "w": 1000, "h": 700, "x": 0, "y": 0, "max": false },   // global, not per-vault
  "sidebar_w": 412,                              // GLOBAL, beside `win`; absent = never resized
  "vaults": {
    "/Users/me/Notes": {
      "sort": 0,                                 // u8 0..3
      "expanded": ["Projects", "Projects/2026"], // folders only, max 2000, silently truncated
      "last_note": "Misc.md",
      "scroll_top": 0
    }
  }
}
```

`expanded` is capped at **2,000** — 500 is too small for a real vault (it silently loses expansion a
heavy user notices) and 4,096 is a 250 KB prefs file; 2,000 paths is ~60 KB. **Missing vaults are
pruned on launch** (`prune_missing_vaults`): a recents entry whose folder is gone does not survive
the next start, so the popover's `(missing)` row only ever describes a deletion that happened while
the app was running.

`sidebar_w` is **GLOBAL, beside `win`, not per-vault** — it is a property of the window the user
arranged, not of the notes in it, which is also why it is applied ABOVE the per-vault early return:
a resize with no vault open still persists. It is an `Option`, and absence means **"never resized"**,
so a fresh install serialises no width and the page keeps the 412 default. The core bounds a stored
value to `[120, 4000]` on both apply and load — a hand-edited file cannot ship a 0px sidebar — and
deliberately does **not** clamp against the window, which only the page knows the width of.

Written with the same atomic routine as note writes (§7.1 rule 2, minus the conflict check),
debounced 1,000 ms, and flushed unconditionally in the `confirm_close` path **after** the editor
buffer. A corrupt or unparseable file is silently replaced with defaults — never an error dialog,
never a startup failure. The `vaults` map is pruned to the 8 entries in `recents`.

**The identifier is settled: `com.cairn.app`** (§9 E1), and it decides this path. It is **stable
because churning it is pointless, not because change is dangerous**: there is no installed base to
strand (Cairn is never publicly distributed, §9 E5), and a change would cost one `mv` of one directory before
the next launch.

#### 7.6.1 The read path — `expanded` and `scroll_top` (Z2)

**Folder expansion and sidebar scroll position must survive a restart, and they do.** The write half
was fully wired while `VaultInfo` carried neither field, so `main.ts`'s `applyVault()` reset both on
every vault open.

**Ruling: `VaultInfo` carries them. There is no command 21.** Every consumer of this data already
awaits a `VaultInfo` (from `open_vault`, `current_vault`, `rescan_all`, and again off
`nc://vault-opened`), so a separate `get_ui_state` call would be one more round trip, one more await
on the boot path, and a second chance for the two answers to disagree.

- `core/src/vault.rs`: `VaultInfo` gains `expanded: Vec<String>` (folders only, already truncated to
  2,000) and `scroll_top: f64` (finite, ≥ 0), and `vault::info(…)` takes both as parameters — they
  come from `prefs.rs`, not the arena, exactly as `last_note` already does.
- `core/src/prefs.rs`: one reader, so the three call sites do not re-derive it —
  `PrefsStore::view_state(root) -> (Vec<String>, f64)`, returning `(vec![], 0.0)` for an unknown
  vault, already sanitised.
- `src/ipc.d.ts` and `src/main.ts`: the fields, and `applyVault()` passes them to
  `setExpanded` / `setScrollTop` instead of the empty defaults.

**The key must be one spelling.** `view_state`'s `root` is the same string as `VaultInfo.root` and
the same string `save_ui_state` writes under; a key differing by one character makes the whole read
path silently inert. **Tests (mandatory):** Rust — `view_state` returns the defaults for an unknown
vault, exactly what `save_ui_state` wrote for a known one, `expanded` truncated at 2,000 and
`scroll_top` `0.0` for a persisted `NaN`/negative; frontend — both are applied **only when
`switched` is true** (never on a rescan of the vault already applied, which would stomp every folder
the user has expanded since), in the order `setExpanded` → `await refreshTree()` → `setScrollTop`,
because `setScrollTop` clamps to live content.

## 8. The memory position — retired

**THE MEMORY POSITION IS NOT GATED.** G5a and the whole memory thesis were retired by user ruling
(*"Fuck memory efficiency. We'll optimize later."*), and §8.1–§8.4's numbers were five-process
Tauri/WKWebView measurements of a stack that no longer exists. **The measurements are not
withdrawn** — the measured **~15 B of `phys_footprint` per byte of minified JS** and the arena's
**448 KiB** stand as measurements — but nothing enforces them. **Optimisation is deferred, not abandoned:
re-measure on Electron before designing around any number that stood here.** The section numbers
below are kept as tombstones because code cites them.

#### §8.1 — DELETED (the `phys_footprint` metric and process attribution. The one rule that survives: **a locked screen invalidates graphics and memory numbers — refuse the run, do not disable the check**.)

#### §8.2 — DELETED (the 86.9 MB composition and the marginal-cost ladder).

#### §8.3 — DELETED (the per-platform verdicts and the 2× projection).

#### §8.4 — DELETED (the Tauri cold start; G6 is not enforced until Electron is measured — §6.5).

### 8.5 Threads and locks (M40)

| Thread | Count | Lifetime |
|---|---:|---|
| main | 1 | process |
| tokio worker | 2 | process |
| tokio blocking | ≤ **6** | on demand — one slot is held by the search coordinator for the whole duration of a search |
| vault walker | 1 | per `open_vault`, joined |
| watcher (notify) + coalescer | 2 | per vault; shut down **by disconnect**, not by a flag |
| search workers | **4** | **per query only** — no persistent pool (§4.1) |

Both counts are set on a runtime the **addon builds itself** and hands to napi — which is why `tokio`
is a direct dependency (§6.2, X8). A runtime we do not construct cannot be tuned, and the blocking
count is load-bearing.

`Vault::drop` order is normative and non-negotiable: **(1) drop `watcher`, (2) `join()` the
coalescer, (3) drop the arena.** Dropping the `RwLock` guard before the `Vault` is the other half
(§4.3); either in the wrong order deadlocks.

## 9. Escalations — the user's decisions, now recorded

**Every ruling in this section is settled. Nothing here is open.** E1–E4 are the four escalations
this document raised; E4a is this document ruling on a control E4's principle covers; E5 is a
standing user constraint; E6 and E7 are user decisions about Debian.

### E1 — Product name and bundle identifier

**`productName: "Cairn"`, `identifier: "com.cairn.app"`, crate `cairn` / `cairn_lib`.** The bundle
identifier decides the config directory (§7.6) and the ad-hoc signature's `Identifier`. Every earlier
placeholder is dead.

**The identifier that stood here before named the user's EMPLOYER** — inferred by an agent from a
home-directory account name and frozen into a reverse-DNS name as though it were the vendor. Nobody
chose it; the user struck it on sight. **The caution generalises: do not infer identity, ownership or
affiliation from a filesystem path, a hostname, a git config, an email domain or a login name, and
never freeze such an inference into a name that outlives the guess.** The home-directory paths in
the tooling are correct and must not be rewritten. **The identifier is stable because churn is
pointless, not because change is dangerous**: Cairn has no installed base (§9 E5), and a change
would cost one `mv` of one directory before the next launch. Do not churn it; do not write it up as
a hazard either.

### E2 — Linux — DELETED (macOS-only for v1; the deferral was lifted by E6 and its Tauri-era mechanism is gone).

### E3 — The Retina position — DELETED (the single-surface lever was a WebKit preference; deleted with that engine — §5.12).

### E4 — Pixel-identity vs. dead controls — **SETTLED: all four omitted**

**No inert decoration.** The user's ruling omits the two title-bar icons (the tab-list chevron and
the right-sidebar toggle), the vault bar's help `?` and settings gear, and syntax highlighting inside
code blocks. The fullscreen traffic-light hole is accepted: fullscreen is not in the feature list,
but ⌃⌘F and the green button reach it, and only there do the lights leave the strip (§5.6). No
section may draw any of them, reserve space for them, or gate on them. **E4 forbids controls that do
nothing, not features** — the Memoir page, secret notes and drag-to-move are deliberate additions
(see the last subsection here).

### E4a — the `panel-left` title-bar button — **RULED HERE: omitted**

The reference draws it and nothing in this document binds it, so it would ship as dead pixels or as
an invented feature. **Omitted**, and omission moves nothing: `.titlebar-left` is width-fixed at
`--sidebar-w`. `[C]`

### E5 — Distribution — **SETTLED: none public, ever; private releases to own machines only. NORMATIVE**

The user builds Cairn, packages it, and installs it on devices they own. The only artifacts are
the private GitHub releases of the single version 1.0.0, built from latest main by
`.github/workflows/release.yml` (the repo is private, so those releases are private too).
**Permanent, not a v1 simplification**, and every consequence below is engineering rather than wording.

1. **Notarization is deleted, not deferred.** No Apple Developer Program membership, no Developer ID
   certificate, no `notarytool`, no stapling. No section, spec or tool script may describe
   notarization — or acquiring a signing certificate — as future work or as the thing that would fix
   a problem.
2. **Ad-hoc `codesign -s -` is the permanent, correct signature**, as `tools/sign-macos.sh` runs it.
   §6.4's four-step order and its "rebundling by any route destroys the signature" rule are
   mandatory.
3. **Gatekeeper's first-launch story is mostly not this app's story.** `com.apple.quarantine` is set by the
   **downloader**, and a locally built `.app` carries no such xattr, so it launches with **no dialog
   at all**. A copy pulled from the private release travels through a browser and DOES carry the
   xattr — clear it as README describes. `spctl`'s `rejected` verdict is expected forever either way.
4. **The `.dmg` is a copy convenience for the author's own Macs**, shipped only through the private
   1.0.0 release — never a public download. §6.4's signing order applies to it unchanged.
5. **What survives, and it is the one real cost:** the ad-hoc designated requirement is a bare
   `cdhash` and the build is not reproducible, so **every rebuild is a new code identity and TCC
   Files-and-Folders grants are re-prompted after every rebuild.** A Developer ID is the only thing
   that would stop it and Cairn will never have one: **a permanent, accepted property of the app,
   not a defect awaiting a certificate.**
6. **One version: 1.0.0, from latest main.** No semver, no incrementing, no changelog automation.
   Every push to `main` rebuilds both artifacts and republishes the `v1.0.0` tag (upload with
   `--clobber`); the workflow can also be dispatched by hand.

### E6 — Debian/Linux is a supported dev and usage platform — **SETTLED**

Cairn is developed and used on a Debian 13 (trixie) box (GNOME on Wayland). A locally built `.deb`
installed on the user's own machine is E5's *"installs it on devices they own"* verbatim, not
distribution: `npm run package:deb` builds it with no electron-builder. **There is no Linux memory,
graphics or geometry number anywhere in this document, and none may be quoted until one is
measured — but G9 DOES run on Debian and its verdict is taken there.** One gap is recorded rather
than hidden: **the Freedesktop trash-refusal case has no test** — the trash backend on Linux is the
crate default, not `NsFileManager`, and `dl_27` is macOS-only.

### E7 — The Linux title bar — **SETTLED, and it is measured**

On Linux the 39px strip IS the title bar, and three **44 × 39** controls — minimize,
maximize/restore, close — sit flush to its right edge under `html[data-os="linux"]`; the geometry
and all four glyphs come from Obsidian's own bundle. `--macos-tl-inset` is **8px on Linux** and 88px
on macOS. **The ✕ still runs §1.6's flush handshake**: it is `win.close()`, never `destroy()`, so a
rejecting flush still cancels the quit. §0.5 E7 is the ruling;
`electron-shell/window-control.test.mjs` and `tests/frontend/window-controls.test.mjs` are its
coverage.

#### Standing user features

Each is a deliberate user feature with no E-number of its own, and each is specified where it lives:
**the Memoir page** — a fixed second tab over `llm-service` at `127.0.0.1:8770` (§0.6, §7.4);
**secret notes** — `cairn-type: secrets` files with a credentials viewer, command 25, a tree mark and
a content-search exclusion (§1.3, §3.6, §4.1, §7.3 case 18); **drag-to-move** — command 24,
Obsidian's drop with uniquification (§1.3, §7.3 case 17); **two fixed tabs** — the note tab and
Memoir, neither closable, switched by click or Mod-1 / Mod-2 (§0.6, §7.4); and **click-to-copy in a
TOTP row** — there is no `Copy` button (§0.46.6).

## 10. What an implementation agent does with this document

1. **Read §1 and §2 before writing any IPC code.** `core/src/note_frame.rs` and `src/note_frame.js`
   are the only two copies of the byte layout, and nothing else may restate it.
2. **Treat any `spec-NN §X` cross-reference as void.** Every spec's cross-references were written
   against a different numbering and point at the wrong documents. Cite this contract.
3. **Where a spec section is named STRUCK in §0 or in the body, delete it** on the next editing pass
   over that spec rather than annotating it. An annotated contradiction is still a contradiction.
4. **Do not re-open a settled ruling** because a spec or an inference argues the other way. Where a
   measurement beats an assertion, the measurement wins; where this document chose, the choice names
   its loser and its reason. §9 is the set of standing user decisions, and **do not infer a vendor or
   an organisation from a path, a hostname or an account name** (§9 E1).
5. **Read §5.12 before adding any scrolling box, any `overflow` declaration or any
   `::-webkit-scrollbar` rule.** Three rules carry it: there are exactly **two** rendered scrollable
   boxes and the main frame is not one of them; the editor's `::-webkit-scrollbar` must be on
   `.cm-scroller` itself; and the tree's `scroll` handler must not force layout. G9's
   `layers.scrollers` row catches all three. **Do not write `src/vscroll.ts`** — it belonged to a
   fallback that is deleted with its engine.
