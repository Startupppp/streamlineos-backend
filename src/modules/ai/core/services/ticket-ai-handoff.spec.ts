jest.mock("../../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: (db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(db),
}));

import { NotFoundException } from "@nestjs/common";
import { TicketAiService } from "./ticket-ai.service";
import type { Db } from "../../../../db/drizzle.module";
import type { AiGatewayService } from "../gateway/ai-gateway.service";
import type { AuditService } from "../../../../common/audit/audit.service";

const mockAudit = { log: jest.fn() } as unknown as AuditService;

beforeEach(() => {
  jest.resetAllMocks();
});

function makeSelectChain(rows: unknown[]) {
  const limit = jest.fn().mockResolvedValue(rows);
  const where = jest.fn().mockReturnValue({ limit });
  const innerJoin = jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ limit }) });
  const from = jest.fn().mockReturnValue({ where, innerJoin, limit });
  return { from, where, limit };
}

describe("TicketAiService.handoffSummary", () => {
  it("calls gateway with feature 'ticket.handoff' and returns structured output", async () => {
    const ticket = {
      id: 1,
      title: "Fix login bug",
      description: "Users cannot log in when 2FA is enabled",
      type: "bug",
      status: "in_progress",
      priority: "high",
      projectId: 10,
    };

    const handoffResult = {
      currentState: "Work is in progress.",
      keyDecisions: ["Use JWT refresh token"],
      nextAction: "Write integration tests",
      blockers: [],
      citations: [{ source: "description" as const, excerpt: "Users cannot log in" }],
    };

    const ticketChain = makeSelectChain([ticket]);
    const commentsChain = makeSelectChain([]);

    let selectCallCount = 0;
    const mockDb = {
      select: jest.fn().mockImplementation(() => {
        selectCallCount += 1;
        return selectCallCount === 1 ? ticketChain : commentsChain;
      }),
    } as unknown as Db;

    const mockGateway = {
      invokeStructured: jest.fn().mockResolvedValue({ ok: true, data: handoffResult }),
    } as unknown as AiGatewayService;

    const svc = new TicketAiService(mockDb, mockGateway, mockAudit);
    const result = await svc.handoffSummary("org-1", "user-1", 10, 1);

    expect(mockGateway.invokeStructured).toHaveBeenCalledTimes(1);
    expect(mockGateway.invokeStructured).toHaveBeenCalledWith(
      expect.objectContaining({
        feature: "ticket.handoff",
        charge: true,
        tier: "fast",
        maxTokens: 768,
      }),
    );
    expect(result).toEqual(handoffResult);
    expect(mockAudit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ai.ticket.handoff", orgId: "org-1", userId: "user-1" }),
    );
  });

  it("throws NotFoundException when ticket not found", async () => {
    const emptyChain = makeSelectChain([]);
    const mockDb = {
      select: jest.fn().mockReturnValue(emptyChain),
    } as unknown as Db;

    const mockGateway = {
      invokeStructured: jest.fn(),
    } as unknown as AiGatewayService;

    const svc = new TicketAiService(mockDb, mockGateway, mockAudit);
    await expect(svc.handoffSummary("org-1", "user-1", 10, 999)).rejects.toThrow(NotFoundException);
    expect(mockGateway.invokeStructured).not.toHaveBeenCalled();
  });
});

describe("TicketAiService.extractMeetingActions", () => {
  it("calls gateway with feature 'pm.extract-meeting-actions' and returns { ...data, suggestions: true }", async () => {
    const meeting = {
      id: 5,
      title: "Sprint Planning",
      type: "planning",
      scheduledAt: new Date("2026-07-16T10:00:00Z"),
      notes: "We decided to split the auth service. Alice will handle JWT, Bob will write tests.",
    };

    const extractResult = {
      actions: [
        { title: "Handle JWT implementation", ownerName: "Alice", dueDateHint: "", rationale: "Explicitly assigned in notes" },
        { title: "Write tests for auth service", ownerName: "Bob", dueDateHint: "", rationale: "Explicitly assigned in notes" },
      ],
      summary: "Sprint planning focused on auth service split.",
    };

    const meetingChain = makeSelectChain([meeting]);
    const attendeesChain = {
      from: jest.fn().mockReturnValue({
        innerJoin: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
        }),
        where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
        limit: jest.fn().mockResolvedValue([]),
      }),
    };
    const existingActionsChain = makeSelectChain([]);

    let selectCallCount = 0;
    const mockDb = {
      select: jest.fn().mockImplementation(() => {
        selectCallCount += 1;
        if (selectCallCount === 1) return meetingChain;
        if (selectCallCount === 2) return attendeesChain;
        return existingActionsChain;
      }),
    } as unknown as Db;

    const mockGateway = {
      invokeStructured: jest.fn().mockResolvedValue({ ok: true, data: extractResult }),
    } as unknown as AiGatewayService;

    const svc = new TicketAiService(mockDb, mockGateway, mockAudit);
    const result = await svc.extractMeetingActions("org-1", "user-1", 10, 5);

    expect(mockGateway.invokeStructured).toHaveBeenCalledTimes(1);
    expect(mockGateway.invokeStructured).toHaveBeenCalledWith(
      expect.objectContaining({
        feature: "pm.extract-meeting-actions",
        charge: true,
        tier: "fast",
        maxTokens: 1024,
      }),
    );
    expect(result).toEqual({ ...extractResult, suggestions: true });
    expect(mockAudit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ai.meeting.extract-actions", orgId: "org-1", userId: "user-1" }),
    );
  });

  it("returns empty actions early when meeting has no notes, gateway is NOT called", async () => {
    const meeting = {
      id: 5,
      title: "Empty Meeting",
      type: "meeting",
      scheduledAt: null,
      notes: null,
    };

    const meetingChain = makeSelectChain([meeting]);
    const mockDb = {
      select: jest.fn().mockReturnValue(meetingChain),
    } as unknown as Db;

    const mockGateway = {
      invokeStructured: jest.fn(),
    } as unknown as AiGatewayService;

    const svc = new TicketAiService(mockDb, mockGateway, mockAudit);
    const result = await svc.extractMeetingActions("org-1", "user-1", 10, 5);

    expect(mockGateway.invokeStructured).not.toHaveBeenCalled();
    expect(result).toEqual({
      actions: [],
      summary: "Meeting has no notes to extract actions from.",
      suggestions: true,
    });
  });

  it("returns empty actions early when meeting notes is empty string, gateway is NOT called", async () => {
    const meeting = {
      id: 5,
      title: "Empty Notes Meeting",
      type: "standup",
      scheduledAt: null,
      notes: "   ",
    };

    const meetingChain = makeSelectChain([meeting]);
    const mockDb = {
      select: jest.fn().mockReturnValue(meetingChain),
    } as unknown as Db;

    const mockGateway = {
      invokeStructured: jest.fn(),
    } as unknown as AiGatewayService;

    const svc = new TicketAiService(mockDb, mockGateway, mockAudit);
    const result = await svc.extractMeetingActions("org-1", "user-1", 10, 5);

    expect(mockGateway.invokeStructured).not.toHaveBeenCalled();
    expect(result).toEqual({
      actions: [],
      summary: "Meeting has no notes to extract actions from.",
      suggestions: true,
    });
  });

  it("throws NotFoundException when meeting not found", async () => {
    const emptyChain = makeSelectChain([]);
    const mockDb = {
      select: jest.fn().mockReturnValue(emptyChain),
    } as unknown as Db;

    const mockGateway = {
      invokeStructured: jest.fn(),
    } as unknown as AiGatewayService;

    const svc = new TicketAiService(mockDb, mockGateway, mockAudit);
    await expect(svc.extractMeetingActions("org-1", "user-1", 10, 999)).rejects.toThrow(NotFoundException);
    expect(mockGateway.invokeStructured).not.toHaveBeenCalled();
  });
});
