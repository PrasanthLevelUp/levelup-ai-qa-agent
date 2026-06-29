#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# DEBUG ARTIFACT — not part of the product runtime.
# Kept under scripts/debug/ as the reproduction harness that proved the
# "report pollutes git status/diff → phantom fix-less PR" root cause. Safe to
# delete once that investigation is closed.
# ─────────────────────────────────────────────────────────────────────────────
# Trace the EXACT git sequence the healing-pr route runs, against the real repo.
# Goal: prove under which conditions the pushed branch has NO diff vs base
# (the "No commits between main and heal/<branch>" 422).
#
# Usage: TOKEN=ghu_xxx ./trace-git-workflow.sh <owner> <repo> <scenario>
#   scenario = code_change   -> apply a real code edit + always-on report
#   scenario = code_nochange -> NO code edit, only the always-on report
set -uo pipefail

TOKEN="${TOKEN:?set TOKEN}"
OWNER="${1:?owner}"; REPO="${2:?repo}"; SCENARIO="${3:-code_change}"
BASE="main"
TS="$(date +%s%3N)"
DIR="/tmp/trace-${REPO}-${TS}"

hr(){ echo "──────── $* ────────"; }
g(){ git -C "$DIR" "$@"; }

hr "1. CLONE (--depth 1 --branch $BASE) — exactly like cloneRepo()"
git clone --depth 1 --branch "$BASE" \
  "https://x-access-token:${TOKEN}@github.com/${OWNER}/${REPO}.git" "$DIR" 2>&1 | sed 's/x-access-token:[^@]*@/x-access-token:***@/g'
g config user.email "bot@leveluptesting.in"
g config user.name "LevelUp AI Bot"

BRANCH="heal/trace-${SCENARIO}-${TS}"
hr "2. checkout -b $BRANCH"
g checkout -b "$BRANCH" 2>&1
echo "HEAD after branch: $(g rev-parse HEAD)"
echo "origin/$BASE     : $(g rev-parse "origin/$BASE")"

hr "3. APPLY 'fix' (scenario=$SCENARIO)"
# Find a test/page file to (maybe) edit
TARGET="$(g ls-files | grep -E '\.(ts|js)$' | grep -iE 'login|page|test|spec' | head -1)"
echo "target file: ${TARGET:-<none>}"
if [ "$SCENARIO" = "code_change" ] && [ -n "$TARGET" ]; then
  # make a guaranteed real change
  printf '\n// levelup-trace-%s\n' "$TS" >> "$DIR/$TARGET"
  echo "appended a marker line to $TARGET"
else
  echo "NO code change applied (simulating a heal whose locator didn't match the fresh clone, or already-merged fix)"
fi

hr "4. Option A: report is NOT written to the repo (it is platform metadata)"
echo "skipping healing-reports/ write — report document now persists to object storage (pr_automations.report_uri holds only the reference)"

hr "5. git add -A"
g add -A

hr "6. git status --porcelain  (the route's early empty-guard checks THIS)"
PORC="$(g status --porcelain)"
echo "${PORC:-<empty>}"
if [ -z "$PORC" ]; then echo ">>> porcelain EMPTY -> route returns 'No changes to commit'"; fi

hr "7. git commit"
g commit -m "trace commit ($SCENARIO)" >/dev/null 2>&1
echo "commit SHA: $(g rev-parse HEAD)"

hr "8. git show --stat HEAD (what's actually in the commit)"
g show --stat --oneline HEAD | head -20

hr "9. THE INVARIANT: git diff --stat origin/$BASE HEAD"
DIFF="$(g diff --stat "origin/$BASE" HEAD)"
echo "${DIFF:-<EMPTY — this is the no-commits-between condition>}"

hr "10. Option A check: committed paths must be SOURCE ONLY (never healing-reports/)"
NAMES="$(g diff --name-only "origin/$BASE" HEAD)"
echo "committed paths:"; echo "${NAMES:-  <none>}" | sed 's/^/  - /'
REPORTS="$(echo "$NAMES" | grep '^healing-reports/' || true)"

hr "VERDICT (Option A behavior)"
if [ -z "$NAMES" ]; then
  echo "EMPTY changeset -> route STOPS (invariant #1: 'No repository changes detected'). No push, no GitHub call."
elif [ -n "$REPORTS" ]; then
  echo "FAIL: a healing report leaked into the commit -> selectCommitFiles should have stripped it:"
  echo "$REPORTS" | sed 's/^/  - /'
else
  echo "PASS: real source change, NO report in the commit -> PR proceeds with source-only diff:"
  echo "$NAMES" | sed 's/^/  - /'
fi

rm -rf "$DIR"
