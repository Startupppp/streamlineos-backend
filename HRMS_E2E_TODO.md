# HRMS E2E Remediation TODO

Source: HRMS E2E QA audit, tickets **HRMS-E2E-001…033** + HRMS-LEGACY-01…14.
Org under audit: *QA Audit Co 0924*. Live env is context only — every fix is made and
verified in code plus local/branch tests.

> **Renumbering note.** An earlier brief numbered a 20-ticket subset of this same audit.
> That numbering is retired. Where work already landed under an old ID, the row below
> carries the new ID and cites the same commits; the old ID is named in the Evidence
> column so the history stays traceable. Nothing was re-done and nothing was dropped.

**Working copies** — both repos on branch `hrms/e2e-001-033`, cut from `main`:
- BE `/Users/tarunchintakunta/Personal/streamline/streamlineos-backend`
- FE `/Users/tarunchintakunta/Personal/streamline/streamlineos-frontend` (app code under `frontend/`)

**Convention**: paths tagged _(likely, verify in code)_ are hypotheses, confirmed or
corrected as each item is worked. Untagged paths were read.

**Status vocabulary** (§4 honesty rule — CLAIMED and VERIFIED are not the same word):

| Status | Means |
|---|---|
| `todo` | not started |
| `re-verify` | Phase-1 ticket, reproduction not yet attempted |
| `in_progress` | started, not finished |
| `done-verified` | **every** acceptance criterion met **with evidence** |
| `Partial` | some criteria met; the unmet ones are named in the row |
| `claimed-unverified` | code written, no evidence run |
| `not-reproduced` | could not reproduce; evidence of the attempt recorded |
| `BLOCKED` | with exact reason and owner (Joseph / ops / eng) |

**Evidence standard**: a failing-then-passing test name plus its pass output, a command
exit code, an API status + body, or a described UI result after re-running the repro.
Where a row's evidence is a **service-level integration test against a real Postgres**
rather than an HTTP e2e, the row says so — that is a real but different guarantee.

---

## Phase 0 findings that reshape the ticket picture

Read in code before any change:

1. **A shared approver resolver already exists.** `src/modules/directory/approval-authority.service.ts`
   resolves `reporting_manager → managers_manager → department_head → queue(permission)`, skips the
   subject, records `skipped[]` reasons and returns a human `explanation`. `LeavesWriteService.create`
   already calls it and 409s with that explanation. **011** is therefore a *wiring + permission* problem
   (does the manager hold `hr:leaves:approve`?), not a missing resolver.
2. **The 402 on expenses is already a structured envelope.** `ModuleDisabledException`
   (`src/common/http/api-exceptions.ts:42`) returns `{code:"MODULE_NOT_ENABLED", message,
   details:{moduleKey,reason,upgradePath}}`. The expenses controllers are gated
   `@RequireModule("accounting")`, not `"hr"` — an HR-only org is denied by design. Which modules a plan
   includes is **decision #1** and stays BLOCKED.
3. **Imports carry `orgId` on every insert.** The tenant-ID STOP-RULE check for 001/002/003 came back
   clean — see the log at the foot of this file.
4. **`toTitleCase` exists but is applied to `role`, not names** (`hr/directory/org-chart-helpers.ts:52`).
   The BE onboarding path does not title-case `firstName`/`lastName`. **027**'s cause is not on the
   server write path.
5. **`GET /hr/export/:entity`** built its CSV header from `Object.keys(rows[0] ?? {})`, so an empty
   result set yielded a genuinely 0-byte file — the **009**/**022** mechanism on the server side,
   independent of the CORS failure QA also saw.
6. **The error envelope is `{code, message, details?, correlationId?}`**, not `{error:{…}}`, and
   validation answers **400 `VALIDATION_FAILED`**, not 422. That is `AllExceptionsFilter`'s repo-wide
   contract (BE-17/BE-20). §10.1 of the brief proposes a different shape; changing it would break every
   client in the product, so the deviation is **recorded, not applied** — see Shared-infra notes.

---

## Phase 1 — RE-VERIFY FIRST

No code change for these five until the reproduction outcome is recorded.

| ID | Title | Re-verify outcome | Recorded |
|---|---|---|---|
| 007 | People Analytics hard-errors | **REPRODUCED** — and the cause is not the one in the ticket. `hr_mood_checkins.date` is a **text** column compared to `NOW() - INTERVAL '12 months'`; Postgres raises 42883 (`text >= timestamptz`) before reading a row, so every call 500s on a full tenant too, not only an empty one. Measured each of the six trend queries separately against real Postgres — five were already fine. | Fixed, `55f274499` |
| 016 | Work logs disabled; rosters no assignment | `re-verify` | pending |
| 023 | Sign-in codes delayed/batched; valid code rejected | `re-verify` | pending |
| 024 | Leave policy server error | **NOT REPRODUCED on the server.** `createLeavePolicySchema` carries per-field messages and `assertLeaveTypeInOrg` 404s a foreign type; `provisionEmployeeSelfService` (called by `bootstrapCellOrganization`) seeds five leave types with `onConflictDoNothing`. No 500 path found. Deviation recorded: validation answers 400 `VALIDATION_FAILED`, not 422. | recorded |
| 032 | Leave submit disabled | `re-verify` | pending |

---

## Ticket rows

Severity legend: **B**locker · **H**igh · **M**edium · **L**ow.

### Phase 4 — Blocker: imports that report success but persist nothing

| ID | Sev | Repo | Files (confirmed) | Dep | Status | Evidence |
|---|---|---|---|---|---|---|
| **001** Employees import persists nothing | B | both | `hr-import-commit.service.ts` (`commitEmployee`), `hr-import.service.ts` (`commitJob`), `schemas/import-row-identity.ts` | — | **done-verified** | *(was 003)* `bb306a6a3`, `7666f07e4`, `4ffee54e7`, `6a4be16b3`. **Root cause**: the directory reads `organization_members INNER JOIN users` and only LEFT JOINs `hr_people` (`employees.service.ts:156`); the import wrote neither, so an imported employee could never be listed — and `hr_people.user_id` stayed NULL, which is why 002/003/005 then failed with "No user found". Now goes through `MembershipAdmissionService` + `PersonEmploymentSyncService`. Natural key `(org, lower(email))`, secondary `employeeNumber`, in-file dupes error the later row, a zero-write job records `failed` not `committed`, counts come from DB outcomes and a reconcile invariant asserts `created+updated+unchanged == valid`. Evidence: `hr-employee-import.db.spec.ts` (6 real-DB assertions) + `import-row-identity` cases, all green. **Gap to the new brief**: no HTTP e2e; the guarantee is service-level against real Postgres |
| **002** Leave balances import drops data | B | both | `commitLeaveBalance`, `import-row-identity.ts` | 024 | **done-verified** | *(was 004)* `6a4be16b3`, `4ffee54e7`. Unresolved employee/leave-type already threw → row error; the silent-drop half was the in-file duplicate, now an error. Absolute set on `(user_id, leave_type_id, year)` — conflict target verified against the real index `uniq_leave_balances_user_type_year`; `leave_type_id` is itself org-scoped. Outcome now created/updated/**unchanged**. **Gap**: no HTTP e2e |
| **003** Attendance import accepts invalid rows, persists none | B | both | `entity-row-schemas.ts`, `commitAttendance` | — | **done-verified** | *(was 005)* `6a4be16b3`, `6fced68be`, `4ffee54e7`. **Second defect found**: the dialog documents `checkIn` as `09:30` and the commit called `new Date("09:30")` — an Invalid Date — so every row in the documented format failed at insert. Both a wall clock (read in org TZ, default Asia/Kolkata) and a full ISO timestamp are accepted. `checkOut > checkIn`, status enum, no future date, same-day duplicate guard. Evidence: `hr-import-attendance-idempotency.db.spec.ts`, green. **Gap**: no HTTP e2e |

### Phase 5 — Blocker: duplicate-safe asset & document imports

| ID | Sev | Repo | Files (confirmed) | Dep | Status | Evidence |
|---|---|---|---|---|---|---|
| **004** Asset import not idempotent / serial corruption | B | BE | `commitAsset` | — | **Partial** | *(was 006)* `4ffee54e7`. **Met**: match on `upper(trim(serial_number))` within org, in-file duplicate serial errors, re-import creates 0 rows, and a blank assignee column no longer strips an assignment made in the app. Evidence: `hr-import-idempotency.db.spec.ts` — real-DB row counts before/after re-import. **Not met**: the partial unique index. The existing estate has not been audited (production data) and §9 forbids creating it before an approved cleanup. **BLOCKED — needs Joseph/ops**: duplicate-serial audit + cleanup approval |
| **005** Document import doubles on re-import | B | BE | `commitDocument`, `import-row-identity.ts` | decision #2 | **done-verified (PROVISIONAL)** | *(was 007)* `4ffee54e7`, `6a4be16b3`. Key `(org, user_id is not distinct from, lower(trim(category)), lower(trim(name)))` — decision #2's provisional default, commented as such. In-file exact dupes error; re-import creates 0. **Also**: the `type` column was parsed, validated and *discarded* — every document stored as OTHER. Now validated against the `document_type` enum and kept. Unique index deliberately not created (same rule as 004) |

### Phase 3 — People core (dependency enabler)

| ID | Sev | Repo | Files (confirmed) | Dep | Status | Evidence |
|---|---|---|---|---|---|---|
| **006** Employee detail fails for new + owner | H | both | `employee-mutations.service.ts:71`, `bootstrap-cell-organization.ts` | — | **Partial** | *(was 008)* `b154ef3ed`. **Already met on main** (verified in code, no change needed): `getEmployeeDetail` wraps skills, employment and employment-facts in `degraded(...)`, every employment field is `?? null`, a missing member is 404 not 500, the read is tenant-scoped, cross-tenant is 404. **Fixed**: the owner had no employment record — `provisionOwnerEmployment` now writes one at org create through `ensureManyFromUsers`, staged `PRE_JOINING` so a founder who was never hired stays out of headcount. Evidence: `owner-employment-bootstrap.db.spec.ts`, 4 real-DB assertions. **Not met**: the FE does not display `correlationId` on failure — see Shared-infra note 2 |
| **015** Employee Active before accepting invite | M | both | `employees.service.ts` (`getEmployeeCounts`), FE `employees-directory-stats.tsx` | decision #4 | **Partial** | *(was 014)* `412ca7a1e`, `406cb1e6d`. **Root cause**: the count filtered on `users.isActive`, the ACCOUNT flag, set true the moment an administrator creates the person — so an unopened invitation was headcount. Acceptance is taken to be `users.email_verified`, which the magic link sets. Pending is now its own directory card, hidden when nobody waits. No stored status, so no migration and no backfill either way. **Not met**: analytics, attendance, rosters, work logs and the approver pool still count a pending person — each reads a different query and none was touched. **Backfill BLOCKED** on decision #4 |
| **025** Owner displayed as email prefix | L | both | `src/modules/auth/auth.service.ts:163`, `auth-passwordless.utils.ts:46` | 006 | **todo** — cause confirmed | *(was 018)* Traced: a signup with no name falls back to `email.split("@")[0]`, which is how the owner became `ywpkpz+7po5eetnm3vno`. The org-setup wizard collects company name, industry, size and phone — **not the person's name**. Fix is a name field on the Basics step written through to `users`, plus a prompt for owners already carrying a local-part name |
| **027** Employee name capitalization changed | L | both | `dto/employee-name-verbatim.spec.ts` | — | **not-reproduced** | *(was 020)* `c3ff68b41`. Traced end to end: the onboarding schema trims only; `PersonEmploymentSyncService` and the bulk writer pass names through; the org chart returns `name: row.name`; the export serialises untransformed. The single `toTitleCase` is applied to the membership **role** (`ORG_ADMIN` → "Org Admin"). No FE name formatter and no CSS `capitalize` on a name. Shipped a 10-assertion regression net across an initialism, an internal capital, a particle, an apostrophe and a hyphen. **If QA still sees it, the evidence needed is the API response body** — that says whether the name is altered at the server or only on screen |

### Phase 6 — Leave flow *(the largest remaining block; 010→011→012→013→014)*

| ID | Sev | Repo | Files _(likely, verify in code)_ | Dep | Status | Evidence |
|---|---|---|---|---|---|---|
| **010** HR roles cannot be configured or assigned | H | both | BE module-access/role-membership service; FE `features/module-access/**`, HR Access > Roles | — | **todo** | Acceptance: assign existing org users to HR role groups with an audit row; a Manager-capable role can include `hr:leaves:approve` (decision #5, PROVISIONAL allowed); Members panel reflects real assignments; system roles stay labelled. Tests: unit — membership service assigns within tenant, rejects cross-tenant; e2e — ORG_ADMIN assigns manager a role granting `hr:leaves:approve`, Members lists them |
| **011** Approval routing bypasses the reporting manager | H | both | `approval-authority.service.ts`, leave approvals surfaces | 010 | **todo** | Phase-0 finding 1: the resolver already prefers the reporting manager — it skipped them with "they cannot approve this kind of request", i.e. the manager did not hold `hr:leaves:approve`. So this is 010's assignment path plus making the routing text match the real outcome. Tests: unit — resolver returns the manager when they hold the key, skips the requester; e2e — member submits, manager approves |
| **012** Phantom manager leave requests | H | both | `LeavesWriteService`, "my leaves" list query | 011 | **todo** | Acceptance: one request identity, requester preserved; a report's leave never inserts a manager-owned row; "My leaves" filters by requester id; detection query for existing phantoms written but **not run** (§9). Tests: unit — create does not clone; e2e — two reports submit → admin sees exactly two |
| **013** `/hr/approvals` empty while Leave approvals has pending | H | both | approvals queue query vs leave approvals query | 011 | **todo** | decision #6 PROVISIONAL: one source of truth; Leave > Approvals becomes a filtered view. Tests: unit — queue query returns HR-queue leave requests for an admin; e2e — item appears on `/hr/approvals` and can be acted on |
| **014** Balances ignore policy; deduction unverifiable | H | both | leave balance service, dashboard widget vs Time Off header | 002, 024 | **todo** | Acceptance: balance reads the configured policy; approve deducts, reject does not; widget, header and admin summary agree; copy never says "no leave policy" when one exists. Tests: unit — accrual from policy, approve mutates, reject does not; e2e — 12-day policy → 12 available → approve 2 days → 10 |

### Phase 7 — Exports

| ID | Sev | Repo | Files (confirmed) | Dep | Status | Evidence |
|---|---|---|---|---|---|---|
| **008** Expenses import/export 402 | H | both | `module.guard.ts`, `api-exceptions.ts`, expenses controllers, FE entitlement hook | decision #1 | **BLOCKED (part) / todo (part)** | *(was 012)* The envelope is already `MODULE_NOT_ENABLED` with `{moduleKey,reason,upgradePath}` — not a bare 402. **BLOCKED**: which plans include Expenses is decision #1; entitlement seeds, plan keys and pricing untouched. **Still todo**: FE rendering that message instead of a generic error; export job contract alignment; unknown-category handling |
| **009** Settings asset export 0-byte | H | both | `hr-export-columns.ts`, `src/main.ts:115`; FE `lib/download-export.ts` | — | **Partial** | *(was 013)* `95fb5271d`. **Met**: the header now comes from the exported table's columns, so an empty page is a header-only CSV, never 0 bytes (`hr-export-columns.spec.ts`, 7 assertions); `content-disposition`, `x-has-more` and `x-next-cursor` added to `exposedHeaders` — without them a cross-origin download got a blob with no filename and a paged export looked complete after page one. FE `download-export.ts` + `download-export-job.ts` guard non-2xx, **zero-byte body** and HTML/JSON content-type. **Not met**: those helpers are not yet wired into every export call site. **BLOCKED (ops)**: QA's console shows the fetch to `api.streamlineos.in` blocked outright — `CORS_ORIGINS` in the deployed environment does not list the app origin. Env value, not code |
| **017** Expenses UI inconsistent import contract | M | FE | `features/hr/expenses/components/import-expense-sheet.tsx` | — | **done-verified** | *(was 016)* `1e60375da`. `HrSheet` already had `submitDisabled`; the sheet never passed it, so Import was live and its handler returned early on `!file` — the click did nothing at all, with no message. The template, the parser and the documented columns were **three** lists: the template wrote Title Case while the docs said snake_case, and it shipped with **no rows** although the copy promised "sample rows to guide you". One declaration now, with a filled sample row |
| **022** Leave export silently does nothing | M | both | `hr-export-columns.ts`; FE leave export | 009 | **Partial** | *(was 017)* `95fb5271d` — an empty export is a header-only CSV on the shared route. **Not met**: the FE leave-export path still has the silent no-op; not yet traced |

### Phase 9 — Remaining Medium

| ID | Sev | Repo | Files | Dep | Status | Evidence |
|---|---|---|---|---|---|---|
| **016** Work logs disabled; rosters no assignment | M | both | `src/modules/hr/time/**` _(likely)_, FE `features/hr/rosters/**`, `features/hr/work-logs/**` | Phase 1 | **re-verify** | Reproduction not yet attempted |
| **018** Invite email not received at Maildrop | M | both | `employee-onboarding.service.ts`, `employees.controller.ts`; FE `components/hr/copy-invite-link-button.tsx` | — | **Partial** | *(was 001)* `d16384e78` (BE), `095b7fe8f` (FE). **Met**: token hash + outbox row in **one** transaction — they were two statements, so a failure between them left a live token for mail never queued; minting now **retires every earlier token**, so a link forwarded last week stops working when a resend corrects it; `POST /hr/employees/:employeeId/invite-link` (hashed, single-use, 7-day TTL, `hr:onboarding:manage`, 404 cross-tenant, 20/hour, critical audit row naming actor and address but never the token); the toast said "Invitation sent", which the server never claimed — `invite.sent` means the outbox accepted it — and now says **queued**. Evidence: `employee-invite-link.spec.ts` (7) + `copy-invite-link-button.test.tsx` (4). **Not met**: employee detail does not yet show `queued\|sent\|delivered\|bounced\|failed`. **BLOCKED (ops)**: real inbox receipt depends on SMTP credentials and SPF/DKIM in the deployed environment |
| **019** Bulk upload requires managers in an earlier file | M | both | `bulk-onboarding-graph.ts` (new), `bulk-onboarding-plan.ts`, `bulk-onboarding-writes.ts`; FE `bulk-onboard-download.ts` | 006 | **done-verified** | *(was 002)* `b154ef3ed`, `c09496440`, `0cb44322a`. A manager may now be another row of the file. **Cycles fail every row of the loop**, not just the one that closed it; a row whose manager row was rejected fails citing that row number, and the sweep repeats because a rejected row may itself be somebody's manager. Reporting lines written managers-first. Under-16 DOB was **already** rejected (`MIN_AGE_MS`). Template: the Employees sheet already carried both columns and **only the Instructions sheet** was missing them — measured, not guessed; both now documented, including that a manager may be a row of the same file, with the instruction rows in an exported function so a test holds them against the column list. Evidence: `bulk-onboarding-graph.spec.ts`, 10 assertions. **Duplicate detection preserved** (§14 12a): same email, case variant, existing member and underage all still error |
| **020** ORG_ADMIN gated by self-onboarding wizard | M | both | FE `lib/wizard-gate.ts`, `proxy.ts` | decision #7 | **todo** | FE-11: `resolveWizardGate` is the single authority for `/org-setup` and `/employee-onboarding` — two decision points over two sources gives `ERR_TOO_MANY_REDIRECTS`, so the Skip must live there and nowhere else |
| **021** Manager team view lists pending leave as approved | M | both | `/me/team` upcoming-leave mapper | — | **todo** | |
| **023** Sign-in codes delayed/batched | M | both | OTP issuance/invalidation | Phase 1 | **re-verify** | Reproduction not yet attempted |

### Phase 10 — Low + legacy

| ID | Sev | Repo | Files | Dep | Status | Evidence |
|---|---|---|---|---|---|---|
| **024** Leave policy server error | L | both | `leave-policies.controller.ts`, `dto/leaves.schemas.ts` | Phase 1 | **not-reproduced** | See the Phase-1 table. Effective-date validation retained; no speculative rewrite |
| **026** Fake mobile accepted at org setup | L | both | `common/validation/implausible-phone.ts`; FE `lib/implausible-phone.ts` | — | **done-verified** | *(was 019)* `47cbad19d` + `ca91dd2bd`. Refuses one digit repeated; the API field stays optional as it already was. **Narrowed deliberately**: a run like `9876543210` is just as obviously a placeholder and was rejected while I wrote it, but the numbering plan can allocate it and turning a real customer away at signup costs more — it is also the fixture the org-setup suite has always used, which is how the false positive announced itself. Duplicated rather than shared (no package between the repos); the two test files mirror each other |
| **028** Stale Time Off content flashes before denial | L | FE | route transition / `PageState` | — | **todo** | |
| **029** Leave type label; no submit toast | L | FE | leave type option label, submit handler | 014 | **todo** | |
| **030** PAN helper text broken encoding | L | FE | employee-onboarding Step 2 copy | — | **todo** | Mojibake `â€"` — a UTF-8 em-dash read as cp1252 |
| **031** `/hr/configuration` Page Not Found | L | both | route registry / nav | — | **todo** | |
| **032** Leave submit disabled in prior audit | L | both | leave request form | Phase 1 | **re-verify** | Reproduction not yet attempted |
| **033** Approve has no comment box or toast | L | FE (+BE) | approve action + toast | decision #8 | **todo** | |

### Legacy fold-ins

| ID | Pri | Repo | Acceptance | Dep | Status | Evidence |
|---|---|---|---|---|---|---|
| LEGACY-01 department create id | P1 | both | Response carries a string `id`; form sets `departmentId` immediately | — | todo | |
| LEGACY-02 manager without employment | P1 | BE | Satisfied if the owner stub lands | 006, 019 | **met by 006** | `b154ef3ed`. The `manager-has-no-employment` skip reason was the founder having no employment record |
| LEGACY-03 org-chart peer root | P1 | both | Unmanaged hire lands in *Unassigned / needs manager*, not as a peer CEO | 006 | todo | |
| LEGACY-04 designation vs positions | P1 | both | Free-text designation guides create-role/position or is marked provisional | — | todo | |
| LEGACY-05 role count mismatch | P1 | both | One source of truth, or explicitly labelled scopes | 010 | todo | overlaps 010 |
| LEGACY-06 India compliance seed | P1 | both | Idempotent seed; never imply coverage when empty | — | todo | |
| LEGACY-07 duplicate name heading | P2 | FE | Display name shown once | 006 | todo | |
| LEGACY-08 leave empty / 0 days UX | P2 | FE | Empty state + "Policies not configured" | 014 | todo | partly superseded by 014 |
| LEGACY-09 attendance offline copy | P2 | FE | Offline vs not-provisioned distinguished | 016 | todo | |
| LEGACY-10 empty-module checklist | P2 | FE | Shared *Start here*: People → Leave → Shifts → Documents | — | **Partial** | The checklist already existed (`frontend/features/hr/setup/hr-start-here.ts`). Its shift step linked to `/hr/attendance`, which cannot create a shift, so the step could never be completed from its own button — **and its spec asserted that destination**, which is how the defect survived. Fixed and all four hrefs pinned: `0d3f6efb9` |
| LEGACY-11…14 | P3 | FE | Optional | — | todo | Only if cheap after P0–P1 |

### Reported by the product owner during the run

Defects raised in flight, on screens the tickets already touch.

| What was reported | Repo | Cause | Status | Evidence |
|---|---|---|---|---|
| "Define a shift" on the HR overview opens Attendance | FE | The step's `id` and `href` both said `attendance` while its title, button and completion signal all concerned shifts. Its own spec asserted `/hr/attendance`. | done-verified | `0d3f6efb9` — 15 assertions, 1 failed before |
| Expiring and Calendar tabs under Documents show no proper SVG | FE | Both passed a bare lucide glyph as the `EmptyState` illustration with `w-8` — width only, leaving the icon's `height="24"` attribute in place: a 32×24 line drawing in the 96px illustration box. The Letters tab beside them already used `illustrationPreset`; the document table one tab over had the identical defect. | done-verified | `4a9f45707` |
| No profile photos beside names in the employee picker | FE | `EmployeeListItem` carries `image` and the contract parses it, so the photo was fetched on every open and dropped at the render. `Combobox` had no slot for anything but a label and a sublabel; it gains an optional per-option `icon` and `EmployeePicker` fills it with the attendance roster's own avatar markup. Fixes every HR surface that picks a person. | done-verified | `ede215e3f` — 6 assertions, 4 failed against the previous picker |

---

## Shared-infra changes (§16.2) — every non-HRMS-module change, with justification

| Change | File | Required by | Justification |
|---|---|---|---|
| `exposedHeaders` += `content-disposition`, `x-has-more`, `x-next-cursor` | `src/main.ts` | 009 | Without them a cross-origin download gets a blob with no filename and a paged export looks complete after page one. Additive; no origin list changed |
| `hr:employee-invite-link` rate-limit tier (20/hour) | `rate-limit.service.ts` | 018 | BE-35: an `@UseRateLimit` key with no `TIERS` entry denies and logs |
| Optional per-option `icon` on `Combobox` | `components/ui/combobox.tsx` | owner report | Additive optional prop; every existing call site unchanged |
| **Not applied**: §10.1's `{error:{code,message,details,requestId}}` envelope and Zod→422 | — | 006, 024 | The repo contract is `{code,message,details?,correlationId?}` with Zod→400 `VALIDATION_FAILED` (BE-17/BE-20), and `AllExceptionsFilter` is the catch-all behind **every** route in the product. Changing the shape would break every existing client at once — far outside "HRMS only". **Recorded as a deviation for Joseph**, not applied |
| **Not applied**: `correlationId` in `getErrorMessage` output | `lib/get-error-message.ts` | 006, 007 | One shared helper behind every error toast in the product. What it prints is a product-wide copy decision, not an HRMS fix |

---

## Open product decisions (do not guess)

| # | Decision | What is built around it | PROVISIONAL shipped | What stays BLOCKED |
|---|---|---|---|---|
| 1 | Is Expenses in trial and base plans? | Error **shape** is already `MODULE_NOT_ENABLED` with the module key and upgrade path | none | Entitlement seeds, plan keys, pricing |
| 2 | Document re-import identity key | Provisional key implemented + tested; in-file exact dupes rejected | `(org, user_id, lower(trim(category)), lower(trim(name)))`, commented as provisional | The unique **index**, until dupes are audited and cleanup approved |
| 3 | How the owner's own leave is approved | Resolver already routes to another approver and never to the requester; the founder's missing employment record (which blocked it) is fixed | none — auto-approval **not** shipped | A genuine one-person org: 409s with the explanation |
| 4 | Active on acceptance alone, or acceptance + joining date? | Pending computed from `users.email_verified` at read time — nothing stored | pending-until-acceptance | Backfill / rewriting existing statuses |
| 5 | Do reporting managers auto-receive `hr:leaves:approve`? | — | not yet | 010/011 depend on it; **no MEMBER will be silently elevated** |
| 6 | Is `/hr/approvals` the single HR queue? | — | not yet | 013 |
| 7 | May ORG_ADMIN skip the wizard? | — | not yet | 020 |
| 8 | Are approval comments required/optional/unsupported? | — | not yet | 033; Reject's required reason will not change |

---

## Tenant-isolation stop-rule log (003 / 004 / 005) — **CLEARED, no incident**

Run 2026-09-24 on `streamline_hrms_e2e`, a local non-production database built from the
migration chain. **No fix-forward happened before this check.**

**Structural finding (conclusive).** Every tenant column on every import target is
`NOT NULL` with an FK to `organizations.id`, verified against the live catalog, not the ORM:

| Column | `is_nullable` |
|---|---|
| `hr_import_jobs.org_id` | NO |
| `hr_import_rows.org_id` | NO |
| `hr_people.org_id` | NO |
| `hr_employments.org_id` | NO |
| `organization_people.organization_id` | NO |
| `attendance.org_id` | NO |
| `assets.org_id` | NO |
| `leave_balances.org_id` | NO |
| `documents.org_id` | NO |

A null tenant is therefore impossible by DDL. A *wrong* tenant is impossible by construction
too: the org reaches `commitJob` only from `CurrentUserContext.orgId`, which the guard sets
from the token, and no import entity schema has a tenant column, so no CSV can carry one.

**Empirical check.** These ran inside `BEGIN READ ONLY`:

| Check | Rows |
|---|---|
| `hr_import_rows` with null `org_id` | 0 |
| `hr_import_rows.org_id <> hr_import_jobs.org_id` | 0 |
| `hr_people` / `attendance` / `assets` / `leave_balances` / `documents` with null `org_id` | 0 |
| `leave_balances.org_id <> leave_types.org_id` | 0 |

**Stated honestly**: this database holds no import history, so the empirical result is
0-of-0. It corroborates the structural proof rather than replacing it. The rows QA's failing
imports wrote live in the production database, which this workflow does not query. No
tenant-isolation incident found; fix-forward proceeded.
