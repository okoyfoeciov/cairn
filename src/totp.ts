/**
 * src/totp.ts — the `totp` fenced block: live one-time codes, click to copy.
 * Owner: 03.  Spec: CONTRACT §0.46 E94, §5.4.5 (block widgets), §1.3 command 23.
 *
 * ===========================================================================
 * WHAT THIS IS, AND WHAT IT IS NOT
 * ===========================================================================
 * It is a REVERSE-ENGINEERING of the user's own Obsidian plugin,
 * `~/totp-obsidian-getter` — not of Obsidian.  §0.17's method ("when the
 * question is what does Obsidian do, read Obsidian") does not apply: Obsidian
 * ships nothing like this, and the reference implementation is 140 lines of
 * TypeScript this project can read directly.  The user's instruction was
 * explicit that identity is NOT the goal here — *"this is not native to
 * Obsidian… It doesn't need to be strictly identical!"* — so the divergences
 * below are DESIGN, and each one is written down with its reason.
 *
 * ── WHAT IS TRANSCRIBED EXACTLY, BECAUSE IT IS A WIRE FORMAT ───────────────
 * The algorithm is RFC 6238 and the plugin implements it correctly; both are
 * reproduced here to the bit, and `tests/frontend/totp.test.mjs` pins them
 * against RFC 6238 Appendix B's published vectors rather than against this
 * code's own output.  The BLOCK GRAMMAR is transcribed too, because the user
 * has a live credentials note full of these blocks and a parser that disagreed
 * with the plugin would silently stop producing codes for a real account.
 *
 * ── THE FIVE DIVERGENCES, ALL DELIBERATE ──────────────────────────────────
 *   1. MANY ENTRIES PER BLOCK.  The plugin joins every label with " / " and
 *      concatenates every non-comment token into ONE secret, so a block can
 *      hold exactly one account; the user's note therefore carries nine
 *      separate ```totp fences.  Here a `# Label` line OPENS an entry, so one
 *      block is a list.  Asked for directly: *"we can support a whole block of
 *      TOTPs."*  A single-entry block parses identically — see the
 *      back-compatibility note on `parseEntries`.
 *   2. THE CODE IS SHOWN, WITH ITS COUNTDOWN.  The plugin deliberately shows
 *      neither (`// confirmation only — no code, no timer`) and that is its one
 *      real usability bug: click at T-1s and you copy a code that dies before
 *      you can paste it, with nothing on screen to warn you.  Every hardware
 *      and software authenticator shows both, for that reason.
 *   3. THE SECRET IS NEVER RENDERED.  This is the security half of (2) and it
 *      is what makes (2) defensible: the widget REPLACES the fence, so the
 *      base32 seed — the thing that is worth stealing — leaves the screen,
 *      where in a plain note it sits there in plaintext.  A 30-second derived
 *      code is not the secret.  Reveal the block by putting the caret in it.
 *   4. `otpauth://` URIs are accepted, so a seed can be pasted straight from
 *      the QR-code link a provider gives you, with its own digits/period/
 *      algorithm.  The plugin hardcodes 6/30/SHA-1 and silently ignores
 *      anything else, which produces WRONG CODES rather than an error for the
 *      (rare, real) 8-digit or SHA-256 issuer.
 *   5. `+ Add TOTP secret` writes a new entry into the note, and REFUSES an
 *      unusable secret instead of writing it.  Asked for directly.
 *
 * ── AND ONE THING THE PLUGIN DOES THAT IS KEPT ────────────────────────────
 * Failure is per-entry and VISIBLE.  A bad seed renders a row with the reason
 * in it; it does not throw, does not blank the block, and does not take the
 * other eight accounts down with it.
 *
 * ── COMMENT (user feature, 2026-09-16, shared with the secrets viewer) ─────
 * One `# comment: …` line per row of text between the label and the seed is a
 * free-form note, rendered beside the label.  Old files are unaffected unless
 * a label literally used that prefix; `parseCommentLine` is the one place
 * that decides.
 *
 * ===========================================================================
 * WHY THE CLIPBOARD IS AN IPC COMMAND AND NOT `navigator.clipboard`
 * ===========================================================================
 * The plugin uses `navigator.clipboard.writeText` with a `document.execCommand`
 * fallback.  MEASURED IN THIS SHELL (2026-09-12, a real `file://` renderer):
 * the API exists and `writeText` REJECTS — *"Document is not focused."*  Every
 * windowed run this repo takes is of an unfocused window (§0.23 E45), and a
 * copy that silently fails is the worst possible outcome for a credential: the
 * user pastes whatever was in the clipboard before.  §1.3 command 23 goes
 * through Electron's own `clipboard` module in the MAIN process, which has no
 * focus requirement.
 *
 * `crypto.subtle` WAS measured in the same probe and IS available — `file://`
 * is a secure context in Chromium, `isSecureContext === true`, and HMAC-SHA-1
 * returns its 20 bytes.  So there is no hand-rolled SHA-1 here and no new Rust
 * dependency; that was checked before it was assumed.
 */

import { StateField } from '@codemirror/state'
import type { EditorState, Extension, Range } from '@codemirror/state'
import { Text } from '@codemirror/state'
import type { DecorationSet } from '@codemirror/view'
import { Decoration, EditorView, WidgetType } from '@codemirror/view'

import { blockIndex } from './livepreview'
import type { Block } from './livepreview'
import { editorFocused } from './tables'
import { paintIcons } from './icons'

/* ═══════════════════════════════════════════════════════════════════════════
 * 1.  The model — pure, and testable with no DOM and no crypto.
 * ═══════════════════════════════════════════════════════════════════════════ */

/** The hashes RFC 6238 §1.2 allows.  WebCrypto's own spelling, so the strings
 *  go straight into `importKey` without a lookup table. */
export type TotpHash = 'SHA-1' | 'SHA-256' | 'SHA-512'

export interface TotpEntry {
  /** What the row is called.  May be empty — an unlabelled seed still works. */
  readonly label: string
  /** Free-form note ("for work").  `''` when the entry has none.  Never a
   *  secret: it is rendered next to the label.  File syntax is one `# comment:`
   *  line per row of text, between the label and the seed (user feature,
   *  2026-09-16, shared with the secrets viewer). */
  readonly comment: string
  /** The base32 seed, EXACTLY as written.  Never rendered; see divergence 3. */
  readonly secret: string
  readonly digits: number
  readonly period: number
  readonly algorithm: TotpHash
  /** Non-null when this entry cannot produce a code.  The row shows it. */
  readonly error: string | null
  /** Document offsets of the line(s) this entry occupies, so a future edit or
   *  delete has somewhere to write.  `from` is the label line when there is
   *  one, otherwise the seed line. */
  readonly from: number
  readonly to: number
}

export interface TotpBlock {
  /** Start of the opening fence line. */
  readonly from: number
  /** End of the closing fence line (or the document end, when unclosed). */
  readonly to: number
  /** Where a new entry is appended: the end of the last body line, or the end
   *  of the opening fence line when the block is empty. */
  readonly insertAt: number
  readonly entries: readonly TotpEntry[]
}

const DEFAULTS = { digits: 6, period: 30, algorithm: 'SHA-1' as TotpHash }

/** RFC 4648 §6, and the plugin's own cleaning rule: case-insensitive, and
 *  spaces, dashes, underscores and `=` padding are all ignorable. Providers
 *  print seeds in groups of four and people paste them that way. */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/* The return type is spelled with its buffer, deliberately. A bare `Uint8Array`
 * is `Uint8Array<ArrayBufferLike>` in TS 5.7+, and `SubtleCrypto.importKey`
 * wants `ArrayBufferView<ArrayBuffer>` — so a bare one fails to typecheck at the
 * call in `totpCode` with an error about `SharedArrayBuffer` that says nothing
 * about the real problem. `slice` below (not `subarray`) is what makes this
 * TRUE rather than merely asserted: it copies into a fresh, exactly-sized
 * ArrayBuffer, where a subarray would be a view onto a larger one. */
export function base32Decode(input: string): Uint8Array<ArrayBuffer> {
  const cleaned = input.trim().replace(/[\s\-_=]+/g, '').toUpperCase()
  if (!cleaned) throw new Error('empty secret')
  if (!/^[A-Z2-7]+$/.test(cleaned)) throw new Error('not base32 (use A-Z and 2-7)')
  let bits = 0
  let value = 0
  let n = 0
  const bytes = new Uint8Array(Math.floor((cleaned.length * 5) / 8))
  for (let i = 0; i < cleaned.length; i++) {
    value = (value << 5) | B32.indexOf(cleaned.charAt(i))
    bits += 5
    if (bits >= 8) {
      bytes[n++] = (value >>> (bits - 8)) & 0xff
      bits -= 8
    }
  }
  // A base32 string whose length is not a multiple of 8 leaves < 8 bits over;
  // RFC 4648 says they are padding and MUST be zero. They are dropped, which is
  // what every authenticator does with an unpadded seed.
  return bytes.slice(0, n)
}

/** `SHA1` / `sha-256` / `SHA512` -> WebCrypto's spelling, or null. */
function hashOf(raw: string): TotpHash | null {
  const k = raw.trim().toUpperCase().replace('-', '')
  return k === 'SHA1' ? 'SHA-1' : k === 'SHA256' ? 'SHA-256' : k === 'SHA512' ? 'SHA-512' : null
}

/**
 * `otpauth://totp/Issuer:account?secret=…&digits=8&period=60&algorithm=SHA256`
 * — the Key URI format every provider's QR code encodes.
 *
 * `HOTP` IS REFUSED RATHER THAN TREATED AS TOTP.  It is counter-based: there is
 * no clock in it, and rendering one as a time code would show a confidently
 * wrong number forever.
 */
export function parseOtpauth(uri: string): Omit<TotpEntry, 'from' | 'to'> | null {
  let u: URL
  try {
    u = new URL(uri)
  } catch {
    return null
  }
  if (u.protocol !== 'otpauth:') return null
  // F42: `new URL` leaves a malformed %-escape (e.g. `%E9`) untouched, and
  // `decodeURIComponent` then throws URIError — out of EditorState.create,
  // which wedged the editor. Keep the raw text instead.
  const rawPath = u.pathname.replace(/^\/+/, '')
  const safeDecode = (s: string): string => {
    try { return decodeURIComponent(s) } catch { return s }
  }
  const bad = (error: string): Omit<TotpEntry, 'from' | 'to'> => ({
    label: safeDecode(rawPath) || 'otpauth',
    comment: '', secret: '', ...DEFAULTS, error,
  })
  if (u.host.toLowerCase() !== 'totp') return bad('only otpauth://totp is supported')

  const q = u.searchParams
  const secret = (q.get('secret') ?? '').trim()
  // The path is `Issuer:account` or just `account`; `?issuer=` is the canonical
  // copy and wins where both exist, which is what the spec recommends.
  const path = safeDecode(rawPath)
  const issuer = q.get('issuer')?.trim() ?? ''
  const account = path.includes(':') ? path.slice(path.indexOf(':') + 1).trim() : path
  const label = issuer && account ? issuer + ' (' + account + ')' : issuer || account || ''

  const digits = Number(q.get('digits') ?? DEFAULTS.digits)
  const period = Number(q.get('period') ?? DEFAULTS.period)
  const algorithm = hashOf(q.get('algorithm') ?? 'SHA1')

  if (!secret) return bad('otpauth URI has no secret')
  if (algorithm === null) return bad('unsupported algorithm')
  if (!Number.isInteger(digits) || digits < 6 || digits > 10) return bad('digits must be 6-10')
  if (!Number.isInteger(period) || period < 1 || period > 300) return bad('period must be 1-300s')

  return { label, comment: '', secret, digits, period, algorithm, error: validate(secret) }
}

/** `null` when the seed is usable. Runs the real decoder, so a seed that would
 *  throw at code time fails HERE instead, where the row can say why. */
function validate(secret: string): string | null {
  try {
    const b = base32Decode(secret)
    return b.length === 0 ? 'secret is too short' : null
  } catch (e) {
    return e instanceof Error ? e.message : 'invalid secret'
  }
}

/** A `# comment: …` line's text, or null when `raw` is not one.
 *
 *  Case-insensitive, so `# Comment: for work` and `#comment:x` both count.
 *  Anything else starting with `#` is a LABEL line (the plugin's rule) — the
 *  `comment:` prefix is what keeps the two apart, and a label that literally
 *  reads `comment: foo` is now a comment, which is the documented cost of the
 *  field.  The text is kept verbatim except for edge whitespace: it is
 *  rendered, never used as a key. */
export function parseCommentLine(raw: string): string | null {
  const m = /^\s*#\s*comment\s*:(.*)$/i.exec(raw)
  return m ? (m[1] ?? '').trim() : null
}

/**
 * Serialise one entry back to fence lines — the single writer behind Add and
 * Edit in both the widget and the secrets viewer, so the two cannot drift.
 * The comment is omitted when empty, so entries without one write exactly the
 * old shape (`# Label` + seed).  Multi-line comments re-emit one `# comment:`
 * line each.  `label`/`comment` must not contain newlines (the forms use
 * single-line inputs); a stray one becomes a space rather than a new entry.
 */
export function formatTotpEntry(label: string, comment: string, secretLine: string): string {
  const lines: string[] = []
  const cleanLabel = label.replace(/\s*\n+\s*/g, ' ').trim()
  if (cleanLabel) lines.push('# ' + cleanLabel)
  for (const c of comment.split('\n')) {
    if (c.trim()) lines.push('# comment: ' + c.trim())
  }
  lines.push(secretLine)
  return lines.join('\n')
}

/**
 * The block grammar.
 *
 * ── BACK-COMPATIBILITY, WHICH IS NOT OPTIONAL HERE ────────────────────────
 * The user's live credentials note holds nine of these fences, each written for
 * the plugin. On its grammar: `#` lines are labels (joined with " / "), every
 * other token is part of THE secret. On this one, a `#` line OPENS an entry.
 * For a block with one label and one seed — which is every block in that file —
 * the two produce the identical entry, and the test suite pins that shape
 * first. Consecutive `#` lines still join with " / ", exactly as the plugin
 * does, so a two-comment header does not become a labelless second row.
 *
 * WHERE THEY GENUINELY DIFFER: a seed split across two LINES. The plugin
 * concatenates it; this opens a second entry. Spaces WITHIN a line are still
 * joined, which is how providers actually print seeds ("abcd efgh ijkl"), so
 * the divergence needs a seed wrapped mid-token across a newline to appear.
 * Chosen deliberately — without it, "one block, many entries" is unparseable.
 */
export function parseEntries(body: string, bodyFrom: number): TotpEntry[] {
  const out: TotpEntry[] = []
  let cur: { label: string; comment: string[]; secret: string; from: number; to: number } | null = null
  let pos = bodyFrom

  const flush = (): void => {
    if (!cur) return
    out.push({
      label: cur.label,
      comment: cur.comment.join('\n'),
      secret: cur.secret,
      ...DEFAULTS,
      error: cur.secret ? validate(cur.secret) : 'no secret for this label',
      from: cur.from,
      to: cur.to,
    })
    cur = null
  }

  for (const raw of body.split('\n')) {
    const from = pos
    const to = pos + raw.length
    pos = to + 1
    const line = raw.trim()
    if (!line) continue

    // A `# comment:` line annotates the entry being built — or, with no entry
    // open, the coming one — and never joins the label the way a second `#`
    // line does.
    const comment = parseCommentLine(raw)
    if (comment !== null) {
      if (cur) {
        cur.comment.push(comment)
        cur.to = to
      } else {
        cur = { label: '', comment: [comment], secret: '', from, to }
      }
      continue
    }

    if (line.startsWith('#')) {
      const label = line.replace(/^#+\s*/, '').trim()
      // Two comment lines in a row are ONE label — the plugin's rule.
      if (cur && !cur.secret) {
        cur.label = cur.label ? cur.label + ' / ' + label : label
        cur.to = to
        continue
      }
      flush()
      cur = { label, comment: [], secret: '', from, to }
      continue
    }

    if (/^otpauth:/i.test(line)) {
      // A `# Label` above an otpauth URI labels THAT entry: the URI supplies
      // the seed and its parameters, the pending label (and comment) supply
      // the name.  Without this the Add form's `# label` + URI wrote an error
      // row beside the entry.
      const pending: { label: string; comment: string[]; secret: string; from: number; to: number } | null =
        cur && !cur.secret ? cur : null
      cur = null
      const parsed = parseOtpauth(line)
      if (parsed) {
        out.push({
          ...parsed,
          label: pending?.label || parsed.label,
          comment: (pending?.comment ?? []).join('\n'),
          from: pending?.from ?? from,
          to,
        })
      } else {
        // An unparseable URI consumes nothing: the pending label keeps its
        // old meaning (an error row awaiting its seed) rather than vanishing.
        cur = pending
        flush()
        out.push({ label: '', comment: '', secret: '', ...DEFAULTS, error: 'not a valid otpauth URI', from, to })
      }
      continue
    }

    // A trailing `# note` is a comment: `#` is not a base32 character, and the
    // plugin strips it the same way.
    const seed = (line.split('#')[0] ?? '').trim().replace(/\s+/g, '')
    if (!seed) continue
    if (cur && !cur.secret) {
      cur.secret = seed
      cur.to = to
      flush()
    } else {
      flush()
      cur = { label: '', comment: [], secret: seed, from, to }
      flush()
    }
  }
  flush()
  return out
}

/** The info string of a fenced block's opening line, lowercased and trimmed. */
function infoOf(doc: Text, block: Block): string {
  const line = doc.lineAt(block.from)
  const text = doc.sliceString(line.from, Math.min(line.to, line.from + 64))
  return text.replace(/^\s*(`{3,}|~{3,})/, '').trim().toLowerCase()
}

/** Every ```totp block in the document, parsed. Reads `blockIndex`, which is
 *  already maintained incrementally, so this adds no scanner of its own. */
export function totpBlocks(state: EditorState): TotpBlock[] {
  const doc = state.doc
  const out: TotpBlock[] = []
  for (const b of state.field(blockIndex).blocks) {
    if (infoOf(doc, b) !== 'totp') continue
    const openLine = doc.lineAt(b.from)
    // The closing fence is the last line of the block when the block is closed;
    // an UNCLOSED block runs to the document end and has no closing line, so the
    // body simply runs to `to`.
    const lastLine = doc.lineAt(Math.max(b.from, b.to))
    const closed = lastLine.from > openLine.from && /^\s*(`{3,}|~{3,})\s*$/.test(lastLine.text)
    const bodyFrom = Math.min(openLine.to + 1, doc.length)
    const bodyTo = closed ? Math.max(bodyFrom - 1, lastLine.from - 1) : b.to
    const body = bodyTo > bodyFrom ? doc.sliceString(bodyFrom, bodyTo) : ''
    out.push({
      from: b.from,
      to: b.to,
      insertAt: Math.max(openLine.to, bodyTo),
      entries: parseEntries(body, bodyFrom),
    })
  }
  return out
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 2.  RFC 6238.  Transcribed, and pinned against the RFC's own vectors.
 * ═══════════════════════════════════════════════════════════════════════════ */

/** The time step index for `nowMs`. RFC 6238 §4.2's `T`, with `T0 = 0`.
 *
 *  `secondsLeft()` stood beside this and is DELETED with the countdown that was
 *  its only caller (§0.46.6) — the same treatment `groupCode` got. An exported,
 *  tested function with no consumer is the shape §9 E4 rejects one step back
 *  from the UI: it reads as a capability the app has and does not. */
export function counterAt(nowMs: number, period: number): number {
  return Math.floor(nowMs / 1000 / period)
}

function subtle(): SubtleCrypto {
  const c = globalThis.crypto
  if (!c?.subtle) throw new Error('WebCrypto unavailable')
  return c.subtle
}

/**
 * RFC 4226 §5.3's dynamic truncation, over RFC 6238's time counter.
 *
 * The counter is written as a 64-bit big-endian integer in TWO 32-bit halves,
 * because `setUint32` is exact where a single `setBigUint64` would drag BigInt
 * into the bundle for a value that cannot exceed 2^33 before the year 10 000.
 */
export async function totpCode(entry: TotpEntry, nowMs: number = Date.now()): Promise<string> {
  const key = base32Decode(entry.secret)
  const counter = counterAt(nowMs, entry.period)
  const buf = new ArrayBuffer(8)
  const view = new DataView(buf)
  view.setUint32(0, Math.floor(counter / 0x1_0000_0000))
  view.setUint32(4, counter >>> 0)

  const k = await subtle().importKey('raw', key, { name: 'HMAC', hash: entry.algorithm }, false, ['sign'])
  const mac = new Uint8Array(await subtle().sign('HMAC', k, buf))

  const off = (mac[mac.length - 1] as number) & 0x0f
  const bin =
    (((mac[off] as number) & 0x7f) << 24) |
    (((mac[off + 1] as number) & 0xff) << 16) |
    (((mac[off + 2] as number) & 0xff) << 8) |
    ((mac[off + 3] as number) & 0xff)
  return (bin % 10 ** entry.digits).toString().padStart(entry.digits, '0')
}


/* ═══════════════════════════════════════════════════════════════════════════
 * 3.  NO TICKER, NO CODE ON SCREEN — §0.46.6, user ruling.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The first version of this file showed each code live with a one-second
 * countdown, on the argument that the plugin's `// confirmation only — no code,
 * no timer` is its one usability bug: click at T-1s and you copy a code that
 * dies before you paste it.  **The user overruled that, twice** — *"I don't want
 * code or countdown, really. Please remove it!"* — so the plugin's posture is
 * restored and this section is what is left of the machinery.
 *
 * WHAT THAT DELETED, recorded because the absence is the design:
 *   · a shared 1 Hz interval and its subscribe/unsubscribe bookkeeping;
 *   · every per-row cached code and counter;
 *   · `groupCode`, which had no other caller once nothing displays a code;
 *   · the `is-expiring` state and its three CSS rules.
 *
 * THE CODE IS GENERATED AT CLICK TIME, which is the freshest it can be — a
 * standing code would age between render and click. The expiry risk the
 * countdown existed to warn about is therefore narrowed to the paste itself and
 * is ACCEPTED, by ruling, not overlooked.
 */

/* ═══════════════════════════════════════════════════════════════════════════
 * 4.  The host — copy, and writing a new entry back into the note.
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface TotpHost {
  /** §1.3 command 23. Resolves when the text is on the clipboard. */
  copyText(text: string): Promise<void>
  onError(err: unknown, context: string): void
}

let host: TotpHost | null = null

/** `main.ts` wires this once, for the same reason `registerLinkHost` exists:
 *  this module must not import `ipc.ts` (§6.4), and a widget has no other way
 *  to reach a command. */
export function registerTotpHost(h: TotpHost | null): void {
  host = h
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 5.  The widget.
 * ═══════════════════════════════════════════════════════════════════════════ */

/** How long the "Copied" confirmation stays on a button. The plugin's own
 *  feedback is a `Notice`; a button that relabels itself is the same
 *  confirmation without a toast, and it is attached to the thing you clicked. */
const COPIED_MS = 1200

class TotpWidget extends WidgetType {
  constructor(readonly block: TotpBlock) { super() }

  /** CM6 rebuilds a widget whenever this says no, and a rebuild restarts every
   *  countdown in the block. The comparison is over the ENTRIES, not the block,
   *  so typing elsewhere in the note leaves a running block alone. */
  override eq(o: WidgetType): boolean {
    if (!(o instanceof TotpWidget)) return false
    const a = this.block.entries
    const b = o.block.entries
    if (a.length !== b.length || this.block.insertAt !== o.block.insertAt) return false
    for (let i = 0; i < a.length; i++) {
      const x = a[i] as TotpEntry
      const y = b[i] as TotpEntry
      if (
        x.label !== y.label || x.comment !== y.comment || x.secret !== y.secret || x.digits !== y.digits ||
        x.period !== y.period || x.algorithm !== y.algorithm || x.error !== y.error
      ) return false
    }
    return true
  }

  /** CM6 calls this on every rebuild. There is no interval to cancel since
   *  §0.46.6 took the ticker, but a row that was clicked in the last second
   *  holds a pending "Copied" timeout, and firing it against a detached button
   *  is a write to DOM that is no longer in the document. */
  override destroy(dom: HTMLElement): void {
    const t = (dom as HTMLElement & { __timers?: number[] }).__timers
    if (t) for (const id of t) clearTimeout(id)
  }

  override ignoreEvent(): boolean {
    // The block is a control surface: its clicks are ours, not selection
    // changes in the document underneath.
    return true
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div')
    // `.nc-block` is §5.4.2's convention and is `display: flow-root`, so this
    // widget's own margins are CONTAINED in the box CM6 measures — §0.26 E62.
    wrap.className = 'nc-block nc-totp'

    const head = document.createElement('div')
    head.className = 'nc-totp-head'
    const title = document.createElement('span')
    title.className = 'nc-totp-title'
    title.textContent = this.block.entries.length === 1 ? '1 code' : this.block.entries.length + ' codes'
    head.appendChild(title)

    const add = document.createElement('button')
    add.className = 'nc-totp-add'
    add.type = 'button'
    const plus = document.createElement('span')
    plus.className = 'nc-totp-plus'
    plus.setAttribute('data-icon', 'plus')
    add.appendChild(plus)
    add.appendChild(document.createTextNode('Add TOTP secret'))
    head.appendChild(add)
    wrap.appendChild(head)

    const rows = document.createElement('div')
    rows.className = 'nc-totp-rows'
    wrap.appendChild(rows)

    for (const e of this.block.entries) this.row(rows, e)

    if (this.block.entries.length === 0) {
      const hint = document.createElement('div')
      hint.className = 'nc-totp-empty'
      hint.textContent = 'No secrets yet.'
      rows.appendChild(hint)
    }

    const form = makeAddForm(view, this.block, add)
    wrap.appendChild(form.el)
    add.addEventListener('click', (ev) => {
      ev.preventDefault()
      form.toggle()
    })

    paintIcons(wrap)
    return wrap
  }

  /**
   * One row: a label, and nothing else.  CLICK-TO-COPY (user feature,
   * 2026-09-17, same as the secrets viewer): the row is the control, so
   * there is no Copy button — click, and the code is generated, copied, and
   * confirmed with a transient pill.  Nothing about the account is on screen
   * between clicks except its name.
   *
   * NO KEYBOARD ARM HERE, unlike the viewer's rows: this widget lives inside
   * CM6 content, where Tab is the indent key (spec-03 §7.1) and a tabindex
   * would be unreachable anyway.  The old button had the same reach.
   */
  private row(parent: HTMLElement, e: TotpEntry): void {
    const row = document.createElement('div')
    row.className = 'nc-totp-row'

    const main = document.createElement('div')
    main.className = 'nc-totp-main'
    const label = document.createElement('span')
    label.className = 'nc-totp-label'
    label.textContent = e.label || 'Unnamed'
    main.appendChild(label)
    if (e.comment) {
      const comment = document.createElement('span')
      comment.className = 'nc-totp-comment'
      comment.textContent = e.comment
      main.appendChild(comment)
    }
    row.appendChild(main)

    if (e.error !== null) {
      // VISIBLE, per-entry failure — the one behaviour of the plugin's that is
      // kept verbatim. One bad seed must not blank the other eight accounts.
      const err = document.createElement('span')
      err.className = 'nc-totp-error'
      err.textContent = e.error
      row.appendChild(err)
      row.classList.add('is-bad')
      parent.appendChild(row)
      return
    }

    row.classList.add('is-copyable')
    row.title = 'Click to copy a fresh code'
    const pill = document.createElement('span')
    pill.className = 'nc-totp-copied'
    pill.setAttribute('aria-hidden', 'true')
    row.appendChild(pill)
    parent.appendChild(row)

    let busy = false
    const show = (text: string, ok: boolean): void => {
      pill.textContent = text
      pill.classList.toggle('is-bad', !ok)
      pill.classList.add('is-on')
      this.after(pill, () => {
        // The text goes WITH the class — see `secrets.ts`'s row-copy for why.
        pill.textContent = ''
        pill.classList.remove('is-on')
        busy = false
      })
    }
    row.addEventListener('click', (ev) => {
      ev.preventDefault()
      const h = host
      if (busy || !h) return
      busy = true
      // GENERATED AT CLICK TIME, not held. A standing code would age between
      // render and click; this is the freshest the app can hand over, which is
      // what carries the expiry risk now that nothing warns about it (§0.46.6).
      void totpCode(e)
        .then((code) => h.copyText(code))
        .then(
          () => { show('Copied', true) },
          (err: unknown) => {
            show('Failed', false)
            // The user gets the word in the row AND the reason through the
            // app's own error path; a credential that did not copy must not
            // fail quietly.
            h.onError(err, 'totp-copy')
          }
        )
    })
  }

  /** A `COPIED_MS` timeout whose id is parked on the widget root, so
   *  `destroy()` can cancel it — see the note there.  The fired id is spliced
   *  out so a long-lived widget does not accumulate one number per Copy click.
   */
  private after(el: HTMLElement, fn: () => void): void {
    const rootOf = (n: HTMLElement): HTMLElement => (n.closest('.nc-totp') as HTMLElement | null) ?? n
    const root = rootOf(el) as HTMLElement & { __timers?: number[] }
    const timers = (root.__timers ??= [])
    const id = window.setTimeout(() => {
      const i = timers.indexOf(id)
      if (i >= 0) timers.splice(i, 1)
      fn()
    }, COPIED_MS)
    timers.push(id)
  }
}

/**
 * `+ Add TOTP secret`.
 *
 * IT REFUSES AN UNUSABLE SECRET RATHER THAN WRITING IT.  The whole value of the
 * button is that the next thing you see is a working code; a form that accepted
 * anything would put a broken row in a credentials file and tell you about it
 * only the next time you needed to log in.  Validation is the REAL decoder, not
 * a regex — see `validate`.
 *
 * THE WRITE IS ONE INSERT AT THE END OF THE BLOCK BODY, never a
 * re-serialisation of the fence.  Same rule §0.24.6 E55 established for the
 * Properties block, and for the same reason: a rewrite of a block the user has
 * hand-maintained can reorder or drop what it did not understand, and this
 * particular file is the one where that is least acceptable.
 */
function makeAddForm(
  view: EditorView,
  block: TotpBlock,
  addBtn: HTMLElement
): { el: HTMLElement; toggle: () => void } {
  const el = document.createElement('div')
  el.className = 'nc-totp-form'
  el.hidden = true

  const name = document.createElement('input')
  name.className = 'nc-totp-input'
  name.type = 'text'
  name.placeholder = 'Label (e.g. GitHub)'

  const comment = document.createElement('input')
  comment.className = 'nc-totp-input nc-totp-comment-input'
  comment.type = 'text'
  comment.placeholder = 'Comment (optional, e.g. for work)'
  comment.autocomplete = 'off'
  comment.spellcheck = false

  const seed = document.createElement('input')
  seed.className = 'nc-totp-input nc-totp-seed'
  seed.type = 'text'
  seed.placeholder = 'Base32 secret, or otpauth://totp/… URI'
  // `autocomplete=off` and a password manager will still not offer to fill a
  // seed field; `spellcheck=false` stops a red squiggle under every seed.
  seed.autocomplete = 'off'
  seed.spellcheck = false

  const msg = document.createElement('span')
  msg.className = 'nc-totp-msg'

  const save = document.createElement('button')
  save.className = 'nc-totp-save'
  save.type = 'button'
  save.textContent = 'Add'

  const cancel = document.createElement('button')
  cancel.className = 'nc-totp-cancel'
  cancel.type = 'button'
  cancel.textContent = 'Cancel'

  const bar = document.createElement('div')
  bar.className = 'nc-totp-formrow'
  bar.append(name, comment, seed, save, cancel)
  el.append(bar, msg)

  const close = (): void => {
    el.hidden = true
    addBtn.hidden = false
    msg.textContent = ''
    name.value = ''
    comment.value = ''
    seed.value = ''
  }

  const commit = (): void => {
    const raw = seed.value.trim()
    if (!raw) {
      msg.textContent = 'Enter a secret.'
      return
    }
    let label = name.value.trim()
    const note = comment.value.trim()
    let line = raw

    if (/^otpauth:/i.test(raw)) {
      const parsed = parseOtpauth(raw)
      if (!parsed || parsed.error !== null) {
        msg.textContent = parsed?.error ?? 'Not a valid otpauth URI.'
        return
      }
      // The URI is written VERBATIM: it carries digits/period/algorithm that a
      // bare seed line cannot, and re-encoding it could lose a parameter.
      if (!label) label = parsed.label
    } else {
      const bad = validate(raw)
      if (bad !== null) {
        msg.textContent = bad.charAt(0).toUpperCase() + bad.slice(1) + '.'
        return
      }
      line = raw.replace(/\s+/g, '')
    }

    // `\n` FIRST: `insertAt` is the END of a line, so this opens a new one and
    // cannot join itself onto the last seed. An empty block inserts after the
    // opening fence, which is the same shape.
    const text = '\n' + formatTotpEntry(label, note, line)
    view.dispatch({
      changes: { from: block.insertAt, insert: text },
      userEvent: 'input.totp',
    })
    close()
  }

  save.addEventListener('click', (ev) => { ev.preventDefault(); commit() })
  cancel.addEventListener('click', (ev) => { ev.preventDefault(); close() })
  for (const input of [name, comment, seed]) {
    input.addEventListener('keydown', (ev) => {
      // F79: the Return or Escape that ends an IME composition belongs to the IME.
      if (ev.isComposing || ev.keyCode === 229) return
      if (ev.key === 'Enter') { ev.preventDefault(); commit() }
      else if (ev.key === 'Escape') { ev.preventDefault(); close() }
    })
  }

  return {
    el,
    toggle: () => {
      el.hidden = false
      addBtn.hidden = true
      seed.value = ''
      comment.value = ''
      name.value = ''
      msg.textContent = ''
      name.focus()
    },
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 6.  The extension.
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * §5.4.1's reveal at block scale, exactly as `tables.ts` does it: a block whose
 * range the selection touches shows its source — which is how you edit or
 * delete a secret — and an UNFOCUSED editor reveals nothing (§0.23 E48).
 *
 * The reveal is also the security story for editing: to see a seed you must put
 * the caret in the block, deliberately.
 */
function decorate(state: EditorState): DecorationSet {
  const blocks = totpBlocks(state)
  if (blocks.length === 0) return Decoration.none
  const focused = state.field(editorFocused)
  const ranges: Range<Decoration>[] = []
  for (const b of blocks) {
    let touched = false
    if (focused) {
      for (const r of state.selection.ranges) {
        if (r.to >= b.from && r.from <= b.to) { touched = true; break }
      }
    }
    if (touched) continue
    ranges.push(Decoration.replace({ block: true, widget: new TotpWidget(b) }).range(b.from, b.to))
  }
  return Decoration.set(ranges, true)
}

export const totpDecorations = StateField.define<DecorationSet>({
  create: (state) => decorate(state),
  update(deco, tr) {
    const refocused = tr.startState.field(editorFocused) !== tr.state.field(editorFocused)
    if (!tr.docChanged && !tr.selection && !refocused) return deco
    return decorate(tr.state)
  },
  provide: (f) => EditorView.decorations.from(f),
})

/** What `editor.ts` adds. `blockIndex` and `editorFocused` are already in the
 *  set (from `livePreview` and `tables`), so this contributes one field. */
export const totp: Extension = [totpDecorations]
