/**
 * tests/frontend/epub.test.mjs — CONTRACT §0.55 E108's container half.
 *
 * No jsdom and no new dependency: `_epub-fixture.mjs` writes a real ZIP and
 * the real `src/epub.ts` opens it through the same DecompressionStream the
 * browser uses.  These tests pin the parts a malformed book can break: the
 * central directory, OPF metadata, spine order, EPUB3 nav, EPUB2 NCX, path
 * resolution, entities and each chapter's searchable text.
 */

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'
import { CONTAINER, CH1, CH2, NAV, OPF, fixture, zip } from './_epub-fixture.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '..', '..')

/** @type {any} */ let E

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cairn-epub-'))
  process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })
  const out = join(dir, 'bundle.mjs')
  await esbuild.build({
    stdin: {
      contents: 'export * as E from ' + JSON.stringify(join(ROOT, 'src', 'epub.ts')) + '\n',
      resolveDir: ROOT,
      sourcefile: 'epub-test-entry.ts',
      loader: 'ts',
    },
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    mainFields: ['module', 'main'],
    conditions: ['import', 'default'],
    target: 'es2021',
    absWorkingDir: ROOT,
    logLevel: 'silent',
  })
  E = (await import(pathToFileURL(out).href)).E
})

test('openEpub: metadata, spine order and EPUB3 nav', async () => {
  const book = await E.openEpub(fixture())
  assert.equal(book.metadata.title, 'The Test Book')
  assert.equal(book.metadata.author, 'A. Writer, B. Editor')
  assert.equal(book.metadata.language, 'en')
  assert.deepEqual(book.chapters.map((c) => c.href), ['OEBPS/ch1.xhtml', 'OEBPS/text/ch2.xhtml'])
  assert.deepEqual(book.chapters.map((c) => c.title), ['One & Only', 'Two'])
  assert.deepEqual(
    book.toc.map((t) => [t.title, t.chapter, t.fragment, t.depth]),
    [
      ['One & Only', 0, '', 0],
      ['Two', 1, 'part2', 0],
      ['Deep', 1, 'deep', 1],
    ]
  )
  assert.equal(book.chapterFor('OEBPS/text/ch2.xhtml'), 1)
  book.destroy()
})

test('openEpub: chapter text is visible text only, across chapters', async () => {
  const book = await E.openEpub(fixture())
  assert.equal(book.chapters.length, 2)
  assert.ok(book.chapters[0].text.includes('needle'))
  assert.ok(book.chapters[1].text.includes('needle'))
  assert.equal(book.chapters[0].text.includes('do_not_index_me'), false, 'a <script> body is not book text')
  assert.equal(book.chapters[0].text.includes('<'), false, 'markup never leaks into searchable text')
  book.destroy()
})

test('imageSize: PNG, GIF, JPEG and all three WebP headers', () => {
  const png = new Uint8Array(33)
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  new DataView(png.buffer).setUint32(8, 13)
  png.set([0x49, 0x48, 0x44, 0x52], 12)
  new DataView(png.buffer).setUint32(16, 365)
  new DataView(png.buffer).setUint32(20, 570)
  assert.deepEqual(E.imageSize(png), { width: 365, height: 570 })
  const huge = new Uint8Array(33)
  huge.set(png)
  new DataView(huge.buffer).setUint32(16, 0xffffffff)
  new DataView(huge.buffer).setUint32(20, 0xffffffff)
  assert.equal(E.imageSize(huge), null)

  const gif = new Uint8Array(10)
  gif.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0)
  new DataView(gif.buffer).setUint16(6, 365, true)
  new DataView(gif.buffer).setUint16(8, 570, true)
  assert.deepEqual(E.imageSize(gif), { width: 365, height: 570 })

  const jpeg = new Uint8Array([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x3a, 0x01, 0x6d, 0, 0, 0, 0, 0, 0, 0,
  ])
  assert.deepEqual(E.imageSize(jpeg), { width: 365, height: 570 })

  const webp = (kind, width, height) => {
    const b = new Uint8Array(30)
    b.set([0x52, 0x49, 0x46, 0x46], 0)
    b.set([0x57, 0x45, 0x42, 0x50], 8)
    b.set([...kind].map((c) => c.charCodeAt(0)), 12)
    new DataView(b.buffer).setUint32(16, 10, true)
    if (kind === 'VP8X') {
      const w = width - 1
      const h = height - 1
      b[24] = w & 0xff; b[25] = (w >> 8) & 0xff; b[26] = (w >> 16) & 0xff
      b[27] = h & 0xff; b[28] = (h >> 8) & 0xff; b[29] = (h >> 16) & 0xff
    } else if (kind === 'VP8 ') {
      b.set([0x9d, 0x01, 0x2a], 23)
      new DataView(b.buffer).setUint16(26, width, true)
      new DataView(b.buffer).setUint16(28, height, true)
    } else {
      b[20] = 0x2f
      const bits = (width - 1) | ((height - 1) << 14)
      new DataView(b.buffer).setUint32(21, bits, true)
    }
    return b
  }
  for (const kind of ['VP8X', 'VP8 ', 'VP8L']) {
    assert.deepEqual(E.imageSize(webp(kind, 365, 570)), { width: 365, height: 570 }, kind)
  }

  assert.equal(E.imageSize(new Uint8Array(8)), null)
  assert.equal(E.imageSize(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0])), null)
})

test('xml: malformed start tags make progress and never spin', () => {
  for (const bad of ['<a href=/foo>x</a>', '<div class=a/b>x</div>', '<img src=x / >', '<p / x>']) {
    const doc = E.parseXml(bad)
    assert.ok(E.findElement(doc, 'a') || E.findElement(doc, 'div') || E.findElement(doc, 'img') || E.findElement(doc, 'p') || doc.children.length >= 0)
  }
  const many = E.parseXml('<'.repeat(20_000))
  assert.ok(many.children.length > 0)
})

test('xml: deep nesting is refused with a named error, not a stack overflow', () => {
  const deep = '<div>'.repeat(600) + 'x' + '</div>'.repeat(600)
  assert.throws(
    () => E.parseXml(deep),
    (e) => e && e.name === 'EpubError' && e.code === 'corrupt'
  )
})

test('openEpub: a ZIP comment containing the EOCD signature is not mistaken for it', async () => {
  const book = await E.openEpub(zip([
    { name: 'mimetype', data: 'application/epub+zip', store: true },
    { name: 'META-INF/container.xml', data: CONTAINER },
    { name: 'OEBPS/content.opf', data: OPF },
    { name: 'OEBPS/nav.xhtml', data: NAV },
    { name: 'OEBPS/ch1.xhtml', data: CH1 },
    { name: 'OEBPS/text/ch2.xhtml', data: CH2 },
    { name: 'OEBPS/pic.png', data: Buffer.from('89504e470d0a1a0a', 'hex'), store: true },
  ], { comment: 'PK\x05\x06 not the directory' }))
  assert.equal(book.metadata.title, 'The Test Book')
  book.destroy()
})

test('openEpub: duplicate normalized entry names are refused', async () => {
  await assert.rejects(
    E.openEpub(fixture([{ name: './OEBPS/ch1.xhtml', data: CH1, store: true }])),
    (e) => e && e.name === 'EpubError' && e.code === 'corrupt'
  )
})

test('openEpub: a ZIP-encrypted entry is DRM, not prose', async () => {
  await assert.rejects(
    E.openEpub(fixture([{ name: 'OEBPS/secret.xhtml', data: 'ciphertext', store: true, flags: 0x0801 }])),
    (e) => e && e.name === 'EpubError' && e.code === 'drm'
  )
})

const makeFixture = (opfText = OPF, navText = NAV) => zip([
  { name: 'mimetype', data: 'application/epub+zip', store: true },
  { name: 'META-INF/container.xml', data: CONTAINER },
  { name: 'OEBPS/content.opf', data: opfText },
  { name: 'OEBPS/nav.xhtml', data: navText },
  { name: 'OEBPS/ch1.xhtml', data: CH1 },
  { name: 'OEBPS/text/ch2.xhtml', data: CH2 },
  { name: 'OEBPS/pic.png', data: Buffer.from('89504e470d0a1a0a', 'hex'), store: true },
])

test('openEpub: duplicate manifest ids, duplicate spine items and landmarks-only navs', async () => {
  await assert.rejects(
    E.openEpub(makeFixture(OPF.replace('id="c2"', 'id="c1"'))),
    (e) => e && e.name === 'EpubError' && e.code === 'corrupt'
  )
  const dupSpine = await E.openEpub(
    makeFixture(OPF.replace('<itemref idref="c2"/>', '<itemref idref="c2"/><itemref idref="c1"/>'))
  )
  assert.equal(dupSpine.chapters.length, 2, 'a repeated spine itemref is not a second chapter')
  dupSpine.destroy()

  const landmark = await E.openEpub(
    makeFixture(OPF, NAV.replace('epub:type="toc"', 'epub:type="landmarks"'))
  )
  assert.equal(landmark.toc.length, 2, 'a landmarks-only nav must fall back to the spine')
  landmark.destroy()
})

test('openEpub: an untyped manifest image still gets its extension MIME', async () => {
  const book = await E.openEpub(
    makeFixture(OPF.replace('media-type="image/png"', ''))
  )
  assert.equal(book.mimeOf('OEBPS/pic.png'), 'image/png')
  book.destroy()
})

test('resolveHref: fragment-only and backslash hrefs stay on the base document', () => {
  assert.deepEqual(E.resolveHref('OEBPS/ch1.xhtml', '#part2'), {
    path: 'OEBPS/ch1.xhtml', fragment: 'part2',
  })
  assert.equal(E.resolveHref('OEBPS/ch1.xhtml', '..\\pic.png').path, 'pic.png')
})

test('openEpub: a declared resource is readable and typed', async () => {
  const book = await E.openEpub(fixture())
  const pic = await book.resource('OEBPS/pic.png')
  assert.ok(pic)
  assert.equal(pic.mime, 'image/png')
  assert.ok(pic.bytes.length > 8)
  assert.deepEqual(E.imageSize(pic.bytes), { width: 1, height: 1 })
  assert.equal(await book.resource('OEBPS/nope.png'), null)
  book.destroy()
})

test('openEpub: EPUB2 NCX is the fallback when no nav document exists', async () => {
  const opf = OPF.replace(' properties="nav"', '').replace(
    '<spine>',
    '<spine toc="ncx">'
  ).replace(
    '</manifest>',
    '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/></manifest>'
  )
  const ncx = `<?xml version="1.0"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><navMap>
  <navPoint id="a"><navLabel><text>First</text></navLabel><content src="ch1.xhtml"/>
    <navPoint id="b"><navLabel><text>Second</text></navLabel><content src="text/ch2.xhtml#tail"/></navPoint>
  </navPoint>
</navMap></ncx>`
  const book = await E.openEpub(zip([
    { name: 'mimetype', data: 'application/epub+zip', store: true },
    { name: 'META-INF/container.xml', data: CONTAINER },
    { name: 'OEBPS/content.opf', data: opf },
    { name: 'OEBPS/toc.ncx', data: ncx },
    { name: 'OEBPS/ch1.xhtml', data: CH1 },
    { name: 'OEBPS/text/ch2.xhtml', data: CH2 },
  ]))
  assert.deepEqual(
    book.toc.map((t) => [t.title, t.chapter, t.depth]),
    [['First', 0, 0], ['Second', 1, 1]]
  )
  assert.equal(book.toc[1].fragment, 'tail')
  book.destroy()
})

test('openEpub: an encrypted spine is DRM, but a font-only encryption is not', async () => {
  const encryptedSpine = `<?xml version="1.0"?>
<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"
 xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
  <enc:EncryptedData><enc:CipherData>
    <enc:CipherReference URI="OEBPS/ch1.xhtml"/>
  </enc:CipherData></enc:EncryptedData>
</encryption>`
  await assert.rejects(
    () => E.openEpub(fixture([{ name: 'META-INF/encryption.xml', data: encryptedSpine }])),
    (e) => e.name === 'EpubError' && e.code === 'drm'
  )

  const fontsOnly = encryptedSpine.replace('OEBPS/ch1.xhtml', 'OEBPS/font.otf')
  const book = await E.openEpub(
    fixture([{ name: 'META-INF/encryption.xml', data: fontsOnly }])
  )
  assert.equal(book.chapters.length, 2)
  book.destroy()
})

test('openEpub: a plain ZIP is refused by name, not by a RangeError', async () => {
  const notEpub = zip([{ name: 'hello.txt', data: 'hi' }])
  await assert.rejects(
    () => E.openEpub(notEpub),
    (e) => e.name === 'EpubError' && e.code === 'notEpub' && /container\.xml/.test(e.message)
  )
})

test('xml: entities decode, unknown names are left alone, namespaces are local', () => {
  const doc = E.parseXml(
    '<r xmlns:dc="x"><dc:title>A &amp; B &#8212; &#x43; &nbsp; &bogus;</dc:title><p>plain</p></r>'
  )
  const title = E.findElement(doc, 'title')
  assert.ok(title)
  assert.equal(E.elementText(title), 'A & B \u2014 C &bogus;')
  assert.ok(E.findElement(doc, 'p'))
})

test('resolveHref: fragments, percent escapes and .. are resolved inside the archive', () => {
  assert.deepEqual(E.resolveHref('OEBPS/text/ch2.xhtml', '../pic.png'), {
    path: 'OEBPS/pic.png',
    fragment: '',
  })
  assert.deepEqual(E.resolveHref('OEBPS/text/ch2.xhtml', 'ch2.xhtml#part%202'), {
    path: 'OEBPS/text/ch2.xhtml',
    fragment: 'part 2',
  })
  assert.deepEqual(E.resolveHref('OEBPS/text/ch2.xhtml', '/OEBPS/ch1.xhtml'), {
    path: 'OEBPS/ch1.xhtml',
    fragment: '',
  })
})
