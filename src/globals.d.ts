/**
 * src/globals.d.ts
 * Owner: 07.  Spec: spec-07 §5.2 / CONTRACT.md §6.3.
 */

interface Window {
  /** Set by core/src/main.rs's initialization script under `--pixeltest`
   *  ONLY (CONTRACT §5.11).  In a normal launch neither this flag nor
   *  tools/verify-geometry.js exists, so the probe cannot cost a byte of the
   *  shipped bundle — build.mjs never bundles it. */
  __PIXELTEST__?: boolean
  /** Harness-only, set alongside __PIXELTEST__ by main.rs.  `false` runs the
   *  probe in non-gate mode, which SKIPS the gate-only checks instead of failing
   *  them against a window size the gate was never written for.  Absent (and so
   *  `!== false`) on the contract path. */
  __PIXELTEST_GATE__?: boolean
  /** Installed by tools/verify-geometry.js when, and only when, the probe is
   *  injected.  `.ok` is gate G9: 0 failures AND 0 skips. */
  __verifyGeometry?: (opts?: { gate?: boolean; emit?: 'ipc'; allowSkip?: boolean }) => unknown
  /** §0.5 E7.  Set by lib.rs's initialization script on LINUX ONLY, where it is
   *  `'linux'`; absent everywhere else, including macOS, every test harness and
   *  a plain browser.  chrome.ts's `applyPlatform()` reads it once at boot and
   *  index.html's `data-os="macos"` stands when it is absent.
   *
   *  It is a compiled-in fact, not a `navigator.userAgent` sniff, and that is
   *  deliberate: on Linux the window is UNDECORATED, so if the page guessed
   *  wrong it would draw no window controls over a frame that has none either
   *  and the user could not close the app.  A guess is not good enough for
   *  that; `#[cfg(target_os = "linux")]` cannot be wrong. */
  __CAIRN_OS__?: 'linux'
  /** §0.7 E9.  The persisted sidebar width in px, injected by lib.rs's
   *  initialization script — the same seam as `__CAIRN_OS__` and for the same
   *  reason: it has to be in the page BEFORE the first frame, or the sidebar
   *  renders at 412 and jumps.
   *
   *  ABSENT under `--pixeltest`, deliberately: gate G9 measures the sidebar at
   *  412 and eight x-coordinates derived from it, and a width the user dragged
   *  to yesterday must not decide whether the gate passes today.
   *
   *  It is NOT trusted as-is. `applyPlatform`'s neighbour clamps it against the
   *  live `innerWidth`, so a width saved on a wide monitor cannot squeeze the
   *  editor to nothing on a narrow one. */
  __CAIRN_SIDEBAR_W__?: number
  }
