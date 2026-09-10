import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * ACC-17. India fiscal-year edge cases for inventory-linked invoices.
 *
 * The acceptance is "FY rollover doesn't double-post", and it holds — for a
 * reason worth pinning rather than assuming. Every journal is keyed on the
 * document's **id**, never its number, so a series that resets on 1 April,
 * or two documents that end up sharing a number, cannot produce a replay or a
 * double post. The number is a label; the id is the identity.
 *
 * What the ticket turned up instead is the numbering itself, and it is not
 * theoretical. The rest of this file records it, with the measurements, in the
 * same marker style as the payroll gap: these are defects in `modules/invoices`
 * and the inventory bridge's use of it, outside what this pack may rewrite, and
 * a test that fails the day somebody fixes them is the cheapest way to stop
 * them being forgotten.
 */

const MODULES = join(__dirname, "../../..", "modules");

describe("a fiscal-year rollover cannot double-post", () => {
  it("keys every inventory-linked journal on an id, never on a document number", () => {
    /*
      The property the acceptance rests on. If the key were built from the
      invoice number, an FY series reset would hand a new document the same key
      as last year's — and the ledger would answer with last year's journal and
      post nothing, silently.
    */
    const source = readFileSync(
      join(MODULES, "inventory/sales-orders/so-lifecycle.service.ts"),
      "utf8",
    );
    const at = source.indexOf('sourceType: "sales_invoice"');
    expect(at).toBeGreaterThan(-1);

    const command = source.slice(at, at + 400);
    expect(command).toContain("sourceId: String(created.id)");
    expect(command).not.toContain("invoiceNumber");
  });

  it("keys the goods receipt and the shipment the same way", () => {
    for (const [file, id] of [
      ["inventory/purchase-orders/grn.service.ts", "grn.id"],
      ["inventory/sales-orders/so-fulfillment.service.ts", "ship.id"],
    ] as const) {
      const source = readFileSync(join(MODULES, file), "utf8");
      expect(source).toContain(`sourceId: String(${id})`);
    }
  });

  it("resets the accounting series per fiscal year, and refuses to guess one", () => {
    /*
      The kernel's own sequencer handles the India case properly: a row per
      (book, kind, fiscal year), an {FY} token in the pattern, and a hard
      refusal when a resetting series is asked for a number with no fiscal year
      in hand. That refusal is the load-bearing part — silently allocating from
      a continuous row would merge two years' series into one.
    */
    const sequence = readFileSync(
      join(__dirname, "../kernel/sequence.service.ts"),
      "utf8",
    );
    expect(sequence).toContain("resetEachFiscalYear");
    expect(sequence).toContain("resets each fiscal year but no fiscal year was supplied");
    expect(sequence).toContain("{FY}");
  });
});

describe("what ACC-17 found and could not fix", () => {
  const legacyWrite = readFileSync(join(MODULES, "invoices/invoices-write.service.ts"), "utf8");
  const soLifecycle = readFileSync(
    join(MODULES, "inventory/sales-orders/so-lifecycle.service.ts"),
    "utf8",
  );

  it("records that the legacy invoice number is derived from a row count", () => {
    /*
      `invoices-write.service.ts` numbers an invoice `INV-{calendarYear}-{count+1}`
      where the count is every invoice the organisation has. Three consequences,
      all of them GST-relevant and none of them caught by a constraint:

        - the count includes invoices the SALES-ORDER path created, which are
          numbered from a different series entirely, so the manual series skips
          a number every time a sales order is invoiced. Under GST the series
          has to be consecutive;
        - the calendar year in the label is decorative — the counter never
          resets, so 1 January moves `INV-2026-0412` to `INV-2027-0413`;
        - a count goes backwards if a row is ever removed, and the next invoice
          then reuses a number that was already issued.

      A real sequence table fixes all three, and `inv_number_sequences` and
      `gl_document_sequences` are both already in the schema. That is
      `modules/invoices`' change to make.
    */
    expect(legacyWrite).toContain("count(*)::int");
    expect(legacyWrite).toContain("`INV-${new Date().getFullYear()}-${String(nextNum)");
  });

  it("records that two generators write numbers into one table", () => {
    /*
      Measured on the shared database: 350 invoice rows in one organisation,
      25 distinct numbers, every row in the `INV-N` shape that inventory's
      `NumberSequenceService` produces — and ZERO unique indexes covering
      `invoice_number`. Those particular duplicates are a load fixture rather
      than real invoicing, but the fixture only got there because nothing
      forbids it, and a duplicate invoice number inside a financial year is a
      compliance defect, not an inconvenience.

      The two are `INV-{year}-{n}` from the legacy writer and `INV-{n}` from
      inventory's sequencer, so they do not collide textually today. They share
      a column and a namespace, which is the part that will not stay safe.
    */
    expect(soLifecycle).toContain('this.numSeq.next(orgId, "INVOICE")');
    expect(legacyWrite).not.toContain("numSeq");
  });

  it("records that only one of the two writers takes the numbering lock", () => {
    /*
      The legacy writer serialises itself with
      `pg_advisory_xact_lock(hashtext(orgId || 'invoice'))` and then counts
      rows inside that lock. The sales-order path inserts into the same table
      and takes no such lock, so an invoice it creates between the count and
      the insert is not excluded — two invoices can be numbered from the same
      count. With no unique index on `invoice_number`, the duplicate lands
      silently.

      Fixing it properly means giving the legacy writer a real sequence rather
      than a count; making the sales-order path take a lock it should not need
      to know about would paper over the root cause and add a second place to
      forget.
    */
    expect(legacyWrite).toContain("pg_advisory_xact_lock");
    expect(soLifecycle).not.toContain("pg_advisory_xact_lock");
  });

  it("keeps the finding written down where the next reader will look", () => {
    const adr = readFileSync(
      join(__dirname, "../../../..", "docs/adr-legacy-invoices-vs-ar.md"),
      "utf8",
    );
    expect(adr).toContain("## Document numbering");
    expect(adr).toContain("count(*)");
  });
});
