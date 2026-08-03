import { Test, type TestingModule } from "@nestjs/testing";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { AutomationService } from "./automation.service";
import { NotificationsService } from "../notifications/notifications.service";
import { AutomationEmailService } from "./automation-email.service";
import { PlanLimitsService } from "../billing/core/plan-limits.service";
import { AiNodeExecutorService } from "./ai-workflow-nodes/ai-node-executor.service";
import { DRIZZLE } from "../../db/drizzle.constants";

const mockDb = {
  query: {
    automationRules: { findMany: jest.fn(), findFirst: jest.fn() },
    automationRuns: { findMany: jest.fn() },
  },
  select: jest.fn().mockReturnValue({
    from: jest.fn().mockReturnValue({
      where: jest.fn().mockResolvedValue([{ total: 0 }]),
    }),
  }),
  insert: jest.fn().mockReturnThis(),
  values: jest.fn().mockReturnThis(),
  onConflictDoNothing: jest.fn().mockResolvedValue(undefined),
  update: jest.fn().mockReturnThis(),
  set: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  orderBy: jest.fn().mockReturnThis(),
  limit: jest.fn().mockResolvedValue([]),
  delete: jest.fn().mockReturnThis(),
  returning: jest.fn().mockResolvedValue([{ id: 1 }]),
};

const mockNotifications = { create: jest.fn() };
const mockEmail = { send: jest.fn() };
const mockPlanLimits = { assertWithinLimit: jest.fn().mockResolvedValue(undefined) };
const mockAiNodeExecutor = { executeNode: jest.fn().mockResolvedValue({ ok: true }) };

describe("AutomationService — support_* actions", () => {
  let service: AutomationService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockDb.where.mockReturnThis();
    mockDb.onConflictDoNothing.mockResolvedValue(undefined);
    mockDb.returning.mockResolvedValue([{ id: 1 }]);
    mockPlanLimits.assertWithinLimit.mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AutomationService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: NotificationsService, useValue: mockNotifications },
        { provide: AutomationEmailService, useValue: mockEmail },
        { provide: PlanLimitsService, useValue: mockPlanLimits },
        { provide: AiNodeExecutorService, useValue: mockAiNodeExecutor },
      ],
    }).compile();
    service = module.get(AutomationService);
  });

  const rule = (actions: unknown[]) => ({ id: 1, conditions: [], actions: actions as never });

  it("support_assign_ticket updates the ticket's assignee, scoped to org and ticketId from the payload", async () => {
    const result = await service.runRule(
      "org1",
      rule([{ type: "support_assign_ticket", config: { assigneeId: "agent-1" } }]),
      { ticketId: 42 },
    );

    expect(result.matched).toBe(true);
    expect(result.actionResults).toEqual([{ type: "support_assign_ticket", ok: true }]);
    expect(mockDb.update).toHaveBeenCalled();
    expect(mockDb.set).toHaveBeenCalledWith(expect.objectContaining({ assigneeId: "agent-1" }));
  });

  it("support_set_priority updates the ticket's priority", async () => {
    const result = await service.runRule(
      "org1",
      rule([{ type: "support_set_priority", config: { priority: "URGENT" } }]),
      { ticketId: 42 },
    );

    expect(result.actionResults).toEqual([{ type: "support_set_priority", ok: true }]);
    expect(mockDb.set).toHaveBeenCalledWith(expect.objectContaining({ priority: "URGENT" }));
  });

  it("support_add_tag inserts a ticket tag idempotently via onConflictDoNothing", async () => {
    const result = await service.runRule(
      "org1",
      rule([{ type: "support_add_tag", config: { tagId: 7 } }]),
      { ticketId: 42 },
    );

    expect(result.actionResults).toEqual([{ type: "support_add_tag", ok: true }]);
    expect(mockDb.values).toHaveBeenCalledWith({ ticketId: 42, tagId: 7 });
    expect(mockDb.onConflictDoNothing).toHaveBeenCalled();
  });

  it("support_internal_note inserts a system-authored internal message", async () => {
    const result = await service.runRule(
      "org1",
      rule([{ type: "support_internal_note", config: { body: "Auto-escalated" } }]),
      { ticketId: 42 },
    );

    expect(result.actionResults).toEqual([{ type: "support_internal_note", ok: true }]);
    expect(mockDb.values).toHaveBeenCalledWith(
      expect.objectContaining({ ticketId: 42, authorId: null, body: "Auto-escalated", isInternal: true }),
    );
  });

  it("fails the action gracefully (not a thrown error) when the payload has no ticketId", async () => {
    const result = await service.runRule(
      "org1",
      rule([{ type: "support_assign_ticket", config: { assigneeId: "agent-1" } }]),
      {},
    );

    expect(result.matched).toBe(true);
    expect(result.actionResults).toEqual([
      { type: "support_assign_ticket", ok: false, error: "This action requires a ticketId in the event payload" },
    ]);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it("skips execution entirely when rule conditions don't match", async () => {
    const result = await service.runRule(
      "org1",
      {
        id: 1,
        conditions: [{ field: "priority", op: "eq", value: "URGENT" } as never],
        actions: [{ type: "support_assign_ticket", config: { assigneeId: "agent-1" } } as never],
      },
      { priority: "LOW" },
    );

    expect(result.matched).toBe(false);
    expect(result.actionResults).toEqual([]);
    expect(mockDb.update).not.toHaveBeenCalled();
  });
});

describe("AutomationService — rule CRUD", () => {
  let service: AutomationService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockDb.returning.mockResolvedValue([{ id: 1 }]);
    mockPlanLimits.assertWithinLimit.mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AutomationService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: NotificationsService, useValue: mockNotifications },
        { provide: AutomationEmailService, useValue: mockEmail },
        { provide: PlanLimitsService, useValue: mockPlanLimits },
        { provide: AiNodeExecutorService, useValue: mockAiNodeExecutor },
      ],
    }).compile();
    service = module.get(AutomationService);
  });

  describe("createRule", () => {
    it("rejects an unknown trigger event before touching the database", async () => {
      await expect(
        service.createRule("org1", "user1", {
          name: "bad rule",
          triggerEvent: "not.a.real.trigger",
          conditions: [],
          actions: [],
          isEnabled: true,
        } as never),
      ).rejects.toThrow(NotFoundException);
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it("propagates ForbiddenException from plan limit and does not insert", async () => {
      mockPlanLimits.assertWithinLimit.mockRejectedValueOnce(
        new ForbiddenException("Limit reached"),
      );
      await expect(
        service.createRule("org1", "user1", {
          name: "blocked rule",
          triggerEvent: "ticket.priority_changed",
          conditions: [],
          actions: [],
          isEnabled: true,
        } as never),
      ).rejects.toThrow(ForbiddenException);
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it("creates a rule for a valid ticket.* trigger", async () => {
      mockDb.returning.mockResolvedValueOnce([{ id: 5, triggerEvent: "ticket.priority_changed" }]);
      const result = await service.createRule("org1", "user1", {
        name: "Escalate urgent",
        triggerEvent: "ticket.priority_changed",
        conditions: [],
        actions: [],
        isEnabled: true,
      } as never);
      expect(result).toEqual({ id: 5, triggerEvent: "ticket.priority_changed" });
    });
  });

  describe("updateRule / deleteRule", () => {
    it("throws NotFoundException when the rule doesn't exist in the org", async () => {
      mockDb.returning.mockResolvedValueOnce([]);
      await expect(service.updateRule("org1", 999, { isEnabled: false } as never)).rejects.toThrow(
        NotFoundException,
      );
    });

    it("throws NotFoundException when deleting a rule that doesn't exist in the org", async () => {
      mockDb.returning.mockResolvedValueOnce([]);
      await expect(service.deleteRule("org1", 999)).rejects.toThrow(NotFoundException);
    });
  });

  describe("listRules / listRuns", () => {
    it("filters by trigger prefix when provided", async () => {
      mockDb.query.automationRules.findMany.mockResolvedValueOnce([]);
      await service.listRules("org1", "ticket.");
      expect(mockDb.query.automationRules.findMany).toHaveBeenCalled();
    });

    it("lists all rules for the org when no prefix is provided", async () => {
      mockDb.query.automationRules.findMany.mockResolvedValueOnce([]);
      await service.listRules("org1");
      expect(mockDb.query.automationRules.findMany).toHaveBeenCalled();
    });

    it("scopes listRuns to a specific rule when ruleId is provided", async () => {
      mockDb.query.automationRuns.findMany.mockResolvedValueOnce([]);
      await service.listRuns("org1", 5);
      expect(mockDb.query.automationRuns.findMany).toHaveBeenCalled();
    });

    it("lists all runs for the org when no ruleId is provided", async () => {
      mockDb.query.automationRuns.findMany.mockResolvedValueOnce([]);
      await service.listRuns("org1");
      expect(mockDb.query.automationRuns.findMany).toHaveBeenCalled();
    });
  });
});
