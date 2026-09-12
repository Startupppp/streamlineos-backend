import { z } from "zod";
import { wireDate } from "../../../common/openapi/wire-types";

/**
 * `ComposeOutcome` from `lib/outbound-compose.types.ts`.
 *
 * A refusal is the common answer and is a returned value rather than a throw —
 * "we considered this customer and decided not to write" is a successful run of
 * the loop — so both arms are 2xx and the discriminant is `held`.
 */
export const composeOutboundResponseSchema = z.union([
  z.object({
    held: z.literal(false),
    stage: z.enum(["eligibility", "draft", "confidence"]),
    reason: z.string(),
  }),
  z.object({
    held: z.literal(true),
    outboundMessageId: z.string(),
    autonomyHoldId: z.string(),
    decisionId: z.string(),
    outboundClass: z.string(),
    holdUntil: wireDate(),
    windowSeconds: z.number().int(),
  }),
]);
