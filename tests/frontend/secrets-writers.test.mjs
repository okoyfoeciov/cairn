/**
 * F43/F44 — the secret viewer's WRITERS,
 * tests/frontend/secrets-writers.test.mjs — the secret viewer's WRITERS,
 * driven through the rendered viewer (`renderSecrets`) on the minidom shim.
 *
 * `secrets.test.mjs` pins the model with no DOM.  This file clicks the real
 * buttons, because both defects it guards live in the wiring between a row
 * and the dispatch:
 *
 *   1. DELETE AFTER AN ASYNC CONFIRM.  The row's offsets come from the
 *      document it was rendered from; the confirm is a modal that can stay
 *      open while the buffer is reloaded (an outside edit) or replaced by
 *      another note.  Confirming must then delete NOTHING and report it,
 *      never apply the stale range to whatever document is loaded now.
 *   2. ADD AND EDIT REFUSE TEXT THE PARSER WOULD READ BACK DIFFERENTLY.  A
 *      secret line starting with `#` is a label to the parser, and a fence
 *      line can end the block.  The forms refuse both with a message and
 *      leave the document untouched; every text they accept round-trips.
 *
 * The stub view has the two paths `editor.ts` re-renders on: `dispatch`
 * (onUpdate → syncSecretMode) and `setState` (loadDoc → syncSecretMode).
 *
 * NO REAL SECRET APPEARS IN THIS FILE.
 */

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

import { ADocument, AElement } from './_minidom.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '..', '..')

/** @type {any} */ let S
/** @type {any} */ let LP
/** @type {any} */ let CM

/** Unhandled rejections seen by this process: a throw inside the confirm's
 *  `.then` has nowhere else to go. */
const unhandled = []
process.on('unhandledRejection', (reason) => { unhandled.push(reason) })

before(async () => {
  const esbuild = await import(pathToFileURL(join(ROOT, 'node_modules', 'esbuild', 'lib', 'main.js')).href)
  const dir = mkdtempSync(join(tmpdir(), 'cairn-secrets-writers-'))
  process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })
  const out = join(dir, 'bundle.mjs')
  await esbuild.build({
    stdin: {
      contents:
        "export * as S from " + JSON.stringify(join(ROOT, 'src', 'secrets.ts')) + "\n" +
        "export * as LP from " + JSON.stringify(join(ROOT, 'src', 'livepreview.ts')) + "\n" +
        "export { EditorState } from '@codemirror/state'\n",
      resolveDir: ROOT,
      sourcefile: 'secrets-writers-entry.ts',
      loader: 'ts',
    },
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    mainFields: ['module', 'main'],
    conditions: ['import', 'default'],
    target: 'es2021',
    absWorkingDir: ROOT,
    logLevel: 'silent',
  })
  // Import BEFORE the DOM globals exist: CM6's browser sniffing runs at module
  // evaluation and expects a real `document` when one is defined.
  const mod = await import(pathToFileURL(out).href)
  S = mod.S
  LP = mod.LP
  CM = mod
  globalThis.document = new ADocument()
  globalThis.window = { setTimeout, clearTimeout }
  // The one DOM method `secrets.ts` uses that the shared shim lacks.
  if (!AElement.prototype.appendChild) {
    AElement.prototype.appendChild = function appendChild(kid) { this.append(kid); return kid }
  }
})

const stateOf = (text) => CM.EditorState.create({ doc: text, extensions: [LP.blockIndex] })

/** A view with `editor.ts`'s two re-render paths. */
function mount(text) {
  const root = document.createElement('div')
  const view = {
    state: stateOf(text),
    dispatch(spec) {
      const tr = this.state.update(spec)
      this.state = tr.state
      if (tr.docChanged) S.renderSecrets(root, this)
    },
    setState(s) {
      this.state = s
      S.renderSecrets(root, this)
    },
  }
  S.renderSecrets(root, view)
  return { root, view }
}

/** Registers a host whose confirm stays open until the test answers it. */
function host() {
  const h = { errors: [], answer: null, asked: [] }
  S.registerSecretsHost({
    copyText: async () => {},
    onError: (err, context) => { h.errors.push({ err, context }) },
    confirmDelete: (label) => {
      h.asked.push(label)
      return new Promise((res) => { h.answer = res })
    },
  })
  return h
}

const click = (el) => el.dispatch('click', { preventDefault() {}, target: el })
const settle = () => new Promise((r) => setImmediate(r))
const labelOf = (row) => row.querySelector('.nc-secrets-label')?.textContent
const labels = (root) => root.querySelectorAll('.nc-secrets-row').map(labelOf)
function row(root, label) {
  const r = root.querySelectorAll('.nc-secrets-row').find((x) => labelOf(x) === label)
  assert.ok(r, 'no row labelled ' + label + ' in ' + JSON.stringify(labels(root)))
  return r
}

const V1 = [
  '---',
  'cairn-type: secrets',
  '---',
  '',
  '```totp',
  '# GitHub',
  'JBSWY3DPEHPK3PXP',
  '```',
  '',
  '```secret',
  '# Bank PIN',
  'PIN-1111',
  '# Stripe key',
  'sk_test_FIXTURE_ONLY',
  '# AWS root',
  'aws-FIXTURE-ONLY',
  '```',
  '',
].join('\n')

/** V1 after the other machine added a TOTP inside the totp fence: every
 *  offset below it moved by the inserted length. */
const V2 = V1.replace('JBSWY3DPEHPK3PXP\n', 'JBSWY3DPEHPK3PXP\n# Google\nGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ\n')

/* =========================================================================
 * 1.  Delete after the confirm.
 * ========================================================================= */

test('delete control: with no change during the confirm, exactly the chosen entry goes', async () => {
  const h = host()
  const { root, view } = mount(V1)
  click(row(root, 'Stripe key').querySelector('.nc-secrets-delete'))
  assert.deepEqual(h.asked, ['Stripe key'])
  h.answer(true)
  await settle()
  assert.equal(view.state.doc.toString(), V1.replace('# Stripe key\nsk_test_FIXTURE_ONLY\n', ''))
  assert.deepEqual(h.errors, [])
})

test('delete: the note reloads during the confirm -> nothing is deleted, and it is reported', async () => {
  const h = host()
  const { root, view } = mount(V1)
  click(row(root, 'Stripe key').querySelector('.nc-secrets-delete'))
  // noteExternalChange reloading a clean buffer: loadDoc -> setState.
  view.setState(stateOf(V2))
  assert.deepEqual(labels(root), ['GitHub', 'Google', 'Bank PIN', 'Stripe key', 'AWS root'])
  h.answer(true)
  await settle()
  assert.equal(view.state.doc.toString(), V2, 'the reloaded document must be untouched')
  assert.equal(h.errors.length, 1, 'the refusal is reported, not silent')
  assert.equal(h.errors[0].context, 'secrets-delete')
  // The fresh row still works: a second Delete, with no change, removes it.
  click(row(root, 'Stripe key').querySelector('.nc-secrets-delete'))
  h.answer(true)
  await settle()
  assert.equal(view.state.doc.toString(), V2.replace('# Stripe key\nsk_test_FIXTURE_ONLY\n', ''))
})

test('delete: another note opens during the confirm -> its bytes are not touched', async () => {
  const h = host()
  const { root, view } = mount(V1)
  click(row(root, 'Stripe key').querySelector('.nc-secrets-delete'))
  // Search (Mod-Shift-F, Enter) opens a longer, unrelated note behind the modal.
  const other = 'Line 1 of the meeting notes for project Alpha.\n'.repeat(8)
  view.setState(stateOf(other))
  h.answer(true)
  await settle()
  assert.equal(view.state.doc.toString(), other)
  assert.equal(h.errors.length, 1)
})

test('delete: a shorter note opens during the confirm -> no throw escapes the confirm', async () => {
  const h = host()
  const { root, view } = mount(V1)
  const before = unhandled.length
  click(row(root, 'Stripe key').querySelector('.nc-secrets-delete'))
  view.setState(stateOf('short\n'))
  h.answer(true)
  await settle()
  await settle()
  assert.equal(view.state.doc.toString(), 'short\n')
  assert.equal(unhandled.length - before, 0, 'unhandled rejection: ' + String(unhandled[before]))
  assert.equal(h.errors.length, 1)
})

/* =========================================================================
 * 2.  Add and Edit refuse secret text the parser would read differently.
 * ========================================================================= */

const REFUSED = [
  ['#Welcome2024', 'a leading # makes the password a label'],
  ['  #pw', 'indented #'],
  ['###', 'only hashes'],
  ['API_KEY=abc\n# rotated monthly\nDB_PASS=xyz', 'a # line splits the entry'],
  ['abc\n# comment: hi\ndef', 'a comment line opens a new entry'],
  ['line1\n```\nline2', 'a backtick fence ends the block'],
  ['   ```', 'three spaces is still a fence'],
  ['a\n````\nb', 'a longer backtick fence closes too'],
  ['a\n~~~\nb', 'a tilde fence ends a ~~~secret block'],
]

const ACCEPTED = [
  'hunter2',
  'a#b',
  'pass # word',
  'line one\n\nline two',
  '-----BEGIN KEY-----\nMIIB\n-----END KEY-----',
  '    ```',
  '  spaced value  ',
  '{"k": "v"}\n~ not a fence\n`` two ticks',
]

test('secretTextProblem refuses # lines and fence lines, and nothing else', () => {
  assert.equal(typeof S.secretTextProblem, 'function', 'secrets.ts exports no secretTextProblem')
  for (const [s, why] of REFUSED) {
    const p = S.secretTextProblem(s)
    assert.equal(typeof p, 'string', why + ': ' + JSON.stringify(s) + ' was accepted')
    assert.ok(p.length > 0)
  }
  for (const s of ACCEPTED) assert.equal(S.secretTextProblem(s), null, JSON.stringify(s) + ' was refused')
  assert.match(S.secretTextProblem('ok\n#bad'), /Line 2/, 'the message names the line')
})

test('every refusal is justified: written anyway, the text does not read back', () => {
  for (const [s, why] of REFUSED) {
    // A tilde fence only closes a tilde block, and a hand-made `~~~secret`
    // block is one the Add form appends into.
    const fence = s.includes('~~~') ? '~~~' : '```'
    const doc = '---\ncairn-type: secrets\n---\n\n' + fence + 'secret\n' +
      S.formatSecretEntry('L', '', s) + '\n# N\nnnn\n' + fence + '\n'
    const got = S.parseSecretFile(stateOf(doc)).secrets.flatMap((b) => b.entries)
      .map((e) => ({ label: e.label, secret: e.secret, error: e.error }))
    assert.notDeepEqual(got, [
      { label: 'L', secret: s, error: null },
      { label: 'N', secret: 'nnn', error: null },
    ], why)
  }
})

/** The section's Add form and its fields. */
function addForm(root, index) {
  const section = root.querySelectorAll('.nc-secrets-section')[index]
  const form = section.children.find((c) => c.classList.contains('nc-secrets-form'))
  const [name, note, body] = form.querySelectorAll('.nc-secrets-input')
  return {
    open: () => click(section.querySelector('.nc-secrets-add')),
    form, name, note, body,
    save: form.querySelector('.nc-secrets-save'),
    msg: form.querySelector('.nc-secrets-msg'),
  }
}

test('Add refuses a # or fence line with a message, and writes nothing', () => {
  host()
  for (const [s, why] of REFUSED) {
    const { root, view } = mount(V1)
    const f = addForm(root, 1)
    f.open()
    f.name.value = 'Bank'
    f.body.value = s
    click(f.save)
    assert.equal(view.state.doc.toString(), V1, why + ': the document changed')
    assert.notEqual(f.msg.textContent, '', why + ': no message')
    assert.equal(f.form.hidden, false, why + ': the form closed on a refusal')
  }
})

test('Edit refuses a # or fence line with a message, and writes nothing', () => {
  host()
  for (const [s, why] of REFUSED) {
    const { root, view } = mount(V1)
    const r = row(root, 'Bank PIN')
    click(r.querySelector('.nc-secrets-edit'))
    const form = r.nextElementSibling
    assert.ok(form.classList.contains('nc-secrets-editform'))
    const body = form.querySelectorAll('.nc-secrets-input')[2]
    assert.equal(body.value, 'PIN-1111', 'the form opened prefilled')
    body.value = s
    click(form.querySelector('.nc-secrets-save'))
    assert.equal(view.state.doc.toString(), V1, why + ': the document changed')
    assert.notEqual(form.querySelector('.nc-secrets-msg').textContent, '', why + ': no message')
  }
})

test('every text Add accepts reads back as exactly that entry, beside its neighbour', () => {
  host()
  for (const s of ACCEPTED) {
    const { root, view } = mount(S.SECRET_TEMPLATE)
    for (const [label, secret] of [['L', s], ['N', 'nnn']]) {
      const f = addForm(root, 1)
      f.open()
      f.name.value = label
      f.body.value = secret
      click(f.save)
      assert.equal(f.msg.textContent, '', JSON.stringify(secret) + ' was refused: ' + f.msg.textContent)
    }
    const got = S.parseSecretFile(view.state).secrets.flatMap((b) => b.entries)
      .map((e) => ({ label: e.label, secret: e.secret, error: e.error }))
    assert.deepEqual(got, [
      { label: 'L', secret: s, error: null },
      { label: 'N', secret: 'nnn', error: null },
    ], JSON.stringify(s))
  }
})
