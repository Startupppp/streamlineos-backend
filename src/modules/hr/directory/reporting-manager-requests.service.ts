import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
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
import { REPORTING_LINE_ERROR_CODES as CODES } from "../../directory/reporting-line.types";
import { orgBusinessDate } from "../time/attendance-business-date";
import { resolveEmployeesScope } from "./employees-scope";
import { searchManagerCandidates } from "./reporting-manager-people";
import {
  liveRequest,
  myRequest,
  ownRequestRow,
  requestCursorBefore,
  requestPage,
  requestsFrom,
  scopedRequests,
  suggestedManagerUserId,
  toHrRequests,
  toMyRequests,
  type RequestRow,
} from "./reporting-manager-requests-read";
import { notifyDecision, notifyReviewers } from "./reporting-manager-requests-notify";
import { transitionRequest } from "./reporting-manager-requests-transition";
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

/**
 * HRM-15 §7.5: an employee's request to correct their own reporting manager, and HR's decision on
 * it. A request never changes a line by itself; only an approval does, through the canonical
 * relationship service, so every PRD §6 rule and the D4 guard are re-run at decision time.
 */
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
        await notifyReviewers(this.access, this.dispatch, tx, actor, inserted.id, "created");
        return myRequest(tx, actor, inserted.id);
      },
      { orgId },
    );
  }

  async listMine(actor: CurrentUserContext, query: ListMyReportingManagerRequestsInput) {
    const rows = await requestsFrom(
      this.db,
      actor.orgId,
      and(
        eq(hrReportingManagerRequests.orgId, actor.orgId),
        eq(hrReportingManagerRequests.requestedByUserId, actor.userId),
        liveRequest,
        requestCursorBefore(query.cursor),
      ),
      query.limit + 1,
    );
    return requestPage(rows, query.limit, (page) => toMyRequests(this.db, actor.orgId, page));
  }

  async cancelMine(actor: CurrentUserContext, requestId: string): Promise<MyReportingManagerRequest> {
    return runInTenantTransaction(
      this.db,
      async (tx) => {
        const row = await ownRequestRow(tx, actor, requestId);
        await transitionRequest(tx, actor.orgId, row, OPEN, { status: "CANCELLED", resolvedAt: new Date() });
        await this.audit.logCritical({
          action: AUDIT.CANCELLED,
          userId: actor.userId,
          orgId: actor.orgId,
          targetType: "reporting_manager_request",
          targetId: requestId,
          metadata: { from: row.status },
        });
        return myRequest(tx, actor, requestId);
      },
      { orgId: actor.orgId },
    );
  }

  async respondMine(actor: CurrentUserContext, requestId: string, body: RespondReportingManagerRequestInput): Promise<MyReportingManagerRequest> {
    return runInTenantTransaction(
      this.db,
      async (tx) => {
        const row = await ownRequestRow(tx, actor, requestId);
        await transitionRequest(tx, actor.orgId, row, ["MORE_INFO_REQUIRED"], { status: "PENDING", employeeReason: body.reason });
        await this.audit.logCritical({
          action: AUDIT.RESPONDED,
          userId: actor.userId,
          orgId: actor.orgId,
          targetType: "reporting_manager_request",
          targetId: requestId,
          before: { employeeReason: row.employeeReason },
          after: { employeeReason: body.reason },
        });
        await notifyReviewers(this.access, this.dispatch, tx, actor, requestId, "responded");
        return myRequest(tx, actor, requestId);
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
          const managerUserId = body.managerUserId ?? (await suggestedManagerUserId(tx, orgId, row));
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

        await transitionRequest(tx, orgId, row, from, {
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
        await notifyDecision(this.dispatch, tx, actor, row, body.decision, managers);
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

  private async reviewRow(db: DbOrTx, actor: CurrentUserContext, requestId: string): Promise<RequestRow> {
    const read = await resolveEmployeesScope(this.access, actor);
    const [row] = await scopedRequests(read, db, [eq(hrReportingManagerRequests.id, requestId)], 1);
    if (!row) throw new NotFoundException("Request not found.");
    return row;
  }
}
