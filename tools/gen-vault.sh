#!/bin/bash
# tools/gen-vault.sh -- deterministic synthetic vault generator.  Owner: 06.
#
# Produces the fixture vaults every measured number in the project is defined
# against:
#
#   * the MEMORY fixture (spec-06 §9.1, spike-A §6, spike-L2 §0) -- the default
#     shape, 5,000 notes in 620 folders at seed 1, 10,059,538 B of markdown.
#     THAT BYTE TOTAL IS A RECORDED MEASUREMENT IN TWO SPIKES.  The default path
#     below is therefore byte-for-byte frozen: no sizing flag means no scaling,
#     no calibration, and the identical stream of pseudo-random draws this
#     script has always made.  Regenerating the default must reproduce
#     10,059,538 B exactly, and `--verify` is what catches it if it ever stops.
#
#   * the SEARCH fixtures (spec-05 §2.1, CONTRACT §4.4) -- Corpus A, 5,000 notes
#     at a ~2,054 B mean (10.27 MB), and Corpus B, 5,000 notes at a ~5,107 B
#     mean (25.53 MB).  Corpus B is why `--mean-bytes` exists: the mean used to
#     be hard-coded in the awk body, so `--notes 12500` bought 25 MB of the
#     WRONG SHAPE -- 12,500 small files rather than 5,000 large ones -- and the
#     25 MB half of §4.4 was not reproducible from this repo at all.
#
# Deterministic: the same flags and the same --seed always produce byte-identical
# output, so a regression run is comparable to the baseline it is diffed against.
# Every decision draws from the script's own 32-bit LCG; awk's rand() is not
# portable between implementations and is never used.
#
# Usage:
#   gen-vault.sh <dir> [--notes N] [--folders F] [--seed S] [SIZE] [--force]
#   gen-vault.sh <dir> --verify
#
#   SIZE is at most two of:
#     --mean-bytes B     target mean note size in bytes (calibrated, see below)
#     --total-bytes T    target total markdown size in bytes
#     --total-mb M       the same, in MiB (M * 1048576)
#
#   --force                             rebuild <dir>.  Only ever deletes a
#                                       directory this tool generated (it has a
#                                       .vault-manifest); anything else is refused
#
#   --notes with --mean-bytes           -> total follows
#   --notes with --total-*              -> mean = total / notes
#   --mean-bytes with --total-*         -> notes = round(total / mean)
#   all three at once                   -> refused, it is over-determined
#   no SIZE flag at all                 -> the frozen default shape above
#
# HOW --mean-bytes IS HIT.  The note body is built from sections, paragraphs and
# words; a target mean is reached by scaling the section count and the words per
# paragraph, then CALIBRATING -- the generator dry-runs the whole corpus against
# the same seed, measures the mean it actually produced, corrects the two scale
# factors and repeats until it is within 0.2% or it runs out of iterations.  The
# dry runs consume and then rewind the LCG, so the vault that is finally written
# is exactly the vault the last calibration pass measured.  The achieved mean is
# printed and stored in the manifest: this tool never reports a target it did not
# hit.
#
# --verify re-reads the manifest written at generation time and asserts the vault
# on disk still matches it.  The measurement harness calls this first; a mutated
# vault silently changes every number it feeds.
set -euo pipefail

# Portable file sizes.  BSD `stat -f%z` does not exist on GNU coreutils and GNU
# `stat -c%s` does not exist on BSD, so every size goes through `wc -c`, which
# both have.  `sum_bytes` reads a NUL-delimited file list on stdin and filters
# `wc -c`'s per-invocation `total` lines (xargs may invoke it more than once);
# no corpus filename is ever `total`, and an empty list sums to 0 either way.
sum_bytes() { xargs -0 wc -c | awk '$2 != "total" {s+=$1} END{print s+0}'; }
file_bytes() { wc -c < "$1" | tr -d ' '; }

usage() {
  sed -n '3,57p' "$0" | sed 's/^# \{0,1\}//'
}

DIR=""; NOTES=5000; FOLDERS=620; SEED=1; FORCE=0; VERIFY=0
NOTES_SET=0; MEAN=""; TOTAL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --notes)       NOTES="$2"; NOTES_SET=1; shift 2 ;;
    --folders)     FOLDERS="$2"; shift 2 ;;
    --seed)        SEED="$2";    shift 2 ;;
    --mean-bytes)  MEAN="$2";    shift 2 ;;
    --total-bytes) TOTAL="$2";   shift 2 ;;
    --total-mb)    TOTAL=$(awk -v m="$2" 'BEGIN{printf "%.0f", m*1048576}'); shift 2 ;;
    --force)       FORCE=1;      shift ;;
    --verify)      VERIFY=1;     shift ;;
    -h|--help)     usage; exit 0 ;;
    -*) echo "gen-vault: unknown flag $1" >&2; exit 2 ;;
    *)  DIR="$1"; shift ;;
  esac
done
[ -n "$DIR" ] || { usage >&2; exit 2; }

MANIFEST="$DIR/.vault-manifest"

if [ "$VERIFY" = 1 ]; then
  [ -f "$MANIFEST" ] || { echo "gen-vault --verify: no manifest at $MANIFEST" >&2; exit 3; }
  # shellcheck disable=SC1090
  . "$MANIFEST"
  # M_NOTES / M_FOLDERS / M_BYTES MEAN THE CORPUS, AND ONLY THE CORPUS.
  n_md=$(find "$DIR" -type f -name '*.md' | wc -l | tr -d ' ')
  n_dir=$(find "$DIR" -mindepth 1 -type d | wc -l | tr -d ' ')
  bytes=$(find "$DIR" -type f -name '*.md' -print0 | sum_bytes)
  ok=1
  [ "$n_md"  = "$M_NOTES" ]   || { echo "gen-vault --verify: notes $n_md != $M_NOTES" >&2; ok=0; }
  [ "$n_dir" = "$M_FOLDERS" ] || { echo "gen-vault --verify: folders $n_dir != $M_FOLDERS" >&2; ok=0; }
  [ "$bytes" = "$M_BYTES" ]   || { echo "gen-vault --verify: bytes $bytes != $M_BYTES" >&2; ok=0; }

  [ "$ok" = 1 ] || exit 4
  # M_MEAN_ACTUAL is absent from manifests written before the sizing flags
  # landed; an older fixture still verifies, it just cannot print its mean.
  echo "gen-vault --verify: OK  notes=$n_md folders=$n_dir bytes=$bytes seed=$M_SEED mean=${M_MEAN_ACTUAL:-$(awk -v b="$bytes" -v n="$n_md" 'BEGIN{printf "%.1f", (n>0)?b/n:0}')}"
  exit 0
fi

# ------------------------------------------------------------- sizing ------
# Resolve --notes / --mean-bytes / --total-* into (NOTES, MEAN).  MEAN empty
# means "no target": the frozen default path, which must stay byte-identical.
if [ -n "$TOTAL" ] && [ -n "$MEAN" ] && [ "$NOTES_SET" = 1 ]; then
  echo "gen-vault: --notes, --mean-bytes and --total-* together are over-determined; drop one" >&2
  exit 2
fi
if [ -n "$TOTAL" ]; then
  case "$TOTAL" in ''|*[!0-9]*) echo "gen-vault: --total-* must be a positive integer of bytes" >&2; exit 2 ;; esac
  if [ -n "$MEAN" ]; then
    NOTES=$(awk -v t="$TOTAL" -v m="$MEAN" 'BEGIN{n=int(t/m+0.5); print (n<1)?1:n}')
  else
    MEAN=$(awk -v t="$TOTAL" -v n="$NOTES" 'BEGIN{printf "%.4f", t/n}')
  fi
fi
if [ -n "$MEAN" ]; then
  awk -v m="$MEAN" 'BEGIN{exit !(m+0 >= 80)}' || {
    echo "gen-vault: --mean-bytes $MEAN is below the ~80 B floor a note with a title, a heading and one line costs" >&2
    exit 2; }
fi
case "$NOTES"   in ''|*[!0-9]*) echo "gen-vault: --notes must be a positive integer" >&2; exit 2 ;; esac
case "$FOLDERS" in ''|*[!0-9]*) echo "gen-vault: --folders must be a positive integer" >&2; exit 2 ;; esac
[ "$NOTES" -ge 1 ] || { echo "gen-vault: --notes must be >= 1" >&2; exit 2; }

# --force deletes DIR, so it may only ever delete something this tool made: a
# directory with its manifest, one carrying the in-progress marker of an
# interrupted run, or an empty one.  Anything else is refused with or without
# --force, because a mistyped path can name a real vault.
PARTIAL="$DIR/.gen-vault-partial"
if [ -e "$DIR" ] && [ ! -f "$MANIFEST" ] && [ ! -f "$PARTIAL" ] &&
   ! { [ -d "$DIR" ] && [ -r "$DIR" ] && [ -z "$(ls -A "$DIR")" ]; }; then
  echo "gen-vault: $DIR exists and is not a gen-vault fixture (no .vault-manifest); refusing to touch it." >&2
  echo "gen-vault: pick a new path, or delete it yourself if you are sure it is disposable." >&2
  exit 5
fi
if [ -e "$DIR" ] && [ "$FORCE" != 1 ]; then
  if [ -f "$MANIFEST" ]; then
    # shellcheck disable=SC1090
    . "$MANIFEST"
    if [ "$M_NOTES" = "$NOTES" ] && [ "$M_FOLDERS" = "$FOLDERS" ] && [ "$M_SEED" = "$SEED" ] &&
       [ "${M_MEAN:-}" = "$MEAN" ]; then
      echo "gen-vault: $DIR already matches (notes=$NOTES folders=$FOLDERS seed=$SEED mean=${MEAN:-natural}); use --force to rebuild"
      exit 0
    fi
  fi
  echo "gen-vault: $DIR exists and does not match the requested shape; pass --force" >&2
  exit 5
fi
rm -rf "$DIR"; mkdir -p "$DIR"; : > "$PARTIAL"

# The body of the generator is awk: bash cannot write thousands of multi-KB
# files in a tolerable amount of time, and awk is in POSIX and on every box we
# target.  awk's own rand() is not portable between implementations, so the
# script carries its own 32-bit LCG -- this is what makes the output
# reproducible.
#
# `want` is the requested mean, or 0 for the frozen default.  When it is 0 the
# two scale factors are never consulted and not one extra draw is made, so the
# default vault is bit-for-bit the vault this script produced before the sizing
# flags existed.
awk -v dir="$DIR" -v notes="$NOTES" -v folders="$FOLDERS" -v seed="$SEED" -v want="${MEAN:-0}" -v out_stats="$DIR/.calib" '
function rnd() { s = (1103515245 * s + 12345) % 2147483648; return s / 2147483648 }
function ri(n) { return int(rnd() * n) }
function pick(arr, n) { return arr[ri(n)] }

# One note body.  THE ONLY PLACE A NOTE IS BUILT -- the calibration dry run and
# the real write call this same function, so what is calibrated is what is
# written.  When `want` is 0, `ssec` and `swrd` are never read and the draws are
# identical to the pre-sizing script.
function body(base,   out, title, nsec, k, npar, q, line, wc, w) {
  title = toupper(substr(base,1,1)) substr(base,2)
  gsub(/-/, " ", title)
  out = "# " title "\n\n"
  nsec = 2 + ri(5)
  if (want > 0) { nsec = int(nsec * ssec + 0.5); if (nsec < 1) nsec = 1 }
  for (k = 0; k < nsec; k++) {
    out = out "## " pick(topic, nt) " " pick(topic, nt) "\n\n"
    npar = 1 + ri(3)
    for (q = 0; q < npar; q++) {
      line = ""
      wc = 20 + ri(40)
      if (want > 0) { wc = int(wc * swrd + 0.5); if (wc < 3) wc = 3 }
      for (w = 0; w < wc; w++) line = line pick(word, nw) " "
      out = out line "\n\n"
    }
    if (rnd() < 0.22) {
      out = out "```rust\nfn " pick(topic, nt) "(n: usize) -> usize {\n    n * " (2 + ri(30)) "\n}\n```\n\n"
    }
    if (rnd() < 0.30) {
      for (q = 0; q < 3 + ri(4); q++) out = out "- " pick(word, nw) " " pick(word, nw) " " pick(word, nw) "\n"
      out = out "\n"
    }
  }
  return out
}

# One pass over the whole corpus.  write=0 is the calibration dry run: it makes
# exactly the draws the real pass will make, and the caller rewinds `s` around
# it, so measuring costs the LCG nothing.
function gen(write,   i, fi, base, f, txt, tot) {
  tot = 0
  for (i = 0; i < notes; i++) {
    # 4% of notes live at the vault root, the rest anywhere in the tree
    fi = (rnd() < 0.04) ? 0 : 1 + ri(nf - 1)
    base = pick(topic, nt) "-" pick(topic, nt) "-" (i+1)
    if (rnd() < 0.35) base = base "-" pick(seg, ns)          # widen the name-length spread
    f = (paths[fi] == "") ? dir "/" base ".md" : dir "/" paths[fi] "/" base ".md"
    txt = body(base)
    if (write) { printf "%s", txt > f; close(f) }
    tot += length(txt)
  }
  return tot
}

BEGIN {
  s = seed * 7919 + 17

  nt = split("architecture design api backend frontend release meeting retro standup research \
    spike incident postmortem onboarding roadmap pricing security latency caching schema migration \
    index parser renderer scheduler queue worker daemon protocol handshake benchmark profiling \
    budget invoice hiring interview offsite planning discovery interview-notes journal reading \
    ideas draft outline summary questions answers todo blockers decisions risks glossary", topic, /[ \t\n]+/)
  ns = split("engineering product design research ops platform infra data mobile web docs \
    archive inbox projects clients personal reference meetings 2023 2024 2025 q1 q2 q3 q4 \
    notes drafts specs rfcs vendors legal finance people team", seg, /[ \t\n]+/)
  nw = split("the system stores every note as a plain markdown file on disk so that any other \
    editor can open it without a migration step or a proprietary index sitting in the way of the \
    user and their own data which is the entire point of the exercise here and elsewhere too \
    memory footprint startup latency scroll performance and disk layout are the four numbers we \
    actually care about everything else is downstream of them in practice over a long horizon", word, /[ \t\n]+/)

  # --- folder tree: depths 1..4, weighted toward 2 and 3 -------------------
  nf = 0
  paths[nf++] = ""                       # vault root
  # depth 1
  d1 = int(folders * 0.06); if (d1 < 4) d1 = 4
  for (i = 0; i < d1; i++) { p = pick(seg, ns) "-" (i+1); paths[nf++] = p; l1[i] = p }
  # depth 2.  The `< 1` guards only bite below --folders 4 and below --folders 3
  # respectively; at 620 (the default) and at 5 (smoke.sh) they are no-ops.
  # Without them a level can be empty and every path below it starts with "/".
  d2 = int(folders * 0.30); if (d2 < 1) d2 = 1
  for (i = 0; i < d2; i++) { p = l1[ri(d1)] "/" pick(seg, ns) "-" (i+1); paths[nf++] = p; l2[i] = p }
  # depth 3
  d3 = int(folders * 0.42); if (d3 < 1) d3 = 1
  for (i = 0; i < d3; i++) { p = l2[ri(d2)] "/" pick(topic, nt) "-" (i+1); paths[nf++] = p; l3[i] = p }
  # depth 4 -- the remainder, so the folder count is exact
  d4 = folders - d1 - d2 - d3
  for (i = 0; i < d4; i++) { p = l3[ri(d3)] "/" pick(topic, nt) "-notes-" (i+1); paths[nf++] = p }

  for (i = 1; i < nf; i++) print "mkdir -p \"" dir "/" paths[i] "\"" > (dir "/.mk.sh")
  close(dir "/.mk.sh")
  system("sh \"" dir "/.mk.sh\""); system("rm -f \"" dir "/.mk.sh\"")

  # --- calibration ---------------------------------------------------------
  # Skipped entirely when no mean was asked for, which is what keeps the
  # default vault byte-identical.  10,059,538 B / 5,000 notes = 2,011.9077 B is
  # the mean the unscaled generator produces at the default shape, and it is the
  # only place that constant is used: it sets the FIRST GUESS, and the search
  # below then measures what actually came out.  A different --notes, --folders
  # or --seed converges just the same, from a worse starting point.
  #
  # TWO KNOBS, AND ONLY ONE OF THEM IS SEARCHED ON PURPOSE.  Sections per note
  # is an integer in the low single digits, so `int(nsec * ssec + 0.5)` is a
  # STEP function -- at ssec = 1.01 it changes nothing at all, and a search that
  # moves it hunts across a discontinuity and stalls (measured: 8 passes still
  # +5.34% off a 2,054 B target).  So ssec is fixed from the requested scale,
  # where it does the job it is good at -- giving a 5 KB note more headings and
  # more fenced blocks rather than four enormous paragraphs -- and the search
  # runs on words-per-paragraph, which spans 20..59 and is smooth in the mean
  # once averaged over the corpus.  The relation is very nearly affine
  # (bytes = A x swrd + B, B being the per-section overhead), so a SECANT search
  # lands on it in two or three passes.
  #
  # THE TOLERANCE IS 1% BECAUSE THE MEAN HAS A NOISE FLOOR, MEASURED.  Every
  # word costs one draw, so moving swrd at all reshuffles the WHOLE downstream
  # LCG stream -- which folder each note lands in, its topics, its section
  # count.  The achieved mean is therefore a smooth trend plus a random walk,
  # and the walk does not shrink with more passes.  Measured on the corpus below:
  # 5,000 notes, per-note sd 772.4 B, so one standard error on the corpus mean is
  # 10.9 B = 0.53%.  A 0.2% target is BELOW that floor; asking for it made the
  # search run 11 passes and finish no closer (+0.46%) than pass 3.  1% is a
  # shade under two standard errors and is reached in two or three passes.
  # Whatever comes out, the achieved mean is measured, printed and put in the
  # manifest -- this tool reports what it made, never what it was asked for.
  iters = 0; got = 0
  if (want > 0) {
    ssec = sqrt(want / 2011.9077)
    x1 = ssec
    swrd = x1
    sv = s; y1 = gen(0) / notes; s = sv; iters = 1
    best_x = x1; best_y = y1; got = y1
    if (y1 > 0) {
      x2 = x1 * want / y1
      for (it = 2; it <= 6; it++) {
        e1 = (best_y - want) / want; if (e1 < 0) e1 = -e1
        if (e1 <= 0.01) break
        swrd = x2
        sv = s; y2 = gen(0) / notes; s = sv; iters = it
        e2 = (y2 - want) / want; if (e2 < 0) e2 = -e2
        # KEEP THE BEST PASS, NOT THE LAST.  On a noisy objective the final
        # secant step can land further out than one already taken, and silently
        # shipping the last one would throw away a better corpus.
        if (e2 < e1) { best_x = x2; best_y = y2 }
        if (e2 <= 0.01) break
        if (y2 == y1) break                     # flat: floored by wc >= 3
        x3 = x2 + (want - y2) * (x2 - x1) / (y2 - y1)
        if (x3 < 0.02) x3 = 0.02                # never let a knob go non-positive
        if (x3 > 200) x3 = 200
        x1 = x2; y1 = y2; x2 = x3
      }
    }
    swrd = best_x; got = best_y
  }

  # --- notes ---------------------------------------------------------------
  total = gen(1)

  printf "M_MEAN_ACTUAL=%.4f\nM_SCALE_SEC=%.6f\nM_SCALE_WRD=%.6f\nM_CALIB_ITERS=%d\n",
         total / notes, (want > 0 ? ssec : 1), (want > 0 ? swrd : 1), iters > out_stats
  close(out_stats)

  printf "gen-vault: %d notes, %d folders, %d B (%.2f MiB / %.2f MB), mean %.1f B/note\n",
         notes, nf - 1, total, total / 1048576, total / 1000000, total / notes
  if (want > 0) {
    printf "gen-vault: mean target %.1f B, achieved %.1f B (%+.2f%%) after %d calibration pass%s\n",
           want, total / notes, (total / notes - want) * 100 / want, iters, (iters == 1 ? "" : "es")
    if ((total / notes - want) * 100 / want > 2 || (want - total / notes) * 100 / want > 2)
      print "gen-vault: WARNING: the achieved mean is more than 2% from the target; the section/word\n" \
            "           scaling is quantised and cannot hit every mean. Report the ACHIEVED mean." > "/dev/stderr"
  }
}
'

# THE CORPUS CENSUS.  M_BYTES is the frozen number two spikes recorded.
n_md=$(find "$DIR" -type f -name '*.md' | wc -l | tr -d ' ')
n_dir=$(find "$DIR" -mindepth 1 -type d | wc -l | tr -d ' ')
bytes=$(find "$DIR" -type f -name '*.md' -print0 | sum_bytes)
{
  echo "M_NOTES=$n_md"
  echo "M_FOLDERS=$n_dir"
  echo "M_BYTES=$bytes"
  echo "M_SEED=$SEED"
  echo "M_MEAN=$MEAN"           # the REQUESTED mean, or empty for the frozen default
  cat "$DIR/.calib"             # M_MEAN_ACTUAL, the two scale factors, the pass count
} > "$MANIFEST"
rm -f "$DIR/.calib" "$PARTIAL"
echo "gen-vault: wrote $MANIFEST (notes=$n_md folders=$n_dir bytes=$bytes)"

