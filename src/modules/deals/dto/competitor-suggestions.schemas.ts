import { z } from "zod";
import { COMPETITOR_SUGGESTION_STATUSES } from "../../../db/schema";

/**
 * The payloads of the suggestion half of deal competitors.
 *
 * In their own file rather than appended to `deals.schemas.ts` because the
 * distinction they encode is the ticket's: `createCompetitorSchema` next door
 * describes a person stating a fact, and these describe a person judging a
 * proposal. Keeping them apart means a reader reviewing "how does a competitor
 * get onto a deal" sees two answers with different shapes rather than one file
 * where the second is easy to miss.
 */

export const listCompetitorSuggestionsSchema = z.object({
  /**
   * Defaults to the open ones, because that is the only question the card asks.
   * The decided ones are still readable — an accepted proposal is the provenance
   * of a competitor row and a dismissed one is why a name stopped being offered
   * — but they are not what somebody opens a deal to see.
   */
  status: z.enum(COMPETITOR_SUGGESTION_STATUSES).optional(),
});

/**
 * A scan takes no body at all, and that is a decision rather than an omission.
 *
 * Every knob a caller could turn — how far back to read, which vocabulary to
 * match, how confident to be — is a way to widen what the system proposes, and
 * widening it is precisely what must not be delegated to whoever is holding the
 * button. The bounds live in `competitor-suggestion.ts` where they can be argued
 * with once, in the open.
 */

/**
 * Acceptance echoes the name back.
 *
 * The id alone would be enough to find the row and is deliberately not enough to
 * act on it. A person accepts "Zoho, because of this line in Tuesday's call" —
 * not "suggestion 4f21" — and the only way for the server to know which of those
 * happened is to be told the name the screen was showing. A mismatch means the
 * screen was stale, and a stale screen is exactly the case where a click is not
 * consent.
 */
export const acceptCompetitorSuggestionSchema = z
  .object({
    confirmedCompetitorKey: z.string().min(1).max(200),
    notes: z.string().max(1000).optional(),
  })
  .strict();

/**
 * Dismissal may say why, and is never required to.
 *
 * Requiring a reason to reject a machine's guess makes rejecting it more work
 * than accepting it, which biases the whole feature toward acceptance — the
 * opposite of what it is for.
 */
export const dismissCompetitorSuggestionSchema = z
  .object({
    reason: z.string().max(500).optional(),
  })
  .strict();

export type ListCompetitorSuggestionsInput = z.infer<
  typeof listCompetitorSuggestionsSchema
>;
export type AcceptCompetitorSuggestionInput = z.infer<
  typeof acceptCompetitorSuggestionSchema
>;
export type DismissCompetitorSuggestionInput = z.infer<
  typeof dismissCompetitorSuggestionSchema
>;
