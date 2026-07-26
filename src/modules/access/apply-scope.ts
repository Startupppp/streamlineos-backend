import { eq, inArray, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { DataScope } from "./access.types";

export interface ScopeColumns {
  ownerColumn: PgColumn;
  teamColumn?: PgColumn;
  teamIds?: string[];
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
      // §5: when no real team membership source is available, fail closed rather
      // than silently narrowing to "own" — a team-scoped grant must not act as
      // a broader grant than intended.
      return sql`false`;
    }
    case "none":
      return sql`false`;
    default: {
      const _exhaustive: never = scope;
      return sql`false`;
    }
  }
}
