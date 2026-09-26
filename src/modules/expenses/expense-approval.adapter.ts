import { Inject, Injectable, OnModuleInit } from "@nestjs/common";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { ApprovalAdapterRegistry } from "../attention/approval-adapter.registry";
import { pendingExpensesRoutedToPage } from "./expense-inbox-reads";
import type {
  BuildApprovalInboxItem,
  InboxSourcePosition,
} from "../notifications/dto/unified-inbox.schemas";

export const EXPENSE_APPROVAL_DEEP_LINK = "/hr/expenses";
export const EXPENSE_CLAIM_OBJECT_TYPE = "expense_claim";

function claimantName(
  name: string | null,
  first: string | null,
  last: string | null,
): string | null {
  if (name) return name;
  const parts = [first, last].filter((p): p is string => Boolean(p));
  return parts.length > 0 ? parts.join(" ") : null;
}

@Injectable()
export class ExpenseApprovalAdapter implements OnModuleInit {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly registry: ApprovalAdapterRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      module: "expenses",
      kindLabel: "expense",
      permission: "hr:expenses:approve",
      supportsAfterCursor: true,
      fetch: (orgId, _userId, membershipId, limit, cursor) =>
        this.fetchExpenses(orgId, membershipId, limit, cursor),
    });
  }

  private async fetchExpenses(
    orgId: string,
    membershipId: number | null,
    limit: number,
    cursor: InboxSourcePosition | null,
  ): Promise<BuildApprovalInboxItem[]> {
    if (membershipId === null) return [];
    const rows = await pendingExpensesRoutedToPage(
      this.db,
      orgId,
      membershipId,
      limit,
      cursor,
    );
    return rows.map(
      (row): BuildApprovalInboxItem => ({
        kind: "build_approval",
        id: row.id,
        approvalKind: "expense",
        status: "pending",
        projectId: null,
        ticketId: null,
        dueAt: null,
        objectType: EXPENSE_CLAIM_OBJECT_TYPE,
        objectId: String(row.id),
        dedupKey: `approval:expense:${String(row.id)}`,
        sourceModule: "expenses",
        subject: `${row.category} · ${row.currency} ${row.amount}`,
        timestamp: row.createdAt.toISOString(),
        isRead: false,
        deepLink: EXPENSE_APPROVAL_DEEP_LINK,
        actor: row.userId
          ? {
              id: row.userId,
              name: claimantName(
                row.userName,
                row.userFirstName,
                row.userLastName,
              ),
              image: row.userImage ?? null,
            }
          : null,
      }),
    );
  }
}
