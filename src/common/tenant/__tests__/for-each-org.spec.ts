import type { SQL } from "drizzle-orm";
import { forEachOrg } from "../for-each-org";
import { getTenantContext } from "../tenant-context";
import type { Db } from "../../../db/drizzle.module";

interface ChainCapture {
  where?: SQL;
}

function collectColumnNames(value: unknown, found: Set<string>): void {
  if (value === null || typeof value !== "object") return;
  if ("name" in value && typeof (value as { name: unknown }).name === "string") {
    found.add((value as { name: string }).name);
  }
  if ("queryChunks" in value && Array.isArray((value as { queryChunks: unknown[] }).queryChunks)) {
    for (const chunk of (value as { queryChunks: unknown[] }).queryChunks) {
      collectColumnNames(chunk, found);
    }
  }
}

function makeMockDb(orgIds: string[]): { db: Db; capture: ChainCapture; execute: jest.Mock } {
  const capture: ChainCapture = {};
  const execute = jest.fn();
  const rows = orgIds.map((id) => ({ id }));

  interface SelectChain {
    from: jest.Mock<SelectChain, []>;
    where: jest.Mock<SelectChain, [SQL]>;
    orderBy: jest.Mock<Promise<{ id: string }[]>, []>;
  }

  const chain: SelectChain = {
    from: jest.fn((): SelectChain => chain),
    where: jest.fn((condition: SQL): SelectChain => {
      capture.where = condition;
      return chain;
    }),
    orderBy: jest.fn(() => Promise.resolve(rows)),
  };

  const db = {
    select: jest.fn(() => chain),
    transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) => fn({ execute })),
  };

  return { db: db as unknown as Db, capture, execute };
}

describe("forEachOrg", () => {
  it("only enumerates organizations that are ACTIVE and not soft-deleted", async () => {
    const { db, capture } = makeMockDb([]);

    await forEachOrg(db, "test-sweep", jest.fn());

    const columns = new Set<string>();
    collectColumnNames(capture.where, columns);
    expect(columns).toContain("status");
    expect(columns).toContain("deleted_at");
  });

  it("runs the callback once per organization with that organization's id", async () => {
    const { db } = makeMockDb(["org-a", "org-b", "org-c"]);
    const seen: string[] = [];

    const result = await forEachOrg(db, "test-sweep", async (_tx, orgId) => {
      seen.push(orgId);
    });

    expect(seen).toEqual(["org-a", "org-b", "org-c"]);
    expect(result).toEqual({ organizations: 3, succeeded: 3, failed: 0 });
  });

  it("sets the tenant GUC for each organization", async () => {
    const { db, execute } = makeMockDb(["org-a", "org-b"]);

    await forEachOrg(db, "test-sweep", jest.fn());

    expect(execute).toHaveBeenCalledTimes(2);
    const orgIds = new Set<string>();
    function collectNestedStrings(value: unknown): void {
      if (typeof value === "string") { orgIds.add(value); return; }
      if (!value || typeof value !== "object") return;
      const obj = value as Record<string, unknown>;
      if ("queryChunks" in obj && Array.isArray(obj.queryChunks))
        for (const c of obj.queryChunks as unknown[]) collectNestedStrings(c);
    }
    for (const call of execute.mock.calls) collectNestedStrings(call[0]);
    expect(orgIds).toContain("org-a");
    expect(orgIds).toContain("org-b");
  });

  it("exposes the ambient tenant context so nested services resolve to the transaction", async () => {
    const { db } = makeMockDb(["org-a"]);
    let observed: string | undefined;

    await forEachOrg(db, "test-sweep", async () => {
      observed = getTenantContext()?.orgId;
    });

    expect(observed).toBe("org-a");
  });

  it("isolates a failing organization and continues the sweep", async () => {
    const { db } = makeMockDb(["org-a", "org-b", "org-c"]);
    const seen: string[] = [];

    const result = await forEachOrg(db, "test-sweep", async (_tx, orgId) => {
      seen.push(orgId);
      if (orgId === "org-b") throw new Error("boom");
    });

    expect(seen).toEqual(["org-a", "org-b", "org-c"]);
    expect(result).toEqual({ organizations: 3, succeeded: 2, failed: 1 });
  });

  it("leaves no tenant context behind once the sweep finishes", async () => {
    const { db } = makeMockDb(["org-a"]);

    await forEachOrg(db, "test-sweep", jest.fn());

    expect(getTenantContext()).toBeUndefined();
  });
});
