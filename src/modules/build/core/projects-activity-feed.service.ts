import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, isNull, lt } from "drizzle-orm";
import {
  organizationMembers,
  organizationPeople,
  projects,
  ticketActivityLog,
  tickets,
  users,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { assertProjectInOrg } from "./project-access";
import {
  buildCursorPage,
  decodeCursor,
} from "../../../common/pagination/cursor";
import {
  resolvePersonDisplayName,
  UNRESOLVED_MEMBER_NAME,
} from "../../../common/organization/person-display-name";

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
export class ProjectsActivityFeedService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async getProjectActivity(
    actor: CurrentUserContext,
    projectId: number,
    opts: { limit: number; cursor?: string },
  ) {
    const orgId = actor.orgId;
    await assertProjectInOrg(this.db, orgId, projectId);

    const position = decodeCursor(opts.cursor);
    const rawId = position !== null ? Number(position.sortValue) : NaN;
    const beforeId = isNaN(rawId) ? undefined : rawId;

    const conditions = [eq(ticketActivityLog.orgId, orgId)];
    if (beforeId !== undefined) {
      conditions.push(lt(ticketActivityLog.id, beforeId));
    }

    const rows = await this.db
      .select({
        id: ticketActivityLog.id,
        action: ticketActivityLog.action,
        fromValue: ticketActivityLog.fromValue,
        toValue: ticketActivityLog.toValue,
        createdAt: ticketActivityLog.createdAt,
        userMembershipId: ticketActivityLog.userMembershipId,
        ticketId: tickets.id,
        ticketTitle: tickets.title,
        ticketNumber: tickets.ticketNumber,
        projectKey: projects.key,
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
      .innerJoin(
        tickets,
        and(
          eq(tickets.id, ticketActivityLog.ticketId),
          eq(tickets.orgId, ticketActivityLog.orgId),
          eq(tickets.projectId, projectId),
          isNull(tickets.deletedAt),
        ),
      )
      .innerJoin(
        projects,
        and(
          eq(projects.id, projectId),
          eq(projects.orgId, orgId),
          isNull(projects.deletedAt),
        ),
      )
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
      ticketId: row.ticketId,
      ticketTitle: row.ticketTitle,
      ticketNumber: row.ticketNumber,
      projectKey: row.projectKey,
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
