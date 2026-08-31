import { CalendarRecurrenceService } from "./calendar-recurrence.service";
import type { Db } from "../../db/drizzle.module";

const ATTACKER_ORG = "org-attacker";
const ATTACKER_USER = "user-attacker";
const EVENT_ID = 77;
const OCCURRENCE_ISO = "2026-06-01T10:00:00.000Z";

const UPSERT_INPUT = { modifiedTitle: "Revised" };

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
  const from = jest.fn().mockReturnValue({ where });
  const txCallback = jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          onConflictDoUpdate: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([{ id: 1 }]),
          }),
        }),
      }),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
      }),
    };
    return fn(tx);
  });
  return {
    query: {
      organizationMembers: {
        findFirst: jest.fn().mockResolvedValue(memberRow),
      },
    },
    select: jest.fn().mockReturnValue({ from }),
    transaction: txCallback,
  } as unknown as Db;
}

beforeEach(() => jest.resetAllMocks());

describe("CalendarRecurrenceService — cross-tenant isolation (BOLA)", () => {
  it("upsertOccurrenceException returns null when caller has no membership in the requesting org (DENY)", async () => {
    const db = makeDb(undefined);
    const svc = new CalendarRecurrenceService(db);
    const result = await svc.upsertOccurrenceException(ATTACKER_ORG, ATTACKER_USER, EVENT_ID, OCCURRENCE_ISO, UPSERT_INPUT);
    expect(result).toBeNull();
  });

  it("cancelOccurrence returns null when caller has no membership in the requesting org — cross-org isolation", async () => {
    const db = makeDb(undefined);
    const svc = new CalendarRecurrenceService(db);
    const result = await svc.cancelOccurrence(ATTACKER_ORG, ATTACKER_USER, EVENT_ID, OCCURRENCE_ISO);
    expect(result).toBeNull();
  });

  it("getRecurringEventForOwner scopes the org membership lookup to the requesting orgId — cross-org isolation", async () => {
    const db = makeDb(undefined);
    const svc = new CalendarRecurrenceService(db);
    await svc.cancelOccurrence(ATTACKER_ORG, ATTACKER_USER, EVENT_ID, OCCURRENCE_ISO);
    const findFirstCalls = (db.query.organizationMembers.findFirst as jest.Mock).mock.calls;
    expect(findFirstCalls.length).toBeGreaterThan(0);
    const arg = findFirstCalls[0]?.[0] as { where?: unknown };
    const whereVals = sqlValues(arg?.where);
    expect(whereVals).toContain(ATTACKER_ORG);
  });
});
