import { Injectable, NotFoundException } from "@nestjs/common";
import type { OrgHierarchyCacheContext } from "../../../common/cache/org-hierarchy-cache.service";
import type {
  BranchOptionsQueryInput,
  CreateBusinessUnitInput,
  CreateCostCenterInput,
  CreateOrgBranchInput,
  CreateOrgDepartmentInput,
  CreateOrgLocationInput,
  CreateOrgTeamInput,
  ListQueryInput,
  UpdateBusinessUnitInput,
  UpdateCostCenterInput,
  UpdateOrgBranchInput,
  UpdateOrgDepartmentInput,
  UpdateOrgLocationInput,
  UpdateOrgTeamInput,
} from "./dto/org-hierarchy.schemas";
import { OrgHierarchyBranchesService } from "./org-hierarchy-branches.service";
import { OrgHierarchyBusinessUnitsService } from "./org-hierarchy-business-units.service";
import { OrgHierarchyCommandService } from "./org-hierarchy-command.service";
import { OrgHierarchyCostCentersService } from "./org-hierarchy-cost-centers.service";
import { OrgHierarchyDepartmentsService } from "./org-hierarchy-departments.service";
import {
  OrgHierarchyDependenciesService,
  type OrgUnitKind,
} from "./org-hierarchy-dependencies.service";
import { OrgHierarchyLocationsService } from "./org-hierarchy-locations.service";
import { OrgHierarchyReadService } from "./org-hierarchy-read.service";
import { OrgHierarchyTeamsService } from "./org-hierarchy-teams.service";

@Injectable()
export class OrgHierarchyService {
  constructor(
    private readonly businessUnits: OrgHierarchyBusinessUnitsService,
    private readonly branches: OrgHierarchyBranchesService,
    private readonly departments: OrgHierarchyDepartmentsService,
    private readonly teams: OrgHierarchyTeamsService,
    private readonly locations: OrgHierarchyLocationsService,
    private readonly costCenters: OrgHierarchyCostCentersService,
    private readonly dependencies: OrgHierarchyDependenciesService,
    private readonly commands: OrgHierarchyCommandService,
    private readonly reads: OrgHierarchyReadService,
  ) {}

  private updateWithArchiveGuard<T>(
    orgId: string,
    unitId: string,
    kind: OrgUnitKind,
    status: string | undefined,
    mutation: () => Promise<T>,
  ): Promise<T> {
    return status === "ARCHIVED"
      ? this.commands.run(orgId, unitId, kind, mutation)
      : mutation();
  }

  listBusinessUnits(orgId: string, query: ListQueryInput) {
    return this.businessUnits.listBusinessUnits(orgId, query);
  }

  getBusinessUnit(orgId: string, businessUnitId: string) {
    return this.businessUnits.getBusinessUnit(orgId, businessUnitId);
  }

  createBusinessUnit(
    orgId: string,
    userId: string,
    body: CreateBusinessUnitInput,
  ) {
    return this.businessUnits.createBusinessUnit(orgId, userId, body);
  }

  updateBusinessUnit(
    orgId: string,
    userId: string,
    businessUnitId: string,
    body: UpdateBusinessUnitInput,
  ) {
    return this.updateWithArchiveGuard(
      orgId,
      businessUnitId,
      "BUSINESS_UNIT",
      body.status,
      () =>
        this.businessUnits.updateBusinessUnit(
          orgId,
          userId,
          businessUnitId,
          body,
        ),
    );
  }

  listOrgBranches(orgId: string, query: ListQueryInput) {
    return this.branches.listOrgBranches(orgId, query);
  }

  listOrgBranchOptions(orgId: string, query: BranchOptionsQueryInput) {
    return this.branches.listOrgBranchOptions(orgId, query);
  }

  getOrgBranch(orgId: string, branchId: string) {
    return this.branches.getOrgBranch(orgId, branchId);
  }

  createOrgBranch(orgId: string, userId: string, body: CreateOrgBranchInput) {
    return this.branches.createOrgBranch(orgId, userId, body);
  }

  updateOrgBranch(
    orgId: string,
    userId: string,
    branchId: string,
    body: UpdateOrgBranchInput,
  ) {
    return this.updateWithArchiveGuard(
      orgId,
      branchId,
      "BRANCH",
      body.status,
      () => this.branches.updateOrgBranch(orgId, userId, branchId, body),
    );
  }

  listDepartments(orgId: string, query: ListQueryInput) {
    return this.departments.listDepartments(orgId, query);
  }

  getDepartment(orgId: string, departmentId: string) {
    return this.departments.getDepartment(orgId, departmentId);
  }

  createDepartment(
    orgId: string,
    userId: string,
    body: CreateOrgDepartmentInput,
  ) {
    return this.departments.createDepartment(orgId, userId, body);
  }

  updateDepartment(
    orgId: string,
    userId: string,
    departmentId: string,
    body: UpdateOrgDepartmentInput,
  ) {
    return this.updateWithArchiveGuard(
      orgId,
      departmentId,
      "DEPARTMENT",
      body.status,
      () => this.departments.updateDepartment(orgId, userId, departmentId, body),
    );
  }

  listTeams(orgId: string, query: ListQueryInput) {
    return this.teams.listTeams(orgId, query);
  }

  getTeam(orgId: string, teamId: string) {
    return this.teams.getTeam(orgId, teamId);
  }

  createTeam(orgId: string, userId: string, body: CreateOrgTeamInput) {
    return this.teams.createTeam(orgId, userId, body);
  }

  updateTeam(
    orgId: string,
    userId: string,
    teamId: string,
    body: UpdateOrgTeamInput,
  ) {
    return this.updateWithArchiveGuard(orgId, teamId, "TEAM", body.status, () =>
      this.teams.updateTeam(orgId, userId, teamId, body),
    );
  }

  listLocations(orgId: string, query: ListQueryInput) {
    return this.locations.listLocations(orgId, query);
  }

  getLocation(orgId: string, locationId: string) {
    return this.locations.getLocation(orgId, locationId);
  }

  createLocation(orgId: string, userId: string, body: CreateOrgLocationInput) {
    return this.locations.createLocation(orgId, userId, body);
  }

  updateLocation(
    orgId: string,
    userId: string,
    locationId: string,
    body: UpdateOrgLocationInput,
  ) {
    return this.updateWithArchiveGuard(
      orgId,
      locationId,
      "LOCATION",
      body.status,
      () => this.locations.updateLocation(orgId, userId, locationId, body),
    );
  }

  listCostCenters(orgId: string, query: ListQueryInput) {
    return this.costCenters.listCostCenters(orgId, query);
  }

  getCostCenter(orgId: string, costCenterId: string) {
    return this.costCenters.getCostCenter(orgId, costCenterId);
  }

  createCostCenter(orgId: string, userId: string, body: CreateCostCenterInput) {
    return this.costCenters.createCostCenter(orgId, userId, body);
  }

  updateCostCenter(
    orgId: string,
    userId: string,
    costCenterId: string,
    body: UpdateCostCenterInput,
  ) {
    return this.updateWithArchiveGuard(
      orgId,
      costCenterId,
      "COST_CENTER",
      body.status,
      () => this.costCenters.updateCostCenter(orgId, userId, costCenterId, body),
    );
  }

  async getDependencyPreview(
    orgId: string,
    unitId: string,
    kind: OrgUnitKind,
  ) {
    const unit = await this.getUnitByKind(orgId, unitId, kind);
    if (!unit) throw new NotFoundException("Organization unit not found");
    const dependencies = await this.dependencies.listDependencies(
      orgId,
      unitId,
      kind,
    );
    return {
      unitId,
      unitKind: kind,
      dependencies,
      totalDependencies: dependencies.reduce(
        (total, dependency) => total + dependency.count,
        0,
      ),
    };
  }

  private getUnitByKind(orgId: string, unitId: string, kind: OrgUnitKind) {
    switch (kind) {
      case "BUSINESS_UNIT":
        return this.businessUnits.getBusinessUnit(orgId, unitId);
      case "BRANCH":
        return this.branches.getOrgBranch(orgId, unitId);
      case "DEPARTMENT":
        return this.departments.getDepartment(orgId, unitId);
      case "TEAM":
        return this.teams.getTeam(orgId, unitId);
      case "LOCATION":
        return this.locations.getLocation(orgId, unitId);
      case "COST_CENTER":
        return this.costCenters.getCostCenter(orgId, unitId);
    }
  }

  getHierarchy(orgId: string, context: OrgHierarchyCacheContext) {
    return this.reads.getHierarchy(orgId, context);
  }

  getTree(orgId: string, context: OrgHierarchyCacheContext) {
    return this.reads.getTree(orgId, context);
  }
}
