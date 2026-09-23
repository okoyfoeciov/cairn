// `node --test tests/frontend/*.test.mjs`.
//
// electron-shell/replace-file.mjs publishes a file by rename. The property
// that matters is the INODE: a process that has `cairn.node` mapped keeps the
// file it loaded, and only a new inode gives it that. Copying over the path
// writes into the old inode, and a running Cairn then executes whatever bytes
// sit at the old offsets (electron-shell/addon-rebuild.test.mjs shows the crash).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  closeSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { replaceFileAtomically } from '../../electron-shell/replace-file.mjs'

function scratch() {
  return mkdtempSync(join(tmpdir(), 'cairn-replace-'))
}

function readFd(fd, n) {
  const buf = Buffer.alloc(n)
  const got = readSync(fd, buf, 0, n, 0)
  return buf.subarray(0, got).toString()
}

test('the published path is a NEW inode, and a reader of the old one keeps its bytes', () => {
  const dir = scratch()
  try {
    const dst = join(dir, 'cairn.node')
    const src = join(dir, 'built.so')
    writeFileSync(dst, 'OLD-ADDON-BYTES')
    writeFileSync(src, 'NEW-ADDON-BYTES')
    const inoBefore = statSync(dst).ino
    // Stands in for a running process that has the old addon open (dlopen maps it).
    const held = openSync(dst, 'r')
    try {
      replaceFileAtomically(src, dst)
      assert.equal(readFileSync(dst, 'utf8'), 'NEW-ADDON-BYTES')
      assert.notEqual(statSync(dst).ino, inoBefore,
        'the destination kept its inode: the new bytes were written INTO the file a running process has mapped')
      assert.equal(readFd(held, 64), 'OLD-ADDON-BYTES',
        'a process holding the old file now reads the new bytes -- an in-place overwrite')
    } finally {
      closeSync(held)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the mode survives, and no temp file is left beside the destination', () => {
  const dir = scratch()
  try {
    const dst = join(dir, 'cairn.node')
    const src = join(dir, 'built.so')
    writeFileSync(src, 'x', { mode: 0o755 })
    replaceFileAtomically(src, dst)
    assert.equal(statSync(dst).mode & 0o777, statSync(src).mode & 0o777)
    assert.deepEqual(readdirSync(dir).sort(), ['built.so', 'cairn.node'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a failed publish leaves the old file and no temp file', () => {
  const dir = scratch()
  try {
    const dst = join(dir, 'cairn.node')
    writeFileSync(dst, 'OLD')
    assert.throws(() => replaceFileAtomically(join(dir, 'missing.so'), dst))
    assert.equal(readFileSync(dst, 'utf8'), 'OLD')
    assert.deepEqual(readdirSync(dir), ['cairn.node'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
