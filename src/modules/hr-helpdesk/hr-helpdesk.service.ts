import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { helpdeskTickets, organizationMembers, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { EmailService } from "../email/email.service";
import type { CreateInput, ListInput } from "./dto/hr-helpdesk.schemas";

@Injectable()
export class HrHelpdeskService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly email: EmailService,
  ) {}

  list(orgId: string, userId: string, isAdmin: boolean, filters: ListInput) {
    const conditions = [eq(helpdeskTickets.orgId, orgId)];

    if (filters.userId) {
      conditions.push(eq(helpdeskTickets.userId, filters.userId));
    } else if (!isAdmin) {
      conditions.push(eq(helpdeskTickets.userId, userId));
    }

    if (filters.status) {
      conditions.push(eq(helpdeskTickets.status, filters.status));
    }

    return this.db
      .select()
      .from(helpdeskTickets)
      .where(and(...conditions))
      .orderBy(desc(helpdeskTickets.createdAt));
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

    if (existing) {
      throw new ConflictException("A ticket with this title already exists.");
    }

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
      })
      .returning();

    void this.dispatchNewTicketEmails(orgId, userId, body.title, body.category, body.priority ?? "MEDIUM").catch(
      () => {},
    );

    return ticket;
  }

  private async dispatchNewTicketEmails(
    orgId: string,
    creatorId: string,
    ticketTitle: string,
    category: string,
    priority: string,
  ) {
    const [hrMemberIds, [creator]] = await Promise.all([
      this.db
        .select({ userId: organizationMembers.userId })
        .from(organizationMembers)
        .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.role, "HR"))),
      this.db
        .select({ name: users.name })
        .from(users)
        .where(eq(users.id, creatorId))
        .limit(1),
    ]);

    if (hrMemberIds.length === 0) return;

    const hrUsers = await this.db
      .select({ email: users.email, name: users.name })
      .from(users)
      .where(inArray(users.id, hrMemberIds.map((m) => m.userId)));

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
