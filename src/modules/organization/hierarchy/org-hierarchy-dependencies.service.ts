import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { sql, type SQL } from "drizzle-orm";
import {
  legalEntities,
  orgUnitMembers,
  orgUnits,
  principalGroups,
  workerEngagements,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import {
  countQuery,
  pushKindDependencyQueries,
  type OrgUnitKind,
} from "./lib/org-unit-kind-dependencies";

export const ORG_UNIT_DEPENDENCY_ERROR = "ORG_UNIT_HAS_DEPENDENCIES";

/**
 * Declared in lib/org-unit-kind-dependencies.ts, where the per-kind query
 * catalog needs it, and re-exported here because every existing importer
 * (org-hierarchy.service, org-hierarchy-command.service and their specs)
 * has always taken it from this module.
 */
export type { OrgUnitKind };

export type OrgUnitDependency = {
  key: string;
  label: string;
  count: number;
};

type DependencyCountRow = {
  key: string;
  label: string;
  count: number | string;
};

const KIND_LABELS: Record<OrgUnitKind, string> = {
  BUSINESS_UNIT: "business unit",
  BRANCH: "branch",
  DEPARTMENT: "department",
  TEAM: "team",
  LOCATION: "location",
  COST_CENTER: "cost center",
};

@Injectable()
export class OrgHierarchyDependenciesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  private buildQueries(
    orgId: string,
    unitId: string,
    kind: OrgUnitKind,
    includeLegalEntities: boolean,
  ): SQL[] {
    const queries: SQL[] = [
      countQuery(
        "child_units",
        "Non-archived child organization units",
        sql`${orgUnits}`,
        sql`${orgUnits.orgId} = ${orgId} AND ${orgUnits.parentId} = ${unitId} AND ${orgUnits.deletedAt} IS NULL ${sql`AND ${orgUnits.status} <> 'ARCHIVED'`}`,
      ),
      countQuery(
        "unit_members",
        "People assigned directly to this unit",
        sql`${orgUnitMembers}`,
        sql`${orgUnitMembers.orgId} = ${orgId} AND ${orgUnitMembers.orgUnitId} = ${unitId}`,
      ),
      countQuery(
        "access_groups",
        "Access groups scoped to this unit",
        sql`${principalGroups}`,
        sql`${principalGroups.orgId} = ${orgId} AND ${principalGroups.orgUnitId} = ${unitId}`,
      ),
    ];

    // Legal entities are being introduced behind a staged schema rollout. A
    // workspace on the earlier schema cannot contain legal-entity references,
    // so omit this dependency query until the relation exists instead of
    // turning every hierarchy archive into an undefined-table 500.
    if (includeLegalEntities)
      queries.push(
        countQuery(
          "legal_entities",
          "Active legal entities linked to this unit",
          sql`${legalEntities}`,
          sql`${legalEntities.orgId} = ${orgId} AND ${legalEntities.orgUnitId} = ${unitId} ${sql`AND ${legalEntities.status} = 'ACTIVE' AND ${legalEntities.deletedAt} IS NULL`}`,
        ),
      );

    const engagementStatus = sql`AND ${workerEngagements.status} IN ('PLANNED', 'ACTIVE')`;
    const engagementColumn =
      kind === "BUSINESS_UNIT"
        ? workerEngagements.businessUnitId
        : kind === "BRANCH"
          ? workerEngagements.branchId
          : kind === "DEPARTMENT"
            ? workerEngagements.departmentId
            : kind === "TEAM"
              ? workerEngagements.teamId
              : kind === "LOCATION"
                ? workerEngagements.locationId
                : null;
    if (engagementColumn) {
      queries.push(
        countQuery(
          "worker_assignments",
          "Current worker assignments",
          sql`${workerEngagements}`,
          sql`${workerEngagements.organizationId} = ${orgId} AND ${engagementColumn} = ${unitId} ${engagementStatus}`,
        ),
      );
    }

    pushKindDependencyQueries(queries, orgId, unitId, kind);

    return queries;
  }

  async listDependencies(
    orgId: string,
    unitId: string,
    kind: OrgUnitKind,
  ): Promise<OrgUnitDependency[]> {
    const [capability] = await this.db.execute<{ available: boolean }>(sql`
      SELECT to_regclass('public.legal_entities') IS NOT NULL AS available
    `);
    const rows = await this.db.execute<DependencyCountRow>(
      sql.join(
        this.buildQueries(orgId, unitId, kind, capability?.available === true),
        sql` UNION ALL `,
      ),
    );
    return rows
      .map((row) => ({
        key: row.key,
        label: row.label,
        count: Number(row.count),
      }))
      .filter((row) => row.count > 0);
  }

  private async assertNoDependencies(
    orgId: string,
    unitId: string,
    kind: OrgUnitKind,
  ): Promise<void> {
    const dependencies = await this.listDependencies(orgId, unitId, kind);
    if (dependencies.length === 0) return;

    throw new ConflictException({
      code: ORG_UNIT_DEPENDENCY_ERROR,
      message: `This ${KIND_LABELS[kind]} is still in use. Move or update its dependent records before you archive it.`,
      details: {
        unitId,
        unitKind: kind,
        action: "archive",
        dependencies,
        totalDependencies: dependencies.reduce(
          (total, dependency) => total + dependency.count,
          0,
        ),
      },
    });
  }

  assertCanArchive(orgId: string, unitId: string, kind: OrgUnitKind) {
    return this.assertNoDependencies(orgId, unitId, kind);
  }
}
