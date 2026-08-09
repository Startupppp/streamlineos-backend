import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
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
import {
  OrgHierarchyDependenciesService,
  type DependencyMode,
  type OrgUnitKind,
} from "./org-hierarchy-dependencies.service";

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
    if (body.status === "ACTIVE") {
      const existing = await this.businessUnits.getBusinessUnit(orgId, id);
      await this.assertActiveParent(
        orgId,
        existing?.parentId,
        "BUSINESS_UNIT",
        "business unit",
      );
    }
    return this.businessUnits.updateBusinessUnit(orgId, userId, id, body);
  }

  async deleteBusinessUnit(orgId: string, userId: string, id: string) {
    await this.dependencies.assertCanRetire(orgId, id, "BUSINESS_UNIT");
    return this.businessUnits.deleteBusinessUnit(orgId, userId, id);
  }

  async moveBusinessUnit(orgId: string, buId: string, newParentId: string | null) {
    await this.assertActiveParent(
      orgId,
      newParentId,
      "BUSINESS_UNIT",
      "business unit",
    );
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

  listLocations(orgId: string, query: ListQueryInput) {
    return this.locations.listLocations(orgId, query);
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

  listCostCenters(orgId: string, query: ListQueryInput) {
    return this.costCenters.listCostCenters(orgId, query);
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

    type Row = (typeof allUnits)[number];

    const buIds = new Set(
      allUnits.filter((u) => u.kind === "BUSINESS_UNIT").map((u) => u.id),
    );
    const branchIds = new Set(
      allUnits.filter((u) => u.kind === "BRANCH").map((u) => u.id),
    );
    const deptIds = new Set(
      allUnits.filter((u) => u.kind === "DEPARTMENT").map((u) => u.id),
    );

    const branchesByBu = new Map<string | null, Row[]>();
    const deptsByBranch = new Map<string | null, Row[]>();
    const teamsByDept = new Map<string | null, Row[]>();

    for (const u of allUnits) {
      if (u.kind === "BRANCH") {
        const key =
          u.parentId !== null && buIds.has(u.parentId) ? u.parentId : null;
        const bucket = branchesByBu.get(key) ?? [];
        bucket.push(u);
        branchesByBu.set(key, bucket);
      } else if (u.kind === "DEPARTMENT") {
        const key =
          u.parentId !== null && branchIds.has(u.parentId)
            ? u.parentId
            : null;
        const bucket = deptsByBranch.get(key) ?? [];
        bucket.push(u);
        deptsByBranch.set(key, bucket);
      } else if (u.kind === "TEAM") {
        const key =
          u.parentId !== null && deptIds.has(u.parentId) ? u.parentId : null;
        const bucket = teamsByDept.get(key) ?? [];
        bucket.push(u);
        teamsByDept.set(key, bucket);
      }
    }

    const buildTeam = (team: Row) => ({
      ...toOrgTeam(team),
      type: "team" as const,
      children: [],
    });

    const buildDept = (dept: Row) => {
      const {
        kind: _deptKind,
        parentId: branchId,
        metadata: _deptMetadata,
        ...department
      } = dept;
      return {
        ...department,
        branchId,
        type: "department" as const,
        children: (teamsByDept.get(dept.id) ?? []).sort(byName).map(buildTeam),
      };
    };

    const buildBranch = (branch: Row) => {
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
        type: "branch" as const,
        children: (deptsByBranch.get(branch.id) ?? [])
          .sort(byName)
          .map(buildDept),
      };
    };

    const buildBu = (bu: Row) => {
      const {
        kind: _buKind,
        parentId: _buParentId,
        headUserId: _buHeadUserId,
        metadata: _buMetadata,
        ...businessUnit
      } = bu;
      return {
        ...businessUnit,
        type: "business_unit" as const,
        children: (branchesByBu.get(bu.id) ?? [])
          .sort(byName)
          .map(buildBranch),
      };
    };

    const buRoots = allUnits
      .filter((u) => u.kind === "BUSINESS_UNIT")
      .sort(byName)
      .map(buildBu);

    const orphanBranchRoots = (branchesByBu.get(null) ?? [])
      .sort(byName)
      .map(buildBranch);
    const orphanDeptRoots = (deptsByBranch.get(null) ?? [])
      .sort(byName)
      .map(buildDept);
    const orphanTeamRoots = (teamsByDept.get(null) ?? [])
      .sort(byName)
      .map(buildTeam);

    return [
      ...buRoots,
      ...orphanBranchRoots,
      ...orphanDeptRoots,
      ...orphanTeamRoots,
    ];
  }
}
