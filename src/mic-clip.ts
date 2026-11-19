/**
 * src/mic-clip.ts
 * Owner: 03.  Spec: CONTRACT.md §0.58 E111 — the player behind the transcript
 * card: comart's offscreen.js:280-352 (loadClip, dropClip, playState,
 * playPause, seek, and the error words) as the MicClip of ./mic-types.
 *
 * The clip is the trimmed WAV, or the recorded WebM when the trim gave up.  A
 * live WebM has no duration (the element reports Infinity), so `ms` — the
 * trim's length, or the recorder's clock — is the length until the element
 * knows a real one.  comart's `mic:clipgone` has no port: only a take started
 * in another tab could take a clip away, and here the next take's card
 * releases this one first.
 */

import type { MicClip, MicClipListener, MicClipState } from './mic-types'
import { stopWarmSink } from './mic-trim'

export interface MicClipDeps {
  /** Where the <audio> lives (comart appends it to the body). */
  doc: Document
  url: { createObjectURL(blob: Blob): string; revokeObjectURL(url: string): void }
  /** The sink wake-up has done its job once the clip itself plays. */
  stopWarmSink(): void
}

/** comart loadClip(blob, tabId, ms): the element is made and loading now. */
export function createMicClip(blob: Blob, ms: number, deps: Partial<MicClipDeps> = {}): MicClip {
  const doc = deps.doc ?? document
  const url = deps.url ?? URL
  const wake = deps.stopWarmSink ?? stopWarmSink
  let clipUrl: string | null = url.createObjectURL(blob)
  let clipMs = ms
  let listener: MicClipListener | null = null
  let audio: HTMLAudioElement | null = doc.createElement('audio')
  audio.src = clipUrl
  audio.preload = 'auto'
  doc.body.appendChild(audio)

  const el = audio
  const send = (): void => { if (audio && listener) listener.state(playState()) }
  el.addEventListener('timeupdate', send)
  el.addEventListener('play', send)
  el.addEventListener('pause', send)
  el.addEventListener('ended', send)
  // The real duration the moment it is known, rather than at the next timeupdate.
  el.addEventListener('loadedmetadata', send)
  // A dead, silent player is worse than a message. Aborts are ignored.
  el.addEventListener('error', () => {
    if (!audio || !listener) return
    const err = el.error
    if (err && err.code === 1) return
    listener.failed("Couldn't play the recording" + (err && err.code === 4 ? ' (unsupported format)' : '') + '.')
  })

  function playState(): MicClipState {
    if (!audio) return { playing: false, t: 0, dur: 0 }
    // The element's own duration when it has a real one; the clock otherwise.
    const d = isFinite(audio.duration) && audio.duration > 0 ? audio.duration : clipMs / 1000
    return { playing: !audio.paused && !audio.ended, t: Math.min(audio.currentTime || 0, d), dur: d }
  }

  return {
    play(want) {
      if (!audio) return null
      const playing = !audio.paused && !audio.ended
      const go = want === undefined ? !playing : !!want
      if (go) {
        wake()
        // Restart from the top when sitting at the end.
        const s = playState()
        if (audio.ended || (s.dur && audio.currentTime >= s.dur - 0.05)) audio.currentTime = 0
        const p = audio.play()
        if (p && p.catch) p.catch(() => {})
      } else {
        audio.pause()
      }
      return playState()
    },
    seek(frac) {
      if (!audio) return null
      const s = playState()
      if (!s.dur) return null              // no length, no seek
      const f = Math.min(1, Math.max(0, Number(frac) || 0))
      try { audio.currentTime = f * s.dur } catch { /* not seekable yet */ }
      return playState()
    },
    state: playState,
    watch(l) {
      listener = l
    },
    release() {
      listener = null
      if (audio) { try { audio.pause() } catch { /* already stopped */ } audio.remove(); audio = null }
      if (clipUrl) { try { url.revokeObjectURL(clipUrl) } catch { /* already revoked */ } clipUrl = null }
      clipMs = 0
    },
  }
}
