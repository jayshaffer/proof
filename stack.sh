#!/usr/bin/env bash
#
# stack.sh — compose a stacked-PR walkthrough from a manifest of per-PR ledgers.
#
#   per layer: reduce ledger → ingest `gh pr diff` → enrich pr facts (proof.spine/v2)
#   then:      compose (proof.stack/v1) → validate → render self-contained HTML
#
# No model call. Each layer's diff is pulled from its PR, so it is pinned to that
# PR's own base — immune to local-worktree rebase drift. A layer may instead
# point at an already-reduced `spine` (offline samples, no gh needed).
#
# Manifest shape (see docs / prototype/data/stack-sample.manifest.json):
#   { repo, base, topPr, epic, planFile?,
#     layers: [ { pr, ledger } | { pr, spine }, + phase/summary/capability/acids ] }
#
# Usage:
#   stack.sh <manifest.json> [--repo owner/name] [--out dir]
#
# Exit codes:
#   0  rendered to <out>/stack-<top>.html
#   1  validation failed
#   2  usage / precondition error
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

MANIFEST=""
REPO=""
OUT="$HERE/prototype"

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --out)  OUT="$2";  shift 2 ;;
    -h|--help) sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "❌ unknown flag: $1" >&2; exit 2 ;;
    *)  if [ -z "$MANIFEST" ]; then MANIFEST="$1"; fi; shift ;;
  esac
done

[ -n "$MANIFEST" ] || { echo "usage: stack.sh <manifest.json> [--repo owner/name] [--out dir]" >&2; exit 2; }
[ -r "$MANIFEST" ] || { echo "❌ manifest not readable: $MANIFEST" >&2; exit 2; }
MANIFEST_DIR="$(cd "$(dirname "$MANIFEST")" && pwd)"

if [ -z "$REPO" ]; then
  REPO="$(jq -r '.repo // empty' "$MANIFEST")"
  [ -n "$REPO" ] || REPO="${GITHUB_REPOSITORY:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$OUT/data"

N="$(jq '.layers | length' "$MANIFEST")"
TOP="$(jq -r '.topPr // (.layers[-1].pr)' "$MANIFEST")"
echo "· stack of $N layers in $REPO → top #$TOP"

# The runtime manifest is the input with each layer's spine path (and planFile)
# rewritten to an absolute path, so compose-stack.js resolves them from $TMP.
RUNTIME="$TMP/manifest.json"
cp "$MANIFEST" "$RUNTIME"
PLAN_REL="$(jq -r '.planFile // empty' "$MANIFEST")"
if [ -n "$PLAN_REL" ]; then
  jq --arg p "$MANIFEST_DIR/$PLAN_REL" '.planFile = $p' "$RUNTIME" > "$RUNTIME.tmp" && mv "$RUNTIME.tmp" "$RUNTIME"
fi

i=0
while [ "$i" -lt "$N" ]; do
  PR="$(jq -r ".layers[$i].pr" "$MANIFEST")"
  LEDGER_REL="$(jq -r ".layers[$i].ledger // empty" "$MANIFEST")"

  if [ -n "$LEDGER_REL" ]; then
    LEDGER="$MANIFEST_DIR/$LEDGER_REL"
    [ -r "$LEDGER" ] || { echo "❌ ledger not readable: $LEDGER" >&2; exit 2; }
    REDUCED="$OUT/data/pr-$PR.reduced.json"
    DIFF="$TMP/pr-$PR.diff"
    META="$TMP/pr-$PR.meta.json"
    echo "· [layer $i] PR #$PR — gather → reduce → ingest → enrich"
    gh pr view "$PR" --repo "$REPO" \
      --json number,title,baseRefName,baseRefOid,headRefName,headRefOid > "$META"
    gh pr diff "$PR" --repo "$REPO" > "$DIFF"
    HEAD_SHA="$(jq -r '.headRefOid' "$META")"
    BASE_SHA="$(jq -r '.baseRefOid' "$META")"
    TITLE="$(jq -r '.title' "$META")"
    node "$HERE/generator/reduce-ledger.js" "$LEDGER" "$REDUCED"
    node "$HERE/generator/ingest-diff.js" "$REDUCED" "$DIFF" "$REDUCED"
    jq --arg n "$PR" --arg t "$TITLE" --arg r "$REPO" --arg h "$HEAD_SHA" --arg b "$BASE_SHA" \
      '.pr = ((.pr // {}) + {number:$n, title:$t, repo:$r, headSha:$h, baseSha:$b})' \
      "$REDUCED" > "$REDUCED.tmp" && mv "$REDUCED.tmp" "$REDUCED"
  else
    SPINE_REL="$(jq -r ".layers[$i].spine // empty" "$MANIFEST")"
    [ -n "$SPINE_REL" ] || { echo "❌ layer $i (#$PR) has neither ledger nor spine" >&2; exit 2; }
    REDUCED="$MANIFEST_DIR/$SPINE_REL"
    [ -r "$REDUCED" ] || { echo "❌ spine not readable: $REDUCED" >&2; exit 2; }
    echo "· [layer $i] PR #$PR — using committed spine $SPINE_REL"
  fi

  jq --argjson i "$i" --arg s "$REDUCED" '.layers[$i].spine = $s' \
    "$RUNTIME" > "$RUNTIME.tmp" && mv "$RUNTIME.tmp" "$RUNTIME"
  i=$((i + 1))
done

STACK="$OUT/data/stack-$TOP.json"
echo "· compose — proof.stack/v1"
node "$HERE/generator/compose-stack.js" "$RUNTIME" "$STACK"
echo "· validate"
if ! node "$HERE/validate.js" "$STACK"; then
  echo "❌ validation failed — not rendering." >&2
  exit 1
fi
echo "· render — $OUT/stack-$TOP.html"
node "$HERE/generate.js" "$STACK" "$OUT/stack-$TOP.html"
echo "✓ stack walkthrough ready: $OUT/stack-$TOP.html"
