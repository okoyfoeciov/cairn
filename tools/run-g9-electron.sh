#!/usr/bin/env bash
# run-g9-electron.sh — take a real gate G9 verdict ON THE ELECTRON SHELL.
#
# WHY THIS EXISTS, SEPARATELY FROM run-g9.sh.
# `run-g9.sh` drives the Tauri/WebKitGTK binary, and on WebKitGTK gate G9 CANNOT
# go green: the engine floors the USED line box to an integer, so a 31.0656px
# title box measures 31 and EPS is 0.02.  That is not a Cairn defect and no
# retune fixes it — it is the engine, and the engine is being replaced.
# See CONTRACT §0.19 and docs/PENDING-USER-ACTIONS.md item 1.
#
# On Chromium the floor does not happen, so this is the runner that can actually
# reach a verdict.  It is the SAME probe (tools/verify-geometry.js), the SAME
# frontend path (chrome.ts's runGeometryProbe on the first rAF after
# nc://vault-opened, into ipc.ts's emitGeometryReport), and the SAME contract:
# one JSON line to stdout, exit 0 iff `ok`.
#
# WHAT DIFFERS FROM run-g9.sh, and it is not cosmetic:
#   This shell opens the vault EXPLICITLY from $CAIRN_VAULT rather than letting
#   the startup path restore it from state.json, so a seeded state file — which
#   is how run-g9.sh gets its expanded[] list — has nothing to read it at the
#   moment it is needed.  The fixture is seeded through CAIRN_PIXELTEST_EXPANDED
#   / _NOTE and command 17 instead, AFTER the open: `save_ui_state` keys
#   `expanded` by vault root and there is no root to key it to before then.
#   Eleven G9 checks live on tree rows at depth 1..3; a collapsed vault SKIPs
#   them, and a SKIP fails the run.
#
#   §8.2 step 5 made that seed WRITE A REAL FILE — `prefs.rs` is in the process
#   now, where the deleted JS backend kept UI state in memory — so app-main.mjs
#   gives a --pixeltest run a fresh temp state.json.  A gate run must not
#   rewrite the expansion set of the person running it (spike-M D1).
#
#   ./tools/run-g9-electron.sh          real G9: a 1920x964 window for ~20s, gate=TRUE
#   ./tools/run-g9-electron.sh --small  plumbing check only: 1000x700, gate=FALSE,
#                                       so NOT a G9 verdict — proves the rows run
set -euo pipefail
cd "$(dirname "$0")/.."

command -v node >/dev/null || { echo "node not found" >&2; exit 2; }
[ -x node_modules/.bin/electron ] || { echo "no electron; run: npm ci" >&2; exit 2; }

# BOTH ARTEFACTS ARE BUILT HERE, not by Electron.  Skipping either is how you
# measure yesterday's code with today's probe and believe the result — which is
# exactly what a stale `core/target/release/cairn` did on 2026-09-08,
# reproducing a two-day-old failure to the digit.
#
# The addon first: §8.2 step 5 put the real Rust core behind this shell and
# `app-main.mjs` refuses to start without `electron-shell/cairn.node`.  ~30 s
# from cold, ~0 warm.
echo "== building the native addon =="
node electron-shell/build-native.mjs

echo "== building the frontend bundle =="
node electron-shell/build-app.mjs

WORK=$(mktemp -d "${TMPDIR:-/tmp}/cairn-g9e-XXXXXX")
trap 'rm -rf "$WORK"' EXIT
V="$WORK/vault"; mkdir -p "$V"
V=$(cd "$V" && pwd -P)

# §5.11's fixture, byte-identical to run-g9.sh's: a folder at depth 0 expanded,
# a folder AND a file at depth 1, a folder at depth 2, a file at depth 3.  The
# note opened must NOT begin with a heading — §5.4.2 renders the inline title
# AND a leading H1, which would move every row the title rows assert.
mkdir -p "$V/Projects/Alpha/Deep"
printf 'Body line one, deliberately not a heading.\n\n## A second-level heading\n\nplain body text\n\n```sh\necho hi\n```\n' > "$V/Projects/guide.md"
printf 'depth-1 file\n' > "$V/Projects/notes.md"
printf 'depth-3 file\n'  > "$V/Projects/Alpha/Deep/leaf.md"
printf 'root file\n'     > "$V/root.md"

export CAIRN_PIXELTEST=1
export CAIRN_VAULT="$V"
export CAIRN_PIXELTEST_EXPANDED="Projects,Projects/Alpha,Projects/Alpha/Deep"
export CAIRN_PIXELTEST_NOTE="Projects/guide.md"


if [ "${1:-}" = "--small" ]; then
  export CAIRN_ELECTRON_GEOM=1000x700
  export CAIRN_PIXELTEST_GATE=0
  echo "== gate G9 (ELECTRON) ==  vault=$V"
  echo "   --small: 1000x700, gate=FALSE — plumbing check, NOT a verdict"
else
  echo "== gate G9 (ELECTRON) ==  vault=$V  expanded=[Projects, Projects/Alpha, Projects/Alpha/Deep]"
  echo "   1920x964 centred for ~20s, gate=TRUE"
fi

set +e; OUT=$(node_modules/.bin/electron electron-shell/app-main.mjs 2>&1); RC=$?; set -e
echo "$OUT" | grep -v '^{' || true
JSON=$(echo "$OUT" | grep '^{' | tail -1)
if [ -n "$JSON" ]; then
  printf '%s' "$JSON" > "$WORK/report.json"
  python3 - "$WORK/report.json" <<'PY'
import json, sys
r = json.load(open(sys.argv[1]))
print()
if r.get("error"):
    print("  ERROR: %s" % r["error"])
print("  rows %s  checks %s  pass %s  FAIL %s  SKIP %s"
      % (r.get("rows"), r.get("checks"), r.get("pass"), r.get("fail"), r.get("skip")))
print("  gate=%s  ok=%s  inner=%s  dpr=%s"
      % (r.get("gate"), r.get("ok"), r.get("inner"), r.get("dpr")))
# A dpr other than 1 makes hairline rows fail for the COMPOSITOR's reasons.
# Say so here rather than letting the reader diagnose four failures twice.
# The gate runs at ANY display scale. It states its comparison on the device
# grid the engine actually renders on, so a fractional scale is a REPORTED
# CONDITION and not a failure. Say which rules admitted the run, because a green
# run at dpr 1.25 leaned on a looser rule than a green run at dpr 1 and must
# never be quoted as if it had not.
if not r.get("integerScale", True):
    print()
    print("  note: dpr is %s (a FRACTIONAL scale), so the tolerance is one device" % r.get("dpr"))
    print("        pixel + EPS = %.4g CSS px instead of %s." % (r.get("tolerance", 0), 0.02))
    print("        Chromium snaps a USED border box to whole device pixels, so a 1px")
    print("        rule measures %.4g here and no integer CSS px is representable." % (1.0 / float(r["dpr"])))
    print("        At dpr 1 or 2 the tolerance is EPS and the gate is unchanged.")
    loose = [x for x in r.get("results", []) if x.get("via") == "device-px"]
    print("        %s row(s) needed the loose rule; the rest were exact or exact-after-snap."
          % len(loose))
    # NAME THEM. "4 rows needed the loose rule" is unfalsifiable; these four are
    # the only part of a green run that a run at dpr 1 would have held to a
    # tighter standard, so they are the part a reader must be able to check.
    for x in loose:
        print("          - %s | %s | want %r got %r  (delta %+.4g)"
              % (x["row"], x["check"], x["expect"], x["got"], x["got"] - x["expect"]))
print()
for x in r.get("results", []):
    st = x.get("status")
    if st == "FAIL":
        # The probe's field is `check` (verify-geometry.js:1025-1038). Both
        # printers read `name`, which the report has never carried, so every
        # FAIL line has printed an empty middle field since these were written.
        print("    [FAIL] %s | %s | expect %r got %r"
              % (x.get("row", "?"), x.get("check", ""), x.get("expect"), x.get("got")))
    elif st == "SKIP":
        print("    [SKIP] %s | %s%s" % (x.get("row", "?"), x.get("check", ""),
                                        "  (" + x["note"] + ")" if x.get("note") else ""))
PY
else
  echo "  no JSON report was printed - the probe never ran (see output above)"
fi
echo
echo "exit=$RC   (0 = G9 PASS; anything else = not green)"
exit $RC
