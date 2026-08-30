import { eq, inArray, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { DataScope } from "./access.types";

export interface ScopeColumns {
  ownerColumn: PgColumn;
  teamColumn?: PgColumn;
  teamIds?: string[];
}

export function applyScope(
  scope: DataScope,
  _orgId: string,
  userId: string,
  cols: ScopeColumns,
): SQL {
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
      return eq(cols.ownerColumn, userId);
    }
    case "none":
      return sql`false`;
    default: {
      const _exhaustive: never = scope;
      return sql`false`;
    }
  }
}
