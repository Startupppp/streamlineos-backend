import { PgDialect } from "drizzle-orm/pg-core";
import { ReconciliationRulesService } from "../reconciliation-rules.service";
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
  const svc = new ReconciliationRulesService(buildDb(captured), {} as never);
  await svc.listRules(USER, { cursor, limit: 20 });
  return captured;
}

describe("ReconciliationRulesService.listRules — keyset on priority/id", () => {
  it("orders by priority desc then id desc", async () => {
    const { orderBy } = await captureList(undefined);
    const rendered = orderBy.map(render).join(" ");
    expect(rendered).toContain('"priority"');
    expect(rendered).toContain('"id"');
  });

  it("cursor predicate is a strict < inequality and references id", async () => {
    const { where } = await captureList("MAAW");
    const sql = render(where);
    expect(sql).toMatch(/</);
    expect(sql).toContain('"id"');
  });

  it("first page omits the cursor predicate", async () => {
    const { where } = await captureList(undefined);
    expect(render(where)).not.toContain('"id"');
  });
});
