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
  /**
   * The worker's membership in this organisation. Since the actor cutover
   * (0715) a period names its worker by membership, not by user.
   */
  userMembershipId: number | null;
  /**
   * The worker's user id, read back through that membership. Null when the
   * membership no longer resolves: removing a member sets the period's
   * membership to null rather than deleting the period.
   */
  userId: string | null;
  userName: string | null;
  userEmail: string | null;
  periodStart: string;
  periodEnd: string;
  status: string;
  totalHours: string;
  dueDate: string;
  daysOverdue: number;
  /**
   * How many of the organisation's configured overdue reminders this period has
   * passed. Zero when it has passed none — and also zero for an organisation
   * that configured none, which is why `daysOverdue` is the field to sort by
   * and `escalationThresholds` is returned alongside so a caller can tell the
   * two cases apart.
   */
  escalationLevel: number;
}

export interface OverdueQueueResult {
  /** The org's `remindAfterDueDays`, ascending. Empty when reminders are off or unconfigured. */
  escalationThresholds: number[];
  /** The grace applied to every period end to get its due date. */
  graceDays: number;
  asOf: string;
  items: OverduePeriodRow[];
  total: number;
}

/**
 * The statuses that mean "still owed".
 *
 * Not `submitted_at IS NULL`, which is what the reminder sweep uses and which
 * is wrong for this list in one direction and right in the other. A REJECTED
 * period has a `submitted_at` — it was submitted, and sent back — and is owed
 * again; a period reopened by an approver keeps its `submitted_at` too. Asking
 * the status instead says exactly the intended thing: not approved, and not
 * currently sitting in somebody else's queue.
 */
const UNSETTLED = ["OPEN", "DRAFT", "REJECTED"] as const;

/**
 * TS-11. The overdue and escalation queue.
 *
 * The pieces already existed and never met: `submission_grace_days` and
 * `reminder_rules` were being read by the nightly sweep to decide whom to
 * email, and by nothing else — so an approver had no way to see who was late,
 * only the people themselves got told, and nobody could act on the list. This
 * is the same arithmetic, served as a list.
 *
 * Deliberately derived rather than stored. An "overdue" table would be a second
 * source of truth that a settings change silently invalidates: raise the grace
 * from 2 days to 5 and every stored row is wrong until something recomputes it.
 * Computing from `period_end + grace` on read means the queue is always
 * consistent with the policy as it stands right now.
 */
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

    /**
     * The whole filter, pushed into SQL.
     *
     * A period is overdue when `period_end + grace < asOf`, so the latest
     * period end that can be overdue is `asOf - grace - 1` day. Deriving the
     * cutoff here rather than filtering in JavaScript is what keeps this a
     * bounded, indexed range scan instead of loading every unsettled period in
     * the organisation to throw most of them away.
     */
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
      /**
       * The filter names a person by user id and the period names them by
       * membership, so the one is looked up as the other inside this
       * organisation. A user with no membership here matches nothing: dropping
       * the filter instead would answer "who is late?" for everybody when asked
       * about one person.
       */
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
      /**
       * The same route to a name as `PeriodsReadService`: through the worker's
       * membership, joined on the period's own org so it cannot reach a member
       * row in another organisation.
       */
      .leftJoin(
        ownerMember,
        and(
          eq(timesheetPeriods.orgId, ownerMember.orgId),
          eq(timesheetPeriods.userMembershipId, ownerMember.id),
        ),
      )
      .leftJoin(users, eq(ownerMember.userId, users.id))
      .where(and(...conditions))
      /** Oldest first: the most overdue period is the one somebody should chase. */
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
