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
} from "../../../db/schema";
import { actingMembershipId } from "../../../common/auth/principal";
import { PeriodsReadService } from "./periods-read.service";
import { TimesheetsAuditService } from "./timesheets-audit.service";
import { EntriesService } from "./entries.service";
import { RateResolverService } from "./rate-resolver.service";
import { TimesheetApprovalRoutingService } from "./approval-routing.service";
import type { TimesheetApprovalMode, TimesheetApproverSource } from "./lib/approval-routing";
import type { PeriodApproverPreview } from "./dto/timesheets-approvals-response.schemas";
import { applyApproval } from "./lib/approval-transition";
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

const PERIOD_STATUSES_OPEN_TO_SUBMIT = ["OPEN", "DRAFT"] as const;

@Injectable()
export class PeriodsSubmitService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly reader: PeriodsReadService,
    private readonly entries: EntriesService,
    private readonly audit: TimesheetsAuditService,
    private readonly routing: TimesheetApprovalRoutingService,
    private readonly rateResolver: RateResolverService,
  ) {}

  async previewApprover(u: CurrentUserContext, periodId: number): Promise<PeriodApproverPreview> {
    const { entries: periodEntries, settings } = await this.ownedPeriodEntries(u, periodId, PERIOD_STATUSES_OPEN_TO_SUBMIT);
    const decision = await this.decideRoute(u, periodEntries, settings);
    return {
      kind: decision.kind,
      approver: decision.kind === "routed" ? decision.approver : null,
      route: decision.kind === "unowned" ? null : decision.route,
      dueAt: decision.kind === "routed" ? decision.dueAt.toISOString() : null,
      explanation: decision.kind === "unowned" ? decision.explanation : decision.route.explanation,
    };
  }

  async submitPeriod(u: CurrentUserContext, periodId: number) {
    const actorMembId = actingMembershipId(u.principal);
    if (actorMembId === null) throw new ForbiddenException("Submitting a timesheet requires a personal session");
    const { row, entries: periodEntries, settings } = await this.ownedPeriodEntries(u, periodId, PERIOD_STATUSES_OPEN_TO_SUBMIT);
    const requiredFields = parseStoredRequiredFields(settings?.requiredFields);

    for (const entry of periodEntries) {
      if (requiredFields.includes("description") && !entry.description) {
        throw new BadRequestException(`Entry ${entry.id} is missing a required description`);
      }
      if (requiredFields.includes("project") && !entry.projectId && !entry.ticketId) {
        throw new BadRequestException(`Entry ${entry.id} is missing a required project`);
      }
    }

    const decision = await this.decideRoute(u, periodEntries, settings);
    if (decision.kind === "unowned") {
      throw new ConflictException(`${decision.explanation} Ask an HR administrator to set a reporting manager or a timesheet approver before submitting.`);
    }
    const approverMembershipId = decision.kind === "routed" ? (decision.approver?.membershipId ?? null) : null;

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
          approvalRoute: decision.route,
          approvalDueAt: decision.kind === "routed" ? decision.dueAt : null,
          approvalEscalatedAt: null,
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
        after: {
          status: "SUBMITTED",
          approvalRoute: decision.route,
          currentApproverMembershipId: approverMembershipId,
        },
      });

      /**
       * In the transaction, so a submitted period can never exist without its
       * event and an event can never announce a submission that rolled back.
       * `transition` is absent only when the UPDATE matched nothing, which the
       * guards above have already ruled out — but a silent emit for a period
       * that was not updated would be worse than no emit, so it is checked.
       * `ownerUserId` is null only when the worker's membership no longer
       * resolves, which skips the event and not the submission.
       *
       * The approver's notification is sent by `PeriodsService.submitPeriod`
       * once this has committed.
       */
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

      if (decision.kind === "auto") {
        const lockAfterApproval = settings?.lockAfterApproval ?? true;
        await applyApproval(
          tx,
          { rateResolver: this.rateResolver, audit: this.audit },
          u,
          periodId,
          {
            approverActor: { membershipId: actorMembId },
            lockAfterApproval,
            emitCount: lockAfterApproval ? 2 : 1,
            ownerUserId,
            now: submittedAt,
          },
        );
      }
    });

    const updated = await this.reader.getPeriodWithUser(u.orgId, periodId);
    if (!updated) throw new NotFoundException("Period not found after submit");
    return { ...this.reader.mapPeriod(updated), notifyUserIds: decision.kind === "routed" ? (decision.approver ? [decision.approver.userId] : decision.queueUserIds) : [] };
  }

  private async ownedPeriodEntries(u: CurrentUserContext, periodId: number, allowedStatuses: readonly string[]) {
    const row = await this.reader.getPeriodWithUser(u.orgId, periodId);
    if (!row) throw new NotFoundException("Period not found");
    if (row.userMembershipId !== actingMembershipId(u.principal)) throw new ForbiddenException("You can only submit your own period");
    if (!allowedStatuses.includes(row.status)) throw new ConflictException("Only open or draft periods can be submitted");
    const settings = await this.reader.getSettings(u.orgId);
    const entries = await this.db.query.timesheets.findMany({
      where: and(eq(timesheets.timesheetPeriodId, periodId), eq(timesheets.orgId, u.orgId), isNull(timesheets.voidedAt)),
    });
    return { row, entries, settings };
  }

  private decideRoute(
    u: CurrentUserContext,
    periodEntries: ReadonlyArray<{ projectId: number | null }>,
    settings: { approvalMode: TimesheetApprovalMode; approverSource: TimesheetApproverSource } | undefined,
  ) {
    return this.routing.resolve({
      orgId: u.orgId,
      subjectUserId: u.userId,
      entries: periodEntries,
      settings: {
        approvalMode: settings?.approvalMode ?? "MANAGER",
        approverSource: settings?.approverSource ?? "REPORTING_MANAGER",
      },
    });
  }
}
