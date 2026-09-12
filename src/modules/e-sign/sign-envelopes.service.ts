import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, count, eq, isNull, type SQL } from "drizzle-orm";
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
import { envelopeSenderScope, systemEnvelopeScope } from "./sign-envelope-scope";
import type { ScopedRead } from "../access/scoped-read";
import { buildListResponse } from "../../common/pagination/pagination";
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
import {
  canTransitionEnvelope,
  isEnvelopeEditable,
  isEnvelopeSignable,
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
import { registerAfterCommit } from "../../common/tenant/tenant-context";

export type { EnvelopeValidationResult };

function isSignEnvelopeStatus(value: string): value is SignEnvelopeStatus {
  return signEnvelopeStatusEnum.enumValues.some((status) => status === value);
}

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

  async list(
    read: ScopedRead,
    membershipId: number | null,
    query: ListEnvelopesInput,
  ) {
    const pageParams = { page: query.page, pageSize: query.limit };
    const domain: SQL[] = [];
    if (query.status) {
      if (!isSignEnvelopeStatus(query.status)) {
        throw new BadRequestException(
          `Invalid envelope status: ${query.status}`,
        );
      }
      domain.push(eq(signEnvelopes.status, query.status));
    }
    if (query.sourceModule)
      domain.push(eq(signEnvelopes.sourceModule, query.sourceModule));
    if (query.sourceEntityType)
      domain.push(
        eq(signEnvelopes.sourceEntityType, query.sourceEntityType),
      );
    if (query.sourceEntityId)
      domain.push(eq(signEnvelopes.sourceEntityId, query.sourceEntityId));

    return read.read(
      { tenant: signEnvelopes.orgId, scope: envelopeSenderScope(membershipId), and: domain },
      async ({ sql: where }) => {
        const [rows, [totalRow]] = await Promise.all([
          this.db.query.signEnvelopes.findMany({
            where,
            orderBy: (e, { desc }) => [desc(e.createdAt)],
            limit: query.limit,
            offset: (query.page - 1) * query.limit,
          }),
          this.db.select({ total: count() }).from(signEnvelopes).where(where),
        ]);

        return buildListResponse(rows, Number(totalRow?.total ?? 0), pageParams);
      },
      () => buildListResponse([], 0, pageParams),
    );
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

  async getFull(read: ScopedRead, membershipId: number | null, envelopeId: number) {
    const orgId = read.orgId;
    const envelope = await this.mustGet(orgId, envelopeId);
    // Kept as an application-level check, not a `mustGetVisibleEnvelope` predicate:
    // this endpoint has always answered a same-tenant, out-of-scope envelope with
    // 403 (never the 404 that a row-filter miss would produce), so the raw value is
    // read here rather than folding this into the shared 404-only helper.
    if (!read.unrestricted && (membershipId == null || envelope.senderMembershipId !== membershipId)) {
      throw new ForbiddenException("Not authorized to view this envelope");
    }
    const [documents, recipientRows, fields] = await Promise.all([
      this.db.query.signDocuments.findMany({
        where: and(
          eq(signDocuments.orgId, orgId),
          eq(signDocuments.envelopeId, envelopeId),
        ),
        orderBy: (d, { asc }) => [asc(d.orderIndex)],
      }),
      this.recipients.listForEnvelope(systemEnvelopeScope(orgId), null, envelopeId),
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

  send(
    orgId: string,
    envelopeId: number,
    actor: RequestActorContext,
    delivery: InvitationDelivery = "after_commit",
  ) {
    return this.dispatch.send(orgId, envelopeId, actor, delivery);
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
      await tx
        .update(signRecipients)
        .set({ tokenRevokedAt: new Date() })
        .where(
          and(
            eq(signRecipients.orgId, orgId),
            eq(signRecipients.envelopeId, envelopeId),
            isNull(signRecipients.completedAt),
          ),
        );

      const [row] = await tx
        .update(signEnvelopes)
        .set({
          status: "voided",
          voidedAt: new Date(),
          voidedByMembershipId: actor.membershipId,
          voidReason: input.reason,
        })
        .where(eq(signEnvelopes.id, envelopeId))
        .returning();

      return row;
    });

    const recipientRows = await this.recipients.listForEnvelope(
      systemEnvelopeScope(orgId),
      null,
      envelopeId,
    );
    /*
     * The inner `transaction` above is a savepoint inside the request's
     * transaction, so "after it returns" is still before anything is durable.
     * A voided notice that goes out and is then rolled back tells every
     * recipient about a void that never happened; it waits for the commit.
     */
    const notifyRecipients = async () => {
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
    };
    if (!registerAfterCommit(notifyRecipients)) await notifyRecipients();

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

    /*
     * Each patched recipient must belong to THIS envelope. `recipients.update`
     * is org-bound only, so without this a `sign:envelope:correct` holder could
     * reach any recipient in the organisation through any envelope's correct
     * route, and the audit row would land on the wrong envelope. Out of
     * envelope reads as not found, the same answer a foreign id gets.
     */
    for (const patch of input.recipients ?? []) {
      const current = await this.recipients.get(orgId, patch.id);
      if (current.envelopeId !== envelopeId) throw new NotFoundException("Recipient not found");
      const updated = await this.recipients.update(
        orgId,
        patch.id,
        { name: patch.name, email: patch.email, phone: patch.phone },
        actor,
      );
      if (patch.email !== undefined && patch.email !== current.email && updated.email)
        await this.dispatch.reinviteCorrectedRecipient(
          orgId,
          envelopeId,
          { ...updated, email: updated.email },
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

    /*
     * Only an envelope that can still be signed, or one that expired and can
     * be reopened, has an expiry to move. A completed or voided envelope is
     * closed history; a declined one waits on a correction, not a date.
     */
    const reopening = envelope.status === "expired";
    if (!reopening && !isEnvelopeSignable(envelope.status) && !isEnvelopeEditable(envelope.status))
      throw new ConflictException(`A ${envelope.status} envelope's expiration cannot be extended`);
    if (reopening && !canTransitionEnvelope(envelope.status, "sent"))
      throw new ConflictException("This envelope cannot be reopened");

    const nextStatus: SignEnvelopeStatus = reopening ? "sent" : envelope.status;

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
      .where(and(eq(signEnvelopes.id, envelopeId), eq(signEnvelopes.orgId, orgId)))
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

    /* The sweep revoked their tokens with the expiry; the reopened envelope needs them back. */
    if (reopening) await this.dispatch.reviveExpiredRecipients(orgId, envelopeId, newExpiresAt, actor);

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

  runReminderSweep(orgId: string) {
    return this.sweeps.runReminderSweep(orgId);
  }

  runExpirationSweep(orgId: string) {
    return this.sweeps.runExpirationSweep(orgId);
  }
}
