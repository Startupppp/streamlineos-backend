import { z } from "zod";
import { EXEMPLAR_METRICS } from "../call-exemplars";

/**
 * What the two rep-facing intelligence reads accept.
 *
 * `.strict()` on both, matching `call-recording-consent.schemas.ts` and for a
 * related reason. Zod's default is to strip an unknown key silently, so a
 * request carrying `repUserId`, `includeEmbargoed` or `scope=team` would be
 * accepted, ignored, and leave the author believing a widening parameter had
 * worked. There is no such parameter and there must not be one: what a reader
 * may see is decided by `callAnalysisVisibility` against the keys they hold, and
 * a query string that could widen it would be a second, weaker authority.
 */

/**
 * The period both surfaces cover.
 *
 * Defaulted rather than required — somebody opening the page has not chosen a
 * period, and a 400 is a worse first impression than a sensible month. Capped at
 * 90 days for the reason the coaching digest's is: these read rows and apply the
 * visibility rule in process, so an unbounded period is an unbounded read, and
 * the row cap would then truncate silently on every request from a busy team.
 */
const sinceDaysSchema = z.coerce.number().int().min(1).max(90).default(30);

/**
 * The page cap, which is the platform's and not this feature's.
 *
 * 100 is the hard cap on every list endpoint in this codebase. The default is 25
 * because a per-rep table is read a screen at a time, and 25 rows is more reps
 * than most teams have.
 */
const pageSchema = z.coerce.number().int().min(1).default(1);
const limitSchema = z.coerce.number().int().min(1).max(100).default(25);

export const repCallAggregatesQuerySchema = z
  .object({
    sinceDays: sinceDaysSchema,
    page: pageSchema,
    limit: limitSchema,
  })
  .strict();

export type RepCallAggregatesQueryDto = z.infer<typeof repCallAggregatesQuerySchema>;

/**
 * The metric an exemplar is an exemplar *of*.
 *
 * Required, with no default, and that is the one place these two schemas differ
 * in temperament. "Best calls" with no metric named is not a question with an
 * answer — a call that models a good talk ratio and one that models next-step
 * capture are different calls — so defaulting would silently pick a definition
 * of "best" on the caller's behalf and hand back a ranked list they never asked
 * the question behind.
 */
export const callExemplarsQuerySchema = z
  .object({
    metric: z.enum(EXEMPLAR_METRICS),
    sinceDays: sinceDaysSchema,
    page: pageSchema,
    /** Ten by default: this is a shortlist to listen to, not a table to scan. */
    limit: z.coerce.number().int().min(1).max(100).default(10),
  })
  .strict();

export type CallExemplarsQueryDto = z.infer<typeof callExemplarsQuerySchema>;
