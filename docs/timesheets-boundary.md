# Timesheets: what it owns, what it reads, what it must never touch

**Written 2026-09-09.** TS-02. This exists because the boundary is not
self-evident from the directory tree — `src/modules/timesheets/payroll/` and
`src/modules/payroll/` are one path segment apart, and only one of them belongs
to this module.

## The one-line version

Timesheets **feeds** payroll. It does not read from it, import from it, or know
its types. The dependency arrow points from payroll toward the contract that
timesheets publishes, or it points nowhere at all.

## Owned

| Path | What |
|---|---|
| `src/modules/timesheets/core/**` | Entries, timer, periods, approvals, exceptions, rates, FX, billing, budgets, reports, settings, audit |
| `src/modules/timesheets/payroll/**` | The **export** — computing hours buckets from approved entries and snapshotting them. Named `payroll` because of what it is *for*, not what it belongs to |
| `src/modules/timesheets/payroll/handoff/**` | The published contract: Zod schemas, `TimesheetPayrollHandoffPort`, the outbox consumer, and the adapter bound when nothing implements the port |
| `src/db/schema/timesheets/**` | `timesheets`, `timesheet_exports`, `timesheet_settings`, audit and exception tables |

## Read-only seams

Consumed through the shared schema or a published service, never by importing
the owning module's internals:

- `holidays` — used by the export's weekend and holiday bucketing
- `leave_requests` — used by `computeLeaveDays`
- `fin_exchange_rates` — FX evidence for billing
- `users`, `organization_members` — worker identity on export rows
- `user_delegations` — approver delegation

Reading these tables is not a boundary violation. Importing
`src/modules/hr/**` or `src/modules/payroll/**` is, and
`pnpm check:timesheets-payroll-boundary` fails the build on it.

## Forbidden

| Never | Why |
|---|---|
| Import anything from `src/modules/payroll/**` | Different owner. The handoff port exists so this import is never needed |
| Import anything from `src/modules/hr/**` | HRMS is read-only to this pack |
| Write to HR or payroll tables | Same |
| Add migrations touching HR or payroll schema | Same |
| Put pay calculation in timesheets beyond bucket mapping | Timesheets counts hours; payroll prices them |

## How the handoff actually works

```text
POST /timesheets/payroll/export
  └─ one transaction:
       insert timesheet_exports (snapshot = worker rows)
       update timesheets  -> payrollStatus EXPORTED
       OutboxWriter.emit  -> timesheets.payroll.export.ready
  └─ commit
       ...later, cron: POST /cron/outbox-events-worker
         └─ OutboxPublisherService claims the row
              └─ PayrollHandoffConsumer (registered for that event type)
                   └─ loads the export inside the org's tenant transaction
                        └─ TimesheetPayrollHandoffPort.deliver(payload)
```

Three properties of that chain are load-bearing and each fails silently if
broken, so each has a test that would notice:

1. **The emit is inside the export transaction.** An export cannot commit
   without its event, and an event cannot outlive a rolled-back export.
2. **The consumer registers itself.** `OutboxPublisherService.deliver` throws
   on an event type with no registered consumer, and that throw goes down the
   retry and dead-letter path. A consumer that exists but never registers is
   worse than none: it dead-letters every export.
3. **The consumer reads under tenant context.** The publisher wraps `handle` in
   `runInNewTenantTransaction`. Under the application role a read with no
   tenant context *raises* rather than returning empty, so a handoff moved
   outside that wrapper would fail on every export, in the background, where
   nobody is looking.

## The period lifecycle, and where it goes

Added by TS-05/TS-06, alongside the export chain above.

```text
POST /timesheets/periods/:id/submit | approve | reject | lock
  └─ one transaction:
       update timesheet_periods  -> status, and event_seq = event_seq + 1
       OutboxWriter.emit         -> timesheets.period.{submitted|approved|rejected|locked}
  └─ commit
       ...later, cron: POST /cron/outbox-events-worker
         └─ TimesheetLifecycleConsumer (registered for all four types)
              └─ WebhooksDispatchService.deliverNow -> the org's subscribed endpoints
```

`aggregate_version` is `timesheet_periods.event_seq`, a counter incremented by
the same UPDATE that performs the transition. `outbox_events` is UNIQUE on
`(organization_id, aggregate_type, aggregate_id, aggregate_version)`, and a
period emits repeatedly — it can be submitted, rejected, submitted again,
approved and locked, and reopened to do it all over. A constant version works
once per period and then fails forever; a wall-clock version collides on
approve-with-lock, which emits two events from one transaction sharing one
`now`.

Notifications (TS-24) do **not** ride this path. They are emitted through
`NotificationDispatchService` in the request, where `registerAfterCommit` drains
on the request's own commit; that is the existing pipeline and therefore the
existing email outbox, which is what the ticket asks for. The outbox events
carry the same facts to *external* subscribers — see
`docs/timesheets-webhooks.md` for the payloads.

## What an implementer does

Bind `TIMESHEET_PAYROLL_HANDOFF_PORT` to a class implementing
`TimesheetPayrollHandoffPort`. Nothing in `modules/timesheets` changes. The
implementation must be idempotent on `payload.idempotencyKey` — the publisher
retries on lease expiry — and should **throw** when it cannot deliver, so the
failure lands in the outbox instead of vanishing.

## What ships today, stated plainly

`RecordingPayrollHandoffAdapter` is bound, and it delivers to nothing. It
validates the payload against the published contract and logs, once per export,
that no implementation is bound. It is deliberately not called a no-op: a silent
one would report a successful handoff for an export that reached nobody.

## Deliberate deviations from the ticket text

- **No per-worker pay codes.** `payrollMappingSchema` is
  `{ provider, columns[] }` — an organisation-level mapping with no per-worker
  dimension anywhere in the schema. A `payCode` per row could only have been
  one value repeated, or invented. The mapping is carried once, at the top of
  the payload.
- **Worker rows are not in the outbox payload.** The outbox is durable and
  replayable; putting every worker's name and email in it duplicates that data
  for the life of the log and grows the payload with headcount. The snapshot is
  already on `timesheet_exports`, so the event carries identifiers and totals
  and the consumer loads the rows. The port still receives everything the
  ticket asks for.
- **`currency` is null.** This export computes hours, not money. Treating a
  null as "the org default" is exactly the silent mixed-currency the PRD
  forbids.
