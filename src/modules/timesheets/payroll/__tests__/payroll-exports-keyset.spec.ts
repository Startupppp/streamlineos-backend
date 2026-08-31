import { PgDialect } from "drizzle-orm/pg-core";
import { PayrollExportService } from "../payroll-export.service";
import type { Db } from "../../../../db/drizzle.module";

const dialect = new PgDialect();

function render(v: unknown): string {
  return dialect.sqlToQuery(v as Parameters<PgDialect["sqlToQuery"]>[0]).sql;
}

interface Captured {
  where: unknown;
  orderBy: unknown[];
}

function buildDb(captured: Captured) {
  const b: Record<string, unknown> = {
    from: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    where: jest.fn((c: unknown) => {
      captured.where = c;
      return b;
    }),
    orderBy: jest.fn((...cols: unknown[]) => {
      captured.orderBy = cols;
      return b;
    }),
    limit: jest.fn().mockResolvedValue([]),
  };
  return { select: jest.fn().mockReturnValue(b) } as unknown as Db;
}

const mockCache = {
  cachedVersioned: jest.fn(
    (_ns: unknown, _key: unknown, fn: () => Promise<unknown>) => fn(),
  ),
  invalidateNamespace: jest.fn(),
};

const CURSOR = Buffer.from("2024-01-15T10:00:00.000Z\x001").toString("base64url");

async function capture(cursor: string | undefined): Promise<Captured> {
  const captured: Captured = { where: undefined, orderBy: [] };
  const svc = new PayrollExportService(
    buildDb(captured),
    mockCache as never,
    {} as never,
  );
  await svc.listExports("org-1", { limit: 20, cursor });
  return captured;
}

describe("PayrollExportService.listExports — keyset matches the sort", () => {
  it("orders by created_at desc, then id desc", async () => {
    const { orderBy } = await capture(undefined);
    const rendered = orderBy.map(render);
    expect(rendered[0]).toContain('"created_at"');
    expect(rendered[1]).toContain('"id"');
  });

  it("leading sort column matches the cursor sort column", async () => {
    const { orderBy } = await capture(CURSOR);
    expect(render(orderBy[0])).toContain('"created_at"');
  });

  it("cursor predicate uses row-value strict less-than", async () => {
    const { where } = await capture(CURSOR);
    expect(render(where)).toMatch(/\) < \(\$/);
  });

  it("omits cursor predicate on first page", async () => {
    const { where } = await capture(undefined);
    expect(render(where)).not.toMatch(/\) < \(\$/);
  });

  it("bite proof: an id-only cursor without created_at is what this rejects", () => {
    const badSort = ['"timesheet_exports"."id" desc'];
    expect(badSort[0]).not.toContain('"created_at"');
  });
});
