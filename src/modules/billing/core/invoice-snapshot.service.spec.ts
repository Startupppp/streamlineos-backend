import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { MODULE_METADATA } from "@nestjs/common/constants";
import { Test } from "@nestjs/testing";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { BillingModule } from "./billing.module";
import { InvoiceSnapshotService, type IssueInvoiceInput } from "./invoice-snapshot.service";

let ambientTx: unknown = null;

jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: (_db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(ambientTx),
}));

const dialect = new PgDialect();

function renderSql(value: unknown): string {
  return dialect.sqlToQuery(value as SQL).sql;
}

const ISSUED_AT = new Date("2026-08-27T09:00:00Z");

function makeTx(options: { lastNumber?: number; inserted?: { id: number }[] } = {}) {
  const calls: string[] = [];
  const executedSql: string[] = [];
  const insertedValues: unknown[] = [];
  const updatedValues: Record<string, unknown>[] = [];
  const selectResults: Record<string, unknown>[][] = [];

  const execute = jest.fn().mockImplementation((statement: unknown) => {
    const rendered = renderSql(statement);
    executedSql.push(rendered);
    if (rendered.includes("pg_advisory_xact_lock")) {
      calls.push("lock");
      return Promise.resolve([]);
    }
    calls.push("allocate");
    return Promise.resolve([{ last_number: options.lastNumber ?? 1 }]);
  });

  function nextRows(): Record<string, unknown>[] {
    return selectResults.shift() ?? [];
  }

  const tx = {
    execute,
    select: jest.fn().mockImplementation(() => {
      calls.push("select");
      const chain: Record<string, unknown> = {};
      const passthrough = () => chain;
      chain["from"] = passthrough;
      chain["where"] = passthrough;
      chain["orderBy"] = passthrough;
      chain["limit"] = () => Promise.resolve(nextRows());
      chain["then"] = (onFulfilled: (rows: Record<string, unknown>[]) => unknown) => onFulfilled(nextRows());
      return chain;
    }),
    update: jest.fn().mockImplementation(() => {
      const chain: Record<string, unknown> = {};
      chain["set"] = (values: Record<string, unknown>) => {
        updatedValues.push(values);
        calls.push("update");
        return chain;
      };
      chain["where"] = () => Promise.resolve([]);
      return chain;
    }),
    insert: jest.fn().mockImplementation(() => ({
      values: (values: unknown) => {
        insertedValues.push(values);
        calls.push("insert");
        const promise = Promise.resolve([]);
        return Object.assign(promise, {
          returning: () => Promise.resolve(options.inserted ?? [{ id: 900 }]),
        });
      },
    })),
  };

  return { tx, calls, executedSql, insertedValues, updatedValues, selectResults };
}

async function buildService(): Promise<InvoiceSnapshotService> {
  const moduleRef = await Test.createTestingModule({
    providers: [InvoiceSnapshotService, { provide: DRIZZLE, useValue: {} }],
  }).compile();
  return moduleRef.get(InvoiceSnapshotService);
}

function issueInput(overrides: Partial<IssueInvoiceInput> = {}): IssueInvoiceInput {
  return {
    orgId: "org1",
    currency: "INR",
    taxBehavior: "EXCLUSIVE",
    issuedAt: ISSUED_AT,
    sellerName: "StreamlineOS",
    sellerAddress: { line1: "1 Example Road", country: "IN" },
    sellerTaxIds: { GSTIN: "29AAAAA0000A1Z5" },
    buyerName: "Acme Pvt Ltd",
    buyerAddress: { line1: "9 Buyer Street", country: "IN" },
    buyerTaxIds: { GSTIN: "27BBBBB1111B1Z9" },
    placeOfSupply: "KA",
    fxRateMicro: 83_450_000,
    fxRateSource: "rbi-reference",
    fxRateCapturedAt: ISSUED_AT,
    lines: [
      { lineType: "SUBSCRIPTION", description: "Professional, 10 seats", quantity: 10, unitAmountMinor: 99_900, taxRateBps: 1800 },
    ],
    ...overrides,
  };
}

const ISSUED_SNAPSHOT = {
  id: 900,
  invoiceNumber: "INV-2026-000001",
  status: "ISSUED",
  currency: "INR",
  taxBehavior: "EXCLUSIVE",
  placeOfSupply: "KA",
  fxRateMicro: 83_450_000,
  fxRateSource: "rbi-reference",
  fxRateCapturedAt: ISSUED_AT,
  subtotalMinor: 999_000,
  taxAmountMinor: 179_820,
  totalMinor: 1_178_820,
  roundingRule: "HALF_UP",
  issuedAt: ISSUED_AT,
  paidAt: null,
  voidedAt: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  ambientTx = null;
});

describe("InvoiceSnapshotService — registration", () => {
  it("is a provider of BillingModule", () => {
    const providers: unknown = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, BillingModule);
    expect(Array.isArray(providers) ? providers : []).toContain(InvoiceSnapshotService);
  });

  it("is exported by BillingModule", () => {
    const exported: unknown = Reflect.getMetadata(MODULE_METADATA.EXPORTS, BillingModule);
    expect(Array.isArray(exported) ? exported : []).toContain(InvoiceSnapshotService);
  });
});

describe("InvoiceSnapshotService — seller, buyer, tax and currency are frozen at issue", () => {
  it("snapshots both parties, their tax registrations, place of supply and tax behaviour", async () => {
    const { tx, insertedValues } = makeTx();
    ambientTx = tx;
    const service = await buildService();

    await service.issueInvoice(issueInput());

    expect(insertedValues[0]).toMatchObject({
      sellerName: "StreamlineOS",
      sellerTaxIds: { GSTIN: "29AAAAA0000A1Z5" },
      buyerName: "Acme Pvt Ltd",
      buyerTaxIds: { GSTIN: "27BBBBB1111B1Z9" },
      placeOfSupply: "KA",
      taxBehavior: "EXCLUSIVE",
      currency: "INR",
    });
  });

  it("captures the FX rate, its source and when it was taken", async () => {
    const { tx, insertedValues } = makeTx();
    ambientTx = tx;
    const service = await buildService();

    await service.issueInvoice(issueInput());

    expect(insertedValues[0]).toMatchObject({
      fxRateMicro: 83_450_000,
      fxRateSource: "rbi-reference",
      fxRateCapturedAt: ISSUED_AT,
    });
  });

  it("carries the currency onto every line, not only the header", async () => {
    const { tx, insertedValues } = makeTx();
    ambientTx = tx;
    const service = await buildService();

    await service.issueInvoice(
      issueInput({
        currency: "USD",
        lines: [
          { lineType: "SUBSCRIPTION", description: "a", quantity: 1, unitAmountMinor: 100 },
          { lineType: "USAGE", description: "b", quantity: 2, unitAmountMinor: 50 },
        ],
      }),
    );

    const lines = insertedValues[1] as Record<string, unknown>[];
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line["currency"]).toBe("USD");
  });

  it("refuses a currency that is not a three-letter ISO code", async () => {
    ambientTx = makeTx().tx;
    const service = await buildService();

    await expect(service.issueInvoice(issueInput({ currency: "Rupee" }))).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("refuses an invoice with no lines rather than issuing an empty document", async () => {
    ambientTx = makeTx().tx;
    const service = await buildService();

    await expect(service.issueInvoice(issueInput({ lines: [] }))).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe("InvoiceSnapshotService — amounts are integer minor units and totals are computed, not accepted", () => {
  it("prices each line and rolls the document up from the lines", async () => {
    const { tx, insertedValues } = makeTx();
    ambientTx = tx;
    const service = await buildService();

    const result = await service.issueInvoice(issueInput());

    expect(result.subtotalMinor).toBe(999_000);
    expect(result.taxAmountMinor).toBe(179_820);
    expect(result.totalMinor).toBe(1_178_820);
    expect(insertedValues[0]).toMatchObject({
      subtotalMinor: 999_000,
      taxAmountMinor: 179_820,
      totalMinor: 1_178_820,
    });
  });

  it("keeps the document total equal to the sum of line totals under any rounding rule", async () => {
    for (const roundingRule of ["HALF_UP", "HALF_EVEN", "FLOOR", "CEILING"] as const) {
      const { tx, insertedValues } = makeTx();
      ambientTx = tx;
      const service = await buildService();

      const result = await service.issueInvoice(
        issueInput({
          roundingRule,
          lines: [
            { lineType: "USAGE", description: "a", quantity: 3, unitAmountMinor: 333, taxRateBps: 1250 },
            { lineType: "USAGE", description: "b", quantity: 7, unitAmountMinor: 101, taxRateBps: 1250 },
            { lineType: "PRORATION", description: "c", quantity: 1, unitAmountMinor: 5, taxRateBps: 1250 },
          ],
        }),
      );

      const lines = insertedValues[1] as Record<string, number>[];
      const lineTotal = lines.reduce((sum, line) => sum + line["totalMinor"]!, 0);
      expect(result.totalMinor).toBe(lineTotal);
      expect(result.totalMinor).toBe(result.subtotalMinor + result.taxAmountMinor);
      expect(Number.isInteger(result.taxAmountMinor)).toBe(true);
    }
  });

  it("adds tax on top when the behaviour is EXCLUSIVE", async () => {
    const { tx, insertedValues } = makeTx();
    ambientTx = tx;
    const service = await buildService();

    const result = await service.issueInvoice(
      issueInput({
        taxBehavior: "EXCLUSIVE",
        lines: [{ lineType: "SUBSCRIPTION", description: "a", quantity: 1, unitAmountMinor: 10_000, taxRateBps: 1800 }],
      }),
    );

    expect(result.subtotalMinor).toBe(10_000);
    expect(result.taxAmountMinor).toBe(1_800);
    expect(result.totalMinor).toBe(11_800);
    expect((insertedValues[1] as Record<string, number>[])[0]).toMatchObject({ totalMinor: 11_800 });
  });

  it("extracts tax from the unit amount when the behaviour is INCLUSIVE, leaving the total unchanged", async () => {
    const { tx } = makeTx();
    ambientTx = tx;
    const service = await buildService();

    const result = await service.issueInvoice(
      issueInput({
        taxBehavior: "INCLUSIVE",
        lines: [{ lineType: "SUBSCRIPTION", description: "a", quantity: 1, unitAmountMinor: 11_800, taxRateBps: 1800 }],
      }),
    );

    expect(result.totalMinor).toBe(11_800);
    expect(result.taxAmountMinor).toBe(1_800);
    expect(result.subtotalMinor).toBe(10_000);
  });

  it("charges an INCLUSIVE line less tax than an EXCLUSIVE one at the same unit amount", async () => {
    const lines = [{ lineType: "SUBSCRIPTION", description: "a", quantity: 3, unitAmountMinor: 49_999, taxRateBps: 500 }];

    ambientTx = makeTx().tx;
    const exclusive = await (await buildService()).issueInvoice(
      issueInput({ taxBehavior: "EXCLUSIVE", lines }),
    );
    ambientTx = makeTx().tx;
    const inclusive = await (await buildService()).issueInvoice(
      issueInput({ taxBehavior: "INCLUSIVE", lines }),
    );

    expect(inclusive.taxAmountMinor).toBeLessThan(exclusive.taxAmountMinor);
    expect(inclusive.totalMinor).toBe(inclusive.subtotalMinor + inclusive.taxAmountMinor);
    expect(exclusive.totalMinor).toBe(exclusive.subtotalMinor + exclusive.taxAmountMinor);
  });

  it("stores the rounding rule it used, so the document can be recomputed identically", async () => {
    const { tx, insertedValues } = makeTx();
    ambientTx = tx;
    const service = await buildService();

    await service.issueInvoice(issueInput({ roundingRule: "HALF_EVEN" }));

    expect(insertedValues[0]).toMatchObject({ roundingRule: "HALF_EVEN" });
  });

  it("refuses a fractional unit amount rather than storing a rounded one", async () => {
    ambientTx = makeTx().tx;
    const service = await buildService();

    await expect(
      service.issueInvoice(
        issueInput({ lines: [{ lineType: "USAGE", description: "a", quantity: 1, unitAmountMinor: 10.5 }] }),
      ),
    ).rejects.toThrow(/integer minor unit/);
  });

  it("preserves the line order it was given", async () => {
    const { tx, insertedValues } = makeTx();
    ambientTx = tx;
    const service = await buildService();

    await service.issueInvoice(
      issueInput({
        lines: [
          { lineType: "SUBSCRIPTION", description: "first", quantity: 1, unitAmountMinor: 100 },
          { lineType: "PRORATION", description: "second", quantity: 1, unitAmountMinor: 200 },
          { lineType: "USAGE", description: "third", quantity: 1, unitAmountMinor: 300 },
        ],
      }),
    );

    const lines = insertedValues[1] as Record<string, unknown>[];
    expect(lines.map((line) => line["sortOrder"])).toEqual([0, 1, 2]);
    expect(lines.map((line) => line["description"])).toEqual(["first", "second", "third"]);
  });

  it("links a line to the proration line or usage rollup it came from", async () => {
    const { tx, insertedValues } = makeTx();
    ambientTx = tx;
    const service = await buildService();

    await service.issueInvoice(
      issueInput({
        lines: [
          { lineType: "PRORATION", description: "a", quantity: 1, unitAmountMinor: 100, prorationLineId: 11 },
          { lineType: "USAGE", description: "b", quantity: 1, unitAmountMinor: 100, usageRollupId: 22 },
        ],
      }),
    );

    const lines = insertedValues[1] as Record<string, unknown>[];
    expect(lines[0]).toMatchObject({ prorationLineId: 11, usageRollupId: null });
    expect(lines[1]).toMatchObject({ prorationLineId: null, usageRollupId: 22 });
  });
});

describe("InvoiceSnapshotService — numbering is transactionally serialized", () => {
  it("takes the per-organisation numbering lock before it allocates", async () => {
    const { tx, calls, executedSql } = makeTx();
    ambientTx = tx;
    const service = await buildService();

    await service.issueInvoice(issueInput());

    expect(calls[0]).toBe("lock");
    expect(calls.indexOf("allocate")).toBeGreaterThan(calls.indexOf("lock"));
    expect(executedSql[0]).toContain("pg_advisory_xact_lock");
  });

  it("increments the stored sequence rather than counting existing invoices", async () => {
    const { tx, executedSql } = makeTx({ lastNumber: 42 });
    ambientTx = tx;
    const service = await buildService();

    const result = await service.issueInvoice(issueInput());

    expect(result.invoiceNumber).toBe("INV-2026-000042");
    const allocateSql = executedSql.find((statement) => statement.includes("billing_invoice_number_sequences"));
    expect(allocateSql).toContain("ON CONFLICT");
    expect(allocateSql).toContain("last_number + 1");
  });

  it("scopes the sequence to the year the invoice is issued in", async () => {
    const { tx } = makeTx({ lastNumber: 7 });
    ambientTx = tx;
    const service = await buildService();

    const result = await service.issueInvoice(
      issueInput({ issuedAt: new Date("2027-01-02T00:00:00Z") }),
    );

    expect(result.invoiceNumber).toBe("INV-2027-000007");
  });

  it("refuses rather than numbering an invoice from a sequence it could not read", async () => {
    const { tx } = makeTx();
    tx.execute = jest.fn().mockResolvedValue([]);
    ambientTx = tx;
    const service = await buildService();

    await expect(service.issueInvoice(issueInput())).rejects.toThrow(/no row returned/);
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it("refuses a prefix that would not fit or would not read back", async () => {
    ambientTx = makeTx().tx;
    const service = await buildService();

    await expect(service.issueInvoice(issueInput({ numberPrefix: "inv oice!" }))).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe("InvoiceSnapshotService — an issued invoice does not change", () => {
  it("moves status and stamps a time without touching any amount", async () => {
    const { tx, selectResults, updatedValues } = makeTx();
    selectResults.push([ISSUED_SNAPSHOT]);
    ambientTx = tx;
    const service = await buildService();

    await service.markPaid("org1", 900, ISSUED_AT);

    expect(updatedValues[0]).toEqual({ status: "PAID", paidAt: ISSUED_AT });
    for (const forbidden of ["subtotalMinor", "taxAmountMinor", "totalMinor", "currency", "invoiceNumber"])
      expect(Object.keys(updatedValues[0] ?? {})).not.toContain(forbidden);
  });

  it("refuses to void a paid invoice and points at the credit note instead", async () => {
    const { tx, selectResults } = makeTx();
    selectResults.push([{ ...ISSUED_SNAPSHOT, status: "PAID" }]);
    ambientTx = tx;
    const service = await buildService();

    await expect(service.voidInvoice("org1", 900)).rejects.toBeInstanceOf(ConflictException);
  });

  it("refuses to change a voided invoice at all", async () => {
    const { tx, selectResults } = makeTx();
    selectResults.push([{ ...ISSUED_SNAPSHOT, status: "VOID" }]);
    ambientTx = tx;
    const service = await buildService();

    await expect(service.markPaid("org1", 900)).rejects.toBeInstanceOf(ConflictException);
  });

  it("is a no-op when the invoice is already in the target status", async () => {
    const { tx, selectResults } = makeTx();
    selectResults.push([{ ...ISSUED_SNAPSHOT, status: "PAID" }]);
    ambientTx = tx;
    const service = await buildService();

    await service.markPaid("org1", 900);

    expect(tx.update).not.toHaveBeenCalled();
  });

  it("reports a missing invoice rather than transitioning nothing", async () => {
    const { tx, selectResults } = makeTx();
    selectResults.push([]);
    ambientTx = tx;
    const service = await buildService();

    await expect(service.markPaid("org1", 900)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("InvoiceSnapshotService — corrections are credit notes that preserve the original", () => {
  it("writes a separately numbered note pointing at the original and never updates it", async () => {
    const { tx, selectResults, insertedValues, updatedValues } = makeTx({ lastNumber: 3 });
    selectResults.push([ISSUED_SNAPSHOT]);
    ambientTx = tx;
    const service = await buildService();

    const result = await service.createCreditNote({
      orgId: "org1",
      originalSnapshotId: 900,
      noteType: "CREDIT",
      reason: "seat count corrected",
      createdBy: "admin1",
      lines: [{ lineType: "ADJUSTMENT", description: "2 seats", quantity: 2, unitAmountMinor: 99_900, taxRateBps: 1800 }],
    });

    expect(result.noteNumber).toBe("CN-2026-000003");
    expect(result.totalMinor).toBe(235_764);
    expect(insertedValues[0]).toMatchObject({ originalSnapshotId: 900, noteType: "CREDIT", status: "ISSUED" });
    expect(updatedValues).toHaveLength(0);
  });

  it("takes the currency from the original invoice, so a note cannot drift to another currency", async () => {
    const { tx, selectResults, insertedValues } = makeTx({ lastNumber: 1 });
    selectResults.push([{ ...ISSUED_SNAPSHOT, currency: "USD" }]);
    ambientTx = tx;
    const service = await buildService();

    await service.createCreditNote({
      orgId: "org1",
      originalSnapshotId: 900,
      noteType: "CREDIT",
      reason: "refund",
      createdBy: "admin1",
      lines: [{ lineType: "ADJUSTMENT", description: "a", quantity: 1, unitAmountMinor: 100 }],
    });

    expect(insertedValues[0]).toMatchObject({ currency: "USD" });
    expect((insertedValues[1] as Record<string, unknown>[])[0]).toMatchObject({ currency: "USD" });
  });

  it("refuses to credit a draft invoice, which has nothing to correct yet", async () => {
    const { tx, selectResults } = makeTx();
    selectResults.push([{ ...ISSUED_SNAPSHOT, status: "DRAFT" }]);
    ambientTx = tx;
    const service = await buildService();

    await expect(
      service.createCreditNote({
        orgId: "org1",
        originalSnapshotId: 900,
        noteType: "CREDIT",
        reason: "x",
        createdBy: "admin1",
        lines: [{ lineType: "ADJUSTMENT", description: "a", quantity: 1, unitAmountMinor: 100 }],
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe("migration 0565 — the database enforces immutability too", () => {
  const sqlText = readFileSync(
    join(__dirname, "..", "..", "..", "..", "migrations", "0565_billing_invoice_snapshot_immutability.sql"),
    "utf8",
  );

  it("puts a BEFORE UPDATE trigger on the snapshot table the service writes", () => {
    expect(sqlText).toContain("CREATE TRIGGER trg_billing_invoice_snapshot_immutability");
    expect(sqlText).toContain("BEFORE UPDATE ON billing_invoice_snapshots");
  });

  it("guards every field the invoice snapshots, not only the totals", () => {
    for (const column of [
      "invoice_number",
      "currency",
      "tax_behavior",
      "subtotal_minor",
      "tax_amount_minor",
      "total_minor",
      "rounding_rule",
      "fx_rate_micro",
      "fx_rate_source",
      "fx_rate_captured_at",
      "seller_tax_ids",
      "buyer_tax_ids",
      "place_of_supply",
      "issued_at",
    ])
      expect(sqlText).toContain(`OLD.${column}`);
  });

  it("leaves the lifecycle columns writable, so a paid invoice can be marked paid", () => {
    expect(sqlText).not.toContain("OLD.paid_at");
    expect(sqlText).not.toContain("OLD.voided_at");
    expect(sqlText).not.toContain("OLD.due_at");
  });

  it("guards lines and credit notes as well as the header", () => {
    expect(sqlText).toContain("BEFORE UPDATE ON billing_invoice_line_snapshots");
    expect(sqlText).toContain("BEFORE UPDATE ON billing_credit_notes");
    expect(sqlText).toContain("BEFORE UPDATE ON billing_credit_note_lines");
  });

  it("guards UPDATE only, so tenant erasure can still cascade a delete through", () => {
    expect(sqlText).not.toContain("BEFORE DELETE");
    expect(sqlText).not.toContain("BEFORE UPDATE OR DELETE");
  });

  it("fails fast on a lock rather than queueing behind a long reader", () => {
    expect(sqlText).toContain("SET lock_timeout");
  });
});
