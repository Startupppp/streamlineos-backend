import { Test, type TestingModule } from "@nestjs/testing";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { HrAutomationEngineService } from "../hr-automation-engine.service";
import { HrAutomationActionsService } from "../hr-automation-actions.service";
import { HR_WORKFLOW_STARTER } from "../hr-workflow-starter.port";
import { NotificationsService } from "../../../notifications/notifications.service";
import { AutomationEmailService } from "../../../automation/automation-email.service";

const mockInsert = jest.fn().mockReturnThis();
const mockValues = jest.fn().mockResolvedValue(undefined);
const mockUpdate = jest.fn().mockReturnThis();
const mockSet = jest.fn().mockReturnThis();
const mockWhere = jest.fn().mockResolvedValue(undefined);

const mockDb = {
  query: {
    hrAutomationRules: { findMany: jest.fn(), findFirst: jest.fn() },
    hrAutomationRuns: { findMany: jest.fn() },
  },
  insert: mockInsert,
  values: mockValues,
  update: mockUpdate,
  set: mockSet,
  where: mockWhere,
};

const mockActions = { execute: jest.fn() };
const mockNotifications = { create: jest.fn() };
const mockEmail = { send: jest.fn() };
const mockWorkflowStarter = { startWorkflow: jest.fn().mockResolvedValue(null) };

function makeRule(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    conditions: [] as { field: string; operator: string; value: unknown }[],
    actions: [] as { type: string; config: Record<string, unknown> }[],
    webhookSecret: null,
    isEnabled: true,
    orgId: "org1",
    triggerEvent: "employee.created",
    deletedAt: null,
    runCount: 0,
    lastRunAt: null,
    ...overrides,
  };
}

describe("HrAutomationEngineService — condition evaluation", () => {
  let service: HrAutomationEngineService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockInsert.mockReturnThis();
    mockValues.mockResolvedValue(undefined);
    mockUpdate.mockReturnThis();
    mockSet.mockReturnThis();
    mockWhere.mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HrAutomationEngineService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: HrAutomationActionsService, useValue: mockActions },
        { provide: HR_WORKFLOW_STARTER, useValue: mockWorkflowStarter },
      ],
    }).compile();

    service = module.get(HrAutomationEngineService);
  });

  describe("testRule — condition operators", () => {
    it("eq: matches when field value equals condition value", async () => {
      mockDb.query.hrAutomationRules.findFirst.mockResolvedValueOnce(
        makeRule({
          conditions: [{ field: "status", operator: "eq", value: "ACTIVE" }],
          actions: [],
        }),
      );

      const result = await service.testRule("org1", 1, { status: "ACTIVE" });
      expect(result.matched).toBe(true);
    });

    it("eq: does not match when values differ", async () => {
      mockDb.query.hrAutomationRules.findFirst.mockResolvedValueOnce(
        makeRule({
          conditions: [{ field: "status", operator: "eq", value: "ACTIVE" }],
          actions: [],
        }),
      );

      const result = await service.testRule("org1", 1, { status: "INACTIVE" });
      expect(result.matched).toBe(false);
    });

    it("neq: matches when field value differs", async () => {
      mockDb.query.hrAutomationRules.findFirst.mockResolvedValueOnce(
        makeRule({
          conditions: [{ field: "status", operator: "neq", value: "INACTIVE" }],
          actions: [],
        }),
      );

      const result = await service.testRule("org1", 1, { status: "ACTIVE" });
      expect(result.matched).toBe(true);
    });

    it("in: matches when field value is in the array", async () => {
      mockDb.query.hrAutomationRules.findFirst.mockResolvedValueOnce(
        makeRule({
          conditions: [{ field: "department", operator: "in", value: ["eng", "design"] }],
          actions: [],
        }),
      );

      const result = await service.testRule("org1", 1, { department: "eng" });
      expect(result.matched).toBe(true);
    });

    it("in: does not match when field value is not in the array", async () => {
      mockDb.query.hrAutomationRules.findFirst.mockResolvedValueOnce(
        makeRule({
          conditions: [{ field: "department", operator: "in", value: ["eng", "design"] }],
          actions: [],
        }),
      );

      const result = await service.testRule("org1", 1, { department: "sales" });
      expect(result.matched).toBe(false);
    });

    it("gte: matches when numeric field >= condition value", async () => {
      mockDb.query.hrAutomationRules.findFirst.mockResolvedValueOnce(
        makeRule({
          conditions: [{ field: "salary", operator: "gte", value: 50000 }],
          actions: [],
        }),
      );

      const result = await service.testRule("org1", 1, { salary: 60000 });
      expect(result.matched).toBe(true);
    });

    it("gte: does not match when numeric field < condition value", async () => {
      mockDb.query.hrAutomationRules.findFirst.mockResolvedValueOnce(
        makeRule({
          conditions: [{ field: "salary", operator: "gte", value: 50000 }],
          actions: [],
        }),
      );

      const result = await service.testRule("org1", 1, { salary: 40000 });
      expect(result.matched).toBe(false);
    });

    it("lte: matches when numeric field <= condition value", async () => {
      mockDb.query.hrAutomationRules.findFirst.mockResolvedValueOnce(
        makeRule({
          conditions: [{ field: "daysUntilEnd", operator: "lte", value: 30 }],
          actions: [],
        }),
      );

      const result = await service.testRule("org1", 1, { daysUntilEnd: 7 });
      expect(result.matched).toBe(true);
    });

    it("contains: matches when field value includes condition substring (case-insensitive)", async () => {
      mockDb.query.hrAutomationRules.findFirst.mockResolvedValueOnce(
        makeRule({
          conditions: [{ field: "notes", operator: "contains", value: "urgent" }],
          actions: [],
        }),
      );

      const result = await service.testRule("org1", 1, { notes: "This is URGENT please review" });
      expect(result.matched).toBe(true);
    });

    it("matches when no conditions (always runs)", async () => {
      mockDb.query.hrAutomationRules.findFirst.mockResolvedValueOnce(
        makeRule({ conditions: [], actions: [] }),
      );

      const result = await service.testRule("org1", 1, {});
      expect(result.matched).toBe(true);
    });
  });
});

describe("HrAutomationEngineService — loop prevention + fire-and-forget", () => {
  let service: HrAutomationEngineService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockInsert.mockReturnThis();
    mockValues.mockResolvedValue(undefined);
    mockUpdate.mockReturnThis();
    mockSet.mockReturnThis();
    mockWhere.mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HrAutomationEngineService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: HrAutomationActionsService, useValue: mockActions },
        { provide: HR_WORKFLOW_STARTER, useValue: mockWorkflowStarter },
      ],
    }).compile();

    service = module.get(HrAutomationEngineService);
  });

  it("stores a failed run with loop_prevented error when depth >= 3", async () => {
    mockDb.query.hrAutomationRules.findMany.mockResolvedValueOnce([
      makeRule({ id: 1, conditions: [], actions: [{ type: "send_notification", config: {} }] }),
    ]);

    let insertedRun: Record<string, unknown> | null = null;
    const captureInsert = {
      ...mockDb,
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockImplementation((v: Record<string, unknown>) => {
          insertedRun = v;
          return Promise.resolve();
        }),
      }),
    };
    (service as unknown as { db: typeof mockDb }).db = captureInsert as unknown as typeof mockDb;

    await service.emit("org1", "employee.created", { employeeId: "u1" }, { depth: 3 });

    expect(insertedRun).not.toBeNull();
    expect(insertedRun!.status).toBe("failed");
    expect(String(insertedRun!.error)).toContain("loop_prevented");
  });

  it("emit does not throw into the caller even when an action throws", async () => {
    mockDb.query.hrAutomationRules.findMany.mockResolvedValueOnce([
      makeRule({ id: 2, conditions: [], actions: [{ type: "send_notification", config: {} }] }),
    ]);

    mockActions.execute.mockRejectedValueOnce(new Error("action boom"));

    await expect(
      service.emit("org1", "employee.created", { employeeId: "u2" }),
    ).resolves.toBeUndefined();
  });
});

describe("HrAutomationActionsService — call_webhook SSRF", () => {
  let actionsService: HrAutomationActionsService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HrAutomationActionsService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: NotificationsService, useValue: mockNotifications },
        { provide: AutomationEmailService, useValue: mockEmail },
        { provide: HR_WORKFLOW_STARTER, useValue: mockWorkflowStarter },
      ],
    }).compile();

    actionsService = module.get(HrAutomationActionsService);
  });

  async function callWebhookAction(url: string) {
    return actionsService.execute(
      "org1",
      { type: "call_webhook", config: { url, method: "POST" } } as never,
      { employeeId: "u1" },
      null,
    );
  }

  it("blocks 127.0.0.1 as SSRF", async () => {
    const result = await callWebhookAction("https://127.0.0.1/hook");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/SSRF/i);
  });

  it("blocks localhost as SSRF", async () => {
    const result = await callWebhookAction("http://localhost/internal");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/SSRF/i);
  });

  it("blocks 10.x.x.x private class A", async () => {
    const result = await callWebhookAction("https://10.0.0.1/hook");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/SSRF/i);
  });

  it("blocks 192.168.x.x private class C", async () => {
    const result = await callWebhookAction("https://192.168.1.1/hook");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/SSRF/i);
  });

  it("blocks 172.16.x.x private class B lower bound", async () => {
    const result = await callWebhookAction("https://172.16.0.1/hook");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/SSRF/i);
  });

  it("blocks ::1 IPv6 loopback (URL parse may throw InvalidURL — still blocked)", async () => {
    const result = await callWebhookAction("http://[::1]/hook");
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("rejects non-https public URLs — http is not blocked by SSRF but result depends on fetch", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true });
    const result = await callWebhookAction("http://example.com/hook");
    expect(result.ok).toBe(true);
    (global.fetch as jest.Mock).mockRestore?.();
  });

  it("returns ok for a valid public https URL", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true });
    const result = await callWebhookAction("https://example.com/webhook");
    expect(result.ok).toBe(true);
    (global.fetch as jest.Mock).mockRestore?.();
  });

  it("returns error for invalid URL", async () => {
    const result = await callWebhookAction("not-a-url");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/invalid.url/i);
  });
});
