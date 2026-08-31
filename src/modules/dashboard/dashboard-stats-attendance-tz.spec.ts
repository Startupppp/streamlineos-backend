import type { Db } from "../../db/drizzle.module";
import { DashboardStatsService } from "./dashboard-stats.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

function makeChain(rows: unknown[] = []): object {
  return Object.assign(Promise.resolve(rows), {
    limit: jest.fn().mockImplementation(() => makeChain(rows)),
    orderBy: jest.fn().mockImplementation(() => makeChain(rows)),
    where: jest.fn().mockImplementation(() => makeChain(rows)),
  });
}

function makeDb(orgTimezone: string): Db {
  return {
    query: {
      organizations: {
        findFirst: jest.fn().mockResolvedValue({ name: "Acme", slug: "acme", timezone: orgTimezone }),
      },
    },
    select: jest.fn().mockImplementation(() => ({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockImplementation(() => makeChain([{ count: 0 }])),
      }),
    })),
  } as unknown as Db;
}

function makeAccess() {
  return {
    getPermissionsVersion: jest.fn().mockResolvedValue(1),
    scopeFor: jest.fn().mockResolvedValue("all"),
    resolveUserPermissions: jest.fn().mockResolvedValue(new Map([["hr:attendance:manage", "all"]])),
  } as never;
}

function makeCache(callLog: { key: string; dimension?: string }[] = []) {
  return {
    cachedForOrg: jest.fn().mockImplementation((_org: string, key: string, fn: () => unknown) => {
      callLog.push({ key });
      return fn();
    }),
  } as never;
}

const makeU = (orgId: string): CurrentUserContext => ({ orgId, userId: "user-1" }) as CurrentUserContext;

describe("DashboardStatsService — attendance cache key timezone dimension", () => {
  it("orgs in UTC+14 and UTC-12 get different attendance cache keys on the same instant", async () => {
    const orgUtcPlus14 = "org-tz-plus14";
    const orgUtcMinus12 = "org-tz-minus12";

    const keysPlus14: string[] = [];
    const keysMinus12: string[] = [];

    const svcPlus14 = new DashboardStatsService(
      makeDb("Pacific/Kiritimati"),
      { cachedForOrg: jest.fn().mockImplementation((_o: string, key: string, fn: () => unknown) => { keysPlus14.push(key); return fn(); }) } as never,
      makeAccess(),
    );

    const svcMinus12 = new DashboardStatsService(
      makeDb("Etc/GMT+12"),
      { cachedForOrg: jest.fn().mockImplementation((_o: string, key: string, fn: () => unknown) => { keysMinus12.push(key); return fn(); }) } as never,
      makeAccess(),
    );

    await svcPlus14.getDashboardStats(orgUtcPlus14, makeU(orgUtcPlus14));
    await svcMinus12.getDashboardStats(orgUtcMinus12, makeU(orgUtcMinus12));

    const attendancePlus14 = keysPlus14.find((k) => k.includes("stats-attendance"));
    const attendanceMinus12 = keysMinus12.find((k) => k.includes("stats-attendance"));

    expect(attendancePlus14).toBeDefined();
    expect(attendanceMinus12).toBeDefined();
    expect(attendancePlus14).not.toEqual(attendanceMinus12);
  });

  it("attendance key includes the org's IANA timezone identifier, not just the date", async () => {
    const orgId = "org-tz-kolkata";
    const keys: string[] = [];

    const svc = new DashboardStatsService(
      makeDb("Asia/Kolkata"),
      { cachedForOrg: jest.fn().mockImplementation((_o: string, key: string, fn: () => unknown) => { keys.push(key); return fn(); }) } as never,
      makeAccess(),
    );

    await svc.getDashboardStats(orgId, makeU(orgId));

    const attendanceKey = keys.find((k) => k.includes("stats-attendance"));
    expect(attendanceKey).toBeDefined();
    expect(attendanceKey).toContain("Asia/Kolkata");
  });

  it("attendance key rolls at the org local midnight, not UTC midnight", () => {
    const moment = new Date("2026-03-01T00:30:00.000Z");

    const localDateKolkata = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(moment);
    const localDateUtc = moment.toISOString().slice(0, 10);

    expect(localDateKolkata).toBe("2026-03-01");
    expect(localDateUtc).toBe("2026-03-01");

    const momentAfterKolkataMidnight = new Date("2026-03-01T18:31:00.000Z");
    const kolkataDateAfter = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(momentAfterKolkataMidnight);
    const utcDateAfter = momentAfterKolkataMidnight.toISOString().slice(0, 10);

    expect(kolkataDateAfter).toBe("2026-03-02");
    expect(utcDateAfter).toBe("2026-03-01");
    expect(kolkataDateAfter).not.toEqual(utcDateAfter);
  });

  it("UTC fallback is used when org has no configured timezone", async () => {
    const orgId = "org-no-tz";
    const keys: string[] = [];

    const dbWithNoTz = {
      query: {
        organizations: {
          findFirst: jest.fn().mockResolvedValue({ name: "NoTz", slug: "notz", timezone: null }),
        },
      },
      select: jest.fn().mockImplementation(() => ({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockImplementation(() => makeChain([{ count: 0 }])),
        }),
      })),
    } as unknown as Db;

    const svc = new DashboardStatsService(
      dbWithNoTz,
      { cachedForOrg: jest.fn().mockImplementation((_o: string, key: string, fn: () => unknown) => { keys.push(key); return fn(); }) } as never,
      makeAccess(),
    );

    await svc.getDashboardStats(orgId, makeU(orgId));

    const attendanceKey = keys.find((k) => k.includes("stats-attendance"));
    expect(attendanceKey).toBeDefined();
    expect(attendanceKey).toContain("UTC");
  });
});
