/**
 * src/chrome.ts
 * Owner: 01 (NEW OWNER — CONTRACT.md §6.4, X9/X10: nothing else drew these).
 * Spec: §5.6/§5.7 (macOS chrome and the drag region), §0.12 E14 (there is no
 * nav toolbar; §5.9 is STRUCK), §3.3 (the cap banners), §7.3 case 16 (the
 * watcher-degraded banner), §5.5 (the vault bar), §5.11 (the --pixeltest probe
 * kick-off), §7.3 case 8 (vault-lost), §7.5 (first run), §5.12.4.3 (no third
 * scroller), §7.2 (Mod-s).
 *
 * Owns the title bar, the vault bar's HOST, THE THREE BANNERS — §7.3 case 8's
 * vault-lost bar, §7.3 case 16's watcher-degraded bar and §3.3's cap banners —
 * the app's seven keyboard shortcuts and the probe kick-off.  Owns the `.sidebar`
 * shell but NOT its contents: `.tree-scroller`'s inside is owner 04's,
 * `.editor`'s is owner 03's, and no frontend module reaches into another's DOM
 * subtree (spec-07 §1, rule 5).
 *
 * §0.12 E14 DELETED THE NAV TOOLBAR, and with it four of the five things this
 * module used to wire.  What is left of that strip is one behaviour, not five:
 * `rescan_all()` now hangs off the watcher-degraded banner's `[ Refresh ]`,
 * which is the only state in which it was ever the right click.
 */

import { paintIcons } from './icons'
import { emitGeometryReport, emitWindowControl, onWindowState } from './ipc'
import { modalIsOpen } from './modal'
import { hideTabUntilWired, type TabId } from './tabstrip'

/* ── mount ─────────────────────────────────────────────────────────────────── */

/**
 * Paint the glyphs into their hosts and close the one markup deviation the
 * scaffold shipped on purpose: the tab is NOT RENDERED with no note open
 * (see tabstrip.ts).  This is the app's only innerHTML assignment (CONTRACT
 * §6.1) and it happens exactly once.
 */
export function mountChrome(root: ParentNode = document): void {
  applyPlatform(root)
  applySidebarW(root)
  applyGuideWidth(root)
  applyRowH(root)
  applyNavScrollbarW(root)   // after applyPlatform: it branches on `data-os`
  // …and again whenever the window comes back: macOS switches between classic
  // and overlay bars when a mouse is connected or removed, and the probe is the
  // only way this page learns.  Measured on 2026-09-15: the same Mac read 15px
  // with a mouse and 0px an hour later without one.  Guarded against double
  // registration: `mountChrome` is boot-once, but a second call must not stack
  // a second identical listener.
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    const w = window as Window & { __cairnNavFocusWired?: boolean }
    if (!w.__cairnNavFocusWired) {
      w.__cairnNavFocusWired = true
      window.addEventListener('focus', () => applyNavScrollbarW(root))
    }
  }
  paintIcons(root)
  hideTabUntilWired(root)
}

/**
 * §0.5 E7.  Correct `data-os` BEFORE `paintIcons`, so the Linux window controls
 * are painted in the same single pass as everything else and the strip never
 * renders with three empty 44px holes in it.
 *
 * index.html ships `data-os="macos"` and this only ever overwrites it with
 * `linux`, on the one signal that cannot be wrong: `window.__CAIRN_OS__`, set
 * by lib.rs's initialization script under `#[cfg(target_os = "linux")]`.  There
 * is deliberately no `navigator.userAgent` fallback — see globals.d.ts.
 *
 * Two things ride on this attribute, and the SECOND ONE IS A BUG FIX, not new
 * behaviour: `.window-controls` is `display: none` without it (chrome.css), and
 * `isMod()` below picks ⌘ over Ctrl with it.  Until now `data-os` was the string
 * `macos` on Debian too, so every ⌘-shortcut on Linux — Mod-s included — was
 * bound to Super and Ctrl-S fell through to the webview.
 */
function applyPlatform(root: ParentNode): void {
  if (window.__CAIRN_OS__ !== 'linux') return
  // Duck-typed, not `root instanceof Document`: `root` is a test double in the
  // suite and `Document` is not a global in node, so the `instanceof` would
  // throw before it could be false.
  const html = (root as Partial<Document>).documentElement ?? document.documentElement
  html.setAttribute('data-os', 'linux')
}

/* ── §0.7 E9 the sidebar resize ───────────────────────────────────────────── */

/** §0.7 E9 `[C]`.  Below this the tree is unreadable: the deepest indent guide
 *  sits at `--cx0 + d * --step`, and 180px still leaves room for a name at
 *  depth 6.  Obsidian has no single constant to copy here — its minimum falls
 *  out of a flex solver — so this is a choice, and it is named as one. */
export const SIDEBAR_MIN = 180

/** §0.7 E9 `[C]`.  What the EDITOR keeps, not what the sidebar may take.
 *  Expressed this way round because it is the editor that has a legibility
 *  floor: §5.3's line box is 32px of inset each side, so 320 leaves 256 of text.
 *  At the 900px minimum window (§6.1) this caps the sidebar at 580. */
export const EDITOR_MIN = 320

/**
 * The one place the width is bounded, exported PURE so the bounds are testable
 * without a DOM — a clamp that only exists inside a pointermove handler is a
 * clamp nobody ever checks.
 *
 * A window narrower than `SIDEBAR_MIN + EDITOR_MIN` cannot satisfy both. The
 * floor wins, because a sidebar that has collapsed to nothing looks broken and
 * an editor that is merely narrow does not. `minWidth: 900` (§6.1) means the
 * app never actually reaches that case; the branch exists so the arithmetic is
 * total rather than accidentally correct.
 */
export function clampSidebarW(want: number, winW: number): number {
  const max = Math.max(SIDEBAR_MIN, winW - EDITOR_MIN)
  if (!Number.isFinite(want)) return SIDEBAR_W_DEFAULT
  return Math.min(max, Math.max(SIDEBAR_MIN, Math.round(want)))
}

/** tokens.css's `[M]` 412, restated here as the fallback for a NaN or a missing
 *  persisted value. The token stays the source of truth for the CSS; this is
 *  the source of truth for the arithmetic, and `chrome-ui.test.mjs` asserts the
 *  two agree so they cannot drift. */
export const SIDEBAR_W_DEFAULT = 412

/**
 * §0.48 E96 — `--hairline`, the tree's indent-guide stripe, snapped the way
 * Chromium snaps a border.
 *
 * OBSIDIAN'S GUIDE IS A REAL `border-inline-start: 1px`, and a USED border is
 * snapped to whole device pixels — `floor(dpr)/dpr` CSS px, which is 0.8 at
 * dpr 1.25 and 1.0 at dpr 1 and 2 (§0.26.2 E66 established that rule for the
 * tab's 1px rule and it is the same one).  Cairn draws its guides as
 * `repeating-linear-gradient` stops on the row, because the row is ONE pooled
 * element and cannot carry N borders (spec-04 §5.4) — and a gradient stop is
 * rasterised by COVERAGE, not snapped.  So a flat `1px` stripe is 1.25 device
 * px, and wherever it began on a fractional column it painted TWO of them.
 *
 * That is the defect the user reported — *"Creds and Envs lines are unusually
 * thick"* — and it was measured as device columns 71 AND 72 both at full ink,
 * where every other guide in the same capture was a single column.
 *
 * THIS IS THE ONLY PLACE THE VALUE IS COMPUTED.  `tokens.css` declares `1px`,
 * which is the correct value at dpr 1 and 2 and therefore a fallback that is
 * right rather than merely safe — a page that never runs this function renders
 * exactly as it did before §0.48.
 *
 * Re-applied on `resize`, which is what fires when a window moves to a display
 * with a different scale; there is no dedicated dpr event, and
 * `matchMedia('(resolution: …)')` would need a listener per candidate scale.
 */
export function applyGuideWidth(root: ParentNode = document): void {
  const html = (root as Partial<Document>).documentElement ?? document.documentElement
  const dpr = typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1
  html.style.setProperty('--hairline', Math.floor(dpr) / dpr + 'px')
}

/**
 * 2026-09-15 [M] — `--row-h`, the tree row's pitch, MEASURED rather than the
 * round 27 spike D assumed and nobody re-derived.
 *
 * Obsidian's `.tree-item-self` (app.css:10353-10364) sets `font-size:
 * var(--nav-item-size)` = `--font-ui-small` = `--tree-fs` (13px, already
 * Cairn's own token), `line-height: var(--line-height-tight)` = 1.3, and
 * `padding: var(--nav-item-padding)` = 4px top and bottom (`--size-4-1`); its
 * `margin-bottom` (`--nav-item-margin-bottom` = `--size-2-1` = 2px) sits
 * BETWEEN rows.  That is the SAME split Cairn's own box model already keeps —
 * the fill is `top: 0; bottom: 2px`, so `--row-h − 2` is one item and `2` is
 * the gap (tree.css) — so the probe reproduces one item's height and this
 * function adds the 2px back.
 *
 * MEASURED, NOT COMPUTED FROM THE NUMBERS ABOVE: `1.3 × 13 = 16.9` exactly on
 * paper, but a browser's line-box height for a unitless `line-height` comes
 * from the FONT's own metrics rounded to its hinting grid, and spike Q's
 * whole history (§0.17) is that this project does not guess that rounding —
 * it was 26.890625 on this Mac's font, and a probe on THIS engine, with
 * whatever font is actually installed, is what makes the same number correct
 * on Debian's different one, rather than a second hardcoded literal for it.
 *
 * `tools/verify-geometry.js`'s `verify()` re-seats `K.rowH` from this same
 * `--row-h` before building its table, exactly as it already does for
 * `--hairline` — the gate asserts the ENGINE's number, not a fixed one.
 */
export function applyRowH(root: ParentNode = document): void {
  const doc = ((root as Partial<Document>).documentElement ? root : document) as Document
  const html = doc.documentElement
  try {
    const probe = doc.createElement('div')
    probe.style.cssText =
      'position:absolute;visibility:hidden;left:-9999px;top:-9999px;white-space:nowrap;' +
      'font-size:var(--tree-fs);line-height:var(--line-height-tight);' +
      'padding-top:4px;padding-bottom:4px'   // Obsidian's --size-4-1, vertical only
    probe.textContent = 'M'
    doc.body.appendChild(probe)
    const itemH = probe.getBoundingClientRect().height
    probe.remove()
    if (Number.isFinite(itemH) && itemH > 0) {
      html.style.setProperty('--row-h', itemH + 2 + 'px')   // + Obsidian's --size-2-1 margin-bottom
    }
  } catch {
    // A test double with no layout: tokens.css's 27px fallback stands, same as
    // tree.ts's own `ROW_H_FALLBACK`.
  }
}

/**
 * 2026-09-15 [M] — `--nav-scrollbar-w`: the width Obsidian's file-tree
 * scrollbar takes out of its rows' box while the tree overflows.  tree.css
 * spends it on the fill's right inset; see `.tree-scroller.is-overflowing`.
 *
 * Obsidian branches on the platform, `rd.isMacOS ||
 * document.body.addClass("styled-scrollbars")`:
 *  - Linux takes the styled `::-webkit-scrollbar` at `--scrollbar-width: 12px`
 *    (app.css:2623, :9654) — a constant.  From the stylesheet; NOT measured on
 *    Debian.
 *  - macOS matches no `::-webkit-scrollbar` rule at all.  Its bar is Chromium's
 *    own, coloured by `body:not(.styled-scrollbars) { scrollbar-color:
 *    var(--scrollbar-thumb-bg) var(--scrollbar-bg) }` (:9651, with `gray` from
 *    `.mod-macos`, :3028), so its width belongs to the ENGINE and the SYSTEM
 *    setting — 15px with classic scroll bars, 0 with overlay ones.  It is
 *    therefore MEASURED, on a throwaway box carrying exactly that declaration.
 *    The same probe was taken on this Mac in both apps: 15 in Obsidian's
 *    Chrome 150, 15 in Cairn's Chrome 142 (and 11 in both under `thin`, which
 *    Obsidian does not set).
 *
 * Read at mount and again on every window `focus` (mountChrome): Obsidian's bar
 * follows a change of scroll-bar style by being the engine's, and this follows
 * it the next time the window is focused.  Writes only on a change.
 */
export function applyNavScrollbarW(root: ParentNode = document): void {
  const doc = ((root as Partial<Document>).documentElement ? root : document) as Document
  const html = doc.documentElement
  const write = (v: string): void => {
    if (html.style.getPropertyValue('--nav-scrollbar-w') !== v) html.style.setProperty('--nav-scrollbar-w', v)
  }
  if (html.getAttribute('data-os') === 'linux') {
    write('12px')
    return
  }
  try {
    const probe = doc.createElement('div')
    probe.style.cssText =
      'position:absolute;visibility:hidden;left:0;top:0;width:100px;height:50px;' +
      'overflow-y:scroll;scrollbar-color:gray transparent'
    const kid = doc.createElement('div')
    kid.style.height = '200px'
    probe.appendChild(kid)
    doc.body.appendChild(probe)
    const w = probe.offsetWidth - probe.clientWidth
    probe.remove()
    if (Number.isFinite(w) && w >= 0) write(w + 'px')
  } catch {
    // A test double with no layout: tokens.css's measured 15px stands.
  }
}

/**
 * Apply a width by overwriting `--sidebar-w` on `<html>` as an INLINE style.
 *
 * tokens.css keeps the declaration and stays the only file that DECLARES a
 * custom property (§5.1); this writes an element style, which is a different
 * thing and is what the cascade is for. Exactly two rules consume the token —
 * `.titlebar-left` and `.sidebar` — and `.tab-strip` and `.editor` are both
 * `flex: 1 1 auto`, so this single write moves the whole layout.
 */
export function setSidebarW(w: number, root: ParentNode = document): void {
  const html = (root as Partial<Document>).documentElement ?? document.documentElement
  html.style.setProperty('--sidebar-w', w + 'px')
}

/**
 * §0.7 E9.  Restore the persisted sidebar width, BEFORE the first frame.
 *
 * The window is `visible: false` until the frontend reports `frontend-ready`
 * (§6.1), and this runs inside `mountChrome()` well before that, so a restored
 * width never appears as a jump — the first frame the user sees is already at
 * the width they left it.
 *
 * CLAMPED AGAINST THE LIVE WINDOW, not trusted. A width saved on a 3440px
 * monitor would leave no editor at all on a 900px one, and `state.json` is a
 * plain file a person can edit. Rust rejects nonsense (`sane_sidebar_w`); this
 * enforces the layout policy, because only the page knows how wide the window
 * actually is right now.
 */
function applySidebarW(root: ParentNode): void {
  const saved = window.__CAIRN_SIDEBAR_W__
  if (typeof saved !== 'number') return
  // `window.innerWidth` IS NOT KNOWN YET AND MUST NOT BE TRUSTED HERE.  This
  // runs at DOMContentLoaded, and §6.1 creates the window `visible: false`, so
  // innerWidth is 0 until it is mapped — MEASURED: a persisted 300 came back as
  // 180, which is `SIDEBAR_MIN`, because `max(SIDEBAR_MIN, 0 - EDITOR_MIN)` is
  // the floor.  Every restored width would have collapsed to the minimum.
  //
  // So apply the value Rust already sanity-bounded, unclamped, and let
  // `reclampSidebar` in wireChrome enforce the layout policy on the first frame
  // — by which time the window has a real width.
  setSidebarW(usableWidth() > 0 ? clampSidebarW(saved, usableWidth()) : saved, root)
}

/** `innerWidth`, or 0 while the window is still unmapped.  One place, because
 *  "is the window laid out yet" is a question two callers ask and neither
 *  should answer differently. */
function usableWidth(): number {
  const w = typeof window === 'undefined' ? 0 : window.innerWidth
  return Number.isFinite(w) && w >= SIDEBAR_MIN + EDITOR_MIN ? w : 0
}

/* ── §3.3 the truncation banners ───────────────────────────────────────────── */

/** §3.3, VERBATIM.  No icon and no dismiss control: dismissing a truth that is
 *  still true is a lie. */
export const CAP_BANNER_NODES = 'This vault is very large; only the first 50,000 items are shown.'
export const CAP_BANNER_DEPTH = 'Some folders are nested too deeply to display.'

/** The banner copy for a `(truncated, truncatedDepth)` pair, in the order §3.3
 *  stacks them.  Pure, so the stacking rule is testable without a DOM. */
export function capBannerText(nodes: boolean, depth: boolean): string[] {
  const out: string[] = []
  if (nodes) out.push(CAP_BANNER_NODES)
  if (depth) out.push(CAP_BANNER_DEPTH)
  return out
}

/** The live sidebar scroller — `.tree-scroller` or, under §4.5's search view,
 *  `.search-scroller`.  Banners are siblings of whichever is live and stay
 *  visible in BOTH views (errata 2): hiding the warning on the view where the
 *  user is hunting for a missing note is the worst possible moment to hide it. */
function liveScroller(root: ParentNode): Element | null {
  return root.querySelector('.tree-scroller, .search-scroller')
}

/**
 * §3.3.  Insert or remove `.cap-banner` elements as SIBLINGS of the live
 * scroller inside `.sidebar`, NEVER as children of it — so a banner does not
 * scroll away and does not enter the tree's coordinate system.
 *
 * Driven by `VaultInfo.truncated` (the 50,000-node cap, flags bit 0) and
 * `VaultInfo.truncatedDepth` (the 255-depth cap, bit 1).  Both may be present
 * at once, stacked in that order, for a maximum of 48px.
 *
 * THE CONSEQUENCE LANDS ON OWNER 04, and it is where the bug would be: a banner
 * appearing shortens the scroller from 875 to 851 to 827, and the row pool is
 * sized from the scroller's LIVE clientHeight — never from a constant, and
 * with `ceil(clientHeight / --row-h) + 2*OVERSCAN + 1`, OVERSCAN = 8 (errata 2;
 * X9's `+ 2` form is STRUCK).  A banner appearing is an ORDINARY RESIZE and is
 * handled by the same path as a window resize, so this function dispatches a
 * `resize` event after mutating the DOM rather than expecting anyone to poll.
 *
 * §5.12.4.3: each banner stays SINGLE-LINE with `text-overflow: ellipsis`.  A
 * banner that wrapped into a scrollable box would be the document's third
 * scroller, ~23.5 MB at 2x, and would fail both `layers.scrollers` and G5d.
 */
export function setCapBanners(nodes: boolean, depth: boolean, root: ParentNode = document): void {
  const sidebar = root.querySelector<HTMLElement>('.sidebar')
  const scroller = liveScroller(root)
  if (!sidebar || !scroller) return

  const wanted = capBannerText(nodes, depth)
  const have = Array.from(sidebar.querySelectorAll<HTMLElement>('.cap-banner'))
  let changed = false

  // Reconcile in place: the same two strings in the same order, so a depth
  // banner appearing under a node banner never re-creates the node banner.
  for (let i = 0; i < wanted.length; i++) {
    const text = wanted[i] as string
    const existing = have[i]
    if (existing) {
      if (existing.textContent !== text) { existing.textContent = text; changed = true }
    } else {
      const el = document.createElement('div')
      el.className = 'cap-banner'
      el.setAttribute('role', 'status')
      el.title = text                       // the full line, when 412px ellipsises it
      el.textContent = text
      sidebar.insertBefore(el, scroller)
      changed = true
    }
  }
  for (let i = wanted.length; i < have.length; i++) {
    have[i]?.remove()
    changed = true
  }

  // The scroller just changed height.  Owner 04 re-sizes the row pool from the
  // live clientHeight on `resize`; §3.3 is explicit that a banner appearing is
  // an ordinary resize and must not need a second code path.
  if (changed) window.dispatchEvent(new Event('resize'))
}

/* ── §7.3 case 8 — the vault root is gone ──────────────────────────────────── */

export const VAULT_LOST_TEXT = 'This vault is no longer available.'

/**
 * `nc://vault-lost { path }` (§1.4, consumer: chrome).  Before M57 this event
 * had NO CONSUMER IN ANY FRONTEND SPEC.
 *
 * §7.3 case 8's invariant: the app never autosaves into a path whose root is
 * gone, and never draws a vault that no longer exists.  The frontend MUST stop
 * autosave, mark the buffer read-only with a banner, freeze the tree, and offer
 * `[ Re-open ] [ Switch vault… ]`.  This function draws the affordance and the
 * banner; stopping autosave, the read-only buffer and freezing the tree belong
 * to owners 03 and 04 and are `deps.onVaultLost()`'s to perform — wired in
 * `wireChrome`, because a chrome module must not reach into either subtree.
 *
 * Geometry: §7.3 case 8 specifies NONE.  `[C]` — a 48px two-line bar in the same
 * slot as the §3.3 banners, above them, `overflow: hidden` and no scroller.  The
 * geometry fixture never trips it (the gate vault is present), so no probe row
 * moves and G9 is unaffected.
 */
export function setVaultLost(path: string | null, root: ParentNode = document): void {
  const sidebar = root.querySelector<HTMLElement>('.sidebar')
  const scroller = liveScroller(root)
  if (!sidebar) return
  const existing = sidebar.querySelector<HTMLElement>('.vault-lost')
  if (path === null) {
    if (existing) { existing.remove(); window.dispatchEvent(new Event('resize')) }
    return
  }
  if (existing) { existing.title = path; return }

  const bar = document.createElement('div')
  bar.className = 'vault-lost'
  bar.setAttribute('role', 'alert')
  bar.title = path

  const line = document.createElement('div')
  line.className = 'vault-lost-line clipline'
  line.textContent = VAULT_LOST_TEXT
  bar.appendChild(line)

  const row = document.createElement('div')
  row.className = 'vault-lost-actions'
  row.appendChild(makeButton('Re-open', 'vault-lost-reopen'))
  row.appendChild(makeButton('Switch vault…', 'vault-lost-switch'))
  bar.appendChild(row)

  // THE RANK IS `gone > stale > truncated` (§0.12 E14).  Anchoring on the FIRST
  // of the two lower ranks — not on `.cap-banner` alone — is what keeps this bar
  // on top when a degraded watcher is already showing and no cap banner is:
  // `?? scroller` would otherwise land it BELOW the watcher bar.
  sidebar.insertBefore(bar, sidebar.querySelector('.watch-degraded, .cap-banner') ?? scroller)
  window.dispatchEvent(new Event('resize'))
}

function makeButton(label: string, cls: string): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'chrome-btn ' + cls
  b.textContent = label
  return b
}

/* ── §7.3 case 16 — the watcher is degraded ────────────────────────────────── */

/** The one line the banner shows, per §1.4's two wire reasons.  Exported so the
 *  test asserts the SHIPPED copy rather than a second transcription of it. */
export const WATCH_DEGRADED_LIMIT = 'File-watching hit the system limit.'
export const WATCH_DEGRADED_ERROR = 'File-watching stopped.'

/** Pure, so the reason→copy mapping is testable without a DOM. An unknown
 *  reason falls to the general line rather than throwing: §1.4 pins the union at
 *  two values, and a third arriving from a future Rust must not blank the bar. */
export function watchDegradedText(reason: string): string {
  return reason === 'watch-limit' ? WATCH_DEGRADED_LIMIT : WATCH_DEGRADED_ERROR
}

/**
 * `nc://watch-degraded { reason, hint }` (§1.4), closing M57 for the second
 * time.  UNTIL §0.12 E14 THIS LIT NAV SLOT 4 — it raised the Refresh button's
 * opacity and hung the whole explanation off that button's `title`.  E14 deleted
 * the toolbar, and a rehoming was mandatory rather than optional: the old
 * selector would simply have found nothing and both functions would have become
 * SILENT NO-OPS, with no error, no failing test, and the §7.3 case 16 invariant
 * — the user is never left believing the tree is live when it is not — quietly
 * unenforced.  That is the exact failure this comment exists to prevent.
 *
 * So the signal is now a BANNER of its own, in the §3.3 slot, following the
 * §7.3 case 8 vault-lost bar rule for rule: 48px border-box, two lines, its own
 * `[ Refresh ]` in `.chrome-btn`, `role="alert"`, `overflow: hidden` and never a
 * scroller (§5.12.4.3 — a third rendered scroller is ~23.5 MB at 2x and fails
 * both `layers.scrollers` and G5d).
 *
 * THE RANK IS `gone > stale > truncated`: below `.vault-lost` (when the root is
 * gone there is nothing to refresh and its own `[ Re-open ]` is the right
 * action) and above `.cap-banner` (this one carries a control and a cap banner
 * does not).  `setCapBanners` anchors on the scroller and so lands below this
 * for free; `setVaultLost` anchors on `.watch-degraded, .cap-banner` and so
 * lands above it for free.  Three functions, one order, no coordination.
 *
 * THE BUTTON IS LABELLED `Refresh` AND MUST STAY SO.  Both Rust hint strings —
 * `watcher.rs`'s `degrade_hint` and `app.rs`'s `emit_degraded`, which are
 * byte-identical copies — end "Use Refresh to pick up changes.", and that
 * sentence is shown to the user in this bar's tooltip.  Rename the button and
 * the copy becomes a lie about a control that no longer exists.
 *
 * UNLIKE THE OLD OPACITY TOGGLE, THIS CHANGES LAYOUT.  The bar is a flex child
 * of `.sidebar`, so the live scroller loses 48px and owner 04 re-sizes the row
 * pool from `clientHeight` on `resize` (§3.3).  Both the insert and the removal
 * dispatch one; the "already showing, only the text moved" branch does not.
 */
export function setWatchDegraded(reason: string, hint: string, root: ParentNode = document): void {
  const sidebar = root.querySelector<HTMLElement>('.sidebar')
  if (!sidebar) return

  const line = watchDegradedText(reason)
  // The hint is Rust's and is the actionable half; it goes in the tooltip
  // because it does not fit 412px, and the bar clips rather than wraps.
  const full = hint ? line + ' ' + hint : line

  const existing = sidebar.querySelector<HTMLElement>('.watch-degraded')
  if (existing) {
    // §1.4 says at most once per vault, but a re-open re-arms it; reconcile
    // rather than re-create, so a second event does not re-size the sidebar.
    existing.title = full
    const l = existing.querySelector('.watch-degraded-line')
    if (l && l.textContent !== line) l.textContent = line
    return
  }

  const bar = document.createElement('div')
  bar.className = 'watch-degraded'
  bar.setAttribute('role', 'alert')
  bar.title = full

  const l = document.createElement('div')
  l.className = 'watch-degraded-line clipline'
  l.textContent = line
  bar.appendChild(l)

  const row = document.createElement('div')
  row.className = 'watch-degraded-actions'
  row.appendChild(makeButton('Refresh', 'watch-degraded-refresh'))
  bar.appendChild(row)

  sidebar.insertBefore(bar, sidebar.querySelector('.cap-banner') ?? liveScroller(root))
  window.dispatchEvent(new Event('resize'))
}

/** Called from `applyVaultInfo` when `VaultInfo.watching` is true — i.e. after
 *  every successful `rescan_all`, which re-emits `nc://vault-opened`.  A rescan
 *  that failed to restart the watcher leaves the bar up, correctly. */
export function clearWatchDegraded(root: ParentNode = document): void {
  const sidebar = root.querySelector<HTMLElement>('.sidebar')
  if (!sidebar) return
  const existing = sidebar.querySelector<HTMLElement>('.watch-degraded')
  if (!existing) return
  existing.remove()
  window.dispatchEvent(new Event('resize'))
}

/* ── F66 — the note-state bar (§7.3 cases 5/7) ───────────────────────────────
 *
 * `keepMine`, `reloadFromDisk` and `saveAs` existed in owner 03's module with
 * NO caller: a conflicted, detached or vault-lost note could never be resolved
 * and the only exit was quitting over the discard modal. This is the caller.
 * The bar shows ONLY in those states, so nothing at rest moves (G9).
 *
 * Same box as `.vault-lost`, deliberately — one banner shape — but in
 * `main.editor` above `#ed`, because it names the NOTE, not the vault.
 * `vault-lost` keeps its sidebar bar; this bar covers `conflict` (Keep mine /
 * Reload from disk) and `detached` (Save as… / Discard). The clicks delegate
 * from `main.editor`, which outlives every bar, following the sidebar-banner
 * rule one section up. */

export type NoteBarState = 'conflict' | 'detached'

export const NOTE_BAR_TEXT: Record<NoteBarState, { line: string; buttons: Array<[string, string]> }> = {
  conflict: {
    line: 'This note changed on disk.',
    buttons: [['Keep mine', 'note-keep'], ['Reload from disk', 'note-reload']],
  },
  detached: {
    line: 'This note was renamed or removed outside the app.',
    buttons: [['Save as…', 'note-saveas'], ['Discard', 'note-discard']],
  },
}

export function setNoteBar(state: NoteBarState | null, root: ParentNode = document): void {
  const host = root.querySelector<HTMLElement>('main.editor')
  const ed = root.querySelector<HTMLElement>('#ed')
  if (!host || !ed) return
  const existing = host.querySelector<HTMLElement>('.note-bar')
  if (state === null) {
    if (existing) existing.remove()
    return
  }
  const copy = NOTE_BAR_TEXT[state]
  if (existing) {
    if (existing.dataset.state !== state) {
      existing.remove()
    } else {
      const l = existing.querySelector('.note-bar-line')
      if (l && l.textContent !== copy.line) l.textContent = copy.line
      return
    }
  }
  const bar = document.createElement('div')
  bar.className = 'note-bar note-bar-' + state
  bar.dataset.state = state
  bar.setAttribute('role', 'alert')
  const line = document.createElement('div')
  line.className = 'note-bar-line clipline'
  line.textContent = copy.line
  bar.appendChild(line)
  const row = document.createElement('div')
  row.className = 'note-bar-actions'
  for (const [label, cls] of copy.buttons) row.appendChild(makeButton(label, cls))
  bar.appendChild(row)
  host.insertBefore(bar, ed)
}

/* ── §7.5 first run — DELETED, §0.44 E89 ───────────────────────────────────── */

/* `setFirstRun(show)` stood here and is GONE with the `.first-run` panel it
 * toggled.  User ruling: *"Remove this text and this feature.  We already have
 * the vault picker at the bottom left corner."*  §7.5's normative sentence is
 * STRUCK; `index.html` carries the full argument at the element's grave.
 *
 * Nothing replaces it in this module.  `{state:'none'}` is still a distinct
 * state and `main.ts` still branches on it — it now points the vault bar at
 * `null`, which is the branch `VaultBar.setVault` was always documented to
 * take ("or `null` for §7.5's first-run state where no vault is configured").
 * `deps.pickVault` below keeps its other caller, §7.3 case 8's
 * `[ Switch vault… ]`. */

/* ── wiring ────────────────────────────────────────────────────────────────── */

export interface ChromeDeps {
  /** Mod-N.  The row menus reach the same flow through their own owners. */
  newNote(): void
  /** §1.3 command 5, from the watcher-degraded banner's `[ Refresh ]` — its ONE
   *  caller, and the bar is drawn from `VaultInfo.watching` as well as from
   *  `nc://watch-degraded`, so a startup event this page was too late to hear
   *  does not cost the control (§7.3 case 16).
   *
   *  IT IS NO LONGER §7.3 CASE 9's ESCAPE HATCH, and §0.12.2 records that as an
   *  accepted trade rather than an oversight: a network vault's watcher STARTS
   *  (`watching: true`) and merely never fires, so no bar is drawn and nothing
   *  calls this.  Such a vault picks up external changes on its next open. */
  rescanAll(): Promise<void>
  /** Mod-Shift-F.  §0.6 E8 deleted the title-bar button, so this is the ONLY
   *  route in — and `toggle()` is deliberately not `reveal()`: Escape does not
   *  close the panel, so a reveal-only binding would strand the user in the
   *  search view with the file tree unreachable (§0.7 E9, search.ts). */
  toggleSearch(): void
  /** Mod-F.  In-note find (src/find.ts, KNOWN-ISSUES.md X-13): the overlay bar
   *  in the NOTE viewer.  Show-or-focus, never a close — a second Mod-F with
   *  the bar open hands the focus back to the field.  Never the Memoir page —
   *  that is a plain textarea outside the editor and `main.ts` refuses the
   *  toggle while it is visible. */
  toggleFind(): void
  /** Mod-Shift-O, and the vault bar's recents popover.  §0.6 E8 deleted the
   *  title-bar button that also called this. */
  switchVault(): void
  /** Mod-1 / Mod-2 (user ruling 2026-09-16): select the note tab / the fixed
   *  Memoir tab.  The shell owns the switch (flush-first via `switchTab`), so
   *  a refused write keeps the current tab; this module never touches tab
   *  state itself. */
  selectTab(which: TabId): void
  /** §0.7 E9.  The sidebar width, in px, ON RELEASE of the resize drag — never
   *  per frame.  main.ts hands it to state.ts's patch, which debounces and
   *  writes it through `save_ui_state`; nothing new is added to §1.3. */
  saveSidebarW(w: number): void
  /** The native folder dialog + §4.3 switch.  ONE caller since §0.44 E89 took
   *  §7.5's first-run button away: §7.3 case 8's `[ Switch vault… ]`, delegated
   *  from `.sidebar` below.  The vault bar's popover reaches the same flow
   *  through its own owner and does not come through here. */
  pickVault(): void
  /** §7.3 case 8's `[ Re-open ]`: `open_vault` on the same root again. */
  reopenVault(): void
  /** §7.2: Mod-s flushes and returns true to suppress the webview's own save
   *  dialog.  Rust does no autosave timing and holds no dirty buffer. */
  flushNow(reason: string): Promise<void>
  /** §7.3 case 8, the half that is not chrome's: stop autosave, mark the buffer
   *  read-only, freeze the tree.  Called once, when the event arrives. */
  onVaultLost(path: string): void
  /** F66 (§7.3 cases 5/7): the note bar's four buttons. `keepMine` and
   *  `reloadFromDisk` resolve the conflict; `saveAsPrompt` offers Save as…
   *  for a detached note; `discardNote` empties the pane. */
  keepMine(): Promise<void>
  reloadFromDisk(): Promise<void>
  saveAsPrompt(): void
  discardNote(): void
  onError(err: unknown, context: string): void
}

export interface ChromeHandle {
  /** `nc://vault-lost` (§1.4): draws the bar AND runs deps.onVaultLost. */
  vaultLost(path: string): void
  /** A successful `open_vault` clears it again. */
  vaultRestored(): void
  /** F66: `onNoteStateChanged`'s `conflict`/`detached` draw the note bar;
   *  every other state removes it. */
  noteState(s: NoteBarState | null): void
  destroy(): void
}

/**
 * Bind every control this module owns.  Kept SEPARATE from `mountChrome()` on
 * purpose: `mountChrome()` is DOM-only and is what main.ts calls today, before
 * ipc.ts (owner 02) exists; `wireChrome` needs the command surface and is
 * called once those wrappers land.  Nothing in the shell is drawn-but-dead in
 * the meantime — the buttons are real controls awaiting a real transport, which
 * is a different thing from §9 E4's inert decoration.
 */
export function wireChrome(deps: ChromeDeps, root: ParentNode = document): ChromeHandle {
  const offs: Array<() => void> = []

  function on(el: Element | null, type: string, fn: (ev: Event) => void): void {
    if (!el) return
    el.addEventListener(type, fn)
    offs.push(() => el.removeEventListener(type, fn))
  }
  function guard(p: Promise<unknown>, ctx: string): void {
    void p.catch((err: unknown) => deps.onError(err, ctx))
  }

  /* §5.9's five slots are GONE — §0.12 E14, a user decision, and the `nav()`
     lookup helper went with them.  Four of the five duplicated an affordance
     that already existed (Mod-N and the tab strip's `+` for New note; the row
     menus for New note and New folder; a sort order the user does not want to
     choose), and the fifth was only ever the right click in the one state that
     now draws its own control.  Collapse all had no duplicate and is REMOVED,
     not rehomed — recorded here because that is the one capability this change
     costs.  The remaining bindings are below and in `setWatchDegraded`. */

  /* §5.6's title-bar buttons are GONE — §0.6 E8, a user decision.  `search` and
     `folder-open` duplicated affordances that already exist: Mod-Shift-F below
     opens search, and the vault bar's `.vault-switch` opens the switcher.  The
     `title()` helper went with them; `.titlebar-left` now holds nothing but the
     spacer that reserves --sidebar-w.  §9 E4a had already omitted panel-left and
     §9 E4 the two far-right icons, so the strip's left half is now empty by
     three separate rulings rather than by accident.

     deps.toggleSearch and deps.switchVault are STILL WIRED, below and in
     vaultbar.ts — nothing was orphaned, which is the whole reason this was a
     safe deletion. */

  /* §0.5 E7's three Linux window controls.  Wired UNCONDITIONALLY, on every
     platform: on macOS the elements exist but are `display: none`, so the
     listeners are three dead handlers on three unreachable buttons, and that is
     cheaper than a platform branch here that a later reader has to keep in sync
     with the one in chrome.css.  Nothing is emitted until something is clicked.

     `close` is the ✕ and it goes through §1.6: Rust answers this event with
     `window.close()`, which raises `CloseRequested`, which arms the flush
     handshake.  It is NOT a quit shortcut and must never become one. */
  const controls = root.querySelector<HTMLElement>('.window-controls')
  on(root.querySelector('.win-minimize'), 'click', () => emitWindowControl('minimize'))
  on(root.querySelector('.win-maximize'), 'click', () => emitWindowControl('toggle-maximize'))
  on(root.querySelector('.win-close'), 'click', () => emitWindowControl('close'))

  /* The middle control's glyph follows the window, not the click: a maximize
     that the WM refused, a keyboard-driven un-maximize and a double-click on
     the drag region (which invokes `internal_toggle_maximize` inside drag.js,
     where nothing here can see it) all have to land on the same icon.  So the
     state is Rust's and arrives as `nc://window-state`.

     Repainting through `paintIcons` rather than assigning `innerHTML` here is
     §6.1: icons.ts is the only file in the app that may write markup. */
  const maxBtn = root.querySelector<HTMLElement>('.win-maximize')
  if (controls && maxBtn) {
    guard(
      onWindowState((p) => {
        maxBtn.dataset['icon'] = p.maximized ? 'win-restore' : 'win-maximize'
        maxBtn.setAttribute('aria-label', p.maximized ? 'Restore' : 'Maximize')
        maxBtn.setAttribute('title', p.maximized ? 'Restore' : 'Maximize')
        paintIcons(controls)
      }).then((off) => { offs.push(off) }),
      'window-state'
    )
  }

  /* §0.7 E9 — THE SIDEBAR RESIZE.  Pointer events, not mouse: one code path
     covers mouse, pen and touch, and `setPointerCapture` is what keeps the drag
     alive when the pointer outruns the 3px handle, which at speed it always
     does.  Without capture the drag dies the first time you move faster than
     the layout can follow.

     THE WIDTH IS THE POINTER'S x, NOT A DELTA.  A delta accumulates rounding
     and drifts away from the cursor over a long drag; `clientX` is absolute and
     the handle stays under the finger for as long as the clamp allows.

     Persisted ONLY on release, through the EXISTING `save_ui_state` (command
     17), so this adds no command — §1.3 is at twenty-one since §0.30 E70 — and a drag writes one patch rather than
     one per frame — the 1,000 ms debounce in state.ts would coalesce them
     anyway, but not emitting them is cheaper than coalescing them. */
  const grip = root.querySelector<HTMLElement>('.sidebar-resize')
  if (grip) {
    let dragging = false

    const bodyEl = (): Element | null => root.querySelector('body') ?? document.body

    function onMove(ev: Event): void {
      if (!dragging) return
      const e = ev as PointerEvent
      setSidebarW(clampSidebarW(e.clientX, window.innerWidth), root)
    }

    function onUp(ev: Event): void {
      if (!dragging) return
      dragging = false
      const e = ev as PointerEvent
      grip?.classList.remove('is-active')
      bodyEl()?.classList.remove('is-grabbing')
      try { grip?.releasePointerCapture(e.pointerId) } catch { /* already gone */ }
      const w = clampSidebarW(e.clientX, window.innerWidth)
      setSidebarW(w, root)
      // The panes changed width.  §3.3's banner reconciler already uses this
      // idiom for the same reason: a resize is a resize whoever caused it, and
      // owner 04's row pool and CodeMirror both listen for it.  Fired ONCE, on
      // release — not per frame, which would rebuild the pool sixty times a
      // second for a measurement that only matters when the drag stops.
      window.dispatchEvent(new Event('resize'))
      deps.saveSidebarW(w)
    }

    on(grip, 'pointerdown', (ev) => {
      const e = ev as PointerEvent
      if (e.button !== 0) return
      e.preventDefault()          // no text selection, no drag-image
      dragging = true
      grip.classList.add('is-active')
      bodyEl()?.classList.add('is-grabbing')
      try { grip.setPointerCapture(e.pointerId) } catch { /* not captured; move still works */ }
    })
    on(grip, 'pointermove', onMove)
    on(grip, 'pointerup', onUp)
    on(grip, 'pointercancel', onUp)
  }

  /* §0.7 E9.  Re-clamp when the WINDOW changes size, and once on the first
     frame.  Two jobs in one handler:
       - the first frame is when a width restored at boot finally meets a real
         `innerWidth` (see applySidebarW: it cannot clamp before the window is
         mapped);
       - and narrowing the window must take the space from the sidebar, or a
         620px sidebar in a 900px window leaves 280 for the editor.
     It does NOT persist: the user did not choose this width, the window did,
     and writing it back would let a temporary narrow window eat the width they
     actually dragged to. */
  function reclampSidebar(): void {
    const w = usableWidth()
    if (w === 0) return
    const html = (root as Partial<Document>).documentElement ?? document.documentElement
    const cur = Number.parseFloat(html.style.getPropertyValue('--sidebar-w'))
    const next = clampSidebarW(Number.isFinite(cur) ? cur : SIDEBAR_W_DEFAULT, w)
    if (next !== cur) setSidebarW(next, root)
  }
  window.addEventListener('resize', reclampSidebar)
  offs.push(() => window.removeEventListener('resize', reclampSidebar))
  /* §0.48 E96 — a window dragged to a display with a different scale fires
     `resize`, and the guide stripe has to be re-snapped for the new dpr. */
  const reGuide = (): void => applyGuideWidth(root)
  window.addEventListener('resize', reGuide)
  offs.push(() => window.removeEventListener('resize', reGuide))
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(reclampSidebar)

  /* THE BANNER BUTTONS — §7.3 case 8's two and §7.3 case 16's one.  ALL
     delegated from `.sidebar`, because no banner exists until its event
     arrives, and one listener rather than three keeps the teardown honest: a
     bar that is created and destroyed repeatedly would otherwise leak a
     listener per creation. */
  const sidebar = root.querySelector<HTMLElement>('.sidebar')
  on(sidebar, 'click', (ev) => {
    const t = ev.target
    if (!(t instanceof Element)) return
    if (t.closest('.vault-lost-reopen')) deps.reopenVault()
    else if (t.closest('.vault-lost-switch')) deps.pickVault()
    // §0.12 E14: the sole surviving route to `rescan_all()`.  The bar clears
    // itself when the rescan succeeds — `applyVaultInfo` calls
    // `clearWatchDegraded()` on the re-emitted `nc://vault-opened` — so there is
    // no second success path here to keep in sync.
    else if (t.closest('.watch-degraded-refresh')) guard(deps.rescanAll(), 'rescan')
  })

  /* F66's four buttons, delegated from `main.editor` like the banner buttons
     above delegate from `.sidebar`: the bar is created and destroyed with the
     state, and one listener on the stable host keeps the teardown honest. */
  on(root.querySelector('main.editor'), 'click', (ev) => {
    const t = ev.target
    if (!(t instanceof Element)) return
    if (t.closest('.note-keep')) guard(deps.keepMine(), 'keep-mine')
    else if (t.closest('.note-reload')) guard(deps.reloadFromDisk(), 'reload-note')
    else if (t.closest('.note-saveas')) deps.saveAsPrompt()
    else if (t.closest('.note-discard')) deps.discardNote()
  })

  /* The seven keyboard shortcuts (Obsidian-compatible).  Deliberately short: an
     app with no settings UI cannot let the user fix a collision, so every extra
     binding is a permanent one. */
  function onKeyDown(ev: Event): void {
    const e = ev as KeyboardEvent
    // Somebody nearer the event already owns this keystroke.  The case that
    // matters is Mod-s: §7.2 describes it as a CM6 keymap entry that "flushes
    // and returns true", and a CM6 keymap calls preventDefault() without
    // stopping propagation — so without this line a save inside the editor would
    // run the flush TWICE, once from CodeMirror and once from here.  Checking
    // defaultPrevented instead of sniffing the target keeps the rule general and
    // keeps it correct whichever module ends up owning a given binding.
    if (e.defaultPrevented) return
    // F56: shortcuts stay dead under a modal. Vault switching under a delete
    // confirm re-resolves the pending relative path in the NEW vault.
    if (modalIsOpen()) return
    if (!isMod(e) || e.altKey) return
    const k = e.key.toLowerCase()
    if (e.shiftKey) {
      if (k === 'f') { e.preventDefault(); deps.toggleSearch() }             // ⌘⇧F  search
      else if (k === 'o') { e.preventDefault(); deps.switchVault() }         // ⌘⇧O  switch vault
      return
    }
    if (k === 'n') {                                                          // ⌘N   new note
      if (e.repeat) { e.preventDefault(); return }
      e.preventDefault()
      deps.newNote()
    } else if (k === 'f') {                                                   // ⌘F   find in note
      // Mod-F is the browser's own find binding, so preventDefault is what
      // keeps the engine's find bar from opening over the note.  Mod-Shift-F
      // above stays the vault-wide panel; the two never collide (shift splits
      // them before this branch is reached).
      e.preventDefault()
      deps.toggleFind()
    } else if (k === '1') {                                                   // ⌘1   note tab
      e.preventDefault()
      deps.selectTab('note')
    } else if (k === '2') {                                                   // ⌘2   Memoir tab
      e.preventDefault()
      deps.selectTab('memoir')
    } else if (k === 's') {                                                   // ⌘S   save
      // §7.2: Mod-s flushes AND suppresses the webview's own save dialog.
      // preventDefault is the load-bearing half — without it WebKit opens a
      // native save panel over a note that is already being written.
      e.preventDefault()
      guard(deps.flushNow('shortcut'), 'flush')
    }
  }
  document.addEventListener('keydown', onKeyDown)
  offs.push(() => document.removeEventListener('keydown', onKeyDown))

  return {
    vaultLost(path: string): void {
      setVaultLost(path, root)
      deps.onVaultLost(path)
    },
    vaultRestored(): void {
      setVaultLost(null, root)
    },
    noteState(s: NoteBarState | null): void {
      setNoteBar(s, root)
    },
    destroy(): void {
      for (const off of offs) off()
      offs.length = 0
    },
  }
}

/** macOS is the only v1 platform (§9 E2), so `Mod` is ⌘.  The `data-os` read is
 *  the one-line portability seam §5.8 keeps honest without shipping Linux. */
function isMod(e: KeyboardEvent): boolean {
  const os = document.documentElement.getAttribute('data-os')
  return os === 'macos' ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
}

/* ── §5.11 the --pixeltest probe ───────────────────────────────────────────── */

/**
 * CONTRACT §5.11, step "run it" — owner 01's single obligation in the
 * `--pixeltest` chain.
 *
 * On the first animation frame after `nc://vault-opened`, if the probe was
 * injected, run it in gate mode and emit the report.  main.rs (07) listens,
 * prints one JSON line to stdout and exits 0 iff `ok`; that exit code IS gate
 * G9, and no other process needs to understand the event.
 *
 * A SKIP fails the run by default: a green run that measured nothing is worse
 * than a red one.  (§6.5 G9: the earlier `report.skips === 0` clause is STRUCK —
 * the field is `skip`, and `undefined === 0` would have failed every run.)
 */
export function runGeometryProbe(): void {
  if (!window.__PIXELTEST__) return
  requestAnimationFrame(() => {
    const probe = window.__verifyGeometry
    if (!probe) {
      // The flag is set but the script is missing — that is a harness fault, and
      // reporting nothing would let a broken gate read as a passing one.
      emitGeometryReport({ ok: false, rows: 0, checks: 0, pass: 0, fail: 1, skip: 0,
                           error: '__verifyGeometry missing under --pixeltest' })
      return
    }
    // Gate mode is the contract path and the default.  `__PIXELTEST_GATE__` is
    // set false only by the geometry harness's window-size override, where a
    // gate-mode run would report failures against a geometry it was never run
    // at.  Gate G9 is only ever read from a plain `--pixeltest` run, which
    // always gates (§5.11.1).
    const gate = window.__PIXELTEST_GATE__ !== false
    emitGeometryReport(probe({ gate }))
  })
}
