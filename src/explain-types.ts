/**
 * src/explain-types.ts
 * Owner: 03.  Spec: CONTRACT.md §0.56 E109 — click-to-explain in the EPUB reader,
 * and §0.57 E110 — the band's two halves (comart's §3h split).
 *
 * The seam between the two halves of the feature, and nothing else:
 *   · `reader.ts` picks the word(s) in the book and assembles the passage;
 *   · `explain.ts` owns the bottom panel — it asks ai-service, streams the
 *     answer, draws the Merriam-Webster badges and handles follow-ups.
 * `main.ts` binds the shell-side values (ai-service origin, the persisted
 * height, `open_external`) and hands the reader a `MountExplain`, so the reader
 * never imports the panel and the panel never imports the reader.  Types only.
 */

/** One picked item, exactly ai-service's `/api/explain` item shape. */
export interface ExplainItem {
  /** The words joined by single spaces. */
  phrase: string
  /** One entry per word; a single-word item is what earns the MW prefetch. */
  words: string[]
}

/** A new question from the book: the passage and what was picked in it. */
export interface ExplainRequest {
  /** The passage the item(s) came from — ai-service's `text` (the SELECTION). */
  text: string
  items: ExplainItem[]
}

/** What a book pick did: it started the first thread, or it waits for a half. */
export type ExplainOutcome = 'started' | 'staged'

export interface ExplainPanel {
  /** A pick from the book.  When neither half holds anything (no round, no
   *  stream, no error line) it starts the left thread at full width and shows
   *  the panel: 'started'.  Otherwise it is STAGED: nothing is fetched until a
   *  trusted click or key on a half places it, and a newer pick replaces a
   *  staged one: 'staged'. */
  explain(req: ExplainRequest): ExplainOutcome
  /** Drop a staged pick, if there is one, spending nothing.  Never closes the
   *  panel.  True when a pick was dropped. */
  cancelStaged(): boolean
  isStaged(): boolean
  /** Hide the panel, abort both streams, drop a staged pick, forget both
   *  threads and go back to one panel.  Idempotent.  Calls
   *  `hooks.onClosed()` when it actually closed an open panel. */
  close(): void
  isOpen(): boolean
  /** The panel's root element, for the reader's outside-click containment. */
  element(): HTMLElement
  /** The host was resized: re-clamp the panel height to the space there is. */
  relayout(): void
  destroy(): void
}

/** What the READER supplies when it mounts the panel. */
export interface ExplainHooks {
  /** The panel closed (outside click, Esc, leaving the book…).  The reader
   *  clears its word mark here. */
  onClosed(): void
  /** The panel just became visible or changed height and has laid out; the
   *  reader scrolls the marked word clear of it if the band now hides it. */
  onShown(): void
  /** A staged pick was placed in a half and its request sent.  The reader's
   *  mark now belongs to that pick. */
  onPlaced(): void
}

/** What `main.ts` supplies, bound before the reader ever sees the factory. */
export interface ExplainShellDeps {
  /** ai-service origin, no trailing slash, e.g. `http://127.0.0.1:8770`. */
  base: string
  /** The persisted panel height in CSS px, or null for the default. */
  initialHeight: number | null
  /** Persist a new height (released drag or keyboard resize). */
  saveHeight(h: number): void
  /** Open an http(s) link from an answer in the system browser (command 22). */
  openExternal(url: string): Promise<void>
  onError(err: unknown, context: string): void
}

export type ExplainPanelDeps = ExplainHooks &
  ExplainShellDeps & {
    /** Test seam; defaults to the global `fetch`. */
    fetch?: typeof fetch
    /** Test seam; defaults to `(url) => new Audio(url)`. */
    audio?: (url: string) => HTMLAudioElement
  }

/** The factory `main.ts` hands to `mountReader` through `ReaderDeps`.  The
 *  panel appends its own root to `host` (the reader's `#reader` section). */
export type MountExplain = (host: HTMLElement, hooks: ExplainHooks) => ExplainPanel
