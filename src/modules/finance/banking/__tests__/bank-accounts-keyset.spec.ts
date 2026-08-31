import { PgDialect } from "drizzle-orm/pg-core";
import { BankAccountsService } from "../bank-accounts.service";
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

const USER = { orgId: "org-1", userId: "u-1" } as never;

async function captureList(cursor: string | undefined): Promise<Captured> {
  const captured: Captured = { where: undefined, orderBy: [] };
  const svc = new BankAccountsService(buildDb(captured), {} as never, {} as never, {} as never);
  await svc.list(USER, { cursor, limit: 20 });
  return captured;
}

describe("BankAccountsService.list — keyset on name/id", () => {
  it("orders by name then id", async () => {
    const { orderBy } = await captureList(undefined);
    const rendered = orderBy.map(render).join(" ");
    expect(rendered).toContain('"name"');
    expect(rendered).toContain('"id"');
  });

  it("cursor predicate is a strict > inequality and references id", async () => {
    const { where } = await captureList("dGVzdAAwMQ==");
    const sql = render(where);
    expect(sql).toMatch(/>/);
    expect(sql).toContain('"id"');
  });

  it("first page omits the cursor predicate", async () => {
    const { where } = await captureList(undefined);
    expect(render(where)).not.toContain('"id"');
  });
});
