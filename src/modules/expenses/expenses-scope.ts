import { eq, inArray, or, type SQL } from "drizzle-orm";
import { expenses } from "../../db/schema";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { DataScope } from "../access/access.types";
import { AccessService } from "../access/access.service";
import { EmploymentFactsService } from "../directory/employment-facts.service";

export const EXPENSES_APPROVE_PERMISSION = "hr:expenses:approve";

export interface ExpenseReadScope {
  scope: DataScope;
  teamUserIds: readonly string[];
}

export const SELF_ONLY_SCOPE: ExpenseReadScope = { scope: "own", teamUserIds: [] };

export async function resolveExpenseReadScope(
  access: AccessService,
  employment: EmploymentFactsService,
  u: CurrentUserContext,
): Promise<ExpenseReadScope> {
  if (u.isOrgOwner) return { scope: "all", teamUserIds: [] };

  const perms = await access.resolveUserPermissions(u.orgId, u.userId);
  const scope = perms.get(EXPENSES_APPROVE_PERMISSION);
  if (scope === "all") return { scope: "all", teamUserIds: [] };
  if (scope !== "team") return SELF_ONLY_SCOPE;

  const teamUserIds = await employment.getDirectReportUserIds(u.orgId, u.userId);
  return { scope: "team", teamUserIds };
}

export function expenseOwnerPredicate(
  read: ExpenseReadScope,
  userId: string,
  requestedUserId?: string,
): SQL | undefined {
  if (read.scope === "all")
    return requestedUserId ? eq(expenses.userId, requestedUserId) : undefined;

  const visible = new Set<string>([userId, ...read.teamUserIds]);
  if (requestedUserId) {
    return visible.has(requestedUserId)
      ? eq(expenses.userId, requestedUserId)
      : eq(expenses.userId, userId);
  }
  if (visible.size === 1) return eq(expenses.userId, userId);
  return or(eq(expenses.userId, userId), inArray(expenses.userId, [...visible]));
}

export function canReadOthersExpenses(read: ExpenseReadScope): boolean {
  return read.scope === "all" || read.teamUserIds.length > 0;
}
