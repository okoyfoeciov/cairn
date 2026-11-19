// Owner: 03 (E111 — the reader's microphone, src/styles/mic.css).
// `node --test tests/frontend/mic-css.test.mjs`.
//
// Sheet conformance for CONTRACT §0.58 E111: comart's mic.css restyled with
// E109/E110's token mapping, rule by rule.  No custom property, every rule
// scoped to the button root or the card layer, one scroller, focus rings the
// base.css way, `!important` only on motion, the sixth rule-5 exemption and
// its one reduced-motion override, and the layering against the modal and the
// menus.  Text checks only: the pixels are electron-shell/mic.test.mjs's.
//
// comart's values are written out here rather than read from ~/comart: a test
// must not depend on another repo, and the point is that nobody "corrects" a
// literal without this file noticing.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
const noComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, ' ')

const SHEET = noComments(read('src/styles/mic.css'))

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
    assert.ok(!prelude.includes(';') && !prelude.includes('}'), `unparseable prelude: ${prelude}`)
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
function decls(body) {
  return body
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => {
      const k = d.indexOf(':')
      return [d.slice(0, k).trim(), d.slice(k + 1).trim().replace(/\s+/g, ' ')]
    })
}

/** A selector list split on its top-level commas. */
function selectors(prelude) {
  const out = []
  let depth = 0
  let cur = ''
  for (const ch of prelude) {
    if (ch === '(') depth += 1
    if (ch === ')') depth -= 1
    if (ch === ',' && depth === 0) {
      out.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  out.push(cur.trim())
  return out
}

const ALL = blocks(SHEET)
const STYLE = ALL.filter((b) => !b.prelude.startsWith('@'))
const HOVER = '@media (hover: hover)'
const REDUCED = '@media (prefers-reduced-motion: reduce)'
const MOTION = /^(transition|animation)/

/** Every style rule as [media, prelude, declarations], motion left out. */
const still = (pick) => STYLE.filter(pick)
  .map((b) => [b.media, b.prelude, decls(b.body).filter(([p]) => !MOTION.test(p))])
  .filter(([, , d]) => d.length > 0)

/* ── the sheet's own discipline ───────────────────────────────────────────── */

test('mic.css declares no custom property (§5.1: tokens.css is the only site)', () => {
  assert.ok(STYLE.length > 30, 'mic.css is not written yet')
  assert.equal(/(^|[;{]\s*)--[\w-]+\s*:/gim.test(SHEET), false, 'mic.css declares a custom property')
})

test('every var() mic.css reads is declared in tokens.css', () => {
  const tokens = read('src/styles/tokens.css')
  const used = new Set([...SHEET.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map((m) => m[1]))
  assert.deepEqual([...used].sort(), [
    '--accent', '--bg-modifier-hover', '--bg-secondary', '--divider-color', '--font-text', '--font-ui',
    '--fs-text', '--hairline', '--lh-text', '--radius-s', '--scrollbar-thumb', '--scrollbar-track',
    '--scrollbar-w-editor', '--text-error', '--text-muted', '--text-normal', '--titlebar-h',
  ])
  for (const v of used) {
    assert.ok(new RegExp(`(^|[\\s;{])${v}\\s*:`, 'm').test(tokens), `${v} is not declared in tokens.css`)
  }
})

test('every selector is scoped to .ep-mic-frame, .ep-mic or .ep-mic-layer; the only at-rules are hover, reduced motion and mc-* keyframes', () => {
  const at = ALL.filter((b) => b.prelude.startsWith('@')).map((b) => b.prelude)
  assert.deepEqual(at, ['@keyframes mc-dot', '@keyframes mc-blink'])
  for (const b of STYLE) {
    assert.ok(b.media === null || b.media === HOVER || b.media === REDUCED, `unexpected media block: ${b.media}`)
    for (const s of selectors(b.prelude)) {
      const button = s === '.ep-mic' || s.startsWith('.ep-mic[') || s.startsWith('.ep-mic ')
      const layer = s === '.ep-mic-layer' || s.startsWith('.ep-mic-layer ')
      const frame = s === '.ep-mic-frame' || s.startsWith('.ep-mic-frame ')
      assert.ok(button || layer || frame, `selector escapes the mic: ${s}`)
    }
  }
  assert.equal(SHEET.includes('.cmtm'), false, 'a comart class name survived the rename')
})

test('two scroller declarations: the frame, with no scrollbar, and .ep-mic-layer .mc-body, with the band\'s 12px bar; no scrollbar-color', () => {
  const scrollers = STYLE.flatMap((b) =>
    decls(b.body).filter(([p, v]) => /^overflow(-[xy])?$/.test(p) && /auto|scroll/.test(v)).map(() => b.prelude))
  assert.deepEqual(scrollers, ['.ep-mic-frame', '.ep-mic-layer .mc-body'])
  assert.equal(/scrollbar-color/.test(SHEET), false)
  const widths = STYLE.flatMap((b) => decls(b.body).filter(([p]) => p === 'scrollbar-width').map(([, v]) => [b.prelude, v]))
  assert.deepEqual(widths, [['.ep-mic-frame', 'none']])
  const bars = STYLE.filter((b) => b.prelude.includes('::-webkit-scrollbar')).map((b) => [b.prelude, decls(b.body)])
  assert.deepEqual(bars, [
    ['.ep-mic-layer .mc-body::-webkit-scrollbar', [['width', 'var(--scrollbar-w-editor)'], ['background', 'transparent']]],
    ['.ep-mic-layer .mc-body::-webkit-scrollbar-track', [['background', 'var(--scrollbar-track)']]],
    ['.ep-mic-layer .mc-body::-webkit-scrollbar-thumb', [
      ['background', 'var(--scrollbar-thumb)'], ['border-radius', 'var(--radius-s)'],
      ['border', '2px solid transparent'], ['background-clip', 'content-box'],
    ]],
  ])
})

test('no outline anywhere; every focus ring is an inset box-shadow in --accent, and the circle and pill rings keep their shadow', () => {
  assert.equal(/(^|[;{\s])outline(-[a-z]+)?\s*:/m.test(SHEET), false, 'base.css\'s `:focus { outline: none; }` — a ring is a box-shadow, never outline')
  const rings = STYLE.filter((b) => b.prelude.includes(':focus-visible')).map((b) => [b.prelude, decls(b.body)])
  const RING = 'inset 0 0 0 2px var(--accent)'
  assert.deepEqual(rings, [
    ['.ep-mic .mc-btn:focus-visible', [['box-shadow', RING]]],
    ['.ep-mic[data-state="recording"] .mc-btn:focus-visible, .ep-mic[data-state="arming"] .mc-btn:focus-visible, ' +
      '.ep-mic[data-state="transcribing"] .mc-btn:focus-visible, ' +
      '.ep-mic[data-msg]:not([data-state="recording"]):not([data-state="arming"]) .mc-btn:focus-visible',
    [['box-shadow', `${RING}, 0 6px 20px rgba(0, 0, 0, 0.28)`]]],
    ['.ep-mic-layer .mc-pp:focus-visible', [['box-shadow', RING]]],
    ['.ep-mic-layer .mc-copy:focus-visible', [['box-shadow', RING]]],
  ])
  // The ring composes because it comes after the shadow it would replace.
  const idx = (sel) => STYLE.findIndex((b) => selectors(b.prelude).includes(sel))
  assert.ok(idx('.ep-mic .mc-btn:focus-visible') > idx('.ep-mic[data-state="recording"] .mc-btn'))
  assert.ok(idx('.ep-mic[data-state="recording"] .mc-btn:focus-visible') > idx('.ep-mic[data-state="recording"] .mc-btn'))
})

test('no !important outside transition, animation and animation-delay (comart\'s host-page armour is dropped)', () => {
  for (const b of STYLE) {
    for (const [p, v] of decls(b.body)) {
      if (v.includes('!important')) assert.match(p, /^(transition|animation|animation-delay)$/, `${b.prelude} { ${p} }`)
      else assert.doesNotMatch(p, MOTION, `${b.prelude} { ${p} } must be !important to beat base.css rule 5`)
    }
  }
})

/* ── comart's button, rule by rule ────────────────────────────────────────── */

// comart mic.css:44-92, 137-181, 310-408 with E109/E110's mapping and X1-X3.
const SHADOW = '0 6px 20px rgba(0, 0, 0, 0.28)'
const BUTTON = [
  [null, '.ep-mic', [
    ['position', 'absolute'], ['bottom', '16px'], ['right', '16px'], ['z-index', '71'],
    ['display', 'flex'], ['flex-direction', 'column'], ['align-items', 'flex-end'], ['justify-content', 'flex-end'],
    ['gap', '10px'], ['margin', '0'], ['padding', '0'], ['pointer-events', 'none'],
  ]],
  [null, '.ep-mic[hidden]', [['display', 'none']]],
  [null, '.ep-mic .mc-btn', [
    ['pointer-events', 'auto'], ['zoom', '1.4'],
    ['display', 'flex'], ['align-items', 'center'], ['justify-content', 'center'], ['gap', '8px'],
    ['padding', '8px'], ['border', '0'], ['background', 'none'], ['box-shadow', 'none'],
    ['color', 'var(--text-muted)'],
    ['filter', 'drop-shadow(0 0 1.5px rgba(0, 0, 0, 0.85)) drop-shadow(0 1px 3px rgba(0, 0, 0, 0.5))'],
    ['font', '600 14px/1 var(--font-ui)'], ['letter-spacing', '-0.01em'],
    ['cursor', 'pointer'], ['-webkit-tap-highlight-color', 'transparent'], ['touch-action', 'manipulation'],
    ['-webkit-user-select', 'none'], ['user-select', 'none'],
  ]],
  [HOVER, '.ep-mic .mc-btn:hover', [['color', 'var(--text-normal)']]],
  [null, '.ep-mic .mc-btn:active', [['transform', 'scale(0.9)']]],
  [null, '.ep-mic .mc-btn.is-error', [['color', 'var(--text-error)']]],
  [null, '.ep-mic[data-msg]:not([data-state="recording"]):not([data-state="arming"]) .mc-btn', [
    ['padding', '6px 16px'], ['border-radius', '100px'], ['background', 'var(--bg-secondary)'],
    ['box-shadow', SHADOW], ['filter', 'none'],
  ]],
  [null, '.ep-mic[data-state="recording"] .mc-btn, .ep-mic[data-state="arming"] .mc-btn, .ep-mic[data-state="transcribing"] .mc-btn', [
    ['padding', '8px'], ['border-radius', '100px'], ['background', 'var(--bg-secondary)'],
    ['box-shadow', SHADOW], ['filter', 'none'],
  ]],
  [null, '.ep-mic .mc-label', [
    ['display', 'none'], ['max-width', 'calc(52vw / 1.4)'],
    ['white-space', 'nowrap'], ['overflow', 'hidden'], ['text-overflow', 'ellipsis'], ['font-variant-numeric', 'tabular-nums'],
  ]],
  [null, '.ep-mic[data-msg]:not([data-state="recording"]):not([data-state="arming"]) .mc-label', [['display', 'inline']]],
  [null, '.ep-mic[data-state="recording"] .mc-label, .ep-mic[data-state="arming"] .mc-label', [['display', 'none']]],
  [null, '.ep-mic .mc-ico', [['width', '24px'], ['height', '24px'], ['flex', 'none'], ['display', 'block']]],
  [null, '.ep-mic .mc-ico-stop', [['display', 'none']]],
  [null, '.ep-mic .mc-dots', [
    ['display', 'none'], ['width', '24px'], ['height', '24px'], ['flex', 'none'],
    ['align-items', 'center'], ['justify-content', 'center'], ['gap', '4px'],
  ]],
  [null, '.ep-mic .mc-dots i', [
    ['display', 'block'], ['width', '5px'], ['height', '5px'], ['border-radius', '50%'],
    ['background', 'var(--accent)'], ['opacity', '0.25'],
  ]],
  [null, '.ep-mic[data-state="arming"] .mc-dots, .ep-mic[data-state="transcribing"] .mc-dots', [['display', 'flex']]],
  [null, '.ep-mic[data-state="arming"] .mc-ico, .ep-mic[data-state="transcribing"] .mc-ico', [['display', 'none']]],
  [null, '.ep-mic[data-state="recording"] .mc-btn', [['color', 'var(--text-error)']]],
  [null, '.ep-mic[data-state="recording"] .mc-ico-mic', [['display', 'none']]],
  [null, '.ep-mic[data-state="recording"] .mc-ico-stop', [['display', 'block']]],
  [null, '.ep-mic[data-state="transcribing"] .mc-btn', [['color', 'var(--text-muted)'], ['cursor', 'progress']]],
]

test('the frame: a fixed, pointerless, barless scroller over the window at z 70; a sticky pin; a 200000px run', () => {
  const actual = still((b) => b.prelude.startsWith('.ep-mic-frame'))
  assert.deepEqual(actual, [
    [null, '.ep-mic-frame', [
      ['position', 'fixed'], ['inset', '0'], ['z-index', '70'], ['pointer-events', 'none'],
      ['overflow-x', 'hidden'], ['overflow-y', 'scroll'], ['scrollbar-width', 'none'], ['overflow-anchor', 'none'],
    ]],
    [null, '.ep-mic-frame .mc-pin', [['position', 'sticky'], ['top', '0'], ['height', '100%'], ['pointer-events', 'none']]],
    [null, '.ep-mic-frame .mc-run', [['height', '200000px'], ['pointer-events', 'none']]],
  ])
})

test('the button is comart\'s, rule by rule and in order', () => {
  const actual = still((b) => b.prelude === '.ep-mic' || /^\.ep-mic[[ ]/.test(b.prelude))
    .filter(([, p]) => !p.includes(':focus-visible'))
  assert.deepEqual(actual, BUTTON)
})

// comart's plain card: mic.css:455-508 with :740-810 folded in, the host modal's
// frame replaced by the layer, no grip, no CHECK, no word chips.
const CARD = [
  [null, '.ep-mic-layer', [['position', 'absolute'], ['inset', '0'], ['z-index', '70'], ['pointer-events', 'none']]],
  [null, '.ep-mic-layer .mc-shield', [
    ['position', 'absolute'], ['inset', 'var(--titlebar-h) 0 0 0'], ['z-index', '2'], ['pointer-events', 'auto'],
  ]],
  [null, '.ep-mic-layer .mc-wrap', [
    ['position', 'absolute'], ['left', '0'], ['right', '0'], ['top', '15vh'], ['height', '0'], ['padding', '0'],
    ['display', 'flex'], ['justify-content', 'center'], ['align-items', 'flex-start'], ['z-index', '2'],
  ]],
  [null, '.ep-mic-layer .mc-card', [
    ['position', 'relative'], ['z-index', '1'], ['width', '100%'], ['max-width', 'none'], ['box-sizing', 'border-box'],
    ['max-height', '33vh'], ['display', 'flex'], ['flex-direction', 'column'], ['overflow', 'hidden'],
    ['background', 'var(--bg-secondary)'],
    ['border', '0'], ['border-top', 'var(--hairline) solid var(--divider-color)'], ['border-radius', '0'],
    ['box-shadow', '0 16px 48px rgba(0, 0, 0, 0.5)'],
    ['-webkit-font-smoothing', 'antialiased'], ['pointer-events', 'auto'],
    ['opacity', '0'], ['translate', '0 10px'],
  ]],
  [null, '.ep-mic-layer .mc-card.is-shown', [['opacity', '1'], ['translate', 'none']]],
  [null, '.ep-mic-layer .mc-body', [['overflow-y', 'auto'], ['padding', '18px 20px 14px'], ['min-height', '0'], ['flex', '1 1 auto']]],
  [null, '.ep-mic-layer .mc-body::-webkit-scrollbar', [['width', 'var(--scrollbar-w-editor)'], ['background', 'transparent']]],
  [null, '.ep-mic-layer .mc-body::-webkit-scrollbar-track', [['background', 'var(--scrollbar-track)']]],
  [null, '.ep-mic-layer .mc-body::-webkit-scrollbar-thumb', [
    ['background', 'var(--scrollbar-thumb)'], ['border-radius', 'var(--radius-s)'],
    ['border', '2px solid transparent'], ['background-clip', 'content-box'],
  ]],
  [null, '.ep-mic-layer .mc-text', [
    ['margin', '0'], ['font', '400 var(--fs-text)/var(--lh-text) var(--font-text)'],
    ['white-space', 'pre-wrap'], ['word-break', 'break-word'], ['color', 'var(--text-normal)'],
    ['-webkit-user-select', 'text'], ['user-select', 'text'],
  ]],
  [null, '.ep-mic-layer .mc-text.is-empty', [['color', 'var(--text-muted)'], ['font-style', 'italic']]],
  [null, '.ep-mic-layer .mc-player[hidden]', [['display', 'none']]],
  [null, '.ep-mic-layer .mc-player', [['display', 'flex'], ['align-items', 'center'], ['gap', '10px'], ['margin-top', '14px']]],
  [null, '.ep-mic-layer .mc-pp', [
    ['flex', 'none'], ['width', '32px'], ['height', '32px'], ['padding', '0'], ['border-radius', '50%'],
    ['border', '1px solid var(--bg-modifier-hover)'],
    ['background', 'transparent'], ['color', 'var(--accent)'], ['cursor', 'pointer'],
    ['display', 'flex'], ['align-items', 'center'], ['justify-content', 'center'],
  ]],
  [null, '.ep-mic-layer .mc-pp:active', [['transform', 'scale(0.93)']]],
  [null, '.ep-mic-layer .mc-ico-pp', [['width', '13px'], ['height', '13px'], ['display', 'block']]],
  [null, '.ep-mic-layer .mc-ico-play', [['margin-left', '2px']]],
  [null, '.ep-mic-layer .mc-ico-pause', [['display', 'none']]],
  [null, '.ep-mic-layer .mc-player.is-playing .mc-ico-play', [['display', 'none']]],
  [null, '.ep-mic-layer .mc-player.is-playing .mc-ico-pause', [['display', 'block']]],
  [null, '.ep-mic-layer .mc-track', [
    ['flex', '1'], ['height', '6px'], ['border-radius', 'var(--radius-s)'],
    ['background', 'var(--bg-modifier-hover)'], ['cursor', 'pointer'], ['overflow', 'hidden'],
  ]],
  [null, '.ep-mic-layer .mc-fill', [['height', '100%'], ['width', '0'], ['background', 'var(--accent)']]],
  [null, '.ep-mic-layer .mc-time', [
    ['flex', 'none'], ['font', '400 11px/1.3 var(--font-ui)'], ['font-variant-numeric', 'tabular-nums'],
    ['color', 'var(--text-muted)'], ['min-width', '72px'], ['text-align', 'right'],
  ]],
  [null, '.ep-mic-layer .mc-actions', [
    ['display', 'flex'], ['justify-content', 'flex-end'], ['align-items', 'center'], ['gap', '2px'], ['margin-top', '8px'],
  ]],
  [null, '.ep-mic-layer .mc-copy', [
    ['display', 'flex'], ['align-items', 'center'], ['justify-content', 'center'], ['width', '34px'], ['height', '34px'],
    ['padding', '0'], ['color', 'var(--accent)'], ['background', 'none'], ['border', 'none'],
    ['border-radius', 'var(--radius-s)'], ['cursor', 'pointer'],
  ]],
  [null, '.ep-mic-layer .mc-copy:hover', [['opacity', '0.7']]],
  [null, '.ep-mic-layer .mc-copy:active', [['opacity', '0.4']]],
  [null, '.ep-mic-layer .mc-copy svg', [['width', '17px'], ['height', '17px'], ['display', 'block']]],
  [null, '.ep-mic-layer .mc-copy .mc-ico-ck', [['display', 'none']]],
  [null, '.ep-mic-layer .mc-copy.is-copied', [['color', 'var(--accent)']]],
  [null, '.ep-mic-layer .mc-copy.is-copied .mc-ico-cp', [['display', 'none']]],
  [null, '.ep-mic-layer .mc-copy.is-copied .mc-ico-ck', [['display', 'block']]],
  [null, '.ep-mic-layer .mc-copy[hidden]', [['display', 'none']]],
]

test('the card is the plain card, top-anchored as comart\'s full card (no centring transform): 33vh, 18px top padding, 100% wide, hairline top, square, comart\'s shadow', () => {
  const actual = still((b) => b.prelude.startsWith('.ep-mic-layer')).filter(([, p]) => !p.includes(':focus-visible'))
  assert.deepEqual(actual, CARD)
})

/* ── motion: the sixth exemption ──────────────────────────────────────────── */

test('the sixth exemption is exactly comart\'s motion, and nothing else moves', () => {
  const motion = STYLE.flatMap((b) => decls(b.body).filter(([p]) => MOTION.test(p)).map(([p, v]) => [b.media, b.prelude, p, v]))
  assert.deepEqual(motion, [
    [null, '.ep-mic .mc-btn', 'transition', 'transform 0.16s ease, background 0.16s ease, color 0.16s ease !important'],
    [null, '.ep-mic[data-state="idle"] .mc-btn', 'transition', 'transform 0.16s ease, color 0.16s ease !important'],
    [null, '.ep-mic .mc-dots i', 'animation', 'mc-dot 1.15s ease-in-out infinite !important'],
    [null, '.ep-mic .mc-dots i:nth-child(2)', 'animation-delay', '0.15s !important'],
    [null, '.ep-mic .mc-dots i:nth-child(3)', 'animation-delay', '0.3s !important'],
    [null, '.ep-mic[data-state="recording"] .mc-ico-stop', 'animation', 'mc-blink 1.2s ease infinite !important'],
    [null, '.ep-mic-layer .mc-card', 'transition', 'opacity 0.22s ease, translate 0.22s ease !important'],
    [null, '.ep-mic-layer .mc-pp', 'transition', 'background 0.15s ease, transform 0.12s ease !important'],
    [null, '.ep-mic-layer .mc-copy', 'transition', 'opacity 0.15s ease, color 0.15s ease !important'],
    [REDUCED, '.ep-mic[data-state="recording"] .mc-ico-stop', 'animation', 'none !important'],
  ])
  const frames = (name) => {
    const k = ALL.find((b) => b.prelude === `@keyframes ${name}`)
    assert.ok(k, `no @keyframes ${name}`)
    return blocks(k.body).map((b) => [b.prelude, decls(b.body)])
  }
  assert.deepEqual(frames('mc-dot'), [
    ['0%, 80%, 100%', [['opacity', '0.25'], ['transform', 'translateY(0)']]],
    ['40%', [['opacity', '1'], ['transform', 'translateY(-2px)']]],
  ])
  assert.deepEqual(frames('mc-blink'), [['50%', [['opacity', '0.3']]]])
  // Every exemption beats base.css's `*, *::before, *::after` (0,0,1) on specificity.
  for (const [, sel] of motion) assert.ok((sel.match(/[.[:]/g) ?? []).length >= 2, `${sel} is too weak to beat rule 5`)
})

test('reduced motion stops only the Stop\'s blink, after its exemption', () => {
  const reduced = STYLE.filter((b) => b.media === REDUCED)
  assert.equal(reduced.length, 1, 'one reduced-motion rule: comart mic.css:818, the one that reaches the plain card')
  assert.equal(reduced[0].prelude, '.ep-mic[data-state="recording"] .mc-ico-stop')
  const at = (b) => STYLE.indexOf(b)
  const exempt = STYLE.filter((b) => b.media === null && b.prelude === reduced[0].prelude && /animation\s*:/.test(b.body))
  assert.equal(exempt.length, 1)
  assert.ok(at(reduced[0]) > at(exempt[0]), 'same selector, both !important: source order decides')
})

/* ── layering and the build ───────────────────────────────────────────────── */

test('the layers sit below the modal and the menus, and the button above its card', () => {
  const z = (sel) => Number(Object.fromEntries(STYLE.filter((b) => b.prelude === sel).flatMap((b) => decls(b.body)))['z-index'])
  const modal = /const BACKDROP_STYLE =[\s\S]*?z-index:(\d+)/.exec(read('src/modal.ts'))
  assert.ok(modal, 'modal.ts BACKDROP_STYLE has no z-index')
  const menu = /\.ctx-menu \{[^}]*?z-index:\s*(\d+)/.exec(noComments(read('src/styles/chrome.css')))
  assert.ok(menu, 'chrome.css .ctx-menu has no z-index')
  assert.ok(z('.ep-mic') > z('.ep-mic-layer'), 'the button stays live above the shield')
  assert.ok(z('.ep-mic') < Number(modal[1]), 'below the modal backdrop')
  assert.ok(z('.ep-mic') < Number(menu[1]), 'below the menus')
  assert.deepEqual([z('.ep-mic'), z('.ep-mic-layer'), Number(modal[1]), Number(menu[1])], [71, 70, 80, 100])
})

test('the shield leaves the title bar live', () => {
  const shield = Object.fromEntries(STYLE.filter((b) => b.prelude === '.ep-mic-layer .mc-shield').flatMap((b) => decls(b.body)))
  assert.equal(shield.inset, 'var(--titlebar-h) 0 0 0')
  assert.match(read('src/styles/base.css'), /inset: var\(--titlebar-h\) 0 0 0;/, '.app starts where the shield does')
})

test('CSS_ORDER ships mic.css straight after explain.css', async () => {
  const { CSS_ORDER } = await import(join(ROOT, 'electron-shell', 'build-app.mjs'))
  assert.ok(CSS_ORDER.includes('explain.css'), 'explain.css is not in CSS_ORDER')
  assert.equal(CSS_ORDER.indexOf('mic.css'), CSS_ORDER.indexOf('explain.css') + 1)
})

test('base.css counts six exemptions, names mic.css, and warns before a seventh', () => {
  const base = read('src/styles/base.css')
  assert.match(base, /THERE ARE SIX EXEMPTIONS AND NOTHING ELSE/)
  assert.match(base, /`mic\.css`/)
  assert.match(base, /BEFORE ADDING A SEVENTH/)
  assert.match(base, /Six exemptions in,/)
  assert.doesNotMatch(base, /FIVE EXEMPTIONS|ADDING A SIXTH|Five exemptions in/)
})
