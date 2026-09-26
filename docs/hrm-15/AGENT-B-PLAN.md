# HRM-15 — Agent B plan (Block 1: audit and preparation)

Scope: CONTRACT.md §4, PRD §7/§9/§10, in the files OWNERSHIP.md gives Agent B.
Everything below marked **[A]** waits for `docs/hrm-15/AGENT-A-PUBLISHED.md`.
Line numbers are at `85f15eaf4`.

## 0. Already committed in Block 1 (no Agent A dependency)

| File | What |
|---|---|
| `src/modules/hr/directory/reporting-manager-columns.ts` (+ spec, 11 tests) | `normaliseManagerColumns(row)` — THE manager-column normaliser. Maps `reportingManagerEmail` / `reportsTo` / `managerEmail` (loose header match: case, space, `_`, `-`) to `primaryManagerEmail`, reads `secondaryManagerEmail1..3`, blank → `null`, returns `legacyHeader` for telemetry, refuses conflicting headers (`{ ok:false, conflictingColumns }`). |
| `dto/reporting-lines-shared.schemas.ts` | `managerRef`, `RelationshipEntry`, source enum (§1.1), resolution enum, params schemas `employeeUserId` / `requestId` (uuid) / `jobId` (uuid). |
| `dto/reporting-lines-line.schemas.ts` | §4.1–4.7, §4.13: policy GET/PATCH, line detail (extends today's `reportingLineViewSchema`), PUT body/response, candidates query (clamped to 20), coverage detail (extends today's), `/me/reporting-line`. |
| `dto/reporting-lines-requests.schemas.ts` | §4.8–4.12, §4.14–4.16. |
| `dto/reporting-lines-bulk.schemas.ts` | §4.17–4.19 bulk jobs, §4.20 onboarding preview + commit result, §4.21 `primaryManager`. |
| `dto/reporting-lines-contract.schemas.spec.ts` | 9 parse tests. |

Request schemas are structural only; every PRD §6 rule is left to the canonical service so the
response carries the contract `code` (a Zod 400 has none). Nothing is wired, so `check:dead-code`
may report the new exports until Block 2. ts-jest runs `isolatedModules`, so these files have NOT
been type-checked (no tsc in this block).

## 1. Findings that change the plan

1. **Onboarding is already atomic over HTTP.** `TenantContextInterceptor`
   (`common/tenant/tenant-context.interceptor.ts:109`) wraps the handler in `withTenant`, the route
   has no `@NoTenantTransaction`, and `runInTenantTransaction` reuses the ambient transaction. So
   `employee-onboarding.service.ts:266` (`this.reportingLines.assign` after the admission block)
   rolls back with the request. CONTRACT §0 "not atomic" overstates it: the defect is that the
   atomicity is inherited and undeclared. The fix still moves the writes into the callback
   (explicit, and a spec can pin it), but it is not a data-loss bug today.
2. **The employment row is also written outside the callback** (`ensureFromUser`, `:248`), and the
   line needs it. Moving the line write in means moving `ensureFromUser` (`:248-258`),
   `syncCanonicalEmploymentFields` (`:260-264`) and the sensitive-field upsert (`:276-294`) in too.
3. **Four more writers go through `ReportingLineService.assign/assignMany`** and bypass source,
   reason, frequency guard and top-level rules: `employee-mutations.service.ts:384-393` (mine),
   `users/users.service.ts:256`, `users/user-ops.service.ts:217` (bulk), `users/user-profile.service.ts:183`.
   **Question for A/main:** does `assign` become a thin adapter over `setRelationships` (source
   `MANUAL`), or do I migrate all four callers? The `users/*` files are mine only "if a call
   signature changes".
4. **The effective-change applier cannot call `setRelationships` as specified.** `applyManager`
   (`hr-effective-change-applier.service.ts:286-367`) has employment ids, a possibly **bounded**
   `effectiveTo` (`:365`), and a **null actor** from the cron sweep (`cron-hr-engines.service.ts:58`).
   The §2 command takes `subjectUserId`/`managerUserId`, no `effectiveTo`, and a non-null `actor`.
   A manager employment's person can have no user (`hrPeople.userId` is nullable). **[A] needs:**
   an employment-keyed entry (or accept ids), optional `effectiveTo`, and a system actor.
5. **Staged-import rollback of an employee row is broken today.** `rollbackRef` deletes `hr_people`
   only (`hr-import-commit.service.ts:627-629`); `fk_hr_employments_org_person` is `ON DELETE RESTRICT`
   (`db/schema/hr/core-people.ts:178-182`) and `ensureFromUser` always creates an employment, so the
   rollback 23503s → 500. Reporting lines of created employees would cascade only if the employment
   were deleted. Lines written for `updated` rows are never undone (`hr-import.service.ts:405-411`
   skips non-`created`) — that is the existing rollback contract and I will keep it, but the rollback
   UI must say "manager changes are not reverted".
6. **Staged-import rows commit in uuid order** (`hr-import.service.ts:254`, `orderBy(asc(hrImportRows.id))`),
   not row order, so an in-file manager cannot be relied on to exist first.
7. **Two inert rate limits in my controller:** `resend-invite` and `invite-link`
   (`employees.controller.ts:100-129`) carry `@UseRateLimit` but no `@UseGuards(RateLimitGuard)`;
   the guard is not global (`common/ratelimit/rate-limit-coverage.spec.ts:192`). One-line fix each,
   out of HRM-15 scope — **main agent: include or not?**
8. **Fire-and-forget on the request tx:** `employee-onboarding.service.ts:197`
   `void this.automation.runAutomationsForEvent(...)` (BE-82). `runAutomationsForEventDetached`
   exists (`automation/automation.service.ts:61`). Fix while I am in the file.
9. `reporting-lines.controller.ts:19` declares its params schema inline (BE-16). Moves to
   `dto/reporting-lines-shared.schemas.ts` (done there already).
10. `hr-import-commit.service.ts:155` has `tx as unknown as Db` (hard-zero gate). I will pass `tx`
    typed as `DbOrTx` when I touch that call.
11. Staged-import routes (`hr-import.controller.ts:54-115`) have no `@Idempotent`. Commit is guarded
    by the `previewed` status check, so a retry 400s rather than duplicating; adding the fence makes
    the header required (API change). **Default: add `@Idempotent("hr.import.jobs.commit")` only.**

## 2. Integrations

### 2.1 Single onboarding — `POST /hr/employees/onboard` (§4.21) **[A]**
- `dto/hr-directory.schemas.ts:278-305` `requireReportsTo`: drop the "manager or top-level required"
  branch (`:294-296`); keep top-level exclusivity and reason. Add
  `secondaryManagers: z.array(secondaryManagerInputSchema).max(3).optional()` to
  `onboardEmployeeFieldsSchema` (`:307`). Rewrite `dto/onboard-reports-to.spec.ts` accordingly.
- `employee-onboarding.service.ts:103-110`: delete the pre-check (`checkManager`); the canonical
  service validates inside the transaction.
- `:121-195`: inside the `runInTenantTransaction` callback, after `syncOrgUnitPlacement`:
  `ensureFromUser(..., tx)` (moved from `:248`), department sync (moved from `:260`), then
  `ReportingManagerFallbackResolver.resolve(orgId, actor, row, tx)` when no manager and not top-level,
  then `ReportingRelationshipService.setRelationships(tx, { subjectUserId, primaryManagerUserId,
  topLevelReason, secondary, effectiveFrom: joiningDate ?? org-local today, source:
  ONBOARDING_SELECTED|ONBOARDING_FALLBACK })`. Sensitive-field upsert moves in as well.
  `NO_DEFAULT_REPORTING_MANAGER` → 400 before admission commits.
- Delete `:266-274`. Audit metadata (`:243-244`) gains `primaryManagerResolution`.
- Response (`dto/directory-response.schemas.ts:313`, `onboardResponseSchema`): add
  `primaryManager: onboardPrimaryManagerSchema.nullable()`; `resolution` only when
  `access.can(actor, "hr:employees:view")`. NB: the payload carries `success`, so BE-19 passes it
  through **unwrapped** — Agent C reads top level.
- Cache: add `hierarchyCache.invalidateAfterMutation(orgId)` (missing today, `:296-298`).
- Specs: `employee-onboarding-validation.spec.ts`, `employee-onboarding-tenant-isolation.spec.ts`,
  `employee-onboarding-lock-ordering.spec.ts` (order of the moved writes), new
  `employee-onboarding-reporting-line.spec.ts`: fallback chosen, top-level, secondary cap refusal
  rolls back admission.

### 2.2 Bulk onboarding — preview + commit (§4.20) **[A]**
- Row DTO (`hr-directory.schemas.ts:392-416`): add `primaryManagerEmail`, `secondaryManagerEmail1..3`,
  `effectiveFrom` (`z.iso.date()`), keep `reportingManagerEmail`; drop `requireReportsTo`'s
  required-branch. Service passes each row through `normaliseManagerColumns` (DTO keys are the two
  JSON names; conflict → row ERROR `MANAGER_COLUMN_CONFLICT`, see §5 Q5). `legacyHeader` counted into
  audit metadata `legacyManagerHeader: true` + count.
- Split `onboardEmployeesBulk` (`employee-bulk-onboarding.service.ts:64-169`) into
  `plan(actor, rows, db)` (everything up to `:120`, no writes except `ensureDepartments` — which
  **writes** at `:76`; preview must call a read-only variant: departments that would be created
  become a WARNING) and `commit`. Preview = `plan` + `validateMany` + `resolveMany`, returns
  §4.20 shape, no writes.
- `bulk-onboarding-plan.ts:117-137` `resolveReportingManager` → reads normalised primary +
  secondaries; in-file emails stay `IN_FILE`. `:277-328` `rejectCyclesAndOrphans` already produces
  "failed on row N" — change it to status `SKIPPED`, `codes: ["MANAGER_ROW_FAILED"]`,
  `dependsOnRow`, manager email in the message. Secondary in-file managers join the same edge set for
  ordering (not for cycles — cycles are primary-only).
- `employee-bulk-onboarding.service.ts:171-186` `rejectRowsWithUnassignableManagers` (N `checkManager`
  calls) → replaced by one `validateMany` **[A]**.
- `bulk-onboarding-writes.ts:198-230`: `deps.reportingLines.assign` → `setRelationships(tx, …, source:
  BULK_ONBOARDING)` in `managersFirst` order; blank rows use the resolver result
  (`ONBOARDING_FALLBACK`). `BulkOnboardWriteDeps` (`:35-40`) swaps `reportingLines` for the two A
  services.
- Commit result (`directory-response.schemas.ts:324-329`): replace with
  `bulkOnboardCommitResultSchema` (adds `status`, `codes`, `primaryManager`, top-level `skipped`).
  `bulk-onboarding.types.ts:4-10` `BulkOnboardRowResult` gains the same fields.
- Transaction: whole file stays one request transaction (as today). A write-time refusal the
  preview did not predict aborts the file (409) rather than half-writing — PRD §7.6.5 "never
  silently partially update". Per-dependency-set savepoints only if A's `validateMany` can disagree
  with `setRelationships` in practice.
- Idempotency: commit keeps `hr.employees.onboard-bulk`; preview writes nothing → no fence.
- Specs: `bulk-onboarding-plan.spec.ts`, `bulk-onboarding-graph.spec.ts`,
  `employee-bulk-onboarding-query-count.spec.ts` (query budget must stay flat with fallback rows),
  `bulk-duplicate-guard.spec.ts`.

### 2.3 Job history for bulk onboarding — **do not reuse `hr_import_jobs`**
- `hr_import_rows.payload` is jsonb of the raw row (`db/schema/hr/import-jobs.ts:78`); a bulk
  onboarding row carries `taxId`, `bankDetails`, `monthlySalary` — persisting it stores unsealed PII
  that today is only ever written sealed (`bulk-onboarding-writes.ts:65-68`).
- `hr_import_jobs.status='committed'` makes a job rollback-able (`hr-import.service.ts:374-420`);
  rolling back an onboarding job would hit the RESTRICT FK (§1.5) or silently do nothing.
- Onboarding has no preview persistence in §4.20 ("no writes"), so the job would only ever be born
  `committed`.
- **Default:** job history = the existing `hr.employees_bulk_onboarded` critical audit event
  (`employee-bulk-onboarding.service.ts:150-160`) enriched with per-row `{row, email, status, codes}`
  and `legacyManagerHeader`, plus the idempotent replay of the response. A dedicated table is Agent
  A's call if the main agent wants a history screen (§5 Q3).

### 2.4 Staged import `employees` entity (§4.22) **[A]**
- `import/schemas/entity-row-schemas.ts:92-115` `employeeRowSchema`: replace `managerEmail` with
  `primaryManagerEmail`, `secondaryManagerEmail1..3`, `topLevelRoleReason`, `effectiveFrom`,
  `clearPrimaryManager` (boolean-ish cell); resolved keys `resolvedPrimaryManagerUserId`,
  `resolvedSecondaryManagerUserIds`. Refinement: `clearPrimaryManager` only with `topLevelRoleReason`.
- `hr-import.service.ts:64-71` `createJob`: for `entity === "employees"`, map rows through
  `normaliseManagerColumns` before `validateRows`; conflict → row error. Count legacy headers into the
  job's audit.
- `hr-import-preflight.ts:196-294` `resolveEmployees`: manager lookup moves from
  `employmentsByEmail` (employment ids) to active members by email (user ids); in-file roster emails
  accepted; existing employees with all manager cells blank → no relationship command at all
  (blank = no change); new employees with blank primary → fallback via `resolveMany` **[A]**
  (preview shows the resolved name + `FALLBACK_*`).
- `hr-import-commit.service.ts:178-181, 240-326`: delete `applyImportedManager` (half-open close at
  `:311`, own cycle CTE `:282-300`); call `setRelationships(tx, { source: STAGED_IMPORT,
  secondary: undefined unless a secondary cell is filled, ... })`. `ImportCommitContext` (`:53-58`)
  gains `actor: CurrentUserContext` (fallback needs it) — `hr-import.controller.ts:101` passes `u`.
- `hr-import.service.ts:241-300` commit loop: two passes — rows without an in-file manager, then
  rows with one in `managersFirst` order (reuse `bulk-onboarding-graph.ts`); a dependant whose
  manager row failed becomes `error` "manager failed on row N (email)". Row error text becomes
  `"<CODE>: <message>"` so the code survives the savepoint catch (`:289-296`).
- Rollback: unchanged contract (`created` rows only); fix §1.5 by deleting the employment before the
  person **only if main agent agrees it is in scope**.
- Specs: `hr-import-preflight.spec.ts`, `hr-employee-import.db.spec.ts`,
  `hr-import-tenant-isolation.spec.ts`, `schemas/entity-row-schemas.spec.ts`,
  `__tests__/hr-import-row-savepoint.db.spec.ts`.

### 2.5 Replace the rogue writers **[A]**
- `hr-import-commit.service.ts:250 applyImportedManager` → §2.4.
- `hr-effective-change-applier.service.ts:286-367 applyManager` → `setRelationships(tx, { source:
  EFFECTIVE_CHANGE, skipFrequencyGuard: true, effectiveFrom: change.effectiveFrom,
  effectiveTo: change.effectiveTo })` once §1.4 is answered. The `sameStart` 409 (`:332-344`) stays
  the canonical service's call. `applyDue`'s UTC cutoff (`:65`) should become org-local (PRD §10.10).
- After both: `grep -rn "insert(hrReportingLines)\|update(hrReportingLines)" src/modules` must return
  only Agent A's writer.

### 2.6 Notifications (after commit)
- Mechanism: `NotificationDispatchService.emit` (`notifications/notification-dispatch.service.ts:78`)
  inside the transaction — it writes a deduped intent row in the ambient tx and drains it on commit
  (PIPE-001, "the one way to emit a notification"). This is stricter than §4's "NotificationsService
  after commit" and gives the dedupe PRD §10.9 asks for. **Deviation to confirm (§5 Q1).**
- HR-reviewer fan-out example: `hr/lifecycle/exit-write.service.ts:389-408`
  (`access.membersWithPermission(orgId, "hr:exit:manage")` → `dispatch.emit`); also
  `expenses/expense-outbox.consumer.ts:142`.
- Events (need entries in `notifications/notification-events-hr.catalog.ts` — **unowned, main agent**):
  `hr.reporting_manager_request.created` → `membersWithPermission("hr:reporting-lines:review")`,
  one actionable notification, no employee reason in the message;
  `hr.reporting_manager_request.decided` → employee (reason visible); on APPROVE also
  `hr.reporting_line.changed_by_request` → incoming + outgoing primary (no free text);
  `hr.reporting_line_bulk_job.committed` → one summary to the committing HR user.
  Recipients resolved in the tx (BE-86); `dedupeKey` per request/job id.

### 2.7 Cache invalidation after commit
- Every line-writing command: `OrgHierarchyCacheService.invalidateAfterMutation(orgId)`
  (`common/cache/org-hierarchy-cache.service.ts:77`, already registers after commit) +
  `cache.invalidateNamespace(CACHE_KEYS.hrEmployeesListNamespace(orgId))` via `registerAfterCommit`
  (BE-85 fallback inline), as `employee-bulk-onboarding.service.ts:205-215` does. Onboarding single
  path lacks the hierarchy call today. Policy PATCH: no reporting-line cache exists, nothing extra.

### 2.8 Rate limits (tiers live in `common/ratelimit/rate-limit.service.ts:10`, **unowned**)
- Existing: `hr:employee-bulk-onboard` 10/h (`:117`), used by `POST onboard/bulk` with
  `RateLimitGuard` (`employees.controller.ts:135-136`), pinned by `hr/hr-command-safety.spec.ts:36-40`.
- Proposed new tiers (main agent adds; I decorate + add `RateLimitGuard`):
  `hr:employee-bulk-onboard-preview` 60/h, `hr:reporting-line-bulk-preview` 30/h,
  `hr:reporting-line-bulk-commit` 10/h. Sharing the commit tier with preview would spend the
  10/h budget on dry runs. Self-service request create needs none (unique active-request index).

## 3. Routes (§4) — controller, exposure, fence, schemas

All controllers: `@RequireModule("hr")`, `@UseGuards(JwtAuthGuard, PermissionGuard)`. Every handler
gets `@ResponseSchema`; every param goes in a `.strict()` params schema (BE-14/27).

| # | Route | Controller file | Exposure (BE-30) | `@Idempotent` scope | Body/query/params | Response |
|---|---|---|---|---|---|---|
| 1 | GET `/hr/reporting-manager-policy` | new `reporting-manager-policy.controller.ts` | `hr:employees:view` | — | — | `reportingManagerPolicySchema` |
| 2 | PATCH same | same | `hr:reporting-lines:override` | `hr.reporting-manager-policy.update` | `updateReportingManagerPolicySchema` | same |
| 3 | GET `/hr/reporting-lines/:employeeUserId` | `reporting-lines.controller.ts:37` | `hr:employees:view` + `resolveEmployeesScope` | — | `employeeUserIdParamsSchema` | `reportingLineDetailSchema` |
| 4 | PUT same | same | `hr:reporting-lines:manage` + scope check | `hr.reporting-lines.set` | params + `setReportingLineSchema` | `setReportingLineResponseSchema` |
| 5 | POST `…/:employeeUserId/confirm-fallback` | same | `hr:reporting-lines:manage` | `hr.reporting-lines.confirm-fallback` | params, `@BodylessAction()` | `reportingLineDetailSchema` |
| 6 | GET `/hr/reporting-lines/manager-candidates` | same, **declared before `:employeeUserId`** | `hr:employees:view` | — | `managerCandidatesQuerySchema` | `managerCandidatesResponseSchema` |
| 7 | GET `/hr/reporting-lines/coverage` | same (`:30`) | `hr:employees:view` | — | — | `managerCoverageDetailSchema` |
| 8 | POST `/me/reporting-manager-requests` | new `reporting-manager-requests-me.controller.ts` | `@Universal()` + self check | `self.reporting-manager-requests.create` | `createReportingManagerRequestSchema` | `myReportingManagerRequestSchema` (201) |
| 9 | GET same | same | `@Universal()` | — | `listMyReportingManagerRequestsSchema` | `myReportingManagerRequestPageSchema` |
| 10 | POST `…/:requestId/cancel` | same | `@Universal()` | `self.reporting-manager-requests.cancel` | `reportingManagerRequestIdParamsSchema`, bodyless | `myReportingManagerRequestSchema` |
| 11 | POST `…/:requestId/respond` | same | `@Universal()` | `self.reporting-manager-requests.respond` | params + `respondReportingManagerRequestSchema` | same |
| 12 | GET `/me/reporting-manager-requests/manager-candidates` | same | `@Universal()` | — | `myManagerCandidatesQuerySchema` | `managerCandidatesResponseSchema` |
| 13 | GET `/me/reporting-line` | new `my-reporting-line.controller.ts` | `@Universal()` | — | — | `myReportingLineSchema` |
| 14 | GET `/hr/reporting-manager-requests` | new `reporting-manager-requests.controller.ts` | `hr:reporting-lines:review` | — | `listReportingManagerRequestsSchema` | `hrReportingManagerRequestPageSchema` |
| 15 | GET `…/:requestId` | same | `hr:reporting-lines:review` | — | params | `hrReportingManagerRequestSchema` |
| 16 | POST `…/:requestId/review` | same | `hr:reporting-lines:review` | `hr.reporting-manager-requests.review` | params + `reviewReportingManagerRequestSchema` | `reviewReportingManagerRequestResponseSchema` |
| 17 | POST `/hr/reporting-lines/bulk-jobs` | new `reporting-line-bulk-jobs.controller.ts` | `hr:reporting-lines:manage` | `hr.reporting-line-bulk-jobs.preview` | `createBulkJobSchema` | `bulkJobSchema` (201) |
| 18 | POST `…/bulk-jobs/:jobId/commit` | same | `hr:reporting-lines:manage` | `hr.reporting-line-bulk-jobs.commit` | params + `commitBulkJobSchema` | `bulkJobSchema` |
| 19a | GET `…/bulk-jobs` | same | `hr:reporting-lines:manage` | — | `listBulkJobsSchema` | `bulkJobPageSchema` |
| 19b | GET `…/bulk-jobs/:jobId` | same | `hr:reporting-lines:manage` | — | params + `getBulkJobSchema` | `bulkJobSchema` |
| 19c | GET `…/bulk-jobs/:jobId/failures.csv` | same | `hr:reporting-lines:manage` | — | params | `text/csv` via `@Res()` + `@ApiOkResponse`, as `hr-import.controller.ts:117-149` |
| 20 | POST `/hr/employees/onboard/bulk/preview` | `employees.controller.ts` (before `onboard/bulk`) | `hr:onboarding:manage` | none (no writes) | `bulkOnboardEmployeesSchema` | `bulkOnboardPreviewSchema` |
| 20' | POST `/hr/employees/onboard/bulk` | `employees.controller.ts:131` | unchanged | `hr.employees.onboard-bulk` | unchanged DTO + new fields | `bulkOnboardCommitResultSchema` |
| 21 | POST `/hr/employees/onboard` | `employees.controller.ts:87` | unchanged | `hr.employees.onboard` | + `secondaryManagers` | `onboardResponseSchema` + `primaryManager` |

Route-order trap: `hr/reporting-lines/bulk-jobs` (separate controller) and
`hr/reporting-lines/manager-candidates|coverage` share the prefix with `GET :employeeUserId`.
Express matches in registration order, so `ReportingLineBulkJobsController` must precede
`ReportingLinesController` in `hr-directory.module.ts:46-56`, and the static GETs precede
`:employeeUserId` inside `ReportingLinesController`. A spec pins both (GET `/bulk-jobs` must not
reach `line()`).

Services (new, mine): `reporting-manager-requests.service.ts` (create/list/cancel/respond/queue/
detail/review; keyset cursor on `(created_at desc, id desc)` per A's index; reviewer scope from
`req.rbacScope` if `:review` is scopable — §5 Q6), `reporting-line-bulk-jobs.service.ts`
(preview → `validateMany` + row insert; commit → confirmation phrase `CONFIRM <affected>` when
affected ≥ 10, per-row reason when `changesLast24h ≥ threshold`, `setRelationships` per row with
`bulkJobId`, `source: BULK_REASSIGNMENT`; expired/committed job → 409). Controllers only call
services (BE-06). `hr-directory.module.ts` registers them; A's services come via `DirectoryModule`
(already imported, `:30`).

## 4. Gates per item (`:self-test` first)

| Item | Gates |
|---|---|
| All new/changed controllers | `check:route-classification`, `check:params-schema-completeness`, `check:openapi-path-params`, `check:openapi-coverage`, `check:contract-registry`, `check:route-duplicates`, `check:idempotent-commands`, `check:bodyless-conflicts`, `check:body-binding`, `check:get-route-writes`, `check:record-access`, `check:scope-boundary`, `check:envelope-consistency`, `check:operation-ids`, `check:module-registration`, `check:module-di`, `check:authz-deny` |
| Services / queries | `check:query-projections`, `check:unbounded-reads`, `check:n1-growing-loops`, `check:db-call-count`, `check:lifecycle-predicates`, `check:hr-pagination`, `check:bulk-id-limits`, `check:unjoined-table-refs`, `check:date-in-sql-template` |
| Transactions / side effects | `check:transaction-callbacks`, `check:fire-and-forget`, `check:request-txn-outbound`, `check:bare-throw`, `check:outbox-consumers`, `check:placement-bypass` |
| Cache | `check:cache-invalidation`, `check:namespace-coverage`, `check:cache-key-shapes` |
| Onboarding / import | `check:membership-writes`, `check:membership-parity`, `check:hr-table-freeze`, `check:conflict-targets` |
| Every file | `check:type-assertions`, `check:kebab-case`, `check:file-sizes`, `check:over-300`, `check:cycles`, `check:import-direction`, `check:dead-code`, `check:log-secrets` |
| Whole | `typecheck` + `typecheck:test` (12 GB, under the heavy lock), `lint`, `rate-limit-coverage.spec.ts`, `hr-command-safety.spec.ts`, related jest suites, e2e `hr-directory.controller.e2e-spec.ts` + new controller e2e (auth, RBAC allow/deny, cross-tenant 404, BE-135) |

Size watch: `employee-onboarding.service.ts` is 576 lines and `hr-import-commit.service.ts` 648 —
both already over 500 (`check:file-sizes` baseline). My edits must be net-negative or split
(e.g. onboarding write block into `employee-onboarding-writes.ts`).

## 5. Open questions for the main agent

1. **Notifications mechanism:** `NotificationDispatchService.emit` (durable, deduped) instead of
   "NotificationsService after commit"? Needs 4 catalog entries in `notification-events-hr.catalog.ts`.
2. **`ReportingLineService.assign` callers** (§1.3): A adapts `assign`, or B migrates 4 callers?
3. **Bulk onboarding job history:** audit event only (default), or a table from A?
4. **Applier contract** (§1.4): employment-keyed entry, `effectiveTo`, system actor.
5. **Missing error codes:** `MANAGER_COLUMN_CONFLICT` (normaliser) and `MANAGER_ROW_FAILED`
   (skipped dependant) are not in `REPORTING_LINE_ERROR_CODES`. Add to A's const, or keep them as
   bulk-only codes in my files?
6. Is `hr:reporting-lines:review` scopable (Branch HR sees only their branch's queue)? Decides
   whether routes 14–16 apply `req.rbacScope`.
7. Rate-limit tiers in §2.8 and the two inert limits (§1.7): who edits `rate-limit.service.ts`?
8. Staged-import rollback RESTRICT bug (§1.5): fix in HRM-15 or ticket separately?
9. `/me/*` routes: add `@RequireModule("hr")` (402 when HR is off)? Contract is silent; default yes.

## 6. Where CONTRACT §4 looks wrong or underspecified

- §0 "not atomic" — see §1.1; atomic via the request transaction, undeclared.
- §4.19 says the job **list** returns `BulkJob`; a list must be `{ items, nextCursor }`. Drafted as
  `bulkJobPageSchema` with row-less items.
- §4.20 commit `status` vocabulary is unstated. READY/WARNING describe a plan, not an outcome.
  Default: `status` is the preview classification the row committed under, `success` says whether
  it was written, and a skipped dependant is `SKIPPED` with `success:false`.
- §4.21 onboard response is `{ success, … }`: BE-19 passes it through without the `data` envelope.
- §4.3 exposes `topLevel.reason` to every `hr:employees:view` reader while `changeReason` is
  restricted to manage/review. Probably intended to match; flag for C/PRD §9 ("must not expose audit
  reasons … to an unauthorised manager/employee").
- §4.11 respond body `reason` has no bounds; drafted 1..1000.
- §4.20 preview is `hr:onboarding:manage` with no rate limit in the contract (see §2.8).
- §2 `setRelationships` has no `effectiveTo` and a mandatory `actor` (see §1.4).
- §4.22 needs `ImportCommitContext.actor` for fallback; staged import currently only carries
  `actorId` (`hr-import-commit.service.ts:53-58`).
