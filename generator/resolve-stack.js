#!/usr/bin/env node
/**
 * Resolves the PR stack containing an entry PR, from GitHub PR ref topology.
 *
 * A stack is a chain of PRs where each one's head branch is the next one's
 * base branch, promoted to the default branch bottom-up. Given ANY PR in the
 * chain, this walks:
 *
 *   down  follow baseRefName to the PR whose base is the default branch (or
 *         whose base is not itself an open PR head) — the stack floor.
 *   up    find the PR whose baseRefName == the current head — the next layer,
 *         until no PR builds on the current head — the stack top.
 *
 * Topology only — no diffs, no model, no reasoning. It emits the ordered layer
 * list (bottom → top) as a proof.sh-stack manifest skeleton: each layer carries
 * pr/title/phase, and a `ledger` path the caller must still produce (the
 * interpretive retrofit step). The skill drives that; this is its mechanical half.
 *
 * Input is the PR graph as JSON on argv[3] (a file) or stdin — the array from:
 *   gh pr list --repo O/R --state open --limit 200 \
 *     --json number,title,baseRefName,headRefName
 * so this script needs no network of its own and is unit-testable offline.
 *
 * Usage:
 *   node generator/resolve-stack.js <entry-pr> <repo> [prs.json]   # file or stdin
 *
 * Exit codes:
 *   0  resolved — manifest skeleton on stdout
 *   2  usage error, or entry PR not found in the graph
 */
const fs = require("fs");

function readGraph(argPath) {
  const raw = argPath ? fs.readFileSync(argPath, "utf8") : fs.readFileSync(0, "utf8");
  const prs = JSON.parse(raw);
  if (!Array.isArray(prs)) throw new Error("PR graph must be a JSON array");
  return prs;
}

// Resolve the ordered stack (bottom → top) containing entryPr. Pure function
// over the PR list so it is testable without gh. defaultBranch bounds the
// floor: a PR based directly on it is a stack floor.
function resolveStack(prs, entryPr, defaultBranch = "main") {
  const byNumber = new Map(prs.map((p) => [Number(p.number), p]));
  // head branch -> the PR whose head it is (a branch has at most one open PR).
  const byHead = new Map(prs.map((p) => [p.headRefName, p]));

  const entry = byNumber.get(Number(entryPr));
  if (!entry) return null;

  // Walk DOWN: follow base branches while the base is another open PR's head.
  // The floor is the first PR whose base is the default branch or otherwise
  // not an open PR head (its lower layers already merged).
  let floor = entry;
  const seenDown = new Set([floor.headRefName]);
  while (floor.baseRefName !== defaultBranch && byHead.has(floor.baseRefName)) {
    const lower = byHead.get(floor.baseRefName);
    if (seenDown.has(lower.headRefName)) break; // cycle guard
    seenDown.add(lower.headRefName);
    floor = lower;
  }

  // Walk UP from the floor: the next layer is the PR based on the current head.
  const ordered = [floor];
  const seenUp = new Set([floor.headRefName]);
  let cur = floor;
  while (true) {
    const upper = prs.find((p) => p.baseRefName === cur.headRefName);
    if (!upper || seenUp.has(upper.headRefName)) break; // top, or cycle guard
    seenUp.add(upper.headRefName);
    ordered.push(upper);
    cur = upper;
  }

  return ordered;
}

// Shape the ordered PRs into a proof.sh-stack manifest skeleton. Each layer
// gets a ledger path the caller must produce; the epic is a placeholder for
// the skill/author to fill. phase is the 0-based position, human-labeled.
function toManifest(ordered, repo, defaultBranch = "main") {
  const top = ordered[ordered.length - 1];
  return {
    repo,
    base: defaultBranch,
    topPr: Number(top.number),
    epic: {
      badge: "STACK",
      title: `${repo} — ${ordered.length}-layer stack`,
      note: "Skeleton emitted by resolve-stack.js from PR ref topology. Fill epic + per-layer capability/summary, and produce each layer's ledger, before rendering.",
      goal: "",
    },
    layers: ordered.map((p, i) => ({
      pr: Number(p.number),
      ticket: p.headRefName,
      phase: `layer ${i}`,
      title: p.title || `PR ${p.number}`,
      summary: "",
      capability: "",
      ledger: `pr-${p.number}.ledger.jsonl`,
    })),
  };
}

function main() {
  const entryPr = process.argv[2];
  const repo = process.argv[3];
  const graphPath = process.argv[4];
  if (!entryPr || !repo) {
    console.error("usage: node generator/resolve-stack.js <entry-pr> <repo> [prs.json]");
    process.exit(2);
  }
  const defaultBranch = process.env.PROOF_DEFAULT_BRANCH || "main";
  const prs = readGraph(graphPath);
  const ordered = resolveStack(prs, entryPr, defaultBranch);
  if (!ordered) {
    console.error(`❌ entry PR #${entryPr} not found in the PR graph`);
    process.exit(2);
  }
  process.stderr.write(
    `· resolved ${ordered.length}-layer stack: ${ordered.map((p) => "#" + p.number).join(" → ")}\n`,
  );
  process.stdout.write(JSON.stringify(toManifest(ordered, repo, defaultBranch), null, 2) + "\n");
}

if (require.main === module) main();
module.exports = { resolveStack, toManifest };
