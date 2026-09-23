/**
 * tests/frontend/memoir-wiring.test.mjs — F26/F47's `main.ts` half.
 *
 * F26: the quit handshake never flushed the journal page. `flushAndClose`
 * must flush the memoir AFTER the editor, and a refused journal write must
 * refuse the close (`confirm_close(false, kind)` + the modal) instead of
 * answering `true` over unsaved entries.
 *
 * F47: `nc://note-external-change` for `Memoir.md` must reach the page's
 * `externalChange()` — the editor's `noteExternalChange` cannot cover a
 * buffer the editor does not own.
 *
 * How it runs: the REAL `src/main.ts`, bundled with every sibling replaced
 * by a recording stub (the `vault-restore.test.mjs` harness shape — imports
 * are parsed out of main.ts itself, so a new import fails to bundle rather
 * than slipping past). The tests drive the genuine `nc://flush-and-close`
 * and `nc://note-external-change` subscriptions boot() registered.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as esbuild from 'esbuild'

const ROOT = new URL('../../', import.meta.url).pathname
const read = (p) => readFileSync(ROOT + p, 'utf8')

function importsOf(src) {
  const mods = new Map()
  const re = /import\s+(type\s+)?(?:\{([^}]*)\}|(\w+))\s+from\s+'([^']+)'/g
  for (const m of src.matchAll(re)) {
    const [, typeOnly, braced, dflt, spec] = m
    if (typeOnly) continue
    const names = mods.get(spec) ?? new Set()
    if (dflt) names.add('default')
    for (const raw of (braced ?? '').split(',')) {
      const part = raw.trim()
      if (part === '' || part.startsWith('type ')) continue
      names.add(part.split(/\s+as\s+/)[0].trim())
    }
    mods.set(spec, names)
  }
  return mods
}

const MAIN = read('src/main.ts')
const MODS = importsOf(MAIN)

function makeCalls() {
  const log = []
  return {
    log,
    argsOf: (name) => log.filter((c) => c.name === name).map((c) => c.args),
    countOf: (name) => log.filter((c) => c.name === name).length,
    clear: () => { log.length = 0 },
  }
}

function stubFor(spec, names) {
  const key = JSON.stringify(spec)
  const lines = [`const M = globalThis.__CAIRN_HARNESS__; const K = ${key};`]
  for (const n of names) {
    lines.push(
      `export const ${n === 'default' ? '__d' : n} = (...a) => M.call(K, ${JSON.stringify(n)}, a);`,
    )
    if (n === 'default') lines.push('export default __d;')
  }
  return lines.join('\n')
}

const stubPlugin = {
  name: 'cairn-stub-siblings',
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (args.kind === 'entry-point') return null
      const names = MODS.get(args.path)
      assert.ok(names, `main.ts imports '${args.path}', which this harness does not stub`)
      return { path: args.path, namespace: 'stub' }
    })
    build.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
      contents: stubFor(args.path, MODS.get(args.path)),
      loader: 'js',
    }))
  },
}

const BUNDLE = (
  await esbuild.build({
    entryPoints: [ROOT + 'src/main.ts'],
    bundle: true,
    format: 'esm',
    write: false,
    plugins: [stubPlugin],
    logLevel: 'silent',
  })
).outputFiles[0].text

let bootSeq = 0
// `MEMOIR_PATH` is a string const in `src/tree.ts`, but the recorder stubs
// every sibling export as a function. Pin it back: without this,
// `p.path === MEMOIR_PATH` in the external-change route is always false and
// the F47 test would pass vacuously — or rather, fail for the wrong reason.
const BUNDLE_PINNED = BUNDLE.replace(
  /var MEMOIR_PATH = .*?;/,
  `var MEMOIR_PATH = 'Memoir.md';`,
)
assert.match(BUNDLE_PINNED, /var MEMOIR_PATH = 'Memoir.md';/)
async function bootMain(memoirFake) {
  const calls = makeCalls()
  let flushAndCloseCb = null
  let noteExternalCb = null

  const el = () => ({
    addEventListener() {},
    appendChild() {},
    style: {},
    classList: { add() {}, remove() {}, toggle() {} },
    parentElement: null,
  })
  // `mountMemoir` only runs when `#ed` has a parent: give it one.
  const ed = el()
  ed.parentElement = el()

  const returns = {
    './ipc:onVaultOpened': () => Promise.resolve(),
    './ipc:onTreeChanged': () => Promise.resolve(),
    './ipc:onVaultLost': () => Promise.resolve(),
    './ipc:onWatchDegraded': () => Promise.resolve(),
    './ipc:onNoteExternalChange': (a) => {
      noteExternalCb = a[0]
      return Promise.resolve()
    },
    './editor:onFlushAndClose': () => Promise.resolve({ ok: true }),
    // The SUBSCRIPTION lives in `./ipc`; the flush call in `./editor`.
    './ipc:onFlushAndClose': (a) => {
      flushAndCloseCb = a[0]
      return Promise.resolve()
    },
    './ipc:currentVault': () => Promise.resolve({ state: 'none' }),
    './ipc:treeSnapshot': () => Promise.resolve(new ArrayBuffer(64)),
    './ipc:showMainWindow': () => Promise.resolve(),
    './ipc:saveUiState': () => Promise.resolve(),
    './ipc:confirmClose': () => Promise.resolve(),
    './modal:openModal': () => Promise.resolve('keep'),
    './editor:currentPath': () => null,
    './editor:isDirty': () => false,
    './editor:flushNow': () => Promise.resolve(),
    './editor:noteExternalChange': () => Promise.resolve(),
    './chrome:wireChrome': () => recorder('chrome'),
    './tree:createTree': () => recorder('tree'),
    './search:mountSearch': () => recorder('search'),
    './tabstrip:createTabStrip': () => recorder('tabs'),
    './vaultbar:createVaultBar': () => recorder('bar'),
    './memoir:mountMemoir': () => memoirFake,
  }

  const recorder = (tag) =>
    new Proxy(
      {},
      {
        get: (_t, prop) =>
          typeof prop === 'string'
            ? (...a) => {
                calls.log.push({ mod: tag, name: prop, args: a })
                const r = returns[tag + ':' + prop]
                return r ? r(a) : undefined
              }
            : undefined,
      },
    )

  const g = globalThis
  const saved = {
    document: g.document,
    requestAnimationFrame: g.requestAnimationFrame,
    __CAIRN_HARNESS__: g.__CAIRN_HARNESS__,
  }
  g.__CAIRN_HARNESS__ = {
    call(mod, name, args) {
      calls.log.push({ mod, name, args })
      const r = returns[mod + ':' + name]
      return r ? r(args) : undefined
    },
  }
  g.document = {
    readyState: 'complete',
    addEventListener() {},
    getElementById: (id) => (id === 'ed' ? ed : el()),
    querySelector: () => el(),
  }
  g.requestAnimationFrame = () => 0

  try {
    const src = BUNDLE_PINNED + `\n//# boot=${bootSeq += 1}\n`
    await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'))
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete g[k]
      else g[k] = v
    }
  }
  await Promise.resolve()
  await Promise.resolve()
  assert.ok(flushAndCloseCb, 'main.ts did not subscribe to nc://flush-and-close')
  assert.ok(noteExternalCb, 'main.ts did not subscribe to nc://note-external-change')
  calls.clear()
  const drain = async () => {
    for (let i = 0; i < 12; i += 1) await new Promise((r) => setImmediate(r))
  }
  return {
    calls,
    close: async () => {
      flushAndCloseCb()
      await drain()
    },
    external: async (path) => {
      noteExternalCb({ path })
      await drain()
    },
  }
}

const memoirFake = (over = {}) => ({
  show: () => {},
  hide: () => {},
  visible: () => false,
  flush: () => Promise.resolve(),
  isDirty: () => false,
  reset: () => {},
  externalChange: () => {},
  ...over,
})

test('F26 wiring: the quit handshake flushes the journal after the editor', async () => {
  let flushed = false
  const h = await bootMain(
    memoirFake({
      flush: () => {
        flushed = true
        return Promise.resolve()
      },
    }),
  )
  await h.close()
  assert.equal(flushed, true, 'flushAndClose never called memoir.flush()')
  const closes = h.calls.argsOf('confirmClose')
  assert.deepEqual(
    closes.at(-1),
    [true],
    'expected confirm_close(true) after both flushes, got ' + JSON.stringify(closes),
  )
})

test('F26 wiring: a refused journal write refuses the close and asks', async () => {
  const h = await bootMain(
    memoirFake({
      flush: () => Promise.reject({ kind: 'conflict', message: 'changed on disk' }),
      isDirty: () => true,
    }),
  )
  await h.close()
  const closes = h.calls.argsOf('confirmClose')
  assert.deepEqual(closes[0], [false, 'conflict'], 'expected confirm_close(false) first')
  assert.equal(h.calls.countOf('openModal'), 1, 'expected the discard/keep modal')
  assert.ok(!closes.slice(1).some((a) => a[0] === true), 'must not confirm_close(true) after refusal')
})

test('F47 wiring: an external change to Memoir.md reaches the page', async () => {
  let paged = 0
  let edited = 0
  const h = await bootMain(
    memoirFake({
      externalChange: () => {
        paged += 1
      },
    }),
  )
  const noteExternalCallsBefore = h.calls.countOf('noteExternalChange')
  await h.external('Memoir.md')
  assert.equal(paged, 1)
  assert.equal(h.calls.countOf('noteExternalChange'), noteExternalCallsBefore)
  await h.external('note.md')
  void edited
  assert.equal(paged, 1, 'other notes must not reach the page')
  assert.equal(h.calls.countOf('noteExternalChange'), noteExternalCallsBefore + 1)
})
