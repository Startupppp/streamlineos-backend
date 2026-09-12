import { ConflictException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import { autonomousDecisions, autonomyHolds, deals } from "../../db/schema";
import { isUniqueViolation } from "../../common/db/postgres-error";
import { startRun } from "../../common/workflow/workflow-store";
import { NotificationsService } from "../notifications/notifications.service";
import { buildDecision } from "./decision-record";
import { clampHoldWindow } from "./hold-window";
import { draftQuoteFromDeal } from "./quote-draft";
import { QuotesService } from "../quotes/quotes.service";
import { AutonomyScoringService } from "./autonomy-scoring.service";
import type { HoldDeps } from "./autonomy-hold.types";
import { liveOutboundClassStops, releaseOutboundClassStop } from "./lib/hold-class-stops";
import { cancelHoldsInFlight, cancelOneHold, liveHoldsFor } from "./lib/hold-in-flight";
import { notifyHoldPending } from "./lib/hold-notify";

export const HOLD_WORKFLOW = "crm.autonomy-hold";

/**
 * Placing, showing and cancelling holds.
 *
 * The wait itself belongs to the workflow runtime — `step.sleep` releases the
 * run and re-claims it later, so a hold survives a deploy and costs nothing
 * while it waits. A polling job would add latency to every send and would have
 * no memory of what it had already done when it crashed mid-batch.
 *
 * Placing a hold stays here, unique-violation handling and all; the
 * notification it sends is `lib/hold-notify.ts`, cancelling and listing what is
 * waiting is `lib/hold-in-flight.ts`, and the class stops, read and written, are
 * `lib/hold-class-stops.ts`.
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

  /** The request transaction, the notifier and this class's logger, as the libs take them. */
  private get deps(): HoldDeps {
    return { db: this.db, notifications: this.notifications, logger: this.logger };
  }

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

    await notifyHoldPending(this.deps, input.organizationId, hold.id, input.quoteId, windowSeconds);

    return { autonomyHoldId: hold.id, decisionId: decision.id, holdUntil, windowSeconds };
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

    if (!drafted.ok) return this.recordQuoteSkip(input, deal.partyId, drafted.reason);

    /**
     * Created in the name of whoever owns the deal, and skipped when nobody
     * does. `quotes.created_by_id` is NOT NULL and references `users`, so a
     * system actor is not representable there — the same gap ticket 08 found
     * in `deal_activities`. The literal `"system"` this used to fall back to
     * failed that key, and the whole decision with it. The deal's owner is
     * honest enough at the quote level; the ledger records that the system decided.
     */
    if (!deal.assignedToId)
      return this.recordQuoteSkip(input, deal.partyId, "Nobody owns this deal, so there is nobody to quote as.");

    const created = await this.quotes.create(input.organizationId, deal.assignedToId, {
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
    return liveOutboundClassStops(this.db, organizationId);
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
    return releaseOutboundClassStop(this.db, organizationId, userId, outboundClassStopId);
  }

  /** Everything still waiting, with the time each has left. */
  async liveHolds(organizationId: string) {
    return liveHoldsFor(this.db, organizationId);
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
    return cancelOneHold(this.deps, organizationId, userId, holdId, reason);
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
    return cancelHoldsInFlight(this.db, organizationId, userId, kind);
  }

  /**
   * A decision not to quote, recorded rather than thrown away. A decision not
   * to act that nobody recorded is indistinguishable from one that never ran.
   */
  private async recordQuoteSkip(
    input: { organizationId: string; dealId: number; confidence: number },
    partyId: string | null,
    summary: string,
  ) {
    await this.db.insert(autonomousDecisions).values(
      buildDecision({
        organizationId: input.organizationId,
        kind: "quote.sent",
        outcome: "skipped",
        triggerType: "deal",
        triggerId: String(input.dealId),
        dealId: String(input.dealId),
        partyId,
        confidence: input.confidence,
        summary,
      }),
    );
    return { held: false as const, reason: summary };
  }
}
