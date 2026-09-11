import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { signEnvelopes, signRecipients } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { SignAuditService } from "./sign-audit.service";
import { SignTokensService } from "./sign-tokens.service";
import { SignAuthMethodPolicy } from "./sign-auth-method.policy";
import { isEnvelopeEditable, isEnvelopeTerminal } from "./sign-state";
import type { CreateRecipientInput, UpdateRecipientInput } from "./dto/e-sign.schemas";
import type { RequestActorContext } from "../../common/audit/actor-context";


@Injectable()
export class SignRecipientsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: SignAuditService,
    private readonly tokens: SignTokensService,
    private readonly authMethods: SignAuthMethodPolicy,
  ) {}

  private async loadEnvelope(orgId: string, envelopeId: number) {
    const envelope = await this.db.query.signEnvelopes.findFirst({
      where: and(eq(signEnvelopes.id, envelopeId), eq(signEnvelopes.orgId, orgId)),
    });
    if (!envelope) throw new NotFoundException("Envelope not found");
    return envelope;
  }

  private validateForCreate(input: CreateRecipientInput, routingMode: string): void {
    /**
     * SIGN-P2-01. An in-person host needs an email like everybody else.
     *
     * The exemption that used to sit here read as support for an in-person
     * ceremony, and there is none: no host-led session route exists anywhere.
     * `in_person_host` is a signing type, so `computeEnvelopeStatusFromRecipients`
     * waits for it before the envelope can complete — while the dispatch loop
     * skips any recipient without an email (`shouldInviteNow && plan.email`).
     * So an emailless host was never invited, had no other way to reach a
     * signing session, and blocked the envelope forever. The envelope did not
     * fail; it simply never finished, which is worse.
     *
     * Until a host-led flow exists, the type is a LABEL on an otherwise
     * ordinary signing recipient. Labels do not change how someone is reached.
     */
    if (!input.email) {
      throw new BadRequestException("Email is required for this recipient");
    }
    if (routingMode === "sequential" && !input.routingOrder) {
      throw new BadRequestException("Routing order is required for sequential envelopes");
    }
  }

  async add(orgId: string, envelopeId: number, input: CreateRecipientInput, actor: RequestActorContext) {
    const envelope = await this.loadEnvelope(orgId, envelopeId);
    if (!isEnvelopeEditable(envelope.status)) {
      throw new ForbiddenException("Recipients can only be added to a draft envelope");
    }
    this.validateForCreate(input, envelope.routingMode);
    await this.authMethods.assertUsable(orgId, input.authMethod, input.phone);

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
        userMembershipId: input.userMembershipId,
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

  async update(orgId: string, recipientId: number, input: UpdateRecipientInput, actor: RequestActorContext) {
    const recipient = await this.get(orgId, recipientId);
    const envelope = await this.loadEnvelope(orgId, recipient.envelopeId);

    if (recipient.status === "completed") {
      throw new ForbiddenException("A completed recipient cannot be modified");
    }
    if (!isEnvelopeEditable(envelope.status) && isEnvelopeTerminal(envelope.status)) {
      throw new ForbiddenException("This envelope can no longer be modified");
    }

    /**
     * The same gate `add` runs, because this is the other way in.
     *
     * It was only on `add`, while `updateRecipientSchema` is
     * `createRecipientSchema.partial()` — the same eight-value enum. One PATCH
     * restored the state SIGN-P0-03/P0-04/P1-03 were written to end: a
     * recipient configured for a method `authenticate` refuses as "not yet
     * supported", found by the customer holding the link.
     *
     * Reachable later in the envelope's life than `add`, too. Adding a
     * recipient requires a draft; this refuses only terminal envelopes, and a
     * *sent* envelope is neither editable nor terminal — so the method could be
     * changed underneath someone already invited. Nothing downstream would have
     * caught it: `validateForSend` checks that an `otp_sms` recipient has a
     * phone number, never that the method is enabled or deliverable, and it
     * does not run again after the send.
     *
     * Only when the caller actually names the field. Running it on every PATCH
     * would fail a rename because of a value the caller never mentioned,
     * whenever the row predates the current allowlist.
     */
    if (input.authMethod !== undefined) {
      await this.authMethods.assertUsable(orgId, input.authMethod, input.phone ?? recipient.phone);
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

  async remove(orgId: string, recipientId: number, actor: RequestActorContext) {
    const recipient = await this.get(orgId, recipientId);
    const envelope = await this.loadEnvelope(orgId, recipient.envelopeId);
    if (!isEnvelopeEditable(envelope.status)) {
      throw new ForbiddenException("Recipients can only be removed from a draft envelope");
    }

    await this.db.delete(signRecipients).where(and(eq(signRecipients.id, recipientId), eq(signRecipients.orgId, orgId)));

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
