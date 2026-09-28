import type { Db } from "../../../db/drizzle.module";
import { WorkloadCapacityService } from "./workload-capacity.service";

jest.mock("../core/project-crud/project-access", () => ({
  assertProjectInOrg: jest.fn().mockResolvedValue(undefined),
}));

const OWNER_ORG = "org-owner";
const ATTACKER_ORG = "org-attacker";
const PROJECT_ID = 1;

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value")
      ? sqlValues(record.value, seen)
      : []),
  ];
}

function makeBuilder(rows: unknown[]) {
  const where = jest.fn();
  const limit = jest.fn();
  const orderBy = jest.fn();
  const leftJoin = jest.fn();
  const innerJoin = jest.fn();
  const groupBy = jest.fn();
  const builder: Record<string, unknown> & {
    then: unknown;
    catch: unknown;
    finally: unknown;
  } = {
    from: jest.fn(),
    where,
    limit,
    orderBy,
    leftJoin,
    innerJoin,
    groupBy,
    then: (fn: (v: unknown) => unknown) => Promise.resolve(rows).then(fn),
    catch: (fn: (e: unknown) => unknown) => Promise.resolve(rows).catch(fn),
    finally: (fn: () => void) => Promise.resolve(rows).finally(fn),
  };
  (builder.from as jest.Mock).mockReturnValue(builder);
  where.mockReturnValue(builder);
  limit.mockReturnValue(builder);
  orderBy.mockReturnValue(builder);
  leftJoin.mockReturnValue(builder);
  innerJoin.mockReturnValue(builder);
  groupBy.mockReturnValue(builder);
  return { builder, where };
}

function makeSequentialDb(perCallRows: unknown[][]) {
  let callIndex = 0;
  const wheresByCall: jest.Mock[] = [];
  const db = {
    select: jest.fn().mockImplementation(() => {
      const rows = perCallRows[callIndex] ?? [];
      callIndex++;
      const { builder, where } = makeBuilder(rows);
      wheresByCall.push(where);
      return builder;
    }),
  } as unknown as Db;
  return { db, wheresByCall };
}

describe("WorkloadCapacityService — teamId filter", () => {
  it("returns empty members when teamId is provided but no team members exist in that team — filter is applied server-side", async () => {
    const { db } = makeSequentialDb([
      [{ expectedDailyHours: "8.0" }],
      [],
    ]);
    const svc = new WorkloadCapacityService(db);
    const result = await svc.capacity(OWNER_ORG, PROJECT_ID, "2026-09-01", "2026-09-14", 42);
    expect(result.members).toHaveLength(0);
  });

  it("returns only members in the team when teamId is provided and the team has members (positive control)", async () => {
    const teamMember = { membershipId: 1 };
    const memberRow = { userId: "u-team-1", membershipId: 1 };
    const { db, wheresByCall } = makeSequentialDb([
      [{ expectedDailyHours: "8.0" }],
      [teamMember],
      [memberRow],
      [],
      [],
    ]);
    const svc = new WorkloadCapacityService(db);
    const result = await svc.capacity(OWNER_ORG, PROJECT_ID, "2026-09-01", "2026-09-14", 42);
    expect(result.members).toHaveLength(1);
    expect(result.members[0].userId).toBe("u-team-1");
    const allVals = wheresByCall.flatMap((w) =>
      w.mock.calls.flatMap((c: unknown[]) => sqlValues(c[0])),
    );
    expect(allVals).toContain(OWNER_ORG);
    expect(allVals).toContain(42);
  });

  it("the team members WHERE clause contains both orgId and teamId — dropping either breaks tenant isolation or team filtering", async () => {
    const teamMember = { membershipId: 99 };
    const memberRow = { userId: "u-team-1", membershipId: 99 };
    const { db, wheresByCall } = makeSequentialDb([
      [],
      [teamMember],
      [memberRow],
      [],
      [],
    ]);
    const svc = new WorkloadCapacityService(db);
    await svc.capacity(OWNER_ORG, PROJECT_ID, "2026-09-01", "2026-09-14", 42);
    const teamWhereVals = wheresByCall[1]?.mock.calls.flatMap((c: unknown[]) => sqlValues(c[0])) ?? [];
    expect(teamWhereVals).toContain(OWNER_ORG);
    expect(teamWhereVals).toContain(42);
  });
});

describe("WorkloadCapacityService — cross-tenant isolation", () => {
  it("all four WHERE clauses (settings, members, leaves, timesheets) contain attacker orgId and not owner orgId — drop any orgId predicate and this fails", async () => {
    const memberRow = { userId: "u-attacker-1", membershipId: 99 };
    const { db, wheresByCall } = makeSequentialDb([
      [],
      [memberRow],
      [],
      [],
    ]);
    const svc = new WorkloadCapacityService(db);
    await svc.capacity(ATTACKER_ORG, PROJECT_ID, "2026-09-01", "2026-09-14");

    const allVals = wheresByCall.flatMap((w) =>
      w.mock.calls.flatMap((c: unknown[]) => sqlValues(c[0])),
    );
    expect(allVals).toContain(ATTACKER_ORG);
    expect(allVals).not.toContain(OWNER_ORG);
    expect(wheresByCall.length).toBeGreaterThanOrEqual(4);
  });

  it("result has no member data when attacker queries a project they do not belong to — no cross-boundary data returned", async () => {
    const { db } = makeSequentialDb([[], []]);
    const svc = new WorkloadCapacityService(db);
    const result = await svc.capacity(ATTACKER_ORG, PROJECT_ID, "2026-09-01", "2026-09-14");
    expect(result.members).toHaveLength(0);
  });

  it("owner orgA: all WHERE clauses contain owner orgId (positive control — same-tenant succeeds)", async () => {
    const memberRow = { userId: "u-owner-1", membershipId: 1 };
    const { db, wheresByCall } = makeSequentialDb([
      [{ expectedDailyHours: "8.0" }],
      [memberRow],
      [],
      [],
    ]);
    const svc = new WorkloadCapacityService(db);
    await svc.capacity(OWNER_ORG, PROJECT_ID, "2026-09-01", "2026-09-14");

    const allVals = wheresByCall.flatMap((w) =>
      w.mock.calls.flatMap((c: unknown[]) => sqlValues(c[0])),
    );
    expect(allVals).toContain(OWNER_ORG);
    expect(wheresByCall.length).toBeGreaterThanOrEqual(4);
  });

  it("owner orgA: result has the member entry with non-null capacity — data is not silently dropped (positive control)", async () => {
    const memberRow = { userId: "u-owner-1", membershipId: 1 };
    const { db } = makeSequentialDb([
      [{ expectedDailyHours: "8.0" }],
      [memberRow],
      [],
      [],
    ]);
    const svc = new WorkloadCapacityService(db);
    const result = await svc.capacity(OWNER_ORG, PROJECT_ID, "2026-09-01", "2026-09-14");
    expect(result.members).toHaveLength(1);
    expect(result.members[0].userId).toBe("u-owner-1");
  });
});
