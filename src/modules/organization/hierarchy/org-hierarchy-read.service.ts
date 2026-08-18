import { Inject, Injectable } from "@nestjs/common";
import { and, count, eq, isNull, ne } from "drizzle-orm";
import {
  OrgHierarchyCacheService,
  type OrgHierarchyCacheContext,
} from "../../../common/cache/org-hierarchy-cache.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { orgUnits } from "../../../db/schema/common/organization";
import { toOrgTeam } from "./org-hierarchy-teams.service";
import {
  OrgHierarchyTreeSourceService,
  type HierarchyTreeReadProfile,
  type OrgTreeRow,
} from "./org-hierarchy-tree-source.service";

@Injectable()
export class OrgHierarchyReadService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly hierarchyCache: OrgHierarchyCacheService,
    private readonly treeSource: OrgHierarchyTreeSourceService,
  ) {}

  getHierarchy(orgId: string, context: OrgHierarchyCacheContext) {
    return this.hierarchyCache.read(orgId, "overview", context, () =>
      this.buildHierarchy(orgId),
    );
  }

  async getTree(orgId: string, context: OrgHierarchyCacheContext) {
    const profile = await this.treeSource.resolveReadProfile(orgId);
    return this.hierarchyCache.read(
      orgId,
      `tree:${profile.mode}:r${profile.revision}`,
      context,
      () => this.buildTree(orgId, profile),
    );
  }

  private async buildHierarchy(orgId: string) {
    const countRows = await this.db
      .select({ kind: orgUnits.kind, count: count() })
      .from(orgUnits)
      .where(
        and(
          eq(orgUnits.orgId, orgId),
          ne(orgUnits.status, "ARCHIVED"),
          isNull(orgUnits.deletedAt),
        ),
      )
      .groupBy(orgUnits.kind);

    const counts = new Map(
      countRows.map((countRow) => [countRow.kind, Number(countRow.count)]),
    );
    return {
      businessUnits: counts.get("BUSINESS_UNIT") ?? 0,
      branches: counts.get("BRANCH") ?? 0,
      departments: counts.get("DEPARTMENT") ?? 0,
      teams: counts.get("TEAM") ?? 0,
      locations: counts.get("LOCATION") ?? 0,
      costCenters: counts.get("COST_CENTER") ?? 0,
    };
  }

  private async buildTree(
    orgId: string,
    profile: HierarchyTreeReadProfile,
  ) {
    const allUnits = await this.treeSource.loadTreeRows(orgId, profile);

    const byName = (leftUnit: { name: string }, rightUnit: { name: string }) =>
      leftUnit.name.localeCompare(rightUnit.name);
    const buIds = this.idsForKind(allUnits, "BUSINESS_UNIT");
    const branchIds = this.idsForKind(allUnits, "BRANCH");
    const departmentIds = this.idsForKind(allUnits, "DEPARTMENT");
    const branchesByBu = new Map<string | null, OrgTreeRow[]>();
    const departmentsByBranch = new Map<string | null, OrgTreeRow[]>();
    const teamsByDepartment = new Map<string | null, OrgTreeRow[]>();

    for (const unit of allUnits) {
      if (unit.kind === "BRANCH") {
        this.addToBucket(
          branchesByBu,
          this.validParent(unit.parentId, buIds),
          unit,
        );
      } else if (unit.kind === "DEPARTMENT") {
        this.addToBucket(
          departmentsByBranch,
          this.validParent(unit.parentId, branchIds),
          unit,
        );
      } else if (unit.kind === "TEAM") {
        this.addToBucket(
          teamsByDepartment,
          this.validParent(unit.parentId, departmentIds),
          unit,
        );
      }
    }

    const buildTeam = (team: OrgTreeRow) => ({
      ...toOrgTeam(team),
      type: "team" as const,
      children: [],
    });
    const buildDepartment = (departmentRow: OrgTreeRow) => {
      const {
        kind: _kind,
        parentId: branchId,
        metadata: _metadata,
        ...department
      } = departmentRow;
      return {
        ...department,
        branchId,
        type: "department" as const,
        children: (teamsByDepartment.get(departmentRow.id) ?? [])
          .sort(byName)
          .map(buildTeam),
      };
    };
    const buildBranch = (branchRow: OrgTreeRow) => {
      const {
        kind: _kind,
        parentId: businessUnitId,
        headUserId: managerUserId,
        metadata,
        ...branch
      } = branchRow;
      return {
        ...branch,
        businessUnitId,
        managerUserId,
        address: metadata?.address ?? null,
        city: metadata?.city ?? null,
        state: metadata?.state ?? null,
        country: metadata?.country ?? null,
        postalCode: metadata?.postalCode ?? null,
        phone: metadata?.phone ?? null,
        email: metadata?.email ?? null,
        type: "branch" as const,
        children: (departmentsByBranch.get(branchRow.id) ?? [])
          .sort(byName)
          .map(buildDepartment),
      };
    };
    const buildBusinessUnit = (businessUnitRow: OrgTreeRow) => {
      const {
        kind: _kind,
        parentId: _parentId,
        headUserId: _headUserId,
        metadata: _metadata,
        ...businessUnit
      } = businessUnitRow;
      return {
        ...businessUnit,
        type: "business_unit" as const,
        children: (branchesByBu.get(businessUnitRow.id) ?? [])
          .sort(byName)
          .map(buildBranch),
      };
    };

    return [
      ...allUnits
        .filter((unit) => unit.kind === "BUSINESS_UNIT")
        .sort(byName)
        .map(buildBusinessUnit),
      ...(branchesByBu.get(null) ?? []).sort(byName).map(buildBranch),
      ...(departmentsByBranch.get(null) ?? [])
        .sort(byName)
        .map(buildDepartment),
      ...(teamsByDepartment.get(null) ?? []).sort(byName).map(buildTeam),
    ];
  }

  private idsForKind(
    units: OrgTreeRow[],
    kind: OrgTreeRow["kind"],
  ): Set<string> {
    return new Set(
      units.filter((unit) => unit.kind === kind).map((unit) => unit.id),
    );
  }

  private validParent(
    parentId: string | null,
    validIds: ReadonlySet<string>,
  ): string | null {
    return parentId !== null && validIds.has(parentId) ? parentId : null;
  }

  private addToBucket(
    buckets: Map<string | null, OrgTreeRow[]>,
    parentId: string | null,
    unit: OrgTreeRow,
  ): void {
    const bucket = buckets.get(parentId) ?? [];
    bucket.push(unit);
    buckets.set(parentId, bucket);
  }
}
