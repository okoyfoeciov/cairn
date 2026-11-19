/**
 * src/vad-worker.ts
 * Owner: 03.  Spec: CONTRACT.md §0.58 E111 — comart's vendor/silero/vad.js
 * (warm, probabilities), inside the per-take Worker that src/vad.ts hosts.
 *
 * NOT part of app.js's module graph: build-app.mjs bundles this file on its own
 * with the four vendored runtime files as defines (SHA-256 checked), and app.js
 * carries the result as one string.  So nothing here is fetched: ort's script,
 * its .mjs and its wasm become blob: URLs inside this worker, and the model is
 * handed to ort as bytes.
 *
 * The model's contract, copied from silero-vad's OnnxWrapper.__call__ and from
 * ricky0123/vad's models/silero.ts (both MIT/ISC):
 *
 *   input   float32 [1, 576]   the last 64 samples of the previous frame, then
 *                              the new 512 samples. 512/16000 = 32ms.
 *   state   float32 [2, 1, 128]  carried from the previous call
 *   sr      int64   scalar     16000
 *   output  float32 [1, 1]     p(voice) for this 32ms
 *   stateN  float32 [2, 1, 128]  the state for the next call
 *
 * The 64-sample context is not optional: an onset that straddles a frame
 * boundary is only seen whole when the tail of the previous frame is prepended.
 */

import { monoMix, voicedBounds, wavBlob } from './mic-trim'
import { CONTEXT, FRAME, SR, type VadReply, type VadRequest } from './vad'

/* build-app.mjs's defines: the vendored bytes, each referenced once. */
declare const __VAD_ORT_JS__: string
declare const __VAD_ORT_MJS__: string
declare const __VAD_WASM_B64__: string
declare const __VAD_MODEL_B64__: string

/* What this file touches of the worker scope and of the `ort` global that
   ort.wasm.min.js defines. */
declare function importScripts(...urls: string[]): void
interface OrtTensor {
  readonly data: Float32Array
  dispose?(): void
}
interface OrtSession {
  run(feeds: { input: OrtTensor; state: OrtTensor; sr: OrtTensor }): Promise<{ output?: OrtTensor; stateN?: OrtTensor }>
}
declare const ort: {
  env: { wasm: { numThreads: number; proxy: boolean; wasmPaths?: string | { mjs?: string; wasm?: string } } }
  Tensor: new (type: 'float32' | 'int64', data: Float32Array | bigint[], dims?: number[]) => OrtTensor
  InferenceSession: { create(model: Uint8Array, opts: { executionProviders: string[] }): Promise<OrtSession> }
}

const scope = self as unknown as {
  onmessage: ((ev: MessageEvent<VadRequest>) => void) | null
  postMessage(message: VadReply, options: { transfer: Transferable[] }): void
}

function bytes(b64: string): Uint8Array {
  const from = (Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array }).fromBase64
  if (from) return from(b64)
  const bin = atob(b64)
  const u = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i)
  return u
}
const blobUrl = (data: string | Uint8Array, type: string): string =>
  URL.createObjectURL(new Blob([data as BlobPart], { type }))

let sessionP: Promise<OrtSession> | null = null
let paths: { mjs: string; wasm: string } | null = null

function initRuntime(): void {
  if (typeof ort === 'undefined') importScripts(blobUrl(__VAD_ORT_JS__, 'text/javascript'))
  // One thread: no SharedArrayBuffer, no COOP/COEP, and 32ms frames are far
  // too small to benefit from a worker pool.
  ort.env.wasm.numThreads = 1
  ort.env.wasm.proxy = false
  // Both as URLs, never `wasmBinary`: with a blob: .mjs the Emscripten module
  // resolves the wasm against a non-hierarchical base and warm() never settles.
  paths ??= { mjs: blobUrl(__VAD_ORT_MJS__, 'text/javascript'), wasm: blobUrl(bytes(__VAD_WASM_B64__), 'application/wasm') }
  ort.env.wasm.wasmPaths = paths
}

// Safe to call from start(), so the runtime loads while the microphone is opening.
function warm(): Promise<OrtSession> {
  if (sessionP) return sessionP
  initRuntime()
  sessionP = Promise.resolve()
    .then(() => bytes(__VAD_MODEL_B64__))
    .then((buf) => ort.InferenceSession.create(buf, { executionProviders: ['wasm'] }))
    .catch((e: unknown) => {
      sessionP = null              // a later recording may try again
      throw e
    })
  return sessionP
}

// One probability per 32ms frame. Yields every 64 frames (~2s of audio).
async function probabilities(audio: Float32Array): Promise<{ probs: Float32Array; frameSec: number }> {
  const session = await warm()
  const frames = Math.max(1, Math.ceil(audio.length / FRAME))
  const probs = new Float32Array(frames)
  let state = new ort.Tensor('float32', new Float32Array(2 * 128), [2, 1, 128])
  const sr = new ort.Tensor('int64', [16000n])
  let context = new Float32Array(CONTEXT)

  for (let i = 0; i < frames; i++) {
    const frame = new Float32Array(FRAME)
    const from = i * FRAME
    frame.set(audio.subarray(from, Math.min(audio.length, from + FRAME)))

    const input = new Float32Array(CONTEXT + FRAME)
    input.set(context, 0)
    input.set(frame, CONTEXT)
    context = frame.slice(-CONTEXT)

    const prevState = state
    const out = await session.run({
      input: new ort.Tensor('float32', input, [1, CONTEXT + FRAME]),
      state,
      sr,
    })

    if (!out.output || !out.stateN) throw new Error('model returned no stateN/output')
    probs[i] = out.output.data[0]!
    state = out.stateN
    // The old state and the output are WASM allocations; a 60s clip is 1,875
    // frames, and not releasing them would hold ~2MB for nothing.
    if (out.output.dispose) out.output.dispose()
    if (prevState.dispose) prevState.dispose()

    if ((i & 63) === 63) await new Promise((r) => setTimeout(r, 0))
  }
  return { probs, frameSec: FRAME / SR }
}

// The trim's sample work (src/mic-trim.ts TrimWork): comart's own functions,
// here so a long take's 50-100 ms encode is not a main-thread task.
let clip: { x: Float32Array; sr: number } | null = null

scope.onmessage = async (ev) => {
  const m = ev.data
  try {
    if (m.type === 'warm') {
      await warm()
      scope.postMessage({ id: m.id, ok: true }, { transfer: [] })
      return
    }
    if (m.type === 'bounds') {
      const chs = m.channels
      const buf = { length: chs[0]?.length ?? 0, numberOfChannels: chs.length, sampleRate: m.sr, getChannelData: (c: number) => chs[c]! }
      const x = monoMix(buf as unknown as AudioBuffer)
      clip = { x, sr: m.sr }
      scope.postMessage({ id: m.id, ok: true, length: x.length, bounds: voicedBounds(x, m.sr) }, { transfer: [] })
      return
    }
    if (m.type === 'wav') {
      if (!clip) throw new Error('no clip')
      scope.postMessage({ id: m.id, ok: true, blob: wavBlob(clip.x.subarray(m.a, m.z), clip.sr) }, { transfer: [] })
      return
    }
    const a = await probabilities(m.x)
    scope.postMessage({ id: m.id, ok: true, probs: a.probs, frameSec: a.frameSec }, { transfer: [a.probs.buffer as ArrayBuffer] })
  } catch (e) {
    scope.postMessage({ id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) }, { transfer: [] })
  }
}
