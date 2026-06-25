# Domain migration checklist (strangler-fig)

Kernel + auth bridge: done (Plan A) — config, DB module, exception filter, Zod pipe, JWT auth
(HS256-pinned), CASL ability + module guards, cache/pagination/audit, and the /me proving endpoint.

| Domain | Routes | Ported | Verified | Cutover (web routes deleted) |
|--------|-------:|:------:|:--------:|:----------------------------:|
| CRM Leads (pilot) | ~31 | core slice (8) | operator-run | no |
| remaining ~45 domains | - | no | no | no |

CRM Leads core slice ported (Plan B): `GET /leads`, `POST /leads`, `GET /leads/:leadId`,
`PATCH /leads/:leadId`, `DELETE /leads/:leadId`, `GET /leads/board`, `GET /leads/stats`,
`POST /leads/ingest`. Deferred: status-transition, assign, distribute, import, export, merge,
score-explanation, activities/timeline, analytics, Inngest crons, and the cutover.

## How to shadow-verify (CRM Leads pilot)

The pilot runs in shadow: the frontend keeps calling Next.js. Correctness is proven by diffing
the NestJS responses against the live Next.js endpoints over the SAME Neon DB.

1. API `.env`: set `BACKEND_JWT_SECRET` (identical in both repos), `DATABASE_URL` (the same Neon DB
   the web app uses), and `CORS_ORIGINS=http://localhost:1000`.
2. `pnpm sync:schema && pnpm start:dev` — API on :1500. Run the web app on :1000.
3. Sign in to the web app, then grab a token from `GET /api/auth/backend-token`.
4. Read-only parity (safe):
   `node scripts/parity-leads.mjs --token=<jwt> --leadId=<knownLeadId>`
   (or set `BACKEND_TOKEN` / `PARITY_LEAD_ID` in env). Defaults: `WEB_BASE=http://localhost:1000/api`,
   `API_BASE=http://localhost:1500`. Expect every read endpoint to print `PASS`.
5. Write smoke (optional): add `--write` (and `--apiKey=<rawApiKey>` to also smoke ingest). It creates
   a lead against the API, confirms it via the WEB read on the shared DB, then deletes it.

The script deep-diffs JSON and ignores volatile fields (timestamps, `thisMonth`). It exits non-zero
if any read diff is found.

Known shadow-only gaps (documented, acceptable for this non-cutover phase; none affect read parity):
- `POST /leads` omits the webhook dispatch, automation-engine dispatch, and the assignment email.
- `POST /leads/ingest` 429 returns the retry hint in the body, not a `Retry-After` header.
- `POST /leads/ingest` validation errors are 400 (Zod pipe / explicit check), not 422.

Mark the pilot "verified" once read parity passes and a `--write` smoke create round-trips.
