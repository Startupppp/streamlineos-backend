import { NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { AutomationService } from "./automation.service";
import { NotificationsService } from "../notifications/notifications.service";
import { AutomationEmailService } from "./automation-email.service";
import { PlanLimitsService } from "../billing/core/plan-limits.service";
import { AiNodeExecutorService } from "./ai-workflow-nodes/ai-node-executor.service";
import { DRIZZLE } from "../../db/drizzle.constants";

describe("AutomationService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner-uuid";
  const ATTACKER_ORG = "org-attacker-uuid";
  const RULE_ID = 42;
  const USER_ID = "user-uuid-1";

  function makeMockDb(overrides?: Record<string, unknown>) {
    return {
      query: {
        automationRules: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null) },
        automationRuns: { findMany: jest.fn().mockResolvedValue([]) },
      },
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([{ total: 0 }]) }),
      }),
      insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([{ id: 1 }]) }) }),
      update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }) }) }),
      delete: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }) }),
      ...overrides,
    };
  }

  async function buildSvc(mockDb: ReturnType<typeof makeMockDb>) {
    const mod = await Test.createTestingModule({
      providers: [
        AutomationService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: NotificationsService, useValue: { create: jest.fn() } },
        { provide: AutomationEmailService, useValue: { send: jest.fn() } },
        { provide: PlanLimitsService, useValue: { assertWithinLimit: jest.fn().mockResolvedValue(undefined) } },
        { provide: AiNodeExecutorService, useValue: { executeNode: jest.fn().mockResolvedValue({ ok: true }) } },
      ],
    }).compile();
    return mod.get(AutomationService);
  }

  describe("testRule", () => {
    it("throws NotFoundException when rule belongs to a different org (cross-tenant isolation)", async () => {
      const db = makeMockDb();
      (db.query.automationRules.findFirst as jest.Mock).mockResolvedValue(null);
      const svc = await buildSvc(db);

      await expect(svc.testRule(ATTACKER_ORG, RULE_ID, {})).rejects.toThrow(NotFoundException);
      expect(db.query.automationRules.findFirst).toHaveBeenCalledTimes(1);
    });

    it("runs the test for the owning org (control)", async () => {
      const db = makeMockDb();
      (db.query.automationRules.findFirst as jest.Mock).mockResolvedValue({
        id: RULE_ID,
        orgId: OWNER_ORG,
        triggerEvent: "support.ticket.created",
        conditions: [],
        actions: [],
      });
      const svc = await buildSvc(db);

      const result = await svc.testRule(OWNER_ORG, RULE_ID, {});
      expect(result.matched).toBe(true);
      expect(result.status).toBe("success");
    });
  });

  describe("updateRule", () => {
    it("throws NotFoundException when rule belongs to a different org (cross-tenant isolation)", async () => {
      const db = makeMockDb();
      (db.update as jest.Mock).mockReturnValue({
        set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }) }),
      });
      const svc = await buildSvc(db);

      await expect(svc.updateRule(ATTACKER_ORG, RULE_ID, { name: "Hacked" })).rejects.toThrow(NotFoundException);
    });

    it("updates rule for the owning org (control)", async () => {
      const RULE_ROW = { id: RULE_ID, orgId: OWNER_ORG, name: "Updated Rule" };
      const db = makeMockDb();
      (db.update as jest.Mock).mockReturnValue({
        set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([RULE_ROW]) }) }),
      });
      const svc = await buildSvc(db);

      const result = await svc.updateRule(OWNER_ORG, RULE_ID, { name: "Updated Rule" });
      expect(result).toMatchObject({ id: RULE_ID });
    });
  });

  describe("deleteRule", () => {
    it("throws NotFoundException when rule belongs to a different org (cross-tenant isolation)", async () => {
      const db = makeMockDb();
      (db.delete as jest.Mock).mockReturnValue({
        where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }),
      });
      const svc = await buildSvc(db);

      await expect(svc.deleteRule(ATTACKER_ORG, RULE_ID)).rejects.toThrow(NotFoundException);
    });

    it("deletes rule for the owning org (control)", async () => {
      const RULE_ROW = { id: RULE_ID, orgId: OWNER_ORG, name: "My Rule" };
      const db = makeMockDb();
      (db.delete as jest.Mock).mockReturnValue({
        where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([RULE_ROW]) }),
      });
      const svc = await buildSvc(db);

      const result = await svc.deleteRule(OWNER_ORG, RULE_ID);
      expect(result).toMatchObject({ success: true });
    });
  });

  describe("listRules", () => {
    it("queries rules scoped to the calling org (cross-tenant isolation)", async () => {
      const db = makeMockDb();
      const svc = await buildSvc(db);

      const result = await svc.listRules(ATTACKER_ORG);
      expect(result.data).toHaveLength(0);
      expect(db.query.automationRules.findMany).toHaveBeenCalledTimes(1);
    });

    it("returns rules for the owning org (control)", async () => {
      const RULE_ROW = { id: RULE_ID, orgId: OWNER_ORG, name: "My Rule", triggerEvent: "support.ticket.created" };
      const db = makeMockDb();
      (db.query.automationRules.findMany as jest.Mock).mockResolvedValue([RULE_ROW]);
      (db.select as jest.Mock).mockReturnValue({
        from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([{ total: 1 }]) }),
      });
      const svc = await buildSvc(db);

      const result = await svc.listRules(OWNER_ORG);
      expect(result.data).toHaveLength(1);
      expect(result.data[0]).toMatchObject({ id: RULE_ID });
    });
  });
});
