import { z } from "zod";

/**
 * The body of the one request that starts an outbound message.
 *
 * Its own file rather than a section of `autonomy-review.schemas.ts`, for a
 * reason that file's own tests make concrete: `send-guardrails.spec.ts` and
 * `cold-outbound-gate.spec.ts` both import `updateAutonomySettingsSchema` to
 * prove no tenant-settable key reaches a guardrail threshold. Growing that
 * module with outbound keys puts the two next to each other and invites exactly
 * the override those tests exist to forbid.
 *
 * Which is also why there is nothing here but two identifiers. Every choice the
 * loop makes — the class, the wording, the hold window, whether it may go at all
 * — belongs to `outbound-eligibility.ts`, the drafter and `send-guardrails.ts`.
 * A caller does not get to name the class or skip a check; it gets to say which
 * customer, and the system decides the rest or refuses.
 */
export const composeOutboundSchema = z
  .object({
    /** The party to write to. The address is resolved at send time, not from here. */
    partyId: z.string().trim().min(1).max(64),
    /**
     * The deal it is about. Optional in the type and load-bearing in practice:
     * the deal carries the salesperson to write as and the conversation to write
     * from, so without one `composeAndHold` refuses before it pays a provider.
     * See `loadComposeContext`.
     */
    dealId: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

export type ComposeOutboundInput = z.infer<typeof composeOutboundSchema>;
