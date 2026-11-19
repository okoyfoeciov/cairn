#!/usr/bin/env node
/**
 * electron-shell/build-app.mjs -- bundles the REAL frontend for Electron.
 *
 * IT IS THE ONLY BUILD. The `tauri_modules=0` check below costs nothing and it
 * is the thing that would notice `@tauri-apps` coming back in through a
 * dependency.
 *
 * Output goes to electron-shell/app/, which is generated -- never edit it,
 * and never commit it.
 *
 * THE CSS IS INLINED, NOT LINKED, AND THAT IS A PACKAGING REQUIREMENT.
 * Relative `<link>` paths climb out of `electron-shell/app/` into the repo,
 * which is unshippable: a packaged app has no `src/`, so the page would render
 * completely unstyled with no error. The output directory is self-contained.
 * The same goes for fonts: the stylesheet pass inlines them as data: URLs.
 *
 * THE VAD RUNTIME IS INLINED TOO (CONTRACT §0.58 E111).  `src/vad-worker.ts` is
 * bundled on its own with comart's four vendored files inside it (SHA-256
 * checked, the build fails on a mismatch), and app.js carries that bundle as
 * ONE string, `__CAIRN_VAD_WORKER__`, which src/vad.ts starts as a Worker from
 * a blob: URL.  So the page still loads nothing from file:// at run time.
 *
 * Importing this module builds nothing; it exports `CSS_ORDER` and
 * `bundleCss()` so a unit test can check the real stylesheet pass without
 * writing `electron-shell/app/` under another run's feet, and the VAD pieces
 * (`VAD_VENDOR`, `readVadVendor()`, `buildVadWorker()`) for the same reason.
 */

import * as esbuild from 'esbuild'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const HERE = dirname(SELF)
const ROOT = dirname(HERE)
const OUT = join(HERE, 'app')

// The same cascade order build.mjs pins (tokens.css first -- every other sheet
// assumes its custom properties exist).
export const CSS_ORDER = [
  'tokens.css',
  'base.css',
  'chrome.css',
  'tree.css',
  'editor.css',
  'search.css',
  'find.css',
  'memoir.css',
  'reader.css',
  'explain.css',
  'mic.css',
]

/** The token src/index.html carries where the stylesheet is inlined. Spelled the
 *  same way build.mjs spells it, and for the same reason: a second literal copy
 *  of the token anywhere in this file would be a candidate substitution site. */
const PLACEHOLDER = '<!' + '--CSS-->'

/* The stylesheet, in one esbuild pass, in CSS_ORDER, with K5's drag-region sheet
   LAST so it overrides nothing but the region property.
   `stdin` rather than a generated `_index.css`, so CSS_ORDER here is the one
   copy of the order and nothing is written under src/.
   `.ttf` is a `dataurl` (`data:font/ttf`): explain.css's two Lora faces land
   inside the inlined <style>, so the page stays one self-contained file (E34).
   The bytes go in unchanged -- a converted or subset Lora would be a Modified
   Version, which may not keep its name (THIRD-PARTY-NOTICES.md). */
export async function bundleCss() {
  const cssResult = await esbuild.build({
    stdin: {
      contents:
        CSS_ORDER.map((f) => `@import "./${f}";`).join('\n') +
        '\n@import "../../electron-shell/app-chrome.css";\n',
      resolveDir: join(ROOT, 'src', 'styles'),
      loader: 'css',
    },
    bundle: true,
    write: false,
    minify: true,
    target: 'chrome142',
    loader: { '.ttf': 'dataurl' },
  })
  return cssResult.outputFiles[0].text
}

/** The VAD runtime app.js carries: comart's vendor/ files, byte for byte, with
 *  the SHA-256s of its THIRD_PARTY_NOTICES.md. */
export const VAD_VENDOR = {
  ortJs: { file: 'vendor/onnxruntime/ort.wasm.min.js', sha256: '65e09376df69107e881b5c34d2d37aed333a366b6d941073ec518168e269b87d' },
  ortMjs: { file: 'vendor/onnxruntime/ort-wasm-simd-threaded.mjs', sha256: '30dd851d9c00622940500f71ddd2ff8820c5cb65270816080175b958705385a8' },
  wasm: { file: 'vendor/onnxruntime/ort-wasm-simd-threaded.wasm', sha256: '71aef04959c5c1b6de461b6538e2058e306610034a85aad2742d0c7fd4533fe4' },
  model: { file: 'vendor/silero/silero_vad_v6.onnx', sha256: '1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3' },
}

/** The four files' bytes, each checked against its hash.  Throws an Error with
 *  `reason` ('vendor-missing' | 'vendor-hash') and `file`; the bytes that were
 *  hashed are the bytes that get embedded. */
export function readVadVendor(root = ROOT) {
  const out = {}
  for (const [key, { file, sha256 }] of Object.entries(VAD_VENDOR)) {
    let bytes
    try {
      bytes = readFileSync(join(root, file))
    } catch {
      throw Object.assign(new Error('vendor-missing file=' + file), { reason: 'vendor-missing', file })
    }
    const got = createHash('sha256').update(bytes).digest('hex')
    if (got !== sha256) {
      throw Object.assign(new Error('vendor-hash file=' + file + ' sha256=' + got), { reason: 'vendor-hash', file })
    }
    out[key] = bytes
  }
  return out
}

/** The worker bundle as the text app.js embeds.  The ort scripts go in as
 *  strings and the wasm and the model as base64, each through a define that
 *  vad-worker.ts reads exactly once (a define is inlined at every use). */
export async function buildVadWorker(root = ROOT) {
  const v = readVadVendor(root)
  const r = await esbuild.build({
    entryPoints: [join(ROOT, 'src', 'vad-worker.ts')],
    bundle: true,
    format: 'iife',
    target: 'chrome142',
    platform: 'browser',
    minify: true,
    legalComments: 'none',
    write: false,
    logLevel: 'warning',
    define: {
      __VAD_ORT_JS__: JSON.stringify(v.ortJs.toString('utf8')),
      __VAD_ORT_MJS__: JSON.stringify(v.ortMjs.toString('utf8')),
      __VAD_WASM_B64__: JSON.stringify(v.wasm.toString('base64')),
      __VAD_MODEL_B64__: JSON.stringify(v.model.toString('base64')),
    },
  })
  return r.outputFiles[0].text
}

/** Run as a script (`node electron-shell/build-app.mjs`), not imported. */
function invokedDirectly() {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(SELF)
  } catch {
    return false
  }
}

async function main() {
  mkdirSync(OUT, { recursive: true })

  let vadWorker
  try {
    vadWorker = await buildVadWorker()
  } catch (e) {
    if (e && e.reason) {
      console.error('BUILD-APP result=FAIL reason=' + e.reason + ' file=' + e.file)
      process.exit(1)
    }
    throw e
  }

  /* TWO OPTIONS ARE NOT STYLE:
       `iife`, not `esm` -- under strict-mode ESM a single assignment to a
       non-writable global ABORTS THE WHOLE MODULE, silently. `index.html`
       asserts a CLASSIC `<script>` tag at build time.
       `minify: true` -- the `js=` figure is a minified byte count; without it the
       same bundle measures ~2x and the number stops meaning anything.
     `target` is `chrome142`: the pinned engine, Obsidian's own. */
  const result = await esbuild.build({
    entryPoints: [join(ROOT, 'src', 'main.ts')],
    outfile: join(OUT, 'app.js'),
    bundle: true,
    format: 'iife',
    target: 'chrome142',
    platform: 'browser',
    minify: true,
    legalComments: 'none',
    treeShaking: true,
    splitting: false,
    drop: ['debugger'],
    logLevel: 'info',
    metafile: true,
    define: { __CAIRN_VAD_WORKER__: JSON.stringify(vadWorker) },
  })

  // Fail loudly if anything Tauri survived the bundle -- that is the whole
  // point of the exercise and it must not pass quietly.
  const inputs = Object.keys(result.metafile.inputs)
  const tauri = inputs.filter((p) => p.includes('@tauri-apps'))
  if (tauri.length > 0) {
    console.error('BUILD-APP result=FAIL reason=tauri-in-bundle files=' + tauri.join(','))
    process.exit(1)
  }

  /* The payload is in app.js exactly when src/vad.ts is, and exactly once: the
     model's base64 is the probe, since nothing else in the page can spell it. */
  const appText = readFileSync(join(OUT, 'app.js'), 'latin1')
  const vadIn = inputs.some((p) => p.replace(/\\/g, '/').endsWith('src/vad.ts'))
  const modelB64 = readVadVendor().model.toString('base64')
  const carried = appText.split(modelB64).length - 1
  if (carried !== (vadIn ? 1 : 0)) {
    console.error('BUILD-APP result=FAIL reason=vad-payload vad_ts=' + vadIn + ' copies=' + carried)
    process.exit(1)
  }

  const css = await bundleCss()

  // The real index.html, with its CSS placeholder filled and its script URL
  // cache-busted by the app.js hash. Read, never modified in place --
  // src/index.html is owner 01's.
  const html = readFileSync(join(ROOT, 'src', 'index.html'), 'utf8')

  /* EXACTLY ONE, not "at least one": String.replace substitutes the FIRST
     occurrence, so a second copy of the token in a doc comment sends the whole
     stylesheet into that comment and ships a page that renders unstyled with no
     console error at all. */
  const nPlaceholder = html.split(PLACEHOLDER).length - 1
  if (nPlaceholder !== 1) {
    console.error('BUILD-APP result=FAIL reason=css-placeholder-count found=' + nPlaceholder)
    process.exit(1)
  }
  // A FUNCTION, not a string: a string replacement would interpret `$&` / `$'` /
  // `` $` `` inside the CSS as substitution patterns.
  const jsBytes = readFileSync(join(OUT, 'app.js'))
  const jsHash = createHash('sha256').update(jsBytes).digest('hex').slice(0, 16)

  /* CACHE-BUST THE SCRIPT.  `index.html` is loaded from `file://`, and Chromium
   * will happily reuse a cached app.js across launches.  That made a rebuilt
   * reader invisible: the page looked new, the JavaScript was old.  The hash makes
   * every build a different URL.  Replace the LAST occurrence because the header
   * comment also spells the tag. */
  const SCRIPT = '<script src="./app.js"></script>'
  let page = html.replace(PLACEHOLDER, () => `<style>${css}</style>`)
  const at = page.lastIndexOf(SCRIPT)
  const styleEnd = page.lastIndexOf('</style>')
  if (at < 0 || at < styleEnd) {
    // The header comment also spells the tag.  If the real one is missing, the
    // last occurrence is inside that comment; rewriting it would ship a page
    // with no executable script while reporting success.
    console.error('BUILD-APP result=FAIL reason=app-script-tag-missing-or-before-style')
    process.exit(1)
  }
  page = page.slice(0, at) + `<script src="./app.js?v=${jsHash}"></script>` + page.slice(at + SCRIPT.length)
  writeFileSync(join(OUT, 'index.html'), page)

  const jsB = jsBytes.length
  const cssB = Buffer.byteLength(css)
  console.log(
    'BUILD-APP result=PASS modules=' + inputs.length + ' tauri_modules=0 js=' + jsB +
      ' B css=' + cssB + ' B vad=' + (carried ? vadWorker.length : 0) + ' B hash=' + jsHash + ' out=' + OUT
  )
}

if (invokedDirectly()) await main()
