jest.mock("../../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: (_db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(_db),
  runInNewTenantTransaction: (_db: unknown, _orgId: string, fn: (tx: unknown) => Promise<unknown>) => fn(_db),
}));

import { PgDialect } from "drizzle-orm/pg-core";
import { PayrollRunExportService, type PayrollRunExportJobRow } from "../payroll-export.service";
import { StorageService } from "../../../storage/storage.service";
import type { Db } from "../../../../db/drizzle.module";

const dialect = new PgDialect();

function render(value: unknown): string {
  return dialect.sqlToQuery(value as Parameters<PgDialect["sqlToQuery"]>[0]).sql;
}

interface Captured {
  where: unknown;
  orderBy: unknown[];
}

function buildDb(captured: Captured) {
  const builder: Record<string, unknown> = {
    from: jest.fn(),
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
  (builder.from as jest.Mock).mockReturnValue(builder);
  return { select: jest.fn().mockReturnValue(builder) } as unknown as Db;
}

const JOB = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  orgId: "org-a",
  filters: {},
} as unknown as PayrollRunExportJobRow;

async function capture(afterId: number | undefined): Promise<Captured> {
  const captured: Captured = { where: undefined, orderBy: [] };
  const svc = new PayrollRunExportService(buildDb(captured), {} as StorageService);
  await svc.rows(JOB, afterId);
  return captured;
}

describe("PayrollRunExportService.rows — keyset matches the sort", () => {
  it("orders by the same column the cursor advances on", async () => {
    const { orderBy } = await capture(undefined);
    const rendered = orderBy.map(render);
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toContain('"id"');
  });

  it("the leading sort column is the cursor column, never another column", async () => {
    const { orderBy } = await capture(500);
    const leading = render(orderBy[0]);
    expect(leading).toContain('"id"');
    expect(leading).not.toContain('"month"');
  });

  it("advances the cursor with a strict inequality, not equality", async () => {
    const { where } = await capture(500);
    const sql = render(where);
    expect(sql).toMatch(/"id"\s*>\s*\$\d+/);
    expect(sql).not.toMatch(/"id"\s*=\s*\$\d+/);
  });

  it("omits the cursor predicate entirely on the first page", async () => {
    const { where } = await capture(undefined);
    expect(render(where)).not.toMatch(/"id"\s*>/);
  });

  it("bite proof: a month-leading sort with an id cursor is what this rejects", () => {
    const monthLeadingSort = ['"payroll_runs"."month" desc', '"payroll_runs"."id" asc'];
    expect(monthLeadingSort).toHaveLength(2);
    expect(monthLeadingSort[0]).toContain('"month"');
  });
});
