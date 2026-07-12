import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, count, eq, isNotNull } from "drizzle-orm";
import { expenses, expenseCategories } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { AuditService } from "../../common/audit/audit.service";
import { paginateOffset, buildListResponse } from "../../common/pagination/pagination";
import type { ReceiptListInput, PatchReceiptInput } from "./dto/finance-expenses.schemas";

@Injectable()
export class ReceiptsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
  ) {}

  async listReceiptInbox(orgId: string, filters: ReceiptListInput) {
    const { limit, offset } = paginateOffset(filters);

    const where = and(
      eq(expenses.orgId, orgId),
      eq(expenses.status, "SUBMITTED"),
      isNotNull(expenses.policyFlag),
    );

    const [rows, [countResult]] = await Promise.all([
      this.db.query.expenses.findMany({
        where,
        with: { user: true, expenseCategory: true },
        orderBy: (exp, { desc }) => [desc(exp.createdAt)],
        limit,
        offset,
      }),
      this.db.select({ total: count() }).from(expenses).where(where),
    ]);

    return buildListResponse(rows, Number(countResult?.total ?? 0), filters);
  }

  async patchReceiptMetadata(
    orgId: string,
    actorUserId: string,
    expenseId: number,
    input: PatchReceiptInput,
  ) {
    const expense = await this.db.query.expenses.findFirst({
      where: and(eq(expenses.id, expenseId), eq(expenses.orgId, orgId)),
      columns: { id: true, status: true },
    });

    if (!expense) throw new NotFoundException("Expense not found");

    if (expense.status !== "SUBMITTED") {
      throw new BadRequestException("Only SUBMITTED expenses can have receipt metadata corrected");
    }

    if (input.categoryId) {
      const cat = await this.db.query.expenseCategories.findFirst({
        where: and(eq(expenseCategories.id, input.categoryId), eq(expenseCategories.orgId, orgId)),
        columns: { id: true, name: true },
      });
      if (!cat) throw new BadRequestException("Category not found in this org");
    }

    await this.db
      .update(expenses)
      .set({
        ...(input.merchant !== undefined && { merchant: input.merchant }),
        ...(input.receiptNumber !== undefined && { receiptNumber: input.receiptNumber }),
        ...(input.taxAmount !== undefined && { taxAmount: input.taxAmount.toFixed(2) }),
        ...(input.categoryId !== undefined && { categoryId: input.categoryId }),
        updatedAt: new Date(),
      })
      .where(and(eq(expenses.id, expenseId), eq(expenses.orgId, orgId)));

    this.audit.log({
      action: "expense.receipt_metadata_patched",
      userId: actorUserId,
      orgId,
      targetId: String(expenseId),
      targetType: "expense",
      metadata: input,
    });

    await this.cache.invalidatePattern(`hr:expenses:${orgId}:*`);

    return { success: true };
  }
}
