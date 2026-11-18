/**
 * src/explain-thread.ts
 * Owner: 03.  Spec: CONTRACT.md §0.56 E109 — click-to-explain in the EPUB reader,
 * and §0.57 E110 — the band's two halves (comart §3h).
 *
 * ONE HALF OF THE BAND: comart's `newThread` (panel.js:160-212) and everything
 * that reads or writes it.  Its column (`.ex-thread[data-slot] > .ex-scroll >
 * .ex-content`), its passage and rounds, its one stream (AbortController and
 * 180 s deadline), the live buffer, the error line, the drill-down marks, the
 * pron-only rows, and its OWN Merriam-Webster cache with its own epoch: the
 * related-form bridge scans the whole cache, so one half's clips must never
 * stand in for the other half's words (E109's rule; comart shares one cache,
 * a recorded divergence).  Two of these run at once and never touch each
 * other: a stream, a lookup or a reset in one half cannot reach the other.
 *
 * `explain.ts` owns the pair, the layout, the gestures and every listener;
 * this file holds no listener.  `explain-render.ts` builds every node, so no
 * HTML string reaches the document (§6.1).
 */

import {
  errorLine,
  isPronFailure,
  newPronState,
  pronFailure,
  refreshBadges,
  refreshPronMaps,
  renderMarkdown,
  roundBlock,
  storePronData,
  thinkingDots,
  visibleBuffer,
  wrapResponseWords,
  type PronData,
  type PronEntry,
} from './explain-render'
import type { ExplainItem } from './explain-types'

/** comart's HISTORY_ROUNDS: the earlier answers replayed to the model. */
const HISTORY_ROUNDS = 3
/** Within this of the bottom, a streaming answer keeps the view pinned. */
const STICK_PX = 48
/** One request, start to `done`.  No idle timeout: the server is silent
 *  while the model reasons. */
const DEADLINE_MS = 180_000

const CUT_OFF = 'The answer was cut off — the backend stopped mid-stream.'
const TIMED_OUT = `ai-service didn't finish within ${DEADLINE_MS / 1000} s, so the request was stopped.`
const SERVER_ERROR = 'Something went wrong.'

export type Slot = 0 | 1

/** What a half needs from the band: where ai-service is and how to reach it. */
export interface ThreadDeps {
  slot: Slot
  /** ai-service origin, no trailing slash. */
  base: string
  fetch: typeof fetch
  onError(err: unknown, context: string): void
}

export interface ExplainThread {
  readonly slot: Slot
  /** `.ex-thread[data-slot]`: the column the band lays out and tints. */
  readonly column: HTMLElement
  /** `.ex-scroll`: this half's own scroller. */
  readonly scroll: HTMLElement
  /** `.ex-content`: the rounds. */
  readonly content: HTMLElement
  /** comart's threadHasContent (panel.js:2645-2647): a round, a stream
   *  (even before its first chunk), an error line or a buffer. */
  hasContent(): boolean
  /** Streaming, and within STICK_PX of the bottom: the view follows the
   *  answer.  The band reads it before a width change it makes (D2). */
  isFollowing(): boolean
  toBottom(): void
  /** Forget everything, then ask about `items` in `text`, which stays this
   *  half's passage for every drill-down after it. */
  start(text: string, items: readonly ExplainItem[]): void
  /** A drill-down from round `round`: the rounds after it go, then the next
   *  round is asked for with this half's passage and history. */
  drillFrom(round: number, words: readonly string[]): void
  /** Mark `spans[from..to]` (inclusive, either order) and unmark the rest. */
  markRange(spans: readonly Element[], from: number, to: number): void
  clearMarks(): void
  /** Abort, forget the rounds and the cache, empty the column. */
  reset(): void
  /** Reset, and stay silent for good. */
  destroy(): void
}

/** A committed answer.  Never mutated: `render` keeps a block's DOM for as
 *  long as the same object sits at the same index. */
interface Round {
  readonly text: string
  readonly items: readonly ExplainItem[]
}

interface ExplainBody {
  text: string
  items: readonly ExplainItem[]
  history: string[]
}

function isAbort(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { name?: unknown }).name === 'AbortError'
}

export function createThread(deps: ThreadDeps): ExplainThread {
  const { slot, base } = deps
  const fetchFn = deps.fetch

  const column = document.createElement('div')
  column.className = 'ex-thread'
  column.setAttribute('data-slot', String(slot))
  const scroll = document.createElement('div')
  scroll.className = 'ex-scroll'
  const content = document.createElement('div')
  content.className = 'ex-content'
  scroll.append(content)
  column.append(scroll)

  const st = newPronState()
  const pronInflight = new Set<string>()
  // Bumped with every reset, which empties the cache: a lookup that lands
  // afterwards belongs to the forgotten thread and is dropped.  This half's
  // own count, so a reset of the other half drops nothing here.
  let pronEpoch = 0
  let rounds: Round[] = []
  let domRounds: Round[] = []
  let threadText = ''
  let streamItems: readonly ExplainItem[] = []
  let buffer = ''
  let firstChunkSeen = false
  let streaming = false
  let errorMsg = ''
  let inFlight: AbortController | null = null
  let deadline: ReturnType<typeof setTimeout> | null = null
  const responseMarks = new Set<string>()
  let liveRoundEl: HTMLElement | null = null
  let liveRoundCount = -1
  let dead = false

  /* ── render (comart panel.js render, reconciling) ─────────────────────── */

  const nearBottom = (): boolean => scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < STICK_PX
  const toBottom = (): void => { scroll.scrollTop = scroll.scrollHeight }

  function render(incremental = false): void {
    if (dead) return
    // Badges read the thread's first-wins pos/ipa maps: refill them first.
    refreshPronMaps(st, [...rounds.map((r) => r.text), buffer])
    const stick = nearBottom()

    // A chunk only grew the live answer: rebuild that one block, so the
    // answers above keep their nodes, marks and scroll.
    if (incremental && streaming && firstChunkSeen && liveRoundEl && liveRoundCount === rounds.length) {
      liveRoundEl.replaceChildren(renderMarkdown(visibleBuffer(buffer), st))
      wireBadges()
      if (stick) toBottom()
      return
    }

    // Reconcile, never wipe: a committed round still at its index keeps its
    // DOM (and a playing badge its `.is-playing`); only the tail is rebuilt.
    let keep = 0
    while (keep < domRounds.length && keep < rounds.length && domRounds[keep] === rounds[keep]) keep += 1
    for (const node of Array.from(content.children)) {
      if (node.classList.contains('ex-round-block')) {
        const r = Number(node.getAttribute('data-round'))
        if (Number.isInteger(r) && r < keep) continue
      }
      node.remove()
    }
    const tail: HTMLElement[] = []
    for (let i = keep; i < rounds.length; i += 1) {
      const r = rounds[i]
      if (r) tail.push(roundBlock(r.text, r.items, i, false, st))
    }
    let liveBlock: HTMLElement | null = null
    if (streaming) {
      liveBlock = roundBlock(visibleBuffer(buffer), streamItems, rounds.length, true, st)
      tail.push(liveBlock)
      if (!firstChunkSeen) tail.push(thinkingDots())
    }
    if (errorMsg) tail.push(errorLine(errorMsg))

    if (!tail.length && keep === 0) {
      content.replaceChildren()
      liveRoundEl = null
      liveRoundCount = -1
      domRounds = []
      return
    }
    content.append(...tail)
    domRounds = rounds.slice()
    refreshBadges(content, st)
    wireBadges()
    wrapResponseWords(content, responseMarks)
    liveRoundEl = streaming && firstChunkSeen && liveBlock
      ? liveBlock.querySelector<HTMLElement>('.ex-round.ex-live')
      : null
    liveRoundCount = rounds.length
    if (stick) toBottom()
  }

  /* ── pronunciations (comart wireBadges) ───────────────────────────────── */

  /** Every `.loading` badge asks `/api/pron` once.  pron-data only covers
   *  single-word picks that MW answered within the server's budget, so the
   *  row's badge races it from the first render, as in comart. */
  function wireBadges(): void {
    for (const btn of Array.from(content.querySelectorAll('.pron-badge.loading'))) {
      const key = btn.getAttribute('data-key')
      if (!key || pronInflight.has(key)) continue
      void lookUpPron(key, btn.getAttribute('data-word') ?? '', btn.getAttribute('data-pos') ?? '')
    }
  }

  async function lookUpPron(key: string, word: string, pos: string): Promise<void> {
    pronInflight.add(key)
    const epoch = pronEpoch
    let entry: PronEntry
    try {
      const r = await fetchFn(`${base}/api/pron?word=${encodeURIComponent(word)}&pos=${encodeURIComponent(pos)}`)
      if (!r.ok) {
        entry = pronFailure(r.status)
      } else {
        const data: unknown = await r.json()
        // A non-object would cache as "nothing yet" and re-fetch forever.
        entry = data && typeof data === 'object' && !Array.isArray(data)
          ? (data as PronData)
          : pronFailure(undefined)
      }
    } catch {
      // A thrown fetch has no status: MW counts as unreachable.
      entry = pronFailure(undefined)
    }
    pronInflight.delete(key)
    // Failures are cached so a re-render does not re-fetch in a loop, but
    // never over real data: the server's pron-data may have filled this key
    // while the lookup was out.
    const had = st.cache.get(key)
    if (epoch === pronEpoch && !(isPronFailure(entry) && had && !isPronFailure(had))) st.cache.set(key, entry)
    render()
  }

  /* ── drill-down marks ─────────────────────────────────────────────────── */

  function markRange(spans: readonly Element[], from: number, to: number): void {
    const a = Math.min(from, to)
    const b = Math.max(from, to)
    spans.forEach((sp, i) => {
      const on = i >= a && i <= b
      const rid = sp.getAttribute('data-rid') ?? ''
      if (on) responseMarks.add(rid)
      else responseMarks.delete(rid)
      sp.classList.toggle('is-marked', on)
    })
  }

  /** This half's marks only: a press in one half leaves the other's
   *  (comart `clearResponseMarks(t)`, panel.js:2511). */
  function clearMarks(): void {
    responseMarks.clear()
    for (const sp of Array.from(content.querySelectorAll('.ex-word.is-marked'))) sp.classList.remove('is-marked')
  }

  /* ── the request (comart triggerExplain / streamExplain / readSse) ────── */

  function abortInFlight(): void {
    // The deadline goes with its request, even one whose stream never ends.
    if (deadline !== null) {
      clearTimeout(deadline)
      deadline = null
    }
    if (!inFlight) return
    try { inFlight.abort() } catch { /* already settled */ }
    inFlight = null
  }

  function networkMessage(): string {
    let where = base
    try { where = new URL(base).host } catch { /* print the base as given */ }
    return `Can't reach ai-service. It isn't answering on ${where}.`
  }

  /** The passage is invisible in the answer and fixed for the whole thread,
   *  so every request prints what went out.  No UI for it, by design. */
  function logRequest(body: ExplainBody): void {
    const asked = body.items.map((it) => `"${it.phrase}"`).join(', ')
    const n = body.history.length
    const where = slot === 1 ? ' · right half' : ''
    console.info(`[explain] ${asked} · ${body.text.length} chars · ${n} earlier answer${n === 1 ? '' : 's'}${where}\n\n${body.text}`)
  }

  async function triggerExplain(items: readonly ExplainItem[]): Promise<void> {
    abortInFlight()
    streamItems = items
    buffer = ''
    errorMsg = ''
    firstChunkSeen = false
    streaming = true
    render()
    toBottom()

    const ctrl = new AbortController()
    inFlight = ctrl
    let late = false
    const timer = setTimeout(() => {
      late = true
      try { ctrl.abort() } catch { /* already settled */ }
    }, DEADLINE_MS)
    deadline = timer
    try {
      await streamExplain({
        text: threadText,
        items,
        history: rounds.slice(-HISTORY_ROUNDS).map((r) => r.text),
      }, ctrl)
    } catch (e) {
      if (ctrl === inFlight && !isAbort(e)) errorMsg = networkMessage()
    } finally {
      clearTimeout(timer)
      if (deadline === timer) deadline = null
      // A superseded request (new pick, drill-down, close) commits nothing.
      // The live one keeps what arrived, with the error line under it.
      if (ctrl === inFlight) {
        if (late && !errorMsg) errorMsg = TIMED_OUT
        streaming = false
        inFlight = null
        if (buffer) rounds.push({ text: buffer, items: streamItems })
        buffer = ''
        render()
      }
    }
  }

  async function streamExplain(body: ExplainBody, ctrl: AbortController): Promise<void> {
    // Before the fetch: a request that never lands is exactly when the
    // passage is worth reading.
    logRequest(body)
    let res: Response
    try {
      res = await fetchFn(`${base}/api/explain`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      })
    } catch (e) {
      if (isAbort(e)) throw e
      if (ctrl === inFlight) errorMsg = networkMessage()
      return
    }
    if (ctrl !== inFlight) return
    if (!res.ok) {
      // ai-service's refusals (403/413/415/400) are JSON `{error}`.
      let said = ''
      try {
        const j: unknown = await res.json()
        const e = j && typeof j === 'object' ? (j as { error?: unknown }).error : undefined
        if (typeof e === 'string') said = e.trim()
      } catch { /* no JSON body */ }
      if (ctrl === inFlight) {
        errorMsg = said
          ? `ai-service answered HTTP ${res.status}: ${said}`
          : `ai-service answered HTTP ${res.status}.`
      }
      return
    }
    await readSse(res, ctrl)
  }

  /** EventSource cannot POST, so the stream is parsed by hand.  Every event
   *  is `event: X` / `data: <one-line JSON>` / blank line, `done` last. */
  async function readSse(res: Response, ctrl: AbortController): Promise<void> {
    const stream = res.body
    if (stream) {
      const reader = stream.getReader()
      const dec = new TextDecoder()
      let buf = ''
      let event = ''
      let data = ''
      for (;;) {
        let chunk: Awaited<ReturnType<typeof reader.read>>
        try {
          chunk = await reader.read()
        } catch (e) {
          if (!isAbort(e)) deps.onError(e, 'explain-stream')
          break
        }
        // Superseded: whatever this read brought belongs to a thread that is
        // gone, and must not paint into the one that replaced it.
        if (ctrl !== inFlight) {
          try { await reader.cancel() } catch { /* already closed */ }
          return
        }
        if (chunk.done) break
        buf += dec.decode(chunk.value, { stream: true })
        let nl: number
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).replace(/\r$/, '')
          buf = buf.slice(nl + 1)
          if (line === '') {
            if (event === 'done') {
              try { await reader.cancel() } catch { /* already closed */ }
              return
            }
            if (event && data) handleSse(event, data)
            event = ''
            data = ''
            continue
          }
          if (line.startsWith(':')) continue
          if (line.startsWith('event:')) { event = line.slice(6).trim(); continue }
          if (line.startsWith('data:')) data += (data ? '\n' : '') + line.slice(5).trim()
        }
      }
    }
    // `done` is always the server's last event: without it the backend died
    // or restarted mid-answer.  The partial answer is kept, flagged.
    if (!ctrl.signal.aborted && !errorMsg && ctrl === inFlight) errorMsg = CUT_OFF
  }

  function handleSse(event: string, data: string): void {
    let parsed: unknown
    try { parsed = JSON.parse(data) } catch { return }
    const obj = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
    if (event === 'pron-data') {
      // Keyed `word|`: the server looked each word up without a pos.
      storePronData(st.cache, obj['prons'])
      render()
    } else if (event === 'chunk') {
      firstChunkSeen = true
      if (typeof obj['text'] === 'string') buffer += obj['text']
      render(true)
    } else if (event === 'error') {
      const m = obj['message']
      errorMsg = typeof m === 'string' && m ? m : SERVER_ERROR
      render()
    }
  }

  /* ── lifecycle ────────────────────────────────────────────────────────── */

  function reset(): void {
    abortInFlight()
    rounds = []
    domRounds = []
    threadText = ''
    streamItems = []
    buffer = ''
    firstChunkSeen = false
    streaming = false
    errorMsg = ''
    responseMarks.clear()
    liveRoundEl = null
    liveRoundCount = -1
    content.replaceChildren()
    scroll.scrollTop = 0
    // comart's cache died with its page; this renderer lives all day, and
    // the related-form bridge scans every entry, so another thread's words
    // would lend their clips.  A passing MW outage is forgotten with it.
    st.cache.clear()
    pronEpoch += 1
  }

  function start(text: string, items: readonly ExplainItem[]): void {
    if (dead) return
    reset()
    // The thread's passage: every drill-down replays it, not one about the
    // word picked in an answer.
    threadText = text
    void triggerExplain(items)
  }

  function drillFrom(round: number, words: readonly string[]): void {
    if (dead || !words.length) return
    // Picking in round k regenerates round k+1 and drops everything after,
    // so the answers stay one drill-down chain instead of a growing stack.
    if (Number.isInteger(round)) rounds = rounds.slice(0, round + 1)
    void triggerExplain([{ phrase: words.join(' '), words: [...words] }])
  }

  return {
    slot,
    column,
    scroll,
    content,
    hasContent: () => rounds.length > 0 || streaming || !!errorMsg || !!buffer,
    isFollowing: () => streaming && nearBottom(),
    toBottom,
    start,
    drillFrom,
    markRange,
    clearMarks,
    reset,
    destroy: () => {
      reset()
      dead = true
    },
  }
}
