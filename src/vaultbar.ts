/**
 * src/vaultbar.ts
 * Owner: 04.  Spec: CONTRACT.md §5.5/§5.10 R2 (the bar's geometry), §4.3 (vault
 * switch ordering, M30), §1.3 commands 1/2/4, §5.12.4.3 (no third scroller),
 * §9 E4 (the omitted ?/gear).
 *
 * The bottom-left vault switcher and its recents popover.
 *
 * THE ORDERING IS NORMATIVE AND IT IS A DATA-LOSS RULE (M30, §4.3).  On the JS
 * side: FLUSH THE EDITOR FIRST, then switch.  On the Rust side the swap is
 * `let old = guard.take(); drop(guard); drop(old);` — the old snapshot is
 * dropped OUTSIDE the lock, so a 5,000-node arena teardown does not hold every
 * reader out.  spec-06 §6.6's Rust paragraph and its JS ordering are STRUCK.
 *
 * §4.3's six steps, and which side of the seam each one lives on:
 *
 *   1  await flushNow("switch")                     -> deps.releaseVault
 *   2  persist state.json for the OUTGOING vault    -> deps.releaseVault
 *   3  view.setState(...)  NOT view.destroy() (M70) -> deps.releaseVault
 *   4  searchCancel(gen); clear the panel           -> deps.releaseVault
 *   5  drop the blob, the views, the ui/visible
 *      arrays, the name cache                      -> deps.releaseVault
 *   6  invoke open_vault(newRoot)                   -> HERE
 *
 * Steps 1-5 touch editor.ts (03), state.ts (04), search.ts (05) and tree.ts
 * (04) — four modules this file does not own and may not reach into (spec-07 §1
 * rule 5).  They are therefore ONE required dependency, `releaseVault`, whose
 * contract is: perform 1-5 IN THAT ORDER, and REJECT to abort the switch.  This
 * module never proceeds past a rejection, so "on REJECT, ABORT the switch and
 * show the error.  Never discard." is enforced here even though the flush is
 * not implemented here.  A vault switch that dropped a dirty buffer would be
 * the worst bug in this file, and the seam is drawn so it cannot happen.
 *
 * §9 E4, SETTLED: the reference's help "?" and settings gear at the right end of
 * this bar are OMITTED.  No space is reserved and nothing inert is drawn in
 * their place.  Do not add them back.
 *
 * §5.10 R2, and DO NOT CHASE IT: the measured ink band's centre is content
 * y 942.5, 3px below the 37px bar's interior centre (939.5).  The bar's inner
 * row is `display:flex; align-items:center` in the 36px interior and the
 * residual 3px is recorded as UNEXPLAINED rather than encoded as a magic
 * offset.  It is deliberately not gated (the probe's `vault.bar` row asserts the
 * box, the label's left at content x 38 and the 16px chevron box, and NOT the
 * ink band's vertical position).  Adding `padding-top: 3px` here would make one
 * number match and every other number in the bar wrong.
 *
 * §5.12.4.3: the recents popover MUST FIT OR CLIP.  It reuses menu.ts's ONE
 * primitive, which places by arithmetic and never scrolls — with the 8-entry
 * `recents` cap from §7.6 its tallest form is 10 rows, and it flips ABOVE the
 * bar (the bar sits at content y 915 of 958, so there is never room below).
 */

import { openMenu, closeMenu, type MenuEntry } from './menu'

/** §1.5 `VaultInfo`, narrowed to what this bar renders.  The full type is
 *  ipc.d.ts's (owner 02); this file states only the fields it reads so it does
 *  not have to wait on that file to compile, and structural typing makes the
 *  real `VaultInfo` assignable to it unchanged. */
export interface VaultBarInfo {
  root: string
  name: string
}

/** §1.5 `RecentVault`, verbatim. */
export interface VaultBarRecent {
  root: string
  name: string
  exists: boolean
}

export interface VaultBarDeps {
  /** §1.3 command 1.  The NATIVE folder dialog.  Resolves to `null` when the
   *  user cancels, which is not an error and is not reported as one. */
  pickVault(): Promise<string | null>
  /** §1.3 command 2, i.e. §4.3 step 6.  Must be called only after
   *  `releaseVault` has RESOLVED. */
  openVault(path: string): Promise<VaultBarInfo>
  /** §1.3 command 4. */
  recentVaults(): Promise<VaultBarRecent[]>
  /** §1.3 command 21 (§0.30 E70).  Drop a vault from the tracked list.  It
   *  writes `state.json` and touches nothing in the vault, and it REJECTS for
   *  the currently open vault — which is why the popover only offers it on a
   *  non-active row. */
  forgetVault(root: string): Promise<void>
  /**
   * §4.3 steps 1-5, in order, for the OUTGOING vault.  REJECT to abort the
   * switch — this module then leaves the current vault open and untouched and
   * surfaces the error.  Never resolve on a failed flush.
   */
  releaseVault(reason: string): Promise<void>
  /** Surfaced to the user; this module does not own error presentation. */
  onError(err: unknown, context: string): void
}

export interface VaultBar {
  /** Repaint from `nc://vault-opened`'s VaultInfo, or `null` for §7.5's
   *  first-run state where no vault is configured. */
  setVault(info: VaultBarInfo | null): void
  /** Open the recents popover.  Bound to the bar's button, to the title bar's
   *  `folder-open` slot and to the switch-vault shortcut.  §0.29 E69: `at` is
   *  the POINTER, because Obsidian places this menu at the cursor and not at
   *  the bar; a caller with no pointer (⌘⇧O) omits it and gets the bar. */
  openPopup(at?: { x: number; y: number }): void
  /** The full §4.3 switch, including the abort-on-reject rule.  Exposed so the
   *  §7.3 case 8 `[ Switch vault… ]` button can reach it. */
  pickAndSwitch(): Promise<void>
  readonly root: string | null
  destroy(): void
}

export function createVaultBar(deps: VaultBarDeps, root: ParentNode = document): VaultBar {
  const bar = root.querySelector<HTMLElement>('.vault-bar')
  const button = root.querySelector<HTMLElement>('.vault-switch')
  const nameEl = root.querySelector<HTMLElement>('.vault-name')

  let current: VaultBarInfo | null = null
  let busy = false

  function setVault(info: VaultBarInfo | null): void {
    current = info
    if (nameEl) nameEl.textContent = info ? info.name : 'No vault'
    if (button) {
      const t = info ? info.root : 'No vault open'
      button.title = t
      button.setAttribute('aria-label', info ? 'Switch vault — ' + info.name : 'Open a vault')
    }
  }

  /**
   * §4.3, the whole of it.  Step 1's rejection is the branch that matters: it
   * returns WITHOUT calling `openVault`, so the outgoing vault stays open with
   * its buffer intact.  Nothing here discards anything, ever.
   */
  async function switchTo(path: string): Promise<void> {
    if (busy) return
    if (current && current.root === path) return
    busy = true
    setBusy(true)
    try {
      try {
        await deps.releaseVault('switch')          // §4.3 steps 1-5
      } catch (err) {
        deps.onError(err, 'flush')                 // ABORT.  The switch does not happen.
        return
      }
      try {
        const info = await deps.openVault(path)    // §4.3 step 6
        setVault(info)
      } catch (err) {
        // Steps 1-5 have already run, so the old vault is gone and the new one
        // did not open.  Say so rather than leaving the bar naming a vault the
        // process no longer holds.
        setVault(null)
        deps.onError(err, 'open-vault')
      }
    } finally {
      busy = false
      setBusy(false)
    }
  }

  function setBusy(b: boolean): void {
    if (bar) bar.classList.toggle('is-busy', b)
    if (button) button.toggleAttribute('disabled', b)
  }

  /**
   * §0.30 E70 — forget a vault, then REOPEN the popover where it was.
   *
   * The reopen is what makes this feel like editing a list rather than firing a
   * command: menu.ts rebuilds a menu from data and has no live-update path, so
   * the only way to show the shorter list is to build it again. Obsidian gets
   * this for free — its vault list is a WINDOW that stays open and calls its own
   * refresh — and closing plus reopening at the same point is the nearest thing
   * a menu can do.
   *
   * On failure the popover is NOT reopened: the error is the thing to look at,
   * and a popover springing back over it would be the second surprise.
   */
  async function forget(root: string, at?: { x: number; y: number }): Promise<void> {
    try {
      await deps.forgetVault(root)
    } catch (err) {
      deps.onError(err, 'forget-vault')
      return
    }
    openPopup(at)
  }

  /** The native folder dialog, then the same switch path. */
  async function pickAndSwitch(): Promise<void> {
    let picked: string | null
    try {
      picked = await deps.pickVault()
    } catch (err) {
      deps.onError(err, 'pick-vault')
      return
    }
    if (picked === null) return                    // cancelled: not an error
    await switchTo(picked)
  }

  /**
   * §0.29 E69 — `at` IS THE POINTER, and that is Obsidian's own placement.
   * Its vault switcher builds the menu with `Menu.forEvent(clickEvent)`, which
   * is `showAtMouseEvent` -> `showAtPosition({x: e.clientX, y: e.clientY})`, so
   * the popover is placed at the CURSOR and not at the bar.  Reported by the
   * user: *"The left bottom corner of the dialog is always the place I place my
   * cursor."*
   *
   * OPTIONAL, because ⌘⇧O opens this popover too (`chrome.ts`'s
   * `deps.switchVault`) and a keyboard has no pointer.  Obsidian never has to
   * answer that — its switcher is a `div`, so it cannot be activated from the
   * keyboard at all.  The fallback is the bar's own top-left, which `placeMenu`
   * then turns into a popover whose bottom-left corner sits there: the same
   * place the old anchored code put it, reached by the one rule instead of by a
   * second one.
   */
  function openPopup(at?: { x: number; y: number }): void {
    if (!bar) return
    // Read the recents fresh on every open: another window, a rename or a
    // deletion can have changed `exists` since the last time this was shown.
    void deps.recentVaults().then(
      (list) => showPopup(list, at),
      (err) => {
        // A failure to LIST recents must not cost the user the ability to open
        // a vault at all, so the popover still opens with its one live row.
        deps.onError(err, 'recent-vaults')
        showPopup([], at)
      },
    )
  }

  function showPopup(list: VaultBarRecent[], at?: { x: number; y: number }): void {
    if (!bar) return
    const r = bar.getBoundingClientRect()
    const entries: MenuEntry[] = []
    for (const v of list) {
      const isOpen = current !== null && current.root === v.root
      entries.push({
        // A vault whose folder vanished MID-SESSION is SHOWN and DISABLED, not
        // hidden: the user's mental model is "my vaults", and silently dropping
        // one reads as data loss even when it is only a missing volume. On the
        // NEXT LAUNCH the core prunes it (`prune_missing_vaults`, user ruling
        // 2026-09-14), so this row only ever describes a deletion that happened
        // while the app was running.
        label: v.exists ? v.name : v.name + ' (missing)',
        disabled: !v.exists,
        checked: isOpen,
        onSelect: () => { void switchTo(v.root) },
        // §0.30 E70 — `Close`, on every row BUT the open one.  A user decision,
        // and Obsidian's own constraint arrives at the same place from the other
        // end: its `vault-remove` REFUSES a vault a window has open, so the row
        // that cannot be removed is exactly the row that carries the tick.
        // Omitted entirely rather than drawn disabled (§9 E4).
        //
        // A MISSING vault keeps its button. The row is disabled — you cannot
        // switch to a folder that is gone — but forgetting it is the one thing
        // you can still do with it, and it is the commonest reason to want this
        // control at all.
        ...(isOpen ? {} : { trailing: { icon: 'x' as const, label: 'Close', onSelect: () => { void forget(v.root, at) } } }),
      })
    }
    if (entries.length > 0) entries.push({ separator: true })
    // §0.27 E67 — Obsidian's last row is `setTitle(manageVaults()).setIcon(
    // "open-vault")`, and the glyph is the only part of it Cairn can copy: there
    // is no vault MANAGER here, and the user's ruling is that there does not
    // need to be one ("we only need a feature to adding a vault").  So the row
    // keeps Cairn's label and Cairn's action — the native folder picker — and
    // takes Obsidian's glyph, which is the thing that makes the popover the
    // right SHAPE: the last row's label sits 16px right of the vault names'
    // above it, in both apps, because its icon slot is filled and theirs are
    // not.  §9 E4 is satisfied: the control works.
    entries.push({
      label: 'Open folder as vault…',
      icon: 'open-vault',
      onSelect: () => { void pickAndSwitch() },
    })

    // NO `flipAboveY` AND NO ANCHOR ARITHMETIC.  `placeMenu` lifts a menu that
    // would overflow the bottom by its own height, and at content y ~915 of a
    // 964px window this one always does — so the popover opens upward for the
    // same reason it did before, out of Obsidian's rule rather than out of a
    // flag this call site had to set.
    openMenu(entries, {
      x: at ? at.x : r.left,
      y: at ? at.y : r.top,
      label: 'Vaults',
    })
  }

  /**
   * A REAL pointer position, or none at all.  A `<button>` activated with Enter
   * or Space fires a `click` whose `clientX`/`clientY` are 0 and whose `detail`
   * is 0 — and 0,0 is a real coordinate, so it cannot be told from a click in
   * the window's top-left corner by looking at the numbers.  `detail` is what
   * separates them: it is the click count for a mouse and 0 for a synthesised
   * activation.  Without this check ⌘⇧O-through-the-button would drop the
   * popover in the corner of the screen.
   */
  function onButtonClick(ev: Event): void {
    ev.preventDefault()
    ev.stopPropagation()
    const m = ev as MouseEvent
    openPopup(typeof m.detail === 'number' && m.detail > 0
      ? { x: m.clientX, y: m.clientY }
      : undefined)
  }

  if (button) button.addEventListener('click', onButtonClick)
  setVault(null)

  return {
    setVault,
    openPopup,
    pickAndSwitch,
    get root(): string | null { return current ? current.root : null },
    destroy(): void {
      if (button) button.removeEventListener('click', onButtonClick)
      closeMenu()
    },
  }
}
