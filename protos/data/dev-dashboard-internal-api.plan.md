++ b/.plans/dev-dashboard-internal-api.md
# Plan: Dev Dashboard Internal API Entity Operations

**TDD**: `docs/tdds/dev-dashboard-internal-api.md`
**Target branch**: `feat/dev-dashboard-internal-api` (single feature branch)
**Repo**: pathccm/attribution-service

Acceptance criteria are derived from the TDD's three Capabilities and expressed in EARS
(`WHEN` / `IF` / `WHERE` / `WHILE` … `the system SHALL` …), each mapped to named test
cases. Structure follows `/jira:jira-start` (parse AC → expand to EARS → derive tests →
phase the implementation), with the TDD standing in for a Jira description.

---

## 1. Research findings that change the TDD's assumptions

Verified against the working tree before planning. Three corrections, five discoveries.
Each one changes what gets built.

### 1.1 The internal spec IS already Spectral-linted (TDD is stale)

TDD:144 says "`docs/openapi-internal.yaml` is currently absent from Spectral linting;
the root `openapi-lint` task targets the public spec only." No longer true:

- `package.json:11` — `"openapi-lint": "spectral lint docs/openapi.yaml docs/openapi-internal.yaml"`
- `Taskfile.yml` `openapi-lint` lists both specs under `sources:`
- `pnpm exec spectral lint docs/openapi-internal.yaml` → **6 warnings, 0 errors**
  (`operation-tags` and `owasp:api8:2023-define-error-responses-500` on the two
  `options` operations)

**Consequence**: TDD Open Question #2 is already resolved in code. But every new
operation must satisfy Spectral's OWASP rules — `maxLength` on every string, `maxItems`
on every array, `minimum`/`maximum` on every integer — or the warning count grows.
"No new Spectral warnings" becomes an explicit AC (§4.5) rather than a PR-time surprise.

*Unverified*: whether CI fails on warnings. `.github/workflows/linting.yml` delegates to
`pathccm/shared-github-actions/.github/workflows/general-linting.yml@main`
(`openapi-validation-version: 'v2'`); the threshold isn't visible in this repo. Plan
holds new operations to zero warnings regardless.

### 1.2 ElectroDB has purpose-built `create()` and `patch()` — do not hand-roll conditions

The TDD says create "fails if the `id` already exists" (TDD:59) and update "applies only
the fields supplied" (TDD:60) but not how. Verified in
`electrodb@3.9.1/src/entity.js`:

| Primitive | Line | Behavior |
|---|---|---|
| `create()` | `:394` | `put` + `attribute_not_exists` condition |
| `patch()` | `:414` | `update` + `attribute_exists` condition |
| `returnOnConditionCheckFailure` | `:815-840` | returns `{ rejected: true }` instead of throwing |
| `_isConditionalCheckFailedException` | `:869` | matches `err.name`/`err.code` — not message text |

**Consequence**: create/update use `create()`/`patch()` with
`.go({ returnOnConditionCheckFailure: true })` and a `rejected` check. This replaces the
brittle `error.message.includes("ConditionalCheckFailed")` string matching that
`deletePractice` (`packages/data/src/repository/practice-repository.ts:38-44`) and
`deleteReferral` (`referral-repository.ts:69-76`) use today. The difference between a
contract and a coincidence.

Existing delete methods are **left alone** — the TDD scopes no change to them, and
they're covered by passing tests. Noted as a follow-up, not folded in.

### 1.3 ElectroDB already removes GSI keys when a partition-key attribute is removed

The TDD flags clearing `accountManager` (GSI3 PK) as "the one clear case worth an
explicit test" (TDD:68) and implies bespoke handling. Verified `_getUpdatedKeys`
(`:3475-3527`): it computes `removedKeyImpact` from removed attributes and pushes the
affected index keys onto `deletedKeys`, which `:2564-2574` converts to
`update.remove(indexKey)` — correctly skipping the table's own PK/SK.

**Consequence**: `.remove(["accountManager"])` cleans up `GSI3PK`/`GSI3SK` unaided. Keep
the TDD's test — it's valuable as a *verification of library behavior against LocalStack*
— but write no workaround. The TDD's worry that clearing "must remove the index entry
rather than leave a key formatted from an empty string" is already handled upstream.

### 1.4 `IncompleteCompositeAttributes` has a documented escape hatch

TDD:79 correctly identifies that changing a GSI partition key throws unless every
composite for the affected access pattern is supplied. The error message itself
(`:3355-3360`) names the fix: *"use the 'composite' chain method on update to supply the
value for key formatting purposes."*

Every index on both entities is `pk: [field], sk: [id]`, and `id` is always known from
the route path. So `.composite({ id })` supplies the missing piece for any GSI-key patch.

**Consequence**: patching `name`, `status`, `accountManager`, `practiceName`,
`cleanReferrerName`, `referringProviderId`, or `fullName` is mechanical, not special-cased.

### 1.5 `PatchFields` / `UpsertFields` already exist and are completely unused

`packages/data/src/model/types.ts:164-199` defines `UpsertFields`, `PatchFields`, and
`IdentityFields` — generics that derive "fields settable on update" from a model plus its
ElectroDB entity, excluding auto-set keys. Grep across `packages/data/src`,
`apps/api/src`, and `apps/jobs/**` finds **zero call sites**.

**Consequence**: the exact type vocabulary this work needs was already built and never
wired up. New repository signatures use
`PatchFields<Practice, typeof PracticeEntity, "createdAt" | "updatedAt">` instead of
inventing parallel hand-written input types.

### 1.6 Nullable clearing: use `nullable: true`, not `type: [string, "null"]`

TDD:66 specifies `type: [string, "null"]`. Both forms work; the repo has precedent for
the other one, and mixing them is worse than either.

Spiked against `ajv@8.18.0` with `{ strict: true }` (matching `server.ts:53`):

| Form | Compiles (strict) | Accepts `null` | Rejects wrong type |
|---|---|---|---|
| `type: ["string","null"]` | yes | yes | yes (`must be string,null`) |
| `nullable: true` | yes | yes | — |

And `nullable: true` is already used on a **request** schema —
`PracticeRow.accountManager` (`docs/openapi.yaml:1631-1634`) — generating
`accountManager?: string \| null` (`apps/api/src/generated/types.ts:697`). The ingest
path already round-trips nullable request fields through openapi-typescript correctly.

**Decision**: follow in-repo precedent (`nullable: true`). It's an OAS 3.0 keyword in a
3.1.1 document, which is a wart, but it demonstrably works through AJV *and*
openapi-typescript here, and consistency with `PracticeRow` beats spec purism. Flagged
for the reviewer rather than silently diverging from the TDD.

### 1.7 The dev-dashboard has no test infrastructure at all

`apps/dev-dashboard/package.json:15` — `"test": "vitest run --passWithNoTests"`. No
`vitest.config.ts`, no `jsdom`/`happy-dom`, no `@testing-library/*`, no test file
anywhere under `apps/dev-dashboard/`.

**Consequence**: the TDD's UI guarantees — confirmation on destructive/replace ops
(TDD:126), "UI should not imply permanence" (TDD:132), no PHI persisted (TDD:124),
"Preview must not imply it verified opt-out status" (TDD:118) — have nothing to assert
them. See §2.

### 1.8 The dashboard does not use the generated SDK, and the SDK can't cover internal ops

`apps/dev-dashboard` depends on `@pathccm/attribution-service-client-ts-axios`
(`package.json:20`) but imports it nowhere; pages call raw axios paths
(`PracticesIngest.tsx:52` — `client.post("/internal/practices/ingest", parsed, …)`).

More decisively: `clients/attribution-service-client-ts-axios/openapi-config.yaml` sets
`inputSpec: ../../docs/openapi.yaml` — **public spec only**. `detect-sdk-drift.yml`
watches only `docs/openapi.yaml`.

**Consequence**: the TDD's goal "every operation … reached through generated types"
(TDD:19) cannot mean the axios SDK for internal operations. It means either (a) generate
a second internal SDK, or (b) type the dashboard's calls against
`apps/api/src/generated/internal-types.ts`. This plan takes **(b)** — the dashboard
imports the generated `components["schemas"]` types, so a spec change breaks `tsc -b`
in the dashboard. Recorded as a deviation from the literal TDD wording (§7).

---

## 2. Scope decision: UI testing

The TDD's Capabilities are operator-facing ("An operator can create a practice, search
existing ones by name, status, or account manager, open one to see its full stored
state…"), so honest AC coverage implies UI tests. Per §1.7 the dashboard has zero test
infrastructure.

Rather than silently drop the UI ACs or silently expand scope, this plan:

- Stands up **minimal** Vitest + jsdom + `@testing-library/react` in `apps/dev-dashboard`
  as an explicit, separable phase (Phase 6), scoped to the four behaviors the TDD calls
  out as consequential: destructive-op confirmation, impermanence warning,
  no-PHI-persistence, and the opt-out caveat on preview.
- Does **not** attempt broad component coverage of every form field.

Smallest addition that makes the TDD's UI guarantees assertable. If you'd rather defer
it, Phase 6 lifts out cleanly and every API-layer AC still holds.

---

## 3. Deviations from the TDD (all deliberate)

| # | TDD says | Plan does | Why |
|---|---|---|---|
| 1 | Internal spec is unlinted (TDD:144); Open Q #2 asks whether to lint it | Treats it as already linted; holds new ops to zero new warnings | §1.1 — `package.json:11` already lints both |
| 2 | Clear via `type: [string, "null"]` (TDD:66) | `nullable: true` | §1.6 — matches `PracticeRow`, verified through AJV + openapi-typescript |
| 3 | "reached through generated types" (TDD:19) | Dashboard imports `internal-types.ts`; no internal axios SDK | §1.8 — SDK generator is public-spec-only |
| 4 | Clearing GSI3 key "worth an explicit test" implying custom handling (TDD:68) | Test kept; no custom code | §1.3 — ElectroDB handles it |
| 5 | UI behaviors asserted (TDD:118,124,126,132) | Requires new test infra (Phase 6) | §1.7 — none exists |

---

## 4. Acceptance criteria (EARS)

Each requirement is testable and traced to a TDD line. `SHALL` is normative.

### 4.1 Auth scheme correction — prerequisite for everything else

Derived from TDD:83-98. Ships **first**, alone, so no new operation inherits a wrong
contract.

The internal spec declares `apiKeyAuth` as `type: apiKey, in: header, name: x-api-key`
(`docs/openapi-internal.yaml:84-87`), but `apiKeyAuth` (`apps/api/src/security/api-key-auth.ts:6-21`)
reads `request.headers.authorization` and requires `Bearer <key>`. The public spec gets
it right (`docs/openapi.yaml:604-606`: `type: http, scheme: bearer`).

- **AUTH-1**: WHERE `docs/openapi-internal.yaml` declares the `apiKeyAuth` security
  scheme, the system SHALL declare it as `type: http, scheme: bearer`, matching
  `docs/openapi.yaml:604-606` and the behavior of `api-key-auth.ts`.
- **AUTH-2**: WHEN a request carries a valid key as `Authorization: Bearer <key>` to any
  authenticated internal operation, the system SHALL authenticate it successfully.
- **AUTH-3**: IF a request to an authenticated internal operation omits the
  `Authorization` header, THEN the system SHALL respond `401` with body
  `errorType: "AuthenticationError"`.
- **AUTH-4**: IF a request presents a key not in the `API_KEYS` allowlist, THEN the
  system SHALL respond `401` with `errorType: "AuthenticationError"`.
- **AUTH-5**: IF a request presents an `Authorization` header whose scheme is not
  `Bearer` or which does not split into exactly two space-separated parts, THEN the
  system SHALL respond `401`.
- **AUTH-6**: WHERE the internal spec declares `servers`, the system SHALL list
  local (`http://localhost:3024`) and dev-int alongside the existing prod-int entry
  (TDD:98).
- **AUTH-7**: WHERE an operation is a CORS preflight (`options*`), the system SHALL
  declare `security: []` and SHALL respond `204` without authentication.

*Note*: AUTH-3/4/5 already hold at runtime (the handler is correct); these lock in
behavior while the *declaration* changes, guarding against a regression where someone
"fixes" the handler to match the old wrong spec.

### 4.2 Capability: Manage practice records

Derived from TDD:148-154. Entity: `Practice` (`packages/data/src/model/practice.ts`),
fields `id`, `name`, `status`, `accountManager?`, `practiceEmail?`, `lastReferralDate?`,
`createdAt` (readOnly), `updatedAt` (`watch: "*"`).

**Create** — `POST /internal/practices`

- **PC-1**: WHEN a create request supplies a valid body with an `id` that does not exist,
  THEN the system SHALL persist the practice and respond `201` with the stored record
  including server-assigned `createdAt` and `updatedAt`.
- **PC-2**: IF a create request supplies an `id` that already exists, THEN the system
  SHALL respond `409` with `errorType: "ConflictError"` and SHALL NOT modify the stored
  record (TDD:59 — "rejected rather than silently overwriting").
- **PC-3**: IF a create request omits any of `id`, `name`, or `status`, THEN the system
  SHALL respond `422` with `errorType: "UnprocessableContentError"`.
- **PC-4**: IF a create request supplies a `status` outside the `PracticeStatus` enum
  (`SOLD`, `ONBOARDING`, `STALLED_IN_ONBOARDING`, `CHURNED`, `OTHER`), THEN the system
  SHALL respond `422`.
- **PC-5**: IF a create request supplies `createdAt` or `updatedAt`, THEN the system
  SHALL respond `422` (both are server-managed; `additionalProperties: false`).
- **PC-6**: WHEN a practice is created with `accountManager` present, THEN the system
  SHALL make it retrievable via the GSI3 account-manager lookup.

**Read** — `GET /internal/practices/{practiceId}`, `GET /internal/practices`

- **PR-1**: WHEN a detail request names an existing `practiceId`, THEN the system SHALL
  respond `200` with every stored attribute, including absent optional fields omitted
  rather than null.
- **PR-2**: IF a detail request names a `practiceId` with no stored record, THEN the
  system SHALL respond `404` with `errorType: "NotFoundError"`.
- **PR-3**: WHEN a list request supplies no filter, THEN the system SHALL respond `200`
  with a page of practices and a `nextCursor` when more results exist.
- **PR-4**: WHEN a list request supplies exactly one of `name`, `status`, or
  `accountManager`, THEN the system SHALL serve it from the corresponding GSI
  (`byName`/GSI2, `byStatus`/GSI1, `byAccountManager`/GSI3) rather than a table scan.
- **PR-5**: WHILE more results remain, the system SHALL return a `nextCursor` that, when
  replayed, returns the following page without repeating or skipping records.
- **PR-6**: IF a list request supplies a `limit` outside 1–100, THEN the system SHALL
  respond `422`.
- **PR-7**: WHERE `name` and `accountManager` GSI keys use `casing: "upper"`
  (`practice.ts:93`, `:110`), the system SHALL match those lookups case-insensitively.

**Update** — `PATCH /internal/practices/{practiceId}`

- **PU-1**: WHEN a patch supplies a subset of mutable fields, THEN the system SHALL apply
  only those fields and SHALL leave every other stored attribute unchanged (TDD:60).
- **PU-2**: IF a patch names a `practiceId` with no stored record, THEN the system SHALL
  respond `404` and SHALL NOT create one (`patch()`'s `attribute_exists` condition — no
  accidental upsert).
- **PU-3**: IF a patch body includes `id`, THEN the system SHALL respond `422` — `id` is
  the primary-key composite and immutable (TDD:72: "update must reject an attempted `id`
  change rather than silently ignoring it").
- **PU-4**: WHEN a patch sets an optional field to `null`, THEN the system SHALL remove
  the attribute so it is genuinely absent, not stored as a literal null (TDD:64-67).
- **PU-5**: WHEN a patch clears `accountManager` to `null`, THEN the system SHALL remove
  the GSI3 index entry, and the practice SHALL NOT appear in any account-manager lookup
  (TDD:68).
- **PU-6**: WHEN a patch changes a GSI partition key — `name` (GSI2), `status` (GSI1), or
  `accountManager` (GSI3) — THEN the system SHALL regenerate that index's keys so the
  record is found under the new value and not the old.
- **PU-7**: WHEN a patch omits a field, THEN the system SHALL leave it untouched;
  omission SHALL NOT be interpreted as a clear (TDD:60 — the explicit contrast with
  `upsertReferral`'s replace semantics).
- **PU-8**: WHEN any patch succeeds, THEN the system SHALL advance `updatedAt` and SHALL
  leave `createdAt` unchanged.
- **PU-9**: IF a patch supplies an empty body `{}`, THEN the system SHALL respond `422`
  rather than issuing a no-op write.

**Delete** — `DELETE /internal/practices/{practiceId}`

- **PD-1**: WHEN a delete names an existing `practiceId`, THEN the system SHALL remove
  the record and respond `204`.
- **PD-2**: IF a delete names a `practiceId` with no stored record, THEN the system SHALL
  respond `404`.
- **PD-3**: WHEN a single practice is deleted, THEN the system SHALL leave all other
  practices intact — distinct from `deleteAllPractices` (TDD:154).
- **PD-4**: WHERE `DELETE /internal/practices` (delete-all) already exists, the system
  SHALL keep its current path, `operationId`, and `204` behavior unchanged.

**Ingest isolation**

- **PI-1**: WHERE `upsertPractice` (`practice-repository.ts:7-21`) serves the Hex ingest,
  the system SHALL leave its signature and merge semantics unchanged, and
  `POST /internal/practices/ingest` SHALL keep passing its existing tests (TDD:55).

### 4.3 Capability: Manage referral records

Derived from TDD:156-162. Entity: `Referral` (`packages/data/src/model/referral.ts`) —
7 required fields (`id`, `leadId`, `fullName`, `cleanReferrerName`,
`referringProviderId`, `practiceName`, `createdDate`, `therapyOrPsychLead`) and
12 optional ones. **Carries PHI** (`fullName`, `mobile`, `email`, stage data).

**Create** — `POST /internal/pcp-referrals`

- **RC-1**: WHEN a create request supplies a valid body with a new `id`, THEN the system
  SHALL persist the referral and respond `201` with the stored record.
- **RC-2**: IF a create request supplies an existing `id`, THEN the system SHALL respond
  `409` with `errorType: "ConflictError"` and SHALL NOT modify the stored record.
- **RC-3**: IF a create request omits any required field, THEN the system SHALL respond
  `422` naming the offending field in `issues`.
- **RC-4**: IF a create request supplies `therapyOrPsychLead` outside `LeadType`
  (`PSYCH_ONLY`, `THERAPY_ONLY`, `BOTH`), or `therapyLeadStage`/`psychLeadStage` outside
  `LeadStage` (`LEAD`, `CONTACT`, `HOLD`, `REGISTERED`, `SCHEDULED`, `PATIENT`), THEN the
  system SHALL respond `422`.
- **RC-5**: WHEN a referral is created, THEN the system SHALL make it retrievable under
  all four GSIs — `practiceName` (GSI1), `cleanReferrerName` (GSI2), `fullName` (GSI3),
  `referringProviderId` (GSI4).

**Read** — `GET /internal/pcp-referrals/{referralId}`, `GET /internal/pcp-referrals`

- **RR-1**: WHEN a detail request names an existing `referralId`, THEN the system SHALL
  respond `200` with every stored attribute including lead type and both stage fields
  (TDD:160).
- **RR-2**: IF a detail request names an unknown `referralId`, THEN the system SHALL
  respond `404`.
- **RR-3**: WHEN a list request supplies exactly one of `practiceName`,
  `cleanReferrerName`, `referringProviderId`, or `fullName`, THEN the system SHALL serve
  it from the matching GSI.
- **RR-4**: IF a list request supplies no filter, THEN the system SHALL respond `422` —
  unfiltered referral listing is not offered, since a table scan over PHI records has no
  operator use case the four lookups don't cover.
- **RR-5**: WHILE more results remain, the system SHALL return a replayable `nextCursor`
  (TDD:160 — "page through results").
- **RR-6**: WHERE GSI1/GSI2/GSI3 use `casing: "upper"` but GSI4
  (`referringProviderId`) uses `casing: "none"` (`referral.ts:131,148,166,182`), the
  system SHALL match the first three case-insensitively and GSI4 case-sensitively.

**Update** — `PATCH /internal/pcp-referrals/{referralId}`

- **RU-1**: WHEN a patch supplies one field, THEN the system SHALL leave all 12 optional
  fields and every other stored attribute untouched. This is the headline guarantee:
  "editing one stage field must not disturb `mobile`, `email`, `networkName`,
  `insuranceCarrier`, or the rest" (TDD:162).
- **RU-2**: IF a patch names an unknown `referralId`, THEN the system SHALL respond `404`
  and SHALL NOT create a record.
- **RU-3**: IF a patch body includes `id`, THEN the system SHALL respond `422`.
- **RU-4**: WHEN a patch sets an optional field to `null`, THEN the system SHALL remove
  that attribute and SHALL leave the other 11 optional fields unchanged.
- **RU-5**: WHEN a patch changes a GSI partition key — `practiceName`,
  `cleanReferrerName`, `referringProviderId`, or `fullName` — THEN the system SHALL
  regenerate that index so the referral is found under the new value and not the old.
- **RU-6**: WHEN a patch succeeds, THEN the system SHALL advance `updatedAt` and leave
  `createdAt` unchanged.
- **RU-7**: IF a patch supplies an empty body `{}`, THEN the system SHALL respond `422`.

**Delete** — `DELETE /internal/pcp-referrals/{referralId}`

- **RD-1**: WHEN a delete names an existing `referralId`, THEN the system SHALL remove it
  and respond `204`.
- **RD-2**: IF a delete names an unknown `referralId`, THEN the system SHALL respond `404`.
- **RD-3**: WHEN one referral is deleted, THEN the system SHALL leave all others intact.
- **RD-4**: WHERE `DELETE /internal/pcp-referrals` (delete-all) already exists, the
  system SHALL keep its path, `operationId`, and `204` behavior unchanged.

**PHI and impermanence**

- **RP-1**: WHERE any referral field flows through the dashboard, the system SHALL NOT
  persist request or response bodies to `localStorage`, `IndexedDB`, or logs
  (`apps/dev-dashboard/README.md:83-84`, TDD:124).
- **RP-2**: WHERE the dashboard offers referral edit or delete, the system SHALL require
  explicit operator confirmation before submitting (TDD:126 — "referral mutation is the
  highest-consequence surface in this document").
- **RP-3**: WHERE the dashboard presents a referral edit form, the system SHALL state
  that edits are overwritten by the next Hex ingest run (TDD:132 — "the UI should not
  imply permanence").
- **RP-4**: WHERE `upsertReferral` (`referral-repository.ts:22-52`) serves the Hex
  ingest, the system SHALL leave its replace semantics unchanged and its existing tests
  passing (TDD:55).

### 4.4 Capability: Preview the monthly batch cohort

Derived from TDD:100-120, 164-168. Read-only. Requires extracting cohort logic and the
pure guard predicates into a shared workspace package (TDD:110).

**Extraction**

- **CX-1**: WHERE `evaluateGuards`, `hasPracticeContactEmail`, and `isPracticeOptedOut`
  (`apps/jobs/batch-runner/src/services/guards.ts:7-26`) are pure functions of a
  `Practice`, the system SHALL relocate them to a shared workspace package consumed by
  both `apps/api` and `apps/jobs/batch-runner`, so preview and batch cannot drift
  (TDD:110 — duplication into `apps/api` "explicitly rejected").
- **CX-2**: WHERE `SkipReason` (`services/skip-reason.ts`) is a plain enum, the system
  SHALL relocate it to the shared package with all three members unchanged
  (`NO_PRACTICE_CONTACT_EMAIL`, `OPTED_OUT`, `BELOW_REFERRAL_FLOOR`).
- **CX-3**: WHERE `emitPracticeSkipped` (`guards.ts:31-38`) emits Datadog counters, the
  system SHALL leave it in `apps/jobs/batch-runner` and SHALL NOT move it into the
  shared package (TDD:107,112 — "a preview must not move batch counters").
- **CX-4**: WHEN the extraction lands, THEN `apps/jobs/batch-runner` SHALL import the
  predicates from the shared package, and its existing tests
  (`__tests__/services/guards.test.ts`, `cohort.test.ts`, `loop.test.ts`,
  `metrics-emission.test.ts`, `outcome.test.ts`) SHALL pass unchanged.
- **CX-5**: WHERE `resolveCohort` (`services/cohort.ts:8-35`) interleaves selection with
  two fire-and-forget Datadog emissions (`:22`, `:31`), the system SHALL extract the
  selection logic such that a caller can resolve the cohort **without** emitting
  `COHORT.PAGE_FETCHED` or `COHORT.SIZE`, while batch-runner keeps emitting both.
- **CX-6**: WHERE the shared package is created, the system SHALL follow the
  `/add-package` checklist — own workspace under `packages/`, not a `common/` umbrella
  (TDD:110; `CLAUDE.md` "Adding a New Package") — including `Dockerfile` manifest/source/dist
  wiring and the `CLAUDE.md` architecture-tree entry.

**Preview endpoint** — `GET /internal/practice-reports/cohort-preview`

- **CP-1**: WHEN a preview request is made, THEN the system SHALL select practices with
  status `SOLD` via `listPracticesByStatus`, matching `resolveCohort`'s selection exactly
  (TDD:106).
- **CP-2**: WHEN the cohort is resolved, THEN the system SHALL evaluate the same guards
  as the batch for each practice and report each as proceed or skip with its
  `SkipReason` (TDD:112,168).
- **CP-3**: WHEN a practice has no non-blank `practiceEmail`, THEN the system SHALL
  report it skipped with reason `NO_PRACTICE_CONTACT_EMAIL` (`guards.ts:7-9,22-24`).
- **CP-4**: WHEN a preview is requested, THEN the system SHALL respond `200` with the
  total cohort size, the count that would proceed, and the skipped entries with reasons.
- **CP-5**: WHILE a preview runs, the system SHALL NOT render a PDF, write a
  `PracticeReportPublished` ledger row, stage anything to S3, send email, or emit any
  batch metric (TDD:112 — read-only).
- **CP-6**: WHERE `isPracticeOptedOut` reads `optedOut`, which is **not** a declared
  attribute on `PracticeEntity` (`services/types.ts:4-5`, `TODO(NEV-1412)` closed
  *Wont fix*), the system SHALL report `OPTED_OUT` for zero practices and SHALL surface a
  caveat that opt-out status was not verified (TDD:114-118 — "Preview must not imply it
  verified opt-out status").
- **CP-7**: WHERE `optedOut` is not a stored attribute, the system SHALL NOT offer it as
  an editable field on the practice edit surface (TDD:120).
- **CP-8**: WHEN a cohort page is fetched during preview, THEN the system SHALL paginate
  to completion so the preview covers the whole cohort, not just the first page.

### 4.5 Cross-cutting: spec-as-contract, auth matrix, lint

Derived from TDD:134-144, copying `pathccm/employer-backend`'s good patterns.

- **X-1**: WHERE every operation the dashboard performs, the system SHALL declare it in
  `docs/openapi-internal.yaml` and reach it through generated types — no hand-rolled
  paths, no dashboard-only operations (TDD:19,142).
- **X-2**: WHEN the server is running, THEN `GET /internal-documentation/json` SHALL list
  every new `operationId`, so missing glue wiring fails a test rather than 404-ing in a
  browser (TDD:140).
- **X-3**: WHERE every `[method, url]` pair on the internal surface, the system SHALL
  return `401` for a missing key and `401` for a wrong key, asserted via a `test.each`
  matrix on the `errorType` discriminator (TDD:139).
- **X-4**: WHEN `pnpm openapi-lint` runs, THEN the internal spec SHALL report no more
  warnings than the 6 present at baseline (§1.1) — every new string carries `maxLength`,
  every array `maxItems`, every integer `minimum`/`maximum`.
- **X-5**: WHERE new operations are added, the system SHALL follow the repo's OpenAPI
  conventions: kebab-case paths, camelCase path params (`{practiceId}` — not
  kebab-case, per the `fastify-openapi-glue` `{(\w+)}` regex limitation), PascalCase
  schemas, camelCase properties, SCREAMING_SNAKE_CASE enum values (`CLAUDE.md`).
- **X-6**: WHEN `task api` regenerates types, THEN `internal-types.ts` and
  `internal-route-handler-types.ts` SHALL be committed in the same change as the spec
  edit, and `tsc --build` SHALL pass across the workspace.
- **X-7**: WHERE the public spec's two `/internal/*/ingest` declarations live
  (`docs/openapi.yaml:523,558`), the system SHALL leave them in place — moving them is
  called out as an open question, not this work (TDD:32,187).
- **X-8**: WHERE new operations need CORS preflight for the browser dashboard, the system
  SHALL declare an `options` operation per new path with `security: []`, matching the
  existing convention, since `corsOptionsDelegate` (`apps/api/src/cors.ts:61-67`) allows
  the local dashboard origin on `-int` hosts.
- **X-9**: WHERE a `409` response is introduced, the system SHALL add a `ConflictError`
  schema and a `ConflictError` class following the existing `errors.ts` pattern
  (subclass `ResponseError`, `statusCode` 409, `errorType` discriminator) — no `409`
  exists anywhere in the repo today.

---

## 5. Derived test cases

Repository tests hit LocalStack DynamoDB (`clearAllItems` in `afterEach`, per
`packages/data/src/__tests__/repository/practice-repository.test.ts:17-26`). Route tests
use `useServerHelper()` + `server.inject()` with `authorization: "Bearer valid-test-key"`
and `vi.mock("../../config")` (per `__tests__/routes/internal-practices-ingest.test.ts`).

### 5.1 `packages/data` — repository layer

`__tests__/repository/practice-repository.test.ts` (extend):

- [ ] `createPractice` persists a new practice with `createdAt`/`updatedAt` → PC-1
- [ ] `createPractice` rejects a duplicate `id` without mutating the stored record → PC-2
- [ ] `createPractice` makes the record findable via `listPracticesByAccountManager` → PC-6
- [ ] `patchPractice` applies one field and leaves the others byte-identical → PU-1
- [ ] `patchPractice` on a missing `id` reports not-found and creates nothing → PU-2
- [ ] `patchPractice` with `practiceEmail: null` removes the attribute (absent, not null) → PU-4
- [ ] `patchPractice` clearing `accountManager` drops the GSI3 entry; AM lookup misses → PU-5
- [ ] `patchPractice` changing `name` moves the GSI2 partition (old miss, new hit) → PU-6
- [ ] `patchPractice` changing `status` moves the GSI1 partition → PU-6
- [ ] `patchPractice` advances `updatedAt`, preserves `createdAt` → PU-8
- [ ] `patchPractice` omitting `practiceEmail` leaves the stored value in place —
      omission is not a clear (the contrast with `upsertReferral`) → PU-7
- [ ] `hasPracticeContactEmail` treats whitespace-only `practiceEmail` as absent → CP-3

`__tests__/repository/referral-repository.test.ts` (extend):

- [ ] `createReferral` persists all required + supplied optional fields → RC-1
- [ ] `createReferral` rejects a duplicate `id` → RC-2
- [ ] `createReferral` is findable under all four GSIs → RC-5
- [ ] **`patchReferral` on one stage field leaves all 12 optional fields intact** → RU-1
      *(the headline guarantee — assert the full stored object, not field-by-field)*
- [ ] `patchReferral` with `mobile: null` removes only `mobile` → RU-4
- [ ] `patchReferral` changing `practiceName` moves GSI1 → RU-5
- [ ] `patchReferral` changing `fullName` moves GSI3 → RU-5
- [ ] `patchReferral` on a missing `id` creates nothing → RU-2
- [ ] existing `upsertPractice`/`upsertReferral` suites still pass untouched → PI-1, RP-4

### 5.2 `apps/api` — routes

`__tests__/routes/internal-practices-crud.test.ts` (new):

- [ ] `POST` valid → `201` + stored body → PC-1
- [ ] `POST` duplicate `id` → `409` / `ConflictError` → PC-2
- [ ] `POST` missing `name` → `422` → PC-3
- [ ] `POST` bad `status` enum → `422` → PC-4
- [ ] `POST` with `createdAt` supplied → `422` → PC-5
- [ ] `GET` detail existing → `200`, absent optionals omitted → PR-1
- [ ] `GET` detail unknown → `404` / `NotFoundError` → PR-2
- [ ] `GET` list unfiltered → `200` + page → PR-3
- [ ] `GET` list by each of name/status/accountManager → `200` → PR-4
- [ ] `GET` list `limit=0` and `limit=101` → `422` → PR-6
- [ ] `GET` list name lookup is case-insensitive → PR-7
- [ ] cursor replay returns page 2 with no repeats/gaps → PR-5
- [ ] `PATCH` partial → `200`, untouched fields preserved → PU-1
- [ ] `PATCH` unknown id → `404` → PU-2
- [ ] `PATCH` body containing `id` → `422` → PU-3
- [ ] `PATCH` `{"practiceEmail": null}` → field absent on re-read → PU-4
- [ ] `PATCH` `{}` → `422` → PU-9
- [ ] `DELETE` existing → `204` → PD-1
- [ ] `DELETE` unknown → `404` → PD-2
- [ ] `DELETE` one leaves siblings intact → PD-3
- [ ] `DELETE /internal/practices` (all) still `204` → PD-4

`__tests__/routes/internal-pcp-referrals-crud.test.ts` (new):

- [ ] `POST` valid → `201` → RC-1
- [ ] `POST` duplicate `id` → `409` → RC-2
- [ ] `POST` missing a required field → `422` naming it in `issues` → RC-3
- [ ] `POST` bad `therapyOrPsychLead` / `therapyLeadStage` enum → `422` → RC-4
- [ ] `GET` detail existing → `200` incl. lead type + both stage fields → RR-1
- [ ] `GET` detail unknown → `404` → RR-2
- [ ] `GET` list by each of practiceName/cleanReferrerName/referringProviderId/fullName → RR-3
- [ ] `GET` list with no filter → `422` → RR-4
- [ ] cursor replay pages without repeats/gaps → RR-5
- [ ] `GET` list by `referringProviderId` is case-**sensitive** (GSI4 `casing: "none"`);
      the other three are case-insensitive → RR-6
- [ ] **`PATCH` one stage field over a fully-populated referral → every other field
      byte-identical** → RU-1
- [ ] `PATCH` unknown id → `404`, creates nothing → RU-2
- [ ] `PATCH` body containing `id` → `422` → RU-3
- [ ] `PATCH` `{"mobile": null}` → only `mobile` absent → RU-4
- [ ] `PATCH` `{}` → `422` → RU-7
- [ ] `PATCH` succeeds → `updatedAt` advanced, `createdAt` unchanged → RU-6
- [ ] `DELETE` existing → `204` → RD-1
- [ ] `DELETE` unknown → `404` → RD-2
- [ ] `DELETE` one leaves siblings intact → RD-3
- [ ] `DELETE /internal/pcp-referrals` (all) still `204` → RD-4

`__tests__/routes/internal-cohort-preview.test.ts` (new):

- [ ] preview returns only `SOLD` practices → CP-1
- [ ] practice without `practiceEmail` reported skipped `NO_PRACTICE_CONTACT_EMAIL` → CP-3
- [ ] practice with valid email reported as proceeding → CP-2
- [ ] response carries cohort size, proceed count, skip list → CP-4
- [ ] **no Datadog counter/gauge emitted during preview** (spy on `stats.sendCounter`
      and `sendGauge`, assert zero batch-metric calls) → CP-5
- [ ] no ledger row written, no S3 call, no email → CP-5
- [ ] `OPTED_OUT` count is zero and the caveat field is present → CP-6
- [ ] cohort spanning multiple pages is fully enumerated → CP-8

`__tests__/routes/internal-auth-matrix.test.ts` (new):

- [ ] `test.each` over every internal `[method, url]`: no header → `401` /
      `AuthenticationError` → AUTH-3, X-3
- [ ] `test.each` same pairs: wrong key → `401` → AUTH-4, X-3
- [ ] non-`Bearer` scheme → `401` → AUTH-5
- [ ] valid `Bearer` key → not `401` → AUTH-2
- [ ] every `options` operation → `204` without auth → AUTH-7

`__tests__/routes/internal-spec-contract.test.ts` (new):

- [ ] `GET /internal-documentation/json` lists every new `operationId` → X-2
- [ ] served internal spec declares `apiKeyAuth` as `type: http, scheme: bearer` → AUTH-1
- [ ] served internal spec lists local, dev-int, prod-int servers → AUTH-6

### 5.3 Shared cohort package

`packages/<cohort-pkg>/src/__tests__/guards.test.ts` (moved from batch-runner):

- [ ] `evaluateGuards` table-driven cases port over unchanged → CX-1, CX-4
- [ ] `SkipReason` retains all three members → CX-2
- [ ] package exports no Datadog/observability dependency → CX-3

`apps/jobs/batch-runner` (existing, must stay green):

- [ ] `guards.test.ts`, `cohort.test.ts`, `loop.test.ts`, `metrics-emission.test.ts`,
      `outcome.test.ts` all pass against the shared imports → CX-4
- [ ] batch-runner still emits `COHORT.PAGE_FETCHED` and `COHORT.SIZE` → CX-5

### 5.4 Dashboard (Phase 6, see §2)

- [ ] destructive referral action requires confirmation before firing a request → RP-2
- [ ] referral edit form shows the ingest-overwrite warning → RP-3
- [ ] no response body reaches `localStorage`/`sessionStorage` (spy on setters) → RP-1
- [ ] cohort preview view renders the opt-out caveat → CP-6
- [ ] practice edit form exposes no `optedOut` control → CP-7

---

## 6. Implementation phases

Ordered so each phase is independently reviewable and leaves the tree green. Phase 1
ships alone and first (TDD:96 — "corrected before new operations are added").

### Phase 1 — Auth scheme + servers correction

Files: `docs/openapi-internal.yaml`, generated types, new contract test.

- [ ] Change `apiKeyAuth` to `type: http, scheme: bearer` with the description mirroring
      `docs/openapi.yaml:604-611` → AUTH-1
- [ ] Add local (`http://localhost:3024`) and dev-int `servers` entries → AUTH-6
- [ ] `task api` → commit regenerated `internal-types.ts` + `internal-route-handler-types.ts` → X-6
- [ ] Add `internal-spec-contract.test.ts` asserting the served scheme and servers
- [ ] Add `internal-auth-matrix.test.ts` over the two existing operations (extended in
      later phases as operations land) → X-3
- [ ] `pnpm openapi-lint` — confirm still 6 warnings, no new ones → X-4

**Why alone**: it's the one change that alters an existing published contract. Reviewable
in isolation, and Swagger UI "Try it out" against `/internal-documentation` starts
working, which makes every later phase manually verifiable.

### Phase 2 — Data layer: create + patch for both entities

Files: `packages/data/src/repository/{practice,referral}-repository.ts`,
`repository/types.ts`, `errors.ts`, repository tests.

- [ ] Add `ConflictError` to `packages/data/src/errors.ts` (mirrors the existing
      `NotFoundError` shape) → X-9
- [ ] `createPractice` / `createReferral` via ElectroDB `create()` +
      `.go({ returnOnConditionCheckFailure: true })`, mapping `rejected` → `ConflictError` → PC-2, RC-2, §1.2
- [ ] `patchPractice` / `patchReferral` via `patch()`, splitting the input into
      set-fields and null-fields (`.remove([...])`), and `.composite({ id })` when a GSI
      partition key changes → PU-1…PU-8, RU-1…RU-6, §1.4
- [ ] Type inputs with the existing, unused `PatchFields` / `IdentityFields` generics
      from `model/types.ts:164-199` → §1.5
- [ ] Extend `IPracticeRepository` / `IReferralRepository` in `repository/types.ts`
- [ ] Write §5.1 tests, including the GSI-migration and null-clearing cases
- [ ] Leave `upsertPractice` / `upsertReferral` and both `delete*` methods untouched → PI-1, RP-4

**Risk**: §1.3 and §1.4 are read from ElectroDB source, not yet exercised against
LocalStack. The GSI-clearing test (PU-5) and GSI-migration tests (PU-6, RU-5) are the
first place a wrong reading surfaces — write those before the route layer depends on them.

### Phase 3 — Practice CRUD API

Files: `docs/openapi-internal.yaml`, `apps/api/src/routes/internal/practices.ts`,
`apps/api/src/service/practice-service.ts`, `apps/api/src/errors.ts`, route tests.

- [ ] Add `ConflictError` class + `ConflictErrorResponse`/`ConflictError` schema to the
      internal spec and `apps/api/src/errors.ts` → X-9
- [ ] Declare `POST /internal/practices`, `GET /internal/practices`,
      `GET|PATCH|DELETE /internal/practices/{practiceId}` with `options` siblings → X-1, X-5, X-8
- [ ] Nullable optional fields via `nullable: true` (§1.6); `additionalProperties: false`
      so `id`/`createdAt` in a patch body 422s → PU-3, PC-5
- [ ] `task api`; implement handlers against generated route-handler types
- [ ] Service functions delegating to the repository; map `ConflictError` → 409,
      not-found → 404
- [ ] Write §5.2 practice route tests; extend the auth matrix with the new pairs
- [ ] `pnpm openapi-lint` → no new warnings → X-4

*Naming check*: the spec already has a public `getPractice`/`listPractices`
(`docs/openapi.yaml:82,194`). Internal `operationId`s must not collide across the two
glue registrations — use `createPractice`, `getInternalPractice`, `listInternalPractices`,
`updatePractice`, `deletePractice`. Verify at the `/internal-documentation/json`
contract test (X-2).

### Phase 4 — Referral CRUD API

Same shape as Phase 3 for `/internal/pcp-referrals`, plus:

- [ ] All 12 optional fields declared nullable → RU-4
- [ ] Enum-constrained `therapyOrPsychLead`, `therapyLeadStage`, `psychLeadStage` → RC-4
- [ ] Filter-required list validation → RR-4
- [ ] Write §5.2 referral route tests, leading with the RU-1 "touch nothing else" case

### Phase 5 — Shared cohort package + preview endpoint

- [ ] `/add-package` for the shared package (own workspace, not `common/`; Dockerfile
      manifest+source+dist wiring; `CLAUDE.md` tree entry) → CX-6
- [ ] Move `guards.ts` pure predicates + `skip-reason.ts` + `PracticeWithGuardFields` in;
      leave `emitPracticeSkipped` in batch-runner → CX-1, CX-2, CX-3
- [ ] Split cohort resolution from metric emission so preview resolves without emitting → CX-5
- [ ] Repoint batch-runner imports; confirm its five test files pass unchanged → CX-4
- [ ] Add `@attribution-service/<pkg>` to `apps/api/package.json`; `pnpm install`
- [ ] Declare + implement `GET /internal/practice-reports/cohort-preview` → CP-1…CP-8
- [ ] Preview response carries an explicit opt-out caveat field → CP-6
- [ ] Write §5.2 preview tests, including the zero-batch-metrics assertion

### Phase 6 — Dashboard pages (separable, see §2)

- [ ] Stand up Vitest + jsdom + `@testing-library/react` in `apps/dev-dashboard`
      (`vitest.config.ts`, drop `--passWithNoTests`) → §1.7
- [ ] `PracticeList` / `PracticeDetail` / `CreatePracticeForm` + delete-confirm dialog;
      same triplet for referrals (TDD:138 — one triplet per entity, not one page per endpoint)
- [ ] Cohort preview page (read-only) with the opt-out caveat rendered → CP-6
- [ ] Type all calls against `apps/api/src/generated/internal-types.ts` `components["schemas"]` → X-1, §1.8
- [ ] Confirmation gate on referral edit/delete → RP-2
- [ ] Ingest-overwrite warning on referral edit → RP-3
- [ ] No `optedOut` control on the practice form → CP-7
- [ ] Write §5.4 tests
- [ ] Confirm `apps/dev-dashboard/**` stays out of the Dockerfile and in
      `deploy-eks.yml` `paths-ignore` (TDD:30)

---

## 7. Open questions carried forward

From TDD:183-191, with a recommendation each. None block Phase 1–2.

| TDD open question | Recommendation |
|---|---|
| Move the two `/internal/*/ingest` ops from public → internal spec? | **No, not here.** Breaking change to a published spec with a live Hex caller. X-7 keeps them put. |
| Add the internal spec to Spectral linting? | **Already done** — §1.1. Question is closed; X-4 keeps it clean. |
| Should referral create validate like Hex ingest, or looser for fixtures? | **Same validation.** Looser input invites fixtures the batch can't process; RC-3/RC-4 assume parity. |
| Should cohort preview accept status/AM filters? | **No filters in v1.** CP-1 mirrors `resolveCohort` exactly; a filter makes preview diverge from what it predicts. |
| Page size 25, and server- vs client-side pagination? | **Server-side, `limit` 1–100, default 25.** Matches repository defaults; PR-6 bounds it. Referrals carry PHI — don't fetch-and-filter whole sets into the browser. |

Additional questions this plan surfaced:

- **`nullable: true` vs `type: [x, "null"]`** — plan picks the former for consistency
  (§1.6, deviation #2). Reviewer may prefer strict 3.1 and a separate sweep of the
  public spec's existing `nullable` usages.
- **Phase 6 scope** — is standing up dashboard test infrastructure in scope, or does the
  UI ship untested for now? (§2)
- **`deletePractice`/`deleteReferral` string-matched conditional checks** — noted in
  §1.2 as fragile; deliberately not fixed here. Worth a follow-up ticket.
