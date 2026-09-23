/**
 * src/tabstrip.ts
 * Owner: 03 (MOVED in — CONTRACT.md §6.4, M56).  Spec: §7.4 (the tab strip and
 * the empty state), §5.7 (the drag region this markup sits inside).
 *
 * Locked feature 5 had pixel geometry and no behaviour, and its ownership was
 * disclaimed in a loop; §7.4 assigns it here.  User ruling 2026-09-16: BOTH
 * tabs are FIXED and neither carries a close button — *"Please remove the
 * close button on the first tab: We don't need that. Two tabs will be always
 * on this app. Fixed. Can't close!"*  §7.4's close table (clean -> close,
 * dirty -> flush-first with the §1.6 modal) is therefore VOID for the tab
 * strip: there is no control left that discards anything, and the dirty-close
 * guard lives on the paths that still tear down (quit, vault switch, delete).
 *
 *   no note open               -> the note tab is NOT RENDERED and the pane is
 *                                 EMPTY.  (This used to read "the strip shows
 *                                 only the `+` button" — §0.30 E71 DELETED that
 *                                 button, so with no note open the strip shows
 *                                 the Memoir tab alone.  Corrected, not quietly
 *                                 dropped.)
 *   the empty state            -> §0.45 E91: THERE IS NO LONGER ONE.  The
 *                                 centred `No note open` line this module used
 *                                 to toggle is deleted, so "no note open" is
 *                                 now expressed by the note tab's absence alone.
 *
 * There is NO `(deleted)` tab marker: spec-04 §10.4's row is STRUCK (case 3).
 * TWO FIXED TABS since 2026-09-15/16 (user features): the note tab and the
 * `Memoir` tab, second, neither closable.  Exactly one carries `.is-active` at
 * any moment; the inactive style (transparent, no ring, no curves) is Obsidian
 * 1.13.7's own `.workspace-tab-header`, transcribed in
 * `src/styles/chrome.css`.  G9's `tab` row reads `.tab.is-active`, so it keeps
 * asserting the active tab's box and never sees the second one.
 *
 * THE SCAFFOLD DEVIATION THIS FILE CLOSES.  index.html ships `.tab` VISIBLE with
 * no note open — deliberately, so its measured geometry (left 430, width 200,
 * height 39, fill #1c1c1c) was verifiable before the tab had any behaviour — and
 * that contradicts §7.4's "the tab is not rendered".  `hideTabUntilWired()` is
 * called from chrome.ts's `mountChrome()`, i.e. on the boot path that exists
 * TODAY, so the deviation is closed even before main.ts wires this module.
 * `.tab[hidden] { display: none }` was already waiting in chrome.css.
 *
 * NOTE FOR THE GEOMETRY GATE (§5.11): the probe's `tab` row asserts x 430 /
 * width 200 / height 39 / #1c1c1c, and a `display:none` tab reads back as zeros.
 * That row therefore requires the fixture's note to be OPEN — which §5.11's
 * fixture already mandates ("the open note containing a fenced ```sh block") —
 * and `setNote()` to have run before the probe's first animation frame.  This is
 * the same ordering every `.cm-line`, `.nc-title` and `.nc-cb` row already
 * depends on; the tab simply joins them.  It is reported, not silently assumed.
 */

import { displayName } from './inline-edit'

export type TabId = 'note' | 'memoir'

export interface TabStripDeps {
  /**
   * Click on the INACTIVE tab, either direction.  The shell switches through
   * `openNote`, which flushes first and ABORTS on a rejection — so a refused
   * write keeps the current tab.  Optional so older harnesses (whose fixture
   * holds one tab and no memoir element) keep working: with no second tab
   * there is nothing to select.
   */
  onSelect?(which: TabId): void
}

export interface TabStrip {
  /** `null` hides the note tab (§7.4 row 3).  It used to show the empty state too;
   *  §0.45 E91 deleted that element, so hiding the tab is the whole of it. */
  setNote(path: string | null): void
  /** The fixed second tab: visible whenever a vault is open, never closable.
   *  Its label is fixed markup ("Memoir") and is never written here. */
  setMemoirVisible(visible: boolean): void
  /** Exactly one tab carries `.is-active`; G9 reads that one. */
  setActive(which: TabId): void
  /** Repaint the label after a rename (§7.3 case 4, §5.4.2). */
  setDirty(dirty: boolean): void
  readonly path: string | null
  readonly active: TabId
  destroy(): void
}

/**
 * Close the §7.4 scaffold deviation on the boot path that exists today.
 * Idempotent, DOM-only, and safe to call before any IPC wiring exists.
 * Hides EVERY `.tab` — the note tab and the fixed Memoir tab alike.
 */
export function hideTabUntilWired(root: ParentNode = document): void {
  const tabs = root.querySelectorAll<HTMLElement>('.tab')
  tabs.forEach((tab) => { tab.hidden = true })
  // §0.45 E91: there is no `.empty-state` to un-hide any more.  This function
  // is now the tab half alone, and it keeps its name and its caller because the
  // scaffold deviation it closes is unchanged — `index.html` still ships `.tab`
  // VISIBLE so its geometry is measurable before the strip has any behaviour.
}

export function createTabStrip(deps: TabStripDeps, root: ParentNode = document): TabStrip {
  // The primary tab keeps the ORIGINAL selectors: the first `.tab` in DOM
  // order is the note tab (index.html), and the unit fixture holds exactly one
  // `.tab` with no `data-tab` at all — so these queries behave identically for
  // both, and the memoir half below is purely additive.
  const tab = root.querySelector<HTMLElement>('.tab')
  const label = root.querySelector<HTMLElement>('.tab-label')
  // The fixed second tab.  ABSENT in older harnesses (and their fixtures), so
  // every touch below is null-guarded and the module is fully working with one
  // tab — which is also what makes the pre-memoir unit tests meaningful still.
  const memoir = root.querySelector<HTMLElement>('[data-tab="memoir"]')
  let path: string | null = null
  let active: TabId = 'note'

  function render(): void {
    if (tab) {
      tab.hidden = path === null
      tab.classList.toggle('is-active', active === 'note')
    }
    if (label && path !== null) label.textContent = displayName(path)
    // The tab's `title` is the only place the full vault-relative path is shown,
    // which matters as soon as two folders hold a `Notes.md`.
    if (tab && path !== null) tab.title = path
    else if (tab) tab.removeAttribute('title')
    if (memoir) memoir.classList.toggle('is-active', active === 'memoir')
  }

  function onTabClick(which: TabId): () => void {
    return (): void => {
      // Both tabs are fixed with no close button (user ruling 2026-09-16), so
      // every click here is a background click — a no-op while already there,
      // a switch request otherwise.  The shell owns the switch (flush-first);
      // this module never changes `active` on its own authority.
      if (active !== which) deps.onSelect?.(which)
    }
  }

  const noteClick = onTabClick('note')
  const memoirClick = onTabClick('memoir')
  if (tab) tab.addEventListener('click', noteClick)
  if (memoir) memoir.addEventListener('click', memoirClick)
  render()

  return {
    setNote(p: string | null): void { path = p; render() },
    setMemoirVisible(visible: boolean): void {
      if (memoir) memoir.hidden = !visible
    },
    setActive(which: TabId): void { active = which; render() },
    setDirty(dirty: boolean): void {
      // There is no `(deleted)` marker (STRUCK) and no dirty dot in the
      // reference's 200px tab; the class exists so the state is inspectable
      // from a test and from the probe without inventing pixels for it.
      // The flag belongs to the EDITOR buffer, so it rides the ACTIVE tab —
      // attributing Memoir's dirt to the note tab (or vice versa) would be a
      // lie the tests could not see and the user could.
      const host = active === 'memoir' && memoir !== null ? memoir : tab
      if (host) host.classList.toggle('is-dirty', dirty)
    },
    get path(): string | null { return path },
    get active(): TabId { return active },
    destroy(): void {
      if (tab) tab.removeEventListener('click', noteClick)
      if (memoir) memoir.removeEventListener('click', memoirClick)
    },
  }
}
