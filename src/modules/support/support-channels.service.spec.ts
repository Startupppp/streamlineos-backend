import { Test, type TestingModule } from "@nestjs/testing";
import { BadRequestException, NotFoundException, UnauthorizedException } from "@nestjs/common";
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
  listPublicMessages: jest.fn().mockResolvedValue([]),
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

      await expect(service.verifyInboundSecret("org1", "email", "any-secret")).rejects.toThrow(UnauthorizedException);
    });

    it("throws UnauthorizedException when the provided secret doesn't match", async () => {
      mockDb.query.supportChannels.findFirst.mockResolvedValueOnce({
        id: 1,
        inboundSecret: "correct-secret",
      });

      await expect(service.verifyInboundSecret("org1", "email", "wrong-secret")).rejects.toThrow(UnauthorizedException);
    });

    it("returns the channel when the secret matches", async () => {
      const channel = { id: 1, inboundSecret: "correct-secret", config: {} };
      mockDb.query.supportChannels.findFirst.mockResolvedValueOnce(channel);

      await expect(service.verifyInboundSecret("org1", "email", "correct-secret")).resolves.toEqual(channel);
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

  describe("ingestInboundWhatsApp", () => {
    const waInput = { messageId: "wamid.abc123", from: "+15551234567", fromName: "Jane", bodyText: "Still broken" };

    it("threads onto the ticket matching inReplyTo when provided", async () => {
      mockDb.query.supportTicketMessages.findFirst.mockResolvedValueOnce(undefined);
      mockDb.query.supportTickets.findFirst.mockResolvedValueOnce({ id: 42 });

      const result = await service.ingestInboundWhatsApp(
        "org1",
        { id: 1, config: {} } as never,
        { ...waInput, inReplyTo: "wamid.original" } as never,
      );

      expect(result).toEqual({ ticketId: 42, messageId: 7, deduped: false });
      expect(mockTickets.createTicket).not.toHaveBeenCalled();
    });

    it("falls back to the sender's most recent open ticket on this channel when there's no inReplyTo", async () => {
      mockDb.query.supportTicketMessages.findFirst.mockResolvedValueOnce(undefined);
      mockDb.query.supportTickets.findFirst.mockResolvedValueOnce({ id: 99 });

      const result = await service.ingestInboundWhatsApp("org1", { id: 1, config: {} } as never, waInput as never);

      expect(mockTickets.addMessage).toHaveBeenCalledWith(
        "org1",
        99,
        null,
        { body: waInput.bodyText, isInternal: false, attachments: undefined },
        { channel: "whatsapp", messageId: waInput.messageId, contactEmail: waInput.from, contactName: waInput.fromName },
      );
      expect(result).toEqual({ ticketId: 99, messageId: 7, deduped: false });
    });

    it("creates a new ticket attributed to the channel owner when no open ticket exists for this sender", async () => {
      mockDb.query.supportTicketMessages.findFirst.mockResolvedValueOnce(undefined);
      mockDb.query.supportTickets.findFirst.mockResolvedValueOnce(undefined);
      mockDb.query.users.findFirst.mockResolvedValueOnce({ id: "owner-1" });

      const result = await service.ingestInboundWhatsApp(
        "org1",
        { id: 1, config: { ownerUserId: "owner-1" } } as never,
        waInput as never,
      );

      expect(mockTickets.createTicket).toHaveBeenCalledWith(
        "org1",
        "owner-1",
        { title: "New whatsapp support request", description: waInput.bodyText },
        { channel: "whatsapp", messageId: waInput.messageId, requesterEmail: waInput.from, requesterName: waInput.fromName },
      );
      expect(result).toEqual({ ticketId: 42, messageId: null, deduped: false });
    });

    it("dedupes by messageId, same as email", async () => {
      mockDb.query.supportTicketMessages.findFirst.mockResolvedValueOnce({ id: 5, ticketId: 42 });

      const result = await service.ingestInboundWhatsApp("org1", { id: 1, config: {} } as never, waInput as never);

      expect(result).toEqual({ ticketId: 42, messageId: 5, deduped: true });
      expect(mockTickets.createTicket).not.toHaveBeenCalled();
      expect(mockTickets.addMessage).not.toHaveBeenCalled();
    });
  });

  describe("ingestInboundSms", () => {
    const smsInput = { messageId: "SM123", from: "+15559876543", bodyText: "call me back" };

    it("has no reply-context concept — always threads onto the sender's most recent open ticket", async () => {
      mockDb.query.supportTicketMessages.findFirst.mockResolvedValueOnce(undefined);
      mockDb.query.supportTickets.findFirst.mockResolvedValueOnce({ id: 77 });

      const result = await service.ingestInboundSms("org1", { id: 1, config: {} } as never, smsInput as never);

      expect(mockTickets.addMessage).toHaveBeenCalledWith(
        "org1",
        77,
        null,
        { body: smsInput.bodyText, isInternal: false, attachments: undefined },
        { channel: "sms", messageId: smsInput.messageId, contactEmail: smsInput.from, contactName: smsInput.from },
      );
      expect(result).toEqual({ ticketId: 77, messageId: 7, deduped: false });
    });

    it("creates a new ticket when the sender has no open ticket yet", async () => {
      mockDb.query.supportTicketMessages.findFirst.mockResolvedValueOnce(undefined);
      mockDb.query.supportTickets.findFirst.mockResolvedValueOnce(undefined);
      mockDb.query.users.findFirst.mockResolvedValueOnce({ id: "owner-1" });

      const result = await service.ingestInboundSms(
        "org1",
        { id: 1, config: { ownerUserId: "owner-1" } } as never,
        smsInput as never,
      );

      expect(mockTickets.createTicket).toHaveBeenCalledWith(
        "org1",
        "owner-1",
        { title: "New sms support request", description: smsInput.bodyText },
        { channel: "sms", messageId: smsInput.messageId, requesterEmail: smsInput.from, requesterName: smsInput.from },
      );
      expect(result).toEqual({ ticketId: 42, messageId: null, deduped: false });
    });
  });

  describe("startChatSession", () => {
    it("throws NotFoundException when no active chat channel exists for the org", async () => {
      mockDb.query.supportChannels.findFirst.mockResolvedValueOnce(undefined);

      await expect(
        service.startChatSession("org1", { name: "Jane", message: "hi" } as never),
      ).rejects.toThrow(NotFoundException);
    });

    it("throws BadRequestException when the chat channel has no configured owner", async () => {
      mockDb.query.supportChannels.findFirst.mockResolvedValueOnce({ id: 1, config: {} });

      await expect(
        service.startChatSession("org1", { name: "Jane", message: "hi" } as never),
      ).rejects.toThrow(BadRequestException);
      expect(mockTickets.createTicket).not.toHaveBeenCalled();
    });

    it("creates a ticket and returns a fresh session token", async () => {
      mockDb.query.supportChannels.findFirst.mockResolvedValueOnce({ id: 1, config: { ownerUserId: "owner-1" } });
      mockDb.query.users.findFirst.mockResolvedValueOnce({ id: "owner-1" });

      const result = await service.startChatSession("org1", {
        name: "Jane",
        email: "jane@example.com",
        message: "Need help",
      } as never);

      expect(mockTickets.createTicket).toHaveBeenCalledWith(
        "org1",
        "owner-1",
        { title: "Live chat with Jane", description: "Need help" },
        expect.objectContaining({ channel: "chat", requesterEmail: "jane@example.com", requesterName: "Jane" }),
      );
      expect(result.ticketId).toBe(42);
      expect(typeof result.sessionToken).toBe("string");
      expect(result.sessionToken.length).toBeGreaterThan(0);
    });
  });

  describe("sendChatMessage / getChatSession", () => {
    it("throws NotFoundException for an unknown session token", async () => {
      mockDb.query.supportTickets.findFirst.mockResolvedValueOnce(undefined);

      await expect(service.sendChatMessage("org1", "bad-token", { body: "hi" } as never)).rejects.toThrow(
        NotFoundException,
      );
      expect(mockTickets.addMessage).not.toHaveBeenCalled();
    });

    it("posts a public message onto the ticket matching the session token", async () => {
      mockDb.query.supportTickets.findFirst.mockResolvedValueOnce({ id: 42 });

      const result = await service.sendChatMessage("org1", "good-token", { body: "still here?" } as never);

      expect(mockTickets.addMessage).toHaveBeenCalledWith(
        "org1",
        42,
        null,
        { body: "still here?", isInternal: false },
        { channel: "chat" },
      );
      expect(result).toEqual({ ticketId: 42, messageId: 7 });
    });

    it("returns the ticket id and public messages for a valid session", async () => {
      mockDb.query.supportTickets.findFirst.mockResolvedValueOnce({ id: 42 });
      mockTickets.listPublicMessages.mockResolvedValueOnce([{ id: 1, body: "hi" }]);

      const result = await service.getChatSession("org1", "good-token");

      expect(result).toEqual({ ticketId: 42, messages: [{ id: 1, body: "hi" }] });
    });
  });
});
