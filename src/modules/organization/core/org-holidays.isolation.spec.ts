import { OrgHolidaysService } from "./org-holidays.service";
import type { Db } from "../../../db/drizzle.module";
import type { AuditService } from "../../../common/audit/audit.service";

const ATTACKER_ORG = "org-attacker";
const VICTIM_ORG = "org-victim";

const mockAudit = { log: jest.fn() } as unknown as AuditService;

function makeChain(resolved: unknown[], whereCalls?: unknown[]) {
  const promise = Promise.resolve(resolved);
  const chain: Record<string, unknown> = {};
  chain.from = jest.fn(() => chain);
  chain.where = jest.fn((cond: unknown) => {
    whereCalls?.push(cond);
    return chain;
  });
  chain.orderBy = jest.fn(() => chain);
  chain.limit = jest.fn(() => promise);
  chain.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => promise.then(res, rej);
  chain.catch = (rej: (e: unknown) => unknown) => promise.catch(rej);
  chain.finally = (cb: () => void) => promise.finally(cb);
  return chain;
}

function makeDb(rows: unknown[] = [], whereCalls?: unknown[]): Db {
  return {
    select: jest.fn(() => makeChain(rows, whereCalls)),
    insert: jest.fn(() => ({ values: jest.fn(() => ({ returning: jest.fn().mockResolvedValue([]) })) })),
    delete: jest.fn(() => ({ where: jest.fn().mockResolvedValue(undefined) })),
    query: {},
  } as unknown as Db;
}

beforeEach(() => jest.resetAllMocks());

describe("OrgHolidaysService — cross-tenant isolation", () => {
  it("listHolidays returns empty when no holidays exist for the requesting org — isolation by absence", async () => {
    const db = makeDb([]);
    const svc = new OrgHolidaysService(db, mockAudit);
    const result = await svc.listHolidays(ATTACKER_ORG);
    expect(result).toHaveLength(0);
  });

  it("listHolidays scopes WHERE to the requesting orgId — cross-org isolation", async () => {
    const whereCalls: unknown[] = [];
    const db = makeDb([], whereCalls);
    const svc = new OrgHolidaysService(db, mockAudit);
    await svc.listHolidays(ATTACKER_ORG);

    const flatValues: unknown[] = [];
    function walk(val: unknown, seen = new Set<object>()): void {
      if (val === null || val === undefined || typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
        flatValues.push(val);
        return;
      }
      if (Array.isArray(val)) { val.forEach((v) => walk(v, seen)); return; }
      if (typeof val !== "object" || seen.has(val as object)) return;
      seen.add(val as object);
      const rec = val as Record<string, unknown>;
      if (rec["queryChunks"]) walk(rec["queryChunks"], seen);
      if (Object.prototype.hasOwnProperty.call(rec, "value")) walk(rec["value"], seen);
    }
    whereCalls.forEach((w) => walk(w));
    expect(flatValues).toContain(ATTACKER_ORG);
    expect(flatValues).not.toContain(VICTIM_ORG);
  });
});
