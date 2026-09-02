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
import { SignIntegrationsService } from "./sign-integrations.service";
import { isSigningType } from "./sign-envelope-validation.service";
import { isEnvelopeSignable } from "./sign-state";
import type { RequestActorContext } from "../../common/audit/actor-context";

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
        .where(eq(signRecipients.id, r.id));
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
        .where(eq(signEnvelopes.id, envelope.id));
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

  async runReminderSweep(): Promise<number> {
    const now = new Date();
    const candidates = await this.db.query.signEnvelopes.findMany({
      where: and(
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

  async runExpirationSweep(): Promise<number> {
    const now = new Date();
    const expiring = await this.db.query.signEnvelopes.findMany({
      where: and(
        inArray(signEnvelopes.status, [
          "sent",
          "delivered",
          "partially_completed",
        ]),
        lte(signEnvelopes.expiresAt, now),
      ),
    });

    for (const envelope of expiring) {
      await this.db
        .update(signRecipients)
        .set({ status: "expired", tokenRevokedAt: now })
        .where(
          and(
            eq(signRecipients.envelopeId, envelope.id),
            notInArray(signRecipients.status, [
              "completed",
              "declined",
              "delegated",
            ]),
          ),
        );
      await this.db
        .update(signEnvelopes)
        .set({ status: "expired" })
        .where(eq(signEnvelopes.id, envelope.id));
      await this.audit.record({
        orgId: envelope.orgId,
        envelopeId: envelope.id,
        actorType: "system",
        eventType: "envelope_expired",
        eventMessage: "Envelope expired automatically",
      });
      this.integrations.emitEnvelopeEvent(
        { ...envelope, status: "expired" },
        "expired",
      );
    }
    return expiring.length;
  }
}
