import { SQL, eq, inArray } from "drizzle-orm";
import { users } from "../../db/schema";
import type { AnyColumn } from "drizzle-orm";
import type { Db } from "../../db/drizzle.module";

const BRANCH_SCOPED_ROLES = new Set(["BRANCH_MANAGER", "BRANCH_HR"]);

const ORG_WIDE_ROLES = new Set(["CEO", "HR", "ADMIN"]);

export interface BranchContext {
  role: string;
  branchId: number | null;
  userId: string;
}

export function isBranchScoped(ctx: BranchContext): boolean {
  return BRANCH_SCOPED_ROLES.has(ctx.role) && ctx.branchId !== null;
}

export function isOrgWide(ctx: BranchContext): boolean {
  return ORG_WIDE_ROLES.has(ctx.role);
}

export function branchIdFilter(
  branchIdCol: AnyColumn,
  ctx: BranchContext
): SQL | undefined {
  if (!isBranchScoped(ctx) || ctx.branchId === null) return undefined;
  return eq(branchIdCol, ctx.branchId) as SQL;
}

export async function getBranchUserIds(
  db: Db,
  ctx: BranchContext
): Promise<string[] | null> {
  if (!isBranchScoped(ctx) || ctx.branchId === null) return null;
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.branchId, ctx.branchId));
  return rows.map((r) => r.id);
}

export async function pushBranchAssigneeFilter(
  db: Db,
  where: SQL[],
  assigneeIdCol: AnyColumn,
  ctx: BranchContext
): Promise<void> {
  const userIds = await getBranchUserIds(db, ctx);
  if (userIds === null) return;

  const safeIds = userIds.length > 0 ? userIds : ["__no_match__"];
  where.push(inArray(assigneeIdCol, safeIds) as SQL);
}
