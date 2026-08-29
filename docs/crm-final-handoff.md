# CRM Final Handoff

**Date:** 2026-08-30
**Branch:** `crm/phase-2-3-consolidated` (backend), `crm/phase-4-5-frontend` (frontend)

---

## Summary

All five CRM phases are implemented, and — for the first time on this branch —
the application starts, the schema the code declares can be built from the
migration journal, and the seeded end-to-end suite runs green against a database
whose role cannot bypass row-level security.

The previous revision of this document said the same thing in fewer words and
was wrong about it. What follows separates what is now observed from what is
still known to be missing. Everything under **Verified** was run; everything
under **Not done** was not, and says why.

---

## What was found

The first version of this document was written by the same commit that stopped
the application booting. That is not an isolated slip — it is the shape of the
whole problem, so it is worth stating plainly.

Every one of the following passed 8,000 unit tests without complaint, because
unit tests mock the database and build their own module graphs:

| Defect | Consequence | Fixed in |
|---|---|---|
| `CrmMcpModule` injected `PartyService` from a `PartyModule` that never exported it | `AppModule` did not instantiate. Not the MCP route — **the entire application** — from the commit that declared the programme complete | `044ad316` |
| 27 migration files existed in `migrations/` and in no journal entry | **Every Wave 4 and Wave 5 table** — outbound, cold outbound, autonomy repairs, call analysis, commissions, accrual, lifecycle, health, renewal triggers, report builder — did not exist on any database built from the journal. It is also why nineteen CRM permission keys reached nobody: their backfills are in those files | `0b8b513b` |
| `WorkflowOutboxRelayService.relay` read `outbox_events` across tenants | Refused under RLS with 42501. The whole cron tick 500s, no run is ever started, and **every durable workflow in the product silently stops**. It worked only against an owner connection | `505bf44d` |
| `commitRow` stamped `committed_at` before doing the work | Violated `chk_crm_import_rows_outcome` on its own first statement, and a CHECK cannot be deferred. **The importer could not commit a single `create`, `update` or `review` row** — only `skip` and `merge`, which the constraint exempts | `e6ef29dc` |
| `activities.deal_id` was `text` against a `serial` key | `fk_activities_deal` could not be created, so migration 0472 failed on every database and the timeline's deal anchor had **no referential integrity at all**. Same again for `relationship_states.deal_id` | `f2c2332e` |
| Three migrations had never applied to an empty database | 0352 recreated a table the baseline already ships; 0486 used `ADD CONSTRAINT IF NOT EXISTS`, which is not PostgreSQL syntax at any version; 0266 inserted an untyped `'all'` into a `data_scope` enum, so **ticket 20's `settings:record-layouts:manage` was never granted to anybody** | `9e6d764c` |
| `crm_nurture_*` had no migration at all | P5-mk existed only as a Drizzle declaration | `0b8b513b` (0558) |
| `modules/commission/` and `modules/calls/` had no frontend | Registered in `app.module.ts` with permission-guarded controllers, and no route, no hook, no permission key. Unreachable by anything | frontend `026fa2343` |
| `eslint.config.mjs` registered one plugin name three times | ESLint 9 refuses the config outright, so `pnpm lint` reported success-shaped silence and **nothing on the frontend had been linted** | frontend `e1c6459e2` |

The common thread: each of these is invisible to a suite that mocks its
dependencies, and each is caught immediately by one that does not.

---

## Verified

Run against local PostgreSQL 18, on a database created empty and built only by
`db:bootstrap`, with `APP_DATABASE_URL` pointing at a non-owner
(`NOBYPASSRLS`) role.

| Gate | Result |
|---|---|
| `db:bootstrap` from `CREATE DATABASE` | **350/350, REACHED_HEAD** |
| `check-schema-drift` (declared vs built) | **0 tables, 0 columns** the database cannot satisfy |
| Legacy CRM identity tables present afterwards | **none** — G3 observed rather than inferred |
| Backend `tsc --noEmit` | clean |
| Backend unit suite | **8,380 passing**; 23 failing, all pre-existing and non-CRM (kb, hr, build, storage, automation, cache, notifications), verified identical at `51bf2046` in a baseline worktree |
| Seeded e2e (`jest-e2e-seeded`) | **126/126, 6/6 suites** — harness, tenant isolation, inbound ingress, import round trip, golden path, kb |
| Frontend `tsc --noEmit` | clean |
| Frontend `eslint` | **0 errors** (242 warnings) |
| Frontend suite | **1,254/1,254, 144/144 suites** |

`test/app-module-resolves.e2e-spec.ts` compiles the real module graph in about
twenty seconds with no database, and fails with the exact Nest error when the
`PartyService` export is removed — checked both ways.

`src/scripts/check-schema-drift.ts` diffs every declared Drizzle table against
`information_schema` and exits non-zero on anything the database cannot satisfy.
It is how the missing 27 were found and how they stay found.

---

## G1 — the golden path

`test/crm/crm-golden-path.seeded-e2e-spec.ts`, 3/3. Nothing is substituted: a
signed WhatsApp Cloud API webhook through the real reader and adapter, in over
HTTP through the real guards, the durable runtime advanced by
`POST /cron/workflow-tick` rather than by calling a handler, every assertion read
back out of Postgres.

A stranger writes in and becomes a party with a filed activity and an extracted
next step. The rep does that step, opens a deal, and the follow-up loop drafts a
message into a hold — which a human stops inside the window, and nothing leaves.
A second message is left to run its window out.

The last test asserts **both** arms, and that is what makes it deterministic.
`OUTBOUND_WORKING_HOURS` is a constant and explicitly "not a setting", so a
window elapsing outside 09:00–17:00 local is deferred to the next opening. Out of
hours the test asserts the hold is still held, nothing is sent, and the run sleeps
to a moment inside working hours — which is `pending.md`'s "3am local is not
sent", and nothing else in the suite covers it.

---

## Not done

### Two legs of the specified golden path do not exist

`pending.md` specifies `inbound → party → deal opened → extract → quote drafted
into hold`. Two of those have no production caller:

- **Nothing opens a deal autonomously.** `autonomy-actions.service.ts` implements
  `applyNextStep` and `applyStageAdvance`, and the decision ledger records exactly
  `task.extracted` and `stage.advanced`. Every `insert(deals)` in the codebase is
  a human path, an import, or the demo seed.
- **`AutonomyHoldService.generateAndHoldQuote` has no caller** anywhere in `src/`
  and no test. It is unreached code, so "quote drafted into hold" has no entry
  point. The hold machinery it would use is real and is exercised through
  `composeAndHold`.

Both are product decisions rather than gaps to test around: autonomously drafting
a commercial document to a stranger is a policy an organisation should opt into,
not a default somebody switches on to make a test green.

### AI spend is not being audited

`ai-gateway-credit.helper.ts` logs `ai.invoke` with `userId: actor.userId ?? "system"`.
`audit_logs.user_id` is `NOT NULL` with a foreign key to `users.id`, and
`"system"` is not a user, so **every autonomous AI invocation's audit row fails
its foreign key** and is swallowed by the `audit.log failed` catch. Visible in any
seeded run that reaches the gateway.

Left alone deliberately: the fix is either a nullable `user_id` or a real system
principal, both of which change a table every module writes to, and this is a CRM
branch. It wants its own change.

### `0488_hr_people_drop_identity_cols` is left unjournalled

It drops eleven `hr_people` columns that the HR schema still declares, so applying
it breaks that module — the migration and its schema never landed together. That
is HR's inconsistency to resolve, and journalling it from a CRM branch would be
exactly the "do not disturb other modules" line. HR is left as it was.

### Pre-existing failures not touched

23 backend unit tests across 12 suites, all non-CRM, all identical at `51bf2046`.
242 frontend eslint warnings, now visible for the first time.

---

## Secrets and infrastructure still required

| What | Why | Note |
|---|---|---|
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | live Stripe checkout | adapter is complete and fixture-tested; live path stays flagged off |
| `EU_DATABASE_URL` | second region | registry and resolver are done; single-database dev mode supported |
| `APP_DATABASE_URL` | the application's own role | **required**, not optional: with an owner connection the RLS defects above are invisible. `pnpm db:bootstrap-role` provisions it |
| pgvector | `CREATE EXTENSION vector` | needed before the first migration |

---

## Running the suite

```bash
createdb streamline_crm_e2e
psql -d streamline_crm_e2e -c 'CREATE EXTENSION vector; CREATE EXTENSION pg_trgm; CREATE EXTENSION "uuid-ossp"; CREATE EXTENSION pgcrypto; CREATE EXTENSION btree_gin;'
psql -d streamline_crm_e2e -c 'CREATE SCHEMA build; CREATE SCHEMA build_events;'
pnpm db:bootstrap                       # 350/350
APP_DB_SCHEMA=public pnpm db:bootstrap-role
# set APP_DATABASE_URL to the streamline_app role, then:
NODE_OPTIONS=--max-old-space-size=12288 pnpm test:e2e:seeded
```

`AppModule` needs 12 GB to boot; 8 GB dies.

---

**Signed off by:** Claude Code
**Date:** 2026-08-30
