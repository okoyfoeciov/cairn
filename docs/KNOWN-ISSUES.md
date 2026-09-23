# Known issues and leftovers

> **What this file is.** One place to look before asking *"is this a bug or was it left out on
> purpose?"* — every gap in the tree that somebody could reasonably mistake for a defect, and every
> defect that is real and unfixed. It is THE register: items carry stable IDs so they can be cited
> and closed by name.
>
> **What it is not.** It is not a ruling index and it does not override anything: `docs/CONTRACT.md
> §0` is the ruling index, and a measurement beats both. Nothing here is normative. Where an item
> was already recorded somewhere else, this file **points** at it and does not restate it, so that
> there is still only one copy of every fact.

---

## 1. The note viewer — live preview (§5.4.4, CONTRACT §0.23)

### LP-8 · An unresolved wikilink does nothing, where Obsidian creates the note 🟡

**Opened 2026-09-12 with CONTRACT §0.38 E85.** `[[a note that does not exist]]` is a no-op on click.
Obsidian creates the file (`getFirstLinkpathDest` misses → `fileManager.createNewFile`) and opens it.

Deliberate, on two grounds. It is a **write to the vault from a single click**, and LP-7 means Cairn
cannot draw the difference yet: every wikilink renders resolved, so the click that would create a file
looks exactly like the click that opens one. A write nobody can see coming is worse than a click that
does nothing.

*Closed by:* LP-7 first (so an unresolved link is visibly unresolved), then a decision about creating
files from a click — including where the new note goes when the link names no folder.

### LP-7 · Every wikilink renders RESOLVED, because nothing asks whether the note exists 🟡

**Opened 2026-09-12 with CONTRACT §0.36 E83.** `[[a note that does not exist]]` renders exactly like
one that does: `--link-color`, underlined, no distinction. Obsidian dims an unresolved link — its
decorator adds `is-unresolved`, and the sheet (`app.css:13495`) gives it `--link-unresolved-color`,
`--link-unresolved-opacity: 0.7` and a `--link-unresolved-decoration-color` that is 30% of the
accent — so a broken link is visibly broken there and is not here.

**THIS is the part that needs the metadata cache**, and it is worth being exact about, because
`livepreview.ts:20` used to name the cache as the reason the whole construct was absent: the cache
decides RESOLVED vs UNRESOLVED. Rendering never needed it. The decorator would need one lookup per
wikilink per rebuild — a name→path map the Rust core can answer from the tree it already holds — and
a decision about what "resolved" means when two notes share a basename.

*Closed by:* a name→path index the decorator can ask synchronously, plus the four `--link-unresolved-*`
tokens and the `is-unresolved` rule. **§0.38 E85 built half of it** — `TreeBlob.resolveLink` answers
exactly this question, in one pass over bytes — but on a CLICK, once. Running it per wikilink per
decoration rebuild is a different cost and needs its own measurement.

### LP-2 · Eight markdown constructs are absent, by decision

`src/livepreview.ts:20` names them: `![[embed]]`, `#tag`, `[^footnote]`, callouts, math, mermaid,
images, inline HTML. Each needs something the app does not have — a second parser or a renderer — so
the absence is scope, not oversight. `ConstructKind` is a union and §4 is a switch, so none of them is
structurally blocked.

### LP-11 · The task tick is the app's one remaining SVG image, and it can poison a strike 🟡

**Opened 2026-09-12 by §0.50 E98.** `.nc-task input[type=checkbox]:checked::after` is Obsidian's own
rule (app.css:14046 in 1.13.7): a `-webkit-mask-image` whose source is a 12×10 SVG data URL. It is
the same mechanism as the tree chevron's mask (CONTRACT §0.50 E98), and it was measured to poison — a bold strike populated right
after a tick's first paint came out unhacked, 3 of 3. It stays because Chromium snaps a CSS image's
destination rectangle to device pixels and the tick both apps draw is that snapped raster: an exact
vector `clip-path` missed it by 143 channels (max 95 of 255) and one that modelled the snap by 136
(max 68). **Exposure is narrow**: a checked task's FIRST paint in a process must be followed by a
style-time strike population (a `ch`-sized cell whose font description is new to the process) before
any main-document layout; with the chevron gone nothing paints an SVG image before the note, and a
note that carries both a tick and a table populates the table's strikes in the style pass BEFORE the
tick's paint. It is not nothing, and it is Obsidian's hazard too.

*Closes when:* the tick renders identically without an SVG image — either a `clip-path` whose
coordinates chrome.ts derives from the snapped device rectangle at the live dpr (the snap is
`round(origin)`, `round(far edge)`, then a stretch into that integer box; two static attempts got to
136 channels and no further), or a pre-warm that paints the tick once at boot and forces a layout
before the vault opens. `tests/frontend/no-svg-images.test.mjs` allowlists exactly this one rule and
says why.

### LP-12 · A doubly-mixed indent run is 0.05px narrower than Obsidian's 🟡

**Opened 2026-09-12 with CONTRACT §0.51 E99.** A list line whose leading indent mixes spaces and a
tab **more than once** — `"  \t  \t  "` — renders its run 95.05px wide against Obsidian's 95.10.
Every singly-mixed run (`"  \t  "`, `"\t  "`, `" \t"`) is identical, and so is every run of spaces
or tabs alone.

**Why.** Obsidian's splitting loop drops the tab that ends a partial group, and gets away with it
because the tab is still inside a `.cm-hmd-list-indent` wrapper whose `inline-block` re-origins its
tab stop at the start of the whole run. Cairn emits no wrapper, so it keeps that tab inside the group
it ended — which re-origins the stop at the start of **that group**. The two agree whenever every
group before the tab is 36-aligned, which a `.cm-indent` always is; they differ by the width of a
partial group once a *second* mixed group follows a first.

**Deliberate.** Closing it means reproducing the wrapper — a mark nesting a mark, whose CM6 ordering
is its own question — for an indent spelling that occurs zero times in the user's vault and that
Obsidian itself does not classify consistently (see LP-13). The residual is 0.05 CSS px, which is
1/20 of a device pixel at dpr 1.25 and cannot be rendered differently.

*Closed by:* a `.nc-li-indent` wrapper mark around the whole run, with the group marks nested inside
it, if some other rule ever needs the wrapper for its own reasons.

### LP-13 · Cairn calls `" \t- x"` a list line and Obsidian does not 🟡

**Opened 2026-09-12 with CONTRACT §0.51 E99**, found while measuring that pass and **not caused by
it**. A line indented by a space THEN a tab, carrying a bullet, is `cm-line nc-li` in Cairn and plain
`cm-line` in the live Obsidian 1.13.7 — its own list parser declines the line. Cairn's marker then
lands at 48 where Obsidian's text lands at 14.087, and Obsidian's number is what a line that is *not*
a list line gets: CM6's default `tab-size: 4` instead of `--list-indent`.

**It is a list-OPENER grammar difference, not an indent one**, which is why it is filed separately:
every number on both sides follows correctly from its own classification. Cairn's `LIST_OPENER_RE`
(`/^[ \t]*([*+-] |\d+[.)] )/`) accepts any mix of leading whitespace; what Obsidian's stream mode
requires there has not been read.

*Closed by:* reading Obsidian's own list-opening rule out of `lib/codemirror/markdown.js` and the
`hypermd` wrapper, and deciding whether to transcribe it — which is a bigger question than this shape,
because it also governs `LIST_PREFIX_RE` and §0.31 E75's hanging indent.

### LP-9 · A rendered table is read-only, where Obsidian's is editable 🟡

**Opened 2026-09-12 with CONTRACT §0.40 E87.** Obsidian's live-preview table is editable **in place**:
each cell is its own nested CodeMirror, which its own `.cm-table-widget .cm-scroller` rule gives away
— a scroller inside a table cell. Cairn's is a read-only widget.

It is not inert. The table reveals its markdown when the selection reaches it, which is §5.4.1's rule
for every other construct in the app, so a table is edited the way it is edited today — as markdown —
and it looks like Obsidian's the rest of the time. What is missing is typing in a cell.

*Closed by:* a per-cell editor, which is a much larger thing than the widget: a nested `EditorView`
per cell, its own selection and undo behaviour, and a mapping from cell edits back to the pipe row.
Worth pricing before starting.

### LP-3 · A paragraph longer than 200 lines or 20,000 characters renders its tail raw

`PARA_LOOKBACK = 200` (`src/livepreview.ts:578`) and `INLINE_SLICE = 20_000` (`:574`) bound the
paragraph-scoped inline scan so that seam rule 5 keeps binding. Past either bound the scanner stops
backing up, so a `**` that opened 201 lines earlier is not seen and its run renders with its
asterisks showing. **Nothing warns; it just looks unformatted.** The same bound applies to
frontmatter through `FM_MAX_LINES = 1000` (`src/livepreview.ts:284`), which is Cairn's and not Obsidian's — `tP` walks
to the end of the document.

Deliberate, and the trade is stated where the constants are. It is here because the failure is silent
and a reader who hits it will read it as a parser bug.

### LP-4 · The reveal is gated on `view.hasFocus`, so an unfocused window shows no markers

Obsidian's own behaviour (`v10 = t10.hasFocus ? … : []`, CONTRACT §0.23 E48) and therefore correct.
Recorded because it **cost a red G9 once** and will cost the next person the same hour: any harness
that asserts a revealed marker must take real window focus first, and `show()` alone does not do it —
`app-main.mjs` needs all three of `show()`, `focus()` and `webContents.focus()`.

### LP-16 · `--hr-color` is Obsidian 1.12.7's `#363636`; 1.13.7's is `#333333` 🟡

**Opened 2026-09-13 (candidate 2).** `src/styles/tokens.css:606` reads `--hr-color: #363636`, and its
comment cites 1.12.7's line numbers. In 1.13.7 the chain is `--hr-color` → `--background-modifier-border`
(app.css:2873) → `--color-base-30`, which is **`#333333`** (:2976). Measured:

| | rule pixels | computed `border-top-color` |
|---|---|---|
| Obsidian | `#333333` | `rgb(51,51,51)` |
| Cairn | `#363636` | `rgb(54,54,54)` |

No ruling keeps 1.12.7 for this token.

*Closed by:* re-reading the token from 1.13.7.

### LP-17 · The thematic break sits 1.78px low in its line 🟡

**Opened 2026-09-13 (candidate 3).** Within its 24px line, the top of the rule is at **11.00** in
Obsidian and **12.78** in Cairn: **+1.78px**.
- **Obsidian:** `.markdown-source-view.mod-cm6 .hr { display: flex; align-items: center }` (app.css:13028).
- **Cairn:** `.nc-hr-rule { display: inline-block; width: 100%; vertical-align: middle }`
  (`src/styles/editor.css:906`).

In absolute y the rule lands **+3.97px** low, which includes the drift LP-18 and PR-8 add above it.

No ruling covers it.

*Closed by:* Obsidian's flex centring, re-measured.

### LP-18 · The first list line after a heading keeps its top padding — MEASUREMENT CONTRADICTS CONTRACT §0.30.4 🔴

**Opened 2026-09-13 (candidate 4).** The 🔴 is for the conflict with the contract, not for the size;
1.19px is small. On the same note:

| | height | padding-top | padding-bottom |
|---|---|---|---|
| Obsidian | **25.19** | 0 | 1.2 |
| Cairn | **26.38** | 1.2 | 1.2 |

**Every line below it sits +1.19 low.** At dpr 1 those heights are exactly 25.1875 and 26.375, because
`--list-spacing: 1.2px` truncates to 1.1875 (§0.53 E103).

Obsidian's rule is:

```css
.cm-s-obsidian .cm-line.HyperMD-header + .cm-line:not(.HyperMD-header):not(:has(>br:only-child))
  { padding-top: var(--p-spacing-empty) }                       /* = 0, app.css:12873-12875 */
```

It outranks `.mod-cm6 .HyperMD-list-line.cm-line { padding-top: var(--list-spacing) }` (:13236).
Cairn's list padding is `src/styles/editor.css:668-670`, and Cairn has no counterpart to the rule.

> **THE CONTRACT SAYS THIS RULE CANNOT CHANGE A PIXEL. THE MEASUREMENT SAYS IT DOES.**
>
> **What the contract says.** CONTRACT §0.30.4 lists it as Obsidian's rule 2 and left it *"not
> transcribed, deliberately. It cancels a base `.cm-line` top padding that Cairn does not have, so
> writing it would be a rule that can never change a pixel."* §0.30.5 repeats the reason: *"no base
> line padding for the third rule to cancel"*.
>
> **Why it fails here.** That reason holds for a paragraph line. It does not hold for a list line,
> which carries a top padding of its own — `--list-spacing`, §0.35.1 E82 — and that is exactly what
> the rule cancels.
>
> **What this file does about it.** Following CLAUDE.md §1, the contract's words are **not rewritten
> here**. CONTRACT §0.53 E102 reports the conflict, with a dated note beside §0.30.4.

*Closed by:* transcribing rule 2. That is an app change, and it needs approval; the measurement has
already disposed of the stated reason not to.

### LP-19 · A task's checkbox and its text sit 4px right of Obsidian's 🟡

**Opened 2026-09-13 (candidate 5).** Checkbox x: **451.328** in Obsidian, **455.328** in Cairn —
**+4.000**, and the task's text moves by the same 4px.

Obsidian has `.markdown-source-view.mod-cm6 .task-list-label { padding: 0; margin-inline-start: -0.25em }`
(app.css:~14132); −0.25em is −4px at 16px. Cairn's `.nc-task` (`src/styles/editor.css:829`) has no
counterpart.

No ruling covers it.

*Closed by:* transcribing that negative margin.

### LP-20 · The task tick is white; Obsidian's is the ground colour 🟡

**Opened 2026-09-13 (candidate 6).** Measured: the tick in a ticked box is `#ffffff` in Cairn and
dark — the ground colour — in Obsidian.

**The cite is right about the line and wrong about what applies.** `src/styles/tokens.css:654` sets
`--checkbox-marker-color: var(--text-on-accent)` and cites `app.css:3254`. In 1.13.7 that declaration
(:3324) is scoped to `.attachments-gallery .download-attachment-item`. The value on `body` is
`var(--background-primary)` (:2158).

It is LP-11's tick: its mask stays, and only its colour is wrong. Once PR-6 is fixed, the Properties
checkbox will read the same token.

No ruling covers it.

*Closed by:* pointing the token at `--background-primary`.

### LP-21 · A rendered `[text](url)` has no external-link glyph, so the rest of its line sits 14.39px left 🟡

**Opened 2026-09-13 (candidate 10). Recorded nowhere before this pass.** Obsidian's `.external-link`
(app.css:13358) takes `padding-inline-end: 0.9em` = **14.4px**, plus a background glyph. Cairn's
`.nc-link` (`src/styles/editor.css:525-530`) has neither, so everything after the link on that line sits
**14.39px left** in Cairn.


> **THE FIX COLLIDES WITH A TEST'S RULE.** Obsidian's glyph is an SVG CSS image.
> `tests/frontend/no-svg-images.test.mjs` forbids those and allows exactly one, LP-11's tick. The rule
> exists because of §0.50 E98's strike-poisoning race.

*Closed by:* a ruling first. Either the allowlist takes a second SVG image, accepting LP-11's hazard,
or the glyph is drawn another way — as §0.50 E98 redrew the chevron as an inline `<svg>`.

### LP-22 · Cairn draws no list indentation guide, and nothing ever ruled it out 🟡

**Opened 2026-09-13 (candidate 11).** Obsidian draws a vertical guide beside a nested bullet; Cairn
draws none.

**The contract states that as a fact and never rules on it.** §0.35 E81 says *"Cairn
draws none"*, and gives it as the reason not to reproduce the `.cm-indent` split. **§0.51 E99 withdrew
that reason** (LP-6's postscript). What is left is an absence nobody decided.

This pass did not record the line of Obsidian's guide rule, and Cairn has no rule to cite.

*Closed by:* a user ruling: draw it, or record it as an omission.

### LP-23 · The editor has no bottom file margin: `scrollHeight` 1303 against Obsidian's 1333 🟡

**Opened 2026-09-13; measured outside every gated region.** Same note, `clientHeight` 924: the
scroller's `scrollHeight` is **1333** in Obsidian and **1303** in Cairn.
- **Obsidian** pads `.cm-scroller`'s bottom by `--file-margins`, which is 32.
- **Cairn's** bottom padding is `0`: `src/styles/editor.css:95`,
  `padding: var(--editor-inset-y) var(--editor-inset-x) 0 var(--editor-inset-x)`.

**You see it as a longer scrollbar thumb and a shorter maximum scroll.**

**The comment beside that line records a different gap.** spec-03 §8.2's `30vh` bottom padding is
STRUCK there, and *"the last line does not scroll to mid-pane"* is written down as a functional gap.
Obsidian's 32px bottom margin is not mentioned, so no recorded decision covers it.

*Closed by:* a 32px bottom padding on the scroller, re-measured.

---

## 2. The Properties block (§5.4.5, CONTRACT §0.24)

### PR-2 · The fold state is remembered per note-open, not per file

The fold lives in a `StateField` (`properties.ts:1051`), whose lifetime is the whole reason it is the
right home: a note switch is `view.setState(EditorState.create(…))` (M70), which builds a fresh field,
so the fold resets per note without anything having to notice a switch, and a document edit is a
transaction the field survives. The remembered state is applied as `display: none` directly, not by
running the animation — a fresh render has nothing to slide from.

**STILL OPEN, AND IT IS A FEATURE RATHER THAN A DEFECT:** Obsidian persists the fold **per file** —
`setCollapse` ends in `this.owner.onMarkdownFold()`, the same path that saves heading and list folds
into the vault's `workspace.json`. Cairn has no per-file fold store, and adding one is a new persisted
field in `state.json`. So the block remembers its fold for as long as the note is open and forgets it
on a switch.

### PR-3 · Three property features are absent, and each needs something upstream of it

`src/properties.ts:67` states them: **delete** (Obsidian puts it on a context menu, which is §0.13's
open ground), **list editing** for `tags` / `aliases` / any block sequence (gated by `isScalar`,
because a one-line write cannot reach a value that lives on the following lines), and the **type
picker / drag-reorder / vault-wide autocomplete** (all of which want a `metadataTypeManager` Cairn has
no equivalent of). The one-line-write rule in §4 of that file is what let the editing land without a
data-loss pass; whatever adds list editing has to keep it or earn its own pass.

### PR-4 · Two deliberate divergences from Obsidian, both stated in the source

- **`inferType(null)` is `'text'`, where `app.js:33085` gives `unknown`** (`src/properties.ts:285-302`).
  Obsidian never reaches that branch, because its type manager remembers a type per key across the
  vault; a literal transcription would render every empty `key:` as an orange `null` that cannot be
  edited, so a property you had just added could never be filled in.
- **`app.css:11188`'s `.is-collapsed .metadata-property { display: none }` is NOT copied**
  (`src/properties.ts:359`). With `setCollapse` adding the class before the slide runs, the two
  halves of Obsidian disagree, and copying both would reproduce exactly the abrupt fold the user
  reported. **This one is a guess that renders correctly, not a reading** — it is the item in this
  file most likely to be wrong, and the way to settle it is to watch the real app's rows during a
  collapse.

### PR-5 · The YAML subset refuses eleven constructs, and a duplicate key bails

Block scalars, anchors, aliases, explicit tags, tab indentation, two-level maps, sequences of maps,
flow mappings — `parseFrontmatter` returns `null` and the block renders raw in `--text-error`
(`.nc-fm-invalid`), which is Obsidian's own rule. Eleven bail cases are tested by name. **This is the
feature, not a gap** (§0.24 E50): a Properties panel that disagrees with the file is the failure this
design exists to prevent.

A duplicate key **bails at any level** — exact and case-sensitive, which is YAML's rule and
Obsidian's (asked of the live 1.13.7: `name:` twice and `a:` twice in a nested map both render raw and
invalid; `Name` and `name` together are two different keys). The parser bails rather than guessing.

### PR-6 · The Properties checkbox is the native macOS control 🟡

**Opened 2026-09-13 (candidate 7).** Measured on macOS at dpr 1 against Obsidian 1.13.7 (the method is
the note just above LP-16 in §1):

| | size | `appearance` | colour |
|---|---|---|---|
| Cairn | **13 × 13** | `auto` | `#0075ff` |
| Obsidian | **16 × 16** | `none` | `rgb(138,92,245)` |

Obsidian's box also takes `margin: var(--input-padding)`. Its rules are app.css:12360, plus the global
`input[type=checkbox]` rule at :14009.

Cairn's checkbox rules are scoped to `.nc-task input[type=checkbox]` (`src/styles/editor.css:820`), and
the property row's box matches none of them. **`editor.css:1214`'s comment is false**: it says the
checkbox *"reuses §5's task-box rules"*, and it does not. §0.24.6 E55 made the box toggle, so it works;
it is just unstyled.

No ruling covers it.

*Closed by:* giving the property checkbox Obsidian's global rule, together with LP-20's tick colour.

### PR-7 · A `date` property renders as plain text 🟡

**Opened 2026-09-13 (candidate 8). Recorded nowhere before this pass.** A value of `2026-09-01`:

- **Cairn:** a plain longtext div showing `2026-09-01`.
- **Obsidian:** `<input type=date class="metadata-input metadata-input-text mod-date">`, showing a
  **locale-formatted** `01/09/2026` with a calendar glyph and a link icon.

**Its pixels depend on the locale**, so a capture comparison against Obsidian moves with the
machine's locale and not with any app change — untested here.

No ruling covers it, and PR-3's list of absent property features does not name it.

*Closed by:* a date input, or a ruling that a date stays text.

### PR-8 · Property rows differ in height, so the body below the block sits 1px low 🟡

**Opened 2026-09-13 (candidate 9).** Measured row heights:

| | text | list | number | checkbox | date |
|---|---|---|---|---|---|
| Obsidian | 29 | 29 | 28 | 28 | 28 |
| Cairn | 29 | 28 | 29 | 28 | 29 |

Two causes, both READ from the DOM:
- **number and date:** Cairn uses longtext divs (29px), where Obsidian uses inputs (28px).
- **list:** Cairn has no trailing input (28 against 29). That half traces to **PR-3**.

The net is **+1.0px from `+ Add property` down** (320.19 against 321.19), so every body line under
the block sits one row low.

**A rigid pixel count cannot see a misregistered 1px feature vanish** (CONTRACT §0.53 E102): every
such feature under the block is already offset, so deleting one *lowers* the count.

*Closed by:* inputs for number and date (with PR-7), and PR-3's list editing for the list half.

---

## 3. Cross-cutting

### X-1 · `base.css`'s blanket `transition: none !important` is a rule whose reason was deleted

`src/styles/base.css:154`. §5.1 rule 5 is in force and was **not** unilaterally repealed, but its
stated rationale is §5.12.6's main-thread scroll path, which was WebKitGTK with async scrolling off —
an engine this repo deleted (§0.20.6 E35), whose successor sustains 105 fps (spike P). **THREE**
exemptions now exist, all carrying Obsidian's own numbers:

- two inside the Properties block, written as inline `!important` because **a stylesheet
  `!important` outranks a normal inline style** (§0.24.5 E53);
- `tree.css`'s `.tr.d::before`, the folder chevron's `transform 100ms ease-in-out` (§0.44 E90),
  written as a **stylesheet** `!important` — which wins because between two author `!important`
  declarations the cascade falls back to **specificity**, and `.tr.d::before` (0,2,1) outranks
  `*::before` (0,0,1). Its duration is `var(--chev-ms, 0ms)` and not a literal, because the tree's
  rows are POOLED: a blanket transition animates a slot that merely changed which node it draws.

So there are now two *different* ways round this rule and a third case (§0.24.5's dead checkbox
`box-shadow`) that nobody has bothered to rescue. **And the same failure mode is not confined to this
rule**: §0.45 E93 found `caret-color` had been silently outranked by CM6's own base theme since the
editor was first mounted, so the caret rendered white against a token marked `[M]`. Four occurrences
now, three mechanisms (a blanket `!important`, an inline style losing to one, and a base-theme
selector at higher specificity). **When a declaration looks right and the pixels disagree, read the
computed style before re-reading the source.** Anything else that needs to animate will hit the
same wall silently, and the list grows each time.

*Closed by:* a ruling — either the rule stands as an aesthetic choice, or it goes and the exemption
list goes with it.

### X-5 · Two UI absences that are decisions, and one that is a gap

Restated in one place only because each has been "fixed" by mistake before — the full reasoning is
CLAUDE.md §2 and the contract sections it names. **Collapse all is gone** (§0.12) and
`tree.collapseAll()` is callerless. **A network vault has no refresh at all** (§0.12.2) and its
banner must not be drawn while `watching` is true.

**③ THERE IS NO CONTEXT MENU ANYWHERE THE APP DOES NOT DRAW ONE, AND ON ELECTRON THAT INCLUDES THE
EDITOR.** The old note here said the engine's menu remained reachable as a fallback; that was true
of WebKitGTK, which drew Back / Forward / Reload / Inspect Element on its own. **Electron draws no
default context menu at all** — `app-main.mjs` registers no `context-menu` handler, verified — so a
right-click over the editor, the search panel, the tab strip or the vault bar now shows *nothing*,
and with it goes the only mouse-driven cut/copy/paste the app had. The tree's own row menus still
work (`tree.ts`'s own `contextmenu` listener). The Reload exposure is gone with the menu; what
replaces cut/copy/paste is an open question. CONTRACT §0.13 describes the old stack and needs a
ruling.

### X-6 · "Reveal in Finder" errors on Debian, and the button is still there — by ruling

`fsops::reveal_in_os` has a macOS arm and nothing else, so on Debian command 20 answers a §1.5 `io`.
`main.ts:671`'s delete-failure dialog still offers `Show in Finder`, so **the button is reachable and
pressing it produces an error toast** — the shape §9 E4 forbids, standing here because the user ruled
it: *"Fuck this feature. Just show an error, for all. Don't over engineer this app"* (CONTRACT §0.25.1
E59, 2026-09-10). The label still says *Finder* on a machine that has none.

**Not a task.** §0.20.2's costed fix (`org.freedesktop.FileManager1.ShowItems` over D-Bus with an
`xdg-open`-the-parent fallback) is cancelled, not deferred. It is here so the next person reads the
error as a decision rather than as a regression to fix.

### X-10 · `forget_vault` given a non-canonical spelling of the open vault is a silent no-op 🟡

**Opened 2026-09-13 (CONTRACT §0.53 E106, candidate 13). The UI cannot reach it.** Call command 21
with a `/var/…` spelling, or with a symlink, of the vault that is OPEN, and it returns `ok: true` and
**does nothing** — it neither refuses nor forgets. Both spellings were measured through the addon on
macOS.

The Rust function is `core/src/app.rs:557`. `open_vault` stores the root canonicalised, on purpose;
`core/src/prefs.rs:33-54` says so: *"IF YOU ADD A CALLER, CANONICALISE BEFORE YOU CALL"*.

**It was found through a test, not through the app.** `native.test.mjs`'s §0.30 E70 row built its
vault under `os.tmpdir()`. On a Mac that path begins `/var/folders/…`, and `/var` is a symlink to
`/private/var`. The row then compared that raw spelling with the canonical root in recents. So it
failed on macOS, and passes on Debian, where `/tmp` is a real directory. The test now
`realpathSync`s its work directory and is 22/22.

**Why no data is at risk:** every root the frontend hands to command 21 comes out of
`recent_vaults`, which already holds the canonical spelling.

**One more quirk, INFERRED, NOT MEASURED:** `switchTo` (`src/vaultbar.ts:137`) compares the raw
`pick_vault` path with the canonical `current.root`. So picking a symlink spelling of the open vault
would release it and reopen it, where it should do nothing. The release flushes first, so nothing is
lost. Whether macOS's open panel even returns such a spelling was not measured.

*Closed by:* canonicalising `root` inside `app::forget_vault` before the comparison, with a fallback
to the raw string so a deleted vault can still be forgotten. That is a `core/` change and needs
approval. Otherwise, a ruling that an unreachable quirk stays recorded.

### UI-1 · Cairn has no unfocused window state; Obsidian has one

Obsidian dims two things when its window loses focus, and Cairn dims neither. Its title strip goes
from `--background-secondary-alt` to `--background-secondary` (`app.css:3998-4006`, keyed on
`body.is-focused`), and its active tab's label goes from `--text-normal` to `--text-muted`
(`:6132-6143`, keyed on `body.is-focused .mod-active`). Cairn always draws the focused values.

Found while diagnosing the user's Cairn-vs-Obsidian tab screenshots on 2026-09-10 (CONTRACT §0.26.3):
the two crops differed in strip grey (`#333333` vs `#282828`) and label grey (`#dadada` vs `#b3b3b3`),
and both differences are this — **that Obsidian window was not focused.** They read as palette
defects, which is why they are written down here rather than left to be re-diagnosed.

*Closed by:* a focus class on `body` (Electron's `browser-window-focus`/`-blur`, or the page's own
`window.onfocus`), plus the two token rows. Small, and nobody has ruled on whether an unfocused state
is wanted — Cairn is single-pane, so `.mod-active` has no analogue and only the `is-focused` half
applies.

**The practical cost was measured 2026-09-13** (CONTRACT §0.53 E101): an unfocused Obsidian looks
like a palette defect — the strip reads `#282828` against Cairn's `#333333` and the label `#b3b3b3`
against `#dadada` — so any future capture comparison must record focus first and refuse a shot
without it. In the 1.13.7 asar the focus rules are at **app.css:~4112-4123**, and 1.13.7's
`--color-base-30` is `#333333` (:2976), so a focused Obsidian's strip is exactly Cairn's colour.

### UI-4 · `--shadow-popover` is not Obsidian's modal shadow, and §5.1's "one permitted shadow" is false

**The modal half is TAKEN** (measured 2026-09-14): `src/modal.ts:194` draws Obsidian's own
`--shadow-l`, the three-layer value under `.modal-container.mod-dim .modal` (app.css:8894/2944) —
which is the dimming confirm case Cairn's modal is. See `tokens.css:212-225` for the value and the
light/dark twins.

**What remains is the token and two consumers.** `--shadow-popover` (`tokens.css:199`, the single
`0 2px 8px`) still backs:

- `src/main.ts:227` — the `promptForName` dialog;
- `src/styles/chrome.css:910` — `.inline-edit-msg`.

So the app draws two different shadows, and `tokens.css:199`'s comment ("the one permitted shadow",
from §5.1) is stale: it describes one, and a second is now measured and in use. Either those two
consumers take a measured token of their own, or §5.1's sentence gets an erratum.

*Closed by:* a measurement for the inline-message/prompt shadow, or a ruling that it does not matter.

### UI-5 · The menu's drop shadow differs by ≤ 2 of 255 in a synthetic A/B

Below any gate. Recorded so nobody re-runs it: the interiors are pixel-identical, the diff is the two
harness DOCUMENTS and not the two menus (substituting Obsidian's literal shadow changes nothing), and
the pixel region that would have settled it is gone with that gate.

### UI-6 · The list bullet's disc anti-aliases ≤ 6 of 255 differently from Obsidian's

CONTRACT §0.52 E100 put the disc on Obsidian's device column; what is left is edge coverage — 16
pixels over an 11×10 region differ, max 6 of 255, same grounds and size in both. Below any gate.

### UI-7 · `-webkit-font-smoothing: antialiased` is Cairn's, not Obsidian's 🟡

**Opened 2026-09-13 (candidate 1).** Cairn declares it twice: `src/styles/base.css:58` and
`src/styles/editor.css:176`. **Obsidian 1.13.7's `app.css` declares no font smoothing anywhere.** The
declaration came from `docs/spec-01-visual.md:371` (*"grayscale AA, matches macOS default"*), which
is design detail and not a ruling.

**Measured on macOS at dpr 1, on Cairn-only captures:** both declarations were flipped to `auto`,
captured, then restored byte-identical. Differing pixels against Obsidian:

| capture region | `antialiased` | `auto` |
|---|---|---|
| `note body` region | 29,709 | 25,368 |
| Properties crop | 5,111 | 2,768 |
| `tab strip` region | 500 | 302 |
| `vault bar` region | 486 | 329 |
| `tree band` region | 2,993 | 2,800 |
| `sidebar column` region | 4,683 | 4,333 |

**So the 2026-09-09 account — *"the residual is Blink coverage, no CSS reaches it"* — is only
partly true on macOS.** One declaration reaches every region.

**Two things were NOT measured: the mechanism, and the effect on Linux.** The Debian comparison
that would have to be repeated recorded the property as inert there (CONTRACT §0.50 E98's
investigation); it neither confirms nor refutes this.

*Closed by:* removing both declarations, or a user ruling that they stay.

### UI-8 · Tree labels sit ~1px low inside their rows 🟡

**Opened 2026-09-13 (candidate 12).** Measured on macOS at dpr 1, in the same 27px row slot: every
tree label's ink centroid sits **+1.00 to +1.06px lower in Cairn** than in Obsidian. That holds on all
7 rows, with identical row-to-row spacing — so the rows are placed right and the text inside them is
not. **G9 cannot see it**, because it measures box edges. It is part of the `tree band` capture
residual (2,993 px).

**THE CAUSE IS INFERRED FROM CSS, NOT ISOLATED.** The two rows are built differently:
- **Cairn:** `line-height: var(--row-h)` = 27px (`src/styles/tree.css:211`), with a 25px hover/active
  fill drawn by a 2px inset shadow (`:376`).
- **Obsidian:** `padding-top` 4, `line-height` 1.3 and `margin-bottom` 2 (app.css:10353-10363).

Read that way, the offset dates from the scaffold and affects every platform. But the first diagnosis
also left an engine cause open — baseline snapping in Chrome 142 against 150 — and nothing has ruled
that out.

*Closed by:* a measurement that separates the CSS from the engine, then a fix. Debian is the cleaner
place to take it: its Obsidian runs Cairn's own pinned Chrome 142 (§0.52 E100).

### UI-9 · No ruling omits Obsidian's status bar or its view header 🟡

**Opened 2026-09-13.** Cairn draws neither, and **no ruling says it should not.** CONTRACT §0.22.5
E43 notes only that Obsidian's status bar *"has no counterpart"*; it describes the absence and does
not decide it. Any future comparison must account for both — Obsidian's view header off via its own
`showViewHeader` setting, its status bar present — with a region boundary, never a CSS mask standing
in for an omission nobody ruled on.

*Closed by:* a user ruling on each.

### UI-10 · On macOS the editor's scrollbar gutter is unsettled: line box 1432 in Cairn, 1444 in Obsidian 🟡

**Opened 2026-09-13; measured outside the gated regions.** At dpr 1 on the Mac, the editor's line box
is **1432** in Cairn and **1444** in Obsidian. The 12px difference is the gutter §0.37 E84 transcribed.

**E84's own reading does not cover macOS.** It quotes Obsidian's 12px as *"live on every platform but
macOS"* (`rd.isMacOS || document.body.addClass("styled-scrollbars")`), and on this Mac Obsidian's body
has no `styled-scrollbars` class. Cairn reserves the 12px on every platform.

**It is not simply a defect, because Obsidian's own macOS gutter moved between runs.** Under the
overlay scrollbar, the hr's last ink column was 1872 in one capture and 1887 in another. That is also
why the `note body` region stopped at column 1871. Nobody has measured the right macOS value with the
system's scroll-bar setting held fixed.

*Closed by:* measuring Obsidian's macOS gutter with the system's *show scroll bars* setting pinned,
then a ruling on whether Cairn's editor gutter becomes per-platform.

---

### X-12 · K6 — `contextIsolation` is a product ruling, still undecided

CONTRACT §0.20 E30 records it as entangled with the addon's byte path and **NOT decided here**.
Obsidian ships `contextIsolation:false, nodeIntegration:true`; Cairn ships
`contextIsolation:true, nodeIntegration:false, sandbox:true`, which is safer and more work. The K4
measurement made it a performance question as well as a security one: the ipcMain structured clone is
81% of the frontend's blob wait, and that cost is a consequence of loading the addon in the main
process — which is what keeps the renderer's `nodeIntegration` off. **Decide deliberately; do not
inherit it by accident.**

*Closed by:* a user ruling, recorded in CONTRACT §0.20.

### X-13 · No in-note find, no non-`.md` rows, and search is `.md`-only

**Opened 2026-09-23.** Three absences, one subject — what the app can look at. Obsidian's Mod-F finds
inside the open note; Cairn binds Mod-Shift-F (the vault-wide panel) and has no in-note find at all.
The tree hides every entry that is not a directory or a regular `*.md` (§3.6, `scan.rs`), so a `.txt`
or `.pdf` beside a note is not listed and cannot be opened from the app. Search greps `.md` files
only, for the same reason. Each is a decision by construction, and none has a ruling of its own.

*Closed by:* a user ruling on each, or the feature.

### UI-11 · Mod-N with the cursor on a folder creates the note in the folder's PARENT

**Reported, not changed** — the source says so at `main.ts`'s `newNote`. `destinationFor(_, false)`
computed beside-the-cursor before §0.16 E18 deleted it; with the cursor ON A FOLDER the note lands in
that folder's parent, which is not what E18's own model would predict. Changing a keyboard shortcut's
destination is not a silent edit, so it is recorded here.

*Closed by:* a ruling on which side of the folder row Mod-N means.

### UI-12 · `Copy absolute path` uses `navigator.clipboard`, where command 23 `copy_text` exists for exactly that failure

`main.ts`'s `copyAbsolutePath` calls `navigator.clipboard.writeText` straight from the click. The
TOTP work measured that this path FAILS in this app's own harness runs — *"Document is not focused"* —
and added §1.3 command 23 (`copy_text`, shell-implemented in the main process) for it; the totp and
secrets rows use the command, and this row does not. On a window that never took focus the copy
silently does nothing until the user pastes.

*Closed by:* routing this row through command 23 like the other two copiers.

### UI-13 · The tree keyboard ring is one column short, and a yak's glyph ink escapes the row by 2px

Both are stated in `tree.css`'s cursor-ring comment and recorded here for visibility. (1) When the row
fill does not reach the scroller's right edge, the ring's right side wants x 400..401 and x 401 is
Cairn's reserved gutter, so it is clipped (Obsidian reserves none and draws it). (2) The ring's 2px
`overflow-clip-margin` also lets label glyph ink out by 2px, so a name built from stacked combining
marks paints into its neighbours while it is the keyboard row. Both need a layout change (an inner
clip box for the text) rather than a token.

*Closed by:* the inner text box, or rulings that neither matters.

## 4. What is verified, and what only looks it

### V-4 · The hit-test probe samples 30px into a text rect, which can land on a glyph midpoint

`app-main.mjs`'s `CAIRN_LP_PROBE` hit-test phase (the guard for §0.26 E62) picks its sample point as
`x = rect.left + min(30, rect.width / 2)`. That is an arbitrary offset into the row, and on some
strings it lands within half a glyph of a character boundary — where `caretRangeFromPoint` and
`posAtCoords` round to opposite sides and the row reports a mismatch of ONE position.

Found 2026-09-12 (CONTRACT §0.31.4) by adding `1. an ordered item …` to the fixture: one mismatch,
`cm 421 / dom 420`, **and the same mismatch with the feature under test removed.**

**It is not a false alarm about the thing the guard guards.** A stale height map shifts every row
below the offending element by whole lines — tens of positions, many rows — which is what E62
measured. A single ±1 on a single row is the sampling, and telling them apart is one run with the
change backed out.

Not fixed because the fix is a change to the guard itself (sample at a rect edge, or at several x per
row and require agreement at all of them), and that is worth doing deliberately rather than in the
middle of a feature. **Do not widen the assertion's tolerance to admit a ±1** — that blunts the one
row standing between this app and E62's defect.

*Closed by:* a sampling rule that cannot land on a boundary.

### V-6 · Above 120 Hz, scroll-bench's `fps` and `deficit` measure its synthetic driver, not the app 🟡

**Opened 2026-09-13.** The full account is `docs/spike-S-scroll-on-electron.md` §11 (and CONTRACT §0.53). On the Mac's
144 Hz panel (Dell AW2725DM, dpr 1), the bench reported a 16.8% deficit, and **none of it is Cairn's.**
The comparison was like-for-like and MEASURED: a 2560×1319 window at dpr 1, 50,500 notes, median of runs 2-5.

| | fps of 143.97 Hz | deficit | dropped | handler p99 | step_cv | uneven |
|---|---|---|---|---|---|---|
| Cairn | 119.75 | 16.84% | 0.5 | 0.167 ms | 8.49% | 0.42% |
| live Obsidian 1.13.7 | 118.41 | 17.77% | 6 | 6.26 ms | 18.90% | 2.59% |

A driver that delivers exactly 120 events a second caps the deficit at **1 − 120/143.97 = 16.65%**.

**The cause is READ in Chromium's source.** `Input.synthesizeScrollGesture` dispatches an event every 8.333 ms:
- `content/browser/renderer_host/input/synthetic_gesture_target_base.cc` hard-codes a 16667 µs vsync.
- The controller halves that for high-frequency dispatch.
- `SyntheticGestureTargetMac` does not override it.
- The controller is byte-identical in Chrome 142 and 150, and `GetVSyncParameters()` is the same code in
  both: `:111-116` in 142, `:114-119` in 150. `target_base.cc` differs between the two tags only by three
  `#include` lines that Chrome 150 adds above it. So both apps share the cap (spike S §11.4).

What was MEASURED:
- cc's own trace gives `vsync_interval_ms` 6.946 (143.97 Hz), and the display link fires at about 144/s.
- Wheel events arrive at 120.2/s.
- **Driven by a trusted CDP wheel at 144/s, Cairn's tree presents 143.99 fps, with 0/864 janky frames and 0 dropped.**

**What the same runs still tell you:** §5.12.6(d)'s handler budget passed in every run. **What they do not:** the
begin-frame → submit pairing printed `paired=false` in every run, so this build of the bench cannot
report the app-controlled frame cost. Spike S §10's Debian figure, 115.70 of 120, came from a panel at the driver's
own rate, so the cap could not show there (inferred).

*Closed by:* a scroll driver that is not capped at 120 Hz. Until then, quote `fps` and `deficit` only
from a panel at or below 120 Hz.

## 5. Traps that cost real time here — read before measuring

Not defects. Recorded because each one produced a **confident wrong answer** before it was found, and
each will do it again.

| Trap | Where it is written up |
|---|---|
| Five mechanisms that fail as **a hang with no output** on this shell | CONTRACT §0.20.1 |
| A backtick in a comment inside `executeJavaScript(\`…\`)` — same symptom, one file out. Now caught in 40 ms by `tests/frontend/shell-syntax.test.mjs` | CONTRACT §0.24.10 |
| A **skip is a third kind of green**: no summary line separates "16 skipped" from "16 that cannot fail here" | CONTRACT §0.22.2 E40 |
| **A test that reads the wrong file cannot fail**, and neither can a feature nobody has executed | CONTRACT §0.20.6.1 E36 |
| Screenshot colour is **framebuffer bytes, not colour**, without `--force-color-profile=srgb` | CONTRACT §0.22.5 |
| A **relative unit declared twice down one chain is applied twice** — `0.875em` on both the cell and its child is 12.25px | CONTRACT §0.24.9 E58 |
| **A settle scroll is not neutral.** Scrolling the document twice before reading a line height re-creates every line's DOM, and the re-created lines take whatever strikes are cached — which is why four passes of the 0.8px-line investigation read 24.0 in instances that would have read 24.8. Read the first render, then settle | CONTRACT §0.50.5 E98 |
| **A font strike remembers the device scale it was born under.** Blink's strike scale is a process-wide static that ANY view's `LayoutRoot` rewrites, and an SVG loaded as a CSS image is a view of its own at scale 1.0. A probe that lays out to measure cannot see it — the layout rewrites the static first; only a style-time population (`min-width: 6ch`) observes the transient | CONTRACT §0.50.2–3 E98 |
| A **threshold measurement cannot see a flex-shrink**: the left edge said 0.25px off, the centroid said 1.2 | CONTRACT §0.24.7 E56 |
| **When the question is "what does Obsidian do", read Obsidian** — it is an Electron app and its `app.js` / `app.css` are text. Four rulings settled by derivation were overturned in one pass | CONTRACT §0.17 |
| **CM6 measures BORDER BOXES.** A CSS margin inside `.cm-content` is real to the layout and invisible to the height map, and `posAtCoords` resolves clicks through the map — so the caret lands below the pointer and nothing about the DOM, the CSS or the decorations looks wrong | CONTRACT §0.26.1 E62 |
| **Two sidebars can look identically placed at the seam and put the tab on different device pixels.** The tab's left edge is `pane + 18` CSS = `pane + 22.5` DEVICE px at dpr 1.25 — dead on a rounding boundary — so ~0.4 CSS px of sidebar difference flips it, while the seam itself rounds to the same column either way. Measured identical in Cairn and Obsidian at every width, so it is never a Cairn defect: **compare only at an identical `sidebar_w`, both windows maximized** | CONTRACT §0.26.4 |
| **A `Page.captureScreenshot` clip at a fractional CSS x resets the rasteriser's sub-pixel phase**, so it cannot see a sub-device-pixel offset at all. Clip from the WINDOW ORIGIN (`x: 0`) and use absolute device columns | CONTRACT §0.26.4 |
| **CM6 reports ESTIMATED block heights until it has measured them.** A scroll-walk comparing line positions down a note produced a clean 230.9px "jump" at one line and a 489px total-height difference — both artefacts: the same Cairn instance reported `scrollHeight` 3836 then 4902 for the same note, and the "jump" put two consecutive source lines out of order. **A height read from a document CM6 has not finished measuring is not a measurement** | CONTRACT §0.42.3 |
| **A FRESH Obsidian profile is not a neutral reference — it is a different configuration.** The first measurement taken with `tools/obsidian-live.mjs` reported a 1-device-pixel difference in the Properties block's gap, with a confident explanation attached. Both were the test profile's own defaults: `readableLineLength: true` (the user's vault says `false`) capped its content column at 700px against Cairn's 1064, a property value wrapped onto extra lines, and everything below moved 21px. With the vault's `app.json` copied in and the sidebar set to 412 on both sides, **every number matches to the sub-device-pixel**. §0.26.4's "compare only at an identical `sidebar_w`" has a second half: **and at identical SETTINGS** | CONTRACT §0.41.1 |
| **A 7px thumb can hide a 12px track.** `--scrollbar-gutter-w: 8px` was tagged `[M]` and read off the VISIBLE thumb, which is 7px wide in both apps by two different routes (Obsidian: a 12px track less a `3px 3px 3px 2px` transparent border; Cairn: an 8px track less a 1px one). The 4px that differs is invisible track — and it is reserved by `scrollbar-gutter: stable`, so it comes out of `.cm-content` and moves where every line WRAPS. Found by a user photographing one url breaking one unit early. **Ink is not the box**, now four times over | CONTRACT §0.37 E84 |
| **A cap-height band inverted through a font ratio has now been wrong three times** — `--h1-size` 29, the E12 font diagnosis, and the 12px tab label. The screenshots were never rendered in Inter | CONTRACT §0.19 E24, §0.18 E23, §0.26 E63 |
| **CDP emulation is not a rasterisation scale.** On a dpr-1 Mac, `Emulation` alone made `devicePixelRatio` read 1.25, while a 1.2px box still laid out on the host's grid at 1.1875. A `contain: paint` / `none` A/B differed in **0 of 2,892,000 px**. With the real `--force-device-scale-factor`, the box is 1.2000000477 and 8,372 px differ. A test that needs a fractional scale must launch at one, and must assert the raster, not `devicePixelRatio` | CONTRACT §0.53 E104 |
| **A CSS-px number can move with dpr.** Chromium lays out in 1/64 of a DEVICE pixel and truncates, so `1.2px` of padding is 1.1875 at dpr 1 and 1.2 at 1.25. That is how the "fixed" 26.4 / 25.2 line boxes failed on the Mac. An inline-block's text width snaps UP instead. Derive the expected value from the page and its dpr; never fold one in from one machine | CONTRACT §0.53 E103 |
| **A rigid pixel diff cannot see a misregistered 1px feature vanish — its count goes DOWN.** One pixel of drift under the Properties block meant that deleting strikethrough *lowered* a region count (29,709 → 29,693), and it passed. **A lower number is not evidence that anything was fixed** | CONTRACT §0.53 E102 |
| **An unfocused Obsidian looks like a palette defect.** Another app took the front 3 s before a capture: the strip read `#282828` against Cairn's `#333333`, and the tab strip "failed" at 86.9%. Record focus with the capture, and refuse a shot without it | CONTRACT §0.53 E101, UI-1 |
