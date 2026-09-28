import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  cycles,
  organizationMembers,
  organizationPeople,
  projects,
  ticketActivityLog,
  ticketCommentMentions,
  tickets,
  users,
} from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { logger } from "../../../../common/logger/logger.service";
import { NotificationsService } from "../../../notifications/notifications.service";
import { NotificationDispatchService } from "../../../notifications/notification-dispatch.service";
import { resolvePersonDisplayName } from "../../../../common/organization/person-display-name";
import { buildTicketHref, buildTicketKey } from "../lib/build-app-paths";
import { withSavepoint } from "../../../data-quality/savepoint";

type TicketActivityAction =
  (typeof ticketActivityLog.action.enumValues)[number];

interface TicketSnapshot {
  title: string;
  status: string;
  priority: string;
  assigneeId: string | null;
  dueDate: string | null;
  points: number | null;
  type: string;
  cycleId: number | null;
}

interface TicketChanges {
  title?: string;
  status?: string;
  priority?: string;
  assigneeId?: string | null;
  dueDate?: string | null;
  points?: number | null;
  type?: string;
  cycleId?: number | null;
}

interface ProcessMentionsInput {
  orgId: string;
  ticketId: number;
  ticketNumber: number;
  ticketTitle: string;
  projectId: number | null;
  commentId: number;
  content: string;
  authorId: string;
  authorName: string;
}

interface OrgUser {
  id: string;
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string;
}

function normalize(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  return str.length > 0 ? str : null;
}

function extractMentionTokens(content: string): string[] {
  const matches = content.match(/@([\w.+-]+(?:\s+[\w.+-]+)?)/g);
  if (!matches) return [];
  return matches
    .map((token) => token.slice(1).trim().toLowerCase())
    .filter(Boolean);
}

function matchMentionedUsers(content: string, orgUsers: OrgUser[]): OrgUser[] {
  const tokens = extractMentionTokens(content);
  if (tokens.length === 0) return [];

  const matched = new Map<string, OrgUser>();
  for (const user of orgUsers) {
    const candidates = [
      user.email.toLowerCase(),
      user.email.split("@")[0]?.toLowerCase() ?? "",
      (
        resolvePersonDisplayName({
          firstName: user.firstName,
          lastName: user.lastName,
          accountName: user.name,
          email: user.email,
        }) ?? ""
      ).toLowerCase(),
      `${user.firstName ?? ""}`.toLowerCase().trim(),
    ].filter(Boolean);

    if (tokens.some((token) => candidates.includes(token))) {
      matched.set(user.id, user);
    }
  }
  return Array.from(matched.values());
}

@Injectable()
export class ProjectsActivityService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly notifications: NotificationsService,
    private readonly dispatch: NotificationDispatchService,
  ) {}

  private async resolveMembershipId(
    orgId: string,
    userId: string | null,
  ): Promise<number | null> {
    if (!userId) return null;
    const [row] = await this.db
      .select({ id: organizationMembers.id })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.orgId, orgId),
          eq(organizationMembers.userId, userId),
        ),
      )
      .limit(1);
    return row?.id ?? null;
  }

  private async resolveTicketProjectId(
    orgId: string,
    ticketId: number,
  ): Promise<number | null> {
    const [row] = await this.db
      .select({ projectId: tickets.projectId })
      .from(tickets)
      .where(and(eq(tickets.orgId, orgId), eq(tickets.id, ticketId)))
      .limit(1);
    return row?.projectId ?? null;
  }

  async logTicketActivity(
    orgId: string,
    ticketId: number,
    userId: string | null,
    action: TicketActivityAction,
    fromValue?: string | null,
    toValue?: string | null,
  ): Promise<void> {
    const [userMembershipId, projectId] = await Promise.all([
      this.resolveMembershipId(orgId, userId),
      this.resolveTicketProjectId(orgId, ticketId),
    ]);
    await this.db.insert(ticketActivityLog).values({
      orgId,
      ticketId,
      projectId,
      userMembershipId,
      action,
      fromValue: fromValue ?? null,
      toValue: toValue ?? null,
    });
  }

  async logTicketFieldChanges(
    orgId: string,
    ticketId: number,
    userId: string,
    before: TicketSnapshot,
    changes: TicketChanges,
  ): Promise<void> {
    const entries: Array<{
      action: TicketActivityAction;
      from: string | null;
      to: string | null;
    }> = [];

    if (
      changes.title !== undefined &&
      normalize(changes.title) !== normalize(before.title)
    ) {
      entries.push({
        action: "title_changed",
        from: normalize(before.title),
        to: normalize(changes.title),
      });
    }
    if (
      changes.status !== undefined &&
      normalize(changes.status) !== normalize(before.status)
    ) {
      entries.push({
        action: "status_changed",
        from: normalize(before.status),
        to: normalize(changes.status),
      });
    }
    if (
      changes.priority !== undefined &&
      normalize(changes.priority) !== normalize(before.priority)
    ) {
      entries.push({
        action: "priority_changed",
        from: normalize(before.priority),
        to: normalize(changes.priority),
      });
    }
    if (
      changes.assigneeId !== undefined &&
      normalize(changes.assigneeId) !== normalize(before.assigneeId)
    ) {
      const ids = [before.assigneeId, changes.assigneeId].filter(
        (id): id is string => !!id,
      );
      const nameById = await this.resolveUserNames(orgId, ids);
      entries.push({
        action: "assignee_changed",
        from: before.assigneeId
          ? (nameById.get(before.assigneeId) ?? before.assigneeId)
          : null,
        to: changes.assigneeId
          ? (nameById.get(changes.assigneeId) ?? changes.assigneeId)
          : null,
      });
    }
    if (
      changes.dueDate !== undefined &&
      normalize(changes.dueDate) !== normalize(before.dueDate)
    ) {
      entries.push({
        action: "due_date_changed",
        from: normalize(before.dueDate),
        to: normalize(changes.dueDate),
      });
    }
    if (
      changes.points !== undefined &&
      normalize(changes.points) !== normalize(before.points)
    ) {
      entries.push({
        action: "estimate_changed",
        from: normalize(before.points),
        to: normalize(changes.points),
      });
    }
    if (
      changes.type !== undefined &&
      normalize(changes.type) !== normalize(before.type)
    ) {
      entries.push({
        action: "type_changed",
        from: normalize(before.type),
        to: normalize(changes.type),
      });
    }
    if (
      changes.cycleId !== undefined &&
      normalize(changes.cycleId) !== normalize(before.cycleId)
    ) {
      const cycleIds = [before.cycleId, changes.cycleId].filter(
        (id): id is number => id != null,
      );
      const cycleNameById = await this.resolveCycleNames(orgId, cycleIds);
      entries.push({
        action: "cycle_changed",
        from:
          before.cycleId != null
            ? (cycleNameById.get(before.cycleId) ?? String(before.cycleId))
            : null,
        to:
          changes.cycleId != null
            ? (cycleNameById.get(changes.cycleId) ?? String(changes.cycleId))
            : null,
      });
    }

    if (entries.length === 0) return;

    const [userMembershipId, projectId] = await Promise.all([
      this.resolveMembershipId(orgId, userId),
      this.resolveTicketProjectId(orgId, ticketId),
    ]);
    await this.db.insert(ticketActivityLog).values(
      entries.map((entry) => ({
        orgId,
        ticketId,
        projectId,
        userMembershipId,
        action: entry.action,
        fromValue: entry.from,
        toValue: entry.to,
      })),
    );
  }

  private async resolveUserNames(
    orgId: string,
    ids: string[],
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const unique = Array.from(new Set(ids));
    if (unique.length === 0) return map;

    const rows = await this.db
      .select({
        userId: organizationPeople.userId,
        displayName: organizationPeople.displayName,
        firstName: organizationPeople.firstName,
        lastName: organizationPeople.lastName,
        workEmail: organizationPeople.workEmail,
      })
      .from(organizationPeople)
      .where(
        and(
          eq(organizationPeople.organizationId, orgId),
          inArray(organizationPeople.userId, unique),
        ),
      );

    for (const row of rows) {
      if (!row.userId) continue;
      const name = resolvePersonDisplayName({
        displayName: row.displayName,
        firstName: row.firstName,
        lastName: row.lastName,
        email: row.workEmail,
      });
      if (name) map.set(row.userId, name);
    }

    const unresolved = unique.filter((id) => !map.has(id));
    if (unresolved.length === 0) return map;

    const membersOfOrg = this.db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(eq(organizationMembers.orgId, orgId));

    const accounts = await this.db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(
        and(inArray(users.id, unresolved), inArray(users.id, membersOfOrg)),
      );

    for (const account of accounts) {
      const name = resolvePersonDisplayName({
        accountName: account.name,
        email: account.email,
      });
      if (name) map.set(account.id, name);
    }
    return map;
  }

  private async resolveCycleNames(
    orgId: string,
    ids: number[],
  ): Promise<Map<number, string>> {
    const map = new Map<number, string>();
    const unique = Array.from(new Set(ids));
    if (unique.length === 0) return map;

    const rows = await this.db
      .select({ id: cycles.id, name: cycles.name })
      .from(cycles)
      .where(and(eq(cycles.orgId, orgId), inArray(cycles.id, unique), isNull(cycles.deletedAt)));

    for (const row of rows) {
      map.set(row.id, row.name);
    }
    return map;
  }

  async processCommentMentions(input: ProcessMentionsInput): Promise<void> {
    if (!input.content || !input.content.includes("@")) return;

    const tokens = extractMentionTokens(input.content);
    if (tokens.length === 0) return;

    const idRows = await this.db.execute(
      sql`SELECT uid FROM app.search_mention_user_ids(${tokens}) AS uid`,
    );
    const candidateIds = idRows.map((r) => String(r["uid"]));
    if (candidateIds.length === 0) return;

    const orgUsers = await this.db
      .select({
        id: users.id,
        name: users.name,
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(
        and(
          eq(organizationMembers.orgId, input.orgId),
          inArray(users.id, candidateIds),
        ),
      )
      .limit(20);

    const mentioned = matchMentionedUsers(input.content, orgUsers).filter(
      (user) => user.id !== input.authorId,
    );
    if (mentioned.length === 0) return;

    const mentionedUserIds = mentioned.map((u) => u.id);
    const memberRows = await this.db
      .select({
        id: organizationMembers.id,
        userId: organizationMembers.userId,
      })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.orgId, input.orgId),
          inArray(organizationMembers.userId, mentionedUserIds),
        ),
      );
    const membershipByUserId = new Map(memberRows.map((r) => [r.userId, r.id]));

    try {
      await withSavepoint(() =>
        this.db
          .insert(ticketCommentMentions)
          .values(
            mentioned.map((user) => ({
              orgId: input.orgId,
              commentId: input.commentId,
              mentionedUserId: user.id,
              mentionedUserMembershipId: membershipByUserId.get(user.id) ?? null,
            })),
          )
          .onConflictDoNothing(),
      );
    } catch (error) {
      logger.error("Failed to insert ticket comment mentions", { error });
      return;
    }

    let ticketLink: string | undefined;
    let ticketKey: string | undefined;
    if (input.projectId) {
      const [projectRow] = await this.db
        .select({ key: projects.key })
        .from(projects)
        .where(
          and(
            eq(projects.id, input.projectId),
            eq(projects.orgId, input.orgId),
            isNull(projects.deletedAt),
          ),
        )
        .limit(1);

      ticketKey = buildTicketKey(projectRow?.key, input.ticketNumber);
      ticketLink = buildTicketHref(input.projectId, ticketKey, input.commentId);
    }

    // REG-004: see projects-tickets-create.service.ts.
    await this.dispatch
      .emit({
        eventKey: "build.comment.mention",
        orgId: input.orgId,
        targetUserIds: mentioned.map((user) => user.id),
        entityType: "ticket",
        entityId: String(input.ticketId),
        title: "You were mentioned",
        message: `${input.authorName} mentioned you in a comment on "${input.ticketTitle}".`,
        link: ticketLink,
        metadata: {
          ticketId: input.ticketId,
          commentId: input.commentId,
          ticketKey: ticketKey ?? null,
        },
      })
      .catch((error: unknown) =>
        logger.error("Failed to notify mentioned users", { error }),
      );
  }
}
