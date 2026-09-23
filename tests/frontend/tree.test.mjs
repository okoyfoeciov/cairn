// Owner: 04.  A NEW file — CONTRACT §6.4's table row `tests/frontend/*.test.mjs`
// names owner 03, and owner 05's search.test.mjs already established the
// convention that each owner adds its OWN uniquely-named file rather than
// editing anyone else's.  REPORTED as an addition, not an edit.  Run with
// `node --test tests/frontend/`.
//
// Spec: CONTRACT.md §3.2 (TreeBlob v1 — the layout and the validation),
// §3.3 (the row pool is `ceil(clientHeight / --row-h) + 2·OVERSCAN + 1`,
// OVERSCAN = 8 — errata 2 / Y5, 50 rows at 881px), §3.4 (expansion is
// FRONTEND-owned and PATH-KEYED), §3.5 (full rebuild, always, no deltas),
// §5.2 (the box model: 27px pitch, 17px indent step), §5.12.6 (the scroll
// handler's obligations), §7.6 (state.json, debounced 1,000 ms, cap 2,000),
// M61 (an empty folder draws no chevron).
//
// `src/tree.ts` and `src/treeblob.ts` are TypeScript and esbuild is the
// project's only transpiler (§6.3), so this file bundles them to ESM in a temp
// dir and imports that: the code under test is the shipped code.
//
// THE DOM SHIM IS DELIBERATELY LOCAL TO THIS FILE, not `./_minidom.mjs`.  That
// helper is owner 05's and supports what `search.ts` touches; the tree needs
// `el.style.setProperty`, a live `clientHeight`, `getComputedStyle` on a
// non-root element and `removeEventListener`, none of which it has.  Extending
// it would be an edit to another owner's file (§6.4).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const SRC = join(HERE, '..', '..', 'src')

const out = mkdtempSync(join(tmpdir(), 'cairn-tree-'))
// ONE bundle, not two: `tree.ts` imports `treeblob.ts`, and bundling them
// separately would give the tree its own private copy of `TreeBlob` — the
// decoder these tests exercise would then not be the decoder the tree uses.
const entry = join(out, 'entry.ts')
writeFileSync(
  entry,
  `export * as T from ${JSON.stringify(join(SRC, 'tree.ts'))}\n` +
    `export * as B from ${JSON.stringify(join(SRC, 'treeblob.ts'))}\n` +
    `export * as I from ${JSON.stringify(join(SRC, 'inline-edit.ts'))}\n`
)
await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2021',
  outfile: join(out, 'entry.mjs'),
  logLevel: 'silent',
})
const { T, B, I } = await import(join(out, 'entry.mjs'))
process.on('exit', () => {
  try {
    rmSync(out, { recursive: true, force: true })
  } catch {}
})

/* ══ the DOM shim ═══════════════════════════════════════════════════════════
 * Exactly what src/tree.ts touches.  Anything it does not touch is absent, so
 * a test cannot silently start depending on browser behaviour invented here. */

class Style {
  constructor() {
    this.transform = ''
    this.height = ''
    this.props = new Map()
  }
  setProperty(k, v) {
    this.props.set(k, String(v))
  }
  getPropertyValue(k) {
    return this.props.get(k) ?? ''
  }
}

/** §0.50 E98: the ONE thing tree.ts asks of a text node — `.data`. */
class TextNode {
  constructor(doc, data) { this.ownerDocument = doc; this.parentNode = null; this.data = String(data); this.childNodes = [] }
  get textContent() { return this.data }
  remove() {
    const p = this.parentNode
    if (!p) return
    const i = p.childNodes.indexOf(this)
    if (i >= 0) p.childNodes.splice(i, 1)
    this.parentNode = null
  }
}

class El {
  constructor(doc, tag) {
    this.ownerDocument = doc
    this.tagName = tag.toUpperCase()
    this.className = ''
    this.attrs = new Map()
    this.childNodes = []
    this.parentNode = null
    this.style = new Style()
    this.listeners = new Map()
    this.text = ''
    // Settable by the test; this is the ONE value §3.3 sizes the pool from.
    this.clientHeight = 0
    this.scrollTop = 0
  }
  get hidden() {
    return this.attrs.has('hidden')
  }
  set hidden(v) {
    if (v) this.attrs.set('hidden', '')
    else this.attrs.delete('hidden')
  }
  get textContent() {
    // §0.50 E98: a row's label is a child TEXT NODE now (the chevron sits before
    // it), so textContent reads through the children the way the browser does.
    return this.text + this.childNodes.map((c) => (c instanceof TextNode ? c.data : '')).join('')
  }
  set textContent(v) {
    this.text = String(v)
  }
  setAttribute(k, v) {
    this.attrs.set(k, String(v))
  }
  getAttribute(k) {
    return this.attrs.get(k) ?? null
  }
  removeAttribute(k) {
    this.attrs.delete(k)
  }
  appendChild(kid) {
    kid.remove()
    kid.parentNode = this
    this.childNodes.push(kid)
    return kid
  }
  // icons.ts's chevron uses Element.append (standard DOM; the other shim in
  // this suite implements that name).
  append(...kids) {
    for (const k of kids) this.appendChild(k)
  }
  remove() {
    const p = this.parentNode
    if (!p) return
    const i = p.childNodes.indexOf(this)
    if (i >= 0) p.childNodes.splice(i, 1)
    this.parentNode = null
  }
  get classes() {
    return new Set(String(this.className).split(/\s+/).filter(Boolean))
  }
  /* ── what src/inline-edit.ts touches, and NOTHING it does not.  The field is
   *    a real <input> in the app; here it is exactly the six members
   *    attachNameEditor() reads, so a test cannot start depending on browser
   *    behaviour invented in this shim. ─────────────────────────────────── */
  get classList() {
    const self = this
    return {
      add(...cs) {
        const have = self.classes
        for (const c of cs) have.add(c)
        self.className = [...have].join(' ')
      },
      remove(...cs) {
        const have = self.classes
        for (const c of cs) have.delete(c)
        self.className = [...have].join(' ')
      },
      contains: (c) => self.classes.has(c),
    }
  }
  focus() {
    this.focused = true
  }
  setSelectionRange(a, b) {
    this.selectionStart = a
    this.selectionEnd = b
  }
  setRangeText(text, start, end) {
    const v = String(this.value ?? '')
    this.value = v.slice(0, start) + text + v.slice(end)
    this.selectionStart = this.selectionEnd = start + text.length
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
  }
  get offsetWidth() {
    return 0
  }
  get offsetHeight() {
    return 0
  }
  matches(sel) {
    // `.a`, `.a.b` only — the tree selects with `.tr` and `.sz`.
    const want = sel.split('.').filter(Boolean)
    const have = this.classes
    return want.every((c) => have.has(c))
  }
  closest(sel) {
    let n = this
    while (n instanceof El) {
      if (n.matches(sel)) return n
      n = n.parentNode
    }
    return null
  }
  querySelector(sel) {
    const stack = [...this.childNodes]
    while (stack.length) {
      const n = stack.shift()
      if (n.matches(sel)) return n
      stack.push(...n.childNodes)
    }
    return null
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type).push(fn)
  }
  removeEventListener(type, fn) {
    const a = this.listeners.get(type)
    if (!a) return
    const i = a.indexOf(fn)
    if (i >= 0) a.splice(i, 1)
  }
  dispatch(type, ev) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(ev)
  }
  listenerCount(type) {
    return (this.listeners.get(type) ?? []).length
  }
}

class Doc {
  constructor() {
    this.body = new El(this, 'body')
  }
  // §0.50 E98: tree.ts builds the row chevron with createElementNS; this shim is namespace-blind.
  createElementNS(_ns, tag) { return this.createElement(tag) }
  createTextNode(t) { return new TextNode(this, t) }
  createElement(tag) {
    const el = new El(this, tag)
    if (tag === 'input') {
      el.value = ''
      el.selectionStart = 0
      el.selectionEnd = 0
      el.focused = false
    }
    return el
  }
}

const doc = new Doc()
globalThis.document = doc
globalThis.Element = El
// inline-edit.ts positions its message element against the viewport and
// re-positions it on resize.  Neither is what these tests assert, but both must
// exist or `attachNameEditor` throws on the first `setMessage`.
globalThis.window = {
  innerWidth: 1918,
  innerHeight: 958,
  addEventListener() {},
  removeEventListener() {},
}
// tokens.css declares --row-h: 27px; the shim stands in for it (§5.1: tokens.css
// is the one file allowed to declare it, so a fixture MAY state its value).
globalThis.getComputedStyle = () => ({ getPropertyValue: (k) => (k === '--row-h' ? '27px' : '') })
// ResizeObserver is deliberately NOT defined: tree.ts guards on
// `typeof ResizeObserver === 'function'`, and leaving it absent means every
// re-measure in this file is an explicit `measure()` call the test can see.

function key(k, extra = {}) {
  let prevented = false
  return {
    key: k,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    preventDefault() {
      prevented = true
    },
    get defaultPrevented() {
      return prevented
    },
    ...extra,
  }
}

/* ══ the encoder — CONTRACT §3.2's layout, mirroring core/src/tree.rs's
 *    `encode_blob` byte for byte (header 32 B, then subtree u32·N, parent i32·N,
 *    name_off u32·(N+1), depth u8·N, kind u8·N, names).  Written independently
 *    of the decoder so the two can disagree. ══════════════════════════════ */

const ENC = new TextEncoder()

/** `spec` is a preorder list of `{ name, dir, kids }`.  `name` is the DISPLAY
 *  name — Rust has already stripped a file's trailing `.md` (§3.2). */
function buildBlob(spec, opts = {}) {
  const names = []
  const parent = []
  const depth = []
  const kind = []
  const subtree = []

  const walk = (nodes, parentIx, d) => {
    for (const nd of nodes) {
      const me = names.length
      names.push(nd.name)
      parent.push(parentIx)
      depth.push(d)
      kind.push(nd.dir ? 1 : 0)
      subtree.push(0)
      walk(nd.kids ?? [], me, d + 1)
    }
  }
  walk(spec, -1, 0)

  const n = names.length
  // One reverse sweep: a child always has a higher index than its parent.
  for (let i = n - 1; i >= 0; i--) {
    const p = parent[i]
    if (p >= 0) subtree[p] += subtree[i] + 1
  }

  const nameBytes = names.map((s) => ENC.encode(s))
  const nameOff = [0]
  for (const b of nameBytes) nameOff.push(nameOff[nameOff.length - 1] + b.length)
  const m = nameOff[n]

  const buf = new ArrayBuffer(36 + 14 * n + m)
  const dv = new DataView(buf)
  dv.setUint32(0, opts.magic ?? 0x3142544e, true)
  dv.setUint32(4, opts.version ?? 1, true)
  dv.setUint32(8, n, true)
  dv.setUint32(12, m, true)
  dv.setUint32(16, opts.sort ?? 0, true)
  dv.setUint32(20, opts.flags ?? 0, true)
  dv.setBigUint64(24, BigInt(opts.epoch ?? 1), true)

  let o = 32
  for (let i = 0; i < n; i++, o += 4) dv.setUint32(o, subtree[i], true)
  for (let i = 0; i < n; i++, o += 4) dv.setInt32(o, parent[i], true)
  for (let i = 0; i <= n; i++, o += 4) dv.setUint32(o, nameOff[i], true)
  for (let i = 0; i < n; i++, o += 1) dv.setUint8(o, depth[i])
  for (let i = 0; i < n; i++, o += 1) dv.setUint8(o, kind[i])
  const u8 = new Uint8Array(buf)
  for (let i = 0; i < n; i++) u8.set(nameBytes[i], o + nameOff[i])
  return buf
}

const dir = (name, kids = []) => ({ name, dir: true, kids })
const file = (name) => ({ name, dir: false, kids: [] })

/** A flat vault of `n` files at depth 0 — the virtualiser's worst case, since
 *  every node is visible. */
function flatVault(n, prefix = 'note-') {
  const out = new Array(n)
  for (let i = 0; i < n; i++) out[i] = file(prefix + String(i).padStart(5, '0'))
  return out
}

/* ══ mounting ═══════════════════════════════════════════════════════════════ */

function mount(clientHeight = 842, host = {}) {
  const scroller = doc.createElement('div')
  scroller.className = 'tree-scroller'
  scroller.clientHeight = clientHeight
  const calls = { open: [], cursor: [], expanded: [], scrollTop: [], vanished: [], escape: 0 }
  const t = T.createTree({
    scroller,
    openNote: (p) => calls.open.push(p),
    onCursorMoved: (p) => calls.cursor.push(p),
    onExpandedChanged: (p) => calls.expanded.push(p),
    onScrollTopChanged: (v) => calls.scrollTop.push(v),
    onActiveVanished: (p) => calls.vanished.push(p),
    onEscape: () => (calls.escape += 1),
    ...host,
  })
  return { scroller, tree: t, calls, sizer: scroller.querySelector('.sz') }
}

/** Every `.tr` currently in the document, painted or pooled-and-hidden. */
const rowsOf = (m) => m.sizer.childNodes
const shownRows = (m) => rowsOf(m).filter((r) => !r.hidden)
const rowTextAt = (m, v) => {
  const [first] = m.tree.debug.paintedRange()
  const el = rowsOf(m)[v % m.tree.debug.poolSize()]
  return v >= first ? el.textContent : null
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  §3.2 — the decoder
 * ═════════════════════════════════════════════════════════════════════════ */

test('§3.2 the header decodes, and the length formula is 36 + 14N + M', () => {
  const spec = [dir('Projects', [file('a'), file('b')]), file('top')]
  const buf = buildBlob(spec, { sort: 2, flags: 3, epoch: 987654321 })
  // N = 4 nodes, M = "Projects"+"a"+"b"+"top" = 8+1+1+3 = 13
  assert.equal(buf.byteLength, 36 + 14 * 4 + 13)

  const blob = B.adopt(buf)
  assert.equal(blob.n, 4)
  assert.equal(blob.m, 13)
  assert.equal(blob.sortOrder, 2)
  assert.equal(blob.epoch, 987654321)
  assert.equal(blob.truncatedNodes, true)
  assert.equal(blob.truncatedDepth, true)
})

test('§3.2 the six arrays are VIEWS on the caller buffer — no copy', () => {
  const buf = buildBlob([dir('d', [file('x')])])
  const blob = B.adopt(buf)
  for (const a of [blob.subtree, blob.parent, blob.nameOff, blob.depth, blob.kind, blob.names]) {
    assert.equal(a.buffer, buf, 'every typed array must alias the adopted ArrayBuffer')
  }
  assert.equal(blob.buffer, buf)
})

test('§3.2 pathOf gives a file its .md back and leaves a folder bare', () => {
  const blob = B.adopt(buildBlob([dir('Projects', [dir('2026', [file('plan')])])]))
  assert.equal(blob.pathOf(0), 'Projects')
  assert.equal(blob.pathOf(1), 'Projects/2026')
  assert.equal(blob.pathOf(2), 'Projects/2026/plan.md')
  assert.equal(blob.nameOf(2), 'plan', 'nameOf is the DISPLAY name — no .md')
})

/* ══ §0.38 E85 — the wikilink resolver ═══════════════════════════════════
 * It lives on the blob because the blob owns the vault's index and its path
 * arithmetic, and because a resolver in `main.ts` could not be tested without a
 * DOM.  The ORDER is the thing under test: it has to be total, or the answer
 * depends on which way the walk went. */

const VAULT = [
  dir('Memory', [file('feedback_pr_review_workflow'), file('Shared')]),
  dir('Ops', [dir('Runbooks', [file('Shared')]), file('Deploy')]),
  file('Shared'),
  file('Root note'),
]

test('§0.38 E85 resolveLink: a bare name that is unique, from anywhere', () => {
  const b = B.adopt(buildBlob(VAULT))
  assert.equal(b.resolveLink('feedback_pr_review_workflow', null),
    'Memory/feedback_pr_review_workflow.md')
  assert.equal(b.resolveLink('Deploy', 'Memory/x.md'), 'Ops/Deploy.md')
  assert.equal(b.resolveLink('nothing at all', null), null)
})

test('§0.38 E85 resolveLink: `.md` on the target is optional', () => {
  const b = B.adopt(buildBlob(VAULT))
  assert.equal(b.resolveLink('Deploy.md', null), 'Ops/Deploy.md')
  assert.equal(b.resolveLink('Ops/Deploy.md', null), 'Ops/Deploy.md')
})

/* THE TIE-BREAK, AND IT IS THE HALF THAT MATTERS.  Three notes are called
 * `Shared`.  Obsidian's own resolver takes the SOURCE path for exactly this
 * reason (`getFirstLinkpathDest(path, sourcePath)`), so the one in the reader's
 * own folder wins; then the shallowest; then lexicographic. */
test('§0.38 E85 resolveLink: same folder first, then shallowest, then name', () => {
  const b = B.adopt(buildBlob(VAULT))
  assert.equal(b.resolveLink('Shared', 'Ops/Runbooks/notes.md'), 'Ops/Runbooks/Shared.md')
  assert.equal(b.resolveLink('Shared', 'Memory/anything.md'), 'Memory/Shared.md')
  // No source, or a source whose folder holds no candidate: the shallowest.
  assert.equal(b.resolveLink('Shared', null), 'Shared.md')
  assert.equal(b.resolveLink('Shared', 'Ops/Deploy.md'), 'Shared.md')
})

/* A target with a `/` in it is a PATH, and it matches exactly or not at all.
 * Obsidian falls back to the basename here; falling back means opening a file
 * the user did not name. */
test('§0.38 E85 resolveLink: a path target is exact, and never falls back', () => {
  const b = B.adopt(buildBlob(VAULT))
  assert.equal(b.resolveLink('Ops/Runbooks/Shared', null), 'Ops/Runbooks/Shared.md')
  assert.equal(b.resolveLink('Nowhere/Shared', 'Ops/Runbooks/x.md'), null,
    'a path that does not exist must not resolve to some other Shared')
})

/* ASCII-only folding, for §0.33 E79's reason: a full Unicode fold can change a
 * string's LENGTH, and this compares byte runs. */
test('§0.38 E85 resolveLink: case-insensitive in ASCII, and a folder is never a hit', () => {
  const b = B.adopt(buildBlob(VAULT))
  assert.equal(b.resolveLink('DEPLOY', null), 'Ops/Deploy.md')
  assert.equal(b.resolveLink('root NOTE', null), 'Root note.md')
  assert.equal(b.resolveLink('Memory', null), null, 'Memory is a FOLDER')
  assert.equal(b.resolveLink('', null), null)
  assert.equal(b.resolveLink('   ', null), null)
})

/* The scan compares BYTES against `names` and never calls `nameOf`, so a big
 * vault does not decode every name — and does not evict the row cache the
 * virtualiser is using — on one click. */
test('§0.38 E85 resolveLink: a 3,000-note scan does not touch the name cache', () => {
  const b = B.adopt(buildBlob(flatVault(3000)))
  b.clearNameCache()
  assert.equal(b.resolveLink('note-02999', null), 'note-02999.md')
  assert.equal(b.nameCacheSize, 1, 'only the ONE hit was decoded')
  b.clearNameCache()
  assert.equal(b.resolveLink('no such note', null), null)
  assert.equal(b.nameCacheSize, 0, 'a miss decodes nothing at all')
})

test('§3.2 the name cache is hard-capped at 1,024 and never grows per node', () => {
  const blob = B.adopt(buildBlob(flatVault(3000)))
  for (let i = 0; i < 3000; i++) blob.nameOf(i)
  assert.ok(
    blob.nameCacheSize <= B.NAME_CACHE_MAX,
    `name cache grew to ${blob.nameCacheSize}, cap is ${B.NAME_CACHE_MAX}`
  )
})

test('§3.2 a non-ArrayBuffer names the JSON degradation, not "corrupt bytes"', () => {
  assert.throws(
    () => B.adopt({ nope: 1 }),
    (e) => e.name === 'TreeBlobError' && /degraded to JSON/.test(e.message)
  )
})

test('§3.2 every structural invariant is rejected, each by name', () => {
  const good = buildBlob([dir('d', [file('x'), file('y')])])
  const mutate = (fn) => {
    const b = good.slice(0)
    fn(new DataView(b), new Uint8Array(b))
    return b
  }
  const cases = [
    ['magic', mutate((dv) => dv.setUint32(0, 0xdeadbeef, true)), /magic/],
    ['version', mutate((dv) => dv.setUint32(4, 2, true)), /version 2/],
    ['length', good.slice(0, good.byteLength - 1), /!= 36 \+ 14N \+ M/],
    // parent[1] = 1, i.e. its own index — invariant P says parent < i.
    ['invariant P', mutate((dv) => dv.setInt32(32 + 12 + 4, 1, true)), /invariant P/],
    // subtree[2] = 9 runs past the last node.
    ['subtree range', mutate((dv) => dv.setUint32(32 + 8, 9, true)), /runs past the last node/],
    // depth[2] = 7 while its parent is at depth 0.
    ['depth', mutate((_dv, u8) => (u8[32 + 12 + 12 + 16 + 2] = 7)), /depth\[2\] = 7/],
    // kind[0] sets a reserved bit.
    ['reserved kind bit', mutate((_dv, u8) => (u8[32 + 12 + 12 + 16 + 3] = 0x03)), /reserved bit/],
  ]
  for (const [what, buf, re] of cases) {
    assert.throws(
      () => B.adopt(buf),
      (e) => e.name === 'TreeBlobError' && re.test(e.message),
      `${what}: expected a named TreeBlobError matching ${re}`
    )
  }
})

/* ═══════════════════════════════════════════════════════════════════════════
 *  §3.3 — virtualisation and the pool
 * ═════════════════════════════════════════════════════════════════════════ */

test('§3.3 errata 2 (Y5): the pool is ceil(h/27) + 2·OVERSCAN + 1, from the LIVE height', () => {
  assert.equal(T.OVERSCAN, 8, 'OVERSCAN is a named constant, and it is 8')
  // The BANDS §3.3 actually produces.  They have now moved twice: §0.12 E14
  // deleted the 40px nav toolbar (841 -> 881) and the vault bar going from 37 to
  // its real 43 takes 6 more (881 -> 875).  827 is reached two ways — two cap
  // banners, or E14's single 48px watcher bar — and the formula does not care.
  // The POOL SIZES did not move with the bands, which is the point of asserting
  // the formula at three heights rather than pinning one number: 875 and 881
  // both sit in ceil()'s 33rd row.
  for (const [h, want] of [
    [875, 50], // nothing in the banner slot   (958 − 40 − 43)
    [851, 49], // one cap banner
    [827, 48], // both cap banners, or the watcher-degraded bar alone
  ]) {
    const m = mount(h)
    m.tree.applySnapshot(buildBlob(flatVault(5000)))
    assert.equal(m.tree.debug.poolSize(), want, `clientHeight ${h} must give ${want} rows`)
    assert.equal(rowsOf(m).length, want, 'the DOM must hold exactly the pool')
    m.tree.destroy()
  }
})

test('§3.3 5,000 nodes do NOT become 5,000 DOM nodes', () => {
  const m = mount(842)
  m.tree.applySnapshot(buildBlob(flatVault(5000)))
  assert.equal(m.tree.debug.visibleCount(), 5000)
  assert.equal(rowsOf(m).length, 49)
  assert.equal(m.sizer.style.height, 5000 * 27 + 'px', 'the sizer carries the full scroll height')
  m.tree.destroy()
})

test('§3.3 a banner appearing is an ordinary resize: the pool re-sizes, live', () => {
  const m = mount(842)
  m.tree.applySnapshot(buildBlob(flatVault(5000)))
  assert.equal(m.tree.debug.poolSize(), 49)
  m.scroller.clientHeight = 818 // one cap banner appeared
  m.tree.measure()
  assert.equal(m.tree.debug.poolSize(), 48)
  assert.equal(rowsOf(m).length, 48)
  m.scroller.clientHeight = 842 // and went away
  m.tree.measure()
  assert.equal(m.tree.debug.poolSize(), 49)
  m.tree.destroy()
})

test('§5.12.6(c) a scroll NEVER creates a row, at any position', () => {
  const m = mount(842)
  m.tree.applySnapshot(buildBlob(flatVault(50000)))
  const before = rowsOf(m).length
  for (let st = 0; st <= 50000 * 27 - 842; st += 137) {
    m.scroller.scrollTop = st
    m.tree.debug.onScroll()
    assert.equal(rowsOf(m).length, before, `pool grew at scrollTop ${st}`)
  }
  assert.equal(before, 49)
  m.tree.destroy()
})

test('§5.12.6 the painted band covers the viewport, and pooled rows outside it are hidden', () => {
  const m = mount(842)
  m.tree.applySnapshot(buildBlob(flatVault(5000)))
  m.scroller.scrollTop = 27 * 1000
  m.tree.debug.onScroll()
  const [first, last] = m.tree.debug.paintedRange()
  assert.equal(first, 1000 - T.OVERSCAN)
  // floor((27000 + 842)/27) + 8 = 1031 + 8
  assert.equal(last, 1031 + T.OVERSCAN)
  assert.ok(last - first + 1 <= m.tree.debug.poolSize())
  assert.equal(shownRows(m).length, last - first + 1)
  // Every visible viewport row is painted with the right node.
  for (let v = 1000; v <= 1031; v++) {
    assert.equal(rowTextAt(m, v), 'note-' + String(v).padStart(5, '0'))
  }
  m.tree.destroy()
})

test('§5.12.6(d) a scroll frame at the 50,000-node cap holds the ≤ 2 ms budget', () => {
  const m = mount(842)
  m.tree.applySnapshot(buildBlob(flatVault(50000)))
  const N = 2000
  // Warm the JIT so the number is a steady-state one, not a first-call one.
  for (let k = 0; k < 200; k++) {
    m.scroller.scrollTop = (k * 731) % (50000 * 27 - 842)
    m.tree.debug.onScroll()
  }
  const t0 = process.hrtime.bigint()
  for (let k = 0; k < N; k++) {
    m.scroller.scrollTop = (k * 731) % (50000 * 27 - 842)
    m.tree.debug.onScroll()
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / N
  console.log(`      scroll frame, 50,000 nodes, worst-case jump: ${ms.toFixed(4)} ms/frame`)
  assert.ok(ms < 2, `mean scroll frame ${ms.toFixed(4)} ms exceeds the §5.12.6(d) 2 ms budget`)
  m.tree.destroy()
})

/* ═══════════════════════════════════════════════════════════════════════════
 *  §5.2 — the geometry a row carries
 * ═════════════════════════════════════════════════════════════════════════ */

test('§5.2 a row carries its depth TWICE and its y as translateY at a 27px pitch', () => {
  const m = mount(842)
  m.tree.setExpanded(['Projects', 'Projects/2026'])
  m.tree.applySnapshot(
    buildBlob([dir('Projects', [dir('2026', [file('plan')])]), file('top')])
  )
  const rows = shownRows(m)
  assert.equal(m.tree.debug.visibleCount(), 4)
  const byText = Object.fromEntries(rows.map((r) => [r.textContent, r]))
  assert.equal(byText['Projects'].getAttribute('data-d'), '0')
  assert.equal(byText['Projects'].style.getPropertyValue('--d'), '0')
  assert.equal(byText['2026'].getAttribute('data-d'), '1')
  assert.equal(byText['2026'].style.getPropertyValue('--d'), '1')
  assert.equal(byText['plan'].getAttribute('data-d'), '2')
  assert.equal(byText['plan'].style.getPropertyValue('--d'), '2')
  // Row pitch — §5.2's 27px, and the ONLY transform written.
  assert.equal(byText['Projects'].style.transform, 'translateY(0px)')
  assert.equal(byText['2026'].style.transform, 'translateY(27px)')
  assert.equal(byText['plan'].style.transform, 'translateY(54px)')
  assert.equal(byText['top'].style.transform, 'translateY(81px)')
  // aria-level is 1-based (§5.2's tree semantics).
  assert.equal(byText['plan'].getAttribute('aria-level'), '3')
  m.tree.destroy()
})

test('§0.50 E98 the chevron is an inline <svg class="chev"> child, ahead of the label text node', () => {
  const m = mount(842)
  m.tree.applySnapshot(buildBlob([dir('Full', [file('x')]), file('loose')]))
  const rows = shownRows(m)
  for (const r of rows) {
    // Every pooled row carries the glyph; tree.css shows it only on `.d`. It is
    // an ELEMENT (Obsidian's own construction) and never a mask source: an SVG
    // loaded as a CSS image is laid out in an isolated page that poisons
    // Blink's font-strike scale on Linux — LP-10, the 0.8px line.
    const chev = r.childNodes[0]
    assert.equal(chev && String(chev.tagName).toLowerCase(), 'svg', r.textContent + ': first child is the chevron svg')
    assert.ok(chev.classList.contains('chev'), 'it carries the .chev class tree.css addresses')
    assert.equal(chev.childNodes[0].getAttribute('d'), 'm9 18 6-6-6-6', 'Lucide chevron-right, the literal --chev carried')
    assert.equal(r.childNodes.length, 2, 'chevron + one text node, nothing else')
    assert.equal(r.childNodes[1].textContent, r.textContent, 'the label is the text node, and textContent still reads as the name')
  }
  m.tree.destroy()
})

test('§5.4 the class table: .d for EVERY folder (M61 overturned), .o when open', () => {
  const m = mount(842)
  m.tree.applySnapshot(buildBlob([dir('Empty'), dir('Full', [file('x')]), file('loose')]))
  let by = Object.fromEntries(shownRows(m).map((r) => [r.textContent, r.className]))
  // M61 required 'tr' here — an empty folder drew no chevron. Overturned by
  // measurement of the reference app: Obsidian 1.13.7 constructs its folder
  // item with an unconditional `setCollapsible(!0)` (app.js, beside
  // `addClass("mod-folder")`), which is what creates the `.collapse-icon`, so
  // an empty folder still shows one. See src/tree.ts's chevron predicate.
  assert.equal(by['Empty'], 'tr d', 'an EMPTY folder still draws a chevron (Obsidian-measured)')
  assert.equal(by['Full'], 'tr d', 'a folder with children is .tr.d, collapsed')
  assert.equal(by['loose'], 'tr', 'a file is a bare .tr — the spacer is padding, not a class')

  m.tree.setExpanded(['Full'])
  by = Object.fromEntries(shownRows(m).map((r) => [r.textContent, r.className]))
  assert.equal(by['Full'], 'tr d o', 'an expanded folder gains .o')
  assert.equal(by['x'], 'tr')
  m.tree.destroy()
})

test('the secret mark: setSecrets paints `is-secret` on exactly those rows', () => {
  const m = mount(842)
  m.tree.applySnapshot(buildBlob([file('a'), dir('Projects', [file('plan')]), file('b')]))
  m.tree.setExpanded(['Projects'])
  const rowFor = (t) => shownRows(m).find((r) => r.textContent === t)
  // No secrets: no mark anywhere.
  m.tree.setSecrets([])
  assert.equal(rowFor('a').className, 'tr')
  // One secret file: its row and nothing else — never a folder.
  m.tree.setSecrets(['Projects/plan.md'])
  assert.equal(rowFor('plan').className, 'tr is-secret')
  assert.equal(rowFor('a').className, 'tr')
  assert.equal(rowFor('Projects').className, 'tr d o', 'a folder drew the secret mark')
  // A rel no row holds falls out rather than marking whatever holds the index.
  m.tree.setSecrets(['gone.md'])
  assert.equal(rowFor('plan').className, 'tr')
  // A snapshot re-resolves by PATH, not by index: the mark follows the file.
  m.tree.applySnapshot(buildBlob([file('a'), dir('Projects', [file('plan')]), file('b')]))
  m.tree.setSecrets(['a.md'])
  assert.equal(rowFor('a').className, 'tr is-secret')
  assert.equal(rowFor('plan').className, 'tr')
  m.tree.destroy()
})

/* ---- §0.13 E15 — the row menu must SUPPRESS the engine's own -------------
 * A right-click that does not `preventDefault()` gets the engine's menu as well
 * as Cairn's, and on Linux that means INSTEAD of Cairn's: WebKitGTK's menu is a
 * GTK popup window, taking it blurs the webview, and menu.ts closes on
 * `window.blur`.  Measured on Debian — the tree's own menu had never once been
 * reachable there, on any build, while looking perfectly fine on macOS.
 * ---------------------------------------------------------------------- */

test('§0.13 E15 — a right-click on a ROW opens our menu and cancels the engine\'s', () => {
  const seen = []
  const m = mount(842, { onContextMenu: (ev, path, isDir) => seen.push([path, isDir]) })
  m.tree.applySnapshot(buildBlob([file('a'), dir('Projects', [file('plan')])]))
  const rowFor = (t) => shownRows(m).find((r) => r.textContent === t)

  let prevented = 0
  m.scroller.dispatch('contextmenu', {
    target: rowFor('a'), preventDefault: () => { prevented += 1 },
  })
  assert.equal(prevented, 1,
    "the engine's context menu was not cancelled — on Linux it takes the focus and closes ours")
  assert.deepEqual(seen, [['a.md', false]])

  // A FOLDER row, and EMPTY SPACE (`target` is the scroller itself, so `nodeAt`
  // returns -1) — the empty-space menu is a menu, not "no menu", so it cancels too.
  m.scroller.dispatch('contextmenu', {
    target: rowFor('Projects'), preventDefault: () => { prevented += 1 },
  })
  m.scroller.dispatch('contextmenu', {
    target: m.scroller, preventDefault: () => { prevented += 1 },
  })
  assert.equal(prevented, 3)
  assert.deepEqual(seen, [['a.md', false], ['Projects', true], [null, false]])
})

test('§0.13 E15 — a FROZEN tree cancels the engine\'s menu and opens none of its own', () => {
  // §7.3 case 8: the vault is gone.  Neither menu may act on it — and an engine
  // menu offering Reload over a dirty buffer is worse than no menu at all.
  const seen = []
  const m = mount(842, { onContextMenu: (...a) => seen.push(a), isFrozen: () => true })
  m.tree.applySnapshot(buildBlob([file('a')]))
  let prevented = 0
  m.scroller.dispatch('contextmenu', {
    target: shownRows(m)[0], preventDefault: () => { prevented += 1 },
  })
  assert.equal(prevented, 1)
  assert.deepEqual(seen, [])
})

test('§5.4 active and cursor are ORTHOGONAL classes, .a and .c', () => {
  const m = mount(842)
  m.tree.applySnapshot(buildBlob([file('a'), file('b')]))
  const rowFor = (t) => shownRows(m).find((r) => r.textContent === t)
  // Click 'a': it becomes both cursor and active.
  m.scroller.dispatch('click', { target: rowFor('a') })
  assert.equal(rowFor('a').className, 'tr a c')
  assert.equal(rowFor('a').getAttribute('aria-selected'), 'true')
  // Arrow down: the cursor moves off, the active row stays active.
  m.scroller.dispatch('keydown', key('ArrowDown'))
  assert.equal(rowFor('a').className, 'tr a', 'the active row survives the cursor leaving')
  assert.equal(rowFor('b').className, 'tr c')
  m.tree.destroy()
})

test('the cursor ring is armed by keyboard NAVIGATION, never by a click, a bare Shift or a shift-click (2026-09-15)', () => {
  // Obsidian's `has-focus` lifecycle.  The user's report was the ring drawn on
  // the first plain-clicked row by the Shift held for a shift-click, which the
  // engine's `:focus-visible` heuristic did and this flag cannot.
  const m = mount(842)
  m.tree.applySnapshot(buildBlob([file('a'), file('b'), file('c'), file('cz')]))
  const rowFor = (t) => shownRows(m).find((r) => r.textContent === t)
  const armed = () => m.scroller.classList.contains('kbd-focus')
  assert.equal(armed(), false, 'armed at mount')

  m.scroller.dispatch('click', { target: rowFor('a') })
  assert.equal(armed(), false, 'a plain click armed the ring')
  m.scroller.dispatch('keydown', key('Shift', { shiftKey: true }))
  assert.equal(armed(), false, 'a bare Shift armed the ring')
  m.scroller.dispatch('click', { target: rowFor('c'), shiftKey: true })
  assert.equal(armed(), false, 'a shift-click armed the ring')
  assert.equal(rowFor('a').className, 'tr c s', 'the cursor is still on the first row, which is why it matters')

  m.scroller.dispatch('keydown', key('ArrowDown'))
  assert.equal(armed(), true, 'ArrowDown did not arm the ring')
  // A shift-click leaves has-focus ALONE in Obsidian — so it must not disarm
  // an armed ring either, not merely fail to arm a disarmed one.
  m.scroller.dispatch('click', { target: rowFor('a'), shiftKey: true })
  assert.equal(armed(), true, 'a shift-click disarmed the ring')
  // Obsidian's first Escape clears the selection and keeps has-focus.
  m.scroller.dispatch('keydown', key('Escape'))
  assert.equal(armed(), true, 'Escape disarmed the ring')

  m.scroller.dispatch('click', { target: rowFor('b') })
  assert.equal(armed(), false, 'a plain click on a row did not disarm the ring')
  m.scroller.dispatch('keydown', key('c'))   // type-ahead that moves the cursor
  assert.equal(armed(), true, 'type-ahead that moved the cursor did not arm the ring')
  m.scroller.dispatch('click', { target: m.sizer })   // empty space
  assert.equal(armed(), false, 'a plain click on empty space did not disarm the ring')
  for (const k of ['Enter', 'F2', 'Escape']) {
    m.scroller.dispatch('keydown', key(k))
    assert.equal(armed(), false, k + ' armed the ring')
  }
  // Every navigation key arms it, each from a disarmed start.
  for (const k of ['ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageDown', 'PageUp']) {
    m.scroller.dispatch('click', { target: rowFor('b') })
    assert.equal(armed(), false)
    m.scroller.dispatch('keydown', key(k))
    assert.equal(armed(), true, k + ' did not arm the ring')
  }
  // A key that ACTS on the cursor row without moving it does not — asserted
  // with a cursor present, so the key really reaches its case.
  const deleted = []
  const m2 = mount(842, { onDeleteRequest: (p) => deleted.push(p), onRenameRequest: () => {} })
  m2.tree.applySnapshot(buildBlob([file('a'), file('b')]))
  const row2 = (t) => shownRows(m2).find((r) => r.textContent === t)
  for (const k of ['Delete', 'Backspace', 'F2']) {
    m2.scroller.dispatch('click', { target: row2('b') })
    m2.scroller.dispatch('keydown', key(k))
    assert.equal(m2.scroller.classList.contains('kbd-focus'), false, k + ' with a cursor armed the ring')
  }
  assert.deepEqual(deleted, ['b.md', 'b.md'], 'Delete and Backspace never reached their case')
  m2.tree.destroy()
  m.tree.destroy()
})

test('destroy() leaves neither .kbd-focus nor .is-overflowing on the scroller (2026-09-15)', () => {
  const m = mount(270)
  m.tree.applySnapshot(buildBlob(flatVault(40)))
  m.scroller.dispatch('keydown', key('ArrowDown'))
  assert.ok(m.scroller.classList.contains('kbd-focus') && m.scroller.classList.contains('is-overflowing'))
  m.tree.destroy()
  assert.equal(m.scroller.className, 'tree-scroller')
})

test('.is-overflowing counts BOTH paddings, read from the computed style (2026-09-15)', () => {
  // tree.css's 12px top and 24px bottom, and a band of 881.  31 rows: 12 + 837
  // + 24 = 873, fits.  32 rows: 900, overflows — and 876 without the bottom
  // padding, which would not, so a predicate that drops it fails here.
  const real = globalThis.getComputedStyle
  globalThis.getComputedStyle = () => ({
    getPropertyValue: (k) => (k === '--row-h' ? '27px' : ''),
    paddingTop: '12px',
    paddingBottom: '24px',
  })
  try {
    const m = mount(881)
    m.tree.applySnapshot(buildBlob(flatVault(31)))
    assert.equal(m.scroller.classList.contains('is-overflowing'), false, '873px of content in 881 overflowed')
    m.tree.applySnapshot(buildBlob(flatVault(32)))
    assert.equal(m.scroller.classList.contains('is-overflowing'), true, '900px of content in 881 did not overflow')
    m.tree.destroy()
    // And the TOP padding: 900px in an 889 band overflows, and would not
    // (888) if the predicate dropped padTop.
    const m2 = mount(889)
    m2.tree.applySnapshot(buildBlob(flatVault(32)))
    assert.equal(m2.scroller.classList.contains('is-overflowing'), true, '900px of content in 889 did not overflow')
    m2.tree.destroy()
  } finally {
    globalThis.getComputedStyle = real
  }
})

test('.is-overflowing tracks padTop + rows + padBottom against clientHeight (2026-09-15)', () => {
  // tree.css spends this on the fill's right inset.  The shim has no padding,
  // so the boundary here is rows * 27 against clientHeight exactly.
  const over = (m) => m.scroller.classList.contains('is-overflowing')
  const m = mount(270)
  m.tree.applySnapshot(buildBlob(flatVault(10)))   // 270 of 270: fits
  assert.equal(over(m), false, '10 rows in 270px are not an overflow')
  m.tree.applySnapshot(buildBlob(flatVault(11)))   // 297 > 270
  assert.equal(over(m), true, '11 rows in 270px did not overflow')
  m.scroller.clientHeight = 297
  m.tree.measure()
  assert.equal(over(m), false, 'a taller scroller did not clear the overflow')

  // Folding moves the boundary too, not only snapshots and resizes.
  m.tree.applySnapshot(buildBlob([dir('P', flatVault(20)), file('x')]))
  assert.equal(over(m), false, 'a collapsed folder of 20 is 2 rows')
  m.tree.setExpanded(['P'])
  assert.equal(over(m), true, 'expanding 20 rows into 297px did not overflow')
  m.tree.setExpanded([])
  assert.equal(over(m), false, 'collapsing it again did not clear the overflow')
  m.tree.destroy()
})

test('a single-note vault draws NO active fill on its one row (user ruling 2026-09-14 [C])', () => {
  const m = mount(842)
  m.tree.applySnapshot(buildBlob([file('only')]))
  m.tree.setActivePath('only.md')
  const row = shownRows(m).find((r) => r.textContent === 'only')
  assert.equal(row.className, 'tr', 'the lone note still draws the active fill')
  assert.equal(row.getAttribute('aria-selected'), 'false')
  // …and the fill comes back the moment a second note exists, so this is a
  // suppression and not a deleted state.
  m.tree.applySnapshot(buildBlob([file('only'), file('second')]))
  assert.equal(
    shownRows(m).find((r) => r.textContent === 'only').className,
    'tr a',
    'the active fill did not return with a second note'
  )
  m.tree.destroy()
})

/* ═══════════════════════════════════════════════════════════════════════════
 * Shift-click range selection (user ruling, 2026-09-14) — transcribed from
 * Obsidian 1.13.7's `handleItemSelection`, measured live file by file before
 * anything here was written.  The anchor is the last plain-clicked row (files
 * AND folders); a shift-click replaces the selection with the visible rows
 * from anchor to clicked, inclusive, opening and toggling nothing.
 * ═════════════════════════════════════════════════════════════════════════ */

test('shift-click selects anchor..clicked and opens nothing', () => {
  const m = mount(842)
  m.tree.applySnapshot(buildBlob([file('a'), file('b'), file('c')]))
  const rowFor = (t) => shownRows(m).find((r) => r.textContent === t)
  // A plain click anchors and opens, selecting nothing yet.
  m.scroller.dispatch('click', { target: rowFor('a') })
  assert.deepEqual(m.tree.getSelection(), [])
  assert.deepEqual(m.calls.open, ['a.md'])
  // The shift-click extends the range — and opens nothing further.
  m.scroller.dispatch('click', { target: rowFor('c'), shiftKey: true })
  assert.deepEqual(m.calls.open, ['a.md'], 'shift-click navigated')
  assert.deepEqual(m.tree.getSelection().map((s) => s.path), ['a.md', 'b.md', 'c.md'])
  assert.equal(rowFor('a').className, 'tr c s', 'active+cursor+selected do not compose')
  assert.equal(rowFor('b').className, 'tr s')
  assert.equal(rowFor('c').className, 'tr s')
  assert.equal(rowFor('b').getAttribute('aria-selected'), 'true')
  m.tree.destroy()
})

test('a live selection suppresses the active fill everywhere; clearing restores it', () => {
  // User ruling, 2026-09-15 [C]: while a shift-selection is live, no row
  // draws grey — the selection is the one highlight system on screen.
  const m = mount(842)
  m.tree.applySnapshot(buildBlob([file('a'), file('b'), file('c')]))
  const rowFor = (t) => shownRows(m).find((r) => r.textContent === t)
  m.scroller.dispatch('click', { target: rowFor('a') })
  m.scroller.dispatch('click', { target: rowFor('b'), shiftKey: true })
  assert.equal(rowFor('a').className, 'tr c s', 'the open row kept its grey fill inside the selection')
  // Move the open note OUTSIDE the selection without touching mouse state.
  m.tree.setActivePath('c.md')
  assert.equal(rowFor('c').className, 'tr', 'the open note draws grey beside a live selection')
  assert.equal(rowFor('c').getAttribute('aria-selected'), 'false')
  assert.equal(rowFor('a').className, 'tr c s')
  // Clearing the selection brings the active fill back.
  m.scroller.dispatch('keydown', key('Escape'))
  assert.equal(rowFor('c').className, 'tr a')
  m.tree.destroy()
})

test('a second shift-click re-ranges from the SAME anchor', () => {
  const m = mount(842)
  m.tree.applySnapshot(buildBlob([file('a'), file('b'), file('c')]))
  const rowFor = (t) => shownRows(m).find((r) => r.textContent === t)
  m.scroller.dispatch('click', { target: rowFor('c') })
  m.scroller.dispatch('click', { target: rowFor('a'), shiftKey: true })
  assert.deepEqual(m.tree.getSelection().map((s) => s.path), ['a.md', 'b.md', 'c.md'])
  // Back the other way: the range follows the NEW end, rows outside fall out.
  m.scroller.dispatch('click', { target: rowFor('b'), shiftKey: true })
  assert.deepEqual(m.tree.getSelection().map((s) => s.path), ['b.md', 'c.md'])
  assert.equal(rowFor('a').className, 'tr', 'a row outside the new range kept its fill')
  m.tree.destroy()
})

test('a folder anchors without selecting, and is a valid range end', () => {
  const m = mount(842)
  m.tree.applySnapshot(buildBlob([dir('P', [file('a'), file('b')]), file('Misc')]))
  const rowFor = (t) => shownRows(m).find((r) => r.textContent === t)
  // Plain folder click folds it open AND anchors — selecting nothing.
  m.scroller.dispatch('click', { target: rowFor('P') })
  assert.deepEqual(m.tree.getSelection(), [], 'a folder click selected')
  assert.deepEqual(m.calls.open, [], 'a folder click opened a note')
  // Shift-click a file: the range runs P..b over the visible rows.
  m.scroller.dispatch('click', { target: rowFor('b'), shiftKey: true })
  assert.deepEqual(m.tree.getSelection().map((s) => s.path), ['P', 'P/a.md', 'P/b.md'])
  assert.equal(rowFor('P').className, 'tr d o c s', 'the click parks the cursor on the folder too')
  m.tree.destroy()
})

test('shift-click with no anchor selects just the clicked row', () => {
  const m = mount(842)
  m.tree.applySnapshot(buildBlob([file('a'), file('b')]))
  const rowFor = (t) => shownRows(m).find((r) => r.textContent === t)
  // No plain click first (the note arrived via restore, not the mouse).
  m.scroller.dispatch('click', { target: rowFor('b'), shiftKey: true })
  assert.deepEqual(m.tree.getSelection().map((s) => s.path), ['b.md'])
  assert.equal(rowFor('b').className, 'tr s')
  assert.deepEqual(m.calls.open, [], 'an anchorless shift-click navigated')
  m.tree.destroy()
})

test('a plain click on the open file keeps anchor and selection', () => {
  const m = mount(842)
  m.tree.applySnapshot(buildBlob([file('a'), file('b')]))
  const rowFor = (t) => shownRows(m).find((r) => r.textContent === t)
  m.scroller.dispatch('click', { target: rowFor('a') })
  m.scroller.dispatch('click', { target: rowFor('b'), shiftKey: true })
  // 'a' is open; clicking it again moves the cursor and re-opens, but the
  // anchor stays 'a' and the range survives (Obsidian's is-active branch).
  m.scroller.dispatch('click', { target: rowFor('a') })
  assert.deepEqual(m.tree.getSelection().map((s) => s.path), ['a.md', 'b.md'])
  assert.equal(rowFor('b').className, 'tr s')
  m.tree.destroy()
})

test('Escape drops the selection first, and only then the editor takes it', () => {
  const m = mount(842)
  m.tree.applySnapshot(buildBlob([file('a'), file('b')]))
  const rowFor = (t) => shownRows(m).find((r) => r.textContent === t)
  m.scroller.dispatch('click', { target: rowFor('a') })
  m.scroller.dispatch('click', { target: rowFor('b'), shiftKey: true })
  m.scroller.dispatch('keydown', key('Escape'))
  assert.deepEqual(m.tree.getSelection(), [], 'Escape did not clear the selection')
  assert.equal(m.calls.escape, 0, 'Escape fell through to the editor with a live selection')
  assert.equal(rowFor('b').className, 'tr', 'a cleared row kept its fill')
  m.scroller.dispatch('keydown', key('Escape'))
  assert.equal(m.calls.escape, 1, 'Escape stopped working after the selection cleared')
  m.tree.destroy()
})

test('a refresh drops vanished rows (and anchor) from the selection', () => {
  const m = mount(842)
  m.tree.applySnapshot(buildBlob([file('a'), file('b'), file('c')]))
  const rowFor = (t) => shownRows(m).find((r) => r.textContent === t)
  m.scroller.dispatch('click', { target: rowFor('a') })
  m.scroller.dispatch('click', { target: rowFor('c'), shiftKey: true })
  m.tree.applySnapshot(buildBlob([file('a'), file('c')]))
  assert.deepEqual(m.tree.getSelection().map((s) => s.path), ['a.md', 'c.md'])
  // The anchor survived (it is still there); a re-shift ranges from it.
  m.scroller.dispatch('click', { target: rowFor('c'), shiftKey: true })
  assert.deepEqual(m.tree.getSelection().map((s) => s.path), ['a.md', 'c.md'])
  // Now lose the anchor AND the rest: the next shift-click stands alone.
  m.tree.applySnapshot(buildBlob([file('b')]))
  assert.deepEqual(m.tree.getSelection(), [], 'a deleted selection survived the refresh')
  m.scroller.dispatch('click', { target: rowFor('b'), shiftKey: true })
  assert.deepEqual(m.tree.getSelection().map((s) => s.path), ['b.md'])
  m.tree.destroy()
})

test('§3.4 expansion is PATH-keyed: a git pull inserting a folder does not move it', () => {
  const m = mount(842)
  const before = [
    dir('Archive', [file('old')]),
    dir('Projects', [file('plan'), file('spec')]),
  ]
  m.tree.applySnapshot(buildBlob(before))
  // Expand Projects by clicking it.
  const proj = shownRows(m).find((r) => r.textContent === 'Projects')
  m.scroller.dispatch('click', { target: proj })
  assert.deepEqual(
    shownRows(m).map((r) => r.textContent).sort(),
    ['Archive', 'Projects', 'plan', 'spec']
  )
  assert.deepEqual(m.tree.expanded(), ['Projects'])

  // An external `git pull` creates AAA/, shifting every index by two.
  const after = [
    dir('AAA', [file('fresh')]),
    dir('Archive', [file('old')]),
    dir('Projects', [file('plan'), file('spec')]),
  ]
  m.tree.applySnapshot(buildBlob(after))
  assert.deepEqual(
    shownRows(m).map((r) => r.textContent).sort(),
    ['AAA', 'Archive', 'Projects', 'plan', 'spec'],
    'Projects is still expanded although its node index changed'
  )
  m.tree.destroy()
})

test('§3.4 expansion survives a folder deleted and recreated (git checkout)', () => {
  const m = mount(842)
  m.tree.applySnapshot(buildBlob([dir('P', [file('a')])]))
  m.tree.setExpanded(['P'])
  assert.equal(m.tree.debug.visibleCount(), 2)
  // The folder vanishes entirely...
  m.tree.applySnapshot(buildBlob([file('unrelated')]))
  assert.equal(m.tree.debug.visibleCount(), 1)
  // ...and comes back.  Path-keying is what restores it; a NodeId key could not.
  m.tree.applySnapshot(buildBlob([dir('P', [file('a')]), file('unrelated')]))
  assert.deepEqual(shownRows(m).map((r) => r.textContent).sort(), ['P', 'a', 'unrelated'])
  m.tree.destroy()
})

test('§7.6 setExpanded seeds and the set is capped at 2,000', () => {
  const m = mount(842)
  const many = Array.from({ length: 2500 }, (_, i) => 'f' + i)
  m.tree.setExpanded(many)
  assert.equal(m.tree.expanded().length, T.EXPANDED_CAP)
  assert.equal(T.EXPANDED_CAP, 2000)
  m.tree.destroy()
})

test('§3.4 revealPath adds every ancestor, centres, and returns the visible index', () => {
  const m = mount(842)
  m.tree.applySnapshot(
    buildBlob([...flatVault(200), dir('P', [dir('Q', [file('deep')])])])
  )
  assert.equal(m.tree.debug.visibleCount(), 201, 'P is collapsed to start with')
  const v = m.tree.revealPath('P/Q/deep.md')
  assert.equal(v, 202)
  assert.deepEqual(m.tree.expanded().sort(), ['P', 'P/Q'])
  assert.equal(m.tree.cursorPath(), 'P/Q/deep.md')
  // Centred: top − (clientHeight − rowH)/2 (§12.1 — an arbitrary jump DOES centre).
  assert.equal(m.scroller.scrollTop, Math.round(202 * 27 - (842 - 27) / 2))
  assert.equal(m.tree.revealPath('nope/gone.md'), -1)
  m.tree.destroy()
})

/* ═══════════════════════════════════════════════════════════════════════════
 *  §3.5 — full rebuild, always.  This is the regression the paint caches broke.
 * ═════════════════════════════════════════════════════════════════════════ */

test('§3.5 REGRESSION: a rename that keeps the node index still repaints the name', () => {
  // A name-sorted vault of a, b, c.  Renaming `b.md` to `bb.md` leaves the
  // renamed note at node index 1, so paint()'s `__n !== n` guard held and the
  // row kept its old text.  The pool's caches are keyed on a node index, which
  // identifies nothing across a snapshot.
  const m = mount(842)
  m.tree.applySnapshot(buildBlob([file('a'), file('b'), file('c')]))
  assert.deepEqual(shownRows(m).map((r) => r.textContent), ['a', 'b', 'c'])
  m.tree.applySnapshot(buildBlob([file('a'), file('bb'), file('c')]))
  assert.deepEqual(
    shownRows(m).map((r) => r.textContent),
    ['a', 'bb', 'c'],
    'the renamed row must show its NEW name without waiting to be recycled'
  )
  m.tree.destroy()
})

test('§3.5 REGRESSION: a depth change at a constant node index repaints --d', () => {
  const m = mount(842)
  m.tree.setExpanded(['P'])
  m.tree.applySnapshot(buildBlob([dir('P', [file('x')])]))
  let x = shownRows(m).find((r) => r.textContent === 'x')
  assert.equal(x.getAttribute('data-d'), '1')
  // `P` is deleted and `x.md` moves to the vault root: still one node, index 0,
  // now at depth 0.  Nothing but a cache invalidation makes this repaint.
  m.tree.applySnapshot(buildBlob([file('x')]))
  x = shownRows(m).find((r) => r.textContent === 'x')
  assert.equal(x.getAttribute('data-d'), '0')
  assert.equal(x.style.getPropertyValue('--d'), '0')
  m.tree.destroy()
})

// Not a cache regression — `__m` is keyed on the STATE BITS, not on the node
// index, so it self-invalidates whenever the answer actually changes.  Kept
// because M61 across a snapshot is worth pinning either way.
test('a folder emptied by a delete KEEPS its chevron (M61 overturned)', () => {
  const m = mount(842)
  m.tree.applySnapshot(buildBlob([dir('P', [file('only')])]))
  assert.equal(shownRows(m).find((r) => r.textContent === 'P').className, 'tr d')
  m.tree.applySnapshot(buildBlob([dir('P')]))
  // M61 required 'tr' here. Overturned by measurement: Obsidian's folder item
  // is unconditionally collapsible, so emptying a folder does not remove its
  // chevron. The row must also not FLICKER between the two states, which is
  // the reason this direction is tested separately from the static case.
  assert.equal(
    shownRows(m).find((r) => r.textContent === 'P').className,
    'tr d',
    'a folder that loses its last child still draws a chevron (Obsidian-measured)'
  )
  m.tree.destroy()
})

test('§7.3 case 5 the active note vanishing is REPORTED, and activePath is kept', () => {
  const m = mount(842)
  m.tree.applySnapshot(buildBlob([file('a'), file('b')]))
  m.tree.setActivePath('a.md')
  assert.equal(shownRows(m).find((r) => r.textContent === 'a').className, 'tr a')
  m.tree.applySnapshot(buildBlob([file('b')]))
  assert.deepEqual(m.calls.vanished, ['a.md'])
  assert.equal(m.tree.activePath(), 'a.md', 'the editor still holds a buffer for it')
  assert.equal(shownRows(m).some((r) => r.className.includes('a')), false)
  m.tree.destroy()
})

test('§3.5 scrollTop is preserved across a snapshot and clamped to the new content', () => {
  const m = mount(842)
  m.tree.applySnapshot(buildBlob(flatVault(5000)))
  m.scroller.scrollTop = 27 * 4000
  m.tree.debug.onScroll()
  m.tree.applySnapshot(buildBlob(flatVault(5000)))
  assert.equal(m.scroller.scrollTop, 27 * 4000, 'a same-size refresh does not jump')
  m.tree.applySnapshot(buildBlob(flatVault(100)))
  assert.equal(m.scroller.scrollTop, 100 * 27 - 842, 'a shrunken vault clamps to the new bottom')
  m.tree.destroy()
})

/* ═══════════════════════════════════════════════════════════════════════════
 *  keyboard, clicks and the frozen state
 * ═════════════════════════════════════════════════════════════════════════ */

test('up/down/left/right/enter — §12.1', () => {
  const m = mount(842)
  m.tree.applySnapshot(buildBlob([dir('P', [file('x'), file('y')]), file('z')]))

  m.scroller.dispatch('keydown', key('ArrowDown'))
  assert.equal(m.tree.cursorPath(), 'P')

  // Right on a collapsed folder EXPANDS it; right again steps to the first child.
  m.scroller.dispatch('keydown', key('ArrowRight'))
  assert.deepEqual(m.tree.expanded(), ['P'])
  assert.equal(m.tree.cursorPath(), 'P')
  m.scroller.dispatch('keydown', key('ArrowRight'))
  assert.equal(m.tree.cursorPath(), 'P/x.md')

  // Left on a file steps to its parent; left again collapses.
  m.scroller.dispatch('keydown', key('ArrowLeft'))
  assert.equal(m.tree.cursorPath(), 'P')
  m.scroller.dispatch('keydown', key('ArrowLeft'))
  assert.deepEqual(m.tree.expanded(), [])
  assert.equal(m.tree.debug.visibleCount(), 2)

  // Down onto the file, Enter opens it.
  m.scroller.dispatch('keydown', key('ArrowDown'))
  assert.equal(m.tree.cursorPath(), 'z.md')
  m.scroller.dispatch('keydown', key('Enter'))
  assert.deepEqual(m.calls.open, ['z.md'])

  // Enter on a folder toggles rather than opening.
  m.scroller.dispatch('keydown', key('ArrowUp'))
  m.scroller.dispatch('keydown', key('Enter'))
  assert.deepEqual(m.tree.expanded(), ['P'])
  assert.deepEqual(m.calls.open, ['z.md'], 'a folder never opens a note')

  // Up from the top does not wrap and does not throw.
  m.scroller.dispatch('keydown', key('ArrowUp'))
  assert.equal(m.tree.cursorPath(), 'P')
  m.tree.destroy()
})

test('a modified arrow key is left to the global shortcuts (§12.2)', () => {
  const m = mount(842)
  m.tree.applySnapshot(buildBlob([file('a'), file('b')]))
  const ev = key('ArrowDown', { metaKey: true })
  m.scroller.dispatch('keydown', ev)
  assert.equal(ev.defaultPrevented, false)
  assert.equal(m.tree.cursorPath(), null)
  m.tree.destroy()
})

test('§7.3 case 8 a FROZEN tree moves the cursor but opens nothing and toggles nothing', () => {
  let frozen = false
  const m = mount(842, { isFrozen: () => frozen })
  m.tree.applySnapshot(buildBlob([dir('P', [file('x')]), file('z')]))
  frozen = true
  const rowFor = (t) => shownRows(m).find((r) => r.textContent === t)
  m.scroller.dispatch('click', { target: rowFor('z') })
  assert.equal(m.tree.cursorPath(), 'z.md', 'the cursor still moves')
  assert.deepEqual(m.calls.open, [], 'but no note is opened')
  m.scroller.dispatch('click', { target: rowFor('P') })
  assert.deepEqual(m.tree.expanded(), [], 'and no folder toggles')
  frozen = false
  m.scroller.dispatch('click', { target: rowFor('P') })
  assert.deepEqual(m.tree.expanded(), ['P'])
  m.tree.destroy()
})

test('a click on empty space below the last row drops the cursor and keeps the active note', () => {
  const m = mount(842)
  m.tree.applySnapshot(buildBlob([file('a')]))
  m.scroller.dispatch('click', { target: shownRows(m)[0] })
  assert.equal(m.tree.cursorPath(), 'a.md')
  m.scroller.dispatch('click', { target: m.sizer })
  assert.equal(m.tree.cursorPath(), null)
  assert.equal(m.tree.activePath(), 'a.md')
  assert.deepEqual(m.calls.cursor, ['a.md', null])
  m.tree.destroy()
})

/* ═══════════════════════════════════════════════════════════════════════════
 *  §7.6 — persistence
 * ═════════════════════════════════════════════════════════════════════════ */

test('§7.6 expanded and scrollTop are debounced, and scrollTop reports the LAST value', () => {
  const m = mount(842)
  m.tree.applySnapshot(buildBlob(flatVault(5000)))
  // Many scroll events, as in a momentum tail.  Exactly one patch, carrying the
  // final position — this is what the hoisted, non-allocating callback must
  // still get right.
  for (let k = 1; k <= 50; k++) {
    m.scroller.scrollTop = k * 100
    m.tree.debug.onScroll()
  }
  assert.deepEqual(m.calls.scrollTop, [], 'nothing is persisted while scrolling')
  m.tree.debug.flushPersist()
  assert.deepEqual(m.calls.scrollTop, [5000])

  m.tree.setExpanded([])
  m.scroller.dispatch('click', {
    target: shownRows(m)[0],
  })
  m.tree.destroy()
})

test('§7.6 an expansion change is debounced into ONE patch', () => {
  const m = mount(842)
  m.tree.applySnapshot(buildBlob([dir('P', [file('x')]), dir('Q', [file('y')])]))
  const rowFor = (t) => shownRows(m).find((r) => r.textContent === t)
  m.scroller.dispatch('click', { target: rowFor('P') })
  m.scroller.dispatch('click', { target: rowFor('Q') })
  assert.deepEqual(m.calls.expanded, [], 'not written yet')
  m.tree.debug.flushPersist()
  assert.equal(m.calls.expanded.length, 1)
  assert.deepEqual(m.calls.expanded[0].sort(), ['P', 'Q'])
  m.tree.destroy()
})

test('destroy() removes every listener and every pooled row', () => {
  const m = mount(842)
  m.tree.applySnapshot(buildBlob(flatVault(5000)))
  assert.equal(rowsOf(m).length, 49)
  for (const t of ['scroll', 'click', 'contextmenu', 'keydown']) {
    assert.equal(m.scroller.listenerCount(t), 1, `${t} listener`)
  }
  m.tree.destroy()
  assert.equal(rowsOf(m).length, 0)
  assert.equal(m.tree.debug.poolSize(), 0)
  for (const t of ['scroll', 'click', 'contextmenu', 'keydown']) {
    assert.equal(m.scroller.listenerCount(t), 0, `${t} listener after destroy`)
  }
})

/* ═══════════════════════════════════════════════════════════════════════════
 *  §7.5 — THE POOL IS BORN HIDDEN (regression for commit 42f852e)
 *
 *  The pool is sized from `clientHeight` at mount, but `paint()` and
 *  `onScroll()` both return early while `blob` is null, so nothing hides a
 *  fresh row until the FIRST snapshot arrives.  On §7.5's first run that window
 *  has no end — `current_vault()` returns `{state:'none'}` and no snapshot is
 *  ever applied — and the end-to-end launch measured the consequence: "35
 *  visible .tr rows, .sz height=0, first row text=''" stacked under the nav
 *  toolbar, for as long as the user took to pick a vault.
 * ═════════════════════════════════════════════════════════════════════════ */

test('§7.5 REGRESSION: every pooled row is born HIDDEN, and stays hidden with no vault', () => {
  const m = mount(842)
  // The pool exists — this is not passing by never having been built.
  assert.equal(m.tree.debug.poolSize(), 49)
  assert.equal(rowsOf(m).length, 49)
  assert.equal(shownRows(m).length, 0, 'a fresh pool row is visible before any snapshot')
  for (const r of rowsOf(m)) {
    assert.equal(r.hidden, true)
    assert.equal(r.textContent, '', 'a born row carries a name')
    assert.equal(r.style.transform, '', 'a born row carries a --y it was never given')
  }
  // …and nothing un-hides them: a scroll, a re-measure and a re-size all run
  // while `blob` is null, which is exactly the first-run window.
  m.tree.debug.onScroll()
  m.scroller.clientHeight = 794
  m.tree.measure()
  assert.equal(shownRows(m).length, 0, 'a pre-snapshot scroll or resize un-hid the pool')
  m.tree.destroy()
})

test('§7.5 the first snapshot un-hides EXACTLY the painted band, not the whole pool', () => {
  const m = mount(842)
  m.tree.applySnapshot(buildBlob(flatVault(6)))
  // 6 rows of content in a 49-row pool: six visible, forty-three still hidden.
  assert.equal(shownRows(m).length, 6)
  assert.equal(rowsOf(m).length, 49)
  assert.deepEqual(
    shownRows(m).map((r) => r.textContent),
    ['note-00000', 'note-00001', 'note-00002', 'note-00003', 'note-00004', 'note-00005']
  )
  m.tree.destroy()
})

/* ═══════════════════════════════════════════════════════════════════════════
 *  §5.4.2 / §7.3 cases 4 and 11 — THE INLINE ROW EDITOR
 *
 *  §5.4.2 and Obsidian both put a new or renamed entry in an editable field IN
 *  THE TREE ROW.  Before `rowHost`/`reserveRowHost` existed `TreeController`
 *  handed out no host element, so `main.ts` fell back to a centred dialog and
 *  said so in a REPORTED DEVIATION comment.  These tests are about PLACEMENT,
 *  which is this file's half; the filter, the flash and the error copy are
 *  inline-edit.ts's and are asserted through it, not restated here.
 * ═════════════════════════════════════════════════════════════════════════ */

const tinyVault = () =>
  buildBlob([
    dir('Projects', [file('a'), dir('2026', [file('deep')])]),
    file('Misc'),
    file('Zed'),
  ])

/** A mount with the fixture applied and `Projects` open. */
function mountOpen(clientHeight = 842) {
  const m = mount(clientHeight)
  m.tree.applySnapshot(tinyVault())
  m.tree.setExpanded(['Projects'])
  return m
}

const editRow = (m) => rowsOf(m).find((r) => r.classes.has('tr-edit')) ?? null
const yOf = (el) => Number(/translateY\((-?\d+)px\)/.exec(el.style.transform ?? '')?.[1] ?? NaN)

test('§5.4.2 rowHost() gives a positioned .tr.tr-edit ON the row, at the row depth', () => {
  const m = mountOpen()
  // Rows: 0 Projects, 1 a, 2 2026, 3 Misc, 4 Zed.
  const h = m.tree.rowHost('Projects/a.md')
  assert.ok(h, 'rowHost returned null for a visible row')
  assert.equal(h, editRow(m))
  assert.deepEqual([...h.classes].sort(), ['tr', 'tr-edit'])
  assert.equal(yOf(h), 1 * 27, 'the host is not on the row it is editing')
  // §5.2's TWO depth channels, exactly as a pooled row carries them, or the
  // field does not line up with the names above and below it.
  assert.equal(h.getAttribute('data-d'), '1')
  assert.equal(h.style.getPropertyValue('--d'), '1')
  assert.equal(m.tree.debug.editingPath(), 'Projects/a.md')
  m.tree.destroy()
})

test('§5.4.2 the row under a rename is SUPPRESSED, so the old name is not drawn behind the field', () => {
  const m = mountOpen()
  const before = shownRows(m).map((r) => r.textContent)
  assert.deepEqual(before, ['Projects', 'a', '2026', 'Misc', 'Zed'])
  m.tree.rowHost('Projects/a.md')
  const during = shownRows(m)
    .filter((r) => !r.classes.has('tr-edit'))
    .map((r) => r.textContent)
  assert.deepEqual(during, ['Projects', '2026', 'Misc', 'Zed'], '"a" is still painted')
  // …and it comes back, with its name and its position, when the host goes.
  m.tree.releaseRowHost()
  assert.equal(editRow(m), null)
  assert.deepEqual(
    shownRows(m).map((r) => r.textContent),
    ['Projects', 'a', '2026', 'Misc', 'Zed']
  )
  m.tree.destroy()
})

test('§5.4.2 rowHost() on a COLLAPSED row reveals its ancestors first', () => {
  const m = mount(842)
  m.tree.applySnapshot(tinyVault())          // everything collapsed
  assert.equal(m.tree.debug.visibleCount(), 3)
  const h = m.tree.rowHost('Projects/2026/deep.md')
  assert.ok(h, 'rowHost gave up on a row hidden under a collapsed ancestor')
  assert.deepEqual(m.tree.expanded().sort(), ['Projects', 'Projects/2026'])
  // Projects(0) a(1) 2026(2) deep(3) Misc(4) Zed(5)
  assert.equal(yOf(h), 3 * 27)
  assert.equal(h.getAttribute('data-d'), '2')
  m.tree.destroy()
})

test('§5.4.2 reserveRowHost() opens the parent, takes REAL space and shifts the rows below it', () => {
  const m = mount(842)
  m.tree.applySnapshot(tinyVault())          // Projects collapsed
  const h = m.tree.reserveRowHost('Projects')
  assert.ok(h)
  // The folder is opened — otherwise the reserved row is the only thing in it.
  assert.ok(m.tree.expanded().includes('Projects'))
  // First child of Projects: display row 1, depth 1.
  assert.equal(m.tree.debug.reservedAt(), 1)
  assert.equal(yOf(h), 27)
  assert.equal(h.getAttribute('data-d'), '1')
  // NOTHING is drawn on top of anything: `a` was display row 1 and is now 2.
  const painted = shownRows(m)
    .filter((r) => !r.classes.has('tr-edit'))
    .map((r) => [r.textContent, yOf(r)])
  assert.deepEqual(painted, [
    ['Projects', 0],
    ['a', 2 * 27],
    ['2026', 3 * 27],
    ['Misc', 4 * 27],
    ['Zed', 5 * 27],
  ])
  // …and the content is one row taller, so the last row can still be scrolled to.
  assert.equal(m.sizer.style.height, 6 * 27 + 'px')
  m.tree.releaseRowHost()
  assert.equal(m.sizer.style.height, 5 * 27 + 'px')
  assert.equal(m.tree.debug.reservedAt(), -1)
  m.tree.destroy()
})

test('§5.4.2 reserveRowHost("") reserves row 0 at the vault root', () => {
  const m = mountOpen()
  const h = m.tree.reserveRowHost('')
  assert.ok(h)
  assert.equal(m.tree.debug.reservedAt(), 0)
  assert.equal(yOf(h), 0)
  assert.equal(h.getAttribute('data-d'), '0')
  assert.equal(yOf(shownRows(m).find((r) => r.textContent === 'Projects')), 27)
  m.tree.destroy()
})

test('§7.3 case 11 beginRename() opens the SHARED field in the row and commits on Enter', async () => {
  const m = mountOpen()
  const committed = []
  // The field holds what the ROW was drawing — no `.md`, exactly as Obsidian's
  // `getTitle()` is `file.basename` — and the extension goes back on through
  // `suffix`.  That is how main.ts calls it.
  const h = m.tree.beginRename('Misc.md', {
    initial: 'Misc',
    suffix: '.md',
    onCommit(name) {
      committed.push(name)
      return { ok: true }
    },
  })
  assert.ok(h)
  const input = h.input
  assert.equal(input.parentNode, editRow(m), 'the field is not inside the tree row')
  // The shared editor, not a second copy: its class, its selection, its
  // rejected-character filter.
  assert.ok(input.classes.has('inline-edit-input'))
  assert.deepEqual([input.selectionStart, input.selectionEnd], [0, 'Misc'.length])
  input.value = 'Notes'
  input.dispatch('keydown', { key: 'Enter', preventDefault() {}, stopPropagation() {} })
  await new Promise((r) => setTimeout(r, 0))
  assert.deepEqual(committed, ['Notes.md'])
  assert.equal(h.closed, true)
  assert.equal(editRow(m), null, 'a committed editor left its host behind')
  assert.equal(m.tree.debug.editingPath(), null)
  m.tree.destroy()
})

test("beginRename() selects the WHOLE name — a dot in a title is not an extension", () => {
  // Obsidian's `startRename` ends in `sm(innerEl)`, i.e.
  // `Range.selectNodeContents` over the whole title, and the title carries no
  // extension to protect.  The default here was `'stem'`, which cut at the LAST
  // dot: opening `v1.2 plan` for rename selected `v1` and left ` plan`
  // untouched, so the first keystroke produced `X plan`.
  const m = mount(842)
  m.tree.applySnapshot(buildBlob([file('v1.2 plan'), file('Zed')]))
  const h = m.tree.beginRename('v1.2 plan.md', { initial: 'v1.2 plan', suffix: '.md',
                                                 onCommit: () => ({ ok: true }) })
  assert.ok(h)
  assert.deepEqual([h.input.selectionStart, h.input.selectionEnd], [0, 'v1.2 plan'.length])
  // …and a caller that genuinely wants a partial selection still gets one.
  h.cancel()
  const g = m.tree.beginRename('v1.2 plan.md', { initial: 'v1.2 plan', select: 'stem',
                                                 onCommit: () => ({ ok: true }) })
  assert.deepEqual([g.input.selectionStart, g.input.selectionEnd], [0, 'v1'.length])
  m.tree.destroy()
})

test('a FOLDER under rename keeps its chevron, at its own rotation', () => {
  const m = mountOpen()
  // `Projects` is expanded, so its arrow is rotated: `.tr.d.o`.  Obsidian puts
  // `contenteditable` on the title INSIDE the row and touches nothing else, so
  // the collapse icon never goes anywhere.  The host used to be a bare
  // `.tr.tr-edit`, and the arrow vanished for the length of the edit.
  m.tree.beginRename('Projects', { initial: 'Projects', onCommit: () => ({ ok: true }) })
  assert.deepEqual([...editRow(m).classes].sort(), ['d', 'o', 'tr', 'tr-edit'])
  assert.equal(editRow(m).getAttribute('aria-expanded'), 'true')
  m.tree.releaseRowHost()

  // A COLLAPSED folder keeps the arrow and loses the rotation.
  m.tree.setExpanded([])
  m.tree.beginRename('Projects', { initial: 'Projects', onCommit: () => ({ ok: true }) })
  assert.deepEqual([...editRow(m).classes].sort(), ['d', 'tr', 'tr-edit'])
  assert.equal(editRow(m).getAttribute('aria-expanded'), 'false')
  m.tree.releaseRowHost()

  // A FILE has no arrow to keep, and a RESERVED row has no entry yet — a
  // chevron there would toggle nothing (§9 E4, no inert decoration).
  m.tree.beginRename('Misc.md', { initial: 'Misc', suffix: '.md', onCommit: () => ({ ok: true }) })
  assert.deepEqual([...editRow(m).classes].sort(), ['tr', 'tr-edit'])
  m.tree.releaseRowHost()
  m.tree.beginCreate('', { initial: 'Untitled', onCommit: () => ({ ok: true }) })
  assert.deepEqual([...editRow(m).classes].sort(), ['tr', 'tr-edit'])
  m.tree.destroy()
})

test('the renamed row keeps the ACTIVE fill when it is the open note', () => {
  const m = mountOpen()
  m.tree.setActivePath('Misc.md')
  m.tree.beginRename('Misc.md', { initial: 'Misc', suffix: '.md', onCommit: () => ({ ok: true }) })
  // Obsidian's `startRenameFile` never clears `is-active`, so the row the user
  // is looking at does not lose its fill for the duration of the edit.
  assert.deepEqual([...editRow(m).classes].sort(), ['a', 'tr', 'tr-edit'])
  m.tree.releaseRowHost()
  m.tree.setActivePath('Zed.md')
  m.tree.beginRename('Misc.md', { initial: 'Misc', suffix: '.md', onCommit: () => ({ ok: true }) })
  assert.deepEqual([...editRow(m).classes].sort(), ['tr', 'tr-edit'])
  m.tree.destroy()
})

test('§7.3 case 11 a REJECTED commit keeps the field open, in the row', async () => {
  const m = mountOpen()
  const h = m.tree.beginRename('Misc.md', {
    initial: 'Misc.md',
    onCommit() {
      return { ok: false, message: 'A file or folder with that name already exists.' }
    },
  })
  h.input.value = 'Zed.md'
  h.input.dispatch('keydown', { key: 'Enter', preventDefault() {}, stopPropagation() {} })
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(h.closed, false, 'the editor closed over a rejected name')
  assert.equal(editRow(m), h.input.parentNode, 'the host went away under the open field')
  assert.equal(m.tree.debug.editingPath(), 'Misc.md')
  m.tree.destroy()
})

test('Escape cancels the inline editor and gives the row back', () => {
  const m = mountOpen()
  let cancelled = 0
  const h = m.tree.beginRename('Misc.md', {
    initial: 'Misc.md',
    onCommit: () => ({ ok: true }),
    onCancel: () => (cancelled += 1),
  })
  h.input.dispatch('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} })
  assert.equal(cancelled, 1)
  assert.equal(editRow(m), null)
  assert.deepEqual(
    shownRows(m).map((r) => r.textContent),
    ['Projects', 'a', '2026', 'Misc', 'Zed']
  )
  m.tree.destroy()
})

test('beginCreate() opens a field in a RESERVED row under the parent', async () => {
  const m = mountOpen()
  const made = []
  const h = m.tree.beginCreate('Projects', {
    initial: 'Untitled',
    suffix: '.md',
    onCommit(name) {
      made.push(name)
      return { ok: true }
    },
  })
  assert.ok(h)
  assert.equal(h.input.parentNode, editRow(m))
  // 'all', not 'stem': there is no extension in the field for a new note — the
  // suffix is appended at commit.
  assert.deepEqual([h.input.selectionStart, h.input.selectionEnd], [0, 'Untitled'.length])
  h.input.value = 'Plan'
  h.input.dispatch('keydown', { key: 'Enter', preventDefault() {}, stopPropagation() {} })
  await new Promise((r) => setTimeout(r, 0))
  assert.deepEqual(made, ['Plan.md'], 'the suffix is applied by the shared editor')
  assert.equal(m.tree.debug.reservedAt(), -1)
  assert.equal(m.sizer.style.height, 5 * 27 + 'px')
  m.tree.destroy()
})

test('keystrokes in the field do NOT reach the tree: no type-ahead, no cursor move', () => {
  const m = mountOpen()
  m.scroller.dispatch('keydown', key('Home'))          // cursor on row 0
  assert.equal(m.tree.cursorPath(), 'Projects')
  const h = m.tree.beginRename('Misc.md', { initial: 'Misc.md', onCommit: () => ({ ok: true }) })
  const inField = (k) =>
    m.scroller.dispatch('keydown', key(k, { target: h.input }))
  // The field is INSIDE the scroller, so every one of these bubbles to the
  // tree's delegated handler.  'z' would type-ahead onto Zed; ArrowDown would
  // walk the cursor out from under the row being renamed.
  inField('z')
  inField('ArrowDown')
  inField('End')
  assert.equal(m.tree.cursorPath(), 'Projects', 'a keystroke in the field moved the tree cursor')
  m.tree.destroy()
})

test('a click inside the field is not a click on a row', () => {
  const m = mountOpen()
  m.scroller.dispatch('keydown', key('Home'))
  const h = m.tree.beginRename('Misc.md', { initial: 'Misc.md', onCommit: () => ({ ok: true }) })
  m.scroller.dispatch('click', { target: h.input })
  assert.equal(m.tree.cursorPath(), 'Projects', 'clicking the field dropped the tree cursor')
  assert.deepEqual(m.calls.open, [], 'clicking the field opened a note')
  m.tree.destroy()
})

test('a snapshot during a rename re-resolves the host BY PATH, and drops it if the row is gone', () => {
  const m = mountOpen()
  const h = m.tree.beginRename('Misc.md', { initial: 'Misc.md', onCommit: () => ({ ok: true }) })
  assert.equal(yOf(m.tree.debug.editHost()), 3 * 27)
  // A watcher refresh adds a folder ABOVE Misc: its node index and its row both
  // move, and the host must move with them.  (Node indices mean nothing across
  // a snapshot — that is what invalidatePool() exists for.)
  m.tree.applySnapshot(
    buildBlob([dir('Aaa', []), dir('Projects', [file('a'), dir('2026', [file('deep')])]), file('Misc'), file('Zed')])
  )
  assert.equal(m.tree.debug.editingPath(), 'Misc.md')
  assert.equal(yOf(m.tree.debug.editHost()), 4 * 27, 'the host did not follow its row')
  assert.equal(h.closed, false)
  // Now delete the row out from under it: the editor goes rather than pointing
  // at whatever else now holds that index.
  m.tree.applySnapshot(buildBlob([dir('Aaa', []), file('Zed')]))
  assert.equal(m.tree.debug.editHost(), null)
  assert.equal(m.tree.debug.editingPath(), null)
  m.tree.destroy()
})

test('releaseRowHost() is idempotent, and destroy() takes the host with it', () => {
  const m = mountOpen()
  m.tree.releaseRowHost()                       // nothing open: a no-op
  m.tree.beginRename('Misc.md', { initial: 'Misc.md', onCommit: () => ({ ok: true }) })
  m.tree.releaseRowHost()
  m.tree.releaseRowHost()
  assert.equal(editRow(m), null)
  m.tree.beginCreate('', { initial: 'Untitled', suffix: '.md', onCommit: () => ({ ok: true }) })
  m.tree.destroy()
  assert.equal(rowsOf(m).length, 0, 'destroy() left the inline-edit host in the sizer')
})

test('§5.12.6(c) a reserved row is NOT a pooled row: the pool does not grow', () => {
  const m = mountOpen()
  const before = m.tree.debug.poolSize()
  m.tree.beginCreate('Projects', { initial: 'Untitled', suffix: '.md', onCommit: () => ({ ok: true }) })
  assert.equal(m.tree.debug.poolSize(), before)
  // A scroll with the reserved row open still creates nothing.
  m.scroller.scrollTop = 27
  m.tree.debug.onScroll()
  assert.equal(m.tree.debug.poolSize(), before)
  assert.equal(rowsOf(m).length, before + 1, 'the host is the only extra element')
  m.tree.destroy()
})

test('the tree still validates names through the ONE shared filter (inline-edit.ts)', () => {
  // Placement is this file's half; the rules are inline-edit.ts's, and there is
  // exactly one copy of them.  Asserted through the module the tree imports.
  assert.equal(I.validateName('My Notes.md').ok, true)
  assert.equal(I.validateName('a/b.md').ok, false)
  assert.equal(I.validateName('NUL.md').ok, false)
  assert.equal(I.sanitizeNameInput('My: Notes'), 'My Notes')
})

test('collapsing a folder while an editor is open keeps the host ON its row', () => {
  const m = mountOpen()          // Projects(0) a(1) 2026(2) Misc(3) Zed(4)
  const h = m.tree.rowHost('Misc.md')
  assert.equal(yOf(h), 3 * 27)
  // Collapse Projects from the keyboard: `a` and `2026` go, Misc moves to row 1.
  m.scroller.dispatch('keydown', key('Home'))
  m.scroller.dispatch('keydown', key('ArrowLeft'))
  assert.equal(m.tree.debug.visibleCount(), 3)
  assert.equal(yOf(m.tree.debug.editHost()), 1 * 27, 'the host was left on the old row')
  m.tree.destroy()
})

/* ══ the fixed Memoir tab's sidebar hiding (user feature, 2026-09-15) ══════
 * Vault-root `Memoir.md` is shown ONLY in the tab strip's fixed second tab and
 * never as a sidebar row.  The hiding is frontend-only — one byte per node,
 * set in `restore()` (which already decodes every file's name) and honoured in
 * `flatten()` — root-level only, and it leaves the blob, and therefore search
 * hits and `[[Memoir]]` links, intact. */

test('Memoir.md at the vault root draws no row; a nested namesake still does', () => {
  const spec = [file('Memoir'), file('top'), dir('notes', [file('Memoir')])]
  const m = mount(842)
  m.tree.applySnapshot(buildBlob(spec))
  // Root Memoir.md hidden; `top` and collapsed `notes` visible.
  assert.equal(m.tree.debug.visibleCount(), 2)
  m.tree.setExpanded(['notes'])
  m.tree.applySnapshot(buildBlob(spec))
  // `top`, `notes`, `notes/Memoir` — and the one Memoir row is the NESTED one.
  assert.equal(m.tree.debug.visibleCount(), 3)
  const memoirs = shownRows(m).filter((r) => r.textContent === 'Memoir')
  assert.equal(memoirs.length, 1, 'the root Memoir.md drew a row, or the nested one lost its')
  assert.equal(memoirs[0].getAttribute('data-d'), '1')
  m.tree.destroy()
})

test('a vault holding only Memoir.md reads as empty (but still resolves it)', () => {
  const m = mount(842)
  m.tree.applySnapshot(buildBlob([file('Memoir')]))
  assert.equal(m.tree.debug.visibleCount(), 0)
  m.tree.destroy()
  // Hiding is tree-only: the blob still carries the note, so search still
  // finds it and `[[Memoir]]` still opens it — in the Memoir tab.
  const b = B.adopt(buildBlob([file('Memoir'), file('top')]))
  assert.equal(b.resolveLink('Memoir', null), 'Memoir.md')
  assert.equal(T.MEMOIR_PATH, 'Memoir.md')
})

/* ══ drag-to-move (Obsidian's file-explorer drop, transcribed) ══════════════
 * app.js `attachDropHandler` + `SA` + `xA`, 1.13.7. Pure helpers on `debug`,
 * bound to the live blob — no DataTransfer, no ghost, no timer. The event
 * handlers are thin wrappers around these four; the engine test (fold-style)
 * would drive real DragEvents, but the validity model is what decides every
 * highlight and every move, so it is pinned here. */

function mountDragVault() {
  //   top.md
  //   A/
  //     a.md
  //     Sub/
  //       deep.md
  //   B/
  const spec = [file('top'), dir('A', [file('a'), dir('Sub', [file('deep')])]), dir('B')]
  const m = mount(842)
  m.tree.applySnapshot(buildBlob(spec))
  m.tree.setExpanded(['A', 'A/Sub', 'B'])
  m.tree.applySnapshot(buildBlob(spec))
  return m
}

function nodeOf(m, path) {
  const blob = m.tree.blob()
  for (let i = 0; i < blob.n; i++) if (blob.pathOf(i) === path) return i
  return -1
}

test('drag: a folder resolves to itself, a file to its parent, empty space to root', () => {
  const m = mountDragVault()
  const d = m.tree.debug
  assert.equal(d.dropTargetFor(nodeOf(m, 'A')), 'A')
  assert.equal(d.dropTargetFor(nodeOf(m, 'A/a.md')), 'A')
  assert.equal(d.dropTargetFor(nodeOf(m, 'top.md')), '')
  assert.equal(d.dropTargetFor(nodeOf(m, 'A/Sub/deep.md')), 'A/Sub')
  assert.equal(d.dropTargetFor(-1), '')
  m.tree.destroy()
})

test('drag: SA — a folder cannot go into itself or a descendant, a file can go anywhere but home', () => {
  const m = mountDragVault()
  const d = m.tree.debug
  const folderA = { path: 'A', isDir: true }
  const fileA = { path: 'A/a.md', isDir: false }
  // Onto itself: refused.
  assert.equal(d.isValidDrop([folderA], 'A'), false)
  assert.equal(d.isValidDrop([fileA], 'A/a.md'), false)
  // Into a descendant: refused (the `path + "/"` prefix, not a string prefix —
  // `A` must not refuse `AB`).
  assert.equal(d.isValidDrop([folderA], 'A/Sub'), false)
  assert.equal(d.isValidDrop([folderA], 'A/Sub/deep.md') , false)
  assert.equal(d.isValidDrop([{ path: 'AB', isDir: true }], 'AB/CD'), false)
  // Already home: no highlight (Obsidian's `l.parent===e` — a no-op hover).
  assert.equal(d.isValidDrop([fileA], 'A'), false)
  assert.equal(d.isValidDrop([{ path: 'top.md', isDir: false }], ''), false)
  // Genuine moves: highlighted. (`A` to root is a no-op — it already lives
  // there — so the true root-ward folder move is `A/Sub` to root.)
  assert.equal(d.isValidDrop([fileA], ''), true)
  assert.equal(d.isValidDrop([fileA], 'B'), true)
  assert.equal(d.isValidDrop([folderA], 'B'), true)
  assert.equal(d.isValidDrop([folderA], ''), false)
  assert.equal(d.isValidDrop([{ path: 'A/Sub', isDir: true }], ''), true)
  m.tree.destroy()
})

test('drag: a folder swallows its selected descendants (xA)', () => {
  const m = mountDragVault()
  const d = m.tree.debug
  const entries = [
    { path: 'A', isDir: true },
    { path: 'A/a.md', isDir: false },
    { path: 'A/Sub', isDir: true },
    { path: 'A/Sub/deep.md', isDir: false },
    { path: 'B', isDir: true },
  ]
  assert.deepEqual(d.filterTopLevel(entries), [
    { path: 'A', isDir: true },
    { path: 'B', isDir: true },
  ])
  m.tree.destroy()
})

test('drag: the drag set is the whole selection when the row is in it, else the single row', () => {
  const m = mountDragVault()
  const d = m.tree.debug
  // No selection: single row, even for a folder (descendants are not sources —
  // the move carries the subtree, `xA` has nothing to filter on one entry).
  assert.deepEqual(d.dragSetFor(nodeOf(m, 'A')), [{ path: 'A', isDir: true }])
  assert.deepEqual(d.dragSetFor(nodeOf(m, 'A/a.md')), [{ path: 'A/a.md', isDir: false }])
  m.tree.destroy()
})

test('drag: the native image is Obsidian\'s 1x1 transparent GIF, never a 0-area node', () => {
  // User report: a globe flying from the source row to the cursor on every
  // drag. `setDragImage` on a 0x0 div is IGNORED by Chromium (zero area = no
  // image), so the engine fell back to its default feedback — the source
  // row's snapshot flying to the cursor. Obsidian's `NO(e)` sets a 1x1
  // transparent GIF (`LO`, app.js 1.13.7), which has area and is honoured.
  // Driven through a real `dragstart` with a fake DataTransfer: the shim has
  // no DnD, but the handler only reads `target`/`dataTransfer`, both faked.
  const m = mountDragVault()
  const row = shownRows(m).find((r) => r.textContent === 'a')
  assert.ok(row, 'expected a painted row for A/a.md')
  const seen = {}
  m.scroller.dispatch('dragstart', {
    target: row,
    clientX: 10,
    clientY: 10,
    preventDefault() {},
    dataTransfer: {
      effectAllowed: '',
      setData(k, v) { seen[k] = String(v) },
      setDragImage(el, x, y) { seen.image = el; seen.x = x; seen.y = y },
    },
  })
  assert.ok(seen.image, 'dragstart never called setDragImage')
  assert.equal(seen.image.tagName, 'IMG',
    'the drag image must be an <img> — a 0-area div is ignored and the default feedback flies instead')
  assert.match(seen.image.getAttribute('src') ?? '', /^data:image\/gif;base64,R0lGODlhAQABAIAAAAUEBAAAACwAAAAAAQABAAACAkQBADs=$/,
    'the drag image must be the 1x1 transparent GIF, byte for byte')
  assert.ok(!((seen.image.getAttribute('style') ?? '').includes('width:0')),
    'a zero-area style is what Chromium ignores — it must never come back')
  m.tree.destroy()
})

/* ═══════════════════════════════════════════════════════════════════════════
 *  A NOTE'S EXTENSION CASE.  `Foo.MD` is a note (Obsidian lowercases the
 *  extension before comparing it), `names` carries only the stem, and `kind`
 *  bits 1..2 carry the case (tree.rs `md_ext_case`: bit 1 = `M`, bit 2 = `D`).
 *  Every row must address ITS OWN on-disk file: rebuilt as `Foo.md`, it named
 *  nothing, or — beside a real `Foo.md` on a case-sensitive disk — the sibling.
 * ═════════════════════════════════════════════════════════════════════════ */

const EXT_M = 1 << 1
const EXT_D = 1 << 2

/** Set node `i`'s `kind` byte in a built blob: the array sits at 36 + 13N. */
function withKind(buf, i, k) {
  const n = new DataView(buf).getUint32(8, true)
  new Uint8Array(buf)[36 + 13 * n + i] = k
  return buf
}

test('extension case: pathOf rebuilds each note\'s on-disk name, and kind bits 1..2 are a file\'s only', () => {
  const buf = buildBlob([dir('Sub', [file('inner')]), file('Dup'), file('Dup'), file('Foo'), file('x')])
  withKind(buf, 1, EXT_D)
  withKind(buf, 3, EXT_M | EXT_D)
  withKind(buf, 4, EXT_M | EXT_D)
  withKind(buf, 5, EXT_M)
  const b = B.adopt(buf)
  const paths = Array.from({ length: b.n }, (_, i) => b.pathOf(i))
  assert.deepEqual(paths, ['Sub', 'Sub/inner.mD', 'Dup.md', 'Dup.MD', 'Foo.MD', 'x.Md'])
  assert.equal(b.nameOf(4), 'Foo', 'the display name carries no extension, whatever its case')
  assert.equal(b.isDir(4), false)
  // A wikilink reaches the note that exists, not a lowercase spelling of it.
  assert.equal(b.resolveLink('Foo', null), 'Foo.MD')
  assert.equal(b.resolveLink('Sub/inner', null), 'Sub/inner.mD')

  B.adopt(withKind(buildBlob([file('a')]), 0, EXT_M | EXT_D)) // accepted
  assert.throws(() => B.adopt(withKind(buildBlob([file('a')]), 0, 0x08)), /reserved bit/)
  assert.throws(() => B.adopt(withKind(buildBlob([dir('d')]), 0, 1 | EXT_M)), /reserved bit/,
    'a folder has no extension; bits 1..2 on one are corruption')
  assert.throws(() => B.adopt(withKind(buildBlob([dir('d')]), 0, 1 | EXT_D)), /reserved bit/)
})

test('extension case: open, Delete, F2 and the row menu all carry the row\'s exact path', () => {
  const seen = []
  const m = mount(842, {
    onContextMenu: (_ev, path) => seen.push(['menu', path]),
    onRenameRequest: (path) => seen.push(['rename', path]),
    onDeleteRequest: (path) => seen.push(['delete', path]),
  })
  // Two rows both drawn `Dup` — Linux holds `Dup.md` and `Dup.MD` side by side.
  const buf = buildBlob([file('Dup'), file('Dup'), file('Foo')])
  withKind(buf, 1, EXT_M | EXT_D)
  withKind(buf, 2, EXT_M | EXT_D)
  m.tree.applySnapshot(buf)
  const rowAt = (v) => rowsOf(m)[v % m.tree.debug.poolSize()]
  assert.deepEqual([0, 1, 2].map((v) => rowAt(v).textContent), ['Dup', 'Dup', 'Foo'])

  m.scroller.dispatch('click', { target: rowAt(1) })
  assert.deepEqual(m.calls.open, ['Dup.MD'], 'the second row opened its lowercase sibling')
  m.scroller.dispatch('keydown', key('Delete'))
  m.scroller.dispatch('keydown', key('F2'))
  m.scroller.dispatch('contextmenu', { target: rowAt(1), preventDefault() {} })
  assert.deepEqual(seen, [['delete', 'Dup.MD'], ['rename', 'Dup.MD'], ['menu', 'Dup.MD']],
    'an operation from the Dup.MD row would act on Dup.md, a different file')
  m.scroller.dispatch('click', { target: rowAt(0) })
  m.scroller.dispatch('click', { target: rowAt(2) })
  assert.deepEqual(m.calls.open, ['Dup.MD', 'Dup.md', 'Foo.MD'])
  m.tree.destroy()
})

test('extension case: an open Foo.MD is the active row and a refresh does not detach it', () => {
  const m = mount(842)
  const mk = () => withKind(buildBlob([file('Foo'), file('Other')]), 0, EXT_M | EXT_D)
  const rowFor = (t) => shownRows(m).find((r) => r.textContent === t)
  m.tree.applySnapshot(mk())
  // A search hit and state.json's lastNote hand over the real rel.
  m.tree.setActivePath('Foo.MD')
  assert.equal(rowFor('Foo').className, 'tr a')
  m.tree.applySnapshot(mk())
  assert.deepEqual(m.calls.vanished, [], 'a refresh called onActiveVanished, which detaches the editor')
  assert.equal(rowFor('Foo').className, 'tr a')
  // …and the lowercase spelling is NOT that note.
  m.tree.setActivePath('Foo.md')
  m.tree.applySnapshot(mk())
  assert.deepEqual(m.calls.vanished, ['Foo.md'])
  m.tree.destroy()
})

test('extension case: only a root Memoir.md is hidden; a root Memoir.MD is an ordinary row', () => {
  const m = mount(842)
  m.tree.applySnapshot(withKind(buildBlob([file('Memoir'), file('a')]), 0, EXT_M | EXT_D))
  assert.deepEqual(shownRows(m).map((r) => r.textContent), ['Memoir', 'a'])
  m.tree.applySnapshot(buildBlob([file('Memoir'), file('a')]))
  assert.deepEqual(shownRows(m).map((r) => r.textContent), ['a'])
  m.tree.destroy()
})

test('extension case: a selection holding Foo.MD survives a refresh', () => {
  const m = mount(842)
  const mk = () => withKind(buildBlob([file('a'), file('Foo'), file('z')]), 1, EXT_M | EXT_D)
  const rowFor = (t) => shownRows(m).find((r) => r.textContent === t)
  m.tree.applySnapshot(mk())
  m.scroller.dispatch('click', { target: rowFor('a') })
  m.scroller.dispatch('click', { target: rowFor('z'), shiftKey: true })
  const want = ['a.md', 'Foo.MD', 'z.md']
  assert.deepEqual(m.tree.getSelection().map((s) => s.path), want)
  m.tree.applySnapshot(mk())
  assert.deepEqual(m.tree.getSelection().map((s) => s.path), want)
  assert.equal(rowFor('Foo').className, 'tr s')
  m.tree.destroy()
})

/* ═══════════════════════════════════════════════════════════════════════════
 *  A LARGE SHIFT-SELECTION.  It persists across refreshes until a plain click
 *  or Escape, so every watcher refresh and every dragover pays for it: both
 *  must be linear in the vault, not in vault × selection.
 * ═════════════════════════════════════════════════════════════════════════ */

/** Shift-select every row of a flat vault: plain-click the first, scroll to
 *  the end, shift-click the last. */
function selectAllFlat(m, n) {
  const first = shownRows(m).find((r) => r.textContent === 'note-00000')
  m.scroller.dispatch('click', { target: first })
  m.scroller.scrollTop = n * m.tree.debug.rowPitch() - m.tree.debug.clientHeight()
  m.tree.debug.onScroll()
  const lastName = 'note-' + String(n - 1).padStart(5, '0')
  const last = shownRows(m).find((r) => r.textContent === lastName)
  assert.ok(last, 'the last row is not painted')
  m.scroller.dispatch('click', { target: last, shiftKey: true })
}

test('a refresh with 20,000 rows shift-selected costs about what one without does', () => {
  const N = 20000
  const spec = flatVault(N)
  const m = mount(842)
  m.tree.applySnapshot(buildBlob(spec))
  const time = () => {
    const buf = buildBlob(spec)
    const t0 = performance.now()
    m.tree.applySnapshot(buf)
    return performance.now() - t0
  }
  const median3 = () => [time(), time(), time()].sort((a, b) => a - b)[1]
  const bare = median3()
  selectAllFlat(m, N)
  assert.equal(m.tree.getSelection().length, N)
  const withSel = median3()
  // Measured: ~4,000 ms against ~2 ms when the selection was scanned per file.
  assert.ok(withSel < bare * 10 + 50,
    `a refresh with ${N} selected took ${withSel.toFixed(1)} ms against ${bare.toFixed(1)} ms bare`)
  assert.equal(m.tree.getSelection().length, N, 'the selection did not survive the refresh')
  m.tree.destroy()
})

test('dragover re-uses the drag set resolved at dragstart; it does not walk the blob', () => {
  const N = 5000
  const m = mount(842)
  m.tree.applySnapshot(buildBlob(flatVault(N)))
  selectAllFlat(m, N)
  const last = shownRows(m).find((r) => r.textContent === 'note-' + String(N - 1).padStart(5, '0'))
  m.scroller.dispatch('dragstart', {
    target: last, clientX: 10, clientY: 10, preventDefault() {},
    dataTransfer: { effectAllowed: '', setData() {}, setDragImage() {} },
  })
  const proto = B.TreeBlob.prototype
  const orig = proto.pathOf
  let n = 0
  proto.pathOf = function (i) { n++; return orig.call(this, i) }
  try {
    for (let k = 0; k < 5; k++) {
      m.scroller.dispatch('dragover', {
        target: m.scroller, clientX: 10, clientY: 10 + k, preventDefault() {},
        dataTransfer: { dropEffect: '' },
      })
    }
  } finally {
    proto.pathOf = orig
  }
  assert.ok(n <= 10, `five dragovers made ${n} pathOf calls`)
  m.tree.destroy()
})

test('drop hands onMoveRequest the top-level set resolved at dragstart', () => {
  // Guards the cached drag set: the same request the per-event walk produced.
  const moves = []
  const m = mount(842, { onMoveRequest: (req, dest) => moves.push([req, dest]) })
  const spec = [file('top'), dir('A', [file('a')]), dir('B')]
  m.tree.applySnapshot(buildBlob(spec))
  m.tree.setExpanded(['A'])
  const rowFor = (t) => shownRows(m).find((r) => r.textContent === t)
  m.scroller.dispatch('click', { target: rowFor('top') })
  m.scroller.dispatch('click', { target: rowFor('a'), shiftKey: true })
  assert.deepEqual(m.tree.getSelection().map((s) => s.path), ['top.md', 'A', 'A/a.md'])
  m.scroller.dispatch('dragstart', {
    target: rowFor('top'), clientX: 10, clientY: 10, preventDefault() {},
    dataTransfer: { effectAllowed: '', setData() {}, setDragImage() {} },
  })
  const over = { target: rowFor('B'), clientX: 10, clientY: 90, preventDefault() {}, dataTransfer: { dropEffect: '' } }
  m.scroller.dispatch('dragover', over)
  m.scroller.dispatch('drop', over)
  assert.deepEqual(moves, [[[{ path: 'top.md', isDir: false }, { path: 'A', isDir: true }], 'B']])
  m.tree.destroy()
})

test('filterTopLevel drops only entries under a dragged folder, at a / boundary', () => {
  const m = mount(842)
  m.tree.applySnapshot(buildBlob([file('x')]))
  const e = (path, isDir = false) => ({ path, isDir })
  const got = m.tree.debug.filterTopLevel([
    e('a', true), e('a/x.md'), e('a/b', true), e('a/b/y.md'), e('c.md'), e('ab.md'), e('ab/z.md'),
  ])
  assert.deepEqual(got.map((x) => x.path), ['a', 'c.md', 'ab.md', 'ab/z.md'])
  m.tree.destroy()
})

/* ═══════════════════════════════════════════════════════════════════════════
 *  THE PERSIST TIMERS AS A CONTROLLER SEAM.  A vault switch and a quit flush
 *  them into state.ts's queue first (main.ts), and a stale one must never fire
 *  after the expansion set was replaced.
 * ═════════════════════════════════════════════════════════════════════════ */

test('flushPersist fires the pending expansion and scroll persists synchronously, once', () => {
  const m = mount(842)
  m.tree.applySnapshot(buildBlob([dir('P', [file('x')]), dir('Q', [file('y')])]))
  const rowFor = (t) => shownRows(m).find((r) => r.textContent === t)
  m.scroller.dispatch('click', { target: rowFor('P') })
  assert.deepEqual(m.calls.expanded, [])
  m.tree.flushPersist()
  assert.deepEqual(m.calls.expanded, [['P']])
  assert.equal(m.calls.scrollTop.length, 1, 'the scroll persist armed by the repaint was not flushed')
  m.tree.flushPersist()
  assert.equal(m.calls.expanded.length, 1, 'nothing was pending, so nothing fires')
  assert.equal(m.calls.scrollTop.length, 1)
  m.tree.destroy()
})

test('cancelPersist and setExpanded drop a pending expansion persist; it never fires later', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const m = mount(842)
  m.tree.applySnapshot(buildBlob([dir('P', [file('x')]), dir('Q', [file('y')])]))
  const rowFor = (t) => shownRows(m).find((r) => r.textContent === t)
  m.scroller.dispatch('click', { target: rowFor('P') })
  m.tree.cancelPersist()
  t.mock.timers.tick(1100)
  assert.deepEqual(m.calls.expanded, [])
  // The vault-switch shape: a toggle, then the set replaced wholesale.  The
  // timer read the set when it fired, so it used to persist the new `[]`.
  m.scroller.dispatch('click', { target: rowFor('Q') })
  m.tree.setExpanded([])
  t.mock.timers.tick(1100)
  assert.deepEqual(m.calls.expanded, [], 'a stale persist fired after the set was replaced')
  // An ordinary toggle still persists after the debounce.
  m.scroller.dispatch('click', { target: rowFor('P') })
  t.mock.timers.tick(1100)
  assert.deepEqual(m.calls.expanded, [['P']])
  m.tree.destroy()
})
