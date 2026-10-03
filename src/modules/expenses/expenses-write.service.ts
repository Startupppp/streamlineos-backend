import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { expenses } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import { AuditService } from "../../common/audit/audit.service";
import { findExpensePayrollRunId } from "../payroll/runs/lib/payable-expenses";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import {
  assertOrganizationActor,
  OrganizationActorError,
  organizationActorHttpError,
} from "../../common/organization/organization-actor";
import { emitExpenseOutboxEvent } from "./expense-outbox-emitter";
import {
  EXPENSE_DECIDED_EVENT,
  EXPENSE_SUBMITTED_EVENT,
  expenseDecidedPayloadSchema,
  expenseSubmittedPayloadSchema,
} from "./dto/expense-outbox.schemas";
import {
  updateExpenseDetailsSchema,
  updateExpenseStatusSchema,
  type CreateExpenseInput,
  type UpdateExpenseDetailsInput,
} from "./dto/expense.schemas";

const statusProbeSchema = z.object({ status: z.string().min(1) });

function formatDateOnly(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

@Injectable()
export class ExpensesWriteService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
  ) {}

  async create(orgId: string, userId: string, body: CreateExpenseInput) {
    const expense = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(expenses)
        .values({
          orgId,
          userId,
          category: body.category,
          categoryId: body.categoryId,
          amount: body.amount.toString(),
          description: body.description,
          receiptUrl: body.receiptUrl,
          receiptFileName: body.receiptFileName,
          merchant: body.merchant,
          paymentMethod: body.paymentMethod,
          projectId: body.projectId,
          expenseDate: formatDateOnly(body.expenseDate),
          status: "PENDING",
          approverId: null,
          approvedAt: null,
        })
        .returning();

      if (!row) {
        throw new InternalServerErrorException("Failed to create expense.");
      }

      await emitExpenseOutboxEvent(tx, {
        orgId,
        expenseId: row.id,
        eventType: EXPENSE_SUBMITTED_EVENT,
        payload: expenseSubmittedPayloadSchema.parse({
          expenseId: row.id,
          orgId,
          actorUserId: userId,
          amount: body.amount.toString(),
          category: body.category,
          description: body.description ?? null,
          recipients: { mode: "EXPENSE_APPROVERS" },
          runAutomations: true,
        }),
      });

      return row;
    });

    this.audit.log({
      action: "expense.created",
      userId,
      orgId,
      targetId: String(expense.id),
      targetType: "expense",
      metadata: { category: body.category, amount: body.amount },
    });

    await this.cache.invalidateNamespace(CACHE_KEYS.expensesListNamespace(orgId));

    return expense;
  }

  async update(u: CurrentUserContext, isAdmin: boolean, expenseId: number, rawBody: unknown) {
    if (!isAdmin) {
      throw new ForbiddenException("Only admins can update expense status.");
    }

    if (!statusProbeSchema.safeParse(rawBody).success) {
      return this.updateDetails(u.orgId, expenseId, rawBody);
    }

    return this.updateStatus(u, expenseId, rawBody);
  }

  async updateOwn(
    orgId: string,
    userId: string,
    expenseId: number,
    body: UpdateExpenseDetailsInput,
  ) {
    const [updated] = await this.db
      .update(expenses)
      .set({
        ...(body.category && { category: body.category }),
        ...(body.amount !== undefined && { amount: body.amount.toString() }),
        ...(body.description !== undefined && { description: body.description }),
        ...(body.merchant !== undefined && { merchant: body.merchant }),
        ...(body.paymentMethod !== undefined && {
          paymentMethod: body.paymentMethod,
        }),
        ...(body.expenseDate && { expenseDate: body.expenseDate }),
        ...(body.receiptUrl !== undefined && { receiptUrl: body.receiptUrl }),
        ...(body.receiptFileName !== undefined && {
          receiptFileName: body.receiptFileName,
        }),
        status: sql`CASE WHEN ${expenses.status} = 'REJECTED' THEN 'PENDING' ELSE ${expenses.status} END`,
        rejectionReason: sql`CASE WHEN ${expenses.status} = 'REJECTED' THEN NULL ELSE ${expenses.rejectionReason} END`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(expenses.id, expenseId),
          eq(expenses.orgId, orgId),
          eq(expenses.userId, userId),
          inArray(expenses.status, ["DRAFT", "PENDING", "REJECTED"]),
        ),
      )
      .returning({ id: expenses.id });

    if (!updated) {
      throw new NotFoundException(
        "Expense not found or it can no longer be edited.",
      );
    }

    this.audit.log({
      action: "expense.updated",
      userId,
      orgId,
      targetId: String(expenseId),
      targetType: "expense",
    });

    await this.cache.invalidateNamespace(CACHE_KEYS.expensesListNamespace(orgId));
    return { success: true };
  }

  private async updateDetails(orgId: string, expenseId: number, rawBody: unknown) {
    const parsed = updateExpenseDetailsSchema.safeParse(rawBody);
    if (!parsed.success) throw new BadRequestException("Invalid update data.");

    const expense = await this.db.query.expenses.findFirst({
      where: and(eq(expenses.id, expenseId), eq(expenses.orgId, orgId)),
      columns: { id: true },
    });
    if (!expense) throw new NotFoundException("Expense not found.");
    if ((await findExpensePayrollRunId(this.db, orgId, expenseId)) !== null) {
      throw new ConflictException("This expense is being paid through a payroll run and cannot be edited.");
    }

    const d = parsed.data;
    await this.db
      .update(expenses)
      .set({
        ...(d.category && { category: d.category }),
        ...(d.amount !== undefined && { amount: d.amount.toString() }),
        ...(d.description !== undefined && { description: d.description }),
        ...(d.merchant !== undefined && { merchant: d.merchant }),
        ...(d.paymentMethod !== undefined && { paymentMethod: d.paymentMethod }),
        ...(d.expenseDate && { expenseDate: d.expenseDate }),
        ...(d.receiptUrl !== undefined && { receiptUrl: d.receiptUrl }),
        ...(d.receiptFileName !== undefined && { receiptFileName: d.receiptFileName }),
        updatedAt: new Date(),
      })
      .where(and(eq(expenses.id, expenseId), eq(expenses.orgId, orgId)));

    await this.cache.invalidateNamespace(CACHE_KEYS.expensesListNamespace(orgId));
    return { success: true };
  }

  private async updateStatus(u: CurrentUserContext, expenseId: number, rawBody: unknown) {
    const parsed = updateExpenseStatusSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new BadRequestException("status must be APPROVED, REJECTED, or PAID.");
    }
    const body = parsed.data;

    const statusActor = await assertOrganizationActor(this.db, u.orgId, { kind: "user", userId: u.userId }).catch((e: unknown) => {
      if (e instanceof OrganizationActorError) throw organizationActorHttpError(e);
      throw e;
    });

    await this.db.transaction(async (tx) => {
      const [expense] = await tx
        .select()
        .from(expenses)
        .where(and(eq(expenses.id, expenseId), eq(expenses.orgId, u.orgId)))
        .for("update");

      if (!expense) throw new NotFoundException("Expense not found.");
      if (expense.userId === u.userId) {
        throw new ForbiddenException("You cannot decide on your own expense.");
      }
      const approvableStatuses: string[] = ["PENDING", "SUBMITTED"];
      if (!approvableStatuses.includes(expense.status ?? "")) {
        throw new BadRequestException("Expense has already been processed.");
      }

      const [updated] = await tx
        .update(expenses)
        .set({
          status: body.status,
          approverId: u.userId,
          approverMembershipId: statusActor.membershipId,
          approvedAt: body.status === "APPROVED" || body.status === "PAID" ? new Date() : null,
          rejectionReason: body.rejectionReason ?? null,
          updatedAt: new Date(),
        })
        .where(and(eq(expenses.id, expenseId), eq(expenses.orgId, u.orgId)))
        .returning({ id: expenses.id });

      if (!updated) {
        throw new InternalServerErrorException("Expense was concurrently modified.");
      }

      if (!expense.userId) return;

      await emitExpenseOutboxEvent(tx, {
        orgId: u.orgId,
        expenseId,
        eventType: EXPENSE_DECIDED_EVENT,
        payload: expenseDecidedPayloadSchema.parse({
          expenseId,
          orgId: u.orgId,
          actorUserId: u.userId,
          recipientUserId: expense.userId,
          status: body.status,
          amount: expense.amount,
          category: expense.category,
          rejectionReason: body.rejectionReason ?? null,
          journalEntryId: null,
        }),
      });
    });

    const auditAction =
      body.status === "APPROVED"
        ? "expense.approved"
        : body.status === "PAID"
          ? "expense.paid"
          : "expense.rejected";
    this.audit.log({
      action: auditAction,
      userId: u.userId,
      orgId: u.orgId,
      targetId: String(expenseId),
      targetType: "expense",
      metadata: { status: body.status, rejectionReason: body.rejectionReason },
    });

    await this.cache.invalidateNamespace(CACHE_KEYS.expensesListNamespace(u.orgId));
    return { success: true };
  }
}
