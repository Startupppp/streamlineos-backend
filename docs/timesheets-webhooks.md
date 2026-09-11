# Timesheet webhooks: subscribing, verifying, and what arrives

**TS-25.** Written 2026-09-09, alongside TS-05 and TS-06.

Timesheets emits its lifecycle through the platform's transactional outbox, and
the outbox consumer fans each event out to the organisation's own webhook
endpoints. This document is the contract: which events exist, how to subscribe,
how to verify a delivery is genuine, and what the body looks like.

## The events

| Event | Emitted when | Aggregate |
|---|---|---|
| `timesheets.period.submitted` | A worker submits a period for approval | `timesheet_period` |
| `timesheets.period.approved` | An approver approves it | `timesheet_period` |
| `timesheets.period.rejected` | An approver rejects it, singly or in bulk | `timesheet_period` |
| `timesheets.period.locked` | The period is locked — explicitly, or by approval when `lockAfterApproval` is on | `timesheet_period` |
| `timesheets.payroll.export.ready` | A payroll export snapshot is created | `timesheet_export` |
| `timesheets.payroll.export.acked` | Somebody records that payroll took delivery | `timesheet_export` |

The four `period.*` events are delivered to subscribed webhook endpoints by
`TimesheetLifecycleConsumer`. The two `payroll.*` events go to the
`TimesheetPayrollHandoffPort` instead (see `docs/timesheets-boundary.md`); they
are listed here because they share the outbox and an implementer needs to know
they exist, not because they reach webhooks today.

**Approving with `lockAfterApproval` on emits two events, not one** — `approved`
then `locked`, in that order, from one transaction. That is deliberate: a
consumer that only cares about payroll readiness can subscribe to `locked` alone
without having to know the organisation's approval policy.

## Subscribing

Webhook endpoints are organisation-scoped and managed through the platform
webhooks API. Every route needs `settings:webhooks:manage`.

```http
POST /webhooks
Content-Type: application/json

{
  "url": "https://example.com/hooks/streamline",
  "description": "Payroll bridge",
  "events": ["timesheets.period.locked", "timesheets.period.approved"]
}
```

The response carries `secret` **once**. It is encrypted at rest and never
returned again; `POST /webhooks/:webhookId/rotate-secret` issues a new one, also
once.

An empty `events` array means *everything*, and `"*"` does the same. Prefer an
explicit list: a bridge subscribed to everything receives every CRM, inventory
and billing event the platform emits, and has to filter them itself.

`url` must be a public `http(s)` endpoint. Private, loopback, link-local and
cloud metadata addresses are rejected at write time and re-checked immediately
before every delivery, so an endpoint that later resolves to a private address
is blocked rather than fetched.

## Verifying a delivery

Every request carries:

| Header | Value |
|---|---|
| `X-StreamlineOS-Signature` | `sha256=<hex>` — HMAC-SHA256 of the **raw body** with your endpoint secret |
| `X-Webhook-Event` | the event name, so you can route before parsing |

Compute the HMAC over the exact bytes received, not over a re-serialised object:
key order is not guaranteed to survive a JSON round trip, and a re-serialised
body will not match.

```js
const expected =
  "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
const ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received));
```

## The envelope

Every delivery has the same three-key envelope; the event-specific part is
`data`.

```json
{
  "event": "timesheets.period.locked",
  "data": { "...": "see below" },
  "timestamp": "2026-09-09T11:04:22.918Z"
}
```

## Sample payload — `timesheets.period.locked`

```json
{
  "event": "timesheets.period.locked",
  "data": {
    "organization_id": "org_9f2c1a",
    "period_id": 48213,
    "user_id": "usr_7b31de",
    "period_start": "2026-09-01",
    "period_end": "2026-09-07",
    "status": "APPROVED",
    "total_hours": "38.50",
    "billable_hours": "31.00",
    "non_billable_hours": "7.50",
    "actor_user_id": "usr_2ac904",
    "reason": null,
    "occurred_at": "2026-09-09T11:04:22.883Z"
  },
  "timestamp": "2026-09-09T11:04:22.918Z"
}
```

All four `period.*` events share that `data` shape exactly. Three fields repay a
closer look:

- **`status` is the period's status, not the event name.** A `locked` event
  usually reports `"APPROVED"`, because `lockPeriod` writes `locked_at` and does
  not write the `LOCKED` status the enum declares. That is recorded as a known
  finding rather than papered over in the payload — route on `event`, not on
  `data.status`.
- **`user_id` is whose timesheet it is; `actor_user_id` is who did the thing.**
  They are the same on submission and different on every approval decision.
- **Hours are strings.** They are `decimal` columns; sending them as JSON
  numbers would round, and would disagree with what the API returns for the same
  period.

`reason` is populated on `timesheets.period.rejected` and null everywhere else.
It is present on all four so the shape does not vary by event.

## Delivery semantics

- **At-least-once.** The event commits in the same transaction as the state
  change, and a relay delivers it afterwards. A delivery that fails is retried
  with exponential backoff and dead-lettered after 8 attempts. **Deduplicate on
  `data.period_id` plus `event`** — or keep the delivery id if you need to be
  strict, since one period can legitimately be submitted, rejected and submitted
  again.
- **Ordering is not guaranteed across periods.** Within one period the outbox
  version is a monotonic counter (`timesheet_periods.event_seq`), so per-period
  order is stable, but two periods locked in the same second may arrive in
  either order.
- **A 2xx is a success; anything else is a retry.** Respond quickly and do the
  work asynchronously — the delivery times out after 10 seconds, and a slow
  endpoint becomes a retrying one.
- **Failures are visible to the organisation**, in `GET /webhooks/:webhookId/logs`,
  with the response status and a truncated body. `POST
  /webhooks/:webhookId/logs/:logId/retry` re-sends one.

## What is deliberately not in the payload

**The entries.** A period can hold hundreds, and the outbox is a durable,
replayable log — putting them in the event would duplicate every line of
everybody's timesheet into it and keep them for as long as the log is retained.
A consumer that needs the detail has `period_id` and the API.

**Anything priced.** Timesheets counts hours; it does not price them. Rates,
currency and amounts live behind the billing and payroll surfaces and their own
permission gates, and a webhook is not the place to hand them out.
