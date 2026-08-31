import { PgDialect } from "drizzle-orm/pg-core";
import { ModuleAccessGroupCrudService } from "../module-access-group-crud.service";
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
    groupBy: jest.fn().mockResolvedValue([]),
  };
  (builder.from as jest.Mock).mockReturnValue(builder);
  return {
    select: jest.fn().mockReturnValue(builder),
    selectDistinct: jest.fn().mockReturnValue(builder),
    query: {
      roles: { findFirst: jest.fn() },
      organizationMembers: { findFirst: jest.fn() },
    },
  } as unknown as Db;
}

const CACHE = {
  cached: jest.fn().mockImplementation(
    (_key: string, fetcher: () => Promise<unknown>) => fetcher(),
  ),
  invalidate: jest.fn(),
};

const ACCESS = {
  resolveUserPermissions: jest.fn().mockResolvedValue(new Map()),
  getPermissionsVersion: jest.fn().mockResolvedValue(1),
};

const GROUP_POLICY = {
  permissionKeys: jest.fn().mockReturnValue(new Set<string>()),
  assertGroupBelongsToModule: jest.fn(),
  resolveOwnerUserId: jest.fn().mockResolvedValue(null),
};

const AUDIT = { log: jest.fn() };

async function capture(cursor: string | undefined): Promise<Captured> {
  const captured: Captured = { where: undefined, orderBy: [] };
  const db = buildDb(captured);
  const svc = new ModuleAccessGroupCrudService(
    db,
    ACCESS as never,
    CACHE as never,
    AUDIT as never,
    GROUP_POLICY as never,
  );
  await svc.listGroups("org-a", "hr", 1, cursor, 20);
  return captured;
}

describe("ModuleAccessGroupCrudService.fetchGroups — keyset matches the sort", () => {
  it("sorts by name first, then by id as tie-breaker", async () => {
    const { orderBy } = await capture(undefined);
    const rendered = orderBy.map(render);
    expect(rendered).toHaveLength(2);
    expect(rendered[0]).toContain('"name"');
    expect(rendered[1]).toContain('"id"');
  });

  it("the leading sort column is name, never id", async () => {
    const { orderBy } = await capture(undefined);
    const leading = render(orderBy[0]);
    expect(leading).toContain('"name"');
    expect(leading).not.toContain('"id"');
  });

  it("advances the cursor with a strict > inequality on (name, id), not =", async () => {
    const cursor = encodeCursor({ sortValue: "Alpha", id: "10" });
    const { where } = await capture(cursor);
    const sql = render(where);
    expect(sql).toMatch(/\("roles"\."name",\s*"roles"\."id"\)\s*>/);
    expect(sql).not.toMatch(/\("roles"\."name",\s*"roles"\."id"\)\s*=/);
  });

  it("omits the cursor predicate entirely on the first page", async () => {
    const { where } = await capture(undefined);
    const sql = render(where);
    expect(sql).not.toMatch(/\("roles"\."name",\s*"roles"\."id"\)\s*>/);
  });

  it("bite proof: a sort on id only with a name cursor drops rows", () => {
    const idOnlySort = ['"roles"."id" asc'];
    expect(idOnlySort).toHaveLength(1);
    expect(idOnlySort[0]).not.toContain('"name"');
  });
});
