import {
  BadRequestException,
  Inject,
  Injectable,
} from "@nestjs/common";
import { and, eq, isNull, ne } from "drizzle-orm";
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
import {
  OrgHierarchyTeamsService,
  toOrgTeam,
} from "./org-hierarchy-teams.service";
import { OrgHierarchyLocationsService } from "./org-hierarchy-locations.service";
import { OrgHierarchyCostCentersService } from "./org-hierarchy-cost-centers.service";
import { OrgHierarchyDependenciesService } from "./org-hierarchy-dependencies.service";

const ORG_TREE_COLUMNS = {
  id: orgUnits.id,
  orgId: orgUnits.orgId,
  kind: orgUnits.kind,
  parentId: orgUnits.parentId,
  name: orgUnits.name,
  code: orgUnits.code,
  description: orgUnits.description,
  headUserId: orgUnits.headUserId,
  status: orgUnits.status,
  metadata: orgUnits.metadata,
  createdAt: orgUnits.createdAt,
  updatedAt: orgUnits.updatedAt,
  deletedAt: orgUnits.deletedAt,
};

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
  ) {}

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

  async getBusinessUnit(orgId: string, id: string) {
    return this.businessUnits.getBusinessUnit(orgId, id);
  }

  async createBusinessUnit(orgId: string, userId: string, body: CreateBusinessUnitInput) {
    return this.businessUnits.createBusinessUnit(orgId, userId, body);
  }

  async updateBusinessUnit(orgId: string, userId: string, id: string, body: UpdateBusinessUnitInput) {
    if (body.status === "ARCHIVED") {
      await this.dependencies.assertCanArchive(orgId, id, "BUSINESS_UNIT");
    }
    return this.businessUnits.updateBusinessUnit(orgId, userId, id, body);
  }

  async deleteBusinessUnit(orgId: string, userId: string, id: string) {
    await this.dependencies.assertCanRetire(orgId, id, "BUSINESS_UNIT");
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
    await this.assertActiveParent(
      orgId,
      body.businessUnitId,
      "BUSINESS_UNIT",
      "business unit",
    );
    return this.branches.createOrgBranch(orgId, userId, body);
  }

  async updateOrgBranch(orgId: string, userId: string, id: string, body: UpdateOrgBranchInput) {
    if (body.status === "ARCHIVED") {
      await this.dependencies.assertCanArchive(orgId, id, "BRANCH");
    }
    if (body.businessUnitId !== undefined || body.status === "ACTIVE") {
      const existing =
        body.businessUnitId === undefined
          ? await this.branches.getOrgBranch(orgId, id)
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
    return this.branches.updateOrgBranch(orgId, userId, id, body);
  }

  async deleteOrgBranch(orgId: string, userId: string, id: string) {
    await this.dependencies.assertCanRetire(orgId, id, "BRANCH");
    return this.branches.deleteOrgBranch(orgId, userId, id);
  }

  async moveBranch(orgId: string, branchId: string, newBusinessUnitId: string | null) {
    await this.assertActiveParent(
      orgId,
      newBusinessUnitId,
      "BUSINESS_UNIT",
      "business unit",
    );
    return this.branches.moveBranch(orgId, branchId, newBusinessUnitId);
  }

  async listDepartments(orgId: string, query: ListQueryInput) {
    return this.departments.listDepartments(orgId, query);
  }

  async getDepartment(orgId: string, id: string) {
    return this.departments.getDepartment(orgId, id);
  }

  async createDepartment(orgId: string, userId: string, body: CreateOrgDepartmentInput) {
    await this.assertActiveParent(
      orgId,
      body.branchId,
      "BRANCH",
      "branch",
    );
    return this.departments.createDepartment(orgId, userId, body);
  }

  async updateDepartment(orgId: string, userId: string, id: string, body: UpdateOrgDepartmentInput) {
    if (body.status === "ARCHIVED") {
      await this.dependencies.assertCanArchive(orgId, id, "DEPARTMENT");
    }
    if (body.branchId !== undefined || body.status === "ACTIVE") {
      const existing =
        body.branchId === undefined
          ? await this.departments.getDepartment(orgId, id)
          : null;
      await this.assertActiveParent(
        orgId,
        body.branchId === undefined ? existing?.branchId : body.branchId,
        "BRANCH",
        "branch",
      );
    }
    return this.departments.updateDepartment(orgId, userId, id, body);
  }

  async deleteDepartment(orgId: string, userId: string, id: string) {
    await this.dependencies.assertCanRetire(orgId, id, "DEPARTMENT");
    return this.departments.deleteDepartment(orgId, userId, id);
  }

  async moveDepartment(orgId: string, departmentId: string, newBranchId: string | null) {
    await this.assertActiveParent(
      orgId,
      newBranchId,
      "BRANCH",
      "branch",
    );
    return this.departments.moveDepartment(orgId, departmentId, newBranchId);
  }

  async listTeams(orgId: string, query: ListQueryInput) {
    return this.teams.listTeams(orgId, query);
  }

  async getTeam(orgId: string, id: string) {
    return this.teams.getTeam(orgId, id);
  }

  async createTeam(orgId: string, userId: string, body: CreateOrgTeamInput) {
    await this.assertActiveParent(
      orgId,
      body.departmentId,
      "DEPARTMENT",
      "department",
      true,
    );
    return this.teams.createTeam(orgId, userId, body);
  }

  async updateTeam(orgId: string, userId: string, id: string, body: UpdateOrgTeamInput) {
    if (body.status === "ARCHIVED") {
      await this.dependencies.assertCanArchive(orgId, id, "TEAM");
    }
    if (body.departmentId !== undefined || body.status === "ACTIVE") {
      const existing =
        body.departmentId === undefined
          ? await this.teams.getTeam(orgId, id)
          : null;
      await this.assertActiveParent(
        orgId,
        body.departmentId ?? existing?.departmentId,
        "DEPARTMENT",
        "department",
        true,
      );
    }
    return this.teams.updateTeam(orgId, userId, id, body);
  }

  async deleteTeam(orgId: string, userId: string, id: string) {
    await this.dependencies.assertCanRetire(orgId, id, "TEAM");
    return this.teams.deleteTeam(orgId, userId, id);
  }

  async moveTeam(orgId: string, teamId: string, newDepartmentId: string) {
    await this.assertActiveParent(
      orgId,
      newDepartmentId,
      "DEPARTMENT",
      "department",
      true,
    );
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
    if (body.status === "ARCHIVED") {
      await this.dependencies.assertCanArchive(orgId, id, "LOCATION");
    }
    return this.locations.updateLocation(orgId, userId, id, body);
  }

  async deleteLocation(orgId: string, userId: string, id: string) {
    await this.dependencies.assertCanRetire(orgId, id, "LOCATION");
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
    if (body.status === "ARCHIVED") {
      await this.dependencies.assertCanArchive(orgId, id, "COST_CENTER");
    }
    return this.costCenters.updateCostCenter(orgId, userId, id, body);
  }

  async deleteCostCenter(orgId: string, userId: string, id: string) {
    await this.dependencies.assertCanRetire(orgId, id, "COST_CENTER");
    return this.costCenters.deleteCostCenter(orgId, userId, id);
  }

  async getHierarchy(orgId: string) {
    const rows = await this.db
      .select({ kind: orgUnits.kind })
      .from(orgUnits)
      .where(
        and(
          eq(orgUnits.orgId, orgId),
          ne(orgUnits.status, "ARCHIVED"),
          isNull(orgUnits.deletedAt),
        ),
      );

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
      .select(ORG_TREE_COLUMNS)
      .from(orgUnits)
      .where(
        and(
          eq(orgUnits.orgId, orgId),
          ne(orgUnits.status, "ARCHIVED"),
          isNull(orgUnits.deletedAt),
        ),
      );

    const byName = (a: { name: string }, b: { name: string }) =>
      a.name.localeCompare(b.name);
    const bus = allUnits
      .filter((u) => u.kind === "BUSINESS_UNIT")
      .sort(byName);

    return bus.map((bu) => {
      const buBranches = allUnits.filter(
        (u) => u.kind === "BRANCH" && u.parentId === bu.id,
      ).sort(byName);
      const {
        kind: _buKind,
        parentId: _buParentId,
        headUserId: _buHeadUserId,
        metadata: _buMetadata,
        ...businessUnit
      } = bu;
      return {
        ...businessUnit,
        type: "business_unit",
        children: buBranches.map((branch) => {
          const depts = allUnits.filter(
            (u) => u.kind === "DEPARTMENT" && u.parentId === branch.id,
          ).sort(byName);
          const {
            kind: _branchKind,
            parentId: businessUnitId,
            headUserId: managerUserId,
            metadata: branchMetadata,
            ...branchFields
          } = branch;
          return {
            ...branchFields,
            businessUnitId,
            managerUserId,
            address: branchMetadata?.address ?? null,
            city: branchMetadata?.city ?? null,
            state: branchMetadata?.state ?? null,
            country: branchMetadata?.country ?? null,
            postalCode: branchMetadata?.postalCode ?? null,
            phone: branchMetadata?.phone ?? null,
            email: branchMetadata?.email ?? null,
            type: "branch",
            children: depts.map((dept) => {
              const teamsForDept = allUnits.filter(
                (u) => u.kind === "TEAM" && u.parentId === dept.id,
              ).sort(byName);
              const {
                kind: _deptKind,
                parentId: branchId,
                metadata: _deptMetadata,
                ...department
              } = dept;
              return {
                ...department,
                branchId,
                type: "department",
                children: teamsForDept.map((team) => ({
                  ...toOrgTeam(team),
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
