import type { Db } from "../../../db/drizzle.module";
import { OrgHierarchyCostCentersService } from "./org-hierarchy-cost-centers.service";
import { OrgUnitCrudService } from "./org-unit-crud";

describe("OrgHierarchyCostCentersService", () => {
  it("archives a cost center and never hard-deletes the row", async () => {
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
    const returning = jest
      .fn()
      .mockResolvedValue([{ ...costCenter, status: "ARCHIVED" as const }]);
    const where = jest.fn().mockReturnValue({ returning });
    const set = jest.fn().mockReturnValue({ where });
    const update = jest.fn().mockReturnValue({ set });
    const hardDelete = jest.fn();
    const db = {
      select,
      update,
      delete: hardDelete,
    } as unknown as Db;
    const audit = { logCritical: jest.fn().mockResolvedValue(undefined) };
    const cache = { invalidateAfterMutation: jest.fn() };
    const service = new OrgHierarchyCostCentersService(
      new OrgUnitCrudService(db, audit, cache),
    );

    const result = await service.updateCostCenter("org-1", "user-1", costCenter.id, {
      status: "ARCHIVED",
    });

    expect(result.status).toBe("ARCHIVED");
    expect(update).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith({ status: "ARCHIVED" });
    expect(hardDelete).not.toHaveBeenCalled();
    expect(audit.logCritical).toHaveBeenCalledWith(
      expect.objectContaining({ action: "org.costCenter.updated" }),
    );
    expect(cache.invalidateAfterMutation).toHaveBeenCalledWith("org-1");
  });
});
