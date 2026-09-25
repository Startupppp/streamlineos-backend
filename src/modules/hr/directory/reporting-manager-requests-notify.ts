import type { DbOrTx } from "../../../common/rbac/access-invalidate";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AccessService } from "../../access/access.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { REPORTING_LINE_PERMISSIONS } from "../../directory/reporting-line.types";
import { EMPLOYEES_VIEW_PERMISSION } from "./employees-scope";
import { peopleByUserIds } from "./reporting-manager-people";
import type { RequestRow } from "./reporting-manager-requests-read";
import type { ReviewReportingManagerRequestInput } from "./dto/reporting-lines-requests.schemas";

const REVIEW_LINK = (requestId: string) => `/hr/employees/reporting-requests?request=${requestId}`;
const MY_LINK = "/settings";


/** Reviewers notified of one request; the review queue itself shows everyone past it. */
const REVIEWER_NOTIFICATION_CAP = 100;

/** One actionable notification per reviewer; the employee's free text never leaves the request. */
export async function notifyReviewers(access: AccessService, dispatch: NotificationDispatchService, tx: DbOrTx, actor: CurrentUserContext, requestId: string, kind: "created" | "responded"): Promise<void> {
  const reviewers = await access.membersWithPermission(actor.orgId, REPORTING_LINE_PERMISSIONS.REVIEW, { limit: REVIEWER_NOTIFICATION_CAP });
  const candidates = reviewers.map((member) => member.userId).filter((userId) => userId !== actor.userId);
  // Only a reviewer whose employees scope reaches this employee can open the request; an own-scoped
  // reviewer would be sent a link to a 404. The requester is never the reviewer, so "covers" is
  // "org-wide". ponytail: one cached permission resolve per reviewer, bounded by the cap; a batch
  // scope query belongs in AccessService if reviewer counts grow past it.
  const scopes = await Promise.all(candidates.map((userId) => access.resolveUserPermissions(actor.orgId, userId)));
  const targetUserIds = candidates.filter((_userId, index) => scopes[index]?.get(EMPLOYEES_VIEW_PERMISSION) === "all");
  if (targetUserIds.length === 0) return;
  const name = (await peopleByUserIds(tx, actor.orgId, [actor.userId])).get(actor.userId)?.name ?? "An employee";
  await dispatch.emit({
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

export async function notifyDecision(
  dispatch: NotificationDispatchService,
  tx: DbOrTx,
  actor: CurrentUserContext,
  row: RequestRow,
  decision: ReviewReportingManagerRequestInput["decision"],
  managers: { incoming: string | null; outgoing: string | null },
): Promise<void> {
  const employeeUserId = row.employeeUserId;
  if (employeeUserId) {
    const verb = { APPROVE: "approved", REJECT: "declined", CANCEL_DUPLICATE: "closed as a duplicate", REQUEST_INFO: "needs more information" }[decision];
    await dispatch.emit({
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
  await dispatch.emit({
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
