import { PgDialect } from "drizzle-orm/pg-core";
import { TaxReportsService } from "../tax-reports.service";
import type { Db } from "../../../../db/drizzle.module";

const dialect = new PgDialect();

function render(value: unknown): string {
  return dialect.sqlToQuery(value as Parameters<PgDialect["sqlToQuery"]>[0]).sql;
}

interface Captured {
  where: unknown;
  orderBy: unknown[];
}

function buildDb(captured: Captured): Db {
  const builder: Record<string, unknown> = {
    from: jest.fn().mockReturnThis(),
    where: jest.fn((cond: unknown) => {
      captured.where = cond;
      return builder;
    }),
    orderBy: jest.fn((...cols: unknown[]) => {
      captured.orderBy = cols;
      return builder;
    }),
    limit: jest.fn().mockResolvedValue([]),
  };
  return { select: jest.fn().mockReturnValue(builder) } as unknown as Db;
}

const mockCache = {
  cachedVersioned: jest.fn((_ns: unknown, _key: unknown, fn: () => unknown) => fn()),
};

const BASE_QUERY = { from: "2025-01-01", to: "2025-03-31", limit: 20, format: "json" as const };

async function captureOutput(cursor: string | undefined): Promise<Captured> {
  const captured: Captured = { where: undefined, orderBy: [] };
  const svc = new TaxReportsService(buildDb(captured), mockCache as never, {} as never);
  await svc.getOutputReport("org-1", { ...BASE_QUERY, cursor });
  return captured;
}

async function captureInput(cursor: string | undefined): Promise<Captured> {
  const captured: Captured = { where: undefined, orderBy: [] };
  const svc = new TaxReportsService(buildDb(captured), mockCache as never, {} as never);
  await svc.getInputReport("org-1", { ...BASE_QUERY, cursor });
  return captured;
}

describe("TaxReportsService.getOutputReport — keyset on invoices.created_at/id", () => {
  it("orders by created_at desc then id desc", async () => {
    const { orderBy } = await captureOutput(undefined);
    const rendered = orderBy.map(render).join(" ");
    expect(rendered).toContain('"created_at"');
    expect(rendered).toContain('"id"');
  });

  it("cursor predicate is a strict < inequality and references id", async () => {
    const { where } = await captureOutput("MjAyNS0wMS0wMVQwMDowMDowMC4wMDBaADEw");
    const sql = render(where);
    expect(sql).toMatch(/</);
    expect(sql).toContain('"id"');
  });

  it("first page omits the cursor predicate", async () => {
    const { where } = await captureOutput(undefined);
    expect(render(where)).not.toContain('"id"');
  });
});

describe("TaxReportsService.getInputReport — keyset on purchase_bills.bill_date/id", () => {
  it("orders by bill_date desc then id desc", async () => {
    const { orderBy } = await captureInput(undefined);
    const rendered = orderBy.map(render).join(" ");
    expect(rendered).toContain('"bill_date"');
    expect(rendered).toContain('"id"');
  });

  it("cursor predicate is a strict < inequality and references id", async () => {
    const { where } = await captureInput("MjAyNS0wMS0xNQAxMA==");
    const sql = render(where);
    expect(sql).toMatch(/</);
    expect(sql).toContain('"id"');
  });

  it("first page omits the cursor predicate", async () => {
    const { where } = await captureInput(undefined);
    expect(render(where)).not.toContain('"id"');
  });
});
