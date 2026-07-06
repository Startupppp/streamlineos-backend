import { Test, type TestingModule } from "@nestjs/testing";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { SupportPortalService } from "./support-portal.service";
import { SupportTicketsService } from "./support-tickets.service";
import { DRIZZLE } from "../../db/drizzle.constants";

const mockDb = {
  query: {
    supportTickets: { findFirst: jest.fn(), findMany: jest.fn() },
  },
};

const mockTickets = {
  createTicket: jest.fn().mockResolvedValue({ id: 1, possibleDuplicateOf: null }),
  listPublicMessages: jest.fn().mockResolvedValue([]),
  addMessage: jest.fn().mockResolvedValue({ id: 99 }),
};

describe("SupportPortalService", () => {
  let service: SupportPortalService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SupportPortalService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: SupportTicketsService, useValue: mockTickets },
      ],
    }).compile();
    service = module.get(SupportPortalService);
  });

  describe("createTicket", () => {
    it("creates the ticket with createdBy = the portal user and channel = portal", async () => {
      await service.createTicket("org1", "portal-user-1", {
        title: "My printer is broken",
        category: "general",
        description: "It won't turn on",
      } as never);

      expect(mockTickets.createTicket).toHaveBeenCalledWith(
        "org1",
        "portal-user-1",
        { title: "My printer is broken", category: "general", description: "It won't turn on" },
        { channel: "portal" },
      );
    });
  });

  describe("getMyTicket — ownership scoping", () => {
    it("throws NotFoundException when the ticket doesn't exist in the org", async () => {
      mockDb.query.supportTickets.findFirst.mockResolvedValueOnce(undefined);

      await expect(service.getMyTicket("org1", "portal-user-1", 999)).rejects.toThrow(NotFoundException);
    });

    it("throws ForbiddenException when the ticket belongs to a different portal user", async () => {
      mockDb.query.supportTickets.findFirst.mockResolvedValueOnce({ id: 1, createdBy: "someone-else" });

      await expect(service.getMyTicket("org1", "portal-user-1", 1)).rejects.toThrow(ForbiddenException);
    });

    it("uses listPublicMessages (never the internal-note-including path) for portal reads", async () => {
      mockDb.query.supportTickets.findFirst
        .mockResolvedValueOnce({ id: 1, createdBy: "portal-user-1" }) // ownership check
        .mockResolvedValueOnce({ id: 1, title: "t", createdBy: "portal-user-1" }); // ticket fetch

      await service.getMyTicket("org1", "portal-user-1", 1);

      expect(mockTickets.listPublicMessages).toHaveBeenCalledWith("org1", 1);
    });
  });

  describe("addMessage — ownership scoping", () => {
    it("throws ForbiddenException when replying to another user's ticket", async () => {
      mockDb.query.supportTickets.findFirst.mockResolvedValueOnce({ id: 1, createdBy: "someone-else" });

      await expect(
        service.addMessage("org1", "portal-user-1", 1, { body: "hello" } as never),
      ).rejects.toThrow(ForbiddenException);
      expect(mockTickets.addMessage).not.toHaveBeenCalled();
    });

    it("always forces isInternal: false regardless of input", async () => {
      mockDb.query.supportTickets.findFirst.mockResolvedValueOnce({ id: 1, createdBy: "portal-user-1" });

      await service.addMessage("org1", "portal-user-1", 1, { body: "hello" } as never);

      expect(mockTickets.addMessage).toHaveBeenCalledWith(
        "org1",
        1,
        "portal-user-1",
        { body: "hello", isInternal: false, attachments: undefined },
        { channel: "portal" },
      );
    });
  });
});
