/**
 * electron-shell/fake-ai-ws.mjs — a fake ai-service for the real-engine suites:
 * `/api/transcribe/ws` over a hand-rolled RFC 6455 server (Node has no
 * WebSocket server), `/api/explain` as a short SSE answer so a band can open,
 * and `/api/pron` as not found for the answer's bold word.  It never calls
 * anything.  Every other route is recorded as stray.
 *
 * The WebSocket route answers the way ai-service's does (transcribe_stream.go):
 * the upgrade is refused unless `type` is an audio type, the client's binary
 * frames are the WebM body, and after the client's "stop" text frame ONE text
 * frame goes back — `{text, first_word_ms, last_word_ms}` or `{error}` — and
 * the TCP connection is dropped with no close handshake (its CloseNow).
 *
 * Each upgrade takes the next scripted behaviour (the last one repeats):
 *   { text, first_word_ms?, last_word_ms?, delayMs? }   answer at "stop"
 *   { error }                                            `{"error": …}` at "stop"
 *   { hang: true }                                       never answer
 *   { garbage: true }                                    a non-JSON text frame
 *   { http: 403 }                                        refuse the upgrade
 *   { close: code, afterFrames? }                        a close frame (at once, or mid-stream)
 *   { drop: afterFrames }                                destroy the socket mid-stream
 */

import { createHash } from 'node:crypto'
import { createServer } from 'node:http'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

function frame(opcode, payload) {
  const n = payload.length
  let head
  if (n < 126) head = Buffer.from([0x80 | opcode, n])
  else if (n < 65536) {
    head = Buffer.alloc(4)
    head[0] = 0x80 | opcode
    head[1] = 126
    head.writeUInt16BE(n, 2)
  } else {
    head = Buffer.alloc(10)
    head[0] = 0x80 | opcode
    head[1] = 127
    head.writeBigUInt64BE(BigInt(n), 2)
  }
  return Buffer.concat([head, payload])
}

function closeFrame(code, reason = '') {
  const p = Buffer.alloc(2 + Buffer.byteLength(reason))
  p.writeUInt16BE(code, 0)
  p.write(reason, 2)
  return frame(0x8, p)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Start the fake on 127.0.0.1 at a free port.  `explainText` is what every
 * `/api/explain` streams.
 */
export function startFakeAi({ explainText = '**word**: a plain gloss written by the test harness.' } = {}) {
  /** One record per upgrade, in arrival order. */
  const conns = []
  const stray = []
  const explains = []
  const prons = []
  let script = [{ text: 'fake transcript' }]
  let next = 0
  const sockets = new Set()

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method === 'POST' && url.pathname === '/api/explain') {
      let raw = ''
      for await (const c of req) raw += c
      explains.push(raw)
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' })
      res.write(`event: chunk\ndata: ${JSON.stringify({ text: explainText })}\n\n`)
      res.end('event: done\ndata: {}\n\n')
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/pron') {
      prons.push(url.searchParams.get('word') ?? '')
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{"error":"not_found"}')
      return
    }
    stray.push(`${req.method} ${url.pathname}`)
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('Not found')
  })

  server.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })

  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    socket.on('error', () => {})
    if (url.pathname !== '/api/transcribe/ws') {
      stray.push(`UPGRADE ${url.pathname}`)
      socket.destroy()
      return
    }
    const beh = script[Math.min(next, script.length - 1)] ?? { text: '' }
    next++
    const c = {
      idx: conns.length,
      behaviour: beh,
      url: req.url,
      type: url.searchParams.get('type'),
      origin: req.headers.origin ?? null,
      t0: Date.now(),
      /** Binary frame sizes, in order. */
      frames: [],
      chunks: [],
      texts: [],
      /** Binary frames received before "stop", or null when none came. */
      stop: null,
      clientClose: null,
      reply: null,
      closed: false,
      /** Who ended the TCP connection: 'client', 'server', or null while open. */
      endedBy: null,
    }
    conns.push(c)
    if (beh.http) {
      c.closed = true
      c.endedBy = 'server'
      socket.end(`HTTP/1.1 ${beh.http} Forbidden\r\nContent-Type: application/json\r\nContent-Length: 22\r\nConnection: close\r\n\r\n{"error":"Forbidden."}`)
      return
    }
    const accept = createHash('sha1').update(String(req.headers['sec-websocket-key']) + GUID).digest('base64')
    socket.setNoDelay(true)
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`)
    const end = (by) => {
      if (c.closed) return
      c.closed = true
      c.endedBy = by
    }
    socket.on('end', () => end('client'))
    socket.on('close', () => end('client'))
    if (!c.type || !/^(audio|video)\//.test(c.type)) {
      end('server')
      socket.end(closeFrame(1008, 'Content-Type must be an audio type'))
      return
    }
    if (beh.close && !beh.afterFrames) {
      end('server')
      socket.end(closeFrame(beh.close, beh.reason ?? ''))
      return
    }

    const answer = async () => {
      if (beh.hang) return
      if (beh.delayMs) await sleep(beh.delayMs)
      if (c.closed) return
      let body
      if (beh.garbage) body = 'this is not json'
      else if (beh.error !== undefined) body = JSON.stringify({ error: beh.error })
      else {
        const out = { text: beh.text ?? '' }
        if (beh.first_word_ms !== undefined) out.first_word_ms = beh.first_word_ms
        if (beh.last_word_ms !== undefined) out.last_word_ms = beh.last_word_ms
        body = JSON.stringify(out)
      }
      c.reply = body
      end('server')
      socket.write(frame(0x1, Buffer.from(body)))
      socket.destroy()
    }

    let buf = Buffer.alloc(0)
    let parts = []
    let op = 0
    socket.on('data', (d) => {
      buf = Buffer.concat([buf, d])
      for (;;) {
        if (buf.length < 2) return
        const fin = (buf[0] & 0x80) !== 0
        const opcode = buf[0] & 0x0f
        const masked = (buf[1] & 0x80) !== 0
        let len = buf[1] & 0x7f
        let off = 2
        if (len === 126) {
          if (buf.length < 4) return
          len = buf.readUInt16BE(2)
          off = 4
        } else if (len === 127) {
          if (buf.length < 10) return
          len = Number(buf.readBigUInt64BE(2))
          off = 10
        }
        const maskAt = off
        if (masked) off += 4
        if (buf.length < off + len) return
        const payload = Buffer.from(buf.subarray(off, off + len))
        if (masked) for (let i = 0; i < len; i++) payload[i] ^= buf[maskAt + (i & 3)]
        buf = buf.subarray(off + len)
        if (opcode === 0x8) {
          c.clientClose = payload.length >= 2 ? payload.readUInt16BE(0) : 1005
          end('client')
          socket.end(closeFrame(1000))
          return
        }
        if (opcode === 0x9) {
          socket.write(frame(0xa, payload))
          continue
        }
        if (opcode === 0xa) continue
        if (opcode !== 0) op = opcode
        parts.push(payload)
        if (!fin) continue
        const data = Buffer.concat(parts)
        parts = []
        if (op === 0x2) {
          c.frames.push(data.length)
          c.chunks.push(data)
          if (beh.close && beh.afterFrames === c.frames.length) {
            end('server')
            socket.end(closeFrame(beh.close, beh.reason ?? ''))
            return
          }
          if (beh.drop && beh.drop === c.frames.length) {
            end('server')
            socket.destroy()
            return
          }
        } else {
          const text = data.toString('utf8')
          c.texts.push(text)
          if (text.trim() === 'stop' && c.stop === null) {
            c.stop = c.frames.length
            void answer()
          }
        }
      }
    })
  })

  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const port = server.address().port
    resolve({
      port,
      base: `http://127.0.0.1:${port}`,
      conns,
      stray,
      explains,
      prons,
      /** Replace the behaviour queue; the next upgrade takes the first. */
      script(...behaviours) {
        script = behaviours
        next = 0
      },
      /** The bytes one connection received, in order. */
      body(c) {
        return Buffer.concat(c.chunks)
      },
      close() {
        for (const s of sockets) s.destroy()
        return new Promise((r) => server.close(() => r()))
      },
    })
  }))
}
