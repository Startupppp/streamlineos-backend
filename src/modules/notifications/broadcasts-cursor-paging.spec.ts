import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { BroadcastsService } from "./broadcasts.service";
import type { Db } from "../../db/drizzle.module";
import type { CacheService } from "../../common/cache/cache.service";
import type { AuditService } from "../../common/audit/audit.service";
import type { NotificationDispatchService } from "./notification-dispatch.service";

// The cursor bounded `id` while the ORDER BY was `created_at`, so any row with a lower id than the page's last row was skipped for good.

const dialect = new PgDialect();
const ORG = "org-1";

interface StoredBroadcast {
  id: number;
  createdAt: Date;
}

class BroadcastStore {
  readonly rows: StoredBroadcast[] = [];

  /** createdAt deliberately disagrees with id order — a backdated or edited row. */
  constructor(count: number) {
    for (let i = 1; i <= count; i++) {
      const minutes = i % 2 === 0 ? count - i : i;
      this.rows.push({ id: i, createdAt: new Date(Date.UTC(2024, 0, 1, 0, minutes)) });
    }
  }

  byId(cursor: number | undefined, limit: number): StoredBroadcast[] {
    return this.rows
      .filter((r) => (cursor === undefined ? true : r.id < cursor))
      .sort((a, b) => b.id - a.id)
      .slice(0, limit);
  }
}

function cursorFromPredicate(where: SQL): number | undefined {
  const { sql: text, params } = dialect.sqlToQuery(where);
  if (!/"broadcasts"\."id"\s*<\s*\$/i.test(text)) return undefined;
  const value = params[params.length - 1];
  if (typeof value !== "number") throw new Error(`cursor parameter was ${typeof value}`);
  return value;
}

function buildHarness(store: BroadcastStore) {
  let orderBySql = "";

  const chain = (): Record<string, unknown> => {
    const link: Record<string, unknown> = {};
    let capturedCursor: number | undefined;
    link["from"] = jest.fn(() => link);
    link["where"] = jest.fn((w: SQL) => {
      capturedCursor = cursorFromPredicate(w);
      return link;
    });
    link["orderBy"] = jest.fn((o: SQL) => {
      orderBySql = dialect.sqlToQuery(o).sql;
      return link;
    });
    link["limit"] = jest.fn((n: number) => Promise.resolve(store.byId(capturedCursor, n)));
    return link;
  };

  const db = { select: jest.fn(() => chain()) } as unknown as Db;
  const cache = {
    cachedVersioned: jest.fn((_ns: string, _key: string, fn: () => Promise<unknown>) => fn()),
  } as unknown as CacheService;

  const service = new BroadcastsService(
    db,
    cache,
    {} as unknown as AuditService,
    {} as unknown as NotificationDispatchService,
  );

  return { service, orderBy: () => orderBySql };
}

async function pageThrough(harness: ReturnType<typeof buildHarness>, limit: number) {
  const ids: number[] = [];
  let cursor: number | undefined;
  for (let guard = 0; guard < 50; guard++) {
    const page = (await harness.service.list(ORG, { limit, cursor } as never)) as {
      items: StoredBroadcast[];
      nextCursor: number | null;
    };
    ids.push(...page.items.map((b) => b.id));
    if (page.nextCursor == null) return ids;
    cursor = page.nextCursor;
  }
  throw new Error("paging did not terminate");
}

describe("broadcast paging — every row exactly once", () => {
  it("orders by the same column the cursor bounds", async () => {
    const harness = buildHarness(new BroadcastStore(5));

    await harness.service.list(ORG, { limit: 10 } as never);

    expect(harness.orderBy()).toContain('"broadcasts"."id"');
    expect(harness.orderBy()).not.toContain("created_at");
  });

  it("returns every row exactly once when createdAt disagrees with id order", async () => {
    const store = new BroadcastStore(23);
    const harness = buildHarness(store);

    const ids = await pageThrough(harness, 5);

    expect([...ids].sort((a, b) => a - b)).toEqual(store.rows.map((r) => r.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("takes the next cursor from the last row it keeps, not the discarded sentinel", async () => {
    const limit = 5;
    const harness = buildHarness(new BroadcastStore(limit + 1));

    const first = (await harness.service.list(ORG, { limit } as never)) as {
      items: StoredBroadcast[];
      nextCursor: number | null;
    };

    expect(first.items).toHaveLength(limit);
    expect(first.nextCursor).toBe(Math.min(...first.items.map((b) => b.id)));
  });

  it("stops without a cursor when exactly one page remains", async () => {
    const harness = buildHarness(new BroadcastStore(5));

    const page = (await harness.service.list(ORG, { limit: 5 } as never)) as {
      nextCursor: number | null;
    };

    expect(page.nextCursor).toBeNull();
  });
});
