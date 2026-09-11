import { ConflictException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import {
  autonomousDecisions,
  autonomyHolds,
  crmOutboundClassStops,
  crmOutboundMessages,
  deals,
  quotes,
} from "../../db/schema";
import { getOrgAdminUserIds } from "../../common/tenant/org-admin-recipients";
import { startRun } from "../../common/workflow/workflow-store";
import { NotificationsService } from "../notifications/notifications.service";
import { buildDecision } from "./decision-record";
import { clampHoldWindow, secondsRemaining } from "./hold-window";
import { draftQuoteFromDeal } from "./quote-draft";
import { QuotesService } from "../quotes/quotes.service";
import { AutonomyScoringService } from "./autonomy-scoring.service";

export const HOLD_WORKFLOW = "crm.autonomy-hold";

/**
 * Placing, showing and cancelling holds.
 *
 * The wait itself belongs to the workflow runtime — `step.sleep` releases the
 * run and re-claims it later, so a hold survives a deploy and costs nothing
 * while it waits. A polling job would add latency to every send and would have
 * no memory of what it had already done when it crashed mid-batch.
 */
@Injectable()
export class AutonomyHoldService {
  private readonly logger = new Logger("AutonomyHold");

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly scoring: AutonomyScoringService,
    private readonly notifications: NotificationsService,
    private readonly quotes: QuotesService,
  ) {}

  /**
   * Decide to send a quote, and start the interval in which that can be stopped.
   *
   * There is no approval step anywhere in this path. The decision is recorded as
   * `held` rather than `applied` because it has not happened yet — a reviewer
   * seeing "sent" for something still waiting would be reading a lie.
   */
  async holdQuoteSend(input: {
    organizationId: string;
    quoteId: number;
    summary: string;
    confidence: number | null;
    model?: string | null;
    promptVersion?: string | null;
    dealId?: string | null;
    partyId?: string | null;
  }) {
    const settings = await this.scoring.settingsFor(input.organizationId);
    const windowSeconds = clampHoldWindow(settings.holdWindowSeconds);
    const holdUntil = new Date(Date.now() + windowSeconds * 1000);

    const [decision] = await this.db
      .insert(autonomousDecisions)
      .values(
        buildDecision({
          organizationId: input.organizationId,
          kind: "quote.sent",
          // Not `applied`: it has not left yet, and the feed must not say it has.
          outcome: "held",
          triggerType: "deal",
          triggerId: input.dealId ?? null,
          dealId: input.dealId ?? null,
          partyId: input.partyId ?? null,
          model: input.model ?? null,
          promptVersion: input.promptVersion ?? null,
          confidence: input.confidence,
          decision: { quoteId: input.quoteId, holdUntil: holdUntil.toISOString() },
          summary: input.summary,
        }),
      )
      .returning({ id: autonomousDecisions.autonomousDecisionId });

    if (!decision) throw new ConflictException("Could not record the decision to send.");

    let hold;
    try {
      [hold] = await this.db
        .insert(autonomyHolds)
        .values({
          organizationId: input.organizationId,
          autonomousDecisionId: decision.id,
          kind: "quote.sent",
          quoteId: input.quoteId,
          holdUntil,
        })
        .returning({ id: autonomyHolds.autonomyHoldId });
    } catch (error) {
      // The partial unique index on live holds. A second decision to send the
      // same quote while one is already waiting is a duplicate, not a race to win.
      if (isUniqueViolation(error))
        throw new ConflictException("That quote is already waiting to send.");
      throw error;
    }

    if (!hold) throw new ConflictException("Could not place the hold.");

    const runId = await startRun(this.db, {
      organizationId: input.organizationId,
      workflowName: HOLD_WORKFLOW,
      input: { autonomyHoldId: hold.id },
      causationEventId: hold.id,
      correlationId: `hold:${hold.id}`,
    });

    await this.db
      .update(autonomyHolds)
      .set({ workflowRunId: runId })
      .where(
        and(
          eq(autonomyHolds.organizationId, input.organizationId),
          eq(autonomyHolds.autonomyHoldId, hold.id),
        ),
      );

    await this.notifyPending(input.organizationId, hold.id, input.quoteId, windowSeconds);

    return { autonomyHoldId: hold.id, decisionId: decision.id, holdUntil, windowSeconds };
  }

  /**
   * Tell the people who could stop it, while there is still time.
   *
   * A hold nobody hears about is a delay, not a safeguard. The notification goes
   * to whoever owns the deal — the person most likely to know the send is wrong
   * and the one whose customer it is — and to the organisation's administrators
   * when nobody owns it, because the hold sends either way.
   */
  private async notifyPending(
    organizationId: string,
    holdId: string,
    quoteId: number,
    windowSeconds: number,
  ): Promise<void> {
    const [row] = await this.db
      .select({ assignedToId: deals.assignedToId, quoteSubject: quotes.subject })
      .from(quotes)
      .leftJoin(deals, and(eq(deals.orgId, quotes.orgId), eq(deals.id, quotes.dealId)))
      .where(and(eq(quotes.orgId, organizationId), eq(quotes.id, quoteId)))
      .limit(1);

    /**
     * Nobody owns the deal, so the org's administrators are told instead.
     *
     * Returning here was silent, and the hold sent sixty seconds later anyway —
     * which is the failure this notification exists to prevent, arriving
     * precisely on the quotes least likely to have been checked by a person. An
     * unassigned deal is not a reason to send a customer a quote unannounced.
     */
    const recipients = row?.assignedToId
      ? [row.assignedToId]
      : await getOrgAdminUserIds(this.db, organizationId);

    if (recipients.length === 0) {
      this.logger.warn(
        `hold ${holdId} has no assignee and the organisation has no active admin to tell; it will send unannounced`,
      );
      return;
    }

    for (const userId of recipients) {
      try {
        await this.notifications.create({
          orgId: organizationId,
          userId,
          type: "WARNING",
          // High, because the whole value is that it is read before the window ends.
          priority: "HIGH",
          category: "SYSTEM",
          sourceModule: "crm",
          eventKey: "crm.autonomy.quote-holding",
          entityType: "autonomy_hold",
          entityId: holdId,
          title: "A quote is about to send",
          message: `"${row?.quoteSubject ?? "A quote"}" sends in ${windowSeconds} seconds unless you stop it.`,
          link: `/crm/autonomy?holdId=${holdId}`,
        });
      } catch (error) {
        // A failed notification must not stop the hold from existing. The feed
        // still shows it, and swallowing this silently is what §4 forbids.
        this.logger.error(
          `could not notify ${userId} about hold ${holdId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /**
   * Generate a quote from a deal and decide to send it — with no approval step.
   *
   * The money is arithmetic, computed in `quote-draft.ts` rather than asked of a
   * model: a language model multiplying a quantity by a unit price will usually
   * be right, which is worse than reliably wrong, because the failure is a
   * customer holding a figure nobody can reconstruct.
   */
  async generateAndHoldQuote(input: {
    organizationId: string;
    dealId: number;
    confidence: number;
  }) {
    const [deal] = await this.db
      .select({
        name: deals.name,
        valueMinor: deals.valueMinor,
        assignedToId: deals.assignedToId,
        partyId: deals.partyId,
      })
      .from(deals)
      .where(
        and(
          eq(deals.orgId, input.organizationId),
          eq(deals.id, input.dealId),
          isNull(deals.deletedAt),
        ),
      )
      .limit(1);

    if (!deal) throw new NotFoundException("Deal not found");

    const drafted = draftQuoteFromDeal({
      name: deal.name,
      valueMinor: deal.valueMinor ?? 0,
      currency: "INR",
    });

    if (!drafted.ok) {
      // Recorded as skipped, not thrown away. A decision not to act that nobody
      // recorded is indistinguishable from one that never ran.
      await this.db.insert(autonomousDecisions).values(
        buildDecision({
          organizationId: input.organizationId,
          kind: "quote.sent",
          outcome: "skipped",
          triggerType: "deal",
          triggerId: String(input.dealId),
          dealId: String(input.dealId),
          partyId: deal.partyId,
          confidence: input.confidence,
          summary: drafted.reason,
        }),
      );
      return { held: false as const, reason: drafted.reason };
    }

    /**
     * Created in the name of whoever owns the deal.
     *
     * `quotes.created_by_id` is NOT NULL and references `users`, so a system
     * actor is not representable there — the same gap ticket 08 found in
     * `deal_activities`. Attributing it to the deal's owner is honest enough at
     * the quote level, and the ledger records that the system decided it.
     */
    const created = await this.quotes.create(input.organizationId, deal.assignedToId ?? "system", {
      dealId: input.dealId,
      subject: drafted.draft.subject,
      validUntil: drafted.draft.validUntil,
      lineItems: drafted.draft.lineItems.map((line) => ({ ...line })),
    });

    const quoteId = (created as { id: number }).id;

    const held = await this.holdQuoteSend({
      organizationId: input.organizationId,
      quoteId,
      summary: `Drafted ${drafted.draft.subject} and decided to send it.`,
      confidence: input.confidence,
      dealId: String(input.dealId),
      partyId: deal.partyId,
    });

    return { held: true as const, quoteId, ...held };
  }

  /**
   * The classes currently stopped, and who stopped each.
   *
   * A stop is open-ended, so without a way to see them a tenant would gradually
   * stop reaching people and have nowhere to find out why the follow-ups had
   * quietly thinned out.
   */
  async liveClassStops(organizationId: string) {
    return this.db
      .select({
        outboundClassStopId: crmOutboundClassStops.outboundClassStopId,
        partyId: crmOutboundClassStops.partyId,
        outboundClass: crmOutboundClassStops.outboundClass,
        outboundMessageId: crmOutboundClassStops.outboundMessageId,
        reason: crmOutboundClassStops.reason,
        stoppedByUserId: crmOutboundClassStops.stoppedByUserId,
        stoppedAt: crmOutboundClassStops.stoppedAt,
      })
      .from(crmOutboundClassStops)
      .where(
        and(
          eq(crmOutboundClassStops.organizationId, organizationId),
          isNull(crmOutboundClassStops.releasedAt),
        ),
      );
  }

  /**
   * Let this class reach this party again.
   *
   * The other half of the stop, and the half without which it is a one-way door:
   * `released_at` is documented as cleared only by a person, and until this
   * existed there was no person-shaped way to clear it — a single cancellation
   * silenced a class for that party permanently, recoverable only by hand in the
   * database.
   *
   * Scoped to the organisation and to a live stop. Releasing an already-released
   * one is a conflict rather than a silent success, because "it is released" and
   * "you released it" are different things to tell somebody who is trying to
   * work out why a customer stopped hearing from them.
   */
  async releaseClassStop(organizationId: string, userId: string, outboundClassStopId: string) {
    const released = await this.db
      .update(crmOutboundClassStops)
      .set({ releasedAt: new Date(), releasedByUserId: userId })
      .where(
        and(
          eq(crmOutboundClassStops.organizationId, organizationId),
          eq(crmOutboundClassStops.outboundClassStopId, outboundClassStopId),
          isNull(crmOutboundClassStops.releasedAt),
        ),
      )
      .returning({ id: crmOutboundClassStops.outboundClassStopId });

    if (released.length === 0) {
      const [existing] = await this.db
        .select({ releasedAt: crmOutboundClassStops.releasedAt })
        .from(crmOutboundClassStops)
        .where(
          and(
            eq(crmOutboundClassStops.organizationId, organizationId),
            eq(crmOutboundClassStops.outboundClassStopId, outboundClassStopId),
          ),
        )
        .limit(1);

      if (!existing) throw new NotFoundException("Stop not found");
      throw new ConflictException("That stop was already released.");
    }

    return { released: true };
  }

  /** Everything still waiting, with the time each has left. */
  async liveHolds(organizationId: string) {
    const rows = await this.db
      .select({
        autonomyHoldId: autonomyHolds.autonomyHoldId,
        autonomousDecisionId: autonomyHolds.autonomousDecisionId,
        quoteId: autonomyHolds.quoteId,
        holdUntil: autonomyHolds.holdUntil,
        createdAt: autonomyHolds.createdAt,
        quoteSubject: quotes.subject,
        summary: autonomousDecisions.summary,
      })
      .from(autonomyHolds)
      .leftJoin(quotes, and(eq(quotes.orgId, autonomyHolds.organizationId), eq(quotes.id, autonomyHolds.quoteId)))
      .leftJoin(
        autonomousDecisions,
        and(
          eq(autonomousDecisions.organizationId, autonomyHolds.organizationId),
          eq(autonomousDecisions.autonomousDecisionId, autonomyHolds.autonomousDecisionId),
        ),
      )
      .where(
        and(eq(autonomyHolds.organizationId, organizationId), eq(autonomyHolds.status, "held")),
      )
      .orderBy(autonomyHolds.holdUntil)
      .limit(100);

    return rows.map((row) => ({
      ...row,
      secondsRemaining: secondsRemaining(row.holdUntil),
    }));
  }

  /**
   * Stop one before it leaves.
   *
   * `WHERE status = 'held'` is what makes this safe against the window expiring
   * at the same moment: whichever statement commits first wins, and the other
   * updates no rows and says so.
   */
  async cancelHold(
    organizationId: string,
    userId: string,
    holdId: string,
    reason?: string,
  ) {
    const cancelled = await this.db
      .update(autonomyHolds)
      .set({
        status: "cancelled",
        cancelledAt: new Date(),
        cancelledByUserId: userId,
        cancelReason: reason ?? null,
      })
      .where(
        and(
          eq(autonomyHolds.organizationId, organizationId),
          eq(autonomyHolds.autonomyHoldId, holdId),
          eq(autonomyHolds.status, "held"),
        ),
      )
      .returning({
        id: autonomyHolds.autonomyHoldId,
        decisionId: autonomyHolds.autonomousDecisionId,
        outboundMessageId: autonomyHolds.outboundMessageId,
      });

    if (cancelled.length === 0) {
      const [existing] = await this.db
        .select({ status: autonomyHolds.status })
        .from(autonomyHolds)
        .where(
          and(
            eq(autonomyHolds.organizationId, organizationId),
            eq(autonomyHolds.autonomyHoldId, holdId),
          ),
        )
        .limit(1);

      if (!existing) throw new NotFoundException("Hold not found");
      throw new ConflictException(
        existing.status === "sent"
          ? "That already sent — the window had closed."
          : `That is already ${existing.status}.`,
      );
    }

    // The cancellation is itself audited: the decision stops claiming it will
    // happen, and the feed shows who stopped it.
    await this.db
      .update(autonomousDecisions)
      .set({
        outcome: "reversed",
        reversedAt: new Date(),
        reversedByUserId: userId,
        reversedReason: reason ?? "Cancelled inside the hold window",
      })
      .where(
        and(
          eq(autonomousDecisions.organizationId, organizationId),
          eq(autonomousDecisions.autonomousDecisionId, cancelled[0]!.decisionId),
        ),
      );

    await this.stopClassForParty(
      organizationId,
      userId,
      cancelled[0]!.outboundMessageId,
      reason,
    );

    return { cancelled: true };
  }

  /**
   * Stopping a message stops its class for that party, not just that message.
   *
   * Ticket 07's US8, and until now only half-built: `outbound.service.ts` reads
   * `crm_outbound_class_stops` at send time as a guardrail, and nothing anywhere
   * inserted a row — so the table was always empty and the check always passed.
   * A person who stopped a nudge got the next nudge anyway, which is the reading
   * of "stop" nobody means.
   *
   * The stop is per class rather than per party: someone who does not want
   * chasing may still want the renewal conversation, and one cancellation is not
   * consent to go silent everywhere. It is also open-ended — `releasedAt` is
   * cleared only by a person, per the column's own contract — because a stop
   * that quietly expires is a stop the customer did not agree to.
   *
   * Quote holds carry no `outboundMessageId` and no class, so there is nothing
   * to stop and this does nothing for them.
   *
   * Never throws outward. The cancellation is the thing the caller asked for and
   * it has already committed; failing here must not turn a successful stop into
   * a 500 that invites the person to press the button again. The send-time
   * guardrail is a read of this table, so a lost row costs one message, and the
   * failure is loud in the log.
   */
  private async stopClassForParty(
    organizationId: string,
    userId: string,
    outboundMessageId: string | null,
    reason?: string,
  ): Promise<void> {
    if (!outboundMessageId) return;

    try {
      const [message] = await this.db
        .select({
          partyId: crmOutboundMessages.partyId,
          outboundClass: crmOutboundMessages.outboundClass,
        })
        .from(crmOutboundMessages)
        .where(
          and(
            eq(crmOutboundMessages.organizationId, organizationId),
            eq(crmOutboundMessages.outboundMessageId, outboundMessageId),
          ),
        )
        .limit(1);

      if (!message) return;

      /**
       * A second stop on a live one would be a duplicate row saying the same
       * thing, and the guardrail reads the first it finds either way.
       */
      const [existing] = await this.db
        .select({ id: crmOutboundClassStops.outboundClassStopId })
        .from(crmOutboundClassStops)
        .where(
          and(
            eq(crmOutboundClassStops.organizationId, organizationId),
            eq(crmOutboundClassStops.partyId, message.partyId),
            eq(crmOutboundClassStops.outboundClass, message.outboundClass),
            isNull(crmOutboundClassStops.releasedAt),
          ),
        )
        .limit(1);

      if (existing) return;

      await this.db.insert(crmOutboundClassStops).values({
        organizationId,
        partyId: message.partyId,
        outboundClass: message.outboundClass,
        outboundMessageId,
        reason: reason ?? "Stopped inside the hold window",
        stoppedByUserId: userId,
      });
    } catch (error) {
      this.logger.error(
        `could not stop ${outboundMessageId}'s class for its party: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Cancel everything still waiting for one action type.
   *
   * Called when a kill switch goes off. Stopping new holds is not enough on its
   * own: the ones already decided are the more dangerous half, and leaving them
   * to send would mean the switch protected only the messages nobody had
   * committed to yet.
   */
  async cancelInFlight(organizationId: string, userId: string, kind: string): Promise<number> {
    const cancelled = await this.db
      .update(autonomyHolds)
      .set({
        status: "cancelled",
        cancelledAt: new Date(),
        cancelledByUserId: userId,
        cancelReason: "Autonomous sending was switched off",
      })
      .where(
        and(
          eq(autonomyHolds.organizationId, organizationId),
          eq(autonomyHolds.status, "held"),
          kind === "*" ? sql`true` : eq(autonomyHolds.kind, kind as "quote.sent"),
        ),
      )
      .returning({ decisionId: autonomyHolds.autonomousDecisionId });

    for (const row of cancelled) {
      await this.db
        .update(autonomousDecisions)
        .set({
          outcome: "reversed",
          reversedAt: new Date(),
          reversedByUserId: userId,
          reversedReason: "Autonomous sending was switched off",
        })
        .where(
          and(
            eq(autonomousDecisions.organizationId, organizationId),
            eq(autonomousDecisions.autonomousDecisionId, row.decisionId),
          ),
        );
    }

    return cancelled.length;
  }
}

const PG_UNIQUE_VIOLATION = "23505";

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === PG_UNIQUE_VIOLATION
  );
}
