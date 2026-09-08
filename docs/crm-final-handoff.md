# CRM Final Handoff

**Date:** 2026-09-08
**Backend branch:** `crm/phase-2-3-consolidated` (PR #12) — `c4ba8f8d8`
**Frontend branch:** `crm/phase-4-5-frontend` (PR #31) — `fecfe90fe`

This handoff records what is implemented and **what was actually executed to
check it**. Where something was read rather than run, it says so.

The 2026-08-31 edition of this file was written from the worktree branch
`crm/p5-ui-and-g1`, whose commits are now folded into the two PR heads above by
fast-forward. That branch is an ancestor and should not be committed to again.

## Completed Remainder

| Unit | Status | Evidence |
|---|---|---|
| X1 Call intelligence | Complete, and now addressable | The list surface and `src/modules/calls/` were already present. `/crm/intelligence/[activityId]` was added this pass — a call's analysis previously had no URL and could only be read inline on the timeline. |
| X2 Commissions UI | Complete before this pass | CRM commission plan/accrual routes/hooks/components, backed by `src/modules/commission/`. |
| X3 Renewals / health UI | Complete | `/crm/renewals` and `/crm/health` with lifecycle hooks, navigation, and loading/error/empty/denied states. |
| X4 MCP token/settings UI | Complete, with a corrected security claim | `/crm/settings/mcp` and token management ship. See **X4 correction** below — the isolation property is real but holds for a different reason than the ticket states, and a genuine defect was found and fixed behind it. |
| X5 Golden path e2e | **Run, and green** | 6/6, under RLS, on a cold-built database. See **Verification**. |
| X6 Signup + first value | Complete | Public `/signup`, passwordless workspace creation, country-derived region placement, activation checklist mounted at `frontend/app/(authenticated)/crm/page.tsx:179`. `seedDemoDataset` runs inside `provisionWorkspace` (`src/modules/auth/auth.service.ts:200`). |
| X7 Leftover identity modules | **Reclassified — see below** | The schema-level collapse is done and `legacy-identity-collapse.spec.ts` proves it. The modules themselves must stay. |
| X8 Honest handoff | This document | |

## X5: the quote leg now has a caller

The previous edition recorded that `AutonomyHoldService.generateAndHoldQuote`
had no production caller anywhere in `src/` — written, reviewed, unreached. It
does now.

A stage advance that actually moved a deal drafts a quote through it and places
it in the existing hold window. The trigger is the advance, not a new model
output: the extraction schema answers two closed questions and neither is
"should we quote", and widening it would put the decision to send a customer a
figure into a free-text field.

Four gates, all of which must pass:

1. `autonomy_settings.auto_quote_enabled` — **off by default** (migration 0656)
2. no operator kill switch stops `quote.sent`, at platform or org level
3. confidence clears the 0.9 threshold `quote.sent` carries
4. no quote exists on the deal already

The opt-in is a new column rather than an `autonomy_switches` row because
`resolveSwitch` is deliberately default-ON — the switches exist to stop
autonomy, not to opt into it — so routing this through them would have started
drafting quotes for every existing tenant on deploy. `updateAutonomySettingsSchema`
is `.strict()`, so the field was added there too; without it the column would
have existed with no caller able to set it.

Covered by six unit tests in `autonomy.service.spec.ts`. **Not** covered by a
seeded e2e: the golden path runs with the opt-in off, which is the default, so
the quote leg's database behaviour is proven by unit test and by migration 0656
applying cleanly, not by an end-to-end run. That is the honest limit of the
current evidence.

## X4 correction: the isolation property, and a real defect behind it

The ticket asks for a token-level proof that a CRM-scoped agent token cannot
reach payroll or inventory. `src/modules/agent-access/agent-token-module-boundary.spec.ts`
now provides one over a real guard chain — the actual `AgentTokenGuard` and
`PermissionGuard` over the real `AccessService.scopeFor`. A token scoped
`["crm:deals:read"]` gets 200 on a CRM route and 403 on payroll and inventory,
and widening the token's scopes flips payroll to 200, which is what attributes
the refusal to the ceiling rather than to anything else.

What it does not show, stated because the ticket reads as though it does:

- The routes are a probe controller, not the shipped payroll/inventory
  controllers, and there is no database in that test.
- `AgentTokenGuard` is mounted in exactly one place — `AgentController`
  (`/agent/v1`), whose routes are all `build:*`. Payroll and inventory sit
  behind the global `JwtAuthGuard`, which resolves a different token table, so
  an agent token at a real payroll route gets **401 today, not 403**. The
  property is currently true by *unreachability*, not by scoping.
- `CrmMcpController` guards with `JwtAuthGuard`, so an agent token cannot reach
  the CRM MCP server at all — the ticket's framing does not describe the
  shipped wiring.
- `CrmMcpService` calls `resolveUserPermissions` directly rather than
  `scopeFor`, and the ceiling is applied only in `scopeFor`. A token principal
  arriving there would have its ceiling ignored. Worth knowing before anyone
  mounts that guard more widely.

**A real defect was found and fixed on the way.** `CrmMcpService.checkPermission`
asked `resolved.has(key)`. `resolveUserPermissions` returns
`Map<string, DataScope>`, and a key resolved to `"none"` is present in that map
and denied — returning `"none"` is how the resolver says no. So a permission the
resolver had explicitly denied passed here, and only here: every
`@RequirePermission` route goes through `AccessService.holds`, which is
`scopeFor(...) !== "none"`. Fixed, mutation-checked, and pinned by a test.

Worse than the bug: all six mocks in `crm-mcp.service.spec.ts` returned a
`{ permissions: [...] }` shape that nothing in production returns, so every
authorization assertion in that file — including both 403 cases — was
exercising a dead branch. The mocks now return real Maps and test the live path.

## X7 correction: the legacy modules must stay

The previous edition recorded X7 as "ratcheted". That is accurate, and the
ratchet is the right one: `legacy-identity-collapse.spec.ts` proves no
`pgTable` for `leads`, `clients`, `contacts` or `crmOrganizations` exists and
that those modules no longer import the dropped symbols. The tables really are
gone; the collapse is done.

What it does **not** prove, and what a reader could easily assume, is that the
modules are deletable. They are not:

- ~45 routes across `/leads`, `/clients`, `/contacts` have live frontend
  callers in `hooks/api/leads.ts`, `hooks/api/crm/clients.ts` and
  `hooks/api/crm/contacts.ts`. Unmounting 404s all three CRM screens.
- `SurveysModule` imports `LeadsModule` and injects `LeadsService` and
  `LeadsDetailService` — deleting `leads/` breaks application bootstrap, not
  just routes.
- 11 files under `ai/` and `crm/` import pure helpers out of those directories
  (`lead-party-reader`, `lead-status-semantics`, `duplicate-leads`,
  `client-party-reader`).

The genuinely dead surface is ~30 routes with no frontend caller. Removing them
is a separate, scoped piece of work; the controllers must stay mounted for the
live ones.

## Verification Run In This Pass

Everything below was executed, with exit codes checked rather than output
grepped.

**Cold database build, from empty** — this is what makes the rest trustworthy:

```bash
createdb crm_cold_0908
DATABASE_URL=postgres://…/crm_cold_0908 node src/scripts/db-bootstrap.mjs
# RESULT: REACHED_HEAD 417/417
DATABASE_URL=… APP_DB_PASSWORD=… node src/scripts/db-bootstrap-app-role.mjs
# RESULT: READY — streamline_app, bypassrls=false, 939/939 tables granted,
#         can create objects in: (none)
```

**Seeded e2e, whole suite, under real RLS:**

```bash
DATABASE_URL=<owner>  APP_DATABASE_URL=<streamline_app>  CRON_SECRET=…  \
  node --max-old-space-size=12288 node_modules/jest/bin/jest.js \
  --config ./jest-e2e-seeded.json --runInBand --forceExit
# Test Suites: 6 passed, 6 total
# Tests:       129 passed, 129 total
```

That includes `crm-golden-path` (6/6), `crm-inbound-ingress`,
`crm-import-roundtrip`, `crm-tenant-isolation`, `kb-page-visibility` and the
harness self-tests.

**`APP_DATABASE_URL` is load-bearing, not optional.** Run as the owner, the two
harness self-tests — "direct query without tenant GUC is denied by RLS" and
"app connection does not bypass RLS" — fail, and the golden path fails a hold
assertion. The whole suite is green only under the non-owner role. A green run
without `APP_DATABASE_URL` set is measuring nothing about RLS.

**Two earlier red runs were database drift, not defects.** Templating the test
database from `scratch_07b_probe` produced three golden-path failures
(`contact_party_map.contact_id` had no `nextval('contacts_id_seq')` default,
which migration 0277 installs). Templating from `crm_dbspec_0905` produced a
CHECK violation on `autonomous_decisions.kind` — that database's constraint
allowed 5 kinds where `DECISION_KINDS` has 8, because it never received
`0535_crm_outbound`. Both databases carry 634 applied rows against a 417-entry
journal and a watermark stamped 2027; neither is a valid basis for judging this
branch. **Build cold or do not conclude.**

**Unit and typecheck:**

```bash
pnpm typecheck                                          # exit 0
jest --testPathPattern="modules/autonomy"               # 26 suites, 446 tests
jest --testPathPattern="(crm/mcp|agent-access|modules/access)"  # 31 suites, 320 tests
node src/scripts/verify-migration-chain.mjs             # UNJOURNALLED 2 → 0
```

Frontend: `pnpm type-check` reports exactly one source error,
`components/expenses/expense-export/pdf-renderer.tsx(330)` — `html2canvas` is in
`package.json` but absent from `node_modules`. Pre-existing, unrelated to CRM,
and an install gap rather than a code defect. The other errors are stale
`.next` generated validators.

## Known Red, Not Caused Here

`verify-migration-chain.mjs` still exits 1 on 15 duplicate migration prefixes,
8 timestamp regressions (duplicate `when` values from merges) and 1 chain gap.
All predate this pass and are unchanged by it. The chain nonetheless reaches
head from empty, which is the property that matters for a rebuild.

Backend lint is red repo-wide; `crm-mcp.service.ts` carried 5 pre-existing
errors before and after this pass.

## Secrets And Infrastructure

| Required value | Why it matters | Current state |
|---|---|---|
| `STRIPE_SECRET_KEY` + webhook secret | Live Stripe checkout/webhooks | Fixture paths testable; live payments not production-ready. **Still blocked.** |
| `EU_DATABASE_URL` + 3 Neon DBs, 3 R2 buckets | Real second-region placement, and P3-08's "three regions reachable" / "outage isolation demonstrated", both still unticked | Country-to-region selection is wired; single-database mode remains valid. **Still blocked.** |
| `APP_DATABASE_URL` | Application role under RLS | **No longer blocked locally** — `db:bootstrap-role` produces `streamline_app` and the suite is green under it. A non-owner role is still required in CI. |
| `CRON_SECRET` | Drives the durable workflow via `POST /cron/workflow-tick` | Present locally. |

## Remaining Product Decisions

- **Should the CRM ever open a deal autonomously?** Still open, and
  deliberately not built. Autonomy implements exactly `applyNextStep` and
  `applyStageAdvance`; every insert into `deals` is a human path, an import or
  the demo seed. A wrong autonomous deal corrupts the forecast people plan
  headcount against, so this needs a tenant opt-in and an audit policy decided
  by a person, not inferred. The golden path creates its deal the way one is
  created today — by the rep.
- ~~Should quote drafting be wired to `generateAndHoldQuote`?~~ **Decided:**
  wired, behind a per-org opt-in defaulted off, triggered by a stage advance
  that actually moved the deal. Reversible by clearing the flag. If the
  commercial guardrails should be tighter than "the deal moved, we have a
  number, nobody has quoted yet", that is the paragraph to revisit.

## Not Built, and Not a Gap to Close by Testing

- **P5-mk segments.** The nurture-sequences half is complete end to end
  (`@Controller("crm/sequences")`, `CrmSequencesService`, and a UI at
  `/crm/settings/sequences`). The **segments** half does not exist at any
  layer — no table, no service, no route, no UI. It is a feature to be built,
  not a gap to be closed, and building the UI first would produce exactly the
  "shipped but unreachable" surface this programme has been correcting.
