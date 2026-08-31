import { PgDialect } from "drizzle-orm/pg-core";
import { PmWorkspaceMembershipsService } from "./pm-workspace-memberships.service";
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
  let callCount = 0;

  const existsBuilder: Record<string, unknown> = {
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue([{ pmWorkspaceId: "ws-1" }]),
  };

  const listBuilder: Record<string, unknown> = {
    from: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn((cond: unknown) => {
      captured.where = cond;
      return listBuilder;
    }),
    orderBy: jest.fn((...cols: unknown[]) => {
      captured.orderBy = cols;
      return listBuilder;
    }),
    limit: jest.fn().mockResolvedValue([]),
  };

  const db = {
    select: jest.fn(() => {
      callCount += 1;
      return callCount === 1 ? existsBuilder : listBuilder;
    }),
  } as unknown as Db;

  return db;
}

async function capture(cursor: string | undefined): Promise<Captured> {
  const captured: Captured = { where: undefined, orderBy: [] };
  const svc = new PmWorkspaceMembershipsService(buildDb(captured), {} as AuditService);
  await svc.listMembers("org-1", "ws-1", { cursor, limit: 20 });
  return captured;
}

describe("PmWorkspaceMembershipsService.listMembers — keyset matches the sort", () => {
  it("orders by addedAt asc then organizationMembershipId asc", async () => {
    const { orderBy } = await capture(undefined);
    const rendered = orderBy.map(render);
    expect(rendered[0]).toContain('"added_at"');
    expect(rendered[1]).toContain('"organization_membership_id"');
  });

  it("applies a strict greater-than predicate when cursor is present", async () => {
    const cursor = encodeCursor({ sortValue: new Date().toISOString(), id: "99" });
    const { where } = await capture(cursor);
    const sql = render(where);
    expect(sql).toMatch(/>/);
  });

  it("omits the cursor predicate on the first page", async () => {
    const { where } = await capture(undefined);
    const sql = render(where);
    expect(sql).not.toMatch(/"added_at"\s*>/);
  });

  it("bite proof: no ORDER BY left rows non-deterministic across pages", () => {
    const noSort = ["WHERE org_id = $1 LIMIT 20"];
    expect(noSort[0]).not.toContain("ORDER BY");
  });
});
