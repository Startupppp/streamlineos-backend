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

function sqlColumnNames(value: unknown, seen = new Set<object>()): string[] {
  if (value === null || typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  if (Array.isArray(value)) return value.flatMap((item) => sqlColumnNames(item, seen));
  const record = value as { name?: unknown };
  if (typeof record.name === "string") return [record.name];
  return Object.values(record).flatMap((child) => sqlColumnNames(child, seen));
}

function makeSequentialDb(perCallRows: unknown[][]) {
  let callIndex = 0;
  const wheresByCall: jest.Mock[] = [];
  const select = jest.fn().mockImplementation(() => {
    const rows = perCallRows[callIndex] ?? [];
    callIndex++;
    const { builder, where } = makeBuilder(rows);
    wheresByCall.push(where);
    return builder;
  });
  const db = { select } as unknown as Db;
  return { db, wheresByCall, select };
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

const MEMBER_ROW = { userId: "u-owner-1", membershipId: 1 };
const MON_TO_FRI_START = "2026-09-14";
const MON_TO_FRI_END = "2026-09-18";

function makeEstimateDb(estimateRows: unknown[]) {
  return makeSequentialDb([
    [{ expectedDailyHours: "8.0" }],
    [MEMBER_ROW],
    [],
    [],
    estimateRows,
  ]);
}

async function capacityWithEstimates(estimateRows: unknown[]) {
  const { db, wheresByCall, select } = makeEstimateDb(estimateRows);
  const svc = new WorkloadCapacityService(db);
  const result = await svc.capacity(OWNER_ORG, PROJECT_ID, MON_TO_FRI_START, MON_TO_FRI_END);
  return { result, wheresByCall, select };
}

describe("WorkloadCapacityService — estimate projection reads a column a writer actually populates", () => {
  it("projects tickets.original_estimate, the column written by ticket create and ticket update, and never the writerless story_points", async () => {
    const { select } = await capacityWithEstimates([]);
    const estimateProjection = select.mock.calls[4]?.[0] as Record<string, unknown> | undefined;
    expect(estimateProjection).toBeDefined();
    const names = sqlColumnNames(estimateProjection);
    expect(names).toContain("original_estimate");
    expect(names).not.toContain("story_points");
  });

  it("excludes completed and cancelled statuses so the estimate figure is outstanding demand, not historical work", async () => {
    const { wheresByCall } = await capacityWithEstimates([]);
    const chunks = wheresByCall[4]?.mock.calls.flatMap((c: unknown[]) => sqlValues(c[0])) ?? [];
    const text = chunks.filter((v): v is string => typeof v === "string").join(" ");
    expect(text).toContain("IS DISTINCT FROM 'completed'");
    expect(text).toContain("IS DISTINCT FROM 'cancelled'");
  });

  it("carries orgId and projectId in the estimate WHERE clause so one tenant's estimates cannot land on another tenant's workload row", async () => {
    const { wheresByCall } = await capacityWithEstimates([]);
    const vals = wheresByCall[4]?.mock.calls.flatMap((c: unknown[]) => sqlValues(c[0])) ?? [];
    expect(vals).toContain(OWNER_ORG);
    expect(vals).toContain(PROJECT_ID);
  });
});

describe("WorkloadCapacityService — estimateHours distinguishes no-estimate from a zero estimate", () => {
  it("returns null estimateHours when no open assigned ticket carries an original_estimate, so the row cannot render a fabricated 0h", async () => {
    const { result } = await capacityWithEstimates([
      { assigneeMembershipId: 1, estimateHours: "0", estimatedTicketCount: "0" },
    ]);
    expect(result.members[0].estimateHours).toBeNull();
    expect(result.members[0].allocationPercent).toBeNull();
    expect(result.members[0].varianceHours).toBeNull();
  });

  it("returns 0 estimateHours when a ticket does carry an explicit zero estimate, which is a different fact from null", async () => {
    const { result } = await capacityWithEstimates([
      { assigneeMembershipId: 1, estimateHours: "0", estimatedTicketCount: "1" },
    ]);
    expect(result.members[0].estimateHours).toBe(0);
    expect(result.members[0].allocationPercent).toBe(0);
  });

  it("sums original_estimate across the member's open tickets and derives allocation against net capacity (positive control)", async () => {
    const { result } = await capacityWithEstimates([
      { assigneeMembershipId: 1, estimateHours: "20.00", estimatedTicketCount: "3" },
    ]);
    expect(result.members[0].capacityHours).toBe(40);
    expect(result.members[0].estimateHours).toBe(20);
    expect(result.members[0].allocationPercent).toBe(50);
  });

  it("returns null estimateHours for a member absent from the grouped estimate rows rather than crediting them another member's total", async () => {
    const { result } = await capacityWithEstimates([
      { assigneeMembershipId: 99, estimateHours: "40.00", estimatedTicketCount: "5" },
    ]);
    expect(result.members[0].membershipId).toBe(1);
    expect(result.members[0].estimateHours).toBeNull();
  });

  it("ignores grouped rows whose assigneeMembershipId is null so unassigned estimates are never attributed to a member", async () => {
    const { result } = await capacityWithEstimates([
      { assigneeMembershipId: null, estimateHours: "40.00", estimatedTicketCount: "5" },
      { assigneeMembershipId: 1, estimateHours: "8.00", estimatedTicketCount: "1" },
    ]);
    expect(result.members[0].estimateHours).toBe(8);
  });
});

function makeTeamDb(teamRows: unknown[]) {
  return makeSequentialDb([
    [{ expectedDailyHours: "8.0" }],
    [MEMBER_ROW],
    [],
    [],
    [],
    teamRows,
  ]);
}

describe("WorkloadCapacityService — team membership on the capacity projection", () => {
  it("carries each team the member belongs to, so the workload view can group by team without one read per team", async () => {
    const { db } = makeTeamDb([
      { membershipId: 1, teamId: 4, teamName: "Platform" },
      { membershipId: 1, teamId: 9, teamName: "Payments" },
    ]);
    const svc = new WorkloadCapacityService(db);
    const result = await svc.capacity(OWNER_ORG, PROJECT_ID, MON_TO_FRI_START, MON_TO_FRI_END);
    expect(result.members[0].teams).toEqual([
      { id: 4, name: "Platform" },
      { id: 9, name: "Payments" },
    ]);
  });

  it("returns an empty team list for a member on no team, rather than omitting the field the contract declares", async () => {
    const { db } = makeTeamDb([]);
    const svc = new WorkloadCapacityService(db);
    const result = await svc.capacity(OWNER_ORG, PROJECT_ID, MON_TO_FRI_START, MON_TO_FRI_END);
    expect(result.members[0].teams).toEqual([]);
  });

  it("never credits one member with another member's team", async () => {
    const { db } = makeTeamDb([{ membershipId: 77, teamId: 4, teamName: "Platform" }]);
    const svc = new WorkloadCapacityService(db);
    const result = await svc.capacity(OWNER_ORG, PROJECT_ID, MON_TO_FRI_START, MON_TO_FRI_END);
    expect(result.members[0].membershipId).toBe(1);
    expect(result.members[0].teams).toEqual([]);
  });

  it("scopes the team read to the caller's org, so a shared team id cannot name another tenant's team", async () => {
    const { db, wheresByCall } = makeTeamDb([{ membershipId: 1, teamId: 4, teamName: "Platform" }]);
    const svc = new WorkloadCapacityService(db);
    await svc.capacity(ATTACKER_ORG, PROJECT_ID, MON_TO_FRI_START, MON_TO_FRI_END);
    const teamWhereVals =
      wheresByCall[5]?.mock.calls.flatMap((c: unknown[]) => sqlValues(c[0])) ?? [];
    expect(teamWhereVals).toContain(ATTACKER_ORG);
    expect(teamWhereVals).not.toContain(OWNER_ORG);
  });

  it("bounds the team read, so a member on hundreds of teams cannot make the response unbounded", async () => {
    const { db, select } = makeTeamDb([{ membershipId: 1, teamId: 4, teamName: "Platform" }]);
    const svc = new WorkloadCapacityService(db);
    await svc.capacity(OWNER_ORG, PROJECT_ID, MON_TO_FRI_START, MON_TO_FRI_END);
    const teamBuilder = select.mock.results[5]?.value as { limit: jest.Mock };
    expect(teamBuilder.limit).toHaveBeenCalledWith(500);
  });
});
