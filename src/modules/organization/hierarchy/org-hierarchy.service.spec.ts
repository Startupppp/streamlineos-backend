import { ConflictException } from "@nestjs/common";
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
  let service: OrgHierarchyService;

  beforeEach(() => {
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
    service = new OrgHierarchyService(
      businessUnits as unknown as OrgHierarchyBusinessUnitsService,
      branches as unknown as OrgHierarchyBranchesService,
      departments as unknown as OrgHierarchyDepartmentsService,
      teams as unknown as OrgHierarchyTeamsService,
      locations as unknown as OrgHierarchyLocationsService,
      costCenters as unknown as OrgHierarchyCostCentersService,
      dependencies as unknown as OrgHierarchyDependenciesService,
      commands as unknown as OrgHierarchyCommandService,
      {} as OrgHierarchyReadService,
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
      service.getDependencyPreview(orgId, unitId, "BRANCH"),
    ).resolves.toEqual({
      unitId,
      unitKind: "BRANCH",
      dependencies: [
        { key: "workers", label: "Current worker assignments", count: 3 },
      ],
      totalDependencies: 3,
    });

    expect(dependencies.listDependencies).toHaveBeenCalledWith(
      orgId,
      unitId,
      "BRANCH",
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
      expect.any(Function),
    );
    expect(branches.updateOrgBranch).not.toHaveBeenCalled();
  });

});
