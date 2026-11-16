/**
 * src/epub.ts
 * Owner: 02.  Spec: CONTRACT.md §0.55 E108 — the in-house EPUB container
 * reader.  No dependency, no iframe, no network.
 *
 * WHAT THIS FILE OWNS, AND WHAT IT DOES NOT.  It owns the ZIP container, the
 * OPF package, the spine, the TOC, each chapter's collapsed visible text and
 * raster image headers.  It does NOT create reader chrome or touch the app's
 * DOM: `src/reader.ts` owns that, and it consumes `EpubChapter.body` through
 * its own allow-list renderer.
 *
 * WHY A HAND-WRITTEN XML PARSER.  The app has no `DOMParser` in its test
 * environment, and the whole point of the E108 decision is a reader that ships
 * no new runtime dependency.  This parser is deliberately non-validating and
 * lenient: an EPUB is user content, and a stray `&nbsp;`, an unclosed `<br>`
 * or a missing DTD must degrade to readable text rather than a failed book.
 * It never executes anything; `reader.ts` sanitises the tree it produces.
 *
 * ZIP SUPPORT IS STORE + DEFLATE, read from the CENTRAL DIRECTORY.  That is
 * what EPUB 2 and 3 require.  ZIP64, encryption and every other method are
 * refused with a named `EpubError`; DRM is out of scope by the E108 ruling.
 */

/** A named failure the reader can put on its error page without parsing prose. */
export type EpubErrorCode = 'notEpub' | 'corrupt' | 'unsupported' | 'tooLarge' | 'drm'

export class EpubError extends Error {
  override readonly name = 'EpubError'
  readonly code: EpubErrorCode
  constructor(code: EpubErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

/* ── XML: a tiny, lenient, non-validating tree ────────────────────────────── */

export interface XmlText {
  readonly kind: 'text'
  readonly text: string
}

export interface XmlElement {
  readonly kind: 'element'
  readonly name: string
  readonly attrs: ReadonlyMap<string, string>
  readonly children: readonly XmlNode[]
}

export type XmlNode = XmlText | XmlElement

interface MutableElement {
  kind: 'element'
  name: string
  attrs: Map<string, string>
  children: XmlNode[]
}

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
])

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  mdash: '\u2014', ndash: '\u2013', hellip: '\u2026', lsquo: '\u2018',
  rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d', copy: '\u00a9',
  reg: '\u00ae', trade: '\u2122', times: '\u00d7', divide: '\u00f7',
  middot: '\u00b7', bull: '\u2022', deg: '\u00b0', plusmn: '\u00b1',
  frac12: '\u00bd', frac14: '\u00bc', frac34: '\u00be', sup1: '\u00b9',
  sup2: '\u00b2', sup3: '\u00b3', shy: '\u00ad',
}

/** Decode the entities an EPUB actually contains, numeric forms included. */
export function decodeEntities(input: string): string {
  if (!input.includes('&')) return input
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]+);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X'
      const digits = hex ? body.slice(2) : body.slice(1)
      const n = Number.parseInt(digits, hex ? 16 : 10)
      if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff) return whole
      try {
        return String.fromCodePoint(n)
      } catch {
        return whole
      }
    }
    const key = body.toLowerCase()
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key) ? NAMED_ENTITIES[key]! : whole
  })
}

/** The local part of a qualified XML name (`dc:title` -> `title`). */
export function localName(name: string): string {
  const at = name.lastIndexOf(':')
  return (at < 0 ? name : name.slice(at + 1)).toLowerCase()
}

interface StartTag {
  name: string
  attrs: Map<string, string>
  selfClosing: boolean
  end: number
}

/** A start tag longer than this is treated as malformed text, not scanned to
 *  EOF.  EPUB markup is far below it; the cap makes a hostile document O(n). */
const MAX_TAG_CHARS = 1 << 18
const MAX_XML_DEPTH = 512

function readStartTag(source: string, at: number): StartTag | null {
  const n = source.length
  let i = at + 1
  while (i < n && !/[\s/><]/.test(source[i]!)) i++
  if (i >= n || source[i] === '<') return null
  const name = source.slice(at + 1, i)
  if (!name) return null
  const attrs = new Map<string, string>()
  while (i < n) {
    if (i - at > MAX_TAG_CHARS) return null
    while (i < n && /\s/.test(source[i]!)) i++
    if (i >= n) break
    if (source[i] === '>') return { name, attrs, selfClosing: false, end: i + 1 }
    if (source[i] === '/' && source[i + 1] === '>') {
      return { name, attrs, selfClosing: true, end: i + 2 }
    }
    const keyStart = i
    while (i < n && !/[\s=/><]/.test(source[i]!)) i++
    if (i >= n || source[i] === '<') return null
    const key = source.slice(keyStart, i)
    if (!key) {
      // A stray slash (or any other no-progress character) is consumed.  The
      // old loop spun forever on `<img src=x / >`, freezing the renderer.
      i++
      continue
    }
    while (i < n && /\s/.test(source[i]!)) i++
    let value = ''
    if (source[i] === '=') {
      i++
      while (i < n && /\s/.test(source[i]!)) i++
      const quote = source[i]
      if (quote === '"' || quote === "'") {
        const end = source.indexOf(quote, i + 1)
        if (end < 0) return null
        value = source.slice(i + 1, end)
        i = end + 1
      } else {
        const start = i
        while (
          i < n &&
          !/\s/.test(source[i]!) &&
          source[i] !== '<' &&
          !(source[i] === '>' || (source[i] === '/' && source[i + 1] === '>'))
        ) {
          i++
        }
        value = source.slice(start, i)
      }
    }
    attrs.set(key, decodeEntities(value))
  }
  return null
}

/**
 * Parse one XML document into an inert tree.  There is no DTD resolution and
 * no external entity fetch: the result is data the sanitising renderer walks.
 */
export function parseXml(source: string): XmlElement {
  const root: MutableElement = {
    kind: 'element',
    name: '#document',
    attrs: new Map<string, string>(),
    children: [],
  }
  const stack: MutableElement[] = [root]
  const top = (): MutableElement => stack[stack.length - 1]!
  const pushText = (text: string): void => {
    if (text) top().children.push({ kind: 'text', text })
  }
  let i = source.charCodeAt(0) === 0xfeff ? 1 : 0
  const n = source.length
  while (i < n) {
    const lt = source.indexOf('<', i)
    if (lt < 0) {
      pushText(decodeEntities(source.slice(i)))
      break
    }
    if (lt > i) pushText(decodeEntities(source.slice(i, lt)))
    i = lt
    if (source.startsWith('<!--', i)) {
      const end = source.indexOf('-->', i + 4)
      i = end < 0 ? n : end + 3
      continue
    }
    if (source.startsWith('<![CDATA[', i)) {
      const end = source.indexOf(']]>', i + 9)
      pushText(end < 0 ? source.slice(i + 9) : source.slice(i + 9, end))
      i = end < 0 ? n : end + 3
      continue
    }
    if (source.startsWith('<?', i)) {
      const end = source.indexOf('?>', i + 2)
      i = end < 0 ? n : end + 2
      continue
    }
    if (source.startsWith('<!', i)) {
      // DOCTYPE, including an internal subset in brackets.
      let depth = 0
      let j = i + 2
      while (j < n) {
        const ch = source[j]
        if (ch === '[') depth++
        else if (ch === ']') depth--
        else if (ch === '>' && depth <= 0) {
          j++
          break
        }
        j++
      }
      i = j
      continue
    }
    if (source.startsWith('</', i)) {
      const end = source.indexOf('>', i + 2)
      const name = localName(source.slice(i + 2, end < 0 ? n : end).trim())
      i = end < 0 ? n : end + 1
      if (stack.length > 1) {
        for (let k = stack.length - 1; k > 0; k--) {
          if (localName(stack[k]!.name) === name) {
            stack.length = k
            break
          }
        }
      }
      continue
    }
    const tag = readStartTag(source, i)
    if (!tag) {
      // Consume to the next '<' in one step.  Advancing one character and
      // re-scanning made a chapter of N '<' characters O(N^2).
      const next = source.indexOf('<', i + 1)
      const end = next < 0 ? n : next
      pushText(decodeEntities(source.slice(i, end)))
      i = end
      continue
    }
    const el: MutableElement = {
      kind: 'element',
      name: tag.name,
      attrs: tag.attrs,
      children: [],
    }
    top().children.push(el)
    i = tag.end
    if (!tag.selfClosing && !VOID_ELEMENTS.has(localName(tag.name))) {
      if (stack.length >= MAX_XML_DEPTH) {
        throw new EpubError('corrupt', 'The EPUB has markup nested too deeply.')
      }
      stack.push(el)
    }
  }
  return root
}

/** The first descendant with this local name, depth-first. */
export function findElement(node: XmlNode, local: string): XmlElement | null {
  if (node.kind === 'text') return null
  const want = local.toLowerCase()
  if (localName(node.name) === want) return node
  for (const child of node.children) {
    const hit = findElement(child, want)
    if (hit) return hit
  }
  return null
}

/** Every descendant with this local name, in document order. */
export function findElements(node: XmlNode, local: string, out: XmlElement[] = []): XmlElement[] {
  if (node.kind === 'text') return out
  const want = local.toLowerCase()
  if (localName(node.name) === want) out.push(node)
  for (const child of node.children) findElements(child, want, out)
  return out
}

/** Direct children only — TOC depth lives in the nesting, so descendants leak. */
function childElements(node: XmlElement, local: string): XmlElement[] {
  const want = local.toLowerCase()
  const out: XmlElement[] = []
  for (const child of node.children) {
    if (child.kind === 'element' && localName(child.name) === want) out.push(child)
  }
  return out
}

/** Attribute lookup by exact name first, then by local name. */
export function attr(node: XmlElement, name: string): string {
  const exact = node.attrs.get(name)
  if (exact !== undefined) return exact
  const want = name.toLowerCase()
  for (const [k, v] of node.attrs) {
    if (k.toLowerCase() === want || localName(k) === want) return v
  }
  return ''
}

const BLOCK_TEXT = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'caption', 'dd', 'div',
  'dl', 'dt', 'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5',
  'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section',
  'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
])

/** Markup whose text is never part of the book: scripts, styles and the SVG
 *  title.  The renderer drops these too, so the searchable text must agree. */
const NON_TEXT = new Set(['head', 'math', 'noscript', 'script', 'style', 'svg', 'template'])

function collectText(node: XmlNode, out: string[]): void {
  if (node.kind === 'text') {
    out.push(node.text)
    return
  }
  const local = localName(node.name)
  if (NON_TEXT.has(local)) return
  const block = BLOCK_TEXT.has(local)
  if (block) out.push(' ')
  for (const child of node.children) collectText(child, out)
  if (block) out.push(' ')
}

/** Visible text with runs collapsed; what the reader flattens for Mod-F. */
export function elementText(node: XmlNode): string {
  const out: string[] = []
  collectText(node, out)
  return out.join('').replace(/\s+/g, ' ').trim()
}

/* ── image dimensions ─────────────────────────────────────────────────────── */

export interface ImageSize {
  width: number
  height: number
}

/** A reserved box bigger than this is a malformed header, not a picture. */
const MAX_IMAGE_DIM = 32768

function u16be(b: Uint8Array, i: number): number {
  return (b[i]! << 8) | b[i + 1]!
}

function u16le(b: Uint8Array, i: number): number {
  return b[i]! | (b[i + 1]! << 8)
}

function u24le(b: Uint8Array, i: number): number {
  return b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16)
}

function u32be(b: Uint8Array, i: number): number {
  return ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0
}

/** Intrinsic dimensions from the image header, before any decode.  The reader
 *  uses this to reserve the image's box in the flow: without it an image has no
 *  height until its bytes arrive, and a search jump made in that window lands on
 *  coordinates the later load invalidates.  Returns null for an unknown or
 *  malformed header; the reader then falls back to the image's own load. */
export function imageSize(bytes: Uint8Array): ImageSize | null {
  const n = bytes.length
  if (n < 10) return null

  // PNG: full signature, then a real IHDR chunk (length 13) and its u32s.
  if (
    n >= 33 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a &&
    u32be(bytes, 8) === 13 &&
    bytes[12] === 0x49 && bytes[13] === 0x48 && bytes[14] === 0x44 && bytes[15] === 0x52
  ) {
    const width = u32be(bytes, 16)
    const height = u32be(bytes, 20)
    return width > 0 && height > 0 && width <= MAX_IMAGE_DIM && height <= MAX_IMAGE_DIM
      ? { width, height }
      : null
  }

  // GIF: logical screen width/height are little-endian u16s at 6 and 8.
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    const width = u16le(bytes, 6)
    const height = u16le(bytes, 8)
    return width > 0 && height > 0 && width <= MAX_IMAGE_DIM && height <= MAX_IMAGE_DIM
      ? { width, height }
      : null
  }

  // JPEG: walk the markers to the first Start Of Frame.
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2
    while (i + 3 < n) {
      if (bytes[i] !== 0xff) {
        i++
        continue
      }
      const marker = bytes[i + 1]!
      if (marker === 0xff) {
        i++
        continue
      }
      // Standalone markers carry no length: SOI, TEM, RST0..RST7, EOI.
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
        i += 2
        continue
      }
      if (i + 4 > n) return null
      const size = u16be(bytes, i + 2)
      if (size < 2) return null
      const sof =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      if (sof) {
        if (i + 9 > n) return null
        const height = u16be(bytes, i + 5)
        const width = u16be(bytes, i + 7)
        return width > 0 && height > 0 && width <= MAX_IMAGE_DIM && height <= MAX_IMAGE_DIM
          ? { width, height }
          : null
      }
      i += 2 + size
    }
    return null
  }

  // WebP: RIFF container; VP8 (lossy), VP8L (lossless) and VP8X (extended).
  if (
    n >= 25 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    const kind = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!)
    if (kind === 'VP8X' && n >= 30) {
      const width = u24le(bytes, 24) + 1
      const height = u24le(bytes, 27) + 1
      return width <= MAX_IMAGE_DIM && height <= MAX_IMAGE_DIM ? { width, height } : null
    }
    if (
      kind === 'VP8 ' && n >= 30 &&
      bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a
    ) {
      const width = u16le(bytes, 26) & 0x3fff
      const height = u16le(bytes, 28) & 0x3fff
      return width > 0 && height > 0 && width <= MAX_IMAGE_DIM && height <= MAX_IMAGE_DIM
        ? { width, height }
        : null
    }
    if (kind === 'VP8L' && bytes[20] === 0x2f) {
      const bits =
        (bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24)) >>> 0
      const width = 1 + (bits & 0x3fff)
      const height = 1 + ((bits >>> 14) & 0x3fff)
      return width <= MAX_IMAGE_DIM && height <= MAX_IMAGE_DIM ? { width, height } : null
    }
  }

  return null
}

/* ── paths inside the archive ─────────────────────────────────────────────── */

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

function dirOf(path: string): string {
  const at = path.lastIndexOf('/')
  return at < 0 ? '' : path.slice(0, at)
}

function normaliseSegments(input: string): string {
  const out: string[] = []
  for (const part of input.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      out.pop()
      continue
    }
    out.push(part)
  }
  return out.join('/')
}

/** ZIP entry names and href paths share one canonical spelling: forward
 *  slashes, no leading/trailing separators, no `.`/`..` segments. */
function canonicalArchivePath(input: string): string {
  return normaliseSegments(input)
}

export interface ResolvedHref {
  /** Archive path, no leading slash, no fragment. */
  path: string
  /** Decoded fragment without `#`; '' when absent. */
  fragment: string
}

/** Resolve an EPUB href against the document that contains it. */
export function resolveHref(baseFile: string, href: string): ResolvedHref {
  const hash = href.indexOf('#')
  const beforeHash = hash < 0 ? href : href.slice(0, hash)
  const fragment = hash < 0 ? '' : safeDecode(href.slice(hash + 1))
  const query = beforeHash.indexOf('?')
  const raw = query < 0 ? beforeHash : beforeHash.slice(0, query)
  const decoded = safeDecode(raw).replace(/\\/g, '/')
  if (decoded === '') return { path: canonicalArchivePath(baseFile), fragment }
  const path = decoded.startsWith('/')
    ? normaliseSegments(decoded)
    : normaliseSegments((dirOf(baseFile) ? dirOf(baseFile) + '/' : '') + decoded)
  return { path, fragment }
}

/* ── ZIP: the central directory, store and deflate ────────────────────────── */

/** A zip bomb is still a file the app is asked to read. */
const MAX_EXTRACTED_BYTES = 1024 * 1024 * 1024

interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  uncompressedSize: number
  localOffset: number
}

class ZipArchive {
  private readonly buffer: ArrayBuffer
  private readonly view: DataView
  private readonly entries = new Map<string, ZipEntry>()
  private readonly cache = new Map<string, Uint8Array>()
  private extracted = 0

  private constructor(buffer: ArrayBuffer) {
    this.buffer = buffer
    this.view = new DataView(buffer)
  }

  static open(buffer: ArrayBuffer): ZipArchive {
    const zip = new ZipArchive(buffer)
    zip.readCentralDirectory()
    return zip
  }

  private u16(at: number): number {
    if (at < 0 || at + 2 > this.view.byteLength) throw new EpubError('corrupt', 'The EPUB archive is truncated.')
    return this.view.getUint16(at, true)
  }

  private u32(at: number): number {
    if (at < 0 || at + 4 > this.view.byteLength) throw new EpubError('corrupt', 'The EPUB archive is truncated.')
    return this.view.getUint32(at, true)
  }

  private readCentralDirectory(): void {
    const len = this.view.byteLength
    if (len < 22) throw new EpubError('notEpub', 'This file is too small to be an EPUB.')
    // EOCD is 22 bytes plus a comment of at most 65,535.
    const floor = Math.max(0, len - 22 - 0xffff)
    let eocd = -1
    for (let at = len - 22; at >= floor; at--) {
      if (this.u32(at) !== 0x0605_4b50) continue
      // The EOCD is the LAST structure: its comment must end exactly at EOF.
      // Without this, a `PK\x05\x06` inside a ZIP comment shadows the real
      // directory and the book is misread (or rejected).
      const commentLen = this.u16(at + 20)
      if (at + 22 + commentLen !== len) continue
      eocd = at
      break
    }
    if (eocd < 0) throw new EpubError('notEpub', 'This file is not a ZIP container, so it is not an EPUB.')
    const count = this.u16(eocd + 10)
    const dirSize = this.u32(eocd + 12)
    const dirAt = this.u32(eocd + 16)
    if (count === 0xffff || dirSize === 0xffff_ffff || dirAt === 0xffff_ffff) {
      throw new EpubError('unsupported', 'This EPUB uses ZIP64, which the reader does not support yet.')
    }
    if (dirAt + dirSize > eocd) {
      throw new EpubError('corrupt', 'The EPUB archive directory runs past its end record.')
    }
    let at = dirAt
    let totalUncompressed = 0
    for (let k = 0; k < count; k++) {
      if (this.u32(at) !== 0x0201_4b50) {
        throw new EpubError('corrupt', 'The EPUB archive has a damaged entry table.')
      }
      const flags = this.u16(at + 8)
      const method = this.u16(at + 10)
      if ((flags & 0x0001) !== 0 || (flags & 0x0040) !== 0 || method === 99) {
        throw new EpubError('drm', 'This EPUB is encrypted at the ZIP level.')
      }
      const compressedSize = this.u32(at + 20)
      const uncompressedSize = this.u32(at + 24)
      const nameLen = this.u16(at + 28)
      const extraLen = this.u16(at + 30)
      const commentLen = this.u16(at + 32)
      const localOffset = this.u32(at + 42)
      if (compressedSize === 0xffff_ffff || uncompressedSize === 0xffff_ffff || localOffset === 0xffff_ffff) {
        throw new EpubError('unsupported', 'This EPUB uses ZIP64, which the reader does not support yet.')
      }
      totalUncompressed += uncompressedSize
      if (totalUncompressed > MAX_EXTRACTED_BYTES) {
        throw new EpubError('tooLarge', 'This EPUB expands to more than 1 GiB.')
      }
      const nameAt = at + 46
      if (nameAt + nameLen > len) throw new EpubError('corrupt', 'The EPUB archive has a damaged entry name.')
      const bytes = new Uint8Array(this.buffer, nameAt, nameLen)
      // Bit 11 says UTF-8; the flag is advisory in too many real archives to
      // refuse a non-UTF-8 name outright, so decode leniently either way.
      const rawName = new TextDecoder('utf-8').decode(bytes)
      const name = canonicalArchivePath(rawName)
      if (name) {
        if (this.entries.has(name)) {
          throw new EpubError('corrupt', 'The EPUB archive has two entries named ' + name + '.')
        }
        this.entries.set(name, { name, method, compressedSize, uncompressedSize, localOffset })
      }
      at = nameAt + nameLen + extraLen + commentLen
    }
  }

  has(name: string): boolean {
    return this.entries.has(name)
  }

  names(): string[] {
    return [...this.entries.keys()]
  }

  async bytes(name: string): Promise<Uint8Array | null> {
    const key = canonicalArchivePath(name)
    const hit = this.cache.get(key)
    if (hit) return hit
    const entry = this.entries.get(key)
    if (!entry) return null
    const local = entry.localOffset
    if (this.u32(local) !== 0x0403_4b50) {
      throw new EpubError('corrupt', 'The EPUB archive has a damaged local header.')
    }
    const nameLen = this.u16(local + 26)
    const extraLen = this.u16(local + 28)
    const dataAt = local + 30 + nameLen + extraLen
    if (dataAt + entry.compressedSize > this.view.byteLength) {
      throw new EpubError('corrupt', 'An EPUB entry runs past the end of the file.')
    }
    const compressed = new Uint8Array(this.buffer, dataAt, entry.compressedSize)
    let out: Uint8Array
    if (entry.method === 0) {
      out = compressed.slice()
    } else if (entry.method === 8) {
      const remaining = MAX_EXTRACTED_BYTES - this.extracted
      out = await inflateRaw(compressed, remaining)
    } else {
      throw new EpubError(
        'unsupported',
        'This EPUB uses ZIP compression method ' + entry.method + ', which the reader does not support.'
      )
    }
    this.extracted += out.byteLength
    if (this.extracted > MAX_EXTRACTED_BYTES) {
      throw new EpubError('tooLarge', 'This EPUB expands to more than 1 GiB.')
    }
    this.cache.set(key, out)
    return out
  }

  async text(name: string): Promise<string | null> {
    const bytes = await this.bytes(name)
    if (!bytes) return null
    return new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/, '')
  }

  clear(): void {
    this.cache.clear()
  }
}

async function inflateRaw(data: Uint8Array, limit: number): Promise<Uint8Array> {
  if (limit <= 0) throw new EpubError('tooLarge', 'This EPUB expands to more than 1 GiB.')
  // A fresh buffer, not the archive view: `BlobPart` is typed over
  // `ArrayBuffer`, and the view's offset must not be lost in the conversion.
  const copy = new Uint8Array(data.length)
  copy.set(data)
  let stream: ReadableStream<Uint8Array>
  try {
    stream = new Blob([copy.buffer])
      .stream()
      .pipeThrough(new DecompressionStream('deflate-raw'))
  } catch {
    throw new EpubError('unsupported', 'This EPUB uses a DEFLATE stream the reader cannot open.')
  }
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      // COUNT WHILE INFLATING.  Checking `uncompressedSize` from the central
      // directory first trusted a number the archive's author controls; a
      // tiny stream could allocate gigabytes before the old post-check.
      if (total > limit) {
        await reader.cancel()
        throw new EpubError('tooLarge', 'This EPUB expands to more than 1 GiB.')
      }
      chunks.push(value)
    }
  } catch (err) {
    if (err instanceof EpubError) throw err
    throw new EpubError('corrupt', 'An EPUB entry is not a valid DEFLATE stream.')
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.byteLength
  }
  return out
}

/* ── the book model ───────────────────────────────────────────────────────── */

export interface EpubMetadata {
  title: string
  author: string
  language: string
}

export interface EpubTocEntry {
  title: string
  /** Archive path of the target document. */
  href: string
  /** Decoded fragment inside that document; '' when the entry names the top. */
  fragment: string
  /** Nesting depth, 0 = top level. */
  depth: number
  /** 0-based spine index, or -1 when the target is not in the spine. */
  chapter: number
}

export interface EpubChapter {
  /** 0-based spine index. */
  index: number
  href: string
  title: string
  body: XmlElement
  /** Collapsed visible text.  The reader flattens it for Mod-F search. */
  text: string
  /** Inherited writing direction/language from <html>/<body>, if any. */
  dir: string
  lang: string
}

interface ManifestItem {
  id: string
  href: string
  mediaType: string
  properties: string
}

interface TocDraft {
  title: string
  href: string
  fragment: string
  depth: number
}

export class EpubBook {
  readonly metadata: EpubMetadata
  readonly chapters: EpubChapter[]
  readonly toc: EpubTocEntry[]
  private readonly zip: ZipArchive
  private readonly manifest: readonly ManifestItem[]
  private readonly byHref: ReadonlyMap<string, number>

  constructor(
    zip: ZipArchive,
    metadata: EpubMetadata,
    chapters: EpubChapter[],
    toc: EpubTocEntry[],
    manifest: ManifestItem[],
    byHref: Map<string, number>
  ) {
    this.zip = zip
    this.metadata = metadata
    this.chapters = chapters
    this.toc = toc
    this.manifest = manifest
    this.byHref = byHref
  }

  chapterFor(href: string): number {
    return this.byHref.get(href) ?? -1
  }

  resolve(baseFile: string, href: string): ResolvedHref {
    return resolveHref(baseFile, href)
  }

  /** The manifest media type, or an extension guess for an unlisted resource. */
  mimeOf(href: string): string {
    for (const item of this.manifest) {
      if (item.href !== href) continue
      const declared = item.mediaType.split(';')[0]!.trim().toLowerCase()
      if (declared !== '') return declared === 'image/jpg' ? 'image/jpeg' : declared
    }
    const lower = href.toLowerCase()
    if (lower.endsWith('.png')) return 'image/png'
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
    if (lower.endsWith('.gif')) return 'image/gif'
    if (lower.endsWith('.webp')) return 'image/webp'
    if (lower.endsWith('.svg')) return 'image/svg+xml'
    if (lower.endsWith('.ttf')) return 'font/ttf'
    if (lower.endsWith('.otf')) return 'font/otf'
    if (lower.endsWith('.woff')) return 'font/woff'
    if (lower.endsWith('.woff2')) return 'font/woff2'
    return ''
  }

  /** One resource's bytes, for the reader's blob-URL cache. */
  async resource(href: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
    const bytes = await this.zip.bytes(href)
    if (!bytes) return null
    return { bytes, mime: this.mimeOf(href) }
  }

  destroy(): void {
    this.zip.clear()
  }
}

/* ── open ─────────────────────────────────────────────────────────────────── */

function deriveTitle(body: XmlElement, fallback: string): string {
  for (const tag of ['h1', 'h2', 'h3']) {
    const heading = findElement(body, tag)
    if (heading) {
      const text = elementText(heading)
      if (text) return text.slice(0, 200)
    }
  }
  const stem = fallback.slice(fallback.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '')
  return stem || fallback
}

function uniqueTitle(title: string, used: Set<string>, index: number): string {
  const base = title || 'Chapter ' + (index + 1)
  let out = base
  let n = 2
  while (used.has(out)) {
    out = base + ' (' + n + ')'
    n++
  }
  used.add(out)
  return out
}

export async function openEpub(buffer: ArrayBuffer): Promise<EpubBook> {
  const zip = ZipArchive.open(buffer)
  const mime = await zip.text('mimetype')
  if (mime !== null && mime.trim() !== 'application/epub+zip') {
    throw new EpubError('notEpub', 'This ZIP is not an EPUB: its mimetype is not application/epub+zip.')
  }

  const container = await zip.text('META-INF/container.xml')
  if (!container) throw new EpubError('notEpub', 'This EPUB has no META-INF/container.xml.')
  const containerDoc = parseXml(container)
  const rootfile = findElement(containerDoc, 'rootfile')
  if (!rootfile) throw new EpubError('notEpub', 'This EPUB names no package document.')
  const opfHref = attr(rootfile, 'full-path')
  if (!opfHref) throw new EpubError('notEpub', 'This EPUB names no package document.')
  const opfPath = resolveHref('', opfHref).path
  const opfText = await zip.text(opfPath)
  if (!opfText) throw new EpubError('corrupt', 'The EPUB package document is missing.')
  const opf = parseXml(opfText)
  const pkg = findElement(opf, 'package') ?? opf

  const metadataEl = findElement(pkg, 'metadata')
  const titles = metadataEl ? findElements(metadataEl, 'title') : []
  const creators = metadataEl ? findElements(metadataEl, 'creator') : []
  const languages = metadataEl ? findElements(metadataEl, 'language') : []
  const metadata: EpubMetadata = {
    title: titles.map(elementText).find((s) => s.length > 0) ?? 'Untitled book',
    author: creators.map(elementText).filter((s) => s.length > 0).join(', '),
    language: languages.map(elementText).find((s) => s.length > 0) ?? '',
  }

  const manifest: ManifestItem[] = []
  const manifestById = new Map<string, ManifestItem>()
  for (const item of findElements(pkg, 'item')) {
    const id = attr(item, 'id')
    const href = attr(item, 'href')
    if (!id || !href) continue
    if (manifestById.has(id)) {
      throw new EpubError('corrupt', 'The EPUB manifest repeats the id ' + id + '.')
    }
    const resolved = resolveHref(opfPath, href).path
    const entry: ManifestItem = {
      id,
      href: resolved,
      mediaType: attr(item, 'media-type'),
      properties: attr(item, 'properties'),
    }
    manifest.push(entry)
    manifestById.set(id, entry)
  }

  const spineEl = findElement(pkg, 'spine')
  if (!spineEl) throw new EpubError('corrupt', 'The EPUB package names no spine.')
  const spineDocs = new Set<string>()
  for (const itemref of findElements(spineEl, 'itemref')) {
    const item = manifestById.get(attr(itemref, 'idref'))
    if (item && attr(itemref, 'linear').toLowerCase() !== 'no') spineDocs.add(item.href)
  }
  if (await hasEncryptedSpine(zip, spineDocs, opfPath)) {
    throw new EpubError(
      'drm',
      'This EPUB encrypts its reading content. DRM-protected books are not supported.'
    )
  }
  const chapterList: EpubChapter[] = []
  const byHref = new Map<string, number>()
  const usedTitles = new Set<string>()
  for (const itemref of findElements(spineEl, 'itemref')) {
    const idref = attr(itemref, 'idref')
    const item = manifestById.get(idref)
    if (!item) continue
    if (attr(itemref, 'linear').toLowerCase() === 'no') continue
    if (byHref.has(item.href)) continue
    const media = item.mediaType.split(';')[0]!.trim().toLowerCase()
    const looksText =
      media === 'application/xhtml+xml' ||
      media === 'text/html' ||
      (media === '' && /\.(?:xhtml|html?|htm)$/i.test(item.href))
    if (!looksText) continue
    const text = await zip.text(item.href)
    if (text === null) continue
    const doc = parseXml(text)
    const body = findElement(doc, 'body') ?? doc
    const html = findElement(doc, 'html')
    const dir = attr(body, 'dir') || (html ? attr(html, 'dir') : '')
    const lang =
      attr(body, 'lang') ||
      attr(body, 'xml:lang') ||
      (html ? attr(html, 'lang') || attr(html, 'xml:lang') : '')
    const index = chapterList.length
    const plain = elementText(body)
    chapterList.push({
      index,
      href: item.href,
      title: uniqueTitle(deriveTitle(body, item.href), usedTitles, index),
      body,
      text: plain,
      dir: dir === 'ltr' || dir === 'rtl' || dir === 'auto' ? dir : '',
      lang,
    })
    byHref.set(item.href, index)
  }
  if (chapterList.length === 0) {
    throw new EpubError('corrupt', 'The EPUB spine contains no readable XHTML documents.')
  }

  let tocDraft: TocDraft[] = []
  try {
    tocDraft = await readNavToc(zip, manifest)
    if (tocDraft.length === 0) {
      tocDraft = await readNcxToc(zip, manifest, spineEl)
    }
  } catch {
    // A broken TOC is not a broken book: the spine still reads, and the
    // fallback below gives every chapter a row.
    tocDraft = []
  }

  const toc: EpubTocEntry[] = []
  const tocTitles = new Map<number, string>()
  for (const draft of tocDraft) {
    const chapter = byHref.get(draft.href) ?? -1
    if (chapter < 0) continue
    toc.push({
      title: draft.title || chapterList[chapter]!.title,
      href: draft.href,
      fragment: draft.fragment,
      depth: draft.depth,
      chapter,
    })
    if (!tocTitles.has(chapter) && draft.title) tocTitles.set(chapter, draft.title)
  }
  for (const chapter of chapterList) {
    const fromToc = tocTitles.get(chapter.index)
    if (fromToc) chapter.title = fromToc
  }
  if (toc.length === 0) {
    for (const chapter of chapterList) {
      toc.push({
        title: chapter.title,
        href: chapter.href,
        fragment: '',
        depth: 0,
        chapter: chapter.index,
      })
    }
  }

  return new EpubBook(zip, metadata, chapterList, toc, manifest, byHref)
}

/**
 * True when `META-INF/encryption.xml` names a SPINE document or the OPF.
 * Font obfuscation is common and harmless, so the mere presence of that file
 * is not enough: only an encrypted reading document is DRM for this reader.
 */
async function hasEncryptedSpine(
  zip: ZipArchive,
  spineDocs: ReadonlySet<string>,
  opfPath: string
): Promise<boolean> {
  const text = await zip.text('META-INF/encryption.xml')
  if (!text) return false
  const doc = parseXml(text)
  for (const ref of findElements(doc, 'cipherreference')) {
    const uri = attr(ref, 'URI')
    if (!uri) continue
    const path = resolveHref('', uri).path
    if (path === opfPath || spineDocs.has(path)) return true
  }
  return false
}

async function readNavToc(
  zip: ZipArchive,
  manifest: readonly ManifestItem[]
): Promise<TocDraft[]> {
  const navItem = manifest.find((item) => item.properties.split(/\s+/).includes('nav'))
  if (!navItem) return []
  const text = await zip.text(navItem.href)
  if (!text) return []
  const doc = parseXml(text)
  const navs = findElements(doc, 'nav')
  const nav =
    navs.find((n) => attr(n, 'type').toLowerCase().split(/\s+/).includes('toc')) ??
    navs.find((n) => attr(n, 'epub:type').toLowerCase().split(/\s+/).includes('toc'))
  if (!nav) return []
  const out: TocDraft[] = []
  const walkList = (list: XmlElement, depth: number): void => {
    for (const li of childElements(list, 'li')) {
      const anchor = childElements(li, 'a')[0] ?? childElements(li, 'span')[0]
      if (anchor) {
        const title = elementText(anchor)
        const href = attr(anchor, 'href')
        if (href) {
          const r = resolveHref(navItem.href, href)
          out.push({ title, href: r.path, fragment: r.fragment, depth })
        }
      }
      for (const nested of childElements(li, 'ol')) walkList(nested, depth + 1)
    }
  }
  for (const list of childElements(nav, 'ol')) walkList(list, 0)
  if (out.length === 0) {
    // Some nav documents are a flat run of anchors rather than nested lists.
    for (const anchor of findElements(nav, 'a')) {
      const href = attr(anchor, 'href')
      if (!href) continue
      const r = resolveHref(navItem.href, href)
      out.push({ title: elementText(anchor), href: r.path, fragment: r.fragment, depth: 0 })
    }
  }
  return out
}

async function readNcxToc(
  zip: ZipArchive,
  manifest: readonly ManifestItem[],
  spine: XmlElement
): Promise<TocDraft[]> {
  const tocId = attr(spine, 'toc')
  const ncx =
    manifest.find((item) => item.id === tocId) ??
    manifest.find((item) => item.mediaType.toLowerCase() === 'application/x-dtbncx+xml')
  if (!ncx) return []
  const text = await zip.text(ncx.href)
  if (!text) return []
  const doc = parseXml(text)
  const navMap = findElement(doc, 'navMap')
  if (!navMap) return []
  const out: TocDraft[] = []
  const walk = (parent: XmlElement, depth: number): void => {
    for (const point of childElements(parent, 'navPoint')) {
      const label = findElement(point, 'navLabel')
      const titleEl = label ? findElement(label, 'text') : null
      const content = findElement(point, 'content')
      const src = content ? attr(content, 'src') : ''
      if (src) {
        const r = resolveHref(ncx.href, src)
        out.push({
          title: titleEl ? elementText(titleEl) : '',
          href: r.path,
          fragment: r.fragment,
          depth,
        })
      }
      walk(point, depth + 1)
    }
  }
  walk(navMap, 0)
  return out
}
