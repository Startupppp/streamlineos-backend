import { CalendarExportService } from "./calendar-export.service";
import { EXPORT_MAX_SPAN_DAYS, exportSchema } from "./dto/calendar.schemas";
import type { Db } from "../../db/drizzle.module";

const ATTACKER_ORG = "org-attacker";
const ATTACKER_USER = "user-attacker";

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

function makeDb(memberRow?: { id: number }, whereCalls?: unknown[]): Db {
  const limit = jest.fn().mockResolvedValue([]);
  const orderBy = jest.fn().mockReturnValue({ limit });
  const where = jest.fn().mockImplementation((cond: unknown) => {
    whereCalls?.push(cond);
    return { orderBy };
  });
  const leftJoin = jest.fn().mockReturnValue({ where });
  const from = jest.fn().mockReturnValue({ leftJoin });
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

describe("CalendarExportService — cross-tenant isolation (BOLA)", () => {
  it("exportEvents returns empty array when caller has no membership in the requesting org (DENY)", async () => {
    const db = makeDb(undefined);
    const svc = new CalendarExportService(db);
    const from = new Date("2026-01-01");
    const to = new Date("2026-12-31");
    const result = await svc.exportEvents(ATTACKER_ORG, ATTACKER_USER, from, to);
    expect(result).toHaveLength(0);
  });

  it("exportEvents scopes the WHERE predicate to the requesting orgId — cross-org isolation", async () => {
    const whereCalls: unknown[] = [];
    const db = makeDb({ id: 0 }, whereCalls);
    const svc = new CalendarExportService(db);
    const from = new Date("2026-01-01");
    const to = new Date("2026-12-31");
    await svc.exportEvents(ATTACKER_ORG, ATTACKER_USER, from, to);
    expect(whereCalls.length).toBeGreaterThan(0);
    const allValues = whereCalls.flatMap((w) => sqlValues(w));
    expect(allValues).toContain(ATTACKER_ORG);
  });

  it("exportEvents org membership lookup is scoped to the requesting orgId — cross-org isolation", async () => {
    const db = makeDb(undefined);
    const svc = new CalendarExportService(db);
    const from = new Date("2026-01-01");
    const to = new Date("2026-12-31");
    await svc.exportEvents(ATTACKER_ORG, ATTACKER_USER, from, to);
    const findFirstCalls = (db.query.organizationMembers.findFirst as jest.Mock).mock.calls;
    expect(findFirstCalls.length).toBe(1);
    const arg = findFirstCalls[0]?.[0] as { where?: unknown };
    const whereVals = sqlValues(arg?.where);
    expect(whereVals).toContain(ATTACKER_ORG);
  });
});
