#!/usr/bin/env node
// Proto generator (config-driven). Parses each layer's real gh-pr-diff into
// layered stack data and emits the stack's HTML. A first cut of the real
// ingest/compose step.
//   node protos/build-proto.js [stack]      (default: devdash-phases)
//   node protos/build-proto.js devdash-slice293
// Stack configs live in protos/stacks/<stack>.js; diffs in protos/data/<pr>.diff.
const fs = require("fs");
const path = require("path");

const DIR = __dirname;
const DATADIR = path.join(DIR, "data");
const stackId = process.argv[2] || "devdash-phases";
const cfg = require(path.join(DIR, "stacks", stackId + ".js"));
const OUT = path.join(DIR, cfg.out || "stack-viewer.html");

// EARS acceptance criteria parsed from the plan (id -> text).
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
const AC = cfg.planFile ? parseAcMap(fs.readFileSync(path.join(DATADIR, cfg.planFile), "utf8")) : {};
const acList = (ids) => (ids || []).map((id) => ({ id, text: AC[id] || "" })).filter((a) => a.text);

// A decision anchors to a specific source file + substring. Tests, generated
// code, and snapshots are never anchored, keeping anchors sparse.
const SKIP = /(__tests__|\.test\.|\.spec\.|\/generated\/|\.snap$)/;
function anchorOf(p, text) {
  if (SKIP.test(p)) return null;
  for (const a of cfg.anchors) if (p.includes(a.file) && text.includes(a.sub)) return a.d;
  return null;
}

function parseDiff(text, layer) {
  const files = [];
  let f = null, oldN = 0, newN = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git")) {
      const m = line.match(/ b\/(.+)$/);
      f = { path: m ? m[1] : line, layer: String(layer), hunks: [], adds: 0, dels: 0, hasAnchor: false };
      files.push(f);
      continue;
    }
    if (!f) continue;
    if (line.startsWith("+++ ") || line.startsWith("--- ") || line.startsWith("index ") ||
        line.startsWith("new file") || line.startsWith("deleted file") ||
        line.startsWith("similarity ") || line.startsWith("rename ") || line.startsWith("\\ No newline")) continue;
    if (line.startsWith("@@")) {
      const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/);
      oldN = m ? +m[1] : 0; newN = m ? +m[2] : 0;
      f.hunks.push({ header: line, lines: [] });
      continue;
    }
    const hunk = f.hunks[f.hunks.length - 1];
    if (!hunk) continue;
    const sign = line[0];
    const txt = line.slice(1);
    if (sign === "+") { const d = anchorOf(f.path, txt); if (d) f.hasAnchor = true; hunk.lines.push({ s: "+", n: newN++, t: txt, d }); f.adds++; }
    else if (sign === "-") { hunk.lines.push({ s: "-", o: oldN++, t: txt }); f.dels++; }
    else { hunk.lines.push({ s: " ", o: oldN++, n: newN++, t: txt }); }
  }
  return files;
}

const FILES = [];
cfg.layers.forEach((L, i) => {
  const text = fs.readFileSync(path.join(DATADIR, L.pr + ".diff"), "utf8");
  parseDiff(text, i).forEach((f) => FILES.push(f));
});

// seam = a path touched by more than one layer
const byPath = {};
FILES.forEach((f) => { (byPath[f.path] = byPath[f.path] || new Set()).add(f.layer); });
const seams = {};
Object.keys(byPath).forEach((p) => { if (byPath[p].size > 1) seams[p] = [...byPath[p]].sort(); });

const LAYERS = cfg.layers.map((L, i) => ({
  layer: String(i), ...L,
  ticket: { capability: L.capability, ac: acList(L.acids) },
}));
const DATA = { LAYERS, DECISIONS: cfg.decisions, FILES, seams, epic: cfg.epic };

const totalLines = FILES.reduce((a, f) => a + f.hunks.reduce((b, h) => b + h.lines.length, 0), 0);

const template = fs.readFileSync(path.join(DIR, "proto-template.html"), "utf8");
const client = fs.readFileSync(path.join(DIR, "proto-client.js"), "utf8");
const html = template
  .replace("/*__DATA__*/", "var DATA=" + JSON.stringify(DATA) + ";")
  .replace('<script src="proto-client.js"></script>', "<script>\n" + client + "\n</script>");
fs.writeFileSync(OUT, html);
console.log(`wrote ${OUT}  (stack: ${stackId})`);
console.log(`  ${cfg.layers.length} layer(s) · ${FILES.length} file cards · ${totalLines} diff lines · ${Object.keys(seams).length} seam files · ${Object.keys(cfg.decisions).length} decisions`);
