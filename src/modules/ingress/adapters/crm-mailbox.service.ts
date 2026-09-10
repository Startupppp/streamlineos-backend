import { ConflictException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { resolvePush } from "./mailbox-push-route";
import { and, asc, eq, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.types";
import { crmMailboxSync, userIntegrationConnections } from "../../../db/schema";
import type { NormalizerConnectionMeta } from "../../mail/providers/mail-normalizers";
import { GmailMailProvider } from "../../mail/providers/gmail-mail.provider";
import { OutlookMailProvider } from "../../mail/providers/outlook-mail.provider";
import { InboundIngressService } from "../inbound-ingress.service";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { logger } from "../../../common/logger/logger.service";
import { mailToInboundEvent, type MailMessageForIngress } from "./mail-to-inbound-event";
import { advanceWatermark, planSweep } from "./mailbox-sync";
import {
  forIngress,
  sweepNote,
  type SweepRead,
} from "./crm-mailbox-sweep-types";
import {
  enrichWithDetail,
  fetchGmailMessages,
  fetchOutlookMessages,
} from "./crm-mailbox-provider-fetch";

/**
 * A mailbox feeding the CRM.
 *
 * Connecting a mailbox to StreamlineOS and pointing it at the CRM are two
 * different decisions, and this keeps them apart. Somebody may want their inbox
 * in the Mail module without every message they receive becoming a customer
 * record — so the connection is the integrations module's, and the opt-in is
 * here.
 */
@Injectable()
export class CrmMailboxService {
  private readonly logger = new Logger("CrmMailbox");

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly ingress: InboundIngressService,
    private readonly gmail: GmailMailProvider,
    private readonly outlook: OutlookMailProvider,
  ) {}

  /**
   * A provider push, which is a doorbell rather than a delivery.
   *
   * Runs outside any tenant context, because a push arrives with no session and
   * no organisation — the mailbox row is what supplies the tenant. So the lookup
   * is deliberately unscoped by `organization_id`, and `resolvePush` is what
   * makes that safe: the row's own secret has to verify the body before its
   * tenant is used for anything.
   *
   * Push is the fast path, never the truth. It only pulls the mailbox's next
   * sweep forward; the periodic sweep still runs and still closes whatever gap
   * push left, which is why a missed or forged-and-rejected notification costs
   * latency rather than data.
   */
  async push(rawBody: string, signature: string | undefined): Promise<void> {
    const parsed = ((): { resource?: unknown; provider?: unknown } => {
      try {
        return JSON.parse(rawBody) as { resource?: unknown; provider?: unknown };
      } catch {
        return {};
      }
    })();

    const address = typeof parsed.resource === "string" ? parsed.resource.trim() : "";
    const provider = parsed.provider;
    if (!address || (provider !== "gmail" && provider !== "outlook")) return;

    const [row] = await this.db
      .select({
        crmMailboxSyncId: crmMailboxSync.crmMailboxSyncId,
        organizationId: crmMailboxSync.organizationId,
        provider: crmMailboxSync.provider,
        mailboxAddress: crmMailboxSync.mailboxAddress,
        pushSecret: crmMailboxSync.pushSecret,
        enabled: crmMailboxSync.enabled,
      })
      .from(crmMailboxSync)
      .where(
        and(
          eq(crmMailboxSync.provider, provider),
          eq(crmMailboxSync.mailboxAddress, address),
          eq(crmMailboxSync.enabled, true),
        ),
      )
      .limit(1);

    const verdict = resolvePush(rawBody, signature, row ?? null);
    if (!verdict.ok) return;

    await runInNewTenantTransaction(this.db, verdict.organizationId, async () => {
      await this.sync(verdict.organizationId, verdict.crmMailboxSyncId);
    });
  }

  /** Every mailbox this organisation has pointed at the CRM. */
  async list(organizationId: string) {
    return this.db
      .select({
        crmMailboxSyncId: crmMailboxSync.crmMailboxSyncId,
        connectionId: crmMailboxSync.connectionId,
        mailboxAddress: crmMailboxSync.mailboxAddress,
        provider: crmMailboxSync.provider,
        enabled: crmMailboxSync.enabled,
        syncedThrough: crmMailboxSync.syncedThrough,
        lastRunAt: crmMailboxSync.lastRunAt,
        lastError: crmMailboxSync.lastError,
        consecutiveFailures: crmMailboxSync.consecutiveFailures,
      })
      .from(crmMailboxSync)
      .where(eq(crmMailboxSync.organizationId, organizationId))
      .orderBy(asc(crmMailboxSync.mailboxAddress))
      .limit(100);
  }

  /**
   * Point an already-connected mailbox at the CRM.
   *
   * The connection has to exist and belong to this organisation — this endpoint
   * cannot create one, because authorising a mailbox is the provider's flow and
   * borrowing somebody else's connection id would be the whole point of trying.
   */
  async enable(organizationId: string, userId: string, connectionId: number) {
    const [connection] = await this.db
      .select({
        id: userIntegrationConnections.id,
        toolkit: userIntegrationConnections.toolkit,
        accountEmail: userIntegrationConnections.accountEmail,
        status: userIntegrationConnections.status,
      })
      .from(userIntegrationConnections)
      .where(
        and(
          eq(userIntegrationConnections.id, connectionId),
          eq(userIntegrationConnections.orgId, organizationId),
          eq(userIntegrationConnections.userId, userId),
        ),
      )
      .limit(1);

    if (!connection) throw new NotFoundException("Mailbox not found");

    if (connection.toolkit !== "gmail" && connection.toolkit !== "outlook")
      throw new ConflictException("That connection is not a mailbox.");

    if (!connection.accountEmail)
      throw new ConflictException(
        "That mailbox has no address yet — finish authorising it and try again.",
      );

    const [row] = await this.db
      .insert(crmMailboxSync)
      .values({
        organizationId,
        connectionId,
        mailboxAddress: connection.accountEmail.toLowerCase(),
        provider: connection.toolkit,
        enabled: true,
      })
      .onConflictDoUpdate({
        target: [crmMailboxSync.organizationId, crmMailboxSync.connectionId],
        set: { enabled: true, lastError: null, consecutiveFailures: 0 },
      })
      .returning({ id: crmMailboxSync.crmMailboxSyncId });

    return { crmMailboxSyncId: row?.id ?? null, enabled: true };
  }

  /**
   * Stop a mailbox feeding the CRM.
   *
   * Disabled rather than deleted, deliberately. The watermark is the record of
   * what has already been filed; deleting it would mean re-enabling later
   * re-imported everything from the lookback window, duplicating months of
   * correspondence. Nothing already filed is removed — those are real
   * activities on real records now.
   */
  async disable(organizationId: string, crmMailboxSyncId: string) {
    const updated = await this.db
      .update(crmMailboxSync)
      .set({ enabled: false })
      .where(
        and(
          eq(crmMailboxSync.organizationId, organizationId),
          eq(crmMailboxSync.crmMailboxSyncId, crmMailboxSyncId),
        ),
      )
      .returning({ id: crmMailboxSync.crmMailboxSyncId });

    if (updated.length === 0) throw new NotFoundException("Mailbox not found");
    return { enabled: false };
  }

  /**
   * Read a mailbox forward and offer everything new to the seam.
   *
   * Returns counts rather than throwing on a provider error: the caller is
   * either a sweep over every mailbox or a webhook, and one revoked mailbox must
   * not stop the others.
   */
  async sync(organizationId: string, crmMailboxSyncId: string) {
    const [row] = await this.db
      .select()
      .from(crmMailboxSync)
      .where(
        and(
          eq(crmMailboxSync.organizationId, organizationId),
          eq(crmMailboxSync.crmMailboxSyncId, crmMailboxSyncId),
        ),
      )
      .limit(1);

    if (!row) throw new NotFoundException("Mailbox not found");

    const plan = planSweep({
      syncedThrough: row.syncedThrough,
      enabled: row.enabled,
      consecutiveFailures: row.consecutiveFailures,
    });

    if (!plan.sweep) return { swept: false as const, reason: plan.reason };

    /**
     * The connection is the source of truth for whether this mailbox still
     * exists. Composio's disconnect deletes the connection row, and a sync row
     * pointing at nothing would otherwise fail forever against a provider that
     * has never heard of it.
     */
    const [connection] = await this.db
      .select({
        userId: userIntegrationConnections.userId,
        composioAccountId: userIntegrationConnections.composioConnectedAccountId,
        status: userIntegrationConnections.status,
      })
      .from(userIntegrationConnections)
      .where(
        and(
          eq(userIntegrationConnections.id, row.connectionId),
          eq(userIntegrationConnections.orgId, organizationId),
        ),
      )
      .limit(1);

    if (!connection) {
      await this.db
        .update(crmMailboxSync)
        .set({ enabled: false, lastError: "The mailbox was disconnected." })
        .where(eq(crmMailboxSync.crmMailboxSyncId, crmMailboxSyncId));
      return { swept: false as const, reason: "disconnected" as const };
    }

    /**
     * A mailbox awaiting re-authorisation is skipped, not failed.
     *
     * Counting it as a failure would burn through the failure budget while
     * somebody is being asked to click a button, and then stop sweeping the
     * mailbox permanently the moment they finally did. The watermark stays
     * exactly where it is, so re-authorising resumes rather than re-imports.
     */
    if (connection.status === "needs_reauth")
      return { swept: false as const, reason: "needs-reauth" as const };

    try {
      const read = await this.fetch(
        row.provider,
        connection.userId,
        connection.composioAccountId,
        plan.since,
      );

      let delivered = 0;
      let skipped = 0;
      let unjudged = 0;
      let newest: Date | null = null;

      for (const message of read.messages) {
        const result = mailToInboundEvent(message, {
          organizationId,
          provider: row.provider,
          mailboxAddress: row.mailboxAddress,
          privateLabelRule: read.privateLabelRule,
        });

        if (result.ok) {
          await this.ingress.accept(result.event, organizationId);
          delivered += 1;
        } else {
          skipped += 1;
          if (result.reason === "labels-unknown") unjudged += 1;
        }

        const at = this.watermarkTimestamp(message, result);
        if (at && (!newest || at > newest)) newest = at;
      }

      /**
       * How far the watermark may move, given how much of the window was read.
       *
       * A truncated read has offered the newest of the window and not the rest,
       * and the watermark is a single instant: it cannot say "everything up to
       * here except a hole in the middle". So the two cases are different.
       *
       * A first sweep truncating means the initial lookback held more mail than
       * one sweep can carry. That window is a courtesy backfill, not a delivery
       * promise, so the watermark moves and the oldest of it is left where it
       * is — the alternative is a mailbox that re-reads the same newest 2,500
       * messages every few minutes forever and never files a message that
       * arrives after it was connected.
       *
       * Any later sweep truncating means mail that arrived *after* the mailbox
       * was connected is at risk, and that is not a courtesy. The watermark is
       * held so nothing is skipped, and the note below says so.
       */
      const holdWatermark = read.truncated && !plan.firstRun;

      await this.db
        .update(crmMailboxSync)
        .set({
          syncedThrough: holdWatermark
            ? row.syncedThrough
            : advanceWatermark(row.syncedThrough, newest),
          lastRunAt: new Date(),
          lastError: sweepNote(read.truncated, plan.firstRun, read.messages.length, unjudged),
          consecutiveFailures: 0,
        })
        .where(eq(crmMailboxSync.crmMailboxSyncId, crmMailboxSyncId));

      return {
        swept: true as const,
        delivered,
        skipped,
        unjudged,
        read: read.messages.length,
        truncated: read.truncated,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("crm mailbox sweep failed", {
        organizationId,
        crmMailboxSyncId,
        mailboxEmailAddress: row.mailboxAddress,
        error: message,
      });

      await this.db
        .update(crmMailboxSync)
        .set({
          lastRunAt: new Date(),
          lastError: message.slice(0, 500),
          consecutiveFailures: sql`${crmMailboxSync.consecutiveFailures} + 1`,
        })
        .where(eq(crmMailboxSync.crmMailboxSyncId, crmMailboxSyncId));

      return { swept: false as const, reason: "provider-error" as const };
    }
  }

  /** Every enabled mailbox in this organisation, oldest run first. */
  async sweepAll(organizationId: string) {
    const due = await this.db
      .select({ id: crmMailboxSync.crmMailboxSyncId })
      .from(crmMailboxSync)
      .where(
        and(eq(crmMailboxSync.organizationId, organizationId), eq(crmMailboxSync.enabled, true)),
      )
      .orderBy(sql`${crmMailboxSync.lastRunAt} ASC NULLS FIRST`)
      .limit(50);

    let swept = 0;
    let delivered = 0;

    for (const mailbox of due) {
      const result = await this.sync(organizationId, mailbox.id);
      if (result.swept) {
        swept += 1;
        delivered += result.delivered;
      }
    }

    return { mailboxes: due.length, swept, delivered };
  }

  /**
   * The timestamp a message contributes to the watermark, if any.
   *
   * "Everything at or before the watermark has been offered" — so a message the
   * adapter judged counts whether it was filed or refused; a private one was
   * looked at and deliberately not filed, and re-reading it forever would be
   * pointless.
   *
   * Two do not count. A message refused for want of labels was never judged at
   * all, and moving past it would mean it is never judged. And an estimated
   * timestamp is this instant rather than the message's, so letting it through
   * would set "everything up to now has been read" off the back of one
   * malformed `Date:` header — skipping whatever the provider had not yet
   * indexed, which is the exact gap the watermark exists to close.
   */
  private watermarkTimestamp(
    message: MailMessageForIngress,
    result: ReturnType<typeof mailToInboundEvent>,
  ): Date | null {
    if (result.ok && result.occurredAtEstimated) return null;
    if (!result.ok && result.reason === "labels-unknown") return null;

    const at = new Date(result.ok ? result.event.occurredAt : (message.date ?? ""));
    return Number.isNaN(at.getTime()) ? null : at;
  }

  private async fetch(
    provider: "gmail" | "outlook",
    userId: string,
    composioAccountId: string,
    since: Date,
  ): Promise<SweepRead> {
    const conn: NormalizerConnectionMeta = {
      id: 0,
      composioAccountId,
      provider,
      accountEmail: null,
    };

    const read =
      provider === "gmail"
        ? await fetchGmailMessages(this.gmail, userId, conn, since)
        : await fetchOutlookMessages(this.outlook, userId, conn, since);

    return { ...read, messages: await enrichWithDetail(provider, this.gmail, this.outlook, userId, conn, read.messages, this.logger) };
  }
}
