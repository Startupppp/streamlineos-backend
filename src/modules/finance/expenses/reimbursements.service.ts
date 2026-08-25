import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, count, eq, inArray } from "drizzle-orm";
import { expenses, finReimbursementBatches, users } from "../../../db/schema";
import { finBankAccounts } from "../../../db/schema/accounting/finance-banking";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { AuditService } from "../../../common/audit/audit.service";
import { addDecimals, formatDecimal } from "../../accounting/core/money.util";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { FinancePostingService } from "../../accounting/posting/finance-posting.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { CreateBatchInput, PayBatchInput, BatchListInput } from "./dto/finance-expenses.schemas";

// Global users contains authentication secrets and legacy payroll fields. Never
// hydrate the full relation into an API response.
const REIMBURSEMENT_ACTOR_COLUMNS = {
  id: true,
  name: true,
  firstName: true,
  lastName: true,
  email: true,
  image: true,
} as const;

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

    const conditions = [eq(finReimbursementBatches.orgId, orgId)];
    if (filters.status) {
      conditions.push(eq(finReimbursementBatches.status, filters.status));
    }
    const where = and(...conditions);

    const [rows, [countResult]] = await Promise.all([
      this.db.query.finReimbursementBatches.findMany({
        where,
        with: {
          creator: { columns: REIMBURSEMENT_ACTOR_COLUMNS },
          approver: { columns: REIMBURSEMENT_ACTOR_COLUMNS },
        },
        orderBy: (batch, { desc }) => [desc(batch.createdAt)],
        limit: pageSize,
        offset,
      }),
      this.db.select({ total: count() }).from(finReimbursementBatches).where(where),
    ]);

    const total = Number(countResult?.total ?? 0);

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

    const totalAmount = formatDecimal(
      pendingExpenses.reduce((sum, e) => addDecimals(sum, e.amount), "0"),
      4,
    );

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
      .where(and(inArray(expenses.id, input.expenseIds), eq(expenses.orgId, u.orgId)));

    this.audit.log({
      action: "fin.reimbursement_batch.created",
      userId: u.userId,
      orgId: u.orgId,
      targetId: String(batch.id),
      targetType: "fin_reimbursement_batch",
      metadata: { name: input.name, expenseCount: input.expenseIds.length, totalAmount },
    });


    return batch;
  }

  async getBatch(orgId: string, batchId: number) {
    const batch = await this.db.query.finReimbursementBatches.findFirst({
      where: and(eq(finReimbursementBatches.id, batchId), eq(finReimbursementBatches.orgId, orgId)),
      with: {
        creator: { columns: REIMBURSEMENT_ACTOR_COLUMNS },
        approver: { columns: REIMBURSEMENT_ACTOR_COLUMNS },
      },
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

    const totalStr = formatDecimal(batch.totalAmount, 2);

    let bankLedgerAccountId: number | undefined;
    if (input.bankAccountId !== undefined) {
      const [bankAcct] = await this.db
        .select({ id: finBankAccounts.id, ledgerAccountId: finBankAccounts.ledgerAccountId })
        .from(finBankAccounts)
        .where(and(eq(finBankAccounts.id, input.bankAccountId), eq(finBankAccounts.orgId, u.orgId)))
        .limit(1);
      if (!bankAcct) throw new BadRequestException("Bank account not found");
      if (!bankAcct.ledgerAccountId) throw new BadRequestException("Bank account has no linked ledger account");
      bankLedgerAccountId = bankAcct.ledgerAccountId;
    }

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
        bankLedgerAccountId !== undefined
          ? {
              accountId: bankLedgerAccountId,
              credit: totalStr,
              description: `Batch payment: ${batch.name}`,
            }
          : {
              systemPurpose: "BANK_CLEARING" as const,
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
          bankAccountId: input.bankAccountId ?? null,
          updatedAt: new Date(),
        })
        .where(and(eq(finReimbursementBatches.id, batchId), eq(finReimbursementBatches.orgId, u.orgId)));

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
      const employeeTotal = formatDecimal(employeeExpenses.reduce((s, e) => addDecimals(s, e.amount), "0"), 2);

      await this.dispatch.emit({
        eventKey: "accounting.reimbursement.paid",
        orgId: u.orgId,
        actorUserId: u.userId,
        targetUserIds: [employeeId],
        entityType: "fin_reimbursement_batch",
        entityId: String(batchId),
        variables: { batchName: batch.name, totalAmount: employeeTotal, paidDate: input.paidDate },
      });
    }

    await this.cache.invalidateNamespace(CACHE_KEYS.expensesListNamespace(u.orgId));

    return { success: true, replayed: postResult.replayed, entryId: postResult.entryId };
  }
}
