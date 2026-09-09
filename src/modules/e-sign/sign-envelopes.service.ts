import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { OutboxWriter } from "../../common/outbox/outbox-writer";
import {
  signDocuments,
  signEnvelopes,
  signEnvelopeStatusEnum,
  signFields,
  signRecipients,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { SignAuditService } from "./sign-audit.service";
import { SignRecipientsService } from "./sign-recipients.service";
import { SignIntegrationsService } from "./sign-integrations.service";
import { SignNotificationsService } from "./sign-notifications.service";
import { PlanLimitsService } from "../billing/core/plan-limits.service";
import {
  SignEnvelopeValidationService,
  type EnvelopeValidationResult,
} from "./sign-envelope-validation.service";
import { SignEnvelopeSweepsService } from "./sign-envelope-sweeps.service";
import { SignEnvelopeDispatchService } from "./sign-envelope-dispatch.service";
import { SignSettingsService } from "./sign-settings.service";
import {
  canTransitionEnvelope,
  isEnvelopeEditable,
  isEnvelopeTerminal,
  type SignEnvelopeStatus,
} from "./sign-state";
import type {
  CreateEnvelopeInput,
  UpdateEnvelopeInput,
  ListEnvelopesInput,
  VoidEnvelopeInput,
  CorrectEnvelopeInput,
  ExtendExpirationInput,
} from "./dto/e-sign.schemas";
import type { RequestActorContext } from "../../common/audit/actor-context";

export type { EnvelopeValidationResult };

@Injectable()
export class SignEnvelopesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: SignAuditService,
    private readonly recipients: SignRecipientsService,
    private readonly integrations: SignIntegrationsService,
    private readonly notifications: SignNotificationsService,
    private readonly planLimits: PlanLimitsService,
    private readonly validation: SignEnvelopeValidationService,
    private readonly sweeps: SignEnvelopeSweepsService,
    private readonly dispatch: SignEnvelopeDispatchService,
    private readonly settings: SignSettingsService,
  ) {}

  async create(orgId: string, userId: string, input: CreateEnvelopeInput) {
    await this.planLimits.assertWithinLimit(orgId, "signEnvelopes");

    /**
     * SIGN-P2-03. The three reminder cadence settings were written by the
     * settings API and read by nothing — an organisation that set "first
     * reminder after 7 days, repeat weekly, at most twice" got 3/3/5 on every
     * envelope. That was invisible while the sweep was wired to no scheduler;
     * since SIGN-P0-01 the sweep actually fires, on the wrong cadence.
     */
    const orgSettings = await this.settings.getOrCreate(orgId);

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
        reminderFirstAfterDays:
          input.reminderFirstAfterDays ?? orgSettings.defaultReminderFirstAfterDays,
        reminderRepeatDays: input.reminderRepeatDays ?? orgSettings.defaultReminderRepeatDays,
        reminderMaxCount: input.reminderMaxCount ?? orgSettings.defaultReminderMaxCount,
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

  async update(
    orgId: string,
    envelopeId: number,
    input: UpdateEnvelopeInput,
    actor: RequestActorContext,
  ) {
    const envelope = await this.mustGet(orgId, envelopeId);
    if (!isEnvelopeEditable(envelope.status)) {
      throw new ForbiddenException(
        "Only draft envelopes can be edited directly",
      );
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

  async delete(orgId: string, envelopeId: number, actor: RequestActorContext) {
    const envelope = await this.mustGet(orgId, envelopeId);
    if (!isEnvelopeEditable(envelope.status)) {
      throw new ForbiddenException("Only draft envelopes can be deleted. Void sent envelopes instead.");
    }

    await this.db.delete(signEnvelopes).where(
      and(eq(signEnvelopes.id, envelopeId), eq(signEnvelopes.orgId, orgId)),
    );

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

  async list(
    orgId: string,
    query: ListEnvelopesInput,
    scope: { userId: string; viewAll: boolean },
  ) {
    const conditions = [eq(signEnvelopes.orgId, orgId)];
    if (!scope.viewAll)
      conditions.push(eq(signEnvelopes.senderUserId, scope.userId));
    if (query.status) {
      if (
        !(signEnvelopeStatusEnum.enumValues as readonly string[]).includes(
          query.status,
        )
      ) {
        throw new BadRequestException(
          `Invalid envelope status: ${query.status}`,
        );
      }
      conditions.push(
        eq(signEnvelopes.status, query.status as SignEnvelopeStatus),
      );
    }
    if (query.sourceModule)
      conditions.push(eq(signEnvelopes.sourceModule, query.sourceModule));
    if (query.sourceEntityType)
      conditions.push(
        eq(signEnvelopes.sourceEntityType, query.sourceEntityType),
      );
    if (query.sourceEntityId)
      conditions.push(eq(signEnvelopes.sourceEntityId, query.sourceEntityId));

    return this.db.query.signEnvelopes.findMany({
      where: and(...conditions),
      orderBy: (e, { desc }) => [desc(e.createdAt)],
      limit: query.limit,
      offset: (query.page - 1) * query.limit,
    });
  }

  async mustGet(orgId: string, envelopeId: number) {
    const envelope = await this.db.query.signEnvelopes.findFirst({
      where: and(
        eq(signEnvelopes.id, envelopeId),
        eq(signEnvelopes.orgId, orgId),
      ),
    });
    if (!envelope) throw new NotFoundException("Envelope not found");
    return envelope;
  }

  async getFull(orgId: string, envelopeId: number) {
    const envelope = await this.mustGet(orgId, envelopeId);
    const [documents, recipientRows, fields] = await Promise.all([
      this.db.query.signDocuments.findMany({
        where: and(
          eq(signDocuments.orgId, orgId),
          eq(signDocuments.envelopeId, envelopeId),
        ),
        orderBy: (d, { asc }) => [asc(d.orderIndex)],
      }),
      this.recipients.listForEnvelope(orgId, envelopeId),
      this.db.query.signFields.findMany({
        where: and(
          eq(signFields.orgId, orgId),
          eq(signFields.envelopeId, envelopeId),
        ),
      }),
    ]);
    return { envelope, documents, recipients: recipientRows, fields };
  }

  validate(orgId: string, envelopeId: number): Promise<EnvelopeValidationResult> {
    return this.validation.validate(orgId, envelopeId);
  }

  send(orgId: string, envelopeId: number, actor: RequestActorContext) {
    return this.dispatch.send(orgId, envelopeId, actor);
  }

  async voidEnvelope(
    orgId: string,
    envelopeId: number,
    input: VoidEnvelopeInput,
    actor: RequestActorContext,
  ) {
    const envelope = await this.mustGet(orgId, envelopeId);
    if (!canTransitionEnvelope(envelope.status, "voided")) {
      throw new ForbiddenException(
        `Cannot void an envelope in status "${envelope.status}"`,
      );
    }

    const updated = await this.db.transaction(async (tx) => {
      await (tx as Db)
        .update(signRecipients)
        .set({ tokenRevokedAt: new Date() })
        .where(
          and(
            eq(signRecipients.orgId, orgId),
            eq(signRecipients.envelopeId, envelopeId),
            isNull(signRecipients.completedAt),
          ),
        );

      const [row] = await (tx as Db)
        .update(signEnvelopes)
        .set({
          status: "voided",
          voidedAt: new Date(),
          voidedBy: actor.userId,
          voidReason: input.reason,
        })
        .where(eq(signEnvelopes.id, envelopeId))
        .returning();

      if (row) {
        await OutboxWriter.emit(tx, {
          eventId: randomUUID(),
          organizationId: orgId,
          aggregateType: "sign_envelope",
          aggregateId: String(envelopeId),
          aggregateVersion: Date.now(),
          eventType: "sign.envelope.voided",
          payload: {
            envelopeId,
            orgId,
            reason: input.reason,
            actorUserId: actor.userId,
          },
          occurredAt: new Date(),
        });
      }
      return row;
    });

    const recipientRows = await this.recipients.listForEnvelope(
      orgId,
      envelopeId,
    );
    for (const r of recipientRows) {
      if (r.email && r.status !== "completed") {
        await this.notifications.sendVoidedToRecipient(
          r.email,
          r.name,
          envelope.title,
          input.reason,
        );
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

    this.integrations.emitEnvelopeEvent(updated, "voided", {
      reason: input.reason,
    });

    return updated;
  }

  async correct(
    orgId: string,
    envelopeId: number,
    input: CorrectEnvelopeInput,
    actor: RequestActorContext,
  ) {
    const envelope = await this.mustGet(orgId, envelopeId);
    if (isEnvelopeTerminal(envelope.status)) {
      throw new ForbiddenException(
        "Completed or voided envelopes cannot be corrected",
      );
    }

    for (const patch of input.recipients ?? []) {
      await this.recipients.update(
        orgId,
        patch.id,
        { name: patch.name, email: patch.email, phone: patch.phone },
        actor,
      );
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

  resend(orgId: string, envelopeId: number, actor: RequestActorContext) {
    return this.dispatch.resend(orgId, envelopeId, actor);
  }

  async extendExpiration(
    orgId: string,
    envelopeId: number,
    input: ExtendExpirationInput,
    actor: RequestActorContext,
  ) {
    const envelope = await this.mustGet(orgId, envelopeId);
    const newExpiresAt = new Date(input.expiresAt);
    if (newExpiresAt.getTime() <= Date.now())
      throw new BadRequestException("New expiration must be in the future");

    const nextStatus: SignEnvelopeStatus =
      envelope.status === "expired" ? "sent" : envelope.status;

    await this.db
      .update(signRecipients)
      .set({ tokenExpiresAt: newExpiresAt })
      .where(
        and(
          eq(signRecipients.orgId, orgId),
          eq(signRecipients.envelopeId, envelopeId),
          isNull(signRecipients.completedAt),
        ),
      );

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

  applyRecipientOutcome(orgId: string, envelopeId: number) {
    return this.dispatch.applyRecipientOutcome(orgId, envelopeId);
  }

  sendManualReminder(
    orgId: string,
    envelopeId: number,
    actor: RequestActorContext,
  ) {
    return this.sweeps.sendManualReminder(orgId, envelopeId, actor);
  }

  runReminderSweep() {
    return this.sweeps.runReminderSweep();
  }

  runExpirationSweep() {
    return this.sweeps.runExpirationSweep();
  }
}
