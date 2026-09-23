#!/usr/bin/env bash
# Owner: 07.  MANDATORY after every mac package (`npm run package:mac`).
# CONTRACT.md §6.4 (X9-build), spec-07 §6.3.
#
# WHAT THE BUNDLER EMITS IS NOT SIGNED IN ANY USEFUL SENSE.  It is only
# *linker*-signed: `CodeDirectory flags=0x20002(adhoc,linker-signed)`,
# `Info.plist=not bound`, `Sealed Resources=none`, and it FAILS
# `codesign --verify --strict`.  `hardenedRuntime: true` is inert without this
# script.
#
# ============== AD-HOC (`codesign -s -`) IS THE PERMANENT ANSWER ==============
# DO NOT "UPGRADE" THIS SCRIPT TO A DEVELOPER ID FLOW.  Cairn is never
# distributed -- not through the App Store, not through any store, not to
# anyone.  The user builds it, packages it, and installs it on machines they
# own.  That is a standing decision, not a v1 shortcut, so:
#
#   * There is no notarisation step here and there never will be one.  No
#     `xcrun notarytool`, no `stapler`, no `signingIdentity` in
#     tauri.macos.conf.json.  Notarisation is not deferred work; it is work
#     this project does not have.
#   * A Developer ID certificate would cost a $99/year Apple Developer Program
#     membership and would buy exactly one thing this project uses: a code
#     identity that is stable across rebuilds (see the TCC note below).  It
#     would buy nothing else, because the only Gatekeeper behaviour it changes
#     is the behaviour of a DOWNLOADED copy -- and no copy of this app is ever
#     downloaded.
#   * `spctl -a -t exec` will report `rejected` for this app forever.  That is
#     expected and is not a defect to chase.  Gatekeeper only gates files
#     carrying the `com.apple.quarantine` xattr, which only a downloading agent
#     (browser, Mail, AirDrop, Messages) sets.  A locally built .app has no such
#     xattr and launches with no dialog at all -- measured, spike C §5.3 case A.
#   * `--options runtime` (the hardened runtime) stays.  ~~It costs nothing~~ --
#     CORRECTED 2026-09-09, ON FIRST CONTACT WITH macOS: it costs the launch.
#     The hardened runtime turns on LIBRARY VALIDATION, ad-hoc signatures carry
#     no Team ID, and dyld reads two absent Team IDs as different ones, so the
#     .app died at image load with `Library not loaded: @rpath/Electron
#     Framework.framework/Electron Framework`.  `tools/cairn.entitlements` is
#     the fix and that file carries the whole diagnosis.  The flags still read
#     `0x10002(adhoc,runtime)` instead of `0x2(adhoc)`, and it is still NOT here
#     as groundwork for notarisation -- but "costs nothing" was a derivation and
#     it was wrong.
# =============================================================================
#
# ===================== THE ORDER IS THE CORRECTION ==========================
# The .dmg is built FROM the .app, so it must be built from the SIGNED one:
# packaging first and signing the .app afterwards leaves a signed .app sitting
# next to a .dmg that still contains the unsigned one.  (In the Tauri era the
# failure mode was sharper -- a dmg-only rebuild DELETED the .app, measured --
# but the ordering lesson is the same under hdiutil.)  So this script does all
# four steps itself, in order:
#
#   1  codesign the .app
#   2  build the .dmg from the SIGNED .app with hdiutil
#   3  codesign the .dmg
#   4  verify BOTH -- and verify INSIDE the .dmg, not beside it.  Step 4 is the
#      one that would have caught the original defect: verifying the .app on
#      disk PASSES while the shipped artifact still carries linker-signed.
#      A linker-signed CodeDirectory inside the .dmg is a RELEASE BLOCKER.
#
# Rebundling by ANY route destroys the signature, so nothing may rebuild or
# repackage after step 1 without repeating all four.
# ============================================================================
#
# Driven by hand after the packager, in this order:
#   npm run package:mac && bash tools/sign-macos.sh out/darwin-<arch>
# ONE invocation signs both artifacts -- there is no app-only path, because
# step 4's inside-the-.dmg check is the verdict and it needs the .dmg.
#
# THE ONE REAL COST OF AD-HOC, AND IT IS NOT GOING AWAY.  The build is NOT
# reproducible (`touch src/lib.rs` with no source change yields a different
# binary) and the ad-hoc designated requirement is a bare `cdhash`, so every
# rebuild is a NEW CODE IDENTITY to the system.  TCC keys its grants to that
# identity, so **Files-and-Folders access is RE-PROMPTED after every rebuild**
# once the vault sits in ~/Documents, ~/Desktop, iCloud Drive or an external
# volume.  This is real and it is the thing that will actually annoy whoever
# uses this.  Only a stable designated requirement -- i.e. a Developer ID
# certificate, whose DR is `identifier ... and certificate leaf[subject.OU] =
# TEAMID` -- would stop it, and buying one is not on the table.  Two ways to
# live with it instead: keep the vault outside the TCC-protected locations
# (e.g. ~/Vaults), or rebuild less often.
#
# (The same rebuild-changes-identity fact also means a Gatekeeper "Open Anyway"
# approval would not carry over.  That is a downloaded-copy concern and does not
# arise here; see the ad-hoc block above.)
set -euo pipefail

BUNDLE="${1:-out/darwin-arm64}"
# Absolute, because step 2 resolves the .dmg beside it and a relative .app
# path would resolve against the wrong root.
BUNDLE="$(cd "$BUNDLE" 2>/dev/null && pwd || echo "$BUNDLE")"
APP="$BUNDLE/macos/Cairn.app"
[ -d "$APP" ] || { echo "no bundle at $APP -- run: npm run package:mac" >&2; exit 1; }

# ============================================================================
# 1. SIGN THE NESTED CODE FIRST, DEEPEST FIRST, THEN THE OUTER BUNDLE.
#
# THIS BLOCK IS NEW AND HAS NEVER RUN (2026-09-08).  It exists because the app
# this script signs CHANGED: a Tauri .app had one Mach-O and no nested bundles,
# so `codesign "$APP"` was the whole job.  An ELECTRON .app has three helper
# apps and a framework inside `Contents/Frameworks`, and macOS refuses to launch
# a bundle whose nested code is unsigned -- with "code signature invalid", which
# reads like a corrupt download rather than a missing step.
#
# Deepest first is not a preference: signing a container SEALS its contents, so
# anything signed afterwards invalidates the seal above it.  `--force` because
# Electron's prebuilt frameworks arrive carrying Apple's own signature, which
# has to be replaced rather than added to.
#
# `--options runtime` on the nested code too: the hardened runtime is a property
# of each signature, and a helper without it can be refused while the outer app
# is fine -- which looks like the app crashing on startup for no reason.
#
# UNVERIFIED.  Nothing in this project has executed on macOS since the port.
# If it fails, the message it prints is the thing to send back.
# ============================================================================
# ======================= K7 IS ANSWERED, AND IT WAS "NO" ====================
# §8.3 K7 asked whether an ad-hoc signature launches on Apple Silicon under the
# hardened runtime.  MEASURED 2026-09-09, the first time this project ever ran
# on macOS: it does not.  The .app signed and verified clean -- `valid on disk`,
# `satisfies its Designated Requirement`, flags `0x10002(adhoc,runtime)` -- and
# then died at image load before a single line of Cairn ran:
#
#     dyld: Library not loaded: @rpath/Electron Framework.framework/Electron Framework
#     Reason: ... not valid for use in process:
#             mapping process and mapped file (non-platform) have different Team IDs
#
# THE CAUSE IS STRUCTURAL, NOT A SIGNING MISTAKE.  The hardened runtime turns on
# library validation, which demands every loaded image be a platform binary or
# carry the process's own Team ID.  An ad-hoc signature has no Team ID at all --
# `TeamIdentifier=not set` on both sides -- and the check reads two absent
# identifiers as two different ones.  No signing order, no `--deep`, and no
# amount of re-signing reaches it: ad-hoc and library validation are mutually
# exclusive by construction.  §9 E5 pins ad-hoc, so the entitlement is the only
# arm that moves.
#
# NOTE WHAT VERIFIED GREEN THROUGH ALL OF THIS.  Step 4 below passed -- strict,
# deep, inside-the-artifact -- on a bundle that could not start.  `codesign
# --verify` answers "is this signature well formed", never "will this run", and
# this script's own success line was one step short of the truth for exactly as
# long as nobody launched the thing.  Same shape as CLAUDE.md §0.20.6.1's two
# green tests on code that was not running.  Step 5 is `open` it, and it is not
# optional.
# ============================================================================
ENTITLEMENTS="$(cd "$(dirname "$0")" && pwd)/cairn.entitlements"
[ -f "$ENTITLEMENTS" ] || { echo "FAIL: no $ENTITLEMENTS -- the app will not launch (K7)" >&2; exit 1; }
# `--entitlements` ON EVERY IMAGE, not only the outer .app.  Library validation
# is judged per loading process, and each Electron helper is its own process:
# the renderer maps the same framework the main process does, so an outer-only
# entitlement launches the app and then loses the window.  Measured cheaper to
# apply uniformly than to reason about which helper loads what.
sign_one() { codesign -s - --force --options runtime --timestamp=none --entitlements "$ENTITLEMENTS" "$1"; }

NESTED=0
if [ -d "$APP/Contents/Frameworks" ]; then
  # Sort by path DEPTH descending, so `.../Versions/A/Helpers/chrome_crashpad`
  # is signed before `Electron Framework.framework`, which is signed before the
  # helper .apps, which are signed before "$APP" below.
  #
  # THE DEPTH IS COUNTED IN BASH, AND THAT IS A CORRECTION -- MEASURED ON THE
  # FIRST macOS RUN, 2026-09-09.  This was an `xargs -0 -I{} sh -c` pipeline,
  # and BSD xargs refused it outright:
  #
  #     xargs: command line cannot be assembled, too long
  #
  # `-I` gives BSD xargs a 255-byte replacement budget per line, and
  # `Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/
  # libGLESv2.dylib` under an absolute $APP does not fit.  THE FAILURE IS
  # SILENT WHERE IT MATTERS: xargs writes to stderr and the pipeline still
  # exits 0 with an EMPTY stdout, so the loop ran zero times, printed
  # `signed 0 nested bundle(s)` as though there were none to sign, and left
  # the outer codesign to fail with `code has no resources but signature
  # indicates they must be present / In subcomponent: Electron Helper.app`
  # -- an error that names the symptom three steps downstream of the cause.
  # `set -o pipefail` would not have caught it either, because xargs exits 0.
  #
  # Hence: NUL all the way through, depth from bash's own `${x//[^\/]/}`, and
  # a temp file rather than a pipe so that $NESTED survives the loop (a piped
  # `while` runs in a subshell and its increments are discarded -- which would
  # have printed `signed 0` again, for a completely different reason).
  LIST="$(mktemp)"
  trap 'rm -f "$LIST"' EXIT
  while IFS= read -r -d '' target; do
    slashes="${target//[^\/]/}"
    printf '%s\t%s\0' "${#slashes}" "$target"
  done < <(
    find "$APP/Contents/Frameworks" \
         \( -name '*.app' -o -name '*.framework' -o -name '*.dylib' \) -print0 2>/dev/null
  ) | sort -z -rn > "$LIST"

  while IFS= read -r -d '' line; do
    target="${line#*$'\t'}"
    [ -n "$target" ] || continue
    sign_one "$target" || { echo "FAIL: could not sign nested code: $target" >&2; exit 1; }
    NESTED=$((NESTED + 1))
  done < "$LIST"
fi
echo "signed $NESTED nested bundle(s) inside Contents/Frameworks"

# 1a-bis. THE ADDON.  `cairn.node` is a Mach-O that the main process `dlopen`s,
# and it lives in Contents/Resources/app, NOT in Contents/Frameworks -- so the
# sweep above cannot see it and the outer bundle would seal it as an inert
# RESOURCE.  Under `--options runtime` that is not a cosmetic difference:
# library validation is a hardened-runtime feature, it applies to every image
# the process loads, and it judges the image's OWN signature.  The addon
# arrives carrying the linker's (`flags=0x20002 adhoc,linker-signed`), which is
# a different code identity from the one this script gives the app.
#
# It is signed here rather than left to `--deep` because `--deep` is documented
# by Apple as a repair tool and not a signing strategy, and because the failure
# it prevents -- `dlopen` refused at launch -- reads as "the app opens and
# immediately shows an error", i.e. exactly the K7 symptom this whole script
# exists to make legible.  Signed BEFORE the outer bundle, same as everything
# above: the seal has to cover the final bytes.
ADDON="$APP/Contents/Resources/app/electron-shell/cairn.node"
if [ -f "$ADDON" ]; then
  sign_one "$ADDON" || { echo "FAIL: could not sign the addon: $ADDON" >&2; exit 1; }
  echo "signed the napi addon (cairn.node)"
else
  echo "FAIL: no addon at $ADDON -- the package is incomplete" >&2
  exit 1
fi

# 1b. the outer .app, LAST, so its seal covers everything above.
sign_one "$APP"

# 2. build the .dmg FROM THE SIGNED .app with hdiutil.  The name matches the
# artifact this repo already ships: out/Cairn-<version>-<arch>.dmg, version
# from package.json, arch from the machine that built it.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VER="$(node -p "require('$ROOT/package.json').version")"
ARCH="$(uname -m)"
[ -n "$VER" ] && [ -n "$ARCH" ] || { echo "FAIL: cannot name the .dmg (empty version or arch)" >&2; exit 1; }
DMG="$(dirname "$BUNDLE")/Cairn-${VER}-${ARCH}.dmg"
# A stale mount from an interrupted run makes create fail, so detach first.
# The previous .dmg is overwritten, not kept: it was built from an older
# signature, and keeping it would ship exactly the staleness step 4 hunts.
hdiutil detach "/Volumes/Cairn" >/dev/null 2>&1 || true
hdiutil create -volname "Cairn" -srcfolder "$APP" -ov -format UDZO "$DMG" >/dev/null \
  || { echo "FAIL: hdiutil could not build $DMG from the signed .app" >&2; exit 1; }
# hdiutil can exit 0 having produced nothing useful.  Assert the artifact,
# because the failure this script exists to prevent is exactly "reported OK,
# shipped something else".
[ -f "$DMG" ] || { echo "FAIL: hdiutil did not produce $DMG" >&2; exit 1; }
# 3. sign the .dmg
codesign -s - --force "$DMG"

# 4. verify BOTH.
codesign --verify --strict --deep --verbose=2 "$APP"
codesign -dv --verbose=2 "$APP" 2>&1 | grep -E 'Identifier=|Signature=|Sealed Resources|CodeDirectory'
MNT=$(mktemp -d)
hdiutil attach -nobrowse -readonly -mountpoint "$MNT" "$DMG" >/dev/null
codesign --verify --strict --deep --verbose=2 "$MNT/Cairn.app" \
  || { hdiutil detach "$MNT" >/dev/null; echo "FAIL: unsigned .app inside the .dmg" >&2; exit 1; }
if codesign -dv --verbose=2 "$MNT/Cairn.app" 2>&1 | grep -q 'linker-signed'; then
  hdiutil detach "$MNT" >/dev/null
  echo "FAIL: linker-signed CodeDirectory inside the .dmg -- release blocker" >&2
  exit 1
fi
hdiutil detach "$MNT" >/dev/null

echo "OK: .app and .dmg ad-hoc signed and verified. Re-run after ANY rebuild."
