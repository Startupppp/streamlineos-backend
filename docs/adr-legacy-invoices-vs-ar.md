# ADR: `modules/invoices` and accounting's AR

**Status:** accepted. ACC-18 of the accounting-seam pack.
**Date:** 2026-09-10, against `crm/phase-2-3-consolidated`.
**Decision:** keep both for now, deprecate `modules/invoices` behind a dedicated
migration ticket, and — immediately — stop the two from producing two journals
for one document.

---

## The two systems

| | `modules/invoices` (legacy) | `accounting/ar` |
|---|---|---|
| Table | `invoices`, `invoice_items` | `ar_documents`, `ar_document_lines` |
| Primary key | `serial` integer | `text` UUID |
| Writers | `invoices-write`, `quotes-lifecycle`, `inventory/sales-orders/so-lifecycle` | `ar-documents.service` |
| Posts as | `sales_invoice:{int}:post` | `sales_invoice:{uuid}:…` |
| Tax | GST components frozen onto the row | Determined by the tax pack |
| Party | `party_id` beside a legacy `client_id` | `gl_parties`, via `external_refs` |

Both post through `PostingCommandService`, so neither writes the ledger
directly and `ledger-boundary.spec.ts` stays green either way. This is not a
dual *ledger*; it is a dual *document*.

---

## What was actually broken

### The two systems cannot collide with each other, by accident

Both post with `sourceType: "sales_invoice"`, so their idempotency keys share a
namespace. They do not collide because one id space is `serial` integers and the
other is UUIDs, and no integer is ever equal to a UUID string.

That is luck, not design, and it is recorded here so it stops being invisible:
if either side's primary key type ever changed, or a third writer adopted the
same `sourceType`, one document's journal would be returned for another's
posting attempt and the second document would silently post nothing.

### Two writers into the *same* id space did collide

`modules/invoices` and `inventory/sales-orders/so-lifecycle` both insert into
the **same `invoices` table**, sharing one serial id space — and they posted
under **different purposes**: `post` and `issue`. So one invoice had two
possible idempotency keys, and the key could not deduplicate between them.

It was reachable. `invoices-update.service.ts` posts whenever a status moves to
`ISSUED` from anything else:

```ts
const willPost = input.status === "ISSUED" && existing.status !== "ISSUED";
```

An invoice created by the sales-order path is born `ISSUED` and has already
posted under `sales_invoice:{id}:issue`. `updateInvoiceSchema` accepts
`ISSUED | PAID | FAILED | VOIDED`, so a `PATCH` to `VOIDED` followed by a
`PATCH` back to `ISSUED` satisfies `willPost`, posts under
`sales_invoice:{id}:post`, and the ledger accepts it as a different document.
**AR control and sales revenue, counted twice, with no error anywhere.**

**Fixed** by giving the sales-order path the same purpose (`post`) as its
sibling, so one document has one key. `inventory-posting-keys.spec.ts` pins it.

**Not fixed, and it cannot be from here:** an invoice that already posted under
`:issue` on a live database still has a key no future `:post` will match, so the
round-trip can still double-post *those* rows once. Repairing them needs a
migration that finds `gl_journals` with `source_type = 'sales_invoice'` and a
`:issue` idempotency key and reconciles them against `invoices` — a data
migration with a real blast radius, and a ticket of its own.

---

## Document numbering

Found by ACC-17, which set out to check India fiscal-year edge cases and found
the numbering instead.

### The rollover itself is safe

Every journal is keyed on the document's **id**, never its number. A series
that resets on 1 April, or two documents that end up sharing a number, cannot
produce a replay or a double post — the number is a label, the id is the
identity. The kernel's own `SequenceService` handles the India case properly:
a row per `(book, kind, fiscal_year)`, an `{FY}` token in the pattern, and a
hard refusal when a resetting series is asked for a number with no fiscal year
in hand.

### The numbers themselves are not

`invoices-write.service.ts` numbers an invoice `INV-{calendarYear}-{count+1}`,
where the count is **every invoice row the organisation has**:

```ts
const countRows = await tx.select({ count: sql`count(*)::int` })
  .from(invoices).where(eq(invoices.orgId, orgId));
const nextNum = (countRows[0]?.count ?? 0) + 1;
```

Four problems, none of them caught by a constraint:

1. **The series skips.** That count includes invoices the sales-order path
   created, which are numbered from a different series entirely
   (`NumberSequenceService`, `INV-00001`). So the manual series jumps a number
   every time a sales order is invoiced. Under GST an invoice series has to be
   consecutive.
2. **The year is decorative.** The counter never resets, so 1 January moves
   `INV-2026-0412` to `INV-2027-0413`.
3. **A count goes backwards.** Remove a row and the next invoice reuses a
   number that was already issued.
4. **Only one writer takes the lock.** The legacy writer serialises itself with
   `pg_advisory_xact_lock(hashtext(orgId || 'invoice'))` and counts inside it.
   The sales-order path inserts into the same table and takes no such lock, so
   two invoices can be numbered from the same count.

And `invoices.invoice_number` has **no uniqueness constraint** — the only
unique index on the table is `uniq_invoices_org_id` on `(org_id, id)`. So a
duplicate lands silently. Measured on the shared development database: 350
invoice rows in one organisation, **25 distinct numbers**, every row in the
`INV-N` shape, zero unique indexes covering the column. Those particular
duplicates are a load fixture rather than real invoicing — but the fixture only
got there because nothing forbids it.

### Why this pack did not fix it

The root cause is the count-based scheme in `modules/invoices`, which is not
this pack's to rewrite, and the right fix is a real sequence row —
`inv_number_sequences` and `gl_document_sequences` are both already in the
schema. Making the sales-order path take the legacy writer's advisory lock
would paper over the cause and add a second place to forget it.

Adding the unique index is its own migration and cannot be done blind: on any
database carrying duplicates it fails, so it needs a repair pass first, and the
repair has to decide what a re-numbered invoice does to a GST return already
filed against the old number. That is a ticket, not a line.

`document-series-fy.spec.ts` pins each of these so they fail the day they are
fixed.

---

## Decision, and why not the alternatives

### Keep both, deprecate the legacy one behind its own ticket

**Not delete.** `modules/invoices` has three writers, one of which is the
inventory sales-order flow, and its rows carry frozen GST components that AR
would re-derive from the tax pack. Deleting it is a data migration plus three
call-site rewrites plus a tax-equivalence proof, and the pack's own scope note
says to prefer documenting over a big-bang delete.

**Not migrate now.** AR is the better model — real party resolution, pack-driven
tax, credit notes, receipts, aging — and it should win in the end. But moving
the sales-order flow onto it means the SO invoice acquires a UUID, and
`inv_sales_orders.invoice_id` is an `integer` FK to `invoices`. That column has
to change type or become a second pointer, which is a schema migration on live
inventory data. Not something to do inside a seam pack.

**Not leave it alone.** The double-post above is a correctness bug in the
general ledger, which is exactly what this pack exists to prevent, and it cost
one word to fix.

### The rule that holds until the migration ticket

> Every writer into the `invoices` table posts as
> `sales_invoice:{invoices.id}:post`. One document, one key.

A new writer picking its own purpose reintroduces the same defect, and it would
look like careful naming rather than a bug — which is why the rule is written
down and asserted rather than left to the reader.

---

## What a migration ticket has to cover

1. `inv_sales_orders.invoice_id`: integer FK to `invoices` → a pointer to
   `ar_documents`, or a second column during the overlap.
2. `quotes-lifecycle`'s accept-to-invoice path.
3. Tax equivalence: the legacy row's frozen CGST/SGST/IGST versus what the
   `IN` pack determines for the same document. If they differ, the migration
   must preserve the frozen values — a later change of registered address must
   not rewrite history.
4. The `:issue` journals already written, per the section above.
5. Payments: `invoices-payment.service` versus `ar-receipts`, including
   allocation and realised FX.

Until all five have answers, both systems stay, and the rule above is what keeps
them from disagreeing.
