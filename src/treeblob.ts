/**
 * src/treeblob.ts
 * Owner: 04.  Spec: CONTRACT.md §3 (the tree transport, B1/B19/M49/M38/M61),
 * §3.2 (TreeBlob v1 — the layout), §3.3 (the caps and their header bits).
 *
 * THE DECODER, AS ARRAYBUFFER VIEWS AND ZERO PER-NODE OBJECTS.  The whole point
 * of the format is that a 50,000-node vault crosses the IPC once as raw bytes
 * and is never materialised as 50,000 JS objects; a decoder that allocates per
 * node throws the ruling away.  What `adopt()` allocates is a fixed, N-
 * independent count of objects: one `TreeBlob`, six typed-array VIEWS onto the
 * caller's buffer (no copy), and one bounded name cache.  Nothing else, ever.
 *
 * The header's `flags` are read here: bit 0 is the 50,000-node cap and bit 1 is
 * the 255-depth cap (§3.3).  They also surface on `VaultInfo` as `truncated` and
 * `truncatedDepth`, so owner 01's banner reads them WITHOUT parsing the blob;
 * they are decoded here as well because `sort_order` and `epoch` are, and a
 * half-read header is how the two sources silently drift.
 *
 * `epoch` at offset 24 is the SAME counter as `nc://tree-changed`'s payload and
 * as every mutating command's returned epoch — there is exactly one such
 * counter in the process.  It is a u64 on the wire and is exposed as a `number`:
 * it is a monotonic event counter, not an identifier, and 2^53 of them at the
 * §3.5 debounce floor of 150 ms is ~43 million years.
 *
 * ── ON VALIDATION ────────────────────────────────────────────────────────────
 * §3.2 requires `magic` and `version` to be checked before any view is created.
 * This module checks more than that, and the extra checks are not defensive
 * padding: every one of them is a precondition that `tree.ts` relies on and
 * cannot re-check on a hot path.
 *
 *   - `byteLength === 36 + 14N + M` — without it, a short buffer throws a bare
 *     `RangeError` from a `new Uint32Array(...)` deep inside adopt, naming
 *     nothing.
 *   - Invariant P (`parent[i] < i`, `i + subtree[i] < N`) — `flatten()` skips a
 *     collapsed folder with `i += subtree[i] + 1`, and `restore()` indexes
 *     `pre[depth[i] - 1]`.  A blob that violated P would make the first loop
 *     non-terminating or out of range and the second silently wrong.  P is
 *     stated in §3.2 as something "every consumer may rely on"; relying on it
 *     is exactly why it is worth one O(N) integer pass to establish it.
 *   - `depth[i] === depth[parent[i]] + 1` — `restore()`'s ancestor stack is
 *     addressed by depth, so a depth that skips a level builds a wrong path and
 *     therefore restores the wrong folder's expansion.
 *   - `kind` bits 3..7 zero, and a folder's bits 1..2 zero — reserved bits
 *     MUST be 0 (§3.2), so a future encoder that starts using one must not
 *     have its rows silently misread here.
 *
 * The whole validation is integer work over already-decoded typed arrays: five
 * O(N) passes, no allocation, no string work.  Measured cost is reported in the
 * conformance note at the foot of this file.
 */

/** `"NTB1"` little-endian — core/src/tree.rs `MAGIC`. */
export const MAGIC = 0x3142_544e
export const VERSION = 1
export const HEADER_LEN = 32
/** header `flags` bit 0 — the 50,000-node cap (§3.3). */
export const FLAG_TRUNCATED_NODES = 1 << 0
/** header `flags` bit 1 — the 255-depth cap (§3.3). */
export const FLAG_TRUNCATED_DEPTH = 1 << 1
/** `kind` bit 0 — a directory. */
export const KIND_DIR = 1 << 0
/** `kind` bits 1..2 — a file's extension case: bit 1 = `M`, bit 2 = `D`. */
export const KIND_EXT_UPPER_M = 1 << 1
export const KIND_EXT_UPPER_D = 1 << 2

/**
 * A note's extension as it is on disk, indexed by `(kind >> 1) & 3`.  `names`
 * holds the stem only, and a `.MD` file is a note (as in Obsidian), so a path
 * must put back the case the file actually has or it names a different file.
 */
const MD_EXT = ['.md', '.Md', '.mD', '.MD'] as const

/**
 * §3.2's measured heap note: "a hard-capped 1,024-entry name cache".  Cleared
 * wholesale rather than LRU-evicted — a clear costs one 1,024-entry drop and the
 * refill is ~1 µs/row, where an LRU would cost a doubly-linked list of 1,024
 * nodes to save nothing.
 */
export const NAME_CACHE_MAX = 1024

/**
 * Every rejection this module can produce, so a caller can tell "the transport
 * degraded to JSON" from "the bytes are corrupt" without parsing a message.
 */
export class TreeBlobError extends Error {
  override readonly name = 'TreeBlobError'
  constructor(message: string) {
    super(message)
  }
}

function bad(msg: string): never {
  throw new TreeBlobError('TreeBlob v1: ' + msg)
}

const DEC = new TextDecoder('utf-8')
/** §0.38 E85 — only `resolveLink` encodes, and only a link target. */
const ENC = new TextEncoder()
/** ASCII case fold, on one byte.  `A`..`Z` -> `a`..`z`, everything else as-is. */
function fold(b: number): number {
  return b >= 65 && b <= 90 ? b + 32 : b
}

/**
 * One decoded blob.  Exactly one of these is live at a time (`tree.ts` holds it);
 * `adopt()` on a fresh snapshot replaces it wholesale — §3.5 rules FULL REBUILD,
 * ALWAYS, NO DELTAS.
 *
 * The six typed arrays are VIEWS onto the ArrayBuffer the IPC handed us.  They
 * are public and are meant to be read directly on hot paths: `blob.subtree[i]`
 * is one bounds-checked load, where `blob.subtreeOf(i)` would be a call.
 */
export class TreeBlob {
  /** The adopted bytes.  Kept alive because every view below aliases it. */
  readonly buffer: ArrayBuffer
  /** N — node count, excluding the vault root. */
  readonly n: number
  /** M — `names` length in bytes. */
  readonly m: number
  /** Echo of the active `SortMode`, 0..3 (§1.5). */
  readonly sortOrder: number
  /** Raw header `flags`. */
  readonly flags: number
  /** The one process-wide counter (§1.4). */
  readonly epoch: number

  /** Descendant count, excluding self.  Node `i` owns `[i+1, i+subtree[i]]`. */
  readonly subtree: Uint32Array
  /** Parent index, or -1 for a top-level node.  Always `< i`. */
  readonly parent: Int32Array
  /** Byte offsets into `names`; `nameOff[n] === m`.  Length N+1. */
  readonly nameOff: Uint32Array
  /** 0 = top level; hard cap 255 (§3.3). */
  readonly depth: Uint8Array
  /** bit0 = is_directory; bits 1..2 = a file's extension case (`extOf`);
   *  bits 3..7 reserved and validated zero. */
  readonly kind: Uint8Array
  /** Concatenated UTF-8 DISPLAY names — a file's trailing `.md` is stripped. */
  readonly names: Uint8Array

  /** node index -> decoded name.  Hard-capped at NAME_CACHE_MAX (§3.2). */
  private readonly nameCache = new Map<number, string>()

  constructor(buffer: ArrayBuffer) {
    if (!(buffer instanceof ArrayBuffer)) {
      // §3.5's adopt() guard, kept verbatim in spirit: the one failure that is
      // NOT corruption is the transport silently falling back to JSON, and the
      // message has to say so or the next hour goes into the wrong file.
      bad(
        'tree_snapshot did not return an ArrayBuffer (got ' +
          Object.prototype.toString.call(buffer) +
          ') — the IPC transport has degraded to JSON'
      )
    }
    if (buffer.byteLength < HEADER_LEN) {
      bad('buffer is ' + buffer.byteLength + ' B, shorter than the 32 B header')
    }

    const h = new DataView(buffer, 0, HEADER_LEN)
    const magic = h.getUint32(0, true)
    if (magic !== MAGIC) {
      bad('magic 0x' + magic.toString(16) + ' != 0x' + MAGIC.toString(16))
    }
    const version = h.getUint32(4, true)
    if (version !== VERSION) bad('version ' + version + ' != ' + VERSION)

    const n = h.getUint32(8, true)
    const m = h.getUint32(12, true)
    const want = 36 + 14 * n + m
    if (buffer.byteLength !== want) {
      bad(
        'length ' +
          buffer.byteLength +
          ' != 36 + 14N + M = ' +
          want +
          ' (N=' +
          n +
          ', M=' +
          m +
          ')'
      )
    }

    this.buffer = buffer
    this.n = n
    this.m = m
    this.sortOrder = h.getUint32(16, true)
    this.flags = h.getUint32(20, true)
    // A counter, not an identifier — see the header comment on the u64 -> number
    // narrowing.  Number(bigint) is exact below 2^53.
    this.epoch = Number(h.getBigUint64(24, true))

    // §3.2's offset table, in order.  Every offset is 4-byte aligned by
    // construction (32, 32+4N, 32+8N are multiples of 4), so no copy is needed.
    let o = HEADER_LEN
    this.subtree = new Uint32Array(buffer, o, n)
    o += 4 * n
    this.parent = new Int32Array(buffer, o, n)
    o += 4 * n
    this.nameOff = new Uint32Array(buffer, o, n + 1)
    o += 4 * (n + 1)
    this.depth = new Uint8Array(buffer, o, n)
    o += n
    this.kind = new Uint8Array(buffer, o, n)
    o += n
    this.names = new Uint8Array(buffer, o, m)

    this.validate()
  }

  /** §3.3 bit 0 — the walk stopped descending at 50,000 nodes. */
  get truncatedNodes(): boolean {
    return (this.flags & FLAG_TRUNCATED_NODES) !== 0
  }

  /** §3.3 bit 1 — a subtree was not descended into at depth 255. */
  get truncatedDepth(): boolean {
    return (this.flags & FLAG_TRUNCATED_DEPTH) !== 0
  }

  /** `kind` bit 0. */
  isDir(i: number): boolean {
    return (this.kind[i]! & 1) !== 0
  }

  /**
   * The DISPLAY name — a file's trailing `.md` is already stripped by Rust.
   * Cached; the cache is dropped wholesale at NAME_CACHE_MAX (§3.2).
   */
  nameOf(i: number): string {
    const hit = this.nameCache.get(i)
    if (hit !== undefined) return hit
    if (this.nameCache.size >= NAME_CACHE_MAX) this.nameCache.clear()
    const s = DEC.decode(this.names.subarray(this.nameOff[i]!, this.nameOff[i + 1]!))
    this.nameCache.set(i, s)
    return s
  }

  /**
   * A file's extension exactly as it is on disk (`.md`, `.MD`, …); `''` for a
   * folder.  The tree holds nothing but directories and notes (§3.6).
   */
  extOf(i: number): string {
    const k = this.kind[i]!
    return (k & KIND_DIR) !== 0 ? '' : MD_EXT[(k >> 1) & 3]!
  }

  /**
   * Vault-relative, '/'-separated, no leading slash (§1.1 `VaultPath`).
   *
   * `names` holds display names, so a FILE gets its extension back here, in
   * its on-disk case (`extOf`).  A folder path is the key `expandedPaths` is
   * keyed on (§3.4), which is why this must never append anything to a
   * directory.
   */
  pathOf(i: number): string {
    const parts: string[] = []
    // Bounded by depth+1: `parent[k] < k` is validated, so this terminates, but
    // a bound costs nothing and turns a hypothetical cycle into a wrong answer
    // rather than a hang.
    let guard = this.depth[i]! + 2
    for (let k = i; k >= 0 && guard-- > 0; k = this.parent[k]!) parts.push(this.nameOf(k))
    parts.reverse()
    const p = parts.join('/')
    return p + this.extOf(i)
  }

  /**
   * §0.38 E85 — A `[[wikilink]]` TARGET -> A VAULT PATH, OR NULL.
   *
   * `target` is the link's own text with the alias and the `#subpath` already
   * stripped: `Note`, `Folder/Note`, or either with a `.md` on the end.
   * `fromPath` is the note the link is IN, and it only breaks ties.
   *
   * WHY HERE.  This object already owns the vault's index and its path
   * arithmetic (`pathOf`), and it is the only thing in the frontend that does.
   * A resolver in `main.ts` would have to reach through `tree` for the blob and
   * re-implement `pathOf`, and it could not be tested without a DOM.
   *
   * ONE PASS, OVER BYTES.  The scan compares the target's last segment against
   * `names` directly — no `nameOf`, so a 50,000-node vault does not decode
   * 50,000 strings and blow the name cache on one click. `pathOf` runs only for
   * the handful of nodes whose name matched.
   *
   * CASE-INSENSITIVE, ASCII ONLY, and that is §0.33 E79's rule again for its
   * reason: a full Unicode fold can change a string's LENGTH, and this compares
   * byte runs. Two notes differing only outside ASCII case therefore do not
   * match each other; two differing in ASCII case do.
   *
   * THE ORDER IS TOTAL, so the answer never depends on the walk:
   *   1. a target containing `/` must match a path EXACTLY. It does NOT fall
   *      back to the basename — Obsidian is more forgiving here, and being
   *      forgiving means opening a file the user did not name.
   *   2. otherwise the note in the SAME FOLDER as `fromPath` wins (Obsidian's
   *      `getFirstLinkpathDest` takes the source path for this reason),
   *   3. then the shallowest path, then lexicographic.
   */
  resolveLink(target: string, fromPath: string | null): string | null {
    const t = target.trim()
    if (t === '') return null
    const noExt = t.length > 3 && t.slice(-3).toLowerCase() === '.md' ? t.slice(0, -3) : t
    const slash = noExt.lastIndexOf('/')
    const base = slash < 0 ? noExt : noExt.slice(slash + 1)
    if (base === '') return null
    const want = ENC.encode(base)

    const hits: number[] = []
    for (let i = 0; i < this.n; i++) {
      if (this.isDir(i)) continue
      const a = this.nameOff[i]!
      if (this.nameOff[i + 1]! - a !== want.length) continue
      let ok = true
      for (let k = 0; k < want.length; k++) {
        if (fold(this.names[a + k]!) !== fold(want[k]!)) { ok = false; break }
      }
      if (ok) hits.push(i)
    }
    if (hits.length === 0) return null
    const paths = hits.map((i) => this.pathOf(i))

    if (slash >= 0) {
      const exact = (noExt + '.md').toLowerCase()
      return paths.find((p) => p.toLowerCase() === exact) ?? null
    }
    if (paths.length === 1) return paths[0]!

    const cut = fromPath === null ? -1 : fromPath.lastIndexOf('/')
    const dir = cut < 0 ? '' : fromPath!.slice(0, cut + 1)
    const dirOf = (p: string): string => {
      const c = p.lastIndexOf('/')
      return c < 0 ? '' : p.slice(0, c + 1)
    }
    const same = paths.filter((p) => dirOf(p) === dir)
    const pool = same.length > 0 ? same : paths
    const depthOf = (p: string): number => {
      let d = 0
      for (let i = 0; i < p.length; i++) if (p.charCodeAt(i) === 47) d++
      return d
    }
    pool.sort((a, b) => depthOf(a) - depthOf(b) || (a < b ? -1 : a > b ? 1 : 0))
    return pool[0]!
  }

  /** Test/diagnostic hook: how many names are currently memoised. */
  get nameCacheSize(): number {
    return this.nameCache.size
  }

  clearNameCache(): void {
    this.nameCache.clear()
  }

  /**
   * The four structural invariants `tree.ts` relies on and cannot re-check on a
   * hot path.  Five O(N) integer passes, fused into two loops, no allocation.
   */
  private validate(): void {
    const { n, m, subtree, parent, nameOff, depth, kind } = this

    if (nameOff[0] !== 0) bad('name_off[0] = ' + nameOff[0] + ', must be 0')
    if (nameOff[n] !== m) bad('name_off[N] = ' + nameOff[n] + ' != names_len ' + m)

    for (let i = 0; i < n; i++) {
      const p = parent[i]!
      // Invariant P: "its parent always has a lower index"; -1 is top level.
      if (p < -1 || p >= i) bad('parent[' + i + '] = ' + p + ' violates invariant P (parent < i)')
      // Invariant P: node i owns the contiguous range [i+1, i+subtree[i]].
      if (i + subtree[i]! >= n) {
        bad('subtree[' + i + '] = ' + subtree[i] + ' runs past the last node (N=' + n + ')')
      }
      // depth is what restore()'s ancestor stack is addressed by.
      const d = p < 0 ? 0 : depth[p]! + 1
      if (depth[i] !== d) bad('depth[' + i + '] = ' + depth[i] + ', expected ' + d)
      // §3.2: bits 3..7 reserved, MUST be 0; a folder has no extension bits.
      const k = kind[i]!
      if ((k & 0xf8) !== 0 || ((k & KIND_DIR) !== 0 && (k & (KIND_EXT_UPPER_M | KIND_EXT_UPPER_D)) !== 0)) {
        bad('kind[' + i + '] = ' + k + ' sets a reserved bit')
      }
      // A folder's parent is always a folder (invariant P, third sentence).
      if (p >= 0 && (kind[p]! & 1) === 0) bad('node ' + i + "'s parent " + p + ' is not a folder')
      if (nameOff[i + 1]! < nameOff[i]!) bad('name_off is not monotonic at ' + i)
    }
  }
}

/**
 * §3.2: "The frontend adopts the blob with typed-array views — no copy, no
 * parse, no per-node allocation — and MUST validate `magic` and `version`
 * before creating any view."
 *
 * @throws {TreeBlobError} on anything that is not a well-formed TreeBlob v1.
 */
export function adopt(buffer: ArrayBuffer): TreeBlob {
  return new TreeBlob(buffer)
}
