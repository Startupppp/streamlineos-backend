import { SalesPlaybookService } from "./sales-playbook.service";
import type { Db } from "../../db/drizzle.module";

const ATTACKER_ORG = "org-attacker";
const VICTIM_ORG = "org-victim";

function makeChain(resolved: unknown[], whereCalls?: unknown[]) {
  const promise = Promise.resolve(resolved);
  const chain: Record<string, unknown> = {};
  chain.from = jest.fn(() => chain);
  chain.where = jest.fn((cond: unknown) => {
    whereCalls?.push(cond);
    return chain;
  });
  chain.orderBy = jest.fn(() => chain);
  chain.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => promise.then(res, rej);
  chain.catch = (rej: (e: unknown) => unknown) => promise.catch(rej);
  chain.finally = (cb: () => void) => promise.finally(cb);
  return chain;
}

function makeDb(rows: unknown[] = [], whereCalls?: unknown[]): Db {
  return {
    select: jest.fn(() => makeChain(rows, whereCalls)),
    insert: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    query: {},
  } as unknown as Db;
}

beforeEach(() => jest.resetAllMocks());

describe("SalesPlaybookService — cross-tenant isolation", () => {
  it("listPlaybook returns empty when no entries exist for the requesting org — isolation by absence", async () => {
    const db = makeDb([]);
    const svc = new SalesPlaybookService(db);
    const result = await svc.listPlaybook(ATTACKER_ORG);
    expect(result).toHaveLength(0);
  });

  it("listPlaybook scopes WHERE to the requesting orgId — cross-org isolation", async () => {
    const whereCalls: unknown[] = [];
    const db = makeDb([], whereCalls);
    const svc = new SalesPlaybookService(db);
    await svc.listPlaybook(ATTACKER_ORG);

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
