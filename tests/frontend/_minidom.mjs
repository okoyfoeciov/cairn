// Owner: 05.  A HELPER, NOT A TEST — the filename has no `.test.` segment, so
// `node --test tests/frontend/` does not pick it up.
//
// The smallest DOM that `src/search.ts` actually uses.  There is no jsdom in
// this project's dependency set (esbuild + typescript only, CONTRACT §6.3), and
// adding one to run a test would be a new npm dependency in a codebase whose
// whole premise is that dependencies are weighed.  This is ~200 lines instead.
//
// It supports exactly what SearchPanel touches and nothing else: element
// creation, append/remove/after/insertBefore, textContent, classList, dataset
// (backed by real attributes, so `[data-rel="…"]` selectors work), `hidden`,
// one-level-deep event dispatch with `closest()`-style targets, and a selector
// engine that understands compound `.class` / `[attr="v"]` selectors and comma
// lists.  Anything else is deliberately absent so a test cannot silently start
// depending on browser behaviour this file made up.

class ANode {
  constructor(doc) { this.ownerDocument = doc; this.parentNode = null; this.childNodes = [] }
  get parentElement() { return this.parentNode instanceof AElement ? this.parentNode : null }
  get nextSibling() {
    const p = this.parentNode
    if (!p) return null
    const i = p.childNodes.indexOf(this)
    return p.childNodes[i + 1] ?? null
  }
  get nextElementSibling() {
    const p = this.parentNode
    if (!p) return null
    let i = p.childNodes.indexOf(this) + 1
    for (; i < p.childNodes.length; i += 1) if (p.childNodes[i] instanceof AElement) return p.childNodes[i]
    return null
  }
  remove() {
    const p = this.parentNode
    if (!p) return
    const i = p.childNodes.indexOf(this)
    if (i >= 0) p.childNodes.splice(i, 1)
    this.parentNode = null
  }
}

class AText extends ANode {
  constructor(doc, data) { super(doc); this.data = String(data) }
  get textContent() { return this.data }
}

class AFragment extends ANode {
  append(...kids) { for (const k of kids) adopt(this, k) }
}

function adopt(parent, kid) {
  if (typeof kid === 'string') kid = new AText(parent.ownerDocument, kid)
  if (kid instanceof AFragment) { for (const k of [...kid.childNodes]) adopt(parent, k); return }
  kid.remove()
  kid.parentNode = parent
  parent.childNodes.push(kid)
}

class ClassList {
  constructor(el) { this.el = el }
  get set() { return new Set(String(this.el.className).split(/\s+/).filter(Boolean)) }
  write(s) { this.el.className = [...s].join(' ') }
  add(...n) { const s = this.set; for (const x of n) s.add(x); this.write(s) }
  remove(...n) { const s = this.set; for (const x of n) s.delete(x); this.write(s) }
  contains(n) { return this.set.has(n) }
  toggle(n, force) {
    const s = this.set
    const want = force === undefined ? !s.has(n) : !!force
    if (want) s.add(n); else s.delete(n)
    this.write(s)
    return want
  }
}

class AElement extends ANode {
  constructor(doc, tag) {
    super(doc)
    this.tagName = tag.toUpperCase()
    this.attrs = new Map()
    this.className = ''
    this.listeners = new Map()
    this.scrollTop = 0
    this.value = ''
    this.dataset = new Proxy({}, {
      get: (_t, k) => this.attrs.get(`data-${kebab(String(k))}`),
      set: (_t, k, v) => { this.attrs.set(`data-${kebab(String(k))}`, String(v)); return true },
      has: (_t, k) => this.attrs.has(`data-${kebab(String(k))}`),
    })
  }
  get hidden() { return this.attrs.get('hidden') === '' }
  set hidden(v) { if (v) this.attrs.set('hidden', ''); else this.attrs.delete('hidden') }
  get title() { return this.attrs.get('title') ?? '' }
  set title(v) { this.attrs.set('title', String(v)) }
  get classList() { return new ClassList(this) }
  setAttribute(k, v) { this.attrs.set(k, String(v)) }
  getAttribute(k) { return this.attrs.get(k) ?? null }
  append(...kids) { for (const k of kids) adopt(this, k) }
  insertBefore(node, ref) {
    if (!ref) { adopt(this, node); return node }
    node.remove()
    const i = this.childNodes.indexOf(ref)
    node.parentNode = this
    this.childNodes.splice(i < 0 ? this.childNodes.length : i, 0, node)
    return node
  }
  after(node) { this.parentNode?.insertBefore(node, this.nextSibling) }
  get textContent() { return this.childNodes.map((c) => c.textContent).join('') }
  set textContent(v) {
    for (const c of this.childNodes) c.parentNode = null
    this.childNodes = []
    if (v !== '') adopt(this, String(v))
  }
  get children() { return this.childNodes.filter((c) => c instanceof AElement) }
  descendants() {
    const out = []
    const walk = (n) => { for (const c of n.childNodes) if (c instanceof AElement) { out.push(c); walk(c) } }
    walk(this)
    return out
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null }
  querySelectorAll(sel) { return this.descendants().filter((e) => matches(e, sel)) }
  closest(sel) {
    let n = this
    while (n instanceof AElement) { if (matches(n, sel)) return n; n = n.parentNode }
    return null
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type).push(fn)
  }
  dispatch(type, ev) {
    for (const fn of this.listeners.get(type) ?? []) fn(ev)
  }
  focus() { this.ownerDocument.activeElement = this }
  select() {}
  scrollIntoView() {}
  getBoundingClientRect() { return { left: 0, top: 0, right: 409, bottom: 27, width: 409, height: 27 } }
}

function kebab(s) { return s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`) }

/** `.a.b`, `[k="v"]`, `.a[k="v"]`, and comma lists of those.  No tags, no
 *  combinators — the panel uses none. */
function matches(el, sel) {
  return sel.split(',').some((one) => {
    const s = one.trim()
    if (!s) return false
    const parts = s.match(/\.[A-Za-z0-9_-]+|\[[^\]]+\]/g)
    if (!parts) return false
    return parts.every((p) => {
      if (p.startsWith('.')) return el.classList.contains(p.slice(1))
      const m = /^\[([^=\]]+)(?:=("?)(.*?)\2)?\]$/.exec(p)
      if (!m) return false
      if (m[3] === undefined) return el.attrs.has(m[1])
      return el.attrs.get(m[1]) === m[3].replace(/\\(.)/g, '$1')
    })
  })
}

/** The tokens `src/search.ts` reads once at mount.  A test fixture MAY state
 *  these values: it is standing in for `tokens.css`, which is the one file
 *  allowed to declare them (CONTRACT §5.1, §5.2).  If tokens.css ever moves
 *  them, this fixture is the thing that should be updated with it. */
const ROOT_TOKENS = { '--cx0': '15px', '--chev-w': '16px', '--row-h': '27px' }

class ADocument {
  constructor() {
    this.activeElement = null
    this.documentElement = new AElement(this, 'html')
    this.defaultView = {
      getComputedStyle: (el) => ({
        getPropertyValue: (k) => (el === this.documentElement ? (ROOT_TOKENS[k] ?? '') : ''),
      }),
    }
  }
  createElement(tag) { return new AElement(this, tag) }
  // §0.50 E98: tree.ts builds the row chevron with createElementNS; the shim is namespace-blind.
  createElementNS(_ns, tag) { return new AElement(this, tag) }
  createTextNode(t) { return new AText(this, t) }
  createDocumentFragment() { return new AFragment(this) }
}

/** Install the two globals `src/search.ts` uses in `instanceof` guards, plus the
 *  event shapes it constructs tests around.  Without these, `e instanceof
 *  MouseEvent` is a ReferenceError in node. */
export function installGlobals() {
  globalThis.Element = AElement
  globalThis.MouseEvent = class MouseEvent { constructor(t, i = {}) { Object.assign(this, i); this.type = t } }
  globalThis.KeyboardEvent = class KeyboardEvent {
    constructor(t, i = {}) { Object.assign(this, i); this.type = t; this.defaultPrevented = false }
    preventDefault() { this.defaultPrevented = true }
  }
}

/** A `.sidebar` containing the banner slot and the live `.tree-scroller`, i.e.
 *  the shape `src/index.html` ships.  §0.12 E14 deleted the `.nav-toolbar` this
 *  used to prepend: a fixture that still built one would be asserting a sidebar
 *  the app no longer has, and every child-order assertion written against it
 *  would pass while describing nothing. */
export function makeSidebar() {
  const doc = new ADocument()
  const sidebar = doc.createElement('aside')
  sidebar.className = 'sidebar'
  const tree = doc.createElement('div'); tree.className = 'tree-scroller'
  sidebar.append(tree)
  return { doc, sidebar, tree }
}

export { AElement, AText, ADocument }
