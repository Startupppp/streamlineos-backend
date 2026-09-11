process.env.APP_URL ??= "http://localhost:1000";

import { LeadsBoardService } from "../leads-board.service";
import * as applyScopeMod from "../../access/apply-scope";
import { ScopedRead } from "../../access/scoped-read";
import { CACHE_TTL } from "../../../common/cache/cache-keys";

/**
 * Leads are read from `lead_party_map` joined to `business_parties` now, so every
 * builder below starts `.from(...).innerJoin(...)`. The join returns the same
 * step object, which keeps these mocks about what they were always about — which
 * scope reaches `applyScope` — rather than about the shape of the query.
 */
function withJoins<T extends object>(step: T): T {
  return Object.assign(step, {
    innerJoin: jest.fn().mockImplementation(() => step),
    leftJoin: jest.fn().mockImplementation(() => step),
  });
}

/**
 * One query per status, not two. `getBoard` selects the rows and their
 * `count(*) OVER ()` together and reads the total off the first row, so `where`
 * must always answer the same `.orderBy().limit()` chain. The previous double
 * alternated a rows-shape and a count-shape on `callN % 2`, which broke twice
 * over: the second query no longer exists, and the per-status queries run inside
 * `Promise.all`, so nothing orders the calls anyway.
 */
function buildDb(rows: Array<Record<string, unknown>> = []) {
  return {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue(
        withJoins({
          where: jest.fn().mockReturnValue({
            orderBy: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue(rows),
            }),
          }),
        }),
      ),
    }),
  };
}

function buildCache(statusKeys: string[] = ["NEW"]) {
  return {
    cached: jest.fn().mockImplementation(
      async (key: string, fn: () => Promise<unknown>, _ttl?: typeof CACHE_TTL.MEDIUM) => {
        if (key.includes("status-keys")) return statusKeys;
        return fn();
      },
    ),
    cachedVersioned: jest.fn().mockImplementation(
      async (namespace: string, key: string, fn: () => Promise<unknown>) => {
        if (key === "status-keys") return statusKeys;
        return fn();
      },
    ),
  };
}

describe("LeadsBoardService.getBoard — DataScope routing (no branch filter)", () => {
  const ORG = "org-1";
  const USER = "user-1";

  let applyScopeSpy: jest.SpyInstance;

  beforeEach(() => {
    applyScopeSpy = jest.spyOn(applyScopeMod, "applyScope");
  });

  afterEach(() => {
    applyScopeSpy.mockRestore();
  });

  it("calls applyScope with scope=own and the caller userId when board is requested", async () => {
    const db = buildDb();
    const cache = buildCache(["NEW"]);
    const svc = new LeadsBoardService(db as never, cache as never);

    await svc.getBoard(ORG, { read: ScopedRead.of(ORG, USER, "own") });

    expect(applyScopeSpy).toHaveBeenCalledWith(
      "own",
      ORG,
      USER,
      expect.objectContaining({ ownerColumn: expect.anything() }),
    );
  });

  it("calls applyScope with scope=all and the caller userId", async () => {
    const db = buildDb();
    const cache = buildCache(["NEW"]);
    const svc = new LeadsBoardService(db as never, cache as never);

    await svc.getBoard(ORG, { read: ScopedRead.of(ORG, USER, "all") });

    expect(applyScopeSpy).toHaveBeenCalledWith(
      "all",
      ORG,
      USER,
      expect.objectContaining({ ownerColumn: expect.anything() }),
    );
  });

  it("cannot be asked for an unscoped board — the read is a required field", async () => {
    const db = buildDb();
    const cache = buildCache(["NEW"]);
    const svc = new LeadsBoardService(db as never, cache as never);

    await svc.getBoard(ORG, { read: ScopedRead.of(ORG, USER, "own") });

    expect(applyScopeSpy).toHaveBeenCalled();
    expect(db.select).toHaveBeenCalled();
  });

  it("queries nothing at all when scope=none", async () => {
    const db = buildDb();
    const cache = buildCache(["NEW"]);
    const svc = new LeadsBoardService(db as never, cache as never);

    await svc.getBoard(ORG, { read: ScopedRead.of(ORG, USER, "none") });

    expect(applyScopeSpy).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
  });

  it("returns a board keyed by status", async () => {
    const db = buildDb();
    const cache = buildCache(["NEW", "OPEN"]);
    const svc = new LeadsBoardService(db as never, cache as never);

    const result = await svc.getBoard(ORG, { read: ScopedRead.of(ORG, USER, "all") });

    expect(result).toMatchObject({
      NEW: expect.objectContaining({ leads: [], total: 0 }),
      OPEN: expect.objectContaining({ leads: [], total: 0 }),
    });
  });

  it("takes the per-status total from the windowed count and keeps it off the lead", async () => {
    // `_total` deliberately exceeds the row count: `limit` caps the page while
    // `count(*) OVER ()` reports the whole status. Were the total read from
    // `rows.length` instead, this would be 2 and the assertion would catch it.
    const db = buildDb([
      { id: "lead-1", status: "NEW", assignedToId: null, _total: "7" },
      { id: "lead-2", status: "NEW", assignedToId: null, _total: "7" },
    ]);
    const cache = buildCache(["NEW"]);
    const svc = new LeadsBoardService(db as never, cache as never);

    const result = await svc.getBoard(ORG, { read: ScopedRead.of(ORG, USER, "all") });

    expect(result.NEW?.total).toBe(7);
    expect(result.NEW?.leads).toHaveLength(2);
    expect(result.NEW?.leads[0]).not.toHaveProperty("_total");
  });
});

describe("LeadsBoardService.getStats — DataScope routing (no branch filter)", () => {
  const ORG = "org-1";
  const USER = "user-1";

  let applyScopeSpy: jest.SpyInstance;

  function buildStatsDb() {
    const whereResult = Object.assign(Promise.resolve([]), {
      groupBy: jest.fn().mockResolvedValue([]),
    });
    return {
      select: jest.fn().mockReturnValue({
        from: jest
          .fn()
          .mockReturnValue(withJoins({ where: jest.fn().mockReturnValue(whereResult) })),
      }),
    };
  }

  beforeEach(() => {
    applyScopeSpy = jest.spyOn(applyScopeMod, "applyScope");
  });

  afterEach(() => {
    applyScopeSpy.mockRestore();
  });

  it("calls applyScope with scope=own when getStats is called with own scope", async () => {
    const db = buildStatsDb();
    const cache = buildCache();
    const svc = new LeadsBoardService(db as never, cache as never);

    await svc.getStats(ORG, { read: ScopedRead.of(ORG, USER, "own") });

    expect(applyScopeSpy).toHaveBeenCalledWith(
      "own",
      ORG,
      USER,
      expect.objectContaining({ ownerColumn: expect.anything() }),
    );
  });

  it("calls applyScope with scope=all when getStats is called with all scope", async () => {
    const db = buildStatsDb();
    const cache = buildCache();
    const svc = new LeadsBoardService(db as never, cache as never);

    await svc.getStats(ORG, { read: ScopedRead.of(ORG, USER, "all") });

    expect(applyScopeSpy).toHaveBeenCalledWith(
      "all",
      ORG,
      USER,
      expect.objectContaining({ ownerColumn: expect.anything() }),
    );
  });

  it("queries nothing at all when getStats is called with scope=none", async () => {
    const db = buildStatsDb();
    const cache = buildCache();
    const svc = new LeadsBoardService(db as never, cache as never);

    const result = await svc.getStats(ORG, { read: ScopedRead.of(ORG, USER, "none") });

    expect(applyScopeSpy).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
    expect(result.total).toBe(0);
  });
});
