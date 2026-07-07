import { Test, type TestingModule } from "@nestjs/testing";
import { SupportSettingsAuditService } from "./support-settings-audit.service";
import { DRIZZLE } from "../../db/drizzle.constants";

const mockDb = {
  insert: jest.fn().mockReturnThis(),
  values: jest.fn().mockResolvedValue(undefined),
  query: {
    supportSettingsAuditLog: { findMany: jest.fn().mockResolvedValue([]) },
  },
};

describe("SupportSettingsAuditService", () => {
  let service: SupportSettingsAuditService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockDb.values.mockResolvedValue(undefined);
    mockDb.query.supportSettingsAuditLog.findMany.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [SupportSettingsAuditService, { provide: DRIZZLE, useValue: mockDb }],
    }).compile();
    service = module.get(SupportSettingsAuditService);
  });

  describe("record", () => {
    it("inserts an audit log row with the given fields", async () => {
      await service.record("org1", "user1", "sla_policy", 5, "created", { name: "Default" });

      expect(mockDb.insert).toHaveBeenCalled();
      expect(mockDb.values).toHaveBeenCalledWith({
        orgId: "org1",
        userId: "user1",
        entityType: "sla_policy",
        entityId: "5",
        action: "created",
        changes: { name: "Default" },
      });
    });

    it("swallows and logs errors rather than throwing, so it never blocks the underlying write", async () => {
      mockDb.values.mockRejectedValueOnce(new Error("db down"));

      await expect(service.record("org1", "user1", "channel", 1, "deleted")).resolves.toBeUndefined();
    });

    it("stores a null userId when the actor is a system process", async () => {
      await service.record("org1", null, "automation", 9, "updated");

      expect(mockDb.values).toHaveBeenCalledWith(
        expect.objectContaining({ userId: null, changes: null }),
      );
    });
  });

  describe("list", () => {
    it("filters by entityType when provided", async () => {
      await service.list("org1", "sla_policy");
      expect(mockDb.query.supportSettingsAuditLog.findMany).toHaveBeenCalled();
    });

    it("lists all entity types when none is specified", async () => {
      await service.list("org1");
      expect(mockDb.query.supportSettingsAuditLog.findMany).toHaveBeenCalled();
    });
  });
});
