import type { AuditService } from "../../../common/audit/audit.service";
import type { CacheService } from "../../../common/cache/cache.service";
import type { Db } from "../../../db/drizzle.module";
import { OrgHierarchyCostCentersService } from "./org-hierarchy-cost-centers.service";

describe("OrgHierarchyCostCentersService", () => {
  it("soft-removes a cost center and never hard-deletes the row", async () => {
    const costCenter = {
      id: "00000000-0000-0000-0000-000000000001",
      orgId: "org-1",
      name: "Engineering",
      code: "ENG",
      description: null,
      status: "ACTIVE" as const,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    };
    const limit = jest.fn().mockResolvedValue([costCenter]);
    const select = jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ limit }),
      }),
    });
    const where = jest.fn().mockResolvedValue(undefined);
    const set = jest.fn().mockReturnValue({ where });
    const update = jest.fn().mockReturnValue({ set });
    const hardDelete = jest.fn();
    const db = {
      select,
      update,
      delete: hardDelete,
    } as unknown as Db;
    const cache = {
      invalidate: jest.fn().mockResolvedValue(undefined),
      invalidateForOrg: jest.fn().mockResolvedValue(undefined),
      invalidateNamespaceForOrg: jest.fn().mockResolvedValue(undefined),
    } as unknown as CacheService;
    const audit = {
      logCritical: jest.fn().mockResolvedValue(undefined),
    } as unknown as AuditService;
    const service = new OrgHierarchyCostCentersService(db, cache, audit);

    await service.deleteCostCenter("org-1", "user-1", costCenter.id);

    expect(update).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith({ deletedAt: expect.any(Date) });
    expect(hardDelete).not.toHaveBeenCalled();
    expect(cache.invalidate).toHaveBeenCalled();
    expect(audit.logCritical).toHaveBeenCalledWith(
      expect.objectContaining({ action: "org.costCenter.deleted" }),
    );
  });
});
