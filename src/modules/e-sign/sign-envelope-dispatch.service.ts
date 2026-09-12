import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { addDays } from "date-fns";
import { OutboxWriter } from "../../common/outbox/outbox-writer";
import { registerAfterCommit } from "../../common/tenant/tenant-context";
import { signEnvelopes, signRecipients } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { appUrl } from "../email/app-url";
import { SignAuditService } from "./sign-audit.service";
import { SignTokensService } from "./sign-tokens.service";
import { SignSettingsService } from "./sign-settings.service";
import { SignNotificationsService } from "./sign-notifications.service";
import { SignRecipientsService } from "./sign-recipients.service";
import { systemEnvelopeScope } from "./sign-envelope-scope";
import { findEnvelopeOrThrow, resolveSenderName } from "./sign-envelope-lookup";
import {
  SignEnvelopeInvitationsService,
  type InvitationDelivery,
  type InvitationPlan,
} from "./sign-envelope-invitations.service";
import { SignIntegrationsService } from "./sign-integrations.service";
import {
  SignEnvelopeValidationService,
  isSigningType,
} from "./sign-envelope-validation.service";
import {
  canTransitionEnvelope,
  computeEnvelopeStatusFromRecipients,
  isEnvelopeEditable,
  isEnvelopeSignable,
  nextEligibleRecipientIds,
  type SignEnvelopeStatus,
} from "./sign-state";
import type { RequestActorContext } from "../../common/audit/actor-context";

@Injectable()
export class SignEnvelopeDispatchService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: SignAuditService,
    private readonly tokens: SignTokensService,
    private readonly settings: SignSettingsService,
    private readonly notifications: SignNotificationsService,
    private readonly recipients: SignRecipientsService,
    private readonly integrations: SignIntegrationsService,
    private readonly validation: SignEnvelopeValidationService,
    private readonly invitations: SignEnvelopeInvitationsService,
  ) {}

  async send(
    orgId: string,
    envelopeId: number,
    actor: RequestActorContext,
    delivery: InvitationDelivery = "after_commit",
  ) {
    const envelope = await findEnvelopeOrThrow(this.db, orgId, envelopeId);
    if (!isEnvelopeEditable(envelope.status)) {
      throw new ForbiddenException("Only draft envelopes can be sent");
    }
    const validationResult = await this.validation.validate(orgId, envelopeId);
    if (!validationResult.valid) {
      throw new BadRequestException({
        message: "Envelope is not ready to send",
        errors: validationResult.errors,
      });
    }

    const orgSettings = await this.settings.getOrCreate(orgId);
    const expiresAt =
      envelope.expiresAt ?? addDays(new Date(), orgSettings.defaultExpirationDays);
    const finalizationKey = randomUUID();

    const recipientRows = await this.recipients.listForEnvelope(systemEnvelopeScope(orgId), null, envelopeId);
    const signingRecipients = recipientRows.filter((r) => isSigningType(r.recipientType));
    const inviteNowIds = new Set(
      nextEligibleRecipientIds(
        signingRecipients.map((r) => ({
          id: r.id,
          routingOrder: r.routingOrder,
          status: r.status,
        })),
      ),
    );
    const senderNameStr = await resolveSenderName(this.db, orgId, actor.membershipId);

    type SendPlan = {
      id: number;
      rawToken: string;
      tokenHash: string;
      shouldInviteNow: boolean;
      email: string | null;
      name: string;
    };

    const sendPlans: SendPlan[] = signingRecipients.map((recipient) => {
      const shouldInviteNow =
        envelope.routingMode !== "sequential" || inviteNowIds.has(recipient.id);
      const rawToken = this.tokens.generateSigningToken();
      return {
        id: recipient.id,
        rawToken,
        tokenHash: this.tokens.hash(rawToken),
        shouldInviteNow,
        email: recipient.email,
        name: recipient.name,
      };
    });
    const invitedCount = sendPlans.filter((p) => p.shouldInviteNow && p.email).length;

    const updated = await this.db.transaction(async (tx) => {
      for (const plan of sendPlans) {
        await tx
          .update(signRecipients)
          .set({
            status: plan.shouldInviteNow ? "invited" : "pending",
            signingTokenHash: plan.tokenHash,
            tokenExpiresAt: expiresAt,
            tokenRevokedAt: null,
          })
          .where(eq(signRecipients.id, plan.id));
      }
      const [row] = await tx
        .update(signEnvelopes)
        .set({ status: "sent", sentAt: new Date(), expiresAt, finalizationKey })
        .where(eq(signEnvelopes.id, envelopeId))
        .returning();
      return row;
    });

    /*
     * The single-envelope route runs under `TenantContextInterceptor`, whose
     * context holds a hook array, so its invitations defer past the commit.
     * Bulk send reaches this method one row at a time inside
     * `runInNewTenantTransaction`; that context holds a hook array too, but a
     * hook drained after the row's commit is fire-and-forget, so a provider
     * refusal there would leave the row reading `success` with no invitation
     * behind it. It asks for `outbox` delivery instead and the invitation
     * commits with the row.
     */
    await this.invitations.deliverInvitations(
      sendPlans.flatMap((plan) =>
        plan.shouldInviteNow && plan.email
          ? [{ email: plan.email, name: plan.name, rawToken: plan.rawToken }]
          : [],
      ),
      senderNameStr,
      envelope,
      delivery,
    );

    /*
     * The CC notices leave the same way. They are a second hook rather than
     * part of the first only because they render a different template; hooks
     * drain in registration order, so the signers are still mailed first.
     */
    const ccPlans =
      envelope.ccTiming === "on_send"
        ? recipientRows.flatMap((r) =>
            (r.recipientType === "cc" || r.recipientType === "viewer") && r.email
              ? [{ email: r.email, name: r.name }]
              : [],
          )
        : [];
    if (ccPlans.length > 0) {
      const envelopeViewUrl = `${appUrl()}/sign/envelopes/${envelopeId}`;
      if (delivery === "outbox") {
        for (const cc of ccPlans)
          await this.notifications.queueCcNotice(cc.email, cc.name, envelope.title, envelopeViewUrl);
      } else {
        const deliverCcNotices = async () => {
          for (const cc of ccPlans) {
            await this.notifications.sendCcNotice(cc.email, cc.name, envelope.title, envelopeViewUrl);
          }
        };
        if (!registerAfterCommit(deliverCcNotices)) await deliverCcNotices();
      }
    }

    await this.audit.record({
      orgId,
      envelopeId,
      actorType: "internal_user",
      actorUserId: actor.userId,
      eventType: "envelope_sent",
      eventMessage: `Sent to ${invitedCount} recipient(s)`,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });

    this.integrations.emitEnvelopeEvent(updated, "sent", { invitedCount });

    return updated;
  }

  async resend(orgId: string, envelopeId: number, actor: RequestActorContext) {
    const envelope = await findEnvelopeOrThrow(this.db, orgId, envelopeId);
    if (!isEnvelopeSignable(envelope.status)) {
      throw new ForbiddenException("Only sent envelopes can be resent");
    }

    const senderNameStr = await resolveSenderName(this.db, orgId, actor.membershipId);
    const recipientRows = await this.recipients.listForEnvelope(systemEnvelopeScope(orgId), null, envelopeId);
    const invitations: InvitationPlan[] = [];
    for (const r of recipientRows) {
      if (!isSigningType(r.recipientType)) continue;
      if (
        r.status === "completed" ||
        r.status === "declined" ||
        r.status === "delegated" ||
        r.status === "pending"
      )
        continue;

      const rawToken = this.tokens.generateSigningToken();
      await this.db
        .update(signRecipients)
        .set({
          signingTokenHash: this.tokens.hash(rawToken),
          tokenRevokedAt: null,
        })
        .where(eq(signRecipients.id, r.id));

      if (r.email) invitations.push({ email: r.email, name: r.name, rawToken });
    }
    const count = invitations.length;

    /*
     * Same rule as `send`: the token rotations above are in the request
     * transaction, the emails are not. Rotating a token already invalidates the
     * link the recipient was holding, so a hook that never runs leaves them no
     * worse off than the throw did — and a second resend mints another token.
     *
     * `resentCount` therefore counts recipients whose token was rotated and who
     * have an address, not deliveries confirmed by the provider. It never
     * reported deliveries anyway: a mid-loop SMTP throw rolled the whole
     * request back, so no caller ever saw a partial count.
     */
    await this.invitations.deliverInvitations(invitations, senderNameStr, envelope, "after_commit");

    await this.audit.record({
      orgId,
      envelopeId,
      actorType: "internal_user",
      actorUserId: actor.userId,
      eventType: "envelope_sent",
      eventMessage: `Resent to ${count} recipient(s)`,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });

    return { resentCount: count };
  }

  /**
   * A correction that changes where an invited recipient is reached.
   *
   * The link already mailed to the old address stays valid until its token is
   * rotated — lookup is by digest, so a fresh token is what revokes it — and
   * the new address has never been sent anything. Rotate, then invite the new
   * address the same way `resend` does, after the correction commits. A
   * recipient who has not been invited yet (pending, or the envelope is still a
   * draft) needs neither: their first invitation goes to whatever address is on
   * the row when the envelope is sent.
   */
  async reinviteCorrectedRecipient(
    orgId: string,
    envelopeId: number,
    recipient: { id: number; name: string; email: string; recipientType: string; status: string },
    actor: RequestActorContext,
  ): Promise<boolean> {
    const envelope = await findEnvelopeOrThrow(this.db, orgId, envelopeId);
    if (!isEnvelopeSignable(envelope.status)) return false;
    if (!isSigningType(recipient.recipientType)) return false;
    if (recipient.status !== "invited" && recipient.status !== "viewed" && recipient.status !== "authenticated")
      return false;

    const rawToken = this.tokens.generateSigningToken();
    await this.db
      .update(signRecipients)
      .set({ signingTokenHash: this.tokens.hash(rawToken), tokenRevokedAt: null, status: "invited" })
      .where(and(eq(signRecipients.id, recipient.id), eq(signRecipients.orgId, orgId)));

    const senderNameStr = await resolveSenderName(this.db, orgId, actor.membershipId);
    await this.invitations.deliverInvitations(
      [{ email: recipient.email, name: recipient.name, rawToken }],
      senderNameStr,
      envelope,
      "after_commit",
    );
    return true;
  }

  /**
   * Brings an expired envelope's recipients back with the envelope.
   *
   * The expiration sweep marks every unfinished recipient `expired` and revokes
   * their tokens, so an envelope whose expiry was merely moved forward came
   * back as `sent` with nobody able to sign it: every session closed on the
   * revoked token and no new link was ever sent. The recipients the sweep
   * expired are exactly the ones who were eligible when it ran — in a
   * sequential envelope, the current step; the rest were still `pending` and
   * stay so — and each gets a fresh token and a fresh invitation after the
   * commit. Returns how many were reinvited.
   */
  async reviveExpiredRecipients(
    orgId: string,
    envelopeId: number,
    expiresAt: Date,
    actor: RequestActorContext,
  ): Promise<number> {
    const envelope = await findEnvelopeOrThrow(this.db, orgId, envelopeId);
    const recipientRows = await this.recipients.listForEnvelope(systemEnvelopeScope(orgId), null, envelopeId);
    const revivable = recipientRows.filter(
      (r): r is typeof r & { email: string } =>
        isSigningType(r.recipientType) && r.status === "expired" && r.completedAt === null && r.email !== null,
    );
    if (revivable.length === 0) return 0;

    const senderNameStr = await resolveSenderName(this.db, orgId, envelope.senderMembershipId);
    const invitations: InvitationPlan[] = [];
    for (const r of revivable) {
      const rawToken = this.tokens.generateSigningToken();
      await this.db
        .update(signRecipients)
        .set({
          status: "invited",
          signingTokenHash: this.tokens.hash(rawToken),
          tokenRevokedAt: null,
          tokenExpiresAt: expiresAt,
        })
        .where(and(eq(signRecipients.id, r.id), eq(signRecipients.orgId, orgId)));
      invitations.push({ email: r.email, name: r.name, rawToken });
    }
    await this.invitations.deliverInvitations(invitations, senderNameStr, envelope, "after_commit");
    await this.audit.record({
      orgId,
      envelopeId,
      actorType: "internal_user",
      actorUserId: actor.userId,
      eventType: "envelope_sent",
      eventMessage: `Re-invited ${invitations.length} recipient(s) after the expiration was extended`,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });
    return invitations.length;
  }

  async applyRecipientOutcome(
    orgId: string,
    envelopeId: number,
  ): Promise<{ status: SignEnvelopeStatus; becameCompleted: boolean }> {
    const envelope = await findEnvelopeOrThrow(this.db, orgId, envelopeId);
    const recipientRows = await this.recipients.listForEnvelope(systemEnvelopeScope(orgId), null, envelopeId);
    const signingRecipients = recipientRows.filter((r) => isSigningType(r.recipientType));

    const newStatus = computeEnvelopeStatusFromRecipients(
      signingRecipients.map((r) => ({ status: r.status })),
      envelope.status,
    );

    if (
      newStatus !== envelope.status &&
      canTransitionEnvelope(envelope.status, newStatus)
    ) {
      const patch: Partial<typeof signEnvelopes.$inferInsert> = {
        status: newStatus,
      };
      if (newStatus === "completed") patch.completedAt = new Date();
      if (newStatus === "declined") patch.declinedAt = new Date();

      await this.db.transaction(async (tx) => {
        await tx
          .update(signEnvelopes)
          .set(patch)
          .where(eq(signEnvelopes.id, envelopeId));
        if (newStatus === "completed") {
          await OutboxWriter.emit(tx, {
            eventId: randomUUID(),
            organizationId: orgId,
            aggregateType: "sign_envelope",
            aggregateId: String(envelopeId),
            aggregateVersion: patch.completedAt?.getTime() ?? Date.now(),
            eventType: "sign.envelope.completed",
            payload: { envelopeId, orgId },
            occurredAt: new Date(),
          });
        }
      });

      await this.audit.record({
        orgId,
        envelopeId,
        actorType: "system",
        eventType:
          newStatus === "completed"
            ? "envelope_completed"
            : newStatus === "declined"
              ? "recipient_declined"
              : "envelope_updated",
        eventMessage: `Envelope status changed to ${newStatus}`,
      });

      if (newStatus === "declined") {
        this.integrations.emitEnvelopeEvent(
          { ...envelope, status: newStatus, declinedAt: patch.declinedAt ?? envelope.declinedAt },
          "declined",
        );
      }
    }

    if (
      newStatus !== "completed" &&
      newStatus !== "declined" &&
      envelope.routingMode !== "parallel"
    ) {
      const eligibleIds = new Set(
        nextEligibleRecipientIds(
          signingRecipients.map((r) => ({
            id: r.id,
            routingOrder: r.routingOrder,
            status: r.status,
          })),
        ),
      );
      const senderNameStr = await resolveSenderName(this.db, orgId, envelope.senderMembershipId);
      const invitations: InvitationPlan[] = [];
      for (const r of signingRecipients) {
        if (r.status !== "pending" || !eligibleIds.has(r.id)) continue;
        const rawToken = this.tokens.generateSigningToken();
        await this.db
          .update(signRecipients)
          .set({
            status: "invited",
            signingTokenHash: this.tokens.hash(rawToken),
            tokenExpiresAt: envelope.expiresAt,
          })
          .where(eq(signRecipients.id, r.id));
        if (r.email) invitations.push({ email: r.email, name: r.name, rawToken });
      }

      /*
       * The one caller of this method is the public signing flow, which is
       * `@Public()` — so `resolveTenant` finds no org, `TenantContextInterceptor`
       * opens nothing, and the enclosing transaction is the one
       * `withRecipientSession` opens. It shadows the helper's hook array with
       * one of its own so the next signer's invitation is drained *awaited*
       * after the commit, with a provider failure logged in the signer's
       * request rather than fired and forgotten.
       */
      await this.invitations.deliverInvitations(invitations, senderNameStr, envelope, "after_commit");
    }

    return {
      status: newStatus,
      becameCompleted:
        newStatus === "completed" && envelope.status !== "completed",
    };
  }
}
