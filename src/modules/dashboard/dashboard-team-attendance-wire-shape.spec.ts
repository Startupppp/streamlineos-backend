import type { Db } from "../../db/drizzle.module";
import { DashboardAvailabilityService } from "./dashboard-availability.service";
import { teamAttendanceSchema } from "./dto/dashboard-misc-response.schemas";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

const ORG = "org-1";

const makeU = (): CurrentUserContext =>
  ({ orgId: ORG, userId: "user-1" }) as CurrentUserContext;

function makeChain(rows: unknown[]): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  chain["from"] = jest.fn().mockImplementation(self);
  chain["innerJoin"] = jest.fn().mockImplementation(self);
  chain["leftJoin"] = jest.fn().mockImplementation(self);
  chain["where"] = jest.fn().mockImplementation(self);
  chain["orderBy"] = jest.fn().mockImplementation(self);
  chain["limit"] = jest.fn().mockImplementation(self);
  chain["then"] = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(rows).then(resolve, reject);
  return chain;
}

function makeDb(todayAttendanceRows: unknown[]): Db {
  const queue = [
    [{ count: 5 }],
    todayAttendanceRows,
    [{ present: 2, clockedIn: 1 }],
  ];
  let call = 0;
  const select = jest.fn().mockImplementation(() => {
    const rows = queue[call] ?? [];
    call += 1;
    return makeChain(rows);
  });
  return { select } as unknown as Db;
}

function makeAccess() {
  return {
    getPermissionsVersion: jest.fn().mockResolvedValue(1),
    resolveUserPermissions: jest.fn().mockResolvedValue(new Map()),
  } as never;
}

function makeCache(throughRedis: boolean) {
  return {
    cachedForOrg: jest.fn().mockImplementation(async (_org: unknown, _key: unknown, fn: () => Promise<unknown>) => {
      const value = await fn();
      return throughRedis ? JSON.parse(JSON.stringify(value)) : value;
    }),
  } as never;
}

function attendanceRow() {
  return {
    userId: "user-2",
    userName: "Ada Lovelace",
    userImage: null,
    userDesignation: "Engineer",
    checkIn: new Date("2026-09-14T09:00:00.000Z"),
    checkOut: null,
    status: "PRESENT",
    createdAt: new Date("2026-09-14T09:00:00.000Z"),
  };
}

describe("DashboardController.teamAttendance — the shape the read path returns", () => {
  it("satisfies teamAttendanceSchema on a cache MISS (fresh Date objects)", async () => {
    const svc = new DashboardAvailabilityService(makeDb([attendanceRow()]), makeCache(false), makeAccess());
    const result = await svc.getTeamAttendance(makeU());
    const parsed = teamAttendanceSchema.safeParse(result);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);
  });

  it("satisfies teamAttendanceSchema on a cache HIT (Redis JSON round-trip turns Date into string)", async () => {
    const svc = new DashboardAvailabilityService(makeDb([attendanceRow()]), makeCache(true), makeAccess());
    const result = await svc.getTeamAttendance(makeU());
    const record = (result as { records: { checkIn: unknown }[] }).records[0];
    expect(typeof record?.checkIn).toBe("string");
    const parsed = teamAttendanceSchema.safeParse(result);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);
  });

  it("returns an object, not the array the schema used to alias", async () => {
    const svc = new DashboardAvailabilityService(makeDb([attendanceRow()]), makeCache(false), makeAccess());
    const result = await svc.getTeamAttendance(makeU());
    expect(Array.isArray(result)).toBe(false);
    expect(result).toHaveProperty("records");
  });
});
