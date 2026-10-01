/**
 * src/find.ts
 * Owner: 03.  In-note find (KNOWN-ISSUES.md X-13, first bullet).
 *
 * Obsidian's Mod-F finds inside the open note; Cairn bound Mod-Shift-F (the
 * vault-wide panel, owner 05) and had no in-note find at all.  This is the
 * in-note half: a small overlay bar in `main.editor` that searches the open
 * note's live text, marks every match in the single EditorView (the marks stay
 * painted while the bar holds focus, which the editor's own selection does
 * not), selects the current match, and steps through matches with Enter /
 * Shift+Enter / Prev / Next.  Esc closes.
 *
 * Mod-F SHOWS OR FOCUSES, never closes: with the bar open and the caret in the
 * note, Mod-F puts the focus back in the field (selecting the query) instead
 * of dismissing the bar it just opened.  A closed bar keeps no query: every
 * fresh open starts empty — or from the current selection — never from the
 * previous search text.  The closes are Esc, the × button, a pointer press
 * outside the bar, and the programmatic hide on note/vault/page switches.
 *
 * SCOPE, STATED SO IT IS NOT RE-READ AS A BUG:
 *   - Plain substring only, case-insensitive unless the `Aa` toggle is on.
 *     No regex, no whole-word, no replace.  Those are features, not gaps in
 *     this one.
 *   - The bar is an OVERLAY (`position: absolute` in `main.editor`, which is
 *     `position: relative`).  It never enters flow, so G9's box rows do not
 *     move whether it is open or not.
 *
 * NO `innerHTML`, ANYWHERE (§6.1).  Every row is `createElement` +
 * `textContent`, like search.ts.  No scroll listener (§5.12.6).  No custom
 * property declaration (tokens.css owns them).
 */

export const MAX_FIND_MATCHES = 2000

export interface FindMatch {
  from: number
  to: number
}

export function findMatches(
  text: string,
  query: string,
  caseSensitive: boolean,
): { matches: FindMatch[]; truncated: boolean } {
  if (query === '') return { matches: [], truncated: false }
  const hay = caseSensitive ? text : text.toLowerCase()
  const needle = caseSensitive ? query : query.toLowerCase()
  // An empty needle after folding (cannot happen for non-empty query in
  // practice) would make `indexOf('', pos)` succeed everywhere.
  if (needle === '') return { matches: [], truncated: false }
  const matches: FindMatch[] = []
  let pos = 0
  for (;;) {
    const idx = hay.indexOf(needle, pos)
    if (idx < 0) return { matches, truncated: false }
    if (matches.length >= MAX_FIND_MATCHES) return { matches, truncated: true }
    matches.push({ from: idx, to: idx + needle.length })
    // Non-overlapping: `aa` in `aaa` is one match at 0, not two.
    pos = idx + needle.length
  }
}

export class FindModel {
  query = ''
  caseSensitive = false
  matches: FindMatch[] = []
  index = -1
  truncated = false

  recompute(text: string, query: string, caseSensitive: boolean, keepIndex?: number): void {
    this.query = query
    this.caseSensitive = caseSensitive
    if (query === '') {
      this.matches = []
      this.index = -1
      this.truncated = false
      return
    }
    const r = findMatches(text, query, caseSensitive)
    this.matches = r.matches
    this.truncated = r.truncated
    if (r.matches.length === 0) {
      this.index = -1
      return
    }
    if (keepIndex !== undefined) {
      this.index = Math.max(0, Math.min(keepIndex, r.matches.length - 1))
      return
    }
    this.index = 0
  }

  current(): FindMatch | null {
    const m = this.matches[this.index]
    return m ?? null
  }

  next(): FindMatch | null {
    if (this.matches.length === 0) return null
    this.index = (this.index + 1) % this.matches.length
    return this.current()
  }

  prev(): FindMatch | null {
    if (this.matches.length === 0) return null
    this.index = (this.index - 1 + this.matches.length) % this.matches.length
    return this.current()
  }

  countText(): string {
    if (this.query === '') return ''
    if (this.matches.length === 0) return 'No results'
    const cur = (this.index + 1).toLocaleString()
    const total = this.matches.length.toLocaleString() + (this.truncated ? '+' : '')
    return `${cur}/${total}`
  }
}

export interface FindDeps {
  /** The open note's live text, or null when no note is open (or secret mode). */
  getText(): string | null
  /** The current editor selection, for prefill. `''` when none/unsuitable. */
  getSelection(): string
  /** Select [from, to) and scroll it into view. Keeps focus where it is. */
  reveal(from: number, to: number): void
  /** Paint the mark layer (owner 03's decoration set, via `editor.ts`). The
   *  current match takes `from/to`, or -1/-1 when there is none. */
  setHighlight(query: string, caseSensitive: boolean, from: number, to: number): void
  focusEditor(): void
  /** Fired by the editor on every document change. Returns the unsubscribe. */
  onDocChanged(cb: () => void): () => void
}

export class FindPanel {
  readonly model = new FindModel()

  private readonly doc: Document
  private readonly deps: FindDeps
  private offDoc: (() => void) | null = null
  private readonly onDocDown: (e: Event) => void

  readonly root: HTMLElement
  private readonly input: HTMLInputElement
  private readonly countEl: HTMLElement
  private readonly prevBtn: HTMLButtonElement
  private readonly nextBtn: HTMLButtonElement
  private readonly caseBtn: HTMLButtonElement
  private readonly closeBtn: HTMLButtonElement

  constructor(pane: HTMLElement, deps: FindDeps) {
    this.doc = pane.ownerDocument
    this.deps = deps

    const d = this.doc
    const root = d.createElement('div')
    root.className = 'find-bar'
    root.hidden = true
    root.setAttribute('role', 'search')
    root.setAttribute('aria-label', 'Find in note')

    const input = d.createElement('input')
    input.className = 'find-input'
    input.type = 'text'
    input.spellcheck = false
    input.autocapitalize = 'off'
    input.setAttribute('autocomplete', 'off')
    input.setAttribute('aria-label', 'Find in note')
    input.placeholder = 'Find in note'

    const count = d.createElement('span')
    count.className = 'find-count'
    count.setAttribute('role', 'status')
    count.textContent = ''

    const prev = d.createElement('button')
    prev.className = 'find-btn'
    prev.type = 'button'
    prev.textContent = '↑'
    prev.setAttribute('aria-label', 'Previous match')

    const next = d.createElement('button')
    next.className = 'find-btn'
    next.type = 'button'
    next.textContent = '↓'
    next.setAttribute('aria-label', 'Next match')

    const cs = d.createElement('button')
    cs.className = 'find-btn'
    cs.type = 'button'
    cs.textContent = 'Aa'
    cs.setAttribute('aria-label', 'Case sensitive')
    cs.setAttribute('aria-pressed', 'false')

    const close = d.createElement('button')
    close.className = 'find-btn'
    close.type = 'button'
    close.textContent = '×'
    close.setAttribute('aria-label', 'Close find')

    root.append(input, count, prev, next, cs, close)
    pane.append(root)

    this.root = root
    this.input = input as HTMLInputElement
    this.countEl = count
    this.prevBtn = prev as HTMLButtonElement
    this.nextBtn = next as HTMLButtonElement
    this.caseBtn = cs as HTMLButtonElement
    this.closeBtn = close as HTMLButtonElement

    this.wire()
    this.offDoc = deps.onDocChanged(() => this.onExternalDocChanged())
    // A press outside the bar dismisses it.  `pointerdown`, not `click`: the
    // bar must be gone before the press lands, and a drag that starts outside
    // and releases inside is still an outside press.
    this.onDocDown = (e: Event) => this.onOutsideDown(e)
    this.doc.addEventListener('pointerdown', this.onDocDown)
  }

  get isOpen(): boolean {
    return !this.root.hidden
  }

  /** Show, or focus the field when already open. False = no note.
   *
   *  Re-showing never resets the match index: with the bar open and the caret
   *  in the note, Mod-F must hand the focus back without jumping the current
   *  match back to the first one. */
  show(): boolean {
    if (this.deps.getText() === null) return false
    if (this.isOpen) {
      this.input.focus()
      this.input.select()
      return true
    }
    this.root.hidden = false
    if (this.input.value === '') {
      const sel = this.deps.getSelection()
      if (sel !== '') this.input.value = sel
    }
    this.recompute(true)
    this.input.focus()
    this.input.select()
    return true
  }

  /** Hide without moving focus. The programmatic close (note switch, etc).
   *  Clears the mark layer (hidden matches are not matches) and WIPES the
   *  query: reopening always starts empty — or from the fresh selection —
   *  never from the previous search text. */
  hide(): void {
    if (!this.isOpen) return
    this.root.hidden = true
    this.input.value = ''
    const cs = this.caseBtn.getAttribute('aria-pressed') === 'true'
    this.model.recompute('', '', cs)
    this.paintCount()
    this.deps.setHighlight('', false, -1, -1)
  }

  /** The user close: hide and hand focus back to the note. */
  close(): void {
    this.hide()
    this.deps.focusEditor()
  }

  /** Mod-F: show, or focus when already open. Never closes. */
  toggle(): void {
    this.show()
  }

  destroy(): void {
    if (this.offDoc !== null) {
      this.offDoc()
      this.offDoc = null
    }
    this.doc.removeEventListener('pointerdown', this.onDocDown)
    this.deps.setHighlight('', false, -1, -1)
    this.root.remove()
  }

  private wire(): void {
    this.input.addEventListener('input', () => {
      this.recompute(true)
    })
    this.input.addEventListener('keydown', (e) => this.onKeyDown(e as KeyboardEvent))
    this.prevBtn.addEventListener('click', () => this.step(-1))
    this.nextBtn.addEventListener('click', () => this.step(1))
    this.caseBtn.addEventListener('click', () => {
      const on = this.caseBtn.getAttribute('aria-pressed') !== 'true'
      this.caseBtn.setAttribute('aria-pressed', String(on))
      this.caseBtn.classList.toggle('is-active', on)
      this.recompute(true)
    })
    this.closeBtn.addEventListener('click', () => this.close())
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.isComposing || e.keyCode === 229) return
    if (e.key === 'Escape') {
      e.preventDefault()
      this.close()
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      this.step(e.shiftKey ? -1 : 1)
    }
  }

  private step(dir: 1 | -1): void {
    const m = dir === 1 ? this.model.next() : this.model.prev()
    this.paintCount()
    this.pushHighlight()
    if (m !== null) this.deps.reveal(m.from, m.to)
  }

  private recompute(resetIndex: boolean): void {
    const text = this.deps.getText() ?? ''
    const cs = this.caseBtn.getAttribute('aria-pressed') === 'true'
    if (resetIndex) this.model.recompute(text, this.input.value, cs)
    else this.model.recompute(text, this.input.value, cs, this.model.index)
    this.paintCount()
    this.pushHighlight()
    const cur = this.model.current()
    if (resetIndex && cur !== null) this.deps.reveal(cur.from, cur.to)
  }

  /** Mirror the model into the editor's mark layer. Runs on every recompute
   *  so the marks, the count and the selection can never disagree. */
  private pushHighlight(): void {
    const cs = this.caseBtn.getAttribute('aria-pressed') === 'true'
    const cur = this.model.current()
    if (this.model.query === '' || cur === null) {
      this.deps.setHighlight(this.model.query, cs, -1, -1)
      return
    }
    this.deps.setHighlight(this.model.query, cs, cur.from, cur.to)
  }

  /** A press that starts outside the bar dismisses it — without moving focus,
   *  which belongs to wherever the press landed.  The parent chain is walked
   *  by hand rather than `contains()` so the minidom harness (no `contains`)
   *  proves the same path the browser takes. */
  private onOutsideDown(e: Event): void {
    if (!this.isOpen) return
    let n: unknown = (e as PointerEvent).target ?? null
    while (n !== null && n !== undefined) {
      if (n === this.root) return
      n = (n as { parentNode?: unknown }).parentNode ?? null
    }
    this.hide()
  }

  /** The editor changed under us (typing, reload). Update the count, keep the
   *  caret where the user put it: no reveal, index clamped, never reset. */
  private onExternalDocChanged(): void {
    if (!this.isOpen) return
    this.recompute(false)
  }

  private paintCount(): void {
    this.countEl.textContent = this.model.countText()
  }
}

export function mountFind(pane: HTMLElement, deps: FindDeps): FindPanel {
  return new FindPanel(pane, deps)
}
