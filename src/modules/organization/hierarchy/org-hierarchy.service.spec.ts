import { BadRequestException, ConflictException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import type { OrgHierarchyCacheService } from "../../../common/cache/org-hierarchy-cache.service";
import { OrgHierarchyBranchesService } from "./org-hierarchy-branches.service";
import { OrgHierarchyBusinessUnitsService } from "./org-hierarchy-business-units.service";
import { OrgHierarchyCommandService } from "./org-hierarchy-command.service";
import { OrgHierarchyCostCentersService } from "./org-hierarchy-cost-centers.service";
import { OrgHierarchyDepartmentsService } from "./org-hierarchy-departments.service";
import { OrgHierarchyDependenciesService } from "./org-hierarchy-dependencies.service";
import { OrgHierarchyLocationsService } from "./org-hierarchy-locations.service";
import { OrgHierarchyReadService } from "./org-hierarchy-read.service";
import { OrgHierarchyService } from "./org-hierarchy.service";
import { OrgHierarchyTeamsService } from "./org-hierarchy-teams.service";

describe("OrgHierarchyService integrity boundaries", () => {
  const orgId = "org-1";
  const userId = "user-1";
  const unitId = "00000000-0000-0000-0000-000000000001";
  let parentRows: unknown[];
  let businessUnits: {
    createBusinessUnit: jest.Mock;
    getBusinessUnit: jest.Mock;
    updateBusinessUnit: jest.Mock;
  };
  let branches: {
    createOrgBranch: jest.Mock;
    updateOrgBranch: jest.Mock;
    getOrgBranch: jest.Mock;
  };
  let dependencies: {
    listDependencies: jest.Mock;
  };
  let departments: {
    createDepartment: jest.Mock;
    getDepartment: jest.Mock;
    updateDepartment: jest.Mock;
  };
  let teams: {
    createTeam: jest.Mock;
    getTeam: jest.Mock;
    updateTeam: jest.Mock;
  };
  let commands: { run: jest.Mock };
  let locations: {
    createLocation: jest.Mock;
    listLocations: jest.Mock;
    updateLocation: jest.Mock;
  };
  let costCenters: {
    createCostCenter: jest.Mock;
    listCostCenters: jest.Mock;
    updateCostCenter: jest.Mock;
  };
  let hierarchyCache: { invalidateAfterMutation: jest.Mock };
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
      createBusinessUnit: jest.fn(),
      getBusinessUnit: jest.fn(),
      updateBusinessUnit: jest.fn(),
    };
    branches = {
      createOrgBranch: jest.fn(),
      updateOrgBranch: jest.fn(),
      getOrgBranch: jest.fn(),
    };
    departments = {
      createDepartment: jest.fn(),
      getDepartment: jest.fn(),
      updateDepartment: jest.fn(),
    };
    teams = {
      createTeam: jest.fn(),
      getTeam: jest.fn(),
      updateTeam: jest.fn(),
    };
    dependencies = {
      listDependencies: jest.fn().mockResolvedValue([]),
    };
    commands = {
      run: jest
        .fn()
        .mockImplementation(
          async (
            _orgId: string,
            _unitId: string,
            _kind: string,
            _mode: string,
            mutation: () => Promise<unknown>,
          ) => mutation(),
        ),
    };
    locations = {
      createLocation: jest.fn(),
      listLocations: jest.fn(),
      updateLocation: jest.fn(),
    };
    costCenters = {
      createCostCenter: jest.fn(),
      listCostCenters: jest.fn(),
      updateCostCenter: jest.fn(),
    };
    hierarchyCache = {
      invalidateAfterMutation: jest.fn().mockResolvedValue(undefined),
    };

    service = new OrgHierarchyService(
      db,
      businessUnits as unknown as OrgHierarchyBusinessUnitsService,
      branches as unknown as OrgHierarchyBranchesService,
      departments as unknown as OrgHierarchyDepartmentsService,
      teams as unknown as OrgHierarchyTeamsService,
      locations as unknown as OrgHierarchyLocationsService,
      costCenters as unknown as OrgHierarchyCostCentersService,
      dependencies as unknown as OrgHierarchyDependenciesService,
      commands as unknown as OrgHierarchyCommandService,
      {} as OrgHierarchyReadService,
      hierarchyCache as unknown as OrgHierarchyCacheService,
    );
  });

  it("forwards cursor filters to location and cost-center lists", async () => {
    const query = {
      cursor: "cursor-2",
      limit: 25,
      search: "north",
      status: "ACTIVE" as const,
    };
    const page = {
      data: [],
      pageInfo: { limit: 25, hasMore: false, nextCursor: null },
    };
    locations.listLocations.mockResolvedValue(page);
    costCenters.listCostCenters.mockResolvedValue(page);

    await expect(service.listLocations(orgId, query)).resolves.toBe(page);
    await expect(service.listCostCenters(orgId, query)).resolves.toBe(page);

    expect(locations.listLocations).toHaveBeenCalledWith(orgId, query);
    expect(costCenters.listCostCenters).toHaveBeenCalledWith(orgId, query);
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
    commands.run.mockRejectedValue(
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

    expect(commands.run).toHaveBeenCalledWith(
      orgId,
      unitId,
      "BRANCH",
      "archive",
      expect.any(Function),
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

  it("invalidates after successful create, update, archive and restore mutations", async () => {
    businessUnits.createBusinessUnit.mockResolvedValue({ id: "bu-created" });
    locations.updateLocation.mockResolvedValue({ id: "location-updated" });
    costCenters.updateCostCenter.mockResolvedValue({ id: "cost-center-archived" });
    businessUnits.getBusinessUnit.mockResolvedValue({ parentId: null });
    businessUnits.updateBusinessUnit.mockResolvedValue({ id: "bu-restored" });

    await service.createBusinessUnit(orgId, userId, {
      name: "Operations",
      code: "OPS",
    });
    await service.updateLocation(orgId, userId, unitId, {
      name: "Bengaluru",
    });
    await service.updateCostCenter(orgId, userId, unitId, {
      status: "ARCHIVED",
    });
    await service.updateBusinessUnit(orgId, userId, unitId, {
      status: "ACTIVE",
    });

    expect(hierarchyCache.invalidateAfterMutation).toHaveBeenCalledTimes(4);
    expect(hierarchyCache.invalidateAfterMutation).toHaveBeenCalledWith(orgId);
  });
});
