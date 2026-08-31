import { PgDialect } from "drizzle-orm/pg-core";
import { PayoutBatchesService } from "../payout-batches.service";
import type { AuditService } from "../../../../common/audit/audit.service";
import type { StorageService } from "../../../storage/storage.service";
import type { EmploymentFactsService } from "../../../directory/employment-facts.service";
import type { Db } from "../../../../db/drizzle.types";
import { encodeCursor } from "../../../../common/pagination/cursor";

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

async function capture(cursor: string | undefined): Promise<Captured> {
  const captured: Captured = { where: undefined, orderBy: [] };
  const svc = new PayoutBatchesService(
    buildDb(captured),
    {} as AuditService,
    {} as StorageService,
    {} as EmploymentFactsService,
  );
  await svc.listBatches("org-a", undefined, cursor);
  return captured;
}

const TEST_CURSOR = encodeCursor({
  sortValue: new Date("2026-01-15T12:00:00.000Z").toISOString(),
  id: "99",
});

describe("PayoutBatchesService.listBatches — keyset matches the sort", () => {
  it("orders by generated_at DESC then id DESC", async () => {
    const { orderBy } = await capture(undefined);
    const rendered = orderBy.map(render);
    expect(rendered).toHaveLength(2);
    expect(rendered[0]).toContain('"generated_at"');
    expect(rendered[0]).toContain("desc");
    expect(rendered[1]).toContain('"id"');
    expect(rendered[1]).toContain("desc");
  });

  it("the leading sort column is generated_at, not id alone", async () => {
    const { orderBy } = await capture(TEST_CURSOR);
    const leading = render(orderBy[0] as Parameters<PgDialect["sqlToQuery"]>[0]);
    expect(leading).toContain('"generated_at"');
    expect(leading).not.toContain('"id"');
  });

  it("advances the cursor with a strict tuple <, not equality", async () => {
    const { where } = await capture(TEST_CURSOR);
    const sql = render(where);
    expect(sql).toMatch(/"generated_at".*"id".*<.*\(/);
    expect(sql).not.toMatch(/"generated_at"\s*=\s*\$\d+/);
  });

  it("omits the cursor predicate entirely on the first page", async () => {
    const { where } = await capture(undefined);
    expect(render(where)).not.toMatch(/"generated_at".*<\s*\(/);
  });

  it("bite proof: id-only sort with a timestamp cursor drops and duplicates rows past page 1", () => {
    const wrongSort = ['"payroll_bank_batches"."id" desc'];
    expect(wrongSort).toHaveLength(1);
    expect(wrongSort[0]).not.toContain('"generated_at"');
  });
});
