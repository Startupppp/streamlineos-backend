import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, inArray, lte, notInArray } from "drizzle-orm";
import { addDays } from "date-fns";
import { signEnvelopes, signRecipients, signSweepRuns, users } from "../../db/schema";
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
import { forEachOrg } from "../../common/tenant/for-each-org";
import { runInNewTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";

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

  private async senderName(userId: string): Promise<string> {
    const user = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
    });
    return user?.name ?? "A StreamlineOS user";
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
    const senderNameStr = await this.senderName(envelope.senderUserId);
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
          reminderSentCount: envelope.reminderSentCount + 1,
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

  /**
   * Both sweeps, across every organisation, for the platform scheduler.
   *
   * The per-organisation methods above query `sign_envelopes` with no `org_id`
   * filter. That is not a bug where they are called from — an admin request
   * runs inside its own tenant transaction and RLS narrows the query to that
   * organisation — but it means they cannot simply be called from a cron
   * endpoint, which has no tenant context at all. `sign_envelopes` uses the
   * raising accessor, so such a call fails outright rather than sweeping
   * nothing quietly.
   *
   * `forEachOrg` supplies the context per organisation, which also keeps one
   * tenant's failure from stopping the rest.
   */
  async runSweepAllOrgs(sweep: "reminder" | "expiration"): Promise<SweepAllResult> {
    const failures: Array<{ orgId: string; message: string }> = [];
    let affected = 0;

    const outcome = await forEachOrg(this.db, `sign-${sweep}-sweep`, async (_tx, orgId) => {
      try {
        const count =
          sweep === "reminder" ? await this.runReminderSweep() : await this.runExpirationSweep();
        affected += count;
        await this.recordRun(orgId, sweep, count, null);
      } catch (error) {
        /**
         * Remembered, then rethrown. `forEachOrg` rolls this organisation's
         * transaction back and carries on, so a failure row written here would
         * roll back with it — the one case where the record matters most would
         * be the one case that never persists. It is written afterwards, in a
         * transaction of its own.
         */
        failures.push({
          orgId,
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    });

    for (const failure of failures) {
      await runInNewTenantTransaction(this.db, failure.orgId, () =>
        this.recordRun(failure.orgId, sweep, 0, failure.message),
      ).catch(() => undefined);
    }

    return {
      sweep,
      organizations: outcome.organizations,
      succeeded: outcome.succeeded,
      failed: outcome.failed,
      affected,
    };
  }

  /** Last run per (organisation, sweep). Upserted, because only the latest matters. */
  private async recordRun(
    orgId: string,
    sweep: "reminder" | "expiration",
    affected: number,
    error: string | null,
  ): Promise<void> {
    await this.db
      .insert(signSweepRuns)
      .values({ orgId, sweep, affected, error, ranAt: new Date() })
      .onConflictDoUpdate({
        target: [signSweepRuns.orgId, signSweepRuns.sweep],
        set: { affected, error, ranAt: new Date(), updatedAt: new Date() },
      });
  }

  /** What an admin screen reads to answer "did this ever run, and did it work". */
  async lastRuns(orgId: string): Promise<SignSweepRunSummary[]> {
    const rows = await this.db
      .select({
        sweep: signSweepRuns.sweep,
        ranAt: signSweepRuns.ranAt,
        affected: signSweepRuns.affected,
        error: signSweepRuns.error,
      })
      .from(signSweepRuns)
      .where(eq(signSweepRuns.orgId, orgId));

    /**
     * Both sweeps are always reported, present or not. An absent row means
     * "never run", and that is the answer worth showing — omitting it lets a
     * screen render nothing and look fine.
     */
    return (["reminder", "expiration"] as const).map((sweep) => {
      const row = rows.find((r) => r.sweep === sweep);
      return {
        sweep,
        ranAt: row?.ranAt ? row.ranAt.toISOString() : null,
        affected: row?.affected ?? 0,
        error: row?.error ?? null,
        neverRun: !row,
      };
    });
  }
}

export interface SweepAllResult {
  sweep: "reminder" | "expiration";
  organizations: number;
  succeeded: number;
  failed: number;
  affected: number;
}

export interface SignSweepRunSummary {
  sweep: "reminder" | "expiration";
  ranAt: string | null;
  affected: number;
  error: string | null;
  neverRun: boolean;
}
