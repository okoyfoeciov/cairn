/**
 * src/reader.ts
 * Owner: 03.  Spec: CONTRACT.md §0.55 E108 — the EPUB reader surface.
 *
 * THE TAKEOVER SHAPE IS MEMOIR'S, not a second editor.  This module mounts one
 * `#reader` host beside `#ed` inside `main.editor` and toggles `.is-reader` on
 * the pane, which hides the CodeMirror host while the book is up.  It owns ONE
 * rendered scroller: the book itself.  Mod-F mounts the NOTE VIEWER'S OWN
 * find bar (`find.ts`/find.css) as an overlay, never a second view and never a
 * third scroller (§5.12.4's two-scroller ceiling; the explanation band below
 * is the one exception: E109's third, and E110's fourth while it is split).
 * There is no visible search button; the shortcut is the only way in.
 *
 * CLICK-TO-EXPLAIN (§0.56 E109).  A press on a word picks it, a drag from a
 * word picks a phrase of up to 8 words inside one block, and the passage
 * around the pick goes to the explanation band `main.ts` hands over as
 * `mountExplain` (explain.ts; this file knows only its type).  There are no
 * word spans: a caret hit-test plus the word's own line boxes find the word,
 * and the CSS Highlight API paints it, so the book's DOM is never rewritten.
 * Book text is not selectable.  Links stay links: a word inside an actionable
 * link is never picked.  The band brings its own scroller while it is open.
 *
 * TWO HALVES (§0.57 E110).  A pick on a band that already holds an answer is
 * STAGED: the band asks nothing until a half is clicked, and the reader marks
 * the staged word meanwhile.  Esc drops the stage and the mark goes back to
 * the last placed word; the next Esc closes the band.
 *
 * THE MICROPHONE (§0.58 E111).  `main.ts` hands over `mountMic` on Linux only
 * (mic.ts; this file knows only its type).  The reader decides when its button
 * shows (a rendered book in read mode), discards a take whenever the book is
 * left, and stands its outside-click rule down while the transcript card is
 * open: the card's own shield closes the card, and only the next click is the
 * band's.
 *
 * NO `innerHTML` ASSIGNMENT (§6.1).  The EPUB's XHTML is parsed by `epub.ts`
 * into an inert tree, then walked through an allow-list here.  Scripts, forms,
 * embedded frames, remote images and every URL scheme except http(s)/mailto are
 * dropped before a node reaches the document.  Text lands through
 * `createTextNode`; book markup is never a string.
 *
 * The transport arrives from `main.ts` (§6.4): this file never imports
 * `ipc.ts`.  Progress leaves through `onProgress`, so `main.ts` owns the
 * per-vault bookmark map and `state.json` owns the bytes.
 */

import {
  EpubBook,
  EpubError,
  attr,
  imageSize,
  localName,
  openEpub,
  type ImageSize,
  type XmlElement,
  type XmlNode,
} from './epub'
import { findMatches, mountFind, type FindPanel } from './find'
import type { EpubBookmark } from './ipc'
import {
  MAX_WORDS,
  buildPassage,
  contextWindow,
  wordAt,
  wordsIn,
  type PassageMeta,
  type PickWord,
} from './bookpick'
import type { ExplainHooks, ExplainPanel, MountExplain } from './explain-types'
import type { MicView, MountMic } from './mic-types'

interface LoadedImage {
  url: string
  width: number
  height: number
}

export interface ReaderTransport {
  readEpub(path: string): Promise<ArrayBuffer>
  openExternal(url: string): Promise<void>
}

export interface ReaderDeps {
  transport: ReaderTransport
  /** Save one position.  `main.ts` debounces the corresponding `save_ui_state`. */
  onProgress(path: string, bookmark: EpubBookmark): void
  onError(err: unknown, context: string): void
  /** §0.56 E109: the explanation band's factory, bound by `main.ts`.  Absent,
   *  the book has no word picking at all. */
  mountExplain?: MountExplain
  /** §0.58 E111: the microphone's factory, bound by `main.ts` on Linux only. */
  mountMic?: MountMic
  /** Test seam for the two layout questions a pick asks; defaults to the
   *  engine's own.  The minidom tests have no layout. */
  probe?: ReaderProbe
}

/** A position inside one of the book's text nodes. */
export interface TextPoint {
  node: Text
  offset: number
}

export interface PickRect {
  left: number
  top: number
  right: number
  bottom: number
}

export interface ReaderProbe {
  /** The caret position under a viewport point, if any. */
  caretAt(x: number, y: number): { node: Node; offset: number } | null
  /** The line boxes of the text from `start` to `end`, in viewport px. */
  rectsOf(start: TextPoint, end: TextPoint): ArrayLike<PickRect>
}

function engineProbe(doc: Document): ReaderProbe {
  return {
    caretAt(x, y) {
      if (typeof doc.caretPositionFromPoint === 'function') {
        const pos = doc.caretPositionFromPoint(x, y)
        return pos ? { node: pos.offsetNode, offset: pos.offset } : null
      }
      const range = doc.caretRangeFromPoint?.(x, y) ?? null
      return range ? { node: range.startContainer, offset: range.startOffset } : null
    },
    rectsOf(start, end) {
      const range = doc.createRange()
      range.setStart(start.node, start.offset)
      range.setEnd(end.node, end.offset)
      return range.getClientRects()
    },
  }
}

export interface ReaderView {
  /** Load and show a book.  `false` means the read failed and the previous
   *  surface is still showing; a malformed book returns `true` and draws its
   *  own error page, because the row IS open. */
  open(path: string, position: EpubBookmark | null): Promise<boolean>
  /** Cancel an in-flight open without touching the book already showing. */
  cancelOpen(): void
  show(): void
  hide(): void
  close(): void
  reset(): void
  visible(): boolean
  path(): string | null
  /** Save now (vault switch, quit, tab change). */
  flushProgress(): void
  /** Mod-F while the reader is up; starts in the book, never the vault search. */
  toggleSearch(): void
  /** Adopt a rename/move of the open book. */
  adoptPath(path: string): void
  /** The row vanished from the tree: keep the text, stop pretending it saves. */
  lost(): void
  destroy(): void
}

/** `loading` shows neither the book nor the message: a blank pane. */
type Mode = 'read' | 'error' | 'loading'

const SAVE_DEBOUNCE_MS = 600

/* §0.56 E109.  Highlight registry names; explain.css paints them. */
const HOVER_HIGHLIGHT = 'cairn-explain-hover'
const MARK_HIGHLIGHT = 'cairn-explain-mark'
/** A link that acts on a click keeps the click: its words are never picked. */
const ACTIONABLE = 'a[data-ep-external], a[data-ep-chapter], a.ep-noteref'
/** A footnote marker: its digits are noise in a passage, and they glue onto
 *  the word before them ("lizard12") because inline boundaries add no space. */
const NOTEREF = 'a.ep-noteref'
/** Code is not prose: comart never picks it either. */
const NOT_PROSE = 'pre, code, kbd, samp, var'
/** A layer above the book owns its own clicks.  The find bar too: comart's is
 *  the browser's, which a page never sees clicked.  So do the microphone and
 *  its card layer: comart exempts its whole widget from the band's outside
 *  click. */
const LAYERS = '.ctx-menu, .nc-modal-back, .find-bar, .ep-mic, .ep-mic-layer'
/** px around a word's line boxes that still hit it; comart's chip reaches 2px
 *  past each side of the word. */
const PICK_SLOP = 2
/** comart's swallowClick window. */
const SWALLOW_MS = 250
/** Room kept between a revealed mark and the band (comart's revealMarks). */
const REVEAL_GAP = 12
const HEADING_TAG = /^H[1-6]$/i
/** comart's cap: a longer "heading" is a styled paragraph, not a title. */
const MAX_HEADING = 300

/* The sanitising allow-list.  Anything not here is either unwrapped (its text
 * survives) or dropped whole (the dangerous set below). */
const ALLOWED_TAGS = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'blockquote', 'br', 'caption', 'cite', 'code',
  'col', 'colgroup', 'dd', 'del', 'div', 'dl', 'dt', 'em', 'figcaption',
  'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd',
  'li', 'mark', 'ol', 'p', 'pre', 'q', 'rp', 'rt', 'ruby', 's', 'samp',
  'small', 'span', 'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'tfoot',
  'th', 'thead', 'tr', 'u', 'ul', 'var', 'wbr',
])

const DROP_TAGS = new Set([
  'applet', 'audio', 'base', 'button', 'canvas', 'embed', 'form', 'frame',
  'frameset', 'head', 'iframe', 'input', 'link', 'map', 'math', 'meta',
  'noembed', 'noframes', 'noscript', 'object', 'param', 'script', 'select',
  'source', 'style', 'svg', 'template', 'textarea', 'title', 'track', 'video',
])

const BLOCK_UNWRAP = new Set(['html', 'body', 'main', 'header', 'footer', 'aside', 'nav'])

/** Block-level elements for the paint run builder.  Text inside the same block
 *  is one continuous inline run even if spans split it. */
const BLOCK_FLOW = new Set([
  'address', 'article', 'aside', 'blockquote', 'dd', 'div', 'dl', 'dt',
  'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table',
  'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
])

const SAFE_ID = /[^A-Za-z0-9_.:-]/g

interface RenderContext {
  book: EpubBook
  chapter: number
  chapterHref: string
  ids: Map<string, string>
  usedIds: Set<string>
}

function isExternalUrl(href: string): boolean {
  const lower = href.trim().toLowerCase()
  return lower.startsWith('http://') || lower.startsWith('https://') || lower.startsWith('mailto:')
}

function safeNumber(value: string, min: number, max: number): number | null {
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) && n >= min && n <= max ? n : null
}

function chapterAnchor(chapter: number, fragment: string): string {
  return 'ep-c' + chapter + '-' + fragment.replace(SAFE_ID, '_')
}

export function mountReader(pane: HTMLElement, deps: ReaderDeps): ReaderView {
  const doc = pane.ownerDocument

  const root = doc.createElement('section')
  root.setAttribute('id', 'reader')
  root.className = 'ep-reader'
  root.hidden = true
  root.setAttribute('aria-label', 'EPUB reader')

  const scroller = doc.createElement('div')
  scroller.className = 'ep-scroller'
  scroller.tabIndex = 0
  const content = doc.createElement('article')
  content.className = 'ep-content'
  scroller.append(content)

  const message = doc.createElement('div')
  message.className = 'ep-message'
  message.hidden = true
  const messageTitle = doc.createElement('h1')
  messageTitle.className = 'ep-message-title'
  const messageDetail = doc.createElement('p')
  messageDetail.className = 'ep-message-detail'
  message.append(messageTitle, messageDetail)

  root.append(scroller, message)
  pane.append(root)

  /* ── state ────────────────────────────────────────────────────────────── */

  let book: EpubBook | null = null
  let bookPath: string | null = null
  let mode: Mode = 'read'
  let pendingPosition: EpubBookmark | null = null
  /** The current book's chapters are in the DOM.  Between the parse and the
   *  render (the picture preload) a book has its path but nothing on screen. */
  let rendered = false
  let objectUrls = new Map<string, LoadedImage>()
  let resourceSeq = 0
  let chapterTops: number[] = []
  let chapterHeights: number[] = []
  /** Snapshotted in `measure()`; `scrollHeight` on every scroll frame forces a
   *  layout and was part of the reader's ~30 fps scroll. */
  let measuredMaxScroll = 0
  let lastChapter = 0
  let lastOffset = 0
  let lastProgress = 0
  let restoring = false
  let frame = 0
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  /** Flattened searchable text, `\n\n` between chapters; offsets are global. */
  let bookText = ''
  let chapterStarts: number[] = []
  let chapterTexts: { text: string; runs: TextRun[] }[] = []
  let paintKey = ''
  let paintGroups: { from: number; marks: HTMLElement[] }[] = []
  let currentMark: HTMLElement | null = null
  let find: FindPanel | null = null
  /** The `from` offset last revealed by find, or null when no find is live. */
  let findTarget: number | null = null
  /** Bumped by every open/close/reset; an older open aborts after its awaits. */
  let openSeq = 0
  /** The row vanished externally: keep the text, stop pretending it saves. */
  let orphaned = false

  /* E109 pick state.  `shown` is the last pick the band started or placed;
   * `staged` is a pick waiting for a half (E110).  The mark paints
   * `staged ?? shown`, and a drag paints its own run over it until it fires.
   * The reveal follows `shown` only. */
  const probe = deps.probe ?? engineProbe(doc)
  let explain: ExplainPanel | null = null
  let mic: MicView | null = null
  let drag: Drag | null = null
  /** This click sequence (detail 1, 2, 3…) has already asked. */
  let seqPicked = false
  let shown: PickSpan | null = null
  let staged: PickSpan | null = null
  let hover: PickSpan | null = null
  let pointer: { x: number; y: number; buttons: number } | null = null
  let moveFrame = 0
  let swallowing = false
  let swallowTimer: ReturnType<typeof setTimeout> | null = null
  /** The latest left press began inside the band or a layer (onDocDown). */
  let pressKeeps = false

  function clearChildren(node: Element | HTMLElement): void {
    node.textContent = ''
  }

  function showMode(next: Mode, takeFocus = true): void {
    mode = next
    const read = next === 'read'
    scroller.hidden = !read
    message.hidden = next !== 'error'
    if (read && takeFocus) scroller.focus()
    syncMic()
  }

  /** The microphone shows over a book only: not over the blank page of an
   *  open in flight, an error page, or a replacement whose old book is gone. */
  function syncMic(): void {
    mic?.setShown(!root.hidden && mode === 'read' && rendered)
  }

  /** The mic's restoreFocus: focus goes back inside #reader, where its Esc
   *  listens (the band while it is open, else the book).  Focus already inside
   *  (the find field) stays. */
  function focusReader(): void {
    if (root.hidden || root.contains(doc.activeElement)) return
    ;(explain?.isOpen() ? explain.element() : scroller).focus({ preventScroll: true })
  }

  /* ── resources ────────────────────────────────────────────────────────── */

  async function resourceUrl(path: string): Promise<LoadedImage | null> {
    const hit = objectUrls.get(path)
    if (hit !== undefined) return hit
    if (!book) return null
    // Check the declared type BEFORE inflating: an `<img src=huge.bin>` must
    // not make the reader decompress a non-raster resource just to reject it.
    if (!/^image\/(?:png|jpe?g|gif|webp)$/i.test(book.mimeOf(path))) return null
    const seq = resourceSeq
    try {
      const resource = await book.resource(path)
      if (!resource || !/^image\/(?:png|jpe?g|gif|webp)$/i.test(resource.mime)) return null
      if (seq !== resourceSeq) return null
      const size = imageSize(resource.bytes)
      const copy = new Uint8Array(resource.bytes.length)
      copy.set(resource.bytes)
      const url = URL.createObjectURL(new Blob([copy.buffer], { type: resource.mime }))
      if (seq !== resourceSeq) {
        // The book was closed while the bytes were in flight; a URL created
        // after the revoke pass would leak for the life of the renderer.
        URL.revokeObjectURL(url)
        return null
      }
      const loaded: LoadedImage = { url, width: size?.width ?? 0, height: size?.height ?? 0 }
      objectUrls.set(path, loaded)
      return loaded
    } catch (err) {
      deps.onError(err, 'epub-resource')
      return null
    }
  }

  function revokeResources(): void {
    ++resourceSeq
    for (const loaded of objectUrls.values()) URL.revokeObjectURL(loaded.url)
    objectUrls = new Map<string, LoadedImage>()
  }

  /** Every raster image the spine actually references, resolved to its archive
   *  path.  Preloaded before the first render so each `<img>` can be given its
   *  intrinsic width/height up front: an unreserved box has no height until the
   *  bytes arrive, and a find jump made in that window lands on coordinates the
   *  later load invalidates. */
  function imagePaths(): string[] {
    if (!book) return []
    const out = new Set<string>()
    const walk = (node: XmlNode, chapterHref: string): void => {
      if (node.kind !== 'element') return
      const tag = localName(node.name)
      if (tag === 'img' || tag === 'image') {
        const raw = attr(node, 'src') || attr(node, 'href') || attr(node, 'xlink:href')
        if (raw && !/^data:/i.test(raw)) {
          const hit = book!.resolve(chapterHref, raw)
          if (hit.path && /^image\/(?:png|jpe?g|gif|webp)$/i.test(book!.mimeOf(hit.path))) {
            out.add(hit.path)
          }
        }
      }
      for (const child of node.children) walk(child, chapterHref)
    }
    for (const chapter of book.chapters) walk(chapter.body, chapter.href)
    return [...out]
  }

  async function preloadImages(): Promise<void> {
    for (const path of imagePaths()) await resourceUrl(path)
  }

  /* ── the sanitising renderer ───────────────────────────────────────────── */

  function nameId(ctx: RenderContext, raw: string): string {
    const clean = raw.replace(SAFE_ID, '_').slice(0, 180)
    if (!clean) return chapterAnchor(ctx.chapter, '')
    const first = chapterAnchor(ctx.chapter, clean)
    let out = first
    let n = 2
    while (ctx.usedIds.has(out)) {
      out = first + '-' + n
      n++
    }
    ctx.usedIds.add(out)
    ctx.ids.set(raw, out)
    return out
  }

  function appendNode(ctx: RenderContext, node: XmlNode, parent: Node): void {
    if (node.kind === 'text') {
      parent.appendChild(doc.createTextNode(node.text))
      return
    }
    const tag = localName(node.name)
    // A cover/illustration SVG is common; keep the image it wraps, never the
    // SVG element itself (and never its scripts or foreignObject children).
    if (tag === 'svg') {
      const image = findImage(node)
      if (image) {
        const img = renderImage(ctx, image)
        if (img) parent.appendChild(img)
      }
      return
    }
    if (DROP_TAGS.has(tag)) return
    if (tag === 'image') {
      const img = renderImage(ctx, node)
      if (img) parent.appendChild(img)
      return
    }
    if (!ALLOWED_TAGS.has(tag)) {
      if (BLOCK_UNWRAP.has(tag) || !DROP_TAGS.has(tag)) {
        // The wrapper itself is dropped, but an id on it is a real link target
        // (footnotes often live on `<aside id=...>`).  Keep an empty marker.
        if (attr(node, 'id')) {
          const marker = doc.createElement('span')
          marker.setAttribute('id', nameId(ctx, attr(node, 'id')))
          parent.appendChild(marker)
        }
        for (const child of node.children) appendNode(ctx, child, parent)
      }
      return
    }

    if (tag === 'a') {
      const anchor = doc.createElement('a')
      const href = attr(node, 'href').trim()
      const rawTarget = attr(node, 'name')
      let linked = false
      if (href.startsWith('#')) {
        const raw = href.slice(1)
        let decoded = raw
        try { decoded = decodeURIComponent(raw) } catch {}
        const target = ctx.ids.get(raw) ?? ctx.ids.get(decoded) ?? safeFragment(ctx.chapter, decoded)
        anchor.setAttribute('href', '#' + target)
        anchor.setAttribute('data-ep-chapter', String(ctx.chapter))
        anchor.setAttribute('data-ep-target-id', target)
        linked = true
      } else if (isExternalUrl(href)) {
        anchor.setAttribute('href', href)
        anchor.setAttribute('data-ep-external', href)
        anchor.setAttribute('rel', 'noreferrer noopener')
        linked = true
      } else if (href) {
        const r = ctx.book.resolve(ctx.chapterHref, href)
        const target = ctx.book.chapterFor(r.path)
        if (target >= 0) {
          const frag = r.fragment ? safeFragment(target, r.fragment) : ''
          const targetId = frag || 'ep-chapter-' + target
          anchor.setAttribute('href', '#' + targetId)
          anchor.setAttribute('data-ep-chapter', String(target))
          anchor.setAttribute('data-ep-target-id', targetId)
          if (r.fragment) anchor.setAttribute('data-ep-fragment', r.fragment)
          linked = true
        }
      }
      if (linked) {
        copyCommon(ctx, node, anchor)
        if (attr(node, 'type').includes('noteref')) anchor.className = 'ep-noteref'
        for (const child of node.children) appendNode(ctx, child, anchor)
        parent.appendChild(anchor)
      } else if (rawTarget || attr(node, 'id')) {
        // An unlinked `<a name=...>`/`<a id=...>` is still a footnote target.
        const marker = doc.createElement('span')
        copyCommon(ctx, node, marker)
        for (const child of node.children) appendNode(ctx, child, marker)
        parent.appendChild(marker)
      } else {
        // A `javascript:` href or a target that is not in the spine keeps its
        // text but not the underline: a link that cannot act must not look
        // like one.
        for (const child of node.children) appendNode(ctx, child, parent)
      }
      return
    }

    if (tag === 'img') {
      const img = renderImage(ctx, node)
      if (img) parent.appendChild(img)
      return
    }

    const element = doc.createElement(tag)
    copyCommon(ctx, node, element)
    if (tag === 'ol') {
      const start = safeNumber(attr(node, 'start'), -1_000_000, 1_000_000)
      if (start !== null) element.setAttribute('start', String(start))
      if (node.attrs.has('reversed')) element.setAttribute('reversed', '')
    }
    if (tag === 'li') {
      const value = safeNumber(attr(node, 'value'), -1_000_000, 1_000_000)
      if (value !== null) element.setAttribute('value', String(value))
    }
    if (tag === 'td' || tag === 'th') {
      const span = safeNumber(attr(node, 'colspan'), 1, 1000)
      if (span !== null) element.setAttribute('colspan', String(span))
      const rows = safeNumber(attr(node, 'rowspan'), 1, 1000)
      if (rows !== null) element.setAttribute('rowspan', String(rows))
      const scope = attr(node, 'scope')
      if (scope === 'row' || scope === 'col' || scope === 'rowgroup' || scope === 'colgroup') {
        element.setAttribute('scope', scope)
      }
    }
    if (tag === 'br' || tag === 'hr' || tag === 'wbr' || tag === 'col') {
      parent.appendChild(element)
      return
    }
    for (const child of node.children) appendNode(ctx, child, element)
    parent.appendChild(element)
  }

  function copyCommon(ctx: RenderContext, node: XmlElement, element: HTMLElement): void {
    const id = attr(node, 'id') || (localName(node.name) === 'a' ? attr(node, 'name') : '')
    if (id) element.setAttribute('id', nameId(ctx, id))
    const title = attr(node, 'title')
    if (title) element.setAttribute('title', title)
    const lang = attr(node, 'lang') || attr(node, 'xml:lang')
    if (lang) element.setAttribute('lang', lang)
    const dir = attr(node, 'dir')
    if (dir === 'ltr' || dir === 'rtl') element.setAttribute('dir', dir)
  }

  function applyImageSize(img: HTMLImageElement, size: ImageSize | null): void {
    if (!size || size.width <= 0 || size.height <= 0) return
    img.setAttribute('width', String(size.width))
    img.setAttribute('height', String(size.height))
  }

  function dataUrlSize(raw: string): ImageSize | null {
    // Header parsing only; do not synchronously decode an arbitrarily large
    // inline image just to reserve its box.
    if (raw.length > 16 * 1024 * 1024) return null
    try {
      const comma = raw.indexOf(',')
      if (comma < 0) return null
      const binary = atob(raw.slice(comma + 1))
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      return imageSize(bytes)
    } catch {
      return null
    }
  }

  function renderImage(ctx: RenderContext, node: XmlElement): HTMLImageElement | null {
    const raw = attr(node, 'src') || attr(node, 'href') || attr(node, 'xlink:href')
    if (!raw) return null
    const img = doc.createElement('img')
    const alt = attr(node, 'alt')
    img.setAttribute('alt', alt)
    // No `loading="lazy"`: a deferred image has no intrinsic height until it
    // arrives, so a search jump could land on coordinates that the later load
    // invalidates.  The book is a local, already-in-memory file; eager images
    // keep scroll geometry honest.
    img.setAttribute('decoding', 'async')
    const title = attr(node, 'title')
    if (title) img.setAttribute('title', title)
    // Raster data URLs only.  `data:image/svg+xml` is a document, not a
    // picture, and an <img> must not become a second, unsanitised renderer.
    if (/^data:image\/(?:png|jpe?g|gif|webp);base64,/i.test(raw)) {
      applyImageSize(img, dataUrlSize(raw))
      img.setAttribute('src', raw)
      return img
    }
    const r = ctx.book.resolve(ctx.chapterHref, raw)
    if (!r.path) return null
    // `preloadImages()` has normally filled this already, so the box is
    // reserved synchronously; the promise path is for a resource outside the
    // spine walk (or a warm-cache miss).
    const cached = objectUrls.get(r.path)
    if (cached) {
      applyImageSize(img, cached)
      img.setAttribute('src', cached.url)
      return img
    }
    void resourceUrl(r.path).then((loaded) => {
      if (!loaded || !img.parentNode) return
      applyImageSize(img, loaded)
      img.setAttribute('src', loaded.url)
    })
    return img
  }

  function findImage(node: XmlElement): XmlElement | null {
    if (localName(node.name) === 'image') return node
    for (const child of node.children) {
      if (child.kind === 'element') {
        const hit = findImage(child)
        if (hit) return hit
      }
    }
    return null
  }

  function safeFragment(chapter: number, raw: string): string {
    return chapterAnchor(chapter, raw.replace(SAFE_ID, '_').slice(0, 180))
  }

  function renderBook(): void {
    clearChildren(content)
    chapterTops = []
    chapterHeights = []
    measuredMaxScroll = 0
    lastChapter = 0
    lastOffset = 0
    lastProgress = 0
    if (!book) return
    for (const chapter of book.chapters) {
      const section = doc.createElement('section')
      section.className = 'ep-chapter'
      section.setAttribute('id', 'ep-chapter-' + chapter.index)
      section.setAttribute('data-ep-href', chapter.href)
      if (chapter.dir) section.setAttribute('dir', chapter.dir)
      if (chapter.lang) section.setAttribute('lang', chapter.lang)
      const ctx: RenderContext = {
        book,
        chapter: chapter.index,
        chapterHref: chapter.href,
        ids: new Map<string, string>(),
        usedIds: new Set<string>(),
      }
      for (const child of chapter.body.children) appendNode(ctx, child, section)
      content.appendChild(section)
    }
  }

  /* ── position ─────────────────────────────────────────────────────────── */

  function measure(): void {
    // A hidden reader has no layout; measuring it collapses every chapter to
    // the same top and silently zeroes the bookmark on the next save.
    if (root.hidden || scroller.clientHeight === 0) return
    chapterTops = []
    chapterHeights = []
    const base = scroller.getBoundingClientRect().top - scroller.scrollTop
    for (const section of content.querySelectorAll<HTMLElement>('.ep-chapter')) {
      const rect = section.getBoundingClientRect()
      chapterTops.push(rect.top - base)
      chapterHeights.push(rect.height)
    }
    measuredMaxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
  }

  function maxScroll(): number {
    return measuredMaxScroll
  }

  function chapterAt(top: number): number {
    if (chapterTops.length === 0) return 0
    let lo = 0
    let hi = chapterTops.length - 1
    let ans = 0
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (chapterTops[mid]! <= top + 8) {
        ans = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    return ans
  }

  function readPosition(): EpubBookmark | null {
    if (!book || chapterTops.length !== book.chapters.length) return null
    const top = scroller.scrollTop
    const chapter = chapterAt(top)
    const start = chapterTops[chapter] ?? 0
    const height = Math.max(1, chapterHeights[chapter] ?? 1)
    const offset = Math.max(0, Math.min(1, (top - start) / height))
    const progress = maxScroll() > 0 ? Math.max(0, Math.min(1, top / maxScroll())) : 0
    return {
      chapter,
      href: book.chapters[chapter]?.href ?? '',
      offset,
      progress,
    }
  }

  function updateFromScroll(): void {
    if (!book || restoring || concealed()) return
    const pos = readPosition()
    if (!pos) return
    lastChapter = pos.chapter
    lastOffset = pos.offset
    lastProgress = pos.progress
    if (saveTimer !== null) clearTimeout(saveTimer)
    saveTimer = setTimeout(saveProgress, SAVE_DEBOUNCE_MS)
  }

  function saveProgress(): void {
    if (saveTimer !== null) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    // `hide()` and `close()` call this BEFORE the box goes away, so a visible
    // reader is the only one with a measurable position.  A concealed render
    // is not at its bookmark yet, and the stored one is still right.
    if (!bookPath || !book || orphaned || root.hidden || scroller.clientHeight === 0 || concealed()) return
    const pos = readPosition()
    if (!pos) return
    lastChapter = pos.chapter
    lastOffset = pos.offset
    lastProgress = pos.progress
    deps.onProgress(bookPath, pos)
  }

  function scrollToPosition(pos: EpubBookmark): void {
    if (!book) return
    const byHref =
      pos.href === '' ? -1 : book.chapters.findIndex((c) => c.href === pos.href)
    const valid = Number.isInteger(pos.chapter) && pos.chapter >= 0 && pos.chapter < book.chapters.length
    let chapter = valid ? pos.chapter : 0
    let useProgress = false
    if (byHref >= 0) {
      // The file was replaced and the spine moved: the href is the stable
      // identity, even when the old index still happens to be in range.
      chapter = byHref
    } else if (!valid) {
      useProgress = true
    }
    const start = chapterTops[chapter] ?? 0
    const height = chapterHeights[chapter] ?? 0
    const offset = Number.isFinite(pos.offset) ? Math.max(0, Math.min(1, pos.offset)) : 0
    const fallback = Number.isFinite(pos.progress) ? Math.max(0, Math.min(1, pos.progress)) : 0
    if (useProgress || height <= 0) {
      scroller.scrollTop = fallback * maxScroll()
    } else {
      scroller.scrollTop = start + offset * height
    }
    lastChapter = chapter
    lastOffset = offset
    lastProgress = maxScroll() > 0 ? scroller.scrollTop / maxScroll() : 0
  }

  function restore(pos: EpubBookmark | null): void {
    restoring = true
    measure()
    if (pos) scrollToPosition(pos)
    else {
      scroller.scrollTop = 0
      lastChapter = 0
      lastOffset = 0
      lastProgress = 0
    }
    requestAnimationFrame(() => {
      restoring = false
      updateFromScroll()
    })
  }

  /* A fresh render is laid out but not painted (`.ep-restoring`) until its
   * first restore has scrolled it to its bookmark, so no frame shows the top
   * of the book on the way to where the reader left off.  Laid out, because
   * a scroller with no box can be neither measured nor scrolled. */
  function concealed(): boolean {
    return scroller.classList.contains('ep-restoring')
  }

  /** Scroll a concealed render to its bookmark, then let it paint.  A hidden
   *  reader has no layout to scroll; the way back to it reveals it instead
   *  (a reopen of the same book, which is main.ts's way, or `show()`). */
  function reveal(): void {
    if (!concealed() || !book || root.hidden) return
    restore(pendingPosition)
    scroller.classList.remove('ep-restoring')
  }

  function goToId(id: string): void {
    if (!book) return
    showMode('read')
    measure()
    const target = content.querySelector<HTMLElement>('[id="' + id + '"]')
    if (target) {
      const base = scroller.getBoundingClientRect().top - scroller.scrollTop
      scroller.scrollTop = Math.max(0, target.getBoundingClientRect().top - base)
      updateFromScroll()
    }
    scroller.focus()
  }

  function goTo(
    chapter: number,
    fragment = '',
    at: number | null = null,
    takeFocus = true
  ): void {
    if (!book) return
    showMode('read', takeFocus)
    measure()
    const target = Math.max(0, Math.min(book.chapters.length - 1, chapter))
    const start = chapterTops[target] ?? 0
    const height = chapterHeights[target] ?? 0
    let top = start
    if (at !== null && at >= 0) {
      const text = book.chapters[target]?.text ?? ''
      const ratio = text.length > 0 ? at / text.length : 0
      top = start + Math.max(0, Math.min(1, ratio)) * height
    } else if (fragment) {
      const anchor = content.querySelector<HTMLElement>(
        '[id="' + safeFragment(target, fragment) + '"]'
      )
      if (anchor) {
        const base = scroller.getBoundingClientRect().top - scroller.scrollTop
        top = anchor.getBoundingClientRect().top - base
      }
    }
    scroller.scrollTop = Math.max(0, top)
    updateFromScroll()
    if (takeFocus) scroller.focus()
  }

  /* ── find ─────────────────────────────────────────────────────────────── */

  /** The search projection is the RENDERED DOM, not the XML text.  Both the
   *  count (`bookText`) and the marks then come from one string with one set of
   *  offsets, so a query cannot match in one and vanish in the other. */
  function buildSearchIndex(): void {
    chapterStarts = []
    chapterTexts = []
    const parts: string[] = []
    let at = 0
    for (const section of content.querySelectorAll<HTMLElement>('.ep-chapter')) {
      const ct = chapterText(section)
      chapterTexts.push(ct)
      chapterStarts.push(at)
      parts.push(ct.text)
      at += ct.text.length + 2
    }
    bookText = parts.join('\n\n')
  }

  function chapterForOffset(at: number): number {
    if (chapterStarts.length === 0) return 0
    let lo = 0
    let hi = chapterStarts.length - 1
    let ans = 0
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (chapterStarts[mid]! <= at) {
        ans = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    return ans
  }

  function clearMarks(): void {
    currentMark = null
    paintKey = ''
    paintGroups = []
    const marks = content.querySelectorAll<HTMLElement>('mark.cm-find-match')
    if (marks.length > 0) dropPickHighlights()
    for (const mark of marks) {
      const text = doc.createTextNode(mark.textContent)
      try {
        mark.replaceWith(text)
      } catch {
        mark.remove()
      }
    }
  }

  interface TextRun {
    node: Text
    /** Offset of this run's first normalized character in the chapter text. */
    start: number
    end: number
    /** normalized-local index -> raw index in `node.data`. */
    map: number[]
  }

  /** Normalize a section exactly the way the reader will search it: collapse
   *  whitespace, insert a non-searchable separator at block boundaries and
   *  `<br>`, and keep a map from every normalized character back to its text
   *  node offset.  The chapter string and the paint ranges are the same bytes. */
  function chapterText(section: HTMLElement): { text: string; runs: TextRun[] } {
    let text = ''
    const runs: TextRun[] = []
    const sep = (): void => {
      if (text.length > 0 && !text.endsWith('\n')) text += '\n'
    }
    const add = (node: Text): void => {
      const raw = node.data
      if (raw === '') return
      let norm = ''
      const map: number[] = []
      let i = 0
      while (i < raw.length) {
        if (/\s/.test(raw[i]!)) {
          const at = i
          while (i < raw.length && /\s/.test(raw[i]!)) i++
          norm += ' '
          map.push(at)
        } else {
          norm += raw[i]
          map.push(i)
          i++
        }
      }
      if (norm === '') return
      const at = text.length
      text += norm
      runs.push({ node, start: at, end: text.length, map })
    }
    const walk = (node: Node): void => {
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === 3) add(child as Text)
        else if (child.nodeType === 1) {
          const el = child as Element
          const tag = el.tagName.toLowerCase()
          if (tag === 'br') {
            sep()
            continue
          }
          const block = BLOCK_FLOW.has(tag)
          if (block) sep()
          walk(el)
          if (block) sep()
        }
      }
    }
    walk(section)
    let lead = 0
    while (lead < text.length && text[lead] === '\n') lead++
    if (lead > 0) {
      text = text.slice(lead)
      for (const run of runs) {
        run.start -= lead
        run.end -= lead
      }
    }
    while (text.endsWith('\n')) text = text.slice(0, -1)
    return { text, runs }
  }

  /** Wrap one occurrence, one segment per text node.  Segments are processed
   *  right-to-left so earlier offsets stay valid as nodes split. */
  function wrapOccurrence(
    runs: TextRun[],
    from: number,
    to: number
  ): HTMLElement[] {
    const marks: HTMLElement[] = []
    for (let i = runs.length - 1; i >= 0; i--) {
      const run = runs[i]!
      if (run.end <= from) break
      if (run.start >= to) continue
      const node = run.node
      if (!node.parentNode) continue
      const normStart = Math.max(0, from - run.start)
      const normEnd = Math.min(run.map.length, to - run.start)
      if (normEnd <= normStart) continue
      const rawStart = run.map[normStart] ?? node.data.length
      const rawEnd =
        normEnd < run.map.length ? run.map[normEnd]! : node.data.length
      if (rawEnd <= rawStart) continue
      try {
        const mid = rawStart === 0 ? node : node.splitText(rawStart)
        if (rawEnd < node.data.length) mid.splitText(rawEnd - rawStart)
        const mark = doc.createElement('mark')
        mark.className = 'cm-find-match'
        mid.replaceWith(mark)
        mark.appendChild(mid)
        marks.unshift(mark)
      } catch {
        /* a detached node: the other segments still paint */
      }
    }
    return marks
  }

  /** Paint every match in one chapter with the note viewer's own mark classes,
   *  and strengthen the one at `localFrom` (the FindModel's current match). */
  function paintMarks(
    chapter: number,
    rawQuery: string,
    caseSensitive: boolean,
    localFrom: number
  ): void {
    if (rawQuery === '') {
      clearMarks()
      return
    }
    const key = chapter + '\u0000' + rawQuery + '\u0000' + String(caseSensitive)
    let painted = paintGroups
    if (key !== paintKey) {
      clearMarks()
      dropPickHighlights()
      const section =
        content.querySelector<HTMLElement>('[id="ep-chapter-' + chapter + '"]') ??
        content.querySelectorAll<HTMLElement>('.ep-chapter')[chapter] ??
        null
      if (section) {
        // Marks split text nodes.  Clear them, merge the pieces, and rebuild
        // THIS chapter's normalized index so its node references are live.
        section.normalize?.()
        chapterTexts[chapter] = chapterText(section)
      }
      const ct = chapterTexts[chapter]
      if (!ct) return
      const found = findMatches(ct.text, rawQuery, caseSensitive).matches
      const groups: HTMLElement[][] = new Array(found.length)
      for (let i = found.length - 1; i >= 0; i--) {
        groups[i] = wrapOccurrence(ct.runs, found[i]!.from, found[i]!.to)
      }
      painted = []
      for (let i = 0; i < groups.length; i++) {
        if (groups[i]!.length > 0) painted.push({ from: found[i]!.from, marks: groups[i]! })
      }
      paintKey = key
      paintGroups = painted
    }
    if (painted.length === 0) return
    for (const group of painted) {
      for (const mark of group.marks) mark.classList.remove('cm-find-current')
    }
    // The model and the paint use the same normalized string, so the exact
    // `from` is normally present.  If a case fold or an edited DOM broke that,
    // take the nearest painted match rather than nothing.
    let pick = painted.find((p) => p.from === localFrom)
    if (!pick) {
      let best = 0
      let distance = Number.MAX_SAFE_INTEGER
      for (let i = 0; i < painted.length; i++) {
        const d = Math.abs(painted[i]!.from - localFrom)
        if (d < distance) {
          distance = d
          best = i
        }
      }
      pick = painted[best]!
    }
    for (const mark of pick!.marks) mark.classList.add('cm-find-current')
    currentMark = pick!.marks[0] ?? null
  }

  function setFindHighlight(
    query: string,
    caseSensitive: boolean,
    from: number,
    _to: number
  ): void {
    if (!book || query === '' || from < 0) {
      clearMarks()
      return
    }
    const chapter = chapterForOffset(from)
    paintMarks(chapter, query, caseSensitive, from - (chapterStarts[chapter] ?? 0))
  }

  /** Set the scroller so the current mark is vertically centred.  Returns
   *  false when there is no painted mark to measure. */
  function centerOnMark(): boolean {
    if (!currentMark || !content.contains(currentMark)) return false
    const mark = currentMark.getBoundingClientRect()
    const box = scroller.getBoundingClientRect()
    const top =
      scroller.scrollTop + (mark.top - box.top) - (scroller.clientHeight - mark.height) / 2
    scroller.scrollTop = Math.max(0, top)
    return true
  }

  /** Re-centre after LATE LAYOUT.  Lazy images (and a font or a window resize)
   *  can change the height above the mark after the reveal has run; the match
   *  then sits at the bottom of the viewport instead of the middle.  Called
   *  from the image-load and resize paths only while the find bar is open. */
  function recenterFind(): void {
    if (findTarget === null || !find?.isOpen) return
    if (!centerOnMark()) return
    updateFromScroll()
  }

  /** Centre the current match explicitly.  `scrollIntoView` is not used: it
   *  was a no-op in one real session, which left every match in the chapter
   *  that holds the cover parked on the cover, while the first match in the
   *  NEXT spine file appeared to work only because moving chapters scrolled to
   *  that file's top.  Setting `scrollTop` from the mark's measured rect is
   *  deterministic and does not depend on the browser choosing the scroller. */
  function revealFind(from: number, _to: number): void {
    if (!book) return
    showMode('read', false)
    findTarget = from
    if (!centerOnMark()) {
      // No painted mark (a shim, or text the renderer had to drop): fall back
      // to the match's proportional position in its chapter, never the top.
      const chapter = chapterForOffset(from)
      const text = chapterTexts[chapter]?.text ?? ''
      const local = Math.max(0, from - (chapterStarts[chapter] ?? 0))
      const ratio = text.length > 0 ? Math.min(1, local / text.length) : 0
      measure()
      const start = chapterTops[chapter] ?? 0
      const height = chapterHeights[chapter] ?? 0
      scroller.scrollTop = Math.max(0, start + ratio * height)
    }
    updateFromScroll()
    // The mark's box can still settle after this frame; one more pass is
    // cheap and idempotent.  Image loads later than that use the load path.
    requestAnimationFrame(() => recenterFind())
  }

  function findSelection(): string {
    try {
      const sel = root.ownerDocument.defaultView?.getSelection?.()
      const text = sel?.toString().trim() ?? ''
      return text.length > 200 ? '' : text
    } catch {
      return ''
    }
  }

  /* ── click-to-explain (§0.56 E109) ────────────────────────────────────── */

  interface PickSpan {
    start: TextPoint
    end: TextPoint
  }

  /** A pickable word under the pointer, in its block's own text. */
  interface Hit {
    block: HTMLElement
    section: HTMLElement
    ct: { text: string; runs: TextRun[] }
    /** `ct.text` with actionable links blanked: the words a pick may take. */
    text: string
    word: PickWord
    span: PickSpan
  }

  interface Drag {
    block: HTMLElement
    section: HTMLElement
    runs: TextRun[]
    text: string
    /** `ct.text` with only footnote markers blanked.  Where it differs from
     *  `text` a link sits, and a phrase cannot run through a link: its words
     *  were never picked, so the phrase would have a hole in it. */
    crossable: string
    words: PickWord[]
    anchor: number
    current: number
    /** False for the second press of a double-click: same gesture, no new ask. */
    fire: boolean
  }

  function paintHighlight(name: string, span: PickSpan | null): void {
    if (typeof CSS === 'undefined' || !CSS.highlights) return
    let range: Range | null = null
    if (span && typeof Highlight === 'function' && typeof doc.createRange === 'function') {
      try {
        range = doc.createRange()
        range.setStart(span.start.node, span.start.offset)
        range.setEnd(span.end.node, span.end.offset)
      } catch {
        range = null
      }
    }
    if (range) CSS.highlights.set(name, new Highlight(range))
    else CSS.highlights.delete(name)
  }

  function sameSpan(a: PickSpan | null, b: PickSpan | null): boolean {
    if (a === null || b === null) return a === b
    return (
      a.start.node === b.start.node &&
      a.start.offset === b.start.offset &&
      a.end.node === b.end.node &&
      a.end.offset === b.end.offset
    )
  }

  function setHover(span: PickSpan | null): void {
    content.classList.toggle('ex-over-word', span !== null)
    if (sameSpan(hover, span)) return
    hover = span
    paintHighlight(HOVER_HIGHLIGHT, span)
  }

  /** Find is about to split or re-join text nodes, and a Range into them would
   *  paint the wrong text.  The band keeps its answer and its staged pick. */
  function dropPickHighlights(): void {
    drag = null
    shown = null
    staged = null
    setHover(null)
    paintHighlight(MARK_HIGHLIGHT, null)
  }

  function closeExplain(): void {
    explain?.close()
    dropPickHighlights()
  }

  /** The nearest block at or above `el`, never above its chapter. */
  function blockOf(el: HTMLElement, section: HTMLElement): HTMLElement {
    for (let n: HTMLElement | null = el; n && n !== section; n = n.parentElement) {
      if (BLOCK_FLOW.has(n.tagName.toLowerCase())) return n
    }
    return section
  }

  /** `ct.text` with every character inside a `selector` element made a space.
   *  Same length, so the runs' offsets still hold. */
  function blankOut(ct: { text: string; runs: TextRun[] }, selector: string): string {
    let out = ''
    let at = 0
    for (const run of ct.runs) {
      if (!run.node.parentElement?.closest(selector)) continue
      out += ct.text.slice(at, run.start) + ' '.repeat(run.end - run.start)
      at = run.end
    }
    return out + ct.text.slice(at)
  }

  /** Normalized offset of raw offset `raw` in `run`: the last character that
   *  starts at or before it. */
  function runIndex(run: TextRun, raw: number): number {
    let k = 0
    while (k + 1 < run.map.length && run.map[k + 1]! <= raw) k++
    return run.start + k
  }

  /** The DOM endpoints of `[from, to)` in a chapterText string. */
  function spanOf(runs: TextRun[], from: number, to: number): PickSpan | null {
    const a = runs.find((r) => r.start <= from && from < r.end)
    const b = runs.find((r) => r.start < to && to <= r.end)
    const start = a?.map[from - a.start]
    const last = b?.map[to - 1 - b.start]
    if (!a || !b || start === undefined || last === undefined) return null
    return { start: { node: a.node, offset: start }, end: { node: b.node, offset: last + 1 } }
  }

  function covers(span: PickSpan, x: number, y: number): boolean {
    let rects: ArrayLike<PickRect>
    try {
      rects = probe.rectsOf(span.start, span.end)
    } catch {
      return false
    }
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i]!
      if (
        x >= r.left - PICK_SLOP && x <= r.right + PICK_SLOP &&
        y >= r.top - PICK_SLOP && y <= r.bottom + PICK_SLOP
      ) return true
    }
    return false
  }

  /** The pickable word under a viewport point.  The caret alone is not enough:
   *  in a margin or past a line's end it still snaps to the nearest text, so
   *  the word's own line boxes must hold the point. */
  function wordUnder(x: number, y: number): Hit | null {
    let caret: { node: Node; offset: number } | null
    try {
      caret = probe.caretAt(x, y)
    } catch {
      return null
    }
    if (!caret || caret.node.nodeType !== 3 || !content.contains(caret.node)) return null
    const node = caret.node as Text
    const parent = node.parentElement
    if (!parent || parent.closest(ACTIONABLE) || parent.closest(NOT_PROSE)) return null
    const section = parent.closest<HTMLElement>('.ep-chapter')
    if (!section) return null
    const block = blockOf(parent, section)
    const ct = chapterText(block)
    const run = ct.runs.find((r) => r.node === node)
    if (!run) return null
    const text = blankOut(ct, ACTIONABLE)
    const at = runIndex(run, caret.offset)
    // On a glyph's right half the caret sits AFTER it, so the word ending
    // there is the second candidate.
    for (const i of [at, at - 1]) {
      const word = wordAt(text, i)
      if (!word) continue
      const span = spanOf(ct.runs, word.from, word.to)
      if (span && covers(span, x, y)) return { block, section, ct, text, word, span }
    }
    return null
  }

  function canPick(): boolean {
    return explain !== null && book !== null && mode === 'read' && !root.hidden
  }

  /** comart's article gesture: the press marks the word, a drag extends it,
   *  the release asks.  A press anywhere else stays the page's own. */
  function onContentDown(ev: Event): void {
    const e = ev as MouseEvent
    if (!e.isTrusted || e.button !== 0 || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return
    // A new click sequence; a double-click's second press only repeats a
    // press that picked, so a re-click after a miss still asks.
    if (e.detail < 2) seqPicked = false
    if (!canPick()) return
    // The card's shield takes such a press anyway; this holds it without
    // layout.  Not in canPick(): the band's reveal still follows its mark.
    if (mic?.cardOpen()) return
    const hit = wordUnder(e.clientX, e.clientY)
    if (!hit) return
    // No native selection and no focus move; the book keeps the keyboard.
    e.preventDefault()
    scroller.focus({ preventScroll: true })
    setHover(null)
    // A hover sample flushed with this press still says buttons 0; its frame
    // must not read it as a release.
    pointer = { x: e.clientX, y: e.clientY, buttons: e.buttons | 1 }
    const words = wordsIn(hit.text)
    const anchor = words.findIndex((w) => w.from === hit.word.from)
    if (anchor < 0) return
    const asks = !seqPicked
    seqPicked = true
    drag = {
      block: hit.block,
      section: hit.section,
      runs: hit.ct.runs,
      text: hit.text,
      crossable: blankOut(hit.ct, NOTEREF),
      words,
      anchor,
      current: anchor,
      fire: asks,
    }
    if (drag.fire) paintHighlight(MARK_HIGHLIGHT, hit.span)
  }

  function onPointerMove(ev: Event): void {
    const e = ev as MouseEvent
    pointer = { x: e.clientX, y: e.clientY, buttons: e.buttons }
    if (moveFrame !== 0) return
    moveFrame = requestAnimationFrame(() => {
      if (moveFrame === 0) return
      moveFrame = 0
      applyMove()
    })
  }

  function onPointerLeave(): void {
    pointer = null
    setHover(null)
  }

  function applyMove(): void {
    const p = pointer
    if (!p || !canPick()) return
    if (drag) {
      // The release never arrived (comart drops the drag); the mark goes back
      // to the staged pick, or else to what the band shows.
      if (p.buttons === 0) {
        drag = null
        paintHighlight(MARK_HIGHLIGHT, staged ?? shown)
        return
      }
      extendDrag(p.x, p.y)
      return
    }
    setHover(wordUnder(p.x, p.y)?.span ?? null)
  }

  function extendDrag(x: number, y: number): void {
    const d = drag
    if (!d || !d.fire) return
    const hit = wordUnder(x, y)
    if (!hit || hit.block !== d.block) return
    let i = d.words.findIndex((w) => w.from === hit.word.from)
    if (i < 0) return
    // comart's ±7 clamp: a drag picks a phrase, not a paragraph.
    i = Math.max(d.anchor - (MAX_WORDS - 1), Math.min(d.anchor + (MAX_WORDS - 1), i))
    const lo = d.words[Math.min(d.anchor, i)]!
    const hi = d.words[Math.max(d.anchor, i)]!
    // Never across a `\n` (a nested block or a <br>) or a link.
    const run = d.text.slice(lo.from, hi.to)
    if (run.includes('\n') || run !== d.crossable.slice(lo.from, hi.to)) return
    if (i === d.current) return
    d.current = i
    const span = spanOf(d.runs, lo.from, hi.to)
    if (span) paintHighlight(MARK_HIGHLIGHT, span)
  }

  function onWindowUp(): void {
    if (!drag) return
    // A release inside the same frame as the last move must not lose it.
    if (moveFrame !== 0) {
      moveFrame = 0
      applyMove()
    }
    const d = drag
    drag = null
    if (!d) return
    swallowClick()
    if (d.fire) fire(d)
  }

  /** The click after a pick belongs to the pick (comart's swallowClick).  The
   *  timer frees the flag when a release produces no click at all. */
  function swallowClick(): void {
    swallowing = true
    if (swallowTimer !== null) clearTimeout(swallowTimer)
    swallowTimer = setTimeout(() => {
      swallowing = false
      swallowTimer = null
    }, SWALLOW_MS)
  }

  /** Where the latest press began.  The engine aims a press-drag-release's
   *  click at the common ancestor, so a press on the band released over the
   *  book clicks #reader; comart's band is an iframe, which keeps that whole
   *  gesture inside it.  The same holds for a press in a layer.  pointerdown,
   *  not mousedown: every press makes one, even where a handler suppresses
   *  the mousedown (the sidebar grip), so the flag is never left over. */
  function onDocDown(ev: Event): void {
    const e = ev as PointerEvent
    const t = e.target as Node | null
    const el = t && t.nodeType === 1 ? (t as Element) : (t?.parentElement ?? null)
    pressKeeps = e.isTrusted && e.button === 0 && !!explain && !!t &&
      (explain.element().contains(t) || !!el?.closest(LAYERS))
  }

  /** comart's band rule: a click outside the band closes it.  Capture phase,
   *  never consumed.  A press on a scrollbar makes no click, so grabbing the
   *  book's scrollbar leaves the answer up. */
  function onDocClick(ev: Event): void {
    const e = ev as MouseEvent
    // A script must not be able to dismiss an answer or eat a pick's click.
    if (!e.isTrusted) return
    // A keyboard click (detail 0) belongs to no press.
    const keeps = pressKeeps && e.detail > 0
    pressKeeps = false
    if (swallowing) {
      swallowing = false
      e.preventDefault()
      e.stopPropagation()
      return
    }
    // The card's shield closes the card at target phase, after this listener,
    // so the click that closes the card never closes the band (rule 3).
    if (mic?.cardOpen()) return
    if (!explain || !explain.isOpen() || e.defaultPrevented || keeps) return
    const target = e.target as Node | null
    if (target && explain.element().contains(target)) return
    const el = target && target.nodeType === 1 ? (target as Element) : (target?.parentElement ?? null)
    if (el?.closest(LAYERS)) return
    explain.close()
  }

  /** The text of the last non-empty h1–h6 before `block` in its chapter
   *  (comart's nearestHeadingBefore); '' when there is none.  A spine file
   *  can hold several chapters, and its title is only the first one's. */
  function headingBefore(section: HTMLElement, block: HTMLElement): string {
    const textOf = (h: Element): string => (h.textContent ?? '').replace(/\s+/g, ' ').trim()
    const lastIn = (el: Element): string => {
      const kids = Array.from(el.children)
      for (let i = kids.length - 1; i >= 0; i--) {
        const k = kids[i]!
        const inner = lastIn(k)
        if (inner) return inner
        if (HEADING_TAG.test(k.tagName)) {
          const t = textOf(k)
          if (t) return t
        }
      }
      return ''
    }
    for (let n: Element = block; n !== section; ) {
      const parent = n.parentElement
      if (!parent) break
      const kids = Array.from(parent.children)
      for (let i = kids.indexOf(n) - 1; i >= 0; i--) {
        const k = kids[i]!
        const inner = lastIn(k)
        if (inner) return inner
        if (HEADING_TAG.test(k.tagName)) {
          const t = textOf(k)
          if (t) return t
        }
      }
      n = parent
    }
    return ''
  }

  /** Title, author and chapter for the passage.  epub.ts's placeholders are
   *  noise to the model: 'Untitled book', and a chapter titled after a
   *  machine-made file name (`index_split_005`, `ch01`, maybe with " (2)").
   *  The heading the pick sits under wins over the spine file's title unless
   *  that title already says it ("Chapter I. The Ball" over "I"). */
  function orientation(section: HTMLElement, block: HTMLElement): PassageMeta {
    const meta = book?.metadata
    const index = /^ep-chapter-(\d+)$/.exec(section.getAttribute('id') ?? '')
    const chapter = index ? book?.chapters[Number(index[1])] : undefined
    let chapterTitle = chapter?.title ?? ''
    if (chapter) {
      const stem = chapter.href.slice(chapter.href.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '')
      const suffix = chapterTitle.startsWith(stem) ? chapterTitle.slice(stem.length) : null
      const fromFile = suffix !== null && (suffix === '' || /^ \(\d+\)$/.test(suffix))
      if (fromFile && /^[^\s]*[\d_][^\s]*$/.test(stem)) chapterTitle = ''
    }
    const heading = headingBefore(section, block)
    if (heading && heading.length <= MAX_HEADING && !chapterTitle.includes(heading)) chapterTitle = heading
    return {
      title: meta?.title === 'Untitled book' ? '' : (meta?.title ?? ''),
      author: meta?.author ?? '',
      chapter: chapterTitle,
    }
  }

  /** The passage for a pick, from its chapter walked FRESH: find's marks split
   *  and re-join text nodes, so the cached search index can hold dead nodes. */
  function passageFor(d: Drag, span: PickSpan, from: number, to: number): string {
    const ct = chapterText(d.section)
    const a = ct.runs.find((r) => r.node === span.start.node)
    const b = ct.runs.find((r) => r.node === span.end.node)
    const context =
      a && b
        ? contextWindow(blankOut(ct, NOTEREF), runIndex(a, span.start.offset), runIndex(b, span.end.offset - 1) + 1)
        : contextWindow(d.crossable, from, to)
    return buildPassage(context, orientation(d.section, d.block))
  }

  function fire(d: Drag): void {
    if (!explain || !book) return
    const picked = d.words.slice(Math.min(d.anchor, d.current), Math.max(d.anchor, d.current) + 1)
    const first = picked[0]
    const last = picked[picked.length - 1]
    if (!first || !last) return
    const span = spanOf(d.runs, first.from, last.to)
    if (!span) return
    const words = picked.map((w) => w.text)
    const outcome = explain.explain({
      text: passageFor(d, span, first.from, last.to),
      items: [{ phrase: words.join(' '), words }],
    })
    // A staged pick explains nothing yet, so `shown` stays for Esc to restore.
    if (outcome === 'staged') {
      staged = span
    } else {
      shown = span
      staged = null
    }
    paintHighlight(MARK_HIGHLIGHT, span)
  }

  /** The band took the bottom of the book's box: if the marked word is now
   *  under it, scroll by exactly the overlap (comart's revealMarks). */
  function revealMark(): void {
    if (!shown || !canPick()) return
    let bottom = -Infinity
    try {
      const rects = probe.rectsOf(shown.start, shown.end)
      for (let i = 0; i < rects.length; i++) bottom = Math.max(bottom, rects[i]!.bottom)
    } catch {
      return
    }
    if (bottom === -Infinity) return
    const limit = scroller.getBoundingClientRect().top + scroller.clientHeight - REVEAL_GAP
    // Only a mark in the rows the band now holds: one the reader scrolled
    // away from stays where it is when the band is resized.
    if (bottom > limit && bottom <= root.getBoundingClientRect().bottom) scroller.scrollTop += Math.ceil(bottom - limit)
  }

  const explainHooks: ExplainHooks = {
    onClosed: () => {
      shown = null
      staged = null
      setHover(null)
      paintHighlight(MARK_HIGHLIGHT, null)
    },
    onShown: () => {
      requestAnimationFrame(revealMark)
    },
    // The mark already paints the staged word; only its role changes.
    onPlaced: () => {
      shown = staged
      staged = null
    },
  }

  /* ── open / close ─────────────────────────────────────────────────────── */

  function showMessage(title: string, detail: string): void {
    messageTitle.textContent = title
    messageDetail.textContent = detail
    showMode('error')
  }

  function fail(err: unknown): void {
    const e = err instanceof EpubError ? err : null
    const detail = e
      ? e.message
      : err !== null && typeof err === 'object' && 'message' in err
        ? String((err as { message: unknown }).message)
        : String(err)
    showMessage(
      e?.code === 'drm' ? 'This book is protected' : 'This EPUB could not be opened',
      detail + (e?.code === 'drm' ? ' DRM-protected books are not supported.' : '')
    )
  }

  function clearBook(): void {
    // Leaving the book forgets its explanation; the pick's Ranges point into
    // DOM that is about to go.  A take of it is discarded.
    closeExplain()
    mic?.leave()
    revokeResources()
    if (book) book.destroy()
    book = null
    bookText = ''
    chapterStarts = []
    chapterTexts = []
    findTarget = null
    orphaned = false
    clearMarks()
    clearChildren(content)
    chapterTops = []
    chapterHeights = []
    measuredMaxScroll = 0
    lastChapter = 0
    lastOffset = 0
    lastProgress = 0
    pendingPosition = null
    rendered = false
    scroller.classList.remove('ep-restoring')
    if (saveTimer !== null) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    syncMic()
  }

  async function open(path: string, position: EpubBookmark | null): Promise<boolean> {
    const seq = ++openSeq
    if (book && rendered && bookPath === path && !orphaned) {
      // Already laid out: keep the live position.  `show()` is the path back
      // from another tab, and it must not rewind to the position the book had
      // when it was first opened.  Only once rendered: a book still preloading
      // its pictures is an open in flight, and the open below supersedes it
      // (this one bumped openSeq, so the older open would drop the book).
      root.hidden = false
      pane.classList.add('is-reader')
      showMode('read')
      requestAnimationFrame(() => {
        if (concealed()) reveal()
        else measure()
        recenterFind()
      })
      return true
    }
    // Read BEFORE clearing the current book.  A failed read leaves the old
    // book exactly where it was, which is also what the tree's active row is
    // put back to; only a successful read earns the replacement.
    let buffer: ArrayBuffer
    try {
      buffer = await deps.transport.readEpub(path)
    } catch (err) {
      if (seq !== openSeq) return false
      deps.onError(err, 'read-epub')
      if (!book) {
        hide()
        bookPath = null
      }
      return false
    }
    // The user may have clicked a note, another book, or closed the tab while
    // the bytes were in flight.  A stale open must not touch any shared state.
    if (seq !== openSeq) return false
    if (book && bookPath !== null && bookPath !== path) {
      // The 600 ms scroll debounce would otherwise die with clearBook().
      saveProgress()
    }
    // A first open takes the pane at once but shows it blank until the text is
    // in: the parse is short, and any message would only flash.  A replacement
    // keeps the previous page up while the new container is parsed, so a
    // corrupt book cannot destroy the book that is already readable.
    if (!book) {
      root.hidden = false
      pane.classList.add('is-reader')
      clearChildren(content)
      showMode('loading')
    }
    let next: EpubBook
    try {
      next = await openEpub(buffer)
    } catch (err) {
      if (seq !== openSeq) return false
      if (!book) {
        fail(err)
        return true
      }
      deps.onError(err, 'open-epub')
      return false
    }
    if (seq !== openSeq) {
      next.destroy()
      return false
    }
    if (book && bookPath !== null && bookPath !== path) saveProgress()
    find?.hide()
    clearBook()
    bookPath = path
    pendingPosition = position
    root.hidden = false
    pane.classList.add('is-reader')
    book = next
    orphaned = false
    try {
      await preloadImages()
      if (seq !== openSeq) {
        // Only clean up this request's book; a newer open may already own the
        // shared `book`/`bookPath` slots.
        if (book === next) {
          clearBook()
          bookPath = null
        }
        return false
      }
      renderBook()
      rendered = true
      syncMic()
      buildSearchIndex()
      scroller.classList.add('ep-restoring')
      showMode('read')
    } catch (err) {
      if (seq !== openSeq) return false
      fail(err)
      // Do not leave a half-open book behind: the error page is the surface,
      // and a second click on the row should retry the read.
      if (book === next) {
        revokeResources()
        next.destroy()
        book = null
        bookPath = null
        findTarget = null
        rendered = false
      }
      return true
    }
    // Two frames: the first lets the chapter boxes lay out, the second lets
    // images that arrived in that layout settle their boxes.  Keyed to the
    // book, not to this open: a later open that failed, was cancelled or
    // reopened this same book leaves this one showing, still owed its place.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (book === next) reveal()
      })
    })
    return true
  }

  function hide(): void {
    if (root.hidden) return
    find?.hide()
    // Before the band closes: its height changes the box the position is read in.
    saveProgress()
    closeExplain()
    mic?.leave()
    root.hidden = true
    pane.classList.remove('is-reader')
    syncMic()
    if (mode !== 'read') showMode('read')
  }

  function show(): void {
    if (!bookPath) return
    root.hidden = false
    pane.classList.add('is-reader')
    if (book) showMode('read')
    else showMode('error')
    requestAnimationFrame(() => {
      // A render whose own frames passed while the reader was hidden.
      if (concealed()) reveal()
      else measure()
      recenterFind()
    })
  }

  function close(): void {
    ++openSeq
    hide()
    clearBook()
    bookPath = null
  }

  function reset(): void {
    close()
  }

  /* ── events ───────────────────────────────────────────────────────────── */

  function onScroll(): void {
    // The text moved under a still pointer; the next move finds the new word.
    if (hover) setHover(null)
    if (frame !== 0) return
    frame = requestAnimationFrame(() => {
      frame = 0
      updateFromScroll()
    })
  }
  scroller.addEventListener('scroll', onScroll, { passive: true })
  // An image that lands after the first measurement moves every chapter below
  // it; re-measure rather than saving a position against stale offsets.
  content.addEventListener(
    'load',
    () => {
      if (root.hidden) return
      measure()
      recenterFind()
      if (mode === 'read') updateFromScroll()
    },
    true
  )
  window.addEventListener('resize', () => {
    if (root.hidden) return
    measure()
    recenterFind()
    if (mode === 'read') updateFromScroll()
    explain?.relayout()
  })
  // The sidebar resize rewrites a CSS variable and fires no window resize.
  const resizeObserver =
    typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => {
          if (root.hidden) return
          measure()
          recenterFind()
          if (mode === 'read') updateFromScroll()
          explain?.relayout()
        })
  resizeObserver?.observe(scroller)

  root.addEventListener('click', (ev) => {
    const e = ev as MouseEvent
    const target = e.target as HTMLElement | null
    const anchor = target?.closest?.('a[data-ep-external], a[data-ep-chapter]') as
      | HTMLAnchorElement
      | null
    if (!anchor) return
    const external = anchor.getAttribute('data-ep-external')
    if (external) {
      e.preventDefault()
      void deps.transport.openExternal(external).catch((err: unknown) => deps.onError(err, 'open-external'))
      return
    }
    const chapter = Number(anchor.getAttribute('data-ep-chapter'))
    if (!Number.isInteger(chapter)) return
    e.preventDefault()
    const targetId = anchor.getAttribute('data-ep-target-id')
    if (targetId) {
      goToId(targetId)
      return
    }
    const fragment = anchor.getAttribute('data-ep-fragment') ?? ''
    if (fragment) goTo(chapter, fragment)
    else goTo(chapter)
  })

  function onKeyDown(ev: Event): void {
    const e = ev as KeyboardEvent
    if (e.defaultPrevented) return
    const k = e.key.toLowerCase()
    const mod = e.metaKey || e.ctrlKey
    if (mod && !e.altKey && !e.shiftKey && k === 'f') {
      e.preventDefault()
      find?.toggle()
      return
    }
    const target = e.target as HTMLElement | null
    if (target && target.tagName === 'INPUT') return
    if (e.key !== 'Escape') return
    // One layer per press: a held key must not close the next layer too.
    if (e.repeat) return
    if (find?.isOpen) {
      e.preventDefault()
      find.close()
      return
    }
    if (explain?.isStaged()) {
      e.preventDefault()
      explain.cancelStaged()
      staged = null
      // The mark goes back to the word the band shows.  A drag that will ask
      // owns the mark until it ends; a double-click's second press never
      // painted it.
      if (!drag?.fire) paintHighlight(MARK_HIGHLIGHT, shown)
      return
    }
    if (explain?.isOpen()) {
      e.preventDefault()
      const inside = explain.element().contains(doc.activeElement)
      explain.close()
      // A hidden band cannot keep focus; the book takes the keyboard back.
      if (inside) scroller.focus({ preventScroll: true })
    }
  }
  root.addEventListener('keydown', onKeyDown)

  // The band goes in after the message page and before the find bar, so the
  // find overlay still stacks above it.
  try {
    explain = deps.mountExplain ? deps.mountExplain(root, explainHooks) : null
  } catch (err) {
    deps.onError(err, 'explain-mount')
  }
  if (explain) {
    content.addEventListener('mousedown', onContentDown)
    scroller.addEventListener('mousemove', onPointerMove)
    scroller.addEventListener('mouseleave', onPointerLeave)
    // Capture: the release may land anywhere, and nothing else may eat it.
    window.addEventListener('mouseup', onWindowUp, true)
    doc.addEventListener('pointerdown', onDocDown, true)
    doc.addEventListener('click', onDocClick, true)
  }
  // Its roots are body-level (main.editor's paint containment would clip a
  // child of #reader); #reader is its anchor and its focus target.
  try {
    mic = deps.mountMic ? deps.mountMic(root, { restoreFocus: focusReader }) : null
  } catch (err) {
    deps.onError(err, 'mic-mount')
  }

  find = mountFind(root, {
    placeholder: 'Find in book',
    // Book text is not selectable (E109), and a selection was never a search
    // query anyway; Ctrl-F opens empty.
    prefillSelection: false,
    getText: () => (book ? bookText : null),
    getSelection: findSelection,
    reveal: revealFind,
    setHighlight: setFindHighlight,
    focusEditor: () => scroller.focus(),
    // Book content is static for the life of an open book.
    onDocChanged: () => () => {},
  })

  function lost(): void {
    // The rendered text and the last saved bookmark survive; further scrolls
    // must not write a bookmark for a path that no longer exists.
    orphaned = true
    if (saveTimer !== null) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
  }

  showMode('read')

  return {
    open,
    cancelOpen: () => {
      ++openSeq
      // An open that has taken the pane but has nothing on it yet (a first
      // open's blank page, or a replacement between dropping the old book and
      // rendering the new one) gives the pane back now: the surface that
      // cancelled it is about to show, whether or not it then opens.  A
      // rendered book and a finished open's error page stay.
      if (!root.hidden && !rendered && mode !== 'error') hide()
    },
    show,
    hide,
    close,
    reset,
    visible: () => !root.hidden,
    path: () => bookPath,
    flushProgress: () => {
      if (!root.hidden && book) saveProgress()
    },
    toggleSearch: () => {
      if (root.hidden) return
      find?.toggle()
    },
    adoptPath: (path: string) => {
      orphaned = false
      const old = bookPath
      bookPath = path
      if (old !== path && book) {
        // The old key is gone from the vault; write the same position under the
        // new one so a rename does not lose the bookmark.  A concealed render
        // is not at its place yet: its place is the bookmark it opened with.
        const pos = concealed()
          ? pendingPosition
          : {
              chapter: lastChapter,
              href: book.chapters[lastChapter]?.href ?? '',
              offset: lastOffset,
              progress: lastProgress,
            }
        if (pos) deps.onProgress(path, pos)
      }
    },
    lost,
    destroy: () => {
      ++openSeq
      reset()
      resizeObserver?.disconnect()
      find?.destroy()
      find = null
      if (explain) {
        window.removeEventListener('mouseup', onWindowUp, true)
        doc.removeEventListener('pointerdown', onDocDown, true)
        doc.removeEventListener('click', onDocClick, true)
        explain.destroy()
        explain = null
      }
      if (swallowTimer !== null) clearTimeout(swallowTimer)
      swallowTimer = null
      swallowing = false
      moveFrame = 0
      mic?.destroy()
      mic = null
      root.remove()
    },
  }
}
