/**
 * src/reader.ts
 * Owner: 03.  Spec: CONTRACT.md §0.55 E108 — the EPUB reader surface.
 *
 * THE TAKEOVER SHAPE IS MEMOIR'S, not a second editor.  This module mounts one
 * `#reader` host beside `#ed` inside `main.editor` and toggles `.is-reader` on
 * the pane, which hides the CodeMirror host while the book is up.  It owns ONE
 * rendered scroller: the book itself.  Mod-F mounts the NOTE VIEWER'S OWN
 * find bar (`find.ts`/find.css) as an overlay, never a second view and never a
 * third scroller (§5.12.4's two-scroller ceiling).  There is no visible search
 * button; the shortcut is the only way in.
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

type Mode = 'read' | 'error'

const SAVE_DEBOUNCE_MS = 600

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

  function clearChildren(node: Element | HTMLElement): void {
    node.textContent = ''
  }

  function showMode(next: Mode, takeFocus = true): void {
    mode = next
    const read = next === 'read'
    scroller.hidden = !read
    message.hidden = next !== 'error'
    if (read && takeFocus) scroller.focus()
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
    if (!book || restoring) return
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
    // reader is the only one with a measurable position.
    if (!bookPath || !book || orphaned || root.hidden || scroller.clientHeight === 0) return
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
    for (const mark of content.querySelectorAll<HTMLElement>('mark.cm-find-match')) {
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
    if (saveTimer !== null) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
  }

  async function open(path: string, position: EpubBookmark | null): Promise<boolean> {
    const seq = ++openSeq
    if (book && bookPath === path && !orphaned) {
      // Already laid out: keep the live position.  `show()` is the path back
      // from another tab, and it must not rewind to the position the book had
      // when it was first opened.
      root.hidden = false
      pane.classList.add('is-reader')
      showMode('read')
      requestAnimationFrame(() => {
        measure()
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
    // A first open shows its progress; a replacement keeps the previous page up
    // while the new container is parsed, so a corrupt book cannot destroy the
    // book that is already readable.
    if (!book) {
      root.hidden = false
      pane.classList.add('is-reader')
      clearChildren(content)
      showMessage('Opening book\u2026', '')
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
      buildSearchIndex()
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
      }
      return true
    }
    // Two frames: the first lets the chapter boxes lay out, the second lets
    // images that arrived in that layout settle their boxes.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (seq !== openSeq) return
        restore(pendingPosition)
      })
    })
    return true
  }

  function hide(): void {
    if (root.hidden) return
    find?.hide()
    saveProgress()
    root.hidden = true
    pane.classList.remove('is-reader')
    if (mode !== 'read') showMode('read')
  }

  function show(): void {
    if (!bookPath) return
    root.hidden = false
    pane.classList.add('is-reader')
    if (book) showMode('read')
    else showMode('error')
    requestAnimationFrame(() => {
      measure()
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
    if (e.key === 'Escape' && find?.isOpen) {
      e.preventDefault()
      find.close()
      return
    }
  }
  root.addEventListener('keydown', onKeyDown)

  find = mountFind(root, {
    placeholder: 'Find in book',
    // A selection is text to quote, not a search query; Ctrl-F opens empty.
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
    cancelOpen: () => { ++openSeq },
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
        // new one so a rename does not lose the bookmark.
        deps.onProgress(path, {
          chapter: lastChapter,
          href: book.chapters[lastChapter]?.href ?? '',
          offset: lastOffset,
          progress: lastProgress,
        })
      }
    },
    lost,
    destroy: () => {
      ++openSeq
      reset()
      resizeObserver?.disconnect()
      find?.destroy()
      find = null
      root.remove()
    },
  }
}
