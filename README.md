# streamlineos-api

NestJS resource server for StreamlineOS. It owns business APIs, authorization, and the
database schema, and listens on port 1500 by default.

## Setup

1. Copy `.env.example` to `.env`.
2. Fill `DATABASE_URL`, `BACKEND_JWT_SECRET`, `CORS_ORIGINS`, and `APP_URL`.
3. Set the same `BACKEND_JWT_SECRET` and `INTERNAL_API_SECRET` in the frontend environment.
4. Run `pnpm install`.
5. Run `pnpm start:dev`.

`CRON_SECRET`, `INTERNAL_API_SECRET`, and `CONTACT_NOTIFICATION_EMAIL` may be omitted for
local development, but all three are required when `NODE_ENV=production`. Generate
independent secret values with `openssl rand -base64 48`; never commit or send those values
through chat. `CONTACT_NOTIFICATION_EMAIL` must be the canonical inbox that receives public
contact submissions.

## Tests

- `pnpm test` (unit)
- `pnpm test:e2e` (e2e)
- `pnpm lint`
- `pnpm typecheck`
- `pnpm build`

## Health endpoints

- `GET /health` — process liveness. Shallow by design: it touches no dependency, so a database
  blip gets the process drained rather than killed and restarted.
- `GET /health/ready` — dependency-aware readiness. Returns HTTP 200 with
  `status: "ready" | "degraded"` and a per-dependency report (`database`, `cache`, `queue`,
  `providers`), and HTTP 503 with `status: "unready"` when a required dependency is down or the
  process has begun draining. `degraded` keeps the replica in rotation: an unreachable cache
  still falls through to the database.

The readiness result is cached for `READINESS_CACHE_TTL_MS` (default 5000) and evaluations are
single-flight, so probe traffic cannot amplify the outage it is reporting; each check is bounded
by `READINESS_CHECK_TIMEOUT_MS` (default 2000).

Configure the runtime's liveness probe to use `/health` and its readiness or deployment
probe to use `/health/ready`.

Readiness and shutdown environment variables, all optional:

| Variable | Default | Effect |
|---|---|---|
| `READINESS_CACHE_TTL_MS` | `5000` | Window in which repeat probes are served from cache |
| `READINESS_CHECK_TIMEOUT_MS` | `2000` | Per-dependency budget; exceeding it reports `down` |
| `READINESS_QUEUE_STALL_SECONDS` | `900` | Drain-worker heartbeat age that counts as stalled |
| `READINESS_QUEUE_HEARTBEAT_JOBS` | `outbox-events-worker` | Comma-separated cron job keys to watch |
| `READINESS_REQUIRED_PROVIDERS` | *(none)* | Comma-separated providers whose open circuit makes the process unready |
| `SHUTDOWN_SETTLING_DELAY_MS` | `5000` | Time readiness reports 503 before new requests are refused |
| `SHUTDOWN_DRAIN_TIMEOUT_MS` | `25000` | How long shutdown waits for in-flight requests to finish |

On `SIGTERM` the process fails readiness first, keeps serving for the settling delay so the load
balancer can take it out of rotation, then refuses new requests with HTTP 503 and waits for
in-flight requests to finish before the connection pool is closed. Cron leases are refused for
the whole of that window, so a sweep is never started and abandoned — the next tick resumes it.

## Production scheduler contract

Cron jobs run on the backend, not the frontend. Configure an external scheduler to send:

```text
POST https://<backend-origin>/cron/<job>
Authorization: Bearer <CRON_SECRET>
```

Use HTTPS, set a request timeout longer than the selected job's expected runtime, and treat
non-2xx responses as failures. Schedules are interpreted by the scheduler; use UTC unless a
different timezone is explicitly configured there.

The schedules previously declared in the frontend map to these existing backend jobs:

| Schedule (UTC) | Backend request |
| --- | --- |
| `0 9 * * *` | `POST /cron/daily-notifications` |
| `0 12 * * *` | `POST /cron/holiday-notifications` |
| `0 19 * * *` | `POST /cron/auto-checkout` |
| `0 10 * * 1` | `POST /cron/weekly-ceo-recap` |
| `0 0 1 * *` | `POST /cron/monthly-leave-reset` |

The stale frontend entries for `/api/cron/weekly-attendance-report` and
`/api/cron/monthly-expense-report` had no matching backend jobs and were intentionally not
carried forward. The complete implemented job catalog is the route list in
`src/modules/cron/cron.controller.ts`; only enable jobs whose product workflow and cadence
have been approved.

### Retention sweeps are code-scheduled — no external configuration required

The table above never contained a retention sweep, and no scheduler in either repository
ever sent one of these requests. Every retention drain was therefore correct and dead.
`CronRetentionSchedulerService` (`src/modules/cron/cron-retention-scheduler.service.ts`)
now runs all of them in process, on the cadence declared in
`src/modules/cron/retention-schedule.ts`, taking the same `CronLeaseService` lease the HTTP
route takes.

| Sweep | Manual trigger | Cadence | Lease |
| --- | --- | --- | --- |
| HR policy retention (documents, employees, cases, attendance) | `POST /cron/hr-policy-retention-sweep` | daily | 1800s |
| Helpdesk ticket retention | `POST /cron/helpdesk-retention-sweep` | daily | 1800s |
| Mail metadata retention | `POST /cron/mail-metadata-retention-sweep` | daily | 1800s |
| Announcements retention | `POST /cron/announcements-retention-sweep` | daily | 1800s |
| AI usage log retention | `POST /cron/ai-usage-retention-sweep` | daily | 1800s |
| Notification body + record purge | `POST /cron/notifications-retention-sweep` | daily | 300s |
| Notification outbox retention | `POST /cron/notification-outbox-retention-sweep` | daily | 1800s |
| Outbox events retention | `POST /cron/outbox-events-retention-sweep` | daily | 1800s |
| KB chat history purge | `POST /cron/kb-chat-history-purge` | daily | 600s |
| KB chunk retention | `POST /cron/kb-chunk-retention-sweep` | daily | 600s |
| Build webhook delivery retention | `POST /cron/build-retention-prune` | daily | 120s |
| Notification partition detach/drop | `POST /cron/notifications-retention-detach` | daily | 300s |
| GDPR subject-export artifact retention | `POST /cron/gdpr-export-artifact-retention` | hourly | 900s |

The two mechanisms compose rather than compete. Due-ness is read from the same
`cron:heartbeat:<jobKey>` key the lease writes on every successful run, so an external
scheduler POSTing a route refreshes the heartbeat and the in-process scheduler stands down
for the rest of that interval.

- `RETENTION_SCHEDULER_ENABLED=false` turns the in-process scheduler off. Set it only in a
  deployment that genuinely drives these routes from outside; the default is on, because an
  opt-in scheduler nobody opts into is the defect this replaced.
- `RETENTION_SCHEDULER_TICK_MS` overrides the 10-minute due-check interval.

### Dead-man signal

Silence is the failure mode here, and silence is indistinguishable from success, so absence
of a run is itself an alert.

- `CronLeaseService` writes `cron:heartbeat:<jobKey>` (ISO timestamp, 7-day TTL) after every
  successful run and `cron:last-error:<jobKey>` on failure.
- A sweep that failed for *some* tenants still writes a heartbeat — it did run — so
  `CronSweepFailureSinkService` records that partial failure to `cron:last-error:<jobKey>`
  as well. `forEachOrg` used to return the failed count and nothing read it.
- `node src/scripts/alert-retention-dead-man.mjs` reads both keys for all twelve sweeps and
  exits 1 when any is stale or has a recent failure record, 2 when Redis is unreachable or
  every heartbeat is absent (an empty result set is not a healthy state). Registered in
  `alert-dispatch.mjs` as `retention-dead-man`, owner `platform-reliability`.
- `READINESS_QUEUE_HEARTBEAT_JOBS` makes `/health/ready` degrade on a stalled drain. It
  defaults to `outbox-events-worker` only; to cover retention, set it to the job keys above
  and raise `READINESS_QUEUE_STALL_SECONDS` past the daily cadence.

## Deployment

Build the container from the repository root with `docker build -f backend/Dockerfile backend`.
Provide production environment variables at runtime, expose port 1500 or the configured
`PORT`, and run database migrations as a separate release step before shifting traffic.
The container does not run migrations automatically.

Attach the first-party hostname `api.streamlineos.in` as a Railway custom domain (DNS in
Cloudflare). Browser clients and CSP must use that origin via the frontend
`NEXT_PUBLIC_API_URL` — see `docs/production-api-domain.md`. Keep `CORS_ORIGINS` set to the
web origins (`https://www.streamlineos.in`, …), not the API hostname.

## Authenticated endpoints

- `GET /me` — current user context (requires `Authorization: Bearer <backend-token>`)
- `GET /me/access` — server-resolved module and permission access
