/**
 * electron-shell/replace-file.mjs -- publish a file by rename, never in place.
 *
 * A running Cairn has `cairn.node` mapped (Node `dlopen`s it). Copying over
 * that path truncates and rewrites the SAME inode, so the next call into the
 * addon executes whatever bytes now sit at the old offsets: on Linux that is a
 * SIGSEGV even for a byte-identical rebuild, and macOS kills a signed image
 * that changed underneath it. A copy to a sibling temp file followed by
 * rename() gives the path a new inode instead, and every process that already
 * loaded the old one keeps it until it exits -- which is how dpkg replaces the
 * installed copy.
 *
 * No side effects at import, so it is testable without running cargo.
 */

import { closeSync, copyFileSync, fsyncSync, openSync, renameSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

export function replaceFileAtomically(src, dst) {
  // Beside `dst`, because rename() cannot cross a filesystem boundary.
  const tmp = join(dirname(dst), basename(dst) + '.tmp-' + process.pid)
  try {
    copyFileSync(src, tmp)
    const fd = openSync(tmp, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, dst)
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  }
}
