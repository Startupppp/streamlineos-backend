# Accounting seam — definition of done

ACC-20. What each ticket of the accounting-seam pack delivered, what proves it,
and what is deliberately still open.

Run the gate with:

```bash
pnpm check:accounting-seam
```

It checks the four things no test can: the orchestrator's fence, the rejected
design not returning, each delivered ticket's artefact still carrying
assertions, and the contract still saying what the commits cite it as saying.
The P1s and the P2 sit in that floor on the same terms as the P0s — a priority
says what to do first, not what may quietly rot afterwards. Everything else is
proved by the specs named below, which run in the ordinary suite.

---

## P0 status

| Ticket | State | Evidence |
|---|---|---|
| ACC-01 Document the Inventory↔GL contract | Done | `docs/inventory-gl-contract.md` |
| ACC-02 Provisioning check when accounting is enabled | Done | `accounting/setup/accounting-provisioning.spec.ts` |
| ACC-03 Account mapping model | Done, **3 of 6 roles** | `accounting/kernel/system-tag-roles.spec.ts`, migration `0672` |
| ACC-04 FE account-mapping screen | Done | `features/accounting/settings/__tests__/account-mappings-card.test.tsx` (frontend) |
| ACC-02/17 FE provisioning notice | Done, **found unrendered** | `features/accounting/setup/__tests__/provisioning-notice.test.tsx` (frontend) |
| ACC-05 Enforce the period before valuation posts | Done | `accounting/adapters/inventory-post-atomicity.spec.ts` |
| ACC-06 Missing map fails deterministically | Done | `accounting/adapters/posting-rejections-over-http.spec.ts` |
| ACC-07 Post only via `PostingCommandService` | Done | `accounting/adapters/inventory-posting-keys.spec.ts` |
| ACC-08 Report movements with no journal | Done | `accounting/adapters/reconciliation/unposted-movements.spec.ts` |
| ACC-10 Party-only identity in accounting | Done | `accounting/parties/accounting-party-only.spec.ts` |
| ACC-12 Never imply an IRP filing | Done | `accounting/compliance/compliance-honesty.spec.ts` |
| ACC-16 Accounting-disabled tenant unchanged | Done | `accounting/adapters/accounting-disabled-tenant.spec.ts` |
| ACC-19 Ratchet on direct ledger writes | Done | `accounting/adapters/ledger-boundary.spec.ts` |
| ACC-20 This checklist and its gate | Done | `src/scripts/check-accounting-seam.mjs` |

## P1 status

| Ticket | State | Evidence |
|---|---|---|
| ACC-09 Stock ledger vs GL reconciliation | Done, **narrowed** | `adapters/reconciliation/stock-gl-reconciliation.spec.ts` |
| ACC-11 AR/AP party resolution | Done, **structural not e2e** | `accounting/parties/accounting-party-only.spec.ts` |
| ACC-13 Transport interface + mock IRP | Done | `compliance/transport/compliance-transport.spec.ts`, migration `0673` |
| ACC-15 Adapter idempotency and rejection paths | Done | `adapters/posting-refusals.spec.ts` |
| ACC-18 ADR on legacy invoices vs AR | Done, **and a bug fixed** | `docs/adr-legacy-invoices-vs-ar.md` |
| ACC-14 Live IRP provider | **Blocked** | No credentials. ACC-13's mock is the substitute. |
| ACC-17 India FY edge cases for inventory-linked invoices (P2) | Done, **and two findings** | `adapters/document-series-fy.spec.ts`, `setup/accounting-provisioning.spec.ts` |
| ACC-21 Close the unposted stock movements | Done, **7 of 10, 3 by decision** | `adapters/stock-movement-bridge.spec.ts`, `adapters/stock-bridge-reachability.spec.ts` |

---

## Decisions, so they are not rediscovered as questions

**Fail closed, never `pending_accounting`.** Argued in the contract's §4. A
queue would need a retry, a dead-letter and an operator surface to make one
existing failure quieter, and everything it would defer — a missing account
role, a locked period — is operator configuration that does not resolve with
time. The gate fails if that state reappears.

**Three new account roles, not six.** `inventory` and `cogs` already existed.
`grni`, `inventory_write_off` and `inventory_adjustment` are new in `0672`.
`landed_cost_clearing` is deliberately **not** added: there is no landed-cost
feature anywhere on this branch — no module, no schema, no service — so the tag
would appear on the mapping screen as a role an operator is asked to fill for a
capability the product does not have. It lands with the module that needs it.

**One `inventory_adjustment` account, not a gain/loss pair.** A gain credits it
and a loss debits it, so its balance is the period's net adjustment cost.
Splitting it makes that net invisible on both the P&L and the trial balance.

**Role validation runs when a tag is assigned, never when a journal is posted.**
A tenant whose chart predates the rule keeps posting unchanged; validating at
post time would turn a historical mapping choice into an outage.

**The fiscal year is warned about, not extended automatically.** ACC-17 found
that AP self-heals via `ensureFiscalYear` while AR and the inventory bridge
reject, so an Indian tenant provisioned only for FY2026-27 stops being able to
receive goods at midnight on 31 March — with a rejection that reads like a
misconfiguration rather than a calendar. Provisioning now reports
`fiscal_year_ending` 30 days out. Creating the next year automatically was the
tempting fix and is the wrong one: the pattern, and whether a transition period
is wanted, are the tenant's decisions, and a year silently created with guessed
dates is harder to notice than a missing one.

**The mock IRP gets its own transport enum member, not a flag.** An environment
variable does not survive a database restore, a CSV export or a screenshot, and
`document_compliance` rows are kept as evidence that an obligation was met.
Evidence has to carry its own provenance, so a mock's rows read `mock_irp`
forever. The registry refuses to boot a production node configured for it.

**ACC-09 compares the bridge, not a re-derived valuation.** Valuing stock inside
accounting would mean copying inventory's FIFO, standard and average costing
branches, and a duplicated costing rule drifts until the report finds
differences it invented itself. What it compares instead — the inventory
account's movement from `stock_move` journals against the value of the
movements that produced them — must agree exactly, so any difference is a
bridge defect.

**Every writer into the legacy `invoices` table posts as
`sales_invoice:{invoices.id}:post`.** Two purposes for one id space made a
double-post reachable through a status round-trip; see the ADR.

---

## Open, and why

**§3.3a — the period guard and the ledger check different dates.**
`assertPeriodOpen` guards the movement's posting date, which defaults to *today*
because no call site passes one, while the journal carries the document's date.
They disagree in both directions. The fix is for the receipt and the shipment to
pass their document date as the movement's `postingDate` — but
`loadCostingContext` keys cost layers on that same date, so it changes inventory
valuation for backdated documents. That is an inventory decision, not a
GL-contract one.

**§3.4 — closed by ACC-21, and the count was wrong.** Seven of the ten now post
through one bridge; three are correct to post nothing and saying so is more
accurate than making them post — a quarantine journal would move a balance
sheet for goods sitting in the next aisle. What remains is narrower and named:
a transfer's accounting during transit is correct today only because the ledger
has no location dimension, and a product that grows a `stock_in_transit` role
would want the outbound leg posted against it.

**The shipment reconciliation is sales-order-level.** A stock transaction
records the sales order as its reference and never the shipment, so on a
partially shipped order one posted shipment makes the whole order look posted.
The report says so in its own payload.

**ACC-14 live IRP transport is blocked.** Confirmed rather than assumed: there
are no IRP or GSP credentials in the env schema, none in `.env` or
`.env.example`, and no provider client anywhere in `src` — the only matches for
`irp` outside the mock are comments saying it does not exist yet.

ACC-13's mock is the substitute, and the seam is built so ACC-14 is small. What
it has to do, and what it must not:

- Implement `ComplianceTransportAdapter`. The port already carries the four
  outcomes, and `unavailable` versus `rejected` is the distinction that matters
  most: a portal timeout must not tell somebody to correct an invoice that may
  be perfectly valid.
- Add an `irp` member to `COMPLIANCE_TRANSPORT` in `env.validation.ts`. It is
  deliberately absent today, so nobody can set it and believe a document is
  being filed.
- Flip `isReal` to `true` — which fails
  `compliance-transport.spec.ts`'s "no adapter claiming to be real". That
  failure is the point: it is the prompt to re-read the honesty rules at the
  moment they stop being theoretical.
- Write rows under `transport: "irp"`, not `mock_irp`. The narrative's
  `SYNTHETIC_TRANSPORTS` set is what separates the two, and nothing else needs
  to change for `filed` to start meaning filed.
- Keep credentials out of the repository and out of logs, and keep the call out
  of the posting transaction — `POST .../submit` is a separate request for that
  reason.

Three IRP behaviours the mock does not model, and a real adapter must: a
duplicate-IRN response for a document already filed (the IRP returns the
original IRN, which should be recorded as `accepted`, not as an error); the
24-hour cancellation window, after which a filed document can only be credited,
not cancelled; and auth-token expiry, which needs a refresh rather than being
surfaced as a rejection.

**Legacy invoice numbers are derived from a row count.** ACC-17's second
finding, in `modules/invoices` rather than in the seam: `INV-{calendarYear}-{count+1}`
over every invoice row the organisation has, so the series skips whenever a
sales order is invoiced (that path numbers from a different sequencer into the
same table), the year in the label never resets, a deleted row lets a number be
reissued, and only one of the two writers takes the numbering lock. There is no
unique index on `invoice_number` — measured on the development database, 350
rows, 25 distinct numbers, zero unique indexes covering the column. Those
duplicates are a load fixture rather than real invoicing; the fixture only got
there because nothing forbids it. The fix is a real sequence row, which is
`modules/invoices`' change, and the index needs a repair pass plus an answer to
what re-numbering does to a GST return already filed. The ADR carries the
detail and `document-series-fy.spec.ts` fails the day it is fixed.

**Invoices already posted under `sales_invoice:{id}:issue`** on a live database
keep a key no future `:post` will match, so the ADR's round-trip can double-post
those rows once. Repairing them is a data migration with real blast radius and
needs its own ticket.

**Payroll still swallows its paid-posting failures.** `payroll-posting.service.ts`
catches every rejection on the paid disbursement and logs it, so a locked period
leaves the run looking posted. Payroll business logic is outside this pack's
fence; ACC-15 makes the refusal survive independently by auditing it in the
adapter, and a test in `posting-refusals.spec.ts` fails the day payroll stops
swallowing so the gap is not forgotten.

---

**A quarantine round-trip loses its cost layers.** Found while classifying the
ten, and reported rather than fixed because it is inventory's costing, not the
seam. Putting stock on hold issues it out of `ON_HAND`, which consumes cost
layers and records the value; releasing it adds the quantity back with no
`unitCost`, and `applyCosting` returns early without recording a layer. So the
quantity returns and the value does not. The ledger is right to post nothing
either way — the goods were owned throughout — which means that here, unusually,
the GL is correct and the stock valuation report is the one that drifts.

## The reachability sweep, and what it found

Run at the end because this pack found "built, and nothing routes to it" four
times in other people's code and I shipped it once myself. Every controller
added here is registered and reaches `app.module.ts` through
`AccountingRootModule`; the account-mapping card is rendered by
`/accounting/settings`.

One thing was not. **The provisioning verdict was computed, returned in every
`/accounting/setup/status` response, typed on the frontend, and rendered by
nobody** — so an organisation with the module on and no book, whose every stock
movement and invoice was being accepted and recorded nowhere, saw exactly the
screen an organisation that never opted in sees. And ACC-17's
`fiscal_year_ending` never reached the frontend union at all, which no type
error could reveal: the consumer's own union did not know the state existed, so
its `switch` stayed exhaustive over a stale set.

Fixed, with two cross-repo drift guards — every backend state must have a
branch in the component, and must be present in the frontend union — each
verified by deliberate breakage. The lesson worth keeping is that a field is
not a route: reachability for an API *field* has to be checked in the consuming
repository, and the check is only as good as its parse (mine found 2 of 5
states until an assertion floor caught it).

---

## Gates run for this pack

Green: `check:accounting-seam`, `check:route-classification`,
`check:permission-keys`, `check:scope-application`, `check:record-access`,
`check:module-entitlement`, `typecheck`, and the full backend unit suite.

Failing before this pack started and still failing, none of it caused here:
`check:migration-chain` (8 pre-existing timestamp regressions, duplicate
prefixes, and a watermark ahead of the journal — `0672` is not implicated),
`check:tenant-isolation` (21% coverage repo-wide), and
`check:idempotent-commands` (three AR/AP `allocate` handlers with no
`@Idempotent`; adding one makes the header required, which is a breaking change
for existing clients and belongs to ACC-15).

Seeded e2e was **not** run. It needs a database this session did not stand up,
so nothing here claims an end-to-end pass. The three SQL queries added by ACC-08
and ACC-09 were `EXPLAIN`ed against the real schema, which proves they are valid
and nothing more.
