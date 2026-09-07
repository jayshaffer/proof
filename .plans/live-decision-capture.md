# Plan: live decision capture — the `/decision-log` emitter

> **Status:** Phase 1 (the honest floor — `observedAt`, the `first-hand` degrade, the
> `by: human` attestation gate), Phase 2 (the emitter — `generator/decision-log.js`,
> `skills/decision-log/SKILL.md`, invoked as `/proof:decision-log`), and Phase 3's mechanics
> (`hooks/observe-edit.js`, `hooks/record-approval.js`, `hooks/reconcile-stop.js`) are **built**.
> See the Phase 3 note below for exactly what was verified against real Claude Code hook
> payloads versus wired defensively but unconfirmed. Phase 4 (an instrumented real ticket) is
> still open.

## The thesis

`docs/retrofit-ledger.md` names the one thing reconstruction structurally cannot reach:
in-the-moment reasoning that was never written down — "planned X, hit Y, switched to Z."
Retrofit recovers it only if some artifact happened to record it. Capturing it costs one
instruction to an agent that already knows the answer at the moment it matters.

Everything downstream of the event stream is already built and does not care who writes it:
`generator/ledger-cli.js` (the deterministic writer), `generator/reduce-ledger.js` (the fold
into `proof.spine/v2`), the provenance ladder, `retrofit.sh`, the renderer. This plan designs
only the missing producer: what writes `proof.ledger/v1` events **while** the work happens.

## What exists vs. what is missing

| Piece | State |
|---|---|
| `proof.ledger/v1` event contract + schema | built, stable |
| `ledger-cli.js` — seq, id minting, supersedes, commit stamp, schema gate | built |
| `reduce-ledger.js` — fold to spine, derive provenance tier | built |
| `/proof:retrofit-ledger` — writes `by: retrofit` events after the fact | built |
| **A producer that writes `by: agent` events during the work** | **missing — this plan** |
| **Any check that a `by: agent` event was actually written live** | **missing — this plan** |
| **Any check that `by: human` came from a human** | **missing — this plan** |

## Decisions locked with the author (2026-09-05)

- **Invocation: hybrid.** A `/decision-log` skill is the write interface; Claude Code hooks
  in this repo supply the forcing function. Self-contained in proof, portable to any repo,
  and the discipline does not depend on the agent remembering.
- **Anti-laundering: detect and downgrade.** An agent event that cannot be shown to have been
  written at decision time does not get to claim `first-hand`.

## The split: hooks observe, the agent explains

The failure mode that kills this feature is an agent that logs nothing during the work and
dumps events from memory at the end. Those events are retrofit quality wearing a `first-hand`
badge, and the entire provenance ladder rests on that badge meaning something.

The design answer is to give each participant only the job it is actually good at:

- **Hooks observe mechanically.** A `PostToolUse` hook on `Edit`/`Write` appends to a scratch
  observation log — file, line range touched, `HEAD` at that moment. A hook always fires, never
  forgets, and never editorializes. It also cannot know *why* a line changed, so it never tries.
- **The agent explains.** `/decision-log` carries only judgment: what was chosen, what was
  rejected, why it matters, and which observed edits belong to which decision.

The observation log is what makes both the anchors precise and the liveness claim checkable.
Neither is something the agent should be asked to self-report.

## Event flow, by phase

**Plan.** The agent emits one `/decision-log propose` per decision it intends (4–8, same bar as
the generation prompt: a point where a competent engineer could have chosen otherwise). Batching
these into one call is honest — they genuinely all happen at one moment.

**Approval.** A `PostToolUse` hook matching `ExitPlanMode` records that a human approved, at
which commit, into the scratch state. It does not write `confirm` events directly, because
`confirm` must reference decision ids that may not exist yet. Instead the CLI consumes that
recorded approval: the next `propose` for this ticket pairs itself with a `by: human` `confirm`.
The human attestation is thereby grounded in an actual human action, never asserted by the agent.

**Execute.** For each proposed decision the agent emits exactly one terminal event:

| What happened | Event |
|---|---|
| Implemented as planned | `realize` (attaches anchors + tests) |
| Implemented differently | `revise` — `reason` states the obstacle that forced the change |
| Abandoned | `reject` — `reason` states why |

A decision discovered mid-execute is a `realize` carrying its own `title`; the CLI already
supports first-establishment this way. It is allowed but should be rare and is worth counting.

**Review.** A finding that changes code is a `revise` in the `review` phase; one the reviewer
declines is a `reject`; a lens that passed clean is a `verify`. Externally-driven changes
(a bot or a second reviewer) use the `copilot` phase. All of this is unchanged from today's
retrofit mapping — only the actor and the timing differ.

**Close.** One `close` when the work is done, carrying the suites/AC summary.

## The emitter interface

The agent should supply judgment and nothing else. Everything mechanical is derived:

| Field | Source |
|---|---|
| `ticket` | branch name, else `.proof/state.json`, else `--ticket` |
| `phase` | sticky in `.proof/state.json`, set once per phase, `--phase` overrides |
| `by` | **always `agent`** from the skill — see below |
| `commit` | `git rev-parse HEAD` at write time (already done by the CLI) |
| `seq`, `id`, `supersedes` | already owned by the CLI |
| `anchors` | offered from the observation log, agent confirms which belong to this decision |

So a realize is close to: `/decision-log realize d3 --anchors 2,3 --tests src/x.test.ts:"skips when disabled"`,
where `2,3` selects from the edits the hook already saw. The agent never types a line number.

### `by: human` requires evidence, not a flag

Today `ledger-cli.js` validates `by` against the enum and nothing else, so a single call
claiming `{"by": "human", "event": "verify"}` yields `author-verified` — the tier the design
says clears a walkthrough for trusted publish. That is a one-line path from an agent's
assertion to the top of the ladder, and it must close before any live capture ships.

The rule: **the skill can only write `by: agent`.** Human-actor events come from evidence
recorded by a hook that observed a real human action — plan approval for `confirm`, and an
explicitly human-invoked command for `verify`. The CLI rejects `by: human` unless the matching
evidence is present in the scratch state. This is the same anti-laundering principle the
retrofit cap already encodes, applied to the actor rather than the reconstruction.

## Anti-laundering: making `first-hand` mean something

Add one optional field to the event: **`observedAt`** — the commit at which the *work* being
described happened, taken from the observation log. It is distinct from `commit`, which is when
the *event was written*. When the two agree, the log kept pace with the work.

Reducer rule, in `signalOf`: an `agent` event may claim `first-hand` only with positive evidence
of liveness — `observedAt` present and equal to `commit`. Otherwise it degrades to
`reconstructed`, the same tier a retrofit gets, which is exactly what an end-of-run memory dump
is. Review-phase events keep their `through-review` reading, since that tier is about where the
reasoning came from, not when it was recorded.

Two properties worth noting. It fails safe: a repo with no hooks installed produces no
`observedAt`, so its events read `reconstructed` rather than silently claiming more than they
earned. And it is contract-additive: one optional field, no new enum value, so older consumers
ignore it and the major stays at v1.

Alternative considered and set aside: a distinct `self-reported` tier between `reconstructed`
and `first-hand`, to separate agent-memory from artifact-reconstruction. It reads more precisely
but costs a seventh tier on a ladder that is already the hardest part of the model to hold in
your head. Reuse `reconstructed` unless the distinction proves load-bearing.

## Anchors

The observation log gives each anchor a real `sha` — the commit the edit was made at — instead
of a guess reconciled after the fact. Line numbers still drift as the branch keeps moving, so
at render time the anchor's `(sha, lines)` is mapped forward through the PR's own diff, which
proof already pulls. An anchor that fails to resolve is flagged for re-verification rather than
silently trusted, which is invariant 7 in `docs/ledger-schema.md` finally becoming enforceable.

On the `fingerprint` field the schema doc still lists as open: capture an optional **`symbol`**
(the enclosing function or class from the edit context) as the durable handle. A symbol survives
reformatting and line drift far better than a byte hash, and it is nearly free to capture at
observation time. Byte-level fingerprinting stays deferred; it does not block this work.

## The three hooks

1. **`PostToolUse` on `Edit`/`Write` — observe.** Append file, range, `HEAD`, and enclosing
   symbol to `.proof/observations.jsonl`. Silent, never blocks. This is the only hook that runs
   often, so it must stay cheap.
2. **`PostToolUse` on `ExitPlanMode` — record approval.** Write "human approved at `<sha>`" into
   the scratch state, which the CLI later consumes to ground `confirm`.
3. **`Stop` — the reconciliation gate.** Block while any `propose` for this ticket has no
   terminal event, listing the open ids. This is the forcing function that converts "remember to
   log" into "you cannot finish with decisions unaccounted for," and it is what makes deviation
   capture reliable rather than aspirational: the agent is reconciling against a known list, not
   free-associating about what was interesting.

   Two guards this needs. It must fire only when a ledger exists for the current branch, so it
   is inert in every repo that has not opted in. And it needs an escape hatch — a `reject` with
   a reason, or an explicit defer — so a blocked agent always has an honest way forward rather
   than being trapped into fabricating a `realize`.

## Scratch state, and what gets committed

`.proof/ledger.jsonl` is committed to the branch, as already decided. The observation log and
approval state are **not** — they are working files under `.proof/` that the ledger distills
from, and committing them would put a noisy, merge-conflict-prone artifact in every PR for no
reader benefit. They are gitignored; only the ledger travels.

## Phases

**Phase 1 — the honest floor.** `by: human` evidence check in `ledger-cli.js`, plus the
`observedAt` field and the `signalOf` degrade rule in the reducer. This is worth landing on its
own: it makes today's ledgers accurate about what they are and closes the top-tier hole, with no
emitter and no hooks. Nothing else in this plan is safe to ship before it.

**Phase 2 — the emitter.** `skills/decision-log/SKILL.md` plus the derivation layer (ticket,
sticky phase, anchor selection). Voluntary capture works end to end; a ticket logged this way
produces a real `by: agent` ledger and a walkthrough with no reconstruction in it.

**Phase 3 — the forcing functions.** The three hooks, in the order above. Observation first
(it improves anchors immediately and is risk-free), then approval, then the Stop gate last,
since a blocking hook is the one that can go wrong in a way that ruins someone's afternoon.

Built as `hooks/observe-edit.js`, `hooks/record-approval.js`, `hooks/reconcile-stop.js`.
What's actually verified, versus what is wired on documentation and inference alone:

- **`observe-edit.js` (PostToolUse, `Edit|Write`) — confirmed live.** Wired into a real
  `.claude/settings.json` and triggered by real `Edit`/`Write` tool calls in this session; the
  exact stdin field names it depends on (`tool_name`, `tool_input.file_path`/`old_string`/
  `new_string`/`content`, `tool_response.structuredPatch`) were read from the real payload, not
  assumed. Both the patch-derived range and the whole-file fallback (a `Write` that creates a
  file has an empty `structuredPatch`) were exercised.
- **`reconcile-stop.js` (Stop) — logic verified by direct invocation, blocking mechanism
  verified by platform documentation, never fired live.** `decision: "block"` + `reason` is
  what this install's own bundled settings schema documents for a `Stop` hook (not the
  `continueLoop` field an earlier, less authoritative research pass guessed); this hook was
  never actually allowed to block a real session, since doing that on purpose has an obvious
  failure mode. The self-built re-entrancy cap (`MAX_CONSECUTIVE_BLOCKS`, since no confirmed
  `stop_hook_active`-equivalent field exists in the documented schema) was tested directly:
  it blocks for a genuinely open decision, then fails open on schedule, on both a fresh ledger
  and a repeat of the same open set.
- **`record-approval.js` (PermissionRequest + PostToolUse, `ExitPlanMode`) — pipe-tested only,
  never fired live.** No real `ExitPlanMode` call happened against the wired hook during this
  work (that needs an actual plan-approval round trip, not manufactured as a side effect of
  building this). The script is defensive about that: every field it reads is optional-checked,
  and any failure exits 0 silently rather than surfacing. **Confirm this one empirically before
  trusting it** — the file itself says so at the top.

The verified wiring (a real `.claude/settings.json` hooks block pointing at these three
scripts) is intentionally **not committed** — it hardcoded this session's own scratchpad
Node binary (this machine's system `node` is broken) and this checkout's absolute path,
neither of which is portable. What ships is the three hook scripts, which take no path
assumptions of their own (they resolve sibling `generator/` modules via `__dirname`, and
read `.proof/` paths from the hook payload's own `cwd`, never `process.cwd()`, since how
Claude Code sets a spawned hook's working directory isn't confirmed either). Wiring them
into a real `.claude/settings.json` — with a working `node` and this checkout's real path —
is left to whoever adopts this, until the portable route (a plugin-declared `hooks.json`
using `${CLAUDE_PLUGIN_ROOT}`, per external documentation this session did not verify
first-hand) gets its own verification pass.

**Phase 4 — instrumented for real.** Run one actual ticket end to end and compare its ledger
against a retrofit of the same PR. The interesting number is not how many decisions each found
but how many `revise` events exist on the live side and are simply absent from the retrofit —
that difference is the entire argument for the feature, and it should be measured rather than
assumed.

## Open questions

- **Does the Stop gate hold across sessions?** A ticket spans several sessions; the gate fires
  per session end. Blocking at the end of session 1 for decisions genuinely intended for session
  3 would be wrong. Likely answer: gate on decisions whose files have already been edited, not
  on every open proposal.
- **Subagents.** Work delegated to a subagent produces edits the parent did not make. Does the
  subagent write to the same ledger (append-only makes this safe), and does its `Stop` fire the
  gate? Leaning yes to the first, no to the second.
- **`propose` without a plan.** Small tickets skip plan mode entirely, so there is no approval
  hook and no proposal list to reconcile against. Those should still be able to `realize` with
  a title, but then the Stop gate has nothing to check. Accept the weaker guarantee, or require
  a proposal for any ticket that opts in?
- **Multi-repo tickets.** Already open in `docs/ledger-schema.md`; unchanged here. One ledger
  per repo keyed by ticket remains the likely answer.
