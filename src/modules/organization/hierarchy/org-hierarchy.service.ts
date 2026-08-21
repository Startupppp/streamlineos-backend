import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import {
  OrgHierarchyCacheService,
  type OrgHierarchyCacheContext,
} from "../../../common/cache/org-hierarchy-cache.service";
import {
  orgUnits,
} from "../../../db/schema/common/organization";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
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
import {
  OrgHierarchyDependenciesService,
  type DependencyMode,
  type OrgUnitKind,
} from "./org-hierarchy-dependencies.service";
import { OrgHierarchyCommandService } from "./org-hierarchy-command.service";
import { OrgHierarchyReadService } from "./org-hierarchy-read.service";

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
    private readonly dependencies: OrgHierarchyDependenciesService,
    private readonly commands: OrgHierarchyCommandService,
    private readonly reads: OrgHierarchyReadService,
    private readonly hierarchyCache: OrgHierarchyCacheService,
  ) {}

  private async mutateHierarchy<T>(
    orgId: string,
    mutation: () => Promise<T>,
  ): Promise<T> {
    const result = await mutation();
    await this.hierarchyCache.invalidateAfterMutation(orgId);
    return result;
  }

  private async assertActiveParent(
    orgId: string,
    parentId: string | null | undefined,
    kind: "BUSINESS_UNIT" | "BRANCH" | "DEPARTMENT",
    label: string,
    required = false,
  ) {
    if (!parentId) {
      if (required) {
        throw new BadRequestException(`Select an active ${label}.`);
      }
      return;
    }

    const [parent] = await this.db
      .select({ id: orgUnits.id })
      .from(orgUnits)
      .where(
        and(
          eq(orgUnits.id, parentId),
          eq(orgUnits.orgId, orgId),
          eq(orgUnits.kind, kind),
          eq(orgUnits.status, "ACTIVE"),
          isNull(orgUnits.deletedAt),
        ),
      )
      .limit(1);

    if (!parent) {
      throw new BadRequestException({
        code: "ORG_UNIT_PARENT_UNAVAILABLE",
        message: `Select an active ${label}. Archived, disabled, or removed units cannot receive new assignments.`,
      });
    }
  }

  async listBusinessUnits(orgId: string, query: ListQueryInput) {
    return this.businessUnits.listBusinessUnits(orgId, query);
  }

  async getBusinessUnit(orgId: string, businessUnitId: string) {
    return this.businessUnits.getBusinessUnit(orgId, businessUnitId);
  }

  async createBusinessUnit(orgId: string, userId: string, body: CreateBusinessUnitInput) {
    return this.mutateHierarchy(orgId, () =>
      this.businessUnits.createBusinessUnit(orgId, userId, body),
    );
  }

  async updateBusinessUnit(orgId: string, userId: string, businessUnitId: string, body: UpdateBusinessUnitInput) {
    if (body.status === "ARCHIVED") {
      return this.mutateHierarchy(orgId, () =>
        this.commands.run(orgId, businessUnitId, "BUSINESS_UNIT", "archive", () =>
          this.businessUnits.updateBusinessUnit(orgId, userId, businessUnitId, body),
        ),
      );
    }
    if (body.status === "ACTIVE") {
      const existing = await this.businessUnits.getBusinessUnit(orgId, businessUnitId);
      await this.assertActiveParent(
        orgId,
        existing?.parentId,
        "BUSINESS_UNIT",
        "business unit",
      );
    }
    return this.mutateHierarchy(orgId, () =>
      this.businessUnits.updateBusinessUnit(orgId, userId, businessUnitId, body),
    );
  }

  async deleteBusinessUnit(orgId: string, userId: string, businessUnitId: string) {
    return this.mutateHierarchy(orgId, () =>
      this.commands.run(orgId, businessUnitId, "BUSINESS_UNIT", "retire", () =>
        this.businessUnits.deleteBusinessUnit(orgId, userId, businessUnitId),
      ),
    );
  }

  async moveBusinessUnit(
    orgId: string,
    businessUnitId: string,
    newParentBusinessUnitId: string | null,
  ) {
    await this.assertActiveParent(
      orgId,
      newParentBusinessUnitId,
      "BUSINESS_UNIT",
      "business unit",
    );
    return this.mutateHierarchy(orgId, () =>
      this.businessUnits.moveBusinessUnit(
        orgId,
        businessUnitId,
        newParentBusinessUnitId,
      ),
    );
  }

  async listOrgBranches(orgId: string, query: ListQueryInput) {
    return this.branches.listOrgBranches(orgId, query);
  }

  async getOrgBranch(orgId: string, branchId: string) {
    return this.branches.getOrgBranch(orgId, branchId);
  }

  async createOrgBranch(orgId: string, userId: string, body: CreateOrgBranchInput) {
    await this.assertActiveParent(
      orgId,
      body.businessUnitId,
      "BUSINESS_UNIT",
      "business unit",
    );
    return this.mutateHierarchy(orgId, () =>
      this.branches.createOrgBranch(orgId, userId, body),
    );
  }

  async updateOrgBranch(orgId: string, userId: string, branchId: string, body: UpdateOrgBranchInput) {
    if (body.status === "ARCHIVED") {
      return this.mutateHierarchy(orgId, () =>
        this.commands.run(orgId, branchId, "BRANCH", "archive", () =>
          this.branches.updateOrgBranch(orgId, userId, branchId, body),
        ),
      );
    }
    if (body.businessUnitId !== undefined || body.status === "ACTIVE") {
      const existing =
        body.businessUnitId === undefined
          ? await this.branches.getOrgBranch(orgId, branchId)
          : null;
      await this.assertActiveParent(
        orgId,
        body.businessUnitId === undefined
          ? existing?.businessUnitId
          : body.businessUnitId,
        "BUSINESS_UNIT",
        "business unit",
      );
    }
    return this.mutateHierarchy(orgId, () =>
      this.branches.updateOrgBranch(orgId, userId, branchId, body),
    );
  }

  async deleteOrgBranch(orgId: string, userId: string, branchId: string) {
    return this.mutateHierarchy(orgId, () =>
      this.commands.run(orgId, branchId, "BRANCH", "retire", () =>
        this.branches.deleteOrgBranch(orgId, userId, branchId),
      ),
    );
  }

  async moveBranch(orgId: string, branchId: string, newBusinessUnitId: string | null) {
    await this.assertActiveParent(
      orgId,
      newBusinessUnitId,
      "BUSINESS_UNIT",
      "business unit",
    );
    return this.mutateHierarchy(orgId, () =>
      this.branches.moveBranch(orgId, branchId, newBusinessUnitId),
    );
  }

  async listDepartments(orgId: string, query: ListQueryInput) {
    return this.departments.listDepartments(orgId, query);
  }

  async getDepartment(orgId: string, departmentId: string) {
    return this.departments.getDepartment(orgId, departmentId);
  }

  async createDepartment(orgId: string, userId: string, body: CreateOrgDepartmentInput) {
    await this.assertActiveParent(
      orgId,
      body.branchId,
      "BRANCH",
      "branch",
    );
    return this.mutateHierarchy(orgId, () =>
      this.departments.createDepartment(orgId, userId, body),
    );
  }

  async updateDepartment(orgId: string, userId: string, departmentId: string, body: UpdateOrgDepartmentInput) {
    if (body.status === "ARCHIVED") {
      return this.mutateHierarchy(orgId, () =>
        this.commands.run(orgId, departmentId, "DEPARTMENT", "archive", () =>
          this.departments.updateDepartment(orgId, userId, departmentId, body),
        ),
      );
    }
    if (body.branchId !== undefined || body.status === "ACTIVE") {
      const existing =
        body.branchId === undefined
          ? await this.departments.getDepartment(orgId, departmentId)
          : null;
      await this.assertActiveParent(
        orgId,
        body.branchId === undefined ? existing?.branchId : body.branchId,
        "BRANCH",
        "branch",
      );
    }
    return this.mutateHierarchy(orgId, () =>
      this.departments.updateDepartment(orgId, userId, departmentId, body),
    );
  }

  async deleteDepartment(orgId: string, userId: string, departmentId: string) {
    return this.mutateHierarchy(orgId, () =>
      this.commands.run(orgId, departmentId, "DEPARTMENT", "retire", () =>
        this.departments.deleteDepartment(orgId, userId, departmentId),
      ),
    );
  }

  async moveDepartment(orgId: string, departmentId: string, newBranchId: string | null) {
    await this.assertActiveParent(
      orgId,
      newBranchId,
      "BRANCH",
      "branch",
    );
    return this.mutateHierarchy(orgId, () =>
      this.departments.moveDepartment(orgId, departmentId, newBranchId),
    );
  }

  async listTeams(orgId: string, query: ListQueryInput) {
    return this.teams.listTeams(orgId, query);
  }

  async getTeam(orgId: string, teamId: string) {
    return this.teams.getTeam(orgId, teamId);
  }

  async createTeam(orgId: string, userId: string, body: CreateOrgTeamInput) {
    await this.assertActiveParent(
      orgId,
      body.departmentId,
      "DEPARTMENT",
      "department",
      true,
    );
    return this.mutateHierarchy(orgId, () =>
      this.teams.createTeam(orgId, userId, body),
    );
  }

  async updateTeam(orgId: string, userId: string, teamId: string, body: UpdateOrgTeamInput) {
    if (body.status === "ARCHIVED") {
      return this.mutateHierarchy(orgId, () =>
        this.commands.run(orgId, teamId, "TEAM", "archive", () =>
          this.teams.updateTeam(orgId, userId, teamId, body),
        ),
      );
    }
    if (body.departmentId !== undefined || body.status === "ACTIVE") {
      const existing =
        body.departmentId === undefined
          ? await this.teams.getTeam(orgId, teamId)
          : null;
      await this.assertActiveParent(
        orgId,
        body.departmentId ?? existing?.departmentId,
        "DEPARTMENT",
        "department",
        true,
      );
    }
    return this.mutateHierarchy(orgId, () =>
      this.teams.updateTeam(orgId, userId, teamId, body),
    );
  }

  async deleteTeam(orgId: string, userId: string, teamId: string) {
    return this.mutateHierarchy(orgId, () =>
      this.commands.run(orgId, teamId, "TEAM", "retire", () =>
        this.teams.deleteTeam(orgId, userId, teamId),
      ),
    );
  }

  async moveTeam(orgId: string, teamId: string, newDepartmentId: string) {
    await this.assertActiveParent(
      orgId,
      newDepartmentId,
      "DEPARTMENT",
      "department",
      true,
    );
    return this.mutateHierarchy(orgId, () =>
      this.teams.moveTeam(orgId, teamId, newDepartmentId),
    );
  }

  listLocations(orgId: string, query: ListQueryInput) {
    return this.locations.listLocations(orgId, query);
  }

  async getLocation(orgId: string, locationId: string) {
    return this.locations.getLocation(orgId, locationId);
  }

  async createLocation(orgId: string, userId: string, body: CreateOrgLocationInput) {
    return this.mutateHierarchy(orgId, () =>
      this.locations.createLocation(orgId, userId, body),
    );
  }

  async updateLocation(orgId: string, userId: string, locationId: string, body: UpdateOrgLocationInput) {
    if (body.status === "ARCHIVED") {
      return this.mutateHierarchy(orgId, () =>
        this.commands.run(orgId, locationId, "LOCATION", "archive", () =>
          this.locations.updateLocation(orgId, userId, locationId, body),
        ),
      );
    }
    return this.mutateHierarchy(orgId, () =>
      this.locations.updateLocation(orgId, userId, locationId, body),
    );
  }

  async deleteLocation(orgId: string, userId: string, locationId: string) {
    return this.mutateHierarchy(orgId, () =>
      this.commands.run(orgId, locationId, "LOCATION", "retire", () =>
        this.locations.deleteLocation(orgId, userId, locationId),
      ),
    );
  }

  listCostCenters(orgId: string, query: ListQueryInput) {
    return this.costCenters.listCostCenters(orgId, query);
  }

  async getCostCenter(orgId: string, costCenterId: string) {
    return this.costCenters.getCostCenter(orgId, costCenterId);
  }

  async createCostCenter(orgId: string, userId: string, body: CreateCostCenterInput) {
    return this.mutateHierarchy(orgId, () =>
      this.costCenters.createCostCenter(orgId, userId, body),
    );
  }

  async updateCostCenter(orgId: string, userId: string, costCenterId: string, body: UpdateCostCenterInput) {
    if (body.status === "ARCHIVED") {
      return this.mutateHierarchy(orgId, () =>
        this.commands.run(orgId, costCenterId, "COST_CENTER", "archive", () =>
          this.costCenters.updateCostCenter(orgId, userId, costCenterId, body),
        ),
      );
    }
    return this.mutateHierarchy(orgId, () =>
      this.costCenters.updateCostCenter(orgId, userId, costCenterId, body),
    );
  }

  async deleteCostCenter(orgId: string, userId: string, costCenterId: string) {
    return this.mutateHierarchy(orgId, () =>
      this.commands.run(orgId, costCenterId, "COST_CENTER", "retire", () =>
        this.costCenters.deleteCostCenter(orgId, userId, costCenterId),
      ),
    );
  }

  async getDependencyPreview(
    orgId: string,
    unitId: string,
    kind: OrgUnitKind,
    mode: DependencyMode,
  ) {
    const unit = await this.getUnitByKind(orgId, unitId, kind);
    if (!unit) {
      throw new NotFoundException("Organization unit not found");
    }

    const dependencies = await this.dependencies.listDependencies(
      orgId,
      unitId,
      kind,
      mode,
    );

    return {
      unitId,
      unitKind: kind,
      mode,
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
