import { NotFoundException } from "@nestjs/common";
import { OrgCustomDomainsService } from "./org-custom-domains.service";
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

function makeQuery(resolved: unknown = undefined) {
  return {
    orgCustomDomains: {
      findFirst: jest.fn().mockResolvedValue(resolved),
    },
  };
}

function makeDb(rows: unknown[] = [], whereCalls?: unknown[], queryResult: unknown = undefined): Db {
  return {
    select: jest.fn(() => makeChain(rows, whereCalls)),
    insert: jest.fn(() => ({ values: jest.fn(() => ({ returning: jest.fn().mockResolvedValue([]) })) })),
    delete: jest.fn(() => ({ where: jest.fn(() => ({ returning: jest.fn().mockResolvedValue([]) })) })),
    update: jest.fn(() => ({ set: jest.fn(() => ({ where: jest.fn().mockResolvedValue(undefined) })) })),
    query: makeQuery(queryResult),
  } as unknown as Db;
}

beforeEach(() => jest.resetAllMocks());

describe("OrgCustomDomainsService — cross-tenant isolation", () => {
  it("listCustomDomains returns empty when no domains exist for the requesting org — isolation by absence", async () => {
    const db = makeDb([]);
    const svc = new OrgCustomDomainsService(db, mockAudit);
    const result = await svc.listCustomDomains(ATTACKER_ORG);
    expect(result).toHaveLength(0);
  });

  it("listCustomDomains scopes WHERE to the requesting orgId — cross-org isolation", async () => {
    const whereCalls: unknown[] = [];
    const db = makeDb([], whereCalls);
    const svc = new OrgCustomDomainsService(db, mockAudit);
    await svc.listCustomDomains(ATTACKER_ORG);

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

  it("verifyCustomDomain throws NotFoundException when domainId belongs to a different org — cross-tenant DENY", async () => {
    const db = makeDb([], undefined, undefined);
    const svc = new OrgCustomDomainsService(db, mockAudit);
    await expect(svc.verifyCustomDomain(ATTACKER_ORG, "user-1", "domain-from-victim-org")).rejects.toThrow(NotFoundException);
  });

  it("removeCustomDomain returns NotFoundException when domainId belongs to a different org — cross-tenant DENY", async () => {
    const db = makeDb([]);
    const svc = new OrgCustomDomainsService(db, mockAudit);
    await expect(svc.removeCustomDomain(ATTACKER_ORG, "user-1", "domain-from-victim-org")).rejects.toThrow(NotFoundException);
  });
});
