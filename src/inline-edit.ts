/**
 * src/inline-edit.ts
 * Owner: 04.  Spec: CONTRACT.md §7.3 case 11 (invalid names, M52), §5.4.2 (the
 * inline title's rename reuses this filter), §5.1 (--text-error), §5.12.4.3
 * (no third scroller).
 *
 * THE SHARED rename/create inline editor.  There is ONE filter and ONE flash in
 * the app, not two that drift.  Four callers:
 *   1. new note      (the tab strip's `+`, Mod-N, the row menus)
 *   2. new folder    (the row menus — the ONLY route since §0.12 E14)
 *   3. rename        (the row menus)
 *   4. the inline title's click-to-rename (§5.4.2, owner 03) — which supplies
 *      its OWN <input class="nc-title-edit"> and calls attachNameEditor() on it,
 *      so the title keeps its H1 metrics and still shares this filter.
 *
 * THE RULE THAT MAKES IT SHARED: keystrokes are filtered by a `beforeinput`
 * handler so REJECTED CHARACTERS NEVER LAND, and the field flashes `.bad` in
 * --text-error for 200 ms.  Nothing is silently accepted-then-rejected.  On
 * `invalidName` / `alreadyExists` the editor STAYS OPEN with the message inline.
 *
 * Rust re-validates independently: `validate_name` (create/rename) and
 * `validate_rel_for_lookup` (resolution) are DIFFERENT FUNCTIONS (M52), and the
 * frontend filter is a COURTESY, NEVER THE GUARANTEE.  `validateName` below is a
 * transcription of core/src/path.rs's `validate_name`, rule for rule and in
 * the same order, so the two cannot disagree about which name is legal — but the
 * commit path still surfaces whatever Rust says, and Rust's answer wins.
 *
 * §5.12.4.3: the inline message is a small `position: fixed` element appended to
 * <body> for exactly as long as it is shown.  It never scrolls and it is never a
 * viewport-sized layer, so it cannot become the document's third scrollable box.
 */

/* ── the character rules (path.rs RESERVED + the C0 range) ─────────────────── */

/** path.rs `RESERVED`: the nine characters no vault name may contain. */
export const RESERVED_CHARS = '\\/:*?"<>|'

/** path.rs `MAX_NAME_BYTES`.  Bytes, not UTF-16 code units — a name of 128 CJK
 *  characters is 384 bytes and is refused. */
export const MAX_NAME_BYTES = 255

/** path.rs `DEVICE_NAMES`, all 22.  Compared ASCII-case-insensitively against
 *  the stem (everything before the FIRST '.'), which is what makes `NUL.md`
 *  and `nul.tar.gz` both illegal. */
const DEVICE_NAMES = [
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]

/** True for a character the `beforeinput` filter drops on sight.  These are the
 *  only rules that can be enforced per-character; every other rule in
 *  `validateName` is a property of the whole name and therefore runs at commit. */
export function isRejectedChar(ch: string): boolean {
  const cp = ch.codePointAt(0)
  if (cp === undefined) return false
  if (cp < 0x20) return true
  return RESERVED_CHARS.indexOf(ch) >= 0
}

/** Drop every rejected character from `data`, keeping the rest.  Returning the
 *  legal remainder rather than dropping the whole insertion is what makes a
 *  paste of `My: Notes` land as `My Notes` instead of silently doing nothing. */
export function sanitizeNameInput(data: string): string {
  let out = ''
  for (const ch of data) if (!isRejectedChar(ch)) out += ch
  return out
}

/** UTF-8 byte length, because path.rs measures `name.len()` in bytes. */
export function utf8Length(s: string): number {
  let n = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4
  }
  return n
}

export type NameCheck = { ok: true } | { ok: false; reason: string }

/**
 * CONTRACT §7.3 case 11, the `validate_name` row — CREATION AND RENAME TARGETS
 * ONLY.  Never applied to a lookup path: that is `validate_rel_for_lookup`, a
 * different and far weaker function (M52), and conflating the two is what made
 * legitimate notes visible-but-permanently-unopenable.
 *
 * Rule order and reason strings are core/src/path.rs:61-93 verbatim, so a
 * name refused here is refused there with the same sentence and the user never
 * sees two different explanations for one keystroke.
 */
export function validateName(name: string): NameCheck {
  if (name.length === 0) return { ok: false, reason: 'a name cannot be empty' }
  if (utf8Length(name) > MAX_NAME_BYTES)
    return { ok: false, reason: 'a name cannot be longer than 255 bytes' }
  for (const ch of name) {
    if (RESERVED_CHARS.indexOf(ch) >= 0)
      return { ok: false, reason: 'a name cannot contain \\ / : * ? " < > or |' }
    if ((ch.codePointAt(0) ?? 0) < 0x20)
      return { ok: false, reason: 'a name cannot contain control characters' }
  }
  if (name.trim().length === 0) return { ok: false, reason: 'a name cannot be only whitespace' }
  if (name === '.' || name === '..') return { ok: false, reason: '"." and ".." are not names' }
  if (name.startsWith(' ') || name.endsWith(' '))
    return { ok: false, reason: 'a name cannot start or end with a space' }
  if (name.endsWith('.')) return { ok: false, reason: 'a name cannot end with a period' }
  const stem = name.split('.')[0] ?? name
  for (const d of DEVICE_NAMES) {
    // ASCII-only folding, because path.rs compares with `eq_ignore_ascii_case`.
    // `String.toUpperCase()` is Unicode-aware and folds characters Rust leaves
    // alone, which would make the frontend refuse a name Rust accepts — a note
    // the user cannot create with no explanation that matches the real rule.
    if (eqAsciiIgnoreCase(d, stem))
      return { ok: false, reason: 'this name is reserved on Windows' }
  }
  return { ok: true }
}

/** `str::eq_ignore_ascii_case`, exactly: A-Z/a-z fold, every other code unit is
 *  compared as-is. */
function eqAsciiIgnoreCase(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    let x = a.charCodeAt(i)
    let y = b.charCodeAt(i)
    if (x >= 65 && x <= 90) x += 32
    if (y >= 65 && y <= 90) y += 32
    if (x !== y) return false
  }
  return true
}

/* ── basename helpers, shared with tabstrip.ts and the row menus ───────────── */

/** The final component of a vault-relative path.  `""` (the vault root) has no
 *  basename and returns `""`. */
export function basename(rel: string): string {
  const i = rel.lastIndexOf('/')
  return i < 0 ? rel : rel.slice(i + 1)
}

/** The parent of a vault-relative path, `""` for a top-level entry — which is
 *  exactly the `parent` argument create_note/create_folder take (§1.3). */
export function parentOf(rel: string): string {
  const i = rel.lastIndexOf('/')
  return i < 0 ? '' : rel.slice(0, i)
}

/** A note's display name: the basename with a case-insensitive `.md` removed.
 *  §3.6 keeps `.md` on the wire; only the screen drops it. */
export function displayName(rel: string): string {
  const b = basename(rel)
  return b.length > 3 && b.slice(-3).toLowerCase() === '.md' ? b.slice(0, -3) : b
}

/**
 * §0.12 E14 — `Copy absolute path`.  Joins the absolute vault root to a
 * vault-relative path.  PURE, and here rather than in main.ts because this file
 * already owns every vault-path string helper and main.ts owns nothing.
 *
 * `root` is `VaultInfo.root`, and it is the CANONICALISED root, not the user's
 * spelling: `open_vault_blocking` runs the path through `fsops::canonical_root`
 * (i.e. `fs::canonicalize`, full symlink resolution) before the walk, and the
 * arena's `root_path` — which is what `VaultInfo.root` serialises — is that
 * result.  It is canonicalised for a data-loss reason and not for tidiness: the
 * watcher reports canonical paths, so a user-spelled arena root would make every
 * fingerprint miss and turn each of our own saves into a spurious §7.3 case 7
 * conflict bar.  It is also the `state.json` key, and a test asserts the two
 * agree.
 *
 * THE CONSEQUENCE, STATED SO NOBODY IS SURPRISED BY IT: a user who opened
 * `~/Notes` through a symlink to `/Volumes/SSD/Notes` copies the second form.
 * The path is correct and resolves; it is simply not the string they typed.
 * (`fs::canonicalize` is deliberately NOT used as a traversal check anywhere —
 * that guarantee is the arena, §7.3 cases 12/13 — and this is a different use
 * of the same function, not an exception to that rule.)
 *
 * TWO CASES THAT ARE NOT COSMETIC:
 *   - `rel === ''` is the vault root itself (the empty-space menu targets it),
 *     and must yield `root` alone — `root + '/'` is a different string and some
 *     tools treat it as a different path.
 *   - a `root` that already ends in a separator (`/`, and only `/` itself does
 *     in practice) must not produce `//Notes`.  POSIX leaves a leading `//`
 *     implementation-defined, so it is trimmed rather than relied on.
 * No separator is inserted anywhere else: `rel` never begins with `/` (§1.5
 * vault-relative paths are `a/b/c.md`), which `validate_rel_for_lookup`
 * enforces on the Rust side.
 */
export function absolutePath(root: string, rel: string): string {
  const base = root.length > 1 && root.endsWith('/') ? root.slice(0, -1) : root
  if (rel === '') return base
  return base === '/' ? '/' + rel : base + '/' + rel
}

/* ── the 200 ms invalid flash ──────────────────────────────────────────────── */

/** CONTRACT §7.3 case 11 / §5.4.2: the field flashes `.bad` in --text-error for
 *  200 ms.  A CLASS TOGGLE ON A TIMER, never a CSS animation: base.css enforces
 *  `animation: none !important` app-wide (M59), so an animated flash would be
 *  silently dead. */
const FLASH_MS = 200
const flashTimers = new WeakMap<Element, number>()

export function flashBad(el: HTMLElement): void {
  const prev = flashTimers.get(el)
  if (prev !== undefined) clearTimeout(prev)
  el.classList.add('bad')
  const t = setTimeout(() => {
    el.classList.remove('bad')
    flashTimers.delete(el)
  }, FLASH_MS) as unknown as number
  flashTimers.set(el, t)
}

/* ── the editor itself ─────────────────────────────────────────────────────── */

/** What a commit handler returns.  `{ok:false}` keeps the editor OPEN with the
 *  message inline — §7.3 case 11's "nothing is silently accepted-then-rejected"
 *  and §5.4.2's "on invalidName / alreadyExists the editor stays open". */
export type CommitOutcome = { ok: true } | { ok: false; message: string }

export interface NameEditorOptions {
  /** Pre-filled text.  For a rename this is the current basename. */
  initial: string
  /** `'stem'` selects everything before the last `.` — Finder's behaviour, and
   *  what a rename wants.  `'all'` selects the lot.  Default `'all'`. */
  select?: 'all' | 'stem'
  /** Appended to the committed name before validation and before `onCommit`.
   *  `'.md'` for a new note, `''` for a folder.  Default `''`.
   *  The suffix is validated WITH the name, because `NUL` + `.md` is illegal
   *  and `NUL` alone would already have been caught anyway. */
  suffix?: string
  /**
   * Called with the full name (including `suffix`) once it passes
   * `validateName`.  Reject or return `{ok:false}` to keep the editor open.
   * A THROW is treated as `{ok:false}` with the thrown message, so a caller
   * that simply awaits an IPC call cannot accidentally close the editor over a
   * VaultError.
   */
  onCommit(name: string): Promise<CommitOutcome> | CommitOutcome
  /** Escape, or a blur when `commitOnBlur` is false. */
  onCancel?(): void
  /** §5.4.2: "blur commits".  Default true.  The tree's new-row editor uses the
   *  same default, so clicking away from a half-typed new note creates it rather
   *  than discarding what was typed. */
  commitOnBlur?: boolean
}

export interface NameEditorHandle {
  readonly input: HTMLInputElement
  /** Focus and apply the initial selection. */
  focus(): void
  /** Show (or clear, with null) the inline message under the field. */
  setMessage(text: string | null): void
  /** Close without committing.  Fires `onCancel`. */
  cancel(): void
  /** Tear down every listener and remove the message element.  Idempotent, and
   *  safe to call from inside `onCommit`. */
  destroy(): void
  /** True once the editor has committed or cancelled. */
  readonly closed: boolean
}

/**
 * Attach the shared filter, flash, commit and message behaviour to an existing
 * <input>.  The CALLER owns the element and its metrics — which is what lets the
 * inline title (§5.4.2, owner 03) share this behaviour while keeping its H1
 * box, and lets the tree (owner 04) keep its row inside its own DOM subtree.
 * No module reaches into another's subtree (spec-07 §1 rule 5).
 */
export function attachNameEditor(
  input: HTMLInputElement,
  opts: NameEditorOptions,
): NameEditorHandle {
  const suffix = opts.suffix ?? ''
  const commitOnBlur = opts.commitOnBlur !== false
  let closed = false
  let busy = false
  let msgEl: HTMLElement | null = null

  input.value = opts.initial
  input.setAttribute('spellcheck', 'false')
  input.setAttribute('autocomplete', 'off')
  input.setAttribute('autocapitalize', 'off')
  input.setAttribute('autocorrect', 'off')
  input.classList.add('inline-edit-input')

  function setMessage(text: string | null): void {
    if (text === null || text === '') {
      if (msgEl) { msgEl.remove(); msgEl = null }
      input.removeAttribute('aria-describedby')
      return
    }
    if (!msgEl) {
      msgEl = document.createElement('div')
      msgEl.className = 'inline-edit-msg'
      msgEl.id = 'inline-edit-msg'
      msgEl.setAttribute('role', 'alert')
      document.body.appendChild(msgEl)
      input.setAttribute('aria-describedby', msgEl.id)
    }
    msgEl.textContent = text
    position()
  }

  /** The message tracks the field.  `position: fixed` + explicit coordinates,
   *  clamped to the viewport — never `overflow: auto` on an ancestor, which
   *  §5.12.4.3 forbids outright. */
  function position(): void {
    if (!msgEl) return
    const r = input.getBoundingClientRect()
    const w = msgEl.offsetWidth
    const h = msgEl.offsetHeight
    const p = clampPopup(r.left, r.bottom + 2, w, h, window.innerWidth, window.innerHeight)
    msgEl.style.left = p.x + 'px'
    msgEl.style.top = p.y + 'px'
  }

  function destroy(): void {
    if (closed) return
    closed = true
    input.removeEventListener('beforeinput', onBeforeInput)
    input.removeEventListener('keydown', onKeyDown)
    input.removeEventListener('blur', onBlur)
    window.removeEventListener('resize', position)
    setMessage(null)
  }

  function cancel(): void {
    if (closed) return
    destroy()
    if (opts.onCancel) opts.onCancel()
  }

  /**
   * THE FILTER.  Rejected characters never land: `preventDefault()` on the
   * whole insertion, then re-insert only the legal remainder.  The field flashes
   * `.bad` for 200 ms so the drop is visible rather than mysterious.
   *
   * `data` covers typing and IME commits; `dataTransfer` covers paste and drop,
   * where `data` is null.  A deletion has neither and passes straight through.
   */
  function onBeforeInput(ev: Event): void {
    const e = ev as InputEvent
    let data = e.data
    if (data === null || data === undefined) {
      const dt = e.dataTransfer
      data = dt ? dt.getData('text/plain') : null
    }
    if (data === null || data === '') return
    const clean = sanitizeNameInput(data)
    if (clean === data) return
    e.preventDefault()
    flashBad(input)
    if (clean !== '') {
      const start = input.selectionStart ?? input.value.length
      const end = input.selectionEnd ?? start
      input.setRangeText(clean, start, end, 'end')
    }
    setMessage('\\ / : * ? " < > and | cannot be used in a name')
  }

  function onKeyDown(ev: KeyboardEvent): void {
    // F79: the Return or Escape that ends an IME composition belongs to the IME.
    if (ev.isComposing || ev.keyCode === 229) return
    if (ev.key === 'Enter') {
      ev.preventDefault()
      ev.stopPropagation()
      void commit()
    } else if (ev.key === 'Escape') {
      ev.preventDefault()
      // Stop here: the app-level Escape (menu dismissal, chrome.ts) must not
      // also fire off one keystroke.
      ev.stopPropagation()
      cancel()
    }
  }

  function onBlur(): void {
    if (closed || busy) return
    if (commitOnBlur) void commit()
    else cancel()
  }

  async function commit(): Promise<void> {
    if (closed || busy) return
    const name = input.value + suffix
    const v = validateName(name)
    if (!v.ok) {
      flashBad(input)
      setMessage(v.reason)
      input.focus()
      return
    }
    busy = true
    let out: CommitOutcome
    try {
      out = await opts.onCommit(name)
    } catch (err) {
      out = { ok: false, message: messageOf(err) }
    }
    busy = false
    if (closed) return
    if (out.ok) { destroy(); return }
    // §7.3 case 11 / §5.4.2: alreadyExists and invalidName keep the editor OPEN.
    flashBad(input)
    setMessage(out.message)
    input.focus()
  }

  input.addEventListener('beforeinput', onBeforeInput)
  input.addEventListener('keydown', onKeyDown)
  input.addEventListener('blur', onBlur)
  window.addEventListener('resize', position)

  const handle: NameEditorHandle = {
    input,
    focus(): void {
      input.focus()
      const sel = opts.select ?? 'all'
      if (sel === 'stem') {
        const dot = input.value.lastIndexOf('.')
        input.setSelectionRange(0, dot > 0 ? dot : input.value.length)
      } else {
        input.setSelectionRange(0, input.value.length)
      }
    },
    setMessage,
    cancel,
    destroy,
    get closed(): boolean { return closed },
  }
  return handle
}

/**
 * The tree's inline row editor: `openInlineRow(host, opts)` builds the field
 * inside a host element THE CALLER HAS ALREADY CREATED AND POSITIONED.
 *
 * That split is deliberate.  Rows are absolutely positioned inside `.sz` and
 * their depth/indent model is §5.2's, owned by tree.ts — this module must not
 * compute a row's `top` or its indent, and tree.ts must not restate the filter.
 * So the caller makes an empty `.tr.tr-edit` at the right place and hands it
 * here; this function fills it and returns the same handle `attachNameEditor`
 * returns.
 */
export function openInlineRow(host: HTMLElement, opts: NameEditorOptions): NameEditorHandle {
  const input = document.createElement('input')
  input.type = 'text'
  host.appendChild(input)
  const h = attachNameEditor(input, opts)
  h.focus()
  return h
}

/* ── shared popup placement, used here and by menu.ts ──────────────────────── */

/**
 * Clamp a `position: fixed` popup of `w`x`h` whose preferred origin is (x, y)
 * into a `vw`x`vh` viewport, with an 4px margin.
 *
 * §5.12.4.3 is why this exists as arithmetic rather than as `overflow: auto`:
 * a popup that scrolled would be the document's THIRD scrollable box, which is
 * ~23.5 MB at 2x and fails both `layers.scrollers` and G5d.  A popup that does
 * not fit is CLIPPED, and the clamp is what makes that essentially never happen.
 * Flipping above the anchor is preferred to clipping, which is why the caller
 * passes `flipY` for menus.
 */
export function clampPopup(
  x: number, y: number, w: number, h: number, vw: number, vh: number,
  flipY?: { anchorY: number },
): { x: number; y: number } {
  const M = 4
  let ox = x
  let oy = y
  if (flipY && oy + h > vh - M && flipY.anchorY - h >= M) oy = flipY.anchorY - h
  if (ox + w > vw - M) ox = vw - M - w
  if (ox < M) ox = M
  if (oy + h > vh - M) oy = vh - M - h
  if (oy < M) oy = M
  return { x: ox, y: oy }
}

/** A VaultError (§1.5) or an Error, rendered as one line.  The frontend
 *  switches on `kind` and MUST NOT parse `message`, which is OS-localised — so
 *  every sentence below is OURS, and `message` is only ever appended for `io`,
 *  where the OS string is the only thing that says what actually went wrong. */
export function messageOf(err: unknown): string {
  if (err && typeof err === 'object' && 'kind' in err) {
    const e = err as { kind: string; reason?: string; path?: string; message?: string
                       bytes?: number; limit?: number }
    switch (e.kind) {
      case 'noVault':          return 'No vault is open.'
      case 'notFound':         return 'That file no longer exists.'
      case 'alreadyExists':    return 'A file or folder with that name already exists.'
      case 'notADirectory':    return 'That is not a folder.'
      case 'notUtf8':          return 'That note is not valid UTF-8 text.'
      case 'tooLarge':         return `This note is ${mb(e.bytes)} — too large to open (the limit is ${mb(e.limit)}).`
      case 'invalidName':      return e.reason ?? 'That name cannot be used.'
      case 'invalidPath':      return e.reason ?? 'That path cannot be used.'
      case 'conflict':         return 'This note changed on disk since it was opened.'
      case 'trashUnavailable': return 'The Trash is not available for this location.'
      case 'io':               return e.message ?? 'The file could not be read or written.'
      case 'cancelled':        return 'Cancelled.'
      default:                 return 'Something went wrong.'
    }
  }
  if (err instanceof Error) return err.message
  return String(err)
}

function mb(bytes: number | undefined): string {
  if (bytes === undefined) return 'too large'
  return Math.round((bytes / (1024 * 1024)) * 10) / 10 + ' MB'
}
