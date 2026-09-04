import type { Db } from "../../db/drizzle.module";
import type { AuditService } from "../../common/audit/audit.service";
import type { CacheService } from "../../common/cache/cache.service";
import { stubService } from "../../test/service-stub.spec-fixtures";
import type { PlanLimitsService } from "../billing/core/plan-limits.service";
import type { CrmAutomationBusService } from "../crm/automation-studio/crm-automation-bus.service";
import { QuotesLifecycleService } from "./quotes-lifecycle.service";

describe("QuotesLifecycleService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const QUOTE_ID = 7;
  const USER_ID = "user-abc";

  function makeDb(quoteRow: unknown): Db {
    const findFirst = jest.fn().mockResolvedValue(quoteRow);
    return {
      query: { quotes: { findFirst } },
      update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([quoteRow]) }) }) }),
      select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }) }),
    } as unknown as Db;
  }

  it("returns null when quote belongs to a different org (cross-tenant isolation)", async () => {
    const db = makeDb(null);
    const mockCache = stubService<CacheService>({ cached: jest.fn(), invalidateForOrg: jest.fn(), invalidateNamespace: jest.fn().mockResolvedValue(undefined) });
    const mockAudit = stubService<AuditService>({ log: jest.fn() });
    const mockBus = stubService<CrmAutomationBusService>({ emit: jest.fn().mockResolvedValue(undefined) });
    const mockPlanLimits = stubService<PlanLimitsService>({});
    const svc = new QuotesLifecycleService(db, mockCache, mockAudit, mockBus, mockPlanLimits);
    const result = await svc.send(ATTACKER, USER_ID, QUOTE_ID);
    expect(result).toBeNull();
  });

  it("proceeds for the owning org (control — same-tenant)", async () => {
    const quoteRow = { id: QUOTE_ID, orgId: OWNER, status: "DRAFT", clientId: 1, approvalStatus: null, quoteNumber: "Q-001", dealId: null };
    const db = makeDb(quoteRow);
    const mockCache = stubService<CacheService>({ cached: jest.fn(), invalidateForOrg: jest.fn(), invalidateNamespace: jest.fn().mockResolvedValue(undefined) });
    const mockAudit = stubService<AuditService>({ log: jest.fn() });
    const mockBus = stubService<CrmAutomationBusService>({ emit: jest.fn().mockResolvedValue(undefined) });
    const mockPlanLimits = stubService<PlanLimitsService>({});
    const svc = new QuotesLifecycleService(db, mockCache, mockAudit, mockBus, mockPlanLimits);
    const result = await svc.send(OWNER, USER_ID, QUOTE_ID);
    expect(result).not.toBeNull();
  });
});
