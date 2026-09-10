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
them also post (`grn`, `so-fulfillment`). One — `stock/inv-stock-reservations` —
only reserves and releases, changes no value, and correctly posts nothing. The
remaining **ten never reach the ledger at all**:

`stock/inv-stock-adjustments`, `stock/inv-stock-transfers`,
`counts/inv-cycle-counts`, `counts/inv-physical-audits`,
`quality/quality-holds`, `quality/quality-inspections`,
`quality/quality-recalls`, `returns/customer-returns`,
`returns/vendor-returns`, `import-export/import`.

So on an accounting-enabled tenant today a scrap, a cycle-count loss, a
write-off and a customer return all change the value of stock on hand and leave
the inventory GL account untouched. The balance sheet and the stock valuation
report disagree by construction, and nothing says so. ACC-08 makes that
visible; ACC-03 gives those movements accounts to post to.

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

### 3.3 The divergence window — the defect this contract exists to close

All three call sites post **after** their stock transaction has already
committed:

```
await this.db.transaction(...)   // stock rows written, committed
await this.engine.invalidateCaches(orgId)
await this.postToLedger(...)     // may now throw
```

So on an accounting-enabled tenant, a missing `inventory` tag or a locked
period today produces: **stock moved, no journal, and a 500 to the caller.**
The client sees a failure, retries, and moves the stock a second time. This is
strictly worse than a silent skip, because a silent skip at least does not
double the stock.

`stock-engine.service.ts` has an `assertPeriodOpen` pre-check, which helps and
does not close this. It refuses only when a period exists **and** is `LOCKED`;
a date no fiscal year covers passes the pre-check and is then refused by the
ledger — after the commit. It also guards the *movement's* posting date, while
the journal is posted on the document's date (`receivedDate`, `shipDate`,
`today`), which are not required to be the same day.

---

## 4. The decision: fail closed, atomically

> **When accounting is enabled, the GL post rides the same database
> transaction as the stock movement it values. If the ledger refuses, the stock
> movement rolls back with it. There is no `pending_accounting` state.**

`PostingCommandService.submit(orgId, userId, command, tx?)` already takes a
transaction and threads it all the way to `LedgerService.post`. It was built for
this. None of the three inventory call sites passes one. That is the whole fix.

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
| Goods received not invoiced | `grni` | **no** | receipt (see §2.2) |
| Landed cost clearing | `landed_cost_clearing` | **no** | landed-cost apply |
| Inventory write-off | `inventory_write_off` | **no** | scrap, quality write-off, recall |
| Inventory adjustment gain/loss | `inventory_adjustment` | **no** | cycle-count gain/loss, physical audit, transfer variance |

ACC-03 adds the four missing roles additively. `gl_system_tag` is a Postgres
enum, so this is `ALTER TYPE ... ADD VALUE` and never a drop — existing posted
history is untouched, which is the point of tagging roles rather than codes.

---

## 7. What each downstream ticket owes this document

| Ticket | Obligation |
|---|---|
| ACC-02 | Refuse enabling accounting when the reference data it needs is absent, naming what is missing |
| ACC-03 | The four missing roles + mapping CRUD + validation |
| ACC-05 | Period enforcement moves inside the transaction; §3.3 window closes |
| ACC-06 | Missing role refuses deterministically on an enabled tenant; disabled tenant unaffected |
| ACC-07 | All posts through `PostingCommandService` only; `ledger-boundary.spec.ts` still green |
| ACC-08 | Report every valued movement with no journal on an enabled tenant |
| ACC-09 | Stock valuation vs GL inventory balance, with per-SKU exceptions |
| ACC-16 | Accounting-disabled golden path, asserted, unchanged |
| ACC-19 | Ratchet: no new direct `gl_journals` writers |

---

## 8. Provenance

Everything in §2 and §3 was read out of the branch, not inferred: the three
call sites and their exact source keys, the twelve stock-moving services, the
`gl_system_tag` enum values, `LedgerService.resolvePeriod`'s two refusals, and
the post-commit ordering at each call site. §4 is a product decision and is
argued rather than measured.
