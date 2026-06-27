import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, gte, inArray, like, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { expenses, organizationMembers, organizations, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { AuditService } from "../../common/audit/audit.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { EmailService } from "../email/email.service";
import { AutomationService } from "../automation/automation.service";
import {
  updateExpenseDetailsSchema,
  updateExpenseStatusSchema,
  type CreateExpenseInput,
  type EmailReportFilters,
  type EmailReportInput,
  type ExpenseStatus,
} from "./dto/expense.schemas";

const statusProbeSchema = z.object({ status: z.string().min(1) });

const EXPENSE_STATUS_VALUES: readonly ExpenseStatus[] = ["PENDING", "APPROVED", "REJECTED", "PAID"];

function isExpenseStatus(value: string): value is ExpenseStatus {
  return (EXPENSE_STATUS_VALUES as readonly string[]).includes(value);
}

function formatReportAmount(value: number | string): string {
  const num = Number(value);
  if (Number.isNaN(num)) return "0.00";
  return new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(num);
}

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
    private readonly email: EmailService,
    private readonly automation: AutomationService,
  ) {}

  async create(orgId: string, userId: string, isAdmin: boolean, body: CreateExpenseInput) {
    const [expense] = await this.db
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
        status: isAdmin ? "APPROVED" : "PENDING",
        approverId: isAdmin ? userId : null,
        approvedAt: isAdmin ? new Date() : null,
      })
      .returning();

    if (!expense) {
      throw new InternalServerErrorException("Failed to create expense.");
    }

    this.audit.log({
      action: "expense.created",
      userId,
      orgId,
      targetId: String(expense.id),
      targetType: "expense",
      metadata: { category: body.category, amount: body.amount },
    });

    if (!isAdmin) {
      void this.dispatchExpenseSubmitted(orgId, userId, expense.id, body);
    }

    await this.cache.invalidatePattern(`hr:expenses:${orgId}:*`);

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

  private async updateDetails(orgId: string, expenseId: number, rawBody: unknown) {
    const parsed = updateExpenseDetailsSchema.safeParse(rawBody);
    if (!parsed.success) throw new BadRequestException("Invalid update data.");

    const expense = await this.db.query.expenses.findFirst({
      where: and(eq(expenses.id, expenseId), eq(expenses.orgId, orgId)),
      columns: { id: true },
    });
    if (!expense) throw new NotFoundException("Expense not found.");

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

    await this.cache.invalidatePattern(`hr:expenses:${orgId}:*`);
    return { success: true };
  }

  private async updateStatus(u: CurrentUserContext, expenseId: number, rawBody: unknown) {
    const parsed = updateExpenseStatusSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new BadRequestException("status must be APPROVED, REJECTED, or PAID.");
    }
    const body = parsed.data;

    await this.db.transaction(async (tx) => {
      const [expense] = await tx
        .select()
        .from(expenses)
        .where(and(eq(expenses.id, expenseId), eq(expenses.orgId, u.orgId)))
        .for("update");

      if (!expense) throw new NotFoundException("Expense not found.");
      if (expense.status !== "PENDING") {
        throw new BadRequestException("Expense has already been processed.");
      }

      await tx
        .update(expenses)
        .set({
          status: body.status,
          approverId: u.userId,
          rejectionReason: body.rejectionReason ?? null,
        })
        .where(eq(expenses.id, expenseId));
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

    void this.dispatchExpenseDecision(u, expenseId, body.status, body.rejectionReason ?? null);

    await this.cache.invalidatePattern(`hr:expenses:${u.orgId}:*`);
    return { success: true };
  }

  private buildReportConditions(
    filters: EmailReportFilters,
    orgId: string,
    isAdmin: boolean,
    userId: string,
  ) {
    const conditions = [eq(expenses.orgId, orgId)];

    if (!isAdmin) {
      conditions.push(eq(expenses.userId, userId));
    } else if (filters.userId) {
      conditions.push(eq(expenses.userId, filters.userId));
    }

    if (filters.startDate) conditions.push(gte(expenses.expenseDate, filters.startDate));
    if (filters.endDate) conditions.push(lte(expenses.expenseDate, filters.endDate));
    if (filters.month) {
      const [year, month] = filters.month.split("-");
      const lastDay = new Date(parseInt(year), parseInt(month), 0).getDate();
      conditions.push(gte(expenses.expenseDate, `${year}-${month}-01`));
      conditions.push(lte(expenses.expenseDate, `${year}-${month}-${lastDay.toString().padStart(2, "0")}`));
    }
    if (filters.categoryId) conditions.push(eq(expenses.categoryId, filters.categoryId));
    if (filters.category) conditions.push(eq(expenses.category, filters.category));
    if (filters.status) {
      if (Array.isArray(filters.status)) {
        const valid = filters.status.filter(isExpenseStatus);
        if (valid.length > 0 && !filters.status.includes("all")) {
          conditions.push(inArray(expenses.status, valid));
        }
      } else if (filters.status !== "all" && isExpenseStatus(filters.status)) {
        conditions.push(eq(expenses.status, filters.status));
      }
    }
    if (filters.minAmount !== undefined && filters.minAmount > 0) {
      conditions.push(gte(sql`CAST(${expenses.amount} AS DECIMAL)`, filters.minAmount));
    }
    if (filters.maxAmount !== undefined && filters.maxAmount > 0) {
      conditions.push(lte(sql`CAST(${expenses.amount} AS DECIMAL)`, filters.maxAmount));
    }
    if (filters.paymentMethod && filters.paymentMethod !== "all") {
      conditions.push(eq(expenses.paymentMethod, filters.paymentMethod));
    }
    if (filters.search?.trim()) {
      const term = `%${filters.search.trim().toLowerCase()}%`;
      conditions.push(
        or(
          like(sql`LOWER(${expenses.description})`, term),
          like(sql`LOWER(${expenses.category})`, term),
          like(sql`LOWER(${expenses.merchant})`, term),
        )!,
      );
    }

    return conditions;
  }

  async emailReport(orgId: string, userId: string, isAdmin: boolean, body: EmailReportInput) {
    const conditions = this.buildReportConditions(body.filters, orgId, isAdmin, userId);

    const [expenseList, statsRow] = await Promise.all([
      this.db.query.expenses.findMany({
        where: and(...conditions),
        with: { user: true },
        orderBy: [desc(expenses.expenseDate)],
      }),
      this.db
        .select({
          totalAmount: sql<number>`COALESCE(SUM(CAST(${expenses.amount} AS DECIMAL)), 0)`,
          totalCount: sql<number>`COUNT(*)`,
        })
        .from(expenses)
        .where(and(...conditions)),
    ]);

    if (expenseList.length === 0) {
      throw new BadRequestException("No expenses found for the selected filters");
    }

    const members = await this.db.query.organizationMembers.findMany({
      where: eq(organizationMembers.orgId, orgId),
      with: { user: true },
    });

    const recipientEmails = members
      .filter((m) => {
        if (body.sendTo === "CEO") return m.role === "CEO";
        if (body.sendTo === "HR") return m.role === "HR";
        return m.role === "CEO" || m.role === "HR";
      })
      .map((m) => m.user?.email)
      .filter((email): email is string => !!email);

    if (recipientEmails.length === 0) {
      throw new BadRequestException("No CEO/HR email addresses found");
    }

    const org = await this.db.query.organizations.findFirst({
      where: eq(organizations.id, orgId),
      columns: { name: true },
    });

    const { startDate, endDate } = body.filters;
    const periodLabel =
      startDate && endDate
        ? `${startDate} to ${endDate}`
        : startDate
          ? `From ${startDate}`
          : "All Time";

    const rows = expenseList.map((e) => ({
      date: e.expenseDate,
      employeeName:
        `${e.user?.firstName ?? ""} ${e.user?.lastName ?? ""}`.trim() || "Unknown",
      category: e.category,
      amount: formatReportAmount(e.amount),
      currency: "INR",
      status: e.status ?? "PENDING",
    }));

    const stats = statsRow[0];
    const summary = {
      totalAmount: formatReportAmount(stats?.totalAmount ?? 0),
      totalCount: Number(stats?.totalCount) || 0,
      pendingCount: expenseList.filter((e) => e.status === "PENDING").length,
      approvedCount: expenseList.filter((e) => e.status === "APPROVED").length,
      paidCount: expenseList.filter((e) => e.status === "PAID").length,
      rejectedCount: expenseList.filter((e) => e.status === "REJECTED").length,
    };

    await this.email.sendMonthlyExpenseReportEmail(
      periodLabel,
      org?.name ?? "StreamlineOS",
      rows,
      summary,
      recipientEmails,
    );

    return { success: true };
  }

  private async dispatchExpenseSubmitted(
    orgId: string,
    userId: string,
    expenseId: number,
    body: CreateExpenseInput,
  ): Promise<void> {
    try {
      const actor = await this.db.query.users.findFirst({
        where: eq(users.id, userId),
        columns: { name: true },
      });
      const actorName = actor?.name ?? null;

      await this.automation.runAutomationsForEvent(orgId, "expense.submitted", {
        expenseId,
        userId,
        employeeName: actorName ?? "",
        amount: body.amount.toString(),
        category: body.category,
        submittedAt: new Date().toISOString(),
      });

      const hrMembers = await this.db
        .select({ userId: organizationMembers.userId })
        .from(organizationMembers)
        .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.role, "HR")));
      if (hrMembers.length === 0) return;

      const hrUsers = await this.db
        .select({ email: users.email, name: users.name })
        .from(users)
        .where(
          inArray(
            users.id,
            hrMembers.map((m) => m.userId),
          ),
        );

      await Promise.all(
        hrUsers
          .filter((hr) => hr.email)
          .map((hr) =>
            this.email.sendExpenseSubmittedEmail(
              hr.email,
              hr.name ?? "HR",
              actorName ?? "Employee",
              body.category,
              body.amount.toString(),
              body.description ?? "",
            ),
          ),
      );
    } catch {
      return;
    }
  }

  private async dispatchExpenseDecision(
    u: CurrentUserContext,
    expenseId: number,
    status: "APPROVED" | "REJECTED" | "PAID",
    rejectionReason: string | null,
  ): Promise<void> {
    try {
      const expenseRow = await this.db.query.expenses.findFirst({
        where: eq(expenses.id, expenseId),
        columns: { userId: true, category: true, amount: true },
      });
      if (!expenseRow?.userId) return;

      const [employee, approver] = await Promise.all([
        this.db.query.users.findFirst({
          where: eq(users.id, expenseRow.userId),
          columns: { email: true, name: true },
        }),
        this.db.query.users.findFirst({
          where: eq(users.id, u.userId),
          columns: { name: true },
        }),
      ]);
      if (!employee?.email) return;

      const employeeName = employee.name ?? "Employee";
      const approverName = approver?.name ?? "Admin";
      const { amount, category } = expenseRow;

      if (status === "APPROVED") {
        await this.email.sendExpenseApprovedEmail(
          employee.email,
          employeeName,
          category,
          amount,
          approverName,
        );
      } else if (status === "REJECTED") {
        await this.email.sendExpenseRejectedEmail(
          employee.email,
          employeeName,
          category,
          amount,
          approverName,
          rejectionReason ?? "No reason provided",
        );
      } else if (status === "PAID") {
        await this.email.sendExpensePaidEmail(employee.email, employeeName, category, amount);
      }
    } catch {
      return;
    }
  }
}
