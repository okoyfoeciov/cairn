/**
 * electron-shell/ime-composition.test.mjs -- typing through an input method, in
 * the real engine, through Blink's own IME path (`Input.imeSetComposition` /
 * `Input.insertText`, which is what ibus, macOS marked text and every CJK IME
 * drive).  The DOM shims under tests/frontend have no composition at all.
 *
 * 1. LIVE PREVIEW MUST NOT REDRAW A CONSTRUCT UNDER AN OPEN COMPOSITION.
 *    Composing right after a closing `**`, `*`, `~~`, `==` or backtick moves the
 *    caret off the construct, which flipped its markers from shown to hidden in
 *    the same update.  CM6 then redrew around the composition node and dropped
 *    the construct's text from the DOM, and the next DOM read turned that into
 *    a deletion: `a **x**` + "nh" became `a ****nnh`, autosaved.  Obsidian maps
 *    its decorations while `view.composing` and rebuilds after; so does Cairn.
 *
 * 2. AN ENTER THAT CONFIRMS A COMPOSITION IS NOT A COMMIT.  macOS delivers the
 *    Return that commits marked text as keydown `Enter`, keyCode 229,
 *    `isComposing: true`.  The inline title renamed on it and moved focus into
 *    the note, so the habitual second Return wrote a newline into the body.
 *    The same holds for the Properties key and value editors.
 *
 * Needs a display (offscreen, never shown), like every engine suite here.
 */

import { strict as assert } from 'node:assert'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { SKIP, launch, sleep } from './cdp-drive.mjs'

const CONSTRUCTS = ['a **x**', 'a *x*', 'a ~~x~~', 'a ==x==', 'a `x`']
const CONTROL = 'a plain'
const NOTE = [...CONSTRUCTS, CONTROL].join('\n\n') + '\n'

/** Compose "n", "nh" and commit "nh" at the end of 1-based line `n`. */
async function composeAtEnd(app, n) {
  await app.evaluate(`(() => { const v = V(); v.dispatch({ selection: { anchor: v.state.doc.line(${n}).to } }); v.focus(); return 1 })()`)
  await app.frames()
  for (const s of ['n', 'nh']) {
    await app.send('Input.imeSetComposition', { text: s, selectionStart: s.length, selectionEnd: s.length })
    await app.frames()
  }
  await app.send('Input.insertText', { text: 'nh' })
  await app.frames()
}

test('composing right after a closing marker keeps the construct and types exactly once', { skip: SKIP, timeout: 120_000 }, async () => {
  const app = await launch({ files: { 'ime.md': NOTE }, note: 'ime.md' })
  try {
    const lines = NOTE.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i]
      if (text === '') continue
      await composeAtEnd(app, i + 1)
      const got = await app.evaluate(`V().state.doc.line(${i + 1}).text`)
      assert.equal(got, text + 'nh', `line ${i + 1} after composing "nh" at its end`)
      lines[i] = text + 'nh'
    }
    const want = lines.join('\n')
    assert.equal(await app.evaluate('V().state.doc.toString()'), want)
    // …and that is what reaches the disk (autosave idles at 800 ms).
    const path = join(app.vault, 'ime.md')
    let disk = ''
    for (let i = 0; i < 50 && disk !== want; i++) { await sleep(100); disk = readFileSync(path, 'utf8') }
    assert.equal(disk, want)
  } finally {
    await app.close()
  }
})

test('after the composition ends, the construct renders for the caret it left behind', { skip: SKIP, timeout: 120_000 }, async () => {
  // While composing, the decorations are only mapped; the rebuild the
  // composition held back must still happen once it commits, not at the next
  // keystroke.  The caret now sits past the closing marker, so the markers are
  // hidden again.
  const app = await launch({ files: { 'ime.md': 'a **x**\n' }, note: 'ime.md' })
  try {
    await composeAtEnd(app, 1)
    assert.equal(await app.evaluate('V().state.doc.line(1).text'), 'a **x**nh')
    await sleep(200)
    await app.frames()
    const shown = await app.evaluate(`V().contentDOM.querySelectorAll('.cm-line .nc-md-marker-plain').length`)
    assert.equal(shown, 0, 'the `**` markers are still drawn as revealed although the caret has left them')
    assert.equal(await app.evaluate(`V().contentDOM.querySelectorAll('.nc-strong').length`), 1)
  } finally {
    await app.close()
  }
})

/** The vault's file names, sorted. */
const filesIn = (dir) => readdirSync(dir).filter((f) => f.endsWith('.md')).sort()

test('the Return that confirms a composition in the inline title does not rename', { skip: SKIP, timeout: 120_000 }, async () => {
  const BODY = 'Line one\nLine two\n'
  const app = await launch({ files: { 'note.md': BODY }, note: 'note.md' })
  try {
    const r = await app.evaluate(`(() => { const b = document.querySelector('.nc-title').getBoundingClientRect(); return { x: b.left + 20, y: b.top + b.height / 2 } })()`)
    await app.click(r.x, r.y)
    await app.frames()
    assert.equal(await app.evaluate(`document.activeElement && document.activeElement.className`), 'nc-title-edit')
    await app.evaluate('(document.activeElement.select(), 1)')

    await app.send('Input.insertText', { text: 'Kế ' })
    await app.send('Input.imeSetComposition', { text: 'hoạch', selectionStart: 5, selectionEnd: 5 })
    await app.frames()
    // Cocoa's order for a Return that commits marked text: the keydown (229,
    // isComposing) and then the commit, back to back.
    const keyDown = app.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229,
    })
    const commit = app.send('Input.insertText', { text: 'hoạch' })
    await Promise.all([keyDown, commit])
    await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 })
    await sleep(400)
    await app.frames()
    assert.deepEqual(filesIn(app.vault), ['note.md'], 'renamed on the Return that only confirmed the composition')
    assert.equal(await app.evaluate(`document.activeElement && document.activeElement.className`), 'nc-title-edit')
    assert.equal(await app.evaluate(`document.activeElement.value`), 'Kế hoạch')

    // The real Return renames, and the note's body is untouched.
    await app.key('Enter', 13, '\r')
    let names = []
    for (let i = 0; i < 40; i++) { await sleep(100); names = filesIn(app.vault); if (names.includes('Kế hoạch.md')) break }
    assert.deepEqual(names, ['Kế hoạch.md'])
    await sleep(1200)
    assert.equal(readFileSync(join(app.vault, 'Kế hoạch.md'), 'utf8'), BODY)
    assert.equal(await app.evaluate('V().state.doc.toString()'), BODY)
  } finally {
    await app.close()
  }
})

test('the Return that confirms a composition in a property key or value does not commit', { skip: SKIP, timeout: 120_000 }, async () => {
  const DOC = '---\ntitle: old\n---\n\nbody\n'
  const app = await launch({ files: { 'p.md': DOC }, note: 'p.md' })
  const composeThenConfirm = async (text) => {
    await app.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length })
    await app.frames()
    const keyDown = app.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229,
    })
    const commit = app.send('Input.insertText', { text })
    await Promise.all([keyDown, commit])
    await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 })
    await sleep(200)
    await app.frames()
  }
  try {
    // ── the key ──
    const hasKey = await app.evaluate(`(() => { const el = document.querySelector('.metadata-property-key-input'); if (!el) return false; el.focus(); el.select(); return document.activeElement === el })()`)
    assert.ok(hasKey, 'the Properties key input is on screen and focusable')
    await composeThenConfirm('name')
    assert.equal(await app.evaluate('V().state.doc.toString()'), DOC, 'the key was renamed on the confirming Return')
    assert.equal(await app.evaluate(`document.activeElement && document.activeElement.className`), 'metadata-property-key-input')
    await app.key('Enter', 13, '\r')
    await app.frames()
    assert.equal(await app.evaluate('V().state.doc.toString()'), '---\nname: old\n---\n\nbody\n')

    // ── the value ──
    const hasValue = await app.evaluate(`(() => { const el = document.querySelector('.metadata-input-longtext'); if (!el) return false; el.focus(); const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return document.activeElement === el })()`)
    assert.ok(hasValue, 'the Properties value editor is on screen and focusable')
    const before = await app.evaluate('V().state.doc.toString()')
    await composeThenConfirm('mới')
    assert.equal(await app.evaluate('V().state.doc.toString()'), before, 'the value was committed on the confirming Return')
    assert.equal(await app.evaluate(`document.activeElement && document.activeElement.className`), 'metadata-input-longtext')
    await app.key('Enter', 13, '\r')
    await app.frames()
    assert.equal(await app.evaluate('V().state.doc.toString()'), '---\nname: mới\n---\n\nbody\n')
  } finally {
    await app.close()
  }
})
