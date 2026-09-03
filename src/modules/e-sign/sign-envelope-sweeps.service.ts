import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, inArray, lte, notInArray, sql } from "drizzle-orm";
import { addDays } from "date-fns";
import { organizationMembers, signEnvelopes, signRecipients } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { SignAuditService } from "./sign-audit.service";
import { SignTokensService } from "./sign-tokens.service";
import { SignNotificationsService } from "./sign-notifications.service";
import { SignRecipientsService } from "./sign-recipients.service";
import { SYSTEM_ENVELOPE_SCOPE } from "./sign-envelope-scope";
import { SignIntegrationsService } from "./sign-integrations.service";
import { isSigningType } from "./sign-envelope-validation.service";
import { isEnvelopeSignable } from "./sign-state";
import type { RequestActorContext } from "../../common/audit/actor-context";

/**
 * Envelopes flipped per statement.
 *
 * The three writes an expiring envelope needs — its recipients, its own status
 * and its `envelope_expired` audit row — are uniform across the batch, so they
 * become three statements per chunk rather than three per envelope. 500 ids is
 * ~500 bound parameters per `inArray`, two orders of magnitude under the 65,535
 * a single Postgres statement can bind.
 *
 * Batching here does NOT widen a lost-audit window. `runExpirationSweep` is
 * reachable only from `POST /sign/admin/run-expiration-sweep`, which carries no
 * `@NoTenantTransaction`, so `TenantContextInterceptor` already wraps the whole
 * call in one transaction and the DRIZZLE proxy routes every statement below
 * into it: the status flips and the audit rows commit or roll back together,
 * one envelope at a time or five hundred. What the per-envelope loop bought was
 * not atomicity but 3N round trips inside that transaction.
 */
const EXPIRATION_SWEEP_CHUNK = 500;

@Injectable()
export class SignEnvelopeSweepsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: SignAuditService,
    private readonly tokens: SignTokensService,
    private readonly notifications: SignNotificationsService,
    private readonly recipients: SignRecipientsService,
    private readonly integrations: SignIntegrationsService,
  ) {}

  private async findEnvelope(orgId: string, envelopeId: number) {
    const row = await this.db.query.signEnvelopes.findFirst({
      where: and(eq(signEnvelopes.id, envelopeId), eq(signEnvelopes.orgId, orgId)),
    });
    if (!row) throw new NotFoundException("Envelope not found");
    return row;
  }

  private async senderName(orgId: string, membershipId: number | null | undefined): Promise<string> {
    if (membershipId == null) return "A StreamlineOS user";
    const member = await this.db.query.organizationMembers.findFirst({
      where: and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.id, membershipId)),
      with: { user: { columns: { name: true } } },
    });
    return member?.user?.name ?? "A StreamlineOS user";
  }

  private async remindEnvelopeRecipients(
    envelope: typeof signEnvelopes.$inferSelect,
    actorType: "system" | "internal_user",
    actorUserId?: string,
  ): Promise<number> {
    const now = new Date();
    const recipientRows = await this.recipients.listForEnvelope(
      envelope.orgId,
      envelope.id,
      SYSTEM_ENVELOPE_SCOPE,
    );
    const senderNameStr = await this.senderName(envelope.orgId, envelope.senderMembershipId);
    let remindedCount = 0;

    for (const r of recipientRows) {
      if (!isSigningType(r.recipientType)) continue;
      if (
        r.status !== "invited" &&
        r.status !== "viewed" &&
        r.status !== "authenticated"
      )
        continue;
      if (!r.email || !r.signingTokenHash) continue;

      const rawToken = this.tokens.generateSigningToken();
      await this.db
        .update(signRecipients)
        .set({ signingTokenHash: this.tokens.hash(rawToken) })
        .where(and(eq(signRecipients.id, r.id), eq(signRecipients.orgId, envelope.orgId)));
      const signingUrl = this.tokens.buildSigningUrl(rawToken);
      const daysRemaining = envelope.expiresAt
        ? Math.max(
            0,
            Math.ceil(
              (envelope.expiresAt.getTime() - now.getTime()) / 86_400_000,
            ),
          )
        : null;
      await this.notifications.sendReminder(
        r.email,
        r.name,
        senderNameStr,
        envelope.title,
        signingUrl,
        daysRemaining,
      );
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
        .set({
          reminderSentCount: sql`${signEnvelopes.reminderSentCount} + 1`,
          lastReminderAt: now,
        })
        .where(and(eq(signEnvelopes.id, envelope.id), eq(signEnvelopes.orgId, envelope.orgId)));
    }
    return remindedCount;
  }

  async sendManualReminder(
    orgId: string,
    envelopeId: number,
    actor: RequestActorContext,
  ): Promise<{ remindedCount: number }> {
    const envelope = await this.findEnvelope(orgId, envelopeId);
    if (!isEnvelopeSignable(envelope.status)) {
      throw new ForbiddenException(
        "Reminders can only be sent for envelopes awaiting signature",
      );
    }
    const remindedCount = await this.remindEnvelopeRecipients(
      envelope,
      "internal_user",
      actor.userId,
    );
    return { remindedCount };
  }

  /**
   * The sweeps are reached from `POST /sign/admin/run-*-sweep`, so they run for
   * one organisation — the caller's. `orgId` is REQUIRED rather than optional:
   * an optional tenant filter with an all-organisations default is the
   * fail-open shape, and without the predicate these queries selected every
   * organisation's envelopes and were confined only by whatever tenant GUC the
   * ambient transaction happened to carry. A holder of `sign:admin:manage`
   * would otherwise expire another tenant's envelopes and mail that tenant's
   * signers a freshly minted signing link.
   */
  async runReminderSweep(orgId: string): Promise<number> {
    const now = new Date();
    const candidates = await this.db.query.signEnvelopes.findMany({
      where: and(
        eq(signEnvelopes.orgId, orgId),
        inArray(signEnvelopes.status, [
          "sent",
          "delivered",
          "partially_completed",
        ]),
        eq(signEnvelopes.reminderEnabled, true),
      ),
    });

    let sentCount = 0;
    for (const envelope of candidates) {
      if (envelope.reminderSentCount >= envelope.reminderMaxCount) continue;
      const baseline = envelope.lastReminderAt ?? envelope.sentAt;
      if (!baseline) continue;
      const intervalDays =
        envelope.reminderSentCount === 0
          ? envelope.reminderFirstAfterDays
          : envelope.reminderRepeatDays;
      if (addDays(baseline, intervalDays).getTime() > now.getTime()) continue;

      sentCount += await this.remindEnvelopeRecipients(envelope, "system");
    }
    return sentCount;
  }

  async runExpirationSweep(orgId: string): Promise<number> {
    const now = new Date();
    const expiring = await this.db.query.signEnvelopes.findMany({
      where: and(
        eq(signEnvelopes.orgId, orgId),
        inArray(signEnvelopes.status, [
          "sent",
          "delivered",
          "partially_completed",
        ]),
        lte(signEnvelopes.expiresAt, now),
      ),
    });

    if (expiring.length === 0) return 0;

    for (let offset = 0; offset < expiring.length; offset += EXPIRATION_SWEEP_CHUNK) {
      const batch = expiring.slice(offset, offset + EXPIRATION_SWEEP_CHUNK);
      const envelopeIds = batch.map((envelope) => envelope.id);
      await this.db
        .update(signRecipients)
        .set({ status: "expired", tokenRevokedAt: now })
        .where(
          and(
            eq(signRecipients.orgId, orgId),
            inArray(signRecipients.envelopeId, envelopeIds),
            notInArray(signRecipients.status, ["completed", "declined", "delegated"]),
          ),
        );
      await this.db
        .update(signEnvelopes)
        .set({ status: "expired" })
        .where(and(eq(signEnvelopes.orgId, orgId), inArray(signEnvelopes.id, envelopeIds)));
      await this.audit.record(
        batch.map((envelope) => ({
          orgId: envelope.orgId,
          envelopeId: envelope.id,
          actorType: "system" as const,
          eventType: "envelope_expired" as const,
          eventMessage: "Envelope expired automatically",
        })),
      );
    }

    for (const envelope of expiring)
      this.integrations.emitEnvelopeEvent({ ...envelope, status: "expired" }, "expired");

    return expiring.length;
  }
}
