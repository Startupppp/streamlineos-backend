import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import type { DbOrTx } from "../../../common/rbac/access-invalidate";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AuditService } from "../../../common/audit/audit.service";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { hrReportingManagerRequests, type ReportingManagerRequestStatus } from "../../../db/schema";
import { AccessService } from "../../access/access.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { ReportingLineService } from "../../directory/reporting-line.service";
import { ReportingRelationshipService } from "../../directory/reporting-relationship.service";
import { ReportingLineException, rethrowReportingLineWriteError } from "../../directory/reporting-line-errors";
import { relationshipsBetween, subjectEmployments } from "../../directory/reporting-line-queries";
import { REPORTING_LINE_ERROR_CODES as CODES, REPORTING_LINE_PERMISSIONS } from "../../directory/reporting-line.types";
import { orgBusinessDate } from "../time/attendance-business-date";
import { EMPLOYEES_VIEW_PERMISSION, resolveEmployeesScope } from "./employees-scope";
import { peopleByEmploymentIds, peopleByUserIds, searchManagerCandidates } from "./reporting-manager-people";
import {
  liveRequest,
  requestCursorBefore,
  requestOrder,
  requestPage,
  requestsFrom,
  scopedRequests,
  toHrRequests,
  toMyRequests,
  type RequestRow,
} from "./reporting-manager-requests-read";
import type {
  CreateReportingManagerRequestInput,
  HrReportingManagerRequest,
  ListMyReportingManagerRequestsInput,
  ListReportingManagerRequestsInput,
  MyManagerCandidatesQuery,
  MyReportingManagerRequest,
  RespondReportingManagerRequestInput,
  ReviewReportingManagerRequestInput,
} from "./dto/reporting-lines-requests.schemas";
import type { ManagerRef } from "./dto/reporting-lines-shared.schemas";

const OPEN: ReportingManagerRequestStatus[] = ["PENDING", "MORE_INFO_REQUIRED"];

const AUDIT = {
  CREATED: "hr.reporting_manager_request.created",
  CANCELLED: "hr.reporting_manager_request.cancelled",
  RESPONDED: "hr.reporting_manager_request.responded",
  REVIEWED: "hr.reporting_manager_request.reviewed",
} as const;

const DECISION_STATUS = {
  APPROVE: "APPROVED",
  REJECT: "REJECTED",
  CANCEL_DUPLICATE: "CANCELLED",
  REQUEST_INFO: "MORE_INFO_REQUIRED",
} as const;

const REVIEW_LINK = (requestId: string) => `/hr/employees/reporting-requests?request=${requestId}`;
const MY_LINK = "/settings";

/**
 * HRM-15 §7.5: an employee's request to correct their own reporting manager, and HR's decision on
 * it. A request never changes a line by itself; only an approval does, through the canonical
 * relationship service, so every PRD §6 rule and the D4 guard are re-run at decision time.
 */
/** Reviewers notified of one request; the review queue itself shows everyone past it. */
const REVIEWER_NOTIFICATION_CAP = 100;

@Injectable()
export class ReportingManagerRequestsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly dispatch: NotificationDispatchService,
    private readonly reportingLines: ReportingLineService,
    private readonly relationships: ReportingRelationshipService,
  ) {}

  async create(actor: CurrentUserContext, body: CreateReportingManagerRequestInput): Promise<MyReportingManagerRequest> {
    const orgId = actor.orgId;
    return runInTenantTransaction(
      this.db,
      async (tx) => {
        const [subject] = await subjectEmployments(tx, orgId, { userIds: [actor.userId] });
        if (!subject) throw new ReportingLineException(CODES.EMPLOYEE_NOT_FOUND, "You do not have an employment record in this organization.");
        const today = await orgBusinessDate(this.db, orgId);
        const current = (await relationshipsBetween(tx, orgId, [subject.employmentId], today, today)).find((line) => line.primary);
        const suggestedManagerEmploymentId = body.suggestedManagerUserId
          ? await this.eligibleManager(tx, orgId, actor.userId, body.suggestedManagerUserId)
          : null;

        let inserted: { id: string } | undefined;
        try {
          [inserted] = await tx
            .insert(hrReportingManagerRequests)
            .values({
              orgId,
              employeeEmploymentId: subject.employmentId,
              requestedByUserId: actor.userId,
              currentPrimaryLineId: current?.lineId ?? null,
              suggestedManagerEmploymentId,
              requestedEffectiveFrom: body.requestedEffectiveFrom ?? null,
              employeeReason: body.reason,
            })
            .returning({ id: hrReportingManagerRequests.id });
        } catch (error) {
          rethrowReportingLineWriteError(error);
        }
        if (!inserted) throw new NotFoundException("The request could not be recorded.");

        await this.audit.logCritical({
          action: AUDIT.CREATED,
          userId: actor.userId,
          orgId,
          targetType: "reporting_manager_request",
          targetId: inserted.id,
          metadata: { employmentId: subject.employmentId, currentPrimaryLineId: current?.lineId ?? null, suggestedManagerEmploymentId },
        });
        await this.notifyReviewers(tx, actor, inserted.id, "created");
        return this.mine(tx, actor, inserted.id);
      },
      { orgId },
    );
  }

  async listMine(actor: CurrentUserContext, query: ListMyReportingManagerRequestsInput) {
    const rows = await requestsFrom(this.db, actor.orgId)
      .where(
        and(
          eq(hrReportingManagerRequests.orgId, actor.orgId),
          eq(hrReportingManagerRequests.requestedByUserId, actor.userId),
          liveRequest,
          requestCursorBefore(query.cursor),
        ),
      )
      .orderBy(...requestOrder)
      .limit(query.limit + 1);
    return requestPage(rows, query.limit, (page) => toMyRequests(this.db, actor.orgId, page));
  }

  async cancelMine(actor: CurrentUserContext, requestId: string): Promise<MyReportingManagerRequest> {
    return runInTenantTransaction(
      this.db,
      async (tx) => {
        const row = await this.ownRow(tx, actor, requestId);
        await this.transition(tx, actor.orgId, row, OPEN, { status: "CANCELLED", resolvedAt: new Date() });
        await this.audit.logCritical({
          action: AUDIT.CANCELLED,
          userId: actor.userId,
          orgId: actor.orgId,
          targetType: "reporting_manager_request",
          targetId: requestId,
          metadata: { from: row.status },
        });
        return this.mine(tx, actor, requestId);
      },
      { orgId: actor.orgId },
    );
  }

  async respondMine(actor: CurrentUserContext, requestId: string, body: RespondReportingManagerRequestInput): Promise<MyReportingManagerRequest> {
    return runInTenantTransaction(
      this.db,
      async (tx) => {
        const row = await this.ownRow(tx, actor, requestId);
        await this.transition(tx, actor.orgId, row, ["MORE_INFO_REQUIRED"], { status: "PENDING", employeeReason: body.reason });
        await this.audit.logCritical({
          action: AUDIT.RESPONDED,
          userId: actor.userId,
          orgId: actor.orgId,
          targetType: "reporting_manager_request",
          targetId: requestId,
          before: { employeeReason: row.employeeReason },
          after: { employeeReason: body.reason },
        });
        await this.notifyReviewers(tx, actor, requestId, "responded");
        return this.mine(tx, actor, requestId);
      },
      { orgId: actor.orgId },
    );
  }

  async myCandidates(actor: CurrentUserContext, query: MyManagerCandidatesQuery): Promise<{ items: ManagerRef[] }> {
    return { items: await searchManagerCandidates(this.db, actor.orgId, { q: query.q, excludeUserIds: [actor.userId], limit: 20 }) };
  }

  async listForReview(actor: CurrentUserContext, query: ListReportingManagerRequestsInput) {
    const read = await resolveEmployeesScope(this.access, actor);
    const where = [
      ...(query.status ? [eq(hrReportingManagerRequests.status, query.status)] : []),
      ...[requestCursorBefore(query.cursor)].flatMap((clause) => (clause ? [clause] : [])),
    ];
    const rows = await scopedRequests(read, this.db, where, query.limit + 1);
    const today = await orgBusinessDate(this.db, actor.orgId);
    return requestPage(rows, query.limit, (page) => toHrRequests(this.db, actor.orgId, today, page));
  }

  async getForReview(actor: CurrentUserContext, requestId: string): Promise<HrReportingManagerRequest> {
    const row = await this.reviewRow(this.db, actor, requestId);
    const [request] = await toHrRequests(this.db, actor.orgId, await orgBusinessDate(this.db, actor.orgId), [row]);
    if (!request) throw new NotFoundException("Request not found.");
    return request;
  }

  async review(
    actor: CurrentUserContext,
    requestId: string,
    body: ReviewReportingManagerRequestInput,
  ): Promise<{ request: HrReportingManagerRequest; warnings: string[] }> {
    const orgId = actor.orgId;
    const outcome = await runInTenantTransaction(
      this.db,
      async (tx) => {
        const row = await this.reviewRow(tx, actor, requestId);
        if (row.requestedByUserId === actor.userId)
          throw new ReportingLineException(CODES.ELEVATED_AUTHORITY_REQUIRED, "You cannot decide your own reporting manager request.");
        const status = DECISION_STATUS[body.decision];
        const from: readonly ReportingManagerRequestStatus[] = body.decision === "REQUEST_INFO" ? ["PENDING"] : OPEN;
        if (!from.includes(row.status))
          throw new ReportingLineException(CODES.REQUEST_INVALID_TRANSITION, `A ${row.status.toLowerCase()} request cannot be changed this way.`);

        let warnings: string[] = [];
        let resolvedLineId: number | null = null;
        let managers: { incoming: string | null; outgoing: string | null } = { incoming: null, outgoing: null };
        if (body.decision === "APPROVE") {
          const managerUserId = body.managerUserId ?? (await this.suggestedManagerUserId(tx, orgId, row));
          if (!managerUserId)
            throw new ReportingLineException(CODES.MANAGER_NOT_FOUND, "Choose the manager this employee should report to.", { field: "managerUserId" });
          if (managerUserId === actor.userId)
            throw new ReportingLineException(CODES.ELEVATED_AUTHORITY_REQUIRED, "You cannot approve a request that makes you the manager.");
          const effectiveFrom = body.effectiveFrom ?? row.requestedEffectiveFrom ?? (await orgBusinessDate(this.db, orgId));
          const result = await this.relationships.setRelationships(tx, {
            orgId,
            actor,
            subjectEmploymentId: row.employeeEmploymentId,
            primaryManagerUserId: managerUserId,
            effectiveFrom,
            source: "EMPLOYEE_REQUEST",
            reason: body.reviewReason,
            requestId,
          });
          warnings = result.warnings;
          resolvedLineId = result.after.primary?.lineId ?? null;
          managers = { incoming: result.after.primary?.managerUserId ?? null, outgoing: result.before.primary?.managerUserId ?? null };
        }

        await this.transition(tx, orgId, row, from, {
          status,
          reviewerUserId: actor.userId,
          reviewReason: body.reviewReason,
          ...(status === "MORE_INFO_REQUIRED" ? {} : { resolvedAt: new Date(), resolvedLineId }),
        });
        await this.audit.logCritical({
          action: AUDIT.REVIEWED,
          userId: actor.userId,
          orgId,
          targetType: "reporting_manager_request",
          targetId: requestId,
          metadata: { decision: body.decision, from: row.status, to: status, resolvedLineId, warnings },
        });
        await this.notifyDecision(tx, actor, row, body.decision, managers);
        return { warnings };
      },
      { orgId },
    );
    return { request: await this.getForReview(actor, requestId), warnings: outcome.warnings };
  }

  private async eligibleManager(tx: DbOrTx, orgId: string, selfUserId: string, managerUserId: string): Promise<number> {
    if (managerUserId === selfUserId) throw new ReportingLineException(CODES.SELF_REFERENCE, "You cannot suggest yourself as your manager.");
    const check = (await this.reportingLines.checkManagers(orgId, [managerUserId], tx)).get(managerUserId);
    if (!check?.ok)
      throw new ReportingLineException(
        check?.reason === "manager-not-in-organization" || !check ? CODES.MANAGER_NOT_FOUND : CODES.MANAGER_NOT_ELIGIBLE,
        check?.message ?? "The suggested manager is not an active member of this organization.",
        { field: "suggestedManagerUserId" },
      );
    return check.managerEmploymentId;
  }

  private async suggestedManagerUserId(tx: DbOrTx, orgId: string, row: RequestRow): Promise<string | null> {
    if (row.suggestedManagerEmploymentId === null) return null;
    const person = (await peopleByEmploymentIds(tx, orgId, [row.suggestedManagerEmploymentId])).get(row.suggestedManagerEmploymentId);
    return person?.userId || null;
  }

  private async ownRow(tx: DbOrTx, actor: CurrentUserContext, requestId: string): Promise<RequestRow> {
    const [row] = await requestsFrom(tx, actor.orgId)
      .where(
        and(
          eq(hrReportingManagerRequests.orgId, actor.orgId),
          eq(hrReportingManagerRequests.id, requestId),
          eq(hrReportingManagerRequests.requestedByUserId, actor.userId),
          liveRequest,
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException("Request not found.");
    return row;
  }

  private async reviewRow(db: DbOrTx, actor: CurrentUserContext, requestId: string): Promise<RequestRow> {
    const read = await resolveEmployeesScope(this.access, actor);
    const [row] = await scopedRequests(read, db, [eq(hrReportingManagerRequests.id, requestId)], 1);
    if (!row) throw new NotFoundException("Request not found.");
    return row;
  }

  private async mine(tx: DbOrTx, actor: CurrentUserContext, requestId: string): Promise<MyReportingManagerRequest> {
    const [mapped] = await toMyRequests(tx, actor.orgId, [await this.ownRow(tx, actor, requestId)]);
    if (!mapped) throw new NotFoundException("Request not found.");
    return mapped;
  }

  /** Compare-and-set on status, so two reviewers deciding at once cannot both win. */
  private async transition(
    tx: DbOrTx,
    orgId: string,
    row: RequestRow,
    from: readonly ReportingManagerRequestStatus[],
    set: Partial<typeof hrReportingManagerRequests.$inferInsert>,
  ): Promise<void> {
    if (!from.includes(row.status))
      throw new ReportingLineException(CODES.REQUEST_INVALID_TRANSITION, `A ${row.status.toLowerCase()} request cannot be changed this way.`);
    const [updated] = await tx
      .update(hrReportingManagerRequests)
      .set({ ...set, updatedAt: new Date() })
      .where(
        and(
          eq(hrReportingManagerRequests.orgId, orgId),
          eq(hrReportingManagerRequests.id, row.id),
          inArray(hrReportingManagerRequests.status, [...from]),
        ),
      )
      .returning({ id: hrReportingManagerRequests.id });
    if (!updated) throw new ReportingLineException(CODES.REQUEST_INVALID_TRANSITION, "This request changed while you were looking at it. Reload it.");
  }

  /** One actionable notification per reviewer; the employee's free text never leaves the request. */
  private async notifyReviewers(tx: DbOrTx, actor: CurrentUserContext, requestId: string, kind: "created" | "responded"): Promise<void> {
    const reviewers = await this.access.membersWithPermission(actor.orgId, REPORTING_LINE_PERMISSIONS.REVIEW, { limit: REVIEWER_NOTIFICATION_CAP });
    const candidates = reviewers.map((member) => member.userId).filter((userId) => userId !== actor.userId);
    // Only a reviewer whose employees scope reaches this employee can open the request; an own-scoped
    // reviewer would be sent a link to a 404. The requester is never the reviewer, so "covers" is
    // "org-wide". ponytail: one cached permission resolve per reviewer, bounded by the cap; a batch
    // scope query belongs in AccessService if reviewer counts grow past it.
    const scopes = await Promise.all(candidates.map((userId) => this.access.resolveUserPermissions(actor.orgId, userId)));
    const targetUserIds = candidates.filter((_userId, index) => scopes[index]?.get(EMPLOYEES_VIEW_PERMISSION) === "all");
    if (targetUserIds.length === 0) return;
    const name = (await peopleByUserIds(tx, actor.orgId, [actor.userId])).get(actor.userId)?.name ?? "An employee";
    await this.dispatch.emit({
      eventKey: "hr.reporting_manager_request.created",
      orgId: actor.orgId,
      actorUserId: actor.userId,
      targetUserIds,
      entityType: "reporting_manager_request",
      entityId: requestId,
      title: kind === "created" ? "Reporting manager review requested" : "More information provided",
      message:
        kind === "created"
          ? `${name} asked HR to review their reporting manager.`
          : `${name} replied to your request for more information about their reporting manager.`,
      link: REVIEW_LINK(requestId),
      ...(kind === "created" ? { dedupeKey: `hr-rm-request:created:${requestId}` } : {}),
    });
  }

  private async notifyDecision(
    tx: DbOrTx,
    actor: CurrentUserContext,
    row: RequestRow,
    decision: ReviewReportingManagerRequestInput["decision"],
    managers: { incoming: string | null; outgoing: string | null },
  ): Promise<void> {
    const employeeUserId = row.employeeUserId;
    if (employeeUserId) {
      const verb = { APPROVE: "approved", REJECT: "declined", CANCEL_DUPLICATE: "closed as a duplicate", REQUEST_INFO: "needs more information" }[decision];
      await this.dispatch.emit({
        eventKey: "hr.reporting_manager_request.decided",
        orgId: actor.orgId,
        actorUserId: actor.userId,
        targetUserIds: [employeeUserId],
        entityType: "reporting_manager_request",
        entityId: row.id,
        title: "Reporting manager request updated",
        message: `Your reporting manager request was ${verb}.`,
        link: MY_LINK,
      });
    }
    if (decision !== "APPROVE") return;
    const recipients = [managers.incoming, managers.outgoing].filter(
      (userId): userId is string => userId !== null && userId !== "" && userId !== employeeUserId,
    );
    if (recipients.length === 0 || !employeeUserId) return;
    const name = (await peopleByUserIds(tx, actor.orgId, [employeeUserId])).get(employeeUserId)?.name ?? "An employee";
    await this.dispatch.emit({
      eventKey: "hr.reporting_line.changed_by_request",
      orgId: actor.orgId,
      actorUserId: actor.userId,
      targetUserIds: [...new Set(recipients)],
      entityType: "employee",
      entityId: employeeUserId,
      title: "Reporting line changed",
      message: `${name}'s reporting manager was changed by HR.`,
      link: `/hr/employees/${employeeUserId}`,
      dedupeKey: `hr-rm-request:line-changed:${row.id}`,
    });
  }
}
