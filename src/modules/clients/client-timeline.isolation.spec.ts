import { ClientTimelineService } from "./client-timeline.service";
import type { Db } from "../../db/drizzle.module";

const ATTACKER_ORG = "org-attacker";
const VICTIM_ORG = "org-victim";

function makeChain(resolved: unknown[], whereCalls?: unknown[]) {
  const promise = Promise.resolve(resolved);
  const chain: Record<string, unknown> = {};
  chain.from = jest.fn(() => chain);
  chain.innerJoin = jest.fn(() => chain);
  chain.leftJoin = jest.fn(() => chain);
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
    query: {},
  } as unknown as Db;
}

beforeEach(() => jest.resetAllMocks());

describe("ClientTimelineService — cross-tenant isolation", () => {
  it("getTimeline returns null when the clientId is not visible to the requesting org — cross-org DENY by absence", async () => {
    const db = makeDb([]);
    const svc = new ClientTimelineService(db);
    const result = await svc.getTimeline(ATTACKER_ORG, 9999);
    expect(result).toBeNull();
  });

  it("getTimeline scopes the client lookup WHERE to the requesting orgId — cross-org isolation", async () => {
    const whereCalls: unknown[] = [];
    const db = makeDb([], whereCalls);
    const svc = new ClientTimelineService(db);
    await svc.getTimeline(ATTACKER_ORG, 9999);

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
