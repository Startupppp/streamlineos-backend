import { Test, type TestingModule } from "@nestjs/testing";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { SupportCustomFieldsService } from "./support-custom-fields.service";
import { DRIZZLE } from "../../../db/drizzle.constants";

const mockTicketFindFirst = jest.fn().mockResolvedValue({ id: 42 });

const mockDb = {
  query: { supportTickets: { findFirst: mockTicketFindFirst } },
  insert: jest.fn().mockReturnThis(),
  values: jest.fn().mockReturnThis(),
  onConflictDoUpdate: jest.fn().mockResolvedValue(undefined),
  returning: jest.fn().mockResolvedValue([{ id: 1 }]),
  update: jest.fn().mockReturnThis(),
  set: jest.fn().mockReturnThis(),
  delete: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  select: jest.fn().mockReturnThis(),
  from: jest.fn().mockReturnThis(),
  innerJoin: jest.fn().mockReturnThis(),
  limit: jest.fn().mockResolvedValue([]),
  orderBy: jest.fn().mockResolvedValue([]),
};

describe("SupportCustomFieldsService", () => {
  let service: SupportCustomFieldsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockTicketFindFirst.mockResolvedValue({ id: 42 });
    mockDb.returning.mockResolvedValue([{ id: 1 }]);
    mockDb.onConflictDoUpdate.mockResolvedValue(undefined);
    mockDb.where.mockReturnThis();
    mockDb.limit.mockResolvedValue([]);
    mockDb.orderBy.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [SupportCustomFieldsService, { provide: DRIZZLE, useValue: mockDb }],
    }).compile();
    service = module.get(SupportCustomFieldsService);
  });

  describe("createField", () => {
    it("throws ConflictException when the key already exists for the org", async () => {
      mockDb.limit.mockResolvedValueOnce([{ id: 1, key: "order_number" }]);

      await expect(
        service.createField("org1", {
          key: "order_number",
          label: "Order #",
          fieldType: "text",
          required: false,
          sortOrder: 0,
          isActive: true,
        } as never),
      ).rejects.toThrow(ConflictException);
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it("creates the field when the key is unique", async () => {
      mockDb.limit.mockResolvedValueOnce([]);

      await service.createField("org1", {
        key: "order_number",
        label: "Order #",
        fieldType: "text",
        required: false,
        sortOrder: 0,
        isActive: true,
      } as never);

      expect(mockDb.insert).toHaveBeenCalled();
    });
  });

  describe("updateField / deleteField", () => {
    it("throws NotFoundException when updating a field that doesn't exist in the org", async () => {
      mockDb.returning.mockResolvedValueOnce([]);
      await expect(service.updateField("org1", 999, { label: "New" } as never)).rejects.toThrow(NotFoundException);
    });

    it("throws NotFoundException when deleting a field that doesn't exist in the org", async () => {
      mockDb.returning.mockResolvedValueOnce([]);
      await expect(service.deleteField("org1", 999)).rejects.toThrow(NotFoundException);
    });
  });

  describe("setFieldValues", () => {
    it("throws ConflictException when a required active field is missing from the payload", async () => {
      mockDb.where.mockReturnValueOnce({
        orderBy: jest.fn().mockResolvedValue([
          { id: 1, orgId: "org1", key: "order_number", label: "Order #", fieldType: "text",
            isRequired: true, category: null, displayOrder: 0, isActive: true, options: null,
            createdAt: new Date(), updatedAt: new Date(), entityType: "support_ticket", projectId: 0 },
        ]),
      });

      await expect(service.setFieldValues("org1", 42, [], true)).rejects.toThrow(ConflictException);
    });

    it("silently drops values for fieldIds that don't belong to the org", async () => {
      mockDb.where.mockResolvedValueOnce([]);

      await service.setFieldValues("org1", 42, [{ fieldId: 999, value: "x" }] as never, true);

      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it("upserts a value for a field that belongs to the org", async () => {
      mockDb.where.mockResolvedValueOnce([
        { id: 1, orgId: "org1", key: "order_number", label: "Order #", fieldType: "text",
          isRequired: false, category: null, displayOrder: 0, isActive: true, options: null,
          createdAt: new Date(), updatedAt: new Date(), entityType: "support_ticket", projectId: 0 },
      ]);

      await service.setFieldValues("org1", 42, [{ fieldId: 1, value: "ORD-1" }] as never, true);

      expect(mockDb.insert).toHaveBeenCalled();
      expect(mockDb.values).toHaveBeenCalledWith([{ orgId: "org1", ticketId: 42, fieldDefinitionId: 1, value: "ORD-1" }]);
      expect(mockDb.onConflictDoUpdate).toHaveBeenCalled();
    });

    it("skips DB work entirely when there's nothing to set and required enforcement is off", async () => {
      await service.setFieldValues("org1", 42, [], false);
      expect(mockDb.insert).not.toHaveBeenCalled();
    });
  });

  describe("getFieldValues", () => {
    it("refuses a ticket outside the caller's org", async () => {
      mockTicketFindFirst.mockResolvedValueOnce(undefined);

      await expect(service.getFieldValues("org1", 42)).rejects.toThrow(NotFoundException);
    });

    it("joins values with their field definitions", async () => {
      mockDb.where.mockResolvedValueOnce([
        { fieldId: 1, value: "ORD-1", key: "order_number", label: "Order #", fieldType: "text" },
      ]);

      const result = await service.getFieldValues("org1", 42);

      expect(result).toEqual([
        { fieldId: 1, value: "ORD-1", key: "order_number", label: "Order #", fieldType: "text" },
      ]);
    });
  });
});
