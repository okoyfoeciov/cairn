// Owner: 03 (the Memoir page's sheet, src/styles/memoir.css).
// `node --test tests/frontend/memoir-css.test.mjs`.
//
// Three cascade traps in memoir.css that looked right and were dead in the
// engine.  Text checks only; electron-shell/memoir.test.mjs measures the same
// three things in the real engine.
//
//  · Reduced motion: the override and the fourth rule-5 exemption have the
//    same selectors, the same specificity and both carry `!important`, so
//    source order decides.  The override must come after the exemption.
//  · The shimmer stagger: base.css's `animation: none !important` and the
//    exemption's own shorthand both reset `animation-delay` to 0s, so a plain
//    delay is dead and the three lines pulse together.  The delays need
//    `!important` too.  House rule: the reduced-motion block stays LAST in
//    the sheet, so one ordering rule covers every override (the delays would
//    also work after it, on specificity, but the rule is not left to that).
//  · The 9px scrollbar: Chromium ignores `::-webkit-scrollbar` on a scroller
//    whose own `scrollbar-color` or `scrollbar-width` is not `auto`.  Only
//    `scrollbar-color` inherits, so one set on `#memoir` reaches both
//    scrollers; the sheet sets neither anywhere, which also keeps
//    `scrollbar-width` off the scrollers themselves.  The thumb sits on two
//    grounds (the page's `--bg-primary`, the drawer's `--bg-secondary`), so
//    its inset is a transparent border, not a border painted in one of them.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
const noComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, ' ')
const SHEET = noComments(readFileSync(join(ROOT, 'src', 'styles', 'memoir.css'), 'utf8'))

/** Blocks of a comment-free sheet, in source order, as {prelude, body, media};
 *  `@media` is flattened so its rules carry their condition. */
function blocks(css, media = null, out = []) {
  let i = 0
  for (;;) {
    const open = css.indexOf('{', i)
    if (open < 0) {
      assert.equal(css.slice(i).trim(), '', 'text outside any block')
      return out
    }
    const prelude = css.slice(i, open).trim().replace(/\s+/g, ' ')
    let depth = 1
    let j = open + 1
    for (; j < css.length && depth > 0; j += 1) {
      if (css[j] === '{') depth += 1
      else if (css[j] === '}') depth -= 1
    }
    const body = css.slice(open + 1, j - 1)
    if (prelude.startsWith('@media')) blocks(body, prelude, out)
    else out.push({ prelude, body, media })
    i = j
  }
}

/** `prop: value` pairs, whitespace collapsed. */
const decls = (body) => body
  .split(';')
  .map((d) => d.trim())
  .filter(Boolean)
  .map((d) => {
    const k = d.indexOf(':')
    return [d.slice(0, k).trim(), d.slice(k + 1).trim().replace(/\s+/g, ' ')]
  })

const STYLE = blocks(SHEET).filter((b) => !b.prelude.startsWith('@'))
const selectorsOf = (b) => b.prelude.split(',').map((s) => s.trim())
const REDUCED = '@media (prefers-reduced-motion: reduce)'
const rule = (sel) => {
  const hit = STYLE.filter((b) => b.media === null && b.prelude === sel)
  assert.ok(hit.length > 0, `memoir.css has no \`${sel}\` rule`)
  return Object.fromEntries(hit.flatMap((b) => decls(b.body)))
}

/* ── reduced motion ───────────────────────────────────────────────────────── */

const EXEMPT = {
  '#memoir .mm-ink-ring': 'mm-spin 0.9s linear infinite !important',
  '#memoir .mm-ink-dot': 'mm-pulse 1.4s ease-in-out infinite !important',
  '#memoir .mm-lines span': 'mm-shimmer 1.3s ease-in-out infinite !important',
}

test('reduced motion wins: each override comes after the exemption it overrides', () => {
  for (const [sel, value] of Object.entries(EXEMPT)) {
    const exempt = STYLE.map((b, i) => [b, i])
      .filter(([b]) => b.media === null && selectorsOf(b).includes(sel)
        && decls(b.body).some(([p]) => p === 'animation'))
    assert.equal(exempt.length, 1, `${sel}: expected one exemption rule`)
    assert.deepEqual(decls(exempt[0][0].body), [['animation', value]], `${sel}: the exemption changed`)

    const reduced = STYLE.map((b, i) => [b, i])
      .filter(([b]) => b.media === REDUCED && selectorsOf(b).includes(sel))
    assert.equal(reduced.length, 1, `${sel}: expected one reduced-motion override`)
    assert.deepEqual(decls(reduced[0][0].body), [['animation', 'none !important']])
    assert.ok(reduced[0][1] > exempt[0][1],
      `${sel}: the reduced-motion override sits before the exemption, so the exemption wins on source order`)
  }
})

test('the shimmer stagger survives the shorthands: !important delays, before the reduced-motion override', () => {
  const delays = STYLE.flatMap((b) => decls(b.body).filter(([p]) => p === 'animation-delay').map(([, v]) => [b.prelude, v]))
  for (const [sel, v] of delays) {
    assert.match(v, /!important$/, `${sel}: \`animation-delay: ${v}\` is dead, an \`animation\` shorthand resets it to 0s`)
  }
  const at = (sel) => {
    const hit = STYLE.map((b, i) => [b, i]).filter(([b]) => b.media === null && selectorsOf(b).includes(sel))
    assert.equal(hit.length, 1, `expected one \`${sel}\` rule`)
    return hit[0]
  }
  const reduced = STYLE.findIndex((b) => b.media === REDUCED)
  assert.ok(reduced >= 0, 'no reduced-motion block')
  for (const [n, delay] of [[2, '0.15s'], [3, '0.3s']]) {
    const sel = `#memoir .mm-lines span:nth-child(${n})`
    const [b, i] = at(sel)
    assert.deepEqual(decls(b.body), [['animation-delay', `${delay} !important`]], `${sel}: the delay changed`)
    assert.ok(i < reduced, `${sel}: the delay sits after the reduced-motion override, which must stay last`)
  }
})

/* ── the 9px scrollbar ────────────────────────────────────────────────────── */

test('#memoir sets neither scrollbar-color nor scrollbar-width (either one on a scroller disables ::-webkit-scrollbar)', () => {
  const host = rule('#memoir')
  assert.equal(host['scrollbar-color'], undefined, '#memoir sets scrollbar-color')
  assert.equal(host['scrollbar-width'], undefined, '#memoir sets scrollbar-width')
  assert.equal(/scrollbar-(color|width)\s*:/.test(SHEET), false, 'memoir.css sets scrollbar-color or scrollbar-width')
})

test('the bar is 9px with a transparent-bordered thumb, so it reads right on both grounds', () => {
  assert.equal(rule('#memoir ::-webkit-scrollbar').width, '9px')
  assert.equal(rule('#memoir ::-webkit-scrollbar-track').background, 'transparent')
  const thumb = rule('#memoir ::-webkit-scrollbar-thumb')
  assert.equal(thumb.background, 'var(--scrollbar-thumb)')
  assert.equal(thumb['border-radius'], '99px')
  assert.equal(thumb.border, '2px solid transparent')
  assert.equal(thumb['background-clip'], 'content-box')
})

test('the page has exactly two scrollers, both inside #memoir where the bar rules reach them', () => {
  const scrollers = STYLE.flatMap((b) =>
    decls(b.body)
      .filter(([p, v]) => /^overflow(-x|-y)?$/.test(p) && /\b(auto|scroll|overlay)\b/.test(v))
      .map(([p, v]) => [b.prelude, p, v])
  )
  // textarea#mm-editor and the check drawer's .mm-scroll; memoir.ts builds
  // both inside the #memoir host.  A third one needs its bar checked too.
  assert.deepEqual(scrollers, [
    ['#mm-editor', 'overflow-y', 'auto'],
    ['.mm-scroll', 'overflow-y', 'auto'],
  ])
})
