jest.mock("@composio/core", () => ({ Composio: jest.fn() }));

import { BadRequestException, NotFoundException, ForbiddenException } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { MeetingsPrepService } from "./meetings-prep.service";
import { AiGatewayService } from "../gateway/ai-gateway.service";
import { AiConfirmationService } from "../../ai-confirmation/ai-confirmation.service";
import { ComposioGateway, ComposioToolError } from "../../integrations/composio.gateway";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { AiInvokeResult } from "../gateway/ai-gateway.types";

const ORG_A = "org-A";
const ORG_B = "org-B";
const USER_1 = "user-1";
const EVENT_ID = "101";

const MOCK_AGENDA = {
  agenda: "1. Intro\n2. Review goals\n3. Action items",
  keyTopics: ["Q3 Goals", "Budget", "Risks"],
  suggestedDuration: "60 minutes",
  preparationNotes: "Bring last quarter's metrics",
  citations: [{ id: "1", title: "Meeting details", snippet: "Q3 Planning session" }],
};

const MOCK_FOLLOW_UP = {
  subject: "Q3 Planning Follow-up",
  body: "Hi team,\n\nHere are the outcomes...",
  actionItems: [{ item: "Ship dashboard", assignee: "Alice", dueDate: "2026-08-05" }],
  nextMeetingDate: "2026-08-15",
};

function makeCalendarEventRows(orgId: string = ORG_A) {
  return [
    {
      id: 101,
      title: "Q3 Planning",
      startDate: new Date("2026-08-01T10:00:00Z"),
      endDate: new Date("2026-08-01T11:00:00Z"),
      description: "Quarterly planning session",
      location: "Conference Room A",
      meetingUrl: null,
      agenda: "Review Q3 goals",
      entityType: null,
      entityId: null,
      linkedLeadId: null,
      linkedDealId: null,
      createdBy: USER_1,
      externalEventId: "gcal-evt-abc",
      integrationConnectionId: 1,
      orgId,
    },
  ];
}

const MOCK_ATTENDEES = [
  { userId: USER_1, name: "Alice Smith", status: "accepted" },
];

const MOCK_CONNECTION = {
  id: 1,
  toolkit: "googlecalendar" as const,
  accountEmail: "user1@example.com",
  composioConnectedAccountId: "composio-acct-1",
  isPrimary: true,
};

function makeGateway(invokeResult?: AiInvokeResult<unknown>): jest.Mocked<AiGatewayService> {
  const defaultSuccess: AiInvokeResult<unknown> = {
    ok: true,
    data: MOCK_AGENDA,
    model: "gpt-4o-mini",
    latencyMs: 100,
    correlationId: "corr-1",
    usage: { promptTokens: 50, completionTokens: 100, totalTokens: 150 },
  };
  return {
    invokeStructured: jest.fn().mockResolvedValue(invokeResult ?? defaultSuccess),
    invokeText: jest.fn().mockResolvedValue({ ok: true, data: "email body", model: "gpt-4o-mini", latencyMs: 80, correlationId: "corr-2", usage: { promptTokens: 40, completionTokens: 80, totalTokens: 120 } }),
  } as unknown as jest.Mocked<AiGatewayService>;
}

function makeConfirmation(): jest.Mocked<AiConfirmationService> {
  return {
    propose: jest.fn().mockResolvedValue({
      proposalId: 1,
      token: "1.9999999999.abcdef1234567890",
      expiresAt: new Date(Date.now() + 120_000),
    }),
    confirm: jest.fn().mockResolvedValue({
      proposalId: 1,
      action: "meetings.send-follow-up",
      payload: {
        eventId: 101,
        followUpDraft: MOCK_FOLLOW_UP,
        channel: "calendar",
      },
    }),
    markExecuted: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<AiConfirmationService>;
}

function makeComposio(configured = true): jest.Mocked<ComposioGateway> {
  return {
    isConfigured: jest.fn().mockReturnValue(configured),
    executeTool: jest.fn().mockResolvedValue({ successful: true, data: {} }),
  } as unknown as jest.Mocked<ComposioGateway>;
}

function mockThenable(resolveWith: unknown): jest.Mock {
  const fn = jest.fn().mockResolvedValue(resolveWith);
  return fn;
}

function makeFluentChain(resolveWith: unknown) {
  const limit = mockThenable(resolveWith);
  const whereChain: Record<string, jest.Mock> = {
    limit,
    innerJoin: jest.fn().mockReturnValue({
      where: mockThenable(resolveWith),
    }),
  };
  (whereChain as Record<string, unknown>).then = (res: (v: unknown) => unknown) =>
    Promise.resolve(resolveWith).then(res);
  const where = jest.fn().mockReturnValue(whereChain);
  const from = jest.fn().mockReturnValue({ where, innerJoin: jest.fn().mockReturnValue({ where }), limit });
  return { from };
}

function makeDb(
  eventRows: ReturnType<typeof makeCalendarEventRows> | [] = makeCalendarEventRows(),
  attendeeRows = MOCK_ATTENDEES,
  connectionRows: typeof MOCK_CONNECTION[] = [MOCK_CONNECTION],
) {
  let selectCall = 0;
  const selectMock = jest.fn().mockImplementation(() => {
    selectCall += 1;
    const mod = selectCall % 3;
    if (mod === 1) return makeFluentChain(eventRows);
    if (mod === 2) return makeFluentChain(attendeeRows);
    return makeFluentChain(connectionRows);
  });
  return { select: selectMock };
}

async function buildModule(opts: {
  gateway?: jest.Mocked<AiGatewayService>;
  confirmation?: jest.Mocked<AiConfirmationService>;
  composio?: jest.Mocked<ComposioGateway>;
  db?: ReturnType<typeof makeDb>;
} = {}) {
  const gateway = opts.gateway ?? makeGateway();
  const confirmation = opts.confirmation ?? makeConfirmation();
  const composio = opts.composio ?? makeComposio();
  const db = opts.db ?? makeDb();

  const moduleRef: TestingModule = await Test.createTestingModule({
    providers: [
      MeetingsPrepService,
      { provide: AiGatewayService, useValue: gateway },
      { provide: AiConfirmationService, useValue: confirmation },
      { provide: ComposioGateway, useValue: composio },
      { provide: DRIZZLE, useValue: db },
    ],
  }).compile();

  return {
    service: moduleRef.get(MeetingsPrepService),
    gateway,
    confirmation,
    composio,
    db,
  };
}

describe("MeetingsPrepService", () => {
  describe("draftAgenda", () => {
    it("should charge credits via AiGatewayService before calling LLM", async () => {
      const gateway = makeGateway();
      const { service } = await buildModule({ gateway });

      await service.draftAgenda(ORG_A, USER_1, EVENT_ID, {});

      expect(gateway.invokeStructured).toHaveBeenCalledWith(
        expect.objectContaining({
          charge: expect.objectContaining({ credits: expect.any(Number) }),
          actor: { orgId: ORG_A, userId: USER_1 },
        }),
      );
    });

    it("should return draft agenda on success", async () => {
      const { service } = await buildModule();

      const result = await service.draftAgenda(ORG_A, USER_1, EVENT_ID, {});

      expect(result.agenda).toBeDefined();
      expect(result.connectedIntegrations).toBe(true);
    });

    it("should throw BadRequestException on AI quota_exceeded", async () => {
      const failResult: AiInvokeResult<unknown> = {
        ok: false,
        kind: "quota_exceeded",
        message: "Insufficient AI credits",
        correlationId: "corr-err",
      };
      const gateway = makeGateway(failResult);
      const { service } = await buildModule({ gateway });

      await expect(service.draftAgenda(ORG_A, USER_1, EVENT_ID, {})).rejects.toBeInstanceOf(BadRequestException);
    });

    it("should indicate connectedIntegrations=false when Composio not configured", async () => {
      const composio = makeComposio(false);
      const { service } = await buildModule({ composio });

      const result = await service.draftAgenda(ORG_A, USER_1, EVENT_ID, {});

      expect(result.connectedIntegrations).toBe(false);
    });

    it("should throw NotFoundException for an invalid (non-numeric) eventId", async () => {
      const { service } = await buildModule();

      await expect(service.draftAgenda(ORG_A, USER_1, "abc", {})).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("draftFollowUp", () => {
    it("should return draft follow-up without calling ComposioGateway.executeTool", async () => {
      const composio = makeComposio(true);
      const gateway = makeGateway({
        ok: true,
        data: MOCK_FOLLOW_UP,
        model: "gpt-4o-mini",
        latencyMs: 100,
        correlationId: "corr-1",
        usage: { promptTokens: 50, completionTokens: 100, totalTokens: 150 },
      });
      const { service } = await buildModule({ composio, gateway });

      const result = await service.draftFollowUp(ORG_A, USER_1, EVENT_ID, undefined, undefined);

      expect(result.followUp).toBeDefined();
      expect(composio.executeTool).not.toHaveBeenCalled();
    });

    it("should include meeting notes feature in the prompt when notes provided", async () => {
      const gateway = makeGateway({
        ok: true,
        data: MOCK_FOLLOW_UP,
        model: "gpt-4o-mini",
        latencyMs: 100,
        correlationId: "corr-1",
        usage: { promptTokens: 50, completionTokens: 100, totalTokens: 150 },
      });
      const { service } = await buildModule({ gateway });

      await service.draftFollowUp(ORG_A, USER_1, EVENT_ID, "Ship dashboard by Friday", undefined);

      const call = gateway.invokeStructured.mock.calls[0];
      expect(call).toBeDefined();
      const opts = call?.[0] as { prompt: { user: string; system: string } };
      expect(opts.prompt.user).toContain("Ship dashboard by Friday");
    });
  });

  describe("proposeSendFollowUp", () => {
    it("should call AiConfirmationService.propose with correct orgId, userId, action", async () => {
      const confirmation = makeConfirmation();
      const { service } = await buildModule({ confirmation });

      const result = await service.proposeSendFollowUp(ORG_A, USER_1, EVENT_ID, MOCK_FOLLOW_UP, "calendar");

      expect(confirmation.propose).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId: ORG_A,
          userId: USER_1,
          action: "meetings.send-follow-up",
        }),
      );
      expect(result.proposalId).toBe(1);
      expect(result.token).toBeDefined();
    });

    it("should NOT call ComposioGateway.executeTool at proposal time", async () => {
      const composio = makeComposio(true);
      const { service } = await buildModule({ composio });

      await service.proposeSendFollowUp(ORG_A, USER_1, EVENT_ID, MOCK_FOLLOW_UP, "calendar");

      expect(composio.executeTool).not.toHaveBeenCalled();
    });
  });

  describe("executeSendFollowUp", () => {
    it("should call confirm before executeTool (order enforced)", async () => {
      const confirmation = makeConfirmation();
      const composio = makeComposio(true);
      const order: string[] = [];

      confirmation.confirm.mockImplementation(async () => {
        order.push("confirm");
        return {
          proposalId: 1,
          action: "meetings.send-follow-up",
          payload: { eventId: 101, followUpDraft: MOCK_FOLLOW_UP, channel: "calendar" },
        };
      });

      composio.executeTool.mockImplementation(async () => {
        order.push("execute");
        return { successful: true };
      });

      const { service } = await buildModule({ confirmation, composio });
      await service.executeSendFollowUp(ORG_A, USER_1, "valid-token");

      expect(order[0]).toBe("confirm");
      expect(order[1]).toBe("execute");
    });

    it("should NOT call executeTool if token confirmation fails (ForbiddenException)", async () => {
      const confirmation = makeConfirmation();
      const composio = makeComposio(true);
      confirmation.confirm.mockRejectedValue(new ForbiddenException("Token signature mismatch"));
      const { service } = await buildModule({ confirmation, composio });

      await expect(service.executeSendFollowUp(ORG_A, USER_1, "bad-token")).rejects.toBeInstanceOf(ForbiddenException);
      expect(composio.executeTool).not.toHaveBeenCalled();
    });

    it("should use the user's own connected account (ownership via orgId+userId scoped query)", async () => {
      const confirmation = makeConfirmation();
      const composio = makeComposio(true);
      const { service } = await buildModule({ confirmation, composio });

      await service.executeSendFollowUp(ORG_A, USER_1, "valid-token");

      const toolCall = composio.executeTool.mock.calls[0];
      expect(toolCall).toBeDefined();
      expect(toolCall?.[1]).toBe(USER_1);
      expect(toolCall?.[3]).toBe(MOCK_CONNECTION.composioConnectedAccountId);
    });

    it("should call markExecuted after successful Composio tool execution", async () => {
      const confirmation = makeConfirmation();
      const composio = makeComposio(true);
      const { service } = await buildModule({ confirmation, composio });

      await service.executeSendFollowUp(ORG_A, USER_1, "valid-token");

      expect(confirmation.markExecuted).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ status: "sent" }),
      );
    });

    it("should return { executed: false, error: 'auth_required' } on ComposioToolError with isAuthError=true", async () => {
      const confirmation = makeConfirmation();
      const composio = makeComposio(true);
      composio.executeTool.mockRejectedValue(
        new ComposioToolError("Token expired", true),
      );
      const { service } = await buildModule({ confirmation, composio });

      const result = await service.executeSendFollowUp(ORG_A, USER_1, "valid-token");

      expect(result.executed).toBe(false);
      expect(result.error).toBe("auth_required");
    });
  });
});
