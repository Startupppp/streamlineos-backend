# streamlineos-api

NestJS resource server for StreamlineOS. Runs on port 1500. Verifies the NextAuth-minted
backend JWT (`BACKEND_JWT_SECRET`, shared with the web app), enforces CASL RBAC, and shares
the Neon DB and Upstash Redis with the web app during the strangler migration.

## Setup
1. `cp .env.example .env` and fill `DATABASE_URL`, `BACKEND_JWT_SECRET` (same value as the web app), `CORS_ORIGINS`.
2. `pnpm install`
3. `pnpm sync:schema`  (copies the Drizzle schema from ../Streamlineos)
4. `pnpm start:dev`

## Schema sync
The Drizzle schema is owned by the web repo during migration. Run `pnpm sync:schema` after any
web schema change; CI runs `pnpm check:schema` and fails on drift.

## Tests
- `pnpm test` (unit)
- `pnpm test:e2e` (e2e)

## Endpoints (foundation)
- `GET /health` — liveness
- `GET /health/ready` — readiness (DB `select 1`)
- `GET /me` — current user context (requires `Authorization: Bearer <backend-token>`)
- `GET /me/protected` — example RBAC-gated route (`crm:leads:delete`)
