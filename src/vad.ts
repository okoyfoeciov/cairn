/**
 * src/vad.ts
 * Owner: 03.  Spec: CONTRACT.md §0.58 E111 — the voice-activity oracle behind the
 * playback trim: comart's vendor/silero/vad.js (Silero VAD v6 over
 * onnxruntime-web 1.22.0).
 *
 * comart runs it on its offscreen document's main thread, and Chrome closes
 * that document when idle, which frees the WASM heap.  Cairn's page lives for
 * the session, so the model runs in a Worker made per take and terminated with
 * it, which gives the heap back; a Worker is also not throttled in a hidden
 * window.  The frame rules (segments, pick) stay here, synchronous, exactly as
 * trimClip calls them; warm() and probabilities() are vad.js's own, in
 * src/vad-worker.ts.  The same worker does the trim's sample work (TrimWork),
 * so a long take's WAV encode is not a main-thread task.
 *
 * The worker's code — ort, the .mjs, the wasm and the model — is one string
 * inside app.js (build-app.mjs's `__CAIRN_VAD_WORKER__`): the page stays one
 * self-contained file and nothing is loaded from file:// at run time.
 */

import { monoMix, voicedBounds, wavBlob, type TrimWork } from './mic-trim'

/* vad.js:21-27 */
export const FRAME = 512          // 32ms at 16kHz
export const CONTEXT = 64         // tail of the previous frame
export const SR = 16000
export const POS = 0.5            // Silero's default speech threshold
export const NEG = 0.35           // its default neg_threshold (POS - 0.15)
export const MIN_SIL_MS = 100     // silence this long ends a segment
export const MIN_SPEECH_MS = 100  // shorter blips are not words

/** Seconds from the first sample. */
export interface VadSegment {
  start: number
  end: number
}

export interface VadProbs {
  /** One p(voice) per 32 ms frame. */
  probs: Float32Array
  frameSec: number
}

export type VadPick =
  | (VadSegment & { segments: VadSegment[]; how: 'first' | 'contains' | 'nearest' })
  | { segments: VadSegment[]; start: null; how: 'no-speech' | 'none-near' }

export interface Vad {
  /** Creates the session once; rejects on failure, and a later call retries. */
  warm(): Promise<void>
  /** 16 kHz mono.  The samples are transferred to the worker: `audio` is
   *  detached once this returns. */
  probabilities(audio: Float32Array): Promise<VadProbs>
  segments(probs: Float32Array, frameSec: number): VadSegment[]
  pick(probs: Float32Array, frameSec: number, anchorSec: number): VadPick
}

// Silero's own hysteresis: start at POS, end after MIN_SIL_MS below NEG,
// and drop segments shorter than MIN_SPEECH_MS. Times are seconds.
export function segments(probs: Float32Array, frameSec: number): VadSegment[] {
  const minSil = Math.max(1, Math.round((MIN_SIL_MS / 1000) / frameSec))
  const minSpeech = Math.max(1, Math.round((MIN_SPEECH_MS / 1000) / frameSec))
  const out: VadSegment[] = []
  let inSpeech = false, start = 0, quietAt = 0

  for (let i = 0; i < probs.length; i++) {
    const p = probs[i]!
    if (!inSpeech) {
      if (p >= POS) { inSpeech = true; start = i; quietAt = 0 }
      continue
    }
    if (p < NEG) {
      if (!quietAt) quietAt = i
      if (i - quietAt + 1 >= minSil) {
        if (quietAt - start >= minSpeech) {
          out.push({ start: start * frameSec, end: quietAt * frameSec })
        }
        inSpeech = false
        quietAt = 0
      }
    } else if (p >= POS) {
      quietAt = 0                    // the dip was a false negative
    }
  }
  if (inSpeech && probs.length - start >= minSpeech) {
    out.push({ start: start * frameSec, end: probs.length * frameSec })
  }
  return out
}

// Which segment is the word? The anchor is first_word_ms; the VAD supplies
// the acoustic edge. A segment containing the anchor (with 150ms tolerance)
// wins; otherwise the nearest start within 800ms. Nothing near the anchor
// means "do not trust the VAD here".
export function pick(probs: Float32Array, frameSec: number, anchorSec: number): VadPick {
  const segs = segments(probs, frameSec)
  if (!segs.length) return { segments: segs, start: null, how: 'no-speech' }
  if (!Number.isFinite(anchorSec)) {
    return { ...segs[0]!, segments: segs, how: 'first' }
  }
  for (const s of segs) {
    if (anchorSec >= s.start - 0.15 && anchorSec <= s.end + 0.15) {
      return { ...s, segments: segs, how: 'contains' }
    }
  }
  let best: VadSegment | null = null, bestD = Infinity
  for (const s of segs) {
    const d = Math.abs(s.start - anchorSec)
    if (d < bestD) { bestD = d; best = s }
  }
  if (best && bestD <= 0.8) return { ...best, segments: segs, how: 'nearest' }
  return { segments: segs, start: null, how: 'none-near' }
}

/* ------------------------------------------------------------------ */
/* the Worker host                                                    */
/* ------------------------------------------------------------------ */

/** What the host uses of a Worker; tests pass a fake. */
export interface VadWorkerPort {
  postMessage(message: unknown, transfer: Transferable[]): void
  addEventListener(type: 'message' | 'error' | 'messageerror', listener: (ev: Event) => void): void
  terminate(): void
}

/** The page → worker messages, and its answers (src/vad-worker.ts). */
export type VadRequest =
  | { id: number; type: 'warm' }
  | { id: number; type: 'probabilities'; x: Float32Array }
  | { id: number; type: 'bounds'; channels: Float32Array[]; sr: number }
  | { id: number; type: 'wav'; a: number; z: number }
export type VadReply =
  | { id: number; ok: true; probs?: Float32Array; frameSec?: number; length?: number; bounds?: VadSegment | null; blob?: Blob }
  | { id: number; ok: false; error: string }

/** The worker bundle app.js carries; '' in a bundle built without it (unit
 *  tests).  Read in exactly one place, so app.js holds it once. */
function payload(): string {
  try {
    return __CAIRN_VAD_WORKER__
  } catch {
    return ''
  }
}

/** The payload as a Blob, made at the first take and kept for the page: the
 *  Blob copies the whole string, 25-100 ms on the page's thread, and a take
 *  must not pay that between its click and getUserMedia. */
let payloadBlob: Blob | null = null

function payloadWorker(): VadWorkerPort {
  if (!payloadBlob) {
    const src = payload()
    if (!src) throw new Error('the VAD payload is not in this build')
    payloadBlob = new Blob([src], { type: 'text/javascript' })
  }
  const url = URL.createObjectURL(payloadBlob)
  // The URL is resolved when the Worker is constructed, so it can go now.
  try {
    return new Worker(url)
  } finally {
    URL.revokeObjectURL(url)
  }
}

/**
 * comart's VAD in a Worker of its own, which also does the trim's sample work
 * (TrimWork).  Nothing starts until the first call.  An `error` or
 * `messageerror` from the worker rejects every pending call and ends the host
 * for good, as dispose() does: a dead VAD must reject, never leave trimClip
 * waiting.  The sample work then runs on the page instead, so a dead worker
 * still leaves comart's rules 2 and 3.
 */
export function sileroVadWorker(make: () => VadWorkerPort = payloadWorker): Vad & TrimWork & { dispose(): void } {
  let worker: VadWorkerPort | null = null
  let dead: string | null = null
  let seq = 0
  const pending = new Map<number, { resolve: (r: VadReply) => void; reject: (e: Error) => void }>()

  const end = (why: string): void => {
    if (dead) return
    dead = why
    if (worker) { try { worker.terminate() } catch { /* already gone */ } }
    worker = null
    const calls = [...pending.values()]
    pending.clear()
    for (const p of calls) p.reject(new Error(why))
  }

  const port = (): VadWorkerPort => {
    if (worker) return worker
    const w = make()
    w.addEventListener('message', (ev) => {
      const r = (ev as MessageEvent<VadReply>).data
      const p = pending.get(r.id)
      if (!p) return
      pending.delete(r.id)
      p.resolve(r)
    })
    w.addEventListener('error', (ev) => {
      ev.preventDefault()
      end('VAD worker error: ' + ((ev as ErrorEvent).message || 'unknown'))
    })
    w.addEventListener('messageerror', () => end('VAD worker messageerror'))
    worker = w
    return w
  }

  const call = (req: VadRequest, transfer: Transferable[]): Promise<VadReply> =>
    new Promise((resolve, reject) => {
      if (dead) { reject(new Error(dead)); return }
      try {
        const w = port()
        pending.set(req.id, { resolve, reject })
        w.postMessage(req, transfer)
      } catch (e) {
        pending.delete(req.id)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    }).then((r) => {
      const reply = r as VadReply
      if (!reply.ok) throw new Error(reply.error)
      return reply
    })

  // The clip the sample work is about.  Its channels are posted as copies: the
  // page keeps them for the fallback.
  let clipBuf: AudioBuffer | null = null
  let mixed: Float32Array | null = null
  let remote = false
  const mix = (): Float32Array => {
    if (!clipBuf) throw new Error('no clip')
    mixed ??= monoMix(clipBuf)
    return mixed
  }

  return {
    async warm() {
      await call({ id: ++seq, type: 'warm' }, [])
    },
    async probabilities(audio) {
      const r = await call({ id: ++seq, type: 'probabilities', x: audio }, [audio.buffer as ArrayBuffer])
      if (!r.ok || !r.probs || r.frameSec === undefined) throw new Error('VAD worker returned no probabilities')
      return { probs: r.probs, frameSec: r.frameSec }
    },
    segments,
    pick,
    async bounds(buf) {
      clipBuf = buf
      mixed = null
      remote = false
      const channels: Float32Array[] = []
      for (let c = 0; c < buf.numberOfChannels; c++) channels.push(buf.getChannelData(c))
      try {
        const r = await call({ id: ++seq, type: 'bounds', channels, sr: buf.sampleRate }, [])
        if (r.ok && r.length !== undefined && r.bounds !== undefined) {
          remote = true
          return { length: r.length, bounds: r.bounds }
        }
      } catch { /* the page does it */ }
      const x = mix()
      return { length: x.length, bounds: voicedBounds(x, buf.sampleRate) }
    },
    async wav(a, z) {
      if (remote) {
        try {
          const r = await call({ id: ++seq, type: 'wav', a, z }, [])
          if (r.ok && r.blob) return r.blob
        } catch { /* the page does it */ }
      }
      const x = mix()
      return wavBlob(x.subarray(a, z), clipBuf!.sampleRate)
    },
    dispose() {
      end('VAD disposed')
    },
  }
}
