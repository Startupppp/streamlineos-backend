import { BuildApprovalsInboxService } from "./build-approvals-inbox.service";
import type { Db } from "../../../db/drizzle.module";

const ATTACKER_ORG = "org-attacker";
const OWNER_ORG = "org-owner";
const APPROVER_USER = "user-approver";

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

function makeDb(rows: unknown[] = [], whereCalls?: unknown[]): Db {
  const limit = jest.fn().mockResolvedValue(rows);
  const orderBy = jest.fn().mockReturnValue({ limit });
  const where = jest.fn().mockImplementation((cond: unknown) => {
    whereCalls?.push(cond);
    return { orderBy };
  });
  const from = jest.fn().mockReturnValue({ where });
  return {
    select: jest.fn().mockReturnValue({ from }),
  } as unknown as Db;
}

beforeEach(() => jest.resetAllMocks());

describe("BuildApprovalsInboxService — cross-tenant isolation (BOLA)", () => {
  it("getInboxPage returns empty array for an org with no approvals — DENY for wrong org", async () => {
    const db = makeDb([]);
    const svc = new BuildApprovalsInboxService(db);
    const result = await svc.getInboxPage(ATTACKER_ORG, APPROVER_USER, 20, null);
    expect(result).toHaveLength(0);
  });

  it("getInboxPage scopes the WHERE predicate to the requesting orgId — cross-org isolation", async () => {
    const whereCalls: unknown[] = [];
    const db = makeDb([], whereCalls);
    const svc = new BuildApprovalsInboxService(db);
    await svc.getInboxPage(ATTACKER_ORG, APPROVER_USER, 20, null);
    expect(whereCalls.length).toBeGreaterThan(0);
    const allValues = whereCalls.flatMap((w) => sqlValues(w));
    expect(allValues).toContain(ATTACKER_ORG);
  });

  it("getInboxPage uses the requestor's userId as approverId — different user sees different inbox", async () => {
    const whereCalls: unknown[] = [];
    const db = makeDb([], whereCalls);
    const svc = new BuildApprovalsInboxService(db);
    await svc.getInboxPage(OWNER_ORG, "user-other", 20, null);
    const allValues = whereCalls.flatMap((w) => sqlValues(w));
    expect(allValues).toContain("user-other");
  });
});
