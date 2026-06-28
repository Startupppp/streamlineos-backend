import { eq, and, SQL } from "drizzle-orm";
import type { CurrentUserContext } from "../auth/backend-claims";
import type { DataScope } from "./authorize";

export interface ScopeTarget {
  ownerIdColumn: SQL;
  teamIdColumn?: SQL;
  orgIdColumn: SQL;
}

export function buildScopeWhere(
  scope: DataScope,
  ctx: CurrentUserContext,
  target: ScopeTarget,
): SQL | undefined {
  if (scope === "all") return undefined;
  if (scope === "own") {
    return eq(target.ownerIdColumn, ctx.userId);
  }
  if (scope === "team" && target.teamIdColumn) {
    return eq(target.ownerIdColumn, ctx.userId);
  }
  return eq(target.ownerIdColumn, ctx.userId);
}
