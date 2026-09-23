# spec-03 — CodeMirror 6 live-preview editor

> **Normative for:** the editor pane's internals — the CM6 extension set, the block scanner and its
> `StateField`, the live-preview decoration mechanism, the *rule bodies* in `editor.css`, the frontend
> save/flush state machine, per-note cursor memory, and this document's own test suite
> (`tests/frontend/*.test.mjs`).
>
> **Defers to `docs/CONTRACT.md`**, which is normative and overrides this document wherever they
> disagree. *Every section number in the rest of this paragraph is CONTRACT.md's:* the IPC command
> table and shared types (§1), the note read/write byte frame (§2), the flush-on-quit handshake
> (§1.6), the vault-switch ordering and `EditorView` lifetime (§4.3), design tokens (§5.1), the
> editor surface and code-block geometry (§5.3), the heading ladder and the construct rules
> (§5.4, §5.4.1–§5.4.5), the verification harness (§5.11), the dependency pins (§6.3), the file table
> (§6.4), the acceptance gates (§6.5), and every data-loss rule including autosave, note-size and
> UTF-8 policy (§7).

A bare `§N` means a section of **this** document.

Owns: `src/editor.ts`, `src/livepreview.ts`, `src/tables.ts`, `src/properties.ts`, `src/totp.ts`,
`editor.css`'s rule bodies, the save pipeline, and the frontend test suite for all of the above.
Does not own: the sidebar and file tree, the search UI, the vault switcher, the window chrome/tab
strip, the frontend build, `ipc.ts`, `note_frame.js`, or anything in Rust.

**The reference PNGs `1.png` and `2.png` no longer exist, and nothing here is derived from them.**
Every surviving geometry number is CONTRACT.md's, measured in the pinned engine or read from the
live Obsidian.

---

## 1. What "live preview" means here (scope)

There is **one editing surface** — no preview mode, no source/preview toggle. Live preview renders a
fixed construct set and nothing else:

| Group | Constructs |
|---|---|
| Block | ATX heading, fenced code block, thematic break, blockquote (nested), bullet list, ordered list |
| Inline | bold, italic, bold-italic, strikethrough, `==highlight==`, inline code, `[text](url)`, `<autolink>`, `[[wikilink]]`, a bare URL or email, backslash escape, task checkbox |
| Block widgets | the inline title (§5.5), the Properties block (`properties.ts`), markdown tables (`tables.ts`), the `totp` fenced block (`totp.ts`) |

**Deliberately absent:** `![[embed]]` (renders a note Cairn cannot render), `#tag`, `[^footnote]`,
callouts, math, mermaid, images and inline HTML. Each needs something Cairn does not have — a
renderer or a second parser — not a shape the mechanism cannot hold: `ConstructKind` is a union and
the decoration switch is one arm per kind.

Normative for the shape of each construct's rendering: CONTRACT.md §5.3 (code blocks), §5.4
(headings), §5.4.1 (marker reveal), §5.4.2 (the inline title), §5.4.4 (the inline construct set),
§5.4.5 (the Properties block). This document owns *how* they are found and decorated, not how they
look.

---

## 2. Package set

### 2.1 Bundle variants

**§2.1. (DELETED — the bundle-variant table served only the retired JS size gate; the shipped
`package.json` and CONTRACT §6.3 are the source of truth for what is installed.)**

### 2.2 Decision: hand-rolled scanner, no markdown language package

**No `@codemirror/language` import, no `@lezer/markdown`, no `@codemirror/lang-markdown`.**

**The decisive reason is what Obsidian itself does:** its live preview runs on a CodeMirror 5 stream
mode (`window.CodeMirror.defineMode("hypermd", …)`, wrapping the stock markdown mode) inside
`StreamLanguage` — it does not use `@lezer/markdown` at all. `livepreview.ts` transcribes that mode,
so the scanner and the tokeniser are the reference implementation, not an approximation of one.

The supporting reasons:

1. **Bundle:** `@codemirror/lang-markdown` is ~250 kB of minified JS — it pulls `lang-html`,
   `lang-css`, `lang-javascript` and `@lezer/*`, because it highlights embedded code blocks. We
   render no syntax highlighting.
2. **Runtime memory:** a Lezer tree is the real cost, not the code; the replacement state is a flat
   array of fence descriptors — ~260 kB for a synthetic 5 MB / 67,301-line document, under 3 kB for
   a typical note.
3. **Cold start:** the JS bundle is the cold-start lever (CONTRACT.md §8.4), and this is the one
   package decision still decisive there.
4. **Correctness is not at risk:** the scanner implements the subset we render, and everything
   outside it renders as literal text either way.

`@codemirror/language` still appears in the dependency graph transitively — `@codemirror/commands`
depends on it — but it is shaken down to the few hundred bytes `history` and `standardKeymap`
actually reach. **Do not import from it directly**; that is what re-inflates the bundle.

### 2.3 Dependencies

**Normative: see CONTRACT.md §6.3** and `package.json`.

Pin exactly (no `^`). CodeMirror ships breaking-ish view changes in patch releases often enough that
a pixel-identical target cannot float. Upgrade deliberately, and re-run the geometry harness and the
performance checks afterwards.

**Never add:** `codemirror` (the meta-package — it pulls autocomplete, lint, search and language),
`@codemirror/lang-markdown`, `@lezer/markdown`, a direct `@codemirror/language`, `@codemirror/search`,
`@codemirror/autocomplete`, `@codemirror/lint`, `@lezer/highlight`. §7.2 gives the per-package
reason.

---

## 3. Module layout

**§3. (DELETED — the planned `src/editor/` directory does not exist; the editor's code is
`src/editor.ts`, `src/livepreview.ts`, `src/tables.ts`, `src/properties.ts`, `src/totp.ts` and
`src/tabstrip.ts`, and the public surface is listed in §7.1.)**

---

## 4. The markdown model

### 4.1 Headings — exact rule

```ts
// Applied to at most the first 8 characters of a line, never the whole line (§5.3).
const HEADING_RE = /^(#{1,6})[ \t]/
```

* ATX only. `#Title` (no space) is **not** a heading — CommonMark agrees, and it keeps `#tag`-looking
  text plain.
* Leading spaces are **not** allowed. CommonMark allows up to 3; we require column 0. Rationale: the
  slice-8 fast path stays a pure prefix test, and indented headings are vanishingly rare.
* A closing sequence (`## Title ##`) is not stripped — the trailing hashes stay visible, consistent
  with "markers stay literal".
* **Setext headings (`Title` + `====`) are not supported.** They need two-line lookahead, and a `---`
  underline is ambiguous with a thematic break and a list item.
* A line inside a fenced code block is never a heading, regardless of the regex. Code membership is
  tested first.

### 4.2 Fences — exact rule

```ts
// Evaluated against the first 200 chars of a line at most.
// group 1 = the run of fence characters, group 2 = the info string
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/
```

Pairing follows CommonMark:

* An **opening** fence is any match. If group 1 is backticks, group 2 must not contain a backtick
  (otherwise it is not a fence at all — e.g. `` ```a`b `` is plain text).
* A **closing** fence must use the same character as the opener, be at least as long, and have an
  empty (whitespace-only) info string.
* An unclosed opening fence runs to the end of the document. This matches CommonMark and Obsidian, and
  it is the behaviour you want while typing — the box appears the moment you type the third backtick.
* **Indented (4-space) code blocks are not rendered as boxes.** They are ambiguous with list
  continuation and would fight the "lists are literal text" rule.

### 4.3 Line endings and the BOM

**Normative: see CONTRACT.md §2.4.** Rust owns both halves of the round trip; the editor never sees a
BOM, never sees a `\r`, and never converts anything. The only obligation on this side is to echo
`NoteRead.flags` back verbatim in the `writeNote` call (§9.4).

---

## 5. Decoration mechanism

### 5.1 The block index — a StateField, incrementally maintained

The hard problem in any viewport-only markdown decorator is: *the first visible line might be in the
middle of a code block, and you cannot tell without looking backwards.* Scanning backwards to the
document start is O(doc) per repaint. So the fence positions live in a `StateField` that is updated
incrementally and can be binary-searched.

```ts
// livepreview.ts

/** One fence line. `pos` is the line's start offset; `lineLen` is invariant under
 *  changes outside the line, so the line's end is always pos + lineLen. */
interface Fence {
  pos: number
  lineLen: number
  ch: 96 | 126        // charCode of ` or ~
  len: number         // how many fence characters
  hasInfo: boolean    // non-empty info string → can only open, never close
}

interface Block { from: number; to: number }   // to = end offset of the closing fence line

export class BlockIndex {
  readonly fences: readonly Fence[]
  readonly blocks: readonly Block[]

  static scanAll(doc: Text): BlockIndex

  /** Returns the block containing `pos`, or null. O(log B) binary search. */
  blockAt(pos: number): Block | null

  /** Incremental update; see algorithm below. */
  applyChanges(tr: Transaction): BlockIndex
}

export const blockIndex: StateField<BlockIndex> = StateField.define<BlockIndex>({
  create: state => BlockIndex.scanAll(state.doc),
  update: (value, tr) => tr.docChanged ? value.applyChanges(tr) : value
})
```

**`applyChanges` algorithm** (this is the whole trick — read it carefully):

```
1. Collapse the ChangeSet to one span in each coordinate system:
     tr.changes.iterChanges((fa,ta,fb,tb) => {
       fromA=min(fromA,fa); toA=max(toA,ta); fromB=min(fromB,fb); toB=max(toB,tb) })
2. Expand to whole lines:
     oldLo = oldDoc.lineAt(fromA).from   oldHi = oldDoc.lineAt(toA).to
     newLo = newDoc.lineAt(fromB).from   newHi = newDoc.lineAt(toB).to
3. head = fences with pos <  oldLo            (offsets unchanged — they precede every change)
   tail = fences with pos >  oldHi, each mapped with tr.changes.mapPos(pos, -1)
   (everything between oldLo and oldHi is discarded and re-derived)
4. mid  = scan newDoc line-by-line over [newLo, newHi] with FENCE_RE
5. fences = head ++ mid ++ tail          (already ascending; no sort)
6. blocks = pair(fences)                 (one linear pass, §4.2 rules)
```

Step 3's `mapPos` on the tail and step 6's pairing are the only pieces that are O(number of fences)
rather than O(1). Measured cost of both, on the 5 MB / 5,384-fence document, is in §6.3: **0.04 ms**.

A refinement is available and deliberately **not** taken: skipping the whole update when the typed
character is not `` ` ``/`~`/`#` and the touched line was already known to be plain. At 0.04 ms it is
not worth the state it would require. Boring wins.

### 5.2 Heading markers: hidden by default, revealed on the caret line

**Normative: see CONTRACT.md §5.4.1.** The marker is **hidden by default and revealed, in
`--text-faint`, on the heading line the primary selection intersects** — Obsidian's behaviour, and
the only one that lets a user see and edit the level they are actually editing.

```ts
// livepreview.ts
const HIDE_MARK = Decoration.replace({})
const SHOW_MARK = Decoration.mark({ class: 'nc-md-marker' })

// selectionTouchesLine: any range r where r.from <= line.to && r.to >= line.from.
// Ranges, not just the head, so a selection spanning the line reveals its marker.
function selectionTouchesLine(sel: EditorSelection, line: Line): boolean
```

Two consequences the plugin carries, both mandatory:

* **`|| u.selectionSet` in `update()`** (§5.3) — decorations are no longer a pure function of the
  document, so a cursor move must rebuild them. Measured cost: **0.017 ms** per rebuild.
* **`livePreviewAtomicRanges`**, a second, much smaller range set holding only the runs that
  VANISH, handed to `EditorView.atomicRanges`. Handing CM6 the whole decoration set — the obvious
  construction — makes a REVEALED marker atomic too (`skipAtomicRanges` does not filter on
  `point` or `isReplace`), and the caret could not be placed inside the very marker the rule reveals
  so it can be edited. A marker that is re-drawn in place (a list bullet, a first-level `>`) is not
  in this set, because the character is still on screen and the caret must sit beside it.

Copy/paste is unaffected: `Decoration.replace` hides glyphs, it does not change the document, so
`state.sliceDoc()` and the clipboard always carry the raw `# Heading`.

### 5.3 The ViewPlugin

These `Decoration` objects are created **once at module load and reused forever**. This is not
cosmetic: CM6 diffs decoration sets by value identity when deciding which DOM lines to touch, so
allocating fresh `Decoration.line({class:"nc-h1"})` objects per rebuild would defeat that diff and
force DOM churn on every keystroke.

Notes that matter:

* `visibleRanges`, not `viewport` — it excludes ranges CM6 has decided not to render.
* Line decorations must be added at `line.from` with `from === to`, in ascending order.
  `RangeSetBuilder` throws otherwise; the loop guarantees it. The marker decoration is added
  **immediately after** the line decoration at the same `from`, which keeps the builder's ordering
  invariant (equal `from`, and a zero-length line decoration sorts before a non-zero-length one).
* `doc.sliceString(line.from, line.from + 8)` allocates an 8-character string per visible non-code
  line per rebuild. At ~200 visible lines that is 200 tiny short-lived strings — nursery garbage, and
  it is the price of never touching `Line.text` on a pathological line.
* Code lines never have their text read at all.
* Every code line — opening fence, body, closing fence — gets `nc-cb`. There is no separate fence
  class and no dimming, because CONTRACT.md §5.3 makes fence lines ordinary code lines; the *only*
  thing distinguishing them is the corner radius they inherit from `nc-cb-first` / `nc-cb-last`.
* A scroll must not force a decoration rebuild on the same frame; §7.3's scheduling rule covers it.

### 5.4 Why this does not walk the document per keystroke

Four independent reasons, each necessary:

1. **Decorations are built for `view.visibleRanges` only.** CM6 renders the viewport plus a margin;
   at 1080px and 24px lines that is roughly 45 visible + ~150 margin lines, so ≤ ~200 iterations
   regardless of whether the note is 2 kB or 8 MiB.
2. **"Am I inside a code block?" is a binary search**, not a backwards scan, because the block index
   is precomputed and kept current.
3. **The block index update touches only the changed lines** plus an O(F) array copy and an O(F)
   pairing pass, where F is the number of fence lines in the document (not lines, not characters).
4. **There is no parser.** Nothing else in the extension set walks the document — no syntax tree, no
   highlighter, no lint pass, no bracket matcher.

`doc.lineAt()` is O(log n) on CM6's rope, so even the per-line lookups in step 1 are cheap on a huge
document.

### 5.5 The inline title

**The note's filename is rendered as an inline title above the content, at the H1 tokens, and
clicking it renames the note. Normative: see CONTRACT.md §5.4.2.**

**Mechanism.** A CodeMirror **block widget** decorated at document position 0 —
`Decoration.widget({ block: true, side: -1 })`, class `.nc-title`, `ignoreEvent: () => false` so its
click reaches our handler — and **not** a DOM node injected into `.cm-scroller` by hand. The widget
route is what keeps the title inside CM6's own layout and height map, which is what keeps the first
body line's box top exact. It is **not part of the document**: never in `state.doc`, never typed
into, never saved, never sent to `write_note`.

```ts
// livepreview.ts
class TitleWidget extends WidgetType {
  constructor(readonly base: string) { super() }        // basename WITHOUT ".md"
  eq(o: TitleWidget) { return o.base === this.base }    // no rebuild while the name is unchanged
  ignoreEvent() { return false }
  toDOM() { /* <div class="nc-title">{base}</div> */ }
}
export const titleField: StateField<DecorationSet>     // one widget at pos 0, or Decoration.none
```

Its geometry and its tokens are CONTRACT.md §5.4.2's; `editor.css` carries the rule body.

**A document that genuinely begins with an H1.** The title is rendered from the *filename*, always,
and the document is rendered *unchanged* — nothing is hidden, stripped or promoted. A note whose
first line is `# Misc` therefore shows the title "Misc" and then an H1 "Misc" below it. That is
Obsidian's behaviour under its default settings and it is the only rule that never edits the user's
bytes to make the screen tidier (CONTRACT.md §2.4).

**Clicking it renames.** One click — not a double-click, and not a drag — swaps the widget's contents
for an `<input class="nc-title-edit">` of the same metrics, pre-filled with the basename **without**
`.md` and fully selected:

* keystrokes are filtered by the **same `beforeinput` handler as the tree's rename editor**
  (CONTRACT.md §7.3 case 11): rejected characters never land, and the field flashes `.bad` in
  `--text-error` for 200 ms;
* `Enter` commits via `renameEntry(activePath, name + ".md")`; `Escape` cancels; blur commits;
* on success, take `RenameResult.path` and update `activePath`, the tab label and the title from it —
  never from a locally computed string. Rust has already updated `AppState.open_note` under the write
  lock, and §9.6's cursor-LRU entry is re-keyed in the same transaction;
* on `invalidName` / `alreadyExists` **the editor stays open** with the message inline — nothing is
  silently accepted-then-rejected;
* **while the editor is open the buffer keeps autosaving to the OLD path.** A rename never flushes
  and a flush never renames; the two paths do not interact. This is the one rule that keeps the
  rename affordance out of the save pipeline entirely.

With no note open there is no title and the widget is not created.

---

## 6. Measured performance

All figures measured on this machine (node v20.20.2, esbuild 0.28.2) against a synthetic
**5,243,509-byte, 67,301-line, 5,384-fence** markdown document. Chromium should land within ~2× of
these.

The fixture is 0.63× the **8 MiB** hard cap (CONTRACT.md §7.3 case 15), so the worst *legal* note
scales these rows by **×1.6**. Scaled figures are derived, not measured, and are marked as such.

### 6.1 Load path

| Operation | Time | At the 8 MiB cap (derived ×1.6) |
|---|---:|---:|
| `Text.of(src.split("\n"))` (5 MB) | **7.8 ms** | ~12.5 ms |
| `EditorState.create({doc})` | 0.3 ms | ~0.5 ms |
| Full fence scan, raw-string index loop | **2.7 ms** | ~4.3 ms |
| Full fence scan via `Text.iter()` | 6.9 ms | ~11.0 ms |

The raw-string scanner is 2.5× faster than iterating CM6 lines, but it needs the source string, which
only exists at load time. **Therefore: run `BlockIndex.scanAll` from the decoded source string on
open** (2.7 ms), and use the `Text`-based scanner only for the incremental re-scan of a few lines.

### 6.2 Save path

| Operation | Time | At the 8 MiB cap (derived ×1.6) |
|---|---:|---:|
| `state.doc.toString()` (5 MB) | **3.4 ms** | ~5.4 ms |
| `new TextEncoder().encode(...)` | 2.1 ms | ~3.4 ms |

These two are the *entire* JS-side cost of a save, because the bytes go out raw (§9.3). There is no
JSON escape step and no second converted copy.

### 6.3 Per-keystroke path

| Operation (1,000 iterations, 5 MB doc) | Per keystroke |
|---|---:|
| transaction + `mapPos` over all 5,384 fences | **0.040 ms** |
| transaction + binary-search shift of the tail only | 0.011 ms |
| build an 80-line `DecorationSet` | **0.017 ms** |

Worst-case total added work per keystroke: **~0.06 ms**, against a 16.7 ms frame. The simple
`mapPos`-everything version is chosen over the binary-search version — 0.029 ms is not worth the extra
code path. This row does not scale with note size: it is bounded by the fence count and the viewport.

### 6.4 Memory

**§6.4. (DELETED — the memory budget and the WebKit compositing figures this section carried were
retired with the memory thesis; the live numbers are CONTRACT §8.)**

---

## 7. Extension configuration

### 7.1 The exact state

`EXTENSIONS` in `src/editor.ts` (the list is normative; the shell calls `mountEditor`,
`openNote`, `showEmpty`, `isDirty`, `focusEditor` and `flushNow` from the same file):

```ts
const editable = new Compartment()            // §9.5 flips this, never rebuilds the view

const EXTENSIONS: Extension[] = [
  blockIndex,                                   // §5.1
  livePreview,                                  // §5.3 — decorations + the marker reveal
  EditorView.domEventHandlers({ drop, dragover }), // refuses file drops and foreign drags
  linkClicks,                                   // CONTRACT §5.4.4 — the click policy
  listHangingIndent,                            // CONTRACT §5.4.4 — the wrapped-line hang
  titleField,                                   // §5.5
  properties,                                   // CONTRACT §5.4.5
  tables,                                       // a table renders as a table
  totp,                                         // the totp fenced block
  livePreviewAtomicRanges,                      // §5.2 — step OVER a hidden run, never a revealed one
  EditorView.lineWrapping,                      // required: no horizontal scrolling anywhere
  scrollPastEnd,                                // our own, measured; not the @codemirror/view one
  EditorView.darkTheme.of(true),                // marks the editor dark; adds NO CSS (see §8)
  history({ minDepth: 40, newGroupDelay: 400 }),
  keymap.of([
    ...historyKeymap,
    ...standardKeymap,
    { key: "Tab",       run: insertIndent,  shift: removeIndent, preventDefault: true },
    { key: "Mod-s",     run: () => { void flushNow("manual"); return true } },
  ]),
  EditorState.tabSize.of(4),
  editable.of([]),                              // [] = editable; the compartment's other two states are §9.5's
  EditorView.contentAttributes.of({
    spellcheck: "false",
    autocorrect: "off",
    autocapitalize: "off",
    translate: "no",
    "aria-label": "Note editor",
  }),
  EditorView.updateListener.of(onUpdate),        // dirty flag + debounce scheduling (§9)
]
```

**`insertIndent`/`removeIndent` use `indentMore` semantics, not a fixed four spaces at each caret.**
Obsidian's Tab is CodeMirror's `indentMore`/`indentLess`, bound unconditionally: it indents or
unindents the LINES a selection touches, and there is no caret branch. Inserting at `range.from` and
replacing to `range.to` — the obvious construction — replaces a non-empty selection with four
spaces, which is data loss; the transcribed `changeBySelectedLine` is what prevents it. The local
helpers exist because `indentMore` cannot be borrowed from `@codemirror/commands` without taking that
package's `indentUnit` facet, and with it `@codemirror/language`, into the bundle.

One recorded divergence: the unit is four spaces where Obsidian writes a tab (`useTab: true`,
`tabSize: 4`). Both render at the same width — an indent level is quantised to `--list-indent` — so
this changes the bytes written into the user's file and nothing on screen. Four spaces is the
pinned behaviour.

`Mod-s` must return `true` so Chromium does not open its own save dialog.

The `editable` compartment is the mechanism behind every non-editable state in §9.5: **three states,
not two** — no note open is `EditorView.editable.of(false)` (the only one that removes
`contenteditable`, and with it the native caret); `detached` and `vault-lost` are
`EditorState.readOnly.of(true)` and keep their caret and selection so the text can be copied out;
`live` and `conflict` are editable. Reconfiguring a compartment is a transaction, not a new view —
CONTRACT.md §4.3 allows exactly one `EditorView` for the process lifetime.

### 7.2 Every extension we deliberately do not include

CM6 is opt-in, so "disabling" mostly means "never importing". The list is explicit because a future
contributor will be tempted by each one.

| Extension | Verdict | Reason |
|---|---|---|
| `@codemirror/autocomplete` | **Out** | There is no completion source: wikilinks render as links but are not completed, and `closeBrackets` would fight literal markdown typing (`[`, `` ` ``). |
| `@codemirror/search` | **Out** | "Search" in the feature list is the vault-wide Rust search, not in-note find. **No in-note find exists** — a recorded functional gap. |
| `@codemirror/lint` | **Out** | Nothing to lint. |
| `@codemirror/language` (direct import) | **Out** | It is the doorway to `HighlightStyle`, `syntaxTree` and `StreamLanguage`, all unnecessary (§2.2). |
| `codeFolding` / `foldGutter` | **Out** | Not in the feature list; folding needs a language or a custom `foldService`, and fold state is per-document memory. |
| `bracketMatching` | **Out** | Lives in `@codemirror/language`. Adds a per-selection-change decoration pass and a scan for nothing markdown needs. |
| `lineNumbers` / any gutter | **Out** | The reference has none. A gutter is a whole extra DOM column CM6 must lay out per viewport update. |
| `highlightActiveLine` | **Out** | The recorded samples show a uniform `#1c1c1c` around the caret — Obsidian's active-line highlight is off in this theme. Also one more decoration set to recompute per cursor move. |
| `highlightSpecialChars` | **Out** | Adds a per-viewport regex scan and widget decorations for control characters that will not appear in these notes. |
| `drawSelection` | **Out** | +6.4 kB and, per CM6's own docs, "an extra DOM layout cycle for many updates". |
| `rectangularSelection` / `crosshairCursor` | **Out** | Not in scope. |
| `placeholder` | **Out** | A placeholder decoration would be a second, editor-level empty state. There is no empty-state line at all in the shell: with no note open the pane is EMPTY, which is what Obsidian shows. |
| `defaultKeymap` | **Out**, `standardKeymap` instead | `defaultKeymap` buys `Mod-/` comment toggling (needs a language), line moving and `Mod-[`/`Mod-]` indentation. `standardKeymap` already covers arrows, word motion, `Home`/`End`, `Enter`, `Mod-a`, `Backspace`/`Delete`, `Mod-Backspace`, and the macOS emacs bindings. |
| `history` | **IN** | Undo is not optional and CM6 suppresses the browser's native undo. Configured `minDepth: 40, newGroupDelay: 400`. CM6's history stores `ChangeSet`s, not document snapshots, so its footprint is proportional to *edited* text, not document size. It is discarded wholesale on note switch (§9.3). |
| `EditorState.allowMultipleSelections` | **Left false** (default) | Fewer ranges to map and draw on every transaction. |

**Optionality gaps that are decisions, not oversights:** indented (4-space) code blocks are not
rendered as boxes (§4.2), setext headings are not supported and headings must start at column 0
(§4.1), and lists do not auto-continue on Enter — lists are decorations over literal text, and
auto-continuation would be the only rich-text behaviour for a construct that is otherwise literal.

**On `drawSelection`.** We use the browser's native selection and caret, styled with `caret-color`
and `::selection`. CM6's base theme already ships `.cm-cursor { display: none }`, so the cursor layer
is inert unless `drawSelection` is added — the native caret is what you get by default, and Chromium
honours `caret-color` and `::selection` inside `contenteditable`. The known cosmetic difference is
that a native multi-line selection does not extend past the end of a line to the right edge of the
content column. Accepted.

### 7.3 Single-surface obligations

**§7.3. (DELETED — the WebKit single-surface preference and the `vscroll.ts` fallback it guarded
belong to the retired stack. The editor still treats every synchronous main-thread task as a
scrolling cost: decoration rebuilds, the marker reveal and autosave serialisation must not run
synchronously in a frame in which a scroll is in flight. Autosave's 800 ms debounce already gives it
somewhere else to go; the marker reveal is driven by `selectionSet`, which a scroll does not raise.)**

---

## 8. The editor's CSS

**Decision: the editor's CSS lives in the static `editor.css`, not in an `EditorView.theme(...)`
call.** `EditorView.theme` is CSS-in-JS: it builds a stylesheet through StyleMod at construction time,
costs JS bytes and startup work, and generates obfuscated class names that make inspection painful.
`EditorView.darkTheme.of(true)` gives us the one thing the theme facet is actually needed for —
telling CM6's base theme to use its `&dark` rules — for zero CSS-in-JS.

CM6's base theme is still injected at runtime by `style-mod`, so the document's stylesheet policy
must allow it (see the shell's CSP, CONTRACT.md §6.1). Without that allowance CodeMirror renders
completely unstyled.

Two CM6 base-theme defaults are the reason the sheet's reset exists, and are worth knowing when
debugging: `.cm-line`'s base padding is `0 2px 0 6px` (it would shift every line 6px right) and
`.cm-scroller`'s base is `monospace / 1.4`.

### 8.1 Tokens

**Normative: see CONTRACT.md §5.1.** `tokens.css` is the only declaration site in the project;
`editor.css` declares no custom property and consumes the tokens by name. No web fonts: zero font
bytes to embed, zero font memory, and one less thing between cold start and first paint; the stacks
are `--font-text` and `--font-mono`.

### 8.2 The editor surface

**Normative: see CONTRACT.md §5.3.** It owns the scroller padding, the reserved scrollbar gutter,
the scrollbar rules, and the `.cm-content` / `.cm-line` reset. Do not restate any of them here. The
`::-webkit-scrollbar` selector MUST name `.cm-scroller` and never an ancestor — an ancestor rule
leaves CM6's real scroller on the 17px legacy scrollbar.

### 8.3 Headings

**Normative: see CONTRACT.md §5.4.** Sizes, weights, line-heights and letter-spacings are declared
in `tokens.css`; the rule bodies are this document's. The heading rules MUST appear **after** the
`.cm-line` reset in `editor.css`, because `.cm-line` and `.nc-hN` have equal specificity and source
order decides.

Heading spacing is **padding, never margin**: CM6's height map measures a block's border box and is
blind to margins, so a margin on a `.cm-line` moves the caret without moving the map. The space above
a heading is `--heading-space-before` on the shared `.nc-h` class; there is no space below a heading.

The revealed marker `.nc-md-marker` is **colour only** — it is a mark decoration *inside* an `.nc-hN`
line and inherits its font-size and weight, which is what CONTRACT.md §5.4.1 rule 2 requires. No
background, no transition.

### 8.4 Code blocks

**Normative: see CONTRACT.md §5.3.** It gives the complete `.nc-cb` / `.nc-cb-first` / `.nc-cb-last` /
`.nc-cb-only` rules: no margin, horizontal padding only, mono at `--fs-code` / `--lh-code`,
`--bg-primary-alt`, `--text-normal` including the fence lines, no border, `--radius-s` corners.
`editor.css` writes those rules and adds nothing.

Because the box has **no vertical padding**, the first and last lines of the box are the fence lines
themselves, which is why `nc-cb-first` / `nc-cb-last` / `nc-cb-only` carry the corner radii and no
widget or spacer line is ever inserted. There is **no syntax highlighting** inside a code block — a
settled decision, not an open question.

---

## 9. The save pipeline

### 9.1 Timing

**Normative: see CONTRACT.md §7.2.** The frontend obligation, the 800 ms / 5 s pair, the unconditional
flush points and the maximum loss window are all stated there and are not restated here.

The wiring that implements it is this document's:

```ts
const IDLE_MS = 800     // quiet period after the last keystroke
const MAX_MS  = 5000    // ceiling, from the FIRST unsaved keystroke
```

* Every `update.docChanged` sets `dirty = true`, restarts the idle timer, and starts the ceiling
  timer **only if it is not already running** — the ceiling is measured from the first unsaved
  keystroke, not from the last.
* Whichever fires first calls `flush()`. Both timers are cleared on flush, on `openNote`, and on
  every path in §9.5 that stops autosave.
* The serialise step must not land on a frame in which a scroll is in flight (§7.3). The debounce
  already gives it somewhere else to go; this is a scheduling rule, not a new timer.
* There is deliberately **no journal / WAL / crash-recovery file** — it would need either a second
  in-memory copy of the buffer or a disk write per keystroke, and CONTRACT.md §7.2 has already sized
  the risk it would cover.

### 9.2 The flush points

| Trigger | Wiring |
|---|---|
| idle 800 ms / ceiling 5 s | the timers above |
| **note switch** | `await flushNow("switch")` **before** `view.setState(...)`. On rejection the switch is aborted and the error is shown. |
| **vault switch** | step 1 of CONTRACT.md §4.3's sequence, which aborts the switch on rejection. |
| **window blur** | `window.addEventListener("blur", () => void flushNow("blur"))` |
| **tab/window hidden** | `document.addEventListener("visibilitychange", …)` when `document.hidden` |
| **quit / window close** | Normative: see CONTRACT.md §1.6. |
| **delete of the open note** | Normative: see CONTRACT.md §7.3 case 3. The editor's obligation is step 1 (cancel both timers) before the delete is invoked, and the empty state afterwards. |
| **manual** | `Mod-s`, which also returns `true` to suppress the browser's own save dialog |
| **an inline-title rename (§5.5)** | **NOT a flush point.** A rename never flushes and a flush never renames; while the title editor is open the buffer keeps autosaving to the *old* path (CONTRACT.md §5.4.2). |

The close handshake's frontend half is `editor.ts`'s `onFlushAndClose()`, registered by the shell
against `nc://flush-and-close` through `ipc.ts`. It blurs any Properties field being typed (whose
text lives in widget DOM until commit), cancels both timers, and flushes:

```ts
export async function onFlushAndClose(): Promise<{ ok: true } | { ok: false; kind: string }> {
  cancelTimers()
  commitFocusedWidgetEditor()
  try { await flushNow("close") }
  catch (e) { return { ok: false, kind: (e as VaultError).kind } }
  // A resolved flush is not proof of a write: a conflicted or detached note
  // resolves "skipped" with the buffer intact. Report it as a refusal.
  if (dirty) return { ok: false, kind: (lastError ?? conflict).kind }
  return { ok: true }
}
```

The rules are CONTRACT.md §1.6's, including which failures cancel the close: a flush that RESOLVES
permits the close; a flush that REJECTS cancels it and shows the cannot-save modal; only a flush that
has not returned at all falls through to the shell's watchdog.

A failed write **cancels the close** and surfaces the reason. There is no unconditional watchdog: it
could not tell a hung disk from a write the backend actively refused, and a user with a conflict bar
on screen — the exact situation in which the buffer is the only copy of their edits — must not lose
everything on ⌘Q with no dialog.

### 9.3 No extra copies in memory

The guarantee is structural, not defensive:

* **Dirtiness comes from CM6, not from comparison.** `update.docChanged` is authoritative, so there is
  never a "pristine copy" held for diffing.
* **A flush holds exactly two transient copies**, both nursery garbage before the next debounce
  window: `view.state.doc.toString()` (3.4 ms at 5 MB) and `new TextEncoder().encode(text)` (2.1 ms).
  Nothing else. The bytes are the top-level bridge payload (CONTRACT.md §2.3), so there is **no**
  JSON escape, no reparse, and no Rust-side `String`.
* **The inline title is never in the document** (§5.5), so it costs the save path nothing.
* **CRLF and BOM restoration happen in Rust** (CONTRACT.md §2.4), so JS never allocates a converted
  copy.
* **Note switch uses `view.setState()`**, which drops the old `EditorState`, its rope, its history and
  its block index in one go. Exactly one `EditorView` exists for the process lifetime; CONTRACT.md
  §4.3 makes that normative and applies it to vault switch as well.

### 9.4 What the editor holds per open note

**Normative for the wire: see CONTRACT.md §1.3 (commands 8 and 9), §1.5 (`NoteRead`,
`WriteReceipt`, `VaultError`) and §2 (the byte frame).** The frame is decoded by `note_frame.js`
(owner 02) and this document MUST NOT restate a byte offset.

The editor's per-note state, and nothing more:

```ts
interface OpenNote {
  path:        VaultPath   // updated in place on an in-app rename — from the tree's menu
                           // (CONTRACT.md §7.3 case 4) or from the inline title (§5.5)
  baseMtimeMs: number      // from NoteRead.mtimeMs; replaced by WriteReceipt.mtimeMs after each
                           // write. BOTH are camelCase: CONTRACT.md §1.1's one casing rule
                           // makes every wire field camelCase, errors included.
  flags:       number      // from NoteRead.flags; echoed VERBATIM into every writeNote call
  bytes:       number      // for the too-large branch and the external-change comparison
}
```

Every autosave, idle flush, blur flush and close flush calls
`writeNote(path, text, flags, baseMtimeMs, /* create */ false)`. **`create` is `false` on every one
of those paths** — CONTRACT.md §7.1 rule 1 is what makes the resurrection bug impossible by
construction, and this document's save path is the caller that must not weaken it.

**There is exactly one `create: true` in the whole app, and it is this document's**: the
**Save as…** button on §9.5's `detached` bar. With `create: true` an **existing** destination comes
back `alreadyExists` (CONTRACT.md §7.1 step 1c), so neither value of the header can silently destroy
a file.

`baseMtimeMs` is sent as-is; it becomes `null` (force-overwrite) in exactly two places — when the
user picks *Keep mine* on a conflict bar, and on the Save-as write, which has no base to conflict
against.

### 9.5 When the note stops being the note (external change, conflict, detachment)

The editor is the declared consumer of `nc://note-external-change` (CONTRACT.md §1.4). These states
are the editor's implementation of CONTRACT.md §7.3 cases 5, 7 and 8; the invariants, the mechanisms
and the exact bar copy are the contract's, not restated here.

| State | Entered when | autosave | `editable` compartment | CONTRACT.md |
|---|---|---|---|---|
| `live` | normal | on | editable | — |
| `conflict` | a write rejects with `kind: "conflict"` | **stopped for that note** | editable | §7.2, §7.3 case 7 |
| `detached` | the tree module reports, after a rebuild, that the open path no longer resolves — renamed or removed outside the app | **stopped** | `EditorState.readOnly.of(true)` | §7.3 case 5 |
| `vault-lost` | `nc://vault-lost` (chrome owns the banner; the editor owns the buffer) | **stopped** | `EditorState.readOnly.of(true)` | §7.3 case 8 |
| *no note* | `open === null` | off | `EditorView.editable.of(false)` | §7.4 |

The editor does **not** listen to `nc://tree-changed` — CONTRACT.md §1.4 gives that event to the
tree and to search. The tree calls into the editor when a rebuild orphans the open path; that one
call is the whole `detached` trigger.

**`Save as…` — the `detached` bar's left button, specified.** The bar reads
`This note was renamed or removed outside the app. [ Save as… ] [ Discard ]`, and **`Save as…` is the
app's Save-As**: the only producer of `x-create: '1'` anywhere. It opens the same inline name editor
as a rename (`validate_name`, the `beforeinput` filter, the `.bad` flash in `--text-error`),
defaulted to the note's old basename and rooted at the old parent folder. On commit:

```ts
const r = await writeNote(newPath, text, flags, /* baseMtimeMs */ null, /* create */ true)
```

An existing destination comes back `alreadyExists` and **the editor stays open**. On success the
frontend adopts `newPath` as `activePath`, updates the tab label and the inline title (§5.5), clears
the bar, and resumes autosave against the new path with `r.mtimeMs` as the new base. `[ Discard ]`
drops the buffer to the empty state and **writes nothing, ever**.

Two editor-side rules that follow and that no other document states:

* **A clean buffer reloads silently.** On `nc://note-external-change` for the open path with
  `dirty === false`, the editor re-reads the note and calls `view.setState(...)`, preserving the
  cursor through §9.6's LRU. With `dirty === true` it does nothing at all until the next write
  refuses — the conflict guard is the detector, not the event.
* **Leaving `conflict` is a user action, never a timer.** *Keep mine* re-writes with
  `baseMtimeMs = null`; *Reload from disk* discards the buffer after re-reading. Either way autosave
  restarts only after the write or the reload succeeds.

### 9.6 Per-note cursor memory

A bounded LRU of the last **20** notes' `{ anchor, head, scrollTop }` (three numbers each, ~40 bytes
per entry, 800 bytes total) restores the caret and scroll position when you come back to a note. It
stores numbers only — never an `EditorState`, which would pin a whole document.

Keyed by `VaultPath`, which means two upkeep rules:

* **On an in-app rename** of the open note or one of its ancestors — whether it came from the tree's
  menu or from §5.5's inline title — re-key the entry from `RenameResult.path` in the same
  transaction that updates `OpenNote.path`, the tab label and the title (CONTRACT.md §7.3 case 4,
  §5.4.2). A stale key is not a correctness bug, but it silently loses the caret.
* **On delete**, evict the entry. A recreated path is a different note.

---

## 10. Large notes

**The cap is normative: see CONTRACT.md §7.3 case 15 — `MAX_NOTE_BYTES = 8 MiB`, refused with
`VaultError::TooLarge { path, bytes, limit }`.**

**Every note the app will open therefore fits in 8 MiB, and one opens normally. No virtualisation
beyond CM6's built-in viewport rendering is needed or wanted.**

What actually happens, with §6's numbers scaled to the cap:

* Decode + `Text.of` + fence scan: **~11 ms** measured at 5 MB, **~17 ms** derived at 8 MiB.
* The DOM holds only the rendered viewport — on the order of 200 `.cm-line` elements — no matter how
  long the document is.
* Typing costs ~0.06 ms of our code per keystroke (§6.3), independent of note size.
* JS heap for the document: ~5.5 MB at 5 MB, ~8.8 MB derived at the cap.
* The one genuinely large structure is **CM6's own height map**, which holds an entry per line
  (67,301 of them in the fixture). With `lineWrapping` on, heights of off-screen lines are *estimated*
  until measured, so the scrollbar thumb shifts slightly as you scroll through a long document. This
  is inherent to every CM6 editor including Obsidian's, and is accepted.

Hard guards:

| Condition | Behaviour |
|---|---|
| file > **8 MiB** | `read_note` returns `tooLarge`; the pane shows `This note is 47 MB — too large to open (the limit is 8 MB).` No partial load, no truncated preview, no read-only fallback: a truncated view the user might edit is a data-loss path, not a feature. |
| bytes are **not valid UTF-8** | `read_note` returns `notUtf8` and the note does not open. Opening read-only with a lossy re-decode for display is not an option: it is one bug away from autosaving a lossily-decoded buffer over the user's bytes. |
| a single line > 1 MB | Renders. `build()` never calls `Line.text` (§5.3), so no multi-megabyte string is materialised per repaint. Wrapping such a line is slow in every browser; accepted. |

The memory position assumes what the feature list implies: **one note open at a time**. There is no
second `EditorView`, no preview pane, no background-parsed notes.

---

## 11. Deviations and functional gaps

### 11.1 The code-block deviations

**§11.1. (DELETED — the fence-dimming question and the no-highlighting decision were settled by the
contract and by measurement; CONTRACT §5.3 and §5.4 carry the rules, and §8.4 carries what the code
does.)**

### 11.2 The inline title

**§11.2. (DELETED — the question of whether the big heading in the reference was the inline title is
settled: it was, and §5.5 specifies the widget that renders it.)**

### 11.3 Functional gaps

| Gap | Why |
|---|---|
| No in-note find (`Mod-f`) | The vault-wide search is the search feature; in-note find is not implemented. |
| No setext headings (`Title` / `====`) | Two-line lookahead; `---` is ambiguous with thematic breaks and list items. |
| No indented (4-space) code blocks | Ambiguous with list continuation, which is literal text. |
| Headings must start at column 0 | CommonMark allows 3 leading spaces; column 0 keeps the 8-char fast path a pure prefix test. |
| No auto-continuation of lists on Enter | Lists are decorations over literal text; auto-continuing them would be the only rich-text behaviour for a construct we do not otherwise interpret. |
| Notes above 8 MiB and non-UTF-8 notes do not open at all | §10, per CONTRACT.md §7.3 cases 14 and 15. Refusing is the only branch that cannot destroy bytes. |
| A heading's text shifts right while the caret is on it | §5.2's marker reveal occupies layout, by design and per CONTRACT.md §5.4.1 rule 3. |
| Both panes can drop frames while the main thread is busy | The single-process architecture's honest cost; measured in the scroll bench. |

---

## 12. The tab strip and the empty state

### 12.1 The tab strip

**Behaviour: see CONTRACT.md §7.4.** The strip holds **two fixed tabs** — the note tab and the
`Memoir` tab — and **neither is closable**. The dirty-close guard therefore lives on the paths that
still tear down (quit, vault switch, delete), not on a control in the strip.

`src/tabstrip.ts` owns the contents: with no note open the note tab is **not rendered**; a long label
clips with ellipsis and the strip never scrolls; `setDirty` repaints and `setNote`/`setActive`
re-render from `RenameResult.path`, never from a locally computed string.

### 12.2 The empty state

**There is no empty-state element.** With no note open the pane is EMPTY — no centred line, no
placeholder, and no caret (the editor is not an editable surface in that state, §7.1). That is what
Obsidian shows, and it is what `showEmpty()` produces:

```ts
export function showEmpty(): void {
  view.setState(EditorState.create({ doc: "", extensions: EXTENSIONS }))
  // no note open: no title widget, no note state, no tab
}
```

`view.setState`, never `view.destroy()`: CONTRACT.md §4.3 allows exactly one `EditorView` for the
process lifetime.

---

## 13. Verification

### 13.1 Unit tests for the block index (no DOM needed, `node --test`)

`tests/frontend/livepreview.test.mjs`, owner 03.

Table-driven, input markdown → expected `Block[]`:

```
"```\na\n```"                 → [{from:0,to:9}]
"~~~\na\n~~~"                 → [{from:0,to:9}]
"```js\na\n```"               → one block; the info string does not prevent opening
"```a`b\nx"                   → NO block (backtick inside a backtick info string)
"````\n```\n````"             → one block; the 3-backtick line cannot close a 4-backtick fence
"```\na"                      → one block running to doc end (unclosed)
"   ```\na\n   ```"           → one block (up to 3 leading spaces)
"    ```\na"                  → NO block (4 spaces = not a fence)
"```\n# not a heading\n```"   → the inner line must get nc-cb, never nc-h1
"```\nx\n```\ntext\n```\ny\n```" → two blocks
```

Plus an incremental-equivalence property test: for a random document and a random sequence of 200
random edits, `applyChanges` chained over the edits must produce exactly the same `blocks` array as
`scanAll` on the final document. This is the test that catches the coordinate-mapping bugs in §5.1,
and skipping it is the main correctness risk in this design.

Two tests §5.2's reveal adds, both cheap and both in this suite:

* the marker decoration is `HIDE_MARK` for a heading line the selection does not touch and
  `SHOW_MARK` for one it does, including a **range** selection that merely overlaps the line;
* moving the caret onto and off a heading line changes only the marker decoration — the `.nc-hN`
  line decoration is byte-identical across the two builds, so no line-class churn reaches the DOM.

The frame decoder's tests belong to `note_frame.js`'s owner and are listed in CONTRACT.md §2.4; do
not duplicate them here.

### 13.2 Geometry

**Normative: see CONTRACT.md §5.11.** `tools/verify-geometry.js` is the G9 harness; the gate is
"0 failures, 0 skips" (CONTRACT.md §6.5). It reads box edges, padding, margins and computed
`font-size` / `line-height` through `getBoundingClientRect` and `getComputedStyle`, and asserts
colour through `getComputedStyle` rather than from any raster.

The editor's obligations to that harness, which are this document's:

1. `editor.css` must produce the rows CONTRACT.md §5.3 and §5.4 assert.
2. **The `--pixeltest` fixture note**: its **first line is body text, never a heading** (the inline
   title already occupies the H1 box above it); it contains at least one `## ` heading below the
   fold for the two marker rows; it contains a three-line ` ```sh ` block and enough body to
   overflow vertically; the caret is parked in the body before the probe runs, because §5.2's reveal
   shifts a heading's text by design.
3. A blank markdown line must occupy exactly one body line box, and paragraphs must get no extra
   margin — the "blank lines are preserved literally" rule, which is a decoration decision (§1), not
   a CSS one.
4. The rows this pane owns: **`title`** (`.nc-title`'s box and tokens), **`heading.marker.hidden`**
   (zero `.nc-md-marker` with the caret in the body), **`heading.marker.shown`** (exactly one
   `.nc-md-marker`), and **`layers.scrollers`** (`.cm-scroller` is one of exactly two scrollable
   boxes in the document).

### 13.3 Performance checks

Reproduce §6 on the 5 MB fixture and treat **full open > 40 ms** or **per-keystroke decoration
work > 0.5 ms** as a regression. Both are ~4× and ~8× the measured values, so they catch a
regression without flapping. §5.2's reveal adds a rebuild per *cursor move* as well as per keystroke,
at the same measured 0.017 ms; the same 0.5 ms budget covers it.

---

## 14. Build and conventions

### 14.1 Bundler and build script

**§14.1. (DELETED — `build.mjs` was deleted with the Tauri toolchain; the frontend build is
`electron-shell/build-app.mjs`, CONTRACT §6.3.)**

### 14.2 Application configuration and the CSP

**§14.2. (DELETED — the configuration and CSP are the Electron shell's, CONTRACT §6.1.)** The one
editor-layer fact that survives: CM6's base theme is injected at runtime by `style-mod`, so the
document's stylesheet policy must allow it (§8).

### 14.3 Frontend conventions the editor follows

No React, no Vue, no Svelte, no signals library, no virtual DOM.

* **DOM is built with `document.createElement`** inside each module's own `render*` / `paint*`
  helpers. There is no shared `el()` abstraction, and no templating.
* **Event delegation, not per-row listeners.**
* **State is plain module-level objects** mutated directly, with explicit `render*()` calls. No
  reactivity, no diffing.
* **No CSS-in-JS anywhere, including for the editor** (§8). Static stylesheets in a fixed order,
  inlined at build time.
* **Icons are inline SVG string literals** in `src/icons.ts`, painted into `[data-icon]` hosts by
  `paintIcons` — no icon font and no HTTP requests. Those literals are the **only** strings in the
  app assigned to `innerHTML` (CONTRACT.md §6.1's review rule); note content never reaches the DOM
  as markup. The editor injects none of them: §5.5's title widget writes `textContent`, never
  `innerHTML`.

The editor is the only thing in the frontend that is allowed to be a library.
