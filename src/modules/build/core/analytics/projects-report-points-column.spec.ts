import { Column, SQL, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { CacheService } from "../../../../common/cache/cache.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import { formatDateOnly } from "../../../../common/date";
import type { AccessService } from "../../../access/access.service";
import type { Db } from "../../../../db/drizzle.types";
import { ProjectsAnalyticsService } from "./projects-analytics.service";
import { ProjectsReportsService } from "./projects-reports.service";
import { computeCriticalPath } from "./projects-critical-path.util";

const dialect = new PgDialect();
const ORG = "org-points";
const PROJECT = 7;
const CYCLE = 3;

type Row = Record<string, unknown>;
type Selection = Record<string, unknown>;

const owner: CurrentUserContext = {
  orgId: ORG,
  userId: "user-owner",
  role: "OWNER",
  isOrgOwner: true,
  sessionId: "session",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, true),
};

function rendered(field: unknown): string {
  if (field instanceof SQL) return dialect.sqlToQuery(field).sql;
  if (field instanceof Column) return dialect.sqlToQuery(sql`${field}`).sql;
  throw new Error("selection entry is neither a SQL expression nor a column");
}

function fieldNamed(selections: readonly Selection[], name: string): unknown {
  const matches = selections.filter((selection) => name in selection);
  if (matches.length === 0) throw new Error(`no selection projected ${name}`);
  return matches[0]?.[name];
}

interface Harness {
  db: Db;
  selections: Selection[];
  executed: SQL[];
  inserted: Row[][];
}

function harness(rowsByKey: Record<string, Row[]>, executeRows: Row[] = []): Harness {
  const selections: Selection[] = [];
  const executed: SQL[] = [];
  const inserted: Row[][] = [];

  const chainFor = (rows: Row[]): Record<string, unknown> => {
    const chain: Record<string, unknown> = {};
    for (const method of ["from", "leftJoin", "innerJoin", "where", "groupBy", "orderBy", "limit"])
      chain[method] = () => chain;
    chain["then"] = (
      resolve: (value: Row[]) => unknown,
      reject?: (reason: unknown) => unknown,
    ) => Promise.resolve(rows).then(resolve, reject);
    return chain;
  };

  const db = {
    query: {
      projects: {
        findFirst: async () => ({ id: PROJECT, reportRevision: 0, managerMembershipId: null }),
      },
      cycles: {
        findFirst: async () => ({ id: CYCLE, startDate: "2026-09-01", endDate: "2026-09-02" }),
      },
    },
    select: (selection: Selection) => {
      selections.push(selection);
      const key = Object.keys(rowsByKey).find((name) => name in selection);
      return chainFor(key === undefined ? [] : (rowsByKey[key] ?? []));
    },
    execute: async (statement: SQL) => {
      executed.push(statement);
      return executeRows;
    },
    insert: () => ({
      values: (values: Row[]) => {
        inserted.push(values);
        return { onConflictDoUpdate: async () => [] };
      },
    }),
  } as unknown as Db;

  return { db, selections, executed, inserted };
}

function passThroughCache(): CacheService {
  return {
    cached: <T>(_key: string, fetcher: () => Promise<T>) => fetcher(),
    cachedVersioned: <T>(_namespace: string, _key: string, fetcher: () => Promise<T>) => fetcher(),
  } as unknown as CacheService;
}

function unrestrictedAccess(): AccessService {
  return {
    scopeFor: async () => "all",
    holds: async () => true,
    resolveUserPermissions: async () => new Map<string, string>(),
  } as unknown as AccessService;
}

function reportsService(db: Db): ProjectsReportsService {
  return new ProjectsReportsService(db, passThroughCache(), unrestrictedAccess());
}

describe("Build reports read the points column", () => {
  it("sums points for cycle velocity and returns a non-zero committed and completed total, because summing story_points returned zero velocity for every organization on production", async () => {
    const built = harness({
      cursorStartDate: [
        {
          id: CYCLE,
          name: "C1",
          startDate: "2026-09-01",
          endDate: "2026-09-14",
          cursorStartDate: "2026-09-01 00:00:00",
        },
      ],
      committedPoints: [
        {
          cycleId: CYCLE,
          committedCount: 2,
          committedPoints: 13,
          completedCount: 2,
          completedPoints: 13,
        },
      ],
    });

    const result = await reportsService(built.db).velocity(owner, PROJECT, { limit: 10 });

    const committed = rendered(fieldNamed(built.selections, "committedPoints"));
    const completed = rendered(fieldNamed(built.selections, "completedPoints"));
    expect(committed).toContain('"tickets"."points"');
    expect(committed).not.toContain("story_points");
    expect(completed).toContain('"tickets"."points"');
    expect(completed).not.toContain("story_points");
    expect(result.data[0]?.committedPoints).toBe(13);
    expect(result.data[0]?.completedPoints).toBe(13);
  });

  it("scopes the burnup curve from points and reports a non-zero scope and completed line, because story_points produced a flat zero curve", async () => {
    const day = formatDateOnly(new Date("2026-09-01"));
    const built = harness({
      ticketId: [],
      totalScope: [{ totalScope: 13 }],
      pts: [{ day, pts: 13 }],
    });

    const curve = await reportsService(built.db).burnup(owner, PROJECT, { cycleId: String(CYCLE) });

    expect(rendered(fieldNamed(built.selections, "totalScope"))).toContain('"tickets"."points"');
    expect(rendered(fieldNamed(built.selections, "pts"))).toContain('"tickets"."points"');
    expect(curve.length).toBeGreaterThan(0);
    expect(curve[0]?.scope).toBe(13);
    expect(curve[0]?.completed).toBe(13);
  });

  it("stores a non-zero completed point total in the daily snapshot, because the snapshot summed story_points and persisted zero for every state group", async () => {
    const built = harness({ points: [{ group: "completed", count: 2, points: 13 }] });

    const result = await reportsService(built.db).snapshot(owner, PROJECT);

    expect(rendered(fieldNamed(built.selections, "points"))).toContain('"tickets"."points"');
    expect(result.captured).toBe(5);
    const completed = built.inserted[0]?.find((row) => row["stateGroup"] === "completed");
    expect(completed?.["points"]).toBe(13);
    const backlog = built.inserted[0]?.find((row) => row["stateGroup"] === "backlog");
    expect(backlog?.["points"]).toBe(0);
  });

  it("estimates the critical path from points so a two-ticket chain costs thirteen, because story_points was null on every row and each ticket silently defaulted to one", async () => {
    const built = harness({
      points: [
        { id: 1, title: "Design", points: 5 },
        { id: 2, title: "Build", points: 8 },
      ],
      relationType: [{ workItemId: 1, relatedWorkItemId: 2, relationType: "blocks" }],
    });

    const result = await reportsService(built.db).criticalPath(owner, PROJECT);

    expect(rendered(fieldNamed(built.selections, "points"))).toContain('"tickets"."points"');
    expect(result.totalDuration).toBe(13);
    expect(result.criticalPath.map((node) => node.estimate)).toEqual([5, 8]);
  });

  it("defaults to one point per ticket only when points is null, which is the reading that made the zero-point critical path look correct", () => {
    const edges = [{ from: 1, to: 2 }];

    expect(
      computeCriticalPath(
        [
          { id: 1, title: "Design", points: null },
          { id: 2, title: "Build", points: null },
        ],
        edges,
      ).totalDuration,
    ).toBe(2);
    expect(
      computeCriticalPath(
        [
          { id: 1, title: "Design", points: 5 },
          { id: 2, title: "Build", points: 8 },
        ],
        edges,
      ).totalDuration,
    ).toBe(13);
  });
});

describe("Build project analytics read the points column", () => {
  it("sums points for the project analytics cycle velocity and yields a non-zero completed total, because the health score divided by an always-zero velocity", async () => {
    const built = harness({
      completedPoints: [{ cycleId: CYCLE, cycleName: "C1", completedPoints: 13 }],
    });

    const result = await new ProjectsAnalyticsService(built.db, passThroughCache()).getProjectAnalytics(
      ORG,
      PROJECT,
    );

    const field = rendered(fieldNamed(built.selections, "completedPoints"));
    expect(field).toContain('"tickets"."points"');
    expect(field).not.toContain("story_points");
    expect(result.cycleVelocity[0]?.completedPoints).toBe(13);
  });

  it("reads t.points in the organization health rollup, because that raw SQL coalesced story_points then estimate and both were null on every production row", async () => {
    const built = harness({}, [
      { total: "1", healthy: "1", atRisk: "0", critical: "0", avgScore: "80" },
    ]);

    const summary = await new ProjectsAnalyticsService(
      built.db,
      passThroughCache(),
    ).getOrgProjectHealthSummary(ORG);

    const statement = built.executed[0];
    expect(statement).toBeDefined();
    expect(rendered(statement)).toContain("t.points");
    expect(rendered(statement)).not.toContain("story_points");
    expect(summary.avgScore).toBe(80);
  });
});
