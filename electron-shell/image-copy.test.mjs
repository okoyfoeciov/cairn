/**
 * electron-shell/image-copy.test.mjs -- §0.54 E107 in a REAL engine: right-click
 * a pasted image, the viewer menu offers ONE row, `Copy image`, and it puts the
 * IMAGE on the clipboard through command 27 (`copy_image`).
 *
 * THE RECEIPT IS A PASTE, THROUGH THE APP'S OWN PASTE HANDLER. After Copy the
 * test presses Ctrl/Cmd-V in the note and requires a second image run whose
 * decoded pixels equal the source's, pixel for pixel. A sentinel TEXT is put on
 * the clipboard first (command 23), so a Copy that never landed pastes the
 * sentinel instead of an image and fails loudly rather than passing on whatever
 * was there before.
 *
 * WHAT IT CANNOT SEE: the paste reads Electron's own clipboard. On Wayland an
 * offscreen window has no input serial, so neither this write nor the sentinel
 * reaches the desktop clipboard at all (measured: 0 `set_selection`); on X11 and
 * macOS both do. There the tests that write put the clipboard's prior TEXT back
 * at the end (commands 26/23) — only up to command 23's 4,096 characters, so
 * they SKIP rather than overwrite more text than they could restore. Non-text
 * content is not restored, and on X11 the restored text outlives the app only
 * if a clipboard manager takes it. Whether a real click's Copy reaches the
 * desktop is Electron's half, checked by hand.
 *
 * Hermetic: cdp-drive.mjs gives every launch a temp vault and its own
 * CAIRN_STATE_DIR, and kills only the PID it started.
 *
 * Run: node --test electron-shell/image-copy.test.mjs
 * (needs a display connection, `electron-shell/cairn.node` and the bundle)
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { deflateSync } from 'node:zlib'
import { launch, sleep, SKIP } from './cdp-drive.mjs'

/* ── a real PNG, every pixel distinct enough to catch a swizzle or a resize ── */

const CRC = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
const crc32 = (b) => {
  let c = 0xffffffff
  for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
/** Opaque RGB: an alpha channel would let premultiplication round the receipt. */
function patternPng(w, h) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    const o = y * (w * 3 + 1)
    for (let x = 0; x < w; x++) {
      raw[o + 1 + x * 3] = (x * 7) & 255
      raw[o + 2 + x * 3] = (y * 11) & 255
      raw[o + 3 + x * 3] = (x * y * 3 + 40) & 255
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ])
}

const PNG_URL = 'data:image/png;base64,' + patternPng(40, 30).toString('base64')
const PARA = 'Some words before the image, enough to select.'
const NOTE = `# Img\n\n${PARA}\n\n![pasted image](${PNG_URL})\n\nAfter.\n`
const SENTINEL = 'cairn-image-copy-sentinel'

/* ── page-side helpers, evaluated with cdp-drive's `V()` in scope ──────────── */

/** Every pasted-image run in the document, in order. */
const RUNS = `[...V().state.doc.toString().matchAll(/!\\[[^\\]\\n]*\\]\\((data:image\\/[^)\\n]+)\\)/g)].map((m) => m[1])`

/** Decode two image URLs through the engine and compare them pixel for pixel. */
const SAME_PIXELS = `(async (a, b) => {
  const px = (url) => new Promise((resolve, reject) => {
    const im = new Image()
    im.onload = () => {
      const c = document.createElement('canvas')
      c.width = im.naturalWidth; c.height = im.naturalHeight
      const g = c.getContext('2d')
      g.drawImage(im, 0, 0)
      resolve({ w: c.width, h: c.height, d: g.getImageData(0, 0, c.width, c.height).data })
    }
    im.onerror = () => reject(new Error('undecodable: ' + url.slice(0, 40)))
    im.src = url
  })
  const [p, q] = await Promise.all([px(a), px(b)])
  let diff = 0
  if (p.w === q.w && p.h === q.h) for (let i = 0; i < p.d.length; i++) diff = Math.max(diff, Math.abs(p.d[i] - q.d[i]))
  return { a: [p.w, p.h], b: [q.w, q.h], diff }
})`

/**
 * A point on the i-th rendered `.nc-img` ITSELF, once it has decoded. Not its
 * centre: the X is 22px square and covers most of a small image, so the first
 * of the four corners that hit-tests to the image is used.
 */
const IMAGE_POINT = `(im) => {
  const b = im.getBoundingClientRect()
  return [[b.x + 2, b.y + 2], [b.x + 2, b.bottom - 2], [b.right - 2, b.y + 2], [b.right - 2, b.bottom - 2]]
    .map(([x, y]) => ({ x, y }))
    .find((p) => document.elementFromPoint(p.x, p.y) === im) ?? null
}`

async function imageBody(app, i) {
  for (let n = 0; n < 50; n++) {
    const r = await app.evaluate(`(() => {
      const im = document.querySelectorAll('.nc-img')[${i}]
      if (!im || !im.complete || !im.naturalWidth) return null
      return { p: (${IMAGE_POINT})(im) }
    })()`)
    if (r) {
      assert.ok(r.p, `no corner of image ${i} is clear of the X`)
      return r.p
    }
    await sleep(50)
  }
  throw new Error(`image ${i} never rendered`)
}

/** The centre of the first image's X. */
const X_CENTRE = `(() => {
  const b = document.querySelector('.nc-img-x').getBoundingClientRect()
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
})()`

/** A TRUSTED right-click: CDP input, so `contextmenu` fires as a real one does. */
async function rclick(app, { x, y }) {
  await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
  await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1 })
  await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', buttons: 0, clickCount: 1 })
  await app.frames()
}

/** The open menu's labels and its row rects, or null when none is open. */
const MENU = `(() => {
  const m = document.querySelector('.ctx-menu')
  if (!m) return null
  return {
    label: m.getAttribute('aria-label'),
    clip: m.classList.contains('ctx-clip'),
    rows: [...m.querySelectorAll('.ctx-item')].map((r) => {
      const b = r.getBoundingClientRect()
      return { label: r.querySelector('.ctx-label').textContent, x: b.x + b.width / 2, y: b.y + b.height / 2 }
    }),
  }
})()`

async function invoke(app, command, args) {
  return app.evaluate(`window.cairn.invoke(${JSON.stringify(command)}, ${JSON.stringify(args ?? {})})`)
}

/** Ctrl/Cmd-V into the editor at the end of the document. */
async function pasteAtEnd(app) {
  await app.evaluate('(V().dispatch({ selection: { anchor: V().state.doc.length } }), V().focus(), 1)')
  const modifiers = process.platform === 'darwin' ? 4 : 2
  await app.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, nativeVirtualKeyCode: 86,
    modifiers, commands: ['paste'],
  })
  await app.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, nativeVirtualKeyCode: 86, modifiers,
  })
}

/** Poll until the document holds `n` image runs (the paste is async). */
async function runsWhen(app, n) {
  let runs = []
  for (let i = 0; i < 60; i++) {
    runs = await app.evaluate(RUNS)
    if (runs.length >= n) break
    await sleep(50)
  }
  return runs
}

/**
 * Right-click image `i`, require the one-row menu, click Copy, paste at the
 * end, and return the pasted run with the pixel comparison against `src`.
 */
async function copyAndPasteBack(app, i, src) {
  const sentinel = await invoke(app, 'copy_text', { text: SENTINEL })
  assert.equal(sentinel.ok, true, 'the sentinel could not be put on the clipboard')
  const before = await app.evaluate(RUNS)

  await rclick(app, await imageBody(app, i))
  const menu = await app.evaluate(MENU)
  assert.ok(menu, 'a right-click on a pasted image opened no menu')
  // The menu's own name, not only its rows: it is what tells the image menu
  // from the Copy/Paste menu whatever their rows read.
  assert.equal(menu.label, 'Image actions')
  assert.deepEqual(menu.rows.map((r) => r.label), ['Copy image'])
  assert.equal(menu.clip, true, 'the image menu is the viewer menu (ctx-clip)')

  const row = menu.rows[0]
  await app.click(row.x, row.y)
  await app.frames()
  assert.equal(await app.evaluate(MENU), null, 'activating Copy did not close the menu')

  // The copy is an IPC round trip; give it time before reading the clipboard.
  await sleep(200)
  await pasteAtEnd(app)
  const runs = await runsWhen(app, before.length + 1)
  const doc = await app.evaluate('V().state.doc.toString()')
  assert.equal(doc.includes(SENTINEL), false,
    'the paste brought back the sentinel text: Copy never put the image on the clipboard')
  assert.equal(runs.length, before.length + 1, `expected one pasted image, document holds ${runs.length} runs`)
  const pasted = runs[runs.length - 1]
  const cmp = await app.evaluate(`${SAME_PIXELS}(${JSON.stringify(src)}, ${JSON.stringify(pasted)})`)
  return { pasted, cmp }
}

async function withClipboardRestored(t, app, body) {
  const saved = await invoke(app, 'read_text')
  const text = saved && saved.ok && typeof saved.value === 'string' ? saved.value : ''
  if (text.length > 4096) {
    t.skip('the clipboard holds more text than command 23 could put back')
    return
  }
  try {
    await body()
  } finally {
    if (text) await invoke(app, 'copy_text', { text })
  }
}

test('a pasted image: right-click offers Copy image, and it puts the IMAGE on the clipboard', { skip: SKIP }, async (t) => {
  const app = await launch({ files: { 'Img.md': NOTE }, note: 'Img.md' })
  try {
    await withClipboardRestored(t, app, async () => {
      // A text selection exists, and the image still wins: its row copies the
      // image, not the selected words.
      const from = NOTE.indexOf(PARA)
      await app.evaluate(`(V().dispatch({ selection: { anchor: ${from}, head: ${from + 10} } }), 1)`)
      // The right-click itself moves nothing: no selection change, no reveal.
      await rclick(app, await imageBody(app, 0))
      assert.deepEqual(await app.evaluate('[V().state.selection.main.from, V().state.selection.main.to]'), [from, from + 10])
      assert.equal(await app.evaluate('V().state.doc.toString()'), NOTE)
      assert.equal(await app.evaluate("document.querySelectorAll('.nc-img').length"), 1, 'the source was revealed')
      await app.key('Escape', 27)
      const { pasted, cmp } = await copyAndPasteBack(app, 0, PNG_URL)
      assert.match(pasted, /^data:image\/png;base64,/)
      assert.deepEqual(cmp, { a: [40, 30], b: [40, 30], diff: 0 })
    })
  } finally {
    await app.close()
  }
})

test('a non-PNG image is redrawn as PNG and copies with the same pixels', { skip: SKIP }, async (t) => {
  const app = await launch({ files: { 'Img.md': NOTE }, note: 'Img.md' })
  try {
    await withClipboardRestored(t, app, async () => {
      // Built by the engine itself: WEBP and SVG are formats `nativeImage`
      // cannot decode (measured: `isEmpty()`), JPEG is one it can.
      const sources = await app.evaluate(`(() => {
        const c = document.createElement('canvas')
        c.width = 29; c.height = 17
        const g = c.getContext('2d')
        for (let y = 0; y < 17; y++) for (let x = 0; x < 29; x++) {
          g.fillStyle = 'rgb(' + ((x * 9) & 255) + ',' + ((y * 13) & 255) + ',' + ((x * y) & 255) + ')'
          g.fillRect(x, y, 1, 1)
        }
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="23" height="11">'
          + '<rect width="23" height="11" fill="#2a6"/><rect x="3" y="2" width="9" height="5" fill="#c33"/></svg>'
        return {
          webp: c.toDataURL('image/webp', 1),
          jpeg: c.toDataURL('image/jpeg', 0.92),
          svg: 'data:image/svg+xml;base64,' + btoa(svg),
        }
      })()`)
      assert.match(sources.webp, /^data:image\/webp;/, 'this engine cannot encode WEBP')
      // JPEG crosses as it is (Obsidian's path), so `nativeImage` in the main
      // process decodes it and the comparison decodes it in the page: two
      // decoders of the same lossy bytes, measured 1 apart at most. A redrawn
      // format is decoded once, here, and must match exactly.
      const tolerance = { webp: 0, jpeg: 1, svg: 0 }
      for (const [name, url] of Object.entries(sources)) {
        await app.evaluate(`(V().dispatch({ changes: { from: V().state.doc.length, insert: '\\n![pasted image](${url})\\n' } }), 1)`)
        await app.frames()
        const index = (await app.evaluate(RUNS)).length - 1
        const { pasted, cmp } = await copyAndPasteBack(app, index, url)
        assert.match(pasted, /^data:image\/png;base64,/, `${name}: the clipboard image is not a PNG`)
        assert.ok(cmp.diff <= tolerance[name], `${name}: ${JSON.stringify(cmp)}`)
        assert.deepEqual(cmp.a, cmp.b, `${name}: the size changed`)
      }
    })
  } finally {
    await app.close()
  }
})

test("a right press on the image's X opens the image menu and deletes nothing", { skip: SKIP }, async () => {
  const app = await launch({ files: { 'Img.md': NOTE }, note: 'Img.md' })
  try {
    await imageBody(app, 0)
    const x = await app.evaluate(X_CENTRE)
    await rclick(app, x)
    await sleep(100)
    assert.equal(await app.evaluate('V().state.doc.toString()'), NOTE,
      'a RIGHT press on the X deleted the image')
    const menu = await app.evaluate(MENU)
    assert.equal(menu && menu.label, 'Image actions')
    assert.deepEqual(menu.rows.map((r) => r.label), ['Copy image'])
    // Focus never went to the X: closing the menu hands it back to the editor,
    // and typing lands in the note.
    await app.key('Escape', 27)
    await app.frames()
    assert.deepEqual(await app.evaluate("[document.activeElement.className, V().hasFocus]"),
      [await app.evaluate('V().contentDOM.className'), true], 'the editor lost focus to the X')
    // macOS's Ctrl+click is the menu gesture too, and its mousedown is button 0.
    const os = await app.evaluate("document.documentElement.getAttribute('data-os')")
    await app.evaluate("(document.documentElement.setAttribute('data-os', 'macos'), 1)")
    await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x.x, y: x.y, button: 'left', buttons: 1, clickCount: 1, modifiers: 2 })
    await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x.x, y: x.y, button: 'left', buttons: 0, clickCount: 1, modifiers: 2 })
    await app.frames()
    await app.evaluate(`(document.documentElement.setAttribute('data-os', ${JSON.stringify(os)}), 1)`)
    assert.equal(await app.evaluate('V().state.doc.toString()'), NOTE, "macOS's Ctrl+click on the X deleted the image")
    await app.key('Escape', 27)
    // A plain left press still removes it: the X is a working control (§9 E4).
    await app.click(x.x, x.y)
    await app.frames()
    assert.equal((await app.evaluate(RUNS)).length, 0, 'a LEFT press on the X no longer removes the image')
  } finally {
    await app.close()
  }
})

test('a read-only (detached) note still offers Copy image', { skip: SKIP }, async () => {
  const app = await launch({ files: { 'Img.md': NOTE }, note: 'Img.md' })
  try {
    await imageBody(app, 0)
    rmSync(join(app.vault, 'Img.md'))
    let readOnly = false
    for (let i = 0; i < 60 && !readOnly; i++) {
      readOnly = await app.evaluate('V().state.readOnly')
      if (!readOnly) await sleep(50)
    }
    assert.equal(readOnly, true, 'the deleted note never became read-only')
    // No selection, read-only: the Copy/Paste menu would have nothing to offer.
    await app.evaluate('(V().dispatch({ selection: { anchor: 0 } }), 1)')
    await rclick(app, await imageBody(app, 0))
    const menu = await app.evaluate(MENU)
    assert.equal(menu && menu.label, 'Image actions')
    assert.deepEqual(menu.rows.map((r) => r.label), ['Copy image'])
  } finally {
    await app.close()
  }
})

test('command 27 refuses what it cannot put on the clipboard', { skip: SKIP }, async () => {
  const app = await launch({ files: { 'Img.md': NOTE }, note: 'Img.md' })
  try {
    // Each refusal is told apart by its reason: all three checks share a kind,
    // and a later one would refuse an earlier one's input for its own reason.
    const refuse = (r, why, reason) => {
      assert.equal(r.ok, false, why)
      assert.equal(r.error && r.error.kind, 'invalidPath', why + ': ' + JSON.stringify(r))
      assert.match(String(r.error.reason), reason, why)
    }
    refuse(await invoke(app, 'copy_image', {}), 'no data URL', /PNG or JPEG/)
    refuse(await invoke(app, 'copy_image', { data_url: 42 }), 'not a string', /PNG or JPEG/)
    refuse(await invoke(app, 'copy_image', { data_url: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' }),
      'a format nativeImage cannot decode', /PNG or JPEG/)
    refuse(await invoke(app, 'copy_image', { data_url: 'data:image/png;base64,AAAA' }),
      'a PNG that does not decode', /could not be decoded/)
    // Built in the page: a 256 MiB string is not sent through CDP.
    refuse(await app.evaluate(`window.cairn.invoke('copy_image',
      { data_url: 'data:image/png;base64,' + 'A'.repeat(256 * 1024 * 1024) })`), 'over the cap', /256 MiB/)
  } finally {
    await app.close()
  }
})

test('a PNG/JPEG label on other bytes still copies: the refused pass-through is redrawn', { skip: SKIP }, async (t) => {
  const app = await launch({ files: { 'Img.md': NOTE }, note: 'Img.md' })
  try {
    await withClipboardRestored(t, app, async () => {
      // What a misnamed file pastes as: `File.type` comes from the extension,
      // the engine sniffs the bytes and shows it, and `nativeImage` trusts the
      // label and refuses it.
      const sources = await app.evaluate(`(() => {
        const c = document.createElement('canvas')
        c.width = 31; c.height = 13
        const g = c.getContext('2d')
        for (let y = 0; y < 13; y++) for (let x = 0; x < 31; x++) {
          g.fillStyle = 'rgb(' + ((x * 8) & 255) + ',' + ((y * 19) & 255) + ',90)'
          g.fillRect(x, y, 1, 1)
        }
        const relabel = (url, mime) => 'data:' + mime + url.slice(url.indexOf(';'))
        return {
          jpegAsPng: relabel(c.toDataURL('image/jpeg', 0.92), 'image/png'),
          webpAsJpeg: relabel(c.toDataURL('image/webp', 1), 'image/jpeg'),
        }
      })()`)
      for (const [name, url] of Object.entries(sources)) {
        const direct = await invoke(app, 'copy_image', { data_url: url })
        assert.equal(direct.ok, false, `${name}: precondition — command 27 must refuse it as it is`)
        await app.evaluate(`(V().dispatch({ changes: { from: V().state.doc.length, insert: '\\n![pasted image](${url})\\n' } }), 1)`)
        await app.frames()
        const index = (await app.evaluate(RUNS)).length - 1
        const { pasted, cmp } = await copyAndPasteBack(app, index, url)
        assert.match(pasted, /^data:image\/png;base64,/, name)
        assert.deepEqual(cmp, { a: [31, 13], b: [31, 13], diff: 0 }, name)
      }
    })
  } finally {
    await app.close()
  }
})

test('a non-PNG image wider than the column is redrawn at its NATURAL size', { skip: SKIP }, async (t) => {
  const app = await launch({ files: { 'Img.md': NOTE }, note: 'Img.md' })
  try {
    await withClipboardRestored(t, app, async () => {
      const url = await app.evaluate(`(() => {
        const c = document.createElement('canvas')
        c.width = 3000; c.height = 20
        const g = c.getContext('2d')
        for (let x = 0; x < 3000; x += 10) {
          g.fillStyle = 'rgb(' + (x % 256) + ',80,' + ((x * 3) % 256) + ')'
          g.fillRect(x, 0, 10, 20)
        }
        return c.toDataURL('image/webp', 1)
      })()`)
      await app.evaluate(`(V().dispatch({ changes: { from: V().state.doc.length, insert: '\\n![pasted image](${url})\\n' } }), 1)`)
      await app.frames()
      const index = (await app.evaluate(RUNS)).length - 1
      await imageBody(app, index)
      const [shown, natural] = await app.evaluate(`(() => {
        const im = document.querySelectorAll('.nc-img')[${index}]
        return [im.width, im.naturalWidth]
      })()`)
      assert.ok(shown < natural, `precondition: the image must render scaled down (${shown} of ${natural})`)
      const { cmp } = await copyAndPasteBack(app, index, url)
      assert.deepEqual(cmp, { a: [3000, 20], b: [3000, 20], diff: 0 })
    })
  } finally {
    await app.close()
  }
})

test('an image that did not decode is not offered Copy image; the click falls through to Copy/Paste', { skip: SKIP }, async () => {
  const BAD = `# Img\n\n${PARA}\n\n![pasted image](data:image/png;base64,AAAA)\n\nAfter.\n`
  const app = await launch({ files: { 'Img.md': BAD }, note: 'Img.md' })
  try {
    const from = BAD.indexOf(PARA)
    await app.evaluate(`(V().dispatch({ selection: { anchor: ${from}, head: ${from + 10} } }), 1)`)
    let p = null
    for (let i = 0; i < 50 && !p; i++) {
      p = await app.evaluate(`(() => {
        const im = document.querySelector('.nc-img')
        if (!im || !im.complete) return null
        const q = (${IMAGE_POINT})(im)
        return { ...q, natural: im.naturalWidth, hit: q !== null }
      })()`)
      if (!p) await sleep(50)
    }
    assert.ok(p && p.natural === 0 && p.hit, 'precondition: a broken image under the pointer — ' + JSON.stringify(p))
    await rclick(app, p)
    let menu = null
    for (let i = 0; i < 40 && !menu; i++) {
      menu = await app.evaluate(MENU)
      if (!menu) await sleep(25)
    }
    // The Copy/Paste menu, whose Copy copies the selected text (§9 E4: a Copy
    // that cannot act is not offered).
    assert.equal(menu && menu.label, 'Note actions')
  } finally {
    await app.close()
  }
})

test('a Copy/Paste probe still in flight does not replace a later image menu', { skip: SKIP }, async () => {
  const app = await launch({ files: { 'Img.md': NOTE }, note: 'Img.md' })
  try {
    await imageBody(app, 0)
    const from = NOTE.indexOf(PARA)
    await app.evaluate(`(V().dispatch({ selection: { anchor: ${from}, head: ${from + 10} } }), 1)`)
    // Dispatched in the page, back to back: real input awaited one event at a
    // time lets the text click's clipboard probe land before the image press.
    const labels = await app.evaluate(`(async () => {
      const fire = (el, x, y) => el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2 }))
      const line = [...document.querySelectorAll('.cm-line')].find((l) => l.textContent.includes(${JSON.stringify(PARA)}))
      const lb = line.getBoundingClientRect()
      const img = document.querySelector('.nc-img')
      const ip = (${IMAGE_POINT})(img)
      fire(line, lb.x + 5, lb.y + 5)             // starts the read_text probe
      fire(img, ip.x, ip.y)                      // opens the image menu at once
      await window.cairn.invoke('read_text', {}) // replies in order: the probe has landed
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      return [...document.querySelectorAll('.ctx-menu')].map((m) => m.getAttribute('aria-label'))
    })()`)
    assert.deepEqual(labels, ['Image actions'])
  } finally {
    await app.close()
  }
})
