/**
 * src/icons.ts
 * Owner: 01.  Spec: spec-01 §8 (path data, markup convention), CONTRACT.md
 * §5.1 X2, §6.4 and §0.12 E14.
 *
 * TWENTY-ONE inline SVG glyph literals.  It was ELEVEN until §0.6 E8 deleted the two
 * title-bar buttons, which made `search` and `folder-open` dead literals; it is
 * three now because §0.12 E14 deleted the whole five-slot nav toolbar at the
 * user's request, which killed `square-pen`, `folder-plus`,
 * `arrow-up-narrow-wide`, `refresh-cw` and `chevrons-down-up` in one stroke.
 * `panel-left` went with them: M41 / §5.1 X2 / Y6 have required its deletion
 * since errata 2 and the code had never caught up.  M41's "10 literals" is
 * therefore superseded by E14, not violated — the count it named was a count of
 * a toolbar that no longer exists.
 *
 * Three survived E14 — the tab close ✕, the tab strip's `+` and the vault bar's
 * chevron — AND THE `+`'s BUTTON IS GONE (§0.30 E71, a user decision: Cairn is a
 * single-tab viewer and it was a New note control wearing a new-TAB glyph).  The
 * GLYPH stays: `properties.ts` draws `+ Add property` with it.  §0.14 E16 adds
 * FIVE MORE for the row menus, which Obsidian draws
 * with an icon on every row and Cairn did not.  §0.15 E17 then replaced four of
 * those five: E16 picked them off a screenshot and Obsidian's own call sites say
 * otherwise.  One of the corrected five, `edit`, is character-for-character the
 * `square-pen` E14 deleted — a glyph comes back the moment it has a host, which
 * is the only thing "no inert decoration" ever required.  Every one is Lucide
 * (the set Obsidian itself uses),
 * `viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round"
 * stroke-linejoin="round"`.
 *
 * THE TREE CHEVRON IS HERE TOO, since §0.50 E98, as `chevron()` — a real
 * `<svg>` element built with createElementNS, never a string.  It used to be
 * the one glyph never injected as markup (a `-webkit-mask` source, `--chev` in
 * tokens.css, CONTRACT §5.2 X2), and that is exactly what was wrong with it: an
 * SVG loaded as a CSS IMAGE is laid out by Chromium in an isolated page whose
 * screen info reads scale 1.0, and on Linux that page's `LayoutView::LayoutRoot`
 * overwrites Blink's process-wide font-strike scale (crbug.com/845468).  The
 * first paint of the tree did that, the note's `th` cells then populated the
 * bold body strike at style time (`min-width: 6ch`) with subpixel positioning
 * OFF, and a line mixing that strike with the regular one measured 24.8px —
 * LP-10, 12 launches in 21.  An inline `<svg>` has no page of its own.  Still
 * no file holds two copies.
 *
 * `stroke="currentColor"` means one `color` declaration on the button drives the
 * glyph: no per-icon fill rules, and hover is a single opacity change with no
 * repaint of the path geometry.
 *
 * These are the ONLY strings in the app that may be assigned to innerHTML
 * (CONTRACT §6.1) — a COUNT is not written here any more, deliberately: it was
 * "eight" through three passes that changed it (§5.4.5's nine property glyphs,
 * §0.27 E67's two, §0.33 E78's swap) and a number nothing checks is a number
 * that rots.  `chrome-ui.test.mjs` asserts the LIST both ways instead: every
 * glyph has a host, and every host has a glyph.  Note content NEVER reaches the DOM as markup.
 *
 * PLUS FOUR THAT ARE NOT LUCIDE AND NOT 24-UNIT — the Linux window controls
 * (§0.5 E7, spike N §3.3).  They live in `W` below rather than in `G` because
 * they share nothing with a Lucide glyph: a 12-unit viewBox, three of the four
 * fill-based rather than stroked, and no `stroke-linecap` anywhere.
 *
 * TWO OF `icon()`'s HARDCODED ATTRIBUTES WOULD CORRUPT THEM, and it is worth
 * being exact about WHICH, because the obvious answer is wrong:
 *   - `viewBox="0 0 24 24"` renders a 12-unit path at HALF SCALE in the
 *     top-left quadrant of the box.
 *   - `stroke="currentColor"` + `stroke-width` + the two `stroke-linecap` /
 *     `stroke-linejoin` rounds OUTLINE every filled shape, fattening it by
 *     stroke/2 on each side and rounding corners that are square by design.
 * `fill="none"` is NOT one of them.  `fill` is an INHERITED presentation
 * attribute and every filled shape below sets its own `fill="currentColor"`,
 * which overrides the root — so a root `fill="none"` is inert on all four.  The
 * root `fill` is reproduced as Obsidian writes it (present on two, absent on
 * two) for byte fidelity, not because anything depends on it.
 *
 * They are transcribed BYTE FOR BYTE out of Obsidian 1.13.7's own `app.js`,
 * which is the whole point of them; do not "tidy" the path data.  They are
 * still literals in this file, so §6.1's rule — innerHTML is written HERE and
 * nowhere else — is unchanged.
 *
 * SPEC-01 §8.2's `refresh-cw` RESIDUAL IS RETIRED, NOT RESOLVED.  It was the one
 * path here that had been recalled rather than extracted from the published
 * package, and it was never verified against `lucide-static`.  E14 deleted the
 * glyph, so the verification is moot — recorded here so nobody reads its
 * disappearance as a clean bill of health.
 */

export type IconName =
  | 'x' | 'plus' | 'chevrons-up-down'
  /* §0.14 E16, corrected by §0.15 E17 — the five row-menu glyphs, 16px at
     stroke 2 (Obsidian's `--icon-s` / `--icon-s-stroke-width`).  EACH NAME IS
     OBSIDIAN'S OWN `setIcon()` STRING minus its `lucide-` prefix, so the
     mapping can be audited against `app.js` by grepping for it. */
   | 'edit' | 'folder-open' | 'edit-3' | 'clipboard' | 'trash-2'
  /* The secret file's row-menu glyph (user feature, 2026-09-16).  Cairn-only —
     Obsidian has no `New secret file` row, so E17's grep-audit does not apply —
     and therefore transcribed rather than recalled, from the same canonical
     source the drag ghosts cite: `lucide-static@0.469.0`'s `lock.svg`, byte
     for byte (`<rect>` + one `<path>`, 16px at stroke 2 like the five above).
     `key-round` was the alternative; the lock reads at a glance where the
     key's teeth turn to noise at menu size. */
  | 'lock'
  /* Drag-to-move ghost icons (Obsidian's `dragFile`/`dragFolder`/`dragFiles`):
     `lucide-file`, `lucide-folder-open` (already above) and `lucide-files`,
     16px at stroke 2. Transcribed from `lucide-static@0.469.0` (the canonical
     Lucide source Obsidian's own icon table is built from), `file.svg` and
     `files.svg` — `dragFolder` reuses `folder-open`, so only two are new. */
  | 'file' | 'files'
  /* §0.33 E78 — the search panel's way back to the file tree.  It was `files`
     (Obsidian's own file-explorer glyph) on the reasoning that the button means
     "show me the files"; the user read it as a COPY icon, which is what two
     overlapping documents look like, and asked for a back arrow.  It is
     Obsidian's `arrow-left` now — the glyph its own `app:go-back` command
     carries — and `files` is deleted, because that reasoning was the only thing
     holding it up. */
  | 'arrow-left'
  /* §5.4.5 — the PROPERTY TYPE icons, and the Properties heading's triangle.
     Every one of these is Obsidian's own `registeredTypeWidgets` icon string
     minus its `lucide-` prefix (app.js:33112 maps type -> widget, and each
     widget carries `icon:`), so the mapping can be audited by grepping the
     bundle for `type: "text", icon: "lucide-text"` and its ten siblings.  The
     PATHS are `lucide-static`'s, decoded from Obsidian's own compact icon table
     (`Um`, app.js) rather than recalled — spec-01 §8.2's `refresh-cw` residual
     is the standing reminder of what recalling one costs. */
  | 'text' | 'list' | 'binary' | 'check-square' | 'calendar' | 'clock'
  | 'tags' | 'forward' | 'file-question'
  /* §0.27 E67 — the vault switcher's two.  `check` is what Obsidian's
     `MenuItem.setChecked(true)` paints into the TRAILING `menu-item-icon
     mod-checked` slot, and `open-vault` is the glyph on the popover's last row.
     Both 16px at stroke 2, like the row-menu five: they are `.menu-item-icon`
     children and app.css:7988 puts `--icon-s` / `--icon-s-stroke-width` on
     every one of those. */
  | 'check' | 'open-vault'
  /* NOT Lucide: Obsidian's OWN `right-triangle`, from its `Qm` custom table.
     It is the collapse indicator on the Properties heading, and it is the same
     glyph the file tree uses for a folder. */
  | 'right-triangle'

/** The Linux window controls (§0.5 E7).  A SEPARATE union from `IconName`:
 *  these are not Lucide, do not take `size`/`stroke`, and are painted by the
 *  same pass through a different table. */
export type WindowIconName = 'win-minimize' | 'win-maximize' | 'win-restore' | 'win-close'

interface Glyph { size: number; stroke: number; body: string }

/* size/stroke are spec-01 §8.1's, and each is derived: for a Lucide 24-unit
 * viewBox, ink width = (content_width + stroke) / 24 x size. */
const G: Record<IconName, Glyph> = {
  /* §0.9 — 16, NOT 14.  Obsidian's tab close measures 9.6 CSS px of ink and
     Cairn's measured 8.0.  The model that fixes both ends: a Lucide glyph's ink
     is `(span + stroke) / 24 * size`, and it was VALIDATED by the `plus` that
     used to sit in the same strip — span 14, stroke 1.75, size 18 gives 11.81
     and BOTH apps measured 12.0.  That BUTTON is deleted (§0.30 E71); the glyph
     is not, and the validation stands as the record of how this 16 was derived.
     For `x` (span 12) that model gives 8.17 at size 14 and 9.33
     at size 16; the reference reads 9.6, with a measurement granularity of
     0.8px.  14 cannot produce it and 16 can.  (tokens.css's `--icon-xs: 14px`
     documented the old value and has no consumer; it is corrected there too.) */
  'x': { size: 16, stroke: 2, body:
    '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>' },
  /* §0.30 E71 DELETED ITS FIRST HOST AND NOT THE GLYPH.  This was the tab
     strip's new-tab `+` when it was added; that button is gone, and `plus`
     SURVIVES because `properties.ts` draws the Properties block's
     `+ Add property` with it (§5.4.5).  It was deleted here for one build and
     `live-preview.test.mjs` caught it in the only way anything could: the button
     still rendered, still had its `data-icon`, and was BLANK — `paintIcons`
     leaves a host whose name is in neither table alone.  The glyph-host test in
     chrome-ui.test.mjs ran one direction only (a glyph with no host) and now
     runs both. */
  'plus': { size: 18, stroke: 1.75, body:
    '<path d="M5 12h14"/><path d="M12 5v14"/>' },
  'chevrons-up-down': { size: 16, stroke: 1.75, body:
    '<path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/>' },

  /* §5.4.5 — the property-type glyphs.  `--icon-m: 18px` / `--icon-m-stroke-
     width: 1.75px`, WHICH IS THE DOCUMENT DEFAULT AND NOT `--icon-s`.
     app.css:2334 is `--icon-size: var(--icon-m)` and :2335 is
     `--icon-stroke: var(--icon-m-stroke-width)`; :7336's `svg.svg-icon` reads
     both, and `.metadata-property-icon` overrides NEITHER.  An earlier draft
     put these at the row menus' 16/2 by analogy with the five glyphs above —
     the analogy was wrong, and 16 vs 18 is visible at a glance beside
     Obsidian. */
  'text': { size: 18, stroke: 1.75, body:
    '<path d="M21 5H3"/><path d="M15 12H3"/><path d="M17 19H3"/>' },
  'list': { size: 18, stroke: 1.75, body:
    '<path d="M3 5h.01"/><path d="M3 12h.01"/><path d="M3 19h.01"/>' +
    '<path d="M8 5h13"/><path d="M8 12h13"/><path d="M8 19h13"/>' },
  'binary': { size: 18, stroke: 1.75, body:
    '<rect x="14" y="14" width="4" height="6" rx="2"/>' +
    '<rect x="6" y="4" width="4" height="6" rx="2"/>' +
    '<path d="M6 20h4"/><path d="M14 10h4"/><path d="M6 14h2v6"/><path d="M14 4h2v6"/>' },
  'check-square': { size: 18, stroke: 1.75, body:
    '<path d="M21 10.656V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12.344"/>' +
    '<path d="m9 11 3 3L22 4"/>' },
  'calendar': { size: 18, stroke: 1.75, body:
    '<path d="M8 2v4"/><path d="M16 2v4"/>' +
    '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M3 10h18"/>' },
  'clock': { size: 18, stroke: 1.75, body:
    '<path d="M12 6v6l4 2"/><circle cx="12" cy="12" r="10"/>' },
  'tags': { size: 18, stroke: 1.75, body:
    '<path d="M13.172 2a2 2 0 0 1 1.414.586l6.71 6.71a2.4 2.4 0 0 1 0 3.408l-4.592 ' +
    '4.592a2.4 2.4 0 0 1-3.408 0l-6.71-6.71A2 2 0 0 1 6 9.172V3a1 1 0 0 1 1-1z"/>' +
    '<path d="M2 7v6.172a2 2 0 0 0 .586 1.414l6.71 6.71a2.4 2.4 0 0 0 3.191.193"/>' +
    '<circle cx="10.5" cy="6.5" r="0.5"/>' },
  'forward': { size: 18, stroke: 1.75, body:
    '<path d="m15 17 5-5-5-5"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/>' },
  'file-question': { size: 18, stroke: 1.75, body:
    '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 ' +
    '3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/>' +
    '<path d="M12 17h.01"/><path d="M9.1 9a3 3 0 0 1 5.82 1c0 2-3 3-3 3"/>' },
  /* Obsidian's own, not Lucide: `Qm["right-triangle"]` is exactly this one
     path.  It points DOWN at rest and is rotated -90deg when collapsed, which
     is the opposite of the file tree's convention and is Obsidian's.
     10px AT STROKE 4, and neither number is `--icon-m`: app.css:7270's
     `.collapse-icon svg.svg-icon` overrides BOTH — `width: 10px; height: 10px;
     stroke-width: 4px` — so the glyph is small and heavy where the property
     icons beside it are large and light.  It rendered at 16/2 in the first
     draft and read as a different control entirely. */
  'right-triangle': { size: 10, stroke: 4, body: '<path d="M3 8L12 17L21 8"/>' },

  /* §0.14 E16 — THE ROW-MENU GLYPHS.  All five at `size: 16, stroke: 2`, which
     is Obsidian's own `--icon-s: 16px` and `--icon-s-stroke-width: 2px` applied
     to a 24-unit Lucide viewBox — i.e. 1.33 CSS px of rendered stroke, not 2.
     Do not "correct" the 2 to 1.33: the 2 is in USER UNITS and `icon()` scales
     it, exactly as Obsidian's own `--icon-stroke` does.

     THE PATH DATA IS TRANSCRIBED BYTE FOR BYTE OUT OF OBSIDIAN 1.12.7's
     `app.js`, from the copy installed on this machine — the same provenance and
     the same method spike-N used for the E7 window controls, and a stronger
     source than any screenshot.  Obsidian stores them as `"name":[[6,"d"],…]`
     where 6 is a `<path>` and 5 is a `<rect>` in the order (x, y, w, h, rx, ry)
     — confirmed against two entries whose Lucide originals are known.  Do not
     tidy the path data.

     §0.15 E17 REPLACED FOUR OF THESE FIVE, and the names below are now the ones
     Obsidian's OWN CALL SITES pass to `setIcon()`, minus the `lucide-` prefix.
     E16 chose by eye from a screenshot and asserted the result was Obsidian's;
     it was not, for four rows out of five.  Grep `app.js` and the mapping falls
     out verbatim:
         setTitle(…menuOptNewNote()).setIcon("lucide-edit")
         setTitle(…menuOptNewFolder()).setIcon("lucide-folder-open")
         setTitle(…menuOptRename()).setIcon("lucide-edit-3")
         setTitle(…menuOptDelete()).setIcon("lucide-trash-2")
         setSectionSubmenu("info.copy", { …copyPath(), icon: "lucide-clipboard" })

     `edit` IS `square-pen`.  Obsidian's registry holds both names against
     character-for-character identical path data, and `square-pen` is the literal
     §0.12 E14 deleted from this file as a dead nav glyph.  So the correct New
     note glyph was in the tree all along, E14 removed it because nothing drew
     it, and E16 put back the WRONG one beside it.  It is named `edit` here, not
     `square-pen`, so that the audit above is a plain grep.

     `edit-3` IS NOT `pencil-line`.  Obsidian carries both, and they differ: this
     one is the underline plus the pencil body and has NO nib stroke, where
     `pencil-line` adds `m15 5 4 4`.  E16 shipped `pencil` (body + nib, no
     underline), which is a third glyph again. */
  'edit': { size: 16, stroke: 2, body:
    '<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>' +
    '<path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"/>' },
  'folder-open': { size: 16, stroke: 2, body:
    '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>' },
  'edit-3': { size: 16, stroke: 2, body:
    '<path d="M13 21h8"/>' +
    '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/>' },
  /* The ONE `<rect>` in this file.  `fill` is inherited from `icon()`'s root
     `fill="none"`, so it draws as an outline, which is what Lucide intends. */
  'clipboard': { size: 16, stroke: 2, body:
    '<rect width="8" height="4" x="8" y="2" rx="1" ry="1"/>' +
    '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>' },
  'trash-2': { size: 16, stroke: 2, body:
    '<path d="M10 11v6"/><path d="M14 11v6"/>' +
    '<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/>' +
    '<path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>' },
  /* The secret file's glyph — see the union note.  Transcribed byte for byte
     out of `lucide-static@0.469.0` (`lock.svg`): attribute order and path
     data untouched, exactly as the drag ghosts below keep theirs. */
  'lock': { size: 16, stroke: 2, body:
    '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/>' +
    '<path d="M7 11V7a5 5 0 0 1 10 0v4"/>' },
  /* Drag ghost icons, `lucide-static@0.469.0` verbatim (see the union note). */
  'file': { size: 16, stroke: 2, body:
    '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/>' +
    '<path d="M14 2v4a2 2 0 0 0 2 2h4"/>' },
  'files': { size: 16, stroke: 2, body:
    '<path d="M20 7h-3a2 2 0 0 1-2-2V2"/>' +
    '<path d="M9 18a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h7l4 4v10a2 2 0 0 1-2 2Z"/>' +
    '<path d="M3 7.6v12.8A1.6 1.6 0 0 0 4.6 22h9.8"/>' },

  /* §0.33 E78 — the search panel's back button.  Transcribed out of Obsidian
     1.13.7's own Lucide table, where it is stored as
     `"arrow-left":[[6,"m12 19-7-7 7-7"],[6,"M19 12H5"]]` (6 is a `<path>`), and
     it is the glyph Obsidian puts on its own `app:go-back` command.

     IT REPLACES `files`, which was this button's icon until a user report:
     `files` is two overlapping documents and reads as COPY, whatever the
     registry calls it.  The old reasoning — Obsidian's registry maps
     `"file-explorer-glyph":"files"`, so that glyph means "the file tree" — was
     sound about the NAME and wrong about the picture. */
  'arrow-left': { size: 16, stroke: 2, body:
    '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>' },

  /* §0.27 E67 — the vault switcher popover's two glyphs, from the same 1.13.7
     asar and by the same method.

     `check` is LUCIDE, and it is stored in the compact table as
     `check:[[6,"M20 6 9 17l-5-5"]]` — key unquoted, `6` meaning `<path>`, so a
     grep for `"check":[[` finds nothing (§0.15 E17's lesson again).  Obsidian
     reaches it through `setChecked`'s `"lucide-check"`.

     `open-vault` IS NOT LUCIDE.  It lives in Obsidian's own custom glyph table
     beside `paused` and `question-mark-glyph`, and is reproduced here byte for
     byte.  It still renders through `icon()` unchanged, because that table is
     built with the SAME root attributes as the Lucide one — Obsidian's `Dg()`
     hands it `bg("svg", yg)`, and `yg` is `viewBox="0 0 24 24" fill="none"
     stroke="currentColor" stroke-width=2` with both rounds.  (The neighbouring
     table `Mg` is the one on a `0 0 100 100` viewBox; `open-vault` is not in
     it, and checking which table a glyph is in is not optional.) */
  'check': { size: 16, stroke: 2, body:
    '<path d="M20 6 9 17l-5-5"/>' },
  'open-vault': { size: 16, stroke: 2, body:
    '<path d="M10 21L4.5 21C3.39543 21 3 20.5255 3 19.2L3 4.80001C3 3.47452 3.39543 3.00001 4.5 3.00001L10 3"/>' +
    '<path d="M21 7L22.5 7"/><path d="M21 16L22.5 16"/>' +
    '<path d="M21 18.9104L21 5.09381C21 5.09381 21 3.94236 19.5 3.36674L11.5 1.06397C11.5 1.06397 10 0.488257 10 2.79104L10 21.0928C10 23.5159 11.5 22.9403 11.5 22.9403L19.5 20.6375C21 20.0618 21 18.9104 21 18.9104Z"/>' +
    '<ellipse cx="16" cy="11" rx="1.5" ry="3"/><path d="M16 14L16 17"/>' },
}

/* The four Linux window-control glyphs, COMPLETE `<svg>` strings rather than
 * bodies (spike N §3.3).  Each one is Obsidian 1.13.7's own markup with two
 * changes and no others: `aria-hidden="false"` becomes `"true"`, because every
 * host here carries an `aria-label` and the glyph must not be announced twice,
 * and the stray space Obsidian leaves after `<svg …>` in two of them is gone.
 *
 * `fill="none"` is present on two and absent on two exactly as Obsidian writes
 * it.  It is INERT in all four cases (see the header: `fill` is inherited and
 * every shape below overrides it), and it is reproduced rather than normalised
 * because the claim this table makes is byte fidelity, not equivalence.
 *
 * `restore` replaces `maximize` while the window is maximized — Obsidian swaps
 * the same button's markup on every resize, and chrome.ts does the same on
 * `nc://window-state`. */
const W: Record<WindowIconName, string> = {
  'win-minimize':
    '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">' +
    '<rect fill="currentColor" width="10" height="1" x="1" y="6"></rect></svg>',
  'win-maximize':
    '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">' +
    '<rect width="9" height="9" x="1.5" y="1.5" fill="none" stroke="currentColor"></rect></svg>',
  'win-restore':
    '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">' +
    '<path d="M1.5 3.5H8.5V10.5H1.5V3.5Z" stroke="currentColor"/>' +
    '<path d="M4 2H10V8H9V9H11V1H3V3H4V2Z" fill="currentColor"/></svg>',
  'win-close':
    '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">' +
    '<path fill="currentColor" fill-rule="evenodd" d="M10.052 10.968 1.03 1.93l.849-.848 9.023 9.037-.849.848Z"/>' +
    '<path fill="currentColor" fill-rule="evenodd" d="M1.023 10.112 10.06 1.09l.848.85-9.037 9.023-.848-.85Z"/></svg>',
}

/** The one markup convention (spec-01 §8.3).  `aria-hidden` because every host
 *  already carries an `aria-label`. */
export function icon(name: IconName): string {
  const g = G[name]
  return `<svg width="${g.size}" height="${g.size}" viewBox="0 0 24 24" fill="none" ` +
         `stroke="currentColor" stroke-width="${g.stroke}" stroke-linecap="round" ` +
         `stroke-linejoin="round" aria-hidden="true">${g.body}</svg>`
}

/** A window-control glyph, verbatim.  Separate from `icon()` on purpose — see
 *  the comment on `W`. */
export function windowIcon(name: WindowIconName): string {
  return W[name]
}

/** §0.50 E98 — the tree chevron: Lucide `chevron-right`, 16px, stroke 2, the
 *  same literal `--chev` carried (tree.css's `sw:2 predicts sx 22` derivation
 *  is unchanged).  Built as ELEMENTS rather than a string because it is not a
 *  `[data-icon]` host — every pooled tree row owns one and tree.css shows it on
 *  `.d` — and `chrome-ui.test.mjs`'s both-ways list over `G` must not have to
 *  know about rows that exist only after a vault opens.  `stroke` is left to
 *  tree.css (`var(--text-faint)`), which is the colour the mask's
 *  `background-color` used to supply.  Measured against the mask it replaces at
 *  dpr 1.25: 0 of 2,040 channels differ at rest. */
export const CHEVRON_PATH = 'm9 18 6-6-6-6'
const SVG_NS = 'http://www.w3.org/2000/svg'
export function chevron(doc: Document = document): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg')
  svg.classList.add('chev')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  const path = doc.createElementNS(SVG_NS, 'path')
  path.setAttribute('d', CHEVRON_PATH)
  // `append`, not `appendChild`: the DOM shim under the frontend tests
  // implements the former on every node, and the two are equivalent here.
  svg.append(path)
  return svg
}

/** Fill every `[data-icon]` host in `root`.  This is the app's only innerHTML
 *  assignment, and its argument is always one of the literals above.
 *
 *  Both tables are consulted.  A host whose `data-icon` names neither is left
 *  ALONE rather than emptied: index.html ships hosts this pass does not own, and
 *  a fixture that still carries §9 E4a's omitted `panel-left` host must not have
 *  it emptied either. */
export function paintIcons(root: ParentNode = document): void {
  const hosts = root.querySelectorAll<HTMLElement>('[data-icon]')
  for (let i = 0; i < hosts.length; i++) {
    const el = hosts[i]
    if (!el) continue
    const name = el.dataset['icon']
    if (!name) continue
    if (name in G) el.innerHTML = icon(name as IconName)
    else if (name in W) el.innerHTML = windowIcon(name as WindowIconName)
  }
}
