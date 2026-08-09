import { BadRequestException, ConflictException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { OrgHierarchyBranchesService } from "./org-hierarchy-branches.service";
import { OrgHierarchyBusinessUnitsService } from "./org-hierarchy-business-units.service";
import { OrgHierarchyCostCentersService } from "./org-hierarchy-cost-centers.service";
import { OrgHierarchyDepartmentsService } from "./org-hierarchy-departments.service";
import { OrgHierarchyDependenciesService } from "./org-hierarchy-dependencies.service";
import { OrgHierarchyLocationsService } from "./org-hierarchy-locations.service";
import { OrgHierarchyService } from "./org-hierarchy.service";
import { OrgHierarchyTeamsService } from "./org-hierarchy-teams.service";

describe("OrgHierarchyService integrity boundaries", () => {
  const orgId = "org-1";
  const userId = "user-1";
  const unitId = "00000000-0000-0000-0000-000000000001";
  let parentRows: unknown[];
  let businessUnits: {
    getBusinessUnit: jest.Mock;
    moveBusinessUnit: jest.Mock;
    updateBusinessUnit: jest.Mock;
  };
  let branches: {
    createOrgBranch: jest.Mock;
    deleteOrgBranch: jest.Mock;
    updateOrgBranch: jest.Mock;
    getOrgBranch: jest.Mock;
  };
  let dependencies: {
    assertCanArchive: jest.Mock;
    assertCanRetire: jest.Mock;
    listDependencies: jest.Mock;
  };
  let service: OrgHierarchyService;

  beforeEach(() => {
    parentRows = [];
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockImplementation(async () => parentRows),
          }),
        }),
      }),
    } as unknown as Db;
    businessUnits = {
      getBusinessUnit: jest.fn(),
      moveBusinessUnit: jest.fn(),
      updateBusinessUnit: jest.fn(),
    };
    branches = {
      createOrgBranch: jest.fn(),
      deleteOrgBranch: jest.fn(),
      updateOrgBranch: jest.fn(),
      getOrgBranch: jest.fn(),
    };
    dependencies = {
      assertCanArchive: jest.fn().mockResolvedValue(undefined),
      assertCanRetire: jest.fn().mockResolvedValue(undefined),
      listDependencies: jest.fn().mockResolvedValue([]),
    };

    service = new OrgHierarchyService(
      db,
      businessUnits as unknown as OrgHierarchyBusinessUnitsService,
      branches as unknown as OrgHierarchyBranchesService,
      {} as OrgHierarchyDepartmentsService,
      {} as OrgHierarchyTeamsService,
      {} as OrgHierarchyLocationsService,
      {} as OrgHierarchyCostCentersService,
      dependencies as unknown as OrgHierarchyDependenciesService,
    );
  });

  it("previews dependencies without mutating the organization unit", async () => {
    branches.getOrgBranch.mockResolvedValue({ id: unitId, name: "North" });
    dependencies.listDependencies.mockResolvedValue([
      { key: "workers", label: "Current worker assignments", count: 3 },
    ]);

    await expect(
      service.getDependencyPreview(orgId, unitId, "BRANCH", "archive"),
    ).resolves.toEqual({
      unitId,
      unitKind: "BRANCH",
      mode: "archive",
      dependencies: [
        { key: "workers", label: "Current worker assignments", count: 3 },
      ],
      totalDependencies: 3,
    });

    expect(dependencies.listDependencies).toHaveBeenCalledWith(
      orgId,
      unitId,
      "BRANCH",
      "archive",
    );
    expect(branches.updateOrgBranch).not.toHaveBeenCalled();
  });

  it("does not mutate a unit when the dependency guard blocks archival", async () => {
    dependencies.assertCanArchive.mockRejectedValue(
      new ConflictException({
        code: "ORG_UNIT_HAS_DEPENDENCIES",
        message: "This branch is still in use.",
      }),
    );

    await expect(
      service.updateOrgBranch(orgId, userId, unitId, {
        status: "ARCHIVED",
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(dependencies.assertCanArchive).toHaveBeenCalledWith(
      orgId,
      unitId,
      "BRANCH",
    );
    expect(branches.updateOrgBranch).not.toHaveBeenCalled();
  });

  it("rejects a new assignment to an archived, disabled, or removed parent", async () => {
    await expect(
      service.createOrgBranch(orgId, userId, {
        name: "West",
        code: "WEST",
        businessUnitId: unitId,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(branches.createOrgBranch).not.toHaveBeenCalled();
  });

  it("allows a new assignment when the parent is active in the same organization", async () => {
    parentRows = [{ id: unitId }];
    branches.createOrgBranch.mockResolvedValue({ id: "branch-1" });

    await expect(
      service.createOrgBranch(orgId, userId, {
        name: "West",
        code: "WEST",
        businessUnitId: unitId,
      }),
    ).resolves.toEqual({ id: "branch-1" });

    expect(branches.createOrgBranch).toHaveBeenCalledTimes(1);
  });

  it("rejects moving a business unit under an unavailable parent", async () => {
    await expect(
      service.moveBusinessUnit(orgId, unitId, "00000000-0000-0000-0000-000000000002"),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(businessUnits.moveBusinessUnit).not.toHaveBeenCalled();
  });

  it("prevents restoring a nested business unit beneath an unavailable parent", async () => {
    businessUnits.getBusinessUnit.mockResolvedValue({ parentId: unitId });

    await expect(
      service.updateBusinessUnit(orgId, userId, "child-business-unit", {
        status: "ACTIVE",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(businessUnits.updateBusinessUnit).not.toHaveBeenCalled();
  });

  it("prevents restoring a child while its existing parent is unavailable", async () => {
    branches.getOrgBranch.mockResolvedValue({ businessUnitId: unitId });

    await expect(
      service.updateOrgBranch(orgId, userId, "branch-1", {
        status: "ACTIVE",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(branches.updateOrgBranch).not.toHaveBeenCalled();
  });

  it("guards the legacy remove endpoint before applying its soft removal", async () => {
    dependencies.assertCanRetire.mockRejectedValue(
      new ConflictException("Historical dependencies remain"),
    );

    await expect(
      service.deleteOrgBranch(orgId, userId, unitId),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(dependencies.assertCanRetire).toHaveBeenCalledWith(
      orgId,
      unitId,
      "BRANCH",
    );
    expect(branches.deleteOrgBranch).not.toHaveBeenCalled();
  });
});
