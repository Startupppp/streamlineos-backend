import { Test, type TestingModule } from "@nestjs/testing";
import { BadRequestException, UnauthorizedException } from "@nestjs/common";
import { SupportChannelsService } from "./support-channels.service";
import { SupportTicketsService } from "./support-tickets.service";
import { DRIZZLE } from "../../db/drizzle.constants";

const mockDb = {
  query: {
    supportChannels: { findFirst: jest.fn(), findMany: jest.fn() },
    supportTicketMessages: { findFirst: jest.fn() },
    supportTickets: { findFirst: jest.fn() },
    users: { findFirst: jest.fn() },
  },
  insert: jest.fn().mockReturnThis(),
  values: jest.fn().mockReturnThis(),
  returning: jest.fn().mockResolvedValue([{ id: 1 }]),
  update: jest.fn().mockReturnThis(),
  set: jest.fn().mockReturnThis(),
  delete: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
};

const mockTickets = {
  createTicket: jest.fn().mockResolvedValue({ id: 42 }),
  addMessage: jest.fn().mockResolvedValue({ id: 7 }),
};

const baseInput = {
  messageId: "msg-1@mail.example.com",
  fromEmail: "customer@example.com",
  fromName: "Jane Customer",
  subject: "Help with my order",
  bodyText: "My order hasn't arrived.",
};

describe("SupportChannelsService", () => {
  let service: SupportChannelsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SupportChannelsService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: SupportTicketsService, useValue: mockTickets },
      ],
    }).compile();
    service = module.get(SupportChannelsService);
  });

  describe("verifyInboundSecret", () => {
    it("throws UnauthorizedException when no active email channel exists for the org", async () => {
      mockDb.query.supportChannels.findFirst.mockResolvedValueOnce(undefined);

      await expect(service.verifyInboundSecret("org1", "any-secret")).rejects.toThrow(UnauthorizedException);
    });

    it("throws UnauthorizedException when the provided secret doesn't match", async () => {
      mockDb.query.supportChannels.findFirst.mockResolvedValueOnce({
        id: 1,
        inboundSecret: "correct-secret",
      });

      await expect(service.verifyInboundSecret("org1", "wrong-secret")).rejects.toThrow(UnauthorizedException);
    });

    it("returns the channel when the secret matches", async () => {
      const channel = { id: 1, inboundSecret: "correct-secret", config: {} };
      mockDb.query.supportChannels.findFirst.mockResolvedValueOnce(channel);

      await expect(service.verifyInboundSecret("org1", "correct-secret")).resolves.toEqual(channel);
    });
  });

  describe("ingestInboundEmail — idempotency", () => {
    it("returns the existing ticket/message without creating anything new on a duplicate messageId", async () => {
      mockDb.query.supportTicketMessages.findFirst.mockResolvedValueOnce({ id: 5, ticketId: 42 });

      const result = await service.ingestInboundEmail("org1", { id: 1, config: {} } as never, baseInput as never);

      expect(result).toEqual({ ticketId: 42, messageId: 5, deduped: true });
      expect(mockTickets.createTicket).not.toHaveBeenCalled();
      expect(mockTickets.addMessage).not.toHaveBeenCalled();
    });
  });

  describe("ingestInboundEmail — thread matching", () => {
    it("appends to the existing ticket when inReplyTo matches a known sourceMessageId", async () => {
      mockDb.query.supportTicketMessages.findFirst.mockResolvedValueOnce(undefined);
      mockDb.query.supportTickets.findFirst.mockResolvedValueOnce({ id: 42 });

      const result = await service.ingestInboundEmail(
        "org1",
        { id: 1, config: {} } as never,
        { ...baseInput, inReplyTo: "original-msg@mail.example.com" } as never,
      );

      expect(mockTickets.addMessage).toHaveBeenCalledWith(
        "org1",
        42,
        null,
        { body: baseInput.bodyText, isInternal: false, attachments: undefined },
        {
          channel: "email",
          messageId: baseInput.messageId,
          contactEmail: baseInput.fromEmail,
          contactName: baseInput.fromName,
        },
      );
      expect(result).toEqual({ ticketId: 42, messageId: 7, deduped: false });
      expect(mockTickets.createTicket).not.toHaveBeenCalled();
    });
  });

  describe("ingestInboundEmail — new ticket creation", () => {
    it("throws BadRequestException when the channel has no configured owner", async () => {
      mockDb.query.supportTicketMessages.findFirst.mockResolvedValueOnce(undefined);

      await expect(
        service.ingestInboundEmail("org1", { id: 1, config: {} } as never, baseInput as never),
      ).rejects.toThrow(BadRequestException);
      expect(mockTickets.createTicket).not.toHaveBeenCalled();
    });

    it("throws BadRequestException when the configured owner isn't a real user", async () => {
      mockDb.query.supportTicketMessages.findFirst.mockResolvedValueOnce(undefined);
      mockDb.query.users.findFirst.mockResolvedValueOnce(undefined);

      await expect(
        service.ingestInboundEmail(
          "org1",
          { id: 1, config: { ownerUserId: "ghost-user" } } as never,
          baseInput as never,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it("creates a new ticket attributed to the channel owner, tagging the real requester separately", async () => {
      mockDb.query.supportTicketMessages.findFirst.mockResolvedValueOnce(undefined);
      mockDb.query.users.findFirst.mockResolvedValueOnce({ id: "owner-1" });

      const result = await service.ingestInboundEmail(
        "org1",
        { id: 1, config: { ownerUserId: "owner-1" } } as never,
        baseInput as never,
      );

      expect(mockTickets.createTicket).toHaveBeenCalledWith(
        "org1",
        "owner-1",
        { title: baseInput.subject, description: baseInput.bodyText },
        {
          channel: "email",
          messageId: baseInput.messageId,
          requesterEmail: baseInput.fromEmail,
          requesterName: baseInput.fromName,
        },
      );
      expect(result).toEqual({ ticketId: 42, messageId: null, deduped: false });
    });
  });
});
