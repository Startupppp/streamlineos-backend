import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { organizationMembers, timesheetBudgets, timesheets, projects } from "../../../db/schema";
import { TimesheetsAuditService } from "./timesheets-audit.service";
import { computeBurn } from "./lib/budget-burn";
import { isForeignKeyViolation, isUniqueViolation } from "../../../common/db/postgres-error";
import type { CreateBudgetInput, UpdateBudgetInput } from "./dto/budgets.schemas";

type BudgetRow = typeof timesheetBudgets.$inferSelect;

/**
 * The two constraints a budget write can trip, as the caller's answers.
 * `uniq_timesheet_budgets_active_project` allows one ACTIVE budget per
 * project, and `fk_timesheet_budgets_project_id_org` is a composite tenant
 * key, so a project id from another organisation — or none — is refused by
 * the database. Both surfaced as 500s; the first is a 409 and the second the
 * same 404 an absent project answers, so the refusal confirms nothing.
 */
function budgetWriteRefusal(error: unknown): never {
  if (isUniqueViolation(error)) throw new ConflictException("An active budget already exists for this project");
  if (isForeignKeyViolation(error)) throw new NotFoundException("Project not found");
  throw error;
}

@Injectable()
export class BudgetsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: TimesheetsAuditService,
  ) {}

  private async consumedFor(
    orgId: string,
    budget: { projectId: number | null; startsAt: string | null; endsAt: string | null },
  ): Promise<{ hours: number; amount: number }> {
    const conditions = [eq(timesheets.orgId, orgId), isNull(timesheets.voidedAt)];
    if (budget.projectId !== null) conditions.push(eq(timesheets.projectId, budget.projectId));
    if (budget.startsAt) conditions.push(gte(timesheets.date, budget.startsAt));
    if (budget.endsAt) conditions.push(lte(timesheets.date, budget.endsAt));

    const [row] = await this.db
      .select({
        hours: sql<string>`COALESCE(SUM(hours::numeric), 0)::text`,
        amount: sql<string>`COALESCE(SUM(hours::numeric * COALESCE(bill_rate::numeric, 0)), 0)::text`,
      })
      .from(timesheets)
      .where(and(...conditions));

    return { hours: parseFloat(row?.hours ?? "0"), amount: parseFloat(row?.amount ?? "0") };
  }

  private shape(b: BudgetRow, projectName: string | null, consumed: { hours: number; amount: number }) {
    const burn = computeBurn(
      {
        budgetType: b.budgetType,
        budgetHours: b.budgetHours ? parseFloat(b.budgetHours) : null,
        budgetAmount: b.budgetAmount ? parseFloat(b.budgetAmount) : null,
        alertThresholds: b.alertThresholds,
      },
      consumed.hours,
      consumed.amount,
    );
    return {
      id: b.id,
      orgId: b.orgId,
      projectId: b.projectId,
      projectName,
      clientId: b.clientId,
      budgetType: b.budgetType,
      budgetHours: b.budgetHours,
      budgetAmount: b.budgetAmount,
      currency: b.currency,
      alertThresholds: b.alertThresholds,
      startsAt: b.startsAt,
      endsAt: b.endsAt,
      status: b.status,
      createdAt: b.createdAt,
      updatedAt: b.updatedAt,
      burn,
    };
  }

  async list(orgId: string) {
    const rows = await this.db
      .select({ b: timesheetBudgets, projectName: projects.name })
      .from(timesheetBudgets)
      .leftJoin(projects, eq(timesheetBudgets.projectId, projects.id))
      .where(eq(timesheetBudgets.orgId, orgId))
      .orderBy(desc(timesheetBudgets.createdAt))
      .limit(100);

    if (rows.length === 0) return [];

    const budgetIds = rows.map((r) => r.b.id);
    const consumedRows = await this.db
      .select({
        budgetId: timesheetBudgets.id,
        hours: sql<string>`COALESCE(SUM(${timesheets.hours}::numeric), 0)::text`,
        amount: sql<string>`COALESCE(SUM(${timesheets.hours}::numeric * COALESCE(${timesheets.billRate}::numeric, 0)), 0)::text`,
      })
      .from(timesheets)
      .innerJoin(
        timesheetBudgets,
        and(
          eq(timesheetBudgets.orgId, orgId),
          inArray(timesheetBudgets.id, budgetIds),
          eq(timesheets.orgId, orgId),
          isNull(timesheets.voidedAt),
          sql`(${timesheetBudgets.projectId} IS NULL OR ${timesheets.projectId} = ${timesheetBudgets.projectId})`,
          sql`(${timesheetBudgets.startsAt} IS NULL OR ${timesheets.date} >= ${timesheetBudgets.startsAt})`,
          sql`(${timesheetBudgets.endsAt} IS NULL OR ${timesheets.date} <= ${timesheetBudgets.endsAt})`,
        ),
      )
      .groupBy(timesheetBudgets.id);

    const consumedMap = new Map<number, { hours: number; amount: number }>();
    for (const c of consumedRows) {
      consumedMap.set(c.budgetId, { hours: parseFloat(c.hours), amount: parseFloat(c.amount) });
    }

    return rows.map((r) => {
      const consumed = consumedMap.get(r.b.id) ?? { hours: 0, amount: 0 };
      return this.shape(r.b, r.projectName, consumed);
    });
  }

  private async getOne(orgId: string, budgetId: number) {
    const [row] = await this.db
      .select({ b: timesheetBudgets, projectName: projects.name })
      .from(timesheetBudgets)
      .leftJoin(projects, eq(timesheetBudgets.projectId, projects.id))
      .where(and(eq(timesheetBudgets.id, budgetId), eq(timesheetBudgets.orgId, orgId)));
    if (!row) throw new NotFoundException("Budget not found");
    const consumed = await this.consumedFor(orgId, row.b);
    return this.shape(row.b, row.projectName, consumed);
  }

  async create(orgId: string, userId: string, input: CreateBudgetInput) {
    const [actorMember] = await this.db
      .select({ id: organizationMembers.id })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)))
      .limit(1);
    const actorMembId = actorMember?.id ?? null;

    if (!input.projectId && !input.clientId) {
      throw new BadRequestException("A budget must target a project or client");
    }
    const [row] = await this.db
      .insert(timesheetBudgets)
      .values({
        orgId,
        projectId: input.projectId ?? null,
        clientId: input.clientId ?? null,
        budgetType: input.budgetType ?? "HOURS",
        budgetHours: input.budgetHours?.toString() ?? null,
        budgetAmount: input.budgetAmount?.toString() ?? null,
        currency: input.currency ?? "USD",
        alertThresholds: input.alertThresholds ?? [50, 80, 100],
        startsAt: input.startsAt ?? null,
        endsAt: input.endsAt ?? null,
        status: input.status ?? "ACTIVE",
      })
      .returning()
      .catch(budgetWriteRefusal);

    if (!row) throw new Error("Insert into timesheet_budgets returned no row");

    await this.audit.recordWithDb({
      orgId,
      actorMembershipId: actorMembId,
      entityType: "budget",
      entityId: row.id.toString(),
      action: "budget.created",
      after: { projectId: input.projectId, budgetType: input.budgetType, budgetHours: input.budgetHours, budgetAmount: input.budgetAmount },
    });

    return this.getOne(orgId, row.id);
  }

  async update(orgId: string, userId: string, budgetId: number, input: UpdateBudgetInput) {
    const [[existing], [actorMember]] = await Promise.all([
      this.db.select().from(timesheetBudgets).where(and(eq(timesheetBudgets.id, budgetId), eq(timesheetBudgets.orgId, orgId))),
      this.db.select({ id: organizationMembers.id }).from(organizationMembers).where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId))).limit(1),
    ]);
    if (!existing) throw new NotFoundException("Budget not found");
    const actorMembId = actorMember?.id ?? null;

    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (input.projectId !== undefined) updateData.projectId = input.projectId;
    if (input.clientId !== undefined) updateData.clientId = input.clientId;
    if (input.budgetType !== undefined) updateData.budgetType = input.budgetType;
    if (input.budgetHours !== undefined) updateData.budgetHours = input.budgetHours.toString();
    if (input.budgetAmount !== undefined) updateData.budgetAmount = input.budgetAmount.toString();
    if (input.currency !== undefined) updateData.currency = input.currency;
    if (input.alertThresholds !== undefined) updateData.alertThresholds = input.alertThresholds;
    if (input.startsAt !== undefined) updateData.startsAt = input.startsAt;
    if (input.endsAt !== undefined) updateData.endsAt = input.endsAt;
    if (input.status !== undefined) updateData.status = input.status;

    await this.db
      .update(timesheetBudgets)
      .set(updateData)
      .where(and(eq(timesheetBudgets.id, budgetId), eq(timesheetBudgets.orgId, orgId)))
      .catch(budgetWriteRefusal);

    await this.audit.recordWithDb({
      orgId,
      actorMembershipId: actorMembId,
      entityType: "budget",
      entityId: budgetId.toString(),
      action: "budget.updated",
      after: updateData,
    });

    return this.getOne(orgId, budgetId);
  }

  async remove(orgId: string, userId: string, budgetId: number) {
    const [[existing], [actorMember]] = await Promise.all([
      this.db.select({ id: timesheetBudgets.id }).from(timesheetBudgets).where(and(eq(timesheetBudgets.id, budgetId), eq(timesheetBudgets.orgId, orgId))),
      this.db.select({ id: organizationMembers.id }).from(organizationMembers).where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId))).limit(1),
    ]);
    if (!existing) throw new NotFoundException("Budget not found");
    const actorMembId = actorMember?.id ?? null;

    await this.db.delete(timesheetBudgets).where(and(eq(timesheetBudgets.id, budgetId), eq(timesheetBudgets.orgId, orgId)));

    await this.audit.recordWithDb({
      orgId,
      actorMembershipId: actorMembId,
      entityType: "budget",
      entityId: budgetId.toString(),
      action: "budget.deleted",
    });

    return { success: true };
  }
}
