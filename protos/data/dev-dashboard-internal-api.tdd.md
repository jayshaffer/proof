++ b/docs/tdds/dev-dashboard-internal-api.md
# Dev Dashboard: Internal API Entity Operations

## Problem & Goals

**Repos**: pathccm/attribution-service

`apps/dev-dashboard` exists and works, but it can only do three things: ping `/readyz`, POST an ingest payload for practices, and POST one for referrals — each with a "delete everything" button beside it. There is no way to look at a single record, correct a bad field, or delete one row. The two ingest pages are near-identical copy-paste, each holding a hand-edited JSON blob in a textarea.

The consequence is that every routine data question or fix in dev and prod-int goes through an engineer with AWS console access or a local script. "Why is this practice missing from the batch?" and "this practice's email is wrong" are both currently answered by reading DynamoDB directly. The blast radius is also wrong: the only mutation the dashboard offers is *wipe the entire table*.

The internal API surface that should back this is `docs/openapi-internal.yaml`, and it is 149 lines containing exactly two operations — `deleteAllPcpReferrals` and `deleteAllPractices`. Everything else the dashboard calls (`POST /internal/practices/ingest`, `POST /internal/pcp-referrals/ingest`) is declared in the *public* `docs/openapi.yaml` despite living under an `/internal/` path.

This document covers giving the dashboard full create/read/update/delete over both stored entities, plus a read-only preview of M2 batch cohort selection, with every operation declared in the internal spec so it is typed, documented, and covered by breaking-change detection.

**Goals:**

- An operator can create, find, inspect, edit, and delete individual `Practice` and `Referral` records in local, dev-int, and prod-int without DynamoDB console access.
- An operator can see which practices the M2 monthly batch would select, and why each excluded practice was excluded, before a send goes out.
- Every operation the dashboard performs is declared in `docs/openapi-internal.yaml` and reached through generated types — no hand-rolled paths, no operations that exist only in dashboard code.
- The internal spec's declared auth matches what the server actually enforces.

## Non-Goals

**Repos**: pathccm/attribution-service

- CRUD for `PracticeReportPublished`. Its repository exposes only `writePublishedRow` / `getPublishedRow`, and the M2 send ledger is an audit record of what was sent rather than an operator-editable entity — hand-editing it would falsify delivery history. Excluded deliberately.
- Triggering an M2 batch run for a practice. `docs/tdds/m2-batch-pdf.md` is schedule-only by design and declares no API trigger; a per-practice trigger can send real PHI email and needs its own design and security review.
- Re-driving a failed send. `docs/tdds/m2-batch-pdf.md`'s Non-Goals states "re-drives are operator-run"; contradicting that belongs in that document, not this one.
- Wiring the dashboard to on-demand provider report PDF export. `docs/tdds/provider-report-pdf.md` is an unbuilt design — `getProviderReport` is absent from `docs/openapi.yaml`, no route handler exists, and `apps/api` does not depend on `packages/pdf-renderer` or `packages/practice-report`. It also requires that document's contested `CLAUDE.md` Runtime Isolation override. Revisit once that ships.
- Deploying the dashboard. `apps/dev-dashboard/README.md` is explicit that it runs on developer laptops only, is absent from the `Dockerfile`, and is in `paths-ignore` for `deploy-eks.yml`. That stays true.
- Auth0 `bearerAuth` routes. The dashboard reaches `apiKeyAuth` routes only.
- Replacing the ingest pages. `POST /internal/*/ingest` keeps working as-is; moving those two declarations from the public spec into the internal spec is noted as an open question, not done here.
- Server-side sorting and full-text search beyond the existing GSI-backed lookups.

## Architecture

**Repos**: pathccm/attribution-service

### Existing surface this builds on

`apps/api/src/server.ts:116-123` registers a **second** `fastify-openapi-glue` instance for the internal spec, with handlers resolved from `apps/api/src/routes/internal/` and Swagger UI mounted at `/internal-documentation` (`:149-160`). `apps/api/package.json:12` generates `src/generated/internal-types.ts` from the internal spec via `openapi-typescript`. The pattern for adding internal operations is therefore already established and needs no new infrastructure — `apps/api/src/routes/internal/practices.ts` is a 19-line reference implementation that delegates to `apps/api/src/service/practice-service`.

Data access is the repository pattern in `packages/data/src/repository/`. `PracticeRepository` provides `getPractice`, `deletePractice`, `deleteAllPractices`, `listPractices`, `listPracticesByStatus`, `listPracticesByName`, `listPracticesByAccountManager`, and `listAccountManagers`. `ReferralRepository` provides `getReferral`, `deleteReferral`, `deleteAllReferrals`, `aggregatePracticeStats`, and list-by-practice / referrer / providerId / fullName. Both paginate as `{ <entities>, nextCursor }`.

Read and delete are therefore already covered at the repository layer for both entities. Create and update are where the work is.

### CRUD does not reuse the upsert methods

The two existing `upsert` methods disagree about what an omitted field means, and neither is a good foundation for an operator edit form.

`upsertPractice` (`packages/data/src/repository/practice-repository.ts:7-21`) conditionally spreads each optional field only when it is not `undefined`. ElectroDB's `upsert` compiles to a DynamoDB `UpdateItem`, so an omitted field retains its stored value — merge semantics, with no way to clear `practiceEmail`, `accountManager`, or `lastReferralDate` back to absent.

`upsertReferral` (`packages/data/src/repository/referral-repository.ts:22-52`) does the opposite: after upserting the provided fields it issues a second `update().remove(...)` for every one of the twelve `OPTIONAL_FIELDS` the caller omitted (`:42-48`) — replace semantics, where an omitted field is actively deleted.

**The CRUD surface does not use either.** Both `upsert` methods exist to serve the Hex ingest and are called from exactly two places — `apps/api/src/service/practice-service.ts:70` and `apps/api/src/service/pcp-referrals-service.ts:54`. They are left untouched, so the ingest path carries no regression risk from this work, and no reconciliation of their conflicting semantics is required.

Instead, create and update are new explicit repository methods with unambiguous contracts:

- **Create** fails if the `id` already exists, rather than silently overwriting. This is the operator-visible difference from ingest, which is intentionally idempotent.
- **Update** applies only the fields supplied and leaves every other stored field alone. Clearing an optional field is an explicit act, not an inference from omission.

This keeps the ambiguity contained to the ingest path where it is already load-bearing and tested, rather than propagating it into a UI.

Clearing is represented as an **explicit `null` on the field**: an omitted field is left alone, and `"practiceEmail": null` removes it. Three consequences to design against:

- Each nullable optional field is declared `type: [string, "null"]` in the internal spec, so AJV distinguishes absent from null at the route boundary rather than in handler code.
- The repository translates a `null` into ElectroDB's `update().remove(...)`, since DynamoDB storing a literal null is not the same as the attribute being absent — and the guard predicates test absence (`hasPracticeContactEmail` checks `!= null` plus a trimmed-length check, `guards.ts:7-9`).
- `accountManager` is both optional and the GSI3 partition key, so clearing it must remove the index entry rather than leave a key formatted from an empty string. This is the one clear case worth an explicit test.

### Immutable identifiers and index composites

`id` is the primary-key composite on both entities (`PracticeEntity` `byId`, `ReferralEntity` `byId`) and cannot be changed by an update — changing it means creating a new record and deleting the old one. Create must therefore accept an explicit `id`, and update must reject an attempted `id` change rather than silently ignoring it.

Several mutable fields are **GSI partition keys**, which is what makes update non-trivial:

- `Practice`: `name` (GSI2), `status` (GSI1), `accountManager` (GSI3).
- `Referral`: `practiceName` (GSI1), `cleanReferrerName` (GSI2), `referringProviderId` (GSI4), `fullName` (GSI3).

ElectroDB regenerates the index keys when these change, but it throws `IncompleteCompositeAttributes` unless every composite for each affected access pattern is supplied in the same call (`electrodb@3.9.1`, `src/entity.js:3353-3360`). Every index here is `pk: [thatField], sk: [id]`, so the required composites are the changed field plus `id` — satisfiable, but it means a partial update touching one of these fields is not a plain attribute write and needs deliberate handling.

`accountManager` is optional *and* a GSI3 partition key, so clearing it has to leave the index in a coherent state. `createdAt` is `readOnly` on both entities; `updatedAt` carries `watch: "*"` and maintains itself.

### Auth scheme correction

`docs/openapi-internal.yaml:84-87` declares:

```yaml
apiKeyAuth:
  type: apiKey
  in: header
  name: x-api-key
```

`docs/openapi.yaml:601-603` declares the **same scheme name** as `type: http, scheme: bearer`, and the actual handler `apps/api/src/security/api-key-auth.ts:6` reads `request.headers.authorization` and splits on a space. The dashboard sends `Authorization: Bearer <key>` (`apps/dev-dashboard/src/api/client.ts`). The internal spec's declaration is simply wrong: it describes a mechanism the server does not implement.

Nothing is broken at runtime today because only two operations exist and the dashboard hardcodes the correct header. But every operation added under the current declaration inherits the wrong contract, and Swagger UI's "Try it out" against `/internal-documentation` sends the wrong header. This is corrected before new operations are added, not after.

`docs/openapi-internal.yaml:13-16` also declares only the prod-int server, while the dashboard targets local (`http://localhost:3024`) and dev-int. Those are added.

### Cohort preview and the app boundary

M2's cohort selection lives in `apps/jobs/batch-runner/src/services/`, a **different app** from `apps/api`. `apps/api/package.json` has no dependency on batch-runner, batch-runner has no dependency on `apps/api`, and neither imports the other. The internal spec is served exclusively by `apps/api`, so a cohort-preview endpoint cannot call batch-runner's code as it stands.

The relevant code is small and mostly pure:

- `resolveCohort` (`apps/jobs/batch-runner/src/services/cohort.ts:8-35`) paginates `practiceRepository.listPracticesByStatus(PracticeStatus.SOLD, ...)` and emits two Datadog metrics. The selection logic is one repository call that `apps/api` can already make.
- `evaluateGuards`, `hasPracticeContactEmail`, and `isPracticeOptedOut` (`apps/jobs/batch-runner/src/services/guards.ts:7-26`) are **pure functions of a `Practice`** — no I/O, no metrics, no logging. `emitPracticeSkipped` (`:31-38`) is the only infrastructure-touching function in the file, and a preview does not need it.
- `SkipReason` (`apps/jobs/batch-runner/src/services/skip-reason.ts`) is a plain enum.

The pure guard predicates, `SkipReason`, and the cohort-resolution logic are extracted into a shared workspace package consumed by both `apps/jobs/batch-runner` and `apps/api`, so preview and batch cannot drift. Duplicating the predicates into `apps/api` is explicitly rejected — a preview that disagrees with the batch it predicts is worse than no preview, because it will be trusted. The metric emission stays in batch-runner: a preview must not move batch counters. Package placement follows the `/add-package` checklist and the repo rule that each package is its own workspace, not a `common/` umbrella.

The preview is **read-only**: it resolves the cohort, evaluates guards per practice, and reports proceed/skip with reasons. It renders no PDF, writes no ledger row, stages nothing to S3, and sends no email. It therefore does not touch `docs/tdds/m2-batch-pdf.md`'s Non-Goal on batch triggering.

### The opt-out predicate reads a field that is not stored

`isPracticeOptedOut` reads `(practice as PracticeWithGuardFields).optedOut`, and `optedOut` is **not an attribute on `PracticeEntity`** — `apps/jobs/batch-runner/src/services/types.ts:4-5` declares it as a phantom field on a cast type, with a `TODO(NEV-1412)` noting the real predicate has not landed. NEV-1412 is closed `Wont fix`.

The predicate is extracted as-is; correcting it is not in scope here. The consequence is that preview reports `OPTED_OUT` for zero practices, because the field it reads never exists on a stored record — and that is exactly what the batch does today, so preview remains a faithful prediction of batch behavior. Preview must not imply it verified opt-out status.

Note the interaction with practice editing: because `optedOut` is not a declared entity attribute, it is not an editable field in this work either. An operator cannot mark a practice opted-out through the dashboard, and adding that field is separate, unowned work.

### PHI handling

`Referral` records carry `fullName`, `mobile`, `email`, and per-patient stage data. The dashboard already forbids persisting request or response bodies to `localStorage`, IndexedDB, or logs (`apps/dev-dashboard/README.md:83-84`) while storing the API key per-environment. That constraint extends unchanged to every new page.

Two things do change in degree. Referral list and detail views put more PHI on screen at once than today's single-record ingest echo. And this work introduces operator-authored *writes* to patient-adjacent records where previously only bulk ingest and bulk delete existed. Neither is a new class of data nor a new trust boundary — the same already-authenticated internal operator, over VPN, through the same `apiKeyAuth` scheme — but referral mutation is the highest-consequence surface in this document and warrants explicit confirmation in the UI for destructive and replace operations.

`Practice` records carry `practiceEmail`, which is business contact data rather than patient data.

### Referral edits and ingest overwrites

Referrals are derived from the Hex ingest. A hand-edited referral is not durable: the next ingest run upserts the same `id` and overwrites operator changes. This is accepted — the purpose is manual manipulation for testing and correction, not a durable system of record — but the UI should not imply permanence, and this is worth stating in the AC rather than discovering later.

### Conventions to follow, and one to avoid

`pathccm/employer-backend` is the reference for this shape and supplies three patterns worth copying:

- One component triplet per entity — `XList` / `XDetail` / `CreateXForm` (plus a delete confirmation dialog) — rather than one page per endpoint.
- A `test.each` auth matrix over every `[method, url]` pair asserting 401 for a missing key and 401 for a wrong key, asserting on the error envelope's `errorType` discriminator.
- Spec-as-contract tests that fetch the served `/internal-documentation/json` and assert the operation is actually registered, so a missing glue wiring fails a test rather than 404ing in someone's browser.

One employer-backend trait to **not** copy: its operational actions (backfill, dev reset, seeding) live entirely outside its OpenAPI spec, so they are excluded from type generation and breaking-change detection, and it now carries two parallel internal surfaces (specced `/internal/*` and unspecced legacy `/admin/*`) that its own UI labels inconsistently. Every operation here is declared in the internal spec — that is the point of this document.

Also note `docs/openapi-internal.yaml` is currently absent from Spectral linting; the root `openapi-lint` task targets the public spec only.

## Capabilities

### Manage practice records

**Repos**: pathccm/attribution-service

An operator can create a practice, search existing ones by name, status, or account manager, open one to see its full stored state, edit its fields — including the GSI-backed `name`, `status`, and `accountManager` — and delete that single record.

Creating a practice whose `id` already exists is rejected rather than silently overwriting it. Editing leaves unsubmitted fields intact, and clearing an optional field is possible but explicit. Deleting one practice is distinct from the existing `deleteAllPractices`, which stays as-is behind its confirmation.

### Manage referral records

**Repos**: pathccm/attribution-service

An operator can create a referral, look one up by practice, referrer, referring provider, or patient name, page through results, open a single referral to see its full stored state including lead type and stage fields, edit any of them, and delete an individual record.

Referrals carry twelve optional fields, so the guarantee that an edit touches only what was submitted matters more here than anywhere else: editing one stage field must not disturb `mobile`, `email`, `networkName`, `insuranceCarrier`, or the rest.

### Preview the monthly batch cohort

**Repos**: pathccm/attribution-service

An operator can see, before a monthly send, which Active Sold practices the batch would select and which would be skipped with which reason — so a coverage shortfall is caught by inspection rather than discovered from the delivery numbers afterward. Read-only; renders nothing, sends nothing, and moves no batch metrics. Reports the opt-out limitation rather than implying opt-out was checked.

## Resolved Questions

**Repos**: pathccm/attribution-service

- **Which entities get a mutable surface?** `Practice` and `Referral`, both full CRUD. `PracticeReportPublished` is excluded — see Non-Goals.
- **Referral editing, given ingest overwrites it?** In scope. Manual manipulation is the goal; impermanence is accepted and stated.
- **Reuse the existing `upsert` methods for CRUD?** No. They serve the Hex ingest, have mutually inconsistent omitted-field semantics, and are left untouched. CRUD gets explicit create and update methods, so their conflicting behavior needs no reconciliation and the ingest path carries no regression risk.
- **How is clearing an optional field represented?** Explicit `null` on the field; omission means leave alone. Declared as a nullable type in the spec so validation happens at the route boundary, and translated to ElectroDB `remove` so the attribute is genuinely absent rather than stored as null.
- **Fix the auth mismatch here, or separately?** Here, before new operations are added, so they do not inherit a wrong contract.
- **Duplicate the guard predicates into `apps/api`?** No — extract to a shared package. A preview that can drift from the batch it predicts is actively misleading.
- **Fix the opt-out stub as part of this?** No. Extract it as-is so preview matches batch behavior exactly; the missing entity attribute is separate work.
- **Does cohort preview contradict M2's Non-Goals?** No. M2 excludes triggering sends and re-driving failures. A read-only preview that renders and sends nothing is neither.

## Open Questions

**Repos**: pathccm/attribution-service

- Should `POST /internal/practices/ingest` and `POST /internal/pcp-referrals/ingest` move from `docs/openapi.yaml` into the internal spec? They are `/internal/`-pathed but publicly declared. Moving them is a breaking change to the published spec and may affect the Hex ingest caller.
- Should `docs/openapi-internal.yaml` be added to Spectral linting? It is unlinted today, so naming-convention drift between the two specs is not caught.
- Should creating a referral through the dashboard validate against the same schema the Hex ingest uses, or accept looser input for test-fixture purposes?
- Should cohort preview accept a practice-status or account-manager filter, or always preview the full Active Sold cohort?
- Pagination convention: repositories default to `limit = 25`. Is that the right page size for an operator UI, and should the dashboard paginate server-side or fetch-and-filter client-side as employer-backend's employer list does?
