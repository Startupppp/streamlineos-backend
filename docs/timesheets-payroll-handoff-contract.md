# The timesheets → payroll handoff, for whoever owns payroll

**Written 2026-09-10** on `feat/timesheets-world-class`. Audience: the
developer who owns `src/modules/payroll/**`. Nothing in this document asks you
to change timesheets, and nothing in timesheets will be changed to suit a
payroll implementation — the whole point of the seam is that neither side has
to.

Companion to [`timesheets-boundary.md`](./timesheets-boundary.md), which says
what timesheets owns and why the two `payroll` directories are not the same
thing. This document is narrower: it is the contract, field by field, and what
you have to do to receive data.

---

## 1. The one thing to implement

```ts
import { TIMESHEET_PAYROLL_HANDOFF_PORT } from "…/timesheets/payroll/handoff/handoff.port";

{ provide: TIMESHEET_PAYROLL_HANDOFF_PORT, useClass: YourPayrollHandoffAdapter }
```

Bind that symbol to a class implementing `TimesheetPayrollHandoffPort`
(`src/modules/timesheets/payroll/handoff/handoff.port.ts`) and you are done.
No file under `src/modules/timesheets/` changes. The default binding lives in
`timesheets-payroll-handoff.module.ts:23`; replacing it is the entire extension
point.

**Which way the imports run.** Payroll may import from
`src/modules/timesheets/payroll/handoff/**` — the port, the schemas, the
types. Timesheets may not import from `src/modules/payroll/**` or
`src/modules/hr/**`, and `pnpm check:timesheets-payroll-boundary` fails the
build if it ever does (green today: 108 files scanned, 0 violations).

## 2. The interface, and why both methods are required

```ts
interface TimesheetPayrollHandoffPort {
  deliver(payload: PayrollHandoffPayload): Promise<void>;
  acknowledged(payload: PayrollAckPayload): Promise<void>;
}
```

`acknowledged` is not optional. An acknowledgement is how an export stops
being in flight, and a `REJECTED` or `FAILED` status is how an organisation
learns its payroll data did not land — an implementer who has not thought
about that should fail to compile rather than silently discard it.

Three rules govern both methods:

1. **Be idempotent on `payload.idempotencyKey`.** The publisher retries on a
   thrown error or an expired lease, so one export can legitimately be
   delivered more than once. The key is
   `outbox:<orgId>:<consumerName>:<eventId>`
   (`common/outbox/outbox-consumer.registry.ts:11`) — stable across every retry
   of one event, and different for every distinct event. For `deliver` that
   means one key per export; for `acknowledged` it means one key **per
   acknowledgement**, not per export, because an export can be acknowledged
   repeatedly as its status moves.
2. **Throw when you cannot deliver.** A throw goes back into the publisher's
   retry and dead-letter path, which is where a failure is visible. Returning
   quietly reports a successful handoff for data that reached nobody.
3. **You are already inside a tenant transaction.** `OutboxPublisherService`
   wraps `handle` in `runInNewTenantTransaction` for the event's organisation,
   so your database reads and writes are RLS-scoped without you doing anything
   — and would *raise* rather than return empty if they were not. The cost of
   that: a slow outbound HTTP call inside `deliver` holds a pooled Postgres
   connection for its duration. If your adapter talks to an external payroll
   provider, record the intent durably inside `deliver` and make the network
   call from your own worker.

## 3. What `deliver` receives

`PayrollHandoffPayload` (`handoff.schemas.ts:36`). Every field is present and
non-null except `currency`.

| Field | Type | Notes |
|---|---|---|
| `organizationId` | string | The exporting org. Also the tenant of the transaction you are in |
| `exportId` | int > 0 | `timesheet_exports.id`. Your natural business key alongside the idempotency key |
| `periodStart`, `periodEnd` | string (date) | The exported window, inclusive |
| `currency` | string(3) **or null** | **Always null today.** See §7 |
| `entryCount` | int ≥ 0 | Timesheet entries behind the export |
| `totalHours` | number | Sum across all rows |
| `mapping` | `{ provider, columns[] }` | The org's payroll column mapping. Typed and never null — see §5 |
| `rows` | `HandoffWorkerRow[]` | One per worker. Hours only, never money |
| `idempotencyKey` | string | §2 |
| `ackPath` | string | `timesheets/payroll/exports/<id>/ack`, relative to the API root. §6 |
| `exportedAt` | string (ISO) | `timesheet_exports.created_at` |

`HandoffWorkerRow` (`handoff.schemas.ts:21`): `userId`, `employeeName`,
`employeeEmail`, `regularHours`, `overtimeHours`, `holidayHours`,
`weekendHours`, `leaveDays`, `billableHours`, `nonBillableHours`,
`totalPayableHours`, `entryCount`.

**There is no amount field, and that is deliberate.** Timesheets counts hours;
payroll prices them. There is nothing here for a rate to be wrong about.

**Exported hours are marked, so a re-export cannot double-hand-off the same
work.** `runExport` sets `timesheets.payroll_status = 'EXPORTED'` and
`payroll_export_id` in the same transaction that writes the export
(`payroll-export.service.ts:197`), and the next export excludes them unless the
caller explicitly passes `includeExported` (`:97`).

## 4. How it reaches you

```text
POST /timesheets/payroll/export
  └─ one transaction:
       insert timesheet_exports (snapshot = worker rows)
       update timesheets -> payrollStatus EXPORTED
       OutboxWriter.emit -> "timesheets.payroll.export.ready"
  └─ commit
       ...later, cron: POST /cron/outbox-events-worker
         └─ OutboxPublisherService claims the row
              └─ PayrollHandoffConsumer, inside runInNewTenantTransaction(org)
                   └─ loads the export, resolves the mapping
                        └─ YOUR deliver(payload)
```

Event names are in one place so a producer and a consumer cannot disagree
(`handoff.schemas.ts`, `TIMESHEET_EVENTS`):

| Constant | Wire name |
|---|---|
| `payrollExportReady` | `timesheets.payroll.export.ready` |
| `payrollExportAcked` | `timesheets.payroll.export.acked` |

**The outbox event does not carry the worker rows, and you should not want it
to.** The outbox is a durable replayable log; putting every worker's name and
email in it duplicates that PII for the life of the log and grows the payload
with headcount. The snapshot is already on `timesheet_exports`, so the event
carries identifiers and totals (`payrollExportReadyEventSchema`) and the
consumer loads the rows to build the payload above. **Your port still receives
everything.** If you subscribe to the raw outbox stream instead of implementing
the port, this is the difference you will hit.

## 5. `mapping` is typed and always present

`payrollMappingSchema` is `{ provider: GENERIC | ZOHO_PAYROLL | RAZORPAYX | ADP
| GUSTO, columns: { key, header, enabled }[] }`, with `key` constrained to a
closed set of 15 bucket names (`dto/payroll.schemas.ts:51`).

The consumer runs whatever the export stored through `resolveMapping`
(`lib/payroll-calc.ts:7`), which answers `DEFAULT_PAYROLL_MAPPING` for an
export written before the column existed and for one whose stored value no
longer parses. So `mapping` is never null and never `undefined` — you can route
on it unconditionally.

**There are no per-worker pay codes.** The mapping has no per-worker dimension
anywhere in the schema, so a `payCode` on each row could only have been one
value repeated, or invented. It is carried once, at the top of the payload. If
payroll needs per-worker codes, that is a schema change to agree on, not
something to read into the current shape.

## 6. The acknowledgement, in both directions

**You (or an operator) call:**

```
PATCH /timesheets/payroll/exports/:exportId/ack
body: { status: "RECEIVED" | "ACCEPTED" | "REJECTED" | "FAILED", note?: string }
```

`payroll.controller.ts:81`. Requires `timesheets:payroll:export`, and the
controller carries `@RequireModule("build")` — an org without the `build`
module gets 402 on every timesheets route, this one included.

`ackExport` writes `ack_status`/`ack_note`/`ack_at`/`ack_by` and emits
`timesheets.payroll.export.acked` **in the same transaction**, so an
acknowledgement cannot be recorded without its event or announced without being
recorded (`payroll-export.service.ts:346-389`).

**Then timesheets calls you back:** `PayrollAckConsumer` turns that event into
`acknowledged(payload)`, with `{ organizationId, exportId, status, note, ackAt,
ackBy, idempotencyKey }`. It deliberately re-reads nothing — everything an
acknowledgement means is in the event, and the row may have been acknowledged
again since, so a re-read would hand you the *latest* status while claiming to
describe this one.

Acking repeatedly is expected and supported: `aggregate_version` is
`ackAt.getTime()`, because `(org, aggregate_type, aggregate_id,
aggregate_version)` is UNIQUE and version 1 is the export's own creation event,
so a constant would collide on the first ack.

⚠ **There is no machine credential for that endpoint on this branch.** The
route sits behind `JwtAuthGuard` + `PermissionGuard`; `ApiKeyGuard`
(`common/auth/api-key.guard.ts`) exists but is wired only to CRM lead ingest,
and this worktree has no `@AllowAgentToken` at all. An **in-process** adapter —
the supported shape today — does not need it, because it is called directly and
can record the acknowledgement itself. An **out-of-process** payroll system
calling `ackPath` over HTTP needs a decision from Tarun first: see §8.

## 7. What ships today, stated plainly

`RecordingPayrollHandoffAdapter` is bound, and it delivers to nothing. It
validates the payload against the published contract and logs, once per export,
that no implementation is bound; on an ack it logs at `warn` for `REJECTED`/
`FAILED` and at `log` otherwise. It is deliberately not called a no-op — a
silent one would report a successful handoff to an operator reading the outbox,
for an export that reached nobody. It returns rather than throws, because "no
payroll implementation" is the expected state of this branch, not an error to
dead-letter every export over.

`currency` is null because this export computes hours, not money. Reading a
null as "the org's default" would be exactly the silent mixed-currency the PRD
forbids. The field exists so a later costed handoff has somewhere to put one
rather than needing a second payload shape.

## 8. Decisions for Tarun, not for either module owner

1. **Machine credential for `ackPath`.** Only needed if payroll is
   out-of-process. The nearest existing shape is `ApiKeyGuard` with a new
   scope (`payroll:ack`, beside the existing `leads:write`), applied per-route;
   that is a timesheets-side change and is unwritten.
2. **Costed handoffs.** Whether the handoff ever carries money, and therefore
   whether `currency` ever becomes non-null.
3. **Per-worker pay codes.** Whether they are needed, and if so which table
   they live in — there is no per-worker mapping dimension today.

## 9. Verification status — read this before trusting the pack

**Unit specs pass and are real.** The two consumer specs are green:
`payroll-handoff.consumer.spec.ts` + `payroll-ack.consumer.spec.ts`, 16 tests,
measured 2026-09-10. The full timesheets unit suite is 28 suites / 227 tests,
exit 0. The boundary gate is green.

**The seeded e2e pack proved nothing today, and you should not read it as
green or as red.** `test/timesheets/timesheets-payroll-handoff.seeded-e2e-spec.ts`
has 8 tests and **all 8 fail in `beforeAll`** — not one assertion in the file
executed. Measured 2026-09-10: 8 suites failed / 61 tests failed across the
timesheets e2e pack. Every failure is environment drift, in three causes, none
of them a product defect and none of them clearing the code of one:

| Cause | What is actually missing |
|---|---|
| A | Live `timesheets` has no `user_id` (it has `user_membership_id`); this branch still declares `userId` at `src/db/schema/timesheets/entries.ts:33`. `main`'s `0824_timesheets_auth_owner_drop.sql` and the 0715/0810 pair are not on this branch |
| B | This branch's own `migrations/0659b_timesheets_lifecycle_seq_and_attendance_draft.sql` was never applied to the shared DB, so `timesheet_settings.auto_draft_from_attendance` and `timesheet_periods.event_seq` do not exist live — and because the Drizzle schema declares them, *every* select on those tables 500s |
| C | Live `build.projects` has no `client_id` (it has `client_membership_id`); `main`'s `0917_build_actor_drop.sql` is not on this branch |

The branch is 821 commits behind `main`; its journal ends at 421 entries while
the shared Neon database is at `main`'s head (857 applied). The declared schema
is therefore simultaneously *behind* the database (A, C) and *ahead* of it (B),
so neither a rebase alone nor a migration run alone fixes it.

Two further things that run mean less than they look:

- **RLS is inert in that harness.** `APP_DATABASE_URL` is unset, so the suite
  connects as `neondb_owner`, which has `BYPASSRLS`. The isolation spec's first
  four tests exercise application-level `orgId` scoping — real, but not RLS.
- **Its fifth test is a latent false negative.** It asserts each policy's
  `qual` contains `app.current_org_id()`, but both roles carry a role-level
  `search_path` including `app`, so `pg_get_expr` renders the policy
  unqualified as `(org_id = current_org_id())` for every one of the 10 tables.
  The policies are correct; the assertion cannot pass against this database.
  It is currently masked by the `beforeAll` failure above.

None of this is in payroll's way — an in-process adapter binding the port is
exercised by the unit specs. It matters if you plan to rely on the seeded pack
as your acceptance gate.
