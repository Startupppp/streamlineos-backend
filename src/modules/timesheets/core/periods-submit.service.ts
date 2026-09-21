import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import {
  timesheetPeriods,
  timesheets,
  projects,
} from "../../../db/schema";
import { actingMembershipId } from "../../../common/auth/principal";
import { PeriodsReadService } from "./periods-read.service";
import { TimesheetsAuditService } from "./timesheets-audit.service";
import { EntriesService } from "./entries.service";
import { parseStoredRequiredFields } from "./dto/settings.schemas";
import {
  LIFECYCLE_RETURNING,
  lifecyclePayload,
  membershipUserIds,
  periodOwnerUserIdOrWarn,
} from "./approvals.service";
import {
  TIMESHEET_LIFECYCLE_EVENTS,
  emitPeriodLifecycleEvent,
} from "./events/timesheet-lifecycle.events";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

@Injectable()
export class PeriodsSubmitService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly reader: PeriodsReadService,
    private readonly entries: EntriesService,
    private readonly audit: TimesheetsAuditService,
  ) {}

  async submitPeriod(u: CurrentUserContext, periodId: number) {
    const actorMembId = actingMembershipId(u.principal);
    const row = await this.reader.getPeriodWithUser(u.orgId, periodId);
    if (!row) throw new NotFoundException("Period not found");
    if (row.userMembershipId !== actorMembId) throw new ForbiddenException("You can only submit your own period");
    if (!["OPEN", "DRAFT"].includes(row.status)) {
      throw new ConflictException("Only open or draft periods can be submitted");
    }

    const settings = await this.reader.getSettings(u.orgId);
    const requiredFields = parseStoredRequiredFields(settings?.requiredFields);

    const periodEntries = await this.db.query.timesheets.findMany({
      where: and(
        eq(timesheets.timesheetPeriodId, periodId),
        eq(timesheets.orgId, u.orgId),
        isNull(timesheets.voidedAt),
      ),
    });

    for (const entry of periodEntries) {
      if (requiredFields.includes("description") && !entry.description) {
        throw new BadRequestException(`Entry ${entry.id} is missing a required description`);
      }
      if (requiredFields.includes("project") && !entry.projectId && !entry.ticketId) {
        throw new BadRequestException(`Entry ${entry.id} is missing a required project`);
      }
    }

    const approverMembershipId = await this.resolveApproverMembershipId(u.orgId, periodEntries);

    await this.entries.recomputePeriodTotals(u.orgId, periodId);

    const owners = await membershipUserIds(this.db, u.orgId, [row.userMembershipId]);
    const ownerUserId = periodOwnerUserIdOrWarn(owners, row.userMembershipId, {
      orgId: u.orgId,
      periodId,
      operation: "submit",
    });

    const submittedAt = new Date();
    await this.db.transaction(async (tx) => {
      const [transition] = await tx
        .update(timesheetPeriods)
        .set({
          status: "SUBMITTED",
          submittedAt,
          currentApproverMembershipId: approverMembershipId,
          eventSeq: sql`${timesheetPeriods.eventSeq} + 1`,
          updatedAt: submittedAt,
        })
        .where(and(eq(timesheetPeriods.id, periodId), eq(timesheetPeriods.orgId, u.orgId)))
        .returning(LIFECYCLE_RETURNING);

      await tx
        .update(timesheets)
        .set({ submittedAt: new Date(), updatedAt: new Date() })
        .where(and(
          eq(timesheets.timesheetPeriodId, periodId),
          eq(timesheets.orgId, u.orgId),
          isNull(timesheets.voidedAt),
        ));

      await this.audit.record(tx, {
        orgId: u.orgId,
        actorMembershipId: actorMembId,
        entityType: "period",
        entityId: periodId.toString(),
        action: "period.submitted",
        after: { status: "SUBMITTED" },
      });

      if (transition && ownerUserId) {
        await emitPeriodLifecycleEvent(tx, {
          eventType: TIMESHEET_LIFECYCLE_EVENTS.submitted,
          orgId: u.orgId,
          periodId,
          eventSeq: transition.eventSeq,
          occurredAt: submittedAt,
          payload: lifecyclePayload(u.orgId, periodId, transition, ownerUserId, u.userId, submittedAt, null),
        });
      }
    });

    const updated = await this.reader.getPeriodWithUser(u.orgId, periodId);
    if (!updated) throw new NotFoundException("Period not found after submit");
    return this.reader.mapPeriod(updated);
  }

  private async resolveApproverMembershipId(orgId: string, entries: { projectId: number | null; ticketId: number | null }[]): Promise<number | null> {
    const projectIds = entries
      .map((e) => e.projectId)
      .filter((id): id is number => id !== null);

    if (projectIds.length === 0) return null;

    const freq = new Map<number, number>();
    for (const id of projectIds) freq.set(id, (freq.get(id) ?? 0) + 1);
    const topId = [...freq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!topId) return null;

    const [proj] = await this.db
      .select({ managerMembershipId: projects.managerMembershipId })
      .from(projects)
      .where(and(eq(projects.id, topId), eq(projects.orgId, orgId), isNull(projects.deletedAt)))
      .limit(1);

    return proj?.managerMembershipId ?? null;
  }
}
