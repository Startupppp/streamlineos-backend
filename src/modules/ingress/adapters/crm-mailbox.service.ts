import { ConflictException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { and, asc, eq, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.types";
import { crmMailboxSync, userIntegrationConnections } from "../../../db/schema";
import { GmailMailProvider } from "../../mail/providers/gmail-mail.provider";
import { OutlookMailProvider } from "../../mail/providers/outlook-mail.provider";
import { InboundIngressService } from "../inbound-ingress.service";
import { mailToInboundEvent, type MailMessageForIngress } from "./mail-to-inbound-event";
import { advanceWatermark, planSweep } from "./mailbox-sync";

/** One sweep's ceiling. A backlog is drained over several rather than in one. */
const MAX_PER_SWEEP = 100;

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

    // Another user's connection is indistinguishable from one that is not there.
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
      // Re-enabling a mailbox somebody turned off keeps its watermark, which is
      // what stops a re-enable from re-importing a year of mail.
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
      const messages = await this.fetch(
        row.provider,
        connection.userId,
        connection.composioAccountId,
        plan.since,
      );

      let delivered = 0;
      let skipped = 0;
      let newest: Date | null = null;

      for (const message of messages) {
        const result = mailToInboundEvent(message, {
          organizationId,
          provider: row.provider,
          mailboxAddress: row.mailboxAddress,
        });

        if (!result.ok) {
          skipped += 1;
          continue;
        }

        // Delivered one at a time so a single malformed message cannot lose the
        // batch. The seam deduplicates, so the overlap costs nothing.
        await this.ingress.accept(result.event);
        delivered += 1;

        const at = new Date(result.event.occurredAt);
        if (!Number.isNaN(at.getTime()) && (!newest || at > newest)) newest = at;
      }

      await this.db
        .update(crmMailboxSync)
        .set({
          syncedThrough: advanceWatermark(row.syncedThrough, newest),
          lastRunAt: new Date(),
          lastError: null,
          consecutiveFailures: 0,
        })
        .where(eq(crmMailboxSync.crmMailboxSyncId, crmMailboxSyncId));

      return { swept: true as const, delivered, skipped, read: messages.length };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`sweep failed for ${row.mailboxAddress}: ${message}`);

      /**
       * The watermark is deliberately NOT advanced on failure. Advancing it
       * would skip whatever the failed sweep would have read, permanently.
       */
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
      // Nulls first: a mailbox that has never run is the most overdue.
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

  /** The provider call, and the only place either provider is named. */
  private async fetch(
    provider: "gmail" | "outlook",
    userId: string,
    composioAccountId: string,
    since: Date,
  ): Promise<MailMessageForIngress[]> {
    const conn = { composioAccountId, accountId: 0, provider } as never;

    // Both providers take a query; a date bound is what keeps a sweep bounded
    // rather than reading an entire mailbox every time.
    const query =
      provider === "gmail"
        ? `after:${Math.floor(since.getTime() / 1000)}`
        : `receivedDateTime ge ${since.toISOString()}`;

    // The two paginate differently — Gmail by opaque page token, Outlook by a
    // numeric skip — which is exactly the kind of difference that must not
    // escape this method.
    const { messages } =
      provider === "gmail"
        ? await this.gmail.listMessages(userId, conn, "inbox", MAX_PER_SWEEP, undefined, query)
        : await this.outlook.listMessages(userId, conn, "inbox", MAX_PER_SWEEP, 0, query);

    return messages as unknown as MailMessageForIngress[];
  }
}
