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
import { signEnvelopes, signRecipients, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { appUrl } from "../email/app-url";
import { SignAuditService } from "./sign-audit.service";
import { SignTokensService } from "./sign-tokens.service";
import { SignSettingsService } from "./sign-settings.service";
import { SignNotificationsService } from "./sign-notifications.service";
import { SignRecipientsService } from "./sign-recipients.service";
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
  ) {}

  private async findEnvelope(orgId: string, envelopeId: number) {
    const row = await this.db.query.signEnvelopes.findFirst({
      where: and(eq(signEnvelopes.id, envelopeId), eq(signEnvelopes.orgId, orgId)),
    });
    if (!row) throw new NotFoundException("Envelope not found");
    return row;
  }

  private async senderName(userId: string): Promise<string> {
    const user = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
    });
    return user?.name ?? "A StreamlineOS user";
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

    const recipientRows = await this.recipients.listForEnvelope(orgId, envelopeId);
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
    const senderNameStr = await this.senderName(actor.userId);

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
        await (tx as Db)
          .update(signRecipients)
          .set({
            status: plan.shouldInviteNow ? "invited" : "pending",
            signingTokenHash: plan.tokenHash,
            tokenExpiresAt: expiresAt,
            tokenRevokedAt: null,
          })
          .where(eq(signRecipients.id, plan.id));
      }
      const [row] = await (tx as Db)
        .update(signEnvelopes)
        .set({ status: "sent", sentAt: new Date(), expiresAt, finalizationKey })
        .where(eq(signEnvelopes.id, envelopeId))
        .returning();
      if (row) {
        await OutboxWriter.emit(tx, {
          eventId: randomUUID(),
          organizationId: orgId,
          aggregateType: "sign_envelope",
          aggregateId: String(envelopeId),
          aggregateVersion: Date.now(),
          eventType: "sign.envelope.sent",
          payload: { envelopeId, orgId, invitedCount, actorUserId: actor.userId },
          occurredAt: new Date(),
        });
      }
      return row;
    });

    for (const plan of sendPlans) {
      if (plan.shouldInviteNow && plan.email) {
        const signingUrl = this.tokens.buildSigningUrl(plan.rawToken);
        await this.notifications.sendInvitation(
          plan.email,
          plan.name,
          senderNameStr,
          envelope.title,
          envelope.message ?? undefined,
          signingUrl,
        );
      }
    }

    if (envelope.ccTiming === "on_send") {
      for (const cc of recipientRows.filter(
        (r) => r.recipientType === "cc" || r.recipientType === "viewer",
      )) {
        if (cc.email) {
          await this.notifications.sendCcNotice(
            cc.email,
            cc.name,
            envelope.title,
            `${appUrl}/sign/envelopes/${envelopeId}`,
          );
        }
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
    const envelope = await this.findEnvelope(orgId, envelopeId);
    if (!isEnvelopeSignable(envelope.status)) {
      throw new ForbiddenException("Only sent envelopes can be resent");
    }

    const senderNameStr = await this.senderName(actor.userId);
    const recipientRows = await this.recipients.listForEnvelope(orgId, envelopeId);
    let count = 0;
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

      if (r.email) {
        const signingUrl = this.tokens.buildSigningUrl(rawToken);
        await this.notifications.sendInvitation(
          r.email,
          r.name,
          senderNameStr,
          envelope.title,
          envelope.message ?? undefined,
          signingUrl,
        );
        count++;
      }
    }

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
    const recipientRows = await this.recipients.listForEnvelope(orgId, envelopeId);
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
        await (tx as Db)
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
          { ...envelope, ...patch } as typeof signEnvelopes.$inferSelect,
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
      const senderNameStr = await this.senderName(envelope.senderUserId);
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
        if (r.email) {
          const signingUrl = this.tokens.buildSigningUrl(rawToken);
          await this.notifications.sendInvitation(
            r.email,
            r.name,
            senderNameStr,
            envelope.title,
            envelope.message ?? undefined,
            signingUrl,
          );
        }
      }
    }

    return {
      status: newStatus,
      becameCompleted:
        newStatus === "completed" && envelope.status !== "completed",
    };
  }
}
