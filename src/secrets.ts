/**
 * src/secrets.ts — the secret file: a note that renders as a credentials
 * manager instead of as free text.
 * Owner: 03.  Spec: user feature, 2026-09-16 (no contract section yet).
 *
 * ===========================================================================
 * WHAT THIS IS
 * ===========================================================================
 * A note whose frontmatter carries `cairn-type: secrets` is not edited as
 * markdown at all.  The editor hides its CodeMirror view and mounts this
 * module's viewer in its place: two sections — TOTP codes and secret texts
 * (passwords, API keys, tokens) — each row a label with Show/Hide, Edit and
 * Delete, and the row itself the copy control (click it; user feature,
 * 2026-09-17), each section with an Add form.  On disk it is still a normal
 * `.md` file, so sync, backup and rename keep working unchanged.
 *
 * A note WITHOUT the marker renders exactly as before — including one that
 * holds ```totp fences (the user's `Misc.md` is the standing example).  The
 * marker is the whole of the switch, and `isSecretText` below applies the
 * same strictness as the search backend's exclusion (`core/src/search.rs`
 * §8b: line 1 EXACTLY `---`, a closing `---`, the marker as its own line) so
 * the two detectors always agree on what a secret is.  It is called on the
 * editor's document, and the Rust side reproduces that text from the raw
 * bytes (one BOM stripped, lines split as CodeMirror splits them), so a BOM
 * or a CR-only file cannot be masked here and searchable there.
 *
 * ===========================================================================
 * THE FILE GRAMMAR
 * ===========================================================================
 * The body is a sequence of fenced blocks, reused and new:
 *
 *   ```totp     — the `totp.ts` grammar verbatim (E94): `# Label` opens an
 *                  entry, the next line is its seed, `otpauth://` URIs
 *                  accepted.  Parsed by `parseEntries`, NOT reimplemented.
 *   ```secret   — the parallel for opaque text: `# Label` opens an entry and
 *                  every following line up to the next label or fence is the
 *                  secret, VERBATIM.  Multi-line is allowed (PEM blocks, JSON
 *                  keys): inner blank lines are kept, leading/trailing ones
 *                  are trimmed.  Labels are REQUIRED — an entry without one,
 *                  or with no secret text, renders as a visible error row
 *                  with a Delete button, the same per-entry-failure philosophy
 *                  E94 keeps from the plugin.  So a line starting with `#`,
 *                  or one that looks like a fence, cannot be secret content:
 *                  the Add and Edit forms refuse one (`secretTextProblem`)
 *                  rather than write text that reads back differently.
 *
 *   Both fences accept `# comment: …` lines after the label: a free-form note
 *   ("for work"), one line per row of text, rendered beside the label and
 *   editable in place (user feature, 2026-09-16).  `parseCommentLine` in
 *   `totp.ts` is the one place that recognises them.
 *
 * ===========================================================================
 * THE WRITE RULE (one line, never a re-serialisation)
 * ===========================================================================
 * Every mutation is a single CM6 transaction — one insert for Add, one range
 * removal for Delete, one range replacement for Edit — so the editor's whole
 * machinery (dirty tracking, the §7.2 autosave, conflict/detached/vault-lost
 * states) keeps working unchanged.  This is §0.24.6 E55's rule and E94's,
 * applied a fourth time, for
 * the same reason: a rewrite of a credentials file could drop what it did
 * not understand, and this file is the one where that is least acceptable.
 *
 * ===========================================================================
 * WHAT IS NEVER ON SCREEN
 * ===========================================================================
 * Seeds and secret texts are written into the DOM with `textContent` only —
 * never `innerHTML` — and a text secret renders as fixed bullets until its
 * row's Show toggle is pressed.  A TOTP seed is NEVER rendered at all: its
 * row copies a freshly generated code, exactly like the `totp` widget.  Any
 * doc change re-masks every shown secret (the viewer re-renders from the
 * document), which is the safe direction to fail in.
 */

import type { EditorState } from '@codemirror/state'
import { Text } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

import { blockIndex } from './livepreview'
import type { Block } from './livepreview'
import { paintIcons } from './icons'
import { base32Decode, formatTotpEntry, parseCommentLine, parseOtpauth, totpBlocks, totpCode } from './totp'
import type { TotpBlock, TotpEntry, TotpHost } from './totp'

/** The frontmatter line that makes a note a secret file. */
export const SECRET_MARKER = 'cairn-type: secrets'

/** Bounds the marker walk, mirroring `SECRET_HEAD_LINES` in search.rs §8b. */
const MARKER_MAX_LINES = 64

/**
 * True when `text` is a secret file.  Same strictness as the Rust detector
 * (`core/src/search.rs` §8b) and as `frontmatterEnd`: line 1 EXACTLY `---`,
 * a closing line EXACTLY `---`, the marker as its own line in between —
 * nothing trimmed, because an indented marker is a nested YAML key, not this
 * file's type tag.  Scans the head only (never a full split), so calling it
 * per keystroke costs nothing on notes that do not open with `---`.  Pass it
 * the CM6 document's text: the Rust detector mirrors that, not raw bytes.
 */
export function isSecretText(text: string): boolean {
  let pos = 0
  const nextLine = (): string | null => {
    if (pos > text.length) return null
    let end = text.indexOf('\n', pos)
    if (end < 0) end = text.length
    let line = text.slice(pos, end)
    pos = end + 1
    if (line.endsWith('\r')) line = line.slice(0, -1)
    return line
  }
  if (nextLine() !== '---') return false
  let seen = false
  for (let i = 0; i < MARKER_MAX_LINES; i++) {
    const line = nextLine()
    if (line === null) return false
    if (line === '---') return seen
    if (line === SECRET_MARKER) seen = true
  }
  return false
}

/** What a fresh secret file holds: the marker plus one empty fence of each kind. */
export const SECRET_TEMPLATE =
  '---\n' + SECRET_MARKER + '\n---\n\n```totp\n```\n\n```secret\n```\n'

/* ═══════════════════════════════════════════════════════════════════════════
 * 1.  The `secret` fence model — pure, and testable with no DOM.
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface SecretEntry {
  /** What the row is called.  Empty only on the error row. */
  readonly label: string
  /** Free-form note ("for work").  `''` when the entry has none.  File syntax
   *  is one `# comment:` line per row of text after the label — the same
   *  `parseCommentLine` the `totp` fence uses, because a `#` line can never
   *  be secret content here (every one is metadata already). */
  readonly comment: string
  /** The secret text, verbatim, inner blank lines kept.  Never rendered masked. */
  readonly secret: string
  /** Non-null when this entry cannot be used.  The row shows it. */
  readonly error: string | null
  /** Document offsets of the lines this entry occupies, for Delete. */
  readonly from: number
  readonly to: number
}

export interface SecretBlock {
  /** Start of the opening fence line. */
  readonly from: number
  /** End of the closing fence line (or the document end, when unclosed). */
  readonly to: number
  /** Where a new entry is appended. */
  readonly insertAt: number
  readonly entries: readonly SecretEntry[]
}

/**
 * Serialise one `secret` entry — the single writer behind Add and Edit, so
 * the two cannot drift.  The comment is omitted when empty.  Multi-line
 * comments re-emit one `# comment:` line each.
 */
export function formatSecretEntry(label: string, comment: string, secret: string): string {
  const lines: string[] = []
  lines.push('# ' + label.replace(/\s*\n+\s*/g, ' ').trim())
  for (const c of comment.split('\n')) {
    if (c.trim()) lines.push('# comment: ' + c.trim())
  }
  lines.push(secret)
  return lines.join('\n')
}

/** Any fence run, backtick or tilde: a hand-made `~~~secret` block is closed
 *  by `~~~`, so both kinds are refused whichever block the entry lands in. */
const FENCE_LIKE_RE = /^ {0,3}(`{3,}|~{3,})/

/**
 * Why `secret` cannot be written as secret text, or null when it can.  The
 * writer emits the secret verbatim, so a line the reader would take as
 * something else must be refused here: a `#` line is a label or comment to
 * `parseSecretEntries` (it would split the entry, or show a password as a
 * label), and a fence line can end the block (the rest falls outside it).
 */
export function secretTextProblem(secret: string): string | null {
  const lines = secret.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    // `trim()` exactly as `parseSecretEntries` tests a line.
    if (line.trim().startsWith('#')) {
      return 'Line ' + (i + 1) + ' starts with "#", which this file reads as a label. ' +
        'Secret text cannot contain such a line.'
    }
    if (FENCE_LIKE_RE.test(line)) {
      return 'Line ' + (i + 1) + ' looks like a code fence (``` or ~~~), which would end the secret block. ' +
        'Secret text cannot contain such a line.'
    }
  }
  return null
}

/**
 * One entry's accumulated lines.  Values are kept RAW — a secret that opens
 * or closes with a space is still the secret — and blank trimming happens
 * once, at flush.
 */
interface Pending {
  label: string
  comment: string[]
  labelTo: number
  values: { raw: string; to: number }[]
  from: number
  to: number
}

export function parseSecretEntries(body: string, bodyFrom: number): SecretEntry[] {
  const out: SecretEntry[] = []
  let cur: Pending | null = null
  let pos = bodyFrom

  const flush = (): void => {
    if (!cur) return
    // Trim blank lines at both ends; inner ones are the secret's business.
    let lo = 0
    let hi = cur.values.length
    while (lo < hi && /^\s*$/.test(cur.values[lo]?.raw ?? '')) lo++
    while (hi > lo && /^\s*$/.test(cur.values[hi - 1]?.raw ?? '')) hi--
    const kept = cur.values.slice(lo, hi)
    // No label AND no secret is nothing, not an error — otherwise an empty
    // fence (or one holding only blank lines) would render a phantom
    // 'label required' row with nothing to delete.
    if (!cur.label && kept.length === 0) {
      cur = null
      return
    }
    const secret = kept.map((v) => v.raw).join('\n')
    const to = kept.length > 0 ? (kept[kept.length - 1]?.to ?? cur.labelTo) : cur.labelTo
    out.push({
      label: cur.label,
      comment: cur.comment.join('\n'),
      secret,
      error: !cur.label
        ? 'label required'
        : !secret
          ? 'no secret text for this label'
          : null,
      from: cur.from,
      to,
    })
    cur = null
  }

  for (const raw of body.split('\n')) {
    const from = pos
    const to = pos + raw.length
    pos = to + 1
    // A `# comment:` line annotates the entry being built (or, with no entry
    // open, the coming one) and never joins the label.  Once secret lines
    // have started, it opens the NEXT entry instead: the current one is
    // complete and every `#` line after it is metadata, not content.
    const comment = parseCommentLine(raw)
    if (comment !== null) {
      if (cur && cur.values.length === 0) {
        cur.comment.push(comment)
        cur.to = to
      } else {
        flush()
        cur = { label: '', comment: [comment], labelTo: to, values: [], from, to }
      }
      continue
    }
    if (raw.trim().startsWith('#')) {
      const label = raw.trim().replace(/^#+\s*/, '').trim()
      // Two `#` lines in a row are ONE label — the plugin's rule, kept from
      // `parseEntries` so a two-line header does not become an empty entry.
      // A pending COMMENT does not change that: the label still joins, and a
      // comment-first pending takes its label without joining on nothing.
      if (cur && cur.values.length === 0) {
        cur.label = cur.label ? cur.label + ' / ' + label : label
        cur.to = to
        cur.labelTo = to
        continue
      }
      flush()
      cur = { label, comment: [], labelTo: to, values: [], from, to }
      continue
    }
    if (!cur) {
      // Secret lines before any label: kept, so nothing silently vanishes,
      // and flagged — every entry must have a label.
      cur = { label: '', comment: [], labelTo: from, values: [], from, to: from }
    }
    cur.values.push({ raw, to })
    cur.to = to
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

/** Every ```secret block in the document, parsed.  Mirrors `totpBlocks`. */
export function secretBlocks(state: EditorState): SecretBlock[] {
  const doc = state.doc
  const out: SecretBlock[] = []
  for (const b of state.field(blockIndex).blocks) {
    if (infoOf(doc, b) !== 'secret') continue
    const openLine = doc.lineAt(b.from)
    const lastLine = doc.lineAt(Math.max(b.from, b.to))
    const closed = lastLine.from > openLine.from && /^\s*(`{3,}|~{3,})\s*$/.test(lastLine.text)
    const bodyFrom = Math.min(openLine.to + 1, doc.length)
    const bodyTo = closed ? Math.max(bodyFrom - 1, lastLine.from - 1) : b.to
    const body = bodyTo > bodyFrom ? doc.sliceString(bodyFrom, bodyTo) : ''
    out.push({
      from: b.from,
      to: b.to,
      insertAt: Math.max(openLine.to, bodyTo),
      entries: parseSecretEntries(body, bodyFrom),
    })
  }
  return out
}

export interface SecretFile {
  readonly totps: readonly TotpBlock[]
  readonly secrets: readonly SecretBlock[]
}

/** The whole secret file, both fence kinds, in document order per kind. */
export function parseSecretFile(state: EditorState): SecretFile {
  // `totpBlocks` reads the same incremental index — no second scanner, the
  // same reason `totp.ts` gives for reading `blockIndex` rather than its own.
  return { totps: totpBlocks(state), secrets: secretBlocks(state) }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 2.  The host — copy, errors, and the delete confirm.  Same shape as
 *     `TotpHost` on purpose: `main.ts` wires the same two functions there.
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface SecretsHost extends TotpHost {
  /** The app's one modal, in §7.3 case 5/6's shape: true when the user
   *  confirmed.  The Delete button sits one click from Copy and a misclick
   *  destroys a credential, so every entry delete asks first. */
  confirmDelete(label: string): Promise<boolean>
}

let host: SecretsHost | null = null

/** `main.ts` wires this once: this module must not import `ipc.ts` (§6.4). */
export function registerSecretsHost(h: SecretsHost | null): void {
  host = h
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 3.  The viewer — a full takeover of the note pane, not a widget.
 * ═══════════════════════════════════════════════════════════════════════════ */

const COPIED_MS = 1200

/** Fixed bullets, so the mask reveals nothing about the secret's length. */
const MASK = '••••••••'

function el(tag: string, cls: string, text?: string): HTMLElement {
  const e = document.createElement(tag)
  e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

/**
 * CLICK-TO-COPY (user feature, 2026-09-17): the row IS the copy control, so
 * there is no Copy button.  Clicking anywhere on a healthy row except its
 * action buttons (Show/Edit/Delete) copies, and so do Enter/Space with the
 * row focused.
 *
 * The confirmation is a transient pill at the row's end — "Copied" in the
 * accent colour, on screen for COPIED_MS, the same timing the Copy button's
 * relabel used.  A credential that did not copy still fails LOUDLY ("Failed"
 * plus the app's error path) rather than leaving yesterday's clipboard text
 * in place for the user to paste.
 */
function armRowCopy(
  row: HTMLElement,
  tip: string,
  produce: () => Promise<string>,
): void {
  row.classList.add('is-copyable')
  row.setAttribute('role', 'button')
  row.tabIndex = 0
  row.title = tip

  // Last child, so appearing never shifts Show/Edit/Delete.
  const pill = el('span', 'nc-secrets-copied')
  pill.setAttribute('aria-hidden', 'true')
  row.appendChild(pill)

  let busy = false
  let timer: number | null = null
  const show = (text: string, ok: boolean): void => {
    pill.textContent = text
    pill.classList.toggle('is-bad', !ok)
    pill.classList.add('is-on')
    if (timer !== null) window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      timer = null
      // The text goes WITH the class: a hidden pill holding yesterday's
      // "Copied" is stale state in the DOM, and `innerText` in this engine
      // reads through `display: none` (measured, 2026-09-17).
      pill.textContent = ''
      pill.classList.remove('is-on')
      busy = false
    }, COPIED_MS)
  }
  const go = (): void => {
    const h = host
    if (busy || !h) return
    busy = true
    // GENERATED AT CLICK TIME, not held: for a TOTP row this is the freshest
    // code the app can hand over (§0.46.6); for a text row it keeps the
    // secret out of the DOM until the moment it is needed.
    void produce()
      .then((text) => h.copyText(text))
      .then(
        () => { show('Copied', true) },
        (err: unknown) => {
          show('Failed', false)
          // A credential that did not copy must not fail quietly.
          h.onError(err, 'secrets-copy')
        }
      )
  }
  row.addEventListener('click', (ev) => {
    // The action buttons live inside the row: their clicks are theirs, and
    // form fields answer for themselves — nothing here may steal them.
    const t = ev.target as HTMLElement | null
    if (t && typeof t.closest === 'function' && t.closest('button, input, textarea, a')) return
    ev.preventDefault()
    go()
  })
  row.addEventListener('keydown', (ev) => {
    // The row's own key only: a focused button inside answers for itself, and
    // without this guard Enter on Edit would copy AND edit.
    if (ev.target !== row) return
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); go() }
  })
}

/** Delete asks first, through the host's confirm — a misclick on a row set
 *  for copying must not destroy a credential.  One range removal on confirm:
 *  the write rule in this file's header.
 *
 *  `from`/`to` are offsets into the document this row was rendered from, and
 *  the confirm can stay open while that document is replaced (an outside
 *  edit reloads the buffer; search can open another note).  So the delete
 *  applies only if the view still holds that exact document — CM6's `Text` is
 *  immutable, so identity means "no change since render" — and otherwise
 *  deletes nothing and says so.  The viewer has already re-rendered from the
 *  new document, so the user can press Delete again on the fresh row. */
function deleteButton(view: EditorView, label: string, from: number, to: number): HTMLButtonElement {
  // Called while rendering, so this is the document the offsets belong to.
  const rendered = view.state.doc
  const btn = document.createElement('button')
  btn.className = 'nc-secrets-delete'
  btn.type = 'button'
  btn.textContent = 'Delete'
  btn.title = 'Delete this entry'
  let busy = false
  btn.addEventListener('click', (ev) => {
    ev.preventDefault()
    const h = host
    if (busy || !h) return
    busy = true
    void h.confirmDelete(label).then(
      (ok) => {
        busy = false
        if (!ok) return
        const doc = view.state.doc
        if (doc !== rendered) {
          h.onError(
            new Error('The note changed while the delete was being confirmed; nothing was deleted.'),
            'secrets-delete'
          )
          return
        }
        // Swallow the following newline when there is one, so repeated
        // deletes do not pile blank lines into the file.
        let end = to
        if (end < doc.length && doc.sliceString(end, end + 1) === '\n') end++
        view.dispatch({ changes: { from, to: end }, userEvent: 'delete.secret' })
      },
      (err: unknown) => {
        busy = false
        h.onError(err, 'secrets-confirm')
      }
    )
  })
  return btn
}

/** The row's name block: label with the free-form comment beneath it. */
function labelMain(label: string, comment: string): HTMLElement {
  const main = el('div', 'nc-secrets-main')
  main.appendChild(el('span', 'nc-secrets-label', label || 'Unnamed'))
  if (comment) main.appendChild(el('span', 'nc-secrets-comment', comment))
  return main
}

/** Edit opens the row's inline form.  One click from Copy, like Delete — but
 *  unlike Delete it destroys nothing, so it asks nothing first. */
function editButton(open: () => void): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.className = 'nc-secrets-edit'
  btn.type = 'button'
  btn.textContent = 'Edit'
  btn.title = 'Edit label, comment and secret'
  btn.addEventListener('click', (ev) => {
    ev.preventDefault()
    open()
  })
  return btn
}

/**
 * THE EDIT RULE: one range replacement, never a re-serialisation — the write
 * rule in this file's header, applied a fourth time.  `from`/`to` are the
 * entry's own offsets, so the replacement covers exactly its lines (label,
 * comment and secret alike) and cannot touch the neighbouring entry.
 */
function replaceEntry(view: EditorView, from: number, to: number, entryText: string): void {
  view.dispatch({
    changes: { from, to, insert: entryText },
    userEvent: 'input.secret',
  })
}

function totpRow(view: EditorView, parent: HTMLElement, e: TotpEntry): void {
  const row = el('div', 'nc-secrets-row')
  row.appendChild(labelMain(e.label, e.comment))
  if (e.error !== null) {
    // VISIBLE, per-entry failure — E94's one kept behaviour: one bad seed
    // must not take the other accounts down with it.  Edit is offered here
    // too, so a typo is fixed rather than re-typed.
    row.classList.add('is-bad')
    row.appendChild(el('span', 'nc-secrets-error', e.error))
    const bad = totpEditForm(view, e)
    row.appendChild(editButton(() => { bad.form.hidden ? bad.open() : bad.form.hidden = true }))
    row.appendChild(deleteButton(view, e.label || 'Unnamed', e.from, e.to))
    parent.appendChild(row)
    parent.appendChild(bad.form)
    return
  }
  const form = totpEditForm(view, e)
  row.appendChild(editButton(() => { form.form.hidden ? form.open() : form.form.hidden = true }))
  row.appendChild(deleteButton(view, e.label || 'Unnamed', e.from, e.to))
  parent.appendChild(row)
  parent.appendChild(form.form)
  armRowCopy(row, 'Click to copy a fresh code', () => totpCode(e))
}

function secretRow(view: EditorView, parent: HTMLElement, e: SecretEntry): void {
  const row = el('div', 'nc-secrets-row')
  row.appendChild(labelMain(e.label, e.comment))
  if (e.error !== null) {
    row.classList.add('is-bad')
    row.appendChild(el('span', 'nc-secrets-error', e.error))
    const bad = secretEditForm(view, e)
    row.appendChild(editButton(() => { bad.form.hidden ? bad.open() : bad.form.hidden = true }))
    row.appendChild(deleteButton(view, e.label || 'Unnamed', e.from, e.to))
    parent.appendChild(row)
    parent.appendChild(bad.form)
    return
  }
  const value = el('span', 'nc-secrets-value', MASK)
  row.appendChild(value)
  const show = document.createElement('button')
  show.className = 'nc-secrets-show'
  show.type = 'button'
  show.textContent = 'Show'
  show.title = 'Show the secret'
  show.addEventListener('click', (ev) => {
    ev.preventDefault()
    const showing = value.classList.toggle('is-shown')
    // `textContent`, never `innerHTML`: the secret is somebody else's bytes.
    value.textContent = showing ? e.secret : MASK
    show.textContent = showing ? 'Hide' : 'Show'
    show.title = showing ? 'Hide the secret' : 'Show the secret'
  })
  row.appendChild(show)
  const form = secretEditForm(view, e)
  row.appendChild(editButton(() => { form.form.hidden ? form.open() : form.form.hidden = true }))
  row.appendChild(deleteButton(view, e.label || 'Unnamed', e.from, e.to))
  parent.appendChild(row)
  parent.appendChild(form.form)
  armRowCopy(row, 'Click to copy the secret', () => Promise.resolve(e.secret))
}

/**
 * `+ Add TOTP secret`.  IT REFUSES AN UNUSABLE SECRET RATHER THAN WRITING
 * IT — E94's rule, and the validation is the REAL decoder, not a regex.
 */
function totpAddForm(view: EditorView, blocks: readonly TotpBlock[], addBtn: HTMLElement): FormHandle {
  const form = el('div', 'nc-secrets-form')
  form.hidden = true
  const name = document.createElement('input')
  name.className = 'nc-secrets-input'
  name.type = 'text'
  name.placeholder = 'Label (e.g. GitHub)'
  const note = document.createElement('input')
  note.className = 'nc-secrets-input'
  note.type = 'text'
  note.placeholder = 'Comment (optional, e.g. for work)'
  note.autocomplete = 'off'
  note.spellcheck = false
  const seed = document.createElement('input')
  seed.className = 'nc-secrets-input nc-secrets-seed'
  seed.type = 'text'
  seed.placeholder = 'Base32 secret, or otpauth://totp/… URI'
  seed.autocomplete = 'off'
  seed.spellcheck = false
  const msg = el('span', 'nc-secrets-msg')
  const save = el('button', 'nc-secrets-save', 'Add') as HTMLButtonElement
  save.type = 'button'
  const cancel = el('button', 'nc-secrets-cancel', 'Cancel') as HTMLButtonElement
  cancel.type = 'button'
  const bar = el('div', 'nc-secrets-formrow')
  bar.append(name, note, seed, save, cancel)
  form.append(bar, msg)

  const close = (): void => {
    form.hidden = true
    addBtn.hidden = false
    msg.textContent = ''
    name.value = ''
    note.value = ''
    seed.value = ''
  }
  const commit = (): void => {
    const raw = seed.value.trim()
    if (!raw) {
      msg.textContent = 'Enter a secret.'
      return
    }
    let label = name.value.trim()
    const comment = note.value.trim()
    let line = raw
    if (/^otpauth:/i.test(raw)) {
      const parsed = parseOtpauth(raw)
      if (!parsed || parsed.error !== null) {
        msg.textContent = parsed?.error ?? 'Not a valid otpauth URI.'
        return
      }
      // The URI is written VERBATIM: it carries digits/period/algorithm that
      // a bare seed line cannot, and re-encoding it could lose a parameter.
      if (!label) label = parsed.label
    } else {
      try {
        base32Decode(raw)
      } catch (err) {
        const m = err instanceof Error ? err.message : 'invalid secret'
        msg.textContent = m.charAt(0).toUpperCase() + m.slice(1) + '.'
        return
      }
      line = raw.replace(/\s+/g, '')
    }
    if (!label) {
      msg.textContent = 'Enter a label.'
      return
    }
    appendEntry(view, blocks, 'totp', formatTotpEntry(label, comment, line))
    close()
  }
  save.addEventListener('click', (ev) => { ev.preventDefault(); commit() })
  cancel.addEventListener('click', (ev) => { ev.preventDefault(); close() })
  for (const input of [name, note, seed]) {
    input.addEventListener('keydown', (ev) => {
      // F79: the Return or Escape that ends an IME composition belongs to the IME.
      if (ev.isComposing || ev.keyCode === 229) return
      if (ev.key === 'Enter') { ev.preventDefault(); commit() }
      else if (ev.key === 'Escape') { ev.preventDefault(); close() }
    })
  }
  return { form, open: (): void => {
    form.hidden = false
    addBtn.hidden = true
    msg.textContent = ''
    name.value = ''
    note.value = ''
    seed.value = ''
    name.focus()
  } }
}

function secretAddForm(view: EditorView, blocks: readonly SecretBlock[], addBtn: HTMLElement): FormHandle {
  const form = el('div', 'nc-secrets-form')
  form.hidden = true
  const name = document.createElement('input')
  name.className = 'nc-secrets-input'
  name.type = 'text'
  name.placeholder = 'Label (e.g. Stripe API key)'
  const note = document.createElement('input')
  note.className = 'nc-secrets-input'
  note.type = 'text'
  note.placeholder = 'Comment (optional, e.g. for work)'
  note.autocomplete = 'off'
  note.spellcheck = false
  const body = document.createElement('textarea')
  body.className = 'nc-secrets-input nc-secrets-area'
  body.placeholder = 'Secret text — one line or many'
  body.rows = 3
  body.spellcheck = false
  body.autocomplete = 'off'
  const msg = el('span', 'nc-secrets-msg')
  const save = el('button', 'nc-secrets-save', 'Add') as HTMLButtonElement
  save.type = 'button'
  const cancel = el('button', 'nc-secrets-cancel', 'Cancel') as HTMLButtonElement
  cancel.type = 'button'
  const bar = el('div', 'nc-secrets-formrow')
  bar.append(name, note, body, save, cancel)
  form.append(bar, msg)

  const close = (): void => {
    form.hidden = true
    addBtn.hidden = false
    msg.textContent = ''
    name.value = ''
    note.value = ''
    body.value = ''
  }
  const commit = (): void => {
    const label = name.value.trim()
    if (!label) {
      msg.textContent = 'Enter a label.'
      return
    }
    // The secret is opaque: no trimming inside, only blank lines off the
    // ends — leading/trailing spaces may BE the secret.
    const lines = body.value.split('\n')
    while (lines.length > 0 && /^\s*$/.test(lines[0] ?? '')) lines.shift()
    while (lines.length > 0 && /^\s*$/.test(lines[lines.length - 1] ?? '')) lines.pop()
    if (lines.length === 0) {
      msg.textContent = 'Enter the secret text.'
      return
    }
    const secret = lines.join('\n')
    const problem = secretTextProblem(secret)
    if (problem !== null) {
      msg.textContent = problem
      return
    }
    appendEntry(view, blocks, 'secret', formatSecretEntry(label, note.value.trim(), secret))
    close()
  }
  save.addEventListener('click', (ev) => { ev.preventDefault(); commit() })
  cancel.addEventListener('click', (ev) => { ev.preventDefault(); close() })
  body.addEventListener('keydown', (ev) => {
    // F79: the Return or Escape that ends an IME composition belongs to the IME.
    if (ev.isComposing || ev.keyCode === 229) return
    // Enter stays a newline inside the secret; Cmd/Ctrl+Enter commits.
    if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); commit() }
    else if (ev.key === 'Escape') { ev.preventDefault(); close() }
  })
  for (const input of [name, note]) {
    input.addEventListener('keydown', (ev) => {
      // F79: the Return or Escape that ends an IME composition belongs to the IME.
      if (ev.isComposing || ev.keyCode === 229) return
      if (ev.key === 'Enter') { ev.preventDefault(); commit() }
      else if (ev.key === 'Escape') { ev.preventDefault(); close() }
    })
  }
  return { form, open: (): void => {
    form.hidden = false
    addBtn.hidden = true
    msg.textContent = ''
    name.value = ''
    note.value = ''
    body.value = ''
    name.focus()
  } }
}

/**
 * The per-row Edit form.  Prefilled from the entry; Save validates exactly
 * like Add and then REPLACES the entry's own lines (`replaceEntry`), so the
 * neighbouring entries cannot move and nothing is re-serialised.
 */
function totpEditForm(view: EditorView, e: TotpEntry): FormHandle {
  // `nc-secrets-editform` marks the per-row forms apart from the section's
  // Add form: a bare `.nc-secrets-form` query would land on the first hidden
  // edit form instead of the Add form it wants.
  const form = el('div', 'nc-secrets-form nc-secrets-editform')
  form.hidden = true
  const name = document.createElement('input')
  name.className = 'nc-secrets-input'
  name.type = 'text'
  name.placeholder = 'Label (e.g. GitHub)'
  const note = document.createElement('input')
  note.className = 'nc-secrets-input'
  note.type = 'text'
  note.placeholder = 'Comment (optional, e.g. for work)'
  note.autocomplete = 'off'
  note.spellcheck = false
  const seed = document.createElement('input')
  seed.className = 'nc-secrets-input nc-secrets-seed'
  seed.type = 'text'
  seed.placeholder = 'Base32 secret, or otpauth://totp/… URI'
  seed.autocomplete = 'off'
  seed.spellcheck = false
  const msg = el('span', 'nc-secrets-msg')
  const save = el('button', 'nc-secrets-save', 'Save') as HTMLButtonElement
  save.type = 'button'
  const cancel = el('button', 'nc-secrets-cancel', 'Cancel') as HTMLButtonElement
  cancel.type = 'button'
  const bar = el('div', 'nc-secrets-formrow')
  bar.append(name, note, seed, save, cancel)
  form.append(bar, msg)

  const open = (): void => {
    // Read the document NOW, not from the render-time entry: an otpauth URI
    // line is kept verbatim (the parsed entry holds only its seed, and
    // re-encoding it could lose digits/period/algorithm), and a trailing
    // `# note` on a bare seed migrates into the comment field rather than
    // being dropped by the save.
    const slice = view.state.doc.sliceString(e.from, e.to)
    const lines = slice.split('\n')
    const last = (lines[lines.length - 1] ?? '').trim()
    name.value = e.label
    seed.value = /^otpauth:/i.test(last) ? last : e.secret
    let comment = e.comment
    if (!comment && e.secret && !/^otpauth:/i.test(last)) {
      const i = last.indexOf('#')
      if (i >= 0) comment = last.slice(i + 1).trim()
    }
    note.value = comment
    msg.textContent = ''
    form.hidden = false
    name.focus()
  }
  const commit = (): void => {
    const raw = seed.value.trim()
    if (!raw) {
      msg.textContent = 'Enter a secret.'
      return
    }
    const label = name.value.trim()
    if (!label) {
      msg.textContent = 'Enter a label.'
      return
    }
    const comment = note.value.trim()
    let line = raw
    if (/^otpauth:/i.test(raw)) {
      const parsed = parseOtpauth(raw)
      if (!parsed || parsed.error !== null) {
        msg.textContent = parsed?.error ?? 'Not a valid otpauth URI.'
        return
      }
      // The label travels on its own `#` line: the parser attaches a pending
      // label to a URI instead of erroring, so this round-trips to one row.
    } else {
      try {
        base32Decode(raw)
      } catch (err) {
        const m = err instanceof Error ? err.message : 'invalid secret'
        msg.textContent = m.charAt(0).toUpperCase() + m.slice(1) + '.'
        return
      }
      line = raw.replace(/\s+/g, '')
    }
    replaceEntry(view, e.from, e.to, formatTotpEntry(label, comment, line))
    form.hidden = true
  }
  save.addEventListener('click', (ev) => { ev.preventDefault(); commit() })
  cancel.addEventListener('click', (ev) => { ev.preventDefault(); form.hidden = true })
  for (const input of [name, note, seed]) {
    input.addEventListener('keydown', (ev) => {
      // F79: the Return or Escape that ends an IME composition belongs to the IME.
      if (ev.isComposing || ev.keyCode === 229) return
      if (ev.key === 'Enter') { ev.preventDefault(); commit() }
      else if (ev.key === 'Escape') { ev.preventDefault(); form.hidden = true }
    })
  }
  return { form, open }
}

function secretEditForm(view: EditorView, e: SecretEntry): FormHandle {
  // See `totpEditForm`: this class is what separates edit forms from Add.
  const form = el('div', 'nc-secrets-form nc-secrets-editform')
  form.hidden = true
  const name = document.createElement('input')
  name.className = 'nc-secrets-input'
  name.type = 'text'
  name.placeholder = 'Label (e.g. Stripe API key)'
  const note = document.createElement('input')
  note.className = 'nc-secrets-input'
  note.type = 'text'
  note.placeholder = 'Comment (optional, e.g. for work)'
  note.autocomplete = 'off'
  note.spellcheck = false
  const body = document.createElement('textarea')
  body.className = 'nc-secrets-input nc-secrets-area'
  body.rows = 3
  body.spellcheck = false
  body.autocomplete = 'off'
  const msg = el('span', 'nc-secrets-msg')
  const save = el('button', 'nc-secrets-save', 'Save') as HTMLButtonElement
  save.type = 'button'
  const cancel = el('button', 'nc-secrets-cancel', 'Cancel') as HTMLButtonElement
  cancel.type = 'button'
  const bar = el('div', 'nc-secrets-formrow')
  bar.append(name, note, body, save, cancel)
  form.append(bar, msg)

  const open = (): void => {
    name.value = e.label
    note.value = e.comment
    body.value = e.secret
    msg.textContent = ''
    form.hidden = false
    name.focus()
  }
  const commit = (): void => {
    const label = name.value.trim()
    if (!label) {
      msg.textContent = 'Enter a label.'
      return
    }
    const lines = body.value.split('\n')
    while (lines.length > 0 && /^\s*$/.test(lines[0] ?? '')) lines.shift()
    while (lines.length > 0 && /^\s*$/.test(lines[lines.length - 1] ?? '')) lines.pop()
    if (lines.length === 0) {
      msg.textContent = 'Enter the secret text.'
      return
    }
    const secret = lines.join('\n')
    const problem = secretTextProblem(secret)
    if (problem !== null) {
      msg.textContent = problem
      return
    }
    replaceEntry(view, e.from, e.to, formatSecretEntry(label, note.value.trim(), secret))
    form.hidden = true
  }
  save.addEventListener('click', (ev) => { ev.preventDefault(); commit() })
  cancel.addEventListener('click', (ev) => { ev.preventDefault(); form.hidden = true })
  body.addEventListener('keydown', (ev) => {
    // F79: the Return or Escape that ends an IME composition belongs to the IME.
    if (ev.isComposing || ev.keyCode === 229) return
    if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); commit() }
    else if (ev.key === 'Escape') { ev.preventDefault(); form.hidden = true }
  })
  for (const input of [name, note]) {
    input.addEventListener('keydown', (ev) => {
      // F79: the Return or Escape that ends an IME composition belongs to the IME.
      if (ev.isComposing || ev.keyCode === 229) return
      if (ev.key === 'Enter') { ev.preventDefault(); commit() }
      else if (ev.key === 'Escape') { ev.preventDefault(); form.hidden = true }
    })
  }
  return { form, open }
}

/**
 * ONE INSERT, never a re-serialisation.  Into the first fence of the kind,
 * or — when the file holds none (hand-edited elsewhere) — a whole new fence
 * at the end of the document.
 */
function appendEntry(
  view: EditorView,
  blocks: readonly { insertAt: number }[],
  fence: 'totp' | 'secret',
  entryText: string,
): void {
  const first = blocks[0]
  if (first) {
    // `\n` FIRST: `insertAt` is the END of a line, so this opens a new one
    // and cannot join itself onto the last entry.
    view.dispatch({
      changes: { from: first.insertAt, insert: '\n' + entryText },
      userEvent: 'input.secret',
    })
    return
  }
  const doc = view.state.doc
  const at = doc.length
  const prefix = at > 0 && doc.sliceString(at - 1, at) !== '\n' ? '\n' : ''
  view.dispatch({
    changes: { from: at, insert: prefix + '```' + fence + '\n' + entryText + '\n```\n' },
    userEvent: 'input.secret',
  })
}

interface FormHandle {
  form: HTMLElement
  open(): void
}

function section(
  title: string,
  count: number,
  addLabel: string,
  makeForm: (addBtn: HTMLElement) => FormHandle,
  fill: (rows: HTMLElement) => void,
): HTMLElement {
  const wrap = el('div', 'nc-secrets-section')
  const head = el('div', 'nc-secrets-head')
  head.appendChild(el('span', 'nc-secrets-title', count === 1 ? '1 ' + title : count + ' ' + title + 's'))
  const add = document.createElement('button')
  add.className = 'nc-secrets-add'
  add.type = 'button'
  const plus = el('span', 'nc-secrets-plus')
  plus.setAttribute('data-icon', 'plus')
  add.appendChild(plus)
  add.appendChild(document.createTextNode(addLabel))
  head.appendChild(add)
  wrap.appendChild(head)
  const rows = el('div', 'nc-secrets-rows')
  wrap.appendChild(rows)
  fill(rows)
  const handle = makeForm(add)
  wrap.appendChild(handle.form)
  add.addEventListener('click', (ev) => {
    ev.preventDefault()
    handle.open()
  })
  return wrap
}

/**
 * Re-render the whole viewer from the document.  Called when entering secret
 * mode and on every document change while in it — which re-masks every shown
 * secret, the safe direction.  Open add-forms survive because typing in them
 * never touches the document; only a commit (which closes the form) does.
 */
export function renderSecrets(root: HTMLElement, view: EditorView): void {
  root.textContent = ''
  const { totps, secrets } = parseSecretFile(view.state)
  const totpEntries: TotpEntry[] = totps.flatMap((b) => [...b.entries])
  const secretEntries = secrets.flatMap((b) => [...b.entries])

  root.appendChild(
    section('code', totpEntries.length, 'Add TOTP secret', (addBtn) => (
      totpAddForm(view, totps, addBtn)
    ), (rows) => {
      if (totpEntries.length === 0) {
        rows.appendChild(el('div', 'nc-secrets-empty', 'No TOTP secrets yet.'))
      }
      for (const e of totpEntries) totpRow(view, rows, e)
    })
  )
  root.appendChild(
    section('secret text', secretEntries.length, 'Add secret text', (addBtn) => (
      secretAddForm(view, secrets, addBtn)
    ), (rows) => {
      if (secretEntries.length === 0) {
        rows.appendChild(el('div', 'nc-secrets-empty', 'No secret texts yet.'))
      }
      for (const e of secretEntries) secretRow(view, rows, e)
    })
  )
  paintIcons(root)
}
