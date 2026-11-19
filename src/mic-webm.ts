/**
 * src/mic-webm.ts
 * Owner: 03.  Spec: CONTRACT.md §0.58 E111 — the microphone's live WebM.
 *
 * A streamable WebM writer for one mono Opus track, byte-identical to
 * GStreamer's `webmmux streamable=true min-cluster-duration=100000000`, which
 * is what voice-typing sends (pinned against a GStreamer golden in
 * tests/frontend/mic-webm.test.mjs).  EBML header, a Segment of unknown size,
 * Tags, Info, Tracks, then Clusters of unknown size.  Each packet is written
 * the moment it exists; only the final one waits, because webmmux writes it as
 * a BlockGroup carrying its DiscardPadding.  Pure bytes: no DOM, no I/O.
 */

const ID = {
  EBML: [0x1A, 0x45, 0xDF, 0xA3], DocType: [0x42, 0x82], DocTypeVersion: [0x42, 0x87], DocTypeReadVersion: [0x42, 0x85],
  Segment: [0x18, 0x53, 0x80, 0x67],
  Tags: [0x12, 0x54, 0xC3, 0x67], Tag: [0x73, 0x73], Targets: [0x63, 0xC0], TagTrackUID: [0x63, 0xC5],
  SimpleTag: [0x67, 0xC8], TagName: [0x45, 0xA3], TagString: [0x44, 0x87],
  Info: [0x15, 0x49, 0xA9, 0x66], TimecodeScale: [0x2A, 0xD7, 0xB1], MuxingApp: [0x4D, 0x80], WritingApp: [0x57, 0x41],
  DateUTC: [0x44, 0x61],
  Tracks: [0x16, 0x54, 0xAE, 0x6B], TrackEntry: [0xAE], TrackNumber: [0xD7], TrackType: [0x83], TrackUID: [0x73, 0xC5],
  DefaultDuration: [0x23, 0xE3, 0x83], Name: [0x53, 0x6E], Audio: [0xE1], SamplingFrequency: [0xB5],
  CodecID: [0x86], CodecPrivate: [0x63, 0xA2], SeekPreRoll: [0x56, 0xBB], CodecDelay: [0x56, 0xAA],
  Cluster: [0x1F, 0x43, 0xB6, 0x75], Timecode: [0xE7], PrevSize: [0xAB],
  SimpleBlock: [0xA3], BlockGroup: [0xA0], Block: [0xA1], DiscardPadding: [0x75, 0xA2],
} as const

// webmmux writes every master's size in 8 bytes, and Segment and Cluster as "unknown".
const UNKNOWN8 = [0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  let n = 0
  for (const p of parts) n += p.length
  const out = new Uint8Array(n)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/** EBML variable-size integer of minimal length (leaf elements). */
function vsize(n: number): Uint8Array {
  for (let len = 1; len <= 8; len++) {
    if (n < 2 ** (7 * len) - 1) {
      const out = new Uint8Array(len)
      let v = n
      for (let i = len - 1; i >= 0; i--) {
        out[i] = v % 256
        v = Math.floor(v / 256)
      }
      out[0] = (out[0] ?? 0) | (0x80 >> (len - 1))
      return out
    }
  }
  throw new RangeError('size too large')
}

function vsize8(n: number): Uint8Array {
  const out = new Uint8Array(8)
  let v = n
  for (let i = 7; i >= 0; i--) {
    out[i] = v % 256
    v = Math.floor(v / 256)
  }
  out[0] = (out[0] ?? 0) | 0x01
  return out
}

function uintBytes(v: number | bigint, minLen = 1): Uint8Array {
  const bytes: number[] = []
  let x = BigInt(v)
  while (x > 0n) {
    bytes.unshift(Number(x & 0xFFn))
    x >>= 8n
  }
  while (bytes.length < minLen) bytes.unshift(0)
  return Uint8Array.from(bytes)
}

/** Signed, minimal two's complement. */
function intBytes(v: number): Uint8Array {
  let len = 1
  while (len < 8 && !(v >= -(2 ** (8 * len - 1)) && v < 2 ** (8 * len - 1))) len++
  const out = new Uint8Array(len)
  let x = BigInt.asUintN(8 * len, BigInt(v))
  for (let i = len - 1; i >= 0; i--) {
    out[i] = Number(x & 0xFFn)
    x >>= 8n
  }
  return out
}

const leaf = (id: readonly number[], data: Uint8Array): Uint8Array => concat([Uint8Array.from(id), vsize(data.length), data])
const master = (id: readonly number[], children: Uint8Array[]): Uint8Array => {
  const body = concat(children)
  return concat([Uint8Array.from(id), vsize8(body.length), body])
}
const u = (id: readonly number[], v: number | bigint, minLen?: number): Uint8Array => leaf(id, uintBytes(v, minLen))
// webmmux writes every string with a terminating NUL (DocType "webm" is 5 bytes).
const s = (id: readonly number[], str: string): Uint8Array => leaf(id, concat([new TextEncoder().encode(str), new Uint8Array(1)]))
const f64 = (id: readonly number[], v: number): Uint8Array => {
  const b = new Uint8Array(8)
  new DataView(b.buffer).setFloat64(0, v)
  return leaf(id, b)
}

// DateUTC: nanoseconds since 2001-01-01T00:00:00Z.
const MKV_EPOCH_MS = Date.UTC(2001, 0, 1)
const dateUTC = (ms: number): bigint => BigInt(Math.round(ms - MKV_EPOCH_MS)) * 1000000n

/** OpusHead for a family-0 stream (RFC 7845 §5.1). */
export function opusHead(o: { preSkip?: number; inputSampleRate?: number; channels?: number } = {}): Uint8Array {
  const { preSkip = 312, inputSampleRate = 48000, channels = 1 } = o
  const b = new Uint8Array(19)
  b.set(new TextEncoder().encode('OpusHead'), 0)
  const dv = new DataView(b.buffer)
  b[8] = 1
  b[9] = channels
  dv.setUint16(10, preSkip, true)
  dv.setUint32(12, inputSampleRate, true)
  dv.setInt16(16, 0, true)
  b[18] = 0
  return b
}

export interface OpusHeadInfo {
  bytes: Uint8Array
  version: number
  channels: number
  preSkip: number
  inputSampleRate: number
  gain: number
  family: number
}

/** The encoder's `decoderConfig.description`, read as an OpusHead; null when it is not one. */
export function readOpusHead(desc: ArrayBuffer | ArrayBufferView | null | undefined): OpusHeadInfo | null {
  if (!desc) return null
  const b = desc instanceof Uint8Array
    ? desc
    : ArrayBuffer.isView(desc)
      ? new Uint8Array(desc.buffer.slice(desc.byteOffset, desc.byteOffset + desc.byteLength))
      : new Uint8Array(desc)
  if (b.length < 19 || String.fromCharCode(...b.subarray(0, 8)) !== 'OpusHead') return null
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  return {
    bytes: b, version: b[8] ?? 0, channels: b[9] ?? 0, preSkip: dv.getUint16(10, true),
    inputSampleRate: dv.getUint32(12, true), gain: dv.getInt16(16, true), family: b[18] ?? 0,
  }
}

function randomUid(): bigint {
  const b = new Uint8Array(8)
  globalThis.crypto.getRandomValues(b)
  b[0] = (b[0] ?? 0) & 0x7f
  if (!b[0]) b[0] = 1
  let v = 0n
  for (const x of b) v = (v << 8n) | BigInt(x)
  return v
}

export interface LiveWebmWriterOptions {
  /** Both identity strings at once; nothing reads them. */
  app?: string
  muxingApp?: string
  writingApp?: string
  /** Fixed DateUTC (ns since 2001); otherwise `now()` at header(). */
  dateUtcNs?: bigint | null
  frameMs?: number
  minClusterMs?: number
  bitrate?: number
  trackUid?: bigint
  now?: () => number
}

export class LiveWebmWriter {
  private readonly muxingApp: string
  private readonly writingApp: string
  private readonly dateUtcNs: bigint | null
  private readonly frameMs: number
  private readonly minClusterMs: number
  private readonly bitrate: number
  private readonly trackUid: bigint
  private readonly now: () => number
  private clusterStart: number | null = null
  /** Bytes of the open cluster, its header included (the next one's PrevSize). */
  private clusterBytes = 0
  private prevClusterBytes: number | null = null
  /** Bytes written so far. */
  bytes = 0

  constructor(o: LiveWebmWriterOptions = {}) {
    const app = o.app ?? 'Cairn'
    this.muxingApp = o.muxingApp ?? app
    this.writingApp = o.writingApp ?? app
    this.dateUtcNs = o.dateUtcNs ?? null
    this.frameMs = o.frameMs ?? 60
    this.minClusterMs = o.minClusterMs ?? 100
    this.bitrate = o.bitrate ?? 128000
    this.trackUid = o.trackUid ?? randomUid()
    this.now = o.now ?? Date.now
  }

  /** EBML header + Segment + Tags + Info + Tracks.  `head` is the encoder's
   *  OpusHead (CodecPrivate); its preSkip sets CodecDelay. */
  header(head?: ArrayBuffer | ArrayBufferView | null): Uint8Array {
    const oh = readOpusHead(head) ?? (readOpusHead(opusHead()) as OpusHeadInfo)
    const ebml = master(ID.EBML, [s(ID.DocType, 'webm'), u(ID.DocTypeVersion, 4), u(ID.DocTypeReadVersion, 2)])
    const tags = master(ID.Tags, [master(ID.Tag, [
      master(ID.Targets, [u(ID.TagTrackUID, this.trackUid, 8)]),
      master(ID.SimpleTag, [s(ID.TagName, 'BITSPS'), s(ID.TagString, String(this.bitrate))]),
    ])])
    const date = new Uint8Array(8)
    new DataView(date.buffer).setBigInt64(0, this.dateUtcNs ?? dateUTC(this.now()))
    const info = master(ID.Info, [u(ID.TimecodeScale, 1000000), s(ID.MuxingApp, this.muxingApp), s(ID.WritingApp, this.writingApp), leaf(ID.DateUTC, date)])
    const codecDelayNs = Math.round((oh.preSkip * 1e9) / 48000)
    const tracks = master(ID.Tracks, [master(ID.TrackEntry, [
      u(ID.TrackNumber, 1), u(ID.TrackType, 2), u(ID.TrackUID, this.trackUid, 8),
      u(ID.DefaultDuration, this.frameMs * 1000000), s(ID.Name, 'Audio'),
      master(ID.Audio, [f64(ID.SamplingFrequency, 48000)]),
      s(ID.CodecID, 'A_OPUS'), leaf(ID.CodecPrivate, oh.bytes),
      u(ID.SeekPreRoll, 80000000), u(ID.CodecDelay, codecDelayNs),
    ])])
    const seg = concat([Uint8Array.from(ID.Segment), Uint8Array.from(UNKNOWN8)])
    const out = concat([ebml, seg, tags, info, tracks])
    this.bytes += out.length
    return out
  }

  /** One Opus packet at `tMs` (ms from the first packet): a new Cluster when
   *  min-cluster-duration has elapsed, then a SimpleBlock, or for the padded
   *  final packet a BlockGroup with DiscardPadding, as webmmux writes it. */
  packet(payload: Uint8Array, tMs: number, o: { discardPaddingNs?: number } = {}): Uint8Array {
    const discardPaddingNs = o.discardPaddingNs ?? 0
    const parts: Uint8Array[] = []
    if (this.clusterStart === null || tMs - this.clusterStart >= this.minClusterMs) {
      if (this.clusterStart !== null) this.prevClusterBytes = this.clusterBytes
      this.clusterStart = tMs
      const head = [Uint8Array.from(ID.Cluster), Uint8Array.from(UNKNOWN8), u(ID.Timecode, tMs)]
      if (this.prevClusterBytes !== null) head.push(u(ID.PrevSize, this.prevClusterBytes))
      this.clusterBytes = 0
      parts.push(concat(head))
    }
    const rel = tMs - this.clusterStart
    const bh = new Uint8Array(4)
    bh[0] = 0x81 // track 1, as a 1-byte vint
    new DataView(bh.buffer).setInt16(1, rel)
    if (discardPaddingNs > 0) {
      bh[3] = 0x00
      const block = leaf(ID.Block, concat([bh, payload]))
      parts.push(master(ID.BlockGroup, [leaf(ID.DiscardPadding, intBytes(discardPaddingNs)), block]))
    } else {
      bh[3] = 0x80 // keyframe
      parts.push(leaf(ID.SimpleBlock, concat([bh, payload])))
    }
    const out = concat(parts)
    this.clusterBytes += out.length
    this.bytes += out.length
    return out
  }
}
