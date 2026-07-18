import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { signEnvelopes, signRecipients } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { SignAuditService } from "./sign-audit.service";
import { SignTokensService } from "./sign-tokens.service";
import { isEnvelopeEditable, isEnvelopeTerminal } from "./sign-state";
import type { CreateRecipientInput, UpdateRecipientInput } from "./dto/signos.schemas";

export interface SignActorContext {
  orgId: string;
  userId: string;
  ipAddress?: string;
  userAgent?: string;
}

@Injectable()
export class SignRecipientsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: SignAuditService,
    private readonly tokens: SignTokensService,
  ) {}

  private async loadEnvelope(orgId: string, envelopeId: number) {
    const envelope = await this.db.query.signEnvelopes.findFirst({
      where: and(eq(signEnvelopes.id, envelopeId), eq(signEnvelopes.orgId, orgId)),
    });
    if (!envelope) throw new NotFoundException("Envelope not found");
    return envelope;
  }

  private validateForCreate(input: CreateRecipientInput, routingMode: string): void {
    if (input.recipientType !== "in_person_host" && !input.email) {
      throw new BadRequestException("Email is required for this recipient unless in-person signing is used");
    }
    if ((input.authMethod === "otp_sms") && !input.phone) {
      throw new BadRequestException("Phone number is required when SMS OTP authentication is selected");
    }
    if (routingMode === "sequential" && !input.routingOrder) {
      throw new BadRequestException("Routing order is required for sequential envelopes");
    }
  }

  async add(orgId: string, envelopeId: number, input: CreateRecipientInput, actor: SignActorContext) {
    const envelope = await this.loadEnvelope(orgId, envelopeId);
    if (!isEnvelopeEditable(envelope.status)) {
      throw new ForbiddenException("Recipients can only be added to a draft envelope");
    }
    this.validateForCreate(input, envelope.routingMode);

    const [recipient] = await this.db
      .insert(signRecipients)
      .values({
        orgId,
        envelopeId,
        roleName: input.roleName,
        recipientType: input.recipientType,
        name: input.name,
        email: input.email,
        phone: input.phone,
        userId: input.userId,
        routingOrder: input.routingOrder,
        authMethod: input.authMethod,
        accessCodeHash: input.accessCode ? this.tokens.hash(input.accessCode) : null,
      })
      .returning();

    await this.audit.record({
      orgId,
      envelopeId,
      recipientId: recipient.id,
      actorType: "internal_user",
      actorUserId: actor.userId,
      eventType: "recipient_added",
      eventMessage: `Added recipient ${input.name} (${input.roleName})`,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });

    return recipient;
  }

  async update(orgId: string, recipientId: number, input: UpdateRecipientInput, actor: SignActorContext) {
    const recipient = await this.get(orgId, recipientId);
    const envelope = await this.loadEnvelope(orgId, recipient.envelopeId);

    if (recipient.status === "completed") {
      throw new ForbiddenException("A completed recipient cannot be modified");
    }
    if (!isEnvelopeEditable(envelope.status) && isEnvelopeTerminal(envelope.status)) {
      throw new ForbiddenException("This envelope can no longer be modified");
    }

    const patch: Partial<typeof signRecipients.$inferInsert> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.email !== undefined) patch.email = input.email;
    if (input.phone !== undefined) patch.phone = input.phone;
    if (input.roleName !== undefined) patch.roleName = input.roleName;
    if (input.routingOrder !== undefined) patch.routingOrder = input.routingOrder;
    if (input.authMethod !== undefined) patch.authMethod = input.authMethod;
    if (input.accessCode !== undefined) patch.accessCodeHash = this.tokens.hash(input.accessCode);

    const [updated] = await this.db
      .update(signRecipients)
      .set(patch)
      .where(and(eq(signRecipients.id, recipientId), eq(signRecipients.orgId, orgId)))
      .returning();

    await this.audit.record({
      orgId,
      envelopeId: recipient.envelopeId,
      recipientId,
      actorType: "internal_user",
      actorUserId: actor.userId,
      eventType: "recipient_updated",
      eventMessage: `Updated recipient ${updated.name}`,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });

    return updated;
  }

  async remove(orgId: string, recipientId: number, actor: SignActorContext) {
    const recipient = await this.get(orgId, recipientId);
    const envelope = await this.loadEnvelope(orgId, recipient.envelopeId);
    if (!isEnvelopeEditable(envelope.status)) {
      throw new ForbiddenException("Recipients can only be removed from a draft envelope");
    }

    await this.db.delete(signRecipients).where(eq(signRecipients.id, recipientId));

    await this.audit.record({
      orgId,
      envelopeId: recipient.envelopeId,
      actorType: "internal_user",
      actorUserId: actor.userId,
      eventType: "recipient_removed",
      eventMessage: `Removed recipient ${recipient.name}`,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });
  }

  async get(orgId: string, recipientId: number) {
    const recipient = await this.db.query.signRecipients.findFirst({
      where: and(eq(signRecipients.id, recipientId), eq(signRecipients.orgId, orgId)),
    });
    if (!recipient) throw new NotFoundException("Recipient not found");
    return recipient;
  }

  async listForEnvelope(orgId: string, envelopeId: number) {
    return this.db.query.signRecipients.findMany({
      where: and(eq(signRecipients.orgId, orgId), eq(signRecipients.envelopeId, envelopeId)),
      orderBy: (r, { asc }) => [asc(r.routingOrder), asc(r.id)],
      limit: 100,
    });
  }
}
