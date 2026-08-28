import { randomUUID } from "node:crypto";
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import {
  helpdeskTickets,
  hrHelpdeskComments,
  hrHelpdeskRouting,
  kbArticles,
  users,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import { buildCursorPage, decodeCursor } from "../../../common/pagination/cursor";
import { keysetBeforeId } from "../../../common/pagination/keyset";
import type {
  AddCommentInput,
  CreateInput,
  ListInput,
  RoutingRuleInput,
  SuggestInput,
  UpdateTicketInput,
} from "./dto/hr-helpdesk.schemas";

const HELPDESK_SEARCH_CAP = 500;
const KB_SUGGEST_CAP = 20;

@Injectable()
export class HrHelpdeskService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
  ) {}

  async list(orgId: string, userId: string, isAdmin: boolean, filters: ListInput) {
    const position = decodeCursor(filters.cursor);

    const baseConditions: SQL[] = [eq(helpdeskTickets.orgId, orgId)];

    if (!isAdmin) {
      baseConditions.push(eq(helpdeskTickets.userId, userId));
    } else if (filters.userId) {
      baseConditions.push(eq(helpdeskTickets.userId, filters.userId));
    }

    if (filters.status) baseConditions.push(eq(helpdeskTickets.status, filters.status));
    if (filters.category) baseConditions.push(eq(helpdeskTickets.category, filters.category));
    if (filters.assigneeId) baseConditions.push(eq(helpdeskTickets.assigneeId, filters.assigneeId));

    if (!isAdmin) {
      const confidentialFilter = or(
        eq(helpdeskTickets.isConfidential, false),
        eq(helpdeskTickets.userId, userId),
      );
      if (confidentialFilter) baseConditions.push(confidentialFilter);
    }

    if (filters.q) {
      const searchCondition = await this.ticketSearchCondition(filters.q, `%${filters.q}%`);
      baseConditions.push(searchCondition);
    }

    const conditions = and(...baseConditions);

    const keyset = position
      ? and(conditions, keysetBeforeId(helpdeskTickets.createdAt, helpdeskTickets.id, position))
      : conditions;

    const rows = await this.db
      .select({
        id: helpdeskTickets.id,
        orgId: helpdeskTickets.orgId,
        userId: helpdeskTickets.userId,
        title: helpdeskTickets.title,
        description: helpdeskTickets.description,
        category: helpdeskTickets.category,
        priority: helpdeskTickets.priority,
        status: helpdeskTickets.status,
        assigneeId: helpdeskTickets.assigneeId,
        isConfidential: helpdeskTickets.isConfidential,
        slaDueAt: helpdeskTickets.slaDueAt,
        resolvedAt: helpdeskTickets.resolvedAt,
        resolution: helpdeskTickets.resolution,
        createdAt: helpdeskTickets.createdAt,
        updatedAt: helpdeskTickets.updatedAt,
        authorName: users.name,
        authorImage: users.image,
      })
      .from(helpdeskTickets)
      .leftJoin(users, eq(users.id, helpdeskTickets.userId))
      .where(keyset)
      .orderBy(desc(helpdeskTickets.createdAt), desc(helpdeskTickets.id))
      .limit(filters.limit + 1);

    return buildCursorPage(rows, filters.limit, (row) => ({
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

  async getById(orgId: string, userId: string, isAdmin: boolean, ticketId: number) {
    const ticket = await this.db.query.helpdeskTickets.findFirst({
      where: and(eq(helpdeskTickets.id, ticketId), eq(helpdeskTickets.orgId, orgId)),
    });

    if (!ticket) throw new NotFoundException("Ticket not found.");

    if (ticket.isConfidential && !isAdmin && ticket.userId !== userId) {
      throw new ForbiddenException("Access denied.");
    }

    if (!isAdmin && ticket.userId !== userId) {
      throw new ForbiddenException("Access denied.");
    }

    const comments = await this.db
      .select({
        id: hrHelpdeskComments.id,
        body: hrHelpdeskComments.body,
        createdAt: hrHelpdeskComments.createdAt,
        authorId: hrHelpdeskComments.authorId,
        authorName: users.name,
        authorImage: users.image,
      })
      .from(hrHelpdeskComments)
      .leftJoin(users, eq(users.id, hrHelpdeskComments.authorId))
      .where(and(eq(hrHelpdeskComments.ticketId, ticketId), eq(hrHelpdeskComments.orgId, orgId)))
      .orderBy(hrHelpdeskComments.createdAt);

    return { ...ticket, comments };
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

    const isConfidential = body.isConfidential ?? body.category === "confidential";

    const routing = await this.db
      .select({ assigneeUserId: hrHelpdeskRouting.assigneeUserId })
      .from(hrHelpdeskRouting)
      .where(and(eq(hrHelpdeskRouting.orgId, orgId), eq(hrHelpdeskRouting.category, body.category)))
      .limit(1);

    const assigneeId = routing[0]?.assigneeUserId ?? null;

    const ticket = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(helpdeskTickets)
        .values({
          orgId,
          userId,
          title: body.title,
          description: body.description,
          category: body.category,
          priority: body.priority ?? "MEDIUM",
          status: "TODO",
          isConfidential,
          assigneeId,
        })
        .returning();

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
          priority: body.priority ?? "MEDIUM",
        },
        occurredAt: new Date(),
      });

      return row;
    });

    return ticket;
  }

  async updateTicket(
    orgId: string,
    userId: string,
    isAdmin: boolean,
    ticketId: number,
    body: UpdateTicketInput,
  ) {
    const ticket = await this.db.query.helpdeskTickets.findFirst({
      where: and(eq(helpdeskTickets.id, ticketId), eq(helpdeskTickets.orgId, orgId)),
      columns: { id: true, userId: true, isConfidential: true, assigneeId: true, status: true },
    });
    if (!ticket) throw new NotFoundException("Ticket not found.");

    if (!isAdmin) throw new ForbiddenException("Only HR admins can update tickets.");

    const patch: Partial<typeof helpdeskTickets.$inferInsert> = {};
    if (body.status !== undefined) patch.status = body.status;
    if (body.assigneeId !== undefined) patch.assigneeId = body.assigneeId ?? null;
    if (body.priority !== undefined) patch.priority = body.priority;
    if (body.resolution !== undefined) patch.resolution = body.resolution ?? undefined;
    if (body.status === "DONE" && !patch.resolvedAt) patch.resolvedAt = new Date();

    const assigneeChanged = body.assigneeId !== undefined && body.assigneeId !== ticket.assigneeId;
    const statusChanged = body.status !== undefined && body.status !== ticket.status;
    const newAssigneeId = body.assigneeId ?? null;

    const updated = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(helpdeskTickets)
        .set(patch)
        .where(and(eq(helpdeskTickets.id, ticketId), eq(helpdeskTickets.orgId, orgId)))
        .returning();

      if (!row) throw new NotFoundException("Ticket not found.");

      if (assigneeChanged && newAssigneeId) {
        await OutboxWriter.emit(tx, {
          eventId: randomUUID(),
          organizationId: orgId,
          aggregateType: "helpdesk_ticket",
          aggregateId: String(ticketId),
          aggregateVersion: Date.now(),
          eventType: "hr.helpdesk.ticket_assigned",
          payload: {
            ticketId,
            orgId,
            actorId: userId,
            assigneeId: newAssigneeId,
            title: row.title,
          },
          occurredAt: new Date(),
        });
      }

      if (statusChanged && body.status) {
        await OutboxWriter.emit(tx, {
          eventId: randomUUID(),
          organizationId: orgId,
          aggregateType: "helpdesk_ticket",
          aggregateId: String(ticketId),
          aggregateVersion: Date.now() + 1,
          eventType: "hr.helpdesk.ticket_status_changed",
          payload: {
            ticketId,
            orgId,
            actorId: userId,
            newStatus: body.status,
            title: row.title,
            ownerId: ticket.userId,
          },
          occurredAt: new Date(),
        });
      }

      return row;
    });

    return updated;
  }

  async addComment(
    orgId: string,
    userId: string,
    isAdmin: boolean,
    ticketId: number,
    body: AddCommentInput,
  ) {
    const ticket = await this.db.query.helpdeskTickets.findFirst({
      where: and(eq(helpdeskTickets.id, ticketId), eq(helpdeskTickets.orgId, orgId)),
      columns: { id: true, userId: true, isConfidential: true },
    });
    if (!ticket) throw new NotFoundException("Ticket not found.");

    if (!isAdmin && ticket.userId !== userId) throw new ForbiddenException("Access denied.");
    if (ticket.isConfidential && !isAdmin && ticket.userId !== userId) throw new ForbiddenException("Access denied.");

    const [comment] = await this.db
      .insert(hrHelpdeskComments)
      .values({ ticketId, orgId, authorId: userId, body: body.body })
      .returning();

    return comment;
  }

  listRoutingRules(orgId: string) {
    return this.db
      .select({
        id: hrHelpdeskRouting.id,
        category: hrHelpdeskRouting.category,
        assigneeUserId: hrHelpdeskRouting.assigneeUserId,
        assigneeName: users.name,
        assigneeImage: users.image,
        createdAt: hrHelpdeskRouting.createdAt,
      })
      .from(hrHelpdeskRouting)
      .leftJoin(users, eq(users.id, hrHelpdeskRouting.assigneeUserId))
      .where(eq(hrHelpdeskRouting.orgId, orgId))
      .orderBy(hrHelpdeskRouting.category);
  }

  async upsertRoutingRule(orgId: string, body: RoutingRuleInput) {
    const [rule] = await this.db
      .insert(hrHelpdeskRouting)
      .values({ orgId, category: body.category, assigneeUserId: body.assigneeUserId })
      .onConflictDoUpdate({
        target: [hrHelpdeskRouting.orgId, hrHelpdeskRouting.category],
        set: { assigneeUserId: body.assigneeUserId, updatedAt: new Date() },
      })
      .returning();
    return rule;
  }

  async deleteRoutingRule(orgId: string, ruleId: number) {
    const [deleted] = await this.db
      .delete(hrHelpdeskRouting)
      .where(and(eq(hrHelpdeskRouting.id, ruleId), eq(hrHelpdeskRouting.orgId, orgId)))
      .returning({ id: hrHelpdeskRouting.id });
    if (!deleted) throw new NotFoundException("Routing rule not found.");
    return { success: true };
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
