import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { isUndefinedTable } from "../../../common/db/postgres-error";
import type { Db } from "../../../db/drizzle.module";
import { orgUnitClosure } from "../../../db/schema/common/org-unit-closure";
import { organizationMembers } from "../../../db/schema/common/auth";
import { orgUnits } from "../../../db/schema/common/organization";

import { hrmsMigrationProfiles } from "../../../db/schema/directory/hrms-migration-profile";
const headMember = alias(organizationMembers, "head_member");

const TREE_KINDS = ["BUSINESS_UNIT", "BRANCH", "DEPARTMENT", "TEAM"] as const;

const ORG_TREE_COLUMNS = {
  id: orgUnits.id,
  orgId: orgUnits.orgId,
  kind: orgUnits.kind,
  parentId: orgUnits.parentId,
  name: orgUnits.name,
  code: orgUnits.code,
  description: orgUnits.description,
  status: orgUnits.status,
  metadata: orgUnits.metadata,
  createdAt: orgUnits.createdAt,
  updatedAt: orgUnits.updatedAt,
  deletedAt: orgUnits.deletedAt,
};

const ORG_TREE_READ_COLUMNS = {
  ...ORG_TREE_COLUMNS,
  headUserId: headMember.userId,
};

const closureSelfRows = alias(orgUnitClosure, "hierarchy_tree_self_rows");
const closureParentRows = alias(orgUnitClosure, "hierarchy_tree_parent_rows");

const ORG_CLOSURE_TREE_COLUMNS = {
  ...ORG_TREE_READ_COLUMNS,
  closureSelfId: closureSelfRows.descendantId,
  closureParentId: closureParentRows.ancestorId,
};

export type OrgTreeRow = Pick<
  typeof orgUnits.$inferSelect,
  keyof typeof ORG_TREE_COLUMNS
> & { headUserId: string | null };

export type HierarchyTreeReadMode = "ADJACENCY" | "SHADOW_CLOSURE" | "CLOSURE";

export type HierarchyTreeReadProfile = {
  mode: HierarchyTreeReadMode;
  revision: number;
};

type ClosureTreeRow = OrgTreeRow & {
  closureSelfId: string | null;
  closureParentId: string | null;
};

// Drizzle wraps the driver error, so the SQLSTATE rides on `cause`, not the top level.
function isMissingRelation(error: unknown): boolean {
  return isUndefinedTable(error);
}

const PROFILE_RELATION = "hrms_migration_profiles";
const CLOSURE_RELATION = "org_unit_closure";

@Injectable()
export class OrgHierarchyTreeSourceService {
  private readonly presentRelations = new Set<string>();

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * Asking the catalog costs one cheap lookup; asking the table costs the whole
   * request. A 42P01 aborts the surrounding tenant transaction, so every later
   * query dies 25P02 and catching the original error cannot rescue it.
   */
  private async relationExists(relation: string): Promise<boolean> {
    if (this.presentRelations.has(relation)) return true;
    const rows = await this.db.execute(
      sql`SELECT to_regclass(${relation}) IS NOT NULL AS present`,
    );
    const present = rows[0]?.["present"] === true;
    if (present) this.presentRelations.add(relation);
    return present;
  }

  async resolveReadProfile(orgId: string): Promise<HierarchyTreeReadProfile> {
    if (!(await this.relationExists(PROFILE_RELATION)))
      return { mode: "ADJACENCY", revision: 0 };
    try {
      const [profile] = await this.db
        .select({
          mode: hrmsMigrationProfiles.hierarchyReadMode,
          revision: hrmsMigrationProfiles.profileRevision,
        })
        .from(hrmsMigrationProfiles)
        .where(eq(hrmsMigrationProfiles.organizationId, orgId))
        .limit(1);

      return profile
        ? { mode: profile.mode, revision: profile.revision }
        : { mode: "ADJACENCY", revision: 0 };
    } catch (error) {
      if (isMissingRelation(error)) return { mode: "ADJACENCY", revision: 0 };
      throw error;
    }
  }

  async loadTreeRows(
    orgId: string,
    profile: HierarchyTreeReadProfile,
  ): Promise<OrgTreeRow[]> {
    if (profile.mode === "ADJACENCY") return this.loadAdjacencyRows(orgId);

    const adjacencyRows =
      profile.mode === "SHADOW_CLOSURE"
        ? await this.loadAdjacencyRows(orgId)
        : null;
    if (!(await this.relationExists(CLOSURE_RELATION)))
      return adjacencyRows ?? this.loadAdjacencyRows(orgId);
    try {
      const closureRows = await this.loadClosureRows(orgId);
      if (!this.isCompleteProjection(closureRows))
        return adjacencyRows ?? this.loadAdjacencyRows(orgId);
      if (profile.mode === "SHADOW_CLOSURE") return adjacencyRows ?? [];
      return closureRows.map((closureRow) => {
        const {
          closureSelfId: _closureSelfId,
          closureParentId,
          ...unit
        } = closureRow;
        return { ...unit, parentId: closureParentId };
      });
    } catch (error) {
      if (isMissingRelation(error))
        return adjacencyRows ?? this.loadAdjacencyRows(orgId);
      throw error;
    }
  }

  private loadAdjacencyRows(orgId: string): Promise<OrgTreeRow[]> {
    return this.db
      .select(ORG_TREE_READ_COLUMNS)
      .from(orgUnits)
      .leftJoin(headMember, eq(headMember.id, orgUnits.headMembershipId))
      .where(this.treeFilter(orgId))
      .limit(10000);
  }

  private loadClosureRows(orgId: string): Promise<ClosureTreeRow[]> {
    return this.db
      .select(ORG_CLOSURE_TREE_COLUMNS)
      .from(orgUnits)
      .leftJoin(headMember, eq(headMember.id, orgUnits.headMembershipId))
      .leftJoin(
        closureSelfRows,
        and(
          eq(closureSelfRows.organizationId, orgUnits.orgId),
          eq(closureSelfRows.ancestorId, orgUnits.id),
          eq(closureSelfRows.descendantId, orgUnits.id),
          eq(closureSelfRows.depth, 0),
        ),
      )
      .leftJoin(
        closureParentRows,
        and(
          eq(closureParentRows.organizationId, orgUnits.orgId),
          eq(closureParentRows.descendantId, orgUnits.id),
          eq(closureParentRows.depth, 1),
        ),
      )
      .where(this.treeFilter(orgId))
      .limit(10000);
  }

  private treeFilter(orgId: string) {
    return and(
      eq(orgUnits.orgId, orgId),
      inArray(orgUnits.kind, TREE_KINDS),
      ne(orgUnits.status, "ARCHIVED"),
      isNull(orgUnits.deletedAt),
    );
  }

  private isCompleteProjection(rows: ClosureTreeRow[]): boolean {
    const unitIds = new Set<string>();
    for (const row of rows) {
      if (unitIds.has(row.id)) return false;
      unitIds.add(row.id);
      if (row.closureSelfId !== row.id) return false;
      if (row.closureParentId !== row.parentId) return false;
    }
    return true;
  }
}
