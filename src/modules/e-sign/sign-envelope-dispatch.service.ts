import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { addDays } from "date-fns";
import { OutboxWriter } from "../../common/outbox/outbox-writer";
import { registerAfterCommit } from "../../common/tenant/tenant-context";
import { organizationMembers, signEnvelopes, signRecipients } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { appUrl } from "../email/app-url";
import { SignAuditService } from "./sign-audit.service";
import { SignTokensService } from "./sign-tokens.service";
import { SignSettingsService } from "./sign-settings.service";
import { SignNotificationsService } from "./sign-notifications.service";
import { SignRecipientsService } from "./sign-recipients.service";
import { systemEnvelopeScope } from "./sign-envelope-scope";
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

/** One recipient's pending invitation, resolved while the transaction is live. */
interface InvitationPlan {
  email: string;
  name: string;
  rawToken: string;
}

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
  ) {}

  private async findEnvelope(orgId: string, envelopeId: number) {
    const row = await this.db.query.signEnvelopes.findFirst({
      where: and(eq(signEnvelopes.id, envelopeId), eq(signEnvelopes.orgId, orgId)),
    });
    if (!row) throw new NotFoundException("Envelope not found");
    return row;
  }

  /**
   * Hand a batch of invitations to the transaction boundary, never to the
   * transaction.
   *
   * `this.db` is the tenant-aware proxy, so anything issued under an ambient
   * tenant transaction stays inside it — an SMTP outage would hold that
   * transaction's pooled connection for its whole duration, which §4 forbids,
   * and a throw partway through the loop rolled the token writes back
   * underneath mail already sitting in inboxes.
   *
   * `registerAfterCommit` is the right one of §4's three mechanisms rather than
   * the outbox: the recipient rows carry only the token *hash*, so an outbox
   * payload would have to hold the raw signing token — a bearer credential in
   * plaintext at rest — whereas a hook that never runs is re-drivable through
   * `resend`, which rotates a fresh token for anyone left at `invited`.
   *
   * It returns false when the ambient context carries no hook array, and §4 is
   * explicit that the fallback is to run inline rather than drop the work.
   */
  private async deliverInvitations(
    invitations: InvitationPlan[],
    senderNameStr: string,
    envelope: { title: string; message: string | null },
  ): Promise<void> {
    if (invitations.length === 0) return;
    const deliver = async () => {
      for (const invitation of invitations) {
        await this.notifications.sendInvitation(
          invitation.email,
          invitation.name,
          senderNameStr,
          envelope.title,
          envelope.message ?? undefined,
          this.tokens.buildSigningUrl(invitation.rawToken),
        );
      }
    };
    if (!registerAfterCommit(deliver)) await deliver();
  }

  private async senderName(orgId: string, membershipId: number | null | undefined): Promise<string> {
    if (membershipId == null) return "A StreamlineOS user";
    const member = await this.db.query.organizationMembers.findFirst({
      where: and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.id, membershipId)),
      with: { user: { columns: { name: true } } },
    });
    return member?.user?.name ?? "A StreamlineOS user";
  }

  async send(orgId: string, envelopeId: number, actor: RequestActorContext) {
    const envelope = await this.findEnvelope(orgId, envelopeId);
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
    const senderNameStr = await this.senderName(orgId, actor.membershipId);

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
     * Bulk send is why the fallback inside `deliverInvitations` matters here:
     * it reaches this method one row at a time inside
     * `runInNewTenantTransaction`, which builds a context with no hook array,
     * so `registerAfterCommit` returns false and the email goes out inline —
     * inside that row's transaction, as it does today — rather than being
     * dropped. The single-envelope route runs under
     * `TenantContextInterceptor` and does defer.
     */
    await this.deliverInvitations(
      sendPlans.flatMap((plan) =>
        plan.shouldInviteNow && plan.email
          ? [{ email: plan.email, name: plan.name, rawToken: plan.rawToken }]
          : [],
      ),
      senderNameStr,
      envelope,
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
      const deliverCcNotices = async () => {
        for (const cc of ccPlans) {
          await this.notifications.sendCcNotice(
            cc.email,
            cc.name,
            envelope.title,
            `${appUrl()}/sign/envelopes/${envelopeId}`,
          );
        }
      };
      if (!registerAfterCommit(deliverCcNotices)) await deliverCcNotices();
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
    const envelope = await this.findEnvelope(orgId, envelopeId);
    if (!isEnvelopeSignable(envelope.status)) {
      throw new ForbiddenException("Only sent envelopes can be resent");
    }

    const senderNameStr = await this.senderName(orgId, actor.membershipId);
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
    await this.deliverInvitations(invitations, senderNameStr, envelope);

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

  async applyRecipientOutcome(
    orgId: string,
    envelopeId: number,
  ): Promise<{ status: SignEnvelopeStatus; becameCompleted: boolean }> {
    const envelope = await this.findEnvelope(orgId, envelopeId);
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
      const senderNameStr = await this.senderName(orgId, envelope.senderMembershipId);
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
       * `SignPublicService.withRecipientSession` opens. That is why it installs
       * a hook array of its own: without it `registerAfterCommit` would return
       * false on the only path that reaches here, and this deferral would be
       * decoration over an unchanged send.
       */
      await this.deliverInvitations(invitations, senderNameStr, envelope);
    }

    return {
      status: newStatus,
      becameCompleted:
        newStatus === "completed" && envelope.status !== "completed",
    };
  }
}
