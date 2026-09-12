import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import {
  signEnvelopes,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { SignAuditService } from "./sign-audit.service";
import { SignRecipientsService } from "./sign-recipients.service";
import type { ScopedRead } from "../access/scoped-read";
import { SignIntegrationsService } from "./sign-integrations.service";
import { SignNotificationsService } from "./sign-notifications.service";
import { PlanLimitsService } from "../billing/core/plan-limits.service";
import {
  SignEnvelopeValidationService,
  type EnvelopeValidationResult,
} from "./sign-envelope-validation.service";
import { SignEnvelopeSweepsService } from "./sign-envelope-sweeps.service";
import { SignEnvelopeDispatchService, type InvitationDelivery } from "./sign-envelope-dispatch.service";
import { SignSettingsService } from "./sign-settings.service";
import { SignTemplatesService } from "./sign-templates.service";
import { SignWatermarkService } from "./sign-watermark.service";
import { SignEnvelopeLifecycleService } from "./sign-envelope-lifecycle.service";
import { SignEnvelopeQueriesService } from "./sign-envelope-queries.service";
import {
  isEnvelopeEditable,
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
    private readonly templates: SignTemplatesService,
    private readonly watermarks: SignWatermarkService,
    private readonly lifecycle: SignEnvelopeLifecycleService,
    private readonly queries: SignEnvelopeQueriesService,
  ) {}

  /**
   * The two ids an envelope may point at, read back under the caller's
   * organisation before they are written. Both columns carry composite tenant
   * foreign keys, so another organisation's id — or none — was refused by the
   * database, as a 23503 the caller saw as a 500. Read through the owning
   * services, a missing target and an out-of-tenant one answer the same 404.
   */
  private async assertReferencesInOrg(
    orgId: string,
    input: { templateId?: number; watermarkPolicyId?: number },
  ): Promise<void> {
    if (input.templateId !== undefined) await this.templates.get(orgId, input.templateId);
    if (input.watermarkPolicyId !== undefined) await this.watermarks.get(orgId, input.watermarkPolicyId);
  }

  async create(orgId: string, senderMembershipId: number | null, input: CreateEnvelopeInput) {
    await this.planLimits.assertWithinLimit(orgId, "signEnvelopes");
    await this.assertReferencesInOrg(orgId, input);

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
        senderMembershipId,
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
    await this.assertReferencesInOrg(orgId, input);

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

  list(
    read: ScopedRead,
    membershipId: number | null,
    query: ListEnvelopesInput,
  ) {
    return this.queries.list(read, membershipId, query);
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

  getFull(read: ScopedRead, membershipId: number | null, envelopeId: number) {
    return this.queries.getFull(read, membershipId, envelopeId);
  }

  validate(orgId: string, envelopeId: number): Promise<EnvelopeValidationResult> {
    return this.validation.validate(orgId, envelopeId);
  }

  send(
    orgId: string,
    envelopeId: number,
    actor: RequestActorContext,
    delivery: InvitationDelivery = "after_commit",
  ) {
    return this.dispatch.send(orgId, envelopeId, actor, delivery);
  }

  voidEnvelope(
    orgId: string,
    envelopeId: number,
    input: VoidEnvelopeInput,
    actor: RequestActorContext,
  ) {
    return this.lifecycle.voidEnvelope(orgId, envelopeId, input, actor);
  }

  correct(
    orgId: string,
    envelopeId: number,
    input: CorrectEnvelopeInput,
    actor: RequestActorContext,
  ) {
    return this.lifecycle.correct(orgId, envelopeId, input, actor);
  }

  resend(orgId: string, envelopeId: number, actor: RequestActorContext) {
    return this.dispatch.resend(orgId, envelopeId, actor);
  }

  extendExpiration(
    orgId: string,
    envelopeId: number,
    input: ExtendExpirationInput,
    actor: RequestActorContext,
  ) {
    return this.lifecycle.extendExpiration(orgId, envelopeId, input, actor);
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

  runReminderSweep(orgId: string) {
    return this.sweeps.runReminderSweep(orgId);
  }

  runExpirationSweep(orgId: string) {
    return this.sweeps.runExpirationSweep(orgId);
  }
}
