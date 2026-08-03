import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { alias, type PgColumn } from "drizzle-orm/pg-core";
import { orgUnitMembers, orgUnits } from "../../db/schema";
import type { DataScope } from "./access.types";

export interface ScopeColumns {
  ownerColumn: PgColumn;
  teamColumn?: PgColumn;
  teamIds?: string[];
}

const peerUnits = alias(orgUnitMembers, "scope_peer_unit");
const teammates = alias(orgUnitMembers, "scope_teammate");

/** Everyone sharing at least one TEAM org-unit with `userId`. */
function teammateUserIds(userId: string): SQL {
  return sql`(
    SELECT ${teammates.userId}
    FROM ${teammates}
    WHERE ${teammates.orgUnitId} IN (
      SELECT ${peerUnits.orgUnitId}
      FROM ${peerUnits}
      JOIN ${orgUnits} ON ${eq(orgUnits.id, peerUnits.orgUnitId)}
      WHERE ${and(eq(peerUnits.userId, userId), eq(orgUnits.kind, "TEAM"))}
    )
  )`;
}

export function applyScope(scope: DataScope, userId: string, cols: ScopeColumns): SQL {
  switch (scope) {
    case "all":
      return sql`true`;
    case "own":
      return eq(cols.ownerColumn, userId);
    case "team": {
      if (cols.teamColumn && cols.teamIds && cols.teamIds.length > 0) {
        const byOwner = eq(cols.ownerColumn, userId);
        return sql`(${byOwner} OR ${inArray(cols.teamColumn, cols.teamIds)})`;
      }
      // No team column on this table, so resolve teammates from org_unit_members instead of failing closed
      return sql`(${eq(cols.ownerColumn, userId)} OR ${cols.ownerColumn} IN ${teammateUserIds(userId)})`;
    }
    case "none":
      return sql`false`;
    default: {
      const _exhaustive: never = scope;
      return sql`false`;
    }
  }
}
