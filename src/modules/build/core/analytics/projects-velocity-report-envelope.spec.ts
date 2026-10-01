import { CacheService } from "../../../../common/cache/cache.service";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { AccessService } from "../../../access/access.service";
import type { Db } from "../../../../db/drizzle.types";
import { ProjectsReportsService } from "./projects-reports.service";

const ORG = "org-envelope";
const PROJECT = 99;
const CYCLE_A = 11;
const CYCLE_B = 12;

const actor: CurrentUserContext = {
  orgId: ORG,
  userId: "user-env",
  role: "OWNER",
  isOrgOwner: true,
  sessionId: "session-env",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, true),
};

function passThroughCache(): CacheService {
  return {
    cached: <T>(_key: string, fetcher: () => Promise<T>) => fetcher(),
    cachedVersioned: <T>(_ns: string, _key: string, fetcher: () => Promise<T>) => fetcher(),
  } as unknown as CacheService;
}

function unrestrictedAccess(): AccessService {
  return {
    scopeFor: async () => "all",
    holds: async () => true,
    resolveUserPermissions: async () => new Map<string, string>(),
  } as unknown as AccessService;
}

type Row = Record<string, unknown>;

function buildDb(cursorRows: Row[], statsRows: Row[]): Db {
  let selectCallCount = 0;
  return {
    query: {
      projects: {
        findFirst: async () => ({ id: PROJECT, reportRevision: 0, managerMembershipId: null }),
      },
    },
    select: () => {
      selectCallCount++;
      const rows = selectCallCount === 1 ? cursorRows : statsRows;
      const chain: Record<string, unknown> = {};
      for (const m of ["from", "leftJoin", "innerJoin", "where", "groupBy", "orderBy", "limit"])
        chain[m] = () => chain;
      chain["then"] = (
        resolve: (v: Row[]) => unknown,
        reject?: (r: unknown) => unknown,
      ) => Promise.resolve(rows).then(resolve, reject);
      return chain;
    },
  } as unknown as Db;
}

describe("33 — velocity service returns the standard cursor envelope", () => {
  it("returns data array and pagination object when cycles exist — positive: envelope shape matches BE-25", async () => {
    const cursorRows = [
      { id: CYCLE_A, name: "C-A", startDate: "2026-09-01", endDate: "2026-09-14", cursorStartDate: "2026-09-01 00:00:00" },
      { id: CYCLE_B, name: "C-B", startDate: "2026-08-01", endDate: "2026-08-14", cursorStartDate: "2026-08-01 00:00:00" },
    ];
    const statsRows = [
      { cycleId: CYCLE_A, committedCount: 3, committedPoints: 10, completedCount: 2, completedPoints: 7 },
      { cycleId: CYCLE_B, committedCount: 2, committedPoints: 6, completedCount: 2, completedPoints: 6 },
    ];
    const svc = new ProjectsReportsService(buildDb(cursorRows, statsRows), passThroughCache(), unrestrictedAccess());

    const result = await svc.velocity(actor, PROJECT, { limit: 10 });

    expect(result).toHaveProperty("data");
    expect(result).toHaveProperty("pagination");
    expect(Array.isArray(result.data)).toBe(true);
    expect(result.data).toHaveLength(2);
    expect(result.pagination.hasMore).toBe(false);
    expect(result.pagination.nextCursor).toBeNull();
    expect(result.pagination.limit).toBe(10);
  });

  it("sets hasMore and nextCursor when a second page exists — positive: getNextPageParam can advance the cursor", async () => {
    const limitPlusOne = [
      { id: CYCLE_A, name: "C-A", startDate: "2026-09-01", endDate: "2026-09-14", cursorStartDate: "2026-09-01 00:00:00" },
      { id: CYCLE_B, name: "C-B", startDate: "2026-08-01", endDate: "2026-08-14", cursorStartDate: "2026-08-01 00:00:00" },
    ];
    const svc = new ProjectsReportsService(buildDb(limitPlusOne, []), passThroughCache(), unrestrictedAccess());

    const result = await svc.velocity(actor, PROJECT, { limit: 1 });

    expect(result.pagination.hasMore).toBe(true);
    expect(typeof result.pagination.nextCursor).toBe("string");
    expect(result.data).toHaveLength(1);
  });

  it("returns empty data array and hasMore false when the project has no cycles — negative: empty page is not null", async () => {
    const svc = new ProjectsReportsService(buildDb([], []), passThroughCache(), unrestrictedAccess());

    const result = await svc.velocity(actor, PROJECT, { limit: 10 });

    expect(result.data).toHaveLength(0);
    expect(result.pagination.hasMore).toBe(false);
    expect(result.pagination.nextCursor).toBeNull();
  });
});
