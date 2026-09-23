/**
 * electron-shell/table-reload.test.mjs -- a table the caret is in stays
 * revealed across a reload that keeps the editor focused.
 *
 * `tables.ts` reveals a table's markdown only in a FOCUSED editor, and it
 * learns about focus from a per-state field that starts false.  A clean note
 * that another program rewrites is reloaded with `setState` while the editor
 * keeps its focus, and CM6 raises no focus change for that, so the new state
 * believed it was unfocused: the table under the caret became a widget again,
 * clicking it did not reveal it, and typing landed on the blank line AFTER the
 * table — written to disk by the autosave.
 *
 * Nothing below a real engine can see it: the view shim in tests/frontend has
 * no plugins, no focus and no watcher.  Needs a display (offscreen).
 */

import { strict as assert } from 'node:assert'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { SKIP, launch, sleep } from './cdp-drive.mjs'

const NOTE = '| a | b |\n|---|---|\n| c | d |\n\ny\n'
/** Inside cell `c`, before the `c`. */
const IN_C = NOTE.indexOf('c |')

const widgets = (app) => app.evaluate(`V().contentDOM.querySelectorAll('.nc-table-block').length`)

test('an outside rewrite of a clean note does not turn the table under the caret back into a widget', { skip: SKIP, timeout: 120_000 }, async () => {
  const app = await launch({ files: { 't.md': NOTE }, note: 't.md' })
  try {
    await app.evaluate(`(() => { const v = V(); v.focus(); v.dispatch({ selection: { anchor: ${IN_C} } }); return 1 })()`)
    await app.frames()
    assert.equal(await app.evaluate('V().hasFocus'), true, 'precondition: the editor is focused')
    assert.equal(await widgets(app), 0, 'precondition: the caret reveals the table')

    // Another program rewrites the note; the buffer is clean, so it reloads.
    const EDITED = NOTE.replace('\ny\n', '\ny2\n')
    writeFileSync(join(app.vault, 't.md'), EDITED)
    let doc = ''
    for (let i = 0; i < 100 && doc !== EDITED; i++) { await sleep(100); doc = await app.evaluate('V().state.doc.toString()') }
    assert.equal(doc, EDITED, 'the outside change was reloaded')
    await app.frames()

    assert.equal(await app.evaluate('V().state.selection.main.head'), IN_C, 'the caret memo was restored')
    assert.equal(await app.evaluate('V().hasFocus'), true)
    assert.equal(await widgets(app), 0, 'the table under the caret turned back into a widget')

    // And typing lands where the caret is, which is what reaches the disk.
    await app.send('Input.insertText', { text: 'zz' })
    await app.frames()
    const WANT = EDITED.replace('| c |', '| zzc |')
    assert.equal(await app.evaluate('V().state.doc.toString()'), WANT)
    let disk = ''
    for (let i = 0; i < 50 && disk !== WANT; i++) { await sleep(100); disk = readFileSync(join(app.vault, 't.md'), 'utf8') }
    assert.equal(disk, WANT)
  } finally {
    await app.close()
  }
})
