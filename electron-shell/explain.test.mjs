/**
 * electron-shell/explain.test.mjs — §0.56 E109 click-to-explain, end to end in
 * the real app, plus the shell's navigation guard.
 *
 * WHY AN ENGINE.  `tests/frontend/{reader,explain-panel,explain-render}` drive
 * each half in minidom with fakes for layout, fetch and the band.  None of them
 * can see: a caret hit-test on real line boxes, the CSS Highlight API actually
 * painting, the band taking space from a real flex column (and the reveal
 * scroll that follows), a real SSE body streaming over loopback into a
 * `file://` page, `<audio>` playing a clip, pointer capture on the grip,
 * `state.json` written by the real addon and read back by the next launch, a
 * scrollbar press producing no click, and what Electron does with a link that
 * escapes `preventDefault`.
 *
 * HOW.  The app is launched hermetically (temp vault holding one generated
 * EPUB, its own `CAIRN_STATE_DIR`, `CAIRN_HEADLESS=1`) and driven over the
 * DevTools protocol, like `cdp-drive.mjs`: `Input.dispatchMouseEvent` and
 * `Input.dispatchKeyEvent` are TRUSTED input, which the pick and the band
 * insist on.  ai-service is a FAKE served from this process on a free port
 * (`CAIRN_AI_BASE`, loopback only): `/api/explain` as scripted SSE, `/api/pron`
 * as 200/404/502 by word, and a tiny generated WAV as the "mp3".  Nothing here
 * reaches a billed route; the live leg at the bottom is gated on
 * `CAIRN_EXPLAIN_LIVE=1` and bills one real `/api/explain`.
 *
 * The tests in a session run IN ORDER against one app: each step starts from
 * the state the previous one left, the way a reader uses the band.
 *
 * §0.57 E110 (the two halves).  A book pick on a band that holds anything is
 * STAGED and asks nothing until a half is clicked; the E110 steps walk one
 * band through staging, the hover previews, both placements, a split with two
 * live streams, the replace mode, drill-down per half, every Esc and focus
 * path, the outside click, and a press that begins in the band but is
 * released outside it (no outside click).  The earlier E109 steps that pick
 * on a band holding an answer place the pick over the whole panel
 * (`pick(..., 'left')`).
 * The width leg launches WIDE (1700x900), because at 1200x800 the pane is
 * narrower than the old 792px line cap and a width test could not fail.
 */

import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { after, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { NO_DISPLAY } from './have-display.mjs'
import { CONTAINER, zip } from '../tests/frontend/_epub-fixture.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const BIN = process.platform === 'darwin'
  ? join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
  : join(ROOT, 'node_modules', 'electron', 'dist', 'electron')
const SKIP = !existsSync(BIN)
  ? `electron not installed at ${BIN} -- run npm install`
  : !existsSync(join(HERE, 'cairn.node'))
    ? 'no cairn.node -- run node electron-shell/build-native.mjs'
    : !existsSync(join(HERE, 'app', 'index.html'))
      ? 'electron-shell/app not built -- run node electron-shell/build-app.mjs'
      : NO_DISPLAY
const LIVE = process.env.CAIRN_EXPLAIN_LIVE === '1'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const BOOK = 'Keeper.epub'
const CUT_OFF = 'The answer was cut off — the backend stopped mid-stream.'

/* ── the book ──────────────────────────────────────────────────────────────
 * Long enough to scroll, with every case a pick has to survive: an internal
 * link, an external one, a footnote marker glued to its word, a word split
 * across two inline elements, a paragraph longer than 8 words, and a line
 * far enough down to sit under the band. */

const filler = (tag, n) => Array.from({ length: n }, (_, i) =>
  `<p>Filler ${tag} ${i + 1} tells of rope and salt and the long grey water past the breakwater.</p>`).join('\n')

function makeBook(archiveUrl) {
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>The Lantern Keeper</dc:title><dc:creator>Ada Quill</dc:creator><dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="c1" href="harbour.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="notes.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="c1"/><itemref idref="c2"/></spine>
</package>`
  const nav = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<body><nav epub:type="toc"><ol>
  <li><a href="harbour.xhtml">The Harbour</a></li>
  <li><a href="notes.xhtml">Harbour Notes</a></li>
</ol></nav></body></html>`
  const ch1 = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>
  <h1>The Harbour</h1>
  <p>The old keeper lit the lantern every evening before the tide turned.</p>
  <p>Read the <a href="notes.xhtml#notes">harbour notes</a> first, or visit <a href="${archiveUrl}">the archive</a> later.</p>
  <p>The gulls circled the mast<a epub:type="noteref" href="notes.xhtml#fn1">1</a> and cried.</p>
  <p>She threaded the nee<em>dle</em> by the window.</p>
  <p>One two three four five six seven eight nine ten eleven twelve words marched across the quay.</p>
  ${filler('a', 30)}
  <p>At the bottom the harbour bell rang twice for the evening.</p>
  ${filler('b', 10)}
</body></html>`
  const ch2 = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>
  <h1 id="notes">Harbour Notes</h1>
  <p>The notes describe the tides.</p>
  <p>Type <code>tidegauge</code> and press <kbd>Enter</kbd> to log it.</p>
  ${filler('c', 8)}
  <aside epub:type="footnote" id="fn1"><p>A mast is a tall pole on a ship.</p></aside>
  ${filler('d', 8)}
</body></html>`
  return Buffer.from(zip([
    { name: 'mimetype', data: 'application/epub+zip', store: true },
    { name: 'META-INF/container.xml', data: CONTAINER },
    { name: 'OEBPS/content.opf', data: opf },
    { name: 'OEBPS/nav.xhtml', data: nav },
    { name: 'OEBPS/harbour.xhtml', data: ch1 },
    { name: 'OEBPS/notes.xhtml', data: ch2 },
  ]))
}

/* ── the fake ai-service ───────────────────────────────────────────────────
 * `/api/explain` answers the next scripted spec (or a short generic answer),
 * `/api/pron` answers by word, `/audio/*` serves one generated WAV.  Every
 * other request is recorded as stray: the navigation guard's escapes all
 * point here, so an escape is a recorded hit rather than a real page load. */

/** A 1.2 s, 8 kHz, 16-bit mono tone: long enough to watch `.is-playing`. */
function wav(seconds = 1.2, rate = 8000) {
  const n = Math.round(seconds * rate)
  const b = Buffer.alloc(44 + n * 2)
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8)
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22)
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34)
  b.write('data', 36); b.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(800 * Math.sin((2 * Math.PI * 440 * i) / rate)), 44 + i * 2)
  return b
}
const WAV = wav()

function gate() {
  let open
  const promise = new Promise((r) => { open = r })
  return { promise, open }
}

/** `text` cut into `n` chunk events. */
function pieces(text, n) {
  const out = []
  const step = Math.ceil(text.length / n)
  for (let i = 0; i < text.length; i += step) out.push({ event: 'chunk', data: { text: text.slice(i, i + step) } })
  return out
}

/** The answer ai-service's prompt shape asks for, small: one item, no tags
 *  for a phrase, an AI-respelled `[[PRON]]` for a single word. */
function genericAnswer(items) {
  return (items ?? []).map((it) => {
    const w = it.words && it.words.length === 1 ? it.words[0].toLowerCase() : null
    return `**${it.phrase}**` + (w ? ` [[PRON word="${w}" pos="noun" ipa="ˈtest"]]` : '') +
      ': a plain gloss written by the test harness.\n> A line that quotes **' + it.phrase + '** once.'
  }).join('\n\n')
}

/** E110's answers are long enough to overflow a 320px half, so a half can
 *  scroll, follow its stream and reflow; short words, many paragraphs. */
const para = (topic, k) => `The ${topic} part ${k} walks along the quay and counts the boats, the ropes, the nets and the gulls that wait on every post for the catch.`
const longAnswer = (topic, n) => Array.from({ length: n }, (_, k) => para(topic, k + 1)).join('\n\n')

function fakeAi() {
  const ai = {
    port: 0, base: '', explains: [], prons: [], audio: [], stray: [], specs: [],
    /** Script the next `/api/explain`. */
    next(spec) { ai.specs.push(spec) },
    async waitExplains(n, ms = 5000) {
      const t0 = Date.now()
      while (ai.explains.length < n) {
        if (Date.now() - t0 > ms) throw new Error(`fake ai-service: ${ai.explains.length} /api/explain requests, wanted ${n}`)
        await sleep(25)
      }
      return ai.explains[n - 1]
    },
  }
  const mw = (word, variants) => ({
    hword: word, pos: variants[0].pos, ipa: variants[0].ipa, mp3: variants[0].mp3, variants,
  })
  const prons = () => ({
    lantern: [200, mw('lantern', [
      { pos: 'noun', posList: ['noun'], num: '1 of 2', ipa: 'ˈlan-tərn', mp3: ai.base + '/audio/lantern.wav' },
      { pos: 'verb', posList: ['verb'], num: '2 of 2', ipa: 'ˈlan-tərnz', mp3: ai.base + '/audio/lantern-verb.wav' },
    ])],
    glimmer: [200, mw('glimmer', [
      { pos: 'noun', posList: ['noun', 'verb'], num: '1 of 1', ipa: 'ˈgli-mər', mp3: ai.base + '/audio/glimmer.wav' },
    ])],
    zyzzyva: [404, { error: 'not_found' }],
    quell: [502, { error: 'mw_unavailable' }],
  })
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    try {
      if (req.method === 'POST' && url.pathname === '/api/explain') {
        let raw = ''
        for await (const c of req) raw += c
        let body = null
        try { body = JSON.parse(raw) } catch {}
        ai.explains.push({ body, type: req.headers['content-type'] ?? '' })
        const spec = ai.specs.shift() ?? {
          events: [...pieces(genericAnswer(body && body.items), 3), { event: 'done', data: {} }],
        }
        if (spec.status) {
          res.writeHead(spec.status, { 'content-type': 'application/json' })
          res.end(JSON.stringify(spec.json ?? {}))
          return
        }
        let gone = false
        res.on('close', () => { gone = true })
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store, no-transform' })
        for (const e of spec.events) {
          if (gone) return
          if (e.gate) { await e.gate; continue }
          if (e.end) break // the backend died: no `done`
          res.write(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`)
          await sleep(e.delay ?? 30)
        }
        if (!gone) res.end()
        return
      }
      if (req.method === 'GET' && url.pathname === '/api/pron') {
        const word = url.searchParams.get('word') ?? ''
        ai.prons.push({ word, pos: url.searchParams.get('pos') ?? '' })
        const [status, json] = prons()[word.toLowerCase()] ?? [404, { error: 'not_found' }]
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(json))
        return
      }
      if (req.method === 'GET' && url.pathname.startsWith('/audio/')) {
        ai.audio.push(url.pathname.slice('/audio/'.length))
        res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': WAV.length })
        res.end(WAV)
        return
      }
      ai.stray.push(`${req.method} ${url.pathname}`)
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('Not found')
    } catch {
      try { res.destroy() } catch {}
    }
  })
  ai.listen = () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    ai.port = server.address().port
    ai.base = `http://127.0.0.1:${ai.port}`
    resolve(ai)
  }))
  ai.close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()) })
  return ai
}

/* ── the page helper ───────────────────────────────────────────────────────
 * Read-only lookups (geometry, highlights, band state) plus `reveal`, which
 * scrolls the BOOK to put a word at a chosen height: positioning is not
 * under test, picking is. */

const PAGE_HELPER = String.raw`
window.__EXP__ = (() => {
  const q = (s) => document.querySelector(s)
  const R = (r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom,
    x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2, w: r.width, h: r.height })
  function textRange(text, n) {
    const root = q('.ep-content')
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    const nodes = []
    let all = ''
    for (let t = walker.nextNode(); t; t = walker.nextNode()) { nodes.push([t, all.length]); all += t.data }
    let at = -1
    let from = 0
    for (let k = 0; k <= (n || 0); k++) {
      at = all.indexOf(text, from)
      if (at < 0) return null
      from = at + 1
    }
    const pos = (i) => { for (let j = nodes.length - 1; j >= 0; j--) if (nodes[j][1] <= i) return [nodes[j][0], i - nodes[j][1]] }
    const a = pos(at)
    const b = pos(at + text.length - 1)
    const r = document.createRange()
    r.setStart(a[0], a[1])
    r.setEnd(b[0], b[1] + 1)
    return r
  }
  function find(text, n) {
    const r = textRange(text, n)
    if (!r) return null
    const rs = Array.from(r.getClientRects()).filter((x) => x.width > 0)
    return { first: R(rs[0]), last: R(rs[rs.length - 1]), all: rs.map(R) }
  }
  function reveal(text, n, frac) {
    const sc = q('.ep-scroller')
    const r = textRange(text, n)
    if (!r) return null
    const rect = r.getClientRects()[0]
    const sr = sc.getBoundingClientRect()
    sc.scrollTop += rect.top - (sr.top + frac * sc.clientHeight)
    return find(text, n)
  }
  function hl(name) {
    const h = CSS.highlights.get(name)
    if (!h) return null
    return Array.from(h).map((r) => r.toString()).join('|')
  }
  function scrollers() {
    const out = []
    for (const e of document.querySelectorAll('*')) {
      const s = getComputedStyle(e)
      if (!/^(auto|scroll|overlay)$/.test(s.overflowX) && !/^(auto|scroll|overlay)$/.test(s.overflowY)) continue
      if (e.getClientRects().length === 0) continue
      out.push(String(e.className).trim().split(/\s+/)[0] || e.tagName)
    }
    return out.sort()
  }
  function band() {
    const b = q('.ep-explain')
    if (!b) return null
    const r = b.getBoundingClientRect()
    const live = b.querySelector('.ex-round.ex-live')
    const err = b.querySelector('.ex-err')
    return {
      hidden: b.hidden, rendered: b.getClientRects().length > 0, display: getComputedStyle(b).display,
      top: r.top, h: r.height, styleH: b.style.height,
      blocks: Array.from(b.querySelectorAll('.ex-round-block')).map((x) => ({
        round: x.getAttribute('data-round'), divided: x.classList.contains('ex-divided'),
        text: x.querySelector('.ex-round') ? x.querySelector('.ex-round').textContent : '',
      })),
      live: live ? live.textContent : null,
      thinking: !!b.querySelector('.ex-thinking'),
      err: err ? err.textContent : null,
      words: b.querySelectorAll('.ex-word').length,
      marked: Array.from(b.querySelectorAll('.ex-word.is-marked')).map((x) => x.textContent),
      senses: Array.from(b.querySelectorAll('.sense-odds')).map((x) => x.textContent + (x.classList.contains('lead') ? ' lead' : '')),
      blockquotes: b.querySelectorAll('.ex-round blockquote').length,
      loading: b.querySelectorAll('.pron-badge.loading').length,
      rowWords: Array.from(b.querySelectorAll('.ex-pron-only-row > strong')).map((x) => x.textContent),
      rowVariants: Array.from(b.querySelectorAll('.ex-pron-only .pron-variants > .pron-badge')).map((x) => x.className),
      badges: Array.from(b.querySelectorAll('.ex-round .pron-badge')).map((x) => ({
        cls: x.className, word: x.getAttribute('data-word'), key: x.getAttribute('data-key'),
        mp3: x.getAttribute('data-mp3'), disabled: x.disabled, text: x.textContent,
      })),
      text: b.textContent,
    }
  }
  function inBand(sel, n) {
    const e = q('.ep-explain').querySelectorAll(sel)[n || 0]
    if (!e) return null
    e.scrollIntoView({ block: 'center' })
    return R(e.getBoundingClientRect())
  }
  function box(sel) { const e = q(sel); return e ? R(e.getBoundingClientRect()) : null }
  function scroller() {
    const sc = q('.ep-scroller')
    const r = sc.getBoundingClientRect()
    return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, scrollTop: sc.scrollTop,
      clientHeight: sc.clientHeight, clientWidth: sc.clientWidth, visibleBottom: r.top + sc.clientHeight }
  }
  /** The text of an element as laid out: its leftmost and rightmost glyph
   *  box and its line count.  Text nodes only: a word span's own box may
   *  reach past its glyphs. */
  function textBox(el) {
    const rs = []
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      const r = document.createRange()
      r.selectNodeContents(t)
      for (const x of r.getClientRects()) if (x.width > 0) rs.push(x)
    }
    if (!rs.length) return null
    return { left: Math.min(...rs.map((x) => x.left)), right: Math.max(...rs.map((x) => x.right)),
      lines: new Set(rs.map((x) => Math.round(x.top))).size }
  }
  /** One half of the band (E110): .ex-thread[data-slot=n]. */
  function col(n) {
    const c = q('.ep-explain .ex-thread[data-slot="' + n + '"]')
    if (!c) return null
    const sc = c.querySelector('.ex-scroll')
    const ct = c.querySelector('.ex-content')
    const cs = getComputedStyle(c)
    const live = c.querySelector('.ex-round.ex-live')
    const err = c.querySelector('.ex-err')
    const para = c.querySelector('.ex-round p')
    return {
      rendered: c.getClientRects().length > 0, display: cs.display, inert: c.inert,
      box: R(c.getBoundingClientRect()), bg: cs.backgroundColor, shadow: cs.boxShadow,
      borderLeft: cs.borderLeftWidth + ' ' + cs.borderLeftStyle,
      blocks: c.querySelectorAll('.ex-round-block').length,
      live: live ? live.textContent : null, thinking: !!c.querySelector('.ex-thinking'), err: err ? err.textContent : null,
      text: ct.textContent,
      marked: Array.from(c.querySelectorAll('.ex-word.is-marked')).map((x) => x.textContent),
      scrollTop: sc.scrollTop, scrollHeight: sc.scrollHeight, clientHeight: sc.clientHeight, clientWidth: sc.clientWidth,
      toBottom: sc.scrollHeight - sc.scrollTop - sc.clientHeight,
      // The stable gutter, exact: clientWidth is rounded to a whole px.
      gutter: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--scrollbar-w-editor')),
      scroll: R(sc.getBoundingClientRect()), content: R(ct.getBoundingClientRect()),
      para: para ? textBox(para) : null,
    }
  }
  function slots() {
    const s = q('.ep-explain .ex-slots')
    const p = q('.ep-explain .ex-place')
    return {
      layout: s.getAttribute('data-layout'), mode: s.getAttribute('data-place'),
      classes: Array.from(s.classList).filter((c) => c.startsWith('place-')).sort(),
      place: p.hidden, placeRendered: p.getClientRects().length > 0,
      labels: Array.from(p.children).map((h) => h.getAttribute('aria-label')),
      box: R(s.getBoundingClientRect()), placeBox: R(p.getBoundingClientRect()),
      cols: [col(0), col(1)],
    }
  }
  /** Where the keyboard is: Cairn's band Esc is #reader's, so focus on
   *  <body> is a band Esc can no longer close. */
  function active() {
    const a = document.activeElement
    return { cls: a ? String(a.className) : null, inReader: !!a && !!a.closest && !!a.closest('#reader'), body: a === document.body }
  }
  /** What the pointer would hit at a point, and its cursor. */
  function hit(x, y) {
    const e = document.elementFromPoint(x, y)
    return e ? { cls: String(e.className), cursor: getComputedStyle(e).cursor } : null
  }
  /** Two adjacent answer words of one half's round: the first 'word' and
   *  the one after it, scrolled into that half's view. */
  function pair(slot, round, word) {
    const all = Array.from(document.querySelectorAll('.ep-explain .ex-thread[data-slot="' + slot + '"] .ex-round-block[data-round="' + round + '"] .ex-word'))
    const i = all.findIndex((e) => e.getAttribute('data-word') === word)
    if (i < 0 || !all[i + 1]) return null
    all[i].scrollIntoView({ block: 'center' })
    const a = R(all[i].getBoundingClientRect())
    const b = R(all[i + 1].getBoundingClientRect())
    return { a, b, words: [word, all[i + 1].getAttribute('data-word')] }
  }
  return { find, reveal, hl, scrollers, band, inBand, box, scroller, col, slots, active, hit, pair }
})()
`

/* ── the app over the DevTools protocol ───────────────────────────────── */

async function launch({ vault, state, base, expect = base, geom = '1200x800' }) {
  const env = { ...process.env }
  // Hermetic: nothing the caller's shell exports reaches the app.
  for (const k of Object.keys(env)) if (k.startsWith('CAIRN_')) delete env[k]
  Object.assign(env, {
    CAIRN_HEADLESS: '1',
    CAIRN_VAULT: vault,
    CAIRN_STATE_DIR: state,
    CAIRN_PIXELTEST_NOTE: BOOK,
    CAIRN_ELECTRON_GEOM: geom,
  })
  if (base) env.CAIRN_AI_BASE = base
  const child = spawn(BIN, ['--remote-debugging-port=0', join(HERE, 'app-main.mjs')], {
    cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let err = ''
  child.stdout.on('data', () => {})
  child.stderr.on('data', (d) => { err += d })
  const exited = new Promise((r) => child.once('exit', r))
  let ws = null
  const consoleLines = []
  const exceptions = []
  const close = async () => {
    try { ws && ws.close() } catch {}
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exited
  }
  try {
    const port = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no DevTools port within 30s\n' + err)), 30_000)
      const scan = () => {
        const m = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(err)
        if (m) { clearTimeout(t); resolve(Number(m[1])) }
      }
      child.stderr.on('data', scan)
      child.once('exit', () => { clearTimeout(t); reject(new Error('app exited before DevTools came up\n' + err)) })
      scan()
    })
    const pages = async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json())
      .filter((t) => t.type === 'page')
    let target = null
    for (let i = 0; i < 200 && !target; i++) {
      target = (await pages()).find((t) => /index\.html/.test(t.url)) ?? null
      if (!target) await sleep(100)
    }
    if (!target) throw new Error('no page target\n' + err)
    ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
    let id = 0
    const pending = new Map()
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data)
      if (m.method === 'Runtime.consoleAPICalled') {
        consoleLines.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
      } else if (m.method === 'Runtime.exceptionThrown') {
        exceptions.push(JSON.stringify(m.params.exceptionDetails).slice(0, 500))
      }
      const p = m.id && pending.get(m.id)
      if (p) { pending.delete(m.id); p(m) }
    }
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const n = ++id
      const t = setTimeout(() => { pending.delete(n); reject(new Error(method + ' timed out')) }, 20_000)
      pending.set(n, (m) => {
        clearTimeout(t)
        if (m.error) reject(new Error(method + ': ' + JSON.stringify(m.error)))
        else resolve(m.result)
      })
      ws.send(JSON.stringify({ id: n, method, params }))
    })
    const ev = async (expr) => {
      const r = await send('Runtime.evaluate', {
        expression: `(async () => (${expr}))()`, awaitPromise: true, returnByValue: true,
      })
      if (r.exceptionDetails) throw new Error('evaluate: ' + JSON.stringify(r.exceptionDetails).slice(0, 600))
      return r.result.value
    }
    const X = (call) => ev('window.__EXP__.' + call)
    const frames = () => ev('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))')
    const until = async (what, expr, ms = 5000) => {
      const t0 = Date.now()
      let last
      for (;;) {
        last = await ev(expr)
        if (last) return last
        if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what} (${expr})`)
        await sleep(40)
      }
    }
    const mouse = (type, p, extra = {}) => send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, ...extra })
    const move = async (p) => { await mouse('mouseMoved', p); await frames() }
    const click = async (p, { count = 1, button = 'left' } = {}) => {
      const buttons = button === 'middle' ? 4 : button === 'right' ? 2 : 1
      await mouse('mouseMoved', p)
      await mouse('mousePressed', p, { button, buttons, clickCount: count })
      await mouse('mouseReleased', p, { button, buttons: 0, clickCount: count })
      await frames()
    }
    /** Press at the first point, move through the rest, release at the last. */
    const gesture = async (points) => {
      const [a, ...rest] = points
      await mouse('mouseMoved', a)
      await mouse('mousePressed', a, { button: 'left', buttons: 1, clickCount: 1 })
      for (const p of rest) {
        await mouse('mouseMoved', p, { button: 'left', buttons: 1 })
        await frames()
      }
      await mouse('mouseReleased', points[points.length - 1], { button: 'left', buttons: 0, clickCount: 1 })
      await frames()
    }
    const drag = (a, b, steps = 8) => gesture([a, ...Array.from({ length: steps }, (_, i) =>
      ({ x: a.x + ((b.x - a.x) * (i + 1)) / steps, y: a.y + ((b.y - a.y) * (i + 1)) / steps }))])
    const key = async (k, code, vk, modifiers = 0) => {
      const base = { key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers }
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
      await frames()
    }
    /** A key held down: one press, then `repeats` auto-repeat keydowns. */
    const hold = async (k, code, vk, repeats) => {
      const base = { key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
      for (let i = 0; i < repeats; i++) await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', autoRepeat: true, ...base })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
      await frames()
    }
    const wheel = async (p, deltaY) => {
      await mouse('mouseMoved', p)
      await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: p.x, y: p.y, deltaX: 0, deltaY })
      await frames()
    }
    /** PNG bytes of a viewport clip: equal bytes are equal pixels. */
    const shot = async (r, pad = 2) => (await send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: Math.floor(r.left - pad), y: Math.floor(r.top - pad), width: Math.ceil(r.w + 2 * pad), height: Math.ceil(r.h + 2 * pad), scale: 1 },
    })).data
    const inject = async () => {
      const r = await send('Runtime.evaluate', { expression: PAGE_HELPER })
      if (r.exceptionDetails) throw new Error('page helper: ' + JSON.stringify(r.exceptionDetails).slice(0, 600))
    }

    await send('Runtime.enable')
    // An offscreen window is never focused; the keyboard paths need a focused page.
    await send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await until('the book to render', `!!document.querySelector('.ep-content .ep-chapter') && !!document.querySelector('#reader .ep-explain')`, 20_000)
    await inject()
    // Never drive a page that could reach the real, billed ai-service: every
    // click below would post to it.  Only the gated live leg passes null.
    const pageBase = await ev('window.__CAIRN_AI_BASE__ ?? null')
    if (expect !== null && pageBase !== expect) {
      throw new Error(`refusing to drive the app: its ai-service is ${pageBase ?? 'the default'}, not ${expect}`)
    }
    await frames()
    return {
      send, ev, X, frames, until, move, click, gesture, drag, key, hold, wheel, shot, pages, close, consoleLines, exceptions,
    }
  } catch (e) {
    await close()
    throw e
  }
}

/* ── fixtures and sessions ─────────────────────────────────────────────── */

const work = SKIP ? null : mkdtempSync(join(tmpdir(), 'cairn-explain-'))
const vault = work && join(work, 'vault')
const state = work && join(work, 'state')
const ai = fakeAi()
let app = null
let app2 = null
let app3 = null
let wide = null

after(async () => {
  for (const a of [app, app2, app3, wide]) { try { await a?.close() } catch {} }
  try { await ai.close() } catch {}
  if (work) { try { rmSync(work, { recursive: true, force: true }) } catch {} }
})

let ready = false
async function setup() {
  if (ready) return
  ready = true
  await ai.listen()
  mkdirSync(vault, { recursive: true })
  mkdirSync(state, { recursive: true })
  writeFileSync(join(vault, BOOK), makeBook(`${ai.base}/book-link`))
  writeFileSync(join(vault, 'Note.md'), 'a note\n')
}

const STAGED = `!document.querySelector('.ep-explain .ex-place').hidden`

/** Pick `word` in the book with a real click, wait for the request.  On a
 *  band that holds anything the pick is STAGED (E110) and asks nothing until
 *  a half is clicked: `place` names that half ('left' replaces the whole
 *  panel), and a staged pick without one is an error. */
async function pick(a, word, n = 0, frac = 0.3, place = null) {
  const before = ai.explains.length
  const at = await a.X(`reveal(${JSON.stringify(word)}, ${n}, ${frac})`)
  assert.ok(at, `the book has no "${word}"`)
  await a.click(at.first)
  if (place) {
    await a.until(`"${word}" to be staged`, STAGED)
    assert.equal(ai.explains.length, before, `the staged "${word}" asked ai-service before it was placed`)
    await a.click(await a.X(`box('.ep-explain .ex-place-${place}')`))
  }
  return ai.waitExplains(before + 1)
}

/** Pick `word` on a band that holds an answer: it must be staged, and must
 *  ask nothing. */
async function stage(a, word, n = 0, frac = 0.3) {
  const before = ai.explains.length
  const at = await a.X(`reveal(${JSON.stringify(word)}, ${n}, ${frac})`)
  assert.ok(at, `the book has no "${word}"`)
  await a.click(at.first)
  await a.until(`"${word}" to be staged`, STAGED)
  await sleep(150)
  assert.equal(ai.explains.length, before, `staging "${word}" asked ai-service`)
}

const tinted = (bg) => bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent'

/** Wait until the band's stream is over (no live round, no dots). */
const settled = (a) => a.until('the answer to finish',
  `(() => { const b = window.__EXP__.band(); return b && !b.hidden && b.live === null && !b.thinking && (b.blocks.length > 0 || b.err !== null) })()`)

const readState = () => {
  try { return JSON.parse(readFileSync(join(state, 'state.json'), 'utf8')) } catch { return null }
}

/* The first pick's answer: two senses, MW badges in every state. */
const LANTERN_ANSWER =
  '[[SENSE p="70"]] **lantern** [[PRON word="lantern" pos="noun" ipa="ˈlan-tərn"]]: a lamp in a case of glass, ' +
  'so the wind cannot blow it out. Here the keeper lights one each evening. — close to: *lamp*, *light*, *beacon*.\n' +
  '> He carried a **lantern** down to the boats.\n\n' +
  '[[SENSE p="30"]] **lantern** [[PRON word="lantern" pos="noun" ipa="ˈlan-tərn"]]: the glass room at the top of a lighthouse.\n' +
  '> 🗣️ *Used by:* keepers, who speak of a **glimmer** [[PRON word="glimmer" pos="noun" ipa="ˈgli-mər"]], ' +
  'a **zyzzyva** [[PRON word="zyzzyva" pos="noun" ipa="ˈzi-zə-və"]] and how to **quell** [[PRON word="quell" pos="verb" ipa="ˈkwel"]] a storm.'
/** The first chunk ends INSIDE a `[[PRON` opener. */
const HALF_TAG = LANTERN_ANSWER.indexOf('[[PRON') + '[[PRON word="lan'.length

describe('E109 click-to-explain, real engine (fake ai-service)', { skip: SKIP }, () => {
  const g1 = gate()
  const g2 = gate()
  let first = null

  test('launch: the band is hidden and reader mode has two rendered scrollers', async () => {
    await setup()
    app = await launch({ vault, state, base: ai.base })
    const b = await app.X('band()')
    assert.ok(b, 'no .ep-explain in #reader')
    assert.deepEqual({ hidden: b.hidden, rendered: b.rendered, scrollers: await app.X('scrollers()') },
      { hidden: true, rendered: false, scrollers: ['ep-scroller', 'tree-scroller'] },
      'before any pick the band must be hidden, render no box, and add no scroller')
  })

  // First pointer contact of the session: the baseline shot is a book no
  // hover has ever painted.
  test('hover paints the word under the pointer, with a pointer cursor', async () => {
    const at = await app.X(`reveal('lantern', 0, 0.3)`)
    const word = at.first
    const margin = { x: (await app.X('scroller()')).left + 12, y: word.y }
    await app.move(margin)
    const clean = await app.shot(word)
    await app.move(word)
    assert.deepEqual({
      hover: await app.X(`hl('cairn-explain-hover')`),
      over: await app.ev(`document.querySelector('.ep-content').classList.contains('ex-over-word')`),
    }, { hover: 'lantern', over: true }, 'hover did not highlight the word under the pointer')
    assert.equal(await app.ev(`getComputedStyle(document.querySelector('.ep-content')).cursor`), 'pointer',
      'the cursor over a pickable word is not a pointer')
    assert.notEqual(await app.shot(word), clean, 'the hover highlight paints nothing (::highlight did not resolve)')
    // A margin snaps the caret to the nearest text; it must not light a word.
    await app.move(margin)
    assert.equal(await app.shot(word), clean, 'the hover paint outlived the hover')
    assert.equal(await app.X(`hl('cairn-explain-hover')`), null, 'a margin point still highlights a word')
    assert.equal(await app.ev(`getComputedStyle(document.querySelector('.ep-content')).cursor`), 'auto',
      'the pointer cursor outlived the hover')
  })

  test('book text is not selectable', async () => {
    const h = (await app.X(`reveal('The Harbour', 0, 0.2)`)).first
    const p = (await app.X(`find('lit the lantern')`)).first
    // From the blank end of the heading's line (inside .ep-content, on no
    // word) down across a paragraph: an ordinary text-selecting drag.
    await app.drag({ x: h.right + 120, y: h.y }, { x: p.right, y: p.y })
    assert.equal(await app.ev('getSelection().toString()'), '', 'a drag across the book selected text')
    assert.equal(ai.explains.length, 0, 'a drag from a blank spot was a pick')
    assert.equal(await app.ev(`getComputedStyle(document.querySelector('.ep-content')).userSelect`), 'none',
      'the book does not declare user-select: none')
  })

  test('a click on a word asks ai-service about the passage around it', async () => {
    ai.next({
      events: [
        { event: 'pron-data', data: { prons: { lantern: { hword: 'lantern', variants: [
          { pos: 'noun', posList: ['noun'], num: '1 of 2', ipa: 'ˈlan-tərn', mp3: ai.base + '/audio/lantern.wav' },
          { pos: 'verb', posList: ['verb'], num: '2 of 2', ipa: 'ˈlan-tərnz', mp3: ai.base + '/audio/lantern-verb.wav' },
        ] } } } },
        { gate: g1.promise },
        { event: 'chunk', data: { text: LANTERN_ANSWER.slice(0, HALF_TAG) } },
        { gate: g2.promise },
        ...pieces(LANTERN_ANSWER.slice(HALF_TAG), 5),
        { event: 'done', data: {} },
      ],
    })
    // Focus off the book first, so the pick's own focus() is what is seen.
    await app.ev(`(document.activeElement && document.activeElement.blur(), document.body.focus(), 1)`)
    first = await pick(app, 'lantern')
    assert.match(first.type, /^application\/json/, 'the request is not sent as JSON (ai-service answers 415)')
    assert.deepEqual({ items: first.body.items, history: first.body.history },
      { items: [{ phrase: 'lantern', words: ['lantern'] }], history: [] }, 'the request body is not {items:[lantern], history:[]}')
    assert.ok(first.body.text.startsWith('The Lantern Keeper — Ada Quill\nThe Harbour\n\n'),
      'the passage lost its book/chapter orientation: ' + JSON.stringify(first.body.text.slice(0, 80)))
    assert.ok(first.body.text.includes('The old keeper lit the lantern every evening before the tide turned.'),
      'the passage does not hold the clicked sentence')
    assert.ok(first.body.text.length <= 2500, 'the passage is over CONTEXT_CAP: ' + first.body.text.length)
    assert.ok(app.consoleLines.some((l) => l.startsWith('[explain] "lantern"')), 'no [explain] console line')
  })

  test('the pick opens the band at 320px with thinking dots, marks the word, keeps focus on the book', async () => {
    await app.until('the band to show', `!window.__EXP__.band().hidden`)
    await app.frames()
    const b = await app.X('band()')
    assert.equal(b.rendered, true, 'the shown band renders no box')
    assert.equal(b.h, 320, 'the band did not open at its 320px default')
    assert.equal(b.thinking, true, 'no thinking dots before the first chunk')
    assert.equal(await app.ev(`getComputedStyle(document.querySelector('.ep-explain .ex-thinking span')).animationName`),
      'ex-thinking-pulse', 'the thinking dots lost their exemption from the animation ban')
    assert.equal(await app.X(`hl('cairn-explain-mark')`), 'lantern', 'the picked word is not marked')
    assert.equal(await app.ev(`document.activeElement && document.activeElement.className`), 'ep-scroller',
      'the pick did not leave the keyboard with the book')
  })

  test('while the band is open there are exactly three rendered scrollers', async () => {
    assert.deepEqual(await app.X('scrollers()'), ['ep-scroller', 'ex-scroll', 'tree-scroller'],
      'the open band is not exactly the third rendered scroller')
  })

  test('the answer streams into a live round and hides a half-arrived tag', async () => {
    g1.open()
    await app.until('the first chunk', `window.__EXP__.band().live !== null && window.__EXP__.band().live.includes('lantern') && !window.__EXP__.band().thinking`)
    const mid = await app.X('band()')
    assert.ok(!/\[\[|PRON/.test(mid.text), 'a half-arrived [[PRON tag shows: ' + JSON.stringify(mid.text))
    assert.deepEqual(mid.senses, ['70% lead'], 'the likelier sense is not a .lead chip')
    assert.equal(mid.words, 0, 'words of a live round are wrapped for drill-down')
  })

  test('the finished answer commits as one clean round with quote boxes and drill-down words', async () => {
    g2.open()
    await settled(app)
    const b = await app.X('band()')
    assert.deepEqual({ blocks: b.blocks.map((x) => x.round), err: b.err }, { blocks: ['0'], err: null },
      'the answer is not one round with no error line')
    assert.ok(!/\[\[|\]\]/.test(b.text), 'tag syntax leaked into the answer: ' + JSON.stringify(b.text))
    assert.equal(b.blockquotes, 2, 'the two sense groups are not two quote boxes')
    assert.ok(b.words > 20, 'the committed round has no drill-down words')
  })

  test('the pron-only row and the inline badges reach their real states', async () => {
    await app.until('every badge to settle', `window.__EXP__.band().loading === 0`)
    const b = await app.X('band()')
    const one = (w) => {
      const x = b.badges.filter((y) => y.word === w || (y.key ?? '').startsWith(w + '|'))
      return x.map((y) => [y.cls, y.mp3 ? y.mp3.replace(ai.base, '') : null, y.disabled,
        y.text.includes('AI') ? 'AI' : y.text.includes('pron unavailable') ? 'pron unavailable' : '-'])
    }
    assert.deepEqual({
      row: b.rowWords,
      rowVariants: b.rowVariants,
      lantern: one('lantern'),
      glimmer: one('glimmer'),
      zyzzyva: one('zyzzyva'),
      quell: one('quell'),
    }, {
      row: ['lantern'],
      rowVariants: ['pron-badge is-picked', 'pron-badge'],
      lantern: [['pron-badge', '/audio/lantern.wav', false, '-'], ['pron-badge', '/audio/lantern.wav', false, '-']],
      glimmer: [['pron-badge', '/audio/glimmer.wav', false, '-']],
      zyzzyva: [['pron-badge ai-made', null, true, 'AI']],
      quell: [['pron-badge failed err-mw', null, true, 'pron unavailable']],
    }, 'a badge is not in its real state (row: pron-data variants, noun picked; 200 real; 404 AI; 502 unavailable)')
    const asked = ai.prons.map((p) => `${p.word}|${p.pos}`)
    assert.deepEqual(['glimmer|noun', 'zyzzyva|noun', 'quell|verb'].map((k) => asked.filter((a) => a === k).length), [1, 1, 1],
      'each inline word is not looked up exactly once with its pos: ' + asked)
  })

  test('a click on a real badge plays its clip and marks it playing until the clip ends', async () => {
    const sel = '.ex-round .pron-badge[data-mp3$="/audio/glimmer.wav"]'
    const at = await app.X(`inBand(${JSON.stringify(sel)})`)
    assert.ok(at, 'no glimmer badge to click')
    await app.click(at)
    // Read at once: the clip is 1.2 s.
    const playing = await app.ev(`!!document.querySelector(${JSON.stringify(sel)}) && document.querySelector(${JSON.stringify(sel)}).classList.contains('is-playing')`)
    const focused = await app.ev(`!!document.activeElement && document.activeElement.classList.contains('pron-badge')`)
    const t0 = Date.now()
    while (!ai.audio.includes('glimmer.wav') && Date.now() - t0 < 3000) await sleep(40)
    assert.equal((await app.X('band()')).hidden, false, 'a click on a badge closed the band')
    assert.equal(ai.explains.length, 1, 'a badge click asked ai-service something')
    assert.ok(ai.audio.includes('glimmer.wav'), 'the clip was never requested: ' + ai.audio)
    assert.equal(playing, true, 'the clicked badge is not .is-playing')
    assert.equal(focused, false, 'a mouse click left focus on the badge')
    await app.until('the clip to end', `!document.querySelector('.ex-round .pron-badge.is-playing')`)
  })

  test('a drag over words of a finished answer drills down with the thread passage and the history', async () => {
    const lamp = await app.X(`inBand('.ex-round-block[data-round="0"] .ex-word[data-word="lamp"]')`)
    assert.ok(lamp, 'no "lamp" word span in the committed answer')
    const next = await app.ev(`(() => { const all = Array.from(document.querySelectorAll('.ex-round-block[data-round="0"] .ex-word'));
      const i = all.findIndex((e) => e.getAttribute('data-word') === 'lamp'); const r = all[i + 1].getBoundingClientRect();
      return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2, word: all[i + 1].getAttribute('data-word') } })()`)
    assert.equal(next.word, 'in', 'fixture: the word after "lamp" moved')
    // Released over the BOOK, above the band: the click that follows the
    // release is the gesture's own, not an outside click.
    const top = (await app.X('band()')).top
    await app.gesture([lamp, next, { x: next.x, y: top - 60 }])
    const r = await ai.waitExplains(2)
    assert.deepEqual(r.body.items, [{ phrase: 'lamp in', words: ['lamp', 'in'] }], 'the drilled phrase is not "lamp in"')
    assert.equal(r.body.text, first.body.text, 'a drill-down did not replay the thread\'s passage')
    assert.deepEqual(r.body.history, [LANTERN_ANSWER], 'history is not the first answer, raw')
  })

  test('the drill-down is a new round under the first, the band stays open, the drilled words stay marked', async () => {
    await app.until('the drill-down to finish', `window.__EXP__.band().hidden || (window.__EXP__.band().live === null && !window.__EXP__.band().thinking)`)
    const b = await app.X('band()')
    assert.equal(b.hidden, false, 'the drill-down\'s trailing click closed the band')
    assert.deepEqual(b.blocks.map((x) => [x.round, x.divided]), [['0', false], ['1', true]],
      'the drill-down is not round 1, divided, under round 0')
    assert.deepEqual(b.marked, ['lamp', 'in'], 'the drilled words are not marked in round 0')
  })

  /* ── E110: the two halves ────────────────────────────────────────────────
   * The band holds the lantern thread (two rounds).  Each step starts from
   * the state the one before it left. */

  // A playable badge and a link: what Tab would land on if the columns
  // under a staged pick were not inert.
  const keeperA = () => 'The keeper tends the **lantern** [[PRON word="lantern" pos="noun" ipa="ˈlan-tərn"]] and keeps ' +
    `[the log](${ai.base}/answer-link) of every ship.\n\n` + longAnswer('keeper', 9)
  const KEEPER_B = '\n\n' + longAnswer('later', 5)
  const MAST_A = '**mast**: ' + longAnswer('mast', 7)
  const MAST_B = '\n\n' + longAnswer('rigging', 2)
  const gK = gate()
  const gM = gate()
  const AT_BAND = { cls: 'ep-explain', inReader: true, body: false }
  const FOUR = ['ep-scroller', 'ex-scroll', 'ex-scroll', 'tree-scroller']
  let keeperReq = null
  let mastReq = null
  /** A point in the book's margin above the band: off the halves, on no word. */
  const offBand = async (a) => ({ x: (await a.X('scroller()')).left + 12, y: (await a.X('slots()')).box.top - 40 })

  test('E110: a second pick is STAGED: no request, the overlay over both halves, the mark on the new word, a pointer over the band', async () => {
    await settled(app)
    const old = await app.X('col(0)')
    const n = ai.explains.length
    const lines = app.consoleLines.length
    await stage(app, 'keeper')
    const s = await app.X('slots()')
    assert.deepEqual({
      layout: s.layout, mode: s.mode, place: s.place, rendered: s.placeRendered, labels: s.labels,
      inert: s.cols.map((c) => c.inert), classes: s.classes, tint: s.cols.map((c) => tinted(c.bg)),
      kept: [s.cols[0].blocks, s.cols[0].text === old.text],
      logged: app.consoleLines.slice(lines).filter((l) => l.startsWith('[explain]')).length,
    }, {
      layout: 'single', mode: 'second', place: false, rendered: true,
      labels: ['Replace the whole panel with the new explanation', 'Split the panel and put the new explanation on the right'],
      inert: [true, true], classes: [], tint: [false, false],
      kept: [2, true],
      logged: 0,
    }, 'a pick on a band holding an answer was not staged, unseen, over the old answer')
    assert.deepEqual(s.placeBox, s.box, 'the overlay does not cover the whole row of halves')
    assert.equal(await app.X(`hl('cairn-explain-mark')`), 'keeper', 'the book mark did not move to the staged word')
    assert.deepEqual(await app.X(`hit(${s.box.left + s.box.w / 4}, ${s.box.y})`), { cls: 'ex-place-half ex-place-left', cursor: 'pointer' },
      'the band under a staged pick is not a pointer target')
    // A placement is a billed request: a script can neither click nor key it.
    await app.ev(`(() => { const h = document.querySelector('.ep-explain .ex-place-right'); h.click();
      h.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return 1 })()`)
    await sleep(200)
    assert.deepEqual({ asked: ai.explains.length - n, staged: await app.ev(STAGED), layout: (await app.X('slots()')).layout },
      { asked: 0, staged: true, layout: 'single' }, 'an untrusted click or Enter on a half placed the pick')
  })

  test('E110: hovering the left half tints the whole panel, moves nothing and asks nothing', async () => {
    const n = ai.explains.length
    const before = await app.X('slots()')
    await app.move(await app.X(`box('.ep-explain .ex-place-left')`))
    const s = await app.X('slots()')
    assert.deepEqual({
      classes: s.classes, tint: s.cols.map((c) => tinted(c.bg)), right: s.cols[1].display,
      whole: s.cols[0].box.w === s.box.w, line: s.cols[0].shadow, reflowed: s.cols[0].scrollHeight !== before.cols[0].scrollHeight,
      asked: ai.explains.length - n,
    }, { classes: ['place-left'], tint: [true, false], right: 'none', whole: true, line: 'none', reflowed: false, asked: 0 },
    'the left preview is not a wash over the whole one-panel band')
  })

  test('E110: hovering the right half previews the split: an empty right half, the answer at half width, an inset centre line', async () => {
    const n = ai.explains.length
    await app.move(await offBand(app))
    const full = await app.X('col(0)')
    await app.move(await app.X(`box('.ep-explain .ex-place-right')`))
    const s = await app.X('slots()')
    const [l, r] = s.cols
    assert.deepEqual({
      classes: s.classes, layout: s.layout, right: [r.rendered, r.display, r.blocks, r.text],
      tint: [tinted(l.bg), tinted(r.bg)], lineOnLeft: /inset/.test(l.shadow) && /-\d/.test(l.shadow),
      lineOnRight: r.shadow, border: r.borderLeft, asked: ai.explains.length - n,
    }, {
      classes: ['place-right'], layout: 'single', right: [true, 'flex', 0, ''],
      tint: [false, true], lineOnLeft: true, lineOnRight: 'none', border: '0px none', asked: 0,
    }, 'the right preview is not an empty, tinted right half beside the answer with the line inset on the left column: ' + l.shadow)
    assert.ok(Math.abs(l.box.w - r.box.w) <= 1 && Math.abs(l.box.w - s.box.w / 2) <= 1,
      `the preview halves are not equal: ${l.box.w} + ${r.box.w} of ${s.box.w}`)
    assert.ok(l.content.w < full.content.w * 0.6 && l.scrollHeight > full.scrollHeight,
      `the answer did not reflow to half width (content ${full.content.w} -> ${l.content.w}, height ${full.scrollHeight} -> ${l.scrollHeight})`)
    assert.deepEqual(await app.X('scrollers()'), FOUR, 'the right preview is not exactly the fourth rendered scroller')
    // Leaving the halves ends the preview, not the stage.
    await app.move(await offBand(app))
    const back = await app.X('slots()')
    assert.deepEqual({
      classes: back.classes, right: back.cols[1].display, whole: back.cols[0].box.w === back.box.w,
      height: back.cols[0].scrollHeight, staged: !back.place, asked: ai.explains.length - n,
    }, { classes: [], right: 'none', whole: true, height: full.scrollHeight, staged: true, asked: 0 },
    'leaving the halves did not end the preview, or ended the stage')
  })

  test('E110: Esc drops the stage: nothing is asked, the mark goes back to the placed word, the answer stays', async () => {
    const n = ai.explains.length
    assert.equal((await app.X('active()')).cls, 'ep-scroller', 'fixture: the pick did not leave the keyboard with the book')
    await app.key('Escape', 'Escape', 27)
    const s = await app.X('slots()')
    assert.deepEqual({
      place: s.place, mode: s.mode, inert: s.cols.map((c) => c.inert), open: !(await app.X('band()')).hidden,
      blocks: s.cols[0].blocks, mark: await app.X(`hl('cairn-explain-mark')`), asked: ai.explains.length - n,
    }, { place: true, mode: null, inert: [false, false], open: true, blocks: 2, mark: 'lantern', asked: 0 },
    'Esc did not drop only the staged pick and put the mark back on the placed word')
  })

  test('E110: a held Esc drops the stage and nothing more', async () => {
    await stage(app, 'keeper')
    await app.ev(`(window.__repeats = 0, window.addEventListener('keydown', (e) => { if (e.repeat) window.__repeats++ }, true), 1)`)
    await app.hold('Escape', 'Escape', 27, 4)
    assert.ok(await app.ev('window.__repeats') >= 1, 'fixture: the held key delivered no auto-repeat keydown')
    assert.deepEqual({
      staged: await app.ev(STAGED), open: !(await app.X('band()')).hidden, mark: await app.X(`hl('cairn-explain-mark')`),
    }, { staged: false, open: true, mark: 'lantern' }, 'a held Esc went through more than one layer')
  })

  test('E110: a book drag released over the band is staged there, and its trailing click places nothing', async (t) => {
    const n = ai.explains.length
    const at = (await app.X(`reveal('keeper', 0, 0.3)`)).first
    const row = (await app.X('slots()')).box
    const over = { x: row.left + row.w / 4, y: row.y }
    // The release lands on the answer; the overlay appears under it.
    await app.gesture([at, { x: at.x, y: at.y + 20 }, over])
    await sleep(200)
    const s = await app.X('slots()')
    assert.deepEqual({
      staged: !s.place, layout: s.layout, blocks: s.cols[0].blocks, asked: ai.explains.length - n,
      mark: await app.X(`hl('cairn-explain-mark')`),
    }, { staged: true, layout: 'single', blocks: 2, asked: 0, mark: 'keeper' },
    'a pick released over the band was not staged, or its trailing click placed it')
    // The overlay appears under the still pointer, and the engine's hover
    // update sends the half under it a mouseenter: the preview shows before
    // any move.
    t.diagnostic(`preview right after a release over the band: [${s.classes.join(', ')}]`)
    assert.deepEqual(s.classes, ['place-left'], 'the half that appeared under the still pointer shows no preview')
    await app.move({ x: over.x + 4, y: over.y })
    assert.deepEqual((await app.X('slots()')).classes, ['place-left'], 'moving over the staged half shows no preview')
    await app.move(await offBand(app))
    await app.key('Escape', 'Escape', 27)
    assert.equal(await app.ev(STAGED), false, 'fixture: Esc did not drop the stage')
  })

  test('E110: the grip still resizes the band while a pick is staged', async () => {
    await stage(app, 'keeper')
    const n = ai.explains.length
    const g = await app.X(`box('.ep-explain .ex-grip')`)
    assert.deepEqual(await app.X(`hit(${g.x}, ${g.y})`), { cls: 'ex-grip', cursor: 'row-resize' }, 'the staged overlay covers the grip')
    const h0 = (await app.X('band()')).h
    await app.drag({ x: g.x, y: g.y }, { x: g.x, y: g.y - 40 })
    const up = (await app.X('band()')).h
    const g2 = await app.X(`box('.ep-explain .ex-grip')`)
    await app.drag({ x: g2.x, y: g2.y }, { x: g2.x, y: g2.y + 40 })
    await sleep(150)
    assert.deepEqual({ up: up - h0, back: (await app.X('band()')).h, staged: await app.ev(STAGED), asked: ai.explains.length - n },
      { up: 40, back: h0, staged: true, asked: 0 }, 'the grip did not resize a staged band both ways, or a drag placed the pick')
  })

  test('E110: the wheel over a staged pick scrolls the answer under it, never the book', async () => {
    const n = ai.explains.length
    const c0 = await app.X('col(0)')
    assert.ok(c0.scrollHeight - c0.clientHeight >= 80, `fixture: the lantern thread does not overflow its half (${c0.scrollHeight}/${c0.clientHeight})`)
    await app.ev(`(document.querySelector('.ep-explain .ex-thread[data-slot="0"] .ex-scroll').scrollTop = 0, 1)`)
    const book = (await app.X('scroller()')).scrollTop
    const deltas = []
    // Over the left half; then over the right one, which while the band is
    // one panel previews an EMPTY half: the answer is still what scrolls.
    for (const side of ['left', 'right']) {
      const p = await app.X(`box('.ep-explain .ex-place-${side}')`)
      await app.move(p)
      const t0 = (await app.X('col(0)')).scrollTop
      await app.wheel(p, 40)
      deltas.push((await app.X('col(0)')).scrollTop - t0)
    }
    assert.deepEqual({ deltas, book: (await app.X('scroller()')).scrollTop, staged: await app.ev(STAGED), asked: ai.explains.length - n },
      { deltas: [40, 40], book, staged: true, asked: 0 }, 'the wheel over the overlay did not scroll the answer by its delta')
    await app.move(await offBand(app))
  })

  test('E110: a click on the LEFT half replaces the whole panel: both threads start over, one request, focus stays in #reader', async () => {
    const n = ai.explains.length
    ai.next({ events: [...pieces(keeperA(), 10), { gate: gK.promise }, ...pieces(KEEPER_B, 6), { event: 'done', data: {} }] })
    await app.click(await app.X(`box('.ep-explain .ex-place-left')`))
    keeperReq = await ai.waitExplains(n + 1)
    await app.until('the keeper answer to stream', `(() => { const c = window.__EXP__.col(0); return c.live !== null && c.live.includes('keeper part 9') })()`)
    const s = await app.X('slots()')
    assert.deepEqual({
      items: keeperReq.body.items, history: keeperReq.body.history,
      layout: s.layout, place: s.place, mode: s.mode, classes: s.classes, inert: s.cols.map((c) => c.inert),
      left: [s.cols[0].blocks, s.cols[0].text.includes('lighthouse')], right: [s.cols[1].display, s.cols[1].blocks],
      mark: await app.X(`hl('cairn-explain-mark')`), focus: await app.X('active()'),
    }, {
      items: [{ phrase: 'keeper', words: ['keeper'] }], history: [],
      layout: 'single', place: true, mode: null, classes: [], inert: [false, false],
      left: [1, false], right: ['none', 0],
      mark: 'keeper', focus: AT_BAND,
    }, 'the left click did not start the staged pick over the whole panel, or lost focus')
    await sleep(200)
    assert.equal(ai.explains.length, n + 1, 'one placement sent more than one request')
  })

  test('E110: a click on the RIGHT half splits: the left answer keeps streaming and following, both halves stream at once, a committed centre line', async () => {
    // A failure here must not leave either stream hanging for the steps after.
    let passed = false
    try {
      await splitWhileStreaming()
      passed = true
    } finally {
      gK.open()
      gM.open()
      // After a failure, only so the next steps start from settled halves;
      // it must never mask the failure itself.
      if (!passed) await settled(app).catch(() => {})
    }
    await settled(app)
  })

  async function splitWhileStreaming() {
    const c0 = await app.X('col(0)')
    assert.ok(c0.live !== null && c0.scrollHeight > c0.clientHeight + 100 && c0.toBottom < 2,
      `fixture: the left answer is not streaming, overflowing and followed (${c0.scrollHeight}/${c0.clientHeight}, ${c0.toBottom}px from the bottom)`)
    await stage(app, 'mast')
    const n = ai.explains.length
    const lines = app.consoleLines.length
    ai.next({ events: [...pieces(MAST_A, 6), { gate: gM.promise }, ...pieces(MAST_B, 3), { event: 'done', data: {} }] })
    await app.click(await app.X(`box('.ep-explain .ex-place-right')`))
    mastReq = await ai.waitExplains(n + 1)
    await app.until('the right answer to stream', `(() => { const c = window.__EXP__.col(1); return c.live !== null && c.live.includes('mast part 7') })()`)
    const s = await app.X('slots()')
    const [l, r] = s.cols
    assert.deepEqual({
      items: mastReq.body.items, history: mastReq.body.history,
      layout: s.layout, place: s.place, classes: s.classes,
      live: [l.live !== null, r.live !== null],
      left: [l.blocks, (l.live ?? '').includes('keeper part 9'), l.text.includes('mast part')],
      line: [parseFloat(r.borderLeft) > 0 && r.borderLeft.endsWith(' solid'), l.shadow],
      tint: [tinted(l.bg), tinted(r.bg)],
      mark: await app.X(`hl('cairn-explain-mark')`), focus: await app.X('active()'),
      logged: app.consoleLines.slice(lines).filter((x) => x.startsWith('[explain] "mast"')).map((x) => x.split('\n')[0].endsWith(' · right half')),
    }, {
      items: [{ phrase: 'mast', words: ['mast'] }], history: [],
      layout: 'split', place: true, classes: [],
      live: [true, true],
      left: [1, true, false],
      line: [true, 'none'],
      tint: [false, false],
      mark: 'mast', focus: AT_BAND,
      logged: [true],
    }, 'the right click did not split beside the live left answer: ' + r.borderLeft)
    assert.ok(Math.abs(l.box.w - r.box.w) <= 1.5, `the halves are not equal: ${l.box.w} and ${r.box.w}`)
    // D2: the left half was following its stream; the split must not lose it.
    assert.ok(l.toBottom < 2, `the split left the streaming left half ${l.toBottom}px above its bottom`)
    gK.open()
    await app.until('the left answer to finish', `(() => { const c = window.__EXP__.col(0); return c.live === null && !c.thinking && c.blocks === 1 })()`)
    const l2 = await app.X('col(0)')
    assert.ok(l2.text.includes('later part 5'), 'the left stream lost its tail after the split')
    assert.ok(l2.toBottom < 2, `the left half stopped following its stream after the split (${l2.toBottom}px above the bottom)`)
    assert.notEqual((await app.X('col(1)')).live, null, 'the right stream ended with the left one')
  }

  test('E110: while split there are exactly four rendered scrollers', async () => {
    assert.deepEqual(await app.X('scrollers()'), FOUR, 'a split band is not exactly the fourth rendered scroller')
  })

  test('E110: a drill-down extends only the half it is made in, and the other half keeps its marks', async () => {
    const top = (await app.X('band()')).top
    const n = ai.explains.length
    const lines = app.consoleLines.length
    const left0 = await app.X('col(0)')
    const pr = await app.X(`pair(1, 0, 'walks')`)
    assert.ok(pr, 'no "walks" in the right answer')
    // Released over the book: the trailing click is the gesture's.
    await app.gesture([pr.a, pr.b, { x: pr.b.x, y: top - 60 }])
    const rr = await ai.waitExplains(n + 1)
    await settled(app)
    let l = await app.X('col(0)')
    let r = await app.X('col(1)')
    const said = (phrase) => app.consoleLines.slice(lines).filter((x) => x.startsWith(`[explain] "${phrase}"`))
      .map((x) => x.split('\n')[0].endsWith(' · right half'))
    assert.deepEqual({
      items: rr.body.items, passage: rr.body.text === mastReq.body.text, history: rr.body.history,
      right: [r.blocks, r.marked], left: [l.blocks, l.text === left0.text, l.marked],
      logged: said(pr.words.join(' ')), open: !(await app.X('band()')).hidden,
    }, {
      items: [{ phrase: pr.words.join(' '), words: pr.words }], passage: true, history: [MAST_A + MAST_B],
      right: [2, pr.words], left: [1, true, []], logged: [true], open: true,
    }, 'a drill-down in the right half did not extend that half alone with its own passage and history')
    const pl = await app.X(`pair(0, 0, 'counts')`)
    assert.ok(pl, 'no "counts" in the left answer')
    await app.gesture([pl.a, pl.b, { x: pl.b.x, y: top - 60 }])
    const rl = await ai.waitExplains(n + 2)
    await settled(app)
    l = await app.X('col(0)')
    r = await app.X('col(1)')
    assert.deepEqual({
      items: rl.body.items, passage: rl.body.text === keeperReq.body.text, history: rl.body.history,
      left: [l.blocks, l.marked], right: [r.blocks, r.marked], logged: said(pl.words.join(' ')),
    }, {
      items: [{ phrase: pl.words.join(' '), words: pl.words }], passage: true, history: [keeperA() + KEEPER_B],
      left: [2, pl.words], right: [2, pr.words], logged: [false],
    }, 'a drill-down in the left half did not extend that half alone, or cleared the other half\'s marks')
  })

  test('E110: once split, a pick is staged to REPLACE one half: a hover tints only that half, nothing moves, the wheel scrolls that half', async () => {
    await app.until('every badge to settle', `window.__EXP__.band().loading === 0`)
    const before = await app.X('slots()')
    await stage(app, 'dle')
    const n = ai.explains.length
    const s = await app.X('slots()')
    assert.deepEqual({ mode: s.mode, layout: s.layout, labels: s.labels, inert: s.cols.map((c) => c.inert) }, {
      mode: 'replace', layout: 'split', inert: [true, true],
      labels: ['Put the new explanation in the left panel', 'Put the new explanation in the right panel'],
    }, 'a pick on a split band is not staged in replace mode')
    const seen = {}
    for (const side of ['left', 'right']) {
      const p = await app.X(`box('.ep-explain .ex-place-${side}')`)
      await app.move(p)
      const h = await app.X('slots()')
      const t0 = h.cols.map((c) => c.scrollTop)
      await app.wheel(p, -40)
      const t1 = (await app.X('slots()')).cols.map((c) => c.scrollTop)
      seen[side] = {
        classes: h.classes, tint: h.cols.map((c) => tinted(c.bg)), moved: h.cols.some((c, i) => c.box.w !== before.cols[i].box.w || c.box.left !== before.cols[i].box.left),
        wheel: t1.map((t, i) => t - t0[i]),
      }
    }
    assert.deepEqual({ seen, asked: ai.explains.length - n }, {
      seen: {
        left: { classes: ['place-left'], tint: [true, false], moved: false, wheel: [-40, 0] },
        right: { classes: ['place-right'], tint: [false, true], moved: false, wheel: [0, -40] },
      },
      asked: 0,
    }, 'replace mode did not preview and scroll one half at a time')
  })

  test('E110: the right half replaces only itself; the left half is untouched', async () => {
    const n = ai.explains.length
    const l0 = await app.X('col(0)')
    await app.click(await app.X(`box('.ep-explain .ex-place-right')`))
    const req = await ai.waitExplains(n + 1)
    await settled(app)
    const s = await app.X('slots()')
    const [l, r] = s.cols
    assert.deepEqual({
      items: req.body.items, history: req.body.history, layout: s.layout, place: s.place,
      right: [r.blocks, r.text.includes('needle'), r.text.includes('walks')],
      left: [l.blocks, l.text === l0.text, l.marked, l.scrollTop === l0.scrollTop],
      mark: await app.X(`hl('cairn-explain-mark')`), focus: await app.X('active()'),
    }, {
      items: [{ phrase: 'needle', words: ['needle'] }], history: [], layout: 'split', place: true,
      right: [1, true, false], left: [2, true, ['counts', 'the'], true],
      mark: 'needle', focus: AT_BAND,
    }, 'the right placement did not restart the right half alone')
    await sleep(200)
    assert.equal(ai.explains.length, n + 1, 'one placement sent more than one request')
  })

  test('E110: by keyboard: Tab from the grip skips the inert answers to a half, Enter replaces only that half, focus stays in #reader', async () => {
    await app.until('every badge to settle', `window.__EXP__.band().loading === 0`)
    await stage(app, 'gulls')
    const n = ai.explains.length
    const right0 = await app.X('col(1)')
    assert.ok(await app.ev(`!!document.querySelector('.ep-explain .ex-thread[data-slot="0"] .ex-link') && !!document.querySelector('.ep-explain .ex-thread[data-slot="0"] .pron-badge:not([disabled])')`),
      'fixture: the left half holds no link or playable badge for Tab to land on')
    await app.ev(`(document.querySelector('.ep-explain .ex-grip').focus(), 1)`)
    await app.key('Tab', 'Tab', 9)
    assert.deepEqual({
      focus: (await app.X('active()')).cls, classes: (await app.X('slots()')).classes,
      ring: /inset/.test(await app.ev('getComputedStyle(document.activeElement).boxShadow')),
    }, { focus: 'ex-place-half ex-place-left', classes: ['place-left'], ring: true },
    'Tab from the grip did not land on the left half, previewed and ringed')
    await app.key('Enter', 'Enter', 13)
    const req = await ai.waitExplains(n + 1)
    await settled(app)
    const s = await app.X('slots()')
    assert.deepEqual({
      items: req.body.items, layout: s.layout, place: s.place,
      left: [s.cols[0].blocks, s.cols[0].text.includes('gulls'), s.cols[0].text.includes('keeper part')],
      right: s.cols[1].text === right0.text, focus: await app.X('active()'), mark: await app.X(`hl('cairn-explain-mark')`),
    }, {
      items: [{ phrase: 'gulls', words: ['gulls'] }], layout: 'split', place: true,
      left: [1, true, false], right: true, focus: AT_BAND, mark: 'gulls',
    }, 'Enter on the left half did not replace only the left half, or lost focus')
  })

  test('E110: Esc on a focused half drops the stage and keeps focus in #reader, and the next Esc closes both halves', async () => {
    await stage(app, 'cried')
    const n = ai.explains.length
    await app.ev(`(document.querySelector('.ep-explain .ex-grip').focus(), 1)`)
    await app.key('Tab', 'Tab', 9)
    assert.equal((await app.X('active()')).cls, 'ex-place-half ex-place-left', 'fixture: Tab did not reach the left half')
    await app.key('Escape', 'Escape', 27)
    const s = await app.X('slots()')
    assert.deepEqual({
      place: s.place, layout: s.layout, open: !(await app.X('band()')).hidden, focus: await app.X('active()'),
      mark: await app.X(`hl('cairn-explain-mark')`),
    }, { place: true, layout: 'split', open: true, focus: AT_BAND, mark: 'gulls' },
    'Esc on a focused half did not drop the stage with focus kept inside #reader')
    await app.key('Escape', 'Escape', 27)
    const s2 = await app.X('slots()')
    assert.deepEqual({
      hidden: (await app.X('band()')).hidden, layout: s2.layout, place: s2.place,
      halves: s2.cols.map((c) => [c.blocks, c.text]), mark: await app.X(`hl('cairn-explain-mark')`),
      focus: (await app.X('active()')).cls, scrollers: await app.X('scrollers()'), asked: ai.explains.length - n,
    }, {
      hidden: true, layout: 'single', place: true, halves: [[0, ''], [0, '']], mark: null,
      focus: 'ep-scroller', scrollers: ['ep-scroller', 'tree-scroller'], asked: 0,
    }, 'the second Esc did not close both halves and hand the keyboard back to the book')
  })

  test('E110: reopened, the band is one panel and the third scroller; after a mouse placement Esc still closes it', async () => {
    await pick(app, 'lantern')
    await settled(app)
    const s = await app.X('slots()')
    assert.deepEqual({ layout: s.layout, right: s.cols[1].display, scrollers: await app.X('scrollers()') },
      { layout: 'single', right: 'none', scrollers: ['ep-scroller', 'ex-scroll', 'tree-scroller'] },
      'the reopened band is not one panel, the third rendered scroller')
    await pick(app, 'keeper', 0, 0.3, 'right')
    await app.until('the split', `window.__EXP__.slots().layout === 'split'`)
    assert.deepEqual(await app.X('active()'), AT_BAND, 'a mouse placement left focus outside the band')
    await app.key('Escape', 'Escape', 27)
    assert.equal((await app.X('band()')).hidden, true, 'Esc after a mouse placement did not close the band')
  })

  test('E110: an outside click while a pick is staged in a split band closes everything and asks nothing', async () => {
    await pick(app, 'lantern')
    await settled(app)
    await pick(app, 'keeper', 0, 0.3, 'right')
    await settled(app)
    await stage(app, 'mast')
    const n = ai.explains.length
    const at = (await app.X(`reveal('The Harbour', 0, 0.3)`)).first
    await app.click({ x: at.right + 150, y: at.y })
    await sleep(200)
    const s = await app.X('slots()')
    assert.deepEqual({
      hidden: (await app.X('band()')).hidden, staged: await app.ev(STAGED), layout: s.layout, mode: s.mode,
      halves: s.cols.map((c) => [c.blocks, c.text]), mark: await app.X(`hl('cairn-explain-mark')`), asked: ai.explains.length - n,
    }, {
      hidden: true, staged: false, layout: 'single', mode: null, halves: [[0, ''], [0, '']], mark: null, asked: 0,
    }, 'an outside click did not close both halves and the staged pick')
  })

  /* A press that begins in the band, a re-stage under a still pointer, and
   * Esc inside a double-click.  The band starts closed; the last step closes
   * it again for the E109 steps after. */

  /** Every click from here on, and where the engine aimed it: a press and a
   *  release on different elements click their common ancestor. */
  const recordClicks = (a) => a.ev(`(window.__clicks = [], window.__clickRec || (window.__clickRec = 1,
    window.addEventListener('click', (e) => { const t = e.target; window.__clicks.push({
      to: t.id ? '#' + t.id : String(t.className || t.nodeName),
      inBand: document.querySelector('.ep-explain').contains(t) }) }, true)), 1)`)
  const takeClicks = (a) => a.ev(`(() => { const c = window.__clicks || []; window.__clicks = []; return c })()`)

  test('E110: a press on a staged half released over the book or the sidebar is no outside click: the band, the stage, the mark and focus stay', async (t) => {
    assert.equal((await app.X('band()')).hidden, true, 'fixture: the band is not closed')
    await recordClicks(app)
    const tree = await app.X(`box('.tree-scroller')`)
    const sidebar = { x: tree.x, y: tree.bottom - 30 }
    assert.equal(await app.ev(`!document.elementFromPoint(${sidebar.x}, ${sidebar.y}).closest('#reader')`), true,
      'fixture: the sidebar point is inside #reader')
    const legs = [
      ['left', 'the book margin', () => offBand(app)],
      ['left', 'a book word', async () => (await app.X(`find('lantern')`)).first],
      ['right', 'the sidebar', async () => sidebar],
    ]
    const seen = []
    const targets = []
    let blocks = null
    for (const [side, where, to] of legs) {
      // Every leg starts from a band holding an answer with keeper staged,
      // so a leg that fails leaves the next one its own verdict.
      if ((await app.X('band()')).hidden) {
        await pick(app, 'lantern')
        await settled(app)
      }
      if (!(await app.ev(STAGED))) await stage(app, 'keeper')
      blocks ??= (await app.X('col(0)')).blocks
      await takeClicks(app)
      const n = ai.explains.length
      // Press on the half, change your mind, slide off, let go.
      await app.drag(await app.X(`box('.ep-explain .ex-place-${side}')`), await to(), 6)
      await sleep(150)
      const clicks = await takeClicks(app)
      targets.push(clicks.map((c) => c.to).join(' '))
      const s = await app.X('slots()')
      const f = await app.X('active()')
      seen.push({
        where, clicks: clicks.map((c) => c.inBand),
        open: !(await app.X('band()')).hidden, staged: !s.place, mode: s.mode, blocks: s.cols[0].blocks,
        mark: await app.X(`hl('cairn-explain-mark')`), focus: { inReader: f.inReader, body: f.body },
        asked: ai.explains.length - n,
      })
    }
    t.diagnostic(`a press on a half released outside the band clicks: ${targets.join(' | ')}`)
    // clicks [false]: one click, aimed outside the band, or the leg proves nothing.
    assert.deepEqual(seen, legs.map(([, where]) => ({
      where, clicks: [false], open: true, staged: true, mode: 'second', blocks,
      mark: 'keeper', focus: { inReader: true, body: false }, asked: 0,
    })), 'a press that began on a staged half and ended outside the band closed it, dropped the stage or lost focus')
    // A click that both presses and releases outside the band still closes it.
    const n = ai.explains.length
    await app.click(await offBand(app))
    await sleep(150)
    assert.deepEqual({
      clicks: (await takeClicks(app)).map((c) => c.inBand), open: !(await app.X('band()')).hidden,
      staged: await app.ev(STAGED), mark: await app.X(`hl('cairn-explain-mark')`), asked: ai.explains.length - n,
    }, { clicks: [false], open: false, staged: false, mark: null, asked: 0 }, 'an outside click after the slide-offs did not close the band')
  })

  test('E109: with nothing staged, a press on the band\'s padding released over the book leaves the band open', async () => {
    await pick(app, 'lantern')
    await settled(app)
    const n = ai.explains.length
    const c0 = await app.X('col(0)')
    // The answer's scroller, left of its 16px padding edge: on no word.
    const pad = { x: c0.scroll.left + 6, y: c0.scroll.y }
    assert.match((await app.X(`hit(${pad.x}, ${pad.y})`)).cls, /\bex-scroll\b/, 'fixture: the point is not the band\'s padding')
    await takeClicks(app)
    await app.drag(pad, await offBand(app), 6)
    await sleep(150)
    const f = await app.X('active()')
    assert.deepEqual({
      clicks: (await takeClicks(app)).map((c) => c.inBand), open: !(await app.X('band()')).hidden,
      blocks: (await app.X('col(0)')).blocks, mark: await app.X(`hl('cairn-explain-mark')`),
      focus: { inReader: f.inReader, body: f.body }, asked: ai.explains.length - n,
    }, {
      clicks: [false], open: true, blocks: c0.blocks, mark: 'lantern', focus: { inReader: true, body: false }, asked: 0,
    }, 'a press on the band released over the book closed it')
  })

  test('E109: a press counts for its own click only: after a right press or a drill-down in the band, a sidebar-grip click closes it; a press in the find field slid off over the book keeps it', async (t) => {
    await recordClicks(app)
    const open = async () => !(await app.X('band()')).hidden
    const fresh = async () => {
      if (!(await open())) {
        await pick(app, 'lantern')
        await settled(app)
      }
    }
    // The grip's handler suppresses the mousedown, so its click is the one a
    // left-over band press would wrongly keep.
    const grip = await app.X(`box('.sidebar-resize')`)
    assert.ok(grip && grip.w > 0 && grip.h > 0, 'fixture: no sidebar grip')
    const gripClick = async () => {
      await takeClicks(app)
      await app.click({ x: grip.x, y: grip.y })
      await sleep(150)
      return { clicks: (await takeClicks(app)).map((c) => c.inBand), open: await open() }
    }
    // A right press on the band's padding is no left click's press.
    await fresh()
    const c0 = await app.X('col(0)')
    await app.click({ x: c0.scroll.left + 6, y: c0.scroll.y }, { button: 'right' })
    await sleep(100)
    assert.equal(await app.ev(`!!document.querySelector('.ctx-menu')`), false, 'fixture: a right click on the band opened a menu')
    assert.equal(await open(), true, 'fixture: a right click closed the band')
    const afterRight = await gripClick()
    // A drill-down: the band swallows its click, so the reader never sees it.
    // A reopened band holds genericAnswer(), whose words include "gloss".
    await fresh()
    const n = ai.explains.length
    const gloss = await app.X(`inBand('.ex-round-block[data-round="0"] .ex-word[data-word="gloss"]')`)
    assert.ok(gloss, 'fixture: no "gloss" word span in the reopened band')
    await app.click(gloss)
    await ai.waitExplains(n + 1)
    await settled(app)
    assert.equal(await open(), true, 'fixture: the drill-down closed the band')
    const afterDrill = await gripClick()
    // A drag-select in the find field released over the book clicks #reader.
    await fresh()
    await app.key('f', 'KeyF', 70, process.platform === 'darwin' ? 4 : 2)
    await app.until('the find bar', `!!document.querySelector('#reader .find-bar') && !document.querySelector('#reader .find-bar').hidden`)
    await takeClicks(app)
    await app.drag(await app.X(`box('#reader .find-input')`), await offBand(app), 6)
    await sleep(150)
    const clicks = await takeClicks(app)
    const slid = {
      clicks: clicks.map((c) => c.inBand), open: await open(),
      find: await app.ev(`!document.querySelector('#reader .find-bar').hidden`),
    }
    t.diagnostic(`a find-field press released over the book clicks: ${clicks.map((c) => c.to).join(' ')}`)
    // Close both, as the steps after expect.
    await app.key('Escape', 'Escape', 27)
    await app.key('Escape', 'Escape', 27)
    assert.deepEqual({ afterRight, afterDrill, slid, closed: !(await open()) }, {
      afterRight: { clicks: [false], open: false },
      afterDrill: { clicks: [false], open: false },
      slid: { clicks: [false], open: true, find: true },
      closed: true,
    }, 'a band press outlived its click, or a find-field press slid off closed the band')
  })

  test('E110: Esc during the held second press of a double-click drops the stage and puts the mark back on the placed word', async () => {
    // After a failed step before it, this step opens its own band.
    if ((await app.X('band()')).hidden) {
      await pick(app, 'lantern')
      await settled(app)
    }
    assert.equal(await app.X(`hl('cairn-explain-mark')`), 'lantern', 'fixture: the band does not show lantern')
    const n = ai.explains.length
    const w = (await app.X(`reveal('keeper', 0, 0.3)`)).first
    await app.click(w, { count: 1 })
    await app.until('"keeper" to be staged', STAGED)
    assert.equal(await app.X(`hl('cairn-explain-mark')`), 'keeper', 'fixture: the first click did not stage keeper')
    // The second press repeats the first: it asks nothing and paints nothing.
    await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: w.x, y: w.y, button: 'left', buttons: 1, clickCount: 2 })
    await app.frames()
    await app.key('Escape', 'Escape', 27)
    const during = { staged: await app.ev(STAGED), mark: await app.X(`hl('cairn-explain-mark')`) }
    await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: w.x, y: w.y, button: 'left', buttons: 0, clickCount: 2 })
    await app.frames()
    await sleep(200)
    assert.deepEqual({
      during, after: { staged: await app.ev(STAGED), mark: await app.X(`hl('cairn-explain-mark')`) },
      open: !(await app.X('band()')).hidden, asked: ai.explains.length - n,
    }, {
      during: { staged: false, mark: 'lantern' }, after: { staged: false, mark: 'lantern' }, open: true, asked: 0,
    }, 'Esc in a double-click\'s second press left the dropped word marked')
  })

  test('E110: a pick re-staged by a book drag released over the left half keeps its preview under the still pointer, and a click places the newer pick', async () => {
    try {
      await restageUnderStillPointer()
    } finally {
      // The steps after start from a closed band, pass or fail: Esc drops a
      // stage, the next one closes.
      for (let i = 0; i < 2 && !(await app.X('band()')).hidden; i++) await app.key('Escape', 'Escape', 27)
    }
    assert.equal((await app.X('band()')).hidden, true, 'fixture: Esc did not close the band for the steps after')
  })

  async function restageUnderStillPointer() {
    await stage(app, 'keeper')
    const n = ai.explains.length
    const at = (await app.X(`reveal('evening', 0, 0.3)`)).first
    const row = (await app.X('slots()')).box
    const over = { x: row.left + row.w / 4, y: row.y }
    // The overlay is already up: the drag enters the left half on its way.
    await app.gesture([at, { x: at.x, y: at.y + 20 }, over])
    const still = (await app.X('slots()')).classes
    await sleep(200)
    const s = await app.X('slots()')
    assert.deepEqual({
      staged: !s.place, mode: s.mode, inert: s.cols.map((c) => c.inert), mark: await app.X(`hl('cairn-explain-mark')`),
      asked: ai.explains.length - n, still, later: s.classes,
    }, {
      staged: true, mode: 'second', inert: [true, true], mark: 'evening', asked: 0, still: ['place-left'], later: ['place-left'],
    }, 'a re-stage under a still pointer lost the preview of the half under it')
    await app.move({ x: over.x + 4, y: over.y })
    assert.deepEqual((await app.X('slots()')).classes, ['place-left'], 'a move inside the half did not keep the preview')
    await app.click({ x: over.x + 4, y: over.y })
    const req = await ai.waitExplains(n + 1)
    await settled(app)
    await sleep(150)
    const p = await app.X('slots()')
    assert.deepEqual({
      items: req.body.items, asked: ai.explains.length - n, place: p.place, layout: p.layout,
      left: p.cols[0].text.includes('evening'), mark: await app.X(`hl('cairn-explain-mark')`),
    }, {
      items: [{ phrase: 'evening', words: ['evening'] }], asked: 1, place: true, layout: 'single', left: true, mark: 'evening',
    }, 'the click did not place the newer pick, once, over the whole panel')
  }

  test('a drag from a word picks a phrase of at most 8 words', async () => {
    const one = await app.X(`reveal('One two', 0, 0.3)`)
    const twelve = await app.X(`find('twelve')`)
    assert.equal(Math.round(one.first.top), Math.round(twelve.first.top), 'fixture: the long line wrapped')
    const before = ai.explains.length
    await app.drag({ x: one.first.left + 6, y: one.first.y }, twelve.first)
    const r = await ai.waitExplains(before + 1)
    const eight = ['One', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight']
    assert.deepEqual({ items: r.body.items, mark: await app.X(`hl('cairn-explain-mark')`) },
      { items: [{ phrase: eight.join(' '), words: eight }], mark: eight.join(' ') }, 'the drag was not clamped to 8 words')
    await settled(app)
    assert.deepEqual((await app.X('band()')).rowWords, eight, 'the pron-only row is not one row per picked word')
    await app.until('the row badges to settle', `window.__EXP__.band().loading === 0`)
    assert.ok((await app.X('band()')).text.includes('no pron'), 'a 404 with no ipa is not "no pron"')
  })

  test('a word split across two inline elements is one word', async () => {
    await settled(app)
    // The half whose parent is the <em>, not the block.  The band holds the
    // phrase's answer: placed over the whole panel.
    const r = await pick(app, 'dle', 0, 0.3, 'left')
    assert.deepEqual(r.body.items, [{ phrase: 'needle', words: ['needle'] }], 'nee<em>dle</em> was not one word')
    await settled(app)
  })

  test('a footnote marker is neither part of the picked word nor of the passage', async () => {
    const r = await pick(app, 'mast', 0, 0.3, 'left')
    assert.deepEqual(r.body.items, [{ phrase: 'mast', words: ['mast'] }], 'the footnote marker glued onto the word')
    assert.ok(r.body.text.includes('The gulls circled the mast and cried.'),
      'the footnote digits leaked into the passage: ' + JSON.stringify(r.body.text.slice(0, 400)))
    await settled(app)
  })

  test('a press on the book\'s scrollbar leaves the band open', async () => {
    const sc = await app.X('scroller()')
    await app.click({ x: sc.right - 5, y: sc.top + 120 })
    await app.frames()
    assert.equal((await app.X('band()')).hidden, false, 'a press on the book\'s scrollbar closed the band')
    assert.notEqual((await app.X('scroller()')).scrollTop, sc.scrollTop, 'fixture: the press missed the scrollbar')
  })

  test('clicks inside the band (a row word, the grip) leave it open and ask nothing', async () => {
    const n = ai.explains.length
    await app.click(await app.X(`inBand('.ex-pron-only-row > strong')`))
    await app.click(await app.X(`box('.ep-explain .ex-grip')`))
    await sleep(200)
    assert.equal(ai.explains.length, n, 'a click on the row word asked something')
    assert.equal((await app.X('band()')).hidden, false, 'a click inside the band closed it')
  })

  test('a click on a blank spot of the book is no pick and closes the band, its mark and its scroller', async () => {
    const n = ai.explains.length
    // Past the end of the heading's line, inside .ep-content: the caret snaps
    // to "Harbour", but the point is on no word.
    const at = (await app.X(`reveal('The Harbour', 0, 0.3)`)).first
    await app.click({ x: at.right + 150, y: at.y })
    await sleep(200)
    assert.equal(ai.explains.length, n, 'a margin click was a pick')
    assert.equal((await app.X('band()')).hidden, true, 'a click in the book\'s margin did not close the band')
    assert.equal(await app.X(`hl('cairn-explain-mark')`), null, 'the mark outlived the band')
    assert.deepEqual(await app.X('scrollers()'), ['ep-scroller', 'tree-scroller'], 'the closed band still renders a scroller')
  })

  test('the marked word is scrolled clear of the band when the band would cover it', async () => {
    const at = await app.X(`reveal('bell', 0, 0.85)`)
    const sc0 = await app.X('scroller()')
    assert.ok(at.first.bottom > sc0.visibleBottom - 320, 'fixture: the word is not where the band will be')
    const before = ai.explains.length
    await app.click(at.first)
    await ai.waitExplains(before + 1)
    await app.until('the band to show', `!window.__EXP__.band().hidden`)
    await app.frames()
    await app.frames()
    const sc = await app.X('scroller()')
    const word = (await app.X(`find('bell')`)).first
    assert.ok(sc.scrollTop > sc0.scrollTop, 'the book did not scroll to reveal the word')
    assert.ok(word.bottom <= sc.visibleBottom - 11, `the word (bottom ${word.bottom}) is still under the band (book ends ${sc.visibleBottom})`)
    assert.ok(word.bottom >= sc.visibleBottom - 40, `the reveal scrolled further than the overlap (word bottom ${word.bottom}, book ends ${sc.visibleBottom})`)
    await settled(app)
  })

  test('Esc closes the find bar first, then the band', async () => {
    await app.key('f', 'KeyF', 70, process.platform === 'darwin' ? 4 : 2)
    await app.until('the find bar', `!!document.querySelector('#reader .find-bar') && !document.querySelector('#reader .find-bar').hidden`)
    // The find bar is comart's browser find: clicking it is no outside click.
    await app.click(await app.X(`box('#reader .find-input')`))
    await app.click(await app.X(`box('#reader .find-btn')`))
    assert.equal((await app.X('band()')).hidden, false, 'a click on the find bar closed the band')
    await app.key('Escape', 'Escape', 27)
    assert.equal(await app.ev(`document.querySelector('#reader .find-bar').hidden`), true, 'fixture: Esc did not close the find bar')
    assert.equal((await app.X('band()')).hidden, false, 'one Esc closed the find bar AND the band')
    await app.key('Escape', 'Escape', 27)
    assert.equal((await app.X('band()')).hidden, true, 'the second Esc did not close the band')
  })

  test('hovering a link in the book lights no word', async () => {
    for (const text of ['harbour notes', 'the archive', '1']) {
      const at = text === '1' ? null : await app.X(`reveal(${JSON.stringify(text)}, 0, 0.3)`)
      if (text === '1') await app.X(`reveal('mast', 0, 0.3)`)
      await app.move(at ? at.first : await app.X(`box('a.ep-noteref')`))
      assert.deepEqual({
        hover: await app.X(`hl('cairn-explain-hover')`),
        over: await app.ev(`document.querySelector('.ep-content').classList.contains('ex-over-word')`),
      }, { hover: null, over: false }, `hovering link "${text}" lit a word`)
    }
  })

  test('code is not prose: its words never light up and are never picked', async () => {
    const n = ai.explains.length
    for (const text of ['tidegauge', 'Enter']) {
      const at = (await app.X(`reveal(${JSON.stringify(text)}, 0, 0.3)`)).first
      await app.move(at)
      await app.frames()
      assert.deepEqual({
        hover: await app.X(`hl('cairn-explain-hover')`),
        over: await app.ev(`document.querySelector('.ep-content').classList.contains('ex-over-word')`),
      }, { hover: null, over: false }, `hovering "${text}" lit a word`)
      await app.click(at)
      await sleep(200)
      assert.equal(ai.explains.length, n, `a click on "${text}" asked ai-service`)
      assert.equal(await app.X(`hl('cairn-explain-mark')`), null)
    }
    // The prose around it still picks.
    const at = (await app.X(`reveal('Type', 0, 0.3)`)).first
    await app.move(at)
    await app.frames()
    assert.equal(await app.X(`hl('cairn-explain-hover')`), 'Type', 'fixture: the prose beside the code does not pick')
  })

  test('a chapter link and a footnote marker navigate, and neither is picked', async () => {
    const n = ai.explains.length
    const link = await app.X(`reveal('harbour notes', 0, 0.3)`)
    await app.click(link.first)
    await app.frames()
    const heading = (await app.X(`find('Harbour Notes')`)).first
    const sc = await app.X('scroller()')
    await app.X(`reveal('mast', 0, 0.3)`)
    await app.click(await app.X(`box('a.ep-noteref')`))
    await app.frames()
    const note = (await app.X(`find('A mast is a tall pole')`)).first
    const sc2 = await app.X('scroller()')
    assert.deepEqual({
      chapter: Math.abs(heading.top - sc.top) < 120,
      footnote: note.top >= sc2.top - 2 && note.bottom <= sc2.visibleBottom,
      asked: ai.explains.length - n,
      band: (await app.X('band()')).hidden,
    }, { chapter: true, footnote: true, asked: 0, band: true }, 'a link did not act as a link, or was picked')
  })

  test('a double-click on a closed band asks once, selects nothing, never stages, and leaves the band open', async () => {
    assert.equal((await app.X('band()')).hidden, true, 'fixture: the band is not closed')
    const n = ai.explains.length
    const w = await app.X(`reveal('quay', 0, 0.3)`)
    await app.click(w.first, { count: 1 })
    await app.click(w.first, { count: 2 })
    await ai.waitExplains(n + 1)
    await sleep(400)
    assert.equal(ai.explains.length, n + 1, 'a double-click sent two requests')
    assert.equal(await app.ev('getSelection().toString()'), '', 'a double-click selected the word')
    assert.equal((await app.X('band()')).hidden, false, 'the second click of the double-click closed the band')
    // Its second press repeats the first: it must not stage the same word
    // over the answer the first press just started.
    assert.deepEqual({ staged: await app.ev(STAGED), mode: (await app.X('slots()')).mode },
      { staged: false, mode: null }, 'the double-click\'s second press staged the word over its own answer')
    await settled(app)
  })

  test('Esc still closes the band after a mouse click plays a badge', async () => {
    await pick(app, 'lantern', 0, 0.3, 'left')
    await settled(app)
    const sel = '.ex-round .pron-badge[data-mp3$="/audio/lantern.wav"]'
    await app.until('a real lantern badge', `!!document.querySelector(${JSON.stringify(sel)})`)
    await app.click(await app.X(`inBand(${JSON.stringify(sel)})`))
    assert.equal(await app.ev(`!!document.activeElement && document.activeElement.classList.contains('ep-explain')`), true,
      'a badge click left focus outside the band: ' + await app.ev('document.activeElement && document.activeElement.className'))
    await app.key('Escape', 'Escape', 27)
    assert.equal((await app.X('band()')).hidden, true, 'Esc after a badge click did not close the band')
  })

  test('a server error event leaves its message under the partial answer', async () => {
    const msg = 'OpenRouter is unreachable (dial tcp: refused).'
    ai.next({ events: [{ event: 'chunk', data: { text: 'A partial answer about **evening**' } }, { event: 'error', data: { message: msg } }, { event: 'done', data: {} }] })
    await pick(app, 'evening')
    await settled(app)
    const b = await app.X('band()')
    assert.equal(b.err, msg, 'the server\'s error message is not the error line')
    assert.ok((b.blocks[0]?.text ?? '').includes('A partial answer about evening'), 'the partial answer was dropped')
  })

  test('a stream that ends without done is flagged as cut off', async () => {
    ai.next({ events: [{ event: 'chunk', data: { text: 'Half an answer about **tide**' } }, { end: true }] })
    await pick(app, 'tide', 0, 0.3, 'left')
    await settled(app)
    const b = await app.X('band()')
    assert.equal(b.err, CUT_OFF, 'a stream that ended without done is not flagged as cut off')
    assert.ok((b.blocks[0]?.text ?? '').includes('Half an answer about tide'), 'the partial answer was dropped')
  })

  test('an HTTP error is one line carrying ai-service\'s own error, and no empty round', async () => {
    ai.next({ status: 500, json: { error: 'Provider exploded.' } })
    await pick(app, 'turned', 0, 0.3, 'left')
    await app.until('the error line', `window.__EXP__.band().err !== null && !window.__EXP__.band().thinking`)
    const b = await app.X('band()')
    assert.equal(b.err, 'ai-service answered HTTP 500: Provider exploded.', 'the HTTP error line does not carry ai-service\'s error')
    assert.equal(b.blocks.length, 0, 'an HTTP error committed an empty round')
  })

  test('the top edge drags the band taller, ArrowUp grows it, and the height reaches state.json', async () => {
    // A band holding only an error line still holds something: staged.
    await pick(app, 'evening', 0, 0.3, 'left')
    await settled(app)
    const g = await app.X(`box('.ep-explain .ex-grip')`)
    assert.ok(g && g.h >= 4 && Math.abs(g.top - (await app.X('band()')).top) <= 2, 'no grip on the band\'s top edge')
    assert.equal(await app.ev(`getComputedStyle(document.querySelector('.ep-explain .ex-grip')).cursor`), 'row-resize',
      'the grip lost its resize cursor')
    await app.drag({ x: g.x, y: g.y }, { x: g.x, y: g.y - 80 })
    let b = await app.X('band()')
    assert.deepEqual({ h: b.h, hidden: b.hidden }, { h: 400, hidden: false }, 'an 80px drag up did not leave a 400px band open')
    await app.ev(`document.querySelector('.ep-explain .ex-grip').focus()`)
    await app.key('ArrowUp', 'ArrowUp', 38)
    b = await app.X('band()')
    assert.equal(b.h, 424, 'ArrowUp on the grip did not add 24px')
    const t0 = Date.now()
    while (readState()?.explain_h !== 424 && Date.now() - t0 < 4000) await sleep(100)
    assert.equal(readState()?.explain_h, 424, 'state.json never got explain_h 424: ' + JSON.stringify(readState()?.explain_h))
  })

  test('switching to the Memoir tab closes the band, and the book comes back without it', async () => {
    assert.equal((await app.X('band()')).hidden, false)
    // By keyboard: a click on the tab would close the band as an outside
    // click before the reader is ever hidden.
    const mod = process.platform === 'darwin' ? 4 : 2
    await app.key('2', 'Digit2', 50, mod)
    await app.until('the memoir page', `!document.getElementById('memoir').hidden`)
    assert.equal((await app.X('band()')).hidden, true, 'the band survived a switch to Memoir')
    await app.key('1', 'Digit1', 49, mod)
    await app.until('the book again', `!document.getElementById('reader').hidden`)
    await app.frames()
    const b = await app.X('band()')
    assert.deepEqual({ hidden: b.hidden, blocks: b.blocks.length, mark: await app.X(`hl('cairn-explain-mark')`) },
      { hidden: true, blocks: 0, mark: null }, 'the book came back with the old thread')
  })

  test('the page threw nothing and asked the fake ai-service for nothing unexpected', () => {
    assert.deepEqual(app.exceptions, [], 'the page threw')
    assert.deepEqual(ai.stray, [], 'unexpected requests')
  })
})

describe('E109 relaunch + the shell navigation guard', { skip: SKIP }, () => {
  test('a relaunch opens the band at the saved height', async () => {
    assert.ok(app, 'the first session never ran')
    await app.close()
    app2 = await launch({ vault, state, base: ai.base })
    assert.equal(await app2.ev('window.__CAIRN_EXPLAIN_H__'), 424, 'the saved height did not reach the page')
    await pick(app2, 'lantern')
    await app2.until('the band to show', `!window.__EXP__.band().hidden`)
    await app2.frames()
    assert.equal((await app2.X('band()')).h, 424, 'the band did not open at the saved height')
    await settled(app2)
  })

  test('a refused CAIRN_AI_BASE fails closed: the band reaches nothing, never the real :8770', async () => {
    await setup()
    await app?.close()
    await app2?.close()
    app2 = null
    const n = ai.explains.length
    const a = await launch({ vault, state: join(work, 'state-refused'), base: 'http://0.0.0.0:8770', expect: 'http://127.0.0.1:9' })
    try {
      const at = await a.X(`reveal('lantern', 0, 0.3)`)
      await a.click(at.first)
      await a.until('the error line', `!!document.querySelector('.ep-explain .ex-err')`)
      assert.equal(await a.ev(`document.querySelector('.ep-explain .ex-err').textContent`),
        "Can't reach ai-service. It isn't answering on 127.0.0.1:9.")
      assert.equal(ai.explains.length, n)
    } finally {
      await a.close()
    }
  })

  test('nothing navigates the app window or opens another one', async () => {
    if (!app2) {
      // Run on its own (--test-name-pattern): a fresh app on the same book.
      await setup()
      await app?.close()
      app2 = await launch({ vault, state: join(work, 'state-nav'), base: ai.base })
    }
    await app2.ev('(window.__alive = 1)')
    const url0 = await app2.ev('location.href')
    const esc = (k) => `${ai.base}/escape-${k}`
    const archive = await app2.X(`reveal('the archive', 0, 0.3)`)
    const through = []
    const leg = async (name, fn) => {
      const n = ai.stray.length
      await fn().catch((e) => through.push(`${name}: ${e.message.slice(0, 120)}`))
      await sleep(500)
      if (ai.stray.length > n) through.push(`${name} -> ${ai.stray.slice(n).join(', ')}`)
    }
    const anchor = (href, target) => app2.ev(`(() => { const a = document.createElement('a'); a.href = ${JSON.stringify(href)};` +
      (target ? ` a.target = ${JSON.stringify(target)};` : '') + ` document.body.append(a); a.click(); a.remove(); return 1 })()`)
    // New-window escapes first: they leave this page where it is.
    // A middle click on a book link (the reader handles `click`, not `auxclick`).
    await leg('middle-click', () => app2.click(archive.first, { button: 'middle' }))
    await leg('target=_blank', () => anchor(esc('blank'), '_blank'))
    let refused = 'not run'
    await leg('window.open', async () => { refused = await app2.ev(`window.open(${JSON.stringify(esc('open'))}) === null`) })
    // Then the ones that would replace it.  A link dropped on the book: no
    // page handler takes the drop.
    const drop = { x: archive.first.x, y: archive.first.y + 60 }
    const data = { items: [{ mimeType: 'text/uri-list', data: esc('drop') }, { mimeType: 'text/plain', data: esc('drop') }], dragOperationsMask: 1 | 2 | 16 }
    await leg('drop', async () => {
      for (const type of ['dragEnter', 'dragOver', 'drop']) await app2.send('Input.dispatchDragEvent', { type, x: drop.x, y: drop.y, data })
    })
    // A link outside every handler, clicked by script: nothing prevents it.
    await leg('link click', () => anchor(esc('link')))
    await leg('location.href', () => app2.ev(`(location.href = ${JSON.stringify(esc('assign'))}, 1)`))
    assert.deepEqual({
      through,
      windowOpenRefused: refused,
      samePage: (await app2.ev('window.__alive ?? null')) === 1 && (await app2.ev('location.href')) === url0,
      pageTargets: (await app2.pages()).length,
    }, { through: [], windowOpenRefused: true, samePage: true, pageTargets: 1 }, 'escaped the guard: ' + JSON.stringify(through))
  })

  test('a browser-side reload still reloads the app (the guard only stops the page navigating itself)', async () => {
    await app2.send('Page.reload')
    await app2.until('the reloaded book', `!window.__alive && !!document.querySelector('.ep-content .ep-chapter')`, 20_000)
    assert.deepEqual(ai.stray, [])
  })
})

/* E110 ruling W: the answer fills the band.  At the main session's 1200x800
 * the pane is narrower than the old 792px line cap, so nothing there could
 * see the cap go; this launch is wide enough for it to bind. */
describe('E110 the answer fills its width, real engine at 1700x900 (fake ai-service)', { skip: SKIP }, () => {
  /** One paragraph of short words: a line ends within a word of its box. */
  const WIDE = 'The keeper lit a lamp and the gulls cried. '.repeat(40).trim()

  /** Each side of a half: the gap from its scroller's edge (inside the
   *  stable gutter on the right) to the answer's box, and where the answer's
   *  text starts and ends in that box.  To 0.1px: layout is in 1/64 px. */
  const fit = (c) => ({
    sides: [c.content.left - c.scroll.left, c.scroll.right - c.gutter - c.content.right].map((x) => Math.round(x * 10) / 10),
    textLeft: Math.abs(c.para.left - c.content.left) < 0.5,
    textReach: c.content.right - c.para.right < 60,
    lines: c.para.lines > 2,
  })
  const FIT = { sides: [16, 16], textLeft: true, textReach: true, lines: true }

  test('one panel: the answer spans the band minus 16px a side, past where the old 792px line stopped', async (t) => {
    await setup()
    wide = await launch({ vault, state: join(work, 'state-wide'), base: ai.base, geom: '1700x900' })
    t.diagnostic(`dpr ${await wide.ev('devicePixelRatio')}, viewport ${await wide.ev('innerWidth + "x" + innerHeight')} CSS px`)
    ai.next({ events: [...pieces(WIDE, 4), { event: 'done', data: {} }] })
    await pick(wide, 'lantern')
    await settled(wide)
    const c = await wide.X('col(0)')
    const band = await wide.X(`box('.ep-explain')`)
    const reader = await wide.X(`box('#reader')`)
    assert.ok(c.scroll.w - c.gutter - 32 > 792 + 100, `fixture: the band (${c.scroll.w}px) is too narrow for the old 792px cap to bind`)
    assert.ok(Math.abs(band.w - reader.w) < 0.5, `the band is not the reader's width (${band.w} of ${reader.w})`)
    assert.deepEqual({ ...fit(c), pastOldCap: c.para.right - c.content.left > 792 },
      { ...FIT, pastOldCap: true },
      `the answer does not fill the band: content ${JSON.stringify(c.content)}, scroller ${JSON.stringify(c.scroll)} (gutter ${c.gutter}), text ${JSON.stringify(c.para)}`)
  })

  test('split: each half\'s answer spans its own half minus 16px a side', async () => {
    await stage(wide, 'keeper')
    const n = ai.explains.length
    ai.next({ events: [...pieces(WIDE, 4), { event: 'done', data: {} }] })
    await wide.click(await wide.X(`box('.ep-explain .ex-place-right')`))
    await ai.waitExplains(n + 1)
    await settled(wide)
    const s = await wide.X('slots()')
    const [l, r] = s.cols
    assert.equal(s.layout, 'split', 'fixture: the right click did not split')
    assert.deepEqual({ left: fit(l), right: fit(r) }, { left: FIT, right: FIT },
      `a half's answer does not fill the half: left ${JSON.stringify([l.scroll, l.content, l.para])}, right ${JSON.stringify([r.scroll, r.content, r.para])}`)
    // Both columns are flex 1 1 0, the right one's border inside its own
    // box: the two answers get the same width.
    assert.ok(Math.abs(l.content.w - r.content.w) < 0.5 && Math.abs(l.box.right - r.box.left) < 0.5,
      `the halves are not two equal columns side by side: ${l.content.w} / ${r.content.w}, ${l.box.right} | ${r.box.left}`)
  })

  test('the wide page threw nothing and asked for nothing unexpected', () => {
    assert.deepEqual(wide?.exceptions ?? null, [], 'the page threw')
    assert.deepEqual(ai.stray, [], 'unexpected requests')
  })
})

/* THE LIVE LEG (gated: it bills one real `/api/explain` through ai-service, so
 * it runs only with CAIRN_EXPLAIN_LIVE=1, against whatever ai-service answers
 * on 127.0.0.1:8770).  What it proves end to end: a real model answer streams
 * into the band and its badges settle against real Merriam-Webster data. */
describe('E109 live ai-service (one billed request)', {
  skip: SKIP || (LIVE ? false : 'live /api/explain not requested (CAIRN_EXPLAIN_LIVE=1 to run it)'),
}, () => {
  test('one real word click gets a real answer with settled badges', async () => {
    await setup()
    await app?.close()
    await app2?.close()
    app3 = await launch({ vault, state: join(work, 'state-live'), base: null })
    assert.equal(await app3.ev('window.__CAIRN_AI_BASE__ ?? null'), null)
    const at = await app3.X(`reveal('lantern', 0, 0.3)`)
    await app3.click(at.first)
    await app3.until('the band to show', `!window.__EXP__.band().hidden`)
    await app3.until('the real answer', `(() => { const b = window.__EXP__.band(); return b.err !== null || (b.live === null && !b.thinking && b.blocks.length > 0) })()`, 180_000)
    const b = await app3.X('band()')
    assert.equal(b.err, null, 'ai-service answered with an error: ' + b.err)
    assert.ok(b.blocks[0].text.toLowerCase().includes('lantern'), 'the answer does not mention the word')
    assert.ok(!/\[\[|\]\]/.test(b.text), 'tag syntax leaked into the answer')
    await app3.until('the badges to settle', `window.__EXP__.band().loading === 0`, 60_000)
    const real = (await app3.X('band()')).badges.filter((x) => x.cls.startsWith('pron-badge') && x.mp3)
    assert.ok(real.length > 0, 'no real MW badge in the live answer')
  })
})
