import { Test, type TestingModule } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { SupportIntegrationsService } from "./support-integrations.service";
import { DRIZZLE } from "../../../db/drizzle.constants";

const mockDb = {
  query: {
    supportTickets: { findFirst: jest.fn() },
    supportTicketExternalLinks: { findMany: jest.fn().mockResolvedValue([]) },
    projects: { findFirst: jest.fn() },
    invoices: { findFirst: jest.fn() },
    calendarEvents: { findFirst: jest.fn() },
    chatChannels: { findFirst: jest.fn() },
  },
  insert: jest.fn().mockReturnThis(),
  values: jest.fn().mockReturnThis(),
  onConflictDoNothing: jest.fn().mockReturnThis(),
  returning: jest.fn().mockResolvedValue([]),
  delete: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
};

describe("SupportIntegrationsService", () => {
  let service: SupportIntegrationsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockDb.query.supportTickets.findFirst.mockResolvedValue({ id: 1 });

    const module: TestingModule = await Test.createTestingModule({
      providers: [SupportIntegrationsService, { provide: DRIZZLE, useValue: mockDb }],
    }).compile();
    service = module.get(SupportIntegrationsService);
  });

  describe("addLink", () => {
    it("throws NotFoundException when the ticket doesn't exist in the org", async () => {
      mockDb.query.supportTickets.findFirst.mockResolvedValueOnce(undefined);

      await expect(
        service.addLink("org1", 1, "user1", { entityType: "project", entityId: 5 } as never),
      ).rejects.toThrow(NotFoundException);
    });

    it("throws NotFoundException when the referenced project doesn't exist in the org", async () => {
      mockDb.query.projects.findFirst.mockResolvedValueOnce(undefined);

      await expect(
        service.addLink("org1", 1, "user1", { entityType: "project", entityId: 5 } as never),
      ).rejects.toThrow(NotFoundException);
    });

    it("resolves the project's name as the link label", async () => {
      mockDb.query.projects.findFirst.mockResolvedValueOnce({ name: "Website Redesign" });
      mockDb.returning.mockResolvedValueOnce([
        { id: 1, ticketId: 1, entityType: "project", entityId: 5, label: "Website Redesign" },
      ]);

      const result = await service.addLink("org1", 1, "user1", { entityType: "project", entityId: 5 } as never);

      expect(result).toMatchObject({ label: "Website Redesign" });
      expect(mockDb.values).toHaveBeenCalledWith(
        expect.objectContaining({ ticketId: 1, entityType: "project", entityId: 5, label: "Website Redesign" }),
      );
    });

    it("resolves the invoice number as the link label", async () => {
      mockDb.query.invoices.findFirst.mockResolvedValueOnce({ invoiceNumber: "INV-1042" });
      mockDb.returning.mockResolvedValueOnce([{ id: 2, label: "INV-1042" }]);

      const result = await service.addLink("org1", 1, "user1", { entityType: "invoice", entityId: 10 } as never);

      expect(result).toMatchObject({ label: "INV-1042" });
    });

    it("resolves the calendar event title as the link label", async () => {
      mockDb.query.calendarEvents.findFirst.mockResolvedValueOnce({ title: "Customer escalation call" });
      mockDb.returning.mockResolvedValueOnce([{ id: 3, label: "Customer escalation call" }]);

      const result = await service.addLink("org1", 1, "user1", {
        entityType: "calendar_event",
        entityId: 20,
      } as never);

      expect(result).toMatchObject({ label: "Customer escalation call" });
    });

    it("resolves the chat channel name as the link label", async () => {
      mockDb.query.chatChannels.findFirst.mockResolvedValueOnce({ name: "#customer-a-escalations" });
      mockDb.returning.mockResolvedValueOnce([{ id: 4, label: "#customer-a-escalations" }]);

      const result = await service.addLink("org1", 1, "user1", {
        entityType: "chat_channel",
        entityId: 30,
      } as never);

      expect(result).toMatchObject({ label: "#customer-a-escalations" });
    });
  });

  describe("listLinks", () => {
    it("throws NotFoundException when the ticket doesn't exist in the org", async () => {
      mockDb.query.supportTickets.findFirst.mockResolvedValueOnce(undefined);
      await expect(service.listLinks("org1", 1)).rejects.toThrow(NotFoundException);
    });

    it("returns the ticket's external links", async () => {
      mockDb.query.supportTicketExternalLinks.findMany.mockResolvedValueOnce([
        { id: 1, entityType: "project", entityId: 5, label: "Website Redesign" },
      ]);
      await expect(service.listLinks("org1", 1)).resolves.toHaveLength(1);
    });
  });

  describe("removeLink", () => {
    it("throws NotFoundException when the ticket doesn't exist in the org", async () => {
      mockDb.query.supportTickets.findFirst.mockResolvedValueOnce(undefined);
      await expect(service.removeLink("org1", 1, 5)).rejects.toThrow(NotFoundException);
    });

    it("throws NotFoundException when the link doesn't exist", async () => {
      mockDb.returning.mockResolvedValueOnce([]);
      await expect(service.removeLink("org1", 1, 999)).rejects.toThrow(NotFoundException);
    });

    it("deletes the link", async () => {
      mockDb.returning.mockResolvedValueOnce([{ id: 5 }]);
      await expect(service.removeLink("org1", 1, 5)).resolves.toEqual({ success: true });
    });
  });
});
