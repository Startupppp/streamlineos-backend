import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { AccountOrganizationIndexService } from "./account-organization-index.service";
import type { Db } from "../../../db/drizzle.types";
import { clearRegionRegistry } from "../../../common/region/region-registry";

const dialect = new PgDialect();

function makeSelectChain<T>(result: T[]) {
  const chain = {} as Record<string, jest.Mock> & PromiseLike<T[]>;
  chain.from = jest.fn().mockReturnValue(chain);
  chain.where = jest.fn().mockReturnValue(chain);
  chain.innerJoin = jest.fn().mockReturnValue(chain);
  chain.orderBy = jest.fn().mockReturnValue(chain);
  chain.limit = jest.fn().mockResolvedValue(result);
  chain.then = jest.fn().mockImplementation(
    (resolve: (v: T[]) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  );
  return chain;
}

function makeInsertChain() {
  const chain: Record<string, jest.Mock> = {
    values: jest.fn(),
    onConflictDoUpdate: jest.fn().mockResolvedValue(undefined),
  };
  chain.values.mockReturnValue(chain);
  return chain;
}

function makeDeleteChain() {
  return { where: jest.fn().mockResolvedValue(undefined) };
}

interface TxDouble {
  execute: jest.Mock;
  select: jest.Mock;
  insert: jest.Mock;
  delete: jest.Mock;
}

/**
 * The projection is RLS-protected by
 * `org_id = app.current_org_id_or_null() OR user_id = app.current_user_id_or_null()`,
 * and this path has no organisation context. So the tenant GUC only exists
 * inside the transaction `withIdentity` opens: a write issued on the pool
 * instead dies 42501, and a read silently returns nothing. These doubles put
 * every capability on the `tx` and none on the `db`, so a regression back onto
 * the pool fails rather than passing quietly.
 */
function makeDb(selectResults: unknown[][]): {
  db: Db;
  tx: TxDouble;
  poolSelect: jest.Mock;
  poolInsert: jest.Mock;
  poolDelete: jest.Mock;
  gucs: string[];
} {
  const gucs: string[] = [];
  let call = 0;

  const tx: TxDouble = {
    execute: jest.fn().mockImplementation((query: SQL) => {
      // String() on a Drizzle SQL object yields "[object Object]".
      const rendered = dialect.sqlToQuery(query);
      gucs.push(`${rendered.sql} ${rendered.params.join(" ")}`);
      return Promise.resolve([]);
    }),
    select: jest
      .fn()
      .mockImplementation(() => makeSelectChain(selectResults[call++] ?? [])),
    insert: jest.fn().mockReturnValue(makeInsertChain()),
    delete: jest.fn().mockReturnValue(makeDeleteChain()),
  };

  const poolSelect = jest.fn().mockImplementation(() => {
    throw new Error("read the projection on the pool: no tenant GUC, returns nothing");
  });
  const poolInsert = jest.fn().mockImplementation(() => {
    throw new Error("wrote the projection on the pool: no tenant GUC, dies 42501");
  });
  const poolDelete = jest.fn().mockImplementation(() => {
    throw new Error("deleted from the projection on the pool: no tenant GUC, dies 42501");
  });

  const db = {
    transaction: jest
      .fn()
      .mockImplementation((fn: (t: unknown) => Promise<unknown>) => fn(tx)),
    select: poolSelect,
    insert: poolInsert,
    delete: poolDelete,
  } as unknown as Db;

  return { db, tx, poolSelect, poolInsert, poolDelete, gucs };
}

const LIVE_ROW = {
  orgId: "org-1",
  organizationName: "Acme",
  organizationSlug: "acme",
  membershipRole: "MEMBER",
  membershipStatus: "ACTIVE",
  organizationStatus: "ACTIVE",
  joinedAt: new Date("2024-01-01"),
  region: null,
};

describe("AccountOrganizationIndexService.listForUser", () => {
  afterEach(() => clearRegionRegistry());

  it("returns projection rows for an active user", async () => {
    const rows = [
      { id: "org-1", name: "Acme", slug: "acme", role: "MEMBER", joinedAt: new Date() },
    ];
    const { db, tx } = makeDb([rows]);

    await expect(
      new AccountOrganizationIndexService(db).listForUser("user-1"),
    ).resolves.toEqual(rows);

    expect(tx.select).toHaveBeenCalledTimes(1);
  });

  it("reads inside the identity transaction, because a pool read returns nothing under RLS", async () => {
    const { db, tx, poolSelect, gucs } = makeDb([[]]);

    await new AccountOrganizationIndexService(db).listForUser("user-1");

    expect(poolSelect).not.toHaveBeenCalled();
    expect(tx.select).toHaveBeenCalled();
    expect(gucs.join(" ")).toContain("app.user_id");
  });

  it("returns an empty array when the index has no rows for that user", async () => {
    const { db } = makeDb([[]]);

    await expect(
      new AccountOrganizationIndexService(db).listForUser("user-nobody"),
    ).resolves.toEqual([]);
  });
});

describe("AccountOrganizationIndexService.refreshForUser", () => {
  afterEach(() => clearRegionRegistry());

  it("upserts current memberships and removes stale index rows", async () => {
    const { db, tx } = makeDb([[LIVE_ROW]]);

    await new AccountOrganizationIndexService(db).refreshForUser("user-1");

    expect(tx.insert).toHaveBeenCalledTimes(1);
    expect(tx.delete).toHaveBeenCalledTimes(1);
  });

  it("writes inside the identity transaction, because a pool write dies 42501 under RLS", async () => {
    const { db, tx, poolInsert, poolDelete, gucs } = makeDb([[LIVE_ROW]]);

    await new AccountOrganizationIndexService(db).refreshForUser("user-1");

    expect(poolInsert).not.toHaveBeenCalled();
    expect(poolDelete).not.toHaveBeenCalled();
    expect(tx.insert).toHaveBeenCalled();
    expect(gucs.join(" ")).toContain("app.user_id");
  });

  it("deletes all index rows when the user has no live memberships", async () => {
    const { db, tx } = makeDb([[]]);

    await new AccountOrganizationIndexService(db).refreshForUser("user-gone");

    expect(tx.insert).not.toHaveBeenCalled();
    expect(tx.delete).toHaveBeenCalledTimes(1);
  });
});

describe("AccountOrganizationIndexService.rebuild", () => {
  afterEach(() => clearRegionRegistry());

  const MEMBER_ROW = {
    userId: "user-1",
    membershipRole: "MEMBER",
    membershipStatus: "ACTIVE",
    organizationStatus: "ACTIVE",
    joinedAt: new Date("2024-01-01"),
    organizationName: "Acme",
    organizationSlug: "acme",
    region: null,
  };

  it("iterates all orgs and upserts index rows per org", async () => {
    const { db, tx } = makeDb([[MEMBER_ROW]]);
    // forEachOrg enumerates organizations on the pool, which carries no policy.
    Reflect.set(db, "select", jest.fn().mockReturnValue(makeSelectChain([{ id: "org-1" }])));

    const result = await new AccountOrganizationIndexService(db).rebuild();

    expect(result.organizations).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);
    expect(tx.insert).toHaveBeenCalled();
  });

  it("writes each org's rows inside that org's tenant transaction", async () => {
    const { db, tx, poolInsert } = makeDb([[MEMBER_ROW]]);
    Reflect.set(db, "select", jest.fn().mockReturnValue(makeSelectChain([{ id: "org-1" }])));

    await new AccountOrganizationIndexService(db).rebuild();

    expect(poolInsert).not.toHaveBeenCalled();
    expect(tx.insert).toHaveBeenCalled();
  });

  it("returns a zero count when no orgs exist", async () => {
    const { db, tx } = makeDb([]);
    Reflect.set(db, "select", jest.fn().mockReturnValue(makeSelectChain([])));

    const result = await new AccountOrganizationIndexService(db).rebuild();

    expect(result.organizations).toBe(0);
    expect(tx.insert).not.toHaveBeenCalled();
  });
});
