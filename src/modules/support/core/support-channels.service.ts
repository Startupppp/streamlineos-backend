import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { supportChannels, supportTickets, supportTicketMessages, users } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { SupportTicketsService } from "./support-tickets.service";
import type {
  CreateSupportChannelInput,
  InboundEmailInput,
  InboundSmsInput,
  InboundWhatsAppInput,
  ReplyMessageInput,
  SendChatMessageInput,
  StartChatSessionInput,
  UpdateSupportChannelInput,
} from "./dto/support.schemas";

type SupportChannelRow = typeof supportChannels.$inferSelect;
type InboundChannelType = "email" | "whatsapp" | "sms";

interface NormalizedInboundMessage {
  messageId: string;
  threadTicketId: number | null;
  bodyText: string;
  requesterContact: string;
  requesterName: string;
  subject?: string;
  attachments?: ReplyMessageInput["attachments"];
  sourceChannel: InboundChannelType;
}

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
    const inboundSecret = input.type === "chat" ? null : generateInboundSecret();
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
   * Verifies the inbound webhook secret for an org's channel of the given type
   * and returns the channel row (its config.ownerUserId attributes new tickets
   * created from this channel). Only the first active channel of that type per
   * org is used — this codebase doesn't yet route inbound messages by
   * recipient address/number, so multiple simultaneous channels of the same
   * type per org aren't disambiguated here.
   */
  async verifyInboundSecret(
    orgId: string,
    channelType: InboundChannelType,
    providedSecret: string | undefined,
  ): Promise<SupportChannelRow> {
    const channel = await this.db.query.supportChannels.findFirst({
      where: and(eq(supportChannels.orgId, orgId), eq(supportChannels.type, channelType), eq(supportChannels.isActive, true)),
    });
    if (!channel?.inboundSecret || !providedSecret || channel.inboundSecret !== providedSecret) {
      throw new UnauthorizedException("Invalid inbound webhook secret");
    }
    return channel;
  }

  async ingestInboundEmail(orgId: string, channel: SupportChannelRow, input: InboundEmailInput) {
    const threadTicket = input.inReplyTo
      ? await this.db.query.supportTickets.findFirst({
          where: and(eq(supportTickets.orgId, orgId), eq(supportTickets.sourceMessageId, input.inReplyTo)),
          columns: { id: true },
        })
      : null;

    return this.ingestInboundMessage(orgId, channel, {
      messageId: input.messageId,
      threadTicketId: threadTicket?.id ?? null,
      bodyText: input.bodyText,
      requesterContact: input.fromEmail,
      requesterName: input.fromName ?? input.fromEmail,
      subject: input.subject,
      attachments: input.attachments,
      sourceChannel: "email",
    });
  }

  /**
   * WhatsApp Business API delivers a real reply-context id (inReplyTo) when the
   * customer replies to a specific message — thread on that when present, same
   * as email's inReplyTo. Falls back to "most recent non-closed ticket from
   * this number" otherwise (e.g. the customer just sends a new message rather
   * than using WhatsApp's native reply-to gesture).
   */
  async ingestInboundWhatsApp(orgId: string, channel: SupportChannelRow, input: InboundWhatsAppInput) {
    const threadTicketId = input.inReplyTo
      ? (
          await this.db.query.supportTickets.findFirst({
            where: and(eq(supportTickets.orgId, orgId), eq(supportTickets.sourceMessageId, input.inReplyTo)),
            columns: { id: true },
          })
        )?.id ?? null
      : await this.findOpenTicketIdByContact(orgId, "whatsapp", input.from);

    return this.ingestInboundMessage(orgId, channel, {
      messageId: input.messageId,
      threadTicketId,
      bodyText: input.bodyText,
      requesterContact: input.from,
      requesterName: input.fromName ?? input.from,
      sourceChannel: "whatsapp",
    });
  }

  /**
   * SMS carriers (Twilio et al.) have no reply-context concept — every inbound
   * SMS is threaded onto the sender's most recent non-closed ticket on this
   * channel, or starts a new one if none exists.
   */
  async ingestInboundSms(orgId: string, channel: SupportChannelRow, input: InboundSmsInput) {
    const threadTicketId = await this.findOpenTicketIdByContact(orgId, "sms", input.from);

    return this.ingestInboundMessage(orgId, channel, {
      messageId: input.messageId,
      threadTicketId,
      bodyText: input.bodyText,
      requesterContact: input.from,
      requesterName: input.from,
      sourceChannel: "sms",
    });
  }

  private async findOpenTicketIdByContact(
    orgId: string,
    sourceChannel: InboundChannelType,
    requesterContact: string,
  ): Promise<number | null> {
    const ticket = await this.db.query.supportTickets.findFirst({
      where: and(
        eq(supportTickets.orgId, orgId),
        eq(supportTickets.sourceChannel, sourceChannel),
        eq(supportTickets.requesterEmail, requesterContact),
        eq(supportTickets.status, "OPEN"),
      ),
      columns: { id: true },
      orderBy: [desc(supportTickets.createdAt)],
    });
    return ticket?.id ?? null;
  }

  /**
   * Idempotent by sourceMessageId: replays of the same inbound message (common
   * with webhook retries) must never create a duplicate ticket or message.
   *
   * New tickets are attributed to the channel's configured `ownerUserId`
   * (an org member responsible for the shared inbox) since supportTickets.createdBy
   * is a required FK to a real user — there's no "system user" concept in
   * this codebase to fall back to instead. `requesterEmail` is reused to store
   * a phone number for whatsapp/sms channels — it's a plain text column with
   * no email-format validation at the DB layer, and adding a separate
   * "requesterPhone" column for this alone isn't worth a migration yet.
   */
  private async ingestInboundMessage(orgId: string, channel: SupportChannelRow, input: NormalizedInboundMessage) {
    const [existingByMessageId] = await this.db
      .select({ id: supportTicketMessages.id, ticketId: supportTicketMessages.ticketId })
      .from(supportTicketMessages)
      .innerJoin(supportTickets, eq(supportTicketMessages.ticketId, supportTickets.id))
      .where(
        and(
          eq(supportTicketMessages.sourceMessageId, input.messageId),
          eq(supportTickets.orgId, orgId),
        ),
      )
      .limit(1);
    if (existingByMessageId) {
      return { ticketId: existingByMessageId.ticketId, messageId: existingByMessageId.id, deduped: true };
    }

    if (input.threadTicketId) {
      const message = await this.tickets.addMessage(
        orgId,
        input.threadTicketId,
        null,
        { body: input.bodyText, isInternal: false, attachments: input.attachments },
        {
          channel: input.sourceChannel,
          messageId: input.messageId,
          contactEmail: input.requesterContact,
          contactName: input.requesterName,
        },
      );
      return { ticketId: input.threadTicketId, messageId: message.id, deduped: false };
    }

    const ownerUserId = typeof channel.config?.ownerUserId === "string" ? channel.config.ownerUserId : null;
    if (!ownerUserId) {
      throw new BadRequestException(
        `This ${input.sourceChannel} channel has no configured owner (config.ownerUserId) — cannot attribute new tickets`,
      );
    }
    const owner = await this.db.query.users.findFirst({
      where: eq(users.id, ownerUserId),
      columns: { id: true },
    });
    if (!owner) {
      throw new BadRequestException(`The ${input.sourceChannel} channel's configured owner is not a valid user`);
    }

    const ticket = await this.tickets.createTicket(
      orgId,
      ownerUserId,
      {
        title: (input.subject ?? `New ${input.sourceChannel} support request`).slice(0, 150),
        description: input.bodyText,
      },
      {
        channel: input.sourceChannel,
        messageId: input.messageId,
        requesterEmail: input.requesterContact,
        requesterName: input.requesterName,
      },
    );

    return { ticketId: ticket.id, messageId: null, deduped: false };
  }

  /**
   * Live chat has no server-to-server webhook secret model — requests come
   * directly from the visitor's browser. Instead of a shared secret, a random
   * per-conversation `sessionToken` is generated once and handed back to the
   * widget, which must present it on every subsequent call. The token is
   * stored in `sourceMessageId` (same column email/whatsapp/sms use for their
   * own threading identifiers) scoped by `sourceChannel = "chat"`.
   */
  async startChatSession(orgId: string, input: StartChatSessionInput) {
    const channel = await this.db.query.supportChannels.findFirst({
      where: and(eq(supportChannels.orgId, orgId), eq(supportChannels.type, "chat"), eq(supportChannels.isActive, true)),
    });
    if (!channel) throw new NotFoundException("Live chat is not enabled for this organization");

    const ownerUserId = typeof channel.config?.ownerUserId === "string" ? channel.config.ownerUserId : null;
    if (!ownerUserId) {
      throw new BadRequestException("This chat channel has no configured owner (config.ownerUserId)");
    }
    const owner = await this.db.query.users.findFirst({ where: eq(users.id, ownerUserId), columns: { id: true } });
    if (!owner) {
      throw new BadRequestException("The chat channel's configured owner is not a valid user");
    }

    const sessionToken = generateInboundSecret();
    const ticket = await this.tickets.createTicket(
      orgId,
      ownerUserId,
      { title: `Live chat with ${input.name}`.slice(0, 150), description: input.message },
      { channel: "chat", messageId: sessionToken, requesterEmail: input.email ?? null, requesterName: input.name },
    );

    return { ticketId: ticket.id, sessionToken };
  }

  private async findTicketBySessionToken(orgId: string, sessionToken: string) {
    const ticket = await this.db.query.supportTickets.findFirst({
      where: and(
        eq(supportTickets.orgId, orgId),
        eq(supportTickets.sourceChannel, "chat"),
        eq(supportTickets.sourceMessageId, sessionToken),
      ),
      columns: { id: true },
    });
    if (!ticket) throw new NotFoundException("Chat session not found");
    return ticket;
  }

  async sendChatMessage(orgId: string, sessionToken: string, input: SendChatMessageInput) {
    const ticket = await this.findTicketBySessionToken(orgId, sessionToken);
    const message = await this.tickets.addMessage(
      orgId,
      ticket.id,
      null,
      { body: input.body, isInternal: false },
      { channel: "chat" },
    );
    return { ticketId: ticket.id, messageId: message.id };
  }

  async getChatSession(orgId: string, sessionToken: string) {
    const ticket = await this.findTicketBySessionToken(orgId, sessionToken);
    const messages = await this.tickets.listPublicMessages(orgId, ticket.id);
    return { ticketId: ticket.id, messages };
  }
}

function generateInboundSecret(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
