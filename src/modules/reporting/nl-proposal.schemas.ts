import { z } from "zod";
import { queryDescriptionSchema } from "./dto/reporting.schemas";

/**
 * Phase 5 ticket 15. What the model is allowed to answer with, and nothing
 * else — the structural half of "never emits SQL and has no database
 * access, asserted structurally rather than by prompt".
 *
 * A discriminated union over exactly two shapes. The `true` arm reuses
 * `queryDescriptionSchema` verbatim rather than a parallel definition: it is
 * the same schema `POST /reporting/run` validates against, so a proposal
 * that parses here is already shaped like one a person could have typed by
 * hand, and `ReportingService.explain` — the same compiler every hand-built
 * description goes through — is what actually proves it is safe, not this
 * file. The `false` arm is the ticket's fifth criterion: a model forced to
 * always emit a description has no way to say a question cannot be
 * expressed, and would fabricate one instead.
 *
 * Neither arm can carry a raw SQL string. `queryDescriptionSchema` bounds
 * every leaf to a field NAME (looked up, never emitted) or a scalar VALUE
 * (always a bind parameter); `reason`/`explanation` here are free text, but
 * `nl-proposal.spec.ts` asserts structurally that neither ever reaches
 * anything but a UI label — there is no code path from this schema to a
 * database at all.
 */
export const nlProposalSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      description: queryDescriptionSchema,
      /** One or two sentences, shown beside the proposal so a reviewer can judge intent against shape. */
      explanation: z.string().min(1).max(500),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      /** Why this question has no expressible answer over the declared sources — shown verbatim, never a fallback guess. */
      reason: z.string().min(1).max(500),
    })
    .strict(),
]);

export type NlProposal = z.infer<typeof nlProposalSchema>;
