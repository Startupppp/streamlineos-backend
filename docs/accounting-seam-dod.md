# Accounting seam — definition of done

ACC-20. What each P0 of the accounting-seam pack delivered, what proves it, and
what is deliberately still open.

Run the gate with:

```bash
pnpm check:accounting-seam
```

It checks the four things no test can: the orchestrator's fence, the rejected
design not returning, each P0's artefact still carrying assertions, and the
contract still saying what the commits cite it as saying. Everything else is
proved by the specs named below, which run in the ordinary suite.

---

## P0 status

| Ticket | State | Evidence |
|---|---|---|
| ACC-01 Document the Inventory↔GL contract | Done | `docs/inventory-gl-contract.md` |
| ACC-02 Provisioning check when accounting is enabled | Done | `accounting/setup/accounting-provisioning.spec.ts` |
| ACC-03 Account mapping model | Done, **3 of 6 roles** | `accounting/kernel/system-tag-roles.spec.ts`, migration `0672` |
| ACC-04 FE account-mapping screen | Done | `features/accounting/settings/__tests__/account-mappings-card.test.tsx` (frontend) |
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
| ACC-17 India FY edge cases for inventory-linked invoices | Not started (P2) | — |

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

**§3.4 — ten stock-moving services still post nothing.** Adjustments,
transfers, cycle counts, physical audits, three quality services, both returns
and import all change the value of stock on hand and write no journal. ACC-08
makes the gap countable; closing it needs each of those services to post, which
is a larger piece of work than this pack.

**The shipment reconciliation is sales-order-level.** A stock transaction
records the sales order as its reference and never the shipment, so on a
partially shipped order one posted shipment makes the whole order look posted.
The report says so in its own payload.

**ACC-14 live IRP transport is blocked.** No provider credentials. ACC-13's mock
transport is in and is the substitute until they exist; no adapter may declare
`isReal = true` until then, which is asserted.

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
