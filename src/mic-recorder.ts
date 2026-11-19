/**
 * src/mic-recorder.ts
 * Owner: 03.  Spec: CONTRACT.md §0.58 E111 — the microphone's audio chain.
 *
 * One take: arming → recording → stopping → transcribing → idle.
 *   getUserMedia (raw) → MediaStreamTrackProcessor → average-of-planes mono →
 *   WebCodecs Opus with voice-typing's opusenc settings → live WebM
 *   (mic-webm.ts) → WebSocket `/api/transcribe/ws` (mic-wire.ts).
 * Every packet is sent the moment it exists and is also kept, for the retry
 * and for the clip.  voice-typing's implementation is the authority for
 * quality and latency, so its parameters are carried as they are; each value
 * below names its source.
 *
 * Events (`on(type, fn)` returns an unsubscribe):
 *   armed        the microphone opened
 *   first-audio  the first captured buffer: the socket opens now
 *   stopping     stop() was accepted
 *   sent         the floors passed and "stop" went out: the clip and a promise
 *                of the final answer (with its word timings), for the trim
 *   done | failed | mic-failed | cancelled   exactly one ending
 * Nothing at all fires after an ending.  Every browser API comes through
 * `deps`, so the state machine runs under node with fakes.
 */

import type { MicError } from './mic-types'
import { LiveWebmWriter, concat, readOpusHead } from './mic-webm'
import {
  TakeSocket, WIRE_TYPE, browserTimers, classifyReply, coalesce, failedLine, transcribeUrl,
  type Attempt, type Verdict, type WireTimers, type WsCtor,
} from './mic-wire'

/* ------------------------------------------------------------------ */
/* the parameters                                                      */
/* ------------------------------------------------------------------ */

export interface MicRecorderSettings {
  /** AssemblyAI's limit is 120 s (voice-typing CAP_SECONDS, comart MAX_RECORD_SECS). */
  capMs: number
  /** voice-typing CAP_POLL_MS, comart's poll. */
  capPollMs: number
  /** The floors: since the first buffer, and bytes with the WebM header (MIN_TAKE_MS/BYTES). */
  minMs: number
  minBytes: number
  /** After "stop" (RESPONSE_DEADLINE_S); none while recording. */
  deadlineMs: number
  /** CONNECT_TIMEOUT_S, the upgrade included. */
  connectTimeoutMs: number
  /** DRAIN_TIMEOUT_MS: the encoder flush never hangs a stop. */
  drainTimeoutMs: number
  /** How long release() waits for the buffer that holds the click. */
  releaseWaitMs: number
  /** The processor queues 10 buffers by default and drops the oldest when this
   *  (UI) thread stalls: 120 ms lost 20 ms of audio.  300 = 3 s of headroom. */
  maxBufferSize: number
  /** The type on the wire; the clip keeps comart's plain type. */
  mime: string
  clipType: string
  frameMs: number
}

export const DEFAULTS: Readonly<MicRecorderSettings> = Object.freeze({
  capMs: 119000,
  capPollMs: 200,
  minMs: 350,
  minBytes: 1200,
  deadlineMs: 30000,
  connectTimeoutMs: 5000,
  drainTimeoutMs: 3000,
  releaseWaitMs: 50,
  maxBufferSize: 300,
  mime: WIRE_TYPE,
  clipType: 'audio/webm;codecs=opus',
  frameMs: 60,
})

/** No echo cancellation, noise suppression or gain control (voice-typing's raw pulsesrc). */
export const RAW_CONSTRAINTS = Object.freeze({
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: 1,
})

export interface OpusStreamConfig {
  codec: 'opus'
  sampleRate: number
  numberOfChannels: 1
  bitrate: number
  bitrateMode: 'variable'
  opus: {
    format: 'opus'
    frameDuration: number
    complexity: number
    usedtx: boolean
    useinbandfec: boolean
    packetlossperc: number
    application: 'audio'
    signal: 'auto'
  }
}

/** voice-typing's opusenc (config.py OPUSENC_PROPS): audio-type=generic →
 *  'audio'; bitrate 128000; constrained-vbr → 'variable' (Chromium sets
 *  OPUS_SET_VBR(1) and leaves libopus's default constraint on); complexity 9;
 *  60 ms frames; no DTX; no in-band FEC.  bandwidth=auto and
 *  max-payload-size=4000 have no knob: libopus's default is auto, and packets
 *  stay under 1000 B.  Mono, at the device's rate (Chromium resamples to 48 kHz). */
export function opusConfig(sampleRate: number): OpusStreamConfig {
  return {
    codec: 'opus', sampleRate, numberOfChannels: 1, bitrate: 128000, bitrateMode: 'variable',
    opus: { format: 'opus', frameDuration: 60000, complexity: 9, usedtx: false, useinbandfec: false, packetlossperc: 0, application: 'audio', signal: 'auto' },
  }
}

/* ------------------------------------------------------------------ */
/* the browser seams (structural, so fakes fit)                        */
/* ------------------------------------------------------------------ */

/** The slice of a captured AudioData that capture reads. */
export interface CapturedAudio {
  readonly numberOfChannels: number
  readonly numberOfFrames: number
  readonly sampleRate: number
  readonly timestamp: number
  readonly format?: string | null
  copyTo(dest: Float32Array, o: { planeIndex: number; format: 'f32-planar' }): void
  close(): void
}

export interface MicTrack {
  readonly label?: string
  stop(): void
  addEventListener(type: 'ended', fn: () => void): void
  getSettings(): MediaTrackSettings
}
export interface MicStream {
  getAudioTracks(): MicTrack[]
  getTracks(): MicTrack[]
}

export interface TrackReader {
  read(): Promise<{ done: boolean; value?: CapturedAudio | undefined }>
  cancel(): Promise<void>
}
/** Chromium's MediaStreamTrackProcessor, exposed on Window in Electron 39.
 *  TypeScript's lib.dom does not declare it. */
export type TrackProcessorCtor = new (init: { track: MicTrack; maxBufferSize?: number }) => {
  readonly readable: { getReader(): TrackReader }
}

export interface EncodedPacket {
  readonly byteLength: number
  readonly timestamp: number
  readonly duration: number | null
  copyTo(dest: Uint8Array): void
}
export interface EncodedMeta {
  decoderConfig?: { description?: ArrayBuffer | ArrayBufferView | undefined } | undefined
}
export interface AudioDataOut {
  close(): void
}
export interface EncoderLike {
  readonly state: string
  configure(config: OpusStreamConfig): void
  encode(data: AudioDataOut): void
  flush(): Promise<void>
  close(): void
}
export type EncoderCtor = new (init: { output(chunk: EncodedPacket, meta?: EncodedMeta): void; error(e: unknown): void }) => EncoderLike
export type AudioDataCtor = new (init: {
  format: 'f32-planar'
  sampleRate: number
  numberOfFrames: number
  numberOfChannels: number
  timestamp: number
  data: Float32Array
}) => AudioDataOut

export interface MicTimers extends WireTimers {
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

export interface MicRecorderDeps {
  getUserMedia(c: MediaStreamConstraints): Promise<MicStream>
  WebSocket: WsCtor
  AudioEncoder: EncoderCtor
  AudioData: AudioDataCtor
  MediaStreamTrackProcessor: TrackProcessorCtor | undefined
  now(): number
  timers: MicTimers
}

const browserMicTimers: MicTimers = {
  ...browserTimers,
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as number),
}

/** The browser's own, looked up only when a take needs them. */
function liveDeps(d: Partial<MicRecorderDeps>): MicRecorderDeps {
  const g = globalThis as unknown as Record<string, unknown>
  return {
    getUserMedia: d.getUserMedia ?? ((c) => navigator.mediaDevices.getUserMedia(c) as Promise<unknown> as Promise<MicStream>),
    WebSocket: d.WebSocket ?? (g.WebSocket as WsCtor),
    AudioEncoder: d.AudioEncoder ?? (g.AudioEncoder as EncoderCtor),
    AudioData: d.AudioData ?? (g.AudioData as AudioDataCtor),
    MediaStreamTrackProcessor: d.MediaStreamTrackProcessor ?? (g.MediaStreamTrackProcessor as TrackProcessorCtor | undefined),
    now: d.now ?? (() => performance.now()),
    timers: d.timers ?? browserMicTimers,
  }
}

/* ------------------------------------------------------------------ */
/* capture                                                             */
/* ------------------------------------------------------------------ */

/** Any channel count → mono, the way PipeWire/PulseAudio remix for
 *  voice-typing's `channels=1`: the mean of the channels ((L+R)·0.5 for
 *  stereo).  A mono device opened as stereo comes back bit for bit. */
export function toMono(ad: Pick<CapturedAudio, 'numberOfChannels' | 'numberOfFrames' | 'copyTo'>): Float32Array {
  const n = ad.numberOfChannels
  const frames = ad.numberOfFrames
  const plane = (c: number): Float32Array => {
    const b = new Float32Array(frames)
    ad.copyTo(b, { planeIndex: c, format: 'f32-planar' })
    return b
  }
  if (n === 1) return plane(0)
  if (n === 2) {
    const a = plane(0)
    const b = plane(1)
    for (let i = 0; i < frames; i++) a[i] = ((a[i] ?? 0) + (b[i] ?? 0)) * 0.5
    return a
  }
  const out = plane(0)
  for (let c = 1; c < n; c++) {
    const b = plane(c)
    for (let i = 0; i < frames; i++) out[i] = (out[i] ?? 0) + (b[i] ?? 0)
  }
  for (let i = 0; i < frames; i++) out[i] = (out[i] ?? 0) / n
  return out
}

export interface CapturedBuffer {
  mono: Float32Array
  frames: number
  sampleRate: number
  channels: number
  format: string | null
  timestamp: number
  /** now() when it was read. */
  tRead: number
  /** Its last sample's capture time, on now()'s clock. */
  tEnd: number
}

export interface CaptureStats {
  buffers: number
  afterRelease: number
  tRelease: number | null
  tDrained: number | null
  /** now() − capture end, the smallest seen: the clock offset plus the fastest delivery. */
  k: number | null
  reads: [number, number][]
  untilMs?: number
}

export interface MicHandle {
  readonly track: MicTrack
  readonly settings: MediaTrackSettings
  readonly stats: CaptureStats
  /** Keep reading until the buffer that holds `until` (the Stop click) arrived,
   *  at most `maxWaitMs`, then stop the track and drain the reader. */
  release(o?: { until?: number | null; maxWaitMs?: number }): Promise<CaptureStats>
  /** Stop the device and stop reading; queued buffers are dropped. */
  abort(): void
}

export interface OpenMicOptions {
  getUserMedia(c: MediaStreamConstraints): Promise<MicStream>
  MediaStreamTrackProcessor: TrackProcessorCtor | undefined
  maxBufferSize: number
  now(): number
  timers: WireTimers
  /** Called once, before the first buffer is read. */
  onOpen?(mic: MicHandle): void
  onAudio(a: CapturedBuffer): void
  /** Once, when reading stops.  `unexpected`: not after release() or abort(). */
  onEnd(e: { unexpected: boolean; error: unknown }): void
}

/** Opens the default input with every DSP off and reads it through
 *  MediaStreamTrackProcessor, with no Web Audio hop. */
export async function openMic(o: OpenMicOptions): Promise<MicHandle> {
  const stream = await o.getUserMedia({ audio: RAW_CONSTRAINTS })
  const stopAll = (): void => {
    for (const t of stream.getTracks()) {
      try {
        t.stop()
      } catch {
        /* already stopped */
      }
    }
  }
  const track = stream.getAudioTracks()[0]
  if (!track) {
    stopAll()
    throw Object.assign(new Error('no audio track'), { name: 'NotFoundError' })
  }
  let reader: TrackReader
  try {
    const Mstp = o.MediaStreamTrackProcessor
    if (!Mstp) throw new TypeError('MediaStreamTrackProcessor is not available')
    reader = new Mstp({ track, maxBufferSize: o.maxBufferSize }).readable.getReader()
  } catch (e) {
    // the device is open: never leave it so
    stopAll()
    throw e
  }
  let released = false
  // assigned inside closures, so declared without the initial narrowing to null
  let waiter = null as { until: number; resolve(): void } | null
  const stats: CaptureStats = { buffers: 0, afterRelease: 0, tRelease: null, tDrained: null, k: null, reads: [] }
  let pump: Promise<void> = Promise.resolve()

  const handle: MicHandle = {
    track,
    settings: track.getSettings(),
    stats,
    async release({ until = null, maxWaitMs = 50 } = {}) {
      if (released) {
        await pump
        return stats
      }
      if (until !== null) {
        stats.untilMs = until
        // track.stop() drops whatever the processor still holds (measured), so
        // audio captured before the click is read first.
        await new Promise<void>((resolve) => {
          const timer = o.timers.setTimeout(() => {
            waiter = null
            resolve()
          }, maxWaitMs)
          waiter = {
            until,
            resolve: () => {
              o.timers.clearTimeout(timer)
              resolve()
            },
          }
        })
        waiter = null
      }
      released = true
      stats.tRelease = o.now()
      stopAll()
      await pump
      return stats
    },
    abort() {
      released = true
      if (waiter) {
        const w = waiter
        waiter = null
        w.resolve()
      }
      stopAll()
      try {
        reader.cancel().catch(() => {})
      } catch {
        /* already cancelled */
      }
    },
  }

  track.addEventListener('ended', () => {
    /* the reader ends with the track; onEnd reports it */
  })
  o.onOpen?.(handle)

  pump = (async () => {
    for (;;) {
      let r: { done: boolean; value?: CapturedAudio | undefined }
      try {
        r = await reader.read()
      } catch (e) {
        o.onEnd({ unexpected: !released, error: e })
        return
      }
      if (r.done || !r.value) {
        stats.tDrained = o.now()
        o.onEnd({ unexpected: !released, error: null })
        return
      }
      const ad = r.value
      const tRead = o.now()
      stats.buffers++
      if (released) stats.afterRelease++
      let mono: Float32Array
      try {
        mono = toMono(ad)
      } catch (e) {
        ad.close()
        o.onEnd({ unexpected: !released, error: e })
        return
      }
      // AudioData.timestamp is the capture time in µs on the clock now() runs
      // on, offset by the time origin; k maps it onto now().
      const endMs = (ad.timestamp + (ad.numberOfFrames * 1e6) / ad.sampleRate) / 1000
      const k = tRead - endMs
      if (stats.k === null || k < stats.k) stats.k = k
      const item: CapturedBuffer = {
        mono, frames: ad.numberOfFrames, sampleRate: ad.sampleRate, channels: ad.numberOfChannels,
        format: ad.format ?? null, timestamp: ad.timestamp, tRead, tEnd: endMs + stats.k,
      }
      if (stats.reads.length < 20000) stats.reads.push([+tRead.toFixed(2), +(endMs + stats.k).toFixed(2)])
      ad.close()
      o.onAudio(item)
      if (waiter && item.tEnd >= waiter.until) {
        const w = waiter
        waiter = null
        w.resolve()
      }
    }
  })()
  return handle
}

/* ------------------------------------------------------------------ */
/* the encoder                                                         */
/* ------------------------------------------------------------------ */

export interface OpusPacket {
  bytes: Uint8Array
  timestamp: number
  duration: number | null
  /** The OpusHead from the first output's decoderConfig. */
  description: Uint8Array | null
  tOut: number
  sinceLastEncodeMs: number
}

function copyBytes(d: ArrayBuffer | ArrayBufferView): Uint8Array {
  return ArrayBuffer.isView(d)
    ? new Uint8Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength))
    : new Uint8Array(d.slice(0))
}

/** WebCodecs Opus at voice-typing's settings, configured at the first buffer's rate. */
export class OpusStreamEncoder {
  sampleRate = 0
  inFrames = 0
  packets = 0
  description: Uint8Array | null = null
  private enc: EncoderLike | null = null
  private lastEncodeAt = 0

  constructor(private readonly o: {
    AudioEncoder: EncoderCtor
    AudioData: AudioDataCtor
    now(): number
    onPacket(p: OpusPacket): void
    onError(e: unknown): void
  }) {}

  configure(sampleRate: number): void {
    this.sampleRate = sampleRate
    this.enc = new this.o.AudioEncoder({
      output: (chunk, meta) => {
        const bytes = new Uint8Array(chunk.byteLength)
        chunk.copyTo(bytes)
        const d = meta?.decoderConfig?.description
        if (!this.description && d) this.description = copyBytes(d)
        this.packets++
        const t = this.o.now()
        this.o.onPacket({ bytes, timestamp: chunk.timestamp, duration: chunk.duration, description: this.description, tOut: t, sinceLastEncodeMs: t - this.lastEncodeAt })
      },
      error: (e) => this.o.onError(e),
    })
    this.enc.configure(opusConfig(sampleRate))
  }

  encode(mono: Float32Array, sampleRate: number, timestamp: number): void {
    if (!this.enc) this.configure(sampleRate)
    if (sampleRate !== this.sampleRate) throw new Error(`sample rate changed ${this.sampleRate} -> ${sampleRate}`)
    const ad = new this.o.AudioData({ format: 'f32-planar', sampleRate, numberOfFrames: mono.length, numberOfChannels: 1, timestamp, data: mono })
    this.inFrames += mono.length
    this.lastEncodeAt = this.o.now()
    try {
      this.enc?.encode(ad)
    } finally {
      ad.close()
    }
  }

  /** Input samples so far, on the Opus clock (48 kHz). */
  get inFrames48(): number {
    return this.sampleRate ? Math.round((this.inFrames * 48000) / this.sampleRate) : 0
  }

  async flush(): Promise<void> {
    if (this.enc && this.enc.state === 'configured') await this.enc.flush()
  }

  close(): void {
    if (this.enc && this.enc.state !== 'closed') {
      try {
        this.enc.close()
      } catch {
        /* already closed */
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* the take                                                            */
/* ------------------------------------------------------------------ */

export type MicState = 'idle' | 'arming' | 'recording' | 'stopping' | 'transcribing'
/** 'left' = leaving the book; 'user' = a discard.  Only 'short' and 'cap' speak. */
export type MicCancelReason = 'user' | 'short' | 'cap' | 'left'

/** The final answer: `text` trimmed, '' = no speech; the word timings only when
 *  the service sent them. */
export interface MicAnswer {
  text: string
  first_word_ms?: number
  last_word_ms?: number
}

export interface PacketStat {
  k: number
  tOut: number
  encMs: number
  ts: number
  dur: number | null
  n: number
  tSend?: number
}

export interface TakeStats {
  buffers: number
  frames: number
  packets: PacketStat[]
  first?: { sampleRate: number; channels: number; format: string | null; frames: number; startMs: number }
  drain?: { clickToReleaseMs: number; buffersAfterRelease: number; releaseToDrainedMs: number; lastBufferEndMinusClickMs: number | null; k: number | null }
  tail?: { packets: number; inFrames: number; inFrames48: number; total48: number; need48: number; padding48: number; tailCovered: boolean; heldAfterStop: number; stopToFlushedMs: number }
  elapsedMs?: number
  keptBytes?: number
  attempt1?: AttemptStat
  attempt2?: AttemptStat
  firstError?: string
}

export interface AttemptStat {
  result: Attempt['kind']
  code: number | null
  beforeStop: boolean | null
  sentBytes: number
  sentFrames: number
  stopToResultMs: number | null
}

export interface MicRecorderEvents {
  armed: { gumMs: number; settings: MediaTrackSettings }
  'first-audio': { armMs: number; sampleRate: number; channels: number }
  stopping: Record<string, never>
  /** The floors passed and "stop" went out.  `clip` is exactly the bytes sent
   *  (the retry sends them again); `answer` resolves with the final answer,
   *  after any retry, or null on any other ending.  It never rejects. */
  sent: { clip: Blob; audioMs: number; answer: Promise<MicAnswer | null> }
  done: MicAnswer & { clip: Blob; audioMs: number; retried: boolean; stats: TakeStats }
  /** `message` is the whole line: "Transcription failed — …". */
  failed: { message: string; reason: string; retried: boolean; stats: TakeStats }
  /** A code; the UI owns the words.  `detail` is the exception's name, for logs. */
  'mic-failed': { error: MicError; detail: string }
  cancelled: { reason: MicCancelReason; stats: TakeStats }
}

export interface MicRecorderOptions extends Partial<MicRecorderSettings> {
  /** The ai-service origin.  Required: there is no default, and a missing or
   *  bad one fails the take closed without dialling anything. */
  base: string
  deps?: Partial<MicRecorderDeps>
  /** A handler that threw, or a bug in the stop path. */
  onError?: (err: unknown, context: string) => void
}

export interface MicRecorder {
  readonly state: MicState
  /** Opens the microphone.  False, and nothing happens, unless idle. */
  start(): boolean
  /** True when the take was recording and now stops; otherwise false and
   *  nothing happens (an arming take is discarded with cancel()). */
  stop(): boolean
  /** Discard from any non-idle state: the mic released, the socket closed
   *  without "stop", the bytes dropped.  Fires `cancelled` with the reason. */
  cancel(reason?: MicCancelReason): boolean
  on<K extends keyof MicRecorderEvents>(type: K, fn: (d: MicRecorderEvents[K]) => void): () => void
}

interface Take {
  tClick: number
  tGum: number | null
  tFirst: number | null
  tStop: number | null
  mic: MicHandle | null
  enc: OpusStreamEncoder | null
  writer: LiveWebmWriter | null
  sock: TakeSocket | null
  sock2: TakeSocket | null
  headerBytes: Uint8Array | null
  kept: Uint8Array[]
  keptBytes: number
  packets: number
  held: { k: number; payload: Uint8Array }[]
  lastAudioEnd: number | null
  capTimer: unknown
  answer: Promise<MicAnswer | null>
  settleAnswer(a: MicAnswer | null): void
  stats: TakeStats
}

type Handler = (d: never) => void

const errName = (e: unknown): string => {
  const n = (e as { name?: unknown } | null)?.name
  return typeof n === 'string' ? n : String(e)
}

class Recorder implements MicRecorder {
  private _state: MicState = 'idle'
  private take: Take | null = null
  private readonly s: MicRecorderSettings
  private readonly handlers = new Map<keyof MicRecorderEvents, Handler[]>()
  private readonly onError: (err: unknown, context: string) => void
  private deps: MicRecorderDeps | null = null

  constructor(private readonly o: MicRecorderOptions) {
    const { base: _base, deps: _deps, onError, ...settings } = o
    this.s = { ...DEFAULTS, ...settings }
    this.onError = onError ?? ((err, context) => console.error('cairn[' + context + ']:', err))
  }

  get state(): MicState {
    return this._state
  }

  private get d(): MicRecorderDeps {
    if (!this.deps) this.deps = liveDeps(this.o.deps ?? {})
    return this.deps
  }

  on<K extends keyof MicRecorderEvents>(type: K, fn: (d: MicRecorderEvents[K]) => void): () => void {
    let list = this.handlers.get(type)
    if (!list) {
      list = []
      this.handlers.set(type, list)
    }
    const l = list
    const h = fn as Handler
    l.push(h)
    return () => {
      const i = l.indexOf(h)
      if (i >= 0) l.splice(i, 1)
    }
  }

  private emit<K extends keyof MicRecorderEvents>(type: K, detail: MicRecorderEvents[K]): void {
    for (const fn of [...(this.handlers.get(type) ?? [])]) {
      try {
        ;(fn as (d: MicRecorderEvents[K]) => void)(detail)
      } catch (e) {
        this.onError(e, 'mic-recorder ' + type)
      }
    }
  }

  private socket(): TakeSocket {
    const d = this.d
    return new TakeSocket(transcribeUrl(this.o.base, this.s.mime), {
      WebSocket: d.WebSocket, connectTimeoutMs: this.s.connectTimeoutMs, now: d.now, timers: d.timers,
    })
  }

  start(): boolean {
    if (this._state !== 'idle') return false
    const d = this.d
    let settleAnswer: (a: MicAnswer | null) => void = () => {}
    const answer = new Promise<MicAnswer | null>((resolve) => { settleAnswer = resolve })
    const take: Take = {
      tClick: d.now(), tGum: null, tFirst: null, tStop: null,
      mic: null, enc: null, writer: null, sock: null, sock2: null, headerBytes: null,
      kept: [], keptBytes: 0, packets: 0, held: [], lastAudioEnd: null, capTimer: null,
      answer, settleAnswer, stats: { buffers: 0, frames: 0, packets: [] },
    }
    this.take = take
    this._state = 'arming'
    // The cap runs from the click, so a getUserMedia that never answers is bounded too.
    this.startCapTimer(take)
    const mine = (): boolean => this.take === take && this._state !== 'idle'
    openMic({
      getUserMedia: d.getUserMedia,
      MediaStreamTrackProcessor: d.MediaStreamTrackProcessor,
      maxBufferSize: this.s.maxBufferSize,
      now: d.now,
      timers: d.timers,
      onOpen: (mic) => {
        if (!mine()) {
          mic.abort()
          return
        }
        take.mic = mic
        take.tGum = d.now()
        this.emit('armed', { gumMs: take.tGum - take.tClick, settings: mic.settings })
      },
      onAudio: (a) => {
        if (mine()) this.onAudio(take, a)
      },
      onEnd: (e) => {
        if (mine() && e.unexpected && (this._state === 'arming' || this._state === 'recording')) this.micFailed(take, e.error)
      },
    }).catch((err: unknown) => {
      if (!mine()) return
      const name = errName(err)
      const denied = name === 'NotAllowedError' || name === 'SecurityError'
      this.end(take)
      this.emit('mic-failed', { error: denied ? 'denied' : 'unavailable', detail: name })
    })
    return true
  }

  private onAudio(take: Take, a: CapturedBuffer): void {
    const d = this.d
    take.stats.buffers++
    take.stats.frames += a.frames
    take.lastAudioEnd = a.tEnd
    if (!take.stats.first) {
      take.stats.first = { sampleRate: a.sampleRate, channels: a.channels, format: a.format, frames: a.frames, startMs: a.tEnd - (a.frames * 1000) / a.sampleRate }
    }
    if (this._state === 'arming') {
      // voice-typing: the first captured buffer starts "recording" and opens the stream.
      this._state = 'recording'
      take.tFirst = a.tRead
      take.sock = this.socket()
      take.enc = new OpusStreamEncoder({
        AudioEncoder: d.AudioEncoder, AudioData: d.AudioData, now: d.now,
        onPacket: (p) => this.onPacket(take, p),
        onError: (e) => this.micFailed(take, e),
      })
      take.writer = new LiveWebmWriter({ frameMs: this.s.frameMs })
      this.emit('first-audio', { armMs: take.tFirst - take.tClick, sampleRate: a.sampleRate, channels: a.channels })
    }
    if (this.take !== take || (this._state !== 'recording' && this._state !== 'stopping')) return
    // The cap on the captured audio as well as the poll: a hidden window's
    // timers are throttled to about 1 Hz, capture is not.
    if (this._state === 'recording' && (take.stats.frames * 1000) / a.sampleRate >= this.s.capMs) {
      this.cancel('cap')
      return
    }
    try {
      take.enc?.encode(a.mono, a.sampleRate, a.timestamp)
    } catch (e) {
      this.micFailed(take, e)
    }
  }

  private onPacket(take: Take, p: OpusPacket): void {
    if (this.take !== take || !take.writer) return
    const k = take.packets++
    take.stats.packets.push({ k, tOut: p.tOut, encMs: +p.sinceLastEncodeMs.toFixed(2), ts: p.timestamp, dur: p.duration, n: p.bytes.byteLength })
    if (!take.headerBytes) take.headerBytes = take.writer.header(p.description)
    // Held after the click: the last one needs its DiscardPadding.
    if (this._state === 'stopping') {
      take.held.push({ k, payload: p.bytes })
      return
    }
    this.write(take, k, p.bytes, 0)
  }

  private write(take: Take, k: number, payload: Uint8Array, discardPaddingNs: number): void {
    if (!take.writer) return
    let bytes = take.writer.packet(payload, k * this.s.frameMs, { discardPaddingNs })
    if (k === 0 && take.headerBytes) bytes = concat([take.headerBytes, bytes])
    take.kept.push(bytes)
    take.keptBytes += bytes.byteLength
    const t = this.d.now()
    take.sock?.send(bytes)
    const ps = take.stats.packets[k]
    if (ps) ps.tSend = t
  }

  stop(): boolean {
    const take = this.take
    if (this._state !== 'recording' || !take) return false
    this._state = 'stopping'
    take.tStop = this.d.now()
    this.stopCapTimer(take)
    this.emit('stopping', {})
    this.finish(take).catch((e: unknown) => this.crashed(take, e))
    return true
  }

  /** Release the mic, flush the encoder, write the held tail, the floors,
   *  "stop", then the answer and at most one retry. */
  private async finish(take: Take): Promise<void> {
    const { mic, enc } = take
    if (this.take !== take || !mic || !enc || take.tStop === null || take.tFirst === null) return
    const d = this.d
    const tStop = take.tStop
    const drain = await mic.release({ until: tStop, maxWaitMs: this.s.releaseWaitMs })
    take.stats.drain = {
      clickToReleaseMs: (drain.tRelease ?? tStop) - tStop, buffersAfterRelease: drain.afterRelease,
      releaseToDrainedMs: (drain.tDrained ?? 0) - (drain.tRelease ?? 0),
      lastBufferEndMinusClickMs: take.lastAudioEnd !== null ? take.lastAudioEnd - tStop : null, k: drain.k,
    }
    if (this.take !== take) return
    let drainTimer: unknown = null
    try {
      await Promise.race([enc.flush(), new Promise<void>((r) => { drainTimer = d.timers.setTimeout(r, this.s.drainTimeoutMs) })])
    } catch {
      /* closed by a cancel */
    }
    d.timers.clearTimeout(drainTimer)
    if (this.take !== take) return
    enc.close()
    const oh = enc.description && readOpusHead(enc.description)
    const preSkip = oh ? oh.preSkip : 312
    const total48 = take.packets * 2880
    const need48 = enc.inFrames48 + preSkip
    const pad = total48 - need48
    take.stats.tail = {
      packets: take.packets, inFrames: enc.inFrames, inFrames48: enc.inFrames48, total48, need48, padding48: pad,
      tailCovered: pad >= 0, heldAfterStop: take.held.length, stopToFlushedMs: d.now() - tStop,
    }
    const held = take.held
    take.held = []
    held.forEach((h, i) => this.write(take, h.k, h.payload, i === held.length - 1 && pad > 0 && pad < 2880 ? Math.round((pad * 1e9) / 48000) : 0))
    const elapsed = tStop - take.tFirst
    take.stats.elapsedMs = elapsed
    take.stats.keptBytes = take.keptBytes
    const sock = take.sock
    if (!sock || elapsed < this.s.minMs || take.keptBytes < this.s.minBytes) {
      sock?.abort()
      this.end(take)
      take.settleAnswer(null)
      this.emit('cancelled', { reason: 'short', stats: take.stats })
      return
    }

    this._state = 'transcribing'
    const clip = new Blob(take.kept as BlobPart[], { type: this.s.clipType })
    const audioMs = enc.inFrames48 / 48
    const first = sock.finish(this.s.deadlineMs) // "stop" goes out here
    this.emit('sent', { clip, audioMs, answer: take.answer })
    const a1 = await first
    if (this.take !== take) return
    take.stats.attempt1 = attemptStat(a1, sock)
    sock.abort() // the answer is in; voice-typing closes the connection after reading
    let v: Verdict = classifyReply(a1)
    let retried = false
    if (v.kind === 'retry') {
      retried = true
      take.stats.firstError = v.reason
      const sock2 = (take.sock2 = this.socket())
      for (const b of coalesce(take.kept)) sock2.send(b)
      const a2 = await sock2.finish(this.s.deadlineMs)
      if (this.take !== take) return
      take.stats.attempt2 = attemptStat(a2, sock2)
      sock2.abort()
      v = classifyReply(a2)
      if (v.kind === 'retry') v = { ...v, kind: 'fail' }
    }
    this.end(take)
    if (v.kind === 'text' || v.kind === 'empty') {
      const answer: MicAnswer = { text: v.text }
      if (v.first_word_ms !== undefined) answer.first_word_ms = v.first_word_ms
      if (v.last_word_ms !== undefined) answer.last_word_ms = v.last_word_ms
      take.settleAnswer(answer)
      this.emit('done', { ...answer, clip, audioMs, retried, stats: take.stats })
    } else {
      take.settleAnswer(null)
      this.emit('failed', { message: failedLine(v.message), reason: v.reason, retried, stats: take.stats })
    }
  }

  cancel(reason: MicCancelReason = 'user'): boolean {
    const take = this.take
    if (!take || this._state === 'idle') return false
    this.teardown(take)
    this.end(take)
    take.settleAnswer(null)
    this.emit('cancelled', { reason, stats: take.stats })
    return true
  }

  private micFailed(take: Take, err: unknown): void {
    if (this.take !== take) return
    this.teardown(take)
    this.end(take)
    take.settleAnswer(null)
    this.emit('mic-failed', { error: 'unavailable', detail: errName(err) })
  }

  /** A bug in the stop path must still end the take, once. */
  private crashed(take: Take, err: unknown): void {
    this.onError(err, 'mic-recorder')
    if (this.take !== take) return
    this.teardown(take)
    this.end(take)
    take.settleAnswer(null)
    this.emit('failed', { message: failedLine('no answer'), reason: 'error: ' + errName(err), retried: false, stats: take.stats })
  }

  private teardown(take: Take): void {
    take.mic?.abort()
    take.enc?.close()
    take.sock?.abort()
    take.sock2?.abort()
    take.kept = []
    take.held = []
  }

  private startCapTimer(take: Take): void {
    const { timers, now } = this.d
    take.capTimer = timers.setInterval(() => {
      if (this.take !== take) {
        timers.clearInterval(take.capTimer)
        return
      }
      const t = now()
      const over = this._state === 'recording' && take.tFirst !== null
        ? t - take.tFirst >= this.s.capMs
        : this._state === 'arming' ? t - take.tClick >= this.s.capMs : false
      if (over) this.cancel('cap')
    }, this.s.capPollMs)
  }

  private stopCapTimer(take: Take): void {
    this.d.timers.clearInterval(take.capTimer)
  }

  private end(take: Take): void {
    this.stopCapTimer(take)
    if (this.take === take) {
      this.take = null
      this._state = 'idle'
    }
  }
}

function attemptStat(a: Attempt, sock: TakeSocket): AttemptStat {
  return {
    result: a.kind,
    code: a.kind === 'closed' ? a.code : null,
    beforeStop: 'beforeStop' in a ? a.beforeStop : null,
    sentBytes: sock.sentBytes,
    sentFrames: sock.sentFrames,
    stopToResultMs: sock.tStop !== null ? a.t - sock.tStop : null,
  }
}

/** One recorder runs one take at a time; it is reusable after every ending.
 *  Constructing it opens nothing and touches no browser global. */
export function createMicRecorder(o: MicRecorderOptions): MicRecorder {
  return new Recorder(o)
}
