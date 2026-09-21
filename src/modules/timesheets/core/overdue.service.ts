import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, inArray, lte, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { organizationMembers, timesheetPeriods, timesheetSettings, users } from "../../../db/schema";
import { AccessService } from "../../access/access.service";
import { actingMembershipId } from "../../../common/auth/principal";
import { membershipScope, resolveApprovalScope } from "./timesheets-core-scope";
import { dueDateFor, resolveReminderRules } from "./dto/reminder-rules.schemas";
import { wholeDaysBetween } from "./lib/period.helpers";
import type { OverdueQuery } from "./dto/overdue.schemas";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

export interface OverduePeriodRow {
  periodId: number;
  userMembershipId: number | null;
  userId: string | null;
  userName: string | null;
  userEmail: string | null;
  periodStart: string;
  periodEnd: string;
  status: string;
  totalHours: string;
  dueDate: string;
  daysOverdue: number;
  escalationLevel: number;
}

export interface OverdueQueueResult {
  escalationThresholds: number[];
  graceDays: number;
  asOf: string;
  items: OverduePeriodRow[];
  total: number;
}

const UNSETTLED = ["OPEN", "DRAFT", "REJECTED"] as const;

@Injectable()
export class TimesheetOverdueService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
  ) {}

  async listOverdue(u: CurrentUserContext, query: OverdueQuery): Promise<OverdueQueueResult> {
    const asOf = query.asOf ?? new Date().toISOString().slice(0, 10);

    const [settings] = await this.db
      .select({
        reminderRules: timesheetSettings.reminderRules,
        submissionGraceDays: timesheetSettings.submissionGraceDays,
      })
      .from(timesheetSettings)
      .where(eq(timesheetSettings.orgId, u.orgId))
      .limit(1);

    const graceDays = settings?.submissionGraceDays ?? 0;
    const { rules } = resolveReminderRules(settings?.reminderRules);
    const thresholds = [...rules.remindAfterDueDays].sort((a, b) => a - b);

    const cutoff = new Date(
      Date.parse(`${asOf}T00:00:00Z`) - (graceDays + 1) * 86_400_000,
    )
      .toISOString()
      .slice(0, 10);

    const read = await resolveApprovalScope(this.access, u);
    const conditions: SQL[] = [
      read.compose(
        {
          tenant: timesheetPeriods.orgId,
          scope: membershipScope(actingMembershipId(u.principal), timesheetPeriods.userMembershipId),
          and: [
            inArray(timesheetPeriods.status, [...UNSETTLED]),
            lte(timesheetPeriods.periodEnd, cutoff),
          ],
        },
        (where) => where.sql,
        () => sql`false`,
      ),
    ];
    if (query.userId && read.unrestricted) {
      const [member] = await this.db
        .select({ id: organizationMembers.id })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.orgId, u.orgId),
            eq(organizationMembers.userId, query.userId),
          ),
        )
        .limit(1);
      conditions.push(member ? eq(timesheetPeriods.userMembershipId, member.id) : sql`false`);
    }

    const limit = Math.min(query.limit, 100);
    const offset = (query.page - 1) * limit;

    const ownerMember = alias(organizationMembers, "owner_member");
    const rows = await this.db
      .select({
        id: timesheetPeriods.id,
        userMembershipId: timesheetPeriods.userMembershipId,
        userId: ownerMember.userId,
        periodStart: timesheetPeriods.periodStart,
        periodEnd: timesheetPeriods.periodEnd,
        status: timesheetPeriods.status,
        totalHours: timesheetPeriods.totalHours,
        userName: users.name,
        userEmail: users.email,
        windowTotal: sql<string>`count(*) OVER ()`,
      })
      .from(timesheetPeriods)
      .leftJoin(
        ownerMember,
        and(
          eq(timesheetPeriods.orgId, ownerMember.orgId),
          eq(timesheetPeriods.userMembershipId, ownerMember.id),
        ),
      )
      .leftJoin(users, eq(ownerMember.userId, users.id))
      .where(and(...conditions))
      .orderBy(asc(timesheetPeriods.periodEnd), asc(timesheetPeriods.id))
      .limit(limit)
      .offset(offset);

    const items: OverduePeriodRow[] = rows.map((row) => {
      const dueDate = dueDateFor(row.periodEnd, graceDays);
      const daysOverdue = wholeDaysBetween(dueDate, asOf);
      return {
        periodId: row.id,
        userMembershipId: row.userMembershipId,
        userId: row.userId ?? null,
        userName: row.userName ?? null,
        userEmail: row.userEmail ?? null,
        periodStart: row.periodStart,
        periodEnd: row.periodEnd,
        status: row.status,
        totalHours: row.totalHours,
        dueDate,
        daysOverdue,
        escalationLevel: thresholds.filter((t) => daysOverdue >= t).length,
      };
    });

    const first = rows[0];
    let total: number;
    if (first) {
      total = Number(first.windowTotal);
    } else if (offset === 0) {
      total = 0;
    } else {
      const fallback = await this.db
        .select({ n: sql<string>`count(*)` })
        .from(timesheetPeriods)
        .where(and(...conditions));
      total = Number(fallback[0]?.n ?? 0);
    }

    return { escalationThresholds: thresholds, graceDays, asOf, items, total };
  }
}
