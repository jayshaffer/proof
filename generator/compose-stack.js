#!/usr/bin/env node
/**
 * Folds a manifest of per-PR walkthroughs into a single proof.stack/v1 payload.
 *
 * A stack is not authored — it is composed from the reduced+ingested spines its
 * layers already produced (via stack.sh / retrofit.sh), plus stack-level
 * requirements metadata and two things a single spine cannot know: which files
 * more than one layer touches (seams) and where a later layer's decision rests
 * on a file an earlier layer's decision introduced (builds-on edges). Both are
 * derived from decision evidence anchors, never from an import graph.
 *
 * The requirements source is deliberately open (Jira ticket, repo TDD, plan) —
 * the manifest carries the epic + per-layer capability/AC ids, and optionally a
 * planFile from which AC id -> text is resolved.
 *
 * Usage: node generator/compose-stack.js <manifest.json> [out.json]
 */
const fs = require("fs");
const path = require("path");
const { negotiate } = require("./contract");

const STACK_CONTRACT = "proof.stack/v1";

// EARS acceptance criteria parsed from a plan/TDD file (id -> one-line text).
function parseAcMap(md) {
  const map = {};
  let cur = null, buf = [];
  const flush = () => { if (cur) map[cur] = buf.join(" ").replace(/\s+/g, " ").replace(/[`*]/g, "").trim(); };
  for (const line of md.split("\n")) {
    const m = line.match(/^- \*\*([A-Z]{2,4}-\d+)\*\*:\s*(.*)$/);
    if (m) { flush(); cur = m[1]; buf = [m[2]]; continue; }
    if (cur) {
      if (line.trim() === "" || /^- /.test(line) || /^#/.test(line)) { flush(); cur = null; buf = []; }
      else buf.push(line.trim());
    }
  }
  flush();
  return map;
}

// Non-context evidence files a decision anchors, as file -> Set(decisionId).
function anchoredFiles(spine) {
  const byFile = new Map();
  for (const d of spine.decisions || []) {
    for (const ev of d.evidence || []) {
      const c = ev.code;
      if (!c || c.context || !c.file) continue;
      if (!byFile.has(c.file)) byFile.set(c.file, new Set());
      byFile.get(c.file).add(d.id);
    }
  }
  return byFile;
}

function compose(manifest, baseDir) {
  const readJson = (p) => JSON.parse(fs.readFileSync(path.resolve(baseDir, p), "utf8"));
  const ac = manifest.planFile
    ? parseAcMap(fs.readFileSync(path.resolve(baseDir, manifest.planFile), "utf8"))
    : {};
  const acList = (ids) => (ids || []).map((id) => ({ id, text: ac[id] || "" })).filter((a) => a.text);

  const layers = manifest.layers.map((L, i) => {
    const spine = typeof L.spine === "string" ? readJson(L.spine) : L.spine;
    negotiate(spine.contract, "proof.spine", { defaultMajor: 1 });
    return {
      pr: L.pr,
      ticket: L.ticket || (spine.pr && spine.pr.ticket) || undefined,
      phase: L.phase,
      title: L.title || (spine.pr && spine.pr.title) || `PR ${L.pr}`,
      summary: L.summary,
      capability: L.capability,
      provenance: L.provenance || layerProvenance(spine),
      ac: acList(L.acids),
      edge: L.edge, // may be replaced with a synthesized line below
      spine,
    };
  });

  const anchorsByLayer = layers.map((L) => anchoredFiles(L.spine));

  // seams: a path touched (via any diff file) by more than one layer
  const layersByFile = {};
  layers.forEach((L, i) => {
    for (const f of L.spine.diff || []) (layersByFile[f.file] = layersByFile[f.file] || new Set()).add(i);
  });
  const seams = {};
  for (const f of Object.keys(layersByFile)) {
    if (layersByFile[f].size > 1) seams[f] = [...layersByFile[f]].sort((a, b) => a - b);
  }

  // builds-on edges: a later layer's decision anchors a file an earlier layer's
  // decision also anchors. Decision-anchored only — this is the reasoning seam.
  const edges = [];
  const seen = new Set();
  for (let j = 1; j < layers.length; j++) {
    for (const [file, laterIds] of anchorsByLayer[j]) {
      for (let i = 0; i < j; i++) {
        const earlier = anchorsByLayer[i].get(file);
        if (!earlier) continue;
        for (const fromId of laterIds) {
          for (const toId of earlier) {
            const key = `${j}:${fromId}->${i}:${toId}:${file}`;
            if (seen.has(key)) continue;
            seen.add(key);
            edges.push({ from: { layer: j, decision: fromId }, to: { layer: i, decision: toId }, file });
          }
        }
      }
    }
  }

  // Synthesize a per-layer builds-on line for the rail when the manifest omits one.
  layers.forEach((L, i) => {
    if (L.edge) return;
    const targets = [...new Set(edges.filter((e) => e.from.layer === i).map((e) => e.to.layer))];
    if (targets.length) L.edge = "builds on " + targets.map((t) => "#" + layers[t].pr).join(", ");
  });

  const stack = {
    contract: STACK_CONTRACT,
    stack: {
      repo: manifest.repo,
      base: manifest.base || "main",
      topPr: manifest.topPr != null ? manifest.topPr : layers[layers.length - 1].pr,
      epic: manifest.epic || null,
      layers,
    },
    edges,
    seams,
  };
  // Drop undefined-valued optional keys so the returned object matches the
  // serialized file (JSON.stringify omits them) — keeps schema checks honest.
  return JSON.parse(JSON.stringify(stack));
}

const RANK = { reconstructed: 0, "through-review": 1, "first-hand": 1, "machine-verified": 2, "author-confirmed": 3, "author-verified": 4 };
function layerProvenance(spine) {
  const tiers = (spine.decisions || []).map((d) => d.provenance).filter(Boolean);
  if (!tiers.length) return "through-review";
  // the layer's honest ceiling is its least-advanced decision
  return tiers.reduce((lo, t) => (RANK[t] < RANK[lo] ? t : lo), tiers[0]);
}

function main() {
  const src = process.argv[2];
  if (!src) {
    console.error("usage: node generator/compose-stack.js <manifest.json> [out.json]");
    process.exit(2);
  }
  const out = process.argv[3] || src.replace(/\.manifest\.json$|\.json$/, "") + ".stack.json";
  const manifest = JSON.parse(fs.readFileSync(src, "utf8"));
  const stack = compose(manifest, path.dirname(src));
  fs.writeFileSync(out, JSON.stringify(stack, null, 2) + "\n");
  console.log(
    `wrote ${out} · ${stack.stack.layers.length} layers · ` +
      `${stack.edges.length} builds-on edges · ${Object.keys(stack.seams).length} seam files`,
  );
}

if (require.main === module) main();
module.exports = { compose, parseAcMap, anchoredFiles };
