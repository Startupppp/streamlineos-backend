import { randomUUID } from "node:crypto";
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  helpdeskTickets,
  hrHelpdeskComments,
  kbArticles,
  users,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import {
  assertOrganizationActor,
  OrganizationActorError,
  organizationActorHttpError,
} from "../../../common/organization/organization-actor";
import { buildCursorPage, decodeCursor } from "../../../common/pagination/cursor";
import { keysetAfterId, keysetBeforeId, type KeysetPosition } from "../../../common/pagination/keyset";
import { HR_SCAN_MAX_PAGES, HR_SCAN_PAGE } from "../hr-read-limits";
import { HrAuditService } from "../core/hr-audit.service";
import type {
  AddCommentInput,
  CreateInput,
  ListInput,
  MyRequestsListInput,
  SuggestInput,
  UpdateTicketInput,
} from "./dto/hr-helpdesk.schemas";
import { HrHelpdeskConfigService } from "./hr-helpdesk-config.service";
import {
  canReadTicket,
  canWorkTicket,
  defaultConfidentiality,
  resolveQueue,
  stampSla,
  type SupportActor,
} from "./lib/support-queues";

const HELPDESK_SEARCH_CAP = 500;
const KB_SUGGEST_CAP = 20;

const assigneeUsers = alias(users, "helpdesk_assignee_users");

const ticketProjection = {
  id: helpdeskTickets.id,
  orgId: helpdeskTickets.orgId,
  userId: helpdeskTickets.userId,
  userMembershipId: helpdeskTickets.userMembershipId,
  title: helpdeskTickets.title,
  description: helpdeskTickets.description,
  category: helpdeskTickets.category,
  queue: helpdeskTickets.queue,
  priority: helpdeskTickets.priority,
  status: helpdeskTickets.status,
  assigneeId: helpdeskTickets.assigneeId,
  assigneeMembershipId: helpdeskTickets.assigneeMembershipId,
  assigneeName: assigneeUsers.name,
  isConfidential: helpdeskTickets.isConfidential,
  firstResponseDueAt: helpdeskTickets.firstResponseDueAt,
  firstRespondedAt: helpdeskTickets.firstRespondedAt,
  slaDueAt: helpdeskTickets.slaDueAt,
  escalatedAt: helpdeskTickets.escalatedAt,
  escalationLevel: helpdeskTickets.escalationLevel,
  resolvedAt: helpdeskTickets.resolvedAt,
  resolution: helpdeskTickets.resolution,
  createdAt: helpdeskTickets.createdAt,
  updatedAt: helpdeskTickets.updatedAt,
  authorName: users.name,
  authorImage: users.image,
};

@Injectable()
export class HrHelpdeskService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly config: HrHelpdeskConfigService,
    private readonly audit: HrAuditService,
  ) {}

  private visibleTo(actor: SupportActor): SQL {
    const queues = [...actor.queues];
    const memberOf = actor.isAdmin
      ? sql`true`
      : queues.length > 0
        ? inArray(helpdeskTickets.queue, queues)
        : sql`false`;
    const visible = or(
      eq(helpdeskTickets.userId, actor.userId),
      memberOf,
      eq(helpdeskTickets.isConfidential, false),
    );
    return visible ?? sql`false`;
  }

  async list(actor: SupportActor, filters: ListInput) {
    const baseConditions: SQL[] = [eq(helpdeskTickets.orgId, actor.orgId), this.visibleTo(actor)];

    if (filters.userId) baseConditions.push(eq(helpdeskTickets.userId, filters.userId));
    if (filters.status) baseConditions.push(eq(helpdeskTickets.status, filters.status));
    if (filters.category) baseConditions.push(eq(helpdeskTickets.category, filters.category));
    if (filters.queue) baseConditions.push(eq(helpdeskTickets.queue, filters.queue));
    if (filters.assigneeId) baseConditions.push(eq(helpdeskTickets.assigneeId, filters.assigneeId));
    if (filters.q) baseConditions.push(await this.ticketSearchCondition(filters.q, `%${filters.q}%`));

    return this.page(baseConditions, filters.cursor, filters.limit);
  }

  async listMine(orgId: string, userId: string, filters: MyRequestsListInput) {
    const baseConditions: SQL[] = [eq(helpdeskTickets.orgId, orgId), eq(helpdeskTickets.userId, userId)];
    if (filters.status) baseConditions.push(eq(helpdeskTickets.status, filters.status));
    return this.page(baseConditions, filters.cursor, filters.limit);
  }

  private async page(baseConditions: SQL[], cursor: string | undefined, limit: number) {
    const position = decodeCursor(cursor);
    const conditions = and(...baseConditions);
    const keyset = position
      ? and(conditions, keysetBeforeId(helpdeskTickets.createdAt, helpdeskTickets.id, position))
      : conditions;

    const rows = await this.db
      .select(ticketProjection)
      .from(helpdeskTickets)
      .leftJoin(users, eq(users.id, helpdeskTickets.userId))
      .leftJoin(assigneeUsers, eq(assigneeUsers.id, helpdeskTickets.assigneeId))
      .where(keyset)
      .orderBy(desc(helpdeskTickets.createdAt), desc(helpdeskTickets.id))
      .limit(limit + 1);

    return buildCursorPage(rows, limit, (row) => ({
      sortValue: row.createdAt.toISOString(),
      id: String(row.id),
    }));
  }

  private async ticketSearchCondition(term: string, like: string): Promise<SQL> {
    const fallback = sql`(${helpdeskTickets.title} ILIKE ${like} OR ${helpdeskTickets.description} ILIKE ${like})`;
    const rows = await this.db.execute(
      sql`SELECT app.search_helpdesk_ticket_ids(${term}, ${HELPDESK_SEARCH_CAP + 1}) AS id`,
    );
    if (rows.length === 0) return sql`false`;
    if (rows.length > HELPDESK_SEARCH_CAP) return fallback;
    const ids = rows.map((r) => Number(r["id"]));
    return inArray(helpdeskTickets.id, ids);
  }

  async getById(actor: SupportActor, ticketId: number) {
    const ticket = await this.loadTicketRow(actor.orgId, ticketId);
    if (!ticket || !canReadTicket(actor, ticket)) throw new NotFoundException("Ticket not found.");
    const comments = await this.scanComments(actor.orgId, ticketId);
    return { ...ticket, comments };
  }

  async getMine(orgId: string, userId: string, ticketId: number) {
    const ticket = await this.loadTicketRow(orgId, ticketId);
    if (!ticket || ticket.userId !== userId) throw new NotFoundException("Ticket not found.");
    const comments = await this.scanComments(orgId, ticketId);
    return { ...ticket, comments };
  }

  /**
   * A ticket thread is read whole — a comment silently dropped off the end reads as
   * nobody having answered. Walked in capped `(created_at, id)` keyset pages, the tie-breaker
   * being the primary key so a same-second pair can neither repeat nor be skipped.
   */
  private commentPage(orgId: string, ticketId: number, after: KeysetPosition | null) {
    return this.db
      .select({
        id: hrHelpdeskComments.id,
        ticketId: hrHelpdeskComments.ticketId,
        orgId: hrHelpdeskComments.orgId,
        body: hrHelpdeskComments.body,
        createdAt: hrHelpdeskComments.createdAt,
        authorId: hrHelpdeskComments.authorId,
        authorMembershipId: hrHelpdeskComments.authorMembershipId,
        authorName: users.name,
        authorImage: users.image,
      })
      .from(hrHelpdeskComments)
      .leftJoin(users, eq(users.id, hrHelpdeskComments.authorId))
      .where(
        and(
          eq(hrHelpdeskComments.ticketId, ticketId),
          eq(hrHelpdeskComments.orgId, orgId),
          ...(after
            ? [keysetAfterId(hrHelpdeskComments.createdAt, hrHelpdeskComments.id, after)]
            : []),
        ),
      )
      .orderBy(asc(hrHelpdeskComments.createdAt), asc(hrHelpdeskComments.id))
      .limit(HR_SCAN_PAGE);
  }

  private async scanComments(orgId: string, ticketId: number) {
    const comments: Awaited<ReturnType<HrHelpdeskService["commentPage"]>> = [];
    let after: KeysetPosition | null = null;
    for (let page = 0; page < HR_SCAN_MAX_PAGES; page++) {
      const chunk = await this.commentPage(orgId, ticketId, after);
      comments.push(...chunk);
      if (chunk.length < HR_SCAN_PAGE) break;
      const last = chunk[chunk.length - 1];
      after = { sortValue: last.createdAt, id: String(last.id) };
    }
    return comments;
  }

  private async loadTicketRow(orgId: string, ticketId: number) {
    const [row] = await this.db
      .select(ticketProjection)
      .from(helpdeskTickets)
      .leftJoin(users, eq(users.id, helpdeskTickets.userId))
      .leftJoin(assigneeUsers, eq(assigneeUsers.id, helpdeskTickets.assigneeId))
      .where(and(eq(helpdeskTickets.id, ticketId), eq(helpdeskTickets.orgId, orgId)))
      .limit(1);
    return row ?? null;
  }

  private async loadTicketDetail(orgId: string, ticketId: number) {
    const ticket = await this.loadTicketRow(orgId, ticketId);
    if (!ticket) throw new NotFoundException("Ticket not found.");
    const comments = await this.scanComments(orgId, ticketId);
    return { ...ticket, comments };
  }

  private async loadComment(orgId: string, commentId: number) {
    const [row] = await this.db
      .select({
        id: hrHelpdeskComments.id,
        ticketId: hrHelpdeskComments.ticketId,
        orgId: hrHelpdeskComments.orgId,
        authorId: hrHelpdeskComments.authorId,
        authorMembershipId: hrHelpdeskComments.authorMembershipId,
        body: hrHelpdeskComments.body,
        createdAt: hrHelpdeskComments.createdAt,
        authorName: users.name,
        authorImage: users.image,
      })
      .from(hrHelpdeskComments)
      .leftJoin(users, eq(users.id, hrHelpdeskComments.authorId))
      .where(and(eq(hrHelpdeskComments.id, commentId), eq(hrHelpdeskComments.orgId, orgId)))
      .limit(1);
    if (!row) throw new NotFoundException("Comment not found.");
    return row;
  }

  private async resolveMembershipId(orgId: string, userId: string): Promise<number> {
    try {
      const actor = await assertOrganizationActor(this.db, orgId, { kind: "user", userId });
      return actor.membershipId;
    } catch (e) {
      if (e instanceof OrganizationActorError) throw organizationActorHttpError(e);
      throw e;
    }
  }

  async create(orgId: string, userId: string, body: CreateInput) {
    const [existing] = await this.db
      .select({ id: helpdeskTickets.id })
      .from(helpdeskTickets)
      .where(
        and(
          eq(helpdeskTickets.orgId, orgId),
          eq(helpdeskTickets.userId, userId),
          sql`lower(trim(${helpdeskTickets.title})) = ${body.title.trim().toLowerCase()}`,
        ),
      )
      .limit(1);

    if (existing) throw new ConflictException("A ticket with this title already exists.");

    const rule = await this.config.routingRuleFor(orgId, body.category);
    const queue = resolveQueue(body.category, rule?.queue ?? null);
    const isConfidential = body.isConfidential ?? defaultConfidentiality(queue);
    const assigneeId = rule?.assigneeUserId ?? null;
    const assigneeMembershipId = assigneeId ? await this.resolveMembershipId(orgId, assigneeId) : null;
    const userMembershipId = await this.resolveMembershipId(orgId, userId);
    const sla = await this.config.slaFor(orgId, queue);
    const createdAt = new Date();
    const due = stampSla(createdAt, sla);
    const priority = body.priority ?? "MEDIUM";

    const ticketId = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(helpdeskTickets)
        .values({
          orgId,
          userId,
          userMembershipId,
          title: body.title,
          description: body.description,
          category: body.category,
          queue,
          priority,
          status: "TODO",
          isConfidential,
          assigneeId,
          assigneeMembershipId,
          firstResponseDueAt: due.firstResponseDueAt,
          slaDueAt: due.slaDueAt,
          createdAt,
          updatedAt: createdAt,
        })
        .returning({ id: helpdeskTickets.id });

      if (!row) throw new ConflictException("Failed to create ticket.");

      await OutboxWriter.emit(tx, {
        eventId: randomUUID(),
        organizationId: orgId,
        aggregateType: "helpdesk_ticket",
        aggregateId: String(row.id),
        aggregateVersion: Date.now(),
        eventType: "hr.helpdesk.ticket_created",
        payload: {
          ticketId: row.id,
          orgId,
          creatorId: userId,
          title: body.title,
          category: body.category,
          queue,
          priority,
          isConfidential,
        },
        occurredAt: createdAt,
      });

      await this.audit.log(
        {
          orgId,
          actorId: userId,
          actorMembershipId: userMembershipId,
          entityType: "helpdesk_ticket",
          entityId: String(row.id),
          action: "helpdesk.ticket.created",
          after: {
            queue,
            category: body.category,
            priority,
            isConfidential,
            assigneeId,
            firstResponseDueAt: due.firstResponseDueAt.toISOString(),
            slaDueAt: due.slaDueAt.toISOString(),
          },
        },
        tx,
      );

      return row.id;
    });

    return this.loadTicketDetail(orgId, ticketId);
  }

  async updateTicket(actor: SupportActor, ticketId: number, body: UpdateTicketInput) {
    const ticket = await this.db.query.helpdeskTickets.findFirst({
      where: and(eq(helpdeskTickets.id, ticketId), eq(helpdeskTickets.orgId, actor.orgId)),
      columns: {
        id: true,
        userId: true,
        queue: true,
        isConfidential: true,
        assigneeId: true,
        status: true,
        priority: true,
        firstRespondedAt: true,
      },
    });
    if (!ticket || !canReadTicket(actor, ticket)) throw new NotFoundException("Ticket not found.");
    if (!canWorkTicket(actor, ticket)) throw new ForbiddenException("Only members of this queue can update the request.");

    const now = new Date();
    const patch: Partial<typeof helpdeskTickets.$inferInsert> = { updatedAt: now };
    if (body.status !== undefined) patch.status = body.status;
    if (body.priority !== undefined) patch.priority = body.priority;
    if (body.queue !== undefined) patch.queue = body.queue;
    if (body.resolution !== undefined) patch.resolution = body.resolution ?? undefined;
    if (body.status === "DONE" && !patch.resolvedAt) patch.resolvedAt = now;
    if (body.status !== undefined && body.status !== "TODO" && ticket.firstRespondedAt === null)
      patch.firstRespondedAt = now;

    if (body.assigneeId !== undefined) {
      patch.assigneeId = body.assigneeId ?? null;
      patch.assigneeMembershipId = body.assigneeId
        ? await this.resolveMembershipId(actor.orgId, body.assigneeId)
        : null;
    }

    const assigneeChanged = body.assigneeId !== undefined && body.assigneeId !== ticket.assigneeId;
    const statusChanged = body.status !== undefined && body.status !== ticket.status;
    const newAssigneeId = body.assigneeId ?? null;

    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(helpdeskTickets)
        .set(patch)
        .where(and(eq(helpdeskTickets.id, ticketId), eq(helpdeskTickets.orgId, actor.orgId)))
        .returning({ id: helpdeskTickets.id, title: helpdeskTickets.title, userId: helpdeskTickets.userId });

      if (!row) throw new NotFoundException("Ticket not found.");

      if (assigneeChanged && newAssigneeId) {
        await OutboxWriter.emit(tx, {
          eventId: randomUUID(),
          organizationId: actor.orgId,
          aggregateType: "helpdesk_ticket",
          aggregateId: String(ticketId),
          aggregateVersion: Date.now(),
          eventType: "hr.helpdesk.ticket_assigned",
          payload: {
            ticketId,
            orgId: actor.orgId,
            actorId: actor.userId,
            assigneeId: newAssigneeId,
            title: row.title,
          },
          occurredAt: now,
        });
      }

      if (statusChanged && body.status) {
        await OutboxWriter.emit(tx, {
          eventId: randomUUID(),
          organizationId: actor.orgId,
          aggregateType: "helpdesk_ticket",
          aggregateId: String(ticketId),
          aggregateVersion: Date.now() + 1,
          eventType: "hr.helpdesk.ticket_status_changed",
          payload: {
            ticketId,
            orgId: actor.orgId,
            actorId: actor.userId,
            newStatus: body.status,
            title: row.title,
            ownerId: ticket.userId,
          },
          occurredAt: now,
        });
      }

      await this.audit.log(
        {
          orgId: actor.orgId,
          actorId: actor.userId,
          actorMembershipId: actor.membershipId,
          entityType: "helpdesk_ticket",
          entityId: String(ticketId),
          action: "helpdesk.ticket.updated",
          before: {
            status: ticket.status,
            priority: ticket.priority,
            queue: ticket.queue,
            assigneeId: ticket.assigneeId,
          },
          after: body,
        },
        tx,
      );
    });

    return this.loadTicketDetail(actor.orgId, ticketId);
  }

  async addComment(actor: SupportActor, ticketId: number, body: AddCommentInput) {
    const ticket = await this.db.query.helpdeskTickets.findFirst({
      where: and(eq(helpdeskTickets.id, ticketId), eq(helpdeskTickets.orgId, actor.orgId)),
      columns: { id: true, userId: true, queue: true, isConfidential: true, firstRespondedAt: true },
    });
    if (!ticket || !canReadTicket(actor, ticket)) throw new NotFoundException("Ticket not found.");
    const isRequester = ticket.userId === actor.userId;
    if (!isRequester && !canWorkTicket(actor, ticket))
      throw new ForbiddenException("Only members of this queue can respond to the request.");

    return this.insertComment(actor, ticket, body.body, !isRequester);
  }

  async addMyComment(orgId: string, userId: string, membershipId: number | null, ticketId: number, body: AddCommentInput) {
    const ticket = await this.db.query.helpdeskTickets.findFirst({
      where: and(eq(helpdeskTickets.id, ticketId), eq(helpdeskTickets.orgId, orgId)),
      columns: { id: true, userId: true, queue: true, isConfidential: true, firstRespondedAt: true },
    });
    if (!ticket || ticket.userId !== userId) throw new NotFoundException("Ticket not found.");
    return this.insertComment(
      { orgId, userId, membershipId, isAdmin: false, queues: new Set() },
      ticket,
      body.body,
      false,
    );
  }

  private async insertComment(
    actor: SupportActor,
    ticket: { id: number; firstRespondedAt: Date | null },
    text: string,
    countsAsResponse: boolean,
  ) {
    const now = new Date();
    const commentId = await this.db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(hrHelpdeskComments)
        .values({
          ticketId: ticket.id,
          orgId: actor.orgId,
          authorId: actor.userId,
          authorMembershipId: actor.membershipId,
          body: text,
          createdAt: now,
        })
        .returning({ id: hrHelpdeskComments.id });

      if (!inserted) throw new NotFoundException("Comment not found after insert.");

      if (countsAsResponse && ticket.firstRespondedAt === null) {
        await tx
          .update(helpdeskTickets)
          .set({ firstRespondedAt: now, updatedAt: now })
          .where(and(eq(helpdeskTickets.id, ticket.id), eq(helpdeskTickets.orgId, actor.orgId)));
      }

      await this.audit.log(
        {
          orgId: actor.orgId,
          actorId: actor.userId,
          actorMembershipId: actor.membershipId,
          entityType: "helpdesk_ticket",
          entityId: String(ticket.id),
          action: "helpdesk.ticket.commented",
          after: { commentId: inserted.id, firstResponse: countsAsResponse && ticket.firstRespondedAt === null },
        },
        tx,
      );

      return inserted.id;
    });

    return this.loadComment(actor.orgId, commentId);
  }

  async suggest(orgId: string, input: SuggestInput) {
    const term = input.query;
    const like = `%${term}%`;

    const fallback = and(
      eq(kbArticles.orgId, orgId),
      eq(kbArticles.status, "published"),
      or(
        sql`${kbArticles.title} ILIKE ${like}`,
        sql`${kbArticles.excerpt} ILIKE ${like}`,
      ),
    );

    const rows = await this.db.execute(
      sql`SELECT app.search_kb_article_ids(${term}, ${KB_SUGGEST_CAP + 1}) AS id`,
    );

    const articleWhere = rows.length === 0
      ? sql`false`
      : rows.length > KB_SUGGEST_CAP
      ? fallback
      : and(
          eq(kbArticles.orgId, orgId),
          eq(kbArticles.status, "published"),
          inArray(kbArticles.id, rows.map((r) => Number(r["id"]))),
        );

    const articles = await this.db
      .select({
        id: kbArticles.id,
        title: kbArticles.title,
        slug: kbArticles.slug,
        excerpt: kbArticles.excerpt,
        source: sql<string>`'article'`,
      })
      .from(kbArticles)
      .where(articleWhere)
      .orderBy(desc(kbArticles.updatedAt))
      .limit(5);

    return { results: articles.slice(0, 5) };
  }
}
