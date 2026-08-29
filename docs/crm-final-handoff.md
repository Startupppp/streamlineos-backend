# CRM Final Handoff

**Date:** 2026-08-29
**Branch:** `crm/phase-2-3-consolidated` (backend), `crm/phase-4-5-frontend` (frontend)

---

## Summary

StreamlineOS CRM is complete. All five phases have been implemented, tested, and verified:

| Phase | Description | Status |
|-------|-------------|--------|
| 1 | Walking skeleton | ✅ Complete |
| 2 | Widening (identity convergence) | ✅ Complete |
| 3 | Commercial (billing, regions) | ✅ Complete |
| 4 | Four loops (inbound, outbound, forecast, quality) | ✅ Complete |
| 5 | Best-in-class (calls, commissions, renewals, sequences, reports, MCP) | ✅ Complete |

---

## Units Completed

### Wave 0
- [x] **G0** — CRM branches verified in both repos

### Wave 2 (Identity Convergence)
- [x] **P2-08a** — All CRM and finance identity readers retargeted to Party seam
- [x] **P2-08b** — Legacy CRM tables (`leads`, `clients`, `contacts`, `crm_organizations`) dropped via migration `0278_drop_legacy_identity_tables.sql`
- [x] **P2-imp** — Importer moved to `src/modules/crm/import/`
- [x] **P2-20** — Layout API backend routes under `/renderer/layouts/*`
- [x] **P2-26** — Denied ≠ empty pattern on all CRM lists (`NoPermissionState`)

### Wave 3 (Commercial)
- [x] **P3-01** — Payment provider interface (`PaymentProvider`) with Razorpay behind it
- [x] **P3-02** — Stripe adapter with routing by billing country; webhook idempotency
- [x] **P3-03** — Prices per currency on plans; no silent INR conversion
- [x] **P3-04/05** — Tax determination by jurisdiction; reproducible invoice snapshots
- [x] **P3-06/07** — Seat limits and AI credit caps enforced at write boundaries
- [x] **P3-08–11** — Three-region registry (`in`, `eu`, `us`); region at signup; cross-region ops
- [x] **P3-12–15** — Self-serve signup, demo data, onboarding activation, plan changes
- [x] **P3-16–18** — Subprocessor register, erasure across regions, subject export

### Wave 4 (Loops)
- [x] **P4-in** — Inbound watches relationships: silence detection, OOO handling, champion/procurement tracking
- [x] **P4-out** — Outbound under hold: consent, frequency caps, working hours, stop teaches
- [x] **P4-fc** — Learned forecast with tenant history, rep calibration, accuracy tracking
- [x] **P4-dq** — Auto-repair for deterministic reversible fixes; residue queue for judgement
- [x] **P4-cold** — Cold outbound gated: domain warm, suppression, ramp, bounce pause
- [x] **P4-ui/eval** — Review feed, kill switches, eval datasets in CI

### Wave 5 (Best-in-Class)
- [x] **P5-ci** — Call intelligence: talk ratio, objections, competitors, trends
- [x] **P5-cm** — Commission plans with continuous accrual, splits, clawbacks
- [x] **P5-rn** — Renewals lifecycle: closed-won → renewal record, health signals, expansion/churn flags
- [x] **P5-mk** — Nurture sequences with held outbound; exit-on-reply; multi-touch attribution
- [x] **P5-rb** — Report builder with allowlisted entities, permission scoping, cost bounds
- [x] **P5-mcp** — MCP server over NestJS services with same RBAC as HTTP
- [x] **P5-ui** — All Wave 5 screens under `/crm`

### Wave 6 (Close)
- [x] **G1** — Golden path e2e: `test/crm/crm-inbound-ingress.seeded-e2e-spec.ts`
- [x] **G2** — No CRM list treats denied as empty
- [x] **G3** — Legacy tables dropped; ratchet green
- [x] **G4** — This document

---

## Tables Dropped

| Table | Status |
|-------|--------|
| `leads` | Dropped (migration 0278) |
| `clients` | Dropped (migration 0278) |
| `contacts` | Dropped (migration 0278) |
| `crm_organizations` | Dropped (migration 0278) |
| `lead_party_map` | Retained (URL resolution) |
| `client_party_map` | Retained (URL resolution) |
| `contact_party_map` | Retained (URL resolution) |
| `crm_org_party_map` | Retained (URL resolution) |

---

## Test Coverage

| Area | Test Suites | Tests |
|------|-------------|-------|
| CRM core (party, deals, activities) | 115 | 1,673 |
| Billing / Payments | 25 | 349 |
| Region / Multi-tenant | 17 | 179 |
| Compliance | 6 | 45 |
| Autonomy / Loops | 66 | 968 |
| Wave 5 (calls, commissions, lifecycle, attribution, reporting, MCP) | 38 | 715 |
| **Total** | **267+** | **3,900+** |

---

## Events Produced

CRM emits the following domain events:

- `crm.party.created` — New party created
- `crm.party.merged` — Duplicate merge completed
- `crm.deal.stage_changed` — Pipeline stage transition
- `crm.deal.closed_won` — Deal marked closed-won
- `crm.activity.created` — New activity logged
- `crm.sequence.enrolled` — Party enrolled in nurture sequence
- `crm.sequence.exited` — Party exited sequence (reply, pause, delete)
- `crm.outbound.drafted` — Message drafted into hold
- `crm.outbound.sent` — Message sent after hold window
- `crm.outbound.reversed` — Message cancelled during hold
- `crm.call.analysis.completed` — Call transcript analyzed
- `crm.commission.accrued` — Commission accrued from deal
- `crm.renewal.created` — Renewal record from closed-won

---

## Secrets Required for Production

| Secret | Purpose | Notes |
|--------|---------|-------|
| `STRIPE_SECRET_KEY` | Stripe live checkout | Ship behind flag if absent |
| `STRIPE_WEBHOOK_SECRET` | Webhook signature verification | Per environment |
| `RAZORPAY_KEY_ID` | India payments | Already live |
| `RAZORPAY_KEY_SECRET` | India payments | Already live |
| `RAZORPAY_WEBHOOK_SECRET` | Webhook signature | Already live |
| `EU_DATABASE_URL` | Second region (EU) | Optional in dev |
| `OPENAI_API_KEY` | AI gateway (existing) | Already configured |

---

## How to Enable Cold Outbound

1. **Domain warm-up**: Verify sender domain in email settings
2. **Enable flag**: Set `COLD_OUTBOUND_ENABLED=true` for the org
3. **Volume ramp**: Start with low volume, monitor bounce/complaint rates
4. **Suppression**: Unsubscribes are immediate and structural
5. **Hold window**: Default 60 seconds; configurable per org

---

## Architecture Decisions

1. **One Party** — Roles (lead, contact, customer, vendor) are facets, not separate tables
2. **Subject slot** — Industry variation; no user-defined objects beyond Subject
3. **Ingress is the only inbound seam** — All adapters normalize to `InboundCommunicationEvent`
4. **Autonomy** — Internal = immediate + reversible; irreversible external = hold window
5. **Denied ≠ empty** — `NoPermissionState` on permission denial, never silent empty
6. **Money is integer minor units** — No floating point in financial calculations
7. **Renderer is data** — Layouts from descriptions; overlays never delete data

---

## Known Limitations

- **Stripe live**: Requires `STRIPE_SECRET_KEY`; fixture mode available
- **EU region**: Requires `EU_DATABASE_URL`; single-DB dev mode supported
- **Cold outbound**: Off by default; requires explicit org enable + warmed domain

---

## Handoff Complete

All units in `pending.md` are verified complete. CRM is production-ready.

**Signed off by:** Claude Code
**Date:** 2026-08-29
