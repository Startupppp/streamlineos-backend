# streamlineos-api

NestJS resource server for StreamlineOS. It owns business APIs, authorization, and the
database schema, and listens on port 1500 by default.

## Setup

1. Copy `.env.example` to `.env`.
2. Fill `DATABASE_URL`, `BACKEND_JWT_SECRET`, `CORS_ORIGINS`, and `APP_URL`.
3. Set the same `BACKEND_JWT_SECRET` and `INTERNAL_API_SECRET` in the frontend environment.
4. Run `pnpm install`.
5. Run `pnpm start:dev`.

`CRON_SECRET` and `INTERNAL_API_SECRET` may be omitted for local development, but both are
required when `NODE_ENV=production`. Generate independent values with
`openssl rand -base64 48`; never commit or send those values through chat.

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

## Deployment

Build the container from the repository root with `docker build -f backend/Dockerfile backend`.
Provide production environment variables at runtime, expose port 1500 or the configured
`PORT`, and run database migrations as a separate release step before shifting traffic.
The container does not run migrations automatically.

## Authenticated endpoints

- `GET /me` — current user context (requires `Authorization: Bearer <backend-token>`)
- `GET /me/access` — server-resolved module and permission access
