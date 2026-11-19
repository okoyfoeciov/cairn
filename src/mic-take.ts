/**
 * src/mic-take.ts
 * Owner: 03.  Spec: CONTRACT.md §0.58 E111 — `MicAudio` (src/mic-types.ts):
 * one take at a time, composed from the recorder (mic-recorder.ts), the
 * playback trim and its VAD (mic-trim.ts, vad.ts) and the clip player
 * (mic-clip.ts).
 *
 * The sequencing is comart's offscreen.js start() and finish():
 *   start   stopWarmSink (:688), the last clip dropped (:695), the microphone,
 *           then a new VAD worker warmed and not awaited (:690-694; after
 *           getUserMedia here, because warm() builds the Worker on this thread)
 *   sent    the floors passed and "stop" went out: warmSink (:848), and the
 *           trim starts now, to be awaited only at the answer (:850-870)
 *   done    the trimmed WAV, or the recording at the recorder's length (:894-896)
 *   any other ending  stopWarmSink (:828-835)
 * The worker lives from Start until the trim settles or the take ends.  Every
 * call into it is bounded by VAD_BOUND_MS, because an inline carrier can hang
 * warm() forever and the card waits on the trim; when the bound fires the
 * worker is terminated and trimClip falls back by its own rules.
 */

import type { MicAudio, MicClip, MicTake, MicTakeEvents } from './mic-types'
import { createMicClip } from './mic-clip'
import { createMicRecorder, type MicRecorder, type MicRecorderEvents, type MicRecorderOptions } from './mic-recorder'
import { stopWarmSink, trimClip, warmSink, wordHint, type TrimWork, type TrimmedClip, type WordHint } from './mic-trim'
import { browserTimers, failedLine, type WireTimers } from './mic-wire'
import { sileroVadWorker, type Vad } from './vad'

/** How long any one VAD call may stay unsettled before its worker is terminated. */
export const VAD_BOUND_MS = 10000

/** What sileroVadWorker() returns: the VAD, its sample work, and dispose(). */
export type VadHost = Vad & TrimWork & { dispose(): void }

/** The seams, for the tests; each defaults to the real module. */
export interface MicTakeDeps {
  recorder(o: MicRecorderOptions): MicRecorder
  /** A new worker host per take.  Lazy: no Worker exists until its first call. */
  vad(): VadHost
  trimClip(blob: Blob, hint: Promise<WordHint>, vad: Vad | null, work?: TrimWork): Promise<TrimmedClip | null>
  createClip(blob: Blob, ms: number): MicClip
  warmSink(): void
  stopWarmSink(): void
  timers: WireTimers
}

export interface MicAudioOptions {
  /** The ai-service origin.  Required, and passed on as is: a missing or bad
   *  one fails the take closed in the recorder. */
  base: string
  onError(err: unknown, context: string): void
  deps?: Partial<MicTakeDeps>
}

const DEFAULTS: MicTakeDeps = {
  recorder: createMicRecorder,
  vad: () => sileroVadWorker(),
  trimClip,
  createClip: (blob, ms) => createMicClip(blob, ms),
  warmSink,
  stopWarmSink,
  timers: browserTimers,
}

/** A bounded call in flight: its timer, and how to reject it early. */
interface Bound {
  timer: unknown
  fail: ((e: Error) => void) | null
}

interface Take {
  events: MicTakeEvents
  /** False once it ended or was discarded: nothing reaches the UI after. */
  live: boolean
  /** The recorder is still on this take (no recorder ending yet). */
  recLive: boolean
  off: (() => void)[]
  host: VadHost | null
  /** The host as trimClip sees it: every call bounded. */
  vad: (Vad & TrimWork) | null
  vadOpen: boolean
  calls: Set<Bound>
  trim: Promise<TrimmedClip | null> | null
}

export function createMicAudio(o: MicAudioOptions): MicAudio {
  const d: MicTakeDeps = { ...DEFAULTS, ...o.deps }
  const report = (err: unknown, context: string): void => {
    try {
      o.onError(err, context)
    } catch {
      /* the reporter itself failed; nothing is left to tell */
    }
  }
  const safe = (fn: () => void, context: string): void => {
    try {
      fn()
    } catch (e) {
      report(e, context)
    }
  }

  let rec: MicRecorder | null = null
  let current: Take | null = null
  /** The clip of the last done take: comart's one `audio`, dropped by the next start. */
  let lastClip: MicClip | null = null
  let destroyed = false

  /* ── the VAD worker and its bound ───────────────────────────────────── */

  function closeVad(t: Take, why: string): void {
    if (!t.vadOpen) return
    t.vadOpen = false
    const calls = [...t.calls]
    t.calls.clear()
    for (const c of calls) {
      d.timers.clearTimeout(c.timer)
      c.fail?.(new Error(why))
    }
    const host = t.host
    if (host) safe(() => host.dispose(), 'mic-vad')
  }

  function fire(t: Take, what: string): Error {
    const err = new Error(`VAD ${what}() did not settle within ${VAD_BOUND_MS} ms; its worker was terminated`)
    if (t.live && t.vadOpen) report(err, 'mic-vad-bound')
    closeVad(t, err.message)
    return err
  }

  /** warm() and probabilities(): rejected at the bound, whatever the host does. */
  function race<T>(t: Take, what: string, call: (h: VadHost) => Promise<T>): Promise<T> {
    const host = t.host
    if (!host || !t.vadOpen) return Promise.reject(new Error('the VAD is closed'))
    return new Promise<T>((resolve, reject) => {
      const c: Bound = { timer: null, fail: reject }
      const settled = (): boolean => {
        if (!t.calls.delete(c)) return false
        d.timers.clearTimeout(c.timer)
        return true
      }
      c.timer = d.timers.setTimeout(() => {
        if (t.calls.delete(c)) reject(fire(t, what))
      }, VAD_BOUND_MS)
      t.calls.add(c)
      let p: Promise<T>
      try {
        p = call(host)
      } catch (e) {
        p = Promise.reject(e)
      }
      p.then(
        (v) => { if (settled()) resolve(v) },
        (e: unknown) => { if (settled()) reject(e) },
      )
    })
  }

  /** bounds() and wav(): at the bound the worker is terminated, and the host
   *  then does the work on the page (vad.ts), so the trim keeps its rules. */
  function watch<T>(t: Take, what: string, call: (h: VadHost) => Promise<T>): Promise<T> {
    const host = t.host
    // A take that is over needs no trim: no page work for it.
    if (!host || !t.live) return Promise.reject(new Error('the take is over'))
    if (!t.vadOpen) return call(host)
    const c: Bound = { timer: null, fail: null }
    c.timer = d.timers.setTimeout(() => {
      if (t.calls.delete(c)) fire(t, what)
    }, VAD_BOUND_MS)
    t.calls.add(c)
    const settled = (): void => {
      if (t.calls.delete(c)) d.timers.clearTimeout(c.timer)
    }
    let p: Promise<T>
    try {
      p = call(host)
    } catch (e) {
      p = Promise.reject(e)
    }
    p.then(settled, settled)
    return p
  }

  function bounded(t: Take, host: VadHost): Vad & TrimWork {
    return {
      warm: () => race(t, 'warm', (h) => h.warm()),
      probabilities: (audio) => race(t, 'probabilities', (h) => h.probabilities(audio)),
      segments: (probs, frameSec) => host.segments(probs, frameSec),
      pick: (probs, frameSec, anchorSec) => host.pick(probs, frameSec, anchorSec),
      bounds: (buf) => watch(t, 'bounds', (h) => h.bounds(buf)),
      wav: (a, z) => watch(t, 'wav', (h) => h.wav(a, z)),
    }
  }

  /* ── the UI's events ─────────────────────────────────────────────────── */

  function emit(t: Take, name: string, call: (ev: MicTakeEvents) => void): void {
    try {
      call(t.events)
    } catch (e) {
      report(e, 'mic-take ' + name)
    }
  }

  function letGo(t: Take): void {
    t.live = false
    for (const off of t.off.splice(0)) off()
    if (current === t) current = null
  }

  /** The one ending.  Every ending but done stops the sink wake-up (:828-835),
   *  and the worker goes with the take. */
  function end(t: Take, name: string, call: (ev: MicTakeEvents) => void): void {
    if (!t.live) return
    letGo(t)
    if (name !== 'done') safe(d.stopWarmSink, 'mic-warm-sink')
    closeVad(t, 'the take ended')
    emit(t, name, call)
  }

  /** Silent: no ending reaches the UI, and nothing after. */
  function discard(t: Take): void {
    if (!t.live) return
    letGo(t)
    if (t.recLive && rec) {
      t.recLive = false
      const r = rec
      // its 'cancelled' fires inside cancel(), and this take no longer listens
      safe(() => { r.cancel('user') }, 'mic-take')
    }
    safe(d.stopWarmSink, 'mic-warm-sink')
    closeVad(t, 'the take was discarded')
  }

  /* ── the recorder's events ──────────────────────────────────────────── */

  function sent(t: Take, s: MicRecorderEvents['sent']): void {
    if (!t.live) return
    // After the floors, never at 'stopping': a short take plays no silent loop.
    safe(d.warmSink, 'mic-warm-sink')
    let p: Promise<TrimmedClip | null>
    try {
      p = d.trimClip(s.clip, wordHint(s.answer), t.vad, t.vad ?? undefined)
    } catch (e) {
      p = Promise.reject(e)
    }
    t.trim = p
      .catch((e: unknown) => {
        report(e, 'mic-trim')
        return null
      })
      .then((r) => {
        closeVad(t, 'the trim settled')
        return r
      })
  }

  function answered(t: Take, a: MicRecorderEvents['done']): void {
    if (!t.live) return
    const open = (r: TrimmedClip | null): void => {
      if (!t.live) return // discarded while the trim ran: no clip is made
      let clip: MicClip
      try {
        clip = d.createClip(r ? r.blob : a.clip, r ? r.ms : a.audioMs)
      } catch (e) {
        report(e, 'mic-clip')
        end(t, 'failed', (ev) => ev.failed(failedLine('no answer')))
        return
      }
      lastClip = clip
      end(t, 'done', (ev) => ev.done({ text: a.text, clip }))
    }
    // A failed trim plays the recording as is; it never leaves the take hanging.
    void (t.trim ?? Promise.resolve(null)).then(open, (e: unknown) => {
      report(e, 'mic-trim')
      open(null)
    })
  }

  function cancelled(t: Take, reason: MicRecorderEvents['cancelled']['reason']): void {
    if (reason === 'short' || reason === 'cap') {
      const why = reason === 'cap' ? 'over' : 'short'
      end(t, 'cancelled', (ev) => ev.cancelled(why))
      return
    }
    // 'user' and 'left' come only from discard(), which stops listening first.
    if (!t.live) return
    report(new Error(`the recorder discarded a live take (${reason})`), 'mic-take')
    discard(t)
  }

  function listen(t: Take, r: MicRecorder): void {
    t.off.push(
      r.on('first-audio', () => { if (t.live) emit(t, 'recording', (ev) => ev.recording()) }),
      r.on('stopping', () => { if (t.live) emit(t, 'transcribing', (ev) => ev.transcribing()) }),
      r.on('sent', (s) => sent(t, s)),
      r.on('done', (a) => { t.recLive = false; answered(t, a) }),
      r.on('failed', (f) => { t.recLive = false; end(t, 'failed', (ev) => ev.failed(f.message)) }),
      r.on('mic-failed', (m) => { t.recLive = false; end(t, 'micFailed', (ev) => ev.micFailed(m.error)) }),
      r.on('cancelled', (c) => { t.recLive = false; cancelled(t, c.reason) }),
    )
  }

  /* ── MicAudio ───────────────────────────────────────────────────────── */

  return {
    start(events: MicTakeEvents): MicTake {
      if (destroyed) throw new Error('the microphone was destroyed')
      if (current) {
        report(new Error('start() while a take was in flight: that take is discarded'), 'mic-take')
        discard(current)
      }
      const t: Take = {
        events, live: true, recLive: false, off: [], host: null, vad: null, vadOpen: false, calls: new Set(), trim: null,
      }
      current = t
      // A previous take's wake-up must not linger.
      safe(d.stopWarmSink, 'mic-warm-sink')
      // Lazy: no Worker exists until warm(), below.
      try {
        t.host = d.vad()
        t.vadOpen = true
        t.vad = bounded(t, t.host)
      } catch (e) {
        report(e, 'mic-vad')
      }
      // A new recording replaces the one the card was playing.
      if (lastClip) {
        const c = lastClip
        lastClip = null
        safe(() => c.release(), 'mic-clip')
      }
      let ok = false
      try {
        rec ??= d.recorder({ base: o.base, onError: (err, context) => report(err, context) })
        listen(t, rec)
        t.recLive = true
        ok = rec.start()
      } catch (e) {
        report(e, 'mic-take')
      }
      if (!ok) {
        t.recLive = false
        end(t, 'micFailed', (ev) => ev.micFailed('unavailable'))
      }
      // Load the model while the microphone opens, so Stop pays only inference.
      // comart calls warm() before getUserMedia, where it is an async fetch;
      // here its first call builds the Worker from app.js's payload on this
      // thread, so it comes after rec.start(), which has called getUserMedia.
      // An ended take's bounded VAD rejects without making a Worker.
      t.vad?.warm().catch((e: unknown) => {
        // a bound or a discard closed it, and said so already
        if (t.vadOpen) report(e, 'mic-vad-warm')
      })
      return {
        stop(): boolean {
          if (!t.live || !t.recLive || !rec) return false
          try {
            return rec.stop()
          } catch (e) {
            report(e, 'mic-take')
            return false
          }
        },
        cancel(): void {
          discard(t)
        },
      }
    },
    destroy(): void {
      if (destroyed) return
      destroyed = true
      if (current) discard(current)
      else safe(d.stopWarmSink, 'mic-warm-sink')
      if (lastClip) {
        const c = lastClip
        lastClip = null
        safe(() => c.release(), 'mic-clip')
      }
    },
  }
}
