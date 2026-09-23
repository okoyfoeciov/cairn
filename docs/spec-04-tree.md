# spec-04 — File tree + navigation

**Status: subordinate to `docs/CONTRACT.md`.** Where this document and CONTRACT.md disagree,
CONTRACT.md wins and this document is wrong.

**This document is normative for** the interior of the left sidebar below the title strip: the
virtualised file-tree model and its `ArrayBuffer` consumption, flattening and ring-buffer recycling,
the row-paint hot path, hit-testing, cursor/active/selection semantics, the post-snapshot restore
pass, create/rename/delete *interaction* flows, the shared inline rename editor, the context menus,
the confirm modal's copy, the vault-switcher popover, tree keyboard navigation and the six global
shortcuts, and the tree's own DOM and performance budgets.

**It defers to CONTRACT.md for** — and MUST NOT restate — the command table and shared types
(§1.3, §1.5), the event names and payloads (§1.4), the `TreeBlob v1` layout and its caps (§3.2,
§3.3), where expansion state lives and how it is pruned (§3.4), refresh and echo suppression (§3.5),
what the tree contains (§3.6), search's ownership of the sidebar (§4.4), the token set (§5.1), the
file-tree box model (§5.2), window geometry and the sidebar width (§5.5), the menu rulings (§5.2,
§5.10 R2), the geometry harness (§5.11), the data-loss rules including delete-of-the-open-note, name
validation, case-only renames and moves (§7.1–§7.3), the tab strip (§7.4), first run (§7.5), and
`state.json` (§7.6).

**Boundaries.** Owner 01 owns `tokens.css`, the title strip, the sidebar frame and the vault bar's
frame; owner 02 owns the Rust core (scan, watcher, sort comparator, filesystem mutations, `ipc.ts`,
`prefs.rs`); owner 03 owns the editor and the tab strip — this spec calls `openNote(path)`,
`showEmpty()`, `isDirty()`, `flushNow(reason)`, `saveAsPrompt()` and `focus()`; owner 05 owns the
search panel. This spec owns none of their pixels and none of their commands.

---

## 1. The governing constraint

A 5,000-note vault must cost the tree **a bounded, vault-size-independent amount of DOM and heap**.
The whole design falls out of three numbers:

| | naive tree | this spec |
|---|---|---|
| DOM elements (5,500 nodes) | ~27,500 | **≤ 80, constant** |
| JS heap for the model | ~1.4 MB (objects + strings) | **≈ 250 KB measured**, one ArrayBuffer + three small arrays |
| Allocation per scrolled row | 1 element + N strings | **0 bytes** |

The heap figure is CONTRACT §3.2's measurement, not an estimate: blob 183 KB + `ui` 5.5 KB +
`visible` 22 KB + a hard-capped 1,024-entry name cache. The JS heap is not the dominant term and no
further heap micro-optimisation is worth a line of complexity.

Everything below is in service of those three cells. Where a cleverer option existed, the boring one
was chosen and the reason recorded.

---

## 2. Coordinate system

**§2. (DELETED — the band table and the fixed 412px sidebar it described were measured at the old
gate geometry. The gate window is 1920×964 with an 881px tree band, the sidebar resizes, and both
are CONTRACT §5.5/§5.10's. The one rule this section owned — the row pool is sized from the
scroller's live `clientHeight`, never from a constant — lives in §5.2.)**

---

## 3. Model: one ArrayBuffer, zero objects

### 3.1 Why not a node object graph

5,500 `{name, path, kind, depth, children[], expanded}` objects cost ~1.4 MB: ~110 B of object header
plus slots each, plus 5,500 separately-allocated name strings, plus 500 child arrays. Worse, every
watcher refresh discards and re-allocates the lot, producing a 1.4 MB garbage spike every time the
user saves a file.

Instead the Rust core serialises the tree into one flat binary blob. The frontend creates typed-array
*views* over it — no copy, no parse, no per-node allocation. A refresh swaps one ArrayBuffer for
another; the GC frees exactly one object.

### 3.2 Node ordering (the load-bearing invariant)

Invariant P — a node at index `i` owns the contiguous range `[i+1, i+subtree[i]]`, its parent always
has a lower index, and a folder's parent is always a folder. Normative: see CONTRACT.md §3.2.

Everything in §5 and §6 leans on it: it is what makes flattening O(visible) instead of O(N), makes
"collapse a folder" a single integer add, and makes the restore pass touch only folders.

### 3.3 Binary layout — `TreeBlob v1`

Normative: see CONTRACT.md §3.2. The node caps and their header bits: see CONTRACT.md §3.3.

Two consequences this spec does own, because they are frontend behaviour:

- `adopt()` MUST validate `magic`, `version` and the derived layout before it exposes a single view.
  A blob that fails a check is a hard throw, never a partial adopt (`treeblob.ts`).
- **Every folder draws a chevron, keyed off `kind` alone.** An empty folder is still collapsible —
  Obsidian's folder item is `setCollapsible(true)` unconditionally, which is what creates its
  `.collapse-icon` — so `hasKids()` is not the chevron predicate. It still means what it says and is
  used elsewhere.

### 3.4 Transport

Normative: see CONTRACT.md §1.2 and §3.1. The frontend obligation that follows: the value handed to
`TreeBlob` is an `ArrayBuffer`, and a non-`ArrayBuffer` is a degraded IPC channel, not a shape to
tolerate. The guard lives in `treeblob.ts`'s constructor and says so by name.

### 3.5 Frontend views

The decoder is `src/treeblob.ts`. It materialises **zero per-node objects**: one `TreeBlob` per
adopted buffer, six typed-array views onto the caller's bytes (no copy), and one hard-capped name
cache. `adopt()` is a constructor now, not a function that mutates module state.

```ts
class TreeBlob {
  readonly n: number; readonly m: number
  readonly sortOrder: number; readonly flags: number; readonly epoch: number
  readonly subtree: Uint32Array; readonly parent: Int32Array
  readonly nameOff: Uint32Array; readonly depth: Uint8Array
  readonly kind: Uint8Array;     readonly names: Uint8Array

  isDir(i: number): boolean
  hasKids(i: number): boolean
  nameOf(i: number): string        // display stem; `.md` stripped, never for folders
  extOf(i: number): string         // '.md' / '.MD' — the ON-DISK extension case
  pathOf(i: number): string        // vault-relative, '/'-separated, CONTRACT §1.1
  resolveLink(target: string, fromPath: string | null): string | null
  clearNameCache(): void
}
```

The field offsets are CONTRACT §3.2's; if the two ever disagree, CONTRACT.md is right and
`treeblob.ts` is a bug. `names` holds display names with `.md` stripped, which is why `pathOf`
re-appends the extension — sound only because the tree contains nothing but directories and `.md`
files (§3.6) — and it re-appends `extOf`'s case rather than a literal `.md`, because a `.MD` file is
a note on disk and must keep its spelling on the wire.

Heap: blob 183 KB + `ui` 5.5 KB + `visible` 22 KB + the capped name cache ≈ **250 KB** (CONTRACT
§3.2), one big allocation and three small ones. `nameCache` is a hard-capped `Map` cleared wholesale
rather than LRU-evicted — a clear costs one 1,024-entry drop and the refill is imperceptible.

### 3.6 What the tree contains

Normative: see CONTRACT.md §3.6.

The one behavioural consequence this spec owns: because attachments are never rows, there is no row
in this tree that a click can do nothing with. Every file row opens; every folder row toggles (§6.1).

---

## 4. Row geometry and CSS

### 4.1 The box model

**§4.1. (DELETED — the box model is CONTRACT §5.2's. The two behaviours this section still owned are
in §5.4: a file and a folder at the same depth share a text origin, and guides are drawn for
ancestor levels only.)**

### 4.2 Colours

**§4.2. (DELETED — `tokens.css` is the only declaration site and CONTRACT §5.1 is its ruling. The
tree consumes the tokens by name and declares none.)**

### 4.3 The row element

**§4.3. (DELETED — the row markup and its CSS are `tree.ts` / `tree.css`'s, and the load-bearing
parts of the old block are restated as rules in §5.3 and §5.4: `translateY`, never `top`; no
`will-change` on pooled rows; the chevron is drawn per folder and is an inline `<svg>`.)**

### 4.4 Nav toolbar

**§4.4. (DELETED — the nav toolbar does not exist. Refresh lives in the `.watch-degraded` banner's
`[ Refresh ]` button, whose action is `rescan_all()`; this spec's only involvement is that the
resulting `nc://tree-changed` runs §10.2's handler like any other.)**

---

## 5. Virtualisation

### 5.1 Flattening

```ts
function flatten(): void {
  if (!blob) { visibleCount = 0; sizer.style.height = '0px'; return }
  const { n, subtree, kind } = blob
  let v = 0, i = 0
  while (i < n) {
    if (hidden[i] !== 0) {              // Memoir.md — root-level, files only (§3.6 note)
      i += (kind[i] & 1) !== 0 ? subtree[i] + 1 : 1
      continue
    }
    visible[v++] = i
    // collapsed directory: skip its whole subtree in one add (invariant P)
    i += (kind[i] & 1) !== 0 && (ui[i] & 1) === 0 ? subtree[i] + 1 : 1
  }
  visibleCount = v
  sizeSizer()
}
```

Cost is O(visibleCount), not O(N): a collapsed folder holding 4,000 notes costs one integer add.
Worst case (everything expanded, N=5,500) measured budget: **≤ 0.3 ms**, no allocation.

Called on: adopt, expand, collapse, reveal, and after the inline create row opens or closes.

`sizeSizer()` sets the sizer to **`padTop + rows + padBottom`**, where the two paddings are the
scroller's own and are read once in `measure()` (see §5.2).

### 5.2 Scroll math

```
rowH     = the used --row-h (27px at the default), read from the computed style
OVER     = 8                                    // rows of overscan on each side
poolSize = ceil(liveClientHeight / rowH) + 2*OVER + 1
sy       = scrollTop - padTop                   // scrollTop counts from the PADDING box
first    = max(0, floor(sy / rowH) - OVER)
last     = min(visibleCount - 1, floor((sy + liveClientHeight) / rowH) + OVER)
```

**`poolSize` is computed from the scroller's LIVE `clientHeight` and the used `--row-h`, never from
a constant.** The pool is `ceil(H/rowH) + 17`; at the gate height with no cap banner that is 50
rows. Hard-coding a height would under-size the pool by exactly the number of rows a banner hides,
which is the one configuration nobody tests.

`padTop` is why `sy` exists. `scrollTop` is measured from the scroller's PADDING BOX, so with a top
padding of `p` the sizer and every visible row sit `p` lower in scroll coordinates while the rows are
still laid out as `i * rowH` inside the sizer. Four conversions know this: `onScroll`'s window,
`maxScroll`, and the two comparisons in the create-row host reservation. `padTop` and `padBottom` are
cached in `measure()` — the one place `clientHeight` and `--row-h` are already read — so `onScroll`
still performs a single DOM read.

**Overscan is 8 rows (216px) per side, not 2.** A fling can outrun the main thread by well over
100px; eight rows absorbs that. The cost is 16 extra pooled `<div>`s — ~1 KB of DOM to eliminate
white flashes.

The `scroll` handler updates **synchronously**, not inside `requestAnimationFrame`. rAF-throttling
adds a frame of latency on top of the compositor's own lag and makes the blank-band problem worse.

#### 5.2.1 The scroll handler's four obligations

The scroll handler is on the critical path of every frame of every scroll. Four obligations are
normative, and they are the obligations that decide whether the interaction feels right:

| # | Obligation | Why |
|---|---|---|
| a | **Read `scrollTop` and nothing else.** No `getBoundingClientRect`, no `offsetHeight`, no `clientHeight` inside the handler. | A layout-forcing read on a scroll frame costs the frame. |
| b | Write only `transform: translateY()` and text on pooled rows. | Anything else dirties layout. |
| c | **Never allocate a row during a scroll.** The pool is sized once from live `clientHeight` and re-sized only on resize or a banner appearing. | §5.3/§5.4 guarantee this; it is a rule, not a budget. |
| d | **≤ 2 ms per scroll event at the 50,000-node cap**, asserted by the scroll bench (CONTRACT §5.12.6). | It is the only number that bounds the regression. |

Obligation (a) is implemented by caching: one module-level `clientH`, refreshed from a
`ResizeObserver` on the scroller (which also covers a banner appearing, a window resize, the sidebar
being resized and the sidebar being shown or hidden), and never read from the DOM on a scroll frame.

### 5.3 Ring-buffer recycling

```
slot(v) = v % poolSize
```

This is the whole trick. With a modulo mapping, scrolling by one row changes the node assignment of
**exactly one** pool slot; every other row keeps both its node and its `translateY`. The steady-state
cost of a 60 fps flick is therefore one text-node write and two style writes per frame.

```ts
let curFirst = 0, curLast = -1
let clientH = 0                 // §5.2.1(a): cached; NEVER read from the DOM inside onScroll

export function onScroll(): void {
  const st = scroller.scrollTop         // the ONE DOM read on a scroll frame
  const sy = st - padTop                // §5.2: into sizer coordinates
  let first = Math.max(0, ((sy / rowH) | 0) - OVERSCAN)
  let last  = Math.min(visibleCount - 1, (((sy + clientH) / rowH) | 0) + OVERSCAN)
  if (last - first + 1 > poolSize) last = first + poolSize - 1
  if (first === curFirst && last === curLast) return
  // jumped: repaint everything; otherwise repaint only the new edges and let the
  // rows that scrolled out keep stale content outside the clip.
  repaintRange(first, last)
  hideUnused(first, last)
  curFirst = first; curLast = last
}
```

Two rules about the pooled rows that are not negotiable:

* **`translateY`, never `top`.** Changing `top` dirties layout for the absolutely positioned box;
  the transform does not. On the main-thread scroll path a layout on a scroll frame costs the frame.
* **No `will-change`.** `will-change: transform` on 50 rows would promote 50 compositing layers — a
  GPU-backed surface per row for zero benefit. A plain 2D `translateY` on an absolutely positioned
  box is a paint-only change and does not self-promote.

### 5.4 Zero-allocation painting

Three allocation sources are eliminated:

1. **`className` string concatenation.** A **256-entry** lookup table is precomputed at module load,
   indexed by eight state bits: chevron, open, active, cursor, selected, drag, drop, secret.
2. **Redundant `--d` writes.** Each pool element caches its last-written depth on `el.__d`.
3. **Redundant transform writes.** Each element caches its last `y` on `el.__y`.

```ts
const CHEV = 1, OPEN = 2, ACTIVE = 4, CURSOR = 8, SEL = 16, DRAG = 32, DROP = 64, SECRET = 128
const CLS: string[] = new Array(256)
for (let m = 0; m < 256; m++)
  CLS[m] = 'tr' + (m & CHEV ? ' d' : '') + (m & OPEN ? ' o' : '') +
           (m & ACTIVE ? ' a' : '') + (m & CURSOR ? ' c' : '') + (m & SEL ? ' s' : '') +
           (m & DRAG ? ' is-drag' : '') + (m & DROP ? ' is-drop' : '') +
           (m & SECRET ? ' is-secret' : '')

function paint(v: number): void {
  const el = pool[v % poolSize], n = visible[v], y = yOf(v), d = blob.depth[n]
  if (el.__n !== n) { el.__t.data = blob.nameOf(n); el.__n = n }
  if (el.__y !== y) { el.style.transform = 'translateY(' + y + 'px)'; el.__y = y }
  if (el.__d !== d) { el.style.setProperty('--d', String(d)); el.setAttribute('data-d', String(d));
                      el.setAttribute('aria-level', String(d + 1)); el.__d = d }
  const isD = (blob.kind[n] & 1) !== 0
  const chev = isD ? CHEV : 0                 // §3.3: keyed off kind, never off subtree
  const m = chev | (isD && (ui[n] & 1) ? OPEN : 0) |
            (n === activeNode && fileCount !== 1 && selPaths.size === 0 ? ACTIVE : 0) |
            (selNodes.has(n) ? SEL : 0) | (n === dropNode ? DROP : 0) |
            (secretNodes.has(n) ? SECRET : 0)
  if (el.__m !== m) {
    el.className = CLS[m]
    if (isD) el.setAttribute('aria-expanded', (m & OPEN) ? 'true' : 'false')
    else el.removeAttribute('aria-expanded')
    el.__m = m
  }
}
```

A folder never draws a guide through its own chevron, so `--gx0` is the depth-0 chevron centre and
guides are drawn for **ancestor** levels only — a file and a folder at the same depth share a text
origin, because the chevron is drawn on top and is not a layout box in the flow.

The row's label is a dedicated text node (`el.__t`), not `textContent`, because the row now has a
child before it — the `<svg class="chev">` chevron.

`el.__n` doubles as the hit-test result (§6.1) — no `data-*` attribute, no `dataset` allocation.

### 5.5 DOM budget

| Element | Count |
|---|---|
| `.tree-scroller` | 1 |
| `.sz` sizer | 1 |
| `.tr` pool | `ceil(H/27) + 17` — **50** at the gate height |
| `.ren` rename input | 1 |
| Cap banners (CONTRACT §3.3) — **owner 01, siblings of the scroller, counted here only because they are in the column** | 0–2 |
| Menu primitive (§9): container + ≤10 items + 2 separators | 13 |
| Confirm modal: backdrop + box + text + 2 buttons | 5 |
| Vault bar: bar + chevron + label | 3 |
| **Total sidebar** | **≤ 80, independent of vault size** |

Comfortably inside CONTRACT §4.4's per-scenario ceiling of ≤ 400 DOM nodes at idle.

The menu, modal, banner and rename input are created once at boot and toggled with the `hidden`
property. Nothing in the sidebar is created or destroyed at runtime.

### 5.6 Performance budgets

| Operation | Budget at N=5,500 |
|---|---|
| `adopt(blob)` (views + validation + `ui` + `visible`) | ≤ 0.15 ms |
| Post-snapshot restore pass (§6.3) | ≤ 2 ms |
| `flatten()` all-expanded | ≤ 0.3 ms |
| Full pool repaint (50 rows) | ≤ 0.6 ms |
| Steady-state scroll frame | ≤ 0.15 ms, **0 B allocated** |
| **One `scroll` event at the 50,000-node cap** | **≤ 2 ms** — CONTRACT §5.12.6(d), asserted by `tools/scroll-bench.mjs` |
| Expand/collapse → painted | ≤ 3 ms |
| Sort change → painted (incl. `set_sort` + `tree_snapshot` round trip) | ≤ 40 ms |

The scroll row is the one with an executable instrument. The others are design budgets, asserted
by the DOM-shim tests where they can be and otherwise by inspection on a change that touches the
path.

---

## 6. Interaction plumbing

### 6.1 Listeners and click behaviour

Hover is pure CSS (`.tr:hover`) — no JS. Everything else hangs off delegated listeners on
`.tree-scroller`: `click`, `contextmenu`, `keydown`, plus the drag family (`dragstart`, `dragover`,
`dragleave`, `drop`, `dragend`). No per-row listeners ever.

```ts
function nodeAt(ev: Event): number {
  const el = (ev.target as Element).closest('.tr')
  return el ? (el as PoolRow).__n : -1   // __n is the node index; no dataset, no parseInt
}
```

Click behaviour:

| Target | Action |
|---|---|
| Folder row (anywhere, chevron included) | toggle expand/collapse; set cursor; do **not** change the active note |
| File row | set cursor; set active; `host.openNote(pathOf(n))` — the shell's `openNoteAt`, which routes a `Memoir.md` hit to its own tab and everything else to the note tab |
| Shift-click | replace the selection with the visible rows from the anchor to the clicked row, inclusive — nothing opens, toggles or moves |
| Empty space below the last row | clear cursor and selection; keep active |

The chevron is deliberately **not** a separate hit target: in Obsidian the entire folder row toggles,
so a nested clickable element would be dead weight — which is what lets the chevron be a drawn
element and the row be one node.

**Drag-to-move is transcribed from Obsidian's file-explorer drop.** Every pooled row is a drag
source; the top-level entries resolved at `dragstart` are dropped into the folder under the cursor
(or the vault root in empty space) through §8.6's reparenting; a hovered collapsed folder
auto-expands after Obsidian's 750 ms `mouseoverExpandTimeout`; an invalid drop (into one's own
descendant, or a no-op) highlights nothing. A tree-row drag carries a private MIME type, which is
also what lets the editor's drop handler refuse it.

**While `nc://vault-lost` is outstanding the tree is frozen** (CONTRACT §7.3 case 8): clicks set the
cursor but perform no mutation and open no note, the context menus do not open, and global creates
are inert. The chrome banner's `[ Re-open ]` / `[ Switch vault… ]` are the only ways out.

### 6.2 Cursor, selection, active

Four orthogonal states on one row:

- **hover** — CSS only, transient.
- **cursor** (`.c`) — the keyboard focus row. Exactly one, or none. Rendered as a 1px inset ring, and
  **only while `.tree-scroller` matches `:focus-visible`**, so mouse users never see it.
- **selection** (`.s`) — the shift-click range. Path-keyed (`selPaths`), re-resolved per snapshot.
  A plain click clears it first; the anchor is the last plain-clicked row; Ctrl/Cmd-toggle is not
  implemented. Delete applies to the whole selection.
- **active** (`.a`) — the note currently open. Exactly one file row, or none, and there is no
  `(deleted)` marker. Persistent and focus-independent; it must survive the tree losing focus, a
  sort change and a watcher refresh. A vault holding exactly one note draws no active fill, and a
  live shift-selection suppresses it entirely.

All of these are held as **paths**, not indices, because indices are invalidated by every snapshot:

```ts
let cursorPath = null, activePath = null, anchorPath = null   // durable
let cursorNode = -1, activeNode = -1, anchorNode = -1         // derived, re-resolved per snapshot
const selPaths = new Set<string>()                            // durable; selNodes derived
```

### 6.3 The post-snapshot restore pass

Runs once after every adopt. One loop, ≤ 2 ms at N=5,500, and it does six jobs: rebuild the folder
prefix stack; set `ui[i]` from `expandedPaths`; resolve cursor, active and anchor by path with a
cheap last-segment reject before concatenating; re-resolve the selection and the secret marks;
mark the Memoir row hidden; count the files.

```ts
function restore(): void {
  const pre: string[] = []                     // pre[d] = full path of the current depth-d folder
  cursorNode = activeNode = anchorNode = -1; fileCount = 0
  selNodes.clear(); secretNodes.clear()
  for (let i = 0; i < n; i++) {
    if (kind[i] & 1) {                         // folder: parents are always folders
      const d = depth[i]
      const p = d ? pre[d - 1] + '/' + nameOf(i) : nameOf(i)
      pre[d] = p
      hidden[i] = 0
      ui[i] = expandedPaths.has(p) ? 1 : 0
      if (p === cursorPath) cursorNode = i
      if (p === anchorPath) anchorNode = i
    } else {                                   // file
      const nm = nameOf(i)
      const isMemoir = depth[i] === 0 && nm === 'Memoir' && blob.extOf(i) === '.md'
      hidden[i] = isMemoir ? 1 : 0
      if (!isMemoir) fileCount += 1
      if (cursorPath !== null && cursorNode < 0 && endsWithSeg(cursorPath, nm))
        if (pathOf(i) === cursorPath) cursorNode = i
      if (activePath !== null && activeNode < 0 && endsWithSeg(activePath, nm))
        if (pathOf(i) === activePath) activeNode = i
      // selection / secret marks: one Set lookup on the path built from `pre`
    }
  }
  if (cursorNode < 0) cursorPath = null        // vanished: drop the cursor
  if (anchorPath !== null && anchorNode < 0) anchorPath = null
  if (activePath !== null && activeNode < 0)
    host.onActiveVanished(activePath)        // owner 03; see below
}
```

`host.onActiveVanished()` is the call that tells the shell the open path no longer resolves; the
shell marks the editor's buffer detached. The behaviour behind it is CONTRACT §7.3 case 5's and
belongs to owner 03: stop autosave, mark the buffer read-only, show the `renamed or removed outside
the app` bar. The tree's own obligation is only to stop drawing an active row, and **not** to clear
`activePath` — the editor still holds a buffer for it and the user may `Save as…`.

An in-app delete of the open note never reaches this branch, because CONTRACT §7.3 case 3 clears
`activePath` *before* invoking `delete_entry` (§8.5).

Then: `flatten()`, clamp `scrollTop`, repaint. **The Memoir note is hidden from the tree alone**: a
root-level `Memoir.md` is a place, not a file to browse — it shows only in the tab strip's fixed
second tab, while search still finds it and a `[[Memoir]]` link still opens it. The hiding is one
byte per node, set here because this pass already decodes every file's name.

---

## 7. Sort

### 7.1 The surviving subset

Four orders ship; the wire type is a `u8` 0..3 (CONTRACT §1.5). **The UI pins file name A-Z**: the
sort menu does not exist, and the frontend only ever sends 0. The other three orders remain on the
wire and command 7 still accepts them.

**Created time (both directions) is cut**, and the reason is what decided it: `Metadata::created()`
returns `Err(Unsupported)` on filesystems without a birthtime, and even where it exists a
`git clone`, `rsync`, `cp` or a sync client rewrites it to the copy time. `st_ctime` is not a
substitute — it moves on every write, chmod and rename, so the same menu item would silently mean
two different things on two platforms. Cutting them also removes a `u64` per node from the arena and
a stat field from the scan hot path.

Folders always sort **above** files, in every order, matching Obsidian.

### 7.2 Sorting happens in Rust, never in JS

The frontend contains **no comparator and no `Intl.Collator`**. Rust emits nodes already in order and
the flattener just walks them.

Why: a natural-order sort of 5,500 names via `Intl.Collator.prototype.compare` costs ~70,000 ICU
comparisons at roughly 1 µs each — 70 ms of the cold start — plus an ICU collator instance in the
heap. Rust does the same work in ~2 ms and the frontend never pays it again.

The comparator itself is owner 02's. Its contract with this spec is only that the order is **total**
(so the blob's preorder is reproducible) and that folders precede files at every level. Its
semantics, recorded here because the tooltip copy promises them: natural order — case-insensitive,
maximal digit runs compared numerically so `note2 < note10`, ties broken so the order is stable.

Sort applies uniformly to the whole tree — there is no per-folder override, because that would need a
persisted per-folder map and a UI to manage it.

### 7.3 The menu

**§7.3. (DELETED — the sort menu does not exist; the UI is pinned to file name A-Z and draws no
control. The four orders remain available on the wire.)**

### 7.4 Where the choice is stored

Per vault. Normative: see CONTRACT.md §7.6.

---

## 8. Create, rename, delete, move

### 8.1 The shared inline editor

One permanently allocated row-host editor, `src/inline-edit.ts`, repositioned over the row being
edited (or over a reserved create row). It owns the character-level `beforeinput` filter, the
commit-time rules, and the 200 ms `.bad` flash in `--text-error`; the row it sits on is
`tree.ts`'s `.tr-edit` host.

**Why an `<input>` and not `contenteditable`:** `contenteditable="plaintext-only"` would let the row
element itself become editable with zero extra DOM, and is tempting. It is rejected because paste,
IME composition, undo and `beforeinput` cancellation all behave differently around contenteditable
across engines, and this is a path where a bug renames the wrong file. One `<input>` is one element,
behaves identically, and gives `selectionStart`/`selectionEnd` for free.

Lifecycle:

| Event | Result |
|---|---|
| `Enter` | commit |
| blur | commit (Obsidian's behaviour; a click elsewhere accepts the name) |
| `Escape` | cancel |
| `Tab` | commit, then move the cursor to the next visible row |

On a rejected commit the editor **stays open** with `.bad` applied and a one-line message under it —
no toast, no modal, because the user is already looking at the field. When there is no row to host
the editor (a collapsed or off-screen parent, a path not in the tree at all) `main.ts` falls back to
a centred name prompt; that fallback is never the first choice.

### 8.2 New note / new folder / new secret file

**New note** creates `Untitled.md` immediately (Rust generates the unique name), refreshes the tree,
opens the note, and drops the caret into the **inline title** with the name selected — Obsidian's
gesture, measured. There is no dialog and no second rename path.

**New folder** and **New secret file** reserve an inline create row under the target folder with the
name selected; the file or folder is created on commit, through the same shared editor and validator
as a rename.

Target folder, in order:
1. the folder the gesture was made on (the folder row's menu, or a right-click in its body);
2. the vault root, from empty-space's menu;
3. the vault root, from the global `⌘N`.

**There are no create rows on a file row** — a file's menu is Rename / Copy absolute path / Delete
only, because there is nothing to create *inside* a file (CONTRACT §5.2).

```ts
const { path } = await createNote(parent)      // CONTRACT §1.3 #10 — {path, epoch}, no blob
await refreshTree()                            // treeSnapshot() → adopt/restore/flatten
await openNoteAt(path)                         // notes open immediately, like Obsidian
focusInlineTitle()                             // the caret lands in the title, name selected
```

**Collision on create.** Rust picks the name and the frontend never guesses: `Untitled`, then
`Untitled 1`, `Untitled 2`, … The search is bounded, after which the command errors. Auto-numbering
exists **only** for this system-generated name (CONTRACT §7.3 case 10); a user-typed name is never
silently turned into `Ideas 1`.

**If the user presses Escape** on a create row, nothing is written — the reserved row closes and no
file appears. (The immediately-created New note is the exception: it already exists, so Escape from
its title keeps the generated name. That matches Obsidian and is the safe direction.)

### 8.3 Rename

Entry points: `F2`, or context menu → *Rename…*. Both drive `tree.beginRename`, which puts the shared
editor on the row with the stem selected.

Initial selection: for a file, the stem only — the extension is not shown, and the commit re-appends
the file's **on-disk** extension case. For a folder, all.

Commit: `const { path: neu } = await renameEntry(path, newName)` (CONTRACT §1.3 #12), then a fresh
snapshot. The frontend then:

1. rewrites `expandedPaths`: every entry equal to `old` or starting `old + '/'` is re-keyed onto
   `neu` — this is why an in-app folder rename keeps its subtree expanded;
2. updates `cursorPath`, the selection, and — if it matched — `activePath` and the editor's open-file
   path from `RenameResult.path`, never from a locally computed string (CONTRACT §7.3 case 4);
3. `adopt/restore/flatten/repaint`.

Renaming to the identical name is a no-op (commit closes the editor, no IPC).

### 8.4 Name validation

Normative: see CONTRACT.md §7.3 case 11 (`validate_name` vs `validate_rel_for_lookup`) and §1.5
(`invalidName` / `invalidPath`). Case-only renames on a case-insensitive filesystem: see CONTRACT.md
§7.3 case 10.

Two decisions behind the character rules are this spec's and survive:

- **The strict rule applies on macOS and Linux alike.** Applying each OS's own minimum would let this
  app create files that another machine holding the same vault — a Windows one, through a sync
  client — cannot check out.
- **`/` is rejected rather than interpreted as a move.** Obsidian treats `sub/name` in a rename as a
  move, which is elegant, but it makes the illegal-character rule conditional and lets a stray slash
  relocate a file silently. Moving is drag-and-drop (command 24, §8.6), a gesture with its own
  confirmation path, not a side effect of typing a name.

**Unicode normalisation is not performed** — a limitation recorded in CONTRACT §6.4. macOS may return
NFD-composed names for files written by older HFS+ tooling while Linux returns whatever bytes were
written, so `é` typed here and `é` from elsewhere can coexist as two rows. A normalisation dependency
in the cold-start path is not worth it for that.

### 8.5 Delete

Trigger: `⌫` (macOS) / `Delete` (Linux) on the cursor row — applied to the whole shift-selection when
one is live — or context menu → *Delete*.

**Destination: the system trash**, via the `trash` crate (`trash::delete`), which uses
`NSFileManager trashItemAtURL` on macOS and the freedesktop.org trash spec on Linux. Not a `.trash/`
folder inside the vault: that would put a non-`.md` directory into a vault this project promises is a
plain tree of `.md` files. Not a permanent `unlink` either — this is an app for someone's notes.

Crate version and features: see CONTRACT.md §6.2. The default features are kept deliberately:
dropping the implicit `chrono` removes the `.trashinfo` `DeletionDate` field, without which Linux
file managers cannot restore properly.

**Ordering when the target is the open note.** Normative: see CONTRACT.md §7.3 case 3. The tree
invokes nothing until that sequence has run; in particular `activePath` is already cleared and both
autosave timers are already cancelled when `delete_entry` is called, which is what makes the
resurrection race unwinnable.

**Confirmation: yes, for files and folders alike.** A modal, transcribed from Obsidian 1.13.7: title
`Delete file` / `Delete folder`, body `Are you sure you want to delete “<name>”?` (the full name
including its extension) followed by `It will be moved to your system trash.`, extra warning rows for
a non-empty folder, `Cancel` + a solid-red `Delete` with Delete focused, and an `X` that answers
Cancel. The modal is `modal.ts`'s `openModal()`. When the note is dirty, CONTRACT §7.3 case 3's
three-button modal replaces this one; there is never a second confirmation on top of it. The secret
entry has its own confirm copy.

**Fallback.** Trashing fails on volumes with no trash directory (many network mounts, some external
drives). The error arrives as `VaultError { kind: 'trashUnavailable', path, message }`. On it, a
second modal offers `[ Cancel ] [ Delete permanently ]`, states the reason, and re-invokes
`deleteEntry(path, /*permanent=*/true)`. Never fall through to permanent deletion silently.

After a delete, a fresh snapshot → `adopt/restore/flatten`; the cursor moves to the row that took the
deleted row's visible index (or the last row). If the deleted file was the active note, the editor
goes to the empty state via `editor.showEmpty()` (CONTRACT §7.4).

### 8.6 Move

Drag-to-move (§6.1) reparents one or more entries with **command 24, `move_entry`** (CONTRACT §1.3).
Refusals: dropping an entry into its own descendant, or a drop that would not move anything, is
invalid and highlights nothing. A name collision at the destination is refused, not auto-numbered —
`move_entry` answers `alreadyExists` and the row stays put. The open note's `open_note` is re-keyed
by Rust in the same operation (CONTRACT §7.3 case 4), and the frontend re-keys `expandedPaths`,
`selPaths` and the cursor exactly as a rename does (§8.3).

---

## 9. Context menus

### 9.1 The primitive

One reusable in-page HTML menu, `src/menu.ts` — not a native `NSMenu`/`GtkMenu`. Native menus would
be cheaper still, but they look different from Obsidian, which draws its own HTML menus. One
implementation serves the file menu, the folder menu, the empty-space menu and the vault popover.

The rows, in order:

* **File** — `Rename…` · `Copy absolute path` · separator · `Delete`.
* **Folder** — `New note` · `New folder` · `New secret file` · separator · the file menu's three.
* **Empty space** — `New note` · `New folder` · `New secret file`.

There is no *Reveal in Finder* row and no per-folder *Expand all* / *Collapse all* (CONTRACT §5.2).
*Copy absolute path* needs no command and crosses no IPC: it composes `VaultInfo.root` plus the
vault-relative path and writes it through the shell's clipboard command.

Opening rewrites `textContent` and reorders via `hidden`; no elements are created or destroyed. A
menu never scrolls — no `overflow` anywhere on the menu, the modal or the popover — and each row is a
single nowrap line, so it fits or repositions.

**Placement is Obsidian's `showAtPosition`.** With room below, the menu's top-left corner lands at the
pointer; without it, the menu is lifted by its own height so its **bottom-left** corner is what lands
at the pointer. The vault popover is the same rule, which is why it opens upward near the bottom of
the window without anchor arithmetic.

**Dismissal is exactly four things:** an outside `pointerdown`/`click`, `Escape`, activating a row,
or a right-click. There is no `blur` handler — a menu survives Alt-Tab — and no `resize` or `scroll`
handler.

**Right-clicking a row also moves the cursor to it**, so the menu always acts on a row the user can
see is targeted.

Normative for every menu ruling here: CONTRACT.md §5.2 (the box and the rows), §5.10 (the popover)
and §7.3 (the copy that belongs to delete).

### 9.2 File row menu

### 9.3 Folder row menu

### 9.4 Empty-space menu

The rows are §9.1's three tables; the individual subsections carry no separate rules.

---

## 10. The tree's side of the IPC and event contract

### 10.1 Commands

Normative: see CONTRACT.md §1.3 (the command table) and §1.5 (`src/ipc.d.ts`). `src/ipc.ts` is the
only frontend module that crosses the bridge, and it is **owner 02's**.

The commands this spec calls are `tree_snapshot`, `set_sort`, `create_note`, `create_folder`,
`rename_entry`, `move_entry`, `delete_entry`, `open_vault`, `rescan_all`, `pick_vault`,
`recent_vaults`, `forget_vault`, `secret_notes` and `save_ui_state`, all by CONTRACT §1.3's names and
signatures. Errors arrive as typed `VaultError`s — the frontend switches on `kind` and never parses
`message`.

Two rules from CONTRACT §1.3 shape every flow above: mutating commands return `{path, epoch}` and
never a blob, and the frontend always follows with `tree_snapshot()`.

There is no framework and no virtual-list library in the frontend; that is this spec's own decision
and it stands.

### 10.2 Events and refresh

Normative: see CONTRACT.md §1.4 (the event table) and §3.5 (the refresh handler, echo suppression and
the `Node.mtime` rule).

Echo suppression is by exact `(abs, mtime_ns, len)` fingerprint, and the rename case records **two**
fingerprints, which is the half this spec's create flow depends on.

The events this spec subscribes to, and what it does:

| Event | Tree's obligation |
|---|---|
| `nc://vault-opened` | `expandedPaths` ← the per-vault set; `treeSnapshot()`; `adopt/restore/flatten`; restore `scrollTop`. The banner itself is owner 01's; this spec's obligation is to re-read the scroller's `clientHeight` and re-size the pool when one appears (§5.2.1) |
| `nc://tree-changed` | CONTRACT §3.5's handler |
| `nc://vault-lost` | freeze (§6.1). The banner and the affordances are chrome's |

What survives a refresh, and how:

| State | Mechanism |
|---|---|
| Expanded folders | `expandedPaths: Set<string>`, re-applied by `restore()` (§6.3) |
| Cursor | `cursorPath`; dropped if the path is gone |
| Selection | `selPaths`; re-resolved per snapshot, vanished paths fall out |
| Active note | `activePath`; if gone, `host.onActiveVanished()` — there is no `(deleted)` tab marker |
| Scroll | pixel `scrollTop`, clamped |
| Sort | held in Rust; the blob header echoes it |
| Open rename editor | **cancelled** — the row it pointed at may no longer exist |

The last row is the one place a refresh can cost the user typing. It is accepted rather than solved:
with fingerprint echo suppression a UI-initiated create produces no self-inflicted refresh at all, so
the only way to hit it is a genuine external change landing during a rename, which is rare and
unambiguous.

### 10.3 Caps and guardrails

Normative: see CONTRACT.md §3.3 (50,000 nodes / 255 depth, their header bits and their banner copy)
and §7.3 cases 11–13 (path validation and traversal).

**The banners are drawn by owner 01, not by this spec.** They are `.cap-banner` siblings of the tree
scroller inside `.sidebar` — never children of the scroller, so they do not scroll away and do not
enter the tree's coordinate system. The two bits are independent, so depth truncation shows its
banner even when `VaultInfo.truncated` is false.

**This spec's obligation is the consequence:** each banner shortens the tree scroller, so the row
pool MUST be sized from the scroller's live `clientHeight` (§5.2, §5.2.1) and a banner appearing or
disappearing is handled by the same `ResizeObserver` path as a window resize. Nothing here may use a
constant height.

---

## 11. Persisted state

Normative: see CONTRACT.md §7.6. One `state.json` under the app config directory, per-vault keyed,
written by `prefs.rs` (owner 02) through `save_ui_state`.

What the tree contributes to `UiPatch`, and when:

`UiPatch`'s fields are **camelCase** on the wire, like every type that crosses the IPC boundary
(CONTRACT §1.1, §1.5) — `scrollTop` and `lastNote`, not `scroll_top` / `last_note`. The `state.json`
file on disk is **not** a wire type and keeps the snake_case schema CONTRACT §7.6 prints; `prefs.rs`
bridges the two.

| Field | Written when |
|---|---|
| `expanded` | on expand, collapse, and after a rename re-keys the set — debounced 1 s, capped at 2,000 entries |
| `scrollTop` | on scroll, debounced 1 s |
| `lastNote` | when the active note changes |
| `sort` | accepted on the wire; the UI pins A-Z and sends nothing else |

Pruning of dead `expanded` entries is Rust's and happens in exactly one place: after a successful
full scan (CONTRACT §3.4). The tree never prunes on a refresh — a `git checkout` can remove and
restore a directory within seconds, and eager pruning would lose its expansion.

Expansion persists across launches because that is the state Obsidian restores, and losing it on
every launch would be the most visible regression against the reference.

---

## 12. Keyboard

### 12.1 Tree navigation (`.tree-scroller` focused)

Standard `role="tree"` semantics; nothing invented.

| Key | Action |
|---|---|
| `↓` / `↑` | cursor ± 1 visible row, scrolled into view |
| `→` | folder collapsed → expand; folder expanded → move to first child; file → nothing |
| `←` | folder expanded → collapse; otherwise → move to parent (collapsing nothing) |
| `Enter` | file → open; folder → toggle |
| `Home` / `End` | first / last visible row |
| `PageUp` / `PageDown` | ± (`floor(clientHeight / rowH) − 1`) rows |
| `F2` | rename the cursor row |
| `⌫` (macOS) / `Delete` (Linux) | delete the cursor row (or the whole selection), with confirm |
| `Escape` | live selection → clear it; rename open → cancel it; otherwise → return focus to the editor |
| printable characters | **type-ahead**: jump to the next visible row whose name starts with the typed prefix (500 ms buffer, wraps) |

An empty folder still draws its chevron (§3.3), still toggles on `→`/`Enter`, and simply has no
children to move into.

Type-ahead is not an Obsidian feature but is standard in every OS file browser, costs one string and
one timer, and is the only way to reach a note 3,000 rows down without leaving the keyboard.

`←`/`→` do not scroll horizontally — the tree has no horizontal overflow (names ellipsise).

Scroll-into-view for cursor moves: if the target row is above the viewport, `scrollTop = v*rowH`; if
below, `scrollTop = v*rowH - clientHeight + rowH`. Never centre on a single-step move (it makes
arrow-key navigation feel like the list is sliding under a fixed cursor). **Do** centre on
`revealPath` from search or from a create, where the jump is arbitrary.

### 12.2 Global shortcuts — six

One `keydown` listener on `document`, dispatching from a static table. No per-component listeners.

| macOS | Linux | Action |
|---|---|---|
| `⌘N` | `Ctrl+N` | New note |
| `⌘⇧F` | `Ctrl+Shift+F` | Search — swaps the sidebar to the search panel (CONTRACT §4.4) |
| `⌘⇧O` | `Ctrl+Shift+O` | Switch vault (the menu is placed at the pointer, or at the bar for a synthesised activation) |
| `⌘S` | `Ctrl+S` | Flush the pending autosave now (CONTRACT §7.2) |
| `⌘1` | `Ctrl+1` | Select the note tab |
| `⌘2` | `Ctrl+2` | Select the Memoir tab |

Deliberately absent: `⌘P` (no command palette), `⌘,` (no settings), `⌘E` (live preview only, nothing
to toggle), `⌘O` (no quick switcher), `⌘T`/`⌘W` (fixed tabs), `⌘⇧N` (New folder lives in the menus).

While the rename input has focus, only `Enter`/`Escape`/`Tab` are handled; every global shortcut is
suppressed so `⌘N` inside a filename cannot spawn a note. While a modal is open the shortcuts are
dead. While the vault-lost banner is showing (§6.1), `⌘N` is inert.

---

## 13. The vault switcher

### 13.1 The bar

Vertical geometry and the frame: Normative: see CONTRACT.md §5.10 R2, owner 01. The bar is a button
with a chevron glyph and the active vault's name; `:hover` takes `--bg-modifier-hover` and
`--text-normal`. This spec owns the popover it opens and nothing about the bar's pixels.

### 13.2 The popup — in-page, not a second window

Obsidian opens a separate vault-picker **window**. This app must not: a second webview costs tens of
megabytes for a picker used once a week. The switcher is an in-page popover built on the §9.1 menu
primitive, placed at the pointer for a real click and at the bar's own top-left for a synthesised
keyboard activation (`⌘⇧O`).

Each recent vault is a row carrying:

* the vault **name**, with a trailing tick when it is the open vault (Obsidian's construction: the
  tick is a trailing glyph, not a leading gutter);
* `Close`, hover-revealed and **omitted on the open vault** — the command is `forget_vault`, it
  removes the row from the list and touches nothing in the vault, and it sits absolutely positioned
  so the resting popover's box is exactly what it is when the control is shown;
* a `(missing)` suffix and a disabled row for a vault whose folder has vanished mid-session. Forgetting
  it stays available, because that is the commonest reason to want the control at all. On the next
  launch the core prunes it;
* the last row: **`Open folder as vault…`**, whose action is the picker.

Placement, dismissal and the no-scroll rule are §9.1's.

### 13.3 Listing, staleness, and picking a new vault

On open, `recentVaults()` returns up to 8 `{ root, name, exists }` (CONTRACT §1.5). A vault that no
longer exists is shown **disabled and marked `(missing)`** for the life of the session, and pruned by
the core on the next launch.

*Open folder as vault…* → `pickVault()` → an absolute path or `null`. The picker is the **Electron
main-process folder dialog**, opened by the shell and never by the renderer; no dialog capability is
granted to the page. The picked directory becomes a vault as-is; there is no vault-creation ceremony,
no marker file, no `.obsidian` directory written. Any directory is a vault, exactly as in Obsidian.

Rejections, each with a one-line modal:
- the path is not a directory, or is unreadable — `notADirectory` / `io` (CONTRACT §1.5);
- the path is already the open vault — the popover just closes.

A vault over the node cap is **not** a rejection: it opens, truncated, with CONTRACT §3.3's banner.

**First run** — no vault configured — see CONTRACT.md §7.5.

### 13.4 Switch sequence

Normative: see CONTRACT.md §4.3 (the frontend ordering) and §1.6 (the flush handshake it shares with
quit).

The tree's own steps, inside that ordering:

| CONTRACT §4.3 step | Tree's part |
|---|---|
| 2 — persist the outgoing vault | `saveUiState({ expanded, scrollTop, lastNote })`, awaited — **camelCase** |
| 4 — cancel search | if search holds the sidebar, return it to the tree |
| 5 — drop the model | drop the blob and the views, clear the name cache, empty every pool row, reset the cursor/selection |
| 6 — `open_vault` | on `nc://vault-opened`: `expandedPaths = new Set(info.expanded)`, `treeSnapshot()`, `adopt/restore/flatten`, restore `scrollTop` clamped, repaint, update the bar's label from `VaultInfo.name` |

Step 1 (`await flushNow("switch")`) is not "best effort": if it rejects, the switch **aborts** with a
modal naming the file, and the vault does not change. CONTRACT §1.6 makes quit no weaker than this.

Opening `info.lastNote` (or the empty state) is owner 03's, driven from `VaultInfo.lastNote`.

Because a switch drops one ArrayBuffer, one CM6 `EditorState` and one Rust arena and allocates their
replacements, it is the app's most leak-prone operation; the acceptance test in §14.2 covers it.
Target: a switch completes, painted, in **< 300 ms** for a 5,000-note vault.

### 13.5 Search takes the sidebar

Normative: see CONTRACT.md §4.4 — the search panel **replaces** the tree; the two do not stack.

The tree's side: `.tree-scroller` gets `hidden`, and **nothing is torn down** — the blob, the pool,
the `expandedPaths` set and the scroll position stay resident, so returning is a single
`hidden = false` plus a repaint. The tree does not filter itself; a filtering tree would need a
second flatten path and a second set of expanded semantics for zero gain.

Opening a search result calls `revealPath(path)`: add every ancestor of the target to
`expandedPaths`, set `ui[k] |= 1` for each, re-flatten, centre the row, and set both cursor and
active. No IPC, and no `reveal` command — there is none (CONTRACT §1.3).

---

## 14. Acceptance checks

### 14.1 Geometry

**§14.1. (DELETED — G9 is CONTRACT §5.11's and its fixture is written down there; the rows this
pane owns are named in CONTRACT's harness, not restated here. Colour is asserted through
`getComputedStyle`, never from a raster.)**

### 14.2 Behaviour and budget

1. With 5,000 notes and every folder expanded, `document.querySelectorAll('.tree-scroller .tr').length`
   is `ceil(clientHeight/27) + 17` and does not change when the vault grows.
2. During a 3-second flick, the JS heap delta is < 64 KB (allocation-free scroll path).
3. Expanding a folder holding 4,000 notes paints in < 3 ms.
4. An **empty** folder draws its chevron, is still focusable and still toggles.
5. Renaming a folder in-app keeps its subtree expanded.
6. Renaming a folder outside the app, then re-opening the vault, drops its stale `expanded` entry
   (pruned after the full scan, CONTRACT §3.4) and leaves no phantom row.
7. `touch` on a note inside a collapsed folder does not change `scrollTop`, the cursor, or the active
   row.
8. An external edit made **within 500 ms** of an in-app create still refreshes the tree — the
   fingerprint suppresses the echo, not the window.
9. Twenty A↔B vault switches hold growth under 5 MB end to end (the live footprint protocol is
   CONTRACT §6.5's).
10. Creating a note in a folder that already holds `Untitled.md` yields `Untitled 1.md`.
11. Typing `a/b` into the rename field yields `ab` and a 200 ms red flash.
12. Renaming a note to a name that already exists is **refused** with the editor still open — the
    frontend never auto-renames a user-typed name (CONTRACT §7.3 case 10).
13. Deleting a note moves it to the system trash, with a `.trashinfo` `DeletionDate` on Linux, and it
    is recoverable from the desktop's trash UI.
14. Deleting the open note with a dirty buffer prompts before the buffer is dropped, and the file does
    not reappear after 6 s (past both autosave timers) — CONTRACT §7.3 case 3.
15. On a vault whose walk hits the 50,000-node cap, the banner shows; on one that hits the depth cap
    only, the depth banner shows and `VaultInfo.truncated` is false.
16. Switching sort issues exactly one `set_sort` and exactly one `tree_snapshot`, and `scrollTop`
    lands at 0.
17. Dropping a folder into its own descendant highlights nothing and moves nothing; dropping a note
    into a folder whose contents already include that name is refused with `alreadyExists`.

---

## 15. Conformance log

**§15. (DELETED — the log tracked which critique findings each editing pass resolved; the tree it
describes is the one above.)**
