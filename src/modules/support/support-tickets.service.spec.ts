import { Test, type TestingModule } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { SupportTicketsService } from "./support-tickets.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import { CacheService } from "../../common/cache/cache.service";
import { SupportMacrosService } from "./support-macros.service";
import { SupportNotificationsService } from "./support-notifications.service";

const mockDb = {
  query: {
    supportTickets: { findFirst: jest.fn(), findMany: jest.fn() },
    supportTicketMessages: { findFirst: jest.fn(), findMany: jest.fn() },
  },
  insert: jest.fn().mockReturnThis(),
  values: jest.fn().mockReturnThis(),
  returning: jest.fn().mockResolvedValue([{ id: 1, orgId: "org1", title: "Login not working" }]),
  update: jest.fn().mockReturnThis(),
  set: jest.fn().mockReturnThis(),
  where: jest.fn().mockResolvedValue([]),
  select: jest.fn().mockReturnThis(),
  from: jest.fn().mockReturnThis(),
  groupBy: jest.fn().mockResolvedValue([]),
};

const mockCache = {
  cached: jest.fn((_key: string, fetcher: () => Promise<unknown>) => fetcher()),
  invalidate: jest.fn().mockResolvedValue(undefined),
  invalidatePattern: jest.fn().mockResolvedValue(undefined),
};

const mockMacros = {
  applyRoutingRules: jest.fn().mockResolvedValue({}),
};

const mockNotifications = {
  sendAssignmentEmail: jest.fn().mockResolvedValue(undefined),
  sendStatusEmail: jest.fn().mockResolvedValue(undefined),
  sendReplyEmail: jest.fn().mockResolvedValue(undefined),
};

describe("SupportTicketsService", () => {
  let service: SupportTicketsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockDb.returning.mockResolvedValue([{ id: 1, orgId: "org1", title: "Login not working" }]);
    mockCache.cached.mockImplementation((_key: string, fetcher: () => Promise<unknown>) => fetcher());
    mockMacros.applyRoutingRules.mockResolvedValue({});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SupportTicketsService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: CacheService, useValue: mockCache },
        { provide: SupportMacrosService, useValue: mockMacros },
        { provide: SupportNotificationsService, useValue: mockNotifications },
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
      } as never);

      expect(result.possibleDuplicateOf).toEqual({ id: 42, title: "Login not working" });
      expect(mockDb.insert).toHaveBeenCalled();
    });

    it("does not flag a duplicate when no OPEN/IN_PROGRESS match exists (e.g. prior ticket RESOLVED)", async () => {
      mockDb.query.supportTickets.findFirst.mockResolvedValueOnce(undefined);

      const result = await service.createTicket("org1", "user1", {
        title: "Login not working",
        description: "desc",
      } as never);

      expect(result.possibleDuplicateOf).toBeNull();
    });

    it("never throws on duplicate titles — creation always succeeds", async () => {
      mockDb.query.supportTickets.findFirst.mockResolvedValueOnce({ id: 42, title: "Login not working" });

      await expect(
        service.createTicket("org1", "user1", {
          title: "Login not working",
          description: "desc",
        } as never),
      ).resolves.toBeDefined();
    });
  });

  describe("createTicket — audit logging", () => {
    it("records a 'created' activity entry", async () => {
      mockDb.query.supportTickets.findFirst.mockResolvedValueOnce(undefined);

      await service.createTicket("org1", "user1", { title: "New ticket title", description: "d" } as never);

      const createdActivityPayload = mockDb.values.mock.calls
        .map((call) => call[0])
        .find((payload) => payload && payload.action === "created");

      expect(createdActivityPayload).toMatchObject({ orgId: "org1", userId: "user1", action: "created" });
    });

    it("does not fail ticket creation if the activity insert throws", async () => {
      mockDb.query.supportTickets.findFirst.mockResolvedValueOnce(undefined);
      mockDb.values.mockImplementationOnce(() => mockDb).mockImplementationOnce(() => {
        throw new Error("activity insert failed");
      });

      await expect(
        service.createTicket("org1", "user1", { title: "Another title", description: "d" } as never),
      ).resolves.toBeDefined();
    });
  });

  describe("addMessage — audit logging by isInternal", () => {
    beforeEach(() => {
      mockDb.query.supportTickets.findFirst.mockResolvedValue({
        id: 1,
        status: "OPEN",
        title: "t",
        createdBy: "creator1",
        assigneeId: null,
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

      await expect(service.getTicket("org1", 123)).rejects.toThrow(NotFoundException);
    });

    it("listMessages throws NotFoundException for a ticket belonging to a different org", async () => {
      mockDb.query.supportTickets.findFirst.mockResolvedValueOnce(undefined);

      await expect(service.listMessages("org1", 123)).rejects.toThrow(NotFoundException);
    });
  });
});
