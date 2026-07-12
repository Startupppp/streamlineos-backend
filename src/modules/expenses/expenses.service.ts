import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import {
  eq,
  and,
  or,
  asc,
  desc,
  gte,
  lte,
  like,
  sql,
  count,
} from "drizzle-orm";
import { expenses, expenseCategories, users, ledgerAccounts } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_TTL } from "../../common/cache/cache-keys";
import { AuditService } from "../../common/audit/audit.service";
import type {
  CreateCategoryInput,
  AllExpenseStatus,
  ListInput,
  PageDataInput,
  ReportInput,
  ExportInput,
} from "./dto/expense.schemas";

const ALL_EXPENSE_STATUSES_SET = new Set<string>([
  "DRAFT", "SUBMITTED", "PENDING", "APPROVED", "REJECTED", "REIMBURSEMENT_PENDING", "REIMBURSED", "PAID",
]);

function isExpenseStatus(value: string): value is AllExpenseStatus {
  return ALL_EXPENSE_STATUSES_SET.has(value);
}

interface DeleteContext {
  userId: string;
  isAdmin: boolean;
}

@Injectable()
export class ExpensesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
  ) {}

  list(orgId: string, userId: string, isAdmin: boolean, filters: ListInput) {
    const key = `hr:expenses:${orgId}:${userId}:${isAdmin ? "admin" : "self"}:${filters.userId ?? ""}:${filters.status ?? ""}:${filters.page ?? ""}:${filters.limit ?? ""}:${filters.startDate ?? ""}:${filters.endDate ?? ""}`;
    return this.cache.cached(
      key,
      () => this.getExpenses(orgId, userId, isAdmin, filters),
      CACHE_TTL.SHORT,
    );
  }

  private async getExpenses(orgId: string, userId: string, isAdmin: boolean, filters: ListInput) {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const offset = (page - 1) * limit;

    const conditions = [eq(expenses.orgId, orgId)];
    if (!isAdmin) {
      conditions.push(eq(expenses.userId, userId));
    } else if (filters.userId) {
      conditions.push(eq(expenses.userId, filters.userId));
    }
    if (filters.status) conditions.push(eq(expenses.status, filters.status));
    if (filters.startDate) conditions.push(gte(expenses.expenseDate, filters.startDate));
    if (filters.endDate) conditions.push(lte(expenses.expenseDate, filters.endDate));

    const [countResult] = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(expenses)
      .where(and(...conditions));

    const total = Number(countResult?.count || 0);

    const data = await this.db.query.expenses.findMany({
      where: and(...conditions),
      orderBy: [desc(expenses.expenseDate)],
      limit,
      offset,
    });

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async remove(orgId: string, ctx: DeleteContext, expenseId: number) {
    const expense = await this.db.query.expenses.findFirst({
      where: and(eq(expenses.id, expenseId), eq(expenses.orgId, orgId)),
      columns: { id: true, userId: true, status: true },
    });

    if (!expense) return { error: "not_found" as const };

    const isOwner = expense.userId === ctx.userId;
    if (!isOwner && !ctx.isAdmin) return { error: "forbidden" as const };
    if (expense.status === "PAID") return { error: "paid" as const };

    await this.db.delete(expenses).where(and(eq(expenses.id, expenseId), eq(expenses.orgId, orgId)));

    this.audit.log({
      action: "expense.deleted",
      userId: ctx.userId,
      orgId,
      targetId: String(expenseId),
      targetType: "expense",
    });

    return { success: true as const };
  }

  async getCategories(orgId: string) {
    const cats = await this.db.query.expenseCategories.findMany({
      where: and(eq(expenseCategories.orgId, orgId), eq(expenseCategories.isActive, true)),
      orderBy: [expenseCategories.name],
    });

    const now = new Date();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const monthStart = `${now.getFullYear()}-${m}-01`;

    const spending = await this.db
      .select({
        category: expenses.category,
        totalSpent: sql<number>`COALESCE(SUM(CASE WHEN ${expenses.status} IN ('APPROVED', 'PAID') THEN CAST(${expenses.amount} AS DECIMAL) ELSE 0 END), 0)`,
        pendingAmount: sql<number>`COALESCE(SUM(CASE WHEN ${expenses.status} = 'PENDING' THEN CAST(${expenses.amount} AS DECIMAL) ELSE 0 END), 0)`,
        approvedAmount: sql<number>`COALESCE(SUM(CASE WHEN ${expenses.status} = 'APPROVED' THEN CAST(${expenses.amount} AS DECIMAL) ELSE 0 END), 0)`,
        expenseCount: sql<number>`COUNT(*)`,
      })
      .from(expenses)
      .where(and(eq(expenses.orgId, orgId), gte(expenses.expenseDate, monthStart)))
      .groupBy(expenses.category);

    const spendingMap = new Map(spending.map((s) => [s.category, s]));

    return cats.map((cat) => {
      const s = spendingMap.get(cat.name);
      return {
        ...cat,
        totalSpent: Number(s?.totalSpent) || 0,
        pendingAmount: Number(s?.pendingAmount) || 0,
        approvedAmount: Number(s?.approvedAmount) || 0,
        expenseCount: Number(s?.expenseCount) || 0,
      };
    });
  }

  async createCategory(orgId: string, input: CreateCategoryInput) {
    if (input.ledgerAccountId !== undefined) {
      const [acct] = await this.db
        .select({ id: ledgerAccounts.id, accountType: ledgerAccounts.accountType })
        .from(ledgerAccounts)
        .where(and(eq(ledgerAccounts.id, input.ledgerAccountId), eq(ledgerAccounts.orgId, orgId)))
        .limit(1);
      if (!acct) throw new BadRequestException("Ledger account not found");
      if (acct.accountType !== "EXPENSE") throw new BadRequestException("Ledger account must be of type EXPENSE");
    }

    const [category] = await this.db
      .insert(expenseCategories)
      .values({
        orgId,
        name: input.name,
        description: input.description,
        budgetLimit: input.budgetLimit?.toString(),
        budgetPeriod: input.budgetPeriod,
        ledgerAccountId: input.ledgerAccountId ?? null,
      })
      .returning();

    return category;
  }

  private buildPageConditions(orgId: string, userId: string, isAdmin: boolean, filters: PageDataInput) {
    const conditions = [eq(expenses.orgId, orgId)];

    if (!isAdmin) {
      conditions.push(eq(expenses.userId, userId));
    } else if (filters.userId) {
      conditions.push(eq(expenses.userId, filters.userId));
    }

    if (filters.month) {
      const [year, mon] = filters.month.split("-");
      const lastDay = new Date(parseInt(year), parseInt(mon), 0).getDate();
      conditions.push(gte(expenses.expenseDate, `${year}-${mon}-01`));
      conditions.push(lte(expenses.expenseDate, `${year}-${mon}-${lastDay.toString().padStart(2, "0")}`));
    } else {
      if (filters.startDate) conditions.push(gte(expenses.expenseDate, filters.startDate));
      if (filters.endDate) conditions.push(lte(expenses.expenseDate, filters.endDate));
    }

    if (filters.categoryId) conditions.push(eq(expenses.categoryId, filters.categoryId));
    if (filters.category) conditions.push(eq(expenses.category, filters.category));

    if (filters.status && filters.status !== "all" && filters.status !== "ALL" && isExpenseStatus(filters.status)) {
      conditions.push(eq(expenses.status, filters.status));
    }

    if (filters.minAmount && filters.minAmount > 0) {
      conditions.push(gte(sql`CAST(${expenses.amount} AS DECIMAL)`, filters.minAmount));
    }
    if (filters.maxAmount && filters.maxAmount > 0) {
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

  async getPageData(orgId: string, userId: string, isAdmin: boolean, filters: PageDataInput) {
    const page = filters.page;
    const pageSize = filters.pageSize;
    const offset = (page - 1) * pageSize;

    const conditions = this.buildPageConditions(orgId, userId, isAdmin, filters);
    const baseFilters: PageDataInput = {
      page,
      pageSize,
      sortBy: filters.sortBy,
      sortOrder: filters.sortOrder,
    };
    const baseConditions = this.buildPageConditions(orgId, userId, isAdmin, baseFilters);

    const sortColumns = {
      date: expenses.expenseDate,
      amount: expenses.amount,
      category: expenses.category,
      status: expenses.status,
      created: expenses.createdAt,
    } as const;
    const sortColumn = sortColumns[filters.sortBy] ?? expenses.expenseDate;
    const orderFn = filters.sortOrder === "asc" ? asc : desc;

    const [expenseList, countResult, statsResult, pendingList, categoryList] = await Promise.all([
      this.db.query.expenses.findMany({
        where: and(...conditions),
        with: { user: true, approver: true, expenseCategory: true, project: true },
        orderBy: [
          asc(sql`CASE ${expenses.status} WHEN 'PENDING' THEN 0 WHEN 'APPROVED' THEN 1 WHEN 'REJECTED' THEN 2 WHEN 'PAID' THEN 3 ELSE 4 END`),
          orderFn(sortColumn),
          desc(expenses.createdAt),
        ],
        limit: pageSize,
        offset,
      }),
      this.db.select({ count: count() }).from(expenses).where(and(...conditions)),
      this.db
        .select({
          totalAmount: sql<number>`COALESCE(SUM(CAST(${expenses.amount} AS DECIMAL)), 0)`,
          pendingAmount: sql<number>`COALESCE(SUM(CASE WHEN ${expenses.status} = 'PENDING' THEN CAST(${expenses.amount} AS DECIMAL) ELSE 0 END), 0)`,
          approvedAmount: sql<number>`COALESCE(SUM(CASE WHEN ${expenses.status} = 'APPROVED' THEN CAST(${expenses.amount} AS DECIMAL) ELSE 0 END), 0)`,
          rejectedAmount: sql<number>`COALESCE(SUM(CASE WHEN ${expenses.status} = 'REJECTED' THEN CAST(${expenses.amount} AS DECIMAL) ELSE 0 END), 0)`,
          paidAmount: sql<number>`COALESCE(SUM(CASE WHEN ${expenses.status} = 'PAID' THEN CAST(${expenses.amount} AS DECIMAL) ELSE 0 END), 0)`,
          totalCount: sql<number>`COUNT(*)`,
          pendingCount: sql<number>`COUNT(CASE WHEN ${expenses.status} = 'PENDING' THEN 1 END)`,
          approvedCount: sql<number>`COUNT(CASE WHEN ${expenses.status} = 'APPROVED' THEN 1 END)`,
          rejectedCount: sql<number>`COUNT(CASE WHEN ${expenses.status} = 'REJECTED' THEN 1 END)`,
          paidCount: sql<number>`COUNT(CASE WHEN ${expenses.status} = 'PAID' THEN 1 END)`,
        })
        .from(expenses)
        .where(and(...baseConditions)),
      isAdmin
        ? this.db.query.expenses.findMany({
            where: and(eq(expenses.orgId, orgId), eq(expenses.status, "PENDING")),
            with: { user: true, approver: true, expenseCategory: true, project: true },
            orderBy: [desc(expenses.createdAt)],
          })
        : Promise.resolve([]),
      this.db.query.expenseCategories.findMany({
        where: and(eq(expenseCategories.orgId, orgId), eq(expenseCategories.isActive, true)),
        orderBy: [expenseCategories.name],
      }),
    ]);

    const s = statsResult[0];
    const total = countResult[0]?.count ?? 0;

    return {
      expenses: expenseList,
      pendingExpenses: pendingList,
      stats: {
        totalAmount: Number(s?.totalAmount) || 0,
        pendingAmount: Number(s?.pendingAmount) || 0,
        approvedAmount: Number(s?.approvedAmount) || 0,
        rejectedAmount: Number(s?.rejectedAmount) || 0,
        paidAmount: Number(s?.paidAmount) || 0,
        totalCount: Number(s?.totalCount) || 0,
        pendingCount: Number(s?.pendingCount) || 0,
        approvedCount: Number(s?.approvedCount) || 0,
        rejectedCount: Number(s?.rejectedCount) || 0,
        paidCount: Number(s?.paidCount) || 0,
        avgExpenseAmount: s?.totalCount ? Number(s.totalAmount) / Number(s.totalCount) : 0,
      },
      categories: categoryList,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
      isAdmin,
    };
  }

  async getReport(orgId: string, userId: string, isAdmin: boolean, filters: ReportInput) {
    const conditions = [
      eq(expenses.orgId, orgId),
      gte(expenses.expenseDate, filters.startDate),
      lte(expenses.expenseDate, filters.endDate),
    ];

    if (!isAdmin) conditions.push(eq(expenses.userId, userId));

    const [allExpenses, byCategory, byMonth, byStatus, topExpenses, byEmployee] = await Promise.all([
      this.db
        .select({
          totalAmount: sql<number>`COALESCE(SUM(CAST(${expenses.amount} AS DECIMAL)), 0)`,
          approvedAmount: sql<number>`COALESCE(SUM(CASE WHEN ${expenses.status} IN ('APPROVED','PAID') THEN CAST(${expenses.amount} AS DECIMAL) ELSE 0 END), 0)`,
          rejectedAmount: sql<number>`COALESCE(SUM(CASE WHEN ${expenses.status} = 'REJECTED' THEN CAST(${expenses.amount} AS DECIMAL) ELSE 0 END), 0)`,
          pendingAmount: sql<number>`COALESCE(SUM(CASE WHEN ${expenses.status} = 'PENDING' THEN CAST(${expenses.amount} AS DECIMAL) ELSE 0 END), 0)`,
          totalExpenses: sql<number>`COUNT(*)`,
        })
        .from(expenses)
        .where(and(...conditions)),
      this.db
        .select({
          category: expenses.category,
          count: sql<number>`COUNT(*)`,
          amount: sql<number>`COALESCE(SUM(CAST(${expenses.amount} AS DECIMAL)), 0)`,
        })
        .from(expenses)
        .where(and(...conditions))
        .groupBy(expenses.category)
        .orderBy(desc(sql`SUM(CAST(${expenses.amount} AS DECIMAL))`)),
      this.db
        .select({
          month: sql<string>`TO_CHAR(${expenses.expenseDate}::date, 'Mon YYYY')`,
          count: sql<number>`COUNT(*)`,
          amount: sql<number>`COALESCE(SUM(CAST(${expenses.amount} AS DECIMAL)), 0)`,
        })
        .from(expenses)
        .where(and(...conditions))
        .groupBy(sql`TO_CHAR(${expenses.expenseDate}::date, 'Mon YYYY')`, sql`TO_CHAR(${expenses.expenseDate}::date, 'YYYY-MM')`)
        .orderBy(sql`TO_CHAR(${expenses.expenseDate}::date, 'YYYY-MM')`),
      this.db
        .select({
          status: expenses.status,
          count: sql<number>`COUNT(*)`,
          amount: sql<number>`COALESCE(SUM(CAST(${expenses.amount} AS DECIMAL)), 0)`,
        })
        .from(expenses)
        .where(and(...conditions))
        .groupBy(expenses.status),
      this.db.query.expenses.findMany({
        where: and(...conditions, or(eq(expenses.status, "APPROVED"), eq(expenses.status, "PAID"))),
        with: { user: true },
        orderBy: [desc(sql`CAST(${expenses.amount} AS DECIMAL)`)],
        limit: 10,
      }),
      isAdmin
        ? this.db
            .select({
              userId: expenses.userId,
              firstName: users.firstName,
              lastName: users.lastName,
              count: sql<number>`COUNT(*)`,
              amount: sql<number>`COALESCE(SUM(CAST(${expenses.amount} AS DECIMAL)), 0)`,
            })
            .from(expenses)
            .leftJoin(users, eq(expenses.userId, users.id))
            .where(and(...conditions))
            .groupBy(expenses.userId, users.firstName, users.lastName)
            .orderBy(desc(sql`SUM(CAST(${expenses.amount} AS DECIMAL))`))
        : Promise.resolve([]),
    ]);

    const summary = allExpenses[0];
    const totalAmount = Number(summary?.totalAmount) || 0;

    return {
      summary: {
        totalExpenses: Number(summary?.totalExpenses) || 0,
        totalAmount,
        approvedAmount: Number(summary?.approvedAmount) || 0,
        rejectedAmount: Number(summary?.rejectedAmount) || 0,
        pendingAmount: Number(summary?.pendingAmount) || 0,
        avgExpenseAmount: summary?.totalExpenses ? totalAmount / Number(summary.totalExpenses) : 0,
      },
      byCategory: byCategory.map((c) => ({
        category: c.category,
        count: Number(c.count),
        amount: Number(c.amount),
        percentage: totalAmount > 0 ? (Number(c.amount) / totalAmount) * 100 : 0,
      })),
      byEmployee: byEmployee.map((e) => ({
        userId: e.userId || "",
        userName: `${e.firstName || ""} ${e.lastName || ""}`.trim() || "Unknown",
        count: Number(e.count),
        amount: Number(e.amount),
      })),
      byMonth: byMonth.map((m) => ({
        month: m.month,
        count: Number(m.count),
        amount: Number(m.amount),
      })),
      byStatus: byStatus.map((s) => ({
        status: s.status || "PENDING",
        count: Number(s.count),
        amount: Number(s.amount),
      })),
      topExpenses: topExpenses.map((e) => ({
        id: e.id,
        category: e.category,
        amount: parseFloat(e.amount),
        description: e.description || "",
        userName: `${e.user?.firstName || ""} ${e.user?.lastName || ""}`.trim() || "Unknown",
        expenseDate: e.expenseDate,
      })),
    };
  }

  async getExportRows(orgId: string, ctx: DeleteContext, filters: ExportInput) {
    const conditions = [eq(expenses.orgId, orgId)];

    if (!ctx.isAdmin) {
      conditions.push(eq(expenses.userId, ctx.userId));
    }

    if (filters.status) conditions.push(eq(expenses.status, filters.status));
    if (filters.startDate) conditions.push(gte(expenses.expenseDate, filters.startDate));
    if (filters.endDate) conditions.push(lte(expenses.expenseDate, filters.endDate));

    const data = await this.db
      .select({
        expenseDate: expenses.expenseDate,
        category: expenses.category,
        amount: expenses.amount,
        description: expenses.description,
        status: expenses.status,
        rejectionReason: expenses.rejectionReason,
        userName: users.name,
        userEmail: users.email,
      })
      .from(expenses)
      .leftJoin(users, eq(expenses.userId, users.id))
      .where(and(...conditions))
      .orderBy(expenses.expenseDate);

    this.audit.log({
      action: "expense.exported",
      userId: ctx.userId,
      orgId,
      metadata: {
        format: "csv",
        recordCount: data.length,
        status: filters.status,
        startDate: filters.startDate,
        endDate: filters.endDate,
      },
    });

    return data;
  }
}
