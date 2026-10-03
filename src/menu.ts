/**
 * src/menu.ts
 * Owner: 04.  Spec: CONTRACT.md §5.1 (--bg-menu, --menu-shadow, --text-error),
 * §0.12 E14 (the row menus' shape), §0.27 E67 (the slot, the tick, the border
 * and the shadow), §5.12.4.3 (no third scroller), §5.1 rule 5 (no transitions),
 * spec-01 §7.2.
 *
 * THE ONE context-menu primitive, shared by the tree's file-row menu, its
 * folder-row menu, the empty-space menu and the vault bar's recents popover.
 * ONE PRIMITIVE, NOT FOUR.  Every one of them is `openMenu(entries, opts)` over
 * a plain data description; nothing else in the app builds a floating list.
 *
 * IT WAS FIVE UNTIL §0.12 E14.  The sort menu hung off nav slot 3, and E14
 * deleted the whole nav toolbar: sorting is pinned to file name A-Z at the
 * user's request, so `sortMenu` and `SORT_LABELS` are deleted here rather than
 * left as unreferenced exports.  §1.3 command 7 (`set_sort`) SURVIVES and is
 * still called — main.ts issues one `set_sort(0)` for a vault whose persisted
 * mode is not A-Z, which is the only thing that can now change it.
 *
 * Ground `--bg-menu` + `1px solid --menu-border-color` + `--menu-shadow`, which
 * are Obsidian's own two tokens and NOT the two this file used to name (§0.27
 * E67): `--bg-modifier-border` is the SEPARATOR's grey, and `--shadow-popover`
 * is a single `0 2px 8px` where Obsidian's menu carries three layers.  The
 * Delete row is `--text-error`; the raw #e05252 literal is STRUCK (§5.1 X3).
 *
 * §0.27 E67 CORRECTED THREE THINGS IN THIS FILE, all in the vault switcher's
 * popover and all visible in one screenshot the user sent: the tick was a left
 * gutter and Obsidian's is a trailing glyph; the icon slot was conditional on
 * the menu carrying an icon and Obsidian's is unconditional; and the slot was a
 * 16px box where Obsidian's is `flex: 0 1 auto` and collapses to nothing when
 * empty.  The measurement is in the pinned engine against Obsidian's own
 * app.css.  READ ITS `MenuItem` CONSTRUCTOR, NOT ITS STYLESHEET ALONE: the
 * `.menu.mod-no-icon` rule E16 reasoned from is real, and it is an opt-in
 * (`setNoIcon()`) that nothing in the vault popover's call path takes.
 *
 * §0.14 E16 REBUILT THE BOX TO OBSIDIAN'S OWN METRICS, read out of the `app.css`
 * inside the Obsidian installed on this machine rather than measured off a
 * screenshot: 13px rows on a 1.3 line-height in 4px/8px padding, an 8px gap, a
 * 16px glyph on every row, 4px row radius, 8px box radius, and a separator that
 * is a 1px rule with 6px of margin bleeding 6px past the box's own 6px padding.
 * The rows are therefore 24.9px, not the 28 this menu used to draw — and that
 * number is DERIVED (13 x 1.3 + 4 + 4), never pinned, because §0.7 E9's lesson
 * is that hardcoding the answer instead of the rule is what breaks the moment
 * anything around it moves.
 *
 * "Reveal in Finder" IS GONE FROM THESE MENUS (§0.12 E14, a user decision), and
 * `Copy absolute path` takes its place.  X11 restored the row in errata 1 and
 * these menus were its only caller; §1.3 command 20 `reveal_in_os` is NOT
 * orphaned by the removal, because main.ts's delete-failure dialog still offers
 * `Show in Finder` and is now its only caller.  That sentence in §1.3 — "the
 * tree context-menu row … is the only caller" — is amended by E14, not silently
 * falsified.
 *
 * `Copy absolute path` needs NO command and crosses no IPC: `VaultInfo.root` is
 * already the absolute vault root in the frontend, and the write is
 * `navigator.clipboard.writeText`.  The webview is a secure context on both
 * platforms — Tauri serves `tauri://localhost` (a loopback host) and wry
 * registers the scheme as secure on WebKitGTK — so the API is exposed; WebKit
 * requires TRANSIENT ACTIVATION for it, which is why `activate()` below calls
 * `onSelect()` synchronously inside the click task and why no handler on this
 * path may `await` before the write.
 *
 * §5.12.4.3: A MENU MUST FIT OR CLIP.  It may NOT become the document's third
 * scrollable box — a viewport-sized scroller is ~23.5 MB at 2x and fails both
 * the probe's `layers.scrollers` row and gate G5d.  So: no `overflow: auto`
 * anywhere below, no `max-height` paired with scrolling, and placement is
 * arithmetic (`clampPopup`, which flips above the anchor before it clips).
 * THE TALLEST MENU IN THE APP IS THE VAULT BAR'S RECENTS POPOVER, not a row
 * menu: §7.6 caps `recents` at 8, and vaultbar.ts appends a separator and
 * `Open folder as vault…`, so its worst case is 9 rows plus 1 separator.
 * §0.14 E16 RE-CUT EVERY TERM OF THAT SUM and this paragraph was left on the old
 * one for a whole pass — the row is 24.9px, not 28, and the separator is 13px
 * (a 1px rule with 6px of margin either side), not 9:
 *
 *     recents popover   9 x 24.9 + 13 + 12 = 249.1px   (was 269)
 *     a FOLDER menu     6 x 24.9 + 26 + 12 = 187.4px   (was 162.5: the secret
 *                                                       file row arrived)
 *     a FILE menu       3 x 24.9 + 13 + 12 =  99.7px   (§0.16 E18 — the two
 *                                                       create rows are gone)
 *
 * plus 2px of border on each, which the sums above deliberately omit because the
 * assertion in chrome-ui.test.mjs omits it too.  249.1px against the 919px pane
 * below the title strip is why the clip branch is unreachable in practice; it
 * exists only so that an absurd viewport degrades into a clipped menu instead of
 * a new compositing layer.  The vault popover also has to FLIP: it is anchored
 * at content y 915 of 958 and 915 − 249.1 = 665.9, so it always has room above
 * and never reaches the clamp.  E16 made that margin BIGGER, not smaller.
 *
 * The element lives in <body> only while the menu is open: there is NO
 * persistent popup layer and no backdrop element, because a permanently mounted
 * viewport-sized box is exactly the thing §5.12 spent three spikes removing.
 * Outside-dismissal is a document-level capture listener instead.
 *
 * WHAT DISMISSES A MENU IS A CLOSED SET, AND IT IS OBSIDIAN'S (§0.28 E68).  Its
 * `Menu.onload` registers exactly three window events — `mousedown` and `click`
 * (both -> `handleClickOutside`) and, on desktop, `contextmenu` -> `hide` — plus
 * an `Escape` in the keymap scope it pushes.  That is all of them.  So:
 *
 *     pointerdown / click outside · Escape · activating a row · right-click
 *
 * and NOTHING ELSE.  In particular **there is no `blur` handler**: an Obsidian
 * menu survives Alt-Tab, and so does this one.  Cairn closed on `blur`,
 * `resize` and capture-phase `scroll` until the user reported the first of them
 * — *"Obsidian persists this menu even when I alt+tab"* — and all three are
 * gone.  Adding one back is a divergence, not a hardening: a menu that vanishes
 * because the window lost focus loses the user's place for a reason they cannot
 * see.
 *
 * §0.13 E15's account of the WebKitGTK menu is a DATED RECORD, not a dependency:
 * it explains that taking a GTK popup blurred the webview and this handler ate
 * Cairn's menu inside one event.  The fix for E15 was `tree.ts`'s missing
 * `ev.preventDefault()`, which is still there, and the engine that drew that
 * popup was deleted with Tauri (§0.20.6 E35).
 */

import { type IconName, paintIcons } from './icons'

/** Obsidian's `yv`: a length, or 0 when it is empty or not a number. */
function num(v: string): number {
  const n = parseFloat(v)
  return Number.isNaN(n) ? 0 : n
}

export interface MenuAction {
  label: string
  onSelect(): void
  /** §0.14 E16.  Obsidian draws a 16px glyph on every row of a file menu, so
   *  Cairn does too.  OPTIONAL — and since §0.27 E67 the SLOT is not: a row with
   *  no icon still emits an empty one, zero wide, and pays the row's 8px gap for
   *  it, exactly as Obsidian's does. */
  icon?: IconName
  /** Renders in --text-error.  Delete, and nothing else today. */
  danger?: boolean
  disabled?: boolean
  /** A radio tick — the vault bar's recents popover marks the open vault with
   *  it.  It was the sort menu's current mode too, until §0.12 E14 deleted that
   *  menu; vaultbar.ts is now the only consumer.  §0.27 E67: the tick is a
   *  `check` glyph at the row's RIGHT edge, not a left gutter. */
  checked?: boolean
  /** §0.30 E70 — A SECOND CONTROL ON THE ROW, at its trailing edge, and a real
   *  `<button>` rather than a mark: activating it runs THIS and not `onSelect`.
   *  The vault bar's `Close` is the only consumer.
   *
   *  **OBSIDIAN HAS NO SUCH THING IN A MENU** — its per-row buttons live in the
   *  vault CHOOSER, a window Cairn does not have — so this is a divergence the
   *  user asked for, and it is built to cost the resting menu NOTHING: the
   *  button is absolutely positioned, out of flow, and revealed on hover.  A
   *  hidden-but-in-flow button would have widened every menu that has one by
   *  24px and silently undone §0.27 E67's pixel work. */
  trailing?: { icon: IconName; label: string; onSelect(): void }
}

export interface MenuSeparator { separator: true }

export type MenuEntry = MenuAction | MenuSeparator

function isAction(e: MenuEntry): e is MenuAction {
  return !('separator' in e)
}

export interface MenuOptions {
  /** THE POINT THE MENU IS PLACED AT, in client coordinates — Obsidian's
   *  `showAtPosition({x, y})`, and in every case in this app it is the POINTER
   *  (§0.29 E69).  It is not a corner: `placeMenu` decides which corner lands
   *  here, and near the bottom of the window that corner is the BOTTOM-left.
   *  A caller with no pointer to offer (⌘⇧O) passes an anchor's top-left. */
  x: number
  y: number
  /** Accessible name for the list. */
  label?: string
  /** Extra class on the box, for a menu-scoped width floor or similar.
   *  Unset everywhere except the viewer Copy/Paste menu: the row menus keep
   *  Obsidian's content-sized box (see chrome.css). */
  cls?: string
  /** Called after the menu closes, however it closed. */
  onClose?(): void
}

/**
 * §0.29 E69 — OBSIDIAN'S `Menu.showAtPosition`, TRANSCRIBED.  Its desktop
 * branch, for the no-`width`/no-`left`/no-`overlap` call that
 * `showAtMouseEvent` makes, is six lines and this is all of them:
 *
 *     var g = r + 2, y = r - 2                           // r = x
 *     var w = y - h >= 0                                 // h = menu WIDTH
 *     !(g + h <= d) || e.left && w ? b.left = Math.max(0, y - h) : b.left = g
 *     o + p > f && (o = Math.max(m, o - p))               // p = menu HEIGHT
 *     b.top = o + 2
 *
 * so, with `e.left` undefined:
 *
 *   - x: `x + 2` if the menu fits to the RIGHT of the point, else its right edge
 *     goes 2px to the LEFT of the point (`x - 2 - w`), floored at 0.
 *   - y: `y + 2`, unless that would overflow the bottom, in which case the menu
 *     is lifted by its own height first — so its BOTTOM lands at `y + 2`.
 *
 * **That last clause is the answer to "the bottom-left corner is always where I
 * put my cursor"** (the user, 2026-09-11).  A menu opened near the bottom of the
 * window has its bottom-left corner at `(x + 2, y + 2)`; one opened with room
 * below has its TOP-left there.  It is one rule, not two.
 *
 * NOTE WHAT IS ABSENT.  There is no viewport MARGIN — Obsidian will sit a menu
 * flush against the left edge (`Math.max(0, …)`) and flush against the right —
 * and there is no bottom clamp beyond the flip, so a menu taller than the space
 * above the point lands at `topInset + 2` and is CLIPPED at the bottom by
 * §5.12.4.3's `overflow: hidden` rather than scrolling.  The 4px margin Cairn
 * clamped to (`clampPopup`) is a Cairn invention; `clampPopup` survives for
 * `inline-edit.ts`'s own popup, which is not a menu.
 *
 * `topInset` is Obsidian's `m`: `body`'s `padding-top` plus its
 * `--safe-area-inset-top`.  Both are 0 in this app and it is transcribed
 * anyway, because the clause it guards — do not lift a menu off the top of the
 * window — is the one that would be silently wrong on a device that has one.
 *
 * Pure, and exported, so the arithmetic can be tested without a layout.
 */
export function placeMenu(
  x: number, y: number, w: number, h: number, vw: number, vh: number, topInset = 0,
): { left: number; top: number } {
  const gLeft = x + 2
  const gRight = x - 2
  const left = gLeft + w <= vw ? gLeft : Math.max(0, gRight - w)
  let top = y
  if (top + h > vh) top = Math.max(topInset, top - h)
  return { left, top: top + 2 }
}

export interface MenuHandle {
  close(): void
  readonly element: HTMLElement
}

/* ── the singleton ─────────────────────────────────────────────────────────── */

let open: {
  el: HTMLElement
  items: HTMLElement[]
  actions: MenuAction[]
  active: number
  onClose: (() => void) | undefined
  /** Whatever had focus when the menu opened — the tree scroller, in every case
   *  that matters.  The menu takes focus to run its own arrow keys, so without
   *  this an Escape leaves focus on <body> and the tree's keyboard navigation is
   *  silently dead until the user clicks a row.  Restored ONLY when the menu
   *  still holds focus at close: `activate()` closes before it runs the action,
   *  and the action's own focus() (an inline editor, a modal) must win. */
  returnFocus: HTMLElement | null
} | null = null

export function isMenuOpen(): boolean {
  return open !== null
}

/** Close whatever is open.  Safe to call when nothing is. */
export function closeMenu(): void {
  if (!open) return
  const o = open
  open = null
  const hadFocus = document.activeElement === o.el
  o.el.remove()
  if (hadFocus && o.returnFocus && o.returnFocus.isConnected) o.returnFocus.focus()
  document.removeEventListener('pointerdown', onDocPointerDown, true)
  document.removeEventListener('keydown', onDocKeyDown, true)
  document.removeEventListener('contextmenu', closeMenu, true)
  if (o.onClose) o.onClose()
}

function onDocPointerDown(ev: Event): void {
  if (!open) return
  const t = ev.target
  if (t instanceof Node && open.el.contains(t)) return
  closeMenu()
}

function onDocKeyDown(ev: KeyboardEvent): void {
  if (!open) return
  switch (ev.key) {
    case 'Escape':
      ev.preventDefault()
      ev.stopPropagation()
      closeMenu()
      break
    case 'ArrowDown':
      ev.preventDefault()
      ev.stopPropagation()
      move(1)
      break
    case 'ArrowUp':
      ev.preventDefault()
      ev.stopPropagation()
      move(-1)
      break
    case 'Home':
      ev.preventDefault(); ev.stopPropagation(); setActive(0, 1); break
    case 'End':
      ev.preventDefault(); ev.stopPropagation(); setActive(open.items.length - 1, -1); break
    case 'Enter':
    case ' ':
      ev.preventDefault()
      ev.stopPropagation()
      activate(open.active)
      break
    case 'Tab':
      ev.preventDefault()
      ev.stopPropagation()
      closeMenu()
      break
    default:
      break
  }
}

function move(delta: number): void {
  if (!open) return
  const n = open.items.length
  if (n === 0) return
  let i = open.active < 0 ? (delta > 0 ? -1 : 0) : open.active
  for (let step = 0; step < n; step++) {
    i = (i + delta + n) % n
    const a = open.actions[i]
    if (a && !a.disabled) { setActive(i, delta); return }
  }
}

function setActive(i: number, delta: number): void {
  if (!open) return
  const n = open.items.length
  if (n === 0) return
  let idx = i
  for (let step = 0; step < n; step++) {
    const a = open.actions[idx]
    if (a && !a.disabled) break
    idx = (idx + delta + n) % n
  }
  const prev = open.active >= 0 ? open.items[open.active] : undefined
  if (prev) prev.classList.remove('is-active')
  open.active = idx
  const el = open.items[idx]
  if (el) {
    el.classList.add('is-active')
    open.el.setAttribute('aria-activedescendant', el.id)
  }
}

function activate(i: number): void {
  if (!open) return
  const a = open.actions[i]
  if (!a || a.disabled) return
  // Close FIRST.  Every handler below opens something else — an inline editor,
  // a modal, a native folder dialog — and a menu still mounted when the inline
  // editor takes focus would take that focus straight back on its own blur.
  closeMenu()
  a.onSelect()
}

/* ── open ──────────────────────────────────────────────────────────────────── */

let seq = 0

/**
 * Open a menu.  Any menu already open is closed first — there is at most one
 * floating list in the document at any moment, which is also what keeps the
 * `layers.scrollers` count at two.
 */
export function openMenu(entries: MenuEntry[], opts: MenuOptions): MenuHandle {
  closeMenu()

  const el = document.createElement('div')
  el.className = 'ctx-menu' + (opts.cls ? ' ' + opts.cls : '')
  el.setAttribute('role', 'menu')
  el.tabIndex = -1
  if (opts.label !== undefined) el.setAttribute('aria-label', opts.label)

  const items: HTMLElement[] = []
  const actions: MenuAction[] = []
  const id = ++seq

  for (const entry of entries) {
    if (!isAction(entry)) {
      const sep = document.createElement('div')
      sep.className = 'ctx-sep'
      sep.setAttribute('role', 'separator')
      el.appendChild(sep)
      continue
    }
    const row = document.createElement('div')
    row.className = 'ctx-item'
    row.id = 'ctx-' + id + '-' + items.length
    row.setAttribute('role', entry.checked === undefined ? 'menuitem' : 'menuitemradio')
    if (entry.checked !== undefined) row.setAttribute('aria-checked', String(entry.checked))
    if (entry.danger) row.classList.add('is-danger')
    if (entry.disabled) { row.classList.add('is-disabled'); row.setAttribute('aria-disabled', 'true') }
    if (entry.checked) row.classList.add('is-checked')

    // §0.27 E67 — EVERY ROW EMITS THE SLOT, ALWAYS, and an iconless one is
    // EMPTY rather than absent.  §0.14 E16 made the gutter conditional on the
    // menu carrying at least one icon and called that Obsidian's rule; it is
    // not.  Obsidian's `MenuItem` constructor is three lines and the middle one
    // is unconditional — `this.iconEl = t.createDiv("menu-item-icon")` — and
    // `.menu.mod-no-icon` is an OPT-IN a caller takes by calling `setNoIcon()`,
    // which the vault switcher does not.
    //
    // The slot is not a 16px box.  `.menu-item-icon` is `flex: 0 1 auto` with no
    // width, so an empty one is 0 wide and the row's 8px `gap` is the whole of
    // what it costs.  Measured in the pinned engine against Obsidian's own
    // app.css: a label sits 23px from the menu's outer left edge with an empty
    // slot (1 border + 6 padding + 8 row padding + 0 + 8 gap) and 39px with a
    // filled one.  Cairn drew the vault popover's labels at 15 and its ticked
    // rows at 37.
    const ico = document.createElement('span')
    ico.className = 'ctx-icon'
    if (entry.icon !== undefined) ico.dataset['icon'] = entry.icon
    row.appendChild(ico)

    const label = document.createElement('span')
    // §6.1: textContent, never innerHTML.  A note or folder name reaches the DOM
    // as TEXT everywhere in this app; icons.ts holds the only markup literals.
    label.className = 'ctx-label clipline'
    label.textContent = entry.label
    row.appendChild(label)

    // §0.27 E67 — THE TICK IS A TRAILING GLYPH, NOT A LEFT GUTTER.  Obsidian's
    // `setChecked(true)` appends a SECOND `menu-item-icon`, classed
    // `mod-checked` and holding `lucide-check`, AFTER the title — so it lands at
    // the row's right padding edge, pushed there by the title's `flex-grow`.
    // Cairn drew a `::before` "✓" text glyph in 30px of extra left padding,
    // which moved every ticked row's label 22px right of every plain one.  The
    // row also takes `mod-checked`, as Obsidian's does; no stylesheet in either
    // app reads that class, and it is emitted for parity and for tests.
    //
    // spec-01 §7.2 had the SIDE and the GLYPH right — `.menu-item.is-checked::
    // after`, "lucide `check`, --text-muted" — and the implementation went the
    // other way.  Its 14px is wrong: the mark is a `.menu-item-icon` like any
    // other, so it is `--icon-s` 16 at stroke 2.  And Obsidian appends a real
    // ELEMENT, not an `::after`, which is what lets the title's flex-grow push
    // it to the edge.
    if (entry.checked === true) {
      const tick = document.createElement('span')
      tick.className = 'ctx-icon mod-checked'
      tick.dataset['icon'] = 'check'
      row.appendChild(tick)
      row.classList.add('mod-checked')
    }

    // §0.30 E70 — the trailing button.  LAST, and out of flow (chrome.css), so
    // the row's measured width is exactly what it would be without one.
    if (entry.trailing !== undefined) {
      const t = entry.trailing
      const btn = document.createElement('button')
      btn.className = 'ctx-row-btn'
      btn.type = 'button'
      btn.dataset['icon'] = t.icon
      btn.setAttribute('aria-label', t.label)
      btn.title = t.label
      btn.tabIndex = -1
      // STOP THE EVENT, or the row's own listener runs too and the click both
      // removes the vault and switches to it.  `pointerdown` as well as `click`:
      // the row does not listen for pointerdown, but the document-level
      // outside-click handler reads it and a future row listener would.
      const eat = (ev: Event): void => { ev.preventDefault(); ev.stopPropagation() }
      btn.addEventListener('pointerdown', eat)
      btn.addEventListener('mousedown', eat)
      btn.addEventListener('click', (ev) => {
        eat(ev)
        // Same order as `activate()`: close FIRST, then run the handler, because
        // the handler reopens this very menu.
        closeMenu()
        t.onSelect()
      })
      row.appendChild(btn)
    }

    const idx = items.length
    row.addEventListener('mouseenter', () => { if (!entry.disabled) setActive(idx, 1) })
    row.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); activate(idx) })
    el.appendChild(row)
    items.push(row)
    actions.push(entry)
  }

  // §6.1: icons.ts is the only file in the app that may write markup, so the
  // glyphs are painted through ITS pass over the `[data-icon]` hosts built
  // above — never by assigning innerHTML here.  It must run BEFORE the measure
  // below, or an icon-bearing menu is measured at the width it would have had
  // with empty slots and lands a few pixels off.  UNCONDITIONAL since §0.27
  // E67: the hosts are unconditional now, and a `[data-icon]`-less one is left
  // alone by `paintIcons` anyway.
  paintIcons(el)

  // Measure off-screen, then place.  One layout read, before the element is
  // visible, so no flash at the wrong position.
  el.style.left = '0px'
  el.style.top = '0px'
  el.style.visibility = 'hidden'
  document.body.appendChild(el)

  const prevFocus = document.activeElement
  open = {
    el, items, actions, active: -1, onClose: opts.onClose,
    returnFocus: prevFocus instanceof HTMLElement && prevFocus !== document.body ? prevFocus : null,
  }

  const w = el.offsetWidth
  const h = el.offsetHeight
  // `body.clientWidth/clientHeight`, which is what Obsidian measures against —
  // NOT `window.innerWidth`.  §5.12.5 pins `html, body { overflow: hidden;
  // height: 100% }`, so the two agree here by construction; the body is used
  // because that is the box whose padding `topInset` reads.
  const body = document.body
  const view = document.defaultView
  const cs = view === null ? null : view.getComputedStyle(body)
  const topInset = cs === null
    ? 0
    : num(cs.paddingTop) + num(cs.getPropertyValue('--safe-area-inset-top'))
  const p = placeMenu(opts.x, opts.y, w, h, body.clientWidth, body.clientHeight, topInset)
  el.style.left = p.left + 'px'
  el.style.top = p.top + 'px'
  el.style.visibility = ''

  document.addEventListener('pointerdown', onDocPointerDown, true)
  document.addEventListener('keydown', onDocKeyDown, true)
  // CAPTURE, and that is not a style choice (§0.28 E68).  Obsidian binds its
  // `contextmenu` -> `hide` to the WINDOW in the bubble phase, which is safe for
  // it because every menu is an instance and the handler hides the one it was
  // bound to.  Cairn's menu is a SINGLETON, so a bubble-phase listener would
  // reach the menu a tree row's own `contextmenu` handler had just opened and
  // close it in the same event.  In capture it runs first: the old menu is gone
  // before `openMenu` is called for the new one, which is what `openMenu` does
  // on its own line anyway.
  document.addEventListener('contextmenu', closeMenu, true)
  el.focus()

  return { close: closeMenu, element: el }
}

/* ── the menus themselves, as data ─────────────────────────────────────────── */

/**
 * The five actions a tree row's menu can perform (§0.12 E14).  There is no
 * settings UI and, since E14 deleted the nav toolbar, THE CONTEXT MENU IS THE
 * ONLY ROUTE to New folder, Rename, Copy absolute path and Delete — New note
 * alone has three others (Mod-N, the tab strip's `+`, and this menu).  That is
 * why nothing here may be dropped for want of an owner.
 */
export interface RowMenuActions {
  newNote(): void
  newFolder(): void
  /** A secret file (user feature, 2026-09-16): a note with the
   *  `cairn-type: secrets` marker, rendered as a credentials manager. */
  newSecret(): void
  rename(): void
  copyPath(): void
  remove(): void
}

/** The three that act on THIS entry, whatever it is.  §0.16 E18 splits them out
 *  so the type system carries the rule: a file row cannot be handed a `newNote`
 *  it must not offer, because `fileRowMenu` has nowhere to put one. */
export type EntryActions = Pick<RowMenuActions, 'rename' | 'copyPath' | 'remove'>

/**
 * §0.16 E18 — THE FILE ROW OFFERS NO CREATE ROWS.  A user decision, and it is
 * Obsidian's own behaviour rather than a divergence: `app.js` builds the two
 * create rows inside `if (t instanceof ZT)` — the folder branch — while Rename
 * and Delete sit outside it, so a right-click on a FILE in Obsidian shows no
 * `New note` and no `New folder` either.
 *
 * THIS RESOLVES AN AMBIGUITY RATHER THAN TRADING ONE AWAY, and the comment that
 * used to sit here is the record of it: `folderRowMenu` was `= fileRowMenu`
 * because "New note" meant *inside* on a folder and *beside* on a file, and one
 * label could not honestly say both. With the row gone from the file menu the
 * word only ever means one thing — inside this folder, or at the root from empty
 * space — so the two menus can finally differ and the label stops lying.
 *
 * Delete last, and it is the only --text-error row.  `Copy absolute path` sits
 * with Rename because both act on THIS entry.
 *
 * THE GLYPHS ARE OBSIDIAN'S OWN, AND THEY ARE VERIFIABLE BY GREP (§0.15 E17).
 * Every name is the string Obsidian's `setIcon()` is called with, minus its
 * `lucide-` prefix, so `app.js` settles the mapping without judgement:
 *
 *     New note   setTitle(…menuOptNewNote()).setIcon("lucide-edit")
 *     New folder setTitle(…menuOptNewFolder()).setIcon("lucide-folder-open")
 *     Rename     setTitle(…menuOptRename()).setIcon("lucide-edit-3")
 *     Delete     setTitle(…menuOptDelete()).setIcon("lucide-trash-2")
 *     Copy path  setSectionSubmenu("info.copy", { …, icon: "lucide-clipboard" })
 *
 * §0.14 E16 GOT FOUR OF THE FIVE WRONG and asserted in this very comment that
 * they were Obsidian's — it read them off a screenshot instead of the source it
 * claimed to be citing, and the test written to catch that drift pinned the
 * wrong answer as ground truth. Only `trash-2` survived. Change a name here and
 * the grep above stops matching; that is the point of naming them this way.
 *
 * `clipboard` is Obsidian's glyph for the `Copy path ▸` PARENT row, which is
 * what Cairn's flat `Copy absolute path` stands in for. Its `link` is on that
 * row's CHILD, `Copy Obsidian URL`, which Cairn does not have.
 *
 * `New secret file` carries `lock`: secret files are Cairn-only (Obsidian has
 * no counterpart), so E17's grep-audit does not apply — and recalling a key
 * glyph from memory is the `refresh-cw` residual all over again.  The lock is
 * transcribed byte for byte from `lucide-static@0.469.0` (see icons.ts), at
 * the row menus' 16/2.
 */
export function fileRowMenu(a: EntryActions): MenuEntry[] {
  return [
    { label: 'Rename…', onSelect: a.rename, icon: 'edit-3' },
    { label: 'Copy absolute path', onSelect: a.copyPath, icon: 'clipboard' },
    { separator: true },
    { label: 'Delete', onSelect: a.remove, danger: true, icon: 'trash-2' },
  ]
}

/**
 * The folder menu: the file menu's three rows, plus the two creates ABOVE them.
 * It is no longer `= fileRowMenu` — §0.16 E18 is exactly the change that made
 * the two differ, and the destination is no longer the caller's to disambiguate
 * because there is only one meaning left: INSIDE this folder.
 */
export function folderRowMenu(a: RowMenuActions): MenuEntry[] {
  return [
    { label: 'New note', onSelect: a.newNote, icon: 'edit' },
    { label: 'New folder', onSelect: a.newFolder, icon: 'folder-open' },
    { label: 'New secret file', onSelect: a.newSecret, icon: 'lock' },
    { separator: true },
    ...fileRowMenu(a),
  ]
}

/** Right-click on the tree's empty space: create at the vault root, and nothing
 *  else.  There is nothing to rename or delete, so those rows are absent rather
 *  than disabled — a permanently greyed row is the inert decoration §9 E4
 *  rejects.
 *
 *  User ruling, 2026-09-14: NO `Copy absolute path` here either.  It used to
 *  copy the vault root's own path, which is always a valid string and never
 *  what anyone right-clicking empty space is reaching for — there is no
 *  file or folder under the cursor to copy.  File and folder rows keep theirs;
 *  only the subject-less menu loses the row, separator with it. */
export function emptySpaceMenu(
  a: Pick<RowMenuActions, 'newNote' | 'newFolder' | 'newSecret'>,
): MenuEntry[] {
  return [
    { label: 'New note', onSelect: a.newNote, icon: 'edit' },
    { label: 'New folder', onSelect: a.newFolder, icon: 'folder-open' },
    { label: 'New secret file', onSelect: a.newSecret, icon: 'lock' },
  ]
}

/**
 * The note/memoir viewer menu (2026-10-03): Copy and/or Paste, and nothing
 * else.  ONE PRIMITIVE, NOT THREE: the note viewer (CodeMirror) and the
 * Memoir page (a plain textarea) both build their rows here, so the two
 * viewers cannot drift apart.
 *
 * A row is offered only when it can act, and both may appear at once:
 * `hasSelection` (the viewer holds selected text) draws Copy;
 * `canPaste` (the viewer is editable AND the clipboard holds text) draws
 * Paste.  Neither condition alone implies the other, and when neither holds
 * there is no menu at all — the caller opens nothing rather than an empty
 * box.  Pure, so the row rule is testable without a clipboard.
 *
 * NO ICONS, deliberately.  Every `IconName` is an Obsidian transcription
 * audited by grep against its bundle (§0.15 E17); Copy/Paste have no
 * counterpart in the row menus to transcribe, and inventing glyphs from
 * memory is the `refresh-cw` residual all over again.
 */
export interface ClipMenuActions {
  copy(): void
  paste(): void
}

export function clipMenu(o: {
  hasSelection: boolean
  canPaste: boolean
} & ClipMenuActions): MenuEntry[] {
  const out: MenuEntry[] = []
  if (o.hasSelection) out.push({ label: 'Copy', onSelect: o.copy })
  if (o.canPaste) out.push({ label: 'Paste', onSelect: o.paste })
  return out
}
