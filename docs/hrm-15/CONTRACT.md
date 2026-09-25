# HRM-15 — Binding contract (owned by the integration owner / main agent)

Source PRD: `streamlineos-frontend/docs/specs/hrms-module/15-reporting-manager-onboarding-prd.md`
(copy also at `hrm15-frontend/docs/specs/hrms-module/15-reporting-manager-onboarding-prd.md`).

This file fixes names and shapes so Agents A, B and C build against one contract.
Agent A may refine *internal* service signatures, but any change to a table name,
column name, error code, permission key, route or JSON field below must be reported
to the main agent BEFORE it is made. Nobody invents a parallel contract.

## 0. Ground truth found in Block 0

- The live table is `hr_reporting_lines` (`src/db/schema/hr/core-people.ts:301`).
  `worker_reporting_lines` is a Drizzle declaration whose SQL is unjournalled
  (`migrations/pending/hrms-phase1`). Do not touch or use it.
- Low-level writer: `src/common/hr/sync-canonical-reporting-line.ts`
  (`syncCanonicalReportingLines`). Closes with **inclusive end**
  (`effective_to = dayBefore(effectiveFrom)`). All readers use
  `effective_from <= d AND effective_to >= d` (inclusive).
- Two rogue writers close with a **half-open** end (`effective_to = effectiveFrom`)
  and carry their own cycle CTEs:
  `src/modules/hr/core/hr-effective-change-applier.service.ts:286 applyManager` and
  `src/modules/hr/import/hr-import-commit.service.ts:250 applyImportedManager`.
  HRM-15 consolidates both onto the canonical service (Agent B), and the migration
  normalises existing half-open primary rows to inclusive ends (Agent A).
- Existing constraint `excl_hr_reporting_lines_no_overlap` =
  `EXCLUDE USING gist (employment_id =, line_type =, daterange(from,to,'[)') &&)` — no
  org_id, and it forbids two concurrent secondary lines. It is replaced.
- `line_type` enum `hr_reporting_line_type` = `primary | matrix | dotted`.
  API `relationshipType`: `primary` → `PRIMARY`; `matrix`/`dotted` → `SECONDARY`.
  New secondary writes use `matrix`. No enum change.
- Top-level status is stored nowhere today (only audit metadata of
  `hr.employee_onboarded`). HRM-15 adds a table.
- Onboarding writes the line AFTER the admission transaction with `this.db`
  (`employee-onboarding.service.ts:266`) — not atomic. Fix (Agent B).
- Bulk onboarding has no preview endpoint and no job table; staged import
  (`hr_import_jobs`/`hr_import_rows`) does.
- No `hr:reporting-lines:*` keys exist.

## 1. Database (Agent A) — migrations 1214+ (idx 1096+, `when` > 1803000010726)

`1213` / idx `1095` is reserved by uncommitted work in the main checkout — do not use.

### 1.1 `hr_reporting_lines` (extend, never replace)
New columns:
| column | type | notes |
|---|---|---|
| `source` | text NOT NULL DEFAULT `'MIGRATED'` | CHECK in `MANUAL, MIGRATED, ONBOARDING_SELECTED, ONBOARDING_FALLBACK, BULK_ONBOARDING, STAGED_IMPORT, EMPLOYEE_REQUEST, BULK_REASSIGNMENT, EMERGENCY_OVERRIDE, EFFECTIVE_CHANGE` |
| `change_reason` | text NULL | CHECK length ≤ 1000 |
| `relationship_label` | text NULL | secondary only (CHECK: NULL when line_type='primary'); ≤ 60 chars |
| `fallback_confirmed_at` | timestamptz NULL | set when HR confirms a fallback primary |
| `fallback_confirmed_by` | text NULL | users.id |
| `bulk_job_id` | uuid NULL | FK → `hr_reporting_line_bulk_jobs(org_id,id)` |
| `request_id` | uuid NULL | FK → `hr_reporting_manager_requests(org_id,id)` |
| `updated_at` | timestamptz NOT NULL DEFAULT now() | |

Constraints / indexes:
- normalise legacy half-open primary rows (`effective_to = next.effective_from`) to inclusive (`- 1 day`) BEFORE new constraints; record counts in a NOTICE.
- drop `excl_hr_reporting_lines_no_overlap`; add
  `excl_hr_reporting_lines_primary_overlap EXCLUDE USING gist (org_id WITH =, employment_id WITH =, daterange(effective_from, effective_to, '[]') WITH &&) WHERE (line_type = 'primary')`
  and `excl_hr_reporting_lines_secondary_overlap EXCLUDE USING gist (org_id WITH =, employment_id WITH =, manager_employment_id WITH =, daterange(effective_from, effective_to, '[]') WITH &&) WHERE (line_type <> 'primary')`.
  (`'infinity'::date` upper bound works with `'[]'`.) If live/local data violates, the migration must RAISE with a count and the audit query in the rollout note — never silently delete history.
- `uniq_hr_reporting_lines_open_primary` UNIQUE (org_id, employment_id) WHERE line_type='primary' AND effective_to='infinity'.
- `idx_hr_reporting_lines_manager_type` (org_id, manager_employment_id, line_type, effective_to).
- CHECK `chk_hr_reporting_lines_dates` effective_from <= effective_to (NOT VALID then VALIDATE).
- CHECK no self manager (employment_id <> manager_employment_id).

### 1.2 `hr_reporting_manager_policies` (one row per org; absence = defaults)
`org_id` PK/FK, `max_secondary_managers_per_employee` smallint 0..3 default 0,
`default_primary_manager_user_id` text NULL (FK users), `fallback_order` text CHECK
(`CONFIGURED_MANAGER_THEN_UPLOADER` | `UPLOADER_THEN_CONFIGURED_MANAGER`) default first,
`require_reason_after_changes` smallint 1..10 default 3,
`allow_top_level_without_manager` boolean default true, `version` int default 1,
`updated_by` text NULL, `created_at`, `updated_at`. RLS tenant policy.

### 1.3 `hr_top_level_roles` (effective-dated explicit exception)
`id` uuid PK, `org_id`, `employment_id` (FK org-composite), `reason` text NOT NULL
(1..500, non-blank), `effective_from` date, `effective_to` date default infinity,
`created_by`, `created_at`, `ended_by`, `ended_at`. Partial unique open row per
(org_id, employment_id). Backfill from `audit_logs` where
`action='hr.employee_onboarded' AND metadata->>'topLevelRole'='true'` when the
employee still has no current primary line. RLS.

### 1.4 `hr_reporting_manager_requests`
`id` uuid PK, `org_id`, `employee_employment_id`, `requested_by_user_id`,
`current_primary_line_id` int NULL (FK hr_reporting_lines org-composite),
`suggested_manager_employment_id` int NULL, `requested_effective_from` date NULL,
`employee_reason` text (20..1000), `status` text CHECK
(`PENDING, MORE_INFO_REQUIRED, APPROVED, REJECTED, CANCELLED, EXPIRED`),
`reviewer_user_id` NULL, `review_reason` NULL (≤1000), `resolved_line_id` int NULL,
`created_at`, `updated_at`, `resolved_at`, `deleted_at`.
Partial unique `uniq_hr_rm_requests_active` (org_id, employee_employment_id,
coalesce(current_primary_line_id, 0)) WHERE status IN ('PENDING','MORE_INFO_REQUIRED')
AND deleted_at IS NULL. Indexes (org_id, status, created_at desc, id desc) partial on
deleted_at IS NULL; (org_id, requested_by_user_id, created_at desc). RLS.

### 1.5 `hr_reporting_line_bulk_jobs` + `hr_reporting_line_bulk_job_rows`
Job: `id` uuid PK, `org_id`, `status` (`PREVIEWED, COMMITTING, COMMITTED, FAILED, EXPIRED`),
`job_reason` text, `effective_from` date NULL, `row_count`, `ready_count`,
`warning_count`, `error_count`, `committed_count`, `created_by`, `committed_by`,
`created_at`, `committed_at`, `deleted_at`.
Row: `id` uuid PK, `org_id`, `job_id`, `row_number` int, `employee_email` text,
`employee_employment_id` int NULL, `requested_primary_manager_email` text NULL,
`requested_primary_manager_employment_id` int NULL, `current_primary_manager_employment_id` int NULL,
`secondary_manager_emails` → **normalised**: separate columns `secondary_manager_email_1..3` text NULL,
`effective_from` date NULL, `row_reason` text NULL, `changes_last_24h` int,
`status` (`READY, WARNING, ERROR, SKIPPED, COMMITTED, FAILED`),
`codes` text NULL (comma-joined error/warning codes — display only), `message` text NULL,
`before_line_id` int NULL, `after_line_id` int NULL. Unique (org_id, job_id, row_number). RLS.

## 2. Canonical services (Agent A) — `src/modules/directory/`

Error codes (single exported const `REPORTING_LINE_ERROR_CODES`, `reporting-line.types.ts`):
`SELF_REFERENCE, MANAGER_NOT_ELIGIBLE, MANAGER_NOT_FOUND, PRIMARY_CYCLE,
SECONDARY_DUPLICATES_PRIMARY, SECONDARY_DUPLICATE, SECONDARY_CAP_EXCEEDED,
TOP_LEVEL_WITH_MANAGER, TOP_LEVEL_REASON_REQUIRED, TOP_LEVEL_NOT_ALLOWED,
NO_DEFAULT_REPORTING_MANAGER, CHANGE_REASON_REQUIRED, ELEVATED_AUTHORITY_REQUIRED,
INVALID_EFFECTIVE_DATE, EMPLOYEE_NOT_FOUND, REQUEST_INVALID_TRANSITION,
REQUEST_DUPLICATE_ACTIVE`.
HTTP: 400 validation codes, 403 `ELEVATED_AUTHORITY_REQUIRED`, 404 `EMPLOYEE_NOT_FOUND`,
409 `REQUEST_DUPLICATE_ACTIVE` / `REQUEST_INVALID_TRANSITION`. Error envelope per BE-20:
`{ code, message, details? }` — `code` is the value above.

Services (names binding; internals Agent A's call):
- `ReportingManagerPolicyService` — `get(orgId, db?)` returns full policy incl. defaults +
  `defaultPrimaryManager: {userId,name,designation,eligible:boolean}|null`;
  `update(actor, patch, tx)` validates default manager eligibility, bumps version,
  audits `hr.reporting_manager_policy.updated`, outbox event.
- `ReportingManagerFallbackResolver` — `resolveMany(orgId, actor, rows, db)` (one
  preload, no N+1) and `resolve(...)` → per row
  `{ ok: true, managerUserId, resolution: 'SELECTED'|'IN_FILE'|'FALLBACK_CONFIGURED'|'FALLBACK_UPLOADER' }`
  or `{ ok:false, code:'NO_DEFAULT_REPORTING_MANAGER', message }`. Exactly D2 order.
  Actor qualifies as uploader fallback iff org owner, org admin, or holds
  `hr:reporting-lines:override`/HR admin standing — decided structurally, never by title.
- `ReportingRelationshipService` — the ONLY path that writes relationships:
  `setRelationships(tx, cmd)` where cmd =
  `{ orgId, actor, subjectUserId, primaryManagerUserId: string|null, topLevelReason?: string,
     secondary?: Array<{managerUserId, label?}> | undefined (undefined = leave unchanged),
     effectiveFrom, source, reason?, emergency?, bulkJobId?, requestId?, skipFrequencyGuard? }`
  validates every PRD §6 rule, cap, cycles at the effective date, frequency guard (D4),
  writes lines via the canonical low-level writer, writes/ends `hr_top_level_roles`,
  audits (`hr.reporting_line.changed`, `hr.reporting_line.emergency_override` severity high),
  outbox `hr.reporting_line.changed` in the same tx, and returns
  `{ before, after, changed:boolean, warnings: string[] }`.
  Also `validateMany(...)` for preview (no writes, batched) and `countPrimaryChangesLast24h`.
- `ReportingLineService.getLine` extended (see §4) and `coverage` extended (§4).
- Approval routing stays PRIMARY-only (`currentPrimaryReportingLine`) — add a test.

## 3. Permission keys (Agent A: backend catalog + templates; Agent C: frontend catalog)
- `hr:reporting-lines:manage` — set/schedule lines, bulk jobs, confirm fallback.
- `hr:reporting-lines:review` — HR request queue + decisions.
- `hr:reporting-lines:override` — update policy, exceed change threshold, emergency.
- Reads keep `hr:employees:view` (no `view` key added — smallest change).
- HR_ADMIN template: all three. BRANCH_HR: manage + review. Org owner/admin get all
  structurally. `/me/...` routes are self-service (`@Universal()` + service-side self check).

## 4. HTTP contract (Agent B implements, Agent C consumes). Envelope per BE-19.

Common `managerRef` = `{ userId, name, email|null, designation|null, state: 'active'|'on-notice'|'inactive'|'exited' }`.

`RelationshipEntry` = `{ lineId, relationshipType:'PRIMARY'|'SECONDARY', label|null,
  manager: managerRef, effectiveFrom, effectiveTo|null, source, isFallback:boolean,
  fallbackConfirmedAt|null, recordedAt, changeReason|null /* only for hr:reporting-lines:manage or review */ }`

1. `GET /hr/reporting-manager-policy` (`hr:employees:view`) →
   `{ maxSecondaryManagersPerEmployee, defaultPrimaryManager: managerRef|null, defaultPrimaryManagerEligible:boolean,
      fallbackOrder, requireReasonAfterChanges, allowTopLevelWithoutManager, version, updatedAt|null,
      isConfigured:boolean, actorQualifiesAsFallback:boolean }`
2. `PATCH /hr/reporting-manager-policy` (`hr:reporting-lines:override`, @Idempotent)
   body (strict, all optional): `{ maxSecondaryManagersPerEmployee?, defaultPrimaryManagerUserId?: string|null,
   fallbackOrder?, requireReasonAfterChanges?, allowTopLevelWithoutManager?, expectedVersion: number }` → same as 1.
3. `GET /hr/reporting-lines/:employeeUserId` (`hr:employees:view`, scoped) — EXTENDS today's
   `{ userId, current, upcoming, history }` (kept, PRIMARY only, unchanged shape + new fields
   `source`, `isFallback`, `relationshipType`) with:
   `{ secondary: RelationshipEntry[] /*current+upcoming*/, topLevel: {reason, effectiveFrom}|null,
      primaryChangesLast24h:number, changeThreshold:number, maxSecondaryManagers:number,
      pendingRequest: {requestId,status,createdAt}|null,
      permittedActions: { manage:boolean, review:boolean, override:boolean } }`
4. `PUT /hr/reporting-lines/:employeeUserId` (`hr:reporting-lines:manage`, @Idempotent)
   body `{ primaryManagerUserId: string|null, topLevelReason?: string, secondaryManagers?: [{managerUserId,label?}],
   effectiveFrom?: 'YYYY-MM-DD', reason?: string, emergency?: boolean }` → `{ line: <3>, warnings: string[] }`.
5. `POST /hr/reporting-lines/:employeeUserId/confirm-fallback` (`hr:reporting-lines:manage`, @Idempotent) → `<3>`.
6. `GET /hr/reporting-lines/manager-candidates?q=&excludeUserId=&limit=` (`hr:employees:view`) →
   `{ items: managerRef[] }` active, accepted, in-tenant, eligible; excludes subject; ≤ 20.
7. `GET /hr/reporting-lines/coverage` — existing shape PLUS
   `summary.{topLevel, fallback, pendingReview}`, `policyMissing:boolean`,
   `fallback: [{userId,name,managerUserId,managerName,effectiveFrom}]`,
   `pendingReview: [{requestId,userId,name,createdAt}]`; top-level employees excluded from `withoutManager`.
8. `POST /me/reporting-manager-requests` (@Universal, @Idempotent) body
   `{ reason (20..1000), suggestedManagerUserId?: string, requestedEffectiveFrom?: date }` → `MyRequest`.
   `MyRequest` = `{ requestId, status, employeeReason, suggestedManager: managerRef|null, requestedEffectiveFrom|null,
   reviewReason|null, createdAt, updatedAt, resolvedAt|null }`.
9. `GET /me/reporting-manager-requests?cursor=&limit=` → `{ items: MyRequest[], nextCursor|null }`.
10. `POST /me/reporting-manager-requests/:requestId/cancel` (@Idempotent) → `MyRequest`.
11. `POST /me/reporting-manager-requests/:requestId/respond` body `{ reason }` (MORE_INFO_REQUIRED → PENDING) → `MyRequest`.
12. `GET /me/reporting-manager-requests/manager-candidates?q=` → `{ items: managerRef[] }` (excludes self).
13. `GET /me/reporting-line` (@Universal) → `{ primary: RelationshipEntry|null, secondary: RelationshipEntry[], topLevel: {effectiveFrom}|null }` (no reasons).
14. `GET /hr/reporting-manager-requests?status=&cursor=&limit=` (`hr:reporting-lines:review`) →
   `{ items: HrRequest[], nextCursor|null }`; `HrRequest` = MyRequest + `{ employee: managerRef, currentManager: managerRef|null }`.
15. `GET /hr/reporting-manager-requests/:requestId` (`hr:reporting-lines:review`) → `HrRequest`.
16. `POST /hr/reporting-manager-requests/:requestId/review` (`hr:reporting-lines:review`, @Idempotent)
   body `{ decision: 'APPROVE'|'REJECT'|'CANCEL_DUPLICATE'|'REQUEST_INFO', managerUserId?, effectiveFrom?, reviewReason }`
   → `{ request: HrRequest, warnings: string[] }`.
17. `POST /hr/reporting-lines/bulk-jobs` (`hr:reporting-lines:manage`, @Idempotent) — preview, persists job
   body `{ jobReason (≥10), effectiveFrom?, rows: [{ employeeEmail, primaryManagerEmail?, secondaryManagerEmail1?, secondaryManagerEmail2?, secondaryManagerEmail3?, effectiveFrom?, reason? }] (1..500) }`
   or `{ jobReason, employeeUserIds: string[], primaryManagerUserId, effectiveFrom? }` → `BulkJob`.
18. `POST /hr/reporting-lines/bulk-jobs/:jobId/commit` (`hr:reporting-lines:manage`, @Idempotent)
   body `{ confirmationPhrase?: string /* required, === 'CONFIRM <n>', when affected ≥ 10 */, rowReasons?: [{rowNumber, reason}] }` → `BulkJob`.
19. `GET /hr/reporting-lines/bulk-jobs?cursor=` and `GET /hr/reporting-lines/bulk-jobs/:jobId` → `BulkJob`
   (`rows` paginated ≤ 100 via `?rowCursor=`), `GET .../:jobId/failures.csv` returns text/csv.
   `BulkJob` = `{ jobId, status, jobReason, rowCount, readyCount, warningCount, errorCount, committedCount,
   requiresConfirmation:boolean, confirmationPhrase:string|null, createdAt, committedAt|null,
   rows: BulkJobRow[], nextRowCursor|null }`; `BulkJobRow` = `{ rowNumber, employeeEmail, employee: managerRef|null,
   currentPrimary: managerRef|null, requestedPrimary: managerRef|null, secondaryChanges: string[], changesLast24h,
   requiresRowReason:boolean, status, codes: string[], message|null }`.
20. Bulk onboarding: `POST /hr/employees/onboard/bulk/preview` (`hr:onboarding:manage`) — same row DTO as commit,
   no writes → `{ rows: [{ row, email, status: 'READY'|'WARNING'|'ERROR'|'SKIPPED', codes:string[], messages:string[],
   primaryManager: { userId|null, name, email, resolution: 'SELECTED'|'IN_FILE'|'FALLBACK_CONFIGURED'|'FALLBACK_UPLOADER' }|null,
   secondaryManagers: [{name,email}], dependsOnRow:number|null }], counts:{ready,warning,error,skipped} }`.
   Commit `POST /hr/employees/onboard/bulk` keeps `{total, created, failed, results[]}` and adds per-result
   `status`, `codes`, `primaryManager` (same shape) and top-level `skipped` count.
   Row DTO adds `primaryManagerEmail`, `secondaryManagerEmail1..3`, `effectiveFrom`, keeps
   `reportingManagerEmail` as a read-only alias (legacy → metadata `legacyManagerHeader: true`).
21. Single onboarding `POST /hr/employees/onboard`: `reportingManagerUserId` becomes OPTIONAL; adds
   `secondaryManagers?: [{managerUserId,label?}]`; response adds
   `primaryManager: { userId, name, resolution } | null` (`resolution` only when caller has hr:employees:view).
22. Staged import `employees` entity: canonical columns `primaryManagerEmail` (alias `managerEmail`,
   `reportingManagerEmail`, `reportsTo`), `secondaryManagerEmail1..3`, `topLevelRoleReason`,
   `effectiveFrom`, `clearPrimaryManager`. Blank for an existing employee = no change.

Idempotency: every mutating route above uses `@Idempotent("<scope>")` (BE-34).
Cache/invalidation after commit: `OrgHierarchyCacheService.invalidateAfterMutation` +
`CACHE_KEYS.hrEmployeesListNamespace` as the onboarding path already does.
Notifications (after commit): employee + incoming + outgoing primary on approval;
HR reviewers on request creation (single actionable notification); bulk job = one HR summary.

## 5. Frontend (Agent C)
Query keys (in `lib/query-keys/human-resources.ts`): `reportingLine(userId)` (exists),
`managerCoverage()` (exists), new `reportingManagerPolicy()`, `myReportingLine()`,
`myReportingManagerRequests()`, `reportingManagerRequests(filters)`, `reportingManagerRequest(id)`,
`reportingLineBulkJobs()`, `reportingLineBulkJob(id)`, `managerCandidates(q, exclude)`.
Every mutation invalidates: `reportingLine(userId)`, employee detail, `managerCoverage()`,
`myTeam()`, org chart, and the request/job keys it touches (`invalidateHrWorkforceQueries`).
