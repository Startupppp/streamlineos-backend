import { CalendarAttendeesService } from "./calendar-attendees.service";
import type { Db } from "../../db/drizzle.module";

const ATTACKER_ORG = "org-attacker";
const ATTACKER_USER = "user-attacker";
const EVENT_ID = 42;

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
  const where = jest.fn().mockImplementation((cond: unknown) => {
    whereCalls?.push(cond);
    return { limit };
  });
  const leftJoin = jest.fn().mockReturnValue({ where });
  const from = jest.fn().mockReturnValue({ leftJoin });
  const innerJoin = jest.fn().mockReturnValue({
    innerJoin: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }) }),
  });
  const fromInner = jest.fn().mockReturnValue({ innerJoin });

  let selectCall = 0;
  return {
    query: {
      organizationMembers: {
        findFirst: jest.fn().mockResolvedValue(memberRow),
      },
    },
    select: jest.fn().mockImplementation(() => {
      selectCall++;
      if (selectCall === 1) return { from };
      return { from: fromInner };
    }),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        onConflictDoUpdate: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([]),
        }),
      }),
    }),
  } as unknown as Db;
}

beforeEach(() => jest.resetAllMocks());

describe("CalendarAttendeesService — cross-tenant isolation (BOLA)", () => {
  it("listAttendees returns null when the caller has no membership in the requesting org (DENY)", async () => {
    const db = makeDb(undefined);
    const svc = new CalendarAttendeesService(db);
    const result = await svc.listAttendees(ATTACKER_ORG, ATTACKER_USER, EVENT_ID);
    expect(result).toBeNull();
  });

  it("rsvp returns null when caller has no membership in the requesting org — cross-org isolation", async () => {
    const db = makeDb(undefined);
    const svc = new CalendarAttendeesService(db);
    const result = await svc.rsvp(ATTACKER_ORG, ATTACKER_USER, EVENT_ID, { status: "accepted" });
    expect(result).toBeNull();
  });

  it("listAttendees scopes the org membership lookup to the requesting orgId — cross-org isolation", async () => {
    const whereCalls: unknown[] = [];
    const db = makeDb(undefined, whereCalls);
    const svc = new CalendarAttendeesService(db);
    await svc.listAttendees(ATTACKER_ORG, ATTACKER_USER, EVENT_ID);
    const findFirstCalls = (db.query.organizationMembers.findFirst as jest.Mock).mock.calls;
    expect(findFirstCalls.length).toBeGreaterThan(0);
    const findFirstArg = findFirstCalls[0]?.[0] as { where?: unknown };
    const whereVals = sqlValues(findFirstArg?.where);
    expect(whereVals).toContain(ATTACKER_ORG);
  });
});
