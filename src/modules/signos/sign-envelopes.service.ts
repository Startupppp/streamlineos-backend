import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, inArray, isNull, lte, notInArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { addDays } from "date-fns";
import { signDocuments, signEnvelopes, signFields, signRecipients, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { appUrl } from "../email/app-url";
import { SignAuditService } from "./sign-audit.service";
import { SignTokensService } from "./sign-tokens.service";
import { SignSettingsService } from "./sign-settings.service";
import { SignNotificationsService } from "./sign-notifications.service";
import { SignIntegrationsService } from "./sign-integrations.service";
import { SignRecipientsService, type SignActorContext } from "./sign-recipients.service";
import { PlanLimitsService } from "../billing/plan-limits.service";
import {
  canTransitionEnvelope,
  computeEnvelopeStatusFromRecipients,
  isEnvelopeEditable,
  isEnvelopeSignable,
  isEnvelopeTerminal,
  nextEligibleRecipientIds,
  type SignEnvelopeStatus,
  type SignRecipientStatus,
} from "./sign-state";
import type {
  CreateEnvelopeInput,
  UpdateEnvelopeInput,
  ListEnvelopesInput,
  VoidEnvelopeInput,
  CorrectEnvelopeInput,
  ExtendExpirationInput,
} from "./dto/signos.schemas";

const SIGNING_RECIPIENT_TYPES = ["signer", "approver", "in_person_host", "internal_reviewer"] as const;
type SigningRecipientType = (typeof SIGNING_RECIPIENT_TYPES)[number];

function isSigningType(type: string): type is SigningRecipientType {
  return (SIGNING_RECIPIENT_TYPES as readonly string[]).includes(type);
}

export interface EnvelopeValidationResult {
  valid: boolean;
  errors: string[];
}

@Injectable()
export class SignEnvelopesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: SignAuditService,
    private readonly tokens: SignTokensService,
    private readonly settings: SignSettingsService,
    private readonly notifications: SignNotificationsService,
    private readonly recipients: SignRecipientsService,
    private readonly integrations: SignIntegrationsService,
    private readonly planLimits: PlanLimitsService,
  ) {}

  async create(orgId: string, userId: string, input: CreateEnvelopeInput) {
    await this.planLimits.assertWithinLimit(orgId, "signEnvelopes");

    const [envelope] = await this.db
      .insert(signEnvelopes)
      .values({
        orgId,
        title: input.title,
        subject: input.subject,
        message: input.message,
        routingMode: input.routingMode,
        ccTiming: input.ccTiming,
        allowDecline: input.allowDecline,
        sourceModule: input.sourceModule,
        sourceEntityType: input.sourceEntityType,
        sourceEntityId: input.sourceEntityId,
        templateId: input.templateId,
        watermarkPolicyId: input.watermarkPolicyId,
        senderUserId: userId,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : undefined,
        reminderEnabled: input.reminderEnabled,
        reminderFirstAfterDays: input.reminderFirstAfterDays,
        reminderRepeatDays: input.reminderRepeatDays,
        reminderMaxCount: input.reminderMaxCount,
        metadataJson: input.metadataJson ?? {},
      })
      .returning();

    await this.audit.record({
      orgId,
      envelopeId: envelope.id,
      actorType: "internal_user",
      actorUserId: userId,
      eventType: "envelope_created",
      eventMessage: `Created envelope "${envelope.title}"`,
    });
    return envelope;
  }

  async update(orgId: string, envelopeId: number, input: UpdateEnvelopeInput, actor: SignActorContext) {
    const envelope = await this.mustGet(orgId, envelopeId);
    if (!isEnvelopeEditable(envelope.status)) {
      throw new ForbiddenException("Only draft envelopes can be edited directly");
    }

    const [updated] = await this.db
      .update(signEnvelopes)
      .set({
        ...input,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : undefined,
        metadataJson: input.metadataJson,
        updatedAt: new Date(),
      })
      .where(eq(signEnvelopes.id, envelopeId))
      .returning();

    await this.audit.record({
      orgId,
      envelopeId,
      actorType: "internal_user",
      actorUserId: actor.userId,
      eventType: "envelope_updated",
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });
    return updated;
  }

  async delete(orgId: string, envelopeId: number, actor: SignActorContext) {
    const envelope = await this.mustGet(orgId, envelopeId);
    if (!isEnvelopeEditable(envelope.status)) {
      throw new ForbiddenException("Only draft envelopes can be deleted. Void sent envelopes instead.");
    }

    await this.db.delete(signEnvelopes).where(and(eq(signEnvelopes.id, envelopeId), eq(signEnvelopes.orgId, orgId)));

    await this.audit.record({
      orgId,
      envelopeId: null,
      actorType: "internal_user",
      actorUserId: actor.userId,
      eventType: "envelope_deleted",
      eventMessage: `Deleted draft envelope "${envelope.title}"`,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });

    return { success: true as const };
  }

  async list(orgId: string, query: ListEnvelopesInput, scope: { userId: string; viewAll: boolean }) {
    const conditions = [eq(signEnvelopes.orgId, orgId)];
    if (!scope.viewAll) conditions.push(eq(signEnvelopes.senderUserId, scope.userId));
    if (query.status) conditions.push(eq(signEnvelopes.status, query.status as SignEnvelopeStatus));
    if (query.sourceModule) conditions.push(eq(signEnvelopes.sourceModule, query.sourceModule));
    if (query.sourceEntityType) conditions.push(eq(signEnvelopes.sourceEntityType, query.sourceEntityType));
    if (query.sourceEntityId) conditions.push(eq(signEnvelopes.sourceEntityId, query.sourceEntityId));

    const rows = await this.db.query.signEnvelopes.findMany({
      where: and(...conditions),
      orderBy: (e, { desc }) => [desc(e.createdAt)],
      limit: query.limit,
      offset: (query.page - 1) * query.limit,
    });
    return rows;
  }

  async mustGet(orgId: string, envelopeId: number) {
    const envelope = await this.db.query.signEnvelopes.findFirst({
      where: and(eq(signEnvelopes.id, envelopeId), eq(signEnvelopes.orgId, orgId)),
    });
    if (!envelope) throw new NotFoundException("Envelope not found");
    return envelope;
  }

  async getFull(orgId: string, envelopeId: number) {
    const envelope = await this.mustGet(orgId, envelopeId);
    const [documents, recipientRows, fields] = await Promise.all([
      this.db.query.signDocuments.findMany({
        where: and(eq(signDocuments.orgId, orgId), eq(signDocuments.envelopeId, envelopeId)),
        orderBy: (d, { asc }) => [asc(d.orderIndex)],
      }),
      this.recipients.listForEnvelope(orgId, envelopeId),
      this.db.query.signFields.findMany({
        where: and(eq(signFields.orgId, orgId), eq(signFields.envelopeId, envelopeId)),
      }),
    ]);
    return { envelope, documents, recipients: recipientRows, fields };
  }

  async validate(orgId: string, envelopeId: number): Promise<EnvelopeValidationResult> {
    const envelope = await this.mustGet(orgId, envelopeId);
    const errors: string[] = [];

    const documents = await this.db.query.signDocuments.findMany({
      where: and(eq(signDocuments.orgId, orgId), eq(signDocuments.envelopeId, envelopeId)),
    });
    if (documents.length === 0) errors.push("Envelope has no document");

    const recipientRows = await this.recipients.listForEnvelope(orgId, envelopeId);
    const signingRecipients = recipientRows.filter((r) => isSigningType(r.recipientType));
    if (signingRecipients.length === 0) errors.push("Envelope has no signer");

    for (const r of signingRecipients) {
      if (r.recipientType !== "in_person_host" && !r.email) {
        errors.push(`Recipient "${r.name}" is missing an email address`);
      }
      if (r.authMethod === "otp_sms" && !r.phone) {
        errors.push(`Recipient "${r.name}" is missing a phone number for SMS OTP authentication`);
      }
    }
    if (envelope.routingMode === "sequential" && signingRecipients.some((r) => !r.routingOrder)) {
      errors.push("All recipients require a routing order for sequential envelopes");
    }

    const fields = await this.db.query.signFields.findMany({
      where: and(eq(signFields.orgId, orgId), eq(signFields.envelopeId, envelopeId)),
    });
    const recipientById = new Map(recipientRows.map((r) => [r.id, r]));
    for (const f of fields) {
      const recipient = recipientById.get(f.recipientId);
      if (f.required && recipient && !isSigningType(recipient.recipientType)) {
        errors.push(`A required field on page ${f.pageNumber} is assigned to a non-signing recipient`);
      }
      if (f.width <= 0 || f.height <= 0) errors.push(`A field on page ${f.pageNumber} has invalid coordinates`);
      if (f.fieldType === "dropdown" && (!f.optionsJson || f.optionsJson.length === 0)) {
        errors.push("A dropdown field has no options");
      }
      if (f.fieldType === "radio" && (!f.optionsJson || f.optionsJson.length < 2)) {
        errors.push("A radio group field has fewer than two options");
      }
    }

    if (envelope.expiresAt && envelope.expiresAt.getTime() < Date.now()) {
      errors.push("Expiration date is in the past");
    }

    return { valid: errors.length === 0, errors };
  }

  private async senderName(userId: string): Promise<string> {
    const user = await this.db.query.users.findFirst({ where: eq(users.id, userId) });
    return user?.name ?? "A StreamlineOS user";
  }

  async send(orgId: string, envelopeId: number, actor: SignActorContext) {
    const envelope = await this.mustGet(orgId, envelopeId);
    if (!isEnvelopeEditable(envelope.status)) {
      throw new ForbiddenException("Only draft envelopes can be sent");
    }
    const validation = await this.validate(orgId, envelopeId);
    if (!validation.valid) {
      throw new BadRequestException({ message: "Envelope is not ready to send", errors: validation.errors });
    }

    const orgSettings = await this.settings.getOrCreate(orgId);
    const expiresAt = envelope.expiresAt ?? addDays(new Date(), orgSettings.defaultExpirationDays);
    const finalizationKey = randomUUID();

    const recipientRows = await this.recipients.listForEnvelope(orgId, envelopeId);
    const signingRecipients = recipientRows.filter((r) => isSigningType(r.recipientType));
    const inviteNowIds = new Set(
      nextEligibleRecipientIds(signingRecipients.map((r) => ({ id: r.id, routingOrder: r.routingOrder, status: r.status }))),
    );
    const senderName = await this.senderName(actor.userId);

    let invitedCount = 0;
    for (const recipient of signingRecipients) {
      const shouldInviteNow = envelope.routingMode !== "sequential" || inviteNowIds.has(recipient.id);
      const rawToken = this.tokens.generateSigningToken();
      await this.db
        .update(signRecipients)
        .set({
          status: shouldInviteNow ? "invited" : "pending",
          signingTokenHash: this.tokens.hash(rawToken),
          tokenExpiresAt: expiresAt,
          tokenRevokedAt: null,
        })
        .where(eq(signRecipients.id, recipient.id));

      if (shouldInviteNow && recipient.email) {
        const signingUrl = this.tokens.buildSigningUrl(rawToken);
        await this.notifications.sendInvitation(
          recipient.email,
          recipient.name,
          senderName,
          envelope.title,
          envelope.message ?? undefined,
          signingUrl,
        );
        invitedCount++;
      }
    }

    if (envelope.ccTiming === "on_send") {
      for (const cc of recipientRows.filter((r) => r.recipientType === "cc" || r.recipientType === "viewer")) {
        if (cc.email) {
          await this.notifications.sendCcNotice(cc.email, cc.name, envelope.title, `${appUrl}/sign/envelopes/${envelopeId}`);
        }
      }
    }

    const [updated] = await this.db
      .update(signEnvelopes)
      .set({ status: "sent", sentAt: new Date(), expiresAt, finalizationKey })
      .where(eq(signEnvelopes.id, envelopeId))
      .returning();

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

  async voidEnvelope(orgId: string, envelopeId: number, input: VoidEnvelopeInput, actor: SignActorContext) {
    const envelope = await this.mustGet(orgId, envelopeId);
    if (!canTransitionEnvelope(envelope.status as SignEnvelopeStatus, "voided")) {
      throw new ForbiddenException(`Cannot void an envelope in status "${envelope.status}"`);
    }

    await this.db
      .update(signRecipients)
      .set({ tokenRevokedAt: new Date() })
      .where(and(eq(signRecipients.envelopeId, envelopeId), isNull(signRecipients.completedAt)));

    const [updated] = await this.db
      .update(signEnvelopes)
      .set({ status: "voided", voidedAt: new Date(), voidedBy: actor.userId, voidReason: input.reason })
      .where(eq(signEnvelopes.id, envelopeId))
      .returning();

    const recipientRows = await this.recipients.listForEnvelope(orgId, envelopeId);
    for (const r of recipientRows) {
      if (r.email && r.status !== "completed") {
        await this.notifications.sendVoidedToRecipient(r.email, r.name, envelope.title, input.reason);
      }
    }

    await this.audit.record({
      orgId,
      envelopeId,
      actorType: "internal_user",
      actorUserId: actor.userId,
      eventType: "envelope_voided",
      eventMessage: input.reason,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });

    this.integrations.emitEnvelopeEvent(updated, "voided", { reason: input.reason });

    return updated;
  }

  async correct(orgId: string, envelopeId: number, input: CorrectEnvelopeInput, actor: SignActorContext) {
    const envelope = await this.mustGet(orgId, envelopeId);
    if (isEnvelopeTerminal(envelope.status)) {
      throw new ForbiddenException("Completed or voided envelopes cannot be corrected");
    }

    for (const patch of input.recipients ?? []) {
      await this.recipients.update(orgId, patch.id, { name: patch.name, email: patch.email, phone: patch.phone }, actor);
    }

    await this.audit.record({
      orgId,
      envelopeId,
      actorType: "internal_user",
      actorUserId: actor.userId,
      eventType: "envelope_corrected",
      eventMessage: input.reason ?? "Envelope corrected",
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });

    return this.mustGet(orgId, envelopeId);
  }

  async resend(orgId: string, envelopeId: number, actor: SignActorContext) {
    const envelope = await this.mustGet(orgId, envelopeId);
    if (!isEnvelopeSignable(envelope.status as SignEnvelopeStatus)) {
      throw new ForbiddenException("Only sent envelopes can be resent");
    }

    const senderName = await this.senderName(actor.userId);
    const recipientRows = await this.recipients.listForEnvelope(orgId, envelopeId);
    let count = 0;
    for (const r of recipientRows) {
      if (!isSigningType(r.recipientType)) continue;
      if (r.status === "completed" || r.status === "declined" || r.status === "delegated" || r.status === "pending") continue;

      const rawToken = this.tokens.generateSigningToken();
      await this.db
        .update(signRecipients)
        .set({ signingTokenHash: this.tokens.hash(rawToken), tokenRevokedAt: null })
        .where(eq(signRecipients.id, r.id));

      if (r.email) {
        const signingUrl = this.tokens.buildSigningUrl(rawToken);
        await this.notifications.sendInvitation(r.email, r.name, senderName, envelope.title, envelope.message ?? undefined, signingUrl);
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

  async extendExpiration(orgId: string, envelopeId: number, input: ExtendExpirationInput, actor: SignActorContext) {
    const envelope = await this.mustGet(orgId, envelopeId);
    const newExpiresAt = new Date(input.expiresAt);
    if (newExpiresAt.getTime() <= Date.now()) throw new BadRequestException("New expiration must be in the future");

    const nextStatus: SignEnvelopeStatus = envelope.status === "expired" ? "sent" : (envelope.status as SignEnvelopeStatus);

    await this.db
      .update(signRecipients)
      .set({ tokenExpiresAt: newExpiresAt })
      .where(and(eq(signRecipients.envelopeId, envelopeId), isNull(signRecipients.completedAt)));

    const [updated] = await this.db
      .update(signEnvelopes)
      .set({ expiresAt: newExpiresAt, status: nextStatus })
      .where(eq(signEnvelopes.id, envelopeId))
      .returning();

    await this.audit.record({
      orgId,
      envelopeId,
      actorType: "internal_user",
      actorUserId: actor.userId,
      eventType: "envelope_extended",
      eventMessage: `Extended expiration to ${newExpiresAt.toISOString()}`,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });

    return updated;
  }

  /**
   * Called by the public signing service right after a recipient completes or declines.
   * Recomputes envelope status from the blocking (signing) recipients and, for sequential/mixed
   * routing, invites whichever recipients are next in line. Returns whether the envelope became
   * fully completed so the caller can trigger finalization.
   */
  async applyRecipientOutcome(orgId: string, envelopeId: number): Promise<{ status: SignEnvelopeStatus; becameCompleted: boolean }> {
    const envelope = await this.mustGet(orgId, envelopeId);
    const recipientRows = await this.recipients.listForEnvelope(orgId, envelopeId);
    const signingRecipients = recipientRows.filter((r) => isSigningType(r.recipientType));

    const newStatus = computeEnvelopeStatusFromRecipients(
      signingRecipients.map((r) => ({ status: r.status as SignRecipientStatus })),
      envelope.status as SignEnvelopeStatus,
    );

    if (newStatus !== envelope.status && canTransitionEnvelope(envelope.status as SignEnvelopeStatus, newStatus)) {
      const patch: Partial<typeof signEnvelopes.$inferInsert> = { status: newStatus };
      if (newStatus === "completed") patch.completedAt = new Date();
      if (newStatus === "declined") patch.declinedAt = new Date();
      await this.db.update(signEnvelopes).set(patch).where(eq(signEnvelopes.id, envelopeId));

      await this.audit.record({
        orgId,
        envelopeId,
        actorType: "system",
        eventType: newStatus === "completed" ? "envelope_completed" : newStatus === "declined" ? "recipient_declined" : "envelope_updated",
        eventMessage: `Envelope status changed to ${newStatus}`,
      });

      if (newStatus === "declined") {
        this.integrations.emitEnvelopeEvent({ ...envelope, ...patch } as typeof signEnvelopes.$inferSelect, "declined");
      }
    }

    if (newStatus !== "completed" && newStatus !== "declined" && envelope.routingMode !== "parallel") {
      const eligibleIds = new Set(
        nextEligibleRecipientIds(signingRecipients.map((r) => ({ id: r.id, routingOrder: r.routingOrder, status: r.status as SignRecipientStatus }))),
      );
      const senderName = await this.senderName(envelope.senderUserId);
      for (const r of signingRecipients) {
        if (r.status !== "pending" || !eligibleIds.has(r.id)) continue;
        const rawToken = this.tokens.generateSigningToken();
        await this.db
          .update(signRecipients)
          .set({ status: "invited", signingTokenHash: this.tokens.hash(rawToken), tokenExpiresAt: envelope.expiresAt })
          .where(eq(signRecipients.id, r.id));
        if (r.email) {
          const signingUrl = this.tokens.buildSigningUrl(rawToken);
          await this.notifications.sendInvitation(r.email, r.name, senderName, envelope.title, envelope.message ?? undefined, signingUrl);
        }
      }
    }

    return { status: newStatus, becameCompleted: newStatus === "completed" && envelope.status !== "completed" };
  }

  async runExpirationSweep(): Promise<number> {
    const now = new Date();
    const expiring = await this.db.query.signEnvelopes.findMany({
      where: and(inArray(signEnvelopes.status, ["sent", "delivered", "partially_completed"]), lte(signEnvelopes.expiresAt, now)),
    });

    for (const envelope of expiring) {
      await this.db
        .update(signRecipients)
        .set({ status: "expired", tokenRevokedAt: now })
        .where(
          and(
            eq(signRecipients.envelopeId, envelope.id),
            notInArray(signRecipients.status, ["completed", "declined", "delegated"]),
          ),
        );
      await this.db.update(signEnvelopes).set({ status: "expired" }).where(eq(signEnvelopes.id, envelope.id));
      await this.audit.record({
        orgId: envelope.orgId,
        envelopeId: envelope.id,
        actorType: "system",
        eventType: "envelope_expired",
        eventMessage: "Envelope expired automatically",
      });
      this.integrations.emitEnvelopeEvent({ ...envelope, status: "expired" }, "expired");
    }
    return expiring.length;
  }

  private async remindEnvelopeRecipients(envelope: typeof signEnvelopes.$inferSelect, actorType: "system" | "internal_user", actorUserId?: string): Promise<number> {
    const now = new Date();
    const recipientRows = await this.recipients.listForEnvelope(envelope.orgId, envelope.id);
    const senderName = await this.senderName(envelope.senderUserId);
    let remindedCount = 0;

    for (const r of recipientRows) {
      if (!isSigningType(r.recipientType)) continue;
      if (r.status !== "invited" && r.status !== "viewed" && r.status !== "authenticated") continue;
      if (!r.email || !r.signingTokenHash) continue;

      const rawToken = this.tokens.generateSigningToken();
      await this.db.update(signRecipients).set({ signingTokenHash: this.tokens.hash(rawToken) }).where(eq(signRecipients.id, r.id));
      const signingUrl = this.tokens.buildSigningUrl(rawToken);
      const daysRemaining = envelope.expiresAt
        ? Math.max(0, Math.ceil((envelope.expiresAt.getTime() - now.getTime()) / 86_400_000))
        : null;
      await this.notifications.sendReminder(r.email, r.name, senderName, envelope.title, signingUrl, daysRemaining);
      await this.audit.record({
        orgId: envelope.orgId,
        envelopeId: envelope.id,
        recipientId: r.id,
        actorType,
        actorUserId,
        eventType: "reminder_sent",
        eventMessage: `Reminder sent to ${r.name}`,
      });
      remindedCount++;
    }

    if (remindedCount > 0) {
      await this.db
        .update(signEnvelopes)
        .set({ reminderSentCount: envelope.reminderSentCount + 1, lastReminderAt: now })
        .where(eq(signEnvelopes.id, envelope.id));
    }
    return remindedCount;
  }

  /** Admin/sender-triggered "send reminder now" button — bypasses the interval and max-count gates. */
  async sendManualReminder(orgId: string, envelopeId: number, actor: SignActorContext): Promise<{ remindedCount: number }> {
    const envelope = await this.mustGet(orgId, envelopeId);
    if (!isEnvelopeSignable(envelope.status as SignEnvelopeStatus)) {
      throw new ForbiddenException("Reminders can only be sent for envelopes awaiting signature");
    }
    const remindedCount = await this.remindEnvelopeRecipients(envelope, "internal_user", actor.userId);
    return { remindedCount };
  }

  async runReminderSweep(): Promise<number> {
    const now = new Date();
    const candidates = await this.db.query.signEnvelopes.findMany({
      where: and(inArray(signEnvelopes.status, ["sent", "delivered", "partially_completed"]), eq(signEnvelopes.reminderEnabled, true)),
    });

    let sentCount = 0;
    for (const envelope of candidates) {
      if (envelope.reminderSentCount >= envelope.reminderMaxCount) continue;
      const baseline = envelope.lastReminderAt ?? envelope.sentAt;
      if (!baseline) continue;
      const intervalDays = envelope.reminderSentCount === 0 ? envelope.reminderFirstAfterDays : envelope.reminderRepeatDays;
      if (addDays(baseline, intervalDays).getTime() > now.getTime()) continue;

      sentCount += await this.remindEnvelopeRecipients(envelope, "system");
    }
    return sentCount;
  }
}
