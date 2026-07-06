import { Inject, Injectable } from "@nestjs/common";
import { inArray } from "drizzle-orm";
import { users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { EmailService } from "../email/email.service";
import type { TicketEscalationLevel } from "../email/templates";

type Contact = { id: string; email: string; name: string | null };

@Injectable()
export class SupportNotificationsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly email: EmailService,
  ) {}

  private loadContacts(ids: string[]): Promise<Contact[]> {
    const unique = Array.from(new Set(ids));
    return this.db
      .select({ id: users.id, email: users.email, name: users.name })
      .from(users)
      .where(inArray(users.id, unique));
  }

  async sendAssignmentEmail(
    assigneeId: string,
    actorId: string,
    title: string,
    priority: string,
    ticketId: number,
    actorFallback: string,
  ): Promise<void> {
    const people = await this.loadContacts([assigneeId, actorId]);
    const assignee = people.find((p) => p.id === assigneeId);
    if (!assignee?.email) return;

    const actor = people.find((p) => p.id === actorId);
    await this.email.sendSupportTicketCreatedEmail(
      assignee.email,
      assignee.name ?? "Team Member",
      title,
      priority,
      actor?.name ?? actorFallback,
      ticketId,
    );
  }

  async sendStatusEmail(
    creatorId: string,
    actorId: string,
    title: string,
    ticketId: number,
    status: string,
  ): Promise<void> {
    const people = await this.loadContacts([creatorId, actorId]);
    const creator = people.find((p) => p.id === creatorId);
    if (!creator?.email) return;

    const actor = people.find((p) => p.id === actorId);
    await this.email.sendSupportTicketStatusEmail(
      creator.email,
      creator.name ?? "User",
      title,
      ticketId,
      status,
      actor?.name ?? "Support",
    );
  }

  async sendReplyEmail(
    ticket: { title: string; createdBy: string; assigneeId: string | null },
    ticketId: number,
    authorId: string,
    body: string,
  ): Promise<void> {
    const notifyUserId = authorId === ticket.createdBy ? ticket.assigneeId : ticket.createdBy;
    if (!notifyUserId) return;

    const people = await this.loadContacts([notifyUserId, authorId]);
    const recipient = people.find((p) => p.id === notifyUserId);
    if (!recipient?.email) return;

    const author = people.find((p) => p.id === authorId);
    await this.email.sendSupportTicketReplyEmail(
      recipient.email,
      recipient.name ?? "User",
      ticket.title,
      ticketId,
      author?.name ?? "Team Member",
      body,
    );
  }

  async sendEscalationEmail(
    recipientId: string,
    ticketTitle: string,
    ticketId: number,
    escalationLevel: TicketEscalationLevel,
  ): Promise<void> {
    const [recipient] = await this.loadContacts([recipientId]);
    if (!recipient?.email) return;

    await this.email.sendSupportTicketEscalationEmail(
      recipient.email,
      recipient.name ?? "Team Member",
      ticketTitle,
      ticketId,
      escalationLevel,
    );
  }
}
