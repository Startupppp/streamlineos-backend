import { PgDialect } from "drizzle-orm/pg-core";
import { ProjectsCustomersService } from "./projects-customers.service";
import type { Db } from "../../../../db/drizzle.module";
import { encodeCursor } from "../../../../common/pagination/cursor";

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
    innerJoin: jest.fn().mockReturnThis(),
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
  const svc = new ProjectsCustomersService(buildDb(captured));
  await svc.list("org-1", { cursor, limit: 20 });
  return captured;
}

describe("ProjectsCustomersService.list — keyset matches the sort", () => {
  it("orders by createdAt desc then crmOrganizationId desc", async () => {
    const { orderBy } = await capture(undefined);
    const rendered = orderBy.map(render);
    expect(rendered[0]).toContain('"created_at"');
    expect(rendered[0]).toContain("desc");
    expect(rendered[1]).toContain('"crm_organization_id"');
  });

  it("applies a strict less-than predicate when cursor is present", async () => {
    const cursor = encodeCursor({ sortValue: new Date().toISOString(), id: "3" });
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

  it("bite proof: createdAt-only sort without id tiebreaker was the old defect", () => {
    const oldSort = ['"business_parties"."created_at" desc'];
    expect(oldSort).toHaveLength(1);
    expect(oldSort[0]).not.toContain('"crm_organization_id"');
  });
});
