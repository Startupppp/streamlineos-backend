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
import {
  SWEEP_EXPECTED_WITHIN_HOURS,
  sweepStaleness,
  type SweepStaleness,
} from "./sign-sweep-staleness";

/**
 * Which of an envelope's recipients a reminder would go to.
 *
 * Shared by the sweep and its preview for the same reason the interval rule is:
 * the count a dry run reports has to be the count the real run produces, and
 * two copies of a filter are how those quietly diverge. A recipient with no
 * email or no issued token is skipped rather than failed — there is nothing to
 * remind them at.
 */
export function remindableRecipients<
  T extends {
    recipientType: string;
    status: string;
    email: string | null;
    signingTokenHash: string | null;
  },
>(recipients: T[]): Array<T & { email: string; signingTokenHash: string }> {
  return recipients.filter(
    (r): r is T & { email: string; signingTokenHash: string } =>
      isSigningType(r.recipientType) &&
      (r.status === "invited" || r.status === "viewed" || r.status === "authenticated") &&
      r.email !== null &&
      r.email !== "" &&
      r.signingTokenHash !== null,
  );
}

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

    for (const r of remindableRecipients(recipientRows)) {
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

  /**
   * The envelopes a reminder sweep would act on, right now.
   *
   * Split out so the dry run and the real run cannot disagree. A preview that
   * reimplements the interval arithmetic is worth nothing in staging — the
   * whole point of asking is to be told what the sweep will actually do, and a
   * second copy of the rule is exactly how the answer drifts from the act.
   */
  private async reminderDueEnvelopes(now: Date) {
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

    return candidates.filter((envelope) => {
      if (envelope.reminderSentCount >= envelope.reminderMaxCount) return false;
      const baseline = envelope.lastReminderAt ?? envelope.sentAt;
      if (!baseline) return false;
      const intervalDays =
        envelope.reminderSentCount === 0
          ? envelope.reminderFirstAfterDays
          : envelope.reminderRepeatDays;
      return addDays(baseline, intervalDays).getTime() <= now.getTime();
    });
  }

  /** The envelopes an expiration sweep would act on, right now. */
  private async expiringEnvelopes(now: Date) {
    return this.db.query.signEnvelopes.findMany({
      where: and(
        inArray(signEnvelopes.status, [
          "sent",
          "delivered",
          "partially_completed",
        ]),
        lte(signEnvelopes.expiresAt, now),
      ),
    });
  }

  async runReminderSweep(): Promise<number> {
    const now = new Date();
    let sentCount = 0;
    for (const envelope of await this.reminderDueEnvelopes(now)) {
      sentCount += await this.remindEnvelopeRecipients(envelope, "system");
    }
    return sentCount;
  }

  async runExpirationSweep(): Promise<number> {
    const now = new Date();
    const expiring = await this.expiringEnvelopes(now);

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
  async runSweepAllOrgs(
    sweep: "reminder" | "expiration",
    options: { dryRun?: boolean } = {},
  ): Promise<SweepAllResult> {
    const dryRun = options.dryRun === true;
    const failures: Array<{ orgId: string; message: string }> = [];
    let affected = 0;

    const outcome = await forEachOrg(this.db, `sign-${sweep}-sweep`, async (_tx, orgId) => {
      try {
        if (dryRun) {
          const preview = await this.previewSweep(sweep);
          affected += preview.affected;
          /**
           * Deliberately no `recordRun`. A dry run did not run the sweep, and
           * saying otherwise would let a staging rehearsal reset the staleness
           * clock that SIGN-P1-02 reads — the alert for "this sweep has not
           * fired" would then be silenced by the very thing that proves it has
           * not fired.
           */
          return;
        }
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
      dryRun,
      organizations: outcome.organizations,
      succeeded: outcome.succeeded,
      failed: outcome.failed,
      affected,
    };
  }

  /**
   * What the sweep would do to the organisation in the current tenant scope,
   * touching nothing.
   *
   * Both branches go through the same selection the real sweep uses, so this
   * answers "what will happen" rather than "what a second implementation
   * thinks will happen". `entries` is capped; the totals above it are not, so
   * a large preview is still numerically true.
   */
  async previewSweep(sweep: "reminder" | "expiration"): Promise<SweepPreview> {
    const now = new Date();
    const entries: SweepPreviewEntry[] = [];
    let envelopes = 0;
    let affected = 0;

    if (sweep === "reminder") {
      for (const envelope of await this.reminderDueEnvelopes(now)) {
        const recipients = remindableRecipients(
          await this.recipients.listForEnvelope(envelope.orgId, envelope.id),
        ).length;
        /**
         * A due envelope whose recipients have all signed or declined sends
         * nothing, and the real sweep counts nothing for it. Listing it here
         * would over-promise.
         */
        if (recipients === 0) continue;
        envelopes += 1;
        affected += recipients;
        if (entries.length < SWEEP_PREVIEW_LIMIT)
          entries.push({ envelopeId: envelope.id, title: envelope.title, affected: recipients });
      }
    } else {
      for (const envelope of await this.expiringEnvelopes(now)) {
        envelopes += 1;
        affected += 1;
        if (entries.length < SWEEP_PREVIEW_LIMIT)
          entries.push({ envelopeId: envelope.id, title: envelope.title, affected: 1 });
      }
    }

    return {
      sweep,
      envelopes,
      affected,
      entries,
      /** The totals above are exact; only the listing is capped. */
      truncated: envelopes > entries.length,
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
      const staleness = sweepStaleness(row ? { ranAt: row.ranAt, error: row.error } : null);
      return {
        sweep,
        ranAt: row?.ranAt ? row.ranAt.toISOString() : null,
        affected: row?.affected ?? 0,
        error: row?.error ?? null,
        neverRun: !row,
        /** SIGN-P1-02: the same judgement the platform alert makes. */
        staleness,
        healthy: staleness === "ok",
        expectedWithinHours: SWEEP_EXPECTED_WITHIN_HOURS,
      };
    });
  }
}

const SWEEP_PREVIEW_LIMIT = 100;

export interface SweepPreviewEntry {
  envelopeId: number;
  title: string;
  affected: number;
}

export interface SweepPreview {
  sweep: "reminder" | "expiration";
  envelopes: number;
  affected: number;
  entries: SweepPreviewEntry[];
  truncated: boolean;
}

export interface SweepAllResult {
  sweep: "reminder" | "expiration";
  dryRun: boolean;
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
  staleness: SweepStaleness;
  healthy: boolean;
  expectedWithinHours: number;
}
