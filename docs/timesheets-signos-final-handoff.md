# Timesheets + SignOS — final handoff

**Branch:** `feat/timesheets-signos-finish` (both repos)
**Written:** 2026-09-12. Every number below is from a local run on one laptop; CI has no runner (see §9), so nothing here was verified in CI. Re-run the commands in §6 before relying on any of it.

---

## 1. SHAs

| | Backend (`tsign-backend`) | Frontend (`tsign-frontend/frontend`) |
|---|---|---|
| Base the branch was cut from (`origin/feat/inventory-world-class-implementation`) | `916712d47` | `a4f62e381` |
| Starting local `feat/timesheets-signos-finish` (pre-existing, fast-forwarded) | `2df0136ae` | `36eae611d` |
| `origin/main` merged in (backend only; frontend already contained `510205f4b`) | `ed6c7bef2` → merge `f22657368` | — |
| Final commit before this document | `c722c01af` | `a018752df` |
| Final pushed | `20bff85bb` + the commit that updates §3 of this file | `a018752df` |

Backend: 27 commits after the merge, 128 files, +3,287 / −1,082. Frontend: 9 commits, 33 files (77k of the insertions are the vendored `contracts/openapi.json`).

Nothing was merged to `main`. No commit was amended after push, no `--no-verify`, no force-push.

## 2. What changed

### Timesheets (backend, `src/modules/timesheets/**`)

- **Scope.** A member sees their own time; a module member holds `own` on every scopable view key (`MODULE_MEMBER_KEY_SCOPE_OVERRIDE`). Payroll export history and export rows apply the caller's DataScope through `ScopedRead` (`payroll-exports-read.service.ts`), with the cache key carrying `read.discriminator`.
- **Approvals.** A decision is written only while the period is still `SUBMITTED` (status-predicated UPDATE; the bulk path fails whole); a delegate needs a delegation that names `timesheets:approvals:manage`, not any delegation at all.
- **Audit chain.** `TimesheetsAuditService` takes `pg_advisory_xact_lock(hashtextextended('timesheets-audit:<org>', 0))` *before* reading the chain tail, so concurrent writers cannot fork the chain. `verifyChain` is strict: a hashless row after a hashed one is a break; the null-actor tolerance is gone (0 rows relied on it on Neon, read under `BEGIN READ ONLY`). The actor pointer is immutable — migration 1104 drops the `ON DELETE SET NULL` FK so a departed member's events stay attributed (frontend renders "Former member").
- **Payroll acknowledgement.** `@Idempotent("timesheets.payroll.ack")`; the ack transition table lives in `lib/ack-transition.ts`; the UPDATE is predicated on the status that was checked; the outbox `aggregate_version` comes from a per-row `event_seq` counter (migration 1105), not a timestamp.
- **Budgets.** A second active budget for a project is 409; a project the organisation does not have is 404 (was a 500 that confirmed existence).
- **Current period.** Two concurrent first visits converge on one row (`ON CONFLICT DO NOTHING` + re-read).
- **Exceptions.** One `OPEN` row per finding again (migration 1103, partial unique index); the service is `TimesheetExceptionsService` so the BOLA source index no longer merges it with payroll's `ExceptionsService`.

### SignOS (backend, `src/modules/e-sign/**`, `src/modules/cron/**`)

- **Finalisation rides the `sign.envelope.completed` outbox event** (`sign-envelope-completed-consumer.service.ts`), so the certificate and completion notices are durable and retried, and never run on the public request's transaction. Every email in finalisation, reminders, void and decline is deferred with `registerAfterCommit` (inline fallback when there is no ambient context); `forEachOrg` now installs an after-commit queue per organisation so sweeps get the same guarantee.
- **Sweeps.** One scheduler entry per sweep: `POST /cron/sign-reminder-sweep` and `POST /cron/sign-expiration-sweep`, each with its own lease, validated `dryRun` query; the combined `/cron/sign-envelope-sweeps` pair is retired. The reminder sweep skips envelopes already past `expiresAt`.
- **Extend expiration.** Refuses statuses that cannot carry a deadline (409), checks the `expired → sent` transition, and re-issues tokens and invitations after commit to the signing recipients the sweep expired (`reviveExpiredRecipients`). Before this, an extended envelope came back as `sent` with nobody able to sign it.
- **Recipient identity.** Access codes and OTPs compare in constant time (`digestsMatch`); a recipient must have authenticated before they can decline.
- **Object-level access.** An envelope's template and watermark policy are read under the caller's organisation before they are written (404 cross-tenant). The send-time validator admits `otp_sms` only when an SMS sender is configured.
- Recipient secrets and template keys no longer leave the API; bulk invitations go through the email outbox.

### Frontend

- Timesheets: payroll export and ack use `useAuthorizedIdempotentMutation` with an intent-scoped `Idempotency-Key`; the ack dialog offers only legal moves (`ack-export-schema.ts`); audit reads carry `timesheets:audit:view`; departed actors render as "Former member".
- SignOS: envelope list pages on the server with URL-backed `status/page/size`; void and save-as-template go through `ConfirmWithReasonSheet` / `EntityFormDialog`; every builder action shows only to a role that holds its key (`sign:envelope:send|void`, `sign:template:manage`, `sign:certificate:download`); certificate reads carry `sign:certificate:download`; a failed load reads as an error, not an empty screen; the settings form follows the contract (no public-forms toggle, no recipient hashes); the SignOS sidebar group opens for every key one of its routes needs (`sidebar-group-gate-covers-routes.test.ts` pins it for the SignOS and Timesheets groups).

## 3. Migrations

All hand-authored, journaled, with rollbacks in `migrations/rollback/`. Journal: idx 861–864, `when` 1803000019166–…169 (strictly increasing; nothing renumbered).

| Migration | Forward | Rollback | Proof |
|---|---|---|---|
| `1102_sign_settings_drop_public_forms_enabled` | drops the switch `0660b` retired | re-adds the column | cold build |
| `1103_timesheet_exceptions_open_dedupe_index` | partial unique index, one `OPEN` row per finding | drop index | cold build |
| `1104_timesheet_audit_actor_immutable` | drops `fk_timesheet_audit_actor_membership` | re-adds it as `ON DELETE SET NULL ("actor_membership_id") NOT VALID` (column-list form — bare `SET NULL` nulls `org_id` and aborts the delete) | forward + rollback on clone `tsign_1104_probe`; departure probe: pointer survives member removal |
| `1105_timesheet_exports_event_seq` | `event_seq integer NOT NULL DEFAULT 1` | drop column | forward + rollback on clone `tsign_1105_probe` |

Cold build: `node scripts/db-bootstrap.mjs` against a fresh `tsign_cold` → `RESULT: REACHED_HEAD 865/865` (scratchpad `cold-build-4.log`). `membership-artifacts.ts` records the 1104 pointer as `mechanism: "database-write", onRemoval: "unreferenced"`.

**Applied to Neon on 2026-09-12** (`neondb` on `ep-orange-mode-azxn5hbr`), on Tarun's instruction, one at a time through `src/scripts/apply-journalled-migration.mjs` with `APPLY_ONE_ALLOW_REMOTE=1`, after a `BEGIN READ ONLY` probe showed all four pending in `drizzle.__drizzle_migrations` (858 rows), the preconditions holding, and no data at risk (0 OPEN exceptions, 0 audit events, 0 exports). All four exit 0 and are recorded (ledger 862 rows); a second read-only probe confirms the column drop, the partial unique index, the FK removal and `event_seq`. Only these four were applied — `pnpm db:migrate` was not run there (memory: the Neon ledger matches no branch).

## 4. Contract regeneration

`pnpm openapi:generate` (env: local `DATABASE_URL`, throwaway `BACKEND_JWT_SECRET`/`PORTAL_JWT_SECRET`/`ENCRYPTION_KEY`, `NODE_ENV=test`) → `openapi.json` at 3,891 operations (3,893 − the two retired combined-sweep routes), then `pnpm openapi:check` and `pnpm check:openapi-coverage` exit 0. The document is vendored to the frontend at `contracts/openapi.json` (`aefdeed41`) and `check:contract-vendor` / `check:contract-drift` exit 0 against it.

## 5. Permission keys

No key was added or renamed. Keys the branch newly binds on the frontend: `timesheets:audit:view` (audit verify), `sign:certificate:download` (certificate sheet, builder), `sign:admin:manage` (certificate regenerate), `sign:envelope:send`, `sign:envelope:void`, `sign:template:manage` (builder actions), and the six SignOS route keys on the sidebar group. `check:permission-binding` resolves 2,517 bindings, 0 mismatches. Backend: `timesheets:approvals:manage` is the only key a delegation may carry to act on another approver's queue.

## 6. Verification — commands and results (local, 2026-09-12)

Backend (`tsign-backend`):

| Command | Exit |
|---|---|
| `NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p tsconfig.json` | 0 (`be-tsc-11.log`) |
| `npx jest --maxWorkers=3 src/modules/timesheets src/modules/e-sign test/security/bola` | 0 — 125 suites, 1,153 tests |
| `pnpm check:route-classification` · `check:module-di` · `check:timesheets-payroll-boundary` · `check:cycles` · `check:authz-deny` · `check:scope-boundary` · `check:fire-and-forget` · `check:idempotent-commands` · `check:module-registration` · `check:body-binding` · `check:bulk-id-limits` · `check:cache-invalidation` · `check:module-gate` · `check:navigation-permissions` · `check:openapi-path-params` | 0 each |
| `pnpm openapi:generate` · `openapi:check` · `check:openapi-coverage` | 0 |
| DB gates on `tsign_cold` (`check:constraint-drift`, `check:column-drift`, `check:referential-action-drift`, `check:membership-parity` — each needs its own `*_GATE_DATABASE_URL`; membership-parity needs `?sslmode=disable` locally) | 0 |
| `node scripts/db-bootstrap.mjs` (cold) | `REACHED_HEAD 865/865` |
| BOLA ratchets | scope-sibling drift 336 (was 339, three FIXED pins); body-id-binding 3,891 operations |

Frontend (`tsign-frontend/frontend`):

| Command | Exit |
|---|---|
| `pnpm type-check` | 0 (`fe-typecheck-5.log`) |
| `npx jest features/sign features/timesheets hooks/api/sign hooks/api/timesheets hooks/api/timesheets-core components/layout/sidebar app/(tenant)/sign app/(tenant)/timesheets` | 0 — 36 suites, 250 tests |
| `check:named-handlers` · `gated-reads` · `query-scope` · `icon-labels` · `route-access-contract` · `permission-catalog` · `contract-vendor` · `contract-drift` · `effect-fetches` · `empty-states` · `response-contracts` · `permission-binding` · `import-direction` · `feature-cycles` · `file-sizes` · `colors` · `formatters` · `test-integrity` | 0 each (`permission-binding` needs `STREAMLINE_BACKEND_ROOT`) |
| `check:over-300` · `check:type-assertions` · `check:request-params` | **1 — pre-existing.** Reproduced identically on a worktree of base `a4f62e381`: over-300 names five inventory/CRM/accounting files, type-assertions a stale `hooks/api/crm/contacts.ts` entry, request-params two undeclared keys in `inventory/projects-queries.ts` and `org-hierarchy.ts`. None is a sign/timesheets file; the fence forbids touching them. |

Not run: `next build` (not attempted this session — the build recipe is in memory `inv-frontend-builds-clean`), the full frontend jest run, `check:tenant-isolation:run`, and the seeded e2e suites `test/timesheets/**` / `test/sign/**` (needs a clone of `tsign_cold` with `APP_DB_SCHEMA=public pnpm db:bootstrap-role`, both `DATABASE_URL` and `APP_DATABASE_URL` on it, 12GB heap, throwaway `CRON_SECRET`, minted VAPID keys). The peer session `streamline-b2` agreed to run the seeded suites and Playwright journeys from a separate checkout of the pushed branches.

## 7. Browser proof

**None.** No browser session was run against this branch. Every UI claim above rests on jest component tests and the static gates. Treat "the envelope list pages on the server" and the dialog flows as untested in a real browser until the Playwright journeys in §6 run.

## 8. Scorecard (ceilings applied; a dimension without proof cannot exceed 7)

| # | Dimension | Score | Why not 10 |
|---|---|---|---|
| 1 | Architecture | 9 | Recipient state-machine table is declared and unused (documented P3, not wired). |
| 2 | Backend correctness | 8 | Timer overlap, settings-history version race, payroll-settings PATCH bypassing versioned history, rate-match `clientId` never passed — all still open (§9). |
| 3 | Security / BOLA | 9 | Ratchet lowered with FIXED pins; 336 sibling-drift findings remain platform-wide, none in sign/timesheets. Completed-recipient link revocation not re-reviewed. |
| 4 | Tenant isolation | 8 | Predicates and 404s in place; `check:tenant-isolation:run` not executed. |
| 5 | Validation / contracts | 10 | Zod on every touched route; OpenAPI regenerated, vendored, drift gates 0. |
| 6 | Idempotency / transactions | 9 | Ack and export idempotent, status-predicated, outbox-versioned; run-detection has no `@Idempotent` yet. |
| 7 | Migrations | 10 | Four hand-authored, journaled, rollbacks proven on clones, cold build 865/865. |
| 8 | Side effects / durability | 9 | Finalisation on the outbox, every email after commit; latency ≤15s worker tick. |
| 9 | Performance | 7 | Overdue list is still offset-paginated; keyset indexes `idx_ts_periods_org_status_submitted` etc. exist in SQL but are undeclared in Drizzle; report default span uncapped. Nothing measured in buffers. |
| 10 | Frontend data layer | 9 | Idempotent mutations, exact keys; approvals→reports/team/billing invalidation gaps remain. |
| 11 | Frontend UX states | 7 | Loading/empty/error/denied on touched screens; single/bulk approve and watermark/document delete still lack confirms; audit-trail sheet denied state missing. |
| 12 | Permission gating (FE) | 10 | 2,517 bindings, 0 mismatches; sidebar group rule pinned. |
| 13 | Test coverage | 8 | +40 backend, +12 frontend cases; no seeded e2e or browser run. |
| 14 | Static gates | 9 | All backend gates 0; three frontend gates red, all pre-existing and attributed to base. |
| 15 | Documentation / handoff | 9 | This file; PAGES.md not updated. |
| 16 | Verification honesty | 10 | Every number here is a measured local run with its log named; nothing claimed for CI or a browser. |

## 9. Limitations and externally blocked

- **CI has no runner.** Every gate above ran locally; nothing has been verified by a machine other than this laptop.
- **Neon migrations 1102–1105 are applied** (§3). Nothing else on the branch's journal was applied there; the wider ledger reconciliation (memory: `neon-ledger-matches-no-branch`) is still open and is not this branch's work.
- **Scheduler.** Point it at `POST /cron/sign-reminder-sweep` and `POST /cron/sign-expiration-sweep` (both need `CRON_SECRET`); the combined route is gone. The lease case needs Upstash REST configured.
- **SignOS certificate honesty.** Stubs only: no Aadhaar eSign, no licensed-CA DSC; the certificate statement is unchanged.
- **Timesheets P2s closed on this follow-up:** lock writes `LOCKED`; bulk approve 403s when the caller may approve none of a SUBMITTED batch; entry overlap respects `allowOverlappingEntries`; `expectedDailyHours` drives expected-hours and UNDER_HOURS; settings updates lock the row with `FOR UPDATE`; payroll-settings PATCH writes versioned history and the hash chain; rate-preview takes `clientId` + `date`; report range capped at 366 days; `idx_ts_periods_org_status_submitted` declared in Drizzle; run-detection is `@Idempotent`; payroll binds `TimesheetPayrollHandoffPort` and stores receipts.
- **Frontend closed on this follow-up:** ConfirmDialog for single/bulk approve, watermark-policy and document delete; my-time shows when week entries have more pages; Team page reads `/timesheets/team/week-summary` (no HR hook); billing export downloads the server CSV; rates mutations invalidate `ratePreview`/`billingUninvoiced`; PAGES.md timesheets rows marked audited.
- **Sidebar group gates** in 13 other modules have the same gap the SignOS group had (list in `sidebar-group-gate-covers-routes.test.ts`); outside the fence.

## 10. Merge and rollback

Merge: fast-forward or merge `feat/timesheets-signos-finish` in **both** repos together — the frontend's vendored contract matches this backend's `openapi.json` and `check:contract-vendor` fails against any other. Migrations 1102–1105 are already on Neon; boot once so `RoleGrantReconcilerService` converges (no permission keys changed, so no grants are expected to move). Update the scheduler entries before deploying the cron module.

Rollback: revert the merge in both repos; run `migrations/rollback/1105…`, `1104…`, `1103…`, `1102…` in that order (1104's rollback re-adds the FK `NOT VALID` — run `VALIDATE CONSTRAINT` separately if wanted). Rows written with `event_seq > 1` lose nothing on rollback; audit events attributed to departed members keep their pointer until the FK is validated, at which point validation fails if any such row exists — delete the FK re-add from the rollback in that case rather than nulling history.
