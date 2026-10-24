/**
 * src/memoir.ts
 * Owner: 03.  THE MEMOIR PAGE (user feature, 2026-09-17) — a deliberate
 * divergence from the Obsidian clone, second after the secret-note viewer:
 * the fixed Memoir tab shows a journal page, not a CodeMirror note.
 *
 * A faithful clone of memoir's single-page UI (`~/Downloads/memoir`, one
 * self-contained `public/index.html`): a serif textarea and `Check`
 * (whole-entry proofread) over localhost, rendering into its own drawer.  The
 * entry text is vault-root `Memoir.md` (path arrives via deps — this module
 * does not name it); the LLM call is ai-service's `/api/memoir/check` on
 * `127.0.0.1:8770`.  Server-side entry storage (`/api/entry`) was NOT ported:
 * the vault is the store.
 *
 * Takeover shape follows the secret view (editor.css): this module mounts a
 * `#memoir` host beside `#ed` inside `main.editor`, and the shell toggles
 * `.is-memoir` on the pane — which hides the `#ed` HOST, never the CM6 view
 * (its base theme's `display: flex !important` outranks an inline style, and
 * an emptied-but-visible `#ed` keeps its `height: 100%` and pushes this view
 * below the fold).  Hidden by default, so every gate row that probes the note
 * pane never sees it.
 *
 * §6.1: no innerHTML assignment anywhere here — DOM is built with
 * `createElement` and all model text lands via `textContent`, which is also
 * what makes a correction containing `<` or `&` unable to inject markup.
 * §6.4: this module never imports `ipc.ts`; the transport arrives via deps
 * from `main.ts`, whose whole job is wiring (same seam as the totp/secrets
 * hosts).
 *
 * KNOWN GAPS (v1, recorded not hidden):
 * - An outside edit to `Memoir.md` while this page holds it is not merged:
 *   the next save either overwrites it or reports the conflict and stays
 *   dirty.  The note editor's conflict UI does not extend here yet.
 * - The upstream check panel this clones is read-only: fixes are listed as
 *   wrong → correct with a reason and applied by hand.  Its Apply wiring is
 *   dead code upstream too (no `.apply-one` element is ever created), so
 *   there was no behaviour to transcribe.
 */

/* `openMenu`/`clipMenu` is THE ONE context-menu primitive (owner 04): the
 * journal's Copy/Paste rows are built by it, never as a second floating
 * list.  `menu.ts` imports only `icons.ts`, so this is not a cycle — and
 * like the transport, `ipc.ts` itself is never imported here (§6.4). */
import { clipMenu, openMenu } from './menu'

export const MEMOIR_API = 'http://127.0.0.1:8770/api/memoir'

/** Client-side mirror of the server's cap (ai-service enforces it). */
export const MEMOIR_CHECK_MAX = 12000

/** Structural transport — `main.ts` hands down `ipc.ts`'s own functions. */
export interface MemoirTransport {
  readNote(path: string): Promise<{ text: string; mtimeMs: number; flags: number }>
  writeNote(
    path: string,
    text: string,
    flags: number,
    baseMtimeMs: number | null,
    create: boolean,
  ): Promise<{ mtimeMs: number }>
  createNote(parent: string, name?: string): Promise<{ path: string }>
}

export interface MemoirDeps {
  /** Vault-relative path of the journal file (`MEMOIR_PATH`, owned by tree.ts). */
  path: string
  transport: MemoirTransport
  onDirtyChanged(dirty: boolean): void
  /** After the lazy first create, so the shell can refresh the tree. */
  onFirstCreate(): void
  onError(err: unknown, ctx: string): void
  /**
   * §1.3 command 26, optional so older transports keep working. The journal's
   * context menu probes this to decide whether the clipboard holds text (the
   * Paste row); without it the probe falls back to
   * `navigator.clipboard.readText()` and treats a refusal as empty.
   */
  readClipboardText?(): Promise<string>
  /**
   * §1.3 command 23, optional so older transports keep working. Copy's
   * fallback when `navigator.clipboard.writeText()` rejects (see the note
   * viewer's menu for why the async clipboard stays the first try).
   */
  writeClipboardText?(text: string): Promise<void>
}

export interface MemoirView {
  show(): void
  hide(): void
  visible(): boolean
  /** Write the buffer if dirty; on failure the buffer stays dirty and the
   *  error is reported — resolution is not proof of a write. */
  flush(): Promise<void>
  isDirty(): boolean
  /**
   * F47: `nc://note-external-change` for the journal path. A clean page
   * re-reads (even hidden, so the base is current on return); a dirty page
   * keeps its buffer and the conflict surfaces on the next save.
   */
  externalChange(): void
  /** Drop the session (vault switch/close): buffer, baseline and panels. */
  reset(): void
}

/* ── wire types (ai-service's shapes, structurally) ─────────────────────── */

interface CheckIssue {
  category?: unknown
  original?: unknown
  suggestion?: unknown
  reason?: unknown
  explanation?: unknown
}

interface CheckResult {
  corrected?: unknown
  issues?: unknown
  raw?: unknown
  warning?: unknown
}

/* ── the view ───────────────────────────────────────────────────────────── */

const SAVE_IDLE_MS = 700 // memoir's own autosave beat (the note editor's 800 is CM6's)

function el(tag: string, cls: string, text?: string): HTMLElement {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

export function mountMemoir(pane: HTMLElement, deps: MemoirDeps): MemoirView {
  const t = deps.transport

  const host = el('div', '')
  host.id = 'memoir'
  host.hidden = true

  const bar = el('div', 'mm-bar')
  const tools = el('div', 'mm-tools')
  const checkBtn = document.createElement('button')
  checkBtn.type = 'button'
  checkBtn.id = 'mm-checkBtn'
  checkBtn.textContent = 'Check'
  checkBtn.title = 'Check grammar, spelling and flow with AI'
  tools.appendChild(checkBtn)
  // User ruling 2026-09-17: NO date and NO sync status on the page.  The bar
  // holds the verb alone; save state rides the tab's dirty dot.
  bar.appendChild(tools)

  // Not shown (user ruling above) but still updated: the engine's live leg
  // polls this text for the autosaved signal, and it reads in DevTools.
  const statusEl = el('div', 'mm-status')
  statusEl.id = 'mm-status'
  statusEl.hidden = true

  const frame = el('div', 'mm-frame')
  const editor = document.createElement('textarea')
  editor.id = 'mm-editor'
  editor.spellcheck = false
  ;(editor as HTMLTextAreaElement).autocapitalize = 'sentences'
  editor.autocomplete = 'off'
  editor.readOnly = true
  editor.setAttribute('aria-label', 'Journal entry')
  frame.appendChild(editor)

  const backdrop = el('div', '')
  backdrop.id = 'mm-backdrop'
  backdrop.setAttribute('aria-hidden', 'true')

  function drawer(id: string, label: string, title: string): { aside: HTMLElement; list: HTMLElement; close: HTMLButtonElement } {
    const aside = el('div', '')
    aside.id = id
    aside.setAttribute('aria-hidden', 'true')
    aside.setAttribute('aria-label', label)
    const head = el('div', 'mm-panel-head')
    const h2 = document.createElement('h2')
    h2.textContent = title
    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'mm-close'
    close.textContent = '×'
    close.setAttribute('aria-label', 'Close panel')
    head.appendChild(h2)
    head.appendChild(close)
    const scroll = el('div', 'mm-scroll')
    const list = el('div', 'mm-list')
    scroll.appendChild(list)
    aside.appendChild(head)
    aside.appendChild(scroll)
    return { aside, list, close }
  }

  const check = drawer('mm-checkPanel', 'Writing check', 'Writing check')

  host.appendChild(bar)
  host.appendChild(statusEl)
  host.appendChild(frame)
  host.appendChild(backdrop)
  host.appendChild(check.aside)
  pane.appendChild(host)

  /* state */
  let loaded = false
  let loading = false
  let baseMtime: number | null = null
  let flags = 0
  let dirty = false
  let saveTimer: number | null = null
  let inFlight = false
  let queued = false
  // F50: the session token. A load or write that is still running when the
  // vault switches belongs to the OLD vault: it must not touch the new
  // session's buffer, baseline or flags when it lands. `reset()` retires the
  // token; every application point below checks it after its await.
  let generation = 0
  // One gateway, one turn: a second Check mid-run does nothing rather than
  // billing two calls at once.
  let busy = false
  // F48: the one live LLM request, if any. A hung service must not disable
  // the button for the rest of the session: every request carries a deadline,
  // and leaving the UI (drawer close, tab leave, vault switch) cancels it. A
  // full-size entry (12000 characters) takes about 210 s to check, so the
  // deadline sits well past that.
  const LLM_DEADLINE_MS = 300_000
  let llmAbort: AbortController | null = null

  /** Cancel the live request, if any. Idempotent. */
  function abortLlm(): void {
    if (llmAbort !== null) {
      try {
        llmAbort.abort()
      } catch {
        /* already settled */
      }
      llmAbort = null
    }
  }

  /** Arm the deadline for a request that just became the live one. */
  function armLlmDeadline(): { abort: AbortController; done: () => void } {
    const abort = new AbortController()
    llmAbort = abort
    const timer = setTimeout(() => {
      try {
        abort.abort()
      } catch {
        /* already settled */
      }
    }, LLM_DEADLINE_MS)
    return {
      abort,
      done: () => {
        clearTimeout(timer)
        if (llmAbort === abort) llmAbort = null
      },
    }
  }

  function setDirty(next: boolean): void {
    if (dirty === next) return
    dirty = next
    deps.onDirtyChanged(next)
  }

  function setStatus(text: string): void {
    statusEl.textContent = text
  }

  /* entry load / save (the vault is the store) */

  async function load(): Promise<void> {
    if (loaded || loading) return
    loading = true
    // F50: retired by `reset()` below — the vault switched under the read.
    const gen = generation
    try {
      const r = await t.readNote(deps.path)
      if (gen !== generation) return
      editor.value = r.text
      baseMtime = r.mtimeMs
      flags = r.flags
      loaded = true
      editor.readOnly = false
      // A blank journal (whitespace-only, e.g. a stray newline) opens on the
      // first line: placing the caret at the end lands it past the blank, so
      // an empty-looking page starts on line 2. A real entry still opens at
      // the end for appending.
      try {
        const end = /\S/.test(r.text) ? editor.value.length : 0
        editor.setSelectionRange(end, end)
      } catch {
        /* a shim textarea may not implement selection */
      }
      setStatus('Saved')
    } catch (err) {
      const kind = err !== null && typeof err === 'object' && 'kind' in err
        ? String((err as { kind: unknown }).kind)
        : ''
      if (kind !== 'notFound') {
        deps.onError(err, 'open-memoir')
        setStatus('Could not open the journal.')
        return
      }
      // LAZY: a fresh vault gains no file until the tab is first selected.
      // `createNote` is exact-or-throw, so `alreadyExists` is the lost race
      // with a watcher refresh, not a guess about the name.
      try {
        await t.createNote('', 'Memoir')
        if (gen !== generation) return
        deps.onFirstCreate()
      } catch (cerr) {        const ckind = cerr !== null && typeof cerr === 'object' && 'kind' in cerr
          ? String((cerr as { kind: unknown }).kind)
          : ''
        if (ckind !== 'alreadyExists') {
          deps.onError(cerr, 'create-memoir')
          setStatus('Could not create the journal.')
          return
        }
      }
      try {
        const r2 = await t.readNote(deps.path)
        if (gen !== generation) return
        editor.value = r2.text
        baseMtime = r2.mtimeMs
        flags = r2.flags
        loaded = true
        editor.readOnly = false
        // Same blank rule as the first load above (this path usually holds a
        // just-created empty file, but the alreadyExists race can hold text).
        try {
          const end = /\S/.test(r2.text) ? editor.value.length : 0
          editor.setSelectionRange(end, end)
        } catch {
          /* a shim textarea may not implement selection */
        }
        setStatus('Saved')
      } catch (err2) {
        if (gen !== generation) return
        deps.onError(err2, 'open-memoir')
        setStatus('Could not open the journal.')
      }
    } finally {
      loading = false
    }
  }

  async function put(): Promise<void> {
    if (baseMtime === null) throw { kind: 'conflict', message: 'no baseline to save against' }
    const gen = generation
    const receipt = await t.writeNote(deps.path, editor.value, flags, baseMtime, false)
    // F50: retired mid-write — the receipt names the OLD vault's file.
    if (gen !== generation) throw { kind: 'conflict', message: 'the vault switched during the save' }
    baseMtime = receipt.mtimeMs
  }

  /**
   * F47: re-read the journal when the page holds no unsaved work. A clean
   * page shows the latest disk text and re-bases, so an outside edit neither
   * displays stale nor poisons the next save. A dirty page is never touched:
   * its buffer is unsaved work and only the user (Keep mine / Reload, F66)
   * may resolve it against the disk version.
   */
  async function refreshIfClean(): Promise<void> {
    if (!loaded || loading || dirty || inFlight) return
    let r: { text: string; mtimeMs: number; flags: number }
    try {
      r = await t.readNote(deps.path)
    } catch (err) {
      deps.onError(err, 'reload-memoir')
      return
    }
    if (dirty || inFlight) return // typed while the read was in flight
    if (r.text !== editor.value) editor.value = r.text
    baseMtime = r.mtimeMs
    flags = r.flags
    setStatus('Saved')
  }

  async function flushSave(): Promise<void> {
    if (!loaded || inFlight || !dirty) return
    setDirty(false)
    inFlight = true
    setStatus('Saving…')
    const gen = generation
    try {
      await put()
      if (gen !== generation) return
      setStatus('Saved')
    } catch (err) {
      // F50: a write retired mid-flight reports, but must not dirty the NEW
      // session's clean buffer.
      if (gen === generation) {
        setDirty(true)
        setStatus('Unsaved — will retry')
      }
      deps.onError(err, 'flush-memoir')
      throw err
    } finally {
      inFlight = false
      if (queued) {
        queued = false
        scheduleSave(0)
      }
    }
  }

  function scheduleSave(ms: number): void {
    if (saveTimer !== null) window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => {
      saveTimer = null
      if (!loaded) return
      if (inFlight) {
        queued = true
        return
      }
      void flushSave().catch(() => {
        /* reported inside; the buffer stays dirty for the next beat */
      })
    }, ms)
  }

  editor.addEventListener('input', () => {
    setDirty(true)
    setStatus('Editing')
    scheduleSave(SAVE_IDLE_MS)
  })
  // F82: a sidebar row dropped on the journal used to paste raw vault paths
  // as text and autosave them. Tree drags carry the private MIME (see
  // tree.ts); file drops land nowhere either (the editor refuses them too).
  editor.addEventListener('dragover', (e) => {
    const dt = e.dataTransfer
    if (!dt) return
    if (dt.types.includes('application/x-cairn-paths') || (dt.files && dt.files.length > 0)) {
      e.preventDefault()
    }
  })
  editor.addEventListener('drop', (e) => {
    const dt = e.dataTransfer
    if (!dt) return
    if (dt.types.includes('application/x-cairn-paths') || (dt.files && dt.files.length > 0)) {
      e.preventDefault()
    }
  })
  editor.addEventListener('blur', () => {
    if (dirty) scheduleSave(0)
  });
  // Right-clicking selected text must not collapse it: Chromium moves the
  // caret on a right mousedown as its default action, so by `contextmenu`
  // time the selection the user right-clicked is already gone and Copy could
  // never be offered.  Preventing the default keeps a live selection; with
  // no selection the caret still lands at the click point (the Paste target),
  // which is the native behaviour the Paste row relies on.
  editor.addEventListener('mousedown', (ev) => {
    const e = ev as MouseEvent
    if (e.button !== 2) return
    let s0 = 0
    let e0 = 0
    try {
      s0 = editor.selectionStart ?? 0
      e0 = editor.selectionEnd ?? s0
    } catch {
      return
    }
    if (e0 > s0) e.preventDefault()
  });
  // THE JOURNAL'S CONTEXT MENU (Copy/Paste, 2026-10-03): the same two rows
  // as the note viewer, built by the same `clipMenu` primitive so the two
  // cannot drift. `preventDefault()` replaces the engine's own menu (the
  // tree's §0.13 E15 rationale); the clipboard probe is async, so the menu
  // opens after it lands, at the event's own point.
  editor.addEventListener('contextmenu', (ev) => {
    onContextMenu(ev as MouseEvent)
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && dirty) scheduleSave(0)
  })

  /**
   * Copy is offered on a non-empty selection; Paste additionally needs an
   * editable journal (before the first load it is `readOnly`) and text on
   * the clipboard.  When neither holds, no menu opens at all.  The rows are
   * read AFTER the probe lands, against the live state — the selection may
   * have moved while the IPC was in flight.
   */
  function onContextMenu(ev: MouseEvent): void {
    ev.preventDefault()
    const x = ev.clientX
    const y = ev.clientY
    let start = 0
    let end = 0
    try {
      start = editor.selectionStart ?? 0
      end = editor.selectionEnd ?? start
    } catch {
      /* a shim textarea may not implement selection */
    }
    if (end <= start && editor.readOnly) return
    void (async () => {
      let clip = ''
      try {
        clip = deps.readClipboardText
          ? await deps.readClipboardText()
          : await navigator.clipboard.readText()
      } catch {
        clip = ''
      }
      if (host.hidden) return
      let s0 = start
      let e0 = end
      try {
        s0 = editor.selectionStart ?? start
        e0 = editor.selectionEnd ?? end
      } catch {
        /* keep the open-time range */
      }
      const hasSelection = e0 > s0
      const canPaste = !editor.readOnly && clip.length > 0
      if (!hasSelection && !canPaste) return
      const clipText = clip
      openMenu(
        clipMenu({
          hasSelection,
          canPaste,
          copy: () => {
            let a = s0
            let b = e0
            try {
              a = editor.selectionStart ?? s0
              b = editor.selectionEnd ?? e0
            } catch {
              /* keep the open-time range */
            }
            if (b <= a) return
            const text = editor.value.slice(a, b)
            // `navigator.clipboard` first, the IPC write as fallback (see
            // the note viewer's menu for why the unbounded async clipboard
            // stays the first try and command 23 the second).
            const fallback = (): void => {
              if (deps.writeClipboardText) {
                void deps.writeClipboardText(text).catch((err: unknown) => {
                  deps.onError(err, 'memoir-copy')
                })
              } else {
                deps.onError(new Error('clipboard write failed'), 'memoir-copy')
              }
            }
            try {
              void navigator.clipboard.writeText(text).catch(() => fallback())
            } catch (err) {
              fallback()
            }
          },
          paste: () => {
            if (editor.readOnly || !clipText) return
            try {
              editor.focus()
            } catch {
              /* a shim textarea may not implement focus */
            }
            let a = s0
            let b = e0
            try {
              a = editor.selectionStart ?? s0
              b = editor.selectionEnd ?? e0
            } catch {
              /* keep the open-time range */
            }
            // `setRangeText` is undoable and keeps the caret; the manual
            // `input` event is what marks the buffer dirty and re-arms the
            // autosave beat, exactly as a typed keystroke would.
            try {
              editor.setRangeText(clipText, a, b, 'end')
            } catch {
              return
            }
            try {
              editor.dispatchEvent(new Event('input', { bubbles: true }))
            } catch {
              /* without Event there is no dispatch to perform */
            }
          },
        }),
        { x, y, label: 'Journal actions', cls: 'ctx-clip' }
      )
    })()
  }

  /* drawer */

  function openPanel(): void {
    host.classList.add('mm-check-open')
    check.aside.setAttribute('aria-hidden', 'false')
    backdrop.setAttribute('aria-hidden', 'false')
  }

  function closePanels(): void {
    // F48: leaving the UI cancels the request behind it.
    abortLlm()
    host.classList.remove('mm-check-open')
    check.aside.setAttribute('aria-hidden', 'true')
    backdrop.setAttribute('aria-hidden', 'true')
  }

  check.close.addEventListener('click', closePanels)
  backdrop.addEventListener('click', closePanels)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && host.contains(document.activeElement)) {
      if (host.classList.contains('mm-check-open')) closePanels()
    }
  })

  editor.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey
    if (!mod || e.key !== 'Enter') return
    e.preventDefault()
    e.stopPropagation()
    void runCheck()
  })

  function emptyState(html: string): HTMLElement {
    // Static two-part messages only; all model/user text uses textContent.
    const d = el('div', 'mm-empty')
    const parts = html.split('<br>')
    parts.forEach((p, i) => {
      if (i > 0) d.appendChild(document.createElement('br'))
      if (p) {
        const node = el('span', '', p)
        d.appendChild(node)
      }
    })
    return d
  }

  function checkingAnim(head: string, sub: string): HTMLElement {
    const d = el('div', 'mm-checking')
    d.setAttribute('aria-live', 'polite')
    const ink = el('div', 'mm-ink')
    ink.setAttribute('aria-hidden', 'true')
    ink.appendChild(el('div', 'mm-ink-ring'))
    ink.appendChild(el('div', 'mm-ink-dot'))
    const lines = el('div', 'mm-lines')
    lines.setAttribute('aria-hidden', 'true')
    lines.appendChild(el('span', ''))
    lines.appendChild(el('span', ''))
    lines.appendChild(el('span', ''))
    const tx = el('div', 'mm-checking-text')
    const strong = document.createElement('strong')
    strong.textContent = head
    const em = el('em', '', sub)
    tx.appendChild(strong)
    tx.appendChild(em)
    d.appendChild(ink)
    d.appendChild(lines)
    d.appendChild(tx)
    return d
  }

  /* check */

  function renderCheck(result: CheckResult): void {
    const issues = Array.isArray(result.issues) ? (result.issues as CheckIssue[]) : []
    check.list.textContent = ''
    if (issues.length === 0) {
      if (!editor.value.trim()) {
        check.list.appendChild(emptyState('Your entry is empty.<br>Write something first.'))
      } else if (typeof result.warning === 'string' && result.warning) {
        const card = el('div', 'mm-issue')
        const body = el('div', 'mm-issue-body', typeof result.corrected === 'string' ? result.corrected : '')
        const reason = el('div', 'mm-issue-reason', result.warning)
        card.appendChild(body)
        card.appendChild(reason)
        check.list.appendChild(card)
      } else {
        const ok = el('div', 'mm-empty')
        ok.textContent = '✓ No issues. Your English looks natural here.'
        check.list.appendChild(ok)
      }
      return
    }
    issues.forEach((it, idx) => {
      const cat = String(it.category ?? 'grammar').toLowerCase()
      const orig = String(it.original ?? '')
      const sugg = String(it.suggestion ?? '')
      const reason = String(it.reason ?? it.explanation ?? '').trim() || 'fix'
      const card = el('div', 'mm-issue')
      const head = el('div', 'mm-issue-head')
      const tag = el('span', 'mm-issue-cat ' + cat, cat)
      const num = el('span', '', '#' + (idx + 1))
      head.appendChild(tag)
      head.appendChild(num)
      const body = el('div', 'mm-issue-body')
      body.appendChild(el('span', 'mm-orig', orig))
      body.appendChild(el('span', 'mm-arrow', '→'))
      body.appendChild(el('span', 'mm-sugg', sugg))
      card.appendChild(head)
      card.appendChild(body)
      card.appendChild(el('div', 'mm-issue-reason', reason))
      check.list.appendChild(card)
    })
  }

  async function runCheck(): Promise<void> {
    if (busy) return
    const content = editor.value
    if (!content.trim()) {
      openPanel()
      check.list.textContent = ''
      check.list.appendChild(emptyState('Your entry is empty.'))
      return
    }
    if (content.length > MEMOIR_CHECK_MAX) {
      openPanel()
      check.list.textContent = ''
      check.list.appendChild(emptyState('That entry is too long to check.'))
      return
    }
    busy = true
    checkBtn.disabled = true
    checkBtn.classList.add('mm-checking')
    const prevText = checkBtn.textContent
    checkBtn.textContent = 'Checking…'
    openPanel()
    check.list.textContent = ''
    check.list.appendChild(checkingAnim('Reading your entry…', 'This takes a few seconds'))
    const llm = armLlmDeadline()
    try {
      const r = await fetch(MEMOIR_API + '/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
        signal: llm.abort.signal,
      })
      const data = (await r.json().catch(() => ({}))) as CheckResult & { error?: unknown }
      if (!r.ok) {
        const msg = typeof data.error === 'string' ? data.error : 'HTTP ' + r.status
        check.list.textContent = ''
        const err = el('div', 'mm-empty')
        err.textContent = 'Could not check right now. ' + msg
        check.list.appendChild(err)
        return
      }
      renderCheck(data)
    } catch (e) {
      check.list.textContent = ''
      const err = el('div', 'mm-empty')
      err.textContent = 'Check failed: ' + (e instanceof Error ? e.message : String(e))
      check.list.appendChild(err)
    } finally {
      llm.done()
      busy = false
      checkBtn.disabled = false
      checkBtn.classList.remove('mm-checking')
      checkBtn.textContent = prevText
    }
  }

  checkBtn.addEventListener('click', () => {
    void runCheck()
  })

  /* visibility + lifecycle */

  function focusTextarea(): void {
    // User ruling 2026-09-17: selecting the tab puts the caret in the text.
    // Plain focus() preserves the caret (a return visit lands where it left);
    // the fresh load below already placed it at the end of a real entry, or
    // at the start of a blank one.
    try {
      editor.focus({ preventScroll: true })
    } catch {
      try {
        editor.focus()
      } catch {
        /* a shim textarea may not implement focus */
      }
    }
  }

  function show(): void {
    host.hidden = false
    if (loaded) {
      // F47: the page used to show whatever it last read for the whole
      // session, so an outside edit (sync from the other machine) made every
      // later save conflict forever. A clean page re-reads instead; a dirty
      // one keeps its unsaved buffer.
      void refreshIfClean()
      focusTextarea()
    } else if (!loading) {
      void load()
        .then(() => {
          if (loaded && !host.hidden) focusTextarea()
        })
        .catch(() => {
          /* reported inside */
        })
    }
  }

  function hide(): void {
    closePanels()
    host.hidden = true
  }

  return {
    show,
    hide,
    visible: () => !host.hidden,
    externalChange: () => {
      void refreshIfClean().catch(() => {
        /* reported inside */
      })
    },
    flush: async () => {
      if (saveTimer !== null) {
        window.clearTimeout(saveTimer)
        saveTimer = null
      }
      // F50: wait out the running write instead of resolving over it — a
      // flush that returns while the write is still going reports success
      // for bytes that may still fail. No time cap: the §1.6 watchdog bounds
      // the quit handshake, and a bounded wait here is what cleared a buffer
      // under its own write.
      while (inFlight) {
        await new Promise((res) => setTimeout(res, 50))
      }
      await flushSave()
      if (dirty) throw { kind: 'conflict', message: 'the journal was not saved' }
    },
    isDirty: () => dirty,
    reset: () => {
      // F50: retire the session FIRST, so a load or write still running from
      // the old vault cannot touch the new one when it lands.
      generation++
      // F48: leaving the page cancels the request behind it.
      abortLlm()
      busy = false
      checkBtn.disabled = false
      if (saveTimer !== null) {
        window.clearTimeout(saveTimer)
        saveTimer = null
      }
      // F50: explicitly orphan whatever was running — its generation check
      // discards the landing, and no timer must revive it.
      inFlight = false
      queued = false
      // F49: a switch that leaves the page visible strands a dead page (and a
      // dead tab) in the new vault — `openMemoir` early-returns on visible.
      host.hidden = true
      loaded = false
      loading = false
      baseMtime = null
      setDirty(false)
      editor.value = ''
      editor.readOnly = true
      check.list.textContent = ''
      closePanels()
      setStatus('')
    },
  }
}
