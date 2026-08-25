import { ConflictException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { and, asc, eq, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.types";
import { crmMailboxSync, userIntegrationConnections } from "../../../db/schema";
import type { MailMessageSummary } from "../../mail/dto/mail-schemas";
import type { NormalizerConnectionMeta } from "../../mail/providers/mail-normalizers";
import { GmailMailProvider } from "../../mail/providers/gmail-mail.provider";
import { OutlookMailProvider } from "../../mail/providers/outlook-mail.provider";
import { InboundIngressService } from "../inbound-ingress.service";
import {
  EXCLUDED_FOLDERS,
  isPrivateMessage,
  mailToInboundEvent,
  PRIVATE_LABELS,
  type MailMessageForIngress,
  type PrivateLabelRule,
} from "./mail-to-inbound-event";
import { advanceWatermark, planSweep } from "./mailbox-sync";

/** One page from a provider. */
const MAX_PER_PAGE = 100;

/**
 * How many pages one sweep will follow before it stops.
 *
 * The sweep follows the provider's pagination to the floor of its window rather
 * than reading one page and moving the watermark past the rest — which is what
 * it used to do. Both providers return newest first, so a single page of a
 * 500-message window is the newest day of it; advancing the watermark to the
 * newest of those put the other 400 permanently below the floor, and the user
 * who had just connected their mailbox saw one day of history and never learned
 * the rest was not coming.
 *
 * This is the "follow the pages within the sweep" option rather than "persist a
 * cursor and resume next time". The cursor would drain a backlog of any size,
 * but it needs two columns on `crm_mailbox_sync` and a migration, and it has to
 * cope with a page token that expired between sweeps. The budget here covers
 * 2,500 messages in one window — a 7-day first sync of a mailbox taking over
 * 350 messages a day — and what happens past it is defined below rather than
 * silent.
 */
const MAX_PAGES_PER_SWEEP = 25;

/**
 * How many messages a sweep reads in full.
 *
 * A listing gives a ~160-character preview and no cc, and a timeline entry made
 * of previews is a poor record of a conversation and a worse input to anything
 * that reads the body afterwards. The full text is a call per message, though
 * (two, on Graph, which fetches the attachment list alongside), so the newest
 * are read in full and a backlog drain falls back to previews rather than
 * spending thousands of calls. A steady-state sweep is a handful of messages
 * and never reaches this.
 */
const MAX_DETAIL_FETCHES_PER_SWEEP = 50;

/** Enough failed detail reads to conclude the provider is not going to answer. */
const MAX_DETAIL_FAILURES = 3;

/**
 * The exclusions Gmail applies on our behalf.
 *
 * Built from the same lists the adapter checks messages against, because two
 * copies would drift apart the day somebody adds to one of them. Gmail's own
 * label syntax uses hyphens where a label has spaces (`Junk Email` is
 * `label:junk-email`).
 */
const GMAIL_EXCLUSIONS = [...PRIVATE_LABELS, ...EXCLUDED_FOLDERS]
  .map((label) => `-label:${label.replace(/\s+/g, "-")}`)
  .join(" ");

/** What one sweep read, and how much of the window it got through. */
interface SweepRead {
  readonly messages: readonly MailMessageForIngress[];
  /** How the private-label rule was enforced for these messages. */
  readonly privateLabelRule: PrivateLabelRule;
  /** The page budget ran out before the window was read down to its floor. */
  readonly truncated: boolean;
}

/**
 * A provider summary as the shape the seam's adapter takes.
 *
 * Written out field by field rather than cast. The cast that used to stand here
 * — `messages as unknown as MailMessageForIngress[]` — silenced the compiler
 * over a type that has no `labels`, no `cc` and no body at all, so the private
 * label check ran against `undefined` and returned "not private" for every
 * message ever swept.
 */
function forIngress(
  message: MailMessageSummary,
  labels: readonly string[] | null,
): MailMessageForIngress {
  return {
    id: message.id,
    threadId: message.threadId,
    from: message.from,
    to: message.to,
    subject: message.subject,
    snippet: message.snippet,
    date: message.date,
    labels,
  };
}

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
      const read = await this.fetch(
        row.provider,
        connection.userId,
        connection.composioAccountId,
        plan.since,
      );

      let delivered = 0;
      let skipped = 0;
      /** Skipped for want of labels rather than on the merits — see below. */
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
          // Delivered one at a time so a single malformed message cannot lose
          // the batch. The seam deduplicates, so the overlap costs nothing.
          await this.ingress.accept(result.event);
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
          /**
           * `lastError` carries the truncation note as well as real errors: it
           * is the one field the mailbox list surfaces, and a sweep that could
           * not read its whole window has to be visible somewhere.
           */
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

  /** The provider call, and the only place either provider is named. */
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
        ? await this.fetchGmail(userId, conn, since)
        : await this.fetchOutlook(userId, conn, since);

    return { ...read, messages: await this.readInFull(provider, userId, conn, read.messages) };
  }

  /**
   * Gmail, which does both the date bound and the privacy rule itself.
   *
   * The query is Gmail's own search syntax and carries both: `after:` keeps the
   * sweep bounded, and the `-label:` terms mean a message somebody marked
   * private is never handed over in the first place. That is weaker than
   * reading each message's labels and deciding here — it cannot be verified
   * from what comes back — but it is a real exclusion rather than an
   * assumption, and it is the same mechanism the date floor already depends on.
   *
   * The stronger version needs `normalizeGmailMessage` to carry `labelIds`
   * through to `MailMessageSummary`; it already parses them, for `isRead` and
   * `isStarred`, and then drops them.
   */
  private async fetchGmail(
    userId: string,
    conn: NormalizerConnectionMeta,
    since: Date,
  ): Promise<SweepRead> {
    const query = `after:${Math.floor(since.getTime() / 1000)} ${GMAIL_EXCLUSIONS}`;

    const messages: MailMessageForIngress[] = [];
    let pageToken: string | undefined;
    let pages = 0;

    do {
      const page = await this.gmail.listMessages(
        userId,
        conn,
        "inbox",
        MAX_PER_PAGE,
        pageToken,
        query,
      );
      for (const message of page.messages) messages.push(forIngress(message, null));
      pageToken = page.nextPageToken ?? undefined;
      pages += 1;
    } while (pageToken && pages < MAX_PAGES_PER_SWEEP);

    return { messages, privateLabelRule: "provider-query", truncated: Boolean(pageToken) };
  }

  /**
   * Outlook, which bounds itself here rather than at the provider.
   *
   * There is no date filter on this path: `listMessagesForIngress` asks for the
   * Inbox newest-first and the floor is applied to the `receivedDateTime` that
   * comes back. That is a server-assigned timestamp — unlike a `Date:` header,
   * which the sender writes — so filtering on it cannot be steered by somebody
   * sending mail with a fabricated date.
   *
   * Crossing the floor ends the sweep: the order was requested descending, so
   * the first message older than the floor means the rest of that page and
   * every page after it is older too. The page budget is the backstop if the
   * order is ever not honoured.
   */
  private async fetchOutlook(
    userId: string,
    conn: NormalizerConnectionMeta,
    since: Date,
  ): Promise<SweepRead> {
    const messages: MailMessageForIngress[] = [];
    let skip = 0;
    let pages = 0;
    let drained = false;

    while (pages < MAX_PAGES_PER_SWEEP) {
      const page = await this.outlook.listMessagesForIngress(
        userId,
        conn,
        "inbox",
        MAX_PER_PAGE,
        skip,
      );
      pages += 1;

      let crossedFloor = false;
      for (const message of page.messages) {
        const at = new Date(message.date).getTime();
        if (!Number.isNaN(at) && at < since.getTime()) {
          crossedFloor = true;
          continue;
        }
        messages.push(forIngress(message, message.labels));
      }

      if (crossedFloor || page.nextSkip === null) {
        drained = true;
        break;
      }
      skip = page.nextSkip;
    }

    return { messages, privateLabelRule: "message-labels", truncated: !drained };
  }

  /**
   * The newest messages again, in full.
   *
   * A listing carries a preview and the `to` line; the cc list and the actual
   * text of the message need a second call each. One that fails is not fatal —
   * the summary is still a usable event — but a run of failures means the
   * provider is not going to answer and continuing would spend the rest of the
   * budget finding that out fifty times.
   *
   * A message already marked private is never fetched: it is going to be
   * refused, and pulling its body across first would be both waste and exactly
   * the content nobody asked us to handle.
   */
  private async readInFull(
    provider: "gmail" | "outlook",
    userId: string,
    conn: NormalizerConnectionMeta,
    messages: readonly MailMessageForIngress[],
  ): Promise<MailMessageForIngress[]> {
    const enriched: MailMessageForIngress[] = [];
    let fetched = 0;
    let failures = 0;

    for (const message of messages) {
      if (
        fetched >= MAX_DETAIL_FETCHES_PER_SWEEP ||
        failures >= MAX_DETAIL_FAILURES ||
        isPrivateMessage(message)
      ) {
        enriched.push(message);
        continue;
      }

      try {
        fetched += 1;
        const detail =
          provider === "gmail"
            ? await this.gmail.getMessage(userId, conn, message.id)
            : await this.outlook.getMessage(userId, conn, message.id);

        // The labels stay the list's: a detail response does not carry them,
        // and taking the detail's word for it would erase what we know.
        enriched.push({
          ...message,
          cc: detail.cc,
          bodyText: detail.bodyText,
          bodyHtml: detail.bodyHtml,
        });
      } catch (error) {
        failures += 1;
        this.logger.warn(
          `could not read ${message.id} in full: ${error instanceof Error ? error.message : String(error)}`,
        );
        enriched.push(message);
      }
    }

    return enriched;
  }
}

/**
 * What a sweep that succeeded but did not do its whole job leaves behind.
 *
 * A mailbox that reads mail and files none of it must not report itself
 * healthy — that is the shape of the bug this module has already had once,
 * where every sweep returned `delivered: 0`, reset the failure count, and left
 * somebody believing their mail was in the CRM.
 */
function sweepNote(
  truncated: boolean,
  firstRun: boolean,
  read: number,
  unjudged: number,
): string | null {
  if (truncated)
    return firstRun
      ? `The first sweep read the ${read} most recent messages in the lookback window and there were more; older mail was left in the mailbox.`
      : `Read ${read} messages and there are still more in the window. Nothing has been skipped — the watermark is held — but a backlog this size will not drain on its own.`;

  if (unjudged > 0)
    return `${unjudged} of ${read} messages were left alone because the provider did not say which labels they carry. Nothing is filed from this mailbox until it does — a message somebody marked private must not be guessed at.`;

  return null;
}
