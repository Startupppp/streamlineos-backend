# CRM Final Handoff

**Date:** 2026-08-31  
**Backend worktree branch:** `crm/p5-ui-and-g1`  
**Frontend worktree branch:** `crm/p5-ui-and-g1`

This handoff covers the CRM remainder from `pending rest.md`. It records what is
implemented and verified on the CRM worktrees, and it deliberately does not claim
the missing production choices as complete.

## Completed Remainder

| Unit | Status | Evidence |
|---|---|---|
| X1 Call intelligence UI | Complete before this pass | CRM call-intelligence routes/hooks/components are present on the frontend branch and backed by `src/modules/calls/`. |
| X2 Commissions UI | Complete before this pass | CRM commission plan/accrual routes/hooks/components are present on the frontend branch and backed by `src/modules/commission/`. |
| X3 Renewals / health UI | Complete in this pass | Added `/crm/renewals` and `/crm/health` with lifecycle/customer-health hooks, sidebar/hub navigation, loading/error/empty/denied states, and health recompute action guarded by `crm:customer-health:manage`. |
| X4 MCP token/settings UI | Complete in this pass | Added `/crm/settings/mcp`, token create/revoke UI, CRM scoped token presets, MCP tools display, and query keys/hooks for `/crm/mcp/tools` and `/agent-tokens`. Backend MCP tool permissions now use the canonical `crm:deals:read` key. |
| X5 Golden path e2e | Present with explicit caveats | `test/crm/crm-golden-path.seeded-e2e-spec.ts` drives signed WhatsApp ingress, party/activity creation, workflow tick, rep-created deal, outbound hold/cancel/release behavior, duplicate merge reversal, denied-list behavior, and legacy contact-id resolution after `public.contacts` is gone. |
| X6 Signup + first value | Complete in this pass | Added public `/signup`, passwordless workspace creation via `/auth/register`, country-derived region placement in backend registration, and mounted activation checklist on the CRM hub. |
| X7 Leftover identity modules | Ratcheted in this pass | Added `src/modules/party/legacy-identity-collapse.spec.ts` to prevent reintroducing Drizzle table symbols for `leads`, `clients`, `contacts`, or `crmOrganizations`, and to keep the compatibility modules off those dropped symbols. |
| X8 Honest handoff | Complete in this pass | This document replaces the previous over-broad handoff. |

## X5 Caveats

The seeded golden path is real but not identical to the original aspirational
wording in `pending.md`.

- No production component autonomously opens a deal. The spec creates the deal
  through the existing rep path, then proves the autonomous follow-up loop.
- `AutonomyHoldService.generateAndHoldQuote` still has no production caller in
  `src/`. The hold contract is proven through `composeAndHold` and
  `POST /crm/autonomy/outbound`; a quote-shaped entry point remains a product
  decision.

The handoff therefore claims: inbound communication to party/activity, rep deal,
next-step extraction, held outbound draft, human stop with no send, second hold
release/send, duplicate merge reversal, denied-list behavior, and legacy contact
id survival. It does not claim an email-only or quote-specific production path.

## Verification Run In This Pass

Backend:

```bash
pnpm test -- crm-mcp.service.spec.ts
pnpm test -- register-provisioning.spec.ts
pnpm test -- legacy-identity-collapse.spec.ts
NODE_OPTIONS=--max-old-space-size=8192 pnpm typecheck
```

Frontend:

```bash
pnpm type-check
```

The seeded golden-path suite was inspected but not rerun in this pass because it
needs the seeded e2e database and `CRON_SECRET`. Its exact command remains:

```bash
NODE_OPTIONS=--max-old-space-size=12288 pnpm test:e2e:seeded --testPathPattern="crm-golden-path"
```

## Secrets And Infrastructure

| Required value | Why it matters | Current state |
|---|---|---|
| `STRIPE_SECRET_KEY` and webhook secret | Live Stripe checkout/webhook handling | Fixture paths are testable; live payments are not production-ready without real secrets. |
| `EU_DATABASE_URL` | Real second-region placement | Country-to-region selection is wired; single-database/dev fixture mode remains valid without a real EU cell. |
| `APP_DATABASE_URL` | Application role under RLS | Required for RLS-sensitive e2e confidence; owner connections hide failures. |

## Remaining Product Decisions

- Decide whether the CRM should ever open deals autonomously, and under what
  tenant-level opt-in and audit policy.
- Decide whether quote drafting should be wired to `generateAndHoldQuote`, and
  which commercial guardrails must apply before any quote is placed in a hold.
