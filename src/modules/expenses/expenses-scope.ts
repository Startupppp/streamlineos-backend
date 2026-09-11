import { eq, inArray, or, type SQL } from "drizzle-orm";
import { expenses } from "../../db/schema";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ScopedRead } from "../access/scoped-read";
import { AccessService } from "../access/access.service";
import { EmploymentFactsService } from "../directory/employment-facts.service";

export const EXPENSES_APPROVE_PERMISSION = "hr:expenses:approve";

export interface ExpenseRead {
  read: ScopedRead;
  isAll: boolean;
  teamUserIds: readonly string[];
}

export function selfOnlyRead(orgId: string, userId: string): ExpenseRead {
  return { read: ScopedRead.of(orgId, userId, "own"), isAll: false, teamUserIds: [] };
}

export async function resolveExpenseReadScope(
  access: AccessService,
  employment: EmploymentFactsService,
  u: CurrentUserContext,
): Promise<ExpenseRead> {
  if (u.isOrgOwner) return { read: ScopedRead.of(u.orgId, u.userId, "all"), isAll: true, teamUserIds: [] };

  const perms = await access.resolveUserPermissions(u.orgId, u.userId);
  const scope = perms.get(EXPENSES_APPROVE_PERMISSION);
  if (scope === "all") return { read: ScopedRead.of(u.orgId, u.userId, "all"), isAll: true, teamUserIds: [] };
  if (scope !== "team") return selfOnlyRead(u.orgId, u.userId);

  const teamUserIds = await employment.getDirectReportUserIds(u.orgId, u.userId);
  return { read: ScopedRead.of(u.orgId, u.userId, "team"), isAll: false, teamUserIds };
}

export function expenseOwnerPredicate(
  er: ExpenseRead,
  requestedUserId?: string,
): SQL | undefined {
  const actorId = er.read.actorId;

  if (requestedUserId) {
    if (er.isAll) return eq(expenses.userId, requestedUserId);
    const visible = new Set<string>([actorId, ...er.teamUserIds]);
    return visible.has(requestedUserId)
      ? eq(expenses.userId, requestedUserId)
      : eq(expenses.userId, actorId);
  }

  if (er.isAll) return undefined;
  const visible = new Set<string>([actorId, ...er.teamUserIds]);
  if (visible.size === 1) return eq(expenses.userId, actorId);
  return or(eq(expenses.userId, actorId), inArray(expenses.userId, [...visible]));
}

export function canReadOthersExpenses(er: ExpenseRead): boolean {
  return er.isAll || er.teamUserIds.length > 0;
}
