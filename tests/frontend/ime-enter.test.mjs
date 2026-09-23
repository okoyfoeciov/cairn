// `node --test tests/frontend/*.test.mjs`.
//
// F79 — THE RETURN THAT CONFIRMS AN IME COMPOSITION IS NOT A COMMIT.
//
// macOS delivers the Return that commits marked text (CJK candidates, the
// Vietnamese input sources) as keydown `Enter` with `isComposing: true` and
// keyCode 229, BEFORE `compositionend`.  The shared name editor
// (`inline-edit.ts`, which the tree's rename and New note/New folder rows use)
// committed on it — a rename on a half-confirmed name — and its Escape
// cancelled the whole rename when it should only have cancelled the marked
// text.  The inline title and the Properties editors have the same guard and
// are covered in the real engine by electron-shell/ime-composition.test.mjs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const SRC = join(HERE, '..', '..', 'src')

const out = mkdtempSync(join(tmpdir(), 'cairn-ime-'))
process.on('exit', () => { try { rmSync(out, { recursive: true, force: true }) } catch {} })
const entry = join(out, 'entry.ts')
writeFileSync(entry, `export * as I from ${JSON.stringify(join(SRC, 'inline-edit.ts'))}\n`)
await esbuild.build({
  entryPoints: [entry], bundle: true, format: 'esm', platform: 'neutral',
  target: 'es2021', outfile: join(out, 'entry.mjs'), logLevel: 'silent',
})
const { I } = await import(join(out, 'entry.mjs'))

// Exactly what attachNameEditor touches on these paths.
globalThis.window = { innerWidth: 1000, innerHeight: 700, addEventListener() {}, removeEventListener() {} }

function fakeInput(value) {
  const listeners = new Map()
  return {
    value,
    selectionStart: 0,
    selectionEnd: 0,
    addEventListener(t, f) { listeners.set(t, [...(listeners.get(t) ?? []), f]) },
    removeEventListener(t, f) { listeners.set(t, (listeners.get(t) ?? []).filter((g) => g !== f)) },
    setAttribute() {},
    removeAttribute() {},
    focus() {},
    setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b },
    classList: { add() {}, remove() {} },
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0 }),
    fire(t, ev) { for (const f of listeners.get(t) ?? []) f(ev) },
  }
}

function keydown(key, extra = {}) {
  return {
    key, isComposing: false, keyCode: key === 'Enter' ? 13 : key === 'Escape' ? 27 : 0,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true },
    stopPropagation() {},
    ...extra,
  }
}

function editor(value) {
  const input = fakeInput(value)
  const calls = { commit: [], cancel: 0 }
  const h = I.attachNameEditor(input, {
    initial: value,
    onCommit: (name) => { calls.commit.push(name); return { ok: true } },
    onCancel: () => { calls.cancel++ },
  })
  return { input, calls, h }
}

const settle = () => new Promise((r) => setTimeout(r, 0))

for (const [label, extra] of [
  ['isComposing', { isComposing: true, keyCode: 229 }],
  ['keyCode 229 alone', { keyCode: 229 }],
  ['isComposing alone', { isComposing: true }],
]) {
  test(`name editor: an Enter with ${label} confirms the composition, not the name`, async () => {
    const { input, calls, h } = editor('draft')
    input.value = '計画'
    const ev = keydown('Enter', extra)
    input.fire('keydown', ev)
    await settle()
    assert.deepEqual(calls.commit, [], 'committed on the confirming Return')
    assert.equal(h.closed, false)
    assert.equal(ev.defaultPrevented, false, 'the IME must still receive its Return')

    // The real Return that follows commits, once, with the confirmed text.
    input.fire('keydown', keydown('Enter'))
    await settle()
    assert.deepEqual(calls.commit, ['計画'])
    assert.equal(h.closed, true)
  })
}

test('name editor: an Escape during a composition cancels the composition, not the rename', async () => {
  const { input, calls, h } = editor('draft')
  input.fire('keydown', keydown('Escape', { isComposing: true, keyCode: 229 }))
  await settle()
  assert.equal(calls.cancel, 0)
  assert.equal(h.closed, false)
  input.fire('keydown', keydown('Escape'))
  assert.equal(calls.cancel, 1)
  assert.equal(h.closed, true)
})
