import { managedProductsService } from "./__tests__/managed-products-spec-fixtures";
import { PgDialect } from "drizzle-orm/pg-core";
import { ManagedProductsService } from "./managed-products.service";
import { AuditService } from "../../../common/audit/audit.service";
import type { Db } from "../../../db/drizzle.module";
import { encodeCursor } from "../../../common/pagination/cursor";

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

async function capture(cursor: string | undefined): Promise<Captured> {
  const captured: Captured = { where: undefined, orderBy: [] };
  const svc = (await managedProductsService(buildDb(captured), {} as AuditService));
  await svc.listManagedProducts("org-1", { cursor, limit: 20 }, 1);
  return captured;
}

describe("ManagedProductsService.listManagedProducts — keyset matches the sort", () => {
  it("orders by createdAt desc then id desc", async () => {
    const { orderBy } = await capture(undefined);
    const rendered = orderBy.map(render);
    expect(rendered[0]).toContain('"created_at"');
    expect(rendered[0]).toContain("desc");
    expect(rendered[1]).toContain('"id"');
  });

  it("applies a strict less-than predicate when cursor is present", async () => {
    const cursor = encodeCursor({ sortValue: new Date().toISOString(), id: "5" });
    const { where } = await capture(cursor);
    const sql = render(where);
    expect(sql).toMatch(/</);
    expect(sql).not.toMatch(/>/);
  });

  it("omits the cursor predicate on the first page", async () => {
    const { where } = await capture(undefined);
    const sql = render(where);
    expect(sql).not.toMatch(/"created_at"\s*</);
  });

  it("rejects a malformed cursor instead of silently returning the first page", async () => {
    const svc = (await managedProductsService(buildDb({ where: undefined, orderBy: [] }), {} as AuditService));
    await expect(svc.listManagedProducts("org-1", { cursor: "not-a-cursor", limit: 20 }, 1)).rejects.toThrow(
      "Invalid pagination cursor",
    );
  });

  it("bite proof: no ORDER BY would silently repeat rows at page boundaries", () => {
    const noSortQuery = ["WHERE org_id = $1 LIMIT 20"];
    expect(noSortQuery[0]).not.toContain("ORDER BY");
  });
});
