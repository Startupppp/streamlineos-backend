# Timesheets: what changed, what it cost, and what is still open

**Branch** `feat/timesheets-world-class` (backend) and
`feat/timesheets-world-class-frontend` (frontend), both cut from the CRM lane so
that lane was never disturbed. **Written 2026-09-09.** TS-32.

## The short version

The module was largely built and almost entirely unproven. Fourteen spec files
existed and every one of them tested a pure function in `lib/` — no service, no
controller, no query had a test of any kind. Everything below was found by
writing those tests, not by reading the code.

Six defects, four of them shipping behaviour:

| What | Where | How it presented |
|---|---|---|
| No outbox events at all | whole module | No payroll handoff existed. `grep OutboxWriter src/modules/timesheets` returned nothing |
| Reminders never fired | `timesheet_settings.reminder_rules` | Column written by the settings API, read by nothing. Also an unvalidated `z.unknown()` JSON sink |
| Backdate limit varied by server timezone | `entries.service` | `backdateLimitDays: 3` allowed 4 days in UTC and India, 3 in UTC+14 |
| A second entry in a day returned 500 | `entries.service` | Uncaught 23505 from a partial unique index; an ordinary user action answered with "internal server error" |
| Money summed across currencies | `billing.service` | A project billed $1,000 and ₹40,000 reported `41000 USD` |
| Holidays ignored entirely | `reports.service`, week grid | A week containing a public holiday still expected 40 hours, so the compliance report marked the whole company short |

## The payroll handoff

`TimesheetPayrollHandoffPort` with Zod contracts, an outbox event emitted inside
the export transaction, a registered consumer, and an acknowledgement travelling
back the same way. Nothing in `modules/timesheets` imports `modules/payroll` or
`modules/hr`, and `pnpm check:timesheets-payroll-boundary` fails the build if
that ever reverses.

TS-05 and TS-06 shipped as one commit deliberately. `OutboxPublisherService`
throws on an event type with no registered consumer and sends that throw down
the retry and dead-letter path — so an emit without a consumer would not have
been "events without handling", it would have dead-lettered every payroll
export.

Three places the ticket text and the codebase disagreed, resolved toward the
codebase:

- **No per-worker pay codes exist.** `payrollMappingSchema` is
  `{ provider, columns[] }`, organisation-level, with no per-worker dimension.
  A `payCode` per row could only have been one value repeated, or invented.
- **Worker rows stay out of the outbox payload.** The outbox is durable and
  replayable; every worker's name and email would be duplicated into it for the
  life of the log, and the payload would grow with headcount. The snapshot is
  already on `timesheet_exports`, so the event carries identifiers and the
  consumer loads the rows. The port receives everything regardless.
- **`currency` is null and stays null.** This export computes hours, not money.

## Decisions that are not this pack's to make

Four findings are recorded as passing tests describing current behaviour, so
that changing them is a deliberate edit rather than a later discovery.

**Timesheets is gated on the `build` module.** All thirteen controllers carry
`@RequireModule("build")`, while the registry declares `timesheets` as its own
plan-gated module with its own route and cache namespace. Measured: an
organisation with only `timesheets` enabled gets 402 on the payroll export;
adding `build` makes it pass. So somebody who buys Timesheets cannot reach it,
and somebody with Build gets it free. Flipping the decorator would revoke access
from every Build-only organisation.

**`lockPeriod` has no state guard.** It checks the period exists and nothing
else, so a draft nobody submitted or approved can be locked, freezing a worker's
entries with no approval anywhere in the history. Every other transition guards
its source state. Relatedly, nothing in the module ever writes the status
`LOCKED` that the enum declares and `reopenPeriod` accepts — `lockPeriod` stamps
`lockedAt` and leaves the status alone, so reopen's LOCKED branch is unreachable
and `unlock` is the only way back out.

**`uniq_timesheets_work_log` subsumes the two indexes beside it.**
`(org_id, user_id, date) WHERE ticket_id IS NULL` allows one ticket-less entry
per person per day, so `uniq_timesheets_day_project` — which exists to allow one
entry per project per day — can never come into play. It also omits
`voided_at IS NULL`, so voiding an entry does not free the day. The index serves
the HR work-log upsert; whether the whole module should inherit
one-row-per-person-per-day is a question for those two owners.

**Bulk approve reports success when it approved nothing.** The single-period
route answers 403; `bulk-approve` treats `ForbiddenException` as an expected
skip and answers 200 with `{ approved: 0, skipped: n }`. Reasonable for a mixed
batch, surprising for a batch of one, and the skip count cannot distinguish
"already approved" from "not allowed".

## Still stored and read by nothing

`expectedDailyHours` is settable through the settings API and has no reader
anywhere in the repository — the same shape `reminderRules` had before TS-10.
Fixing it needs a decision about what a daily expectation should drive: a grid
target, an exception rule, or both.

## Infrastructure notes, measured not assumed

- **`test/` had never been typechecked on this branch.** `tsconfig.json`
  included only `src/**/*` and `evals/**/*`, `tsconfig.build.json` excludes
  tests, and ts-jest runs `isolatedModules`. Three configurations, none of them
  checking a test file. Turning it on cost six errors — two of them in a seeded
  spec written an hour earlier, including an insert naming a column that does
  not exist, which drizzle silently dropped.
- **Two permission gates had never run once.** `check:permission-keys` and
  `check:navigation-permissions` resolved the frontend as `<repo>/frontend`, a
  layout this repository has never had, and exited 2 from every checkout
  including main. Now pointed at a resolver that prefers the paired worktree and
  prints which checkout it used, because comparing against another branch's
  frontend is how a sibling check nearly deleted 22 live permission keys.
- **`pnpm openapi:check` exits 1 on this branch with 437 route differences, and
  none of them are ours.** `openapi.json` was last regenerated on 2026-08-29 and
  contains zero `accounting/ar` routes, so it predates the accounting merge on
  the base branch. Regenerating would fold 437 unrelated route changes into a
  timesheets commit.
- **The `.db.spec` harness does not exist on this branch.** `src/test/
  db-spec-gate.ts` and `db-spec-fixture.ts` are inventory-branch files; this
  branch's nine `.db.spec.ts` files gate on `CRM_DB_TESTS=1` and roll their own
  setup. New database-backed tests here use the seeded harness instead.

## Where the tests are

```
pnpm jest --testPathPattern="modules/timesheets"          20 suites, 183 tests
DATABASE_URL=… APP_DATABASE_URL=… \
  pnpm test:e2e:seeded --testPathPattern="test/timesheets" 8 suites, 62 tests
pnpm check:timesheets-payroll-boundary                     exit 0
pnpm check:permission-keys                                 exit 0
tsc --noEmit -p tsconfig.json                              exit 0
```

Both seeded URLs must point at the **same** database: `DATABASE_URL` seeds and
asserts as the owner, `APP_DATABASE_URL` serves the application as
`streamline_app` with `rolbypassrls = false`. `.env` points the first at Neon,
so overriding only the second seeds one database and serves another.

## Not done

TS-09 (auto-draft from clock segments), TS-11 (overdue queue), TS-16 (settings
history), TS-17 (entry/timer idempotency), TS-19–25, TS-28, TS-29, TS-34, TS-35.
None is blocked; they are simply after the P0s in the queue.
