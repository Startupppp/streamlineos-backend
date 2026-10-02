import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { organizationMembers, projects, tickets, timesheets } from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { AccessService } from "../../../access/access.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { UpdateBudgetInput } from "../dto/projects.schemas";
import { assertProjectAccess, assertProjectWriteAccess } from "../project-crud/project-access";

const MINOR_UNITS_PER_MAJOR = 100;

function majorToMinor(major: number): number {
  return Math.round(major * MINOR_UNITS_PER_MAJOR);
}

function minorToMajor(minor: number): number {
  return minor / MINOR_UNITS_PER_MAJOR;
}

export interface MemberCost {
  userId: string;
  /** Every billable hour this member logged on the project, rated or not. */
  hours: number;
  /** Major units of the budget's base currency. */
  cost: number;
  /** Of `hours`, the ones carrying no stamped rate — real work, unknown cost. */
  unratedHours: number;
}

/**
 * One `(member, entry currency)` group of the project's billable timesheet
 * entries. Money units, stated once so no operand below is ambiguous:
 *
 *   timesheets.hours      numeric(6,2)   hours
 *   timesheets.bill_rate  numeric(10,2)  MAJOR units per hour, in timesheets.currency
 *   costMinor             integer        MINOR units of timesheets.currency
 *
 * `hours * bill_rate * 100` is multiplied and rounded by Postgres in `numeric`,
 * per entry, so no money value passes through a JS float.
 */
interface BudgetCostRow {
  membershipId: number | null;
  currency: string | null;
  hours: string | null;
  ratedHours: string | null;
  ratedEntries: number;
  costMinor: string | null;
}

@Injectable()
export class ProjectsBudgetService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
  ) {}

  /**
   * Spent-to-date on a project.
   *
   * Cost comes from the rate STAMPED ON THE TIMESHEET ENTRY
   * (`timesheets.bill_rate` + `timesheets.currency`, written at period approval
   * by `TimesheetsApprovalsService` from `RateResolverService`). It deliberately
   * does NOT come from `project_members.hourly_rate_minor`, which this method
   * used to read: nothing in the repository writes that column, so every
   * project in every org reported `actualCost: 0` beside real billable hours.
   *
   * Wiring a writer for it would have been the wrong repair twice over. The
   * member rate is already the last rung of `RateResolverService`'s fallback
   * chain, so it reaches the budget *through* the stamped entry — reading it
   * again here double-counts it; and multiplying today's rate by historical
   * hours re-prices work that was approved at a different rate. The two sibling
   * money surfaces (`timesheets/core/budgets.service.ts`,
   * `timesheets/core/billing.service.ts`) both cost from `bill_rate`; this one
   * now agrees with them.
   */
  async getBudget(u: CurrentUserContext, projectId: number) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    const project = await this.db.query.projects.findFirst({
      where: and(eq(projects.id, projectId), eq(projects.orgId, u.orgId), isNull(projects.deletedAt)),
      columns: { budgetMinor: true, budgetCurrency: true },
    });
    if (!project) throw new NotFoundException("Project not found");
    const orgId = u.orgId;

    // Voided entries are excluded here as they are on every other money surface
    // in the repository (11 call sites) — a voided entry is cancelled work and
    // must not read as spend.
    const costRows: BudgetCostRow[] = await this.db
      .select({
        membershipId: timesheets.userMembershipId,
        currency: timesheets.currency,
        hours: sql<string>`COALESCE(SUM(${timesheets.hours}), 0)::text`,
        ratedHours: sql<string>`COALESCE(SUM(${timesheets.hours}) FILTER (WHERE ${timesheets.billRate} IS NOT NULL), 0)::text`,
        ratedEntries: sql<number>`COUNT(*) FILTER (WHERE ${timesheets.billRate} IS NOT NULL)::int`,
        // MINOR units: hours x major-unit rate x 100, rounded per entry in numeric.
        costMinor: sql<string>`COALESCE(SUM(round(${timesheets.hours} * ${timesheets.billRate} * 100)) FILTER (WHERE ${timesheets.billRate} IS NOT NULL), 0)::text`,
      })
      .from(timesheets)
      .innerJoin(tickets, eq(timesheets.ticketId, tickets.id))
      .where(
        and(
          eq(timesheets.orgId, orgId),
          eq(tickets.orgId, orgId),
          eq(tickets.projectId, projectId),
          eq(timesheets.isBillable, true),
          isNull(timesheets.voidedAt),
        ),
      )
      .groupBy(timesheets.userMembershipId, timesheets.currency);

    // A cost may only be summed in ONE currency. The project's declared budget
    // currency wins; when it declares none (nothing writes projects.budget_currency
    // today) the entries' own currency is adopted, but only if they all agree.
    const ratedCurrencies = new Set(
      costRows.filter((r) => r.ratedEntries > 0).map((r) => r.currency),
    );
    const baseCurrency: string | null =
      project.budgetCurrency ??
      (ratedCurrencies.size === 1 ? [...ratedCurrencies][0] : null);

    const membershipIds = [
      ...new Set(
        costRows
          .map((r) => r.membershipId)
          .filter((id): id is number => id !== null),
      ),
    ];
    const orgMembers =
      membershipIds.length > 0
        ? await this.db
            .select({ id: organizationMembers.id, userId: organizationMembers.userId })
            .from(organizationMembers)
            .where(
              and(
                eq(organizationMembers.orgId, orgId),
                inArray(organizationMembers.id, membershipIds),
              ),
            )
            .limit(membershipIds.length)
        : [];
    const membershipIdToUserId = new Map(orgMembers.map((m) => [m.id, m.userId]));

    // Accumulated in MINOR units and converted once at the end, so no money
    // value is ever added to another in floating-point major units.
    const perUser = new Map<string, { userId: string; hours: number; costMinor: number; unratedHours: number }>();
    let actualCostMinor = 0; // MINOR units of baseCurrency
    let totalHours = 0;
    let unratedHours = 0;
    let excludedCurrencyHours = 0;
    let currencyMismatch = false;

    for (const row of costRows) {
      const hours = Number(row.hours ?? 0);
      const ratedHours = Number(row.ratedHours ?? 0);
      const rowCostMinor = Number(row.costMinor ?? 0);
      const countable = row.ratedEntries > 0 && row.currency === baseCurrency;

      totalHours += hours;
      unratedHours += hours - ratedHours;
      if (row.ratedEntries > 0 && !countable) {
        currencyMismatch = true;
        excludedCurrencyHours += ratedHours;
      }
      if (countable) actualCostMinor += rowCostMinor;

      const userId =
        row.membershipId !== null ? membershipIdToUserId.get(row.membershipId) : undefined;
      if (!userId) continue;
      const existing = perUser.get(userId) ?? { userId, hours: 0, costMinor: 0, unratedHours: 0 };
      existing.hours += hours;
      existing.unratedHours += hours - ratedHours;
      if (countable) existing.costMinor += rowCostMinor;
      perUser.set(userId, existing);
    }

    const memberBreakdown: MemberCost[] = [...perUser.values()]
      .sort((a, b) => b.costMinor - a.costMinor || b.hours - a.hours || a.userId.localeCompare(b.userId))
      .map((m) => ({
        userId: m.userId,
        hours: m.hours,
        cost: minorToMajor(m.costMinor),
        unratedHours: m.unratedHours,
      }));

    const plannedBudgetMinor = project.budgetMinor ?? 0;

    return {
      projectId,
      plannedBudget: minorToMajor(plannedBudgetMinor),
      actualCost: minorToMajor(actualCostMinor),
      remaining: minorToMajor(plannedBudgetMinor - actualCostMinor),
      utilizationPct:
        plannedBudgetMinor > 0
          ? Math.round((actualCostMinor / plannedBudgetMinor) * 100)
          : 0,
      currency: baseCurrency,
      totalHours,
      /** Billable hours carrying no stamped rate: real work `actualCost` omits. */
      unratedHours,
      /** True when rated hours exist in a currency other than `currency`. */
      currencyMismatch,
      /** Rated hours left out of `actualCost` because their currency differs. */
      excludedCurrencyHours,
      memberBreakdown,
    };
  }

  async updateBudget(u: CurrentUserContext, projectId: number, input: UpdateBudgetInput) {
    await assertProjectWriteAccess(this.db, this.access, u, projectId);

    const [updated] = await this.db
      .update(projects)
      .set({
        budget: String(input.budget),
        budgetMinor: majorToMinor(input.budget),
      })
      .where(and(eq(projects.id, projectId), eq(projects.orgId, u.orgId)))
      .returning({
        id: projects.id,
        budgetMinor: projects.budgetMinor,
        budgetCurrency: projects.budgetCurrency,
      });

    if (!updated) throw new NotFoundException("Project not found");
    return {
      id: updated.id,
      budget: minorToMajor(updated.budgetMinor ?? 0),
      currency: updated.budgetCurrency,
    };
  }
}
