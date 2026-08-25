# Plan: diff stack viewer (one artifact for a whole stacked-PR chain)

## The thesis

`proof` is PR-scoped: one ledger → one spine → one HTML. But work ships as a **stack** — a
chain of PRs, each based on the one below, promoted to main in order. A reviewer of the whole
stack today opens N PRs and reconstructs, in their head, both *how the pieces build on each
other* and *what the net change to main actually is*. The per-PR walkthrough can't show
either: it sees only its own diff against its own base.

A stack viewer folds N ledgers into **one artifact** that gives a reviewer the two things no
single PR walkthrough holds:

- **the net change** — one cumulative diff equal to what merges into main (`main…top-of-stack`);
- **layer ownership + the reasoning seams** — which ticket owns each line, and where a later
  ticket's decision sits on top of what an earlier ticket built.

It is **additive**. Nothing about the single-PR path changes. A stack is literally an ordered
list of the `proof.spine/v2` artifacts proof already produces, plus the edges between them.

## Decisions locked with the author (2026-08-24)

- **Data source:** GitHub PR chain → retrofit. Point at the top PR; walk base pointers down to
  main; retrofit a ledger per PR. Inherits the retrofit provenance ceiling (`through-review`),
  honestly — nothing in the stack claims first-hand.
- **Primary shape:** layered cumulative diff. Each line tinted by its owning layer, linked to
  the decision behind it, with a peel control.
- **Audience:** reviewer approving the whole stack. Density, coverage, and *where risk
  concentrates* across layers are the payoff.
- **Cumulative model:** **both** — net `main…top` composed diff is the landing view; the peel
  control drops to any single layer's own base-pinned diff. **Phased:** sequenced per-PR ships
  first (Phase 1), net compose lands second (Phase 2).

## The dependency-graph trap, and how we dodge it

`design.md` deliberately omits the structure/dependency graph: structure is machine-recoverable,
reasoning is not, so effort goes only to reasoning. A "diff **stack** viewer" pulls toward
drawing a pretty DAG of PRs — the recoverable part. We resist that.

The cross-layer **"builds-on" edge is derived from decisions, not imports**: two layers are
linked only when a later layer's decision *anchors to a file an earlier layer's decision
introduced*. The edge exists exactly where reasoning crosses a layer boundary
("NEV-1539's upload gate sits on the client package NEV-1538 added"), computed mechanically
from anchors already in the ledgers — no model call, no import graph.

## Pipeline (extends the retrofit path; new work is `compose` + a stack render)

```
1. resolve   gh pr view <any-pr> --json baseRefName,headRefName,number,title
             from ANY entry PR: walk DOWN (follow baseRefName) until base ==
             default branch to find the stack floor, then walk UP (find the PR
             whose baseRefName == current head) to the top. Entry can be any
             layer, not just the tip. A base retargeted to main after a lower
             PR merged (e.g. #217 after #216) naturally bounds the floor.
             → ordered layers, bottom (nearest main) → top          [skill, interpretive]
2. retrofit  run the existing /proof:retrofit-ledger once per layer
             → N .ledger.jsonl + a stack manifest naming them in order [skill, interpretive]
3. reduce    reduce-ledger.js per layer (reuse `reduce` export)      → N proof.spine/v2
4. compose   NEW compose-stack.js: stitch spines + per-PR base-pinned
             diffs (reuse ingest-diff.js) + derive builds-on edges   → proof.stack/v1
5. validate  per-layer spine checks (unchanged) + NEW cross-layer:
             edges resolve to real decisions; layers partition the
             cumulative diff (Phase 2)                               → exit non-zero on fail
6. render    generate.js renderStack path                            → one self-contained HTML
```

Interpretive steps (1–2) mirror the existing split: `/proof:retrofit-ledger` already
reconstructs one PR; the new `/proof:retrofit-stack` skill resolves the chain and drives it per
layer, emitting a manifest. Deterministic steps (3–6) run from `stack.sh <manifest>` with no
model and no creds — the mechanical path, testable in isolation like `retrofit.sh --data`.

## New contract: `proof.stack/v1`

A thin wrapper over the existing per-layer artifacts — the stack owns order and edges, each
layer owns its own settled `proof.spine/v2`:

```jsonc
{
  "contract": "proof.stack/v1",
  "stack": {
    "repo": "owner/name",
    "topPr": 1234,
    "base": "main",
    "layers": [                     // bottom (nearest main) → top
      { "pr": 1230, "ticket": "NEV-1538", "spine": { /* proof.spine/v2 */ },
        "diff": { /* base-pinned per-PR attributed diff */ } }
    ]
  },
  "edges": [                        // builds-on, decision-anchored only
    { "from": { "layer": 1, "decision": "D3" },
      "to":   { "layer": 0, "decision": "D2" },
      "file": "packages/couchdrop-client/src/client.ts" }
  ],
  "cumulative": { /* Phase 2: net main…top diff + line→layer ownership */ }
}
```

`contract.js` negotiates `proof.stack` (defaultMajor 1) exactly as it does `proof.ledger` /
`proof.spine`.

## Phase 1 — sequenced stack viewer (reuses everything)

Ship a working stack artifact with zero new rendering primitives.

- **compose-stack.js** — reduce each ledger (via the exported `reduce`), ingest each layer's
  base-pinned diff (via `ingest-diff.js`), derive builds-on edges from shared anchors, emit
  `proof.stack/v1` (no `cumulative` block yet).
- **stack.sh** — deterministic driver: manifest → compose → validate → render. `--data` style,
  no Bedrock.
- **validate.js** — add a `proof.stack/v1` branch: validate each layer's spine with the current
  v2 rules; check every edge resolves to a real (layer, decision) pair and points strictly
  downward.
- **generate.js** — `renderStack`: a stack overview strip (layers bottom→top, each a card with
  decision count, coverage bucket summary, provenance ceiling, and its builds-on edges), plus
  the existing per-layer Decisions + per-PR Diff rendered per layer. The **peel control**
  (reusing `client.js` sort/filter machinery) switches the active layer. Templates
  (`decision-card`, `diff-file`, `coverage`) are reused unchanged; one new small template for
  the overview strip.
- **/proof:retrofit-stack** skill — resolve the chain, retrofit each PR, write the manifest.

Deliverable: point at a real stacked chain, get one HTML where a reviewer steps layer-by-layer
through exactly what each author wrote, sees the coverage and the builds-on seams, and never
opens GitHub.

## Phase 2 — net composed diff (the landing view)

- Compose the `main…top` net diff and attribute each line to its **last-touching layer**
  (line-number reconciliation across the per-layer base-pinned diffs). Lines churned away
  within the stack (added by PR1, removed by PR2) carry no net diff line and surface as a
  layer-local decision with no cumulative anchor — honest, exactly like today's
  non-change-links-only-to-before rule.
- Landing view becomes the net diff tinted by owning layer; **cross-layer seams** (files owned
  by >1 layer) are highlighted as where the risk concentrates. Peel drops net → per-layer
  (Phase 1's view).
- validate.js cross-layer check gains the partition rule: every net changed line owned by
  exactly one layer.

## Safety net (the CLAUDE.md byte-identical invariant)

Rendering is regenerated and diffed. Add a committed stack sample under `prototype/data/`
(a manifest + its layer ledgers) and wire it into `build.sh`, so a structure-only change
regenerates to identical bytes.

**Reference stack (real):** `pathccm/attribution-service` #217→#221 (`devdash-internal-api`
phase2→phase6), 5 open layers on merged main, ~8k additions, textbook bottom-up arc
(data → practice API → referral API → cohort package → UI). This is the faithful sample —
retrofit a ledger per layer and commit the manifest + ledgers. Big enough to stress the
overview strip, the peel control, and cross-layer seam detection (phase3→phase2 repository
methods; phase6→phase3/4 endpoints + phase5 cohort package).

## Open questions

- **Escaping / templates:** the `<%- %>`-only invariant and single `esc`/`richText` path must
  hold in the new overview template. No `<%=`.
- **Sample provenance:** need one real stacked chain to produce a truthful committed sample;
  until then the synthesized manifest is dev-only and must not be presented as real.
- **Peel UX detail:** cumulative step-up (main → +PR1 → +PR2) vs. isolate-one-layer — Phase 1
  ships isolate; step-up is a Phase 2 affordance once the net diff exists to step through.

## Shipped — deterministic cut (branch `diff-stack-viewer`)

The proto (`protos/`) proved the UX; it is now real code. Details in
`~/.claude/plans/gleaming-bubbling-quilt.md`. What landed:

- **Contract** `proof.stack/v1` registered in `generator/contract.js`; structural
  `schemas/stack.v1.schema.json` (wrapper only — layer spines validated deeply against v2).
- **`generator/compose-stack.js`** — folds a manifest of per-PR spines into `proof.stack/v1`:
  resolves AC text from a `planFile`, computes **seams** (file in >1 layer) and
  **decision-anchored builds-on edges**. Requirements are **source-agnostic** (Jira / TDD /
  plan) — the manifest carries `epic` + per-layer `capability`/`acids`.
- **`validate.js`** — v2 body factored into a pure `validateSpineV2(spine)`; new
  `proof.stack/v1` branch validates each layer against v2 + cross-layer edge/seam integrity.
  Single-PR v1/v2 output is **byte-identical** (verified against HEAD).
- **`generate.js` `renderStackPage`** — dispatched at the same seam as `renderV2Page`;
  transforms the wrapper into the client model (layer-namespaced decision ids) and inlines
  `generator/stack.css` + `generator/stack-client.js` (ported from the proto; separate assets
  so single-PR pages are untouched — no class collisions).
- **`proof.sh stack <manifest>`** — folded into the main entry point as a subcommand (was a
  separate `stack.sh`): per-layer reduce → ingest `gh pr diff` → enrich, then compose →
  validate → render. A layer may instead point at a committed `spine` (offline, no `gh`).
- **Sample** — `prototype/data/stack-sample.manifest.json` (2 committed reduced spines,
  offline) wired into `build.sh`. A real multi-layer chain still awaits the deferred skill.
- **Stack tab on the normal PR page** — `renderV2Page` now optionally renders a "Stack" tab
  (`generator/stack-tab.css` + `generator/stack-tab-client.js`, `#view-stack`-scoped `st-*`
  ports of the standalone rail/peel widget, so nothing collides with the page's own `.dl`,
  `.diff-file`, `pre.code`, etc.). `proof.sh stack` now writes both the standalone
  `stack-<top>.html` *and* one `pr-<n>.html` per layer with the tab embedded and pinned to
  that layer (`stackDefaultLayer`, set explicitly by the orchestrator — a spine's own baked-in
  `pr.number` isn't guaranteed to match the manifest's label for it, seen firsthand in the
  synthetic sample). Additive: a `renderV2Page` call with no `stack` field is unchanged
  (verified byte-identical modulo the pre-existing empty-conditional blank-line pattern).

- **`/proof:retrofit-stack` — the bidirectional chain resolver + per-layer retrofit → manifest.**
  `generator/resolve-stack.js` is the mechanical half: a pure function over the open-PR ref graph
  (`gh pr list --json number,title,baseRefName,headRefName`, passed as a file/stdin so it needs no
  network of its own) that walks *down* base branches to the stack floor and *up* to the top,
  from any entry PR, and emits a `proof.sh stack` manifest skeleton (layers bottom→top, one
  `ledger` path each). `skills/retrofit-stack/SKILL.md` is the interpretive half: resolve the
  chain, drive `/proof:retrofit-ledger` per layer, fill the manifest, render via `proof.sh stack`.
  Its one stack-specific rule is the `context:true` anchor on a consuming layer's decision — the
  exact signal `compose-stack.js` needs for a builds-on edge (which is also why the edge detector
  had to stop excluding context anchors; see that fix). Verified end-to-end against the real open
  #300→#301 chain in `pathccm/attribution-service`: resolves from either entry point, 2 layers,
  2 correct builds-on edges. Handles a middle entry, a partially-merged floor, a single PR, a
  missing PR (exit 2), and a malformed cycle (terminates), all unit-checked offline.

**Deferred (next cut):** the net-composed `main…top` diff with line reconciliation; a CI workflow.
The **sample provenance** open question above stands — the committed sample is dev-only
synthetic until real per-layer ledgers exist.
