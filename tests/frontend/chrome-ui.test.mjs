// Owner: 01 / 04 / 03 (the chrome, tree-chrome and tab-strip modules).
// `node --test tests/frontend/`.
//
// Spec: CONTRACT.md §7.3 case 11 (validate_name, M52), §5.4.2 (the inline
// title shares the same filter), §3.3 (the cap banners, verbatim copy),
// §5.1 (the token table, X3), §5.9 (the nav toolbar's origin), §5.12.4.3 (no
// third scroller), §5.1 rule 5 / M59 (no transitions), §7.4 (the tab is not
// rendered with no note open), §9 E4a (panel-left is omitted).
//
// ===========================================================================
// WHAT THIS FILE CAN AND CANNOT PROVE, STATED UP FRONT
// ===========================================================================
// node --test has no DOM and this project ships no DOM shim (the dependency set
// is pinned at four packages, §6.3/M23, and a jsdom would be a fifth).  So this
// file is deliberately TWO KINDS of test and claims nothing beyond them:
//
//   PART A — behaviour.  The modules' PURE exports, compiled from TypeScript by
//     the same esbuild the app is built with and imported for real.  These are
//     genuine unit tests: validateName is the frontend half of the M52 split and
//     a drift against core/src/path.rs is a real, shippable defect.
//
//   PART B — source conformance.  Grep-shaped assertions over the shipped CSS
//     and TS text.  They are weaker than a rendered assertion and they are here
//     because the rules they guard have ALL been broken before in this project:
//     a raw #e05252 in three files, a `justify-content: center` that lands 1px
//     off every measured centre, a transition on the chevron, a third scroller.
//     Each one is cheap, exact, and fails loudly the day somebody re-adds it.
//
//   PART C — DOM behaviour, against tests/frontend/_minidom.mjs.  The banner
//     reconciler, the §7.4 close table, the §4.3 vault switch and the one menu
//     primitive, driven for real.  This part is NOT a substitute for the probe:
//     the minidom has no layout, so it can prove ORDER, IDENTITY, SEQUENCE and
//     which callback ran, and it can prove nothing at all about a pixel.
//
// What is NOT covered, and is reported rather than faked: the RENDERED geometry
// — every box, colour and font in this file's CSS.  That belongs to
// tools/verify-geometry.js (gate G9), which reads real boxes out of a real
// WebKit, and to a manual pass.  A hand-rolled DOM stub that returned made-up
// rects would only prove that the stub agrees with the code written against
// it, which is why PART C asserts no coordinate that the minidom invents.
// ===========================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as esbuild from 'esbuild'

const ROOT = new URL('../../', import.meta.url).pathname
const read = (p) => readFileSync(ROOT + p, 'utf8')

/** Compile the pure surface of the modules under test into one ESM bundle and
 *  import it.  Neither module touches `document` at module scope — that is
 *  itself part of what this asserts, because an import-time DOM read would make
 *  them untestable and would also run before index.html's body exists. */
async function load() {
  const out = await esbuild.build({
    stdin: {
      contents: `export * from './src/inline-edit'\nexport * from './src/menu'\n`,
      resolveDir: ROOT,
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2021',
    write: false,
  })
  const js = out.outputFiles[0].text
  return import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))
}

const M = await load()

/* =========================================================================
 * PART A — behaviour
 * ====================================================================== */

test('validateName mirrors path.rs rule for rule (§7.3 case 11)', () => {
  const ok = (n) => assert.equal(M.validateName(n).ok, true, `expected legal: ${JSON.stringify(n)}`)
  const no = (n, frag) => {
    const v = M.validateName(n)
    assert.equal(v.ok, false, `expected illegal: ${JSON.stringify(n)}`)
    if (frag) assert.match(v.reason, frag)
  }

  ok('Misc.md')
  ok('Projects')
  ok('a')
  ok('note.with.many.dots.md')
  ok('Ünïcödé notes.md')
  ok('.hidden')                       // dotfiles are legal NAMES; §3.6 hides them from the tree
  ok('CONSOLE.md')                    // stem "CONSOLE" is not the device name "CON"
  ok('MyCON.md')

  no('', /empty/)
  no('   ', /whitespace/)
  no('.', /"\."/)
  no('..', /"\."/)
  no('a/b', /\\ \/ : \* \? " < > or \|/)
  no('a\\b'); no('a:b'); no('a*b'); no('a?b'); no('a"b'); no('a<b'); no('a>b'); no('a|b')
  no('a\u0000b', /control/)
  no('a\u001fb', /control/)
  no(' lead', /space/)
  no('trail ', /space/)
  no('trailing.', /period/)
  no('CON', /Windows/)
  no('con.md', /Windows/)             // ASCII-case-insensitive, and stem is before the FIRST dot
  no('NUL.tar.gz', /Windows/)
  no('LPT9.md', /Windows/)
  no('COM1', /Windows/)
})

test('validateName measures 255 in BYTES, not code units (path.rs name.len())', () => {
  assert.equal(M.MAX_NAME_BYTES, 255)
  assert.equal(M.validateName('a'.repeat(255)).ok, true)
  assert.equal(M.validateName('a'.repeat(256)).ok, false)
  // 85 x 3-byte CJK = 255 bytes but only 85 UTF-16 units: a length check written
  // against `.length` would wrongly admit 255 of them (765 bytes).
  assert.equal(M.utf8Length('\u4e2d'), 3)
  assert.equal(M.validateName('\u4e2d'.repeat(85)).ok, true)
  assert.equal(M.validateName('\u4e2d'.repeat(86)).ok, false)
  assert.equal(M.utf8Length('\u{1f600}'), 4)      // astral: one code point, four bytes
})

test('the beforeinput filter drops exactly path.rs RESERVED plus C0 (§7.3 case 11)', () => {
  assert.equal(M.RESERVED_CHARS, '\\/:*?"<>|')
  for (const ch of M.RESERVED_CHARS) assert.equal(M.isRejectedChar(ch), true, ch)
  for (const ch of '\u0000\u0001\u0009\u000a\u001f') assert.equal(M.isRejectedChar(ch), true)
  for (const ch of 'aZ0 .-_()[]{}~!@#$%^&+=;,\u00e9\u4e2d') assert.equal(M.isRejectedChar(ch), false, ch)

  // The legal remainder is KEPT, not dropped with the rest: pasting "My: Notes"
  // must land "My Notes", not silently do nothing.
  assert.equal(M.sanitizeNameInput('My: Notes'), 'My Notes')
  assert.equal(M.sanitizeNameInput('a/b\\c:d*e?f"g<h>i|j'), 'abcdefghij')
  assert.equal(M.sanitizeNameInput('clean'), 'clean')
  assert.equal(M.sanitizeNameInput(''), '')
  assert.equal(M.sanitizeNameInput('line\nbreak'), 'linebreak')
  // A name made only of rejected characters sanitises to '' and then fails
  // validateName on commit — refused twice, never accepted-then-rejected.
  assert.equal(M.sanitizeNameInput('///'), '')
  assert.equal(M.validateName('').ok, false)
})

test('path helpers agree with §1.1 (vault-relative, "" is the root) and §3.6 (.md)', () => {
  assert.equal(M.basename('a/b/c.md'), 'c.md')
  assert.equal(M.basename('c.md'), 'c.md')
  assert.equal(M.basename(''), '')
  assert.equal(M.parentOf('a/b/c.md'), 'a/b')
  assert.equal(M.parentOf('c.md'), '')          // a top-level entry's parent is the root
  assert.equal(M.parentOf(''), '')
  assert.equal(M.displayName('a/b/Misc.md'), 'Misc')
  assert.equal(M.displayName('a/b/Misc.MD'), 'Misc')   // §3.6: ASCII case-insensitive
  assert.equal(M.displayName('Projects'), 'Projects')  // a folder keeps its name
  assert.equal(M.displayName('.md'), '.md')            // not a 0-length note name
  assert.equal(M.displayName('a.md.md'), 'a.md')
})

test('§0.12 E14 — absolutePath joins the vault root to a vault-relative path', () => {
  // The whole of `Copy absolute path`'s arithmetic.  It is pure and it is here
  // rather than in main.ts because main.ts owns no behaviour.
  assert.equal(M.absolutePath('/home/j/Vault', 'a/b/c.md'), '/home/j/Vault/a/b/c.md')
  assert.equal(M.absolutePath('/home/j/Vault', 'Projects'), '/home/j/Vault/Projects')

  // '' IS THE VAULT ROOT — the empty-space menu's target — and must yield the
  // root alone.  `root + '/' + ''` is a different string, and a trailing slash
  // is not what anyone wants on the clipboard.
  assert.equal(M.absolutePath('/home/j/Vault', ''), '/home/j/Vault')

  // A root that already ends in a separator must not produce '//x'.  POSIX
  // leaves a LEADING '//' implementation-defined, so it is trimmed rather than
  // relied on.  A vault at '/' is pathological; it is still one conditional.
  assert.equal(M.absolutePath('/home/j/Vault/', 'a.md'), '/home/j/Vault/a.md')
  assert.equal(M.absolutePath('/home/j/Vault/', ''), '/home/j/Vault')
  assert.equal(M.absolutePath('/', 'a.md'), '/a.md')
  assert.equal(M.absolutePath('/', ''), '/')

  // Spaces and non-ASCII pass through untouched: this is a filesystem path
  // headed for a clipboard, not a URL.  Percent-encoding it would be wrong.
  assert.equal(M.absolutePath('/home/j/My Vault', 'ノート/a b.md'), '/home/j/My Vault/ノート/a b.md')
})

test('clampPopup keeps a popup on screen and flips before it clips (§5.12.4.3)', () => {
  const VW = 1918, VH = 958
  // Fits where asked.
  assert.deepEqual(M.clampPopup(100, 100, 180, 200, VW, VH), { x: 100, y: 100 })
  // Off the right edge -> pulled left by exactly the overflow plus the 4px margin.
  assert.deepEqual(M.clampPopup(1900, 100, 180, 200, VW, VH), { x: VW - 4 - 180, y: 100 })
  // Off the bottom with no flip line -> pushed up.
  assert.deepEqual(M.clampPopup(100, 900, 180, 200, VW, VH), { x: 100, y: VH - 4 - 200 })
  // The vault bar: anchored at content y 915 of 958, there is NEVER room below,
  // so a flip line above it is the only placement that does not clip.
  assert.deepEqual(M.clampPopup(4, 921, 200, 240, VW, VH, { anchorY: 921 }), { x: 4, y: 681 })
  // A popup taller than the viewport cannot flip either way: it clamps to the
  // top margin and is CLIPPED by overflow:hidden — never given a scroller.
  assert.deepEqual(M.clampPopup(4, 921, 200, 2000, VW, VH, { anchorY: 921 }), { x: 4, y: 4 })
})

test('messageOf renders VaultError by kind and never parses `message` (§1.5)', () => {
  assert.match(M.messageOf({ kind: 'alreadyExists', path: 'a.md' }), /already exists/)
  assert.match(M.messageOf({ kind: 'notFound', path: 'a.md' }), /no longer exists/)
  assert.match(M.messageOf({ kind: 'conflict', path: 'a.md', diskMtimeMs: 1 }), /changed on disk/)
  assert.match(M.messageOf({ kind: 'notUtf8', path: 'a.md' }), /UTF-8/)
  // §7.3 case 15's copy: spec-03's 32 MB guard is STRUCK; the limit is 8 MiB and
  // the sentence names BOTH numbers.
  const tooLarge = M.messageOf({ kind: 'tooLarge', path: 'a.md', bytes: 47 * 1024 * 1024, limit: 8 * 1024 * 1024 })
  assert.match(tooLarge, /47 MB/)
  assert.match(tooLarge, /the limit is 8 MB/)
  // invalidName carries Rust's own reason through verbatim: one sentence per
  // rule, and the frontend's copy of the rule says the same thing.
  assert.equal(M.messageOf({ kind: 'invalidName', name: 'a:b', reason: 'a name cannot contain \\ / : * ? " < > or |' }),
               'a name cannot contain \\ / : * ? " < > or |')
  // `io` is the ONE kind whose OS-localised message is shown, because it is the
  // only thing that says what actually failed.
  assert.equal(M.messageOf({ kind: 'io', path: 'a.md', code: 13, message: 'Permission denied' }), 'Permission denied')
  assert.equal(M.messageOf(new Error('boom')), 'boom')
})

test('§0.16 E18 — a FILE row offers no create rows; a FOLDER row does', () => {
  const calls = []
  const rec = (k) => () => calls.push(k)
  const acts = {
    newNote: rec('newNote'), newFolder: rec('newFolder'), newSecret: rec('newSecret'),
    rename: rec('rename'), copyPath: rec('copyPath'), remove: rec('remove'),
  }
  const file = M.fileRowMenu(acts)
  const folder = M.folderRowMenu(acts)
  const labels = (m) => m.filter((e) => !e.separator).map((e) => e.label)

  // A USER DECISION, and Obsidian's own shape: `app.js` builds the two create
  // rows inside `if (t instanceof ZT)` — the folder branch — while Rename and
  // Delete sit outside it.
  assert.deepEqual(labels(file), ['Rename…', 'Copy absolute path', 'Delete'])
  assert.deepEqual(labels(folder),
    ['New note', 'New folder', 'New secret file', 'Rename…', 'Copy absolute path', 'Delete'])

  // THE TWO MENUS MUST DIFFER. `folderRowMenu` was `= fileRowMenu` for eighteen
  // errata passes, and this assertion is what stops a tidy-up from collapsing
  // them again — which would silently put the create rows back on files.
  assert.notDeepEqual(labels(folder), labels(file))
  assert.equal(labels(file).includes('New note'), false)
  assert.equal(labels(file).includes('New folder'), false)
  assert.equal(labels(file).includes('New secret file'), false)

  // The folder menu is the file menu with three rows on top: same three actions,
  // same order, so a change to one cannot drift the other.
  assert.deepEqual(labels(folder).slice(3), labels(file))

  // §0.12 E14: "Reveal in Finder" is GONE and `Copy absolute path` stands where
  // it stood. X11 restored the reveal row in errata 1 and these menus were its
  // only caller, so this is what would catch a well-meaning restoration.
  assert.equal(labels(file).includes('Reveal in Finder'), false)

  // Every row is wired to its OWN action. A menu returning five rows that all
  // call `remove` would satisfy a labels-only test.
  for (const e of folder.filter((x) => !x.separator)) e.onSelect()
  assert.deepEqual(calls, ['newNote', 'newFolder', 'newSecret', 'rename', 'copyPath', 'remove'])
  calls.length = 0
  for (const e of file.filter((x) => !x.separator)) e.onSelect()
  assert.deepEqual(calls, ['rename', 'copyPath', 'remove'])

  // §5.1 X3: Delete is the one --text-error row, in BOTH menus, and only it.
  for (const m of [file, folder]) {
    const danger = m.filter((e) => e.danger)
    assert.equal(danger.length, 1)
    assert.equal(danger[0].label, 'Delete')
  }

  // Separator counts: the file menu keeps the seam before Delete and loses the
  // one that separated the creates; §5.12.4.3's height arithmetic reads these.
  assert.equal(file.filter((e) => e.separator).length, 1)
  assert.equal(folder.filter((e) => e.separator).length, 2)

  // The empty-space menu OMITS rename/delete rather than disabling them: a
  // permanently greyed row is the inert decoration §9 E4 rejects. It offers
  // just the creates — user ruling, 2026-09-14: `Copy absolute path` is gone
  // here too, since there is no file or folder under the cursor to copy (file
  // and folder rows keep theirs).
  const empty = M.emptySpaceMenu(acts)
  assert.deepEqual(labels(empty), ['New note', 'New folder', 'New secret file'])
  assert.equal(empty.some((e) => e.disabled), false)
})

test('note/memoir context menu — Copy on selection, Paste on clipboard text, both at once', () => {
  const calls = []
  const acts = { copy: () => calls.push('copy'), paste: () => calls.push('paste') }
  const labels = (m) => m.filter((e) => !e.separator).map((e) => e.label)

  // The four states of the two independent conditions. Neither condition
  // implies the other, and neither alone is "no menu".
  assert.deepEqual(labels(M.clipMenu({ hasSelection: true, canPaste: false, ...acts })), ['Copy'])
  assert.deepEqual(labels(M.clipMenu({ hasSelection: false, canPaste: true, ...acts })), ['Paste'])
  assert.deepEqual(labels(M.clipMenu({ hasSelection: true, canPaste: true, ...acts })), ['Copy', 'Paste'])
  assert.deepEqual(M.clipMenu({ hasSelection: false, canPaste: false, ...acts }), [],
    'no selection and an empty clipboard is no menu, not an empty box')

  // Every row is wired to its OWN action.
  for (const e of M.clipMenu({ hasSelection: true, canPaste: true, ...acts })) {
    if (!e.separator) e.onSelect()
  }
  assert.deepEqual(calls, ['copy', 'paste'])

  // Copy before Paste, and neither row is ever disabled or separated: an
  // unofferable row is omitted, not greyed (§9 E4 — the empty-space menu's
  // own rule, applied here too).
  const both = M.clipMenu({ hasSelection: true, canPaste: true, ...acts })
  assert.equal(both.some((e) => e.separator), false)
  assert.equal(both.some((e) => e.disabled), false)
})

test('§0.12 E14 — the sort menu is deleted, not merely unwired', () => {
  // The user pinned sorting to file name A-Z, so `sortMenu`/`SORT_LABELS` are
  // gone from menu.ts rather than left as unreferenced exports that a later
  // reader would take for a live feature.  `tsc` cannot catch a dead EXPORT, so
  // this is the check that does.
  assert.equal(M.sortMenu, undefined)
  assert.equal(M.SORT_LABELS, undefined)
  assert.equal(/sortMenu|SORT_LABELS/.test(read('src/menu.ts').split('*/').slice(1).join('*/')), false,
    'menu.ts still has sort-menu CODE below its header comment')

  // …and §1.3 command 7 SURVIVES with exactly one caller: main.ts correcting a
  // vault whose persisted mode is not 0.  The ruling was "no UI", not "no
  // sorter", and an ipc.ts that had dropped the wrapper would no longer mirror
  // the command table.
  const main = read('src/main.ts')
  assert.match(read('src/ipc.ts'), /export function setSort\(/)
  assert.match(main, /if \(info\.sort !== 0\)/)
  assert.match(main, /await setSort\(0\)/)
})

/* =========================================================================
 * PART B — source conformance
 * ====================================================================== */

/** Strip `/* … *\/` blocks.  Every rule below greps for a pattern that this
 *  file's own PROSE also contains — "the raw #e05252 literal is STRUCK", "no
 *  `overflow: auto` anywhere", "`.at-edge` went with it" — so a naive grep over
 *  the raw text fails on the comment that documents the rule.  Stripping first
 *  is what makes these assertions about the SHIPPED CSS rather than about how
 *  carefully the CSS was annotated. */
function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, ' ')
}

const chromeTs = read('src/chrome.ts')
const chromeCssRaw = read('src/styles/chrome.css')
const chromeCss = stripCssComments(chromeCssRaw)
const tabstripTs = read('src/tabstrip.ts')
const indexHtml = read('src/index.html')
const contract = read('docs/CONTRACT.md')

test('the §3.3 cap-banner copy is byte-identical to the contract', () => {
  // The two strings are quoted in CONTRACT §3.3's table AND in its X9 bullet.
  // Copy that drifts from a normative document is the failure this catches, and
  // it is invisible in any rendered test.
  const nodes = 'This vault is very large; only the first 50,000 items are shown.'
  const depth = 'Some folders are nested too deeply to display.'
  assert.ok(contract.includes(nodes), 'the contract no longer contains the nodes-cap sentence')
  assert.ok(contract.includes(depth), 'the contract no longer contains the depth-cap sentence')
  assert.ok(chromeTs.includes(`'${nodes}'`), 'chrome.ts drifted from §3.3 nodes copy')
  assert.ok(chromeTs.includes(`'${depth}'`), 'chrome.ts drifted from §3.3 depth copy')
})

/* CONTRACT §0.11 measured the tab label at 12px by inverting a cap-height band
 * out of the reference PNG through INTER's 0.7275 cap ratio.  §0.18 E23 then
 * established that Obsidian does not render in Inter — the same refutation that
 * took `--h1-size` from 29 to 25.888 (§0.19 E24) — and CLAUDE.md listed the tab
 * label as still open, "needs a 1.12.7 asar".  The Obsidian installed on this
 * machine IS 1.12.7, so it is a grep now:
 *     --tab-font-size: var(--font-ui-small)   app.css:2691
 *     --font-ui-small: 13px                   app.css:2247
 *     --tab-font-weight: inherit              app.css:2692  -> 400, because
 *                                             `body` (app.css:3134) sets none
 * Confirmed against the live Obsidian on this machine over CDP, 2026-09-10:
 * `getComputedStyle(.workspace-tab-header-inner-title).fontSize` is `13px` and
 * its weight is `400`.  A 12px label fits three more characters before the
 * ellipsis than Obsidian's does, which is what the user reported seeing. */
test('§0.11 → 13px: the tab label is --font-ui-small, like Obsidian\'s', () => {
  const tab = /\.tab-label\s*\{([^}]*)\}/.exec(chromeCss)
  assert.ok(tab, 'chrome.css no longer styles .tab-label')
  assert.match(tab[1], /font-size:\s*var\(--fs-ui-small\)/,
    'the tab label is Obsidian\'s --tab-font-size, which IS --font-ui-small (app.css:2691). ' +
    '§0.11\'s 12px was inverted through Inter\'s cap ratio and E23 struck that method.')
  assert.match(tab[1], /font-weight:\s*400/, '--tab-font-weight is `inherit`, and body sets none')
  /* §0.26.2. Obsidian's title declares no line-height and inherits `body`'s
     `--line-height-tight` (app.css:2401), so it computes 16.9px at 13px.
     Cairn's `--lh-ui` is 1, so the label needs the declaration or its box is a
     flat 13 — and that is one of the two halves of the half-pixel the user
     reported. The ENGINE half is `lifecycle.test.mjs`; this is the sheet. */
  assert.match(tab[1], /line-height:\s*1\.3/,
    "the tab label lost Obsidian's --line-height-tight (1.3), which its own body rule puts on the title")
  const fs = Number(/--fs-ui-small:\s*(\d+)px/.exec(read('src/styles/tokens.css'))[1])
  assert.equal(fs, 13, '[S] Obsidian --font-ui-small')
})

test('§7.4 — the tab is not rendered with no note open', () => {
  // The scaffold ships `.tab` visible; the fix must be on the boot path that
  // exists today, which is chrome.ts's mountChrome().
  assert.match(tabstripTs, /export function hideTabUntilWired/)
  assert.match(tabstripTs, /tab\.hidden = true/)
  assert.match(chromeTs, /hideTabUntilWired\(root\)/)
  assert.match(chromeCss, /\.tab\[hidden\]\s*\{\s*display:\s*none/)
  // index.html still ships it visible — that is owner 01's other file and is
  // reported, not silently patched here.  This assertion records the state so
  // the report cannot go stale without the suite noticing.
  assert.match(indexHtml, /<div class="tab is-active"/)
})

test('§5.12.4.3 — chrome.css introduces NO third scroller', () => {
  // Any box with overflow auto|scroll|overlay whose content overflows earns its
  // own compositing surface; a viewport-sized one is ~23.5 MB at 2x and fails
  // both the probe's layers.scrollers row and gate G5d.  The document has
  // exactly two scrollers and neither of them is declared in this file.
  const bad = chromeCss.match(/overflow(-x|-y)?\s*:\s*(auto|scroll|overlay)/g)
  assert.equal(bad, null, `chrome.css declares a scroller: ${bad}`)
  // Every floating box in this file clips instead.
  assert.match(chromeCss, /\.ctx-menu[\s\S]*?overflow:\s*hidden/)
})

test('§5.1 — chrome.css declares no custom property and holds no struck literal', () => {
  // tokens.css is the ONLY declaration site (M32, M36).  A declaration is
  // `--name:` at the start of a rule body; `var(--name)` is a use and is fine.
  const decls = chromeCss.match(/(^|[;{]\s*)--[a-z0-9-]+\s*:/gim)
  assert.equal(decls, null, `chrome.css declares custom properties: ${decls}`)
  // §5.1 X3: the raw #e05252 literal is STRUCK in tree.css, search.css AND
  // chrome.css alike; the token is declared once and consumed by name.
  assert.equal(/#e05252/i.test(chromeCss), false, 'chrome.css carries the struck #e05252 literal')
  // AND THE DECIMAL FORM, which is the hole this guard had. `rgba(224,82,82,.09)`
  // IS #e05252 and a hex grep cannot see it — search.css carried two of them
  // through every pass this rule has existed, and they only surfaced when
  // --text-error moved and they did not move with it.
  for (const [file, css] of [['chrome.css', chromeCss], ['tree.css', read('src/styles/tree.css')],
                             ['search.css', read('src/styles/search.css')]]) {
    assert.equal(/\b224\s*,\s*82\s*,\s*82\b/.test(css), false,
      `${file} carries the struck #e05252 as a DECIMAL rgb triple`)
  }
  assert.match(chromeCss, /var\(--text-error\)/)
})

test('§0.12 E14 — the nav toolbar is deleted at the source, in all four files', () => {
  // A USER DECISION.  This test replaces `§5.9 X5 — the nav group is positioned,
  // never centred`, which sliced chrome.css between `.nav-toolbar {` and
  // `.nav-toolbar .icon-btn` and asserted the measured origin.  Deleting only
  // ONE of those two markers would have made that slice `''` and failed on a
  // missing `gap: 4px` — a message about the wrong thing entirely.  So the check
  // is inverted: the toolbar must be gone from every file that drew it.
  assert.equal(/nav-toolbar/.test(chromeCss), false, 'chrome.css still styles the nav toolbar')
  assert.equal(/nav-toolbar/.test(indexHtml), false, 'index.html still ships the nav toolbar')
  assert.equal(/--navbar-h/.test(read('src/styles/tokens.css')), false,
    'tokens.css still declares --navbar-h, which now has no consumer')
  assert.equal(/--navbar-h/.test(chromeCss), false)

  // The glyphs that existed ONLY for the toolbar went with it, and `panel-left`
  // — dead since §9 E4a and still shipped — went too.
  //
  // `folder-plus` is NOT on this list, and that is the point of the rule below
  // rather than of a fixed roster: §0.14 E16 brought it and `file-plus` back for
  // the row menus, which is legitimate precisely because they now have a host.
  // E14 never banned a glyph; it banned a glyph nothing draws.
  const iconsTs = read('src/icons.ts')
  const body = iconsTs.slice(iconsTs.indexOf('export type IconName'))
  //
  // `square-pen` is NOT on this list either, and the reason is §0.15 E17: its
  // path data is back, character for character, under `edit` — which is what
  // Obsidian's own registry calls the identical glyph and what its New note row
  // asks for. The literal name stays gone; the drawing came back with a host.
  for (const dead of ['arrow-up-narrow-wide', 'refresh-cw',
                      'chevrons-down-up', 'panel-left']) {
    assert.equal(body.includes(`'${dead}'`), false, `icons.ts still carries the ${dead} literal`)
  }
})

test('§9 E4 / §0.12 E14 — every glyph in icons.ts has a host, and no glyph is inert', () => {
  // THE RULE E14 ACTUALLY ENFORCES, written as a rule instead of as a roster.
  // A Lucide literal with nothing that draws it is dead weight — which is what
  // `panel-left` was for eleven errata passes, in plain sight, because the only
  // check anyone had written was a count.  `tsc` cannot see this: the table is
  // keyed by a union type, so an unused entry is well-typed forever.
  const iconsTs = read('src/icons.ts')
  const table = iconsTs.slice(iconsTs.indexOf('const G: Record<IconName, Glyph>'),
                              iconsTs.indexOf('const W: Record<WindowIconName'))
  const declared = [...table.matchAll(/^\s*'([a-z0-9-]+)':\s*\{\s*size:/gm)].map((m) => m[1])
  assert.ok(declared.length >= 3, 'the glyph table could not be parsed')

  // A host is `data-icon="name"` in the markup, `icon: 'name'` in a module that
  // hands it to menu.ts, or `dataset['icon'] = 'name'` in a module that builds
  // its own host element.  All three are searched, because each was introduced
  // by a later pass than the scan and a scan that knows only the earlier forms
  // reports live glyphs as dead — E16 added the second kind, the search panel's
  // back button the third.
  //
  // src/search.ts IS ON THIS LIST, and it has to be: it is the only file that
  // draws `files`, and until it was added here this test failed with
  // "icons.ts declares 'files' and nothing in the app draws it" while the button
  // was on screen and working.  A roster of files is the same liability as a
  // roster of glyph names; if a fourth module ever paints an icon, it goes here.
  //
  // src/properties.ts is the FOURTH module, added by §5.4.5, and it is the one
  // the note above predicted.  It needs no new form: its Properties-block
  // triangle is `dataset['icon'] = 'right-triangle'` (form three) and its nine
  // property-type glyphs are the `icon: 'name'` values of `TYPE_WIDGET` (form
  // two), which is the shape Obsidian's own `registeredTypeWidgets` has.
  //
  // src/tree.ts is the FIFTH, added by drag-to-move: its `.drag-ghost-icon`
  // hosts are `dataset['icon'] = 'file' | 'folder-open' | 'files'` (form three),
  // Obsidian's own per-kind `dragFile`/`dragFolder`/`dragFiles` strings.
  const hosts = [indexHtml, read('src/menu.ts'), chromeTs, read('src/main.ts'),
                 read('src/vaultbar.ts'), read('src/tabstrip.ts'),
                 read('src/search.ts'), read('src/properties.ts'),
                 read('src/tree.ts')].join('\n')
  for (const name of declared) {
    assert.ok(hosts.includes(`data-icon="${name}"`) || hosts.includes(`icon: '${name}'`) ||
              hosts.includes(`dataset['icon'] = '${name}'`),
      `icons.ts declares '${name}' and nothing in the app draws it`)
  }

  // …AND THE OTHER DIRECTION, WHICH WAS MISSING AND COST A BUILD (§0.30 E71).
  // Deleting the `plus` glyph with the tab strip's `+` left `properties.ts`'s
  // `+ Add property` asking for a name icons.ts no longer had — and the failure
  // is SILENT: `paintIcons` leaves a host whose name is in neither table alone,
  // so the button still rendered, still carried its `data-icon`, and was blank.
  // `node --test electron-shell/live-preview.test.mjs` caught it; nothing in
  // this file could, because every row here ran glyph -> host.
  const wanted = new Set([
    ...hosts.matchAll(/data-icon="([a-z0-9-]+)"/g),
    ...hosts.matchAll(/icon: '([a-z0-9-]+)'/g),
    ...hosts.matchAll(/dataset\['icon'\] = '([a-z0-9-]+)'/g),
  ].map((m) => m[1]))
  const windowIcons = new Set(['win-minimize', 'win-maximize', 'win-restore', 'win-close'])
  for (const name of wanted) {
    if (windowIcons.has(name)) continue          // the separate `W` table
    assert.ok(declared.includes(name),
      `something in the app draws '${name}' and icons.ts declares no such glyph — ` +
      'it will render as an EMPTY box with no error anywhere')
  }

  // `.icon-btn` is NOT deleted with them: it is the shared base rule for
  // icon buttons (vault popover rows, window controls via their own class),
  // and dropping it would unstyle any future host.
  //
  // §0.30 E71 DELETED THE OTHER ONE. The tab strip's `+` was a NEW NOTE button
  // wearing Obsidian's new-TAB glyph, and Cairn has never had a second tab for
  // it to open — a user decision: "We only support single-tab viewer. New
  // note/folder works on the sidebar, not here!". Pinned ABSENT, along with its
  // glyph and its CSS rule, because a half-deleted control is the shape §9 E4
  // exists to forbid.  2026-09-16 the tab ✕ joined it (user ruling: both tabs
  // fixed, can't close) — pinned ABSENT the same way.
  assert.match(chromeCss, /^\.icon-btn \{/m)
  assert.equal(/class="icon-btn tab-close"/.test(indexHtml.replace(/<!--[\s\S]*?-->/g, '')), false, 'the tab ✕ is back')
  assert.equal(/class="icon-btn plus"/.test(indexHtml), false, 'the `+` button is back')
  // THE GLYPH IS NOT DELETED WITH IT, and that correction is worth pinning: the
  // first draft of E71 took `plus` out of icons.ts too, and `properties.ts`'s
  // `+ Add property` — its other host since §5.4.5 — went blank with no error
  // anywhere. Only the BUTTON, its CSS rule and its wiring are gone.
  assert.match(read('src/icons.ts'), /'plus': \{ size: 18/, 'the `plus` GLYPH was deleted with the button')
  assert.match(read('src/properties.ts'), /dataset\['icon'\] = 'plus'/)
  assert.equal(/\.icon-btn\.plus/.test(chromeCss), false, 'the `+` still has a CSS rule')
  assert.equal(/newNote/.test(read('src/tabstrip.ts')), false,
    'tabstrip.ts still takes a `newNote` dep — the `+` was its only caller')

  // The probe must lose the two rows in the SAME change, not later: G9 is
  // `fail === 0 && skip === 0`, so a row whose element is gone reports SKIP and
  // takes a correct app red.
  const probe = read('tools/verify-geometry.js')
  assert.equal(/row\('nav/.test(probe), false, 'verify-geometry.js still runs a nav row')
  assert.equal(/navSlot|navGroupL|K\.navH/.test(probe), false,
    'verify-geometry.js still derives nav geometry')
  assert.match(probe, /K\.treeTop\s*=\s*K\.stripH;/)
})

test('§0.12 E14 — E9\'s 158px sidebar floor was the nav toolbar\'s, and only SIDEBAR_MIN is left', () => {
  // The old origin `calc((var(--sidebar-w) - 156px) / 2 - 1px)` went negative
  // below 158px, which is why E9 had to pin the relationship to SIDEBAR_MIN.
  // With the toolbar gone nothing in chrome.css has that property any more — but
  // SIDEBAR_MIN itself must not be relaxed on those grounds, because EDITOR_MIN
  // is the real constraint and this test is where that reasoning is recorded.
  assert.equal(/calc\(\(var\(--sidebar-w\) - \d+px\) \/ 2/.test(chromeCss), false)
  assert.match(chromeTs, /SIDEBAR_MIN\s*=\s*180/)
})

test('every ground is the Oceanic value (user ruling 2026-09-30, no longer Obsidian)', () => {
  // The palette no longer targets Obsidian: every ground is Oceanic #16.
  // Keyed to the token name so the failure message says which token broke.
  const tokens = read('src/styles/tokens.css')
  const BASE = {
    '--bg-primary': '#182028',
    '--bg-primary-alt': '#212a34',
    '--bg-secondary': '#252f3a',
    '--bg-menu': '#252f3a',
    '--bg-form-field': '#303a47',
    '--bg-titlebar': '#323e4c',
    '--bg-modifier-border': '#334052',
    '--tab-outline': '#334052',
  }
  for (const [name, want, chain] of [
    ['--bg-primary',         '#182028', 'editor ground'],
    ['--bg-primary-alt',     '#212a34', 'code-background'],
    ['--bg-secondary',       '#252f3a', 'sidebar ground'],
    ['--bg-menu',            '#252f3a', 'menu-background = sidebar ground'],
    ['--bg-form-field',      '#303a47', 'form field'],
    ['--bg-titlebar',        '#323e4c', 'titlebar ground'],
    ['--bg-modifier-border', '#334052', '1px rules'],
    ['--tab-outline',        '#334052', 'tab outline = 1px rules'],
  ]) {
    const m = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(tokens)
    assert.ok(m, `${name} is not declared as a hex in tokens.css`)
    assert.equal(m[1].toLowerCase(), BASE[name],
      `${name} must be ${BASE[name]} (${chain}), got ${m[1]}`)
  }

  // THE STRIP AND THE SIDEBAR ARE NOT THE SAME COLOUR. app.css:2818 says
  // `--titlebar-background: var(--background-secondary)` and :2819 + :4116-4118
  // immediately override it to `--background-secondary-alt` under
  // `body.is-focused`. Reading only the first line is how a pass concluded the
  // strip merges into the sidebar; a window in use is always focused.
  const strip = /--bg-titlebar:\s*(#[0-9a-fA-F]{6})/.exec(tokens)[1].toLowerCase()
  const side = /--bg-secondary:\s*(#[0-9a-fA-F]{6})/.exec(tokens)[1].toLowerCase()
  assert.notEqual(strip, side, 'the strip must not collapse into the sidebar — that is the UNFOCUSED value')

  // The three inks are Oceanic's and must not drift.
  for (const [name, want] of [['--text-normal', '#d7dfe9'], ['--text-muted', '#a5b1c2'],
                              ['--text-faint', '#626d7e'], ['--text-error', '#f26d6d']]) {
    const m = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(tokens)
    assert.equal(m[1].toLowerCase(), want, `${name} must be ${want}`)
  }

  // The two blends are DECLARED AS BLENDS, not frozen as the hex they happen to
  // paint over today's ground. Oceanic tints them ice-blue.
  assert.match(tokens, /--indent-guide:\s*rgba\(170,205,240,\.14\)/,
    'the indent guide must be Oceanic ice-blue, not a hex frozen against one ground')
  assert.match(tokens, /--bg-modifier-hover:\s*rgba\(170,205,240,\.08\)/,
    'hover is Oceanic ice-blue 8%')
})

test('§5.1 rule 5 / M59 — chrome.css declares no transition and no animation', () => {
  const bad = chromeCss.match(/^\s*(transition|animation)\s*:/gm)
  assert.equal(bad, null, `chrome.css animates: ${bad}`)
})

test('the vault bar is a 43px BORDER BOX whose height is its own parts, rule included', () => {
  const bar = chromeCss.slice(chromeCss.indexOf('.vault-bar {'), chromeCss.indexOf('.vault-switch {'))
  assert.match(bar, /box-sizing:\s*border-box/)
  assert.match(bar, /border-top:\s*1px solid var\(--bg-modifier-border\)/)
  assert.match(bar, /height:\s*var\(--vaultbar-h\)/)

  // THE HEIGHT IS NOT A NUMBER TO COPY, IT IS A SUM TO RE-DERIVE — which is the
  // whole reason 37 stood for eighteen errata passes without anyone catching it.
  // The 37 was never measured: it is `winH 958 − rule 921`, and 958 is five short
  // of the reference PNG's own 963px content box (rows 31..993 between 1px chrome
  // at y30 and y994). The rule at content 921 is right; the height derived from it
  // was not. See chrome.css `.vault-bar` for the full arithmetic and for how this
  // also closes §5.10 R2's "unexplained 3px".
  //
  // Obsidian 1.13.7 gives the bar `height: unset` and 8px of padding round a
  // content row as tall as its tallest child (app.css:6319-6330); the tallest
  // child is the `?`/gear column's `.clickable-icon`, `--size-2-2` padding round
  // an `--icon-m` glyph = 4 + 18 + 4 = 26 (8010-8022).  Cairn omits those two
  // controls (§9 E4) and keeps the row they set, so the bar reads
  //     1 (rule) + 8 (pad) + 26 (content row) + 8 (pad) = 43.
  const RULE = 1, PAD = 8, ICON_M = 18, CLICKABLE_PAD_Y = 4
  const contentRow = CLICKABLE_PAD_Y + ICON_M + CLICKABLE_PAD_Y      // 26
  const derived = RULE + PAD + contentRow + PAD                       // 43
  const tokens = read('src/styles/tokens.css')
  const declared = Number(/--vaultbar-h:\s*(\d+)px/.exec(tokens)?.[1])
  assert.equal(declared, derived,
    `--vaultbar-h must be ${derived} = 1 + ${PAD} + ${contentRow} + ${PAD}, not ${declared}`)

  // …and the sidebar column must still close on the window, which is the half of
  // §5.10 R2 that survives: a content-box bar would sum to 959.
  const STRIP = 40, WIN_H = 958
  assert.equal(STRIP + (WIN_H - STRIP - declared) + declared, WIN_H)
  assert.equal(WIN_H - STRIP - declared, 875, 'the tree band follows the bar: 958 − 40 − 43')

  // The bar pads on BOTH axes now: the switcher, not the bar, supplies the
  // second 8px that keeps the chevron box at content x 16..32.
  assert.match(bar, /padding:\s*8px/)
  assert.equal(/padding-left:\s*16px/.test(bar), false,
    'the bar still carries the old single 16px padding-left; the switcher cannot then start its hover box at x 8')
})

test('the vault switcher fills the bar, so the hover box is the row and not the label', () => {
  const sw = chromeCss.slice(chromeCss.indexOf('.vault-switch {'),
                             chromeCss.indexOf('.vault-switch:hover'))
  // Obsidian's `.workspace-drawer-vault-switcher` is `flex-grow: 1` with
  // `padding: var(--size-4-1) var(--size-4-2)` (app.css:6335-6340).  Without the
  // grow the highlight hugs the glyph + label and dies after the vault name,
  // which is exactly the mismatch this pass was opened for.
  assert.match(sw, /flex:\s*1 1 auto/, 'the switcher must grow, or the hover box is only as wide as the name')
  assert.match(sw, /padding:\s*4px 8px/)
  assert.match(sw, /gap:\s*8px/, "Obsidian's gap is --size-4-2 (8), not 6 — it is what puts the label at 40")
  // NO pinned height. Obsidian derives the box from `4 + max(icon, name line box)`
  // and the NAME wins: 13px at its body line-height of 1.3 is 16.9, so the hover
  // box is 24.9 and not 24. Pinning 24 both missed by 0.9px and froze a number
  // Obsidian computes — `.vault-name`'s line-height is what must set it.
  assert.equal(/height:\s*\d/.test(sw), false,
    'the switcher must not pin a height; its box comes from its padding and the name line box')
  const nm = chromeCss.slice(chromeCss.indexOf('.vault-name {'),
                             chromeCss.indexOf('}', chromeCss.indexOf('.vault-name {')))
  assert.match(nm, /line-height:\s*1\.3/,
    "without Obsidian's 1.3 the name's line box is under the 16px icon and the hover box collapses to 24")
  assert.ok(Math.abs((4 + 13 * 1.3 + 4) - 24.9) < 0.05, '4 + 13x1.3 + 4 = 24.9')
  assert.match(sw, /border-radius:\s*var\(--radius-s\)/)
  assert.match(chromeCss, /\.vault-switch:hover \{ background: var\(--bg-modifier-hover\); \}/)

  // 8 (bar) + 8 (switcher) + 16 (chevron) + 8 (gap) = 40, and the chevron box is
  // still 16..32 — the probe's `vault.bar` row asserts both numbers.
  assert.equal(8 + 8, 16)
  assert.equal(8 + 8 + 16 + 8, 40)
})

test('the vault name is --text-normal at 500 and the chevron is --text-faint', () => {
  // app.css:6332 puts `--vault-profile-color` (= --text-normal) on the SWITCHER
  // and 6357-6362 sets only size and weight on the name, so the colour falls
  // through; 6364-6370 give the icon `--text-faint` and 6353 lifts it to
  // `--text-muted` on hover.  Cairn had the name at --text-muted and the icon at
  // --icon-color, i.e. both at #b3b3b3 and neither at Obsidian's value.
  const sw = chromeCss.slice(chromeCss.indexOf('.vault-switch {'),
                             chromeCss.indexOf('.vault-switch:hover'))
  assert.match(sw, /color:\s*var\(--text-normal\)/)

  const name = chromeCss.slice(chromeCss.indexOf('.vault-name {'),
                               chromeCss.indexOf('}', chromeCss.indexOf('.vault-name {')))
  assert.match(name, /font-weight:\s*500/)
  assert.equal(/color:/.test(name), false,
    'the name must INHERIT --text-normal from the switcher, not re-declare a colour')

  const ico = chromeCss.slice(chromeCss.indexOf('.ico-vault {'),
                              chromeCss.indexOf('}', chromeCss.indexOf('.ico-vault {')))
  assert.match(ico, /color:\s*var\(--text-faint\)/)
  assert.match(chromeCss, /\.vault-switch:hover \.ico-vault \{ color: var\(--text-muted\); \}/)
})

/* =========================================================================
 * PART C — DOM behaviour, against the minidom this project already ships
 *
 * The header above said this file could not do this, on the grounds that there
 * is no DOM shim.  THAT IS NO LONGER TRUE: tests/frontend/_minidom.mjs exists
 * (owner 05, written for src/search.ts) and covers exactly the surface
 * chrome.ts and tabstrip.ts touch — createElement, insertBefore, textContent,
 * classList, hidden, comma-list selectors and one-level event dispatch.  Two
 * methods are missing from it and are shimmed HERE rather than in that file,
 * which this assignment does not own; both are reported.
 *
 * These rows are about the two things in this assignment that can lose work or
 * lie to the user, and neither is reachable from a grep:
 *   - §3.3, the banner reconciler.  A banner appearing shortens the live
 *     scroller from 842 to 818 to 794, and owner 04 sizes the row pool from
 *     that live clientHeight on `resize`.  If the reconciler re-creates instead
 *     of reusing, or fires no resize, the pool is sized for a scroller that no
 *     longer exists and the tree renders short by a row.
 *   - §7.4, the close table.  A rejected flush MUST cancel the close.  This is
 *     the one control in the app that looks like it discards something.
 * ====================================================================== */

import { installGlobals, AElement, ADocument } from './_minidom.mjs'

/* The two DOM methods `_minidom.mjs` does not implement.  REPORTED to owner 05
 * rather than added there: this assignment owns no file under tests/ but this
 * one, and a shim that lives beside its use cannot silently rot in a file its
 * author never reads. */
AElement.prototype.removeAttribute = function (k) { this.attrs.delete(k) }
AElement.prototype.appendChild = function (n) { this.append(n); return n }
AElement.prototype.toggleAttribute = function (k, force) {
  const want = force === undefined ? !this.attrs.has(k) : !!force
  if (want) this.attrs.set(k, ''); else this.attrs.delete(k)
  return want
}
/* `_minidom.mjs`'s selector engine is documented as having no combinators.
 * chrome.ts and tabstrip.ts DO use descendant selectors — `.tab-strip .plus`,
 * `.titlebar-left .icon-btn…` — so one level of descendant support is added
 * here, on top of the existing engine rather than replacing it.  (The
 * `.nav-toolbar .icon-btn[data-icon="refresh-cw"]` selector that motivated this
 * is gone with §0.12 E14's toolbar; the support stays for the others.) */
/* `openMenu` places a real box: it reads offsetWidth/offsetHeight, writes
 * el.style and appends to document.body.  None of that exists in the minidom.
 * The two sizes below stand in for a real measured box — they are the INPUT to
 * clampPopup, which PART A already tests as arithmetic, so the numbers only
 * have to be plausible for the placement rows to mean something.  They no
 * longer describe any shipped menu: §0.12 E14 deleted the sort menu they were
 * taken from, and §0.14 E16 dropped the 180px `min-width` and took the row from
 * 28px to 24.9. Nothing reads them as geometry, which is why they are FIXED
 * CONSTANTS rather than something derived from chrome.css. */
Object.defineProperty(AElement.prototype, 'style', {
  get() { if (!this._style) this._style = {}; return this._style },
  configurable: true,
})
Object.defineProperty(AElement.prototype, 'offsetWidth', { get() { return 180 }, configurable: true })
Object.defineProperty(AElement.prototype, 'isConnected', {
  get() { let n = this; while (n.parentNode) n = n.parentNode; return n !== this },
  configurable: true,
})
Object.defineProperty(AElement.prototype, 'offsetHeight', {
  get() { return 8 + this.children.length * 28 }, configurable: true,
})

const qsaSimple = AElement.prototype.querySelectorAll
AElement.prototype.querySelectorAll = function (sel) {
  const groups = String(sel).split(',').map((s) => s.trim()).filter(Boolean)
  // F66: `_minidom.mjs` has no `#id` selector either, and `setNoteBar`
  // anchors on `#ed`. Same deal as the descendant support below: shimmed
  // HERE, on top of the existing engine rather than replacing it.
  const needsId = groups.some((g) => /#[A-Za-z0-9_-]+/.test(g))
  if (!needsId) {
    if (!groups.some((g) => /\s/.test(g))) return qsaSimple.call(this, sel)
  }
  const out = []
  for (const g of groups) {
    const parts = g.split(/\s+/)
    const last = parts[parts.length - 1]
    const idm = /#([A-Za-z0-9_-]+)/.exec(last)
    let cands
    if (idm) {
      cands = this.descendants().filter((e) => e.attrs.get('id') === idm[1])
      const rest = last.replace(/#[A-Za-z0-9_-]+/g, '').trim()
      // A bare tag (`main` in `main#ed`) is unmatchable here, as in the base
      // engine; a class rest still goes through it.
      const cls = (rest.match(/\.[A-Za-z0-9_-]+|\[[^\]]+\]/g) ?? []).join('')
      if (cls) cands = cands.filter((e) => qsaSimple.call(this, cls).includes(e))
    } else if (/\s/.test(g)) {
      cands = qsaSimple.call(this, last)
    } else {
      cands = qsaSimple.call(this, g)
    }
    for (const el of cands) {
      let n = el.parentNode
      let ok = true
      for (let i = parts.length - 2; i >= 0; i -= 1) {
        n = n && n.closest ? n.closest(parts[i]) : null
        if (!n) { ok = false; break }
        n = n.parentNode
      }
      if (ok && !out.includes(el)) out.push(el)
    }
  }
  return out
}

/** Install `document`, `window` and `Event` for the duration of the file.  The
 *  modules read them at CALL time, never at import time — which PART A already
 *  asserts by importing them with no DOM present at all. */
function installDom() {
  installGlobals()
  const doc = new ADocument()
  doc.body = doc.createElement('body')
  const resizes = []
  globalThis.Event = class Event { constructor(t) { this.type = t } }
  globalThis.Node = AElement
  globalThis.HTMLElement = AElement
  doc.listeners = new Map()
  doc.addEventListener = (t, fn) => { (doc.listeners.get(t) ?? doc.listeners.set(t, []).get(t)).push(fn) }
  doc.removeEventListener = (t, fn) => {
    const l = doc.listeners.get(t) ?? []
    const i = l.indexOf(fn)
    if (i >= 0) l.splice(i, 1)
  }
  doc.fire = (t, ev) => { for (const fn of [...(doc.listeners.get(t) ?? [])]) fn(ev) }
  // §0.29 E69 — `menu.ts` places against `body.clientWidth/clientHeight`, which
  // is what Obsidian measures against, so the stub has to carry them. The gate
  // window is 1920 x 964 (§0.22 E41) and §5.12.5 pins `html, body { overflow:
  // hidden; height: 100% }`, so the body IS the viewport.
  doc.body.clientWidth = 1920
  doc.body.clientHeight = 964
  globalThis.document = doc
  globalThis.window = {
    innerWidth: 1918,
    innerHeight: 958,
    dispatchEvent(ev) { resizes.push(ev.type); return true },
    addEventListener() {},
    removeEventListener() {},
  }
  return { doc, resizes }
}

/** `.sidebar` in the shape src/index.html ships it since §0.12 E14: the banner
 *  slot, then the live `.tree-scroller`.  The `.nav-toolbar` that used to be
 *  element 0 here is gone, which is why every `kids()` assertion below starts at
 *  the banners. */
function sidebarFixture(doc) {
  const sidebar = doc.createElement('aside')
  sidebar.className = 'sidebar'
  const tree = doc.createElement('div'); tree.className = 'tree-scroller'
  sidebar.append(tree)
  const root = doc.createElement('div')
  root.append(sidebar)
  return { root, sidebar, tree }
}

const banners = (sidebar) => sidebar.querySelectorAll('.cap-banner')
const kids = (sidebar) => sidebar.children.map((e) => e.className.split(' ')[0])

/** chrome.ts and tabstrip.ts bundled the same way.  Nothing under `src/`
 *  imports `@tauri-apps/api` any more, so no stub is needed. */
async function loadChrome() {
  const out = await esbuild.build({
    stdin: {
      contents: `export * from './src/chrome'\nexport * from './src/tabstrip'\n` +
              `export * from './src/vaultbar'\nexport * from './src/menu'\n` +
              `export * as modal from './src/modal'\n`,
      resolveDir: ROOT,
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2021',
    write: false,
  })
  return import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'))
}

const C = await loadChrome()

test('§3.3 — the banners are SIBLINGS of the live scroller, above it, never children', () => {
  const { doc, resizes } = installDom()
  const { root, sidebar, tree } = sidebarFixture(doc)

  C.setCapBanners(true, true, root)
  assert.deepEqual(kids(sidebar), ['cap-banner', 'cap-banner', 'tree-scroller'])
  assert.equal(tree.children.length, 0, 'a banner was put INSIDE the scroller and will scroll away')
  assert.deepEqual(banners(sidebar).map((b) => b.textContent),
    [C.CAP_BANNER_NODES, C.CAP_BANNER_DEPTH])
  assert.deepEqual(resizes, ['resize'], 'the scroller changed height and nobody was told')
})

test('§3.3 — the reconciler REUSES the node banner when the depth banner appears', () => {
  const { doc, resizes } = installDom()
  const { root, sidebar } = sidebarFixture(doc)

  C.setCapBanners(true, false, root)
  const first = banners(sidebar)[0]
  assert.equal(first.textContent, C.CAP_BANNER_NODES)

  C.setCapBanners(true, true, root)
  assert.equal(banners(sidebar)[0], first, 'the node banner was re-created, not reconciled')

  // nodes clears while depth stays: the SURVIVING banner must say the depth
  // sentence, and there must be exactly one of it.
  C.setCapBanners(false, true, root)
  assert.deepEqual(banners(sidebar).map((b) => b.textContent), [C.CAP_BANNER_DEPTH])

  C.setCapBanners(false, false, root)
  assert.equal(banners(sidebar).length, 0)
  assert.deepEqual(resizes, ['resize', 'resize', 'resize', 'resize'])
})

test('§3.3 — a call that changes nothing fires NO resize', () => {
  const { doc, resizes } = installDom()
  const { root } = sidebarFixture(doc)
  C.setCapBanners(true, false, root)
  assert.deepEqual(resizes, ['resize'])
  C.setCapBanners(true, false, root)          // same state, twice
  assert.deepEqual(resizes, ['resize'], 'an idempotent call re-sized the tree for nothing')
})

test('§4.5 — the banners follow the live scroller into the search view', () => {
  const { doc } = installDom()
  const { root, sidebar, tree } = sidebarFixture(doc)
  // §4.5: the search panel REPLACES the tree; the ceiling stays at two
  // scrollers and the banner must still land above whichever one is live.
  tree.className = 'search-scroller'
  C.setCapBanners(true, false, root)
  assert.deepEqual(kids(sidebar), ['cap-banner', 'search-scroller'])
})

test('§7.3 case 8 — the vault-lost bar sits ABOVE the cap banners and never duplicates', () => {
  const { doc } = installDom()
  const { root, sidebar } = sidebarFixture(doc)

  C.setCapBanners(true, true, root)
  C.setVaultLost('/Volumes/Gone/Vault', root)
  assert.deepEqual(kids(sidebar),
    ['vault-lost', 'cap-banner', 'cap-banner', 'tree-scroller'],
    '"the vault is gone" must outrank "the vault is big"')

  C.setVaultLost('/Volumes/Gone/Vault', root)
  assert.equal(sidebar.querySelectorAll('.vault-lost').length, 1)
  assert.equal(sidebar.querySelector('.vault-lost').getAttribute('title'), '/Volumes/Gone/Vault')
  assert.match(sidebar.querySelector('.vault-lost').textContent, /^This vault is no longer available\./)
  // The two buttons §7.3 case 8 names, and only those.
  assert.deepEqual(
    sidebar.querySelectorAll('.chrome-btn').map((b) => b.textContent),
    ['Re-open', 'Switch vault…'])

  C.setVaultLost(null, root)
  assert.equal(sidebar.querySelectorAll('.vault-lost').length, 0)
  // …and the banners it was stacked on top of are untouched.
  assert.equal(banners(sidebar).length, 2)
})

/* ---- §7.3 case 16 — the watcher-degraded banner (§0.12 E14) --------------
 * NONE of this had a test before E14, because before E14 it was one opacity
 * change on a button.  It is now a 48px flex child of `.sidebar`, so it moves a
 * band the row pool is sized from — and the OLD code would have gone silently
 * dead the moment the nav toolbar was deleted (`if (!btn) return`), with no
 * error and nothing failing.  These tests are the reason that cannot happen
 * again without something going red.
 * ---------------------------------------------------------------------- */

test('§7.3 case 16 — the degraded bar names the reason and carries [ Refresh ]', () => {
  const { doc, resizes } = installDom()
  const { root, sidebar } = sidebarFixture(doc)

  C.setWatchDegraded('watch-limit', 'The system ran out of file-watch handles.', root)
  const bar = sidebar.querySelector('.watch-degraded')
  assert.ok(bar, 'no bar was drawn for a degraded watcher')
  assert.equal(bar.getAttribute('role'), 'alert')
  assert.equal(bar.querySelector('.watch-degraded-line').textContent, C.WATCH_DEGRADED_LIMIT)
  // The hint is Rust's and does not fit 412px, so it lives in the tooltip with
  // the line — not instead of it.
  assert.equal(bar.getAttribute('title'),
    C.WATCH_DEGRADED_LIMIT + ' The system ran out of file-watch handles.')

  // The button must READ `Refresh`: both Rust hint strings end "Use Refresh to
  // pick up changes." and that sentence is shown in this very tooltip.
  assert.deepEqual(sidebar.querySelectorAll('.chrome-btn').map((b) => b.textContent), ['Refresh'])
  assert.equal(sidebar.querySelectorAll('.watch-degraded-refresh').length, 1)

  // The scroller lost 48px and owner 04 sizes the row pool from clientHeight.
  assert.deepEqual(resizes, ['resize'], 'the scroller changed height and nobody was told')

  // The other reason gets the other line; an unknown one falls back rather than
  // blanking the bar.
  C.setWatchDegraded('watch-error', '', root)
  assert.equal(bar.querySelector('.watch-degraded-line').textContent, C.WATCH_DEGRADED_ERROR)
  assert.equal(bar.getAttribute('title'), C.WATCH_DEGRADED_ERROR, 'an empty hint left a trailing space')
  C.setWatchDegraded('something-new', 'x', root)
  assert.equal(bar.querySelector('.watch-degraded-line').textContent, C.WATCH_DEGRADED_ERROR)

  // Reconciled, never re-created: §1.4 says at most once per vault, but a
  // re-open re-arms it and a second bar would cost another 48px.
  assert.equal(sidebar.querySelectorAll('.watch-degraded').length, 1)
  assert.deepEqual(resizes, ['resize'], 'a text-only update re-sized the tree for nothing')
})

test('§0.12 E14 — the rank is gone > stale > truncated, whatever order they arrive in', () => {
  const { doc } = installDom()
  const { root, sidebar } = sidebarFixture(doc)

  // Arrive in the WRONG order on purpose: truncated, then stale, then gone.
  // Each function anchors on the next rank down, so no two of them have to
  // agree about anything beyond their own selector.
  C.setCapBanners(true, true, root)
  C.setWatchDegraded('watch-limit', 'h', root)
  C.setVaultLost('/Volumes/Gone/Vault', root)
  assert.deepEqual(kids(sidebar),
    ['vault-lost', 'watch-degraded', 'cap-banner', 'cap-banner', 'tree-scroller'],
    'gone > stale > truncated')

  // …and in the right order, from empty.
  const b = sidebarFixture(doc)
  C.setVaultLost('/Volumes/Gone/Vault', b.root)
  C.setWatchDegraded('watch-error', 'h', b.root)
  C.setCapBanners(true, false, b.root)
  assert.deepEqual(kids(b.sidebar),
    ['vault-lost', 'watch-degraded', 'cap-banner', 'tree-scroller'])

  // The degraded bar with NOTHING else: it must still land above the scroller
  // and not be appended past the vault bar.
  const c = sidebarFixture(doc)
  C.setWatchDegraded('watch-error', '', c.root)
  assert.deepEqual(kids(c.sidebar), ['watch-degraded', 'tree-scroller'])
})

test('§7.3 case 16 — clearing the bar removes it and re-sizes the tree back', () => {
  const { doc, resizes } = installDom()
  const { root, sidebar } = sidebarFixture(doc)

  // Clearing when nothing is showing is the COMMON case — main.ts calls it on
  // every `nc://vault-opened` where `watching` is true — and it must not fire a
  // resize, or every vault open would rebuild the row pool for nothing.
  C.clearWatchDegraded(root)
  assert.deepEqual(resizes, [])

  C.setWatchDegraded('watch-limit', 'h', root)
  C.setCapBanners(true, false, root)
  assert.deepEqual(resizes, ['resize', 'resize'])

  C.clearWatchDegraded(root)
  assert.equal(sidebar.querySelectorAll('.watch-degraded').length, 0)
  assert.deepEqual(resizes, ['resize', 'resize', 'resize'])
  // …and the cap banner it was stacked on top of is untouched.
  assert.deepEqual(kids(sidebar), ['cap-banner', 'tree-scroller'])
})

test('§4.5 — the degraded bar follows the live scroller into the search view', () => {
  const { doc } = installDom()
  const { root, sidebar, tree } = sidebarFixture(doc)
  tree.className = 'search-scroller'
  C.setWatchDegraded('watch-limit', 'h', root)
  assert.deepEqual(kids(sidebar), ['watch-degraded', 'search-scroller'],
    'hiding a dead watcher on the view where the user is hunting for a missing note is the worst possible moment to hide it')
})

test('§0.12 E14 — the degraded signal is a BANNER, not a lit button, at the source', () => {
  // The regression this guards is specific: `.is-lit` and the `refresh-cw`
  // selector were scoped to `.nav-toolbar`, so re-introducing either would fail
  // to style or find anything and the signal would be invisible with no error.
  assert.equal(/is-lit/.test(chromeTs), false, 'chrome.ts still lights a button')
  assert.equal(/is-lit/.test(chromeCss), false, 'chrome.css still has the .is-lit rule')
  assert.equal(/refresh-cw/.test(chromeTs), false)
  assert.match(chromeCss, /^\.watch-degraded \{/m)
  // §5.12.4.3 / G5d: never a scroller.
  const bar = chromeCss.slice(chromeCss.indexOf('.watch-degraded {'),
                              chromeCss.indexOf('.watch-degraded-line'))
  assert.match(bar, /overflow:\s*hidden/)
  assert.equal(/overflow[^;]*:\s*(auto|scroll|overlay)/.test(bar), false)
  // The one route to rescan_all() is the delegated click on this button.
  assert.match(chromeTs, /watch-degraded-refresh'\)\)\s*guard\(deps\.rescanAll\(\)/)
})

/* ---- §7.4, the fixed tabs (user ruling 2026-09-16) ------------------------
 * BOTH tabs are FIXED and carry NO close button — "Two tabs will be always
 * on this app. Fixed. Can't close!"  §7.4's close table (clean -> close,
 * dirty -> flush-first with the §1.6 modal) is VOID for the strip: there is
 * no control left that closes anything.  These rows pin what PART C can
 * prove: visibility lifetime, label/title wiring, and click-to-select. */

function tabFixture(doc) {
  const root = doc.createElement('div')
  const strip = doc.createElement('div'); strip.className = 'tab-strip'
  const tab = doc.createElement('div'); tab.className = 'tab is-active'
  const label = doc.createElement('span'); label.className = 'tab-label'
  const inner = doc.createElement('span'); inner.className = 'tab-inner'
  inner.append(label)
  tab.append(inner)
  // §0.30 E71 — the strip holds the TAB AND NOTHING ELSE. The fixture models
  // `index.html`, and one that still built a `+` would let a `.tab-strip .plus`
  // listener come back green.  2026-09-16: same for `.tab-close` — the fixture
  // models `index.html`, which no longer has one.
  strip.append(tab)
  // §0.45 E91 — AND NO `.empty-state`. The fixture models `index.html`, which
  // no longer has one; building a stray copy here would let a leftover
  // `querySelector('.empty-state')` in tabstrip.ts keep passing. Same argument
  // as E71's `+` above.
  root.append(strip)
  return { root, strip, tab, label, inner }
}

function spyDeps(over) {
  const calls = []
  return {
    calls,
    deps: {
      onSelect: (w) => calls.push('select:' + w),
      ...over,
    },
  }
}

const clickEvent = () => ({ preventDefault() {}, stopPropagation() {} })
const settle = () => new Promise((r) => setTimeout(r, 0))

test('§7.4 — no note open: the note tab is not rendered, and nothing replaces it', async () => {
  const { doc } = installDom()
  const f = tabFixture(doc)
  const { deps } = spyDeps()
  const strip = C.createTabStrip(deps, f.root)

  assert.equal(f.tab.hidden, true)
  assert.equal(strip.path, null)
  // §0.45 E91: the note tab's absence is now the WHOLE of "no note open" on screen.
  assert.equal(f.root.querySelector('.empty-state'), null, 'the module re-created a deleted element')

  strip.setNote('Notes/Misc.md')
  assert.equal(f.tab.hidden, false)
  assert.equal(f.label.textContent, 'Misc', '§3.6: the screen drops .md, the wire keeps it')
  assert.equal(f.tab.getAttribute('title'), 'Notes/Misc.md')

  // Deleting/emptying the editor hides the tab again — the ONLY path that
  // hides it now that the ✕ is gone (main.ts `onEmpty` -> `setNote(null)`).
  strip.setNote(null)
  assert.equal(f.tab.hidden, true)
  assert.equal(strip.path, null)
})

test('§7.4 — neither tab carries a close button, and the module wires none', async () => {
  const { doc } = installDom()
  const f = tabFixture(doc)
  const { calls, deps } = spyDeps()
  const strip = C.createTabStrip(deps, f.root)
  strip.setNote('Misc.md')

  assert.equal(f.root.querySelector('.tab-close'), null, 'the module re-created a deleted control')
  // Clicking the tab selects nothing while already there (no close to trigger).
  f.tab.dispatch('click', clickEvent())
  await settle()
  assert.deepEqual(calls, [], 'a click on the active tab requested a switch')
})

test('§0.30 E71 — the tab strip holds the tab and NOTHING ELSE', async () => {
  const { doc } = installDom()
  // This row used to be "the `+` button is New note, and the close button is
  // not". The `+` is deleted (a user decision: Cairn is a single-tab viewer and
  // the button opened no tab), and 2026-09-16 the ✕ is deleted too (user
  // ruling: both tabs fixed, can't close).  So the row pins that the strip's
  // note tab holds a label and NOTHING ELSE, and that wiring it raises
  // nothing. A deleted control that leaves its handler behind is how the next
  // person reintroduces it.
  const f = tabFixture(doc)
  const { calls, deps } = spyDeps()
  const strip = C.createTabStrip(deps, f.root)
  assert.deepEqual(f.strip.children.map((c) => c.className), ['tab is-active'])
  assert.equal(f.tab.querySelector('.tab-close'), null, 'the ✕ is back')
  assert.equal(f.tab.querySelector('.plus'), null, 'the `+` is back')
  assert.deepEqual(calls, [], 'creating the strip called a dep')
})

/* ---- §4.3, the vault switch --------------------------------------------- */

function vaultBarFixture(doc) {
  const root = doc.createElement('div')
  const bar = doc.createElement('div'); bar.className = 'vault-bar'
  const btn = doc.createElement('button'); btn.className = 'vault-switch'
  const name = doc.createElement('span'); name.className = 'vault-name'
  btn.append(name)
  bar.append(btn)
  root.append(bar)
  return { root, bar, btn, name }
}

function vaultDeps(over) {
  const calls = []
  return {
    calls,
    deps: {
      pickVault: async () => '/new',
      openVault: async (p) => { calls.push('openVault:' + p); return { root: p, name: p.slice(1) } },
      recentVaults: async () => [],
      forgetVault: async (root) => { calls.push('forgetVault:' + root) },
      releaseVault: async (r) => { calls.push('releaseVault:' + r) },
      onError: (err, ctx) => calls.push('onError:' + ctx),
      ...over,
    },
  }
}

test('§4.3 — the switch runs release (steps 1-5) BEFORE open_vault (step 6)', async () => {
  const { doc } = installDom()
  const f = vaultBarFixture(doc)
  const { calls, deps } = vaultDeps()
  const vb = C.createVaultBar(deps, f.root)
  assert.equal(f.name.textContent, 'No vault')

  await vb.pickAndSwitch()
  assert.deepEqual(calls, ['releaseVault:switch', 'openVault:/new'])
  assert.equal(vb.root, '/new')
  assert.equal(f.name.textContent, 'new')
})

test('§4.3 M30 — a REJECTED flush ABORTS the switch; open_vault is never reached', async () => {
  const { doc } = installDom()
  const f = vaultBarFixture(doc)
  const { calls, deps } = vaultDeps({
    releaseVault: async () => { throw { kind: 'conflict' } },
  })
  const vb = C.createVaultBar(deps, f.root)
  // Start from an open vault so "unchanged" is an observable, not a default.
  vb.setVault({ root: '/old', name: 'old' })

  await vb.pickAndSwitch()

  // THE ROW THAT MATTERS.  A vault switch that dropped a dirty buffer would be
  // the worst bug in this file; the seam is drawn so it cannot happen.
  assert.equal(calls.includes('openVault:/new'), false, 'the vault was switched over a failed flush')
  assert.deepEqual(calls, ['onError:flush'])
  assert.equal(vb.root, '/old', 'the outgoing vault must stay open and untouched')
  assert.equal(f.name.textContent, 'old')
  assert.equal(f.btn.getAttribute('disabled'), null, 'the bar was left disabled after an abort')
})

test('§4.3 — a cancelled folder dialog is not an error and releases nothing', async () => {
  const { doc } = installDom()
  const f = vaultBarFixture(doc)
  const { calls, deps } = vaultDeps({ pickVault: async () => null })
  const vb = C.createVaultBar(deps, f.root)
  vb.setVault({ root: '/old', name: 'old' })

  await vb.pickAndSwitch()
  assert.deepEqual(calls, [], 'cancelling the dialog tore down the open vault')
  assert.equal(vb.root, '/old')
})

test('§4.3 — steps 1-5 have already run when open_vault fails, and the bar says so', async () => {
  const { doc } = installDom()
  const f = vaultBarFixture(doc)
  const { calls, deps } = vaultDeps({
    openVault: async () => { throw { kind: 'notFound' } },
  })
  const vb = C.createVaultBar(deps, f.root)
  vb.setVault({ root: '/old', name: 'old' })

  await vb.pickAndSwitch()
  assert.deepEqual(calls, ['releaseVault:switch', 'onError:open-vault'])
  assert.equal(vb.root, null, 'the bar still names a vault the process no longer holds')
  assert.equal(f.name.textContent, 'No vault')
})

test('§4.3 — re-picking the OPEN vault is a no-op, not a teardown and reload', async () => {
  const { doc } = installDom()
  const f = vaultBarFixture(doc)
  const { calls, deps } = vaultDeps({ pickVault: async () => '/old' })
  const vb = C.createVaultBar(deps, f.root)
  vb.setVault({ root: '/old', name: 'old' })

  await vb.pickAndSwitch()
  assert.deepEqual(calls, [])
  assert.equal(vb.root, '/old')
})

/* ---- the ONE menu primitive --------------------------------------------- */

const labelsOf = (el) => el.querySelectorAll('.ctx-item').map((r) => r.textContent)

test('§5.1 — openMenu renders the row menu as ONE box, Delete last and in --text-error', () => {
  const { doc } = installDom()
  const noop = () => {}
  const acts = { newNote: noop, newFolder: noop, newSecret: noop, rename: noop, copyPath: noop, remove: noop }
  const h = C.openMenu(C.folderRowMenu(acts), { x: 100, y: 100, label: 'Folder' })

  assert.equal(h.element.className, 'ctx-menu')
  assert.equal(doc.body.children.length, 1, 'the menu is not a persistent layer')
  assert.deepEqual(labelsOf(h.element),
    ['New note', 'New folder', 'New secret file', 'Rename…', 'Copy absolute path', 'Delete'])
  const del = h.element.querySelectorAll('.ctx-item').pop()
  assert.equal(del.classList.contains('is-danger'), true)
  // The FOLDER menu is the tall one, and it is the one menu.ts's §5.12.4.3
  // arithmetic sizes: 6 rows + 2 separators = 187.4px, against the 249.1px
  // recents popover that sets the worst case.
  assert.equal(h.element.querySelectorAll('.ctx-sep').length, 2)
  assert.equal(labelsOf(h.element).includes('Reveal in Finder'), false)

  C.closeMenu()
  assert.equal(doc.body.children.length, 0, 'the menu element outlived the menu')
})

test('the viewer Copy/Paste menu carries its width-floor class; row menus carry none', () => {
  const { doc } = installDom()
  const noop = () => {}
  const acts = { newNote: noop, newFolder: noop, newSecret: noop, rename: noop, copyPath: noop, remove: noop }
  const plain = C.openMenu(C.folderRowMenu(acts), { x: 100, y: 100, label: 'Folder' })
  assert.equal(plain.element.classList.contains('ctx-clip'), false,
    'the row menus keep Obsidian\'s content-sized box')
  C.closeMenu()
  const clip = C.openMenu(
    C.clipMenu({ hasSelection: true, canPaste: true, copy: noop, paste: noop }),
    { x: 100, y: 100, label: 'Note actions', cls: 'ctx-clip' })
  assert.equal(clip.element.classList.contains('ctx-clip'), true)
  assert.deepEqual(labelsOf(clip.element), ['Copy', 'Paste'])
  C.closeMenu()
  assert.equal(doc.body.children.length, 0)
})

test('§0.14 E16 — every row carries Obsidian\'s own glyph, painted through icons.ts', () => {
  const { doc } = installDom()
  const noop = () => {}
  const acts = { newNote: noop, newFolder: noop, newSecret: noop, rename: noop, copyPath: noop, remove: noop }
  const h = C.openMenu(C.folderRowMenu(acts), { x: 100, y: 100, label: 'Folder' })

  // One slot per ROW — including, in an icon-bearing menu, any row that has no
  // icon of its own, or the labels below it slide 24px left.
  const rows = h.element.querySelectorAll('.ctx-item')
  const icons = h.element.querySelectorAll('.ctx-icon')
  assert.equal(icons.length, rows.length, 'a row is missing its icon slot')

  // The mapping, which is the thing that silently rots: these are Obsidian's own
  // choices for the rows Obsidian has, and `link` is the glyph it puts on the
  // `Copy path` parent row.
  // §0.15 E17 — OBSIDIAN'S OWN, and each name is the string its `setIcon()` is
  // called with. E16 asserted `file-plus/folder-plus/pencil/link/trash-2` here
  // and called them Obsidian's; four were wrong, and pinning them in a test made
  // the drift permanent instead of catching it. Verify against app.js, never by
  // eye: grep `menuOptNewNote`, `menuOptNewFolder`, `menuOptRename`,
  // `menuOptDelete` and `copyPath()`.
  assert.deepEqual(icons.map((i) => i.getAttribute('data-icon')),
    ['edit', 'folder-open', 'lock', 'edit-3', 'clipboard', 'trash-2'])

  // …and §6.1's pass actually RAN. A `data-icon` nobody paints is an empty box,
  // and the failure mode is invisible: the menu still opens, correctly sized,
  // with five blank gutters.
  for (const i of icons) {
    assert.match(String(i.innerHTML), /^<svg width="16" height="16" viewBox="0 0 24 24"/,
      `${i.getAttribute('data-icon')} was never painted`)
    assert.match(String(i.innerHTML), /stroke-width="2"/, '[S] Obsidian --icon-s-stroke-width')
  }
  C.closeMenu()
})

test('§0.27 E67 — an ICONLESS row still emits the slot, and `mod-no-icon` is an OPT-IN', () => {
  const { doc } = installDom()
  // THIS ROW IS INVERTED FROM WHAT E16 PINNED. It used to assert
  // `.ctx-icon` count === 0 for a menu no row of which carries an icon, and
  // called that Obsidian's `.menu.mod-no-icon` rule. It is not: that rule is
  // real, and it is reached only through `Menu.setNoIcon()`, which nothing in
  // the vault popover's call path calls. Obsidian's `MenuItem` constructor
  // creates `menu-item-icon` unconditionally, so an iconless row gets an EMPTY
  // slot — zero wide, because `.menu-item-icon` is `flex: 0 1 auto` — and pays
  // the row's 8px `gap` for it. Measured in the pinned engine against
  // Obsidian's own app.css: labels at 23px from the menu's outer left edge with
  // an empty slot, 39px with a filled one. Cairn drew 15 and 15.
  const h = C.openMenu([{ label: '/a', onSelect: () => {} }, { separator: true },
                        { label: 'Open folder as vault…', onSelect: () => {} }],
                       { x: 10, y: 10, label: 'Vaults' })
  const rows = h.element.querySelectorAll('.ctx-item')
  assert.equal(h.element.querySelectorAll('.ctx-icon').length, rows.length)
  // …and an empty slot is EMPTY: `paintIcons` leaves a host with no `data-icon`
  // alone, so nothing lands in it and it collapses to nothing.
  assert.equal(rows[0].querySelector('.ctx-icon').getAttribute('data-icon'), null)
  assert.ok(!rows[0].querySelector('.ctx-icon').innerHTML, 'the empty slot was painted')
  // The slot is FIRST. Its whole job is to sit between the row's padding and the
  // label; appended anywhere else it would indent nothing.
  assert.equal(rows[0].children[0].className, 'ctx-icon')
  assert.equal(rows[0].children[1].className, 'ctx-label clipline')
  assert.equal(doc.body.children.length, 1)
  C.closeMenu()
})

test('§0.27 E67 — the tick is a trailing `check` glyph, not a left gutter', () => {
  installDom()
  // Obsidian's `setChecked(true)` appends a SECOND `menu-item-icon`, classed
  // `mod-checked`, holding `lucide-check`, AFTER the title — so the title's
  // flex-grow puts it against the row's right padding edge. Cairn drew a
  // `::before "✓"` inside 30px of extra left padding, which put every ticked
  // row's label 22px right of every plain one in the same menu.
  const h = C.openMenu([{ label: 'active', checked: true, onSelect: () => {} },
                        { label: 'sanctum', checked: false, onSelect: () => {} }],
                       { x: 10, y: 10, label: 'Vaults' })
  const rows = h.element.querySelectorAll('.ctx-item')

  // The CHECKED row: empty slot, label, tick — in that order, and the tick LAST.
  assert.deepEqual([...rows[0].children].map((c) => c.className),
    ['ctx-icon', 'ctx-label clipline', 'ctx-icon mod-checked'])
  assert.equal(rows[0].classList.contains('mod-checked'), true)
  assert.equal(rows[0].getAttribute('aria-checked'), 'true')
  // Painted, and painted as Lucide's `check` at --icon-s / --icon-s-stroke-width.
  const tick = rows[0].querySelector('.ctx-icon.mod-checked')
  assert.equal(tick.getAttribute('data-icon'), 'check')
  assert.match(String(tick.innerHTML), /^<svg width="16" height="16" viewBox="0 0 24 24"/)
  assert.match(String(tick.innerHTML), /stroke-width="2"/)
  assert.match(String(tick.innerHTML), /<path d="M20 6 9 17l-5-5"\/>/)

  // The UNCHECKED row carries no tick at all — `checked: false` is a state, not
  // a greyed-out mark — and its label sits on the SAME left edge as the checked
  // one, which is the whole point of the change.
  assert.equal(rows[1].querySelectorAll('.ctx-icon.mod-checked').length, 0)
  assert.equal(rows[1].classList.contains('mod-checked'), false)
  assert.equal(rows[1].getAttribute('aria-checked'), 'false')
  assert.deepEqual([...rows[1].children].map((c) => c.className),
    ['ctx-icon', 'ctx-label clipline'])

  // And the stylesheet no longer carries the gutter that used to move it: a
  // `padding-left` on the radio rows is exactly the defect, so it is pinned
  // ABSENT rather than left to be noticed in a screenshot.
  assert.equal(/\[role="menuitemradio"\]\s*\{[^}]*padding-left/.test(chromeCss), false,
    'the 30px tick gutter is back; every ticked label is out of line again')
  assert.equal(/is-checked::before/.test(chromeCss), false,
    'the "✓" text glyph is back in place of Obsidian\'s Lucide `check`')
  C.closeMenu()
})

test('§0.28 E68 — a menu survives Alt-Tab: no blur, no resize, no scroll listener', () => {
  const { doc } = installDom()
  // REPORTED BY THE USER: "Obsidian persists this menu even when I alt+tab. It
  // only disappears when I click away or click on an item inside that menu."
  // Obsidian's `Menu.onload` registers exactly three window events — `mousedown`
  // and `click` (both -> handleClickOutside) and, on desktop, `contextmenu` ->
  // hide — plus Escape in the keymap scope it pushes. There is NO blur handler
  // and no resize or scroll handler anywhere in the class.
  //
  // This reads the SOURCE rather than firing events, because the thing being
  // pinned is the absence of a registration: `installDom`'s `window` stubs
  // addEventListener to a no-op, so a `blur` handler could come back tomorrow
  // and no behavioural test in this file would notice.
  const menuTs = read('src/menu.ts')
  const body = menuTs.slice(menuTs.indexOf('export function closeMenu'))
  const regs = [...body.matchAll(/(document|window)\.addEventListener\(\s*'([a-z]+)'/g)]
    .map((m) => `${m[1]}:${m[2]}`)
  assert.deepEqual(regs, ['document:pointerdown', 'document:keydown', 'document:contextmenu'],
    'the dismissal set changed; it is Obsidian\'s and it is closed')
  // Every one of them is removed again, or the next menu stacks a second copy.
  for (const r of regs) {
    const [target, type] = r.split(':')
    assert.ok(body.includes(`${target}.removeEventListener('${type}'`), `${r} is never removed`)
  }
  // …and `window` is not listened to AT ALL below the singleton.
  assert.equal(/window\.addEventListener/.test(body), false,
    'a window listener is back — a menu that closes on blur does not survive Alt-Tab')
})

test('§0.28 E68 — a right-click anywhere dismisses the menu (Obsidian does this too)', () => {
  const { doc } = installDom()
  const h = C.openMenu([{ label: 'a', onSelect: () => {} }], { x: 10, y: 10 })
  assert.equal(doc.body.children.length, 1)
  // Obsidian: `rd.isDesktop && this.registerDomEvent(i, "contextmenu", this.hide)`.
  // Unconditional — a right-click INSIDE the menu closes it too, which is the
  // only case `pointerdown` does not already cover, since a right-click outside
  // fires `pointerdown` with button 2 and takes the outside-click path.
  doc.fire('contextmenu', { target: h.element })
  assert.equal(doc.body.children.length, 0, 'a right-click left the menu mounted')
})

test('§0.14 E16 — the menu glyphs are 16px at stroke 2, and their paths are Obsidian\'s', () => {
  // The five row glyphs were transcribed byte for byte out of the `app.js`
  // inside the Obsidian installed on this machine (1.12.7). That archive is NOT
  // in the repo and is not on the macOS machine, so this test pins what CAN
  // travel: the sizing, and one distinctive substring of each path that a
  // "tidy-up" or a re-transcription from a different Lucide release would move.
  const iconsTs = read('src/icons.ts')
  const expect = {
    edit: 'M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7',
    'folder-open': 'm6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6',
    // `edit-3` is NOT `pencil-line`: Obsidian ships both and this one has the
    // underline and NO nib stroke. `M13 21h8` is the underline, and its absence
    // is exactly how E16's `pencil` differed.
    'edit-3': '<path d="M13 21h8"/>',
    // The one `<rect>` in the file, in Lucide's own attribute order.
    clipboard: '<rect width="8" height="4" x="8" y="2" rx="1" ry="1"/>',
    'trash-2': 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6',
  }
  for (const [name, d] of Object.entries(expect)) {
    // SCOPED TO THIS GLYPH'S OWN DECLARATION. The check used to be
    // `iconsTs.includes(d)` over the whole file, which says only that the string
    // exists SOMEWHERE — so swapping the bodies of two entries left every
    // assertion green while Rename drew a trash can and Delete drew a pencil.
    const at = iconsTs.indexOf(`'${name}': {`)
    assert.ok(at >= 0, `icons.ts no longer declares '${name}'`)
    // Skip THIS entry's own `': { size:` before looking for the next one, or a
    // name longer than 4 characters slices its declaration to nothing.
    const next = iconsTs.indexOf("': { size:", at + name.length + 4)
    const decl = iconsTs.slice(at, next < 0 ? iconsTs.indexOf('const W:', at) : next)
    assert.match(decl.slice(0, 60), /size: 16, stroke: 2/, `${name} is not 16px at stroke 2`)
    assert.ok(decl.includes(d), `'${name}' is not drawing Obsidian 1.12.7's ${name} path`)
  }
  // `edit` is the cross-check, and the sharpest fact in E17: Obsidian's registry
  // holds `edit` and `square-pen` against IDENTICAL path data, and `square-pen`
  // is the literal E14 deleted as a dead nav glyph. The correct New note glyph
  // was in the tree the whole time. If this fails, Cairn's ORIGINAL square-pen
  // transcription was wrong too.
  const squarePen = 'M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505'
  assert.ok(iconsTs.includes(squarePen), "`edit` is no longer `square-pen`'s twin")
})

test('§5.12.4.3 — the menu is REMOVED on close, never hidden and kept mounted', () => {
  const { doc } = installDom()
  C.openMenu([{ label: 'a', onSelect: () => {} }], { x: 10, y: 10 })
  assert.equal(C.isMenuOpen(), true)
  C.openMenu([{ label: 'b', onSelect: () => {} }], { x: 10, y: 10 })
  assert.equal(doc.body.children.length, 1, 'two floating lists were mounted at once')
  C.closeMenu()
  assert.equal(C.isMenuOpen(), false)
})

test('the menu CLOSES before it runs the action (the inline editor takes focus next)', () => {
  const { doc } = installDom()
  let openWhenRun = null
  C.openMenu([{ label: 'Rename…', onSelect: () => { openWhenRun = doc.body.children.length } }],
    { x: 10, y: 10 })
  doc.fire('keydown', { key: 'ArrowDown', preventDefault() {}, stopPropagation() {} })
  doc.fire('keydown', { key: 'Enter', preventDefault() {}, stopPropagation() {} })
  assert.equal(openWhenRun, 0, 'the menu was still mounted when the action ran')
  assert.equal(C.isMenuOpen(), false)
})

test('arrow keys skip a DISABLED row and wrap; Escape closes without selecting', () => {
  const { doc } = installDom()
  const picked = []
  C.openMenu([
    { label: 'live', onSelect: () => picked.push('live') },
    { label: 'missing', disabled: true, onSelect: () => picked.push('missing') },
    { label: 'other', onSelect: () => picked.push('other') },
  ], { x: 10, y: 10 })
  const down = () => doc.fire('keydown', { key: 'ArrowDown', preventDefault() {}, stopPropagation() {} })
  down()                                        // -> live
  down()                                        // -> other  (skips the disabled row)
  doc.fire('keydown', { key: 'Enter', preventDefault() {}, stopPropagation() {} })
  assert.deepEqual(picked, ['other'])

  C.openMenu([{ label: 'x', onSelect: () => picked.push('x') }], { x: 10, y: 10 })
  doc.fire('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} })
  assert.deepEqual(picked, ['other'])
  assert.equal(C.isMenuOpen(), false)
})

test('a `checked` entry still renders as a radio row (the recents popover, not the sort menu)', () => {
  // §0.12 E14 deleted the sort menu, which was `checked`'s first consumer.  The
  // FIELD survives because vaultbar.ts marks the open vault with it, and this is
  // the test that keeps that rendering path alive now that the sort menu is not
  // exercising it.  Written against the primitive, as the sort test was.
  const { doc } = installDom()
  const got = []
  const h = C.openMenu(
    ['/a', '/b', '/c'].map((v, i) => ({ label: v, checked: i === 2, onSelect: () => got.push(v) })),
    { x: 10, y: 10, label: 'Vaults' })
  const rows = h.element.querySelectorAll('.ctx-item')
  assert.deepEqual(rows.map((r) => r.getAttribute('role')),
    ['menuitemradio', 'menuitemradio', 'menuitemradio'])
  assert.deepEqual(rows.map((r) => r.getAttribute('aria-checked')), ['false', 'false', 'true'])
  rows[0].dispatch('click', { preventDefault() {}, stopPropagation() {} })
  assert.deepEqual(got, ['/a'])
  assert.equal(doc.body.children.length, 0)
})

test('§0.29 E69 — placeMenu is Obsidian showAtPosition, arithmetic only', () => {
  // Pure. No DOM, no layout — this is the six lines of Obsidian's desktop branch
  // and nothing else, so it can be checked against the source by reading.
  const W = 1920, H = 964

  // ROOM BELOW: the point is the menu's TOP-left, offset by (2, 2).
  assert.deepEqual(C.placeMenu(100, 100, 150, 250, W, H), { left: 102, top: 102 })

  // NO ROOM BELOW: `o + p > f`, so the menu is lifted by its own height first
  // and its BOTTOM-left corner lands on the point, offset by (2, 2). THIS IS
  // THE USER'S REPORT: "the left bottom corner of the dialog is always the
  // place I place my cursor".
  const p = C.placeMenu(100, 900, 150, 250, W, H)
  assert.deepEqual(p, { left: 102, top: 652 })
  assert.equal(p.top + 250, 902, 'the menu bottom is not 2px below the point')

  // NO ROOM TO THE RIGHT: the menu's RIGHT edge goes 2px LEFT of the point.
  // Boundary: `gLeft + w <= vw` is inclusive, so a menu that fits EXACTLY stays
  // on the right.
  assert.equal(C.placeMenu(1768, 100, 150, 250, W, H).left, 1770, 'w=150 fits exactly at x+2')
  assert.equal(C.placeMenu(1769, 100, 150, 250, W, H).left, 1769 - 2 - 150)

  // NO ROOM EITHER WAY: floored at 0, NOT at a margin. Obsidian writes
  // `Math.max(0, y - h)` and Cairn's old `clampPopup` used a 4px margin that is
  // a Cairn invention.
  // (w=1915: `12 + 1915 > 1920`, so the right branch runs and `10 - 2 - 1915`
  // is negative.)
  assert.equal(C.placeMenu(10, 100, 1915, 250, W, H).left, 0)

  // TALLER THAN THE SPACE ABOVE: clamped to the top inset, and CLIPPED at the
  // bottom by §5.12.4.3's `overflow: hidden` rather than scrolling. There is no
  // second flip and no bottom margin.
  assert.deepEqual(C.placeMenu(100, 300, 150, 900, W, H, 0), { left: 102, top: 2 })
  assert.deepEqual(C.placeMenu(100, 300, 150, 900, W, H, 40), { left: 102, top: 42 })
})

test('§5.12.4.3 — the vault popover opens UPWARD from the pointer rather than clipping', () => {
  const { doc } = installDom()
  // A click on the vault bar, at content y 921 of a 964px window: there is never
  // room below, so `placeMenu`'s lift fires and the popover's BOTTOM-left corner
  // lands on the pointer. §0.29 E69 deleted `flipAboveY`; the flip is the rule
  // now, not a flag this call site sets.
  const h = C.openMenu(
    [{ label: 'a', onSelect: () => {} }, { label: 'b', onSelect: () => {} }],
    { x: 40, y: 921, label: 'Vaults' })
  const top = parseInt(h.element.style.top, 10)
  const left = parseInt(h.element.style.left, 10)
  const height = 8 + 2 * 28          // the stub's offsetHeight model
  assert.equal(top, 921 - height + 2, 'the popover opened downward off the bottom of the window')
  assert.equal(top + height, 923, 'the popover bottom is not 2px below the pointer')
  assert.equal(left, 42, 'the popover left edge is not 2px right of the pointer')
  C.closeMenu()
})

test('§0.32.4/§0.34.4 — the tree keeps Obsidian\'s own 24px below and 12px above', () => {
  // REPORTED BY THE USER: "usually when I have to create a new note/folder in
  // the root, I have to scroll down to the end. but look at this, crowded note
  // vault leaves no space." A vault taller than the pane ended flush against the
  // vault bar, so there was nowhere left to right-click and §0.16 E18's root
  // create rows were unreachable by mouse.
  //
  // §0.32 E77 — 72, NOT Obsidian's 24, and that is a USER RULING rather than a
  // measurement: *"Please triple the padding space below the end of the note
  // vault!!!"*. §0.30 E72 transcribed `.nav-files-container { padding-bottom:
  // max(var(--safe-area-inset-bottom), var(--size-4-6)) }` (app.css:15818,
  // `--size-4-6: 24px` at :2661), the user tried it, and 24 is one row's worth
  // on a 27px pitch — not enough to right-click in, which is the whole purpose.
  //
  // PINNED AS A RULING. If this ever fails at 24, the question is not "which is
  // right" — it is whether somebody restored Obsidian's number over a reported
  // complaint, which needs a ruling of its own to undo.
  const treeCss = stripCssComments(read('src/styles/tree.css'))
  const rule = /\.tree-scroller \{[^}]*padding-bottom:\s*(\d+)px/.exec(treeCss)
  assert.ok(rule, '.tree-scroller no longer reserves space below the last row')
  // 24 [S] -> 72 -> 216 -> 144 -> 108 -> 24 [S]. §0.32's divergence is
  // WITHDRAWN by user ruling ("Let's copy the Obsidian padding space") and this
  // is a transcription again: `--size-4-6`, measured off the user's own Obsidian
  // screenshot at 32 device px = 25.6 CSS at dpr 1.25, i.e. 24 within the error
  // of reading a row box off its ink. A little UNDER one row on the 27px pitch.
  assert.equal(Number(rule[1]), 24,
    'the bottom space is not Obsidian\'s own --size-4-6 (§0.32.4)')

  // §0.34.4 — AND OBSIDIAN'S OWN GAP AT THE TOP: `var(--row-h)` -> half of it
  // -> 12px [S], the last step being *"Do the same with top padding (we don't
  // have this ribbon, we just need to measure the space between the first row
  // and the ribbon)"*. Measured in the pinned engine over Obsidian's own DOM:
  // `.nav-buttons-container` bottom 32, first row top 44, gap 12 — which is
  // `.nav-header { padding: var(--size-4-2) }`'s bottom 8 plus
  // `.nav-files-container`'s opening `var(--size-4-1)` 4.
  //
  // NOT 4. Box to box the nav-header's edge to the first row IS 4, but the 8 is
  // padding inside a nav-header Cairn does not draw (§0.12 E14 deleted the nav
  // toolbar), so 4 here would sit the first row 8px above Obsidian's. When the
  // element the other half lived on is gone, transcribe the SPACE.
  const decl = /\.tree-scroller \{([^}]*)\}/.exec(treeCss)[1]
  const top = /padding-top:\s*(\d+)px/.exec(decl)
  assert.ok(top, 'the top padding is gone, or it is no longer a plain px literal')
  assert.equal(Number(top[1]), 12,
    'the top space is not Obsidian\'s ribbon-to-first-row gap (§0.34.4)')

  // NO HORIZONTAL PADDING. Obsidian's shorthand also sets 12px sides, and those
  // belong to ITS row box model; Cairn's is §5.2's measured `--cx0`/`--tx0`,
  // which G9 asserts to the pixel. A padding shorthand here would move every row
  // and take four gate rows with it.
  assert.equal(/padding(-left|-right|-inline)/.test(decl), false,
    'the tree scroller took padding on an axis §5.2 owns')
  assert.equal(/padding:\s/.test(decl), false,
    'a padding SHORTHAND would set the sides too — §5.2 owns those')

  // …AND `tree.ts` KNOWS ABOUT IT. This is the half that is not cosmetic:
  // `scrollTop` counts from the padding box, so a top padding moves every row in
  // SCROLL coordinates while leaving it alone in SIZER coordinates. The virtual
  // scroller reads the value out of the computed style and corrects for it; a
  // hardcoded 27 there would be wrong the next time this number moves, and
  // leaving it out does not look broken — it trims one row at the very bottom
  // of a full vault, once, at one scroll position.
  const treeTs = read('src/tree.ts')
  assert.match(treeTs, /paddingTop/, 'tree.ts no longer reads the scroller\'s padding-top')
  assert.equal(/padTop\s*=\s*27/.test(treeTs), false, 'tree.ts hardcodes the padding instead of reading it')
  for (const site of [/const sy = st - padTop/, /padTop \+ displayCount\(\) \* rowH/,
                      /const top = padTop \+ at \* rowH/]) {
    assert.match(treeTs, site,
      'a scroll<->sizer conversion in tree.ts stopped accounting for the top padding')
  }

  // …and NOT on the search panel, which is grouped with the tree in every other
  // rule in that file. It draws no context menu, so space below its last hit
  // buys nothing, and Obsidian does not pad it either.
  assert.equal(/\.search-scroller[^{]*\{[^}]*padding-bottom/.test(treeCss), false,
    'the search panel grew bottom padding it has no use for')
})

test('§0.30 E70 — `Close` is on every row BUT the open one, and it forgets that vault', async () => {
  const { doc } = installDom()
  const f = vaultBarFixture(doc)
  // Three vaults: the open one, a live one, and one whose folder is gone.
  const list = [{ root: '/a', name: 'a', exists: true },
                { root: '/b', name: 'b', exists: true },
                { root: '/c', name: 'c', exists: false }]
  const { calls, deps } = vaultDeps({ recentVaults: async () => list })
  const vb = C.createVaultBar(deps, f.root)
  vb.setVault({ root: '/a', name: 'a' })
  vb.openPopup()
  await settle()

  const rows = () => doc.body.children[0].querySelectorAll('.ctx-item')
  const btns = () => doc.body.children[0].querySelectorAll('.ctx-row-btn')
  assert.equal(rows().length, 4, '3 recents + "Open folder as vault…"')

  // THE OPEN VAULT HAS NO BUTTON, and that is not decoration: §1.3 command 21
  // REJECTS for the open vault (Obsidian's `vault-remove` answers false and says
  // "Can't remove a currently open vault."), so a control there could only ever
  // fail. §9 E4: omitted, not drawn disabled.
  assert.equal(rows()[0].getAttribute('aria-checked'), 'true', 'the fixture is wrong: /a is open')
  assert.equal(rows()[0].querySelectorAll('.ctx-row-btn').length, 0,
    'the OPEN vault offers a Close that command 21 would refuse')
  // The last row is "Open folder as vault…" — an action, not a vault.
  assert.equal(rows()[3].querySelectorAll('.ctx-row-btn').length, 0)
  // …and the two that are not open DO have one, INCLUDING the missing vault:
  // forgetting it is the one thing left to do with a folder that is gone, and it
  // is the commonest reason to want this control at all.
  assert.equal(btns().length, 2)
  assert.equal(rows()[2].classList.contains('is-disabled'), true, 'the fixture is wrong: /c is gone')
  assert.equal(rows()[2].querySelectorAll('.ctx-row-btn').length, 1,
    'a vault whose folder is gone cannot be forgotten')

  // Obsidian's own glyph for this action is `lucide-x` (its vault chooser's
  // "Remove from list"), painted through icons.ts like every other.
  const btn = rows()[1].querySelectorAll('.ctx-row-btn')[0]
  assert.equal(btn.getAttribute('data-icon'), 'x')
  assert.equal(btn.getAttribute('aria-label'), 'Close')
  assert.match(String(btn.innerHTML), /^<svg width="16" height="16"/)

  // ACTIVATING IT FORGETS THAT VAULT AND DOES NOT SWITCH TO IT. Both halves
  // matter: the button sits inside a row whose own click handler opens the
  // vault, so a missing `stopPropagation` would remove it AND open it.
  btn.dispatch('click', clickEvent())
  await settle()
  assert.deepEqual(calls, ['forgetVault:/b'])
  assert.equal(calls.some((c) => c.startsWith('releaseVault')), false,
    'Close switched vaults as well as forgetting one')
})

test('§0.30 E70 — the popover REOPENS after a Close, and stays CLOSED after a failed one', async () => {
  const { doc } = installDom()
  const f = vaultBarFixture(doc)
  let list = [{ root: '/a', name: 'a', exists: true },
              { root: '/b', name: 'b', exists: true },
              { root: '/c', name: 'c', exists: true }]
  let fail = false
  const { calls, deps } = vaultDeps({
    recentVaults: async () => list,
    forgetVault: async (root) => {
      calls.push('forgetVault:' + root)
      if (fail) throw new Error('nope')
      list = list.filter((v) => v.root !== root)
    },
  })
  const vb = C.createVaultBar(deps, f.root)
  vb.setVault({ root: '/a', name: 'a' })
  vb.openPopup()
  await settle()
  const labels = () => doc.body.children[0].querySelectorAll('.ctx-item').map((r) => r.textContent)
  const firstBtn = () => doc.body.children[0].querySelectorAll('.ctx-row-btn')[0]
  assert.deepEqual(labels(), ['a', 'b', 'c', 'Open folder as vault…'])

  // menu.ts rebuilds a menu from data and has no live-update path, so the only
  // way to show the shorter list is to build it again. Obsidian gets this free —
  // its vault list is a WINDOW that calls its own refresh — and close-then-reopen
  // is the nearest a menu can do. It is also what lets the user remove several
  // in a row without going back to the bar each time.
  firstBtn().dispatch('click', clickEvent())
  await settle()
  assert.equal(doc.body.children.length, 1, 'the popover did not come back')
  assert.deepEqual(labels(), ['a', 'c', 'Open folder as vault…'])

  // ON FAILURE IT STAYS CLOSED, and the error is reported. A popover springing
  // back over the message would be the second surprise.
  fail = true
  firstBtn().dispatch('click', clickEvent())
  await settle()
  assert.deepEqual(calls.slice(-2), ['forgetVault:/c', 'onError:forget-vault'])
  assert.equal(doc.body.children.length, 0, 'the popover reopened over the error')
})

test('§7.6 — the recents popover is the TALLEST menu in the app, and it still fits', async () => {
  const { doc } = installDom()
  const f = vaultBarFixture(doc)
  // §7.6 caps `recents` at 8.  One of them is gone from disk: it is SHOWN and
  // DISABLED, never silently dropped — "my vaults" losing an entry reads as
  // data loss even when it is only an unmounted volume.
  const list = Array.from({ length: 8 }, (_, i) => ({ root: '/v' + i, name: 'v' + i, exists: i !== 3 }))
  const { deps } = vaultDeps({ recentVaults: async () => list })
  const vb = C.createVaultBar(deps, f.root)
  vb.setVault({ root: '/v1', name: 'v1' })
  vb.openPopup()
  await settle()

  const menu = doc.body.children[0]
  const rows = menu.querySelectorAll('.ctx-item')
  assert.equal(rows.length, 9, '8 recents + "Open folder as vault…"')
  assert.equal(menu.querySelectorAll('.ctx-sep').length, 1)
  assert.equal(rows[3].textContent, 'v3 (missing)')
  assert.equal(rows[3].classList.contains('is-disabled'), true)
  assert.equal(rows[1].getAttribute('aria-checked'), 'true', 'the open vault carries the tick')
  assert.equal(rows[8].textContent, 'Open folder as vault…')

  // §0.27 E67 — THE SHAPE OF THE POPOVER, which is what the user reported.
  // Nine empty slots, one tick at the END of the open vault's row, and one glyph
  // on the last row: that is Obsidian's own popover, whose items are
  // `setTitle(name).setChecked(isCurrent)` and then, after a separator,
  // `setTitle(manageVaults()).setIcon("open-vault")`.
  for (const r of rows) {
    assert.equal(r.children[0].className, 'ctx-icon', 'a row lost its leading icon slot')
  }
  const tail = (r) => r.children[r.children.length - 1]
  assert.equal(tail(rows[1]).className, 'ctx-icon mod-checked')
  assert.equal(tail(rows[1]).getAttribute('data-icon'), 'check')
  assert.equal(menu.querySelectorAll('.ctx-icon.mod-checked').length, 1,
    'exactly one vault is open, so exactly one row is ticked')
  assert.equal(rows[8].children[0].getAttribute('data-icon'), 'open-vault')
  assert.match(String(rows[8].children[0].innerHTML), /^<svg width="16" height="16"/)
  // The eight vault rows carry NO glyph — their slots are empty and therefore
  // zero wide, so their labels sit 16px left of the last row's. Both apps.
  for (let i = 0; i < 8; i++) {
    assert.equal(rows[i].children[0].getAttribute('data-icon'), null)
  }

  // §5.12.4.3: the clip branch must stay unreachable, and the numbers that make
  // it unreachable are in chrome.css — so read them from there rather than
  // restating them, or the day someone grows .ctx-item this row goes quiet.
  //
  // §0.14 E16 REBUILT THE MODEL, because Obsidian's row has no `height` at all:
  // it is padding + the taller of the text box and the 16px glyph, and pinning
  // a height here would have been exactly the "write the answer, not the rule"
  // mistake §0.7 E9 records. So the arithmetic below reconstructs the row the
  // way the browser does, from the four declarations that decide it.
  const num = (re, where = chromeCss) => Number(re.exec(where)[1])
  const itemCss = chromeCss.slice(chromeCss.indexOf('.ctx-item {'), chromeCss.indexOf('.ctx-icon {'))
  const menuCss = chromeCss.slice(chromeCss.indexOf('.ctx-menu {'), chromeCss.indexOf('.ctx-item {'))
  // BOUNDED. This slice used to run to END OF FILE, so deleting `.ctx-sep`'s
  // `border-bottom` — which removes every dividing rule in every menu — let the
  // regex walk 76 lines on and match `.vault-lost`'s border instead, still
  // return 1, and keep this test green.
  const sepCss = chromeCss.slice(chromeCss.indexOf('.ctx-sep {'),
                                 chromeCss.indexOf('}', chromeCss.indexOf('.ctx-sep {')))
  const iconCss = chromeCss.slice(chromeCss.indexOf('.ctx-icon {'), chromeCss.indexOf('.ctx-label'))

  const padY = num(/padding:\s*(\d+)px/, itemCss)                 // 4  [S] --size-4-1
  // §0.27 E67 MOVED WHERE THE 16 LIVES, and this row moved with it rather than
  // being deleted. `.ctx-icon` no longer declares a width or a height: Obsidian's
  // `.menu-item-icon` is `flex: 0 1 auto` and the 16px belongs to the GLYPH, via
  // `.menu-item-icon .svg-icon { --icon-size: var(--icon-s) }`. Cairn writes the
  // same 16 as an attribute pair in `icon()`, from each glyph's own `size`. So
  // the row's height is still `2 * padY + max(glyph, text)` — the model is
  // unchanged — but the glyph term is now read out of icons.ts, which is where
  // it is actually decided, and the CSS is pinned NOT to reopen the box.
  assert.equal(/flex:\s*0 1 auto/.test(iconCss), true,
    '.ctx-icon is sized again; an EMPTY slot must collapse to nothing')
  assert.equal(/(^|\s)(width|height):/.test(iconCss), false,
    '.ctx-icon declares a box again; an iconless row would indent by 24, not 8')
  const iconsTs = read('src/icons.ts')
  const iconH = Number(/'check': \{ size: (\d+)/.exec(iconsTs)[1])  // 16 [S] --icon-s
  const lineH = num(/line-height:\s*([\d.]+)/, menuCss)            // 1.3 [S] tight
  const fs = num(/--fs-ui-small:\s*(\d+)px/, read('src/styles/tokens.css'))
  const menuPad = num(/padding:\s*(\d+)px/, menuCss)              // 6  [S] --size-2-3
  const sepM = num(/margin:\s*(\d+)px/, sepCss)                   // 6
  const sepB = num(/border-bottom:\s*(\d+)px/, sepCss)            // 1

  assert.equal(fs, 13, '[S] Obsidian --font-ui-small')
  assert.equal(lineH, 1.3, '[S] Obsidian body --line-height-tight')
  // The text box is TALLER than the glyph (16.9 > 16), so it drives the row and
  // the icon rides along. If that ever inverts, the row stops being 24.9 and
  // this assertion is what says so.
  assert.ok(fs * lineH > iconH, 'the glyph now drives the row height, not the text')
  const itemH = 2 * padY + Math.max(iconH, fs * lineH)
  assert.equal(Math.round(itemH * 10) / 10, 24.9, 'the row is no longer Obsidian 1.12.7\'s 24.9px')

  const tallest = 9 * itemH + (sepB + 2 * sepM) + 2 * menuPad
  assert.equal(Math.round(tallest * 10) / 10, 249.1, 'was 269 before E16 shrank the row')
  assert.ok(tallest < 919, 'the tallest menu no longer fits the pane and would have to clip')
  // …and it always has room ABOVE the vault bar, so it flips instead of clamping.
  assert.ok(921 - tallest >= 4, 'the recents popover would be clamped rather than flipped')
})

test('§5.11 — the probe runs AFTER a note is open, not on the boot frame', () => {
  // THE TRIPWIRE THIS REPLACES HAS FIRED, AS DESIGNED.  It recorded that
  // mountChrome() hides the tab (§7.4) while main.ts ran runGeometryProbe() on
  // the very next frame with no note ever opened — so the probe's `tab` row
  // (x 430 / width 200 / height 34 / #182028 — §0.6 E8) read a display:none box and
  // FAILED four checks, in a gate whose whole condition is
  // `fail === 0 && skip === 0`.  main.ts now opens `VaultInfo.lastNote` and
  // fires the probe only after that, which is what §5.11's "on the first
  // animation frame after nc://vault-opened" plus its fixture actually require.
  //
  // The row is kept rather than deleted, inverted: it now pins the FIX, so that
  // moving runGeometryProbe() back onto the boot path fails here instead of
  // silently costing four checks in G9.
  const mainTs = read('src/main.ts')
  assert.match(mainTs, /mountChrome\(\)/)
  assert.match(mainTs, /runGeometryProbe\(\)/)

  // The probe call must live in the vault-opened path, not in boot().
  const boot = mainTs.slice(mainTs.indexOf('function boot('))
  assert.equal(/runGeometryProbe\(\)/.test(boot), false,
    'runGeometryProbe() is back on the boot frame — the `tab` row will read a hidden box')
  const applied = mainTs.slice(
    mainTs.indexOf('async function applyVaultInfo'),
    mainTs.indexOf('function boot(')
  )
  assert.match(applied, /runGeometryProbe\(\)/)
  assert.match(applied, /openNoteAt\(info\.lastNote\)/)
  // …and it fires ONCE, so a rescan or a vault switch cannot emit a second
  // geometry-report to a main.rs that exits on the first one.
  assert.match(applied, /probeDone/)

  // The tab is a real, wired control now, not the scaffold's always-visible div.
  assert.match(mainTs, /createTabStrip\(/)

  const probe = read('tools/verify-geometry.js')
  assert.match(probe, /row\('tab',/)
  assert.match(probe, /c\('x', 430,/)
})

test('§0.12 E14 — Copy absolute path writes the clipboard from the click, with no IPC', () => {
  // The minidom has no `navigator` and no `document.execCommand`, and giving it
  // either would be inventing browser behaviour to agree with — `_minidom.mjs`'s
  // own header refuses that on purpose.  So the CONTRACT is asserted at the
  // source, and the arithmetic under it is tested for real in the
  // `absolutePath` case above.
  const mainTs = read('src/main.ts')
  const fn = mainTs.slice(mainTs.indexOf('function copyAbsolutePath('),
                          mainTs.indexOf('function rowMenu('))

  // 1. It is the WEB API, not a new command: copy-path crosses no IPC.
  assert.match(fn, /navigator\.clipboard\s*\n?\s*\.writeText\(/)
  assert.equal(/invoke\(/.test(fn), false, 'copy-path crossed the IPC')

  // 2. IT MUST NOT BE ASYNC.  WebKit gates the async clipboard on transient
  //    activation; anything awaited before `writeText` consumes it and the
  //    promise rejects with NotAllowedError for no visible reason.  menu.ts's
  //    `activate()` calls `onSelect()` synchronously precisely so this holds.
  assert.equal(/async function copyAbsolutePath/.test(mainTs), false,
    'copyAbsolutePath is async: the click activation is gone by the time writeText runs')
  assert.equal(/await/.test(fn), false, 'copyAbsolutePath awaits before writing the clipboard')
  assert.match(read('src/menu.ts'), /closeMenu\(\)\n\s*a\.onSelect\(\)/)

  // 3. BOTH failure shapes are handled, and they are different shapes.  A
  //    rejected promise (NotAllowedError) is the `.catch`; a MISSING
  //    `navigator.clipboard` throws a TypeError synchronously, before there is
  //    a promise to attach `.catch` to, and would escape into menu.ts's click
  //    listener as an uncaught exception.
  assert.match(fn, /\.catch\(\(e: unknown\) => reportError\(e, 'copy-path'\)\)/)
  assert.match(fn, /try \{[\s\S]*\} catch \(err\) \{[\s\S]*reportError\(err, 'copy-path'\)/)

  // 4. The ROW menus are wired to it — file and folder both target their own
  //    path — and the empty-space menu is NOT.  User ruling, 2026-09-14: with
  //    no entry under the cursor there is nothing to copy, so `rowMenu` must
  //    not build a `copyPath` for the root at all (the forbidden wiring is
  //    named here the way `destinationFor` is elsewhere in this file: the
  //    pattern is the assertion, and a bare-substring future grep is the
  //    documented hazard).
  const rowMenu = mainTs.slice(mainTs.indexOf('function rowMenu('),
                               mainTs.indexOf('/** The one route into the editor.'))
  assert.equal(/copyPath: \(\) => copyAbsolutePath\(''\)/.test(rowMenu), false,
    'empty space copies the vault root again')
  assert.match(rowMenu, /copyPath: \(\) => copyAbsolutePath\(path\)/)
  assert.equal(/reveal:/.test(rowMenu), false, 'the row menus still wire Reveal in Finder')

  // 5. …and §1.3 command 20 is NOT orphaned by that: the delete-failure dialog
  //    is now its only caller, which is the sentence §1.3 had to be amended to.
  assert.match(mainTs, /label: 'Show in Finder'/)
  assert.match(mainTs, /await revealInOs\(path\)/)
})

test('§0.12 E14 — ChromeDeps lost exactly the four members the nav slots owned', () => {
  // `tsc` catches a REMOVED member that is still passed, but not a member left
  // on the interface with no consumer — and four of these were nav-slot-only.
  const deps = chromeTs.slice(chromeTs.indexOf('export interface ChromeDeps {'),
                              chromeTs.indexOf('export interface ChromeHandle {'))
  // Matched as a DECLARATION (start of line, two-space indent), not as a
  // substring: the interface's own comment names all four, saying where each
  // went, and that prose is the point rather than a leak.
  for (const gone of ['newFolder', 'getSort', 'setSort', 'collapseAll']) {
    assert.equal(new RegExp(`^  ${gone}\\(`, 'm').test(deps), false,
      `ChromeDeps still declares ${gone}()`)
  }
  // Mod-N keeps `newNote`, and the banner keeps `rescanAll`.
  assert.match(deps, /newNote\(\): void/)
  assert.match(deps, /rescanAll\(\): Promise<void>/)
  assert.equal(/function nav\(icon/.test(chromeTs), false, 'the nav slot lookup helper survived')
})

test('closing a menu hands focus BACK, so the tree`s arrow keys are not left dead', () => {
  const { doc } = installDom()
  const tree = doc.createElement('div')
  tree.className = 'tree-scroller'
  doc.body.append(tree)
  tree.focus()
  assert.equal(doc.activeElement, tree)

  // Escape: the menu had focus, so it must give it back.
  C.openMenu([{ label: 'Rename…', onSelect: () => {} }], { x: 10, y: 10 })
  assert.equal(doc.activeElement, C.isMenuOpen() ? doc.activeElement : null)
  doc.fire('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} })
  assert.equal(doc.activeElement, tree, 'Escape left focus on nothing')

  // Selecting a row must NOT: activate() closes first and the action's own
  // focus() — an inline editor, a modal — has to win.
  const field = doc.createElement('input')
  doc.body.append(field)
  tree.focus()
  C.openMenu([{ label: 'Rename…', onSelect: () => field.focus() }], { x: 10, y: 10 })
  doc.fire('keydown', { key: 'ArrowDown', preventDefault() {}, stopPropagation() {} })
  doc.fire('keydown', { key: 'Enter', preventDefault() {}, stopPropagation() {} })
  assert.equal(doc.activeElement, field, 'the menu stole focus back from the inline editor')
})

/* ---- the two fixed tabs (user features, 2026-09-15/16) --------------------
 * Note tab + fixed `Memoir` tab, NEITHER closable, vault-root `Memoir.md`
 * shown ONLY there.  Inactive styling is Obsidian 1.13.7's own
 * `.workspace-tab-header` (transcribed in chrome.css, read out of the 1.13.7
 * asar — NOT derived), and these rows pin the wiring PART C can prove:
 * visibility lifetime, the exactly-one-active invariant, click-to-select in
 * both directions, and the null-guards that keep the pre-memoir single-tab
 * fixture (and every test above it) meaningful. */

/** `tabFixture` plus the fixed second tab, as src/index.html ships it: the
 *  memoir tab starts HIDDEN (no vault yet) and — like the note tab since
 *  2026-09-16 — carries no close button. */
function memoirFixture(doc) {
  const f = tabFixture(doc)
  const memoir = doc.createElement('div'); memoir.className = 'tab'
  memoir.setAttribute('data-tab', 'memoir')
  memoir.hidden = true
  const inner = doc.createElement('span'); inner.className = 'tab-inner'
  const mlabel = doc.createElement('span'); mlabel.className = 'tab-label'
  mlabel.textContent = 'Memoir'
  inner.append(mlabel)
  memoir.append(inner)
  f.strip.append(memoir)
  return { ...f, memoir, mlabel }
}

const isActive = (el) => el.classList.contains('is-active')
const activeTabs = (strip) => strip.querySelectorAll('.tab.is-active').length

test('Memoir — hidden until the vault opens; the module never unhides it alone', async () => {
  const { doc } = installDom()
  const f = memoirFixture(doc)
  const { deps } = spyDeps()
  const strip = C.createTabStrip(deps, f.root)

  assert.equal(f.memoir.hidden, true, 'creating the strip showed Memoir with no vault open')
  strip.setNote('A.md')
  assert.equal(f.memoir.hidden, true, 'opening a note showed Memoir with no vault applied')
  strip.setMemoirVisible(true)
  assert.equal(f.memoir.hidden, false)
  assert.equal(f.tab.hidden, false, 'showing Memoir hid the note tab')
  strip.setMemoirVisible(false)
  assert.equal(f.memoir.hidden, true)
})

test('Memoir — exactly one tab is active, and setActive flips the pair', async () => {
  const { doc } = installDom()
  const f = memoirFixture(doc)
  const { deps } = spyDeps()
  const strip = C.createTabStrip(deps, f.root)
  strip.setNote('A.md')
  strip.setMemoirVisible(true)

  assert.equal(strip.active, 'note')
  assert.equal(activeTabs(f.strip), 1)
  assert.equal(isActive(f.tab), true)
  assert.equal(isActive(f.memoir), false)

  strip.setActive('memoir')
  assert.equal(strip.active, 'memoir')
  assert.equal(activeTabs(f.strip), 1, 'both tabs carried .is-active — G9 would read either')
  assert.equal(isActive(f.tab), false)
  assert.equal(isActive(f.memoir), true)

  strip.setActive('note')
  assert.equal(activeTabs(f.strip), 1)
})

test('Memoir — clicking the inactive tab selects; clicking the active one is silent', async () => {
  const { doc } = installDom()
  const f = memoirFixture(doc)
  const selected = []
  const { deps } = spyDeps({ onSelect: (w) => selected.push(w) })
  const strip = C.createTabStrip(deps, f.root)
  strip.setNote('A.md')
  strip.setMemoirVisible(true)

  f.memoir.dispatch('click', clickEvent())
  assert.deepEqual(selected, ['memoir'])
  // The shell flips `active` on a successful open (flush-first); the module
  // never does it on its own authority, so model that step explicitly.
  strip.setActive('memoir')
  f.memoir.dispatch('click', clickEvent())
  assert.deepEqual(selected, ['memoir'], 'clicking the active tab re-requested the switch')

  f.tab.dispatch('click', clickEvent())
  assert.deepEqual(selected, ['memoir', 'note'], 'clicking the inactive note tab selected nothing')
})

test('Memoir — both tabs are fixed: no close button anywhere on the strip', async () => {
  const { doc } = installDom()
  const f = memoirFixture(doc)
  const { deps } = spyDeps()
  const strip = C.createTabStrip(deps, f.root)
  strip.setNote('Misc.md')
  strip.setMemoirVisible(true)

  assert.equal(f.root.querySelector('.tab-close'), null, 'a close button shipped')
  assert.equal(strip.path, 'Misc.md')
  assert.equal(f.tab.hidden, false)
  assert.equal(f.memoir.hidden, false)
})

test('Memoir — setNote never rewrites the fixed label; dirt rides the ACTIVE tab', async () => {
  const { doc } = installDom()
  const f = memoirFixture(doc)
  const { deps } = spyDeps()
  const strip = C.createTabStrip(deps, f.root)
  strip.setNote('A.md')
  strip.setMemoirVisible(true)

  assert.equal(f.mlabel.textContent, 'Memoir')
  strip.setDirty(true)
  assert.equal(f.tab.classList.contains('is-dirty'), true)
  assert.equal(f.memoir.classList.contains('is-dirty'), false,
    "Memoir's dirt was attributed to the note tab")

  strip.setActive('memoir')
  strip.setDirty(false)
  strip.setDirty(true)
  assert.equal(f.memoir.classList.contains('is-dirty'), true)
  assert.equal(f.label.textContent, 'A', 'the note label moved while on Memoir')
})

test('Memoir — the pre-memoir single-tab DOM keeps working (every guard holds)', async () => {
  const { doc } = installDom()
  const f = tabFixture(doc)
  const { deps } = spyDeps()
  const strip = C.createTabStrip(deps, f.root)

  // No memoir element at all: visibility and activation are no-ops, not throws.
  strip.setMemoirVisible(true)
  strip.setActive('memoir')
  assert.equal(strip.active, 'memoir')
  strip.setDirty(true)
  assert.equal(f.tab.classList.contains('is-dirty'), true, 'dirt fell on the floor with no memoir tab')
  strip.setNote('Misc.md')
  assert.equal(f.tab.hidden, false)
  assert.equal(f.root.querySelector('.tab-close'), null, 'a close button shipped')
})

test('Memoir — source conformance: NO close button, a fixed label, inactive CSS', async () => {
  // ZERO `.tab-close` in the shipped strip (user ruling 2026-09-16): both tabs
  // are fixed and can't close.
  assert.equal(/tab-close/.test(indexHtml.replace(/<!--[\s\S]*?-->/g, '')), false, 'a close button shipped')
  assert.match(indexHtml, /data-tab="memoir"/)
  assert.match(indexHtml, />Memoir</)
  // Both tabs carry the inner pill — the hover fill lives on it, inset from
  // the slot, which is the separation the user photographed.
  assert.equal(indexHtml.match(/tab-inner/g).length, 2, 'a tab lost its inner pill')
  // The inactive transcription (Obsidian app.css:6706-7060): transparent, no
  // ring, no shoulder curves, muted text, hover pill ON THE INNER.  The hover
  // fill on the whole `.tab` stood here and was photographed touching the
  // active tab — withdrawn 2026-09-16.
  assert.match(chromeCss, /\.tab:not\(\.is-active\)\s*\{[^}]*background:\s*transparent/)
  assert.match(chromeCss, /\.tab:not\(\.is-active\)::before/)
  assert.match(chromeCss, /\.tab:not\(\.is-active\) \.tab-label\s*\{[^}]*color:\s*var\(--text-muted\)/)
  assert.match(chromeCss, /\.tab:not\(\.is-active\):hover \.tab-inner\s*\{[^}]*background:\s*var\(--bg-modifier-hover\)/)
  assert.equal(/\.tab:not\(\.is-active\):hover\s*\{[^}]*background/.test(chromeCss), false,
    'the hover fill is back on the whole tab — it touches the active tab')
  assert.match(chromeCss, /\.tab-inner\s*\{[^}]*padding:\s*0 3px 0 6px/)
  // The pill radius is platform-scoped, like Obsidian's own `--tab-radius`
  // (base `body` 4px, `.mod-macos` 8px — never the active tab's 6px): macOS
  // value at the base, Linux value under `:root[data-os="linux"]`, the only
  // place a token may depend on the OS.  Shipping the 8px globally wore a
  // macOS pill on Linux and the user photographed it.
  assert.match(chromeCss, /\.tab-inner\s*\{[^}]*border-radius:\s*var\(--tab-pill-radius\)/)
  const tokensCss = read('src/styles/tokens.css')
  assert.match(tokensCss, /--tab-pill-radius:\s*var\(--radius-m\)/)
  assert.match(tokensCss, /:root\[data-os="linux"\][\s\S]*?--tab-pill-radius:\s*var\(--radius-s\)/)
  // No close-button rules anywhere: both tabs are fixed (2026-09-16).
  assert.equal(/tab-close/.test(chromeCss), false, 'a .tab-close rule is back')
})

/* ---- Mod-1 / Mod-2 tab switching (user ruling 2026-09-16) -----------------
 * Ctrl/Cmd+1 selects the note tab, Ctrl/Cmd+2 the fixed Memoir tab — the same
 * flush-first `switchTab` the tab clicks go through.  `chrome.ts` owns the
 * keystroke, `main.ts` owns the switch; these rows pin the keystroke half
 * (which tab is named, which keystrokes are ignored) and the wiring half. */

function chromeDeps(over) {
  const calls = []
  return {
    calls,
    deps: {
      newNote: () => calls.push('newNote'),
      rescanAll: async () => { calls.push('rescanAll') },
      toggleSearch: () => calls.push('toggleSearch'),
      switchVault: () => calls.push('switchVault'),
      saveSidebarW: () => {},
      pickVault: () => {},
      reopenVault: () => {},
      flushNow: async () => {},
      onVaultLost: () => {},
      onError: () => {},
      selectTab: (w) => calls.push('tab:' + w),
      ...over,
    },
  }
}

function modKey(doc, key, mod) {
  // `isMod` picks ⌘ on macos and Ctrl elsewhere; the event shape mirrors what
  // the browser delivers (no alt, no shift unless stated).
  const os = doc.documentElement.getAttribute('data-os')
  const ev = {
    key,
    metaKey: os === 'macos' ? mod === 'mod' : false,
    ctrlKey: os === 'macos' ? false : mod === 'mod',
    altKey: false,
    shiftKey: false,
    repeat: false,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true },
    stopPropagation() {},
  }
  doc.fire('keydown', ev)
  return ev
}

test('Mod-1 / Mod-2 select the note / Memoir tab (macOS ⌘)', () => {
  const { doc } = installDom()
  doc.documentElement.setAttribute('data-os', 'macos')
  const root = doc.createElement('div')
  const { calls, deps } = chromeDeps()
  const handle = C.wireChrome(deps, root)

  const e1 = modKey(doc, '1', 'mod')
  assert.equal(e1.defaultPrevented, true, 'Mod-1 did not suppress the webview default')
  const e2 = modKey(doc, '2', 'mod')
  assert.equal(e2.defaultPrevented, true, 'Mod-2 did not suppress the webview default')
  assert.deepEqual(calls, ['tab:note', 'tab:memoir'])
  handle.destroy()
})

test('Ctrl-1 / Ctrl-2 select the tabs on Linux', () => {
  const { doc } = installDom()
  doc.documentElement.setAttribute('data-os', 'linux')
  const root = doc.createElement('div')
  const { calls, deps } = chromeDeps()
  const handle = C.wireChrome(deps, root)

  modKey(doc, '1', 'mod')
  modKey(doc, '2', 'mod')
  assert.deepEqual(calls, ['tab:note', 'tab:memoir'])
  handle.destroy()
})

test('Mod-1 / Mod-2 ignore the keystrokes they do not own', () => {
  const { doc } = installDom()
  doc.documentElement.setAttribute('data-os', 'macos')
  const root = doc.createElement('div')
  const { calls, deps } = chromeDeps()
  const handle = C.wireChrome(deps, root)

  // No modifier: typing "1" into a note must not switch tabs.
  modKey(doc, '1', 'plain')
  // With Shift: Mod-Shift-1 is "!" — not a tab binding (Shift-Mod is F/O only).
  const shifted = {
    key: '1', metaKey: true, ctrlKey: false, altKey: false, shiftKey: true,
    repeat: false, defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true }, stopPropagation() {},
  }
  doc.fire('keydown', shifted)
  // A third tab does not exist.
  modKey(doc, '3', 'mod')
  // Somebody nearer already owned it (CM6's Mod-s shape): no double-run.
  const owned = {
    key: '1', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false,
    repeat: false, defaultPrevented: true,
    preventDefault() {}, stopPropagation() {},
  }
  doc.fire('keydown', owned)
  assert.deepEqual(calls, [], 'an unowned keystroke reached selectTab')
  handle.destroy()
})

test('Mod-1 / Mod-2 are wired to the tab switch in main.ts', () => {
  const mainTs = read('src/main.ts')
  assert.match(mainTs, /selectTab:\s*\(which\)\s*=>\s*switchTab\(which\)/)
  assert.match(read('src/chrome.ts'), /selectTab\(which: TabId\): void/)
  assert.match(read('src/chrome.ts'), /deps\.selectTab\('note'\)/)
  assert.match(read('src/chrome.ts'), /deps\.selectTab\('memoir'\)/)
})

/* =========================================================================
 * F66 — the note-state bar (§7.3 cases 5/7). `keepMine`, `reloadFromDisk`
 * and `saveAs` had no caller, so a conflicted/detached note could never be
 * resolved. The bar is the caller. It shows ONLY in those states, so nothing
 * at rest moves (G9).
 * ====================================================================== */

/** `main.editor` in the shape src/index.html ships it: the bar's host, then
 *  the `#ed` it must land above. `_minidom.mjs` matches `.class`/`[attr]`
 *  only, so the `#ed` lookup below needs the `#id` support added beside the
 *  descendant support above. */
function editorFixture(doc) {
  const root = doc.createElement('div')
  const main = doc.createElement('main')
  main.className = 'editor'
  const ed = doc.createElement('div')
  ed.setAttribute('id', 'ed')
  main.append(ed)
  root.append(main)
  return { root, main, ed }
}

const noteBar = (main) => main.querySelectorAll('.note-bar')
const barButtons = (bar) => bar.querySelectorAll('.chrome-btn').map((b) => b.textContent)

test('F66: the conflict bar names the state and lands above #ed', () => {
  const { doc } = installDom()
  const { root, main, ed } = editorFixture(doc)

  C.setNoteBar('conflict', root)
  assert.equal(noteBar(main).length, 1)
  const bar = noteBar(main)[0]
  assert.equal(bar.querySelectorAll('.note-bar-line')[0].textContent, C.NOTE_BAR_TEXT.conflict.line)
  assert.deepEqual(barButtons(bar), ['Keep mine', 'Reload from disk'])
  assert.equal(main.children[0], bar, 'the bar must precede #ed')
  assert.equal(main.children[1], ed)

  C.setNoteBar(null, root)
  assert.equal(noteBar(main).length, 0, 'every other state removes the bar')
})

test('F66: the detached bar carries Save as… and replaces the conflict bar', () => {
  const { doc } = installDom()
  const { root, main } = editorFixture(doc)

  C.setNoteBar('conflict', root)
  C.setNoteBar('detached', root)
  assert.equal(noteBar(main).length, 1, 'switching states must replace, not stack')
  assert.deepEqual(barButtons(noteBar(main)[0]), ['Save as…', 'Discard'])
  C.setNoteBar('detached', root)
  assert.equal(noteBar(main).length, 1, 're-setting the same state must not duplicate')
})

test('F66: the four buttons reach the four deps', () => {
  const { doc } = installDom()
  const { root, main } = editorFixture(doc)
  const calls = []
  const deps = {
    newNote: () => {}, rescanAll: () => Promise.resolve(), toggleSearch: () => {},
    switchVault: () => {}, selectTab: () => {}, saveSidebarW: () => {},
    pickVault: () => {}, reopenVault: () => {}, flushNow: () => Promise.resolve(),
    onVaultLost: () => {}, onError: (e, ctx) => calls.push(['error', ctx]),
    keepMine: () => { calls.push(['keepMine']); return Promise.resolve() },
    reloadFromDisk: () => { calls.push(['reload']); return Promise.resolve() },
    saveAsPrompt: () => { calls.push(['saveAsPrompt']) },
    discardNote: () => { calls.push(['discard']) },
  }
  const handle = C.wireChrome(deps, root)
  const click = (cls) => {
    const btn = main.querySelectorAll('.' + cls)[0]
    assert.ok(btn, 'button .' + cls + ' is missing')
    main.dispatch('click', { target: btn })
  }
  handle.noteState('conflict')
  click('note-keep')
  click('note-reload')
  handle.noteState('detached')
  click('note-saveas')
  click('note-discard')
  assert.deepEqual(calls, [['keepMine'], ['reload'], ['saveAsPrompt'], ['discard']])
  // No `handle.destroy()`: `_minidom.mjs` has no `removeEventListener`, and
  // the keydown listener dies with this test's document anyway.
})

/* F56: shortcuts stay dead under a modal. ⌘⇧O under a delete confirm opened
 * the vault popover above the dialog; switching vaults re-resolved the
 * pending relative path in the new vault. */
test('F56: no chrome shortcut fires while a dialog is open', () => {
  const { doc } = installDom()
  const calls = []
  const deps = {
    newNote: () => { calls.push('newNote') },
    rescanAll: () => Promise.resolve(), toggleSearch: () => {},
    switchVault: () => { calls.push('switchVault') }, selectTab: () => {},
    saveSidebarW: () => {}, pickVault: () => {}, reopenVault: () => {},
    flushNow: () => Promise.resolve(), onVaultLost: () => {},
    onError: () => {},
    keepMine: () => Promise.resolve(), reloadFromDisk: () => Promise.resolve(),
    saveAsPrompt: () => {}, discardNote: () => {},
  }
  const root = doc.createElement('div')
  C.wireChrome(deps, root)
  const ctrlO = {
    key: 'o', ctrlKey: true, metaKey: false, shiftKey: true, altKey: false,
    repeat: false, defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true }, stopPropagation() {},
  }
  doc.fire('keydown', { ...ctrlO })
  assert.deepEqual(calls, ['switchVault'], 'the shortcut broke before the dialog')

  calls.length = 0
  const realError = console.error
  console.error = () => {}
  let answer
  try {
    answer = C.modal.openModal({
      title: 'Delete file', detail: 'y',
      buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'delete', label: 'Delete', destructive: true }],
      defaultId: 'cancel',
    })
    assert.equal(C.modal.modalIsOpen(), true)
    doc.fire('keydown', { ...ctrlO })
    assert.deepEqual(calls, [], 'a shortcut fired under the open dialog')
  } finally {
    console.error = realError
  }
  void answer
})
