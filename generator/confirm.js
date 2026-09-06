#!/usr/bin/env node
/**
 * The smallest author-correction loop for a proof.spine/v1 walkthrough: flip an
 * inferred decision to author-stated once the author points at their own words.
 * The quote given here still has to pass validate.js's --inputs verbatim check
 * (docs/design.md "The author is the first verifier") — confirming means
 * quoting yourself, not re-asserting the inference.
 *
 * Usage:
 *   node generator/confirm.js <data.json> <decision-id> --quote "<verbatim text>" --src "<where it is>"
 */
const fs = require("fs");

function parseArgs(argv) {
  const [dataPath, id, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const val = rest[i + 1];
    if (flag === "--quote") opts.quote = val;
    else if (flag === "--src") opts.src = val;
  }
  return { dataPath, id, ...opts };
}

function main() {
  const { dataPath, id, quote, src } = parseArgs(process.argv.slice(2));
  if (!dataPath || !id || !quote || !src) {
    console.error(
      'usage: node generator/confirm.js <data.json> <decision-id> --quote "<verbatim text>" --src "<where it is>"',
    );
    process.exit(2);
  }

  const data = JSON.parse(fs.readFileSync(dataPath, "utf8"));
  const d = (data.decisions || []).find((x) => x.id === id);
  if (!d) {
    console.error(`❌ no decision "${id}" in ${dataPath}`);
    process.exit(2);
  }
  if (d.source !== "infer") {
    console.error(`❌ ${id}: source is "${d.source}", not "infer" — nothing to confirm`);
    process.exit(2);
  }

  d.source = "author";
  d.quote = quote;
  d.quoteSrc = src;
  delete d.inferNote;
  delete d.inferSrc;
  const stamp = `Confirmed by author ${new Date().toISOString().slice(0, 10)}.`;
  d.note = d.note ? `${d.note} ${stamp}` : stamp;

  fs.writeFileSync(dataPath, JSON.stringify(data, null, 2) + "\n");
  console.log(`✓ ${id}: infer -> author (${dataPath})`);
  console.log(`  re-run: node validate.js ${dataPath} --inputs <inputs.txt> && node generate.js ${dataPath}`);
}

main();
