/**
 * electron-shell/scroll-converge.test.mjs -- scrolling a long note to its end,
 * in the real engine, with real wheel events.
 *
 * THE BUG. A 1,534-line test-plan note could not be scrolled to the bottom:
 * `scrollTop` was thrown back by thousands of px and the same two states
 * repeated for as long as the wheel turned.  The write is CM6's own scroll
 * anchor, reacting to a height map that had just been REBUILT.
 *
 * WHY IT WAS REBUILT.  `ViewState.measure` calls `docView.measureTextSize()`
 * whenever a new line height shows up, and that takes the FIRST rendered line
 * of 20 characters or fewer whose children are all plain text as the sample
 * for `heightOracle.lineHeight`.  A change of more than 0.3px throws the whole
 * height map away (`HeightMap.empty()`), and every height measured so far goes
 * with it.  Cairn's fenced-code lines are 21px against a paragraph's 24, and
 * they carried no marks, so a short code line was a candidate: each time one
 * entered the rendered range ahead of the paragraphs the oracle flipped to 21,
 * each time the anchor jump took the viewport back it flipped to 24, and
 * nothing it measured on the way ever survived.
 *
 * Needs a display (offscreen, never shown), like every engine suite here.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { SKIP, launch, sleep } from './cdp-drive.mjs'

/** What the oracle can sample is a line of 20 characters or fewer made of
 *  plain text.  A bullet never is (its marker and marks are children of their
 *  own) and a long paragraph is too long, so the only candidates here are the
 *  code lines: the oracle sees 21px while a code block is in the rendered range
 *  and falls back to its own 24px probe while none is.  Bullets that wrap one
 *  row more every few sections, in three list flavours, keep a NEW height
 *  arriving, and a new height is what makes CM6 re-measure. */
function note() {
  const words = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu'.split(' ')
  const text = (n) => {
    let t = ''
    for (let i = 0; t.length < n; i++) t += words[i % words.length] + ' '
    return t.trim()
  }
  const code = ['{', '  "a": 1,', '}', 'x = 1', 'if (y) {', '  go()', '}', 'done']
  // Line 1 holds the caret, so CM6 keeps it rendered whatever the scroll, and a
  // short one would be the oracle's sample for ever.
  const out = ['The caret starts on this line, which is long enough never to be a sample.', '']
  for (let s = 0; s < 60; s++) {
    out.push(`## Section ${s}`, '')
    const n = 300 + s * 45
    out.push(`- ${text(n)}`, `1. ${text(n + 20)}`, `- [ ] ${text(n + 40)}`, '')
    if (s % 8 === 7) {
      out.push('```js')
      for (let c = 0; c < 4; c++) out.push(...code)
      out.push('```', '')
    }
  }
  return out.join('\n') + '\n'
}

test('wheeling down a long note with code blocks never throws scrollTop backward and reaches the end', { skip: SKIP, timeout: 240_000 }, async () => {
  const app = await launch({ files: { 'long.md': note() }, note: 'long.md' })
  try {
    await sleep(800)
    const read = `(() => { const s = V().scrollDOM; return [s.scrollTop, s.scrollHeight, s.clientHeight] })()`
    const trace = []
    let reached = false
    for (let i = 0; i < 1500 && !reached; i++) {
      await app.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 800, y: 400, deltaX: 0, deltaY: 300 })
      await sleep(25)
      const t = await app.evaluate(read)
      trace.push(t)
      reached = t[0] + t[2] >= t[1] - 2
    }
    // The wheel only ever asks for +300, so a step back of 1,500px is CM6's anchor.
    const back = []
    for (let i = 1; i < trace.length; i++) {
      const before = trace[i - 1][0], after = trace[i][0]
      if (after < before - 1500) back.push(`${Math.round(before)} -> ${Math.round(after)} (scrollHeight ${trace[i - 1][1]} -> ${trace[i][1]})`)
    }
    assert.deepEqual(back, [], 'scrollTop was thrown backward by CM6 re-anchoring after a height-map rebuild')
    assert.ok(reached, `the end was not reached in ${trace.length} wheel steps (last ${JSON.stringify(trace[trace.length - 1])})`)
  } finally {
    await app.close()
  }
})
