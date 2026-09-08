import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.types";
import { inboundEvents, userIntegrationConnections } from "../../../db/schema";
import { ComposioGateway } from "../../integrations/core/composio.gateway";
import { InboundIngressService } from "../inbound-ingress.service";
import { INITIAL_LOOKBACK_MS, OVERLAP_MS } from "./mailbox-sync";
import {
  callLogPath,
  MAX_PAGES_PER_SWEEP,
  parseCallPage,
  TELEPHONY_PROVIDER,
  TELEPHONY_TOOLKIT,
} from "./telephony-call-log";
import { telephonyCallToInboundEvent, type TelephonyCallForIngress } from "./telephony-to-inbound-event";
import {
  NO_SKIPS,
  sweepNote,
  type SkipTally,
  type TelephonySweepRefusal,
  type TelephonySweepResult,
} from "./telephony-sweep-result";

export type { TelephonySweepRefusal, TelephonySweepResult };

/**
 * A carrier's call log feeding the CRM.
 *
 * Connectivity is Composio's and the `integrations` module's, exactly as the
 * platform rule requires: this reads `user_integration_connections` for a
 * connected account id and goes out through `ComposioGateway`. No provider OAuth
 * runs here, no token is read, and nothing is written to that table — it is
 * mirrored, not owned.
 *
 * Three things have to be true before this can run, and none of them is true
 * today. They are reported rather than fixed here because each is a change to a
 * file this ticket does not own:
 *
 *   1. `IntegrationToolkit` has three members and none of them is a carrier, and
 *      `IntegrationsService.toToolkit` throws on anything else — so a telephony
 *      connection cannot be finalised.
 *   2. `ComposioGateway.authConfigIdFor` has no carrier branch and falls through
 *      to the Outlook auth config, so initiating one would send a person to the
 *      wrong provider's consent screen.
 *   3. `ComposioGateway.getAccountEmail` has no carrier branch, so the account
 *      reference this service refuses to run without is never populated.
 *
 * Written anyway, and deliberately: the shape of what ticket 12 has to wire is
 * more useful stated in code than described in a paragraph, and every refusal
 * below is a refusal that has to survive the wiring.
 */
@Injectable()
export class TelephonyCallLogService {
  private readonly logger = new Logger("TelephonyCallLog");

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly composio: ComposioGateway,
    private readonly ingress: InboundIngressService,
  ) {}

  /**
   * Read a call log forward and offer everything new to the seam.
   *
   * Returns a result rather than throwing on a provider failure, because the
   * caller is a sweep over several connections and one revoked carrier must not
   * stop the rest.
   */
  async sync(organizationId: string, connectionId: number): Promise<TelephonySweepResult> {
    const [connection] = await this.db
      .select({
        userId: userIntegrationConnections.userId,
        toolkit: userIntegrationConnections.toolkit,
        composioAccountId: userIntegrationConnections.composioConnectedAccountId,
        accountLabel: userIntegrationConnections.accountLabel,
        accountEmail: userIntegrationConnections.accountEmail,
        status: userIntegrationConnections.status,
      })
      .from(userIntegrationConnections)
      .where(
        and(
          eq(userIntegrationConnections.id, connectionId),
          eq(userIntegrationConnections.orgId, organizationId),
        ),
      )
      .limit(1);

    // Another organisation's connection is indistinguishable from one that is
    // not there, and a disconnect deletes the row outright.
    if (!connection)
      return { swept: false, reason: "disconnected", note: "The carrier was disconnected." };

    /**
     * Widened to `string` on the way out of the row, not cast into one.
     *
     * `userIntegrationConnections.toolkit` is a plain `text` column wearing a
     * three-member TypeScript union, and no carrier is in it. Comparing against
     * a value outside the union is the compiler's business; what is in the
     * column at runtime is this service's, and it has to be checked — a Gmail
     * connection id handed to this method must not become a request for
     * somebody's call log.
     */
    const toolkit: string = connection.toolkit;
    if (toolkit !== TELEPHONY_TOOLKIT)
      return {
        swept: false,
        reason: "not-telephony",
        note: "That connection is not a carrier.",
      };

    /**
     * A connection awaiting re-authorisation is skipped, not failed — somebody
     * is being asked to click a button, and the watermark stays where it is so
     * finishing that resumes rather than re-imports.
     */
    if (connection.status === "needs_reauth")
      return {
        swept: false,
        reason: "needs-reauth",
        note: "The carrier connection needs re-authorising.",
      };

    /**
     * The carrier account the call log belongs to.
     *
     * Refused when absent rather than defaulted, mirroring `CrmMailboxService`'s
     * refusal of a mailbox with no address: the account reference is a path
     * segment in every request this makes, and an empty one is a request for
     * somebody else's calls or for nothing at all.
     */
    const accountReference = (connection.accountLabel ?? connection.accountEmail)?.trim();
    if (!accountReference)
      return {
        swept: false,
        reason: "no-account-reference",
        note: "That carrier connection has no account identifier yet — finish authorising it and try again.",
      };

    const watermark = await this.watermark(organizationId);
    /**
     * The floor, from the two constants the mail sweep already reasons with.
     *
     * Reused rather than restated: the overlap exists because a call that lands
     * mid-sweep would otherwise fall in the gap, and the lookback exists so a
     * first sync is useful without importing a decade — neither of which is a
     * mail-specific argument, and two copies would drift.
     */
    const since = watermark
      ? new Date(watermark.getTime() - OVERLAP_MS)
      : new Date(Date.now() - INITIAL_LOOKBACK_MS);

    try {
      const read = await this.fetch(connection.composioAccountId, accountReference, since);

      let delivered = 0;
      const skipped: SkipTally = { ...NO_SKIPS };

      for (const call of read.calls) {
        const result = telephonyCallToInboundEvent(call, {
          organizationId,
          provider: TELEPHONY_PROVIDER,
        });

        if (!result.ok) {
          skipped[result.reason] += 1;
          continue;
        }

        /**
         * Offered one at a time so one malformed call cannot lose the batch, and
         * the seam deduplicates on the provider's own id so the overlap costs
         * nothing.
         *
         * `result.unrepresented` is dropped here, and that is the finding rather
         * than an omission: duration, direction and the recording reference have
         * no field on `InboundCommunicationEvent` and no column the workflow's
         * activity writer would fill from one. See `TelephonyCallFacts`.
         */
        await this.ingress.accept(result.event);
        delivered += 1;
      }

      return {
        swept: true,
        read: read.calls.length,
        delivered,
        skipped,
        truncated: read.truncated,
        note: sweepNote(read.calls.length, delivered, skipped, read.truncated),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`call log sweep failed for connection ${connectionId}: ${message}`);
      /**
       * Nothing is recorded as read. There is no watermark column to hold back —
       * the watermark is derived from the events that were actually accepted —
       * so a failed sweep is simply a sweep that delivered nothing, and the next
       * one reads the same window again.
       */
      return { swept: false, reason: "provider-error", note: message.slice(0, 500) };
    }
  }

  /**
   * How far this channel has already been read, taken from what it delivered.
   *
   * There is no `crm_call_log_sync` table, and this is deliberate rather than
   * missing. A watermark column can advance past mail that was never read — the
   * bug the mail sweep has already had twice — whereas the newest call this
   * organisation has actually accepted an event for cannot, by construction, be
   * newer than what was read. The cost is a query per sweep and the loss of the
   * failure counter and the `lastError` surface, which is what a sync row would
   * buy and what ticket 12 should add if this channel is ever enabled.
   */
  private async watermark(organizationId: string): Promise<Date | null> {
    const [newest] = await this.db
      .select({ occurredAt: inboundEvents.occurredAt })
      .from(inboundEvents)
      .where(
        and(
          eq(inboundEvents.organizationId, organizationId),
          eq(inboundEvents.provider, TELEPHONY_PROVIDER),
          eq(inboundEvents.channel, "call"),
        ),
      )
      .orderBy(desc(inboundEvents.occurredAt))
      .limit(1);

    return newest?.occurredAt ?? null;
  }

  /**
   * The provider call, and the only place a carrier's API is touched.
   *
   * The floor is applied here rather than asked for, and the pages after the
   * first are the provider's own `next_page_uri` rather than a query this file
   * assembled — both so that the one string this module invents is the first
   * path, where being wrong is a 404 and not a silently ignored filter.
   *
   * Crossing the floor ends the sweep: carriers return a call log newest first,
   * so the first call older than the floor means the rest of that page and every
   * page after it is older too. The page budget is the backstop if that order is
   * ever not honoured.
   */
  private async fetch(
    composioAccountId: string,
    accountReference: string,
    since: Date,
  ): Promise<{ calls: TelephonyCallForIngress[]; truncated: boolean }> {
    const calls: TelephonyCallForIngress[] = [];
    let path: string | null = callLogPath(accountReference);
    let pages = 0;
    let drained = false;

    while (path && pages < MAX_PAGES_PER_SWEEP) {
      const raw: unknown = await this.composio.executeProxy(composioAccountId, "GET", path);
      const page = parseCallPage(raw);
      pages += 1;

      let crossedFloor = false;
      for (const call of page.calls) {
        const at = call.startedAt ? new Date(call.startedAt).getTime() : Number.NaN;
        if (!Number.isNaN(at) && at < since.getTime()) {
          crossedFloor = true;
          continue;
        }
        calls.push(call);
      }

      if (crossedFloor || !page.nextPath) {
        drained = true;
        break;
      }
      path = page.nextPath;
    }

    return { calls, truncated: !drained };
  }
}

