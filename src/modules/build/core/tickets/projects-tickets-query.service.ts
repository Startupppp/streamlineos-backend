import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, isNull, lt } from "drizzle-orm";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.types";
import { CacheService } from "../../../../common/cache/cache.service";
import { logSideEffectFailure } from "../../../../common/logger/side-effect";
import { AccessService } from "../../../access/access.service";
import { resolveValidTicketStatuses } from "./ticket-status.util";
import { ProjectsInvalidTicketStatusException } from "../../../../common/http/api-exceptions";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { BulkUpdateInput, RankTicketInput } from "../dto/projects.schemas";
import { rankTicket } from "./projects-tickets-rank-utils";
import { bulkMutateTickets } from "./build-ticket-bulk-mutation";
import { authorizeTicketMutation, lockProjectTicketMutation, readMutationTickets } from "../project-crud/project-access";
import { ProjectsWebhooksDispatchService } from "../webhooks/projects-webhooks-dispatch.service";
import { BuildAutomationRunnerService } from "../automation/build-automation-runner.service";
import { ProjectsActivityService } from "../activity/projects-activity.service";
import { NotificationDispatchService } from "../../../notifications/notification-dispatch.service";
import { ProjectsTicketsTransferService } from "./projects-tickets-transfer.service";
import { queryTickets } from "./projects-tickets-read.query";
import { assertTicketReadAccess } from "../project-crud/project-access";
import {
  buildCursorPage,
  decodeCursor,
} from "../../../../common/pagination/cursor";
import {
  organizationPeople,
  organizationMembers,
  ticketActivityLog,
  tickets,
  users,
} from "../../../../db/schema";
import {
  resolvePersonDisplayName,
  UNRESOLVED_MEMBER_NAME,
} from "../../../../common/organization/person-display-name";

const ACTION_LABELS: Record<string, string> = {
  created: "created this ticket",
  status_changed: "changed status",
  priority_changed: "changed priority",
  assignee_changed: "changed assignee",
  title_changed: "renamed the ticket",
  sprint_changed: "changed sprint",
  due_date_changed: "changed due date",
  comment_added: "added a comment",
  comment_updated: "edited a comment",
  comment_deleted: "deleted a comment",
  label_changed: "changed labels",
};

function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action.replace(/_/g, " ");
}

@Injectable()
export class ProjectsTicketsQueryService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly access: AccessService,
    private readonly webhooksDispatch: ProjectsWebhooksDispatchService,
    private readonly automationRunner: BuildAutomationRunnerService,
    private readonly activity: ProjectsActivityService,
    private readonly dispatch: NotificationDispatchService,
    private readonly transfer: ProjectsTicketsTransferService,
  ) {}

  async validateTicketStatus(projectId: number, orgId: string, status: string): Promise<void> {
    const valid = await resolveValidTicketStatuses(this.db, projectId, orgId);
    if (!valid.has(status)) throw new ProjectsInvalidTicketStatusException(status);
  }

  async bulkUpdate(actor: CurrentUserContext, projectId: number, body: BulkUpdateInput) {
    const result = await bulkMutateTickets(this.db, this.access, actor, projectId, body, {
      webhooksDispatch: this.webhooksDispatch,
      automationRunner: this.automationRunner,
      activity: this.activity,
      dispatch: this.dispatch,
      transfer: this.transfer,
    });
    await this.cache.invalidateNamespace(`build:analytics:${actor.orgId}`)
      .catch(logSideEffectFailure("analytics cache eviction", { orgId: actor.orgId, projectId }));
    return result;
  }

  async authorizeMutation(tx: Db, actor: CurrentUserContext, projectId: number, ticketIds: number[]) {
    const policy = await authorizeTicketMutation(tx, this.access, actor, projectId);
    await lockProjectTicketMutation(tx, actor.orgId, projectId);
    return readMutationTickets(tx, actor, projectId, ticketIds, policy);
  }

  async rankTicket(actor: CurrentUserContext, projectId: number, ticketId: number, body: RankTicketInput) {
    return rankTicket(this.db, this.cache, this.access, actor, projectId, ticketId, body, {
      webhooksDispatch: this.webhooksDispatch,
      automationRunner: this.automationRunner,
      activity: this.activity,
      dispatch: this.dispatch,
      transfer: this.transfer,
    });
  }

  async getSubtasks(
    u: CurrentUserContext,
    projectId: number,
    ticketId: number,
  ) {
    await assertTicketReadAccess(this.db, this.access, u, projectId, ticketId);
    return queryTickets(
      this.db,
      and(
        eq(tickets.parentTicketId, ticketId),
        eq(tickets.projectId, projectId),
        eq(tickets.orgId, u.orgId),
        isNull(tickets.deletedAt),
      ),
      [asc(tickets.rank), asc(tickets.id)],
      200,
    );
  }

  async getTicketActivity(
    actor: CurrentUserContext,
    projectId: number,
    ticketId: number,
    opts: { limit: number; cursor?: string },
  ) {
    await assertTicketReadAccess(this.db, this.access, actor, projectId, ticketId);
    const orgId = actor.orgId;

    const position = decodeCursor(opts.cursor);
    const rawId = position !== null ? Number(position.sortValue) : NaN;
    const beforeId = isNaN(rawId) ? undefined : rawId;

    const conditions = [
      eq(ticketActivityLog.ticketId, ticketId),
      eq(ticketActivityLog.orgId, orgId),
    ];
    if (beforeId !== undefined)
      conditions.push(lt(ticketActivityLog.id, beforeId));

    const rows = await this.db
      .select({
        id: ticketActivityLog.id,
        action: ticketActivityLog.action,
        fromValue: ticketActivityLog.fromValue,
        toValue: ticketActivityLog.toValue,
        createdAt: ticketActivityLog.createdAt,
        userMembershipId: ticketActivityLog.userMembershipId,
        personUserId: organizationPeople.userId,
        memberUserId: organizationMembers.userId,
        displayName: organizationPeople.displayName,
        firstName: organizationPeople.firstName,
        lastName: organizationPeople.lastName,
        avatarUrl: organizationPeople.avatarUrl,
        accountName: users.name,
        email: users.email,
        userImage: users.image,
      })
      .from(ticketActivityLog)
      .leftJoin(
        organizationMembers,
        and(
          eq(organizationMembers.orgId, ticketActivityLog.orgId),
          eq(organizationMembers.id, ticketActivityLog.userMembershipId),
        ),
      )
      .leftJoin(users, eq(users.id, organizationMembers.userId))
      .leftJoin(
        organizationPeople,
        and(
          eq(organizationPeople.organizationId, ticketActivityLog.orgId),
          isNull(organizationPeople.deletedAt),
          eq(organizationPeople.userId, organizationMembers.userId),
        ),
      )
      .where(and(...conditions))
      .orderBy(desc(ticketActivityLog.id))
      .limit(opts.limit + 1);

    const mapped = rows.map((row) => ({
      id: row.id,
      action: row.action,
      label: actionLabel(row.action),
      fromValue: row.fromValue,
      toValue: row.toValue,
      createdAt: row.createdAt,
      user:
        row.userMembershipId !== null && row.userMembershipId !== undefined
          ? {
              id: row.personUserId ?? row.memberUserId ?? null,
              name: resolvePersonDisplayName(row) ?? UNRESOLVED_MEMBER_NAME,
              image: row.avatarUrl ?? row.userImage ?? null,
            }
          : null,
    }));

    return buildCursorPage(mapped, opts.limit, (r) => ({
      sortValue: String(r.id),
      id: String(r.id),
    }));
  }
}
