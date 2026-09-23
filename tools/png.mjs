/**
 * tools/png.mjs -- a PNG decoder, in Node, with no dependency.
 *
 * WHY NOT A LIBRARY. `electron-shell/pane-paint.test.mjs` reads a screenshot's
 * bytes and this project's line is "no framework, no bundler beyond esbuild".
 * `zlib` is built in and the rest of PNG is a header and a filter per scanline,
 * so a decoder is ~120 lines. That is cheaper than the argument about which
 * library.
 *
 * ================== IT RETURNS RAW STORED BYTES. THAT IS THE POINT. ==========
 * `docs/reference/obsidian-macos-window.png` carries an `iCCP` chunk (516 B,
 * gamma 1.961), and spike-O §3.5 / spike-Q Trap 2 are emphatic about what that
 * means: the compositor blended the anti-alias edges in DISPLAY space, so **the
 * stored byte is what is linear in glyph coverage**, and decoding to sRGB first
 * inflates every partial pixel by up to +0.040 of coverage. Every threshold in
 * this project is computed on raw stored bytes.
 *
 * So this decoder IGNORES `iCCP`, `gAMA`, `sRGB` and `cHRM` — deliberately, not
 * by omission. It is not a colour-management bug; colour-managing here would be
 * the bug, and it would silently move every measurement.
 * ============================================================================
 *
 * Supports the two things that actually occur: 8-bit RGB and 8-bit RGBA,
 * non-interlaced. Anything else THROWS with what it found, rather than
 * returning a plausible wrong image.
 */

import { inflateSync } from 'node:zlib'

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Paeth, from the spec, unchanged -- the one filter worth naming. */
function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/**
 * Decode a PNG to `{ width, height, data }`, `data` being RGBA8 with no colour
 * management applied. See the header.
 */
export function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error('png: not a PNG (bad signature)')

  let ihdr = null
  const idat = []
  let pos = 8
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      }
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    // Every other chunk -- iCCP, gAMA, sRGB, pHYs, tEXt -- is SKIPPED. See the
    // header: colour-managing here would move every measurement in the project.
    pos += 12 + len
  }
  if (!ihdr) throw new Error('png: no IHDR')
  if (ihdr.bitDepth !== 8) throw new Error(`png: bit depth ${ihdr.bitDepth}, only 8 is supported`)
  if (ihdr.interlace !== 0) throw new Error('png: interlaced, which nothing here produces')
  const channels = ihdr.colorType === 6 ? 4 : ihdr.colorType === 2 ? 3 : 0
  if (!channels) throw new Error(`png: colour type ${ihdr.colorType}, only 2 (RGB) and 6 (RGBA)`)

  const raw = inflateSync(Buffer.concat(idat))
  const { width, height } = ihdr
  const stride = width * channels
  const out = new Uint8Array(width * height * 4)
  let prev = new Uint8Array(stride)

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const cur = new Uint8Array(stride)
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0
      const b = prev[i]
      const c = i >= channels ? prev[i - channels] : 0
      const x = line[i]
      cur[i] =
        (filter === 0 ? x
          : filter === 1 ? x + a
          : filter === 2 ? x + b
          : filter === 3 ? x + ((a + b) >> 1)
          : filter === 4 ? x + paeth(a, b, c)
          : (() => { throw new Error(`png: filter ${filter} on row ${y}`) })()) & 0xff
    }
    for (let x = 0; x < width; x++) {
      const s = x * channels
      const d = (y * width + x) * 4
      out[d] = cur[s]
      out[d + 1] = cur[s + 1]
      out[d + 2] = cur[s + 2]
      out[d + 3] = channels === 4 ? cur[s + 3] : 255
    }
    prev = cur
  }
  return { width, height, data: out }
}
