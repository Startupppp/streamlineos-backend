import { CalendarExportService } from "./calendar-export.service";
import { EXPORT_MAX_SPAN_DAYS, exportSchema } from "./dto/calendar.schemas";
import type { Db } from "../../db/drizzle.module";
import { ScopedRead } from "../access/scoped-read";

const ATTACKER_ORG = "org-attacker";
const ATTACKER_USER = "user-attacker";
const readAs = (orgId: string, userId: string, scope: "none" | "own" | "team" | "all" = "all") =>
  ScopedRead.of(orgId, userId, scope);

function sqlValues(val: unknown, seen = new Set<object>()): unknown[] {
  if (val === null || val === undefined || typeof val === "string" || typeof val === "number" || typeof val === "boolean") return [val];
  if (Array.isArray(val)) return val.flatMap((v) => sqlValues(v, seen));
  if (typeof val !== "object" || seen.has(val as object)) return [];
  seen.add(val as object);
  const rec = val as Record<string, unknown>;
  return [
    ...(rec["queryChunks"] ? sqlValues(rec["queryChunks"], seen) : []),
    ...(Object.prototype.hasOwnProperty.call(rec, "value") ? sqlValues(rec["value"], seen) : []),
  ];
}

/**
 * The mock chain deliberately omits `leftJoin`. The export query uses a
 * scalar subquery for attendance visibility instead of a LEFT JOIN (see
 * `attendedByExporter` in calendar-export.service.ts). If the service is
 * reverted to use `.leftJoin()`, every test below throws
 * "TypeError: db.select(...).from(...).leftJoin is not a function" —
 * that TypeError IS the bite proof: the test fails exactly where the
 * structural regression is.
 */
function makeDb(memberRow?: { id: number }, whereCalls?: unknown[]): Db {
  const limit = jest.fn().mockResolvedValue([]);
  const orderBy = jest.fn().mockReturnValue({ limit });
  const where = jest.fn().mockImplementation((cond: unknown) => {
    whereCalls?.push(cond);
    return { orderBy };
  });
  const from = jest.fn().mockReturnValue({ where });
  return {
    query: {
      organizationMembers: {
        findFirst: jest.fn().mockResolvedValue(memberRow),
      },
    },
    select: jest.fn().mockReturnValue({ from }),
  } as unknown as Db;
}

beforeEach(() => jest.resetAllMocks());

describe("exportSchema — date range enforcement", () => {
  it(`accepts a range exactly at ${EXPORT_MAX_SPAN_DAYS} days (boundary, must pass)`, () => {
    const from = new Date("2026-01-01T00:00:00.000Z");
    const to = new Date(from.getTime() + EXPORT_MAX_SPAN_DAYS * 24 * 60 * 60 * 1000);
    const result = exportSchema.safeParse({
      from: from.toISOString(),
      to: to.toISOString(),
    });
    expect(result.success).toBe(true);
  });

  it(`rejects a range one day past ${EXPORT_MAX_SPAN_DAYS} days (boundary + 1, must fail)`, () => {
    const from = new Date("2026-01-01T00:00:00.000Z");
    const to = new Date(from.getTime() + (EXPORT_MAX_SPAN_DAYS + 1) * 24 * 60 * 60 * 1000);
    const result = exportSchema.safeParse({
      from: from.toISOString(),
      to: to.toISOString(),
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((i) => i.path.includes("to"))).toBe(true);
  });

  it("rejects an inverted range (to before from)", () => {
    const result = exportSchema.safeParse({
      from: "2026-08-10T00:00:00.000Z",
      to: "2026-08-01T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a narrow valid range (30 days)", () => {
    const result = exportSchema.safeParse({
      from: "2026-07-01T00:00:00.000Z",
      to: "2026-07-31T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a non-date from value", () => {
    const result = exportSchema.safeParse({ from: "not-a-date", to: "2026-08-01" });
    expect(result.success).toBe(false);
  });

  it("rejects a non-date to value", () => {
    const result = exportSchema.safeParse({ from: "2026-08-01", to: "bad" });
    expect(result.success).toBe(false);
  });
});

describe("CalendarExportService — scalar subquery visibility (no LEFT JOIN)", () => {
  it("BITE: resolves without error when the mock chain has no leftJoin — reverted service throws TypeError here", async () => {
    const db = makeDb({ id: 7 });
    const svc = new CalendarExportService(db);
    const from = new Date("2026-01-01");
    const to = new Date("2026-06-30");
    await expect(svc.exportEvents(readAs("org-1", "user-1"), from, to)).resolves.toBeDefined();
  });
});

describe("CalendarExportService — cross-tenant isolation (BOLA)", () => {
  it("exportEvents returns empty array when caller has no membership in the requesting org (DENY)", async () => {
    const db = makeDb(undefined);
    const svc = new CalendarExportService(db);
    const from = new Date("2026-01-01");
    const to = new Date("2026-12-31");
    const result = await svc.exportEvents(readAs(ATTACKER_ORG, ATTACKER_USER), from, to);
    expect(result.events).toHaveLength(0);
    expect(result.truncated).toBe(false);
  });

  it("exportEvents scopes the WHERE predicate to the requesting orgId — cross-org isolation", async () => {
    const whereCalls: unknown[] = [];
    const db = makeDb({ id: 0 }, whereCalls);
    const svc = new CalendarExportService(db);
    const from = new Date("2026-01-01");
    const to = new Date("2026-12-31");
    await svc.exportEvents(readAs(ATTACKER_ORG, ATTACKER_USER), from, to);
    expect(whereCalls.length).toBeGreaterThan(0);
    const allValues = whereCalls.flatMap((w) => sqlValues(w));
    expect(allValues).toContain(ATTACKER_ORG);
  });

  it("exportEvents org membership lookup is scoped to the requesting orgId — cross-org isolation", async () => {
    const db = makeDb(undefined);
    const svc = new CalendarExportService(db);
    const from = new Date("2026-01-01");
    const to = new Date("2026-12-31");
    await svc.exportEvents(readAs(ATTACKER_ORG, ATTACKER_USER), from, to);
    const findFirstCalls = (db.query.organizationMembers.findFirst as jest.Mock).mock.calls;
    expect(findFirstCalls.length).toBe(1);
    const arg = findFirstCalls[0]?.[0] as { where?: unknown };
    const whereVals = sqlValues(arg?.where);
    expect(whereVals).toContain(ATTACKER_ORG);
  });
});
