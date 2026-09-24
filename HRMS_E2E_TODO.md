# HRMS E2E Remediation TODO

Source: HRMS E2E QA audit (2026-09-24), tickets HRMS-E2E-001…020 + HRMS-LEGACY-01…14.

**Working copies** — both repos are checked out on `main`:
- BE `/Users/tarunchintakunta/Personal/streamline/streamlineos-backend`
- FE `/Users/tarunchintakunta/Personal/streamline/streamlineos-frontend` (app code under `frontend/`)

**Convention**: paths tagged _(likely, verify in code)_ are Phase-0 hypotheses, confirmed or corrected as each item is worked. Paths without the tag were read during Phase 0 and are confirmed.

**Status legend**: `todo` | `in_progress` | `done` | `BLOCKED`

---

## Phase 0 findings that change the ticket picture

These were read in code before any change and reshape several tickets:

1. **A shared approver resolver already exists.** `src/modules/directory/approval-authority.service.ts` resolves
   `reporting_manager → managers_manager → department_head → queue(permission)`, skips the subject, records
   `skipped[]` reasons and returns a human `explanation`. `LeavesWriteService.create` already calls it and throws
   `409` with that explanation when `rung === null`. So HRMS-E2E-010a is mostly **already built**; the real gap is
   the *owner* case (subject is the only queue member) and the FE's silent disabled button.
2. **The 402 on expenses is already a structured envelope**, not a bare 402: `ModuleDisabledException`
   (`src/common/http/api-exceptions.ts:42`) returns `{code:"MODULE_NOT_ENABLED", message, details:{moduleKey,reason,upgradePath}}`.
   The expenses controllers are gated `@RequireModule("accounting")`, not `"hr"` — an HR-only org is denied by design.
   Which modules a plan includes is **decision #1** and stays BLOCKED; the FE not rendering the message is in scope.
3. **The attendance import duplicate guard already landed** (`hr-import-commit.service.ts`, explicit same-day check
   with a comment naming this exact bug). HRMS-E2E-005b is partly done — verify, then close the remaining gaps
   (checkOut > checkIn, future date, in-file duplicates at preview time).
4. **Imports do carry `orgId` on every insert** in `HrImportCommitService` and on `hr_import_rows`. The tenant-ID
   STOP-RULE check for 003/004/005 is therefore expected to come back clean, but is still run and recorded before
   any fix-forward.
5. **`toTitleCase` exists but is applied to `role`, not names** (`hr/directory/org-chart-helpers.ts:52`, used at
   `org-chart.service.ts:270`). The BE onboarding path does not title-case `firstName`/`lastName`. HRMS-E2E-020's
   cause is therefore elsewhere — verify FE display + CSV export path.
6. **`GET /hr/export/:entity`** exists on `HrImportController` and builds its CSV header from `Object.keys(rows[0] ?? {})`
   — so an empty result set yields a genuinely 0-byte file. That is the 013/017 "0-byte export" mechanism on the
   server side, independent of the CORS failure QA also saw.

---

## Ticket rows

### HRMS-E2E-001 — Invite email never delivered · P0 · both

| Sub | Repo | Likely files | Acceptance | Depends | Status | Evidence |
|---|---|---|---|---|---|---|
| 001a outbox + send status | BE | `src/modules/organization/core/invitation-create.service.ts`, `src/modules/organization/core/lib/invitation-mail-ops.ts`, `src/modules/email/email-outbox.service.ts`, `src/modules/hr/directory/employee-onboarding.service.ts` | Invite/resend writes hashed single-use token + TTL **and** outbox row in one DB transaction; no raw token in logs; resend rate-limited and invalidates the prior token | Foundations, 014 | todo | |
| 001b Copy invite link | both | BE `employees.controller.ts` _(likely, verify in code)_; FE `frontend/features/hr/employees/**` _(likely, verify in code)_ | ORG_ADMIN/HR can copy an invite link (permission-guarded + audit logged); private-window open starts join; employee detail shows `queued\|sent\|delivered\|bounced\|failed` | 001a | todo | |
| 001c delivery verification | ops | — | Real inbox receipt within ~1–2 min | provider env | todo | Expected **BLOCKED** if SMTP/provider keys or SPF/DKIM are absent in this environment |

### HRMS-E2E-002 — Onboarding bulk cannot stage managers · P0 · both

| Sub | Repo | Likely files | Acceptance | Depends | Status | Evidence |
|---|---|---|---|---|---|---|
| 002a owner employment | BE | `src/modules/hr/directory/employee-onboarding.service.ts`, `src/modules/organization/setup/org-setup.service.ts`, new idempotent backfill | Owner has an employment record at org create; idempotent backfill for existing orgs; owner usable as `reportingManagerEmail` | 008 | todo | |
| 002b same-file manager graph | BE | `src/modules/hr/directory/bulk-onboarding/bulk-onboarding-plan.ts`, `bulk-onboarding-writes.ts`, `employee-bulk-onboarding.service.ts` | Dependency graph from `reportingManagerEmail`, topo-sorted, one transaction; cycle → row error; manager failure → dependent row error citing the manager's row; in-file duplicate email (incl. case variants) and under-16 DOB → row errors; existing member flagged; duplicate `employeeId` handled; re-run creates no duplicates | 002a | todo | |
| 002c template/docs | both | BE template generator; FE onboarding bulk UI | Template + instructions include `reportingManagerEmail` and `topLevelRoleReason` | 002b | todo | |

### HRMS-E2E-003 — Employees import commit persists nothing · P0 · both

| Sub | Repo | Likely files | Acceptance | Depends | Status | Evidence |
|---|---|---|---|---|---|---|
| 003a tenant-ID STOP check | BE | read-only query, non-prod DB | No import-written rows with null/wrong `tenant_id`; result recorded here **before** any fix-forward | — | todo | |
| 003b commit writes + counts | BE | `src/modules/hr/import/hr-import-commit.service.ts` (`commitEmployee`), `hr-import.service.ts` (`commitJob`) | Natural key `(org_id, lower(email))`; on match update names/designation/department/joining date; counts come from DB `RETURNING`; `created+updated+unchanged == preview valid` or the job fails; UI never shows *Committed* when 0 of N were written | 003a | todo | |
| 003c email / emp# dedupe | BE | `src/modules/hr/import/schemas/entity-row-schemas.ts` | Secondary unique `(org_id, employee_number)` where not null; emp# belonging to a different email → row error; in-file duplicate email → error on later rows; email compared case-insensitively | 003b | todo | |

### HRMS-E2E-004 — Leave balances import drops data · P0 · both

| Sub | Repo | Likely files | Acceptance | Depends | Status | Evidence |
|---|---|---|---|---|---|---|
| 004a tenant-ID STOP check | BE | read-only query | as 003a | — | todo | |
| 004b reference validation | BE | `hr-import-commit.service.ts` (`commitLeaveBalance`), `entity-row-schemas.ts` | Unresolved employee or leave type → **row error**, never a silent drop; in-file duplicate key → error | 009 (default leave types) | todo | |
| 004c persist + count reconcile | BE | same | Key `(org_id, user_id, leave_type_id, year)`; balance set **absolute** (file wins); ON CONFLICT target must match the real unique index (verify `org_id` is in it — Drizzle needs every indexed column); re-import → 0 creates | 004b | todo | |

### HRMS-E2E-005 — Attendance import invalid + persists none · P0 · both

| Sub | Repo | Likely files | Acceptance | Depends | Status | Evidence |
|---|---|---|---|---|---|---|
| 005a tenant-ID STOP check | BE | read-only query | as 003a | — | todo | |
| 005b time/uniqueness validation | BE | `entity-row-schemas.ts`, `hr-import-commit.service.ts` (`commitAttendance`) | `checkOut > checkIn`; status enum; date not in the future in org TZ (default `Asia/Kolkata`); same-day duplicate rejected **at preview**, not only at commit | — | todo | Same-day commit-time guard already present — verify it holds |
| 005c persist + counts | BE | `hr-import.service.ts` | 1 valid unique-day row commits and appears in the attendance list; re-import creates 0 duplicates | 005b | todo | |

### HRMS-E2E-006 — Asset import not idempotent / serial dupes · P0 · both

| Sub | Repo | Likely files | Acceptance | Depends | Status | Evidence |
|---|---|---|---|---|---|---|
| 006a duplicate audit **before** index | BE | read-only cross-tenant query on `assets` | Duplicate serial groups reported; **no deletion**; index created only after approved cleanup | — | todo | BLOCKED → index, if duplicates exist |
| 006b serial upsert | BE | `hr-import-commit.service.ts` (`commitAsset`) | In-file duplicate serial → row errors; DB match on `(org_id, upper(trim(serial)))` → update fields/assignee | 006a | todo | |
| 006c re-import idempotent | BE | same | First import of 2 distinct serials → 2 rows; re-import → 0 new | 006b | todo | |

### HRMS-E2E-007 — Document import duplicates on re-import · P0 · both

| Sub | Repo | Likely files | Acceptance | Depends | Status | Evidence |
|---|---|---|---|---|---|---|
| 007a identity key | BE | `hr-import-commit.service.ts` (`commitDocument`) | **PROVISIONAL (decision #2)**: upsert on `(org_id, user_id, category, lower(trim(name)))`; exact row match counts as *unchanged* | decision #2 | todo | Unique **index** stays BLOCKED until dupes audited + cleanup approved |
| 007b reject exact dupes | BE | `entity-row-schemas.ts` | Exact duplicate within the file → row error | 007a | todo | |
| 007c re-import idempotent | BE | same | First import → 2 distinct docs; second import does not double. Also: `type` is currently hard-coded `"OTHER"`, discarding the CSV column — fix | 007a | todo | |

### HRMS-E2E-008 — Employee detail fails (new + owner) · P0 · both

| Sub | Repo | Likely files | Acceptance | Depends | Status | Evidence |
|---|---|---|---|---|---|---|
| 008a left-join / nullable DTO | BE | `src/modules/hr/directory/employee-detail.controller.ts`, `employee-detail-canonical-read.spec.ts`, `dto/directory-response.schemas.ts` | Optional relations left-joined; nullable fields nullable in the Zod response DTO; lookup by `id + org`; never 500 on a null optional; cross-tenant GET → 404 | — | todo | |
| 008b owner employment stub | BE | `employee-onboarding.service.ts`, org-setup | Owner GET detail → 200; invitee-not-accepted GET detail → 200; create → immediate GET detail 200 | 002a | todo | |
| 008c FE error surface | FE | `frontend/features/hr/employees/**` _(likely, verify in code)_ | Failure shows the envelope message + `requestId` | Foundations | todo | |

### HRMS-E2E-009 — Leave policy create server error · P0 · both

| Sub | Repo | Likely files | Acceptance | Depends | Status | Evidence |
|---|---|---|---|---|---|---|
| 009a create API + field errors | both | `src/modules/hr/time/leave-policies.controller.ts`, `leave-policies.service.ts`; FE `frontend/features/hr/leave-policies/**` | POST succeeds; bad input → 422 with field details; no opaque toast without a request ID | Foundations | todo | |
| 009b seed default leave types | BE | `src/modules/hr/time/leave-types.service.ts`, `src/modules/hr/policies/seed-default-policies.ts` | Default leave types seeded at org create + idempotent backfill; policy usable for balances/requests | — | todo | |

### HRMS-E2E-010 — Leave submit disabled, no approver · P0 · both

| Sub | Repo | Likely files | Acceptance | Depends | Status | Evidence |
|---|---|---|---|---|---|---|
| 010a shared approver resolver | BE | `src/modules/directory/approval-authority.service.ts`, `src/modules/hr/time/leaves-write.service.ts` | Order policy → reporting manager → dept head → HR admin → owner, skipping the requester | 008, 002 | todo | Resolver **already exists** — verify order + owner fallback |
| 010b owner's own leave | BE | same | **PROVISIONAL (decision #3)**: route to another org/HR admin; never auto-approve | decision #3 | todo | If no other approver exists, owner path → **BLOCKED** |
| 010c UI checklist / unassigned queue | both | FE leave request form | Empty chain → submit still possible into an unassigned queue **or** a visible setup checklist with a CTA; never a silent disabled button | 010a | todo | |

### HRMS-E2E-011 — People Analytics hard-errors · P0 · both

| Sub | Repo | Likely files | Acceptance | Depends | Status | Evidence |
|---|---|---|---|---|---|---|
| 011a null-safe aggregates | BE | `src/modules/hr/analytics-plus/hr-analytics-plus.service.ts`, `src/modules/hr/lifecycle/hr-analytics.service.ts` | Empty tenant → 200 with empty/zero series, never 500 | — | todo | |
| 011b empty state + requestId | FE | `frontend/features/hr/analytics/**`, `frontend/features/hr/engagement/**` | Dashboard or soft empty state, with request ID on failure | Foundations | todo | |
| 011c per-widget isolation | FE | same | One widget's failure does not kill the page | 011b | todo | |

### HRMS-E2E-012 — Expenses import/export 402 / missing GET · P0 · both

| Sub | Repo | Likely files | Acceptance | Depends | Status | Evidence |
|---|---|---|---|---|---|---|
| 012a entitlement single source | both | `src/common/rbac/module.guard.ts`, `src/common/http/api-exceptions.ts`, FE nav/entitlement hook | FE reads the **same** module entitlement the guard enforces; a denied action shows the `MODULE_NOT_ENABLED` message + module key instead of a bare 402 | decision #1 | todo | **Which plans include Expenses is BLOCKED (decision #1).** Controllers are gated `accounting`; not changed here |
| 012b export job contract | both | `src/modules/expenses/expenses.controller.ts` (`POST hr/expenses/export/jobs`, `GET …/:jobId`, `…/download`), FE settings export | Settings and the page use the same async job contract; no route that 404s as `Cannot GET /hr/expenses/export` | 013a helper | todo | |
| 012c import via pipeline | BE | `src/modules/expenses/expenses-import.service.ts` | Unknown category → row error or explicit mapping, never a silent map to `Other`; soft duplicate warning on `(employee, date, amount, category, merchant)`; when entitled, valid rows persist and export returns them | 012a | todo | |

### HRMS-E2E-013 — Settings asset export 0-byte / CORS · P0 · both

| Sub | Repo | Likely files | Acceptance | Depends | Status | Evidence |
|---|---|---|---|---|---|---|
| 013a CORS + route | BE | `src/main.ts` CORS config, `src/modules/hr/import/hr-import.controller.ts` (`GET hr/export/:entity`) | App origin allow-listed with credentials; **error** responses also carry CORS headers; `Content-Disposition` exposed | — | todo | |
| 013b shared FE download helper | FE | `frontend/features/hr/import-export/**`, `frontend/lib/api/**` _(likely, verify in code)_ | One helper checks `ok`, content-type and non-empty body, parses the error envelope, and never saves a 0-byte "success" file | 013a | todo | |
| 013c non-empty export | BE | `hr-import.controller.ts` + `hr-export-csv.ts` | With N assets, export has a header row + N data rows (header comes from the schema, not from `rows[0]`) | 013a | todo | |

### HRMS-E2E-014 — Active before invite acceptance · P1 · both

| Sub | Repo | Likely files | Acceptance | Depends | Status | Evidence |
|---|---|---|---|---|---|---|
| 014a status model | BE | `src/modules/hr/directory/employee-admission-status.ts`, `src/modules/organization/core/membership-admission.service.ts` | Employment status and invite/account status are distinct; a new hire is `pending` until acceptance | decision #4 | todo | PROVISIONAL default: pending → active on acceptance |
| 014b exclude pending | BE | headcount/analytics/attendance/roster/approver queries | Pending excluded from active headcount, analytics, attendance, rosters, work logs and the leave-approver pool | 014a | todo | |
| 014c backfill | BE | new idempotent script | Written but **not run** | decision #4 | todo | **BLOCKED** pending decision #4 |

### HRMS-E2E-015 — Work logs disabled; roster no assign · P1 · both

| Sub | Repo | Likely files | Acceptance | Depends | Status | Evidence |
|---|---|---|---|---|---|---|
| 015a roster assignments | BE | `src/modules/hr/time/**` rosters/shifts _(likely, verify in code)_ | `roster_assignments` (or the existing equivalent) with overlap validation | 014 | todo | |
| 015b assign UI | both | FE `frontend/features/hr/rosters/**` | Assign/unassign on a draft roster, permission-guarded | 015a | todo | |
| 015c manual clock / work log | both | `src/modules/hr/time/attendance-clock.service.ts`, FE `frontend/features/hr/work-logs/**` | Manual clock-in/out and work log with `source = manual`, no biometric needed; RBAC + audit; admin can produce ≥1 visible attendance/work-log event for an active employee | 015a | todo | |

### HRMS-E2E-016 — Expenses import UX/schema mismatch · P1 · FE (+BE template)

| Sub | Repo | Likely files | Acceptance | Depends | Status | Evidence |
|---|---|---|---|---|---|---|
| 016a disable until file | FE | `frontend/features/hr/expenses/**` | Import button disabled until a file is selected | — | todo | |
| 016b schema-generated template | both | `src/modules/expenses/dto/expense-import.schemas.ts` | Template generated from the validator's schema; header aliases accept Title Case, snake_case and camelCase; docs match the template; sample row present if the docs claim one | 012c | todo | |

### HRMS-E2E-017 — Leave export toast instead of empty file · P2 · both

| Sub | Repo | Likely files | Acceptance | Depends | Status | Evidence |
|---|---|---|---|---|---|---|
| 017a header-only or clear unavailable | both | FE `frontend/features/hr/leaves/**`, BE leave export | Header-only file via the export job path, or the action is clearly unavailable — no fake download, no bare toast | 013 | todo | |

### HRMS-E2E-018 — Owner shown as email prefix · P2 · both

| Sub | Repo | Likely files | Acceptance | Depends | Status | Evidence |
|---|---|---|---|---|---|---|
| 018a collect full name + prompt | both | `src/modules/organization/setup/org-setup.service.ts`, FE signup/org-setup | Full name collected at signup/org setup; existing owners prompted when missing; directory, org chart and export show the real name | 008 | todo | |

### HRMS-E2E-019 — Fake mobile accepted at org setup · P2 · both

| Sub | Repo | Likely files | Acceptance | Depends | Status | Evidence |
|---|---|---|---|---|---|---|
| 019a IN mobile validation | both | `src/modules/organization/setup/dto/org.schemas.ts`, FE org-setup form | Optional, or `+91` + 10 digits starting 6–9 with repeated-digit patterns rejected; never claim a verified OTP that does not exist | — | todo | |

### HRMS-E2E-020 — Name auto title-cased · P2 · both

| Sub | Repo | Likely files | Acceptance | Depends | Status | Evidence |
|---|---|---|---|---|---|---|
| 020a store as entered | both | FE display/formatter _(likely, verify in code)_; BE export path | Names stored and displayed exactly as entered (trim only); no auto title-case in DTO or formatter | — | todo | BE onboarding path confirmed clean; cause is downstream |

### Legacy fold-ins

| ID | Pri | Repo | Likely files | Acceptance | Depends | Status | Evidence |
|---|---|---|---|---|---|---|---|
| LEGACY-01 department create id | P1 | both | FE onboarding department form; BE department create response | Response carries a string `id`; the form sets `departmentId` immediately; empty-state CTA; one create without reopening | — | todo | |
| LEGACY-02 manager without employment | P1 | BE | `approval-authority.service.ts` (`manager-has-no-employment` skip reason) | Covered if the 002/008 owner stub lands; otherwise implement the allow-approver-without-employment alternative and note it | 002, 008, 010 | todo | |
| LEGACY-03 org-chart peer root | P1 | both | `src/modules/hr/directory/org-chart.service.ts`, FE org chart | Unmanaged hire lands in an *Unassigned / needs manager* bucket, not as a peer CEO; onboarding warning | 002 | todo | |
| LEGACY-04 designation vs positions | P1 | both | people/positions | Free-text designation with 0 positions guides create-role/position or is marked provisional; no silent divergence | — | todo | |
| LEGACY-05 role count mismatch | P1 | both | `/hr/access` vs settings roles | One source of truth, or explicitly labelled scopes | — | todo | |
| LEGACY-06 India compliance seed | P1 | both | `src/modules/compliance/**` | Idempotent seed; offered at first HR setup; never imply coverage when empty | — | todo | |
| LEGACY-07 duplicate name heading | P2 | FE | employee detail header | Display name shown once | 008 | todo | |
| LEGACY-08 leave empty / 0 days UX | P2 | FE | `frontend/features/hr/leaves/**` | Empty state + "Policies not configured" | 009 | todo | |
| LEGACY-09 attendance offline copy | P2 | FE | `frontend/features/hr/attendance/**` | Offline vs not-provisioned distinguished; CTA into 015 | 015 | todo | |
| LEGACY-10 empty-module checklist | P2 | FE | HRMS shell | Shared *Start here*: People → Leave → Attendance → Documents | — | todo | |
| LEGACY-11 sensitive tab trust | P3 | FE | people sensitive tab | Optional — only if cheap after P0–P1 | — | todo | |
| LEGACY-12 salary default ₹25,000 | P3 | both | comp | Optional | — | todo | |
| LEGACY-13 PF/ESI inline help | P3 | FE | comp/compliance | Optional | LEGACY-06 | todo | |
| LEGACY-14 essentials nav mode | P3 | FE | nav | Optional | — | todo | |

---

## Open product decisions (Joseph)

| # | Decision | What is built around it | Status |
|---|---|---|---|
| 1 | Is Expenses in trial and base plans? | Error **shape** and the FE surfacing it are fixed; entitlement seeds, plan keys and pricing untouched | Entitlement part **BLOCKED** |
| 2 | Document re-import identity key | PROVISIONAL `(org_id, user_id, category, lower(trim(name)))`; exact row match = unchanged | Unique **index** BLOCKED until dupes audited + cleanup approved |
| 3 | How the owner's own leave is approved | PROVISIONAL: route to another org/HR admin; never auto-approve | Owner path **BLOCKED** if no second approver exists |
| 4 | Active on acceptance alone, or acceptance + joining date? | PROVISIONAL: pending until acceptance, then active | **Backfill BLOCKED**, script written but not run |

---

## Tenant-isolation stop-rule log (003 / 004 / 005)

| Import | Query run | Result | Date |
|---|---|---|---|
| employees | | | |
| leave_balances | | | |
| attendance | | | |
