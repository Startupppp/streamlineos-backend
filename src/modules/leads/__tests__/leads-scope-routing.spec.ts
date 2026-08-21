process.env.APP_URL ??= "http://localhost:1000";

import { LeadsBoardService } from "../leads-board.service";
import * as applyScopeMod from "../../access/apply-scope";
import { CACHE_TTL } from "../../../common/cache/cache-keys";

function buildDb() {
  const leadsRow = Object.assign(Promise.resolve([]), {
    orderBy: jest.fn().mockReturnValue({
      limit: jest.fn().mockResolvedValue([]),
    }),
  });

  const countRow = Promise.resolve([{ total: 0 }]);

  let callN = 0;
  return {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockImplementation(() => {
          return callN++ % 2 === 0 ? leadsRow : countRow;
        }),
        orderBy: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue([]),
        }),
      }),
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

    await svc.getBoard(ORG, { scope: "own", userId: USER });

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

    await svc.getBoard(ORG, { scope: "all", userId: USER });

    expect(applyScopeSpy).toHaveBeenCalledWith(
      "all",
      ORG,
      USER,
      expect.objectContaining({ ownerColumn: expect.anything() }),
    );
  });

  it("does not call applyScope when no scope is provided", async () => {
    const db = buildDb();
    const cache = buildCache(["NEW"]);
    const svc = new LeadsBoardService(db as never, cache as never);

    await svc.getBoard(ORG, {});

    expect(applyScopeSpy).not.toHaveBeenCalled();
  });

  it("does not call applyScope when scope=none (pushLeadsViewScope short-circuits to sql false)", async () => {
    const db = buildDb();
    const cache = buildCache(["NEW"]);
    const svc = new LeadsBoardService(db as never, cache as never);

    await svc.getBoard(ORG, { scope: "none", userId: USER });

    expect(applyScopeSpy).not.toHaveBeenCalled();
  });

  it("returns a board keyed by status", async () => {
    const db = buildDb();
    const cache = buildCache(["NEW", "OPEN"]);
    const svc = new LeadsBoardService(db as never, cache as never);

    const result = await svc.getBoard(ORG, { scope: "all", userId: USER });

    expect(result).toMatchObject({
      NEW: expect.objectContaining({ leads: [], total: 0 }),
      OPEN: expect.objectContaining({ leads: [], total: 0 }),
    });
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
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue(whereResult),
        }),
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

    await svc.getStats(ORG, { scope: "own", userId: USER });

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

    await svc.getStats(ORG, { scope: "all", userId: USER });

    expect(applyScopeSpy).toHaveBeenCalledWith(
      "all",
      ORG,
      USER,
      expect.objectContaining({ ownerColumn: expect.anything() }),
    );
  });

  it("does not call applyScope when no scope provided to getStats", async () => {
    const db = buildStatsDb();
    const cache = buildCache();
    const svc = new LeadsBoardService(db as never, cache as never);

    await svc.getStats(ORG, {});

    expect(applyScopeSpy).not.toHaveBeenCalled();
  });
});
