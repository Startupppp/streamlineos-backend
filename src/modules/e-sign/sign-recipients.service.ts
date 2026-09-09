import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { signEnvelopes, signRecipients } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { SignAuditService } from "./sign-audit.service";
import { SignTokensService } from "./sign-tokens.service";
import { SignSettingsService } from "./sign-settings.service";
import { SMS_SENDER, type SmsSenderPort } from "./sms/sms-sender.port";
import { isEnvelopeEditable, isEnvelopeTerminal } from "./sign-state";
import type { CreateRecipientInput, UpdateRecipientInput } from "./dto/e-sign.schemas";
import type { RequestActorContext } from "../../common/audit/actor-context";


@Injectable()
export class SignRecipientsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: SignAuditService,
    private readonly tokens: SignTokensService,
    private readonly settings: SignSettingsService,
    @Inject(SMS_SENDER) private readonly sms: SmsSenderPort,
  ) {}

  private async loadEnvelope(orgId: string, envelopeId: number) {
    const envelope = await this.db.query.signEnvelopes.findFirst({
      where: and(eq(signEnvelopes.id, envelopeId), eq(signEnvelopes.orgId, orgId)),
    });
    if (!envelope) throw new NotFoundException("Envelope not found");
    return envelope;
  }

  /**
   * The organisation's own list, at last.
   *
   * `sign_org_settings.allowed_auth_methods` has been writable since SignOS
   * shipped and read by nothing. Its default is
   * `["email_link", "access_code", "otp_email"]` — precisely the three methods
   * that work — while the DTO enum accepted all eight, so a recipient could be
   * configured for `otp_sms`, `sso`, `passkey`, `kba` or `id_verification`, be
   * *required* to supply a phone number for the first of those, and then find
   * the envelope unsignable: `authenticate` answers "not yet supported" for
   * every one of them.
   *
   * Refusing at configuration time rather than at signing time is the whole
   * point. The failure moves from a customer holding a signing link to the
   * person setting the envelope up, who can still do something about it.
   */
  private async assertAuthMethodUsable(orgId: string, input: CreateRecipientInput): Promise<void> {
    const method = input.authMethod;
    if (!method || method === "email_link") return;

    const settings = await this.settings.getOrCreate(orgId);
    const allowed = settings.allowedAuthMethods ?? [];
    if (!allowed.includes(method)) {
      throw new BadRequestException(
        `Authentication method "${method}" is not enabled for this organisation. ` +
          `Enabled methods: ${allowed.join(", ") || "none"}.`,
      );
    }

    /**
     * Enabled is not the same as available. An organisation may have added
     * `otp_sms` to its list, but if this deployment has no SMS provider the
     * code can never be delivered — so the phone number is not requested
     * either, because requiring a field for a channel that cannot send is the
     * broken promise this replaces.
     */
    if (method === "otp_sms") {
      if (!this.sms.isConfigured()) {
        throw new BadRequestException(
          "SMS one-time codes are enabled for this organisation but no SMS provider is " +
            "configured in this environment, so the code could not be delivered.",
        );
      }
      if (!input.phone) {
        throw new BadRequestException("Phone number is required when SMS OTP authentication is selected");
      }
    }
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
    await this.assertAuthMethodUsable(orgId, input);

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

  async update(orgId: string, recipientId: number, input: UpdateRecipientInput, actor: RequestActorContext) {
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

  async remove(orgId: string, recipientId: number, actor: RequestActorContext) {
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
