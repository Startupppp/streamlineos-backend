import {
  Inject,
  Injectable,
} from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import {
  orgUnits,
} from "../../db/schema/common/organization";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type {
  CreateBusinessUnitInput,
  UpdateBusinessUnitInput,
  CreateOrgBranchInput,
  UpdateOrgBranchInput,
  CreateOrgDepartmentInput,
  UpdateOrgDepartmentInput,
  CreateOrgTeamInput,
  UpdateOrgTeamInput,
  CreateOrgLocationInput,
  UpdateOrgLocationInput,
  CreateCostCenterInput,
  UpdateCostCenterInput,
  ListQueryInput,
} from "./dto/org-hierarchy.schemas";
import { OrgHierarchyBusinessUnitsService } from "./org-hierarchy-business-units.service";
import { OrgHierarchyBranchesService } from "./org-hierarchy-branches.service";
import { OrgHierarchyDepartmentsService } from "./org-hierarchy-departments.service";
import { OrgHierarchyTeamsService } from "./org-hierarchy-teams.service";
import { OrgHierarchyLocationsService } from "./org-hierarchy-locations.service";
import { OrgHierarchyCostCentersService } from "./org-hierarchy-cost-centers.service";

@Injectable()
export class OrgHierarchyService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly businessUnits: OrgHierarchyBusinessUnitsService,
    private readonly branches: OrgHierarchyBranchesService,
    private readonly departments: OrgHierarchyDepartmentsService,
    private readonly teams: OrgHierarchyTeamsService,
    private readonly locations: OrgHierarchyLocationsService,
    private readonly costCenters: OrgHierarchyCostCentersService,
  ) {}

  async listBusinessUnits(orgId: string, query: ListQueryInput) {
    return this.businessUnits.listBusinessUnits(orgId, query);
  }

  async getBusinessUnit(orgId: string, id: string) {
    return this.businessUnits.getBusinessUnit(orgId, id);
  }

  async createBusinessUnit(orgId: string, userId: string, body: CreateBusinessUnitInput) {
    return this.businessUnits.createBusinessUnit(orgId, userId, body);
  }

  async updateBusinessUnit(orgId: string, userId: string, id: string, body: UpdateBusinessUnitInput) {
    return this.businessUnits.updateBusinessUnit(orgId, userId, id, body);
  }

  async deleteBusinessUnit(orgId: string, userId: string, id: string) {
    return this.businessUnits.deleteBusinessUnit(orgId, userId, id);
  }

  async moveBusinessUnit(orgId: string, buId: string, newParentId: string | null) {
    return this.businessUnits.moveBusinessUnit(orgId, buId, newParentId);
  }

  async listOrgBranches(orgId: string, query: ListQueryInput) {
    return this.branches.listOrgBranches(orgId, query);
  }

  async getOrgBranch(orgId: string, id: string) {
    return this.branches.getOrgBranch(orgId, id);
  }

  async createOrgBranch(orgId: string, userId: string, body: CreateOrgBranchInput) {
    return this.branches.createOrgBranch(orgId, userId, body);
  }

  async updateOrgBranch(orgId: string, userId: string, id: string, body: UpdateOrgBranchInput) {
    return this.branches.updateOrgBranch(orgId, userId, id, body);
  }

  async deleteOrgBranch(orgId: string, userId: string, id: string) {
    return this.branches.deleteOrgBranch(orgId, userId, id);
  }

  async moveBranch(orgId: string, branchId: string, newBusinessUnitId: string | null) {
    return this.branches.moveBranch(orgId, branchId, newBusinessUnitId);
  }

  async listDepartments(orgId: string, query: ListQueryInput) {
    return this.departments.listDepartments(orgId, query);
  }

  async getDepartment(orgId: string, id: string) {
    return this.departments.getDepartment(orgId, id);
  }

  async createDepartment(orgId: string, userId: string, body: CreateOrgDepartmentInput) {
    return this.departments.createDepartment(orgId, userId, body);
  }

  async updateDepartment(orgId: string, userId: string, id: string, body: UpdateOrgDepartmentInput) {
    return this.departments.updateDepartment(orgId, userId, id, body);
  }

  async deleteDepartment(orgId: string, userId: string, id: string) {
    return this.departments.deleteDepartment(orgId, userId, id);
  }

  async moveDepartment(orgId: string, departmentId: string, newBranchId: string | null) {
    return this.departments.moveDepartment(orgId, departmentId, newBranchId);
  }

  async listTeams(orgId: string, query: ListQueryInput) {
    return this.teams.listTeams(orgId, query);
  }

  async getTeam(orgId: string, id: string) {
    return this.teams.getTeam(orgId, id);
  }

  async createTeam(orgId: string, userId: string, body: CreateOrgTeamInput) {
    return this.teams.createTeam(orgId, userId, body);
  }

  async updateTeam(orgId: string, userId: string, id: string, body: UpdateOrgTeamInput) {
    return this.teams.updateTeam(orgId, userId, id, body);
  }

  async deleteTeam(orgId: string, userId: string, id: string) {
    return this.teams.deleteTeam(orgId, userId, id);
  }

  async moveTeam(orgId: string, teamId: string, newDepartmentId: string | null) {
    return this.teams.moveTeam(orgId, teamId, newDepartmentId);
  }

  listLocations(orgId: string) {
    return this.locations.listLocations(orgId);
  }

  async getLocation(orgId: string, id: string) {
    return this.locations.getLocation(orgId, id);
  }

  async createLocation(orgId: string, userId: string, body: CreateOrgLocationInput) {
    return this.locations.createLocation(orgId, userId, body);
  }

  async updateLocation(orgId: string, userId: string, id: string, body: UpdateOrgLocationInput) {
    return this.locations.updateLocation(orgId, userId, id, body);
  }

  async deleteLocation(orgId: string, userId: string, id: string) {
    return this.locations.deleteLocation(orgId, userId, id);
  }

  listCostCenters(orgId: string) {
    return this.costCenters.listCostCenters(orgId);
  }

  async getCostCenter(orgId: string, id: string) {
    return this.costCenters.getCostCenter(orgId, id);
  }

  async createCostCenter(orgId: string, userId: string, body: CreateCostCenterInput) {
    return this.costCenters.createCostCenter(orgId, userId, body);
  }

  async updateCostCenter(orgId: string, userId: string, id: string, body: UpdateCostCenterInput) {
    return this.costCenters.updateCostCenter(orgId, userId, id, body);
  }

  async deleteCostCenter(orgId: string, userId: string, id: string) {
    return this.costCenters.deleteCostCenter(orgId, userId, id);
  }

  async getHierarchy(orgId: string) {
    const rows = await this.db
      .select({ kind: orgUnits.kind })
      .from(orgUnits)
      .where(and(eq(orgUnits.orgId, orgId), isNull(orgUnits.deletedAt)));

    const counts: Record<string, number> = {};
    for (const row of rows) {
      counts[row.kind] = (counts[row.kind] ?? 0) + 1;
    }

    return {
      businessUnits: counts["BUSINESS_UNIT"] ?? 0,
      branches: counts["BRANCH"] ?? 0,
      departments: counts["DEPARTMENT"] ?? 0,
      teams: counts["TEAM"] ?? 0,
      locations: counts["LOCATION"] ?? 0,
      costCenters: counts["COST_CENTER"] ?? 0,
    };
  }

  async getTree(orgId: string) {
    const allUnits = await this.db
      .select()
      .from(orgUnits)
      .where(and(eq(orgUnits.orgId, orgId), isNull(orgUnits.deletedAt)));

    const bus = allUnits.filter((u) => u.kind === "BUSINESS_UNIT");

    return bus.map((bu) => {
      const buBranches = allUnits.filter(
        (u) => u.kind === "BRANCH" && u.parentId === bu.id,
      );
      return {
        ...bu,
        type: "business_unit",
        children: buBranches.map((branch) => {
          const depts = allUnits.filter(
            (u) => u.kind === "DEPARTMENT" && u.parentId === branch.id,
          );
          return {
            ...branch,
            type: "branch",
            children: depts.map((dept) => {
              const teamsForDept = allUnits.filter(
                (u) => u.kind === "TEAM" && u.parentId === dept.id,
              );
              return {
                ...dept,
                type: "department",
                children: teamsForDept.map((team) => ({
                  ...team,
                  type: "team",
                  children: [],
                })),
              };
            }),
          };
        }),
      };
    });
  }
}
