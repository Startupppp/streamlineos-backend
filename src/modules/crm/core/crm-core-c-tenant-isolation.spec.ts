import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { CrmCeDashboardService } from "./crm-ce-dashboard.service";
import { CrmOrganizationsMergeService } from "./crm-organizations-merge.service";
import type { CacheService } from "../../../common/cache/cache.service";
import type { PartyMergeService } from "../../party/party-merge.service";
import { resolveLegacyParty, isLegacyResolved } from "../../party/party-legacy-seam";

jest.mock("../../party/party-legacy-seam");

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const rec = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(rec.queryChunks ? sqlValues(rec.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(rec, "value") ? sqlValues(rec.value, seen) : []),
  ];
}

const ATTACKER = "org-attacker";
const OWNER = "org-owner";

function makeFullDb() {
  const where = jest.fn();
  const chain = {
    then: (fn: (v: unknown[]) => unknown) => Promise.resolve([]).then(fn),
    catch: (fn: (e: unknown) => unknown) => Promise.resolve([]).catch(fn),
    finally: (fn: () => void) => Promise.resolve([]).finally(fn),
    groupBy: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn(),
  };
  chain.groupBy.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  chain.limit.mockReturnValue(chain);
  where.mockReturnValue(chain);
  const noopFindMany = jest.fn().mockResolvedValue([]);
  const db = {
    select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where }) }),
    query: {
      crmCompanies: { findMany: noopFindMany },
      crmMonthlyMetrics: { findMany: noopFindMany },
      crmActivities: { findMany: noopFindMany },
      crmSupportTickets: { findMany: noopFindMany },
    },
  } as unknown as Db;
  return { db, where, noopFindMany };
}

describe("CrmCeDashboardService — cross-tenant isolation", () => {
  it("getCustomerExecutiveDashboard: all DB calls carry the attacker orgId (deny — data scoped per caller)", async () => {
    const { db, where, noopFindMany } = makeFullDb();
    const cache = {
      cached: jest.fn().mockImplementation((_key: string, fn: () => unknown) => fn()),
    } as unknown as CacheService;
    const svc = new CrmCeDashboardService(db, cache);
    const result = await svc.getCustomerExecutiveDashboard(ATTACKER);
    expect(result.keyAccounts).toHaveLength(0);
    expect(where).toHaveBeenCalled();
    const selectVals = where.mock.calls.flatMap(([arg]) => sqlValues(arg));
    expect(selectVals).toContain(ATTACKER);
    expect(selectVals).not.toContain(OWNER);
    const findManyVals = noopFindMany.mock.calls.flatMap(([arg]) => sqlValues(arg?.where));
    expect(findManyVals).toContain(ATTACKER);
  });

  it("getCustomerExecutiveDashboard: all DB calls carry the owner orgId (control)", async () => {
    const { db, where, noopFindMany } = makeFullDb();
    const cache = {
      cached: jest.fn().mockImplementation((_key: string, fn: () => unknown) => fn()),
    } as unknown as CacheService;
    const svc = new CrmCeDashboardService(db, cache);
    const result = await svc.getCustomerExecutiveDashboard(OWNER);
    expect(result).toBeDefined();
    const selectVals = where.mock.calls.flatMap(([arg]) => sqlValues(arg));
    expect(selectVals).toContain(OWNER);
    const findManyVals = noopFindMany.mock.calls.flatMap(([arg]) => sqlValues(arg?.where));
    expect(findManyVals).toContain(OWNER);
  });
});

describe("CrmOrganizationsMergeService — cross-tenant isolation", () => {
  beforeEach(() => jest.clearAllMocks());

  it("mergeOrganizations: throws NotFoundException when primary org not in the attacker's org (deny)", async () => {
    jest.mocked(resolveLegacyParty).mockResolvedValue({ status: "not_found" } as never);
    jest.mocked(isLegacyResolved).mockReturnValue(false);
    const db = {} as unknown as Db;
    const cache = { invalidateNamespace: jest.fn().mockResolvedValue(undefined) } as unknown as CacheService;
    const merges = {} as unknown as PartyMergeService;
    const svc = new CrmOrganizationsMergeService(db, cache, merges);
    await expect(
      svc.mergeOrganizations(ATTACKER, { primaryId: 1, duplicateId: 2 }, "actor-1"),
    ).rejects.toThrow(NotFoundException);
    expect(jest.mocked(resolveLegacyParty)).toHaveBeenCalledWith(db, ATTACKER, expect.objectContaining({}));
  });

  it("mergeOrganizations: calls merge for the owning org and returns result (control)", async () => {
    jest.mocked(resolveLegacyParty).mockResolvedValue({ status: "resolved", party: { partyId: "party-1", deletedAt: null } } as never);
    jest.mocked(isLegacyResolved).mockReturnValue(true);
    const mergeWhere = jest.fn().mockReturnValue({ then: (fn: (v: unknown[]) => unknown) => Promise.resolve([]).then(fn), limit: jest.fn().mockResolvedValue([]) });
    const db = {
      select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where: mergeWhere, innerJoin: jest.fn().mockReturnValue({ where: mergeWhere }) }) }),
    } as unknown as Db;
    const cache = { invalidateNamespace: jest.fn().mockResolvedValue(undefined) } as unknown as CacheService;
    const merges = {
      merge: jest.fn().mockResolvedValue({ partyMergeId: "pm-1", conflicts: [] }),
    } as unknown as PartyMergeService;
    const svc = new CrmOrganizationsMergeService(db, cache, merges);
    const result = await svc.mergeOrganizations(OWNER, { primaryId: 1, duplicateId: 2 }, "actor-1");
    expect(result.success).toBe(true);
    expect(result.partyMergeId).toBe("pm-1");
    expect(jest.mocked(resolveLegacyParty)).toHaveBeenCalledWith(db, OWNER, expect.objectContaining({}));
  });
});
