/**
 * src/modal.ts
 * Owner: 01.  NEW in errata 3 (CONTRACT.md §0.1 Z4, §1.6.1, §6.4's file table).
 *
 * THE ONLY MODAL IN THE APP.  It has exactly five call sites, all of them
 * standing between a user and something destructive:
 *
 *   §1.6   the flush-on-quit handshake's "This note could not be saved."
 *   §7.3 case 3   the dirty-delete prompt (Cancel / Save and delete /
 *                 Delete without saving), which is where the LIVE DATA-LOSS
 *                 BUG (docs/DATA-LOSS-VERIFICATION.md finding F1) was: the
 *                 dialog that shipped never consulted `isDirty()` at all.
 *   §7.3 case 5/6   the delete confirm, transcribed from Obsidian 1.13.7
 *                 (2026-09-14): "Delete file", two paragraphs, Cancel +
 *                 solid-red Delete, X button, no checkbox.
 *   §7.3 case 3/5/6 the delete-failure report ("Could not delete …").
 *   secrets   the secret entry's delete confirm (user request, 2026-09-16):
 *                 "Delete secret" in the case-5/6 shape, but with NO `focusId`
 *                 — entries have no Trash, so Return lands on Cancel.
 *
 * WHY THIS FILE EXISTS.  §6.4 gave the modal no owner, so the integrator grew
 * one inside `main.ts` — whose file-table line is "entry: boot sequence, wires
 * modules, OWNS NOTHING ELSE".  Z4 moved it here and moved `ModalSpec` out of
 * `tabstrip.ts`, so "there is exactly one modal" is now a FILE-OWNERSHIP rule
 * rather than a style opinion: a second implementation cannot appear without
 * appearing in somebody's diff as a new file.
 *
 * WHY IT IS PROMISE-SHAPED.  The two-button, two-callback `ModalSpec` that
 * `tabstrip.ts` declared cannot express §7.3 case 3's THREE-way question
 * (Cancel / Save and delete / Delete without saving), and a third callback
 * would have left the "which one did the user pick" answer split across three
 * closures at every call site.  `openModal()` returns the picked button's `id`.
 *
 * WHAT IT IS BUILT FROM, and why that is not an aesthetic choice:
 *   - `createElement` / `textContent` with inline `style` attributes.  NEVER
 *     `innerHTML` (§6.1): `detail` carries user-controlled note names, and a
 *     note called `<img src=x onerror=…>.md` is a legal filename on APFS
 *     (measured — docs/DATA-LOSS-VERIFICATION.md M-c).
 *   - NO stylesheet.  §6.3's CSS gate is 20,000 bytes and this dialog spends
 *     none of it.  Sizes and colours are `tokens.css` custom properties
 *     (§5.1 is the only declaration site), so the dialog cannot drift from the
 *     rest of the chrome — EXCEPT a handful of [S] literals transcribed from
 *     Obsidian's own sheet that have no Cairn token (the 1.3 line-heights, the
 *     paragraphs' 15px margins, the 30px button height, the X offsets, white
 *     ink on solid red).  Each is cited where it stands.
 *   - NO `overflow` on any element (§5.12.4.3, §5.11's `layers.scrollers`
 *     row).  `position: fixed` with no overflow declares no scrollable box, so
 *     this dialog can never become the THIRD RENDERED SCROLLER, which is a
 *     ~23.5 MB regression at 2x and fails G5d as well as the geometry gate.
 *     That is why the box has a `max-width` and NO `max-height`: the detail
 *     text wraps, it never scrolls.
 *   - NO `overflow` on any element (§5.12.4.3, §5.11's `layers.scrollers`
 *     row).  `position: fixed` with no overflow declares no scrollable box, so
 *     this dialog can never become the THIRD RENDERED SCROLLER, which is a
 *     ~23.5 MB regression at 2x and fails G5d as well as the geometry gate.
 *     That is why the box has a `max-width` and NO `max-height`: the detail
 *     text wraps, it never scrolls.
 */

/* ═══════════════════════════════════════════════════════════════════════════
 * The interface — §1.6.1's, PLUS the three fields the Obsidian transcription
 * needed (2026-09-14): `details` (the delete confirm has TWO paragraphs),
 * `warnings` (its amber rows), `cta` (its SOLID red Delete), and `focusId`
 * (Obsidian focuses the ACCEPT button — measured — where §1.6.1 behaviour 1
 * says the default takes focus).
 *
 * THE FOCUS FORK, stated plainly because it is a safety ruling, not a style:
 * behaviour 1 exists so Return-on-open can never destroy anything, and the
 * delete confirm is the one dialog that focuses destruction.  What Obsidian
 * does is measured (Delete focused, zero-width outline either way — no focus
 * ring renders in either app), what the user asked for is pixel identity, and
 * what is KEPT is every guard around it: `defaultId` stays the safe button
 * (Escape, the N1 source scan, the no-stack refusal answer), the Trash is
 * recoverable, and each file of a multi-delete is confirmed on its own.  A
 * caller that passes no `focusId` gets behaviour 1 verbatim.
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface ModalButton {
  /** Returned by openModal(). Stable, not the label. */
  id: string
  label: string
  /** Renders in --text-error. Never the default. */
  destructive?: boolean
  /** WITH `destructive`: the SOLID red fill (Obsidian `mod-cta`); on its own
   *  it is not used by any caller today.  The dirty-delete guard's destructive
   *  row passes no `cta` and keeps the tinted look. */
  cta?: boolean
}

export interface ModalSpec {
  title: string
  /** One paragraph, or several (the delete confirm's two).  The FIRST gets
   *  `overflow-wrap: break-word` (Obsidian `u-break-word`) so a long name
   *  wraps instead of widening the box. */
  detail: string | string[]
  /** Amber `mod-warning` paragraphs after the detail (a non-empty folder's
   *  two).  Colour only — same size, same margins. */
  warnings?: string[]
  /** Rendered left to right, in array order. 2 or 3 entries; §1.6 uses 2, §7.3 case 3 uses 3. */
  buttons: ModalButton[]
  /** MUST match one button's `id`.  What Escape picks, and what the N1 source
   *  scan requires to mean "change nothing". */
  defaultId: string
  /** Focused on open.  Defaults to `defaultId` (behaviour 1); the delete
   *  confirm passes its accept button, as measured. */
  focusId?: string
}

/* ═══════════════════════════════════════════════════════════════════════════
 * §1.6.1 behaviour 5 — ONE MODAL AT A TIME.
 *
 * Two stacked data-loss prompts is a bug, never a state to render: the second
 * one covers the first, the user answers the one they can see, and the answer
 * lands on the wrong question.  A call made while one is open is therefore a
 * PROGRAMMING ERROR — refused, logged, and resolved with the REFUSED spec's
 * OWN `defaultId`, which is always that caller's safe answer (F52: answering
 * a quit prompt with the open delete dialog's `cancel` quit the app over
 * unsaved edits, and an unknown id read as `delete` trashed a note). A
 * refusal can never destroy anything.
 * ═══════════════════════════════════════════════════════════════════════════ */
let openSpec: ModalSpec | null = null

/** True while a dialog is on screen.  The app reads it in two places: the
 *  quit handshake skips pulling focus while another dialog owns it, and the
 *  chrome shortcuts stay dead under a modal (F56). */
export function modalIsOpen(): boolean {
  return openSpec !== null
}

/* ═══════════════════════════════════════════════════════════════════════════
 * THE TOKENS — AND A CONTRACT/MEASUREMENT CONFLICT, REPORTED RATHER THAN
 * QUIETLY WORKED AROUND (CLAUDE.md §1: a measurement beats the contract).
 *
 * §1.6.1 states that owner 01 "owns `tokens.css`, which declares every custom
 * property this dialog consumes (`--bg-secondary`, `--text-normal`,
 * `--border-normal`, `--interactive-accent`, `--bg-modifier-hover`,
 * `--fs-ui`)".  MEASURED against `src/styles/tokens.css` at this revision,
 * THREE OF THOSE SIX ARE NOT DECLARED ANYWHERE: there is no `--border-normal`,
 * no `--interactive-accent` and no `--fs-ui`.  The names that exist are
 * `--bg-modifier-border`, `--accent`, and the `--fs-ui-smaller` /
 * `--fs-ui-small` / `--fs-ui-medium` triple.
 *
 * It is not a naming quibble.  `var(--interactive-accent)` with no fallback
 * resolves to nothing, so the DEFAULT button — the safe one, the focused one,
 * the one Escape picks — rendered with NO FILL, leaving it visually
 * indistinguishable from the destructive button at exactly the moment the user
 * is being asked whether to destroy their unsaved work.  The dialog also lost
 * its 1px border outright.  This code came over verbatim from `main.ts`'s
 * `showModal`, so THE SHIPPING DIALOG HAS ALL THREE DEFECTS TODAY; it was
 * invisible because an undeclared custom property resolves to the empty string
 * rather than throwing.  Found by `tests/frontend/modal.test.mjs`'s [N8] row,
 * which is there to check every `var(--x)` in this file against `tokens.css`.
 *
 * RESOLUTION, and it is the only one this file may make on its own: consume
 * the tokens that EXIST.  `tokens.css` is the single declaration site (§5.1,
 * M32/M36) and its table is ruled property by property; inventing three
 * aliases to satisfy a prose list would put two names on one colour, which is
 * the drift §5.1 exists to prevent.  §1.6.1's parenthesis needs an erratum.
 *
 * Two more §5.1 rules the same inherited code was breaking, fixed here:
 * `--shadow-popover` is "the one permitted shadow" and this dialog had
 * invented a second, and the radii/spacing are now `--radius-*` / `--sp-*`
 * rather than the literals that were sitting on top of them.
 * ═══════════════════════════════════════════════════════════════════════════ */

const BACKDROP_STYLE =
  'position:fixed;inset:0;z-index:80;display:flex;align-items:center;' +
  // Obsidian's backdrop is `rgba(10,10,10,.4)` AT 85% element opacity, on a
  // SIBLING of the dialog box — measured live.  This box is nested INSIDE the
  // backdrop, so an opacity here would dim the dialog with it; the single
  // alpha below renders identically over the opaque page
  // (.85*(.4*10+.6*P)+.15*P = .34*10+.66*P, per channel).
  'justify-content:center;background:rgba(10,10,10,.34)'

// Obsidian's `.modal`, transcribed declaration by declaration (2026-09-14,
// obsidian-1.13.7.asar app.css + live measurement at dpr 1.25): 560 wide,
// `#1c1c1c`, 12px radius, 1px `#555` border, 16px padding, three-layer
// shadow.  `position: relative` is load-bearing, not cosmetic: it is the
// origin the X button positions against.
// NO max-height and NO overflow — see the header.
const BOX_STYLE =
  'position:relative;width:var(--dialog-width);max-width:80vw;min-height:100px;' +
  // Obsidian `.modal` is `display:flex;flex-direction:column` — and the
  // 11.25px title-to-body gap DEPENDS on it.  Without flex the header's
  // margin-bottom and the first paragraph's margin-top COLLAPSE to 15px
  // (block layout), which is exactly the "smaller gap than Obsidian" a user
  // report caught (2026-09-15): measured 15px effective against Obsidian's
  // 11.25 + 15 = 26.25.  Flex items never collapse, so the declared margins
  // are the rendered ones.
  'display:flex;flex-direction:column;' +
  'padding:var(--sp-6);border-radius:var(--radius-l);' +
  'background:var(--bg-primary);color:var(--text-normal);' +
  'border:1px solid var(--modal-border-color);font-size:var(--fs-ui-medium);' +
  'box-shadow:var(--shadow-l)'

// Obsidian `.modal-header`: `margin-bottom: 0.75em` in the box's 15px context
// (measured 11.25px used).
const HEADER_STYLE = 'margin-bottom:0.75em'
// Obsidian `.modal-title`: 20px/600, tight.  Left-aligned by construction:
// the header is full width and the text starts where it starts.
const TITLE_STYLE = 'font-size:var(--font-ui-large);font-weight:600;line-height:1.3;margin:0'
// Obsidian body copy: 15px `#dadada`, 1.3, and each paragraph carries 15px
// above and below (plain UA `p` margins — no collapsing games, because the
// box is a flex column and the content is an ordinary block inside it).
const DETAIL_STYLE =
  'color:var(--text-normal);font-size:var(--fs-ui-medium);line-height:1.3;margin:15px 0'
const DETAIL_FIRST_STYLE = DETAIL_STYLE + ';overflow-wrap:break-word'
// Obsidian `.mod-warning`: colour only.
const WARNING_STYLE = DETAIL_STYLE + ';color:var(--text-warning)'
// Obsidian `.modal-button-container`: right-aligned, 8px apart, 1.5em down.
const ROW_STYLE =
  'display:flex;gap:var(--sp-4);justify-content:flex-end;margin-top:1.5em'

// The X: Obsidian `.modal-header-button` — absolute, 6px down, 12px in from
// the right on this machine (`body.styled-scrollbars` rule; the base 6px is
// what a non-scrollbar body gets), 4px of padding around an 18px lucide-x in
// `#b3b3b3` (measured 26x26 box, 18x18 glyph).  Cairn's `x` glyph is
// registered at 16; the svg is resized to 18 here, which scales cleanly
// (viewBox) and is verified by pixel A/B, not by the registry.
const X_STYLE =
  'position:absolute;top:6px;right:12px;padding:4px;color:var(--text-muted);' +
  'cursor:pointer;display:flex'

// Obsidian base `button`: 13px/400, 30px tall, 4px/12px padding, 5px radius,
// NO border.
const BUTTON_BASE =
  'display:inline-flex;align-items:center;justify-content:center;' +
  'padding:var(--sp-2) var(--sp-5);height:30px;border:0;border-radius:var(--button-radius);' +
  'font-size:var(--fs-ui-small);font-weight:400;white-space:nowrap;cursor:pointer;'
// The safe button both call sites focus by default: Obsidian's plain button
// over `#333` (`--interactive-normal`, dark), normal ink.
const BUTTON_DEFAULT =
  'background:var(--bg-modifier-border);color:var(--text-normal)'
/** `destructive` without `cta` (the guard's "Delete without saving", the quit
 *  dialog's "Discard"): Obsidian's 10% error tint with error ink. */
const BUTTON_DESTRUCTIVE =
  'background:color-mix(in oklch, var(--text-error) 10%, transparent);color:var(--text-error)'
/** `destructive` WITH `cta` (the delete confirm's Delete): solid error fill,
 *  white ink.  Measured `#fb464c` — Cairn's `--text-error`, transcribed long
 *  before this dialog needed it. */
const BUTTON_DESTRUCTIVE_CTA = 'background:var(--text-error);color:white'

/**
 * Resolves with the picked button's `id`.  NEVER rejects — every caller is on a
 * data-loss path and a rejection there would have to be swallowed into some
 * default anyway, which is a decision this function is in a better position to
 * make than its callers.
 */
export function openModal(spec: ModalSpec): Promise<string> {
  if (openSpec !== null) {
    // §1.6.1 behaviour 5.  Answer with the REFUSED caller's own safe default,
    // not the open dialog's: the refused spec's `defaultId` is always its
    // caller's safe answer (F52 — answering a quit prompt with a delete
    // dialog's `cancel` quit the app over unsaved edits). Say so loudly; do
    // not stack.
    console.error(
      'cairn[modal]: refused a second modal while "' + openSpec.title + '" is open; ' +
        'answering "' + spec.title + '" with its own default ' +
        JSON.stringify(spec.defaultId)
    )
    return Promise.resolve(spec.defaultId)
  }
  if (spec.buttons.length < 2 || spec.buttons.length > 3) {
    // Stated rather than silently rendered: §1.6.1 says 2 or 3.  A one-button
    // dialog is an alert, which this app does not have, and a four-button one
    // is a menu.
    console.error('cairn[modal]: ' + spec.buttons.length + ' buttons; §1.6.1 allows 2 or 3')
  }

  openSpec = spec

  const doc = document
  // §1.6.1 behaviour 3: restore focus to whatever had it.  Captured BEFORE the
  // dialog is built, because appending it can move focus on some engines.
  const previous = doc.activeElement as { focus?: () => void } | null

  const back = doc.createElement('div')
  back.className = 'nc-modal-back'
  back.setAttribute('style', BACKDROP_STYLE)
  /* §1.6.1 behaviour 2: A CLICK ON THE BACKDROP DOES NOTHING.  There is no
   * listener here at all — not a listener that ignores the event, none — so a
   * stray click cannot answer a data-loss question by any route, including a
   * future refactor that "tidies" a no-op handler into a dismiss. */

  const box = doc.createElement('div')
  box.className = 'nc-modal'
  box.setAttribute('role', 'dialog')
  box.setAttribute('aria-modal', 'true')
  box.setAttribute('style', BOX_STYLE)

  // Obsidian `.modal-header-button.mod-raised.clickable-icon`: the X that
  // closes to the safe answer.  Built with createElementNS, not innerHTML —
  // tree.ts's chevron exists for the same reason (§6.1, and the minidom has no
  // innerHTML setter).  The glyph is the registry `x` resized to the measured
  // 18px; stroke scales with the viewBox.
  const xHost = doc.createElement('span')
  xHost.className = 'nc-modal-x'
  xHost.setAttribute('style', X_STYLE)
  xHost.setAttribute('aria-label', 'Close')
  const SVG_NS = 'http://www.w3.org/2000/svg'
  const xSvg = doc.createElementNS(SVG_NS, 'svg')
  xSvg.setAttribute('width', '18')
  xSvg.setAttribute('height', '18')
  xSvg.setAttribute('viewBox', '0 0 24 24')
  xSvg.setAttribute('fill', 'none')
  xSvg.setAttribute('stroke', 'currentColor')
  xSvg.setAttribute('stroke-width', '2')
  xSvg.setAttribute('stroke-linecap', 'round')
  xSvg.setAttribute('stroke-linejoin', 'round')
  xSvg.setAttribute('aria-hidden', 'true')
  for (const d of ['M18 6 6 18', 'm6 6 12 12']) {
    const p = doc.createElementNS(SVG_NS, 'path')
    p.setAttribute('d', d)
    xSvg.appendChild(p)
  }
  xHost.appendChild(xSvg)
  box.appendChild(xHost)

  const headerEl = doc.createElement('div')
  headerEl.className = 'nc-modal-header'
  headerEl.setAttribute('style', HEADER_STYLE)

  const titleEl = doc.createElement('div')
  titleEl.className = 'nc-modal-title'
  titleEl.textContent = spec.title
  titleEl.setAttribute('style', TITLE_STYLE)
  // The accessible name comes from the title element, not from a duplicated
  // aria-label that would drift from it.
  const titleId = 'nc-modal-title'
  titleEl.setAttribute('id', titleId)
  box.setAttribute('aria-labelledby', titleId)
  headerEl.appendChild(titleEl)
  box.appendChild(headerEl)

  const contentEl = doc.createElement('div')
  contentEl.className = 'nc-modal-detail'
  const details = Array.isArray(spec.detail) ? spec.detail : [spec.detail]
  details.forEach((text, i) => {
    const p = doc.createElement('p')
    p.textContent = text
    // textContent, never innerHTML (§6.1): detail carries note names, and a
    // note called `<img src=x onerror=…>.md` is legal on APFS (measured —
    // docs/DATA-LOSS-VERIFICATION.md M-c).
    p.setAttribute('style', i === 0 ? DETAIL_FIRST_STYLE : DETAIL_STYLE)
    contentEl.appendChild(p)
  })
  for (const text of spec.warnings ?? []) {
    const p = doc.createElement('p')
    p.textContent = text
    p.setAttribute('style', WARNING_STYLE)
    contentEl.appendChild(p)
  }
  box.appendChild(contentEl)

  const row = doc.createElement('div')
  row.setAttribute('style', ROW_STYLE)

  let settled = false
  let resolveWith: (id: string) => void = () => {}
  const result = new Promise<string>((res) => { resolveWith = res })

  function finish(id: string): void {
    if (settled) return
    settled = true
    openSpec = null
    doc.removeEventListener('keydown', onKey, true)
    back.remove()
    // §1.6.1 behaviour 3.
    previous?.focus?.()
    resolveWith(id)
  }

  // The X answers with the safe default — the same code path as Escape, so a
  // close can never land on an unwritten branch either.
  xHost.addEventListener('click', (ev: Event) => {
    ev.preventDefault()
    ev.stopPropagation()
    finish(spec.defaultId)
  })

  const buttons: HTMLButtonElement[] = []

  for (const b of spec.buttons) {
    const el = doc.createElement('button')
    el.type = 'button'
    el.textContent = b.label
    el.className = 'nc-modal-btn'
    el.setAttribute('data-id', b.id)
    const isDefault = b.id === spec.defaultId
    if (b.destructive === true && isDefault) {
      // §1.6.1: "Never the default."  Reported rather than rendered, because a
      // destructive default is what Escape would then pick.
      console.error('cairn[modal]: destructive button ' + JSON.stringify(b.id) + ' is the default')
    }
    // Obsidian's three looks: plain (Cancel), tinted destructive (a guard's
    // "Delete without saving"), SOLID destructive+cta (this dialog's Delete).
    // §1.6.1's "never filled like the default" now reads against the SOLID
    // one: no caller may pass `cta` without `destructive`.
    if (b.cta === true && b.destructive !== true) {
      console.error('cairn[modal]: cta button ' + JSON.stringify(b.id) + ' is not destructive')
    }
    el.setAttribute(
      'style',
      BUTTON_BASE + (b.destructive === true
        ? (b.cta === true ? BUTTON_DESTRUCTIVE_CTA : BUTTON_DESTRUCTIVE)
        : BUTTON_DEFAULT)
    )
    el.addEventListener('click', (ev: Event) => {
      ev.preventDefault()
      ev.stopPropagation()
      finish(b.id)
    })
    buttons.push(el)
    // §1.6.1: "Rendered left to right, in array order."  Every call site puts
    // the safe choice FIRST, so the destructive choice is never the one under
    // the pointer's resting position at the right edge of the row.
    row.append(el)
  }

  /**
   * §1.6.1 behaviours 1 and 4.  Escape picks `defaultId` — never a dismissal
   * with no answer, because "the user pressed Escape" and "the user picked
   * Cancel" must land on the same code path or the caller has a fourth,
   * unwritten branch.  Tab cycles WITHIN the dialog: with the backdrop covering
   * the app, tabbing out would put focus on a control the user cannot see.
   */
  function onKey(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') {
      ev.preventDefault()
      ev.stopPropagation()
      finish(spec.defaultId)
      return
    }
    if (ev.key !== 'Tab' || buttons.length === 0) return
    ev.preventDefault()
    ev.stopPropagation()
    const active = doc.activeElement
    let i = buttons.findIndex((b) => b === active)
    if (i < 0) i = 0
    const next = ev.shiftKey
      ? (i - 1 + buttons.length) % buttons.length
      : (i + 1) % buttons.length
    buttons[next]?.focus()
  }

  box.appendChild(row)
  back.append(box)
  doc.body.appendChild(back)
  doc.addEventListener('keydown', onKey, true)

  // Focus on open: `focusId`, defaulting to `defaultId` (§1.6.1 behaviour 1 —
  // the safe choice, so Return-on-open can never destroy anything).  The
  // delete confirm is the measured exception (see the interface comment): it
  // focuses its Delete.
  const focusId = spec.focusId ?? spec.defaultId
  const foc = buttons.find((b) => b.getAttribute('data-id') === focusId)
  if (foc === undefined) {
    console.error(
      'cairn[modal]: focusId ' + JSON.stringify(focusId) + ' matches no button'
    )
  }
  const def = buttons.find((b) => b.getAttribute('data-id') === spec.defaultId)
  if (def === undefined) {
    console.error(
      'cairn[modal]: defaultId ' + JSON.stringify(spec.defaultId) + ' matches no button'
    )
  }
  ;(foc ?? def ?? buttons[0])?.focus()

  return result
}
