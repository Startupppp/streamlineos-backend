import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import { expenses, finReimbursementBatches, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { AuditService } from "../../common/audit/audit.service";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import { FinancePostingService } from "../accounting/finance-posting.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { CreateBatchInput, PayBatchInput, BatchListInput } from "./dto/finance-expenses.schemas";

@Injectable()
export class ReimbursementsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
    private readonly dispatch: NotificationDispatchService,
    private readonly posting: FinancePostingService,
  ) {}

  async listBatches(orgId: string, filters: BatchListInput) {
    const page = filters.page;
    const pageSize = filters.pageSize;
    const offset = (page - 1) * pageSize;

    const rows = await this.db.query.finReimbursementBatches.findMany({
      where: (batch, { and: a, eq: e }) => {
        const conds = [e(batch.orgId, orgId)];
        if (filters.status) conds.push(e(batch.status, filters.status));
        return a(...conds);
      },
      with: { creator: true, approver: true },
      orderBy: (batch, { desc }) => [desc(batch.createdAt)],
      limit: pageSize,
      offset,
    });

    const [countResult] = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(finReimbursementBatches)
      .where(
        and(
          eq(finReimbursementBatches.orgId, orgId),
          ...(filters.status ? [eq(finReimbursementBatches.status, filters.status)] : []),
        ),
      );

    const total = Number(countResult?.count ?? 0);

    return {
      data: rows,
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  async createBatch(u: CurrentUserContext, input: CreateBatchInput) {
    const pendingExpenses = await this.db
      .select({ id: expenses.id, amount: expenses.amount, userId: expenses.userId })
      .from(expenses)
      .where(
        and(
          eq(expenses.orgId, u.orgId),
          eq(expenses.status, "REIMBURSEMENT_PENDING"),
          inArray(expenses.id, input.expenseIds),
        ),
      );

    if (pendingExpenses.length !== input.expenseIds.length) {
      const foundIds = new Set(pendingExpenses.map((e) => e.id));
      const missing = input.expenseIds.filter((id) => !foundIds.has(id));
      throw new BadRequestException(
        `Expenses ${missing.join(", ")} are not in REIMBURSEMENT_PENDING status or not found in this org`,
      );
    }

    const totalAmount = pendingExpenses
      .reduce((sum, e) => sum + parseFloat(e.amount), 0)
      .toFixed(4);

    const [batch] = await this.db
      .insert(finReimbursementBatches)
      .values({
        orgId: u.orgId,
        name: input.name,
        status: "DRAFT",
        totalAmount,
        createdBy: u.userId,
      })
      .returning();

    if (!batch) throw new BadRequestException("Failed to create reimbursement batch");

    await this.db
      .update(expenses)
      .set({ reimbursementBatchId: batch.id, updatedAt: new Date() })
      .where(inArray(expenses.id, input.expenseIds));

    this.audit.log({
      action: "fin.reimbursement_batch.created",
      userId: u.userId,
      orgId: u.orgId,
      targetId: String(batch.id),
      targetType: "fin_reimbursement_batch",
      metadata: { name: input.name, expenseCount: input.expenseIds.length, totalAmount },
    });

    await this.cache.invalidatePattern(`fin:reimbursement-batches:${u.orgId}:*`);

    return batch;
  }

  async getBatch(orgId: string, batchId: number) {
    const batch = await this.db.query.finReimbursementBatches.findFirst({
      where: and(eq(finReimbursementBatches.id, batchId), eq(finReimbursementBatches.orgId, orgId)),
      with: { creator: true, approver: true },
    });

    if (!batch) throw new NotFoundException("Reimbursement batch not found");

    const items = await this.db
      .select({
        id: expenses.id,
        amount: expenses.amount,
        category: expenses.category,
        expenseDate: expenses.expenseDate,
        description: expenses.description,
        status: expenses.status,
        userId: expenses.userId,
        userName: users.name,
        userEmail: users.email,
      })
      .from(expenses)
      .leftJoin(users, eq(expenses.userId, users.id))
      .where(and(eq(expenses.orgId, orgId), eq(expenses.reimbursementBatchId, batchId)));

    return { batch, items };
  }

  async approveBatch(u: CurrentUserContext, batchId: number) {
    const batch = await this.db.query.finReimbursementBatches.findFirst({
      where: and(eq(finReimbursementBatches.id, batchId), eq(finReimbursementBatches.orgId, u.orgId)),
      columns: { id: true, status: true },
    });

    if (!batch) throw new NotFoundException("Reimbursement batch not found");
    if (batch.status !== "DRAFT") {
      throw new BadRequestException(`Batch is already ${batch.status}`);
    }

    await this.db
      .update(finReimbursementBatches)
      .set({ status: "APPROVED", approvedBy: u.userId, approvedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(finReimbursementBatches.id, batchId), eq(finReimbursementBatches.orgId, u.orgId)));

    this.audit.log({
      action: "fin.reimbursement_batch.approved",
      userId: u.userId,
      orgId: u.orgId,
      targetId: String(batchId),
      targetType: "fin_reimbursement_batch",
    });

    await this.cache.invalidatePattern(`fin:reimbursement-batches:${u.orgId}:*`);

    return { success: true };
  }

  async payBatch(u: CurrentUserContext, batchId: number, input: PayBatchInput) {
    const batch = await this.db.query.finReimbursementBatches.findFirst({
      where: and(eq(finReimbursementBatches.id, batchId), eq(finReimbursementBatches.orgId, u.orgId)),
    });

    if (!batch) throw new NotFoundException("Reimbursement batch not found");
    if (batch.status === "PAID") {
      return { success: true, replayed: true };
    }
    if (batch.status !== "APPROVED") {
      throw new BadRequestException("Batch must be in APPROVED status before paying");
    }

    const batchExpenses = await this.db
      .select({ id: expenses.id, userId: expenses.userId, amount: expenses.amount, category: expenses.category })
      .from(expenses)
      .where(and(eq(expenses.orgId, u.orgId), eq(expenses.reimbursementBatchId, batchId)));

    const totalStr = parseFloat(batch.totalAmount).toFixed(2);

    const postResult = await this.posting.postJournal(u, {
      entryDate: input.paidDate,
      description: `Reimbursement batch paid: ${batch.name}`,
      sourceType: "REIMBURSEMENT_BATCH",
      sourceId: String(batchId),
      sourceEvent: "paid",
      lines: [
        {
          systemPurpose: "REIMBURSEMENT_PAYABLE",
          debit: totalStr,
          description: "Clear reimbursement payable",
        },
        {
          systemPurpose: "BANK_CLEARING",
          credit: totalStr,
          description: `Batch payment: ${batch.name}`,
        },
      ],
    });

    await this.db.transaction(async (tx) => {
      await tx
        .update(finReimbursementBatches)
        .set({
          status: "PAID",
          paidDate: input.paidDate,
          journalEntryId: postResult.entryId,
          updatedAt: new Date(),
        })
        .where(eq(finReimbursementBatches.id, batchId));

      await tx
        .update(expenses)
        .set({ status: "REIMBURSED", paidAt: new Date(), updatedAt: new Date() })
        .where(and(eq(expenses.orgId, u.orgId), eq(expenses.reimbursementBatchId, batchId)));
    });

    this.audit.log({
      action: "fin.reimbursement_batch.paid",
      userId: u.userId,
      orgId: u.orgId,
      targetId: String(batchId),
      targetType: "fin_reimbursement_batch",
      metadata: { journalEntryId: postResult.entryId, paidDate: input.paidDate, totalAmount: totalStr },
    });

    const uniqueEmployeeIds = [...new Set(batchExpenses.map((e) => e.userId))];
    for (const employeeId of uniqueEmployeeIds) {
      const employeeExpenses = batchExpenses.filter((e) => e.userId === employeeId);
      const employeeTotal = employeeExpenses.reduce((s, e) => s + parseFloat(e.amount), 0).toFixed(2);

      void this.dispatch.emit({
        eventKey: "accounting.reimbursement.paid",
        orgId: u.orgId,
        actorUserId: u.userId,
        targetUserIds: [employeeId],
        entityType: "fin_reimbursement_batch",
        entityId: String(batchId),
        variables: { batchName: batch.name, totalAmount: employeeTotal, paidDate: input.paidDate },
      });
    }

    await this.cache.invalidatePattern(`fin:reimbursement-batches:${u.orgId}:*`);
    await this.cache.invalidatePattern(`hr:expenses:${u.orgId}:*`);

    return { success: true, replayed: postResult.replayed, entryId: postResult.entryId };
  }
}
