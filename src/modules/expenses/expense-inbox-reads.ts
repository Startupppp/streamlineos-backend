import { and, count, desc, eq } from "drizzle-orm";
import { expenses, users } from "../../db/schema";
import {
  descKeyset,
  type DescKeysetPosition,
} from "../../common/pagination/desc-keyset";
import type { Db } from "../../db/drizzle.module";

export type ExpenseInboxRow = {
  id: number;
  amount: string;
  currency: string;
  category: string;
  expenseDate: string;
  createdAt: Date;
  userId: string | null;
  userName: string | null;
  userFirstName: string | null;
  userLastName: string | null;
  userImage: string | null;
};

function routedToApprover(orgId: string, approverMembershipId: number) {
  return and(
    eq(expenses.orgId, orgId),
    eq(expenses.status, "PENDING"),
    eq(expenses.approverMembershipId, approverMembershipId),
  );
}

export async function pendingExpensesRoutedToPage(
  db: Db,
  orgId: string,
  approverMembershipId: number,
  limit: number,
  cursor: DescKeysetPosition | null,
): Promise<ExpenseInboxRow[]> {
  return db
    .select({
      id: expenses.id,
      amount: expenses.amount,
      currency: expenses.currency,
      category: expenses.category,
      expenseDate: expenses.expenseDate,
      createdAt: expenses.createdAt,
      userId: users.id,
      userName: users.name,
      userFirstName: users.firstName,
      userLastName: users.lastName,
      userImage: users.image,
    })
    .from(expenses)
    .leftJoin(users, eq(users.id, expenses.userId))
    .where(
      and(
        routedToApprover(orgId, approverMembershipId),
        descKeyset(expenses.createdAt, expenses.id, cursor),
      ),
    )
    .orderBy(desc(expenses.createdAt), desc(expenses.id))
    .limit(limit);
}

export async function countPendingExpensesRoutedTo(
  db: Db,
  orgId: string,
  approverMembershipId: number,
): Promise<number> {
  const [row] = await db
    .select({ cnt: count(expenses.id) })
    .from(expenses)
    .where(routedToApprover(orgId, approverMembershipId));
  return Number(row?.cnt ?? 0);
}
