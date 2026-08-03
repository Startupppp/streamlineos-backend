import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, count, desc, eq, inArray, max } from "drizzle-orm";
import { finBudgets, finBudgetLines, finBudgetRevisions, ledgerAccounts } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { buildListResponse, paginateOffset } from "../../../common/pagination/pagination";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { addDecimals, multiplyDecimals } from "../../accounting/core/money.util";
import type {
  ListBudgetsQuery,
  CreateBudgetInput,
  UpdateBudgetInput,
  ReplaceBudgetLinesInput,
  BudgetWorkflowInput,
  DuplicateBudgetInput,
} from "./dto/finance-planning.schemas";

const BUDGET_CACHE_PREFIX = (orgId: string, budgetId: number) =>
  `fin:budget:${orgId}:${budgetId}`;
const BVA_CACHE_PREFIX = (orgId: string, budgetId: number) =>
  `fin:bva:${orgId}:${budgetId}`;

@Injectable()
export class BudgetsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
  ) {}

  async listBudgets(orgId: string, query: ListBudgetsQuery) {
    const { page, pageSize, status, fiscalYear } = query;
    const conds = [eq(finBudgets.orgId, orgId)];
    if (status) conds.push(eq(finBudgets.status, status));
    if (fiscalYear) conds.push(eq(finBudgets.fiscalYear, fiscalYear));
    const where = and(...conds);
    const { offset, limit } = paginateOffset({ page, pageSize });
    const items = await this.db
      .select()
      .from(finBudgets)
      .where(where)
      .orderBy(desc(finBudgets.createdAt))
      .offset(offset)
      .limit(limit);
    const totalRows = await this.db
      .select({ c: count() })
      .from(finBudgets)
      .where(where);
    return buildListResponse(items, Number(totalRows[0]?.c ?? 0), { page, pageSize });
  }

  async createBudget(orgId: string, userId: string, input: CreateBudgetInput) {
    const [budget] = await this.db
      .insert(finBudgets)
      .values({
        orgId,
        name: input.name,
        fiscalYear: input.fiscalYear,
        periodType: input.periodType,
        dimensionType: input.dimensionType,
        status: "DRAFT",
        totalAmount: "0",
        createdBy: userId,
      })
      .returning();
    if (!budget) throw new Error("Failed to create budget");
    this.audit.log({
      action: "budget.created",
      userId,
      orgId,
      resourceType: "fin_budget",
      resourceId: String(budget.id),
    });
    return budget;
  }

  async getBudget(orgId: string, budgetId: number) {
    const [budget] = await this.db
      .select()
      .from(finBudgets)
      .where(and(eq(finBudgets.id, budgetId), eq(finBudgets.orgId, orgId)));
    if (!budget) throw new NotFoundException("Budget not found");

    const lines = await this.db
      .select({
        accountId: finBudgetLines.accountId,
        accountCode: ledgerAccounts.code,
        accountName: ledgerAccounts.name,
        periodKey: finBudgetLines.periodKey,
        amount: finBudgetLines.amount,
        departmentId: finBudgetLines.departmentId,
        projectId: finBudgetLines.projectId,
      })
      .from(finBudgetLines)
      .innerJoin(ledgerAccounts, eq(finBudgetLines.accountId, ledgerAccounts.id))
      .where(
        and(
          eq(finBudgetLines.budgetId, budgetId),
          eq(finBudgetLines.orgId, orgId),
        ),
      );

    return { ...budget, lines };
  }

  async updateBudget(
    orgId: string,
    budgetId: number,
    userId: string,
    input: UpdateBudgetInput,
  ) {
    const [existing] = await this.db
      .select({ status: finBudgets.status })
      .from(finBudgets)
      .where(and(eq(finBudgets.id, budgetId), eq(finBudgets.orgId, orgId)));
    if (!existing) throw new NotFoundException("Budget not found");
    if (existing.status !== "DRAFT") {
      throw new ForbiddenException("Budget is not in DRAFT status");
    }

    const updates: Partial<typeof finBudgets.$inferInsert> = {};
    if (input.name !== undefined) updates.name = input.name;
    if (input.dimensionType !== undefined) updates.dimensionType = input.dimensionType;

    const [updated] = await this.db
      .update(finBudgets)
      .set(updates)
      .where(and(eq(finBudgets.id, budgetId), eq(finBudgets.orgId, orgId)))
      .returning();

    await this.cache.invalidate(BUDGET_CACHE_PREFIX(orgId, budgetId));
    this.audit.log({
      action: "budget.updated",
      userId,
      orgId,
      resourceType: "fin_budget",
      resourceId: String(budgetId),
    });
    return updated;
  }

  async replaceBudgetLines(
    orgId: string,
    budgetId: number,
    userId: string,
    input: ReplaceBudgetLinesInput,
  ) {
    const [existing] = await this.db
      .select({ status: finBudgets.status })
      .from(finBudgets)
      .where(and(eq(finBudgets.id, budgetId), eq(finBudgets.orgId, orgId)));
    if (!existing) throw new NotFoundException("Budget not found");
    if (existing.status !== "DRAFT") {
      throw new ForbiddenException("Budget is not in DRAFT status");
    }

    if (input.lines.length > 0) {
      const accountIds = [...new Set(input.lines.map((l) => l.accountId))];
      const validAccounts = await this.db
        .select({ id: ledgerAccounts.id })
        .from(ledgerAccounts)
        .where(
          and(
            eq(ledgerAccounts.orgId, orgId),
            eq(ledgerAccounts.isActive, true),
            inArray(ledgerAccounts.id, accountIds),
          ),
        );
      const validAccountIdSet = new Set(validAccounts.map((a) => a.id));
      const invalidIds = accountIds.filter((id) => !validAccountIdSet.has(id));
      if (invalidIds.length > 0) {
        throw new BadRequestException(`Invalid or inactive account IDs: ${invalidIds.join(", ")}`);
      }
    }

    await this.db.transaction(async (tx) => {
      const currentLines = await tx
        .select()
        .from(finBudgetLines)
        .where(
          and(
            eq(finBudgetLines.budgetId, budgetId),
            eq(finBudgetLines.orgId, orgId),
          ),
        );

      const maxRevResult = await tx
        .select({ maxRev: max(finBudgetRevisions.revisionNumber) })
        .from(finBudgetRevisions)
        .where(eq(finBudgetRevisions.budgetId, budgetId));
      const nextRevision = Number(maxRevResult[0]?.maxRev ?? 0) + 1;

      const snapshotData = currentLines.map((l) => ({
        accountId: l.accountId,
        periodKey: l.periodKey,
        amount: l.amount,
        departmentId: l.departmentId ?? null,
        projectId: l.projectId ?? null,
      }));

      await tx.insert(finBudgetRevisions).values({
        budgetId,
        orgId,
        revisionNumber: nextRevision,
        snapshot: snapshotData,
        note: input.note ?? null,
        createdBy: userId,
      });

      await tx
        .delete(finBudgetLines)
        .where(
          and(
            eq(finBudgetLines.budgetId, budgetId),
            eq(finBudgetLines.orgId, orgId),
          ),
        );

      if (input.lines.length > 0) {
        await tx.insert(finBudgetLines).values(
          input.lines.map((line) => ({
            budgetId,
            orgId,
            accountId: line.accountId,
            periodKey: line.periodKey,
            amount: String(line.amount),
            departmentId: line.departmentId ?? null,
            projectId: line.projectId ?? null,
          })),
        );
      }

      let total = "0";
      for (const line of input.lines) {
        total = addDecimals(total, String(line.amount));
      }

      await tx
        .update(finBudgets)
        .set({ totalAmount: total })
        .where(and(eq(finBudgets.id, budgetId), eq(finBudgets.orgId, orgId)));
    });

    await Promise.all([
      this.cache.invalidate(BUDGET_CACHE_PREFIX(orgId, budgetId)),
      this.cache.invalidatePattern(`${BVA_CACHE_PREFIX(orgId, budgetId)}:*`),
    ]);
    this.audit.log({
      action: "budget.lines_replaced",
      userId,
      orgId,
      resourceType: "fin_budget",
      resourceId: String(budgetId),
    });
  }

  async submitBudget(
    orgId: string,
    budgetId: number,
    userId: string,
    input: BudgetWorkflowInput,
  ) {
    const [existing] = await this.db
      .select({ status: finBudgets.status })
      .from(finBudgets)
      .where(and(eq(finBudgets.id, budgetId), eq(finBudgets.orgId, orgId)));
    if (!existing) throw new NotFoundException("Budget not found");
    if (existing.status !== "DRAFT") {
      throw new ForbiddenException("Budget is not in DRAFT status");
    }

    const [updated] = await this.db
      .update(finBudgets)
      .set({ status: "PENDING_APPROVAL" })
      .where(and(eq(finBudgets.id, budgetId), eq(finBudgets.orgId, orgId)))
      .returning();

    await this.cache.invalidate(BUDGET_CACHE_PREFIX(orgId, budgetId));
    this.audit.log({
      action: "budget.submitted",
      userId,
      orgId,
      resourceType: "fin_budget",
      resourceId: String(budgetId),
      metadata: { note: input.note },
    });
    return updated;
  }

  async approveBudget(
    orgId: string,
    budgetId: number,
    userId: string,
    input: BudgetWorkflowInput,
  ) {
    const [existing] = await this.db
      .select({ status: finBudgets.status })
      .from(finBudgets)
      .where(and(eq(finBudgets.id, budgetId), eq(finBudgets.orgId, orgId)));
    if (!existing) throw new NotFoundException("Budget not found");
    if (existing.status !== "PENDING_APPROVAL") {
      throw new ForbiddenException("Budget is not in PENDING_APPROVAL status");
    }

    const [updated] = await this.db
      .update(finBudgets)
      .set({ status: "APPROVED", approvedBy: userId, approvedAt: new Date() })
      .where(and(eq(finBudgets.id, budgetId), eq(finBudgets.orgId, orgId)))
      .returning();

    await this.cache.invalidate(BUDGET_CACHE_PREFIX(orgId, budgetId));
    this.audit.log({
      action: "budget.approved",
      userId,
      orgId,
      resourceType: "fin_budget",
      resourceId: String(budgetId),
      metadata: { note: input.note },
    });
    return updated;
  }

  async listRevisions(orgId: string, budgetId: number) {
    const [budget] = await this.db
      .select({ id: finBudgets.id })
      .from(finBudgets)
      .where(and(eq(finBudgets.id, budgetId), eq(finBudgets.orgId, orgId)));
    if (!budget) throw new NotFoundException("Budget not found");

    const revisions = await this.db
      .select()
      .from(finBudgetRevisions)
      .where(
        and(
          eq(finBudgetRevisions.budgetId, budgetId),
          eq(finBudgetRevisions.orgId, orgId),
        ),
      )
      .orderBy(desc(finBudgetRevisions.revisionNumber));

    return revisions.map((rev) => {
      const snapshotArray = Array.isArray(rev.snapshot) ? rev.snapshot : [];
      return {
        id: rev.id,
        revisionNumber: rev.revisionNumber,
        note: rev.note,
        createdBy: rev.createdBy,
        createdAt: rev.createdAt,
        lineCount: snapshotArray.length,
      };
    });
  }

  async duplicateBudget(
    orgId: string,
    budgetId: number,
    userId: string,
    input: DuplicateBudgetInput,
  ) {
    const [source] = await this.db
      .select()
      .from(finBudgets)
      .where(and(eq(finBudgets.id, budgetId), eq(finBudgets.orgId, orgId)));
    if (!source) throw new NotFoundException("Budget not found");

    const sourceLines = await this.db
      .select()
      .from(finBudgetLines)
      .where(
        and(
          eq(finBudgetLines.budgetId, budgetId),
          eq(finBudgetLines.orgId, orgId),
        ),
      );

    const multiplier = String(1 + input.upliftPct / 100);

    const finalBudget = await this.db.transaction(async (tx) => {
      const [newBudget] = await tx
        .insert(finBudgets)
        .values({
          orgId,
          name: input.newName,
          fiscalYear: input.newFiscalYear,
          periodType: source.periodType,
          dimensionType: source.dimensionType,
          status: "DRAFT",
          totalAmount: "0",
          createdBy: userId,
        })
        .returning();
      if (!newBudget) throw new Error("Failed to duplicate budget");

      let total = "0";
      if (sourceLines.length > 0) {
        const newLines = sourceLines.map((line) => {
          const newAmount = multiplyDecimals(String(line.amount), multiplier);
          total = addDecimals(total, newAmount);
          return {
            budgetId: newBudget.id,
            orgId,
            accountId: line.accountId,
            periodKey: line.periodKey,
            amount: newAmount,
            departmentId: line.departmentId,
            projectId: line.projectId,
          };
        });
        await tx.insert(finBudgetLines).values(newLines);
      }

      const [updated] = await tx
        .update(finBudgets)
        .set({ totalAmount: total })
        .where(and(eq(finBudgets.id, newBudget.id), eq(finBudgets.orgId, orgId)))
        .returning();
      return updated;
    });

    if (!finalBudget) throw new NotFoundException("Duplicated budget not found");
    this.audit.log({
      action: "budget.duplicated",
      userId,
      orgId,
      resourceType: "fin_budget",
      resourceId: String(finalBudget.id),
      metadata: { sourceBudgetId: budgetId },
    });
    return finalBudget;
  }
}
