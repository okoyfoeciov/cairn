// Owner: 05. A helper, not a test: the filename has no `.test.` segment.
//
// A real EPUB written as a real ZIP. `src/epub.ts` reads the central directory
// and inflates with `DecompressionStream`, so the fixture exercises the same
// bytes the browser sees. CRC fields are zero because the reader does not verify
// them, and DOS time is zero so the bytes are deterministic.

import { deflateRawSync } from 'node:zlib'

export function zip(entries, options = {}) {
  const chunks = []
  const central = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const raw = Buffer.from(entry.data)
    const method = entry.store ? 0 : 8
    const body = method === 0 ? raw : deflateRawSync(raw)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(entry.flags ?? 0x0800, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(0, 10)
    local.writeUInt32LE(0, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    chunks.push(local, name, body)

    const c = Buffer.alloc(46)
    c.writeUInt32LE(0x02014b50, 0)
    c.writeUInt16LE(20, 4)
    c.writeUInt16LE(20, 6)
    c.writeUInt16LE(entry.flags ?? 0x0800, 8)
    c.writeUInt16LE(method, 10)
    c.writeUInt32LE(0, 12)
    c.writeUInt32LE(0, 16)
    c.writeUInt32LE(body.length, 20)
    c.writeUInt32LE(raw.length, 24)
    c.writeUInt16LE(name.length, 28)
    c.writeUInt16LE(0, 30)
    c.writeUInt16LE(0, 32)
    c.writeUInt16LE(0, 34)
    c.writeUInt16LE(0, 36)
    c.writeUInt32LE(0, 38)
    c.writeUInt32LE(offset, 42)
    central.push(c, name)
    offset += local.length + name.length + body.length
  }
  const dir = Buffer.concat(central)
  const comment = Buffer.from(options.comment ?? '')
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(dir.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(comment.length, 20)
  const out = Buffer.concat([...chunks, dir, eocd, comment])
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength)
}

export const OPF = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>The Test Book</dc:title>
    <dc:creator>A. Writer</dc:creator>
    <dc:creator>B. Editor</dc:creator>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="pic" href="pic.png" media-type="image/png"/>
  </manifest>
  <spine>
    <itemref idref="c1"/>
    <itemref idref="c2"/>
  </spine>
</package>`

export const NAV = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<body><nav epub:type="toc"><ol>
  <li><a href="ch1.xhtml">One &amp; Only</a></li>
  <li><a href="text/ch2.xhtml#part2">Two</a>
    <ol><li><a href="text/ch2.xhtml#deep">Deep</a></li></ol>
  </li>
</ol></nav></body></html>`

export const CH1 = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body>
  <h1>Chapter One</h1>
  <p>Hello <em>world</em> with&nbsp;space and a nee<span>dle</span>.</p>
  <script>do_not_index_me()</script>
  <img src="pic.png" alt="A picture"/>
  <p><a href="text/ch2.xhtml#deep">Go deep</a></p>
  <p><a href="https://example.com/x">Outside</a></p>
  <p><a href="javascript:alert(1)">Bad link</a></p>
</body></html>`

export const CH2 = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body>
  <h1 id="part2">Chapter Two</h1>
  <p>Another needle lives here.</p>
  <p><a href="#tail">Jump to the tail</a> and <a href="#aside1">aside</a>.</p>
  <h2 id="deep">Deep</h2>
  <aside id="aside1">An aside target.</aside>
  <p id="tail">The last line.</p>
</body></html>`

export const CONTAINER = `<?xml version="1.0"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`

export function fixture(extra = []) {
  return zip([
    { name: 'mimetype', data: 'application/epub+zip', store: true },
    { name: 'META-INF/container.xml', data: CONTAINER },
    { name: 'OEBPS/content.opf', data: OPF },
    { name: 'OEBPS/nav.xhtml', data: NAV },
    { name: 'OEBPS/ch1.xhtml', data: CH1 },
    { name: 'OEBPS/text/ch2.xhtml', data: CH2 },
    { name: 'OEBPS/pic.png', data: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2m9sAAAAASUVORK5CYII=', 'base64'), store: true },
    ...extra,
  ])
}
