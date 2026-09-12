import type { Logger } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.types";
import { quotes } from "../../../db/schema";
import type { AutonomyActionsService } from "../autonomy-actions.service";
import type { AutonomyHoldService } from "../autonomy-hold.service";
import type { AutonomyScoringService } from "../autonomy-scoring.service";
import { buildDecision, shouldAct } from "../decision-record";
import { EXTRACTION_PROMPT_VERSION, type Extraction } from "../extraction.schemas";

/*
  The quote leg of `AutonomyService.processActivity`, called only when the
  stage advance reports that the deal moved.
*/

/** What the quote leg reads and writes through: the service's own handles. */
export interface AutonomyQuoteDeps {
  readonly db: Db;
  readonly logger: Logger;
  readonly actions: Pick<AutonomyActionsService, "isAllowedFor" | "record">;
  readonly holds: Pick<AutonomyHoldService, "generateAndHoldQuote">;
  readonly scoring: Pick<AutonomyScoringService, "settingsFor">;
}

/**
 * The quote leg: a deal that just moved forward, drafted and put in the hold.
 *
 * Triggered by the stage advance rather than by anything the model says. The
 * extraction schema answers two closed questions and neither is "should we
 * quote" — adding a third would put the decision to send a customer a figure
 * in the hands of a free-text field, and the deterministic signal is better
 * anyway: the deal moved, on evidence already recorded in the ledger.
 *
 * Four gates, and all four have to pass. Ordered cheapest-first so a tenant
 * that never opted in costs one indexed read, not a model call and a quote:
 *
 *   1. the organisation opted in — `auto_quote_enabled`, off by default
 *   2. no operator kill switch stops `quote.sent`, at either level
 *   3. confidence clears the 0.9 threshold a quote carries
 *   4. nobody has quoted this deal yet
 *
 * Nothing here sends anything. `generateAndHoldQuote` drafts and holds, and
 * the hold is what a human cancels — the send is a separate act by the
 * workflow when the window closes with nobody having stopped it.
 */
export async function maybeDraftAutonomyQuote(
  deps: AutonomyQuoteDeps,
  organizationId: string,
  activityId: string,
  dealId: number,
  extraction: Extraction,
): Promise<void> {
  const settings = await deps.scoring.settingsFor(organizationId);
  if (!settings.autoQuoteEnabled) return;

  const allowed = await deps.actions.isAllowedFor(organizationId, "quote.sent");
  if (!allowed.allowed || !shouldAct("quote.sent", extraction.confidence)) {
    await deps.actions.record(
      buildDecision({
        organizationId,
        kind: "quote.sent",
        outcome: "skipped",
        triggerType: "activity",
        triggerId: activityId,
        dealId: String(dealId),
        confidence: extraction.confidence,
        promptVersion: String(EXTRACTION_PROMPT_VERSION),
        summary: allowed.allowed
          ? `The deal moved, but confidence ${extraction.confidence.toFixed(2)} is below what a quote needs.`
          : `Quoting is switched off (${allowed.decidedBy}).`,
      }),
    );
    return;
  }

  /**
   * One quote per deal, and the check is "any", not "any live one".
   *
   * A rejected or expired quote is still a figure this customer has already
   * been given, and drafting a second one automatically because the first did
   * not land is how an autonomous system starts negotiating against itself.
   * A human re-quotes; this does not.
   */
  const [existing] = await deps.db
    .select({ id: quotes.id })
    .from(quotes)
    .where(and(eq(quotes.orgId, organizationId), eq(quotes.dealId, dealId)))
    .limit(1);

  if (existing) {
    await deps.actions.record(
      buildDecision({
        organizationId,
        kind: "quote.sent",
        outcome: "skipped",
        triggerType: "activity",
        triggerId: activityId,
        dealId: String(dealId),
        confidence: extraction.confidence,
        summary: "The deal already has a quote, so a second one was not drafted.",
      }),
    );
    return;
  }

  try {
    await deps.holds.generateAndHoldQuote({
      organizationId,
      dealId,
      confidence: extraction.confidence,
    });
  } catch (error) {
    /**
     * Recorded, never rethrown. This runs after the stage advance has already
     * committed its own decision row; propagating would retry the whole
     * workflow and re-apply a move that has happened, which is a worse failure
     * than not quoting.
     */
    const reason = error instanceof Error ? error.message : String(error);
    deps.logger.error(`quote draft failed for deal ${dealId}: ${reason}`);
    await deps.actions.record(
      buildDecision({
        organizationId,
        kind: "quote.sent",
        outcome: "failed",
        triggerType: "activity",
        triggerId: activityId,
        dealId: String(dealId),
        confidence: extraction.confidence,
        summary: `The quote could not be drafted: ${reason}`,
      }),
    );
  }
}
