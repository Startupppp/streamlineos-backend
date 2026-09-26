# HRM-15 — Agent A publication (data model + canonical services)

Branch `hrms/hrm-15-reporting-managers`, worktree `hrm15-backend`. Commits `17c8d3a07`…`147bc08cb`.

## 1. Migrations (journal idx 1102–1107, `when` 1803000010727–…732)

| File | What it does | Rollback |
|---|---|---|
| `1214_hr_reporting_manager_policies` | `hr_reporting_manager_policies` (PK `org_id`). Default manager FK is **`(org_id, default_primary_manager_user_id) → organization_members(org_id, user_id)` ON DELETE SET NULL** (tenant-consistent; see §8). | drop table |
| `1215_hr_reporting_line_bulk_jobs` | `hr_reporting_line_bulk_jobs` + `hr_reporting_line_bulk_job_rows` (normalised `secondary_manager_email_1..3`; `before_line_id`/`after_line_id` are trace ints, no FK). | drop tables |
| `1216_hr_reporting_manager_requests` | `hr_reporting_manager_requests`, `uniq_hr_rm_requests_active`, list indexes, FKs to lines `SET NULL`. | drop table |
| `1217_hr_reporting_lines_provenance` | `source` (default `MIGRATED`), `change_reason`, `relationship_label`, `fallback_confirmed_at/_by`, `bulk_job_id`, `request_id`, `updated_at`; CHECKs; FKs to jobs/requests; `idx_hr_reporting_lines_manager_type`; `idx_hr_reporting_lines_recent_primary` (D4 count). | drops columns |
| `1218_hr_reporting_lines_one_current_primary` | **new table `hr_reporting_lines_superseded`** (§8); normalises legacy half-open ends (`effective_to - 1`), moves empty-period legacy rows to the archive (`LEGACY_EMPTY_PERIOD`); RAISES with counts on remaining overlap / inverted / self-managed rows; drops `excl_hr_reporting_lines_no_overlap`; adds `excl_hr_reporting_lines_primary_overlap`, `excl_hr_reporting_lines_secondary_overlap`, `uniq_hr_reporting_lines_open_primary`, `chk_hr_reporting_lines_dates`, `chk_hr_reporting_lines_not_self`. | restores old exclusion + legacy rows; refuses if the app has written `REPLACED` archive rows |
| `1219_hr_top_level_roles` | `hr_top_level_roles` + `uniq_hr_top_level_roles_open`; backfill from `audit_logs` (`hr.employee_onboarded`, `metadata.topLevelRole = true`, no current primary). | drop table |

Every new table: `ENABLE ROW LEVEL SECURITY`, `tenant_isolation` policy (`org_id = app.current_org_id()` USING + WITH CHECK), explicit `GRANT … TO streamline_app`, `lock_timeout = 5s`, named constraints, FKs `NOT VALID` → `VALIDATE`, every FK indexed with `org_id` leading.

Drizzle: `src/db/schema/hr/core-people.ts` (`hrReportingLines` + `REPORTING_LINE_SOURCES`, `ReportingLineSource`) and `src/db/schema/hr/reporting-manager.ts` (`hrReportingManagerPolicies`, `hrReportingLineBulkJobs`, `hrReportingLineBulkJobRows`, `hrReportingManagerRequests`, `hrReportingLinesSuperseded`, `hrTopLevelRoles`, status/order const arrays and types), exported from `src/db/schema/hr/index.ts`. Exclusion constraints and the two lines→jobs/requests FKs are DB-only (drizzle cannot express the former; declaring the latter would make `core-people.ts` ↔ `reporting-manager.ts` an import cycle).

## 2. Injection

All providers live in **`EmploymentFactsModule`** (`src/modules/directory/employment-facts.module.ts`), which `DirectoryModule` re-exports. Import `EmploymentFactsModule` (or `DirectoryModule`) and inject by class:
`ReportingLineService`, `ReportingManagerPolicyService`, `ReportingManagerFallbackResolver`, `ReportingRelationshipService`. `AccessService` and `AuditService` come from their global modules.

## 3. Service API

### `ReportingRelationshipService` — `src/modules/directory/reporting-relationship.service.ts` (the ONLY relationship writer)
```ts
setRelationships(tx: DbOrTx, cmd: SetRelationshipsCommand): Promise<SetRelationshipsResult>
validateMany(orgId: string, commands: readonly SetRelationshipsCommand[], db?: DbOrTx): Promise<RelationshipValidation[]>
countPrimaryChangesLast24h(orgId: string, employmentIds: readonly number[], db?: DbOrTx): Promise<Map<number, number>>
confirmFallback(tx: DbOrTx, cmd: { orgId: string; actor: ReportingActor; subjectUserId: string }): Promise<{ lineId: number | null; confirmed: boolean }>
```
- `setRelationships` takes an org-wide advisory xact lock, validates, writes primary (+ bounded window), top-level role, secondaries, then (only if the snapshot changed) `AuditService.logCritical` `hr.reporting_line.changed` (+ `hr.reporting_line.emergency_override` with `metadata.severity = "high"`) and `OutboxWriter.emit(tx, "hr.reporting_line.changed")`. Throws `ReportingLineException` with the first issue. A DB exclusion/unique race surfaces as `INVALID_EFFECTIVE_DATE`, never 500.
- `validateMany` is the preview path: no writes, **constant query count** for up to 500 rows (policy 1, subjects ≤2, manager eligibility 1, manager dates 1, lines 1, top-level 1, 24h counts 1, cycles 1, elevation 1 per distinct actor).
- `confirmFallback` stamps `fallback_confirmed_at/_by` on the current unconfirmed `ONBOARDING_FALLBACK` primary; audits `hr.reporting_line.fallback_confirmed`. Idempotent: `{ confirmed: false }` when there is nothing to confirm.

Types (`src/modules/directory/reporting-line.types.ts`):
```ts
type ReportingActor = CurrentUserContext | { orgId; userId; isOrgOwner: boolean } | { orgId; system: string };
type SetRelationshipsCommand = ({ subjectUserId: string } | { subjectEmploymentId: number }) & {
  orgId: string; actor: ReportingActor;
  primaryManagerUserId: string | null;      // null = top-level (needs topLevelReason)
  topLevelReason?: string | null;
  secondary?: Array<{ managerUserId: string; label?: string | null }>; // undefined = unchanged; [] = end all
  effectiveFrom: string;                     // YYYY-MM-DD org-local
  effectiveTo?: string | null;               // inclusive last day of a bounded PRIMARY line
  source: ReportingLineSource;               // MANUAL | ONBOARDING_SELECTED | ONBOARDING_FALLBACK | BULK_ONBOARDING | STAGED_IMPORT | EMPLOYEE_REQUEST | BULK_REASSIGNMENT | EFFECTIVE_CHANGE (EMERGENCY_OVERRIDE is set for you when emergency)
  reason?: string | null; emergency?: boolean; bulkJobId?: string | null; requestId?: string | null;
  skipFrequencyGuard?: boolean;
};
interface SetRelationshipsResult { subjectUserId: string | null; employmentId: number; before: RelationshipSnapshot; after: RelationshipSnapshot; changed: boolean; primaryChanged: boolean; warnings: ReportingLineWarning[] }
interface RelationshipSnapshot { primary: { lineId; managerUserId; managerEmploymentId } | null; secondary: Array<{ lineId; managerUserId; managerEmploymentId; label }>; topLevel: { reason; effectiveFrom } | null }
interface RelationshipValidation { ok; issues: Array<{ code; message }>; warnings; employmentId; currentPrimaryManagerEmploymentId; primaryManagerEmploymentId; primaryChanged; primaryChangesLast24h; requiresReason }
```
Warnings: `PRIMARY_CHANGE_THRESHOLD_EXCEEDED`, `EMERGENCY_OVERRIDE`, `FALLBACK_ASSIGNED`. Snapshots are taken **at `effectiveFrom`**. Before/after line ids for bulk rows: `result.before.primary?.lineId` / `result.after.primary?.lineId`.

Rules (pure function `evaluateRelationshipCommand` in `reporting-relationship-rules.ts`): subject must be a live primary employment not CANDIDATE/EXITED/ALUMNI; valid ISO dates, `effectiveTo ≥ effectiveFrom`; top-level needs a 1..500 reason, is refused when policy forbids it, and may not carry a primary or secondary manager; manager distinct, eligible via `checkManager` refusal logic, employed on the effective date (joining ≤ date ≤ last working day / exit); no primary cycle at the effective date **or any later date a primary line starts**; secondaries ≤ policy cap, not self, not the primary, no duplicates, eligible, label ≤ 60; unchanged secondaries may not already contain the new primary. D4: when the primary actually changes and the org's 24h count (live + superseded primary lines) ≥ `requireReasonAfterChanges`: reason ≥ 10 non-whitespace chars **and** elevated authority (system actors skip only the elevation). Emergency: reason ≥ 10 non-whitespace chars **and** elevated authority, always (system actors cannot). `skipFrequencyGuard` skips D4 only.

Elevated = org owner / org admin (structural, `isStructuralOrgAdmin*`) or holder of `hr:reporting-lines:override`; `{ system }` never.

### `ReportingManagerPolicyService` — `reporting-manager-policy.service.ts`
```ts
get(orgId: string, db?: DbOrTx): Promise<ReportingManagerPolicyView>
update(actor: CurrentUserContext, patch: ReportingManagerPolicyPatch, tx: DbOrTx): Promise<ReportingManagerPolicyView>
isElevated(actor: ReportingActor): Promise<boolean>
permittedActions(actor: CurrentUserContext): Promise<PermittedActions>   // { manage, review, override }; override implies manage + review
```
`ReportingManagerPolicyView` = `{ orgId, isConfigured, maxSecondaryManagersPerEmployee, defaultPrimaryManagerUserId, fallbackOrder, requireReasonAfterChanges, allowTopLevelWithoutManager, version, updatedAt: string|null, defaultPrimaryManager: { userId, name, designation, eligible } | null }`. No row ⇒ defaults with `isConfigured: false, version: 0`. `update` requires `patch.expectedVersion === current version` (0 for an unconfigured org) else **409 `{ code: "CONFLICT" }`**; validates the default manager with `checkManager` (`MANAGER_NOT_FOUND` / `MANAGER_NOT_ELIGIBLE`, `details.field`); bumps `version`; audits + outbox `hr.reporting_manager_policy.updated`. The route guard must enforce `hr:reporting-lines:override` (the service does not re-check).

### `ReportingManagerFallbackResolver` — `reporting-manager-fallback.resolver.ts`
```ts
resolveMany(orgId: string, actor: ReportingActor, rows: readonly FallbackRow[], db?: DbOrTx): Promise<FallbackResult[]>
resolve(orgId: string, actor: ReportingActor, row: FallbackRow, db?: DbOrTx): Promise<FallbackResult>
actorQualifiesAsFallback(orgId: string, actor: ReportingActor, db?: DbOrTx): Promise<boolean>
FallbackRow = { key: number; employeeUserId?; employeeEmail?; primaryManagerUserId?; primaryManagerEmail? }
FallbackResult = { key; ok: true; managerUserId: string | null; managerEmploymentId: number | null; name; email; resolution: "SELECTED"|"IN_FILE"|"FALLBACK_CONFIGURED"|"FALLBACK_UPLOADER"; dependsOnRow: number | null }
               | { key; ok: false; code; message }
```
Exactly D2: `primaryManagerUserId` → `SELECTED`; `primaryManagerEmail` naming an existing member → `IN_FILE`; naming another row's `employeeEmail` → `IN_FILE` with `managerUserId: null, dependsOnRow`; a supplied manager that is invalid is refused (`MANAGER_NOT_FOUND` / `MANAGER_NOT_ELIGIBLE` / `SELF_REFERENCE` / `MANAGER_COLUMN_CONFLICT` when id and email disagree), **never replaced by a fallback**; otherwise the policy order between the configured default (if eligible and not the employee) and the actor (if elevated, employed, eligible, not the employee); else `NO_DEFAULT_REPORTING_MANAGER`. One preload per call: policy, members by id ∪ email (1 query), eligibility (1), elevation (≤2).

### `ReportingLineService` — `reporting-line.service.ts` (extended)
```ts
checkManagers(orgId, managerUserIds: readonly string[], db?): Promise<Map<string, ManagerAssignmentCheck>>  // NEW batch form, same refusal logic
getLine(read: ScopedRead, userId: string, options?: { permittedActions?: PermittedActions }): Promise<ReportingLineView | null>
coverage(orgId: string): Promise<ManagerCoverageReport>
assign(..., db?, provenance?: { source; reason?; bulkJobId?; requestId? })   // kept for existing callers; source defaults MANUAL
assignMany(..., db?, provenance?)
```
`getLine` adds to the existing `{ userId, current, upcoming, history }` (PRIMARY only; entries gain `relationshipType: "PRIMARY"`, `source`, `isFallback` (= source is `ONBOARDING_FALLBACK`), `fallbackConfirmedAt`, `changeReason`): `secondary: RelationshipEntry[]` (current + upcoming), `topLevel: { reason: string|null, effectiveFrom } | null` (only when no current primary), `primaryChangesLast24h`, `changeThreshold`, `maxSecondaryManagers`, `pendingRequest`, `permittedActions`. `changeReason` and `topLevel.reason` are null unless `permittedActions.manage || review` — **the controller must pass `permittedActions` from `ReportingManagerPolicyService.permittedActions(actor)`**; omitted ⇒ all false. "Today" is the org's business date (`orgBusinessDate`), not UTC.
`coverage` adds `summary.{topLevel, fallback, pendingReview}`, `policyMissing` (= no default primary manager configured), `fallback[]` (current, unconfirmed `ONBOARDING_FALLBACK` primaries), `pendingReview[]`, and `circular[].members: [{ userId, name }]`; top-level employees are excluded from `withoutManager` and `summary.withoutManager`.

### Low-level writer — `src/common/hr/sync-canonical-reporting-line.ts`
```ts
writePrimaryLines(db, orgId, assignments: Array<{ employmentId; managerEmploymentId: number | null }>, window: { from; to? }, provenance: LineProvenance): Promise<Map<number, PrimaryWriteResult>>
writeSecondaryLines(db, orgId, employmentId, desired: Array<{ managerEmploymentId; label }>, from, provenance): Promise<{ addedLineIds; endedLineIds; keptLineIds }>
lockReportingLines(db, orgId): Promise<void>
syncCanonicalReportingLine(s)(…same positional args…, provenance?)   // unchanged positions; outcomes gain lineId
```
Semantics: a line that began before `from` is closed `from - 1`; a line that begins on/after `from` (same-day correction, cancelled scheduled change) never took effect and is **moved to `hr_reporting_lines_superseded` (`REPLACED`)** — never deleted, never ended before it starts; a bounded window re-opens the displaced line the day after `to`. Constant statement count per batch. Only `ReportingRelationshipService` should call these; they do not validate.

## 4. Error codes — `REPORTING_LINE_ERROR_CODES` (`reporting-line.types.ts`), thrown as `ReportingLineException` (`reporting-line-errors.ts`)
Body `{ code, message, details? }` via `AllExceptionsFilter`. Status map exported as `REPORTING_LINE_ERROR_STATUS`.

| Code | HTTP |
|---|---|
| `SELF_REFERENCE`, `MANAGER_NOT_ELIGIBLE`, `MANAGER_NOT_FOUND`, `PRIMARY_CYCLE`, `SECONDARY_DUPLICATES_PRIMARY`, `SECONDARY_DUPLICATE`, `SECONDARY_CAP_EXCEEDED`, `TOP_LEVEL_WITH_MANAGER`, `TOP_LEVEL_REASON_REQUIRED`, `TOP_LEVEL_NOT_ALLOWED`, `NO_DEFAULT_REPORTING_MANAGER`, `CHANGE_REASON_REQUIRED`, `INVALID_EFFECTIVE_DATE`, `MANAGER_COLUMN_CONFLICT`, `MANAGER_ROW_FAILED` | 400 |
| `ELEVATED_AUTHORITY_REQUIRED` | 403 |
| `EMPLOYEE_NOT_FOUND` | 404 |
| `REQUEST_DUPLICATE_ACTIVE`, `REQUEST_INVALID_TRANSITION` | 409 |

`rethrowReportingLineWriteError(error)` maps `uniq_hr_rm_requests_active` 23505 → `REQUEST_DUPLICATE_ACTIVE` (use it around the request insert). `MANAGER_ROW_FAILED` is also used for an over-long secondary label.

Also exported: `REPORTING_LINE_PERMISSIONS` (`MANAGE`/`REVIEW`/`OVERRIDE`), `REPORTING_LINE_EVENTS`, `REPORTING_LINE_WARNINGS`, `CHANGE_REASON_MIN_CHARS = 10`.

## 5. Permission keys
`hr:reporting-lines:manage`, `:review`, `:override` added to `HR_FOUNDATION_PERMISSIONS` (`src/modules/rbac/permissions/hr-foundation.permissions.ts`; not scopable). HR_ADMIN template: all three; BRANCH_HR: manage + review (`role-templates-hr.constants.ts`). No grant backfill migration (BE-111) — `PermissionCatalogSyncService` upserts the catalog at boot and `RoleGrantReconcilerService` converges templates. `check:permission-keys` passes (no route uses them yet; the frontend union is Agent C's).

## 6. Existing callers changed
None outside Agent A's files. `assign`/`assignMany`/`checkManager*`/`checkApprover`/`syncCanonicalReportingLine(s)` keep their signatures (new optional trailing `provenance`). `checkManagerAssignment(s)` now uses the date-aware cycle query (stricter: also refuses a cycle a scheduled line would close). Coverage queries moved to `reporting-line-coverage.ts`; shared reads in `reporting-line-queries.ts`.

## 7. Tests and exact commands

| File | Kind | Result |
|---|---|---|
| `src/modules/directory/reporting-relationship-rules.spec.ts` | unit, pure rules: eligibility, dates (same-day/future/back-dated/invalid), top-level exclusivity, cap 0–3 boundaries, self/primary/duplicate secondaries, D4 (0–2 ok, 4th reason + elevation, 10 non-ws chars, policy threshold, unchanged not guarded, system actor, skip), emergency | 39 pass |
| `src/common/hr/sync-canonical-reporting-line.spec.ts` | unit (rewritten): batching, same-day supersede, future supersede, back-dated close, provenance, bounded carve, secondary set semantics | 21 pass |
| `src/modules/directory/__tests__/reporting-line-constraints.db.spec.ts` | open-primary uniqueness, inclusive overlap, two concurrent secondaries, same secondary twice, date/self CHECKs, label CHECK, tenant isolation of all 7 new/changed tables as `streamline_app` | 7 pass |
| `src/modules/directory/__tests__/reporting-relationship.db.spec.ts` | writer via service + audit + outbox, cap, same-day/back-dated/scheduled, direct/indirect/future cycles, D4 with real counts, emergency high-severity, top-level, preview, getLine, coverage + confirm fallback, policy defaults, D2 both orders + ineligible default + in-file | 15 pass |
| `src/modules/directory/__tests__/approval-routing-primary-only.db.spec.ts` | `ApprovalAuthorityService` routes only PRIMARY current lines (secondary present, secondary only, ended/future primary) | 3 pass |

Commands (all under `nice`, `--maxWorkers=2`):
```
nice -n 15 npx jest --testPathPattern='(directory/(reporting|approver|employment-query|direct)|common/hr/sync-canonical-reporting|hr-permission-boundaries|permission-catalog|role-template)' --maxWorkers=2
  → 20 suites, 252 tests, all pass
ALLOW_DESTRUCTIVE_DB_TESTS=1 DATABASE_URL=postgres://tarunchintakunta@127.0.0.1:5432/scratch_hrm15 HR_PROBE_DATABASE_URL=<same> \
  nice -n 15 npx jest --config ./jest-db.json --testPathPattern='directory/__tests__/' --maxWorkers=2
  → my 3 db specs: 25/25 pass. Pre-existing failures unchanged from the baseline run before any change:
    approval-authority.db.spec (7) and reporting-line.db.spec (3) — fixtures never set users.email_verified, so the
    V-021 "manager-never-accepted" refusal fires; employee-directory-counts.db.spec (8, Agent B area, same cause).
NODE_OPTIONS=--max-old-space-size=12288 nice -n 10 npx tsc --noEmit -p tsconfig.json  → EXIT=2, 5 errors, all in
  src/modules/kb/wiki/kb-wiki-project-scoped.spec.ts (pre-existing, untouched)
npx madge --circular --extensions ts src  → no circular dependency
```
DB spec harness: `requireApprovedDatabaseUrl` reads `HR_PROBE_DATABASE_URL` then `DATABASE_URL`, needs `ALLOW_DESTRUCTIVE_DB_TESTS=1` and a loopback host (or `DB_SPEC_ALLOWED_HOSTS`). Probes create and drop their own orgs.

Migration proof: `scratch_hrm15` and `scratch_hrm15_replay` were cloned from `scratch_hrmskb` by `pg_dump | pg_restore` (`createdb -T` was refused: a running API held 3 sessions on the template). The drizzle migrator could not apply the chain (1205/1206 use `CREATE INDEX CONCURRENTLY` inside its transaction), so every post-watermark entry was applied with the repo runner, one tag at a time: `DATABASE_URL=…?sslmode=disable node src/scripts/run-pending-migrations.mjs --tag=<tag>` (the untagged runner would also re-offer `1174`, whose hash is not recorded there). Verified by catalog: 6 tables with `rowsecurity`, 0 unvalidated constraints, 5 new constraints on `hr_reporting_lines`, the partial unique index, 6 `SELECT` grants to `streamline_app`; exclusion probes behave as specified. Rollback proof on the replay copy: all six `.down.sql` in reverse order, ledger rows deleted, re-applied — clean, legacy row archived again.

## 8. Audit / backfill counts

- `scratch_hrm15` (seeded org + shared scratch data, 1,100 primary lines, all finite `2036-09-22` ends, no successors): half-open rows normalised **0**, empty-period rows archived **0**, remaining overlapping primary pairs **0**, top-level backfill candidates **0** (no `topLevelRole` audit rows), rows now `source = MIGRATED` **1,100**. Active employees **5,102**, without a current primary line **4,002**, top-level **0**.
- `scratch_hrm15_replay` with two planted legacy rows: **1** half-open close normalised (`2026-08-01 → 2026-07-31`), **1** empty-period row moved to `hr_reporting_lines_superseded` (`LEGACY_EMPTY_PERIOD`), 0 overlaps after.
- Audit query for the rollout note is in the header of `1218_…sql`.

## 9. Deviations from CONTRACT.md and open items

1. **New table `hr_reporting_lines_superseded`** (1235). Required by "never produce `effective_to < effective_from`", "supersede future-dated rows correctly" and "never hard-delete history" together: a line replaced on or before its start date cannot be closed without inverting its range and cannot stay without overlapping its replacement, so it moves to the archive with full provenance. The D4 24h count includes archived primary rows. No existing reader needs to change. Requests/bulk rows that pointed at an archived line keep a `SET NULL` FK / plain trace id.
2. **Policy default-manager FK** targets `organization_members(org_id, user_id)` instead of `users(id)` — same column, tenant-consistent, cleared when the member is removed.
3. **Top-level role ended before it began** is closed on its own first day (`effective_to = effective_from`, `ended_at` set) rather than inverted; readers only treat a top-level role as in force when there is no current primary line.
4. **`policyMissing`** = no default primary manager configured (row absent or `default_primary_manager_user_id` null).
5. **Policy version conflict** is `409 { code: "CONFLICT" }` (generic), not a new `REPORTING_LINE_ERROR_CODES` entry.
6. **Actor typing**: `ReportingActor` covers request, background `{ orgId, userId, isOrgOwner }`, and `{ orgId, system }` (addendum item). Source `EFFECTIVE_CHANGE` is just a `source` value; a system actor still needs a D4 reason unless the caller passes `skipFrequencyGuard`.
7. **OPEN — outbox consumers.** `check:outbox-consumers` now FAILS: `hr.reporting_line.changed` and `hr.reporting_manager_policy.updated` are emitted (contract §2) with no registered consumer, so every emit will dead-letter. Addendum 2 routes notifications through `NotificationDispatchService.emit`, not the outbox. The main agent must either register a real consumer (e.g. the after-commit cache invalidation, or the webhook dispatcher) or drop the emits; I did not invent a consumer to green the gate.
8. **OPEN — ratchets owned by the main agent** (I did not edit `src/scripts/**`): `check:type-assertions` RAW_ROW_LEDGER now lists `reporting-line-coverage.ts` (7 `db.execute<T>`) and `reporting-line-queries.ts` (3) — the 6 moved from `reporting-line.service.ts` (itself unledgered before) plus 4 new; `check:unbounded-reads` flags `reporting-line-queries.ts`, `reporting-line.service.ts`, `reporting-manager-fallback.resolver.ts`, `reporting-relationship.service.ts` (all reads bounded by an id set or one org's policy/employees); `check:over-300` net +3 files (`reporting-line-coverage.ts` 319, `reporting-relationship.service.ts` 343, `reporting-line.service.ts` 465 — down from 587 — and `sync-canonical-reporting-line.ts` 480). All four gates were already failing on this branch before my changes.
9. Not done here (other owners): routes/DTOs/controllers and caller migration to `setRelationships` (Agent B); frontend permission union (Agent C). `assign`/`assignMany` stay until Block 3.

## Change after publication

**Outbox emits removed (main-agent decision).** `ReportingRelationshipService.setRelationships` and `ReportingManagerPolicyService.update` no longer call `OutboxWriter.emit`; `hr.reporting_line.changed` and `hr.reporting_manager_policy.updated` are no longer outbox events. The audit writes are unchanged: `hr.reporting_line.changed`, `hr.reporting_line.emergency_override` (severity high), `hr.reporting_line.fallback_confirmed`, `hr.reporting_manager_policy.updated`. Durable notifications go through `NotificationDispatchService.emit` in the transaction, and cache invalidation through `registerAfterCommit`; both are Agent B's. No public signature changed. This supersedes the outbox mentions in §3 and item 7 of §9.

The relationship db spec now asserts that no outbox row is written. Reruns:
- `check:outbox-consumers:self-test` → 32 passed.
- `check:outbox-consumers` → still exit 1, but only on pre-existing recruitment orphans (`candidate.moved/rejected/hired/applied`, `referral.bonus_due`). No HRM-15 event remains.
- Focused unit specs → 252/252 pass.
- The three HRM-15 db specs on `scratch_hrm15` → 25/25 pass.
