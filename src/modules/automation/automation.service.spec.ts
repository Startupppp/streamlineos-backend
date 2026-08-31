import { Test, type TestingModule } from "@nestjs/testing";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { AutomationService } from "./automation.service";
import { NotificationsService } from "../notifications/notifications.service";
import { AutomationEmailService } from "./automation-email.service";
import { AutomationWebhookService } from "./automation-webhook.service";
import { PlanLimitsService } from "../billing/core/plan-limits.service";
import { AiNodeExecutorService } from "./ai-workflow-nodes/ai-node-executor.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import { automationRuns } from "../../db/schema";

const mockDb = {
  query: {
    automationRules: { findMany: jest.fn(), findFirst: jest.fn() },
    automationRuns: { findMany: jest.fn() },
  },
  select: jest.fn().mockReturnValue({
    from: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue(
        Object.assign(Promise.resolve([{ total: 0 }]), {
          limit: jest.fn().mockResolvedValue([{ status: "ACTIVE" }]),
        }),
      ),
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
const mockWebhook = { dispatchWebhook: jest.fn().mockResolvedValue(undefined) };
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
        { provide: AutomationWebhookService, useValue: mockWebhook },
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
        { provide: AutomationWebhookService, useValue: mockWebhook },
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

describe("AutomationService.runAutomationsForEvent() — batch writes", () => {
  let service: AutomationService;
  let insertedRuns: unknown[];
  let insertedByActions: unknown[];
  let updatedRuleIds: number[];

  beforeEach(async () => {
    jest.clearAllMocks();
    insertedRuns = [];
    insertedByActions = [];
    updatedRuleIds = [];

    mockDb.query.automationRules.findMany.mockResolvedValue([]);
    mockDb.query.automationRuns.findMany.mockResolvedValue([]);

    // Capture by table. This used to push every insert into `insertedRuns`,
    // which was accurate only while run records were the sole write. Actions
    // now insert their own rows — a `create_task` action writes a task — so the
    // undifferentiated array counted tasks as runs and every length assertion
    // read one too many.
    mockDb.insert.mockImplementation((table: unknown) => ({
      values: jest.fn().mockImplementation((rows: unknown) => {
        const arr = Array.isArray(rows) ? rows : [rows];
        if (table === automationRuns) insertedRuns.push(...arr);
        else insertedByActions.push(...arr);
        return Promise.resolve([{ id: 1 }]);
      }),
    }));

    mockDb.update.mockImplementation(() => ({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockImplementation((_cond: unknown, ids?: number[]) => {
          if (ids) updatedRuleIds.push(...ids);
          return Promise.resolve([]);
        }),
      }),
    }));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AutomationService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: NotificationsService, useValue: mockNotifications },
        { provide: AutomationEmailService, useValue: mockEmail },
        { provide: AutomationWebhookService, useValue: mockWebhook },
        { provide: PlanLimitsService, useValue: mockPlanLimits },
        { provide: AiNodeExecutorService, useValue: mockAiNodeExecutor },
      ],
    }).compile();
    service = module.get(AutomationService);
  });

  it("no rules for trigger → returns without any inserts or updates", async () => {
    mockDb.query.automationRules.findMany.mockResolvedValueOnce([]);

    await service.runAutomationsForEvent("org1", "ticket.priority_changed", { ticketId: 1 });

    expect(insertedRuns).toHaveLength(0);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it("one matched rule → one run record inserted with status 'success', runCount updated", async () => {
    mockDb.query.automationRules.findMany.mockResolvedValueOnce([
      { id: 7, conditions: [], actions: [{ type: "create_task", config: { title: "Task A" } }] },
    ]);

    await service.runAutomationsForEvent("org1", "ticket.priority_changed", { ticketId: 1 });

    expect(insertedRuns).toHaveLength(1);
    expect((insertedRuns[0] as Record<string, unknown>)["status"]).toBe("success");
    expect((insertedRuns[0] as Record<string, unknown>)["ruleId"]).toBe(7);
    expect(mockDb.update).toHaveBeenCalled();

    // Separating the captures must not lose the fact that the action ran: a
    // 'success' run record beside no task at all would be the worse bug.
    expect(insertedByActions).toContainEqual(
      expect.objectContaining({ title: "Task A" }),
    );
  });

  it("rule conditions don't match → run record inserted with status 'skipped', runCount NOT updated", async () => {
    mockDb.query.automationRules.findMany.mockResolvedValueOnce([
      {
        id: 8,
        conditions: [{ field: "priority", op: "eq", value: "URGENT" }],
        actions: [],
      },
    ]);

    await service.runAutomationsForEvent("org1", "ticket.priority_changed", { priority: "LOW" });

    expect(insertedRuns).toHaveLength(1);
    expect((insertedRuns[0] as Record<string, unknown>)["status"]).toBe("skipped");
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it("two rules — one matching, one not → two run records, only matched rule's id sent to update", async () => {
    mockDb.query.automationRules.findMany.mockResolvedValueOnce([
      { id: 10, conditions: [], actions: [{ type: "create_task", config: { title: "T" } }] },
      { id: 11, conditions: [{ field: "priority", op: "eq", value: "URGENT" }], actions: [] },
    ]);

    await service.runAutomationsForEvent("org1", "ticket.priority_changed", { priority: "LOW" });

    expect(insertedRuns).toHaveLength(2);
    const statuses = (insertedRuns as Array<Record<string, unknown>>).map((r) => r["status"]);
    expect(statuses).toContain("success");
    expect(statuses).toContain("skipped");
    expect(mockDb.update).toHaveBeenCalledTimes(1);
  });

  it("action failure → run record inserted with status 'failed', error message set", async () => {
    mockNotifications.create.mockRejectedValueOnce(new Error("notification failed"));

    mockDb.query.automationRules.findMany.mockResolvedValueOnce([
      { id: 12, conditions: [], actions: [{ type: "notify_all", config: { title: "T", message: "M" } }] },
    ]);

    await service.runAutomationsForEvent("org1", "ticket.priority_changed", { ticketId: 1 });

    expect(insertedRuns).toHaveLength(1);
    const run = insertedRuns[0] as Record<string, unknown>;
    expect(run["status"]).toBe("failed");
    expect(typeof run["error"]).toBe("string");
  });

  it("running the same event twice → two separate sets of run records (one per invocation)", async () => {
    mockDb.query.automationRules.findMany.mockResolvedValue([
      { id: 20, conditions: [], actions: [{ type: "create_task", config: { title: "T" } }] },
    ]);

    await service.runAutomationsForEvent("org1", "ticket.priority_changed", { ticketId: 1 });
    await service.runAutomationsForEvent("org1", "ticket.priority_changed", { ticketId: 2 });

    expect(insertedRuns).toHaveLength(2);
  });
});

describe("AutomationService — support_add_tag org-scoping", () => {
  let service: AutomationService;

  function makeModule(tagLookupResult: Array<{ id: number }>) {
    jest.clearAllMocks();
    const limitMock = jest.fn().mockResolvedValue(tagLookupResult);
    const selectMock = jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue(
          Object.assign(Promise.resolve([]), { limit: limitMock }),
        ),
      }),
    });
    const insertTracker: unknown[] = [];
    const localDb = {
      query: { automationRules: { findMany: jest.fn(), findFirst: jest.fn() }, automationRuns: { findMany: jest.fn() } },
      select: selectMock,
      insert: jest.fn().mockImplementation(() => ({
        values: jest.fn().mockImplementation((row: unknown) => {
          insertTracker.push(row);
          return { onConflictDoNothing: jest.fn().mockResolvedValue(undefined) };
        }),
      })),
      update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }) }) }),
    };
    return { localDb, insertTracker, limitMock };
  }

  async function buildService(localDb: unknown) {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AutomationService,
        { provide: DRIZZLE, useValue: localDb },
        { provide: NotificationsService, useValue: { create: jest.fn() } },
        { provide: AutomationEmailService, useValue: { send: jest.fn() } },
        { provide: AutomationWebhookService, useValue: { dispatchWebhook: jest.fn().mockResolvedValue(undefined) } },
        { provide: PlanLimitsService, useValue: { assertWithinLimit: jest.fn() } },
        { provide: AiNodeExecutorService, useValue: { executeNode: jest.fn() } },
      ],
    }).compile();
    return module.get(AutomationService);
  }

  it("proof — skipping the tag lookup (always inserts) lets a foreign tag be applied", async () => {
    const { localDb, insertTracker } = makeModule([{ id: 99 }]);
    service = await buildService(localDb);

    const result = await service.executeAction(
      "org-a",
      { type: "support_add_tag", config: { tagId: 99 } },
      { ticketId: 10 },
    );

    expect(result.ok).toBe(true);
    expect(insertTracker).toContainEqual({ ticketId: 10, tagId: 99 });
  });

  it("rejects a tagId that does not belong to the caller's org (cross-org tag isolation)", async () => {
    const { localDb } = makeModule([]);
    service = await buildService(localDb);

    const result = await service.executeAction(
      "org-a",
      { type: "support_add_tag", config: { tagId: 999 } },
      { ticketId: 10 },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found in this organisation/i);
  });

  it("allows a valid org-owned tag and inserts without error", async () => {
    const { localDb, insertTracker } = makeModule([{ id: 7 }]);
    service = await buildService(localDb);

    const result = await service.executeAction(
      "org-a",
      { type: "support_add_tag", config: { tagId: 7 } },
      { ticketId: 42 },
    );

    expect(result.ok).toBe(true);
    expect(insertTracker).toContainEqual({ ticketId: 42, tagId: 7 });
  });
});

describe("AutomationService — W-6: live membership check on assigneeId", () => {
  async function buildServiceWithMemberLookup(memberRow: { status: string } | null) {
    jest.clearAllMocks();

    const limitMock = jest.fn().mockResolvedValue(memberRow ? [memberRow] : []);
    const localDb = {
      query: {
        automationRules: { findMany: jest.fn(), findFirst: jest.fn() },
        automationRuns: { findMany: jest.fn() },
      },
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue(
            Object.assign(Promise.resolve([]), { limit: limitMock }),
          ),
        }),
      }),
      insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) }),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }),
        }),
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AutomationService,
        { provide: DRIZZLE, useValue: localDb },
        { provide: NotificationsService, useValue: { create: jest.fn() } },
        { provide: AutomationEmailService, useValue: { send: jest.fn() } },
        { provide: AutomationWebhookService, useValue: { dispatchWebhook: jest.fn().mockResolvedValue(undefined) } },
        { provide: PlanLimitsService, useValue: { assertWithinLimit: jest.fn() } },
        { provide: AiNodeExecutorService, useValue: { executeNode: jest.fn() } },
      ],
    }).compile();

    return { service: module.get(AutomationService), localDb };
  }

  it("proof — skipping the membership check (active member) lets support_assign_ticket succeed", async () => {
    const { service } = await buildServiceWithMemberLookup({ status: "ACTIVE" });

    const result = await service.executeAction(
      "org-a",
      { type: "support_assign_ticket", config: { assigneeId: "agent-1" } },
      { ticketId: 5 },
    );

    expect(result.ok).toBe(true);
  });

  it("support_assign_ticket rejects a departed assignee (not found)", async () => {
    const { service } = await buildServiceWithMemberLookup(null);

    const result = await service.executeAction(
      "org-a",
      { type: "support_assign_ticket", config: { assigneeId: "gone-agent" } },
      { ticketId: 5 },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not an active member/i);
  });

  it("support_assign_ticket rejects a SUSPENDED assignee", async () => {
    const { service } = await buildServiceWithMemberLookup({ status: "SUSPENDED" });

    const result = await service.executeAction(
      "org-a",
      { type: "support_assign_ticket", config: { assigneeId: "suspended-agent" } },
      { ticketId: 5 },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not an active member/i);
  });

  it("create_task with an assigneeId rejects a departed user (not found)", async () => {
    const { service } = await buildServiceWithMemberLookup(null);

    const result = await service.executeAction(
      "org-a",
      { type: "create_task", config: { title: "Do it", assigneeId: "gone-user" } },
      {},
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not an active member/i);
  });

  it("create_task with an assigneeId allows an active member", async () => {
    const { service } = await buildServiceWithMemberLookup({ status: "ACTIVE" });

    const result = await service.executeAction(
      "org-a",
      { type: "create_task", config: { title: "Do it", assigneeId: "good-user" } },
      {},
    );

    expect(result.ok).toBe(true);
  });

  it("create_task without an assigneeId skips the membership check entirely", async () => {
    const limitMock = jest.fn();
    const localDb = {
      query: {
        automationRules: { findMany: jest.fn(), findFirst: jest.fn() },
        automationRuns: { findMany: jest.fn() },
      },
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue(
            Object.assign(Promise.resolve([]), { limit: limitMock }),
          ),
        }),
      }),
      insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) }),
      update: jest.fn(),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AutomationService,
        { provide: DRIZZLE, useValue: localDb },
        { provide: NotificationsService, useValue: { create: jest.fn() } },
        { provide: AutomationEmailService, useValue: { send: jest.fn() } },
        { provide: AutomationWebhookService, useValue: { dispatchWebhook: jest.fn().mockResolvedValue(undefined) } },
        { provide: PlanLimitsService, useValue: { assertWithinLimit: jest.fn() } },
        { provide: AiNodeExecutorService, useValue: { executeNode: jest.fn() } },
      ],
    }).compile();
    const service = module.get(AutomationService);

    const result = await service.executeAction(
      "org-a",
      { type: "create_task", config: { title: "Unassigned task" } },
      {},
    );

    expect(result.ok).toBe(true);
    expect(limitMock).not.toHaveBeenCalled();
  });
});
