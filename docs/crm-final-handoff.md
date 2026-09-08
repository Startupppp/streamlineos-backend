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

## The headline: nothing schedules the loops

Phase 4's first goal is that the loops run with no human step. They do not run at
all unless somebody posts to a route.

There is no scheduler in this repository — no `@nestjs/schedule`, no `@Cron`, no
`ScheduleModule` anywhere in `src/`. The codebase says so itself at
`src/modules/lifecycle/lifecycle-triggers.service.ts:61`: *"NOTHING SCHEDULES
THIS… a renewal opens a conversation when a person or a job posts to that route,
and not before."* That comment is honest and it is load-bearing.

The one CRM thing on a cron path is `CronCrmTasksService.flushOverdueTasks`
(task reminders), reached via `cron-build.controller.ts`. No cron controller
mentions lifecycle, outbound, repair, forecast or relationship sweeps.

So today: the durable workflow advances when `POST /cron/workflow-tick` is
driven, and every other autonomous loop — renewals, churn risk, silence
detection, field repair — waits for a human or an external job. The golden path
passes because the spec drives the tick itself. **This is the single largest gap
between what the CRM claims and what it does**, and it is infrastructure, not a
CRM feature: whatever runs on a timer should call these services rather than
grow its own copy.

## Phase 4 was never ticketed either

No tickets were derived from `2026-08-24-crm-phase-4-loops-prd.md`. A sweep found
a great deal genuinely built — relationship state derived from activities,
out-of-office distinguished from a reply, compose → hold → send-time snapshot,
consent and suppression evaluated at send time, per-party frequency caps, the
cold-outbound gate with ramp and self-pause, auto-repair with per-item revert,
one decision-record shape across loops, and kill switches per kind and tenant
with a UI. That is real.

Unreached, same shape as the rest:

| Surface | State |
|---|---|
| **The learned forecast** | `src/modules/deals/forecast/{logistic-regression,training-examples,deal-forecast-features,forecast-metrics,matrix-solve}.ts` are imported only by their own specs. `crmDealForecastModels` and `crmDealForecastScores` have zero references outside `db/schema`. Shipped forecasting is stage-probability × value. |
| **`LifecycleTriggersService.sweep`** | The only autonomous caller of `composeAndHold`. Nothing invokes it. |
| **`POST /crm/autonomy/outbound`** | No frontend caller. |
| **The whole repair operator surface** | Four endpoints — repair policies GET/PATCH, repairs/run, repairs, repair-measure — have no frontend caller at all, only an unused permission key. US18/20/21 have no operator: a steward can neither set classes nor see the ratio. |
| **`RelationshipStateService.read()` / `listAwaitingReply()`** | No callers outside the module. |
| **`meeting_request` outbound class** | `outbound.service.ts:845` hardcodes `meetingRequested: false`, so the eligibility branch can never fire. No calendar free/busy anywhere. |

Missing: deal-gone-quiet detection (US1), champion→procurement shift (US2),
thread-fork-as-opportunity (US3), automatic competitor capture (US4 — capture is
a manual POST), and the entire forecast intelligence set (US12–17: confidence
interval, ranked factors, learning from the tenant's closed deals, rep
calibration, what-would-change-its-mind, accuracy over time). A stopped message
does not stop its class for that party — `crmOutboundClassStops` is read and
never written. Nothing writes `crmSuppressionHashes`, so cold-track unsubscribes
are not ingested. Renewal is not an outbound class.

Partial: silence is judged on fixed 10/45-day constants, never against the
relationship's own stored `replyP50Seconds`; `partyTimezone` is hardcoded `null`
at `outbound.service.ts:548`, so working hours are always the tenant's; the cold
track can be paused but never enabled or warmed, because nothing writes
`crmColdOutboundSettings` or `crmSendingDomains`; and there is no eval dataset or
gate for outbound, forecast, relationship or repair.

The renderer migration (D28, US27–29) is out of scope for this programme and is
not counted as a gap — but for the record, `@/features/renderer` has no consumers
outside `crm/` and `party/`.

## Phase 5 was never ticketed, and a sweep of it found four more unreached surfaces

No tickets were ever derived from `2026-08-24-crm-phase-5-best-in-class-prd.md`,
so until 2026-09-08 nothing had checked it against the code. A sweep did. Four
findings are the same shape as `generateAndHoldQuote` — written, reviewed, and
reached by nothing:

| Surface | State |
|---|---|
| **Multi-touch attribution** | `src/modules/attribution/attribution-models.ts` implements linear, time-decay and position-based weighting as complete pure functions. There is no module, no service, no controller, and `AttributionModule` appears **zero** times in `app.module.ts`. Nothing outside that directory calls `weightsFor`, `orderTouches` or `touchesUpTo`. The shipped attribution is the first/last-touch report the PRD exists to replace. |
| **Nurture sequences** | `crm_nurture_sequences`, `_steps`, `_enrollments`, `_step_attempts` exist, carrying `autonomyHoldId`, `outboundMessageId` and `exitReason`. Outside `db/schema`, the only files that reference them are `sequence-reply-exit.service.ts` and its spec. No controller, no enrollment writer, no step sender. |
| **Reply-exit** | `SequenceReplyExitService.onInboundReply` is fully written and its module is registered, but `grep -rn "onInboundReply" src` outside its own directory returns nothing. The PRD calls continuing to send after someone replies the single most damaging behaviour in the product. |
| **The reporting query surface** | `@Controller("crm/reporting")` is registered and complete — parameterised compilation, tenancy and DataScope applied by the compiler, injection-tested. Zero frontend files reference `crm/reporting`. Its only caller is `crm_run_report` inside the MCP service, which sits behind `JwtAuthGuard` and so cannot be reached by the agent tokens it was built for. |

**A correction to the 2026-09-08 record.** An earlier edition of this section
said "the nurture-sequences half is complete end to end", citing
`@Controller("crm/sequences")`, `CrmSequencesService` and `/crm/settings/sequences`.
That was a name match, not a verification. Those are a **different** feature over
the `crm_sequences` task tables; that service contains zero references to the
nurture tables and zero to consent, frequency caps, working hours or holds. The
claim was wrong and is withdrawn.

Also missing outright, from the same sweep: segments at every layer (no table,
service, route or hook); per-rep call aggregates and trends; best-call exemplar
search; ARR movement (new / expansion / contraction / churn — the trigger kinds
are exactly `renewal-due` and `churn-risk`, with no expansion trigger); a report
builder UI, report scheduling and delivery; MCP being off by default per tenant;
and MCP tool execution reaching the audit trail (`grep -rni audit
src/modules/crm/mcp/` returns nothing).

Partial: commissions calculate correctly but only on an explicit POST — there is
no scheduler anywhere in `src/`, so "calculated continuously" and "clawback is
automatic" are both manual today. Campaign attribution sums `deals.value` with no
won-stage predicate, so it reports pipeline value, not closed revenue. MCP
exposes six tools, all reads.

## Not Built, and Not a Gap to Close by Testing

- **P5-mk segments.** Confirmed absent at every layer — no table in
  `src/db/schema/crm/`, no service, no controller, no route, no hook. A feature
  to be built, not a gap to be closed, and building the UI first would produce
  exactly the "shipped but unreachable" surface this programme has been
  correcting — of which phase 5 already has four.
