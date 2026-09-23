/**
 * tests/frontend/conflict-bars.test.mjs — F66's `main.ts` half.
 *
 * The note bar (owner 01) is drawn, but until this change nothing fed it:
 * `onNoteStateChanged` only reached `console.error`, and `keepMine` /
 * `reloadFromDisk` / `saveAs` had no caller. These rows prove the wiring —
 * state to bar, bar buttons to the editor's resolvers, Save as… to a prompt
 * that writes, and the vault-lost resume on re-open — against the REAL
 * `src/main.ts` with recording stubs (the `vault-restore.test.mjs` shape).
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
async function bootMain(over = {}) {
  const calls = makeCalls()
  let editorHooks = null
  let chromeDeps = null
  let vaultOpenedCb = null
  const chromeHandle = {
    noteState: (...a) => calls.log.push({ mod: 'chromeHandle', name: 'noteState', args: a }),
    vaultLost: () => {},
    vaultRestored: () => {},
    destroy: () => {},
  }

  const el = () => ({
    addEventListener() {},
    appendChild() {},
    style: {},
    classList: { add() {}, remove() {}, toggle() {} },
    parentElement: null,
  })
  const ed = el()
  ed.parentElement = el()

  const returns = {
    './ipc:onVaultOpened': (a) => {
      vaultOpenedCb = a[0]
      return Promise.resolve()
    },
    './ipc:onTreeChanged': () => Promise.resolve(),
    './ipc:onVaultLost': () => Promise.resolve(),
    './ipc:onWatchDegraded': () => Promise.resolve(),
    './ipc:onNoteExternalChange': () => Promise.resolve(),
    './ipc:onFlushAndClose': () => Promise.resolve(),
    './editor:onFlushAndClose': () => Promise.resolve({ ok: true }),
    './ipc:currentVault': () => Promise.resolve({ state: 'none' }),
    './ipc:treeSnapshot': () => Promise.resolve(new ArrayBuffer(64)),
    './ipc:secretNotes': () => Promise.resolve([]),
    './ipc:showMainWindow': () => Promise.resolve(),
    './ipc:saveUiState': () => Promise.resolve(),
    './ipc:confirmClose': () => Promise.resolve(),
    './modal:openModal': () => Promise.resolve('keep'),
    './editor:currentPath': () => over.currentPath ?? 'a.md',
    './editor:currentNoteState': () => over.noteState ?? 'live',
    './editor:isDirty': () => false,
    './editor:flushNow': () => Promise.resolve(),
    './editor:noteExternalChange': () => Promise.resolve(),
    './editor:keepMine': () => Promise.resolve(),
    './editor:reloadFromDisk': () => Promise.resolve(),
    './editor:resumeAfterVaultRestored': () => {},
    './editor:saveAs': () => Promise.resolve(),
    './editor:showEmpty': () => {},
    './editor:setEditorHooks': (a) => {
      editorHooks = a[0]
    },
    './chrome:wireChrome': (a) => {
      chromeDeps = a[0]
      return chromeHandle
    },
    './tree:createTree': () => recorder('tree'),
    './search:mountSearch': () => recorder('search'),
    './tabstrip:createTabStrip': () => recorder('tabs'),
    './vaultbar:createVaultBar': () => recorder('bar'),
    './memoir:mountMemoir': () => ({
      show: () => {}, hide: () => {}, visible: () => false,
      flush: () => Promise.resolve(), isDirty: () => false,
      reset: () => {}, externalChange: () => {},
    }),
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

  // `promptForName`'s inline editor, captured so the test can commit it.
  let nameEditor = null
  returns['./inline-edit:attachNameEditor'] = (a) => {
    nameEditor = a[1]
    return { focus() {} }
  }
  // `saveAsPrompt` reads these for real; the stubs would hand it `undefined`.
  returns['./inline-edit:parentOf'] = (a) => {
    const i = a[0].lastIndexOf('/')
    return i < 0 ? '' : a[0].slice(0, i)
  }
  returns['./inline-edit:displayName'] = (a) => a[0].slice(a[0].lastIndexOf('/') + 1).replace(/\.md$/i, '')

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
    createElement: () => el(),
    body: el(),
  }
  g.requestAnimationFrame = () => 0

  try {
    const src = BUNDLE + `\n//# boot=${bootSeq += 1}\n`
    await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'))
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete g[k]
      else g[k] = v
    }
  }
  await Promise.resolve()
  await Promise.resolve()
  assert.ok(editorHooks, 'main.ts never called setEditorHooks')
  assert.ok(chromeDeps, 'main.ts never called wireChrome')
  calls.clear()
  const drain = async () => {
    for (let i = 0; i < 12; i += 1) await new Promise((r) => setImmediate(r))
  }
  return {
    calls,
    editorHooks,
    chromeDeps,
    nameEditor: () => nameEditor,
    vaultOpened: async (info) => {
      vaultOpenedCb(info)
      await drain()
    },
  }
}

const vaultInfo = (over = {}) => ({
  root: '/tmp/A',
  name: 'A',
  nNotes: 1,
  truncated: false,
  truncatedDepth: false,
  watching: true,
  expanded: [],
  scrollTop: 0,
  sort: 0,
  lastNote: 'a.md',
  ...over,
})

test('F66 wiring: conflict and detached draw the bar, live removes it', async () => {
  const h = await bootMain()
  h.editorHooks.onNoteStateChanged('conflict', { kind: 'conflict' })
  h.editorHooks.onNoteStateChanged('detached', { kind: 'notFound' })
  h.editorHooks.onNoteStateChanged('live', null)
  const states = h.calls.argsOf('noteState')
  assert.deepEqual(
    states.map((a) => a[0]),
    ['conflict', 'detached', null],
  )
})

test('F66 wiring: the bar buttons reach keepMine / reload / Save as / discard', async () => {
  const h = await bootMain({ currentPath: 'sub/a.md' })
  await h.chromeDeps.keepMine()
  await h.chromeDeps.reloadFromDisk()
  assert.equal(h.calls.countOf('keepMine'), 1)
  assert.equal(h.calls.countOf('reloadFromDisk'), 1)
  // Save as… opens the prompt on the old stem; committing writes beside it.
  // `promptForName` needs a bare document: `createElement` + a body.
  const g = globalThis
  const savedDoc = g.document
  const made = []
  g.document = {
    createElement: () => {
      const e = {
        setAttribute() {}, append() {}, appendChild() {}, remove() {},
        classList: { add() {}, remove() {} }, style: {}, textContent: '',
        type: '', addEventListener() {}, focus() {},
      }
      made.push(e)
      return e
    },
    body: { appendChild() {} },
  }
  try {
    h.chromeDeps.saveAsPrompt()
  } finally {
    g.document = savedDoc
  }
  assert.ok(h.nameEditor(), 'Save as… never opened the name prompt')
  assert.equal(h.nameEditor().initial, 'a', 'the prompt opens on the old stem')
  await h.nameEditor().onCommit('copy.md')
  const saves = h.calls.argsOf('saveAs')
  assert.deepEqual(
    saves.map((a) => a[0]),
    ['sub/copy.md'],
    'Save as… writes beside the detached note, got ' + JSON.stringify(saves),
  )
  h.chromeDeps.discardNote()
  assert.equal(h.calls.countOf('showEmpty'), 1)
})

test('F66 wiring: re-opening the vault resumes a vault-lost note', async () => {
  const h = await bootMain({ noteState: 'vault-lost' })
  await h.vaultOpened(vaultInfo())
  await h.vaultOpened(vaultInfo())
  assert.equal(h.calls.countOf('resumeAfterVaultRestored'), 1)
})
