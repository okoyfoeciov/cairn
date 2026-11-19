/**
 * src/mic-wire.ts
 * Owner: 03.  Spec: CONTRACT.md §0.58 E111 — the microphone's wire to ai-service.
 *
 * One take's upload over ai-service's `GET /api/transcribe/ws?type=<mime>`:
 * binary frames, then the text frame "stop"; the server answers with ONE text
 * frame (the stream route's JSON body, its HTTP status dropped) and drops the
 * connection.  voice-typing's wire rules, mapped onto it:
 *   - never a zero-length frame;
 *   - "stop" only after the final data (the recorder sends it after the mic is
 *     released and the encoder flushed);
 *   - cancel = close without "stop";
 *   - no timeout while recording; a 30 s answer deadline after "stop";
 *   - a socket that dies while recording is remembered, the take keeps
 *     recording, and the outcome is read at stop;
 *   - one retry with the kept bytes on a transport failure or a retryable
 *     upstream error (`classifyReply`).
 * Only the "Transcription failed — …" lines are worded here; the microphone's
 * failures are codes, worded by the UI.
 */

/** comart's type plus voice-typing's client tag, which only labels ai-service's log. */
export const WIRE_TYPE = 'audio/webm;codecs=opus;client=cairn'
/** Deepgram's way of saying "no speech" (voice-typing config.py). */
export const DEEPGRAM_EMPTY_ERROR = 'deepgram returned no transcript'
export const FAILED_PREFIX = 'Transcription failed — '

export const failedLine = (message: string): string => FAILED_PREFIX + message

/** The socket URL for an ai-service origin, or null when `base` is missing or
 *  not http(s): the take then fails closed, without dialling anything. */
export function transcribeUrl(base: unknown, type: string): string | null {
  if (typeof base !== 'string') return null
  const trimmed = base.trim().replace(/\/$/, '')
  if (!trimmed) return null
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  return trimmed.replace(/^http/, 'ws') + '/api/transcribe/ws?type=' + encodeURIComponent(type)
}

export type Attempt =
  | { kind: 'reply'; data: unknown; beforeStop: boolean; t: number }
  | { kind: 'closed'; code: number; reason: string; errorSeen: boolean; beforeStop: boolean; t: number }
  | { kind: 'timeout'; t: number }
  | { kind: 'connect-timeout'; beforeStop: boolean; t: number }
  | { kind: 'aborted'; t: number }

export interface WordTimes {
  first_word_ms?: number
  last_word_ms?: number
}

export type Verdict =
  | ({ kind: 'text'; text: string } & WordTimes)
  | ({ kind: 'empty'; text: '' } & WordTimes)
  | { kind: 'retry'; reason: string; message: string }
  | { kind: 'fail'; reason: string; message: string }

/** What an attempt means, after ai-service's own statuses: the 413/415/500
 *  strings are final; every other error string is the 502 family and is
 *  retried, except Deepgram's "no transcript", which is silence. */
export function classifyReply(r: Attempt | null): Verdict {
  if (!r) return { kind: 'retry', reason: 'no result', message: 'no transcription response' }
  if (r.kind === 'reply') {
    if (typeof r.data !== 'string') return { kind: 'retry', reason: 'binary reply', message: 'no answer' }
    let data: unknown
    try {
      data = JSON.parse(r.data)
    } catch {
      return { kind: 'retry', reason: 'malformed reply', message: 'no answer' }
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { kind: 'retry', reason: 'malformed reply', message: 'no answer' }
    const d = data as Record<string, unknown>
    if (d.error !== undefined && d.error !== null) {
      const err = String(d.error)
      if (err === DEEPGRAM_EMPTY_ERROR) return { kind: 'empty', text: '' }
      const final = err === 'recording too long' || err === 'internal' || err.startsWith('server not configured') ||
        err.startsWith('Content-Type must be') || err === 'Forbidden.'
      return { kind: final ? 'fail' : 'retry', reason: 'error: ' + err.slice(0, 120), message: err }
    }
    const text = String(d.text == null ? '' : d.text).trim()
    const words: WordTimes = {}
    const fw = Number(d.first_word_ms)
    const lw = Number(d.last_word_ms)
    if (Number.isFinite(fw) && fw >= 0) words.first_word_ms = fw
    if (Number.isFinite(lw) && lw >= 0) words.last_word_ms = lw
    return text ? { kind: 'text', text, ...words } : { kind: 'empty', text: '', ...words }
  }
  if (r.kind === 'closed') {
    // 1008: the type was refused (the WS form of 415), final.  1009: a frame
    // over the 1 MiB read limit, which would repeat, final.  Anything else
    // without an answer (1006 dropped/refused/403, 1011) is a transport failure.
    if (r.code === 1008 || r.code === 1009) {
      return { kind: 'fail', reason: `close ${r.code} ${r.reason || ''}`.trim(), message: r.reason || 'transcription connection closed' }
    }
    return {
      kind: 'retry',
      reason: `close ${r.code}${r.errorSeen ? ' after error' : ''}${r.beforeStop ? ' before stop' : ''}`,
      message: r.errorSeen ? 'transcription connection failed' : 'transcription connection closed',
    }
  }
  if (r.kind === 'timeout') return { kind: 'retry', reason: 'answer deadline', message: 'no transcription response' }
  if (r.kind === 'connect-timeout') return { kind: 'retry', reason: 'connect timeout', message: 'transcription connection failed' }
  return { kind: 'fail', reason: r.kind, message: 'no answer' }
}

/** The retry's frames: every kept byte, in order, each frame well under the
 *  server's 1 MiB read limit. */
export function coalesce(chunks: readonly Uint8Array[], max = 256 * 1024): Uint8Array[] {
  const groups: Uint8Array[][] = []
  let cur: Uint8Array[] = []
  let n = 0
  for (const c of chunks) {
    if (n + c.byteLength > max && n) {
      groups.push(cur)
      cur = []
      n = 0
    }
    cur.push(c)
    n += c.byteLength
  }
  if (n) groups.push(cur)
  return groups.map((parts) => {
    const b = new Uint8Array(parts.reduce((sum, p) => sum + p.byteLength, 0))
    let o = 0
    for (const p of parts) {
      b.set(p, o)
      o += p.byteLength
    }
    return b
  })
}

/** The slice of WebSocket the wire uses; the real one satisfies it. */
export interface WsLike {
  binaryType: string
  send(data: string | Uint8Array): void
  close(): void
  onopen: ((e: unknown) => void) | null
  onmessage: ((e: { data: unknown }) => void) | null
  onerror: ((e: unknown) => void) | null
  onclose: ((e: { code: number; reason: string }) => void) | null
}
export type WsCtor = new (url: string) => WsLike

export interface WireTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export const browserTimers: WireTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as number),
}

export interface TakeSocketOptions {
  WebSocket: WsCtor
  connectTimeoutMs?: number
  now?: () => number
  timers?: WireTimers
}

/** One WebSocket attempt. */
export class TakeSocket {
  sentFrames = 0
  sentBytes = 0
  stopSent = false
  errorSeen = false
  tOpen: number | null = null
  tStop: number | null = null
  private state: 'connecting' | 'open' | 'closed' | 'failed' = 'connecting'
  private ws: WsLike | null = null
  private pending: Uint8Array[] = []
  private result: Attempt | null = null
  private waiters: ((a: Attempt) => void)[] = []
  private stopQueued = false
  private deadlineMs = 30000
  private connectTimer: unknown = null
  private deadlineTimer: unknown = null
  private errorTimer: unknown = null
  private readonly now: () => number
  private readonly timers: WireTimers

  constructor(url: string | null, o: TakeSocketOptions) {
    this.now = o.now ?? (() => performance.now())
    this.timers = o.timers ?? browserTimers
    let ws: WsLike
    try {
      if (url === null) throw new SyntaxError('no transcription URL')
      ws = new o.WebSocket(url)
    } catch (e) {
      this.state = 'failed'
      this.settle({ kind: 'closed', code: 0, reason: String((e as Error | null)?.message ?? e), errorSeen: true, beforeStop: true, t: 0 })
      return
    }
    this.ws = ws
    ws.binaryType = 'arraybuffer'
    this.connectTimer = this.timers.setTimeout(() => {
      if (this.state === 'connecting') {
        this.settle({ kind: 'connect-timeout', beforeStop: !this.stopSent, t: 0 })
        this.closeSocket()
      }
    }, o.connectTimeoutMs ?? 5000)
    ws.onopen = () => {
      this.timers.clearTimeout(this.connectTimer)
      if (this.state !== 'connecting') return
      this.state = 'open'
      this.tOpen = this.now()
      for (const b of this.pending) this.write(b)
      this.pending = []
      if (this.stopQueued) this.sendStop()
    }
    ws.onmessage = (e) => {
      this.settle({ kind: 'reply', data: e.data, beforeStop: !this.stopSent, t: 0 })
    }
    ws.onerror = () => {
      this.errorSeen = true
      // Chromium fires 'close' right after 'error'; settle there to keep its code.
      this.errorTimer = this.timers.setTimeout(() => {
        this.settle({ kind: 'closed', code: 1006, reason: '', errorSeen: true, beforeStop: !this.stopSent, t: 0 })
      }, 1000)
    }
    ws.onclose = (e) => {
      this.timers.clearTimeout(this.connectTimer)
      this.state = 'closed'
      this.settle({ kind: 'closed', code: e.code, reason: e.reason, errorSeen: this.errorSeen, beforeStop: !this.stopSent, t: 0 })
    }
  }

  private write(b: Uint8Array): void {
    this.ws?.send(b)
    this.sentFrames++
    this.sentBytes += b.byteLength
  }

  private closeSocket(): void {
    try {
      this.ws?.close()
    } catch {
      /* already closed */
    }
  }

  private settle(r: Attempt): void {
    if (this.result) return
    r.t = this.now()
    this.result = r
    this.timers.clearTimeout(this.deadlineTimer)
    this.timers.clearTimeout(this.errorTimer)
    this.timers.clearTimeout(this.connectTimer)
    const waiters = this.waiters
    this.waiters = []
    for (const w of waiters) w(r)
  }

  /** Never a zero-length frame.  Bytes fed while connecting are queued in order;
   *  after an outcome or after "stop", nothing is sent. */
  send(bytes: Uint8Array | null | undefined): void {
    if (!bytes || !bytes.byteLength || this.result || this.stopSent) return
    if (this.state === 'open') this.write(bytes)
    else if (this.state === 'connecting') this.pending.push(bytes)
  }

  private sendStop(): void {
    this.stopSent = true
    this.tStop = this.now()
    this.ws?.send('stop')
    this.deadlineTimer = this.timers.setTimeout(() => {
      this.settle({ kind: 'timeout', t: 0 })
      this.closeSocket()
    }, this.deadlineMs)
  }

  /** After the final data: "stop", then the one answer (or failure) within the
   *  deadline.  An outcome that came first is returned as it is, with no "stop". */
  finish(deadlineMs = 30000): Promise<Attempt> {
    if (this.result) return Promise.resolve(this.result)
    const p = new Promise<Attempt>((resolve) => this.waiters.push(resolve))
    this.deadlineMs = deadlineMs
    if (this.state === 'open') this.sendStop()
    else this.stopQueued = true // still connecting: onopen flushes, then stops
    return p
  }

  /** Close without "stop".  Nobody waiting hears anything. */
  abort(): void {
    this.timers.clearTimeout(this.connectTimer)
    this.timers.clearTimeout(this.deadlineTimer)
    this.timers.clearTimeout(this.errorTimer)
    this.waiters = []
    if (!this.result) this.result = { kind: 'aborted', t: this.now() }
    this.pending = []
    this.closeSocket()
  }
}
