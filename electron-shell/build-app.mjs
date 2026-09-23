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
 */

import * as esbuild from 'esbuild'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const OUT = join(HERE, 'app')

// The same cascade order build.mjs pins (tokens.css first -- every other sheet
// assumes its custom properties exist).
const CSS_ORDER = [
  'tokens.css',
  'base.css',
  'chrome.css',
  'tree.css',
  'editor.css',
  'search.css',
  'memoir.css',
]

/** The token src/index.html carries where the stylesheet is inlined. Spelled the
 *  same way build.mjs spells it, and for the same reason: a second literal copy
 *  of the token anywhere in this file would be a candidate substitution site. */
const PLACEHOLDER = '<!' + '--CSS-->'

mkdirSync(OUT, { recursive: true })

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
})

// Fail loudly if anything Tauri survived the bundle -- that is the whole
// point of the exercise and it must not pass quietly.
const inputs = Object.keys(result.metafile.inputs)
const tauri = inputs.filter((p) => p.includes('@tauri-apps'))
if (tauri.length > 0) {
  console.error('BUILD-APP result=FAIL reason=tauri-in-bundle files=' + tauri.join(','))
  process.exit(1)
}

/* The stylesheet, in one esbuild pass, in CSS_ORDER, with K5's drag-region sheet
   LAST so it overrides nothing but the region property.
   `stdin` rather than a generated `_index.css`, so CSS_ORDER here is the one
   copy of the order and nothing is written under src/. */
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
})
const css = cssResult.outputFiles[0].text

// The real index.html, with its CSS placeholder filled and its script left
// alone. Read, never modified in place -- src/index.html is owner 01's.
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
writeFileSync(join(OUT, 'index.html'), html.replace(PLACEHOLDER, () => `<style>${css}</style>`))

const jsB = Buffer.byteLength(readFileSync(join(OUT, 'app.js')))
const cssB = Buffer.byteLength(css)
console.log(
  'BUILD-APP result=PASS modules=' + inputs.length + ' tauri_modules=0 js=' + jsB +
    ' B css=' + cssB + ' B out=' + OUT
)
