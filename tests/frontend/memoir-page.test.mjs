/**
 * tests/frontend/memoir-page.test.mjs — F26/F47's page half, against
 * tests/frontend/_minidom.mjs (no jsdom in the dependency set).
 *
 * F26: the quit handshake never flushed the journal page, so text typed
 * within the 700 ms debounce was silently lost on quit. The page half of the
 * fix is that `flush()` writes everything pending, including sub-debounce
 * input — `main.ts`'s `flushMemoirForClose` (wired in the same change) is
 * what calls it on the quit path.
 *
 * F47: the page read Memoir.md once per session and never again, so an
 * outside edit made every later save conflict forever, blocked leaving the
 * page, and the entry died on quit. The fix: a clean page re-reads on
 * `show()` and on `externalChange()`; a dirty page keeps its buffer.
 *
 * The transport mock enforces the base mtime the way `core/src/fsops.rs`
 * does, so a stale-base write conflicts instead of silently succeeding.
 */

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'
import { installGlobals, AElement, ADocument } from './_minidom.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '..', '..')

/** @type {any} */ let MO

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cairn-mmp-'))
  process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })
  const out = join(dir, 'bundle.mjs')
  await esbuild.build({
    stdin: {
      contents: 'export * as MO from ' + JSON.stringify(join(ROOT, 'src', 'memoir.ts')) + '\n',
      resolveDir: ROOT,
      sourcefile: 'memoir-page-test-entry.ts',
      loader: 'ts',
    },
    outfile: out, bundle: true, format: 'esm', platform: 'neutral',
    mainFields: ['module', 'main'], conditions: ['import', 'default'],
    target: 'es2021', absWorkingDir: ROOT, logLevel: 'silent',
  })
  MO = (await import(pathToFileURL(out).href)).MO

  installGlobals()
  // Test-local alias: the page uses `appendChild`, `_minidom.mjs` (owner 05)
  // spells it `append`. Augmenting the prototype here changes no owner file.
  if (typeof AElement.prototype.appendChild !== 'function') {
    AElement.prototype.appendChild = function (...kids) { return this.append(...kids) }
  }
  const doc = new ADocument()
  // `_minidom.mjs` covers elements, not the document object: the page only
  // needs these two listeners (`visibilitychange`, `keydown`,
  // `selectionchange`) plus the `hidden` flag.
  doc.listeners = new Map()
  doc.addEventListener = (t, f) => {
    if (!doc.listeners.has(t)) doc.listeners.set(t, [])
    doc.listeners.get(t).push(f)
  }
  doc.hidden = false
  globalThis.document = doc
  globalThis.window = {
    setTimeout: (...a) => setTimeout(...a),
    clearTimeout: (...a) => clearTimeout(...a),
  }
  // The paraphrase arming path schedules a frame; the tests never read it.
  if (typeof globalThis.requestAnimationFrame !== 'function') {
    globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0)
  }
})

/** A transport whose disk enforces the base mtime like `fsops.rs` step 1. */
function makeTransport(disk = { text: 'journal start\n', mtimeMs: 1000 }) {
  const calls = []
  return {
    disk,
    calls,
    async readNote() {
      calls.push({ op: 'read' })
      return { text: disk.text, mtimeMs: disk.mtimeMs, flags: 0 }
    },
    async writeNote(_path, text, _flags, base, _create) {
      calls.push({ op: 'write', text, base })
      if (base !== disk.mtimeMs) throw { kind: 'conflict', message: 'changed on disk' }
      disk.text = text
      disk.mtimeMs += 1
      return { mtimeMs: disk.mtimeMs }
    },
    async createNote() {
      throw { kind: 'alreadyExists' }
    },
  }
}

function mount(t) {
  const pane = globalThis.document.createElement('div')
  const errors = []
  const v = MO.mountMemoir(pane, {
    path: 'Memoir.md',
    transport: t,
    onDirtyChanged: () => {},
    onFirstCreate: () => {},
    onError: (e, ctx) => { errors.push([ctx, e]) },
  })
  const editor = pane.descendants().find((e) => e.tagName === 'TEXTAREA')
  assert.ok(editor, 'the page mounts a textarea')
  return { v, editor, errors }
}

const type = (editor, text) => {
  editor.value += text
  editor.dispatch('input', {})
}
const settle = () => new Promise((r) => setImmediate(r))

async function shown(t, text = t.disk.text) {
  const { v, editor, errors } = mount(t)
  v.show()
  await settle()
  await settle()
  assert.equal(editor.value, text)
  return { v, editor, errors }
}

test('F26 page half: flush() writes input that never reached the debounce', async () => {
  const t = makeTransport()
  const { v, editor } = await shown(t)
  type(editor, 'JOURNAL_TYPED')
  assert.equal(v.isDirty(), true)
  await v.flush()
  assert.equal(t.disk.text, 'journal start\nJOURNAL_TYPED')
  assert.equal(v.isDirty(), false)
})

test('F47: a clean show() picks up an outside edit and re-bases', async () => {
  const t = makeTransport()
  const { v, editor } = await shown(t)
  t.disk.text = 'outside edit\n'
  t.disk.mtimeMs += 1
  v.show()
  await settle()
  await settle()
  assert.equal(editor.value, 'outside edit\n')
  // The next save succeeds — the base was refreshed, not left stale.
  type(editor, 'mine\n')
  await v.flush()
  assert.equal(t.disk.text, 'outside edit\nmine\n')
  assert.equal(v.isDirty(), false)
})

test('F47: a dirty page keeps its buffer on show() and conflicts, not clobbers', async () => {
  const t = makeTransport()
  const { v, editor } = await shown(t)
  type(editor, 'MY ENTRY')
  t.disk.text = 'outside edit\n'
  t.disk.mtimeMs += 1
  v.show()
  await settle()
  await settle()
  assert.equal(editor.value, 'journal start\nMY ENTRY')
  const err = await v.flush().then(() => null, (e) => e)
  assert.equal(err?.kind, 'conflict')
  assert.equal(v.isDirty(), true)
  assert.equal(t.disk.text, 'outside edit\n')
})

test('F47: externalChange() re-reads when clean and keeps when dirty', async () => {
  const t = makeTransport()
  const { v, editor } = await shown(t)
  t.disk.text = 'synced\n'
  t.disk.mtimeMs += 1
  v.externalChange()
  await settle()
  await settle()
  assert.equal(editor.value, 'synced\n')
  type(editor, 'mine\n')
  t.disk.text = 'synced twice\n'
  t.disk.mtimeMs += 1
  v.externalChange()
  await settle()
  assert.equal(editor.value, 'synced\nmine\n', 'dirty buffer untouched')
})

/* F82: a sidebar row dropped on the journal lands nowhere (it used to paste
 * raw vault paths as text and autosave them). File drops land nowhere either. */
test('F82: tree drags and file drops on the journal are refused', async () => {
  const t = makeTransport()
  const { editor } = await shown(t)
  const refused = []
  const drop = (dataTransfer) => {
    let prevented = false
    editor.dispatch('drop', { dataTransfer, preventDefault: () => { prevented = true } })
    refused.push(prevented)
  }
  drop({ types: ['text/plain', 'application/x-cairn-paths'], files: [] })
  drop({ types: ['Files'], files: [{}] })
  assert.deepEqual(refused, [true, true])
  assert.equal(t.disk.text, 'journal start\n', 'the drop wrote into the journal')
})

/* F49: a vault switch while the page is showing must not strand a dead page
 * (and a dead tab) in the new vault — `openMemoir` early-returns on visible. */
test('F49: reset() hides the page, and the next show() loads fresh', async () => {
  const t = makeTransport()
  const { v, editor } = await shown(t)
  assert.equal(v.visible(), true)
  v.reset()
  assert.equal(v.visible(), false)
  t.disk.text = 'new vault journal\n'
  t.disk.mtimeMs += 1
  v.show()
  await settle()
  await settle()
  assert.equal(editor.value, 'new vault journal\n')
})

/* F50: flush() waits out a slow write instead of reporting success for bytes
 * that may still fail — the 5 s cap is what cleared a buffer under its own
 * write on a vault switch. */
test('F50: flush() does not resolve while the write is still running', async () => {
  const t = makeTransport()
  let release = null
  const origWrite = t.writeNote.bind(t)
  t.writeNote = (...a) => new Promise((res) => { release = () => origWrite(...a).then(res) })
  const { v, editor } = await shown(t)
  type(editor, 'slow\n')
  const f = v.flush()
  await settle()
  await settle()
  assert.ok(release, 'the write never started')
  let done = false
  f.then(() => { done = true }, () => { done = true })
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(done, false, 'flush() resolved while the write was still running')
  release()
  await f
  assert.equal(t.disk.text, 'journal start\nslow\n')
})

/* F50: a load or write retired by reset() cannot touch the new session when
 * it lands — neither dirtying a clean buffer nor rebasing it. */
test('F50: a write that fails after reset() leaves the new session clean', async () => {
  const t = makeTransport()
  let release = null
  t.writeNote = () => new Promise((_, rej) => { release = () => rej({ kind: 'io' }) })
  const { v, editor } = await shown(t)
  type(editor, 'doomed\n')
  const f = v.flush()
  await settle()
  await settle()
  assert.ok(release, 'the write never started')
  v.reset()
  release()
  await f.then(() => 'resolved', () => 'rejected')
  assert.equal(v.isDirty(), false, 'a retired write dirtied the new session')
  assert.equal(editor.value, '', 'a retired write touched the new buffer')
})

/* F48: an LLM request that never answers must not disable Check and Other
 * ways for the rest of the session — every request carries a deadline, and
 * leaving the page cancels it. */
test('F48: a hung Check disables nothing after reset(), and the abort lands', async () => {
  const t = makeTransport()
  const pane = globalThis.document.createElement('div')
  const errors = []
  const v = MO.mountMemoir(pane, {
    path: 'Memoir.md',
    transport: t,
    onDirtyChanged: () => {},
    onFirstCreate: () => {},
    onError: (e, ctx) => { errors.push([ctx, e]) },
  })
  v.show()
  await settle()
  await settle()
  const editor = pane.descendants().find((e) => e.tagName === 'TEXTAREA')
  type(editor, 'today I wrote tests\n')
  let aborted = false
  globalThis.fetch = (_url, opts) => new Promise((_, rej) => {
    opts?.signal?.addEventListener('abort', () => {
      aborted = true
      rej(new Error('aborted'))
    })
  })
  try {
    const btn = pane.descendants().find((e) => e.tagName === 'BUTTON' && e.id === 'mm-checkBtn')
    assert.ok(btn, 'no Check button')
    btn.dispatch('click', {})
    await settle()
    await settle()
    assert.equal(btn.disabled, true, 'Check never started')
    v.reset()
    assert.equal(btn.disabled, false, 'reset() left the buttons dead')
    await settle()
    await settle()
    assert.equal(aborted, true, 'leaving the page never cancelled the request')
    assert.equal(v.isDirty(), false)
  } finally {
    delete globalThis.fetch
  }
})

/* F48's deadline must outlast a real check: a full-size entry (12000
 * characters) takes about 210 s at llm-service, and a deadline shorter than
 * that aborts an answer that was on its way. */
test('F48: the Check deadline outlasts a full-size check and still fires', async (ctx) => {
  const t = makeTransport()
  const pane = globalThis.document.createElement('div')
  const v = MO.mountMemoir(pane, {
    path: 'Memoir.md',
    transport: t,
    onDirtyChanged: () => {},
    onFirstCreate: () => {},
    onError: () => {},
  })
  v.show()
  await settle()
  await settle()
  let aborted = false
  globalThis.fetch = (_url, opts) => new Promise((_, rej) => {
    opts?.signal?.addEventListener('abort', () => {
      aborted = true
      rej(new Error('aborted'))
    })
  })
  ctx.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const btn = pane.descendants().find((e) => e.tagName === 'BUTTON' && e.id === 'mm-checkBtn')
    assert.ok(btn, 'no Check button')
    btn.dispatch('click', {})
    await settle()
    await settle()
    assert.equal(btn.disabled, true, 'Check never started')
    ctx.mock.timers.tick(210_000)
    await settle()
    assert.equal(aborted, false, 'a 210 s check was cut off')
    ctx.mock.timers.tick(90_000)
    await settle()
    await settle()
    assert.equal(aborted, true, 'the deadline never fired')
    assert.equal(btn.disabled, false, 'a timed-out Check left the button dead')
  } finally {
    ctx.mock.timers.reset()
    delete globalThis.fetch
    v.reset()
  }
})

/* A blank journal (only whitespace, e.g. a stray newline autosaved into
 * Memoir.md) must open on the FIRST line, not past the blank: the fresh load
 * used to place the caret at the end unconditionally, so "\n" opened with the
 * caret on line 2 of an empty-looking page. */
test('blank journal opens on the first line, non-blank at the end', async () => {
  for (const [text, want] of [['\n', 0], ['   \n  ', 0], ['', 0], ['hello\n', 6]]) {
    const t = makeTransport({ text, mtimeMs: 1000 })
    const pane = globalThis.document.createElement('div')
    const v = MO.mountMemoir(pane, {
      path: 'Memoir.md',
      transport: t,
      onDirtyChanged: () => {},
      onFirstCreate: () => {},
      onError: () => {},
    })
    const editor = pane.descendants().find((e) => e.tagName === 'TEXTAREA')
    editor.selectionStart = -1
    editor.selectionEnd = -1
    editor.setSelectionRange = (a, b) => { editor.selectionStart = a; editor.selectionEnd = b }
    v.show()
    await settle()
    await settle()
    assert.equal(editor.value, text)
    assert.deepEqual(
      [editor.selectionStart, editor.selectionEnd],
      [want, want],
      'caret for ' + JSON.stringify(text),
    )
    v.reset()
  }
})
