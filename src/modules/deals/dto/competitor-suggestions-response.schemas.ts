import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../common/openapi/wire-types";

/**
 * One proposal, as `selectSuggestions` projects it.
 *
 * `decidedByUserId`, `decidedAt` and `appliedCompetitorId` are null exactly
 * while the status is `pending`; `decidedByName` comes off a projected LEFT JOIN
 * to `users`, so it is null for a reviewer who has since left.
 */
const competitorSuggestionSchema = z.object({
  competitorSuggestionId: z.string(),
  competitorKey: z.string(),
  sourceKind: z.string(),
  sourceActivityId: z.string(),
  evidenceQuote: z.string(),
  status: z.string(),
  decidedByUserId: z.string().nullable(),
  decidedByName: z.string().nullable(),
  decidedAt: nullableWireDate(),
  decisionNote: z.string().nullable(),
  appliedCompetitorId: z.string().nullable(),
  createdAt: wireDate(),
});

export const listCompetitorSuggestionsResponseSchema = z.array(competitorSuggestionSchema);

/**
 * `scan` — the counts beside the rows.
 *
 * "Nothing was proposed" has three meanings and the counts are what tell them
 * apart: no vocabulary, nothing in the timeline, or everything already known.
 */
export const scanCompetitorSuggestionsResponseSchema = z.object({
  proposed: z.number().int(),
  vocabularySize: z.number().int(),
  activitiesScanned: z.number().int(),
  alreadyTracked: z.number().int(),
  alreadyProposed: z.number().int(),
  suggestions: z.array(competitorSuggestionSchema),
});

/** `accept` — the decided row and the competitor it produced or adopted. */
export const acceptCompetitorSuggestionResponseSchema = z.object({
  competitorSuggestionId: z.string(),
  status: z.string(),
  appliedCompetitorId: z.string().nullable(),
});

/** `dismiss` — the decided row. A second decision is a 409, not a second row. */
export const dismissCompetitorSuggestionResponseSchema = z.object({
  competitorSuggestionId: z.string(),
  status: z.string(),
});
