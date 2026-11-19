/**
 * src/mic.ts
 * Owner: 03.  Spec: CONTRACT.md §0.58 E111 — the book reader's microphone.
 *
 * comart's microphone button and its PLAIN transcript card (`~/comart/mic.js`
 * at 7ec2379), restyled by mic.css: record → the red Stop → transcribe → a card
 * with the transcript, a player and Copy, over the reader pane.  Only the
 * red Stop: comart's extra Stops, its full card, grip, CHECK and word chips are
 * not ported.
 *
 * NO AUDIO CODE.  One take at a time goes through `MicAudio` (mic-types.ts),
 * and every event is guarded by the take's own token, so nothing a discarded
 * take says can reach the screen; a stale `done` has its clip released.
 *
 * ONE BODY-LEVEL FRAME, never a child of `#reader`: `main.editor` is
 * `contain: paint`, which clips every fixed descendant to the pane, and the
 * shield must cover the sidebar too.  `div.ep-mic-frame` is an invisible
 * scroller that takes no pointer; it carries the wheel (see "the frame" below)
 * and shows while the button or the card does.  Inside it, `section.ep-mic`
 * lives for the mount and is `[hidden]` unless a book shows;
 * `div.ep-mic-layer` (shield + card) exists only while the card is open and is
 * removed on close, never hidden.
 *
 * RULE 3.  While the card is open the shield takes every click below the title
 * bar and closes only the card; the reader's outside-click rule stands down
 * (`cardOpen()`), so the band stays.  Esc closes the card first, at window
 * capture, and stops there; it steps aside for a modal or a menu.
 *
 * THREE WINDOW LISTENERS for the life of the mount: keydown and keyup at
 * capture (Esc), and resize (the card's placement).
 *
 * WHERE IT DIFFERS FROM comart, on purpose: an arming click cancels the take
 * at once (comart keeps the start pending for one shared recorder); the
 * keyboard may record and stop, a held Enter is one click, and an Esc on the
 * focused button gives focus back to #reader; a pointer press never takes
 * focus out of #reader, and no press on the mic closes the find bar; Esc steps
 * aside for a modal or a menu, and a held Esc closes one layer; a refused
 * microphone says "Microphone access denied".  Which answers
 * retry, fail or mean no speech is voice-typing's classify, decided on the
 * audio side: the UI shows the line it is given.
 *
 * No HTML string reaches the document (§6.1): the glyphs are comart's, built
 * with createElementNS like explain-render.ts's, and every word is textContent.
 */

import type { MicClip, MicClipState, MicDeps, MicError, MicTake, MicView } from './mic-types'

type State = 'idle' | 'arming' | 'recording' | 'transcribing'

/** The button's accessible name per state (comart mic.js:1062-1071). */
const LABEL: Record<State, string> = {
  idle: 'Record',
  arming: 'Starting',
  recording: 'Stop recording',
  transcribing: 'Transcribing',
}

/** The UI owns the microphone's words; the audio side reports codes.  'denied'
 *  is comart's app-page wording: mic.js's names a tab Cairn never opens. */
const MIC_WORDS: Record<MicError, string> = {
  denied: 'Microphone access denied',
  unavailable: 'Microphone unavailable',
}
const CAP = 'Recording cancelled — over 2 minutes'
const SHORT = 'Too short — try again'
const NO_SPEECH = 'No speech detected'
const FAILED = 'Transcription failed'
const PLAY_FAILED = "Couldn't play the recording."
const FLASH_MS = 1800
const COPIED_MS = 1500

const SVG_NS = 'http://www.w3.org/2000/svg'

type Attrs = readonly (readonly [string, string])[]

/** The stroked-glyph attributes comart sets on its mic, copy and check. */
const STROKE: Attrs = [
  ['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', '2'],
  ['stroke-linecap', 'round'], ['stroke-linejoin', 'round'],
]

/** One of comart's glyphs, its exact attributes (mic.js:63-74).  NOT
 *  `icons.ts icon()`: its root stroke would outline the filled Stop, play and
 *  pause shapes, and these are comart's, not Lucide's. */
function glyph(doc: Document, cls: string, extra: Attrs, kids: readonly (readonly [string, Attrs])[]): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('class', cls)
  for (const [k, v] of extra) svg.setAttribute(k, v)
  for (const [tag, attrs] of kids) {
    const el = doc.createElementNS(SVG_NS, tag)
    for (const [k, v] of attrs) el.setAttribute(k, v)
    svg.append(el)
  }
  return svg
}

/** comart's clock (mic.js:1125-1128): m:ss. */
function clock(sec: number): string {
  const n = Math.max(0, Math.floor(sec || 0))
  return Math.floor(n / 60) + ':' + String(n % 60).padStart(2, '0')
}

/** A press on the mic is the mic's: the find bar's outside press (document,
 *  bubble) must not hear it, or Record, the card and the shield would close
 *  the find bar and wipe its query.  Capture listeners (the reader's band
 *  rule, the menu's) still see it. */
function keepPress(el: HTMLElement): void {
  el.addEventListener('pointerdown', (ev) => ev.stopPropagation())
}

/** `el` scrolls on y and still has room in the direction of `dy`. */
function hasRoom(el: Element, dy: number): boolean {
  const ovy = window.getComputedStyle(el).overflowY
  if (ovy !== 'auto' && ovy !== 'scroll') return false
  const max = el.scrollHeight - el.clientHeight
  return dy > 0 ? el.scrollTop < max - 0.5 : el.scrollTop > 0.5
}

/** comart's card top: the fraction of the page's height above it. */
const CARD_TOP = 0.15

/** The frame's run: far more travel each way than a card's life needs. */
const PARK = 100000

/** The open card's parts, built fresh on every open so no listener or text
 *  survives a close. */
interface Card {
  layer: HTMLDivElement
  wrap: HTMLDivElement
  el: HTMLElement
  player: HTMLDivElement
  pp: HTMLButtonElement
  fill: HTMLDivElement
  time: HTMLSpanElement
  copy: HTMLButtonElement
  clip: MicClip
}

export function mountMic(host: HTMLElement, deps: MicDeps): MicView {
  const doc = host.ownerDocument

  /* ── the button (comart mic.js:85-121, 196) ───────────────────────────── */

  const root = doc.createElement('section')
  root.className = 'ep-mic'
  root.setAttribute('aria-label', 'Voice transcription')
  root.setAttribute('data-state', 'idle')
  root.hidden = true
  const btn = doc.createElement('button')
  btn.setAttribute('type', 'button')
  btn.className = 'mc-btn'
  btn.setAttribute('aria-label', LABEL.idle)
  const micIco = glyph(doc, 'mc-ico mc-ico-mic', STROKE, [
    ['path', [['d', 'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z']]],
    ['path', [['d', 'M19 10v2a7 7 0 0 1-14 0v-2']]],
    ['path', [['d', 'M12 19v3']]],
  ])
  const stopIco = glyph(doc, 'mc-ico mc-ico-stop', [], [
    ['rect', [['x', '7'], ['y', '7'], ['width', '10'], ['height', '10'], ['rx', '2.5'], ['fill', 'currentColor']]],
  ])
  const dots = doc.createElement('span')
  dots.className = 'mc-dots'
  dots.setAttribute('aria-hidden', 'true')
  for (let i = 0; i < 3; i++) dots.append(doc.createElement('i'))
  const label = doc.createElement('span')
  label.className = 'mc-label'
  label.setAttribute('aria-live', 'polite')
  btn.append(micIco, stopIco, dots, label)
  root.append(btn)

  /* ── the frame: the wheel over the mic is the engine's own ────────────── */

  // comart's page scrolls under its button and shield because the document is
  // the scroller there.  The book and the band are inner scrollers that are
  // not ancestors of the mic, so the engine's chaining never reaches them, and
  // a hand-made scroll cannot have the engine's wheel animation.  So the mic
  // lives inside an invisible scroller of its own, the frame: a wheel over the
  // button, the shield or the card chains to the frame, the engine animates
  // the frame exactly as it would the book, and every frame of that movement
  // is handed to the scroller the pointer is over (`target`).  The card's text
  // is nearer than the frame, so it scrolls first while it has room.  The pin
  // holds the mic still while the frame moves; the frame takes no pointer.
  const frame = doc.createElement('div')
  frame.className = 'ep-mic-frame'
  frame.hidden = true
  const pin = doc.createElement('div')
  pin.className = 'mc-pin'
  const run = doc.createElement('div')
  run.className = 'mc-run'
  pin.append(root)
  frame.append(pin, run)
  doc.body.append(frame)
  keepPress(root)

  let target: Element | null = null
  let last = 0
  function park(): void {
    frame.scrollTop = PARK
    last = frame.scrollTop
  }
  // Passive: the engine never waits for it, as it never waits over the book.
  frame.addEventListener('wheel', (ev) => {
    const e = ev as WheelEvent
    if (!e.deltaY) return
    target = doc.elementsFromPoint(e.clientX, e.clientY)
      .find((n) => !frame.contains(n) && hasRoom(n, e.deltaY)) ?? null
  }, { passive: true })
  frame.addEventListener('scroll', () => {
    const now = frame.scrollTop
    const d = now - last
    last = now
    if (d && target) target.scrollTop += d
  })
  // The target lasts one wheel motion: an arrow key on the focused button or a
  // drag-select's autoscroll also moves the frame, and must not move the book.
  frame.addEventListener('scrollend', () => {
    target = null
    if (Math.abs(frame.scrollTop - PARK) > PARK / 2) park()
  })
  /** The frame shows while the button or the card does. */
  function syncFrame(): void {
    const hide = root.hidden && card === null
    if (frame.hidden === hide) return
    frame.hidden = hide
    if (!hide) park()
  }

  /* ── state (comart mic.js:1062-1103) ──────────────────────────────────── */

  let state: State = 'idle'
  let take: MicTake | null = null
  /** The live take's token: an event from any other take is ignored. */
  let current: object | null = null
  let card: Card | null = null
  let sticky = false
  let flashTimer: ReturnType<typeof setTimeout> | null = null
  let copiedTimer: ReturnType<typeof setTimeout> | null = null
  /** The Esc that closed the card is still held: swallow its repeats. */
  let escHeld = false
  let destroyed = false

  function setState(s: State): void {
    state = s
    root.setAttribute('data-state', s)
    btn.setAttribute('aria-label', LABEL[s])
  }
  // comart's quirk, kept: a status does not cancel a pending flash's timer.
  function setStatus(msg: string, isError: boolean): void {
    sticky = false
    label.textContent = msg
    root.setAttribute('data-msg', '1')
    btn.classList.toggle('is-error', isError)
  }
  function idleStatus(): void {
    sticky = false
    label.textContent = ''
    root.removeAttribute('data-msg')
    btn.classList.remove('is-error')
  }
  function flash(msg: string, isError: boolean): void {
    setStatus(msg, isError)
    if (flashTimer !== null) clearTimeout(flashTimer)
    flashTimer = setTimeout(() => {
      flashTimer = null
      if (state === 'idle') idleStatus()
    }, FLASH_MS)
  }
  /** The cap's message stays until a click reads it: a timer would leave no
   *  evidence that a long take was thrown away. */
  function showSticky(msg: string, isError: boolean): void {
    if (flashTimer !== null) clearTimeout(flashTimer)
    flashTimer = null
    setStatus(msg, isError)
    sticky = true
  }

  /** The take is over (or discarded): forget it and go back to the glyph. */
  function end(): void {
    current = null
    take = null
    setState('idle')
    idleStatus()
  }
  /** Discard the live take silently. */
  function drop(): void {
    const t = take
    current = null
    take = null
    t?.cancel()
  }

  /* ── a take ───────────────────────────────────────────────────────────── */

  function startTake(): void {
    const token = {}
    current = token
    const mine = (): boolean => current === token
    let t: MicTake
    try {
      t = deps.audio.start({
        recording: () => {
          if (!mine() || state !== 'arming') return
          setState('recording')
          idleStatus()
        },
        micFailed: (err) => {
          if (!mine()) return
          end()
          setStatus(MIC_WORDS[err], true)
        },
        transcribing: () => {
          if (!mine() || state === 'idle') return
          setState('transcribing')
          idleStatus()
        },
        done: (d) => {
          if (!mine()) {
            d.clip.release()
            return
          }
          end()
          showCard(d.text, d.clip)
        },
        failed: (message) => {
          if (!mine()) return
          end()
          setStatus(message || FAILED, true)
        },
        cancelled: (reason) => {
          if (!mine()) return
          end()
          if (reason === 'over') showSticky(CAP, false)
          else flash(SHORT, false)
        },
      })
    } catch (err) {
      deps.onError(err, 'mic-start')
      if (mine()) {
        end()
        setStatus(MIC_WORDS.unavailable, true)
      }
      return
    }
    // An ending can arrive before start() returns; that take is not kept.
    if (mine()) take = t
  }

  /* ── the button (comart mic.js:1598-1738) ─────────────────────────────── */

  // The press never takes focus: focus stays in #reader, where the reader and
  // the band hear Esc.  Probed in Electron 39: :active still applies.
  btn.addEventListener('mousedown', (ev) => ev.preventDefault())
  // A held Enter is one click.  The engine clicks a focused button on every
  // Enter keydown, auto-repeats included, unless the keydown is cancelled;
  // Space clicks on keyup only.
  btn.addEventListener('keydown', (ev) => {
    const e = ev as KeyboardEvent
    if (e.key === 'Enter' && e.repeat) e.preventDefault()
  })
  btn.addEventListener('click', (ev) => {
    const e = ev as MouseEvent
    if (!e.isTrusted || destroyed) return
    // Keyboard activation is allowed (detail 0): Cairn owns its DOM, so no page
    // can focus the button behind the reader's back.
    const pointer = e.detail > 0
    if (sticky) {
      idleStatus()
      deps.restoreFocus()
      return
    }
    if (state === 'idle') {
      endCard()
      setState('arming')
      idleStatus()
      startTake()
    } else if (state === 'arming') {
      // At once: an arming take has sent nothing to ai-service yet.
      drop()
      setState('idle')
      idleStatus()
    } else if (state === 'recording') {
      const t = take
      setState('transcribing')
      idleStatus()
      if (t && !t.stop() && take === t) {
        drop()
        setState('idle')
        idleStatus()
      }
    }
    // transcribing: the answer is already on its way.
    if (pointer) deps.restoreFocus()
  })

  /* ── the plain card (comart mic.js:1353-1490) ─────────────────────────── */

  function paint(c: Card, s: MicClipState | null): void {
    const dur = s && s.dur ? s.dur : 0
    const t = s ? Math.min(s.t || 0, dur) : 0
    c.fill.style.width = (dur ? (t / dur) * 100 : 0) + '%'
    c.time.textContent = clock(t) + ' / ' + clock(dur)
    c.player.classList.toggle('is-playing', !!(s && s.playing))
    c.pp.setAttribute('aria-label', s && s.playing ? 'Pause' : 'Play')
  }

  /** The card's top is where comart's own card's is: 15% of the page's
   *  height below its top (the modal's `padding-top: 15vh`, mic.css:417-445),
   *  the page being the reader pane, at the pane's edges and width (plainPlace,
   *  mic.js:1270-1276, for the writing).  comart's plain card hangs on a host
   *  card's middle line instead, but here no card is under it. */
  function place(): void {
    const c = card
    if (!c) return
    const r = host.getBoundingClientRect()
    c.wrap.style.top = Math.round(r.top + r.height * CARD_TOP) + 'px'
    c.wrap.style.left = r.left + 'px'
    c.wrap.style.right = 'auto'
    c.wrap.style.width = r.width + 'px'
  }
  // The pane can change width with no window resize (the sidebar).
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => place()) : null

  function buildCard(text: string, clip: MicClip): Card {
    const layer = doc.createElement('div')
    layer.className = 'ep-mic-layer'
    const shield = doc.createElement('div')
    shield.className = 'mc-shield'
    const wrap = doc.createElement('div')
    wrap.className = 'mc-wrap'
    const el = doc.createElement('section')
    el.className = 'mc-card'
    el.setAttribute('role', 'dialog')
    el.setAttribute('aria-modal', 'true')
    el.setAttribute('aria-label', 'Transcript')
    const body = doc.createElement('div')
    body.className = 'mc-body'
    const p = doc.createElement('p')
    p.className = 'mc-text'
    p.textContent = text || NO_SPEECH
    p.classList.toggle('is-empty', !text)

    const player = doc.createElement('div')
    player.className = 'mc-player'
    const pp = doc.createElement('button')
    pp.setAttribute('type', 'button')
    pp.className = 'mc-pp'
    pp.setAttribute('aria-label', 'Play')
    pp.append(
      glyph(doc, 'mc-ico-pp mc-ico-play', [], [
        ['path', [['d', 'M9 7.4v9.2a1 1 0 0 0 1.53.85l7.3-4.6a1 1 0 0 0 0-1.7l-7.3-4.6A1 1 0 0 0 9 7.4z'], ['fill', 'currentColor']]],
      ]),
      glyph(doc, 'mc-ico-pp mc-ico-pause', [], [
        ['rect', [['x', '8'], ['y', '6'], ['width', '3.2'], ['height', '12'], ['rx', '1.2'], ['fill', 'currentColor']]],
        ['rect', [['x', '12.8'], ['y', '6'], ['width', '3.2'], ['height', '12'], ['rx', '1.2'], ['fill', 'currentColor']]],
      ]),
    )
    const track = doc.createElement('div')
    track.className = 'mc-track'
    const fill = doc.createElement('div')
    fill.className = 'mc-fill'
    track.append(fill)
    const time = doc.createElement('span')
    time.className = 'mc-time'
    time.textContent = '0:00 / 0:00'
    player.append(pp, track, time)

    const actions = doc.createElement('div')
    actions.className = 'mc-actions'
    const copy = doc.createElement('button')
    copy.setAttribute('type', 'button')
    copy.className = 'mc-copy'
    copy.setAttribute('aria-label', 'Copy')
    copy.append(
      glyph(doc, 'mc-ico-cp', STROKE, [
        ['rect', [['x', '9'], ['y', '9'], ['width', '11'], ['height', '11'], ['rx', '2']]],
        ['path', [['d', 'M5 15V6a2 2 0 0 1 2-2h8']]],
      ]),
      glyph(doc, 'mc-ico-ck', STROKE, [['path', [['d', 'M20 6 9 17l-5-5']]]]),
    )
    copy.hidden = !text
    actions.append(copy)

    body.append(p, player, actions)
    el.append(body)
    wrap.append(el)
    // The shield first: the wrapper, later at the same z-index, rides above it.
    layer.append(shield, wrap)
    keepPress(layer)
    const c: Card = { layer, wrap, el, player, pp, fill, time, copy, clip }

    // Target phase, never capture: the reader's document-capture click must
    // see the card still open and stand down, or the band would close too.
    shield.addEventListener('click', (ev) => {
      if (ev.isTrusted && card === c && endCard()) deps.restoreFocus()
    })
    pp.addEventListener('click', (ev) => {
      if (!ev.isTrusted || card !== c) return
      const s = clip.play()
      if (s) paint(c, s)
    })
    track.addEventListener('click', (ev) => {
      const e = ev as MouseEvent
      if (!e.isTrusted || card !== c) return
      const r = track.getBoundingClientRect()
      if (!r.width) return
      const s = clip.seek((e.clientX - r.left) / r.width)
      if (s) paint(c, s)
    })
    // Command 23: navigator.clipboard fails in this shell.  The check shows
    // only once the copy resolved, as comart's does.
    copy.addEventListener('click', (ev) => {
      if (!ev.isTrusted || card !== c) return
      void deps.copyText(text).then(() => {
        if (card !== c) return
        copy.classList.add('is-copied')
        copy.setAttribute('aria-label', 'Copied')
        if (copiedTimer !== null) clearTimeout(copiedTimer)
        copiedTimer = setTimeout(() => {
          copiedTimer = null
          copy.classList.remove('is-copied')
          copy.setAttribute('aria-label', 'Copy')
        }, COPIED_MS)
      }, (err: unknown) => deps.onError(err, 'mic-copy'))
      copy.blur()
    })
    return c
  }

  function showCard(text: string, clip: MicClip): void {
    endCard()
    const c = buildCard(text, clip)
    card = c
    pin.append(c.layer)
    syncFrame()
    paint(c, { playing: false, t: 0, dur: clip.state().dur })
    // The rect read also flushes the card's first style, so the class added on
    // the next frame transitions instead of jumping.
    place()
    ro?.observe(host)
    requestAnimationFrame(() => {
      if (card === c) c.el.classList.add('is-shown')
    })
    clip.watch({
      state: (s) => {
        if (card === c) paint(c, s)
      },
      failed: (message) => {
        if (card === c) flash(message || PLAY_FAILED, true)
      },
    })
    const s = clip.play(true)
    if (s) paint(c, s)
  }

  /** Instant, as comart's endPlain: no close motion.  The clip goes with it. */
  function endCard(): boolean {
    const c = card
    if (!c) return false
    card = null
    if (copiedTimer !== null) clearTimeout(copiedTimer)
    copiedTimer = null
    dropSelectionIn(c.el)
    ro?.unobserve(host)
    c.layer.remove()
    syncFrame()
    c.clip.release()
    return true
  }

  /** A selection inside the card goes with it; one elsewhere is the user's. */
  function dropSelectionIn(node: Node): void {
    try {
      const sel = doc.defaultView?.getSelection?.()
      if (sel && sel.rangeCount && node.contains(sel.getRangeAt(0).commonAncestorContainer)) sel.removeAllRanges()
    } catch {
      /* no selection to drop */
    }
  }

  /* ── Esc and the window (comart mic.js:1505-1513) ─────────────────────── */

  function onKeyDown(ev: Event): void {
    const e = ev as KeyboardEvent
    if (!e.isTrusted || e.key !== 'Escape') return
    if (e.repeat) {
      // One press, one layer, even held: the reader and the find field would
      // otherwise take the repeats of the press that closed the card.
      if (escHeld) e.stopPropagation()
      return
    }
    escHeld = false
    // A modal's or a menu's own Esc (document capture) runs after this one.
    if (deps.layerAbove()) return
    if (!card) {
      // A keyboard click leaves focus on this body-level button, outside
      // #reader, so no reader layer hears the Esc: it gives focus back, and
      // the next Esc is the reader's.
      if (doc.activeElement === btn) deps.restoreFocus()
      return
    }
    e.stopPropagation()
    endCard()
    escHeld = true
    deps.restoreFocus()
  }
  function onKeyUp(ev: Event): void {
    const e = ev as KeyboardEvent
    if (e.isTrusted && e.key === 'Escape') escHeld = false
  }
  window.addEventListener('keydown', onKeyDown, true)
  window.addEventListener('keyup', onKeyUp, true)
  window.addEventListener('resize', place)

  /* ── the reader's seam ────────────────────────────────────────────────── */

  function leave(): void {
    drop()
    endCard()
    if (flashTimer !== null) clearTimeout(flashTimer)
    flashTimer = null
    escHeld = false
    setState('idle')
    idleStatus()
  }

  return {
    setShown(on: boolean): void {
      root.hidden = !on
      syncFrame()
    },
    leave,
    cardOpen: () => card !== null,
    destroy(): void {
      if (destroyed) return
      leave()
      destroyed = true
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('resize', place)
      ro?.disconnect()
      frame.remove()
      deps.audio.destroy()
    },
  }
}
