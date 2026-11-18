/**
 * tests/frontend/explain-persist.test.mjs — CONTRACT §0.56 E109's shell seam.
 *
 * The explanation panel's height (`state.json` `explain_h`, wire `explainH`)
 * and the `CAIRN_AI_BASE` test origin travel main process → `additionalArguments`
 * → sandboxed preload → page global.  Rust's half is pinned in `prefs.rs`.
 *
 * Everything here EXECUTES the shipped code: `state.ts` is bundled, the
 * app-main.mjs helpers are lifted out of the file and run against fakes (the
 * module itself cannot be imported without Electron), and the preload runs
 * with a fake `contextBridge`.  No window, no display.
 */

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

const appMain = read('electron-shell/app-main.mjs')
const preloadSrc = read('electron-shell/preload.cjs')
const prefsRs = read('core/src/prefs.rs')
const globalsDts = read('src/globals.d.ts')

/** The source of `function <name>(…) {…}` in `src`, braces matched while
 *  skipping strings, template literals and comments. */
function functionSource(src, name) {
  const at = src.indexOf(`function ${name}(`)
  assert.ok(at >= 0, `app-main.mjs no longer defines ${name}()`)
  let i = src.indexOf('{', at)
  let depth = 0
  for (; i < src.length; i += 1) {
    const c = src[i]
    if (c === '"' || c === "'" || c === '`') {
      i += 1
      while (i < src.length && src[i] !== c) { if (src[i] === '\\') i += 1; i += 1 }
      continue
    }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i += 1; continue }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i) + 1; continue }
    if (c === '{') depth += 1
    else if (c === '}' && (depth -= 1) === 0) return src.slice(at, i + 1)
  }
  throw new Error(`unbalanced braces in ${name}()`)
}

/** One top-level `const <name> = …` line. */
function constLine(src, name) {
  const m = src.match(new RegExp(`^const ${name} = .*$`, 'm'))
  assert.ok(m, `app-main.mjs no longer declares ${name}`)
  return m[0]
}

/** The E109 helpers from app-main.mjs, bound to fakes for everything the
 *  module scope would have supplied. */
function shellHelpers({ pixeltest = false, file, env = {} } = {}) {
  const errors = []
  const body = [
    constLine(appMain, 'EXPLAIN_H_BAND'),
    functionSource(appMain, 'persistedExplainH'),
    constLine(appMain, 'AI_BASE_HOSTS'),
    constLine(appMain, 'AI_BASE_REFUSED'),
    functionSource(appMain, 'loopbackAiBase'),
    functionSource(appMain, 'explainArguments'),
    'return { EXPLAIN_H_BAND, persistedExplainH, loopbackAiBase, explainArguments }',
  ].join('\n')
  const readFileSync = (p, enc) => {
    assert.equal(p, '/fake/state.json')
    assert.equal(enc, 'utf8')
    if (file === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    return file
  }
  const fakeConsole = { error: (...a) => errors.push(a.join(' ')) }
  // eslint-disable-next-line no-new-func
  const h = new Function('PIXELTEST', 'readFileSync', 'prefsPath', 'process', 'console', body)(
    pixeltest, readFileSync, () => '/fake/state.json', { env }, fakeConsole
  )
  return { ...h, errors }
}

/** Run the real preload with `argv`; returns what it exposed to the page. */
function runPreload(argv, { platform = 'darwin', env = {} } = {}) {
  const exposed = new Map()
  const electron = {
    contextBridge: {
      exposeInMainWorld: (name, value) => {
        assert.ok(!exposed.has(name), `${name} exposed twice`)
        exposed.set(name, value)
      },
    },
    ipcRenderer: {},
  }
  const req = (m) => {
    assert.equal(m, 'electron', 'the sandboxed preload may require nothing but electron')
    return electron
  }
  // eslint-disable-next-line no-new-func
  new Function('require', 'process', preloadSrc)(req, { platform, env, argv: ['electron', ...argv] })
  return exposed
}

/* ── state.ts: the patch carries explainH ─────────────────────────────────── */

/** @type {any} */ let S

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cairn-explain-persist-'))
  process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })
  const out = join(dir, 'bundle.mjs')
  await esbuild.build({
    stdin: {
      contents: 'export * as S from ' + JSON.stringify(join(ROOT, 'src', 'state.ts')) + '\n',
      resolveDir: ROOT,
      sourcefile: 'explain-persist-entry.ts',
      loader: 'ts',
    },
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2021',
    absWorkingDir: ROOT,
    logLevel: 'silent',
  })
  S = (await import(pathToFileURL(out).href)).S
})

test('E109 state.ts — explainH is queued, coalesced last-writer-wins, and sent', async () => {
  const sent = []
  S.configurePersist(async (p) => { sent.push(structuredClone(p)) })
  S.patchUi({ explainH: 300 })
  S.patchUi({ sidebarW: 500 })
  S.patchUi({ explainH: 310 })
  await S.flushUi()
  assert.deepEqual(sent, [{ explainH: 310, sidebarW: 500 }])

  // A later patch that does not name it leaves it out of the wire patch:
  // absent means "not mentioned", never "reset".
  S.patchUi({ sort: 2 })
  await S.flushUi()
  assert.deepEqual(sent[1], { sort: 2 })
})

/* ── app-main.mjs: the persisted height ───────────────────────────────────── */

test('E109 app-main — the persisted height is read from state.json and banded', () => {
  const at = (file, opts) => shellHelpers({ file, ...opts }).persistedExplainH()
  assert.equal(at(JSON.stringify({ v: 1, explain_h: 333 })), 333)
  assert.equal(at(JSON.stringify({ v: 1, explain_h: 377.5 })), 377.5)
  assert.equal(at(JSON.stringify({ v: 1, explain_h: 140 })), 140, 'the floor itself is legal')
  assert.equal(at(JSON.stringify({ v: 1, explain_h: 4000 })), 4000, 'the ceiling itself is legal')
  for (const bad of [0, -5, 139.9, 4000.5, 90000, 'tall', null, [320], {}]) {
    assert.equal(at(JSON.stringify({ v: 1, explain_h: bad })), null, JSON.stringify(bad))
  }
  assert.equal(at(JSON.stringify({ v: 1 })), null, 'never resized')
  assert.equal(at(undefined), null, 'no state file yet')
  assert.equal(at('{"v":1,"explain_h":3'), null, 'a truncated file')
  // The sidebar's field is not the panel's.
  assert.equal(at(JSON.stringify({ v: 1, sidebar_w: 333 })), null)
})

test('E109/G9 app-main — a --pixeltest run never sees a persisted height', () => {
  const h = shellHelpers({ pixeltest: true, file: JSON.stringify({ v: 1, explain_h: 333 }) })
  assert.equal(h.persistedExplainH(), null)
  assert.deepEqual(h.explainArguments(), [])
})

test('E109 app-main — the JS band is prefs.rs\'s band', () => {
  const num = (name) => {
    const m = prefsRs.match(new RegExp(`pub const ${name}: f64 = ([0-9_.]+);`))
    assert.ok(m, `prefs.rs no longer declares ${name}`)
    return Number(m[1].replace(/_/g, ''))
  }
  assert.deepEqual(shellHelpers().EXPLAIN_H_BAND, [num('EXPLAIN_H_MIN'), num('EXPLAIN_H_MAX')],
    'app-main.mjs and prefs.rs disagree about which heights are sane')
})

/* ── app-main.mjs: CAIRN_AI_BASE ──────────────────────────────────────────── */

test('E109 app-main — CAIRN_AI_BASE accepts loopback http and hands over the origin only', () => {
  const { loopbackAiBase } = shellHelpers()
  for (const [raw, origin] of [
    ['http://127.0.0.1:9123', 'http://127.0.0.1:9123'],
    ['http://127.0.0.1:9123/', 'http://127.0.0.1:9123'],
    ['http://localhost:9000/api/explain?x=1#y', 'http://localhost:9000'],
    ['http://LOCALHOST:9000', 'http://localhost:9000'],
    ['http://[::1]:7000/', 'http://[::1]:7000'],
    ['http://[0:0:0:0:0:0:0:1]:7000', 'http://[::1]:7000'],
    ['http://127.0.0.1', 'http://127.0.0.1'],
    ['http://127.0.0.1:80', 'http://127.0.0.1'],
    ['http://user:secret@127.0.0.1:5/', 'http://127.0.0.1:5'],
    // The URL parser normalises these to 127.0.0.1 — still the loopback.
    ['http://127.1:8770', 'http://127.0.0.1:8770'],
    ['http://0x7f000001:8770', 'http://127.0.0.1:8770'],
  ]) {
    assert.equal(loopbackAiBase(raw), origin, raw)
  }
})

test('E109 app-main — CAIRN_AI_BASE refuses anything that could leave the machine', () => {
  const { loopbackAiBase } = shellHelpers()
  for (const raw of [
    undefined,
    '',
    'https://127.0.0.1:9123',
    'ws://127.0.0.1:9123',
    'file:///tmp/fake',
    'javascript:alert(1)',
    'http://example.com',
    'http://127.0.0.1.example.com',
    'http://localhost.example.com',
    'http://localhost.',
    'http://example.com@evil.example',
    'http://10.0.0.1:8770',
    'http://0.0.0.0:8770',
    'http://[::2]:8770',
    'localhost:8770',
    '127.0.0.1:8770',
    'not a url',
  ]) {
    assert.equal(loopbackAiBase(raw), null, String(raw))
  }
})

test('E109 app-main — explainArguments: what reaches additionalArguments', () => {
  const file = JSON.stringify({ v: 1, explain_h: 333, sidebar_w: 500 })
  let h = shellHelpers({ file, env: { CAIRN_AI_BASE: 'http://127.0.0.1:9123/api' } })
  assert.deepEqual(h.explainArguments(), ['--cairn-explain-h=333', '--cairn-ai-base=http://127.0.0.1:9123'])
  assert.deepEqual(h.errors, [])

  h = shellHelpers({ env: { CAIRN_AI_BASE: 'http://user:secret@evil.example:80' } })
  assert.deepEqual(h.explainArguments(), ['--cairn-ai-base=http://127.0.0.1:9'],
    'a refused base must fail closed, never fall back to the billed :8770')
  assert.equal(h.errors.length, 1, 'a refused CAIRN_AI_BASE must be said, once')
  assert.doesNotMatch(h.errors[0], /secret|evil/, 'the refusal echoes the raw value')

  h = shellHelpers({})
  assert.deepEqual(h.explainArguments(), [])
  assert.deepEqual(h.errors, [], 'an unset CAIRN_AI_BASE is the normal case, not an error')
})

test('E109 app-main — the window is built with both halves of additionalArguments', () => {
  const block = appMain.slice(appMain.indexOf('additionalArguments:'))
  const end = block.indexOf('],')
  assert.ok(end > 0, 'additionalArguments is no longer an array literal')
  const args = block.slice(0, end)
  assert.ok(
    args.includes('...(persistedSidebarW() === null ? [] : [`--cairn-sidebar-w=${persistedSidebarW()}`]),'),
    'the sidebar argument changed'
  )
  assert.match(args, /\.\.\.explainArguments\(\)/, 'the E109 arguments never reach the preload')
})

/* ── preload.cjs: the page globals ────────────────────────────────────────── */

test('E109 preload — publishes the height as a number and the base as a string', () => {
  const g = runPreload(['--cairn-explain-h=333.5', '--cairn-ai-base=http://127.0.0.1:9123'])
  assert.equal(g.get('__CAIRN_EXPLAIN_H__'), 333.5)
  assert.equal(typeof g.get('__CAIRN_EXPLAIN_H__'), 'number')
  assert.equal(g.get('__CAIRN_AI_BASE__'), 'http://127.0.0.1:9123')
})

test('E109 preload — absent or malformed arguments publish nothing', () => {
  let g = runPreload([])
  assert.ok(!g.has('__CAIRN_EXPLAIN_H__'), 'a first run must leave the panel at its default')
  assert.ok(!g.has('__CAIRN_AI_BASE__'), 'a normal launch must leave the panel at :8770')

  g = runPreload(['--cairn-explain-h=tall', '--cairn-ai-base='])
  assert.ok(!g.has('__CAIRN_EXPLAIN_H__'), 'a non-number height was published')
  assert.ok(!g.has('__CAIRN_AI_BASE__'), 'an empty base was published')
})

test('E109 preload — the sidebar width is still published beside them', () => {
  const g = runPreload(['--cairn-sidebar-w=333', '--cairn-explain-h=250'], { platform: 'linux' })
  assert.equal(g.get('__CAIRN_SIDEBAR_W__'), 333)
  assert.equal(g.get('__CAIRN_EXPLAIN_H__'), 250)
  assert.equal(g.get('__CAIRN_OS__'), 'linux')
  assert.equal(typeof g.get('cairn')?.invoke, 'function')
})

test('E109 preload — the globals it publishes are the ones globals.d.ts declares', () => {
  for (const name of ['__CAIRN_EXPLAIN_H__', '__CAIRN_AI_BASE__']) {
    assert.match(globalsDts, new RegExp(`^\\s*${name}\\?:`, 'm'), `globals.d.ts does not declare ${name}`)
    assert.match(preloadSrc, new RegExp(`exposeInMainWorld\\('${name}'`), `preload.cjs does not publish ${name}`)
  }
})
