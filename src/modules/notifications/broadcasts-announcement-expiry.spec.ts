import type { Db } from "../../db/drizzle.module";
import { BroadcastsService } from "./broadcasts.service";

interface Chain extends Promise<unknown[]> {
  from: () => Chain;
  leftJoin: () => Chain;
  innerJoin: () => Chain;
  where: (w: unknown) => Chain;
  orderBy: () => Chain;
  limit: () => Chain;
}

interface Walked {
  values: unknown[];
  columns: string[];
}

function walk(node: unknown, seen = new Set<object>(), acc: Walked = { values: [], columns: [] }): Walked {
  if (node === null || node === undefined) return acc;
  if (typeof node === "string" || typeof node === "number" || typeof node === "boolean") {
    acc.values.push(node);
    return acc;
  }
  if (node instanceof Date) return acc;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, seen, acc);
    return acc;
  }
  if (typeof node !== "object" || seen.has(node)) return acc;
  seen.add(node);
  const shape = node as {
    name?: unknown;
    columnType?: unknown;
    queryChunks?: unknown;
    value?: unknown;
  };
  if (typeof shape.name === "string" && typeof shape.columnType === "string") {
    acc.columns.push(shape.name);
    return acc;
  }
  if (shape.queryChunks !== undefined) walk(shape.queryChunks, seen, acc);
  if (Object.prototype.hasOwnProperty.call(shape, "value")) walk(shape.value, seen, acc);
  return acc;
}

function makeService(): { svc: BroadcastsService; wheres: unknown[] } {
  const wheres: unknown[] = [];
  const chain: Chain = Object.assign(Promise.resolve([]), {
    from: () => chain,
    leftJoin: () => chain,
    innerJoin: () => chain,
    where: (w: unknown) => {
      wheres.push(w);
      return chain;
    },
    orderBy: () => chain,
    limit: () => chain,
  });
  const db = { select: () => chain } as unknown as Db;
  const cache = { cachedVersioned: jest.fn(), invalidateNamespace: jest.fn(), invalidateForOrg: jest.fn() };
  const svc = new BroadcastsService(
    db,
    cache as never,
    { log: jest.fn() } as never,
    { emit: jest.fn() } as never,
  );
  return { svc, wheres };
}

describe("expiry is a property of the unified announcement, so the Inbox honours it too", () => {
  it("filters listInboxPage on expires_at, so an expired Home announcement leaves the Inbox instead of sitting there unread", async () => {
    const { svc, wheres } = makeService();

    await svc.listInboxPage("org-a", "u-1", 20, null, 9);

    expect(walk(wheres).columns).toContain("expires_at");
  });

  it("filters listInbox on expires_at as well, because the unpaged read is the same list", async () => {
    const { svc, wheres } = makeService();

    await svc.listInbox("org-a", "u-1", 20, 9);

    expect(walk(wheres).columns).toContain("expires_at");
  });

  it("still requires SENT and still scopes to the caller's org, the positive control for the expiry filter", async () => {
    const { svc, wheres } = makeService();

    await svc.listInboxPage("org-a", "u-1", 20, null, 9);

    const walked = walk(wheres);
    expect(walked.values).toContain("SENT");
    expect(walked.values).toContain("org-a");
    expect(walked.values).not.toContain("org-b");
  });
});
