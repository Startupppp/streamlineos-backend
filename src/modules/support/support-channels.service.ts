import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { supportChannels, supportTickets, supportTicketMessages, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { SupportTicketsService } from "./support-tickets.service";
import type {
  CreateSupportChannelInput,
  InboundEmailInput,
  UpdateSupportChannelInput,
} from "./dto/support.schemas";

type SupportChannelRow = typeof supportChannels.$inferSelect;

@Injectable()
export class SupportChannelsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly tickets: SupportTicketsService,
  ) {}

  listChannels(orgId: string) {
    return this.db.query.supportChannels.findMany({
      where: eq(supportChannels.orgId, orgId),
    });
  }

  async createChannel(orgId: string, input: CreateSupportChannelInput) {
    const inboundSecret = input.type === "email" ? generateInboundSecret() : null;
    const [channel] = await this.db
      .insert(supportChannels)
      .values({
        orgId,
        type: input.type,
        name: input.name,
        config: input.config,
        isActive: input.isActive,
        inboundSecret,
      })
      .returning();
    return channel;
  }

  async updateChannel(orgId: string, id: number, input: UpdateSupportChannelInput) {
    const [updated] = await this.db
      .update(supportChannels)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(supportChannels.id, id), eq(supportChannels.orgId, orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Channel not found");
    return updated;
  }

  async deleteChannel(orgId: string, id: number) {
    const [deleted] = await this.db
      .delete(supportChannels)
      .where(and(eq(supportChannels.id, id), eq(supportChannels.orgId, orgId)))
      .returning();
    if (!deleted) throw new NotFoundException("Channel not found");
    return { success: true };
  }

  /**
   * Verifies the inbound webhook secret for an org's email channel and
   * returns the channel row (its config.ownerUserId attributes new tickets
   * created from this channel — see ingestInboundEmail). Only the first
   * active email channel per org is used — this codebase doesn't yet route
   * inbound email by recipient address, so multiple simultaneous email
   * channels per org aren't disambiguated here.
   */
  async verifyInboundSecret(orgId: string, providedSecret: string | undefined): Promise<SupportChannelRow> {
    const channel = await this.db.query.supportChannels.findFirst({
      where: and(eq(supportChannels.orgId, orgId), eq(supportChannels.type, "email"), eq(supportChannels.isActive, true)),
    });
    if (!channel?.inboundSecret || !providedSecret || channel.inboundSecret !== providedSecret) {
      throw new UnauthorizedException("Invalid inbound webhook secret");
    }
    return channel;
  }

  /**
   * Idempotent by sourceMessageId: replays of the same inbound email (common
   * with webhook retries) must never create a duplicate ticket or message.
   *
   * New tickets are attributed to the channel's configured `ownerUserId`
   * (an org member responsible for the shared inbox) since supportTickets.createdBy
   * is a required FK to a real user — there's no "system user" concept in
   * this codebase to fall back to instead.
   */
  async ingestInboundEmail(orgId: string, channel: SupportChannelRow, input: InboundEmailInput) {
    const existingByMessageId = await this.db.query.supportTicketMessages.findFirst({
      where: eq(supportTicketMessages.sourceMessageId, input.messageId),
      columns: { id: true, ticketId: true },
    });
    if (existingByMessageId) {
      return { ticketId: existingByMessageId.ticketId, messageId: existingByMessageId.id, deduped: true };
    }

    const contactName = input.fromName ?? input.fromEmail;
    const threadTicket = input.inReplyTo
      ? await this.db.query.supportTickets.findFirst({
          where: and(eq(supportTickets.orgId, orgId), eq(supportTickets.sourceMessageId, input.inReplyTo)),
          columns: { id: true },
        })
      : null;

    if (threadTicket) {
      const message = await this.tickets.addMessage(
        orgId,
        threadTicket.id,
        null,
        { body: input.bodyText, isInternal: false, attachments: input.attachments },
        { channel: "email", messageId: input.messageId, contactEmail: input.fromEmail, contactName },
      );
      return { ticketId: threadTicket.id, messageId: message.id, deduped: false };
    }

    const ownerUserId = typeof channel.config?.ownerUserId === "string" ? channel.config.ownerUserId : null;
    if (!ownerUserId) {
      throw new BadRequestException(
        "This email channel has no configured owner (config.ownerUserId) — cannot attribute new tickets",
      );
    }
    const owner = await this.db.query.users.findFirst({
      where: eq(users.id, ownerUserId),
      columns: { id: true },
    });
    if (!owner) {
      throw new BadRequestException("The email channel's configured owner is not a valid user");
    }

    const ticket = await this.tickets.createTicket(
      orgId,
      ownerUserId,
      {
        title: (input.subject ?? "New email support request").slice(0, 150),
        description: input.bodyText,
      },
      {
        channel: "email",
        messageId: input.messageId,
        requesterEmail: input.fromEmail,
        requesterName: contactName,
      },
    );

    return { ticketId: ticket.id, messageId: null, deduped: false };
  }
}

function generateInboundSecret(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
