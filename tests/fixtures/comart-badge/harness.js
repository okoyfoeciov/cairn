/*
 * tests/fixtures/comart-badge/harness.js -- the in-page half of
 * electron-shell/explain-badge.test.mjs, shared by both pages.
 *
 * Each page defines `window.mountCell(spec, k)` (its own host markup) before
 * loading this; everything else -- building the badges, waiting for Lora,
 * measuring, aligning, reading computed styles -- is this one file, so the
 * two pages cannot differ in anything but their stylesheet and host.
 */
'use strict'
;(function () {
  const R = window.CairnExplainRender
  const specs = window.badgeCells(R)
  const cells = new Map()
  specs.forEach((spec, k) => {
    const m = window.mountCell(spec, k)
    m.box.dataset.cell = spec.cell
    if (spec.kind === 'inline') {
      const p = document.createElement('p')
      const word = document.createElement('strong')
      word.textContent = spec.word
      // `**word [[PRON]]**`: the renderer puts the badge inside the <strong>.
      if (spec.inBold) word.append(spec.build())
      p.append(word, ...(spec.inBold ? [] : [spec.build()]), document.createTextNode(spec.gloss))
      m.inline.append(p)
    } else {
      m.row.append(spec.build())
    }
    cells.set(spec.cell, m)
  })

  const badgesOf = (cell) => [...cells.get(cell).box.querySelectorAll('.pron-badge')]
  const badge = ([, cell, i]) => badgesOf(cell)[i]
  const rect = (el) => { const r = el.getBoundingClientRect(); return [r.x, r.y, r.width, r.height] }
  const frames = () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)))

  /* font-display: swap paints the fallback first, so nothing is measured or
     captured until every Lora face the badges use has LOADED. */
  const LORA = ['400 13.95px "Lora"', 'italic 400 13.95px "Lora"', '600 13.95px "Lora"', '700 13.95px "Lora"']
  const loraFaces = () => [...document.fonts]
    .filter((f) => f.family.replace(/^"|"$/g, '') === 'Lora')
    .map((f) => f.style + ' ' + f.weight + ' ' + f.status)

  const PROPS = ['fontFamily', 'fontSize', 'lineHeight', 'fontWeight', 'fontStyle', 'fontStretch',
    'fontKerning', 'fontFeatureSettings', 'fontVariationSettings', 'fontOpticalSizing', 'fontSynthesis',
    'letterSpacing', 'wordSpacing', 'textTransform', 'textRendering', 'webkitFontSmoothing',
    'color', 'backgroundColor', 'opacity', 'boxShadow', 'display', 'alignItems', 'gap',
    'borderTopWidth', 'borderTopStyle', 'borderTopColor', 'borderTopLeftRadius',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'marginLeft', 'marginRight',
    'width', 'height', 'verticalAlign', 'fill', 'cursor']
  const styleOf = (el) => {
    const c = getComputedStyle(el)
    const o = { tag: el.tagName.toLowerCase(), cls: el.getAttribute('class') || '' }
    for (const p of PROPS) o[p] = c[p]
    // What moves, not how it is spelled: comart's children compute `all 0s`
    // and Cairn's base.css ban computes `none`; neither animates.
    o.transition = c.transitionDuration.split(',').every((d) => parseFloat(d) === 0)
      ? 'none'
      : [c.transitionProperty, c.transitionDuration, c.transitionTimingFunction].join(' / ')
    return o
  }

  window.H = {
    states: window.BADGE_STATES,
    ready: Promise.all(LORA.map((f) => document.fonts.load(f, 'ab')))
      .then(() => document.fonts.ready).then(frames).then(loraFaces),

    /** Every state's badge border box, CSS px. */
    rects: () => window.BADGE_STATES.map((s) => rect(badge(s))),

    /** The markup each cell's builder produced: must be the same in both pages. */
    dom: () => specs.map((s) => {
      const b = badgesOf(s.cell)
      const unit = b[0].closest('.pron-variants') || b[0]
      return [s.cell, unit.outerHTML]
    }),

    /** Computed style of every badge and of every element inside it. */
    computed: () => window.BADGE_STATES.map((s) => {
      const b = badge(s)
      return [styleOf(b), ...[...b.querySelectorAll('*')].map(styleOf)]
    }),

    /** Paints `c` behind every badge (the band's own background in Cairn). */
    setBackdrop: (c) => { for (const m of cells.values()) m.box.style.background = c; return frames() },
    backdrop: () => getComputedStyle(cells.values().next().value.box).backgroundColor,

    /** Moves each cell (through its own layout offset, never a transform) so
     *  its first badge lands exactly on `target`'s.  Layout snaps a length
     *  to its unit, so a quarter of one is added away from zero and the
     *  result is re-measured; the caller asserts the rects agree. */
    align: async (target, dpr) => {
      const eps = 1 / (256 * dpr)
      for (let pass = 0; pass < 4; pass++) {
        let worst = 0
        for (const [cell, m] of cells) {
          const i = window.BADGE_STATES.findIndex((s) => s[1] === cell)
          const [x, y] = rect(badge(window.BADGE_STATES[i]))
          const dx = target[i][0] - x
          const dy = target[i][1] - y
          worst = Math.max(worst, Math.abs(dx), Math.abs(dy))
          if (Math.abs(dx) < 1e-4 && Math.abs(dy) < 1e-4) continue
          const nx = (parseFloat(m.shift.style.left) || 0) + dx
          const ny = (parseFloat(m.shift.style.top) || 0) + dy
          m.shift.style.left = (nx + Math.sign(nx) * eps) + 'px'
          m.shift.style.top = (ny + Math.sign(ny) * eps) + 'px'
        }
        if (worst < 1e-4) break
      }
      await frames()
    },

    /** Cells whose scroller has something to scroll.  Must be none: a
     *  scrolling box gets its own scroll translation, which moves how the
     *  badge rasterises inside it (measured: +-1 levels on the right cap). */
    overflowing: () => [...cells].filter(([, m]) => m.scroller.scrollHeight > m.scroller.clientHeight ||
      m.scroller.scrollWidth > m.scroller.clientWidth).map(([cell]) => cell),

    /** A box declared 1.2px tall lays out on the grid of the scale Chromium
     *  is really rasterising at -- which `devicePixelRatio` alone cannot
     *  prove (pane-paint.test.mjs, assertRealScale). */
    grid: () => {
      const g = document.createElement('div')
      g.style.cssText = 'position:absolute;left:0;top:0;width:1px;height:1.2px;visibility:hidden'
      document.body.append(g)
      const h = g.getBoundingClientRect().height
      g.remove()
      return { dpr: window.devicePixelRatio, gridH: h }
    },
  }
})()
