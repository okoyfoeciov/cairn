// Owner: 03 (E109 — the explanation band's sheet, src/styles/explain.css).
// `node --test tests/frontend/explain-css.test.mjs`.
//
// Sheet conformance for CONTRACT §0.56 E109 and §0.57 E110, in the style of
// find.test.mjs's CSS rows: no custom property, one scroller declaration, the
// full-width answer, the split's rules (scoping, the overlay under the grip,
// no motion), the fifth rule-5 exemption and nothing else, the frozen
// Merriam-Webster badge rule by rule, the Lora faces, and the build that
// inlines them.  Text checks only: the pixels are
// electron-shell/explain-badge.test.mjs's, and this file pins the sheet it
// measures.
//
// The badge values are written out here rather than read from ~/comart: a test
// must not depend on another repo, and the point is that nobody "corrects" a
// frozen literal without this file noticing.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
const noComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, ' ')

// Importing build-app.mjs must build nothing; prove it while importing it.
const BUILT = join(ROOT, 'electron-shell', 'app', 'index.html')
const builtBefore = existsSync(BUILT) ? statSync(BUILT).mtimeMs : null
const BUILD = await import(join(ROOT, 'electron-shell', 'build-app.mjs'))
const builtAfter = existsSync(BUILT) ? statSync(BUILT).mtimeMs : null

const SHEET = noComments(read('src/styles/explain.css'))

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
const rule = (sel, media = null) => {
  const hit = STYLE.filter((b) => b.prelude === sel && b.media === media)
  assert.ok(hit.length > 0, `explain.css has no \`${sel}\` rule${media ? ' in ' + media : ''}`)
  return Object.fromEntries(hit.flatMap((b) => decls(b.body)))
}

/** Like `rule`, but `sel` may be one member of a selector list. */
const ruleOf = (sel) => {
  const hit = STYLE.filter((b) => b.media === null && selectors(b.prelude).includes(sel))
  assert.ok(hit.length > 0, `explain.css has no rule for \`${sel}\``)
  return Object.fromEntries(hit.flatMap((b) => decls(b.body)))
}

const REDUCED = '@media (prefers-reduced-motion: reduce)'

/* ── the sheet's own discipline ───────────────────────────────────────────── */

test('explain.css declares no custom property (§5.1: tokens.css is the only site)', () => {
  assert.equal(/(^|[;{]\s*)--[\w-]+\s*:/gim.test(SHEET), false, 'explain.css declares a custom property')
})

test('every var() explain.css reads is declared in tokens.css', () => {
  const tokens = read('src/styles/tokens.css')
  const used = new Set([...SHEET.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map((m) => m[1]))
  assert.ok(used.size > 10, 'the panel is expected to consume Cairn tokens')
  for (const v of used) {
    assert.ok(new RegExp(`(^|[\\s;{])${v}\\s*:`, 'm').test(tokens), `${v} is not declared in tokens.css`)
  }
})

test('every rule is scoped to the band, or is one of the two cairn-explain highlights', () => {
  const at = ALL.filter((b) => b.prelude.startsWith('@')).map((b) => b.prelude)
  for (const p of at) {
    assert.ok(p === '@font-face' || /^@keyframes ex-[a-z-]+$/.test(p), `unexpected at-rule: ${p}`)
  }
  for (const b of STYLE) {
    assert.ok(b.media === null || b.media === REDUCED, `unexpected media block: ${b.media}`)
    for (const s of selectors(b.prelude)) {
      const scoped = s === '.ep-explain' || s === '.ep-explain[hidden]' || s.startsWith('.ep-explain ')
      const highlight = /^::highlight\(cairn-explain-(hover|mark)\)$/.test(s)
      assert.ok(scoped || highlight, `selector escapes the band: ${s}`)
    }
  }
  assert.ok(rule('::highlight(cairn-explain-hover)')['background-color'], 'no hover highlight wash')
  assert.ok(rule('::highlight(cairn-explain-mark)')['background-color'], 'no mark highlight wash')
})

test('exactly one scroller declaration, .ex-scroll (one per half, both from this rule), and no scrollbar-color', () => {
  const scrollers = STYLE.flatMap((b) =>
    decls(b.body)
      .filter(([p, v]) => /^overflow(-x|-y)?$/.test(p) && /\b(auto|scroll|overlay)\b/.test(v))
      .map(([p, v]) => [b.prelude, p, v])
  )
  assert.deepEqual(scrollers, [['.ep-explain .ex-scroll', 'overflow-y', 'auto']])
  // `scrollbar-color` switches the ::-webkit-scrollbar styling off.
  assert.equal(/scrollbar-color\s*:/.test(SHEET), false, 'explain.css sets scrollbar-color')
})

/* ── the band's geometry against the book's ───────────────────────────────── */

test('the band is an in-flow column item, hidden until used', () => {
  const band = rule('.ep-explain')
  assert.equal(band.flex, '0 0 auto')
  assert.equal(band.display, 'flex')
  assert.equal(band['flex-direction'], 'column')
  assert.equal(band.position, 'relative')
  assert.equal(band.background, 'var(--bg-secondary)')
  assert.equal(band['user-select'], 'none')
  assert.equal(rule('.ep-explain[hidden]').display, 'none')
  assert.equal(rule('.ep-explain .ex-grip').cursor, 'row-resize')
})

test('the answer fills its column, like comart: no max-width, no auto margin, 16px sides (E110 W)', () => {
  // Nothing in the band caps a line: the text runs the band, or its half.
  const capped = STYLE.flatMap((b) =>
    decls(b.body)
      .filter(([p, v]) => p === 'max-width' || (/^margin(-left|-right|-inline.*)?$/.test(p) && /\bauto\b/.test(v)))
      .map(([p, v]) => [b.prelude, p, v])
  )
  assert.deepEqual(capped, [], 'a width cap or a centring margin in explain.css')
  assert.equal(rule('.ep-explain .ex-content')['max-width'], undefined)
  // comart's `.explain-content { padding: 20px 16px }` sides (panel.css:355-365),
  // Cairn's 24px foot; the stable gutter and 12px bar stay, so a streaming
  // answer that starts to overflow never re-wraps.
  const scroll = rule('.ep-explain .ex-scroll')
  assert.equal(scroll.padding, '20px 16px 24px')
  assert.equal(scroll['scrollbar-gutter'], 'stable')
  assert.equal(rule('.ep-explain .ex-scroll::-webkit-scrollbar').width, 'var(--scrollbar-w-editor)')
})

/* ── E110: the two halves (comart panel.css:126-160, 355-419) ─────────────── */

test('split: the layout lives on .ex-slots, never on the band root, and every split rule is scoped', () => {
  const split = STYLE.filter((b) => /ex-slots|ex-thread|ex-place/.test(b.prelude))
  assert.ok(split.length >= 8, 'explain.css has no split rules')
  for (const b of split) {
    for (const s of selectors(b.prelude)) {
      assert.ok(s.startsWith('.ep-explain '), `split selector not under the band: ${s}`)
      assert.doesNotMatch(s, /\.ep-explain\[/, `the band root carries split state: ${s}`)
      assert.doesNotMatch(s, />/, `a child combinator would not survive a wrapper: ${s}`)
    }
  }
  assert.doesNotMatch(SHEET, /\.ep-explain\[data-(layout|place)/)
})

test('split: one row of two equal columns; the scroller stays each column\'s only overflow', () => {
  const row = rule('.ep-explain .ex-slots')
  assert.equal(row.flex, '1 1 auto')
  assert.equal(row['min-height'], '0')
  assert.equal(row.display, 'flex')
  assert.equal(row.position, 'relative', 'the overlay is placed against the row')
  assert.equal(row['z-index'], undefined, 'the row must not trap the overlay under the grip in its own context')
  const col = rule('.ep-explain .ex-thread')
  assert.equal(col.flex, '1 1 0')
  assert.equal(col['min-width'], '0')
  assert.equal(col['min-height'], '0')
  assert.equal(col.display, 'flex')
  assert.equal(col['flex-direction'], 'column')
  for (const sel of ['.ep-explain .ex-slots', '.ep-explain .ex-thread', '.ep-explain .ex-place', '.ep-explain .ex-place-half']) {
    const d = rule(sel)
    for (const p of ['overflow', 'overflow-x', 'overflow-y']) assert.equal(d[p], undefined, `${sel} declares ${p}`)
  }
  const s = rule('.ep-explain .ex-scroll')
  assert.equal(s.flex, '1 1 auto')
  assert.equal(s['min-height'], '0')
})

test('split: one panel hides the right column except while previewing it; the divider is an inset shadow, then a border', () => {
  assert.equal(rule('.ep-explain .ex-slots[data-layout="single"] .ex-thread[data-slot="1"]').display, 'none')
  assert.equal(rule('.ep-explain .ex-slots[data-layout="single"].place-right .ex-thread[data-slot="1"]').display, 'flex')
  // The preview line takes no width and is scoped to single, or it would
  // double the committed border (comart panel.css:413-415).
  assert.equal(
    rule('.ep-explain .ex-slots[data-layout="single"].place-right .ex-thread[data-slot="0"]')['box-shadow'],
    'inset calc(0px - var(--hairline)) 0 0 var(--divider-color)'
  )
  assert.equal(
    rule('.ep-explain .ex-slots[data-layout="split"] .ex-thread[data-slot="1"]')['border-left'],
    'var(--hairline) solid var(--divider-color)'
  )
})

test('split: the tint is comart\'s 8% accent wash on the target COLUMN, never on the overlay half', () => {
  const wash = 'color-mix(in srgb, var(--accent) 8%, transparent)'
  assert.equal(ruleOf('.ep-explain .ex-slots.place-left .ex-thread[data-slot="0"]').background, wash)
  assert.equal(ruleOf('.ep-explain .ex-slots.place-right .ex-thread[data-slot="1"]').background, wash)
  const halves = STYLE.filter((b) => /ex-place/.test(b.prelude))
  for (const b of halves) {
    for (const [p] of decls(b.body)) assert.ok(!/^background/.test(p), `${b.prelude} paints a background`)
  }
})

test('split: the overlay covers the row below the grip, hides with [hidden], and rings a focused half with an inset shadow', () => {
  const grip = rule('.ep-explain .ex-grip')
  const place = rule('.ep-explain .ex-place')
  assert.equal(place.position, 'absolute')
  assert.equal(place.inset, '0')
  assert.equal(place.display, 'flex')
  assert.ok(Number(place['z-index']) < Number(grip['z-index']), `overlay z ${place['z-index']} is not below the grip's ${grip['z-index']}`)
  assert.equal(rule('.ep-explain .ex-place[hidden]').display, 'none')
  const half = rule('.ep-explain .ex-place-half')
  assert.equal(half.flex, '1 1 0')
  assert.equal(half['min-width'], '0')
  assert.equal(half.cursor, 'pointer')
  const ring = rule('.ep-explain .ex-place-half:focus-visible')
  assert.equal(ring['box-shadow'], 'inset 0 0 0 2px var(--accent)')
  assert.equal(ring.outline, undefined, 'base.css: a ring is a box-shadow, never an outline')
})

test('split: no motion — the wash, the reflow and the divider are instant (comart\'s transition is inert, not ported)', () => {
  const split = STYLE.filter((b) => /ex-slots|ex-thread|ex-place/.test(b.prelude))
  assert.ok(split.length >= 8, 'explain.css has no split rules')
  for (const b of split) {
    for (const [p] of decls(b.body)) assert.ok(!/^(transition|animation)/.test(p), `${b.prelude} declares ${p}`)
  }
})

/* ── §5.1 rule 5: the fifth exemption ─────────────────────────────────────── */

test('the fifth exemption is exactly the badge fade and the thinking dots, all !important', () => {
  const motion = STYLE.flatMap((b) =>
    decls(b.body)
      .filter(([p]) => /^(transition|animation)(-|$)/.test(p))
      .map(([p, v]) => [b.media, b.prelude, p, v])
  )
  assert.deepEqual(motion, [
    [null, '.ep-explain .pron-badge', 'transition', 'background 0.15s ease, color 0.15s ease !important'],
    [null, '.ep-explain .ex-thinking span', 'animation', 'ex-thinking-pulse 1.4s ease infinite !important'],
    [null, '.ep-explain .ex-thinking span:nth-child(2)', 'animation-delay', '0.18s !important'],
    [null, '.ep-explain .ex-thinking span:nth-child(3)', 'animation-delay', '0.36s !important'],
    [REDUCED, '.ep-explain .pron-badge', 'transition', 'none !important'],
    [REDUCED, '.ep-explain .ex-thinking span', 'animation', 'none !important'],
  ])
  assert.ok(ALL.some((b) => b.prelude === '@keyframes ex-thinking-pulse'), 'the pulse has no @keyframes')
})

test('reduced motion wins: its overrides come after the exemption in source order', () => {
  const at = (media, sel) => STYLE.findIndex((b) => b.media === media && b.prelude === sel)
  for (const sel of ['.ep-explain .pron-badge', '.ep-explain .ex-thinking span']) {
    const exempt = STYLE.map((b, i) => [b, i])
      .filter(([b]) => b.media === null && b.prelude === sel && /(transition|animation)\s*:/.test(b.body))
      .map(([, i]) => i)
    assert.equal(exempt.length, 1, `${sel}: expected one exemption rule`)
    assert.ok(at(REDUCED, sel) > exempt[0], `${sel}: the reduced-motion override is not after the exemption`)
  }
})

test('base.css: the blanket ban is unchanged and its exemption list names explain.css', () => {
  const base = read('src/styles/base.css')
  assert.match(
    noComments(base),
    /\*,\s*\*::before,\s*\*::after\s*\{\s*transition:\s*none\s*!important;\s*animation:\s*none\s*!important;\s*\}/
  )
  assert.match(base, /THERE ARE SIX EXEMPTIONS AND NOTHING ELSE/)
  assert.match(base, /`explain\.css`/)
})

/* ── the frozen Merriam-Webster badge ─────────────────────────────────────── */

// comart panel.css:733-817 with its tokens resolved, the freeze block folded
// in and the inherited size pinned (weight and style still inherit, as
// comart's do).  The transition lives in the exemption row above.
const BADGE = [
  ['.ep-explain .pron-badge', [
    ['display', 'inline-flex'], ['align-items', 'center'], ['gap', '5px'], ['background', 'transparent'],
    ['color', '#8ec5d3'], ['border', '1px solid rgba(142, 197, 211, 0.42)'], ['border-radius', '100px'],
    ['padding', '0 8px 0 10px'],
    ['font', '13.95px/1.7 "Lora", Georgia, "Iowan Old Style", "Times New Roman", serif'],
    ['font-weight', 'inherit'], ['font-style', 'inherit'],
    ['cursor', 'pointer'], ['vertical-align', 'baseline'], ['margin', '0 2px'],
    ['-webkit-font-smoothing', 'antialiased'],
  ]],
  ['.ep-explain .pron-badge:hover', [['background', 'rgba(142, 197, 211, 0.1)']]],
  ['.ep-explain .pron-badge:focus-visible', [['outline', '2px solid #8ec5d3'], ['outline-offset', '2px']]],
  ['.ep-explain .pron-badge.is-playing', [['background', 'rgba(142, 197, 211, 0.1)']]],
  ['.ep-explain .pron-badge.loading', [['opacity', '0.55'], ['cursor', 'progress']]],
  ['.ep-explain .pron-badge.failed', [['border-style', 'dashed'], ['cursor', 'help']]],
  ['.ep-explain .pron-badge.failed.err-mw', [['color', '#ff5a4d'], ['border-color', 'rgba(255, 90, 77, 0.55)']]],
  ['.ep-explain .pron-badge.failed.err-mw:hover', [['background', 'rgba(255, 90, 77, 0.1)']]],
  ['.ep-explain .pron-badge.failed.err-none', [['color', '#e8b34a'], ['border-color', 'rgba(232, 179, 74, 0.55)']]],
  ['.ep-explain .pron-badge.failed.err-none:hover', [['background', 'rgba(232, 179, 74, 0.1)']]],
  ['.ep-explain .pron-badge .warn', [['width', '12px'], ['height', '12px'], ['fill', 'currentColor']]],
  ['.ep-explain .pron-badge .err-label', [['font-style', 'normal'], ['font-size', '0.9em']]],
  ['.ep-explain .pron-badge.ai-made', [
    ['color', '#c3a6e8'], ['border-color', 'rgba(195, 166, 232, 0.5)'], ['border-style', 'dashed'], ['cursor', 'help'],
  ]],
  ['.ep-explain .pron-badge.ai-made:hover', [['background', 'rgba(195, 166, 232, 0.12)']]],
  ['.ep-explain .pron-badge.ai-made .approx', [['font-style', 'normal'], ['opacity', '0.8'], ['margin-right', '-1px']]],
  ['.ep-explain .pron-badge.ai-made .ai-tag', [
    ['font-style', 'normal'], ['font-size', '0.62em'], ['font-weight', '700'], ['letter-spacing', '0.05em'],
    ['padding', '1px 4px'], ['margin-left', '2px'], ['border-radius', '4px'],
    ['background', 'rgba(195, 166, 232, 0.12)'], ['color', '#c3a6e8'],
  ]],
  ['.ep-explain .pron-badge .ipa', [['font-style', 'normal']]],
  ['.ep-explain .pron-badge .speaker', [['width', '12px'], ['height', '12px'], ['fill', 'currentColor'], ['margin-left', '1px']]],
  ['.ep-explain .pron-badge .badge-pos', [
    ['font-style', 'italic'], ['font-size', '0.85em'], ['color', '#c5c2bb'], ['margin-right', '1px'],
  ]],
  ['.ep-explain .pron-badge .dot-loader', [
    ['display', 'inline-block'], ['width', '16px'], ['text-align', 'center'], ['letter-spacing', '1px'],
  ]],
  ['.ep-explain .pron-variants', [
    ['display', 'inline-flex'], ['align-items', 'center'], ['flex-wrap', 'wrap'], ['gap', '4px'],
  ]],
  ['.ep-explain .pron-badge.is-picked', [
    ['border-color', '#8ec5d3'], ['background', 'rgba(142, 197, 211, 0.2)'], ['box-shadow', '0 0 0 1px #8ec5d3 inset'],
  ]],
  ['.ep-explain .pron-badge.is-picked:hover', [['background', 'rgba(142, 197, 211, 0.2)']]],
  ['.ep-explain .pron-badge.is-picked .badge-pos', [['color', '#8ec5d3'], ['font-style', 'normal'], ['font-weight', '700']]],
  ['.ep-explain .pron-badge.is-picked .ipa', [['font-weight', '600']]],
  ['.ep-explain .pron-variants:has(.is-picked) .pron-badge:not(.is-picked)', [['opacity', '0.45']]],
  ['.ep-explain .pron-variants:has(.is-picked) .pron-badge:not(.is-picked):hover', [['opacity', '1']]],
]

test('the badge block is comart\'s frozen rendering, rule by rule and in order', () => {
  const actual = STYLE.filter((b) => b.media === null && /\.pron-(badge|variants)/.test(b.prelude))
    .map((b) => [b.prelude, decls(b.body).filter(([p]) => !/^(transition|animation)/.test(p))])
    .filter(([, d]) => d.length > 0)
  assert.deepEqual(actual, BADGE)
})

/* ── fonts ────────────────────────────────────────────────────────────────── */

// Cyreal's unchanged Original Version of Lora 3.008 (SIL OFL 1.1, Reserved
// Font Name "Lora"), byte for byte from cyrealtype/Lora-Cyrillic@403b1a66
// fonts/variable/.  Any change to the bytes makes a Modified Version, which
// may not be called "Lora" (THIRD-PARTY-NOTICES.md).
const LORA = {
  'Lora[wght].ttf': '822a6621ccbe8d97d20ac88c1c41f5615c9c2c202eaa75f272cd452aac6475a7',
  'Lora-Italic[wght].ttf': '22d8d8854b53807aa664ca34f2031a9ed57a1d0dea296b8b96cdd3aad937a2b3',
}
// The 226 code points of comart's Latin subsets (their cmap, read from the
// woff2 files).  The full font also has ə, ā, ≈ …; the range keeps them
// falling back per glyph as they do in comart, i.e. keeps the badge's pixels.
const RANGE = 'U+000D, U+0020-007E, U+00A0-00AC, U+00AE-00FF, U+0102, U+0131, U+0152-0153, U+02BB-02BC, ' +
  'U+02C6, U+02DA, U+02DC, U+0300-0301, U+0303-0304, U+0308-0309, U+0323, U+2013-2014, U+2018-201A, ' +
  'U+201C-201E, U+2022, U+2026, U+2032-2033, U+2039-203A, U+2044, U+20AC, U+2122, U+2212, U+2215'
const sha = (buf) => createHash('sha256').update(buf).digest('hex')
const fontFile = (name) => readFileSync(join(ROOT, 'src', 'styles', 'fonts', name))

/** The code points a unicode-range value names. */
function rangePoints(range) {
  const out = new Set()
  for (const part of range.split(',').map((s) => s.trim())) {
    const m = /^U\+([0-9A-F]{1,6})(?:-([0-9A-F]{1,6}))?$/.exec(part)
    assert.ok(m, `unparseable unicode-range part: ${part}`)
    for (let c = parseInt(m[1], 16); c <= parseInt(m[2] ?? m[1], 16); c += 1) out.add(c)
  }
  return out
}

/** The code points a TrueType file's cmap maps to a real glyph (format 4). */
function cmapPoints(buf) {
  let cmap = null
  for (let i = 0; i < buf.readUInt16BE(4); i += 1) {
    const r = 12 + i * 16
    if (buf.toString('latin1', r, r + 4) === 'cmap') cmap = buf.subarray(buf.readUInt32BE(r + 8))
  }
  assert.ok(cmap, 'the font has no cmap table')
  const out = new Set()
  for (let i = 0; i < cmap.readUInt16BE(2); i += 1) {
    const t = cmap.subarray(cmap.readUInt32BE(8 + i * 8))
    assert.equal(t.readUInt16BE(0), 4, 'a cmap subtable that is not format 4')
    const segs = t.readUInt16BE(6) / 2
    for (let s = 0; s < segs; s += 1) {
      const end = t.readUInt16BE(14 + s * 2)
      const start = t.readUInt16BE(16 + segs * 2 + s * 2)
      const delta = t.readInt16BE(16 + segs * 4 + s * 2)
      const roAt = 16 + segs * 6 + s * 2
      const ro = t.readUInt16BE(roAt)
      for (let c = start; c <= end && c < 0xffff; c += 1) {
        const raw = ro ? t.readUInt16BE(roAt + ro + (c - start) * 2) : c
        if (raw !== 0 && ((raw + delta) & 0xffff) !== 0) out.add(c)
      }
    }
  }
  return out
}

test('two @font-face rules: comart panel.css:62-75 but for the files, plus the subsets\' unicode-range', () => {
  const faces = ALL.filter((b) => b.prelude === '@font-face').map((b) => decls(b.body))
  assert.deepEqual(faces, [
    [['font-family', '"Lora"'], ['font-style', 'normal'], ['font-weight', '400 700'], ['font-display', 'swap'],
      ['src', 'url("./fonts/Lora[wght].ttf") format("truetype")'], ['unicode-range', RANGE]],
    [['font-family', '"Lora"'], ['font-style', 'italic'], ['font-weight', '400 700'], ['font-display', 'swap'],
      ['src', 'url("./fonts/Lora-Italic[wght].ttf") format("truetype")'], ['unicode-range', RANGE]],
  ])
})

test('the shipped font files are Cyreal\'s Original Version, byte for byte, and nothing else is in fonts/', () => {
  assert.deepEqual(readdirSync(join(ROOT, 'src', 'styles', 'fonts')).sort(), Object.keys(LORA).sort())
  for (const [name, hash] of Object.entries(LORA)) assert.equal(sha(fontFile(name)), hash, name)
})

test('the unicode-range is what keeps ə on its fallback: the files map it, the range leaves it out', () => {
  const range = rangePoints(RANGE)
  assert.equal(range.size, 226, 'comart\'s subsets map 226 code points')
  for (const name of Object.keys(LORA)) {
    const cmap = cmapPoints(fontFile(name))
    const missing = [...range].filter((c) => !cmap.has(c)).map((c) => c.toString(16))
    assert.deepEqual(missing, [], `${name} lacks code points the range promises`)
    // In the badge's IPA (states.js): without the range they would draw from Lora.
    for (const c of [0x0259, 0x0101, 0x014d, 0x0113, 0x0307, 0x2248]) {
      assert.ok(cmap.has(c), `${name} has no U+${c.toString(16)}: this check no longer proves anything`)
      assert.equal(range.has(c), false, `the range takes U+${c.toString(16)}, which comart's subsets lack`)
    }
  }
})

/* ── the build ────────────────────────────────────────────────────────────── */

test('importing build-app.mjs builds nothing', () => {
  assert.equal(builtAfter, builtBefore, 'importing build-app.mjs rewrote electron-shell/app/index.html')
})

test('CSS_ORDER ships explain.css straight after reader.css', () => {
  const order = BUILD.CSS_ORDER
  assert.ok(order.includes('reader.css'), 'reader.css is not in CSS_ORDER')
  assert.equal(order.indexOf('explain.css'), order.indexOf('reader.css') + 1)
})

test('build-app\'s stylesheet pass inlines both Lora faces, byte-identical (E34: one self-contained page)', async () => {
  const css = await BUILD.bundleCss()
  const fonts = [...css.matchAll(/url\(\s*["']?data:font\/ttf;base64,([A-Za-z0-9+/=]+)["']?\s*\)\s*format\(\s*["']truetype["']\s*\)/g)]
    .map((m) => sha(Buffer.from(m[1], 'base64')))
  assert.deepEqual(fonts, Object.values(LORA))
  assert.equal(/fonts\/Lora/.test(css), false, 'a font is still linked by path')
  // Minifying must not drop or reshape the range: it is what keeps the pixels.
  const ranges = [...css.matchAll(/unicode-range:\s*([^;}]+)/g)].map((m) => m[1].replace(/\s+/g, ''))
  assert.deepEqual(ranges, [RANGE.replace(/\s+/g, ''), RANGE.replace(/\s+/g, '')])
  const scroller = css.indexOf('.ep-scroller')
  assert.ok(scroller >= 0 && css.indexOf('.ep-explain') > scroller, 'explain.css is not bundled after reader.css')
})

/* ── reader.css (E109 ruling 7) ───────────────────────────────────────────── */

test('reader.css: book text is not selectable, and a pickable word shows a pointer', () => {
  const reader = noComments(read('src/styles/reader.css'))
  assert.equal(/user-select:\s*text/.test(reader), false, 'the reading band still opts into selection')
  const content = /\.ep-content\s*\{([^}]*)\}/.exec(reader)
  assert.ok(content, 'reader.css has no .ep-content rule')
  assert.equal(Object.fromEntries(decls(content[1]))['user-select'], 'none')
  assert.match(reader, /\.ep-content\.ex-over-word\s*\{\s*cursor:\s*pointer;?\s*\}/)
})
