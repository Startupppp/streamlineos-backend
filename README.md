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

- `GET /health` — process liveness; returns HTTP 200 while the API process is serving.
- `GET /health/ready` — database readiness; returns HTTP 200 when the database responds and
  HTTP 503 otherwise.

Configure the runtime's liveness probe to use `/health` and its readiness or deployment
probe to use `/health/ready`.

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

Two jobs are not optional, because the feature they serve does not work without them:

| Schedule (UTC) | Backend request | Why |
| --- | --- | --- |
| `* * * * *` | `POST /cron/outbox-events-worker` | Drains the transactional outbox. Nothing downstream of a domain event happens until it runs. |
| `* * * * *` | `POST /cron/inventory-webhook-delivery` | Delivers and retries outbound inventory webhooks. Every attempt after the first is scheduled here; unscheduled, a subscriber gets one attempt and never a retry. |

Both are safe to over-trigger: each claims its work under a lease, so an overlapping run finds
nothing to do rather than delivering twice. A minute is the natural cadence — the webhook
worker's first retry is a minute after the failure, and a slower tick only delays every
subsequent attempt, it does not lose one.

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
