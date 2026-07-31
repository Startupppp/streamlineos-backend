import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import {
  helpdeskTickets,
  hrHelpdeskComments,
  hrHelpdeskRouting,
  kbArticles,
  users,
} from "../../../db/schema";
import { AccessService } from "../../access/access.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { EmailService } from "../../email/email.service";
import type {
  AddCommentInput,
  CreateInput,
  ListInput,
  RoutingRuleInput,
  SuggestInput,
  UpdateTicketInput,
} from "./dto/hr-helpdesk.schemas";

@Injectable()
export class HrHelpdeskService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly email: EmailService,
    private readonly access: AccessService,
  ) {}

  async list(orgId: string, userId: string, isAdmin: boolean, filters: ListInput) {
    const conditions: SQL[] = [eq(helpdeskTickets.orgId, orgId)];

    if (filters.userId) {
      conditions.push(eq(helpdeskTickets.userId, filters.userId));
    } else if (!isAdmin) {
      conditions.push(eq(helpdeskTickets.userId, userId));
    }

    if (filters.status) conditions.push(eq(helpdeskTickets.status, filters.status));
    if (filters.category) conditions.push(eq(helpdeskTickets.category, filters.category));
    if (filters.assigneeId) conditions.push(eq(helpdeskTickets.assigneeId, filters.assigneeId));

    if (!isAdmin) {
      const confidentialFilter = or(
        eq(helpdeskTickets.isConfidential, false),
        eq(helpdeskTickets.userId, userId),
      );
      if (confidentialFilter) conditions.push(confidentialFilter);
    }

    const offset = (filters.page - 1) * filters.pageSize;

    const [rows, [countRow]] = await Promise.all([
      this.db
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
        .where(and(...conditions))
        .orderBy(desc(helpdeskTickets.createdAt))
        .limit(filters.pageSize)
        .offset(offset),
      this.db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(helpdeskTickets)
        .where(and(...conditions)),
    ]);

    const total = countRow?.count ?? 0;
    return {
      items: rows,
      total,
      page: filters.page,
      pageSize: filters.pageSize,
      totalPages: Math.ceil(total / filters.pageSize),
    };
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
      .where(eq(hrHelpdeskComments.ticketId, ticketId))
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

    const [ticket] = await this.db
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

    void this.dispatchNewTicketEmails(orgId, userId, body.title, body.category, body.priority ?? "MEDIUM").catch(() => {});

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
      columns: { id: true, userId: true, isConfidential: true },
    });
    if (!ticket) throw new NotFoundException("Ticket not found.");

    if (!isAdmin) throw new ForbiddenException("Only HR admins can update tickets.");

    const patch: Partial<typeof helpdeskTickets.$inferInsert> = {};
    if (body.status !== undefined) patch.status = body.status;
    if (body.assigneeId !== undefined) patch.assigneeId = body.assigneeId ?? null;
    if (body.priority !== undefined) patch.priority = body.priority;
    if (body.resolution !== undefined) patch.resolution = body.resolution ?? undefined;
    if (body.status === "DONE" && !patch.resolvedAt) patch.resolvedAt = new Date();

    const [updated] = await this.db
      .update(helpdeskTickets)
      .set(patch)
      .where(and(eq(helpdeskTickets.id, ticketId), eq(helpdeskTickets.orgId, orgId)))
      .returning();

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
    const pattern = `%${input.query}%`;

    const articles = await this.db
      .select({
        id: kbArticles.id,
        title: kbArticles.title,
        slug: kbArticles.slug,
        excerpt: kbArticles.excerpt,
        source: sql<string>`'article'`,
      })
      .from(kbArticles)
      .where(
        and(
          eq(kbArticles.orgId, orgId),
          eq(kbArticles.status, "published"),
          or(
            ilike(kbArticles.title, pattern),
            ilike(kbArticles.excerpt, pattern),
          ),
        ),
      )
      .orderBy(desc(kbArticles.updatedAt))
      .limit(5);

    const handbooks = await this.db
      .select({
        id: sql<number>`0`,
        title: sql<string>`${input.query}`,
        slug: sql<string>`''`,
        excerpt: sql<string>`''`,
        source: sql<string>`'handbook'`,
      })
      .from(kbArticles)
      .where(sql`false`)
      .limit(0);

    return { results: [...articles, ...handbooks].slice(0, 5) };
  }

  private async dispatchNewTicketEmails(
    orgId: string,
    creatorId: string,
    ticketTitle: string,
    category: string,
    priority: string,
  ) {
    const [hrMemberRows, [creator]] = await Promise.all([
      this.access.membersWithPermission(orgId, "hr:employees:manage"),
      this.db
        .select({ name: users.name })
        .from(users)
        .where(eq(users.id, creatorId))
        .limit(1),
    ]);

    if (hrMemberRows.length === 0) return;

    const hrUsers = await this.db
      .select({ email: users.email, name: users.name })
      .from(users)
      .where(inArray(users.id, hrMemberRows.map((m) => m.userId)));

    const creatorName = creator?.name ?? "Employee";

    await Promise.all(
      hrUsers
        .filter((u): u is { email: string; name: string | null } => u.email !== null)
        .map((u) =>
          this.email.sendHelpdeskTicketEmail(
            u.email,
            u.name ?? "HR",
            ticketTitle,
            category,
            priority,
            creatorName,
          ),
        ),
    );
  }
}
