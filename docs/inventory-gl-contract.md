# The Inventory ↔ General Ledger contract

**Status:** normative. ACC-01 of the accounting-seam pack.
**Written:** 2026-09-10, against `crm/phase-2-3-consolidated`.
**Binds:** every service under `src/modules/inventory/**` that moves stock, and
`src/modules/accounting/adapters/**` which receives what they send.

This is the single source of truth for what inventory owes the ledger, what the
ledger owes inventory back, and what each side is allowed to do when the other
one says no. Where this document and the code disagree, the code is the bug.

---

## 1. The two tenants

Accounting is **opt-in**. Every rule below has two readings and both are
requirements, not tolerances.

| | Accounting **disabled** (no default book) | Accounting **enabled** (a default book exists) |
|---|---|---|
| Stock movement | Works, unchanged, forever | Works only if the ledger accepts the matching journal |
| Journals | **None.** Never a placeholder, never a draft | One per valuation event, or the movement does not happen |
| Missing account role | Not a concept — nothing resolves | **Refusal.** Named, deterministic, before anything commits |
| Closed period | Not a concept | **Refusal** |

"Accounting enabled" means exactly one thing in code: `BooksService.findDefault(orgId)`
returns a row. There is no separate feature flag, and adding one would create a
third state in which a book exists but is ignored — which is how ledgers rot.

---

## 2. What posts today (measured, not aspirational)

Three call sites in inventory reach the ledger. All three go through
`PostingCommandService.submit`; none of them names a GL account id.

| Event | Call site | Source key `{sourceType}:{sourceId}:{purpose}` | Lines |
|---|---|---|---|
| Goods received | `purchase-orders/grn.service.ts` | `stock_move:{grnId}:receive` | Dr `inventory` / Cr `ap_control` |
| Shipment COGS | `sales-orders/so-fulfillment.service.ts` | `stock_move:{shipmentId}:ship` | Dr `cogs` / Cr `inventory` |
| SO invoice | `sales-orders/so-lifecycle.service.ts` | `sales_invoice:{invoiceId}:issue` | Dr `ar_control` / Cr `sales` |

The shipment key is on the **shipment**, not the sales order, and that is
load-bearing: a partially shipped SO ships more than once, and keying on the SO
would make every shipment after the first an idempotent replay that posted no
COGS at all while reporting success.

### 2.1 What does not post, and should

Thirteen services under `src/modules/inventory/**` call the stock engine. Two of
them posted from the start (`grn`, `so-fulfillment`). This section used to list
the other ten as a single hole. **ACC-21 closed it, and found that the count was
wrong** — not in size, but in kind. Of the ten:

**Seven post now**, each on the movement's own transaction, through
`StockMovementBridgeService`: `stock/inv-stock-adjustments`,
`stock/inv-stock-transfers`, `counts/inv-cycle-counts`,
`counts/inv-physical-audits`, `quality/quality-inspections` (the scrap
disposition), `returns/customer-returns`, `returns/vendor-returns`.

**Three are correct to post nothing**, and saying so is more accurate than
making them post:

- `quality/quality-holds` and `quality/quality-recalls` move stock between
  buckets. A hold blocks goods; it does not stop the business owning them, so
  the balance sheet must not move. A journal here would be wrong, not merely
  noisy.
- `import-export/import` writes opening stock, whose ledger counterpart is the
  opening trial balance the accountant enters at `/accounting/opening-balances`.
  Every real migration does both, and posting here as well would double the
  tenant's inventory figure.

`stock/inv-stock-reservations` was always in the third group: it promises stock
and changes no value.

The remaining honest gap is narrower and named: a transfer posts only its
shrinkage, and only at completion (see §3.4).

### 2.2 The GRNI defect, named

The goods receipt credits **`ap_control`** directly. That is wrong and it is the
clearest single correctness gap against Zoho Books and Odoo, both of which
accrue to a goods-received-not-invoiced account.

Crediting AP control at receipt means the AP control account carries a balance
for which no bill exists, so the AP subledger — which only knows about bills —
cannot agree with its own control account between receipt and invoice. Every
period that closes in that window closes on an AP figure that no aged-payables
report can reproduce. The fix is a `grni` role (ACC-03): receipt credits GRNI,
the bill debits GRNI and credits AP control, and GRNI nets to zero per PO line.

---

## 3. The failure model

### 3.1 What the ledger refuses

`LedgerService.post` fails closed on all of these, and the kernel never invents
its way past one:

- **No period covers the journal date** — `"No accounting period covers {date}. Open the fiscal year first."`
- **The period is `LOCKED`** — refused, including for reversals.
- **Unbalanced lines** — caught earlier by the adapter, in the caller's own vocabulary.

`PostingCommandService` adds `AdapterRejection` with a code:
`UNKNOWN_ACCOUNT_TAG`, `UNBALANCED_COMMAND`, `BOOK_NOT_ENABLED`,
`TAX_MISMATCH`, `DUPLICATE_DOCUMENT`.

### 3.2 What inventory is allowed to swallow

Exactly one code: **`BOOK_NOT_ENABLED`**. That is not a failure, it is the
opt-in tenant, and it is logged at `debug` and dropped.

**Every other rejection must surface.** A missing account role is a setup
mistake the operator can fix in a minute once they are told; swallowing it
converts a one-minute fix into a silent, permanent divergence between stock and
the GL that is discovered at audit.

### 3.3 Atomicity is inherited, not declared

**Corrected 2026-09-10.** The first version of this document said all three call
sites post after their stock transaction has committed, and therefore that a
rejected post leaves stock moved with no journal and a 500 to the caller. The
shape of the code does read that way:

```
const grnId = await this.db.transaction(...)   // stock written
await this.postToLedger(...)                   // may throw
```

**It is not a divergence window, and that claim was wrong.** `TenantContextInterceptor`
opens `withTenant` — a real `transaction()` — around the *entire* HTTP handler,
and `createTenantAwareDb` proxies the injected `DRIZZLE` so that inside a request
`this.db` resolves to that transaction. So `this.db.transaction(...)` above is a
**savepoint inside the request's transaction**, the post afterwards runs on the
same transaction, and a throw propagates out of the handler and rolls the whole
thing back — the stock movement with it. Checked: all three call sites are
reachable only from HTTP controllers, none of them carries
`@NoTenantTransaction()`, and no cron, queue or AI path calls them.

What is actually wrong with it is quieter, and worth more than the thing it
replaced:

1. **Nothing declares the guarantee and nothing tests it.** No test asserts that
   a rejected journal unwinds the stock. The property that makes this seam safe
   is a side effect of a global interceptor two layers away, discoverable only by
   reading `tenant-db.ts` and knowing a proxy is involved.

2. **It holds only for an HTTP caller under that interceptor.** A handler marked
   `@NoTenantTransaction()` has no ambient transaction, so `this.db.transaction`
   opens a real one, commits it, and the post that follows runs on its own — and
   *there* the window is genuine. So is a cron sweep, an outbox relay, or a
   `registerAfterCommit` hook. Fifteen controllers in this codebase already carry
   that decorator. Nothing stops the sixteenth being a bulk goods receipt.

3. **One `catch` erases it silently.** The guarantee depends on the error
   reaching the interceptor untouched. `so-lifecycle.confirmSo` already catches an
   auto-reserve failure and logs a warning; a call site that did the same to a
   posting failure would commit the stock and lose the journal with no error
   anywhere. That is one plausible line of code away, and no test would fail.

So the fix is not to close a window. It is to stop depending on someone else's
transaction for a guarantee this seam is supposed to make itself.

### 3.3a The period guard and the ledger check different dates

Measured, and a real defect this pack deliberately does **not** fix.

`StockEngineService.assertPeriodOpen(orgId, resolvePostingDate(cmd))` guards the
*movement's* posting date. `resolvePostingDate` falls back to **today** when the
command carries none — and neither the goods receipt nor the shipment passes
one. The journal, meanwhile, is posted on the *document's* date:
`data.receivedDate`, `data.shipDate`, `today`.

So the two can disagree in both directions:

- A receipt **backdated into a locked period**: the guard sees today's open
  period and passes; `LedgerService.resolvePeriod` sees the locked one and
  refuses. The outcome is right — the whole request rolls back — but the message
  comes from the kernel rather than from inventory.
- A receipt **dated into an open period while today's is locked**: the guard
  refuses a movement the ledger would have accepted.

The correct fix is for the receipt and the shipment to pass their document date
as the movement's `postingDate`, so the stock ledger, its costing layers and the
GL all agree on when the event happened. That is not done here because
`loadCostingContext` keys cost layers on that same date: changing it changes
inventory valuation for backdated documents, which is an inventory decision and
not a GL-contract one. It belongs to whoever owns `stock-engine`, and this
paragraph exists so that it is a decision rather than a discovery.

### 3.4 The hole that was real: ten movements that posted nothing

**Closed by ACC-21.** Kept here, in the past tense, because several commits cite
this section by number and because the shape of the mistake is worth keeping.

What it said: of the thirteen services that move stock, ten never reached the
ledger, so on an accounting-enabled tenant a scrap, a cycle-count loss and a
customer return each changed the value of stock on hand and left the inventory
GL account exactly as it was — no error, no log, no failed request.

That was true, and the framing was not. Reading the ten one at a time, three of
them *should* post nothing (§2.1), and treating the list as one undifferentiated
hole would have produced three wrong journals — most obviously a quarantine,
which would have moved a balance sheet for goods sitting in the next aisle.
"Ten services must post" was the confident answer; the correct one was six, plus
a seventh that posts only when a transfer goes short.

Two things it did not cover, both now in the map beside their reasoning: value
comes from the stock rows the engine just wrote rather than from each call site,
so the two ledgers cannot disagree about a movement they both saw; and a
transfer posts once, at completion, across both legs, because the ledger has one
inventory account with no location dimension and goods in transit are still
inventory.

What remains open here is the transfer's own accounting during transit. It is
correct today only because the GL cannot see locations. A product that grows a
`stock_in_transit` role would want the outbound leg posted against it, and that
is a ticket rather than a line.

## 4. The decision: fail closed, and say so in the code

> **When accounting is enabled, the GL post rides the same database
> transaction as the stock movement it values, passed explicitly. If the ledger
> refuses, the stock movement rolls back with it. There is no
> `pending_accounting` state.**

`PostingCommandService.submit(orgId, userId, command, tx?)` already takes a
transaction and threads it all the way to `LedgerService.post`. It was built for
this. None of the three inventory call sites passes one.

Passing it changes little about what happens today over HTTP (§3.3) and changes
everything about *why* it happens: the journal shares the stock movement's own
transaction rather than borrowing the request's. The guarantee then survives a
caller that is not an HTTP request, a handler that opts out of the tenant
transaction, and — because a rolled-back savepoint takes the stock with it — a
call site that later decides to catch and log.

### Why not `pending_accounting`

A queued-post state was the alternative and is rejected, deliberately:

1. It needs a durable queue, a retry, a dead-letter and an operator surface —
   four new failure modes to make one existing one quieter.
2. Between enqueue and drain, the stock valuation report and the balance sheet
   disagree, and every report drawn in that window is wrong in a way no reader
   can detect.
3. The two things it would defer are both *operator configuration*, not
   transient faults. A missing account role and a locked period do not resolve
   on their own with time, which is the only thing a retry queue buys.
4. Refusing the movement is recoverable in the only direction that matters: the
   goods are still physically on the dock, and the receipt can be re-entered
   the moment the account is mapped. An unwound ledger cannot be re-derived
   from a stock table.

Odoo and Zoho both refuse the document rather than queue it. This is the one
place to agree with them.

### What "fail closed" is not

It is **not** a licence to fail an accounting-*disabled* tenant. `BOOK_NOT_ENABLED`
stays swallowed, the movement stands, and ACC-16 keeps a golden-path test
asserting exactly that.

---

## 5. Rules, restated as obligations

**Inventory must:**

1. Never insert into `gl_journals` / `gl_journal_lines`. Enforced by
   `adapters/ledger-boundary.spec.ts` (ACC-19).
2. Never name a GL account id. Name a **role** (`accountTag`) and let the org's
   own chart resolve it. A tenant renumbering their chart must not break a
   goods receipt.
3. Pass its transaction to `submit` for any post that values a movement.
4. Use a source key that is unique per *valuation event*, not per document, when
   one document can value stock more than once.
5. Swallow `BOOK_NOT_ENABLED` and nothing else.

**Accounting must:**

1. Refuse in the caller's vocabulary. `"Nothing in this book is tagged
   'inventory'"` is actionable; a foreign-key violation is not.
2. Stay idempotent on `{sourceType}:{sourceId}:{purpose}` — a redelivery returns
   the original journal and posts nothing.
3. Never post on behalf of a module that did not ask.
4. Never require inventory to know a period, a fiscal year, or a currency.

---

## 6. The account roles inventory needs

`gl_system_tag` currently offers `inventory` and `cogs` of the six this seam
requires. The other four do not exist:

| Role | Tag | Exists | Used by |
|---|---|---|---|
| Inventory asset | `inventory` | yes | receipt, shipment, every adjustment |
| COGS | `cogs` | yes | shipment, scrap-to-P&L |
| Goods received not invoiced | `grni` | yes (0672) | vendor return; the receipt still owes it (§2.2) |
| Landed cost clearing | `landed_cost_clearing` | **no** | landed-cost apply |
| Inventory write-off | `inventory_write_off` | yes (0672) | quality scrap |
| Inventory adjustment gain/loss | `inventory_adjustment` | yes (0672) | adjustments, cycle counts, physical audits, transfer shrinkage |

ACC-03 adds the four missing roles additively. `gl_system_tag` is a Postgres
enum, so this is `ALTER TYPE ... ADD VALUE` and never a drop — existing posted
history is untouched, which is the point of tagging roles rather than codes.

---

## 7. What each downstream ticket owes this document

| Ticket | Obligation |
|---|---|
| ACC-02 | Refuse enabling accounting when the reference data it needs is absent, naming what is missing |
| ACC-03 | The four missing roles + mapping CRUD + validation |
| ACC-05 | The post takes the stock movement's own transaction; the period guard stops passing dates no period covers |
| ACC-06 | Missing role refuses deterministically on an enabled tenant; disabled tenant unaffected; the §3.4 movements stop being silent |
| ACC-07 | All posts through `PostingCommandService` only; `ledger-boundary.spec.ts` still green |
| ACC-08 | Report every valued movement with no journal on an enabled tenant |
| ACC-09 | Stock valuation vs GL inventory balance, with per-SKU exceptions |
| ACC-16 | Accounting-disabled golden path, asserted, unchanged |
| ACC-19 | Ratchet: no new direct `gl_journals` writers |

---

## 8. Provenance

Everything in §2 and §3 was read out of the branch, not inferred: the three
call sites and their exact source keys, the thirteen stock-moving services, the
`gl_system_tag` enum values, `LedgerService.resolvePeriod`'s two refusals, the
post-commit ordering at each call site, and — for §3.3 — `TenantContextInterceptor`,
`withTenantOn`'s `regional.transaction(...)`, and the `createTenantAwareDb`
proxy that makes `this.db` resolve to it. §4 is a product decision and is argued
rather than measured.

§3.3 previously asserted a divergence window that does not exist over HTTP. It
was written from the shape of the call sites without reading the interceptor.
The correction is left visible above rather than quietly rewritten, because
three commits and a piece of user-facing copy were built on the wrong version.
