/**
 * src/mic-types.ts
 * Owner: 03.  Spec: CONTRACT.md §0.58 E111 — the book reader's microphone
 * (comart's mic button and plain transcript card, voice-typing's audio chain).
 *
 * The two seams of the feature, and nothing else:
 *   · reader ↔ mic: the reader mounts the mic, shows/hides it with the book,
 *     discards it on leaving, and asks whether the card is open (rule 3);
 *   · UI ↔ audio: `mic.ts` drives one take at a time through `MicAudio` and
 *     hears its outcome; `mic-take.ts` implements it over the recorder, the
 *     trim and the clip player.
 * `main.ts` binds the shell-side values (the ai-service origin, `copy_text`,
 * the modal/menu test) and hands the reader a `MountMic`, so the reader never
 * imports the mic and the UI never imports the audio modules.  Types only.
 */

/* ------------------------------------------------------------------ */
/* reader ↔ mic                                                        */
/* ------------------------------------------------------------------ */

/** What the READER supplies when it mounts the mic. */
export interface MicHooks {
  /** Move focus back inside #reader when it is not there already: the band
   *  while it is open, else the book scroller.  The reader's Esc listens on
   *  #reader, so focus outside it is an Esc nobody hears. */
  restoreFocus(): void
}

export interface MicView {
  /** The button is drawn only while a book is showing. */
  setShown(on: boolean): void
  /** Leaving the book (hide, close, another book, tab or vault switch):
   *  discard any take silently, close the card, clear the status.  Idempotent.
   *  Never calls restoreFocus — the reader is going away. */
  leave(): void
  /** True while the transcript card is open: the reader's outside-click rule
   *  stands down and no book pick starts (rule 3). */
  cardOpen(): boolean
  destroy(): void
}

/** What main.ts binds before the reader sees the factory. */
export interface MicShellDeps {
  /** One take at a time.  Constructing it opens nothing: no device, no
   *  socket, no wasm, no worker. */
  audio: MicAudio
  /** Command 23 `copy_text` (CONTRACT UI-12: navigator.clipboard fails here). */
  copyText(text: string): Promise<void>
  /** A modal or a menu is open: the card's Esc steps aside for it. */
  layerAbove(): boolean
  onError(err: unknown, context: string): void
}

export type MicDeps = MicHooks & MicShellDeps

/** Handed to mountReader by main.ts.  The mic appends its own roots to
 *  host.ownerDocument.body and reads host's rect for its geometry. */
export type MountMic = (host: HTMLElement, hooks: MicHooks) => MicView

/* ------------------------------------------------------------------ */
/* UI ↔ audio                                                          */
/* ------------------------------------------------------------------ */

/** comart playState(): seconds. */
export interface MicClipState {
  playing: boolean
  t: number
  dur: number
}

export interface MicClipListener {
  /** timeupdate / play / pause / ended / loadedmetadata. */
  state(s: MicClipState): void
  /** comart's text: "Couldn't play the recording." or
   *  "Couldn't play the recording (unsupported format)."  Aborts never
   *  arrive here. */
  failed(message: string): void
}

/** The playback clip of one finished take: the trimmed WAV, or the recorded
 *  WebM when the trim gave up. */
export interface MicClip {
  /** comart playPause(want): undefined toggles, true plays, false pauses;
   *  playing at the end restarts from 0.  null once released. */
  play(want?: boolean): MicClipState | null
  /** comart seek(frac): 0..1, clamped; null with no duration. */
  seek(frac: number): MicClipState | null
  state(): MicClipState
  /** One listener; a second call replaces the first. */
  watch(l: MicClipListener): void
  /** comart dropClip(): pause, detach, revoke the object URL.  Idempotent;
   *  no listener fires after it. */
  release(): void
}

export interface MicDone {
  /** Trimmed; '' means no speech ("No speech detected"). */
  text: string
  clip: MicClip
}

/** getUserMedia's NotAllowedError/SecurityError → 'denied'; anything else that
 *  stops the microphone → 'unavailable'. */
export type MicError = 'denied' | 'unavailable'

/** Events of ONE take.  Exactly one ending (micFailed, done, failed,
 *  cancelled) arrives, and nothing at all after it or after
 *  `MicTake.cancel()`. */
export interface MicTakeEvents {
  /** The first captured audio arrived and the stream to ai-service opens now.
   *  The button becomes the red Stop here, not before. */
  recording(): void
  /** The microphone would not open, or stopped mid-take.  The UI owns the
   *  words. */
  micFailed(error: MicError): void
  /** stop() was accepted: the mic is being released and the answer awaited. */
  transcribing(): void
  done(d: MicDone): void
  /** The whole status line, already worded: "Transcription failed — …". */
  failed(message: string): void
  /** The two endings that speak: over the 2-minute cap, or under the floors. */
  cancelled(reason: 'over' | 'short'): void
}

export interface MicTake {
  /** Stop recording.  False, and nothing happens, when this take is not
   *  recording (still arming, or already stopping). */
  stop(): boolean
  /** Discard silently from any state: no "stop", the mic released, the bytes
   *  dropped, any clip released.  No event fires after it. */
  cancel(): void
}

export interface MicAudio {
  /** One take; the microphone is opened now.  The UI never calls it while a
   *  take is in flight. */
  start(events: MicTakeEvents): MicTake
  destroy(): void
}
