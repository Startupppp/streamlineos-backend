import { Test, type TestingModule } from "@nestjs/testing";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { SupportTicketsService } from "./support-tickets.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { CacheService } from "../../../common/cache/cache.service";
import { PlanLimitsService } from "../../billing/core/plan-limits.service";
import { SupportMacrosService } from "./support-macros.service";
import { SupportNotificationsService } from "./support-notifications.service";
import { SupportRealtimeService } from "./support-realtime.service";
import { SupportSlaService } from "./support-sla.service";
import { AutomationService } from "../../automation/automation.service";
import { SupportAiService } from "./support-ai.service";
import { SupportCustomFieldsService } from "./support-custom-fields.service";
import { SupportMentionsService } from "./support-mentions.service";
import { SupportTicketActivityService } from "./support-ticket-activity.service";
import { SupportTicketMessagesService } from "./support-ticket-messages.service";
import { SupportTicketOperationsService } from "./support-ticket-operations.service";

const mockDb = {
  query: {
    supportTickets: { findFirst: jest.fn(), findMany: jest.fn() },
    supportTicketMessages: { findFirst: jest.fn(), findMany: jest.fn() },
    users: { findFirst: jest.fn().mockResolvedValue({ name: "Agent", email: "agent@example.com" }) },
  },
  insert: jest.fn().mockReturnThis(),
  values: jest.fn().mockReturnThis(),
  onConflictDoNothing: jest.fn().mockReturnThis(),
  returning: jest.fn().mockResolvedValue([{ id: 1, orgId: "org1", title: "Login not working" }]),
  update: jest.fn().mockReturnThis(),
  set: jest.fn().mockReturnThis(),
  where: jest.fn().mockResolvedValue([]),
  select: jest.fn().mockReturnThis(),
  from: jest.fn().mockReturnThis(),
  groupBy: jest.fn().mockResolvedValue([]),
  transaction: jest.fn(),
};

mockDb.transaction.mockImplementation((cb: unknown) =>
  (cb as (tx: unknown) => Promise<unknown>)(mockDb),
);

const mockCache = {
  cached: jest.fn((_key: string, fetcher: () => Promise<unknown>) => fetcher()),
  cachedVersioned: jest.fn(
    (_namespace: string, _key: string, fetcher: () => Promise<unknown>) => fetcher(),
  ),
  invalidate: jest.fn().mockResolvedValue(undefined),
  invalidateNamespace: jest.fn().mockResolvedValue(undefined),
};

const mockMacros = {
  applyRoutingRules: jest.fn().mockResolvedValue({}),
  isVipClient: jest.fn().mockResolvedValue(false),
};

const mockNotifications = {
  sendAssignmentEmail: jest.fn().mockResolvedValue(undefined),
  sendStatusEmail: jest.fn().mockResolvedValue(undefined),
  sendReplyEmail: jest.fn().mockResolvedValue(undefined),
};

const mockRealtime = {
  publishTicketUpdated: jest.fn().mockResolvedValue(undefined),
  publishMessageCreated: jest.fn().mockResolvedValue(undefined),
};

const mockSla = {
  resolvePolicy: jest.fn().mockResolvedValue({
    firstResponseTargetMins: 60,
    resolutionTargetMins: 1440,
    pauseStatuses: ["WAITING"],
    businessHours: null,
  }),
  computeDueDates: jest.fn((_policy: unknown, from: Date) => ({
    firstResponseDueAt: new Date(from.getTime() + 60 * 60_000),
    resolutionDueAt: new Date(from.getTime() + 1440 * 60_000),
  })),
  computePauseTransition: jest.fn(() => ({ slaPausedAt: null, slaPausedMinutes: 0, extendByMinutes: 0 })),
};

const mockAutomations = {
  runAutomationsForEvent: jest.fn().mockResolvedValue(undefined),
};

const mockAi = {
  runFullAnalysis: jest.fn().mockResolvedValue(undefined),
};

const mockCustomFields = {
  setFieldValues: jest.fn().mockResolvedValue(undefined),
  getFieldValues: jest.fn().mockResolvedValue([]),
};

const mockMentions = {
  processMessageMentions: jest.fn().mockResolvedValue(undefined),
};

const mockPlanLimits = {
  assertWithinLimit: jest.fn().mockResolvedValue(undefined),
};

describe("SupportTicketsService", () => {
  let service: SupportTicketsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockDb.returning.mockResolvedValue([{ id: 1, orgId: "org1", title: "Login not working" }]);
    mockDb.select.mockReturnThis();
    mockDb.from.mockReturnThis();
    mockDb.where.mockResolvedValue([]);
    mockDb.groupBy.mockResolvedValue([]);
    mockCache.cached.mockImplementation((_key: string, fetcher: () => Promise<unknown>) => fetcher());
    mockPlanLimits.assertWithinLimit.mockResolvedValue(undefined);
    mockMacros.applyRoutingRules.mockResolvedValue({});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SupportTicketsService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: CacheService, useValue: mockCache },
        { provide: PlanLimitsService, useValue: mockPlanLimits },
        { provide: SupportMacrosService, useValue: mockMacros },
        { provide: SupportNotificationsService, useValue: mockNotifications },
        { provide: SupportRealtimeService, useValue: mockRealtime },
        { provide: SupportSlaService, useValue: mockSla },
        { provide: AutomationService, useValue: mockAutomations },
        { provide: SupportAiService, useValue: mockAi },
        { provide: SupportCustomFieldsService, useValue: mockCustomFields },
        { provide: SupportMentionsService, useValue: mockMentions },
        SupportTicketActivityService,
        SupportTicketMessagesService,
        SupportTicketOperationsService,
      ],
    }).compile();
    service = module.get(SupportTicketsService);
  });

  describe("createTicket — duplicate title scoping", () => {
    it("flags a possible duplicate when a same-titled ticket is still OPEN/IN_PROGRESS, without blocking creation", async () => {
      mockDb.query.supportTickets.findFirst.mockResolvedValueOnce({ id: 42, title: "Login not working" });

      const result = await service.createTicket("org1", "user1", {
        title: "Login not working",
        description: "desc",
      } as never, undefined, 1);

      expect(result.possibleDuplicateOf).toEqual({ id: 42, title: "Login not working" });
      expect(mockDb.insert).toHaveBeenCalled();
    });

    it("does not flag a duplicate when no OPEN/IN_PROGRESS match exists (e.g. prior ticket RESOLVED)", async () => {
      mockDb.query.supportTickets.findFirst.mockResolvedValueOnce(undefined);

      const result = await service.createTicket("org1", "user1", {
        title: "Login not working",
        description: "desc",
      } as never, undefined, 1);

      expect(result.possibleDuplicateOf).toBeNull();
    });

    it("never throws on duplicate titles — creation always succeeds", async () => {
      mockDb.query.supportTickets.findFirst.mockResolvedValueOnce({ id: 42, title: "Login not working" });

      await expect(
        service.createTicket("org1", "user1", {
          title: "Login not working",
          description: "desc",
        } as never, undefined, 1),
      ).resolves.toBeDefined();
    });
  });

  describe("createTicket — audit logging", () => {
    it("records a 'created' activity entry", async () => {
      mockDb.query.supportTickets.findFirst.mockResolvedValueOnce(undefined);

      await service.createTicket("org1", "user1", { title: "New ticket title", description: "d" } as never, undefined, 1);

      const createdActivityPayload = mockDb.values.mock.calls
        .map((call) => call[0])
        .find((payload) => payload && payload.action === "created");

      expect(createdActivityPayload).toMatchObject({ orgId: "org1", userId: "user1", action: "created" });
    });

    it("does not fail ticket creation if the activity insert throws", async () => {
      mockDb.query.supportTickets.findFirst.mockResolvedValueOnce(undefined);
      mockDb.values.mockImplementation((payload?: { action?: string }) => {
        if (payload?.action === "created") throw new Error("activity insert failed");
        return mockDb;
      });

      await expect(
        service.createTicket("org1", "user1", { title: "Another title", description: "d" } as never, undefined, 1),
      ).resolves.toBeDefined();

      mockDb.values.mockImplementation(() => mockDb);
    });
  });

  describe("addMessage — audit logging by isInternal", () => {
    beforeEach(() => {
      mockDb.query.supportTickets.findFirst.mockResolvedValue({
        id: 1,
        status: "OPEN",
        title: "t",
        createdByMembershipId: null,
        assigneeMembershipId: null,
        firstRespondedAt: null,
        priority: "MEDIUM",
        category: null,
        creatorMembership: { user: { id: "creator1" } },
        assigneeMembership: null,
      });
      mockDb.returning.mockResolvedValue([{ id: 99, ticketId: 1, body: "hi", isInternal: false }]);
    });

    it("records a 'replied' activity entry for a public reply", async () => {
      await service.addMessage("org1", 1, "user1", { body: "hello", isInternal: false } as never);

      const repliedPayload = mockDb.values.mock.calls
        .map((call) => call[0])
        .find((payload) => payload && payload.action === "replied");
      expect(repliedPayload).toBeDefined();
    });

    it("records an 'internal_note' activity entry for an internal note", async () => {
      await service.addMessage("org1", 1, "user1", { body: "internal", isInternal: true } as never);

      const internalPayload = mockDb.values.mock.calls
        .map((call) => call[0])
        .find((payload) => payload && payload.action === "internal_note");
      expect(internalPayload).toBeDefined();
    });

    it("only sends a customer notification email for public replies, not internal notes", async () => {
      await service.addMessage("org1", 1, "user1", { body: "internal", isInternal: true } as never);
      expect(mockNotifications.sendReplyEmail).not.toHaveBeenCalled();

      await service.addMessage("org1", 1, "user1", { body: "hello", isInternal: false } as never);
      expect(mockNotifications.sendReplyEmail).toHaveBeenCalled();
    });

    it("kicks off mention processing for an internal note with an author", async () => {
      await service.addMessage("org1", 1, "user1", { body: "cc @jane", isInternal: true } as never);
      expect(mockDb.query.users.findFirst).toHaveBeenCalled();
    });

    it("never kicks off mention processing for a public reply", async () => {
      await service.addMessage("org1", 1, "user1", { body: "cc @jane", isInternal: false } as never);
      expect(mockDb.query.users.findFirst).not.toHaveBeenCalled();
    });

    it("stamps firstRespondedAt on the first public agent reply", async () => {
      await service.addMessage("org1", 1, "user1", { body: "hello", isInternal: false } as never);

      const firstResponsePayload = mockDb.set.mock.calls
        .map((call) => call[0])
        .find((payload) => payload && "firstRespondedAt" in payload);
      expect(firstResponsePayload).toBeDefined();
    });

    it("does not stamp firstRespondedAt for an internal note", async () => {
      await service.addMessage("org1", 1, "user1", { body: "internal", isInternal: true } as never);

      const firstResponsePayload = mockDb.set.mock.calls
        .map((call) => call[0])
        .find((payload) => payload && "firstRespondedAt" in payload);
      expect(firstResponsePayload).toBeUndefined();
    });
  });

  describe("updateTicket — SLA pause/resume wiring", () => {
    it("consults the SLA service to compute a pause transition on status change", async () => {
      mockDb.query.supportTickets.findFirst.mockResolvedValueOnce({
        id: 1,
        status: "OPEN",
        priority: "MEDIUM",
        category: null,
        createdBy: "creator1",
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        slaPausedAt: null,
        slaPausedMinutes: 0,
        firstResponseDueAt: null,
        firstRespondedAt: null,
        slaDeadline: null,
      });

      await service.updateTicket("org1", 1, "user1", { status: "WAITING" } as never);

      expect(mockSla.resolvePolicy).toHaveBeenCalledWith("org1", "MEDIUM", null);
      expect(mockSla.computePauseTransition).toHaveBeenCalledWith(
        "OPEN",
        "WAITING",
        ["WAITING"],
        null,
        0,
      );
    });

    it("extends due dates by the paused duration when resuming from a pause status", async () => {
      mockSla.computePauseTransition.mockReturnValueOnce({
        slaPausedAt: null,
        slaPausedMinutes: 15,
        extendByMinutes: 15,
      });
      const firstResponseDueAt = new Date("2026-01-01T01:00:00.000Z");
      const slaDeadline = new Date("2026-01-02T00:00:00.000Z");
      mockDb.query.supportTickets.findFirst.mockResolvedValueOnce({
        id: 1,
        status: "WAITING",
        priority: "MEDIUM",
        category: null,
        createdBy: "creator1",
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        slaPausedAt: new Date("2026-01-01T00:00:00.000Z"),
        slaPausedMinutes: 0,
        firstResponseDueAt,
        firstRespondedAt: null,
        slaDeadline,
      });

      await service.updateTicket("org1", 1, "user1", { status: "IN_PROGRESS" } as never);

      const extendedPayload = mockDb.set.mock.calls
        .map((call) => call[0])
        .find((payload) => payload && "slaDeadline" in payload);
      expect(extendedPayload.slaDeadline.getTime()).toBe(slaDeadline.getTime() + 15 * 60_000);
      expect(extendedPayload.firstResponseDueAt.getTime()).toBe(firstResponseDueAt.getTime() + 15 * 60_000);
    });
  });

  describe("listPublicMessages — internal note leak defense", () => {
    it("filters isInternal at the query level (defense-in-depth for the future customer portal)", async () => {
      mockDb.query.supportTickets.findFirst.mockResolvedValueOnce({ id: 1 });
      mockDb.query.supportTicketMessages.findMany.mockResolvedValueOnce([
        { id: 1, body: "public reply", isInternal: false },
      ]);

      await service.listPublicMessages("org1", 1);

      const [callArgs] = mockDb.query.supportTicketMessages.findMany.mock.calls;
      const whereClause = callArgs[0].where;
      const serialized = JSON.stringify(whereClause, (key, value) => (key === "table" ? undefined : value));
      expect(serialized).toContain("is_internal");
    });

    it("throws NotFoundException when the ticket does not belong to the org", async () => {
      mockDb.query.supportTickets.findFirst.mockResolvedValueOnce(undefined);

      await expect(service.listPublicMessages("org1", 999)).rejects.toThrow(NotFoundException);
    });
  });

  describe("cross-org isolation", () => {
    it("getTicket throws NotFoundException for a ticket belonging to a different org", async () => {
      mockDb.query.supportTickets.findFirst.mockResolvedValueOnce(undefined);

      await expect(service.getTicket("org1", 123, { userId: "user1", scope: "all" })).rejects.toThrow(NotFoundException);
    });

    it("listMessages throws NotFoundException for a ticket belonging to a different org", async () => {
      mockDb.query.supportTickets.findFirst.mockResolvedValueOnce(undefined);

      await expect(service.listMessages("org1", 123)).rejects.toThrow(NotFoundException);
    });
  });

  describe("updateTicket — optimistic locking", () => {
    const baseTicket = {
      id: 1,
      status: "OPEN",
      priority: "MEDIUM",
      assigneeId: null,
      createdBy: "creator1",
      title: "t",
      updatedAt: new Date("2024-01-01T00:00:00.000Z"),
    };

    it("throws a 409 STALE_TICKET conflict when expectedUpdatedAt does not match the current row", async () => {
      mockDb.query.supportTickets.findFirst.mockResolvedValueOnce(baseTicket);

      let caught: { getStatus?: () => number; getResponse?: () => unknown } | undefined;
      try {
        await service.updateTicket("org1", 1, "user1", {
          status: "IN_PROGRESS",
          expectedUpdatedAt: new Date("2024-01-02T00:00:00.000Z"),
        } as never);
      } catch (error) {
        caught = error as typeof caught;
      }

      expect(caught).toBeDefined();
      expect(caught?.getStatus?.()).toBe(409);
      expect(caught?.getResponse?.()).toMatchObject({ code: "STALE_TICKET" });
    });

    it("succeeds when expectedUpdatedAt matches the current row", async () => {
      mockDb.query.supportTickets.findFirst.mockResolvedValueOnce(baseTicket);

      await expect(
        service.updateTicket("org1", 1, "user1", {
          status: "IN_PROGRESS",
          expectedUpdatedAt: baseTicket.updatedAt,
        } as never),
      ).resolves.toMatchObject({ success: true });
    });

    it("succeeds when no expectedUpdatedAt is provided (check is opt-in)", async () => {
      mockDb.query.supportTickets.findFirst.mockResolvedValueOnce(baseTicket);

      await expect(
        service.updateTicket("org1", 1, "user1", { status: "IN_PROGRESS" } as never),
      ).resolves.toMatchObject({ success: true });
    });
  });

  describe("mergeTicket", () => {
    it("rejects merging a ticket into itself", async () => {
      await expect(
        service.mergeTicket("org1", 1, "user1", { intoTicketId: 1 } as never),
      ).rejects.toThrow(BadRequestException);
    });

    it("throws NotFoundException when the target ticket does not exist in the org", async () => {
      mockDb.query.supportTickets.findFirst
        .mockResolvedValueOnce({ id: 1, status: "OPEN", mergedIntoTicketId: null })
        .mockResolvedValueOnce(undefined);

      await expect(
        service.mergeTicket("org1", 1, "user1", { intoTicketId: 2 } as never),
      ).rejects.toThrow(NotFoundException);
    });

    it("throws ConflictException when the ticket has already been merged", async () => {
      mockDb.query.supportTickets.findFirst
        .mockResolvedValueOnce({ id: 1, status: "OPEN", mergedIntoTicketId: 99 })
        .mockResolvedValueOnce({ id: 2 });

      await expect(
        service.mergeTicket("org1", 1, "user1", { intoTicketId: 2 } as never),
      ).rejects.toThrow(ConflictException);
    });

    it("closes the source ticket and records a 'merged' activity entry on success", async () => {
      mockDb.query.supportTickets.findFirst
        .mockResolvedValueOnce({ id: 1, status: "OPEN", mergedIntoTicketId: null })
        .mockResolvedValueOnce({ id: 2 });

      const result = await service.mergeTicket("org1", 1, "user1", { intoTicketId: 2 } as never);

      expect(result).toMatchObject({ success: true, mergedIntoTicketId: 2 });
      const mergedPayload = mockDb.values.mock.calls.map((c) => c[0]).find((p) => p && p.action === "merged");
      expect(mergedPayload).toBeDefined();
    });
  });

  describe("snoozeTicket / unsnoozeTicket", () => {
    it("throws NotFoundException when the ticket doesn't exist", async () => {
      mockDb.query.supportTickets.findFirst.mockResolvedValueOnce(undefined);

      await expect(
        service.snoozeTicket("org1", 1, "user1", { snoozedUntil: new Date(Date.now() + 86_400_000) } as never),
      ).rejects.toThrow(NotFoundException);
    });

    it("sets snoozedUntil/snoozedBy and records a 'snoozed' activity entry", async () => {
      mockDb.query.supportTickets.findFirst.mockResolvedValueOnce({ id: 1 });
      const until = new Date(Date.now() + 86_400_000);

      const result = await service.snoozeTicket("org1", 1, "user1", { snoozedUntil: until } as never);

      expect(result).toMatchObject({ success: true, snoozedUntil: until });
      const setPayload = mockDb.set.mock.calls.map((c) => c[0]).find((p) => p && "snoozedUntil" in p);
      expect(setPayload).toMatchObject({ snoozedUntil: until, snoozedBy: "user1" });
      const activityPayload = mockDb.values.mock.calls.map((c) => c[0]).find((p) => p && p.action === "snoozed");
      expect(activityPayload).toBeDefined();
    });

    it("clears snoozedUntil/snoozedBy and records an 'unsnoozed' activity entry", async () => {
      mockDb.query.supportTickets.findFirst.mockResolvedValueOnce({ id: 1 });

      const result = await service.unsnoozeTicket("org1", 1, "user1");

      expect(result).toMatchObject({ success: true });
      const setPayload = mockDb.set.mock.calls
        .map((c) => c[0])
        .find((p) => p && "snoozedUntil" in p && p.snoozedUntil === null);
      expect(setPayload).toBeDefined();
      const activityPayload = mockDb.values.mock.calls.map((c) => c[0]).find((p) => p && p.action === "unsnoozed");
      expect(activityPayload).toBeDefined();
    });
  });

  describe("unsnoozeExpiredTickets", () => {
    it("clears expired snoozes and invalidates caches per affected org", async () => {
      mockDb.where.mockReturnValueOnce(mockDb);
      mockDb.returning.mockResolvedValueOnce([
        { id: 1, orgId: "org1" },
        { id: 2, orgId: "org2" },
      ]);

      const result = await service.unsnoozeExpiredTickets();

      expect(result).toEqual({ unsnoozed: 2 });
      expect(mockCache.invalidateNamespace).toHaveBeenCalledWith("support:tickets:org1");
      expect(mockCache.invalidateNamespace).toHaveBeenCalledWith("support:tickets:org2");
    });
  });

  describe("splitTicket", () => {
    it("throws NotFoundException when the original ticket does not exist", async () => {
      mockDb.query.supportTickets.findFirst.mockResolvedValueOnce(undefined);

      await expect(
        service.splitTicket("org1", 1, "user1", { title: "New split ticket issue" } as never, 1),
      ).rejects.toThrow(NotFoundException);
    });

    it("creates a new ticket, links it back to the original, and records split activity on both", async () => {
      mockDb.query.supportTickets.findFirst
        .mockResolvedValueOnce({
          id: 1,
          category: "billing",
          clientId: 5,
          priority: "HIGH",
          requesterEmail: null,
          requesterName: null,
        })
        .mockResolvedValueOnce(undefined);
      mockDb.returning.mockResolvedValueOnce([{ id: 2, orgId: "org1", title: "New split ticket issue" }]);

      const result = await service.splitTicket("org1", 1, "user1", { title: "New split ticket issue" } as never, 1);

      expect(result).toMatchObject({ id: 2 });
      const linkPayload = mockDb.values.mock.calls.map((c) => c[0]).find((p) => p && p.relation === "split");
      expect(linkPayload).toMatchObject({ ticketId: 2, linkedTicketId: 1, relation: "split" });
      const splitActivities = mockDb.values.mock.calls.map((c) => c[0]).filter((p) => p && p.action === "split");
      expect(splitActivities.length).toBe(2);
    });
  });

  describe("addTicketLink", () => {
    it("rejects linking a ticket to itself", async () => {
      await expect(
        service.addTicketLink("org1", 1, "user1", { linkedTicketId: 1, relation: "related" } as never),
      ).rejects.toThrow(BadRequestException);
    });

    it("throws NotFoundException when the linked ticket does not exist in the org", async () => {
      mockDb.query.supportTickets.findFirst.mockResolvedValueOnce({ id: 1 }).mockResolvedValueOnce(undefined);

      await expect(
        service.addTicketLink("org1", 1, "user1", { linkedTicketId: 2, relation: "related" } as never),
      ).rejects.toThrow(NotFoundException);
    });

    it("records a 'linked' activity entry on success", async () => {
      mockDb.query.supportTickets.findFirst.mockResolvedValueOnce({ id: 1 }).mockResolvedValueOnce({ id: 2 });
      mockDb.returning.mockResolvedValueOnce([{ id: 5, ticketId: 1, linkedTicketId: 2, relation: "related" }]);

      await service.addTicketLink("org1", 1, "user1", { linkedTicketId: 2, relation: "related" } as never);

      const linkedPayload = mockDb.values.mock.calls.map((c) => c[0]).find((p) => p && p.action === "linked");
      expect(linkedPayload).toBeDefined();
    });
  });
});
