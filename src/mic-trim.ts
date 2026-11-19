/**
 * src/mic-trim.ts
 * Owner: 03.  Spec: CONTRACT.md §0.58 E111 — comart's playback trim
 * (offscreen.js:353-678) and its output-sink wake (:86-145), ported as is.
 *
 * Between the click and the first word there is always a gap, and the card
 * autoplays the whole clip, so the player would open on silence.  The trim cuts
 * the clip from just before the first word to just after the last one, and
 * re-encodes it as a 16-bit mono WAV, which has a real duration: the recorder's
 * live WebM has none, so seeking it is best-effort and its clock would read the
 * untrimmed length.
 *
 * Where the cut goes, in order of trust (trimClip's three rules):
 *   1. the recognizer's first word (`first_word_ms`) chooses WHICH Silero VAD
 *      segment holds it, and the cut is that segment's edge less 10 ms — unless
 *      the edge is more than 50 ms after the word, when it missed a soft onset;
 *   2. no usable VAD answer: the word itself less 150 ms, because the recognizer
 *      marks where it recognized the word, 40-135 ms after the attack;
 *   3. no timings either: the energy detector (voicedBounds).
 * The end is the last word + 150 ms, else the VAD/energy end + 250 ms.
 *
 * The decode, the VAD and the encode start at Stop and are awaited only when
 * the card is about to open, so the transcription round trip hides them.  Any
 * failure gives null, and the recording plays as recorded.
 */

import type { Vad, VadSegment } from './vad'

/* offscreen.js:39-52 */
// The lead before the VAD's edge; the tail exists only so the last consonant
// is not cut off mid-decay.
export const TRIM_LEAD_SECS = 0.010
export const TRIM_TAIL_SECS = 0.250
// The recognizer's last word is the semantic end of speech; its timestamp is
// the word's recognized end, so 150ms covers the final decay.
export const TRIM_WORD_TAIL_SECS = 0.150
// The recognizer's first word lands 40-135ms after the acoustic attack (and
// 30ms before it once); 150ms puts the attack 15-110ms into the played clip.
export const TRIM_HINT_PAD_SECS = 0.150

/* offscreen.js:445-457 */
export const TRIM_FRAME_SECS = 0.020
export const TRIM_HOP_SECS = 0.010
export const TRIM_SMOOTH_SECS = 0.050      // moving average; one click is not a word
export const TRIM_PLATEAU_SECS = 0.150     // a word keeps going for this long
export const TRIM_PLATEAU_FILL = 0.800     // ...and fills 120ms of it
export const TRIM_QUIET_SECS = 0.100       // the room this long before it is the cut
export const TRIM_FLOOR_SECS = 1.500       // where the room level is measured
export const TRIM_FLOOR_PERCENT = 0.100
export const TRIM_RANGE = 4                // 12dB between room and voice, or no trim
export const TRIM_QUIET_FACTOR = 1.75      // 4.9dB over the room
// Not a level a voice has to reach, just a trap for a digitally silent floor,
// where "the geometric middle of zero and the voice" would be zero too.
export const TRIM_SILENCE = 1e-5           // -100 dBFS

/** ms from the first sample; NaN = unknown. */
export interface WordHint {
  first: number
  last: number
}

/** audio/wav, 16-bit mono at the decode rate (48 kHz). */
export interface TrimmedClip {
  blob: Blob
  ms: number
}

/**
 * Where the trim's sample work runs: monoMix + voicedBounds on the 48 kHz
 * decode, and the WAV encode of the cut.  On a 119 s take the encode alone is
 * a 52-105 ms main-thread task, so the take hands trimClip its VAD worker
 * (src/vad.ts) for this; localTrimWork() is comart's own, on this thread.
 */
export interface TrimWork {
  /** monoMix + voicedBounds; the mixed samples are kept for wav(). */
  bounds(buf: AudioBuffer): Promise<{ length: number; bounds: VadSegment | null }>
  /** wavBlob of the mixed samples [a, z), at the decode's rate. */
  wav(a: number, z: number): Promise<Blob>
}

/** The answer fields the hint reads; anything else on it is ignored. */
export interface WordTimings {
  first_word_ms?: unknown
  last_word_ms?: unknown
}

/* ------------------------------------------------------------------ */
/* the output sink, woken before the card plays (offscreen.js:86-145)  */
/* ------------------------------------------------------------------ */

// An idle Bluetooth sink is suspended, and the first play resumes the link,
// which takes ~100-300ms and swallows the first word.  So, while the transcript
// is in flight, a silent looping WAV plays through the same output.  It stops
// when the clip starts, when the take fails, or after 8s.  Deliberately not the
// clip's own element: dropping the clip must not touch the wake-up, and the
// wake-up must never enter the card's clock.
let warmEl: HTMLAudioElement | null = null
let warmUrl: string | null = null
let warmTimer: ReturnType<typeof setTimeout> | 0 = 0

export function warmSink(): void {
  try {
    if (!warmEl) {
      // One second of digital silence, 16kHz/16-bit; looped. Zeros are
      // inaudible at any volume, and a non-zero volume keeps some stacks from
      // treating the stream as absent.
      if (!warmUrl) warmUrl = URL.createObjectURL(wavBlob(new Float32Array(16000), 16000))
      warmEl = document.createElement('audio')
      warmEl.src = warmUrl
      warmEl.loop = true
      warmEl.preload = 'auto'
      warmEl.setAttribute('aria-hidden', 'true')
      document.body.appendChild(warmEl)
    }
    warmEl.volume = 0.01
    warmEl.currentTime = 0
    const p = warmEl.play()
    if (p && p.catch) p.catch(() => {})
    clearTimeout(warmTimer)
    warmTimer = setTimeout(stopWarmSink, 8000)
  } catch {
    // No sink warm-up is not fatal; the clip still plays, possibly with the
    // Bluetooth resume clipping its first word.
  }
}

export function stopWarmSink(): void {
  clearTimeout(warmTimer)
  warmTimer = 0
  if (!warmEl) return
  try { warmEl.pause() } catch { /* nothing to stop */ }
  try { warmEl.currentTime = 0 } catch { /* nothing to rewind */ }
}

/* ------------------------------------------------------------------ */
/* the clip's lead-in (offscreen.js:459-678)                           */
/* ------------------------------------------------------------------ */

export function monoMix(buf: AudioBuffer): Float32Array {
  const n = buf.length
  const chs: Float32Array[] = []
  for (let c = 0; c < buf.numberOfChannels; c++) chs.push(buf.getChannelData(c))
  if (chs.length === 1) return chs[0]!
  // getUserMedia is asked for one channel, but a device may ignore that.
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let v = 0
    for (let c = 0; c < chs.length; c++) v += chs[c]![i]!
    out[i] = v / chs.length
  }
  return out
}

// Where the voice starts and ends, in seconds, or null when there is nothing to
// cut. A null is always a safe answer: the caller keeps the whole clip.
export function voicedBounds(x: Float32Array, sr: number): VadSegment | null {
  const win = Math.max(1, Math.round(sr * TRIM_FRAME_SECS))
  const hop = Math.max(1, Math.round(sr * TRIM_HOP_SECS))
  const frames: number[] = []
  for (let i = 0; i + win <= x.length; i += hop) {
    let sum = 0
    for (let j = 0; j < win; j++) { const v = x[i + j]!; sum += v * v }
    frames.push(Math.sqrt(sum / win))
  }
  if (frames.length < 20) return null

  const span = Math.max(1, Math.round(TRIM_SMOOTH_SECS / TRIM_HOP_SECS))
  const side = (span - 1) / 2
  const sm: number[] = []
  for (let i = 0; i < frames.length; i++) {
    let sum = 0, n = 0
    for (let j = Math.floor(i - side); j <= Math.ceil(i + side); j++) {
      if (j < 0 || j >= frames.length) continue
      sum += frames[j]!; n++
    }
    sm.push(sum / n)
  }

  const pct = (a: number[], p: number): number => a[Math.min(a.length - 1, Math.floor((a.length - 1) * p))]!
  const level = pct(sm.slice().sort((a, b) => a - b), 0.95)
  // The room from the first 1.5s: the lead-in lives there. Measured over the
  // whole clip it would be speech itself whenever someone talks most of the
  // way through; measured over too short a head, one breath moves it.
  const head = sm.slice(0, Math.min(sm.length, Math.round(TRIM_FLOOR_SECS / TRIM_HOP_SECS)))
    .sort((a, b) => a - b)
  const floor = Math.max(pct(head, TRIM_FLOOR_PERCENT), TRIM_SILENCE)
  const quiet = floor * TRIM_QUIET_FACTOR
  // Under 12dB there is no room to tell silence from speech: refuse, and keep
  // the clip, rather than guess and cut into a word.
  if (level < floor * TRIM_RANGE) return null
  const thr = Math.sqrt(floor * level)   // the halfway point in dB

  // The first 150ms window that is mostly loud. A click is 10-30ms and cannot
  // fill it; a word can, even when it opens on a plosive or a fricative.
  const need = Math.round(TRIM_PLATEAU_SECS / TRIM_HOP_SECS)
  const fill = Math.round(need * TRIM_PLATEAU_FILL)
  let start = -1
  for (let i = 0; i + need <= sm.length; i++) {
    let heard = 0
    for (let j = i; j < i + need; j++) if (sm[j]! > thr) heard++
    if (heard >= fill) { start = i; break }
  }
  if (start < 0) return null

  // The clip already opens on speech: the microphone armed after the first word
  // began. There is no lead-in to cut, and cutting to the next pause would eat
  // the first word.
  let hot = 0
  for (let i = 0; i < Math.min(frames.length, 8); i++) if (frames[i]! > thr) hot++
  if (hot >= 5) return null

  // The last 100ms of room before that plateau. Walking back from the plateau
  // means a breath, a plosive or a fricative in between is kept whole: only a
  // genuine stretch of room ends the search.
  const gap = Math.round(TRIM_QUIET_SECS / TRIM_HOP_SECS)
  let q = -1
  for (let i = Math.min(start - 1, sm.length - 1); i >= gap - 1; i--) {
    let calm = true
    for (let j = i - gap + 1; j <= i; j++) if (sm[j]! > quiet) { calm = false; break }
    if (calm) { q = i; break }
  }
  if (q < 0) return null
  const soundAt = ((q + 1) * hop) / sr
  if (soundAt < TRIM_QUIET_SECS) return null

  let end = start
  for (let i = sm.length - 1; i >= start; i--) if (sm[i]! > thr) { end = i; break }
  // A frame's time is the START of its window; the last one ends a full window
  // later. This is not `(end + 1) * win` — the hop is half the window.
  return { start: soundAt, end: (end * hop + win) / sr }
}

export function wavBlob(pcm: Float32Array, sr: number): Blob {
  const bytes = pcm.length * 2
  const out = new DataView(new ArrayBuffer(44 + bytes))
  const tag = (o: number, s: string): void => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)) }
  tag(0, 'RIFF'); out.setUint32(4, 36 + bytes, true); tag(8, 'WAVEfmt ')
  out.setUint32(16, 16, true)          // fmt chunk length
  out.setUint16(20, 1, true)           // PCM
  out.setUint16(22, 1, true)           // mono
  out.setUint32(24, sr, true)
  out.setUint32(28, sr * 2, true)      // byte rate
  out.setUint16(32, 2, true)           // block align
  out.setUint16(34, 16, true)          // bits
  tag(36, 'data'); out.setUint32(40, bytes, true)
  for (let i = 0; i < pcm.length; i++) {
    const v = Math.max(-1, Math.min(1, pcm[i]!))
    out.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true)
  }
  return new Blob([out.buffer], { type: 'audio/wav' })
}

/** comart's sample work, on the calling thread. */
export function localTrimWork(): TrimWork {
  let x: Float32Array | null = null
  let rate = 0
  return {
    async bounds(buf) {
      rate = buf.sampleRate
      x = monoMix(buf)
      return { length: x.length, bounds: voicedBounds(x, rate) }
    },
    async wav(a, z) {
      if (!x) throw new Error('no clip')
      return wavBlob(x.subarray(a, z), rate)
    },
  }
}

// Decode a second time at 16 kHz for the VAD. OfflineAudioContext does the
// resampling properly, and two decodes are cheaper than hand-rolling a filter.
// The page decodes: OfflineAudioContext does not exist in a worker.
export async function vadAnalyze(blob: Blob, vad: Vad | null): Promise<{ probs: Float32Array; frameSec: number; segments: VadSegment[] }> {
  if (!vad) throw new Error('vad.js not loaded')
  const ctx = new OfflineAudioContext(1, 1, 16000)
  const buf = await ctx.decodeAudioData(await blob.arrayBuffer())
  const x = monoMix(buf)
  const a = await vad.probabilities(x)
  const segs = vad.segments(a.probs, a.frameSec)
  return { probs: a.probs, frameSec: a.frameSec, segments: segs }
}

/**
 * The trimmed clip, or null for "play it as recorded".  Never throws.
 * `hintMs` resolves to `{ first, last }` (wordHint), to a bare number for the
 * first word only, or to NaN.  `vadImpl` null is comart's "vad.js not loaded".
 * `work` is where the sample work runs (see TrimWork); the cut is comart's.
 */
export async function trimClip(
  blob: Blob,
  hintMs: Promise<WordHint | number> | null,
  vadImpl: Vad | null,
  work: TrimWork = localTrimWork(),
): Promise<TrimmedClip | null> {
  try {
    // Offline, so there is no output device and no autoplay policy in the way.
    const ctx = new OfflineAudioContext(1, 1, 48000)
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer())
    const sr = buf.sampleRate
    // comart: x = monoMix(buf); b = voicedBounds(x, sr)
    const { length, bounds: b } = await work.bounds(buf)   // local tail + last-resort start
    const dur = length / sr
    let end = b ? b.end : dur
    let endPad = TRIM_TAIL_SECS

    // The VAD starts now and runs in parallel with the STT, so by the time
    // first_word_ms arrives its probabilities are already there.
    const vadP = vadAnalyze(blob, vadImpl).catch(() => null)

    let h: WordHint | number | null = null
    if (hintMs) { try { h = await hintMs } catch { /* fall back */ } }
    if (typeof h === 'number') h = { first: h, last: NaN }
    const firstMs = Number(h && h.first)
    const lastMs = Number(h && h.last)
    const hint = Number.isFinite(firstMs) && firstMs >= 0 && firstMs < dur * 1000 ? firstMs : NaN
    const tailMs = Number.isFinite(lastMs) && lastMs > 0 && lastMs <= dur * 1000 ? lastMs : NaN

    const vad = await vadP
    let start: number | null = null, lead = TRIM_LEAD_SECS

    // 1. VAD, with the timestamp choosing WHICH speech event. The probabilities
    //    cover the whole clip, but only the segment at the anchor is eligible.
    if (vadImpl && vad && vad.segments.length) {
      const chosen = vadImpl.pick(
        vad.probs, vad.frameSec, Number.isFinite(hint) ? hint / 1000 : NaN)
      if (chosen.start !== null && Number.isFinite(chosen.start)) {
        const anchorSec = Number.isFinite(hint) ? hint / 1000 : NaN
        // A VAD that starts AFTER the recognizer's word has missed the word's
        // beginning — a soft "And", a breathed "Hmm" — and cutting there would
        // delete it. Only a VAD edge at or before the anchor may refine the cut.
        const late = Number.isFinite(anchorSec) && chosen.start > anchorSec + 0.05
        if (!late) {
          start = chosen.start
          end = Math.max(end, chosen.end)    // the VAD's end is speech, not room
          lead = TRIM_LEAD_SECS
          // No anchor: the energy detector can still see a soft onset the VAD
          // skipped. Trust it only when it is close to the VAD's segment.
          if (!Number.isFinite(hint) && b && b.start < start && start - b.start <= 0.5) {
            start = b.start
          }
        }
      }
    }

    // 2. No usable VAD answer, but the recognizer knows where the word is.
    if (start == null && Number.isFinite(hint)) {
      start = hint / 1000
      lead = TRIM_HINT_PAD_SECS
    }

    // 3. The energy detector.
    if (start == null && b) {
      start = b.start
      lead = TRIM_LEAD_SECS
    }

    // The recognizer's last word is the semantic end of speech, exactly as the
    // first word is its semantic start. Without it, the VAD/energy end keeps
    // its 250ms safety tail.
    if (start != null && Number.isFinite(tailMs) && tailMs / 1000 >= start) {
      end = tailMs / 1000
      endPad = TRIM_WORD_TAIL_SECS
    }

    if (start == null) return null
    if (end < start) end = dur               // the hint is later than the local tail
    const a = Math.max(0, Math.round((start - lead) * sr))
    const z = Math.min(length, Math.round((end + endPad) * sr))
    // comart: pcm = x.subarray(a, z); its length, without the samples here.
    const n = Math.max(0, z - Math.min(a, length))
    if (!n) return null

    return { blob: await work.wav(a, z), ms: (n / sr) * 1000 }
  } catch {
    return null
  }
}

/**
 * The trim's hint from the transcription's answer (offscreen.js:859-869): the
 * recognizer's first and last word, in ms from the first sample, when finite
 * and not negative; NaN otherwise, and for no answer or a failed one.
 */
export function wordHint(answer: Promise<WordTimings | null | undefined> | null): Promise<WordHint> {
  return answer
    ? answer.then((r) => {
        const d: WordTimings = r ?? {}
        const first = Number(d.first_word_ms)
        const last = Number(d.last_word_ms)
        return {
          first: Number.isFinite(first) && first >= 0 ? first : NaN,
          last: Number.isFinite(last) && last >= 0 ? last : NaN,
        }
      }).catch(() => ({ first: NaN, last: NaN }))
    : Promise.resolve({ first: NaN, last: NaN })
}
