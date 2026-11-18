/**
 * src/explain.ts
 * Owner: 03.  Spec: CONTRACT.md §0.56 E109 — click-to-explain in the EPUB reader,
 * and §0.57 E110 — the band's two halves.
 *
 * THE EXPLANATION BAND under the book: comart's explain path (panel.js
 * `triggerExplain` / `streamExplain` / `readSse` / `render`, app-listen.js
 * `playBadge`, content.js's resize grip) and its §3h split (panel.js:484-528,
 * 2711-2817): two halves, each its own thread (`explain-thread.ts`), laid out
 * as one panel or as two equal columns.  A pick on a band that holds nothing
 * starts the left thread at full width; any later pick is STAGED, and nothing
 * is fetched until a trusted click, Enter or Space on a half places it —
 * over the whole panel or in the new right half while it is one panel, in
 * either half once it is split.  The split lasts until the band closes, or
 * until both halves have ended empty: then the next pick starts one panel.
 * comart's Ask, caption card and credits are not ported.
 *
 * This file is the controller of everything there is one of: the root, the
 * grip and height, the layout, the staged pick and its overlay, focus, the
 * drill-down gesture, audio, the click swallow and its TWO window listeners.
 * `explain-thread.ts` owns each half's state and I/O; `explain-render.ts`
 * builds every node.  No HTML string reaches the document (§6.1).
 *
 * The band never dismisses itself: the reader owns the outside click and Esc
 * (it knows what a pick is) and calls `cancelStaged()` or `close()`.  Nothing
 * is printed unasked except the error line; the passage sent goes to the
 * console only.
 */

import { MAX_WORDS } from './bookpick'
import { createThread, type ExplainThread } from './explain-thread'
import type { ExplainItem, ExplainOutcome, ExplainPanel, ExplainPanelDeps, ExplainRequest } from './explain-types'

/** Height in CSS px: the default, the floor, and the book kept above the band. */
const DEFAULT_H = 320
const MIN_H = 140
const BOOK_ROOM = 24
const KEY_STEP = 24
const SWALLOW_MS = 250
/** A drag reaches this many words either side of where it started. */
const DRILL_REACH = MAX_WORDS - 1
/** A wheel "line" in px: Blink's own step for a line-mode delta. */
const WHEEL_LINE_PX = 40

type Side = 'left' | 'right'
type Layout = 'single' | 'split'

/** A pick waiting for a half.  `mode` is fixed when it is staged: 'second'
 *  while the band is one panel (left = the whole panel, right = split),
 *  'replace' once it is split (each half replaces only itself). */
interface Pending {
  text: string
  items: ExplainItem[]
  mode: 'second' | 'replace'
}

/** A drill-down in progress: the half, the round block it started in and
 *  that block's words. */
interface Drill {
  thread: ExplainThread
  block: Element
  spans: Element[]
  startIdx: number
  currentIdx: number
}

/** comart's wording (panel.js:2730-2735); the halves carry no visible text. */
const LABELS = {
  second: {
    left: 'Replace the whole panel with the new explanation',
    right: 'Split the panel and put the new explanation on the right',
  },
  replace: {
    left: 'Put the new explanation in the left panel',
    right: 'Put the new explanation in the right panel',
  },
} as const

function elementOf(t: EventTarget | null): Element | null {
  const n = t as Node | null
  if (!n) return null
  return n.nodeType === 1 ? (n as Element) : n.parentElement
}

function isHttp(href: string): boolean {
  try {
    const u = new URL(href)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

export function mountExplain(host: HTMLElement, deps: ExplainPanelDeps): ExplainPanel {
  const base = deps.base.replace(/\/+$/, '')
  // Unbound `fetch` throws "Illegal invocation" in the browser.
  const fetchFn: typeof fetch = deps.fetch ?? ((input, init) => fetch(input, init))
  const makeAudio = deps.audio ?? ((url: string) => new Audio(url))

  /* ── DOM (§2's contract) ──────────────────────────────────────────────── */

  const panel = document.createElement('div')
  panel.className = 'ep-explain'
  panel.hidden = true
  // Focusable but not tabbable: a click inside keeps focus within #reader,
  // and every path that hides a focused half lands focus here.
  panel.setAttribute('tabindex', '-1')
  panel.setAttribute('role', 'region')
  panel.setAttribute('aria-label', 'Explanation')
  const grip = document.createElement('div')
  grip.className = 'ex-grip'
  grip.setAttribute('role', 'separator')
  grip.setAttribute('aria-orientation', 'horizontal')
  grip.setAttribute('aria-label', 'Resize explanation panel')
  grip.setAttribute('tabindex', '0')

  const threadIO = { base, fetch: fetchFn, onError: (err: unknown, ctx: string) => deps.onError(err, ctx) }
  const left = createThread({ slot: 0, ...threadIO })
  const right = createThread({ slot: 1, ...threadIO })
  const threads = [left, right] as const

  // The overlay is the row's LAST child: with both columns inert while a pick
  // is staged, Tab goes from the grip straight to the halves.
  const place = document.createElement('div')
  place.className = 'ex-place'
  place.hidden = true
  function placeHalf(side: Side): HTMLDivElement {
    const half = document.createElement('div')
    half.className = `ex-place-half ex-place-${side}`
    half.setAttribute('role', 'button')
    half.setAttribute('tabindex', '0')
    return half
  }
  const placeLeft = placeHalf('left')
  const placeRight = placeHalf('right')
  place.append(placeLeft, placeRight)

  const slots = document.createElement('div')
  slots.className = 'ex-slots'
  slots.setAttribute('data-layout', 'single')
  slots.append(left.column, right.column, place)
  panel.append(grip, slots)
  host.append(panel)

  let layout: Layout = 'single'
  let pending: Pending | null = null
  /** The half under the pointer while the overlay is up, from its
   *  `mouseenter` until the overlay's `mouseleave`. */
  let hoverSide: Side | null = null
  let drill: Drill | null = null
  let lastDrillKey = ''
  let destroyed = false

  /* ── height ───────────────────────────────────────────────────────────── */

  // The height the user chose; the applied one is this clamped to the room
  // there is now, so a short window does not ratchet the choice down.  One
  // height for both halves, as comart's band.
  const initial = deps.initialHeight
  let wantH = typeof initial === 'number' && Number.isFinite(initial) ? initial : DEFAULT_H
  let curH = 0

  function clampH(h: number): number {
    const room = host.clientHeight
    // An unlaid-out host (hidden reader) has no room to clamp against yet.
    const max = room > 0 ? Math.max(MIN_H, room - BOOK_ROOM) : Infinity
    return Math.min(max, Math.max(MIN_H, Math.round(h)))
  }

  function applyH(h: number): boolean {
    const next = clampH(h)
    if (next === curH) return false
    curH = next
    panel.style.height = `${next}px`
    return true
  }

  /** A height the user set (grip or keys): it becomes the choice.  One the
   *  clamp swallowed is no choice, or a tall window's height would be lost to
   *  a short one's. */
  function resizeTo(h: number): boolean {
    const changed = applyH(h)
    if (changed) wantH = curH
    return changed
  }

  applyH(wantH)

  let shownQueued = false
  /** `onShown` once the new height has laid out, at most once a frame. */
  function queueShown(): void {
    if (shownQueued) return
    shownQueued = true
    requestAnimationFrame(() => {
      shownQueued = false
      if (!destroyed && !panel.hidden) deps.onShown()
    })
  }

  // The grip stays live while a pick is staged: the overlay sits below it.
  let gripDrag: { startY: number; startH: number; startWant: number } | null = null

  grip.addEventListener('pointerdown', (ev) => {
    const e = ev as PointerEvent
    if (e.button !== 0) return
    e.preventDefault()
    gripDrag = { startY: e.clientY, startH: curH, startWant: wantH }
    grip.classList.add('is-active')
    // Capture keeps the drag alive when the pointer outruns the 6px strip.
    try { grip.setPointerCapture(e.pointerId) } catch { /* moves still arrive over the grip */ }
  })
  grip.addEventListener('pointermove', (ev) => {
    if (!gripDrag) return
    const e = ev as PointerEvent
    // Up is taller: the band's bottom edge is pinned to the reader's.
    if (resizeTo(gripDrag.startH + (gripDrag.startY - e.clientY))) queueShown()
  })
  function endGrip(ev: Event): void {
    if (!gripDrag) return
    const { startWant } = gripDrag
    gripDrag = null
    grip.classList.remove('is-active')
    try { grip.releasePointerCapture((ev as PointerEvent).pointerId) } catch { /* already released */ }
    // Once per drag, not per frame, and not for a click that moved nothing.
    if (wantH !== startWant) deps.saveHeight(wantH)
  }
  grip.addEventListener('pointerup', endGrip)
  grip.addEventListener('pointercancel', endGrip)
  grip.addEventListener('keydown', (ev) => {
    const e = ev as KeyboardEvent
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
    e.preventDefault()
    if (resizeTo(curH + (e.key === 'ArrowUp' ? KEY_STEP : -KEY_STEP))) {
      queueShown()
      deps.saveHeight(wantH)
    }
  })

  /* ── layout, and following through a width change (D2) ───────────────── */

  function setLayout(next: Layout): void {
    layout = next
    slots.setAttribute('data-layout', next)
  }

  /** The preview and the split change a column's width, which re-wraps its
   *  answer under a scrollTop the engine's anchoring holds still: a half
   *  that was following its stream would stop.  Re-pin it after the change
   *  (D2; comart loses the pin). */
  function keepFollowing(change: () => void): void {
    const pinned = threads.filter((t) => t.isFollowing())
    change()
    for (const t of pinned) t.toBottom()
  }

  /** The preview classes alone; callers wrap them in `keepFollowing`. */
  function previewClasses(side: Side | null): void {
    slots.classList.toggle('place-left', side === 'left')
    slots.classList.toggle('place-right', side === 'right')
  }

  function setPreview(side: Side | null): void {
    keepFollowing(() => previewClasses(side))
  }

  /** Focus that was in `el` lands on the band root: inside #reader, where
   *  Esc is heard, and never on <body> when `el` hides or goes inert. */
  function rescueFocus(el: Element): void {
    const active = document.activeElement
    if (active && active !== panel && el.contains(active)) panel.focus({ preventScroll: true })
  }

  /* ── staging (comart showPlacement / clearPlacement) ──────────────────── */

  function showPlacement(p: Pending): void {
    pending = p
    slots.setAttribute('data-place', p.mode)
    placeLeft.setAttribute('aria-label', LABELS[p.mode].left)
    placeRight.setAttribute('aria-label', LABELS[p.mode].right)
    // The overlay blocks the pointer; inert blocks the keyboard reaching a
    // badge or link underneath.  Focus leaves first, or the engine drops it
    // to <body>.
    for (const t of threads) rescueFocus(t.column)
    for (const t of threads) t.column.inert = true
    place.hidden = false
  }

  /** Drop the stage: no request, and nothing on screen but the preview
   *  changes.  The caller wraps it in `keepFollowing`. */
  function hidePlacement(): void {
    pending = null
    hoverSide = null
    // Before the overlay hides: a focused half that goes `display: none`
    // would drop focus to <body>.  Its blur sees no pending pick.
    rescueFocus(place)
    previewClasses(null)
    place.hidden = true
    slots.removeAttribute('data-place')
    for (const t of threads) t.column.inert = false
  }

  /** A thread starts or resets: a drill in it, and its double-click key,
   *  belong to answers that are gone. */
  function forgetGesture(t: ExplainThread): void {
    if (drill?.thread === t) drill = null
    if (lastDrillKey.startsWith(`${t.slot}/`)) lastDrillKey = ''
  }

  function startThread(t: ExplainThread, text: string, items: readonly ExplainItem[]): void {
    forgetGesture(t)
    t.start(text, items)
  }

  function resetThread(t: ExplainThread): void {
    forgetGesture(t)
    t.reset()
  }

  /** comart placePending (panel.js:2752-2776), committed by a trusted
   *  gesture only: every placement is a billed request. */
  function commit(side: Side): void {
    const p = pending
    if (!p || destroyed) return
    keepFollowing(() => {
      hidePlacement()
      if (!left.hasContent() && !right.hasContent()) {
        // D6: thread 0's stream ended empty while the pick waited.  A split
        // now would put a blank half on the left; start over at full width.
        resetThread(right)
        setLayout('single')
        startThread(left, p.text, p.items)
      } else if (p.mode === 'second') {
        if (side === 'left') {
          // Over the whole panel: the old thread goes, stream and all.
          resetThread(right)
          setLayout('single')
          startThread(left, p.text, p.items)
        } else {
          // Split: thread 0 keeps its answer, stream, marks and scroll.
          setLayout('split')
          startThread(right, p.text, p.items)
        }
      } else {
        // Both halves hold a thread: the chosen one starts over, the other
        // is untouched.
        startThread(side === 'left' ? left : right, p.text, p.items)
      }
    })
    panel.focus({ preventScroll: true })
    deps.onPlaced()
  }

  for (const [half, side] of [[placeLeft, 'left'], [placeRight, 'right']] as const) {
    half.addEventListener('mouseenter', () => {
      if (!pending) return
      hoverSide = side
      setPreview(side)
    })
    half.addEventListener('focus', () => {
      if (pending) setPreview(side)
    })
    // A keyboard focus leaving a half hands the preview back to the half
    // under the pointer, or clears it when the pointer is elsewhere.  comart
    // (:2787-2791) clears it too, but keeps the last preview while the
    // pointer is over the overlay.
    half.addEventListener('blur', () => {
      if (pending) setPreview(hoverSide)
    })
    // The overlay covers both columns, scrollbars included: while a pick
    // waits, a click anywhere in the band below the grip places it — one
    // aimed at an answer word, a badge, a link or a scrollbar too.  comart's
    // behaviour, and a billed request; only the wheel reaches the answers.
    half.addEventListener('click', (ev) => {
      const e = ev as MouseEvent
      if (!pending || !e.isTrusted) return
      e.preventDefault()
      e.stopPropagation()
      commit(side)
    })
    half.addEventListener('keydown', (ev) => {
      const e = ev as KeyboardEvent
      if (!pending || !e.isTrusted || (e.key !== 'Enter' && e.key !== ' ')) return
      e.preventDefault()
      // #reader's keydown must not see the key that placed the pick.
      e.stopPropagation()
      commit(side)
    })
  }
  place.addEventListener('mouseleave', () => {
    hoverSide = null
    if (pending) setPreview(null)
  })
  // The overlay is the hit-test surface while a pick waits, so the wheel is
  // forwarded to the half under the pointer (comart :2811-2817).  While one
  // panel previews the split, the new half is empty: thread 0 scrolls.
  place.addEventListener('wheel', (ev) => {
    const e = ev as WheelEvent
    // Ctrl+wheel is the zoom, not a scroll.
    if (!pending || e.ctrlKey) return
    const onRight = !!elementOf(e.target)?.closest('.ex-place-right')
    const t = onRight && layout === 'split' ? right : left
    // deltaMode 1 is lines, 2 is pages.
    const unit = e.deltaMode === 1 ? WHEEL_LINE_PX : e.deltaMode === 2 ? t.scroll.clientHeight : 1
    t.scroll.scrollTop += e.deltaY * unit
    e.preventDefault()
  }, { passive: false })

  /* ── audio (app-listen.js playBadge): one clip across both halves ─────── */

  let playing: { audio: HTMLAudioElement; btn: Element } | null = null

  function stopAudio(): void {
    if (!playing) return
    try { playing.audio.pause() } catch { /* never started */ }
    playing.btn.classList.remove('is-playing')
    playing = null
  }

  function playBadge(btn: Element): void {
    const url = btn.getAttribute('data-mp3')
    if (!url) return
    stopAudio()
    const audio = makeAudio(url)
    const token = { audio, btn }
    playing = token
    btn.classList.add('is-playing')
    // Identity-checked: a superseded clip's late `ended`/`error` must not
    // clear the badge a newer click is playing.
    const stop = (): void => {
      if (playing !== token) return
      playing = null
      btn.classList.remove('is-playing')
    }
    audio.addEventListener('ended', stop)
    audio.addEventListener('error', stop)
    try {
      audio.play().catch(stop)
    } catch {
      stop()
    }
  }

  /* ── links and badges, in either half (one delegated set) ─────────────── */

  const threadOf = (el: Element): ExplainThread | null => {
    const col = el.closest('.ex-thread')
    return threads.find((t) => t.column === col) ?? null
  }

  slots.addEventListener('click', (ev) => {
    const e = ev as MouseEvent
    const t = elementOf(e.target)
    if (!t || !threadOf(t)) return
    const link = t.closest('.ex-link')
    if (link) {
      // Never the app window: the system browser, through the allow-listed
      // command, or nothing.
      e.preventDefault()
      const href = link.getAttribute('href') ?? ''
      if (isHttp(href)) void deps.openExternal(href).catch((err: unknown) => deps.onError(err, 'explain-link'))
      return
    }
    const btn = t.closest('.pron-badge')
    if (!btn) return
    const c = btn.classList
    if (c.contains('loading') || c.contains('failed') || c.contains('ai-made')) return
    // A mouse click would leave focus on the badge; a keyboard click
    // (detail 0) keeps it, as a keyboard user expects.  The panel takes it,
    // not <body>: the band's Esc is #reader's.
    if (e.detail > 0) panel.focus({ preventScroll: true })
    playBadge(btn)
  })
  // A middle click would open the link in a new app window, and a dropped
  // link would navigate this one.
  slots.addEventListener('auxclick', (ev) => {
    if (elementOf(ev.target)?.closest('.ex-link')) ev.preventDefault()
  })
  slots.addEventListener('dragstart', (ev) => ev.preventDefault())

  /* ── drill-down (comart panel.js 2492-2553), per half ─────────────────── */

  slots.addEventListener('mousedown', (ev) => {
    const e = ev as MouseEvent
    // A billed request is one real gesture, as in the book.  Nothing is
    // drilled while a pick waits for a half (comart `if (pending) return`).
    if (pending || !e.isTrusted || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return
    const span = elementOf(e.target)?.closest('.ex-word')
    if (!span) return
    const thread = threadOf(span)
    const block = span.closest('.ex-round-block')
    if (!thread || !block || span.closest('.ex-live')) return
    e.preventDefault()
    // The second press of a double-click on the same word: the first asked.
    // Slot-prefixed: both halves number their rounds and words from 0.
    const key = `${thread.slot}/${block.getAttribute('data-round') ?? ''}/${span.getAttribute('data-rid') ?? ''}`
    if (e.detail >= 2 && key === lastDrillKey) return
    lastDrillKey = key
    // This half's marks only; the other half keeps its own.
    thread.clearMarks()
    const spans = Array.from(block.querySelectorAll('.ex-word'))
    const idx = spans.indexOf(span)
    drill = { thread, block, spans, startIdx: idx, currentIdx: idx }
    thread.markRange(spans, idx, idx)
  })

  slots.addEventListener('mousemove', (ev) => {
    if (!drill) return
    const e = ev as MouseEvent
    // Released outside the window: the mouseup never came.
    if (e.buttons === 0) { drill = null; return }
    const span = elementOf(e.target)?.closest('.ex-word')
    if (!span) return
    // Only the block the drag started in: never the other half.
    let idx = drill.spans.indexOf(span)
    if (idx < 0) return
    idx = Math.min(drill.startIdx + DRILL_REACH, Math.max(drill.startIdx - DRILL_REACH, idx))
    if (idx === drill.currentIdx) return
    drill.currentIdx = idx
    drill.thread.markRange(drill.spans, drill.startIdx, idx)
  })

  let swallowing = false
  let swallowTimer: ReturnType<typeof setTimeout> | null = null

  /** The click after a drill-down's release is the gesture's, not a click:
   *  released over the book it would otherwise read as an outside click.
   *  The timer covers a release that makes no click at all. */
  function swallowClick(): void {
    swallowing = true
    if (swallowTimer !== null) clearTimeout(swallowTimer)
    swallowTimer = setTimeout(() => {
      swallowing = false
      swallowTimer = null
    }, SWALLOW_MS)
  }

  function onWindowClick(ev: Event): void {
    if (!swallowing) return
    swallowing = false
    ev.preventDefault()
    ev.stopPropagation()
  }

  function onWindowUp(): void {
    if (!drill) return
    const d = drill
    drill = null
    if (pending) return
    const a = Math.min(d.startIdx, d.currentIdx)
    const b = Math.max(d.startIdx, d.currentIdx)
    const words = d.spans
      .slice(a, b + 1)
      .map((s) => s.getAttribute('data-word') ?? '')
      .filter((w) => w !== '')
    if (!words.length) return
    swallowClick()
    // Round k regenerates k+1 and drops the rest, in THIS half only.
    d.thread.drillFrom(Number(d.block.getAttribute('data-round')), words)
  }

  // Capture: the release may land anywhere, and nothing else may eat it.
  // The band's only two window listeners, however many halves stream.
  window.addEventListener('mouseup', onWindowUp, true)
  window.addEventListener('click', onWindowClick, true)

  /* ── the public surface ───────────────────────────────────────────────── */

  function explain(req: ExplainRequest): ExplainOutcome {
    if (destroyed) return 'started'
    const text = String(req.text ?? '')
    // A snapshot: the committed round holds what was sent.
    const items = (req.items ?? []).map((it) => ({ phrase: String(it.phrase ?? ''), words: [...(it.words ?? [])] }))
    if (!left.hasContent() && !right.hasContent()) {
      // A first pick, or the band is open but holds nothing (a stream that
      // ended empty): full width at once, and any older stage is dropped.
      hidePlacement()
      resetThread(right)
      setLayout('single')
      panel.hidden = false
      applyH(wantH)
      queueShown()
      startThread(left, text, items)
      return 'started'
    }
    // Any later pick waits for a half; the newest one is the one being placed.
    if (pending) {
      // Only the pick changes.  The mode cannot have (only a commit, a close
      // or a start changes the layout, and each drops the stage first), and a
      // book drag released over a half re-stages under a still pointer: a
      // hidden and re-shown overlay gets no new mouseenter and would lose the
      // preview.
      pending = { text, items, mode: pending.mode }
      return 'staged'
    }
    showPlacement({ text, items, mode: layout === 'split' ? 'replace' : 'second' })
    return 'staged'
  }

  function cancelStaged(): boolean {
    if (!pending) return false
    keepFollowing(hidePlacement)
    return true
  }

  function close(): void {
    const wasOpen = !panel.hidden
    hidePlacement()
    drill = null
    lastDrillKey = ''
    for (const t of threads) t.reset()
    setLayout('single')
    stopAudio()
    panel.hidden = true
    if (wasOpen && !destroyed) deps.onClosed()
  }

  function relayout(): void {
    if (destroyed) return
    if (applyH(wantH) && !panel.hidden) queueShown()
  }

  function destroy(): void {
    if (destroyed) return
    close()
    destroyed = true
    for (const t of threads) t.destroy()
    if (swallowTimer !== null) clearTimeout(swallowTimer)
    window.removeEventListener('mouseup', onWindowUp, true)
    window.removeEventListener('click', onWindowClick, true)
    panel.remove()
  }

  return {
    explain,
    cancelStaged,
    isStaged: () => pending !== null,
    close,
    isOpen: () => !panel.hidden,
    element: () => panel,
    relayout,
    destroy,
  }
}
