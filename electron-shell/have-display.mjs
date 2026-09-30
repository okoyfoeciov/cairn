/**
 * electron-shell/have-display.mjs -- "can Electron map a window here?"
 *
 * ONE PREDICATE, ONE FILE, BECAUSE THERE WERE FIVE COPIES AND ALL FIVE WERE
 * WRONG THE SAME WAY.  Every Electron suite in this directory guarded itself
 * with, verbatim:
 *
 *     !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY
 *
 * which asks whether an X11 or Wayland server is reachable.  On macOS neither
 * variable is ever set and neither ever will be -- the window server is Quartz,
 * and Electron maps windows there with no environment variable at all.  So the
 * guard was not "no display", it was "not Linux" wearing a display check's
 * clothes, and on the first macOS run it skipped 16 tests that all pass:
 *
 *     lifecycle       5 skipped   (⌘Q through the ✕'s function, single-instance,
 *                                  §0.7 E9's sidebar width -- ⌘Q is macOS's key
 *                                  and macOS is where it had never been run)
 *     window-control  6 skipped
 *     g10-harness     5 skipped
 *
 * THE g10-harness ONE IS THE EXPENSIVE ONE.  §8.2 step 9 is the open gate that
 * "matters now", `docs/DO-THIS-NEXT.md` says the comparison "has to happen on
 * the Mac" because the reference is a macOS capture and Linux has no SF Pro --
 * and the harness for it could not run on a Mac.  It was green on Debian, where
 * its verdict is meaningless, and skipped on the one machine that can produce a
 * verdict at all.
 *
 * THIS IS THE SAME DEFECT CLASS CLAUDE.md §0.20.6.1 RECORDS TWICE ALREADY --
 * `__PIXELTEST__` nested inside a `platform === 'linux'` check, so gate G9 could
 * never have run on macOS; and a test grepping the Tauri source while the app
 * ran on `app-main.mjs`.  Both were green.  A skip is a third kind of green: it
 * is not a pass, but nothing in a summary line distinguishes "16 skipped" from
 * "16 that cannot fail here", and no CI run on one platform ever will.
 *
 * NOT `process.platform !== 'linux'` INVERTED.  The Linux arm still has to be a
 * real check -- a headless Debian box genuinely cannot map a window, which is
 * why the guard existed -- so the predicate is per platform, and darwin's arm
 * is a constant because on darwin the answer is a constant.
 */

/** True when Electron can map a real window in this process's environment. */
export const HAVE_DISPLAY =
  process.platform === 'darwin'
    ? true
    : Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)

/** The skip reason, or `false` when a window can be mapped. Shaped to drop
 *  straight into the `SKIP` ternaries these suites already use. */
export const NO_DISPLAY = HAVE_DISPLAY
  ? false
  : 'no DISPLAY or WAYLAND_DISPLAY -- Electron cannot map a window'
